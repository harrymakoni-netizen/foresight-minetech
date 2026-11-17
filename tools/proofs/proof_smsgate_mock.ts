// Proof test 3 (spec §17 Phase 0) with the mock gateway, over real HTTP:
// mock SMSGate → /api/messaging/sms webhook → check-in stored → messaging
// service sends the confirmation through the gateway API (allow-list mode) →
// delivery receipt webhook → message marked delivered.
// Usage: node --experimental-strip-types tools/proofs/proof_smsgate_mock.ts
// Requires a production build (npm run build). Sends nothing to any phone.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

const port = 3077, mockPort = 8377, token = randomBytes(24).toString("hex");
const MINER = "+99900000001";
const env = {
  ...process.env,
  NODE_ENV: "production",
  FORESIGHT_DATABASE_PATH: path.join(mkdtempSync(path.join(tmpdir(), "proof3-")), "proof.sqlite"),
  FORESIGHT_PERSONAL_DATA_KEY: randomBytes(32).toString("base64"),
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  BETTER_AUTH_URL: `http://localhost:${port}`,
  SMSGATE_URL: `http://127.0.0.1:${mockPort}`,
  SMSGATE_USERNAME: "mock",
  SMSGATE_PASSWORD: "mock-password",
  SMSGATE_WEBHOOK_TOKEN: token,
  MESSAGING_MODE: "allow-list",
  MESSAGING_TEST_NUMBERS: MINER,
};
Object.assign(process.env, env);
const { startMockGateway } = await import("../../services/messaging/mock-gateway.ts");
const mock = await startMockGateway({ port: mockPort, webhookUrl: `http://localhost:${port}/api/messaging/sms?token=${token}` });
const web = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--port", String(port)], { env, stdio: "ignore" });
const base = `http://localhost:${port}`;
const result: Record<string, unknown> = { proof: "smsgate-mock-http", mode: env.MESSAGING_MODE };
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) break;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const signIn = await fetch(base + "/api/auth/sign-in/anonymous", { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: "{}" });
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const state = await (await fetch(base + "/api/workspace/state", { headers: { Cookie: cookie } })).json();
  const post = async (p: string, body: unknown) => {
    const r = await fetch(base + p, { method: "POST", headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json", "Idempotency-Key": "proof3-" + randomBytes(8).toString("hex"), "X-Workspace-Id": state.workspace.id }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(`${p}: ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  await post("/api/gateway", { provider: "smsgate", channelKey: "mock-device" });
  const tendai = state.entities.find((e: any) => e.kind === "person" && String(e.data.name).startsWith("Tendai"));
  const person = await post("/api/workspace/people", { name: "Proof Miner", phone: MINER, role: "miner", defaultBuddyId: tendai.id, channels: { whatsapp: false, sms: true } });
  await post(`/api/workspace/people/${person.id}/consent`, { given: true, note: "Proof test: consent recorded in person" });
  const back = new Date(Date.now() + 2 * 3600e3);
  const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Harare", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(back).replace(":", "");
  await fetch(`http://127.0.0.1:${mockPort}/__control/inbound`, { method: "POST", body: JSON.stringify({ phoneNumber: MINER, message: `IN 2 ${hhmm} TENDAI` }) });
  const checkIns = (await (await fetch(base + "/api/checkins", { headers: { Cookie: cookie } })).json()).checkIns;
  result.checkInStored = checkIns.length === 1 && checkIns[0].data.status === "declared-underground";
  result.reference = checkIns[0]?.data.reference;
  // One messaging-service tick against the same database.
  const { tick } = await import("../../services/messaging/service.ts");
  const t = await tick(new Date());
  result.dispatched = t.sent;
  result.gatewaySent = mock.sent.map((m) => ({ to: m.phoneNumbers, text: m.text }));
  const sent = mock.sent[0];
  await fetch(`http://127.0.0.1:${mockPort}/__control/deliver/${sent.id}`, { method: "POST", body: "{}" });
  const after = await (await fetch(base + "/api/workspace/state", { headers: { Cookie: cookie } })).json();
  const out = after.entities.find((e: any) => e.kind === "message" && e.data.direction === "outbound");
  result.statusHistory = out.data.statusHistory.map((h: any) => h.status);
  result.inboundRecorded = after.entities.some((e: any) => e.kind === "message" && e.data.direction === "inbound");
  // Allow-list: a different number is blocked, never sent.
  await fetch(`http://127.0.0.1:${mockPort}/__control/inbound`, { method: "POST", body: JSON.stringify({ phoneNumber: "+99900000055", message: "IN" }) });
  await tick(new Date());
  result.nonAllowListedReachedGateway = mock.sent.some((m) => m.phoneNumbers.includes("+99900000055"));
  result.passed = Boolean(result.checkInStored) && JSON.stringify(result.statusHistory) === JSON.stringify(["queued", "accepted", "delivered"]) && result.nonAllowListedReachedGateway === false;
} finally {
  web.kill();
  await mock.close();
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.passed ? 0 : 1);
