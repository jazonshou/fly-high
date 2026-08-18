import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * The perf-capture project (1A-1c).
 *
 * `npm run perf:capture` boots the real FlightRenderer in WebGPU-capable
 * headless Chromium, renders three fixed shots (fixed seed, camera, weather,
 * clock; DPR 1; 1280×720), and writes screenshots plus a numeric report to
 * tests/perf/artifacts, comparing against the committed baselines in
 * tests/perf/baseline. `npm run perf:capture:rebaseline` rewrites the
 * baselines — only at the four sanctioned churn points (1B-2, 1B-3, 1B-9,
 * the 1C-4/5/6 atmosphere rebaseline); any other baseline change is a
 * regression until proven otherwise.
 *
 * Local, real GPU. Run at gate boundaries and before any baseline-churning
 * merge. Deliberately excluded from `npm run verify` and `npm test`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["tests/perf/**/*.test.ts"],
    passWithNoTests: false,
    reporters: ["default"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      provider: playwright({
        launchOptions: {
          channel: "chromium",
          args: [
            "--enable-unsafe-webgpu",
            "--use-angle=metal",
            "--enable-features=WebGPU",
          ],
        },
      }),
      instances: [{ browser: "chromium" }],
    },
  },
});
