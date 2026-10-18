"use client";
import { useState } from "react";
import {
  Field,
  ErrorText,
  localInput,
  fromLocal,
  type ViewProps,
} from "./shared";
export function ResponseCase({
  sourceId,
  sourceKind,
  post,
  refresh,
  notify,
}: Pick<ViewProps, "post" | "refresh" | "notify"> & {
  sourceId: string;
  sourceKind: "run" | "vision-event";
}) {
  const [title, setTitle] = useState(""),
    [owner, setOwner] = useState(""),
    [reason, setReason] = useState(""),
    [due, setDue] = useState(localInput()),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [created, setCreated] = useState("");
  return (
    <details className="fs-panel">
      <summary>Document a human response</summary>
      <p>
        {sourceKind === "run"
          ? "Create a laboratory response case retaining this run and its assumptions. This does not apply calculated conditions to operational assessments."
          : "Record a response linked to this supervisor-confirmed event."}{" "}
        Muster still requires separate human confirmation.
      </p>
      {created ? (
        <p role="status">
          Response case saved. <a href="#people">Open People and Response</a>
        </p>
      ) : (
        <form
          className="fs-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              const c = await post("cases/from-source", {
                sourceKind,
                sourceId,
                title,
                owner,
                reason,
                dueAt: fromLocal(due),
              });
              setCreated(c.id);
              await refresh();
              notify("Response case saved with its source and assumptions.");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Response title">
            <input
              required
              minLength={3}
              maxLength={140}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label="Response owner">
            <input
              required
              minLength={2}
              maxLength={100}
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
            />
          </Field>
          <Field label="Response due time · Africa/Harare">
            <input
              required
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </Field>
          <Field label="Human decision and rationale">
            <textarea
              required
              minLength={3}
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <ErrorText message={error} />
          <button className="fs-button" disabled={busy}>
            {busy ? "Saving…" : "Create linked response case"}
          </button>
        </form>
      )}
    </details>
  );
}
