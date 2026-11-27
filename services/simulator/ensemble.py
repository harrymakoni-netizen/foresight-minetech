"""Seeded sensitivity envelope. Uniform assumption samples are not calibrated probabilities."""
import copy,random
from .engine import solve,validate,ValidationError,input_hash

def validate_ranges(scenario,config):
    if not isinstance(config,dict) or set(config)!={'samples','seed','inflowM3s','pumpCapacityM3s','backupDelaySeconds'}:raise ValidationError('Invalid sensitivity contract')
    if not isinstance(config['samples'],int) or not 1<=config['samples']<=100:raise ValidationError('Ensemble budget is 1–100 samples')
    if not isinstance(config['seed'],int):raise ValidationError('Ensemble seed must be an integer')
    for field,maximum in [('inflowM3s',100),('pumpCapacityM3s',100),('backupDelaySeconds',scenario['horizonSeconds'])]:
        values=config[field]
        if not isinstance(values,list) or len(values)!=2 or not 0<=values[0]<=values[1]<=maximum:raise ValidationError('Invalid '+field+' assumption range')
    if not any(e['type']=='pump_availability' for e in scenario['events']):raise ValidationError('Sensitivity run needs a configured backup activation event')
    return config

def ensemble(scenario,config,cancelled=lambda:False,progress=lambda x:None):
    validate(scenario);validate_ranges(scenario,config);rng=random.Random(config['seed']);results=[];envelope=[]
    for i in range(config['samples']):
        if cancelled():return {'status':'cancelled','samplesCompleted':i}
        s=copy.deepcopy(scenario);flow=rng.uniform(*config['inflowM3s']);pump=rng.uniform(*config['pumpCapacityM3s']);delay=rng.uniform(*config['backupDelaySeconds']);s['nodes'][0]['inflowM3s']=flow;s['pumps'][0]['capacityM3s']=pump
        next(e for e in s['events'] if e['type']=='pump_availability')['atSeconds']=delay
        result=solve(s,cancelled)
        if result['status']=='cancelled':return {'status':'cancelled','samplesCompleted':i}
        results.append({'inputHash':result['inputHash'],'parameters':{'inflowM3s':flow,'pumpCapacityM3s':pump,'backupDelaySeconds':delay},'summary':result['summary'],'thresholds':result['thresholds'],'relativeResidual':result['diagnostics']['relativeResidual']})
        for j,point in enumerate(result['series']):
            volume=sum(n['volumeM3'] for n in point['nodes'].values())
            if i==0:envelope.append({'atSeconds':point['atSeconds'],'minimumVolumeM3':volume,'maximumVolumeM3':volume})
            else:envelope[j]['minimumVolumeM3']=min(envelope[j]['minimumVolumeM3'],volume);envelope[j]['maximumVolumeM3']=max(envelope[j]['maximumVolumeM3'],volume)
        progress((i+1)/config['samples'])
    return {'status':'completed','modelId':'bounded-sensitivity-v1','inputHash':input_hash({'scenario':scenario,'sensitivity':config}),'assumptions':config,'sampleResults':results,'envelope':envelope,'crossingCounts':[{'thresholdId':t['id'],'crossed':sum(not r['thresholds'][j]['censored'] for r in results),'censored':sum(r['thresholds'][j]['censored'] for r in results)} for j,t in enumerate(scenario['thresholds'])],'warning':'Range from uniformly sampled stated assumptions, not a confidence interval or calibrated probability.'}
