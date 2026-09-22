import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { checkoutCacheDir } from "../scripts/checkoutCacheDir";

/** Isolated pure-module test config; it intentionally omits the app's worker plugins. */
export default defineConfig({
  // Not Vite's default, which every worktree shares; see scripts/checkoutCacheDir.ts.
  cacheDir: checkoutCacheDir("world"),
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("..", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/world*.test.ts"],
    // Match the full-suite budget; see vitest.config.ts.
    testTimeout: 30_000,
  },
});
