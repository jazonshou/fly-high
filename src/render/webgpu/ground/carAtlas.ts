import type { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import { createRawTextureFromMipChain } from "@/src/render/webgpu/core/MipChainUpload";
import { hashLatticeCoordinates, unitFloatFromHash } from "@/src/world/seed";
import {
  ARCH,
  BODY,
  DOOR_LINES,
  GLASSHOUSE,
  GRILLE_INSERT,
  LC76_FRONT_AXLE_X,
  LC76_REAR_AXLE_X,
  LC76_TYRE_LOADED_RADIUS,
  REAR_DOOR_SPLIT_Z,
  SHELL_SPLIT_Z,
  SIDE_WINDOW_BOTTOM,
} from "./lc76Lines";

/**
 * The LandCruiser 76's ONE texture atlas: every opaque part of the car wears
 * one PBR material and picks its finish by UV, as the boat's do, so the car
 * costs a draw per moving part rather than a draw per colour.
 *
 * Three maps share one layout, `ATLAS_WIDTH` x `ATLAS_HEIGHT`:
 *  - albedo (sRGB),
 *  - metallic-roughness (R the clear coat's share, G roughness, B metallic):
 *    the paint wears a full clear coat and the plastics, rubber and metals
 *    none, so one material carries both,
 *  - emissive: black but for the gauges' backlit markings, so the dash
 *    glow is one intensity on the cockpit's material.
 *
 * LAYOUT, in texels from the top-left (v grows down the buffer):
 *  - rows 0-63: `SWATCH_CELL` square swatches of one finish each, read at
 *    their centres so a part is one colour at every distance.
 *  - rows 64-319: the body's sides, mapped flat along x and up the height
 *    (`sideUv`): paint, with the doors' shut lines, the handles, the fuel
 *    flap and the pillars' black-outs drawn in.
 *  - rows 320-383: the grille insert's black mesh, across its width
 *    (`grilleUv`).
 *  - rows 384-511, left half: the four dial faces, `DIAL_CELL` square.
 *  - rows 384-511, right half: the tail, mapped flat across z and up the
 *    height (`rearUv`): the barn doors' paint and dust, with their shut
 *    lines drawn in. Its edge texels run on into a `REAR_MARGIN` border,
 *    so the dials and the grille never bleed onto the tail at range.
 *
 * Only `ATLAS_MIP_LEVELS` levels are kept: at the last a swatch is still two
 * texels across, so a swatch never bleeds into its neighbour at range.
 */
export const ATLAS_WIDTH = 1024;
export const ATLAS_HEIGHT = 512;
export const SWATCH_CELL = 32;
export const DIAL_CELL = 128;
export const ATLAS_MIP_LEVELS = 5;
const SWATCHES_PER_ROW = ATLAS_WIDTH / SWATCH_CELL;
const SIDE_TOP = 64;
const SIDE_ROWS = 256;
const GRILLE_TOP = 320;
const GRILLE_ROWS = 64;
const DIAL_TOP = 384;
const REAR_TOP = 384;
const REAR_LEFT = 512;
const REAR_COLUMNS = 512;
const REAR_ROWS = 128;
const REAR_MARGIN = 8;

/** The side map's extent: the whole body's length, from the sills to the roof. */
export const SIDE_SPAN = Object.freeze({
  minX: BODY.bumperRear - 0.02,
  maxX: BODY.bumperFront + 0.02,
  minHeight: 0.38,
  maxHeight: 1.97,
});

interface Finish {
  /** sRGB 0-255. */
  readonly albedo: readonly [number, number, number];
  readonly roughness: number;
  readonly metallic?: number;
  readonly emissive?: readonly [number, number, number];
  /** The clear coat over it, 0..1: the paint's lacquer. */
  readonly clearCoat?: number;
}

/**
 * Every finish on the car. Toyota's French Vanilla is a warm white, glossy
 * as fresh paint is; the bumpers are painted steel, the flares and mirrors
 * moulded black plastic, the cabin grey vinyl and cloth.
 */
const FINISHES = {
  paint: { albedo: [226, 222, 208], roughness: 0.3, clearCoat: 1 },
  blackPlastic: { albedo: [30, 31, 32], roughness: 0.72 },
  /** The over-fenders' moulded black, a touch duller than the trim. */
  flare: { albedo: [26, 27, 28], roughness: 0.8 },
  seal: { albedo: [12, 12, 13], roughness: 0.55 },
  bumper: { albedo: [104, 106, 108], roughness: 0.46, metallic: 0.35, clearCoat: 0.5 },
  chrome: { albedo: [214, 216, 220], roughness: 0.12, metallic: 1 },
  chassis: { albedo: [20, 20, 21], roughness: 0.78 },
  underbody: { albedo: [38, 37, 35], roughness: 0.9 },
  rubber: { albedo: [24, 24, 24], roughness: 0.9 },
  /** Rubber under a film of the road it runs on. */
  sidewall: { albedo: [46, 44, 41], roughness: 0.86 },
  steelWheel: { albedo: [168, 170, 172], roughness: 0.38, metallic: 0.65 },
  hub: { albedo: [46, 46, 48], roughness: 0.5, metallic: 0.4 },
  lugNut: { albedo: [196, 198, 200], roughness: 0.25, metallic: 1 },
  brakeDisc: { albedo: [92, 88, 84], roughness: 0.5, metallic: 0.8 },
  axle: { albedo: [26, 26, 27], roughness: 0.62, metallic: 0.2 },
  spring: { albedo: [40, 40, 42], roughness: 0.5, metallic: 0.3 },
  shock: { albedo: [178, 30, 26], roughness: 0.4 },
  exhaust: { albedo: [86, 70, 58], roughness: 0.62, metallic: 0.5 },
  dash: { albedo: [44, 45, 47], roughness: 0.7 },
  trim: { albedo: [78, 78, 76], roughness: 0.8 },
  headliner: { albedo: [150, 146, 138], roughness: 0.92 },
  seat: { albedo: [42, 43, 47], roughness: 0.92 },
  carpet: { albedo: [28, 28, 30], roughness: 1 },
  plate: { albedo: [232, 232, 226], roughness: 0.4 },
  mirrorGlass: { albedo: [150, 160, 170], roughness: 0.04, metallic: 1 },
  reflector: { albedo: [200, 200, 204], roughness: 0.18, metallic: 1 },
  grilleBlack: { albedo: [16, 16, 17], roughness: 0.55 },
  wheelGrip: { albedo: [22, 22, 23], roughness: 0.65 },
  needle: { albedo: [255, 120, 30], roughness: 0.4, emissive: [255, 104, 20] },
  switchGlow: { albedo: [40, 40, 42], roughness: 0.5, emissive: [120, 160, 255] },
  badge: { albedo: [200, 202, 206], roughness: 0.2, metallic: 1 },
  /** The GXL's dark grey alloy wheels, and their barrels' dull inside. */
  alloy: { albedo: [70, 72, 76], roughness: 0.32, metallic: 0.75, clearCoat: 0.6 },
  barrel: { albedo: [40, 41, 43], roughness: 0.6, metallic: 0.4 },
  /** The tread's blocks: their tops worn and dusty, lighter than the grooves between them. */
  tread: { albedo: [60, 56, 50], roughness: 0.9 },
  /** The grille's TOYOTA letters: satin silver. */
  lettering: { albedo: [178, 180, 184], roughness: 0.3, metallic: 0.9 },
} as const satisfies Record<string, Finish>;

export type CarFinish = keyof typeof FINISHES;
export const CAR_FINISHES = Object.freeze(Object.keys(FINISHES) as CarFinish[]);

/** The four dial faces, left to right in the dial strip. */
export type CarDial = "tachometer" | "speedometer" | "fuel" | "temperature";
const DIAL_ORDER: readonly CarDial[] = ["tachometer", "speedometer", "fuel", "temperature"];

/** UV of a finish's swatch centre. */
export function finishUv(finish: CarFinish): readonly [number, number] {
  const index = CAR_FINISHES.indexOf(finish);
  const column = index % SWATCHES_PER_ROW;
  const row = Math.floor(index / SWATCHES_PER_ROW);
  return [((column + 0.5) * SWATCH_CELL) / ATLAS_WIDTH, ((row + 0.5) * SWATCH_CELL) / ATLAS_HEIGHT];
}

/** UV of a body-frame side point, (x, height above ground). */
export function sideUv(x: number, height: number): readonly [number, number] {
  const u = (x - SIDE_SPAN.minX) / (SIDE_SPAN.maxX - SIDE_SPAN.minX);
  const v = (SIDE_SPAN.maxHeight - height) / (SIDE_SPAN.maxHeight - SIDE_SPAN.minHeight);
  const cu = Math.min(1, Math.max(0, u));
  const cv = Math.min(1, Math.max(0, v));
  return [(0.5 + cu * (ATLAS_WIDTH - 1)) / ATLAS_WIDTH, (SIDE_TOP + 0.5 + cv * (SIDE_ROWS - 1)) / ATLAS_HEIGHT];
}

/** The rear map's extent: the tail across the body's width, from the doors' foot to the gutter. */
export const REAR_SPAN = Object.freeze({
  halfWidth: BODY.halfWidth,
  minHeight: BODY.rearBottom,
  maxHeight: GLASSHOUSE.head,
});

/** UV of a body-frame point on the tail, (z across, height above ground). */
export function rearUv(z: number, height: number): readonly [number, number] {
  const u = (z + REAR_SPAN.halfWidth) / (2 * REAR_SPAN.halfWidth);
  const v = (REAR_SPAN.maxHeight - height) / (REAR_SPAN.maxHeight - REAR_SPAN.minHeight);
  const cu = Math.min(1, Math.max(0, u));
  const cv = Math.min(1, Math.max(0, v));
  return [
    (REAR_LEFT + REAR_MARGIN + 0.5 + cu * (REAR_COLUMNS - 2 * REAR_MARGIN - 1)) / ATLAS_WIDTH,
    (REAR_TOP + REAR_MARGIN + 0.5 + cv * (REAR_ROWS - 2 * REAR_MARGIN - 1)) / ATLAS_HEIGHT,
  ];
}

/** UV across the grille: `s` 0..1 left to right seen from ahead, `t` 0..1 bottom to top. */
export function grilleUv(s: number, t: number): readonly [number, number] {
  const cs = Math.min(1, Math.max(0, s));
  const ct = Math.min(1, Math.max(0, t));
  return [(0.5 + cs * (ATLAS_WIDTH - 1)) / ATLAS_WIDTH, (GRILLE_TOP + 0.5 + (1 - ct) * (GRILLE_ROWS - 1)) / ATLAS_HEIGHT];
}

/**
 * UV on a dial face: `(s, t)` in [-1, 1] across the face, +t up the dial.
 * The face's outer ring (|r| > 0.9) is its chrome bezel.
 */
export function dialUv(dial: CarDial, s: number, t: number): readonly [number, number] {
  const index = DIAL_ORDER.indexOf(dial);
  const half = DIAL_CELL / 2;
  return [(index * DIAL_CELL + half + s * (half - 1)) / ATLAS_WIDTH, (DIAL_TOP + half - t * (half - 1)) / ATLAS_HEIGHT];
}

/**
 * The gauges' laws: the needle angle for a reading, radians clockwise from
 * straight up on the face. The drawn markings and the posed needles both use
 * them, so a needle points at the number it reads.
 */
export const DIAL_SWEEP = Object.freeze({
  /** 0 to 5,000 rpm over 240 degrees, the red line from 4,000 (the 1GD-FTV's limiter). */
  tachometer: { minimum: 0, maximum: 5_000, startDegrees: -120, endDegrees: 120, redFrom: 4_000 },
  /** 0 to 180 km/h over 240 degrees. */
  speedometer: { minimum: 0, maximum: 180, startDegrees: -120, endDegrees: 120, redFrom: Number.POSITIVE_INFINITY },
  /** Empty to full over 90 degrees. */
  fuel: { minimum: 0, maximum: 1, startDegrees: -45, endDegrees: 45, redFrom: Number.POSITIVE_INFINITY },
  /** Cold to hot over 90 degrees. */
  temperature: { minimum: 0, maximum: 1, startDegrees: -45, endDegrees: 45, redFrom: Number.POSITIVE_INFINITY },
});

export function dialNeedleAngle(dial: CarDial, reading: number): number {
  const sweep = DIAL_SWEEP[dial];
  const safe = Number.isFinite(reading) ? reading : sweep.minimum;
  const t = Math.min(1, Math.max(0, (safe - sweep.minimum) / (sweep.maximum - sweep.minimum)));
  return ((sweep.startDegrees + t * (sweep.endDegrees - sweep.startDegrees)) * Math.PI) / 180;
}

export interface CarAtlasPixels {
  readonly albedo: Uint8Array;
  readonly metallicRoughness: Uint8Array;
  readonly emissive: Uint8Array;
}

/** 5x7 glyphs for the dial legends and the grille's letters, one string per row, top first. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  "/": ["....#", "...#.", "...#.", "..#..", ".#...", ".#...", "#...."],
  x: [".....", ".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
};

const MARKING: readonly [number, number, number] = [236, 238, 242];
const MARKING_GLOW: readonly [number, number, number] = [214, 226, 255];
const RED_LINE: readonly [number, number, number] = [214, 40, 36];
const NO_GLOW: readonly [number, number, number] = [0, 0, 0];

class AtlasPainter {
  readonly albedo = new Uint8Array(ATLAS_WIDTH * ATLAS_HEIGHT * 4);
  readonly metallicRoughness = new Uint8Array(ATLAS_WIDTH * ATLAS_HEIGHT * 4);
  readonly emissive = new Uint8Array(ATLAS_WIDTH * ATLAS_HEIGHT * 4);

  constructor() {
    // Unpainted texels: the paint, so a region's edge bleeds into white at range.
    for (let index = 0; index < ATLAS_WIDTH * ATLAS_HEIGHT; index += 1) {
      this.set(index % ATLAS_WIDTH, Math.floor(index / ATLAS_WIDTH), FINISHES.paint.albedo, FINISHES.paint.roughness, 0, NO_GLOW, 1);
    }
  }

  set(
    x: number,
    y: number,
    albedo: readonly [number, number, number],
    roughness: number,
    metallic: number,
    emissive: readonly [number, number, number],
    clearCoat = 0,
  ): void {
    if (x < 0 || y < 0 || x >= ATLAS_WIDTH || y >= ATLAS_HEIGHT) return;
    const at = (y * ATLAS_WIDTH + x) * 4;
    this.albedo[at] = albedo[0];
    this.albedo[at + 1] = albedo[1];
    this.albedo[at + 2] = albedo[2];
    this.albedo[at + 3] = 255;
    this.metallicRoughness[at] = Math.round(clearCoat * 255);
    this.metallicRoughness[at + 1] = Math.round(roughness * 255);
    this.metallicRoughness[at + 2] = Math.round(metallic * 255);
    this.metallicRoughness[at + 3] = 255;
    this.emissive[at] = emissive[0];
    this.emissive[at + 1] = emissive[1];
    this.emissive[at + 2] = emissive[2];
    this.emissive[at + 3] = 255;
  }

  /** Blend `coverage` of a marking over the texel. */
  blend(
    x: number,
    y: number,
    coverage: number,
    albedo: readonly [number, number, number],
    roughness: number,
    emissive: readonly [number, number, number],
    metallic?: number,
  ): void {
    if (coverage <= 0 || x < 0 || y < 0 || x >= ATLAS_WIDTH || y >= ATLAS_HEIGHT) return;
    const c = Math.min(1, coverage);
    const at = (y * ATLAS_WIDTH + x) * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      this.albedo[at + channel] = Math.round(this.albedo[at + channel]! * (1 - c) + albedo[channel]! * c);
      this.emissive[at + channel] = Math.round(this.emissive[at + channel]! * (1 - c) + emissive[channel]! * c);
    }
    this.metallicRoughness[at + 1] = Math.round(this.metallicRoughness[at + 1]! * (1 - c) + roughness * 255 * c);
    if (metallic !== undefined) {
      this.metallicRoughness[at + 2] = Math.round(this.metallicRoughness[at + 2]! * (1 - c) + metallic * 255 * c);
    }
  }

  /** An anti-aliased line of `width` texels between two points. */
  line(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    width: number,
    colour: readonly [number, number, number],
    glow: readonly [number, number, number],
    roughness = 0.5,
  ): void {
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
        this.blend(x, y, width / 2 + 0.5 - distance, colour, roughness, glow);
      }
    }
  }

  /** An anti-aliased filled rectangle with rounded corners, in texels. */
  roundedRect(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    radius: number,
    colour: readonly [number, number, number],
    roughness: number,
    metallic?: number,
  ): void {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const hx = (x1 - x0) / 2;
    const hy = (y1 - y0) / 2;
    for (let y = Math.floor(y0) - 1; y <= Math.ceil(y1) + 1; y += 1) {
      for (let x = Math.floor(x0) - 1; x <= Math.ceil(x1) + 1; x += 1) {
        const qx = Math.abs(x + 0.5 - cx) - (hx - radius);
        const qy = Math.abs(y + 0.5 - cy) - (hy - radius);
        const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
        this.blend(x, y, 0.5 - outside, colour, roughness, NO_GLOW, metallic);
      }
    }
  }

  /** A legend in the 5x7 font, centred at (cx, cy), `scale` texels a glyph pixel (`scaleY` tall). */
  text(
    label: string,
    cx: number,
    cy: number,
    scale: number,
    colour: readonly [number, number, number],
    glow: readonly [number, number, number],
    scaleY = scale,
    roughness = 0.5,
    metallic?: number,
  ): void {
    const advance = 6 * scale;
    const width = label.length * advance - scale;
    const left = Math.round(cx - width / 2);
    const top = Math.round(cy - (7 * scaleY) / 2);
    for (let character = 0; character < label.length; character += 1) {
      const glyph = GLYPHS[label[character]!];
      if (!glyph) continue;
      for (let row = 0; row < 7; row += 1) {
        for (let column = 0; column < 5; column += 1) {
          if (glyph[row]![column] !== "#") continue;
          for (let sy = 0; sy < scaleY; sy += 1) {
            for (let sx = 0; sx < scale; sx += 1) {
              this.blend(left + character * advance + column * scale + sx, top + row * scaleY + sy, 1, colour, roughness, glow, metallic);
            }
          }
        }
      }
    }
  }
}

function paintSwatches(painter: AtlasPainter): void {
  for (const [index, name] of CAR_FINISHES.entries()) {
    const finish: Finish = FINISHES[name];
    const left = (index % SWATCHES_PER_ROW) * SWATCH_CELL;
    const top = Math.floor(index / SWATCHES_PER_ROW) * SWATCH_CELL;
    for (let y = top; y < top + SWATCH_CELL; y += 1) {
      for (let x = left; x < left + SWATCH_CELL; x += 1) {
        painter.set(x, y, finish.albedo, finish.roughness, finish.metallic ?? 0, finish.emissive ?? NO_GLOW, finish.clearCoat ?? 0);
      }
    }
  }
}

/** Texel column and row of a side-map point. */
function sideTexel(x: number, height: number): readonly [number, number] {
  const [u, v] = sideUv(x, height);
  return [u * ATLAS_WIDTH, v * ATLAS_HEIGHT];
}

/** Texel column and row of a rear-map point. */
function rearTexel(z: number, height: number): readonly [number, number] {
  const [u, v] = rearUv(z, height);
  return [u * ATLAS_WIDTH, v * ATLAS_HEIGHT];
}

/** The road dust a working 76 wears: a pale, dry tan. */
const DUST: readonly [number, number, number] = [150, 134, 110];

/** 0 at `from`, 1 at `to` (either way round), smooth between. */
function smoothstep(from: number, to: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** Smooth value noise in 0..1 over a lattice of unit cells. */
function valueNoise(seed: number, x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const at = (cx: number, cy: number): number => unitFloatFromHash(hashLatticeCoordinates(seed, cx, cy));
  const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
  const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
  return top + (bottom - top) * sy;
}

/**
 * How much road dust a point of the flanks wears, 0 to 1, at body station x
 * and height above the ground: thickest along the sills and lower doors, a
 * halo the tyres throw round each arch (heaviest behind the wheel), the
 * tail's dust drawn in behind a moving wagon, all broken by streaks where it
 * ran down in rain, which vary faster along the body than down it.
 */
function sideGrime(x: number, height: number): number {
  const low = smoothstep(0.98, 0.45, height);
  let thrown = 0;
  for (const centre of [LC76_FRONT_AXLE_X, LC76_REAR_AXLE_X]) {
    const dx = Math.abs(x - centre) / ARCH.halfWidth;
    const dy = Math.abs(height - LC76_TYRE_LOADED_RADIUS) / ARCH.height;
    const r = Math.cbrt(dx ** 3 + dy ** 3);
    thrown = Math.max(thrown, smoothstep(1.75, 1.05, r) * (x < centre ? 1 : 0.5));
  }
  const tail = smoothstep(BODY.rear + 0.3, BODY.rear, x) * smoothstep(1.45, 0.6, height);
  const streaks = valueNoise(0x6d_0517, x / 0.035, height / 0.4) * 0.6 + valueNoise(0x6d_0518, x / 0.3, height / 0.25) * 0.4;
  const amount = Math.max(0.6 * low + 0.45 * thrown, 0.55 * tail);
  return Math.min(1, Math.max(0, amount * (0.45 + 0.75 * streaks)));
}

/** The shut lines' dark hairline: the gap between two panels. */
const SHUT_LINE: readonly [number, number, number] = [62, 60, 56];

/**
 * A texel of paint under `dust` (0 to 1) of road dust, `fall` of the way down
 * the side map's height (0 at its top): a faint gloss gradient leaves the
 * lower body a touch darker, as a white car's flanks read under sky.
 */
function setDustyPaint(painter: AtlasPainter, x: number, y: number, fall: number, dust: number): void {
  const p = FINISHES.paint.albedo;
  const shade = -6 * fall;
  const grain = (unitFloatFromHash(hashLatticeCoordinates(0x7c_0a1, x, y)) - 0.5) * 2;
  const colour = [0, 1, 2].map((k) => Math.round((p[k]! + shade + grain) * (1 - dust) + DUST[k]! * dust)) as [number, number, number];
  // Dust is matte: it dulls the paint and its coat.
  painter.set(x, y, colour, FINISHES.paint.roughness + (0.82 - FINISHES.paint.roughness) * dust, 0, NO_GLOW, 1 - 0.75 * dust);
}

/**
 * How much road dust the tail wears, 0 to 1, at z across it and height above
 * the ground: drawn in over the barn doors by the wake, thickest low down,
 * and run down them in streaks. Toward its corners it becomes the flanks'
 * own at the tail, so the rear map meets the side map round the corners
 * without a seam.
 */
function rearGrime(z: number, height: number): number {
  const low = smoothstep(0.98, 0.45, height);
  const tail = smoothstep(1.45, 0.6, height);
  const streaks = valueNoise(0x6d_0519, z / 0.035, height / 0.4) * 0.6 + valueNoise(0x6d_051a, z / 0.3, height / 0.25) * 0.4;
  const own = Math.min(1, Math.max(0, Math.max(0.6 * low, 0.55 * tail) * (0.45 + 0.75 * streaks)));
  const corner = smoothstep(REAR_SPAN.halfWidth - 0.08, REAR_SPAN.halfWidth, Math.abs(z));
  return own + (sideGrime(BODY.rear, height) - own) * corner;
}

/**
 * The tail: the barn doors' dusty paint, with their shut lines drawn as dark
 * hairlines, each door's outer edge up to the belt and the split between
 * them up to the gutter. Drawn, not modelled: a groove a few millimetres
 * wide is under a pixel from the chase camera and broke into dots whenever
 * the car turned, where a drawn line filters to a fainter, unbroken one.
 */
function paintRear(painter: AtlasPainter): void {
  const columns = REAR_COLUMNS - 2 * REAR_MARGIN - 1;
  const rows = REAR_ROWS - 2 * REAR_MARGIN - 1;
  for (let y = REAR_TOP; y < REAR_TOP + REAR_ROWS; y += 1) {
    // The texel's own height and z, as rearUv addresses them; the margin repeats the edge.
    const v = Math.min(1, Math.max(0, (y - REAR_TOP - REAR_MARGIN) / rows));
    const height = REAR_SPAN.maxHeight - (REAR_SPAN.maxHeight - REAR_SPAN.minHeight) * v;
    const fall = (SIDE_SPAN.maxHeight - height) / (SIDE_SPAN.maxHeight - SIDE_SPAN.minHeight);
    for (let x = REAR_LEFT; x < REAR_LEFT + REAR_COLUMNS; x += 1) {
      const u = Math.min(1, Math.max(0, (x - REAR_LEFT - REAR_MARGIN) / columns));
      const z = REAR_SPAN.halfWidth * (2 * u - 1);
      setDustyPaint(painter, x, y, fall, rearGrime(z, height) * 0.8);
    }
  }
  const vertical = (z: number, bottom: number, top: number): void => {
    const [x0, y0] = rearTexel(z, bottom);
    const [x1, y1] = rearTexel(z, top);
    painter.line(x0, y0, x1, y1, 2, SHUT_LINE, NO_GLOW, 0.7);
  };
  for (const side of [-1, 1]) vertical(side * SHELL_SPLIT_Z, BODY.rearBottom, BODY.belt);
  vertical(REAR_DOOR_SPLIT_Z, BODY.rearBottom + 0.02, GLASSHOUSE.head);
}

/**
 * The body's sides: paint under a film of road dust, with the door shut
 * lines as dark hairlines, the door handles, the fuel flap behind the rear
 * door, and the satin-black B and C pillar trims a GXL wears between its
 * windows. Both sides wear the one map (the left mirrors the right), so
 * nothing here may read as text.
 */
function paintSides(painter: AtlasPainter): void {
  const width = 1.6;
  for (let y = SIDE_TOP; y < SIDE_TOP + SIDE_ROWS; y += 1) {
    const t = (y - SIDE_TOP) / SIDE_ROWS;
    // The texel's own station and height, as sideUv addresses it.
    const height = SIDE_SPAN.maxHeight - (SIDE_SPAN.maxHeight - SIDE_SPAN.minHeight) * ((y - SIDE_TOP) / (SIDE_ROWS - 1));
    for (let x = 0; x < ATLAS_WIDTH; x += 1) {
      const station = SIDE_SPAN.minX + (SIDE_SPAN.maxX - SIDE_SPAN.minX) * (x / (ATLAS_WIDTH - 1));
      setDustyPaint(painter, x, y, t, sideGrime(station, height) * 0.8);
    }
  }
  const vertical = (x: number, bottom: number, top: number): void => {
    const [x0, y0] = sideTexel(x, bottom);
    const [x1, y1] = sideTexel(x, top);
    painter.line(x0, y0, x1, y1, width, SHUT_LINE, NO_GLOW, 0.7);
  };
  const horizontal = (fromX: number, toX: number, height: number): void => {
    const [x0, y0] = sideTexel(fromX, height);
    const [x1, y1] = sideTexel(toX, height);
    painter.line(x0, y0, x1, y1, width, SHUT_LINE, NO_GLOW, 0.7);
  };
  // Front door: leading edge under the mirror, trailing edge at the B pillar, its bottom over the sill.
  vertical(DOOR_LINES.frontDoorFront, BODY.sill + 0.03, SIDE_WINDOW_BOTTOM - 0.01);
  vertical(DOOR_LINES.frontDoorRear, BODY.sill + 0.03, GLASSHOUSE.head - 0.035);
  vertical(DOOR_LINES.rearDoorRear, BODY.sill + 0.12, GLASSHOUSE.head - 0.035);
  horizontal(DOOR_LINES.frontDoorFront, DOOR_LINES.rearDoorRear, BODY.sill + 0.03);
  // The doors' window frames: a shut line round the top of each door's glass.
  horizontal(DOOR_LINES.frontDoorFront - 0.1, DOOR_LINES.rearDoorRear, GLASSHOUSE.head - 0.035);
  // A stamped swage line along the flanks, under the belt.
  const [sx0, sy0] = sideTexel(BODY.bumperRear + 0.1, BODY.belt - 0.13);
  const [sx1, sy1] = sideTexel(BODY.front - 0.05, BODY.belt - 0.13);
  painter.line(sx0, sy0, sx1, sy1, 2.2, [206, 203, 192], NO_GLOW, 0.35);
  // B and C pillars: satin black between the door glass.
  for (const [front, rear] of [[-0.33, -0.42], [-1.27, -1.36]] as const) {
    const [x0, y0] = sideTexel(front, GLASSHOUSE.head - 0.05);
    const [x1, y1] = sideTexel(rear, SIDE_WINDOW_BOTTOM);
    painter.roundedRect(x0, y0, x1, y1, 1.5, FINISHES.seal.albedo, 0.6);
  }
  // Door handles: a black pull just under the belt at each door's trailing edge.
  for (const x of [DOOR_LINES.frontDoorRear + 0.2, DOOR_LINES.rearDoorRear + 0.2]) {
    const [x0, y0] = sideTexel(x + 0.07, BODY.belt - 0.045);
    const [x1, y1] = sideTexel(x - 0.07, BODY.belt - 0.085);
    painter.roundedRect(Math.min(x0, x1), y0, Math.max(x0, x1), y1, 2, FINISHES.blackPlastic.albedo, 0.5);
  }
  // The fuel flap over the rear wheel's leading edge.
  {
    const [x0, y0] = sideTexel(-1.6, BODY.belt - 0.09);
    const [x1, y1] = sideTexel(-1.78, BODY.belt - 0.25);
    painter.line(x1, y0, x0, y0, 1.4, SHUT_LINE, NO_GLOW, 0.7);
    painter.line(x1, y1, x0, y1, 1.4, SHUT_LINE, NO_GLOW, 0.7);
    painter.line(x0, y0, x0, y1, 1.4, SHUT_LINE, NO_GLOW, 0.7);
    painter.line(x1, y0, x1, y1, 1.4, SHUT_LINE, NO_GLOW, 0.7);
  }
}

/**
 * The grille's black mesh, behind the TOYOTA letters (which are geometry):
 * a diamond lattice of satin strands over the dark radiator, drawn in the
 * insert's own metres so its diamonds are square on the car.
 */
function paintGrille(painter: AtlasPainter, width: number, height: number): void {
  const pitchAcross = 0.022;
  const pitchUp = 0.013;
  const strand = 0.2;
  for (let y = GRILLE_TOP; y < GRILLE_TOP + GRILLE_ROWS; y += 1) {
    const up = ((y - GRILLE_TOP + 0.5) / GRILLE_ROWS) * height;
    for (let x = 0; x < ATLAS_WIDTH; x += 1) {
      const across = ((x + 0.5) / ATLAS_WIDTH) * width;
      const p = across / pitchAcross + up / pitchUp;
      const q = across / pitchAcross - up / pitchUp;
      const distance = Math.min(Math.abs(p - Math.round(p)), Math.abs(q - Math.round(q)));
      // Coverage of the strand across the texel, so the lattice is anti-aliased at level 0.
      const coverage = Math.min(1, Math.max(0, (strand / 2 - distance) * 6 + 0.5));
      const shade = 4 + coverage * 34;
      painter.set(x, y, [shade, shade, shade + 2], 0.85 - coverage * 0.35, coverage * 0.15, NO_GLOW);
    }
  }
}

/** A round dial: chrome bezel, black face, ticks and numerals on `sweep`, lit at night. */
function paintRoundDial(
  painter: AtlasPainter,
  dial: CarDial,
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
  for (let y = DIAL_TOP; y < DIAL_TOP + DIAL_CELL; y += 1) {
    for (let x = index * DIAL_CELL; x < (index + 1) * DIAL_CELL; x += 1) {
      const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / half;
      if (r > 0.9) painter.set(x, y, FINISHES.chrome.albedo, FINISHES.chrome.roughness, 1, NO_GLOW);
      else painter.set(x, y, [10, 10, 12], 0.3, 0, NO_GLOW);
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
      if (label.length === 0) continue;
      const at = radius * 0.6;
      painter.text(label, cx + sin * at, cy - cos * at, label.length > 2 ? 1 : 2, MARKING, MARKING_GLOW);
    }
  }
  painter.text(legend, cx, cy + half * 0.45, 1, MARKING, MARKING_GLOW);
}

/** The atlas's three maps at level 0, deterministic. */
export function synthesizeCarAtlas(): CarAtlasPixels {
  const painter = new AtlasPainter();
  paintSwatches(painter);
  paintSides(painter);
  paintRear(painter);
  paintGrille(painter, 2 * GRILLE_INSERT.halfWidth, GRILLE_INSERT.top - GRILLE_INSERT.bottom);
  paintRoundDial(painter, "tachometer", DIAL_SWEEP.tachometer, ["0", "1", "2", "3", "4", "5"], 5, 4, "RPMx1000");
  paintRoundDial(painter, "speedometer", DIAL_SWEEP.speedometer, ["0", "20", "40", "60", "80", "100", "120", "140", "160", "180"], 2, null, "KM/H");
  paintRoundDial(painter, "fuel", DIAL_SWEEP.fuel, ["E", "", "F"], 2, null, "");
  paintRoundDial(painter, "temperature", DIAL_SWEEP.temperature, ["C", "", "H"], 2, null, "");
  return { albedo: painter.albedo, metallicRoughness: painter.metallicRoughness, emissive: painter.emissive };
}

/** A box-filtered mip chain of a `width` x `height` RGBA level 0, both powers of two. */
export function buildRectMipChain(rgba: Uint8Array, width: number, height: number, levels: number): Uint8Array[] {
  const chain: Uint8Array[] = [rgba];
  let w = width;
  let hgt = height;
  let source = rgba;
  for (let level = 1; level < levels && (w > 1 || hgt > 1); level += 1) {
    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, hgt >> 1);
    const next = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y += 1) {
      for (let x = 0; x < nw; x += 1) {
        for (let channel = 0; channel < 4; channel += 1) {
          let sum = 0;
          for (let dy = 0; dy < 2; dy += 1) {
            for (let dx = 0; dx < 2; dx += 1) {
              const sx = Math.min(w - 1, x * 2 + dx);
              const sy = Math.min(hgt - 1, y * 2 + dy);
              sum += source[(sy * w + sx) * 4 + channel]!;
            }
          }
          next[(y * nw + x) * 4 + channel] = Math.round(sum / 4);
        }
      }
    }
    chain.push(next);
    source = next;
    w = nw;
    hgt = nh;
  }
  return chain;
}

export interface CarAtlasTextures {
  readonly albedo: RawTexture;
  readonly metallicRoughness: RawTexture;
  readonly emissive: RawTexture;
}

function upload(scene: Scene, name: string, pixels: Uint8Array, srgb: boolean): RawTexture {
  const levels = buildRectMipChain(pixels, ATLAS_WIDTH, ATLAS_HEIGHT, ATLAS_MIP_LEVELS);
  const texture = createRawTextureFromMipChain(scene, levels, ATLAS_WIDTH, ATLAS_HEIGHT, { useSrgbBuffer: srgb });
  texture.name = name;
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 8;
  return texture;
}

export function createCarAtlasTextures(scene: Scene, pixels: CarAtlasPixels = synthesizeCarAtlas()): CarAtlasTextures {
  return {
    albedo: upload(scene, "landcruiser-atlas-albedo", pixels.albedo, true),
    metallicRoughness: upload(scene, "landcruiser-atlas-metallic-roughness", pixels.metallicRoughness, false),
    emissive: upload(scene, "landcruiser-atlas-emissive", pixels.emissive, true),
  };
}
