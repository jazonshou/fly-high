import { defineConfig } from "vitest/config";

// Kept independent of the app's Vite/Cloudflare plugins so the numerical core
// can be exercised in a plain Node process.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/sim*.test.ts"],
  },
});

