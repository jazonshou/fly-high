import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every tarball in the lockfile must resolve to the public npm registry.
 *
 * Installing through a mirroring or proxying registry rewrites `resolved` to
 * that mirror's host. npm substitutes the locally configured registry on the
 * way back in, so the damage is invisible on the machine that made it — but CI
 * has no route to a private mirror and `npm ci` dies there, historically with
 * npm's unhelpful "Exit handler never called!" rather than a network error.
 *
 * Rewriting the host is safe: `integrity` still pins the exact tarball bytes,
 * so a substituted artifact fails the hash check instead of installing.
 */
const PUBLIC_REGISTRY = "registry.npmjs.org";

const lockfile = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
) as { packages: Record<string, { resolved?: string; integrity?: string }> };

describe("package-lock.json is installable from a clean network", () => {
  it("resolves every package to the public npm registry", () => {
    const foreign = Object.entries(lockfile.packages)
      .filter(([, entry]) => entry.resolved !== undefined)
      .map(([name, entry]) => ({ name, host: new URL(entry.resolved!).host }))
      .filter(({ host }) => host !== PUBLIC_REGISTRY);

    expect(
      foreign,
      `These packages resolve to a registry CI cannot reach:\n` +
        foreign.map(({ name, host }) => `  ${name} -> ${host}`).join("\n") +
        `\n\nRewrite the hosts back to ${PUBLIC_REGISTRY} (versions and ` +
        `integrity hashes must stay untouched), or re-resolve with:\n` +
        `  npm install --package-lock-only --registry=https://${PUBLIC_REGISTRY}/\n`,
    ).toEqual([]);
  });

  it("pins an integrity hash for every resolved package", () => {
    const unpinned = Object.entries(lockfile.packages)
      .filter(([, entry]) => entry.resolved !== undefined && !entry.integrity)
      .map(([name]) => name);

    expect(unpinned).toEqual([]);
  });
});
