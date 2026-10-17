import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assess, can, validTransition } from "../lib/domain/assessment.ts";
import { validateSpans, type Fact } from "../lib/domain/contracts.ts";
const directory = mkdtempSync(path.join(tmpdir(), "foresight-test-"));
process.env.FORESIGHT_DATABASE_PATH = path.join(directory, "test.sqlite");
const { database } = await import("../lib/server/db.ts");
const {
  atomic,
  workspaceFor,
  insert,
  list,
  get,
  idempotent,
  update,
  auditLog,
} = await import("../lib/server/repository.ts");
const { mutate, extract } = await import("../lib/server/workflows.ts");
const { migrateLegacy } = await import("../lib/server/migrate.ts");
const text =
  "Pump P2 stopped at 10 am. Water was rising near the east sump. No injury reported.";
function fact(overrides: Partial<Fact> = {}): Fact {
  return {
    category: "drainage",
    zoneId: "zone-b",
    assetId: "P2",
    condition: "Pump P2 stopped",
    polarity: "affirmed",
    action: "observed",
    quantity: null,
    unit: null,
    observedAt: null,
    timeExpression: "10 am",
    spans: [{ start: 0, end: 24, quote: text.slice(0, 24) }],
    interpretation: "explicit",
    serious: true,
    ...overrides,
  };
}
test("source offsets, quantities and missing observation date are validated", () => {
  validateSpans(text, [fact()]);
  assert.throws(() =>
    validateSpans(text, [
      fact({ spans: [{ start: 2, end: 8, quote: "invented" }] }),
    ]),
  );
  assert.throws(() => validateSpans(text, [fact({ quantity: 12 })]));
  assert.equal(fact().observedAt, null);
});
test("serious individual observation reaches review; negation and proposed actions do not", () => {
  const ctx = workspaceFor("assessment-user");
  const one = atomic(() =>
    insert(ctx, "observation", { ...fact(), quality: "accepted" }, "zone-b"),
  );
  const result = assess([one], new Date().toISOString(), null);
  assert.equal(result.concerns.length, 1);
  assert.equal(result.concerns[0].priority, "urgent-review");
  for (const overrides of [
    { polarity: "negated" },
    { polarity: "uncertain" },
    { action: "proposed" },
  ])
    assert.equal(
      assess(
        [{ ...one, data: { ...one.data, ...overrides } }],
        new Date().toISOString(),
        null,
      ).concerns.length,
      0,
    );
});
test("workspace scope, idempotency and atomic audit rollback", () => {
  const a = workspaceFor("alice"),
    b = workspaceFor("bob");
  const create = () => insert(a, "report", { text }, "zone-b");
  const first = idempotent(a, "test-key-000001", { text }, create),
    again = idempotent(a, "test-key-000001", { text }, create);
  assert.equal(first.id, again.id);
  assert.throws(() =>
    idempotent(a, "test-key-000001", { text: "different" }, create),
  );
  assert.throws(() => get(b, first.id));
  const before = list(a).length,
    auditBefore = auditLog(a).length;
  assert.throws(() =>
    atomic(() => {
      insert(a, "report", { text: "rolled back" });
      throw new Error("abort");
    }),
  );
  assert.equal(list(a).length, before);
  assert.equal(auditLog(a).length, auditBefore);
});
test("accepting new report creates immutable assessment versions", () => {
  const ctx = workspaceFor("review-user");
  const r = atomic(
    () => mutate(ctx, ["reports"], { text, zoneId: "zone-b" }) as any,
  );
  atomic(() =>
    mutate(ctx, ["reports", r.id, "review"], {
      expectedRevision: r.revision,
      facts: [fact()],
      reason: "Reviewed source.",
    }),
  );
  const first = list(ctx, "assessment")[0],
    prior = JSON.stringify(first);
  const report2 = atomic(
    () =>
      mutate(ctx, ["reports"], {
        text: "No water rising reported.",
        zoneId: "zone-b",
      }) as any,
  );
  atomic(() =>
    mutate(ctx, ["reports", report2.id, "review"], {
      expectedRevision: report2.revision,
      facts: [
        fact({
          category: "water",
          condition: "No water rising reported.",
          polarity: "negated",
          spans: [
            {
              start: 0,
              end: "No water rising reported.".length,
              quote: "No water rising reported.",
            },
          ],
        }),
      ],
      reason: "Negation retained.",
    }),
  );
  assert.equal(list(ctx, "assessment").length, 2);
  assert.equal(JSON.stringify(get(ctx, first.id)), prior);
  assert.throws(() => atomic(() => update(ctx, first, 1, {})));
});
test("missing provider preserves report and returns unavailable state", async () => {
  const ctx = workspaceFor("provider-user");
  const r = atomic(
    () => mutate(ctx, ["reports"], { text, zoneId: "zone-b" }) as any,
  );
  await assert.rejects(() => extract(ctx, r.id), /Extraction unavailable/);
  assert.equal(get(ctx, r.id).data.text, text);
  assert.equal(get(ctx, r.id).data.extractionState, "unavailable");
});
test("roles and verification gates", () => {
  assert.equal(can("viewer", "submit"), false);
  assert.equal(can("reporter", "review"), false);
  assert.equal(can("supervisor", "close"), true);
  assert.throws(() => validTransition("open", "closed", "shortcut", []));
  assert.throws(() =>
    validTransition("awaiting-verification", "closed", "checked", []),
  );
  validTransition("closed", "open", "New evidence requires review", []);
  const ctx = workspaceFor("role-user");
  assert.throws(() =>
    atomic(() =>
      mutate({ ...ctx, role: "viewer" }, ["reports"], {
        text,
        zoneId: "zone-b",
      }),
    ),
  );
});
test("concurrency rejects stale revisions and preserves frozen roster", () => {
  const ctx = workspaceFor("muster-user");
  const muster = atomic(
    () => mutate(ctx, ["muster"], { zoneId: "zone-b", caseId: null }) as any,
  );
  assert.equal(muster.data.members.length, 1);
  const member = muster.data.members[0];
  atomic(() =>
    mutate(ctx, ["muster", muster.id, "confirm"], {
      expectedRevision: 1,
      workerId: member.workerId,
      confirmed: true,
      reason: "Human drill confirmation",
    }),
  );
  assert.throws(() =>
    atomic(() =>
      mutate(ctx, ["muster", muster.id, "confirm"], {
        expectedRevision: 1,
        workerId: member.workerId,
        confirmed: false,
        reason: "Stale revision",
      }),
    ),
  );
  assert.equal(get(ctx, muster.id).data.status, "accounted-for");
});
test("legacy migration backs up and preserves payloads and references on copies", () => {
  const filename = path.join(directory, "legacy.json"),
    source = {
      records: [
        {
          id: "worker-001",
          kind: "worker",
          zone: "zone-b",
          data: { name: "Historic fictional worker", version: 3 },
        },
      ],
      audit: [
        {
          id: "audit-001",
          record_id: "worker-001",
          actor: "Unverified visitor",
          detail: "original",
        },
      ],
    };
  writeFileSync(filename, JSON.stringify(source));
  const result = migrateLegacy(filename),
    again = migrateLegacy(filename);
  assert.equal(result.workspaceId, again.workspaceId);
  assert.deepEqual(JSON.parse(readFileSync(result.backup, "utf8")), source);
  const entities = database()
    .prepare("SELECT payload FROM entities WHERE workspace_id=?")
    .all(result.workspaceId) as any[];
  assert.equal(entities.length, 2);
  assert.ok(
    entities.some(
      (e) => JSON.parse(e.payload).original.record_id === "worker-001",
    ),
  );
  const other = workspaceFor("isolated-user");
  assert.equal(list(other, "legacy-record").length, 0);
  assert.deepEqual(JSON.parse(readFileSync(filename, "utf8")), source);
});
test("reviewed corrections supersede only future assessments while preserving originals", () => {
  const ctx = workspaceFor("correction-user");
  const first = atomic(
    () => mutate(ctx, ["reports"], { text, zoneId: "zone-b" }) as any,
  );
  const accepted = atomic(
    () =>
      mutate(ctx, ["reports", first.id, "review"], {
        expectedRevision: 1,
        facts: [fact()],
        reason: "Original evidence reviewed.",
      }) as any,
  );
  const original = accepted.observations[0];
  const historical = accepted.assessment;
  const text2 = "Pump P2 did not stop; the earlier account was incorrect.";
  const correction = atomic(
    () => mutate(ctx, ["reports"], { text: text2, zoneId: "zone-b" }) as any,
  );
  const result = atomic(
    () =>
      mutate(ctx, ["reports", correction.id, "review"], {
        expectedRevision: 1,
        facts: [
          fact({
            condition: "Pump P2 did not stop",
            polarity: "negated",
            spans: [{ start: 0, end: text2.length, quote: text2 }],
          }),
        ],
        supersedesObservationIds: [original.id],
        reason: "Corrected the earlier mistaken account.",
      }) as any,
  );
  assert.equal(result.assessment.data.concerns.length, 0);
  assert.equal((get(ctx, historical.id).data.concerns as unknown[]).length, 1);
  assert.equal(get(ctx, original.id).data.condition, "Pump P2 stopped");
});
test("worker event credential scope, camera references and duplicate ingestion", async () => {
  const { ingest } = await import("../lib/server/vision.ts");
  const { hash } = await import("../lib/server/repository.ts");
  const ctx = workspaceFor("vision-user"),
    camera = list(ctx, "camera")[0],
    credential = "job-specific-test-credential";
  const job = atomic(() =>
    insert(
      ctx,
      "vision-job",
      { cameraId: camera.id, callbackHash: hash(credential), status: "queued" },
      camera.zoneId,
    ),
  );
  const event = {
    schemaVersion: "1.0",
    eventId: "1265f185-1d7e-471a-a500-44851530b5fd",
    workspaceId: ctx.workspaceId,
    cameraId: camera.id,
    sessionId: "session-test",
    trackId: "1",
    zoneId: "zone-b",
    type: "helmet",
    startsAt: "2026-10-17T10:00:00Z",
    endsAt: "2026-10-17T10:00:02Z",
    visibility: "assessable",
    state: "confirmed-for-review",
    frameIds: ["frame-1"],
    provenance: {
      modelId: "fixture-only-not-inference",
      weightsSha256: "a".repeat(64),
      runtime: "test-fixture",
      policyVersion: "test-policy",
    },
  };
  assert.throws(() => ingest(job.id, event, "wrong-credential"));
  assert.throws(() =>
    ingest(job.id, { ...event, workspaceId: "another-workspace" }, credential),
  );
  const a = ingest(job.id, event, credential),
    b = ingest(job.id, event, credential);
  assert.equal(a.id, b.id);
  assert.equal(list(ctx, "vision-event").length, 1);
});
test("configured adapter executes SDK structured extraction and rejects malformed output, rate limits and timeout", async () => {
  const { MockLanguageModelV4 } = await import("ai/test");
  const { APICallError } = await import("ai");
  const { extractReport, explainAssessment } =
    await import("../lib/server/ai.ts");
  const ctx = workspaceFor("mock-sdk-user");
  const response = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: {
      inputTokens: {
        total: 10,
        noCache: 10,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 20, text: 20, reasoning: undefined },
    },
    warnings: [],
  });
  const model = new MockLanguageModelV4({
    doGenerate: async () =>
      response({ facts: [fact()], unknowns: ["Observation date is unknown"] }),
  });
  const valid = await extractReport(ctx, text, { model });
  assert.equal(valid.facts[0].polarity, "affirmed");
  assert.equal(model.doGenerateCalls.length, 1);
  assert.ok(
    JSON.stringify(model.doGenerateCalls[0].prompt).includes("knownZones"),
  );
  const malformed = new MockLanguageModelV4({
    doGenerate: async () => response({ invented: "not an extraction" }),
  });
  await assert.rejects(
    () => extractReport(ctx, text, { model: malformed }),
    /Extraction unavailable/,
  );
  const forged = new MockLanguageModelV4({
    doGenerate: async () =>
      response({
        facts: [
          fact({ spans: [{ start: 0, end: 3, quote: "not in source" }] }),
        ],
        unknowns: [],
      }),
  });
  await assert.rejects(
    () => extractReport(ctx, text, { model: forged }),
    /Extraction unavailable/,
  );
  const rate = new MockLanguageModelV4({
    doGenerate: async () => {
      throw new APICallError({
        message: "Rate limit test",
        url: "https://provider.invalid",
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { "retry-after": "0" },
        isRetryable: true,
      });
    },
  });
  await assert.rejects(
    () => extractReport(ctx, text, { model: rate }),
    /Extraction unavailable/,
  );
  assert.ok(rate.doGenerateCalls.length <= 2);
  const timeout = new MockLanguageModelV4({
    doGenerate: async (options) =>
      new Promise((_, reject) => {
        options.abortSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("Test timeout", "AbortError")),
          { once: true },
        );
      }),
  });
  await assert.rejects(
    () => extractReport(ctx, text, { model: timeout, timeoutMs: 15 }),
    /Extraction unavailable/,
  );
  const inventedCitation = new MockLanguageModelV4({
    doGenerate: async () =>
      response({
        paragraphs: [
          { text: "Unsupported explanation", evidenceIds: ["absent-source"] },
        ],
        unknowns: [],
      }),
  });
  await assert.rejects(
    () =>
      explainAssessment(
        ctx,
        {},
        [{ id: "actual-source", text: "Reported pump stopped" }],
        { model: inventedCitation },
      ),
    /Explanation unavailable/,
  );
});
test("reviewed PPE events create evidence/assessments and dismissal preserves the original", () => {
  const ctx = workspaceFor("vision-review-user");
  const event = atomic(() =>
    insert(
      ctx,
      "vision-event",
      {
        type: "helmet",
        state: "confirmed-for-review",
        visibility: "assessable",
        startsAt: new Date().toISOString(),
        frameIds: ["fixture-frame"],
        reviewHistory: [],
      },
      "zone-b",
    ),
  );
  atomic(() =>
    mutate(ctx, ["vision", event.id, "review"], {
      expectedRevision: 1,
      status: "acknowledged",
      reason: "Fictional fixture review only; not real PPE inference.",
    }),
  );
  const observation = list(ctx, "observation")[0],
    assessment = list(ctx, "assessment")[0];
  assert.equal(observation.data.category, "ppe");
  assert.equal(observation.data.quantity, null);
  assert.equal((assessment.data.concerns as unknown[]).length, 1);
  atomic(() =>
    mutate(ctx, ["vision", event.id, "review"], {
      expectedRevision: 2,
      status: "dismissed",
      reason: "The original visual interpretation was incorrect.",
    }),
  );
  assert.equal(
    (list(ctx, "assessment")[0].data.concerns as unknown[]).length,
    0,
  );
  assert.equal(get(ctx, observation.id).data.polarity, "affirmed");
  assert.throws(() =>
    atomic(() =>
      mutate(ctx, ["vision", event.id, "review"], {
        expectedRevision: 3,
        status: "acknowledged",
        reason: "Cannot reopen a final event without a new review contract.",
      }),
    ),
  );
});
test("model input masks registered names, contacts and emails without moving source offsets", async () => {
  const { permittedModelText } = await import("../lib/server/privacy.ts");
  const ctx = workspaceFor("privacy-user"),
    original =
      "Training worker A reported Pump P2 stopped. Contact: +263 771 123 456. Email test@example.invalid.";
  const permitted = permittedModelText(ctx, original);
  assert.equal(permitted.text.length, original.length);
  assert.ok(!permitted.text.includes("Training worker A"));
  assert.ok(!permitted.text.includes("771"));
  assert.ok(!permitted.text.includes("test@example"));
  assert.equal(permitted.text.indexOf("Pump P2"), original.indexOf("Pump P2"));
  assert.ok(permitted.redactions >= 3);
});
