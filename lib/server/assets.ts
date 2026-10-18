import { get as getBlob, put, del } from "@vercel/blob";
import { lock } from "./db.ts";
import { formBody, jsonBody } from "./http.ts";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import {
  atomic,
  insert,
  get,
  list,
  DomainError,
  type Context,
} from "./repository.ts";
import { zoneId, instant } from "../domain/contracts.ts";
const metadataSchema = z
  .object({
    zoneId,
    title: z.string().min(3).max(140),
    source: z.string().min(3).max(1000),
    captureAt: instant,
    consent: z.literal(true),
    scaleStatus: z.enum(["unverified", "measured"]),
    metresPerUnit: z.number().positive().max(1000),
    translation: z.tuple([z.number(), z.number(), z.number()]),
    rotationRadians: z.tuple([z.number(), z.number(), z.number()]),
    registrationResidualM: z.number().min(0).nullable(),
    referenceNotes: z.string().min(3).max(2000),
  })
  .strict();
const directory = () =>
  path.join(
    path.dirname(
      process.env.FORESIGHT_DATABASE_PATH ||
        path.join(process.cwd(), ".minetech-data", "foresight.sqlite"),
    ),
    "evidence",
  );
export async function assetsPost(ctx: Context, request: Request) {
  let buffer: Buffer;
  let storageKey: string;
  let metadata: z.infer<typeof metadataSchema>;
  const cloud = Boolean(process.env.VERCEL);
  if (request.headers.get("content-type")?.includes("application/json")) {
    const body = z
      .object({ pathname: z.string(), metadata: metadataSchema })
      .strict()
      .parse(await jsonBody(request, 10000));
    metadata = body.metadata;
    storageKey = body.pathname;
    assertAssetPath(ctx, storageKey);
    if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID)
      throw new DomainError(
        503,
        "ASSET_STORAGE",
        "Private evidence storage is not configured.",
      );
    const blob = await getBlob(storageKey, {
      access: "private",
      useCache: false,
    });
    if (!blob || blob.statusCode !== 200)
      throw new DomainError(404, "ASSET_NOT_FOUND", "Uploaded mesh not found.");
    if (blob.blob.size > 20 * 1024 * 1024) {
      await blob.stream.cancel();
      throw new DomainError(413, "ASSET_SIZE", "GLB limit is 20 MB.");
    }
    buffer = Buffer.from(await new Response(blob.stream).arrayBuffer());
  } else {
    if (
      Number(request.headers.get("content-length")) >
      (cloud ? 4 : 21) * 1024 * 1024
    )
      throw new DomainError(
        413,
        "ASSET_SIZE",
        cloud
          ? "Use the direct upload control for files over 4 MB."
          : "GLB limit is 20 MB.",
      );
    const form = await formBody(request, (cloud ? 4 : 21) * 1024 * 1024),
      file = form.get("file");
    if (
      !(file instanceof File) ||
      file.size > 20 * 1024 * 1024 ||
      file.size < 20
    )
      throw new DomainError(
        422,
        "ASSET_FORMAT",
        "Choose a GLB file between 20 bytes and 20 MB.",
      );
    metadata = metadataSchema.parse(JSON.parse(String(form.get("metadata"))));
    buffer = Buffer.from(await file.arrayBuffer());
    storageKey = cloud
      ? `evidence/${ctx.workspaceId}/${randomUUID()}.glb`
      : randomUUID() + ".glb";
  }
  if (buffer.length < 20 || buffer.length > 20 * 1024 * 1024)
    throw new DomainError(
      422,
      "ASSET_FORMAT",
      "Choose a GLB file between 20 bytes and 20 MB.",
    );
  if (
    metadata.scaleStatus === "measured" &&
    (metadata.registrationResidualM === null ||
      metadata.referenceNotes.length < 20)
  )
    throw new DomainError(
      422,
      "REGISTRATION",
      "Measured scale needs residuals and reference notes.",
    );
  if (
    buffer.toString("ascii", 0, 4) !== "glTF" ||
    buffer.readUInt32LE(4) !== 2 ||
    buffer.readUInt32LE(8) !== buffer.length
  )
    throw new DomainError(
      422,
      "ASSET_FORMAT",
      "A valid GLB 2.0 container is required.",
    );
  const length = buffer.readUInt32LE(12);
  if (
    buffer.toString("ascii", 16, 20) !== "JSON" ||
    20 + length > buffer.length
  )
    throw new DomainError(422, "ASSET_FORMAT", "Invalid GLB JSON chunk.");
  let document: any;
  try {
    document = JSON.parse(buffer.toString("utf8", 20, 20 + length));
  } catch {
    throw new DomainError(422, "ASSET_FORMAT", "Invalid GLB document.");
  }
  if (document.asset?.version !== "2.0" || !document.meshes?.length)
    throw new DomainError(
      422,
      "ASSET_FORMAT",
      "A mesh in GLB 2.0 format is required. Gaussian splats need a separate supported viewer.",
    );
  if (
    [...(document.buffers || []), ...(document.images || [])].some(
      (x: any) => x.uri && !x.uri.startsWith("data:"),
    )
  )
    throw new DomainError(
      422,
      "ASSET_EXTERNAL",
      "External asset URLs are disabled. Embed all buffers and images.",
    );
  if (cloud) {
    if (!request.headers.get("content-type")?.includes("application/json"))
      await put(storageKey, buffer, {
        access: "private",
        contentType: "model/gltf-binary",
        addRandomSuffix: false,
        allowOverwrite: false,
      });
  } else {
    await mkdir(directory(), { recursive: true });
    await writeFile(path.join(directory(), storageKey), buffer, {
      flag: "wx",
      mode: 0o600,
    });
  }
  try {
    const asset = await atomic(async () => {
      await lock(`asset:${ctx.workspaceId}:${storageKey}`);
      const prior = (await list(ctx, "spatial-asset")).find(
        (a) => a.data.storageKey === storageKey,
      );
      if (prior) return prior;
      return await insert(
        ctx,
        "spatial-asset",
        {
          ...metadata,
          storageKey,
          storageBackend: cloud ? "private-blob" : "local",
          format: "glb-2.0",
          bytes: buffer.length,
          sha256: createHash("sha256").update(buffer).digest("hex"),
          viewer: "three-gltf",
          dimensionalCalculations: metadata.scaleStatus === "measured",
        },
        metadata.zoneId,
      );
    });
    return Response.json(asset, { status: 201 });
  } catch (error) {
    if (
      cloud &&
      !request.headers.get("content-type")?.includes("application/json")
    )
      await del(storageKey).catch(() => {});
    else if (!cloud)
      await unlink(path.join(directory(), storageKey)).catch(() => {});
    throw error;
  }
}
export async function assetsGet(ctx: Context, id: string) {
  const asset = await get(ctx, id, "spatial-asset");
  const storageKey = String(asset.data.storageKey);
  const headers = {
    "Content-Type": "model/gltf-binary",
    "Cache-Control": "private, no-store",
    "Content-Disposition": 'inline; filename="reconstruction.glb"',
    "X-Content-Type-Options": "nosniff",
  };
  if (asset.data.storageBackend === "private-blob") {
    assertAssetPath(ctx, storageKey);
    const blob = await getBlob(storageKey, { access: "private" });
    if (!blob || blob.statusCode !== 200)
      throw new DomainError(404, "ASSET_NOT_FOUND", "Mesh unavailable.");
    return new Response(blob.stream, { headers });
  }
  if (!/^[a-f0-9-]+\.glb$/.test(storageKey))
    throw new DomainError(422, "ASSET_KEY", "Invalid storage reference.");
  return new Response(await readFile(path.join(directory(), storageKey)), {
    headers,
  });
}
export function assertAssetPath(ctx: Context, pathname: string) {
  const prefix = `evidence/${ctx.workspaceId}/`;
  if (
    !pathname.startsWith(prefix) ||
    !/^[a-f0-9-]+\.glb$/.test(pathname.slice(prefix.length))
  )
    throw new DomainError(
      403,
      "ASSET_SCOPE",
      "The upload must belong to this workspace.",
    );
}
