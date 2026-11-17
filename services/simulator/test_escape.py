"""Escape engine tests (spec §16.1 Escape). Run in the simulation venv:
.venv-sim/bin/python -m unittest services.simulator.test_escape -v"""
import json
import pathlib
import unittest

from services.simulator import escape, network as net

NETWORK = json.loads((pathlib.Path(__file__).parents[2] / "fixtures/mine/ten-junction.json").read_text())


def scenario(closures=(), people=None, **params):
    if people is None:
        people = ([{"id": f"e{i}", "name": f"East {i}", "zoneId": "east"} for i in range(8)]
                  + [{"id": f"n{i}", "name": f"North {i}", "zoneId": "north"} for i in range(4)]
                  + [{"id": f"s{i}", "name": f"South {i}", "zoneId": "south"} for i in range(6)])
    return {"network": NETWORK, "people": people, "closures": list(closures),
            "params": {"seed": 7, "horizonSeconds": 900, "recordTrajectories": True, **params}}


def by(result, prefix):
    return [p for p in result["people"] if p["id"].startswith(prefix)]


class EscapeTests(unittest.TestCase):
    def assertBalanced(self, r):
        t = r["totals"]
        self.assertEqual(t["simulated"], t["reached-exit"] + t["reached-refuge"] + t["cut-off"] + t["still-walking"])
        self.assertTrue(t["balanced"])

    def test_open_network_everyone_reaches_exit(self):
        r = escape.run(scenario())
        self.assertBalanced(r)
        self.assertEqual(r["totals"]["reached-exit"], 18)
        self.assertIsNotNone(r["times"]["t100"])
        self.assertTrue(all(p["startMethod"] == "spread-along-zone" for p in r["people"]))

    def test_closed_tunnel_reroutes_and_takes_longer(self):
        base, closed = escape.run(scenario()), escape.run(scenario([{"tunnelId": "T2", "atSeconds": 0}]))
        self.assertBalanced(closed)
        self.assertEqual(closed["totals"]["reached-exit"], 18)
        east = lambda r: max(p["atSeconds"] for p in by(r, "e"))
        self.assertGreater(east(closed), east(base))

    def test_isolated_part_is_counted_as_cut_off_not_dropped(self):
        r = escape.run(scenario([{"tunnelId": t, "atSeconds": 0} for t in ("T2", "T3", "T10")]))
        self.assertBalanced(r)
        north = by(r, "n")
        self.assertTrue(all(p["outcome"] == "cut-off" for p in north))
        self.assertTrue(all(p["label"] == "cut off from assumed start in North stope" for p in north))
        self.assertEqual(r["totals"]["cut-off"], 4)
        self.assertEqual(r["totals"]["reached-exit"], 14)
        self.assertEqual(r["segments"][0]["partsWithoutTarget"], 1)

    def test_closure_mid_run_splits_and_cuts_off_people_beyond_it(self):
        # T1 is the only way to the exit; closing it at 30 s leaves nobody a route.
        r = escape.run(scenario([{"tunnelId": "T1", "atSeconds": 30}]))
        self.assertBalanced(r)
        self.assertEqual(len(r["segments"]), 2)
        self.assertEqual(r["totals"]["reached-exit"], 0)
        self.assertEqual(r["totals"]["cut-off"], 18)
        self.assertTrue(all(p["atSeconds"] == 30 for p in r["people"]))

    def test_people_inside_a_closing_tunnel_are_cut_off_with_reason(self):
        r = escape.run(scenario([{"tunnelId": "T4", "atSeconds": 10}]))
        self.assertBalanced(r)
        trapped = [p for p in by(r, "e") if p["outcome"] == "cut-off"]
        self.assertTrue(trapped)
        self.assertTrue(all(p["reason"] == "in tunnel T4 when it closed at 10 s" for p in trapped))
        self.assertTrue(all(p["outcome"] == "reached-exit" for p in by(r, "s")))

    def test_deterministic_with_seed_and_start_assumption_stored(self):
        a, b = escape.run(scenario()), escape.run(scenario())
        self.assertEqual(a["inputHash"], b["inputHash"])
        self.assertEqual([p["atSeconds"] for p in a["people"]], [p["atSeconds"] for p in b["people"]])
        self.assertEqual(a["assumptions"]["startMethod"], "spread-along-zone")
        c = escape.run(scenario(seed=8))
        self.assertNotEqual(a["inputHash"], c["inputHash"])

    def test_horizon_reports_still_walking_and_not_reached(self):
        r = escape.run(scenario(horizonSeconds=60))
        self.assertBalanced(r)
        self.assertGreater(r["totals"]["still-walking"], 0)
        self.assertIsNone(r["times"]["t100"])

    def test_refuge_capacity_is_respected(self):
        n = json.loads(json.dumps(NETWORK))
        n["refuges"] = [{"id": "R1", "junction": "J10", "capacity": 2}]
        s = scenario([{"tunnelId": "T2", "atSeconds": 0}, {"tunnelId": "T10", "atSeconds": 0}, {"tunnelId": "T3", "atSeconds": 0}])
        s["network"] = n
        r = escape.run(s)
        self.assertBalanced(r)
        self.assertEqual(r["totals"]["reached-refuge"], 2)
        self.assertEqual(r["totals"]["cut-off"], 2)

    def test_missing_width_and_plan_crossing_are_rejected(self):
        n = json.loads(json.dumps(NETWORK)); del n["tunnels"][0]["width"]
        with self.assertRaises(escape.EscapeInputError):
            escape.run({**scenario(), "network": n})
        n = json.loads(json.dumps(NETWORK))
        n["junctions"] += [{"id": "K1", "x": 30, "y": 20}, {"id": "K2", "x": 30, "y": -20}]
        n["tunnels"].append({"id": "TX", "from": "K1", "to": "K2", "width": 2})
        with self.assertRaises(escape.EscapeInputError):
            escape.run({**scenario(), "network": n})

    def test_networkx_route_search_reports_no_route(self):
        j, t = net.parse(NETWORK)
        self.assertEqual(net.shortest_path(j, t, "J8", ["J1"])[2], ["T4", "T3", "T2", "T1"])
        self.assertEqual(net.shortest_path(j, t, "J8", ["J1"], {"T2"})[2][-2:], ["T5", "T1"])
        self.assertIsNone(net.shortest_path(j, t, "J10", ["J1"], {"T2", "T3", "T10"}))


if __name__ == "__main__":
    unittest.main()
