// Foresight Lite domain rules (spec §6). Pure functions: no I/O, injectable
// clock. A check-in is a *declaration*; nothing here represents a location.
import { z } from "zod";
import { instant, zoneId } from "./contracts.ts";
import { preEntryConfigSchema, defaultPreEntry } from "./precheck.ts";
import { weatherConfigSchema } from "./weather.ts";

// ---- statuses (spec §6.4) -------------------------------------------------
export const realStatuses = [
  "declared-underground",
  "return-overdue",
  "accounted-for",
  "confirmed-missing",
] as const;
export type RealStatus = (typeof realStatuses)[number];
/** Lives only on scenario run results; never stored on a check-in. */
export const MODELLED_STATUS = "modelled-route-unavailable" as const;
export const statusLabel: Record<RealStatus | typeof MODELLED_STATUS, string> =
  {
    "declared-underground": "Declared underground",
    "return-overdue": "Return overdue",
    "accounted-for": "Accounted for",
    "confirmed-missing": "Confirmed missing",
    "modelled-route-unavailable": "Modelled: route unavailable",
  };
export type StatusActor = "scheduler" | "check-out" | "human";
const transitions: Record<RealStatus, Partial<Record<RealStatus, StatusActor[]>>> = {
  "declared-underground": {
    "return-overdue": ["scheduler"],
    "accounted-for": ["check-out", "human"],
    "confirmed-missing": ["human"],
  },
  "return-overdue": {
    "accounted-for": ["check-out", "human"],
    "confirmed-missing": ["human"],
  },
  "confirmed-missing": { "accounted-for": ["human"] },
  "accounted-for": {},
};
export class StatusError extends Error {}
export function assertTransition(
  from: string,
  to: string,
  by: StatusActor,
  reason?: string,
) {
  if (to === MODELLED_STATUS)
    throw new StatusError(
      "A modelled status comes from a scenario and never changes a real check-in.",
    );
  const allowed = transitions[from as RealStatus]?.[to as RealStatus];
  if (!allowed) throw new StatusError(`Cannot change ${from} to ${to}.`);
  if (!allowed.includes(by))
    throw new StatusError(`Only ${allowed.join(" or ")} may set ${to}.`);
  if (by === "human" && (!reason || reason.trim().length < 3))
    throw new StatusError("A reason is required.");
}
export const isActive = (status: string) =>
  status === "declared-underground" ||
  status === "return-overdue" ||
  status === "confirmed-missing";

// ---- configuration --------------------------------------------------------
export const shaftSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    number: z.number().int().min(1).max(99),
    name: z.string().trim().min(2).max(60),
    zoneIds: z.array(zoneId).max(20),
  })
  .strict();
export const messagingConfigSchema = z
  .object({
    timezone: z.string().default("Africa/Harare"),
    shafts: z.array(shaftSchema).min(1).max(30),
    gracePeriodMinutes: z.number().int().min(5).max(240),
    secondIntervalMinutes: z.number().int().min(5).max(480),
    maxShiftHours: z.number().min(1).max(24),
    unconfirmedAfterMinutes: z.number().int().min(1).max(240),
    language: z.enum(["en"]).default("en"),
    /** Mine location and rain thresholds; null = no forecast polling. */
    weather: weatherConfigSchema.nullable().default(null),
    preEntry: preEntryConfigSchema.default(defaultPreEntry),
    liveEnabled: z
      .object({ by: z.string(), at: instant })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type MessagingConfig = z.infer<typeof messagingConfigSchema>;
export const trainingConfig: MessagingConfig = {
  timezone: "Africa/Harare",
  shafts: [
    { id: "main-shaft", number: 1, name: "Main shaft", zoneIds: ["zone-a", "zone-c"] },
    { id: "east-incline", number: 2, name: "East incline", zoneIds: ["zone-b"] },
    { id: "north-adit", number: 3, name: "North adit", zoneIds: ["zone-a"] },
  ],
  gracePeriodMinutes: 30,
  secondIntervalMinutes: 30,
  maxShiftHours: 14,
  unconfirmedAfterMinutes: 15,
  language: "en",
  weather: null,
  preEntry: defaultPreEntry,
  liveEnabled: null,
};

// ---- people ---------------------------------------------------------------
export const e164 = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s()-]/g, ""))
  .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, "Use international format, e.g. +263…"));
export const personSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    phone: e164.nullable().default(null),
    channels: z
      .object({ whatsapp: z.boolean(), sms: z.boolean() })
      .strict()
      .default({ whatsapp: false, sms: true }),
    role: z.enum(["miner", "shift-boss", "supervisor", "administrator", "buddy-contact"]),
    zoneId: zoneId.nullable().default(null),
    defaultBuddyId: z.string().max(80).nullable().default(null),
    nextOfKin: z
      .array(z.object({ name: z.string().trim().min(2).max(100), phone: e164 }).strict())
      .max(3)
      .default([]),
    languages: z.array(z.enum(["en", "sn", "nd"])).min(1).default(["en"]),
  })
  .strict();
export type PersonInput = z.infer<typeof personSchema>;

export const manualCheckInSchema = z
  .object({
    personId: z.string().min(1).max(80),
    shaftId: z.string().min(1).max(64),
    zoneId: zoneId.nullable().default(null),
    expectedReturn: instant,
    buddyPersonId: z.string().max(80).nullable().default(null),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export const checkInStatusSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    status: z.enum(["accounted-for", "confirmed-missing"]),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

// ---- time (mine time zone) --------------------------------------------------
function zoneParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), s: get("second") };
}
/** UTC instant for a wall-clock time on a given local date in `timeZone`. */
export function zonedInstant(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  timeZone: string,
) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const p = zoneParts(new Date(guess), timeZone);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - guess;
  return new Date(guess - offset);
}
export function formatClock(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}
export type ReturnParse =
  | { ok: true; at: string }
  | { ok: false; reason: "format" | "past" | "too-far" };
/**
 * Parse "14:30", "1430" or "9:05" as the next occurrence in the mine's time
 * zone. A time already passed today is read as tomorrow only when that is
 * within the maximum shift length (overnight shifts); otherwise it is in the
 * past and the miner is asked again.
 */
export function parseReturnTime(
  text: string,
  now: Date,
  cfg: Pick<MessagingConfig, "timezone" | "maxShiftHours">,
): ReturnParse {
  const m = text.trim().match(/^([01]?\d|2[0-3]):?([0-5]\d)$/);
  if (!m) return { ok: false, reason: "format" };
  const local = zoneParts(now, cfg.timezone);
  let at = zonedInstant(local.y, local.m, local.d, Number(m[1]), Number(m[2]), cfg.timezone);
  const max = cfg.maxShiftHours * 3600e3;
  if (at.getTime() <= now.getTime()) {
    const tomorrow = new Date(at.getTime() + 24 * 3600e3);
    if (tomorrow.getTime() - now.getTime() > max) return { ok: false, reason: "past" };
    at = tomorrow;
  }
  if (at.getTime() - now.getTime() > max) return { ok: false, reason: "too-far" };
  return { ok: true, at: at.toISOString() };
}

// ---- escalation ladder (spec §6.3) ------------------------------------------
export type StepName = "reminder" | "overdue" | "supervisor";
export function escalationPlan(
  expectedReturn: string,
  cfg: Pick<MessagingConfig, "gracePeriodMinutes" | "secondIntervalMinutes">,
): { step: StepName; dueAt: string }[] {
  const t = Date.parse(expectedReturn);
  return [
    { step: "reminder", dueAt: new Date(t).toISOString() },
    { step: "overdue", dueAt: new Date(t + cfg.gracePeriodMinutes * 60e3).toISOString() },
    {
      step: "supervisor",
      dueAt: new Date(
        t + (cfg.gracePeriodMinutes + cfg.secondIntervalMinutes) * 60e3,
      ).toISOString(),
    },
  ];
}

// ---- inbound keyword parsing -------------------------------------------------
export type Command =
  | { kind: "in"; shaft?: number; time?: string; buddy?: string }
  | { kind: "out" }
  | { kind: "help" }
  | { kind: "team"; shaft: number; time: string; names: string[] }
  | { kind: "check"; shaft: number }
  | { kind: "consent-yes" }
  | { kind: "stop" }
  | { kind: "answer"; text: string };
/**
 * SMS one-line `IN 1 1430 TENDAI`, bare `IN` (starts the WhatsApp dialogue),
 * `OUT`, `HELP`, `TEAM 1 1430` + names on following lines or after commas,
 * `CHECK 1`, `YES` (consent), `STOP`. Anything else is an answer to the current
 * conversation question.
 */
export function parseCommand(raw: string): Command {
  const text = raw.trim().replace(/\s+/g, " ");
  const upper = text.toUpperCase();
  if (/^(OUT|CHECKOUT|CHECK OUT)$/.test(upper)) return { kind: "out" };
  if (/^(HELP|\?)$/.test(upper)) return { kind: "help" };
  if (/^(YES|Y|AGREE)$/.test(upper)) return { kind: "consent-yes" };
  if (/^(STOP|REMOVE|UNSUBSCRIBE)$/.test(upper)) return { kind: "stop" };
  const check = upper.match(/^CHECK (\d{1,2})$/);
  if (check) return { kind: "check", shaft: Number(check[1]) };
  const team = raw.trim().match(/^team\s+(\d{1,2})\s+(\S+)\s*[\n,]?\s*([\s\S]*)$/i);
  if (team)
    return {
      kind: "team",
      shaft: Number(team[1]),
      time: team[2],
      names: team[3]
        .split(/[\n,]/)
        .map((n) => n.trim())
        .filter(Boolean),
    };
  const inn = text.match(/^in(?:\s+(\d{1,2}))?(?:\s+(\S+))?(?:\s+(.+))?$/i);
  if (inn)
    return {
      kind: "in",
      shaft: inn[1] ? Number(inn[1]) : undefined,
      time: inn[2],
      buddy: inn[3]?.trim(),
    };
  return { kind: "answer", text };
}

/** Short human reference such as K42, unique among the given active refs. */
export function makeReference(taken: Set<string>, random: () => number = Math.random) {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (let i = 0; i < 1000; i++) {
    const ref =
      letters[Math.floor(random() * letters.length)] +
      String(10 + Math.floor(random() * (i < 500 ? 90 : 990)));
    if (!taken.has(ref)) return ref;
  }
  throw new Error("No free reference");
}
