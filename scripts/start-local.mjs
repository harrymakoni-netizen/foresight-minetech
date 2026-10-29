import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
if (process.env.VERCEL)
  throw new Error(
    "Local preview helper cannot run on Vercel. Configure hosted credentials explicitly.",
  );
mkdirSync(".minetech-data", { recursive: true });
const secretPath = ".minetech-data/preview-auth-secret";
if (!existsSync(secretPath))
  writeFileSync(secretPath, randomBytes(32).toString("base64url"), {
    mode: 0o600,
    flag: "wx",
  });
const port = process.env.PORT || "3001";
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "0.0.0.0",
    "--port",
    port,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET || readFileSync(secretPath, "utf8"),
      BETTER_AUTH_URL:
        process.env.BETTER_AUTH_URL || `http://localhost:${port}`,
      FORESIGHT_SIMULATOR_URL:
        process.env.FORESIGHT_SIMULATOR_URL || "http://127.0.0.1:8100",
      FORESIGHT_WORKER_TOKEN:
        process.env.FORESIGHT_WORKER_TOKEN || "development-worker-token",
    },
  },
);
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => process.exit(code || 0));
