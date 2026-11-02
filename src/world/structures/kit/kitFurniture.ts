import type { StructureColliderMaterial, StructureSurface } from "../structureModel";
import { type KitBuilder, FACE, shade } from "./kitBuilder";
import type { PlanRoom } from "./kitPlan";
import { KitChannel, type KitRandom } from "./kitRandom";
import type { StructureLook } from "./kitStyles";

/**
 * A few blocky pieces a room (the plan's "Furniture"): tables, benches, beds,
 * stoves, shelves, counters, stalls. Each piece stands against a wall, clear
 * of doors, door leaves, stairs and (if tall) windows, and leaves the room's
 * doors joined by a walkway the walker's capsule fits through. Every piece is
 * solid: one collider box round it.
 *
 * Then what makes a room look lived in, all thinner than the walker notices
 * (no colliders, as the contract's parts under 0.1 m): books and goods on the
 * shelves, cushions on the sofa, a rug, a picture over a low piece, and
 * curtains beside the windows of the rooms people live in.
 */

/** The walker's capsule radius: the walkway every room keeps between its doors. */
export const WALKER_RADIUS = 0.3;

/** A rectangle in plan, building frame. */
export interface PlanRect {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
}

/** A stretch of wall where only low furniture may stand (under a window). */
export interface WallSpan {
  /** The wall: its axis (the inner face's normal), the face's coordinate, and the room side (+1/-1). */
  readonly normal: "x" | "z";
  readonly at: number;
  readonly s0: number;
  readonly s1: number;
  /** The opening's sill and head, building-frame heights. */
  readonly y0: number;
  readonly y1: number;
}

export interface RoomContext {
  readonly room: PlanRoom;
  /** Floor level, building frame y. */
  readonly floor: number;
  readonly ceiling: number;
  readonly indoor: number;
  /** Where nothing may stand: door ways, door leaves, stairs, wells. */
  readonly keepOut: readonly PlanRect[];
  /** Points that must stay joined by a walkway (in front of each door). */
  readonly anchors: readonly { x: number; z: number }[];
  /** Window spans on this room's walls. */
  readonly windows: readonly WallSpan[];
  readonly look: StructureLook;
  readonly rng: KitRandom;
  /** Index of the room, for the dice. */
  readonly index: number;
  readonly variant: string;
}

interface LocalBox {
  /** Along the wall from the piece's start, metres. */
  readonly a0: number;
  readonly a1: number;
  /** Out from the wall. */
  readonly d0: number;
  readonly d1: number;
  readonly y0: number;
  readonly y1: number;
  readonly surface: StructureSurface;
  readonly colour: number;
  /** Faces hidden beyond the defaults (`HIDE` bits): a book's back on the shelf's, its bottom on the board. */
  readonly hide?: number;
}

/** A box's faces in the piece's own terms: against the wall, underneath, its two ends along the wall, on top. */
const HIDE = Object.freeze({ back: 1, bottom: 2, ends: 4, top: 8 });

interface Piece {
  readonly name: string;
  /** Length along the wall, depth into the room, height. */
  readonly w: number;
  readonly d: number;
  readonly h: number;
  readonly boxes: readonly LocalBox[];
  readonly material: StructureColliderMaterial;
  /** May stand under a window. */
  readonly low: boolean;
  /** The solid boxes (local, as `boxes`); the whole piece's bounding box when absent. */
  readonly solids?: readonly LocalBox[];
}

function box(a0: number, a1: number, d0: number, d1: number, y0: number, y1: number, surface: StructureSurface, colour: number, hide?: number): LocalBox {
  return hide ? { a0, a1, d0, d1, y0, y1, surface, colour, hide } : { a0, a1, d0, d1, y0, y1, surface, colour };
}

/** Book spines: cloth reds, blues, greens, tans, a black and a cream. */
const BOOK_COLOURS = [0x7a2e26, 0x2e4a5e, 0x4e5e3a, 0x8a6a3a, 0x5a3a4e, 0xc8b88a, 0x30302e, 0x9a8a6a];
/** A store's or workshop's goods: tins, jars, boxes and sacks. */
const GOODS_COLOURS = [0x8a7a5a, 0x6a6a62, 0xa89070, 0x5a6a72, 0x7a5a3a, 0xb0a48a];

/** What fills a set of shelves, and its dice (one number per throw). */
interface ShelfFill {
  readonly colours: readonly number[];
  readonly unit: (k: number) => number;
}

// --- The catalogue -------------------------------------------------------------------------

function table(w: number, d: number, timber: number): Piece {
  const top = 0.75;
  return {
    name: "table", w, d, h: top, material: "timber", low: true,
    boxes: [
      box(0, w, 0, d, top - 0.05, top, "timber", timber),
      // Trestle ends: two solid boards, chunkier than legs and readable from across a room.
      box(0.1, 0.16, 0.1, d - 0.1, 0, top - 0.05, "timber", shade(timber, 0.85)),
      box(w - 0.16, w - 0.1, 0.1, d - 0.1, 0, top - 0.05, "timber", shade(timber, 0.85)),
    ],
  };
}

function bench(w: number, timber: number): Piece {
  return {
    name: "bench", w, d: 0.32, h: 0.45, material: "timber", low: true,
    boxes: [
      box(0, w, 0, 0.32, 0.4, 0.45, "timber", timber),
      box(0.08, 0.14, 0.04, 0.28, 0, 0.4, "timber", shade(timber, 0.85)),
      box(w - 0.14, w - 0.08, 0.04, 0.28, 0, 0.4, "timber", shade(timber, 0.85)),
    ],
  };
}

function bed(w: number, timber: number, fabric: number): Piece {
  const len = 2.0;
  return {
    name: "bed", w, d: len, h: 0.95, material: "timber", low: true,
    boxes: [
      box(0, w, 0.06, len, 0, 0.32, "timber", timber),
      box(0.03, w - 0.03, 0.08, len - 0.03, 0.32, 0.5, "fabric", 0xe8e4da),
      box(0.04, w - 0.04, 0.6, len - 0.02, 0.5, 0.56, "fabric", fabric),
      box(0.1, w - 0.1, 0.1, 0.5, 0.5, 0.62, "fabric", 0xf0ece4),
      box(0, w, 0, 0.06, 0, 0.95, "timber", shade(timber, 0.9)),
    ],
  };
}

function bunk(timber: number, fabric: number, fabric2: number): Piece {
  const w = 2.0;
  const d = 0.92;
  return {
    name: "bunk", w, d, h: 1.65, material: "timber", low: false,
    boxes: [
      box(0, 0.08, 0, d, 0, 1.65, "timber", timber),
      box(w - 0.08, w, 0, d, 0, 1.65, "timber", timber),
      box(0.08, w - 0.08, 0, d, 0.25, 0.35, "timber", timber),
      box(0.1, w - 0.1, 0.02, d - 0.02, 0.35, 0.48, "fabric", fabric),
      box(0.08, w - 0.08, 0, d, 1.15, 1.25, "timber", timber),
      box(0.1, w - 0.1, 0.02, d - 0.02, 1.25, 1.38, "fabric", fabric2),
    ],
  };
}

function shelves(w: number, h: number, timber: number, fill?: ShelfFill): Piece {
  const d = 0.38;
  const boxes: LocalBox[] = [
    box(0, 0.04, 0, d, 0, h, "timber", timber),
    box(w - 0.04, w, 0, d, 0, h, "timber", timber),
    box(0.04, w - 0.04, 0, 0.02, 0, h, "timber", shade(timber, 0.8)),
  ];
  const n = Math.max(2, Math.round(h / 0.42));
  for (let i = 0; i <= n; i += 1) {
    const y = (i / n) * (h - 0.03);
    boxes.push(box(0.04, w - 0.04, 0.02, d, y, y + 0.03, "timber", timber));
  }
  if (fill) fillShelves(boxes, w, d, h, n, fill);
  return { name: "shelves", w, d, h, material: "timber", low: false, boxes };
}

/**
 * Up to three runs of books (or goods) on each level, of seeded widths,
 * heights and colours, with gaps; now and then a level is left bare. A run is
 * one box showing its front, top and ends: from across a room it reads as a
 * row of spines.
 */
function fillShelves(boxes: LocalBox[], w: number, d: number, h: number, n: number, fill: ShelfFill): void {
  const { colours, unit } = fill;
  const pitch = (h - 0.03) / n;
  const clear = pitch - 0.03;
  let k = 0;
  for (let level = 0; level < n; level += 1) {
    if (unit(k++) < 0.15) continue;
    const y = level * pitch + 0.03;
    let a = 0.05 + 0.12 * unit(k++);
    for (let run = 0; run < 3; run += 1) {
      const width = 0.14 + 0.3 * unit(k++);
      const end = Math.min(a + width, w - 0.06);
      if (end - a < 0.1) break;
      const height = Math.min(clear - 0.03, 0.19 + 0.12 * unit(k++));
      const depth = Math.min(d - 0.06, 0.18 + 0.08 * unit(k++));
      const colour = colours[Math.floor(unit(k++) * colours.length) % colours.length]!;
      boxes.push(box(a, end, 0.02, 0.02 + depth, y, y + height, "fabric", colour, HIDE.back | HIDE.bottom));
      a = end + (unit(k++) < 0.4 ? 0.06 + 0.2 * unit(k++) : 0.005);
    }
  }
}

function counter(w: number, timber: number, top: number): Piece {
  return {
    name: "counter", w, d: 0.6, h: 0.9, material: "timber", low: true,
    boxes: [
      box(0, w, 0, 0.55, 0, 0.86, "timber", timber),
      box(0, w, 0, 0.6, 0.86, 0.9, "concrete", top),
    ],
  };
}

function stove(pipe: number, ceiling: number): Piece {
  return {
    name: "stove", w: 0.62, d: 0.6, h: ceiling, material: "metal", low: false,
    boxes: [
      box(0.02, 0.6, 0.05, 0.6, 0, 0.82, "steel", 0x2a2a2a),
      box(0, 0.62, 0.03, 0.6, 0.82, 0.86, "steel", 0x1e1e1e),
      box(0.23, 0.39, 0.15, 0.31, 0.86, ceiling, "steel", pipe),
    ],
  };
}

function sofa(w: number, fabric: number, cushion: number): Piece {
  const boxes = [
    box(0, w, 0.18, 0.85, 0, 0.44, "fabric", fabric),
    box(0, w, 0, 0.2, 0, 0.82, "fabric", shade(fabric, 0.88)),
    box(0, 0.16, 0.2, 0.85, 0.44, 0.62, "fabric", shade(fabric, 0.94)),
    box(w - 0.16, w, 0.2, 0.85, 0.44, 0.62, "fabric", shade(fabric, 0.94)),
  ];
  // Two cushions against the back, in the room's other fabric.
  if (w >= 1.2) {
    boxes.push(
      box(0.2, 0.6, 0.2, 0.34, 0.44, 0.8, "fabric", cushion, HIDE.back | HIDE.bottom),
      box(w - 0.6, w - 0.2, 0.2, 0.34, 0.44, 0.8, "fabric", shade(cushion, 0.92), HIDE.back | HIDE.bottom),
    );
  }
  return { name: "sofa", w, d: 0.85, h: 0.82, material: "timber", low: true, boxes };
}

function chest(w: number, timber: number): Piece {
  return { name: "chest", w, d: 0.48, h: 0.82, material: "timber", low: true, boxes: [box(0, w, 0, 0.48, 0, 0.82, "timber", timber)] };
}

function wardrobe(timber: number): Piece {
  return {
    name: "wardrobe", w: 1.0, d: 0.6, h: 1.95, material: "timber", low: false,
    boxes: [box(0, 1.0, 0, 0.58, 0, 1.95, "timber", timber), box(0.49, 0.51, 0.58, 0.6, 0.1, 1.85, "timber", shade(timber, 0.7))],
  };
}

function desk(timber: number): Piece {
  return {
    name: "desk", w: 1.4, d: 0.7, h: 0.76, material: "timber", low: true,
    boxes: [
      box(0, 1.4, 0, 0.7, 0.72, 0.76, "timber", timber),
      box(0, 0.45, 0.02, 0.68, 0, 0.72, "timber", shade(timber, 0.88)),
      box(1.34, 1.4, 0.04, 0.66, 0, 0.72, "timber", shade(timber, 0.88)),
    ],
  };
}

function saunaBenches(w: number, timber: number): Piece {
  return {
    name: "benches", w, d: 1.1, h: 0.95, material: "timber", low: true,
    boxes: [
      box(0, w, 0, 0.6, 0, 0.95, "timber", shade(timber, 1.15)),
      box(0, w, 0.6, 1.1, 0, 0.47, "timber", shade(timber, 1.1)),
    ],
  };
}

function saunaStove(): Piece {
  return {
    name: "sauna stove", w: 0.55, d: 0.55, h: 0.85, material: "stone", low: true,
    boxes: [box(0, 0.55, 0, 0.55, 0, 0.6, "steel", 0x2e2c2a), box(0.03, 0.52, 0.03, 0.52, 0.6, 0.85, "stone", 0x6a6660)],
  };
}

function workbench(w: number, timber: number): Piece {
  return {
    name: "workbench", w, d: 0.72, h: 0.92, material: "timber", low: true,
    boxes: [
      box(0, w, 0, 0.72, 0.84, 0.92, "timber", shade(timber, 1.1)),
      box(0.05, 0.13, 0.05, 0.67, 0, 0.84, "timber", timber),
      box(w - 0.13, w - 0.05, 0.05, 0.67, 0, 0.84, "timber", timber),
      box(0.13, w - 0.13, 0.05, 0.67, 0.18, 0.24, "timber", timber),
    ],
  };
}

function crates(timber: number): Piece {
  return {
    name: "crates", w: 1.3, d: 0.65, h: 1.2, material: "timber", low: false,
    boxes: [
      box(0, 0.62, 0, 0.62, 0, 0.6, "boards", timber),
      box(0.66, 1.28, 0.02, 0.64, 0, 0.6, "boards", shade(timber, 1.12)),
      box(0.3, 0.92, 0.01, 0.63, 0.6, 1.2, "boards", shade(timber, 0.9)),
    ],
  };
}

/** A row of stalls along a wall: dividers end-on to it and a manger along it. */
function stallRow(n: number, depth: number, timber: number): Piece {
  const bay = 1.8;
  const w = n * bay + 0.12;
  const boxes: LocalBox[] = [box(0, w, 0, 0.45, 0, 0.7, "boards", shade(timber, 0.9))];
  const solids: LocalBox[] = [boxes[0]!];
  for (let i = 0; i <= n; i += 1) {
    const a = i * bay;
    const divider = box(a, a + 0.12, 0.45, depth, 0, 1.35, "boards", timber);
    boxes.push(divider, box(a, a + 0.12, depth - 0.12, depth, 1.35, 1.6, "timber", shade(timber, 0.85)));
    solids.push(box(a, a + 0.12, 0.45, depth, 0, 1.6, "boards", timber));
  }
  return { name: "stalls", w, d: depth, h: 1.6, material: "timber", low: true, boxes, solids };
}

function hay(timber: number): Piece {
  const c = 0xc8b06a;
  return {
    name: "hay", w: 1.8, d: 1.0, h: 1.2, material: "timber", low: false,
    boxes: [
      box(0, 0.9, 0, 0.5, 0, 0.4, "boards", c), box(0.9, 1.8, 0, 0.5, 0, 0.4, "boards", shade(c, 0.95)),
      box(0, 0.9, 0.5, 1.0, 0, 0.4, "boards", shade(c, 1.05)), box(0.9, 1.8, 0.5, 1.0, 0, 0.4, "boards", c),
      box(0.2, 1.1, 0.1, 0.6, 0.4, 0.8, "boards", shade(c, 0.92)), box(0.5, 1.4, 0.3, 0.8, 0.8, 1.2, "boards", c),
      box(1.1, 1.75, 0.55, 0.95, 0.4, 0.45, "timber", timber),
    ],
  };
}

function coatRack(timber: number): Piece {
  return { name: "side table", w: 0.8, d: 0.36, h: 0.8, material: "timber", low: true, boxes: [box(0, 0.8, 0, 0.36, 0, 0.8, "timber", timber)] };
}

/** What a room of this kind holds, in the order it is placed (most important first). */
function catalogue(ctx: RoomContext): Piece[] {
  const { look, rng, room } = ctx;
  const timber = shade(look.floorColour, 0.82);
  const dark = shade(look.timberColour, 1.05);
  const f = look.fabricColours;
  const w = room.x1 - room.x0;
  const d = room.z1 - room.z0;
  const long = Math.max(w, d);
  const short = Math.min(w, d);
  const cold = look.style === "boreal" || look.style === "tundra" || look.style === "alpine";
  const ceiling = ctx.ceiling - ctx.floor;
  // Each set of shelves throws its own dice for what stands on it.
  let fills = 0;
  const filled = (colours: readonly number[]): ShelfFill => {
    const salt = (ctx.index * 8 + fills++) * 512;
    return { colours, unit: (k) => rng.unit(KitChannel.decor, salt + k) };
  };
  const books = () => filled(BOOK_COLOURS);
  const goods = () => filled(GOODS_COLOURS);
  switch (room.kind) {
    case "living":
      return [
        ...(cold ? [stove(0x222222, ceiling)] : []),
        sofa(Math.min(2.0, long - 1.6), f[0]!, f[2]!),
        ...(short >= 3.2 ? [table(1.0, 0.55, timber)] : []),
        shelves(1.0, 1.9, timber, books()),
        chest(0.9, dark),
      ];
    case "kitchen":
      return [
        counter(Math.min(2.4, Math.max(1.2, long - 1.8)), shade(timber, 1.1), 0x9a948a),
        stove(0x2a2a2a, ceiling),
        table(Math.min(1.3, short - 1.6), 0.8, timber),
        bench(1.2, timber),
      ];
    case "dining":
      return [table(Math.min(1.6, long - 1.8), 0.9, timber), bench(1.4, timber), shelves(1.1, 1.8, dark, goods())];
    case "bedroom": {
      const double = short >= 3.0 && rng.chance(KitChannel.furniture, 0.6, ctx.index);
      return [bed(double ? 1.4 : 0.95, timber, f[(ctx.index + 1) % f.length]!), wardrobe(dark), chest(0.8, timber)];
    }
    case "main":
      return [
        stove(0x222222, ceiling),
        bed(0.95, timber, f[1]!),
        table(Math.min(1.1, short - 1.5), 0.75, timber),
        bench(1.0, timber),
        shelves(0.9, 1.7, dark, books()),
      ];
    case "bunk":
      return [bunk(timber, f[0]!, f[2]!), bunk(timber, f[1]!, f[0]!), chest(0.8, dark)];
    case "steam":
      return [saunaBenches(Math.min(2.4, long - 0.2), timber), saunaStove()];
    case "changing":
      return [bench(Math.min(1.4, long - 0.4), timber), shelves(0.6, 1.6, timber)];
    case "office":
      return [desk(timber), shelves(1.2, 1.9, dark, books()), table(1.0, 0.6, timber), chest(0.9, dark)];
    case "barn": {
      const n = Math.max(2, Math.min(6, Math.floor((long - 3.4) / 1.8)));
      return [stallRow(n, Math.min(2.6, short * 0.32), dark), hay(dark), workbench(1.6, timber)];
    }
    case "tack":
      return [shelves(1.0, 1.7, dark, goods()), bench(1.2, timber), chest(0.9, dark)];
    case "workshop":
      return ctx.variant === "workshop-store"
        ? [shelves(1.6, 1.9, dark, goods()), workbench(Math.min(2.2, long - 1.2), timber), crates(dark)]
        : [workbench(Math.min(2.2, long - 1.2), timber), shelves(1.2, 1.9, dark, goods()), crates(dark)];
    case "store":
      return ctx.variant === "store-aisle"
        ? [shelves(Math.min(2.0, long - 1.2), 1.9, dark, goods()), shelves(Math.min(2.0, long - 1.2), 1.9, dark, goods()), crates(timber)]
        : [shelves(Math.min(1.6, long - 1.4), 1.9, dark, goods()), crates(timber), shelves(1.0, 1.9, dark, goods()), crates(shade(timber, 0.9))];
    case "hall":
    case "landing":
      return long >= 4 ? [coatRack(timber)] : [];
    default:
      return [];
  }
}

// --- Placement -----------------------------------------------------------------------------

interface Wall {
  readonly normal: "x" | "z";
  /** The inner face's coordinate and the room's side of it. */
  readonly at: number;
  readonly inward: 1 | -1;
  readonly s0: number;
  readonly s1: number;
}

function roomWalls(room: PlanRoom): Wall[] {
  return [
    { normal: "z", at: room.z0, inward: 1, s0: room.x0, s1: room.x1 },
    { normal: "z", at: room.z1, inward: -1, s0: room.x0, s1: room.x1 },
    { normal: "x", at: room.x0, inward: 1, s0: room.z0, s1: room.z1 },
    { normal: "x", at: room.x1, inward: -1, s0: room.z0, s1: room.z1 },
  ];
}

function rectOf(wall: Wall, s: number, w: number, d0: number, d1: number): PlanRect {
  const n0 = wall.at + wall.inward * d0;
  const n1 = wall.at + wall.inward * d1;
  const lo = Math.min(n0, n1);
  const hi = Math.max(n0, n1);
  return wall.normal === "z" ? { x0: s, x1: s + w, z0: lo, z1: hi } : { x0: lo, x1: hi, z0: s, z1: s + w };
}

function overlaps(a: PlanRect, b: PlanRect, gap = 0): boolean {
  return a.x0 < b.x1 + gap && a.x1 > b.x0 - gap && a.z0 < b.z1 + gap && a.z1 > b.z0 - gap;
}

/** Whether every anchor still reaches every other through the room with these rects in the way. */
function walkable(room: PlanRoom, blocked: readonly PlanRect[], anchors: readonly { x: number; z: number }[]): boolean {
  if (anchors.length < 2) return true;
  const cell = 0.1;
  const nx = Math.max(1, Math.round((room.x1 - room.x0) / cell));
  const nz = Math.max(1, Math.round((room.z1 - room.z0) / cell));
  const r = WALKER_RADIUS;
  // Where the capsule's centre may stand: a radius off the walls and off every piece.
  const free = new Uint8Array(nx * nz);
  const cellRange = (lo: number, hi: number, origin: number, n: number): [number, number] => [
    Math.max(0, Math.ceil((lo - origin) / cell - 0.5)),
    Math.min(n - 1, Math.floor((hi - origin) / cell - 0.5)),
  ];
  const [fi0, fi1] = cellRange(room.x0 + r, room.x1 - r, room.x0, nx);
  const [fk0, fk1] = cellRange(room.z0 + r, room.z1 - r, room.z0, nz);
  for (let i = fi0; i <= fi1; i += 1) free.fill(1, i * nz + fk0, i * nz + fk1 + 1);
  for (const b of blocked) {
    // Cells whose centre lies strictly inside the piece grown by the radius.
    const [i0, i1] = cellRange(b.x0 - r + 1e-9, b.x1 + r - 1e-9, room.x0, nx);
    const [k0, k1] = cellRange(b.z0 - r + 1e-9, b.z1 + r - 1e-9, room.z0, nz);
    for (let i = i0; i <= i1; i += 1) if (k1 >= k0) free.fill(0, i * nz + k0, i * nz + k1 + 1);
  }
  // A doorway's anchor sits at the wall: step it in to where the capsule stands.
  const index = (p: { x: number; z: number }) => {
    const x = Math.min(room.x1 - r - 0.05, Math.max(room.x0 + r + 0.05, p.x));
    const z = Math.min(room.z1 - r - 0.05, Math.max(room.z0 + r + 0.05, p.z));
    const i = Math.min(nx - 1, Math.max(0, Math.floor((x - room.x0) / cell)));
    const k = Math.min(nz - 1, Math.max(0, Math.floor((z - room.z0) / cell)));
    return i * nz + k;
  };
  const start = index(anchors[0]!);
  if (!free[start]) return false;
  const seen = new Uint8Array(nx * nz);
  const queue = new Int32Array(nx * nz);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  seen[start] = 1;
  while (head < tail) {
    const c = queue[head++]!;
    const i = (c / nz) | 0;
    const k = c - i * nz;
    if (i > 0 && free[c - nz] && !seen[c - nz]) { seen[c - nz] = 1; queue[tail++] = c - nz; }
    if (i < nx - 1 && free[c + nz] && !seen[c + nz]) { seen[c + nz] = 1; queue[tail++] = c + nz; }
    if (k > 0 && free[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; queue[tail++] = c - 1; }
    if (k < nz - 1 && free[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; queue[tail++] = c + 1; }
  }
  return anchors.every((a) => seen[index(a)] === 1);
}

/** Rooms people live in: a rug, a picture and curtains. */
const LIVED_IN: ReadonlySet<PlanRoom["kind"]> = new Set(["living", "dining", "bedroom", "main", "office"]);
/** Low pieces a picture hangs over. */
const UNDER_PICTURE: ReadonlySet<string> = new Set(["sofa", "chest", "bed", "desk", "side table", "table"]);

/** Rugs' fields; the border is one of the building's fabrics. */
const RUG_COLOURS = [0x8a4a3a, 0x6a5a4a, 0x4a5a6a, 0x9a7a4a, 0x7a3a3a, 0x5a6a4a, 0xa89878];
/** Small landscapes as two bands, sky over land: fields, wheat at evening, the sea, a dark portrait. */
const PICTURES: readonly (readonly [number, number])[] = [
  [0x9ab0c0, 0x6a7a4a], [0xc8b090, 0x8a6a3a], [0x8a9aaa, 0x3e5a6a], [0xb8b0a0, 0x5a6a4a], [0x4a3e34, 0x7a5e4e],
];
const FRAME_COLOURS = [0x3a2a1e, 0x8a6a3a, 0x2a2826, 0x6e5a44];

/** Place a room's furniture and draw it; returns the footprints placed. */
export function furnishRoom(b: KitBuilder, ctx: RoomContext): PlanRect[] {
  const room = ctx.room;
  const placed: PlanRect[] = [];
  const walls = roomWalls(room);
  const pieces = catalogue(ctx);
  const livedIn = LIVED_IN.has(room.kind);
  let hung = false;
  // Start each piece on a seeded wall and position, so neighbouring rooms differ.
  pieces.forEach((piece, pieceIndex) => {
    if (piece.w <= 0.3 || piece.d <= 0.05) return;
    const wallOrder = walls.map((_, i) => i);
    const shift = Math.floor(ctx.rng.unit(KitChannel.furniture, ctx.index * 37 + pieceIndex) * walls.length);
    const order = wallOrder.map((i) => wallOrder[(i + shift) % walls.length]!);
    for (const wi of order) {
      const wall = walls[wi]!;
      const span = wall.s1 - wall.s0;
      if (span < piece.w + 0.02 || piece.d > (wall.normal === "z" ? room.z1 - room.z0 : room.x1 - room.x0) - 0.7) continue;
      const steps = Math.max(1, Math.floor((span - piece.w) / 0.1));
      const startStep = Math.floor(ctx.rng.unit(KitChannel.furniture, 500 + ctx.index * 37 + pieceIndex) * (steps + 1));
      let done = false;
      for (let k = 0; k <= steps && !done; k += 1) {
        const step = (startStep + k) % (steps + 1);
        const s = wall.s0 + 0.01 + step * ((span - piece.w - 0.02) / Math.max(1, steps));
        const rect = rectOf(wall, s, piece.w, 0, piece.d);
        if (ctx.keepOut.some((k2) => overlaps(rect, k2))) continue;
        if (placed.some((p) => overlaps(rect, p, 0.05))) continue;
        if (!piece.low && ctx.windows.some((win) => win.normal === wall.normal && Math.abs(win.at - wall.at) < 0.6
          && s < win.s1 + 0.05 && s + piece.w > win.s0 - 0.05)) continue;
        if (!walkable(room, [...placed, rect], ctx.anchors)) continue;
        placed.push(rect);
        drawPiece(b, ctx, wall, s, piece);
        if (livedIn && !hung && piece.low && UNDER_PICTURE.has(piece.name)) hung = hangPicture(b, ctx, wall, s, piece);
        done = true;
      }
      if (done) break;
    }
  });
  if (livedIn) {
    layRug(b, ctx);
    if (room.kind !== "office") hangCurtains(b, ctx, walls, placed);
  }
  return placed;
}

/** The room's own dice for its decoration, `k` a throw within one `kind` of decoration. */
function decorDice(ctx: RoomContext, kind: number, k: number): number {
  return ctx.rng.unit(KitChannel.decor, 1_000_000 + (ctx.index * 4 + kind) * 64 + k);
}

/** A rug in the middle of the floor, clear of door leaves and stairs: a border and a field. */
function layRug(b: KitBuilder, ctx: RoomContext): void {
  const room = ctx.room;
  const w = room.x1 - room.x0;
  const d = room.z1 - room.z0;
  const long = Math.min(2.6, Math.max(w, d) - 1.4);
  const short = Math.min(1.8, Math.min(w, d) - 1.4);
  if (long < 1.2 || short < 0.8) return;
  const rw = w >= d ? long : short;
  const rd = w >= d ? short : long;
  const cx = (room.x0 + room.x1) * 0.5 + (decorDice(ctx, 0, 0) - 0.5) * Math.min(0.4, w - rw - 1.4);
  const cz = (room.z0 + room.z1) * 0.5 + (decorDice(ctx, 0, 1) - 0.5) * Math.min(0.4, d - rd - 1.4);
  const rect: PlanRect = { x0: cx - rw * 0.5, x1: cx + rw * 0.5, z0: cz - rd * 0.5, z1: cz + rd * 0.5 };
  if (ctx.keepOut.some((k) => overlaps(rect, k))) return;
  const field = RUG_COLOURS[Math.floor(decorDice(ctx, 0, 2) * RUG_COLOURS.length) % RUG_COLOURS.length]!;
  const border = shade(ctx.look.fabricColours[(ctx.index + 2) % ctx.look.fabricColours.length]!, 0.85);
  const y = ctx.floor;
  b.box(rect.x0, rect.x1, y, y + 0.01, rect.z0, rect.z1, "fabric", border, FACE.py | FACE.sides, ctx.indoor);
  const inset = 0.12;
  b.box(rect.x0 + inset, rect.x1 - inset, y + 0.01, y + 0.013, rect.z0 + inset, rect.z1 - inset, "fabric", field, FACE.py, ctx.indoor);
}

/** A framed picture on the wall over a low piece, unless a window is there; whether one was hung. */
function hangPicture(b: KitBuilder, ctx: RoomContext, wall: Wall, s: number, piece: Piece): boolean {
  const pw = Math.min(0.9, piece.w - 0.3, 0.5 + 0.4 * decorDice(ctx, 1, 0));
  if (pw < 0.35) return false;
  const ph = 0.38 + 0.22 * decorDice(ctx, 1, 1);
  const y0 = Math.max(piece.h + 0.3, 1.3);
  const y1 = y0 + ph;
  if (y1 > ctx.ceiling - ctx.floor - 0.3) return false;
  const a0 = s + (piece.w - pw) * 0.5;
  if (ctx.windows.some((win) => win.normal === wall.normal && Math.abs(win.at - wall.at) < 0.6
    && a0 < win.s1 + 0.1 && a0 + pw > win.s0 - 0.1)) return false;
  const { back, front } = wallFaces(wall);
  const frame = FRAME_COLOURS[Math.floor(decorDice(ctx, 1, 2) * FRAME_COLOURS.length) % FRAME_COLOURS.length]!;
  const [sky, land] = PICTURES[Math.floor(decorDice(ctx, 1, 3) * PICTURES.length) % PICTURES.length]!;
  const f = ctx.floor;
  const r = rectOf(wall, a0, pw, 0, 0.03);
  b.box(r.x0, r.x1, f + y0, f + y1, r.z0, r.z1, "timber", frame, FACE.all & ~back & ~FACE.ny & ~FACE.py, ctx.indoor);
  // The canvas: two bands just proud of the frame, the horizon a little below the middle.
  const m = 0.05;
  const c = rectOf(wall, a0 + m, pw - 2 * m, 0.03, 0.032);
  const horizon = f + y0 + m + (ph - 2 * m) * 0.42;
  b.box(c.x0, c.x1, f + y0 + m, horizon, c.z0, c.z1, "fabric", land, front, ctx.indoor);
  b.box(c.x0, c.x1, horizon, f + y1 - m, c.z0, c.z1, "fabric", sky, front, ctx.indoor);
  return true;
}

/** Curtain cloth: linen, oatmeal, pale sea, faded rose, sage and straw. */
const CURTAIN_COLOURS = [0xd8cfc0, 0xc9b79a, 0xb8c4c0, 0xc8a8a0, 0xa8b49a, 0xd4c49a];

/** Curtains drawn back beside each window, where nothing stands in front of the wall. */
function hangCurtains(b: KitBuilder, ctx: RoomContext, walls: readonly Wall[], placed: readonly PlanRect[]): void {
  const colour = CURTAIN_COLOURS[Math.floor(decorDice(ctx, 2, 0) * CURTAIN_COLOURS.length) % CURTAIN_COLOURS.length]!;
  const top = ctx.ceiling - 0.04;
  for (const win of ctx.windows) {
    const wall = walls.find((w) => w.normal === win.normal && Math.abs(w.at - win.at) < 0.05);
    if (!wall) continue;
    const { front, ends } = wallFaces(wall);
    const y0 = Math.max(ctx.floor + 0.05, win.y0 - 0.3);
    const y1 = Math.min(top, win.y1 + 0.18);
    if (y1 - y0 < 0.5) continue;
    for (const [a0, a1] of [[win.s0 - 0.26, win.s0 - 0.01], [win.s1 + 0.01, win.s1 + 0.26]] as const) {
      if (a0 < wall.s0 + 0.02 || a1 > wall.s1 - 0.02) continue;
      const r = rectOf(wall, a0, a1 - a0, 0, 0.07);
      if (placed.some((p) => overlaps(r, p)) || ctx.keepOut.some((k) => overlaps(r, k))) continue;
      // Six narrow folds, standing out and set back, lit and shaded, so the
      // cloth reads as gathered fabric, not a board. Only the standing folds
      // have sides: they show the step down to the folds between them.
      const fold = (a1 - a0) / 6;
      for (let k = 0; k < 6; k += 1) {
        const out = k % 2 === 0;
        const f = rectOf(wall, a0 + k * fold, fold, 0, out ? 0.08 : 0.035);
        b.box(f.x0, f.x1, y0, y1, f.z0, f.z1, "fabric", out ? colour : shade(colour, 0.78), out ? front | ends : front, ctx.indoor);
      }
    }
  }
}

/** The world faces of a box standing against this wall: its back (on the wall), its front, and its two ends. */
function wallFaces(wall: Wall): { back: number; front: number; ends: number } {
  if (wall.normal === "z") {
    return { back: wall.inward > 0 ? FACE.nz : FACE.pz, front: wall.inward > 0 ? FACE.pz : FACE.nz, ends: FACE.px | FACE.nx };
  }
  return { back: wall.inward > 0 ? FACE.nx : FACE.px, front: wall.inward > 0 ? FACE.px : FACE.nx, ends: FACE.pz | FACE.nz };
}

function drawPiece(b: KitBuilder, ctx: RoomContext, wall: Wall, s: number, piece: Piece): void {
  const y0 = ctx.floor;
  // The face against the wall and the bottom are hidden.
  const { back, ends } = wallFaces(wall);
  for (const lb of piece.boxes) {
    const r = rectOf(wall, s + lb.a0, lb.a1 - lb.a0, lb.d0, lb.d1);
    let faces = FACE.all & ~FACE.ny;
    if (lb.d0 <= 1e-6) faces &= ~back;
    if (lb.y0 > 1e-6) faces |= FACE.ny;
    if (lb.hide) {
      if (lb.hide & HIDE.back) faces &= ~back;
      if (lb.hide & HIDE.bottom) faces &= ~FACE.ny;
      if (lb.hide & HIDE.ends) faces &= ~ends;
      if (lb.hide & HIDE.top) faces &= ~FACE.py;
    }
    b.box(r.x0, r.x1, y0 + lb.y0, y0 + lb.y1, r.z0, r.z1, lb.surface, lb.colour, faces, ctx.indoor);
  }
  if (piece.solids) {
    for (const sb of piece.solids) {
      const r = rectOf(wall, s + sb.a0, sb.a1 - sb.a0, sb.d0, sb.d1);
      b.solid(r.x0, r.x1, y0 + sb.y0, y0 + sb.y1, r.z0, r.z1, piece.material);
    }
    return;
  }
  const r = rectOf(wall, s, piece.w, 0, piece.d);
  // A stove's pipe is not part of the solid piece; its body is.
  const h = piece.name === "stove" ? 0.86 : piece.h;
  b.solid(r.x0, r.x1, y0, y0 + h, r.z0, r.z1, piece.material);
}
