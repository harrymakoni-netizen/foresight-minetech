"""Operator-only readiness check. Does not claim PPE accuracy or distribute weights."""
import argparse,json
import numpy as np
from .model import OnnxDetector

def main():
    parser=argparse.ArgumentParser();parser.add_argument('manifest');args=parser.parse_args()
    detector=OnnxDetector(args.manifest)
    detections,_=detector.detect(np.zeros((detector.size,detector.size,3),dtype=np.uint8))
    print(json.dumps({'status':'runtime-contract-loaded','modelId':detector.manifest['modelId'],'sha256':detector.manifest['sha256'],'classes':detector.manifest['classMap'],'blankInputDetectionCount':len(detections),'limitation':'A successful tensor check is not PPE accuracy validation. Verify consented reference clips and class labels before use.'},indent=2))
if __name__=='__main__':main()
