"""Flooding → escape chain and Time to act (spec §16.1 Escape, Time to act).
Run in the simulation venv."""
import copy, json, pathlib, time, unittest

from services.simulator import scenario_chain as chain

FIX = json.loads((pathlib.Path(__file__).parents[2] / "fixtures/mine/training-template.json").read_text())


def chain_input(backup=None, order=5700, people=None, **params):
    if people is None:
        people = ([{"id": f"e{i}", "name": f"East {i}", "zoneId": "zone-b"} for i in range(8)]
                  + [{"id": f"s{i}", "name": f"South {i}", "zoneId": "zone-c"} for i in range(4)])
    return {
        "workspaceId": "ws-test", "mineModelRevisionId": "rev-1", "timeOrigin": "2026-11-17T08:00:00+02:00",
        "model": FIX["model"], "network": FIX["escapeNetwork"], "people": people,
        "water": {"sumpId": "S1", "dutyPumpId": "P1", "backupPumpId": "P2", "failAtSeconds": 0, "backupStartSeconds": backup},
        "params": {"seed": 11, "horizonSeconds": 7200, "alarmDelaySeconds": order, "preMovementSeconds": {"min": 0, "max": 120}, **params},
        "endurance": {"selfRescuerRatedMinutes": 3, "refugeConsumptionM3PerPersonHour": 0.5},
    }


class ChainTests(unittest.TestCase):
    def test_no_backup_floods_at_computed_time_and_closes_model_tunnels(self):
        r = chain.run_chain(chain_input(None))
        f = r["flooding"]
        # 30 m³ start, 18 m³/h in, 24 m³/h duty pump stops at 0 s: +1 m over 30 m²/m → 6000 s.
        self.assertAlmostEqual(f["firstDangerSeconds"], 6000, delta=10)
        self.assertEqual(sorted(c["tunnelId"] for c in r["closures"]), ["T4", "T6"])
        t = r["escape"]["totals"]
        self.assertTrue(t["balanced"])
        self.assertEqual(t["simulated"], 12)
        self.assertLess(abs(f["conservationResidualM3"]), 1e-6)

    def test_early_backup_prevents_danger_and_everyone_reaches_safety(self):
        r = chain.run_chain(chain_input(1800))
        self.assertIsNone(r["flooding"]["firstDangerSeconds"])
        self.assertEqual(r["closures"], [])
        self.assertEqual(r["escape"]["totals"]["reached-exit"], 12)
        self.assertIsNotNone(r["escape"]["times"]["t100"])

    def test_late_evacuation_traps_people_in_flooded_tunnels_with_named_reasons(self):
        r = chain.run_chain(chain_input(None, order=5940))
        cut = [p for p in r["escape"]["people"] if p["outcome"] == "cut-off"]
        self.assertTrue(cut, "some East development people are still in T4/T6 at 6000 s")
        self.assertTrue(all(p["label"] == "cut off from assumed start in East development" for p in cut))
        self.assertTrue(all("when it closed" in p["reason"] or "no route" in p["reason"] for p in cut))
        self.assertTrue(r["escape"]["totals"]["balanced"])

    def test_endurance_checks_show_inputs_and_formula(self):
        r = chain.run_chain(chain_input(1800))
        e = r["endurance"]
        self.assertEqual(e["label"], "Endurance check — not a survival time")
        self.assertEqual(e["selfRescuer"]["ratedMinutes"], 3)
        self.assertTrue(e["selfRescuer"]["exceeding"], "walks longer than 3 minutes are listed")
        inp = chain_input(1800); inp["endurance"] = {}
        e2 = chain.run_chain(inp)["endurance"]
        self.assertFalse(e2["selfRescuer"]["available"])
        self.assertFalse(e2["refuges"][0]["available"])

    def test_missing_inputs_block_flooding_and_never_become_zero(self):
        inp = chain_input(None); m = copy.deepcopy(inp["model"]); m["pumps"][0]["capacityM3h"] = None; inp["model"] = m
        with self.assertRaisesRegex(chain.ChainInputError, "P1 capacity"):
            chain.run_chain(inp)

    def test_playback_and_pedpy_congestion(self):
        r = chain.run_chain(chain_input(1800))
        self.assertEqual(len(r["playback"]["people"]), 12)
        self.assertTrue(all(p["path"] for p in r["playback"]["people"]))
        c = r["congestion"]
        self.assertTrue(c["available"], c)
        total = sum(l.get("crossings", 0) for l in c["lines"] if l["line"].startswith("approach"))
        self.assertGreaterEqual(total, 1)

    def test_deterministic(self):
        a, b = chain.run_chain(chain_input(None), trajectories=False), chain.run_chain(chain_input(None), trajectories=False)
        self.assertEqual(a["inputHash"], b["inputHash"])
        self.assertEqual([p["atSeconds"] for p in a["escape"]["people"]], [p["atSeconds"] for p in b["escape"]["people"]])


class TimeToActTests(unittest.TestCase):
    def study(self, a, b, step, order=5940):
        return {"chain": chain_input(None, order=order), "fromSeconds": a, "toSeconds": b, "stepSeconds": step}

    def test_boundary_found_and_reported_with_range(self):
        started = time.perf_counter()
        r = chain.time_to_act(self.study(4800, 7200, 600))
        self.assertEqual(r["outcome"], "boundary found")
        self.assertEqual(r["testedCount"], 5)
        self.assertEqual(r["latestSuccessSeconds"], 5400)
        self.assertTrue(r["monotonic"])
        self.assertLess(time.perf_counter() - started, 120)

    def test_boundary_not_reached(self):
        r = chain.time_to_act(self.study(600, 1800, 600))
        self.assertEqual(r["outcome"], "boundary not reached in the tested range")
        self.assertEqual(r["latestSuccessSeconds"], 1800)

    def test_no_tested_value_met(self):
        r = chain.time_to_act(self.study(6600, 7200, 600))
        self.assertEqual(r["outcome"], "no tested value met the condition")
        self.assertIsNone(r["latestSuccessSeconds"])


if __name__ == "__main__":
    unittest.main()


class StartMethodTests(unittest.TestCase):
    def test_spread_along_zone_places_people_along_every_zone_tunnel(self):
        from services.simulator import network as net
        people = [{"id": f"p{i}", "zoneId": "zone-b"} for i in range(4)]
        r = chain.run_chain(chain_input(None, order=6000, people=people, preMovementSeconds={"min": 0, "max": 0}), trajectories=False)
        j, t = net.parse(FIX["escapeNetwork"])
        tunnels = sorted({net.containing_tunnels(t, p["start"]["x"], p["start"]["y"], ids={"T4", "T5", "T6", "T7"}, tolerance=1e-3)[0] for p in r["escape"]["people"]})
        self.assertEqual(tunnels, ["T4", "T5", "T6", "T7"])
        self.assertTrue(all(p["startMethod"] == "spread-along-zone" for p in r["escape"]["people"]))
        # Evacuation ordered when the sump reaches danger: people in T4/T6 are cut off, by name.
        cut = sorted(p["id"] for p in r["escape"]["people"] if p["outcome"] == "cut-off")
        self.assertEqual(len(cut), 2)
