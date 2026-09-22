import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Vite cache directory for ONE checkout of this repository and one kind of
 * run in it. Every Vite and Vitest config takes its `cacheDir` from here.
 *
 * Every worktree resolves `node_modules` to the same directory, so a fixed
 * `cacheDir` ("node_modules/.vite-gpu", or Vite's default "node_modules/.vite")
 * is one cache shared by every checkout. Vite hashes the project `root` into
 * the optimizer's metadata, so each run from a different checkout finds the
 * other's metadata stale and re-optimizes over it. When a live dev server or
 * GPU run from the first checkout is serving that directory at the time, it
 * has its modules swapped underneath it: "Must call super constructor",
 * "CascadedShadowMap is not supported by the current engine", a pipeline that
 * fails to read 'buffers' — none of which is the code under test.
 *
 * The key is the checkout's RESOLVED path, so one tree reached by two
 * spellings (`/tmp` and `/private/tmp`) keeps one cache. The readable name in
 * front of the hash is for whoever lists `node_modules` to find a dead tree's
 * cache. `kind` keeps the projects within one checkout apart as well: dev,
 * the Node suite, GPU and perf have different module graphs.
 *
 * The directory is absolute, so a config whose Vite `root` is not the checkout
 * (the static build's `static/`) or that lives below it (`tests/*.config.ts`)
 * still lands beside the others.
 */
export function cacheDirFor(kind: string, checkout: string): string {
  if (!/^[a-z][a-z0-9-]*$/u.test(kind)) {
    throw new RangeError(`A cache kind is lower-case letters, digits and '-'; got ${JSON.stringify(kind)}`);
  }
  const resolved = realpathSync(checkout);
  const key = createHash("sha256").update(resolved).digest("hex").slice(0, 10);
  const name = basename(resolved).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  return join(checkout, "node_modules", `.vite-${kind}-${name ? `${name}-` : ""}${key}`);
}

/** This file's own checkout: it lives in `<checkout>/scripts/`. */
const CHECKOUT = fileURLToPath(new URL("..", import.meta.url));

/** {@link cacheDirFor} this checkout. */
export function checkoutCacheDir(kind: string): string {
  return cacheDirFor(kind, CHECKOUT);
}
