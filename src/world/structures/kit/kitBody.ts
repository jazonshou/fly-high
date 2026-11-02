import type { StructureRecord } from "../structureRecord";
import type { StructureColliderMaterial, StructureInteriorVolume, StructurePortal, StructureSurface, StructureWindowLight } from "../structureModel";
import {
  STRUCTURE_DOOR_HEIGHT,
  STRUCTURE_RAILING_HEIGHT,
  STRUCTURE_STAIR_RISE,
  STRUCTURE_STAIR_TREAD,
  structureEnvelope,
  structurePorchDepth,
  structureStepCount,
  structureStepsStart,
} from "../structureEnvelope";
import { type KitBuilder, FACE, type Vec3, beam, shade } from "./kitBuilder";
import { furnishRoom, type PlanRect, type WallSpan } from "./kitFurniture";
import { structureIndoorLight } from "./kitIndoorLight";
import {
  type FloorPlan,
  FLOOR_STRUCTURE,
  type PlanDoor,
  type PlanRoom,
  type RoomKind,
  PARTITION_THICKNESS,
  STAIR_LANDING,
  STAIR_TREADS,
  STOREY_HEIGHT,
  TOP_CEILING_THICKNESS,
  type WallSide,
  floorPlan,
  roomsAlong,
} from "./kitPlan";
import { KitChannel, KitRandom } from "./kitRandom";
import { drawRoof, type RoofGeometry, type RoofSpec, roofGeometry } from "./kitRoof";
import type { StructureLook, WallCladding } from "./kitStyles";

/**
 * Walled buildings: houses, cottages, cabins, saunas, barns, sheds,
 * stations and stores. One body, one roof, a foundation, a porch and steps,
 * windows and doors with their trims; in the open level, real openings with
 * glass and every room inside (floors, ceilings, partitions, stairs,
 * railings, furniture, door leaves standing open), and the colliders,
 * rooms, portals and lit windows the walker and the night lights read.
 */

/** Window and door casings: width, and how far they stand proud of the wall. */
const CASING = 0.1;
const CASING_PROUD = 0.03;
/** Window glass: its plane's depth inside the outer face, and its thickness. */
const GLASS_DEPTH = 0.06;
const GLASS_THICKNESS = 0.012;
/** The wall's foot below the floor, where the sill beam and joists are (a plinth shows below it). */
const FLOOR_DEPTH = 0.25;

interface Opening {
  readonly side: WallSide;
  readonly storey: number;
  readonly s0: number;
  readonly s1: number;
  /** Building-frame heights. */
  readonly y0: number;
  readonly y1: number;
  readonly kind: "window" | "door" | "barn";
  readonly room: number;
}

interface OuterWall {
  readonly side: WallSide;
  readonly normal: "x" | "z";
  readonly out: 1 | -1;
  readonly inner: number;
  readonly outer: number;
  readonly s0: number;
  readonly s1: number;
}

function outerWalls(hw: number, hd: number, t: number): OuterWall[] {
  return [
    { side: "front", normal: "z", out: 1, inner: hd - t, outer: hd, s0: -hw, s1: hw },
    { side: "back", normal: "z", out: -1, inner: -hd + t, outer: -hd, s0: -hw, s1: hw },
    { side: "left", normal: "x", out: -1, inner: -hw + t, outer: -hw, s0: -hd + t, s1: hd - t },
    { side: "right", normal: "x", out: 1, inner: hw - t, outer: hw, s0: -hd + t, s1: hd - t },
  ];
}

/** Face bits of a wall-aligned box: out, in, the run's low and high ends. */
function wallFaces(normal: "x" | "z", out: 1 | -1) {
  if (normal === "z") return { out: out > 0 ? FACE.pz : FACE.nz, in: out > 0 ? FACE.nz : FACE.pz, lo: FACE.nx, hi: FACE.px };
  return { out: out > 0 ? FACE.px : FACE.nx, in: out > 0 ? FACE.nx : FACE.px, lo: FACE.nz, hi: FACE.pz };
}

/** A box aligned to a wall: run [a, b], y, and the wall-normal coordinate range [n0, n1] in any order. */
function wallBox(
  b: KitBuilder, normal: "x" | "z", a: number, c: number, y0: number, y1: number, n0: number, n1: number,
  surface: StructureSurface, colour: number, faces: number, indoor = 0,
): void {
  const lo = Math.min(n0, n1);
  const hi = Math.max(n0, n1);
  if (normal === "z") b.box(a, c, y0, y1, lo, hi, surface, colour, faces, indoor);
  else b.box(lo, hi, y0, y1, a, c, surface, colour, faces, indoor);
}

function wallSolid(b: KitBuilder, normal: "x" | "z", a: number, c: number, y0: number, y1: number, n0: number, n1: number, material: StructureColliderMaterial): void {
  const lo = Math.min(n0, n1);
  const hi = Math.max(n0, n1);
  if (normal === "z") b.solid(a, c, y0, y1, lo, hi, material);
  else b.solid(lo, hi, y0, y1, a, c, material);
}

/** A point on a wall: run coordinate s, height y, normal coordinate n. */
function wallPoint(normal: "x" | "z", s: number, y: number, n: number): Vec3 {
  return normal === "z" ? [s, y, n] : [n, y, s];
}

export interface Piece {
  readonly a: number;
  readonly c: number;
  readonly y0: number;
  readonly y1: number;
  /** Reveal faces: an opening against the low end, the high end, below (the piece is a head) or above (a sill). */
  readonly lo: boolean;
  readonly hi: boolean;
  readonly bottom: boolean;
  readonly top: boolean;
}

/** Cut a wall's rectangle round its openings, also at `cuts` along the run. */
export function decompose(s0: number, s1: number, y0: number, y1: number, holes: readonly { s0: number; s1: number; y0: number; y1: number }[], cuts: readonly number[]): Piece[] {
  const xs = new Set<number>([s0, s1]);
  for (const h of holes) {
    xs.add(Math.max(s0, Math.min(s1, h.s0)));
    xs.add(Math.max(s0, Math.min(s1, h.s1)));
  }
  for (const c of cuts) if (c > s0 + 1e-6 && c < s1 - 1e-6) xs.add(c);
  const sorted = [...xs].sort((a, b) => a - b);
  const out: Piece[] = [];
  const eps = 1e-6;
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const a = sorted[i]!;
    const c = sorted[i + 1]!;
    if (c - a < 1e-5) continue;
    const mid = (a + c) * 0.5;
    const here = holes.filter((h) => h.s0 < mid && h.s1 > mid && h.y1 > y0 && h.y0 < y1).sort((p, q) => p.y0 - q.y0);
    const ys: [number, number][] = [];
    let at = y0;
    for (const h of here) {
      if (h.y0 > at + eps) ys.push([at, Math.min(h.y0, y1)]);
      at = Math.max(at, h.y1);
    }
    if (at < y1 - eps) ys.push([at, y1]);
    for (const [ya, yb] of ys) {
      const overlapsY = (h: { y0: number; y1: number }) => h.y0 < yb - eps && h.y1 > ya + eps;
      out.push({
        a, c, y0: ya, y1: yb,
        lo: holes.some((h) => Math.abs(h.s1 - a) < eps && overlapsY(h)),
        hi: holes.some((h) => Math.abs(h.s0 - c) < eps && overlapsY(h)),
        bottom: here.some((h) => Math.abs(h.y1 - ya) < eps),
        top: here.some((h) => Math.abs(h.y0 - yb) < eps),
      });
    }
  }
  return out;
}

function claddingSurface(c: WallCladding): StructureSurface {
  return c;
}

function claddingMaterial(c: WallCladding): StructureColliderMaterial {
  return c === "stone" || c === "render" ? "stone" : c === "metal" ? "metal" : "timber";
}

function wallThickness(c: WallCladding): number {
  return c === "logs" ? 0.26 : c === "stone" || c === "render" ? 0.3 : c === "metal" ? 0.16 : 0.2;
}

export interface WalledFrame {
  readonly W: number;
  readonly D: number;
  readonly hw: number;
  readonly hd: number;
  readonly t: number;
  readonly storeys: number;
  readonly eaveY: number;
  readonly foot: number;
  readonly entryRel: number;
  readonly baseRel: number;
  readonly roof: RoofSpec;
  readonly geometry: RoofGeometry;
  readonly plan: FloorPlan;
}

function storeyFloor(k: number): number {
  return k * STOREY_HEIGHT;
}

/** The top of a storey's rooms. */
function storeyCeiling(frame: Pick<WalledFrame, "storeys" | "eaveY">, k: number): number {
  return k < frame.storeys - 1 ? storeyFloor(k) + STOREY_HEIGHT - FLOOR_STRUCTURE : frame.eaveY - TOP_CEILING_THICKNESS;
}

/** The walled building's frame: sizes, storeys, eave line, roof and plan. Pure; shared by every level. */
export function walledFrame(record: StructureRecord, look: StructureLook): WalledFrame {
  const W = record.width;
  const D = record.depth;
  const hw = W * 0.5;
  const hd = D * 0.5;
  const t = Math.max(wallThickness(look.wall), wallThickness(look.groundWall));
  const storeys = record.archetype === "house" ? Math.max(1, Math.min(2, record.storeys)) : 1;
  const topCeiling = record.archetype === "barn" ? 4.0 : record.archetype === "sauna" ? 2.5 : storeys >= 2 ? STOREY_HEIGHT - FLOOR_STRUCTURE : 2.62;
  const eaveY = storeyFloor(storeys - 1) + topCeiling + TOP_CEILING_THICKNESS;
  const entryRel = record.entryY - record.floorY;
  const baseRel = record.baseY - record.floorY;
  const foot = look.foundation === "plinth" ? Math.min(-0.12, Math.max(-FLOOR_DEPTH, entryRel + 0.15)) : -FLOOR_DEPTH;
  const rng = new KitRandom(record.seed);
  const small = record.archetype === "cabin" || record.archetype === "sauna" || record.archetype === "shed" || record.archetype === "store";
  const ridge: "x" | "z" = look.roofForm === "gable" && small && rng.chance(KitChannel.ridge, 0.4) ? "z" : W >= D ? "x" : "z";
  const roof: RoofSpec = {
    form: look.roofForm,
    ridge,
    halfW: hw,
    halfD: hd,
    pitch: look.pitch,
    rake: 0.42,
    eaveY,
    covering: look.roof,
    colour: look.roofColour,
    trimColour: look.trimColour,
    soffitColour: shade(look.timberColour, 1.25),
    gableSurface: claddingSurface(look.wall),
    gableColour: look.wallColour,
  };
  const geometry = roofGeometry(roof);
  const plan = floorPlan(record.archetype, storeys, { x0: -hw + t, x1: hw - t, z0: -hd + t, z1: hd - t }, record.seed);
  if (!plan) throw new Error(`no floor plan for ${record.archetype}`);
  return { W, D, hw, hd, t, storeys, eaveY, foot, entryRel, baseRel, roof, geometry, plan };
}

/** Window size and sill for an archetype in this look. */
function windowSize(record: StructureRecord, look: StructureLook): { w: number; h: number; sill: number } {
  switch (record.archetype) {
    case "barn":
      return { w: 0.9, h: 0.6, sill: 1.9 };
    case "shed":
    case "store":
      return { w: 0.8, h: 0.8, sill: 1.2 };
    case "sauna":
      return { w: 0.6, h: 0.5, sill: 1.3 };
    default:
      return { w: look.windowWidth, h: look.windowHeight, sill: look.windowSill };
  }
}

/** How many windows a room puts in one of its walls at most. */
function windowsPerWall(room: PlanRoom, length: number): number {
  switch (room.kind) {
    case "living":
    case "dining":
    case "main":
    case "office":
      return length > 4.5 ? 2 : 1;
    case "bedroom":
      return length > 5.0 ? 2 : 1;
    case "barn":
      return Math.max(1, Math.floor(length / 3.5));
    case "workshop":
      return length > 5 ? 2 : 1;
    default:
      return 1;
  }
}

/** Every opening in the outer walls: the front door and the windows, room by room. */
function placeOpenings(record: StructureRecord, look: StructureLook, frame: WalledFrame): Opening[] {
  const { plan, hw, hd, t } = frame;
  const out: Opening[] = [];
  const door = plan.frontDoor;
  out.push({
    side: "front", storey: 0, s0: door.s - door.width * 0.5, s1: door.s + door.width * 0.5, y0: 0, y1: door.height,
    kind: record.archetype === "barn" ? "barn" : "door", room: door.to,
  });
  const win = windowSize(record, look);
  const shutterW = look.shutters ? win.w * 0.5 : 0;
  const unit = win.w + 2 * CASING + 2 * shutterW;
  const doorKeep = (side: WallSide, storey: number) => {
    if (side !== "front" || storey !== 0) return null;
    const leaf = record.archetype === "barn" ? door.width * 0.5 + 0.1 : CASING + 0.2;
    return [door.s - door.width * 0.5 - leaf, door.s + door.width * 0.5 + leaf] as const;
  };
  for (const wall of outerWalls(hw, hd, t)) {
    for (let k = 0; k < frame.storeys; k += 1) {
      const sill = storeyFloor(k) + win.sill;
      const along = roomsAlong(plan, k, wall.normal, wall.inner, (-wall.out) as 1 | -1, wall.s0 + (wall.normal === "z" ? t : 0), wall.s1 - (wall.normal === "z" ? t : 0));
      for (const { room, lo, hi } of along) {
        if (room.kind === "steam" && wall.side === "front") continue;
        if (record.archetype === "barn" && wall.side === "front") continue;
        // Hall walls beside a stair get no windows (the stair runs along the partition, not here, but its well does upstairs).
        const margin = 0.3;
        let segments: [number, number][] = [[lo + margin, hi - margin]];
        const keep = doorKeep(wall.side, k);
        if (keep) segments = segments.flatMap(([a, c]) => cutOut(a, c, keep[0], keep[1]));
        let budget = windowsPerWall(room, hi - lo);
        if ((room.kind === "hall" || room.kind === "corridor") && keep && segments.length > 0 && wall.side === "front") budget = 0;
        for (const [a, c] of segments) {
          if (budget <= 0) break;
          const len = c - a;
          const gap = 0.6;
          const count = Math.min(budget, Math.floor((len + gap) / (unit + gap)));
          if (count <= 0) continue;
          budget -= count;
          const spacing = len / count;
          for (let i = 0; i < count; i += 1) {
            const centre = a + spacing * (i + 0.5);
            out.push({ side: wall.side, storey: k, s0: centre - win.w * 0.5, s1: centre + win.w * 0.5, y0: sill, y1: sill + win.h, kind: "window", room: room.id });
          }
        }
      }
    }
  }
  return out;
}

function cutOut(a: number, c: number, k0: number, k1: number): [number, number][] {
  if (k1 <= a || k0 >= c) return [[a, c]];
  const out: [number, number][] = [];
  if (k0 > a) out.push([a, k0]);
  if (k1 < c) out.push([k1, c]);
  return out;
}

interface DrawContext {
  readonly b: KitBuilder;
  readonly record: StructureRecord;
  readonly look: StructureLook;
  readonly frame: WalledFrame;
  readonly openings: readonly Opening[];
  readonly walls: readonly OuterWall[];
  /** Room id to its indoor factor (open level). */
  readonly indoor: (room: number) => number;
}

/** Build a walled building at the builder's level. */
export function buildWalled(b: KitBuilder, record: StructureRecord, look: StructureLook): void {
  const frame = walledFrame(record, look);
  const openings = placeOpenings(record, look, frame);
  const walls = outerWalls(frame.hw, frame.hd, frame.t);
  let indoor: (room: number) => number = () => 0;
  if (b.open) {
    // The rooms, doors and windows first: the indoor light needs them before any part is painted.
    recordLayout(b, record, frame, openings, walls);
    const light = structureIndoorLight({ colliders: [], volumes: b.volumes, portals: b.portals, windows: b.windows });
    const byRoom = new Map<number, StructureInteriorVolume>();
    frame.plan.rooms.forEach((room, i) => byRoom.set(room.id, b.volumes[i]!));
    indoor = (room) => {
      const v = byRoom.get(room);
      return v ? Math.max(0.05, light.roomMean(v)) : 0.3;
    };
  }
  const ctx: DrawContext = { b, record, look, frame, openings, walls, indoor };
  drawFoundation(ctx);
  drawWalls(ctx);
  drawRoof(b, frame.roof);
  if (!b.block) {
    drawOpeningTrims(ctx);
    drawAtticWindows(ctx);
  }
  drawPorchAndSteps(ctx);
  drawChimney(ctx);
  if (b.open) drawInterior(ctx);
  // The roof is one solid from its eave line up, over the overhangs.
  const g = frame.geometry;
  b.solid(-g.planHalfX, g.planHalfX, frame.eaveY, g.topY, -g.planHalfZ, g.planHalfZ, look.roof === "metal" ? "metal" : "timber");
}

/** Rooms, stairwells, portals and window lights (open level). */
function recordLayout(b: KitBuilder, record: StructureRecord, frame: WalledFrame, openings: readonly Opening[], walls: readonly OuterWall[]): void {
  const { plan } = frame;
  for (const room of plan.rooms) {
    b.volume(room.name, room.x0, room.x1, storeyFloor(room.storey), storeyCeiling(frame, room.storey), room.z0, room.z1);
  }
  for (const st of plan.stairs) {
    b.volume(`stairwell ${st.storey + 1}`, st.x0, st.x1, storeyFloor(st.storey), storeyCeiling(frame, st.storey + 1), Math.min(st.zFoot, st.zTop), Math.max(st.zFoot, st.zTop));
  }
  for (const door of plan.doors) b.portal(portalOf(plan, frame, door));
  for (const o of openings) {
    if (o.kind !== "window") continue;
    const wall = walls.find((w) => w.side === o.side)!;
    const c = wallPoint(wall.normal, (o.s0 + o.s1) * 0.5, (o.y0 + o.y1) * 0.5, wall.outer);
    const light: StructureWindowLight = {
      x: c[0], y: c[1], z: c[2],
      nx: wall.normal === "x" ? wall.out : 0,
      nz: wall.normal === "z" ? wall.out : 0,
      width: o.s1 - o.s0,
      height: o.y1 - o.y0,
    };
    b.windowLight(light);
  }
  void record;
}

function portalOf(plan: FloorPlan, frame: WalledFrame, door: PlanDoor): StructurePortal {
  const y = storeyFloor(door.storey);
  if (door.side) {
    // Outside doors are on the front wall.
    return { x: door.s, y, z: frame.hd - frame.t * 0.5, nx: 0, nz: 1, width: door.width, height: door.height, open: true, outside: true };
  }
  const part = plan.partitions[door.partition!]!;
  const from = plan.rooms[door.from]!;
  if (part.normal === "x") {
    const way = from.x0 > part.at ? 1 : -1;
    return { x: part.at, y, z: door.s, nx: way, nz: 0, width: door.width, height: door.height, open: true, outside: false };
  }
  const way = from.z0 > part.at ? 1 : -1;
  return { x: door.s, y, z: part.at, nx: 0, nz: way, width: door.width, height: door.height, open: true, outside: false };
}

// --- Foundation ----------------------------------------------------------------------------

function drawFoundation(ctx: DrawContext): void {
  const { b, look, frame } = ctx;
  const { hw, hd, foot, baseRel, entryRel } = frame;
  const surface = look.plinthSurface;
  const colour = look.plinthColour;
  const material: StructureColliderMaterial = surface === "timber" ? "timber" : "stone";
  if (b.block) {
    if (look.foundation === "posts" || look.foundation === "stumps") {
      // Far away, the dark under the house reads as a band.
      b.box(-hw + 0.15, hw - 0.15, Math.max(baseRel, entryRel - 0.1), foot, -hd + 0.15, hd - 0.15, "timber", shade(colour, 0.6), FACE.sides);
    } else {
      b.box(-hw - 0.03, hw + 0.03, baseRel, foot, -hd - 0.03, hd + 0.03, surface, colour, FACE.sides);
    }
    return;
  }
  switch (look.foundation) {
    case "plinth": {
      b.box(-hw - 0.04, hw + 0.04, baseRel, foot, -hd - 0.04, hd + 0.04, surface, colour, FACE.all & ~FACE.ny);
      b.solid(-hw - 0.04, hw + 0.04, baseRel, foot, -hd - 0.04, hd + 0.04, material);
      break;
    }
    case "piers": {
      // Stone piers at the corners and every 3 m; a dark skirt between them, set back.
      const pier = 0.5;
      const xs = spread(-hw + pier * 0.5, hw - pier * 0.5, 3.0);
      const zs = spread(-hd + pier * 0.5, hd - pier * 0.5, 3.0);
      const seen = new Set<string>();
      const put = (x: number, z: number) => {
        const key = `${x.toFixed(3)},${z.toFixed(3)}`;
        if (seen.has(key)) return;
        seen.add(key);
        b.box(x - pier * 0.5 - 0.03, x + pier * 0.5 + 0.03, baseRel, foot, z - pier * 0.5 - 0.03, z + pier * 0.5 + 0.03, surface, colour, FACE.all & ~FACE.ny);
        b.solid(x - pier * 0.5, x + pier * 0.5, baseRel, foot, z - pier * 0.5, z + pier * 0.5, material);
      };
      for (const x of xs) {
        put(x, -hd + pier * 0.5);
        put(x, hd - pier * 0.5);
      }
      for (const z of zs) {
        put(-hw + pier * 0.5, z);
        put(hw - pier * 0.5, z);
      }
      const inset = 0.12;
      b.box(-hw + inset, hw - inset, Math.min(foot - 0.05, entryRel - 0.1), foot, -hd + inset, hd - inset, "boards", shade(look.timberColour, 0.55), FACE.sides);
      b.solid(-hw + inset, hw - inset, Math.min(foot - 0.1, entryRel - 0.1), foot, -hd + inset, hd - inset, "timber");
      break;
    }
    case "stumps":
    case "posts": {
      const size = look.foundation === "posts" ? 0.2 : 0.18;
      const xs = spread(-hw + size, hw - size, 2.4);
      const zs = spread(-hd + size, hd - size, 2.4);
      for (const x of xs) {
        for (const z of zs) {
          b.box(x - size * 0.5, x + size * 0.5, baseRel, foot, z - size * 0.5, z + size * 0.5, "timber", colour, FACE.sides);
          b.capsule([x, baseRel, z], [x, foot, z], size * 0.5, "timber");
        }
      }
      // The floor's underside, seen between the posts; a sill beam round it.
      polygonDown(b, -hw, hw, -hd, hd, foot, "timber", shade(look.timberColour, 0.9));
      const beamH = 0.2;
      b.box(-hw + 0.04, hw - 0.04, foot - beamH, foot, -hd + 0.04, hd - 0.04, "timber", shade(colour, 1.1), FACE.sides | FACE.ny);
      b.solid(-hw + 0.04, hw - 0.04, foot - beamH, foot, -hd + 0.04, hd - 0.04, "timber");
      break;
    }
  }
}

/** Evenly spaced positions from a to c, no more than `step` apart. */
export function spread(a: number, c: number, step: number): number[] {
  const n = Math.max(1, Math.ceil((c - a) / step));
  const out: number[] = [];
  for (let i = 0; i <= n; i += 1) out.push(a + ((c - a) * i) / n);
  return out;
}

/** A horizontal rectangle facing down. */
export function polygonDown(b: KitBuilder, x0: number, x1: number, z0: number, z1: number, y: number, surface: StructureSurface, colour: number, indoor = 0): void {
  // Counter-clockwise seen from below (looking up +y): x0z0, x0z1, x1z1, x1z0.
  b.polygon([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1], surface, colour, indoor);
}

// --- Walls ---------------------------------------------------------------------------------

function bandsOf(frame: WalledFrame): { y0: number; y1: number; storey: number }[] {
  const out: { y0: number; y1: number; storey: number }[] = [];
  for (let k = 0; k < frame.storeys; k += 1) {
    out.push({
      y0: k === 0 ? frame.foot : storeyFloor(k),
      y1: k === frame.storeys - 1 ? frame.geometry.wallTop : storeyFloor(k + 1),
      storey: k,
    });
  }
  return out;
}

function claddingOf(look: StructureLook, storey: number): { surface: StructureSurface; colour: number; cladding: WallCladding } {
  if (storey === 0 && look.groundWall !== look.wall) return { surface: claddingSurface(look.groundWall), colour: look.groundWallColour, cladding: look.groundWall };
  return { surface: claddingSurface(look.wall), colour: look.wallColour, cladding: look.wall };
}

function drawWalls(ctx: DrawContext): void {
  const { b, look, frame } = ctx;
  const { hw, hd } = frame;
  const bands = bandsOf(frame);
  if (!b.open) {
    // One box per band: the closed shell has no inside.
    const chalet = look.groundWall !== look.wall;
    if (chalet || bands.length === 1) {
      for (const band of bands) {
        const c = claddingOf(look, band.storey);
        b.box(-hw, hw, band.y0, band.y1, -hd, hd, c.surface, c.colour, FACE.sides);
      }
    } else {
      const c = claddingOf(look, 0);
      b.box(-hw, hw, bands[0]!.y0, bands[bands.length - 1]!.y1, -hd, hd, c.surface, c.colour, FACE.sides);
    }
    if (!b.block) drawBelts(ctx);
    return;
  }
  for (const wall of ctx.walls) {
    const faces = wallFaces(wall.normal, wall.out);
    for (const band of bands) {
      const c = claddingOf(look, band.storey);
      const holes = ctx.openings.filter((o) => o.side === wall.side && o.storey === band.storey);
      const roomFloor = storeyFloor(band.storey);
      const roomTop = storeyCeiling(frame, band.storey);
      const along = roomsAlong(frame.plan, band.storey, wall.normal, wall.inner, (-wall.out) as 1 | -1, wall.s0, wall.s1);
      const cuts = along.flatMap((r) => [r.lo, r.hi]);
      const revealSurface: StructureSurface = c.cladding === "render" || c.cladding === "stone" ? c.surface : "trim";
      const revealColour = c.cladding === "render" || c.cladding === "stone" ? c.colour : look.trimColour;
      for (const piece of decompose(wall.s0, wall.s1, band.y0, band.y1, holes, cuts)) {
        // Outside: the outward face, and the run's ends where they are the building's corners (front and back walls).
        let outer = faces.out;
        if (wall.normal === "z" && Math.abs(piece.a - wall.s0) < 1e-6) outer |= faces.lo;
        if (wall.normal === "z" && Math.abs(piece.c - wall.s1) < 1e-6) outer |= faces.hi;
        wallBox(b, wall.normal, piece.a, piece.c, piece.y0, piece.y1, wall.inner, wall.outer, c.surface, c.colour, outer);
        const reveal = (piece.lo ? faces.lo : 0) | (piece.hi ? faces.hi : 0) | (piece.bottom ? FACE.ny : 0) | (piece.top ? FACE.py : 0);
        wallBox(b, wall.normal, piece.a, piece.c, piece.y0, piece.y1, wall.inner, wall.outer, revealSurface, revealColour, reveal);
        wallSolid(b, wall.normal, piece.a, piece.c, piece.y0, piece.y1, wall.inner, wall.outer, claddingMaterial(c.cladding));
        // Inside: the lining of the room behind this stretch, between its floor and ceiling.
        const mid = (piece.a + piece.c) * 0.5;
        const room = along.find((r) => mid > r.lo && mid < r.hi);
        const ly0 = Math.max(piece.y0, roomFloor);
        const ly1 = Math.min(piece.y1, roomTop);
        if (room && ly1 > ly0 + 1e-4) {
          const lining = liningOf(look, room.room);
          wallBox(b, wall.normal, piece.a, piece.c, ly0, ly1, wall.inner, wall.outer, lining.surface, lining.colour, faces.in, ctx.indoor(room.room.id));
        }
      }
    }
  }
  drawBelts(ctx);
}

const PAINTED_ROOMS: ReadonlySet<RoomKind> = new Set(["living", "kitchen", "dining", "bedroom", "main", "office"]);

function liningOf(look: StructureLook, room: PlanRoom): { surface: StructureSurface; colour: number } {
  if (room.kind === "barn" || room.kind === "workshop" || room.kind === "tack") {
    return { surface: look.wall === "metal" ? "boards" : look.wall === "render" ? "render" : "boards", colour: shade(look.timberColour, 1.3) };
  }
  if (room.kind === "steam" || room.kind === "changing") return { surface: "boards", colour: 0xc8a878 };
  if (room.kind === "store") return { surface: look.lining === "plaster" ? "boards" : look.lining, colour: shade(look.liningColour, 0.9) };
  // Painted rooms people live in take one of the building's room paints; halls and landings keep the plain lining.
  if (PAINTED_ROOMS.has(room.kind) && (look.lining === "plaster" || look.lining === "render")) {
    return { surface: look.lining, colour: look.roomPaints[room.id % look.roomPaints.length]! };
  }
  return { surface: look.lining, colour: look.liningColour };
}

/** Corner boards, a skirt board at the wall's foot and a belt between storeys (timber cladding only). */
function drawBelts(ctx: DrawContext): void {
  const { b, look, frame } = ctx;
  const { hw, hd, foot } = frame;
  const timber = look.wall === "clapboard" || look.wall === "boards";
  const top = frame.geometry.wallTop;
  const p = 0.035;
  const colour = look.trimColour;
  const chalet = look.groundWall !== look.wall;
  const cornerFrom = chalet ? STOREY_HEIGHT : foot;
  if (timber) {
    for (const sx of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        const x0 = sx > 0 ? hw - 0.12 : -hw - p;
        const x1 = sx > 0 ? hw + p : -hw + 0.12;
        const z0 = sz > 0 ? hd - 0.12 : -hd - p;
        const z1 = sz > 0 ? hd + p : -hd + 0.12;
        b.box(x0, x1, cornerFrom, top - 0.02, z0, z1, "trim", colour, (sx > 0 ? FACE.px : FACE.nx) | (sz > 0 ? FACE.pz : FACE.nz) | FACE.ny);
      }
    }
  }
  if (timber && !chalet) {
    // Skirt board just above the foot.
    b.box(-hw - p, hw + p, foot, foot + 0.2, -hd - p, hd + p, "trim", colour, FACE.sides | FACE.py);
  }
  if (frame.storeys >= 2 && (timber || chalet)) {
    const y = STOREY_HEIGHT;
    b.box(-hw - p, hw + p, y - 0.1, y + 0.06, -hd - p, hd + p, chalet ? "timber" : "trim", chalet ? shade(look.wallColour, 0.85) : colour, FACE.sides | FACE.py | FACE.ny);
  }
}

// --- Openings ------------------------------------------------------------------------------

function drawOpeningTrims(ctx: DrawContext): void {
  const { b, look } = ctx;
  for (const o of ctx.openings) {
    const wall = ctx.walls.find((w) => w.side === o.side)!;
    const f = wallFaces(wall.normal, wall.out);
    const out = wall.outer;
    const n = (d: number) => out + wall.out * d;
    const trim = look.trimColour;
    const ends = f.out | f.lo | f.hi | FACE.py | FACE.ny;
    if (o.kind === "barn") {
      // The big doors' frame and the two leaves standing open against the wall.
      wallBox(b, wall.normal, o.s0 - 0.16, o.s1 + 0.16, o.y1, o.y1 + 0.2, out, n(0.05), "timber", shade(look.timberColour, 0.9), ends);
      const leafW = (o.s1 - o.s0) * 0.5;
      const leafColour = look.wall === "metal" ? shade(look.wallColour, 0.9) : shade(look.wallColour, 0.92);
      for (const side of [-1, 1] as const) {
        const a = side < 0 ? o.s0 - 0.16 - leafW : o.s1 + 0.16;
        wallBox(b, wall.normal, a, a + leafW, 0.05, o.y1 - 0.02, n(0.01), n(0.07), "boards", leafColour, f.out | f.in | f.lo | f.hi | FACE.py);
        // A brace across each leaf, drawn in trim so the leaves read as doors.
        wallBox(b, wall.normal, a + 0.05, a + leafW - 0.05, o.y1 * 0.45, o.y1 * 0.45 + 0.14, n(0.07), n(0.1), "timber", trim, f.out | FACE.py | FACE.ny);
        b.solid(...solidArgs(wall.normal, a, a + leafW, 0.05, o.y1 - 0.02, n(0.0), n(0.1)), "timber");
      }
      if (b.closed) wallQuad(b, wall, o.s0, o.s1, o.y0, o.y1, 0.004, "doorway", look.doorwayColour);
      continue;
    }
    // Head, jambs, and for windows a sill.
    wallBox(b, wall.normal, o.s0 - CASING, o.s1 + CASING, o.y1, o.y1 + 0.13, out, n(CASING_PROUD + 0.01), "trim", trim, ends);
    wallBox(b, wall.normal, o.s0 - CASING, o.s0, o.y0, o.y1, out, n(CASING_PROUD), "trim", trim, f.out | f.lo);
    wallBox(b, wall.normal, o.s1, o.s1 + CASING, o.y0, o.y1, out, n(CASING_PROUD), "trim", trim, f.out | f.hi);
    if (o.kind === "window") {
      wallBox(b, wall.normal, o.s0 - CASING - 0.04, o.s1 + CASING + 0.04, o.y0 - 0.07, o.y0, out, n(0.07), "trim", shade(trim, 0.92), ends);
      if (look.shutters) {
        const sw = (o.s1 - o.s0) * 0.5;
        const shutter = look.doorColour === look.trimColour ? shade(look.trimColour, 0.7) : look.doorColour;
        wallBox(b, wall.normal, o.s0 - CASING - sw - 0.02, o.s0 - CASING - 0.02, o.y0 + 0.02, o.y1 - 0.02, out, n(0.045), "boards", shutter, ends);
        wallBox(b, wall.normal, o.s1 + CASING + 0.02, o.s1 + CASING + sw + 0.02, o.y0 + 0.02, o.y1 - 0.02, out, n(0.045), "boards", shutter, ends);
      }
      if (b.closed) wallQuad(b, wall, o.s0, o.s1, o.y0, o.y1, 0.004, "window", look.glazingColour);
      else drawSash(ctx, wall, o);
    } else if (b.closed) {
      wallQuad(b, wall, o.s0, o.s1, o.y0, o.y1, 0.004, "doorway", look.doorwayColour);
    }
  }
}

function solidArgs(normal: "x" | "z", a: number, c: number, y0: number, y1: number, n0: number, n1: number): [number, number, number, number, number, number] {
  const lo = Math.min(n0, n1);
  const hi = Math.max(n0, n1);
  return normal === "z" ? [a, c, y0, y1, lo, hi] : [lo, hi, y0, y1, a, c];
}

/** A flat rectangle on a wall's outer face, `proud` out from it, facing out. */
function wallQuad(b: KitBuilder, wall: OuterWall, s0: number, s1: number, y0: number, y1: number, proud: number, surface: StructureSurface, colour: number): void {
  const n = wall.outer + wall.out * proud;
  const p = (s: number, y: number) => wallPoint(wall.normal, s, y, n);
  const corners = [p(s0, y0), p(s1, y0), p(s1, y1), p(s0, y1)];
  const normal: Vec3 = wall.normal === "z" ? [0, 0, wall.out] : [wall.out, 0, 0];
  pushFacing(b, corners, normal, surface, colour);
}

export function pushFacing(b: KitBuilder, corners: Vec3[], normal: Vec3, surface: StructureSurface, colour: number, indoor = 0): void {
  const a = corners[0]!;
  const c1 = corners[1]!;
  const c2 = corners[2]!;
  const e1: Vec3 = [c1[0] - a[0], c1[1] - a[1], c1[2] - a[2]];
  const e2: Vec3 = [c2[0] - a[0], c2[1] - a[1], c2[2] - a[2]];
  const nx = e1[1] * e2[2] - e1[2] * e2[1];
  const ny = e1[2] * e2[0] - e1[0] * e2[2];
  const nz = e1[0] * e2[1] - e1[1] * e2[0];
  const ordered = nx * normal[0] + ny * normal[1] + nz * normal[2] >= 0 ? corners : [...corners].reverse();
  b.polygon(ordered.flatMap((p) => [p[0], p[1], p[2]]), surface, colour, indoor);
}

/** The open level's window: a sash frame and glazing bars in the opening, the glass, a stool inside. */
function drawSash(ctx: DrawContext, wall: OuterWall, o: Opening): void {
  const { b, look } = ctx;
  const f = wallFaces(wall.normal, wall.out);
  const n = (d: number) => wall.outer - wall.out * d;
  const g0 = n(GLASS_DEPTH - 0.025);
  const g1 = n(GLASS_DEPTH + 0.025);
  const fw = 0.06;
  const colour = look.trimColour === look.wallColour ? 0xeeebe2 : shade(look.trimColour, 1.0);
  const frameFaces = f.out | f.in;
  wallBox(b, wall.normal, o.s0, o.s1, o.y0, o.y0 + fw, g0, g1, "trim", colour, frameFaces | FACE.py);
  wallBox(b, wall.normal, o.s0, o.s1, o.y1 - fw, o.y1, g0, g1, "trim", colour, frameFaces | FACE.ny);
  wallBox(b, wall.normal, o.s0, o.s0 + fw, o.y0 + fw, o.y1 - fw, g0, g1, "trim", colour, frameFaces | f.hi);
  wallBox(b, wall.normal, o.s1 - fw, o.s1, o.y0 + fw, o.y1 - fw, g0, g1, "trim", colour, frameFaces | f.lo);
  // Glazing bars: a cross, as the closed shell's window layer paints it.
  const bar = 0.035;
  const ms = (o.s0 + o.s1) * 0.5;
  const my = o.y0 + (o.y1 - o.y0) * 0.55;
  const h0 = n(GLASS_DEPTH - 0.012);
  const h1 = n(GLASS_DEPTH + 0.012);
  wallBox(b, wall.normal, ms - bar * 0.5, ms + bar * 0.5, o.y0 + fw, o.y1 - fw, h0, h1, "trim", colour, f.out | f.in | f.lo | f.hi);
  wallBox(b, wall.normal, o.s0 + fw, ms - bar * 0.5, my - bar * 0.5, my + bar * 0.5, h0, h1, "trim", colour, f.out | f.in | FACE.py | FACE.ny);
  wallBox(b, wall.normal, ms + bar * 0.5, o.s1 - fw, my - bar * 0.5, my + bar * 0.5, h0, h1, "trim", colour, f.out | f.in | FACE.py | FACE.ny);
  // The glass: one thin box in the frame, the transparent mesh's.
  const gl0 = n(GLASS_DEPTH - GLASS_THICKNESS * 0.5);
  const gl1 = n(GLASS_DEPTH + GLASS_THICKNESS * 0.5);
  wallBox(b, wall.normal, o.s0 + fw, o.s1 - fw, o.y0 + fw, o.y1 - fw, gl0, gl1, "glass", 0x9fb4bc, f.out | f.in);
  b.solid(...solidArgs(wall.normal, o.s0, o.s1, o.y0, o.y1, gl0, gl1), "glass");
  // A stool inside under the window.
  const room = ctx.frame.plan.rooms[o.room];
  const ins = wall.inner;
  const stoolIn = ins - wall.out * 0.06;
  wallBox(b, wall.normal, o.s0 - 0.05, o.s1 + 0.05, o.y0 - 0.03, o.y0, ins, stoolIn, "trim", colour, f.in | FACE.py | FACE.ny | f.lo | f.hi, room ? ctx.indoor(room.id) : 0.3);
}

/** A small window in a tall gable, lighting the closed attic: decoration on every level but the block. */
function drawAtticWindows(ctx: DrawContext): void {
  const { b, look, frame, record } = ctx;
  if (frame.roof.form !== "gable") return;
  if (!(record.archetype === "house" || record.archetype === "cottage" || record.archetype === "barn" || record.archetype === "station")) return;
  const rise = frame.geometry.undersideAt(0) - frame.geometry.wallTop;
  if (rise < 1.5) return;
  const rng = new KitRandom(record.seed);
  if (!rng.chance(KitChannel.attic, record.archetype === "barn" ? 0.9 : 0.7)) return;
  const w = record.archetype === "barn" ? 1.2 : 0.6;
  const h = record.archetype === "barn" ? 1.0 : 0.8;
  const y0 = frame.geometry.wallTop + Math.min(0.35, rise * 0.2);
  const ends = frame.roof.ridge === "x" ? (["left", "right"] as const) : (["front", "back"] as const);
  for (const side of ends) {
    const wall = ctx.walls.find((x) => x.side === side)!;
    const span = frame.roof.ridge === "x" ? frame.hd : frame.hw;
    // On the wall's line through the ridge; the run of a gable wall is the other axis.
    const centre = 0;
    if (y0 + h > frame.geometry.undersideAt(w * 0.5 + CASING) - 0.15 || span < 1) continue;
    const f = wallFaces(wall.normal, wall.out);
    const out = wall.outer;
    const n = (d: number) => out + wall.out * d;
    const ends2 = f.out | f.lo | f.hi | FACE.py | FACE.ny;
    wallBox(b, wall.normal, centre - w * 0.5 - CASING, centre + w * 0.5 + CASING, y0 + h, y0 + h + 0.12, out, n(CASING_PROUD + 0.01), "trim", look.trimColour, ends2);
    wallBox(b, wall.normal, centre - w * 0.5 - CASING, centre - w * 0.5, y0, y0 + h, out, n(CASING_PROUD), "trim", look.trimColour, f.out | f.lo);
    wallBox(b, wall.normal, centre + w * 0.5, centre + w * 0.5 + CASING, y0, y0 + h, out, n(CASING_PROUD), "trim", look.trimColour, f.out | f.hi);
    wallBox(b, wall.normal, centre - w * 0.5 - CASING - 0.03, centre + w * 0.5 + CASING + 0.03, y0 - 0.06, y0, out, n(0.06), "trim", shade(look.trimColour, 0.92), ends2);
    wallQuad(b, wall, centre - w * 0.5, centre + w * 0.5, y0, y0 + h, 0.004, record.archetype === "barn" ? "doorway" : "window", record.archetype === "barn" ? look.doorwayColour : look.glazingColour);
  }
}

// --- Porch and steps -----------------------------------------------------------------------

function drawPorchAndSteps(ctx: DrawContext): void {
  const { b, look, frame, record } = ctx;
  const { hw, hd, entryRel, baseRel } = frame;
  const porch = structurePorchDepth(record.archetype, record.style);
  const door = frame.plan.frontDoor;
  const envelope = structureEnvelope(record);
  const steps = structureStepCount(record);
  const start = structureStepsStart(record);
  const big = record.archetype === "barn";
  const stepWidth = big ? door.width + 0.4 : look.verandah && porch > 0 ? 2.0 : door.width + 0.6;
  const sx0 = Math.max(-hw, door.s - stepWidth * 0.5);
  const sx1 = Math.min(hw, sx0 + stepWidth);
  const timberSteps = look.foundation === "posts" || look.foundation === "stumps" || porch > 0;
  const stepSurface: StructureSurface = timberSteps ? "timber" : look.plinthSurface === "timber" ? "timber" : look.plinthSurface;
  const stepColour = timberSteps ? shade(look.timberColour, 1.15) : look.plinthColour;
  const deckColour = shade(look.timberColour, 1.3);

  let px0 = sx0;
  let px1 = sx1;
  if (porch > 0) {
    const width = look.verandah ? 2 * hw : Math.min(2 * hw, Math.max(3.0, door.width + 2.6));
    px0 = look.verandah ? -hw : Math.max(-hw, Math.min(hw - width, door.s - width * 0.5));
    px1 = px0 + width;
    const z0 = hd;
    const z1 = hd + porch;
    const deckTop = 0;
    const deckBottom = -0.18;
    if (b.block) {
      b.box(px0, px1, Math.max(baseRel, entryRel - 0.1), deckTop, z0, z1, "floor", deckColour, FACE.py | FACE.pz | FACE.px | FACE.nx);
    } else {
      b.box(px0, px1, deckBottom, deckTop, z0, z1, "floor", deckColour, FACE.py | FACE.pz | FACE.px | FACE.nx | FACE.ny);
      b.solid(px0, px1, Math.min(deckBottom, -0.12 + entryRel * 0 - 0.1), deckTop, z0, z1, "timber");
      // What carries the deck: the plinth's stone, or posts like the house's.
      if (look.foundation === "plinth") {
        b.box(px0 + 0.03, px1 - 0.03, baseRel, deckBottom, z0, z1 - 0.06, look.plinthSurface, look.plinthColour, FACE.pz | FACE.px | FACE.nx | FACE.py);
        b.solid(px0 + 0.03, px1 - 0.03, baseRel, deckBottom, z0, z1 - 0.06, "stone");
      } else {
        const size = 0.18;
        for (const x of spread(px0 + size, px1 - size, 2.4)) {
          for (const z of [z1 - size, (z0 + z1) * 0.5]) {
            b.box(x - size * 0.5, x + size * 0.5, baseRel, deckBottom, z - size * 0.5, z + size * 0.5, "timber", look.plinthColour, FACE.sides);
            b.capsule([x, baseRel, z], [x, deckBottom, z], size * 0.5, "timber");
          }
        }
      }
    }
    drawPorchRoof(ctx, px0, px1, z1, sx0, sx1, envelope.maxZ, steps);
    if (!b.block && -entryRel > 0.45) drawPorchRailing(ctx, px0, px1, z0, z1, sx0, sx1);
  }

  if (b.block || steps <= 0) return;
  // Front steps from the porch's edge (or the wall) down to the ground in front.
  const rise = -entryRel / steps;
  const foot = entryRel - 0.2;
  for (let i = 1; i < steps; i += 1) {
    const z0 = start + (i - 1) * STRUCTURE_STAIR_TREAD;
    const z1 = start + i * STRUCTURE_STAIR_TREAD;
    const top = -i * rise;
    b.box(sx0, sx1, foot, top, z0, z1, stepSurface, stepColour, FACE.py | FACE.pz | FACE.px | FACE.nx);
    b.solid(sx0, sx1, foot, top, z0, z1, stepSurface === "timber" ? "timber" : "stone");
  }
  // A step from the wall itself (no porch) needs its threshold block.
  if (porch <= 0 && steps >= 1) {
    b.box(sx0, sx1, foot, 0, hd - 0.001, hd + 0.001, stepSurface, stepColour, 0);
  }
  if (steps >= 4) drawStepRails(ctx, sx0, sx1, start, steps, rise);
}

function drawPorchRoof(ctx: DrawContext, px0: number, px1: number, edgeZ: number, sx0: number, sx1: number, maxZ: number, steps: number): void {
  const { b, look, frame } = ctx;
  const { hd } = frame;
  const t = 0.12;
  const attach = frame.storeys >= 2 ? STOREY_HEIGHT + 0.45 : frame.eaveY - 0.06;
  const postZ = edgeZ - 0.12;
  // The roof's front edge: a little past the posts, never past the envelope.
  const front = Math.min(edgeZ + 0.18, maxZ - 0.02);
  // Pitch: as steep as headroom under it allows (2.15 m clear at the posts), 4 to 18 degrees.
  const run = postZ - hd;
  let tanP = Math.tan((frame.storeys >= 2 ? 16 : 12) * Math.PI / 180);
  const minClear = 2.15;
  const maxTan = (attach - t * 1.02 - minClear) / Math.max(0.5, run);
  tanP = Math.max(Math.tan(4 * Math.PI / 180), Math.min(tanP, maxTan));
  const pitch = Math.atan(tanP);
  const cos = Math.cos(pitch);
  const sin = Math.sin(pitch);
  const topAt = (z: number) => attach - (z - hd) * tanP;
  const underAt = (z: number) => topAt(z) - t / cos;
  const x0 = px0 - 0.15;
  const x1 = px1 + 0.15;
  if (b.block) {
    pushFacing(b, [[x0, topAt(hd), hd], [x1, topAt(hd), hd], [x1, topAt(front), front], [x0, topAt(front), front]], [0, 1, 0], look.roof, look.roofColour);
    return;
  }
  // The slab: its top in roofing, underside and edges in timber.
  const lenAlong = (front - hd) / cos;
  const dir: Vec3 = [0, -sin, cos];
  const nrm: Vec3 = [0, cos, sin];
  const topStart: Vec3 = [(x0 + x1) * 0.5, attach, hd];
  // Box: u along x, v the slab's normal, w down the slope. Its top surface starts at the wall at `attach`.
  const centre: Vec3 = [topStart[0], topStart[1] - nrm[1] * t * 0.5 + dir[1] * lenAlong * 0.5, topStart[2] - nrm[2] * t * 0.5 + dir[2] * lenAlong * 0.5];
  const u: Vec3 = [(x1 - x0) * 0.5, 0, 0];
  const v: Vec3 = [0, nrm[1] * t * 0.5, nrm[2] * t * 0.5];
  const w: Vec3 = [0, dir[1] * lenAlong * 0.5, dir[2] * lenAlong * 0.5];
  b.obox(centre, u, v, w, look.roof, look.roofColour, FACE.py);
  b.obox(centre, u, v, w, "timber", shade(look.timberColour, 1.25), FACE.ny | FACE.px | FACE.nx | FACE.pz);
  b.solidOriented(centre, u, v, w, look.roof === "metal" ? "metal" : "timber");
  // A beam along the posts, and the posts, clear of the steps.
  const beamTop = underAt(postZ + 0.07);
  const beamH = 0.18;
  b.box(px0, px1, beamTop - beamH, beamTop, postZ - 0.07, postZ + 0.07, "trim", look.trimColour, FACE.all & ~FACE.py);
  const posts = spread(px0 + 0.07, px1 - 0.07, 2.8).map((x) => {
    if (x > sx0 - 0.1 && x < sx1 + 0.1 && steps > 0) return x < (sx0 + sx1) * 0.5 ? sx0 - 0.1 : sx1 + 0.1;
    return x;
  }).filter((x) => x >= px0 + 0.07 - 1e-6 && x <= px1 - 0.07 + 1e-6);
  for (const x of posts) {
    b.box(x - 0.07, x + 0.07, 0, beamTop - beamH, postZ - 0.07, postZ + 0.07, "trim", look.trimColour, FACE.sides);
    b.capsule([x, 0, postZ], [x, beamTop - beamH, postZ], 0.07, "timber");
  }
  void steps;
}

function drawPorchRailing(ctx: DrawContext, px0: number, px1: number, z0: number, z1: number, sx0: number, sx1: number): void {
  const { b, look } = ctx;
  const h = STRUCTURE_RAILING_HEIGHT;
  const rz = z1 - 0.12;
  const runs: { a: Vec3; c: Vec3 }[] = [];
  if (sx0 - px0 > 0.3) runs.push({ a: [px0 + 0.07, 0, rz], c: [sx0 - 0.1, 0, rz] });
  if (px1 - sx1 > 0.3) runs.push({ a: [sx1 + 0.1, 0, rz], c: [px1 - 0.07, 0, rz] });
  runs.push({ a: [px0 + 0.07, 0, z0 + 0.05], c: [px0 + 0.07, 0, rz] });
  runs.push({ a: [px1 - 0.07, 0, z0 + 0.05], c: [px1 - 0.07, 0, rz] });
  for (const run of runs) railing(b, run.a, run.c, 0, h, look.trimColour, 0);
}

/** A railing between two points at floor height `y`: top rail at `h`, bottom rail, infill. */
export function railing(b: KitBuilder, a: Vec3, c: Vec3, y: number, h: number, colour: number, indoor: number, infill = true): void {
  const top0: Vec3 = [a[0], y + h - 0.045, a[2]];
  const top1: Vec3 = [c[0], y + h - 0.045, c[2]];
  beam(b, top0, top1, 0.09, "trim", colour, FACE.all, indoor, 0.08);
  const bot0: Vec3 = [a[0], y + 0.12, a[2]];
  const bot1: Vec3 = [c[0], y + 0.12, c[2]];
  beam(b, bot0, bot1, 0.06, "trim", colour, FACE.all & ~FACE.ny, indoor, 0.06);
  if (infill) {
    const m0: Vec3 = [a[0], y + (h - 0.09 + 0.15) * 0.5, a[2]];
    const m1: Vec3 = [c[0], y + (h - 0.09 + 0.15) * 0.5, c[2]];
    beam(b, m0, m1, h - 0.09 - 0.15, "boards", shade(colour, 0.95), FACE.px | FACE.nx, indoor, 0.025);
  }
  b.capsule(top0, top1, 0.05, "fence");
}

function drawStepRails(ctx: DrawContext, sx0: number, sx1: number, start: number, steps: number, rise: number): void {
  const { b, look } = ctx;
  const z0 = start;
  const z1 = start + (steps - 1) * STRUCTURE_STAIR_TREAD;
  const h = STRUCTURE_RAILING_HEIGHT;
  for (const x of [sx0 + 0.05, sx1 - 0.05]) {
    const top: Vec3 = [x, h - 0.045, z0];
    const bottom: Vec3 = [x, -steps * rise + h - 0.045 + rise, z1];
    beam(b, top, bottom, 0.08, "trim", look.trimColour, FACE.all, 0, 0.07);
    b.box(x - 0.05, x + 0.05, -steps * rise + rise - 0.2, -steps * rise + rise + h, z1 - 0.05, z1 + 0.05, "trim", look.trimColour, FACE.all & ~FACE.ny);
    b.capsule(top, bottom, 0.05, "fence");
    b.solid(x - 0.05, x + 0.05, -steps * rise + rise - 0.2, -steps * rise + rise + h, z1 - 0.05, z1 + 0.05, "timber");
  }
}

// --- Chimney -------------------------------------------------------------------------------

function drawChimney(ctx: DrawContext): void {
  const { b, look, frame, record } = ctx;
  if (look.chimney === "none") return;
  const g = frame.geometry;
  const rng = new KitRandom(record.seed);
  const along = frame.roof.ridge === "x" ? frame.hw : frame.hd;
  const across = frame.roof.ridge === "x" ? frame.hd : frame.hw;
  // On a hip roof the ridge runs only between the hips: keep the stack on it.
  const reach = frame.roof.form === "hip" ? Math.min(along - 1.1, along - across - 0.35) : along - 1.1;
  const sign = rng.chance(KitChannel.chimney, 0.5, 9) ? 1 : -1;
  const offset = sign * Math.max(0, reach);
  if (look.chimney === "masonry") {
    const cw = 0.62;
    const cd = 0.5;
    const top = g.ridgeY + 0.75;
    const bottom = g.wallTop - 0.4;
    const [cx, cz] = frame.roof.ridge === "x" ? [offset, 0] : [0, offset];
    const [hx, hz] = frame.roof.ridge === "x" ? [cw * 0.5, cd * 0.5] : [cd * 0.5, cw * 0.5];
    // The flue: over the stack's cap.
    b.chimney({ x: cx, y: top + 0.2, z: cz });
    if (b.block) {
      b.box(cx - hx, cx + hx, g.ridgeY - 0.3, top, cz - hz, cz + hz, "stone", look.chimneyColour, FACE.all & ~FACE.ny);
      return;
    }
    b.box(cx - hx, cx + hx, bottom, top, cz - hz, cz + hz, record.style === "desert" ? "render" : "stone", look.chimneyColour, FACE.sides);
    b.box(cx - hx - 0.06, cx + hx + 0.06, top, top + 0.08, cz - hz - 0.06, cz + hz + 0.06, "concrete", 0x7a7670, FACE.all);
    b.box(cx - hx + 0.12, cx + hx - 0.12, top + 0.08, top + 0.2, cz - hz + 0.1, cz + hz - 0.1, "steel", 0x2a2a2a, FACE.all & ~FACE.ny);
    b.solid(cx - hx, cx + hx, frame.eaveY, top + 0.08, cz - hz, cz + hz, "stone");
    return;
  }
  // A stovepipe through one slope, near the ridge.
  const c = 0.6;
  const pipeAlong = sign * Math.max(0, frame.roof.form === "hip" ? Math.min((along - 1.1) * 0.6, along - across + c - 0.25) : (along - 1.1) * 0.6);
  const [px, pz] = frame.roof.ridge === "x" ? [pipeAlong, -c] : [-c, pipeAlong];
  const surf = g.surfaceAt(c);
  const size = b.block ? 0.25 : 0.16;
  b.chimney({ x: px, y: surf + 1.08, z: pz });
  b.box(px - size * 0.5, px + size * 0.5, surf - 0.15, surf + 1.0, pz - size * 0.5, pz + size * 0.5, "steel", look.chimneyColour, FACE.sides);
  if (!b.block) b.box(px - 0.14, px + 0.14, surf + 1.0, surf + 1.08, pz - 0.14, pz + 0.14, "steel", look.chimneyColour, FACE.all);
  b.capsule([px, surf, pz], [px, surf + 1.0, pz], 0.08, "metal");
}

// --- Interior ------------------------------------------------------------------------------

function drawInterior(ctx: DrawContext): void {
  const { b, look, frame, record } = ctx;
  const { plan, foot } = frame;
  const rng = new KitRandom(record.seed);
  const floorColour = look.floorColour;
  // Floors, ceilings, and the slabs between storeys (with their stair wells cut out).
  for (let k = 0; k < frame.storeys; k += 1) {
    const y = storeyFloor(k);
    const rooms = plan.rooms.filter((r) => r.storey === k);
    const wells = plan.stairs.filter((st) => st.storey === k - 1).map((st) => wellRect(st));
    for (const room of rooms) {
      for (const r of subtractRects(room, wells)) {
        b.box(r.x0, r.x1, y - 0.03, y, r.z0, r.z1, room.kind === "barn" || room.kind === "workshop" ? "concrete" : "floor",
          room.kind === "barn" || room.kind === "workshop" ? 0x8a857c : floorColour, FACE.py, ctx.indoor(room.id));
      }
    }
    // The floor's solid: on the ground floor down to the foot, upstairs the slab from the ceiling below.
    const slabBottom = k === 0 ? Math.min(foot, -0.15) : storeyCeiling(frame, k - 1);
    for (const r of subtractRects({ x0: plan.ix0, x1: plan.ix1, z0: plan.iz0, z1: plan.iz1 }, wells)) {
      b.solid(r.x0, r.x1, slabBottom, y, r.z0, r.z1, "timber");
    }
    // Ceilings: the slab's underside over each room, without the wells above.
    const top = storeyCeiling(frame, k);
    const wellsAbove = plan.stairs.filter((st) => st.storey === k).map((st) => wellRect(st));
    for (const room of rooms) {
      for (const r of subtractRects(room, wellsAbove)) {
        b.box(r.x0, r.x1, top, top + 0.03, r.z0, r.z1, look.ceiling, look.ceilingColour, FACE.ny, ctx.indoor(room.id));
      }
    }
    if (k === frame.storeys - 1) {
      b.solid(plan.ix0, plan.ix1, top, frame.eaveY, plan.iz0, plan.iz1, "timber");
    }
    // The wells' rims: the slab's edges round each well above this storey.
    for (const well of wellsAbove) {
      const hall = rooms.find((r) => r.x0 <= well.x0 + 1e-6 && r.x1 >= well.x1 - 1e-6) ?? rooms[0]!;
      b.box(well.x0, well.x1, top, storeyFloor(k + 1), well.z0, well.z1, look.ceiling, shade(look.ceilingColour, 0.95),
        FACE.px | FACE.nx | FACE.pz | FACE.nz, ctx.indoor(hall.id));
    }
  }
  drawPartitions(ctx);
  drawStairs(ctx);
  drawDoors(ctx);
  // Furniture last: it keeps clear of everything above.
  plan.rooms.forEach((room, index) => {
    const keepOut = keepOuts(ctx, room);
    const anchors = doorAnchors(ctx, room);
    const windows: WallSpan[] = ctx.openings.filter((o) => o.kind === "window" && o.room === room.id).map((o) => {
      const wall = ctx.walls.find((w) => w.side === o.side)!;
      return { normal: wall.normal, at: wall.inner, s0: o.s0, s1: o.s1, y0: o.y0, y1: o.y1 };
    });
    furnishRoom(b, {
      room,
      floor: storeyFloor(room.storey),
      ceiling: storeyCeiling(frame, room.storey),
      indoor: ctx.indoor(room.id),
      keepOut,
      anchors,
      windows,
      look,
      rng,
      index,
      variant: plan.variant,
    });
  });
}

function wellRect(st: { x0: number; x1: number; zFoot: number; zTop: number }): PlanRect {
  return { x0: st.x0, x1: st.x1, z0: Math.min(st.zFoot, st.zTop), z1: Math.max(st.zFoot, st.zTop) };
}

/** A rectangle less some holes, as rectangles (strips across x, then z). */
function subtractRects(r: PlanRect, holes: readonly PlanRect[]): PlanRect[] {
  let pieces: PlanRect[] = [r];
  for (const h of holes) {
    const next: PlanRect[] = [];
    for (const p of pieces) {
      if (h.x0 >= p.x1 || h.x1 <= p.x0 || h.z0 >= p.z1 || h.z1 <= p.z0) {
        next.push(p);
        continue;
      }
      if (h.x0 > p.x0) next.push({ ...p, x1: h.x0 });
      if (h.x1 < p.x1) next.push({ ...p, x0: h.x1 });
      const x0 = Math.max(p.x0, h.x0);
      const x1 = Math.min(p.x1, h.x1);
      if (h.z0 > p.z0) next.push({ x0, x1, z0: p.z0, z1: h.z0 });
      if (h.z1 < p.z1) next.push({ x0, x1, z0: h.z1, z1: p.z1 });
    }
    pieces = next;
  }
  return pieces.filter((p) => p.x1 - p.x0 > 1e-4 && p.z1 - p.z0 > 1e-4);
}

function drawPartitions(ctx: DrawContext): void {
  const { b, look, frame } = ctx;
  const { plan } = frame;
  const p = PARTITION_THICKNESS;
  plan.partitions.forEach((part, index) => {
    const y0 = storeyFloor(part.storey);
    const y1 = storeyCeiling(frame, part.storey);
    const doors = plan.doors.filter((d) => d.partition === index);
    const holes = doors.map((d) => ({ s0: d.s - d.width * 0.5, s1: d.s + d.width * 0.5, y0, y1: y0 + d.height }));
    const lo = part.at - p * 0.5;
    const hi = part.at + p * 0.5;
    const sideLo = roomsAlong(plan, part.storey, part.normal, lo, -1, part.s0, part.s1);
    const sideHi = roomsAlong(plan, part.storey, part.normal, hi, 1, part.s0, part.s1);
    const cuts = [...sideLo, ...sideHi].flatMap((r) => [r.lo, r.hi]);
    const fLo = part.normal === "z" ? FACE.nz : FACE.nx;
    const fHi = part.normal === "z" ? FACE.pz : FACE.px;
    const runLo = part.normal === "z" ? FACE.nx : FACE.nz;
    const runHi = part.normal === "z" ? FACE.px : FACE.pz;
    for (const piece of decompose(part.s0, part.s1, y0, y1, holes, cuts)) {
      const mid = (piece.a + piece.c) * 0.5;
      const rl = sideLo.find((r) => mid > r.lo && mid < r.hi);
      const rh = sideHi.find((r) => mid > r.lo && mid < r.hi);
      if (rl) {
        const lining = liningOf(look, rl.room);
        wallBox(b, part.normal, piece.a, piece.c, piece.y0, piece.y1, lo, hi, lining.surface, lining.colour, fLo, ctx.indoor(rl.room.id));
      }
      if (rh) {
        const lining = liningOf(look, rh.room);
        wallBox(b, part.normal, piece.a, piece.c, piece.y0, piece.y1, lo, hi, lining.surface, lining.colour, fHi, ctx.indoor(rh.room.id));
      }
      const reveal = (piece.lo ? runLo : 0) | (piece.hi ? runHi : 0) | (piece.bottom ? FACE.ny : 0);
      const room = rl ?? rh;
      wallBox(b, part.normal, piece.a, piece.c, piece.y0, piece.y1, lo, hi, "trim", shade(look.timberColour, 1.35), reveal, room ? ctx.indoor(room.room.id) : 0.3);
      wallSolid(b, part.normal, piece.a, piece.c, piece.y0, piece.y1, lo, hi, "timber");
    }
    // Thresholds under the doors.
    for (const d of doors) {
      const from = plan.rooms[d.from]!;
      wallBox(b, part.normal, d.s - d.width * 0.5, d.s + d.width * 0.5, y0 - 0.03, y0, lo, hi, "floor", shade(look.floorColour, 0.9), FACE.py, ctx.indoor(from.id));
    }
  });
}

function drawStairs(ctx: DrawContext): void {
  const { b, look, frame } = ctx;
  const { plan } = frame;
  const timber = shade(look.floorColour, 0.95);
  for (const st of plan.stairs) {
    const y = storeyFloor(st.storey);
    const hall = plan.rooms.find((r) => r.storey === st.storey && r.x0 <= st.x0 + 1e-6 && r.x1 >= st.x1 - 1e-6
      && Math.min(r.z0, r.z1) <= Math.min(st.zFoot, st.zTop) + 1e-6)!;
    const indoor = ctx.indoor(hall.id);
    // Which side of the stair is open to the passage.
    const openLow = st.x0 - hall.x0 > hall.x1 - st.x1;
    const sideFace = openLow ? FACE.nx : FACE.px;
    const riserFace = st.dir < 0 ? FACE.pz : FACE.nz;
    for (let i = 0; i < STAIR_TREADS; i += 1) {
      const za = st.zFoot + st.dir * i * STRUCTURE_STAIR_TREAD;
      const zb = st.zFoot + st.dir * (i + 1) * STRUCTURE_STAIR_TREAD;
      const top = y + (i + 1) * STRUCTURE_STAIR_RISE;
      const z0 = Math.min(za, zb);
      const z1 = Math.max(za, zb);
      b.box(st.x0, st.x1, y, top, z0, z1, "floor", timber, FACE.py | riserFace, indoor);
      b.box(st.x0, st.x1, y, top, z0, z1, "boards", shade(look.liningColour, 0.92), sideFace, indoor);
      b.solid(st.x0, st.x1, y, top, z0, z1, "timber");
    }
    // The stair's back (its top end) faces the hall beyond when the well is open there: close it.
    const zEnd = st.zTop;
    const yTop = y + STAIR_TREADS * STRUCTURE_STAIR_RISE;
    b.box(st.x0, st.x1, y, yTop, Math.min(zEnd, zEnd + st.dir * 0.001), Math.max(zEnd, zEnd + st.dir * 0.001), "boards", shade(look.liningColour, 0.92),
      st.dir < 0 ? FACE.nz : FACE.pz, indoor);
    // Handrail on the open side, with a newel post at the foot.
    const rx = openLow ? st.x0 + 0.04 : st.x1 - 0.04;
    const railFoot: Vec3 = [rx, y + STRUCTURE_RAILING_HEIGHT - 0.1, st.zFoot];
    const railTop: Vec3 = [rx, y + STAIR_TREADS * STRUCTURE_STAIR_RISE + STRUCTURE_RAILING_HEIGHT - 0.1, st.zTop];
    beam(b, railFoot, railTop, 0.07, "timber", shade(look.timberColour, 1.1), FACE.all, indoor, 0.06);
    b.capsule(railFoot, railTop, 0.05, "timber");
    const nz0 = st.zFoot - st.dir * 0.05;
    b.box(rx - 0.05, rx + 0.05, y, y + STRUCTURE_RAILING_HEIGHT + 0.05, Math.min(nz0, nz0 + st.dir * 0.1), Math.max(nz0, nz0 + st.dir * 0.1),
      "timber", shade(look.timberColour, 1.1), FACE.all & ~FACE.ny, indoor);
    b.solid(rx - 0.05, rx + 0.05, y, y + STRUCTURE_RAILING_HEIGHT + 0.05, Math.min(nz0, nz0 + st.dir * 0.1), Math.max(nz0, nz0 + st.dir * 0.1), "timber");
    // Upstairs, a railing round the well's open sides: along the passage and across the foot's end.
    const up = storeyFloor(st.storey + 1);
    const well = wellRect(st);
    const landing = plan.rooms.find((r) => r.storey === st.storey + 1 && r.x0 <= st.x0 + 1e-6 && r.x1 >= st.x1 - 1e-6);
    const upIndoor = landing ? ctx.indoor(landing.id) : indoor;
    const ex = openLow ? well.x0 : well.x1;
    const footEndZ = st.zFoot;
    railing(b, [ex, 0, well.z0], [ex, 0, well.z1], up, STRUCTURE_RAILING_HEIGHT, shade(look.timberColour, 1.1), upIndoor);
    railing(b, [well.x0, 0, footEndZ], [well.x1, 0, footEndZ], up, STRUCTURE_RAILING_HEIGHT, shade(look.timberColour, 1.1), upIndoor);
    b.box(ex - 0.05, ex + 0.05, up, up + STRUCTURE_RAILING_HEIGHT + 0.05, footEndZ - 0.05, footEndZ + 0.05, "timber", shade(look.timberColour, 1.0), FACE.all & ~FACE.ny, upIndoor);
    b.solid(ex - 0.05, ex + 0.05, up, up + STRUCTURE_RAILING_HEIGHT + 0.05, footEndZ - 0.05, footEndZ + 0.05, "timber");
  }
}

function drawDoors(ctx: DrawContext): void {
  const { b, look, frame } = ctx;
  const { plan } = frame;
  for (const door of plan.doors) {
    if (door.side && ctx.record.archetype === "barn") continue;
    const leaf = doorLeaf(ctx, door);
    if (!leaf) continue;
    const colour = door.side ? look.doorColour : shade(look.liningColour, 0.96);
    wallBox(b, leaf.normal, leaf.a, leaf.c, leaf.y0, leaf.y1, leaf.n0, leaf.n1, "boards", colour, FACE.all & ~FACE.ny, ctx.indoor(leaf.room));
  }
}

interface Leaf {
  readonly normal: "x" | "z";
  readonly a: number;
  readonly c: number;
  readonly y0: number;
  readonly y1: number;
  readonly n0: number;
  readonly n1: number;
  readonly room: number;
}

/** A door's leaf swung open into its room, flat against the wall on its hinge side. */
function doorLeaf(ctx: DrawContext, door: PlanDoor): Leaf | null {
  const { frame } = ctx;
  const { plan } = frame;
  const room = plan.rooms[door.to]!;
  const y0 = storeyFloor(door.storey) + 0.01;
  const y1 = storeyFloor(door.storey) + Math.min(door.height, STRUCTURE_DOOR_HEIGHT) - 0.01;
  let normal: "x" | "z";
  let face: number;
  let inward: number;
  if (door.side) {
    const wall = ctx.walls.find((w) => w.side === door.side)!;
    normal = wall.normal;
    face = wall.inner;
    inward = -wall.out;
  } else {
    const part = plan.partitions[door.partition!]!;
    normal = part.normal;
    const roomLow = part.normal === "x" ? room.x1 <= part.at : room.z1 <= part.at;
    face = roomLow ? part.at - PARTITION_THICKNESS * 0.5 : part.at + PARTITION_THICKNESS * 0.5;
    inward = roomLow ? -1 : 1;
  }
  const lo = normal === "z" ? room.x0 : room.z0;
  const hi = normal === "z" ? room.x1 : room.z1;
  const s0 = door.s - door.width * 0.5;
  const s1 = door.s + door.width * 0.5;
  const w = door.width;
  const freeLo = s0 - lo;
  const freeHi = hi - s1;
  const blocked = (a: number, c: number) => ctx.frame.plan.stairs.some((st) => {
    if (st.storey !== door.storey) return false;
    const n0 = Math.min(face, face + inward * 0.06);
    const n1 = Math.max(face, face + inward * 0.06);
    const r = normal === "z" ? { x0: a, x1: c, z0: n0, z1: n1 } : { x0: n0, x1: n1, z0: a, z1: c };
    const sw = wellRect(st);
    return r.x0 < sw.x1 && r.x1 > sw.x0 && r.z0 < Math.max(sw.z0, sw.z1) + STAIR_LANDING * 0 && r.z1 > sw.z0;
  });
  let a: number;
  if (freeHi >= w + 0.02 && !blocked(s1 + 0.01, s1 + 0.01 + w) && (freeHi >= freeLo || freeLo < w + 0.02 || blocked(s0 - 0.01 - w, s0 - 0.01))) a = s1 + 0.01;
  else if (freeLo >= w + 0.02 && !blocked(s0 - 0.01 - w, s0 - 0.01)) a = s0 - 0.01 - w;
  else return null;
  return { normal, a, c: a + w, y0, y1, n0: face + inward * 0.005, n1: face + inward * 0.05, room: room.id };
}

/** Where a room's furniture may not stand: in front of its doors, under their leaves, on stairs and landings. */
function keepOuts(ctx: DrawContext, room: PlanRoom): PlanRect[] {
  const { frame } = ctx;
  const { plan } = frame;
  const out: PlanRect[] = [];
  for (const door of plan.doors) {
    if (door.storey !== room.storey) continue;
    const zone = doorZone(ctx, door, room);
    if (zone) out.push(zone);
    if (door.to === room.id || door.side) {
      const leaf = doorLeaf(ctx, door);
      if (leaf && leaf.room === room.id) {
        const n0 = Math.min(leaf.n0, leaf.n1);
        const n1 = Math.max(leaf.n0, leaf.n1) + 0.02;
        out.push(leaf.normal === "z" ? { x0: leaf.a - 0.05, x1: leaf.c + 0.05, z0: n0 - 0.05, z1: n1 + 0.05 } : { x0: n0 - 0.05, x1: n1 + 0.05, z0: leaf.a - 0.05, z1: leaf.c + 0.05 });
      }
    }
  }
  for (const st of plan.stairs) {
    if (st.storey !== room.storey && st.storey !== room.storey - 1) continue;
    const w = wellRect(st);
    // The stair and its landings at both ends.
    out.push({ x0: w.x0 - 0.05, x1: w.x1 + 0.05, z0: w.z0 - STAIR_LANDING, z1: w.z1 + STAIR_LANDING });
    // Upstairs the passage beside the well stays clear too.
    if (st.storey === room.storey - 1) out.push({ x0: room.x0, x1: room.x1, z0: w.z0 - 0.3, z1: w.z1 + 0.3 });
  }
  return out;
}

/** The clear space either side of a door in this room (1 m deep, the door's width and a bit). */
function doorZone(ctx: DrawContext, door: PlanDoor, room: PlanRoom): PlanRect | null {
  const { frame } = ctx;
  const { plan } = frame;
  const s0 = door.s - door.width * 0.5 - 0.15;
  const s1 = door.s + door.width * 0.5 + 0.15;
  const depth = door.side ? 1.2 : 1.0;
  if (door.side) {
    if (door.to !== room.id) return null;
    const wall = ctx.walls.find((w) => w.side === door.side)!;
    const n0 = wall.inner;
    const n1 = wall.inner - wall.out * depth;
    return wall.normal === "z" ? { x0: s0, x1: s1, z0: Math.min(n0, n1), z1: Math.max(n0, n1) } : { x0: Math.min(n0, n1), x1: Math.max(n0, n1), z0: s0, z1: s1 };
  }
  if (door.from !== room.id && door.to !== room.id) return null;
  const part = plan.partitions[door.partition!]!;
  const roomLow = part.normal === "x" ? room.x1 <= part.at : room.z1 <= part.at;
  const face = roomLow ? part.at - PARTITION_THICKNESS * 0.5 : part.at + PARTITION_THICKNESS * 0.5;
  const n1 = face + (roomLow ? -depth : depth);
  return part.normal === "z" ? { x0: s0, x1: s1, z0: Math.min(face, n1), z1: Math.max(face, n1) } : { x0: Math.min(face, n1), x1: Math.max(face, n1), z0: s0, z1: s1 };
}

/** Points in front of each of a room's doors (and its stair ends) that must stay joined. */
function doorAnchors(ctx: DrawContext, room: PlanRoom): { x: number; z: number }[] {
  const { frame } = ctx;
  const { plan } = frame;
  const out: { x: number; z: number }[] = [];
  const inset = 0.45;
  for (const door of plan.doors) {
    if (door.storey !== room.storey) continue;
    if (door.side) {
      if (door.to !== room.id) continue;
      const wall = ctx.walls.find((w) => w.side === door.side)!;
      const n = wall.inner - wall.out * inset;
      out.push(wall.normal === "z" ? { x: door.s, z: n } : { x: n, z: door.s });
      continue;
    }
    if (door.from !== room.id && door.to !== room.id) continue;
    const part = plan.partitions[door.partition!]!;
    const roomLow = part.normal === "x" ? room.x1 <= part.at : room.z1 <= part.at;
    const n = part.at + (roomLow ? -1 : 1) * (PARTITION_THICKNESS * 0.5 + inset);
    out.push(part.normal === "z" ? { x: door.s, z: n } : { x: n, z: door.s });
  }
  for (const st of plan.stairs) {
    const mid = (st.x0 + st.x1) * 0.5;
    if (st.storey === room.storey && mid > room.x0 && mid < room.x1) out.push({ x: mid, z: st.zFoot - st.dir * 0.45 });
    if (st.storey === room.storey - 1 && mid > room.x0 && mid < room.x1) out.push({ x: mid, z: st.zTop + st.dir * 0.45 });
  }
  return out.filter((p) => p.x > room.x0 && p.x < room.x1 && p.z > room.z0 && p.z < room.z1);
}
