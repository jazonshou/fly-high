import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Kept independent of the app's Vite/Cloudflare plugins so the numerical core
// can be exercised in a plain Node process.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("..", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/sim*.test.ts"],
    // Match the full-suite budget; see vitest.config.ts.
    testTimeout: 30_000,
  },
});
