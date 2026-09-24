import type { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import { createRawTextureFromMipChain } from "@/src/render/webgpu/core/MipChainUpload";
import { buildMipChain } from "@/src/render/webgpu/core/TextureArrayMips";

/**
 * Gate A-2 aircraft paint synthesis.
 *
 * The terrain and foliage material work established the renderer's material
 * pipeline convention: author deterministic bytes on the CPU, reduce every
 * mip explicitly, and keep the Babylon upload as a small boundary. Aircraft
 * paint follows that convention instead of introducing an asset loader or a
 * second procedural-texture framework.
 */

export const AIRCRAFT_PAINT_EDGE = 64;

export const AIRCRAFT_PAINT_FEATURES = [
  "panel-lines",
  "rivets",
  "seams",
  "filler",
  "exhaust-soot",
  "leading-edge-wear",
  "livery-decal",
] as const;

export type AircraftPaintFeature = (typeof AIRCRAFT_PAINT_FEATURES)[number];

export interface AircraftPaintRecipe {
  readonly seed: number;
  readonly baseColor: number;
  readonly liveryColor: number;
  /** Per-part physical finish, before local wear/soot modulation. */
  readonly roughness: number;
  readonly metallic: number;
  readonly sootStrength?: number;
  readonly wearStrength?: number;
  /**
   * Scales the panel-line and seam darkening/relief (default 1; rivets keep
   * full strength — they gate on panel PROXIMITY, not the line intensity).
   * The 64² maps are stretched over whatever surface a recipe is bound to, so
   * a large airframe can turn the grid down rather than reading as a quilt.
   * No shipped recipe currently sets it; every recipe that omits the field is
   * byte-identical to the pre-`panelStrength` synthesis.
   */
  readonly panelStrength?: number;
  /**
   * Scales the two filler patches (tone, relief and roughness), default 1.
   * Like `panelStrength`, for a surface the 64² tile is stretched over: on the
   * Global's 33.5 m body each patch is a 3 m smear. Omitted, byte-identical.
   */
  readonly fillerStrength?: number;
  /**
   * Scales the rivets' relief, default 1. Rivets sit on the panel grid whatever
   * `panelStrength` says, so turning the grid off leaves its rivet rows behind
   * as 0.5 m bumps in the normal map; this is the switch for those. Omitted,
   * byte-identical.
   */
  readonly rivetStrength?: number;
  /**
   * Draws the paint's noise on a UV lattice of this many cells a side, so the
   * DESIGN no longer depends on the map's size. Omitted, the noise is indexed
   * in texels, as it always was: grain per texel, the panel lines' jitter in
   * 8-texel blocks, filler mottling in 2-texel blocks. That is one design at
   * 64 and another at 256, where the jitter blocks step each panel line
   * sideways every 10 cm on the trainer, the "totem pole" seam
   * (docs/findings/TRAINER_SKIN_RESOLUTION_2026_09_23.md).
   *
   * Set, every noise term is smooth value noise on the lattice (the jitter on
   * a lattice an eighth as fine, the filler mottling on half), and rivets are
   * domes about a cell across instead of whichever texels fall in their band.
   * At 64 a 64-cell lattice draws today's grain exactly; at 256 it draws the
   * same design, sharper. Omitted, byte-identical.
   */
  readonly noiseLattice?: number;
  /**
   * The livery band's edge, as the smoothstep's two ends in the band's own
   * coordinate (default [0.055, 0.085]). The default ramp is 0.03 of the map
   * whatever its size: 0.21 m across the trainer's 6.9 m fuselage, soft by
   * design, which no texel count sharpens. Omitted, byte-identical.
   */
  readonly liveryEdge?: readonly [number, number];
}

export interface AircraftSurfaceSynthesis {
  readonly edge: number;
  readonly albedoMips: readonly Uint8Array[];
  readonly normalMips: readonly Uint8Array[];
  /** R = AO, G = roughness, B = metallic, A = unused/one. */
  readonly metallicRoughnessMips: readonly Uint8Array[];
  readonly featureCoverage: Readonly<Record<AircraftPaintFeature, number>>;
}

export interface AircraftSurfaceTextures {
  readonly albedo: RawTexture;
  readonly normal: RawTexture;
  readonly metallicRoughness: RawTexture;
}

const CHANNELS = 4;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function byte(value: number): number {
  return Math.round(clamp01(value) * 255);
}

function colorChannels(color: number): readonly [number, number, number] {
  return [
    ((color >>> 16) & 0xff) / 255,
    ((color >>> 8) & 0xff) / 255,
    (color & 0xff) / 255,
  ];
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

/** A wrapped noise lattice's node values, `hash2(x, y, seed)` for x, y < cells. */
interface NoiseLattice {
  readonly cells: number;
  readonly values: Float64Array;
}

function noiseLattice(cells: number, seed: number): NoiseLattice {
  const values = new Float64Array(cells * cells);
  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) values[y * cells + x] = hash2(x, y, seed);
  }
  return { cells, values };
}

/**
 * Smooth value noise in [0, 1) on a wrapped lattice, its nodes at the texel
 * centres of a `cells`-texel map: a `cells`-sized map samples exactly
 * `hash2(x, y, seed)`, and a larger one draws the same values with
 * smoothstep-weighted bilinear in between.
 */
function sampleNoise({ cells, values }: NoiseLattice, u: number, v: number): number {
  const tx = u * cells - 0.5;
  const ty = v * cells - 0.5;
  const x0 = Math.floor(tx);
  const y0 = Math.floor(ty);
  const fx = tx - x0;
  const fy = ty - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  // cells is a power of two: & wraps negatives too.
  const xa = x0 & (cells - 1);
  const xb = (x0 + 1) & (cells - 1);
  const ya = (y0 & (cells - 1)) * cells;
  const yb = ((y0 + 1) & (cells - 1)) * cells;
  const a = values[ya + xa]!;
  const b = values[ya + xb]!;
  const c = values[yb + xa]!;
  const d = values[yb + xb]!;
  const top = a + (b - a) * sx;
  return top + ((c + (d - c) * sx) - top) * sy;
}

function distanceToNearest(value: number, positions: readonly number[]): number {
  let distance = Number.POSITIVE_INFINITY;
  for (const position of positions) distance = Math.min(distance, Math.abs(value - position));
  return distance;
}

function ellipticalMask(
  u: number,
  v: number,
  centerU: number,
  centerV: number,
  radiusU: number,
  radiusV: number,
): number {
  const distance = Math.hypot((u - centerU) / radiusU, (v - centerV) / radiusV);
  return 1 - smoothstep(0.72, 1, distance);
}

/**
 * Produces a tileable-enough local aircraft finish. UV seams are deliberately
 * placed on authored panel boundaries, while the paint grain itself wraps.
 * Feature coverage is returned so the recipe is testable without a GPU or a
 * screenshot judgement.
 */
export function synthesizeAircraftSurface(
  recipe: AircraftPaintRecipe,
  edge = AIRCRAFT_PAINT_EDGE,
): AircraftSurfaceSynthesis {
  if (!Number.isInteger(edge) || edge < 8 || (edge & (edge - 1)) !== 0) {
    throw new RangeError(`Aircraft paint edge must be a power of two >= 8, got ${edge}`);
  }
  const base = colorChannels(recipe.baseColor);
  const livery = colorChannels(recipe.liveryColor);
  const albedo = new Uint8Array(edge * edge * CHANNELS);
  const normalRoughnessAo = new Uint8Array(edge * edge * CHANNELS);
  const metallic = new Uint8Array(edge * edge * CHANNELS);
  const height = new Float32Array(edge * edge);
  const featureCounts = Object.fromEntries(
    AIRCRAFT_PAINT_FEATURES.map((feature) => [feature, 0]),
  ) as Record<AircraftPaintFeature, number>;

  const verticalPanels = [0.16, 0.39, 0.63, 0.84] as const;
  const horizontalPanels = [0.2, 0.49, 0.76] as const;
  const sootStrength = clamp01(recipe.sootStrength ?? 0.82);
  const wearStrength = clamp01(recipe.wearStrength ?? 0.72);
  const panelStrength = clamp01(recipe.panelStrength ?? 1);
  const fillerStrength = clamp01(recipe.fillerStrength ?? 1);
  const rivetStrength = clamp01(recipe.rivetStrength ?? 1);
  const lattice = recipe.noiseLattice;
  if (lattice !== undefined && (!Number.isInteger(lattice) || lattice < 8 || (lattice & (lattice - 1)) !== 0)) {
    throw new RangeError(`Aircraft paint noiseLattice must be a power of two >= 8, got ${lattice}`);
  }
  const [liveryInner, liveryOuter] = recipe.liveryEdge ?? [0.055, 0.085];
  // A rivet dome's half-sizes along and across its line, in UV: about a lattice
  // cell across, as a rivet reads at the lattice's own size.
  const rivetAlong = lattice === undefined ? 0 : 0.6 / lattice;
  const rivetAcross = lattice === undefined ? 0 : 0.9 / lattice;
  // The jitter on a lattice an eighth as fine, the filler mottling on half.
  const lattices = lattice === undefined ? undefined : {
    grain: noiseLattice(lattice, recipe.seed),
    broad: noiseLattice(lattice >> 3, recipe.seed ^ 0x6a09_e667),
    filler: noiseLattice(lattice >> 1, recipe.seed ^ 0xbb67_ae85),
    soot: noiseLattice(lattice, recipe.seed ^ 0x3c6e_f372),
    wear: noiseLattice(lattice, recipe.seed ^ 0xa54f_f53a),
  };

  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const u = (x + 0.5) / edge;
      const v = (y + 0.5) / edge;
      const index = y * edge + x;
      const out = index * CHANNELS;
      const grain = (lattices ? sampleNoise(lattices.grain, u, v) : hash2(x, y, recipe.seed)) - 0.5;
      const broad = (lattices
        ? sampleNoise(lattices.broad, u, v)
        : hash2(x >> 3, y >> 3, recipe.seed ^ 0x6a09_e667)) - 0.5;
      const warpedU = fract(u + broad * 0.012);
      const warpedV = fract(v + grain * 0.004);
      const panelDistance = Math.min(
        distanceToNearest(warpedU, verticalPanels),
        distanceToNearest(warpedV, horizontalPanels),
      );
      const panelLine = (1 - smoothstep(0.004, 0.012, panelDistance)) * panelStrength;
      const seam = (1 - smoothstep(0.003, 0.009, Math.abs(warpedU - 0.63))) * panelStrength;
      const nearVerticalPanel = distanceToNearest(warpedU, verticalPanels) < 0.012;
      const nearHorizontalPanel = distanceToNearest(warpedV, horizontalPanels) < 0.012;
      const rivetPhase = nearVerticalPanel ? fract(v * 30) : fract(u * 30);
      const rivet = (nearVerticalPanel || nearHorizontalPanel)
        && Math.min(rivetPhase, 1 - rivetPhase) < 0.075;
      // On a lattice, a rivet is a dome centred on its line every 1/30, not
      // whichever texels happen to fall in the band: at 256 that band draws
      // dashes across the line, a ladder.
      let rivetAmount = rivet ? 1 : 0;
      if (lattice !== undefined) {
        const acrossVertical = distanceToNearest(warpedU, verticalPanels) / rivetAcross;
        const acrossHorizontal = distanceToNearest(warpedV, horizontalPanels) / rivetAcross;
        // Farther than a dome's half-width from every line: no rivet, and no need to ask.
        if (Math.min(acrossVertical, acrossHorizontal) >= 1) {
          rivetAmount = 0;
        } else {
          const vPhase = fract(v * 30);
          const uPhase = fract(u * 30);
          const onVertical = Math.hypot(acrossVertical, Math.min(vPhase, 1 - vPhase) / 30 / rivetAlong);
          const onHorizontal = Math.hypot(acrossHorizontal, Math.min(uPhase, 1 - uPhase) / 30 / rivetAlong);
          rivetAmount = 1 - smoothstep(0, 1, Math.min(onVertical, onHorizontal));
        }
      }
      const filler = Math.max(
        ellipticalMask(u, v, 0.27, 0.31, 0.095, 0.055),
        ellipticalMask(u, v, 0.73, 0.67, 0.12, 0.07),
      ) * (0.7 + 0.3 * (lattices
        ? sampleNoise(lattices.filler, u, v)
        : hash2(x >> 1, y >> 1, recipe.seed ^ 0xbb67_ae85))) * fillerStrength;
      const sootAxis = Math.abs(v - (0.69 + 0.07 * (u - 0.18)));
      const soot = sootStrength
        * smoothstep(0.08, 0.24, u)
        * (1 - smoothstep(0.56, 0.9, u))
        * (1 - smoothstep(0.015, 0.11, sootAxis))
        * (0.66 + 0.34 * (lattices ? sampleNoise(lattices.soot, u, v) : hash2(x, y, recipe.seed ^ 0x3c6e_f372)));
      const leadingEdge = 1 - smoothstep(0.018, 0.075, Math.min(u, 1 - u));
      const wear = wearStrength * leadingEdge
        * smoothstep(0.2, 0.72, lattices ? sampleNoise(lattices.wear, u, v) : hash2(x, y, recipe.seed ^ 0xa54f_f53a));
      const decalCoordinate = fract(u - v * 0.37 + 0.18);
      const liveryDecal = 1 - smoothstep(liveryInner, liveryOuter, Math.abs(decalCoordinate - 0.5));

      if (panelLine > 0.5) featureCounts["panel-lines"] += 1;
      if (rivetAmount > 0.5 && rivetStrength > 0) featureCounts.rivets += 1;
      if (seam > 0.5) featureCounts.seams += 1;
      if (filler > 0.35) featureCounts.filler += 1;
      if (soot > 0.12) featureCounts["exhaust-soot"] += 1;
      if (wear > 0.12) featureCounts["leading-edge-wear"] += 1;
      if (liveryDecal > 0.5) featureCounts["livery-decal"] += 1;

      const paintVariation = grain * 0.035 + broad * 0.025;
      const fillerTone = filler * 0.16;
      const darkening = panelLine * 0.35 + seam * 0.12 + soot * 0.72;
      const metalExposure = wear * 0.72;
      for (let channel = 0; channel < 3; channel += 1) {
        let value = base[channel]! + paintVariation;
        value = mix(value, livery[channel]!, liveryDecal * 0.92);
        value = mix(value, 0.64, fillerTone);
        value *= 1 - darkening;
        value = mix(value, 0.52 + channel * 0.035, metalExposure);
        albedo[out + channel] = byte(value);
      }
      albedo[out + 3] = 255;

      height[index] = grain * 0.012 - panelLine * 0.085 - seam * 0.035
        + (rivetAmount === 1 ? 0.11 * rivetStrength : 0.11 * rivetStrength * rivetAmount)
        + filler * 0.025 - wear * 0.018;
      const roughness = clamp01(
        recipe.roughness + grain * 0.035 + filler * 0.12 + soot * 0.24 - wear * 0.18,
      );
      const localMetallic = clamp01(mix(recipe.metallic, 0.78, metalExposure));
      const cavity = clamp01(1 - panelLine * 0.2 - seam * 0.09 - soot * 0.06);
      normalRoughnessAo[out + 2] = byte(roughness);
      normalRoughnessAo[out + 3] = byte(cavity);
      metallic[out] = byte(cavity);
      metallic[out + 1] = byte(roughness);
      metallic[out + 2] = byte(localMetallic);
      metallic[out + 3] = 255;
    }
  }

  // Wrapped central differences keep the micro-normal map seamless. The slope
  // stays per TEXEL on a lattice too: the relief that shows (lines, rivets) is
  // about a texel wide at 64 and a few at 256, so per-texel slopes match the
  // 64 design. Taken per lattice cell (x edge / lattice) the 256 map's tilt p90
  // was 39 deg against 12.8 at 64; per texel it is 11.5.
  for (let y = 0; y < edge; y += 1) {
    const previousY = (y + edge - 1) & (edge - 1);
    const nextY = (y + 1) & (edge - 1);
    for (let x = 0; x < edge; x += 1) {
      const previousX = (x + edge - 1) & (edge - 1);
      const nextX = (x + 1) & (edge - 1);
      const dx = height[y * edge + nextX]! - height[y * edge + previousX]!;
      const dy = height[nextY * edge + x]! - height[previousY * edge + x]!;
      const inverseLength = 1 / Math.hypot(dx * 4, dy * 4, 1);
      const out = (y * edge + x) * CHANNELS;
      normalRoughnessAo[out] = byte(-dx * 4 * inverseLength * 0.5 + 0.5);
      normalRoughnessAo[out + 1] = byte(-dy * 4 * inverseLength * 0.5 + 0.5);
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
  // Toksvig roughness belongs in the PBR material map too. Copy the reduced
  // B roughness and A cavity into G/R after the ordinary metallic reduction.
  for (let levelIndex = 0; levelIndex < metallicMips.length; levelIndex += 1) {
    const materialLevel = metallicMips[levelIndex]!;
    const normalLevel = normalMaterialMips[levelIndex]!;
    for (let index = 0; index < materialLevel.length; index += CHANNELS) {
      materialLevel[index] = normalLevel[index + 3]!;
      materialLevel[index + 1] = normalLevel[index + 2]!;
    }
  }

  const texelCount = edge * edge;
  return {
    edge,
    albedoMips: buildMipChain(albedo, edge, "box"),
    normalMips,
    metallicRoughnessMips: metallicMips,
    featureCoverage: Object.fromEntries(
      AIRCRAFT_PAINT_FEATURES.map((feature) => [feature, featureCounts[feature] / texelCount]),
    ) as Record<AircraftPaintFeature, number>,
  };
}

function uploadMipChain(
  scene: Scene,
  name: string,
  edge: number,
  mips: readonly Uint8Array[],
  useSrgbBuffer: boolean,
): RawTexture {
  // The hand-built chain, NOT Babylon's: see `MipChainUpload.ts` (FI-5).
  const texture = createRawTextureFromMipChain(scene, mips, edge, edge, { useSrgbBuffer });
  texture.name = name;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 8;
  return texture;
}

/**
 * The relief half of a synthesized plan: its normal and metallic-roughness
 * maps, without uploading an albedo, for a surface whose colour comes from a
 * livery image instead (`AircraftBuildContext.liveryPaintMaterial`).
 */
export function createAircraftReliefTextures(
  scene: Scene,
  name: string,
  synthesis: AircraftSurfaceSynthesis,
): Omit<AircraftSurfaceTextures, "albedo"> {
  return {
    normal: uploadMipChain(scene, `${name}-normal`, synthesis.edge, synthesis.normalMips, false),
    metallicRoughness: uploadMipChain(
      scene,
      `${name}-metallic-roughness`,
      synthesis.edge,
      synthesis.metallicRoughnessMips,
      false,
    ),
  };
}

/** Babylon upload boundary for a pure synthesized plan. */
export function createAircraftSurfaceTextures(
  scene: Scene,
  name: string,
  synthesis: AircraftSurfaceSynthesis,
): AircraftSurfaceTextures {
  return {
    albedo: uploadMipChain(scene, `${name}-albedo`, synthesis.edge, synthesis.albedoMips, true),
    normal: uploadMipChain(scene, `${name}-normal`, synthesis.edge, synthesis.normalMips, false),
    metallicRoughness: uploadMipChain(
      scene,
      `${name}-metallic-roughness`,
      synthesis.edge,
      synthesis.metallicRoughnessMips,
      false,
    ),
  };
}
