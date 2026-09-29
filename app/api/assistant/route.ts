import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { evidenceContext, evidenceSummary, generateExplanation, selectionSchema } from '@/lib/assistant';
import { reserveAiRequest } from '@/lib/ai-budget';
export const runtime = 'nodejs';
export const maxDuration = 90;
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ configured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_MODEL), scope: 'Simulator evidence only' }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'Same-origin request required.' }, { status: 403 });
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL;
  if (!key || !model) return Response.json({ error: 'Gemini is not connected. Configure GEMINI_API_KEY and GEMINI_MODEL on the MineTech server.' }, { status: 503 });
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
    const context = evidenceContext(snapshot, selection.zone);
    if (!await reserveAiRequest()) return Response.json({ ...evidenceSummary(context, selection.question), context, model: 'Source summary (not AI)', mode: 'source-summary', generatedAt: new Date().toISOString(), label: 'Evidence summary - not AI-generated', notice: 'The shared demo has reached its daily AI limit. This is a direct source summary, not an AI response. AI requests reset at midnight UTC.' }, { headers: { 'Cache-Control': 'no-store' } });
    let answer;
    try { answer = await generateExplanation(context, selection.question, key, model); }
    catch (error) {
      console.error('Gemini provider unavailable', model, error instanceof Error ? error.message : 'Unknown error');
      return Response.json({ ...evidenceSummary(context, selection.question), context, model: 'Source summary (not AI)', mode: 'source-summary', generatedAt: new Date().toISOString(), label: 'Evidence summary - not AI-generated', notice: 'Gemini could not produce an answer. This summary displays the supplied engine evidence directly; it is not an AI explanation or handover draft.' }, {headers:{'Cache-Control':'no-store'}});
    }
    return Response.json({ ...answer, context, model, generatedAt: new Date().toISOString(), label: 'AI-generated draft — verify every statement against the cited evidence.' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Gemini explanation failed:', error instanceof Error ? error.message : 'Unknown error');
    if (error instanceof Error && error.message.startsWith('Gemini is temporarily')) return Response.json({error: error.message}, {status:503});
    return Response.json({ error: 'An evidence-linked explanation could not be produced. The engine evidence remains available; try again or check Gemini configuration.' }, { status: 502 });
  }
}
