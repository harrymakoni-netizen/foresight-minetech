import { expect, test } from "@playwright/test";
// Phase 7: cage and hoist scenario through the real simulation worker.
// Run through `npm run test:demo` (which starts the worker).
test.skip(!process.env.DEMO_E2E, "Run with npm run test:demo");
test.setTimeout(120_000);
test("cage scenario: 10 people, capacity 8, hoist fails at 5 min → ladderway; effect against the baseline", async ({ page }) => {
  await page.goto("/#scenarios");
  await expect(page.getByRole("heading", { name: "Scenarios", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Cage and hoist" }).click();
  const builder = page.getByLabel("Cage scenario builder");
  await expect(builder).toContainText("Cage holds 8");
  await expect(builder).toContainText("ladder climb 900 s");
  // Nobody is declared in a fresh workspace: preflight says so instead of inventing people.
  await builder.getByRole("button", { name: "Check inputs" }).click();
  await expect(builder).toContainText("Nobody is declared underground at Main shaft");
  await builder.getByLabel("Source").selectOption("manual");
  await builder.getByLabel("People at 60 m level").fill("10");
  await builder.getByLabel("Hoist fails at (min)").fill("5");
  await builder.getByRole("button", { name: "Run cage scenario" }).click();
  const results = page.getByLabel("Cage results");
  await expect(results).toContainText("✓ balanced", { timeout: 60_000 });
  // Hand-calculated: cycle = 90 down + 45 load + 90 up + 45 unload = 270 s (unloading taken as equal to loading).
  // Trip 1 carries 8 and is up at 270 s. Failure at 300 s: the 2 waiting climb 900 s -> 1200 s. Baseline: trip 2 up at 540 s.
  await expect(results).toContainText("10 people = 8 by cage + 2 by the ladderway + 0 not reached");
  await expect(results).toContainText("20 min 00 s");
  await expect(results).toContainText("9 min 00 s");
  await expect(results).toContainText("+11 min 00 s later");
  await expect(results).toContainText("same time as loading");
  // Playback: the cage and people are drawn in the 3D mine at the chosen time.
  await page.getByLabel("Scenario time").fill("320");
  await expect(page.locator(".fs-3d-clock")).toContainText("HOIST FAILED");
  await expect(page.locator(".fs-3d-clock")).toContainText("8/10 at surface");
});

test("two cages bring 10 people to the surface in one 270 s cycle", async ({ page }) => {
  await page.goto("/#scenarios");
  await page.getByRole("tab", { name: "Cage and hoist" }).click();
  const builder = page.getByLabel("Cage scenario builder");
  await builder.getByLabel("Source").selectOption("manual");
  await builder.getByLabel("People at 60 m level").fill("10");
  await builder.getByLabel("The hoist fails", { exact: true }).uncheck();
  await builder.getByText("Advanced assumptions", { exact: true }).click();
  await builder.getByLabel("Number of cages (independent, sharing the queues)").fill("2");
  await builder.getByRole("button", { name: "Run cage scenario" }).click();

  const results = page.getByLabel("Cage results");
  await expect(results).toContainText("10 people = 10 by cage + 0 by the ladderway + 0 not reached ✓ balanced", { timeout: 60_000 });
  await expect(results.getByRole("definition").first()).toHaveText("4 min 30 s");
  const trips = results.getByRole("table").first();
  await expect(trips.getByRole("row").filter({ hasText: "4 min 30 s" })).toHaveCount(2);
});
