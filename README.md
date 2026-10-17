# Foresight MineTech development upgrade

Five-section mine safety evidence and scenario-planning application, built in the existing Next.js repository. The working local release includes reviewed reports, immutable assessments, cases/actions, human muster, a fresh Python water/route simulator, saved comparisons, sensitivity jobs and an IndexedDB submission queue. The layout is fictional. No result clears a zone, controls equipment or delivers an external notification.

**Start with [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)** for requirement-by-requirement evidence and unmet acceptance criteria. Real AI quality, independently evaluated helmet/vest recognition, a captured reconstruction, private-site onboarding and field validation are not complete. Missing services are labelled unavailable; manual reporting and local numerical runs remain usable.

## Reproduce locally

Requirements: Node **24** (tested 24.19.0), npm, Python **3.12** (tested 3.12.14), a persistent writable local disk. SQLite is a development adapter, not a multi-instance serverless database. No database/model purchase is required.

```sh
npm ci
npm run worker:simulator
```

In a second terminal:

```sh
npm run dev
```

Open `http://localhost:3000`. Better Auth creates a separate fictional supervisor session per browser. Server-side sessions, workspace scope and persisted roles govern all new writes. No shared public authentication bypass is retained. Local development generates an ignored random session secret; production requires explicit secret configuration. Demo workspaces expire after seven days. A fresh session creates a new fixture without deleting old records.

For the tested offline shell and production-build preview:

```sh
npm run build
npm run preview
```

Open `http://localhost:3001`. The preview helper generates an ignored local secret and uses the local worker. This is a local preview, not a production deployment. The same Python worker must remain running. Next's development HMR runtime does not reliably restore the app offline; use the production build for the reload/sync workflow. The shell caches public application assets only; APIs and private evidence are never service-worker cached. IndexedDB drafts are workspace-scoped. Queue states remain pending/synced/rejected/conflict, and rejected content is preserved for review.

For another origin or worker host, copy `.env.example` to an ignored local configuration and set exact URLs/tokens. The Next app loads `.env.local`; Python workers require the matching values in their process environment. The local-only default worker token is development convenience. Set a strong common token for any remotely reachable worker. Never put credentials in browser-prefixed variables or committed files.

## Optional real extraction

Set server-side `AI_GATEWAY_API_KEY` and `FORESIGHT_AI_MODEL`, selecting a currently available structured-output text model from the provider's live catalog, then restart Next. No model ID is guessed by this repository. Missing configuration and upstream errors preserve reports and allow manual fact review. Requests contain only permitted fictional report text and known zone/asset identifiers; never enter real personal information in this public development edition. Source offsets, negation, proposed actions and unknown dates are reviewed before observations are accepted.

Prepared legacy answers remain test fixtures. The primary interface uses assessment-specific explanation requests; no general chatbot page or live-response claim is retained. Exact contracts and error behaviour: [docs/API.md](docs/API.md).

## Optional actual vision worker

```sh
python -m venv .venv
.venv/bin/pip install -r services/vision/requirements.lock.txt
```

Supply an appropriately licensed **person + helmet + vest** ONNX model and a real manifest matching `services/vision/model-manifest.example.json`. Record exact class IDs, explicit negative labels if supported, checksum, source, reviewed weights/export licences, resolution and output format. The example is not runnable. No external model or footage is bundled or downloaded implicitly.

Set `FORESIGHT_VISION_MANIFEST` to that manifest path, `FORESIGHT_VISION_URL=http://127.0.0.1:8200` in Next, and matching `FORESIGHT_WORKER_TOKEN`/`FORESIGHT_INGEST_URL` in the worker environment:

```sh
npm run worker:vision
```

Evidence → Vision accepts MP4 clips up to 50 MB, 120 seconds, 3840×2160 and a capture-metadata start time. It calls a separate persistent CPU worker. Processing progress, retained blurred frames and event reviews are scoped to the submitting workspace. Configure a zone-mapped image region for restricted-entry testing; image coordinates are not metres. Raw uploaded clips are deleted after processing. Retained frames have a seven-day cleanup policy (startup cleanup; scheduled purge is still needed for long-lived hosted workers). Approximate face-region blurring is not guaranteed anonymisation.

For one operator-configured stream, set `FORESIGHT_CAMERA_FEEDS_FILE` to an operator-owned JSON file such as `{"training-camera":{"url":"rtsp://..."}}`, and set `FORESIGHT_CAMERA_FEED_ALIAS=training-camera` in Next. Credentials stay in worker configuration. The browser cannot supply fetch/stream URLs. Feed jobs are bounded to 120 seconds with open/read timeouts. Hardware capture time is unverified; the live path uses a monotonic processing clock and does not claim measured capture-to-alert latency. No actual live feed was supplied or tested.

A missing helmet/vest box alone yields **cannot assess**. Explicit negative class evidence and adequate visible body regions are needed for a potential-missing event. Occlusion, low light, clipping and overlap reduce coverage. PPE event defaults are three valid samples spanning one second; entry uses a separate transition policy. No facial recognition or automatic worker identity association exists.

## Numerical behaviour

`services/simulator/engine.py` imports with only the Python standard library. The simulator runs SI water conservation over up to three nodes and six effective pumps, with scheduled events, geometry inversion, hysteresis, directed transfers, explicit overflow and whole-journey route restrictions. `contracts/scenario-1.0.schema.json` describes the versioned interchange. The engine independently validates geometry, references, provenance and compute budgets. Scheduled changes apply from their instant onward; simultaneous events use input array order.

A snapshot freezes accepted evidence and worker assumptions. The builder does not infer flow/geometry from qualitative text or silently treat unknown measurements as zero. Physical builder defaults are explicitly fictional assumptions. Saved runs retain scenario inputs, seed, model version, hash, diagnostics and results. Editing a parameter makes the displayed result outdated. Playback reads the saved series. Sensitivity envelopes are seeded ranges of assumptions, not calibrated probabilities.

```sh
npm run evaluate:numerical
python -m services.simulator.engine < scenario.json > result.json
python -m services.simulator.calibration scenario.json result.json readings.csv
```

Calibration CSV columns are shown in `fixtures/calibration.example.csv`; that file contains constructed readings only. The importer compares residuals and missing intervals, without tuning or using future observations to reconstruct past snapshots. Numerical approximation limits are in [docs/MODEL_PROVENANCE.md](docs/MODEL_PROVENANCE.md).

## Verification

```sh
npm run typecheck
npm test
npm run test:python
npm run contracts
npm run evaluate:numerical
npm run build
npx playwright install chromium
# Start the simulator and npm run preview first:
PREVIEW_URL=http://localhost:3001 npm run test:browser
```

The Python numerical/policy/transport suites need no GPU, camera or provider. The extra ONNX plumbing smoke test requires the separately listed dev dependencies:

```sh
.venv/bin/pip install -r services/vision/requirements-dev.txt
npm run test:vision-runtime
```

That smoke test decodes synthetic video through an **input-dependent mathematical ONNX graph**, not a trained PPE model. It verifies adapter plumbing and must not be counted as PPE accuracy evidence. Independent vision acceptance still requires approved weights and ≥12 licensed/consented source clips with reviewed labels. The 100 constructed text candidates also require independent label review and configured-provider evaluation. Accuracy release targets remain unset pending owner/qualified-reviewer approval. Numerical software tolerances are predeclared verification criteria, not engineering acceptance thresholds.

Browser tests create isolated fictional data; they cover report/provider failure/manual review, assessment/case/muster, fresh water comparisons, old bookmarks, workspace isolation, duplicate submissions, offline reload/sync and narrow layouts. Screenshots are in [docs/screenshots](docs/screenshots). Accessibility scan results and manual-check limits are documented in the implementation ledger; an automated scan does not establish WCAG conformance.

## Persistence and safe migration

The application store defaults to `.minetech-data/foresight.sqlite`, with WAL, versioned SQL migrations, foreign-key-scoped links, optimistic revisions and append-only audit triggers. The simulator has a separate persistent `.minetech-data/simulator-jobs.sqlite`; vision jobs/evidence default to `.minetech-data/vision`. Keep these files and their WAL/SHM files together when backing up a running development environment, or stop writers and use SQLite's backup interface. Do not copy a live SQLite main file alone as a consistent backup.

Original local `workspace.json`, Blob code, Expo artifacts, historical replay JSON and the unvalidated legacy register are preserved. No hosted record was read, reset or modified during this upgrade. Export a legacy document yourself and migrate a **copy**:

```sh
npm run migrate:legacy -- /path/to/exported-legacy.json
```

The tool backs up the source, hashes it, imports full original records/audit references into a separate `legacy` workspace and is idempotent. It never deletes the input or grants public membership to historical records. Existing shared fictional actors remain unverified. New public sessions cannot read legacy or other visitors' records. The old record API has no unauthenticated writes; consumers migrate to the scoped API. Original prepared assistant POST returns 410.

## Spatial and hosting dependencies

Mine Map uses versioned conceptual zones and checked fictional route topology. A self-contained GLB2 mesh can be imported with source/capture permission and transform metadata, initially as an unscaled walkthrough. No reconstruction is fabricated. A real captured area, independently measured registration, calibrated 3D annotation and a Gaussian-splat viewer remain outstanding. See [tools/reconstruction/README.md](tools/reconstruction/README.md).

Hosted expansion requires a transactional database adapter with persistent shared storage, configured identity/membership provisioning, private binary storage and separate persistent CPU workers; it must not use ephemeral Vercel disk as durable persistence. The app refuses unconfigured hosted SQLite. TLS, worker credential rotation, scheduled retention and operational controls need a deployment review. No production deployment, paid resource or external SMS/USSD/emergency integration is part of this branch.
