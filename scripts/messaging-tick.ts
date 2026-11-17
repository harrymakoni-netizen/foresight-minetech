// Run one messaging-service tick, optionally at a given instant (for drills
// and the demo acceptance test). Usage:
//   node --experimental-strip-types scripts/messaging-tick.ts [--at ISO]
import { tick } from "../services/messaging/service.ts";
const i = process.argv.indexOf("--at");
const at = i > 0 ? new Date(process.argv[i + 1]) : new Date();
if (Number.isNaN(at.getTime())) throw new Error("--at must be an ISO timestamp");
const r = await tick(at);
console.log(JSON.stringify({ at: at.toISOString(), steps: r.steps, sent: r.sent, unconfirmed: r.unconfirmed }));
process.exit(0);
