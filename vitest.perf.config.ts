import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * The perf-capture project (1A-1c).
 *
 * `npm run perf:capture` boots the real FlightRenderer in WebGPU-capable
 * headless Chromium, renders the sixteen canonical shots (fixed seed, camera,
 * weather, clock, and viewport per definition), and writes screenshots plus a numeric report to
 * tests/perf/artifacts, comparing against the committed baselines in
 * tests/perf/baseline. The baseline directory is always read-only. A missing
 * or dimension-mismatched committed image is a hard failure.
 *
 * `npm run perf:capture:candidate` runs the exact full canonical set, buffers
 * every image until all visual/performance/renderer validations pass, then
 * writes only a fresh timestamped directory beneath
 * tests/perf/artifacts/rebaseline-candidates for human review. It never
 * promotes or rewrites a committed baseline.
 *
 * Real GPU. A focused tier-1 set runs on renderer PRs; the full set runs on
 * main and on schedule. Deliberately excluded from `npm run verify` and the
 * Node-only `npm test` command.
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
    // 2Z and later terrain phases grew the shot list to sixteen; streaming dominates.
    testTimeout: 1_500_000,
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
