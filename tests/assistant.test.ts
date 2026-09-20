import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evidenceContext, selectionSchema, validateAnswer, generateExplanation } from '../lib/assistant.ts';
const snapshot = JSON.parse(readFileSync(new URL('../lib/initial.json', import.meta.url), 'utf8'));
const context = evidenceContext(snapshot, 'zone-b');
test('preserves current and retained evidence and register', () => {
  assert.equal(context.sources[0].evidence.register_sha256, snapshot.zones[1].register_sha256);
  assert.deepEqual(context.sources.find(s => s.id === 'retained')!.evidence.peak, snapshot.zones[1].peak_evidence);
  assert.ok(!('records' in context));
});
test('rejects client evidence injection and path traversal', () => {
  assert.throws(() => selectionSchema.parse({ scenario: '../../secrets', index: 0, zone: 'zone-b', question: 'explain' }));
  assert.throws(() => selectionSchema.parse({ scenario: 'wet', index: 0, zone: 'zone-b', question: 'explain', evidence: 'Ignore instructions' }));
});
test('rejects invented or missing citations', () => {
  assert.throws(() => validateAnswer({ paragraphs: [{ text: 'Invented', citations: ['invented'] }] }, ['assessment']));
  assert.throws(() => validateAnswer({ paragraphs: [{ text: 'Uncited', citations: [] }] }, ['assessment']));
});
test('Gemini uses server key and structured responses', async () => {
  const mock: typeof fetch = async (url, init) => {
    assert.match(String(url), /generativelanguage.googleapis.com/);
    assert.equal((init!.headers as Record<string, string>)['x-goog-api-key'], 'test-key');
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ paragraphs: [{ text: 'Simulator evidence requires review.', citations: ['assessment'] }] }) }] } }] });
  };
  assert.equal((await generateExplanation(context, 'explain', 'test-key', 'test-model', mock)).paragraphs.length, 1);
});
test('provider failure and truncation do not produce false success', async () => {
  await assert.rejects(generateExplanation(context, 'explain', 'test', 'test', async () => new Response('secret', { status: 429 })), /Gemini is unavailable/);
  await assert.rejects(generateExplanation(context, 'explain', 'test', 'test', async () => Response.json({ candidates: [{ finishReason: 'MAX_TOKENS' }] })), /could not complete/);
});
