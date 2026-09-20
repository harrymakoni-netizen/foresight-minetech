import {readCloudState,saveCloudState,BlobPreconditionFailedError as CloudConflict} from './storage-cloud';
import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { RecordItem } from './model';
export type State = { records: RecordItem[]; audit: any[] };
const directory = path.join(process.cwd(), '.minetech-data');
const filename = path.join(directory, 'workspace.json');
export class BlobPreconditionFailedError extends Error {}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function assertLocal() { if (process.env.VERCEL) throw new Error('MineTech hosted storage has not been configured.'); }
export async function readState(): Promise<{ state: State; etag: string | undefined }> {
  if(process.env.VERCEL) return readCloudState();
  assertLocal();
  try {
    const raw = await readFile(filename, 'utf8');
    return { state: JSON.parse(raw), etag: digest(raw) };
  } catch (error: any) {
    if (error.code === 'ENOENT') return { state: { records: [], audit: [] }, etag: undefined };
    throw error;
  }
}
export async function saveState(state: State, etag?: string) {
  if(process.env.VERCEL){try{return await saveCloudState(state,etag);}catch(error:any){if(error instanceof CloudConflict)throw new BlobPreconditionFailedError();throw error;}}
  assertLocal();
  await mkdir(directory, { recursive: true });
  const lockfile = path.join(directory, 'write.lock');
  let lock;
  try { lock = await open(lockfile, 'wx'); }
  catch (error: any) { if (error.code === 'EEXIST') throw new BlobPreconditionFailedError(); throw error; }
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  try {
    const current = await readState();
    if (current.etag !== etag) throw new BlobPreconditionFailedError();
    const file = await open(temporary, 'wx');
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockfile);
  }
}
