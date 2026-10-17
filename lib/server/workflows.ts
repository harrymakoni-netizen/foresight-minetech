import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  factSchema,
  reviewSchema,
  reportSchema,
  validateSpans,
  inspectionSchema,
  workerSchema,
  caseSchema,
  transitionSchema,
  actionSchema,
  musterSchema,
  confirmSchema,
  visionEventSchema,
  type Entity,
  type Fact,
  type Assessment,
} from "../domain/contracts.ts";
import { assess, validTransition, can } from "../domain/assessment.ts";
import {
  atomic,
  idempotent,
  insert,
  update,
  get,
  list,
  DomainError,
  type Context,
} from "./repository.ts";
import { extractReport, explainAssessment } from "./ai.ts";
export function newAssessment(ctx: Context) {
  const prior = list(ctx, "assessment")[0];
  const cutoffAt = new Date().toISOString();
  const data = assess(list(ctx, "observation"), cutoffAt, prior?.id || null);
  return insert(
    ctx,
    "assessment",
    data,
    null,
    data.observationIds.map((id) => ({ id, relation: "input" })),
  );
}
export function reviewReport(ctx: Context, id: string, input: unknown) {
  const body = reviewSchema.parse(input),
    report = get(ctx, id, "report");
  if (report.data.reviewStatus === "accepted")
    throw new DomainError(
      409,
      "ALREADY_REVIEWED",
      "This report is already accepted; add a correction report to preserve history.",
    );
  try {
    validateSpans(String(report.data.text), body.facts);
  } catch (error) {
    throw new DomainError(
      422,
      "SOURCE_SPANS",
      error instanceof Error ? error.message : "Invalid source spans.",
    );
  }
  for (const observationId of body.supersedesObservationIds)
    get(ctx, observationId, "observation");
  const observations = body.facts.map((f) =>
    insert(
      ctx,
      "observation",
      {
        ...f,
        quality: "accepted",
        reportId: id,
        sourceType: "report",
        correctionOfObservationIds: body.supersedesObservationIds,
        submittedAt: report.createdAt,
        reviewedAt: new Date().toISOString(),
        reviewer: ctx.actor,
      },
      f.zoneId,
      [
        { id, relation: "source" },
        ...body.supersedesObservationIds.map((id) => ({
          id,
          relation: "corrects",
        })),
      ],
    ),
  );
  const reviewed = update(ctx, report, body.expectedRevision, {
    ...report.data,
    reviewStatus: "accepted",
    acceptedFacts: body.facts,
    supersedesObservationIds: body.supersedesObservationIds,
    reviewReason: body.reason,
    reviewer: ctx.actor,
    reviewedAt: new Date().toISOString(),
  });
  return { report: reviewed, observations, assessment: newAssessment(ctx) };
}
export function submit(ctx: Context, operation: string, input: unknown) {
  if (!can(ctx.role, "submit"))
    throw new DomainError(403, "ROLE_REQUIRED", "A reporter role is required.");
  if (operation === "reports") {
    const body = reportSchema.parse(input);
    return insert(
      ctx,
      "report",
      {
        ...body,
        reviewStatus: "pending",
        extractionState: "not-requested",
        submittedAt: new Date().toISOString(),
      },
      body.zoneId,
    );
  }
  if (operation === "inspections") {
    const body = inspectionSchema.parse(input),
      record = insert(ctx, "inspection", body, body.zoneId);
    if (can(ctx.role, "review")) {
      insert(
        ctx,
        "observation",
        {
          category: "inspection",
          zoneId: body.zoneId,
          assetId: null,
          condition:
            body.outcome === "verified"
              ? `Inspection verified: ${body.finding}`
              : `Unverified inspection (${body.outcome}): ${body.finding}`,
          polarity: "affirmed",
          action: "observed",
          quantity: null,
          unit: null,
          observedAt: body.observedAt,
          timeExpression: null,
          spans: [{ start: 0, end: body.finding.length, quote: body.finding }],
          interpretation: "explicit",
          serious: false,
          quality: "accepted",
          sourceType: "inspection",
          inspectionId: record.id,
          submittedAt: record.createdAt,
        },
        body.zoneId,
        [{ id: record.id, relation: "source" }],
      );
      return { inspection: record, assessment: newAssessment(ctx) };
    }
    return { inspection: record, reviewRequired: true };
  }
  if (operation === "workers") {
    const body = workerSchema.parse(input);
    return insert(ctx, "worker", body, body.zoneId);
  }
  if (operation === "muster") {
    const body = musterSchema.parse(input);
    if (body.caseId && get(ctx, body.caseId, "case").zoneId !== body.zoneId)
      throw new DomainError(
        422,
        "CASE_ZONE",
        "Muster and response case must refer to the same zone.",
      );
    const now = new Date().toISOString(),
      workers = list(ctx, "worker").filter(
        (w) =>
          w.zoneId === body.zoneId &&
          w.data.status !== "checked-out" &&
          Date.parse(String(w.data.startsAt)) <= Date.now() &&
          Date.parse(String(w.data.endsAt)) >= Date.now(),
      );
    return insert(
      ctx,
      "muster",
      {
        ...body,
        rosterAt: now,
        members: workers.map((w) => ({
          workerId: w.id,
          name: w.data.name,
          assignmentRevision: w.revision,
          status: w.data.status,
          confirmed: false,
          confirmedAt: null,
          actor: null,
        })),
        status: "awaiting-confirmation",
      },
      body.zoneId,
      body.caseId ? [{ id: body.caseId, relation: "case" }] : [],
    );
  }
  throw new DomainError(404, "OPERATION", "Unknown submission operation.");
}
export function mutate(ctx: Context, path: string[], input: unknown): unknown {
  const [operation, id, action] = path;
  if (
    ["reports", "inspections", "workers", "muster"].includes(operation) &&
    !id
  )
    return submit(ctx, operation, input);
  if (!can(ctx.role, "review"))
    throw new DomainError(
      403,
      "ROLE_REQUIRED",
      "Supervisor review is required.",
    );
  if (operation === "cameras" && action === "policy") {
    const body = z
      .object({
        expectedRevision: z.number().int().positive(),
        restrictedRegion: z
          .object({
            xMin: z.number().min(0).max(1),
            yMin: z.number().min(0).max(1),
            xMax: z.number().min(0).max(1),
            yMax: z.number().min(0).max(1),
          })
          .strict(),
        reason: z.string().min(3).max(1000),
      })
      .strict()
      .parse(input);
    if (
      body.restrictedRegion.xMax <= body.restrictedRegion.xMin ||
      body.restrictedRegion.yMax <= body.restrictedRegion.yMin
    )
      throw new DomainError(
        422,
        "REGION",
        "Region maximum coordinates must exceed minimum coordinates.",
      );
    const camera = get(ctx, id, "camera");
    return update(ctx, camera, body.expectedRevision, {
      ...camera.data,
      restrictedRegion: body.restrictedRegion,
      policyVersion: "ppe-development-" + (camera.revision + 1),
      policyReason: body.reason,
    });
  }
  if (operation === "reports" && action === "review")
    return reviewReport(ctx, id, input);
  if (operation === "assessments" && !id) return newAssessment(ctx);
  if (operation === "cases" && !id) {
    const body = caseSchema.parse(input),
      assessment = get(ctx, body.assessmentId, "assessment");
    const concern = (assessment.data as unknown as Assessment).concerns.find(
      (c) => c.id === body.concernId,
    );
    if (!concern || concern.zoneId !== body.zoneId)
      throw new DomainError(
        422,
        "CONCERN",
        "Choose a concern from this assessment and zone.",
      );
    return insert(
      ctx,
      "case",
      {
        ...body,
        status: "open",
        actions: [],
        history: [
          {
            at: new Date().toISOString(),
            actor: ctx.actor,
            status: "open",
            reason: "Case opened",
          },
        ],
      },
      body.zoneId,
      [
        { id: assessment.id, relation: "assessment" },
        ...concern.observationIds.map((id) => ({ id, relation: "evidence" })),
      ],
    );
  }
  if (operation === "cases" && action === "transition") {
    const body = transitionSchema.parse(input),
      record = get(ctx, id, "case");
    try {
      validTransition(
        String(record.data.status),
        body.status,
        body.reason,
        body.verificationIds,
      );
    } catch (error) {
      throw new DomainError(
        422,
        "CASE_TRANSITION",
        error instanceof Error ? error.message : "Invalid case transition.",
      );
    }
    for (const evidenceId of body.verificationIds) {
      const evidence = get(ctx, evidenceId);
      if (
        evidence.zoneId !== record.zoneId ||
        !["observation", "inspection", "vision-event"].includes(evidence.kind)
      )
        throw new DomainError(
          422,
          "VERIFICATION",
          "Verification must reference evidence in the affected zone.",
        );
    }
    if (
      body.status === "closed" &&
      !(record.data.actions as any[]).some((a) => a.completed)
    )
      throw new DomainError(
        422,
        "ACTION_REQUIRED",
        "Complete a corrective action before closure.",
      );
    return update(ctx, record, body.expectedRevision, {
      ...record.data,
      status: body.status,
      verificationIds: body.verificationIds,
      history: [
        ...(record.data.history as any[]),
        {
          at: new Date().toISOString(),
          actor: ctx.actor,
          status: body.status,
          reason: body.reason,
          verificationIds: body.verificationIds,
        },
      ],
    });
  }
  if (operation === "cases" && action === "actions") {
    const body = actionSchema.parse(input),
      record = get(ctx, id, "case");
    for (const evidenceId of body.evidenceIds) get(ctx, evidenceId);
    if (record.data.status === "closed")
      throw new DomainError(
        409,
        "CLOSED",
        "Reopen the case before adding an action.",
      );
    return update(ctx, record, body.expectedRevision, {
      ...record.data,
      actions: [
        ...(record.data.actions as any[]),
        {
          ...body,
          id: randomUUID(),
          actor: ctx.actor,
          at: new Date().toISOString(),
        },
      ],
    });
  }
  if (operation === "muster" && action === "confirm") {
    const body = confirmSchema.parse(input),
      record = get(ctx, id, "muster");
    let found = false;
    const members = (record.data.members as any[]).map((m) => {
      if (m.workerId !== body.workerId) return m;
      found = true;
      return {
        ...m,
        confirmed: body.confirmed,
        actor: ctx.actor,
        confirmedAt: new Date().toISOString(),
        reason: body.reason,
      };
    });
    if (!found)
      throw new DomainError(
        422,
        "ROSTER",
        "Worker is absent from this frozen roster.",
      );
    return update(ctx, record, body.expectedRevision, {
      ...record.data,
      members,
      status: members.every((m) => m.confirmed)
        ? "accounted-for"
        : "awaiting-confirmation",
    });
  }
  if (operation === "workers" && action === "status") {
    const body = z
        .object({
          expectedRevision: z.number().int().positive(),
          status: z.enum(["checked-in", "checked-out"]),
          reason: z.string().min(3).max(500),
        })
        .strict()
        .parse(input),
      record = get(ctx, id, "worker");
    return update(ctx, record, body.expectedRevision, {
      ...record.data,
      status: body.status,
      statusReason: body.reason,
    });
  }
  if (operation === "vision" && action === "review") {
    const body = z
        .object({
          expectedRevision: z.number().int().positive(),
          status: z.enum(["acknowledged", "dismissed", "resolved"]),
          reason: z.string().min(3).max(1000),
        })
        .strict()
        .parse(input),
      record = get(ctx, id, "vision-event");
    const allowed: Record<string, string[]> = {
      candidate: ["dismissed"],
      "confirmed-for-review": ["acknowledged", "dismissed"],
      acknowledged: ["dismissed", "resolved"],
    };
    if (!allowed[String(record.data.state)]?.includes(body.status))
      throw new DomainError(
        409,
        "VISION_TRANSITION",
        "This event is already final or does not permit that review transition.",
      );
    let observationId = record.data.acceptedObservationId;
    if (body.status === "acknowledged" && !observationId) {
      const condition =
        record.data.type === "restricted-entry"
          ? "Reported restricted entry from reviewed camera evidence"
          : `Potentially missing ${record.data.type}; visible equipment observation reviewed`;
      const observation = insert(
        ctx,
        "observation",
        {
          category:
            record.data.type === "restricted-entry"
              ? "restricted-entry"
              : "ppe",
          zoneId: record.zoneId,
          assetId: null,
          condition,
          polarity:
            record.data.visibility === "assessable" ? "affirmed" : "uncertain",
          action: "observed",
          quantity: null,
          unit: null,
          observedAt: record.data.startsAt,
          timeExpression: null,
          spans: [{ start: 0, end: body.reason.length, quote: body.reason }],
          interpretation: "explicit",
          serious: false,
          quality: "accepted",
          sourceType: "vision-review",
          eventId: id,
          frameIds: record.data.frameIds,
          reviewer: ctx.actor,
          reviewedAt: new Date().toISOString(),
        },
        record.zoneId,
        [{ id, relation: "reviewed-event" }],
      );
      observationId = observation.id;
    }
    if (body.status === "dismissed" && observationId) {
      insert(
        ctx,
        "observation",
        {
          ...get(ctx, String(observationId), "observation").data,
          polarity: "negated",
          condition:
            "Human reviewer dismissed the earlier camera interpretation: " +
            body.reason,
          observedAt: null,
          correctionOfObservationIds: [observationId],
          reviewer: ctx.actor,
          reviewedAt: new Date().toISOString(),
        },
        record.zoneId,
        [
          { id, relation: "reviewed-event" },
          { id: String(observationId), relation: "corrects" },
        ],
      );
    }
    const reviewed = update(ctx, record, body.expectedRevision, {
      ...record.data,
      state: body.status,
      acceptedObservationId: observationId || null,
      reviewHistory: [
        ...((record.data.reviewHistory as any[]) || []),
        { ...body, actor: ctx.actor, at: new Date().toISOString() },
      ],
    });
    if (
      body.status === "acknowledged" ||
      (body.status === "dismissed" && observationId)
    )
      newAssessment(ctx);
    return reviewed;
  }
  throw new DomainError(404, "OPERATION", "Unknown workflow operation.");
}
export async function extract(ctx: Context, id: string) {
  const report = get(ctx, id, "report");
  if (report.data.reviewStatus === "accepted")
    throw new DomainError(
      409,
      "ALREADY_REVIEWED",
      "Accepted reports are immutable.",
    );
  try {
    const extraction = await extractReport(ctx, String(report.data.text));
    return atomic(() =>
      update(ctx, report, report.revision, {
        ...report.data,
        extractionState: "succeeded",
        extraction,
      }),
    );
  } catch (error) {
    if (error instanceof DomainError && error.status === 503)
      atomic(() =>
        update(ctx, report, report.revision, {
          ...report.data,
          extractionState: "unavailable",
          extractionFailure: { at: new Date().toISOString(), code: error.code },
        }),
      );
    throw error;
  }
}
export async function explain(ctx: Context, id: string) {
  const assessment = get(ctx, id, "assessment"),
    data = assessment.data as unknown as Assessment;
  const sources = data.observationIds.map((id) => {
    const o = get(ctx, id, "observation");
    return {
      id,
      text: JSON.stringify({
        condition: o.data.condition,
        observedAt: o.data.observedAt,
        spans: o.data.spans,
        quality: o.data.quality,
      }),
    };
  });
  return explainAssessment(ctx, data, sources);
}
