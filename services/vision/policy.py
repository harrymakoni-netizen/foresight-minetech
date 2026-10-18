"""Quality-aware local tracking and review-event state machines. No worker identification."""
from __future__ import annotations
import math,uuid

def iou(a,b):
    intersection=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
    area=(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection
    return intersection/area if area>0 else 0

class Tracker:
    def __init__(self,max_gap=1.0):self.tracks={};self.next=1;self.max_gap=max_gap
    def update(self,people,t):
        self.tracks={k:v for k,v in self.tracks.items() if t-v['at']<=self.max_gap};remaining=set(self.tracks);result=[]
        for person in sorted(people,key=lambda x:-x['confidence']):
            candidates=[(iou(person['box'],self.tracks[k]['box']),k) for k in remaining]
            score,key=max(candidates,default=(0,None))
            if score<0.3:key=str(self.next);self.next+=1
            else:remaining.remove(key)
            self.tracks[key]={'box':person['box'],'at':t};result.append({**person,'trackId':key})
        return result

def center_in(box,region):
    x,y=(box[0]+box[2])/2,(box[1]+box[3])/2
    return region[0]<=x<=region[2] and region[1]<=y<=region[3]

def equipment(person,detections,width,height,brightness,people):
    x1,y1,x2,y2=person['box'];w,h=x2-x1,y2-y1
    overlap=any(other is not person and other.get('trackId')!=person.get('trackId') and iou(person['box'],other['box'])>0.25 for other in people)
    quality=brightness>=45 and h>=60 and x1>1 and x2<width-1 and y2<height-1 and not overlap
    regions={'helmet':[x1,y1,x2,y1+h*.3],'vest':[x1+w*.1,y1+h*.2,x2-w*.1,y1+h*.75]}
    result={}
    for item,region in regions.items():
        region_visible=quality and (y1>1 if item=='helmet' else y1+h*.75<height-1)
        present=[d for d in detections if d['class']==item and center_in(d['box'],region)]
        negative=[d for d in detections if d['class']=='no-'+item and center_in(d['box'],region)]
        if not region_visible:result[item]={'state':'cannot-assess','reason':'Darkness, overlap, small body region or clipped view'}
        elif present and negative:result[item]={'state':'cannot-assess','reason':'Conflicting positive and negative equipment evidence'}
        elif present:result[item]={'state':'observed','confidence':max(d['confidence'] for d in present)}
        elif negative:result[item]={'state':'potentially-missing','confidence':max(d['confidence'] for d in negative)}
        else:result[item]={'state':'cannot-assess','reason':'No positive or explicit negative equipment evidence; absent box is insufficient'}
    return result

def point_polygon(point,polygon,tolerance=3):
    if len(polygon)<3:return 'unknown'
    x,y=point;inside=False
    for a,b in zip(polygon,polygon[1:]+polygon[:1]):
        dx,dy=b[0]-a[0],b[1]-a[1];length=dx*dx+dy*dy
        f=max(0,min(1,((x-a[0])*dx+(y-a[1])*dy)/length)) if length else 0
        if math.hypot(x-(a[0]+f*dx),y-(a[1]+f*dy))<=tolerance:return 'boundary'
        if (a[1]>y)!=(b[1]>y) and x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:inside=not inside
    return 'inside' if inside else 'outside'

class EventMachine:
    def __init__(self,min_samples=3,min_seconds=1.0,reset_seconds=1.0,session_id=None):
        self.namespace=uuid.UUID(session_id) if session_id else uuid.uuid4();self.min_samples=min_samples;self.min_seconds=min_seconds;self.reset_seconds=reset_seconds;self.candidates={};self.entries={};self.events={}
    def ppe(self,track,item,state,t,frame_id):
        key=(track,item);candidate=self.candidates.get(key)
        if state!='potentially-missing':
            if candidate:
                candidate['resetAt']=candidate.get('resetAt',t)
                if state=='cannot-assess' and not candidate.get('eventId'):self.candidates.pop(key,None)
                elif t-candidate['resetAt']>=self.reset_seconds:self.candidates.pop(key,None)
            return None
        if candidate and (t-candidate['last']>self.reset_seconds or ('resetAt' in candidate and t-candidate['resetAt']>=self.reset_seconds)):candidate=None
        if not candidate:candidate={'start':t,'last':t,'count':0,'frames':[]};self.candidates[key]=candidate
        candidate.pop('resetAt',None);candidate['last']=t;candidate['count']+=1;candidate['frames']=candidate['frames']+[frame_id]
        if len(candidate['frames'])>20:candidate['frames']=candidate['frames'][:3]+candidate['frames'][-17:]
        if candidate['count']>=self.min_samples and t-candidate['start']>=self.min_seconds:
            candidate.setdefault('eventId',str(uuid.uuid5(self.namespace,f"{track}:{item}:{candidate['start']:.6f}")));event={'eventId':candidate['eventId'],'trackId':track,'type':item,'startSeconds':candidate['start'],'endSeconds':t,'frameIds':candidate['frames'],'state':'confirmed-for-review','visibility':'assessable'};self.events[event['eventId']]=event;return event
        return None
    def entry(self,track,position,t,frame_id):
        previous=self.entries.get(track)
        if position=='boundary':return None
        if position=='unknown':self.entries.pop(track,None);return None
        self.entries[track]=position
        if position=='inside' and previous=='outside':
            event={'eventId':str(uuid.uuid5(self.namespace,f'entry:{track}:{t:.6f}')),'trackId':track,'type':'restricted-entry','startSeconds':t,'endSeconds':t,'frameIds':[frame_id],'state':'confirmed-for-review','visibility':'assessable'};self.events[event['eventId']]=event;return event
        return None
    def feed_loss(self):self.candidates.clear();self.entries.clear()
