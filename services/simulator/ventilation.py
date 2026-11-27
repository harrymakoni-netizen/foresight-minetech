"""Ventilation network solver (spec 9.8): Hardy Cross with Atkinson's square law,
plus screening gas dilution and re-entry estimates.

Square law: pressure drop across an airway = R * Q * |Q| (R in N s^2 / m^8, Q in
m^3/s, Pa). Loop correction (Hardy Cross):
    dQ = - sum(R Q |Q|) / sum(2 R |Q|)
Junction continuity holds from the initial flow estimate (built along a
spanning tree) and is preserved by every loop correction. The convergence
tolerance and iteration limit are inputs and are reported with the result.

What it is NOT: not CFD, not heat or density effects,
not a fan-selection tool (a fan is a fixed duty, or a tabulated curve you enter; natural
ventilation is a pressure you enter, not computed from the mine's heat). A textbook match verifies the
solver, not a real mine.

Airflow direction convention: positive flow runs from an airway's `from` node to
its `to` node. A negative flow is a reversal against the drawn direction and is
reported as such. Sections of the network that are not connected to a driver or
cannot balance are listed explicitly instead of being given flows."""
from __future__ import annotations

import math
from collections import defaultdict, deque
from typing import Any

ENGINE = "ventilation-hardycross-1.0.0"
DEFAULT_TOLERANCE = 1e-6  # m^3/s, largest loop correction at which iteration stops
DEFAULT_MAX_ITERATIONS = 10000


def _finite(x: Any, name: str, lo: float, hi: float) -> float:
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) or not (lo <= x <= hi):
        raise ValueError(f"{name} must be a number between {lo} and {hi}")
    return float(x)


def _curve(points: list[dict] | None):
    """Piecewise-linear fan characteristic: (q, p) points, q strictly increasing. Returns (rise(q), slope(q), (qmin, qmax))."""
    if not points:
        return None
    qs = [float(x["q"]) for x in points]
    ps = [float(x["p"]) for x in points]

    def rise(q: float) -> float:
        if q <= qs[0]:
            return ps[0]  # no extrapolation: below the first point the first pressure is used
        if q >= qs[-1]:
            return ps[-1]
        for i in range(len(qs) - 1):
            if qs[i] <= q <= qs[i + 1]:
                k = (q - qs[i]) / (qs[i + 1] - qs[i])
                return ps[i] + (ps[i + 1] - ps[i]) * k
        return ps[-1]

    def slope(q: float) -> float:
        if q < qs[0] or q > qs[-1]:
            return 0.0
        for i in range(len(qs) - 1):
            if qs[i] <= q <= qs[i + 1]:
                return (ps[i + 1] - ps[i]) / (qs[i + 1] - qs[i])
        return 0.0

    return rise, slope, (qs[0], qs[-1])


def validate(data: dict) -> None:
    nodes = data.get("nodes")
    airways = data.get("airways")
    if not isinstance(nodes, list) or not nodes or len(nodes) > 5000 or len(set(nodes)) != len(nodes):
        raise ValueError("nodes must be a list of 1 to 5000 unique ids")
    if not isinstance(airways, list) or not airways or len(airways) > 8000:
        raise ValueError("airways must be a list of 1 to 8000 entries")
    known = set(nodes)
    seen: set[str] = set()
    for a in airways:
        if not a.get("id") or a["id"] in seen:
            raise ValueError("airways need unique ids")
        seen.add(a["id"])
        if a.get("from") not in known or a.get("to") not in known or a["from"] == a["to"]:
            raise ValueError(f"airway {a.get('id')} must join two different known nodes")
        if a.get("fixed") is None:
            _finite(a.get("resistance"), f"resistance of {a['id']}", 0, 1e9)
        else:
            _finite(a["fixed"], f"fixed flow of {a['id']}", -1e5, 1e5)
        if a.get("pressureSourcePa") is not None:
            _finite(a["pressureSourcePa"], f"pressure source of {a['id']}", -1e5, 1e5)
        if a.get("fanCurve") is not None:
            pts = a["fanCurve"]
            if a.get("fixed") is not None:
                raise ValueError(f"{a['id']} cannot have both a fixed flow and a fan curve")
            if not isinstance(pts, list) or not 2 <= len(pts) <= 20:
                raise ValueError(f"fan curve of {a['id']} needs 2 to 20 points")
            last = -1.0
            for pt in pts:
                qv = _finite(pt.get("q"), "curve flow", 0, 1e5)
                _finite(pt.get("p"), "curve pressure", 0, 1e6)
                if qv <= last:
                    raise ValueError(f"fan curve of {a['id']} must have strictly increasing flows")
                last = qv
    for s in data.get("slack") or []:
        if s not in known:
            raise ValueError(f"slack node {s} is not a node")
    _finite(data.get("tolerance", DEFAULT_TOLERANCE), "tolerance", 1e-12, 1.0)
    it = data.get("maxIterations", DEFAULT_MAX_ITERATIONS)
    if isinstance(it, bool) or not isinstance(it, int) or not 1 <= it <= 1_000_000:
        raise ValueError("maxIterations must be a whole number between 1 and 1000000")


def solve_network(data: dict) -> dict:
    """Solve steady flows. `data`: nodes, airways [{id, from, to, resistance, fixed}],
    slack (node ids that absorb imbalance, e.g. the surface), tolerance, maxIterations."""
    validate(data)
    nodes: list[str] = list(data["nodes"])
    airways: list[dict] = data["airways"]
    slack = set(data.get("slack") or [])
    tol = float(data.get("tolerance", DEFAULT_TOLERANCE))
    max_iter = int(data.get("maxIterations", DEFAULT_MAX_ITERATIONS))
    by_id = {a["id"]: a for a in airways}
    curves = {a["id"]: _curve(a.get("fanCurve")) for a in airways}

    def rise(a: dict, qv: float) -> float:
        """Pressure the airway adds in its drawn direction: a natural-ventilation source plus a fan curve."""
        r = float(a.get("pressureSourcePa") or 0.0)
        c = curves[a["id"]]
        return r + (c[0](qv) if c else 0.0)

    def rise_slope(a: dict, qv: float) -> float:
        c = curves[a["id"]]
        return c[1](qv) if c else 0.0

    def head_loss(a: dict, qv: float) -> float:
        return float(a["resistance"]) * qv * abs(qv) - rise(a, qv)

    free = [a for a in airways if a.get("fixed") is None]
    fixed = [a for a in airways if a.get("fixed") is not None]

    # External demand on the free network: air leaving through a fixed-duty airway.
    demand: dict[str, float] = defaultdict(float)
    for a in fixed:
        demand[a["from"]] += float(a["fixed"])
        demand[a["to"]] -= float(a["fixed"])

    adj: dict[str, list[tuple[str, int]]] = defaultdict(list)
    for i, a in enumerate(free):
        adj[a["from"]].append((a["to"], i))
        adj[a["to"]].append((a["from"], i))

    # Sections: connected components of the free network (isolated nodes included).
    seen: set[str] = set()
    sections: list[dict] = []
    flow: dict[str, float] = {a["id"]: 0.0 for a in airways}
    for a in fixed:
        flow[a["id"]] = float(a["fixed"])
    node_pressure: dict[str, float | None] = {n: None for n in nodes}
    iterations = 0
    max_correction = 0.0
    converged = True
    loops_total = 0
    loop_unbalanced: set[tuple[str, ...]] = set()
    for start in nodes:
        if start in seen:
            continue
        comp: list[str] = []
        queue = deque([start])
        seen.add(start)
        while queue:
            n = queue.popleft()
            comp.append(n)
            for m, _ in adj[n]:
                if m not in seen:
                    seen.add(m)
                    queue.append(m)
        edges_in = sorted({i for n in comp for _, i in adj[n]})
        total = sum(demand[n] for n in comp)
        slack_here = next((n for n in comp if n in slack), None)
        # A section is driven by a fixed-duty fan, a fan curve or a natural-ventilation pressure.
        has_driver = any(abs(demand[n]) > 0 for n in comp) or any(
            abs(float(free[i].get("pressureSourcePa") or 0.0)) > 0 or (curves[free[i]["id"]] is not None and any(float(pt["p"]) > 0 for pt in free[i]["fanCurve"])) for i in edges_in
        )
        section = {"nodes": comp, "airways": [free[i]["id"] for i in edges_in], "hasSurface": slack_here is not None, "drivers": sum(1 for n in comp if abs(demand[n]) > 0) + sum(1 for i in edges_in if free[i].get("pressureSourcePa") or free[i].get("fanCurve"))}
        if not edges_in:
            section.update(status="isolated", note="No airway is connected here.")
            if abs(total) > 1e-12:
                section.update(status="infeasible", note="A fixed-duty fan feeds this junction but no airway carries the air on.")
            sections.append(section)
            continue
        if slack_here is None and abs(total) > 1e-9:
            section.update(status="infeasible", note=f"Fixed-duty fans force a net {total:+.3f} m3/s into this section, which has no connection to the surface, so the flow cannot balance. No flows are given for it.")
            sections.append(section)
            continue
        if not has_driver:
            section.update(status="no-driver", note="Nothing drives air through this section (no fan, fan curve or natural-ventilation pressure); flows are zero.")
            sections.append(section)
            for n in comp:
                node_pressure[n] = 0.0
            continue
        d = {n: demand[n] for n in comp}
        if slack_here is not None:
            d[slack_here] = -(total - demand[slack_here])
        # Spanning tree from the slack node (or the first node), deterministic order.
        root = slack_here or comp[0]
        parent: dict[str, tuple[str, int] | None] = {root: None}
        order = [root]
        depth = {root: 0}
        queue = deque([root])
        tree_edges: set[int] = set()
        while queue:
            n = queue.popleft()
            for m, i in sorted(adj[n], key=lambda t: (t[1], t[0])):
                if m not in parent:
                    parent[m] = (n, i)
                    depth[m] = depth[n] + 1
                    tree_edges.add(i)
                    order.append(m)
                    queue.append(m)
        # Initial flows on tree edges: flow from a node to its parent is minus the subtree demand.
        sub = dict(d)
        q: dict[int, float] = {i: 0.0 for i in edges_in}
        for n in reversed(order):
            if parent[n] is None:
                continue
            p, i = parent[n]
            flow_up = -sub[n]
            q[i] = flow_up if free[i]["from"] == n else -flow_up
            sub[p] += sub[n]
        # Loops: each non-tree edge closes a cycle through the tree. Signs: +1 when the
        # loop traverses an airway in its drawn from -> to direction.
        loops: list[list[tuple[int, int]]] = []
        for i in edges_in:
            if i in tree_edges:
                continue
            a_, b_ = free[i]["from"], free[i]["to"]
            up_a: list[tuple[int, int]] = []  # stepping up from a to the meeting node
            up_b: list[tuple[int, int]] = []  # stepping up from b to the meeting node
            x, y = a_, b_
            while x != y:
                if depth[x] >= depth[y]:
                    px, ix = parent[x]
                    up_a.append((ix, +1 if free[ix]["from"] == x else -1))
                    x = px
                else:
                    py, iy = parent[y]
                    up_b.append((iy, +1 if free[iy]["from"] == y else -1))
                    y = py
            # a -> b through this airway, then b up to the meeting node, then down to a.
            loops.append([(i, +1)] + up_b + [(e, -sg) for e, sg in reversed(up_a)])
        if not loops and all(abs(d[n]) < 1e-12 for n in comp):
            section.update(status="no-driver", note="The pressure source in this section is not part of any closed circuit (it has no way for air to return), so no air flows.")
            sections.append(section)
            for n in comp:
                node_pressure[n] = 0.0
            continue
        loops_total += len(loops)
        comp_iter = 0
        comp_conv = True
        last = 0.0
        for comp_iter in range(1, max_iter + 1):
            biggest = 0.0
            for loop in loops:
                num = sum(sg * head_loss(free[i], q[i]) for i, sg in loop)
                den = sum(float(free[i]["resistance"]) * 2.0 * abs(q[i]) - rise_slope(free[i], q[i]) for i, _ in loop)
                if den > 1e-9:
                    dq = -num / den
                else:
                    # No slope yet (a loop at rest with a pressure source): step to where friction balances the source.
                    total_r = sum(float(free[i]["resistance"]) for i, _ in loop)
                    if abs(num) <= 1e-12 or total_r <= 0.0:
                        if abs(num) > 1e-9:
                            loop_unbalanced.add(tuple(sorted(free[i]["id"] for i, _ in loop)))
                        continue
                    dq = -math.copysign(math.sqrt(abs(num) / total_r), num)
                for i, sg in loop:
                    q[i] += sg * dq
                biggest = max(biggest, abs(dq))
            last = biggest
            if biggest < tol:
                break
        else:
            comp_conv = False
        if not loops:
            comp_iter = 0
        iterations = max(iterations, comp_iter)
        max_correction = max(max_correction, last)
        converged = converged and comp_conv
        for i in edges_in:
            flow[free[i]["id"]] = q[i]
        # Node pressures (Pa relative to the root) along the tree: flow loses pressure.
        node_pressure[root] = 0.0
        for n in order[1:]:
            p, i = parent[n]
            a = free[i]
            drop = head_loss(a, q[i])  # pressure lost going from -> to (friction minus any fan or natural pressure)
            node_pressure[n] = node_pressure[p] - (drop if a["from"] == p else -drop)
        section.update(status="solved", loops=len(loops), iterations=comp_iter, finalMaxCorrection=last, converged=comp_conv)
        if slack_here is not None:
            section["slackNode"] = slack_here
        sections.append(section)

    # Residuals over the free network.
    net: dict[str, float] = defaultdict(float)
    for a in free:
        net[a["to"]] += flow[a["id"]]
        net[a["from"]] -= flow[a["id"]]
    solved_nodes = {n for s in sections if s["status"] in ("solved", "no-driver") for n in s["nodes"]}
    continuity = max((abs(net[n] - demand[n]) for n in solved_nodes if n not in slack), default=0.0)
    loop_residual = 0.0
    out_airways = []
    for a in airways:
        qv = flow[a["id"]]
        is_fixed = a.get("fixed") is not None
        item = {
            "id": a["id"],
            "from": a["from"],
            "to": a["to"],
            "flowM3s": qv,
            "fixed": is_fixed,
            "direction": "from-to" if qv > 1e-12 else "to-from" if qv < -1e-12 else "none",
            "reversedFromDrawn": qv < -1e-12,
        }
        if not is_fixed:
            item["resistance"] = float(a["resistance"])
            item["pressureDropPa"] = float(a["resistance"]) * qv * abs(qv)
            if a.get("pressureSourcePa") or curves[a["id"]]:
                item["pressureRisePa"] = rise(a, qv)
            c = curves[a["id"]]
            if c:
                lo, hi = c[2]
                item["fanCurve"] = {"flowM3s": qv, "pressureRisePa": rise(a, qv), "rangeM3s": [lo, hi], "inRange": lo <= qv <= hi, "reverseFlow": qv < -1e-12}
            if a.get("pressureSourcePa"):
                item["naturalPressurePa"] = float(a["pressureSourcePa"])
        else:
            pa, pb = node_pressure.get(a["from"]), node_pressure.get(a["to"])
            item["fanPressureRisePa"] = None if pa is None or pb is None else pb - pa
            item["fanPowerW"] = None if item["fanPressureRisePa"] is None else item["fanPressureRisePa"] * qv
        if a.get("areaM2"):
            item["areaM2"] = float(a["areaM2"])
            item["velocityMs"] = abs(qv) / float(a["areaM2"])
        out_airways.append(item)
    # Pressure closure: node pressures follow the spanning tree, so a non-tree airway shows any loop imbalance.
    for a in free:
        pa, pb = node_pressure.get(a["from"]), node_pressure.get(a["to"])
        if pa is None or pb is None:
            continue
        loop_residual = max(loop_residual, abs((pa - pb) - head_loss(a, flow[a["id"]])))
    return {
        "status": "completed",
        "engine": ENGINE,
        "method": "Hardy Cross, Atkinson square law (dP = R Q |Q|), fan curves and natural pressure as pressure sources; loop correction dQ = -sum(h) / sum(dh/dQ) with h = R Q|Q| - P(Q)",
        "tolerance": tol,
        "maxIterations": max_iter,
        "iterations": iterations,
        "finalMaxCorrection": max_correction,
        "converged": converged,
        "loops": loops_total,
        "continuityResidualM3s": continuity,
        "pressureClosureResidualPa": loop_residual,
        "airways": out_airways,
        "sections": sections,
        "nodePressuresPa": {n: p for n, p in node_pressure.items() if p is not None},
        "reversals": [a["id"] for a in out_airways if a["reversedFromDrawn"]],
        "fanWarnings": [
            {"id": a["id"], "problem": "operating outside its tabulated curve" if not a["fanCurve"]["inRange"] and not a["fanCurve"]["reverseFlow"] else "air flows backwards through the fan, where the curve does not apply"}
            for a in out_airways
            if a.get("fanCurve") and (not a["fanCurve"]["inRange"] or a["fanCurve"]["reverseFlow"])
        ],
        "unbalancedLoops": [list(x) for x in sorted(loop_unbalanced)],
    }


# ---- screening estimates (spec 9.8) -------------------------------------------------------------
def gas_dilution(airways: list[dict], source: dict) -> dict:
    """Concentration (volume fraction) in each airway downstream of a gas release,
    assuming full mixing at junctions. c = gas flow / airflow. Screening estimate.

    `airways`: solved airways (id, from, to, flowM3s). `source`: {airwayId, releaseM3s}."""
    rel = _finite(source.get("releaseM3s"), "release rate", 0.0, 1e3)
    src = source.get("airwayId")
    by = {a["id"]: a for a in airways}
    if src not in by:
        raise ValueError(f"release airway {src} is not an airway")
    out: dict[str, Any] = {"airwayId": src, "releaseM3s": rel, "concentration": {}, "gasFluxM3s": {}, "notes": [], "recirculation": False, "stagnant": False}
    s = by[src]
    if abs(s["flowM3s"]) < 1e-9:
        out["stagnant"] = True
        out["notes"].append("No airflow in the release airway: the gas is not carried away and its concentration cannot be estimated (it accumulates).")
        return out
    head = lambda a: a["to"] if a["flowM3s"] > 0 else a["from"]  # noqa: E731
    tail = lambda a: a["from"] if a["flowM3s"] > 0 else a["to"]  # noqa: E731
    moving = [a for a in airways if abs(a["flowM3s"]) > 1e-12 and a["id"] != src]
    outgoing: dict[str, list[dict]] = defaultdict(list)
    for a in moving:
        outgoing[tail(a)].append(a)
    entry = head(s)
    reach: set[str] = set()
    stack = [entry]
    while stack:
        n = stack.pop()
        if n in reach:
            continue
        reach.add(n)
        stack.extend(head(a) for a in outgoing[n])
    indeg: dict[str, int] = defaultdict(int)
    for a in moving:
        if tail(a) in reach:
            indeg[head(a)] += 1
    gas: dict[str, float] = defaultdict(float)
    gas[entry] = rel
    flux: dict[str, float] = {src: rel}
    ready = deque([entry])
    done: set[str] = set()
    if indeg.get(entry, 0) > 0 or tail(s) in reach:
        out["recirculation"] = True  # the air comes back round to the release point
    while ready:
        n = ready.popleft()
        if n in done:
            continue
        done.add(n)
        total = sum(abs(a["flowM3s"]) for a in outgoing[n])
        for a in outgoing[n]:
            f = gas[n] * abs(a["flowM3s"]) / total if total > 0 else 0.0
            flux[a["id"]] = f
            h = head(a)
            gas[h] += f
            indeg[h] -= 1
            if indeg[h] <= 0:
                ready.append(h)
    if any(n not in done for n in reach) or out["recirculation"]:
        out["recirculation"] = True
        out["notes"].append("Airflow recirculates among some junctions; concentrations in and beyond the loop are not estimated.")
        flux = {k: v for k, v in flux.items() if by[k]["to"] in done or by[k]["from"] in done or k == src}
    for aid, f in flux.items():
        qa = abs(by[aid]["flowM3s"])
        out["gasFluxM3s"][aid] = f
        if qa > 1e-12:
            out["concentration"][aid] = f / qa
    out["notes"].append("Screening estimate: gas released at a steady rate, fully mixed at every junction, no sorption or decay. The release rate must come from fume-emission data (not entered by default).")
    return out


def reentry_time(volume_m3: float, flow_m3s: float, c_start: float, c_limit: float) -> dict:
    """t = (V / Q) ln(c_start / c_limit). Full mixing; constant airflow through the volume; no further release."""
    v = _finite(volume_m3, "volume", 1e-6, 1e9)
    q = _finite(flow_m3s, "airflow", 0.0, 1e5)
    cs = _finite(c_start, "starting concentration", 1e-12, 1.0)
    cl = _finite(c_limit, "limit concentration", 1e-12, 1.0)
    base = {"volumeM3": v, "flowM3s": q, "startFraction": cs, "limitFraction": cl, "formula": "t = (V / Q) x ln(c_start / c_limit)"}
    if cs <= cl:
        return {**base, "seconds": 0.0, "note": "The starting concentration is already at or below the limit."}
    if q <= 1e-9:
        return {**base, "seconds": None, "note": "No airflow through the volume: the gas does not clear."}
    return {**base, "seconds": (v / q) * math.log(cs / cl), "note": "Screening estimate: assumes the volume is fully mixed and receives the stated airflow throughout."}


# ---- references the solver is checked against before a result is returned -----------------------------
def reference_checks() -> list[dict]:
    """Closed-form cases (equal pressure drop in parallel airways). Each runs through
    the solver; a failure makes the job fail rather than return numbers."""
    checks = []
    cases = [
        ("two parallel airways R=4 and R=1, 30 m3/s", [4.0, 1.0], 30.0, [10.0, 20.0]),
        ("three parallel airways R=1, 4, 9, 22 m3/s", [1.0, 4.0, 9.0], 22.0, [12.0, 6.0, 4.0]),
    ]
    for name, rs, total, expected in cases:
        data = {
            "nodes": ["A", "B"],
            "airways": [{"id": f"P{i}", "from": "A", "to": "B", "resistance": r} for i, r in enumerate(rs)] + [{"id": "FAN", "from": "B", "to": "A", "fixed": total}],
            "slack": [],
            "tolerance": 1e-10,
        }
        res = solve_network(data)
        got = [a["flowM3s"] for a in res["airways"] if a["id"].startswith("P")]
        worst = max(abs(g - e) for g, e in zip(got, expected))
        checks.append({"name": name, "kind": "closed-form", "expected": expected, "got": got, "maxAbsError": worst, "tolerance": 1e-6, "passed": worst <= 1e-6})
    # Natural pressure P in a loop of R1 + R2: q = sqrt(P / (R1 + R2)); P=100, R=4+1 -> sqrt(20).
    nat = solve_network({"nodes": ["A", "B"], "airways": [{"id": "X", "from": "A", "to": "B", "resistance": 4.0, "pressureSourcePa": 100.0}, {"id": "Y", "from": "B", "to": "A", "resistance": 1.0}], "slack": [], "tolerance": 1e-12})
    got = nat["airways"][0]["flowM3s"]
    checks.append({"name": "natural pressure 100 Pa in a loop of R = 4 + 1", "kind": "closed-form", "expected": [math.sqrt(20)], "got": [got], "maxAbsError": abs(got - math.sqrt(20)), "tolerance": 1e-6, "passed": abs(got - math.sqrt(20)) <= 1e-6})
    # Linear fan curve p = 300 - 10 q into R = 5: 5 q^2 + 10 q - 300 = 0 -> q = (-10 + sqrt(6100)) / 10.
    fan = solve_network({"nodes": ["A", "B"], "airways": [{"id": "X", "from": "A", "to": "B", "resistance": 4.0, "fanCurve": [{"q": 0, "p": 300}, {"q": 30, "p": 0}]}, {"id": "Y", "from": "B", "to": "A", "resistance": 1.0}], "slack": [], "tolerance": 1e-12})
    want = (-10 + math.sqrt(6100)) / 10
    got = fan["airways"][0]["flowM3s"]
    checks.append({"name": "linear fan curve 300 - 10 Q into R = 5", "kind": "closed-form", "expected": [want], "got": [got], "maxAbsError": abs(got - want), "tolerance": 1e-6, "passed": abs(got - want) <= 1e-6})
    return checks


TEXTBOOK = {
    "status": "not-added",
    "note": "No published textbook worked example has been added to this build yet (the sources could not be retrieved while it was built). Until one is added and matches within its stated tolerance, treat results as unverified against a textbook.",
}


def _state(spec: dict, data: dict) -> dict:
    sol = solve_network({"nodes": spec["nodes"], "airways": spec["airways"], "slack": spec.get("slack") or [], "tolerance": data.get("tolerance", DEFAULT_TOLERANCE), "maxIterations": data.get("maxIterations", DEFAULT_MAX_ITERATIONS)})
    out: dict[str, Any] = {"solution": sol}
    if data.get("gas"):
        out["gas"] = gas_dilution(sol["airways"], data["gas"])
    if data.get("reentry"):
        r = data["reentry"]
        flows = {a["id"]: a["flowM3s"] for a in sol["airways"]}
        if r["feedAirwayId"] not in flows:
            raise ValueError(f"feed airway {r['feedAirwayId']} is not an airway")
        out["reentry"] = {**reentry_time(r["volumeM3"], abs(flows[r["feedAirwayId"]]), r["cStartFraction"], r["cLimitFraction"]), "feedAirwayId": r["feedAirwayId"], "airwayIds": r.get("airwayIds", [])}
        if out.get("gas") and r["airwayIds"]:
            c = out["gas"]["concentration"]
            out["reentry"]["screeningConcentrationInArea"] = max((c.get(i, 0.0) for i in r["airwayIds"]), default=0.0)
    return out


def run(data: dict, cancelled=lambda: False) -> dict:
    checks = reference_checks()
    if not all(c["passed"] for c in checks):
        raise ValueError("The solver failed its own reference checks, so no result is returned.")
    states = data.get("states") or {}
    if "baseline" not in states:
        raise ValueError("A baseline network is required")
    out_states = {k: _state(states[k], data) for k in ("baseline", "scenario") if k in states}
    comparison = None
    if "scenario" in out_states:
        b = {a["id"]: a for a in out_states["baseline"]["solution"]["airways"]}
        rows = []
        for a in out_states["scenario"]["solution"]["airways"]:
            x = b.get(a["id"])
            if x is None:
                continue
            rows.append({
                "id": a["id"],
                "baselineM3s": x["flowM3s"],
                "scenarioM3s": a["flowM3s"],
                "deltaM3s": a["flowM3s"] - x["flowM3s"],
                "reversedVsBaseline": abs(x["flowM3s"]) > 1e-9 and abs(a["flowM3s"]) > 1e-9 and (x["flowM3s"] > 0) != (a["flowM3s"] > 0),
                "stoppedVsBaseline": abs(x["flowM3s"]) > 1e-9 and abs(a["flowM3s"]) <= 1e-9,
            })
        comparison = {"airways": rows, "reversed": [r["id"] for r in rows if r["reversedVsBaseline"]], "stopped": [r["id"] for r in rows if r["stoppedVsBaseline"]]}
    return {
        "status": "completed",
        "engine": ENGINE,
        "verification": {"closedFormChecks": checks, "textbook": TEXTBOOK, "note": "A textbook or closed-form match verifies the solver, not a real mine."},
        "states": out_states,
        "comparison": comparison,
        "assumptions": [
            "Steady state; Atkinson square law dP = R Q|Q| with the entered resistances (N s^2/m^8). No natural ventilation, heat, density or leakage effects.",
            "A fan is a fixed duty: it moves its entered flow from its start junction to its end junction whatever the pressure. A failed fan stops pushing and the airway stays open.",
            "Every exit is connected to the surface through a zero-resistance link; shaft and portal losses are not modelled.",
            "A closed door adds its entered resistance in series with its airway; an open door adds none.",
            "Gas and re-entry figures are screening estimates assuming full mixing; they need fume-emission data.",
        ],
        "tolerance": data.get("tolerance", DEFAULT_TOLERANCE),
        "maxIterations": data.get("maxIterations", DEFAULT_MAX_ITERATIONS),
    }
