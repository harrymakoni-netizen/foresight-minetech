"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Map,
  FileText,
  FlaskConical,
  Menu,
  Settings,
  RefreshCw,
  Bell,
  Siren,
  Download,
  LogOut,
} from "lucide-react";
import { authClient } from "@/lib/client/auth";
import { cache, cached, clearCache, queued, sync } from "@/lib/client/queue";
import { CommandCentre } from "@/components/foresight/command";
const Records = dynamic(
  () => import("@/components/foresight/records").then((m) => m.Records),
  { loading: () => <p role="status">Loading workspace view…</p> },
);
const MineMap = dynamic(
  () => import("@/components/foresight/mine").then((m) => m.Mine),
  { loading: () => <p role="status">Loading workspace view…</p> },
);
const Simulator = dynamic(
  () => import("@/components/foresight/escape").then((m) => m.Scenarios),
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
import "./v2.css";
import "./theme.css";
// Four sections in the order a supervisor uses them (spec §4.1).
const nav = [
  ["underground", "Underground now", Activity],
  ["mine", "Mine", Map],
  ["scenarios", "Scenarios", FlaskConical],
  ["records", "Records", FileText],
] as const;
// Old bookmarks keep resolving: five-destination and legacy WorkSafe hashes.
const aliases: Record<string, string> = {
  overview: "underground",
  lite: "underground",
  map: "mine",
  zones: "mine",
  simulator: "scenarios",
  evidence: "records",
  people: "records",
  workers: "records",
  incidents: "records",
  inspections: "records",
  assistant: "records",
  audit: "records",
  checkins: "records",
  messages: "records",
};
const recordTabFor: Record<string, string> = {
  people: "people",
  workers: "people",
  incidents: "incidents",
  audit: "exports",
  checkins: "checkins",
  messages: "messages",
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
    [page, setPage] = useState("underground"),
    [recordTab, setRecordTab] = useState("evidence"),
    [hashKey, setHashKey] = useState(""),
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
      const hash = location.hash.slice(1).split("?")[0];
      setHashKey(location.hash);
      setPage(
        aliases[hash] ||
          (nav.some((n) => n[0] === hash) ? hash : "underground"),
      );
      if (aliases[hash] === "records" || hash === "records")
        setRecordTab(recordTabFor[hash] || "evidence");
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
  // Underground now is a live view: refresh while it is visible and online.
  useEffect(() => {
    if (page !== "underground") return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine)
        void refresh();
    }, 20000);
    return () => clearInterval(timer);
  }, [page, refresh]);
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
  // Live counts for the sidebar and top bar (declared, not tracked).
  const live = (data?.entities || []).filter(
    (e) =>
      e.kind === "check-in" &&
      ["declared-underground", "return-overdue", "confirmed-missing"].includes(
        String(e.data.status),
      ),
  );
  const overdue = live.filter((e) => e.data.status !== "declared-underground").length;
  const emergencies = (data?.entities || []).filter(
    (e) => e.kind === "emergency" && e.data.status === "active",
  ).length;
  const runningRuns = (data?.entities || []).filter(
    (e) => e.kind === "escape-run" && ["queued", "running"].includes(String(e.data.status)),
  ).length;
  const openIncidents = (data?.entities || []).filter(
    (e) => e.kind === "case" && e.data.status !== "closed",
  ).length;
  const alertCount = overdue + emergencies;
  const badges: Record<string, { count?: number; alert?: number; title: string }> = {
    underground: {
      count: live.length,
      alert: alertCount || undefined,
      title: alertCount
        ? `${alertCount} overdue, missing or emergency`
        : `${live.length} declared underground`,
    },
    scenarios: { count: runningRuns, title: `${runningRuns} scenario run(s) calculating` },
    records: { count: openIncidents, title: `${openIncidents} open incident(s) and responses` },
  };
  const m = data?.messaging;
  const gateway = m?.gateways?.[0];
  const systemStatus = [
    {
      label: "Messaging",
      value: !m ? "—" : m.mode === "dry-run" ? "Dry run" : m.mode === "allow-list" ? "Test numbers" : m.liveEnabled ? "Live" : "Live (not enabled)",
      tone: m?.mode === "live" && m.liveEnabled ? "ok" : "warn",
    },
    {
      label: "SMS gateway",
      value: !gateway || gateway.status === "not-configured" ? "Not set up" : gateway.status === "online" && !gateway.stale ? "Online" : "Offline",
      tone: gateway?.status === "online" && !gateway.stale ? "ok" : gateway && gateway.status !== "not-configured" ? "bad" : "warn",
    },
    {
      label: "Alert scheduler",
      value: m?.scheduler.running ? "Running" : "Stopped",
      tone: m?.scheduler.running ? "ok" : "bad",
    },
  ];
  return (
    <div className="fs-app">
      <a href="#main-content" className="fs-skip">
        Skip to content
      </a>
      <aside className={"fs-sidebar " + (menu ? "open" : "")}>
        <a className="fs-brand" href="#underground">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="fs-brand-logo"
            src="/brand/foresight-mark-192.png"
            alt=""
            width={40}
            height={40}
          />
          <span className="fs-brand-name">
            Foresight<small>Mine safety</small>
          </span>
        </a>
        <div
          className="fs-mine-card"
          title="All people, equipment and layout in this mine are fictional. Results are planning calculations, never a safety certification."
        >
          <small>Mine</small>
          <strong>{data?.site.name || "Mavambo training mine"}</strong>
          <span className="fs-training-notice">
            Training mine · fictional data · planning calculations
          </span>
        </div>
        <nav aria-label="Primary navigation">
          {nav.map(([id, label, Icon]) => {
            const badge = badges[id];
            return (
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
                {badge?.alert ? (
                  <b className="fs-nav-badge alert" title={badge.title}>
                    {badge.alert}
                  </b>
                ) : badge?.count ? (
                  <b className="fs-nav-badge" title={badge.title}>
                    {badge.count}
                  </b>
                ) : null}
              </a>
            );
          })}
        </nav>
        <div className="fs-system" aria-label="System status">
          <small>System</small>
          {systemStatus.map((row) => (
            <div key={row.label} className={"fs-system-row " + row.tone}>
              <i aria-hidden="true" />
              <span>{row.label}</span>
              <em>{row.value}</em>
            </div>
          ))}
        </div>
        <div className="fs-sidebar-bottom">
          <button onClick={() => setSettings(true)}>
            <Settings size={17} /> Workspace and records
          </button>
          <div className="fs-user">
            <span className="fs-avatar" aria-hidden="true">
              DS
            </span>
            <span>
              <strong>Demo supervisor</strong>
              <small>{data?.workspace.role || "supervisor"} · fictional</small>
            </span>
          </div>
        </div>
      </aside>
      {menu && (
        <button
          className="fs-scrim"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        />
      )}
      <div className="fs-content">
        <header className="fs-topbar">
          <button
            className="fs-mobile-toggle"
            aria-label="Toggle navigation"
            onClick={() => setMenu(!menu)}
          >
            <Menu />
          </button>
          <div className="fs-title">
            <span className="fs-breadcrumb">
              {nav.find((n) => n[0] === page)?.[1]}
            </span>
            <small>
              {data?.site.name || "Mavambo training mine"} ·{" "}
              {data
                ? `synced ${date(data.latestSyncedAt)}`
                : "connecting…"}
            </small>
          </div>
          <div className="fs-top-actions">
            <label className="fs-zone">
              <span>Zone</span>
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
            <Tag tone={offline ? "amber" : "teal"}>
              {offline ? "Offline · cached" : "Records connected"}
            </Tag>
            <a
              className={"fs-bell " + (alertCount ? "alert" : "")}
              href="#underground"
              aria-label={`Alerts: ${alertCount} needing attention`}
            >
              <Bell size={18} />
              {alertCount > 0 && <b>{alertCount}</b>}
            </a>
            <button
              onClick={() => void refresh()}
              aria-label="Refresh workspace"
            >
              <RefreshCw size={17} />
            </button>
            {["supervisor", "administrator"].includes(
              data?.workspace.role || "",
            ) && (
              <a
                className="fs-emergency-link"
                href="#underground?declare=1"
                aria-label="Emergency: open the declaration on Underground now"
              >
                <Siren size={16} />
                <span>Emergency</span>
              </a>
            )}
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
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
              {page === "underground" && <CommandCentre {...props} />}
              {page === "mine" && <MineMap {...props} />}
              {page === "scenarios" && <Simulator key={hashKey} {...props} />}
              {page === "records" && (
                <Records key={recordTab} {...props} initialTab={recordTab} />
              )}
            </>
          )}
          <footer className="fs-footer">
            <span>
              Foresight notices when someone does not come back.
            </span>
            <span>Planning calculations · no automatic actions · a person decides</span>
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
