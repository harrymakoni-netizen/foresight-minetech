import { betterAuth, type BetterAuthOptions } from "better-auth";
import { anonymous } from "better-auth/plugins/anonymous";
import { nextCookies } from "better-auth/next-js";
import { getMigrations } from "better-auth/db/migration";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { database } from "./db.ts";
import { DomainError, workspaceFor, type Context } from "./repository.ts";
import { can } from "../domain/assessment.ts";
function authOptions() {
  const db = database();
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
    baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
    trustedOrigins:
      process.env.FORESIGHT_TRUSTED_ORIGINS?.split(",").filter(Boolean),
    session: { expiresIn: 7 * 86400 },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
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
function buildAuth(options: ReturnType<typeof authOptions>) {
  return betterAuth(options);
}
type Auth = ReturnType<typeof buildAuth>;
let ready: Promise<Auth> | undefined;
export function getAuth(): Promise<Auth> {
  ready ||= (async () => {
    const options = authOptions();
    const migrations = await getMigrations(options);
    await migrations.runMigrations();
    return buildAuth(options);
  })();
  return ready;
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
  const ctx = workspaceFor(session.user.id);
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
