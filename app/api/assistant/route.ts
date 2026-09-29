import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { preparedDemoAnswer, selectionSchema } from '@/lib/assistant';
export const runtime = 'nodejs';
export const maxDuration = 90;
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ configured: true, mode: 'prepared-demo', scope: 'Simulator evidence only' }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'Same-origin request required.' }, { status: 403 });
  let selection;
  try {
    const body = await request.text();
    if (body.length > 2000) throw new Error();
    selection = selectionSchema.parse(JSON.parse(body));
  } catch { return Response.json({ error: 'Choose a valid scenario, time, zone and question.' }, { status: 400 }); }
  try {
    const replay = JSON.parse(await readFile(path.join(process.cwd(), 'public', 'replay', `${selection.scenario}.json`), 'utf8'));
    const snapshot = replay.snapshots[selection.index];
    if (!snapshot) return Response.json({ error: 'Replay time not found.' }, { status: 400 });
    return Response.json(preparedDemoAnswer(snapshot, selection.zone, selection.question), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'The selected replay evidence could not be loaded. Please reload the page.' }, { status: 503 });
  }
}
