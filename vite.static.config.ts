import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { checkoutCacheDir } from "./scripts/checkoutCacheDir";
import { commitStamp } from "./scripts/commitStamp";

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
  // `?bench=1` stamps its reports with the commit a Pages build was made from,
  // which this writes into index.html alone. GitHub Actions sets GITHUB_SHA;
  // a local build writes nothing and its reports name no commit.
  plugins: [react(), commitStamp(process.env.GITHUB_SHA)],
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
