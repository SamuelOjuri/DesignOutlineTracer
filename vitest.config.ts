import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig({ command: "serve", mode: "test" }),
  defineConfig({
    test: {
      projects: [
        {
          extends: true,
          test: { name: "unit", environment: "node", include: ["src/**/*.test.ts"] },
        },
        {
          extends: true,
          test: { name: "ui", environment: "jsdom", include: ["src/**/*.test.tsx"] },
        },
      ],
    },
  }),
);