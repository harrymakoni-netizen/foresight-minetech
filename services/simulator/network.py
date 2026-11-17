"""Tunnel-network geometry and graph helpers shared by the route, escape and
mine-model preflight code. Requires the simulation-worker environment
(requirements-sim.txt: networkx, shapely).

Coordinates are metres in the mine's local plan datum. Tunnels are straight
centrelines between two junctions. A walkable polygon is the centreline
buffered by half the tunnel width with round ends, so adjoining tunnels overlap
at their shared junction and the union is connected exactly where the graph
is connected. Plan crossings between tunnels that share no junction (for
example, drives on different levels) would merge in 2-D, so they are reported
and the escape engine refuses to run on them instead of inventing a connection.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import networkx as nx
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

GEOMETRY_VERSION = "tunnel-buffer-1.0.0"


class NetworkError(ValueError):
    pass


@dataclass(frozen=True)
class Tunnel:
    id: str
    a: str
    b: str
    width: float
    walkable: bool
    line: LineString

    @property
    def length(self) -> float:
        return self.line.length


def _finite(value, label, low=0.0, high=1e6):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise NetworkError(f"{label} must be a finite number in [{low}, {high}]")
    return float(value)


def parse(network: dict) -> tuple[dict[str, tuple[float, float]], dict[str, Tunnel]]:
    if not isinstance(network, dict):
        raise NetworkError("network must be an object")
    junctions: dict[str, tuple[float, float]] = {}
    for j in network.get("junctions", []):
        jid = j.get("id")
        if not isinstance(jid, str) or not jid or jid in junctions:
            raise NetworkError("junction ids must be unique non-empty strings")
        junctions[jid] = (_finite(j.get("x"), f"{jid}.x", -1e6), _finite(j.get("y"), f"{jid}.y", -1e6))
    if len(junctions) < 2:
        raise NetworkError("at least two junctions are required")
    tunnels: dict[str, Tunnel] = {}
    for t in network.get("tunnels", []):
        tid = t.get("id")
        if not isinstance(tid, str) or not tid or tid in tunnels:
            raise NetworkError("tunnel ids must be unique non-empty strings")
        a, b = t.get("from"), t.get("to")
        if a not in junctions or b not in junctions or a == b:
            raise NetworkError(f"tunnel {tid} must join two different known junctions")
        width = t.get("width")
        if width is None:
            raise NetworkError(f"tunnel {tid} width is not measured or entered; escape geometry cannot be built")
        width = _finite(width, f"{tid}.width", 0.3, 50)
        line = LineString([junctions[a], junctions[b]])
        if line.length <= 0:
            raise NetworkError(f"tunnel {tid} has zero plan length")
        tunnels[tid] = Tunnel(tid, a, b, width, bool(t.get("walkable", True)), line)
    if not tunnels:
        raise NetworkError("at least one tunnel is required")
    return junctions, tunnels


def graph(junctions, tunnels, closed: set[str] = frozenset(), walkable_only=True) -> nx.MultiGraph:
    g = nx.MultiGraph()
    g.add_nodes_from(junctions)
    for t in tunnels.values():
        if t.id in closed or (walkable_only and not t.walkable):
            continue
        g.add_edge(t.a, t.b, key=t.id, id=t.id, length=t.length)
    return g


def tunnel_polygon(t: Tunnel) -> Polygon:
    return t.line.buffer(t.width / 2, cap_style="round", join_style="round", quad_segs=8)


def plan_crossings(junctions, tunnels) -> list[tuple[str, str]]:
    """Pairs of tunnels whose walkable areas overlap without a shared junction."""
    items = [t for t in tunnels.values() if t.walkable]
    polys = {t.id: tunnel_polygon(t) for t in items}
    found = []
    for i, t in enumerate(items):
        for u in items[i + 1:]:
            if {t.a, t.b} & {u.a, u.b}:
                continue
            if polys[t.id].intersects(polys[u.id]):
                found.append((t.id, u.id))
    return found


def walkable_area(tunnels, closed: set[str] = frozenset()):
    polys = [tunnel_polygon(t) for t in tunnels.values() if t.walkable and t.id not in closed]
    return unary_union(polys) if polys else Polygon()


def parts(area) -> list[Polygon]:
    if area.is_empty:
        return []
    if area.geom_type == "Polygon":
        return [area]
    return [g for g in area.geoms if g.geom_type == "Polygon" and not g.is_empty]


def junction_area(junctions, tunnels, junction_id: str) -> Polygon:
    """Disc at a junction sized to the widest walkable tunnel meeting it."""
    widths = [t.width for t in tunnels.values() if t.walkable and junction_id in (t.a, t.b)]
    if not widths:
        raise NetworkError(f"junction {junction_id} has no walkable tunnel")
    return Point(junctions[junction_id]).buffer(max(widths) / 2, quad_segs=8)


def containing_tunnels(tunnels, x: float, y: float, ids=None, tolerance=1e-6) -> list[str]:
    p = Point(x, y)
    return [t.id for t in tunnels.values() if (ids is None or t.id in ids) and tunnel_polygon(t).distance(p) <= tolerance]


def shortest_path(junctions, tunnels, source: str, targets: list[str], closed: set[str] = frozenset()):
    """NetworkX Dijkstra over open walkable tunnels. Returns (target, length,
    tunnel ids) for the nearest reachable target or None ("no route found")."""
    g = graph(junctions, tunnels, closed)
    best = None
    for target in targets:
        if target not in g or source not in g:
            continue
        try:
            nodes = nx.shortest_path(g, source, target, weight="length")
        except nx.NetworkXNoPath:
            continue
        edges, length = [], 0.0
        for a, b in zip(nodes, nodes[1:]):
            key, data = min(g.get_edge_data(a, b).items(), key=lambda kv: kv[1]["length"])
            edges.append(key)
            length += data["length"]
        if best is None or length < best[1]:
            best = (target, length, edges)
    return best


def alternative_paths(junctions, tunnels, source: str, target: str, closed: set[str] = frozenset(), limit=3):
    """Up to `limit` loop-free paths, shortest first, as tunnel-id lists."""
    g = nx.Graph()
    for t in tunnels.values():
        if t.walkable and t.id not in closed:
            if g.has_edge(t.a, t.b) and g[t.a][t.b]["length"] <= t.length:
                continue
            g.add_edge(t.a, t.b, id=t.id, length=t.length)
    if source not in g or target not in g:
        return []
    out = []
    try:
        for nodes in nx.shortest_simple_paths(g, source, target, weight="length"):
            ids = [g[a][b]["id"] for a, b in zip(nodes, nodes[1:])]
            out.append({"tunnelIds": ids, "lengthM": round(sum(g[a][b]["length"] for a, b in zip(nodes, nodes[1:])), 3)})
            if len(out) >= limit:
                break
    except nx.NetworkXNoPath:
        return []
    return out
