import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
  base: process.env.PAGES_BASE ?? "/",
  plugins: [react()],
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
