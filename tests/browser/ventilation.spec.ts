import { expect, test } from "@playwright/test";
// Phase 10: ventilation through the real worker. The training mine's ventilation
// values are fictional and recorded as assumed.
test.skip(!process.env.DEMO_E2E, "Run with npm run test:demo");
test.setTimeout(120_000);
test("fan failure stops the airflow; gas and re-entry are screening estimates; unverified status is stated", async ({ page }) => {
  await page.goto("/#scenarios");
  await expect(page.getByRole("heading", { name: "Scenarios", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Ventilation" }).click();
  const builder = page.getByLabel("Ventilation scenario builder");
  await expect(builder).toContainText("North adit fan (30 m³/s)");
  await builder.getByLabel(/Estimate gas dilution/).check();
  await expect(builder).toContainText("There are no defaults here");
  await builder.getByLabel("Release in tunnel").selectOption("T5");
  await builder.getByLabel("Release rate (m³/s of gas)").fill("0.01");
  await builder.getByLabel("Concentration limit (% by volume)").fill("0.05");
  await builder.getByLabel(/Estimate re-entry time/).check();
  await builder.getByLabel(/Starting concentration after the blast/).fill("1");
  await builder.getByLabel("Tunnel that feeds the area with air").selectOption("T4");
  await builder.locator("details", { hasText: "Tunnels in the work area" }).getByLabel(/T5 East development face/).check();
  await builder.getByRole("button", { name: "Run ventilation scenario" }).click();
  const results = page.getByLabel("Ventilation results");
  await expect(results).toContainText("✓ converged", { timeout: 60_000 });
  await expect(page.getByLabel("Verification status")).toContainText("has not yet been checked against a published textbook worked example");
  await expect(results).toContainText("lose all flow");
  // Baseline: the fan moves its entered 30 m³/s.
  await page.getByRole("button", { name: "Baseline", exact: true }).click();
  await expect(page.locator(".fs-3d-clock")).toContainText("Baseline");
  await expect(results.locator("tr", { hasText: "T13" }).first()).toContainText("30.00"); // baseline column
  await expect(results.locator("tr", { hasText: "T13" }).first()).toContainText("stops in the scenario");
  await expect(results).toContainText("Re-entry estimate (screening)");
  await expect(results).toContainText("does not clear");
  await expect(results).toContainText("full mixing");
});

test("natural ventilation: the helper works out a pressure from the user's own readings and the run reports it", async ({ page }) => {
  await page.goto("/#scenarios");
  await page.getByRole("tab", { name: "Ventilation" }).click();
  const builder = page.getByLabel("Ventilation scenario builder");
  await builder.getByText(/Natural ventilation pressure/).click();
  await builder.getByLabel("Vertical height (m)").fill("100");
  await builder.getByLabel("Cold column temperature (°C)").fill("10");
  await builder.getByLabel("Warm column temperature (°C)").fill("30");
  await builder.getByLabel("Surface air pressure (Pa)").fill("101325");
  await expect(builder).toContainText("≈ 80.7 Pa");
  await builder.getByRole("button", { name: "Add natural pressure" }).click();
  await builder.getByLabel("Pressure (Pa)", { exact: true }).fill("80.7");
  await builder.getByRole("button", { name: "Run ventilation scenario" }).click();
  const results = page.getByLabel("Ventilation results");
  await expect(results).toContainText("✓ converged", { timeout: 60_000 });
  await expect(results).toContainText("natural pressure 80.7 Pa");
});
