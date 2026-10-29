"""Deterministic lumped storage planning model. SI units; no inferred hydraulics."""
from __future__ import annotations
import copy
import hashlib
import heapq
import json
import math
import time
from bisect import bisect_right
from datetime import datetime

ENGINE_VERSION = 'lumped-water-1.0.0'
MAX_NODES, MAX_PUMPS, MAX_EDGES = 3, 6, 80

class ValidationError(ValueError):
    pass

def number(value, label, low=0, high=1e9):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValidationError(f'{label} must be finite in [{low}, {high}]')
    return value

def unique(items, label):
    ids = [x.get('id') for x in items]
    if any(not isinstance(x, str) or not 1 <= len(x) <= 100 for x in ids) or len(ids) != len(set(ids)):
        raise ValidationError(f'{label} identifiers must be unique nonempty strings')
    return set(ids)

def validate(s):
    required = {'schemaVersion','workspaceId','baselineSnapshotId','modelId','modelVersion','timeOrigin','horizonSeconds','outputIntervalSeconds','maxStepSeconds','seed','units','nodes','pumps','transfers','events','thresholds','routeGraph','movements','provenance'}
    if not isinstance(s, dict) or set(s) != required:
        raise ValidationError('Scenario fields do not match version 1.0 contract')
    if s['schemaVersion'] != '1.0' or s['modelId'] != 'lumped-water-v1' or s['modelVersion'] != ENGINE_VERSION:
        raise ValidationError('Unsupported schema or model version')
    for k in ('workspaceId','baselineSnapshotId'):
        if not isinstance(s[k],str) or not 1 <= len(s[k]) <= 120: raise ValidationError(f'{k} is required')
    try:
        origin = datetime.fromisoformat(s['timeOrigin'].replace('Z','+00:00'))
        if origin.tzinfo is None: raise ValueError()
    except (ValueError, TypeError): raise ValidationError('timeOrigin must be timezone aware')
    number(s['horizonSeconds'],'horizon',1,86400)
    number(s['outputIntervalSeconds'],'output interval',1,s['horizonSeconds'])
    number(s['maxStepSeconds'],'internal step',0.05,30)
    if s['horizonSeconds']/s['outputIntervalSeconds'] > 5000: raise ValidationError('Output budget exceeds 5000 samples')
    number(s['seed'],'seed',0,2**32-1)
    if not isinstance(s['seed'],int): raise ValidationError('seed must be an integer')
    if s['units'] != {'volume':'m3','level':'m','time':'s','flow':'m3/s'}: raise ValidationError('Only SI units are accepted; convert once at boundary')
    if not 1 <= len(s['nodes']) <= MAX_NODES or len(s['pumps']) > MAX_PUMPS or len(s['transfers']) > 12: raise ValidationError('Storage/pump/transfer budget exceeded')
    node_ids, pump_ids, transfer_ids = unique(s['nodes'],'nodes'), unique(s['pumps'],'pumps'), unique(s['transfers'],'transfers')
    physical_ids=set()
    for n in s['nodes']:
        if n.get('zoneId') not in ['zone-a','zone-b','zone-c']: raise ValidationError('Unknown zone')
        curve=n.get('geometry',[])
        if not 2 <= len(curve) <= 100: raise ValidationError('Geometry needs 2–100 volume/level points')
        for p in curve: number(p['volumeM3'],'geometry volume'); number(p['levelM'],'geometry elevation',-10000,10000)
        if curve[0]['volumeM3'] != 0: raise ValidationError('Geometry must start at zero volume')
        for a,b in zip(curve,curve[1:]):
            if b['volumeM3'] <= a['volumeM3'] or b['levelM'] <= a['levelM']: raise ValidationError('Geometry must be strictly monotonic and invertible')
        number(n['initialVolumeM3'],'initial volume',0,curve[-1]['volumeM3'])
        number(n['inflowM3s'],'inflow',0,100)
        physical_ids.add(n['id'])
    for p in s['pumps']:
        if p['nodeId'] not in node_ids or type(p['available']) is not bool: raise ValidationError('Invalid pump reference/availability')
        number(p['capacityM3s'],'effective pump capacity',0,100)
        if (p.get('startLevelM') is None) != (p.get('stopLevelM') is None): raise ValidationError('Both hysteresis levels or neither are required')
        if p.get('startLevelM') is not None:
            number(p['startLevelM'],'start level',-10000,10000); number(p['stopLevelM'],'stop level',-10000,10000)
            if p['startLevelM'] <= p['stopLevelM']: raise ValidationError('Pump start level must exceed stop level')
            curve=next(n['geometry'] for n in s['nodes'] if n['id']==p['nodeId'])
            if not curve[0]['levelM'] <= p['stopLevelM'] < p['startLevelM'] <= curve[-1]['levelM']: raise ValidationError('Pump switching outside geometry')
        physical_ids.add(p['id'])
    for tr in s['transfers']:
        if tr['from'] not in node_ids or tr['to'] not in node_ids or tr['from']==tr['to']: raise ValidationError('Invalid directed transfer')
        number(tr['capacityM3s'],'transfer capacity',0,100)
        if not tr.get('assumption'): raise ValidationError('Transfer relation/source assumption is required')
        physical_ids.add(tr['id'])
    graph=s['routeGraph']
    if len(graph['nodes'])>50 or len(graph['edges'])>MAX_EDGES: raise ValidationError('Route graph budget exceeded')
    graph_ids=unique(graph['nodes'],'route nodes'); edge_ids=unique(graph['edges'],'route edges')
    for e in graph['edges']:
        if e['from'] not in graph_ids or e['to'] not in graph_ids or e['zoneId'] not in ['zone-a','zone-b','zone-c']: raise ValidationError('Unknown route endpoint/zone')
        number(e['lengthM'],'route length',0.01,100000); number(e['speedMps'],'assumed speed',0.05,5); number(e['delaySeconds'],'route delay',0,86400)
        if e['availability'] not in ['available','blocked','unknown'] or type(e['bidirectional']) is not bool or not e.get('source'): raise ValidationError('Explicit route availability/direction/source required')
    if len(s['events'])>200 or len(s['thresholds'])>50 or len(s['movements'])>50: raise ValidationError('Event/threshold/movement budget exceeded')
    for e in s['events']:
        number(e['atSeconds'],'event time',0,s['horizonSeconds'])
        typ=e['type']
        if typ=='inflow':
            if e['nodeId'] not in node_ids: raise ValidationError('Unknown inflow node')
            number(e['rateM3s'],'scheduled inflow',0,100)
        elif typ in ('pump_availability','pump_capacity'):
            if e['pumpId'] not in pump_ids: raise ValidationError('Unknown pump')
            if typ=='pump_availability' and type(e['available']) is not bool: raise ValidationError('Availability must be boolean')
            if typ=='pump_capacity': number(e['capacityM3s'],'scheduled capacity',0,100)
        elif typ=='route_availability':
            if e['edgeId'] not in edge_ids or type(e['available']) is not bool: raise ValidationError('Unknown route event')
        else: raise ValidationError('Unsupported scheduled event')
    unique(s['thresholds'],'thresholds')
    for th in s['thresholds']:
        if th['nodeId'] not in node_ids or any(e not in edge_ids for e in th['edgeIds']): raise ValidationError('Invalid threshold reference')
        curve=next(n['geometry'] for n in s['nodes'] if n['id']==th['nodeId'])
        number(th['levelM'],'threshold level',curve[0]['levelM'],curve[-1]['levelM'])
        if not th.get('source'): raise ValidationError('Threshold source/assumption required')
    unique(s['movements'],'movements')
    for m in s['movements']:
        if not m['startNodes'] or any(n not in graph_ids for n in m['startNodes']) or m['targetNode'] not in graph_ids: raise ValidationError('Movement starting-node assumptions required')
        number(m['departureSeconds'],'departure',0,s['horizonSeconds']); number(m['responseDelaySeconds'],'response delay',0,86400)
        if not m.get('assumption'): raise ValidationError('Movement source/assumption required')
    if not isinstance(s['provenance'],list): raise ValidationError('Physical input provenance required')
    covered={p.get('id') for p in s['provenance'] if p.get('source') and p.get('quality') in ['assumed','measured','stale','unverified']}
    if not physical_ids <= covered: raise ValidationError('Every physical node, pump and transfer needs provenance')
    return s

def interpolate(curve,x,x_key,y_key):
    if not curve[0][x_key]-1e-9 <= x <= curve[-1][x_key]+1e-9: raise ValidationError('Geometry extrapolation is disabled')
    j=min(max(bisect_right([p[x_key] for p in curve],x)-1,0),len(curve)-2)
    a,b=curve[j],curve[j+1]
    return a[y_key]+(x-a[x_key])*(b[y_key]-a[y_key])/(b[x_key]-a[x_key])

def level(node,volume): return interpolate(node['geometry'],volume,'volumeM3','levelM')
def volume_at_level(node,elevation): return interpolate(node['geometry'],elevation,'levelM','volumeM3')
def input_hash(s): return hashlib.sha256(json.dumps(s,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()

def solve(scenario, cancelled=lambda:False, progress=lambda x:None):
    started=time.perf_counter();s=copy.deepcopy(validate(scenario)); digest=input_hash(s)
    nodes={n['id']:n for n in s['nodes']};pumps={p['id']:p for p in s['pumps']}
    volumes={i:n['initialVolumeM3'] for i,n in nodes.items()};initial=sum(volumes.values())
    running={i: p.get('startLevelM') is None or level(nodes[p['nodeId']],volumes[p['nodeId']]) >= p['startLevelM'] for i,p in pumps.items()}
    events=sorted(enumerate(s['events']),key=lambda e:(e[1]['atSeconds'],e[0]));event_i=0
    t=0.0; inflow=discharge=overflow=0.0;node_overflow={i:0.0 for i in nodes};node_discharge={i:0.0 for i in nodes}
    samples=[];internal=[];crossings={th['id']:[] for th in s['thresholds']};previous_above={th['id']:level(nodes[th['nodeId']],volumes[th['nodeId']])>=th['levelM'] for th in s['thresholds']}
    for th in s['thresholds']:
        if previous_above[th['id']]:crossings[th['id']].append({'atSeconds':0.0,'direction':'above'})
    next_output=0.0;iterations=0;peak={i:volumes[i] for i in nodes};last_rates={i:0.0 for i in nodes}
    def state():
        return {'atSeconds':round(t,8),'nodes':{i:{'volumeM3':v,'levelM':level(nodes[i],v),'pumpDischargeM3s':last_rates[i],'cumulativeDischargeM3':node_discharge[i],'cumulativeOverflowM3':node_overflow[i]} for i,v in volumes.items()},'cumulativeInflowM3':inflow,'cumulativeDischargeM3':discharge,'cumulativeOverflowM3':overflow}
    while True:
        while event_i<len(events) and events[event_i][1]['atSeconds'] <= t+1e-8:
            e=events[event_i][1];event_i+=1
            if e['type']=='inflow':nodes[e['nodeId']]['inflowM3s']=e['rateM3s']
            elif e['type']=='pump_availability':pumps[e['pumpId']]['available']=e['available']
            elif e['type']=='pump_capacity':pumps[e['pumpId']]['capacityM3s']=e['capacityM3s']
        for i,p in pumps.items():
            if p.get('startLevelM') is not None:
                h=level(nodes[p['nodeId']],volumes[p['nodeId']])
                if running[i] and h<=p['stopLevelM']+1e-9:running[i]=False
                elif not running[i] and h>=p['startLevelM']-1e-9:running[i]=True
        if t>=next_output-1e-8 or t>=s['horizonSeconds']-1e-8:
            samples.append(state());next_output=min(next_output+s['outputIntervalSeconds'],s['horizonSeconds'])
        internal.append((t,dict(volumes)))
        if t>=s['horizonSeconds']-1e-8:break
        if cancelled():return {'status':'cancelled','inputHash':digest,'engineVersion':ENGINE_VERSION,'progress':t/s['horizonSeconds']}
        dt=min(s['maxStepSeconds'],s['horizonSeconds']-t,next_output-t)
        if event_i<len(events):dt=min(dt,events[event_i][1]['atSeconds']-t)
        pump_rates={i:sum(p['capacityM3s'] for key,p in pumps.items() if p['nodeId']==i and p['available'] and running[key]) for i in nodes}
        incoming={i:sum(tr['capacityM3s'] for tr in s['transfers'] if tr['to']==i and volumes[tr['from']]>1e-9) for i in nodes}
        outgoing={i:sum(tr['capacityM3s'] for tr in s['transfers'] if tr['from']==i) for i in nodes}
        # Split exactly at pump hysteresis boundaries using the current flux estimate.
        for key,p in pumps.items():
            if not p['available'] or p.get('startLevelM') is None:continue
            i=p['nodeId'];net=nodes[i]['inflowM3s']+incoming[i]-pump_rates[i]-outgoing[i]
            boundary=p['stopLevelM'] if running[key] else p['startLevelM'];dv=volume_at_level(nodes[i],boundary)-volumes[i]
            if net*dv>1e-12:dt=min(dt,max(dv/net,1e-6))
        if dt<=1e-10:raise ValidationError('Integration step stalled')
        available={i:volumes[i]+nodes[i]['inflowM3s']*dt for i in nodes}
        # Same-state transfers; proportional deterministic allocation across each donor's pump and transfer requests.
        fractions={i:min(1.0,available[i]/((pump_rates[i]+outgoing[i])*dt)) if pump_rates[i]+outgoing[i]>0 else 1.0 for i in nodes}
        transfer_delta={i:0.0 for i in nodes}
        for tr in s['transfers']:
            amount=tr['capacityM3s']*dt*fractions[tr['from']]
            transfer_delta[tr['from']]-=amount;transfer_delta[tr['to']]+=amount
        before=dict(volumes)
        for i,n in nodes.items():
            external=n['inflowM3s']*dt;out=pump_rates[i]*dt*fractions[i]
            inflow+=external;discharge+=out;node_discharge[i]+=out;last_rates[i]=out/dt
            stored=available[i]-out+transfer_delta[i]
            if stored < -1e-7:raise ValidationError('Negative water balance')
            spill=max(0.0,stored-n['geometry'][-1]['volumeM3']);overflow+=spill;node_overflow[i]+=spill
            volumes[i]=min(n['geometry'][-1]['volumeM3'],max(0.0,stored));peak[i]=max(peak[i],volumes[i])
        for th in s['thresholds']:
            i=th['nodeId'];v=volume_at_level(nodes[i],th['levelM']);above=volumes[i]>=v-1e-10
            if above != previous_above[th['id']]:
                delta=volumes[i]-before[i];fraction=(v-before[i])/delta if abs(delta)>1e-12 else 1
                crossing=t+dt*min(1,max(0,fraction));crossings[th['id']].append({'atSeconds':crossing,'direction':'above' if above else 'below'});previous_above[th['id']]=above
        t+=dt;iterations+=1
        if iterations>2000000:raise ValidationError('Internal compute budget exceeded')
        if iterations%200==0:progress(min(0.99,t/s['horizonSeconds']))
    balance=sum(volumes.values())+discharge+overflow-initial-inflow;scale=max(1.0,initial+inflow)
    if abs(balance)/scale>1e-6:raise ValidationError('Conservation check failed')
    route_results=routes(s,crossings)
    return {'status':'completed','schemaVersion':'1.0','engineVersion':ENGINE_VERSION,'inputHash':digest,'seed':s['seed'],'series':samples,'thresholds':[{'id':th['id'],'label':th['label'],'crossings':crossings[th['id']],'firstCrossingSeconds':next((x['atSeconds'] for x in crossings[th['id']] if x['direction']=='above'),None),'censored':not any(x['direction']=='above' for x in crossings[th['id']])} for th in s['thresholds']],'routes':route_results,'summary':{'initialStorageM3':initial,'finalStorageM3':sum(volumes.values()),'externalInflowM3':inflow,'externalDischargeM3':discharge,'overflowM3':overflow,'peakVolumeM3':peak},'diagnostics':{'conservationResidualM3':balance,'relativeResidual':abs(balance)/scale,'internalSteps':iterations,'maxStepSeconds':s['maxStepSeconds'],'durationMs':round((time.perf_counter()-started)*1000,3),'thresholdTimePrecisionSeconds':s['maxStepSeconds']},'warnings':['Fictional configured drainage planning approximation; no pressure/backwater or groundwater solver.','Effective constant pump capacities, layout and water thresholds require site review.','Assignments and simulated arrival are not live positions or human muster.']+[f"{p['id']}: {p['quality']} input from {p['source']}" for p in s['provenance'] if p['quality']!='measured']}

def routes(s,crossings):
    horizon=s['horizonSeconds'];windows={e['id']:[] for e in s['routeGraph']['edges']}
    for th in s['thresholds']:
        start=None
        for c in crossings[th['id']]:
            if c['direction']=='above':start=c['atSeconds']
            elif start is not None:
                for eid in th['edgeIds']:windows[eid].append((start,c['atSeconds']))
                start=None
        if start is not None:
            for eid in th['edgeIds']:windows[eid].append((start,horizon+1))
    for e in s['routeGraph']['edges']:
        start=0 if e['availability']!='available' else None
        for _,ev in sorted(enumerate(s['events']),key=lambda x:(x[1]['atSeconds'],x[0])):
            if ev['type']!='route_availability' or ev['edgeId']!=e['id']:continue
            if not ev['available'] and start is None:start=ev['atSeconds']
            elif ev['available'] and start is not None:windows[e['id']].append((start,ev['atSeconds']));start=None
        if start is not None:windows[e['id']].append((start,horizon+1))
    adjacency={n['id']:[] for n in s['routeGraph']['nodes']}
    for e in s['routeGraph']['edges']:
        adjacency[e['from']].append((e['to'],e))
        if e['bidirectional']:adjacency[e['to']].append((e['from'],e))
    results=[]
    for m in s['movements']:
        departure=m['departureSeconds']+m['responseDelaySeconds'];alternatives=[]
        for start in m['startNodes']:
            queue=[(departure,start,(),(start,))];found=None;visited=0
            while queue:
                at,node,path,seen=heapq.heappop(queue);visited+=1
                if visited>10000:break
                if node==m['targetNode']:found={'edgeSequence':list(path),'arrivalSeconds':at,'travelSeconds':at-departure};break
                for target,e in adjacency[node]:
                    if target in seen:continue
                    finish=at+e['lengthM']/e['speedMps']+e['delaySeconds']
                    if finish>horizon:continue
                    if any(at < end and finish >= begin-1e-9 for begin,end in windows[e['id']]):continue
                    heapq.heappush(queue,(finish,target,path+(e['id'],),seen+(target,)))
            alternatives.append({'startingNode':start,'status':'route-found' if found else 'no-route-found','departureSeconds':departure,**(found or {}),'searchBudgetExceeded':visited>10000})
        results.append({'id':m['id'],'assumption':m['assumption'],'positionStatus':'assumed' if len(m['startNodes'])==1 else 'uncertain-starting-set','alternatives':alternatives,'allStartingNodesFeasible':all(x['status']=='route-found' for x in alternatives)})
    return {'movements':results,'blockedIntervals':{eid:[{'fromSeconds':a,'toSeconds':min(b,horizon)} for a,b in w] for eid,w in windows.items()},'method':'Conservative whole-traversal feasibility; no waiting; simple paths; bounded search.'}

def convergence(scenario):
    coarse=solve(scenario);fine=copy.deepcopy(scenario);fine['maxStepSeconds']/=2;refined=solve(fine)
    differences=[]
    for a,b in zip(coarse['thresholds'],refined['thresholds']):
        x,y=a['firstCrossingSeconds'],b['firstCrossingSeconds'];differences.append({'id':a['id'],'differenceSeconds':abs(x-y) if x is not None and y is not None else None,'censoringMatches':(x is None)==(y is None)})
    return {'coarseStepSeconds':scenario['maxStepSeconds'],'fineStepSeconds':fine['maxStepSeconds'],'finalStorageDifferenceM3':abs(coarse['summary']['finalStorageM3']-refined['summary']['finalStorageM3']),'thresholdDifferences':differences,'coarseRelativeResidual':coarse['diagnostics']['relativeResidual'],'fineRelativeResidual':refined['diagnostics']['relativeResidual']}

if __name__=='__main__':
    import sys
    try:print(json.dumps(solve(json.load(sys.stdin)),allow_nan=False))
    except (ValidationError,KeyError,TypeError) as exc:print(json.dumps({'status':'failed','error':str(exc)}));sys.exit(1)
