import { expect, test } from "@playwright/test";
// Phase 6: rain forecast, pre-entry check and do-not-enter advisory in the UI.
// Run through `npm run test:demo`, which serves a mock Open-Meteo endpoint
// (documented response shape, not real weather).
test.skip(!process.env.DEMO_E2E, "Run with npm run test:demo");
test.setTimeout(120_000);
test("rain forecast → advisory concern → do-not-enter advisory; failed pre-entry check → shaft concern", async ({ page }) => {
  await page.goto("/#concerns?tab=queue");
  await expect(page.getByRole("heading", { name: "Concerns", exact: true })).toBeVisible();
  const rain = page.getByLabel("Rain forecast", { exact: true });
  await expect(rain).toContainText("No mine location is set");
  await rain.getByRole("button", { name: "Set location" }).click();
  await page.getByLabel(/Latitude/).fill("-17.8");
  await page.getByLabel(/Longitude/).fill("31.05");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(rain).toContainText("No forecast has been retrieved yet");
  await rain.getByRole("button", { name: "Get forecast now" }).click();
  await expect(rain).toContainText("Heavy rain forecast", { timeout: 20_000 });
  await expect(rain).toContainText("14 mm/h");
  await expect(rain).toContainText("21 mm");
  await expect(rain).toContainText("Open-Meteo");
  // The advisory concern appears and carries its rule and evidence.
  await page.getByRole("button", { name: "Assign owner" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Advisory");
  await expect(dialog).toContainText("Rule that fired");
  await expect(dialog).toContainText("Heavy rain forecast");
  await expect(dialog).toContainText("Open-Meteo forecast retrieved");
  // Nothing was sent by itself; an authorised user prepares and confirms.
  await dialog.getByRole("button", { name: "Prepare an advisory" }).click();
  await expect(dialog.getByRole("button", { name: "Send advisory" })).toBeDisabled();
  await dialog.getByLabel("East incline").check();
  await dialog.getByLabel(/I am authorised/).check();
  await dialog.getByRole("button", { name: "Send advisory" }).click();
  await expect(page.getByRole("dialog")).toContainText("Active until");
  await expect(page.getByRole("dialog")).toContainText("sent by");
  await page.getByRole("button", { name: "Close detail panel" }).click();
  // Pre-entry check recorded on the supervisor's behalf: a "no" raises a concern for that shaft.
  await page.getByRole("button", { name: "Record a check" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Shaft").selectOption({ label: "East incline" });
  for (const q of ["roof supports", "loose rock", "water level", "ladderways", "hoist"]) {
    const group = form.locator("fieldset", { hasText: new RegExp(q, "i") });
    await group.getByLabel(q === "ladderways" ? "No" : "Yes", { exact: true }).check();
  }
  await form.getByRole("button", { name: "Record check" }).click();
  await expect(page.getByRole("heading", { name: "Pre-entry check failed at East incline" })).toBeVisible();
  await expect(page.getByLabel("Pre-entry checks", { exact: true })).toContainText("1 no");
});
