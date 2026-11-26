// Outbound messaging (spec §6.5–6.6). Every message is an audited entity with
// a status history. Server-enforced modes:
//   dry-run    (default) — written to the outbox only; nothing leaves Foresight
//   allow-list — sent only to numbers in MESSAGING_TEST_NUMBERS
//   live       — needs MESSAGING_MODE=live AND an administrator enabling it in
//                workspace settings. Never set by automation.
// "accepted" by a provider is not "delivered"; only a delivery receipt is.
import { randomUUID } from "node:crypto";
import { query, lock } from "./db.ts";
import {
  atomic,
  get,
  insert,
  update,
  list,
  DomainError,
  type Context,
} from "./repository.ts";
import type { Entity } from "../domain/contracts.ts";
import { render, type Lang, type TemplateKey } from "../messaging/templates.ts";
import { maskPhone, normalisePhone, seal, unseal } from "./personal.ts";
import { trainingConfig, type MessagingConfig } from "../domain/checkin.ts";

export type Channel = "sms" | "whatsapp";
export type MessageStatus =
  | "queued"
  | "dry-run"
  | "blocked"
  | "accepted"
  | "delivered"
  | "failed"
  | "unconfirmed"
  | "received";
export type Purpose =
  | "reply"
  | "reminder"
  | "buddy-alert"
  | "supervisor-alert"
  | "admin-alert"
  | "emergency"
  | "advisory";

// ---- mode -------------------------------------------------------------------
export function messagingMode() {
  const raw = (process.env.MESSAGING_MODE || "dry-run").trim();
  const mode = (["dry-run", "allow-list", "live"].includes(raw) ? raw : "dry-run") as
    | "dry-run"
    | "allow-list"
    | "live";
  const testNumbers = new Set<string>();
  for (const n of (process.env.MESSAGING_TEST_NUMBERS || "").split(",")) {
    try {
      if (n.trim()) testNumbers.add(normalisePhone(n.trim()));
    } catch {
      /* invalid entries are ignored, never widened */
    }
  }
  return {
    mode,
    testNumberCount: testNumbers.size,
    testNumbers,
    problem: raw !== mode ? `Unknown MESSAGING_MODE "${raw}"; using dry-run.` : null,
  };
}

// ---- providers ----------------------------------------------------------------
export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}
export type SendRequest = {
  id: string;
  to: string;
  text: string;
  templateKey: string;
  vars: Record<string, string | number>;
  businessInitiated: boolean;
};
export type Provider = {
  name: string;
  configured: () => boolean;
  send: (r: SendRequest) => Promise<{ providerMessageId: string }>;
};
async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new ProviderError(`Provider unreachable: ${(e as Error).message}`, true);
  }
  const text = await response.text();
  if (!response.ok)
    throw new ProviderError(
      `Provider HTTP ${response.status}: ${text.slice(0, 200)}`,
      response.status >= 500 || response.status === 429,
    );
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("Provider returned invalid JSON", false);
  }
}
/** SMSGate (Android gateway). Shapes from the official client 4.4.0. */
export function smsGateProvider(prefix = "SMSGATE"): Provider {
  const base = () => process.env[`${prefix}_URL`]?.replace(/\/$/, "");
  const auth = () => {
    const user = process.env[`${prefix}_USERNAME`],
      pass = process.env[`${prefix}_PASSWORD`],
      token = process.env[`${prefix}_TOKEN`];
    if (user && pass) return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
    if (token) return "Bearer " + token;
    return null;
  };
  return {
    name: prefix === "SMSGATE" ? "smsgate" : "smsgate-secondary",
    configured: () => Boolean(base() && auth()),
    async send(r) {
      if (!base() || !auth()) throw new ProviderError("SMS gateway is not configured", false);
      const result = await postJson(`${base()}/messages`, { Authorization: auth()! }, {
        id: r.id,
        textMessage: { text: r.text },
        phoneNumbers: [r.to],
        withDeliveryReport: true,
      });
      if (!result?.id) throw new ProviderError("Gateway response has no message id", false);
      return { providerMessageId: String(result.id) };
    },
  };
}
/**
 * WhatsApp Cloud API. Business-initiated messages need an approved template
 * configured in WHATSAPP_TEMPLATES ({"<templateKey>": {"name","language",
 * "approved":true,"params":["var",...]}}); replies inside a conversation use
 * text. Field shapes follow Meta's published Cloud API; they could not be
 * re-checked from this environment and await verification with a test app.
 */
export function whatsappProvider(): Provider {
  const phoneId = () => process.env.WHATSAPP_PHONE_NUMBER_ID,
    token = () => process.env.WHATSAPP_ACCESS_TOKEN,
    version = () => process.env.WHATSAPP_GRAPH_VERSION;
  return {
    name: "whatsapp",
    configured: () => Boolean(phoneId() && token() && version()),
    async send(r) {
      if (!phoneId() || !token() || !version())
        throw new ProviderError("WhatsApp Cloud API is not configured", false);
      let body: Record<string, unknown>;
      if (r.businessInitiated) {
        const t = whatsappTemplates()[r.templateKey];
        if (!t?.approved)
          throw new ProviderError(`WhatsApp template for ${r.templateKey} not approved`, false);
        body = {
          messaging_product: "whatsapp",
          to: r.to.replace(/^\+/, ""),
          type: "template",
          template: {
            name: t.name,
            language: { code: t.language },
            components: [
              {
                type: "body",
                parameters: (t.params || []).map((p) => ({ type: "text", text: String(r.vars[p] ?? "") })),
              },
            ],
          },
        };
      } else
        body = {
          messaging_product: "whatsapp",
          to: r.to.replace(/^\+/, ""),
          type: "text",
          text: { body: r.text },
        };
      const result = await postJson(
        `https://graph.facebook.com/${version()}/${phoneId()}/messages`,
        { Authorization: `Bearer ${token()}` },
        body,
      );
      const id = result?.messages?.[0]?.id;
      if (!id) throw new ProviderError("WhatsApp response has no message id", false);
      return { providerMessageId: String(id) };
    },
  };
}
export function whatsappTemplates(): Record<
  string,
  { name: string; language: string; approved: boolean; params?: string[] }
> {
  try {
    return JSON.parse(process.env.WHATSAPP_TEMPLATES || "{}");
  } catch {
    return {};
  }
}
export type Providers = { sms: Provider[]; whatsapp: Provider };
export const defaultProviders = (): Providers => ({
  sms: [smsGateProvider("SMSGATE"), smsGateProvider("SMSGATE_SECONDARY")],
  whatsapp: whatsappProvider(),
});

// ---- configuration -------------------------------------------------------------
export async function messagingConfig(ctx: Context): Promise<{ entity: Entity | null; config: MessagingConfig }> {
  const entity = (await list(ctx, "messaging-config"))[0] || null;
  // Older saved configurations lack the phase 6 fields; fill their defaults.
  return { entity, config: entity ? ({ ...trainingConfig, ...(entity.data as MessagingConfig) } as MessagingConfig) : trainingConfig };
}

// ---- queue ------------------------------------------------------------------------
export type QueueInput = {
  channel: Channel;
  purpose: Purpose;
  recipientPersonId: string | null;
  recipientPhone: string;
  templateKey: TemplateKey;
  vars?: Record<string, string | number>;
  lang?: Lang;
  checkInId?: string | null;
  incidentId?: string | null;
  emergencyId?: string | null;
  idempotencyKey: string;
  failoverOf?: string | null;
  failoverChannel?: Channel | null;
  dueAt?: string;
};
const history = (status: MessageStatus, detail: string, at = new Date().toISOString()) => ({
  status,
  at,
  detail,
});
/** Queue once per idempotency key; returns the existing message on repeat. */
export async function queueMessage(ctx: Context, input: QueueInput): Promise<Entity> {
  return atomic(async () => {
    await lock("message:" + input.idempotencyKey);
    const {
      rows: [existing],
    } = await query("SELECT message_id FROM foresight.message_queue WHERE idempotency_key=$1", [
      input.idempotencyKey,
    ]);
    if (existing) return await get(ctx, existing.message_id, "message");
    const rendered = render(input.templateKey, input.vars || {}, input.lang || "en");
    const phone = normalisePhone(input.recipientPhone);
    const links = [
      ...(input.checkInId ? [{ id: input.checkInId, relation: "check-in" }] : []),
      ...(input.incidentId ? [{ id: input.incidentId, relation: "incident" }] : []),
      ...(input.emergencyId ? [{ id: input.emergencyId, relation: "emergency" }] : []),
      ...(input.failoverOf ? [{ id: input.failoverOf, relation: "failover-of" }] : []),
    ];
    const message = await insert(
      ctx,
      "message",
      {
        direction: "outbound",
        channel: input.channel,
        purpose: input.purpose,
        recipientPersonId: input.recipientPersonId,
        recipientSealed: seal(phone),
        recipientMasked: maskPhone(phone),
        templateKey: rendered.key,
        lang: rendered.lang,
        translationFallback: rendered.fallback,
        text: rendered.text,
        vars: input.vars || {},
        checkInId: input.checkInId || null,
        incidentId: input.incidentId || null,
        emergencyId: input.emergencyId || null,
        failoverOf: input.failoverOf || null,
        failoverChannel: input.failoverChannel ?? null,
        providerMessageId: null,
        provider: null,
        status: "queued",
        statusHistory: [history("queued", "Queued in the Foresight outbox")],
        idempotencyKey: input.idempotencyKey,
      },
      null,
      links,
    );
    await query(
      "INSERT INTO foresight.message_queue(message_id,idempotency_key,workspace_id,due_at,attempts) VALUES($1,$2,$3,$4,0)",
      [message.id, input.idempotencyKey, ctx.workspaceId, input.dueAt || new Date().toISOString()],
    );
    return message;
  });
}
async function setStatus(
  ctx: Context,
  message: Entity,
  status: MessageStatus,
  detail: string,
  extra: Record<string, unknown> = {},
  at?: string,
) {
  return await update(ctx, message, message.revision, {
    ...message.data,
    ...extra,
    status,
    statusHistory: [...(message.data.statusHistory as unknown[]), history(status, detail, at)],
  });
}
export const serviceContext = (workspaceId: string, mode = "demonstration"): Context => ({
  workspaceId,
  userId: "foresight-messaging-service",
  actor: "Foresight messaging service",
  role: "administrator",
  mode,
});

/** Send due queued messages across workspaces. Returns a summary. */
export async function dispatchDue(now = new Date(), providers: Providers = defaultProviders()) {
  const nowIso = now.toISOString();
  const { rows } = await query(
    "SELECT message_id,workspace_id FROM foresight.message_queue WHERE sent_at IS NULL AND due_at<=$1 AND (claimed_until IS NULL OR claimed_until<$1) ORDER BY due_at LIMIT 25",
    [nowIso],
  );
  const outcomes: { id: string; status: string }[] = [];
  for (const row of rows) {
    const claimed = await query(
      "UPDATE foresight.message_queue SET claimed_until=$1 WHERE message_id=$2 AND sent_at IS NULL AND (claimed_until IS NULL OR claimed_until<$3)",
      [new Date(now.getTime() + 60e3).toISOString(), row.message_id, nowIso],
    );
    if (!claimed.changes) continue;
    outcomes.push({ id: row.message_id, status: await dispatchOne(row.workspace_id, row.message_id, now, providers) });
  }
  return outcomes;
}
async function finish(id: string, now: Date, deadline: string | null, settled: boolean) {
  await query(
    "UPDATE foresight.message_queue SET sent_at=$1,receipt_deadline=$2,settled_at=$3,claimed_until=NULL WHERE message_id=$4",
    [now.toISOString(), deadline, settled ? now.toISOString() : null, id],
  );
}
async function dispatchOne(workspaceId: string, id: string, now: Date, providers: Providers) {
  const ctx = serviceContext(workspaceId);
  const message = await get(ctx, id, "message");
  const { config } = await messagingConfig(ctx);
  const mode = messagingMode();
  const phone = unseal(String(message.data.recipientSealed));
  const at = now.toISOString();
  if (mode.mode === "dry-run") {
    await setStatus(ctx, message, "dry-run", "Dry-run mode: written to the outbox only; not sent to anyone", {}, at);
    await finish(id, now, null, true);
    return "dry-run";
  }
  if (mode.mode === "allow-list" && !mode.testNumbers.has(phone)) {
    await setStatus(ctx, message, "blocked", "Allow-list mode: recipient is not in MESSAGING_TEST_NUMBERS; not sent", {}, at);
    await finish(id, now, null, true);
    return "blocked";
  }
  if (mode.mode === "live" && !config.liveEnabled) {
    await setStatus(ctx, message, "blocked", "Live messaging has not been enabled by an administrator; not sent", {}, at);
    await finish(id, now, null, true);
    return "blocked";
  }
  const channel = message.data.channel as Channel;
  const candidates = channel === "sms" ? providers.sms.filter((p) => p.configured()) : [providers.whatsapp].filter((p) => p.configured());
  const request: SendRequest = {
    id,
    to: phone,
    text: String(message.data.text),
    templateKey: String(message.data.templateKey),
    vars: (message.data.vars as Record<string, string | number>) || {},
    businessInitiated: message.data.purpose !== "reply",
  };
  let lastError = channel === "sms" ? "SMS gateway is not configured" : "WhatsApp Cloud API is not configured";
  let retryable = false;
  for (const provider of candidates) {
    try {
      const { providerMessageId } = await provider.send(request);
      await atomic(async () => {
        await setStatus(ctx, message, "accepted", `Accepted by ${provider.name}; awaiting delivery receipt`, { providerMessageId, provider: provider.name }, at);
        await query(
          "INSERT INTO foresight.provider_messages VALUES($1,$2,'outbound',$3,$4,$5) ON CONFLICT DO NOTHING",
          [provider.name.startsWith("smsgate") ? "smsgate" : provider.name, providerMessageId, workspaceId, id, at],
        );
        await finish(id, now, new Date(now.getTime() + config.unconfirmedAfterMinutes * 60e3).toISOString(), false);
      });
      return "accepted";
    } catch (e) {
      lastError = `${provider.name}: ${(e as Error).message}`;
      retryable = e instanceof ProviderError && e.retryable;
    }
  }
  const { rows: [q] } = await query("SELECT attempts FROM foresight.message_queue WHERE message_id=$1", [id]);
  const attempts = Number(q?.attempts || 0) + 1;
  if (retryable && attempts < 3) {
    await query(
      "UPDATE foresight.message_queue SET attempts=$1,due_at=$2,claimed_until=NULL WHERE message_id=$3",
      [attempts, new Date(now.getTime() + attempts * 30e3).toISOString(), id],
    );
    await setStatus(ctx, message, "queued", `Attempt ${attempts} failed (${lastError}); retrying`, {}, at);
    return "retry";
  }
  const failed = await setStatus(ctx, message, "failed", lastError, {}, at);
  await finish(id, now, null, true);
  await failover(ctx, failed);
  return "failed";
}
/** WhatsApp failed → SMS copy, when the message names a fallback channel. */
async function failover(ctx: Context, message: Entity) {
  const next = message.data.failoverChannel as Channel | null;
  if (!next || next === message.data.channel) return null;
  return await queueMessage(ctx, {
    channel: next,
    purpose: message.data.purpose as Purpose,
    recipientPersonId: (message.data.recipientPersonId as string) || null,
    recipientPhone: unseal(String(message.data.recipientSealed)),
    templateKey: message.data.templateKey as TemplateKey,
    vars: message.data.vars as Record<string, string | number>,
    checkInId: (message.data.checkInId as string) || null,
    incidentId: (message.data.incidentId as string) || null,
    emergencyId: (message.data.emergencyId as string) || null,
    idempotencyKey: `${message.data.idempotencyKey}:failover-${next}`,
    failoverOf: message.id,
    failoverChannel: null,
  });
}

/** Delivery receipt from a provider webhook. Unknown ids are ignored. */
export async function applyReceipt(
  provider: string,
  providerMessageId: string,
  status: "sent" | "delivered" | "failed" | "read",
  at: string,
  detail = "",
) {
  const {
    rows: [row],
  } = await query(
    "SELECT workspace_id,message_id FROM foresight.provider_messages WHERE provider=$1 AND provider_message_id=$2 AND direction='outbound'",
    [provider, providerMessageId],
  );
  if (!row) return { applied: false, reason: "unknown message" };
  const ctx = serviceContext(row.workspace_id);
  return atomic(async () => {
    await lock("receipt:" + row.message_id);
    const message = await get(ctx, row.message_id, "message");
    const current = message.data.status as MessageStatus;
    if (status === "sent")
      return { applied: false, reason: "handset/provider 'sent' is not delivery; recorded only in provider logs" };
    if (status === "delivered" || status === "read") {
      if (current === "delivered") return { applied: false, reason: "duplicate" };
      await setStatus(ctx, message, "delivered", `Delivery receipt from ${provider}${detail ? ": " + detail : ""}`, {}, at);
      await query("UPDATE foresight.message_queue SET settled_at=$1 WHERE message_id=$2", [at, row.message_id]);
      return { applied: true };
    }
    if (current === "failed") return { applied: false, reason: "duplicate" };
    const failed = await setStatus(ctx, message, "failed", `Provider reported failure${detail ? ": " + detail : ""}`, {}, at);
    await query("UPDATE foresight.message_queue SET settled_at=$1 WHERE message_id=$2", [at, row.message_id]);
    await failover(ctx, failed);
    return { applied: true };
  });
}
/** Accepted messages with no receipt by their deadline become "unconfirmed". */
export async function sweepUnconfirmed(now = new Date()) {
  const { rows } = await query(
    "SELECT message_id,workspace_id FROM foresight.message_queue WHERE sent_at IS NOT NULL AND settled_at IS NULL AND receipt_deadline<$1",
    [now.toISOString()],
  );
  for (const row of rows) {
    const ctx = serviceContext(row.workspace_id);
    const message = await get(ctx, row.message_id, "message");
    if (message.data.status === "accepted")
      await setStatus(ctx, message, "unconfirmed", "No delivery receipt before the configured deadline", {}, now.toISOString());
    await query("UPDATE foresight.message_queue SET settled_at=$1 WHERE message_id=$2", [now.toISOString(), row.message_id]);
  }
  return rows.length;
}
/** Record an inbound message once (provider id replay protection). */
export async function recordInbound(
  ctx: Context,
  input: { provider: string; providerMessageId: string; channel: Channel; from: string; text: string; receivedAt: string; personId: string | null },
): Promise<Entity | null> {
  return atomic(async () => {
    await lock(`inbound:${input.provider}:${input.providerMessageId}`);
    const { rows } = await query(
      "SELECT 1 FROM foresight.provider_messages WHERE provider=$1 AND provider_message_id=$2 AND direction='inbound'",
      [input.provider, input.providerMessageId],
    );
    if (rows.length) return null;
    const phone = normalisePhone(input.from);
    const message = await insert(ctx, "message", {
      direction: "inbound",
      channel: input.channel,
      purpose: "inbound",
      senderPersonId: input.personId,
      senderSealed: seal(phone),
      senderMasked: maskPhone(phone),
      text: input.text.slice(0, 2000),
      providerMessageId: input.providerMessageId,
      provider: input.provider,
      status: "received",
      statusHistory: [history("received", `Received via ${input.provider}`, input.receivedAt)],
    });
    await query("INSERT INTO foresight.provider_messages VALUES($1,$2,'inbound',$3,$4,$5)", [
      input.provider,
      input.providerMessageId,
      ctx.workspaceId,
      message.id,
      new Date().toISOString(),
    ]);
    return message;
  });
}
export async function bindChannel(ctx: Context, provider: string, channelKey: string) {
  if (ctx.role !== "administrator" && ctx.role !== "supervisor")
    throw new DomainError(403, "ROLE_REQUIRED", "A supervisor or administrator role is required.");
  await query(
    "INSERT INTO foresight.messaging_channels VALUES($1,$2,$3,$4) ON CONFLICT(provider,channel_key) DO UPDATE SET workspace_id=excluded.workspace_id",
    [provider, channelKey, ctx.workspaceId, new Date().toISOString()],
  );
  return { provider, channelKey, workspaceId: ctx.workspaceId };
}
export async function channelWorkspace(provider: string, channelKey: string) {
  const {
    rows: [row],
  } = await query("SELECT workspace_id FROM foresight.messaging_channels WHERE provider=$1 AND channel_key=$2", [
    provider,
    channelKey,
  ]);
  return (row?.workspace_id as string) || null;
}
export const newMessageKey = () => randomUUID();
