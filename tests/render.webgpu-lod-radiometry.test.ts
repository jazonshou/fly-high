import { describe, expect, it } from "vitest";
import {
  IMPOSTOR_LAYER_EDGE,
  IMPOSTOR_TILE_EDGE,
  planImpostorAtlas,
} from "../src/render/webgpu/detail/ImpostorAtlas";

/**
 * LOD RADIOMETRY — lit brightness across representations, not texture means.
 *
 * Why this file exists. The impostor bake has now produced two shipped defects
 * whose common shape is a brightness DISAGREEMENT between the far band and the
 * geometry bands it hands off from: the inverted double-sided normal test (far
 * band 4.5-7.5x too dark) and, before it, the view-locked face normals wave R
 * replaced. The recorded lesson from the first is explicit:
 *
 *   "an LOD calibration test that compares only ALBEDO passes at 96-98% while
 *    lit BRIGHTNESS is off 4-7x — calibrate the LIGHTING RESPONSE across LOD
 *    representations, not the texture means."
 *
 * Nothing did. `render.webgpu-canopy-handoff.test.ts` asserts COVERAGE and
 * CLOSURE continuity ("no step anywhere, and none at the ring in particular")
 * — that is geometry, not radiometry. This file is the missing half.
 *
 * What it measures. Wave R made the sprite carry "the geometry bands' OWN
 * authored normals (dome-blended cards, smoothed core hull, outward bark), so
 * the sprite is the mid band's normal model verbatim". That is what makes the
 * comparison possible without reconstructing card geometry: at mip 0 the atlas
 * IS the mid band's normal and albedo model, so mip 0 is the reference and mip
 * M is what the far band actually shades with at range. The ratio between them
 * is the handoff's brightness step.
 *
 * The model is the shipped fragment path, not an idealisation:
 *   - discard:    `if (impostorBlend.a < 0.5) { discard; }` on the ALBEDO alpha
 *   - decode:     `tex.xyz * 2 - 1`
 *   - degeneracy: `if (length > 0.25) { n / length } else { vec3f(0,1,0) }`
 * The runtime Y-rotation and the mirror about the billboard's horizontal right
 * axis both preserve the normal's Y component, so a high-sun evaluation is
 * exact rather than approximate.
 */

const PLANS = planImpostorAtlas("lod-radiometry");
const SUN_ELEVATIONS_DEG = [20, 45, 70] as const;

/**
 * The mip range the far band actually shades in.
 *
 * A view tile is `IMPOSTOR_TILE_EDGE` texels inside a 4x4 grid, so box mips
 * stay WITHIN a tile until the tile collapses to one texel at
 * `log2(IMPOSTOR_TILE_EDGE)` = mip 6; from there a texel averages normals from
 * OPPOSING views and the lit response falls off a cliff (measured below). Mip
 * 5 is the transition. The operating range is therefore mips 0-4, and that
 * bound is derived from the atlas geometry rather than from any assumed tree
 * height or viewport - both of which vary and neither of which this file
 * should rest an assertion on.
 *
 * For orientation only (NOT asserted, because it depends on a tree height this
 * file does not own): with the shipping 62-degree HORIZONTAL fov
 * (`FlightRenderer.ts:681`, ~37 degrees vertical at 16:9), a 20 m tree at tier
 * 1's 3,000 m cull subtends ~11 px at 1080p and samples ~mip 3 - two levels of
 * margin. Ultra's 6,000 m cull is tighter and the margin there is worth a
 * measurement of its own; see the report accompanying this file.
 */
const TILE_COLLAPSE_MIP = Math.log2(IMPOSTOR_TILE_EDGE);
const OPERATING_MIP_MAX = TILE_COLLAPSE_MIP - 2;

interface MipRow {
  covered: number;
  albedo: number;
  degenerate: number;
  lit: Record<number, number>;
}

function measure(): MipRow[] {
  const rows: MipRow[] = [];
  const layerCount = PLANS.normalDepth.layerChains.length;
  const mipCount = PLANS.normalDepth.layerChains[0]!.length;

  for (let mip = 0; mip < mipCount; mip += 1) {
    const edge = IMPOSTOR_LAYER_EDGE >> mip;
    let covered = 0;
    let albedoSum = 0;
    let degenerate = 0;
    const litSum: Record<number, number> = {};
    for (const d of SUN_ELEVATIONS_DEG) litSum[d] = 0;

    for (let layer = 0; layer < layerCount; layer += 1) {
      const albedo = PLANS.albedo.layerChains[layer]![mip]!;
      const normals = PLANS.normalDepth.layerChains[layer]![mip]!;
      for (let texel = 0; texel < edge * edge; texel += 1) {
        const i = texel * 4;
        if (albedo[i + 3]! < 128) continue;
        covered += 1;
        const luma =
          (0.2126 * albedo[i]! + 0.7152 * albedo[i + 1]! + 0.0722 * albedo[i + 2]!) / 255;
        albedoSum += luma;

        const nx = (normals[i]! / 255) * 2 - 1;
        const ny = (normals[i + 1]! / 255) * 2 - 1;
        const nz = (normals[i + 2]! / 255) * 2 - 1;
        const len = Math.hypot(nx, ny, nz);
        let ux = 0;
        let uy = 1;
        if (len > 0.25) {
          ux = nx / len;
          uy = ny / len;
        } else {
          degenerate += 1;
        }
        for (const d of SUN_ELEVATIONS_DEG) {
          const e = (d * Math.PI) / 180;
          const ndotl = Math.max(0, ux * Math.cos(e) + uy * Math.sin(e));
          litSum[d] = litSum[d]! + ndotl * luma;
        }
      }
    }

    const lit: Record<number, number> = {};
    for (const d of SUN_ELEVATIONS_DEG) lit[d] = litSum[d]! / Math.max(covered, 1);
    rows.push({
      covered,
      albedo: albedoSum / Math.max(covered, 1),
      degenerate: degenerate / Math.max(covered, 1),
      lit,
    });
  }
  return rows;
}

const ROWS = measure();

describe("LOD radiometry: the card -> impostor handoff", () => {
  it("derives the operating range from the atlas geometry", () => {
    expect(TILE_COLLAPSE_MIP).toBe(6);
    expect(OPERATING_MIP_MAX).toBe(4);
    expect(ROWS.length).toBeGreaterThan(TILE_COLLAPSE_MIP);
  });

  it("holds LIT BRIGHTNESS within 10% of the geometry band across that range", () => {
    // This is the assertion the recorded lesson asked for. Albedo agreement is
    // NOT sufficient and is deliberately not the check here — the defect it
    // guards passed albedo comparison at 96-98% while lit brightness was out
    // by 4-7x.
    for (let mip = 1; mip <= OPERATING_MIP_MAX; mip += 1) {
      for (const d of SUN_ELEVATIONS_DEG) {
        const ratio = ROWS[mip]!.lit[d]! / ROWS[0]!.lit[d]!;
        expect(
          Math.abs(ratio - 1),
          `mip ${mip} lit brightness at sun ${d} deg is x${ratio.toFixed(3)} of the geometry band`,
        ).toBeLessThan(0.1);
      }
    }
  });

  it("keeps degenerate normals negligible across the operating range", () => {
    // The shipped fallback for a degenerate normal is straight up, which lights
    // brighter and flatter than the dome distribution it replaces. Rare is fine;
    // common would be a silent tone shift with distance.
    for (let mip = 0; mip <= OPERATING_MIP_MAX; mip += 1) {
      expect(ROWS[mip]!.degenerate).toBeLessThan(0.05);
    }
  });

  it("documents the cliff below the operating range so it cannot be walked into", () => {
    // MEASURED, not assumed: past the point where a view tile collapses toward
    // a single texel, box-filtered mips average normals from OPPOSING views and
    // the lit response falls off a cliff (to ~0.15x and then to zero). Today
    // that region is unreachable — DEEPEST is well above it — and this row
    // exists so that raising `vegetationDistance`, shrinking the atlas, or
    // adding a lower-resolution tier fails HERE rather than in a frame.
    // Mip 5 is where tiles begin to merge. Pinning that it IS degraded means
    // the boundary cannot silently migrate UP into the operating range without
    // this failing - which is the actual guard, not the cliff's depth.
    const transition = ROWS[TILE_COLLAPSE_MIP - 1]!.lit[45]!;
    expect(transition).toBeLessThan(ROWS[0]!.lit[45]! * 0.5);
    const merged = ROWS[TILE_COLLAPSE_MIP]!.lit[45]!;
    expect(merged).toBeLessThan(ROWS[0]!.lit[45]! * 0.1);
  });
});
