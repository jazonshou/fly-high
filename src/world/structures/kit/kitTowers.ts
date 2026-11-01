import type { StructureRecord } from "../structureRecord";
import type { StructureColliderMaterial, StructureSurface } from "../structureModel";
import { STRUCTURE_DOOR_HEIGHT, STRUCTURE_DOOR_WIDTH, STRUCTURE_RAILING_HEIGHT, STRUCTURE_STAIR_TREAD } from "../structureEnvelope";
import { type KitBuilder, FACE, type Vec3, beam, shade } from "./kitBuilder";
import { decompose, pushFacing, railing } from "./kitBody";
import { structureIndoorLight } from "./kitIndoorLight";
import { STOREY_HEIGHT } from "./kitPlan";
import { drawRoof, type RoofSpec, roofGeometry } from "./kitRoof";
import type { StructureLook } from "./kitStyles";

/**
 * Towers you climb: an outpost's watchtower (outside stairs to a roofed
 * platform), a fire lookout (outside flights with landings up to a cab with
 * windows all round) and a lighthouse (straight flights round a square shaft
 * to the lamp room and its gallery). Their stairs wind round the body in
 * flights of eight risers with landings at the corners: outside the legs for
 * the open towers, inside the walls for the lighthouse.
 */

/** Risers in one flight between landings. */
const FLIGHT_RISERS = 8;
/** The outside stair's band: its inner edge off the body's side, and its width. */
const BAND_GAP = 0.1;
const BAND_WIDTH = 1.0;
/** A tread's block thickness (thick enough to be solid). */
const TREAD = 0.12;

interface Side {
  /** Direction of travel along the side, and the side's outward normal. */
  readonly d: Vec3;
  readonly o: Vec3;
}

/** Up the right side going back, the back going left, the left going forward, the front going right. */
const SIDES: readonly Side[] = [
  { d: [0, 0, -1], o: [1, 0, 0] },
  { d: [-1, 0, 0], o: [0, 0, -1] },
  { d: [0, 0, 1], o: [-1, 0, 0] },
  { d: [1, 0, 0], o: [0, 0, 1] },
];

function at(side: Side, along: number, across: number, y: number): Vec3 {
  return [side.d[0] * along + side.o[0] * across, y, side.d[2] * along + side.o[2] * across];
}

/** An axis-aligned box from a side's (along, across) ranges. */
function sideBox(
  b: KitBuilder, side: Side, a0: number, a1: number, c0: number, c1: number, y0: number, y1: number,
  surface: StructureSurface, colour: number, faces: number, indoor = 0,
): void {
  const p = at(side, a0, c0, 0);
  const q = at(side, a1, c1, 0);
  b.box(Math.min(p[0], q[0]), Math.max(p[0], q[0]), y0, y1, Math.min(p[2], q[2]), Math.max(p[2], q[2]), surface, colour, faces, indoor);
}

function sideSolid(b: KitBuilder, side: Side, a0: number, a1: number, c0: number, c1: number, y0: number, y1: number, material: StructureColliderMaterial): void {
  const p = at(side, a0, c0, 0);
  const q = at(side, a1, c1, 0);
  b.solid(Math.min(p[0], q[0]), Math.max(p[0], q[0]), y0, y1, Math.min(p[2], q[2]), Math.max(p[2], q[2]), material);
}

interface StairRun {
  /** Inner and outer edge of the band, across from the centre. */
  readonly c0: number;
  readonly c1: number;
  /** The side's run between the corner squares: from -half to +half along. */
  readonly half: number;
  /** Corner squares span [half, half + (c1 - c0)] along. */
  readonly from: number;
  readonly to: number;
  readonly material: StructureColliderMaterial;
  readonly surface: StructureSurface;
  readonly colour: number;
  readonly railColour: number;
  /** Railing on the outer edge (open towers) or the inner edge (the lighthouse's void). */
  readonly railOuter: boolean;
  readonly indoor: number;
}

/**
 * Flights round the four sides from `from` up to `to`: each side starts with
 * a flight and carries on as a walkway to the next corner square. Returns
 * the side the last flight climbs and the along position its walkway starts.
 */
function windingStair(b: KitBuilder, run: StairRun): { side: number; walkFrom: number; cornerTops: number[] } {
  const total = run.to - run.from;
  const risers = Math.max(1, Math.round(total / 0.18));
  const rise = total / risers;
  const flights = Math.ceil(risers / FLIGHT_RISERS);
  let level = run.from;
  let done = 0;
  const cornerTops = [NaN, NaN, NaN, NaN];
  let last = { side: 0, walkFrom: -run.half, cornerTops };
  for (let j = 0; j < flights; j += 1) {
    const side = SIDES[j % 4]!;
    const k = Math.min(FLIGHT_RISERS, risers - done);
    const start = -run.half;
    const flightEnd = start + Math.max(0, k - 1) * STRUCTURE_STAIR_TREAD;
    const top = level + k * rise;
    if (b.closed && k > 1) {
      // Seen from outside a flight is a sloped slab between its stringers: one box.
      const mid = (run.c0 + run.c1) * 0.5;
      const a0 = at(side, start - 0.1, mid, level - 0.12);
      const a1 = at(side, flightEnd, mid, top - TREAD - 0.02);
      beam(b, a0, a1, 0.22, "timber", shade(run.colour, 0.85), FACE.long, run.indoor, run.c1 - run.c0);
    }
    // Treads 1..k-1; the k-th riser lands on the walkway.
    for (let i = 1; i < k && !b.closed; i += 1) {
      const top = level + i * rise;
      const a0 = start + (i - 1) * STRUCTURE_STAIR_TREAD;
      const a1 = start + i * STRUCTURE_STAIR_TREAD;
      sideBox(b, side, a0, a1, run.c0, run.c1, top - TREAD, top, run.surface, run.colour, FACE.all, run.indoor);
      sideSolid(b, side, a0, a1, run.c0, run.c1, top - TREAD, top, run.material);
    }
    // Stringers under the treads on both edges.
    if (b.open) {
      for (const c of [run.c0 + 0.03, run.c1 - 0.03]) {
        beam(b, at(side, start - 0.1, c, level - 0.1), at(side, flightEnd, c, top - 0.05), 0.22, "timber", shade(run.colour, 0.8), FACE.all, run.indoor, 0.06);
      }
    }
    // The walkway to the end of the side and the corner square beyond it.
    const band = run.c1 - run.c0;
    sideBox(b, side, flightEnd, run.half + band, run.c0, run.c1, top - TREAD, top, run.surface, run.colour, b.open ? FACE.all : FACE.py | FACE.ny | outwardFace(side), run.indoor);
    sideSolid(b, side, flightEnd, run.half + band, run.c0, run.c1, top - TREAD, top, run.material);
    if (b.closed) {
      // The closed level's railings: the top rails alone.
      const rc = run.railOuter ? run.c1 - 0.04 : run.c0 + 0.04;
      const h = STRUCTURE_RAILING_HEIGHT - 0.045;
      beam(b, at(side, start, rc, level + h), at(side, flightEnd, rc, top + h), 0.08, "timber", run.railColour, FACE.long, run.indoor, 0.07);
      const far = run.half + (run.railOuter ? band : 0);
      beam(b, at(side, flightEnd, rc, top + h), at(side, far, rc, top + h), 0.08, "timber", run.railColour, FACE.long, run.indoor, 0.07);
      if (run.railOuter) {
        const next = SIDES[(j + 1) % 4]!;
        beam(b, at(side, far - 0.04, rc, top + h), at(next, -run.half, rc, top + h), 0.08, "timber", run.railColour, FACE.long, run.indoor, 0.07);
      }
    } else if (b.open) {
      const rc = run.railOuter ? run.c1 - 0.04 : run.c0 + 0.04;
      // Railing up the flight and along the walkway.
      const r0 = at(side, start, rc, level + STRUCTURE_RAILING_HEIGHT - 0.045);
      const r1 = at(side, flightEnd, rc, top + STRUCTURE_RAILING_HEIGHT - 0.045);
      beam(b, r0, r1, 0.08, "timber", run.railColour, FACE.all, run.indoor, 0.07);
      b.capsule(r0, r1, 0.05, "fence");
      railing(b, at(side, flightEnd, rc, 0), at(side, run.half + (run.railOuter ? band : 0), rc, 0), top, STRUCTURE_RAILING_HEIGHT, run.railColour, run.indoor, false);
      if (run.railOuter) {
        // Round the corner square's outer side.
        const next = SIDES[(j + 1) % 4]!;
        const cornerA = at(side, run.half + band - 0.04, run.c1 - 0.04, 0);
        const cornerB = at(next, -run.half, run.c1 - 0.04, 0);
        railing(b, cornerA, cornerB, top, STRUCTURE_RAILING_HEIGHT, run.railColour, run.indoor, false);
      }
    }
    last = { side: j % 4, walkFrom: flightEnd, cornerTops };
    cornerTops[j % 4] = Math.max(Number.isNaN(cornerTops[j % 4]!) ? -Infinity : cornerTops[j % 4]!, top);
    level = top;
    done += k;
  }
  return last;
}

export function buildTower(b: KitBuilder, record: StructureRecord, look: StructureLook): void {
  if (record.archetype === "lighthouse") buildLighthouse(b, record, look);
  else buildOpenTower(b, record, look);
}

// --- Watchtower and lookout ----------------------------------------------------------------

function buildOpenTower(b: KitBuilder, record: StructureRecord, look: StructureLook): void {
  const lookout = record.archetype === "lookout";
  const hw = record.width * 0.5;
  const hd = record.depth * 0.5;
  const half = Math.min(hw, hd);
  const levels = Math.max(lookout ? 3 : 1, record.storeys);
  const H = levels * STOREY_HEIGHT;
  const entry = record.entryY - record.floorY;
  const base = record.baseY - record.floorY;
  const steel = lookout && !(record.style === "boreal" || record.style === "tundra");
  const legColour = steel ? 0x8e928e : shade(look.timberColour, 1.1);
  const legSurface: StructureSurface = steel ? "steel" : "timber";
  const legMaterial: StructureColliderMaterial = steel ? "metal" : "timber";
  const leg = steel ? 0.2 : 0.26;
  const inset = leg * 0.5 + 0.05;
  const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const deckColour = shade(look.timberColour, 1.3);
  const cabH = lookout ? 2.6 : 2.4;
  const eaveY = H + cabH + 0.1;
  const roof: RoofSpec = {
    form: "hip", ridge: "x", halfW: hw, halfD: hd, pitch: (lookout ? 28 : 32) * Math.PI / 180, rake: 0.42, eaveY,
    covering: look.roof === "slate" || look.roof === "tile" ? "metal" : look.roof, colour: look.roofColour,
    trimColour: look.trimColour, soffitColour: shade(look.timberColour, 1.25), gableSurface: "boards", gableColour: look.wallColour,
  };
  const g = roofGeometry(roof);

  // Footings and legs.
  for (const [sx, sz] of corners) {
    const x = sx * (hw - inset);
    const z = sz * (hd - inset);
    if (b.block) {
      // A watchtower's legs run on up as its roof posts (the block level's roof sits on them).
      const legTop = lookout ? H : eaveY;
      b.box(x - leg * 0.5, x + leg * 0.5, entry, legTop, z - leg * 0.5, z + leg * 0.5, legSurface, legColour, FACE.sides);
      continue;
    }
    b.box(x - 0.35, x + 0.35, base, 0.08, z - 0.35, z + 0.35, "concrete", 0x9a958c, FACE.all & ~FACE.ny);
    b.solid(x - 0.35, x + 0.35, base, 0.08, z - 0.35, z + 0.35, "stone");
    b.box(x - leg * 0.5, x + leg * 0.5, 0.08, H, z - leg * 0.5, z + leg * 0.5, legSurface, legColour, FACE.sides);
    b.capsule([x, 0.08, z], [x, H, z], leg * 0.5, legMaterial);
  }
  if (!b.block) {
    // Girts at every level and an X brace in every panel.
    for (let level = 1; level <= levels; level += 1) {
      const y = level * STOREY_HEIGHT - 0.1;
      const y0 = (level - 1) * STOREY_HEIGHT + 0.2;
      for (let i = 0; i < 4; i += 1) {
        const [ax, az] = corners[i]!;
        const [cx, cz] = corners[(i + 1) % 4]!;
        const a: Vec3 = [ax * (hw - inset), y, az * (hd - inset)];
        const c: Vec3 = [cx * (hw - inset), y, cz * (hd - inset)];
        beam(b, a, c, 0.16, legSurface, shade(legColour, 0.95), FACE.long, 0, 0.12);
        const a0: Vec3 = [ax * (hw - inset), y0, az * (hd - inset)];
        const c0: Vec3 = [cx * (hw - inset), y0, cz * (hd - inset)];
        beam(b, a0, c, 0.12, legSurface, shade(legColour, 0.9), FACE.long, 0, 0.08);
        beam(b, c0, a, 0.12, legSurface, shade(legColour, 0.9), FACE.long, 0, 0.08);
      }
    }
  }
  // The platform (or cab floor) and the stair round the tower.
  const deckHalfX = hw + 0.02;
  const deckHalfZ = hd + 0.02;
  b.box(-deckHalfX, deckHalfX, H - 0.18, H, -deckHalfZ, deckHalfZ, "floor", deckColour, b.block ? FACE.all & ~FACE.ny : FACE.all);
  b.solid(-deckHalfX, deckHalfX, H - 0.18, H, -deckHalfZ, deckHalfZ, "timber");
  const run: StairRun = {
    c0: half + BAND_GAP, c1: half + BAND_GAP + BAND_WIDTH, half: half + BAND_GAP, from: entry, to: H,
    material: "timber", surface: "timber", colour: deckColour, railColour: shade(look.timberColour, 1.15), railOuter: true, indoor: 0,
  };
  let arrival = { side: 3, walkFrom: -run.half };
  if (!b.block) {
    const stair = windingStair(b, run);
    arrival = stair;
    // Outer posts under the corner squares, from the ground to the highest landing's railing there.
    // The square after side j: right-back, back-left, left-front, front-right.
    const cornerOf: readonly [number, number][] = [[1, -1], [-1, -1], [-1, 1], [1, 1]];
    for (let j = 0; j < 4; j += 1) {
      const landing = stair.cornerTops[j]!;
      if (Number.isNaN(landing)) continue;
      const [sx, sz] = cornerOf[j]!;
      const r = half + BAND_GAP + BAND_WIDTH - 0.06;
      const postTop = landing + STRUCTURE_RAILING_HEIGHT;
      b.box(sx * r - 0.06, sx * r + 0.06, entry - 0.1, postTop, sz * r - 0.06, sz * r + 0.06, "timber", shade(look.timberColour, 1.0), FACE.all & ~FACE.ny);
      b.solid(sx * r - 0.06, sx * r + 0.06, entry - 0.1, postTop, sz * r - 0.06, sz * r + 0.06, "timber");
    }
  }
  const arrivalSide = SIDES[arrival.side]!;

  if (lookout) {
    buildCab(b, record, look, hw, hd, H, cabH, arrivalSide, run);
  } else {
    // Roof posts at the corners and a railing round the platform, open towards the arrival walkway.
    for (const [sx, sz] of corners) {
      if (b.block) break;
      const x = sx * (hw - 0.08);
      const z = sz * (hd - 0.08);
      b.box(x - 0.08, x + 0.08, H, eaveY + 0.2, z - 0.08, z + 0.08, "timber", shade(look.timberColour, 1.05), FACE.sides);
      b.capsule([x, H, z], [x, eaveY, z], 0.08, "timber");
    }
    if (!b.block) {
      for (let i = 0; i < 4; i += 1) {
        const side = SIDES[i]!;
        if (side === arrivalSide) continue;
        railing(b, at(side, -half + 0.1, half - 0.08, 0), at(side, half - 0.1, half - 0.08, 0), H, STRUCTURE_RAILING_HEIGHT, shade(look.timberColour, 1.15), 0);
      }
    }
    b.volume("platform", -hw, hw, H, eaveY - 0.05, -hd, hd);
    const mid = (arrival.walkFrom + run.half) * 0.5;
    const p = at(arrivalSide, mid, half, H);
    b.portal({ x: p[0], y: H, z: p[2], nx: arrivalSide.o[0], nz: arrivalSide.o[2], width: Math.max(STRUCTURE_DOOR_WIDTH, run.half - arrival.walkFrom - 0.1), height: Math.min(2.3, eaveY - H - 0.05), open: true, outside: true });
  }
  drawRoof(b, roof);
  b.solid(-g.planHalfX, g.planHalfX, eaveY, g.topY, -g.planHalfZ, g.planHalfZ, roof.covering === "metal" ? "metal" : "timber");
}

/** A lookout's cab: walls with windows all round, a door onto the top walkway, the fire-finder table. */
function buildCab(b: KitBuilder, record: StructureRecord, look: StructureLook, hw: number, hd: number, H: number, cabH: number, arrivalSide: Side, run: StairRun): void {
  const t = 0.12;
  const wallTop = H + cabH + 0.1;
  const colour = look.style === "boreal" || look.style === "tundra" ? look.wallColour : 0xd8d4c8;
  const trim = look.trimColour;
  const sill = 0.95;
  const winTop = 2.3;
  const doorSide = SIDES.indexOf(arrivalSide);
  const doorAlong = Math.min(run.half - 0.6, Math.max(-run.half + 0.6, (run.half + 0.0) * 0.4));
  const half = Math.min(hw, hd);
  if (b.block) {
    b.box(-hw, hw, H, wallTop, -hd, hd, "boards", colour, FACE.sides);
    return;
  }
  // The windows and door first: the indoor light needs them.
  const windows: { side: number; a0: number; a1: number }[] = [];
  for (let i = 0; i < 4; i += 1) {
    const span = half - t - 0.25;
    if (i === doorSide) {
      // Beside the door, one window.
      const d0 = doorAlong - STRUCTURE_DOOR_WIDTH * 0.5 - 0.2;
      if (d0 - (-span) > 0.9) windows.push({ side: i, a0: -span, a1: d0 });
    } else {
      windows.push({ side: i, a0: -span, a1: -0.06 });
      windows.push({ side: i, a0: 0.06, a1: span });
    }
  }
  const room = { minX: -hw + t, maxX: hw - t, minY: H, maxY: H + cabH, minZ: -hd + t, maxZ: hd - t };
  b.volume("cab", room.minX, room.maxX, room.minY, room.maxY, room.minZ, room.maxZ);
  const doorPoint = at(arrivalSide, doorAlong, half - t * 0.5, H);
  b.portal({ x: doorPoint[0], y: H, z: doorPoint[2], nx: arrivalSide.o[0], nz: arrivalSide.o[2], width: STRUCTURE_DOOR_WIDTH, height: STRUCTURE_DOOR_HEIGHT, open: true, outside: true });
  for (const w of windows) {
    const side = SIDES[w.side]!;
    const c = at(side, (w.a0 + w.a1) * 0.5, half, H + (sill + winTop) * 0.5);
    b.windowLight({ x: c[0], y: c[1], z: c[2], nx: side.o[0], nz: side.o[2], width: w.a1 - w.a0, height: winTop - sill });
  }
  const light = b.open ? structureIndoorLight({ colliders: [], volumes: b.volumes, portals: b.portals, windows: b.windows }) : null;
  const indoor = light ? light.roomMean(b.volumes[b.volumes.length - 1]!) : 0;
  for (let i = 0; i < 4; i += 1) {
    const side = SIDES[i]!;
    const holes = windows.filter((w) => w.side === i).map((w) => ({ s0: w.a0, s1: w.a1, y0: H + sill, y1: H + winTop }));
    if (i === doorSide) holes.push({ s0: doorAlong - STRUCTURE_DOOR_WIDTH * 0.5, s1: doorAlong + STRUCTURE_DOOR_WIDTH * 0.5, y0: H, y1: H + STRUCTURE_DOOR_HEIGHT });
    // Each side's wall runs between the next side's: the run is [-half, half] along, [half - t, half] across.
    const a0 = i % 2 === 0 ? -half + t : -half;
    const a1 = i % 2 === 0 ? half - t : half;
    for (const piece of decompose(a0, a1, H, wallTop, holes, [])) {
      const solidOpen = b.open;
      if (solidOpen) {
        sideBox(b, side, piece.a, piece.c, half - t, half, piece.y0, piece.y1, "boards", colour, outwardFace(side) | endFaces(side, piece, a0, a1, i));
        sideBox(b, side, piece.a, piece.c, half - t, half, piece.y0, piece.y1, "trim", trim, revealFaces(side, piece));
        sideBox(b, side, piece.a, piece.c, half - t, half, Math.max(piece.y0, H), Math.min(piece.y1, H + cabH), "plaster", 0xe4ded0, inwardFace(side), indoor);
        sideSolid(b, side, piece.a, piece.c, half - t, half, piece.y0, piece.y1, "timber");
      }
    }
    if (!b.open) {
      sideBox(b, side, a0, a1, half - t, half, H, wallTop, "boards", colour, outwardFace(side) | (i % 2 === 1 ? endBoth(side) : 0));
    }
    for (const hole of holes) {
      const isDoor = hole.y0 <= H + 1e-6;
      if (!b.open) {
        const p0 = at(side, hole.s0, half + 0.004, hole.y0);
        const p1 = at(side, hole.s1, half + 0.004, hole.y0);
        const p2 = at(side, hole.s1, half + 0.004, hole.y1);
        const p3 = at(side, hole.s0, half + 0.004, hole.y1);
        pushFacing(b, [p0, p1, p2, p3], side.o, isDoor ? "doorway" : "window", isDoor ? look.doorwayColour : look.glazingColour);
      } else if (!isDoor) {
        const g0 = half - 0.07;
        const g1 = half - 0.058;
        sideBox(b, side, hole.s0, hole.s1, g0, g1, hole.y0, hole.y1, "glass", 0x9fb4bc, outwardFace(side) | inwardFace(side));
        sideSolid(b, side, hole.s0, hole.s1, g0, g1, hole.y0, hole.y1, "glass");
        sideBox(b, side, (hole.s0 + hole.s1) * 0.5 - 0.03, (hole.s0 + hole.s1) * 0.5 + 0.03, g0 - 0.01, g1 + 0.01, hole.y0, hole.y1, "trim", trim, outwardFace(side) | inwardFace(side));
      }
      // A sill outside every window.
      if (!isDoor) sideBox(b, side, hole.s0 - 0.04, hole.s1 + 0.04, half, half + 0.06, hole.y0 - 0.06, hole.y0, "trim", trim, FACE.all & ~inwardFace(side));
    }
  }
  if (b.open) {
    // Ceiling, the fire-finder on its stand, a stool; and the door leaf open against the wall.
    b.box(-hw + t, hw - t, H + cabH, H + cabH + 0.03, -hd + t, hd - t, "boards", 0xcdb48c, FACE.ny, indoor);
    b.solid(-hw + t, hw - t, H + cabH, wallTop, -hd + t, hd - t, "timber");
    b.box(-0.45, 0.45, H, H + 1.0, -0.45, 0.45, "timber", shade(look.timberColour, 1.2), FACE.all & ~FACE.ny, indoor);
    b.box(-0.35, 0.35, H + 1.0, H + 1.12, -0.35, 0.35, "steel", 0x6a6a64, FACE.all, indoor);
    b.solid(-0.45, 0.45, H, H + 1.12, -0.45, 0.45, "timber");
    const leafA = doorAlong + STRUCTURE_DOOR_WIDTH * 0.5 + 0.01;
    if (leafA + STRUCTURE_DOOR_WIDTH < half - t) {
      sideBox(b, arrivalSide, leafA, leafA + STRUCTURE_DOOR_WIDTH, half - t - 0.05, half - t - 0.005, H + 0.01, H + STRUCTURE_DOOR_HEIGHT - 0.01, "boards", look.doorColour, FACE.all & ~FACE.ny, indoor);
    }
    // The walkway's railing goes round the top: the cab sits inside the gallery the stair band makes.
    const railColour = shade(look.timberColour, 1.15);
    for (let i = 0; i < 4; i += 1) {
      const side = SIDES[i]!;
      if (side === arrivalSide) continue;
      const c1 = run.c1;
      railing(b, at(side, -run.half, c1 - 0.04, 0), at(side, run.half + (c1 - run.c0), c1 - 0.04, 0), H, STRUCTURE_RAILING_HEIGHT, railColour, 0, false);
      sideBox(b, side, -run.half, run.half + (c1 - run.c0), run.c0, run.c1, H - TREAD, H, "timber", shade(look.timberColour, 1.3), FACE.all);
      sideSolid(b, side, -run.half, run.half + (c1 - run.c0), run.c0, run.c1, H - TREAD, H, "timber");
    }
  } else {
    // The closed cab's catwalk, as a band round the top.
    for (let i = 0; i < 4; i += 1) {
      const side = SIDES[i]!;
      sideBox(b, side, -run.half, run.half + (run.c1 - run.c0), run.c0, run.c1, H - TREAD, H, "timber", shade(look.timberColour, 1.3), FACE.all & ~FACE.ny);
    }
  }
  void record;
}

function outwardFace(side: Side): number {
  return side.o[0] > 0 ? FACE.px : side.o[0] < 0 ? FACE.nx : side.o[2] > 0 ? FACE.pz : FACE.nz;
}

function inwardFace(side: Side): number {
  return side.o[0] > 0 ? FACE.nx : side.o[0] < 0 ? FACE.px : side.o[2] > 0 ? FACE.nz : FACE.pz;
}

/** The faces at a side's run ends (both), in world bits. */
function endBoth(side: Side): number {
  return Math.abs(side.d[0]) > 0 ? FACE.px | FACE.nx : FACE.pz | FACE.nz;
}

function endFaces(side: Side, piece: { a: number; c: number }, a0: number, a1: number, index: number): number {
  if (index % 2 === 0) return 0;
  let f = 0;
  const lo = side.d[0] + side.d[2] > 0 ? (Math.abs(side.d[0]) > 0 ? FACE.nx : FACE.nz) : (Math.abs(side.d[0]) > 0 ? FACE.px : FACE.pz);
  const hi = side.d[0] + side.d[2] > 0 ? (Math.abs(side.d[0]) > 0 ? FACE.px : FACE.pz) : (Math.abs(side.d[0]) > 0 ? FACE.nx : FACE.nz);
  if (Math.abs(piece.a - a0) < 1e-6) f |= lo;
  if (Math.abs(piece.c - a1) < 1e-6) f |= hi;
  return f;
}

function revealFaces(side: Side, piece: { lo: boolean; hi: boolean; bottom: boolean; top: boolean }): number {
  const lo = side.d[0] + side.d[2] > 0 ? (Math.abs(side.d[0]) > 0 ? FACE.nx : FACE.nz) : (Math.abs(side.d[0]) > 0 ? FACE.px : FACE.pz);
  const hi = side.d[0] + side.d[2] > 0 ? (Math.abs(side.d[0]) > 0 ? FACE.px : FACE.pz) : (Math.abs(side.d[0]) > 0 ? FACE.nx : FACE.nz);
  return (piece.lo ? lo : 0) | (piece.hi ? hi : 0) | (piece.bottom ? FACE.ny : 0) | (piece.top ? FACE.py : 0);
}

// --- Lighthouse ----------------------------------------------------------------------------

function buildLighthouse(b: KitBuilder, record: StructureRecord, look: StructureLook): void {
  const hw = record.width * 0.5;
  const hd = record.depth * 0.5;
  const half = Math.min(hw, hd);
  const t = 0.4;
  const levels = Math.max(3, record.storeys);
  const H = levels * STOREY_HEIGHT;
  const entry = record.entryY - record.floorY;
  const base = record.baseY - record.floorY;
  const stone = look.wall === "stone";
  const wallSurface: StructureSurface = stone ? "stone" : "render";
  const wallColour = look.wallColour;
  const band = stone ? shade(look.wallColour, 0.75) : (record.seed & 1 ? 0xa83228 : 0x2a2b2c);
  const lampH = 2.6;
  const eaveY = H + lampH + 0.15;
  const roof: RoofSpec = {
    form: "hip", ridge: "x", halfW: half, halfD: half, pitch: 35 * Math.PI / 180, rake: 0.42, eaveY,
    covering: "metal", colour: band === 0xa83228 ? 0xa83228 : 0x2e3032, trimColour: 0xe8e6e0, soffitColour: 0xd8d4cc, gableSurface: "render", gableColour: wallColour,
  };
  const g = roofGeometry(roof);
  const doorS = 0;
  const inner = half - t;
  const windowSides = Array.from({ length: levels }, (_, k) => k % 4);

  // Openings: the door at the front, one small window a level.
  const holesFor = (i: number) => {
    const out: { s0: number; s1: number; y0: number; y1: number }[] = [];
    if (i === 3) out.push({ s0: doorS - STRUCTURE_DOOR_WIDTH * 0.5, s1: doorS + STRUCTURE_DOOR_WIDTH * 0.5, y0: 0, y1: STRUCTURE_DOOR_HEIGHT });
    windowSides.forEach((side, k) => {
      if (side !== i || k === 0) return;
      const y = k * STOREY_HEIGHT + 1.5;
      out.push({ s0: -0.28, s1: 0.28, y0: y, y1: y + 0.85 });
    });
    return out;
  };
  if (b.open) {
    b.volume("shaft", -inner, inner, 0, H - 0.25, -inner, inner);
    b.volume("lamp room", -half + 0.12, half - 0.12, H, H + lampH, -half + 0.12, half - 0.12);
    b.portal({ x: 0, y: 0, z: half - t * 0.5, nx: 0, nz: 1, width: STRUCTURE_DOOR_WIDTH, height: STRUCTURE_DOOR_HEIGHT, open: true, outside: true });
    b.portal({ x: 0, y: H, z: half - 0.06, nx: 0, nz: 1, width: STRUCTURE_DOOR_WIDTH, height: STRUCTURE_DOOR_HEIGHT, open: true, outside: true });
    for (let i = 0; i < 4; i += 1) {
      const side = SIDES[i]!;
      for (const h of holesFor(i)) {
        if (h.y0 <= 0) continue;
        const c = at(side, (h.s0 + h.s1) * 0.5, half, (h.y0 + h.y1) * 0.5);
        b.windowLight({ x: c[0], y: c[1], z: c[2], nx: side.o[0], nz: side.o[2], width: h.s1 - h.s0, height: h.y1 - h.y0 });
      }
      const c = at(side, 0, half - 0.06, H + 1.6);
      b.windowLight({ x: c[0], y: c[1], z: c[2], nx: side.o[0], nz: side.o[2], width: 2 * half - 0.6, height: 1.5 });
    }
  }
  const light = b.open ? structureIndoorLight({ colliders: [], volumes: b.volumes, portals: b.portals, windows: b.windows }) : null;
  const shaftIndoor = light ? Math.max(0.1, light.roomMean(b.volumes[0]!)) : 0;
  const lampIndoor = light ? light.roomMean(b.volumes[1]!) : 0;

  // Footing and shaft.
  if (b.block) {
    b.box(-half, half, entry, H, -half, half, wallSurface, wallColour, FACE.sides);
  } else {
    b.box(-half - 0.08, half + 0.08, base, 0.1, -half - 0.08, half + 0.08, "stone", look.plinthColour, FACE.all & ~FACE.ny);
    b.solid(-half - 0.08, half + 0.08, base, 0, -half - 0.08, half + 0.08, "stone");
    for (let i = 0; i < 4; i += 1) {
      const side = SIDES[i]!;
      const a0 = i % 2 === 0 ? -half + t : -half;
      const a1 = i % 2 === 0 ? half - t : half;
      const holes = holesFor(i);
      if (!b.open) {
        sideBox(b, side, a0, a1, half - t, half, 0.1, H, wallSurface, wallColour, outwardFace(side) | (i % 2 === 1 ? endBoth(side) : 0));
        for (const h of holes) {
          const isDoor = h.y0 <= 0;
          const p0 = at(side, h.s0, half + 0.004, h.y0);
          const p1 = at(side, h.s1, half + 0.004, h.y0);
          const p2 = at(side, h.s1, half + 0.004, h.y1);
          const p3 = at(side, h.s0, half + 0.004, h.y1);
          pushFacing(b, [p0, p1, p2, p3], side.o, isDoor ? "doorway" : "window", isDoor ? look.doorwayColour : look.glazingColour);
        }
      } else {
        for (const piece of decompose(a0, a1, 0.1, H, holes, [])) {
          sideBox(b, side, piece.a, piece.c, half - t, half, piece.y0, piece.y1, wallSurface, wallColour, outwardFace(side) | endFaces(side, piece, a0, a1, i) | revealFaces(side, piece));
          sideBox(b, side, piece.a, piece.c, half - t, half, piece.y0, piece.y1, "plaster", 0xe2ddd2, inwardFace(side), shaftIndoor);
          sideSolid(b, side, piece.a, piece.c, half - t, half, piece.y0, piece.y1, "stone");
        }
        for (const h of holes) {
          if (h.y0 <= 0) continue;
          sideBox(b, side, h.s0, h.s1, half - 0.1, half - 0.088, h.y0, h.y1, "glass", 0x9fb4bc, outwardFace(side) | inwardFace(side));
          sideSolid(b, side, h.s0, h.s1, half - 0.1, half - 0.088, h.y0, h.y1, "glass");
        }
      }
      // Door and window surrounds in the band colour.
      for (const h of holes) {
        const isDoor = h.y0 <= 0;
        sideBox(b, side, h.s0 - 0.12, h.s1 + 0.12, half, half + 0.04, h.y1, h.y1 + 0.16, "trim", isDoor ? band : shade(wallColour, 0.9), FACE.all & ~inwardFace(side));
        if (!isDoor) sideBox(b, side, h.s0 - 0.06, h.s1 + 0.06, half, half + 0.06, h.y0 - 0.07, h.y0, "trim", shade(wallColour, 0.9), FACE.all & ~inwardFace(side));
      }
    }
    // Front steps from the pad.
    const steps = Math.max(1, Math.round(-entry / 0.18));
    const rise = -entry / steps;
    for (let i = 1; i < steps; i += 1) {
      b.box(-0.8, 0.8, entry - 0.15, -i * rise, half + (i - 1) * STRUCTURE_STAIR_TREAD, half + i * STRUCTURE_STAIR_TREAD, "concrete", 0x9a958c, FACE.py | FACE.pz | FACE.px | FACE.nx);
      b.solid(-0.8, 0.8, entry - 0.15, -i * rise, half + (i - 1) * STRUCTURE_STAIR_TREAD, half + i * STRUCTURE_STAIR_TREAD, "stone");
    }
  }

  // The gallery: the shaft's top slab, cantilevered out, with a railing.
  const out = half + 0.5;
  b.box(-out, out, H - 0.25, H, -out, out, "concrete", band, b.block ? FACE.all & ~FACE.ny : FACE.all);
  if (!b.block) {
    // Cut round the stair's arrival: the slab inside the shaft is drawn and solid only outside the well.
    b.solid(-out, out, H - 0.25, H, -out, inner - 0.95, "stone");
    b.solid(-out, -inner + 0.95, H - 0.25, H, inner - 0.95, out, "stone");
    b.solid(inner, out, H - 0.25, H, inner - 0.95, out, "stone");
    b.solid(-inner + 0.95, inner, H - 0.25, H, inner, out, "stone");
    for (let i = 0; i < 4; i += 1) {
      const side = SIDES[i]!;
      railing(b, at(side, -out + 0.05, out - 0.05, 0), at(side, out - 0.05, out - 0.05, 0), H, STRUCTURE_RAILING_HEIGHT, 0x2a2b2c, 0, false);
    }
  }

  // The lamp room: a low wall, glazing all round, a door onto the gallery at the front.
  const lw = 0.12;
  const parapet = 0.9;
  if (b.block) {
    b.box(-half + 0.1, half - 0.1, H, eaveY, -half + 0.1, half - 0.1, "window", look.glazingColour, FACE.sides);
  } else {
    for (let i = 0; i < 4; i += 1) {
      const side = SIDES[i]!;
      const edge = half - 0.1;
      const a0 = i % 2 === 0 ? -edge + lw : -edge;
      const a1 = i % 2 === 0 ? edge - lw : edge;
      const doorHere = i === 3;
      const holes = doorHere ? [{ s0: -STRUCTURE_DOOR_WIDTH * 0.5, s1: STRUCTURE_DOOR_WIDTH * 0.5, y0: H, y1: H + STRUCTURE_DOOR_HEIGHT }] : [];
      for (const piece of decompose(a0, a1, H, H + parapet, holes, [])) {
        sideBox(b, side, piece.a, piece.c, edge - lw, edge, piece.y0, piece.y1, "render", band, outwardFace(side) | FACE.py | endFaces(side, piece, a0, a1, i) | revealFaces(side, piece));
        if (b.open) {
          sideBox(b, side, piece.a, piece.c, edge - lw, edge, piece.y0, piece.y1, "plaster", 0xe2ddd2, inwardFace(side), lampIndoor);
          sideSolid(b, side, piece.a, piece.c, edge - lw, edge, piece.y0, piece.y1, "stone");
        }
      }
      // Glazing between the parapet and the eave, in four panes a side.
      const g0 = H + parapet;
      const g1 = eaveY - 0.05;
      const panes = 3;
      for (let p = 0; p < panes; p += 1) {
        const s0 = a0 + ((a1 - a0) * p) / panes;
        const s1 = a0 + ((a1 - a0) * (p + 1)) / panes;
        const paneLo = doorHere && s0 < STRUCTURE_DOOR_WIDTH * 0.5 && s1 > -STRUCTURE_DOOR_WIDTH * 0.5 ? H + STRUCTURE_DOOR_HEIGHT : g0;
        if (b.open) {
          sideBox(b, side, s0 + 0.03, s1 - 0.03, edge - 0.07, edge - 0.058, paneLo, g1, "glass", 0x9fb4bc, outwardFace(side) | inwardFace(side));
          sideSolid(b, side, s0 + 0.03, s1 - 0.03, edge - 0.07, edge - 0.058, paneLo, g1, "glass");
        } else {
          const p0 = at(side, s0 + 0.03, edge - 0.06, paneLo);
          const p1 = at(side, s1 - 0.03, edge - 0.06, paneLo);
          const p2 = at(side, s1 - 0.03, edge - 0.06, g1);
          const p3 = at(side, s0 + 0.03, edge - 0.06, g1);
          pushFacing(b, [p0, p1, p2, p3], side.o, "window", look.glazingColour);
        }
        // Mullions between panes.
        sideBox(b, side, s0 - 0.03, s0 + 0.03, edge - 0.1, edge - 0.02, g0, g1, "steel", 0x2a2b2c, FACE.all & ~FACE.py & ~FACE.ny);
      }
      if (doorHere && b.closed) {
        const p0 = at(side, -STRUCTURE_DOOR_WIDTH * 0.5, edge + 0.004, H);
        const p1 = at(side, STRUCTURE_DOOR_WIDTH * 0.5, edge + 0.004, H);
        const p2 = at(side, STRUCTURE_DOOR_WIDTH * 0.5, edge + 0.004, H + STRUCTURE_DOOR_HEIGHT);
        const p3 = at(side, -STRUCTURE_DOOR_WIDTH * 0.5, edge + 0.004, H + STRUCTURE_DOOR_HEIGHT);
        pushFacing(b, [p0, p1, p2, p3], side.o, "doorway", look.doorwayColour);
      }
    }
    // The lamp on its pedestal.
    b.box(-0.35, 0.35, H, H + 1.0, -0.35, 0.35, "steel", 0x3a3a38, FACE.all & ~FACE.ny, lampIndoor);
    b.box(-0.45, 0.45, H + 1.0, H + 1.9, -0.45, 0.45, "window", 0xd8c890, FACE.all, lampIndoor);
    b.solid(-0.45, 0.45, H, H + 1.9, -0.45, 0.45, "metal");
    b.box(-half + 0.22, half - 0.22, eaveY - 0.15, eaveY - 0.12, -half + 0.22, half - 0.22, "plaster", 0xe8e4dc, FACE.ny, lampIndoor);
  }
  drawRoof(b, roof);
  b.solid(-g.planHalfX, g.planHalfX, eaveY, g.topY, -g.planHalfZ, g.planHalfZ, "metal");

  if (!b.open) return;
  // The stair round the inside of the shaft, the void railed, up through the well into the lamp room.
  const run: StairRun = {
    c0: inner - 0.95, c1: inner, half: inner - 0.95, from: 0, to: H,
    material: "stone", surface: "concrete", colour: 0xa8a49c, railColour: 0x2a2b2c, railOuter: false, indoor: shaftIndoor,
  };
  windingStair(b, run);
  // Floor of the shaft.
  b.box(-inner, inner, -0.05, 0, -inner, inner, "concrete", 0x9a968e, FACE.py, shaftIndoor);
  b.solid(-inner, inner, base, 0, -inner, inner, "stone");
  // The lamp room's floor round the well, and the well's railing.
  b.box(-inner, inner, H - 0.02, H, -inner, inner, "floor", 0x8a6a48, FACE.py, lampIndoor);
  b.box(-inner, inner, H - 0.28, H - 0.25, -inner, inner, "plaster", 0xe2ddd2, FACE.ny, shaftIndoor);
}
