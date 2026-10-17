import { jsonBody } from "@/lib/server/http";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { context } from "@/lib/server/auth";
import {
  list,
  get,
  auditLog,
  atomic,
  idempotent,
  insert,
  update,
  useBudget,
  DomainError,
} from "@/lib/server/repository";
import { mutate, extract, explain } from "@/lib/server/workflows";
import {
  createSnapshot,
  createScenario,
  startRun,
  pollRun,
  worker,
  startSensitivity,
  dispatchRun,
} from "@/lib/server/simulator";
import { fictionalScenario } from "@/lib/domain/scenario";
import { site, visionEventSchema } from "@/lib/domain/contracts";
import { aiConfigured } from "@/lib/server/ai";
import { assetsGet, assetsPost } from "@/lib/server/assets";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ path: string[] }> };
function failure(error: unknown, requestId: string) {
  if (error instanceof DomainError)
    return Response.json(
      { code: error.code, message: error.message, requestId },
      { status: error.status },
    );
  if (error instanceof z.ZodError)
    return Response.json(
      {
        code: "VALIDATION",
        message: "Check the submitted fields.",
        fieldErrors: error.flatten(),
        requestId,
      },
      { status: 422 },
    );
  return Response.json(
    {
      code: "REQUEST_FAILED",
      message:
        "The request could not be completed. Check the input and service configuration.",
      requestId,
    },
    { status: 500 },
  );
}
export async function GET(request: Request, route: RouteContext) {
  const requestId = randomUUID();
  try {
    const ctx = await context(request),
      { path } = await route.params;
    if (path[0] === "state")
      return Response.json(
        {
          workspace: {
            id: ctx.workspaceId,
            name: "Your isolated demonstration",
            mode: ctx.mode,
            actor: ctx.actor,
            role: ctx.role,
          },
          site,
          entities: list(ctx),
          latestSyncedAt: new Date().toISOString(),
          services: {
            ai: aiConfigured(),
            vision: !!process.env.FORESIGHT_VISION_URL,
          },
          legacy: {
            replayFiles: [
              "wet",
              "dry",
              "wet-control",
              "dry-control",
              "wet-retrospective",
            ],
            register: "/api/workspace/legacy-register",
          },
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    if (path[0] === "runs" && path[1])
      return Response.json(await pollRun(ctx, path[1]), {
        headers: { "Cache-Control": "no-store" },
      });
    if (path[0] === "assets" && path[1]) return assetsGet(ctx, path[1]);
    if (path[0] === "export") {
      const format = new URL(request.url).searchParams.get("format"),
        bundle = {
          schemaVersion: "1.0",
          workspaceId: ctx.workspaceId,
          site,
          mode: ctx.mode,
          exportedAt: new Date().toISOString(),
          entities: list(ctx),
          audit: auditLog(ctx),
          limitations: [
            "Fictional software development records. No operational clearance or external notification.",
          ],
        };
      if (format === "text") {
        const text =
          `FORESIGHT — FICTIONAL INCIDENT AND EVIDENCE TIMELINE\nWorkspace ${ctx.workspaceId}\nSite ${site.name}\nExported ${bundle.exportedAt}\n\n` +
          bundle.entities
            .filter((e) =>
              [
                "case",
                "muster",
                "observation",
                "assessment",
                "vision-event",
              ].includes(e.kind),
            )
            .map(
              (e) =>
                `${e.createdAt} | ${e.kind} | ${e.id} | ${e.zoneId || "site"}\n${JSON.stringify(e.data, null, 2)}\n`,
            )
            .join("\n");
        return new Response(text, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition":
              'attachment; filename="foresight-timeline.txt"',
          },
        });
      }
      return Response.json(bundle, {
        headers: {
          "Content-Disposition":
            'attachment; filename="foresight-evidence.json"',
          "Cache-Control": "no-store",
        },
      });
    }
    if (path[0] === "legacy-register") {
      const register = (await import("@/lib/register.json")).default;
      return Response.json({
        label:
          "Legacy unvalidated development artifact; not current assessment policy",
        register,
      });
    }
    if (path[0] === "evaluation") {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const numerical = JSON.parse(
        await readFile(
          join(process.cwd(), "docs/numerical-evaluation.json"),
          "utf8",
        ),
      );
      return Response.json({
        numerical,
        text: {
          candidates: 100,
          independentlyReviewed: 0,
          providerEvaluated: false,
        },
        vision: {
          sourceClips: 0,
          independentlyReviewed: 0,
          accuracyEvaluated: false,
        },
        limitations: [
          "Independent reviewers, capture/model assets and owner-approved accuracy thresholds remain required.",
        ],
      });
    }
    if (path[0] === "audit") return Response.json(auditLog(ctx));
    throw new DomainError(404, "NOT_FOUND", "Endpoint not found.");
  } catch (error) {
    return failure(error, requestId);
  }
}
export async function POST(request: Request, route: RouteContext) {
  const requestId = randomUUID();
  try {
    const { path } = await route.params;
    const review =
      [
        "cases",
        "assessments",
        "scenarios",
        "snapshots",
        "runs",
        "assets",
        "vision",
      ].includes(path[0]) || path[2] === "review";
    const ctx = await context(request, review ? "review" : "submit");
    if (path[0] === "assets") return await assetsPost(ctx, request);
    const body = await jsonBody(request);
    if (path[0] === "reports" && path[2] === "extract")
      return Response.json(await extract(ctx, path[1]));
    if (path[0] === "assessments" && path[2] === "explain")
      return Response.json(await explain(ctx, path[1]));
    if (path[0] === "runs" && path[2] === "retry")
      return Response.json(await dispatchRun(ctx, path[1]));
    if (path[0] === "runs" && path[2] === "cancel") {
      get(ctx, path[1], "run");
      return Response.json(
        await worker(ctx, "/jobs/" + path[1] + "/cancel", {}),
      );
    }
    if (path[0] === "scenarios" && path[2] === "sensitivity")
      return Response.json(
        await startSensitivity(
          ctx,
          path[1],
          body,
          request.headers.get("Idempotency-Key") || "",
        ),
        { status: 202 },
      );
    if (path[0] === "scenarios" && path[2] === "runs")
      return Response.json(
        await startRun(
          ctx,
          path[1],
          request.headers.get("Idempotency-Key") || "",
        ),
        { status: 202 },
      );
    const key = request.headers.get("Idempotency-Key") || "";
    if (path[0] === "sync") {
      const batch = z
        .object({
          items: z
            .array(
              z.object({
                key: z.string(),
                operation: z.enum([
                  "reports",
                  "inspections",
                  "workers",
                  "worker-status",
                ]),
                body: z.unknown(),
              }),
            )
            .max(20),
        })
        .strict()
        .parse(body);
      const outcomes = batch.items.map((item) => {
        try {
          return {
            key: item.key,
            state: "synced",
            result: idempotent(
              ctx,
              item.key,
              { operation: item.operation, body: item.body },
              () => {
                if (item.operation === "worker-status") {
                  const { id, ...body } = z
                    .object({
                      id: z.string().uuid(),
                      expectedRevision: z.number().int().positive(),
                      status: z.enum(["checked-in", "checked-out"]),
                      reason: z.string().min(3).max(500),
                    })
                    .strict()
                    .parse(item.body);
                  return mutate(ctx, ["workers", id, "status"], body);
                }
                return mutate(ctx, [item.operation], item.body);
              },
            ),
          };
        } catch (e) {
          return {
            key: item.key,
            state:
              e instanceof DomainError && e.status === 409
                ? "conflict"
                : "rejected",
            message: e instanceof Error ? e.message : "Submission failed",
          };
        }
      });
      return Response.json({ outcomes });
    }
    const result = idempotent(ctx, key, { path, body }, () => {
      if (path[0] === "snapshots") {
        const snapshot = createSnapshot(ctx);
        return {
          snapshot,
          scenarioTemplate: fictionalScenario(
            ctx.workspaceId,
            snapshot.id,
            snapshot.createdAt,
          ),
        };
      }
      if (path[0] === "scenarios" && !path[1]) return createScenario(ctx, body);
      return mutate(ctx, path, body);
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return failure(error, requestId);
  }
}
