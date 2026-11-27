// Foresight messaging service (spec §5.1): the always-on process that runs the
// escalation scheduler, sends the outbox, marks unconfirmed messages and
// polls gateway health. It shares lib/server modules and the database with the
// web app (chosen over internal HTTP calls; see docs/MESSAGING_SETUP.md).
// Run: npm run worker:messaging
import { dispatchDue, messagingMode, sweepUnconfirmed } from "../../lib/server/messaging.ts";
import { runDueSteps } from "../../lib/server/checkins.ts";
import { heartbeat, pollGateways } from "../../lib/server/gateway.ts";
import { maintainConcerns } from "../../lib/server/concerns.ts";

const tickMs = Number(process.env.MESSAGING_TICK_MS || 5000);
const gatewayMs = Number(process.env.SMSGATE_HEALTH_INTERVAL_MS || 60000);
const concernsMs = Number(process.env.CONCERNS_MAINTAIN_INTERVAL_MS || 300000);
let lastGatewayPoll = 0;
let lastConcerns = 0;
let stopping = false;

export async function tick(now = new Date()) {
  const steps = await runDueSteps(now);
  const sent = await dispatchDue(now);
  const unconfirmed = await sweepUnconfirmed(now);
  let gateways: unknown = null;
  if (now.getTime() - lastGatewayPoll >= gatewayMs) {
    lastGatewayPoll = now.getTime();
    gateways = await pollGateways(now);
  }
  let concerns: Awaited<ReturnType<typeof maintainConcerns>> | null = null;
  if (now.getTime() - lastConcerns >= concernsMs) {
    lastConcerns = now.getTime();
    concerns = await maintainConcerns(now);
  }
  await heartbeat("messaging-service", { mode: messagingMode().mode, steps: steps.length, sent: sent.length, unconfirmed, pid: process.pid }, now);
  return { steps, sent, unconfirmed, gateways, concerns };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = messagingMode();
  console.log(`Foresight messaging service: mode=${mode.mode}${mode.problem ? " (" + mode.problem + ")" : ""}, allow-listed numbers=${mode.testNumberCount}, tick=${tickMs}ms`);
  process.on("SIGTERM", () => (stopping = true));
  process.on("SIGINT", () => (stopping = true));
  while (!stopping) {
    const started = Date.now();
    try {
      const r = await tick();
      if (r.steps.length || r.sent.length || r.unconfirmed)
        console.log(new Date().toISOString(), `steps=${r.steps.length} sent=${r.sent.map((s) => s.status).join(",") || 0} unconfirmed=${r.unconfirmed}`);
    } catch (e) {
      console.error(new Date().toISOString(), "tick failed:", (e as Error).message);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(250, tickMs - (Date.now() - started))));
  }
  process.exit(0);
}
