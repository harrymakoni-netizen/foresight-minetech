import type { NextConfig } from "next";
const config: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  outputFileTracingIncludes: {
    "/api/**": ["./migrations/*.sql", "./certificates/*.crt"],
    "/api/workspace/*": [
      "./migrations/*.sql",
      "./docs/numerical-evaluation.json",
    ],
    "/api/auth/*": ["./migrations/*.sql"],
  },
};
export default config;
