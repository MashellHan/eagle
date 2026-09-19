import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:26001", trace: "retain-on-failure" },
  webServer: {
    command: "npm run dev -- --port 26001 --mode test",
    url: "http://127.0.0.1:26001",
    reuseExistingServer: false,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
});
