// Phase 6 server logic: assessment context for development-controls-2, rain
// forecast polling, pre-entry check records and the do-not-enter advisory.
// Kept free of imports from workflows.ts so check-ins and the messaging service
// can use it.
import { z } from "zod";
import { assess, developmentContextDefaults, type AssessContext } from "../domain/assessment.ts";
import type { Assessment, Entity } from "../domain/contracts.ts";
import { isActive } from "../domain/checkin.ts";
import { OPEN_METEO_SOURCE, isHeavyRain, openMeteoUrl, parseOpenMeteo, type ForecastSummary } from "../domain/weather.ts";
import type { PreEntryAnswer, PreEntryRecord } from "../domain/precheck.ts";
import { DomainError, get, insert, list, update, type Context } from "./repository.ts";
import { messagingConfig, queueMessage, serviceContext } from "./messaging.ts";
import { heartbeat } from "./gateway.ts";
import { query } from "./db.ts";
import { unseal } from "./personal.ts";

// ---- assessments ----------------------------------------------------------------
export async function assessmentContext(ctx: Context, cutoffAt: string): Promise<AssessContext> {
  const { config } = await messagingConfig(ctx);
  const shafts = config.shafts.map((s) => ({ id: s.id, name: s.name, zoneIds: s.zoneIds }));
  const declaredByZone: Record<string, number> = {};
  for (const c of await list(ctx, "check-in")) {
    if (!isActive(String(c.data.status))) continue;
    const zone = (c.data.declaredZoneId as string | null) || shafts.find((s) => s.id === c.data.shaftId)?.zoneIds[0];
    if (zone) declaredByZone[zone] = (declaredByZone[zone] || 0) + 1;
  }
  const f = (await list(ctx, "forecast")).find((e) => Date.parse(String(e.data.retrievedAt)) <= Date.parse(cutoffAt));
  return {
    declaredByZone,
    shafts,
    forecast: f ? { id: f.id, retrievedAt: String(f.data.retrievedAt), summary: f.data.summary as ForecastSummary } : null,
    weather: config.weather,
    preEntry: (await list(ctx, "pre-entry-check")).map((e) => ({ id: e.id, ...(e.data as Omit<PreEntryRecord, "id">) })),
    subsidence: (await list(ctx, "subsidence-mark")).map((e) => ({
      id: e.id,
      zoneId: String(e.data.zoneId),
      markedAt: String(e.data.markedAt),
      note: String(e.data.note || ""),
    })),
    ...developmentContextDefaults,
  };
}
/** Create a new immutable assessment under development-controls-2. */
export async function newAssessment(ctx: Context, now = new Date()) {
  const prior = (await list(ctx, "assessment"))[0];
  const cutoffAt = now.toISOString();
  const x = await assessmentContext(ctx, cutoffAt);
  const data = assess(await list(ctx, "observation"), cutoffAt, prior?.id || null, x);
  const evidenceIds = [...new Set(data.concerns.flatMap((c) => (c.evidence || []).map((e) => e.id)))];
  return await insert(
    ctx,
    "assessment",
    data,
    null,
    [...data.observationIds, ...evidenceIds].map((id) => ({ id, relation: "input" })),
  );
}
/** Fresh assessment only when concerns would differ, so polling does not flood the record. */
export async function reassessIfChanged(ctx: Context, now = new Date()): Promise<Entity | null> {
  const prior = (await list(ctx, "assessment"))[0];
  const cutoffAt = now.toISOString();
  const data = assess(await list(ctx, "observation"), cutoffAt, prior?.id || null, await assessmentContext(ctx, cutoffAt));
  const key = (a: Assessment) => JSON.stringify(a.concerns.map((c) => [c.id, c.priority, c.reason]).sort());
  if (prior && key(prior.data as unknown as Assessment) === key(data) && (prior.data as unknown as Assessment).policyVersion === data.policyVersion) return null;
  return await newAssessment(ctx, now);
}

// ---- rain forecast ---------------------------------------------------------------
export type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
const pollMinutes = () => Number(process.env.WEATHER_POLL_MINUTES || 180);
export type WeatherPoll = { workspaceId: string; outcome: "no-location" | "fresh-enough" | "stored" | "failed"; detail: string };
/** One workspace: fetch and store a forecast when the latest is older than the poll interval. */
export async function pollWeatherFor(ctx: Context, now = new Date(), fetcher: Fetcher = fetch as unknown as Fetcher, force = false): Promise<WeatherPoll> {
  const { config } = await messagingConfig(ctx);
  if (!config.weather) return { workspaceId: ctx.workspaceId, outcome: "no-location", detail: "No mine location configured" };
  const latest = (await list(ctx, "forecast"))[0];
  if (!force && latest && now.getTime() - Date.parse(String(latest.data.retrievedAt)) < pollMinutes() * 60e3)
    return { workspaceId: ctx.workspaceId, outcome: "fresh-enough", detail: `Latest forecast retrieved ${latest.data.retrievedAt}` };
  const url = openMeteoUrl(config.weather.latitude, config.weather.longitude, process.env.OPEN_METEO_BASE_URL || undefined);
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Open-Meteo answered HTTP ${response.status}`);
    const retrievedAt = now.toISOString();
    const summary = parseOpenMeteo(await response.json(), retrievedAt);
    const rain = isHeavyRain(summary, config.weather);
    await insert(ctx, "forecast", {
      source: OPEN_METEO_SOURCE,
      retrievedAt,
      latitude: config.weather.latitude,
      longitude: config.weather.longitude,
      requestUrl: url,
      summary,
      heavy: rain.heavy,
    });
    await reassessIfChanged(ctx, now);
    return { workspaceId: ctx.workspaceId, outcome: "stored", detail: `peak ${summary.maxMmPerHour ?? "unknown"} mm/h, ${summary.totalMm24h ?? "unknown"} mm / 24 h${rain.heavy ? " (heavy)" : ""}` };
  } catch (e) {
    const detail = e instanceof Error ? e.message : "Forecast request failed";
    await heartbeat("weather-error", { at: now.toISOString(), workspaceId: ctx.workspaceId, detail }, now);
    return { workspaceId: ctx.workspaceId, outcome: "failed", detail };
  }
}
/**
 * Messaging-service maintenance: poll forecasts where a location is set, then
 * refresh the assessment of any workspace that has one so ageing evidence
 * (a forecast over 12 h old, a pre-entry "no" over 24 h old) drops out.
 */
export async function maintainConcerns(now = new Date(), fetcher?: Fetcher) {
  const { rows } = await query("SELECT DISTINCT workspace_id FROM foresight.entities WHERE kind IN ('messaging-config','assessment')", []);
  const out: (WeatherPoll & { reassessed: boolean })[] = [];
  for (const r of rows) {
    const ctx = serviceContext(String(r.workspace_id));
    const poll = await pollWeatherFor(ctx, now, fetcher);
    let reassessed = poll.outcome === "stored";
    if (!reassessed && (await list(ctx, "assessment")).length) reassessed = Boolean(await reassessIfChanged(ctx, now));
    out.push({ ...poll, reassessed });
  }
  return out;
}

// ---- pre-entry checks -------------------------------------------------------------
export async function recordPreEntryCheck(ctx: Context, input: { shaftId: string; by: string; personId: string | null; answers: PreEntryAnswer[]; at?: string }) {
  const { config } = await messagingConfig(ctx);
  const shaft = config.shafts.find((s) => s.id === input.shaftId);
  if (!shaft) throw new DomainError(404, "UNKNOWN_SHAFT", "Shaft not found.");
  const check = await insert(ctx, "pre-entry-check", {
    shaftId: shaft.id,
    shaftName: shaft.name,
    at: input.at || new Date().toISOString(),
    by: input.by,
    personId: input.personId,
    answers: input.answers,
  });
  // A "no" changes what Underground now should show, so reassess straight away.
  if (input.answers.some((a) => a.answer === "no")) await newAssessment(ctx);
  return check;
}
export const preEntrySchema = z
  .object({
    shaftId: z.string().min(1).max(64),
    answers: z.array(z.object({ key: z.string().max(40), text: z.string().max(140), answer: z.enum(["yes", "no"]) }).strict()).min(1).max(5),
  })
  .strict();

// ---- do-not-enter advisory ---------------------------------------------------------
export const advisorySchema = z
  .object({
    concernId: z.string().min(1).max(120),
    shaftIds: z.array(z.string().min(1).max(64)).min(1).max(30),
    text: z.string().trim().min(10).max(300),
    hours: z.number().int().min(1).max(48).default(12),
    confirm: z.literal(true),
  })
  .strict();
export async function issueAdvisory(ctx: Context, input: unknown) {
  if (!["supervisor", "administrator"].includes(ctx.role))
    throw new DomainError(403, "ROLE_REQUIRED", "A supervisor or administrator role is required to send an advisory.");
  const body = advisorySchema.parse(input);
  const assessment = (await list(ctx, "assessment"))[0];
  const concern = (assessment?.data as unknown as Assessment | undefined)?.concerns.find((c) => c.id === body.concernId);
  if (!concern) throw new DomainError(404, "CONCERN_NOT_FOUND", "That concern is not in the current assessment.");
  const { config } = await messagingConfig(ctx);
  const shafts = body.shaftIds.map((id) => config.shafts.find((s) => s.id === id));
  if (shafts.some((s) => !s)) throw new DomainError(404, "UNKNOWN_SHAFT", "A shaft in the request does not exist.");
  const now = new Date();
  const advisory = await insert(
    ctx,
    "advisory",
    {
      kind: "do-not-enter",
      concernId: concern.id,
      concernTitle: concern.title,
      assessmentId: assessment.id,
      shaftIds: body.shaftIds,
      text: body.text,
      issuedBy: ctx.actor,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + body.hours * 3600e3).toISOString(),
      status: "active",
      notified: 0,
    },
    null,
    [{ id: assessment.id, relation: "assessment" }],
  );
  // Tell people already declared at those shafts. Messaging mode rules still apply.
  let notified = 0;
  for (const c of await list(ctx, "check-in")) {
    if (!isActive(String(c.data.status)) || !body.shaftIds.includes(String(c.data.shaftId))) continue;
    const person = c.data.personId ? await get(ctx, String(c.data.personId), "person").catch(() => null) : null;
    const sealed = person?.data.phoneSealed ? String(person.data.phoneSealed) : null;
    if (!person || !sealed) continue;
    const channels = person.data.channels as { whatsapp: boolean; sms: boolean };
    await queueMessage(ctx, {
      channel: channels.whatsapp ? "whatsapp" : "sms",
      purpose: "advisory",
      recipientPersonId: person.id,
      recipientPhone: unseal(sealed),
      templateKey: "advisory.notice",
      vars: { text: body.text, shaft: String(c.data.shaftName) },
      checkInId: c.id,
      idempotencyKey: `advisory:${advisory.id}:${c.id}`,
    });
    notified++;
  }
  return await update(ctx, advisory, advisory.revision, { ...advisory.data, notified });
}
export async function withdrawAdvisory(ctx: Context, id: string, reason: string) {
  if (!["supervisor", "administrator"].includes(ctx.role)) throw new DomainError(403, "ROLE_REQUIRED", "A supervisor or administrator role is required.");
  const a = await get(ctx, id, "advisory");
  if (a.data.status !== "active") throw new DomainError(409, "NOT_ACTIVE", "This advisory is not active.");
  return await update(ctx, a, a.revision, { ...a.data, status: "withdrawn", withdrawnBy: ctx.actor, withdrawnAt: new Date().toISOString(), withdrawnReason: reason });
}
/** Advisories in force at a shaft right now (for check-in replies). */
export async function activeAdvisories(ctx: Context, shaftId: string, now = new Date()) {
  return (await list(ctx, "advisory")).filter(
    (a) => a.data.status === "active" && (a.data.shaftIds as string[]).includes(shaftId) && Date.parse(String(a.data.expiresAt)) > now.getTime(),
  );
}

// ---- external sensor readings (slot only, spec §10) ---------------------------------
export const sensorReadingSchema = z
  .object({
    source: z.string().trim().min(2).max(100),
    sensorId: z.string().trim().min(1).max(60),
    zoneId: z.string().max(64).nullable().default(null),
    quantity: z.string().trim().min(2).max(60),
    value: z.number().finite(),
    unit: z.string().trim().min(1).max(20),
    readAt: z.string().datetime({ offset: true }),
    note: z.string().max(300).default(""),
  })
  .strict();
/** Accept an externally supplied reading as evidence with its source and time. No hardware is read and no threshold is applied. */
export async function recordSensorReading(ctx: Context, input: unknown) {
  if (ctx.role !== "administrator") throw new DomainError(403, "ROLE_REQUIRED", "An administrator role is required to record external readings.");
  const body = sensorReadingSchema.parse(input);
  if (Date.parse(body.readAt) > Date.now() + 5 * 60e3) throw new DomainError(422, "FUTURE_READING", "A reading cannot be time-stamped in the future.");
  return await insert(ctx, "sensor-reading", { ...body, recordedBy: ctx.actor, recordedAt: new Date().toISOString(), role: "evidence-only" }, body.zoneId);
}
