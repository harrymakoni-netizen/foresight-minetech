import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.PREVIEW_URL || "http://localhost:3000",
    headless: true,
    trace: "retain-on-failure",
    launchOptions: { args: ["--no-sandbox"] },
  },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "outputs/playwright-report" }],
  ],
  outputDir: "outputs/browser-results",
});
