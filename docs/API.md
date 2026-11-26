# Development API contracts

Versioned JSON Schema exports are in `contracts/`. TypeScript/Zod validates web boundaries and the pure Python engine independently validates SI physical references, geometry and compute budgets. Regenerate with `npm run contracts`; Python contract-parity tests read the same fixture. Stable entity links enforce same-workspace foreign keys in SQLite.

Start a session through Better Auth `POST /api/auth/sign-in/anonymous`. Signed, HTTP-only library sessions identify an isolated, fictional supervisor workspace. The application does not trust a browser-provided role or workspace ID. An optional `X-Workspace-Id` is a guard and must match the server-derived scope. Mutations require a browser same-origin `Origin` and JSON operations require an `Idempotency-Key` of 12–120 alphanumeric/hyphen/underscore characters. The same key and input returns the same result; a changed payload returns 409. An audit entry and mutation commit together.

`GET /api/workspace/state` returns workspace identity/mode, fictional site and selected records. UTC timestamps distinguish observed/submitted/processed/reviewed times; the UI displays Africa/Harare. No real private-site onboarding or production member-management UI is shipped. Roles are persisted and server-enforced; only local operator membership changes are currently supported.

| Method and path | Body / result |
| --- | --- |
| POST `/api/workspace/reports` | `{text,zoneId,observedAt:null or offset datetime}` → pending persisted report |
| POST `/api/workspace/reports/:id/extract` | `{}` → model proposals with spans/provenance; 503 leaves report usable manually |
| POST `/api/workspace/reports/:id/review` | `{expectedRevision,facts,reason}` → immutable observations and new assessment; factual spans must match original UTF-16 offsets |
| POST `/api/workspace/inspections` | `{title,zoneId,dueAt,observedAt,outcome,finding}`; supervisor submission derives observation/assessment; reporter submission requires later review |
| POST `/api/workspace/assessments` | `{}` → new cutoff assessment under development-controls-1 |
| POST `/api/workspace/assessments/:id/explain` | `{}` → provider explanation with known evidence IDs; source existence is checked, entailment still needs review |
| POST `/api/workspace/snapshots` | `{}` → frozen workspace records and fictional scenario template with explicit missing physical inputs |
| POST `/api/workspace/scenarios` | `{name,baselineSnapshotId,scenario,assumptionsAccepted:true}` → immutable laboratory scenario |
| POST `/api/workspace/scenarios/:id/runs` | `{}` → persistent run; submits idempotent job to separate Python service |
| POST `/api/workspace/scenarios/:id/sensitivity` | `{samples:1..100,seed,inflowM3s:[min,max],pumpCapacityM3s:[min,max],backupDelaySeconds:[min,max]}` → background sensitivity job |
| GET `/api/workspace/runs/:id` | Poll worker; persist completed calculation and diagnostics |
| POST `/api/workspace/runs/:id/retry` | `{}` → retry a saved run when worker dispatch was unavailable; same job ID, no duplicate run |
| POST `/api/workspace/runs/:id/cancel` | `{}` → cancellation request, checked between bounded numerical substeps |
| POST `/api/workspace/workers` | `{name,role,zoneId,startsAt,endsAt,status}` → assignment interval; no live location |
| POST `/api/workspace/workers/:id/status` | `{expectedRevision,status,reason}` → checked-in / checked-out |
| POST `/api/workspace/cases` | `{concernId,assessmentId,zoneId,title,owner,dueAt}` → linked case |
| POST `/api/workspace/cases/:id/actions` | `{expectedRevision,title,dueAt,completed,evidenceIds}` → recorded action, separate from verification |
| POST `/api/workspace/cases/:id/transition` | `{expectedRevision,status,reason,verificationIds}` → constrained lifecycle; closure needs completed action and referenced same-zone evidence |
| POST `/api/workspace/muster` | `{zoneId,caseId:null or id}` → frozen active roster |
| POST `/api/workspace/muster/:id/confirm` | `{expectedRevision,workerId,confirmed,reason}` → human confirmation/correction with actor/time |
| POST `/api/workspace/sync` | `{items:[{key,operation,body}]}` up to 20 reports/inspections/assignments/worker-status changes → individual synced/rejected/conflict outcomes |
| POST `/api/workspace/assets` | Multipart `file` GLB and `metadata` JSON; actual GLB2 header and embedded resources checked, 20 MB limit |
| GET `/api/workspace/assets/:id` | Authorised GLB bytes; no public evidence URL |
| POST `/api/workspace/cameras/:id/policy` | `{expectedRevision,restrictedRegion:{xMin,yMin,xMax,yMax},reason}` in image fractions → new mapped region policy version |
| POST `/api/vision/feed` | `{cameraId}` → bounded processing of an administrator-configured feed alias; browser cannot provide a URL |
| POST `/api/vision/jobs` | Multipart MP4 `file`, `cameraId`, offset datetime `recordedAt`; 50 MB, ≤120 seconds, bounded decode; external worker required |
| GET `/api/vision/jobs/:id` | Worker health/progress/result; completed scoped events are ingested idempotently |
| POST `/api/vision/events` | Internal callback `{jobId,event}` with `X-Job-Token`; SHA256-scoped token bound to the persisted job/camera/workspace |
| POST `/api/workspace/vision/:id/review` | `{expectedRevision,status,reason}` → acknowledged/dismissed/resolved |
| GET `/api/vision/frames/:jobId/:frameId` | Scoped, referenced blurred evidence still; retention may make it unavailable |
| GET `/api/workspace/export` | Scoped JSON evidence/audit bundle; `?format=text` readable timeline |
| GET `/api/workspace/audit` | Scoped audit events; before/after references preserved |
| GET `/api/workspace/evaluation` | Constructed numerical verification and outstanding independent evaluation |

Errors use `{code,message,fieldErrors?,requestId?}`. Validation uses 400/422; sessions 401, scope/roles/origin 403, missing scope records 404, revision/idempotency conflicts 409, budgets 429 and unavailable services 503. Stream/video routes return bounded errors without stack traces. Some initial asset/vision validation errors currently omit field-level details; see implementation status.

Old hash bookmarks alias into the five destinations. `/api/records` is retained but requires migration to the scoped API (no unauthenticated writes); legacy prepared `/api/assistant` POST returns 410. `app/legacy-workspace.tsx`, factor register and original replay JSON preserve the old demonstration implementation and histories. No live Blob is modified.

Python simulator transport binds loopback at port 8100. Its `/health` and `/jobs` endpoints require `Authorization: Bearer FORESIGHT_WORKER_TOKEN`. Job reads/cancellation additionally match `X-Workspace-Id`. Event ordering is array order for equal times; changes apply from their event instant onward. Pumps use effective constant capacity and optional start/stop hysteresis. Directed transfer fluxes are allocated proportionally from the same donor state; paired transfers cancel in system balance. Overflow is explicit. Actual pump-rate samples describe the preceding integration interval (zero at time origin).

Numerical jobs persist in a separate SQLite store and requeue interrupted runs after worker restart. Hosting requires a long-running CPU service and persistent disk/transactional DB; the app never spawns Python inside a Vercel function. Queue capacity, horizons, graph size and daily per-workspace budgets are bounded. Uploaded clips are local files; stream URLs are operator-owned configuration, not accepted from browser requests.

## Connected workflow additions (18 October 2026)

`GET /api/workspace/state` now includes `services.aiStatus` (`configured`, friendly `message`) and `visionMessage`; `services.vision` requires authenticated worker readiness, not just URL presence. No provider/worker keys are returned. Presence/syntax readiness is distinct from successful provider authorization.

`POST /api/vision/jobs` accepts the existing multipart MP4 path with `cameraId`, timezone-aware `recordedAt`, and **`consent=true`**. Hosted clients first obtain a scoped private upload token from `/api/uploads`, upload under `clips/<workspace>/<uuid>.mp4`, then send small JSON `{pathname,cameraId,recordedAt,consent:true}`. Client-supplied external URLs are never fetched. Limits are 50 MB/120 s; hosted multipart is limited to 4 MB, so use direct upload there. Job states are queued, processing, completed, failed (older running states normalize to processing). Completed results expose bounded representative `findings` with track/equipment/state/frame/time/reason, alongside temporally confirmed `events`. Missing detections are cannot-assess. Event callback and job-poll imports use the same idempotency key/payload validation.

`POST /api/workspace/cases/from-source` requires a supervisor, normal idempotency header, and `{sourceKind:"run"|"vision-event",sourceId,title,owner,dueAt,reason}`. Runs must be completed; events must be supervisor-acknowledged or resolved with accepted evidence. A laboratory case copies the immutable scenario assumptions and result summary/thresholds/routes/hash, retaining run and snapshot links. An event case retains the event and accepted observation IDs. This explicit human action changes neither operational assessments nor muster.

Spatial import metadata adds `reconstructionMethod` and `coverage`. Older imports remain readable and missing metadata is explicitly recorded as unknown/legacy. New UI imports require actual method/coverage and capture timestamp; scale remains unverified. GLB validation checks chunks, embedded resources, buffer/accessor bounds and dense mesh positions; unsupported sparse or externally decoded layouts return a clear import error. Scale registration never automatically supplies route/simulation geometry.

## MineTech v2 additions (spec 2.0)

Same session, role, same-origin and `Idempotency-Key` rules as above. Supervisor or administrator unless stated.

| Method and path | Body / result |
| --- | --- |
| POST `/api/workspace/incidents` | `{title,zoneId,category,source:"real-event"\|"report",description,peopleAffected,owner,dueAt,occurredAt}` → register entry (`case` kind) |
| POST `/api/workspace/people` | `{name,phone,role,zoneId,defaultBuddyId,channels,nextOfKin,languages}`; phone sealed at rest |
| POST `/api/workspace/people/:id/consent` | `{given,note}` → in-person consent recorded with history |
| POST `/api/workspace/checkins` (alias `/api/checkins`) | `{personId,shaftId,zoneId,expectedReturn,buddyPersonId,reason}` → manual check-in (recorded as manual); escalation steps scheduled |
| GET `/api/checkins[/:id]` | Check-ins and their escalation steps |
| POST `/api/workspace/checkins/:id/status` | `{expectedRevision,status:"accounted-for"\|"confirmed-missing",reason}`; confirmed missing opens an incident |
| POST `/api/workspace/muster/shaft` | `{shaftId,reason}` → frozen roster of people declared at the shaft |
| POST `/api/workspace/messaging/config` | Shafts, grace/second interval, max shift, unconfirmed deadline |
| POST `/api/workspace/messaging/live` | `{enabled,reason}`; **administrator only** |
| GET `/api/gateway` / POST `/api/gateway` | Gateway + scheduler health / `{provider,channelKey}` binds a channel to this workspace |
| GET `/api/messaging/health` | Public; 503 when the scheduler heartbeat is stale (for uptime monitors) |
| GET/POST `/api/messaging/whatsapp` | Meta webhook (challenge; `X-Hub-Signature-256` required) |
| POST `/api/messaging/sms?token=` and `/api/messaging/status?token=` | SMSGate webhooks (`sms:received`, `sms:delivered`, `sms:failed`, `system:ping`) |

`GET /api/workspace/state` now includes `messaging` (mode, allow-list count, live enablement, config, scheduler/gateway health, escalation steps) and `features.vision`. Sealed phone values never leave the server; viewers and reporters lose masked numbers and inbound text. `/api/workspace/sync` accepts `checkins` operations; queued check-ins are shown as "not yet registered" until stored.
| POST `/api/emergencies` | `{shaftId,type:"collapse"\|"flooding"\|"fire"\|"unknown",confirmReal:true,note}` → emergency with roll snapshot and linked incident |
| GET `/api/emergencies/:id/roll` | Snapshot, other shafts and live entries; full phone numbers for supervisors/administrators |
| POST `/api/emergencies/:id/alert` | Messages to buddies and next of kin (current messaging mode) + mine-wide muster; idempotent |
| POST `/api/emergencies/roll/:entryId` | `{expectedRevision,status:"accounted-for"\|"injured"\|"confirmed-missing",note}` |
| POST `/api/emergencies/:id/close` | `{reason}` |
| GET `/api/workspace/incidents/:id/pdf` | Incident report PDF (supervisor/administrator) |
| GET `/api/workspace/export?format=csv&kind=check-in\|case\|message\|muster\|person` | CSV records |

## Phase 6 additions: concerns, forecast, pre-entry checks

| Method and path | Body / result |
| --- | --- |
| POST `/api/workspace/concerns/reassess` | New assessment under `development-controls-2` |
| POST `/api/workspace/concerns/advisory` | `{concernId,shaftIds,text,hours,confirm:true}` → active do-not-enter advisory; supervisor or administrator; messages follow the messaging mode |
| POST `/api/workspace/concerns/advisory/:id/withdraw` | `{reason}` |
| POST `/api/workspace/pre-entry` | `{shaftId,answers:[{key,text,answer:"yes"\|"no"}]}` → pre-entry check recorded as evidence |
| POST `/api/workspace/forecast/refresh` | Fetch a forecast now (supervisor/administrator); `{outcome,detail}` |
| POST `/api/workspace/sensor-readings` | `{source,sensorId,zoneId,quantity,value,unit,readAt,note}`; administrator only; evidence only |
| POST `/api/workspace/messaging/config` | Now also accepts `weather:{latitude,longitude,heavyRainMmPerHour,heavyRainMm24h}\|null` and `preEntry:{questions:[{key,text}]}`; omitted fields keep their saved values |

Assessments created from now on record `policyVersion: "development-controls-2"`; older assessments keep `development-controls-1`. Each concern lists the `rules` that fired, `peopleAtRisk`, and `evidence` records (forecast, pre-entry checks, subsidence marks). A concern with `priority: "advisory"` (heavy rain alone) never opens a response by itself.
