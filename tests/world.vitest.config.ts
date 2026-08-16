import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Isolated pure-module test config; it intentionally omits the app's worker plugins. */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("..", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/world*.test.ts"],
  },
});
