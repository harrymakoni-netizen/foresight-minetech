"""Cage and hoist model (spec 9.7). Every expected time below is worked out by
hand from the cycle rule (down trip + loading + up trip + unloading) and the
failure rules documented in cage.py; none is copied from the engine's output."""
import json, os, socket, subprocess, sys, tempfile, time, unittest, urllib.request, uuid

from . import cage


def inp(people=10, capacity=4, trip=60, load=30, unload=30, ladder=600, outages=None, horizon=7200, levels=None, arrivals=None):
    levels = levels or [{"level": "L1", "junction": "J", "tripSeconds": trip}]
    return {"shaft": {"id": "s", "name": "S", "cageCapacity": capacity, "loadingSeconds": load, "unloadSeconds": unload, "ladderClimbSeconds": ladder, "levels": levels},
            "arrivals": arrivals if arrivals is not None else [{"id": f"p{i}", "name": None, "level": levels[0]["level"], "atSeconds": 0} for i in range(people)],
            "outages": outages or [], "horizonSeconds": horizon}


def surfaced(result):
    return sorted(round(p["surfaceAt"]) for p in result["people"] if p["surfaceAt"] is not None)


class CageTests(unittest.TestCase):
    def test_three_trips_for_ten_people(self):
        # Cycle = 60 down + 30 load + 60 up + 30 unload = 180 s. Trips carry 4, 4, 2.
        r = cage.run(inp())
        self.assertEqual(surfaced(r), [180] * 4 + [360] * 4 + [540] * 2)
        self.assertEqual(r["lastSurfaceSeconds"], 540)
        self.assertEqual(r["totals"], {"people": 10, "byCage": 10, "byLadder": 0, "notReached": 0, "balanced": True})
        self.assertEqual([c["boarded"] for c in r["cycles"]], [4, 4, 2])
        self.assertTrue(all(c["completed"] for c in r["cycles"]))
        self.assertIsNone(r["effect"])
        # Queue: 10 waiting at 0; boarding at 60 leaves 6, at 240 leaves 2, at 420 leaves 0.
        self.assertEqual(r["queueSeries"][0]["points"], [[0.0, 10], [60.0, 6], [240.0, 2], [420.0, 0]])

    def test_failure_while_first_cage_is_in_transit_sends_everyone_up_the_ladder(self):
        # Failure at 100 s: cage left at 0, loaded 4 at 60, still travelling. 4 aboard + 6 waiting climb 600 s from 100 s.
        r = cage.run(inp(outages=[{"fromSeconds": 100, "toSeconds": None}]))
        self.assertEqual(surfaced(r), [700] * 10)
        self.assertEqual(r["totals"], {"people": 10, "byCage": 0, "byLadder": 10, "notReached": 0, "balanced": True})
        self.assertEqual(r["effect"]["baselineLastSurfaceSeconds"], 540)
        self.assertEqual(r["effect"]["withFailureLastSurfaceSeconds"], 700)
        self.assertEqual(r["effect"]["delaySeconds"], 160)
        self.assertEqual(r["effect"]["movedToLadder"], 10)
        self.assertFalse(r["cycles"][0]["completed"])

    def test_failure_after_the_first_trip_keeps_those_already_up(self):
        # Trip 1 finishes at 180 (4 up). Cycle 2 starts at 180; failure at 200 hits an empty, descending cage; 6 waiting climb from 200 s.
        r = cage.run(inp(outages=[{"fromSeconds": 200, "toSeconds": None}]))
        self.assertEqual(surfaced(r), [180] * 4 + [800] * 6)
        self.assertEqual(r["totals"]["byCage"], 4)
        self.assertEqual(r["totals"]["byLadder"], 6)
        self.assertEqual(r["lastSurfaceSeconds"], 800)

    def test_failure_exactly_when_a_cage_reaches_the_surface_counts_those_people_as_up(self):
        r = cage.run(inp(outages=[{"fromSeconds": 180, "toSeconds": None}]))
        self.assertEqual(surfaced(r), [180] * 4 + [780] * 6)

    def test_ladder_time_not_entered_means_not_reached_not_a_guess(self):
        data = inp(outages=[{"fromSeconds": 200, "toSeconds": None}])
        data["shaft"]["ladderClimbSeconds"] = None
        r = cage.run(data)
        self.assertEqual(r["totals"], {"people": 10, "byCage": 4, "byLadder": 0, "notReached": 6, "balanced": True})
        self.assertIsNone(r["lastSurfaceSeconds"])
        self.assertEqual(r["lastReachedSeconds"], 180)
        self.assertEqual({p["reason"] for p in r["people"] if p["surfaceAt"] is None}, {"ladder climb time is not entered"})
        self.assertTrue(r["warnings"])

    def test_two_levels_are_served_oldest_waiting_first(self):
        # L1: 2 people at 0; L2: 3 at 10. Cage is idle at 0, so it goes to L1 first (nobody at L2 yet).
        # L1 cycle: 60 down + 10 load + 60 up + 10 unload = 140 (boards 2 at 60).
        # Then L2 (3 waiting since 10): starts 140, 120 + 10 + 120 + 10 = 260 s -> 400.
        levels = [{"level": "L1", "junction": "A", "tripSeconds": 60}, {"level": "L2", "junction": "B", "tripSeconds": 120}]
        arrivals = [{"id": f"a{i}", "name": None, "level": "L1", "atSeconds": 0} for i in range(2)] + [{"id": f"b{i}", "name": None, "level": "L2", "atSeconds": 10} for i in range(3)]
        r = cage.run(inp(capacity=5, load=10, unload=10, levels=levels, arrivals=arrivals))
        self.assertEqual(surfaced(r), [140, 140, 400, 400, 400])
        self.assertEqual([(c["level"], c["boarded"]) for c in r["cycles"]], [("L1", 2), ("L2", 3)])

    def test_a_person_arriving_later_starts_a_new_cycle_then(self):
        arrivals = [{"id": "p0", "name": None, "level": "L1", "atSeconds": 500}]
        r = cage.run(inp(arrivals=arrivals))
        self.assertEqual(surfaced(r), [680])  # 500 + 180

    def test_boarding_takes_only_people_present_when_loading_starts(self):
        # p0 at 0 starts the cycle (arrives at the level at 60); p1 arrives at 61, after loading started, so waits for the next trip.
        arrivals = [{"id": "p0", "name": None, "level": "L1", "atSeconds": 0}, {"id": "p1", "name": None, "level": "L1", "atSeconds": 61}]
        r = cage.run(inp(arrivals=arrivals))
        self.assertEqual(surfaced(r), [180, 360])

    def test_temporary_outage_moves_waiting_people_to_the_ladder_and_later_arrivals_wait_for_the_cage(self):
        # Outage 100..400. At 100: p0-p9 are aboard/waiting -> ladder, 700 s. A person arriving at 300 (during the outage) waits; cage resumes at 400, cycle 180 -> 580.
        arrivals = [{"id": f"p{i}", "name": None, "level": "L1", "atSeconds": 0} for i in range(10)] + [{"id": "late", "name": None, "level": "L1", "atSeconds": 300}]
        r = cage.run(inp(arrivals=arrivals, outages=[{"fromSeconds": 100, "toSeconds": 400}]))
        by = {p["id"]: p for p in r["people"]}
        self.assertEqual({round(by[f"p{i}"]["surfaceAt"]) for i in range(10)}, {700})
        self.assertEqual(by["late"]["route"], "cage")
        self.assertEqual(round(by["late"]["surfaceAt"]), 580)

    def test_arrival_during_a_permanent_outage_uses_the_ladder_at_once(self):
        arrivals = [{"id": "x", "name": None, "level": "L1", "atSeconds": 300}]
        r = cage.run(inp(arrivals=arrivals, outages=[{"fromSeconds": 100, "toSeconds": None}]))
        self.assertEqual(r["people"][0]["route"], "ladder")
        self.assertEqual(round(r["people"][0]["surfaceAt"]), 900)

    def test_horizon_leaves_people_not_reached_and_last_time_is_not_reached(self):
        r = cage.run(inp(horizon=300))  # only the first trip (180 s) is complete
        self.assertEqual(r["totals"], {"people": 10, "byCage": 4, "byLadder": 0, "notReached": 6, "balanced": True})
        self.assertIsNone(r["lastSurfaceSeconds"])
        self.assertEqual(r["lastReachedSeconds"], 180)
        self.assertIn("in the cage at the horizon", {p["reason"] for p in r["people"]})

    def test_unload_time_defaults_to_loading_time_and_says_so(self):
        data = inp()
        data["shaft"]["unloadSeconds"] = None
        r = cage.run(data)
        self.assertEqual(r["lastSurfaceSeconds"], 540)
        self.assertTrue(any("same time as loading" in a for a in r["assumptions"]))

    def test_deterministic_and_hash_stable(self):
        a, b = cage.run(inp()), cage.run(inp())
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))
        self.assertNotEqual(a["inputHash"], cage.run(inp(capacity=5))["inputHash"])

    def test_invalid_input_is_refused_not_repaired(self):
        for bad in [inp(capacity=0), inp(trip=0), inp(people=0, arrivals=[]), inp(outages=[{"fromSeconds": 50, "toSeconds": 40}]),
                    inp(arrivals=[{"id": "a", "level": "nope", "atSeconds": 0}])]:
            with self.assertRaises(ValueError):
                cage.run(bad)


class CageWorkerTests(unittest.TestCase):
    """The worker accepts a cage job over its authenticated API."""

    def test_job_round_trip(self):
        temp = tempfile.TemporaryDirectory()
        sock = socket.socket(); sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]; sock.close()
        token = "cage-worker-test-token-0123456789abcdef0123"
        proc = subprocess.Popen([sys.executable, "-m", "services.simulator.server"], stdout=subprocess.DEVNULL,
                                env={**os.environ, "FORESIGHT_SIMULATOR_PORT": str(port), "FORESIGHT_SIMULATOR_HOST": "127.0.0.1",
                                     "FORESIGHT_JOB_DATABASE": temp.name + "/jobs.sqlite", "FORESIGHT_WORKER_TOKEN": token})
        try:
            def request(path, body=None):
                req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode() if body is not None else None,
                                             headers={"Authorization": "Bearer " + token, "X-Workspace-Id": "ws-cage", "Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=10) as r:
                    return json.load(r)
            for _ in range(100):
                try:
                    health = request("/health"); break
                except Exception:
                    time.sleep(0.05)
            self.assertIn("cage-simpy-1.0.0", health["engines"])
            job = {"id": str(uuid.uuid4()), "kind": "cage", "workspaceId": "ws-cage", "input": inp(outages=[{"fromSeconds": 200, "toSeconds": None}])}
            self.assertEqual(request("/jobs", job)["status"], "queued")
            for _ in range(100):
                state = request(f"/jobs/{job['id']}")
                if state["status"] in ("completed", "failed"): break
                time.sleep(0.05)
            self.assertEqual(state["status"], "completed")
            self.assertEqual(state["result"]["lastSurfaceSeconds"], 800)
        finally:
            proc.terminate(); proc.wait(timeout=5); temp.cleanup()


if __name__ == "__main__":
    unittest.main()
