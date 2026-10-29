"""Predeclared analytic/conservation evaluation; software verification, not field validation."""
import copy,json,platform,random,time
from pathlib import Path
from services.simulator.engine import solve,convergence
from services.simulator.test_engine import fixture
MANIFEST=Path('fixtures/evaluation/numerical.json')
def generate():
    rng=random.Random(202610180);sets=[]
    for i in range(30):
        flow=rng.uniform(0,72);pump=rng.uniform(0,72);hours=rng.choice([1,6,24]);scenario=fixture(flow,pump,hours)
        scenario['seed']=202610180+i
        sets.append({'id':f'N{i+1:02}','partition':'development' if i<20 else 'locked','scenario':scenario,'expectedFinalStorageM3':min(150,max(0,30+(flow-pump)*hours))})
    MANIFEST.write_text(json.dumps({'schemaVersion':'1.0','authoredBy':'Codex; constructed software fixtures','independentReviewer':None,'predeclaredChecks':{'relativeConservationTolerance':1e-6,'analyticVolumeAbsoluteToleranceM3':1e-5,'convergenceFinalDifferenceM3':.01},'parametersFrozenBeforeEvaluation':True,'cases':sets},indent=2)+'\n')
def evaluate():
    manifest=json.loads(MANIFEST.read_text());out=[]
    for case in manifest['cases']:
        result=solve(case['scenario']);refinement=convergence(case['scenario']);error=abs(result['summary']['finalStorageM3']-case['expectedFinalStorageM3']);out.append({'id':case['id'],'partition':case['partition'],'analyticErrorM3':error,'relativeResidual':result['diagnostics']['relativeResidual'],'durationMs':result['diagnostics']['durationMs'],'convergence':refinement,'passed':error<=1e-5 and result['diagnostics']['relativeResidual']<=1e-6 and refinement['finalStorageDifferenceM3']<=.01})
    # Three nodes and six pumps, 24 hours, explicit directed transfers.
    performance=fixture(36,12,24)
    for i in [2,3]:
        node=copy.deepcopy(performance['nodes'][0]);node['id']='S'+str(i);performance['nodes'].append(node);performance['provenance'].append({**performance['provenance'][0],'id':node['id']})
    performance['pumps']=[]
    for i in range(6):
        pid='P'+str(i+1);performance['pumps'].append({'id':pid,'nodeId':'S'+str(i//2+1),'capacityM3s':12/3600,'available':True,'startLevelM':None,'stopLevelM':None})
        if pid!='P1':performance['provenance'].append({**performance['provenance'][1],'id':pid})
    perf=solve(performance)
    report={'schemaVersion':'1.0','evaluatedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'engineVersion':'lumped-water-1.0.0','hardware':{'platform':platform.platform(),'machine':platform.machine(),'python':platform.python_version()},'verificationOnly':True,'independentReview':False,'cases':out,'passed':sum(x['passed'] for x in out),'failed':sum(not x['passed'] for x in out),'performance24h3nodes6pumps':perf['diagnostics'],'limitations':['Constructed analytic fixtures; not measured mine data.','Locked partition has no independent human review. No product accuracy release threshold has been approved.','Software conservation and convergence do not establish engineering validity.']}
    Path('docs/numerical-evaluation.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k!='cases'},indent=2))
    if report['failed']:raise SystemExit(1)
if __name__=='__main__':
    import sys
    if '--generate' in sys.argv:
        if MANIFEST.exists():raise SystemExit('Refusing to overwrite frozen numerical parameters.')
        generate()
    else:evaluate()
