import vinext from "vinext";
import { defineConfig } from "vite";
import { checkoutCacheDir } from "./scripts/checkoutCacheDir";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    // Every worktree shares one node_modules, so Vite's default cache would be
    // shared too, and a dev server started in one tree re-optimized the deps
    // under a server already running in another. See scripts/checkoutCacheDir.ts.
    cacheDir: checkoutCacheDir("dev"),
    ...(isCodexSeatbeltSandbox
      ? { server: { watch: { useFsEvents: false, usePolling: true } } }
      : {}),
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
