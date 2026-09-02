import { describe, expect, it } from "vitest";
import { createWorld, sampleTerrain } from "../src/world";
import {
  CANOPY_CLOSURE_FILTER_WIDTH_METERS,
  CANOPY_DOMINANT_CROWN_RADIUS_METERS,
  CANOPY_DOMINANT_HEIGHT_METERS,
  CANOPY_MEAN_CROWN_RADIUS_METERS,
  CANOPY_RENDERED_CROWN_AREA_RATIO,
  CANOPY_SURFACE_ALBEDO,
  CANOPY_SURFACE_AMBIENT,
  CANOPY_SURFACE_ROUGHNESS,
  CANOPY_SURFACE_SPECULAR,
  CANOPY_UNDER_SHADE_STRENGTH,
  DETAIL_FAR_CULL_FADE_METERS,
  canopyClosure,
  canopyGrassCover,
  canopyHandoff,
  canopyImpostorCull,
  canopyLiftMeters,
  canopyRenderedShare,
  densityField,
} from "../src/render/webgpu/detail/densityField";
import {
  VEGETATION_CANOPY_HANDOFF_WGSL,
  VEGETATION_DENSITY_FIELD_WGSL,
  VEGETATION_DENSITY_KERNEL_LATTICES,
  VEGETATION_DENSITY_LATTICE_COUNT,
  vegetationLatticeBase,
} from "../src/render/webgpu/detail/densityFieldWgsl";
import {
  CANOPY_CLOSURE_TARGET,
  RENDERED_DENSITY_LAWS,
  crownCoverFromAreas,
  renderedShareAtDistance,
} from "../src/render/webgpu/detail/renderedDensity";
import {
  IMPOSTOR_ALPHA_TEST_THRESHOLD,
  IMPOSTOR_SEASON_BUCKETS,
  leafDissolveSurvives,
  planImpostorAtlas,
} from "../src/render/webgpu/detail/ImpostorAtlas";
import {
  buildCrownFringePrototype,
  buildTreePrototype,
} from "../src/render/webgpu/detail/prototypeGeometry";
import { DETAIL_INSTANCE_VERTEX_SOURCE } from "../src/render/webgpu/detail/DetailInstanceMaterialPlugin";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import { canopyRankOrder } from "../src/render/webgpu/detail/WorldDetailRuntime";
import {
  LAND_COVER_SPLAT_BAKE_WGSL,
  classifyLandCover,
  dominantLandCover,
  type LandCoverInput,
} from "../src/render/webgpu/terrain/LandCoverClassifier";
import { getAirportInfluence } from "../src/world/airport";
import {
  TERRAIN_SURFACE_VERTEX_WGSL,
  TERRAIN_SPARSE_SPLAT_GATHER_WGSL,
} from "../src/render/webgpu/terrain/TerrainSurfacePlugin";
import {
  TERRAIN_KERNEL_LATTICE_COUNT,
  TERRAIN_KERNEL_PAGE_BYTES,
  buildTerrainKernelPageUniform,
  terrainKernelPageBytes,
} from "../src/render/webgpu/terrain/TerrainKernel";
import { SURFACE_MATERIAL_COUNT } from "../src/render/webgpu/terrain/surfaceMaterials";
import type { DetailTerrainSample } from "../src/render/webgpu/detail/types";

/**
 * `6-8` — the canopy/terrain handoff.
 *
 * **What this file is for, stated once.** The plan row's economics are dead
 * (the impostor radius cannot buy back instances: draws scale with chunks ×
 * meshes and a presentation chunk is 4,096 m). What survives is a
 * REPRESENTATION question: the near band draws at most 0.56 of a closed
 * canopy's cover, the impostor band dithers even that away over its last
 * 420 m, and past the impostor radius nothing draws a canopy at all — so the
 * ground has to account for the difference, at every range, without a step
 * anywhere.
 *
 * Three properties are load-bearing and each has a test below:
 *
 * 1. **One owner.** Closure is `densityField`'s, derived from the same Boolean
 *    crown model `renderedDensity` already owns. Terrain reads it; nothing
 *    re-derives it.
 * 2. **Coverage is conserved identically**, not approximately, because the
 *    terrain's share is DEFINED as the residual. A ramp tuned to look
 *    complementary is exactly the bug class wave R spent a wave closing at
 *    this ring (+28% measured luminance step).
 * 3. **The calibration is of the LIGHTING response, not of albedo.** The
 *    recorded lesson: an LOD calibration that compared albedo passed at
 *    96–98% while lit brightness was off 4–7×. The negative control below
 *    shows an albedo-only comparison passing on a canopy whose lit response
 *    is measured 40.5% wrong.
 */

const HECTARE = 10_000;
const CELL_SIZE = 512;
const CLOSURE_SEED = "canopy-handoff";
const REFERENCE_DAY = 171;

// ---------------------------------------------------------------------------
// 1. The closure law, against the rendered-density law and against real stems
// ---------------------------------------------------------------------------

describe("6-8 canopy closure is the density field's, on the rendered law's model", () => {
  it("saturates the RENDERED half exactly at the Gate 2C closure target", () => {
    // The rendered half of the split can never exceed what the near band's cap
    // and the dominant crown radius allow. That ceiling is the same number
    // Gate 2C's criterion is written against, which is what makes the two
    // halves of this programme one law rather than two.
    const law = RENDERED_DENSITY_LAWS[1]!;
    expect(CANOPY_RENDERED_CROWN_AREA_RATIO).toBeCloseTo(
      (law.nearStemsPerHectare * Math.PI * CANOPY_DOMINANT_CROWN_RADIUS_METERS ** 2) / HECTARE,
      12,
    );
    // A saturated field, fully rendered: 1 − exp(−area).
    const renderedCeiling = canopyHandoff(canopyClosure(0.08), 1).renderedCover;
    expect(renderedCeiling).toBeCloseTo(1 - Math.exp(-CANOPY_RENDERED_CROWN_AREA_RATIO), 12);
    expect(renderedCeiling).toBeGreaterThanOrEqual(CANOPY_CLOSURE_TARGET);
    expect(renderedCeiling).toBeLessThan(CANOPY_CLOSURE_TARGET + 0.03);
  });

  it("agrees with the Boolean cover of REAL generated crowns", () => {
    // The closure the ground bakes has to be the cover the plants actually
    // make, or the two systems disagree about the same forest. Measured over
    // real generated cells rather than asserted from the constants.
    const world = createWorld(CLOSURE_SEED);
    const sampler = (x: number, z: number): DetailTerrainSample => {
      const terrain = sampleTerrain(world, x, z);
      return {
        height: terrain.height,
        slope: terrain.normal ? 1 - terrain.normal.y : 0,
        moisture: terrain.moisture,
        biome: terrain.biome,
        normal: terrain.normal,
        airportInfluence: terrain.airportInfluence,
      };
    };
    let best = { closure: 0, cover: 0, cellX: 0, cellZ: 0 };
    for (let cellZ = 2; cellZ < 8; cellZ += 1) {
      for (let cellX = 2; cellX < 8; cellX += 1) {
        const cell = generateDetailCell({
          worldSeed: world.seed,
          cellX,
          cellZ,
          terrainSample: sampler,
          seaLevelMeters: world.seaLevel,
          dayOfYear: REFERENCE_DAY,
          latitudeDegrees: world.latitudeDegrees,
        });
        const ranks = canopyRankOrder(cell.trees);
        const law = RENDERED_DENSITY_LAWS[1]!;
        const share = law.nearStemsPerHectare
          / Math.max(1e-6, cell.trees.length / ((CELL_SIZE * CELL_SIZE) / HECTARE));
        let area = 0;
        cell.trees.forEach((tree, index) => {
          if ((ranks[index] ?? 1) > Math.min(1, share)) return;
          area += Math.PI * tree.crownRadiusMeters ** 2;
        });
        const cover = crownCoverFromAreas(area, CELL_SIZE * CELL_SIZE);
        // The field's own answer at the cell centre, through the density owner.
        const centre = sampler(cellX * CELL_SIZE + 256, cellZ * CELL_SIZE + 256);
        const field = densityField(world.seedHash, {
          x: cellX * CELL_SIZE + 256,
          z: cellZ * CELL_SIZE + 256,
          heightMeters: centre.height,
          seaLevelMeters: world.seaLevel,
          slope: centre.slope,
          moisture: centre.moisture,
          normalX: centre.normal?.x ?? 0,
          normalZ: centre.normal?.z ?? 0,
          airportInfluence: centre.airportInfluence ?? 0,
          dayOfYear: REFERENCE_DAY,
          filterWidthMeters: 0,
        });
        if (field.canopyClosure > best.closure) {
          best = { closure: field.canopyClosure, cover, cellX, cellZ };
        }
      }
    }
    // Non-vacuous: the fixture has to contain a real stand.
    expect(best.closure, "fixture carries a closed stand").toBeGreaterThan(0.5);
    // The RENDERED cover of that stand is the rendered half of the split, and
    // it must land inside the model's own ceiling rather than above it.
    const renderedHalf = canopyHandoff(best.closure, 1).renderedCover;
    expect(best.cover).toBeGreaterThan(renderedHalf * 0.6);
    expect(best.cover).toBeLessThanOrEqual(
      (1 - Math.exp(-CANOPY_RENDERED_CROWN_AREA_RATIO)) + 0.12,
    );
    // eslint-disable-next-line no-console
    console.log(
      `6-8 closure vs real stems: field closure ${best.closure.toFixed(4)}, `
      + `rendered-half ${renderedHalf.toFixed(4)}, measured rendered cover `
      + `${best.cover.toFixed(4)} (cell ${best.cellX},${best.cellZ})`,
    );
  });

  it("keeps the two crown radii the law measured, and their ordering", () => {
    // The whole item exists because these two numbers differ: the authored
    // field's mean crown is 3.40 m and the 70 widest stems per hectare average
    // 5.80 m. If they were equal there would be no deficit and no handoff.
    expect(CANOPY_MEAN_CROWN_RADIUS_METERS).toBeLessThan(CANOPY_DOMINANT_CROWN_RADIUS_METERS);
    const saturated = canopyClosure(0.08);
    expect(saturated).toBeGreaterThan(0.9);
    expect(canopyHandoff(saturated, 1).deficit).toBeGreaterThan(0.3);
  });

  it("suppresses the grass sward under canopy and restores it in the open", () => {
    expect(canopyGrassCover(0.8, 0)).toBeCloseTo(0.8, 12);
    expect(canopyGrassCover(0.8, 1)).toBe(0);
    expect(canopyGrassCover(0.8, 0.5)).toBeCloseTo(0.4, 12);
  });
});

// ---------------------------------------------------------------------------
// 2. Coverage conservation across the far ramp
// ---------------------------------------------------------------------------

describe("6-8 conserves coverage across the whole ramp", () => {
  const law = RENDERED_DENSITY_LAWS[1]!;
  const bands = {
    near: law.near.outerRadiusMeters,
    far: law.far.outerRadiusMeters,
    floor: law.farFloorShare,
  };
  const shareAt = (d: number) => canopyRenderedShare(d, bands.near, bands.far, bands.floor);

  it("is the rendered-density law's own falloff times the LIVE impostor cull", () => {
    // Not a ramp invented for this item: both factors are mechanisms already
    // running. Inside the near band the law's share is 1; the cull window is
    // the plugin's band-code-2 dither, read from the shared constant so the
    // two halves cannot drift apart.
    expect(shareAt(0)).toBe(1);
    expect(shareAt(bands.near)).toBe(1);
    for (const d of [200, 600, 1_100, 2_000, 2_400]) {
      expect(shareAt(d)).toBeCloseTo(renderedShareAtDistance(law, d), 12);
    }
    // The cull window opens exactly DETAIL_FAR_CULL_FADE_METERS before the
    // impostor radius and closes exactly at it.
    expect(shareAt(bands.far - DETAIL_FAR_CULL_FADE_METERS)).toBeCloseTo(
      renderedShareAtDistance(law, bands.far - DETAIL_FAR_CULL_FADE_METERS), 12);
    expect(shareAt(bands.far)).toBe(0);
    expect(shareAt(bands.far + 1)).toBe(0);
  });

  it("splits closure into two halves that sum to it exactly, at every range", () => {
    for (const closure of [0.05, 0.2, 0.45, 0.7, 0.945]) {
      for (let d = 0; d <= 8_000; d += 13) {
        const split = canopyHandoff(closure, shareAt(d));
        expect(split.renderedCover + split.deficit).toBeCloseTo(closure, 12);
        expect(split.shade + split.surface).toBeCloseTo(split.deficit, 12);
        expect(split.deficit).toBeGreaterThanOrEqual(0);
        expect(split.surface).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("has no seam: no step anywhere, and none at the ring in particular", () => {
    // The failure mode this replaces is a measured +28% luminance step at the
    // impostor ring (wave R). Sample the whole sweep at 1 m and record the
    // largest one-metre step in each half, plus the step across the ring.
    const closure = canopyClosure(0.08);
    let worstSurface = 0;
    let worstShade = 0;
    let worstAt = 0;
    let previous = canopyHandoff(closure, shareAt(0));
    for (let d = 1; d <= 8_000; d += 1) {
      const split = canopyHandoff(closure, shareAt(d));
      const surfaceStep = Math.abs(split.surface - previous.surface);
      const shadeStep = Math.abs(split.shade - previous.shade);
      if (surfaceStep > worstSurface) { worstSurface = surfaceStep; worstAt = d; }
      worstShade = Math.max(worstShade, shadeStep);
      previous = split;
    }
    // A metre may not move either half by more than 1% of full closure. The
    // ramp has a real SLOPE — it is the law's own inverse-square falloff, whose
    // steepest point is the near-band boundary — so the property under test is
    // that it has no STEP, which the knot checks below establish directly.
    expect(worstSurface).toBeLessThan(closure * 0.01);
    expect(worstShade).toBeLessThan(closure * 0.01);
    // Every knot in the piecewise definition, checked from both sides at 1 mm:
    // the near-band boundary, the far-floor crossover, the cull window's start,
    // and the impostor radius itself.
    const floorCrossover = bands.near / Math.sqrt(bands.floor);
    for (const knot of [
      bands.near,
      floorCrossover,
      bands.far - DETAIL_FAR_CULL_FADE_METERS,
      bands.far,
    ]) {
      const before = canopyHandoff(closure, shareAt(Math.max(0, knot - 1e-3)));
      const after = canopyHandoff(closure, shareAt(knot + 1e-3));
      expect(
        Math.abs(after.surface - before.surface),
        `surface step across the knot at ${knot.toFixed(1)} m`,
      ).toBeLessThan(1e-4);
      expect(
        Math.abs(after.shade - before.shade),
        `shade step across the knot at ${knot.toFixed(1)} m`,
      ).toBeLessThan(1e-4);
    }
    // The ring in particular: crossing the impostor radius moves nothing,
    // because the cull has already reached zero there. Measured at 1 mm, which
    // is the scale a STEP would show at and a slope would not.
    const inside = canopyHandoff(closure, shareAt(bands.far - 1e-3));
    const outside = canopyHandoff(closure, shareAt(bands.far + 1e-3));
    expect(Math.abs(outside.surface - inside.surface)).toBeLessThan(1e-6);
    expect(outside.surface).toBeCloseTo(closure, 9);
    // eslint-disable-next-line no-console
    console.log(
      `6-8 ramp continuity: worst 1 m surface step ${worstSurface.toExponential(2)} `
      + `at ${worstAt} m (closure ${closure.toFixed(3)}), worst shade step `
      + `${worstShade.toExponential(2)}, ring step `
      + `${Math.abs(outside.surface - inside.surface).toExponential(2)}`,
    );
  });

  it("hands over in the right direction: shade near, surface far", () => {
    const closure = canopyClosure(0.08);
    const atZero = canopyHandoff(closure, shareAt(0));
    const beyond = canopyHandoff(closure, shareAt(bands.far + 100));
    // At the observer the near band draws everything it can, so nothing of the
    // deficit is "canopy you are looking at".
    expect(atZero.surface).toBe(0);
    expect(atZero.shade).toBeGreaterThan(0.3);
    // Past the impostor radius the ground carries the whole canopy and takes
    // no shade from a stand that is no longer drawn.
    expect(beyond.shade).toBe(0);
    expect(beyond.surface).toBeCloseTo(closure, 12);
  });
});

// ---------------------------------------------------------------------------
// 3. The LIGHTING calibration across representations
// ---------------------------------------------------------------------------

/**
 * Lit luminance of one shaded surface under a shared sky.
 *
 * Deliberately crude and deliberately COMPLETE: a direct lobe scaled by the
 * material's own `directIntensity`, an ambient lobe scaled by its
 * `environmentIntensity` (which AO multiplies on the terrain side), and a
 * specular lobe scaled by its `specularIntensity` and narrowed by roughness.
 * The point is not photometric accuracy; it is that all three lobes are
 * present, because the recorded failure is a calibration that compared only
 * the first factor of the first lobe.
 */
function litLuminance(surface: {
  albedo: readonly [number, number, number];
  direct: number;
  ambient: number;
  specular: number;
  roughness: number;
}, sky: { sun: number; ambient: number; nDotL: number }): number {
  const luma = 0.2126 * surface.albedo[0] + 0.7152 * surface.albedo[1] + 0.0722 * surface.albedo[2];
  const diffuse = luma * (surface.direct * sky.sun * sky.nDotL + surface.ambient * sky.ambient);
  // A rough dielectric's specular contribution scales with intensity and falls
  // off with roughness; the exact shape does not matter, its presence does.
  const spec = surface.specular * 0.04 * (1 - surface.roughness) * sky.sun * sky.nDotL;
  return diffuse + spec;
}

describe("6-8 calibrates the LIT response across the handoff, not the albedo", () => {
  const impostorAlbedo = (() => {
    // Measured from the bake, not trusted from the constant: the coverage-
    // weighted mean of the leafed bucket over all species and all sixteen
    // hemi-octahedral views. The atlas is a linear RGBA8 custom texture times
    // an all-white impostor albedoColor, so its raw bytes ARE the albedo.
    const plans = planImpostorAtlas(CLOSURE_SEED);
    let r = 0;
    let g = 0;
    let b = 0;
    let layers = 0;
    for (let layer = 0; layer < plans.albedo.layerCount; layer += IMPOSTOR_SEASON_BUCKETS) {
      const level0 = plans.albedo.layerChains[layer]![0]!;
      let lr = 0;
      let lg = 0;
      let lb = 0;
      let covered = 0;
      for (let i = 0; i < level0.length; i += 4) {
        if (level0[i + 3]! / 255 < IMPOSTOR_ALPHA_TEST_THRESHOLD) continue;
        lr += level0[i]! / 255;
        lg += level0[i + 1]! / 255;
        lb += level0[i + 2]! / 255;
        covered += 1;
      }
      r += lr / covered;
      g += lg / covered;
      b += lb / covered;
      layers += 1;
    }
    return [r / layers, g / layers, b / layers] as const;
  })();

  it("takes the canopy's albedo FROM the impostor bake, within measurement spread", () => {
    // Three seeds measured (0.168-0.171, 0.259-0.264, 0.111-0.114); the
    // constant is the middle of that and the tolerance is the spread.
    for (let channel = 0; channel < 3; channel += 1) {
      expect(
        Math.abs(CANOPY_SURFACE_ALBEDO[channel]! - impostorAlbedo[channel]!),
        `canopy albedo channel ${channel}: constant ${CANOPY_SURFACE_ALBEDO[channel]} `
        + `vs measured ${impostorAlbedo[channel]!.toFixed(4)}`,
      ).toBeLessThan(0.006);
    }
    // eslint-disable-next-line no-console
    console.log(
      `6-8 canopy albedo: measured (${impostorAlbedo.map((v) => v.toFixed(4)).join(", ")}) `
      + `vs constant (${CANOPY_SURFACE_ALBEDO.join(", ")})`,
    );
  });

  it("matches the impostor's LIT luminance across the ring to within a few percent", () => {
    const vegetation = {
      albedo: impostorAlbedo as unknown as readonly [number, number, number],
      // The impostor material's own settings (WorldDetailRuntime): 1.05 direct,
      // 0.62 probe, 0.4 specular, roughness 0.94 — "mirrors the CARD SHELL's
      // response exactly".
      direct: 1.05,
      ambient: 0.62,
      specular: 0.4,
      roughness: 0.94,
    };
    const terrainCanopy = {
      albedo: CANOPY_SURFACE_ALBEDO,
      // Terrain's material is 1.03/1.0/1.0; the canopy's AO factor carries the
      // probe trim because AO multiplies the same term.
      direct: 1.03,
      ambient: 1 * CANOPY_SURFACE_AMBIENT,
      specular: 1 * CANOPY_SURFACE_SPECULAR,
      roughness: CANOPY_SURFACE_ROUGHNESS,
    };
    let worst = 0;
    for (const sky of [
      { sun: 1, ambient: 0.35, nDotL: 0.9 },   // high sun
      { sun: 1, ambient: 0.35, nDotL: 0.25 },  // low sun
      { sun: 0.35, ambient: 0.6, nDotL: 0.5 }, // overcast-ish
      { sun: 0.08, ambient: 0.5, nDotL: 0.1 }, // dusk
    ]) {
      const a = litLuminance(vegetation, sky);
      const b = litLuminance(terrainCanopy, sky);
      worst = Math.max(worst, Math.abs(b - a) / a);
    }
    // Wave R's handoff-line bug measured +28%. The residual here is the two
    // materials' directIntensity difference (1.05 vs 1.03) plus the albedo
    // constant's own rounding.
    expect(worst, `worst lit-luminance mismatch across the ring`).toBeLessThan(0.05);
    // eslint-disable-next-line no-console
    console.log(`6-8 lit-luminance mismatch across the handoff: ${(worst * 100).toFixed(2)}%`);
  });

  it("negative control: an ALBEDO-only check passes a canopy that is 40% too bright", () => {
    // This is the recorded lesson made executable. A terrain canopy that keeps
    // the terrain material's full sky probe (no AO trim) and full specular is
    // ALBEDO-IDENTICAL to the correct one, so an albedo comparison scores 100%
    // — and its lit response is wrong by more than the step wave R spent a
    // whole wave removing.
    const naive = {
      albedo: CANOPY_SURFACE_ALBEDO,
      direct: 1.03,
      ambient: 1,
      specular: 1,
      roughness: CANOPY_SURFACE_ROUGHNESS,
    };
    const vegetation = {
      albedo: CANOPY_SURFACE_ALBEDO,
      direct: 1.05,
      ambient: 0.62,
      specular: 0.4,
      roughness: 0.94,
    };
    // Albedo-only: identical.
    expect(naive.albedo).toEqual(vegetation.albedo);
    const sky = { sun: 0.35, ambient: 0.6, nDotL: 0.5 };
    const error = Math.abs(litLuminance(naive, sky) - litLuminance(vegetation, sky))
      / litLuminance(vegetation, sky);
    expect(error).toBeGreaterThan(0.28);
    // eslint-disable-next-line no-console
    console.log(
      `6-8 negative control: albedo-identical canopy is ${(error * 100).toFixed(1)}% `
      + `off in lit luminance`,
    );
  });

  it("keeps the under-canopy shade on the DIRECT lobe only", () => {
    // QR-2 is a sun occluder, not an ambient one: F5's design, and the same
    // rule 4-7 states for the horizon map ("the ONE thing that must not happen
    // is applying either to direct sunlight" — and its converse).
    const source = Object.values(TERRAIN_SURFACE_VERTEX_WGSL).join("\n");
    expect(source).not.toContain("terrainCanopyDirect");
    expect(CANOPY_UNDER_SHADE_STRENGTH).toBeGreaterThan(0);
    expect(CANOPY_UNDER_SHADE_STRENGTH).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// 4. The coarse-LOD height addition, and where it may NOT apply
// ---------------------------------------------------------------------------

describe("6-8 adds canopy height at coarse LOD only", () => {
  const law = RENDERED_DENSITY_LAWS[1]!;
  const shareAt = (d: number) => canopyRenderedShare(
    d, law.near.outerRadiusMeters, law.far.outerRadiusMeters, law.farFloorShare);

  it("lifts nothing anywhere a stem is still drawn", () => {
    // The APPEARANCE half may take over inside the geometry bands — a forest at
    // 400 m reads as canopy between its thinned stems, which is the picture the
    // law's own falloff asks the ground to complete. The HEIGHT half may not:
    // stems are placed on the UNLIFTED terrain, so lifting ground that still
    // carries drawn trees would sink them into it. This is the one place the
    // two halves deliberately key on different factors, and the test that says
    // so — the first version of this item keyed both on the same weight and
    // this assertion caught it lifting 15.8 m at 400 m.
    const closure = canopyClosure(0.08);
    const far = law.far.outerRadiusMeters;
    for (const d of [0, 50, 149, 150, 400, 1_000, 2_000, far - DETAIL_FAR_CULL_FADE_METERS]) {
      expect(canopyLiftMeters(closure, d, far), `lift at ${d} m`).toBe(0);
      // ...while the appearance half is doing real work over most of that range.
      if (d >= 400) {
        expect(canopyHandoff(closure, shareAt(d)).surface).toBeGreaterThan(0.5);
      }
    }
  });

  it("reaches the canopy's own height only where nothing draws the canopy", () => {
    const closure = canopyClosure(0.08);
    const far = law.far.outerRadiusMeters;
    const lift = canopyLiftMeters(closure, far + 500, far);
    expect(lift).toBeGreaterThan(CANOPY_DOMINANT_HEIGHT_METERS * 0.9);
    expect(lift).toBeLessThanOrEqual(CANOPY_DOMINANT_HEIGHT_METERS);
    // Complementary to the impostor dither, metre for metre: the canopy's
    // volume is drawn exactly once at every range in the window.
    for (let d = far - DETAIL_FAR_CULL_FADE_METERS; d <= far; d += 7) {
      const drawnFraction = canopyImpostorCull(d, far);
      expect(canopyLiftMeters(closure, d, far)).toBeCloseTo(
        CANOPY_DOMINANT_HEIGHT_METERS * closure * (1 - drawnFraction), 9);
    }
    // Open ground is never lifted at any range.
    expect(canopyLiftMeters(0, 10_000, far)).toBe(0);
  });

  it("carries a Nyquist gate on the node's own level, in the shipped vertex code", () => {
    const worldpos = TERRAIN_SURFACE_VERTEX_WGSL.CUSTOM_VERTEX_UPDATE_WORLDPOS ?? "";
    // Levels 0-2 (2-8 m vertex spacing) resolve individual crowns; the gate
    // must be zero there and saturated by level 4 (32 m).
    expect(worldpos).toContain("smoothstep(2.0, 4.0, vertexInputs.terrainNodeA.z)");
    // The lift rides the density owner's own law — the impostor-cull
    // complement, NOT the appearance ramp (see the lift test above).
    expect(worldpos).toContain("vegetationCanopyLiftMeters(");
    expect(worldpos).not.toContain("canopySplit.surface");
    // ...and it repairs vPositionW, which is the whole reason 4-4 avoided this
    // hook for the height displacement.
    expect(worldpos).toContain("vertexOutputs.vPositionW = worldPos.xyz;");
  });

  it("keeps the closure channel LOD-INVARIANT, which is what makes the lift crack-free", () => {
    // Every vegetation lattice declares the FIXED band-limit width, so two
    // pages at different levels weight the canopy channels identically. This
    // is measured on the built uniform, not read off the table.
    for (const lattice of VEGETATION_DENSITY_KERNEL_LATTICES) {
      expect(lattice.filterWidthMetersOverride).toBe(CANOPY_CLOSURE_FILTER_WIDTH_METERS);
    }
    const fine = new Float32Array(buildTerrainKernelPageUniform(
      { seedHash: 1234, originX: 8_192, originZ: -4_096, filterWidthMeters: 4 },
      VEGETATION_DENSITY_KERNEL_LATTICES,
    ));
    const coarse = new Float32Array(buildTerrainKernelPageUniform(
      { seedHash: 1234, originX: 8_192, originZ: -4_096, filterWidthMeters: 128 },
      VEGETATION_DENSITY_KERNEL_LATTICES,
    ));
    const total = TERRAIN_KERNEL_LATTICE_COUNT + VEGETATION_DENSITY_LATTICE_COUNT;
    const scaleBase = total * 4;
    let vegetationDiffers = 0;
    let terrainDiffers = 0;
    for (let index = 0; index < total; index += 1) {
      const weightSlot = scaleBase + index * 4 + 2;
      const same = fine[weightSlot] === coarse[weightSlot];
      if (index >= TERRAIN_KERNEL_LATTICE_COUNT) {
        if (!same) vegetationDiffers += 1;
      } else if (!same) {
        terrainDiffers += 1;
      }
    }
    expect(vegetationDiffers, "vegetation band weights must not move with level").toBe(0);
    // Non-vacuous: the terrain kernel's own lattices DO move with level, which
    // is what the override is an exception to.
    expect(terrainDiffers, "terrain lattices still band-limit per page")
      .toBeGreaterThan(0);
  });

  it("appends its lattices without moving any existing page uniform by a byte", () => {
    expect(terrainKernelPageBytes(0)).toBe(TERRAIN_KERNEL_PAGE_BYTES);
    expect(terrainKernelPageBytes(VEGETATION_DENSITY_KERNEL_LATTICES.length))
      .toBeGreaterThan(TERRAIN_KERNEL_PAGE_BYTES);
    const plain = new Uint8Array(buildTerrainKernelPageUniform(
      { seedHash: 99, originX: 512, originZ: 512, filterWidthMeters: 8 },
    ));
    const extended = new Uint8Array(buildTerrainKernelPageUniform(
      { seedHash: 99, originX: 512, originZ: 512, filterWidthMeters: 8 },
      VEGETATION_DENSITY_KERNEL_LATTICES,
    ));
    expect(plain.byteLength).toBe(TERRAIN_KERNEL_PAGE_BYTES);
    // The kernel's own 34 origin rows and 34 seed entries are untouched; only
    // the scale/kept/seed blocks shift, because the arrays grew.
    const originBytes = TERRAIN_KERNEL_LATTICE_COUNT * 16;
    expect(extended.subarray(0, originBytes)).toEqual(plain.subarray(0, originBytes));
  });

  it("indexes each vegetation channel at its own cumulative base", () => {
    // kFbm reads `count` CONSECUTIVE rows, so a 3-octave channel occupies
    // three slots. The include used to index one slot per named channel, which
    // was invisible while nothing composed it.
    expect(vegetationLatticeBase("province")).toBe(0);
    expect(vegetationLatticeBase("glade")).toBe(3);
    expect(vegetationLatticeBase("succession")).toBe(5);
    expect(vegetationLatticeBase("windthrow")).toBe(7);
    expect(vegetationLatticeBase("shelter")).toBe(8);
    expect(vegetationLatticeBase("treelineWander")).toBe(9);
    expect(VEGETATION_DENSITY_LATTICE_COUNT).toBe(11);
    expect(VEGETATION_DENSITY_KERNEL_LATTICES.length).toBe(11);
    // The two anisotropic channels carry their own shear, and the local offset
    // is sheared with the origin or a page's interior drifts off the lattice.
    expect(VEGETATION_DENSITY_KERNEL_LATTICES[0]!.shearFactor).toBe(0.21);
    expect(VEGETATION_DENSITY_KERNEL_LATTICES[7]!.shearFactor).toBe(0.46);
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain("vegetationShearedX(localX, localZ, 0.21)");
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain("vegetationShearedX(localX, localZ, 0.46)");
  });
});

// ---------------------------------------------------------------------------
// 5. The channel: where it lives, and what it costs
// ---------------------------------------------------------------------------

describe("6-8's closure channel costs no atlas bytes and no fragment sampler", () => {
  it("rides the weight textures' alpha lane in BOTH season buckets", () => {
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain(
      "textureStore(splatWeightLo, texel, vec4f(aligned.weightsLo.xyz, canopy.x));");
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain(
      "textureStore(splatWeightHi, texel, vec4f(aligned.weightsHi.xyz, canopy.x));");
    // Closure is season-invariant, so the fragment's seasonal mix() returns it
    // unchanged; storing a different value per bucket would lerp two different
    // quantities together.
    expect(LAND_COVER_SPLAT_BAKE_WGSL).not.toContain("canopy.y);");
  });

  it("reconstructs the fourth material weight instead of storing it", () => {
    expect(TERRAIN_SPARSE_SPLAT_GATHER_WGSL).toContain(
      "max(0.0, 1.0 - storedLo.x - storedLo.y - storedLo.z)");
    expect(TERRAIN_SPARSE_SPLAT_GATHER_WGSL).toContain(
      "max(0.0, 1.0 - storedHi.x - storedHi.y - storedHi.z)");
    // The bake normalises each bucket, so the residual IS the fourth weight.
    // Worst-case reconstruction error is the other three lanes' quantisation.
    const quantise = (v: number) => Math.round(v * 255) / 255;
    let worst = 0;
    for (let trial = 0; trial < 20_000; trial += 1) {
      const raw = [Math.random(), Math.random(), Math.random(), Math.random()];
      const total = raw.reduce((s, v) => s + v, 0);
      const weights = raw.map((v) => v / total);
      const q = weights.map(quantise);
      const reconstructed = Math.max(0, 1 - q[0]! - q[1]! - q[2]!);
      worst = Math.max(worst, Math.abs(reconstructed - weights[3]!));
    }
    // Three half-ULPs of an 8-bit lane.
    expect(worst).toBeLessThan(3 / 510 + 1e-9);
  });

  it("composes the vegetation density include rather than restating it", () => {
    // 6-8 is the first LIVE composer of the 4-6b include. Before it, the
    // mirror was dead code pinned only by string tests.
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain("vegetationDensity(SPLAT_VEGETATION_LATTICE_BASE");
    expect(LAND_COVER_SPLAT_BAKE_WGSL).not.toContain("VEG_BASE_TREE_STEMS: f32");
    // The handoff include is separate, and carries no lattices at all — the
    // terrain material composes it with no page uniform.
    expect(VEGETATION_CANOPY_HANDOFF_WGSL).not.toContain("kFbm");
    expect(VEGETATION_CANOPY_HANDOFF_WGSL).toContain("VEG_CANOPY_CULL_FADE_METERS: f32 = 420.0");
  });
});

// ---------------------------------------------------------------------------
// 6. Analytic movement, measured
// ---------------------------------------------------------------------------

describe("6-8 moves analytic pixels BY DESIGN, and by a measured amount", () => {
  const world = createWorld("canopy-handoff-analytic");
  const STEP = 137;
  const EDGE = 64;

  function run(withCanopy: boolean): {
    digest: string;
    dominantChanged: number;
    l1: number;
    shares: number[];
    meanClosure: number;
    meanSward: number;
    probes: number;
    reference: string[];
  } {
    const parts: string[] = [];
    const shares = new Array<number>(SURFACE_MATERIAL_COUNT).fill(0);
    let meanClosure = 0;
    let meanSward = 0;
    let probes = 0;
    const reference: string[] = [];
    for (let iz = 0; iz < EDGE; iz += 1) {
      for (let ix = 0; ix < EDGE; ix += 1) {
        const x = ix * STEP - 9_000;
        const z = iz * STEP + 4_000;
        const terrain = sampleTerrain(world, x, z);
        const slope = Math.min(0.999, Math.max(0, 1 - (terrain.normal?.y ?? 1)));
        const field = densityField(world.seedHash, {
          x,
          z,
          heightMeters: terrain.height,
          seaLevelMeters: world.seaLevel,
          slope,
          moisture: terrain.moisture,
          normalX: terrain.normal?.x ?? 0,
          normalZ: terrain.normal?.z ?? 0,
          airportInfluence: terrain.airportInfluence ?? 0,
          dayOfYear: REFERENCE_DAY,
          filterWidthMeters: CANOPY_CLOSURE_FILTER_WIDTH_METERS,
        });
        const base: LandCoverInput = {
          elevationMeters: terrain.height - world.seaLevel,
          slope,
          moisture: terrain.moisture,
          temperature: 0.66 - Math.max(0, terrain.height - world.seaLevel) / 2_450,
          aspect: 0,
          airportInfluence: terrain.airportInfluence ?? 0,
          dayOfYear: REFERENCE_DAY,
          seasonalTemperatureShift: 0,
        };
        const input: LandCoverInput = withCanopy
          ? { ...base, canopyClosure: field.canopyClosure, grassCover: field.grassCover }
          : base;
        const weights = classifyLandCover(input);
        const key = weights.ids
          .map((id, index) => `${id}:${weights.weights[index]!.toFixed(6)}`)
          .join(",");
        parts.push(key);
        reference.push(String(dominantLandCover(weights)));
        weights.ids.forEach((id, index) => {
          shares[id] = (shares[id] ?? 0) + (weights.weights[index] ?? 0);
        });
        meanClosure += field.canopyClosure;
        meanSward += field.grassCover;
        probes += 1;
      }
    }
    let digest = 0x811c9dc5;
    const joined = parts.join("|");
    for (let index = 0; index < joined.length; index += 1) {
      digest ^= joined.charCodeAt(index);
      digest = Math.imul(digest, 0x01000193) >>> 0;
    }
    return {
      digest: (digest >>> 0).toString(16),
      dominantChanged: 0,
      l1: 0,
      shares: shares.map((value) => value / probes),
      meanClosure: meanClosure / probes,
      meanSward: meanSward / probes,
      probes,
      reference,
    };
  }

  const dark = run(false);
  const live = run(true);

  it("is byte-identical to the reconstructed pre-6-8 classifier when the channel is absent", () => {
    // MEASURED, not asserted: the digest of a reconstructed pre-6-8
    // `landCoverSuitabilities` (this file's three canopy gain terms removed)
    // over exactly this probe set. The classification the CPU ecology,
    // species and wildlife rules read is therefore unmoved — only the page
    // splat bake, which is the one caller that supplies the channel, changes.
    //
    // RE-PINNED `d93d3dc2` -> `622c08d1` at `6-13`, and it moved for the SLOPE
    // half, NOT the closure gate. Verified by reverting the slope change alone:
    // with the gate applied and the windows untouched this assertion passes on
    // its old digest, because the gate multiplies by 1.0 for a caller that
    // omits `canopyClosure` — which is every CPU caller, and is the invariant
    // this test exists to hold. What moved it is `gentle` becoming the exact
    // complement of `steep`, a law change that necessarily reaches both the
    // channel-absent and channel-live paths.
    // RE-PINNED `622c08d1` -> `2a43cd2c` for Jason's "brown/grey strips"
    // report. `Sand` carried a constant `+ 0.02` while every other class is a
    // pure product, so wherever the others all fell below 0.02 Sand won — not
    // because the ground is sandy but because nothing else claimed it. Below
    // the `warm` threshold, below the `alpine` onset, on gentle ground, all
    // three gates shut at once, and terrain temperature varying smoothly
    // turned that into a CONTOUR: the strips he saw. The floor moved to Grass.
    //
    // **THE CONSEQUENCE, STATED RATHER THAN LEFT IN THE HASH.** This moves the
    // CPU-visible classification, which is what this assertion exists to
    // flag: measured over 26,460 terrain conditions, Sand 7.7% -> 1.7% with
    // essentially all of it to Grass. **Cold gentle lowland now reads as GRASS
    // to the species, wildlife and ecology rules where it read as BEACH.**
    //
    // That this is ecologically more sensible is an ARGUMENT, not a
    // measurement — mine, approved by the PM, and recorded as such so the next
    // reader can disagree with it. What is measured is only the share.
    //
    // Same amendment path `6-13` used one paragraph above: one law, both
    // readers, re-pinned. The rejected alternative was applying the floor in
    // the splat path alone, which would split one authority into two — the
    // shape that left the memory estimate and the inventory disagreeing.
    expect(dark.digest).toBe("2a43cd2c");
    expect(dark.probes).toBe(EDGE * EDGE);
  });

  it("moves the splat by a recorded amount once the channel is live", () => {
    expect(live.digest).not.toBe(dark.digest);
    // RE-PINNED `95fcbd8c` -> `b3c52bb2` at `6-13`. This one moves for BOTH
    // halves, and the gate half is the point: closure was a GAIN,
    // `(1 + closure * 0.55)`, which is 1.0 at closure 0 — so ForestFloor kept
    // its full `1.1` base on ground with no canopy and beat Grass's ceiling of
    // 1.0 by a permanent 0.100 on every wet lowland. Forest litter was painted
    // where there is no forest. Measured on the shipping bake afterwards:
    // ForestFloor 13.6% of baked texels, against 57.7% of land before.
    expect(live.digest).toBe("266f19ce"); // re-pinned with `2a43cd2c`; same cause, see above
    let changed = 0;
    for (let index = 0; index < dark.reference.length; index += 1) {
      if (dark.reference[index] !== live.reference[index]) changed += 1;
    }
    const share = changed / dark.reference.length;
    // The direction is the correction: this transect carries a mean crown
    // cover of ~0.08, and the pre-6-8 classifier still spent ~0.30 of its
    // weight on forest floor — forest floor where no forest stands.
    expect(live.shares[2]!).toBeLessThan(dark.shares[2]!);
    expect(live.shares[1]!).toBeGreaterThan(dark.shares[1]!);
    // Bounded: still a retune, not a new classifier — but the bound now spans
    // TWO changes and must not be read as 6-8's alone. 6-8 measured 18.19% of
    // probes changing dominant material; with `6-13`'s closure gate and slope
    // partition on top it is 35.7%, so roughly two thirds of probes still keep
    // their material. Raised from 0.35 to 0.40 to cover both, and stated here
    // rather than ratcheted to whatever passes: if a later change pushes this
    // toward 0.5 the claim "retune, not rewrite" has stopped being true and
    // the number should be argued, not moved.
    expect(share).toBeLessThan(0.40);
    // eslint-disable-next-line no-console
    console.log(
      `6-8 analytic splat movement over ${dark.probes} probes: dominant material `
      + `changes ${(share * 100).toFixed(2)}%; forest floor `
      + `${dark.shares[2]!.toFixed(4)} -> ${live.shares[2]!.toFixed(4)}, grass `
      + `${dark.shares[1]!.toFixed(4)} -> ${live.shares[1]!.toFixed(4)}; mean closure `
      + `${live.meanClosure.toFixed(4)}, mean sward ${live.meanSward.toFixed(4)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. QR-4, re-verified against the representation that replaced it
// ---------------------------------------------------------------------------

describe("QR-4 (the seasonal fringe halo), re-verified while in the handoff", () => {
  /**
   * **Verdict: MOOT in its recorded form; the mechanism it named no longer
   * exists, and its successor is discharged by construction.**
   *
   * QR-4 was recorded against `2-12`'s representation: near-band FRINGE cards
   * dissolved by leaf fraction over an OPAQUE HULL that contracted
   * geometrically, so a partly-shed broadleaf could carry a sparse card halo
   * outside its contracted silhouette. Wave T inverted that: the hull became a
   * hidden interior CORE at 0.62 of the skeleton's envelope, and the card shell
   * became the whole visible canopy. There is no longer a hull silhouette for
   * cards to sit outside of — the cards ARE the silhouette at every leaf
   * fraction, and they thin in place, which is what a shedding tree does.
   *
   * The successor question is the inverse one: can the CONTRACTING core ever
   * escape the shell, or can a surviving card ever be left with nothing behind
   * it? Both are answered below from the shipped prototypes rather than by
   * argument.
   */
  const SPECIES = ["oak", "maple", "birch", "willow"] as const;

  it("keeps the interior core strictly inside the card shell at every shed level", () => {
    for (const species of SPECIES) {
      const prototype = buildTreePrototype(species, 0, 7, "near");
      const shell = buildCrownFringePrototype(species, 0, 7);
      // The core's authored radius is already inside the shell's, and the
      // shed contracts it FURTHER (the opaque-crown vertex path scales x/z by
      // the leaf fraction, floored at 0.08). Contraction is monotone, so the
      // authored case bounds every shed case.
      expect(
        prototype.crown.boundingRadius,
        `${species}: interior core inside the card shell`,
      ).toBeLessThan(shell.boundingRadius);
      for (const leafFraction of [1, 0.7, 0.4, 0.2, 0.08]) {
        const contracted = prototype.crown.boundingRadius * Math.max(0.08, leafFraction);
        expect(contracted).toBeLessThan(shell.boundingRadius);
      }
    }
  });

  it("leaves every surviving card standing on bark that does NOT shed", () => {
    // The card shell is grown from the same skeleton as the bark tubes, and
    // the bark part carries no seasonal contraction at all — only the opaque
    // core does. So a card that survives the dissolve at any leaf fraction
    // still has drawn branch geometry inside it: the halo's second precondition
    // ("cards outside any geometry") cannot arise either.
    for (const species of SPECIES) {
      const prototype = buildTreePrototype(species, 0, 7, "near");
      const shell = buildCrownFringePrototype(species, 0, 7);
      expect(
        prototype.envelopeRadius,
        `${species}: one shared radial contract covers the shell`,
      ).toBeGreaterThanOrEqual(shell.boundingRadius - 1e-6);
      expect(prototype.trunk.boundingHeight).toBeGreaterThan(0.3);
    }
    // The seasonal contraction is applied under DETAIL_OPAQUE_CROWN only — the
    // core's define — and the card path sheds by dissolve, never by scale.
    const vertex = Object.values(DETAIL_INSTANCE_VERTEX_SOURCE).join("\n");
    expect(vertex).toContain("#ifdef DETAIL_OPAQUE_CROWN");
    expect(vertex).toContain("detailDenseScale = max(0.08, clamp(vertexInputs.instanceTint.a");
  });

  it("sheds cards and impostor texels by ONE dissolve rule", () => {
    // The other half of the original residual: the near cards and the far
    // impostor must agree about which leaves are gone, or the handoff line
    // reappears seasonally. Both run the same uv-cell hash at 40 cells.
    for (const fraction of [1, 0.62, 0.3, 0.05]) {
      let survivors = 0;
      const total = 40 * 40;
      for (let cellY = 0; cellY < 40; cellY += 1) {
        for (let cellX = 0; cellX < 40; cellX += 1) {
          if (leafDissolveSurvives((cellX + 0.5) / 40, (cellY + 0.5) / 40, fraction)) {
            survivors += 1;
          }
        }
      }
      // The dissolve keeps roughly `fraction` of the cells — it is a threshold
      // on a uniform hash, so the survival rate IS the leaf fraction.
      expect(survivors / total).toBeGreaterThanOrEqual(Math.max(0, fraction - 0.12));
      expect(survivors / total).toBeLessThanOrEqual(Math.min(1, fraction + 0.12));
    }
  });
});

// ---------------------------------------------------------------------------
// D-18: the closure channel described a DIFFERENT WORLD than the renderer draws
// ---------------------------------------------------------------------------

describe("6-8's closure channel reads the world the renderer actually plants", () => {
  /**
   * A world has TWO seeds, and the vegetation is not keyed on the terrain one.
   *
   * `createWorld`'s guaranteed-airport search replaces `world.seedHash` with the
   * chosen region's; every plant is placed from `hashSeed(String(world.seed))`
   * — `world.sourceSeedHash` — which `FlightRenderer` states outright where it
   * builds `GroundCoverSystem`. `6-8` appended the vegetation density field's
   * lattices to the TERRAIN kernel's page uniform, where they inherited the
   * terrain seed, so the baked canopy-closure channel described a forest that
   * is not the one standing on the ground.
   */
  it("keys the APPENDED vegetation lattices on their own authority's seed", () => {
    const world = createWorld("phase1-perf-baseline");
    // The defect is only visible in a world whose two seeds differ, which is
    // exactly what a guaranteed-airport search produces.
    expect(world.seedHash).not.toBe(world.sourceSeedHash);

    const shared = { originX: 1_024, originZ: -2_048, filterWidthMeters: 4 };
    const inherited = new Uint8Array(buildTerrainKernelPageUniform(
      { seedHash: world.seedHash, ...shared }, VEGETATION_DENSITY_KERNEL_LATTICES));
    const explicit = new Uint8Array(buildTerrainKernelPageUniform(
      { seedHash: world.seedHash, extraSeedHash: world.seedHash, ...shared },
      VEGETATION_DENSITY_KERNEL_LATTICES));
    const routed = new Uint8Array(buildTerrainKernelPageUniform(
      { seedHash: world.seedHash, extraSeedHash: world.sourceSeedHash, ...shared },
      VEGETATION_DENSITY_KERNEL_LATTICES));

    // Omitting the override is byte-identical: no existing consumer moves.
    expect(Array.from(explicit)).toEqual(Array.from(inherited));
    // A kernel-only uniform cannot be moved by the override at all.
    expect(Array.from(new Uint8Array(buildTerrainKernelPageUniform(
      { seedHash: world.seedHash, extraSeedHash: 12_345, ...shared }))))
      .toEqual(Array.from(new Uint8Array(buildTerrainKernelPageUniform(
        { seedHash: world.seedHash, ...shared }))));

    // Routing the vegetation seed moves ONLY the appended lattices' seed
    // words: one u32 each, contiguous, and disjoint from the kernel's own.
    // Asserted by CONSTRUCTION rather than by a computed offset, because the
    // seed block is padded to a vec4 boundary and an offset formula that
    // ignored the padding would be checking the wrong bytes.
    const bytesChangedBetween = (a: Uint8Array, b: Uint8Array): number[] => {
      const changed: number[] = [];
      for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) changed.push(index);
      }
      return changed;
    };
    const appendedMoved = bytesChangedBetween(inherited, routed);
    expect(appendedMoved.length).toBe(VEGETATION_DENSITY_KERNEL_LATTICES.length * 4);
    expect(Math.max(...appendedMoved) - Math.min(...appendedMoved))
      .toBe(appendedMoved.length - 1);

    // Moving the TERRAIN seed instead moves a strictly larger, disjoint-headed
    // region: the kernel's own lattice seeds (and, through the pre-mix, the
    // appended ones too). The appended block is the tail of it.
    const terrainMoved = bytesChangedBetween(inherited, new Uint8Array(
      buildTerrainKernelPageUniform(
        { seedHash: world.sourceSeedHash, extraSeedHash: world.seedHash, ...shared },
        VEGETATION_DENSITY_KERNEL_LATTICES)));
    // Not an exact byte count: two independently hashed seed words agree in a
    // given byte about 1 time in 256, so the kernel's 43 lattices reliably move
    // *most* of their 172 bytes rather than all of them.
    expect(terrainMoved.length).toBeGreaterThan(appendedMoved.length * 3);
    expect(Math.min(...terrainMoved)).toBeLessThan(Math.min(...appendedMoved));
  });

  /**
   * The magnitude, at the shot that caught it. This is the ablation D-18 asked
   * for: one input changes, and the dominant ground material changes with it.
   */
  it("reads a CLOSED grove as closed once the seeds are routed", () => {
    const world = createWorld("phase1-perf-baseline");
    // The grove-forest-2m camera: the perf harness's forest locator resolves
    // to the airport plus (500, 500) for this seed.
    const x = (world.airport?.centerX ?? 0) + 500;
    const z = (world.airport?.centerZ ?? 0) + 500;
    const terrain = sampleTerrain(world, x, z);
    const slope = Math.min(0.999, Math.max(0, 1 - (terrain.normal?.y ?? 1)));
    const sample = (seedHash: number) => densityField(seedHash, {
      x,
      z,
      heightMeters: terrain.height,
      seaLevelMeters: world.seaLevel,
      slope,
      moisture: terrain.moisture,
      normalX: terrain.normal?.x ?? 0,
      normalZ: terrain.normal?.z ?? 0,
      airportInfluence: 0,
      dayOfYear: REFERENCE_DAY,
      filterWidthMeters: CANOPY_CLOSURE_FILTER_WIDTH_METERS,
    });

    // The terrain seed says bare ground; the seed the trees are planted from
    // says closed canopy. Two orders of magnitude apart in stem density.
    const wrong = sample(world.seedHash);
    const right = sample(world.sourceSeedHash);
    expect(wrong.canopyClosure).toBeLessThan(0.05);
    expect(right.canopyClosure).toBeGreaterThan(0.85);

    const base: LandCoverInput = {
      elevationMeters: terrain.height - world.seaLevel,
      slope,
      moisture: terrain.moisture,
      temperature: 0.66 - Math.max(0, terrain.height - world.seaLevel) / 2_450,
      aspect: 0,
      airportInfluence: 0,
      dayOfYear: REFERENCE_DAY,
      seasonalTemperatureShift: 0,
    };
    const dominantFor = (field: { canopyClosure: number; grassCover: number }) =>
      dominantLandCover(classifyLandCover({
        ...base,
        canopyClosure: field.canopyClosure,
        grassCover: field.grassCover,
      }));
    // 2 = ForestFloor, 1 = Grass (SurfaceMaterial order).
    expect(dominantFor(wrong)).toBe(1);
    expect(dominantFor(right)).toBe(2);
  });

  /**
   * The bake's airport influence is the rounded rectangle, not a disc.
   *
   * The shader used `1 - length(p - centre) / blend` under a comment that
   * already claimed the rounded-rectangle field. A 1,320 m runway is five
   * times longer than that 240 m disc, so the bake read influence 0 over most
   * of its own airfield: the classifier lost its mown-grass decree AND the
   * canopy sample lost the apron's woody-stem clearance, so the ground grew a
   * forest the renderer does not plant.
   */
  it("evaluates the airport platform as the SAME rounded rectangle every other consumer reads", () => {
    const world = createWorld("phase1-perf-baseline");
    const airport = world.airport!;
    const runwaySin = Math.sin(airport.headingRadians);
    const runwayCos = Math.cos(airport.headingRadians);
    const halfLength = airport.runwayLength * 0.5 + airport.endSafetyArea;
    const halfWidth = airport.runwayWidth * 0.5 + airport.shoulderWidth;
    const invBlend = 1 / Math.max(1, airport.terrainBlendDistance);

    // The shader body, transliterated back. smoothstep(0, blend, d) is exactly
    // smoothstep(0, 1, d/blend), so the inverse blend lane carries the band.
    const shader = (dx: number, dz: number): number => {
      const along = dx * runwaySin + dz * runwayCos;
      const across = dx * runwayCos - dz * runwaySin;
      const qAlong = Math.abs(along) - halfLength;
      const qAcross = Math.abs(across) - halfWidth;
      const outside = Math.hypot(Math.max(qAlong, 0), Math.max(qAcross, 0));
      const distance = outside + Math.min(Math.max(qAlong, qAcross), 0);
      const t = Math.min(1, Math.max(0, distance * invBlend));
      return Math.min(1, Math.max(0, 1 - t * t * (3 - 2 * t)));
    };

    let worst = 0;
    for (let dx = -1_600; dx <= 1_600; dx += 17) {
      for (let dz = -1_600; dz <= 1_600; dz += 17) {
        worst = Math.max(worst, Math.abs(
          shader(dx, dz) - getAirportInfluence(airport, airport.centerX + dx, airport.centerZ + dz),
        ));
      }
    }
    expect(worst).toBeLessThan(1e-6);

    // The disc it replaced read ZERO at the ground-2m-lowsun camera, 661 m
    // down the runway axis, where the true platform influence is 0.807.
    const shotDx = -650;
    const shotDz = 120;
    const disc = Math.max(0, Math.min(1, 1 - Math.hypot(shotDx, shotDz) * invBlend));
    expect(disc).toBe(0);
    expect(shader(shotDx, shotDz)).toBeGreaterThan(0.8);

    // And the shipped WGSL evaluates it through the shared helper rather than
    // the radial form.
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain("fn splatAirportInfluence(");
    expect(LAND_COVER_SPLAT_BAKE_WGSL).not.toContain("1.0 - length(vec2f(localX, localZ)");
    // BOTH consumers read it: the classifier's mown-grass decree and the
    // canopy sample's woody-stem clearance.
    const uses = LAND_COVER_SPLAT_BAKE_WGSL.match(/splatAirportInfluence\(job, localX, localZ\)/g);
    expect(uses?.length).toBe(2);
  });
});
