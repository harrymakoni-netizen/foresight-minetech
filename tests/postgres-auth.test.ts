import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
if (!process.env.FORESIGHT_TEST_DATABASE_URL)
  throw new Error(
    "Set FORESIGHT_TEST_DATABASE_URL to an isolated PostgreSQL test database.",
  );
process.env.DATABASE_URL = process.env.FORESIGHT_TEST_DATABASE_URL;
process.env.BETTER_AUTH_SECRET = randomBytes(48).toString("base64url");
process.env.VERCEL = "1";
process.env.VERCEL_URL = "foresight-auth-test.invalid";
delete process.env.BETTER_AUTH_URL;
const { getAuth, context } = await import("../lib/server/auth.ts");
const { query, closeDatabase } = await import("../lib/server/db.ts");
const base = "https://foresight-auth-test.invalid";
const headers = {
  Origin: base,
  Host: new URL(base).host,
  "Content-Type": "application/json",
  "X-Forwarded-For": "192.0.2.10",
};
test("hosted preview infers its origin and persists authenticated isolated sessions in PostgreSQL", async () => {
  const auth = await getAuth();
  const signIn = await auth.handler(
    new Request(base + "/api/auth/sign-in/anonymous", {
      method: "POST",
      headers,
      body: "{}",
    }),
  );
  assert.equal(signIn.status, 200);
  const first = await signIn.json();
  assert.ok(first.user.id);
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert.ok(cookie.includes("session_token"));
  const request = new Request(base + "/api/workspace/state", {
    headers: { ...headers, Cookie: cookie },
  });
  const a = await context(request),
    b = await context(request);
  assert.equal(a.workspaceId, b.workspaceId);
  assert.equal(a.userId, first.user.id);
  const outsider = await auth.handler(
    new Request(base + "/api/auth/sign-in/anonymous", {
      method: "POST",
      headers: { ...headers, "X-Forwarded-For": "192.0.2.11" },
      body: "{}",
    }),
  );
  const otherCookie = outsider.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const other = await context(
    new Request(base + "/api/workspace/state", {
      headers: { ...headers, Cookie: otherCookie },
    }),
  );
  assert.notEqual(a.workspaceId, other.workspaceId);
  const { rows } = await query(
    'SELECT id FROM public.foresight_session WHERE "userId"=$1',
    [first.user.id],
  );
  assert.equal(rows.length, 1);
  const protectedTables = await query(
    "SELECT relname,relrowsecurity FROM pg_class WHERE relname IN ('foresight_user','foresight_session','foresight_account','foresight_verification','foresight_rate_limit')",
  );
  assert.equal(protectedTables.rows.length, 5);
  assert.ok(protectedTables.rows.every((row) => row.relrowsecurity));
});
after(async () => {
  await closeDatabase();
});
