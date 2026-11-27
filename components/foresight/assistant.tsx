"use client";
// Scenario assistant and grounded run explanations (spec §12). The explanation
// always works without AI; the AI version is shown only after its figures and
// citations were checked against the recorded run on the server.
import { useState } from "react";
import { Bot, FileText } from "lucide-react";
import { ErrorText, Field, Tag, type ViewProps } from "./shared";

type Explanation = {
  runId: string;
  mode: "deterministic" | "ai";
  paragraphs: { text: string; citations: { runId: string; metricId: string }[] }[];
  assumptions: string[];
  unavailable: { metricId: string; label: string; reason: string }[];
  limitation: string;
  provenance?: { modelId: string };
};

export function RunExplain({ runId, compareWith, data, post }: { runId: string; compareWith?: string; data: ViewProps["data"]; post: ViewProps["post"] }) {
  const runIds = compareWith ? [runId, compareWith] : [runId];
  const [x, setX] = useState<Explanation | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const aiOn = data.services.ai;
  async function load(mode: "deterministic" | "ai") {
    setBusy(true);
    setError("");
    try {
      setX((await post("assistant/explain", { runIds, mode })) as Explanation);
    } catch (e) {
      setError((e as Error).message);
      if (mode === "ai" && !x) setX((await post("assistant/explain", { runIds, mode: "deterministic" })) as Explanation);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="fs-explain" aria-label="Explanation of this run">
      <div className="fs-button-row">
        <button className="fs-button secondary" disabled={busy} onClick={() => void load("deterministic")}>
          <FileText size={15} /> {compareWith ? "Explain the difference" : "Explain these results"}
        </button>
        <button className="fs-button secondary" disabled={busy || !aiOn} title={aiOn ? "" : "No AI provider is set up. The explanation on the left needs none."} onClick={() => void load("ai")}>
          <Bot size={15} /> Explain with AI
        </button>
      </div>
      <ErrorText message={error} />
      {x && (
        <div className="fs-explanation">
          <Tag tone={x.mode === "ai" ? "amber" : "teal"}>{x.mode === "ai" ? `AI wording${x.provenance ? ` · ${x.provenance.modelId}` : ""}` : "From the recorded run, no AI"}</Tag>
          {x.paragraphs.map((p, i) => (
            <p key={i}>
              {p.text}
              <small>
                Cites run {p.citations[0]?.runId.slice(0, 8)} · {p.citations.map((c) => c.metricId).join(", ")}
              </small>
            </p>
          ))}
          <h4>Assumptions</h4>
          <ul>
            {x.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
          {x.unavailable.length > 0 && (
            <>
              <h4>Not available</h4>
              <ul>
                {x.unavailable.map((u) => (
                  <li key={u.metricId}>
                    {u.label}: {u.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="fs-help">{x.limitation}</p>
        </div>
      )}
    </section>
  );
}

type Step = { tool: string; ok: boolean; summary: string };
export function AssistantPanel({ data, post, refresh, notify }: Pick<ViewProps, "data" | "post" | "refresh" | "notify">) {
  const aiOn = data.services.ai;
  const supervisor = ["supervisor", "administrator"].includes(data.workspace.role);
  const [message, setMessage] = useState("");
  const [allowRuns, setAllowRuns] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reply, setReply] = useState<{ text: string; steps: Step[]; drafts: string[] } | null>(null);
  async function ask() {
    setBusy(true);
    setError("");
    try {
      const r = await post("assistant/chat", { message, allowRuns: allowRuns && supervisor });
      setReply(r);
      if (r.drafts?.length) notify("The assistant saved a scenario draft. Open it in the builder to check it.");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="fs-assistant" aria-label="Scenario assistant">
      <summary>
        <Bot size={16} aria-hidden /> Scenario assistant {aiOn ? "" : "(not set up)"}
      </summary>
      {!aiOn ? (
        <p className="fs-help">No AI provider is configured, so the assistant is off. Every scenario can be built by hand in the builder, and run explanations work without AI.</p>
      ) : (
        <>
          <p className="fs-help">
            It can look up who is declared underground (counts only), inspect the mine model, list missing inputs, draft and check a scenario, and read or compare results. It cannot send messages, declare emergencies, change statuses or accept evidence. Phone numbers are never sent to the model.
          </p>
          <Field label="Ask or instruct">
            <textarea rows={3} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Draft a scenario where the East development pump fails and the order is given at 100 minutes." />
          </Field>
          {supervisor && (
            <label className="fs-confirm">
              <input type="checkbox" checked={allowRuns} onChange={(e) => setAllowRuns(e.target.checked)} /> Let the assistant run a scenario it has checked, for this request only
            </label>
          )}
          <ErrorText message={error} />
          <button className="fs-button" disabled={busy || message.trim().length < 3} onClick={() => void ask()}>
            Ask the assistant
          </button>
          {reply && (
            <div className="fs-explanation">
              <p>{reply.text}</p>
              {reply.steps.length > 0 && (
                <>
                  <h4>What it did</h4>
                  <ul>
                    {reply.steps.map((s, i) => (
                      <li key={i}>
                        <Tag tone={s.ok ? "teal" : "red"}>{s.tool}</Tag> <small>{s.ok ? "done" : s.summary}</small>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {reply.drafts.map((d) => (
                <p key={d}>
                  <a className="fs-button" href={`#scenarios?draft=${d}`}>
                    Open the draft in the builder
                  </a>
                </p>
              ))}
              <p className="fs-help">The assistant&apos;s wording is not a result. Figures come from recorded runs; check them in the run view.</p>
            </div>
          )}
        </>
      )}
    </details>
  );
}
