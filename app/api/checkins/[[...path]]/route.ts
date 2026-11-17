// /api/checkins family (spec §14): same session, role, idempotency and
// workspace-scope handling as /api/workspace/checkins/*.
import { GET as workspaceGet, POST as workspacePost } from "../../workspace/[...path]/route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ path?: string[] }> };
const forward = (ctx: Ctx) => ({ params: ctx.params.then((p) => ({ path: ["checkins", ...(p.path || [])] })) });
export const GET = (request: Request, ctx: Ctx) => workspaceGet(request, forward(ctx));
export const POST = (request: Request, ctx: Ctx) => workspacePost(request, forward(ctx));
