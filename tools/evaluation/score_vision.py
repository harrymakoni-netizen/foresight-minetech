"""Clip-level event matching; inputs must declare reviewed labels and source licences."""
import json,sys
from pathlib import Path

def evaluate(truth,predicted):
    result={}
    for item in ['helmet','vest','restricted-entry']:
        gold=[e for e in truth['events'] if e['type']==item];detections=[e for e in predicted['events'] if e['type']==item];matched=set();tp=0
        for event in detections:
            candidates=[(min(g['endSeconds'],event['endSeconds'])-max(g['startSeconds'],event['startSeconds']),i) for i,g in enumerate(gold) if i not in matched and g['clipId']==event['clipId']]
            overlap,index=max(candidates,default=(-1,None))
            if overlap>=0:matched.add(index);tp+=1
        fp=len(detections)-tp;fn=len(gold)-tp;hours=truth['videoSeconds']/3600
        result[item]={'precision':tp/(tp+fp) if tp+fp else None,'recall':tp/(tp+fn) if tp+fn else None,'falseAlertsPerVideoHour':fp/hours if hours else None,'truePositive':tp,'falsePositive':fp,'falseNegative':fn}
    return {'metrics':result,'assessableCoverage':predicted.get('assessableCoverage'),'latency':predicted.get('latency'),'hardware':predicted.get('hardware'),'model':predicted.get('model'),'reviewedBy':truth.get('reviewedBy'),'limitation':'Temporal overlap matching is software evaluation only; representative capture coverage and label quality require review.'}
if __name__=='__main__':
    if len(sys.argv)!=3:raise SystemExit('Usage: python tools/evaluation/score_vision.py reviewed-truth.json predictions.json')
    truth=json.loads(Path(sys.argv[1]).read_text());predicted=json.loads(Path(sys.argv[2]).read_text())
    if not truth.get('reviewedBy') or not truth.get('sourceLicences'):raise SystemExit('Independently reviewed labels and source licensing are required')
    print(json.dumps(evaluate(truth,predicted),indent=2))
