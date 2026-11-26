// Phase 8 tests: run metrics and grounding, the assistant's tool set and its
// limits, and explanations. Models are mocked: no provider is called. The
// synthetic run results below are fixtures for the checks, not scenario output.
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { compareRuns, deterministicExplanation, escapeMetrics, groundingProblems, toMetricRun } from "../lib/domain/run-metrics.ts";

const directory = mkdtempSync(path.join(tmpdir(), "foresight-ai-"));
process.env.FORESIGHT_DATABASE_PATH = path.join(directory, "test.sqlite");
process.env.FORESIGHT_SIMULATOR_URL = "http://127.0.0.1:9";
process.env.FORESIGHT_WORKER_TOKEN = "ai-test-token-0123456789abcdef012345";
const { closeDatabase } = await import("../lib/server/db.ts");
const repo = await import("../lib/server/repository.ts");
const ci = await import("../lib/server/checkins.ts");
const mm = await import("../lib/server/mine-model.ts");
const ai = await import("../lib/server/ai-tools.ts");
after(async () => closeDatabase());
const run = randomUUID();
const ws = async (name: string) => {
  const ctx = await repo.workspaceFor(`ai-${run}-${name}`);
  await mm.resetTrainingMine(ctx);
  return ctx;
};

const escapeResult = (over: Record<string, unknown> = {}) => ({
  inputHash: "a".repeat(64),
  flooding: { dangerLevelM: 2, firstDangerSeconds: 6000, peakLevelM: 2.4 },
  closures: [{ tunnelId: "T4", atSeconds: 6000 }, { tunnelId: "T6", atSeconds: 6000 }],
  escape: { totals: { simulated: 12, "reached-exit": 7, "reached-refuge": 0, "cut-off": 5, "still-walking": 0, balanced: true }, times: { t50: 540, t95: null, t100: null }, seed: 11 },
  endurance: { selfRescuer: { available: false, reason: "Self-rescuer rated duration was not entered" }, refuges: [] },
  congestion: { available: false, reason: "No measurement lines in the model" },
  ...over,
});
const fixtureRun = (id = "run-1", result = escapeResult()) =>
  toMetricRun({ id, kind: "escape-run", data: { name: "Fixture run", status: "completed", result, mineModelRevisionNumber: 1, startAssumption: "People start spread along their zone (assumed).", scenario: { evacuationOrderMinutes: 100, preMovementMinutes: { min: 0, max: 2 }, speed: { mean: 1 }, seed: 11, peopleSource: "planned-headcount" } } })!;

// ---- metrics and grounding ----------------------------------------------------------------------
test("metrics carry ids, units and an honest unavailable reason", () => {
  const r = fixtureRun();
  const get = (id: string) => r.metrics.find((m) => m.id === id)!;
  assert.equal(get("escape.people.cut-off").value, 5);
  assert.equal(get("escape.time.t50").value, 540);
  assert.equal(get("escape.time.t100").available, false);
  assert.match(get("escape.time.t100").reason!, /Not everyone/);
  assert.equal(get("endurance.self-rescuer-exceeding").available, false);
  assert.match(get("endurance.self-rescuer-exceeding").reason!, /not entered/);
  assert.equal(get("congestion.peak-per-minute").available, false);
  assert.equal(toMetricRun({ id: "x", kind: "escape-run", data: { status: "running", result: null } }), null);
});
test("the deterministic explanation cites a real run and metric for every paragraph, states assumptions and lists what is unavailable", () => {
  const r = fixtureRun();
  const e = deterministicExplanation(r);
  assert.deepEqual(groundingProblems(e.paragraphs, [r]), []);
  assert.ok(e.paragraphs.every((p) => p.citations.length > 0));
  assert.match(e.paragraphs[1].text, /Time until everyone is at safety: unavailable/);
  assert.ok(e.assumptions.some((a) => /assumed/.test(a)));
  assert.ok(e.unavailable.some((u) => u.metricId === "escape.time.t100"));
  assert.ok(e.unavailable.some((u) => u.metricId === "congestion.peak-per-minute"));
});
test("grounding rejects what is not in the run: unknown run or metric, no citation, an invented number, a figure for an unavailable metric", () => {
  const r = fixtureRun();
  const cite = (metricId: string, runId = r.id) => ({ runId, metricId });
  assert.deepEqual(groundingProblems([{ text: "5 people were cut off.", citations: [cite("escape.people.cut-off")] }], [r]), []);
  assert.deepEqual(groundingProblems([{ text: "The first 50 % were at safety after 9 min 00 s (540 s).", citations: [cite("escape.time.t50")] }], [r]), []);
  assert.match(groundingProblems([{ text: "5 people.", citations: [cite("escape.people.cut-off", "other-run")] }], [r]).join(), /unknown run/);
  assert.match(groundingProblems([{ text: "5 people.", citations: [cite("escape.people.made-up")] }], [r]).join(), /unknown metric/);
  assert.match(groundingProblems([{ text: "Some people were cut off.", citations: [] }], [r]).join(), /cites no run/);
  assert.match(groundingProblems([{ text: "6 people were cut off.", citations: [cite("escape.people.cut-off")] }], [r]).join(), /states 6/);
  assert.match(groundingProblems([{ text: "Everyone was at safety after 20 min.", citations: [cite("escape.time.t100")] }], [r]).join(), /unavailable|states 20/);
  assert.deepEqual(groundingProblems([{ text: "Everyone reaching safety is unavailable: not everyone gets there within the horizon.", citations: [cite("escape.time.t100")] }], [r]), []);
});
test("comparison reports deltas, availability changes and whether inputs differ", () => {
  const a = fixtureRun("a");
  const b = fixtureRun("b", escapeResult({ inputHash: "b".repeat(64), escape: { totals: { simulated: 12, "reached-exit": 12, "reached-refuge": 0, "cut-off": 0, "still-walking": 0 }, times: { t50: 480, t95: 900, t100: 1500 } } }));
  const c = compareRuns(a, b);
  assert.equal(c.sameInputs, false);
  assert.equal(c.deltas.find((d) => d.id === "escape.people.cut-off")!.change, "−5");
  assert.equal(c.deltas.find((d) => d.id === "escape.time.t100")!.change, "became available");
  assert.equal(c.deltas.find((d) => d.id === "escape.time.t50")!.change, "−1 min 00 s");
});

// ---- tools ---------------------------------------------------------------------------------------------
test("declared-underground tool withholds names and never returns phone numbers unless the policy allows names", async () => {
  const ctx = await ws("declared");
  const p = await ci.createPerson(ctx, { name: "Tendai Moyo", phone: "+99900000201", role: "miner", channels: { whatsapp: false, sms: true } });
  await ci.recordConsent(ctx, p.id, "in-person", true, "test");
  await ci.createCheckIn(ctx, { personId: p.id, shaftId: "main-shaft", zoneId: null, expectedReturn: new Date(Date.now() + 3600e3).toISOString(), buddyPersonId: null, method: "manual", declaredBy: "test" });
  const out = await ai.listDeclaredUnderground(ctx);
  assert.equal(out.total, 1);
  assert.equal(out.shafts[0].declared, 1);
  assert.doesNotMatch(JSON.stringify(out), /Tendai|99900000201/);
  assert.match(out.note, /withheld/);
  await repo.insert(ctx, "ai-policy", { allowNames: true });
  const allowed = await ai.listDeclaredUnderground(ctx);
  assert.deepEqual(allowed.shafts[0].names, ["Tendai Moyo"]);
  assert.doesNotMatch(JSON.stringify(allowed), /99900000201/);
});
test("model inspection reports what is in the model and what is missing, without filling gaps", async () => {
  const ctx = await ws("inspect");
  const m = await ai.inspectMineModel(ctx);
  assert.deepEqual(m.counts, { junctions: 13, tunnels: 13, exits: 3, refuges: 1, sumps: 1, pumps: 2, zones: 3 });
  assert.equal(m.exits.find((e) => e.id === "X-MS")!.hasHoist, true);
  assert.equal(m.exits.find((e) => e.id === "X-EI")!.hasHoist, false);
  assert.ok(m.provenanceByQuality.assumed > 0);
  const gaps = await ai.identifyMissingInputs(ctx, { engine: "cage" });
  assert.equal(gaps.engine, "cage");
  assert.ok(Array.isArray(gaps.issues));
});
test("scenario drafts: defaults are stated, endurance stays not entered, problems are listed, nothing runs", async () => {
  const ctx = await ws("draft");
  const none = await ai.createScenarioDraft(ctx, {});
  assert.equal(none.ok, false);
  assert.match(none.problems.join(" "), /Planned headcount is empty|Nobody is declared/);
  await assert.rejects(() => ai.createScenarioDraft(ctx, { plannedHeadcount: { "zone-b": 6 }, sourceReportId: "invented-report" }), /not found/);
  const report = await repo.insert(ctx, "report", { text: "Pump P1 stopped at East development.", reviewStatus: "pending" });
  const d = await ai.createScenarioDraft(ctx, { plannedHeadcount: { "zone-b": 6 }, evacuationOrderMinutes: 100, sourceReportId: report.id });
  assert.equal(d.ok, true);
  assert.equal(d.scenario.endurance.selfRescuerRatedMinutes, null);
  assert.equal(d.scenario.evacuationOrderMinutes, 100);
  assert.equal(d.scenario.sourceReportId, report.id);
  const stored = await repo.get(ctx, d.draftId, "scenario-draft");
  assert.equal(stored.data.status, "draft");
  assert.ok((stored.data.assumedByDefault as string[]).some((a) => /endurance values not entered/.test(a)));
  assert.equal((await repo.list(ctx, "escape-run")).length, 0, "a draft starts no run");
  assert.equal((await ai.validateScenario(ctx, { draftId: d.draftId })).ok, true);
});
test("submitting a run needs permission for the request and a supervisor role", async () => {
  const ctx = await ws("submit");
  const d = await ai.createScenarioDraft(ctx, { plannedHeadcount: { "zone-b": 4 } });
  await assert.rejects(() => ai.submitRun(ctx, { draftId: d.draftId }, false), /not allowed for this request/);
  await assert.rejects(() => ai.submitRun({ ...ctx, role: "reporter" }, { draftId: d.draftId }, true), /supervisor or administrator/);
  const started = await ai.submitRun(ctx, { draftId: d.draftId }, true);
  assert.equal(started.status, "worker-unavailable"); // no worker listens in tests: recorded, not faked
  assert.equal((await repo.list(ctx, "escape-run")).length, 1);
});
test("results and incident drafts come only from completed runs and are text with no record", async () => {
  const ctx = await ws("results");
  const e = await repo.insert(ctx, "escape-run", { name: "Fixture run", status: "completed", result: escapeResult(), mineModelRevisionNumber: 1, startAssumption: "assumed start", scenario: { evacuationOrderMinutes: 100, preMovementMinutes: { min: 0, max: 2 }, speed: { mean: 1 }, seed: 11, peopleSource: "planned-headcount" } });
  const running = await repo.insert(ctx, "escape-run", { name: "Pending", status: "running", result: null });
  const r = await ai.getRunResults(ctx, { runId: e.id });
  assert.equal(r.metrics.find((m) => m.metricId === "escape.people.cut-off")!.value, "5");
  assert.equal(r.metrics.find((m) => m.metricId === "escape.time.t100")!.available, false);
  await assert.rejects(() => ai.getRunResults(ctx, { runId: running.id }), /has not completed/);
  await assert.rejects(() => ai.getRunResults(ctx, { runId: "nope" }), /No such run/);
  const before = (await repo.list(ctx)).length;
  const draft = await ai.draftIncidentReport(ctx, { runId: e.id });
  assert.match(draft.text, /^DRAFT incident description/);
  assert.match(draft.text, /A person must review/);
  assert.equal((await repo.list(ctx)).length, before, "no record is created by a draft");
});

// ---- the assistant ---------------------------------------------------------------------------------------
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const scripted = (...turns: ({ tool: string; input: unknown } | { text: string })[]) => {
  let i = 0;
  const seen: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options: { prompt: unknown }) => {
      seen.push(JSON.stringify(options.prompt));
      const t = turns[Math.min(i++, turns.length - 1)];
      return "tool" in t
        ? { content: [{ type: "tool-call" as const, toolCallId: `call-${i}`, toolName: t.tool, input: JSON.stringify(t.input) }], finishReason: { unified: "tool-calls" as const, raw: undefined }, usage, warnings: [] }
        : { content: [{ type: "text" as const, text: t.text }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] };
    },
  });
  return { model, seen };
};
test("the assistant's tools can look things up, draft and run only when allowed: there is no tool that sends, declares, changes status or accepts evidence", async () => {
  const ctx = await ws("tools");
  const names = Object.keys(ai.assistantTools(ctx, { allowRuns: false })).sort();
  assert.deepEqual(names, [...ai.assistantToolNames].sort());
  for (const n of names) assert.doesNotMatch(n, /send|message|emergenc|declare_|set_status|change|accept|approve|close|delete|consent|notify/i);
});
test("assistant: drafts a scenario from a request; a run it tries without permission is refused and nothing is run", async () => {
  const ctx = await ws("assistant");
  const { model } = scripted(
    { tool: "create_scenario_draft", input: { plannedHeadcount: { "zone-b": 6 }, evacuationOrderMinutes: 100 } },
    { tool: "submit_run", input: { draftId: "unused" } },
    { text: "I drafted a scenario. Running it was not allowed for this request." },
  );
  const out = await ai.runAssistant(ctx, { message: "Set up a scenario for East development and run it.", allowRuns: false }, { model });
  assert.equal(out.drafts.length, 1);
  assert.deepEqual(out.steps.map((s) => [s.tool, s.ok]), [["create_scenario_draft", true], ["submit_run", false]]);
  assert.match(out.steps[1].summary, /not allowed|No such|not found/i);
  assert.equal((await repo.list(ctx, "escape-run")).length, 0);
  assert.equal((await repo.list(ctx, "scenario-draft")).length, 1);
  assert.match(out.text, /Running it was not allowed/);
});
test("assistant: with permission a supervisor's assistant submits the draft; a reporter cannot even ask for that", async () => {
  const ctx = await ws("assistant-run");
  const first = await ai.createScenarioDraft(ctx, { plannedHeadcount: { "zone-b": 4 } });
  const { model } = scripted({ tool: "submit_run", input: { draftId: first.draftId } }, { text: "Submitted." });
  const out = await ai.runAssistant(ctx, { message: "Run the draft.", allowRuns: true }, { model });
  assert.equal(out.steps[0].ok, true);
  assert.equal((await repo.list(ctx, "escape-run")).length, 1);
  await assert.rejects(() => ai.runAssistant({ ...ctx, role: "reporter" }, { message: "Run it", allowRuns: true }, { model }), /supervisor or administrator/);
});
test("assistant: an unknown tool such as send_message cannot succeed and creates no message", async () => {
  const ctx = await ws("assistant-bad");
  const { model } = scripted({ tool: "send_message", input: { to: "+99900000201", text: "hello" } }, { text: "done" });
  // The SDK reports the unknown tool call as invalid instead of running anything.
  const out = await ai.runAssistant(ctx, { message: "Text everyone to evacuate", allowRuns: false }, { model }).catch(() => null);
  assert.deepEqual(out?.steps ?? [], [], "no tool was executed");
  assert.equal((await repo.list(ctx, "message")).length, 0);
  assert.equal((await repo.list(ctx, "emergency")).length, 0);
});
test("assistant: phone numbers and contacts in the request never reach the model", async () => {
  const ctx = await ws("assistant-privacy");
  const { model, seen } = scripted({ text: "ok" });
  await ai.runAssistant(ctx, { message: "Call me on +263771234567 or mail boss@example.com about the east pump.", allowRuns: false }, { model });
  const sent = seen.join(" ");
  assert.doesNotMatch(sent, /263771234567|boss@example\.com/);
  assert.match(sent, /east pump/);
});
test("assistant without a configured model says so and changes nothing", async () => {
  const ctx = await ws("assistant-off");
  const was = { ...process.env };
  delete process.env.FORESIGHT_AI_MODEL; delete process.env.GEMINI_MODEL; delete process.env.AI_GATEWAY_API_KEY; delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  try {
    await assert.rejects(() => ai.runAssistant(ctx, { message: "hello", allowRuns: false }), /not set up/);
    await assert.rejects(() => ai.explainRuns(ctx, { runIds: ["x"], mode: "ai" }), /No such run|not set up/);
  } finally {
    Object.assign(process.env, was);
  }
});

// ---- explanations ------------------------------------------------------------------------------------------
async function savedRun(ctx: any) {
  return await repo.insert(ctx, "escape-run", { name: "Fixture run", status: "completed", result: escapeResult(), mineModelRevisionNumber: 1, startAssumption: "assumed start", scenario: { evacuationOrderMinutes: 100, preMovementMinutes: { min: 0, max: 2 }, speed: { mean: 1 }, seed: 11, peopleSource: "planned-headcount" } });
}
test("explanation without AI is deterministic, cites the run and works with no provider", async () => {
  const ctx = await ws("explain-det");
  const e = await savedRun(ctx);
  const x = await ai.explainRuns(ctx, { runIds: [e.id], mode: "deterministic" });
  assert.equal(x.mode, "deterministic");
  assert.ok(x.paragraphs.every((p) => p.citations.every((c) => c.runId === e.id)));
});
test("AI explanation is accepted only when every figure and citation is grounded in the recorded run", async () => {
  const ctx = await ws("explain-ai");
  const e = await savedRun(ctx);
  const good = scripted({ text: JSON.stringify({ paragraphs: [{ text: "5 people were cut off from their assumed start; the time until everyone is at safety is unavailable because not everyone gets there.", citations: [{ runId: e.id, metricId: "escape.people.cut-off" }, { runId: e.id, metricId: "escape.time.t100" }] }] }) });
  const ok = await ai.explainRuns(ctx, { runIds: [e.id], mode: "ai", question: "What happened?" }, { model: good.model });
  assert.equal(ok.mode, "ai");
  assert.ok(ok.unavailable.some((u) => u.metricId === "escape.time.t100"), "gaps come from the run, not the model");
  assert.ok(ok.assumptions.some((a) => /assumed/.test(a)));
  const invented = scripted({ text: JSON.stringify({ paragraphs: [{ text: "8 people were cut off.", citations: [{ runId: e.id, metricId: "escape.people.cut-off" }] }] }) });
  await assert.rejects(() => ai.explainRuns(ctx, { runIds: [e.id], mode: "ai" }, { model: invented.model }), /not grounded.*states 8/);
  const fake = scripted({ text: JSON.stringify({ paragraphs: [{ text: "Everything is fine.", citations: [{ runId: "other", metricId: "escape.people.cut-off" }] }] }) });
  await assert.rejects(() => ai.explainRuns(ctx, { runIds: [e.id], mode: "ai" }, { model: fake.model }), /unknown run/);
  const garbage = scripted({ text: "not json" });
  await assert.rejects(() => ai.explainRuns(ctx, { runIds: [e.id], mode: "ai" }, { model: garbage.model }), /unavailable/);
});
