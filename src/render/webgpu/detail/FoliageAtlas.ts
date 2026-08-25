import type { RawTexture2DArray } from "@babylonjs/core/Materials/Textures/rawTexture2DArray";
import type { Scene } from "@babylonjs/core/scene";
import { clamp, fbm2D, smoothstep, valueNoise2D } from "@/src/world/noise";
import { hashSeed, mixSeed, normalizeSeed } from "@/src/world/seed";
import type { WorldSeed } from "@/src/world/types";
import {
  alphaDilate,
  planMippedTextureArray,
  uploadMippedTextureArrayPlan,
  type MippedTextureArrayPlan,
} from "../core/TextureArrayMips";

/**
 * 2-11 — the foliage texture atlas (owner: vegetation).
 *
 * INVARIANT THIS FILE OWNS: every card the detail renderer draws — leaves,
 * needles, bark, grass, fern, heather, reed, shrub foliage and ground
 * litter — samples ONE 256² RGBA `Texture2DArray` whose append-only layer
 * indices are stable and whose texels are a pure function of the world
 * seed. Alpha is coverage for card layers; bark and closed near-crown
 * surfaces are opaque. Two treatments are non-negotiable on the
 * alpha-tested path and both live behind `synthesizeFoliageLayer`: colour
 * is dilated into the transparent margin before mipping (otherwise every
 * leaf grows a dark halo at range) and every mip level is
 * coverage-preserving at the shipping alpha-test threshold (otherwise
 * foliage evaporates with distance). Consumers arriving with 2-12/2-12b/
 * 2-15/2-16 index `FOLIAGE_LAYERS` by name and never re-synthesize.
 *
 * Synthesis is Class P — deterministic seeded streams, no Babylon; the
 * single GPU boundary is `createFoliageAtlas`'s upload call.
 */

export const FOLIAGE_ATLAS_EDGE = 256;

/** Shipping alpha-test threshold (normalized): 128 as a byte. */
export const FOLIAGE_ALPHA_TEST_THRESHOLD = 0.5;

/** Dilation passes applied to every layer before mipping. */
export const FOLIAGE_DILATION_PASSES = 8;

/**
 * Stable layer indices. Card geometry bakes these into UVs and instance
 * data, so reordering is a world-format break: append only.
 */
export const FOLIAGE_LAYERS = Object.freeze({
  broadleafOak: 0,
  broadleafMaple: 1,
  broadleafBirch: 2,
  needlePine: 3,
  needleSpruce: 4,
  barkConifer: 5,
  barkBroadleaf: 6,
  barkBirch: 7,
  grassBlade: 8,
  fernFrond: 9,
  heather: 10,
  reed: 11,
  hazelLeaf: 12,
  juniperScale: 13,
  sageLeaf: 14,
  litterTwig: 15,
  // Closed near-crown surfaces. These are deliberately dense, opaque
  // albedo textures rather than card art with its transparent background.
  // Append-only: existing card/bark indices are part of prototype data.
  crownBroadleafDense: 16,
  crownConiferDense: 17,
} as const);

export type FoliageLayerName = keyof typeof FOLIAGE_LAYERS;

/** Layer names in ascending index order. */
export const FOLIAGE_LAYER_NAMES: readonly FoliageLayerName[] = Object.freeze(
  (Object.keys(FOLIAGE_LAYERS) as FoliageLayerName[]).sort(
    (a, b) => FOLIAGE_LAYERS[a] - FOLIAGE_LAYERS[b],
  ),
);

export const FOLIAGE_LAYER_COUNT = FOLIAGE_LAYER_NAMES.length;

// ---------------------------------------------------------------------------
// Deterministic streams (same generator family as detail/generation.ts).
// ---------------------------------------------------------------------------

type RandomSource = () => number;

function createRandom(seed: string): RandomSource {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Stateless per-texel hash noise in [0, 1) for surface grain. */
function texelNoise(x: number, y: number, seed: number): number {
  let hash = (Math.imul(x, 0x27d4_eb2d) ^ Math.imul(y, 0x1656_67b1) ^ seed) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), hash | 1);
  hash ^= hash + Math.imul(hash ^ (hash >>> 7), hash | 61);
  return ((hash ^ (hash >>> 14)) >>> 0) / 4_294_967_296;
}

function randomNoiseSeed(random: RandomSource): number {
  return Math.floor(random() * 4_294_967_296);
}

// ---------------------------------------------------------------------------
// Tiny software raster: alpha-over compositing plus tapered strokes. The
// whole atlas is 256² per layer, so brute-force bounding-box rasterization
// is milliseconds per layer and keeps every synthesizer readable.
// ---------------------------------------------------------------------------

interface FoliageRaster {
  readonly edge: number;
  readonly rgba: Uint8Array;
}

type Rgb = readonly [number, number, number];

function hsvToRgb(hue: number, saturation: number, value: number): Rgb {
  const wrapped = (((hue % 1) + 1) % 1) * 6;
  const chroma = clamp(value, 0, 1) * clamp(saturation, 0, 1);
  const middle = chroma * (1 - Math.abs((wrapped % 2) - 1));
  const base = clamp(value, 0, 1) - chroma;
  const sector = Math.floor(wrapped) % 6;
  const rgb: readonly (readonly [number, number, number])[] = [
    [chroma, middle, 0],
    [middle, chroma, 0],
    [0, chroma, middle],
    [0, middle, chroma],
    [middle, 0, chroma],
    [chroma, 0, middle],
  ];
  const picked = rgb[sector]!;
  return [
    Math.round((picked[0] + base) * 255),
    Math.round((picked[1] + base) * 255),
    Math.round((picked[2] + base) * 255),
  ];
}

/** Source-over blend of one texel; rgb may exceed 255 and is clamped. */
function paint(
  raster: FoliageRaster,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  alpha: number,
): void {
  if (x < 0 || y < 0 || x >= raster.edge || y >= raster.edge || alpha <= 0) return;
  const at = (y * raster.edge + x) * 4;
  const sourceAlpha = Math.min(1, alpha / 255);
  const destinationAlpha = (raster.rgba[at + 3]! / 255) * (1 - sourceAlpha);
  const outAlpha = sourceAlpha + destinationAlpha;
  if (outAlpha <= 0) return;
  raster.rgba[at] = Math.min(
    255,
    Math.round((r * sourceAlpha + raster.rgba[at]! * destinationAlpha) / outAlpha),
  );
  raster.rgba[at + 1] = Math.min(
    255,
    Math.round((g * sourceAlpha + raster.rgba[at + 1]! * destinationAlpha) / outAlpha),
  );
  raster.rgba[at + 2] = Math.min(
    255,
    Math.round((b * sourceAlpha + raster.rgba[at + 2]! * destinationAlpha) / outAlpha),
  );
  raster.rgba[at + 3] = Math.round(outAlpha * 255);
}

/** Antialiased capsule with linearly interpolated radius; length may be 0. */
function strokeTapered(
  raster: FoliageRaster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius0: number,
  radius1: number,
  color: Rgb,
  alpha = 255,
): void {
  const maxRadius = Math.max(radius0, radius1);
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - maxRadius - 1));
  const maxX = Math.min(raster.edge - 1, Math.ceil(Math.max(x0, x1) + maxRadius + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - maxRadius - 1));
  const maxY = Math.min(raster.edge - 1, Math.ceil(Math.max(y0, y1) + maxRadius + 1));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSquared = dx * dx + dy * dy;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = lengthSquared > 0 ? clamp(((x - x0) * dx + (y - y0) * dy) / lengthSquared, 0, 1) : 0;
      const distance = Math.hypot(x - (x0 + dx * t), y - (y0 + dy * t));
      const radius = radius0 + (radius1 - radius0) * t;
      const coverage = clamp(radius - distance + 0.5, 0, 1);
      if (coverage > 0) paint(raster, x, y, color[0], color[1], color[2], alpha * coverage);
    }
  }
}

interface Polyline {
  readonly xs: number[];
  readonly ys: number[];
}

function curveQuadratic(
  x0: number,
  y0: number,
  controlX: number,
  controlY: number,
  x1: number,
  y1: number,
  segments: number,
): Polyline {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    const inverse = 1 - t;
    xs.push(inverse * inverse * x0 + 2 * inverse * t * controlX + t * t * x1);
    ys.push(inverse * inverse * y0 + 2 * inverse * t * controlY + t * t * y1);
  }
  return { xs, ys };
}

function strokePolyline(
  raster: FoliageRaster,
  line: Polyline,
  radius0: number,
  radius1: number,
  color: Rgb,
  alpha = 255,
): void {
  const segments = line.xs.length - 1;
  for (let segment = 0; segment < segments; segment += 1) {
    const ta = segment / segments;
    const tb = (segment + 1) / segments;
    strokeTapered(
      raster,
      line.xs[segment]!,
      line.ys[segment]!,
      line.xs[segment + 1]!,
      line.ys[segment + 1]!,
      radius0 + (radius1 - radius0) * ta,
      radius0 + (radius1 - radius0) * tb,
      color,
      alpha,
    );
  }
}

/**
 * The shared leaf renderer: a spine-framed shape whose half-width profile
 * carries species identity — sinusoidal margin lobes, high-frequency
 * serration, tip sharpness — shaded by a midrib, pinnate chevron veins and
 * hash grain. Alpha is geometric coverage with a one-texel AA skirt.
 */
interface LeafStyle {
  readonly lengthPx: number;
  readonly halfWidthPx: number;
  /** >1 pushes the widest point toward the base (ovate); <1 toward the tip. */
  readonly tipPower: number;
  readonly lobeCount: number;
  readonly lobeDepth: number;
  readonly serrationCount: number;
  readonly serrationPx: number;
  readonly sideVeinCount: number;
  readonly veinDarken: number;
  readonly grainAmp: number;
}

function drawLeaf(
  raster: FoliageRaster,
  centerX: number,
  centerY: number,
  angle: number,
  style: LeafStyle,
  color: Rgb,
  noiseSeed: number,
): void {
  const directionX = Math.cos(angle);
  const directionY = Math.sin(angle);
  const halfLength = style.lengthPx / 2;
  const reach = Math.ceil(Math.max(halfLength, style.halfWidthPx + style.serrationPx) + 2);
  const minX = Math.max(0, Math.floor(centerX - reach));
  const maxX = Math.min(raster.edge - 1, Math.ceil(centerX + reach));
  const minY = Math.max(0, Math.floor(centerY - reach));
  const maxY = Math.min(raster.edge - 1, Math.ceil(centerY + reach));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x - centerX;
      const py = y - centerY;
      const along = px * directionX + py * directionY;
      const across = -px * directionY + py * directionX;
      const t = (along + halfLength) / style.lengthPx;
      if (t <= 0 || t >= 1) continue;
      const profile = Math.sin(Math.PI * Math.pow(t, style.tipPower));
      const lobed = 1 - style.lobeDepth * (0.5 + 0.5 * Math.cos(2 * Math.PI * style.lobeCount * t));
      const margin =
        style.halfWidthPx * profile * lobed +
        style.serrationPx * Math.sin(2 * Math.PI * style.serrationCount * t) * profile;
      const coverage = clamp(margin - Math.abs(across) + 0.5, 0, 1);
      if (coverage <= 0) continue;
      const chevron = (((t * style.sideVeinCount + Math.abs(across) * 0.085) % 1) + 1) % 1;
      const sideVein = Math.max(0, 1 - Math.min(chevron, 1 - chevron) / 0.07);
      const midrib = Math.max(0, 1 - Math.abs(across) / 1.2);
      const grain = 1 - style.grainAmp / 2 + style.grainAmp * texelNoise(x, y, noiseSeed);
      const shade =
        grain * (1 - style.veinDarken * (0.5 * sideVein + 0.7 * midrib)) * (0.86 + 0.26 * t);
      paint(raster, x, y, color[0] * shade, color[1] * shade, color[2] * shade, 255 * coverage);
    }
  }
}

/** Percentile cut over a field — carves an exact fraction of bark texels. */
function percentileThreshold(values: Float32Array, fraction: number): number {
  const sorted = Float32Array.from(values).sort();
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * fraction)));
  return sorted[index]!;
}

// ---------------------------------------------------------------------------
// Per-layer synthesizers. Each is deterministic in its RandomSource draw
// order; hue/saturation/value jitter WITHIN a layer keeps repeated cards
// from reading as copies.
// ---------------------------------------------------------------------------

type FoliageSynthesizer = (
  raster: FoliageRaster,
  random: RandomSource,
  noiseSeed: number,
) => void;

function synthesizeBroadleafOak(raster: FoliageRaster, random: RandomSource): void {
  // Oak: broad leaves with deep rounded margin lobes and pinnate veins.
  for (let leaf = 0; leaf < 12; leaf += 1) {
    const length = 86 + random() * 34;
    const style: LeafStyle = {
      lengthPx: length,
      halfWidthPx: length * (0.3 + random() * 0.06),
      tipPower: 0.95,
      lobeCount: 4,
      lobeDepth: 0.34 + random() * 0.1,
      serrationCount: 0,
      serrationPx: 0,
      sideVeinCount: 7,
      veinDarken: 0.34,
      grainAmp: 0.16,
    };
    const margin = length * 0.55;
    const centerX = margin + random() * (raster.edge - 2 * margin);
    const centerY = margin + random() * (raster.edge - 2 * margin);
    const angle = random() * Math.PI * 2;
    const color = hsvToRgb(
      0.295 + (random() - 0.5) * 0.05,
      0.52 + (random() - 0.5) * 0.18,
      0.4 + (random() - 0.5) * 0.16,
    );
    drawLeaf(raster, centerX, centerY, angle, style, color, randomNoiseSeed(random));
  }
}

function synthesizeBroadleafMaple(raster: FoliageRaster, random: RandomSource): void {
  // Maple: five deep pointed lobes, palmate-read veins, yellow-shifted greens.
  for (let leaf = 0; leaf < 11; leaf += 1) {
    const length = 92 + random() * 32;
    const style: LeafStyle = {
      lengthPx: length,
      halfWidthPx: length * (0.38 + random() * 0.06),
      tipPower: 1,
      lobeCount: 5,
      lobeDepth: 0.5 + random() * 0.14,
      serrationCount: 20,
      serrationPx: 1.6,
      sideVeinCount: 5,
      veinDarken: 0.3,
      grainAmp: 0.16,
    };
    const margin = length * 0.55;
    const centerX = margin + random() * (raster.edge - 2 * margin);
    const centerY = margin + random() * (raster.edge - 2 * margin);
    const angle = random() * Math.PI * 2;
    const color = hsvToRgb(
      0.24 + (random() - 0.5) * 0.09,
      0.52 + (random() - 0.5) * 0.16,
      0.44 + (random() - 0.5) * 0.14,
    );
    drawLeaf(raster, centerX, centerY, angle, style, color, randomNoiseSeed(random));
  }
}

function synthesizeBroadleafBirch(raster: FoliageRaster, random: RandomSource): void {
  // Birch: small ovate leaves, finely serrated margin, light fresh greens.
  // 16 leaves (2-12): 13 left card coverage under the 0.3 crown floor on
  // some seeds — birch stays the airiest broadleaf, above the floor.
  for (let leaf = 0; leaf < 16; leaf += 1) {
    const length = 76 + random() * 26;
    const style: LeafStyle = {
      lengthPx: length,
      halfWidthPx: length * (0.34 + random() * 0.05),
      tipPower: 1.35,
      lobeCount: 0,
      lobeDepth: 0,
      serrationCount: 26,
      serrationPx: 1.7,
      sideVeinCount: 9,
      veinDarken: 0.3,
      grainAmp: 0.16,
    };
    const margin = length * 0.55;
    const centerX = margin + random() * (raster.edge - 2 * margin);
    const centerY = margin + random() * (raster.edge - 2 * margin);
    const angle = random() * Math.PI * 2;
    const color = hsvToRgb(
      0.3 + (random() - 0.5) * 0.05,
      0.5 + (random() - 0.5) * 0.16,
      0.5 + (random() - 0.5) * 0.16,
    );
    drawLeaf(raster, centerX, centerY, angle, style, color, randomNoiseSeed(random));
  }
}

function synthesizeNeedlePine(raster: FoliageRaster, random: RandomSource): void {
  // Pine BOUGH, not pine sprig (2-12): this layer is a card crown's entire
  // visual mass, and a card whose texture is 10% needles is 90% discard — the
  // capture read as bare terrain with speckle. Fascicles now pack densely
  // along arcing branch spines so the card reads as a solid bough with a
  // ragged silhouette (mip-0 coverage ~0.5; the card-crown floor is pinned
  // by the atlas test).
  const sheathColor = hsvToRgb(0.07, 0.5, 0.32);
  const edge = raster.edge;
  for (let bough = 0; bough < 7; bough += 1) {
    // Spines start near one card edge and arc across the middle, so needle
    // mass concentrates centrally and the silhouette stays ragged.
    let x = edge * (0.18 + random() * 0.64);
    let y = edge * (0.18 + random() * 0.64);
    let heading = random() * Math.PI * 2;
    const spineSteps = 12;
    const stepLength = edge * (0.045 + random() * 0.02);
    for (let step = 0; step < spineSteps; step += 1) {
      heading += (random() - 0.5) * 0.5;
      // Steer back toward the card centre so boughs never walk off the edge.
      heading += Math.atan2(edge / 2 - y, edge / 2 - x) > heading ? 0.08 : -0.08;
      const nextX = x + Math.cos(heading) * stepLength;
      const nextY = y + Math.sin(heading) * stepLength;
      strokeTapered(raster, x, y, nextX, nextY, 2.4 - step * 0.1, 1.6 - step * 0.08, sheathColor, 235);
      // Two fascicles per spine step, splayed to either side.
      for (let cluster = 0; cluster < 2; cluster += 1) {
        const baseX = x + (random() - 0.5) * stepLength;
        const baseY = y + (random() - 0.5) * stepLength;
        const clusterHeading = heading + (cluster === 0 ? 1 : -1) * (0.7 + random() * 0.7);
        const needles = 6 + Math.floor(random() * 3);
        for (let needle = 0; needle < needles; needle += 1) {
          const spread = (needle / (needles - 1) - 0.5) * (1.1 + random() * 0.4);
          const angle = clusterHeading + spread;
          const length = 30 + random() * 20;
          const bend = (random() - 0.5) * 0.5;
          const midX = baseX + Math.cos(angle) * length * 0.5;
          const midY = baseY + Math.sin(angle) * length * 0.5;
          const tipX = baseX + Math.cos(angle + bend * 0.4) * length;
          const tipY = baseY + Math.sin(angle + bend * 0.4) * length;
          const color = hsvToRgb(
            0.36 + (random() - 0.5) * 0.05,
            0.5 + (random() - 0.5) * 0.14,
            0.3 + (random() - 0.5) * 0.1,
          );
          strokeTapered(raster, baseX, baseY, midX, midY, 1.5, 1.0, color);
          strokeTapered(raster, midX, midY, tipX, tipY, 1.0, 0.35, color);
        }
      }
      x = nextX;
      y = nextY;
    }
  }
}

function synthesizeNeedleSpruce(raster: FoliageRaster, random: RandomSource): void {
  // Spruce BOUGH (2-12, same correction as pine): short stiff needles combed
  // densely along brown twigs — but enough overlapping twigs that the card
  // reads as branch mass rather than a scatter of combs.
  const twigColor = hsvToRgb(0.08, 0.45, 0.3);
  for (let twig = 0; twig < 42; twig += 1) {
    let x = 24 + random() * (raster.edge - 48);
    let y = 24 + random() * (raster.edge - 48);
    let heading = random() * Math.PI * 2;
    const baseHue = 0.42 + (random() - 0.5) * 0.04;
    const segmentLength = 13 + random() * 5;
    for (let segment = 0; segment < 6; segment += 1) {
      heading += (random() - 0.5) * 0.36;
      const nextX = x + Math.cos(heading) * segmentLength;
      const nextY = y + Math.sin(heading) * segmentLength;
      strokeTapered(raster, x, y, nextX, nextY, 1.4 - segment * 0.12, 1.3 - segment * 0.12, twigColor);
      for (let step = 0; step < segmentLength; step += 3) {
        const pointX = x + Math.cos(heading) * step;
        const pointY = y + Math.sin(heading) * step;
        for (const side of [-1, 1]) {
          const needleAngle = heading + side * (0.95 + (random() - 0.5) * 0.5);
          const needleLength = 9 + random() * 6;
          const color = hsvToRgb(
            baseHue + (random() - 0.5) * 0.03,
            0.46 + random() * 0.15,
            0.28 + random() * 0.12,
          );
          strokeTapered(
            raster,
            pointX,
            pointY,
            pointX + Math.cos(needleAngle) * needleLength,
            pointY + Math.sin(needleAngle) * needleLength,
            0.95,
            0.3,
            color,
          );
        }
      }
      x = nextX;
      y = nextY;
    }
  }
}

function synthesizeBarkConifer(
  raster: FoliageRaster,
  random: RandomSource,
  noiseSeed: number,
): void {
  // Conifer bark: red-brown plates, ridges stretched vertically. Furrows are
  // dark albedo on a closed cylinder; alpha must stay opaque or the foliage
  // material turns texture cracks into holes through the trunk.
  const { edge, rgba } = raster;
  const warpSeed = mixSeed(noiseSeed, 1);
  const crackSeed = mixSeed(noiseSeed, 2);
  const ridgeSeed = mixSeed(noiseSeed, 3);
  const plateSeed = mixSeed(noiseSeed, 4);
  const grainSeed = mixSeed(noiseSeed, 5);
  const crackField = new Float32Array(edge * edge);
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const warp = valueNoise2D(warpSeed, x * 0.02, y * 0.02) * 16;
      crackField[y * edge + x] = fbm2D(crackSeed, (x + warp) * 0.16, y * 0.03, 3);
    }
  }
  const crackCut = percentileThreshold(crackField, 0.09);
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const texel = y * edge + x;
      const ridge = fbm2D(ridgeSeed, x * 0.09, y * 0.018, 4);
      const plate = valueNoise2D(plateSeed, x * 0.045, y * 0.012);
      const grain = texelNoise(x, y, grainSeed);
      const cracked = crackField[texel]! < crackCut;
      const value =
        clamp(0.3 + ridge * 0.14 + plate * 0.07 + grain * 0.06, 0.08, 0.6) * (cracked ? 0.45 : 1);
      const color = hsvToRgb(0.055 + plate * 0.012, 0.46 - ridge * 0.08, value);
      const at = texel * 4;
      rgba[at] = color[0];
      rgba[at + 1] = color[1];
      rgba[at + 2] = color[2];
      rgba[at + 3] = 255;
    }
  }
}

function synthesizeBarkBroadleaf(
  raster: FoliageRaster,
  random: RandomSource,
  noiseSeed: number,
): void {
  // Broadleaf bark: cool grey-brown, blockier plates, shallower furrows.
  const { edge, rgba } = raster;
  const plateSeed = mixSeed(noiseSeed, 11);
  const crackSeed = mixSeed(noiseSeed, 12);
  const ridgeSeed = mixSeed(noiseSeed, 13);
  const grainSeed = mixSeed(noiseSeed, 14);
  const crackField = new Float32Array(edge * edge);
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const plateWarp = valueNoise2D(plateSeed, x * 0.05, y * 0.016) * 9;
      crackField[y * edge + x] = fbm2D(crackSeed, (x + plateWarp) * 0.11, y * 0.05, 3);
    }
  }
  const crackCut = percentileThreshold(crackField, 0.07);
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const texel = y * edge + x;
      const ridge = fbm2D(ridgeSeed, x * 0.07, y * 0.03, 4);
      const plate = valueNoise2D(plateSeed, x * 0.05, y * 0.016);
      const grain = texelNoise(x, y, grainSeed);
      const cracked = crackField[texel]! < crackCut;
      const value =
        clamp(0.34 + ridge * 0.12 + plate * 0.06 + grain * 0.05, 0.1, 0.62) * (cracked ? 0.5 : 1);
      const color = hsvToRgb(0.09 + plate * 0.015, 0.16 + ridge * 0.05, value);
      const at = texel * 4;
      rgba[at] = color[0];
      rgba[at + 1] = color[1];
      rgba[at + 2] = color[2];
      // Bark fissures are albedo, never geometric coverage.
      rgba[at + 3] = 255;
    }
  }
}

function synthesizeBarkBirch(
  raster: FoliageRaster,
  random: RandomSource,
  noiseSeed: number,
): void {
  // Birch bark: chalk-white sheets, dark horizontal lenticels, peeling chips.
  const { edge, rgba } = raster;
  const patchSeed = mixSeed(noiseSeed, 21);
  const chipSeed = mixSeed(noiseSeed, 22);
  const grainSeed = mixSeed(noiseSeed, 23);
  const chipField = new Float32Array(edge * edge);
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      chipField[y * edge + x] = fbm2D(chipSeed, x * 0.07, y * 0.11, 3);
    }
  }
  const chipCut = percentileThreshold(chipField, 0.08);
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const texel = y * edge + x;
      const patch = smoothstep(0.28, 0.55, valueNoise2D(patchSeed, x * 0.03, y * 0.022));
      const grain = texelNoise(x, y, grainSeed);
      const chipped = chipField[texel]! < chipCut;
      const value = (0.82 + grain * 0.12) * (1 - patch * 0.62) * (chipped ? 0.5 : 1);
      const saturation = 0.05 + patch * 0.1;
      const color = hsvToRgb(0.09, saturation, value);
      const at = texel * 4;
      rgba[at] = color[0];
      rgba[at + 1] = color[1];
      rgba[at + 2] = color[2];
      // Peeling/chipped detail belongs in RGB; trunks are closed geometry.
      rgba[at + 3] = 255;
    }
  }
  for (let lenticel = 0; lenticel < 46; lenticel += 1) {
    const y = random() * edge;
    const x = random() * edge;
    const length = 8 + random() * 24;
    const tilt = (random() - 0.5) * 0.12;
    const color = hsvToRgb(0.08 + random() * 0.02, 0.3, 0.16 + random() * 0.1);
    strokeTapered(
      raster,
      x,
      y,
      x + Math.cos(tilt) * length,
      y + Math.sin(tilt) * length,
      1.4 + random() * 0.5,
      1,
      color,
      235,
    );
  }
}

interface DenseCrownStyle {
  readonly hue: number;
  readonly saturation: number;
  readonly value: number;
  readonly needleGrain: boolean;
}

/**
 * Subtle, fully opaque surface colour for the closed near-crown geometry.
 * The old near tree mapped sparse card art onto dozens of intersecting
 * planes, so the transparent background became most of the tree and the
 * remaining leaves read as dark shreds. Closed lobes need a different
 * texture contract: leaf-scale tonal grain, no large colour islands, and no
 * coverage channel at all. Instance tint still supplies stand/species/season
 * variation, so this layer intentionally stays restrained.
 */
function synthesizeDenseCrown(
  raster: FoliageRaster,
  random: RandomSource,
  noiseSeed: number,
  style: DenseCrownStyle,
): void {
  const macroSeed = mixSeed(noiseSeed, 71);
  const leafSeed = mixSeed(noiseSeed, 72);
  const grainSeed = mixSeed(noiseSeed, 73);
  const phaseX = random() * Math.PI * 2;
  const phaseY = random() * Math.PI * 2;
  const { edge, rgba } = raster;
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const macro = fbm2D(macroSeed, x * 0.028, y * 0.028, 3) - 0.5;
      const leaf = fbm2D(leafSeed, x * 0.15, y * 0.15, 2) - 0.5;
      const directional = style.needleGrain
        ? Math.sin(x * 0.32 + y * 0.09 + phaseX) * 0.5
          + Math.sin(x * 0.13 - y * 0.29 + phaseY) * 0.25
        : Math.sin(x * 0.22 + phaseX) * Math.sin(y * 0.2 + phaseY) * 0.45;
      const grain = texelNoise(x, y, grainSeed) - 0.5;
      // Fix-pack F1: contrast raised (±0.13 → ±0.2 clamp, stronger macro/leaf
      // terms). "Restrained" was right for tint stability but left the hull a
      // near-flat tone; the cluster shading needs texture-level clump
      // structure to anchor against.
      const value = clamp(
        style.value + macro * 0.12 + leaf * 0.16 + directional * 0.04 + grain * 0.025,
        style.value - 0.2,
        style.value + 0.2,
      );
      const hue = style.hue + leaf * 0.018 + macro * 0.01 + grain * 0.005;
      const saturation = clamp(style.saturation + macro * 0.08 - leaf * 0.04, 0, 1);
      const color = hsvToRgb(hue, saturation, value);
      const at = (y * edge + x) * 4;
      rgba[at] = color[0];
      rgba[at + 1] = color[1];
      rgba[at + 2] = color[2];
      rgba[at + 3] = 255;
    }
  }
}

function synthesizeDenseBroadleaf(raster: FoliageRaster, random: RandomSource, seed: number): void {
  synthesizeDenseCrown(raster, random, seed, {
    hue: 0.29, saturation: 0.54, value: 0.45, needleGrain: false,
  });
}

function synthesizeDenseConifer(raster: FoliageRaster, random: RandomSource, seed: number): void {
  synthesizeDenseCrown(raster, random, seed, {
    // Fix-pack F1: 0.37 → 0.42 — under the cluster tone modulation the old
    // value read as black blobs from the air.
    hue: 0.4, saturation: 0.55, value: 0.42, needleGrain: true,
  });
}

function synthesizeGrassBlade(raster: FoliageRaster, random: RandomSource): void {
  // Grass: a tall tapered blade pair arcing apart over dimmer filler blades.
  const edge = raster.edge;
  const drawBlade = (
    baseX: number,
    lean: number,
    length: number,
    baseRadius: number,
    value: number,
    saturation: number,
  ): void => {
    const hue = 0.27 + (random() - 0.5) * 0.045;
    const tipY = Math.max(6, edge - 4 - length);
    const line = curveQuadratic(
      baseX,
      edge - 4,
      baseX + lean * 9,
      edge - 4 - length * 0.55,
      baseX + lean * length * 0.45,
      tipY,
      16,
    );
    for (let segment = 0; segment < 16; segment += 1) {
      const t0 = segment / 16;
      const t1 = (segment + 1) / 16;
      const color = hsvToRgb(hue, saturation, value * (0.78 + 0.3 * t0));
      strokeTapered(
        raster,
        line.xs[segment]!,
        line.ys[segment]!,
        line.xs[segment + 1]!,
        line.ys[segment + 1]!,
        baseRadius * (1 - t0 * 0.92),
        baseRadius * (1 - t1 * 0.92),
        color,
      );
    }
  };
  for (let filler = 0; filler < 6; filler += 1) {
    drawBlade(
      edge * (0.28 + 0.44 * random()),
      (random() - 0.5) * 2.4,
      110 + random() * 70,
      3.8 + random() * 1.4,
      0.26 + random() * 0.08,
      0.42,
    );
  }
  drawBlade(edge * 0.42 + random() * 8, -(0.7 + random() * 0.5), 200 + random() * 40, 6.5 + random() * 1.5, 0.46 + random() * 0.1, 0.58);
  drawBlade(edge * 0.55 + random() * 8, 0.7 + random() * 0.5, 190 + random() * 40, 6.5 + random() * 1.5, 0.42 + random() * 0.1, 0.58);
}

function synthesizeFernFrond(raster: FoliageRaster, random: RandomSource): void {
  // Fern: a curved rachis with alternating pinnae shrinking toward the tip.
  const edge = raster.edge;
  for (let frond = 0; frond < 2; frond += 1) {
    const baseX = edge * (0.3 + 0.4 * random());
    const lean = (random() - 0.5) * 0.9;
    const tipX = clamp(baseX + lean * 90, 20, edge - 20);
    const spine = curveQuadratic(
      baseX,
      edge - 6,
      baseX + lean * 26,
      edge * 0.5,
      tipX,
      16 + random() * 14,
      24,
    );
    strokePolyline(raster, spine, 2.3, 0.6, hsvToRgb(0.2, 0.5, 0.3));
    const hue = 0.31 + (random() - 0.5) * 0.03;
    for (let pinna = 0; pinna < 22; pinna += 1) {
      for (const side of [-1, 1]) {
        const t = (0.08 + (0.88 * (pinna + (side < 0 ? 0.5 : 0))) / 22) * 0.999;
        const index = Math.min(23, Math.max(0, Math.round(t * 24)));
        const pointX = spine.xs[index]!;
        const pointY = spine.ys[index]!;
        const rachisAngle = Math.atan2(
          spine.ys[index + 1]! - pointY,
          spine.xs[index + 1]! - pointX,
        );
        const pinnaAngle = rachisAngle + side * (1.15 + (random() - 0.5) * 0.25);
        const length = (44 - 34 * t) * (0.8 + random() * 0.35);
        const width = 1 - t * 0.5;
        const midX = pointX + Math.cos(pinnaAngle) * length * 0.55;
        const midY = pointY + Math.sin(pinnaAngle) * length * 0.55;
        const color = hsvToRgb(
          hue + (random() - 0.5) * 0.02,
          0.5,
          0.3 + random() * 0.14,
        );
        strokeTapered(raster, pointX, pointY, midX, midY, 3.4 * width, 2.2 * width, color);
        strokeTapered(
          raster,
          midX,
          midY,
          pointX + Math.cos(pinnaAngle + side * 0.3) * length,
          pointY + Math.sin(pinnaAngle + side * 0.3) * length,
          2.2 * width,
          0.4,
          color,
        );
      }
    }
  }
}

function synthesizeHeather(raster: FoliageRaster, random: RandomSource): void {
  // Heather: wiry stems clothed in tiny needle leaves, tips in pink bloom.
  const edge = raster.edge;
  for (let stem = 0; stem < 10; stem += 1) {
    let x = edge * (0.08 + 0.84 * random());
    let y = edge - 4;
    let heading = -Math.PI / 2 + (random() - 0.5) * 0.5;
    const height = 120 + random() * 90;
    const segments = 8;
    const segmentLength = height / segments;
    const stemColor = hsvToRgb(0.06 + random() * 0.03, 0.42, 0.24 + random() * 0.08);
    const leafHue = 0.33 + (random() - 0.5) * 0.04;
    const flowerHue = 0.87 + (random() - 0.5) * 0.05;
    const flowerStart = 0.45 + random() * 0.2;
    for (let segment = 0; segment < segments; segment += 1) {
      heading += (random() - 0.5) * 0.34;
      const nextX = x + Math.cos(heading) * segmentLength;
      const nextY = y + Math.sin(heading) * segmentLength;
      const t = segment / segments;
      strokeTapered(raster, x, y, nextX, nextY, 1.5 - 0.8 * t, 1.5 - 0.8 * (t + 1 / segments), stemColor);
      for (let step = 0; step < 4; step += 1) {
        const st = (step + 0.5) / 4;
        const pointX = x + (nextX - x) * st;
        const pointY = y + (nextY - y) * st;
        if (t >= flowerStart) {
          const color = hsvToRgb(flowerHue + (random() - 0.5) * 0.03, 0.44, 0.72 + random() * 0.16);
          const radius = 1.7 + random() * 0.7;
          strokeTapered(raster, pointX, pointY, pointX, pointY, radius, radius, color);
        } else {
          const side = step % 2 === 0 ? 1 : -1;
          const leafAngle = heading + side * (1.2 + (random() - 0.5) * 0.4);
          const leafLength = 3 + random() * 3;
          const color = hsvToRgb(leafHue + (random() - 0.5) * 0.02, 0.5, 0.3 + random() * 0.12);
          strokeTapered(
            raster,
            pointX,
            pointY,
            pointX + Math.cos(leafAngle) * leafLength,
            pointY + Math.sin(leafAngle) * leafLength,
            0.9,
            0.3,
            color,
          );
        }
      }
      x = nextX;
      y = nextY;
    }
  }
}

function synthesizeReed(raster: FoliageRaster, random: RandomSource): void {
  // Reed: long near-vertical tapered blades and one brown cattail head.
  const edge = raster.edge;
  for (let blade = 0; blade < 5; blade += 1) {
    const baseX = edge * (0.15 + 0.7 * random());
    const lean = (random() - 0.5) * 0.5;
    const height = 200 + random() * 46;
    const tipX = clamp(baseX + lean * height, 10, edge - 10);
    const line = curveQuadratic(
      baseX,
      edge - 3,
      baseX + lean * height * 0.3,
      edge - 3 - height * 0.55,
      tipX,
      Math.max(6, edge - 3 - height),
      14,
    );
    const hue = 0.22 + (random() - 0.5) * 0.05;
    const saturation = 0.42 + random() * 0.16;
    const value = 0.4 + random() * 0.14;
    const baseRadius = 2.8 + random() * 1.2;
    for (let segment = 0; segment < 14; segment += 1) {
      const t0 = segment / 14;
      const t1 = (segment + 1) / 14;
      const color = hsvToRgb(hue, saturation, value * (0.8 + 0.28 * t0));
      strokeTapered(
        raster,
        line.xs[segment]!,
        line.ys[segment]!,
        line.xs[segment + 1]!,
        line.ys[segment + 1]!,
        baseRadius * (1 - t0 * 0.94),
        baseRadius * (1 - t1 * 0.94),
        color,
      );
    }
  }
  const stemX = edge * (0.35 + 0.3 * random());
  strokeTapered(raster, stemX, edge - 3, stemX + 6, 44, 1.4, 0.9, hsvToRgb(0.16, 0.4, 0.35));
  strokeTapered(raster, stemX + 5.2, 70, stemX + 6.5, 40, 4.6, 4, hsvToRgb(0.06, 0.55, 0.3));
}

function synthesizeHazelLeaf(raster: FoliageRaster, random: RandomSource): void {
  // Hazel: rounded doubly-serrate leaves, soft matte greens.
  for (let leaf = 0; leaf < 9; leaf += 1) {
    const length = 88 + random() * 28;
    const style: LeafStyle = {
      lengthPx: length,
      halfWidthPx: length * (0.4 + random() * 0.05),
      tipPower: 1.2,
      lobeCount: 0,
      lobeDepth: 0,
      serrationCount: 30,
      serrationPx: 1.8,
      sideVeinCount: 8,
      veinDarken: 0.3,
      grainAmp: 0.18,
    };
    const margin = length * 0.55;
    const centerX = margin + random() * (raster.edge - 2 * margin);
    const centerY = margin + random() * (raster.edge - 2 * margin);
    const angle = random() * Math.PI * 2;
    const color = hsvToRgb(
      0.31 + (random() - 0.5) * 0.04,
      0.5 + (random() - 0.5) * 0.14,
      0.45 + (random() - 0.5) * 0.14,
    );
    drawLeaf(raster, centerX, centerY, angle, style, color, randomNoiseSeed(random));
  }
}

function synthesizeJuniperScale(raster: FoliageRaster, random: RandomSource): void {
  // Juniper: sprays of overlapping scale foliage on short branching axes.
  const edge = raster.edge;
  const walk = (x: number, y: number, heading: number, segments: number, segmentLength: number): Polyline => {
    const xs = [x];
    const ys = [y];
    for (let segment = 0; segment < segments; segment += 1) {
      heading += (random() - 0.5) * 0.36;
      x += Math.cos(heading) * segmentLength;
      y += Math.sin(heading) * segmentLength;
      xs.push(x);
      ys.push(y);
    }
    return { xs, ys };
  };
  const scaleAlong = (line: Polyline, scaleLength: number, hue: number): void => {
    for (let segment = 0; segment + 1 < line.xs.length; segment += 1) {
      const segmentDx = line.xs[segment + 1]! - line.xs[segment]!;
      const segmentDy = line.ys[segment + 1]! - line.ys[segment]!;
      const segmentLength = Math.hypot(segmentDx, segmentDy);
      const angle = Math.atan2(segmentDy, segmentDx);
      for (let along = 0; along < segmentLength; along += 2.0) {
        const pointX = line.xs[segment]! + Math.cos(angle) * along;
        const pointY = line.ys[segment]! + Math.sin(angle) * along;
        for (const side of [-1, 1]) {
          const scaleAngle = angle + side * (0.62 + (random() - 0.5) * 0.3);
          const length = scaleLength * (0.75 + random() * 0.5);
          const color = hsvToRgb(hue + (random() - 0.5) * 0.03, 0.4 + random() * 0.12, 0.34 + random() * 0.16);
          strokeTapered(
            raster,
            pointX,
            pointY,
            pointX + Math.cos(scaleAngle) * length,
            pointY + Math.sin(scaleAngle) * length,
            1.4,
            0.5,
            color,
          );
        }
      }
    }
  };
  // 17 sprays from varied anchors (2-12b): six bottom-anchored sprays left
  // the card 90% discard — the same sprig-vs-card correction as the 2-12
  // needle layers, now that shrub cards are this layer's first consumer.
  for (let spray = 0; spray < 24; spray += 1) {
    const bottomAnchored = spray < 6;
    const baseX = edge * (0.12 + 0.76 * random());
    const baseY = bottomAnchored
      ? edge - 6 - random() * 24
      : edge * (0.2 + 0.6 * random());
    const heading = bottomAnchored
      ? -Math.PI / 2 + (random() - 0.5) * 1.1
      : random() * Math.PI * 2;
    const hue = 0.4 + (random() - 0.5) * 0.03;
    const axis = walk(baseX, baseY, heading, 8, 13 + random() * 4);
    strokePolyline(raster, axis, 1.7, 0.6, hsvToRgb(0.1, 0.4, 0.3));
    scaleAlong(axis, 6.5, hue);
    for (const branchAt of [2, 4, 6]) {
      if (random() < 0.25) continue;
      const branchX = axis.xs[branchAt]!;
      const branchY = axis.ys[branchAt]!;
      const axisAngle = Math.atan2(axis.ys[branchAt + 1]! - branchY, axis.xs[branchAt + 1]! - branchX);
      const side = random() < 0.5 ? -1 : 1;
      const branch = walk(branchX, branchY, axisAngle + side * (0.7 + random() * 0.3), 4, 10);
      scaleAlong(branch, 4, hue);
    }
  }
}

function synthesizeSageLeaf(raster: FoliageRaster, random: RandomSource): void {
  // Sage: narrow oblong grey-green leaves with a heavy pebbled grain.
  // 22 leaves (2-12b): 12 sat under the card-coverage floor once shrub
  // cards became the layer's consumer.
  for (let leaf = 0; leaf < 22; leaf += 1) {
    const length = 68 + random() * 24;
    const style: LeafStyle = {
      lengthPx: length,
      halfWidthPx: length * (0.2 + random() * 0.05),
      tipPower: 1.1,
      lobeCount: 0,
      lobeDepth: 0,
      serrationCount: 0,
      serrationPx: 0,
      sideVeinCount: 6,
      veinDarken: 0.2,
      grainAmp: 0.32,
    };
    const margin = length * 0.55;
    const centerX = margin + random() * (raster.edge - 2 * margin);
    const centerY = margin + random() * (raster.edge - 2 * margin);
    const angle = random() * Math.PI * 2;
    const color = hsvToRgb(
      0.33 + (random() - 0.5) * 0.03,
      0.16 + (random() - 0.5) * 0.1,
      0.6 + (random() - 0.5) * 0.16,
    );
    drawLeaf(raster, centerX, centerY, angle, style, color, randomNoiseSeed(random));
  }
}

function synthesizeLitterTwig(raster: FoliageRaster, random: RandomSource): void {
  // Litter: scattered forked twigs and a few curled dead leaves.
  const edge = raster.edge;
  for (let twig = 0; twig < 17; twig += 1) {
    let x = 12 + random() * (edge - 24);
    let y = 12 + random() * (edge - 24);
    let heading = random() * Math.PI * 2;
    const length = 34 + random() * 40;
    const color = hsvToRgb(
      0.065 + (random() - 0.5) * 0.03,
      0.44 + random() * 0.14,
      0.22 + random() * 0.14,
    );
    const radius = 1.5 + random() * 0.7;
    for (let segment = 0; segment < 3; segment += 1) {
      heading += (random() - 0.5) * 0.5;
      const nextX = x + Math.cos(heading) * (length / 3);
      const nextY = y + Math.sin(heading) * (length / 3);
      strokeTapered(raster, x, y, nextX, nextY, radius * (1 - segment * 0.2), radius * (1 - (segment + 1) * 0.2), color);
      if (segment === 1 && random() < 0.45) {
        const forkAngle = heading + (random() < 0.5 ? -1 : 1) * (0.5 + random() * 0.3);
        strokeTapered(
          raster,
          x,
          y,
          x + Math.cos(forkAngle) * length * 0.4,
          y + Math.sin(forkAngle) * length * 0.4,
          radius * 0.7,
          0.4,
          color,
        );
      }
      x = nextX;
      y = nextY;
    }
  }
  for (let deadLeaf = 0; deadLeaf < 6; deadLeaf += 1) {
    const length = 26 + random() * 16;
    const style: LeafStyle = {
      lengthPx: length,
      halfWidthPx: length * 0.34,
      tipPower: 1.05,
      lobeCount: 0,
      lobeDepth: 0,
      serrationCount: 0,
      serrationPx: 0,
      sideVeinCount: 5,
      veinDarken: 0.3,
      grainAmp: 0.3,
    };
    const color = hsvToRgb(0.07 + random() * 0.03, 0.5, 0.3 + random() * 0.12);
    drawLeaf(
      raster,
      20 + random() * (edge - 40),
      20 + random() * (edge - 40),
      random() * Math.PI * 2,
      style,
      color,
      randomNoiseSeed(random),
    );
  }
}

const SYNTHESIZERS: Readonly<Record<FoliageLayerName, FoliageSynthesizer>> = Object.freeze({
  broadleafOak: synthesizeBroadleafOak,
  broadleafMaple: synthesizeBroadleafMaple,
  broadleafBirch: synthesizeBroadleafBirch,
  needlePine: synthesizeNeedlePine,
  needleSpruce: synthesizeNeedleSpruce,
  barkConifer: synthesizeBarkConifer,
  barkBroadleaf: synthesizeBarkBroadleaf,
  barkBirch: synthesizeBarkBirch,
  grassBlade: synthesizeGrassBlade,
  fernFrond: synthesizeFernFrond,
  heather: synthesizeHeather,
  reed: synthesizeReed,
  hazelLeaf: synthesizeHazelLeaf,
  juniperScale: synthesizeJuniperScale,
  sageLeaf: synthesizeSageLeaf,
  litterTwig: synthesizeLitterTwig,
  crownBroadleafDense: synthesizeDenseBroadleaf,
  crownConiferDense: synthesizeDenseConifer,
});

// ---------------------------------------------------------------------------
// Atlas assembly.
// ---------------------------------------------------------------------------

/**
 * Bark is sampled with repeat addressing around and along a closed trunk.
 * The procedural noise above is intentionally non-periodic, so joining its
 * opposite edges directly would turn the texture boundary into a physical
 * stripe (a horizontal ring for V) every two metres. Heal a restrained band
 * on both axes on the CPU: the outer texels meet exactly, while a smooth
 * falloff keeps the texture's interior detail intact. This has no per-frame
 * cost and happens before mip generation so every sampled level inherits the
 * continuous edge.
 */
const BARK_TILE_BLEND_TEXELS = FOLIAGE_ATLAS_EDGE / 16;

function blendBarkTileAxis(rgba: Uint8Array, edge: number, vertical: boolean): void {
  const source = new Uint8Array(rgba);
  for (let distance = 0; distance < BARK_TILE_BLEND_TEXELS; distance += 1) {
    const seamWeight = 1 - smoothstep(
      0,
      1,
      distance / (BARK_TILE_BLEND_TEXELS - 1),
    );
    for (let across = 0; across < edge; across += 1) {
      const firstTexel = vertical
        ? distance * edge + across
        : across * edge + distance;
      const secondTexel = vertical
        ? (edge - 1 - distance) * edge + across
        : across * edge + edge - 1 - distance;
      const first = firstTexel * 4;
      const second = secondTexel * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const firstValue = source[first + channel]!;
        const secondValue = source[second + channel]!;
        const midpoint = (firstValue + secondValue) * 0.5;
        rgba[first + channel] = Math.round(
          firstValue + (midpoint - firstValue) * seamWeight,
        );
        rgba[second + channel] = Math.round(
          secondValue + (midpoint - secondValue) * seamWeight,
        );
      }
    }
  }
}

function makeBarkTileable(rgba: Uint8Array, edge: number): void {
  blendBarkTileAxis(rgba, edge, true);
  blendBarkTileAxis(rgba, edge, false);
}

/**
 * One synthesized, alpha-dilated 256²×4 RGBA layer — a pure function of
 * (layer, seed). Dilation happens HERE, not at atlas build, so any consumer
 * of a single layer (tools, tests, future impostor bakes) gets halo-safe
 * texels by construction.
 */
export function synthesizeFoliageLayer(layer: FoliageLayerName, seed: WorldSeed): Uint8Array {
  const layerSeed = `foliage-atlas/${normalizeSeed(seed)}/${layer}`;
  const raster: FoliageRaster = {
    edge: FOLIAGE_ATLAS_EDGE,
    rgba: new Uint8Array(FOLIAGE_ATLAS_EDGE * FOLIAGE_ATLAS_EDGE * 4),
  };
  SYNTHESIZERS[layer](raster, createRandom(layerSeed), hashSeed(layerSeed));
  if (layer.startsWith("bark")) makeBarkTileable(raster.rgba, raster.edge);
  return alphaDilate(raster.rgba, FOLIAGE_ATLAS_EDGE, FOLIAGE_DILATION_PASSES);
}

/** Every append-only layer in `FOLIAGE_LAYERS` index order. Pure. */
export function synthesizeFoliageLayers(seed: WorldSeed): Uint8Array[] {
  return FOLIAGE_LAYER_NAMES.map((layer) => synthesizeFoliageLayer(layer, seed));
}

/**
 * The pure half of `createFoliageAtlas`: every layer reduced through the
 * coverage-preserving kernel at the shipping alpha-test threshold. Node
 * tests assert chain structure and coverage on exactly this plan.
 */
export function planFoliageAtlas(seed: WorldSeed): MippedTextureArrayPlan {
  return planMippedTextureArray(synthesizeFoliageLayers(seed), FOLIAGE_ATLAS_EDGE, {
    kind: "coverage",
    alphaTestThreshold: FOLIAGE_ALPHA_TEST_THRESHOLD,
  });
}

export interface FoliageAtlas {
  readonly texture: RawTexture2DArray;
  readonly layerCount: number;
  /** Actual bytes across every layer of every mip level, in MiB. */
  readonly memoryMiB: number;
}

/**
 * GPU boundary: synthesize, mip and upload the full atlas — every layer
 * carrying the complete coverage-preserved chain (assertion 45b).
 */
export function createFoliageAtlas(scene: Scene, seed: WorldSeed): FoliageAtlas {
  const plan = planFoliageAtlas(seed);
  const texture = uploadMippedTextureArrayPlan(scene, plan, {
    name: `foliage-atlas/${normalizeSeed(seed)}`,
  });
  return {
    texture,
    layerCount: plan.layerCount,
    memoryMiB: plan.totalBytes / (1024 * 1024),
  };
}
