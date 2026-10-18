export class ConfigurationError extends Error {
  readonly status = 503;
  readonly code = "WORKSPACE_NOT_CONFIGURED";
}
export function workspaceConfiguration() {
  const missing: string[] = [];
  if (
    process.env.VERCEL &&
    !process.env.DATABASE_URL &&
    !process.env.POSTGRES_URL
  )
    missing.push("DATABASE_URL");
  if (process.env.NODE_ENV === "production" && !process.env.BETTER_AUTH_SECRET)
    missing.push("BETTER_AUTH_SECRET");
  return missing;
}
export function assertWorkspaceConfigured() {
  const missing = workspaceConfiguration();
  if (missing.length)
    throw new ConfigurationError(
      missing.includes("DATABASE_URL")
        ? "This deployment is waiting for its hosted database connection. The project owner must connect PostgreSQL and redeploy."
        : "This deployment is waiting for its authentication configuration. The project owner must configure the session secret and redeploy.",
    );
}
