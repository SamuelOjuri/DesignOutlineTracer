import { defineConfig } from "@playwright/test";
import baseline from "./playwright.config";

const port = Number(process.env.PLAYWRIGHT_ROI_PORT ?? 4181);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid PLAYWRIGHT_ROI_PORT");
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  ...baseline,
  testIgnore: [],
  testMatch: "**/roi-review.spec.ts",
  use: { ...baseline.use, baseURL },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    env: { VITE_ROI_ENABLED: "true", VITE_ROI_API_BASE_URL: "http://127.0.0.1:4199" },
  },
});