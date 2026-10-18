import { randomUUID } from "node:crypto";
import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assess, can, validTransition } from "../lib/domain/assessment.ts";
import { validateSpans, type Fact } from "../lib/domain/contracts.ts";
const directory = mkdtempSync(path.join(tmpdir(), "foresight-test-"));
process.env.FORESIGHT_DATABASE_PATH = path.join(directory, "test.sqlite");
const { query, closeDatabase } = await import("../lib/server/db.ts");
const {
  atomic,
  workspaceFor: findWorkspace,
  insert,
  list,
  get,
  idempotent,
  update,
  auditLog,
  useBudget,
} = await import("../lib/server/repository.ts");
const testRunId = randomUUID();
const workspaceFor = (id: string) => findWorkspace(`test-${testRunId}-${id}`);
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
test("serious individual observation reaches review; negation and proposed actions do not", async () => {
  const ctx = await workspaceFor("assessment-user");
  const one = await atomic(
    async () =>
      await insert(
        ctx,
        "observation",
        { ...fact(), quality: "accepted" },
        "zone-b",
      ),
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
test("workspace scope, idempotency and atomic audit rollback", async () => {
  const a = await workspaceFor("alice"),
    b = await workspaceFor("bob");
  const create = async () => await insert(a, "report", { text }, "zone-b");
  const first = await idempotent(a, "test-key-000001", { text }, create),
    again = await idempotent(a, "test-key-000001", { text }, create);
  assert.equal(first.id, again.id);
  await assert.rejects(
    async () =>
      await idempotent(a, "test-key-000001", { text: "different" }, create),
  );
  await assert.rejects(async () => await get(b, first.id));
  const before = (await list(a)).length,
    auditBefore = (await auditLog(a)).length;
  await assert.rejects(
    async () =>
      await atomic(async () => {
        await insert(a, "report", { text: "rolled back" });
        throw new Error("abort");
      }),
  );
  assert.equal((await list(a)).length, before);
  assert.equal((await auditLog(a)).length, auditBefore);
});
test("accepting new report creates immutable assessment versions", async () => {
  const ctx = await workspaceFor("review-user");
  const r = await atomic(
    async () =>
      (await mutate(ctx, ["reports"], { text, zoneId: "zone-b" })) as any,
  );
  await atomic(
    async () =>
      await mutate(ctx, ["reports", r.id, "review"], {
        expectedRevision: r.revision,
        facts: [fact()],
        reason: "Reviewed source.",
      }),
  );
  const first = (await list(ctx, "assessment"))[0],
    prior = JSON.stringify(first);
  const report2 = await atomic(
    async () =>
      (await mutate(ctx, ["reports"], {
        text: "No water rising reported.",
        zoneId: "zone-b",
      })) as any,
  );
  await atomic(
    async () =>
      await mutate(ctx, ["reports", report2.id, "review"], {
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
  assert.equal((await list(ctx, "assessment")).length, 2);
  assert.equal(JSON.stringify(await get(ctx, first.id)), prior);
  await assert.rejects(
    async () => await atomic(async () => await update(ctx, first, 1, {})),
  );
});
test("missing provider preserves report and returns unavailable state", async () => {
  const ctx = await workspaceFor("provider-user");
  const r = await atomic(
    async () =>
      (await mutate(ctx, ["reports"], { text, zoneId: "zone-b" })) as any,
  );
  await assert.rejects(() => extract(ctx, r.id), /Extraction unavailable/);
  assert.equal((await get(ctx, r.id)).data.text, text);
  assert.equal((await get(ctx, r.id)).data.extractionState, "unavailable");
});
test("roles and verification gates", async () => {
  assert.equal(can("viewer", "submit"), false);
  assert.equal(can("reporter", "review"), false);
  assert.equal(can("supervisor", "close"), true);
  assert.throws(() => validTransition("open", "closed", "shortcut", []));
  assert.throws(() =>
    validTransition("awaiting-verification", "closed", "checked", []),
  );
  validTransition("closed", "open", "New evidence requires review", []);
  const ctx = await workspaceFor("role-user");
  await assert.rejects(
    async () =>
      await atomic(
        async () =>
          await mutate({ ...ctx, role: "viewer" }, ["reports"], {
            text,
            zoneId: "zone-b",
          }),
      ),
  );
});
test("concurrency rejects stale revisions and preserves frozen roster", async () => {
  const ctx = await workspaceFor("muster-user");
  const muster = await atomic(
    async () =>
      (await mutate(ctx, ["muster"], {
        zoneId: "zone-b",
        caseId: null,
      })) as any,
  );
  assert.equal(muster.data.members.length, 1);
  const member = muster.data.members[0];
  await atomic(
    async () =>
      await mutate(ctx, ["muster", muster.id, "confirm"], {
        expectedRevision: 1,
        workerId: member.workerId,
        confirmed: true,
        reason: "Human drill confirmation",
      }),
  );
  await assert.rejects(
    async () =>
      await atomic(
        async () =>
          await mutate(ctx, ["muster", muster.id, "confirm"], {
            expectedRevision: 1,
            workerId: member.workerId,
            confirmed: false,
            reason: "Stale revision",
          }),
      ),
  );
  assert.equal((await get(ctx, muster.id)).data.status, "accounted-for");
});
test("legacy migration backs up and preserves payloads and references on copies", async () => {
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
  const result = await migrateLegacy(filename),
    again = await migrateLegacy(filename);
  assert.equal(result.workspaceId, again.workspaceId);
  assert.deepEqual(JSON.parse(readFileSync(result.backup, "utf8")), source);
  const { rows: entities } = await query(
    "SELECT payload FROM foresight.entities WHERE workspace_id=$1",
    [result.workspaceId],
  );
  assert.equal(entities.length, 2);
  assert.ok(
    entities.some(
      (e) => JSON.parse(e.payload).original.record_id === "worker-001",
    ),
  );
  const other = await workspaceFor("isolated-user");
  assert.equal((await list(other, "legacy-record")).length, 0);
  assert.deepEqual(JSON.parse(readFileSync(filename, "utf8")), source);
});
test("reviewed corrections supersede only future assessments while preserving originals", async () => {
  const ctx = await workspaceFor("correction-user");
  const first = await atomic(
    async () =>
      (await mutate(ctx, ["reports"], { text, zoneId: "zone-b" })) as any,
  );
  const accepted = await atomic(
    async () =>
      (await mutate(ctx, ["reports", first.id, "review"], {
        expectedRevision: 1,
        facts: [fact()],
        reason: "Original evidence reviewed.",
      })) as any,
  );
  const original = accepted.observations[0];
  const historical = accepted.assessment;
  const text2 = "Pump P2 did not stop; the earlier account was incorrect.";
  const correction = await atomic(
    async () =>
      (await mutate(ctx, ["reports"], {
        text: text2,
        zoneId: "zone-b",
      })) as any,
  );
  const result = await atomic(
    async () =>
      (await mutate(ctx, ["reports", correction.id, "review"], {
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
      })) as any,
  );
  assert.equal(result.assessment.data.concerns.length, 0);
  assert.equal(
    ((await get(ctx, historical.id)).data.concerns as unknown[]).length,
    1,
  );
  assert.equal((await get(ctx, original.id)).data.condition, "Pump P2 stopped");
});
test("worker event credential scope, camera references and duplicate ingestion", async () => {
  const { ingest } = await import("../lib/server/vision.ts");
  const { hash } = await import("../lib/server/repository.ts");
  const ctx = await workspaceFor("vision-user"),
    camera = (await list(ctx, "camera"))[0],
    credential = "job-specific-test-credential";
  const job = await atomic(
    async () =>
      await insert(
        ctx,
        "vision-job",
        {
          cameraId: camera.id,
          callbackHash: hash(credential),
          status: "queued",
        },
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
  await assert.rejects(
    async () => await ingest(job.id, event, "wrong-credential"),
  );
  await assert.rejects(
    async () =>
      await ingest(
        job.id,
        { ...event, workspaceId: "another-workspace" },
        credential,
      ),
  );
  const a = await ingest(job.id, event, credential),
    b = await ingest(job.id, event, credential);
  assert.equal(a.id, b.id);
  assert.equal((await list(ctx, "vision-event")).length, 1);
});
test("configured adapter executes SDK structured extraction and rejects malformed output, rate limits and timeout", async () => {
  const { MockLanguageModelV4 } = await import("ai/test");
  const { APICallError } = await import("ai");
  const { extractReport, explainAssessment } =
    await import("../lib/server/ai.ts");
  const ctx = await workspaceFor("mock-sdk-user");
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
test("reviewed PPE events create evidence/assessments and dismissal preserves the original", async () => {
  const ctx = await workspaceFor("vision-review-user");
  const event = await atomic(
    async () =>
      await insert(
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
  await atomic(
    async () =>
      await mutate(ctx, ["vision", event.id, "review"], {
        expectedRevision: 1,
        status: "acknowledged",
        reason: "Fictional fixture review only; not real PPE inference.",
      }),
  );
  const observation = (await list(ctx, "observation"))[0],
    assessment = (await list(ctx, "assessment"))[0];
  assert.equal(observation.data.category, "ppe");
  assert.equal(observation.data.quantity, null);
  assert.equal((assessment.data.concerns as unknown[]).length, 1);
  await atomic(
    async () =>
      await mutate(ctx, ["vision", event.id, "review"], {
        expectedRevision: 2,
        status: "dismissed",
        reason: "The original visual interpretation was incorrect.",
      }),
  );
  assert.equal(
    ((await list(ctx, "assessment"))[0].data.concerns as unknown[]).length,
    0,
  );
  assert.equal((await get(ctx, observation.id)).data.polarity, "affirmed");
  await assert.rejects(
    async () =>
      await atomic(
        async () =>
          await mutate(ctx, ["vision", event.id, "review"], {
            expectedRevision: 3,
            status: "acknowledged",
            reason:
              "Cannot reopen a final event without a new review contract.",
          }),
      ),
  );
});
test("model input masks registered names, contacts and emails without moving source offsets", async () => {
  const { permittedModelText } = await import("../lib/server/privacy.ts");
  const ctx = await workspaceFor("privacy-user"),
    original =
      "Training worker A reported Pump P2 stopped. Contact: +263 771 123 456. Email test@example.invalid.";
  const permitted = await permittedModelText(ctx, original);
  assert.equal(permitted.text.length, original.length);
  assert.ok(!permitted.text.includes("Training worker A"));
  assert.ok(!permitted.text.includes("771"));
  assert.ok(!permitted.text.includes("test@example"));
  assert.equal(permitted.text.indexOf("Pump P2"), original.indexOf("Pump P2"));
  assert.ok(permitted.redactions >= 3);
});

test("concurrent session startup creates one workspace and one training roster", async () => {
  const workspaces = await Promise.all(
    Array.from({ length: 8 }, () => workspaceFor("concurrent-start")),
  );
  assert.equal(new Set(workspaces.map((w) => w.workspaceId)).size, 1);
  assert.equal((await list(workspaces[0], "worker")).length, 3);
});
test("concurrent duplicate submissions commit once and stale revisions lose", async () => {
  const ctx = await workspaceFor("concurrent-submission");
  const submit = () =>
    idempotent(ctx, "concurrent-key-000001", { text }, () =>
      insert(ctx, "report", { text }, "zone-b"),
    );
  const records = await Promise.all(Array.from({ length: 8 }, submit));
  assert.equal(new Set(records.map((r) => r.id)).size, 1);
  assert.equal((await list(ctx, "report")).length, 1);
  const original = records[0];
  const outcomes = await Promise.allSettled([
    update(ctx, original, 1, { text: "revision A" }),
    update(ctx, original, 1, { text: "revision B" }),
  ]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  assert.equal((await get(ctx, original.id)).revision, 2);
});
test("concurrent budget checks cannot exceed the limit", async () => {
  const ctx = await workspaceFor("concurrent-budget");
  const outcomes = await Promise.allSettled(
    Array.from({ length: 8 }, () => useBudget(ctx, "limited", 3)),
  );
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 3);
});
test("failed cross-workspace links roll back the record and audit together", async () => {
  const a = await workspaceFor("foreign-link-a"),
    b = await workspaceFor("foreign-link-b");
  const foreign = (await list(b, "worker"))[0];
  const before = (await list(a)).length,
    audits = (await auditLog(a)).length;
  await assert.rejects(() =>
    insert(a, "report", { text }, "zone-b", [
      { id: foreign.id, relation: "invalid-scope" },
    ]),
  );
  assert.equal((await list(a)).length, before);
  assert.equal((await auditLog(a)).length, audits);
});

test("serverless dispatch leases prevent duplicate execution and save the result", async () => {
  const { dispatchRun } = await import("../lib/server/simulator.ts");
  const ctx = await workspaceFor("serverless-lease"),
    run = await insert(ctx, "run", {
      status: "queued",
      scenario: { workspaceId: ctx.workspaceId },
    });
  const previous = process.env.FORESIGHT_SIMULATOR_MODE,
    token = process.env.FORESIGHT_WORKER_TOKEN;
  process.env.FORESIGHT_SIMULATOR_MODE = "serverless";
  process.env.FORESIGHT_WORKER_TOKEN =
    "serverless-test-only-credential-at-least32";
  let release!: () => void;
  const waiting = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const starting = new Promise<void>((r) => (started = r));
  const fetcher = mock.method(globalThis, "fetch", async () => {
    started();
    await waiting;
    return Response.json({ status: "completed", orchestrationFixture: true });
  });
  try {
    const first = dispatchRun(ctx, run.id);
    await starting;
    const duplicate = await dispatchRun(ctx, run.id);
    assert.equal(duplicate.data.status, "running");
    release();
    const completed = await first;
    assert.equal(completed.data.status, "completed");
    assert.equal(fetcher.mock.callCount(), 1);
    assert.equal(
      (await get(ctx, run.id)).data.result &&
        (await get(ctx, run.id)).data.status,
      "completed",
    );
  } finally {
    release();
    fetcher.mock.restore();
    if (previous === undefined) delete process.env.FORESIGHT_SIMULATOR_MODE;
    else process.env.FORESIGHT_SIMULATOR_MODE = previous;
    if (token === undefined) delete process.env.FORESIGHT_WORKER_TOKEN;
    else process.env.FORESIGHT_WORKER_TOKEN = token;
  }
});
test("serverless cancellation cannot be overwritten by a late compute result", async () => {
  const { dispatchRun, cancelRun } = await import("../lib/server/simulator.ts");
  const ctx = await workspaceFor("serverless-cancel"),
    run = await insert(ctx, "run", {
      status: "queued",
      scenario: { workspaceId: ctx.workspaceId },
    });
  const previous = process.env.FORESIGHT_SIMULATOR_MODE,
    token = process.env.FORESIGHT_WORKER_TOKEN;
  process.env.FORESIGHT_SIMULATOR_MODE = "serverless";
  process.env.FORESIGHT_WORKER_TOKEN =
    "serverless-test-only-credential-at-least32";
  let release!: () => void;
  const waiting = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const starting = new Promise<void>((r) => (started = r));
  const fetcher = mock.method(globalThis, "fetch", async () => {
    started();
    await waiting;
    return Response.json({ status: "completed", orchestrationFixture: true });
  });
  try {
    const pending = dispatchRun(ctx, run.id);
    await starting;
    await cancelRun(ctx, run.id);
    release();
    await pending;
    const cancelled = await get(ctx, run.id);
    assert.equal(cancelled.data.status, "cancelled");
    assert.equal(cancelled.data.result, undefined);
  } finally {
    release();
    fetcher.mock.restore();
    if (previous === undefined) delete process.env.FORESIGHT_SIMULATOR_MODE;
    else process.env.FORESIGHT_SIMULATOR_MODE = previous;
    if (token === undefined) delete process.env.FORESIGHT_WORKER_TOKEN;
    else process.env.FORESIGHT_WORKER_TOKEN = token;
  }
});
test("interrupted serverless execution becomes recoverable after its lease expires", async () => {
  const { pollRun } = await import("../lib/server/simulator.ts");
  const ctx = await workspaceFor("serverless-expired");
  const run = await insert(ctx, "run", {
    status: "running",
    leaseUntil: "2000-01-01T00:00:00Z",
  });
  const previous = process.env.FORESIGHT_SIMULATOR_MODE;
  process.env.FORESIGHT_SIMULATOR_MODE = "serverless";
  try {
    const recovered = await pollRun(ctx, run.id);
    assert.equal(recovered.data.status, "dispatch-pending");
    assert.match(String(recovered.data.error), /interrupted/);
  } finally {
    if (previous === undefined) delete process.env.FORESIGHT_SIMULATOR_MODE;
    else process.env.FORESIGHT_SIMULATOR_MODE = previous;
  }
});

after(async () => {
  await closeDatabase();
});
