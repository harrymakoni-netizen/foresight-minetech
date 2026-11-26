# Foresight implementation status

**Current work:** Foresight MineTech v2 per *Foresight Development Specification 2.0* (16 Nov 2026), on branch `claude/minetech-v2`, created from `codex/atu-foresight-upgrade` at `40a8290` (not `main`). Development and preview only: no production data, live records or production deployment were touched. Messaging is **dry-run**; no SMS or WhatsApp message has been sent to anyone.

Status categories (spec §18): **Implemented and verified** · **Implemented, awaiting environment verification** · **In progress** · **Blocked by a named dependency** · **Not implemented**.

## At a glance (2026-11-17)

Phases 0–5 (the competition build) are implemented on `claude/minetech-v2`. Phases 6–11 are **not implemented** yet.

**Blocked by named dependencies (owner action needed):**
1. Real SMS: an Android phone with an Econet/NetOne SIM running SMSGate, its credentials, and the consenting test numbers for `MESSAGING_TEST_NUMBERS`.
2. Real WhatsApp: a Meta WhatsApp Business test app (app secret, verify token, access token, phone number ID, Graph API version) and approved templates for reminders/alerts. Meta's documentation host and SMSGate's documentation site are outside this build environment's network policy, so field shapes were taken from the official SMSGate client and the published WhatsApp API as known; both await verification with real credentials.
3. Containers: Dockerfiles and `docker-compose.yml` are written but were not built (no Docker daemon in the build environment).
4. Hosting the always-on simulation worker and messaging service (spec §22 open decision), plus an uptime monitor on `/api/messaging/health`.
5. Hosted preview data still contains the test record "QA response drill 1789405000522"; this work does not modify hosted data.

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

## Phase 1 — clean base (2026-11-17)

| Item | Status | Where / evidence |
| --- | --- | --- |
| Four sections (Underground now, Mine, Scenarios, Records) with legacy hash aliases (`#overview`, `#map`, `#evidence`, `#people`, `#simulator`, `#workers`, `#incidents`, `#lite`, `#audit` …) | **Implemented and verified** | `app/workspace.tsx`; browser suite 6/6 updated to the new labels, including old-bookmark navigation |
| Records section with tabs: Evidence and inspections, Incidents and responses, People and musters, Exports and audit | **Implemented and verified** | `components/foresight/records.tsx`; check-ins and message log tabs arrive with Phase 2 |
| One incidents-and-responses register (category, source, people affected, owner, due date, planning flag, `reopened` status) | **Implemented and verified** | `incidentSchema`, `POST /api/workspace/incidents` (supervisor/administrator), concern and run cases now carry `source`/`category`; scenario cases are `planning: true`. `tests/v2.test.ts` |
| Legacy MineShield incidents migrated into the register with audit history | **Implemented and verified** on a copied fixture | `lib/server/migrate.ts` maps status (`investigating` → in progress, `closed-record` → closed), keeps `legacyStatus`, links `migrated-from` and `legacy-audit`. No hosted Blob read |
| Zone generalisation | **Implemented and verified** | `zoneId` is now a workspace-defined id (regex); `insert()` rejects zones not defined for the mine (`UNKNOWN_ZONE`); zones come from the latest published `mine-model-revision`, else the training template; `zone-a/b/c` records unchanged (no DB constraint existed, no data rewrite needed) |
| Vision/PPE frozen behind `FORESIGHT_FEATURE_VISION=1` | **Implemented and verified** | Tab hidden by default (browser test asserts absence); code and tests unchanged |
| One training-mine notice on the mine selector; repeated sidebar/footer/topbar disclaimers removed | **Implemented** | Visual check at 1366 px and 390 px |
| Supplied Foresight logo in sidebar and favicon | **Implemented** | `public/brand/*` cropped from the supplied image |
| Merged people register and muster (WorkerSafe + check-ins) | **In progress** — depends on the Phase 2 `person`/`checkIn` records | |
| Demo data clean-up ("QA response drill …") | **Not applicable in source** — the record exists only in hosted data, which this work does not modify. Remove it from the hosted preview database before a demo | |

Checks after Phase 1: typecheck, build, `npm test` **37/37** (33 existing + 4 new), `npm run test:python` 36/36, `npm run test:sim` 12/12, browser 6/6.

## Phase 2 — real messaging, dry-run by default (2026-11-17)

No SMS or WhatsApp message was sent to any phone. All sending tests used the local mock gateway with unassigned `+999` numbers.

| Item | Status | Where / evidence |
| --- | --- | --- |
| Messaging modes `dry-run` (default) / `allow-list` / `live` enforced on the server; live also needs administrator enablement | **Implemented and verified** | `lib/server/messaging.ts`; tests: dry-run never reaches the gateway, allow-list blocks others, live blocked until enabled, non-admin cannot enable |
| Message records with status history `queued → accepted → delivered \| failed \| unconfirmed` (+ `dry-run`, `blocked`); accepted ≠ delivered; unconfirmed after deadline; WhatsApp→SMS failover | **Implemented and verified** (mock) | `tests/messaging.test.ts` |
| Check-in flows: WhatsApp dialogue (IN → shaft → time → buddy → registered with Ref), SMS one-line `IN 1 1430 TENDAI`, OUT, HELP, unknown numbers (reply + supervisor notified), consent (YES/STOP, in-person), shift-boss `TEAM`, manual check-in | **Implemented and verified** | `lib/domain/checkin.ts`, `lib/server/checkins.ts`, `lib/messaging/templates.ts` (keyed English templates; Shona/Ndebele keys empty) |
| Return times in Africa/Harare; past and beyond-max-shift rejected and asked again; overnight handled | **Implemented and verified** | unit tests |
| Server-first protection: confirmation queued only after the check-in commits; offline saves shown as **not yet registered** | **Implemented and verified** | messaging tests + browser `underground.spec.ts` |
| Status machine (5 statuses; modelled status cannot change a real check-in) with audit events | **Implemented and verified** | `assertTransition`, tests |
| Escalation ladder with persisted steps, fake-clock timing, stop on check-out (records steps run), no double execution under parallel schedulers, idempotent message keys; confirmed missing opens an incident with check-in, messages and timeline; supervisor step opens a shaft muster; muster confirmation marks the check-in accounted for | **Implemented and verified** | `escalation_steps`, `runDueSteps`, tests |
| Scheduler health: heartbeat, "Escalation scheduler stopped" on Underground now, `GET /api/messaging/health` 503 for an external monitor | **Implemented and verified** (unit); **external pager not set up** | `lib/server/gateway.ts` |
| SMSGate gateway: send, inbound webhook (secret URL token), receipts, heartbeat (offline/low battery), secondary gateway failover, admin alert once per outage | **Implemented, awaiting environment verification** (no phone/SIM supplied). Verified against the mock over real HTTP (proof 3 below) | `docs/MESSAGING_SETUP.md` |
| WhatsApp Cloud API: challenge, `X-Hub-Signature-256` verification, inbound/status parsing, text replies, template sends, "template not approved" state | **Implemented, awaiting environment verification** — no Meta app credentials supplied; Meta's documentation host is blocked from this environment, so shapes are from the published API as known, unverified | `lib/messaging/webhooks.ts` |
| Phone numbers sealed (AES-256-GCM, keyed hash lookup), masked for supervisors, hidden from viewers/reporters; inbound text hidden from viewers/reporters | **Implemented and verified** (unit + state filter) | `lib/server/personal.ts`, `protect()` in the workspace route. Production requires `FORESIGHT_PERSONAL_DATA_KEY` |
| Migration 003 (SQLite + PostgreSQL): escalation steps, provider message ids (replay rejection), contact index, conversations, channel bindings, message queue, heartbeats | **Implemented and verified** on SQLite and PostgreSQL 16 | `migrations/003-*.sql` |
| Underground now: headcount by shaft, overdue first, alerts with step and per-message status, gateway and scheduler status, Manual check-in, Start muster; Records: People register, Check-ins, Messages | **Implemented and verified** (browser, 1366 px and 390 px) | `components/foresight/underground.tsx`, `records.tsx` |
| Messaging service, mock gateway, Dockerfiles, `docker-compose.yml` | **Implemented**; compose/images **not built** (no Docker daemon here) | `services/messaging/*`, `deploy/*` |

**Proof test 3 (mock, over HTTP): Implemented and verified.** `tools/proofs/proof_smsgate_mock.ts`: mock SMSGate posts `sms:received` to `/api/messaging/sms`, the check-in is stored (Ref issued), one service tick sends the confirmation through the gateway API in allow-list mode, the mock's `sms:delivered` webhook moves it to delivered (history `queued, accepted, delivered`), and a non-allow-listed sender's reply never reached the gateway. Real Econet/NetOne phones: **Blocked** — needs an Android phone with SIM, SMSGate credentials and allow-listed test numbers from the owner.

Checks after Phase 2: typecheck, build, `npm test` **50/50 on SQLite and 50/50 on PostgreSQL 16**, `npm run test:python` 36/36, `npm run test:sim` 12/12, browser **8/8**.

## Phase 3 — collapse response mode (2026-11-17)

| Item | Status | Where / evidence |
| --- | --- | --- |
| Declare emergency (collapse, flooding, fire, unknown) — supervisor/administrator only, explicit "real emergency" confirmation, one active per shaft | **Implemented and verified** | `lib/server/emergency.ts`, `POST /api/emergencies`; `tests/emergency.test.ts` |
| Rescue roll at declaration: everyone declared underground at the shaft and not checked out, with check-in time, declared zone, expected return, buddy, phone (masked in records; full number with `tel:` link for supervisors); people at other shafts listed separately | **Implemented and verified** | roll produced in the same request (test asserts < 2 s; measured well under that locally) |
| Snapshot kept unchanged plus live roll entries; rescuers mark accounted for / injured / confirmed missing with timestamp, actor and note; each change audited and reflected on the check-in; missing people link to the emergency incident (no duplicate incident) | **Implemented and verified** | tests |
| One action: messages to all buddies and next of kin in the current messaging mode (dry-run here: outbox only) and a mine-wide muster; repeat does not duplicate | **Implemented and verified** (dry-run) | tests + browser |
| Incident linked as category collapse/flooding, source declared emergency | **Implemented and verified** | |
| Incident PDF (zone, timestamps, roll snapshot and changes, messages with delivery history, linked runs and assumptions, responses, audit) | **Implemented and verified** | dependency-free writer `lib/server/pdf.ts`; parsed with poppler `pdftotext` (multi-page, escaping); `GET /api/workspace/incidents/:id/pdf` |
| CSV exports (check-ins, incidents, messages, musters, people), formula-safe, phone masked/hidden by role | **Implemented** | `GET /api/workspace/export?format=csv&kind=` |
| Scenario cannot trigger an emergency | **Implemented and verified** | no simulator/scenario code references the emergency API (test) |
| Emergency, roll and muster usable at 390 px | **Implemented and verified** | `tests/browser/emergency.spec.ts` |

Checks after Phase 3: typecheck, build, `npm test` **54/54 on SQLite and 54/54 on PostgreSQL 16**, browser **9/9**.

## Phase 4 — mine model (2026-11-17)

| Item | Status | Where / evidence |
| --- | --- | --- |
| `mineModelRevision` schema (junctions, tunnels, shafts/adits/exits with hoist and ladder data, refuges, sumps with level–volume tables, pumps, fans, doors, zones, storage links); per-value provenance (measured / survey plan / assumed / default, note, author, time); unknown = null, never 0 | **Implemented and verified** | `lib/domain/mine-model.ts`; JSON schema `contracts/mine-model-1.schema.json` |
| Revisions: drafts editable, publish requires preflight without errors, published revisions immutable (edits start a new draft; previous becomes superseded) | **Implemented and verified** | `lib/server/mine-model.ts`, `/api/mine-model`; `tests/mine-model.test.ts` |
| Training template (fictional, labelled), seeded as revision 1 in every training workspace; zones keep ids `zone-a/b/c` so existing records stay valid | **Implemented and verified** | The template also runs through the Python escape engine via the shared fixture `fixtures/mine/training-template.json` |
| Preflight: connectivity and isolated parts, plan crossings without a junction, elevation consistency (> 60 % error, > 35 % walkway warning), zones without a route, exits/refuges on junctions, refuge capacity/air, pumps on sumps with capacities, sump geometry ordering and danger level, fans/doors on airways, units confirmed, length mismatch, missing provenance, storage links reviewed before multi-sump flooding; each issue names the engines it blocks | **Implemented and verified** | unit tests; live in the editor |
| Workspace zones follow the published revision (state API and server zone validation) | **Implemented and verified** | |
| Plan view to scale (zone colours, shafts/adits/incline, refuges, sumps with pumps, fans, doors, 50 m scale bar, declared headcount per shaft) | **Implemented and verified** | `PlanView` in `components/foresight/mine.tsx` (reused by scenario playback in Phase 5) |
| 3D schematic: Three.js boxes along centrelines from width/height/elevation; orbit, zoom, reset; faded where size unknown; text alternative (Table tab) | **Implemented and verified** (headless Chromium rendered it) | `components/foresight/tunnels-3d.tsx` |
| Editor: add junction (click, snap 1/5/10 m), connect tunnel, delete, property panel with provenance per value, undo/redo, live validation, save draft, publish | **Implemented and verified** | `tests/browser/mine.spec.ts` |
| GLB scans kept as zone pictures only | **Implemented** | "Zone pictures" tab hosts the previous map/GLB view |
| DXF import, GeoTIFF base map, subsidence marks | **Not implemented** (phase 9) | |

**Defect found and fixed (PostgreSQL):** with several processes starting against one database, re-running migration DDL on every start caused intermittent `deadlock detected` (4 of 4 full-suite runs had 1–2 failures). `ensureDatabase` now applies only migrations missing from `schema_migrations`, under the existing advisory lock. After the fix: 5 of 5 full runs clean. This also affects concurrent Vercel cold starts.

Checks after Phase 4: typecheck, build, `npm test` **58/58 on SQLite and on PostgreSQL 16 (5 consecutive runs)**, `npm run test:postgres` 1/1, `npm run test:python` 36/36, `npm run test:sim` 13/13, browser **10/10**.

## Phase 5 — escape and Time to act (2026-11-17)

| Item | Status | Where / evidence |
| --- | --- | --- |
| Flooding → closures → escape chain (one-way handoff; unchanged `lumped-water-1.0.0`; sump danger level closes the model's listed tunnels from that instant) | **Implemented and verified** | `services/simulator/scenario_chain.py`; `test_chain.py` (danger reached at the analytically expected 6000 s for the template; mass residual < 1e-6 m³) |
| Escape on the published model (JuPedSim + walkable polygons, timed closures, disconnected parts, refuges with capacity, exits preferred, pre-movement, seeded speeds); per-person outcome, T50/T95/T100 or *not reached*; accounting rule checked on every run | **Implemented and verified** | `escape.py`; named results read "cut off from assumed start in East development" with the reason |
| Start positions: default **even spread along the zone's tunnel centrelines** (seeded lateral offset); seeded random only when too crowded; method stored per person | **Implemented and verified** | Changed during this phase after the first demo rehearsal showed random placement could cluster everyone on one side of a zone |
| People source: current declarations (declared zone, else first zone of the shaft — assumption recorded per person) or planned headcount; snapshot frozen at run start; mine-model revision stored | **Implemented and verified** | `lib/server/scenarios.ts` |
| Preflight before submission lists blocking problems (model preflight, missing sump/pump inputs, empty headcount, unplaced people) | **Implemented and verified** | `tests/mine-model.test.ts` |
| Long work in the worker only; unreachable worker → run recorded as *not run*, no result shown | **Implemented and verified** | worker job kinds `escape-chain`, `time-to-act` |
| Time to act: full scan of backup start times (≤ 40 values), success = everyone at an exit or refuge before the horizon; reports latest tested value, "no tested value met the condition", "boundary not reached in the tested range", interval/step, monotonicity note | **Implemented and verified** | `time_to_act`; UI wording "Latest tested backup start under these assumptions: X (searched A to B in C steps of D)". Bisection not used (full scan is exact on the tested grid) |
| Endurance checks (self-rescuer walking time vs entered rating; refuge air hours = supply ÷ (occupants × consumption)) labelled "not a survival time", inputs and formula shown; unavailable when inputs missing | **Implemented and verified** | |
| PedPy congestion summary (N-t at exit approaches and narrow tunnels; crossings, first/last, peak per minute) | **Implemented and verified** | PedPy 1.5.1 |
| Trajectories stored as a separate columnar source record; browser playback derivative (5 s) generated without replacing it | **Implemented and verified** | `run-trajectory` entities |
| Playback on the plan view with timeline, play/pause, event markers (pump fails, backup starts, evacuation ordered, route floods, last person out), closed tunnels in red, text alternative (per-person table) | **Implemented and verified** — **deviation:** rendered with SVG on the shared `PlanView`, not deck.gl TripsLayer (avoids a large new dependency; same data could feed TripsLayer later) | |
| Compare runs, export run JSON, planning response (marked planning, no messages), explicit escalation by an authorised user (escalation record + register entry) | **Implemented** (browser-exercised) | |
| One-click "Run scenario" from a concern (zone, pump, concern prefilled) and declared headcount in the concern's zone | **Implemented and verified** (demo test) | Full `development-controls-2` priority rules remain phase 6 |
| Demo reset command (restore training mine, delete nothing) | **Implemented and verified** | `POST /api/workspace/mine-model/reset-training` |
| Underground now refreshes every 20 s while visible | **Implemented** | found during demo rehearsal |

**Demo acceptance (spec §16.2): Implemented and verified in an isolated environment** — `npm run test:demo` passes all six steps (17 s): signed test WhatsApp webhook check-in appears as declared; report → concern → pre-filled scenario; run plays with named cut-off people and balanced totals (danger at 1 h 40 min closes T6/T4); Time to act reports "… (searched 1 h 00 min to 2 h 00 min in 13 steps of 5 min)"; after the return time the buddy's allow-listed test number receives the SMS through the (mock) gateway, the dashboard shows *Delivered* only after the receipt, and a shaft muster opens; emergency roll lists the declared people with phone and the incident PDF exports. With real phones this still needs the owner's WhatsApp/SMSGate credentials (see blockers).

Checks after Phase 5: typecheck, build, `npm test` **60/60** (SQLite and PostgreSQL 16), `npm run test:python` 36/36, `npm run test:sim` 24/24, browser **10/10** + demo acceptance 1/1.

---

## Navigation audit (2026-11-26)

Problem: Underground now mixed the live headcount with concerns, the review queue, laboratory runs and pending decisions; responses were split between Records → Incidents and Records → People → Cases; per-shaft counts were shown twice.

- **Five sections, one job each:** Underground now (people declared underground, overdue alerts, emergency/check-in/muster actions) · **Concerns** (new: 1 Reports and inspections → 2 Concerns → 3 Responses, as numbered steps with live counts) · Scenarios · Mine · Records (people register, check-ins, messages, exports only).
- Underground now links to Concerns only when something there needs attention ("1 concern to review →"). Duplicate per-shaft headcount cards replaced by "Shafts with people down".
- Responses have one home: Concerns → Responses (register, filters, PDF); clicking a response opens the action/decision/verification dialog that used to sit under Records → People → Cases and actions.
- Sidebar items carry a one-line purpose; jargon eyebrows ("UNDERGROUND NOW / CONCERNS / RESPONSES", "WORKERSAFE / DOCUMENTED RESPONSE", "Latest laboratory runs", "Records connected") removed or reworded. Top bar shows the mine name instead of repeating the page title.
- Scenarios: water overrides, movement and run/endurance inputs folded into "Advanced assumptions" (defaults unchanged).
- Old bookmarks still resolve: `#evidence`/`#inspections` → Concerns step 1, `#incidents` → Concerns step 3, `#people`/`#checkins`/`#messages`/`#audit` → Records tabs; `#concerns?tab=queue|reports|responses` selects a step.
- Verified: typecheck, production build, 10/10 browser specs (updated for the new layout) and the demo acceptance story pass; no horizontal scroll at 390 px.

## Hosting: Render engine service (2026-11-26)

- `render.yaml` + `deploy/render.Dockerfile` + `deploy/render-start.sh`: one Render web service running the simulator worker (escape, escape-chain, time-to-act, lumped water) and the messaging service. Guide: `docs/RENDER_SETUP.md`.
- `GET /healthz` added to the simulator (unauthenticated, returns only `{"status":"ok"}`); `/health` and jobs still require the worker token.
- Messaging service no longer requires `BETTER_AUTH_SECRET` in production (`FORESIGHT_PROCESS=messaging-service`); it does not serve sign-in.
- Rehearsed locally in production mode against a fresh PostgreSQL database: healthz ok, auth enforced, heartbeats written, escape-chain job completed in 2.5 s (balanced), Time to act 14.9 s. Regression: `npm test` 60/60, Python suites OK.
- First Render build failed. Rebuilt locally with Docker: better-sqlite3 fell back to compiling from source and the slim Node image has no compilers. The install stage now uses `node:22-bookworm`. The rebuilt image runs: healthz ok, auth enforced, all four engines listed, heartbeats written to PostgreSQL.
- **Not yet verified:** the Render build itself and the live Vercel ↔ Render connection. Escape and Time to act show "worker unavailable" on the live site until `FORESIGHT_SIMULATOR_URL` is set.

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
