import { createHash, randomUUID } from "node:crypto";
import { database } from "./db.ts";
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
export function list(ctx: Context, kind?: string): Entity[] {
  return (
    database()
      .prepare(
        "SELECT * FROM entities WHERE workspace_id=? AND (? IS NULL OR kind=?) ORDER BY created_at DESC,rowid DESC",
      )
      .all(ctx.workspaceId, kind || null, kind || null) as any[]
  ).map(decode);
}
export function get(ctx: Context, id: string, kind?: string): Entity {
  const row = database()
    .prepare("SELECT * FROM entities WHERE workspace_id=? AND id=?")
    .get(ctx.workspaceId, id);
  if (!row)
    throw new DomainError(
      404,
      "NOT_FOUND",
      "Record not found in this workspace.",
    );
  const entity = decode(row);
  if (kind && entity.kind !== kind)
    throw new DomainError(422, "REFERENCE_TYPE", "Invalid record reference.");
  return entity;
}
export function insert(
  ctx: Context,
  kind: string,
  data: object,
  zoneId: string | null = null,
  links: { id: string; relation: string }[] = [],
): Entity {
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
  database()
    .prepare("INSERT INTO entities VALUES(?,?,?,?,?,?,?,?)")
    .run(id, ctx.workspaceId, kind, zoneId, 1, now, now, JSON.stringify(data));
  for (const link of links) {
    get(ctx, link.id);
    database()
      .prepare("INSERT INTO entity_links VALUES(?,?,?,?)")
      .run(ctx.workspaceId, id, link.id, link.relation);
  }
  audit(ctx, id, `create:${kind}`, null, entity);
  return entity;
}
export function update(
  ctx: Context,
  old: Entity,
  revision: number,
  data: object,
): Entity {
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
  const now = new Date().toISOString();
  const result = database()
    .prepare(
      "UPDATE entities SET payload=?,revision=revision+1,updated_at=? WHERE workspace_id=? AND id=? AND revision=?",
    )
    .run(JSON.stringify(data), now, ctx.workspaceId, old.id, revision);
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
  audit(ctx, old.id, `update:${old.kind}`, old, next);
  return next;
}
export function audit(
  ctx: Context,
  id: string | null,
  operation: string,
  before: unknown,
  after: unknown,
) {
  database()
    .prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?,?)")
    .run(
      randomUUID(),
      ctx.workspaceId,
      id,
      ctx.actor,
      operation,
      new Date().toISOString(),
      before ? JSON.stringify(before) : null,
      JSON.stringify(after),
    );
}
export function atomic<T>(fn: () => T): T {
  return database().transaction(fn).immediate();
}
export function idempotent<T>(
  ctx: Context,
  key: string,
  input: unknown,
  fn: () => T,
): T {
  if (!/^[a-zA-Z0-9_-]{12,120}$/.test(key))
    throw new DomainError(
      400,
      "IDEMPOTENCY_REQUIRED",
      "A client idempotency key is required.",
    );
  return atomic(() => {
    const existing = database()
      .prepare("SELECT * FROM idempotency WHERE workspace_id=? AND key=?")
      .get(ctx.workspaceId, key) as any;
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
    useBudget(ctx, "mutations", 2000);
    const result = fn();
    database()
      .prepare("INSERT INTO idempotency VALUES(?,?,?,?)")
      .run(ctx.workspaceId, key, digest, JSON.stringify(result));
    return result;
  });
}
export function useBudget(ctx: Context, category: string, maximum: number) {
  atomic(() => {
    const day = new Date().toISOString().slice(0, 10);
    const row = database()
      .prepare(
        "SELECT count FROM usage WHERE workspace_id=? AND day=? AND category=?",
      )
      .get(ctx.workspaceId, day, category) as any;
    if ((row?.count || 0) >= maximum)
      throw new DomainError(
        429,
        "BUDGET",
        "Workspace daily resource budget reached.",
      );
    database()
      .prepare(
        "INSERT INTO usage VALUES(?,?,?,1) ON CONFLICT(workspace_id,day,category) DO UPDATE SET count=count+1",
      )
      .run(ctx.workspaceId, day, category);
  });
}
export function workspaceFor(userId: string): Context {
  const row = database()
    .prepare(
      "SELECT w.*,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=? AND w.mode!=? ORDER BY w.created_at DESC LIMIT 1",
    )
    .get(userId, "legacy") as any;
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
  return atomic(() => {
    const id = randomUUID(),
      now = new Date().toISOString();
    database()
      .prepare("INSERT INTO workspaces VALUES(?,?,?,?,?,?)")
      .run(
        id,
        site.id,
        "Your isolated demonstration",
        "demonstration",
        now,
        new Date(Date.now() + 7 * 86400e3).toISOString(),
      );
    database()
      .prepare("INSERT INTO memberships VALUES(?,?,?)")
      .run(id, userId, "supervisor");
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
      insert(
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
    insert(
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
export function auditLog(ctx: Context) {
  return database()
    .prepare(
      "SELECT id,entity_id,actor,operation,server_at,before_json,after_json FROM audit_events WHERE workspace_id=? ORDER BY rowid DESC",
    )
    .all(ctx.workspaceId);
}
