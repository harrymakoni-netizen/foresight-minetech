import { test, expect } from "@playwright/test";
import { query, closeDatabase } from "../../lib/server/db.ts";
test("actual persisted role denies closure and writes; browser role fields cannot elevate access", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Command Centre", exact: true }),
  ).toBeVisible();
  const state = await page.evaluate(
    async () => await (await fetch("/api/workspace/state")).json(),
  );
  await query(
    "UPDATE foresight.memberships SET role=$1 WHERE workspace_id=$2",
    ["viewer", state.workspace.id],
  );
  try {
    const denied = await page.evaluate(async () => {
      const response = await fetch("/api/workspace/cases/unknown/transition", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          role: "administrator",
          expectedRevision: 1,
          status: "closed",
          reason: "Unauthorized browser attempted closure",
          verificationIds: [],
        }),
      });
      return { status: response.status, body: await response.json() };
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("ROLE_REQUIRED");
  } finally {
    await query(
      "UPDATE foresight.memberships SET role=$1 WHERE workspace_id=$2",
      ["supervisor", state.workspace.id],
    );
    await closeDatabase();
  }
  const invalid = await page.evaluate(async () => {
    const response = await fetch("/api/workspace/reports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        text: "Fictional time input.",
        zoneId: "zone-b",
        observedAt: "2026-10-17T10:00:00",
      }),
    });
    return response.status;
  });
  expect(invalid).toBe(422);
  const worker = await page.evaluate(
    async () =>
      (
        await fetch("/api/vision/events", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Job-Token": "invalid",
          },
          body: JSON.stringify({
            jobId: "1265f185-1d7e-471a-a500-44851530b5fd",
            event: {},
          }),
        })
      ).status,
  );
  expect([403, 404]).toContain(worker);
});
test("GLB format validation, private import and viewer plumbing use a labelled synthetic mesh", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Command Centre", exact: true }),
  ).toBeVisible();
  const document = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [-1, -1, 0],
        max: [1, 1, 0],
      },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const raw = JSON.stringify(document),
    json = Buffer.from(
      raw + " ".repeat((4 - (Buffer.byteLength(raw) % 4)) % 4),
    ),
    bin = Buffer.alloc(36);
  [-1, -1, 0, 1, -1, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4));
  const buffer = Buffer.alloc(12 + 8 + json.length + 8 + bin.length);
  buffer.write("glTF");
  buffer.writeUInt32LE(2, 4);
  buffer.writeUInt32LE(buffer.length, 8);
  buffer.writeUInt32LE(json.length, 12);
  buffer.writeUInt32LE(0x4e4f534a, 16);
  json.copy(buffer, 20);
  buffer.writeUInt32LE(bin.length, 20 + json.length);
  buffer.writeUInt32LE(0x004e4942, 24 + json.length);
  bin.copy(buffer, 28 + json.length);
  const metadata = {
    zoneId: "zone-b",
    title: "Synthetic triangle — viewer test, not reconstruction",
    source: "Mathematically generated test geometry; no captured area",
    captureAt: "2026-10-17T10:00:00Z",
    consent: true,
    scaleStatus: "unverified",
    metresPerUnit: 1,
    translation: [0, 0, 0],
    rotationRadians: [0, 0, 0],
    registrationResidualM: null,
    referenceNotes: "Software import smoke test only; dimensional use disabled",
  };
  const response = await page.request.post("/api/workspace/assets", {
    headers: { Origin: new URL(page.url()).origin },
    multipart: {
      file: {
        name: "synthetic-test.glb",
        mimeType: "model/gltf-binary",
        buffer,
      },
      metadata: JSON.stringify(metadata),
    },
  });
  expect(response.status()).toBe(201);
  const asset = await response.json();
  const download = await page.request.get("/api/workspace/assets/" + asset.id);
  expect(download.status()).toBe(200);
  expect((await download.body()).subarray(0, 4).toString()).toBe("glTF");
  const invalid = await page.request.post("/api/workspace/assets", {
    headers: { Origin: new URL(page.url()).origin },
    multipart: {
      file: {
        name: "invalid.glb",
        mimeType: "model/gltf-binary",
        buffer: Buffer.from("not a real GLB despite its extension"),
      },
      metadata: JSON.stringify(metadata),
    },
  });
  expect(invalid.status()).toBe(422);
  await page.getByRole("button", { name: "Refresh workspace" }).click();
  await page.getByRole("link", { name: "Mine Map", exact: true }).click();
  await page.getByRole("tab", { name: "Reconstructed area" }).click();
  await expect(
    page.getByText("Walkthrough · scale unverified", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Imported area")).toContainText(
    "Synthetic triangle",
  );
  await expect(page.locator(".fs-reconstruction")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  const reset = page.getByRole("button", { name: "Reset view", exact: true });
  if (await reset.isEnabled()) {
    await page
      .getByRole("button", { name: "Rotate left", exact: true })
      .click();
    await reset.click();
    await expect(page.locator(".fs-reconstruction canvas")).toHaveCount(1);
  } else {
    await expect(page.getByRole("alert")).toContainText(
      "3D rendering unavailable",
    );
  }
});
