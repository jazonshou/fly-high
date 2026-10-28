import type { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import { createRawTextureFromMipChain } from "@/src/render/webgpu/core/MipChainUpload";
import { hashLatticeCoordinates, unitFloatFromHash } from "@/src/world/seed";
import { A_PILLAR_WIDTH, BODY, DOOR_LINES, GLASSHOUSE, SIDE_WINDOW_BOTTOM } from "./lc76Lines";

/**
 * The LandCruiser 76's ONE texture atlas: every opaque part of the car wears
 * one PBR material and picks its finish by UV, as the boat's do, so the car
 * costs a draw per moving part rather than a draw per colour.
 *
 * Three maps share one layout, `ATLAS_WIDTH` x `ATLAS_HEIGHT`:
 *  - albedo (sRGB),
 *  - metallic-roughness (R ambient 1, G roughness, B metallic),
 *  - emissive: black but for the gauges' backlit markings, so the dash
 *    glow is one intensity on the cockpit's material.
 *
 * LAYOUT, in texels from the top-left (v grows down the buffer):
 *  - rows 0-63: `SWATCH_CELL` square swatches of one finish each, read at
 *    their centres so a part is one colour at every distance.
 *  - rows 64-319: the body's sides, mapped flat along x and up the height
 *    (`sideUv`): paint, with the doors' shut lines, the handles, the fuel
 *    flap and the pillars' black-outs drawn in.
 *  - rows 320-383: the grille, across its width (`grilleUv`): black slats and
 *    the TOYOTA letters.
 *  - rows 384-511, left half: the four dial faces, `DIAL_CELL` square.
 *  - rows 384-447, right half: the all-terrain tread, round the tyre along u
 *    and across it along v (`treadUv`).
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
const TREAD_LEFT = 512;
const TREAD_TOP = 384;
const TREAD_ROWS = 64;

/** The side map's extent: the whole body's length, from the sills to the roof. */
export const SIDE_SPAN = Object.freeze({
  minX: BODY.bumperRear - 0.02,
  maxX: BODY.bumperFront + 0.02,
  minHeight: 0.38,
  maxHeight: 1.97,
});

/** Tread blocks round the tyre, and how many repeats of the map that is. */
export const TREAD_REPEATS = 6;

interface Finish {
  /** sRGB 0-255. */
  readonly albedo: readonly [number, number, number];
  readonly roughness: number;
  readonly metallic?: number;
  readonly emissive?: readonly [number, number, number];
}

/**
 * Every finish on the car. Toyota's French Vanilla is a warm white, glossy
 * as fresh paint is; the bumpers are painted steel, the flares and mirrors
 * moulded black plastic, the cabin grey vinyl and cloth.
 */
const FINISHES = {
  paint: { albedo: [236, 233, 222], roughness: 0.3 },
  blackPlastic: { albedo: [30, 31, 32], roughness: 0.72 },
  seal: { albedo: [12, 12, 13], roughness: 0.55 },
  bumper: { albedo: [104, 106, 108], roughness: 0.46, metallic: 0.35 },
  chrome: { albedo: [214, 216, 220], roughness: 0.12, metallic: 1 },
  chassis: { albedo: [20, 20, 21], roughness: 0.78 },
  underbody: { albedo: [38, 37, 35], roughness: 0.9 },
  rubber: { albedo: [24, 24, 24], roughness: 0.9 },
  sidewall: { albedo: [30, 30, 31], roughness: 0.82 },
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

/** UV on the tread: `around` 0..1 of one repeat round the tyre, `across` 0..1 shoulder to shoulder. */
export function treadUv(around: number, across: number): readonly [number, number] {
  const a = Math.min(1, Math.max(0, around));
  const c = Math.min(1, Math.max(0, across));
  const width = ATLAS_WIDTH - TREAD_LEFT;
  return [(TREAD_LEFT + 0.5 + a * (width - 1)) / ATLAS_WIDTH, (TREAD_TOP + 0.5 + c * (TREAD_ROWS - 1)) / ATLAS_HEIGHT];
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
      this.set(index % ATLAS_WIDTH, Math.floor(index / ATLAS_WIDTH), FINISHES.paint.albedo, FINISHES.paint.roughness, 0, NO_GLOW);
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
    if (x < 0 || y < 0 || x >= ATLAS_WIDTH || y >= ATLAS_HEIGHT) return;
    const at = (y * ATLAS_WIDTH + x) * 4;
    this.albedo[at] = albedo[0];
    this.albedo[at + 1] = albedo[1];
    this.albedo[at + 2] = albedo[2];
    this.albedo[at + 3] = 255;
    this.metallicRoughness[at] = 255;
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
        painter.set(x, y, finish.albedo, finish.roughness, finish.metallic ?? 0, finish.emissive ?? NO_GLOW);
      }
    }
  }
}

/** Texel column and row of a side-map point. */
function sideTexel(x: number, height: number): readonly [number, number] {
  const [u, v] = sideUv(x, height);
  return [u * ATLAS_WIDTH, v * ATLAS_HEIGHT];
}

/**
 * The body's sides: paint, with the door shut lines as dark hairlines, the
 * door handles, the fuel flap behind the rear door, and the satin-black
 * B and C pillar trims a GXL wears between its windows. Both sides wear the
 * one map (the left mirrors the right), so nothing here may read as text.
 */
function paintSides(painter: AtlasPainter): void {
  const gap: readonly [number, number, number] = [62, 60, 56];
  const width = 1.6;
  // A faint gloss gradient: the lower body a touch darker, as a white car's flanks read under sky.
  for (let y = SIDE_TOP; y < SIDE_TOP + SIDE_ROWS; y += 1) {
    const t = (y - SIDE_TOP) / SIDE_ROWS;
    const shade = Math.round(-6 * t);
    for (let x = 0; x < ATLAS_WIDTH; x += 1) {
      const grain = (unitFloatFromHash(hashLatticeCoordinates(0x7c_0a1, x, y)) - 0.5) * 2;
      const p = FINISHES.paint.albedo;
      painter.set(x, y, [p[0] + shade + grain, p[1] + shade + grain, p[2] + shade + grain], FINISHES.paint.roughness, 0, NO_GLOW);
    }
  }
  const vertical = (x: number, bottom: number, top: number): void => {
    const [x0, y0] = sideTexel(x, bottom);
    const [x1, y1] = sideTexel(x, top);
    painter.line(x0, y0, x1, y1, width, gap, NO_GLOW, 0.7);
  };
  const horizontal = (fromX: number, toX: number, height: number): void => {
    const [x0, y0] = sideTexel(fromX, height);
    const [x1, y1] = sideTexel(toX, height);
    painter.line(x0, y0, x1, y1, width, gap, NO_GLOW, 0.7);
  };
  const slanted = (fromX: number, fromHeight: number, toX: number, toHeight: number): void => {
    const [x0, y0] = sideTexel(fromX, fromHeight);
    const [x1, y1] = sideTexel(toX, toHeight);
    painter.line(x0, y0, x1, y1, width, gap, NO_GLOW, 0.7);
  };
  // Front door: its leading edge raked from behind the flare to the A pillar's
  // foot, then up the pillar; its trailing edge at the B pillar; its bottom
  // over the sill. Where the drawn door is cut (carBody.ts).
  const pillarAtTop = GLASSHOUSE.screenFootX
    + ((GLASSHOUSE.screenHeadX - GLASSHOUSE.screenFootX) * (DOOR_LINES.doorTop - BODY.belt)) / (GLASSHOUSE.head - BODY.belt)
    - A_PILLAR_WIDTH;
  slanted(DOOR_LINES.frontDoorFoot, DOOR_LINES.frontDoorBottom, DOOR_LINES.frontDoorBelt, BODY.belt);
  slanted(DOOR_LINES.frontDoorBelt, BODY.belt, pillarAtTop, DOOR_LINES.doorTop);
  vertical(DOOR_LINES.frontDoorRear, DOOR_LINES.frontDoorBottom, DOOR_LINES.doorTop);
  vertical(DOOR_LINES.rearDoorRear, BODY.sill + 0.12, DOOR_LINES.doorTop);
  horizontal(DOOR_LINES.frontDoorFoot, DOOR_LINES.rearDoorRear, DOOR_LINES.frontDoorBottom);
  // The doors' window frames: a shut line round the top of each door's glass.
  horizontal(pillarAtTop, DOOR_LINES.rearDoorRear, DOOR_LINES.doorTop);
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
    painter.line(x1, y0, x0, y0, 1.4, gap, NO_GLOW, 0.7);
    painter.line(x1, y1, x0, y1, 1.4, gap, NO_GLOW, 0.7);
    painter.line(x0, y0, x0, y1, 1.4, gap, NO_GLOW, 0.7);
    painter.line(x1, y0, x1, y1, 1.4, gap, NO_GLOW, 0.7);
  }
}

/** The grille: black, five horizontal slats, the TOYOTA letters across the middle one. */
function paintGrille(painter: AtlasPainter): void {
  for (let y = GRILLE_TOP; y < GRILLE_TOP + GRILLE_ROWS; y += 1) {
    const t = (y - GRILLE_TOP) / GRILLE_ROWS;
    // Slats: lighter bars over the dark mesh behind, five across the height.
    const slat = Math.abs(((t * 5) % 1) - 0.5) < 0.28;
    for (let x = 0; x < ATLAS_WIDTH; x += 1) {
      const edge = Math.min(x, ATLAS_WIDTH - 1 - x, y - GRILLE_TOP, GRILLE_TOP + GRILLE_ROWS - 1 - y);
      if (edge < 3) painter.set(x, y, FINISHES.blackPlastic.albedo, 0.6, 0, NO_GLOW);
      else if (slat) painter.set(x, y, [36, 37, 39], 0.42, 0.1, NO_GLOW);
      else painter.set(x, y, [6, 6, 7], 0.85, 0, NO_GLOW);
    }
  }
  // The grille is about 1.05 m by 0.27 m and the map 1024 x 64: letters are drawn
  // four times as wide per texel row, so they read upright on the car.
  painter.text("TOYOTA", ATLAS_WIDTH / 2, GRILLE_TOP + GRILLE_ROWS / 2, 13, FINISHES.badge.albedo, NO_GLOW, 3, 0.2, 1);
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

/**
 * An all-terrain tread, one repeat of `TREAD_REPEATS` round the tyre: a
 * staggered pair of block rows down the middle, chunky shoulder blocks and
 * the dark grooves and sipes between them.
 */
function paintTread(painter: AtlasPainter): void {
  const width = ATLAS_WIDTH - TREAD_LEFT;
  const blocksPerRepeat = 8;
  for (let y = TREAD_TOP; y < TREAD_TOP + TREAD_ROWS; y += 1) {
    const across = (y - TREAD_TOP + 0.5) / TREAD_ROWS;
    for (let x = TREAD_LEFT; x < ATLAS_WIDTH; x += 1) {
      const around = ((x - TREAD_LEFT + 0.5) / width) * blocksPerRepeat;
      const phase = around % 1;
      const column = Math.floor(around);
      // Three lanes: shoulders and two staggered centre rows, split by grooves.
      let groove = false;
      if (Math.abs(across - 0.5) < 0.03 && phase <= 0.5) groove = true;
      if (Math.abs(across - 0.28) < 0.025 || Math.abs(across - 0.72) < 0.025) groove = true;
      const lane = across < 0.28 ? 0 : across < 0.5 ? 1 : across < 0.72 ? 2 : 3;
      const offset = lane === 1 || lane === 3 ? 0.5 : 0;
      const local = (phase + offset) % 1;
      if (local < 0.16) groove = true;
      // A sipe across each block.
      if (Math.abs(local - 0.58) < 0.025 && (lane === 1 || lane === 2)) groove = true;
      const wear = unitFloatFromHash(hashLatticeCoordinates(0x7ead, x, y)) * 6;
      if (groove) painter.set(x, y, [9 + column % 2, 9, 9], 0.95, 0, NO_GLOW);
      else painter.set(x, y, [30 + wear, 30 + wear, 30 + wear], 0.86, 0, NO_GLOW);
    }
  }
}

/** The atlas's three maps at level 0, deterministic. */
export function synthesizeCarAtlas(): CarAtlasPixels {
  const painter = new AtlasPainter();
  paintSwatches(painter);
  paintSides(painter);
  paintGrille(painter);
  paintRoundDial(painter, "tachometer", DIAL_SWEEP.tachometer, ["0", "1", "2", "3", "4", "5"], 5, 4, "RPMx1000");
  paintRoundDial(painter, "speedometer", DIAL_SWEEP.speedometer, ["0", "20", "40", "60", "80", "100", "120", "140", "160", "180"], 2, null, "KM/H");
  paintRoundDial(painter, "fuel", DIAL_SWEEP.fuel, ["E", "", "F"], 2, null, "");
  paintRoundDial(painter, "temperature", DIAL_SWEEP.temperature, ["C", "", "H"], 2, null, "");
  paintTread(painter);
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
