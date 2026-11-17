import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { checkoutCacheDir } from "./scripts/checkoutCacheDir";
import { commitStamp } from "./scripts/commitStamp";

/**
 * The app's one build: the dev server (`npm run dev`), the production bundle
 * (`npm run build`) that CI deploys to GitHub Pages, and its local preview
 * (`npm run start`). A plain client bundle: `static/index.html` mounts
 * `FlightGame` through `static/main.tsx`.
 *
 * `PAGES_BASE` must match the site's URL prefix. GitHub project pages are served
 * from `/<repo>/`, so CI sets it; the default of `/` keeps local runs working.
 */
export default defineConfig({
  root: fileURLToPath(new URL("./static", import.meta.url)),
  // Not Vite's default, which every worktree's node_modules would share.
  cacheDir: checkoutCacheDir("app"),
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
  server: { port: 3000 },
  preview: { port: 3000 },
  build: {
    outDir: fileURLToPath(new URL("./dist-pages", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
  },
});
