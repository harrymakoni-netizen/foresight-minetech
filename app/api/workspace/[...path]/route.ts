import { after } from "next/server";
import { ConfigurationError } from "@/lib/server/configuration";
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
  cancelRun,
  serverlessSimulator,
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
import { visionStatus } from "@/lib/server/vision";
import { aiStatus } from "@/lib/server/ai-config";
import { aiConfigured } from "@/lib/server/ai";
import { assetsGet, assetsPost } from "@/lib/server/assets";
import {
  createCheckIn,
  createPerson,
  openShaftMuster,
  recordConsent,
  saveMessagingConfig,
  setCheckInStatus,
  setLiveMessaging,
  steps as escalationSteps,
} from "@/lib/server/checkins";
import { bindChannel, messagingConfig, messagingMode } from "@/lib/server/messaging";
import { messagingHealth } from "@/lib/server/gateway";
import { canSeePersonal, personalKeySource } from "@/lib/server/personal";
import { manualCheckInSchema, checkInStatusSchema } from "@/lib/domain/checkin";
import type { Entity } from "@/lib/domain/contracts";

// Phone numbers and miners' message bodies are personal data (spec §15).
// Sealed values never leave the server; viewers and reporters also lose masks
// and inbound text.
function protect(entities: Entity[], role: string) {
  const personal = canSeePersonal(role);
  return entities.map((e) => {
    if (!["person", "message"].includes(e.kind)) return e;
    const {
      phoneSealed: _p,
      recipientSealed: _r,
      senderSealed: _s,
      ...data
    } = e.data as Record<string, unknown>;
    if (Array.isArray(data.nextOfKin))
      data.nextOfKin = (data.nextOfKin as Record<string, unknown>[]).map(
        ({ phoneSealed: _k, ...k }) => (personal ? k : { name: k.name }),
      );
    if (!personal) {
      delete data.phoneMasked;
      delete data.recipientMasked;
      delete data.senderMasked;
      if (data.direction === "inbound") data.text = "(hidden: personal data)";
    }
    return { ...e, data };
  });
}
async function manualCheckIn(ctx: Awaited<ReturnType<typeof context>>, body: unknown) {
  const b = manualCheckInSchema.parse(body);
  return await createCheckIn(ctx, {
    ...b,
    method: "manual",
    declaredBy: `${ctx.actor} (manual check-in)`,
  });
}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};
function failure(error: unknown, requestId: string) {
  if (error instanceof DomainError || error instanceof ConfigurationError)
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
    if (path[0] === "state") {
      const vision = await visionStatus();
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
          entities: protect(await list(ctx), ctx.role),
          messaging: {
            mode: messagingMode().mode,
            modeProblem: messagingMode().problem,
            testNumberCount: messagingMode().testNumberCount,
            liveEnabled: (await messagingConfig(ctx)).config.liveEnabled,
            config: (await messagingConfig(ctx)).config,
            personalDataKey: personalKeySource(),
            ...(await messagingHealth()),
            steps: await escalationSteps(ctx),
          },
          latestSyncedAt: new Date().toISOString(),
          services: {
            ai: aiConfigured(),
            aiStatus: aiStatus(),
            directUploads: Boolean(
              process.env.VERCEL && process.env.BLOB_READ_WRITE_TOKEN,
            ),
            vision: vision.ready,
            visionMessage: vision.message,
          },
          features: {
            vision: process.env.FORESIGHT_FEATURE_VISION === "1",
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
    }
    if (path[0] === "checkins") {
      const all = await list(ctx, "check-in");
      return Response.json(
        {
          checkIns: path[1] ? all.filter((c) => c.id === path[1]) : all,
          steps: await escalationSteps(ctx, path[1]),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (path[0] === "runs" && path[1])
      return Response.json(await pollRun(ctx, path[1]), {
        headers: { "Cache-Control": "no-store" },
      });
    if (path[0] === "assets" && path[1]) return await assetsGet(ctx, path[1]);
    if (path[0] === "export") {
      const format = new URL(request.url).searchParams.get("format"),
        bundle = {
          schemaVersion: "1.0",
          workspaceId: ctx.workspaceId,
          site,
          mode: ctx.mode,
          exportedAt: new Date().toISOString(),
          entities: await list(ctx),
          audit: await auditLog(ctx),
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
    if (path[0] === "audit") return Response.json(await auditLog(ctx));
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
        "incidents",
        "people",
        "checkins",
        "messaging",
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
    if (path[0] === "runs" && path[2] === "retry") {
      const saved = await get(ctx, path[1], "run");
      if (serverlessSimulator()) {
        after(async () => {
          await dispatchRun(ctx, saved.id);
        });
        return Response.json(saved, { status: 202 });
      }
      return Response.json(await dispatchRun(ctx, saved.id));
    }
    if (path[0] === "runs" && path[2] === "cancel")
      return Response.json(await cancelRun(ctx, path[1]));
    if (path[0] === "scenarios" && ["sensitivity", "runs"].includes(path[2])) {
      const key = request.headers.get("Idempotency-Key") || "";
      const run =
        path[2] === "sensitivity"
          ? await startSensitivity(ctx, path[1], body, key)
          : await startRun(ctx, path[1], key);
      if (serverlessSimulator())
        after(async () => {
          await dispatchRun(ctx, run.id);
        });
      return Response.json(run, { status: 202 });
    }
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
                  "checkins",
                ]),
                body: z.unknown(),
              }),
            )
            .max(20),
        })
        .strict()
        .parse(body);
      const outcomes = await Promise.all(
        batch.items.map(async (item) => {
          try {
            return {
              key: item.key,
              state: "synced",
              result: await idempotent(
                ctx,
                item.key,
                { operation: item.operation, body: item.body },
                async () => {
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
                    return await mutate(ctx, ["workers", id, "status"], body);
                  }
                  if (item.operation === "checkins")
                    return await manualCheckIn(ctx, item.body);
                  return await mutate(ctx, [item.operation], item.body);
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
        }),
      );
      return Response.json({ outcomes });
    }
    const result = await idempotent(ctx, key, { path, body }, async () => {
      if (path[0] === "snapshots") {
        const snapshot = await createSnapshot(ctx);
        return {
          snapshot,
          scenarioTemplate: fictionalScenario(
            ctx.workspaceId,
            snapshot.id,
            snapshot.createdAt,
          ),
        };
      }
      if (path[0] === "scenarios" && !path[1])
        return await createScenario(ctx, body);
      if (path[0] === "people" && !path[1]) return await createPerson(ctx, body);
      if (path[0] === "people" && path[2] === "consent") {
        const b = z
          .object({ given: z.boolean(), note: z.string().trim().min(3).max(500) })
          .strict()
          .parse(body);
        return await recordConsent(ctx, path[1], "in-person", b.given, b.note);
      }
      if (path[0] === "checkins" && !path[1]) return await manualCheckIn(ctx, body);
      if (path[0] === "checkins" && path[2] === "status") {
        const b = checkInStatusSchema.parse(body);
        return await setCheckInStatus(
          ctx,
          await get(ctx, path[1], "check-in"),
          b.status,
          "human",
          b.reason,
          b.expectedRevision,
        );
      }
      if (path[0] === "messaging" && path[1] === "config")
        return await saveMessagingConfig(ctx, body);
      if (path[0] === "messaging" && path[1] === "live") {
        const b = z
          .object({ enabled: z.boolean(), reason: z.string().min(3).max(500) })
          .strict()
          .parse(body);
        return await setLiveMessaging(ctx, b.enabled, b.reason);
      }
      if (path[0] === "messaging" && path[1] === "bind") {
        const b = z
          .object({
            provider: z.enum(["smsgate", "whatsapp"]),
            channelKey: z.string().min(1).max(120),
          })
          .strict()
          .parse(body);
        return await bindChannel(ctx, b.provider, b.channelKey);
      }
      if (path[0] === "muster" && path[1] === "shaft") {
        const b = z
          .object({ shaftId: z.string().min(1).max(64), reason: z.string().min(3).max(300) })
          .strict()
          .parse(body);
        return { outcome: await openShaftMuster(ctx, b.shaftId, b.reason, null) };
      }
      return await mutate(ctx, path, body);
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return failure(error, requestId);
  }
}
