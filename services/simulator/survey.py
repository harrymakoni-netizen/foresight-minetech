"""Surveyor features (spec 8.3, 8.5): DXF centreline import (ezdxf) and GeoTIFF
base maps (rasterio/GDAL). Both run in the simulation worker.

Nothing is guessed. Units must be chosen by the person, drawings with no
elevation data stay "not entered" unless a constant is entered, arcs are
approximated by chords and counted, and anything the importer cannot read is
listed per layer rather than dropped silently. DXF coordinates are kept as
drawn (converted to metres only)."""
from __future__ import annotations

import base64
import io
import math
from typing import Any

# DXF $INSUNITS codes -> (name, factor to metres). Only units a mine plan would use.
INSUNITS = {1: ("in", 0.0254), 2: ("ft", 0.3048), 4: ("mm", 0.001), 5: ("cm", 0.01), 6: ("m", 1.0), 7: ("km", 1000.0), 10: ("yd", 0.9144)}
UNIT_FACTORS = {"in": 0.0254, "ft": 0.3048, "mm": 0.001, "cm": 0.01, "m": 1.0, "km": 1000.0, "yd": 0.9144}
SUPPORTED = ("LINE", "LWPOLYLINE", "POLYLINE")
MAX_ENDPOINTS = 5000
ARC_APPROX_NOTE = "arc segments (bulges) are approximated by straight chords, so those tunnel lengths are a little short"


def _read_dxf(text: str):
    import ezdxf
    from ezdxf import DXFError

    if not isinstance(text, str) or not text.strip():
        raise ValueError("No DXF text was supplied")
    try:
        return ezdxf.read(io.StringIO(text))
    except (DXFError, ValueError, UnicodeError, IndexError, KeyError) as exc:
        raise ValueError(f"This is not a readable ASCII DXF file: {exc}") from exc


def _vertices(entity) -> tuple[list[tuple[float, float, float]], bool, bool]:
    """Vertices (x, y, z), whether closed, whether any bulge (arc) was present."""
    kind = entity.dxftype()
    if kind == "LINE":
        s, e = entity.dxf.start, entity.dxf.end
        return [(s.x, s.y, s.z), (e.x, e.y, e.z)], False, False
    if kind == "LWPOLYLINE":
        z = float(entity.dxf.elevation) if entity.dxf.hasattr("elevation") else 0.0
        pts = [(p[0], p[1], z) for p in entity.get_points("xyb")]
        return [(x, y, zz) for x, y, zz in pts], bool(entity.closed), any(abs(p[2]) > 1e-9 for p in entity.get_points("xyb"))
    if kind == "POLYLINE":
        pts = [(v.dxf.location.x, v.dxf.location.y, v.dxf.location.z) for v in entity.vertices]
        bulge = any(abs(getattr(v.dxf, "bulge", 0.0) or 0.0) > 1e-9 for v in entity.vertices)
        return pts, bool(entity.is_closed), bulge
    raise ValueError("unsupported entity")


def inspect(data: dict) -> dict:
    doc = _read_dxf(data.get("text"))
    msp = doc.modelspace()
    layers: dict[str, dict[str, Any]] = {}
    total = 0
    for e in msp:
        total += 1
        name = e.dxf.layer
        layer = layers.setdefault(name, {"name": name, "counts": {}, "supported": 0, "unsupported": {}, "bbox": None, "hasZ": False, "zRange": None})
        kind = e.dxftype()
        layer["counts"][kind] = layer["counts"].get(kind, 0) + 1
        if kind not in SUPPORTED:
            layer["unsupported"][kind] = layer["unsupported"].get(kind, 0) + 1
            continue
        pts, _, _ = _vertices(e)
        if len(pts) < 2:
            layer["unsupported"][kind + " (fewer than two vertices)"] = layer["unsupported"].get(kind + " (fewer than two vertices)", 0) + 1
            continue
        layer["supported"] += 1
        xs, ys, zs = [p[0] for p in pts], [p[1] for p in pts], [p[2] for p in pts]
        b = layer["bbox"] or [min(xs), min(ys), max(xs), max(ys)]
        layer["bbox"] = [min(b[0], min(xs)), min(b[1], min(ys)), max(b[2], max(xs)), max(b[3], max(ys))]
        if any(abs(z) > 1e-9 for z in zs):
            layer["hasZ"] = True
            z0, z1 = layer["zRange"] or [min(zs), max(zs)]
            layer["zRange"] = [min(z0, min(zs)), max(z1, max(zs))]
    code = int(doc.header.get("$INSUNITS", 0) or 0)
    name = INSUNITS.get(code, (None, None))[0]
    return {
        "entityTotal": total,
        "insunits": {"code": code, "unit": name, "note": "Declared in the file; confirm it matches the drawing." if name else "The file declares no usable drawing unit. Choose the unit yourself."},
        "layers": sorted(layers.values(), key=lambda l: l["name"]),
    }


# ---- geometry helpers --------------------------------------------------------------------
def _dist(a, b) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _project(p, a, b):
    """Closest point on segment a-b to p: (point, t in [0,1], distance)."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    q = (a[0] + dx * t, a[1] + dy * t)
    return q, t, _dist(p, q)


class _Union:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, i):
        while self.p[i] != i:
            self.p[i] = self.p[self.p[i]]
            i = self.p[i]
        return i

    def union(self, a, b):
        a, b = self.find(a), self.find(b)
        if a != b:
            self.p[max(a, b)] = min(a, b)


def build(data: dict) -> dict:
    """Centrelines -> junctions and tunnels, with near-miss connections listed for review."""
    doc = _read_dxf(data.get("text"))
    layers = data.get("layers")
    if not isinstance(layers, list) or not layers:
        raise ValueError("Select at least one layer")
    unit = data.get("unit")
    if unit not in UNIT_FACTORS:
        raise ValueError("Choose the drawing unit (m, mm, cm, ft, in, km or yd)")
    factor = UNIT_FACTORS[unit]
    snap = float(data.get("snapMetres", 0.1))
    near = float(data.get("nearMissMetres", 3.0))
    if not 0 <= snap <= 5 or not snap <= near <= 50:
        raise ValueError("Snap tolerance must be 0-5 m and the near-miss distance between it and 50 m")
    elevation = data.get("elevation") or {"mode": "unknown"}
    mode = elevation.get("mode")
    if mode not in ("dxf", "constant", "unknown"):
        raise ValueError("Elevation mode must be dxf, constant or unknown")
    constant = None
    if mode == "constant":
        constant = elevation.get("constant")
        if isinstance(constant, bool) or not isinstance(constant, (int, float)) or not -5000 <= constant <= 5000:
            raise ValueError("Enter the constant elevation in metres (-5000 to 5000)")
    accepted = set(data.get("acceptNearMiss") or [])
    warnings: list[str] = []
    skipped: dict[str, int] = {}

    # 1. polylines on the selected layers, in metres
    lines: list[dict] = []
    arcs = 0
    layer_z: dict[str, bool] = {}
    for e in doc.modelspace():
        if e.dxf.layer not in layers:
            continue
        if e.dxftype() not in SUPPORTED:
            skipped[e.dxftype()] = skipped.get(e.dxftype(), 0) + 1
            continue
        pts, closed, bulge = _vertices(e)
        if len(pts) < 2:
            continue
        if closed and len(pts) >= 2:
            pts = pts + [pts[0]]
        arcs += 1 if bulge else 0
        has_z = any(abs(p[2]) > 1e-9 for p in pts)
        layer_z[e.dxf.layer] = layer_z.get(e.dxf.layer, False) or has_z
        lines.append({"layer": e.dxf.layer, "handle": e.dxf.handle, "pts": [(p[0] * factor, p[1] * factor, p[2] * factor) for p in pts], "hasZ": has_z})
    if not lines:
        raise ValueError("The selected layers have no lines or polylines")
    if arcs:
        warnings.append(f"{arcs} polyline(s) contain arcs: {ARC_APPROX_NOTE}.")
    for kind, n in sorted(skipped.items()):
        warnings.append(f"{n} {kind} entit{'y' if n == 1 else 'ies'} on the selected layers {'was' if n == 1 else 'were'} not read (only LINE, LWPOLYLINE and POLYLINE are supported).")
    # Drop zero-length lines.
    lines = [l for l in lines if sum(_dist(l["pts"][i], l["pts"][i + 1]) for i in range(len(l["pts"]) - 1)) > 1e-9]

    # 2. candidate nodes: every polyline end; vertices are added where lines meet
    ends: list[tuple[int, int]] = []  # (line index, vertex index)
    for i, l in enumerate(lines):
        ends.append((i, 0))
        ends.append((i, len(l["pts"]) - 1))
    if len(ends) > MAX_ENDPOINTS:
        raise ValueError(f"Too many line ends ({len(ends)}); split the drawing or select fewer layers (limit {MAX_ENDPOINTS})")
    pos = {k: lines[k[0]]["pts"][k[1]] for k in ends}
    idx = {k: n for n, k in enumerate(ends)}
    uf = _Union(len(ends))
    snapped_ends = 0
    for a in range(len(ends)):
        for b in range(a + 1, len(ends)):
            if _dist(pos[ends[a]], pos[ends[b]]) <= snap + 1e-12 and uf.find(a) != uf.find(b):
                uf.union(a, b)
                snapped_ends += 1
    # 3. T-junctions: a line end resting on another line's interior splits that line there
    splits: dict[int, list[tuple[int, float, tuple[float, float, float]]]] = {}  # line -> [(segment index, t, point)]
    t_junctions = 0
    attach: list[tuple[int, int, int, float, tuple[float, float, float]]] = []  # (end index, line, segment, t, point)

    def find_target(p, own_line, tol):
        best = None
        for j, l in enumerate(lines):
            pts = l["pts"]
            for s in range(len(pts) - 1):
                q, t, d = _project(p, pts[s], pts[s + 1])
                if d > tol or (j == own_line and (t < 1e-9 or t > 1 - 1e-9)):
                    continue
                # Skip contact at the target line's own end vertices: those are handled by node snapping.
                if (s == 0 and t < 1e-9) or (s == len(pts) - 2 and t > 1 - 1e-9):
                    continue
                if best is None or d < best[0]:
                    z = pts[s][2] + (pts[s + 1][2] - pts[s][2]) * t
                    best = (d, j, s, t, (q[0], q[1], z))
        return best

    for k in ends:
        hit = find_target(pos[k], k[0], snap + 1e-12)
        if hit and hit[1] != k[0]:
            _, j, s, t, q = hit
            attach.append((idx[k], j, s, t, q))
    # 4. near misses: dead ends near another node or line but beyond the snap distance
    comp_size: dict[int, int] = {}
    for a in range(len(ends)):
        comp_size[uf.find(a)] = comp_size.get(uf.find(a), 0) + 1
    attached_ends = {a[0] for a in attach}
    near_misses: list[dict] = []
    paired: set[tuple[int, int]] = set()
    for a, k in enumerate(ends):
        if comp_size[uf.find(a)] > 1 or a in attached_ends:
            continue  # already connected
        candidates = []
        for b, k2 in enumerate(ends):
            if uf.find(a) == uf.find(b) or k2[0] == k[0]:
                continue
            d = _dist(pos[k], pos[k2])
            if snap < d <= near:
                candidates.append((d, "node", b, None, None, pos[k2]))
        hit = find_target(pos[k], k[0], near)
        if hit and hit[0] > snap + 1e-12 and hit[1] != k[0]:
            candidates.append((hit[0], "line", hit[1], hit[2], hit[3], hit[4]))
        if candidates:
            candidates.sort(key=lambda c: (round(c[0], 9), c[1], c[2]))
            d, kind, tgt, seg, t, q = candidates[0]
            if kind == "node":
                pair = (min(a, tgt), max(a, tgt))
                if pair in paired:
                    continue  # the same two ends were already proposed from the other side
                paired.add(pair)
            near_misses.append({"_end": a, "distanceM": round(d, 3), "kind": kind, "target": tgt, "segment": seg, "t": t, "point": q, "at": (round(pos[k][0], 3), round(pos[k][1], 3))})
    near_misses.sort(key=lambda n: (n["distanceM"], n["at"]))
    proposals = []
    for n, nm in enumerate(near_misses, 1):
        nm["id"] = f"NM{n}"
        proposals.append({"id": nm["id"], "distanceM": nm["distanceM"], "at": list(nm["at"]), "to": "a line end" if nm["kind"] == "node" else "the middle of another line", "layerA": lines[ends[nm["_end"]][0]]["layer"]})
    for nm in near_misses:
        if nm["id"] not in accepted:
            continue
        if nm["kind"] == "node":
            uf.union(nm["_end"], nm["target"])
        else:
            attach.append((nm["_end"], nm["target"], nm["segment"], nm["t"], nm["point"]))
    unknown_ids = accepted - {nm["id"] for nm in near_misses}
    if unknown_ids:
        raise ValueError("Unknown near-miss id(s): " + ", ".join(sorted(unknown_ids)))

    # 5. node ids: union components of ends, plus split points shared with the ends that rest on them
    node_of_split: dict[tuple[int, int, float], int] = {}
    node_points: list[list[tuple[float, float, float, bool]]] = []
    comp_node: dict[int, int] = {}

    def node_for_end(a: int) -> int:
        r = uf.find(a)
        if r not in comp_node:
            comp_node[r] = len(node_points)
            node_points.append([])
        node_points[comp_node[r]].append((*pos[ends[a]], lines[ends[a][0]]["hasZ"]))
        return comp_node[r]

    end_node = {a: node_for_end(a) for a in range(len(ends))}
    split_node: dict[tuple[int, int, int], int] = {}
    line_cuts: dict[int, list[tuple[int, float, int]]] = {}  # line -> [(segment, t, node)]
    for a, j, s, t, q in attach:
        key = (j, s, round(t, 6))
        if key not in split_node:
            split_node[key] = len(node_points)
            node_points.append([(*q, lines[j]["hasZ"])])
            line_cuts.setdefault(j, []).append((s, t, split_node[key]))
        n = split_node[key]
        # merge the resting end's component node into the split node
        old = end_node[a]
        if old != n:
            for aa, nn in list(end_node.items()):
                if nn == old:
                    end_node[aa] = n
            node_points[n].extend(node_points[old])
            node_points[old] = []
        t_junctions += 1

    # 6. tunnels: split each line at its cuts
    tunnels: list[dict] = []
    elevation_warned = False
    for i, l in enumerate(lines):
        pts = l["pts"]
        first = end_node[idx[(i, 0)]]
        last = end_node[idx[(i, len(pts) - 1)]]
        cuts = sorted(line_cuts.get(i, []))
        # walk along the polyline emitting pieces between consecutive nodes
        pieces: list[tuple[int, int, float, list[tuple[float, float, float]]]] = []
        current = [pts[0]]
        start_node = first
        ci = 0
        for s in range(len(pts) - 1):
            seg_cuts = [c for c in cuts if c[0] == s]
            for (_, t, nid) in seg_cuts:
                a, b = pts[s], pts[s + 1]
                q = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)
                current.append(q)
                pieces.append((start_node, nid, 0.0, current))
                current = [q]
                start_node = nid
                ci += 1
            current.append(pts[s + 1])
        pieces.append((start_node, last, 0.0, current))
        for a_node, b_node, _, path in pieces:
            if a_node == b_node:
                warnings.append(f"A line on layer {l['layer']} returns to the node it starts from and was not made into a tunnel.")
                continue
            plan = sum(_dist(path[k], path[k + 1]) for k in range(len(path) - 1))
            chord = _dist(path[0], path[-1])
            tunnels.append({"from_node": a_node, "to_node": b_node, "layer": l["layer"], "handle": l["handle"], "planLengthM": plan, "chordM": chord})

    # 7. junctions: positions are the mean of the points merged into a node
    used = sorted({t["from_node"] for t in tunnels} | {t["to_node"] for t in tunnels})
    jid = {n: f"J{k + 1}" for k, n in enumerate(used)}
    junctions = []
    for n in used:
        ps = node_points[n]
        x = sum(p[0] for p in ps) / len(ps)
        y = sum(p[1] for p in ps) / len(ps)
        z: float | None
        if mode == "constant":
            z = float(constant)
        elif mode == "dxf":
            zs = [p[2] for p in ps if p[3]]
            z = None
            if zs:
                z = sum(zs) / len(zs)
                if max(zs) - min(zs) > 0.5:
                    warnings.append(f"Junction {jid[n]} joins lines with elevations {min(zs):.2f} and {max(zs):.2f} m; the average was used. Check it.")
        else:
            z = None
        junctions.append({"id": jid[n], "x": round(x, 4), "y": round(y, 4), "z": None if z is None else round(z, 3)})
    if mode == "dxf" and any(j["z"] is None for j in junctions):
        flat = [layer for layer, has in layer_z.items() if not has]
        warnings.append("Elevation: some junctions have no elevation because their layer carries none" + (f" ({', '.join(sorted(flat))})" if flat else "") + ". They stay not entered; set them in the editor.")
    out_tunnels = []
    for k, t in enumerate(tunnels, 1):
        # A length is entered only where the drawn path is meaningfully longer than the straight line.
        length = round(t["planLengthM"], 3) if t["planLengthM"] > t["chordM"] * 1.01 + 1e-9 else None
        out_tunnels.append({"id": f"T{k}", "from": jid[t["from_node"]], "to": jid[t["to_node"]], "length": length, "layer": t["layer"], "sourceHandle": t["handle"]})
    # connected components (isolated parts are listed, not hidden)
    adj: dict[str, set[str]] = {j["id"]: set() for j in junctions}
    for t in out_tunnels:
        adj[t["from"]].add(t["to"])
        adj[t["to"]].add(t["from"])
    seen: set[str] = set()
    components: list[list[str]] = []
    for j in adj:
        if j in seen:
            continue
        stack, comp = [j], []
        while stack:
            c = stack.pop()
            if c in seen:
                continue
            seen.add(c)
            comp.append(c)
            stack.extend(adj[c] - seen)
        components.append(sorted(comp, key=lambda s: int(s[1:])))
    if len(components) > 1:
        warnings.append(f"The drawing has {len(components)} separate parts that are not connected to each other.")
    xs = [j["x"] for j in junctions]
    ys = [j["y"] for j in junctions]
    return {
        "unit": unit,
        "factorToMetres": factor,
        "junctions": junctions,
        "tunnels": out_tunnels,
        "nearMisses": proposals,
        "acceptedNearMiss": sorted(accepted),
        "components": components,
        "stats": {"lines": len(lines), "junctions": len(junctions), "tunnels": len(out_tunnels), "snappedEnds": snapped_ends, "tJunctions": t_junctions, "nearMisses": len(proposals), "arcPolylines": arcs},
        "bbox": [min(xs), min(ys), max(xs), max(ys)],
        "elevation": {"mode": mode, "constant": constant},
        "warnings": warnings,
    }


# ---- GeoTIFF base maps --------------------------------------------------------------------------
def _png(array, mode: str) -> str:
    from PIL import Image

    img = Image.fromarray(array, mode)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def basemap(data: dict) -> dict:
    import numpy as np
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.errors import RasterioIOError

    raw = data.get("b64")
    if not isinstance(raw, str) or not raw:
        raise ValueError("No GeoTIFF was supplied")
    try:
        blob = base64.b64decode(raw, validate=True)
    except ValueError as exc:
        raise ValueError("The file was not valid base64") from exc
    max_px = int(data.get("maxPixels", 1600))
    if not 100 <= max_px <= 4000:
        max_px = min(4000, max(100, max_px))
    try:
        mf = rasterio.MemoryFile(blob)
        ds = mf.open()
    except RasterioIOError as exc:
        raise ValueError(f"This is not a readable GeoTIFF: {exc}") from exc
    with mf, ds:
        if ds.crs is None:
            raise ValueError("The file has no coordinate reference system, so it cannot be placed on the plan")
        factor = None if ds.crs.is_geographic else ds.crs.linear_units_factor[1]
        t0 = ds.transform
        reason = None
        if ds.crs.is_geographic:
            reason = "The file uses latitude and longitude (degrees). Reproject it to a metre-based projected system (for example UTM) before uploading, or let Foresight reproject it"
        elif abs(factor - 1.0) > 1e-9:
            reason = f"The file's coordinates are in {ds.crs.linear_units}, not metres. Reproject it to a metre-based system, or let Foresight reproject it"
        elif abs(t0.b) > 1e-9 or abs(t0.d) > 1e-9:
            reason = "Rotated or sheared rasters are not supported unless Foresight reprojects them north-up. Reproject or resample the file north-up, or let Foresight reproject it"
        vrt = None
        reprojected = None
        bands = ds.count
        if reason:
            if not data.get("reproject"):
                raise ValueError(reason)
            from rasterio.crs import CRS
            from rasterio.vrt import WarpedVRT
            from rasterio.warp import calculate_default_transform, transform as warp_transform

            cx, cy = (ds.bounds.left + ds.bounds.right) / 2, (ds.bounds.bottom + ds.bounds.top) / 2
            lons, lats = warp_transform(ds.crs, "EPSG:4326", [cx], [cy])
            lon, lat = lons[0], lats[0]
            if abs(lat) > 84:
                raise ValueError("The file lies in a polar region, where UTM reprojection is not available")
            zone = min(60, max(1, int((lon + 180) // 6) + 1))
            epsg = (32600 if lat >= 0 else 32700) + zone
            dst = CRS.from_epsg(epsg)
            _, dw, dh = calculate_default_transform(ds.crs, dst, ds.width, ds.height, *ds.bounds)
            k = min(1.0, max_px / max(dw, dh))
            dt, dw, dh = calculate_default_transform(ds.crs, dst, ds.width, ds.height, *ds.bounds, dst_width=max(1, round(dw * k)), dst_height=max(1, round(dh * k)))
            vrt = WarpedVRT(ds, crs=dst, transform=dt, width=dw, height=dh, resampling=Resampling.bilinear, add_alpha=(ds.count != 4))
            reprojected = {"from": ds.crs.to_string(), "to": f"EPSG:{epsg}", "method": "bilinear", "note": f"The picture was resampled into the UTM zone {zone}{'N' if lat >= 0 else 'S'} grid so it can sit on the metre-based plan. Positions are good to about one pixel; the original file is unchanged."}
        src = vrt or ds
        try:
            scale = 1.0 if vrt else min(1.0, max_px / max(ds.width, ds.height))
            w, h = (src.width, src.height) if vrt else (max(1, round(ds.width * scale)), max(1, round(ds.height * scale)))
            idx = list(range(1, bands + 1))
            data_arr = src.read(indexes=idx, out_shape=(bands, h, w), resampling=Resampling.average)
            # The dataset mask honours nodata and the alpha band added when reprojecting.
            mask_arr = src.read_masks(indexes=idx, out_shape=(bands, h, w), resampling=Resampling.nearest)
            blank = mask_arr == 0
            if vrt is not None and ds.count != 4:
                # The alpha band added by the warp marks pixels outside the source footprint.
                alpha_band = src.read(bands + 1, out_shape=(h, w), resampling=Resampling.nearest)
                blank = blank | (alpha_band == 0)[None, :, :]
            arr = np.ma.masked_array(data_arr, mask=blank)
            b = src.bounds
            t = src.transform
            info = {
                "crs": src.crs.to_string(),
                "epsg": src.crs.to_epsg(),
                "bounds": {"west": b.left, "south": b.bottom, "east": b.right, "north": b.top},
                "pixelSizeM": [abs(t.a), abs(t.e)],
                "originalPixels": [ds.width, ds.height],
                "pixels": [w, h],
                "bands": bands,
                "dtype": ds.dtypes[0],
                **({"reprojected": reprojected} if reprojected else {}),
            }
        finally:
            if vrt:
                pass
        if ds.count >= 3:
            rgb = np.ma.filled(arr[:3], 0).astype("float64")
            if ds.dtypes[0] != "uint8":
                lo, hi = np.percentile(rgb[rgb > 0], [2, 98]) if (rgb > 0).any() else (0, 1)
                rgb = np.clip((rgb - lo) / max(hi - lo, 1e-9), 0, 1) * 255
                info["displayStretch"] = f"Values were stretched to 8 bits for display ({ds.dtypes[0]}, {lo:g}-{hi:g}); the file itself is unchanged."
            img = np.moveaxis(rgb.astype("uint8"), 0, -1)
            alpha = (np.ma.getmaskarray(arr[0]) == False).astype("uint8") * 255  # noqa: E712
            if ds.count >= 4:
                alpha = np.minimum(alpha, np.ma.filled(arr[3], 0).astype("uint8"))
            info.update(kind="orthophoto", range=None, png=_png(np.dstack([img, alpha]), "RGBA"))
        else:
            band = arr[0]
            valid = ~np.ma.getmaskarray(band)
            if not valid.any():
                raise ValueError("The raster has no valid (non-nodata) pixels")
            lo, hi = float(band.min()), float(band.max())
            norm = np.zeros(band.shape, dtype="float64") if hi == lo else (np.ma.filled(band, lo).astype("float64") - lo) / (hi - lo)
            # Low = dark green, high = pale: a plain ramp; the legend states the real range.
            r = (30 + 200 * norm).astype("uint8")
            g = (90 + 140 * norm).astype("uint8")
            bl = (50 + 150 * norm).astype("uint8")
            a = valid.astype("uint8") * 255
            info.update(kind="elevation", range={"min": lo, "max": hi, "units": "as stored in the file (not assumed to be metres)"}, nodataPercent=round(100 * (1 - valid.mean()), 2), png=_png(np.dstack([r, g, bl, a]), "RGBA"))
        if vrt:
            vrt.close()
        return info
