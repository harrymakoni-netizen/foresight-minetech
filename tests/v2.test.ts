// MineTech v2 (spec 2.0) tests. Same harness as domain.test.ts: an isolated
// SQLite file, or DATABASE_URL for PostgreSQL.
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validTransition } from "../lib/domain/assessment.ts";
const directory = mkdtempSync(path.join(tmpdir(), "foresight-v2-"));
process.env.FORESIGHT_DATABASE_PATH = path.join(directory, "test.sqlite");
const { query, closeDatabase } = await import("../lib/server/db.ts");
const repo = await import("../lib/server/repository.ts");
const { mutate } = await import("../lib/server/workflows.ts");
const { migrateLegacy } = await import("../lib/server/migrate.ts");
const run = randomUUID();
export const workspaceFor = (id: string) => repo.workspaceFor(`v2-${run}-${id}`);
after(async () => closeDatabase());
const hour = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();

test("zone ids are workspace-defined: template zones and published mine-model zones are accepted, others rejected", async () => {
  const ctx = await workspaceFor("zones");
  // Existing fixed ids keep working unchanged.
  const r = await mutate(ctx, ["reports"], {
    text: "Water seen near the east sump",
    zoneId: "zone-b",
    observedAt: null,
  });
  assert.equal((r as { zoneId: string }).zoneId, "zone-b");
  await assert.rejects(
    () =>
      mutate(ctx, ["reports"], {
        text: "Water seen near the east sump",
        zoneId: "east-development",
        observedAt: null,
      }),
    /zone defined for this mine/,
  );
  await assert.rejects(
    () =>
      mutate(ctx, ["reports"], {
        text: "Water seen near the east sump",
        zoneId: "Not A Zone!",
        observedAt: null,
      }),
  );
  await repo.insert(ctx, "mine-model-revision", {
    status: "published",
    publishedAt: new Date().toISOString(),
    model: { zones: [{ id: "east-development", name: "East development" }] },
  });
  const zones = await repo.knownZones(ctx);
  assert.deepEqual(
    zones.map((z) => z.id),
    ["east-development"],
  );
  await mutate(ctx, ["reports"], {
    text: "Water seen near the east sump",
    zoneId: "east-development",
    observedAt: null,
  });
});

test("incidents register: supervisor records a real incident with category, source, people and owner", async () => {
  const ctx = await workspaceFor("incidents");
  const incident = (await mutate(ctx, ["incidents"], {
    title: "Fall of ground near ladderway",
    zoneId: "zone-a",
    category: "collapse",
    source: "real-event",
    description: "Loose rock fell beside the ladderway; nobody injured.",
    peopleAffected: [{ name: "Fictional miner A", personId: null }],
    owner: "Shift supervisor",
    dueAt: hour(24),
    occurredAt: null,
  })) as { id: string; data: Record<string, unknown> };
  assert.equal(incident.data.category, "collapse");
  assert.equal(incident.data.source, "real-event");
  assert.equal(incident.data.planning, false);
  assert.equal(incident.data.status, "open");
  await assert.rejects(() =>
    mutate(ctx, ["incidents"], {
      title: "Planning shortcut",
      zoneId: "zone-a",
      category: "planning",
      source: "real-event",
      description: "Not allowed directly",
      owner: "Supervisor",
      dueAt: hour(1),
    }),
  );
  const viewer = { ...ctx, role: "reporter" as const };
  await assert.rejects(
    () =>
      mutate(viewer, ["incidents"], {
        title: "Reporter cannot create",
        zoneId: "zone-a",
        category: "near-miss",
        source: "report",
        description: "Reporter attempt",
        owner: "Someone",
        dueAt: hour(1),
      }),
    /Supervisor review is required/,
  );
});

test("reopened is a lifecycle status; legacy closed→open stays valid", () => {
  validTransition("closed", "reopened", "New evidence", []);
  validTransition("reopened", "acknowledged", "Owner accepted", []);
  validTransition("closed", "open", "Older reopen path", []);
  assert.throws(() => validTransition("reopened", "closed", "skip", ["x"]));
});

test("legacy MineShield incidents migrate into the register with audit links", async () => {
  const filename = path.join(directory, "legacy-incidents.json");
  writeFileSync(
    filename,
    JSON.stringify({
      records: [
        {
          id: "inc-1",
          kind: "incident",
          zone: "zone-c",
          createdAt: "2026-09-01T08:00:00Z",
          data: {
            name: "Historic fictional near miss",
            notes: "Ladder rung loose",
            status: "investigating",
            category: "near-miss",
            people: ["Fictional A"],
            version: 2,
          },
        },
        { id: "w-1", kind: "worker", zone: "zone-c", data: { name: "W" } },
      ],
      audit: [
        { id: "a-1", record_id: "inc-1", actor: "Unverified", detail: "{}" },
        { id: "a-2", record_id: "w-1", actor: "Unverified", detail: "{}" },
      ],
    }),
  );
  const result = await migrateLegacy(filename);
  assert.equal(result.incidentCount, 1);
  const { rows } = await query(
    "SELECT id,payload FROM foresight.entities WHERE workspace_id=$1 AND kind='case'",
    [result.workspaceId],
  );
  assert.equal(rows.length, 1);
  const data = JSON.parse(rows[0].payload);
  assert.equal(data.source, "legacy-mineshield");
  assert.equal(data.status, "action-in-progress");
  assert.equal(data.legacyStatus, "investigating");
  const { rows: links } = await query(
    "SELECT relation FROM foresight.entity_links WHERE workspace_id=$1 AND source_id=$2",
    [result.workspaceId, rows[0].id],
  );
  assert.deepEqual(links.map((l) => l.relation).sort(), [
    "legacy-audit",
    "migrated-from",
  ]);
});
