import { prepareMaterialForClusteredLighting } from "../lighting/ClusteredLighting";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Constants } from "@babylonjs/core/Engines/constants";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Scene } from "@babylonjs/core/scene";
import { buildMipChain } from "@/src/render/webgpu/core/TextureArrayMips";

/**
 * `7-11` — hangar and tower materials (owner: world / airfield).
 *
 * Follows the Gate A-2 aircraft-paint convention exactly: deterministic bytes
 * authored on the CPU, every mip reduced explicitly through the shared
 * `TextureArrayMips` contract (Toksvig on the normal/roughness pair), and the
 * Babylon upload kept as a small boundary. No new pipeline.
 *
 * MEMORY BUDGET, derived from the inventory rather than any note. The 495 MiB
 * pin is the constant; the headroom under it is a MEASUREMENT that moves —
 * read it from the latest capture report's worst-shot `inventoriedGpuMemoryMiB`
 * (the estimate row tells a comfortable lie; the inventory binds). At this
 * item's landing (2026-09-01) the binding shot was `reference-viewport` at
 * 492.4, leaving 2.6 MiB for ALL of 7D — a dated observation, not a figure to
 * budget from later (transcribed numbers went stale twice in one night on the
 * draw-ceiling side; same rule here).
 * This module's allocation, by arithmetic on its own arrays (pinned by test):
 * metal 3 × 256² RGBA + mips ≈ 1.00 MiB, concrete 3 × 128² ≈ 0.25 MiB, glass
 * untextured ≈ 0 — **1.25 MiB total, under half the gate's headroom**, leaving
 * the rest for 7-10/7-15 geometry buffers which land in the same inventory.
 * 7-11 explicitly does NOT join the terrain material arrays: one added layer
 * at tier 1's 512 edge costs 2.67 MiB and blows the entire budget alone.
 * A 512² upgrade exists only as a measured trade (halve a vegetation atlas,
 * a visible loss on surfaces the winding fixes just corrected) and is not
 * taken here.
 *
 * THE UV CONTRACT (the load-bearing part — geometry in `AirfieldStructures.ts`
 * must follow it; the constants below are the source of truth):
 *
 *  - U runs ALONG the surface, in metres / `tileMeters`, and WRAPS. All
 *    U-structured features (ribs, panel seams, bolt columns) are periodic.
 *  - V runs DOWN the face: top of the face maps to V = the face's ASPECT
 *    OFFSET, bottom maps to V = 1, and the texture CLAMPS in V. Weathering
 *    (streaks, oxidation) grows monotonically with V — gravity, in UV form.
 *  - Aspect-biased oxidation costs zero pipeline and zero memory: a
 *    north-facing wall starts deeper into the weathering gradient
 *    (`ASPECT_V_START.north = 0.25`), so it renders older from pure UV
 *    arithmetic. NOTE this is a V *start*, not a V offset: an offset into a
 *    TILING axis only changes phase — the gradient works because V clamps
 *    and the face's span compresses into the remaining range.
 *
 * Streak weathering is a downward-flow accumulation from three source kinds —
 * bolt lines (girt rows × seam columns), gutter drip points along the top
 * edge, and a roof-edge wash — each a decaying vertical stamp with lateral
 * jitter. Every recipe returns feature COVERAGE so the artifact is testable
 * without a GPU or a screenshot judgement (the false-pass rule: a recipe
 * whose features are absent fails its coverage floors).
 */

export const AIRFIELD_METAL_EDGE = 256;
export const AIRFIELD_CONCRETE_EDGE = 128;

/** Metres of surface one metal tile covers along U. */
export const AIRFIELD_METAL_TILE_METERS = 2.4;
/** Metres of surface one concrete tile covers along U. */
export const AIRFIELD_CONCRETE_TILE_METERS = 3.0;

/**
 * Where a face's TOP edge starts in V, by RUNWAY-RELATIVE aspect — applied by
 * GEOMETRY when it authors UVs.
 *
 * DELIBERATELY NOT COMPASS ASPECT (decided with SWE II 2, 2026-09-01): the
 * airport's heading is seed-derived, so compass-keyed UVs would make the
 * vertex data a function of heading — two airports could never share a
 * prototype or an instanced buffer, forever, to encode a claim (which face
 * the sun ages fastest) that is unverifiable by eye and sits in a world
 * whose compass semantics are themselves an open decision (the mirror-sky
 * question, NIGHT_LOOK doc). Runway-relative keeps every perceptual benefit
 * — the four faces of a building genuinely differ — heading-free, and
 * carries the honest rationale: the face the airfield SEES gets painted,
 * the face it doesn't gets neglected.
 */
export const AIRFIELD_ASPECT_V_START = Object.freeze({
  /** The face toward the runway: maintained, youngest. */
  facingRunway: 0,
  /** Gable ends and side walls parallel to the runway axis. */
  sides: 0.12,
  /** The back face nobody repaints. */
  awayFromRunway: 0.25,
});

export const AIRFIELD_METAL_FEATURES = [
  "ribs",
  "seams",
  "bolts",
  "streaks",
  "oxidation",
] as const;
export type AirfieldMetalFeature = (typeof AIRFIELD_METAL_FEATURES)[number];

export const AIRFIELD_CONCRETE_FEATURES = [
  "form-ties",
  "board-seams",
  "tie-streaks",
] as const;
export type AirfieldConcreteFeature = (typeof AIRFIELD_CONCRETE_FEATURES)[number];

export interface AirfieldSurfaceSynthesis<Feature extends string> {
  readonly edge: number;
  readonly albedoMips: readonly Uint8Array[];
  readonly normalMips: readonly Uint8Array[];
  /** R = AO/cavity, G = roughness, B = metallic, A = 255 (aircraft packing). */
  readonly metallicRoughnessMips: readonly Uint8Array[];
  readonly featureCoverage: Readonly<Record<Feature, number>>;
  /**
   * Mean oxidation weight in the top and bottom thirds of the tile — the
   * gravity property as numbers, so a test can assert weathering grows
   * DOWNWARD rather than trusting the recipe's intent.
   */
  readonly oxidationTopThird: number;
  readonly oxidationBottomThird: number;
}

const CHANNELS = 4;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function byte(value: number): number {
  return Math.round(clamp01(value) * 255);
}

function mix(a: number, b: number, amount: number): number {
  return a + (b - a) * clamp01(amount);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function fract(value: number): number {
  return value - Math.floor(value);
}

function hash2(x: number, y: number, seed: number): number {
  let hash = (Math.imul(x, 0x27d4_eb2d) ^ Math.imul(y, 0x1656_67b1) ^ seed) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), hash | 1);
  hash ^= hash + Math.imul(hash ^ (hash >>> 7), hash | 61);
  return ((hash ^ (hash >>> 14)) >>> 0) / 4_294_967_296;
}

interface StreakSource {
  readonly u: number;
  /** V where the streak begins. */
  readonly v: number;
  readonly strength: number;
  /** e-folding length of the decay, in V. */
  readonly length: number;
  /** Gaussian half-width in U. */
  readonly width: number;
}

/**
 * Downward-flow accumulation: each source stains every texel below it, with
 * exponential decay in V, a Gaussian profile in U, and a per-column jitter so
 * runs read as drips rather than airbrush gradients. U distance respects the
 * wrap; V does not (V clamps — gravity has a direction).
 */
function stampStreaks(
  target: Float32Array,
  edge: number,
  sources: readonly StreakSource[],
  seed: number,
): void {
  for (const source of sources) {
    const columnJitter = (hash2(Math.round(source.u * edge), 7, seed) - 0.5) * 0.004;
    for (let y = 0; y < edge; y += 1) {
      const v = (y + 0.5) / edge;
      const drop = v - source.v;
      if (drop < 0) continue;
      const fade = Math.exp(-drop / source.length);
      if (fade < 0.02) break;
      for (let x = 0; x < edge; x += 1) {
        const u = (x + 0.5) / edge;
        let du = Math.abs(u - (source.u + columnJitter + drop * columnJitter * 6));
        du = Math.min(du, 1 - du);
        const profile = Math.exp(-((du / source.width) ** 2));
        if (profile < 0.02) continue;
        const grain = 0.75 + 0.5 * hash2(x, y, seed ^ 0x9e37_79b9);
        target[y * edge + x] = Math.min(
          1.5,
          target[y * edge + x]! + source.strength * fade * profile * grain,
        );
      }
    }
  }
}

function packSurface<Feature extends string>(
  edge: number,
  albedo: Uint8Array,
  height: Float32Array,
  roughnessField: Float32Array,
  metallicField: Float32Array,
  cavityField: Float32Array,
  oxidation: Float32Array,
  featureCounts: Record<Feature, number>,
  features: readonly Feature[],
  normalStrength: number,
): AirfieldSurfaceSynthesis<Feature> {
  const normalRoughnessAo = new Uint8Array(edge * edge * CHANNELS);
  const metallic = new Uint8Array(edge * edge * CHANNELS);
  for (let index = 0; index < edge * edge; index += 1) {
    const out = index * CHANNELS;
    normalRoughnessAo[out + 2] = byte(roughnessField[index]!);
    normalRoughnessAo[out + 3] = byte(cavityField[index]!);
    metallic[out] = byte(cavityField[index]!);
    metallic[out + 1] = byte(roughnessField[index]!);
    metallic[out + 2] = byte(metallicField[index]!);
    metallic[out + 3] = 255;
  }
  // Wrapped central differences in U; CLAMPED differences in V — the tile
  // wraps only along the surface, and a wrapped V difference would fold the
  // weathered bottom into the top edge's normal.
  for (let y = 0; y < edge; y += 1) {
    const previousY = Math.max(0, y - 1);
    const nextY = Math.min(edge - 1, y + 1);
    for (let x = 0; x < edge; x += 1) {
      const previousX = (x + edge - 1) & (edge - 1);
      const nextX = (x + 1) & (edge - 1);
      const dx = height[y * edge + nextX]! - height[y * edge + previousX]!;
      const dy = height[nextY * edge + x]! - height[previousY * edge + x]!;
      const inverseLength = 1 / Math.hypot(dx * normalStrength, dy * normalStrength, 1);
      const out = (y * edge + x) * CHANNELS;
      normalRoughnessAo[out] = byte(-dx * normalStrength * inverseLength * 0.5 + 0.5);
      normalRoughnessAo[out + 1] = byte(-dy * normalStrength * inverseLength * 0.5 + 0.5);
    }
  }
  const normalMaterialMips = buildMipChain(
    normalRoughnessAo,
    edge,
    { kind: "toksvig", roughnessGain: 0.5 },
  );
  const normalMips = normalMaterialMips.map((level) => {
    const normal = new Uint8Array(level.length);
    for (let index = 0; index < level.length; index += CHANNELS) {
      const nx = (level[index]! / 255) * 2 - 1;
      const ny = (level[index + 1]! / 255) * 2 - 1;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      normal[index] = level[index]!;
      normal[index + 1] = level[index + 1]!;
      normal[index + 2] = byte(nz * 0.5 + 0.5);
      normal[index + 3] = 255;
    }
    return normal;
  });
  const metallicMips = buildMipChain(metallic, edge, "box");
  for (let levelIndex = 0; levelIndex < metallicMips.length; levelIndex += 1) {
    const materialLevel = metallicMips[levelIndex]!;
    const normalLevel = normalMaterialMips[levelIndex]!;
    for (let index = 0; index < materialLevel.length; index += CHANNELS) {
      materialLevel[index] = normalLevel[index + 3]!;
      materialLevel[index + 1] = normalLevel[index + 2]!;
    }
  }
  const texelCount = edge * edge;
  const third = Math.floor(edge / 3);
  let oxidationTop = 0;
  let oxidationBottom = 0;
  for (let y = 0; y < third; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      oxidationTop += oxidation[y * edge + x]!;
      oxidationBottom += oxidation[(edge - 1 - y) * edge + x]!;
    }
  }
  return {
    edge,
    albedoMips: buildMipChain(albedo, edge, "box"),
    normalMips,
    metallicRoughnessMips: metallicMips,
    featureCoverage: Object.fromEntries(
      features.map((feature) => [feature, featureCounts[feature] / texelCount]),
    ) as Record<Feature, number>,
    oxidationTopThird: oxidationTop / (third * edge),
    oxidationBottomThird: oxidationBottom / (third * edge),
  };
}

/**
 * Ribbed, galvanized, weathering corrugated cladding. Eight rib periods and
 * two panel seams per tile (both exact divisors, so U wraps seamlessly);
 * three girt-line bolt rows; gutter drips and a roof-edge wash feeding the
 * streak accumulator; oxidation growing with V and concentrated where
 * streaks run.
 */
export function synthesizeAirfieldMetal(
  seed: number,
  edge = AIRFIELD_METAL_EDGE,
): AirfieldSurfaceSynthesis<AirfieldMetalFeature> {
  if (!Number.isInteger(edge) || edge < 8 || (edge & (edge - 1)) !== 0) {
    throw new RangeError(`Airfield metal edge must be a power of two >= 8, got ${edge}`);
  }
  const albedo = new Uint8Array(edge * edge * CHANNELS);
  const height = new Float32Array(edge * edge);
  const roughness = new Float32Array(edge * edge);
  const metallicField = new Float32Array(edge * edge);
  const cavity = new Float32Array(edge * edge);
  const oxidation = new Float32Array(edge * edge);
  const streaks = new Float32Array(edge * edge);
  const featureCounts = Object.fromEntries(
    AIRFIELD_METAL_FEATURES.map((feature) => [feature, 0]),
  ) as Record<AirfieldMetalFeature, number>;

  const RIBS_PER_TILE = 8;
  const SEAMS_PER_TILE = 2;
  const GIRT_ROWS = [0.18, 0.5, 0.82] as const;

  const sources: StreakSource[] = [];
  // Bolt lines: one source per (seam column x girt row).
  for (let seam = 0; seam < SEAMS_PER_TILE; seam += 1) {
    const u = (seam + 0.5) / SEAMS_PER_TILE;
    for (const girt of GIRT_ROWS) {
      sources.push({
        u,
        v: girt,
        strength: 0.34 + 0.3 * hash2(seam, Math.round(girt * 97), seed ^ 0x1f83_d9ab),
        length: 0.1 + 0.22 * hash2(seam, Math.round(girt * 131), seed ^ 0x5be0_cd19),
        width: 0.005 + 0.004 * hash2(seam, Math.round(girt * 173), seed),
      });
    }
  }
  // Gutter drip points along the top edge.
  const dripCount = 3 + Math.floor(hash2(11, 3, seed) * 3);
  for (let drip = 0; drip < dripCount; drip += 1) {
    sources.push({
      u: hash2(drip, 29, seed ^ 0x6a09_e667),
      v: 0,
      strength: 0.5 + 0.45 * hash2(drip, 31, seed),
      length: 0.16 + 0.34 * hash2(drip, 37, seed ^ 0xbb67_ae85),
      width: 0.006 + 0.008 * hash2(drip, 41, seed),
    });
  }
  // The roof-edge wash: broad, weak, everywhere along the top.
  sources.push({ u: 0.5, v: 0, strength: 0.16, length: 0.5, width: 0.75 });
  stampStreaks(streaks, edge, sources, seed);

  const GALVANIZED: readonly [number, number, number] = [0.44, 0.48, 0.5];
  const RUST: readonly [number, number, number] = [0.4, 0.2, 0.11];

  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const u = (x + 0.5) / edge;
      const v = (y + 0.5) / edge;
      const index = y * edge + x;
      const out = index * CHANNELS;
      const grain = hash2(x, y, seed) - 0.5;
      const broad = hash2(x >> 4, y >> 4, seed ^ 0x510e_527f) - 0.5;

      // Corrugation: the U-periodic rib field IS the height signal, so the
      // silhouette-facing normal carries real ridges (the plan's "geometry on
      // the silhouette" arrives via geometry in 7-10; this map carries the
      // inboard relief).
      const ribPhase = fract(u * RIBS_PER_TILE);
      const rib = Math.sin(ribPhase * Math.PI * 2);
      const seamDistance = Math.min(
        Math.abs(fract(u * SEAMS_PER_TILE) - 0.5) / 0.5,
        1,
      );
      const seam = 1 - smoothstep(0.02, 0.06, 1 - seamDistance);

      let boltMask = 0;
      for (const girt of GIRT_ROWS) {
        const dv = Math.abs(v - girt);
        const boltPhase = fract(u * RIBS_PER_TILE * 2 + 0.25);
        const nearBolt = Math.min(boltPhase, 1 - boltPhase) < 0.09;
        if (dv < 0.012 && nearBolt) boltMask = 1;
      }

      const streak = clamp01(streaks[index]!);
      const gradient = smoothstep(0.3, 1, v);
      const rust = clamp01(
        gradient * 0.28
        + streak * (0.45 + 0.35 * gradient)
        + boltMask * 0.3
        + broad * 0.06,
      );

      if (Math.abs(rib) > 0.75) featureCounts.ribs += 1;
      if (seam > 0.5) featureCounts.seams += 1;
      if (boltMask > 0) featureCounts.bolts += 1;
      if (streak > 0.12) featureCounts.streaks += 1;
      if (rust > 0.3) featureCounts.oxidation += 1;

      oxidation[index] = rust;
      height[index] = rib * 0.05 - seam * 0.06 + (boltMask ? 0.09 : 0)
        + grain * 0.008 - rust * 0.02;
      for (let channel = 0; channel < 3; channel += 1) {
        let value = GALVANIZED[channel]! + grain * 0.03 + broad * 0.04;
        value *= 1 - seam * 0.22;
        value = mix(value, RUST[channel]!, rust * 0.85);
        albedo[out + channel] = byte(value);
      }
      albedo[out + 3] = 255;
      roughness[index] = clamp01(0.42 + grain * 0.04 + rust * 0.4 + seam * 0.1);
      metallicField[index] = clamp01(0.72 - rust * 0.6);
      cavity[index] = clamp01(1 - seam * 0.25 - (boltMask ? 0.12 : 0) - streak * 0.1);
    }
  }
  return packSurface(
    edge,
    albedo,
    height,
    roughness,
    metallicField,
    cavity,
    oxidation,
    featureCounts,
    AIRFIELD_METAL_FEATURES,
    5,
  );
}

/** Formed concrete: tie grid, board seams, and rust weeps below each tie. */
export function synthesizeAirfieldConcrete(
  seed: number,
  edge = AIRFIELD_CONCRETE_EDGE,
): AirfieldSurfaceSynthesis<AirfieldConcreteFeature> {
  if (!Number.isInteger(edge) || edge < 8 || (edge & (edge - 1)) !== 0) {
    throw new RangeError(`Airfield concrete edge must be a power of two >= 8, got ${edge}`);
  }
  const albedo = new Uint8Array(edge * edge * CHANNELS);
  const height = new Float32Array(edge * edge);
  const roughness = new Float32Array(edge * edge);
  const metallicField = new Float32Array(edge * edge);
  const cavity = new Float32Array(edge * edge);
  const oxidation = new Float32Array(edge * edge);
  const streaks = new Float32Array(edge * edge);
  const featureCounts = Object.fromEntries(
    AIRFIELD_CONCRETE_FEATURES.map((feature) => [feature, 0]),
  ) as Record<AirfieldConcreteFeature, number>;

  // 5 x 5 tie grid (0.6 m pitch on the 3 m tile); every tie weeps a little.
  const TIES = 5;
  const sources: StreakSource[] = [];
  for (let tx = 0; tx < TIES; tx += 1) {
    for (let ty = 0; ty < TIES; ty += 1) {
      sources.push({
        u: (tx + 0.5) / TIES,
        v: (ty + 0.5) / TIES,
        strength: 0.14 + 0.2 * hash2(tx, ty, seed ^ 0x428a_2f98),
        length: 0.05 + 0.1 * hash2(tx, ty, seed ^ 0x7137_4491),
        width: 0.004 + 0.003 * hash2(tx, ty, seed),
      });
    }
  }
  stampStreaks(streaks, edge, sources, seed ^ 0xb5c0_fbcf);

  const CONCRETE: readonly [number, number, number] = [0.52, 0.51, 0.48];
  const STAIN: readonly [number, number, number] = [0.36, 0.28, 0.2];

  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const u = (x + 0.5) / edge;
      const v = (y + 0.5) / edge;
      const index = y * edge + x;
      const out = index * CHANNELS;
      const grain = hash2(x, y, seed) - 0.5;
      const broad = hash2(x >> 3, y >> 3, seed ^ 0xe9b5_dba5) - 0.5;

      const tieU = fract(u * TIES) - 0.5;
      const tieV = fract(v * TIES) - 0.5;
      const tie = 1 - smoothstep(0.045, 0.075, Math.hypot(tieU, tieV));
      const boardSeam = 1 - smoothstep(0.006, 0.016, Math.abs(fract(v * 2.5 + 0.2) - 0.5) * 0.4);
      const streak = clamp01(streaks[index]!);
      const weather = clamp01(smoothstep(0.4, 1, v) * 0.18 + streak * 0.7);

      if (tie > 0.5) featureCounts["form-ties"] += 1;
      if (boardSeam > 0.5) featureCounts["board-seams"] += 1;
      if (streak > 0.1) featureCounts["tie-streaks"] += 1;

      oxidation[index] = weather;
      height[index] = grain * 0.01 + broad * 0.012 - tie * 0.05 - boardSeam * 0.03;
      for (let channel = 0; channel < 3; channel += 1) {
        let value = CONCRETE[channel]! + grain * 0.045 + broad * 0.05;
        value *= 1 - boardSeam * 0.1 - tie * 0.16;
        value = mix(value, STAIN[channel]!, weather * 0.8);
        albedo[out + channel] = byte(value);
      }
      albedo[out + 3] = 255;
      roughness[index] = clamp01(0.82 + grain * 0.05 + weather * 0.1 - tie * 0.05);
      metallicField[index] = 0;
      cavity[index] = clamp01(1 - tie * 0.3 - boardSeam * 0.12 - streak * 0.08);
    }
  }
  return packSurface(
    edge,
    albedo,
    height,
    roughness,
    metallicField,
    cavity,
    oxidation,
    featureCounts,
    AIRFIELD_CONCRETE_FEATURES,
    3.2,
  );
}

function uploadMipChain(
  scene: Scene,
  name: string,
  edge: number,
  mips: readonly Uint8Array[],
  useSrgbBuffer: boolean,
): RawTexture {
  const texture = new RawTexture(
    mips[0]!,
    edge,
    edge,
    Constants.TEXTUREFORMAT_RGBA,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
    0,
    useSrgbBuffer,
    false,
    mips.length,
  );
  texture.name = name;
  // U wraps (the tile repeats along the surface); V CLAMPS (the weathering
  // gradient has a direction, and a wrapped V would rain rust upward onto
  // the eave). This is the one deliberate difference from the aircraft
  // upload, and the UV contract above depends on it.
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 8;
  for (let level = 1; level < mips.length; level += 1) {
    texture.updateMipLevel(mips[level]!, level);
  }
  return texture;
}

export interface AirfieldMaterialSet {
  readonly metal: PBRMaterial;
  readonly concrete: PBRMaterial;
  readonly glass: PBRMaterial;
  readonly accent: PBRMaterial;
  dispose(): void;
}

/**
 * The 7D structure materials, synthesized once and shared by every hangar,
 * the tower, and the furniture — sharing is what keeps 7D's draw growth to
 * the merged-mesh count rather than a per-building material bill. Textures
 * land in `scene.textures`, so `inventoryGpuMemoryMiB` sees every byte with
 * no bookkeeping row to drift.
 */
export function createAirfieldMaterials(scene: Scene, seed: number): AirfieldMaterialSet {
  const metalSynthesis = synthesizeAirfieldMetal(seed);
  const concreteSynthesis = synthesizeAirfieldConcrete(seed ^ 0x59f1_11f1);
  const textures: RawTexture[] = [];
  const wire = (
    material: PBRMaterial,
    name: string,
    synthesis: AirfieldSurfaceSynthesis<string>,
  ): void => {
    const albedo = uploadMipChain(scene, `${name}-albedo`, synthesis.edge, synthesis.albedoMips, true);
    const normal = uploadMipChain(scene, `${name}-normal`, synthesis.edge, synthesis.normalMips, false);
    const orm = uploadMipChain(
      scene,
      `${name}-metallic-roughness`,
      synthesis.edge,
      synthesis.metallicRoughnessMips,
      false,
    );
    textures.push(albedo, normal, orm);
    material.albedoTexture = albedo;
    material.bumpTexture = normal;
    material.metallicTexture = orm;
    material.useAmbientOcclusionFromMetallicTextureRed = true;
    // Babylon's DEFAULT is useRoughnessFromMetallicTextureAlpha = true, and
    // this ORM's alpha is 255 everywhere — omitting the explicit false made
    // every textured surface roughness-1.0 (the alpha flag WINS over the
    // green flag), which rendered the first hangars as flat, blue-shifted,
    // IBL-only mush: roof and wall 0.3% apart in a frame where tree
    // top-vs-under read 25% apart, and darker than the asphalt. The
    // aircraft's proven wiring (builders.ts paintMaterial) sets this false
    // explicitly for exactly this reason; now so does this one, pinned by
    // test.
    material.useRoughnessFromMetallicTextureAlpha = false;
    material.useRoughnessFromMetallicTextureGreen = true;
    material.useMetallnessFromMetallicTextureBlue = true;
    material.roughness = 1;
    material.metallic = 1;
    material.environmentIntensity = 1;
  };

  const metal = new PBRMaterial("airfield-metal", scene);

  prepareMaterialForClusteredLighting(metal);
  wire(metal, "airfield-metal", metalSynthesis);

  const concrete = new PBRMaterial("airfield-concrete", scene);

  prepareMaterialForClusteredLighting(concrete);
  wire(concrete, "airfield-concrete", concreteSynthesis);

  // Glass is deliberately untextured in 7-11 v1 (0 MiB): a smooth, dark,
  // reflective PBR reads correctly at every shipped camera distance, and the
  // sky probe supplies the reflection. A ripple normal is the first upgrade
  // if the tower cab ever reads flat in a Jason closeup.
  const glass = new PBRMaterial("airfield-glass", scene);
  prepareMaterialForClusteredLighting(glass);
  glass.albedoColor = new Color3(0.03, 0.045, 0.06);
  glass.roughness = 0.08;
  glass.metallic = 0.1;
  glass.environmentIntensity = 1;

  const accent = new PBRMaterial("airfield-accent", scene);

  prepareMaterialForClusteredLighting(accent);
  const accentHue = hash2(17, 23, seed);
  accent.albedoColor = Color3.FromHSV(
    30 + accentHue * 30,
    0.55,
    0.5,
  );
  accent.roughness = 0.5;
  accent.metallic = 0.2;
  accent.environmentIntensity = 1;

  return {
    metal,
    concrete,
    glass,
    accent,
    dispose(): void {
      for (const texture of textures) texture.dispose();
      metal.dispose(true, false);
      concrete.dispose(true, false);
      glass.dispose(true, false);
      accent.dispose(true, false);
    },
  };
}

/** Total bytes across every mip of one synthesis — the budget's arithmetic. */
export function synthesisByteSize(synthesis: AirfieldSurfaceSynthesis<string>): number {
  let total = 0;
  for (const mips of [synthesis.albedoMips, synthesis.normalMips, synthesis.metallicRoughnessMips]) {
    for (const level of mips) total += level.byteLength;
  }
  return total;
}
