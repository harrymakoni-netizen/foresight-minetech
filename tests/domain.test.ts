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
  await assert.rejects(() => extract(ctx, r.id), /not set up/);
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
    sessionId: job.id,
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
  const response = (await atomic(
    async () =>
      await mutate(ctx, ["cases", "from-source"], {
        sourceKind: "vision-event",
        sourceId: event.id,
        title: "Fictional PPE review response",
        owner: "Fixture supervisor",
        dueAt: "2026-10-19T08:00:00Z",
        reason:
          "Inspect the supporting equipment evidence and record the human response",
      }),
  )) as any;
  assert.equal(response.data.sourceEventId, event.id);
  assert.deepEqual(response.data.sourceEvidenceIds, [observation.id]);
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

test("AI readiness validates configuration without revealing secrets", async () => {
  const { aiStatus } = await import("../lib/server/ai-config.ts");
  const names = [
    "FORESIGHT_AI_MODEL",
    "FORESIGHT_AI_PROVIDER",
    "AI_GATEWAY_API_KEY",
    "GEMINI_MODEL",
    "GEMINI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
  ];
  const prior = names.map((n) => process.env[n]);
  try {
    for (const n of names) delete process.env[n];
    assert.equal(aiStatus().configured, false);
    process.env.FORESIGHT_AI_MODEL = "invalid-model";
    process.env.AI_GATEWAY_API_KEY = "test-private-credential-not-real";
    assert.equal(aiStatus().configured, false);
    process.env.FORESIGHT_AI_MODEL = "google/test-model";
    assert.equal(aiStatus().configured, true);
    assert.ok(!JSON.stringify(aiStatus()).includes("test-private"));
    delete process.env.FORESIGHT_AI_MODEL;
    process.env.GEMINI_MODEL = "test-gemini-model";
    process.env.GEMINI_API_KEY = "test-private-credential-not-real";
    assert.equal(aiStatus().configured, true);
  } finally {
    names.forEach((n, i) => {
      if (prior[i] === undefined) delete process.env[n];
      else process.env[n] = prior[i];
    });
  }
});

test("requested report retains text, cited independent proposals and unknown measurements until supervisor review", async () => {
  const { MockLanguageModelV4 } = await import("ai/test");
  const { extractReport } = await import("../lib/server/ai.ts");
  const ctx = await workspaceFor("pump-report-regression");
  const original =
    "  At East development, pump P1 stopped and water was observed rising near the sump. No water depth or inflow was measured.\n";
  const report = (await atomic(
    async () =>
      await mutate(ctx, ["reports"], { text: original, zoneId: "zone-b" }),
  )) as any;
  const supported = (quote: string, overrides: Partial<Fact>) =>
    fact({
      timeExpression: null,
      assetId: null,
      spans: [
        {
          start: original.indexOf(quote),
          end: original.indexOf(quote) + quote.length,
          quote,
        },
      ],
      ...overrides,
    });
  const proposals = [
    supported("pump P1 stopped", {
      assetId: "P1",
      condition: "Pump P1 stopped",
    }),
    supported("water was observed rising near the sump", {
      category: "water",
      condition: "Water rising near sump",
    }),
  ];
  const response = (facts: Fact[]) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          facts,
          unknowns: [
            "Water depth, inflow, worker location and observation time are unknown",
          ],
        }),
      },
    ],
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
  const extraction = await extractReport(ctx, original, {
    model: new MockLanguageModelV4({
      doGenerate: async () => response(proposals),
    }),
  });
  assert.equal((await get(ctx, report.id)).data.text, original);
  const measured = "At North working, water depth was measured at 2 m.";
  const measuredFact = fact({
    category: "water",
    zoneId: "zone-a",
    assetId: null,
    condition: "Measured water depth",
    quantity: 2,
    unit: "m",
    timeExpression: null,
    spans: [{ start: 0, end: measured.length, quote: measured }],
  });
  const measuredResult = await extractReport(ctx, measured, {
    model: new MockLanguageModelV4({
      doGenerate: async () => response([measuredFact]),
    }),
  });
  assert.equal(measuredResult.facts[0].quantity, 2);
  assert.equal(extraction.facts.length, 2);
  for (const f of extraction.facts) {
    assert.equal(f.quantity, null);
    assert.equal(f.observedAt, null);
    validateSpans(original, [f]);
  }
  assert.equal((await list(ctx, "observation")).length, 0);
  const zero = supported("No water depth or inflow was measured", {
    quantity: 0,
    unit: "m",
    category: "water",
  });
  await assert.rejects(
    () =>
      extractReport(ctx, original, {
        model: new MockLanguageModelV4({
          doGenerate: async () => response([zero]),
        }),
      }),
    /Extraction unavailable/,
  );
  await atomic(
    async () =>
      await mutate(ctx, ["reports", report.id, "review"], {
        expectedRevision: report.revision,
        facts: [extraction.facts[0]],
        reason:
          "Accept only pump condition after reviewing the original report",
      }),
  );
  assert.equal((await list(ctx, "observation")).length, 1);
  assert.equal((await get(ctx, report.id)).data.text, original);
});

test("pump-failure UI preset matches the executable regression fixture", async () => {
  const { fictionalScenario, pumpFailureDemonstration } =
    await import("../lib/domain/scenario.ts");
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/pump-failure.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(
    pumpFailureDemonstration(
      fictionalScenario(
        fixture.workspaceId,
        fixture.baselineSnapshotId,
        fixture.timeOrigin,
      ),
      4,
    ),
    fixture,
  );
});

test("human response freezes a completed run, preserves source links and leaves assessments and muster unchanged", async () => {
  const { fictionalScenario } = await import("../lib/domain/scenario.ts");
  const ctx = await workspaceFor("lab-response-user"),
    other = await workspaceFor("lab-response-other");
  const snapshot = await atomic(
    async () => await insert(ctx, "snapshot", { fictional: true }),
  );
  const scenario = fictionalScenario(
    ctx.workspaceId,
    snapshot.id,
    "2026-10-18T08:00:00Z",
  );
  const run = await atomic(
    async () =>
      await insert(ctx, "run", {
        scenario,
        status: "completed",
        result: {
          status: "completed",
          summary: { finalStorageM3: 6 },
          thresholds: [],
          routes: {},
          inputHash: "fixture-only",
        },
      }),
  );
  const before = (await list(ctx, "assessment")).length;
  const input = {
    sourceId: run.id,
    sourceKind: "run",
    title: "Fictional exercise response",
    owner: "Exercise supervisor",
    dueAt: "2026-10-19T08:00:00Z",
    reason:
      "Review earlier backup activation and inspect the alternative route",
  };
  await assert.rejects(() =>
    atomic(async () => await mutate(other, ["cases", "from-source"], input)),
  );
  const response = (await atomic(
    async () => await mutate(ctx, ["cases", "from-source"], input),
  )) as any;
  assert.equal(response.data.sourceRunId, run.id);
  assert.deepEqual(response.data.assumptions, scenario);
  assert.equal((await list(ctx, "muster")).length, 0);
  assert.equal((await list(ctx, "assessment")).length, before);
  const queued = await atomic(
    async () => await insert(ctx, "run", { scenario, status: "queued" }),
  );
  await assert.rejects(
    () =>
      atomic(
        async () =>
          await mutate(ctx, ["cases", "from-source"], {
            ...input,
            sourceId: queued.id,
          }),
      ),
    /completed run/,
  );
});

test("GLB validation rejects external resources, missing positions and out-of-bounds binary views", async () => {
  const { validateGlb } = await import("../lib/domain/glb.ts");
  const make = (change: (d: any) => void = () => {}) => {
    const doc = {
      asset: { version: "2.0" },
      buffers: [{ byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      accessors: [
        { bufferView: 0, type: "VEC3", componentType: 5126, count: 3 },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    };
    change(doc);
    const json = Buffer.from(JSON.stringify(doc));
    const size = Math.ceil(json.length / 4) * 4;
    const b = Buffer.alloc(12 + 8 + size + 8 + 36);
    b.write("glTF");
    b.writeUInt32LE(2, 4);
    b.writeUInt32LE(b.length, 8);
    b.writeUInt32LE(size, 12);
    b.writeUInt32LE(0x4e4f534a, 16);
    b.fill(32, 20, 20 + size);
    json.copy(b, 20);
    b.writeUInt32LE(36, 20 + size);
    b.writeUInt32LE(0x004e4942, 24 + size);
    return b;
  };
  validateGlb(make());
  assert.throws(
    () =>
      validateGlb(
        make((d) => (d.buffers[0].uri = "https://example.invalid/mesh.bin")),
      ),
    /External/,
  );
  assert.throws(
    () => validateGlb(make((d) => (d.bufferViews[0].byteLength = 40))),
    /outside/,
  );
  assert.throws(
    () =>
      validateGlb(
        make((d) => (d.meshes[0].primitives[0].attributes.POSITION = 8)),
      ),
    /position/,
  );
  assert.throws(
    () => validateGlb(make((d) => (d.accessors[0].count = 1000000))),
    /accessor/,
  );
  const truncated = make();
  truncated.writeUInt32LE(999999, 12);
  assert.throws(() => validateGlb(truncated), /chunk/);
});
