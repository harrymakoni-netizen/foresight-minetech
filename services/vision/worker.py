"""Bounded local video decode → real ONNX inference → track → policy → evidence."""
from __future__ import annotations
import json,os,time,uuid
from datetime import datetime,timedelta,timezone
from pathlib import Path
import cv2
from .model import OnnxDetector
from .policy import Tracker,equipment,EventMachine,point_polygon

def process(detector:OnnxDetector,source,config,progress=lambda x:None,cancelled=lambda:False):
    capture=cv2.VideoCapture(str(source),cv2.CAP_FFMPEG,[cv2.CAP_PROP_OPEN_TIMEOUT_MSEC,5000,cv2.CAP_PROP_READ_TIMEOUT_MSEC,3000]) if config.get('feedAlias') else cv2.VideoCapture(str(source));fps=capture.get(cv2.CAP_PROP_FPS);count=capture.get(cv2.CAP_PROP_FRAME_COUNT)
    if not capture.isOpened() or not 0<fps<=240:raise ValueError('Video decode unavailable or invalid FPS')
    if capture.get(cv2.CAP_PROP_FRAME_WIDTH)>3840 or capture.get(cv2.CAP_PROP_FRAME_HEIGHT)>2160:capture.release();raise ValueError('Decode resolution exceeds configured budget')
    max_seconds=min(float(config.get('maxSeconds',120)),120);target_fps=min(float(config.get('inferenceFps',5)),10)
    if count>0 and count/fps>max_seconds+1: capture.release();raise ValueError('Video exceeds 120-second processing budget')
    session=config.get('id',str(uuid.uuid4()));tracker=Tracker();machine=EventMachine(session_id=session);processed=decoded=0;durations=[];latencies=[];assessable={'helmet':0,'vest':0};total=0;last_selected=-1;started=time.monotonic();origin=datetime.fromisoformat(config['timeOrigin'].replace('Z','+00:00'))
    if origin.tzinfo is None:raise ValueError('Recording time must be timezone aware')
    evidence_dir=Path(config['evidenceDirectory'])/session;evidence_dir.mkdir(parents=True,exist_ok=True)
    quality_counts={'cannot-assess':0,'observed':0,'potentially-missing':0};retained=set();timestamps=[]
    try:
        while decoded<30000:
            if cancelled():return {'status':'cancelled','sessionId':session}
            ok,frame=capture.read()
            if not ok:break
            decoded+=1
            # Prefer decoded presentation timestamp; reject nonmonotonic PTS rather than silently inventing capture time.
            pts=time.monotonic()-started if config.get('feedAlias') else capture.get(cv2.CAP_PROP_POS_MSEC)/1000
            if timestamps and pts<timestamps[-1]-1e-5:raise ValueError('Nonmonotonic video presentation timestamps')
            if pts>max_seconds:break
            if pts-last_selected<1/target_fps-1e-5:continue
            last_selected=pts;timestamps.append(pts);frame_start=time.monotonic()
            if frame.shape[0]>2160 or frame.shape[1]>3840:raise ValueError('Decode resolution exceeds 3840 × 2160')
            detections,elapsed=detector.detect(frame);durations.append(elapsed);processed+=1
            people=tracker.update([d for d in detections if d['class']=='person'],pts);height,width=frame.shape[:2];frame_id=f'{session}-{decoded}';retain=False
            for person in people:
                x1,y1,x2,y2=map(int,person['box']);crop=frame[y1:y2,x1:x2];brightness=float(cv2.cvtColor(crop,cv2.COLOR_BGR2GRAY).mean()) if crop.size else 0
                observations=equipment(person,detections,width,height,brightness,people);total+=1
                for item in config.get('required',['helmet','vest']):
                    state=observations[item]['state'];quality_counts[state]+=1;assessable[item]+=state!='cannot-assess'
                    event=machine.ppe(person['trackId'],item,state,pts,frame_id)
                    if state=='potentially-missing':retain=True
                    if event:event['signals']={'equipmentScore':observations[item].get('confidence'),'personScore':person['confidence'],'visibilityNote':'Head/torso quality checks passed; raw model scores are not calibrated probabilities'}
                region=config.get('restrictedRegion');polygon=[[region['xMin']*width,region['yMin']*height],[region['xMax']*width,region['yMin']*height],[region['xMax']*width,region['yMax']*height],[region['xMin']*width,region['yMax']*height]] if region else []
                position=point_polygon(((x1+x2)/2,y2),polygon,config.get('boundaryTolerancePixels',3))
                entry_event=machine.entry(person['trackId'],position,pts,frame_id)
                if entry_event:
                    retain=True;entry_event['signals']={'equipmentScore':None,'personScore':person['confidence'],'visibilityNote':'Footpoint outside-to-inside transition in mapped camera region; no global positioning'}
            if retain:
                # Blur upper body/head regions before retaining minimal evidence stills. Raw clip is not exported or sent to text models.
                blurred=frame.copy()
                for p in people:
                    x1,y1,x2,y2=map(int,p['box']);w,h=x2-x1,y2-y1;x1,x2=x1+int(w*.2),x2-int(w*.2);y1,y2=y1+int(h*.1),y1+max(1,int(h*.25));crop=blurred[y1:y2,x1:x2]
                    if crop.size:blurred[y1:y2,x1:x2]=cv2.GaussianBlur(crop,(31,31),0)
                cv2.imwrite(str(evidence_dir/(frame_id+'.jpg')),blurred);retained.add(frame_id)
            latencies.append(time.monotonic()-frame_start);progress(min(0.99,pts/max_seconds))
    finally:capture.release()
    if not processed:raise ValueError('No decoded frames were processed')
    events=[]
    for event in machine.events.values():
        ids=[fid for fid in event['frameIds'] if fid in retained]
        events.append({**event,'schemaVersion':'1.0','workspaceId':config['workspaceId'],'cameraId':config['cameraId'],'sessionId':session,'zoneId':config['zoneId'],'startsAt':(origin+timedelta(seconds=event['startSeconds'])).isoformat(),'endsAt':(origin+timedelta(seconds=event['endSeconds'])).isoformat(),'frameIds':ids,'provenance':{'modelId':detector.manifest['modelId'],'weightsSha256':detector.manifest['sha256'],'runtime':'onnxruntime-cpu','policyVersion':config.get('policyVersion','ppe-development-1')}})
    used={fid for event in events for fid in event['frameIds']}
    for image in evidence_dir.glob('*.jpg'):
        if image.stem not in used:image.unlink()
    wall=time.monotonic()-started;ordered=sorted(latencies)
    return {'status':'completed','sessionId':session,'events':events,'metrics':{'decodedFrames':decoded,'inferredFrames':processed,'sourceFps':fps,'inferenceFps':processed/sum(durations),'processingFps':processed/wall,'p95FrameProcessingSeconds':ordered[min(len(ordered)-1,int(.95*len(ordered)))],'durationSeconds':wall,'videoSeconds':timestamps[-1] if timestamps else 0,'assessableCoverage':{k:v/total if total else 0 for k,v in assessable.items()},'qualityCounts':quality_counts,'declaredHardware':os.environ.get('FORESIGHT_HARDWARE','Undeclared; benchmark not accepted')},'limitations':['Recorded clip processing; frame latency is not live capture-to-alert delay.','Potentially missing PPE requires explicit negative model evidence; absence alone is cannot assess.','No identity recognition; zone mapping only; no global metric position.'],'policy':{'minSamples':3,'minSeconds':1.0,'entryPolicy':'outside-to-inside footpoint transition; boundary tolerance; independent of PPE duration','retentionDays':7}}
