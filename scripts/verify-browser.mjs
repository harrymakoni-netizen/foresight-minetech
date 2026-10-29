import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { gzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
const baseURL = process.env.PREVIEW_URL || "http://localhost:3001";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();
const bodies = new Map();
page.on("response", async (response) => {
  if (response.url().match(/\/_next\/static\/.*\.js(?:\?|$)/)) {
    try {
      bodies.set(response.url(), await response.body());
    } catch {}
  }
});
await page.goto(baseURL);
await page
  .getByRole("heading", { name: "Command Centre", exact: true })
  .waitFor();
await page.getByRole("link", { name: "Evidence", exact: true }).click();
await page.getByRole("heading", { name: "Evidence", exact: true }).waitFor();
await page.waitForLoadState("networkidle");
const scripts = [...bodies.entries()].map(([url, body]) => ({
  path: new URL(url).pathname,
  bytes: body.length,
  gzipBytes: gzipSync(body).length,
}));
const total = scripts.reduce((sum, s) => sum + s.gzipBytes, 0),
  budget = 350 * 1024;
const scans = [];
for (const [hash, name] of [
  ["evidence", "Evidence"],
  ["people", "People and Response"],
  ["map", "Mine Map"],
  ["simulator", "Simulator Lab"],
  ["overview", "Command Centre"],
]) {
  await page.goto(baseURL + "/#" + hash);
  await page.getByRole("heading", { name, exact: true }).waitFor();
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  scans.push({
    view: hash,
    violations: scan.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        summary: n.failureSummary,
      })),
    })),
    incompleteChecks: scan.incomplete.map((x) => x.id),
  });
}
const result = {
  verifiedAt: new Date().toISOString(),
  baseURL,
  viewport: { width: 1280, height: 900 },
  reportingColdJavascript: {
    gzipBytes: total,
    budgetBytes: budget,
    passed: total <= budget,
    scripts,
  },
  accessibility: scans,
  limitation:
    "Automated browser/axe checks do not prove WCAG conformance. Screen-reader, manual touch and full private-account flows require human review.",
};
writeFileSync(
  "docs/browser-verification.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      gzipBytes: total,
      budgetPassed: total <= budget,
      scans: scans.map((s) => ({
        view: s.view,
        violations: s.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.length,
        })),
      })),
    },
    null,
    2,
  ),
);
await browser.close();
if (
  total > budget ||
  scans.some((s) =>
    s.violations.some((v) => ["critical", "serious"].includes(v.impact)),
  )
)
  process.exitCode = 1;
