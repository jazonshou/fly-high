import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { RENDERED_DENSITY_LAWS } from "../src/render/webgpu/detail/renderedDensity";
import { DETAIL_MEMBERSHIP_SLACK_METERS } from "../src/render/webgpu/detail/presentationBuild";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import type { QualityLevel } from "../src/game/types";
import type { RenderingMode } from "../src/settings";

/**
 * **A KNOWN, UNFIXED DEFECT, pinned so that it cannot move in silence and so
 * that fixing it is visible as a red test rather than as nothing.**
 *
 * Filed 2026-08-31 during the P0 investigation. **It is NOT the defect Jason
 * reported** — that was inverted crown winding, fixed in `bbf3d27`. This was
 * investigated and excluded from his line, and is a separate latent defect.
 *
 * **The collision.** `detailSunShadow()` in `DetailInstanceMaterialPlugin`
 * ends with `smoothstep(maxZ * 0.82, maxZ, viewDepth)`, lifting the far band's
 * shadow term to fully lit over its last stretch. The geometry bands use
 * Babylon's receiver, which has a HARD STOP at `shadowMaxZ` and no fade — the
 * function's own comment says exactly that, and it is why the fade exists: wave
 * R added it to stop the cascade boundary drawing a line on the forest.
 *
 * `shadowMaxZ = profile.shadowDistance` (`FlightRenderer.ts`), so the fade
 * begins at `0.82 × shadowDistance`, while the card bands end at
 * `mid.outerRadiusMeters + DETAIL_MEMBERSHIP_SLACK_METERS`. **At three of four
 * tiers the fade begins BEFORE the cards end, so the far band stops receiving
 * shadow across the same ring where it is still being drawn as cards.**
 *
 * **Two properties make it worse than the ground-level numbers below suggest:**
 * 1. **The overlap widens with altitude.** The fade is keyed on VIEW DEPTH
 *    while the band edges are HORIZONTAL RANGE. For ground at horizontal range
 *    `r` seen from altitude `h`, view depth is `hypot(r, h)`, so the fade
 *    threshold is reached at a progressively SMALLER horizontal range as the
 *    camera climbs — the window opens rather than closing.
 * 2. **It is worst exactly where nobody flies.** Tiers 2 and Ultra have the
 *    widest windows AND `vegetationCastsShadows: true`, so they have the most
 *    shadow to lose. No committed capture shot places this ring on screen at
 *    any tier (verified: at tier 1 the ring sits at 1,148–1,196 m while
 *    `canopy-1200ft`, the shot with the most canopy, reaches only 678 m), so
 *    **the entire regression suite is blind to it.**
 *
 * **Fix direction, recorded because the obvious repair does not work.** The
 * `0.82` cannot be corrected by moving it: the fraction that would close the
 * gap differs per tier and rises with altitude, so no constant works. Re-key
 * the fade to HORIZONTAL RANGE, which is the metric the band edges already
 * use. And do NOT simply delete the fade — it exists to stop the cascade
 * boundary drawing its own line, and removing it reinstates that artifact.
 *
 * Original analysis: `Principle Engineer` session, 2026-08-31. Every number
 * here is re-derived from the tree by this file rather than copied from it.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_SOURCE = readFileSync(
  join(REPO_ROOT, "src/render/webgpu/detail/DetailInstanceMaterialPlugin.ts"),
  "utf8",
);

const TIER_INPUTS: readonly (readonly [QualityLevel, RenderingMode])[] = [
  ["low", "balanced"],
  ["medium", "balanced"],
  ["high", "balanced"],
  ["high", "ultra"],
];

/**
 * Derive the fade fraction from the SHADER, not from a copy of it. If someone
 * retunes the literal, this test re-derives and the pinned overlaps below move
 * with it — which is the whole point: the numbers in the docblock above stay
 * true or the suite says so.
 */
function shadowFadeFraction(): number {
  const match = /smoothstep\(\s*maxZ\s*\*\s*([0-9.]+)\s*,\s*maxZ\s*,\s*viewDepth\s*\)/u.exec(
    PLUGIN_SOURCE,
  );
  if (match === null) {
    throw new Error(
      "detailSunShadow's maxZ smoothstep was not found. If the fade was re-keyed "
        + "(the recorded fix direction is to key it to HORIZONTAL RANGE), delete this "
        + "test and record the fix — do not weaken the pattern to make it pass.",
    );
  }
  const captured = match[1];
  if (captured === undefined) throw new Error("the maxZ smoothstep matched but captured no factor");
  return Number.parseFloat(captured);
}

describe("detail far-band shadow fade vs the card band edge (known defect)", () => {
  it("still reads its fade fraction from the shader", () => {
    expect(shadowFadeFraction()).toBeCloseTo(0.82, 5);
  });

  it("pins the per-tier ground-level overlap between the fade and the card bands", () => {
    const fraction = shadowFadeFraction();
    const rows = TIER_INPUTS.map(([quality, mode], tier) => {
      const profile = resolveWebGpuQualityProfile(quality, mode);
      const fadeStart = profile.shadowDistance * fraction;
      const law = RENDERED_DENSITY_LAWS[tier];
      if (law === undefined) throw new Error(`no rendered-density law for tier ${tier}`);
      const cardsEnd = law.mid.outerRadiusMeters + DETAIL_MEMBERSHIP_SLACK_METERS;
      return {
        tier,
        fadeStart: Math.round(fadeStart),
        cardsEnd,
        overlap: Math.round(cardsEnd - fadeStart),
        castsShadows: profile.vegetationCastsShadows,
      };
    });

    // Ground-level overlap, metres. Positive = the fade begins while cards are
    // still drawn, i.e. the seam is open. Tier 0 is the only one that closes.
    expect(rows.map((r) => r.overlap)).toEqual([-2, 48, 120, 128]);
    expect(rows.map((r) => r.fadeStart)).toEqual([738, 1148, 1476, 1968]);
    expect(rows.map((r) => r.cardsEnd)).toEqual([736, 1196, 1596, 2096]);

    // The two tiers with the widest windows are also the two that cast
    // vegetation shadows, so they have the most shadow to lose. If this ever
    // becomes false the defect's severity ordering has changed.
    expect(rows.filter((r) => r.overlap > 100).every((r) => r.castsShadows)).toBe(true);
  });

  it("keeps the fade the far band's own, not a shared receiver", () => {
    // The comment that justifies the fade's existence. If the fade is re-keyed
    // to horizontal range this can go, but it must not be silently deleted:
    // removing the fade reinstates the cascade line on the forest.
    expect(PLUGIN_SOURCE).toContain("Unlike Babylon's hard stop at shadowMaxZ");
  });
});
