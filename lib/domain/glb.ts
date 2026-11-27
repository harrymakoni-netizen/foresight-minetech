// Structural validation only: a valid mesh says nothing about capture authenticity or mine safety.
export function validateGlb(buffer: Buffer) {
  if (
    buffer.length < 20 ||
    buffer.length > 20 * 1024 * 1024 ||
    buffer.toString("ascii", 0, 4) !== "glTF" ||
    buffer.readUInt32LE(4) !== 2 ||
    buffer.readUInt32LE(8) !== buffer.length
  )
    throw new Error("A self-contained GLB 2.0 file up to 20 MB is required.");
  let offset = 12,
    document: any,
    binaryBytes = 0,
    chunks = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length)
      throw new Error("Truncated GLB chunk header.");
    const size = buffer.readUInt32LE(offset),
      type = buffer.readUInt32LE(offset + 4);
    if (size % 4 || offset + 8 + size > buffer.length)
      throw new Error("Invalid GLB chunk alignment or length.");
    if (chunks === 0) {
      if (type !== 0x4e4f534a)
        throw new Error("GLB must begin with a JSON chunk.");
      document = JSON.parse(
        buffer.toString("utf8", offset + 8, offset + 8 + size),
      );
    } else {
      if (chunks !== 1 || type !== 0x004e4942)
        throw new Error("Only one embedded binary chunk is supported.");
      binaryBytes = size;
    }
    offset += size + 8;
    chunks++;
  }
  if (document?.asset?.version !== "2.0" || !document.meshes?.length)
    throw new Error(
      "GLB must contain a mesh; splat files need a separate viewer.",
    );
  for (const item of [
    ...(document.buffers || []),
    ...(document.images || []),
  ]) {
    if (item.uri && !/^data:[^,]+;base64,/.test(item.uri))
      throw new Error(
        "External resource URLs are disabled; embed every image and buffer.",
      );
  }
  if (
    (document.extensionsRequired || []).some((x: string) =>
      [
        "KHR_draco_mesh_compression",
        "EXT_meshopt_compression",
        "KHR_texture_basisu",
      ].includes(x),
    )
  )
    throw new Error(
      "Export an uncompressed mesh with embedded PNG/JPEG textures; this viewer has no external decoder.",
    );
  for (const [i, b] of (document.buffers || []).entries()) {
    if (
      !Number.isInteger(b.byteLength) ||
      b.byteLength < 0 ||
      (!b.uri &&
        (i !== 0 ||
          b.byteLength > binaryBytes ||
          binaryBytes - b.byteLength > 3))
    )
      throw new Error("Embedded buffer size is invalid.");
  }
  for (const v of document.bufferViews || []) {
    const b = document.buffers?.[v.buffer],
      start = v.byteOffset || 0;
    if (
      !b ||
      !Number.isInteger(start) ||
      start < 0 ||
      !Number.isInteger(v.byteLength) ||
      v.byteLength < 0 ||
      start + v.byteLength > b.byteLength
    )
      throw new Error("Buffer view extends outside its declared buffer.");
  }
  const widths: Record<number, number> = {
    5120: 1,
    5121: 1,
    5122: 2,
    5123: 2,
    5125: 4,
    5126: 4,
  };
  const sizes: Record<string, number> = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16,
  };
  for (const a of document.accessors || []) {
    if (a.sparse)
      throw new Error(
        "Export dense mesh accessors; sparse accessor decoding is not supported by this validator.",
      );
    const view = document.bufferViews?.[a.bufferView],
      bytes = widths[a.componentType],
      components = sizes[a.type];
    const start = a.byteOffset || 0,
      stride = view?.byteStride || bytes * components;
    if (
      !view ||
      !bytes ||
      !components ||
      !Number.isInteger(a.count) ||
      a.count < 1 ||
      !Number.isInteger(start) ||
      start < 0 ||
      !Number.isInteger(stride) ||
      stride < bytes * components ||
      start + (a.count - 1) * stride + bytes * components > view.byteLength
    )
      throw new Error(
        "Mesh accessor exceeds its embedded buffer view or has an unsupported layout.",
      );
  }
  for (const mesh of document.meshes) {
    if (!mesh.primitives?.length)
      throw new Error("Mesh contains no primitives.");
    for (const p of mesh.primitives) {
      const a = document.accessors?.[p.attributes?.POSITION];
      if (!a || a.type !== "VEC3" || !Number.isInteger(a.count) || a.count < 1)
        throw new Error("Mesh needs position vertices.");
    }
  }
  return document;
}
