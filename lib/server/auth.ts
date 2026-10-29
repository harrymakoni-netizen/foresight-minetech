import { betterAuth, type BetterAuthOptions } from "better-auth";
import { anonymous } from "better-auth/plugins/anonymous";
import { nextCookies } from "better-auth/next-js";
import { getMigrations } from "better-auth/db/migration";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  ensureDatabase,
  hostedDatabase,
  localDatabase,
  postgresPool,
} from "./db.ts";
import { DomainError, workspaceFor, type Context } from "./repository.ts";
import { can } from "../domain/assessment.ts";
async function authOptions() {
  await ensureDatabase();
  const db = hostedDatabase() ? postgresPool() : localDatabase();
  let secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production")
      throw new Error("BETTER_AUTH_SECRET is required in production.");
    const filename = path.join(
      path.dirname(
        process.env.FORESIGHT_DATABASE_PATH ||
          path.join(process.cwd(), ".minetech-data", "foresight.sqlite"),
      ),
      "auth-secret",
    );
    mkdirSync(path.dirname(filename), { recursive: true });
    if (!existsSync(filename))
      writeFileSync(filename, randomBytes(32).toString("base64url"), {
        mode: 0o600,
        flag: "wx",
      });
    secret = readFileSync(filename, "utf8");
  }
  return {
    database: db,
    secret,
    baseURL: process.env.VERCEL
      ? {
          allowedHosts: [
            process.env.VERCEL_URL,
            process.env.VERCEL_BRANCH_URL,
            process.env.VERCEL_PROJECT_PRODUCTION_URL,
            process.env.BETTER_AUTH_URL,
            ...(process.env.FORESIGHT_TRUSTED_ORIGINS?.split(",") || []),
          ].filter((host): host is string => Boolean(host)),
          fallback:
            process.env.BETTER_AUTH_URL ||
            (process.env.VERCEL_URL
              ? `https://${process.env.VERCEL_URL}`
              : undefined),
          protocol: "https" as const,
        }
      : process.env.BETTER_AUTH_URL || "http://localhost:3000",
    ...(hostedDatabase()
      ? {
          user: { modelName: "foresight_user" },
          account: { modelName: "foresight_account" },
          verification: { modelName: "foresight_verification" },
        }
      : {}),
    trustedOrigins:
      process.env.FORESIGHT_TRUSTED_ORIGINS?.split(",").filter(Boolean),
    session: {
      modelName: hostedDatabase() ? "foresight_session" : "session",
      expiresIn: 7 * 86400,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      modelName: hostedDatabase() ? "foresight_rate_limit" : "rateLimit",
      customRules: { "/sign-in/anonymous": { window: 60, max: 30 } },
    },
    plugins: [
      anonymous({
        disableDeleteAnonymousUser: true,
        generateName: () => "Fictional demonstration visitor",
      }),
      nextCookies(),
    ],
  } satisfies BetterAuthOptions;
}
function buildAuth(options: Awaited<ReturnType<typeof authOptions>>) {
  return betterAuth(options);
}
type Auth = ReturnType<typeof buildAuth>;
let ready: Promise<Auth> | undefined;
export function getAuth(): Promise<Auth> {
  ready ||= (async () => {
    const options = await authOptions();
    // Migrations must be serialized across independent Vercel instances.
    const client = hostedDatabase()
      ? await postgresPool().connect()
      : undefined;
    try {
      await client?.query("BEGIN");
      await client?.query(
        "SELECT pg_advisory_xact_lock(hashtext('foresight-auth-v1'))",
      );
      const migrations = await getMigrations(options);
      await migrations.runMigrations();
      if (client) {
        for (const table of [
          "foresight_user",
          "foresight_session",
          "foresight_account",
          "foresight_verification",
          "foresight_rate_limit",
        ]) {
          await client.query(
            `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`,
          );
          await client.query(`REVOKE ALL ON public.${table} FROM PUBLIC`);
          // Supabase's browser roles must never read session tokens or identities.
          for (const role of ["anon", "authenticated"]) {
            const exists = await client.query(
              "SELECT 1 FROM pg_roles WHERE rolname=$1",
              [role],
            );
            if (exists.rowCount)
              await client.query(`REVOKE ALL ON public.${table} FROM ${role}`);
          }
        }
      }
      await client?.query("COMMIT");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      if (client) {
        client.release();
      }
    }
    return buildAuth(options);
  })();
  return ready.catch((error) => {
    ready = undefined;
    throw error;
  });
}
export async function context(
  request: Request,
  operation: "read" | "submit" | "review" | "close" | "admin" = "read",
): Promise<Context> {
  if (
    request.method !== "GET" &&
    request.headers.get("origin") !==
      new URL(request.url).protocol + "//" + request.headers.get("host")
  )
    throw new DomainError(403, "ORIGIN", "Same-origin request required.");
  const auth = await getAuth(),
    session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    throw new DomainError(
      401,
      "SESSION_REQUIRED",
      "Start an isolated demonstration session.",
    );
  const ctx = await workspaceFor(session.user.id);
  const requested = request.headers.get("x-workspace-id");
  if (requested && requested !== ctx.workspaceId)
    throw new DomainError(
      403,
      "WORKSPACE_SCOPE",
      "This session cannot access that workspace.",
    );
  if (!can(ctx.role, operation))
    throw new DomainError(
      403,
      "ROLE_REQUIRED",
      "Your role does not permit this operation.",
    );
  return ctx;
}
