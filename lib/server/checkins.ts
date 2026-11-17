// Foresight Lite server flows (spec §6). A check-in protects nobody until it
// is stored here; confirmations are queued only after the insert commits in
// the same transaction, and the dispatcher only reads committed rows.
import { randomUUID } from "node:crypto";
import { query, lock } from "./db.ts";
import {
  atomic,
  get,
  insert,
  list,
  update,
  DomainError,
  type Context,
} from "./repository.ts";
import type { Entity } from "../domain/contracts.ts";
import {
  assertTransition,
  escalationPlan,
  formatClock,
  isActive,
  makeReference,
  messagingConfigSchema,
  parseCommand,
  parseReturnTime,
  personSchema,
  StatusError,
  trainingConfig,
  type MessagingConfig,
  type RealStatus,
  type StatusActor,
} from "../domain/checkin.ts";
import {
  messagingConfig,
  queueMessage,
  recordInbound,
  channelWorkspace,
  serviceContext,
  type Channel,
  type Purpose,
} from "./messaging.ts";
import type { TemplateKey } from "../messaging/templates.ts";
import { phoneHash, sealedPhone, unseal, canSeePersonal } from "./personal.ts";

// ---- people -----------------------------------------------------------------------
export async function createPerson(ctx: Context, input: unknown) {
  if (!canSeePersonal(ctx.role))
    throw new DomainError(403, "ROLE_REQUIRED", "A supervisor or administrator role is required.");
  const body = personSchema.parse(input);
  return atomic(async () => {
    const sealed = sealedPhone(body.phone);
    if (sealed.phoneHash) {
      const { rows } = await query(
        "SELECT person_id FROM foresight.contact_index WHERE workspace_id=$1 AND phone_hash=$2",
        [ctx.workspaceId, sealed.phoneHash],
      );
      if (rows.length)
        throw new DomainError(409, "PHONE_IN_USE", "That phone number is already registered to someone in this mine.");
    }
    const kin = body.nextOfKin.map((k) => ({ name: k.name, ...sealedPhone(k.phone) }));
    const person = await insert(
      ctx,
      "person",
      {
        name: body.name,
        role: body.role,
        zoneId: body.zoneId,
        defaultBuddyId: body.defaultBuddyId,
        channels: body.channels,
        languages: body.languages,
        phoneSealed: sealed.phoneSealed,
        phoneMasked: sealed.phoneMasked,
        nextOfKin: kin.map(({ phoneHash: _h, ...k }) => k),
        consent: { status: "not-recorded", history: [] },
        removalRequested: null,
      },
      body.zoneId,
    );
    if (sealed.phoneHash)
      await query("INSERT INTO foresight.contact_index VALUES($1,$2,$3)", [
        ctx.workspaceId,
        sealed.phoneHash,
        person.id,
      ]);
    return person;
  });
}
export async function recordConsent(
  ctx: Context,
  personId: string,
  channel: "whatsapp" | "sms" | "in-person",
  given: boolean,
  note: string,
) {
  const person = await get(ctx, personId, "person");
  const consent = person.data.consent as { status: string; history: unknown[] };
  const at = new Date().toISOString();
  return await update(ctx, person, person.revision, {
    ...person.data,
    consent: {
      status: given ? "given" : "withdrawn",
      at,
      channel,
      textKey: "consent.request",
      history: [...consent.history, { status: given ? "given" : "withdrawn", at, channel, recordedBy: ctx.actor, note }],
    },
    removalRequested: given ? person.data.removalRequested : { at, channel },
  });
}
const phoneOf = (p: Entity) => (p.data.phoneSealed ? unseal(String(p.data.phoneSealed)) : null);
export async function personByPhone(ctx: Context, phone: string) {
  const {
    rows: [row],
  } = await query("SELECT person_id FROM foresight.contact_index WHERE workspace_id=$1 AND phone_hash=$2", [
    ctx.workspaceId,
    phoneHash(phone),
  ]);
  return row ? await get(ctx, row.person_id, "person") : null;
}

// ---- check-ins -----------------------------------------------------------------------
export type CheckInMethod = "whatsapp" | "sms" | "manual" | "team";
export async function activeCheckIns(ctx: Context) {
  return (await list(ctx, "check-in")).filter((c) => isActive(String(c.data.status)));
}
export async function createCheckIn(
  ctx: Context,
  input: {
    personId: string;
    shaftId: string;
    zoneId: string | null;
    expectedReturn: string;
    buddyPersonId: string | null;
    method: CheckInMethod;
    teamCheckInId?: string | null;
    declaredBy: string;
    reason?: string;
  },
  now = new Date(),
) {
  const { config } = await messagingConfig(ctx);
  const shaft = config.shafts.find((s) => s.id === input.shaftId);
  if (!shaft) throw new DomainError(422, "SHAFT", "Choose a configured shaft.");
  if (input.zoneId && !shaft.zoneIds.includes(input.zoneId))
    throw new DomainError(422, "ZONE", "That zone is not reached from this shaft.");
  const ret = Date.parse(input.expectedReturn);
  if (!(ret > now.getTime()) || ret - now.getTime() > config.maxShiftHours * 3600e3)
    throw new DomainError(422, "RETURN_TIME", `Expected return must be in the future and within ${config.maxShiftHours} hours.`);
  return atomic(async () => {
    await lock(`checkin-person:${ctx.workspaceId}:${input.personId}`);
    const person = await get(ctx, input.personId, "person");
    if ((person.data.consent as { status: string }).status !== "given")
      throw new DomainError(409, "CONSENT_REQUIRED", "No check-in is accepted without recorded consent.");
    const active = await activeCheckIns(ctx);
    const existing = active.find((c) => c.data.personId === input.personId);
    if (existing)
      throw new DomainError(409, "ALREADY_DECLARED", `Already declared underground (Ref ${existing.data.reference}).`);
    const buddy = input.buddyPersonId ? await get(ctx, input.buddyPersonId, "person") : null;
    const reference = makeReference(new Set(active.map((c) => String(c.data.reference))));
    const at = now.toISOString();
    const checkIn = await insert(
      ctx,
      "check-in",
      {
        personId: person.id,
        personName: person.data.name,
        shaftId: shaft.id,
        shaftName: shaft.name,
        declaredZoneId: input.zoneId,
        timeIn: at,
        expectedReturn: new Date(ret).toISOString(),
        buddyPersonId: buddy?.id || null,
        buddyName: buddy?.data.name || null,
        method: input.method,
        declaredBy: input.declaredBy,
        teamCheckInId: input.teamCheckInId || null,
        reference,
        status: "declared-underground",
        statusHistory: [{ status: "declared-underground", at, by: input.method === "manual" ? "human" : input.method, actor: ctx.actor, reason: input.reason || null }],
        timeOut: null,
        stepsRun: [],
        configSnapshot: { gracePeriodMinutes: config.gracePeriodMinutes, secondIntervalMinutes: config.secondIntervalMinutes },
      },
      input.zoneId,
      [
        { id: person.id, relation: "person" },
        ...(buddy ? [{ id: buddy.id, relation: "buddy" }] : []),
        ...(input.teamCheckInId ? [{ id: input.teamCheckInId, relation: "team-check-in" }] : []),
      ],
    );
    for (const s of escalationPlan(checkIn.data.expectedReturn as string, config))
      await query(
        "INSERT INTO foresight.escalation_steps(id,workspace_id,checkin_id,step,due_at,idempotency_key) VALUES($1,$2,$3,$4,$5,$6)",
        [randomUUID(), ctx.workspaceId, checkIn.id, s.step, s.dueAt, `${checkIn.id}:${s.step}`],
      );
    return checkIn;
  });
}
export async function steps(ctx: Context, checkInId?: string) {
  const { rows } = await query(
    checkInId
      ? "SELECT checkin_id,step,due_at,executed_at,cancelled_at,outcome FROM foresight.escalation_steps WHERE workspace_id=$1 AND checkin_id=$2 ORDER BY due_at"
      : "SELECT checkin_id,step,due_at,executed_at,cancelled_at,outcome FROM foresight.escalation_steps WHERE workspace_id=$1 ORDER BY due_at",
    checkInId ? [ctx.workspaceId, checkInId] : [ctx.workspaceId],
  );
  return rows as { checkin_id: string; step: string; due_at: string; executed_at: string | null; cancelled_at: string | null; outcome: string | null }[];
}
async function cancelSteps(ctx: Context, checkInId: string, reason: string, at: string) {
  await query(
    "UPDATE foresight.escalation_steps SET cancelled_at=$1,outcome=$2 WHERE workspace_id=$3 AND checkin_id=$4 AND executed_at IS NULL AND cancelled_at IS NULL",
    [at, reason, ctx.workspaceId, checkInId],
  );
  return (await steps(ctx, checkInId)).filter((s) => s.executed_at).map((s) => s.step);
}
export async function setCheckInStatus(
  ctx: Context,
  checkIn: Entity,
  to: RealStatus,
  by: StatusActor,
  reason: string,
  expectedRevision = checkIn.revision,
  now = new Date(),
) {
  try {
    assertTransition(String(checkIn.data.status), to, by, reason);
  } catch (e) {
    throw new DomainError(422, "STATUS_TRANSITION", (e as StatusError).message);
  }
  if (by === "human" && !canSeePersonal(ctx.role))
    throw new DomainError(403, "ROLE_REQUIRED", "A supervisor or administrator must confirm this.");
  return atomic(async () => {
    const at = now.toISOString();
    let stepsRun = checkIn.data.stepsRun as string[];
    if (to === "accounted-for" || to === "confirmed-missing")
      stepsRun = await cancelSteps(ctx, checkIn.id, to === "accounted-for" ? `stopped: ${by === "check-out" ? "checked out" : "accounted for"}` : "stopped: confirmed missing; incident opened", at);
    const next = await update(ctx, checkIn, expectedRevision, {
      ...checkIn.data,
      status: to,
      timeOut: by === "check-out" ? at : checkIn.data.timeOut,
      stepsRun,
      statusHistory: [...(checkIn.data.statusHistory as unknown[]), { status: to, at, by, actor: ctx.actor, reason }],
    });
    if (to === "confirmed-missing") {
      const messages = (await list(ctx, "message")).filter((m) => m.data.checkInId === checkIn.id);
      await insert(
        ctx,
        "case",
        {
          title: `Confirmed missing: ${checkIn.data.personName} at ${checkIn.data.shaftName}`,
          zoneId: checkIn.data.declaredZoneId,
          category: "overdue-miner",
          source: checkIn.data.status === "return-overdue" ? "overdue-escalation" : "real-event",
          description: `Declared underground at ${checkIn.data.shaftName} at ${checkIn.data.timeIn}; expected back ${checkIn.data.expectedReturn}. Confirmed missing by ${ctx.actor}: ${reason}`,
          peopleAffected: [{ name: checkIn.data.personName, personId: checkIn.data.personId }],
          owner: ctx.actor,
          dueAt: new Date(now.getTime() + 3600e3).toISOString(),
          planning: false,
          status: "open",
          actions: [],
          timeline: { checkIn: checkIn.data, stepsRun, messageIds: messages.map((m) => m.id) },
          history: [{ at, actor: ctx.actor, status: "open", reason: "Opened when a person was confirmed missing" }],
        },
        (checkIn.data.declaredZoneId as string) || null,
        [{ id: checkIn.id, relation: "check-in" }, ...messages.map((m) => ({ id: m.id, relation: "message" }))],
      );
    }
    return next;
  });
}
export async function checkOut(ctx: Context, personId: string, now = new Date()) {
  const active = (await activeCheckIns(ctx)).find((c) => c.data.personId === personId);
  if (!active) return null;
  return await setCheckInStatus(ctx, active, "accounted-for", "check-out", "Checked out", active.revision, now);
}

// ---- escalation scheduler ---------------------------------------------------------------
const clock = (iso: string, cfg: MessagingConfig) => formatClock(iso, cfg.timezone);
async function alert(
  ctx: Context,
  person: Entity,
  purpose: Purpose,
  key: TemplateKey,
  vars: Record<string, string | number>,
  idempotencyKey: string,
  checkInId: string,
  prefer: "sms-plus-whatsapp" | "whatsapp-then-sms",
) {
  const phone = phoneOf(person);
  if (!phone) return [`${person.data.name}: no phone on record`];
  const ch = person.data.channels as { whatsapp: boolean; sms: boolean };
  const out: string[] = [];
  const send = async (channel: Channel, failoverChannel: Channel | null) => {
    await queueMessage(ctx, {
      channel,
      purpose,
      recipientPersonId: person.id,
      recipientPhone: phone,
      templateKey: key,
      vars,
      checkInId,
      idempotencyKey: `${idempotencyKey}:${person.id}:${channel}`,
      failoverChannel,
    });
    out.push(`${person.data.name} via ${channel}`);
  };
  if (prefer === "whatsapp-then-sms" && ch.whatsapp) await send("whatsapp", ch.sms ? "sms" : null);
  else {
    if (ch.sms) await send("sms", null);
    if (ch.whatsapp) await send("whatsapp", null);
  }
  return out;
}
/** Execute due escalation steps once each (claim → act → mark, one transaction). */
export async function runDueSteps(now = new Date()) {
  const nowIso = now.toISOString();
  const { rows } = await query(
    "SELECT id,workspace_id,checkin_id,step,due_at,idempotency_key FROM foresight.escalation_steps WHERE executed_at IS NULL AND cancelled_at IS NULL AND due_at<=$1 AND (claimed_until IS NULL OR claimed_until<$1) ORDER BY due_at LIMIT 50",
    [nowIso],
  );
  const done: { step: string; checkInId: string; outcome: string }[] = [];
  for (const row of rows) {
    const ctx = serviceContext(row.workspace_id);
    const outcome = await atomic(async () => {
      const claim = await query(
        "UPDATE foresight.escalation_steps SET claimed_until=$1 WHERE id=$2 AND executed_at IS NULL AND cancelled_at IS NULL AND (claimed_until IS NULL OR claimed_until<$3)",
        [new Date(now.getTime() + 120e3).toISOString(), row.id, nowIso],
      );
      if (!claim.changes) return null;
      let checkIn = await get(ctx, row.checkin_id, "check-in");
      const status = String(checkIn.data.status);
      if (status === "accounted-for") {
        await query("UPDATE foresight.escalation_steps SET cancelled_at=$1,outcome=$2 WHERE id=$3", [nowIso, "stopped: already accounted for", row.id]);
        return "cancelled";
      }
      const { config } = await messagingConfig(ctx);
      const person = await get(ctx, String(checkIn.data.personId), "person");
      const vars = {
        name: String(checkIn.data.personName),
        shaft: String(checkIn.data.shaftName),
        time: clock(String(checkIn.data.expectedReturn), config),
        buddy: String(checkIn.data.buddyName || "none recorded"),
      };
      let result: string[] = [];
      if (row.step === "reminder")
        result = await alert(ctx, person, "reminder", "reminder.miner", vars, row.idempotency_key, checkIn.id, "sms-plus-whatsapp");
      if (row.step === "overdue") {
        if (status === "declared-underground")
          checkIn = await setCheckInStatus(ctx, checkIn, "return-overdue", "scheduler", "Expected return plus grace period passed with no check-out", checkIn.revision, now);
        const buddy = checkIn.data.buddyPersonId ? await get(ctx, String(checkIn.data.buddyPersonId), "person") : null;
        result = buddy
          ? await alert(ctx, buddy, "buddy-alert", "overdue.buddy", vars, row.idempotency_key, checkIn.id, "sms-plus-whatsapp")
          : ["no buddy recorded"];
        result.unshift("status → return overdue");
      }
      if (row.step === "supervisor") {
        const buddyStep = (await steps(ctx, checkIn.id)).find((s) => s.step === "overdue");
        const supervisors = (await list(ctx, "person")).filter((p) => p.data.role === "supervisor");
        for (const s of supervisors)
          result.push(
            ...(await alert(ctx, s, "supervisor-alert", "overdue.supervisor", { ...vars, buddyAt: buddyStep?.executed_at ? clock(buddyStep.executed_at, config) : "not yet" }, row.idempotency_key, checkIn.id, "whatsapp-then-sms")),
          );
        if (!supervisors.length) result.push("no supervisor contact registered; dashboard alert only");
        result.push(await openShaftMuster(ctx, String(checkIn.data.shaftId), `Overdue: ${checkIn.data.personName}`, checkIn.id, now));
      }
      await query("UPDATE foresight.escalation_steps SET executed_at=$1,outcome=$2,claimed_until=NULL WHERE id=$3", [
        nowIso,
        result.join("; ").slice(0, 1000),
        row.id,
      ]);
      await update(ctx, checkIn, checkIn.revision, {
        ...checkIn.data,
        stepsRun: [...(checkIn.data.stepsRun as string[]), row.step],
      });
      return result.join("; ");
    });
    if (outcome !== null) done.push({ step: row.step, checkInId: row.checkin_id, outcome });
  }
  return done;
}
/** Frozen roster of everyone declared underground at a shaft (human confirmations only). */
export async function openShaftMuster(ctx: Context, shaftId: string, reason: string, linkId: string | null, now = new Date()) {
  const open = (await list(ctx, "muster")).find(
    (m) => m.data.scope === "shaft" && m.data.shaftId === shaftId && m.data.status === "awaiting-confirmation",
  );
  if (open) return `muster already open (${open.id.slice(0, 8)})`;
  const roster = (await activeCheckIns(ctx)).filter((c) => c.data.shaftId === shaftId);
  const muster = await insert(
    ctx,
    "muster",
    {
      scope: "shaft",
      shaftId,
      zoneId: null,
      caseId: null,
      reason,
      rosterAt: now.toISOString(),
      source: "check-ins",
      members: roster.map((c) => ({
        workerId: c.id,
        checkInId: c.id,
        personId: c.data.personId,
        name: c.data.personName,
        status: c.data.status,
        expectedReturn: c.data.expectedReturn,
        confirmed: false,
        confirmedAt: null,
        actor: null,
      })),
      status: "awaiting-confirmation",
    },
    null,
    linkId ? [{ id: linkId, relation: "trigger" }] : [],
  );
  return `muster opened for shaft (${muster.data.members ? (muster.data.members as unknown[]).length : 0} on roster)`;
}

// ---- inbound conversation ------------------------------------------------------------------
type Conversation = { step: "idle" | "awaiting-consent" | "ask-shaft" | "ask-return" | "ask-buddy" | "ask-buddy-number"; shaftId?: string; expectedReturn?: string; consentAsked?: boolean };
async function loadConversation(ctx: Context, hash: string, channel: Channel): Promise<Conversation> {
  const {
    rows: [row],
  } = await query("SELECT state_json FROM foresight.conversations WHERE workspace_id=$1 AND phone_hash=$2 AND channel=$3", [ctx.workspaceId, hash, channel]);
  return row ? JSON.parse(row.state_json) : { step: "idle" };
}
async function saveConversation(ctx: Context, hash: string, channel: Channel, state: Conversation) {
  await query(
    "INSERT INTO foresight.conversations VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,phone_hash,channel) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at",
    [ctx.workspaceId, hash, channel, JSON.stringify(state), new Date().toISOString()],
  );
}
export type Inbound = {
  provider: "whatsapp" | "smsgate" | "mock";
  channelKey: string;
  channel: Channel;
  from: string;
  text: string;
  providerMessageId: string;
  receivedAt: string;
};
export async function handleInbound(input: Inbound, now = new Date()) {
  const workspaceId =
    (await channelWorkspace(input.provider === "mock" ? "smsgate" : input.provider, input.channelKey)) ||
    (await channelWorkspace(input.provider === "mock" ? "smsgate" : input.provider, "default"));
  if (!workspaceId) return { handled: false, reason: "No workspace is bound to this messaging channel" };
  const ctx = serviceContext(workspaceId);
  const person = await personByPhone(ctx, input.from);
  const inbound = await recordInbound(ctx, { ...input, personId: person?.id || null });
  if (!inbound) return { handled: false, reason: "duplicate provider message id" };
  const { config } = await messagingConfig(ctx);
  const mine = "the mine";
  let n = 0;
  const reply = async (key: TemplateKey, vars: Record<string, string | number> = {}) =>
    queueMessage(ctx, {
      channel: input.channel,
      purpose: "reply",
      recipientPersonId: person?.id || null,
      recipientPhone: input.from,
      templateKey: key,
      vars,
      idempotencyKey: `reply:${inbound.id}:${n++}`,
    });
  const shaftList = config.shafts.map((s) => `${s.number} ${s.name}`).join("  ");
  if (!person) {
    await reply("unknown.number", { mine });
    await insert(ctx, "messaging-alert", { kind: "unknown-number", at: now.toISOString(), inboundMessageId: inbound.id, detail: "An unregistered number messaged the check-in line." });
    for (const s of (await list(ctx, "person")).filter((p) => p.data.role === "supervisor"))
      if (phoneOf(s))
        await queueMessage(ctx, { channel: (s.data.channels as { whatsapp: boolean }).whatsapp ? "whatsapp" : "sms", purpose: "supervisor-alert", recipientPersonId: s.id, recipientPhone: phoneOf(s)!, templateKey: "unknown.supervisor", vars: { at: formatClock(now.toISOString(), config.timezone) }, idempotencyKey: `unknown:${inbound.id}:${s.id}` });
    return { handled: true, outcome: "unknown-number" };
  }
  const hash = phoneHash(input.from);
  const state = await loadConversation(ctx, hash, input.channel);
  const cmd = parseCommand(input.text);
  const consent = (person.data.consent as { status: string }).status;
  if (cmd.kind === "stop") {
    await recordConsent(ctx, person.id, input.channel, false, "Miner sent STOP");
    await saveConversation(ctx, hash, input.channel, { step: "idle" });
    await reply("consent.removed");
    return { handled: true, outcome: "consent-withdrawn" };
  }
  if (consent !== "given") {
    if (cmd.kind === "consent-yes" && state.step === "awaiting-consent") {
      await recordConsent(ctx, person.id, input.channel, true, "Replied YES to the consent message");
      await saveConversation(ctx, hash, input.channel, { step: "idle" });
      await reply("consent.recorded");
      return { handled: true, outcome: "consent-recorded" };
    }
    await saveConversation(ctx, hash, input.channel, { step: "awaiting-consent" });
    await reply(state.step === "awaiting-consent" ? "consent.required" : "consent.request", { mine });
    return { handled: true, outcome: "consent-requested" };
  }
  const finishCheckIn = async (shaftId: string, expectedReturn: string, buddyId: string | null) => {
    try {
      const c = await createCheckIn(ctx, { personId: person.id, shaftId, zoneId: (person.data.zoneId as string) && config.shafts.find((s) => s.id === shaftId)?.zoneIds.includes(String(person.data.zoneId)) ? String(person.data.zoneId) : null, expectedReturn, buddyPersonId: buddyId, method: input.channel, declaredBy: `${person.data.name} via ${input.channel}` }, now);
      await saveConversation(ctx, hash, input.channel, { step: "idle" });
      await reply("checkin.registered", { shaft: String(c.data.shaftName), time: clock(String(c.data.expectedReturn), config), buddy: String(c.data.buddyName || "none"), ref: String(c.data.reference) });
      return { handled: true, outcome: "checked-in", checkInId: c.id };
    } catch (e) {
      if (e instanceof DomainError && e.code === "ALREADY_DECLARED") {
        const a = (await activeCheckIns(ctx)).find((x) => x.data.personId === person.id)!;
        await saveConversation(ctx, hash, input.channel, { step: "idle" });
        await reply("checkin.already", { shaft: String(a.data.shaftName), ref: String(a.data.reference) });
        return { handled: true, outcome: "already-declared" };
      }
      throw e;
    }
  };
  const buddyOptions = async () => {
    const saved = person.data.defaultBuddyId ? await get(ctx, String(person.data.defaultBuddyId), "person").catch(() => null) : null;
    return { saved, text: saved ? `1 ${saved.data.name} (saved)  2 New number` : "Reply with your buddy's number" };
  };
  const findBuddy = async (value: string) => {
    if (/^\+?\d[\d\s]{7,}$/.test(value)) {
      const phone = value.startsWith("+") ? value.replace(/\s/g, "") : "+" + value.replace(/\s/g, "");
      const known = await personByPhone(ctx, phone).catch(() => null);
      if (known) return known.id;
      const created = await createPerson({ ...ctx, role: "administrator" }, { name: `Buddy of ${person.data.name}`, phone, role: "buddy-contact", channels: { whatsapp: false, sms: true } });
      return created.id;
    }
    const first = (n: unknown) => String(n).toLowerCase().split(/\s+/)[0];
    const matches = (await list(ctx, "person")).filter((p) => p.id !== person.id && (String(p.data.name).toLowerCase() === value.toLowerCase() || first(p.data.name) === first(value)));
    // The miner's saved buddy wins a name match; otherwise never guess between people.
    const saved = matches.find((p) => p.id === person.data.defaultBuddyId);
    if (saved) return saved.id;
    return matches.length === 1 ? matches[0].id : null;
  };
  if (cmd.kind === "out") {
    const done = await checkOut(ctx, person.id, now);
    await saveConversation(ctx, hash, input.channel, { step: "idle" });
    await reply(done ? "checkout.done" : "checkout.none", { time: formatClock(now.toISOString(), config.timezone) });
    return { handled: true, outcome: done ? "checked-out" : "not-checked-in" };
  }
  if (cmd.kind === "help") {
    await reply("help", { shafts: shaftList });
    return { handled: true, outcome: "help" };
  }
  if (cmd.kind === "team") {
    if (person.data.role !== "shift-boss") {
      await reply("team.not-authorised");
      return { handled: true, outcome: "team-refused" };
    }
    const shaft = config.shafts.find((s) => s.number === cmd.shaft);
    const ret = parseReturnTime(cmd.time, now, config);
    if (!shaft || !ret.ok) {
      await reply(!shaft ? "ask.shaft.unknown" : (`ask.return.${ret.ok ? "format" : ret.reason}` as TemplateKey), { shafts: shaftList, maxHours: config.maxShiftHours });
      return { handled: true, outcome: "team-invalid" };
    }
    const team = await insert(ctx, "team-check-in", { shiftBossId: person.id, shiftBossName: person.data.name, shaftId: shaft.id, expectedReturn: ret.at, names: cmd.names, at: now.toISOString() });
    const people = await list(ctx, "person");
    const refs: string[] = [], skipped: string[] = [];
    for (const name of cmd.names) {
      const match = people.filter((p) => String(p.data.name).toLowerCase() === name.toLowerCase() || String(p.data.name).toLowerCase().split(/\s+/)[0] === name.toLowerCase());
      if (match.length !== 1) { skipped.push(`${name} (not registered)`); continue; }
      try {
        const c = await createCheckIn(ctx, { personId: match[0].id, shaftId: shaft.id, zoneId: null, expectedReturn: ret.at, buddyPersonId: person.id, method: "team", teamCheckInId: team.id, declaredBy: `Shift boss ${person.data.name}` }, now);
        refs.push(String(c.data.reference));
      } catch (e) {
        skipped.push(`${name} (${e instanceof DomainError && e.code === "CONSENT_REQUIRED" ? "no consent" : e instanceof DomainError && e.code === "ALREADY_DECLARED" ? "already declared" : "not registered"})`);
      }
    }
    await reply("team.registered", { shaft: shaft.name, time: clock(ret.at, config), count: refs.length, refs: refs.join(", ") || "none", skipped: skipped.length ? ` Not registered: ${skipped.join(", ")}.` : "" });
    return { handled: true, outcome: "team", refs, skipped };
  }
  if (cmd.kind === "in" && cmd.shaft !== undefined && cmd.time && cmd.buddy) {
    const shaft = config.shafts.find((s) => s.number === cmd.shaft);
    if (!shaft) { await reply("ask.shaft.unknown", { shafts: shaftList }); return { handled: true, outcome: "invalid-shaft" }; }
    const ret = parseReturnTime(cmd.time, now, config);
    if (!ret.ok) {
      await saveConversation(ctx, hash, input.channel, { step: "ask-return", shaftId: shaft.id });
      await reply(`ask.return.${ret.reason}` as TemplateKey, { maxHours: config.maxShiftHours });
      return { handled: true, outcome: "invalid-time" };
    }
    const buddyId = await findBuddy(cmd.buddy);
    if (!buddyId) {
      const opts = await buddyOptions();
      await saveConversation(ctx, hash, input.channel, { step: "ask-buddy", shaftId: shaft.id, expectedReturn: ret.at });
      await reply("ask.buddy.unknown", { options: opts.text });
      return { handled: true, outcome: "invalid-buddy" };
    }
    return await finishCheckIn(shaft.id, ret.at, buddyId);
  }
  if (cmd.kind === "in") {
    await saveConversation(ctx, hash, input.channel, { step: "ask-shaft" });
    await reply("ask.shaft", { shafts: shaftList });
    return { handled: true, outcome: "asked-shaft" };
  }
  const answer = input.text.trim();
  if (state.step === "ask-shaft") {
    const shaft = config.shafts.find((s) => String(s.number) === answer);
    if (!shaft) { await reply("ask.shaft.unknown", { shafts: shaftList }); return { handled: true, outcome: "invalid-shaft" }; }
    await saveConversation(ctx, hash, input.channel, { step: "ask-return", shaftId: shaft.id });
    await reply("ask.return");
    return { handled: true, outcome: "asked-return" };
  }
  if (state.step === "ask-return" && state.shaftId) {
    const ret = parseReturnTime(answer, now, config);
    if (!ret.ok) { await reply(`ask.return.${ret.reason}` as TemplateKey, { maxHours: config.maxShiftHours }); return { handled: true, outcome: "invalid-time" }; }
    const opts = await buddyOptions();
    await saveConversation(ctx, hash, input.channel, { step: "ask-buddy", shaftId: state.shaftId, expectedReturn: ret.at });
    await reply("ask.buddy", { options: opts.text });
    return { handled: true, outcome: "asked-buddy" };
  }
  if (state.step === "ask-buddy" && state.shaftId && state.expectedReturn) {
    const opts = await buddyOptions();
    if (answer === "1" && opts.saved) return await finishCheckIn(state.shaftId, state.expectedReturn, opts.saved.id);
    if (answer === "2") {
      await saveConversation(ctx, hash, input.channel, { ...state, step: "ask-buddy-number" });
      await reply("ask.buddy.number");
      return { handled: true, outcome: "asked-buddy-number" };
    }
    const buddyId = await findBuddy(answer);
    if (buddyId) return await finishCheckIn(state.shaftId, state.expectedReturn, buddyId);
    await reply("ask.buddy.unknown", { options: opts.text });
    return { handled: true, outcome: "invalid-buddy" };
  }
  if (state.step === "ask-buddy-number" && state.shaftId && state.expectedReturn) {
    try {
      const buddyId = await findBuddy(answer);
      if (buddyId) return await finishCheckIn(state.shaftId, state.expectedReturn, buddyId);
    } catch {
      /* invalid number: ask again */
    }
    await reply("ask.buddy.number");
    return { handled: true, outcome: "invalid-buddy-number" };
  }
  await reply("help", { shafts: shaftList });
  return { handled: true, outcome: "help" };
}

// ---- configuration and seed ---------------------------------------------------------------------
export async function saveMessagingConfig(ctx: Context, input: unknown) {
  if (ctx.role !== "administrator" && ctx.role !== "supervisor")
    throw new DomainError(403, "ROLE_REQUIRED", "A supervisor or administrator role is required.");
  const body = messagingConfigSchema.omit({ liveEnabled: true }).parse(input);
  const { entity, config } = await messagingConfig(ctx);
  const data = { ...body, liveEnabled: config.liveEnabled };
  return entity ? await update(ctx, entity, entity.revision, data) : await insert(ctx, "messaging-config", data);
}
/** Live sending also needs MESSAGING_MODE=live on the server. Administrator only. */
export async function setLiveMessaging(ctx: Context, enabled: boolean, reason: string) {
  if (ctx.role !== "administrator")
    throw new DomainError(403, "ROLE_REQUIRED", "Only an administrator can enable live messaging.");
  if (reason.trim().length < 3) throw new DomainError(422, "REASON", "A reason is required.");
  const { entity, config } = await messagingConfig(ctx);
  const data = { ...config, liveEnabled: enabled ? { by: ctx.actor, at: new Date().toISOString() } : null, liveReason: reason };
  return entity ? await update(ctx, entity, entity.revision, data) : await insert(ctx, "messaging-config", data);
}
export async function seedMessaging(ctx: Context) {
  await insert(ctx, "messaging-config", trainingConfig);
  const made: Record<string, Entity> = {};
  for (const [key, name, role, zoneId] of [
    ["tendai", "Tendai M. (fictional)", "miner", "zone-b"],
    ["rudo", "Rudo C. (fictional)", "miner", "zone-b"],
    ["farai", "Farai N. (fictional shift boss)", "shift-boss", "zone-a"],
    ["sup", "Duty supervisor (fictional)", "supervisor", null],
  ] as const) {
    made[key] = await insert(
      ctx,
      "person",
      {
        name,
        role,
        zoneId,
        defaultBuddyId: key === "rudo" ? made.tendai?.id || null : null,
        channels: { whatsapp: false, sms: true },
        languages: ["en"],
        phoneSealed: null,
        phoneMasked: null,
        nextOfKin: [],
        consent: { status: "not-recorded", history: [] },
        removalRequested: null,
        fictional: true,
      },
      zoneId,
    );
  }
}
