import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import type { Scene } from "@babylonjs/core/scene";
import { createRawTextureFromMipChain } from "@/src/render/webgpu/core/MipChainUpload";
import { buildRectMipChain } from "@/src/render/webgpu/ground/carAtlas";

/**
 * The walker's ONE texture atlas: every part of the figure wears one PBR
 * material and picks its finish by UV, as the car's parts do.
 *
 * Two maps share one layout, `FIGURE_ATLAS_SIZE` square: albedo (sRGB) and
 * metallic-roughness (G roughness, B metallic).
 *
 * LAYOUT, in texels from the top-left (V grows down the buffer):
 *  - rows 0-63: `SWATCH_CELL` swatches, one finish each. A cell shades from
 *    `MAX_SHADE` darker at its top to the full colour at its bottom, and a
 *    vertex's V inside its cell is its baked ambient occlusion (the armpits,
 *    the inner thighs and under the chin read darker at no cost per pixel).
 *  - rows 64-191, columns 0-127: the face, projected along +X onto (right,
 *    up) from `FACE_SPAN`: skin in the swatch's colour, with eyes, brows,
 *    lips and a little colour in the cheeks painted in.
 *
 * Plain outdoor clothes in neutral colours (the build brief): an olive-grey
 * soft-shell jacket, stone trousers on a leather belt, brown leather boots on
 * dark soles, short dark-brown hair.
 */
export const FIGURE_ATLAS_SIZE = 256;
const SWATCH_CELL = 32;
const SWATCHES_PER_ROW = FIGURE_ATLAS_SIZE / SWATCH_CELL;
const FACE_TOP = 64;
const FACE_SIZE = 128;
const MIP_LEVELS = 5;
/** The darkest a swatch's top row reaches: a vertex's shade is at most this. */
export const MAX_SHADE = 0.6;

interface Finish {
  /** sRGB 0-255. */
  readonly albedo: readonly [number, number, number];
  readonly roughness: number;
  readonly metallic?: number;
}

const FINISHES = {
  jacket: { albedo: [86, 94, 80], roughness: 0.84 },
  trousers: { albedo: [148, 136, 112], roughness: 0.9 },
  belt: { albedo: [60, 44, 33], roughness: 0.55 },
  boot: { albedo: [98, 68, 45], roughness: 0.58 },
  sole: { albedo: [36, 33, 30], roughness: 0.86 },
  skin: { albedo: [198, 148, 118], roughness: 0.55 },
  hair: { albedo: [48, 37, 29], roughness: 0.62 },
  buckle: { albedo: [150, 146, 136], roughness: 0.35, metallic: 0.8 },
} as const satisfies Record<string, Finish>;

export type FigureSwatch = keyof typeof FINISHES;
export const FIGURE_SWATCHES = Object.freeze(Object.keys(FINISHES) as FigureSwatch[]);
export const FIGURE_SWATCH: Readonly<Record<FigureSwatch, FigureSwatch>> = Object.freeze(
  Object.fromEntries(FIGURE_SWATCHES.map((name) => [name, name])) as Record<FigureSwatch, FigureSwatch>,
);

/** The face's projection: right (+Z) and up (Y) across the face texture, metres. */
export const FACE_SPAN = Object.freeze({ minRight: -0.075, maxRight: 0.075, minUp: 1.53, maxUp: 1.73 });

/** UV of a swatch at a shade (0 full colour .. `MAX_SHADE`). */
export function swatchUv(swatch: FigureSwatch, shade = 0): readonly [number, number] {
  const index = FIGURE_SWATCHES.indexOf(swatch);
  const column = index % SWATCHES_PER_ROW;
  const row = Math.floor(index / SWATCHES_PER_ROW);
  const share = 1 - Math.min(1, Math.max(0, shade / MAX_SHADE));
  // Two texels in from the cell's edges, so filtering never reaches a neighbour.
  const texelRow = row * SWATCH_CELL + 2 + share * (SWATCH_CELL - 5) + 0.5;
  return [((column + 0.5) * SWATCH_CELL) / FIGURE_ATLAS_SIZE, texelRow / FIGURE_ATLAS_SIZE];
}

/** UV of a point on the face: `right` and `up` in metres in the root frame. */
export function faceUv(right: number, up: number): readonly [number, number] {
  const u = Math.min(1, Math.max(0, (right - FACE_SPAN.minRight) / (FACE_SPAN.maxRight - FACE_SPAN.minRight)));
  const v = Math.min(1, Math.max(0, (FACE_SPAN.maxUp - up) / (FACE_SPAN.maxUp - FACE_SPAN.minUp)));
  return [(1 + u * (FACE_SIZE - 3) + 0.5) / FIGURE_ATLAS_SIZE, (FACE_TOP + 1 + v * (FACE_SIZE - 3) + 0.5) / FIGURE_ATLAS_SIZE];
}

export interface FigureAtlasPixels {
  readonly albedo: Uint8Array;
  readonly metallicRoughness: Uint8Array;
}

/** The atlas's two maps, level 0. */
export function synthesizeFigureAtlas(): FigureAtlasPixels {
  const size = FIGURE_ATLAS_SIZE;
  const albedo = new Uint8Array(size * size * 4);
  const metallicRoughness = new Uint8Array(size * size * 4);
  const set = (x: number, y: number, rgb: readonly [number, number, number], roughness: number, metallic = 0): void => {
    const i = (y * size + x) * 4;
    albedo[i] = Math.round(Math.min(255, Math.max(0, rgb[0])));
    albedo[i + 1] = Math.round(Math.min(255, Math.max(0, rgb[1])));
    albedo[i + 2] = Math.round(Math.min(255, Math.max(0, rgb[2])));
    albedo[i + 3] = 255;
    metallicRoughness[i] = 255;
    metallicRoughness[i + 1] = Math.round(roughness * 255);
    metallicRoughness[i + 2] = Math.round(metallic * 255);
    metallicRoughness[i + 3] = 255;
  };
  const skin = FINISHES.skin;
  // Everything not painted below is skin, so a stray sample is never a hole.
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) set(x, y, skin.albedo, skin.roughness);
  FIGURE_SWATCHES.forEach((name, index) => {
    const finish: Finish = FINISHES[name];
    const column = index % SWATCHES_PER_ROW;
    const row = Math.floor(index / SWATCHES_PER_ROW);
    for (let y = 0; y < SWATCH_CELL; y += 1) {
      // Darkest at the top, in linear light so the shade is an occlusion factor.
      const share = Math.min(1, Math.max(0, (y - 2) / (SWATCH_CELL - 5)));
      const factor = 1 - MAX_SHADE * (1 - share);
      const rgb = finish.albedo.map((c) => linearToSrgb(srgbToLinear(c) * factor)) as unknown as [number, number, number];
      for (let x = 0; x < SWATCH_CELL; x += 1) set(column * SWATCH_CELL + x, row * SWATCH_CELL + y, rgb, finish.roughness, finish.metallic ?? 0);
    }
  });
  paintFace(set);
  return { albedo, metallicRoughness };
}

type Painter = (x: number, y: number, rgb: readonly [number, number, number], roughness: number, metallic?: number) => void;

function paintFace(set: Painter): void {
  const skin = FINISHES.skin.albedo;
  const mix = (a: readonly number[], b: readonly number[], t: number): [number, number, number] => [
    a[0]! + (b[0]! - a[0]!) * t,
    a[1]! + (b[1]! - a[1]!) * t,
    a[2]! + (b[2]! - a[2]!) * t,
  ];
  const g = (value: number, centre: number, sigma: number): number => Math.exp(-(((value - centre) / sigma) ** 2));
  for (let py = 0; py < FACE_SIZE; py += 1) {
    for (let px = 0; px < FACE_SIZE; px += 1) {
      const right = FACE_SPAN.minRight + ((px - 1) / (FACE_SIZE - 3)) * (FACE_SPAN.maxRight - FACE_SPAN.minRight);
      const up = FACE_SPAN.maxUp - ((py - 1) / (FACE_SIZE - 3)) * (FACE_SPAN.maxUp - FACE_SPAN.minUp);
      const side = Math.abs(right);
      let rgb: [number, number, number] = [skin[0], skin[1], skin[2]];
      let roughness: number = FINISHES.skin.roughness;
      // Warmth in the cheeks and lips' surround, a faint shadow of stubble on the jaw.
      rgb = mix(rgb, [206, 130, 112], 0.35 * g(up, 1.6, 0.018) * g(side, 0.045, 0.02));
      rgb = mix(rgb, [150, 118, 98], 0.25 * g(up, 1.558, 0.022) * (1 - g(side, 0, 0.02) * 0.4) * g(side, 0.03, 0.04));
      // Eyes: the white, the iris, the lid line above.
      const eyeDx = (side - 0.032) / 0.0125;
      const eyeDy = (up - 1.647) / 0.0048;
      const eye = eyeDx * eyeDx + eyeDy * eyeDy;
      if (eye < 1) {
        rgb = [226, 220, 212];
        roughness = 0.3;
        const iris = Math.hypot(side - 0.031, up - 1.647);
        if (iris < 0.0044) rgb = iris < 0.0019 ? [18, 14, 12] : [76, 54, 38];
      }
      const lid = g(up, 1.6515, 0.0016) * g(side, 0.032, 0.011);
      rgb = mix(rgb, [70, 48, 40], 0.75 * lid);
      // Brows.
      const brow = g(up, 1.6645 - 0.06 * (side - 0.033) ** 2 * 40, 0.0028) * g(side, 0.034, 0.014);
      rgb = mix(rgb, [52, 40, 32], Math.min(1, 1.1 * brow));
      // Lips, and the line between them.
      const lips = g(up, 1.578, 0.0045) * g(side, 0, 0.016);
      rgb = mix(rgb, [164, 96, 86], 0.8 * lips);
      rgb = mix(rgb, [92, 52, 48], 0.6 * g(up, 1.578, 0.0012) * g(side, 0, 0.018));
      // Nostrils.
      rgb = mix(rgb, [90, 58, 50], 0.6 * g(up, 1.607, 0.0025) * g(side, 0.0075, 0.003));
      set(px, FACE_TOP + py, rgb, roughness);
    }
  }
}

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(l: number): number {
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return s * 255;
}

export interface FigureAtlasTextures {
  readonly albedo: RawTexture;
  readonly metallicRoughness: RawTexture;
}

function upload(scene: Scene, name: string, pixels: Uint8Array, srgb: boolean): RawTexture {
  const levels = buildRectMipChain(pixels, FIGURE_ATLAS_SIZE, FIGURE_ATLAS_SIZE, MIP_LEVELS);
  const texture = createRawTextureFromMipChain(scene, levels, FIGURE_ATLAS_SIZE, FIGURE_ATLAS_SIZE, { useSrgbBuffer: srgb });
  texture.name = name;
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 4;
  return texture;
}

export function createFigureAtlasTextures(scene: Scene, pixels: FigureAtlasPixels = synthesizeFigureAtlas()): FigureAtlasTextures {
  return {
    albedo: upload(scene, "person-atlas-albedo", pixels.albedo, true),
    metallicRoughness: upload(scene, "person-atlas-metallic-roughness", pixels.metallicRoughness, false),
  };
}
