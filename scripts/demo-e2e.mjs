// Demo acceptance (spec §16.2) in an isolated environment: fresh SQLite
// database, allow-list messaging to two unassigned +999 test numbers, the mock
// SMS gateway (sends nothing), a test WhatsApp app secret used only to sign
// test webhooks, and the simulation worker from .venv-sim. Requires
// `npm run build` and `npm run setup:sim` first.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
const dir = mkdtempSync(path.join(tmpdir(), "foresight-demo-"));
const web = 3090, mockPort = 8390, simPort = 8190, weatherPort = 8391;
const token = randomBytes(24).toString("hex");
const env = {
  ...process.env,
  NODE_ENV: "production",
  FORESIGHT_DATABASE_PATH: path.join(dir, "demo.sqlite"),
  FORESIGHT_PERSONAL_DATA_KEY: randomBytes(32).toString("base64"),
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  BETTER_AUTH_URL: `http://localhost:${web}`,
  FORESIGHT_SIMULATOR_URL: `http://127.0.0.1:${simPort}`,
  FORESIGHT_WORKER_TOKEN: "demo-worker-token-0123456789abcdef0123",
  SMSGATE_URL: `http://127.0.0.1:${mockPort}`,
  SMSGATE_USERNAME: "mock",
  SMSGATE_PASSWORD: "mock-password",
  SMSGATE_WEBHOOK_TOKEN: token,
  WHATSAPP_APP_SECRET: "demo-test-app-secret",
  WHATSAPP_VERIFY_TOKEN: "demo-verify-token",
  OPEN_METEO_BASE_URL: `http://127.0.0.1:${weatherPort}/v1/forecast`,
  MESSAGING_MODE: "allow-list",
  MESSAGING_TEST_NUMBERS: "+99900000001,+99900000002",
  DEMO_E2E: "1",
  PREVIEW_URL: `http://localhost:${web}`,
  MOCK_GATEWAY_URL: `http://127.0.0.1:${mockPort}`,
};
const procs = [];
const start = (cmd, args, extra = {}) => {
  const p = spawn(cmd, args, { env: { ...env, ...extra }, stdio: ["ignore", "inherit", "inherit"] });
  procs.push(p);
  return p;
};
start(process.execPath, ["--experimental-strip-types", "services/messaging/mock-gateway.ts"], { MOCK_GATEWAY_PORT: String(mockPort), MOCK_GATEWAY_WEBHOOK_URL: `http://localhost:${web}/api/messaging/sms?token=${token}` });
start(process.execPath, ["--experimental-strip-types", "services/messaging/mock-open-meteo.ts"], { MOCK_OPEN_METEO_PORT: String(weatherPort) });
start(".venv-sim/bin/python", ["-m", "services.simulator.server"], { FORESIGHT_SIMULATOR_PORT: String(simPort), FORESIGHT_JOB_DATABASE: path.join(dir, "jobs.sqlite") });
start(process.execPath, ["node_modules/next/dist/bin/next", "start", "--port", String(web)]);
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`http://localhost:${web}/api/health`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
const test = spawn("npx", ["playwright", "test", "tests/browser/demo.spec.ts", "tests/browser/rain.spec.ts", "tests/browser/cage.spec.ts", "--trace", "off", "--reporter=list"], { env, stdio: "inherit" });
const code = await new Promise((r) => test.on("exit", r));
for (const p of procs) p.kill();
process.exit(code ?? 1);
