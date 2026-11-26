"""Local persistent asynchronous worker. Bind loopback; put behind authenticated TLS for hosting."""
from __future__ import annotations
import hmac,json,os,sqlite3,threading,time,uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from .engine import solve,validate,ValidationError
from .ensemble import ensemble,validate_ranges

TOKEN=(os.environ.get('FORESIGHT_WORKER_TOKEN') or 'development-worker-token')
if os.environ.get('FORESIGHT_ENV')=='production' and (TOKEN=='development-worker-token' or len(TOKEN)<32):raise RuntimeError('Set a strong worker token')
DB=os.environ.get('FORESIGHT_JOB_DATABASE','.minetech-data/simulator-jobs.sqlite')
Path(DB).parent.mkdir(parents=True,exist_ok=True)
LOCK=threading.RLock();POOL=ThreadPoolExecutor(max_workers=2)

def db():
    connection=sqlite3.connect(DB,timeout=10);connection.row_factory=sqlite3.Row;connection.execute('PRAGMA journal_mode=WAL');return connection
with db() as c:
    c.execute('CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,status TEXT NOT NULL,progress REAL NOT NULL,input TEXT NOT NULL,result TEXT,error TEXT,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,cancel INTEGER NOT NULL DEFAULT 0)')
    c.execute("UPDATE jobs SET status='queued',progress=0 WHERE status='running'")
def _escape(data,cancelled):
    # Imported lazily: the escape engine needs the simulation-worker environment
    # (requirements-sim.txt); the stdlib water engine keeps working without it.
    from .escape import run
    return run(data,cancelled)
def _escape_validate(data):
    from .escape import validate as v
    v(data)
def _chain(data,cancelled):
    from .scenario_chain import run_chain
    return run_chain(data,cancelled)
def _tta(data,cancelled):
    from .scenario_chain import time_to_act
    return time_to_act(data,cancelled)
def _chain_validate(data):
    from .scenario_chain import water_scenario
    from .escape import validate as v
    water_scenario(data)
    v({'network':data['network'],'people':data['people'],'closures':[],'params':data['params']})
def _tta_validate(data):
    if not 0<=float(data['fromSeconds'])<=float(data['toSeconds']) or float(data['stepSeconds'])<=0:raise ValueError('Invalid search interval')
    _chain_validate(data['chain'])
def _cage(data,cancelled):
    from .cage import run
    return run(data,cancelled)
def _cage_validate(data):
    from .cage import validate as v
    v(data)
EXTENDED={'escape':_escape,'escape-chain':_chain,'time-to-act':_tta,'cage':_cage}
VALIDATORS={'escape':_escape_validate,'escape-chain':_chain_validate,'time-to-act':_tta_validate,'cage':_cage_validate}
def extended_available():
    try:
        import jupedsim,shapely,networkx  # noqa: F401
        return True
    except ImportError:return False
def now():return datetime.now(timezone.utc).isoformat()
def execute(job_id):
    with db() as c:
        row=c.execute('SELECT * FROM jobs WHERE id=?',(job_id,)).fetchone()
        if not row or row['status']!='queued':return
        if row['cancel']:c.execute("UPDATE jobs SET status='cancelled',finished_at=? WHERE id=?",(now(),job_id));return
        c.execute("UPDATE jobs SET status='running',started_at=? WHERE id=?",(now(),job_id))
    def cancelled():
        with db() as c:return bool(c.execute('SELECT cancel FROM jobs WHERE id=?',(job_id,)).fetchone()[0])
    def progress(value):
        with db() as c:c.execute('UPDATE jobs SET progress=? WHERE id=?',(value,job_id))
    try:
        payload=json.loads(row['input'])
        if payload.get('kind') in EXTENDED:result=EXTENDED[payload['kind']](payload['input'],cancelled)
        else:result=ensemble(payload['scenario'],payload['sensitivity'],cancelled,progress) if 'sensitivity' in payload else solve(payload,cancelled,progress)
        with db() as c:c.execute('UPDATE jobs SET status=?,progress=?,result=?,finished_at=? WHERE id=?',(result['status'],1 if result['status']=='completed' else result.get('progress',0),json.dumps(result,allow_nan=False),now(),job_id))
    except Exception as exc:
        with db() as c:c.execute("UPDATE jobs SET status='failed',error=?,finished_at=? WHERE id=?",(str(exc)[:500],now(),job_id))
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def send(self,status,data):
        body=json.dumps(data,allow_nan=False).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(body)
    def authorized(self):return hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+TOKEN)
    def do_GET(self):
        # Unauthenticated liveness for hosting platforms (Render). Reveals nothing.
        if self.path=='/healthz':return self.send(200,{'status':'ok'})
        if not self.authorized():return self.send(401,{'error':'Worker credential required'})
        if self.path=='/health':return self.send(200,{'status':'ready','model':'lumped-water-1.0.0','persistentJobs':True,'engines':['lumped-water-1.0.0']+(['escape-jupedsim-1.0.0','flood-escape-chain-1.0.0','time-to-act-scan-1.0.0','cage-simpy-1.0.0'] if extended_available() else [])})
        job_id=self.path.removeprefix('/jobs/')
        with db() as c:row=c.execute('SELECT * FROM jobs WHERE id=? AND workspace_id=?',(job_id,self.headers.get('X-Workspace-Id',''))).fetchone()
        if not row:return self.send(404,{'error':'Job not found'})
        data={k:row[k] for k in ('id','status','progress','error','created_at','started_at','finished_at')};data['result']=json.loads(row['result']) if row['result'] else None
        if row['started_at']:data['queueMs']=(datetime.fromisoformat(row['started_at'])-datetime.fromisoformat(row['created_at'])).total_seconds()*1000
        return self.send(200,data)
    def do_POST(self):
        if not self.authorized():return self.send(401,{'error':'Worker credential required'})
        size=int(self.headers.get('Content-Length',0))
        if not 0 < size <= 2000000:return self.send(413,{'error':'Body limit exceeded'})
        try:body=json.loads(self.rfile.read(size))
        except ValueError:return self.send(400,{'error':'Invalid JSON'})
        if self.path.endswith('/cancel'):
            job_id=self.path.split('/')[-2]
            with db() as c:
                row=c.execute('SELECT * FROM jobs WHERE id=? AND workspace_id=?',(job_id,self.headers.get('X-Workspace-Id',''))).fetchone()
                if not row:return self.send(404,{'error':'Job not found'})
                c.execute('UPDATE jobs SET cancel=1 WHERE id=?',(job_id,))
            return self.send(200,{'id':job_id,'cancelRequested':True})
        if self.path!='/jobs':return self.send(404,{'error':'Unknown path'})
        if body.get('kind') in EXTENDED:
            if not extended_available():return self.send(503,{'error':'Escape engine dependencies are not installed on this worker'})
            try:VALIDATORS[body['kind']](body.get('input'))
            except (ValueError,KeyError,TypeError) as exc:return self.send(422,{'error':str(exc)})
            if body.get('workspaceId')!=self.headers.get('X-Workspace-Id'):return self.send(403,{'error':'Workspace mismatch'})
            return self.enqueue(body.get('id'),body['workspaceId'],json.dumps({'kind':body['kind'],'input':body['input']},sort_keys=True))
        try:
            validate(body['scenario'])
            if body.get('sensitivity'):validate_ranges(body['scenario'],body['sensitivity'])
        except (ValidationError,KeyError,TypeError) as exc:return self.send(422,{'error':str(exc)})
        workspace=body['scenario']['workspaceId']
        if workspace!=self.headers.get('X-Workspace-Id'):return self.send(403,{'error':'Workspace mismatch'})
        return self.enqueue(body.get('id'),workspace,json.dumps({'scenario':body['scenario'],'sensitivity':body['sensitivity']} if body.get('sensitivity') else body['scenario'],sort_keys=True))
    def enqueue(self,job_id,workspace,raw):
        try:uuid.UUID(job_id)
        except (ValueError,TypeError,AttributeError):return self.send(422,{'error':'UUID job ID required'})
        with db() as c:
            previous=c.execute('SELECT * FROM jobs WHERE id=?',(job_id,)).fetchone()
            if previous:
                if previous['workspace_id']!=workspace or previous['input']!=raw:return self.send(409,{'error':'Conflicting job ID'})
                return self.send(200,{'id':job_id,'status':previous['status']})
            count=c.execute("SELECT count(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]
            if count>=10:return self.send(429,{'error':'Worker queue full'})
            c.execute('INSERT INTO jobs(id,workspace_id,status,progress,input,created_at) VALUES(?,?,?,?,?,?)',(job_id,workspace,'queued',0,raw,now()))
        POOL.submit(execute,job_id);return self.send(202,{'id':job_id,'status':'queued'})
if __name__=='__main__':
    with db() as c:
        for row in c.execute("SELECT id FROM jobs WHERE status='queued'").fetchall():POOL.submit(execute,row['id'])
    host=os.environ.get('FORESIGHT_SIMULATOR_HOST','127.0.0.1');port=int(os.environ.get('FORESIGHT_SIMULATOR_PORT','8100'))
    print(f'Simulator worker: http://{host}:{port} (authenticated, persistent jobs)',flush=True)
    ThreadingHTTPServer((host,port),Handler).serve_forever()
