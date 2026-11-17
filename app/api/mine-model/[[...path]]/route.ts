// /api/mine-model family (spec §14): revisions, validate, publish. Same
// session, role, idempotency and scope rules as /api/workspace/mine-model/*.
// DXF import and base-map upload arrive in phase 9.
import { POST as workspacePost } from "../../workspace/[...path]/route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ path?: string[] }> };
export const POST = (request: Request, ctx: Ctx) =>
  workspacePost(request, { params: ctx.params.then((p) => ({ path: ["mine-model", ...(p.path || [])] })) });
