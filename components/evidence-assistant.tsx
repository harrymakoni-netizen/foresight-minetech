'use client';
import { useEffect, useState } from 'react';
import { Sparkles, ArrowDownToLine } from 'lucide-react';

export default function EvidenceAssistant({ scenario, index, zone, time }: { scenario: string; index: number; zone: string; time: string }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => { fetch('/api/assistant').then(r => r.json()).then(d => setConfigured(d.configured)).catch(() => {setConfigured(false);setError('Could not check Gemini connection. Refresh the page to try again.');}); }, []);
  async function ask(question: string) {
    setBusy(true); setError(''); setAnswer(null);
    try {
      const response = await fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario, index, zone, question }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setAnswer(result);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(answer, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'foresight-ai-draft.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="panel minetech-assistant">
    <div className="panel-head"><div><span className="tiny-label">EXPLAINABLE EVIDENCE</span><h2><Sparkles size={21} /> Evidence assistant</h2><p>Understand the evidence. Keep the decision human.</p></div><span className="pill teal">{configured === null ? 'Checking assistant...' : configured ? 'Gemini configured' : 'Gemini not connected'}</span></div>
    <p>Zone {zone.slice(-1).toUpperCase()} · {new Date(time).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC · {scenario}</p>
    <p className="info-note">Only the selected synthetic assessment is sent to Google Gemini. Worker names, contacts and new workflow notes are excluded. AI drafts can be wrong; inspect the sources before use.</p>
    {configured === false && <p role="status">The assistant is ready for a server-side Gemini API key and model configuration. No AI response is being simulated.</p>}
    <div className="assistant-actions">{[['explain', 'Explain this assessment'], ['missing', 'What information is missing?'], ['handover', 'Draft evidence handover']].map(([id, title]) => <button key={id} className="text-button" disabled={busy || !configured} onClick={() => ask(id)}>{title}</button>)}</div>
    {busy && <p role="status">Reading the selected evidence…</p>}{error && <p role="alert">{error}</p>}
    {answer && <div aria-live="polite"><p><b>{answer.label}</b></p>{answer.paragraphs.map((p: any, i: number) => <article key={i}><p>{p.text}</p><div className="assistant-citations">{p.citations.map((id: string) => <a key={id} href={`#source-${id}`}>{answer.context.sources.find((s: any) => s.id === id)?.title}</a>)}</div></article>)}<button className="text-button" onClick={download}><ArrowDownToLine size={16} /> Download draft and evidence</button><small>{answer.model} · Generated {answer.generatedAt}</small><h3>Sources supplied to Gemini</h3>{answer.context.sources.map((s: any) => <details id={`source-${s.id}`} key={s.id}><summary>{s.title}</summary><pre>{JSON.stringify(s.evidence, null, 2)}</pre></details>)}</div>}
    <small>SIMULATOR RESULTS — provisional and unvalidated. The assistant cannot change scores, resolve alerts or clear a zone.</small>
  </section>;
}
