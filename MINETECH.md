# Foresight MineTech Edition

Isolated software development edition for MineTech 2026.

Expo baseline: f9e054ad8e3813913d4f798587c1a91cd18ebd51; local tag expo-2026.
New branch: codex/minetech. Existing production https://foresight-mining.vercel.app is unchanged.
Do not push MineTech changes to the original worksafe repository main branch, copy the Expo .vercel binding or reuse its storage credentials.

Run `npm ci` then `npm run dev -- --port 5180`.

## Gemini configuration

Create an ignored .env.local in this directory with GEMINI_API_KEY and GEMINI_MODEL, then restart. Choose an enabled text model supporting generateContent and structured JSON output. Never prefix the key with NEXT_PUBLIC or put it in browser code. The key is configured only in ignored local and Vercel environment settings.

Only server-selected synthetic replay evidence is sent to Google. No worker details, workflow notes, arbitrary prompts or tools are sent. Current and retained evidence remain distinct. Each paragraph must cite a known source. Citation existence is validated; factual entailment still requires human review. Model output cannot change scores or records.

Hosted AI calls use a shared 30-request daily cap persisted with conditional writes. Failed calls consume quota. Requests use fixed questions and server-selected synthetic evidence. Missing configuration and upstream errors are shown honestly. Live provider access and answer quality still need verification.

API reference: https://ai.google.dev/gemini-api/docs/generate-content/structured-output

Local workflow records persist independently in ignored .minetech-data/workspace.json with exclusive write locking and optimistic concurrency checks. On Vercel, a dedicated MineTech Blob store persists records with conditional writes. The Expo store is never shared. A process crash during a write may leave write.lock; stop all local servers and inspect the data before removing this lock.

## Remaining milestones

- Fresh simulator runs connected to the UI.
- Offline inspection/check-in queue with idempotent synchronization.
- Supervisor follow-up ownership and readable exports.
- Accounts, permissions and AI usage controls.
- Unseen simulator scenarios, practitioner feedback and live Gemini evaluation.

All original safety boundaries remain. No field-validation claims, hardware, automatic evacuation, equipment control or zone clearance.

Dedicated private repository: https://github.com/harrymakoni-netizen/foresight-minetech (main).
