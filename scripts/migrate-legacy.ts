import { migrateLegacy } from "../lib/server/migrate.ts";
if (!process.argv[2])
  throw new Error(
    "Usage: npm run migrate:legacy -- /path/to/exported-legacy.json",
  );
console.log(JSON.stringify(migrateLegacy(process.argv[2]), null, 2));
