import { readFileSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { query } from "./db.ts";
import {
  sequential,
  atomic,
  insert,
  idempotent,
  hash,
  type Context,
} from "./repository.ts";
export async function migrateLegacy(filename: string) {
  const raw = readFileSync(filename, "utf8"),
    source = JSON.parse(raw);
  if (!Array.isArray(source.records) || !Array.isArray(source.audit))
    throw new Error("Legacy document must contain records and audit arrays.");
  const digest = hash(source),
    workspaceId = "legacy-" + digest.slice(0, 24),
    backupDirectory = path.join(process.cwd(), ".minetech-data", "backups");
  mkdirSync(backupDirectory, { recursive: true });
  const backup = path.join(backupDirectory, `legacy-${digest}.json`);
  copyFileSync(filename, backup);
  return await atomic(async () => {
    await query(
      "INSERT INTO foresight.workspaces VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING",
      [
        workspaceId,
        "fictional-mine-001",
        "Preserved legacy fictional records",
        "legacy",
        new Date().toISOString(),
        null,
      ],
    );
    const ctx: Context = {
      workspaceId,
      userId: "migration-operator",
      actor: "Local migration operator; legacy actors remain unverified",
      role: "administrator",
      mode: "legacy",
    };
    return await idempotent(ctx, "migration-" + digest, source, async () => {
      const records = await sequential(
        source.records,
        async (record: any) =>
          await insert(
            ctx,
            "legacy-record",
            {
              legacyId: record.id,
              original: record,
              sourceDocumentHash: digest,
              importedFrom: path.basename(filename),
            },
            record.zone || null,
          ),
      );
      const audit = await sequential(
        source.audit,
        async (entry: any) =>
          await insert(
            ctx,
            "legacy-audit",
            {
              legacyId: entry.id,
              original: entry,
              sourceDocumentHash: digest,
            },
            null,
          ),
      );
      // Port legacy MineShield incidents into the single incidents register,
      // linked to the preserved original and its audit entries.
      const statusMap: Record<string, string> = {
        open: "open",
        acknowledged: "acknowledged",
        investigating: "action-in-progress",
        "closed-record": "closed",
      };
      const incidents = await sequential(
        records.filter((r) => (r.data as any).original?.kind === "incident"),
        async (legacy) => {
          const original = (legacy.data as any).original,
            d = original.data || {};
          const auditIds = audit
            .filter((a) => (a.data as any).original?.record_id === original.id)
            .map((a) => ({ id: a.id, relation: "legacy-audit" }));
          return await insert(
            ctx,
            "case",
            {
              title: String(d.name || "Legacy incident").slice(0, 140),
              zoneId: original.zone || null,
              category: d.category || "near-miss",
              source: "legacy-mineshield",
              description: String(d.notes || ""),
              peopleAffected: (Array.isArray(d.people) ? d.people : []).map(
                (name: unknown) => ({ name: String(name), personId: null }),
              ),
              owner: String(d.actor || "Legacy record (unverified actor)"),
              dueAt: null,
              planning: false,
              status: statusMap[d.status] || "open",
              legacyStatus: d.status ?? null,
              actions: [],
              history: [
                {
                  at: original.createdAt || null,
                  actor: "Legacy migration",
                  status: statusMap[d.status] || "open",
                  reason: "Migrated from the MineShield register",
                },
              ],
            },
            original.zone || null,
            [{ id: legacy.id, relation: "migrated-from" }, ...auditIds],
          );
        },
      );
      return {
        workspaceId,
        backup,
        incidentCount: incidents.length,
        sourceDocumentHash: digest,
        recordCount: records.length,
        auditCount: audit.length,
        limitation:
          "Copied historical document. No hosted Blob was read or modified; membership is not granted automatically.",
      };
    });
  });
}
