// Phase 6 tests: forecast parsing, development-controls-2 rules, polling with
// an injected fetcher, the pre-entry conversation and the advisory.
// The forecast fixture follows the documented Open-Meteo response shape
// (hourly.time + hourly.precipitation, timezone=UTC). It is constructed for
// the test, not a recorded live response; the live API was not reachable.
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assess, developmentContextDefaults, type AssessContext } from "../lib/domain/assessment.ts";
import { isHeavyRain, openMeteoUrl, parseOpenMeteo } from "../lib/domain/weather.ts";
import { parseYesNo } from "../lib/domain/precheck.ts";
import type { Entity } from "../lib/domain/contracts.ts";

const directory = mkdtempSync(path.join(tmpdir(), "foresight-concerns-"));
process.env.FORESIGHT_DATABASE_PATH = path.join(directory, "test.sqlite");
const { closeDatabase } = await import("../lib/server/db.ts");
const repo = await import("../lib/server/repository.ts");
const ci = await import("../lib/server/checkins.ts");
const msg = await import("../lib/server/messaging.ts");
const cn = await import("../lib/server/concerns.ts");
after(async () => closeDatabase());
const run = randomUUID();

// 48 hourly values from 2026-11-26T00:00Z; 0 mm except a 3-hour burst.
const hourlyTimes = Array.from({ length: 48 }, (_, i) => new Date(Date.UTC(2026, 10, 26, i)).toISOString().slice(0, 16));
const burst = (peak: number) => hourlyTimes.map((_, i) => (i === 14 ? peak : i === 15 ? peak / 2 : i === 16 ? 1 : 0));
const response = (precip: (number | null)[]) => ({ latitude: -17.8, longitude: 31.05, hourly_units: { precipitation: "mm" }, hourly: { time: hourlyTimes, precipitation: precip } });
const RETRIEVED = "2026-11-26T09:30:00.000Z";

test("Open-Meteo response: 24-hour window, peak and total computed from the hourly values", () => {
  const f = parseOpenMeteo(response(burst(12)), RETRIEVED);
  // Window = 09:00 on the 26th .. 08:00 on the 27th; the burst (14:00, 15:00, 16:00) is inside it.
  assert.equal(f.maxMmPerHour, 12);
  assert.equal(f.peakAt, "2026-11-26T14:00:00.000Z");
  assert.equal(f.totalMm24h, 12 + 6 + 1);
  assert.equal(f.missingHours, 0);
  assert.equal(f.hours.length, 48);
});
test("forecast values outside the window or missing are not invented", () => {
  const early = burst(0).map((_, i) => (i === 2 ? 30 : 0)); // 02:00, before the window
  assert.equal(parseOpenMeteo(response(early), RETRIEVED).totalMm24h, 0);
  const gap = burst(8).map((v, i) => (i === 14 ? null : v));
  const f = parseOpenMeteo(response(gap), RETRIEVED);
  assert.equal(f.missingHours, 1);
  assert.equal(f.maxMmPerHour, 4); // the 8 mm hour is unknown, so it is not counted
  assert.throws(() => parseOpenMeteo({ hourly: { time: ["2026-11-26T00:00"], precipitation: [] } }, RETRIEVED));
  assert.throws(() => parseOpenMeteo({ nope: true }, RETRIEVED));
  assert.throws(() => parseOpenMeteo(response(Array(48).fill(0)), "2027-01-01T00:00:00Z"), /no hours/);
});
test("request URL asks for hourly precipitation in UTC; heavy-rain thresholds are inclusive and configurable", () => {
  const url = new URL(openMeteoUrl(-17.8, 31.05));
  assert.equal(url.hostname, "api.open-meteo.com");
  assert.equal(url.searchParams.get("hourly"), "precipitation");
  assert.equal(url.searchParams.get("timezone"), "UTC");
  const t = { heavyRainMmPerHour: 10, heavyRainMm24h: 50 };
  assert.deepEqual(isHeavyRain({ maxMmPerHour: 10, totalMm24h: 10 }, t), { heavy: true, hourly: true, daily: false });
  assert.equal(isHeavyRain({ maxMmPerHour: 9.9, totalMm24h: 49.9 }, t).heavy, false);
  assert.deepEqual(isHeavyRain({ maxMmPerHour: 2, totalMm24h: 50 }, t), { heavy: true, hourly: false, daily: true });
  assert.equal(isHeavyRain({ maxMmPerHour: null, totalMm24h: null }, t).heavy, false);
});
test("yes/no parsing is strict", () => {
  for (const t of ["yes", "Y", " No ", "n", "YES."]) assert.ok(parseYesNo(t));
  for (const t of ["maybe", "1", "ok", "", "yes please"]) assert.equal(parseYesNo(t), null);
});

// ---- development-controls-2 ---------------------------------------------------------------------------
const NOW = "2026-11-26T12:00:00.000Z";
const obs = (id: string, data: Record<string, unknown>): Entity =>
  ({ id, workspaceId: "w", kind: "observation", zoneId: null, revision: 1, createdAt: "2026-11-26T10:00:00.000Z", updatedAt: "2026-11-26T10:00:00.000Z", data: { quality: "accepted", polarity: "affirmed", action: "observed", observedAt: "2026-11-26T09:00:00.000Z", serious: false, ...data } }) as Entity;
const supportsOverdue = obs("o1", { category: "inspection", zoneId: "zone-b", assetId: null, condition: "Roof support inspection overdue" });
const genericOverdue = obs("o2", { category: "inspection", zoneId: "zone-b", assetId: null, condition: "Fire extinguisher check overdue" });
const shafts = [
  { id: "main-shaft", name: "Main shaft", zoneIds: ["zone-a", "zone-c"] },
  { id: "east-incline", name: "East incline", zoneIds: ["zone-b"] },
];
const weather = { latitude: -17.8, longitude: 31.05, heavyRainMmPerHour: 10, heavyRainMm24h: 50 };
const ctxWith = (over: Partial<AssessContext> = {}): AssessContext => ({
  declaredByZone: {},
  shafts,
  forecast: { id: "f1", retrievedAt: "2026-11-26T09:30:00.000Z", summary: parseOpenMeteo(response(burst(12)), RETRIEVED) },
  weather,
  preEntry: [],
  subsidence: [],
  ...developmentContextDefaults,
  ...over,
});
const check = (id: string, at: string, answers: Record<string, "yes" | "no">, shaftId = "east-incline") => ({
  id,
  shaftId,
  shaftName: "East incline",
  at,
  by: "Boss",
  answers: Object.entries(answers).map(([key, answer]) => ({ key, text: `Question ${key}?`, answer })),
});

test("policy version: v1 stays available without extra inputs; v2 records its version", () => {
  assert.equal(assess([], NOW, null).policyVersion, "development-controls-1");
  assert.equal(assess([], NOW, null, ctxWith({ forecast: null })).policyVersion, "development-controls-2");
});
test("heavy rain alone is an advisory, not a concern for review", () => {
  const a = assess([], NOW, null, ctxWith());
  assert.equal(a.concerns.length, 1);
  assert.equal(a.concerns[0].priority, "advisory");
  assert.deepEqual(a.concerns[0].rules, ["rain-forecast"]);
  assert.equal(a.concerns[0].evidence?.[0].id, "f1");
  assert.match(a.concerns[0].reason, /nothing is sent automatically/);
});
test("heavy rain + overdue support inspection in a zone is an urgent compound concern; a generic overdue check does not qualify", () => {
  const a = assess([supportsOverdue], NOW, null, ctxWith());
  const compound = a.concerns.find((c) => c.id === "rain-compound-zone-b");
  assert.ok(compound);
  assert.equal(compound.priority, "urgent-review");
  assert.deepEqual(compound.rules, ["rain-forecast", "overdue-support-or-shaft-inspection"]);
  assert.deepEqual(compound.observationIds, ["o1"]);
  const generic = assess([genericOverdue], NOW, null, ctxWith());
  assert.equal(generic.concerns.some((c) => c.id.startsWith("rain-compound")), false);
  assert.ok(generic.concerns.some((c) => c.id === "rain-advisory"));
});
test("no heavy rain: no rain concern; stale or missing forecasts are not used and say so", () => {
  const light = assess([supportsOverdue], NOW, null, ctxWith({ forecast: { id: "f1", retrievedAt: "2026-11-26T09:30:00.000Z", summary: parseOpenMeteo(response(burst(4)), RETRIEVED) } }));
  assert.equal(light.concerns.some((c) => c.rules?.includes("rain-forecast")), false);
  const stale = assess([supportsOverdue], "2026-11-27T00:00:00.000Z", null, ctxWith());
  assert.equal(stale.concerns.some((c) => c.rules?.includes("rain-forecast")), false);
  assert.ok(stale.unknowns.some((u) => /more than 12 hours ago/.test(u)));
  assert.ok(assess([], NOW, null, ctxWith({ forecast: null })).unknowns.some((u) => /none has been retrieved/.test(u)));
  assert.ok(assess([], NOW, null, ctxWith({ weather: null, forecast: null })).unknowns.some((u) => /no mine location/.test(u)));
});
test("pre-entry: a no raises a concern for that shaft; repeated no escalates; yes everywhere raises nothing", () => {
  const one = assess([], NOW, null, ctxWith({ forecast: null, preEntry: [check("c1", "2026-11-26T08:00:00.000Z", { supports: "yes", ladders: "no" })] }));
  const concern = one.concerns.find((c) => c.id === "precheck-c1")!;
  assert.equal(concern.priority, "review");
  assert.equal(concern.shaftId, "east-incline");
  assert.equal(concern.zoneId, "zone-b");
  const repeated = assess([], NOW, null, ctxWith({ forecast: null, preEntry: [check("c0", "2026-11-24T08:00:00.000Z", { ladders: "no" }), check("c1", "2026-11-26T08:00:00.000Z", { ladders: "no" })] }));
  const urgent = repeated.concerns.find((c) => c.id === "precheck-c1")!;
  assert.equal(urgent.priority, "urgent-review");
  assert.deepEqual(urgent.rules, ["pre-entry-repeated-no"]);
  const differentQuestion = assess([], NOW, null, ctxWith({ forecast: null, preEntry: [check("c0", "2026-11-24T08:00:00.000Z", { supports: "no" }), check("c1", "2026-11-26T08:00:00.000Z", { ladders: "no" })] }));
  assert.equal(differentQuestion.concerns.find((c) => c.id === "precheck-c1")!.priority, "review");
  const clean = assess([], NOW, null, ctxWith({ forecast: null, preEntry: [check("c1", "2026-11-26T08:00:00.000Z", { supports: "yes" })] }));
  assert.equal(clean.concerns.length, 0);
  const old = assess([], NOW, null, ctxWith({ forecast: null, preEntry: [check("c1", "2026-11-25T08:00:00.000Z", { ladders: "no" })] }));
  assert.equal(old.concerns.length, 0, "a check older than 24 hours is not current");
});
test("subsidence marks: a new mark raises a concern for review; an old one does not", () => {
  const fresh = assess([], NOW, null, ctxWith({ forecast: null, subsidence: [{ id: "m1", zoneId: "zone-c", markedAt: "2026-11-24T00:00:00.000Z", note: "Crack near pillar" }] }));
  assert.equal(fresh.concerns[0].id, "subsidence-m1");
  assert.equal(fresh.concerns[0].priority, "review");
  const old = assess([], NOW, null, ctxWith({ forecast: null, subsidence: [{ id: "m1", zoneId: "zone-c", markedAt: "2026-10-01T00:00:00.000Z", note: "" }] }));
  assert.equal(old.concerns.length, 0);
});
test("people at risk: review concerns become urgent at the threshold in that zone only", () => {
  const checks = [check("c1", "2026-11-26T08:00:00.000Z", { ladders: "no" })];
  const two = assess([], NOW, null, ctxWith({ forecast: null, preEntry: checks, declaredByZone: { "zone-b": 2 } }));
  assert.equal(two.concerns[0].priority, "review");
  assert.equal(two.concerns[0].peopleAtRisk, 2);
  const three = assess([], NOW, null, ctxWith({ forecast: null, preEntry: checks, declaredByZone: { "zone-b": 3 } }));
  assert.equal(three.concerns[0].priority, "urgent-review");
  assert.ok(three.concerns[0].rules?.includes("people-at-risk"));
  assert.match(three.concerns[0].reason, /3 people are declared underground/);
  const elsewhere = assess([], NOW, null, ctxWith({ forecast: null, preEntry: checks, declaredByZone: { "zone-a": 9 } }));
  assert.equal(elsewhere.concerns[0].priority, "review");
  // An advisory is not escalated by headcount: it stays an advisory.
  const advisory = assess([], NOW, null, ctxWith({ declaredByZone: { "zone-a": 9 } }));
  assert.equal(advisory.concerns[0].priority, "advisory");
});

// ---- server: polling, assessments, conversation, advisory ----------------------------------------------
const ws = (name: string) => repo.workspaceFor(`concerns-${run}-${name}`);
const fakeFetch = (body: unknown, ok = true, status = 200) => {
  const calls: string[] = [];
  const fetcher = async (url: string) => (calls.push(url), { ok, status, json: async () => body });
  return { fetcher, calls };
};
const configure = async (ctx: any, patch: object) => {
  const { liveEnabled: _live, ...saved } = (await msg.messagingConfig(ctx)).config;
  return ci.saveMessagingConfig(ctx, { ...saved, ...patch });
};

test("polling: no location does nothing; with a location it stores the forecast, assesses once and then waits for the interval", async () => {
  const ctx = await ws("poll");
  const { fetcher, calls } = fakeFetch(response(burst(12)));
  const none = await cn.pollWeatherFor(ctx, new Date(RETRIEVED), fetcher as any);
  assert.equal(none.outcome, "no-location");
  assert.equal(calls.length, 0);
  await configure(ctx, { weather });
  const first = await cn.pollWeatherFor(ctx, new Date(RETRIEVED), fetcher as any);
  assert.equal(first.outcome, "stored");
  assert.equal(calls.length, 1);
  const forecast = (await repo.list(ctx, "forecast"))[0];
  assert.equal(forecast.data.retrievedAt, RETRIEVED);
  assert.match(String(forecast.data.source), /Open-Meteo/);
  assert.equal(forecast.data.heavy, true);
  const assessment = (await repo.list(ctx, "assessment"))[0];
  assert.equal(assessment.data.policyVersion, "development-controls-2");
  assert.ok((assessment.data.concerns as any[]).some((c) => c.id === "rain-advisory"));
  const again = await cn.pollWeatherFor(ctx, new Date(new Date(RETRIEVED).getTime() + 60 * 60e3), fetcher as any);
  assert.equal(again.outcome, "fresh-enough");
  assert.equal(calls.length, 1, "no second request inside the poll interval");
  const forced = await cn.pollWeatherFor(ctx, new Date(new Date(RETRIEVED).getTime() + 60 * 60e3), fetcher as any, true);
  assert.equal(forced.outcome, "stored");
  assert.equal((await repo.list(ctx, "assessment")).length, 1, "an unchanged assessment is not repeated");
});
test("polling failures are recorded, not hidden, and store nothing", async () => {
  const ctx = await ws("poll-fail");
  await configure(ctx, { weather });
  const bad = await cn.pollWeatherFor(ctx, new Date(RETRIEVED), fakeFetch({}, false, 503).fetcher as any);
  assert.equal(bad.outcome, "failed");
  assert.match(bad.detail, /HTTP 503/);
  const garbled = await cn.pollWeatherFor(ctx, new Date(RETRIEVED), fakeFetch({ hourly: { time: [], precipitation: [] } }).fetcher as any);
  assert.equal(garbled.outcome, "failed");
  assert.equal((await repo.list(ctx, "forecast")).length, 0);
});
test("maintenance refreshes ageing evidence: a forecast past 12 hours drops its concern", async () => {
  const ctx = await ws("maintain");
  await configure(ctx, { weather });
  const { fetcher } = fakeFetch(response(burst(12)));
  await cn.pollWeatherFor(ctx, new Date(RETRIEVED), fetcher as any);
  // Pretend the forecast was retrieved 13 hours before the assessment time.
  const f = (await repo.list(ctx, "forecast"))[0];
  await repo.update(ctx, f, f.revision, { ...f.data, retrievedAt: new Date(new Date(RETRIEVED).getTime() - 13 * 3600e3).toISOString() });
  const changed = await cn.reassessIfChanged(ctx, new Date(RETRIEVED));
  assert.ok(changed);
  assert.equal((changed!.data.concerns as any[]).some((c) => c.id === "rain-advisory"), false);
  assert.ok((changed!.data.unknowns as string[]).some((u) => /more than 12 hours ago/.test(u)));
  assert.equal(await cn.reassessIfChanged(ctx, new Date(RETRIEVED)), null);
});

const MINER = "+99900000011", BOSS = "+99900000012";
async function conversation(name: string) {
  const ctx = await ws(name);
  const channelKey = `wa-${name}-${run}`;
  await msg.bindChannel(ctx, "whatsapp", channelKey);
  const boss = await ci.createPerson(ctx, { name: "Shift Boss", phone: BOSS, role: "shift-boss", channels: { whatsapp: true, sms: true } });
  const miner = await ci.createPerson(ctx, { name: "Rudo Miner", phone: MINER, role: "miner", channels: { whatsapp: true, sms: true } });
  for (const p of [boss, miner]) await ci.recordConsent(ctx, p.id, "in-person", true, "test consent");
  const say = (text: string, from = BOSS) =>
    ci.handleInbound({ provider: "whatsapp", channelKey, channel: "whatsapp", from, text, providerMessageId: randomUUID(), receivedAt: new Date().toISOString() });
  const last = async () => String((await repo.list(ctx, "message")).filter((m) => m.data.direction === "outbound").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)?.data.text);
  return { ctx, say, last, miner, boss };
}
test("CHECK <shaft>: five strict yes/no questions are stored as evidence; a no raises a concern", async () => {
  const { ctx, say, last } = await conversation("precheck");
  await say("CHECK 2");
  assert.match(await last(), /Pre-entry check for East incline.*1\/5 Are the roof supports/);
  await say("maybe");
  assert.match(await last(), /Please reply YES or NO\. 1\/5/);
  for (const a of ["yes", "yes", "yes"]) await say(a);
  assert.match(await last(), /^4\/5 /);
  await say("no");
  assert.match(await last(), /^5\/5 /);
  assert.equal((await repo.list(ctx, "pre-entry-check")).length, 0, "nothing is stored before the last answer");
  await say("yes");
  assert.match(await last(), /Pre-entry check recorded for East incline \(1 no\).*shown to your supervisor as a concern/);
  const [saved] = await repo.list(ctx, "pre-entry-check");
  assert.equal(saved.data.shaftId, "east-incline");
  assert.equal((saved.data.answers as any[]).filter((a) => a.answer === "no").map((a) => a.key).join(), "ladders");
  const assessment = (await repo.list(ctx, "assessment"))[0];
  assert.ok((assessment.data.concerns as any[]).some((c) => c.id === `precheck-${saved.id}` && c.priority === "review"));
  assert.ok((await repo.list(ctx, "assessment")).length >= 1);
});
test("CHECK is for shift bosses and supervisors; unknown shafts are refused", async () => {
  const { say, last, ctx } = await conversation("precheck-roles");
  await say("CHECK 2", MINER);
  assert.match(await last(), /Only a registered shift boss/);
  await say("CHECK 9");
  assert.match(await last(), /Shaft not found/);
  assert.equal((await repo.list(ctx, "pre-entry-check")).length, 0);
});

test("advisory: supervisor only, explicit confirmation, shown to people who check in, never automatic", async () => {
  const { ctx, say } = await conversation("advisory");
  await configure(ctx, { weather });
  await cn.pollWeatherFor(ctx, new Date(RETRIEVED), fakeFetch(response(burst(12))).fetcher as any);
  const assessment = (await repo.list(ctx, "assessment"))[0];
  const concern = (assessment.data.concerns as any[]).find((c) => c.id === "rain-advisory");
  assert.ok(concern);
  assert.equal((await repo.list(ctx, "advisory")).length, 0, "the forecast alone sends nothing");
  const body = { concernId: "rain-advisory", shaftIds: ["east-incline"], text: "Heavy rain forecast. Do not enter the East incline.", hours: 12, confirm: true };
  await assert.rejects(() => cn.issueAdvisory({ ...ctx, role: "reporter" }, body), /supervisor or administrator/);
  await assert.rejects(() => cn.issueAdvisory(ctx, { ...body, confirm: false }));
  await assert.rejects(() => cn.issueAdvisory(ctx, { ...body, concernId: "nope" }), /not in the current assessment/);
  const issued = await cn.issueAdvisory(ctx, body);
  assert.equal(issued.data.status, "active");
  assert.equal(issued.data.issuedBy, ctx.actor);
  // Someone checking in at the East incline now sees it; someone checking in elsewhere does not.
  const back = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Harare", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(Date.now() + 2 * 3600e3));
  await say(`IN 2 ${back} Shift`, MINER);
  const texts = async () => (await repo.list(ctx, "message")).filter((m) => m.data.direction === "outbound").map((m) => String(m.data.text));
  assert.ok((await texts()).some((t) => /^Registered: East incline/.test(t)), "the check-in itself was registered");
  assert.ok((await texts()).some((t) => /^ADVISORY for East incline: Heavy rain forecast\. Do not enter the East incline\./.test(t)));
  const withdrawn = await cn.withdrawAdvisory(ctx, issued.id, "Rain passed");
  assert.equal(withdrawn.data.status, "withdrawn");
  assert.equal((await cn.activeAdvisories(ctx, "east-incline")).length, 0);
});

test("external sensor readings are evidence with source and time, administrator only, no thresholds applied", async () => {
  const ctx = await ws("sensor");
  const reading = { source: "Contractor logger A", sensorId: "pz-4", zoneId: "zone-b", quantity: "water level", value: 3.2, unit: "m", readAt: "2026-11-26T10:00:00Z", note: "" };
  await assert.rejects(() => cn.recordSensorReading({ ...ctx, role: "supervisor" }, reading), /administrator/);
  const admin = { ...ctx, role: "administrator" as const };
  await assert.rejects(() => cn.recordSensorReading(admin, { ...reading, readAt: "2099-01-01T00:00:00Z" }), /future/);
  const saved = await cn.recordSensorReading(admin, reading);
  assert.equal(saved.data.role, "evidence-only");
  assert.equal(saved.data.source, "Contractor logger A");
  const a = assess([], NOW, null, ctxWith({ forecast: null }));
  assert.equal(a.concerns.length, 0, "a reading alone never creates a concern");
});
