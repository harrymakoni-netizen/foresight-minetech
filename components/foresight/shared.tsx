"use client";
import {
  useEffect,
  useRef,
  useId,
  cloneElement,
  type ReactElement,
} from "react";
import type { Entity } from "@/lib/domain/contracts";
export type Row = Entity<any>;
export type WorkspaceData = {
  workspace: {
    id: string;
    name: string;
    mode: string;
    role: string;
    actor: string;
  };
  site: {
    id: string;
    name: string;
    timezone: string;
    layoutVersion: string;
    datum: string;
    zones: { id: string; name: string; x: number; y: number }[];
  };
  entities: Row[];
  latestSyncedAt: string;
  services: {
    ai: boolean;
    aiStatus?: { configured: boolean; message: string };
    vision: boolean;
    visionMessage?: string;
    directUploads?: boolean;
  };
};
export type ViewProps = {
  data: WorkspaceData;
  zone: string;
  refresh: () => Promise<void>;
  post: (path: string, body?: unknown, key?: string) => Promise<any>;
  notify: (message: string) => void;
};
export const date = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Africa/Harare",
      }).format(new Date(value)) + " CAT (UTC+02)"
    : "Observation time unknown";
export const localInput = (value = new Date().toISOString()) =>
  new Date(Date.parse(value) + 2 * 3600e3).toISOString().slice(0, 16);
export const fromLocal = (value: string) =>
  value ? new Date(value + ":00+02:00").toISOString() : null;
export const rows = (data: WorkspaceData, kind: string, zone?: string) =>
  data.entities.filter(
    (e) => e.kind === kind && (!zone || zone === "all" || e.zoneId === zone),
  );
export function Tag({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={"fs-tag " + tone}>{children}</span>;
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="fs-empty">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function Field({
  label,
  children,
  help,
}: {
  label: string;
  children: React.ReactNode;
  help?: string;
}) {
  const id = useId();
  return (
    <div className="fs-field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(
        children as ReactElement<{ id?: string; "aria-describedby"?: string }>,
        { id, "aria-describedby": help ? id + "-help" : undefined },
      )}
      {help && <small id={id + "-help"}>{help}</small>}
    </div>
  );
}
export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="fs-dialog"
      onCancel={onClose}
      aria-labelledby="fs-dialog-title"
    >
      <div className="fs-dialog-heading">
        <h2 id="fs-dialog-title">{title}</h2>
        <button onClick={onClose} aria-label="Close detail panel">
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function ErrorText({ message }: { message: string }) {
  return message ? (
    <p role="alert" className="fs-error">
      {message}
    </p>
  ) : null;
}
export function sourceName(data: WorkspaceData, id: string) {
  const row = data.entities.find((x) => x.id === id);
  return row
    ? String(row.data.condition || row.data.title || row.data.name || row.kind)
    : id;
}
export function download(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
