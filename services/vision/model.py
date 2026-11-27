"""ONNX CPU adapter for explicitly mapped PPE models; weights are never downloaded implicitly."""
from __future__ import annotations
import hashlib,json,math,time
from pathlib import Path
import cv2
import numpy as np
import onnxruntime as ort

class ModelUnavailable(ValueError):pass
class OnnxDetector:
    def __init__(self,manifest_path):
        manifest_path=Path(manifest_path);self.manifest=json.loads(manifest_path.read_text());m=self.manifest
        required=['modelId','weights','sha256','weightsLicense','runtimeLicense','licenseReviewedBy','source','inputSize','classMap','outputFormat']
        if any(not m.get(k) or (isinstance(m.get(k),str) and (m[k].startswith('SET_') or m[k]=='REVIEW_REQUIRED')) for k in required):raise ModelUnavailable('Model manifest needs provenance, class map, checksums and reviewed licences')
        if not {'person','helmet','vest'} <= set(m['classMap'].values()):raise ModelUnavailable('The model must detect person, helmet and vest separately')
        if sorted(m['classMap'],key=lambda x:int(x)) != [str(i) for i in range(len(m['classMap']))]:raise ModelUnavailable('Class map must contain every contiguous training class, starting at zero')
        expected={'layout':'NCHW','color':'RGB','normalization':'0..1','resize':'letterbox','padding':114,'coordinates':'input-pixels'}
        if m.get('preprocessing')!=expected:raise ModelUnavailable('Preprocessing must explicitly match RGB NCHW /255 square letterbox 114 and input-pixel coordinates')
        if not 0<float(m.get('scoreThreshold',0.5))<=1:raise ModelUnavailable('Invalid confidence threshold')
        self.size=int(m['inputSize'])
        if self.size<128 or self.size>1280:raise ModelUnavailable('Input size must be 128–1280')
        weights=(manifest_path.parent/m['weights']).resolve()
        if not weights.is_file():raise ModelUnavailable('Configured ONNX weights are unavailable')
        digest=hashlib.sha256(weights.read_bytes()).hexdigest()
        if digest!=m['sha256']:raise ModelUnavailable('Weights checksum does not match manifest')
        self.session=ort.InferenceSession(str(weights),providers=['CPUExecutionProvider']);self.input=self.session.get_inputs()[0].name
        inputs=self.session.get_inputs();outputs=self.session.get_outputs()
        if len(inputs)!=1 or len(outputs)!=1:raise ModelUnavailable('Adapter requires one image input and one detection output')
        image=inputs[0]
        if image.type!='tensor(float)' or len(image.shape)!=4 or any(isinstance(v,int) and v!=wanted for v,wanted in zip(image.shape,[1,3,self.size,self.size])):raise ModelUnavailable('Expected float32 input [1,3,inputSize,inputSize]')
        if m['outputFormat'] not in ['yolo-v8','nms-xyxy']:raise ModelUnavailable('Unsupported output tensor; add a tested model adapter')
        # Fail readiness before enabling controls if actual ONNX execution cannot satisfy the adapter.
        self.detect(np.zeros((self.size,self.size,3),dtype=np.uint8))
    def detect(self,frame):
        height,width=frame.shape[:2];ratio=min(self.size/width,self.size/height);rw,rh=round(width*ratio),round(height*ratio)
        resized=cv2.resize(frame,(rw,rh));left=(self.size-rw)//2;top=(self.size-rh)//2
        image=np.full((self.size,self.size,3),114,dtype=np.uint8);image[top:top+rh,left:left+rw]=resized
        tensor=np.transpose(cv2.cvtColor(image,cv2.COLOR_BGR2RGB),(2,0,1))[None].astype(np.float32)/255
        started=time.perf_counter();raw=self.session.run(None,{self.input:tensor})[0];elapsed=time.perf_counter()-started
        if raw.ndim!=3 or raw.shape[0]!=1 or not np.isfinite(raw).all():raise ModelUnavailable('Expected finite batch-one detection tensor')
        rows=np.squeeze(raw,axis=0)
        if rows.ndim!=2:raise ModelUnavailable('Invalid detection tensor rank')
        if self.manifest['outputFormat']=='yolo-v8':
            classes=len(self.manifest['classMap'])
            if rows.shape[0]==4+classes:rows=rows.T
            if rows.shape[1]!=4+classes:raise ModelUnavailable('YOLO output does not match declared classes')
            scores=rows[:,4:];indices=np.argmax(scores,axis=1);confidence=np.max(scores,axis=1)
            boxes=np.stack([rows[:,0]-rows[:,2]/2,rows[:,1]-rows[:,3]/2,rows[:,0]+rows[:,2]/2,rows[:,1]+rows[:,3]/2],axis=1)
        else:
            if rows.ndim!=2 or rows.shape[1]!=6:raise ModelUnavailable('Expected N × 6 xyxy,confidence,class output')
            boxes,confidence,indices=rows[:,:4],rows[:,4],rows[:,5].astype(int)
        if np.any(confidence<0) or np.any(confidence>1):raise ModelUnavailable('Detection confidence must be a probability in [0,1]')
        if self.manifest['outputFormat']=='nms-xyxy' and (np.any(rows[:,5]!=indices) or np.any(indices<0) or np.any(indices>=len(self.manifest['classMap']))):raise ModelUnavailable('Detection class index outside declared map')
        if self.manifest['outputFormat']=='yolo-v8' and (np.any(scores<0) or np.any(scores>1)):raise ModelUnavailable('Expected class probabilities, not logits or objectness rows')
        candidates=[]
        for box,score,klass in zip(boxes,confidence,indices):
            if float(score)<float(self.manifest.get('scoreThreshold',0.5)):continue
            name=self.manifest['classMap'].get(str(int(klass)))
            if name not in ['person','helmet','vest','no-helmet','no-vest']:continue
            x1,y1,x2,y2=box.tolist();x1,x2=(x1-left)/ratio,(x2-left)/ratio;y1,y2=(y1-top)/ratio,(y2-top)/ratio
            box=[max(0,min(width,x1)),max(0,min(height,y1)),max(0,min(width,x2)),max(0,min(height,y2))]
            if box[2]<=box[0] or box[3]<=box[1]:continue
            candidates.append({'class':name,'confidence':float(score),'box':box})
        # Class-aware deterministic NMS.
        kept=[]
        for d in sorted(candidates,key=lambda x:-x['confidence']):
            if not any(d['class']==k['class'] and iou(d['box'],k['box'])>0.45 for k in kept):kept.append(d)
        return kept,elapsed

def iou(a,b):
    intersection=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
    area=(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection
    return intersection/area if area>0 else 0
