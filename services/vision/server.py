"""Local CPU vision worker. File uploads only; stream aliases are administrator-configured."""
from __future__ import annotations
import base64,hmac,json,os,sqlite3,threading,urllib.request,uuid,time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from .model import OnnxDetector
from .worker import process
TOKEN=(os.environ.get('FORESIGHT_WORKER_TOKEN') or 'development-worker-token')
if os.environ.get('FORESIGHT_ENV')=='production' and (TOKEN=='development-worker-token' or len(TOKEN)<32):raise RuntimeError('Strong worker credential required')
ROOT=Path(os.environ.get('FORESIGHT_VISION_DATA','.minetech-data/vision'));ROOT.mkdir(parents=True,exist_ok=True)
DB=ROOT/'jobs.sqlite';POOL=ThreadPoolExecutor(max_workers=1);MODEL=None;MODEL_ERROR='No licensed model manifest configured'
if os.environ.get('FORESIGHT_VISION_MANIFEST'):
    try:MODEL=OnnxDetector(os.environ['FORESIGHT_VISION_MANIFEST']);MODEL_ERROR=None
    except Exception as exc:MODEL_ERROR=str(exc)
def db():
    c=sqlite3.connect(DB,timeout=10);c.row_factory=sqlite3.Row;c.execute('PRAGMA journal_mode=WAL');return c
with db() as c:
    c.execute('CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,workspace_id TEXT,status TEXT,progress REAL,config TEXT,result TEXT,error TEXT,cancel INTEGER DEFAULT 0,created_at TEXT)')
    c.execute("UPDATE jobs SET status='failed',error='Feed interrupted by worker restart; start a new camera session' WHERE status IN ('running','processing') AND json_extract(config,'$.feedAlias') IS NOT NULL")
    c.execute("UPDATE jobs SET status='queued' WHERE status IN ('running','processing')")
def execute(job_id):
    with db() as c:
        row=c.execute('SELECT * FROM jobs WHERE id=?',(job_id,)).fetchone();config=json.loads(row['config']);c.execute("UPDATE jobs SET status='processing' WHERE id=?",(job_id,))
    def cancelled():
        with db() as c:return bool(c.execute('SELECT cancel FROM jobs WHERE id=?',(job_id,)).fetchone()[0])
    def progress(x):
        with db() as c:c.execute('UPDATE jobs SET progress=? WHERE id=?',(x,job_id))
    try:
        if not MODEL:raise ValueError(MODEL_ERROR)
        source=ROOT/(job_id+'.mp4')
        if config.get('feedAlias'):
            # Configuration is operator-owned, never a browser-supplied URL. Secret stream URLs are not returned or logged.
            feeds=json.loads(Path(os.environ['FORESIGHT_CAMERA_FEEDS_FILE']).read_text());source=feeds[config['feedAlias']]['url']
        config['evidenceDirectory']=str(ROOT/'evidence');result=process(MODEL,source,config,progress,cancelled)
        callback=os.environ.get('FORESIGHT_INGEST_URL','http://127.0.0.1:3000/api/vision/events')
        outcomes=[]
        for event in result.get('events',[]):
            payload={k:v for k,v in event.items() if k not in ['startSeconds','endSeconds','eventId']}
            payload['eventId']=event['eventId']
            req=urllib.request.Request(callback,data=json.dumps({'jobId':job_id,'event':payload}).encode(),headers={'Content-Type':'application/json','X-Job-Token':config['callbackToken']})
            try:
                with urllib.request.urlopen(req,timeout=10) as response:outcomes.append({'eventId':event['eventId'],'status':response.status})
            except Exception:outcomes.append({'eventId':event['eventId'],'status':'pending-retry'})
        result['ingestion']=outcomes
        with db() as c:c.execute('UPDATE jobs SET status=?,progress=?,result=? WHERE id=?',(result['status'],1 if result['status']=='completed' else 0,json.dumps(result),job_id))
    except Exception as exc:
        with db() as c:c.execute("UPDATE jobs SET status='failed',error=? WHERE id=?",(str(exc)[:300],job_id))
    finally:
        # Keep minimal blurred evidence; uploaded raw footage is deleted after processing.
        (ROOT/(job_id+'.mp4')).unlink(missing_ok=True)
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def authorized(self):return hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+TOKEN)
    def send(self,status,data,content_type='application/json'):
        body=data if isinstance(data,bytes) else json.dumps(data).encode();self.send_response(status);self.send_header('Content-Type',content_type);self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(body)
    def do_GET(self):
        if not self.authorized():return self.send(401,{'error':'Worker credential required'})
        if self.path=='/health':return self.send(200,{'status':'ready' if MODEL else 'unavailable','reason':None if MODEL else 'Licensed model is missing or failed validation; run the administrator model check','runtime':'onnxruntime-cpu','modelId':MODEL.manifest['modelId'] if MODEL else None})
        parts=self.path.strip('/').split('/');job_id=parts[1] if len(parts)>1 else ''
        with db() as c:row=c.execute('SELECT * FROM jobs WHERE id=? AND workspace_id=?',(job_id,self.headers.get('X-Workspace-Id',''))).fetchone()
        if not row:return self.send(404,{'error':'Job not found'})
        if len(parts)==4 and parts[2]=='frames':
            fid=parts[3];result=json.loads(row['result']) if row['result'] else {};allowed={f for e in result.get('events',[]) for f in e['frameIds']} | {f['frameId'] for f in result.get('findings',[])}
            if fid not in allowed:return self.send(404,{'error':'Frame not referenced by this job'})
            filename=ROOT/'evidence'/result['sessionId']/(fid+'.jpg')
            if filename.is_file() and filename.stat().st_mtime<time.time()-7*86400:filename.unlink()
            if not filename.is_file():return self.send(404,{'error':'Evidence expired or unavailable'})
            return self.send(200,filename.read_bytes(),'image/jpeg')
        return self.send(200,{'id':job_id,'status':row['status'],'progress':row['progress'],'error':row['error'],'result':json.loads(row['result']) if row['result'] else None})
    def do_POST(self):
        if not self.authorized():return self.send(401,{'error':'Worker credential required'})
        if not MODEL:return self.send(503,{'error':'Compatible licensed PPE model is unavailable; ask the administrator to validate the manifest and weights'})
        if self.path!='/jobs':return self.send(404,{'error':'Unknown path'})
        self.connection.settimeout(30)
        try:size=int(self.headers.get('Content-Length',0))
        except ValueError:return self.send(422,{'error':'Invalid clip size'})
        if size<16 or size>50*1024*1024:return self.send(413,{'error':'MP4 size must be 16 bytes–50 MB'})
        filename=None
        try:
            config=json.loads(base64.b64decode(self.headers.get('X-Job-Config',''),validate=True));job_id=config['id'];uuid.UUID(job_id)
            if not config.get('feedAlias') and config.get('consent') is not True:raise ValueError('Consent required')
            if not 0<float(config.get('inferenceFps',5))<=10 or not 0<float(config.get('maxSeconds',120))<=120:raise ValueError('Invalid processing budget')
            if config.get('required')!=['helmet','vest'] or len(config.get('callbackToken',''))<32:raise ValueError('Invalid PPE policy or callback credential')
            datetime.fromisoformat(config['timeOrigin'].replace('Z','+00:00'))
            if config['workspaceId']!=self.headers.get('X-Workspace-Id'):return self.send(403,{'error':'Workspace mismatch'})
            if config.get('feedAlias') and not os.environ.get('FORESIGHT_CAMERA_FEEDS_FILE'):return self.send(422,{'error':'Camera feed alias is not configured'})
            with db() as c:
                existing=c.execute('SELECT * FROM jobs WHERE id=?',(job_id,)).fetchone()
                if existing:return self.send(409,{'error':'Job already exists'})
                if c.execute("SELECT count(*) FROM jobs WHERE status IN ('queued','running','processing')").fetchone()[0]>=3:return self.send(429,{'error':'Vision queue full'})
            header=self.rfile.read(16)
            if header[4:8]!=b'ftyp':return self.send(422,{'error':'MP4 container header required'})
            filename=ROOT/(job_id+'.mp4')
            with filename.open('xb') as f:
                f.write(header);remaining=size-16
                while remaining:
                    chunk=self.rfile.read(min(1024*1024,remaining))
                    if not chunk:raise ValueError('Truncated upload')
                    f.write(chunk);remaining-=len(chunk)
            with db() as c:c.execute('INSERT INTO jobs(id,workspace_id,status,progress,config,created_at) VALUES(?,?,?,?,?,?)',(job_id,config['workspaceId'],'queued',0,json.dumps(config),datetime.now(timezone.utc).isoformat()))
            POOL.submit(execute,job_id);return self.send(202,{'id':job_id,'status':'queued'})
        except Exception:
            if filename:filename.unlink(missing_ok=True)
            return self.send(422,{'error':'Invalid bounded video job; check MP4, consent, recording time and processing limits'})
def purge_expired():
    cutoff=time.time()-7*86400
    for p in (ROOT/'evidence').rglob('*.jpg') if (ROOT/'evidence').exists() else []:
        if p.stat().st_mtime<cutoff:p.unlink()
if __name__=='__main__':
    purge_expired()
    def housekeeping():
        while True:
            time.sleep(3600);purge_expired()
    threading.Thread(target=housekeeping,daemon=True).start()
    if MODEL:
        with db() as c:
            for row in c.execute("SELECT id FROM jobs WHERE status='queued'").fetchall():POOL.submit(execute,row['id'])
    print('Vision worker: http://127.0.0.1:8200; '+('model ready' if MODEL else 'model unavailable'),flush=True)
    ThreadingHTTPServer((os.environ.get('FORESIGHT_VISION_HOST','127.0.0.1'),int(os.environ.get('FORESIGHT_VISION_PORT','8200'))),Handler).serve_forever()
