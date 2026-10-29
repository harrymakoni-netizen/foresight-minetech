import {
  ensureDatabase,
  hostedDatabase,
  closeDatabase,
} from "../lib/server/db.ts";
import { getAuth } from "../lib/server/auth.ts";
try {
  await ensureDatabase();
  await getAuth();
  console.log(
    JSON.stringify({
      status: "ready",
      database: hostedDatabase() ? "postgresql" : "local-sqlite",
      domainMigration: "applied",
      authenticationMigration: "applied",
    }),
  );
} finally {
  await closeDatabase();
}
