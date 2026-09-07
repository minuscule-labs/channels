import { defineConfig, devices } from "@playwright/test";

const channelsPort = Number(process.env.MINU_TEST_CHANNELS_PORT ?? 58410);
const controlPort = Number(process.env.MINU_TEST_CONTROL_PORT ?? 58411);
const webPort = Number(process.env.MINU_TEST_WEB_PORT ?? 58412);
const fixturePort = Number(process.env.MINU_TEST_FIXTURE_PORT ?? 58413);
const serviceToken = "browser-fixture-service-token";

export default defineConfig({
  testDir: "./test-browser",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: `http://minu-channels.localhost:${webPort}`,
    trace: "retain-on-failure",
    extraHTTPHeaders: { authorization: `Bearer ${serviceToken}` },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node test-browser/fixture-server.mjs",
      port: channelsPort,
      env: {
        MINU_TEST_CHANNELS_PORT: String(channelsPort),
        MINU_TEST_CONTROL_PORT: String(controlPort),
        MINU_TEST_FIXTURE_PORT: String(fixturePort),
        MINU_TEST_WEB_PORT: String(webPort),
        MINU_TEST_CHANNELS_SERVICE_TOKEN: serviceToken,
      },
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${webPort} --strictPort`,
      port: webPort,
      env: {
        VITE_CHANNELS_PROXY_TARGET: `http://127.0.0.1:${channelsPort}`,
        VITE_CHANNELS_CONTROL_PROXY_TARGET: `http://127.0.0.1:${controlPort}`,
        MINU_CHANNELS_SERVICE_TOKEN: serviceToken,
      },
      reuseExistingServer: false,
      timeout: 20_000,
    },
  ],
});
