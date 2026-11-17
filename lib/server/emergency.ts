// Collapse response mode (spec §6.7). A declared emergency is a REAL incident
// that only an authorised person can create, with explicit confirmation. No
// scenario or automated code path calls declareEmergency.
import { z } from "zod";
import { query } from "./db.ts";
import { atomic, auditLog, get, insert, list, update, DomainError, type Context } from "./repository.ts";
import type { Entity } from "../domain/contracts.ts";
import { activeCheckIns, setCheckInStatus } from "./checkins.ts";
import { messagingConfig, messagingMode, queueMessage } from "./messaging.ts";
import { canSeePersonal, unseal } from "./personal.ts";
import { formatClock } from "../domain/checkin.ts";
import { textPdf, type PdfLine } from "./pdf.ts";

export const emergencyTypes = ["collapse", "flooding", "fire", "unknown"] as const;
export const declareSchema = z
  .object({
    shaftId: z.string().min(1).max(64),
    type: z.enum(emergencyTypes),
    confirmReal: z.literal(true, { errorMap: () => ({ message: "Confirm that this is a real emergency." }) }),
    note: z.string().trim().max(1000).default(""),
  })
  .strict();
export const rollUpdateSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    status: z.enum(["accounted-for", "injured", "confirmed-missing"]),
    note: z.string().trim().min(3).max(500),
  })
  .strict();
const category: Record<string, string> = { collapse: "collapse", flooding: "flooding", fire: "near-miss", unknown: "near-miss" };
const requireSupervisor = (ctx: Context) => {
  if (!canSeePersonal(ctx.role))
    throw new DomainError(403, "ROLE_REQUIRED", "Only a supervisor or administrator can declare or run an emergency.");
};
async function rollRow(ctx: Context, c: Entity) {
  const person = await get(ctx, String(c.data.personId), "person");
  return {
    checkInId: c.id,
    personId: person.id,
    name: String(c.data.personName),
    shaftId: String(c.data.shaftId),
    shaftName: String(c.data.shaftName),
    declaredZoneId: (c.data.declaredZoneId as string) || null,
    timeIn: String(c.data.timeIn),
    expectedReturn: String(c.data.expectedReturn),
    status: String(c.data.status),
    buddyName: (c.data.buddyName as string) || null,
    buddyPersonId: (c.data.buddyPersonId as string) || null,
    phoneMasked: (person.data.phoneMasked as string) || null,
    reference: String(c.data.reference),
  };
}
export async function declareEmergency(ctx: Context, input: unknown, now = new Date()) {
  requireSupervisor(ctx);
  const body = declareSchema.parse(input);
  const { config } = await messagingConfig(ctx);
  const shaft = config.shafts.find((s) => s.id === body.shaftId);
  if (!shaft) throw new DomainError(422, "SHAFT", "Choose a configured shaft.");
  return atomic(async () => {
    const open = (await list(ctx, "emergency")).find((e) => e.data.status === "active" && e.data.shaftId === shaft.id);
    if (open) throw new DomainError(409, "EMERGENCY_ACTIVE", "An emergency is already active at this shaft.");
    const active = await activeCheckIns(ctx);
    const roll = await Promise.all(active.filter((c) => c.data.shaftId === shaft.id).map((c) => rollRow(ctx, c)));
    const others = await Promise.all(active.filter((c) => c.data.shaftId !== shaft.id).map((c) => rollRow(ctx, c)));
    const at = now.toISOString();
    const incident = await insert(
      ctx,
      "case",
      {
        title: `Declared emergency (${body.type}) at ${shaft.name}`,
        zoneId: shaft.zoneIds[0] || null,
        category: category[body.type],
        source: "declared-emergency",
        description: `${body.type} declared at ${shaft.name} by ${ctx.actor}. ${roll.length} people declared underground at the shaft at declaration.${body.note ? " " + body.note : ""}`,
        peopleAffected: roll.map((r) => ({ name: r.name, personId: r.personId })),
        owner: ctx.actor,
        dueAt: new Date(now.getTime() + 3600e3).toISOString(),
        planning: false,
        status: "open",
        actions: [],
        history: [{ at, actor: ctx.actor, status: "open", reason: "Emergency declared" }],
      },
      shaft.zoneIds[0] || null,
    );
    const emergency = await insert(
      ctx,
      "emergency",
      {
        shaftId: shaft.id,
        shaftName: shaft.name,
        type: body.type,
        note: body.note,
        declaredBy: ctx.actor,
        declaredAt: at,
        status: "active",
        incidentId: incident.id,
        // Snapshot at declaration: never edited. Changes live in roll entries.
        rollSnapshot: roll,
        otherShaftsSnapshot: others,
        alertsSentAt: null,
        musterId: null,
      },
      null,
      [{ id: incident.id, relation: "incident" }, ...roll.map((r) => ({ id: r.checkInId, relation: "rescue-roll" }))],
    );
    for (const r of [...roll, ...others])
      await insert(
        ctx,
        "roll-entry",
        { emergencyId: emergency.id, checkInId: r.checkInId, personId: r.personId, name: r.name, shaftName: r.shaftName, atAffectedShaft: r.shaftId === shaft.id, status: "unconfirmed", history: [{ status: "unconfirmed", at, actor: ctx.actor, note: "On roll at declaration" }] },
        r.declaredZoneId,
        [{ id: emergency.id, relation: "emergency" }, { id: r.checkInId, relation: "check-in" }],
      );
    return emergency;
  });
}
/** Rescuers mark each person; every change is timestamped and audited. */
export async function updateRollEntry(ctx: Context, entryId: string, input: unknown, now = new Date()) {
  requireSupervisor(ctx);
  const body = rollUpdateSchema.parse(input);
  return atomic(async () => {
    const entry = await get(ctx, entryId, "roll-entry");
    const emergency = await get(ctx, String(entry.data.emergencyId), "emergency");
    const at = now.toISOString();
    const next = await update(ctx, entry, body.expectedRevision, {
      ...entry.data,
      status: body.status,
      history: [...(entry.data.history as unknown[]), { status: body.status, at, actor: ctx.actor, note: body.note }],
    });
    const checkIn = await get(ctx, String(entry.data.checkInId), "check-in");
    const target = body.status === "confirmed-missing" ? "confirmed-missing" : "accounted-for";
    if (checkIn.data.status !== target && !(checkIn.data.status === "accounted-for" && target === "accounted-for"))
      await setCheckInStatus(ctx, checkIn, target, "human", `Rescue roll (${body.status}): ${body.note}`, checkIn.revision, now, { incidentId: String(emergency.data.incidentId) });
    return next;
  });
}
/** One action: messages to all buddies and next of kin (respecting messaging mode) and a mine-wide muster. */
export async function alertAndMuster(ctx: Context, emergencyId: string, now = new Date()) {
  requireSupervisor(ctx);
  return atomic(async () => {
    const emergency = await get(ctx, emergencyId, "emergency");
    if (emergency.data.status !== "active") throw new DomainError(409, "EMERGENCY_CLOSED", "This emergency is closed.");
    const roll = emergency.data.rollSnapshot as Awaited<ReturnType<typeof rollRow>>[];
    const queued: string[] = [], skipped: string[] = [];
    for (const r of roll) {
      const vars = { type: String(emergency.data.type), shaft: String(emergency.data.shaftName), name: r.name };
      const person = await get(ctx, r.personId, "person");
      const recipients: { key: "emergency.buddy" | "emergency.kin"; id: string | null; name: string; phone: string | null; channels: { whatsapp: boolean; sms: boolean } }[] = [];
      if (r.buddyPersonId) {
        const b = await get(ctx, r.buddyPersonId, "person");
        recipients.push({ key: "emergency.buddy", id: b.id, name: String(b.data.name), phone: b.data.phoneSealed ? unseal(String(b.data.phoneSealed)) : null, channels: b.data.channels as { whatsapp: boolean; sms: boolean } });
      }
      for (const [i, k] of ((person.data.nextOfKin as { name: string; phoneSealed?: string }[]) || []).entries())
        recipients.push({ key: "emergency.kin", id: null, name: `${k.name} (next of kin of ${r.name}) #${i}`, phone: k.phoneSealed ? unseal(k.phoneSealed) : null, channels: { whatsapp: false, sms: true } });
      for (const rec of recipients) {
        if (!rec.phone) {
          skipped.push(`${rec.name}: no phone`);
          continue;
        }
        const channel = rec.channels.sms ? "sms" : "whatsapp";
        await queueMessage(ctx, { channel, purpose: "emergency", recipientPersonId: rec.id, recipientPhone: rec.phone, templateKey: rec.key, vars, checkInId: r.checkInId, incidentId: String(emergency.data.incidentId), emergencyId: emergency.id, idempotencyKey: `emergency:${emergency.id}:${r.checkInId}:${rec.name}`, failoverChannel: rec.channels.whatsapp && channel === "sms" ? null : rec.channels.sms ? "sms" : null });
        queued.push(rec.name);
      }
    }
    const all = await activeCheckIns(ctx);
    const muster = emergency.data.musterId
      ? await get(ctx, String(emergency.data.musterId), "muster")
      : await insert(
          ctx,
          "muster",
          {
            scope: "mine",
            shaftId: null,
            zoneId: null,
            caseId: emergency.data.incidentId,
            reason: `Emergency at ${emergency.data.shaftName}`,
            rosterAt: now.toISOString(),
            source: "check-ins",
            members: all.map((c) => ({ workerId: c.id, checkInId: c.id, personId: c.data.personId, name: c.data.personName, status: c.data.status, shaftName: c.data.shaftName, confirmed: false, confirmedAt: null, actor: null })),
            status: "awaiting-confirmation",
          },
          null,
          [{ id: emergency.id, relation: "emergency" }],
        );
    await update(ctx, emergency, emergency.revision, { ...emergency.data, alertsSentAt: emergency.data.alertsSentAt || now.toISOString(), musterId: muster.id, alertMode: messagingMode().mode });
    return { queued, skipped, musterId: muster.id, mode: messagingMode().mode };
  });
}
export async function closeEmergency(ctx: Context, id: string, reason: string) {
  requireSupervisor(ctx);
  if (reason.trim().length < 3) throw new DomainError(422, "REASON", "A reason is required.");
  const e = await get(ctx, id, "emergency");
  return await update(ctx, e, e.revision, { ...e.data, status: "closed", closedAt: new Date().toISOString(), closedBy: ctx.actor, closeReason: reason });
}
/** Roll with phone numbers for supervisors/administrators only. */
export async function rescueRoll(ctx: Context, id: string) {
  requireSupervisor(ctx);
  const e = await get(ctx, id, "emergency");
  const entries = (await list(ctx, "roll-entry")).filter((r) => r.data.emergencyId === id);
  const withPhone = async (r: { personId: string }) => {
    const p = await get(ctx, r.personId, "person").catch(() => null);
    return p?.data.phoneSealed ? unseal(String(p.data.phoneSealed)) : null;
  };
  const snapshot = await Promise.all((e.data.rollSnapshot as { personId: string }[]).map(async (r) => ({ ...r, phone: await withPhone(r) })));
  const others = await Promise.all((e.data.otherShaftsSnapshot as { personId: string }[]).map(async (r) => ({ ...r, phone: await withPhone(r) })));
  return { emergency: e, snapshot, others, entries };
}

// ---- incident report ---------------------------------------------------------------
export async function incidentReport(ctx: Context, incidentId: string) {
  requireSupervisor(ctx);
  const incident = await get(ctx, incidentId, "case");
  const { config } = await messagingConfig(ctx);
  const t = (iso: unknown) => (iso ? `${new Date(String(iso)).toISOString().replace("T", " ").slice(0, 16)} UTC (${formatClock(String(iso), config.timezone)} CAT)` : "not recorded");
  const { rows: links } = await query("SELECT target_id,relation FROM foresight.entity_links WHERE workspace_id=$1 AND (source_id=$2 OR target_id=$2)", [ctx.workspaceId, incidentId]);
  const { rows: back } = await query("SELECT source_id FROM foresight.entity_links WHERE workspace_id=$1 AND target_id=$2", [ctx.workspaceId, incidentId]);
  const related = new Set([...links.map((l) => String(l.target_id)), ...back.map((b) => String(b.source_id))]);
  const all = await list(ctx);
  const emergency = all.find((e) => e.kind === "emergency" && e.data.incidentId === incidentId);
  const entries = emergency ? all.filter((e) => e.kind === "roll-entry" && e.data.emergencyId === emergency.id) : [];
  const messages = all.filter((e) => e.kind === "message" && (e.data.incidentId === incidentId || (emergency && e.data.emergencyId === emergency.id) || related.has(e.id)));
  const runs = all.filter((e) => e.kind === "run" && (related.has(e.id) || incident.data.sourceRunId === e.id));
  const checkIns = all.filter((e) => e.kind === "check-in" && related.has(e.id));
  const audit = (await auditLog(ctx)).filter((a) => a.entity_id === incidentId || (emergency && a.entity_id === emergency.id) || entries.some((x) => x.id === a.entity_id));
  const lines: PdfLine[] = [
    { text: `Foresight incident report`, bold: true, size: 16 },
    { text: String(incident.data.title), bold: true, size: 12, gap: 4 },
    { text: `Generated ${t(new Date().toISOString())} by ${ctx.actor}. A named person must review this report before it is sent to any authority.`, size: 8 },
    { text: "Planning calculations in this report are not safety certifications. Check-ins are declarations, not confirmed locations.", size: 8 },
    { text: "Summary", bold: true, gap: 8 },
    { text: `Zone: ${incident.zoneId || "not stated"} · Category: ${incident.data.category || "not classified"} · Source: ${incident.data.source || "not recorded"} · Status: ${incident.data.status}` },
    { text: `Owner: ${incident.data.owner} · Due: ${t(incident.data.dueAt)} · Opened: ${t(incident.createdAt)}` },
    { text: String(incident.data.description || "") },
  ];
  if (emergency) {
    lines.push({ text: "Declared emergency", bold: true, gap: 8 });
    lines.push({ text: `${emergency.data.type} at ${emergency.data.shaftName}; declared by ${emergency.data.declaredBy} at ${t(emergency.data.declaredAt)}. Status: ${emergency.data.status}.` });
    lines.push({ text: `Alerts: ${emergency.data.alertsSentAt ? "requested " + t(emergency.data.alertsSentAt) + " in " + emergency.data.alertMode + " mode" : "not sent"}.` });
    lines.push({ text: "Rescue roll at declaration (snapshot)", bold: true, gap: 6 });
    const snap = emergency.data.rollSnapshot as Record<string, string>[];
    if (!snap.length) lines.push({ text: "Nobody was declared underground at this shaft at declaration." });
    for (const r of snap)
      lines.push({ text: `- ${r.name} (Ref ${r.reference}): in ${t(r.timeIn)}; expected back ${t(r.expectedReturn)}; zone ${r.declaredZoneId || "not stated"}; buddy ${r.buddyName || "none"}; phone ${r.phoneMasked || "none"}; status then ${r.status}` });
    lines.push({ text: "Declared at other shafts (listed for confirmation)", bold: true, gap: 6 });
    for (const r of emergency.data.otherShaftsSnapshot as Record<string, string>[]) lines.push({ text: `- ${r.name} at ${r.shaftName} (Ref ${r.reference}), expected back ${t(r.expectedReturn)}` });
    lines.push({ text: "Roll changes", bold: true, gap: 6 });
    for (const e of entries)
      for (const h of e.data.history as { status: string; at: string; actor: string; note: string }[])
        lines.push({ text: `- ${t(h.at)} ${e.data.name}: ${h.status} by ${h.actor} - ${h.note}` });
  }
  if (checkIns.length) {
    lines.push({ text: "Linked check-ins", bold: true, gap: 8 });
    for (const c of checkIns) lines.push({ text: `- ${c.data.personName} at ${c.data.shaftName}, Ref ${c.data.reference}: in ${t(c.data.timeIn)}, expected ${t(c.data.expectedReturn)}, status ${c.data.status}` });
  }
  lines.push({ text: "Messages and delivery status", bold: true, gap: 8 });
  if (!messages.length) lines.push({ text: "No messages linked." });
  for (const m of messages)
    lines.push({ text: `- ${m.data.direction} ${String(m.data.channel).toUpperCase()} ${m.data.direction === "outbound" ? "to " + m.data.recipientMasked : "from " + m.data.senderMasked} (${m.data.templateKey || "inbound"}): ${(m.data.statusHistory as { status: string; at: string }[]).map((h) => `${h.status} ${t(h.at)}`).join(" -> ")}` });
  lines.push({ text: "Linked scenario runs and assumptions", bold: true, gap: 8 });
  if (!runs.length) lines.push({ text: "No scenario runs linked." });
  for (const r of runs) lines.push({ text: `- Run ${r.id.slice(0, 8)}: ${String(r.data.status)}; input hash ${String((r.data.result as { inputHash?: string })?.inputHash || "n/a")}; planning calculation under stated assumptions` });
  lines.push({ text: "Responses and actions", bold: true, gap: 8 });
  for (const a of (incident.data.actions as { title: string; completed: boolean; dueAt: string }[]) || []) lines.push({ text: `- ${a.title} (${a.completed ? "completed" : "open"}, due ${t(a.dueAt)})` });
  for (const h of (incident.data.history as { at: string; actor: string; status: string; reason: string }[]) || []) lines.push({ text: `- ${t(h.at)} ${h.status} by ${h.actor}: ${h.reason}` });
  lines.push({ text: "Audit trail", bold: true, gap: 8 });
  for (const a of audit.slice().reverse()) lines.push({ text: `- ${t(a.server_at)} ${a.operation} by ${a.actor}`, size: 8 });
  return { incident, lines, pdf: textPdf(String(incident.data.title), lines) };
}
