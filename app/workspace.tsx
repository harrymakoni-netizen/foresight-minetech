"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Map,
  FileText,
  Users,
  FlaskConical,
  Menu,
  Settings,
  RefreshCw,
  Download,
  LogOut,
  ArrowUpRight,
} from "lucide-react";
import { authClient } from "@/lib/client/auth";
import { cache, cached, clearCache, queued, sync } from "@/lib/client/queue";
import { CommandCentre } from "@/components/foresight/command";
const Evidence = dynamic(
  () => import("@/components/foresight/evidence").then((m) => m.Evidence),
  { loading: () => <p role="status">Loading workspace view…</p> },
);
const People = dynamic(
  () => import("@/components/foresight/people").then((m) => m.People),
  { loading: () => <p role="status">Loading workspace view…</p> },
);
const MineMap = dynamic(
  () => import("@/components/foresight/mine-map").then((m) => m.MineMap),
  { loading: () => <p role="status">Loading workspace view…</p> },
);
const Simulator = dynamic(
  () => import("@/components/foresight/simulator").then((m) => m.Simulator),
  { loading: () => <p role="status">Loading workspace view…</p> },
);
import {
  date,
  Dialog,
  ErrorText,
  Tag,
  type WorkspaceData,
} from "@/components/foresight/shared";
import "./upgrade.css";
const nav = [
  ["overview", "Command Centre", Activity],
  ["map", "Mine Map", Map],
  ["evidence", "Evidence", FileText],
  ["people", "People and Response", Users],
  ["simulator", "Simulator Lab", FlaskConical],
] as const;
const aliases: Record<string, string> = {
  zones: "map",
  workers: "people",
  incidents: "people",
  inspections: "evidence",
  assistant: "evidence",
  lite: "evidence",
  audit: "overview",
};
let sessionStarting: Promise<void> | undefined;
async function ensureSession() {
  sessionStarting ||= (async () => {
    const session = await authClient.getSession();
    if (!session.data) {
      const result = await authClient.signIn.anonymous();
      if (result.error)
        throw new Error(result.error.message || "Session unavailable.");
    }
  })();
  try {
    await sessionStarting;
  } catch (error) {
    sessionStarting = undefined;
    throw error;
  }
}
export default function Workspace() {
  const [data, setData] = useState<WorkspaceData | null>(null),
    [page, setPage] = useState("overview"),
    [zone, setZone] = useState("all"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [offline, setOffline] = useState(false),
    [settings, setSettings] = useState(false),
    [menu, setMenu] = useState(false),
    [pending, setPending] = useState(0),
    [starting, setStarting] = useState(true);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker
      .register("/sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => {
        const urls = performance
          .getEntriesByType("resource")
          .map((e) => e.name);
        registration.active?.postMessage({ type: "CACHE_SHELL", urls });
      })
      .catch(() => {});
  }, []);
  const refresh = useCallback(async () => {
    try {
      if (!navigator.onLine)
        throw new Error("Offline: showing the last synced workspace.");
      await ensureSession();
      const response = await fetch("/api/workspace/state", {
          cache: "no-store",
        }),
        next = await response.json();
      if (!response.ok)
        throw new Error(next.message || "Workspace unavailable.");
      setData(next);
      setOffline(false);
      setError("");
      await cache(next.workspace.id, next);
      setPending(
        (await queued(next.workspace.id)).filter((q) => q.state !== "synced")
          .length,
      );
    } catch (e) {
      setError((e as Error).message);
      const id = localStorage.getItem("foresight-last-workspace");
      if (id) {
        const previous = await cached(id);
        if (previous) {
          setData(previous);
          setOffline(true);
          setPending(
            (await queued(id)).filter((q) => q.state !== "synced").length,
          );
        }
      }
    } finally {
      setStarting(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const navigate = () => {
      const hash = location.hash.slice(1);
      setPage(
        aliases[hash] || (nav.some((n) => n[0] === hash) ? hash : "overview"),
      );
    };
    navigate();
    window.addEventListener("hashchange", navigate);
    const online = () => void refresh();
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("hashchange", navigate);
      window.removeEventListener("online", online);
    };
  }, [refresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 7000);
    return () => clearTimeout(timer);
  }, [notice]);
  const post = useCallback(
    async (path: string, body: unknown = {}, key = crypto.randomUUID()) => {
      if (!data) throw new Error("Workspace has not loaded.");
      const response = await fetch("/api/workspace/" + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
          "X-Workspace-Id": data.workspace.id,
        },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Request failed.");
      return result;
    },
    [data],
  );
  async function syncNow() {
    if (!data) return;
    try {
      const outcomes = await sync(data.workspace.id);
      setNotice(
        outcomes.length
          ? `Sync reviewed ${outcomes.length} submission(s). Conflicts retain your content.`
          : "No pending submissions.",
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function signOut() {
    if (!data) return;
    const unsynced = (await queued(data.workspace.id)).some(
      (q) => q.state !== "synced",
    );
    if (unsynced) {
      setError(
        "Sync or resolve your queued content before leaving this session. Drafts stay scoped to this workspace.",
      );
      return;
    }
    await authClient.signOut();
    await clearCache();
    sessionStarting = undefined;
    setData(null);
    setSettings(false);
    await refresh();
  }
  const props = data ? { data, zone, refresh, post, notify: setNotice } : null;
  return (
    <div className="fs-app">
      <a href="#main-content" className="fs-skip">
        Skip to content
      </a>
      <aside className={"fs-sidebar " + (menu ? "open" : "")}>
        <a className="fs-brand" href="#overview">
          <span className="fs-brand-mark">
            F<span>°</span>
          </span>
          <span>
            foresight<small>MINE INTELLIGENCE</small>
          </span>
        </a>
        <div className="fs-site-label">YOUR WORKSPACE</div>
        <nav aria-label="Primary navigation">
          {nav.map(([id, label, Icon], i) => (
            <a
              key={id}
              href={"#" + id}
              aria-label={label}
              aria-current={page === id ? "page" : undefined}
              className={page === id ? "active" : ""}
              onClick={() => setMenu(false)}
            >
              <Icon size={19} />
              <span>{label}</span>
              <small>0{i + 1}</small>
            </a>
          ))}
        </nav>
        <div className="fs-sidebar-bottom">
          <div className="fs-mode">
            <span className="fs-status-dot" />
            <div>
              <strong>Isolated demonstration</strong>
              <small>Fictional site · human review</small>
            </div>
          </div>
          <button onClick={() => setSettings(true)}>
            <Settings size={17} /> Workspace and records
          </button>
          <small className="fs-version">DEVELOPMENT RELEASE · 1.0</small>
        </div>
      </aside>
      <div className="fs-content">
        <header className="fs-topbar">
          <button
            className="fs-mobile-toggle"
            aria-label="Toggle navigation"
            onClick={() => setMenu(!menu)}
          >
            <Menu />
          </button>
          <span className="fs-breadcrumb">
            Workspace <span>/</span> {nav.find((n) => n[0] === page)?.[1]}
          </span>
          <div className="fs-top-actions">
            <Tag tone={offline ? "amber" : "teal"}>
              {offline ? "Offline · cached" : "Development"}
            </Tag>
            <button
              onClick={() => void refresh()}
              aria-label="Refresh workspace"
            >
              <RefreshCw size={17} />
            </button>
            <span className="fs-avatar" title="Fictional demo supervisor">
              DS
            </span>
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          <div className="fs-context">
            <span>
              {data?.site.name || "Mavambo training mine"}{" "}
              <ArrowUpRight size={13} />
            </span>
            <label>
              Zone{" "}
              <select
                aria-label="Selected zone"
                value={zone}
                onChange={(e) => setZone(e.target.value)}
              >
                <option value="all">All zones</option>
                {data?.site.zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </select>
            </label>
            <span className="fs-time">
              {data
                ? `Snapshot synced ${date(data.latestSyncedAt)}`
                : "Connecting to local records…"}
            </span>
          </div>
          {error && (
            <div className="fs-alert">
              <ErrorText message={error} />
              <button onClick={() => void refresh()}>Retry</button>
            </div>
          )}
          {notice && (
            <div role="status" className="fs-notice">
              {notice}
            </div>
          )}
          {pending > 0 && (
            <div className="fs-queue-banner">
              {pending} local submission(s) awaiting sync or review.
              <button onClick={() => void syncNow()}>Sync queue</button>
            </div>
          )}
          {starting && !data ? (
            <div className="fs-loading" role="status">
              Opening your isolated workspace…
            </div>
          ) : !props ? (
            <div className="fs-empty">
              <h1>Workspace unavailable</h1>
              <p>
                Check the local database and authentication configuration, then
                retry.
              </p>
              <button onClick={() => void refresh()}>Try again</button>
            </div>
          ) : (
            <>
              {page === "overview" && <CommandCentre {...props} />}{" "}
              {page === "evidence" && <Evidence {...props} />}{" "}
              {page === "people" && <People {...props} />}{" "}
              {page === "map" && <MineMap {...props} />}{" "}
              {page === "simulator" && <Simulator {...props} />}
            </>
          )}
          <footer className="fs-footer">
            <span>
              FORESIGHT <span> / </span> Evidence before decisions.
            </span>
            <span>
              Fictional inputs · planning approximation · no automatic actions
            </span>
          </footer>
        </main>
      </div>
      {settings && (
        <Dialog
          title="Workspace and records"
          onClose={() => setSettings(false)}
        >
          <Tag tone="teal">{data?.workspace.mode || "Development"}</Tag>
          <p>
            This visitor has a separate fictional workspace. Demonstration
            actors are unverified; no real mine records belong here.
          </p>
          <dl className="fs-meta">
            <dt>Role</dt>
            <dd>{data?.workspace.role}</dd>
            <dt>Workspace</dt>
            <dd>{data?.workspace.id}</dd>
            <dt>Timezone</dt>
            <dd>Africa/Harare · CAT · UTC+02</dd>
            <dt>Latest synced</dt>
            <dd>{date(data?.latestSyncedAt)}</dd>
          </dl>
          <h3>Records and technical details</h3>
          <div className="fs-button-row">
            <a className="fs-button" href="/api/workspace/export">
              <Download size={16} /> Evidence bundle
            </a>
            <a
              className="fs-button secondary"
              href="/api/workspace/export?format=text"
            >
              Readable timeline
            </a>
            <a
              className="fs-button secondary"
              href="/api/workspace/legacy-register"
              target="_blank"
              rel="noreferrer"
            >
              Legacy model details
            </a>
          </div>
          <details>
            <summary>Historical development experiments</summary>
            <p>
              Read-only precomputed artifacts. Their scores are unvalidated
              development values.
            </p>
            {[
              "wet",
              "dry",
              "wet-control",
              "dry-control",
              "wet-retrospective",
            ].map((s) => (
              <a
                className="fs-inline-link"
                key={s}
                href={"/replay/" + s + ".json"}
                target="_blank"
                rel="noreferrer"
              >
                {s}
              </a>
            ))}
          </details>
          <h3>Services</h3>
          <p>
            AI:{" "}
            {data?.services.ai
              ? "configured; requests still require verification"
              : "unavailable; manual facts supported"}
            . Vision:{" "}
            {data?.services.vision ? "worker configured" : "not configured"}.
            Simulation uses a separate local Python worker. Reconstructed
            geometry needs a supplied asset.
          </p>
          <button
            className="fs-button secondary"
            onClick={() => void signOut()}
          >
            <LogOut size={16} /> Leave session and start a fresh demo
          </button>
          <small>
            Pending drafts must be synced or resolved first. This does not
            delete historical records.
          </small>
        </Dialog>
      )}
    </div>
  );
}
