"""Compare timestamped measured level readings to a frozen result; no automatic fitting or future leakage."""
import csv,json,math,sys
from datetime import datetime
from bisect import bisect_left
from pathlib import Path

def compare(scenario,result,readings):
    origin=datetime.fromisoformat(scenario['timeOrigin'].replace('Z','+00:00'));series=result['series'];times=[p['atSeconds'] for p in series];residuals=[];missing=[];last=None
    for row in readings:
        at=datetime.fromisoformat(row['observedAt'].replace('Z','+00:00'))
        if at.tzinfo is None or row['unit']!='m':raise ValueError('Timezone-aware readings in metres are required')
        seconds=(at-origin).total_seconds()
        if last is not None and seconds<=last:raise ValueError('Readings must be strictly time ordered')
        if last is not None and seconds-last>scenario['outputIntervalSeconds']*2:missing.append({'fromSeconds':last,'toSeconds':seconds})
        last=seconds
        if seconds<0 or seconds>times[-1]:continue
        j=min(max(bisect_left(times,seconds),1),len(times)-1);a,b=series[j-1],series[j];node=row['nodeId'];f=(seconds-a['atSeconds'])/(b['atSeconds']-a['atSeconds']);model=a['nodes'][node]['levelM']+f*(b['nodes'][node]['levelM']-a['nodes'][node]['levelM']);residuals.append({'observedAt':row['observedAt'],'nodeId':node,'measuredLevelM':float(row['level']),'modelledLevelM':model,'residualM':model-float(row['level']),'pumpStatus':row.get('pumpStatus'),'measuredFlowM3s':float(row['measuredFlowM3s']) if row.get('measuredFlowM3s') else None})
    return {'readingsCompared':len(residuals),'missingIntervals':missing,'rmseM':math.sqrt(sum(x['residualM']**2 for x in residuals)/len(residuals)) if residuals else None,'residuals':residuals,'limitation':'Comparison only; no tuning performed. Separate calibration and held-out files; never use future readings to reconstruct an earlier snapshot.'}
if __name__=='__main__':
    if len(sys.argv)!=4:raise SystemExit('Usage: python -m services.simulator.calibration scenario.json result.json readings.csv')
    print(json.dumps(compare(json.loads(Path(sys.argv[1]).read_text()),json.loads(Path(sys.argv[2]).read_text()),list(csv.DictReader(Path(sys.argv[3]).open()))),indent=2))
