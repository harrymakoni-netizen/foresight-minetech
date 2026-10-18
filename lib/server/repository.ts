import { createHash, randomUUID } from "node:crypto";
import { query, transaction, lock } from "./db.ts";
import { site, type Entity, type Role } from "../domain/contracts.ts";
export class DomainError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export type Context = {
  workspaceId: string;
  userId: string;
  actor: string;
  role: Role;
  mode: string;
};
export const hash = (x: unknown): string =>
  createHash("sha256").update(canonical(x)).digest("hex");
export function canonical(x: unknown): string {
  if (Array.isArray(x)) return "[" + x.map(canonical).join(",") + "]";
  if (x && typeof x === "object")
    return (
      "{" +
      Object.entries(x)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(x);
}
function decode(row: any): Entity {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    zoneId: row.zone_id,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    data: JSON.parse(row.payload),
  };
}
export async function list(ctx: Context, kind?: string): Promise<Entity[]> {
  const { rows } = await query(
    "SELECT * FROM foresight.entities WHERE workspace_id=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY created_at DESC,sequence DESC",
    [ctx.workspaceId, kind || null],
  );
  return rows.map(decode);
}
export async function get(
  ctx: Context,
  id: string,
  kind?: string,
): Promise<Entity> {
  const { rows } = await query(
    "SELECT * FROM foresight.entities WHERE workspace_id=$1 AND id=$2",
    [ctx.workspaceId, id],
  );
  if (!rows[0])
    throw new DomainError(
      404,
      "NOT_FOUND",
      "Record not found in this workspace.",
    );
  const entity = decode(rows[0]);
  if (kind && entity.kind !== kind)
    throw new DomainError(422, "REFERENCE_TYPE", "Invalid record reference.");
  return entity;
}
export async function insert(
  ctx: Context,
  kind: string,
  data: object,
  zoneId: string | null = null,
  links: { id: string; relation: string }[] = [],
): Promise<Entity> {
  return atomic(async () => {
    const now = new Date().toISOString(),
      id = randomUUID();
    const entity = {
      id,
      workspaceId: ctx.workspaceId,
      kind,
      zoneId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      data,
    } as Entity;
    await query(
      "INSERT INTO foresight.entities(id,workspace_id,kind,zone_id,revision,created_at,updated_at,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, ctx.workspaceId, kind, zoneId, 1, now, now, JSON.stringify(data)],
    );
    for (const link of links) {
      await get(ctx, link.id);
      await query("INSERT INTO foresight.entity_links VALUES($1,$2,$3,$4)", [
        ctx.workspaceId,
        id,
        link.id,
        link.relation,
      ]);
    }
    await audit(ctx, id, `create:${kind}`, null, entity);
    return entity;
  });
}
export async function update(
  ctx: Context,
  old: Entity,
  revision: number,
  data: object,
): Promise<Entity> {
  if (old.workspaceId !== ctx.workspaceId)
    throw new DomainError(404, "NOT_FOUND", "Record not found.");
  if (
    [
      "observation",
      "assessment",
      "legacy-record",
      "legacy-audit",
      "scenario",
      "snapshot",
    ].includes(old.kind)
  )
    throw new DomainError(
      409,
      "IMMUTABLE",
      "Historical evidence is append-only.",
    );
  return atomic(async () => {
    const now = new Date().toISOString();
    const result = await query(
      "UPDATE foresight.entities SET payload=$1,revision=revision+1,updated_at=$2 WHERE workspace_id=$3 AND id=$4 AND revision=$5",
      [JSON.stringify(data), now, ctx.workspaceId, old.id, revision],
    );
    if (!result.changes)
      throw new DomainError(
        409,
        "REVISION_CONFLICT",
        "This record changed. Review the current version before retrying.",
      );
    const next = {
      ...old,
      data,
      revision: revision + 1,
      updatedAt: now,
    } as Entity;
    await audit(ctx, old.id, `update:${old.kind}`, old, next);
    return next;
  });
}
export async function audit(
  ctx: Context,
  id: string | null,
  operation: string,
  before: unknown,
  after: unknown,
) {
  await query(
    "INSERT INTO foresight.audit_events(id,workspace_id,entity_id,actor,operation,server_at,before_json,after_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      randomUUID(),
      ctx.workspaceId,
      id,
      ctx.actor,
      operation,
      new Date().toISOString(),
      before ? JSON.stringify(before) : null,
      JSON.stringify(after),
    ],
  );
}
export const atomic = transaction;
export async function idempotent<T>(
  ctx: Context,
  key: string,
  input: unknown,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!/^[a-zA-Z0-9_-]{12,120}$/.test(key))
    throw new DomainError(
      400,
      "IDEMPOTENCY_REQUIRED",
      "A client idempotency key is required.",
    );
  return atomic(async () => {
    await lock(`submission:${ctx.workspaceId}:${key}`);
    const {
      rows: [existing],
    } = await query(
      "SELECT * FROM foresight.idempotency WHERE workspace_id=$1 AND key=$2",
      [ctx.workspaceId, key],
    );
    const digest = hash(input);
    if (existing) {
      if (existing.input_hash !== digest)
        throw new DomainError(
          409,
          "KEY_CONFLICT",
          "This submission key was already used for different content.",
        );
      return JSON.parse(existing.result_json);
    }
    await useBudget(ctx, "mutations", 2000);
    // Serialize the workspace's mutations so reviewed assessments see a consistent
    // observation set even when two different submissions arrive simultaneously.
    await lock(`workspace:${ctx.workspaceId}`);
    const result = await fn();
    await query("INSERT INTO foresight.idempotency VALUES($1,$2,$3,$4)", [
      ctx.workspaceId,
      key,
      digest,
      JSON.stringify(result),
    ]);
    return result;
  });
}
export async function useBudget(
  ctx: Context,
  category: string,
  maximum: number,
) {
  await atomic(async () => {
    const day = new Date().toISOString().slice(0, 10);
    await lock(`budget:${ctx.workspaceId}:${day}:${category}`);
    const {
      rows: [row],
    } = await query(
      "SELECT count FROM foresight.usage WHERE workspace_id=$1 AND day=$2 AND category=$3",
      [ctx.workspaceId, day, category],
    );
    if ((row?.count || 0) >= maximum)
      throw new DomainError(
        429,
        "BUDGET",
        "Workspace daily resource budget reached.",
      );
    await query(
      "INSERT INTO foresight.usage VALUES($1,$2,$3,1) ON CONFLICT(workspace_id,day,category) DO UPDATE SET count=foresight.usage.count+1",
      [ctx.workspaceId, day, category],
    );
  });
}
export async function workspaceFor(userId: string): Promise<Context> {
  return atomic(async () => {
    await lock(`user-workspace:${userId}`);
    const {
      rows: [row],
    } = await query(
      "SELECT w.*,m.role FROM foresight.workspaces w JOIN foresight.memberships m ON m.workspace_id=w.id WHERE m.user_id=$1 AND w.mode!=$2 ORDER BY w.created_at DESC LIMIT 1",
      [userId, "legacy"],
    );
    if (row) {
      if (row.expires_at && Date.parse(row.expires_at) < Date.now())
        throw new DomainError(
          401,
          "DEMO_EXPIRED",
          "This demonstration expired. Start a new session.",
        );
      return {
        workspaceId: row.id,
        userId,
        actor: "Fictional demo supervisor",
        role: row.role,
        mode: row.mode,
      };
    }
    const id = randomUUID(),
      now = new Date().toISOString();
    await query("INSERT INTO foresight.workspaces VALUES($1,$2,$3,$4,$5,$6)", [
      id,
      site.id,
      "Your isolated demonstration",
      "demonstration",
      now,
      new Date(Date.now() + 7 * 86400e3).toISOString(),
    ]);
    await query("INSERT INTO foresight.memberships VALUES($1,$2,$3)", [
      id,
      userId,
      "supervisor",
    ]);
    const ctx: Context = {
      workspaceId: id,
      userId,
      actor: "Fictional demo supervisor",
      role: "supervisor",
      mode: "demonstration",
    };
    for (const [i, name] of [
      "Training worker A",
      "Training worker B",
      "Training worker C",
    ].entries())
      await insert(
        ctx,
        "worker",
        {
          name,
          role: "Fictional crew",
          zoneId: site.zones[i].id,
          startsAt: now,
          endsAt: new Date(Date.now() + 12 * 3600e3).toISOString(),
          status: "assigned",
        },
        site.zones[i].id,
      );
    await insert(
      ctx,
      "camera",
      {
        name: "Training camera B1",
        zoneId: "zone-b",
        required: ["helmet", "vest"],
        policyVersion: "ppe-development-1",
        calibration: "Zone mapping only; no global position",
      },
      "zone-b",
    );
    return ctx;
  });
}
export async function auditLog(ctx: Context) {
  return (
    await query(
      "SELECT id,entity_id,actor,operation,server_at,before_json,after_json FROM foresight.audit_events WHERE workspace_id=$1 ORDER BY sequence DESC",
      [ctx.workspaceId],
    )
  ).rows;
}

// Sequential writes cannot escape a transaction when one item fails.
export async function sequential<T, U>(
  items: T[],
  fn: (item: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  for (const item of items) results.push(await fn(item));
  return results;
}
