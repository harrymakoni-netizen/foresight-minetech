"""Proof test 5 / transport: the worker process accepts an escape job over its
authenticated job API and returns the result through the same polling path the
web app uses. Runs in the simulation venv (needs jupedsim)."""
import json, os, socket, subprocess, sys, tempfile, time, unittest, urllib.error, urllib.request, uuid

from .test_escape import scenario


class EscapeWorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        sock = socket.socket(); sock.bind(("127.0.0.1", 0)); cls.port = sock.getsockname()[1]; sock.close()
        cls.token = "escape-worker-test-token-0123456789abcdef"
        cls.process = subprocess.Popen([sys.executable, "-m", "services.simulator.server"], stdout=subprocess.DEVNULL,
                                       env={**os.environ, "FORESIGHT_SIMULATOR_PORT": str(cls.port), "FORESIGHT_SIMULATOR_HOST": "127.0.0.1",
                                            "FORESIGHT_JOB_DATABASE": cls.temp.name + "/jobs.sqlite", "FORESIGHT_WORKER_TOKEN": cls.token})
        for _ in range(100):
            try:
                cls.health = cls.request("/health"); break
            except Exception:
                time.sleep(0.05)

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate(); cls.process.wait(timeout=5); cls.temp.cleanup()

    @classmethod
    def request(cls, path, body=None, workspace="ws-escape"):
        req = urllib.request.Request(f"http://127.0.0.1:{cls.port}{path}", data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Authorization": "Bearer " + cls.token, "X-Workspace-Id": workspace, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)

    def test_escape_job_round_trip(self):
        self.assertIn("escape-jupedsim-1.0.0", self.health["engines"])
        job = {"id": str(uuid.uuid4()), "kind": "escape", "workspaceId": "ws-escape",
               "input": scenario([{"tunnelId": "T2", "atSeconds": 0}], recordTrajectories=False)}
        self.assertEqual(self.request("/jobs", job)["status"], "queued")
        self.assertEqual(self.request("/jobs", job)["id"], job["id"])  # idempotent resubmission
        for _ in range(300):
            out = self.request("/jobs/" + job["id"])
            if out["status"] in ("completed", "failed"):
                break
            time.sleep(0.05)
        self.assertEqual(out["status"], "completed", out.get("error"))
        self.assertTrue(out["result"]["totals"]["balanced"])
        self.assertEqual(out["result"]["totals"]["reached-exit"], 18)
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.request("/jobs/" + job["id"], workspace="other")
        self.assertEqual(e.exception.code, 404)

    def test_invalid_escape_input_rejected_before_queueing(self):
        bad = scenario(); bad["network"] = {"junctions": [], "tunnels": []}
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.request("/jobs", {"id": str(uuid.uuid4()), "kind": "escape", "workspaceId": "ws-escape", "input": bad})
        self.assertEqual(e.exception.code, 422)


if __name__ == "__main__":
    unittest.main()
