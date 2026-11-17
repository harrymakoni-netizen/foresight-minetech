"""Escape engine (spec §9.4): JuPedSim agents on walkable polygons generated
from the tunnel network, with timed tunnel closures handed over one way from
the flooding/route engines.

Method (recorded with every result):
* Walkable area = union of open walkable tunnel polygons (network.py).
* The run is split at every closure time. At each split the remaining agents'
  positions are frozen, the walkable area is rebuilt without the closed
  tunnels and its connected parts are found. An agent standing only inside a
  closed tunnel is counted as cut off ("in tunnel T when it closed"). An agent
  in a part with no reachable exit or refuge is counted as cut off ("no route
  from position"). Everyone else continues in a fresh JuPedSim simulation of
  their part, starting from rest at the frozen position. Restarting from rest
  is a stated approximation.
* Each agent heads for the reachable exit or refuge with the shortest walkable
  path (JuPedSim routing engine). Refuges are only chosen while they have
  entered capacity left.
* Start positions: either user-placed, or "spread-along-zone": seeded
  jupedsim.distribute_by_number over the zone's walkable area. The method,
  seed and resulting coordinates are stored with the run.
* Pre-movement: agent stands still (desired speed 0) until alarm delay +
  seeded uniform pre-movement delay, then walks at a seeded truncated-normal
  desired speed.
Accounting rule, checked on every run:
  simulated = reached exit + reached refuge + cut off + still walking.
Results are planning calculations from assumed start positions. A modelled
arrival never marks a real person accounted for.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import random
import time

import jupedsim as jps
from shapely.geometry import Point
from shapely.ops import nearest_points, unary_union

from . import network as net

ENGINE_VERSION = "escape-jupedsim-1.0.0"
MAX_PEOPLE, MAX_HORIZON_S = 500, 6 * 3600
OUTCOMES = ("reached-exit", "reached-refuge", "cut-off", "still-walking")


class EscapeInputError(ValueError):
    pass


def input_hash(s) -> str:
    return hashlib.sha256(json.dumps(s, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def _num(v, label, low, high):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not low <= v <= high:
        raise EscapeInputError(f"{label} must be a finite number in [{low}, {high}]")
    return float(v)


def validate(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise EscapeInputError("escape input must be an object")
    s = copy.deepcopy(raw)
    try:
        junctions, tunnels = net.parse(s.get("network"))
    except net.NetworkError as e:
        raise EscapeInputError(str(e)) from e
    crossings = net.plan_crossings(junctions, tunnels)
    if crossings:
        raise EscapeInputError(
            "tunnels overlap in plan without a shared junction (" + ", ".join(f"{a}/{b}" for a, b in crossings[:5])
            + "); 2-D escape would invent a connection. Separate them or model levels separately.")
    n = s["network"]
    targets = []
    for kind, key in (("exit", "exits"), ("refuge", "refuges")):
        for t in n.get(key, []):
            if t.get("junction") not in junctions:
                raise EscapeInputError(f"{kind} {t.get('id')} must reference a known junction")
            if kind == "exit" and t.get("usableForEscape") is False:
                continue
            cap = t.get("capacity")
            if kind == "refuge":
                if cap is None:
                    raise EscapeInputError(f"refuge {t.get('id')} capacity is not entered")
                cap = int(_num(cap, f"refuge {t.get('id')} capacity", 0, 10000))
            targets.append({"id": t["id"], "kind": kind, "junction": t["junction"], "capacity": cap})
    if not any(t["kind"] == "exit" for t in targets) and not any(t["kind"] == "refuge" for t in targets):
        raise EscapeInputError("no usable exit or refuge is defined")
    zones = {z["id"]: z for z in n.get("zones", [])}
    for z in zones.values():
        missing = [t for t in z.get("tunnelIds", []) if t not in tunnels]
        if missing or not z.get("tunnelIds"):
            raise EscapeInputError(f"zone {z['id']} must list known tunnels")
    people = s.get("people")
    if not isinstance(people, list) or not 0 < len(people) <= MAX_PEOPLE:
        raise EscapeInputError(f"people must be a list of 1..{MAX_PEOPLE}")
    ids = [p.get("id") for p in people]
    if len(set(ids)) != len(ids) or any(not isinstance(i, str) or not i for i in ids):
        raise EscapeInputError("people ids must be unique non-empty strings")
    for p in people:
        if p.get("start") is None and p.get("zoneId") not in zones:
            raise EscapeInputError(f"person {p['id']} needs a known declared zone or a placed start")
    params = s.setdefault("params", {})
    params.setdefault("seed", 1)
    params["seed"] = int(_num(params["seed"], "seed", 0, 2**31 - 1))
    params["horizonSeconds"] = _num(params.get("horizonSeconds", 3600), "horizonSeconds", 1, MAX_HORIZON_S)
    params["dt"] = _num(params.get("dt", 0.05), "dt", 0.01, 0.1)
    params["alarmDelaySeconds"] = _num(params.get("alarmDelaySeconds", 0), "alarmDelaySeconds", 0, 7200)
    pm = params.setdefault("preMovementSeconds", {"min": 0, "max": 0})
    pm["min"] = _num(pm.get("min", 0), "preMovement.min", 0, 7200)
    pm["max"] = _num(pm.get("max", 0), "preMovement.max", pm["min"], 7200)
    sp = params.setdefault("speed", {"mean": 1.0, "sd": 0.15, "min": 0.5, "max": 1.5})
    for k, lo, hi in (("mean", 0.1, 3), ("sd", 0, 1), ("min", 0.1, 3), ("max", 0.1, 3)):
        sp[k] = _num(sp.get(k), f"speed.{k}", lo, hi)
    if not sp["min"] <= sp["mean"] <= sp["max"]:
        raise EscapeInputError("speed min <= mean <= max is required")
    params["radius"] = _num(params.get("radius", 0.25), "radius", 0.1, 0.4)
    params["recordEverySeconds"] = _num(params.get("recordEverySeconds", 1.0), "recordEverySeconds", 0.2, 60)
    params.setdefault("recordTrajectories", True)
    params.setdefault("startMethod", "spread-along-zone")
    if params["startMethod"] not in ("spread-along-zone", "user-placed"):
        raise EscapeInputError("startMethod must be spread-along-zone or user-placed")
    closures = []
    for c in s.get("closures", []):
        if c.get("tunnelId") not in tunnels:
            raise EscapeInputError(f"closure references unknown tunnel {c.get('tunnelId')}")
        closures.append({"tunnelId": c["tunnelId"], "atSeconds": _num(c.get("atSeconds"), "closure time", 0, MAX_HORIZON_S),
                         "source": str(c.get("source", "user"))[:200]})
    s["closures"] = sorted(closures, key=lambda c: (c["atSeconds"], c["tunnelId"]))
    s["_parsed"] = (junctions, tunnels, targets, zones)
    return s


def _zone_positions(zone_area, count, radius, seed):
    pieces = [p for p in net.parts(zone_area)]
    total = sum(p.area for p in pieces)
    out, remaining = [], count
    for i, piece in enumerate(sorted(pieces, key=lambda p: -p.area)):
        k = remaining if i == len(pieces) - 1 else round(count * piece.area / total)
        k = min(k, remaining)
        if k <= 0:
            continue
        try:
            out += jps.distribute_by_number(polygon=piece, number_of_agents=k, distance_to_agents=2.2 * radius,
                                            distance_to_polygon=radius + 0.05, seed=seed + i, max_iterations=20000)
        except Exception as e:  # jupedsim raises AgentNumberError and friends
            raise EscapeInputError(f"declared zone cannot hold {k} people at {2.2 * radius:.2f} m spacing: {e}") from e
        remaining -= k
    return out


def _speed(rng, sp):
    if sp["sd"] == 0:
        return sp["mean"]
    for _ in range(1000):
        v = rng.gauss(sp["mean"], sp["sd"])
        if sp["min"] <= v <= sp["max"]:
            return v
    return sp["mean"]


def _path_length(points):
    return sum(math.dist(a, b) for a, b in zip(points, points[1:]))


def _quantile_time(arrivals, fraction, total):
    need = math.ceil(fraction * total - 1e-9)
    if need <= 0:
        return 0.0
    ordered = sorted(arrivals)
    return round(ordered[need - 1], 2) if len(ordered) >= need else None


def run(raw: dict, cancelled=lambda: False) -> dict:
    started = time.perf_counter()
    s = validate(raw)
    junctions, tunnels, targets, zones = s.pop("_parsed")
    digest = input_hash(s)
    p = s["params"]
    rng = random.Random(p["seed"])
    warnings = [
        "Planning calculation from assumed start positions; not live locations and not a survival prediction.",
        "Agents restart from rest at each closure split (stated approximation).",
    ]

    # --- start positions (seeded, recorded) -------------------------------
    people = []
    by_zone: dict[str, list] = {}
    initial_closed = {c["tunnelId"] for c in s["closures"] if c["atSeconds"] <= 0}
    for person in s["people"]:
        rec = {"id": person["id"], "name": person.get("name"), "zoneId": person.get("zoneId"),
               "declaredBy": person.get("declaredBy"), "start": None, "startMethod": None}
        if person.get("start") is not None:
            x, y = _num(person["start"].get("x"), "start.x", -1e6, 1e6), _num(person["start"].get("y"), "start.y", -1e6, 1e6)
            if not net.containing_tunnels(tunnels, x, y, tolerance=1e-3):
                raise EscapeInputError(f"placed start for {person['id']} is not inside a walkable tunnel")
            rec["start"], rec["startMethod"] = (x, y), "user-placed"
        else:
            by_zone.setdefault(person["zoneId"], []).append(rec)
        people.append(rec)
    for zid, recs in by_zone.items():
        area = unary_union([net.tunnel_polygon(tunnels[t]) for t in zones[zid]["tunnelIds"] if tunnels[t].walkable])
        if area.is_empty:
            raise EscapeInputError(f"zone {zid} has no walkable tunnel")
        positions = _zone_positions(area, len(recs), p["radius"], p["seed"] + sum(map(ord, zid)))
        for rec, pos in zip(recs, positions):
            rec["start"], rec["startMethod"] = (round(pos[0], 3), round(pos[1], 3)), "spread-along-zone"
    for rec in people:
        rec["speed"] = round(_speed(rng, p["speed"]), 3)
        rec["releaseSeconds"] = round(p["alarmDelaySeconds"] + rng.uniform(p["preMovementSeconds"]["min"], p["preMovementSeconds"]["max"]), 2)
        rec["outcome"], rec["atSeconds"], rec["targetId"], rec["reason"] = None, None, None, None
        rec["pos"] = rec["start"]

    refuge_load = {t["id"]: 0 for t in targets if t["kind"] == "refuge"}
    traj = {"t": [], "p": [], "x": [], "y": []}
    index = {r["id"]: i for i, r in enumerate(people)}
    segments = []
    closed = set(initial_closed)
    split_times = sorted({c["atSeconds"] for c in s["closures"] if 0 < c["atSeconds"] < p["horizonSeconds"]})
    bounds = [0.0] + split_times + [p["horizonSeconds"]]
    record_every = max(1, round(p["recordEverySeconds"] / p["dt"]))

    for seg_i, (t0, t1) in enumerate(zip(bounds, bounds[1:])):
        if cancelled():
            return {"status": "cancelled", "engineVersion": ENGINE_VERSION, "inputHash": digest}
        closed |= {c["tunnelId"] for c in s["closures"] if c["atSeconds"] <= t0}
        area = net.walkable_area(tunnels, closed)
        comps = net.parts(area)
        active = [r for r in people if r["outcome"] is None]
        seg = {"fromSeconds": t0, "toSeconds": t1, "closedTunnels": sorted(closed), "parts": len(comps),
               "partsWithoutTarget": 0, "cutOffHere": 0}
        # Which part is each active agent in?
        membership: dict[int, list] = {}
        for r in active:
            pt = Point(r["pos"])
            k = next((i for i, c in enumerate(comps) if c.distance(pt) <= 1e-6), None)
            if k is None:
                inside = net.containing_tunnels(tunnels, *r["pos"], ids=closed, tolerance=1e-3)
                when = "at the start" if t0 == 0 else f"at {t0:.0f} s"
                r.update(outcome="cut-off", atSeconds=t0,
                         reason=f"in tunnel {', '.join(inside) or 'unknown'} when it closed {when}")
                seg["cutOffHere"] += 1
                continue
            membership.setdefault(k, []).append(r)
        for k, recs in membership.items():
            comp = comps[k]
            reach = []
            for t in targets:
                widths = [u.width for u in tunnels.values()
                          if u.walkable and u.id not in closed and t["junction"] in (u.a, u.b)]
                if not widths:
                    continue
                # Convex disc inside every open adjoining tunnel (JuPedSim needs convex exits).
                zone = Point(junctions[t["junction"]]).buffer(0.45 * min(widths), quad_segs=8)
                if comp.contains(zone):
                    reach.append((t, zone))
            if not reach:
                seg["partsWithoutTarget"] += 1
                for r in recs:
                    r.update(outcome="cut-off", atSeconds=t0,
                             reason="no route to any exit or refuge from assumed start" if t0 == 0 else f"no route to any exit or refuge from position at {t0:.0f} s")
                    seg["cutOffHere"] += 1
                continue
            sim = jps.Simulation(model=jps.CollisionFreeSpeedModel(), geometry=comp, dt=p["dt"])
            stage = {}
            for t, zone in reach:
                sid = sim.add_exit_stage(zone)
                stage[t["id"]] = (sid, sim.add_journey(jps.JourneyDescription([sid])), t)
            router = jps.RoutingEngine(comp)
            agent_of = {}
            for r in recs:
                options = []
                for tid, (sid, jid, t) in stage.items():
                    goal = junctions[t["junction"]]
                    try:
                        length = _path_length(router.compute_waypoints(tuple(r["pos"]), tuple(goal)))
                    except Exception:
                        continue
                    options.append((length, t["kind"] != "exit", tid))
                options.sort()
                chosen = None
                for length, _, tid in options:
                    t = stage[tid][2]
                    if t["kind"] == "refuge" and refuge_load[tid] >= t["capacity"]:
                        continue
                    chosen = tid
                    break
                if chosen is None:
                    r.update(outcome="cut-off", atSeconds=t0, reason="every reachable refuge is full and no exit is reachable")
                    seg["cutOffHere"] += 1
                    continue
                if stage[chosen][2]["kind"] == "refuge":
                    refuge_load[chosen] += 1
                sid, jid, t = stage[chosen]
                speed = r["speed"] if r["releaseSeconds"] <= t0 else 0.0
                pos = tuple(r["pos"])
                params = dict(journey_id=jid, stage_id=sid, desired_speed=speed, radius=p["radius"])
                try:
                    aid = sim.add_agent(jps.CollisionFreeSpeedModelAgentParameters(position=pos, **params))
                except Exception:
                    inner = comp.buffer(-(p["radius"] + 0.02))
                    pos = nearest_points(inner, Point(pos))[0].coords[0] if not inner.is_empty else pos
                    aid = sim.add_agent(jps.CollisionFreeSpeedModelAgentParameters(position=pos, **params))
                    warnings.append(f"{r['id']}: start nudged inside walls at {t0:.0f} s")
                r["targetId"] = chosen
                agent_of[aid] = r
            frame = 0
            while sim.agent_count() > 0 and t0 + sim.elapsed_time() < t1 - 1e-9:
                if cancelled():
                    return {"status": "cancelled", "engineVersion": ENGINE_VERSION, "inputHash": digest}
                now = t0 + sim.elapsed_time()
                for aid, r in agent_of.items():
                    if r["outcome"] is None and r["releaseSeconds"] <= now:
                        try:
                            a = sim.agent(aid)
                        except Exception:
                            continue
                        if a.model.desired_speed == 0:
                            a.model.desired_speed = r["speed"]
                sim.iterate()
                frame += 1
                now = t0 + sim.elapsed_time()
                for aid in sim.removed_agents():
                    r = agent_of[aid]
                    kind = stage[r["targetId"]][2]["kind"]
                    r.update(outcome="reached-exit" if kind == "exit" else "reached-refuge", atSeconds=round(now, 2), reason=None)
                if p["recordTrajectories"] and frame % record_every == 0:
                    for a in sim.agents():
                        r = agent_of[a.id]
                        traj["t"].append(round(now, 2)); traj["p"].append(index[r["id"]])
                        traj["x"].append(round(a.position[0], 2)); traj["y"].append(round(a.position[1], 2))
            for a in sim.agents():
                agent_of[a.id]["pos"] = (a.position[0], a.position[1])
            for aid, r in agent_of.items():
                if r["outcome"] is None and r["targetId"] in refuge_load:
                    refuge_load[r["targetId"]] -= 1  # re-decided next segment
        segments.append(seg)

    for r in people:
        if r["outcome"] is None:
            r.update(outcome="still-walking", atSeconds=None, reason=f"not at an exit or refuge at the {p['horizonSeconds']:.0f} s horizon")
    totals = {k: sum(1 for r in people if r["outcome"] == k) for k in OUTCOMES}
    totals["simulated"] = len(people)
    totals["balanced"] = sum(totals[k] for k in OUTCOMES) == len(people)
    if not totals["balanced"]:
        raise AssertionError("accounting rule violated")
    safe = [r["atSeconds"] for r in people if r["outcome"] in ("reached-exit", "reached-refuge")]
    times = {name: _quantile_time(safe, f, len(people)) for name, f in (("t50", 0.5), ("t95", 0.95), ("t100", 1.0))}
    result_people = []
    for r in people:
        zname = zones.get(r["zoneId"], {}).get("name", r["zoneId"])
        label = None
        if r["outcome"] == "cut-off":
            label = f"cut off from assumed start in {zname}"
        result_people.append({k: r[k] for k in ("id", "name", "zoneId", "startMethod", "speed", "releaseSeconds", "outcome", "atSeconds", "targetId", "reason")}
                             | {"start": {"x": r["start"][0], "y": r["start"][1]}, "label": label})
    return {
        "status": "completed", "engineVersion": ENGINE_VERSION, "geometryVersion": net.GEOMETRY_VERSION,
        "adapter": {"library": "jupedsim", "version": jps.get_build_info().library_version, "model": "CollisionFreeSpeedModel",
                    "dt": p["dt"], "radius": p["radius"]},
        "inputHash": digest, "seed": p["seed"],
        "assumptions": {"startMethod": p["startMethod"], "speed": p["speed"], "alarmDelaySeconds": p["alarmDelaySeconds"],
                        "preMovementSeconds": p["preMovementSeconds"], "horizonSeconds": p["horizonSeconds"],
                        "closures": s["closures"], "targetChoice": "shortest walkable path; refuges only while capacity remains"},
        "people": result_people, "totals": totals, "times": times,
        "timesNote": "Time by which the stated share of all simulated people reached an exit or refuge; null means not reached.",
        "segments": segments,
        "trajectories": ({"columns": ["t", "p", "x", "y"], **traj, "people": [r["id"] for r in people]} if p["recordTrajectories"] else None),
        "diagnostics": {"durationMs": round((time.perf_counter() - started) * 1000, 1)},
        "warnings": warnings,
    }
