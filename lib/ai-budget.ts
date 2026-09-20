import { get, head, put, BlobPreconditionFailedError } from '@vercel/blob';

// Global daily cap across all public visitors and server instances. Failed model calls count.
export async function reserveAiRequest() {
  if (!process.env.VERCEL) return true;
  const pathname = `minetech/ai-usage/${new Date().toISOString().slice(0, 10)}.json`;
  for (let attempt = 0; attempt < 4; attempt++) {
    let count = 0;
    let etag: string | undefined;
    const result = await get(pathname, { access: 'private', useCache: false });
    if (result) {
      if (result.statusCode !== 200 || !result.stream) throw new Error('Usage counter unavailable.');
      const data = await new Response(result.stream).json();
      if (!Number.isInteger(data.count) || data.count < 0) throw new Error('Invalid usage counter.');
      count = data.count;
      const metadata = await head(pathname);
      if (result.blob.etag.replace(/^W\//, '') !== metadata.etag) continue;
      etag = metadata.etag;
    }
    if (count >= 30) return false;
    try {
      await put(pathname, JSON.stringify({ count: count + 1 }), { access: 'private', addRandomSuffix: false, contentType: 'application/json', ...(etag ? { ifMatch: etag } : { allowOverwrite: false }) });
      return true;
    } catch (error) { if (!(error instanceof BlobPreconditionFailedError)) throw error; }
  }
  throw new Error('Usage counter busy.');
}
