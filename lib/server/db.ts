import Database from "better-sqlite3";
import { assertWorkspaceConfigured } from "./configuration.ts";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

let sqlite: Database.Database | undefined;
let pool: Pool | undefined;
let initialized: Promise<void> | undefined;
const transactions = new AsyncLocalStorage<PoolClient | Database.Database>();
const connectionString = () =>
  process.env.DATABASE_URL || process.env.POSTGRES_URL;
export const hostedDatabase = () => Boolean(connectionString());

export function postgresPool() {
  if (!connectionString())
    throw new Error("Connect a PostgreSQL database using DATABASE_URL.");
  pool ||= new Pool({
    connectionString: connectionString(),
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });
  return pool;
}

/** Local SQLite is retained for offline development, never for Vercel storage. */
export function localDatabase() {
  if (process.env.VERCEL)
    throw new Error(
      "Hosted workspaces require DATABASE_URL; temporary SQLite is disabled.",
    );
  if (!sqlite) {
    const filename =
      process.env.FORESIGHT_DATABASE_PATH ||
      path.join(process.cwd(), ".minetech-data", "foresight.sqlite");
    mkdirSync(path.dirname(filename), { recursive: true });
    sqlite = new Database(filename);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.exec(
      readFileSync(
        path.join(process.cwd(), "migrations/001-workspaces.sql"),
        "utf8",
      ),
    );
  }
  return sqlite;
}

export async function ensureDatabase() {
  assertWorkspaceConfigured();
  if (!hostedDatabase()) {
    localDatabase();
    return;
  }
  initialized ||= (async () => {
    const client = await postgresPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('foresight-schema-v1'))",
      );
      await client.query(
        readFileSync(
          path.join(process.cwd(), "migrations/002-postgres.sql"),
          "utf8",
        ),
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  })();
  try {
    await initialized;
  } catch (error) {
    initialized = undefined;
    throw error;
  }
}

export async function query<T extends QueryResultRow = Record<string, any>>(
  sql: string,
  values: unknown[] = [],
) {
  await ensureDatabase();
  const current = transactions.getStore();
  if (hostedDatabase()) {
    const result = await (
      (current as PoolClient | undefined) || postgresPool()
    ).query<T>(sql, values);
    return { rows: result.rows, changes: result.rowCount || 0 };
  }
  const parameters: unknown[] = [];
  const localSQL = sql
    .replace(/foresight\./g, "")
    .replace(/\bsequence\b/g, "rowid")
    .replace(/::text/g, "")
    .replace(/\$(\d+)/g, (_, n: string) => {
      parameters.push(values[Number(n) - 1]);
      return "?";
    });
  const statement = localDatabase().prepare(localSQL);
  if (statement.reader)
    return { rows: statement.all(...parameters) as T[], changes: 0 };
  return { rows: [] as T[], changes: statement.run(...parameters).changes };
}

export async function transaction<T>(fn: () => T | Promise<T>): Promise<T> {
  await ensureDatabase();
  if (transactions.getStore()) return fn();
  if (hostedDatabase()) {
    const client = await postgresPool().connect();
    try {
      await client.query("BEGIN");
      const result = await transactions.run(client, fn);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  return serializeLocal(async () => {
    const db = localDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = await transactions.run(db, fn);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}
let localTail: Promise<unknown> = Promise.resolve();
function serializeLocal<T>(fn: () => Promise<T>): Promise<T> {
  const next = localTail.then(fn, fn);
  localTail = next.catch(() => {});
  return next;
}

/** Only call inside transaction(). Locks are transaction-scoped on PostgreSQL. */
export async function lock(key: string) {
  if (hostedDatabase()) {
    const client = transactions.getStore() as PoolClient | undefined;
    if (!client) throw new Error("A database lock requires a transaction.");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
  }
}

export async function closeDatabase() {
  await pool?.end();
  pool = undefined;
  sqlite?.close();
  sqlite = undefined;
  initialized = undefined;
}
