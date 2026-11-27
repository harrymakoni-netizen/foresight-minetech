// /api/emergencies family (spec §14): declare, roll, roll updates, alerts, close.
// Same session, role (supervisor/administrator), idempotency and scope rules
// as /api/workspace/emergencies/*. Roll updates: POST /api/emergencies/roll/:entryId.
import { GET as workspaceGet, POST as workspacePost } from "../../workspace/[...path]/route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ path?: string[] }> };
const forward = (ctx: Ctx) =>
  ({
    params: ctx.params.then((p) => {
      const rest = p.path || [];
      return { path: rest[0] === "roll" ? rest : ["emergencies", ...rest] };
    }),
  });
export const GET = (request: Request, ctx: Ctx) => workspaceGet(request, forward(ctx));
export const POST = (request: Request, ctx: Ctx) => workspacePost(request, forward(ctx));
