import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { checkoutCacheDir } from "./scripts/checkoutCacheDir";

export default defineConfig({
  // Vite's default cache is the one the dev server uses, in the node_modules
  // every worktree shares. See scripts/checkoutCacheDir.ts.
  cacheDir: checkoutCacheDir("node"),
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The browser-mode WebGPU project (vitest.gpu.config.ts) owns tests/gpu/,
    // and the perf-capture project (vitest.perf.config.ts) owns tests/perf/.
    exclude: ["tests/gpu/**", "tests/perf/**", "**/node_modules/**"],
    passWithNoTests: false,
    reporters: ["default"],
    // A timeout catches a hung test; it is not a performance budget. Vitest's
    // 5 s default is one, in effect, and so was the 30 s this stood at until
    // 2026-09-30: the cockpit ray-grid tests run 11 to 23 s each inside the
    // full suite on the M2 Pro, shared CI runners are two to three times
    // slower, and three of them crossed 30 s there on hardware speed alone
    // (31.8 s for one that takes 15.7 s here). Raising it costs nothing — a
    // genuinely hung test never finishes — and stops the suite failing by
    // machine. Sweeps needing more than this set their own (see
    // tests/world.test.ts).
    testTimeout: 120_000,
  },
});

