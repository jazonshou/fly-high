import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { checkoutCacheDir } from "./scripts/checkoutCacheDir";

/**
 * Static-site build used by the GitHub Pages deploy (`npm run build:pages`).
 *
 * Deliberately independent of `vite.config.ts`: that build wires vinext and the
 * Cloudflare plugin to produce a Worker, which Pages cannot host. This one is a
 * plain client bundle over the same `src/` tree.
 *
 * `PAGES_BASE` must match the site's URL prefix. GitHub project pages are served
 * from `/<repo>/`, so CI sets it; the default of `/` keeps local previews
 * (`vite preview --config vite.static.config.ts`) working.
 */
export default defineConfig({
  root: fileURLToPath(new URL("./static", import.meta.url)),
  // Not the default: that would be the dev server's, shared by every worktree.
  cacheDir: checkoutCacheDir("static"),
  base: process.env.PAGES_BASE ?? "/",
  plugins: [react()],
  // `?bench=1` stamps its reports with the commit a Pages build was made from.
  // GitHub Actions sets GITHUB_SHA; a local build stamps null. Declared in
  // src/bench/env.d.ts; no other build defines it.
  define: {
    __FLY_HIGH_COMMIT__: JSON.stringify(process.env.GITHUB_SHA ?? null),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-pages", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
  },
});
