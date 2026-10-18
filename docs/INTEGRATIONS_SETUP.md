# Foresight integration setup

This completes software integration in the existing repository. No PPE weights, footage, captured mine mesh or accuracy scores are bundled. Use fictional records in an isolated workspace. The production site does not change until this branch is deployed.

## Hosted configuration

In Vercel select **hjm-technologies / foresight-minetech**, then Settings → Environment Variables. Set the following for each intended target (Preview and Production are separate); redeploy after changes:

| Variable | Exact requirement |
| --- | --- |
| `POSTGRES_URL` or `DATABASE_URL` | Supabase PostgreSQL transaction pooler URI, port 6543, TLS; the existing integration supplies POSTGRES_URL. Do not replace existing database data. |
| `BETTER_AUTH_SECRET` | Private random 32-byte minimum secret, generated with `openssl rand -hex 32`; preserve existing value to preserve sessions. |
| `BETTER_AUTH_URL` | Production: `https://foresight-minetech.vercel.app`. For local use the exact localhost origin. Preview uses its configured origin/trusted origin; do not set arbitrary wildcards. |
| `FORESIGHT_WORKER_TOKEN` | Strong private shared token, minimum 32 characters; same in Node and Python worker. Preserve the existing configured token. |
| `BLOB_READ_WRITE_TOKEN` | Existing **private** Vercel Blob store integration. GLBs and MP4s use direct private uploads, avoiding the 4.5 MB function request ceiling. |
| AI values | One of the two options below. Never prefix credentials with NEXT_PUBLIC_. |
| `FORESIGHT_VISION_URL` | HTTPS URL of your separately hosted persistent Python worker; omit until provisioned. |

Leave `FORESIGHT_SIMULATOR_URL` unset on Vercel to use the existing bundled Python simulation function. In development use `http://127.0.0.1:8100` and start the simulator separately. Schema creation is additive and automatic; `npm run db:migrate` can be run with the intended database environment first. See [HOSTED_SETUP.md](HOSTED_SETUP.md) for database/TLS details. Supabase's public CA remains pinned in the repository; certificate verification stays enabled.

Deploy the updated `codex/atu-foresight-upgrade` branch (not the unchanged main branch): in Vercel → Deployments → Create Deployment, select that Git branch for a preview. Verify its fictional workflow first, then use Create Deployment with the same commit and the Production target, or your normal reviewed promotion flow. A new build is needed when target-specific environment values change. Do not assume a successful Git push alone changes the production alias.

Check `/api/health` after deployment. Open an isolated browser workspace, submit fictional evidence, then follow [THREE_MINUTE_DEMO.md](THREE_MINUTE_DEMO.md). Do not run automated tests against real worker records.

The current session could not read Vercel environment metadata: the connector returned HTTP 403 for team `hjm-technologies`, and the Vercel CLI was unavailable. Consequently no hosted credentials were changed and no production deployment was published in this follow-up.

## Written-report extraction

Uses installed AI SDK 7 `generateText` + `Output.object` with a Zod schema. Provider references: [structured output](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data), [Google provider](https://ai-sdk.dev/providers/ai-sdk-providers/google). The Google adapter uses `createGoogle` from `@ai-sdk/google` 4; the Gateway adapter uses `createGateway` from `ai`.

**Option A, Gateway:** set `FORESIGHT_AI_PROVIDER=gateway`, `FORESIGHT_AI_MODEL=<provider/model-id>` and `AI_GATEWAY_API_KEY=<your private Gateway key>`. Obtain an actual structured-output capable text-model ID from `curl -fsS https://ai-gateway.vercel.sh/v1/models`; do not paste a direct Google key into this variable.

**Option B, existing Gemini account:** set `FORESIGHT_AI_PROVIDER=google`, `FORESIGHT_AI_MODEL=<actual Google model ID>`, and `GOOGLE_GENERATIVE_AI_API_KEY=<private Google key>`. List available models using Google's authenticated Models API or AI Studio. Existing `GEMINI_MODEL` and `GEMINI_API_KEY` are also supported: if FORESIGHT_AI_MODEL is absent, GEMINI_MODEL supplies the ID; if provider is absent, GEMINI_MODEL selects Google. Explicit configuration takes precedence; remove empty/example provider settings when relying on automatic legacy selection.

The server checks provider, model-ID syntax and credential presence. The UI displays readiness before extraction. This is a configuration check, **not a claim that a key is authorized**: the provider must authorize the generation request. Unsupported model IDs, rejected keys, timeout, quota and invalid structured citations return a friendly unavailable message; the original report and manual review remain available. No raw upstream errors, report text, keys or credentials are logged by this integration. The administrator should verify the exact provider/model/account in its own console, then retry the fictional report below; avoid sending real personal records.

> At East development, pump P1 stopped and water was observed rising near the sump. No water depth or inflow was measured.

Review separate pump-stoppage and rising-water proposals with exact excerpts. Quantities, worker location and observation time must remain unknown. “No measurement” must never become zero. Proposals distinguish observed/proposed/completed actions and affirmed/negated/uncertain conditions. Exact, unique quotes may repair model offset mistakes; absent/ambiguous quotations fail closed. Automatic date interpretation is conservative: only a quoted ISO calendar date plus a cited time expression can supply an observation timestamp; otherwise keep null and let a supervisor review unresolved wording. Numeric proposals must contain their stated number in their supporting excerpt; conversions and spelled-out numbers may require manual review. These checks cannot establish full semantic entailment: supervisor acceptance remains necessary. Remove any unaccepted proposals before accepting the selected facts. Saving/extracting alone creates no accepted observations or assessment.

Automated SDK tests use declared mock models. **No live provider extraction was verified in this environment**, because provider credentials were unavailable.

## Recorded-MP4 PPE worker

Use a persistent Linux machine/container with Python 3.11+, CPU resources, HTTPS ingress/reverse proxy, and writable private disk; do not deploy video processing into the frontend or the stateless simulator function. There is one CPU inference worker and a bounded queue. Do not expose the development token to the internet.

```sh
python -m venv .venv
.venv/bin/pip install -r services/vision/requirements.lock.txt
# Place reviewed manifest and weights in a private directory outside Git.
.venv/bin/python -m services.vision.check_model /absolute/private/models/ppe-manifest.json
# Set variables through your host's secret manager or private service environment:
export FORESIGHT_VISION_MANIFEST=/absolute/private/models/ppe-manifest.json
export FORESIGHT_VISION_DATA=/absolute/private/vision-data
export FORESIGHT_ENV=production
export FORESIGHT_VISION_HOST=0.0.0.0  # container; otherwise keep loopback behind proxy
export FORESIGHT_VISION_PORT=8200
export FORESIGHT_INGEST_URL=https://foresight-minetech.vercel.app/api/vision/events
# FORESIGHT_WORKER_TOKEN must already contain the same strong secret as Next.
.venv/bin/python -m services.vision.server
```

The worker does not load Next's .env.local. Configure its process environment separately. Protect its port with TLS/firewall and a maximum 50 MB reverse-proxy body limit with sufficient upload timeout. Node forwards a bounded private clip; the browser never receives the worker token. `FORESIGHT_HARDWARE` records actual processor/RAM details for measured processing diagnostics; it is not an accuracy metric.

Authenticate `GET /health` using the shared Bearer token in a private operator client. Expected `status: ready` only after manifest, checksum, tensor and preprocessing validation. Set Next's `FORESIGHT_VISION_URL=https://<worker-host>` and redeploy. If callback ingress is blocked, authenticated job polling imports the same final events idempotently. Frame downloads remain workspace scoped and are served through Node.

Evidence → Vision requires explicit recording permission, a mapped camera and real timezone-aware capture start. Limits: **MP4 50 MB, 120 s, 3840×2160, 240 source fps maximum; inference 5 fps by default**. Input header is validated then OpenCV decodes actual frames. Jobs persist as queued → processing → completed/failed; failures remain visible. An unreachable dispatcher saves a failed job with an actionable message. Submit again after repair; failed footage is not silently treated as analyzed.

Camera-session IoU tracks are temporary. No facial recognition or WorkerSafe identity matching is implemented. The policy requires three samples over at least one second for a potentially-missing PPE event, suppresses repeated candidate events, and treats loss of visibility conservatively. No detection alone is **cannot assess**, never proof of missing PPE. Darkness, overlapping people, cropped/small body regions and conflicting detections are also cannot assess. These are development heuristics requiring independent validation; visible positives are observations, not compliance certification. A model without explicit `no-helmet` / `no-vest` labels can show observed/cannot-assess states, but cannot produce missing-equipment alerts. Restricted entry uses the separately reviewed camera-image region.

Review frames retain source timestamps and camera-local track IDs. Upper head regions are blurred as data minimization, **not guaranteed anonymization**. Raw uploaded clips are deleted after processing/dispatch; retained JPEGs expire after seven days and are purged hourly or at startup. Configure a seven-day lifecycle on private Blob `clips/` objects as well, for uploads interrupted before finalization; GLB assets must not share that deletion policy. Dismiss or acknowledge using a supervisor-authored reason. An acknowledged event can create a linked response case; resolve/close only with appropriate human evidence. Calculated movement never confirms muster.

### Required weights and model contract

No approved pretrained model has been supplied. Do not use a generic COCO detector: it does not supply the PPE classes. Acquire weights and their exact training/export class list from a source you are licensed to use; review **weights, base-model, dataset and export/runtime licences**. A permissively licensed wrapper does not establish a permissive weights licence.

Copy `services/vision/model-manifest.example.json` into the private model directory and replace **every placeholder**:

- `modelId`: exact model/version; `source`: canonical source URL, release/commit, export tool/version and original weights identity.
- `weights`: ONNX path relative to manifest; `sha256`: output of `sha256sum /path/model.onnx`.
- `weightsLicense`, `runtimeLicense`, `licenseReviewedBy`: actual licence identifiers/source references and responsible reviewer. Keep supporting licence text with the weights.
- `classMap`: every class indexed contiguously from zero, matching the export's **actual** training order. Must include separate `person`, `helmet`, `vest`; optionally explicit `no-helmet`, `no-vest`. Other training classes may map to their original labels and are ignored. Example IDs are not authoritative.
- `inputSize`: 128–1280 square. The adapter supports exactly one float32 image tensor `[1,3,S,S]`, RGB, `/255`, NCHW, centered letterbox with padding 114 and rounded dimensions. Record these in `preprocessing` exactly as the example. Weights requiring another transform need a tested adapter before activation.
- `outputFormat`: `yolo-v8` means batch-one `[1,4+C,N]` or `[1,N,4+C]` **cx,cy,w,h plus class probabilities with no objectness**, input-pixel coordinates; `nms-xyxy` means `[1,N,6]` **x1,y1,x2,y2,score,class-index**, input-pixel coordinates. Scores must be finite probabilities in [0,1], class indices integral and in range. Normalized coordinates, logits, YOLOv5 objectness, segmentation/pose/multiple-output models are unsupported.

Run the model check, then inspect known consented positive/negative/poor-visibility reference clips against their source labels. Verify that coordinates align after letterbox reversal, class labels are correct, and thresholds match actual review needs. Compare against manually annotated footage before declaring accuracy. `npm run test:vision-runtime` uses an **image-dependent mathematical graph**, not trained PPE weights. Its passing result must never be quoted as PPE recognition quality.

## Reconstructed asset

Follow [tools/reconstruction/README.md](../tools/reconstruction/README.md). Import a real, consented captured-area GLB 2.0 mesh, maximum 20 MB, containing embedded geometry and textures, dense accessors; no external buffers, image URLs or decoder dependencies. The normal UI imports an unscaled walkthrough and records source, capture date, consent, method/software version and coverage/gaps. Measured registration remains a separate reviewed API option with reference notes and residuals; no dimensional calculations or route safety are inferred from either status.

A captured visual surface, a reviewed route graph and simulation storage geometry are distinct records. The viewer supports orbit, zoom, reset, loading/error messages and the 2D map fallback. A synthetic triangle is used solely as an import/viewer software test. **No real captured asset has been imported or verified.**
