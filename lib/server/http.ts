import { DomainError } from "./repository.ts";
export async function boundedBody(request: Request, maximum: number) {
  if (Number(request.headers.get("content-length")) > maximum)
    throw new DomainError(
      413,
      "SIZE_LIMIT",
      "Request exceeds the configured size limit.",
    );
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new DomainError(
          413,
          "SIZE_LIMIT",
          "Request exceeds the configured size limit.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export async function jsonBody(
  request: Request,
  maximum = 200000,
): Promise<unknown> {
  try {
    return JSON.parse((await boundedBody(request, maximum)).toString("utf8"));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(400, "JSON", "Invalid JSON.");
  }
}
export async function formBody(request: Request, maximum: number) {
  return new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: await boundedBody(request, maximum),
  }).formData();
}
