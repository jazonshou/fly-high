import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The browser-mode WebGPU project (vitest.gpu.config.ts) owns tests/gpu/.
    exclude: ["tests/gpu/**", "**/node_modules/**"],
    passWithNoTests: false,
    reporters: ["default"],
    // A timeout catches a hung test; it is not a performance budget. Vitest's
    // 5 s default is one, in effect: the heaviest deterministic sweeps here run
    // ~2.6 s locally, and shared CI runners are roughly 3x slower, so they
    // cross 5 s on hardware speed alone. Raising it costs nothing — a genuinely
    // hung test never finishes — and stops the suite failing by machine.
    // Sweeps needing more than this set their own (see tests/world.test.ts).
    testTimeout: 30_000,
  },
});

