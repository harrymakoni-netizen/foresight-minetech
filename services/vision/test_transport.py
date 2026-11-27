"""HTTP/ONNX/video transport using an explicit mathematical fixture; NOT PPE validation."""
import base64,hashlib,json,os,socket,subprocess,sys,tempfile,time,unittest,urllib.request,urllib.error,uuid
from pathlib import Path
import cv2,numpy as np,onnx
from onnx import helper,TensorProto,numpy_helper

class VisionTransport(unittest.TestCase):
    def test_real_decode_queue_events_frames_scope_and_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);weights=root/'math-not-ppe.onnx'
            base=np.array([[[20,20,90,120,0,0],[35,22,65,40,0,3],[30,50,80,95,0,4]]],np.float32)
            mask=np.zeros_like(base);mask[:,:,4]=1
            graph=helper.make_graph([helper.make_node('ReduceMean',['image'],['mean'],keepdims=0),helper.make_node('Mul',['mean','mask'],['scores']),helper.make_node('Add',['base','scores'],['output'])],'MATH-NOT-PPE',[helper.make_tensor_value_info('image',TensorProto.FLOAT,[1,3,128,128])],[helper.make_tensor_value_info('output',TensorProto.FLOAT,[1,3,6])],[numpy_helper.from_array(base,'base'),numpy_helper.from_array(mask,'mask')])
            model=helper.make_model(graph,opset_imports=[helper.make_opsetid('',18)]);model.ir_version=10;onnx.save(model,weights)
            manifest={'modelId':'MATHEMATICAL-HTTP-TEST-NOT-PPE','weights':weights.name,'sha256':hashlib.sha256(weights.read_bytes()).hexdigest(),'source':'Authored arithmetic fixture, no trained detector','weightsLicense':'CC0 authored test graph','runtimeLicense':'MIT','licenseReviewedBy':'Test fixture author','inputSize':128,'outputFormat':'nms-xyxy','classMap':{'0':'person','1':'helmet','2':'vest','3':'no-helmet','4':'no-vest'},'preprocessing':{'layout':'NCHW','color':'RGB','normalization':'0..1','resize':'letterbox','padding':114,'coordinates':'input-pixels'}}
            manifest_path=root/'manifest.json';manifest_path.write_text(json.dumps(manifest))
            clip=root/'source.mp4';writer=cv2.VideoWriter(str(clip),cv2.VideoWriter_fourcc(*'mp4v'),10,(128,128));self.assertTrue(writer.isOpened())
            for _ in range(25):writer.write(np.full((128,128,3),255,np.uint8))
            writer.release();video=clip.read_bytes()
            with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
            token='fictional-transport-test-token-32-characters';env={**os.environ,'FORESIGHT_VISION_PORT':str(port),'FORESIGHT_VISION_DATA':str(root/'data'),'FORESIGHT_VISION_MANIFEST':str(manifest_path),'FORESIGHT_WORKER_TOKEN':token,'FORESIGHT_INGEST_URL':'http://127.0.0.1:1/api/vision/events'}
            server=subprocess.Popen([sys.executable,'-m','services.vision.server'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            url=f'http://127.0.0.1:{port}'
            def request(path,body=None,headers=None,workspace='fixture-workspace'):
                req=urllib.request.Request(url+path,data=body,headers={'Authorization':'Bearer '+token,'X-Workspace-Id':workspace,**(headers or {})})
                try:
                    with urllib.request.urlopen(req,timeout=5) as response:return response.status,response.read()
                except urllib.error.HTTPError as exc:return exc.code,exc.read()
            try:
                deadline=time.monotonic()+10
                while True:
                    try:status,raw=request('/health');break
                    except OSError:
                        if time.monotonic()>deadline:raise
                        time.sleep(.05)
                self.assertEqual(json.loads(raw)['status'],'ready')
                self.assertEqual(request('/health',headers={'Authorization':'Bearer invalid'})[0],401)
                job_id=str(uuid.uuid4());config={'id':job_id,'workspaceId':'fixture-workspace','cameraId':'fixture-camera','zoneId':'zone-b','timeOrigin':'2026-10-18T08:00:00Z','required':['helmet','vest'],'consent':True,'callbackToken':'test-scoped-callback-token-over-32-characters','maxSeconds':120,'inferenceFps':5}
                headers={'Content-Type':'video/mp4','X-Job-Config':base64.b64encode(json.dumps(config).encode()).decode()}
                status,raw=request('/jobs',video,headers);self.assertEqual(status,202,raw);self.assertEqual(json.loads(raw)['status'],'queued')
                deadline=time.monotonic()+10;states=[]
                while True:
                    status,raw=request('/jobs/'+job_id);job=json.loads(raw);states.append(job['status'])
                    if job['status'] in ['completed','failed']:break
                    self.assertLess(time.monotonic(),deadline);time.sleep(.05)
                self.assertEqual(job['status'],'completed',job.get('error'));self.assertTrue(set(states)<={'queued','processing','completed'})
                result=job['result'];self.assertEqual(len(result['events']),2)
                event=result['events'][0];self.assertGreaterEqual(event['endSeconds']-event['startSeconds'],1)
                self.assertEqual(len({e['eventId'] for e in result['events']}),2)
                frame=event['frameIds'][0];status,jpeg=request(f'/jobs/{job_id}/frames/{frame}');self.assertEqual(status,200);self.assertTrue(jpeg.startswith(b'\xff\xd8'))
                self.assertEqual(request('/jobs/'+job_id,workspace='other-workspace')[0],404)
                self.assertEqual(request(f'/jobs/{job_id}/frames/not-a-source-frame')[0],404)
                self.assertFalse((root/'data'/(job_id+'.mp4')).exists())
                bad={**config,'id':str(uuid.uuid4()),'consent':False};bad_headers={**headers,'X-Job-Config':base64.b64encode(json.dumps(bad).encode()).decode()}
                self.assertEqual(request('/jobs',video,bad_headers)[0],422)
                # A header-valid but undecodable clip must become failed, never completed.
                bad={**config,'id':str(uuid.uuid4())};bad_headers={**headers,'X-Job-Config':base64.b64encode(json.dumps(bad).encode()).decode()}
                self.assertEqual(request('/jobs',b'\x00\x00\x00\x10ftypisom'+b'\x00'*16,bad_headers)[0],202)
                deadline=time.monotonic()+5
                while True:
                    _,raw=request('/jobs/'+bad['id']);failed=json.loads(raw)
                    if failed['status']=='failed':break
                    self.assertLess(time.monotonic(),deadline);time.sleep(.05)
                self.assertIn('decode',failed['error'].lower())
            finally:server.terminate();server.wait(timeout=5)
if __name__=='__main__':unittest.main()
