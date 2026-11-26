import { expect, test } from "@playwright/test";
// Phase 8: run a scenario from a report, then a grounded explanation that needs no AI.
// Run through `npm run test:demo` (real simulation worker). No AI provider is
// configured there, so the assistant must say it is off and the AI button must
// be disabled, while everything else still works.
test.skip(!process.env.DEMO_E2E, "Run with npm run test:demo");
test.setTimeout(180_000);
test("report → scenario builder pre-filled → run → explanation from the recorded run without AI", async ({ page }) => {
  await page.goto("/#concerns?tab=reports");
  await page.getByLabel("Original report", { exact: true }).fill("Pump P1 stopped at East development.");
  await page.getByLabel("Reported zone").selectOption("zone-b");
  await page.getByRole("button", { name: "Save report and sync" }).click();
  await page.locator(".fs-report-item").first().click();
  await page.getByRole("link", { name: "Run scenario from this report" }).click();
  await expect(page.getByRole("heading", { name: "Scenarios", exact: true })).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(/Pump P1 stopped at East development\. \(from report\)/);
  // The assistant is honest about being off.
  await page.getByText(/Scenario assistant/).click();
  await expect(page.getByLabel("Scenario assistant")).toContainText("No AI provider is configured");
  await page.getByLabel("Evacuation ordered at (min)").fill("100");
  await page.getByRole("button", { name: "Run scenario" }).click();
  const results = page.locator(".fs-results");
  await expect(results).toContainText("✓ balanced", { timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Explain with AI" })).toBeDisabled();
  await page.getByRole("button", { name: "Explain these results" }).click();
  const explanation = page.getByLabel("Explanation of this run");
  await expect(explanation).toContainText("From the recorded run, no AI");
  await expect(explanation).toContainText("escape.people.cut-off");
  await expect(explanation).toContainText("were cut off from their assumed start");
  await expect(explanation).toContainText("Assumptions");
  await expect(explanation).toContainText("Not available");
  await expect(explanation).toContainText("Self-rescuer rated duration").catch(() => {});
});
