# Capture → reconstruct → import a real visual surface

No captured asset is supplied. The browser supports self-contained **GLB 2.0 meshes**, not raw point clouds or Gaussian splats. These reproducible commands describe an offline toolchain; they have **not been executed on a real capture here**. They cannot reconstruct unseen or unexcavated parts of a mine.

1. Obtain permission for the actual location and imagery. Record owner/operator, date/time/timezone, permitted use/licence, device, original-file SHA-256, captured coverage and known gaps. Prefer a consenting training area without people or personal information. A corridor proxy must be labelled a corridor proxy, not a mine pilot. Follow the site's own access/capture rules.
2. Capture slow footage with stable exposure, textured surfaces and high overlap from multiple viewpoints. Avoid blur, repeated identical frames, moving objects and reflective/dark surfaces. Retain a separate record of measured reference lengths and at least three non-collinear control points with measurement uncertainty if scale registration is intended. Image-only geometry starts unscaled; do not guess metres per unit.
3. On an appropriate workstation install/version-record FFmpeg, **COLMAP 3.11.1** (CUDA-capable build for dense stereo) and **Blender 4.5 LTS**. Retain their actual version output, GPU/driver version and command log. Verify flags with the installed command's `-h` if using another release. Processing can require substantial disk/GPU resources; no paid service is provisioned here.

From a new, private capture directory:

```sh
mkdir -p frames sparse dense
ffmpeg -i consented-capture.mp4 -vf fps=2 -q:v 2 frames/frame-%06d.jpg
# Manually remove blurred/duplicate frames and any frames lacking capture permission.
colmap feature_extractor --database_path capture.db --image_path frames --ImageReader.single_camera 1 --SiftExtraction.use_gpu 1
colmap exhaustive_matcher --database_path capture.db --SiftMatching.use_gpu 1
colmap mapper --database_path capture.db --image_path frames --output_path sparse
# Confirm sparse/0 exists and registered coverage is credible before proceeding.
colmap image_undistorter --image_path frames --input_path sparse/0 --output_path dense --output_type COLMAP
colmap patch_match_stereo --workspace_path dense --workspace_format COLMAP --PatchMatchStereo.geom_consistency true
colmap stereo_fusion --workspace_path dense --workspace_format COLMAP --input_type geometric --output_path dense/fused.ply
colmap poisson_mesher --input_path dense/fused.ply --output_path dense/surface.ply
# Inspect/remove unsupported filled surfaces; Poisson can bridge unobserved gaps.
# Export a self-contained mesh with the real converter supplied alongside this file:
blender --background --python /absolute/repository/tools/reconstruction/export_glb.py -- dense/surface.ply captured-area.glb
sha256sum consented-capture.mp4 captured-area.glb
```

If reconstruction fails, report that failure and retain the 2D fallback. Do not substitute a procedural tunnel. Poisson surface completion is an algorithmic guess; remove or explicitly record unsupported bridges and holes. Review the output in Blender, clean unrelated surfaces, and reduce mesh density if necessary for the **20 MB** import limit. This basic PLY pipeline produces a mesh; it does not promise photographic textures. If using another licensed photogrammetry tool, export GLB with embedded PNG/JPEG textures and record its method/version/settings. Export dense accessors (sparse accessor layouts are rejected). Disable Draco, meshopt and KTX2 compression, since this viewer does not fetch external decoders.

4. Record the reconstruction method, exact software versions/settings, source hashes, capture date, actual registered-image coverage, exclusions, licence/permission, holes and surface-completion limitations. Do not imply coverage of spaces absent from the images. Optionally fit a rigid/similarity transform using independently measured correspondences; retain the original and transformed assets, datum, metres per unit, XYZ rotation/translation, residuals and measurement uncertainty.
5. In **Mine Map → Reconstructed area → Import a captured reconstruction**, choose the zone and enter the actual title, source/permission reference, capture timestamp, reconstruction method/version and coverage/gaps. Confirm permission and import the GLB. The ordinary UI stores **scale unverified**, with no dimensional calculations. The authenticated assets API also accepts genuinely reviewed measured registration metadata with reference notes and residuals. Marking scale measured still does not establish tunnel clearance or route safety.
6. Check loading/error status, orbit, zoom and reset view. Inspect gaps with the capture owner. Preserve the 2D map fallback. Rendered visual surfaces, the reviewed route graph, and lumped simulation geometry stay separate. Appearance does not establish structural stability or safe passage.

The validator checks the actual GLB container, chunk bounds/alignment, embedded buffers/images, mesh positions and buffer-view bounds. This is file-format validation, **not proof of capture provenance, geometric accuracy or engineering suitability**. Gaussian-splat display and calibrated 3D evidence markers remain outside this workflow.
