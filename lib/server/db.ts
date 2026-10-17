import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
let singleton: Database.Database | undefined;
export function database() {
  if (singleton) return singleton;
  if (process.env.VERCEL && !process.env.FORESIGHT_DATABASE_PATH)
    throw new Error(
      "A persistent database adapter must be configured; ephemeral hosted SQLite is disabled.",
    );
  const filename =
    process.env.FORESIGHT_DATABASE_PATH ||
    path.join(process.cwd(), ".minetech-data", "foresight.sqlite");
  mkdirSync(path.dirname(filename), { recursive: true });
  singleton = new Database(filename);
  singleton.pragma("journal_mode = WAL");
  singleton.pragma("foreign_keys = ON");
  singleton.pragma("busy_timeout = 5000");
  singleton.exec(
    readFileSync(
      path.join(process.cwd(), "migrations/001-workspaces.sql"),
      "utf8",
    ),
  );
  return singleton;
}
