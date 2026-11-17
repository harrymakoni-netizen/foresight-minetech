// Foresight Lite messaging tests (spec §16.1). Phone numbers use the
// unassigned +999 country code and only ever reach the local mock gateway.
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertTransition,
  escalationPlan,
  parseCommand,
  parseReturnTime,
  trainingConfig,
  MODELLED_STATUS,
} from "../lib/domain/checkin.ts";
import { verifyWhatsAppSignature, whatsAppChallenge, parseWhatsApp, parseSmsGate } from "../lib/messaging/webhooks.ts";
import { createHmac } from "node:crypto";
const directory = mkdtempSync(path.join(tmpdir(), "foresight-msg-"));
process.env.FORESIGHT_DATABASE_PATH = path.join(directory, "test.sqlite");
const { closeDatabase, query } = await import("../lib/server/db.ts");
const repo = await import("../lib/server/repository.ts");
const ci = await import("../lib/server/checkins.ts");
const msg = await import("../lib/server/messaging.ts");
const gw = await import("../lib/server/gateway.ts");
const { startMockGateway } = await import("../services/messaging/mock-gateway.ts");
const run = randomUUID();
const ws = (id: string) => repo.workspaceFor(`msg-${run}-${id}`);
let mock: Awaited<ReturnType<typeof startMockGateway>>;
before(async () => {
  mock = await startMockGateway({ username: "mock", password: "mock-password" });
  process.env.SMSGATE_URL = mock.url;
  process.env.SMSGATE_USERNAME = "mock";
  process.env.SMSGATE_PASSWORD = "mock-password";
});
after(async () => {
  await mock.close();
  await closeDatabase();
});
const MINER = "+99900000001",
  BUDDY = "+99900000002",
  SUP = "+99900000003",
  BOSS = "+99900000004",
  STRANGER = "+99900000099";
const NOON = new Date("2026-11-17T10:00:00Z"); // 12:00 in Harare (UTC+2)
const at = (minutes: number) => new Date(NOON.getTime() + minutes * 60e3);

async function setup(name: string, consent = true) {
  const ctx = await ws(name);
  const channelKey = `wa-${name}-${run}`;
  await msg.bindChannel(ctx, "whatsapp", channelKey);
  const buddy = await ci.createPerson(ctx, { name: "Tendai Buddy", phone: BUDDY, role: "miner", channels: { whatsapp: false, sms: true } });
  const miner = await ci.createPerson(ctx, { name: "Rudo Miner", phone: MINER, role: "miner", defaultBuddyId: buddy.id, channels: { whatsapp: true, sms: true }, zoneId: "zone-b" });
  const sup = await ci.createPerson(ctx, { name: "Shift Supervisor", phone: SUP, role: "supervisor", channels: { whatsapp: true, sms: true } });
  if (consent) {
    await ci.recordConsent(ctx, miner.id, "in-person", true, "test consent");
    await ci.recordConsent(ctx, buddy.id, "in-person", true, "test consent");
  }
  const say = (text: string, now = NOON, from = MINER, channel: "whatsapp" | "sms" = "whatsapp") =>
    ci.handleInbound({ provider: "whatsapp", channelKey, channel, from, text, providerMessageId: randomUUID(), receivedAt: now.toISOString() }, now);
  return { ctx, miner, buddy, sup, say, channelKey };
}
const outbound = async (ctx: any) =>
  (await repo.list(ctx, "message")).filter((m) => m.data.direction === "outbound").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
// The service loops; tests drain the outbox the same way.
async function drain(now = new Date()) {
  for (let i = 0; i < 50; i++) if (!(await msg.dispatchDue(now)).length) return;
}
const lastReply = async (ctx: any) => String((await outbound(ctx)).at(-1)?.data.text);

// ---- pure rules ------------------------------------------------------------------
test("return times parse in Africa/Harare; past and too-far times are rejected", () => {
  const cfg = { timezone: "Africa/Harare", maxShiftHours: 14 };
  assert.deepEqual(parseReturnTime("14:30", NOON, cfg), { ok: true, at: "2026-11-17T12:30:00.000Z" });
  assert.deepEqual(parseReturnTime("1430", NOON, cfg), { ok: true, at: "2026-11-17T12:30:00.000Z" });
  assert.deepEqual(parseReturnTime("02:00", NOON, cfg), { ok: true, at: "2026-11-18T00:00:00.000Z" }); // overnight, 14 h
  assert.deepEqual(parseReturnTime("11:00", NOON, cfg), { ok: false, reason: "past" });
  assert.deepEqual(parseReturnTime("25:00", NOON, cfg), { ok: false, reason: "format" });
  assert.deepEqual(parseReturnTime("half two", NOON, cfg), { ok: false, reason: "format" });
  assert.deepEqual(parseReturnTime("03:00", NOON, { ...cfg, maxShiftHours: 12 }), { ok: false, reason: "past" });
});
test("keyword parsing: SMS one-line, bare IN, OUT, TEAM, CHECK", () => {
  assert.deepEqual(parseCommand("IN 1 1430 TENDAI"), { kind: "in", shaft: 1, time: "1430", buddy: "TENDAI" });
  assert.deepEqual(parseCommand(" in "), { kind: "in", shaft: undefined, time: undefined, buddy: undefined });
  assert.equal(parseCommand("out").kind, "out");
  assert.deepEqual(parseCommand("TEAM 2 1600\nRudo\nTendai"), { kind: "team", shaft: 2, time: "1600", names: ["Rudo", "Tendai"] });
  assert.deepEqual(parseCommand("CHECK 1"), { kind: "check", shaft: 1 });
  assert.equal(parseCommand("1").kind, "answer");
});
test("status machine: allowed and forbidden transitions; modelled status never applies", () => {
  assertTransition("declared-underground", "return-overdue", "scheduler");
  assertTransition("return-overdue", "accounted-for", "check-out");
  assertTransition("return-overdue", "confirmed-missing", "human", "Not found at muster");
  assertTransition("confirmed-missing", "accounted-for", "human", "Found injured at level 2");
  assert.throws(() => assertTransition("declared-underground", "return-overdue", "human", "x y z"));
  assert.throws(() => assertTransition("declared-underground", "confirmed-missing", "scheduler"));
  assert.throws(() => assertTransition("accounted-for", "declared-underground", "human", "undo"));
  assert.throws(() => assertTransition("declared-underground", MODELLED_STATUS, "human", "scenario"));
  assert.throws(() => assertTransition("declared-underground", "confirmed-missing", "human", ""));
});
test("escalation plan follows grace and second interval", () => {
  assert.deepEqual(escalationPlan("2026-11-17T12:30:00.000Z", trainingConfig).map((s) => [s.step, s.dueAt]), [
    ["reminder", "2026-11-17T12:30:00.000Z"],
    ["overdue", "2026-11-17T13:00:00.000Z"],
    ["supervisor", "2026-11-17T13:30:00.000Z"],
  ]);
});
test("webhook authenticity: WhatsApp signature and challenge; SMSGate envelope parsing", () => {
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "123" }, messages: [{ from: "99900000001", id: "wamid.1", timestamp: "1763373600", type: "text", text: { body: "IN" } }], statuses: [{ id: "wamid.out", status: "delivered", timestamp: "1763373700" }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "app-secret").update(raw).digest("hex");
  assert.ok(verifyWhatsAppSignature(raw, sig, "app-secret"));
  assert.ok(!verifyWhatsAppSignature(raw, sig, "other-secret"));
  assert.ok(!verifyWhatsAppSignature(raw + " ", sig, "app-secret"));
  const parsed = parseWhatsApp(JSON.parse(raw));
  assert.deepEqual(parsed.messages[0].from, "+99900000001");
  assert.equal(parsed.statuses[0].status, "delivered");
  const url = new URL("https://x/api/messaging/whatsapp?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=42");
  assert.equal(whatsAppChallenge(url, "tok"), "42");
  assert.equal(whatsAppChallenge(url, "wrong"), null);
  assert.deepEqual(parseSmsGate({ event: "sms:received", deviceId: "d1", payload: { messageId: "m1", phoneNumber: MINER, sender: MINER, message: "OUT", receivedAt: NOON.toISOString() } }), { kind: "received", id: "m1", from: MINER, text: "OUT", receivedAt: NOON.toISOString(), deviceId: "d1" });
});

// ---- conversation flows -------------------------------------------------------------
test("WhatsApp conversation registers only after storage and includes the reference", async () => {
  const { ctx, say } = await setup("wa-flow");
  await say("IN");
  assert.match(await lastReply(ctx), /Which shaft\? 1 Main shaft {2}2 East incline {2}3 North adit/);
  assert.equal((await repo.list(ctx, "check-in")).length, 0);
  await say("2");
  assert.match(await lastReply(ctx), /When will you be back up\? Reply like 14:30/);
  await say("11:00"); // past
  assert.match(await lastReply(ctx), /That time has passed/);
  await say("14:30");
  assert.match(await lastReply(ctx), /1 Tendai Buddy \(saved\) {2}2 New number/);
  assert.equal((await repo.list(ctx, "check-in")).length, 0);
  await say("1");
  const [c] = await repo.list(ctx, "check-in");
  assert.equal(c.data.status, "declared-underground");
  assert.equal(c.data.shaftName, "East incline");
  assert.equal(c.data.buddyName, "Tendai Buddy");
  assert.equal(await lastReply(ctx), `Registered: East incline, back by 14:30, buddy Tendai Buddy. Ref ${c.data.reference}. Reply OUT when you are back up.`);
  await say("OUT", at(132));
  assert.equal(await lastReply(ctx), "Welcome back. Checked out 14:12.");
  const done = await repo.get(ctx, c.id, "check-in");
  assert.equal(done.data.status, "accounted-for");
  assert.deepEqual(done.data.stepsRun, []);
});
test("SMS one-line check-in, unknown numbers, consent required and duplicate provider ids", async () => {
  const { ctx, say, miner } = await setup("sms-flow", false);
  await say("IN 1 1430 TENDAI", NOON, MINER, "sms");
  assert.match(await lastReply(ctx), /Reply YES to agree/);
  assert.equal((await repo.list(ctx, "check-in")).length, 0, "no check-in without consent");
  await say("YES", NOON, MINER, "sms");
  assert.equal(((await repo.get(ctx, miner.id, "person")).data.consent as { status: string }).status, "given");
  await say("IN 1 1430 TENDAI", NOON, MINER, "sms");
  const [c] = await repo.list(ctx, "check-in");
  assert.equal(c.data.shaftName, "Main shaft");
  assert.match(await lastReply(ctx), /^Registered: Main shaft, back by 14:30, buddy Tendai Buddy\. Ref /);
  await say("hello", NOON, STRANGER, "sms");
  const stranger = (await outbound(ctx)).filter((m) => m.data.purpose === "reply").at(-1)!;
  assert.match(String(stranger.data.text), /not registered with Foresight/);
  assert.equal((await repo.list(ctx, "messaging-alert")).length, 1);
  const id = randomUUID();
  const r1 = await ci.handleInbound({ provider: "whatsapp", channelKey: `wa-sms-flow-${run}`, channel: "sms", from: MINER, text: "HELP", providerMessageId: id, receivedAt: NOON.toISOString() }, NOON);
  const r2 = await ci.handleInbound({ provider: "whatsapp", channelKey: `wa-sms-flow-${run}`, channel: "sms", from: MINER, text: "HELP", providerMessageId: id, receivedAt: NOON.toISOString() }, NOON);
  assert.equal(r1.handled, true);
  assert.equal(r2.handled, false, "replayed provider message id is ignored");
});
test("shift boss checks in a team; each person gets a linked record; non-consented are listed", async () => {
  const { ctx, say, buddy } = await setup("team");
  const boss = await ci.createPerson(ctx, { name: "Farai Boss", phone: BOSS, role: "shift-boss", channels: { whatsapp: false, sms: true } });
  await ci.recordConsent(ctx, boss.id, "in-person", true, "test");
  await ci.createPerson(ctx, { name: "Chipo Newstart", phone: "+99900000077", role: "miner" });
  await say("TEAM 3 1600\nRudo Miner\nTendai Buddy\nChipo Newstart", NOON, BOSS, "sms");
  const checkIns = await repo.list(ctx, "check-in");
  assert.equal(checkIns.length, 2);
  assert.ok(checkIns.every((c) => c.data.method === "team" && c.data.teamCheckInId && c.data.buddyPersonId === boss.id));
  assert.match(await lastReply(ctx), /2 people.*Not registered: Chipo Newstart \(no consent\)/);
  void buddy;
  await say("TEAM 3 1600\nRudo Miner", NOON, MINER, "sms");
  assert.match(await lastReply(ctx), /Only a registered shift boss/);
});

// ---- escalation ---------------------------------------------------------------------------
test("escalation ladder with a fake clock: reminder, overdue + buddy, supervisor + muster; no double send", async () => {
  process.env.MESSAGING_MODE = "dry-run";
  const { ctx, say, miner } = await setup("ladder");
  await say("IN 2 1430 TENDAI", NOON, MINER, "sms");
  const [c] = await repo.list(ctx, "check-in");
  const mine = async (p: Promise<{ checkInId: string; step: string }[]>) => (await p).filter((x) => x.checkInId === c.id);
  assert.deepEqual(await mine(ci.runDueSteps(at(149))), []);
  const r = await mine(ci.runDueSteps(at(150)));
  assert.deepEqual(r.map((x) => x.step), ["reminder"]);
  assert.equal((await repo.get(ctx, c.id, "check-in")).data.status, "declared-underground");
  const o = await mine(ci.runDueSteps(at(180)));
  assert.deepEqual(o.map((x) => x.step), ["overdue"]);
  assert.equal((await repo.get(ctx, c.id, "check-in")).data.status, "return-overdue");
  const buddyMsgs = (await outbound(ctx)).filter((m) => m.data.purpose === "buddy-alert");
  assert.equal(buddyMsgs.length, 1);
  assert.match(String(buddyMsgs[0].data.text), /Rudo Miner has not checked out from East incline/);
  // "restart": two schedulers racing over the same due rows still execute once
  const [a, b] = await Promise.all([mine(ci.runDueSteps(at(210))), mine(ci.runDueSteps(at(210)))]);
  assert.equal([...a, ...b].filter((x) => x.step === "supervisor").length, 1);
  assert.deepEqual(await mine(ci.runDueSteps(at(400))), []);
  const supMsgs = (await outbound(ctx)).filter((m) => m.data.purpose === "supervisor-alert");
  assert.equal(supMsgs.length, 1, "WhatsApp to supervisor once (SMS only on failover)");
  assert.equal(supMsgs[0].data.channel, "whatsapp");
  assert.equal(supMsgs[0].data.failoverChannel, "sms");
  const musters = await repo.list(ctx, "muster");
  assert.equal(musters.length, 1);
  assert.equal(musters[0].data.shaftId, "east-incline");
  assert.equal((musters[0].data.members as { checkInId: string }[])[0].checkInId, c.id);
  // human confirms missing → incident with check-in, messages and timeline
  const current = await repo.get(ctx, c.id, "check-in");
  await ci.setCheckInStatus(ctx, current, "confirmed-missing", "human", "Not found at shaft muster");
  const [incident] = await repo.list(ctx, "case");
  assert.equal(incident.data.category, "overdue-miner");
  assert.equal(incident.data.source, "overdue-escalation");
  assert.ok((incident.data.timeline as any).messageIds.length >= 3);
  void miner;
});
test("check-out stops the ladder and records which steps ran", async () => {
  const { ctx, say } = await setup("stop");
  await say("IN 1 1430 TENDAI", NOON, MINER, "sms");
  await ci.runDueSteps(at(151));
  await say("OUT", at(160), MINER, "sms");
  const [c] = await repo.list(ctx, "check-in");
  const mine = async (p: Promise<{ checkInId: string }[]>) => (await p).filter((x) => x.checkInId === c.id);
  assert.equal(c.data.status, "accounted-for");
  assert.deepEqual(c.data.stepsRun, ["reminder"]);
  assert.deepEqual(await mine(ci.runDueSteps(at(600))), []);
  const st = await ci.steps(ctx, c.id);
  assert.deepEqual(st.map((s) => [s.step, Boolean(s.executed_at), Boolean(s.cancelled_at)]), [["reminder", true, false], ["overdue", false, true], ["supervisor", false, true]]);
});
test("manual check-in is recorded as such and needs consent; scenario status cannot be applied", async () => {
  const { ctx, miner } = await setup("manual", false);
  const input = { personId: miner.id, shaftId: "main-shaft", zoneId: "zone-a", expectedReturn: new Date(Date.now() + 3600e3).toISOString(), buddyPersonId: null, method: "manual" as const, declaredBy: "Supervisor (manual)" };
  await assert.rejects(() => ci.createCheckIn(ctx, input), /consent/);
  await ci.recordConsent(ctx, miner.id, "in-person", true, "Signed paper form");
  const c = await ci.createCheckIn(ctx, input);
  assert.equal(c.data.method, "manual");
  await assert.rejects(() => ci.createCheckIn(ctx, input), /Already declared/);
  await assert.rejects(() => ci.setCheckInStatus(ctx, c, MODELLED_STATUS as any, "human", "from scenario"), /modelled status/);
});

// ---- delivery and modes --------------------------------------------------------------------
test("dry-run sends nothing; allow-list blocks other numbers; accepted ≠ delivered; unconfirmed; failover", async () => {
  const { ctx, say } = await setup("delivery");
  process.env.MESSAGING_MODE = "dry-run";
  await say("HELP", NOON, MINER, "sms");
  const before = mock.sent.length;
  await drain();
  assert.equal(mock.sent.length, before, "dry-run never reaches the gateway");
  assert.equal((await outbound(ctx)).at(-1)!.data.status, "dry-run");

  process.env.MESSAGING_MODE = "allow-list";
  process.env.MESSAGING_TEST_NUMBERS = MINER;
  const allowed = await msg.queueMessage(ctx, { channel: "sms", purpose: "reply", recipientPersonId: null, recipientPhone: MINER, templateKey: "help", vars: { shafts: "1 Main" }, idempotencyKey: "t-allowed-" + run });
  const blocked = await msg.queueMessage(ctx, { channel: "sms", purpose: "reply", recipientPersonId: null, recipientPhone: STRANGER, templateKey: "help", vars: { shafts: "1 Main" }, idempotencyKey: "t-blocked-" + run });
  const again = await msg.queueMessage(ctx, { channel: "sms", purpose: "reply", recipientPersonId: null, recipientPhone: MINER, templateKey: "help", vars: { shafts: "1 Main" }, idempotencyKey: "t-allowed-" + run });
  assert.equal(again.id, allowed.id, "idempotent queueing");
  const now = new Date();
  await drain(now);
  assert.equal((await repo.get(ctx, blocked.id, "message")).data.status, "blocked");
  const accepted = await repo.get(ctx, allowed.id, "message");
  assert.equal(accepted.data.status, "accepted");
  assert.ok(mock.sent.some((m) => m.id === allowed.id));
  assert.ok(!mock.sent.some((m) => m.phoneNumbers.includes(STRANGER)));
  assert.equal(await msg.sweepUnconfirmed(new Date(now.getTime() + 14 * 60e3)), 0);
  assert.equal(await msg.sweepUnconfirmed(new Date(now.getTime() + 16 * 60e3)), 1);
  assert.equal((await repo.get(ctx, allowed.id, "message")).data.status, "unconfirmed");
  await msg.applyReceipt("smsgate", allowed.id, "delivered", new Date().toISOString());
  const delivered = await repo.get(ctx, allowed.id, "message");
  assert.deepEqual((delivered.data.statusHistory as any[]).map((h) => h.status), ["queued", "accepted", "unconfirmed", "delivered"]);

  // WhatsApp is not configured here, so it fails honestly and an SMS copy follows.
  const wa = await msg.queueMessage(ctx, { channel: "whatsapp", purpose: "supervisor-alert", recipientPersonId: null, recipientPhone: MINER, templateKey: "help", vars: { shafts: "x" }, idempotencyKey: "t-wa-" + run, failoverChannel: "sms" });
  await drain();
  assert.equal((await repo.get(ctx, wa.id, "message")).data.status, "failed");
  const copy = (await outbound(ctx)).find((m) => m.data.failoverOf === wa.id)!;
  assert.equal(copy.data.channel, "sms");
  await drain();
  assert.equal((await repo.get(ctx, copy.id, "message")).data.status, "accepted");
  await msg.applyReceipt("smsgate", copy.id, "failed", new Date().toISOString(), "Mock carrier rejection");
  assert.equal((await repo.get(ctx, copy.id, "message")).data.status, "failed");

  process.env.MESSAGING_MODE = "live";
  const live = await msg.queueMessage(ctx, { channel: "sms", purpose: "reply", recipientPersonId: null, recipientPhone: MINER, templateKey: "help", vars: { shafts: "x" }, idempotencyKey: "t-live-" + run });
  await drain();
  assert.equal((await repo.get(ctx, live.id, "message")).data.status, "blocked", "live needs administrator enablement");
  await assert.rejects(() => ci.setLiveMessaging(ctx, true, "try"), /Only an administrator/);
  process.env.MESSAGING_MODE = "dry-run";
  delete process.env.MESSAGING_TEST_NUMBERS;
});
test("gateway heartbeat: low battery degrades, unreachable goes offline, outage alerts once", async () => {
  const { ctx } = await setup("gateway");
  await msg.bindChannel(ctx, "smsgate", "default");
  let [g] = await gw.pollGateways(new Date());
  assert.equal(g.status, "online");
  await fetch(mock.url + "/__control/health", { method: "POST", body: JSON.stringify({ battery: 12 }) });
  [g] = await gw.pollGateways(new Date());
  assert.equal(g.status, "degraded");
  assert.match(g.reason, /Low battery 12%/);
  const alerts = () => repo.list(ctx, "message").then((ms) => ms.filter((m) => m.data.templateKey === "gateway.offline"));
  const first = (await alerts()).length;
  assert.ok(first >= 1);
  await fetch(mock.url + "/__control/health", { method: "POST", body: JSON.stringify({ status: "offline", battery: 80 }) });
  [g] = await gw.pollGateways(new Date());
  assert.equal(g.status, "offline");
  assert.equal((await alerts()).length, first, "same outage alerts once");
  const health = await gw.messagingHealth();
  assert.equal(health.gateways.find((x) => x.gateway === "primary")!.status, "offline");
  await fetch(mock.url + "/__control/health", { method: "POST", body: JSON.stringify({ status: "pass", battery: 80 }) });
  [g] = await gw.pollGateways(new Date());
  assert.equal(g.status, "online");
  assert.equal(g.outageSince, null);
  // scheduler health
  await gw.heartbeat("messaging-service", { test: true }, new Date(Date.now() - 5 * 60e3));
  assert.equal((await gw.messagingHealth()).scheduler.running, false);
  await gw.heartbeat("messaging-service", { test: true }, new Date());
  assert.equal((await gw.messagingHealth()).scheduler.running, true);
  void query;
});
