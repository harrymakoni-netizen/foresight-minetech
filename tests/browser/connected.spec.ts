import { test, expect } from "@playwright/test";

test("fictional failure → changed route over traversal → comparison → linked human response", async ({
  page,
}) => {
  await page.goto("/#simulator");
  await expect(
    page.getByRole("heading", { name: "Simulator Lab", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clone current workspace" }).click();
  await page
    .getByText("Fictional pump-failure exercise", { exact: true })
    .click();
  await page
    .getByRole("button", { name: "Load fictional pump-failure exercise" })
    .click();
  await page
    .getByLabel("I reviewed these fictional assumptions", { exact: false })
    .check();
  await page.getByRole("button", { name: "Run delayed backup (4 h)" }).click();
  const outcome = page.getByRole("region", { name: "Main calculated outcome" });
  await expect(outcome).toContainText("78.00 m³", { timeout: 20000 });
  await expect(outcome).toContainText("2 h 20 min");
  await expect(page.locator(".fs-lab-results")).toContainText(
    "east-south → south-junction → exit",
  );
  const late = await page.evaluate(async () =>
    (await (await fetch("/api/workspace/state")).json()).entities.find(
      (e: any) => e.kind === "run",
    ),
  );
  await page.getByRole("button", { name: "Run earlier backup (1 h)" }).click();
  await expect(outcome).toContainText("6.00 m³", { timeout: 20000 });
  await expect(outcome).toContainText("not crossed in this run");
  await expect(outcome).toContainText("compared with 78.00 m³");
  await expect(page.locator(".fs-lab-results")).toContainText(
    "east-direct → exit",
  );
  const early = await page.evaluate(async () =>
    (await (await fetch("/api/workspace/state")).json()).entities.find(
      (e: any) => e.kind === "run",
    ),
  );
  expect(early.id).not.toBe(late.id);
  expect(early.data.result.inputHash).not.toBe(late.data.result.inputHash);
  await page.getByText("Document a human response", { exact: true }).click();
  await page
    .getByLabel("Response title", { exact: true })
    .fill("Fictional backup pump exercise response");
  await page
    .getByLabel("Response owner", { exact: true })
    .fill("Exercise supervisor");
  await page
    .getByLabel("Human decision and rationale")
    .fill(
      "Plan earlier backup activation and review the route assumption with the supervisor.",
    );
  await page
    .getByRole("button", { name: "Create linked response case" })
    .click();
  await expect(
    page.getByText("Response case saved.", { exact: false }),
  ).toBeVisible();
  const state = await page.evaluate(
    async () => await (await fetch("/api/workspace/state")).json(),
  );
  const response = state.entities.find((e: any) => e.kind === "case");
  expect(response.data.sourceRunId).toBe(early.id);
  expect(response.data.assumptions).toEqual(early.data.scenario);
  expect(state.entities.filter((e: any) => e.kind === "muster")).toHaveLength(
    0,
  );
  expect(
    state.entities.filter((e: any) => e.kind === "assessment"),
  ).toHaveLength(0);
  await page.reload();
  await page
    .getByRole("button", { name: /Primary failure · backup at four hours/ })
    .click();
  await expect(outcome).toContainText("78.00 m³");
  await page.getByLabel("Compare with completed run").selectOption(early.id);
  await expect(outcome).toContainText("compared with 6.00 m³");
  await page.getByRole("link", { name: "Evidence", exact: true }).click();
  await page.getByRole("tab", { name: /Vision/ }).click();
  await expect(
    page.getByRole("button", { name: "Process actual frames" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Inference unavailable", { exact: true }),
  ).toBeVisible();
});
