import type { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import { createRawTextureFromMipChain } from "@/src/render/webgpu/core/MipChainUpload";
import { buildMipChain } from "@/src/render/webgpu/core/TextureArrayMips";
import { hashLatticeCoordinates, unitFloatFromHash } from "@/src/world/seed";

/**
 * The Runabout 21's ONE texture atlas: every opaque part of the boat (hull,
 * deck, seats, consoles, outboard, propeller, wheel) wears one PBR material
 * and picks its finish by UV, so the boat costs a draw per moving part rather
 * than a draw per colour.
 *
 * Three maps share one layout, `ATLAS_EDGE` square:
 *  - albedo (sRGB),
 *  - metallic-roughness (R ambient 1, G roughness, B metallic: Babylon's
 *    green/blue convention, as the aircraft paint uses),
 *  - emissive: black except the dash's backlit markings, the needles and the
 *    depth sounder's lit segments, so the helm glow is one intensity.
 *
 * LAYOUT, in texels from the top-left (v grows down the buffer):
 *  - rows 0-63: `SWATCH_CELL` square swatches of one finish each. A part's UV
 *    sits at its swatch's centre, so it reads one colour at every distance.
 *  - rows 64-191: the four dial faces, `DIAL_CELL` square each: tachometer,
 *    speedometer, trim gauge, depth sounder.
 *  - rows 256-511: the non-skid deck, planar over the whole deck (x along u,
 *    z along v), a fine pebble in colour and roughness.
 *
 * Only `ATLAS_MIP_LEVELS` levels are kept: at the last one a swatch is still
 * two texels across, so a swatch never bleeds into its neighbour at range.
 */
export const ATLAS_EDGE = 512;
export const SWATCH_CELL = 32;
export const DIAL_CELL = 128;
export const ATLAS_MIP_LEVELS = 5;
const SWATCHES_PER_ROW = ATLAS_EDGE / SWATCH_CELL;
const DIAL_TOP = 64;
const NON_SKID_TOP = 256;

/** Hull-frame extents the non-skid region spans (metres): x 0..6.6, z -1.32..1.32. */
export const NON_SKID_SPAN = Object.freeze({ minX: 0, maxX: 6.6, minZ: -1.32, maxZ: 1.32 });

interface Finish {
  /** sRGB 0-255. */
  readonly albedo: readonly [number, number, number];
  readonly roughness: number;
  readonly metallic?: number;
  /** sRGB 0-255 emissive, black when absent. */
  readonly emissive?: readonly [number, number, number];
}

/**
 * Every finish on the boat. Gelcoat is glossy (roughness 0.14), as a polished
 * moulding is; vinyl is satin; the dash and rubber are matte; the stainless
 * fittings and propeller are metal.
 */
const FINISHES = {
  gelcoat: { albedo: [240, 240, 235], roughness: 0.14 },
  hullColour: { albedo: [20, 38, 72], roughness: 0.16 },
  pinstripe: { albedo: [178, 182, 188], roughness: 0.3, metallic: 0.6 },
  bottom: { albedo: [226, 227, 221], roughness: 0.24 },
  liner: { albedo: [234, 233, 226], roughness: 0.32 },
  vinyl: { albedo: [238, 235, 224], roughness: 0.46 },
  vinylAccent: { albedo: [34, 52, 84], roughness: 0.46 },
  dash: { albedo: [22, 23, 25], roughness: 0.55 },
  rubber: { albedo: [16, 16, 16], roughness: 0.85 },
  stainless: { albedo: [206, 208, 211], roughness: 0.2, metallic: 1 },
  anodized: { albedo: [24, 24, 26], roughness: 0.35, metallic: 0.4 },
  cowl: { albedo: [14, 15, 17], roughness: 0.16 },
  lowerUnit: { albedo: [78, 80, 84], roughness: 0.32 },
  propeller: { albedo: [196, 198, 202], roughness: 0.16, metallic: 1 },
  needle: { albedo: [255, 120, 30], roughness: 0.4, emissive: [255, 104, 20] },
  segment: { albedo: [250, 176, 70], roughness: 0.3, emissive: [255, 156, 48] },
  gloveBox: { albedo: [52, 54, 58], roughness: 0.5 },
  decal: { albedo: [245, 245, 245], roughness: 0.2 },
  cowlAccent: { albedo: [176, 26, 30], roughness: 0.2 },
  lcd: { albedo: [18, 28, 22], roughness: 0.2 },
  lensHousing: { albedo: [18, 18, 18], roughness: 0.4 },
  zinc: { albedo: [150, 152, 150], roughness: 0.6, metallic: 0.8 },
} as const satisfies Record<string, Finish>;

export type BoatFinish = keyof typeof FINISHES;
export const BOAT_FINISHES = Object.freeze(Object.keys(FINISHES) as BoatFinish[]);

/** The four dial faces, left to right in the dial strip. */
export type BoatDial = "tachometer" | "speedometer" | "trim" | "depth";
const DIAL_ORDER: readonly BoatDial[] = ["tachometer", "speedometer", "trim", "depth"];

/** UV of a finish's swatch centre. */
export function finishUv(finish: BoatFinish): readonly [number, number] {
  const index = BOAT_FINISHES.indexOf(finish);
  const column = index % SWATCHES_PER_ROW;
  const row = Math.floor(index / SWATCHES_PER_ROW);
  return [((column + 0.5) * SWATCH_CELL) / ATLAS_EDGE, ((row + 0.5) * SWATCH_CELL) / ATLAS_EDGE];
}

/**
 * UV of a point on a dial face: `(s, t)` in [-1, 1] across the face, +t up
 * the dial. The face's outer ring (|r| > 0.9) is its bezel.
 */
export function dialUv(dial: BoatDial, s: number, t: number): readonly [number, number] {
  const index = DIAL_ORDER.indexOf(dial);
  const half = DIAL_CELL / 2;
  return [(index * DIAL_CELL + half + s * (half - 1)) / ATLAS_EDGE, (DIAL_TOP + half - t * (half - 1)) / ATLAS_EDGE];
}

/** UV of the non-skid at a hull-frame deck point. */
export function nonSkidUv(x: number, z: number): readonly [number, number] {
  const u = (x - NON_SKID_SPAN.minX) / (NON_SKID_SPAN.maxX - NON_SKID_SPAN.minX);
  const v = (z - NON_SKID_SPAN.minZ) / (NON_SKID_SPAN.maxZ - NON_SKID_SPAN.minZ);
  const clampedU = Math.min(1, Math.max(0, u));
  const clampedV = Math.min(1, Math.max(0, v));
  return [(0.5 + clampedU * (ATLAS_EDGE - 1)) / ATLAS_EDGE, (NON_SKID_TOP + 0.5 + clampedV * (ATLAS_EDGE - NON_SKID_TOP - 1)) / ATLAS_EDGE];
}

/**
 * The dial laws: the needle angle for a reading, radians clockwise from
 * straight up on the face. The drawn markings and the posed needles both use
 * these, so a needle points at the number it reads.
 */
export const DIAL_SWEEP = Object.freeze({
  /** 0 to 7,000 rpm over 270 degrees, the red line from 6,000. */
  tachometer: { minimum: 0, maximum: 7_000, startDegrees: -135, endDegrees: 135, redFrom: 6_000 },
  /** 0 to 70 mph over 270 degrees. */
  speedometer: { minimum: 0, maximum: 70, startDegrees: -135, endDegrees: 135, redFrom: Number.POSITIVE_INFINITY },
  /** Trim 0..1 (in to out) over 120 degrees. */
  trim: { minimum: 0, maximum: 1, startDegrees: -60, endDegrees: 60, redFrom: Number.POSITIVE_INFINITY },
});

export function dialNeedleAngle(dial: keyof typeof DIAL_SWEEP, reading: number): number {
  const sweep = DIAL_SWEEP[dial];
  const safe = Number.isFinite(reading) ? reading : sweep.minimum;
  const t = Math.min(1, Math.max(0, (safe - sweep.minimum) / (sweep.maximum - sweep.minimum)));
  return ((sweep.startDegrees + t * (sweep.endDegrees - sweep.startDegrees)) * Math.PI) / 180;
}

export interface BoatAtlasPixels {
  readonly albedo: Uint8Array;
  readonly metallicRoughness: Uint8Array;
  readonly emissive: Uint8Array;
}

/** 5x7 glyphs for the dial legends, one string per row, top first. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
};

const MARKING: readonly [number, number, number] = [236, 238, 242];
const MARKING_GLOW: readonly [number, number, number] = [214, 226, 255];
const RED_LINE: readonly [number, number, number] = [214, 40, 36];

class AtlasPainter {
  readonly albedo = new Uint8Array(ATLAS_EDGE * ATLAS_EDGE * 4);
  readonly metallicRoughness = new Uint8Array(ATLAS_EDGE * ATLAS_EDGE * 4);
  readonly emissive = new Uint8Array(ATLAS_EDGE * ATLAS_EDGE * 4);

  constructor() {
    // Unpainted texels: mid grey, rough, dark. Nothing samples them.
    for (let index = 0; index < ATLAS_EDGE * ATLAS_EDGE; index += 1) {
      this.set(index % ATLAS_EDGE, Math.floor(index / ATLAS_EDGE), [128, 128, 128], 0.6, 0, [0, 0, 0]);
    }
  }

  set(
    x: number,
    y: number,
    albedo: readonly [number, number, number],
    roughness: number,
    metallic: number,
    emissive: readonly [number, number, number],
  ): void {
    if (x < 0 || y < 0 || x >= ATLAS_EDGE || y >= ATLAS_EDGE) return;
    const at = (y * ATLAS_EDGE + x) * 4;
    this.albedo.set([albedo[0], albedo[1], albedo[2], 255], at);
    this.metallicRoughness.set([255, Math.round(roughness * 255), Math.round(metallic * 255), 255], at);
    this.emissive.set([emissive[0], emissive[1], emissive[2], 255], at);
  }

  /** Blend `coverage` of a marking over the texel. */
  blend(
    x: number,
    y: number,
    coverage: number,
    albedo: readonly [number, number, number],
    roughness: number,
    emissive: readonly [number, number, number],
  ): void {
    if (coverage <= 0 || x < 0 || y < 0 || x >= ATLAS_EDGE || y >= ATLAS_EDGE) return;
    const c = Math.min(1, coverage);
    const at = (y * ATLAS_EDGE + x) * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      this.albedo[at + channel] = Math.round(this.albedo[at + channel]! * (1 - c) + albedo[channel]! * c);
      this.emissive[at + channel] = Math.round(this.emissive[at + channel]! * (1 - c) + emissive[channel]! * c);
    }
    this.metallicRoughness[at + 1] = Math.round(this.metallicRoughness[at + 1]! * (1 - c) + roughness * 255 * c);
  }

  /** An anti-aliased line of `width` texels between two points. */
  line(x0: number, y0: number, x1: number, y1: number, width: number, colour: readonly [number, number, number], glow: readonly [number, number, number]): void {
    const minX = Math.floor(Math.min(x0, x1) - width - 1);
    const maxX = Math.ceil(Math.max(x0, x1) + width + 1);
    const minY = Math.floor(Math.min(y0, y1) - width - 1);
    const maxY = Math.ceil(Math.max(y0, y1) + width + 1);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lengthSquared = Math.max(dx * dx + dy * dy, 1e-9);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        const t = Math.min(1, Math.max(0, ((px - x0) * dx + (py - y0) * dy) / lengthSquared));
        const distance = Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
        this.blend(x, y, width / 2 + 0.5 - distance, colour, 0.5, glow);
      }
    }
  }

  /** A legend in the 5x7 font, centred at (cx, cy), `scale` texels a glyph pixel. */
  text(label: string, cx: number, cy: number, scale: number, colour: readonly [number, number, number], glow: readonly [number, number, number]): void {
    const advance = 6 * scale;
    const width = label.length * advance - scale;
    const left = Math.round(cx - width / 2);
    const top = Math.round(cy - (7 * scale) / 2);
    for (let character = 0; character < label.length; character += 1) {
      const glyph = GLYPHS[label[character]!];
      if (!glyph) continue;
      for (let row = 0; row < 7; row += 1) {
        for (let column = 0; column < 5; column += 1) {
          if (glyph[row]![column] !== "#") continue;
          for (let sy = 0; sy < scale; sy += 1) {
            for (let sx = 0; sx < scale; sx += 1) {
              this.blend(left + character * advance + column * scale + sx, top + row * scale + sy, 1, colour, 0.5, glow);
            }
          }
        }
      }
    }
  }
}

function paintSwatches(painter: AtlasPainter): void {
  for (const [index, name] of BOAT_FINISHES.entries()) {
    const finish: Finish = FINISHES[name];
    const left = (index % SWATCHES_PER_ROW) * SWATCH_CELL;
    const top = Math.floor(index / SWATCHES_PER_ROW) * SWATCH_CELL;
    for (let y = top; y < top + SWATCH_CELL; y += 1) {
      for (let x = left; x < left + SWATCH_CELL; x += 1) {
        painter.set(x, y, finish.albedo, finish.roughness, finish.metallic ?? 0, finish.emissive ?? [0, 0, 0]);
      }
    }
  }
}

/** A round dial: chrome bezel, black face, ticks and numerals on `sweep`. */
function paintRoundDial(
  painter: AtlasPainter,
  dial: BoatDial,
  sweep: { readonly startDegrees: number; readonly endDegrees: number },
  majors: readonly string[],
  minorsPerMajor: number,
  redFrom: number | null,
  legend: string,
): void {
  const index = DIAL_ORDER.indexOf(dial);
  const cx = index * DIAL_CELL + DIAL_CELL / 2;
  const cy = DIAL_TOP + DIAL_CELL / 2;
  const half = DIAL_CELL / 2 - 1;
  const bezel = FINISHES.stainless;
  for (let y = DIAL_TOP; y < DIAL_TOP + DIAL_CELL; y += 1) {
    for (let x = index * DIAL_CELL; x < (index + 1) * DIAL_CELL; x += 1) {
      const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / half;
      if (r > 0.9) painter.set(x, y, bezel.albedo, bezel.roughness, 1, [0, 0, 0]);
      else painter.set(x, y, [10, 10, 12], 0.25, 0, [0, 0, 0]);
    }
  }
  const radius = half * 0.86;
  const steps = (majors.length - 1) * minorsPerMajor;
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const degrees = sweep.startDegrees + t * (sweep.endDegrees - sweep.startDegrees);
    const angle = (degrees * Math.PI) / 180;
    const major = step % minorsPerMajor === 0;
    const inner = major ? 0.8 : 0.88;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const red = redFrom !== null && t * (majors.length - 1) >= redFrom - 1e-9;
    painter.line(cx + sin * radius * inner, cy - cos * radius * inner, cx + sin * radius, cy - cos * radius, major ? 3 : 1.6, red ? RED_LINE : MARKING, red ? [200, 30, 24] : MARKING_GLOW);
    if (major) {
      const label = majors[step / minorsPerMajor]!;
      const at = radius * 0.6;
      painter.text(label, cx + sin * at, cy - cos * at, label.length > 1 ? 1 : 2, MARKING, MARKING_GLOW);
    }
  }
  painter.text(legend, cx, cy + half * 0.42, 1, MARKING, MARKING_GLOW);
}

function paintDepthDial(painter: AtlasPainter): void {
  const index = DIAL_ORDER.indexOf("depth");
  const cx = index * DIAL_CELL + DIAL_CELL / 2;
  const cy = DIAL_TOP + DIAL_CELL / 2;
  const half = DIAL_CELL / 2 - 1;
  const lcd = FINISHES.lcd;
  for (let y = DIAL_TOP; y < DIAL_TOP + DIAL_CELL; y += 1) {
    for (let x = index * DIAL_CELL; x < (index + 1) * DIAL_CELL; x += 1) {
      const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / half;
      if (r > 0.9) painter.set(x, y, FINISHES.stainless.albedo, FINISHES.stainless.roughness, 1, [0, 0, 0]);
      else painter.set(x, y, lcd.albedo, lcd.roughness, 0, [6, 10, 8]);
    }
  }
  painter.text("FT", cx, cy + half * 0.5, 1, [200, 150, 70], [150, 110, 40]);
}

function paintNonSkid(painter: AtlasPainter): void {
  // A warm light grey, darker than the gelcoat round it, as moulded non-skid reads.
  const base = [212, 210, 201] as const;
  for (let y = NON_SKID_TOP; y < ATLAS_EDGE; y += 1) {
    for (let x = 0; x < ATLAS_EDGE; x += 1) {
      // Two scales of pebble: a fine grain per texel and a coarser mottle.
      const fine = unitFloatFromHash(hashLatticeCoordinates(0x5b0a_7d, x, y));
      const coarse = unitFloatFromHash(hashLatticeCoordinates(0x5b0a_7e, x >> 2, y >> 2));
      const shade = (fine - 0.5) * 10 + (coarse - 0.5) * 6 - 8;
      const albedo: [number, number, number] = [base[0] + shade, base[1] + shade, base[2] + shade - 2];
      painter.set(x, y, albedo, 0.66 + 0.12 * fine, 0, [0, 0, 0]);
    }
  }
}

/** The atlas's three maps at level 0, deterministic. */
export function synthesizeBoatAtlas(): BoatAtlasPixels {
  const painter = new AtlasPainter();
  paintSwatches(painter);
  paintRoundDial(painter, "tachometer", DIAL_SWEEP.tachometer, ["0", "1", "2", "3", "4", "5", "6", "7"], 4, 6, "RPM");
  paintRoundDial(painter, "speedometer", DIAL_SWEEP.speedometer, ["0", "10", "20", "30", "40", "50", "60", "70"], 2, null, "MPH");
  paintRoundDial(painter, "trim", DIAL_SWEEP.trim, ["D", "", "", "", "U"], 1, null, "TRIM");
  paintDepthDial(painter);
  paintNonSkid(painter);
  return { albedo: painter.albedo, metallicRoughness: painter.metallicRoughness, emissive: painter.emissive };
}

export interface BoatAtlasTextures {
  readonly albedo: RawTexture;
  readonly metallicRoughness: RawTexture;
  readonly emissive: RawTexture;
}

function upload(scene: Scene, name: string, pixels: Uint8Array, srgb: boolean): RawTexture {
  const levels = buildMipChain(pixels, ATLAS_EDGE, "box").slice(0, ATLAS_MIP_LEVELS);
  const texture = createRawTextureFromMipChain(scene, levels, ATLAS_EDGE, ATLAS_EDGE, { useSrgbBuffer: srgb });
  texture.name = name;
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 8;
  return texture;
}

export function createBoatAtlasTextures(scene: Scene, pixels: BoatAtlasPixels = synthesizeBoatAtlas()): BoatAtlasTextures {
  return {
    albedo: upload(scene, "boat-atlas-albedo", pixels.albedo, true),
    metallicRoughness: upload(scene, "boat-atlas-metallic-roughness", pixels.metallicRoughness, false),
    emissive: upload(scene, "boat-atlas-emissive", pixels.emissive, true),
  };
}
