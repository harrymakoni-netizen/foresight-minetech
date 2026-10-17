import { formBody } from "./http.ts";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import {
  atomic,
  insert,
  get,
  hash,
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
  if (Number(request.headers.get("content-length")) > 21 * 1024 * 1024)
    throw new DomainError(413, "ASSET_SIZE", "GLB limit is 20 MB.");
  const form = await formBody(request, 21 * 1024 * 1024),
    file = form.get("file");
  if (!(file instanceof File) || file.size > 20 * 1024 * 1024 || file.size < 20)
    throw new DomainError(
      422,
      "ASSET_FORMAT",
      "Choose a GLB file between 20 bytes and 20 MB.",
    );
  const metadata = metadataSchema.parse(
    JSON.parse(String(form.get("metadata"))),
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
  const buffer = Buffer.from(await file.arrayBuffer());
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
  const storageKey = randomUUID() + ".glb";
  await mkdir(directory(), { recursive: true });
  await writeFile(path.join(directory(), storageKey), buffer, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    const asset = atomic(() =>
      insert(
        ctx,
        "spatial-asset",
        {
          ...metadata,
          storageKey,
          format: "glb-2.0",
          bytes: buffer.length,
          sha256: createHash("sha256").update(buffer).digest("hex"),
          viewer: "three-gltf",
          dimensionalCalculations: metadata.scaleStatus === "measured",
        },
        metadata.zoneId,
      ),
    );
    return Response.json(asset, { status: 201 });
  } catch (error) {
    await unlink(path.join(directory(), storageKey));
    throw error;
  }
}
export async function assetsGet(ctx: Context, id: string) {
  const asset = get(ctx, id, "spatial-asset");
  const storageKey = String(asset.data.storageKey);
  if (!/^[a-f0-9-]+\.glb$/.test(storageKey))
    throw new DomainError(422, "ASSET_KEY", "Invalid storage reference.");
  return new Response(await readFile(path.join(directory(), storageKey)), {
    headers: {
      "Content-Type": "model/gltf-binary",
      "Cache-Control": "private, no-store",
      "Content-Disposition": 'inline; filename="reconstruction.glb"',
      "X-Content-Type-Options": "nosniff",
    },
  });
}
