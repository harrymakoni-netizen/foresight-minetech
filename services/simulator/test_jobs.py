import copy,unittest
from .test_engine import fixture
from .ensemble import ensemble
from .engine import ValidationError
class SensitivityTests(unittest.TestCase):
    def scenario(self):
        s=fixture(hours=1);s['events']=[{'type':'pump_availability','atSeconds':600,'pumpId':'P1','available':True}];return s
    def test_seeded_envelope_and_censoring(self):
        config={'samples':4,'seed':7,'inflowM3s':[.003,.006],'pumpCapacityM3s':[.002,.007],'backupDelaySeconds':[60,900]};s=self.scenario();before=copy.deepcopy(s);a,b=ensemble(s,config),ensemble(s,config);self.assertEqual(a,b);self.assertEqual(s,before);self.assertEqual(a['crossingCounts'][0]['crossed']+a['crossingCounts'][0]['censored'],4);self.assertTrue(all(p['minimumVolumeM3']<=p['maximumVolumeM3'] for p in a['envelope']))
    def test_cancellation_and_bounds(self):
        config={'samples':4,'seed':7,'inflowM3s':[.003,.006],'pumpCapacityM3s':[.002,.007],'backupDelaySeconds':[60,900]};self.assertEqual(ensemble(self.scenario(),config,cancelled=lambda:True)['status'],'cancelled');config['samples']=101
        with self.assertRaises(ValidationError):ensemble(self.scenario(),config)
if __name__=='__main__':unittest.main()
