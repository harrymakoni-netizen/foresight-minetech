// Mine model revisions (spec §8.2). Drafts are editable; a published revision
// is immutable (edits start a new draft), so a run that used it can always be
// reproduced. Publishing requires a preflight without errors.
import { atomic, get, insert, list, update, DomainError, type Context } from "./repository.ts";
import { mineModelSchema, preflight, trainingMineModel, type MineModel } from "../domain/mine-model.ts";
import type { Entity } from "../domain/contracts.ts";

const requireEditor = (ctx: Context) => {
  if (ctx.role !== "supervisor" && ctx.role !== "administrator")
    throw new DomainError(403, "ROLE_REQUIRED", "A supervisor or administrator role is required to edit the mine model.");
};
export async function publishedModel(ctx: Context): Promise<Entity | null> {
  return (
    (await list(ctx, "mine-model-revision"))
      .filter((r) => r.data.status === "published")
      .sort((a, b) => String(b.data.publishedAt).localeCompare(String(a.data.publishedAt)))[0] || null
  );
}
export async function createDraft(ctx: Context, from: "template" | "published" | string) {
  requireEditor(ctx);
  let model: MineModel, basedOn: string | null = null;
  if (from === "template") model = trainingMineModel(ctx.actor, new Date().toISOString());
  else {
    const source = from === "published" ? await publishedModel(ctx) : await get(ctx, from, "mine-model-revision");
    if (!source) throw new DomainError(404, "NO_PUBLISHED", "There is no published mine model to copy.");
    model = source.data.model as MineModel;
    basedOn = source.id;
  }
  const number = (await list(ctx, "mine-model-revision")).length + 1;
  return await insert(ctx, "mine-model-revision", { number, status: "draft", basedOn, model, preflight: preflight(model), createdBy: ctx.actor }, null, basedOn ? [{ id: basedOn, relation: "based-on" }] : []);
}
/** A draft from a model built elsewhere (DXF import). Still needs the editor and a clean preflight to publish. */
export async function createDraftFromModel(ctx: Context, model: MineModel, extra: Record<string, unknown> = {}) {
  requireEditor(ctx);
  const number = (await list(ctx, "mine-model-revision")).length + 1;
  return await insert(ctx, "mine-model-revision", { number, status: "draft", basedOn: null, model, preflight: preflight(model), createdBy: ctx.actor, ...extra });
}
export async function saveDraft(ctx: Context, id: string, input: unknown) {
  requireEditor(ctx);
  const body = input as { expectedRevision?: number; model?: unknown };
  const rev = await get(ctx, id, "mine-model-revision");
  if (rev.data.status !== "draft")
    throw new DomainError(409, "IMMUTABLE_REVISION", "Published revisions cannot change. Start a new draft.");
  const model = mineModelSchema.parse(body.model);
  if (typeof body.expectedRevision !== "number") throw new DomainError(422, "REVISION", "expectedRevision is required.");
  return await update(ctx, rev, body.expectedRevision, { ...rev.data, model, preflight: preflight(model), savedBy: ctx.actor, savedAt: new Date().toISOString() });
}
export async function publish(ctx: Context, id: string, expectedRevision: number) {
  requireEditor(ctx);
  return atomic(async () => {
    const rev = await get(ctx, id, "mine-model-revision");
    if (rev.data.status !== "draft") throw new DomainError(409, "IMMUTABLE_REVISION", "Only a draft can be published.");
    const model = mineModelSchema.parse(rev.data.model);
    const issues = preflight(model);
    const errors = issues.filter((i) => i.severity === "error");
    if (errors.length)
      throw new DomainError(422, "PREFLIGHT_FAILED", `Fix ${errors.length} blocking problem(s) before publishing: ${errors.slice(0, 3).map((e) => e.message).join(" ")}`);
    const previous = await publishedModel(ctx);
    if (previous) await update(ctx, previous, previous.revision, { ...previous.data, status: "superseded", supersededBy: id });
    return await update(ctx, rev, expectedRevision, { ...rev.data, status: "published", publishedAt: new Date().toISOString(), publishedBy: ctx.actor, preflight: issues });
  });
}
/** Training workspaces start with the fictional template published. */
export async function seedMineModel(ctx: Context) {
  const model = trainingMineModel("Foresight template", new Date().toISOString());
  await insert(ctx, "mine-model-revision", { number: 1, status: "published", basedOn: null, model, preflight: preflight(model), createdBy: "Foresight template", publishedAt: new Date().toISOString(), publishedBy: "Foresight template" });
}
/** Demo reset (spec §18): publish the training template as a new revision and
 * restore the training messaging configuration. Deletes nothing: earlier
 * revisions, runs, check-ins, messages and incidents stay in the record. */
export async function resetTrainingMine(ctx: Context) {
  requireEditor(ctx);
  const draft = await createDraft(ctx, "template");
  const published = await publish(ctx, draft.id, draft.revision);
  const { saveMessagingConfig } = await import("./checkins.ts");
  const { trainingConfig } = await import("../domain/checkin.ts");
  const { liveEnabled: _l, ...config } = trainingConfig;
  await saveMessagingConfig(ctx, config);
  return { revision: published.data.number, revisionId: published.id };
}
