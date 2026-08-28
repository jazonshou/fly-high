import { Constants } from "@babylonjs/core/Engines/constants";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
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

  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const u = (x + 0.5) / edge;
      const v = (y + 0.5) / edge;
      const index = y * edge + x;
      const out = index * CHANNELS;
      const grain = hash2(x, y, recipe.seed) - 0.5;
      const broad = hash2(x >> 3, y >> 3, recipe.seed ^ 0x6a09_e667) - 0.5;
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
      const filler = Math.max(
        ellipticalMask(u, v, 0.27, 0.31, 0.095, 0.055),
        ellipticalMask(u, v, 0.73, 0.67, 0.12, 0.07),
      ) * (0.7 + 0.3 * hash2(x >> 1, y >> 1, recipe.seed ^ 0xbb67_ae85));
      const sootAxis = Math.abs(v - (0.69 + 0.07 * (u - 0.18)));
      const soot = sootStrength
        * smoothstep(0.08, 0.24, u)
        * (1 - smoothstep(0.56, 0.9, u))
        * (1 - smoothstep(0.015, 0.11, sootAxis))
        * (0.66 + 0.34 * hash2(x, y, recipe.seed ^ 0x3c6e_f372));
      const leadingEdge = 1 - smoothstep(0.018, 0.075, Math.min(u, 1 - u));
      const wear = wearStrength * leadingEdge
        * smoothstep(0.2, 0.72, hash2(x, y, recipe.seed ^ 0xa54f_f53a));
      const decalCoordinate = fract(u - v * 0.37 + 0.18);
      const liveryDecal = 1 - smoothstep(0.055, 0.085, Math.abs(decalCoordinate - 0.5));

      if (panelLine > 0.5) featureCounts["panel-lines"] += 1;
      if (rivet) featureCounts.rivets += 1;
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
        + (rivet ? 0.11 : 0) + filler * 0.025 - wear * 0.018;
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

  // Wrapped central differences keep the micro-normal map seamless.
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
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 8;
  for (let level = 1; level < mips.length; level += 1) {
    texture.updateMipLevel(mips[level]!, level);
  }
  return texture;
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
