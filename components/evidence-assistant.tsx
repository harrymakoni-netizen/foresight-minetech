'use client';
import { useState } from 'react';
import { preparedDemoAnswer, questions } from '@/lib/assistant';
import { Sparkles, ArrowDownToLine } from 'lucide-react';

export default function EvidenceAssistant({ snapshot, zone }: { snapshot: any; zone: string }) {
  const [answer, setAnswer] = useState<any>(null);
  function ask(question: keyof typeof questions) {
    setAnswer(preparedDemoAnswer(snapshot, zone, question));
  }
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(answer, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'foresight-demo-answer.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="panel minetech-assistant">
    <div className="panel-head"><div><span className="tiny-label">EXPLAINABLE EVIDENCE</span><h2><Sparkles size={21} /> Evidence assistant</h2><p>Understand the evidence. Keep the decision human.</p><p>Choose a question for a prepared, evidence-linked demonstration answer.</p></div><span className="pill teal">Prepared demo answers</span></div>
    <p>Zone {zone.slice(-1).toUpperCase()} · {new Date(snapshot.time).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC</p>
    <p className="info-note">These are fixed response templates populated with the selected simulator evidence. No live AI request is made and no data is sent to Gemini.</p>
    <div className="assistant-actions">{[['explain', 'Explain this assessment'], ['missing', 'What information is missing?'], ['handover', 'Draft evidence handover']].map(([id, title]) => <button key={id} className="text-button" onClick={() => ask(id as keyof typeof questions)}>{title}</button>)}</div>
    {answer && <div aria-live="polite"><p><b>{answer.label}</b></p>{answer.notice && <p role="status">{answer.notice}</p>}{answer.paragraphs.map((p: any, i: number) => <article key={i}><p>{p.text}</p><div className="assistant-citations">{p.citations.map((id: string) => <a key={id} href={`#source-${id}`}>{answer.context.sources.find((s: any) => s.id === id)?.title}</a>)}</div></article>)}<button className="text-button" onClick={download}><ArrowDownToLine size={16} /> Download answer and evidence</button><small>{answer.model} · Prepared {new Date(answer.generatedAt).toLocaleString()}</small><h3>Supporting source evidence</h3>{answer.context.sources.map((s: any) => <details id={`source-${s.id}`} key={s.id}><summary>{s.title}</summary><pre>{JSON.stringify(s.evidence, null, 2)}</pre></details>)}</div>}
    <small>SIMULATOR RESULTS — provisional and unvalidated. The assistant cannot change scores, resolve alerts or clear a zone.</small>
  </section>;
}
