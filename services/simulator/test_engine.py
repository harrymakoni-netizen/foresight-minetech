import copy,json,math,random,time,unittest
from pathlib import Path
from .engine import solve,validate,ValidationError,level,volume_at_level,convergence

def fixture(inflow=18,pump=12,hours=24):
    return {'schemaVersion':'1.0','workspaceId':'test-workspace','baselineSnapshotId':'test-baseline','modelId':'lumped-water-v1','modelVersion':'lumped-water-1.0.0','timeOrigin':'2026-10-17T10:00:00Z','horizonSeconds':hours*3600,'outputIntervalSeconds':60,'maxStepSeconds':10,'seed':42,'units':{'volume':'m3','level':'m','time':'s','flow':'m3/s'},'nodes':[{'id':'S1','zoneId':'zone-b','geometry':[{'volumeM3':0,'levelM':0},{'volumeM3':150,'levelM':5}],'initialVolumeM3':30,'inflowM3s':inflow/3600}],'pumps':[{'id':'P1','nodeId':'S1','capacityM3s':pump/3600,'available':True,'startLevelM':None,'stopLevelM':None}],'transfers':[],'events':[],'thresholds':[{'id':'limit','nodeId':'S1','levelM':5,'edgeIds':['direct'],'label':'Storage limit','source':'Constructed analytic fixture'}],'routeGraph':{'version':'test-1','nodes':[{'id':'east','zoneId':'zone-b'},{'id':'exit','zoneId':None},{'id':'south','zoneId':'zone-c'}],'edges':[{'id':'direct','from':'east','to':'exit','zoneId':'zone-b','lengthM':300,'speedMps':1,'delaySeconds':0,'availability':'available','bidirectional':True,'source':'Fictional graph'}]},'movements':[{'id':'crew','startNodes':['east'],'targetNode':'exit','departureSeconds':0,'responseDelaySeconds':0,'assumption':'Fictional crew at east; no queues'}],'provenance':[{'id':i,'source':'Constructed analytic fixture','quality':'assumed','originalUnit':'m3/h','checkedAt':None} for i in ['S1','P1']]}

class WaterTests(unittest.TestCase):
    def test_w01_decreasing(self):
        r=solve(fixture(pump=20,hours=6));self.assertAlmostEqual(r['summary']['finalStorageM3'],18,places=7)
    def test_w02_twenty_hours(self):
        r=solve(fixture());self.assertAlmostEqual(r['thresholds'][0]['firstCrossingSeconds'],20*3600,places=5);self.assertAlmostEqual(r['summary']['overflowM3'],24,places=6)
    def test_w03_six_hours_forty(self):
        r=solve(fixture(pump=0));self.assertAlmostEqual(r['thresholds'][0]['firstCrossingSeconds'],24000,places=5)
    def test_w04_backup(self):
        s=fixture();s['events']=[{'type':'pump_capacity','atSeconds':36000,'pumpId':'P1','capacityM3s':24/3600}];r=solve(s);self.assertAlmostEqual(r['summary']['peakVolumeM3']['S1'],90,places=7);self.assertEqual(r['summary']['overflowM3'],0)
    def test_w05_overflow_retained(self):
        s=fixture(pump=0);s['events']=[{'type':'pump_capacity','atSeconds':8*3600,'pumpId':'P1','capacityM3s':24/3600}];r=solve(s);self.assertAlmostEqual(r['summary']['overflowM3'],24,places=6);self.assertLess(r['diagnostics']['relativeResidual'],1e-6)
    def test_geometry_inverse(self):
        n=fixture()['nodes'][0];self.assertEqual(level(n,120)-level(n,0),4)
        n['geometry']=[{'volumeM3':0,'levelM':0},{'volumeM3':30,'levelM':2},{'volumeM3':150,'levelM':5}]
        for v in [0,15,30,100,150]:self.assertAlmostEqual(volume_at_level(n,level(n,v)),v)
    def test_reject_invalid_geometry_and_units(self):
        s=fixture();s['nodes'][0]['geometry'][1]['levelM']=0
        with self.assertRaises(ValidationError):solve(s)
        s=fixture();s['units']['flow']='m3/h'
        with self.assertRaises(ValidationError):solve(s)
    def test_empty_and_zero(self):
        s=fixture(inflow=0,pump=100,hours=1);s['nodes'][0]['initialVolumeM3']=0;r=solve(s);self.assertEqual(r['summary']['externalDischargeM3'],0);self.assertEqual(r['summary']['finalStorageM3'],0)
    def test_multiple_pumps_do_not_create_water(self):
        s=fixture(inflow=0,pump=100,hours=1);s['pumps'].append({**s['pumps'][0],'id':'P2'});s['provenance'].append({**s['provenance'][1],'id':'P2'});r=solve(s);self.assertAlmostEqual(r['summary']['externalDischargeM3'],30);self.assertAlmostEqual(r['summary']['finalStorageM3'],0)
    def test_transfer_cancels(self):
        s=fixture(inflow=0,pump=0,hours=1);s['nodes'].append({**copy.deepcopy(s['nodes'][0]),'id':'S2','initialVolumeM3':0});s['transfers']=[{'id':'T1','from':'S1','to':'S2','capacityM3s':1,'assumption':'Constant directed test transfer'}];s['provenance'] += [{**s['provenance'][0],'id':i} for i in ['S2','T1']];r=solve(s);self.assertAlmostEqual(r['summary']['finalStorageM3'],30);self.assertAlmostEqual(r['series'][-1]['nodes']['S2']['volumeM3'],30)
    def test_switching_boundary(self):
        s=fixture(inflow=18,pump=36,hours=1);s['pumps'][0].update(startLevelM=1.1,stopLevelM=0.9);r=solve(s);self.assertTrue(all(26.99<=p['nodes']['S1']['volumeM3']<=33.01 for p in r['series']));self.assertLess(convergence(s)['finalStorageDifferenceM3'],0.01)
    def test_simultaneous_event_order_and_reproducibility(self):
        s=fixture(hours=1);s['events']=[{'type':'pump_availability','atSeconds':0,'pumpId':'P1','available':False},{'type':'pump_availability','atSeconds':0,'pumpId':'P1','available':True}];a,b=solve(s),solve(s);self.assertEqual(a['series'],b['series']);self.assertEqual(a['inputHash'],b['inputHash']);s['seed']=43;self.assertNotEqual(a['inputHash'],solve(s)['inputHash'])
    def test_immutable_input_and_cancellation(self):
        s=fixture();old=copy.deepcopy(s);solve(s);self.assertEqual(s,old);self.assertEqual(solve(s,cancelled=lambda:True)['status'],'cancelled')
    def test_whole_journey_route(self):
        s=fixture(hours=1);s['events']=[{'type':'route_availability','atSeconds':100,'edgeId':'direct','available':False}];r=solve(s);self.assertEqual(r['routes']['movements'][0]['alternatives'][0]['status'],'no-route-found')
    def test_alternative_and_unknown_position(self):
        s=fixture(hours=1);s['routeGraph']['edges'][0]['availability']='blocked';s['routeGraph']['edges'] += [{**s['routeGraph']['edges'][0],'id':'via-south','from':'east','to':'south','availability':'available'},{**s['routeGraph']['edges'][0],'id':'south-exit','from':'south','to':'exit','availability':'available'}];s['movements'][0]['startNodes']=['east','south'];r=solve(s);self.assertTrue(r['routes']['movements'][0]['allStartingNodesFeasible']);self.assertEqual(r['routes']['movements'][0]['positionStatus'],'uncertain-starting-set')
    def test_numeric_parameter_sets_and_monotonicity(self):
        # Fixed seed and analytic expectations were specified before executing these cases.
        for seed in range(30):
            rng=random.Random(1000+seed);q,p=rng.uniform(0,60),rng.uniform(0,60);s=fixture(q,p,hours=6);r=solve(s);expected=min(150,max(0,30+(q-p)*6));self.assertAlmostEqual(r['summary']['finalStorageM3'],expected,places=6);self.assertLess(r['diagnostics']['relativeResidual'],1e-6)
            s2=copy.deepcopy(s);s2['nodes'][0]['inflowM3s']+=2/3600;r2=solve(s2);self.assertGreaterEqual(r2['summary']['finalStorageM3']+1e-7,r['summary']['finalStorageM3'])
            s3=copy.deepcopy(s);s3['pumps'][0]['available']=False;r3=solve(s3);self.assertGreaterEqual(r3['summary']['finalStorageM3']+1e-7,r['summary']['finalStorageM3'])
    def test_water_restricts_route(self):
        s=fixture(pump=0,hours=8);s['movements'][0]['departureSeconds']=25000;r=solve(s);self.assertFalse(r['routes']['movements'][0]['allStartingNodesFeasible'])
    def test_threshold_initial_equality(self):
        s=fixture(hours=1);s['thresholds'][0]['levelM']=1;r=solve(s);self.assertEqual(r['thresholds'][0]['firstCrossingSeconds'],0)

if __name__=='__main__':unittest.main()

class ConnectedDemoRegression(unittest.TestCase):
    def test_six_hour_browser_examples(self):
        baseline=fixture(hours=6);a=solve(baseline)
        self.assertAlmostEqual(a['summary']['finalStorageM3'],66,places=7)
        baseline['pumps'].append({**baseline['pumps'][0],'id':'P2','available':False})
        baseline['provenance'].append({**baseline['provenance'][0],'id':'P2'})
        baseline['events']=[{'type':'pump_availability','atSeconds':3600,'pumpId':'P2','available':True}]
        b=solve(baseline);self.assertAlmostEqual(b['summary']['finalStorageM3'],6,places=7)
        for result in [a,b]:self.assertLess(abs(result['diagnostics']['conservationResidualM3']),1e-6)
    def test_failure_backup_and_route_traversal(self):
        s=json.loads((Path(__file__).parents[2]/'tests/fixtures/pump-failure.json').read_text())
        late=solve(s);self.assertAlmostEqual(late['summary']['finalStorageM3'],78,places=7)
        self.assertAlmostEqual(late['thresholds'][0]['firstCrossingSeconds'],8400,places=6)
        direct=late['routes']['blockedIntervals']['east-direct'][0]
        departure=s['movements'][0]['departureSeconds']
        self.assertLess(departure,direct['fromSeconds'])
        self.assertGreater(departure+300,direct['fromSeconds'])
        self.assertEqual(late['routes']['movements'][0]['alternatives'][0]['edgeSequence'],['east-south','south-junction','exit'])
        self.assertAlmostEqual(late['summary']['peakVolumeM3']['S1'],90,places=7)
        s['events'][1]['atSeconds']=3600;early=solve(s)
        self.assertAlmostEqual(early['summary']['finalStorageM3'],6,places=7)
        self.assertIsNone(early['thresholds'][0]['firstCrossingSeconds'])
        self.assertEqual(early['routes']['movements'][0]['alternatives'][0]['edgeSequence'],['east-direct','exit'])
        for r in [late,early]:self.assertLess(abs(r['diagnostics']['conservationResidualM3']),1e-6)
        s['events'][1]['atSeconds']=14400;s['routeGraph']['edges'][1]['availability']='blocked'
        blocked=solve(s);self.assertFalse(blocked['routes']['movements'][0]['allStartingNodesFeasible'])
