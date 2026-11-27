import json,os,socket,subprocess,sys,tempfile,time,unittest,urllib.request,urllib.error
from .test_engine import fixture
class TransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();sock=socket.socket();sock.bind(('127.0.0.1',0));cls.port=sock.getsockname()[1];sock.close();cls.token='transport-test-worker-token';cls.process=subprocess.Popen([sys.executable,'-m','services.simulator.server'],env={**os.environ,'FORESIGHT_SIMULATOR_PORT':str(cls.port),'FORESIGHT_JOB_DATABASE':cls.temp.name+'/jobs.sqlite','FORESIGHT_WORKER_TOKEN':cls.token},stdout=subprocess.DEVNULL)
        for _ in range(50):
            try:cls.request('/health');break
            except Exception:time.sleep(.05)
    @classmethod
    def tearDownClass(cls):cls.process.terminate();cls.process.wait(timeout=5);cls.temp.cleanup()
    @classmethod
    def request(cls,path,body=None,workspace='test-workspace',token=None):
        request=urllib.request.Request(f'http://127.0.0.1:{cls.port}'+path,data=json.dumps(body).encode() if body is not None else None,headers={'Authorization':'Bearer '+(token or cls.token),'X-Workspace-Id':workspace,'Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=5) as response:return json.load(response)
    def test_authenticated_idempotent_job_and_scope(self):
        import uuid
        job_id=str(uuid.uuid4());body={'id':job_id,'scenario':fixture(hours=1)};self.request('/jobs',body);self.request('/jobs',body)
        for _ in range(50):
            result=self.request('/jobs/'+job_id)
            if result['status']=='completed':break
            time.sleep(.02)
        self.assertEqual(result['status'],'completed');self.assertTrue(result['result']['inputHash'])
        with self.assertRaises(urllib.error.HTTPError) as e:self.request('/jobs/'+job_id,workspace='other-workspace')
        self.assertEqual(e.exception.code,404)
        with self.assertRaises(urllib.error.HTTPError) as e:self.request('/health',token='wrong')
        self.assertEqual(e.exception.code,401)
    def test_restart_preserves_completed_results(self):
        import uuid
        job_id=str(uuid.uuid4());self.request('/jobs',{'id':job_id,'scenario':fixture(hours=1)})
        for _ in range(50):
            before=self.request('/jobs/'+job_id)
            if before['status']=='completed':break
            time.sleep(.02)
        cls=self.__class__;cls.process.terminate();cls.process.wait(timeout=5)
        cls.process=subprocess.Popen([sys.executable,'-m','services.simulator.server'],env={**os.environ,'FORESIGHT_SIMULATOR_PORT':str(cls.port),'FORESIGHT_JOB_DATABASE':cls.temp.name+'/jobs.sqlite','FORESIGHT_WORKER_TOKEN':cls.token},stdout=subprocess.DEVNULL)
        for _ in range(50):
            try:after=self.request('/jobs/'+job_id);break
            except Exception:time.sleep(.05)
        self.assertEqual(after['status'],'completed');self.assertEqual(before['result'],after['result'])
    def test_sensitivity_progress_and_cancel(self):
        import uuid
        scenario=fixture(hours=24);scenario['maxStepSeconds']=.05;scenario['events']=[{'type':'pump_availability','atSeconds':600,'pumpId':'P1','available':True}];job_id=str(uuid.uuid4());self.request('/jobs',{'id':job_id,'scenario':scenario,'sensitivity':{'samples':100,'seed':42,'inflowM3s':[.004,.006],'pumpCapacityM3s':[.002,.006],'backupDelaySeconds':[0,600]}});self.request('/jobs/'+job_id+'/cancel',{})
        for _ in range(100):
            result=self.request('/jobs/'+job_id)
            if result['status']=='cancelled':break
            time.sleep(.02)
        self.assertEqual(result['status'],'cancelled')
if __name__=='__main__':unittest.main()
