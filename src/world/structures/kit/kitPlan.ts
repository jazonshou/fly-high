import type { StructureArchetype } from "../structureRecord";
import { STRUCTURE_DOOR_HEIGHT, STRUCTURE_DOOR_WIDTH, STRUCTURE_STAIR_MIN_WIDTH, STRUCTURE_STAIR_RISE, STRUCTURE_STAIR_TREAD } from "../structureEnvelope";
import { KitChannel, KitRandom } from "./kitRandom";

/**
 * Floor plans of the walled buildings: rooms as rectangles inside the body's
 * walls, the partitions between them, the doors that join them, and the
 * stair between storeys. Rooms tile the inside exactly, columns across the
 * front (x) and rows front to back (z) inside a column, so every partition
 * is a straight line and every room a box. Two to four plans per type,
 * picked by the record's seed and mirrored left to right.
 *
 * Building frame (`structureRecord.ts`): +z out of the front, y up from the
 * ground floor's level.
 */

/** Interior partitions' thickness, metres. */
export const PARTITION_THICKNESS = 0.12;
/** Floor to floor: sixteen of the walker's risers. */
export const STOREY_HEIGHT = 16 * STRUCTURE_STAIR_RISE;
/** The floor's structure between a ceiling and the floor above it. */
export const FLOOR_STRUCTURE = 0.3;
/** A ceiling slab under the roof (the top storey's ceiling). */
export const TOP_CEILING_THICKNESS = 0.1;
/** Stairs between storeys: risers and treads (the top riser lands on the upper floor). */
export const STAIR_RISERS = 16;
export const STAIR_TREADS = STAIR_RISERS - 1;
export const STAIR_RUN = STAIR_TREADS * STRUCTURE_STAIR_TREAD;
export const STAIR_WIDTH = Math.max(STRUCTURE_STAIR_MIN_WIDTH, 0.95);
/** Clear floor before a stair's first riser and after its last. */
export const STAIR_LANDING = 0.95;
/** A hall that holds a stair: the stair and a passage beside it. */
export const STAIR_HALL_WIDTH = 2.05;
/** Least clear width either side of a door opening along its wall. */
const DOOR_END_MARGIN = 0.08;

export type RoomKind =
  | "hall" | "landing" | "corridor" | "living" | "kitchen" | "dining" | "bedroom" | "main" | "bunk"
  | "steam" | "changing" | "office" | "barn" | "tack" | "workshop" | "store";

export interface PlanRoom {
  readonly id: number;
  readonly name: string;
  readonly kind: RoomKind;
  readonly storey: number;
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
}

/**
 * An interior wall: a straight line on one storey. `normal` is the axis it
 * faces: "x" runs along z at x = `at`, "z" runs along x at z = `at`.
 * Its core spans `at` +- half the thickness, from `s0` to `s1` along its run.
 */
export interface PlanPartition {
  readonly storey: number;
  readonly normal: "x" | "z";
  readonly at: number;
  readonly s0: number;
  readonly s1: number;
}

/** The outer walls, by the way they face. */
export type WallSide = "front" | "back" | "left" | "right";

export interface PlanDoor {
  readonly storey: number;
  /** On a partition (index) or an outer wall. */
  readonly partition: number | null;
  readonly side: WallSide | null;
  /** Centre of the opening along its wall's run (x for z-facing walls, z for x-facing ones). */
  readonly s: number;
  readonly width: number;
  readonly height: number;
  /** The room nearer the entrance (or -1, outside) and the room it leads into. */
  readonly from: number;
  readonly to: number;
}

/** A straight flight in a hall, running along z, from `storey` to the next. */
export interface PlanStair {
  readonly storey: number;
  readonly x0: number;
  readonly x1: number;
  /** z of the first riser's foot and of the last tread's back edge (the top). */
  readonly zFoot: number;
  readonly zTop: number;
  /** +1: climbing towards +z; -1: towards -z. */
  readonly dir: 1 | -1;
}

export interface FloorPlan {
  readonly storeys: number;
  /** The inner faces of the outer walls. */
  readonly ix0: number;
  readonly ix1: number;
  readonly iz0: number;
  readonly iz1: number;
  readonly rooms: readonly PlanRoom[];
  readonly partitions: readonly PlanPartition[];
  readonly doors: readonly PlanDoor[];
  readonly stairs: readonly PlanStair[];
  /** The main outside door (always on the front wall, from outside into its room). */
  readonly frontDoor: PlanDoor;
  /** Which plan of the type it is, for tests and shots. */
  readonly variant: string;
}

interface Column {
  readonly x0: number;
  readonly x1: number;
  /** Row boundaries front to back are made per storey. */
  readonly hall: boolean;
}

interface Builder {
  rooms: PlanRoom[];
  partitions: PlanPartition[];
}

/** Room kinds a plan template assigns, by storey, before names are numbered. */
type Assign = (storey: number, column: number, row: number, rows: number, isHall: boolean) => RoomKind;

/** Split [a, b] into pieces of the given relative widths with `gap` between them. */
function splitSpan(a: number, b: number, shares: readonly number[], gap: number): [number, number][] {
  const total = shares.reduce((s, v) => s + v, 0);
  const free = b - a - gap * (shares.length - 1);
  const out: [number, number][] = [];
  let at = a;
  for (let i = 0; i < shares.length; i += 1) {
    const w = (free * shares[i]!) / total;
    const end = i === shares.length - 1 ? b : at + w;
    out.push([at, end]);
    at = end + gap;
  }
  return out;
}

interface Template {
  readonly variant: string;
  /** Column shares across the inside, left to right; null share for the hall (fixed width). */
  readonly columns: readonly (number | "hall" | "corridor")[];
  /** Rows per storey per column: 1 or 2 (split at `rowSplit`). */
  readonly rows: (storey: number, column: number, isHall: boolean) => number;
  readonly rowSplit: (storey: number, column: number) => number;
  readonly assign: Assign;
  /** The entry room's column on the ground floor. */
  readonly entry: number;
  readonly stair: boolean;
}

/** Templates per archetype, chosen by width; the seed picks among those that fit. */
function templatesFor(archetype: StructureArchetype, storeys: number, innerW: number, innerD: number, rng: KitRandom): Template[] {
  const split = (s: number, c: number) => 0.44 + 0.12 * rng.unit(KitChannel.split, s * 8 + c);
  const out: Template[] = [];
  const fits = (minWidths: number[]) => minWidths.reduce((a, b) => a + b, 0) + PARTITION_THICKNESS * (minWidths.length - 1) <= innerW;
  const deepEnoughForRows = innerD >= 2 * 2.5 + PARTITION_THICKNESS;
  switch (archetype) {
    case "house": {
      if (storeys >= 2) {
        const upperKind: Assign = (s, _c, _r, _n, hall) => (hall ? (s === 0 ? "hall" : "landing") : s === 0 ? "living" : "bedroom");
        if (fits([2.6, STAIR_HALL_WIDTH, 2.6])) {
          out.push({
            variant: "centre-hall",
            columns: [1, "hall", 1],
            rows: (s, c, hall) => (hall ? 1 : s === 0 ? (c === 0 ? 1 : 2) : 2),
            rowSplit: split,
            assign: (s, c, r, n, hall) => (hall ? (s === 0 ? "hall" : "landing") : s === 0 ? (c === 2 && r === 1 && n === 2 ? "kitchen" : c === 2 ? "dining" : "living") : "bedroom"),
            entry: 1,
            stair: true,
          });
        }
        out.push({
          variant: "side-hall",
          columns: ["hall", 1],
          rows: (_s, _c, hall) => (hall ? 1 : 2),
          rowSplit: split,
          assign: (s, c, r, n, hall) => (hall ? upperKind(s, c, r, n, hall) : s === 0 ? (r === 1 ? "kitchen" : "living") : "bedroom"),
          entry: 0,
          stair: true,
        });
        if (fits([STAIR_HALL_WIDTH, 3.0, 3.0])) {
          out.push({
            variant: "side-hall-wide",
            columns: ["hall", 1, 1],
            rows: (s, c, hall) => (hall ? 1 : s === 0 ? (c === 1 ? 2 : 1) : 2),
            rowSplit: split,
            assign: (s, c, r, n, hall) => (hall ? upperKind(s, c, r, n, hall) : s === 0 ? (c === 1 ? (r === 1 ? "kitchen" : "dining") : "living") : "bedroom"),
            entry: 0,
            stair: true,
          });
        }
      } else {
        if (fits([3.0, 1.4, 3.0]) && deepEnoughForRows) {
          out.push({
            variant: "corridor",
            columns: [1, "corridor", 1],
            rows: () => 2,
            rowSplit: split,
            assign: (_s, c, r, _n, hall) => (hall ? "corridor" : c === 0 ? (r === 0 ? "living" : "kitchen") : "bedroom"),
            entry: 1,
            stair: false,
          });
        }
        if (deepEnoughForRows) {
          out.push({
            variant: "front-living",
            columns: [1],
            rows: () => 2,
            rowSplit: () => 0.42,
            assign: (_s, _c, r) => (r === 0 ? "living" : "kitchen"),
            entry: 0,
            stair: false,
          });
        }
        out.push({
          variant: "two-column",
          columns: [1.15, 1],
          rows: (_s, c) => (c === 1 && deepEnoughForRows ? 2 : 1),
          rowSplit: split,
          assign: (_s, c, r) => (c === 0 ? "living" : r === 1 ? "kitchen" : "bedroom"),
          entry: 0,
          stair: false,
        });
      }
      break;
    }
    case "cottage":
      if (innerD >= 2 * 2.3 + PARTITION_THICKNESS) {
        out.push({
          variant: "two-column-split",
          columns: [1.3, 1],
          rows: (_s, c) => (c === 1 ? 2 : 1),
          rowSplit: split,
          assign: (_s, c, r) => (c === 0 ? "living" : r === 1 ? "kitchen" : "bedroom"),
          entry: 0,
          stair: false,
        });
      }
      out.push({
        variant: "two-column",
        columns: [1.4, 1],
        rows: () => 1,
        rowSplit: split,
        assign: (_s, c) => (c === 0 ? "living" : "bedroom"),
        entry: 0,
        stair: false,
      });
      if (fits([2.4, 2.9, 2.4])) {
        out.push({
          variant: "three-column",
          columns: [1, 1.3, 1],
          rows: () => 1,
          rowSplit: split,
          assign: (_s, c) => (c === 1 ? "living" : c === 0 ? "bedroom" : "kitchen"),
          entry: 1,
          stair: false,
        });
      }
      break;
    case "cabin":
      out.push({ variant: "one-room", columns: [1], rows: () => 1, rowSplit: split, assign: () => "main", entry: 0, stair: false });
      if (fits([3.2, 2.2])) {
        out.push({
          variant: "bunk-room",
          columns: [1.5, 1],
          rows: () => 1,
          rowSplit: split,
          assign: (_s, c) => (c === 0 ? "main" : "bunk"),
          entry: 0,
          stair: false,
        });
      }
      break;
    case "sauna":
      out.push({ variant: "one-room", columns: [1], rows: () => 1, rowSplit: split, assign: () => "steam", entry: 0, stair: false });
      if (innerD >= 3.0) {
        out.push({
          variant: "changing-room",
          columns: [1],
          rows: () => 2,
          rowSplit: () => 0.42,
          assign: (_s, _c, r) => (r === 0 ? "changing" : "steam"),
          entry: 0,
          stair: false,
        });
      }
      break;
    case "barn":
      out.push({ variant: "open-hall", columns: [1], rows: () => 1, rowSplit: split, assign: () => "barn", entry: 0, stair: false });
      out.push({
        variant: "tack-room",
        columns: [3.6, 1],
        rows: () => 1,
        rowSplit: split,
        assign: (_s, c) => (c === 0 ? "barn" : "tack"),
        entry: 0,
        stair: false,
      });
      break;
    case "shed":
      out.push({ variant: "workshop", columns: [1], rows: () => 1, rowSplit: split, assign: () => "workshop", entry: 0, stair: false });
      out.push({ variant: "workshop-store", columns: [1], rows: () => 1, rowSplit: split, assign: () => "workshop", entry: 0, stair: false });
      break;
    case "station":
      if (fits([3.4, 1.5, 3.4])) {
        out.push({
          variant: "office-hall-bunk",
          columns: [1, "corridor", 1],
          rows: () => 1,
          rowSplit: split,
          assign: (_s, c, _r, _n, hall) => (hall ? "corridor" : c === 0 ? "office" : "bunk"),
          entry: 1,
          stair: false,
        });
      }
      out.push({
        variant: "office-bunk",
        columns: [1.2, 1],
        rows: () => 1,
        rowSplit: split,
        assign: (_s, c) => (c === 0 ? "office" : "bunk"),
        entry: 0,
        stair: false,
      });
      break;
    case "store":
      out.push({ variant: "store", columns: [1], rows: () => 1, rowSplit: split, assign: () => "store", entry: 0, stair: false });
      out.push({ variant: "store-aisle", columns: [1], rows: () => 1, rowSplit: split, assign: () => "store", entry: 0, stair: false });
      break;
    default:
      break;
  }
  return out;
}

const KIND_NAMES: Readonly<Record<RoomKind, string>> = {
  hall: "hall", landing: "landing", corridor: "corridor", living: "living room", kitchen: "kitchen", dining: "dining room",
  bedroom: "bedroom", main: "main room", bunk: "bunk room", steam: "steam room", changing: "changing room", office: "office",
  barn: "barn hall", tack: "tack room", workshop: "workshop", store: "store room",
};

/**
 * A walled building's plan: `inner` is the inside of its outer walls,
 * `storeys` its floors. Returns null for an archetype without one (towers,
 * props). Deterministic from the seed.
 */
export function floorPlan(
  archetype: StructureArchetype,
  storeys: number,
  inner: { x0: number; x1: number; z0: number; z1: number },
  seed: number,
): FloorPlan | null {
  const rng = new KitRandom(seed);
  const innerW = inner.x1 - inner.x0;
  const innerD = inner.z1 - inner.z0;
  const templates = templatesFor(archetype, storeys, innerW, innerD, rng);
  if (templates.length === 0) return null;
  const template = rng.pick(KitChannel.plan, templates);
  const mirror = rng.chance(KitChannel.mirror, 0.5);
  const plan = buildPlan(template, storeys, inner, rng, archetype);
  return mirror ? mirrorPlan(plan) : plan;
}

function buildPlan(
  template: Template, storeys: number,
  inner: { x0: number; x1: number; z0: number; z1: number },
  rng: KitRandom, archetype: StructureArchetype,
): FloorPlan {
  const p = PARTITION_THICKNESS;
  // Columns: the hall and corridor take fixed widths, the rest share what is left.
  const fixedWidth = (c: number | "hall" | "corridor") => (c === "hall" ? STAIR_HALL_WIDTH : c === "corridor" ? 1.5 : 0);
  const fixed = template.columns.reduce<number>((s, c) => s + fixedWidth(c), 0);
  const shareTotal = template.columns.reduce<number>((s, c) => s + (typeof c === "number" ? c : 0), 0);
  const free = inner.x1 - inner.x0 - fixed - p * (template.columns.length - 1);
  const columns: Column[] = [];
  let at = inner.x0;
  template.columns.forEach((c, i) => {
    const w = typeof c === "number" ? (free * c) / shareTotal : fixedWidth(c);
    const x1 = i === template.columns.length - 1 ? inner.x1 : at + w;
    columns.push({ x0: at, x1, hall: typeof c !== "number" });
    at = x1 + p;
  });

  const b: Builder = { rooms: [], partitions: [] };
  const roomGrid: number[][][] = [];
  for (let s = 0; s < storeys; s += 1) {
    roomGrid.push([]);
    columns.forEach((col, c) => {
      const rows = template.rows(s, c, col.hall);
      const ids: number[] = [];
      if (rows === 2) {
        const share = template.rowSplit(s, c);
        // Row 0 is the front (z high), row 1 the back.
        const spans = splitSpan(inner.z0, inner.z1, [1 - share, share], p);
        const [back0, back1] = spans[0]!;
        const [front0, front1] = spans[1]!;
        ids.push(addRoom(b, template.assign(s, c, 0, 2, col.hall), s, col.x0, col.x1, front0!, front1!));
        ids.push(addRoom(b, template.assign(s, c, 1, 2, col.hall), s, col.x0, col.x1, back0!, back1!));
        b.partitions.push({ storey: s, normal: "z", at: (back1! + front0!) * 0.5, s0: col.x0, s1: col.x1 });
      } else {
        ids.push(addRoom(b, template.assign(s, c, 0, 1, col.hall), s, col.x0, col.x1, inner.z0, inner.z1));
      }
      roomGrid[s]!.push(ids);
    });
    for (let c = 0; c + 1 < columns.length; c += 1) {
      b.partitions.push({ storey: s, normal: "x", at: (columns[c]!.x1 + columns[c + 1]!.x0) * 0.5, s0: inner.z0, s1: inner.z1 });
    }
  }

  // The stair: against the hall's partition side, climbing to the back (or the front).
  const stairs: PlanStair[] = [];
  const hallColumn = columns.findIndex((col) => col.hall);
  if (template.stair && storeys >= 2 && hallColumn >= 0) {
    const col = columns[hallColumn]!;
    // The stair lies against the hall's wall that is a partition; for a centre hall, the right one.
    const againstRight = hallColumn < columns.length - 1;
    const x1 = againstRight ? col.x1 : col.x0 + STAIR_WIDTH;
    const x0 = x1 - STAIR_WIDTH;
    const towardsBack = !rng.chance(KitChannel.stairEnd, 0.3);
    for (let s = 0; s + 1 < storeys; s += 1) {
      if (towardsBack) {
        const zFoot = inner.z1 - STAIR_LANDING - 0.05;
        stairs.push({ storey: s, x0, x1, zFoot, zTop: zFoot - STAIR_RUN, dir: -1 });
      } else {
        const zFoot = inner.z0 + STAIR_LANDING;
        stairs.push({ storey: s, x0, x1, zFoot, zTop: zFoot + STAIR_RUN, dir: 1 });
      }
    }
  }

  // Doors: grow a tree from the entry room on each storey, preferring halls.
  const doors: PlanDoor[] = [];
  const entryRoom = roomGrid[0]![template.entry]![0]!;
  const frontEntryRoom = b.rooms[entryRoom]!;
  const frontDoor = makeFrontDoor(frontEntryRoom, stairs, archetype, rng);
  doors.push(frontDoor);
  for (let s = 0; s < storeys; s += 1) {
    const storeyRooms = b.rooms.filter((r) => r.storey === s).map((r) => r.id);
    let seedRoom: number;
    if (s === 0) seedRoom = entryRoom;
    else {
      const stair = stairs.find((st) => st.storey === s - 1)!;
      const zTop = stair.zTop;
      seedRoom = storeyRooms.find((id) => {
        const r = b.rooms[id]!;
        return r.x0 <= stair.x0 + 1e-6 && r.x1 >= stair.x1 - 1e-6 && Math.min(r.z0, r.z1) <= zTop && Math.max(r.z0, r.z1) >= zTop;
      })!;
    }
    const connected = new Set<number>([seedRoom]);
    const queue = [seedRoom];
    while (connected.size < storeyRooms.length) {
      let added = false;
      // Breadth first: from rooms in the order they joined, halls first.
      const order = [...queue].sort((a, c) => hallRank(b.rooms[a]!) - hallRank(b.rooms[c]!));
      for (const from of order) {
        for (const to of storeyRooms) {
          if (connected.has(to)) continue;
          const door = doorBetween(b, from, to, stairs, rng);
          if (door) {
            doors.push(door);
            connected.add(to);
            queue.push(to);
            added = true;
          }
        }
      }
      if (!added) break;
    }
  }
  return {
    storeys,
    ix0: inner.x0,
    ix1: inner.x1,
    iz0: inner.z0,
    iz1: inner.z1,
    rooms: nameRooms(b.rooms),
    partitions: b.partitions,
    doors,
    stairs,
    frontDoor,
    variant: template.variant,
  };
}

function hallRank(room: PlanRoom): number {
  return room.kind === "hall" || room.kind === "landing" || room.kind === "corridor" ? 0 : room.kind === "living" || room.kind === "main" ? 1 : 2;
}

function addRoom(b: Builder, kind: RoomKind, storey: number, x0: number, x1: number, z0: number, z1: number): number {
  const id = b.rooms.length;
  b.rooms.push({ id, name: kind, kind, storey, x0, x1, z0, z1 });
  return id;
}

function nameRooms(rooms: PlanRoom[]): PlanRoom[] {
  const counts = new Map<string, number>();
  for (const r of rooms) counts.set(`${r.storey}:${r.kind}`, (counts.get(`${r.storey}:${r.kind}`) ?? 0) + 1);
  const seen = new Map<string, number>();
  const storeys = new Set(rooms.map((r) => r.storey)).size;
  return rooms.map((r) => {
    const key = `${r.storey}:${r.kind}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const base = KIND_NAMES[r.kind];
    const numbered = (counts.get(key) ?? 1) > 1 ? `${base} ${n}` : base;
    const floor = storeys > 1 ? (r.storey === 0 ? "ground floor " : "upper floor ") : "";
    return { ...r, name: `${floor}${numbered}` };
  });
}

/** The free stretches of a partition or wall run where a door may go (clear of stairs and their wells). */
function blockedByStairs(storey: number, normal: "x" | "z", at: number, stairs: readonly PlanStair[]): [number, number][] {
  const out: [number, number][] = [];
  for (const st of stairs) {
    if (st.storey !== storey && st.storey !== storey - 1) continue;
    const zLo = Math.min(st.zFoot, st.zTop);
    const zHi = Math.max(st.zFoot, st.zTop);
    if (normal === "x") {
      // A wall along z beside the stair (within a partition's reach of its sides).
      if (Math.abs(at - st.x0) < 0.2 || Math.abs(at - st.x1) < 0.2) out.push([zLo - 0.05, zHi + 0.05]);
    } else if (at > zLo - 0.2 && at < zHi + 0.2) {
      out.push([st.x0 - 0.05, st.x1 + 0.05]);
    }
  }
  return out;
}

/** Place a door of `width` in [lo, hi] clear of `blocked`, near `prefer`; null if none fits. */
function placeOnRun(lo: number, hi: number, width: number, blocked: readonly [number, number][], prefer: number): number | null {
  const half = width * 0.5 + DOOR_END_MARGIN;
  let best: number | null = null;
  let bestCost = Infinity;
  const candidates = [prefer, lo + half, hi - half, (lo + hi) * 0.5];
  for (const [b0, b1] of blocked) candidates.push(b0 - half, b1 + half);
  for (const c of candidates) {
    if (c - half < lo - 1e-9 || c + half > hi + 1e-9) continue;
    if (blocked.some(([b0, b1]) => c + half > b0 && c - half < b1)) continue;
    const cost = Math.abs(c - prefer);
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return best;
}

function doorBetween(b: Builder, fromId: number, toId: number, stairs: readonly PlanStair[], rng: KitRandom): PlanDoor | null {
  const from = b.rooms[fromId]!;
  const to = b.rooms[toId]!;
  const p = PARTITION_THICKNESS;
  const eps = 1e-6;
  for (let index = 0; index < b.partitions.length; index += 1) {
    const part = b.partitions[index]!;
    if (part.storey !== from.storey) continue;
    let lo: number;
    let hi: number;
    if (part.normal === "x") {
      if (!(Math.abs(from.x1 + p * 0.5 - part.at) < eps && Math.abs(to.x0 - p * 0.5 - part.at) < eps)
        && !(Math.abs(to.x1 + p * 0.5 - part.at) < eps && Math.abs(from.x0 - p * 0.5 - part.at) < eps)) continue;
      lo = Math.max(from.z0, to.z0);
      hi = Math.min(from.z1, to.z1);
    } else {
      if (!(Math.abs(from.z1 + p * 0.5 - part.at) < eps && Math.abs(to.z0 - p * 0.5 - part.at) < eps)
        && !(Math.abs(to.z1 + p * 0.5 - part.at) < eps && Math.abs(from.z0 - p * 0.5 - part.at) < eps)) continue;
      lo = Math.max(from.x0, to.x0);
      hi = Math.min(from.x1, to.x1);
    }
    if (hi - lo < STRUCTURE_DOOR_WIDTH + 2 * DOOR_END_MARGIN) continue;
    const blocked = blockedByStairs(from.storey, part.normal, part.at, stairs);
    // Doors sit towards one end of a long wall (furniture gets the rest), towards the middle of a short one.
    const towardsLow = rng.chance(KitChannel.split, 0.5, 100 + fromId * 31 + toId);
    const prefer = hi - lo < 2.4 ? (lo + hi) * 0.5 : towardsLow ? lo + 0.6 : hi - 0.6;
    const s = placeOnRun(lo, hi, STRUCTURE_DOOR_WIDTH, blocked, prefer);
    if (s === null) continue;
    return { storey: from.storey, partition: index, side: null, s, width: STRUCTURE_DOOR_WIDTH, height: STRUCTURE_DOOR_HEIGHT, from: fromId, to: toId };
  }
  return null;
}

/** Barns' big doors: clear width and height, metres. */
export const BARN_DOOR_WIDTH = 3.2;
export const BARN_DOOR_HEIGHT = 3.0;

function makeFrontDoor(room: PlanRoom, stairs: readonly PlanStair[], archetype: StructureArchetype, rng: KitRandom): PlanDoor {
  const big = archetype === "barn";
  const width = big ? BARN_DOOR_WIDTH : STRUCTURE_DOOR_WIDTH;
  const height = big ? BARN_DOOR_HEIGHT : STRUCTURE_DOOR_HEIGHT;
  const blocked: [number, number][] = [];
  // The front door of a stair hall opens onto the passage beside the stair.
  for (const st of stairs) if (st.storey === 0 && st.x0 >= room.x0 - 1e-6 && st.x1 <= room.x1 + 1e-6) blocked.push([st.x0, st.x1]);
  const middle = (room.x0 + room.x1) * 0.5;
  const offset = room.x1 - room.x0 > 3.5 && !big ? (rng.unit(KitChannel.split, 77) - 0.5) * 0.5 : 0;
  const s = placeOnRun(room.x0, room.x1, width, blocked, middle + offset) ?? middle;
  return { storey: 0, partition: null, side: "front", s, width, height, from: -1, to: room.id };
}

function mirrorPlan(plan: FloorPlan): FloorPlan {
  const mx = (x: number) => -x;
  return {
    ...plan,
    ix0: -plan.ix1,
    ix1: -plan.ix0,
    rooms: plan.rooms.map((r) => ({ ...r, x0: mx(r.x1), x1: mx(r.x0) })),
    partitions: plan.partitions.map((pt) => (pt.normal === "x" ? { ...pt, at: mx(pt.at) } : { ...pt, s0: mx(pt.s1), s1: mx(pt.s0) })),
    doors: plan.doors.map((d) => mirrorDoor(plan, d)),
    stairs: plan.stairs.map((st) => ({ ...st, x0: mx(st.x1), x1: mx(st.x0) })),
    frontDoor: mirrorDoor(plan, plan.frontDoor),
  };
}

function mirrorDoor(plan: FloorPlan, d: PlanDoor): PlanDoor {
  // Doors on z-facing walls run along x (mirrored); on x-facing walls along z (unchanged).
  const alongX = d.side === "front" || d.side === "back" || (d.partition !== null && plan.partitions[d.partition]!.normal === "z");
  const side = d.side === "left" ? "right" : d.side === "right" ? "left" : d.side;
  return { ...d, side, s: alongX ? -d.s : d.s };
}

/** The rooms of a storey whose rectangles overlap [lo, hi] along a wall run, with their overlaps. */
export function roomsAlong(
  plan: FloorPlan, storey: number, normal: "x" | "z", at: number, side: 1 | -1, lo: number, hi: number,
): { room: PlanRoom; lo: number; hi: number }[] {
  const out: { room: PlanRoom; lo: number; hi: number }[] = [];
  for (const room of plan.rooms) {
    if (room.storey !== storey) continue;
    // The room must lie on `side` of the wall plane and touch it (within a wall's thickness).
    const near = normal === "x"
      ? (side > 0 ? room.x0 >= at - 1e-6 && room.x0 - at < 0.5 : room.x1 <= at + 1e-6 && at - room.x1 < 0.5)
      : (side > 0 ? room.z0 >= at - 1e-6 && room.z0 - at < 0.5 : room.z1 <= at + 1e-6 && at - room.z1 < 0.5);
    if (!near) continue;
    const r0 = normal === "x" ? room.z0 : room.x0;
    const r1 = normal === "x" ? room.z1 : room.x1;
    const o0 = Math.max(lo, r0);
    const o1 = Math.min(hi, r1);
    if (o1 - o0 > 1e-6) out.push({ room, lo: o0, hi: o1 });
  }
  return out.sort((a, b) => a.lo - b.lo);
}

/** The stair's tread count and geometry helpers. */
export function stairTreadTop(index: number): number {
  return (index + 1) * STRUCTURE_STAIR_RISE;
}
