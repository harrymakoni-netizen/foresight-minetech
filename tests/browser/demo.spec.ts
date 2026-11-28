import { expect, test, type Page } from "@playwright/test";
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
// Spec §16.2 demo acceptance on the fictional training mine. Run through
// `npm run test:demo` (isolated database, allow-list to +999 test numbers,
// mock SMS gateway, test WhatsApp app secret for signing test webhooks).
test.skip(!process.env.DEMO_E2E, "Run with npm run test:demo");
test.setTimeout(300_000);
const JUDGE = "+99900000001", BUDDY = "+99900000002";
const base = process.env.PREVIEW_URL!;
async function api(page: Page, method: "GET" | "POST", path: string, body?: unknown) {
  const state = await (await page.request.get(base + "/api/workspace/state")).json();
  const r = await page.request.fetch(base + path, {
    method,
    headers: { Origin: base, "Content-Type": "application/json", "Idempotency-Key": "demo-" + randomUUID(), "X-Workspace-Id": state.workspace.id },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(r.ok(), `${path}: ${await r.text()}`).toBeTruthy();
  return r.json();
}
async function whatsapp(page: Page, text: string) {
  const payload = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "demo", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "demo-phone-id" }, messages: [{ from: JUDGE.slice(1), id: "wamid." + randomUUID(), timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }],
  });
  const sig = "sha256=" + createHmac("sha256", process.env.WHATSAPP_APP_SECRET!).update(payload).digest("hex");
  const r = await page.request.post(base + "/api/messaging/whatsapp", { headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, data: payload });
  expect(r.ok()).toBeTruthy();
}
const lastReply = async (page: Page) => {
  const state = await (await page.request.get(base + "/api/workspace/state")).json();
  const out = state.entities.filter((e: any) => e.kind === "message" && e.data.direction === "outbound" && e.data.purpose === "reply").sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt));
  return String(out.at(-1)?.data.text);
};
const tick = (at: Date) => execFileSync(process.execPath, ["--experimental-strip-types", "scripts/messaging-tick.ts", "--at", at.toISOString()], { env: process.env }).toString();

test("demo story: WhatsApp check-in → report → scenario → time to act → overdue SMS → emergency roll", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Underground now", exact: true })).toBeVisible();
  // Setup: bind the test channels; register the judge's and buddy's test phones.
  await api(page, "POST", "/api/gateway", { provider: "whatsapp", channelKey: "demo-phone-id" });
  await api(page, "POST", "/api/gateway", { provider: "smsgate", channelKey: "mock-device" });
  const buddy = await api(page, "POST", "/api/workspace/people", { name: "Buddy Test Phone", phone: BUDDY, role: "miner", channels: { whatsapp: false, sms: true } });
  await api(page, "POST", "/api/workspace/people", { name: "Judge Test Phone", phone: JUDGE, role: "miner", zoneId: "zone-b", defaultBuddyId: buddy.id, channels: { whatsapp: true, sms: true } });

  // 1. The test phone checks in on WhatsApp; the person appears as declared.
  await whatsapp(page, "IN");
  expect(await lastReply(page)).toMatch(/Reply YES to agree/);
  await whatsapp(page, "YES");
  await whatsapp(page, "IN");
  expect(await lastReply(page)).toMatch(/Which shaft\?/);
  await whatsapp(page, "2");
  const back = new Date(Date.now() + 60 * 60e3);
  const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Harare", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(back);
  await whatsapp(page, hhmm);
  expect(await lastReply(page)).toMatch(/1 Buddy Test Phone \(saved\)/);
  await whatsapp(page, "1");
  expect(await lastReply(page)).toMatch(new RegExp(`^Registered: East incline, back by ${hhmm}, buddy Buddy Test Phone\\. Ref [A-Z]\\d+\\.`));
  await page.reload();
  const card = page.getByRole("article", { name: /East incline: 1 declared underground/ });
  await expect(card).toContainText("Judge Test Phone");
  await expect(card).toContainText("Declared underground");
  // Three fictional colleagues declared at the same shaft (manual, in-person consent).
  const state = await (await page.request.get(base + "/api/workspace/state")).json();
  for (const p of state.entities.filter((e: any) => e.kind === "person" && e.data.fictional && e.data.role !== "supervisor")) {
    await api(page, "POST", `/api/workspace/people/${p.id}/consent`, { given: true, note: "Demo: consent recorded in person" });
    await api(page, "POST", "/api/workspace/checkins", { personId: p.id, shaftId: "east-incline", zoneId: "zone-b", expectedReturn: new Date(Date.now() + 4 * 3600e3).toISOString(), buddyPersonId: null, reason: "Demo shift boss declaration" });
  }

  // 2. A report "Pump P1 stopped at East development" is accepted; a concern appears; one click opens a pre-filled scenario.
  await page.getByRole("link", { name: "Concerns", exact: true }).click();
  await page.getByRole("button", { name: "New report" }).click();
  await page.getByLabel("Original report", { exact: true }).fill("Pump P1 stopped at East development.");
  await page.getByLabel("Reported zone").selectOption("zone-b");
  await page.getByRole("button", { name: "Save report and sync" }).click();
  await page.locator(".fs-report-item").first().click();
  await page.getByLabel("Category", { exact: true }).selectOption("drainage");
  await page.getByLabel("Observed condition / interpretation").fill("Pump P1 stopped");
  await page.getByLabel("Equipment identifier (optional)").fill("P1");
  await page.getByLabel("Serious standalone condition", { exact: false }).check();
  await page.getByRole("button", { name: "Accept reviewed facts and assess" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("tab", { name: /^Concerns:/ }).click();
  const concern = page.locator(".fs-concern").first();
  await expect(concern).toContainText("4 declared underground in this zone now");
  await concern.getByRole("link", { name: "Run scenario" }).click();
  await expect(page.getByRole("heading", { name: "Scenarios", exact: true })).toBeVisible();
  await expect(page.getByLabel("Failing pump")).toHaveValue("P1");
  await expect(page.getByLabel("People source")).toHaveValue("current-declarations");

  // 3. The scenario plays; named people show as cut off from assumed starts; totals balance.
  await page.getByLabel("Evacuation ordered at (min)").fill("100");
  await page.getByText("Advanced assumptions").click();
  await page.getByLabel("Pre-movement to (min)").fill("0");
  await page.getByRole("button", { name: "Run scenario" }).click();
  const results = page.locator(".fs-results");
  await expect(results).toContainText("✓ balanced", { timeout: 120_000 });
  await expect(results).toContainText("4 simulated =");
  await expect(results).toContainText("cut off from assumed start in East development");
  await expect(results).toContainText("reached at 1 h 40 min; closes T6, T4");
  await page.getByRole("button", { name: /Route floods: 1 h 40 min/ }).click();
  await expect(page.getByRole("img", { name: /Scenario playback at 1 h 40 min/ })).toBeVisible();
  const cutaway = page.getByRole("button", { name: "Underground cutaway" });
  await cutaway.click();
  await expect(cutaway).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Vertical exaggeration")).toBeDisabled();
  await expect(page.getByLabel("Vertical exaggeration")).toHaveValue("1");
  await expect(page.locator(".fs-3d-clock")).toContainText("2 tunnel(s) closed");
  await expect(page.locator(".fs-3d canvas")).toBeVisible();
  await expect(page.locator(".fs-3d-labels").getByText("T6 · Sump access · closed")).toBeVisible();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await expect(page.getByLabel("Vertical exaggeration")).toHaveValue("3");

  // 4. Time to act reports the latest tested backup start with its search range.
  await page.getByRole("button", { name: "Find latest backup start" }).click();
  await expect(page.locator(".fs-tta-result")).toContainText(/Latest tested backup start under these assumptions: 1 h \d\d min \(searched 1 h 00 min to 2 h 00 min in 13 steps of 5 min\)/, { timeout: 180_000 });

  // 5. Return time passes: the buddy's test phone gets an SMS through the gateway; delivery status shows; a muster opens.
  tick(new Date(back.getTime() + 31 * 60e3));
  const sent = await (await page.request.get(process.env.MOCK_GATEWAY_URL + "/__control/sent")).json();
  const sms = sent.find((m: any) => m.phoneNumbers.includes(BUDDY) && /has not checked out/.test(m.text));
  expect(sms, "buddy SMS reached the gateway").toBeTruthy();
  expect(sent.every((m: any) => [JUDGE, BUDDY].includes(m.phoneNumbers[0])), "only allow-listed numbers").toBeTruthy();
  await page.request.post(process.env.MOCK_GATEWAY_URL + "/__control/deliver/" + sms.id, { data: "{}" });
  tick(new Date(back.getTime() + 61 * 60e3));
  await page.goto("/#underground");
  await page.reload();
  await expect(page.getByRole("article", { name: /East incline/ })).toContainText("Return overdue");
  const alerts = page.locator(".fs-alert-card").filter({ hasText: "Judge Test Phone" });
  await expect(alerts).toContainText("Overdue: buddy alerted");
  await expect(alerts).toContainText("Delivered");
  await expect(alerts).toContainText("Supervisor alerted, muster opened");
  const musters = (await (await page.request.get(base + "/api/workspace/state")).json()).entities.filter((e: any) => e.kind === "muster" && e.data.shaftId === "east-incline");
  expect(musters.length).toBe(1);

  // 6. An emergency is declared; the rescue roll lists the declared people instantly; the incident PDF exports.
  await page.getByRole("button", { name: "Declare emergency" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Shaft").selectOption({ index: 1 });
  await d.getByLabel(/This is a real emergency/).check();
  await d.getByRole("button", { name: "Declare emergency and show rescue roll" }).click();
  const panel = page.locator(".fs-emergency");
  await expect(panel).toContainText("Judge Test Phone");
  await expect(panel).toContainText("Buddy Test Phone");
  await expect(panel).toContainText(JUDGE);
  const href = await panel.getByRole("link", { name: "Export incident PDF" }).getAttribute("href");
  const pdf = await page.request.get(base + href!);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect((await pdf.body()).subarray(0, 8).toString()).toBe("%PDF-1.4");
});
