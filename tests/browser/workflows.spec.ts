import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
const text =
  "Pump P2 stopped. Water was rising near the east sump. No injury reported.";
const shot = async (page: any, name: string) => {
  mkdirSync("docs/screenshots", { recursive: true });
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    window.scrollTo(0, 0);
    document.querySelector("dialog")?.scrollTo(0, 0);
  });
  await page.screenshot({
    path: `docs/screenshots/${name}.png`,
    fullPage: true,
  });
};
test("report → unavailable extraction → manual review → fresh assessment → case → muster → water comparisons", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Command Centre", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Submit evidence" }).click();
  await page.getByLabel("Original report", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Save report and sync" }).click();
  await expect(page.locator(".fs-report-item")).toHaveCount(1);
  await page.locator(".fs-report-item").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => !!document.activeElement?.closest("dialog")),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.locator(".fs-report-item").click();
  await page
    .getByRole("button", {
      name: "Extract proposed facts with configured model",
    })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Extraction unavailable",
  );
  await page.getByLabel("Category", { exact: true }).selectOption("drainage");
  await page
    .getByLabel("Observed condition / interpretation")
    .fill("Pump P2 stopped; water rising requires review.");
  await page
    .getByLabel("Serious standalone condition", { exact: false })
    .check();
  await shot(page, "report-review");
  await page
    .getByRole("button", { name: "Accept reviewed facts and assess" })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("link", { name: "Command Centre", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Drainage control needs review" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Observation time unknown",
  );
  await page.getByRole("button", { name: "Open linked response case" }).click();
  await expect(page.getByRole("dialog")).toContainText("Manage case");
  await page.getByRole("button", { name: "Close detail panel" }).click();
  await shot(page, "command-concern");
  await page
    .getByRole("link", { name: "People and Response", exact: true })
    .click();
  await page.getByRole("tab", { name: "Cases and actions" }).click();
  await page.locator(".fs-case-row").click();
  await page
    .getByLabel("Decision / reopening / correction reason")
    .fill("Supervisor acknowledges the reported drainage issue.");
  await page.getByRole("button", { name: "acknowledged", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("revision");
  await page
    .getByLabel("Completed corrective action")
    .fill(
      "Backup pump inspected during fictional drill; field verification still needed.",
    );
  await page.getByRole("button", { name: "Record completed action" }).click();
  await expect(page.getByRole("dialog")).toContainText("Backup pump inspected");
  await shot(page, "response-case");
  await page.getByRole("button", { name: "Close detail panel" }).click();
  await page.getByRole("tab", { name: "Human muster" }).click();
  await page.getByRole("button", { name: "Start human muster" }).click();
  await expect(
    page.getByRole("button", { name: "Confirm present" }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Confirm present" }).click();
  await expect(
    page.locator(".fs-tag").filter({ hasText: "accounted-for" }),
  ).toBeVisible();
  await shot(page, "human-muster");
  const workspaceBeforeLab = await page.evaluate(async () => {
    const state = await (await fetch("/api/workspace/state")).json();
    return state.entities.filter((e: any) =>
      ["observation", "assessment", "worker", "case", "muster"].includes(
        e.kind,
      ),
    );
  });
  await page.getByRole("link", { name: "Simulator Lab", exact: true }).click();
  await page.getByRole("button", { name: "Clone current workspace" }).click();
  await page
    .getByLabel("External inflow (m³/hour)", { exact: true })
    .fill("30");
  await page.getByLabel("Horizon (hours)", { exact: true }).fill("24");
  await page
    .getByLabel("I reviewed these fictional assumptions", { exact: false })
    .check();
  await page.getByRole("button", { name: "Run baseline", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Calculated water outcomes" }),
  ).toBeVisible({ timeout: 30000 });
  const original = await page.locator(".fs-lab-metrics").innerText();
  await page
    .getByRole("button", { name: "Run with backup", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Calculating scenario" }),
  ).not.toBeVisible({ timeout: 30000 });
  await expect(
    page.getByRole("heading", { name: "Calculated water outcomes" }),
  ).toBeVisible();
  await expect(page.locator(".fs-saved-run")).toHaveCount(2);
  const changed = await page.locator(".fs-lab-metrics").innerText();
  expect(changed).not.toEqual(original);
  const options = page
    .getByLabel("Compare with completed run")
    .locator("option");
  await page
    .getByLabel("Compare with completed run")
    .selectOption((await options.nth(1).getAttribute("value")) as string);
  await expect(page.locator("svg.fs-water-chart polyline")).toHaveCount(2);
  await shot(page, "simulator-comparison");
  const workspaceAfterLab = await page.evaluate(async () => {
    const state = await (await fetch("/api/workspace/state")).json();
    return state.entities.filter((e: any) =>
      ["observation", "assessment", "worker", "case", "muster"].includes(
        e.kind,
      ),
    );
  });
  expect(workspaceAfterLab).toEqual(workspaceBeforeLab);
  await page.getByLabel("Backup P2 start delay (hours)").fill("8");
  await expect(
    page.getByText("Inputs changed.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Mine Map", exact: true }).click();
  await page.getByLabel("Laboratory overlay").selectOption({ index: 1 });
  await shot(page, "mine-map");
  await page.getByRole("tab", { name: "Reconstructed area" }).click();
  await expect(
    page.getByRole("heading", { name: "No reconstruction imported" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("cross-workspace access, duplicate submissions, offline queue restart and old bookmarks", async ({
  browser,
}) => {
  const first = await browser.newContext(),
    second = await browser.newContext();
  const a = await first.newPage(),
    b = await second.newPage();
  await a.goto("/");
  await b.goto("/");
  await expect(
    a.getByRole("heading", { name: "Command Centre", exact: true }),
  ).toBeVisible();
  await expect(
    b.getByRole("heading", { name: "Command Centre", exact: true }),
  ).toBeVisible();
  const wa = await a.evaluate(
    async () => await (await fetch("/api/workspace/state")).json(),
  );
  const wb = await b.evaluate(
    async () => await (await fetch("/api/workspace/state")).json(),
  );
  expect(wa.workspace.id).not.toEqual(wb.workspace.id);
  const denied = await b.evaluate(
    async (id) =>
      (
        await fetch("/api/workspace/state", {
          headers: { "X-Workspace-Id": id },
        })
      ).status,
    wa.workspace.id,
  );
  expect(denied).toBe(403);
  const duplicate = await a.evaluate(async (text) => {
    const key = crypto.randomUUID();
    const send = () =>
      fetch("/api/workspace/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ text, zoneId: "zone-b" }),
      }).then((r) => r.json());
    return [await send(), await send()];
  }, text);
  expect(duplicate[0].id).toEqual(duplicate[1].id);
  await a.goto("/#workers");
  await expect(
    a.getByRole("heading", { name: "People and Response", exact: true }),
  ).toBeVisible();
  await a.goto("/#evidence");
  await expect(
    a.getByRole("heading", { name: "Evidence", exact: true }),
  ).toBeVisible();
  await a.waitForFunction(() => !!navigator.serviceWorker?.controller);
  await a.waitForTimeout(1000);
  await first.setOffline(true);
  await a
    .getByLabel("Original report", { exact: true })
    .fill("Offline fictional report: east pump stopped.");
  await a.getByRole("button", { name: "Save report and sync" }).click();
  await expect(
    a.getByText("reports · pending", { exact: false }),
  ).toBeVisible();
  await a.reload();
  await expect(
    a.getByText("reports · pending", { exact: false }),
  ).toBeVisible();
  await first.setOffline(false);
  await a.getByRole("button", { name: "Retry pending sync" }).click();
  await expect(a.locator(".fs-report-item")).toHaveCount(2);
  await a.reload();
  await expect(a.locator(".fs-report-item")).toHaveCount(2);
  const leak = await b.evaluate(
    async () => await (await fetch("/api/workspace/state")).json(),
  );
  expect(leak.entities.filter((e: any) => e.kind === "report")).toHaveLength(0);
  await first.close();
  await second.close();
});
test("narrow mobile and tablet navigation stays within viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Command Centre", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page.getByRole("link", { name: "Evidence", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Evidence", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await shot(page, "mobile-reporting");
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/#simulator");
  await expect(
    page.getByRole("heading", { name: "Simulator Lab", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
