export type Queued = {
  key: string;
  workspaceId: string;
  operation: "reports" | "inspections" | "workers" | "worker-status";
  body: unknown;
  queuedAt: string;
  state: "pending" | "synced" | "conflict" | "rejected";
  message?: string;
};
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("foresight-offline-v1", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("submissions", { keyPath: "key" });
      request.result.createObjectStore("cache");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction<T>(
  store: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode),
      request = operation(tx.objectStore(store));
    let result: T;
    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
export async function queue(
  workspaceId: string,
  operation: Queued["operation"],
  body: unknown,
) {
  const entry: Queued = {
    key: crypto.randomUUID(),
    workspaceId,
    operation,
    body,
    queuedAt: new Date().toISOString(),
    state: "pending",
  };
  await transaction("submissions", "readwrite", (s) => s.put(entry));
  return entry;
}
export async function queued(workspaceId: string) {
  return (
    await transaction<Queued[]>("submissions", "readonly", (s) => s.getAll())
  ).filter((x) => x.workspaceId === workspaceId);
}
export async function sync(workspaceId: string) {
  const items = (await queued(workspaceId)).filter(
    (x) => x.state === "pending",
  );
  if (!items.length) return [];
  const response = await fetch("/api/workspace/sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Workspace-Id": workspaceId,
    },
    body: JSON.stringify({
      items: items
        .slice(0, 20)
        .map(({ key, operation, body }) => ({ key, operation, body })),
    }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.message || "Sync unavailable; drafts remain on this device.",
    );
  for (const outcome of data.outcomes) {
    const prior = items.find((x) => x.key === outcome.key)!;
    await transaction("submissions", "readwrite", (s) =>
      s.put({ ...prior, state: outcome.state, message: outcome.message }),
    );
  }
  return data.outcomes;
}
export async function retry(key: string, workspaceId: string, body: unknown) {
  const prior = (await queued(workspaceId)).find((x) => x.key === key);
  if (!prior) throw new Error("Draft is not in this workspace.");
  if (prior.state === "synced") throw new Error("Already synced.");
  const next = await queue(workspaceId, prior.operation, body);
  await transaction("submissions", "readwrite", (s) => s.delete(key));
  return next;
}
export async function cache(workspaceId: string, value: unknown) {
  await transaction("cache", "readwrite", (s) => s.put(value, workspaceId));
  localStorage.setItem("foresight-last-workspace", workspaceId);
}
export async function cached(workspaceId: string) {
  return transaction<any>("cache", "readonly", (s) => s.get(workspaceId));
}
export async function clearCache() {
  const id = localStorage.getItem("foresight-last-workspace");
  if (id) await transaction("cache", "readwrite", (s) => s.delete(id));
  localStorage.removeItem("foresight-last-workspace");
}
