import { z } from "zod";

export const zoneId = z.enum(["zone-a", "zone-b", "zone-c"]);
export const instant = z.string().datetime({ offset: true });
export const roleSchema = z.enum([
  "viewer",
  "reporter",
  "supervisor",
  "administrator",
]);
export type Role = z.infer<typeof roleSchema>;
export const spanSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: z.string().min(1).max(4000),
  })
  .strict();
export const factSchema = z
  .object({
    category: z.enum([
      "water",
      "drainage",
      "inspection",
      "ppe",
      "restricted-entry",
      "injury",
      "other",
    ]),
    zoneId: zoneId.nullable(),
    assetId: z.string().max(60).nullable(),
    condition: z.string().min(1).max(500),
    polarity: z.enum(["affirmed", "negated", "uncertain"]),
    action: z.enum(["observed", "proposed", "completed"]),
    quantity: z.number().finite().nonnegative().max(1e7).nullable(),
    unit: z.enum(["m", "m3", "m3/h", "m3/s"]).nullable(),
    observedAt: instant.nullable(),
    timeExpression: z.string().max(100).nullable(),
    spans: z.array(spanSchema).min(1).max(20),
    interpretation: z.enum(["explicit", "inferred"]),
    serious: z.boolean(),
  })
  .strict();
export type Fact = z.infer<typeof factSchema>;
export const extractionSchema = z
  .object({
    facts: z.array(factSchema).max(30),
    unknowns: z.array(z.string().max(300)).max(20),
  })
  .strict();
export const reportSchema = z
  .object({
    text: z
      .string()
      .min(5)
      .max(12000)
      .refine(
        (text) => text.trim().length >= 5,
        "Enter at least five non-whitespace characters",
      ),
    zoneId,
    observedAt: instant.nullable().default(null),
  })
  .strict();
export const reviewSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    facts: z.array(factSchema).min(1).max(30),
    supersedesObservationIds: z.array(z.string().uuid()).max(20).default([]),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();
export const inspectionSchema = z
  .object({
    zoneId,
    title: z.string().trim().min(3).max(140),
    dueAt: instant,
    observedAt: instant.nullable(),
    outcome: z.enum(["verified", "reported-failed", "unverified", "deferred"]),
    finding: z.string().trim().min(3).max(4000),
  })
  .strict();
export const workerSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    zoneId,
    role: z.string().max(100),
    startsAt: instant,
    endsAt: instant,
    status: z.enum(["assigned", "checked-in", "checked-out"]),
  })
  .strict()
  .refine(
    (x) => Date.parse(x.endsAt) > Date.parse(x.startsAt),
    "Assignment end must follow start",
  );
export const caseSchema = z
  .object({
    concernId: z.string().min(1),
    assessmentId: z.string().min(1),
    zoneId,
    title: z.string().min(3).max(140),
    owner: z.string().min(2).max(100),
    dueAt: instant,
  })
  .strict();
export const transitionSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    status: z.enum([
      "open",
      "acknowledged",
      "action-in-progress",
      "awaiting-verification",
      "closed",
    ]),
    reason: z.string().min(3).max(1000),
    verificationIds: z.array(z.string()).max(20).default([]),
  })
  .strict();
export const actionSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    title: z.string().min(3).max(200),
    dueAt: instant,
    completed: z.boolean(),
    evidenceIds: z.array(z.string()).max(20),
  })
  .strict();
export const musterSchema = z
  .object({ zoneId, caseId: z.string().nullable() })
  .strict();
export const confirmSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    workerId: z.string().min(1),
    confirmed: z.boolean(),
    reason: z.string().min(3).max(500),
  })
  .strict();
export const visionEventSchema = z
  .object({
    eventId: z.string().uuid(),
    schemaVersion: z.literal("1.0"),
    workspaceId: z.string(),
    cameraId: z.string().min(1).max(60),
    sessionId: z.string().min(1).max(100),
    trackId: z.string().max(60),
    zoneId,
    type: z.enum(["helmet", "vest", "restricted-entry", "feed-loss"]),
    startsAt: instant,
    endsAt: instant,
    visibility: z.enum(["assessable", "cannot-assess"]),
    state: z.enum(["candidate", "confirmed-for-review"]),
    frameIds: z.array(z.string().max(100)).max(30),
    signals: z
      .object({
        equipmentScore: z.number().min(0).max(1).nullable(),
        personScore: z.number().min(0).max(1).nullable(),
        visibilityNote: z.string().max(300),
      })
      .strict()
      .optional(),
    provenance: z
      .object({
        modelId: z.string(),
        weightsSha256: z.string().regex(/^[a-f0-9]{64}$/),
        runtime: z.string(),
        policyVersion: z.string(),
      })
      .strict(),
  })
  .strict();
export type Entity<T = Record<string, unknown>> = {
  id: string;
  workspaceId: string;
  kind: string;
  zoneId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  data: T;
};
export type Concern = {
  id: string;
  zoneId: string;
  title: string;
  reason: string;
  observationIds: string[];
  controlState: string;
  priority: "review" | "urgent-review";
};
export type Assessment = {
  cutoffAt: string;
  policyVersion: string;
  observationIds: string[];
  concerns: Concern[];
  unknowns: string[];
  supersedes: string | null;
};
export function validateSpans(text: string, facts: Fact[]) {
  for (const fact of facts) {
    if ((fact.quantity === null) !== (fact.unit === null))
      throw new Error("Quantity and unit must both be stated or both unknown.");
    for (const span of fact.spans)
      if (
        span.end <= span.start ||
        span.end > text.length ||
        text.slice(span.start, span.end) !== span.quote
      )
        throw new Error("A source span does not match the original report.");
  }
}
export const site = {
  id: "fictional-mine-001",
  name: "Mavambo training mine",
  timezone: "Africa/Harare",
  layoutVersion: "conceptual-1",
  datum: "Fictional local datum; metres; not surveyed",
  zones: [
    { id: "zone-a", name: "North working", x: 140, y: 95 },
    { id: "zone-b", name: "East development", x: 430, y: 190 },
    { id: "zone-c", name: "South working", x: 220, y: 295 },
  ],
};
