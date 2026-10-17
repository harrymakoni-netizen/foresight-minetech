# Captured area reconstruction

No captured asset is distributed in this repository. The import workflow supports an independently produced **GLB 2.0 mesh**, with embedded buffers/textures, through Three.js GLTFLoader (version pinned by package-lock). A Gaussian splat viewer is not yet integrated. Do not rename a splat PLY to GLB, USDZ or a mesh format.

1. Obtain capture permission and record location/proxy environment, author, date, licence/consent, phone model and original footage checksum. Avoid workers and personal information. A corridor or training room is a proxy, not an underground pilot.
2. Capture slow overlapping footage with stable exposure and textured surfaces. Place measured reference markers; record at least three non-collinear points and their measurement uncertainty in the site coordinate system.
3. On a machine with an appropriate GPU and a separately installed, version-recorded Nerfstudio/COLMAP toolchain:

```sh
ffmpeg -i consented-capture.mp4 -vf fps=2 frames/frame-%06d.jpg
# Review frames and remove blur, duplicates and people before pose estimation.
ns-process-data images --data frames --output-dir capture-poses
ns-train splatfacto --data capture-poses
ns-export gaussian-splat --load-config outputs/PROJECT/splatfacto/RUN/config.yml --output-dir exported-splat
```

Record actual `ffmpeg`, COLMAP, CUDA and Nerfstudio versions and hardware. These commands are a documented offline pipeline, **not executed or verified in this environment**. Confirm flags in the installed tool versions before a costly run. GPU training and site footage are external dependencies. No paid service is provisioned by this project.

Splatfacto's Gaussian-splat export represents view-dependent captured surfaces. It does not provide a built-in mesh export. To use the currently implemented browser import, independently reconstruct a mesh (for example with a version-recorded COLMAP dense workflow or a suitable licensed photogrammetry tool), clean it, and export self-contained GLB using Blender or another real converter. Review geometry and keep a separate collision mesh if needed.

4. Fit a rigid/similarity transform from measured reference correspondences. Store metres per source unit, translation in metres, XYZ rotation in radians, datum, capture date and registration residuals. Preserve source and transformed assets independently. The import accepts this metadata, but the normal UI initially imports as **unverified walkthrough**, with dimensions disabled.
5. Import in Mine Map → Import a captured reconstruction. Scope the area to a zone, record provenance and capture permission. The server validates actual GLB headers, declared length, mesh presence, size and embedded resources. A role-controlled API accepts measured registration metadata once genuinely reviewed.
6. Review retained surfaces, gaps, asset size and registration error with a competent reviewer. Never infer geology, structural stability, hidden geometry or safe passage from appearance. The manually checked versioned route graph remains authoritative for the software model.

Evidence annotations are zone-scoped alongside the viewer. True calibrated 3D marker placement and a Gaussian-splat viewer remain outstanding; no global camera/person positions are fabricated.
