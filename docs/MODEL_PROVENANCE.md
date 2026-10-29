# Model, solver and evidence provenance

## Deterministic assessment

`development-controls-1` consumes accepted observations at a cutoff. It exposes explicit source IDs, unknown times, a 24-hour development freshness window, control status and direct serious-condition review. Physical water/pump reports are one evidence group; an independent unverified inspection may form a compound concern. These are development rules awaiting qualified review. They are not a collapse model or a validated risk grade. A repair statement alone does not prove restored drainage.

The policy's initial condition classifier uses a small transparent keyword list after human review. This is not an independently evaluated text-understanding model. Freshness, control classification and policy language require reviewer validation. Corrections are append-only source relationships, not deletion or historical rescoring.

## AI extraction and explanations

AI SDK version is pinned in `package-lock.json`; structured output uses the installed `generateText` + `Output.object` API. Model comes only from `FORESIGHT_AI_MODEL`. No model ID is guessed or frozen from memory. Select one from the current provider catalog supporting structured extraction, set the server-side key, and record the exact ID in the returned provenance. No provider call was run in this environment because no key/model was supplied. Missing keys, failed calls and invalid source offsets produce recoverable unavailable states. No prepared answer is labelled as live AI.

Only permitted fictional report text, known fictional zones/assets and reporting timezone enter extraction. Registered worker names/IDs, email addresses and labelled/international phone contacts are masked with length-preserving characters before outbound calls; source offsets are mapped back to the original on the server. This conservative filter does not recognise every possible unregistered personal detail. Do not submit personal information. Workforce/contacts, credentials and footage are not read into the prompt. Explanation sources are selected on the server from the chosen assessment. Citation IDs must exist; a human still reviews factual entailment. Provider failures consume a persisted workspace budget (30/day), with a 20-second timeout and at most one SDK retry. No tools or autonomous actions are provided.

## Numerical model

`lumped-water-1.0.0`, source in `services/simulator/engine.py`, is a pure Python deterministic lumped storage model. Internal units: m³, m, s, m³/s. Piecewise monotonic volume/elevation geometry, effective constant pump capacities, availability/capacity/inflow schedules, hysteresis, directed assumed transfers and explicit overflow implement conservation. Internal step ≤30 seconds splits at events, outputs and pump-switch estimates. Proportional donor allocation prevents negative storage and balances each internal transfer once.

Configured storage/route thresholds are fictional assumptions. Whole-journey conservative graph search uses recorded availability intervals and modelled water crossings, with a bounded simple-path search and no waiting/congestion model. Unknown connections are excluded. Multiple starting nodes expose positional uncertainty. No ventilation, gas, blasting, rock failure, pressure hydraulics or structural-stability solver is active.

Input hashes identify canonical content, not correctness. Seeded sensitivity samples provide ranges of assumptions, not calibrated probabilities. Evaluation independently checks finer steps and conservation; the GUI does not automatically run convergence for every interactive job. Calibration comparison is a CLI import of timestamped readings, pump status and measured flow, with coverage and residuals. No field calibration data has been supplied.

## Vision adapter

Initial runtime: ONNX Runtime CPU **1.24.4** (MIT runtime), OpenCV headless **4.13.0.92**, NumPy **2.3.5**, pinned with transitive dependencies in `services/vision/requirements.lock.txt`. Source code implements image-dependent ONNX tensor inference, RGB letterboxing, class-aware NMS, local IoU tracking, head/torso association, explicit negative evidence, uncertainty, entry transitions, persistent review events and minimal blurred frame retention. Runtime/adapter tests do not establish PPE recognition performance.

No pretrained PPE weights are distributed or claimed verified. A manifest requires the actual source, weight licence, reviewed licence attribution, SHA256 checksum, exact class map and output layout. `model-manifest.example.json` is deliberately not runnable. Standard person detection does not satisfy helmet or vest recognition. Absent equipment boxes are **cannot assess** unless explicit negative equipment evidence and adequate visible body regions support a potential missing-item review. Darkness, overlap and clipped/small regions degrade assessability.

Public model discovery on 2026-10-17 found `wesjos/Yolo-hard-hat-safety-vest` declaring Apache-2.0 and classes `hat,nohat,novest,person,vest`, while identifying Ultralytics YOLO11 as its base. The upstream licensing chain needs review; no weights or sample imagery were downloaded or redistributed and uploader metadata alone is not treated as licence clearance. Other candidate cards lacked clear complete provenance. Supply approved weights/export before claiming actual PPE acceptance. Export tooling is separate from the ONNX CPU runtime and must be licence-reviewed too.

Policy defaults require ≥3 valid PPE samples spanning ≥1 second. Restricted entry has its own outside-to-inside footpoint transition with a pixel tolerance; initial appearance inside a region is unknown entry history. Frame processing latency is distinct from live capture-to-alert delay. Configured streams use monotonic processing time with capture-time uncertainty. None of these tolerances has site validation. No face recognition or automatic WorkerSafe identity association exists.

## Captured geometry

Three.js GLTFLoader supports imported self-contained GLB2 meshes. No reconstructed mine/corridor asset, measured transform or capture permission has been supplied. Until these exist the map remains a versioned conceptual fixture. Unverified imported areas are walkthroughs, with dimensional use disabled. A Gaussian-splat viewer, independently checked 3D evidence coordinates and collision geometry remain dependencies. Offline reconstruction instructions are unexecuted guidance and clearly labelled accordingly.

## Connected integration follow-up · 18 October 2026

Written extraction now uses the installed AI SDK 7 structured-output API with either Gateway or the direct `@ai-sdk/google` 4 provider; legacy Gemini environment names are supported. No live provider result was available for validation in this follow-up. The server checks exact quotation spans and conservatively rejects unsupported numbers/dates; semantic entailment still requires human acceptance.

The ONNX manifest now declares RGB/NCHW/letterbox-114 preprocessing, normalization and input-pixel coordinates. Model readiness executes a real blank tensor through the supplied session before enabling controls. Invalid ranks, probabilities, nonfinite values or class indices fail closed. The new HTTP/MP4 transport test uses authored arithmetic weights, **not pretrained PPE**, and does not change the outstanding licensed-weights or independent-accuracy status above. All three equipment states have timestamped review frames; no generic detector is reclassified as a PPE model.

The pump-failure exercise is an explicitly fictional scenario, distinct from the original constant-pumping example. Its scheduled one-hour primary failure, backup capacity, water threshold, crew start/departure, speeds and route lengths are assumptions. Regression calculations and route interval checks verify arithmetic, not safe operating limits. See [THREE_MINUTE_DEMO.md](THREE_MINUTE_DEMO.md).
