import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { assertClipPath } from "@/lib/server/vision";
import { context } from "@/lib/server/auth";
import { assertAssetPath } from "@/lib/server/assets";
import { jsonBody } from "@/lib/server/http";
import { DomainError, useBudget } from "@/lib/server/repository";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const body = (await jsonBody(request, 10000)) as HandleUploadBody;
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname) => {
        const ctx = await context(request, "review");
        const clip = pathname.startsWith("clips/");
        if (clip) assertClipPath(ctx, pathname);
        else assertAssetPath(ctx, pathname);
        await useBudget(ctx, "asset-uploads", 10);
        return {
          allowedContentTypes: clip ? ["video/mp4"] : ["model/gltf-binary"],
          maximumSizeInBytes: (clip ? 50 : 20) * 1024 * 1024,
          validUntil: Date.now() + 5 * 60000,
          addRandomSuffix: false,
          allowOverwrite: false,
        };
      },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        message:
          error instanceof DomainError
            ? error.message
            : "Private upload unavailable.",
      },
      { status: error instanceof DomainError ? error.status : 503 },
    );
  }
}
