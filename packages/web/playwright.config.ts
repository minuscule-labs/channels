import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test-browser",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5174",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node test-browser/fixture-server.mjs",
      port: 4310,
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      command: "pnpm dev",
      port: 5174,
      reuseExistingServer: false,
      timeout: 20_000,
    },
  ],
});
