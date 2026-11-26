# Three-minute demo (spec §16.2)

One continuous story on the **fictional training mine**. Every number on screen comes from a recorded run. If the venue network fails, show a saved run and say it is saved.

Automated rehearsal of the whole story: `npm run build && npm run setup:sim && npm run test:demo` (isolated database, allow-list to two unassigned `+999` numbers, mock SMS gateway, a test WhatsApp app secret used only to sign the test's webhooks). It passed on 2026-11-17.

1. **Check in live (30 s).** A test phone sends `IN` on WhatsApp → shaft 2 → return time → buddy 1. The reply quotes a reference; Underground now shows the person as *declared underground* at East incline. (Real phones need WhatsApp Cloud API credentials and approved templates; see `docs/MESSAGING_SETUP.md`.)
2. **The failure (30 s).** Concerns → **New report**: submit "Pump P1 stopped at East development", review it (equipment P1, serious) and accept. Open step 2, *Concerns*: the concern shows how many people are declared in that zone (Underground now also shows "1 concern to review"). Click **Run scenario**: the builder opens pre-filled with P1 and current declarations.
3. **The consequence (45 s).** Set *Evacuation ordered at* 100 min and run. The sump reaches its 2 m danger level at 1 h 40 min and closes T4 and T6; named people are *cut off from assumed start in East development*; totals balance (simulated = exit + refuge + cut off + still walking). Use the timeline marker *Route floods*.
4. **Time to act (30 s).** *Find latest backup start* (60–120 min, 5 min steps): "Latest tested backup start under these assumptions: … (searched 1 h 00 min to 2 h 00 min in 13 steps of 5 min)".
5. **The alert (30 s).** When the return time passes the buddy gets an SMS through SMSGate; Underground now shows the escalation step and *Delivered* only after a delivery receipt; a muster opens for the shaft. For rehearsal, `npm run messaging:tick -- --at <time>` advances the scheduler.
6. **The record (15 s).** *Declare emergency* at East incline: the rescue roll lists everyone declared there with buddy and phone; *Export incident PDF*.

Close: "A test phone was checked in, put at risk in a planning calculation and accounted for, with no app to install and no signal needed underground."

What not to claim: live tracking, safety certification, a validated model of a real mine, or delivered messages without receipts.

## Appendix: earlier water-laboratory demonstration (still valid under Scenarios → Water laboratory)


Use a fresh isolated browser workspace. Prerequisite: database/auth and simulator are healthy. AI is optional; actual PPE and reconstruction demonstrations require the real dependencies below. Never use real worker records for this script.

**0:00–0:35 · Submit evidence.** Concerns → New report. Submit exactly:

> At East development, pump P1 stopped and water was observed rising near the sump. No water depth or inflow was measured.

Open the saved report. If the configured provider is available, extract proposals. Expect separate pump-stoppage and rising-water proposals with exact quotes. Check that depth, inflow, worker location and observation time are unknown. No measurement is not zero. If extraction is unavailable, show its visible status and enter those facts manually; state clearly that no AI call succeeded. Original report remains preserved.

**0:35–1:00 · Human review.** Inspect category, source quotes, polarity and observed/proposed/completed action fields. Remove any unsupported proposal. Accept only reviewed facts. Concerns → step 2 shows a new assessment based on those accepted observations; extracting alone never does. Observation time must not silently become submission time.

**1:00–1:45 · Change conditions and calculate.** Simulator Lab → Clone current workspace → expand “Fictional pump-failure exercise” → Load fictional pump-failure exercise. State the assumptions shown: initial 30 m³, inflow 18 m³/h, storage area 30 m²/capacity 150 m³, primary 12 m³/h fails at 1 h, backup 24 m³/h, six-hour horizon. The failure time and physical values are fictional, not inferred from the report. Accept the exercise assumptions. Run delayed backup (4 h): final **78 m³**, peak **3 m**, threshold **2 m at 2 h 20 min**. Then run earlier backup (1 h): final **6 m³**, peak **1.2 m**, threshold not crossed. Comparison is automatic after the first completed run, with matched chart axes.

**1:45–2:15 · Inspect affected routes.** In Thresholds and routes, delayed pumping selects `east-south → south-junction → exit` (**1,050 s**). Departure is assumed at **2 h 18 min**; the direct 300 s edge would overlap the 2 h 20 min restriction, so availability at departure alone is insufficient. Earlier backup permits `east-direct → exit` (**500 s**). Mine Map → choose the delayed run as Laboratory overlay → scrub across the crossing to see the direct route restriction. Neither path establishes route safety or actual arrival. Blocking the alternative as well produces “No route found under assumptions.”

**2:15–2:45 · Record the human response.** Return to a completed run → Document a human response. Enter a fictional owner, due time and rationale; create a linked response case. People and Response → Cases and actions → open it. Show preserved run ID, assumptions and results. Add the intended action/review plan. The action does not change pump controls, apply laboratory results to operational assessments or confirm muster.

**2:45–3:00 · Show honest integration status.** Evidence → Vision: if no compatible licensed model is loaded, show unavailable controls. If configured with actual consented footage, queue the MP4 before this timed demonstration, then show timestamped source frames, all three assessment states, supervisor confirmation/dismissal and a linked response. Mine Map → Reconstructed area: show a pre-imported real consented asset with provenance, method, coverage, scale status and reset controls, or explicitly show “No reconstruction imported.” Do not substitute test fixtures or invent inference/reconstruction results.

The older numerical example remains available through a normal clone: 30 m³ initially, 18 m³/h inflow, primary 12 m³/h, six hours; baseline **66 m³**, additional **12 m³/h** backup at one hour **6 m³**. This differs deliberately from the failure exercise's **24 m³/h** backup; use the displayed assumptions when comparing.
