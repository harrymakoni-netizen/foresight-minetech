// SMS gateway heartbeat and service health (spec §6.6, §6.3). SMSGate health
// responses use status pass/warn/fail with named checks (official client
// 4.4.0). A battery check is recognised by name and percent unit.
import { query } from "./db.ts";
import { list } from "./repository.ts";
import { queueMessage, serviceContext, type Channel } from "./messaging.ts";
import { unseal } from "./personal.ts";

export type GatewayState = {
  gateway: string;
  status: "online" | "degraded" | "offline" | "not-configured";
  reason: string;
  batteryPercent: number | null;
  checkedAt: string;
  lastOnlineAt: string | null;
  outageSince: string | null;
};
const LOW_BATTERY = Number(process.env.SMSGATE_LOW_BATTERY_PERCENT || 20);
export async function heartbeat(service: string, detail: unknown, at = new Date()) {
  await query(
    "INSERT INTO foresight.service_heartbeats VALUES($1,$2,$3) ON CONFLICT(service) DO UPDATE SET beat_at=excluded.beat_at,detail=excluded.detail",
    [service, at.toISOString(), JSON.stringify(detail)],
  );
}
export async function readHeartbeats() {
  const { rows } = await query("SELECT service,beat_at,detail FROM foresight.service_heartbeats");
  return Object.fromEntries(
    rows.map((r) => [r.service as string, { beatAt: r.beat_at as string, detail: JSON.parse(r.detail) as unknown }]),
  ) as Record<string, { beatAt: string; detail: unknown }>;
}
async function probe(prefix: string): Promise<Omit<GatewayState, "gateway" | "checkedAt" | "lastOnlineAt" | "outageSince">> {
  const base = process.env[`${prefix}_URL`]?.replace(/\/$/, "");
  const user = process.env[`${prefix}_USERNAME`], pass = process.env[`${prefix}_PASSWORD`], token = process.env[`${prefix}_TOKEN`];
  if (!base || !((user && pass) || token))
    return { status: "not-configured", reason: "No gateway URL and credentials configured", batteryPercent: null };
  try {
    const response = await fetch(`${base}/health`, {
      headers: { Authorization: user && pass ? "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") : `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) return { status: "offline", reason: `Health HTTP ${response.status}`, batteryPercent: null };
    const checks = (body.checks || {}) as Record<string, { status?: string; observedValue?: number; observedUnit?: string; description?: string }>;
    const battery = Object.entries(checks).find(([name, c]) => /battery/i.test(name) && /percent|%/i.test(String(c.observedUnit || "")));
    const batteryPercent = battery && typeof battery[1].observedValue === "number" ? battery[1].observedValue : null;
    if (body.status === "fail") {
      const failing = Object.entries(checks).filter(([, c]) => c.status === "fail").map(([n]) => n);
      return { status: "offline", reason: `Gateway reports fail${failing.length ? ": " + failing.join(", ") : ""}`, batteryPercent };
    }
    if (batteryPercent !== null && batteryPercent < LOW_BATTERY)
      return { status: "degraded", reason: `Low battery ${batteryPercent}%`, batteryPercent };
    if (body.status === "warn") return { status: "degraded", reason: "Gateway reports warnings", batteryPercent };
    return { status: "online", reason: "Health pass", batteryPercent };
  } catch (e) {
    return { status: "offline", reason: `Unreachable: ${(e as Error).message}`, batteryPercent: null };
  }
}
/** Poll configured gateways, persist state, alert administrators on a new outage. */
export async function pollGateways(now = new Date()) {
  const previous = await readHeartbeats();
  const states: GatewayState[] = [];
  for (const [prefix, name] of [["SMSGATE", "primary"], ["SMSGATE_SECONDARY", "secondary"]] as const) {
    const p = await probe(prefix);
    if (p.status === "not-configured" && name === "secondary") continue;
    const before = previous[`gateway:${name}`]?.detail as GatewayState | undefined;
    const bad = p.status === "offline" || p.status === "degraded";
    const state: GatewayState = {
      gateway: name,
      ...p,
      checkedAt: now.toISOString(),
      lastOnlineAt: p.status === "online" ? now.toISOString() : before?.lastOnlineAt || null,
      outageSince: bad ? before?.outageSince || now.toISOString() : null,
    };
    await heartbeat(`gateway:${name}`, state, now);
    states.push(state);
    if (bad && !before?.outageSince) await alertAdministrators(state);
  }
  return states;
}
async function alertAdministrators(state: GatewayState) {
  const { rows } = await query("SELECT DISTINCT workspace_id FROM foresight.messaging_channels");
  for (const row of rows) {
    const ctx = serviceContext(row.workspace_id);
    for (const p of (await list(ctx, "person")).filter((x) => x.data.role === "administrator" || x.data.role === "supervisor")) {
      if (!p.data.phoneSealed) continue;
      const ch = p.data.channels as { whatsapp: boolean; sms: boolean };
      // WhatsApp first: the SMS gateway is the thing that is down.
      const channel: Channel = ch.whatsapp ? "whatsapp" : "sms";
      await queueMessage(ctx, {
        channel,
        purpose: "admin-alert",
        recipientPersonId: p.id,
        recipientPhone: unseal(String(p.data.phoneSealed)),
        templateKey: "gateway.offline",
        vars: { gateway: state.gateway, reason: state.reason },
        idempotencyKey: `gateway-offline:${state.gateway}:${state.outageSince}:${p.id}`,
      });
    }
  }
}
export const SCHEDULER_STALE_MS = 90_000;
/** What Underground now shows: messaging mode, gateway and scheduler health. */
export async function messagingHealth(now = new Date()) {
  const beats = await readHeartbeats();
  const scheduler = beats["messaging-service"];
  const schedulerOk = Boolean(scheduler && now.getTime() - Date.parse(scheduler.beatAt) < SCHEDULER_STALE_MS);
  const gateways = Object.entries(beats)
    .filter(([k]) => k.startsWith("gateway:"))
    .map(([, v]) => v.detail as GatewayState);
  const weatherError = beats["weather-error"]?.detail as { at: string; detail: string } | undefined;
  return {
    weatherError: weatherError || null,
    scheduler: {
      running: schedulerOk,
      lastBeatAt: scheduler?.beatAt || null,
      message: schedulerOk
        ? "Escalation scheduler running"
        : scheduler
          ? "Escalation scheduler stopped: overdue alerts are not being sent"
          : "Escalation scheduler has never reported: overdue alerts are not being sent",
    },
    gateways: gateways.length
      ? gateways.map((g) => ({ ...g, stale: now.getTime() - Date.parse(g.checkedAt) > 5 * 60e3 }))
      : [{ gateway: "primary", status: "not-configured", reason: "No gateway health reported", batteryPercent: null, checkedAt: null, lastOnlineAt: null, outageSince: null, stale: true }],
  };
}
