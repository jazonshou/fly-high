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
}

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

function box(a0: number, a1: number, d0: number, d1: number, y0: number, y1: number, surface: StructureSurface, colour: number): LocalBox {
  return { a0, a1, d0, d1, y0, y1, surface, colour };
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

function shelves(w: number, h: number, timber: number): Piece {
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
  return { name: "shelves", w, d, h, material: "timber", low: false, boxes };
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

function sofa(w: number, fabric: number): Piece {
  return {
    name: "sofa", w, d: 0.85, h: 0.82, material: "timber", low: true,
    boxes: [
      box(0, w, 0.18, 0.85, 0, 0.44, "fabric", fabric),
      box(0, w, 0, 0.2, 0, 0.82, "fabric", shade(fabric, 0.88)),
      box(0, 0.16, 0.2, 0.85, 0.44, 0.62, "fabric", shade(fabric, 0.94)),
      box(w - 0.16, w, 0.2, 0.85, 0.44, 0.62, "fabric", shade(fabric, 0.94)),
    ],
  };
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
  switch (room.kind) {
    case "living":
      return [
        ...(cold ? [stove(0x222222, ceiling)] : []),
        sofa(Math.min(2.0, long - 1.6), f[0]!),
        ...(short >= 3.2 ? [table(1.0, 0.55, timber)] : []),
        shelves(1.0, 1.9, timber),
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
      return [table(Math.min(1.6, long - 1.8), 0.9, timber), bench(1.4, timber), shelves(1.1, 1.8, dark)];
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
        shelves(0.9, 1.7, dark),
      ];
    case "bunk":
      return [bunk(timber, f[0]!, f[2]!), bunk(timber, f[1]!, f[0]!), chest(0.8, dark)];
    case "steam":
      return [saunaBenches(Math.min(2.4, long - 0.2), timber), saunaStove()];
    case "changing":
      return [bench(Math.min(1.4, long - 0.4), timber), shelves(0.6, 1.6, timber)];
    case "office":
      return [desk(timber), shelves(1.2, 1.9, dark), table(1.0, 0.6, timber), chest(0.9, dark)];
    case "barn": {
      const n = Math.max(2, Math.min(6, Math.floor((long - 3.4) / 1.8)));
      return [stallRow(n, Math.min(2.6, short * 0.32), dark), hay(dark), workbench(1.6, timber)];
    }
    case "tack":
      return [shelves(1.0, 1.7, dark), bench(1.2, timber), chest(0.9, dark)];
    case "workshop":
      return ctx.variant === "workshop-store"
        ? [shelves(1.6, 1.9, dark), workbench(Math.min(2.2, long - 1.2), timber), crates(dark)]
        : [workbench(Math.min(2.2, long - 1.2), timber), shelves(1.2, 1.9, dark), crates(dark)];
    case "store":
      return ctx.variant === "store-aisle"
        ? [shelves(Math.min(2.0, long - 1.2), 1.9, dark), shelves(Math.min(2.0, long - 1.2), 1.9, dark), crates(timber)]
        : [shelves(Math.min(1.6, long - 1.4), 1.9, dark), crates(timber), shelves(1.0, 1.9, dark), crates(shade(timber, 0.9))];
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

/** Place a room's furniture and draw it; returns the footprints placed. */
export function furnishRoom(b: KitBuilder, ctx: RoomContext): PlanRect[] {
  const room = ctx.room;
  const placed: PlanRect[] = [];
  const walls = roomWalls(room);
  const pieces = catalogue(ctx);
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
        done = true;
      }
      if (done) break;
    }
  });
  return placed;
}

function drawPiece(b: KitBuilder, ctx: RoomContext, wall: Wall, s: number, piece: Piece): void {
  const y0 = ctx.floor;
  // The face against the wall and the bottom are hidden.
  const back = wall.normal === "z" ? (wall.inward > 0 ? FACE.nz : FACE.pz) : (wall.inward > 0 ? FACE.nx : FACE.px);
  for (const lb of piece.boxes) {
    const r = rectOf(wall, s + lb.a0, lb.a1 - lb.a0, lb.d0, lb.d1);
    let faces = FACE.all & ~FACE.ny;
    if (lb.d0 <= 1e-6) faces &= ~back;
    if (lb.y0 > 1e-6) faces |= FACE.ny;
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
