"""Cage and hoist evacuation (spec 9.7), discrete-event model on SimPy.

One cage serves level queues through a shared resource. Everything is
deterministic: no random numbers, so identical input gives identical output.

Cycle (cage starts each cycle at the surface):
    down trip (level trip seconds) -> loading dwell -> up trip -> unloading dwell.
A person counts as at the surface when unloading finishes.

Rules (all reported back in `assumptions`):
  * The cage serves the level whose oldest waiting person arrived earliest
    (ties: the level listed first). Boarding takes up to the cage capacity from
    the people who have arrived by the time loading starts.
  * Hoist failure: at the start of an outage everyone still waiting or in the
    cage moves to the ladderway at that level and starts climbing immediately.
    Someone in a cage that fails in transit is treated the same way; rescue of a
    stuck cage is not modelled.
  * A person who arrives while the hoist is out of service for good uses the
    ladderway at once; if the outage ends, they wait for the cage.
  * The ladderway takes any number of climbers at once and every climb takes the
    entered ladder climb time. With no climb time entered, ladder users are
    reported as "not reached" (never guessed).
  * Unloading takes the entered unload time; when none is entered it is taken as
    equal to the loading time (stated, not measured).
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Callable

import simpy

ENGINE = "cage-simpy-1.0.0"
MAX_PEOPLE = 2000


def _num(x: Any, name: str, lo: float, hi: float) -> float:
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not (lo <= x <= hi):
        raise ValueError(f"{name} must be a number between {lo} and {hi}")
    return float(x)


def validate(data: dict) -> None:
    shaft = data.get("shaft")
    if not isinstance(shaft, dict):
        raise ValueError("shaft is required")
    cap = _num(shaft.get("cageCapacity"), "cage capacity", 1, 200)
    if cap != int(cap):
        raise ValueError("cage capacity must be a whole number")
    _num(shaft.get("loadingSeconds"), "loading seconds", 0, 3600)
    if shaft.get("unloadSeconds") is not None:
        _num(shaft["unloadSeconds"], "unload seconds", 0, 3600)
    if shaft.get("ladderClimbSeconds") is not None:
        _num(shaft["ladderClimbSeconds"], "ladder climb seconds", 1, 36000)
    levels = shaft.get("levels")
    if not isinstance(levels, list) or not 1 <= len(levels) <= 50:
        raise ValueError("at least one level with a trip time is required")
    names = set()
    for lv in levels:
        _num(lv.get("tripSeconds"), "trip seconds", 1, 7200)
        if not lv.get("level") or lv["level"] in names:
            raise ValueError("levels need unique names")
        names.add(lv["level"])
    arrivals = data.get("arrivals")
    if not isinstance(arrivals, list) or not 1 <= len(arrivals) <= MAX_PEOPLE:
        raise ValueError(f"between 1 and {MAX_PEOPLE} people must be waiting")
    ids = set()
    for a in arrivals:
        if a.get("level") not in names:
            raise ValueError(f"person {a.get('id')} is at an unknown level")
        _num(a.get("atSeconds"), "arrival seconds", 0, 1e6)
        if not a.get("id") or a["id"] in ids:
            raise ValueError("people need unique ids")
        ids.add(a["id"])
    for o in data.get("outages") or []:
        f = _num(o.get("fromSeconds"), "outage start", 0, 1e6)
        if o.get("toSeconds") is not None and _num(o["toSeconds"], "outage end", 0, 1e6) <= f:
            raise ValueError("an outage must end after it starts")
    _num(data.get("horizonSeconds"), "horizon", 60, 86400)


def _simulate(data: dict, outages: list[dict]) -> dict:
    shaft = data["shaft"]
    capacity = int(shaft["cageCapacity"])
    load_s = float(shaft["loadingSeconds"])
    unload_s = float(shaft["unloadSeconds"]) if shaft.get("unloadSeconds") is not None else load_s
    ladder_s = float(shaft["ladderClimbSeconds"]) if shaft.get("ladderClimbSeconds") is not None else None
    horizon = float(data["horizonSeconds"])
    level_order = [lv["level"] for lv in shaft["levels"]]
    trip = {lv["level"]: float(lv["tripSeconds"]) for lv in shaft["levels"]}
    outs = sorted(({"from": float(o["fromSeconds"]), "to": None if o.get("toSeconds") is None else float(o["toSeconds"])} for o in outages), key=lambda o: o["from"])

    env = simpy.Environment()
    cage = simpy.Resource(env, capacity=1)  # the single hoist
    people = {a["id"]: {"id": a["id"], "name": a.get("name"), "level": a["level"], "arrivedAt": float(a["atSeconds"]), "route": None,
                        "surfaceAt": None, "reason": None, "cageTrips": 0, "movedToLadderAt": None, "aboardAt": None} for a in data["arrivals"]}
    waiting: dict[str, list[str]] = {lv: [] for lv in level_order}
    series: dict[str, list[list[float]]] = {lv: [[0.0, 0]] for lv in level_order}
    cycles: list[dict] = []
    aboard: list[str] = []
    wake = {"event": env.event()}

    def note(level: str) -> None:
        n = len(waiting[level])
        if series[level][-1][1] != n or series[level][-1][0] != env.now:
            if series[level][-1][0] == env.now:
                series[level][-1][1] = n
            else:
                series[level].append([env.now, n])

    def out_at(t: float):
        for o in outs:
            if o["from"] <= t and (o["to"] is None or t < o["to"]):
                return o
        return None

    def next_outage_start(t: float):
        later = [o["from"] for o in outs if o["from"] > t]
        return min(later) if later else None

    def to_ladder(pid: str, at: float) -> None:
        p = people[pid]
        p["route"] = "ladder"
        p["movedToLadderAt"] = at
        if ladder_s is None:
            p["reason"] = "ladder climb time is not entered"
        else:
            p["surfaceAt"] = at + ladder_s

    def arrival(pid: str):
        p = people[pid]
        yield env.timeout(p["arrivedAt"])
        o = out_at(env.now)
        if o is not None and o["to"] is None:
            to_ladder(pid, env.now)
            return
        waiting[p["level"]].append(pid)
        note(p["level"])
        if not wake["event"].triggered:
            wake["event"].succeed()

    fail_done = [env.event() for _ in outs]

    def failure(index: int):
        yield env.timeout(outs[index]["from"])
        # Let anything finishing at this very instant (a cage reaching the
        # surface, an arrival) settle first.
        yield env.timeout(0)
        moved = [*aboard]
        aboard.clear()
        for lv in level_order:
            moved += waiting[lv]
            waiting[lv] = []
            note(lv)
        for pid in moved:
            to_ladder(pid, env.now)
        fail_done[index].succeed()
        if not wake["event"].triggered:
            wake["event"].succeed()

    def next_outage(t: float):
        for i, o in enumerate(outs):
            if o["from"] > t:
                return i
        return None

    def dispatcher():
        while True:
            o = out_at(env.now)
            if o is not None:
                if o["to"] is None:
                    return
                yield env.timeout(o["to"] - env.now)
                continue
            ready = [(people[waiting[lv][0]]["arrivedAt"], i, lv) for i, lv in enumerate(level_order) if waiting[lv]]
            if not ready:
                wake["event"] = env.event()
                yield wake["event"]
                continue
            _, _, level = min(ready)
            start = env.now
            down = trip[level]
            cycle_end = start + 2 * down + load_s + unload_s
            nxt = next_outage(start)
            cut = outs[nxt]["from"] if nxt is not None else None
            with cage.request() as req:
                yield req
                if cut is not None and cut < cycle_end:
                    # A failure interrupts this cycle.
                    boarded: list[str] = []
                    if cut >= start + down:
                        yield env.timeout(down)
                        boarded = [pid for pid in waiting[level] if people[pid]["arrivedAt"] <= env.now][:capacity]
                        for pid in boarded:
                            waiting[level].remove(pid)
                            people[pid]["aboardAt"] = env.now
                        aboard[:] = boarded
                        note(level)
                    yield fail_done[nxt]
                    cycles.append({"startSeconds": start, "level": level, "boarded": len(boarded), "completed": False, "endSeconds": None})
                    continue
                yield env.timeout(down)
                boarded = [pid for pid in waiting[level] if people[pid]["arrivedAt"] <= env.now][:capacity]
                for pid in boarded:
                    waiting[level].remove(pid)
                    people[pid]["aboardAt"] = env.now
                aboard[:] = boarded
                note(level)
                yield env.timeout(load_s + down + unload_s)
                for pid in boarded:
                    p = people[pid]
                    p["route"] = "cage"
                    p["surfaceAt"] = env.now
                    p["cageTrips"] += 1
                aboard.clear()
                cycles.append({"startSeconds": start, "level": level, "boarded": len(boarded), "completed": True, "endSeconds": env.now})

    for pid in people:
        env.process(arrival(pid))
    for i in range(len(outs)):
        env.process(failure(i))
    env.process(dispatcher())
    env.run(until=horizon + 1e-6)

    # Anyone still waiting or aboard at the horizon was not reached.
    for pid, p in people.items():
        if p["surfaceAt"] is not None and p["surfaceAt"] > horizon:
            p["reason"] = "reaches the surface after the horizon"
            p["surfaceAt"] = None
        if p["surfaceAt"] is None and p["reason"] is None:
            p["reason"] = ("in the cage at the horizon" if p["aboardAt"] is not None else "still waiting for the cage at the horizon") if p["route"] is None else "not at the surface by the horizon"
    return {"people": list(people.values()), "queueSeries": [{"level": lv, "points": series[lv]} for lv in level_order], "cycles": cycles}


def _summary(sim: dict) -> dict:
    people = sim["people"]
    reached = [p for p in people if p["surfaceAt"] is not None]
    cage = [p for p in reached if p["route"] == "cage"]
    ladder = [p for p in reached if p["route"] == "ladder"]
    not_reached = [p for p in people if p["surfaceAt"] is None]
    last = max((p["surfaceAt"] for p in reached), default=None)
    return {
        "totals": {"people": len(people), "byCage": len(cage), "byLadder": len(ladder), "notReached": len(not_reached),
                   "balanced": len(people) == len(cage) + len(ladder) + len(not_reached)},
        # "Not reached" when anyone is missing; the last reached time is kept separately.
        "lastSurfaceSeconds": last if not not_reached else None,
        "lastReachedSeconds": last,
    }


def run(data: dict, cancelled: Callable[[], bool] = lambda: False) -> dict:
    validate(data)
    outages = list(data.get("outages") or [])
    with_failure = _simulate(data, outages)
    summary = _summary(with_failure)
    baseline = _summary(_simulate(data, [])) if outages else None
    effect = None
    if baseline is not None:
        b, w = baseline["lastSurfaceSeconds"], summary["lastSurfaceSeconds"]
        effect = {
            "baselineLastSurfaceSeconds": b,
            "withFailureLastSurfaceSeconds": w,
            "delaySeconds": (w - b) if (w is not None and b is not None) else None,
            "movedToLadder": sum(1 for p in with_failure["people"] if p["movedToLadderAt"] is not None),
            "baseline": baseline["totals"],
        }
    ladder_known = data["shaft"].get("ladderClimbSeconds") is not None
    assumptions = [
        "People are ready to ride at their level from the stated arrival time; no walking is modelled here.",
        "One cage, deterministic times, no randomness. Cycle = down trip + loading + up trip + unloading; a person is at the surface when unloading finishes.",
        f"Unloading takes {'the entered ' + str(data['shaft']['unloadSeconds']) + ' s' if data['shaft'].get('unloadSeconds') is not None else 'the same time as loading (' + str(data['shaft']['loadingSeconds']) + ' s): no separate unloading time is entered'}.",
        "The cage serves the level whose oldest waiting person arrived earliest and boards up to its capacity from people already there when loading starts.",
        "Hoist failure: everyone waiting or in the cage moves to the ladderway at their level and starts climbing at once; rescue of a cage stuck in transit is not modelled.",
        "The ladderway takes any number of climbers at once; each climb takes the entered ladder climb time" + ("." if ladder_known else "; none is entered, so ladder users are reported as not reached."),
    ]
    warnings = []
    if outages and not ladder_known:
        warnings.append("Ladder climb time is not entered: people moved to the ladderway are counted as not reached.")
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"))
    return {
        "status": "completed",
        "engine": ENGINE,
        "simpy": simpy.__version__,
        "inputHash": hashlib.sha256(canonical.encode()).hexdigest(),
        **summary,
        "people": with_failure["people"],
        "queueSeries": with_failure["queueSeries"],
        "cycles": with_failure["cycles"],
        "outages": outages,
        "effect": effect,
        "assumptions": assumptions,
        "warnings": warnings,
        "horizonSeconds": data["horizonSeconds"],
    }
