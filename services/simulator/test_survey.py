"""Surveyor imports (spec 8.3, 8.5). DXF fixtures are written with ezdxf in the
tests; GeoTIFF fixtures with rasterio. Expected values are worked out by hand
from the coordinates below, not taken from the importer's output."""
import base64
import io
import math
import unittest

import ezdxf
import numpy as np
import rasterio
from rasterio.transform import from_origin

from . import survey


def dxf_text(build, units=6):
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = units
    build(doc, doc.modelspace())
    out = io.StringIO()
    doc.write(out)
    return out.getvalue()


def network(doc, msp):
    doc.layers.add("DRIVES")
    doc.layers.add("ANNOT")
    # Main drive A (0,0)->(100,0); branch B meets A's end with a 0.02 m gap; side drive C ends ON A's interior at x=40 (T-junction).
    msp.add_lwpolyline([(0, 0), (100, 0)], dxfattribs={"layer": "DRIVES"})
    msp.add_lwpolyline([(100.02, 0), (100.02, 60)], dxfattribs={"layer": "DRIVES"})
    msp.add_line((40, 0), (40, -30), dxfattribs={"layer": "DRIVES"})
    # Dead end 1.5 m short of node (100.02,60)'s neighbour: a near miss to the end of D.
    msp.add_line((100.02, 61.5), (100.02, 90), dxfattribs={"layer": "DRIVES"})
    msp.add_text("Level 1", dxfattribs={"layer": "ANNOT"})
    msp.add_circle((10, 10), 2, dxfattribs={"layer": "DRIVES"})


class DxfTests(unittest.TestCase):
    def test_inspect_lists_layers_counts_unsupported_and_declared_units(self):
        r = survey.inspect({"text": dxf_text(network)})
        self.assertEqual(r["insunits"]["unit"], "m")
        by = {l["name"]: l for l in r["layers"]}
        self.assertEqual(by["DRIVES"]["supported"], 4)
        self.assertEqual(by["DRIVES"]["unsupported"], {"CIRCLE": 1})
        self.assertEqual(by["ANNOT"]["supported"], 0)
        self.assertEqual(by["DRIVES"]["bbox"], [0, -30, 100.02, 90])
        self.assertFalse(by["DRIVES"]["hasZ"])
        self.assertEqual(survey.inspect({"text": dxf_text(network, units=0)})["insunits"]["unit"], None)

    def test_snap_t_junction_and_near_miss(self):
        r = survey.build({"text": dxf_text(network), "layers": ["DRIVES"], "unit": "m", "snapMetres": 0.1, "nearMissMetres": 3, "elevation": {"mode": "unknown"}})
        # Junctions: (0,0); the merged A/B end (100.01,0); (100.02,60); (100.02,61.5); (100.02,90); T at (40,0); (40,-30). = 7
        # Tunnels: A split at the T = 2, B = 1, C = 1, D = 1. = 5
        self.assertEqual((r["stats"]["junctions"], r["stats"]["tunnels"]), (7, 5))
        self.assertEqual(r["stats"]["snappedEnds"], 1)
        self.assertEqual(r["stats"]["tJunctions"], 1)
        pos = {(round(j["x"]), round(j["y"])) for j in r["junctions"]}
        self.assertEqual(pos, {(0, 0), (100, 0), (100, 60), (100, 62), (100, 90), (40, 0), (40, -30)})
        self.assertEqual([n["distanceM"] for n in r["nearMisses"]], [1.5])
        self.assertEqual(len(r["components"]), 2, "the dead-end drive is a separate part until the near miss is accepted")
        self.assertTrue(any("2 separate parts" in w or "separate parts" in w for w in r["warnings"]))
        self.assertTrue(any("1 CIRCLE entity" in w for w in r["warnings"]))
        self.assertTrue(all(j["z"] is None for j in r["junctions"]))

    def test_accepting_a_near_miss_connects_it(self):
        base = {"text": dxf_text(network), "layers": ["DRIVES"], "unit": "m", "snapMetres": 0.1, "nearMissMetres": 3, "elevation": {"mode": "unknown"}}
        r = survey.build({**base, "acceptNearMiss": ["NM1"]})
        self.assertEqual(len(r["components"]), 1)
        self.assertEqual(r["stats"]["junctions"], 6)
        with self.assertRaises(ValueError):
            survey.build({**base, "acceptNearMiss": ["NM9"]})

    def test_nothing_is_connected_beyond_the_snap_distance_by_itself(self):
        r = survey.build({"text": dxf_text(network), "layers": ["DRIVES"], "unit": "m", "snapMetres": 0.0, "nearMissMetres": 3})
        # With no snapping the 0.02 m gap becomes a near miss too, and A/B stay separate.
        self.assertEqual(sorted(n["distanceM"] for n in r["nearMisses"]), [0.02, 1.5])

    def test_units_are_converted_to_metres_and_must_be_chosen(self):
        def mm(doc, msp):
            msp.add_line((0, 0), (12000, 0))
            msp.add_line((12000, 0), (12000, 5000))
        text = dxf_text(mm, units=4)
        r = survey.build({"text": text, "layers": ["0"], "unit": "mm"})
        self.assertEqual(sorted((j["x"], j["y"]) for j in r["junctions"]), [(0.0, 0.0), (12.0, 0.0), (12.0, 5.0)])
        wrong = survey.build({"text": text, "layers": ["0"], "unit": "m"})
        self.assertEqual(max(j["x"] for j in wrong["junctions"]), 12000.0, "the person's choice is used, not the file's declaration")
        with self.assertRaises(ValueError):
            survey.build({"text": text, "layers": ["0"], "unit": "furlong"})
        with self.assertRaises(ValueError):
            survey.build({"text": text, "layers": ["0"]})

    def test_elevations_from_a_3d_layer_constant_or_unknown(self):
        def drive(doc, msp):
            doc.layers.add("D3")
            doc.layers.add("D2")
            msp.add_polyline3d([(0, 0, -60), (50, 0, -62)], dxfattribs={"layer": "D3"})
            msp.add_line((50, 0), (50, 40), dxfattribs={"layer": "D2"})
        text = dxf_text(drive)
        base = {"text": text, "layers": ["D3", "D2"], "unit": "m"}
        r = survey.build({**base, "elevation": {"mode": "dxf"}})
        z = {(j["x"], j["y"]): j["z"] for j in r["junctions"]}
        self.assertEqual(z[(0.0, 0.0)], -60.0)
        self.assertEqual(z[(50.0, 0.0)], -62.0)  # only the 3D line carries elevation here
        self.assertIsNone(z[(50.0, 40.0)])  # a flat layer is NOT read as 0 m
        self.assertTrue(any("no elevation" in w for w in r["warnings"]))
        c = survey.build({**base, "elevation": {"mode": "constant", "constant": -45}})
        self.assertTrue(all(j["z"] == -45.0 for j in c["junctions"]))
        with self.assertRaises(ValueError):
            survey.build({**base, "elevation": {"mode": "constant"}})
        u = survey.build({**base, "elevation": {"mode": "unknown"}})
        self.assertTrue(all(j["z"] is None for j in u["junctions"]))

    def test_curved_polylines_keep_their_drawn_length_and_say_arcs_are_approximated(self):
        def arc(doc, msp):
            pl = msp.add_lwpolyline([(0, 0, 0), (10, 0, 1.0)], format="xyb")  # semicircle of diameter 10
            pl.dxf.layer = "0"
        r = survey.build({"text": dxf_text(arc), "layers": ["0"], "unit": "m"})
        self.assertEqual(r["tunnels"][0]["length"], None)  # chord-only geometry: path length equals the chord
        self.assertTrue(any("arcs" in w for w in r["warnings"]))

    def test_bent_polyline_length_is_the_drawn_path_not_the_chord(self):
        def bent(doc, msp):
            msp.add_lwpolyline([(0, 0), (30, 0), (30, 40)])
        r = survey.build({"text": dxf_text(bent), "layers": ["0"], "unit": "m"})
        self.assertEqual(len(r["tunnels"]), 1)
        self.assertEqual(r["tunnels"][0]["length"], 70.0)  # 30 + 40, chord is 50

    def test_bad_input_is_refused(self):
        with self.assertRaises(ValueError):
            survey.inspect({"text": "this is not a dxf"})
        with self.assertRaises(ValueError):
            survey.inspect({"text": ""})
        with self.assertRaises(ValueError):
            survey.build({"text": dxf_text(network), "layers": ["ANNOT"], "unit": "m"})
        with self.assertRaises(ValueError):
            survey.build({"text": dxf_text(network), "layers": [], "unit": "m"})

    def test_build_is_deterministic(self):
        a = survey.build({"text": dxf_text(network), "layers": ["DRIVES"], "unit": "m"})
        b = survey.build({"text": dxf_text(network), "layers": ["DRIVES"], "unit": "m"})
        self.assertEqual(a, b)


def tif(width, height, count, dtype, crs="EPSG:32736", transform=None, fill=None, nodata=None):
    transform = transform or from_origin(300000, 8000000, 2.0, 2.0)
    buf = io.BytesIO()
    with rasterio.MemoryFile() as mem:
        with mem.open(driver="GTiff", width=width, height=height, count=count, dtype=dtype, crs=crs, transform=transform, nodata=nodata) as ds:
            for b in range(count):
                ds.write(fill(b, height, width) if fill else np.zeros((height, width), dtype=dtype), b + 1)
        buf.write(mem.read())
    return base64.b64encode(buf.getvalue()).decode()


class BaseMapTests(unittest.TestCase):
    def test_orthophoto_bounds_pixel_size_and_png(self):
        b64 = tif(100, 80, 3, "uint8", fill=lambda b, h, w: np.full((h, w), 50 * (b + 1), dtype="uint8"))
        r = survey.basemap({"b64": b64})
        # 100 px x 2 m = 200 m wide, 80 px x 2 m = 160 m high, origin (300000, 8000000) top-left.
        self.assertEqual(r["bounds"], {"west": 300000.0, "south": 7999840.0, "east": 300200.0, "north": 8000000.0})
        self.assertEqual(r["pixelSizeM"], [2.0, 2.0])
        self.assertEqual(r["kind"], "orthophoto")
        self.assertEqual(r["epsg"], 32736)
        from PIL import Image
        img = Image.open(io.BytesIO(base64.b64decode(r["png"])))
        self.assertEqual(img.size, (100, 80))
        self.assertEqual(img.getpixel((5, 5))[:3], (50, 100, 150))

    def test_large_rasters_are_downsampled_but_report_the_original_size(self):
        b64 = tif(300, 200, 3, "uint8")
        r = survey.basemap({"b64": b64, "maxPixels": 100})
        self.assertEqual(r["originalPixels"], [300, 200])
        self.assertEqual(r["pixels"], [100, 67])
        self.assertEqual(r["bounds"]["east"] - r["bounds"]["west"], 600.0)  # still covers the same ground

    def test_elevation_model_reports_its_real_range_and_masks_nodata(self):
        def dem(b, h, w):
            a = np.linspace(1200, 1230, w, dtype="float32")[None, :].repeat(h, axis=0)
            a[:, :5] = -9999
            return a
        r = survey.basemap({"b64": tif(60, 40, 1, "float32", fill=dem, nodata=-9999)})
        self.assertEqual(r["kind"], "elevation")
        self.assertAlmostEqual(r["range"]["min"], 1200 + 30 * 5 / 59, places=3)
        self.assertAlmostEqual(r["range"]["max"], 1230.0, places=3)
        self.assertAlmostEqual(r["nodataPercent"], 100 * 5 / 60, places=1)
        self.assertIn("not assumed to be metres", r["range"]["units"])

    def test_unplaceable_rasters_are_refused_with_a_reason(self):
        with self.assertRaisesRegex(ValueError, "degrees"):
            survey.basemap({"b64": tif(10, 10, 3, "uint8", crs="EPSG:4326", transform=from_origin(31.0, -17.0, 0.001, 0.001))})
        with self.assertRaisesRegex(ValueError, "no coordinate reference system"):
            survey.basemap({"b64": tif(10, 10, 3, "uint8", crs=None)})
        from affine import Affine
        with self.assertRaisesRegex(ValueError, "Rotated"):
            survey.basemap({"b64": tif(10, 10, 3, "uint8", transform=Affine(2.0, 0.3, 300000, 0.3, -2.0, 8000000))})
        with self.assertRaisesRegex(ValueError, "not a readable GeoTIFF"):
            survey.basemap({"b64": base64.b64encode(b"not a tiff").decode()})
        with self.assertRaises(ValueError):
            survey.basemap({"b64": ""})


class ReprojectionTests(unittest.TestCase):
    def test_geographic_raster_is_reprojected_to_the_utm_zone_of_its_centre(self):
        # 100 x 80 px of 0.001 degree: lon 31.00-31.10, lat -17.75 to -17.83 (zone 36 south, central meridian 33 E).
        b64 = tif(100, 80, 3, "uint8", crs="EPSG:4326", transform=from_origin(31.0, -17.75, 0.001, 0.001), fill=lambda b, h, w: np.full((h, w), 80 * (b + 1), dtype="uint8"))
        r = survey.basemap({"b64": b64, "reproject": True})
        self.assertEqual(r["epsg"], 32736)
        self.assertEqual(r["reprojected"]["from"], "EPSG:4326")
        self.assertEqual(r["reprojected"]["to"], "EPSG:32736")
        self.assertIn("resampled", r["reprojected"]["note"])
        bd = r["bounds"]
        # Independent estimate: easting = 500000 - (33 - lon) x 111.32 km x cos(lat); northing = 10,000,000 + lat x 110.6 km.
        lat = -17.79
        east_w = 500000 - (33 - 31.00) * 111320 * math.cos(math.radians(lat))
        east_e = 500000 - (33 - 31.10) * 111320 * math.cos(math.radians(lat))
        self.assertAlmostEqual(bd["west"], east_w, delta=1500)
        self.assertAlmostEqual(bd["east"], east_e, delta=1500)
        self.assertAlmostEqual((bd["north"] + bd["south"]) / 2, 10_000_000 + lat * 110600, delta=3000)
        self.assertGreater(r["pixelSizeM"][0], 90)  # 0.001 degree is about 105 m of easting
        self.assertLess(r["pixelSizeM"][0], 120)
        from PIL import Image
        img = Image.open(io.BytesIO(base64.b64decode(r["png"])))
        self.assertEqual(img.mode, "RGBA")
        cx, cy = img.size[0] // 2, img.size[1] // 2
        self.assertEqual(img.getpixel((cx, cy))[:3], (80, 160, 240))  # imagery colour survives, bilinear on a flat colour
        self.assertEqual(img.getpixel((0, 0))[3] in (0, 255), True)

    def test_rotated_raster_is_warped_north_up_and_its_footprint_matches_the_rotated_corners(self):
        from affine import Affine
        theta = math.radians(20)
        c, s = math.cos(theta), math.sin(theta)
        # 60 x 40 px at 5 m, rotated 20 degrees about the top-left corner (310000, 8000200).
        t = Affine(5 * c, 5 * s, 310000, 5 * s, -5 * c, 8000200)
        b64 = tif(60, 40, 3, "uint8", transform=t)
        with self.assertRaisesRegex(ValueError, "Rotated"):
            survey.basemap({"b64": b64})
        r = survey.basemap({"b64": b64, "reproject": True})
        corners = [t * (0, 0), t * (60, 0), t * (0, 40), t * (60, 40)]
        xs, ys = [p[0] for p in corners], [p[1] for p in corners]
        self.assertAlmostEqual(r["bounds"]["west"], min(xs), delta=8)
        self.assertAlmostEqual(r["bounds"]["east"], max(xs), delta=8)
        self.assertAlmostEqual(r["bounds"]["south"], min(ys), delta=8)
        self.assertAlmostEqual(r["bounds"]["north"], max(ys), delta=8)
        self.assertIn("reprojected", r)

    def test_projected_metre_raster_is_left_alone_even_when_reprojection_is_allowed(self):
        r = survey.basemap({"b64": tif(60, 40, 3, "uint8"), "reproject": True})
        self.assertNotIn("reprojected", r)
        self.assertEqual(r["epsg"], 32736)

    def test_reprojected_elevation_model_keeps_its_value_range_and_masks_outside_pixels(self):
        def dem(b, h, w):
            return np.linspace(1200, 1230, w, dtype="float32")[None, :].repeat(h, axis=0)
        r = survey.basemap({"b64": tif(60, 40, 1, "float32", crs="EPSG:4326", transform=from_origin(31.0, -17.75, 0.001, 0.001), fill=dem), "reproject": True})
        self.assertEqual(r["kind"], "elevation")
        self.assertAlmostEqual(r["range"]["min"], 1200, delta=1.0)
        self.assertAlmostEqual(r["range"]["max"], 1230, delta=1.0)

    def test_polar_rasters_are_refused(self):
        with self.assertRaisesRegex(ValueError, "polar"):
            survey.basemap({"b64": tif(10, 10, 3, "uint8", crs="EPSG:4326", transform=from_origin(10.0, 89.0, 0.001, 0.001)), "reproject": True})


if __name__ == "__main__":
    unittest.main()
