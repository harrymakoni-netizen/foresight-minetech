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
      return {
        workspaceId,
        backup,
        sourceDocumentHash: digest,
        recordCount: records.length,
        auditCount: audit.length,
        limitation:
          "Copied historical document. No hosted Blob was read or modified; membership is not granted automatically.",
      };
    });
  });
}
