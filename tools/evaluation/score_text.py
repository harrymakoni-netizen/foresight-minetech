"""Score field matches; span existence is not semantic entailment."""
import argparse,json
from collections import Counter
from pathlib import Path
FIELDS=['category','polarity','quantity','unit','observedAt','zoneId','action']
def score(dataset,predictions,partition):
    examples=[e for e in dataset['examples'] if e['partition']==partition];predictions={e['exampleId']:e for e in predictions};tp=fp=fn=invalid=total=wrong_links=links=0;missing=[]
    for example in examples:
        prediction=predictions.get(example['id'])
        if prediction is None:missing.append(example['id']);continue
        expected=Counter((i,k,json.dumps(f.get(k),sort_keys=True)) for i,f in enumerate(example['expectedFacts']) for k in FIELDS)
        actual=Counter((i,k,json.dumps(f.get(k),sort_keys=True)) for i,f in enumerate(prediction['facts']) for k in FIELDS)
        tp+=sum((expected&actual).values());fp+=sum((actual-expected).values());fn+=sum((expected-actual).values())
        for i,f in enumerate(prediction['facts']):
            total+=1
            if not f.get('spans') or any(example['text'][s['start']:s['end']]!=s['quote'] for s in f['spans']):invalid+=1
            if i<len(example['expectedFacts']):
                for k in ['zoneId','observedAt']:
                    links+=1;wrong_links+=f.get(k)!=example['expectedFacts'][i].get(k)
    return {'partition':partition,'examples':len(examples),'missingPredictions':missing,'fieldPrecision':tp/(tp+fp) if tp+fp else None,'fieldRecall':tp/(tp+fn) if tp+fn else None,'invalidSourceSpanRate':invalid/total if total else None,'unsupportedExtractionRate':None,'unsupportedExtractionReason':'Requires independent human entailment labels; valid offsets alone do not establish support.','incorrectZoneOrTimeLinkRate':wrong_links/links if links else None,'independentReviewComplete':dataset.get('independentReviewComplete',False),'releaseThresholds':dataset.get('accuracyReleaseThresholds'),'limitation':'Candidate labels are provisional. Ordinal fact matching is a transparent initial scorer; review unmatched/reordered facts separately.'}
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('predictions');parser.add_argument('--partition',choices=['development','locked'],default='development');args=parser.parse_args();dataset=json.loads(Path('fixtures/evaluation/text-candidates.json').read_text());print(json.dumps(score(dataset,json.loads(Path(args.predictions).read_text()),args.partition),indent=2))
