// /api/scenarios family (spec §14): escape runs, Time to act studies,
// preflight, planning responses and explicit escalation. Same session, role,
// idempotency and scope rules as /api/workspace/escape/*. The water laboratory
// keeps its existing /api/workspace/scenarios routes.
import { GET as workspaceGet, POST as workspacePost } from "../../workspace/[...path]/route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ path?: string[] }> };
const forward = (ctx: Ctx) => ({ params: ctx.params.then((p) => ({ path: ["escape", ...(p.path || [])] })) });
export const GET = (request: Request, ctx: Ctx) => workspaceGet(request, forward(ctx));
export const POST = (request: Request, ctx: Ctx) => workspacePost(request, forward(ctx));
