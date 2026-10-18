import json
import unittest
from api.simulation import calculate
from .engine import ValidationError

class ServerlessComputeTests(unittest.TestCase):
    def setUp(self):
        from .test_engine import fixture
        self.scenario=fixture()

    def test_workspace_checked_before_compute(self):
        with self.assertRaises(PermissionError):calculate({'scenario':self.scenario},'other-workspace')

    def test_deadline_is_bounded(self):
        with self.assertRaises(TimeoutError):calculate({'scenario':self.scenario},self.scenario['workspaceId'],seconds=-1)

    def test_result_is_actual_conservation_output(self):
        result=json.loads(calculate({'scenario':self.scenario},self.scenario['workspaceId']))
        self.assertEqual(result['status'],'completed')
        self.assertLess(result['diagnostics']['relativeResidual'],1e-9)
