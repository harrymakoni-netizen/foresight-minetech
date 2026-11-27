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
    launchOptions: {
      args: ["--no-sandbox"],
      // Optional: reuse a pre-installed Chromium when the pinned Playwright
      // browser build is not downloaded (e.g. sandboxed CI containers).
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
        : {}),
    },
  },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "outputs/playwright-report" }],
  ],
  outputDir: "outputs/browser-results",
});
