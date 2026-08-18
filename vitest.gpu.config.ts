import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * The WebGPU-capable test project (0-8).
 *
 * Two Vitest projects on purpose: almost every assertion in Phases 0–1 is a
 * pure function over numbers and belongs in the Node project
 * (vitest.config.ts), where the whole suite runs in seconds. Only shader
 * compilation and CPU/GPU parity need a real adapter, and this project gives
 * them one — headless Chromium through Playwright, with WebGPU enabled over
 * ANGLE Metal.
 *
 * Run with `npm run test:gpu`. Deliberately excluded from `npm run verify`:
 * it needs a machine with a GPU and the Playwright Chromium download. Run it
 * explicitly, and at every gate boundary.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["tests/gpu/**/*.test.ts"],
    passWithNoTests: false,
    reporters: ["default"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Every file creates its own WebGPUEngine; eight concurrent devices on
    // one adapter made screenshot- and timing-sensitive tests fail at random
    // (observed once the 2-8 file landed). The whole suite is seconds long —
    // determinism beats parallelism here.
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      provider: playwright({
        launchOptions: {
          // The chromium-headless-shell has no GPU process; the "chromium"
          // channel selects full Chromium in new-headless mode, which does.
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
