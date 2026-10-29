"""Blender 4.5 CLI converter for an actual reconstructed PLY mesh; no geometry is invented."""
import sys
from pathlib import Path
import bpy
args=sys.argv[sys.argv.index('--')+1:]
if len(args)!=2:raise SystemExit('Usage: blender --background --python export_glb.py -- reconstructed.ply captured.glb')
source,destination=map(lambda value:Path(value).resolve(),args)
if not source.is_file() or source.suffix.lower()!='.ply' or destination.suffix.lower()!='.glb':raise SystemExit('Supply an existing PLY mesh and GLB destination')
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
bpy.ops.wm.ply_import(filepath=str(source))
meshes=[obj for obj in bpy.context.scene.objects if obj.type=='MESH' and len(obj.data.polygons)>0]
if not meshes:raise SystemExit('Capture export has no mesh faces; reconstruct a surface first. Point clouds cannot be renamed into meshes.')
bpy.ops.export_scene.gltf(filepath=str(destination),export_format='GLB',export_draco_mesh_compression_enable=False)
print(f'Exported captured source mesh to {destination}; scale/coverage still require review')
