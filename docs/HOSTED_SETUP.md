# PostgreSQL and Vercel deployment

The hosted workspace uses PostgreSQL (Supabase or Neon) and Better Auth. It never writes its database, sessions or uploaded evidence to Vercel's temporary filesystem. SQLite remains available for local development.

## Connect the database

1. In the `hjm-technologies/foresight-minetech` Vercel project's **Storage** tab, create a Supabase resource on the **Free** plan and connect it to Preview and Production. The existing team already has the Supabase integration installed. No additional authentication provider is needed.
2. Verify that the integration has supplied a server-only **`DATABASE_URL`** or **`POSTGRES_URL`**. Use the Supabase **transaction-pooler** URI (normally port 6543). If the integration supplies only API keys, copy the PostgreSQL transaction-pooler URI from Supabase's **Connect** dialog directly into a Vercel environment variable named `DATABASE_URL` for Preview and Production. Preserve SSL verification. Do not send credentials in chat or commit them.
3. `NEXT_PUBLIC_SUPABASE_URL` and a publishable/anonymous API key alone are insufficient: this backend uses parameterized SQL transactions, not browser access to the Supabase Data API.
4. Configure `BETTER_AUTH_SECRET` (a private random value of at least 32 bytes) in Preview and Production, `BETTER_AUTH_URL=https://foresight-minetech.vercel.app` in Production, and a private `FORESIGHT_WORKER_TOKEN` (at least 32 characters) in both environments. The session secret, production URL and simulation token were configured in this session; their values are never published.
5. Leave `FORESIGHT_SIMULATOR_URL` unset on Vercel to use the bundled Python function. Keep `BLOB_READ_WRITE_TOKEN` connected to the existing **private** `foresight-minetech-records` Blob store. New assets use `evidence/<workspace-id>/...`; historical record objects are not migrated or overwritten.
6. Deploy the upgrade branch as a preview. Check `/api/health`, then verify an actual session and saved report before promotion. A successful frontend build alone is not a release check.

Supabase creation/connection is a dashboard step because the connected Vercel tool surface cannot provision integration resources and the workspace CLI is logged out. Database creation has **not** been claimed complete until the resource is connected and verified.

## Migrations and access

`migrations/002-postgres.sql` creates domain tables in the private `foresight` schema, including scoped foreign keys, revision checks, usage counters, idempotency responses and append-only audits. Better Auth maintains its own `public.foresight_*` identity/session tables. Row level security is enabled and public/anonymous/authenticated Data API access is revoked on those tables. Browser clients only call authenticated Next routes; no PostgreSQL password or service key is bundled into browser JavaScript.

Migrations run once per process at startup, serialized with PostgreSQL transaction advisory locks across instances. They create new Foresight tables without dropping existing data. Deployment/runtime credentials need DDL rights for this bootstrap. To explicitly check the same migration before deployment, pull your linked Vercel env locally into an ignored `.env.local`, then run:

```sh
npm run db:migrate
```

The script prints status only, never credentials. Production requires the session secret; local development can generate an ignored local secret. The migration does not import old visitor data or convert local SQLite sessions. Public demonstrations continue to receive isolated fictional workspaces; private staff enrollment/account administration remains separate product work.

## Simulations on Vercel

`api/simulation.py` runs the existing Python numerical engine without local job files. The Next route saves a queued run, schedules bounded compute with `after()`, and commits results to PostgreSQL. A database lease prevents duplicate dispatch. Interrupted leases become retryable; this is bounded compute with explicit recovery, not an exactly-once durable workflow service. Each compute request has a 120-second calculation budget and a 4 MiB response budget. No numerical result is replaced with a prepared answer.

A cancellation is persisted immediately and late results are discarded. It does not forcibly terminate CPU work already running in another function; that work stops at its time budget. An external persistent simulator can still be selected with `FORESIGHT_SIMULATOR_URL` and the shared worker token.

## Private binary evidence

The map imports self-contained GLB meshes up to 20 MiB using browser-to-private-Blob uploads, avoiding Vercel's 4.5 MB request limit. Token issuance authenticates the session, checks the workspace path, restricts content type/size/expiry, prevents overwrite and consumes a daily budget. Finalization downloads and validates the GLB container/mesh, records its hash/provenance in PostgreSQL, and exposes it through a workspace-scoped streaming route. A storage path alone does not grant read access.

Incomplete direct uploads can remain unreferenced and need an eventual retention/cleanup policy. No existing objects are bulk-deleted. Local development retains file-backed imports.

The optional vision service still needs approved model weights and a hosted CPU worker. Large MP4 uploads need a corresponding direct-storage/worker ingest path; the existing 50 MB local upload path is not a claim of working 50 MB Vercel uploads. AI extraction requires configured model/provider variables. These are not prerequisites for manual evidence review or water simulations.

## Verification performed

- `npm run typecheck`, `npm run build`, and `git diff --check`.
- `npm test`: 28 checks on local SQLite and the same 28 on PostgreSQL 17, including parallel workspace startup, duplicate submissions, revision races, budget races, transaction rollback and simulation leases/cancellation.
- `FORESIGHT_TEST_DATABASE_URL=<isolated-test-uri> npm run test:postgres`: real Better Auth PostgreSQL migration, preview-origin session creation, session persistence, tenant isolation and identity-table RLS.
- `npm run test:python`: 34 numerical, worker, serverless compute and vision policy checks.
- Five browser tests on a production Next build with PostgreSQL 17: evidence → review → assessment → case/action → human muster → fresh water comparisons, plus role denial, asset validation, session isolation, offline reload/sync and phone/tablet layouts.

Local PostgreSQL verification is not proof of connectivity to an unprovisioned Supabase resource. Hosted sign-in, private Blob uploads and Python compute must be tested against the connected preview before changing production.
