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
  },
});

