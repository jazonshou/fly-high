import { defineConfig } from "vitest/config";

/** Isolated pure-module test config; it intentionally omits the app's worker plugins. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/world*.test.ts"],
  },
});
