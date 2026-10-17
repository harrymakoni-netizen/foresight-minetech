"""Runtime plumbing smoke: input-dependent mathematical ONNX graph, NOT a PPE detector."""
import hashlib,json,tempfile,unittest
from pathlib import Path
import numpy as np
import onnx
from onnx import helper,TensorProto,numpy_helper
import cv2
from .model import OnnxDetector
from .worker import process
class RuntimeSmoke(unittest.TestCase):
    def test_image_dependent_onnx_and_decoded_clip(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);weights=root/'math-smoke.onnx'
            # Whole-image mean controls confidence, so the adapter must actually process pixels.
            boxes=np.array([[[20,20,90,120,0,0],[35,22,65,40,0,1],[30,50,80,95,0,2]]],dtype=np.float32)
            base=boxes.copy();mask=np.zeros_like(boxes);mask[:,:,4]=1
            nodes=[helper.make_node('ReduceMean',['images'],['mean'],keepdims=0),helper.make_node('Mul',['mean','mask'],['scores']),helper.make_node('Add',['base','scores'],['output'])]
            graph=helper.make_graph(nodes,'mathematical_runtime_smoke',[helper.make_tensor_value_info('images',TensorProto.FLOAT,[1,3,128,128])],[helper.make_tensor_value_info('output',TensorProto.FLOAT,[1,3,6])],[numpy_helper.from_array(base,name='base'),numpy_helper.from_array(mask,name='mask')])
            model=helper.make_model(graph,opset_imports=[helper.make_opsetid('',18)]);model.ir_version=10;onnx.save(model,weights)
            manifest={'modelId':'MATHEMATICAL-SMOKE-NOT-PPE','weights':weights.name,'sha256':hashlib.sha256(weights.read_bytes()).hexdigest(),'weightsLicense':'CC0 synthetic mathematical fixture created in test','runtimeLicense':'MIT','licenseReviewedBy':'Codex: authored mathematical fixture only, not an external PPE model','source':'This test creates a mean-pixel arithmetic graph; not learned recognition','inputSize':128,'classMap':{'0':'person','1':'helmet','2':'vest'},'outputFormat':'nms-xyxy'}
            file=root/'manifest.json';file.write_text(json.dumps(manifest));detector=OnnxDetector(file)
            black,_=detector.detect(np.zeros((128,128,3),np.uint8));white,_=detector.detect(np.full((128,128,3),255,np.uint8));self.assertEqual(len(black),0);self.assertEqual({d['class'] for d in white},{'person','helmet','vest'})
            clip=root/'synthetic.mp4';writer=cv2.VideoWriter(str(clip),cv2.VideoWriter_fourcc(*'mp4v'),10,(128,128));self.assertTrue(writer.isOpened())
            for _ in range(25):writer.write(np.full((128,128,3),255,np.uint8))
            writer.release();result=process(detector,clip,{'workspaceId':'smoke','cameraId':'smoke-camera','zoneId':'zone-b','timeOrigin':'2026-10-17T10:00:00Z','evidenceDirectory':str(root/'evidence'),'required':['helmet','vest'],'maxSeconds':10});self.assertEqual(result['status'],'completed');self.assertGreaterEqual(result['metrics']['inferredFrames'],10);self.assertEqual(result['events'],[])
if __name__=='__main__':unittest.main()
