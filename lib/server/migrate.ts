import { readFileSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { database } from "./db.ts";
import {
  atomic,
  insert,
  idempotent,
  hash,
  type Context,
} from "./repository.ts";
export function migrateLegacy(filename: string) {
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
  return atomic(() => {
    database()
      .prepare("INSERT OR IGNORE INTO workspaces VALUES(?,?,?,?,?,?)")
      .run(
        workspaceId,
        "fictional-mine-001",
        "Preserved legacy fictional records",
        "legacy",
        new Date().toISOString(),
        null,
      );
    const ctx: Context = {
      workspaceId,
      userId: "migration-operator",
      actor: "Local migration operator; legacy actors remain unverified",
      role: "administrator",
      mode: "legacy",
    };
    return idempotent(ctx, "migration-" + digest, source, () => {
      const records = source.records.map((record: any) =>
        insert(
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
      const audit = source.audit.map((entry: any) =>
        insert(
          ctx,
          "legacy-audit",
          { legacyId: entry.id, original: entry, sourceDocumentHash: digest },
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
