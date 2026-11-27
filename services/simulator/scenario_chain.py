"""Scenario chain (spec §9): flooding → timed tunnel closures → escape →
endurance checks, plus the Time to act search (§9.6).

One-way handoff, not a coupled simulation: the unchanged lumped-water engine
finds when the sump reaches its danger level; the tunnels the mine model says
that sump floods close from that instant; the escape engine then moves people
with those closures. Every number in the result comes from these runs or from
the stated arithmetic with its inputs.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math

from . import engine, escape
from . import network as net

CHAIN_VERSION = "flood-escape-chain-1.0.0"
TTA_VERSION = "time-to-act-scan-1.0.0"
WATER_ZONES = {"zone-a", "zone-b", "zone-c"}  # lumped-water-1.0.0 accepts only these labels


class ChainInputError(ValueError):
    pass


def _hash(x):
    return hashlib.sha256(json.dumps(x, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def water_scenario(inp: dict) -> tuple[dict, dict]:
    """Build a lumped-water-1.0.0 input from the mine model sump and pumps."""
    m, w = inp["model"], inp["water"]
    sump = next((s for s in m["sumps"] if s["id"] == w["sumpId"]), None)
    if sump is None:
        raise ChainInputError(f"sump {w['sumpId']} is not in the mine model")
    pumps = [p for p in m["pumps"] if p["sumpId"] == sump["id"]]
    duty = next((p for p in pumps if p["id"] == w["dutyPumpId"]), None)
    backup = next((p for p in pumps if p["id"] == w.get("backupPumpId")), None) if w.get("backupPumpId") else None
    if duty is None:
        raise ChainInputError(f"pump {w['dutyPumpId']} does not serve sump {sump['id']}")
    missing = []
    inflow = w.get("inflowM3h", sump.get("inflowM3h"))
    initial = w.get("initialVolumeM3", sump.get("initialVolumeM3"))
    for label, value in (("sump inflow", inflow), ("sump starting volume", initial), ("sump danger level", sump.get("dangerLevelM")),
                         (f"{duty['id']} capacity", duty.get("capacityM3h"))) + (((f"{backup['id']} capacity", backup.get("capacityM3h")),) if backup else ()):
        if value is None:
            missing.append(label)
    if len(sump.get("levelVolume", [])) < 2:
        missing.append("sump level–volume table")
    if missing:
        raise ChainInputError("missing inputs block the flooding engine: " + ", ".join(missing))
    zone = next((z["id"] for z in m["zones"] if any(t in z["tunnelIds"] for t in sump.get("closesTunnelIds", []))), None)
    if zone not in WATER_ZONES:
        raise ChainInputError(f"lumped-water-1.0.0 labels storage with zone-a/b/c only; sump {sump['id']} is in {zone!r}")
    geometry = [{"volumeM3": r["volumeM3"], "levelM": r["levelM"]} for r in sump["levelVolume"]]
    events = [{"type": "pump_availability", "atSeconds": float(w["failAtSeconds"]), "pumpId": duty["id"], "available": False}]
    if backup and w.get("backupStartSeconds") is not None:
        events.append({"type": "pump_availability", "atSeconds": float(w["backupStartSeconds"]), "pumpId": backup["id"], "available": True})
    events.sort(key=lambda e: e["atSeconds"])
    horizon = float(inp["params"].get("horizonSeconds", 3600))
    pump_list = [{"id": duty["id"], "nodeId": sump["id"], "capacityM3s": duty["capacityM3h"] / 3600, "available": True, "startLevelM": None, "stopLevelM": None}]
    if backup:
        pump_list.append({"id": backup["id"], "nodeId": sump["id"], "capacityM3s": backup["capacityM3h"] / 3600, "available": False, "startLevelM": None, "stopLevelM": None})
    provenance = [{"id": x, "source": "mine model revision " + str(inp.get("mineModelRevisionId", "")), "quality": (m.get("provenance", {}).get(f"{x}.capacityM3h" if x != sump["id"] else f"{x}.inflowM3h", {}).get("quality") or "assumed").replace("survey-plan", "measured").replace("default", "assumed")} for x in [sump["id"]] + [p["id"] for p in pump_list]]
    scenario = {
        "schemaVersion": "1.0", "workspaceId": inp["workspaceId"], "baselineSnapshotId": inp.get("mineModelRevisionId", "model"),
        "modelId": "lumped-water-v1", "modelVersion": engine.ENGINE_VERSION, "timeOrigin": inp["timeOrigin"],
        "horizonSeconds": horizon, "outputIntervalSeconds": max(10.0, horizon / 360), "maxStepSeconds": 5, "seed": int(inp["params"].get("seed", 1)),
        "units": {"volume": "m3", "level": "m", "time": "s", "flow": "m3/s"},
        "nodes": [{"id": sump["id"], "zoneId": zone, "geometry": geometry, "initialVolumeM3": float(initial), "inflowM3s": float(inflow) / 3600}],
        "pumps": pump_list, "transfers": [], "events": events,
        "thresholds": [{"id": "danger", "nodeId": sump["id"], "levelM": float(sump["dangerLevelM"]), "edgeIds": [], "label": f"{sump['name']} danger level", "source": "mine model danger level (" + (m.get("provenance", {}).get(f"{sump['id']}.dangerLevelM", {}).get("quality") or "no provenance") + ")"}],
        "routeGraph": {"version": "none", "nodes": [], "edges": []}, "movements": [], "provenance": provenance,
    }
    return scenario, sump


def run_chain(raw: dict, cancelled=lambda: False, trajectories=True) -> dict:
    inp = copy.deepcopy(raw)
    for k in ("workspaceId", "model", "people", "params", "water", "timeOrigin"):
        if k not in inp:
            raise ChainInputError(f"{k} is required")
    digest = _hash(inp)
    warnings = []
    water, sump = water_scenario(inp)
    flood = engine.solve(water, cancelled)
    if flood.get("status") != "completed":
        return {"status": flood.get("status", "failed"), "chainVersion": CHAIN_VERSION, "inputHash": digest}
    crossing = flood["thresholds"][0]["firstCrossingSeconds"]
    closures = [{"tunnelId": t, "atSeconds": crossing, "source": f"{sump['name']} reached {sump['dangerLevelM']} m at {crossing:.0f} s (flooding engine)"} for t in sump.get("closesTunnelIds", [])] if crossing is not None else []
    closures += [{"tunnelId": c["tunnelId"], "atSeconds": float(c["atSeconds"]), "source": c.get("source", "user-blocked tunnel")} for c in inp.get("extraClosures", [])]
    params = dict(inp["params"], recordTrajectories=trajectories)
    esc = escape.run({"network": inp["network"], "people": inp["people"], "closures": closures, "params": params}, cancelled)
    if esc.get("status") != "completed":
        return {"status": esc.get("status"), "chainVersion": CHAIN_VERSION, "inputHash": digest}
    level = [{"t": s["atSeconds"], "levelM": round(s["nodes"][sump["id"]]["levelM"], 4)} for s in flood["series"]]
    result = {
        "status": "completed", "chainVersion": CHAIN_VERSION, "inputHash": digest,
        "engines": {"flooding": engine.ENGINE_VERSION, "escape": escape.ENGINE_VERSION, "jupedsim": esc["adapter"]["version"]},
        "mineModelRevisionId": inp.get("mineModelRevisionId"), "seed": esc["seed"],
        "flooding": {"sumpId": sump["id"], "dangerLevelM": sump["dangerLevelM"], "firstDangerSeconds": crossing,
                     "peakLevelM": max(p["levelM"] for p in level), "series": level, "inputHash": flood["inputHash"],
                     "conservationResidualM3": flood["diagnostics"]["conservationResidualM3"], "warnings": flood["warnings"]},
        "closures": closures,
        "escape": {k: v for k, v in esc.items() if k != "trajectories"},
        "endurance": endurance(inp, esc),
        "warnings": warnings + ["One-way handoff: flooding closes tunnels at a time; it is not a coupled simulation.",
                                "Planning calculation under stated assumptions. Simulated arrival never marks a real person accounted for."],
    }
    if trajectories:
        result["trajectories"] = esc["trajectories"]
        result["playback"] = playback(esc)
        result["congestion"] = congestion(inp, esc)
    return result


def endurance(inp: dict, esc: dict) -> dict:
    """Spec §9.5: endurance checks, not survival times. Inputs are shown."""
    e = inp.get("endurance", {}) or {}
    out = {"label": "Endurance check — not a survival time", "selfRescuer": None, "refuges": []}
    rated = e.get("selfRescuerRatedMinutes")
    if rated is None:
        out["selfRescuer"] = {"available": False, "reason": "Self-rescuer rated duration not entered"}
    else:
        rows = []
        for p in esc["people"]:
            if p["outcome"] in ("reached-exit", "reached-refuge"):
                walking = (p["atSeconds"] - p["releaseSeconds"]) / 60
                rows.append({"id": p["id"], "name": p["name"], "walkingMinutes": round(walking, 1), "exceedsRated": walking > rated})
        out["selfRescuer"] = {"available": True, "ratedMinutes": rated, "formula": "modelled walking time (arrival − release) compared with rated duration", "people": rows,
                              "exceeding": [r["name"] or r["id"] for r in rows if r["exceedsRated"]]}
    consumption = e.get("refugeConsumptionM3PerPersonHour")
    occupants = {}
    for p in esc["people"]:
        if p["outcome"] == "reached-refuge":
            occupants[p["targetId"]] = occupants.get(p["targetId"], 0) + 1
    for r in inp["model"].get("refuges", []):
        n = occupants.get(r["id"], 0)
        if r.get("airSupplyM3") is None or consumption is None:
            out["refuges"].append({"id": r["id"], "name": r["name"], "occupants": n, "available": False,
                                   "reason": "Air supply or consumption per person not entered"})
        elif n == 0:
            out["refuges"].append({"id": r["id"], "name": r["name"], "occupants": 0, "available": True, "airHours": None, "note": "No modelled occupants"})
        else:
            hours = r["airSupplyM3"] / (n * consumption)
            out["refuges"].append({"id": r["id"], "name": r["name"], "occupants": n, "available": True, "airHours": round(hours, 2),
                                   "formula": f"{r['airSupplyM3']} m³ ÷ ({n} × {consumption} m³/person/h)"})
    return out


def playback(esc: dict, every=5.0) -> dict:
    """Browser derivative of the source trajectories (kept separately): one
    point per person every `every` seconds."""
    tr = esc.get("trajectories") or {}
    paths: dict[int, list] = {}
    last: dict[int, float] = {}
    for t, p, x, y in zip(tr.get("t", []), tr.get("p", []), tr.get("x", []), tr.get("y", [])):
        if p not in last or t - last[p] >= every - 1e-6:
            paths.setdefault(p, []).append([round(t, 1), round(x, 1), round(y, 1)])
            last[p] = t
    people = esc["people"]
    return {"every": every, "people": [{"id": people[i]["id"], "name": people[i]["name"], "outcome": people[i]["outcome"],
                                         "start": people[i]["start"], "endAt": people[i]["atSeconds"], "path": paths.get(i, [])} for i in range(len(people))]}


def congestion(inp: dict, esc: dict) -> dict:
    """PedPy analysis at each exit or refuge approach and at narrow tunnels."""
    try:
        import pandas as pd
        import pedpy
    except ImportError as e:  # pragma: no cover
        return {"available": False, "reason": f"PedPy unavailable: {e}"}
    tr = esc.get("trajectories")
    if not tr or not tr["t"]:
        return {"available": False, "reason": "No trajectories recorded"}
    step = esc["adapter"]["dt"]
    every = round(min(b - a for a, b in zip(sorted(set(tr["t"])), sorted(set(tr["t"]))[1:])) if len(set(tr["t"])) > 1 else 1.0, 3)
    df = pd.DataFrame({"id": tr["p"], "frame": [round(t / every) for t in tr["t"]], "x": tr["x"], "y": tr["y"]})
    data = pedpy.TrajectoryData(data=df, frame_rate=1 / every)
    junctions, tunnels = net.parse(inp["network"])
    lines = []
    for target in inp["network"].get("exits", []) + inp["network"].get("refuges", []):
        for t in tunnels.values():
            if target["junction"] in (t.a, t.b) and t.walkable:
                lines.append((f"approach to {target.get('id')} via {t.id}", t, target["junction"], 4.0))
    for t in tunnels.values():
        if t.walkable and t.width <= 2.5:
            lines.append((f"narrow tunnel {t.id} ({t.width} m)", t, None, None))
    out = []
    for label, t, end, offset in lines:
        (ax, ay), (bx, by) = t.line.coords
        if end == t.a:
            (ax, ay), (bx, by) = (bx, by), (ax, ay)
        length = t.line.length
        frac = 0.5 if offset is None else max(0.05, 1 - offset / length)
        cx, cy = ax + (bx - ax) * frac, ay + (by - ay) * frac
        nx, ny = -(by - ay) / length, (bx - ax) / length
        half = t.width / 2 - 0.05
        try:
            line = pedpy.MeasurementLine([(cx - nx * half, cy - ny * half), (cx + nx * half, cy + ny * half)])
            nt, crossing = pedpy.compute_n_t(traj_data=data, measurement_line=line)
        except Exception as e:  # geometry/sampling edge cases are reported, not hidden
            out.append({"line": label, "available": False, "reason": str(e)[:200]})
            continue
        frames = sorted(float(f) * every for f in crossing["frame"]) if len(crossing) else []
        if not frames:
            continue
        peak = max(sum(1 for g in frames if f <= g < f + 60) for f in frames)
        out.append({"line": label, "crossings": len(frames), "firstSeconds": frames[0], "lastSeconds": frames[-1], "peakPerMinute": peak})
    return {"available": True, "method": f"PedPy {pedpy.__version__} N-t at measurement lines; trajectories sampled every {every} s (simulation dt {step} s)", "lines": out}


def time_to_act(raw: dict, cancelled=lambda: False, progress=lambda x: None) -> dict:
    """Spec §9.6: full scan of backup start times. Success (default): every
    simulated person reaches an exit or refuge before the horizon."""
    study = copy.deepcopy(raw)
    a, b, step = float(study["fromSeconds"]), float(study["toSeconds"]), float(study["stepSeconds"])
    if not (0 <= a <= b) or step <= 0:
        raise ChainInputError("search interval must satisfy 0 ≤ from ≤ to and step > 0")
    values = [a + i * step for i in range(int(math.floor((b - a) / step + 1e-9)) + 1)]
    if len(values) > 40:
        raise ChainInputError("at most 40 tested values per study")
    rows = []
    for i, v in enumerate(values):
        if cancelled():
            return {"status": "cancelled", "version": TTA_VERSION}
        chain = copy.deepcopy(study["chain"])
        chain["water"]["backupStartSeconds"] = v
        r = run_chain(chain, cancelled, trajectories=False)
        t = r["escape"]["totals"]
        ok = t["cut-off"] == 0 and t["still-walking"] == 0
        rows.append({"backupStartSeconds": v, "success": ok, "cutOff": t["cut-off"], "stillWalking": t["still-walking"],
                     "reachedSafety": t["reached-exit"] + t["reached-refuge"], "simulated": t["simulated"],
                     "firstDangerSeconds": r["flooding"]["firstDangerSeconds"], "t100": r["escape"]["times"]["t100"], "inputHash": r["inputHash"]})
        progress((i + 1) / len(values))
    successes = [r for r in rows if r["success"]]
    flags = [r["success"] for r in rows]
    monotone = all(not (flags[i + 1] and not flags[i]) for i in range(len(flags) - 1))
    if not successes:
        outcome, latest = "no tested value met the condition", None
    elif all(flags):
        outcome, latest = "boundary not reached in the tested range", successes[-1]["backupStartSeconds"]
    else:
        outcome, latest = "boundary found", successes[-1]["backupStartSeconds"]
    return {"status": "completed", "version": TTA_VERSION, "chainVersion": CHAIN_VERSION, "variable": "backupStartSeconds",
            "fromSeconds": a, "toSeconds": b, "stepSeconds": step, "testedCount": len(values),
            "condition": "every simulated person reaches an exit or refuge before the horizon", "method": "full scan of every tested value",
            "monotonic": monotone, "outcome": outcome, "latestSuccessSeconds": latest, "rows": rows,
            "note": None if monotone else "Success was not monotonic in the backup start time; read the full table, not just the latest value.",
            "inputHash": _hash(study)}
