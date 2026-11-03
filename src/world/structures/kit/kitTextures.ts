import { STRUCTURE_SURFACES, type StructureSurface } from "../structureModel";

/**
 * The building kit's materials (structures phase S3): one RGBA layer per
 * drawn pattern, synthesised on the CPU from periodic noise like the
 * terrain's materials, at 256² (Medium) or 512² (High and Ultra). Low draws
 * the part colours alone, so every layer is DETAIL around the part's colour,
 * never a colour of its own: the painted texels of every layer average
 * exactly mid-grey, and a building reads the same at range on every tier.
 *
 * Pure and Babylon-free (a worker can run it); the renderer reduces the mip
 * chains (`planMippedTextureArray`: "box" for `detail`, "toksvig" for
 * `normal`) and uploads.
 *
 * Two arrays of `STRUCTURE_TEXTURE_LAYERS.length` layers, linear UNORM (not
 * sRGB), row 0 at v = 0:
 *
 * - `detail`: RGB the detail, around 0.5. Where A is 1 the albedo is the
 *   part's colour times RGB x 2; where A is 0 RGB is the texel's own albedo
 *   (a window's sash, the mortar between stones, the chinking between
 *   logs): `albedo = mix(rgb, colour * rgb * 2, a)`. On `window`, A is also
 *   the glass: the mask its night glow lights.
 * - `normal`: RG the tangent-space normal's x and y (`n * 0.5 + 0.5`) in the
 *   face's own (u, v) frame as `kitMesh.ts` lays its UVs (v up the face's
 *   most vertical direction, u = v x n), B roughness, A cavity AO.
 *
 * A surface samples its layer at `uv / tileMetres` (UV is metres along the
 * face), and `window` and `doorway` at their 0 to 1 UV; `strength` scales
 * the detail and the normal towards flat (`STRUCTURE_SURFACE_TEXTURES`).
 */

export const STRUCTURE_TEXTURE_LAYERS = Object.freeze([
  "clapboard",
  "boards",
  "logs",
  "render",
  "stone",
  "metal",
  "shingle",
  "tile",
  "planks",
  "timber",
  "paint",
  "window",
  "doorway",
] as const);

export type StructureTextureLayer = (typeof STRUCTURE_TEXTURE_LAYERS)[number];

/** The edges a tier may ask for: Medium 256, High and Ultra 512 (Low has no material array). */
export const STRUCTURE_TEXTURE_EDGES = Object.freeze([256, 512] as const);
export type StructureTextureEdge = (typeof STRUCTURE_TEXTURE_EDGES)[number];

export interface StructureSurfaceTexture {
  /** Index into `STRUCTURE_TEXTURE_LAYERS`. */
  readonly layer: number;
  /** Metres of face one layer covers; 0 for a fitted surface (its UV runs 0 to 1 over the face). */
  readonly tileMetres: number;
  /** 1 the layer as synthesised, 0 flat: the part's colour alone. */
  readonly strength: number;
}

const LAYER = Object.fromEntries(STRUCTURE_TEXTURE_LAYERS.map((name, i) => [name, i])) as Record<StructureTextureLayer, number>;

/** How each surface paints: its layer, the layer's size on the face and how strongly it shows. */
export const STRUCTURE_SURFACE_TEXTURES: Readonly<Record<StructureSurface, StructureSurfaceTexture>> = Object.freeze({
  clapboard: { layer: LAYER.clapboard, tileMetres: 2.4, strength: 1 },
  boards: { layer: LAYER.boards, tileMetres: 2.4, strength: 1 },
  logs: { layer: LAYER.logs, tileMetres: 2.4, strength: 1 },
  render: { layer: LAYER.render, tileMetres: 3.0, strength: 1 },
  stone: { layer: LAYER.stone, tileMetres: 2.4, strength: 1 },
  basalt: { layer: LAYER.stone, tileMetres: 1.8, strength: 0.85 },
  metal: { layer: LAYER.metal, tileMetres: 2.4, strength: 1 },
  shingle: { layer: LAYER.shingle, tileMetres: 2.4, strength: 1 },
  tile: { layer: LAYER.tile, tileMetres: 2.4, strength: 1 },
  slate: { layer: LAYER.shingle, tileMetres: 3.6, strength: 0.8 },
  timber: { layer: LAYER.timber, tileMetres: 1.2, strength: 1 },
  trim: { layer: LAYER.paint, tileMetres: 1.2, strength: 1 },
  plaster: { layer: LAYER.render, tileMetres: 1.5, strength: 0.35 },
  floor: { layer: LAYER.planks, tileMetres: 2.4, strength: 1 },
  concrete: { layer: LAYER.render, tileMetres: 2.0, strength: 0.8 },
  steel: { layer: LAYER.paint, tileMetres: 1.2, strength: 1 },
  window: { layer: LAYER.window, tileMetres: 0, strength: 1 },
  doorway: { layer: LAYER.doorway, tileMetres: 0, strength: 1 },
  fabric: { layer: LAYER.render, tileMetres: 0.6, strength: 0.5 },
  glass: { layer: LAYER.paint, tileMetres: 1.2, strength: 0 },
});

/**
 * The same table by surface id (`structureSurfaceId`), four floats a
 * surface for a uniform buffer: layer, 1 / tileMetres (0 when fitted),
 * strength, 1 when fitted.
 */
export function structureSurfaceTextureTable(): Float32Array {
  const out = new Float32Array(STRUCTURE_SURFACES.length * 4);
  STRUCTURE_SURFACES.forEach((surface, id) => {
    const t = STRUCTURE_SURFACE_TEXTURES[surface];
    out[id * 4] = t.layer;
    out[id * 4 + 1] = t.tileMetres > 0 ? 1 / t.tileMetres : 0;
    out[id * 4 + 2] = t.strength;
    out[id * 4 + 3] = t.tileMetres > 0 ? 0 : 1;
  });
  return out;
}

export interface StructureTextureSet {
  readonly edge: StructureTextureEdge;
  /** Per layer, edge² RGBA: detail around mid-grey, A the paint mask. */
  readonly detail: readonly Uint8Array[];
  /** Per layer, edge² RGBA: normal xy, roughness, cavity AO. */
  readonly normal: readonly Uint8Array[];
}

// --- Periodic noise --------------------------------------------------------------------------

const SEED = 0x51c3_a7e5;

function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 0x27d4_eb2d) ^ Math.imul(y, 0x1656_67b1) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return ((h ^ (h >>> 14)) >>> 0) / 4_294_967_296;
}

function hash1(i: number, seed: number): number {
  return hash2(i, 0x3c6e_f372, seed);
}

/** Value noise on an fu x fv lattice that wraps: exactly periodic on the unit square. */
class Lattice {
  private readonly values: Float32Array;

  constructor(private readonly fu: number, private readonly fv: number, seed: number) {
    this.values = new Float32Array(fu * fv);
    for (let j = 0; j < fv; j += 1) {
      for (let i = 0; i < fu; i += 1) this.values[j * fu + i] = hash2(i, j, seed);
    }
  }

  /** Smooth noise in [0, 1) at (u, v), any real u and v. */
  at(u: number, v: number): number {
    const x = u * this.fu;
    const y = v * this.fv;
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    let tx = x - xf;
    let ty = y - yf;
    tx = tx * tx * (3 - 2 * tx);
    ty = ty * ty * (3 - 2 * ty);
    let x0 = xf;
    if (x0 < 0 || x0 >= this.fu) {
      x0 %= this.fu;
      if (x0 < 0) x0 += this.fu;
    }
    let y0 = yf;
    if (y0 < 0 || y0 >= this.fv) {
      y0 %= this.fv;
      if (y0 < 0) y0 += this.fv;
    }
    const x1 = x0 + 1 === this.fu ? 0 : x0 + 1;
    const y1 = y0 + 1 === this.fv ? 0 : y0 + 1;
    const r0 = y0 * this.fu;
    const r1 = y1 * this.fu;
    const a = this.values[r0 + x0]!;
    const b = this.values[r0 + x1]!;
    const c = this.values[r1 + x0]!;
    const d = this.values[r1 + x1]!;
    const top = a + (b - a) * tx;
    const bottom = c + (d - c) * tx;
    return top + (bottom - top) * ty;
  }
}

/** Fractal sum of periodic lattices, octaves doubling both frequencies; in [0, 1). */
class Fbm {
  private readonly octaves: Lattice[] = [];
  private readonly norm: number;

  constructor(fu: number, fv: number, octaves: number, seed: number) {
    let total = 0;
    for (let o = 0; o < octaves; o += 1) {
      this.octaves.push(new Lattice(fu << o, fv << o, seed + o * 0x9e37));
      total += 0.5 ** o;
    }
    this.norm = 1 / total;
  }

  at(u: number, v: number): number {
    let sum = 0;
    let amp = 1;
    for (const lattice of this.octaves) {
      sum += lattice.at(u, v) * amp;
      amp *= 0.5;
    }
    return sum * this.norm;
  }
}

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const frac = (x: number): number => x - Math.floor(x);

/**
 * Cuts a periodic row into pieces of `min..max` (fractions of the row),
 * scaled to sum to exactly 1, starting at a seeded offset. Returns the
 * ascending cut positions in [0, 1) (each piece runs from a cut to the next,
 * the last wrapping to the first plus 1).
 */
function cutRow(min: number, max: number, seed: number): number[] {
  const widths: number[] = [];
  let sum = 0;
  for (let i = 0; sum < 1 - min * 0.5; i += 1) {
    const w = min + (max - min) * hash1(i, seed);
    widths.push(w);
    sum += w;
  }
  const offset = hash1(999, seed);
  const cuts: number[] = [];
  let at = 0;
  for (const w of widths) {
    cuts.push(frac(offset + at));
    at += w / sum;
  }
  return cuts.sort((p, q) => p - q);
}

/** The piece of a cut row a position falls in: its index, and the distances to its two cuts (row units). */
function pieceOf(cuts: readonly number[], x: number): { index: number; before: number; after: number } {
  const n = cuts.length;
  let i = n - 1;
  for (let k = 0; k < n; k += 1) {
    if (cuts[k]! > x) {
      i = k - 1;
      break;
    }
  }
  if (i < 0) {
    // Before the first cut: the last piece, wrapped.
    return { index: n - 1, before: x + 1 - cuts[n - 1]!, after: cuts[0]! - x };
  }
  const next = i + 1 < n ? cuts[i + 1]! : cuts[0]! + 1;
  return { index: i, before: x - cuts[i]!, after: next - x };
}

// --- One layer's canvas ----------------------------------------------------------------------

/** What a layer's recipe writes for one texel. */
interface Texel {
  /** Detail (painted, around 1) or the texel's own linear albedo (unpainted). */
  r: number;
  g: number;
  b: number;
  /** 1 the part's colour shows, 0 the texel's own. */
  paint: number;
  /** Relief, metres. */
  height: number;
  roughness: number;
  /** Ambient occlusion the recipe knows of (the cavity term is added from the relief). */
  ao: number;
}

interface Recipe {
  /** The layer's size on the face it was drawn for, metres (bump slopes follow it). */
  readonly metres: number;
  /** Cavity AO gain per metre of relief below the local mean. */
  readonly cavity: number;
  /** Fills `t` for (u, v) in [0, 1)², v up. */
  texel(u: number, v: number, t: Texel): void;
}

const WOOD_ROUGH = 0.72;

function clapboard(): Recipe {
  const courses = 12;
  const grain = new Lattice(6, 160, SEED + 11);
  const weather = new Fbm(3, 3, 4, SEED + 12);
  const fine = new Lattice(96, 96, SEED + 13);
  return {
    metres: 2.4,
    cavity: 18,
    texel(u, v, t) {
      const y = v * courses;
      const c = Math.floor(y);
      const f = y - c;
      // Each board's butt stands 14 mm proud of its top, which tucks under the board above (rounded 3 mm).
      const lap = 0.014 * (1 - f) * smoothstep(0, 0.015, f);
      // One butt joint a course, staggered.
      const joint = Math.abs(frac(u - hash1(c, SEED + 14) + 0.5) - 0.5) * 2.4;
      const inJoint = 1 - smoothstep(0.001, 0.004, joint);
      const tone = 1 + 0.035 * (hash1(c * 7 + (u > hash1(c, SEED + 14) ? 1 : 0), SEED + 15) - 0.5);
      const under = 1 - 0.12 * smoothstep(0.86, 1, f);
      const w = weather.at(u, v);
      const d = tone * under * (1 + 0.05 * (grain.at(u, v) - 0.5)) * (1 + 0.1 * (w - 0.5)) * (1 + 0.03 * (fine.at(u, v) - 0.5)) * (1 - 0.35 * inJoint);
      t.r = d;
      t.g = d;
      t.b = d;
      t.paint = 1;
      t.height = lap - 0.002 * inJoint;
      t.roughness = 0.62 + 0.12 * (0.5 - w);
      t.ao = 1 - 0.3 * smoothstep(0.82, 1, f);
    },
  };
}

function boards(): Recipe {
  const count = 8;
  const width = 2.4 / count;
  const grain = new Lattice(192, 5, SEED + 21);
  const streak = new Fbm(48, 3, 2, SEED + 22);
  const weather = new Fbm(3, 3, 4, SEED + 23);
  return {
    metres: 2.4,
    cavity: 16,
    texel(u, v, t) {
      const x = u * count;
      const i = Math.floor(x);
      const f = x - i;
      const fromJoint = Math.min(f, 1 - f) * width;
      // A 60 mm batten over every joint, 20 mm proud, its edges eased.
      const batten = 1 - smoothstep(0.026, 0.032, fromJoint);
      const near = Math.round(x) % count;
      const board = (hash1(i, SEED + 24) - 0.5) * 0.08;
      const battenTone = (hash1(near + 31, SEED + 24) - 0.5) * 0.06;
      const tone = 1 + board * (1 - batten) + battenTone * batten;
      const st = streak.at(u, v);
      const d = tone * (1 + 0.06 * (grain.at(u, v) - 0.5)) * (1 + 0.1 * (st - 0.5)) * (1 + 0.08 * (weather.at(u, v) - 0.5));
      t.r = d;
      t.g = d;
      t.b = d;
      t.paint = 1;
      t.height = 0.02 * batten + 0.002 * (1 - (2 * f - 1) ** 2) * (1 - batten);
      t.roughness = WOOD_ROUGH + 0.1 * (0.5 - st);
      t.ao = 1 - 0.18 * (1 - batten) * (1 - smoothstep(0.03, 0.06, fromJoint));
    },
  };
}

const CHINKING = [0.5, 0.47, 0.4] as const;

function logs(): Recipe {
  const courses = 8;
  const grain = new Lattice(8, 256, SEED + 31);
  const weather = new Fbm(3, 3, 4, SEED + 32);
  const fine = new Lattice(128, 64, SEED + 33);
  return {
    metres: 2.4,
    cavity: 4,
    texel(u, v, t) {
      const y = v * courses;
      const c = Math.floor(y);
      const f = y - c;
      const across = (f - 0.5) / 0.44;
      const inLog = Math.abs(across) < 1;
      if (!inLog) {
        // Chinking between the logs: its own colour, set back.
        const n = 0.92 + 0.16 * fine.at(u, v);
        t.r = CHINKING[0] * n;
        t.g = CHINKING[1] * n;
        t.b = CHINKING[2] * n;
        t.paint = 0;
        t.height = 0.015;
        t.roughness = 0.9;
        t.ao = 0.7;
        return;
      }
      const round = Math.sqrt(1 - across * across);
      // A seasoning check along each log, wandering a little.
      const checkAt = 0.25 * (hash1(c, SEED + 34) - 0.5) + 0.04 * (fine.at(u * 0.25, c * 0.13) - 0.5);
      const check = 1 - smoothstep(0.002, 0.006, Math.abs(across - checkAt) * 0.13);
      const crack = check * smoothstep(0.35, 0.6, grain.at(u * 0.5, c * 0.125 + 0.3));
      const tone = 1 + 0.12 * (hash1(c, SEED + 35) - 0.5);
      const d = tone * (1 + 0.12 * (grain.at(u, v) - 0.5)) * (1 + 0.12 * (weather.at(u, v) - 0.5)) * (0.82 + 0.18 * round) * (1 - 0.45 * crack);
      t.r = d;
      t.g = d;
      t.b = d;
      t.paint = 1;
      t.height = 0.12 * round - 0.004 * crack;
      t.roughness = 0.8;
      t.ao = 0.55 + 0.45 * round;
    },
  };
}

function render(): Recipe {
  const blotch = new Fbm(4, 4, 4, SEED + 41);
  const stucco = new Fbm(96, 96, 2, SEED + 42);
  const grit = new Lattice(256, 256, SEED + 43);
  const streak = new Fbm(24, 2, 2, SEED + 44);
  return {
    metres: 3.0,
    cavity: 60,
    texel(u, v, t) {
      const s = stucco.at(u, v);
      const d = (1 + 0.12 * (blotch.at(u, v) - 0.5)) * (1 + 0.05 * (s - 0.5)) * (1 + 0.05 * (grit.at(u, v) - 0.5)) * (1 - 0.06 * smoothstep(0.55, 0.85, streak.at(u, v)));
      t.r = d;
      t.g = d;
      t.b = d;
      t.paint = 1;
      t.height = 0.0025 * s + 0.0006 * grit.at(u, v);
      t.roughness = 0.9;
      t.ao = 1;
    },
  };
}

const MORTAR = [0.36, 0.345, 0.31] as const;

function stone(): Recipe {
  const rows = 6;
  // Coursed rubble: row bounds jittered, stones of 0.2 to 0.65 m along each row, their outlines wandering.
  const bounds = [0];
  for (let k = 1; k < rows; k += 1) bounds.push((k + 0.44 * (hash1(k, SEED + 51) - 0.5)) / rows);
  bounds.push(1);
  const rowCuts = Array.from({ length: rows }, (_, r) => cutRow(0.085, 0.27, SEED + 52 + r * 17));
  const face = new Fbm(24, 24, 3, SEED + 53);
  const speck = new Lattice(192, 192, SEED + 54);
  const mortarNoise = new Lattice(128, 128, SEED + 55);
  const warpU = new Fbm(16, 16, 2, SEED + 58);
  const warpV = new Fbm(16, 16, 2, SEED + 59);
  const jointHalf = 0.014 / 2.4;
  const warp = 0.03 / 2.4;
  return {
    metres: 2.4,
    cavity: 10,
    texel(u, v, t) {
      const wu = u + warp * (warpU.at(u, v) - 0.5) * 2;
      const wv = Math.min(1 - 1e-6, Math.max(0, v + warp * (warpV.at(u, v) - 0.5) * 2));
      let r = 0;
      while (r + 1 < rows && wv >= bounds[r + 1]!) r += 1;
      const p = pieceOf(rowCuts[r]!, frac(wu));
      const edge = Math.min(p.before, p.after, wv - bounds[r]!, bounds[r + 1]! - wv);
      if (edge < jointHalf) {
        const n = 0.9 + 0.2 * mortarNoise.at(u * 2, v * 2);
        t.r = MORTAR[0] * n;
        t.g = MORTAR[1] * n;
        t.b = MORTAR[2] * n;
        t.paint = 0;
        t.height = 0.004 * mortarNoise.at(u, v);
        t.roughness = 0.95;
        t.ao = 0.8;
        return;
      }
      const id = r * 64 + p.index;
      const tone = 1 + 0.3 * (hash1(id, SEED + 56) - 0.5);
      const warm = 0.06 * (hash1(id, SEED + 57) - 0.5);
      // A rounded face: steep at the joint, flat over the middle.
      const pillow = Math.sqrt(smoothstep(0, 0.09 / 2.4, edge - jointHalf));
      const f = face.at(u, v);
      const d = tone * (1 + 0.22 * (f - 0.5)) * (1 + 0.1 * (speck.at(u, v) - 0.5)) * (0.9 + 0.1 * pillow);
      t.r = d * (1 + warm);
      t.g = d;
      t.b = d * (1 - warm);
      t.paint = 1;
      t.height = 0.028 * pillow + 0.012 * f + 0.01 * hash1(id, SEED + 60);
      t.roughness = 0.85;
      t.ao = 1;
    },
  };
}

function metal(): Recipe {
  const ribs = 32;
  const rust = new Fbm(4, 4, 4, SEED + 61);
  const streak = new Fbm(40, 3, 2, SEED + 62);
  const fine = new Lattice(128, 128, SEED + 63);
  return {
    metres: 2.4,
    cavity: 0,
    texel(u, v, t) {
      const phase = u * ribs;
      const crest = 0.5 + 0.5 * Math.cos(2 * Math.PI * phase);
      // An end lap across each sheet, and fixings on every other crest along four purlins.
      const lap = 1 - smoothstep(0.0, 0.006, Math.min(v, 1 - v) * 2.4);
      const purlin = Math.abs(frac(v * 4) - 0.5) * 0.6;
      const nearCrest = Math.abs(frac(phase / 2 + 0.5) - 0.5) * 2 * 0.075;
      const fixing = 1 - smoothstep(0.004, 0.007, Math.hypot(purlin - 0.3, nearCrest));
      const st = streak.at(u, v);
      const fn = fine.at(u, v);
      const r = smoothstep(0.62, 0.85, rust.at(u, v) * 0.6 + st * 0.5);
      const d = (1 + 0.08 * (st - 0.5)) * (1 + 0.03 * (fn - 0.5)) * (0.94 + 0.06 * crest) * (1 - 0.25 * lap) * (1 - 0.4 * fixing);
      t.r = d * (1 - 0.1 * r);
      t.g = d * (1 - 0.3 * r);
      t.b = d * (1 - 0.45 * r);
      t.paint = 1;
      t.height = 0.009 * crest + 0.002 * lap;
      t.roughness = 0.42 + 0.35 * r + 0.06 * (fn - 0.5);
      t.ao = 0.88 + 0.12 * crest;
    },
  };
}

function shingle(): Recipe {
  const courses = 18;
  const rowCuts = Array.from({ length: courses }, (_, c) => cutRow(0.035, 0.1, SEED + 71 + c * 13));
  const grain = new Lattice(160, 12, SEED + 72);
  const weather = new Fbm(3, 3, 4, SEED + 73);
  return {
    metres: 2.4,
    cavity: 14,
    texel(u, v, t) {
      const y = v * courses;
      const c = Math.floor(y) % courses;
      const f = y - Math.floor(y);
      const p = pieceOf(rowCuts[c]!, u);
      const gap = 1 - smoothstep(0.0012, 0.0028, Math.min(p.before, p.after));
      const id = c * 64 + p.index;
      const tone = 1 + 0.24 * (hash1(id, SEED + 74) - 0.5);
      const tilt = 0.002 * (hash1(id, SEED + 75) - 0.5) * (2 * frac(u * 9) - 1);
      const d = tone * (1 + 0.06 * (grain.at(u, v) - 0.5)) * (1 + 0.14 * (weather.at(u, v) - 0.5)) * (1 - 0.55 * gap);
      t.r = d;
      t.g = d;
      t.b = d;
      t.paint = 1;
      t.height = 0.01 * (1 - f) * smoothstep(0, 0.02, f) + tilt - 0.004 * gap;
      t.roughness = 0.8;
      t.ao = (1 - 0.35 * smoothstep(0.8, 1, f)) * (1 - 0.3 * gap);
    },
  };
}

function tile(): Recipe {
  const rows = 8;
  const cols = 12;
  const dirt = new Fbm(4, 4, 4, SEED + 81);
  const fine = new Lattice(128, 128, SEED + 82);
  return {
    metres: 2.4,
    cavity: 8,
    texel(u, v, t) {
      const y = v * rows;
      const c = Math.floor(y);
      const f = y - c;
      const x = u * cols;
      const k = Math.floor(x);
      const g = x - k;
      // A barrel across each tile, lapped over the course below.
      const barrel = 0.5 - 0.5 * Math.cos(2 * Math.PI * g);
      const id = c * 32 + k;
      const tone = 1 + 0.2 * (hash1(id, SEED + 83) - 0.5);
      const d = tone * (1 + 0.12 * (dirt.at(u, v) - 0.5)) * (1 + 0.05 * (fine.at(u, v) - 0.5)) * (0.86 + 0.14 * barrel);
      t.r = d;
      t.g = d * (1 - 0.02 * (hash1(id, SEED + 84) - 0.5));
      t.b = d;
      t.paint = 1;
      t.height = 0.03 * barrel + 0.012 * (1 - f) * smoothstep(0, 0.03, f);
      t.roughness = 0.75;
      t.ao = (0.75 + 0.25 * barrel) * (1 - 0.3 * smoothstep(0.85, 1, f));
    },
  };
}

function planks(): Recipe {
  const count = 16;
  const grain = new Lattice(256, 10, SEED + 91);
  const figure = new Fbm(24, 3, 3, SEED + 92);
  return {
    metres: 2.4,
    cavity: 10,
    texel(u, v, t) {
      const x = u * count;
      const i = Math.floor(x);
      const f = x - i;
      // Two boards a tile length, the joints staggered board to board.
      const s = hash1(i, SEED + 93);
      const along = frac(v - s) * 2;
      const segment = Math.floor(along);
      const g = along - segment;
      const seam = Math.min(f, 1 - f) * 0.15;
      const butt = Math.min(g, 1 - g) * 1.2;
      const gap = 1 - smoothstep(0.0008, 0.002, Math.min(seam, butt));
      const tone = 1 + 0.18 * (hash1(i * 4 + segment, SEED + 94) - 0.5);
      const gr = grain.at(u, v);
      const fg = figure.at(u, v);
      const d = tone * (1 + 0.1 * (gr - 0.5)) * (1 + 0.12 * (fg - 0.5)) * (1 - 0.5 * gap);
      t.r = d;
      t.g = d;
      t.b = d;
      t.paint = 1;
      t.height = -0.002 * gap + 0.0006 * gr;
      t.roughness = 0.5 + 0.1 * (0.5 - fg);
      t.ao = 1;
    },
  };
}

function timber(): Recipe {
  const broad = new Fbm(6, 6, 4, SEED + 101);
  const grit = new Fbm(64, 64, 2, SEED + 102);
  const speck = new Lattice(256, 256, SEED + 103);
  return {
    metres: 1.2,
    cavity: 20,
    texel(u, v, t) {
      // Weathered wood without a grain direction (a post's faces and a beam's share the layer):
      // mottling, grit and fine dark specks.
      const g = grit.at(u, v);
      const s = smoothstep(0.7, 0.9, speck.at(u, v));
      const br = broad.at(u, v);
      const d = (1 + 0.18 * (br - 0.5)) * (1 + 0.1 * (g - 0.5)) * (1 - 0.12 * s);
      t.r = d;
      t.g = d;
      t.b = d;
      t.paint = 1;
      t.height = 0.0015 * g;
      t.roughness = WOOD_ROUGH + 0.08 * (0.5 - br);
      t.ao = 1;
    },
  };
}

function paint(): Recipe {
  const broad = new Fbm(6, 6, 3, SEED + 111);
  const fine = new Lattice(128, 128, SEED + 112);
  return {
    metres: 1.2,
    cavity: 0,
    texel(u, v, t) {
      const br = broad.at(u, v);
      const fn = fine.at(u, v);
      const d = (1 + 0.05 * (br - 0.5)) * (1 + 0.03 * (fn - 0.5));
      t.r = d;
      t.g = d;
      t.b = d;
      t.paint = 1;
      t.height = 0.0004 * fn;
      t.roughness = 0.45 + 0.08 * (0.5 - br);
      t.ao = 1;
    },
  };
}

const SASH = [0.78, 0.77, 0.74] as const;

function window(): Recipe {
  // A double-hung sash: frame round, a meeting rail across the middle, a muntin up each sash.
  const frameU = 0.065;
  const frameV = 0.05;
  const muntin = 0.014;
  const rail = 0.022;
  const smudge = new Fbm(4, 4, 3, SEED + 121);
  return {
    metres: 1.1,
    cavity: 0,
    texel(u, v, t) {
      const du = Math.min(u, 1 - u) - frameU;
      const dv = Math.min(v, 1 - v) - frameV;
      const dm = Math.abs(u - 0.5) - muntin;
      const dr = Math.abs(v - 0.5) - rail;
      const toWood = Math.min(du, dv, dm, dr);
      if (toWood < 0) {
        const n = 0.97 + 0.06 * smudge.at(u * 3, v * 3);
        t.r = SASH[0] * n;
        t.g = SASH[1] * n;
        t.b = SASH[2] * n;
        t.paint = 0;
        t.height = 0.03 * smoothstep(0, -0.008, toWood);
        t.roughness = 0.45;
        t.ao = 1;
        return;
      }
      // The glass: the sky's reflection brighter at the top of each pane, a faint smudge.
      const pane = v < 0.5 ? (v - frameV) / (0.5 - rail - frameV) : (v - 0.5 - rail) / (0.5 - rail - frameV);
      const d = (0.72 + 0.56 * Math.min(1, Math.max(0, pane)) ** 1.5) * (1 + 0.08 * (smudge.at(u, v) - 0.5));
      t.r = d;
      t.g = d;
      t.b = d;
      t.paint = 1;
      t.height = 0;
      t.roughness = 0.06;
      t.ao = 0.7 + 0.3 * smoothstep(0, 0.04, toWood);
    },
  };
}

function doorway(): Recipe {
  const murk = new Fbm(3, 3, 3, SEED + 131);
  return {
    metres: 1.0,
    cavity: 0,
    texel(u, v, t) {
      // The dark inside: light from the door falls on the floor, the jambs and the head throw shadow.
      const floor = 1 - smoothstep(0.0, 0.3, v);
      const sides = 0.7 + 0.3 * Math.sin(Math.PI * u);
      const head = 1 - 0.3 * smoothstep(0.75, 1, v);
      const d = (0.75 + 0.5 * floor) * sides * head * (1 + 0.1 * (murk.at(u, v) - 0.5));
      t.r = d;
      t.g = d;
      t.b = d;
      t.paint = 1;
      t.height = 0;
      t.roughness = 0.9;
      t.ao = 1;
    },
  };
}

const RECIPES: Readonly<Record<StructureTextureLayer, () => Recipe>> = {
  clapboard, boards, logs, render, stone, metal, shingle, tile, planks, timber, paint, window, doorway,
};

// --- Layers to bytes -------------------------------------------------------------------------

/** One layer at `edge`: detail and normal RGBA bytes. */
export function synthesizeStructureLayer(layer: StructureTextureLayer, edge: StructureTextureEdge): { detail: Uint8Array; normal: Uint8Array } {
  const recipe = RECIPES[layer]();
  const n = edge * edge;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const bl = new Float32Array(n);
  const paintMask = new Float32Array(n);
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const ao = new Float32Array(n);
  // Fractional starts: the fields hold doubles from the first texel (no Smi-to-Double re-shape mid-loop).
  const t: Texel = { r: 0.5, g: 0.5, b: 0.5, paint: 0.5, height: 0.5, roughness: 0.5, ao: 0.5 };
  let lum = 0;
  let painted = 0;
  for (let y = 0; y < edge; y += 1) {
    const v = (y + 0.5) / edge;
    for (let x = 0; x < edge; x += 1) {
      const u = (x + 0.5) / edge;
      recipe.texel(u, v, t);
      const i = y * edge + x;
      r[i] = t.r;
      g[i] = t.g;
      bl[i] = t.b;
      paintMask[i] = t.paint;
      height[i] = t.height;
      rough[i] = t.roughness;
      ao[i] = t.ao;
      if (t.paint >= 0.5) {
        lum += 0.2126 * t.r + 0.7152 * t.g + 0.0722 * t.b;
        painted += 1;
      }
    }
  }
  // The painted texels average exactly the part's colour: what Low draws, and what the layer reads as at range.
  const toMid = painted > 0 ? 0.5 / (lum / painted) : 0.5;
  // The relief's cavity: below a local mean (a periodic box blur ~1/64 of the tile).
  const blur = recipe.cavity > 0 ? periodicBoxBlur(height, edge, Math.max(1, edge >> 6)) : null;
  const metresPerTexel = recipe.metres / edge;
  const detail = new Uint8Array(n * 4);
  const normal = new Uint8Array(n * 4);
  for (let y = 0; y < edge; y += 1) {
    const yUp = y + 1 === edge ? 0 : y + 1;
    const yDown = y === 0 ? edge - 1 : y - 1;
    for (let x = 0; x < edge; x += 1) {
      const i = y * edge + x;
      const xR = x + 1 === edge ? 0 : x + 1;
      const xL = x === 0 ? edge - 1 : x - 1;
      const k = paintMask[i]! >= 0.5 ? toMid : 1;
      detail[i * 4] = toByte(r[i]! * k);
      detail[i * 4 + 1] = toByte(g[i]! * k);
      detail[i * 4 + 2] = toByte(bl[i]! * k);
      detail[i * 4 + 3] = toByte(paintMask[i]!);
      const dhdu = (height[y * edge + xR]! - height[y * edge + xL]!) / (2 * metresPerTexel);
      const dhdv = (height[yUp * edge + x]! - height[yDown * edge + x]!) / (2 * metresPerTexel);
      const len = Math.sqrt(dhdu * dhdu + dhdv * dhdv + 1);
      normal[i * 4] = toByte((-dhdu / len) * 0.5 + 0.5);
      normal[i * 4 + 1] = toByte((-dhdv / len) * 0.5 + 0.5);
      normal[i * 4 + 2] = toByte(rough[i]!);
      const cavity = blur ? Math.max(0, Math.min(1, 1 - recipe.cavity * Math.max(0, blur[i]! - height[i]!))) : 1;
      normal[i * 4 + 3] = toByte(ao[i]! * cavity);
    }
  }
  return { detail, normal };
}

function toByte(x: number): number {
  return x <= 0 ? 0 : x >= 1 ? 255 : (x * 255 + 0.5) | 0;
}

/** A box blur of `radius` texels that wraps (the layer tiles). */
function periodicBoxBlur(src: Float32Array, edge: number, radius: number): Float32Array {
  const across = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const span = 2 * radius + 1;
  for (let y = 0; y < edge; y += 1) {
    const row = y * edge;
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) sum += src[row + ((k + edge) % edge)]!;
    for (let x = 0; x < edge; x += 1) {
      across[row + x] = sum / span;
      sum += src[row + ((x + radius + 1) % edge)]! - src[row + ((x - radius + edge) % edge)]!;
    }
  }
  for (let x = 0; x < edge; x += 1) {
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) sum += across[((k + edge) % edge) * edge + x]!;
    for (let y = 0; y < edge; y += 1) {
      out[y * edge + x] = sum / span;
      sum += across[((y + radius + 1) % edge) * edge + x]! - across[((y - radius + edge) % edge) * edge + x]!;
    }
  }
  return out;
}

/** Every layer at `edge`, in `STRUCTURE_TEXTURE_LAYERS` order. */
export function synthesizeStructureTextures(edge: StructureTextureEdge): StructureTextureSet {
  const detail: Uint8Array[] = [];
  const normal: Uint8Array[] = [];
  for (const layer of STRUCTURE_TEXTURE_LAYERS) {
    const out = synthesizeStructureLayer(layer, edge);
    detail.push(out.detail);
    normal.push(out.normal);
  }
  return { edge, detail, normal };
}
