"""Ventilation solver (spec 9.8, 16.1). Expected values are closed-form results
worked out by hand (equal pressure drop in parallel airways) or checked against
the two physical laws on every airway and an independent nonlinear solver.

NOT here yet: a published textbook worked example. The spec requires one before
results are shown; the source could not be retrieved while building this. See
TextbookReference below."""
import math
import random
import unittest

import numpy as np
from scipy.optimize import least_squares

from . import ventilation as v


def parallel(rs, total, extra=None):
    airways = [{"id": f"P{i}", "from": "A", "to": "B", "resistance": r} for i, r in enumerate(rs)] + [{"id": "FAN", "from": "B", "to": "A", "fixed": total}]
    return {"nodes": ["A", "B"], "airways": airways + (extra or []), "slack": [], "tolerance": 1e-10}


def flows(res):
    return {a["id"]: a["flowM3s"] for a in res["airways"]}


class SolverTests(unittest.TestCase):
    def test_closed_form_parallel_airways(self):
        # Equal pressure drop: R1 q1^2 = R2 q2^2. R=4,1 carrying 30 -> 10 and 20 (both drop 400 Pa).
        r = v.solve_network(parallel([4.0, 1.0], 30.0))
        f = flows(r)
        self.assertAlmostEqual(f["P0"], 10.0, places=8)
        self.assertAlmostEqual(f["P1"], 20.0, places=8)
        self.assertAlmostEqual(r["airways"][0]["pressureDropPa"], 400.0, places=6)
        self.assertAlmostEqual(r["airways"][1]["pressureDropPa"], 400.0, places=6)
        # R=1,4,9 carrying 22 -> 12, 6, 4 (all drop 144 Pa).
        f = flows(v.solve_network(parallel([1.0, 4.0, 9.0], 22.0)))
        self.assertAlmostEqual(f["P0"], 12.0, places=8)
        self.assertAlmostEqual(f["P1"], 6.0, places=8)
        self.assertAlmostEqual(f["P2"], 4.0, places=8)
        self.assertTrue(all(c["passed"] for c in v.reference_checks()))

    def test_fan_operating_point_is_the_pressure_across_the_network_and_power_follows(self):
        r = v.solve_network(parallel([4.0, 1.0], 30.0))
        fan = next(a for a in r["airways"] if a["id"] == "FAN")
        self.assertAlmostEqual(fan["fanPressureRisePa"], 400.0, places=6)
        self.assertAlmostEqual(fan["fanPowerW"], 12000.0, places=4)

    def test_series_airways_carry_the_fan_flow_and_drops_add_up(self):
        data = {"nodes": ["A", "B", "C", "D"], "airways": [
            {"id": "S1", "from": "A", "to": "B", "resistance": 2.0}, {"id": "S2", "from": "B", "to": "C", "resistance": 3.0},
            {"id": "S3", "from": "C", "to": "D", "resistance": 5.0}, {"id": "FAN", "from": "D", "to": "A", "fixed": 10.0}], "slack": []}
        r = v.solve_network(data)
        self.assertTrue(all(abs(flows(r)[k] - 10.0) < 1e-9 for k in ("S1", "S2", "S3")))
        self.assertAlmostEqual(next(a for a in r["airways"] if a["id"] == "FAN")["fanPressureRisePa"], (2 + 3 + 5) * 100.0, places=6)
        self.assertEqual(r["iterations"], 0)  # no loops: nothing to iterate

    def test_surface_links_with_zero_resistance_and_a_slack_node(self):
        # Two intakes at the surface (zero-resistance links) feed R=4 and R=1 airways to a junction with an exhaust fan of 30.
        data = {"nodes": ["S", "A", "B", "J"], "slack": ["S"], "tolerance": 1e-10, "airways": [
            {"id": "SA", "from": "S", "to": "A", "resistance": 0.0}, {"id": "SB", "from": "S", "to": "B", "resistance": 0.0},
            {"id": "AJ", "from": "A", "to": "J", "resistance": 4.0}, {"id": "BJ", "from": "B", "to": "J", "resistance": 1.0},
            {"id": "FAN", "from": "J", "to": "S", "fixed": 30.0}]}
        f = flows(v.solve_network(data))
        for k, e in {"AJ": 10.0, "BJ": 20.0, "SA": 10.0, "SB": 20.0}.items():
            self.assertAlmostEqual(f[k], e, places=7, msg=k)

    def test_flow_reversal_is_reported_against_the_drawn_direction(self):
        # P1 is drawn B -> A but the fan pushes A -> B overall, so its flow is negative.
        data = parallel([4.0], 30.0, [{"id": "P1", "from": "B", "to": "A", "resistance": 1.0}])
        r = v.solve_network(data)
        f = flows(r)
        self.assertAlmostEqual(f["P0"], 10.0, places=7)
        self.assertAlmostEqual(f["P1"], -20.0, places=7)
        self.assertEqual(r["reversals"], ["P1"])
        p1 = next(a for a in r["airways"] if a["id"] == "P1")
        self.assertEqual((p1["direction"], p1["reversedFromDrawn"]), ("to-from", True))

    def test_disconnected_sections_are_listed_not_given_made_up_flows(self):
        data = parallel([4.0, 1.0], 30.0, [
            {"id": "X1", "from": "C", "to": "D", "resistance": 2.0},                       # a separate section with no fan
            {"id": "FAN2", "from": "E", "to": "F", "fixed": 5.0}, {"id": "Y1", "from": "E", "to": "F", "resistance": 1.0}])
        data["nodes"] = ["A", "B", "C", "D", "E", "F", "G"]
        # E -> F fan forces 5 m3/s from E to F; the free section E-F carries it back: fine. G is isolated.
        r = v.solve_network(data)
        by = {tuple(sorted(s["nodes"])): s for s in r["sections"]}
        self.assertEqual(by[("C", "D")]["status"], "no-driver")
        self.assertEqual(by[("G",)]["status"], "isolated")
        self.assertEqual(flows(r)["X1"], 0.0)
        self.assertAlmostEqual(flows(r)["P0"], 10.0, places=7)
        # A fan that pushes air into a closed section with no way out cannot balance.
        bad = {"nodes": ["A", "B", "C"], "slack": [], "airways": [{"id": "FAN", "from": "A", "to": "B", "fixed": 8.0}, {"id": "T", "from": "B", "to": "C", "resistance": 1.0}]}
        rb = v.solve_network(bad)
        self.assertEqual({sec["status"] for sec in rb["sections"]}, {"infeasible"})
        self.assertTrue(any("cannot balance" in sec["note"] for sec in rb["sections"]))
        self.assertEqual(flows(rb)["T"], 0.0)

    def test_tolerance_and_iteration_limit_are_reported(self):
        data = parallel([4.0, 1.0], 30.0)
        data["tolerance"] = 1e-9
        r = v.solve_network(data)
        self.assertTrue(r["converged"])
        self.assertEqual((r["tolerance"], r["maxIterations"]), (1e-9, v.DEFAULT_MAX_ITERATIONS))
        self.assertGreaterEqual(r["iterations"], 1)
        self.assertLess(r["finalMaxCorrection"], 1e-9)
        data["maxIterations"] = 1
        data["tolerance"] = 1e-12
        stopped = v.solve_network(data)
        self.assertFalse(stopped["converged"])
        self.assertEqual(stopped["iterations"], 1)
        self.assertLess(r["continuityResidualM3s"], 1e-9)

    def test_random_networks_satisfy_both_laws_and_match_an_independent_solver(self):
        for seed in range(8):
            rng = random.Random(seed)
            n = rng.randint(5, 9)
            nodes = [f"N{i}" for i in range(n)]
            edges = [(i, i + 1) for i in range(n - 1)] + [(rng.randrange(n), rng.randrange(n)) for _ in range(rng.randint(3, 7))]
            edges = [(a, b) for a, b in edges if a != b]
            airways = [{"id": f"E{k}", "from": nodes[a], "to": nodes[b], "resistance": round(rng.uniform(0.5, 10.0), 3)} for k, (a, b) in enumerate(edges)]
            airways.append({"id": "FAN", "from": nodes[-1], "to": nodes[0], "fixed": round(rng.uniform(5, 40), 2)})
            res = v.solve_network({"nodes": nodes, "airways": airways, "slack": [], "tolerance": 1e-11})
            self.assertTrue(res["converged"], seed)
            f = flows(res)
            p = res["nodePressuresPa"]
            # Law 1, continuity at every node (including the fan edge).
            net = {x: 0.0 for x in nodes}
            for a in airways:
                net[a["to"]] += f[a["id"]]
                net[a["from"]] -= f[a["id"]]
            self.assertLess(max(abs(x) for x in net.values()), 1e-8, seed)
            # Law 2, pressure drop R Q|Q| on every free airway.
            for a in airways[:-1]:
                self.assertAlmostEqual(p[a["from"]] - p[a["to"]], a["resistance"] * f[a["id"]] * abs(f[a["id"]]), places=5, msg=f"{seed} {a['id']}")
            # Independent solve of the nodal equations from a cold start (potentials unknown, node N0 fixed at 0).
            idx = {x: i for i, x in enumerate(nodes)}
            free = airways[:-1]
            demand = np.zeros(n)
            demand[idx[airways[-1]["from"]]] += airways[-1]["fixed"]
            demand[idx[airways[-1]["to"]]] -= airways[-1]["fixed"]

            def residual(x):
                pot = np.concatenate([[0.0], x])
                net_in = np.zeros(n)
                for a in free:
                    dp = pot[idx[a["from"]]] - pot[idx[a["to"]]]
                    q = math.copysign(math.sqrt(abs(dp) / a["resistance"]), dp)
                    net_in[idx[a["to"]]] += q
                    net_in[idx[a["from"]]] -= q
                return (net_in - demand)[1:]

            sol = least_squares(residual, x0=np.full(n - 1, -1.0), xtol=1e-14, ftol=1e-14, gtol=1e-14)
            pot = np.concatenate([[0.0], sol.x])
            for a in free:
                dp = pot[idx[a["from"]]] - pot[idx[a["to"]]]
                self.assertAlmostEqual(math.copysign(math.sqrt(abs(dp) / a["resistance"]), dp), f[a["id"]], places=4, msg=f"{seed} {a['id']}")

    def test_area_gives_velocity_and_results_are_deterministic(self):
        data = parallel([4.0, 1.0], 30.0)
        data["airways"][0]["areaM2"] = 5.0
        r = v.solve_network(data)
        self.assertAlmostEqual(r["airways"][0]["velocityMs"], 2.0, places=7)
        self.assertEqual(v.solve_network(data), r)

    def test_invalid_input_is_refused(self):
        bad = [
            {"nodes": ["A"], "airways": [{"id": "x", "from": "A", "to": "B", "resistance": 1.0}]},
            {"nodes": ["A", "B"], "airways": [{"id": "x", "from": "A", "to": "B", "resistance": -1.0}]},
            {"nodes": ["A", "B"], "airways": [{"id": "x", "from": "A", "to": "B"}]},
            {"nodes": ["A", "B"], "airways": [{"id": "x", "from": "A", "to": "A", "resistance": 1.0}]},
            {"nodes": ["A", "A"], "airways": [{"id": "x", "from": "A", "to": "B", "resistance": 1.0}]},
        ]
        for d in bad:
            with self.assertRaises(ValueError):
                v.solve_network(d)


def airway(i, a, b, q):
    return {"id": i, "from": a, "to": b, "flowM3s": q}


class GasTests(unittest.TestCase):
    def test_concentration_is_release_over_airflow_and_mixing_at_junctions_dilutes(self):
        # N0 -> N1 (20 m3/s, release here), N1 -> N2 (10) and N1 -> N3 (10), clean air 20 m3/s joins N2 from N4, N2 -> N5 (30).
        airways = [airway("A", "N0", "N1", 20.0), airway("B", "N1", "N2", 10.0), airway("C", "N1", "N3", 10.0), airway("D", "N4", "N2", 20.0), airway("E", "N2", "N5", 30.0)]
        g = v.gas_dilution(airways, {"airwayId": "A", "releaseM3s": 0.01})
        c = g["concentration"]
        self.assertAlmostEqual(c["A"], 0.01 / 20, places=12)        # release rate / airflow
        self.assertAlmostEqual(c["B"], 0.0005, places=12)           # splits 50:50, same concentration
        self.assertAlmostEqual(c["C"], 0.0005, places=12)
        self.assertAlmostEqual(c["E"], 0.005 / 30, places=12)       # B's 0.005 m3/s of gas into 30 m3/s
        self.assertNotIn("D", c)                                     # clean intake air carries none
        self.assertFalse(g["recirculation"])

    def test_no_airflow_means_no_estimate_not_infinity(self):
        g = v.gas_dilution([airway("A", "N0", "N1", 0.0)], {"airwayId": "A", "releaseM3s": 0.01})
        self.assertTrue(g["stagnant"])
        self.assertEqual(g["concentration"], {})
        self.assertIn("cannot be estimated", g["notes"][0])

    def test_recirculation_is_flagged(self):
        airways = [airway("A", "N0", "N1", 10.0), airway("B", "N1", "N2", 10.0), airway("C", "N2", "N0", 10.0)]
        g = v.gas_dilution(airways, {"airwayId": "A", "releaseM3s": 0.01})
        self.assertTrue(g["recirculation"])
        self.assertTrue(any("recirculates" in n for n in g["notes"]))

    def test_reentry_time_formula(self):
        # V/Q = 2400/20 = 120 s; ln(0.01/0.0005) = ln 20 = 2.995732...; t = 359.4879 s.
        r = v.reentry_time(2400.0, 20.0, 0.01, 0.0005)
        self.assertAlmostEqual(r["seconds"], 120 * math.log(20), places=9)
        self.assertAlmostEqual(r["seconds"], 359.488, places=2)
        self.assertEqual(r["formula"], "t = (V / Q) x ln(c_start / c_limit)")
        self.assertEqual(v.reentry_time(2400.0, 20.0, 0.0004, 0.0005)["seconds"], 0.0)
        self.assertIsNone(v.reentry_time(2400.0, 0.0, 0.01, 0.0005)["seconds"])
        for bad in [(0.0, 20.0, 0.01, 0.0005), (2400.0, 20.0, 0.0, 0.0005), (2400.0, 20.0, 0.01, 0.0), (2400.0, 20.0, 2.0, 0.0005)]:
            with self.assertRaises(ValueError):
                v.reentry_time(*bad)


class TextbookReference(unittest.TestCase):
    """The spec (9.8) requires agreement with a PUBLISHED textbook worked example, within a
    stated tolerance, before results are shown. None was available to this build (the
    sources could not be fetched), so none is invented here. To add one: put its
    figures into ventilation_references.json (source, page, branch resistances, fan
    duty, published final flows, published tolerance) and enable this test."""

    @unittest.skip("No published textbook example has been added yet: see the docstring")
    def test_published_example(self):
        self.fail("add the published example")


if __name__ == "__main__":
    unittest.main()
