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
  knownZones,
} from "@/lib/server/repository";
import { mutate, extract, explain, newAssessment } from "@/lib/server/workflows";
import { cagePreflight, startCageRun } from "@/lib/server/cage";
import { explainRuns, runAssistant } from "@/lib/server/ai-tools";
import { issueAdvisory, withdrawAdvisory, recordPreEntryCheck, preEntrySchema, pollWeatherFor, recordSensorReading } from "@/lib/server/concerns";
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
import {
  escalateRun,
  planningResponse,
  pollEscape,
  scenarioPreflight,
  startEscapeRun,
  startTimeToAct,
} from "@/lib/server/scenarios";
import { createDraft, publish as publishModel, resetTrainingMine, saveDraft } from "@/lib/server/mine-model";
import { preflight as modelPreflight, mineModelSchema } from "@/lib/domain/mine-model";
import {
  alertAndMuster,
  closeEmergency,
  declareEmergency,
  incidentReport,
  rescueRoll,
  updateRollEntry,
} from "@/lib/server/emergency";
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
          site: {
            ...site,
            // Zones follow the published mine model; old map positions are kept where ids match.
            zones: (await knownZones(ctx)).map((z) => {
              const old = site.zones.find((x) => x.id === z.id);
              return { id: z.id, name: z.name, x: old?.x ?? 0, y: old?.y ?? 0 };
            }),
          },
          // Trajectory source records are large; fetch them per run instead.
          entities: protect(
            (await list(ctx)).filter((e) => e.kind !== "run-trajectory"),
            ctx.role,
          ),
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
    if (path[0] === "escape" && path[1] === "runs" && path[2])
      return Response.json(await pollEscape(ctx, path[2], "escape-run"), { headers: { "Cache-Control": "no-store" } });
    if (path[0] === "cage" && path[1] === "runs" && path[2])
      return Response.json(await pollEscape(ctx, path[2], "cage-run"), { headers: { "Cache-Control": "no-store" } });
    if (path[0] === "escape" && path[1] === "time-to-act" && path[2])
      return Response.json(await pollEscape(ctx, path[2], "time-to-act-study"), { headers: { "Cache-Control": "no-store" } });
    if (path[0] === "escape" && path[1] === "trajectories" && path[2])
      return Response.json(await get(ctx, path[2], "run-trajectory"), { headers: { "Cache-Control": "no-store" } });
    if (path[0] === "emergencies" && path[1] && path[2] === "roll")
      return Response.json(await rescueRoll(ctx, path[1]), {
        headers: { "Cache-Control": "no-store" },
      });
    if (path[0] === "incidents" && path[1] && path[2] === "pdf") {
      const report = await incidentReport(ctx, path[1]);
      return new Response(new Uint8Array(report.pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="foresight-incident-${path[1].slice(0, 8)}.pdf"`,
          "Cache-Control": "no-store",
        },
      });
    }
    if (path[0] === "export" && new URL(request.url).searchParams.get("format") === "csv") {
      const kind = new URL(request.url).searchParams.get("kind") || "check-in";
      if (!["check-in", "case", "message", "person", "muster"].includes(kind))
        throw new DomainError(422, "KIND", "Unsupported CSV record kind.");
      const records = protect(await list(ctx, kind), ctx.role);
      const keys = [...new Set(records.flatMap((r) => Object.keys(r.data)))].filter(
        (k) => !["statusHistory", "history", "members", "actions", "timeline", "vars", "nextOfKin"].includes(k),
      );
      const cell = (v: unknown) => {
        const text = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
        // Neutralise spreadsheet formulas and quote every cell.
        return '"' + (/^[=+\-@]/.test(text) ? "'" + text : text).replace(/"/g, '""') + '"';
      };
      const csv = [["id", "createdAt", "updatedAt", "zoneId", ...keys].map(cell).join(","), ...records.map((r) => [r.id, r.createdAt, r.updatedAt, r.zoneId, ...keys.map((k) => r.data[k])].map(cell).join(","))].join("\r\n");
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="foresight-${kind}.csv"`,
          "Cache-Control": "no-store",
        },
      });
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
        "emergencies",
        "roll",
        "mine-model",
        "escape",
        "cage",
        "assessments",
        "scenarios",
        "snapshots",
        "runs",
        "assets",
        "vision",
        "concerns",
        "pre-entry",
        "forecast",
        "sensor-readings",
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
      if (path[0] === "cage" && path[1] === "preflight") return await cagePreflight(ctx, body);
      if (path[0] === "cage" && path[1] === "runs" && !path[2]) return await startCageRun(ctx, body);
      if (path[0] === "escape" && path[1] === "preflight") return await scenarioPreflight(ctx, body);
      if (path[0] === "escape" && path[1] === "runs" && !path[2]) return await startEscapeRun(ctx, body);
      if (path[0] === "escape" && path[1] === "runs" && path[3] === "escalate") return await escalateRun(ctx, path[2], body);
      if (path[0] === "escape" && path[1] === "runs" && path[3] === "response") return await planningResponse(ctx, path[2], body);
      if (path[0] === "escape" && path[1] === "time-to-act" && !path[2]) return await startTimeToAct(ctx, body);
      if (path[0] === "mine-model" && path[1] === "reset-training") return await resetTrainingMine(ctx);
      if (path[0] === "mine-model" && path[1] === "validate")
        return { issues: modelPreflight(mineModelSchema.parse((body as { model: unknown }).model)) };
      if (path[0] === "mine-model" && !path[1])
        return await createDraft(
          ctx,
          z.object({ from: z.string().min(1).max(80) }).strict().parse(body).from,
        );
      if (path[0] === "mine-model" && path[2] === "publish")
        return await publishModel(
          ctx,
          path[1],
          z.object({ expectedRevision: z.number().int().positive() }).strict().parse(body).expectedRevision,
        );
      if (path[0] === "mine-model" && path[1] && !path[2])
        return await saveDraft(ctx, path[1], body);
      if (path[0] === "emergencies" && !path[1]) return await declareEmergency(ctx, body);
      if (path[0] === "emergencies" && path[2] === "alert")
        return await alertAndMuster(ctx, path[1]);
      if (path[0] === "emergencies" && path[2] === "close")
        return await closeEmergency(
          ctx,
          path[1],
          z.object({ reason: z.string().min(3).max(500) }).strict().parse(body).reason,
        );
      if (path[0] === "roll" && path[1]) return await updateRollEntry(ctx, path[1], body);
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
      if (path[0] === "assistant" && path[1] === "chat") {
        const b = z.object({ message: z.string().trim().min(3).max(2000), allowRuns: z.boolean().default(false) }).strict().parse(body);
        return await runAssistant(ctx, b);
      }
      if (path[0] === "assistant" && path[1] === "explain") {
        const b = z.object({ runIds: z.array(z.string().min(1).max(80)).min(1).max(2), question: z.string().max(500).optional(), mode: z.enum(["deterministic", "ai"]) }).strict().parse(body);
        return await explainRuns(ctx, b);
      }
      if (path[0] === "concerns" && path[1] === "advisory" && !path[2]) return await issueAdvisory(ctx, body);
      if (path[0] === "concerns" && path[1] === "advisory" && path[3] === "withdraw")
        return await withdrawAdvisory(ctx, path[2], z.object({ reason: z.string().min(3).max(300) }).strict().parse(body).reason);
      if (path[0] === "concerns" && path[1] === "reassess") return await newAssessment(ctx);
      if (path[0] === "pre-entry" && !path[1]) {
        const b = preEntrySchema.parse(body);
        return await recordPreEntryCheck(ctx, { shaftId: b.shaftId, by: `${ctx.actor} (web)`, personId: null, answers: b.answers });
      }
      if (path[0] === "forecast" && path[1] === "refresh") {
        if (!["supervisor", "administrator"].includes(ctx.role)) throw new DomainError(403, "ROLE_REQUIRED", "A supervisor or administrator role is required.");
        return await pollWeatherFor(ctx, new Date(), undefined, true);
      }
      if (path[0] === "sensor-readings" && !path[1]) return await recordSensorReading(ctx, body);
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
