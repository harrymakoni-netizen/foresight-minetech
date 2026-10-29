# Three-minute fictional demonstration

Use a fresh isolated browser workspace. Prerequisite: database/auth and simulator are healthy. AI is optional; actual PPE and reconstruction demonstrations require the real dependencies below. Never use real worker records for this script.

**0:00–0:35 · Submit evidence.** Evidence → Reports. Submit exactly:

> At East development, pump P1 stopped and water was observed rising near the sump. No water depth or inflow was measured.

Open the saved report. If the configured provider is available, extract proposals. Expect separate pump-stoppage and rising-water proposals with exact quotes. Check that depth, inflow, worker location and observation time are unknown. No measurement is not zero. If extraction is unavailable, show its visible status and enter those facts manually; state clearly that no AI call succeeded. Original report remains preserved.

**0:35–1:00 · Human review.** Inspect category, source quotes, polarity and observed/proposed/completed action fields. Remove any unsupported proposal. Accept only reviewed facts. Command Centre shows a new assessment based on those accepted observations; extracting alone never does. Observation time must not silently become submission time.

**1:00–1:45 · Change conditions and calculate.** Simulator Lab → Clone current workspace → expand “Fictional pump-failure exercise” → Load fictional pump-failure exercise. State the assumptions shown: initial 30 m³, inflow 18 m³/h, storage area 30 m²/capacity 150 m³, primary 12 m³/h fails at 1 h, backup 24 m³/h, six-hour horizon. The failure time and physical values are fictional, not inferred from the report. Accept the exercise assumptions. Run delayed backup (4 h): final **78 m³**, peak **3 m**, threshold **2 m at 2 h 20 min**. Then run earlier backup (1 h): final **6 m³**, peak **1.2 m**, threshold not crossed. Comparison is automatic after the first completed run, with matched chart axes.

**1:45–2:15 · Inspect affected routes.** In Thresholds and routes, delayed pumping selects `east-south → south-junction → exit` (**1,050 s**). Departure is assumed at **2 h 18 min**; the direct 300 s edge would overlap the 2 h 20 min restriction, so availability at departure alone is insufficient. Earlier backup permits `east-direct → exit` (**500 s**). Mine Map → choose the delayed run as Laboratory overlay → scrub across the crossing to see the direct route restriction. Neither path establishes route safety or actual arrival. Blocking the alternative as well produces “No route found under assumptions.”

**2:15–2:45 · Record the human response.** Return to a completed run → Document a human response. Enter a fictional owner, due time and rationale; create a linked response case. People and Response → Cases and actions → open it. Show preserved run ID, assumptions and results. Add the intended action/review plan. The action does not change pump controls, apply laboratory results to operational assessments or confirm muster.

**2:45–3:00 · Show honest integration status.** Evidence → Vision: if no compatible licensed model is loaded, show unavailable controls. If configured with actual consented footage, queue the MP4 before this timed demonstration, then show timestamped source frames, all three assessment states, supervisor confirmation/dismissal and a linked response. Mine Map → Reconstructed area: show a pre-imported real consented asset with provenance, method, coverage, scale status and reset controls, or explicitly show “No reconstruction imported.” Do not substitute test fixtures or invent inference/reconstruction results.

The older numerical example remains available through a normal clone: 30 m³ initially, 18 m³/h inflow, primary 12 m³/h, six hours; baseline **66 m³**, additional **12 m³/h** backup at one hour **6 m³**. This differs deliberately from the failure exercise's **24 m³/h** backup; use the displayed assumptions when comparing.
