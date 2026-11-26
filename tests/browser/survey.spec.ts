import { expect, test } from "@playwright/test";
// Phase 9: surveyor features through the real worker (ezdxf, rasterio).
// Run through `npm run test:demo`.
test.skip(!process.env.DEMO_E2E, "Run with npm run test:demo");
test.setTimeout(180_000);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");
const dxf =
  "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n" +
  [["DRIVES", 0, 0, 100, 0], ["DRIVES", 100.02, 0, 100.02, 60], ["DRIVES", 100.02, 61.5, 100.02, 90], ["NOTES", 0, 0, 5, 5]]
    .map(([l, a, b, c, d]) => `0\nLINE\n8\n${l}\n10\n${a}\n20\n${b}\n30\n0\n11\n${c}\n21\n${d}\n31\n0\n`)
    .join("") +
  "0\nENDSEC\n0\nEOF\n";

test("base map aligned under the plan, a subsidence mark raises a concern, a DXF becomes a draft only after confirmations", async ({ page }) => {
  await page.goto("/#mine");
  await expect(page.getByRole("heading", { name: "Mine", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Surface" }).click();
  // 1. Base map: bounds come from the file; it is shown only after alignment is confirmed.
  await page.getByLabel("Upload GeoTIFF base map").setInputFiles("tests/fixtures/orthophoto-utm36s.tif");
  const maps = page.getByLabel("Base maps", { exact: true });
  await expect(maps).toContainText("covers E 310000–310300, N 8000000–8000200", { timeout: 30_000 });
  await expect(maps).toContainText("5.00 m pixels");
  await maps.getByRole("button", { name: "Align to the plan" }).click();
  await page.getByLabel("Easting of the plan origin (m)").fill("310000");
  await page.getByLabel("Northing of the plan origin (m)").fill("8000100");
  await expect(page.getByRole("button", { name: "Align and show" })).toBeDisabled();
  await page.getByLabel(/Both the plan and the map are in metres/).check();
  await page.getByRole("button", { name: "Align and show" }).click();
  await expect(maps).toContainText("shown");
  await expect(page.locator("svg.fs-plan image")).toHaveCount(1);
  // 2. A mark placed on the plan near the East drive (plan 210, 20) is recorded with a photo and raises a concern.
  await page.locator("svg.fs-plan").scrollIntoViewIfNeeded();
  const at = await page.evaluate(() => {
    const svg = document.querySelector("svg.fs-plan") as SVGSVGElement;
    const p = svg.createSVGPoint();
    p.x = 210 + 40; // plan x + 40 padding (training mine minX = -40)
    p.y = 220 - 20; // maxY (180 + 40) - plan y
    const q = p.matrixTransform(svg.getScreenCTM()!);
    return { x: q.x, y: q.y };
  });
  await page.mouse.click(at.x, at.y);
  const form = page.getByLabel("New subsidence mark");
  await expect(form).toContainText("New subsidence mark at x");
  await form.getByLabel("What was seen").fill("Open crack above the East development drive");
  await form.getByLabel(/Photo/).setInputFiles({ name: "crack.png", mimeType: "image/png", buffer: PNG });
  await form.getByRole("button", { name: "Record mark" }).click();
  const marks = page.getByLabel("Subsidence marks", { exact: true });
  await expect(marks).toContainText("near East development", { timeout: 15_000 });
  await expect(marks).toContainText("raised a concern for review");
  await expect(marks.getByRole("img", { name: /Photo of: Open crack/ })).toBeVisible();
  await page.getByRole("link", { name: "Concerns", exact: true }).click();
  await page.getByRole("tab", { name: /^Concerns:/ }).click();
  await expect(page.getByRole("heading", { name: "New subsidence mark" })).toBeVisible();
  // 3. DXF import: nothing is joined without a tick, and no draft exists before both confirmations.
  await page.goto("/#mine");
  await page.getByRole("tab", { name: "Import" }).click();
  await page.getByLabel("Choose a DXF file").setInputFiles({ name: "level-1.dxf", mimeType: "application/dxf", buffer: Buffer.from(dxf) });
  const imp = page.getByLabel("DXF import");
  await expect(imp).toContainText("The file says its unit is m", { timeout: 30_000 });
  await expect(imp.getByRole("button", { name: "Detect centrelines" })).toBeDisabled(); // unit not chosen yet
  await imp.getByLabel("Use layer NOTES").uncheck(); // annotation layer: not a centreline
  await imp.getByLabel("Drawing unit").selectOption("m");
  await imp.getByRole("button", { name: "Detect centrelines" }).click();
  await expect(imp).toContainText("5 junctions", { timeout: 30_000 });
  await expect(imp).toContainText("3 tunnels");
  await expect(imp).toContainText("2 separate parts are not connected");
  await expect(imp).toContainText("is 1.5 m from a line end");
  await imp.getByLabel(/NM1/).check();
  await imp.getByRole("button", { name: "Rebuild with these connections" }).click();
  await expect(imp).toContainText("4 junctions", { timeout: 30_000 });
  await expect(imp).not.toContainText("separate parts are not connected");
  const create = imp.getByRole("button", { name: "Create a draft revision" });
  await expect(create).toBeDisabled();
  await imp.getByLabel(/The drawing is in m/).check();
  await expect(create).toBeDisabled();
  await imp.getByLabel(/I have reviewed how elevations are handled/).check();
  await create.click();
  await expect(page.getByRole("status").filter({ hasText: "Draft revision created from the DXF" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("tab", { name: "Edit", selected: true })).toBeVisible();
});
