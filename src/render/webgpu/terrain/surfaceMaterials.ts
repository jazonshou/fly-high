import { TerrainBiome, type TerrainBiomeId } from "@/src/world";

/**
 * 3-0 — the surface material contract (owner: terrain-material).
 *
 * INVARIANT THIS FILE OWNS: there is exactly one list of terrain surface
 * material identities, and exactly one set of their physical constants.
 * `3-1` synthesises against it, `3-2` binds against it, `3-6` blends against
 * it, `3-7` shades against it, `3-9` paints the runway from it, `3-10` tints
 * it, and `4-6` inherits it rather than inventing a second enum. An enum with
 * seven consumers that is invented halfway through an eight-day item gets
 * invented seven times; this file is the separate-the-contract-from-the-
 * behaviour move that `0-4` already proved.
 *
 * Class P: pure numbers, no Babylon import, Node-tested.
 *
 * The split of responsibility inside the contract is deliberate. Everything
 * here is *physical* — tiling periods, roughness ranges, Oren-Nayar diffuse
 * roughness, dielectric F0, the reference albedo each material integrates to.
 * The *appearance* recipes (how the noise strata are laid down) live in
 * `MaterialArraySynthesis.ts`, so a tuning session moves recipe constants and
 * cannot silently move a BRDF constant. That separation is §11 R-3A's answer
 * to "ten hand-tuned recipes is the largest unfalsifiable surface in the
 * programme".
 */

/**
 * Index into both texture arrays. Written as a frozen record rather than the
 * plan's `const enum`, because `tsconfig.json` sets `isolatedModules` and the
 * codebase already resolved this exact question for `TerrainBiome`
 * (`src/world/types.ts`). Call sites read identically.
 *
 * ORDER IS LOAD-BEARING, in two ways:
 *
 * 1. It is the layer index in both `Texture2DArray`s. Reordering is a world
 *    format break; append only.
 * 2. It is the ECOTONE AXIS. `3-2`'s provisional splat interpolates the
 *    material id across a triangle and the fragment brackets the two integers
 *    it lands between, so the first six indices are exactly the chain of biome
 *    PRIMARIES in climatic order:
 *
 *      water/beach → grassland → forest    → highland → alpine → snow
 *      sand (0)    → grass (1) → floor (2) → shrub (3) → rock (4) → snow (5)
 *
 *    Every pair of biomes that can share an edge in the world is therefore ONE
 *    step apart on the axis, and a boundary blends the two materials that
 *    actually meet there — never a third one in between.
 *
 *    That is not a stylistic preference; it was measured. The first ordering
 *    put sand between shrub and rock, and the `approach-500ft` capture came
 *    back with bright closed rings around every mountain: sand is the
 *    brightest material in the table and shrub among the darkest, so the
 *    highland/alpine iso-contour lit up as a white band. The materials that
 *    are never a biome's primary — dry grass, gravel and the two paved
 *    surfaces — sit at 6..9, off the chain.
 */
export const SurfaceMaterial = {
  Sand: 0,
  Grass: 1,
  ForestFloor: 2,
  Shrub: 3,
  Rock: 4,
  Snow: 5,
  DryGrass: 6,
  Gravel: 7,
  Asphalt: 8,
  Concrete: 9,
} as const;

export type SurfaceMaterialId = (typeof SurfaceMaterial)[keyof typeof SurfaceMaterial];
export type SurfaceMaterialName = keyof typeof SurfaceMaterial;

/** Layers per array. Both arrays carry the same ten. */
export const SURFACE_MATERIAL_COUNT = 10;

/** Two arrays: A = albedo/height, B = normal/material. */
export const SURFACE_MATERIAL_ARRAY_COUNT = 2;

/**
 * Array layouts, fixed here and consumed by `3-1` (synthesis) and `3-2`
 * (sampling). Written as data so the shader's channel comments and the
 * synthesiser's writes cannot drift apart silently.
 */
export const SURFACE_ARRAY_A_CHANNELS = ["albedoR", "albedoG", "albedoB", "height"] as const;

/**
 * Array A's RGB is stored as `sqrt(linearAlbedo)` — a gamma-2.0 encoding —
 * and the shader squares it on read. RGBA8 is a linear-quantised format, and
 * forest floor and asphalt integrate to linear albedos of 0.06 and 0.045: a
 * dozen usable byte levels each, for the two materials that cover most of the
 * world. One multiply per sample buys four times the precision exactly where
 * it is scarcest. `3-1` packs it, `3-2` decodes it, and this constant is the
 * one place the exponent is written down.
 */
export const SURFACE_ALBEDO_STORAGE_GAMMA = 2;
export const SURFACE_ARRAY_B_CHANNELS = ["normalX", "normalY", "roughness", "cavityAo"] as const;

export interface SurfaceMaterialSpec {
  readonly id: SurfaceMaterialId;
  readonly name: SurfaceMaterialName;
  /**
   * World-space repeat, metres. Every period is a distinct prime number of
   * decimetres, so any two layers realign only at `p·q` decimetres — 66.7 m
   * for the closest pair, far beyond any patch the eye reads as one surface.
   * Assertion 52 checks the co-primality, not a comment.
   */
  readonly tilingPeriodMeters: number;
  /** [min, max] before the per-block variance the synthesiser adds. */
  readonly roughness: readonly [number, number];
  /** Oren-Nayar sigma (`3-7`): the retroreflective brightening at low sun. */
  readonly diffuseRoughness: number;
  /** Dielectric normal-incidence reflectance, ((n−1)/(n+1))². */
  readonly f0: number;
  /**
   * The material's area-integrated linear albedo. `3-1` normalises its
   * synthesised albedo to this, so the mean the light rig sees (`R-26`) is a
   * contract value rather than a measurement of whatever the recipe happened
   * to produce.
   *
   * These are measured-range values, not the pre-Phase-3 palette's: the
   * deleted `PALETTES` table put grassland at (0.29, 0.445, 0.215), roughly
   * three times a real sward's reflectance, which is the "paint it bright"
   * error that makes a world look like a diorama. Sunlit grass integrates to
   * about 0.20 luminance and forest litter to about 0.09, and that is what is
   * written here.
   */
  readonly referenceAlbedo: readonly [number, number, number];
  /** `3-10`: rides the seasonal tint curve. Rock, asphalt and concrete do not. */
  readonly seasonal: boolean;
  /** `3-5`: projected triplanar rather than planar-XZ. */
  readonly triplanar: boolean;
}

/**
 * Ten identities. Physical constants only.
 *
 * Deviation from `RENDERING_PLAN.md` §3.2's eight published periods (grass
 * 2.4, forest floor 3.1, scree 3.7, sand 4.3, rock 5.7, snow 6.9, asphalt 7.4,
 * concrete 9.1): those are **not** mutually prime, which is the property the
 * plan asks for and assertion 52 tests. As decimetres they are 24, 31, 37, 43,
 * 57, 69, 74, 91 — gravel and asphalt are an exact 2:1 (37 / 74), and 24, 57
 * and 69 share a factor of 3. Every period below is instead a distinct prime
 * number of decimetres, which makes co-primality structural. The five that
 * could be kept unchanged (forest floor 3.1, gravel 3.7, sand 4.3) were.
 */
export const SURFACE_MATERIALS: readonly SurfaceMaterialSpec[] = Object.freeze([
  {
    id: SurfaceMaterial.Sand,
    name: "Sand",
    tilingPeriodMeters: 4.3,
    roughness: [0.5, 0.76],
    diffuseRoughness: 0.55,
    f0: 0.046,
    referenceAlbedo: [0.42, 0.36, 0.25],
    seasonal: false,
    triplanar: false,
  },
  {
    id: SurfaceMaterial.Grass,
    name: "Grass",
    tilingPeriodMeters: 2.3,
    roughness: [0.78, 1.0],
    diffuseRoughness: 0.4,
    f0: 0.033,
    referenceAlbedo: [0.118, 0.183, 0.058],
    seasonal: true,
    triplanar: false,
  },
  {
    id: SurfaceMaterial.ForestFloor,
    name: "ForestFloor",
    // The widest roughness span in the table on purpose: litter reads ~0.6 and
    // moss ~0.95, and adjacent litter and moss with visibly different gloss is
    // most of what stops a forest floor being a brown sheet.
    tilingPeriodMeters: 3.1,
    roughness: [0.6, 0.98],
    diffuseRoughness: 0.42,
    f0: 0.034,
    referenceAlbedo: [0.104, 0.081, 0.048],
    seasonal: true,
    triplanar: false,
  },
  {
    id: SurfaceMaterial.Shrub,
    name: "Shrub",
    tilingPeriodMeters: 4.1,
    roughness: [0.74, 0.98],
    diffuseRoughness: 0.38,
    f0: 0.035,
    referenceAlbedo: [0.098, 0.138, 0.061],
    seasonal: true,
    triplanar: false,
  },
  {
    id: SurfaceMaterial.Rock,
    name: "Rock",
    tilingPeriodMeters: 5.9,
    roughness: [0.45, 0.72],
    diffuseRoughness: 0.35,
    f0: 0.046,
    referenceAlbedo: [0.17, 0.165, 0.155],
    seasonal: false,
    triplanar: true,
  },
  {
    id: SurfaceMaterial.Snow,
    name: "Snow",
    tilingPeriodMeters: 6.7,
    roughness: [0.18, 0.52],
    diffuseRoughness: 0.7,
    // Ice, n = 1.31. Snow's specular is grain facets, not a coating.
    f0: 0.02,
    referenceAlbedo: [0.78, 0.8, 0.84],
    seasonal: false,
    triplanar: false,
  },
  {
    id: SurfaceMaterial.DryGrass,
    name: "DryGrass",
    tilingPeriodMeters: 2.9,
    roughness: [0.7, 0.96],
    diffuseRoughness: 0.45,
    f0: 0.033,
    referenceAlbedo: [0.245, 0.212, 0.108],
    seasonal: true,
    triplanar: false,
  },
  {
    id: SurfaceMaterial.Gravel,
    name: "Gravel",
    tilingPeriodMeters: 3.7,
    roughness: [0.58, 0.88],
    diffuseRoughness: 0.4,
    f0: 0.046,
    referenceAlbedo: [0.2, 0.19, 0.175],
    seasonal: false,
    triplanar: true,
  },
  {
    id: SurfaceMaterial.Asphalt,
    name: "Asphalt",
    tilingPeriodMeters: 7.3,
    roughness: [0.55, 0.83],
    diffuseRoughness: 0.25,
    // Bitumen, n = 1.635.
    f0: 0.058,
    referenceAlbedo: [0.045, 0.046, 0.048],
    seasonal: false,
    triplanar: false,
  },
  {
    id: SurfaceMaterial.Concrete,
    name: "Concrete",
    tilingPeriodMeters: 8.9,
    roughness: [0.62, 0.9],
    diffuseRoughness: 0.3,
    f0: 0.042,
    referenceAlbedo: [0.28, 0.28, 0.27],
    seasonal: false,
    triplanar: false,
  },
] satisfies readonly SurfaceMaterialSpec[]);

export function surfaceMaterialSpec(id: SurfaceMaterialId): SurfaceMaterialSpec {
  const spec = SURFACE_MATERIALS[id];
  if (!spec) throw new RangeError(`Unknown surface material id ${id}`);
  return spec;
}

/**
 * The provisional splat's biome mapping (`3-2`, Class T).
 *
 * `R-25` states the known interim plainly: until `4-6` rasterises real splat
 * pages, these ten well-synthesised materials are selected by the 8-bit
 * per-vertex threshold cascade the audit indicts — the one that puts 41–50% of
 * adjacent vertex pairs in different biomes past 5 km. The boundary quality is
 * `4-6`'s to close. What this table can do is make the *interim* honest:
 *
 * - `primary` and `secondary` are chosen so that neighbouring biomes are
 *   neighbours on the `SurfaceMaterial` axis too, which is what lets `3-2`
 *   interpolate the id instead of flat-shading it.
 * - RUNWAY deliberately maps to ordinary ground. The paved materials arrive
 *   only through `3-9`'s analytic airport SDF, so the ring of vertices around
 *   the apron never sweeps the whole palette on its way to asphalt.
 */
export interface SurfaceMaterialMix {
  readonly primary: SurfaceMaterialId;
  readonly secondary: SurfaceMaterialId;
  /** Weight of `secondary`; `primary` takes the remainder. */
  readonly secondaryWeight: number;
}

export const SURFACE_MATERIALS_BY_BIOME: Readonly<Record<TerrainBiomeId, SurfaceMaterialMix>> =
  Object.freeze({
    // Every entry keeps the ECOTONE AXIS property above: biomes that can share
    // an edge have primaries one step apart. RUNWAY shares grassland's primary
    // outright — the graded ground around an apron IS grass, and the paved
    // materials arrive only through 3-9's airport SDF.
    [TerrainBiome.WATER]: {
      // Sand, because beach is water's only neighbour on the ecotone axis —
      // and darkened to a lake bed by the shader's submerged wetness term
      // rather than by a bespoke material this table cannot afford.
      primary: SurfaceMaterial.Sand,
      secondary: SurfaceMaterial.Gravel,
      secondaryWeight: 0.45,
    },
    [TerrainBiome.BEACH]: {
      primary: SurfaceMaterial.Sand,
      secondary: SurfaceMaterial.Gravel,
      secondaryWeight: 0.18,
    },
    [TerrainBiome.GRASSLAND]: {
      primary: SurfaceMaterial.Grass,
      secondary: SurfaceMaterial.DryGrass,
      secondaryWeight: 0.25,
    },
    [TerrainBiome.FOREST]: {
      primary: SurfaceMaterial.ForestFloor,
      secondary: SurfaceMaterial.Shrub,
      secondaryWeight: 0.3,
    },
    [TerrainBiome.HIGHLAND]: {
      primary: SurfaceMaterial.Shrub,
      secondary: SurfaceMaterial.Gravel,
      secondaryWeight: 0.35,
    },
    [TerrainBiome.ALPINE]: {
      primary: SurfaceMaterial.Rock,
      secondary: SurfaceMaterial.Gravel,
      secondaryWeight: 0.38,
    },
    [TerrainBiome.SNOW]: {
      primary: SurfaceMaterial.Snow,
      secondary: SurfaceMaterial.Rock,
      secondaryWeight: 0.18,
    },
    [TerrainBiome.RUNWAY]: {
      primary: SurfaceMaterial.Grass,
      secondary: SurfaceMaterial.DryGrass,
      secondaryWeight: 0.3,
    },
  });

/**
 * The nominal land-cover mix a temperate world shows at the reference day,
 * used only for the scene-scale mean albedo (`R-26`). It is not a classifier
 * and nothing samples it per pixel; it exists so the light rig's ground bounce
 * is derived from the surface system instead of from a hardcoded 0.25 floor.
 * Snow's share rises with the winter fraction — which is the whole point:
 * `D-6`'s floor could not do that, and `G-B`'s seasonal ground would have
 * fought it.
 */
const SUMMER_LAND_COVER_SHARE: readonly number[] = Object.freeze([
  0.04, // Sand
  0.22, // Grass
  0.24, // ForestFloor
  0.08, // Shrub
  0.14, // Rock
  0.06, // Snow
  0.1, // DryGrass
  0.06, // Gravel
  0.005, // Asphalt
  0.005, // Concrete
]);

/** Snow's share at the depth of winter; the balance is taken from the four seasonal covers. */
const WINTER_SNOW_SHARE = 0.42;

/**
 * Scene-scale mean linear albedo of the terrain surface, as a function of the
 * season (`R-26`, retiring `D-6`/`D-9`). At the reference midsummer day this
 * is ≈0.166 luminance — close enough to the 0.18 atmospheric ground albedo
 * that daylight is unchanged — and it climbs past 0.35 at the depth of a 45°N
 * winter, which is what a snow-covered world actually bounces.
 *
 * `winterFraction` is `seasonalWinterFraction(dayOfYear, latitudeDegrees)`
 * from `src/world/terrain.ts`; it is passed in rather than recomputed so this
 * module keeps no second copy of the seasonal curve.
 */
export function meanSurfaceAlbedo(winterFraction: number): readonly [number, number, number] {
  const shares = landCoverShare(winterFraction);
  let r = 0;
  let g = 0;
  let b = 0;
  SURFACE_MATERIALS.forEach((spec, index) => {
    const share = shares[index] ?? 0;
    r += share * spec.referenceAlbedo[0];
    g += share * spec.referenceAlbedo[1];
    b += share * spec.referenceAlbedo[2];
  });
  return [r, g, b];
}

/**
 * The land-cover share `meanSurfaceAlbedo` weights each material by, adjusted
 * for the season's snow. Exported so the seasonal tint is averaged over the
 * SAME weights the albedo is — an unweighted tint mean over ten materials, six
 * of which are season-invariant, dilutes the swing by more than half.
 */
export function landCoverShare(winterFraction: number): readonly number[] {
  const winter = Math.min(1, Math.max(0, winterFraction));
  const snowGain = (WINTER_SNOW_SHARE - (SUMMER_LAND_COVER_SHARE[SurfaceMaterial.Snow] ?? 0))
    * winter;
  let seasonalShare = 0;
  for (const spec of SURFACE_MATERIALS) {
    if (spec.seasonal) seasonalShare += SUMMER_LAND_COVER_SHARE[spec.id] ?? 0;
  }
  return SURFACE_MATERIALS.map((spec) => {
    const base = SUMMER_LAND_COVER_SHARE[spec.id] ?? 0;
    if (spec.id === SurfaceMaterial.Snow) return base + snowGain;
    if (spec.seasonal && seasonalShare > 0) return base * (1 - snowGain / seasonalShare);
    return base;
  });
}

/** Rec. 709 luminance of a linear RGB triple. */
export function linearLuminance(rgb: readonly [number, number, number]): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
