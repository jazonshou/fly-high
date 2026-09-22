import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cacheDirFor, checkoutCacheDir } from "../scripts/checkoutCacheDir";
import { readSource } from "./support/sourceText";

/**
 * Every worktree of this repository shares one `node_modules`, so a fixed Vite
 * `cacheDir` is shared by every checkout, and Vite re-optimizes it whenever the
 * `root` it was built for changes. Two sessions in two worktrees therefore
 * rebuilt each other's dependency caches under live runs. These guard the fix:
 * the directory is a function of the checkout, and every config uses it.
 */
const checkout = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "checkout-cache-dir-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("a Vite cache directory belongs to one checkout", () => {
  it("gives two checkouts two directories (the positive control: the key does see the root)", () => {
    const first = mkdtempSync(join(scratch, "tree-"));
    const second = mkdtempSync(join(scratch, "tree-"));
    const a = cacheDirFor("gpu", first);
    const b = cacheDirFor("gpu", second);

    expect(a).not.toBe(b);
    expect(basename(a)).not.toBe(basename(b));
    expect(dirname(a)).toBe(join(first, "node_modules"));
    expect(dirname(b)).toBe(join(second, "node_modules"));
  });

  it("gives one checkout one key however its path is spelled", () => {
    const tree = mkdtempSync(join(scratch, "tree-"));
    const alias = join(scratch, "alias");
    symlinkSync(tree, alias);

    expect(basename(cacheDirFor("gpu", alias))).toBe(basename(cacheDirFor("gpu", tree)));
    expect(basename(cacheDirFor("gpu", realpathSync(tree)))).toBe(basename(cacheDirFor("gpu", tree)));
  });

  it("keeps the kinds of run in one checkout apart, and is stable", () => {
    const kinds = ["dev", "node", "gpu", "perf", "static", "sim", "world"];
    const dirs = kinds.map((kind) => cacheDirFor(kind, checkout));

    expect(new Set(dirs).size).toBe(kinds.length);
    expect(cacheDirFor("gpu", checkout)).toBe(cacheDirFor("gpu", checkout));
    expect(() => cacheDirFor("GPU", checkout)).toThrow(RangeError);
    expect(() => cacheDirFor("../gpu", checkout)).toThrow(RangeError);
  });

  it("names the checkout readably, so a dead tree's cache can be found and removed", () => {
    const tree = join(scratch, "Fly High_2");
    mkdirSync(tree);

    expect(basename(cacheDirFor("perf", tree))).toMatch(/^\.vite-perf-fly-high-2-[0-9a-f]{10}$/u);
  });

  it("puts this checkout's caches in this checkout's node_modules", () => {
    const dir = checkoutCacheDir("gpu");

    expect(dirname(dir)).toBe(join(checkout, "node_modules"));
    expect(dir).toBe(cacheDirFor("gpu", checkout));
  });
});

/** Every Vite or Vitest config in the tree, found by walking it — not a list someone must remember to extend. */
function viteConfigs(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/vite(st)?\b.*\.config\.[cm]?[jt]s$/u.test(entry.name)) found.push(relative(checkout, path));
    }
  };
  walk(checkout);
  return found.sort();
}

describe("every Vite and Vitest config uses the checkout's cache", () => {
  const configs = viteConfigs();

  it("finds the configs it guards (not vacuous)", () => {
    expect(configs).toEqual(expect.arrayContaining([
      "tests/sim.vitest.config.ts",
      "tests/world.vitest.config.ts",
      "vite.config.ts",
      "vite.static.config.ts",
      "vitest.config.ts",
      "vitest.gpu.config.ts",
      "vitest.perf.config.ts",
    ]));
  });

  it("sets cacheDir from checkoutCacheDir, with a kind of its own", () => {
    const kinds = configs.map((config) => {
      const source = readSource(join(checkout, config));
      const match = /\bcacheDir:\s*checkoutCacheDir\("([a-z][a-z0-9-]*)"\)/u.exec(source);
      expect(match, `${config} must set cacheDir: checkoutCacheDir("<kind>")`).not.toBeNull();
      expect(source.match(/\bcacheDir\s*:/gu), `${config} sets cacheDir once`).toHaveLength(1);
      return match![1];
    });

    expect(new Set(kinds).size, `kinds must be distinct: ${kinds.join(", ")}`).toBe(configs.length);
  });
});
