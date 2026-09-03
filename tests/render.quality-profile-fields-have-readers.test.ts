import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";

/**
 * **Every field on `WebGpuQualityProfile` must be READ by something in `src/`.**
 *
 * A tier row is a promise that the tiers differ. A field nothing reads is not a
 * quieter version of that promise — it is a number that looks configured,
 * survives review because it is plausible, and costs the next person the time
 * it takes to discover it was never wired. **That has happened twice on this
 * project in one night:** `Q2`'s atlas rows turned out to be REPORTS rather
 * than allocations, so cutting them freed nothing; and
 * `MOON_PEAK_LIGHT_INTENSITY` was raised 3.3x to brighten moonlit ground and
 * cannot move it at all, because sigma is fed the same scene key the ground
 * renders at.
 *
 * `7-9` is where the risk concentrates: its tier row names clustered-light
 * count and cluster tile/slice resolution, and **nothing in `src/` constructs a
 * `ClusteredLightContainer`** — the symbol appears in three files and all three
 * are comments. So those fields would have been four constants nothing reads,
 * sitting beside four that work, indistinguishable to the next reader.
 *
 * **TWO THINGS THIS GUARD HAS TO GET RIGHT, both of which are how guards of
 * this shape usually fail.**
 *
 *  1. **The field list is derived from the ARTIFACT, never from a roster.** It
 *     comes from `Object.keys` on a resolved profile, so a field added tomorrow
 *     is covered tomorrow. A hand-maintained list would become the stale thing
 *     it exists to prevent.
 *  2. **A comment mentioning a name is not a reader.** Comments are stripped
 *     before scanning — which is exactly the case above, where three files
 *     "mention" the container and none constructs one. A loose grep would pass
 *     on the very case this exists to catch.
 *
 * And the first test below is the INSTRUMENT: it feeds the detector a name that
 * cannot possibly be read and fails if the detector claims it is. Without that
 * leg, a scanner that matched everything would report a clean sweep.
 *
 * **Known limit, stated rather than discovered:** a field read only by code
 * that is itself dead would pass here. This guard proves a field is REFERENCED,
 * not that the reference is reachable — a stronger claim would need call-graph
 * analysis, and the failure it catches (a constant with no reader at all) is
 * the one that has actually cost time twice.
 */

const SRC = "src";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** Block and line comments removed, so a mention in prose cannot count as a read. */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(^|[^:])\/\/[^\n]*/gu, "$1 ");
}

/**
 * The defining file is SCANNED TOO, and excluding it was a real bug in this
 * guard's first cut: it reported `frameTargetMs` as inert, when in fact
 * `hitchThresholdMilliseconds` reads `profile.frameTargetMs * 2` inside
 * `QualityProfile.ts` and `FlightRenderer` calls that function. A field whose
 * only reader lives beside its declaration is still wired.
 *
 * Excluding the file is unnecessary anyway: the pattern below matches a
 * property ACCESS (`.name`), which a `readonly name: number;` declaration and a
 * `name: 13.7,` literal both fail to match. The declaration cannot vouch for
 * itself.
 */
const SCANNED = sourceFiles(SRC).map((path) => stripComments(readFileSync(path, "utf8")));

/** Files that READ `name` as a property, comments already stripped. */
function readerCount(name: string): number {
  const pattern = new RegExp(String.raw`(\.${name}\b|\["${name}"\]|\['${name}'\])`, "u");
  return SCANNED.filter((code) => pattern.test(code)).length;
}

/** The artifact: whatever the shipping resolver actually returns. */
const PROFILE_FIELDS = Object.keys(resolveWebGpuQualityProfile("medium", "balanced"));

describe("every quality-profile field has a reader in src/", () => {
  it("INSTRUMENT — the detector reports an unread name as unread", () => {
    // Without this, a scanner with a too-permissive pattern would report a
    // clean sweep over every field and prove nothing at all.
    expect(readerCount("aFieldNoProfileHasEverHad")).toBe(0);
    // And it must find one that genuinely exists, or it is matching nothing.
    expect(readerCount("tier")).toBeGreaterThan(0);
  });

  it("INSTRUMENT — a name that appears ONLY in a comment is not counted as read", () => {
    // SYNTHETIC ON PURPOSE. This leg used `ClusteredLightContainer` as its live
    // example of "mentioned in three files, constructed in none" — and 7-4b then
    // constructed one, retiring the example. Naming a different live symbol only
    // defers the same retirement to whoever builds that one, so the fixture is
    // now a string this file owns and nothing in the codebase can invalidate.
    const inComment = [
      "// the plan says to read .aSyntheticProfileField eventually",
      "/* and .aSyntheticProfileField is discussed here too */",
      "const unrelated = 1;",
    ].join("\n");
    const inCode = "const value = profile.aSyntheticProfileField * 2;";

    const mentions = (code: string): boolean =>
      new RegExp(String.raw`\.aSyntheticProfileField\b`, "u").test(stripComments(code));

    expect(mentions(inComment), "a commented mention was counted as a reader").toBe(false);
    expect(mentions(inCode), "a real property access was not counted as a reader").toBe(true);
    // And the stripping must not be so aggressive that it eats the code: a
    // guard that deleted everything would also report no readers anywhere.
    expect(stripComments(inCode)).toContain("profile.aSyntheticProfileField");
  });

  it("the field list is non-vacuous and comes from the resolved profile", () => {
    expect(PROFILE_FIELDS.length).toBeGreaterThan(20);
    expect(PROFILE_FIELDS).toContain("tier");
    expect(PROFILE_FIELDS).toContain("shadowMapSize");
  });

  it("THE GUARD — no profile field is inert", () => {
    const unread = PROFILE_FIELDS.filter((name) => readerCount(name) === 0);
    expect(
      unread,
      `these quality-profile fields are READ BY NOTHING in src/: ${unread.join(", ")}. `
      + "A tier field nothing consumes is a number that looks configured and is not. "
      + "Either wire it, or do not land it until the system it governs exists.",
    ).toEqual([]);
  });
});
