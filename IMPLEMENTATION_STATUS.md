# Foresight implementation status

**Current work:** Foresight MineTech v2 per *Foresight Development Specification 2.0* (16 Nov 2026), on branch `claude/minetech-v2`, created from `codex/atu-foresight-upgrade` at `40a8290` (not `main`). Development and preview only: no production data, live records or production deployment were touched. Messaging is **dry-run**; no SMS or WhatsApp message has been sent to anyone.

Status categories (spec §18): **Implemented and verified** · **Implemented, awaiting environment verification** · **In progress** · **Blocked by a named dependency** · **Not implemented**.

## Phase 0 — assessment and proof tests (2026-11-17)

### Baseline checks at `40a8290` (before any change)

Environment: Linux x86_64 container, Node 22.23.4, Python 3.13.18, PostgreSQL 16 (local throwaway cluster), Chromium 1243 (pre-installed).

| Check | Result at baseline | Note |
| --- | --- | --- |
| `npm ci` | Pass (620 packages) | |
| `npm run typecheck` | Pass | |
| `npm test` (SQLite) | **18 pass, 15 cancelled**, exit 1 | Cause: `AbortSignal.timeout()` in `lib/server/ai.ts` uses an unreferenced timer. In the mocked timeout test nothing else holds Node's event loop, so it drains before the deadline fires and the runner cancels the rest. Reproduced in isolation. Production is unaffected (the HTTP server keeps the loop alive) but the bounded-failure path was not actually exercised. |
| `npm run test:python` | **36 pass** | System Python 3.13 (earlier reports used 3.12) |
| `npm run build` | Pass (Next.js 16.3.4, Turbopack) | |
| `npm run test:postgres` | Pass (1) | Needs a role not named `foresight`: PostgreSQL's default `"$user", public` search path otherwise puts Better Auth tables in the `foresight` schema. Environment note, not a product defect (Supabase uses `postgres`). |
| `npm test` on PostgreSQL 16 | 33 pass (after fix below) | |
| Browser suite (production build, port 3001 + worker 8100) | **6 pass** | Needed `PLAYWRIGHT_CHROMIUM_EXECUTABLE` (new optional config) because the pinned Playwright 1.64.1 expects browser build 1248 and this container has 1243. Tracked screenshots it rewrote were restored. |

**Fix applied:** `lib/server/ai.ts` now uses a referenced timer (`requestDeadline`) cleared in `finally`. After the fix: `npm test` **33/33 pass** on SQLite and **33/33 on PostgreSQL 16**.

### Gap list: spec §3 versus the code at `40a8290`

| §3 claim | Finding |
| --- | --- |
| Five destinations, legacy hash aliases | Confirmed (`app/workspace.tsx`). |
| Legacy WorkSafe workspace "built as preview" | `app/legacy-workspace.tsx` exists but is **not mounted** by any route (`app/page.tsx` renders only `workspace.tsx`). `/api/records` still serves the old Blob-backed register; `scripts/migrate-legacy.ts` already migrates an exported legacy file into scoped records. Foresight Lite there is a simulated outbox only. |
| Zod contracts, `zoneId` fixed enum | Confirmed: `z.enum(["zone-a","zone-b","zone-c"])`, also used by the vision event and report schemas. |
| `development-controls-1` | Confirmed (`assess`, `can`, `validTransition` in `lib/domain/assessment.ts`). |
| Persistence, migrations 001/002 | Confirmed. |
| Water engine `lumped-water-1.0.0` | Confirmed; note `MAX_NODES = 3`, `MAX_PUMPS = 6`. The new mine model must map sumps onto at most three storage nodes per run unless the engine limit is reviewed. |
| Simulation transport | Confirmed. The local worker **bound only to 127.0.0.1**, so it could not serve from a container; now configurable (`FORESIGHT_SIMULATOR_HOST`). The "job callback" is a poll by the web app (`GET /jobs/:id`), not a push. |
| Vision/PPE worker | Present, shown in Evidence. To be hidden behind a flag in Phase 1. |
| GLB viewer | Confirmed. |
| Offline queue | Confirmed. |
| Tests | 33 Node, 36 Python, 1 PostgreSQL auth, 6 browser (counts verified above). |
| Test record "QA response drill 1789405000522" | Not in source or seed data; it exists only in hosted database data. Not touched (no production/preview data changes in this work). |

### Proof tests

| # | Test | Result | Evidence |
| --- | --- | --- | --- |
| 1 | JuPedSim runs 100 agents in a tunnel-shaped polygon on CPU | **Implemented and verified.** 100/100 reached the exit; first exit 114.25 s, last 179.35 s (simulated); 0.6 s wall clock; 1.7 MB SQLite trajectory written | `tools/proofs/proof_jupedsim.py` (seed 42, L-shaped 3 m drift, 180 m path, JuPedSim 1.4.2 CollisionFreeSpeedModel, dt 0.05 s) |
| 2 | Walkable polygons from a 10-junction network; close a tunnel; reroute or count as cut off | **Implemented and verified.** Open: 18/18 out, T100 323.35 s. T2 closed: 18/18 reroute, T100 434.75 s. T2+T3+T10 closed: 4 people in North stope counted *cut off* ("no route … from assumed start"), 14 out, T95/T100 not reached. T4 closes at 10 s with people inside: 4 cut off ("in tunnel T4 when it closed at 10 s"). Accounting balanced in every run | `services/simulator/escape.py`, `network.py`, `test_escape.py` (10 tests), `fixtures/mine/ten-junction.json`, `tools/proofs/proof_network_escape.py` |
| 3 | SMSGate send/receive via API with a mock; allow-listed phone if provided | **In progress → Phase 2 (mock).** Real phone: **Blocked** — no gateway phone, SIM or allow-listed numbers supplied. API shapes taken from the official SMSGate Python client 4.4.0 on PyPI (`POST {base}/messages`, `{phoneNumbers, textMessage:{text}, withDeliveryReport}`, states Pending/Processed/Sent/Delivered/Failed, webhook events `sms:received/sent/delivered/failed`, `system:ping`, health `pass/warn/fail`, devices `lastSeen`). `docs.sms-gate.app` is outside this environment's network policy, so the webhook-signing method could not be read; the spec fallback (secret URL token) will be used | — |
| 4 | WhatsApp Cloud API webhook verification against a test app | **Blocked** — no Meta test app, app secret, verify token or phone number ID supplied; `developers.facebook.com` is also outside this environment's network policy. Webhook verification will be implemented to the contract in Phase 2 and recorded as *awaiting environment verification* | — |
| 5 | Simulation worker runs as a container and reports results through the job path | **Partly verified.** Worker process accepts an authenticated `kind: "escape"` job, is idempotent and workspace-scoped, and returns a completed balanced result through the polling path (`test_worker_escape.py`). Container image: `deploy/simulator.Dockerfile` written but **not built** — this environment has a Docker client but no daemon. Status: *Implemented, awaiting environment verification* | `services/simulator/server.py`, `deploy/simulator.Dockerfile`, `requirements-sim.txt` |

New commands: `npm run setup:sim` (creates `.venv-sim` from pinned `requirements-sim.txt`), `npm run test:sim` (12 tests). JuPedSim 1.4.2 installs PySide6 and VTK as hard dependencies, so the worker image is large; the stdlib water engine still runs without them, and the worker reports which engines it has at `/health`.

---

# Historical status (codex/atu-foresight-upgrade, October 2026)


Branch: `codex/atu-foresight-upgrade`. Baseline: `5c1b21850f9c4ce405bf1bd179acebbc507641de` (clean main, checked 2026-10-17 UTC). Product direction: supplied Foresight Development Specification v1.0. The initial development upgrade did not change production or live records. Hosted work is recorded below; no paid plan upgrade or external notification was made. **This is a working development release, not the complete validated core release.**

## Connected workflow follow-up (2026-10-18)

See [docs/COMPLETION_REPORT.md](docs/COMPLETION_REPORT.md) for the newest verification and remaining external dependencies. Extraction now supports Gateway and existing Gemini settings, video readiness/private uploads/review evidence are connected, mesh provenance/validation/viewer controls are expanded, and a scheduled-failure/route-response exercise is implemented. These changes have not been deployed by this follow-up. Earlier counts below are historical.

## Hosted persistence follow-up (2026-10-18)

Implemented a pooled PostgreSQL adapter for Supabase/Neon, private domain schema, Better Auth PostgreSQL sessions with Data API restrictions, cross-instance transaction/idempotency/budget locks, hosted readiness errors, direct private GLB uploads, and bounded Vercel Python compute with persisted leases/cancellation/retry. Configured Vercel session and worker secrets. **Supabase is connected. Hosted health/authentication, three browser workflows, fresh Python simulations and a private upload larger than 4.5 MB pass.** Full instructions and current evidence: [docs/HOSTED_SETUP.md](docs/HOSTED_SETUP.md).

Verification now includes 28 Node tests on both SQLite and PostgreSQL 17, one real hosted-mode PostgreSQL auth/session/RLS test, 34 Python tests, and five production-build browser tests against PostgreSQL. The historical verification counts below describe the initial upgrade. Real PPE weights, captured reconstruction, private-site onboarding and independent evaluation remain outstanding.

## Dependency ordered implementation and milestone exits

1. Domain/migration foundation: implemented typed contracts, SQLite transactions/migrations, scoped entity links, append-only audits, session-isolated fictional workspaces and five destinations. Copy-migration/role/isolation tests pass. Hosted PostgreSQL code is implemented and tested locally; private-site provisioning and independent operational acceptance remain outstanding; milestone is partial against the full deployment scope.
2. Evidence/assessment: implemented persisted reports, real configurable SDK extraction/explanation adapters, editable source spans, human acceptance, corrections and immutable assessment versions. Manual complete flow and SDK failure tests pass. Registered worker names/IDs, email and labelled/international phone contacts are masked before outbound model requests; this is not comprehensive free-text PII detection. Live provider quality and independently reviewed text acceptance are pending.
3. Water/routes: implemented pure Python conservation engine, persistent asynchronous service, cancellation/restart-safe job records, comparison/playback, explicit geometry/flow/pump/route assumptions, seeded sensitivity and calibration comparison CLI. W01–W05, numerical/route/transport tests and constructed analytic evaluation pass. Physical model calibration and engineering review remain external.
4. Vision: implemented ONNX CPU adapter, decode/preprocess/NMS/tracking/association/quality/policy stages, minimal evidence, scoped ingestion, review and linked observations. Policy tests and input-dependent ONNX/decoded-clip plumbing pass. No approved pretrained PPE weights or source clips have been supplied; the actual PPE milestone exit is **not met**.
5. Spatial/response/offline: implemented conceptual 2D map, calculated lab route overlay, lazy GLB2 viewer/import, cases/actions/verification, assignment intervals, frozen muster and IndexedDB queue. Browser workflows and synthetic GLB-format tests verify software plumbing. Actual captured reconstruction, metric registration and calibrated 3D annotation remain outstanding.
6. Independent evaluation/demonstration: numerical verification, browser screenshots and evaluation harnesses supplied. Independent text/vision labels, representative clips, predetermined accuracy thresholds and practitioner/institutional evidence are unavailable. Milestone exit is **not met**.

## Core requirement ledger

| ID | Implementation location and actual status | Verification evidence | Outstanding dependency / limit |
| --- | --- | --- | --- |
| CORE01 | `app/workspace.tsx`, `components/foresight/*`, `app/upgrade.css`: five destinations, shared site/zone/Harare time, contextual review, legacy hash aliases, secondary records/settings | Browser desktop, 390px phone and 1024px tablet flows; screenshots in `docs/screenshots`; automated scan in `docs/browser-verification.json` | Full screen-reader/touch review; private account/workspace administration |
| CORE02 | `lib/domain/contracts.ts`, `assessment.ts`, `lib/server/ai.ts`, `workflows.ts`, Evidence/Command components: persisted originals, SDK structured output, UTF-16 spans, negation/uncertainty/proposals/unknown dates, manual correction/acceptance, append-only corrections and fresh assessments | Domain tests: source validation, critical single observation, stale controls, provider failures, immutable history, correction relationships; browser report → manual review → assessment → case | Real configured provider/model; 100 independent reviewed examples; factual entailment evaluation. Current deterministic condition classifier is an explicitly limited development keyword policy |
| CORE03 | `services/vision/{model,policy,worker,server}.py`, `lib/server/vision.ts`, `/api/vision/*`, Evidence Vision tab: CPU tensor inference adapter; local tracks; helmet/vest body association; explicit negative evidence; image-region entry; scoped review/frames; reviewed events derive assessments | Eight policy tests; decoded synthetic clip through input-dependent mathematical ONNX graph; callback scope/idempotency tests; no real PPE results claimed | Approved pretrained person/helmet/vest weights and licence chain; ≥12 consented/licensed source clips, independent labels, real camera, hardware throughput and capture-to-alert latency. Mathematical smoke is **not PPE inference acceptance** |
| CORE04 | `services/simulator/engine.py`, `server.py`, `ensemble.py`, `calibration.py`, `lib/domain/scenario.ts`, Simulator component: deterministic SI water balance, geometry inversion, events/hysteresis/transfers/overflow, durable jobs, cancel/retry, comparisons/playback, assumption envelopes and CLI reading residuals | W01–W05 + edge cases, convergence/conservation, 30 frozen analytic parameter sets (20 dev / 10 locked), job transport/cancel/restart and browser fresh-input comparison. `docs/numerical-evaluation.json` | Site measurements and validated pump curves are not supplied; constant effective capacities only; no pressure/backwater/groundwater model. Interactive GUI runs do not automatically perform convergence; evaluation does |
| CORE05 | `services/simulator/engine.py::routes`, scenario graph/movement contracts, Map/Simulator: explicit restrictions and calculated water intervals, full-traversal checks, multiple starting assumptions and no-path output | Tests for mid-journey closure, alternative route, unknown starting set, water restriction and blocked/no-path cases | Fictional checked graph, assumed speeds/response delays; no measured live positions, queue/congestion or site-reviewed access policy. Search is bounded, conservative, with no waiting |
| CORE06 | Mine Map/Reconstruction components, `lib/server/assets.ts`, `tools/reconstruction`: versioned conceptual layout, zone markers, mapped cameras/pumps/muster, saved laboratory route/level overlay; private GLB2 import with provenance and scale metadata | Browser map/overlay; actual header/format rejection and generated triangle GLB import/download/viewer plumbing. Test shape is clearly labelled synthetic and is not a reconstruction | No real captured area, measured registration or residuals. Gaussian splat viewer and calibrated 3D annotations not implemented. Offline Nerfstudio/COLMAP guidance has not run here |
| CORE07 | People/Command/Evidence components, `workflows.ts`: owner/due dates, constrained case lifecycle, completed actions distinct from verified closure, reopen reasons, assignment intervals, frozen roster and human confirmations, scoped exports | Browser case/action/muster; domain stale-revision, roster, closure gating and role tests; readable/JSON export routes | Private staff authentication/provisioning and qualified response-policy review; no real notifications or location tracking |
| CORE08 | `migrations/001-workspaces.sql`, `lib/server/{db,repository,auth,http,migrate}.ts`, Better Auth routes, IndexedDB queue + `public/sw.js`: persistent local transactions/audit, role/scope checks, bounded requests/budgets, idempotency, draft/conflict preservation and public-shell offline caching | Domain atomic rollback/idempotency/migration; actual browser stored-role denial, workspace isolation, offline report reload/sync; worker callback validation; production build | Hosted PostgreSQL and private Blob paths are implemented; private account lifecycle and operational deployment review remain required. Old Blob not migrated remotely. Offline restoration is tested in production build; Next dev HMR is unreliable offline. Queue conflict editor remains a basic development interface |
| CORE09 | `fixtures/evaluation`, `tools/evaluation`, numerical and browser reports, `docs/MODEL_PROVENANCE.md`, evaluation panel in Lab | 30 numerical cases pass; 100 constructed text review candidates grouped by family (60 dev / 40 locked); clip-level vision scorer and empty source manifest; explicit failure/unavailable states | Zero independently reviewed text labels or vision clips supplied; no trained-PPE accuracy measurements; no owner-approved product accuracy thresholds. Constructed numerical tests do not establish field validation |

## Acceptance evidence

| ID | State | Evidence and limitation |
| --- | --- | --- |
| A01 | Partial | Schema/spans, missing time, negation/proposals/corrections and SDK structured parsing tested. Paraphrase/location/time generalisation on independent provider outputs remains untested |
| A02 | Software checks pass | Missing key preserves report; actual installed SDK mock model tests rate-limit, timeout, malformed structured output and invalid source/citation handling. Real upstream service behaviour not exercised |
| A03 | Pass (development) | Two accepted reports create separate immutable assessment versions; original version remains unchanged |
| A04 | Pass (development policy) | Serious individual observation reaches urgent review; water/pump correlation never gates that direct path. Unvalidated policy is disclosed |
| A05 | Unmet | No approved PPE weights/independent video set. Mathematical graph smoke is explicitly excluded |
| A06 | Partial | Policy tests cover darkness, overlap, clipping, track expiry and feed loss; no independent video quality metrics |
| A07 | Software checks pass | Persistent candidate confirmation/dedup, inadequate-quality suspension, boundary jitter and genuine reentry unit tests. Source-clip validation pending |
| A08 | Pass (software arithmetic) | W01–W05, inversion, empty storage, transfers, hysteresis, simultaneous events, geometry/unit rejection, conservation and finer-step checks |
| A09 | Pass (fictional graph) | Whole-journey availability, no path, alternative route, water thresholds and uncertain starting set tests |
| A10 | Pass (development) | Browser snapshots observation/assessment/worker/case/muster rows before and after lab runs and asserts equality; laboratory writes only create snapshot/scenario/run records |
| A11 | Pass (software) | Same input/engine/seed produces equal series and hash; a changed seed changes content hash; job duplicate submission/restart preserves result |
| A12 | Pass for report queue; check-in path implemented | Production browser network loss → queued report → reload → reconnect → one server record. Worker-status/inspection queue contracts also use revision/idempotency checks; broader conflict UX testing remains |
| A13 | Pass for delivered endpoints | Cross-workspace records denied; actual persisted viewer role cannot close/write; callback bad credentials/workspace/camera rejected; source/upload limits. Private account onboarding absent |
| A14 | Partial | Keyboard modal traversal/Escape, labelled fields, touch-sized main controls, textual map/route/chart alternatives and automated five-view scan. No full manual screen-reader audit or conformance claim |
| A15 | Pass on copies | Sample legacy record/audit payloads, IDs/references and source hash survive an idempotent migration; backup/source unchanged and isolated. Actual live Blob export has not been accessed |

## Verification commands and measured limits

- `npm ci` and added dependencies installed successfully; existing Next.js **16.3.4**, React **19.2.6**, TypeScript **5.9.3** retained. New SDK APIs checked in installed docs (AI SDK **7.0.143**, Better Auth **1.7.10**).
- `npm run typecheck` and `npm run build` pass. No framework rewrite or Expo/production binding change.
- `npm test`: **21 tests pass** (13 new domain/SDK/workflow tests + 8 preserved legacy tests). Legacy prepared tests do not count as live AI quality evidence.
- `npm run test:python`: **31 tests pass** (water/routes, sensitivity, authenticated job transport/restart/cancel, quality/event policy).
- `npm run test:vision-runtime`: **1 mathematical ONNX/decoded-video smoke passes**, using separate documented dev dependencies; no pretrained model or private cache required.
- `npm run evaluate:numerical`: **30/30** constructed fixed parameter sets pass analytic arithmetic/conservation/convergence; no independent engineering validation. On Linux x86_64 / Python 3.12.14, 24h / 3 nodes / 6 pumps was **82.826 ms**, relative mass residual **2.78e-13** in the recorded evaluation.
- `PREVIEW_URL=http://localhost:3001 npm run test:browser`: workflow, role/scope/asset, offline and responsive tests; screenshots under `docs/screenshots`. Final run: **5 browser tests pass**, including keyboard traversal/Escape and generated GLB validation.
- `node scripts/verify-browser.mjs`: initial reporting JS transfer measured about **161 KiB gzip** versus predeclared **350 KiB** budget, excluding lazy 3D; exact current result in `docs/browser-verification.json`. Automated scan initially found text contrast and nested map interaction issues; these were corrected; final scans report **zero violations in all five views**. Manual conformance is still outstanding.
- `npm run contracts` exports shared versioned schemas. `git diff --check` passes.

## External resources and unresolved product work

No provider key/model, real PPE weights, consented footage/feed, reconstruction, measured survey/flow/pump data or independently reviewed text/vision labels were available. One public candidate weight card declared Apache-2.0 over an Ultralytics base; the licence chain remains unresolved, so no weights were downloaded/distributed. No accuracy thresholds were invented. The evaluation candidates identify Codex authorship and missing human review.

Private-site member administration, TLS/credential rotation, scheduled retention for continuously running vision workers, full accessibility review and site-specific engineering acceptance are still needed. Optional higher-detail ventilation/geotechnical/gas/blasting solvers are not active. No claim of mine-failure prediction, accident prevention percentage, institutional endorsement or operational pilot is made.

## Review and preview

A working local production-build preview runs at `http://localhost:3001` with a separate local simulator at port 8100. It can be reproduced from the README. The Supabase-backed preview at `https://foresight-minetech-i15za2g43-hjm-technologies.vercel.app` passes hosted acceptance checks described in `docs/HOSTED_SETUP.md`. Source changes remain on the isolated upgrade branch; the default branch is unchanged. Production releases are managed explicitly in Vercel. See the draft review request when published for the concrete diff.
