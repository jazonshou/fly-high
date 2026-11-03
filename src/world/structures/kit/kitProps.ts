import type { StructureRecord } from "../structureRecord";
import type { StructureColliderMaterial, StructureSurface } from "../structureModel";
import { STRUCTURE_EAVE_OVERHANG } from "../structureEnvelope";
import { type KitBuilder, FACE, type Vec3, add, beam, scale, shade } from "./kitBuilder";
import { KitChannel, KitRandom } from "./kitRandom";
import { polygonFacing } from "./kitRoof";
import type { StructureLook } from "./kitStyles";

/**
 * Props nobody goes inside: a ranch's windmill pump, its water tank on a
 * stand, a weather station's lattice mast. Thin steel and timber that the
 * closed level draws as members (each wider than a pixel at the distance
 * the closed level is drawn from) and the block level as a few solid
 * shapes. They have no rooms; their colliders are the legs, footings and
 * anything a walker could bump.
 */

const STEEL_GREY = 0x9a9d98;
const GALVANISED = 0xa9ada8;
const CONCRETE = 0x9a958c;
const WHITE_PAINT = 0xe8e6de;
const OBSTRUCTION_RED = 0xc8281e;

export function buildProp(b: KitBuilder, record: StructureRecord, look: StructureLook): void {
  switch (record.archetype) {
    case "windmill":
      buildWindmill(b, record);
      break;
    case "tank":
      buildTank(b, record, look);
      break;
    default:
      buildMast(b, record);
      break;
  }
}

/** A footing pad under a leg, from below the ground to just above the floor line. */
function footing(b: KitBuilder, x: number, z: number, half: number, base: number): void {
  b.box(x - half, x + half, base, 0.08, z - half, z + half, "concrete", CONCRETE, FACE.all & ~FACE.ny);
  b.solid(x - half, x + half, base, 0.08, z - half, z + half, "stone");
}

/** A leg, brace or rod as a beam with a collider when it is thick enough. */
function member(
  b: KitBuilder, a: Vec3, c: Vec3, size: number, surface: StructureSurface, colour: number,
  material: StructureColliderMaterial, faces: number = FACE.long,
): void {
  beam(b, a, c, size, surface, colour, faces);
  b.capsule(a, c, size * 0.5, material);
}

/** Points round a regular polygon in the x-z plane (first corner on +x), counter-clockwise seen from above. */
function ring(sides: number, radius: number, y: number, cx = 0, cz = 0, turn = 0): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < sides; i += 1) {
    const a = turn + (i / sides) * Math.PI * 2;
    // Counter-clockwise from above in a right-handed frame with +y up: x = cos, z = -sin.
    out.push([cx + Math.cos(a) * radius, y, cz - Math.sin(a) * radius]);
  }
  return out;
}

/** A prism's sides between two rings of the same count, each quad facing out. */
function prismSides(b: KitBuilder, lower: readonly Vec3[], upper: readonly Vec3[], cx: number, cz: number, surface: StructureSurface, colour: number): void {
  const n = lower.length;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const a = lower[i]!;
    const c = lower[j]!;
    const mx = (a[0] + c[0]) * 0.5 - cx;
    const mz = (a[2] + c[2]) * 0.5 - cz;
    polygonFacing(b, [a, c, upper[j]!, upper[i]!], [mx, 0, mz], surface, colour);
  }
}

// --- Windmill ------------------------------------------------------------------------------

/**
 * A ranch's windmill pump: a tapered four-legged steel tower with a work
 * platform under the head, a wheel of sheet blades facing the wind, a tail
 * vane, the pump rod down the middle to the pump head, and a stock trough
 * at the foot.
 */
function buildWindmill(b: KitBuilder, record: StructureRecord): void {
  const rng = new KitRandom(record.seed);
  const half = Math.min(record.width, record.depth) * 0.5;
  const spreadBottom = Math.min(1.2, half - 0.3);
  const spreadTop = 0.32;
  const towerH = Math.round(rng.range(KitChannel.mastHeight, 8, 10.5) * 10) / 10;
  const base = record.baseY - record.floorY;
  const ground = record.entryY - record.floorY;
  const turn = rng.range(KitChannel.windmillTurn, 0, Math.PI * 2);
  // The wind axis (the wheel faces along +axis) and the wheel's own across.
  const axis: Vec3 = [Math.sin(turn), 0, Math.cos(turn)];
  const across: Vec3 = [Math.cos(turn), 0, -Math.sin(turn)];
  const wheelR = Math.min(1.5, half + STRUCTURE_EAVE_OVERHANG - 0.62);
  const hubY = towerH + 0.55;
  const legAt = (sx: number, sz: number, y: number): Vec3 => {
    const s = spreadBottom + (spreadTop - spreadBottom) * (y / towerH);
    return [sx * s, y, sz * s];
  };
  const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

  if (b.block) {
    // A tapered frustum for the tower, a disc for the wheel, a plate for the vane.
    const lower = corners.map(([sx, sz]) => legAt(sx, sz, 0.08));
    const upper = corners.map(([sx, sz]) => legAt(sx, sz, towerH));
    prismSides(b, lower.slice().reverse(), upper.slice().reverse(), 0, 0, "steel", GALVANISED);
    drawWheelDisc(b, axis, across, hubY, wheelR);
    drawTail(b, axis, hubY, wheelR, true);
    return;
  }

  // Footings, legs, girts and braces.
  for (const [sx, sz] of corners) {
    const p = legAt(sx, sz, 0);
    footing(b, p[0], p[2], 0.3, base);
    member(b, legAt(sx, sz, 0.08), legAt(sx, sz, towerH), 0.1, "steel", GALVANISED, "metal");
  }
  const bays = Math.max(3, Math.round(towerH / 2.2));
  for (let k = 1; k <= bays; k += 1) {
    const y = (k / bays) * towerH;
    const y0 = ((k - 1) / bays) * towerH + 0.08;
    for (let i = 0; i < 4; i += 1) {
      const [ax, az] = corners[i]!;
      const [cx, cz] = corners[(i + 1) % 4]!;
      beam(b, legAt(ax, az, y), legAt(cx, cz, y), 0.07, "steel", GALVANISED, FACE.long, 0, 0.05);
      // Rod braces cross every panel.
      beam(b, legAt(ax, az, y0), legAt(cx, cz, y), 0.04, "steel", shade(GALVANISED, 0.9), FACE.long);
      beam(b, legAt(cx, cz, y0), legAt(ax, az, y), 0.04, "steel", shade(GALVANISED, 0.9), FACE.long);
    }
  }
  // The work platform under the head, and the ladder up one leg's face to it.
  const platY = towerH - 0.95;
  const platHalf = spreadTop + 0.42;
  b.box(-platHalf, platHalf, platY - 0.06, platY, -platHalf, platHalf, "timber", shade(record.style === "desert" ? 0x9b8a72 : 0x8a7a64, 1), FACE.all);
  b.solid(-platHalf, platHalf, platY - 0.1, platY, -platHalf, platHalf, "timber");
  const ladderSide = Math.cos(turn) >= 0 ? -1 : 1;
  ladder(b, ground, platY, (y) => {
    const p = legAt(ladderSide, 1, y);
    return [p[0] * 0.5, y, p[2] + 0.06];
  }, 0.42, [0, 0, 1]);

  // The head: turntable, gearbox, hub and wheel, tail.
  b.box(-0.2, 0.2, towerH, towerH + 0.12, -0.2, 0.2, "steel", STEEL_GREY, FACE.all);
  const head = add([0, hubY - 0.05, 0], scale(axis, 0.1));
  b.obox(head, scale(across, 0.16), [0, 0.2, 0], scale(axis, 0.42), "steel", STEEL_GREY, FACE.all);
  const hub = add([0, hubY, 0], scale(axis, 0.62));
  b.obox(hub, scale(across, 0.14), [0, 0.14, 0], scale(axis, 0.12), "steel", shade(STEEL_GREY, 0.85), FACE.all);
  drawWheel(b, axis, across, hubY, wheelR);
  drawTail(b, axis, hubY, wheelR, false);
  b.capsule([0, 0.08, 0], [0, towerH + 0.2, 0], 0.1, "metal");

  // The pump rod down the middle, the pump head on the well casing, the pipe and trough.
  beam(b, [0, ground + 0.9, 0], [0, towerH, 0], 0.035, "steel", shade(GALVANISED, 0.8), FACE.long);
  b.box(-0.09, 0.09, ground, ground + 0.95, -0.09, 0.09, "steel", 0x4c4e4a, FACE.standing);
  const tz0 = Math.min(spreadBottom + 0.12, half + STRUCTURE_EAVE_OVERHANG - 0.75);
  b.box(-0.06, 0.06, ground + 0.6, ground + 0.68, 0.09, tz0 + 0.12, "steel", 0x4c4e4a, FACE.all);
  const tz1 = tz0 + 0.62;
  const tx = 0.85;
  const top = ground + 0.62;
  b.box(-tx, tx, ground, top, tz0, tz1, "concrete", 0xa7a196, FACE.standing & ~FACE.py);
  // The rim, and the water in it.
  b.box(-tx, tx, top - 0.05, top, tz0, tz1, "concrete", 0xa7a196, FACE.py);
  b.box(-tx + 0.08, tx - 0.08, top - 0.15, top - 0.08, tz0 + 0.08, tz1 - 0.08, "steel", 0x30444a, FACE.py);
  b.solid(-tx, tx, ground, top, tz0, tz1, "stone");
}

/** The wheel's 16 sheet blades between two rims, each turned a little to the wind. */
function drawWheel(b: KitBuilder, axis: Vec3, across: Vec3, hubY: number, radius: number): void {
  const centre = add([0, hubY, 0], scale(axis, 0.66));
  const blades = 16;
  const inner = radius * 0.32;
  const at = (angle: number, r: number, forward = 0): Vec3 =>
    add(add(centre, scale(across, Math.cos(angle) * r)), add([0, Math.sin(angle) * r, 0], scale(axis, forward)));
  for (let i = 0; i < blades; i += 1) {
    const angle = (i / blades) * Math.PI * 2;
    // A blade from the inner rim to the outer, its face turned 30 degrees off the wheel's plane.
    const radial: Vec3 = [Math.cos(angle) * across[0], Math.sin(angle), Math.cos(angle) * across[2]];
    const tangent: Vec3 = [-Math.sin(angle) * across[0], Math.cos(angle), -Math.sin(angle) * across[2]];
    const tilt = 0.52;
    const widthDir = add(scale(tangent, Math.cos(tilt)), scale(axis, Math.sin(tilt)));
    const thickDir = add(scale(axis, Math.cos(tilt)), scale(tangent, -Math.sin(tilt)));
    const mid = add(centre, scale(radial, (inner + radius) * 0.5));
    const bladeWidth = 2 * Math.PI * radius / blades * 0.62;
    b.obox(mid, scale(radial, (radius - inner) * 0.5), scale(widthDir, bladeWidth * 0.5), scale(thickDir, 0.012), "steel", 0xb6b9b4, FACE.pz | FACE.nz);
  }
  // Two rims as rings of short flat bars, and the arms from the hub.
  for (const r of [inner, radius * 0.97]) {
    const segments = 12;
    for (let i = 0; i < segments; i += 1) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      beam(b, at(a0, r, -0.03), at(a1, r, -0.03), 0.04, "steel", STEEL_GREY, FACE.long, 0, 0.03, axis);
    }
  }
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    beam(b, at(a, 0.12, -0.03), at(a, radius * 0.97, -0.03), 0.04, "steel", STEEL_GREY, FACE.long, 0, 0.04, axis);
  }
}

/** The block level's wheel: an octagon facing the wind, both sides. */
function drawWheelDisc(b: KitBuilder, axis: Vec3, across: Vec3, hubY: number, radius: number): void {
  const centre = add([0, hubY, 0], scale(axis, 0.66));
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    corners.push(add(centre, add(scale(across, Math.cos(a) * radius), [0, Math.sin(a) * radius, 0])));
  }
  polygonFacing(b, corners, axis, "steel", 0xb6b9b4);
  polygonFacing(b, corners, scale(axis, -1), "steel", 0xb6b9b4);
}

/** The tail: a boom back from the head and the vane at its end. */
function drawTail(b: KitBuilder, axis: Vec3, hubY: number, radius: number, block: boolean): void {
  const length = Math.min(2.0, radius + 0.45);
  const start = add([0, hubY, 0], scale(axis, -0.3));
  const end = add([0, hubY + 0.05, 0], scale(axis, -length));
  if (!block) beam(b, start, end, 0.06, "steel", STEEL_GREY, FACE.long, 0, 0.05);
  const vaneLength = Math.min(1.1, length - 0.4);
  const vaneMid = add([0, hubY + 0.12, 0], scale(axis, -(length - vaneLength * 0.5)));
  b.obox(vaneMid, scale(axis, vaneLength * 0.5), [0, 0.36, 0], [axis[2] * 0.012, 0, -axis[0] * 0.012], "steel", 0xc3c6c0, FACE.all);
}

/**
 * A ladder: two rails and rungs every 0.3 m from `y0` to `y1`, its centre
 * line at `centre(y)`, `width` across, the rungs along `outward`'s normal
 * plane. Rungs are too thin for colliders (a walker does not climb).
 */
function ladder(b: KitBuilder, y0: number, y1: number, centre: (y: number) => Vec3, width: number, outward: Vec3, above = 0.9): void {
  const acrossDir: Vec3 = [outward[2], 0, -outward[0]];
  const side = (y: number, s: number): Vec3 => add(centre(y), scale(acrossDir, s * width * 0.5));
  for (const s of [-1, 1]) beam(b, side(y0, s), side(y1 + above, s), 0.05, "steel", STEEL_GREY, FACE.long, 0, 0.03);
  if (!b.open) return;
  for (let y = y0 + 0.3; y < y1 - 0.05; y += 0.3) beam(b, side(y, -1), side(y, 1), 0.025, "steel", STEEL_GREY, FACE.long);
}

// --- Water tank ----------------------------------------------------------------------------

/**
 * A steel water tank on a stand: four timber or steel legs braced at every
 * level, a joisted deck, a corrugated tank with a cone roof
 * and a hatch, a ladder, and the outlet pipe down to a tap.
 */
function buildTank(b: KitBuilder, record: StructureRecord, look: StructureLook): void {
  const rng = new KitRandom(record.seed);
  const half = Math.min(record.width, record.depth) * 0.5;
  const standH = Math.round(rng.range(KitChannel.tankHeight, 3.6, 5.2) * 10) / 10;
  const base = record.baseY - record.floorY;
  const ground = record.entryY - record.floorY;
  const steel = record.style === "desert" || record.style === "savanna" ? rng.chance(KitChannel.cladding, 0.4) : rng.chance(KitChannel.cladding, 0.2);
  const legColour = steel ? STEEL_GREY : shade(look.timberColour, 1.05);
  const legSurface: StructureSurface = steel ? "steel" : "timber";
  const legMaterial: StructureColliderMaterial = steel ? "metal" : "timber";
  const leg = steel ? 0.14 : 0.22;
  const legHalf = half - 0.42;
  const deckHalf = half - 0.05;
  const tankR = half - 0.2;
  const tankH = Math.round(rng.range(KitChannel.tankHeight, 2.1, 2.7, 1) * 10) / 10;
  const tankColour = rng.pick(KitChannel.accent, [GALVANISED, 0xb9bcb6, 0x7d8f86, 0xc6c1b0, 0x8a8f8c]);
  const sides = 12;
  const tankBottom = standH + 0.04;
  const tankTop = tankBottom + tankH;
  const coneTop = tankTop + tankR * Math.tan((14 * Math.PI) / 180);
  const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

  if (b.block) {
    b.box(-legHalf, legHalf, ground, standH, -legHalf, legHalf, legSurface, legColour, FACE.sides);
    const lower = ring(6, tankR, tankBottom);
    const upper = ring(6, tankR, tankTop);
    prismSides(b, lower, upper, 0, 0, "metal", tankColour);
    const apex: Vec3 = [0, coneTop, 0];
    for (let i = 0; i < 6; i += 1) polygonFacing(b, [upper[i]!, upper[(i + 1) % 6]!, apex], [0, 1, 0], "metal", shade(tankColour, 0.95));
    return;
  }

  for (const [sx, sz] of corners) {
    const x = sx * legHalf;
    const z = sz * legHalf;
    footing(b, x, z, 0.32, base);
    b.box(x - leg * 0.5, x + leg * 0.5, 0.08, standH - 0.24, z - leg * 0.5, z + leg * 0.5, legSurface, legColour, FACE.sides);
    b.capsule([x, 0.08, z], [x, standH - 0.24, z], Math.max(0.05, leg * 0.5), legMaterial);
  }
  const bays = Math.max(2, Math.round(standH / 2.2));
  for (let k = 1; k <= bays; k += 1) {
    const y = (k / bays) * (standH - 0.24);
    const y0 = ((k - 1) / bays) * (standH - 0.24) + 0.1;
    for (let i = 0; i < 4; i += 1) {
      const [ax, az] = corners[i]!;
      const [cx, cz] = corners[(i + 1) % 4]!;
      const a: Vec3 = [ax * legHalf, y, az * legHalf];
      const c: Vec3 = [cx * legHalf, y, cz * legHalf];
      if (k < bays) beam(b, a, c, steel ? 0.08 : 0.14, legSurface, shade(legColour, 0.95), FACE.long, 0, steel ? 0.06 : 0.06);
      beam(b, [ax * legHalf, y0, az * legHalf], c, steel ? 0.04 : 0.12, legSurface, shade(legColour, 0.9), FACE.long, 0, steel ? 0.04 : 0.05);
      beam(b, [cx * legHalf, y0, cz * legHalf], a, steel ? 0.04 : 0.12, legSurface, shade(legColour, 0.9), FACE.long, 0, steel ? 0.04 : 0.05);
    }
  }
  // Bearers, joists and the deck.
  for (const s of [-1, 1]) {
    b.box(-deckHalf + 0.05, deckHalf - 0.05, standH - 0.46, standH - 0.24, s * legHalf - 0.1, s * legHalf + 0.1, "timber", shade(look.timberColour, 0.95), FACE.all);
  }
  for (let i = 0; i < 6; i += 1) {
    const x = -deckHalf + 0.2 + (i / 5) * (2 * deckHalf - 0.4);
    b.box(x - 0.04, x + 0.04, standH - 0.24, standH - 0.06, -deckHalf + 0.05, deckHalf - 0.05, "timber", shade(look.timberColour, 1.0), FACE.all & ~FACE.py);
  }
  b.box(-deckHalf, deckHalf, standH - 0.06, standH, -deckHalf, deckHalf, "floor", shade(look.timberColour, 1.2), FACE.all);
  b.solid(-deckHalf, deckHalf, standH - 0.46, standH, -deckHalf, deckHalf, "timber");

  // The tank: corrugated sides, a dark band at the base, the cone roof, a hatch.
  const lower = ring(sides, tankR, tankBottom);
  const upper = ring(sides, tankR, tankTop);
  prismSides(b, lower, upper, 0, 0, "metal", tankColour);
  const apex: Vec3 = [0, coneTop, 0];
  const roofRing = ring(sides, tankR + 0.06, tankTop - 0.02);
  for (let i = 0; i < sides; i += 1) polygonFacing(b, [roofRing[i]!, roofRing[(i + 1) % sides]!, apex], [0, 1, 0], "metal", shade(tankColour, 0.93));
  for (let i = 0; i < sides; i += 1) polygonFacing(b, [roofRing[i]!, roofRing[(i + 1) % sides]!, [0, tankTop - 0.02, 0]], [0, -1, 0], "metal", shade(tankColour, 0.7));
  const hatchR = tankR * 0.45;
  const hatchY = tankTop - 0.02 + (tankR + 0.06 - hatchR) * Math.tan((14 * Math.PI) / 180);
  b.box(hatchR - 0.25, hatchR + 0.25, hatchY - 0.05, hatchY + 0.08, -0.25, 0.25, "metal", shade(tankColour, 0.85), FACE.standing);
  // The tank's collider: a box on its flats, and the roof's.
  const flat = tankR * Math.cos(Math.PI / sides);
  b.solid(-flat, flat, tankBottom, tankTop, -flat, flat, "metal");

  // The ladder up the front leg face to the deck and on up the tank's side.
  const ladderX = legHalf * 0.4;
  ladder(b, ground, standH, (y) => [ladderX, y, deckHalf + 0.08], 0.42, [0, 0, 1]);
  ladder(b, standH, tankTop - 0.1, (y) => [ladderX, y, Math.sqrt(Math.max(0, tankR * tankR - ladderX * ladderX)) + 0.1], 0.38, [0, 0, 1], 0.3);

  // The outlet: down from the tank's floor to a tap on a stand pipe.
  const px = -legHalf * 0.5;
  const pz = -legHalf * 0.5;
  beam(b, [px, ground + 0.75, pz], [px, tankBottom + 0.05, pz], 0.08, "steel", 0x6c6f6a, FACE.long);
  beam(b, [px, ground + 0.75, pz], [px, ground + 0.75, pz + 0.3], 0.06, "steel", 0x6c6f6a, FACE.long);
  b.box(px - 0.04, px + 0.04, ground + 0.78, ground + 0.86, pz + 0.26, pz + 0.34, "trim", 0xb03a2a, FACE.all);
}

// --- Weather mast --------------------------------------------------------------------------

/**
 * A weather station's self-supporting lattice mast: three legs tapering
 * towards the top, girts and zig-zag braces, a boom with the anemometer and
 * vane at the top, red obstruction lights at the top and halfway, a solar
 * panel and the logger box; beside it a white louvred instrument screen.
 */
function buildMast(b: KitBuilder, record: StructureRecord): void {
  const rng = new KitRandom(record.seed);
  const half = Math.min(record.width, record.depth) * 0.5;
  const height = Math.round(rng.range(KitChannel.mastHeight, 12, 18) * 10) / 10;
  const base = record.baseY - record.floorY;
  const ground = record.entryY - record.floorY;
  const rBottom = 0.5;
  const rTop = 0.22;
  const turn = rng.range(KitChannel.windmillTurn, 0, Math.PI * 2);
  const legAt = (i: number, y: number): Vec3 => {
    const r = rBottom + (rTop - rBottom) * (y / height);
    const a = turn + (i / 3) * Math.PI * 2;
    return [Math.cos(a) * r, y, -Math.sin(a) * r];
  };
  // The screen and the logger stand off towards the front, inside the body.
  const screenX = Math.max(-0.3, Math.min(0.3, Math.sin(turn) * 0.3));
  const screenZ = half + STRUCTURE_EAVE_OVERHANG - 0.35;

  if (b.block) {
    const lower = [0, 1, 2].map((i) => legAt(i, 0.08));
    const upper = [0, 1, 2].map((i) => legAt(i, height));
    prismSides(b, lower, upper, 0, 0, "steel", WHITE_PAINT);
    b.box(screenX - 0.32, screenX + 0.32, ground + 1.0, ground + 1.6, screenZ - 0.28, screenZ + 0.28, "trim", WHITE_PAINT, FACE.standing);
    return;
  }

  b.box(-0.8, 0.8, base, 0.08, -0.8, 0.8, "concrete", CONCRETE, FACE.all & ~FACE.ny);
  b.solid(-0.8, 0.8, base, 0.08, -0.8, 0.8, "stone");
  for (let i = 0; i < 3; i += 1) member(b, legAt(i, 0.08), legAt(i, height), 0.1, "steel", WHITE_PAINT, "metal");
  // Alternate bands red and white on the legs near the top (aviation marking).
  const band = height / 7;
  for (let k = 0; k < 7; k += 2) {
    const y0 = height - (k + 1) * band;
    if (y0 < height * 0.45) break;
    for (let i = 0; i < 3; i += 1) beam(b, legAt(i, y0), legAt(i, y0 + band), 0.11, "steel", OBSTRUCTION_RED, FACE.long);
  }
  const bays = Math.max(6, Math.round(height / 1.5));
  for (let k = 1; k <= bays; k += 1) {
    const y = (k / bays) * height;
    const y0 = ((k - 1) / bays) * height + 0.08;
    for (let i = 0; i < 3; i += 1) {
      const j = (i + 1) % 3;
      beam(b, legAt(i, y), legAt(j, y), 0.05, "steel", shade(WHITE_PAINT, 0.95), FACE.long, 0, 0.04);
      if (k % 2 === 1) beam(b, legAt(i, y0), legAt(j, y), 0.04, "steel", shade(WHITE_PAINT, 0.9), FACE.long);
      else beam(b, legAt(j, y0), legAt(i, y), 0.04, "steel", shade(WHITE_PAINT, 0.9), FACE.long);
    }
  }
  b.capsule([0, 0.08, 0], [0, height, 0], rTop, "metal");
  // Obstruction lights: on top and halfway up.
  for (const y of [height + 0.12, height * 0.5]) {
    const r = rBottom + (rTop - rBottom) * (Math.min(height, y) / height) + 0.08;
    b.box(-0.07 + r, 0.07 + r, y - 0.08, y + 0.08, -0.07, 0.07, "trim", OBSTRUCTION_RED, FACE.all);
    if (y > height) b.box(-0.07, 0.07, height, y + 0.08, -0.07, 0.07, "trim", OBSTRUCTION_RED, FACE.all);
  }
  // The boom at the top: anemometer cups on one end, the vane on the other.
  const boomDir: Vec3 = [Math.cos(turn + Math.PI / 3), 0, -Math.sin(turn + Math.PI / 3)];
  const boomY = height - 0.4;
  const boomEnd = Math.min(1.25, half + STRUCTURE_EAVE_OVERHANG - 0.25);
  const e0 = scale(boomDir, -boomEnd);
  const e1 = scale(boomDir, boomEnd);
  beam(b, [e0[0], boomY, e0[2]], [e1[0], boomY, e1[2]], 0.05, "steel", STEEL_GREY, FACE.long);
  b.box(e1[0] - 0.02, e1[0] + 0.02, boomY, boomY + 0.35, e1[2] - 0.02, e1[2] + 0.02, "steel", STEEL_GREY, FACE.sides);
  for (let i = 0; i < 3; i += 1) {
    const a = (i / 3) * Math.PI * 2;
    const c: Vec3 = [e1[0] + Math.cos(a) * 0.12, boomY + 0.36, e1[2] - Math.sin(a) * 0.12];
    b.box(c[0] - 0.035, c[0] + 0.035, c[1] - 0.03, c[1] + 0.03, c[2] - 0.035, c[2] + 0.035, "steel", 0x2a2c2c, FACE.all);
  }
  b.box(e0[0] - 0.02, e0[0] + 0.02, boomY, boomY + 0.3, e0[2] - 0.02, e0[2] + 0.02, "steel", STEEL_GREY, FACE.sides);
  b.obox([e0[0], boomY + 0.32, e0[2]], [0.18, 0, 0], [0, 0.06, 0], [0, 0, 0.008], "steel", 0x2a2c2c, FACE.all);
  // Solar panel and the logger box low on the mast.
  // Between two legs, off the middle of a face.
  const panelDir: Vec3 = [Math.cos(turn + Math.PI / 3), 0, -Math.sin(turn + Math.PI / 3)];
  const faceAt = (y: number) => (rBottom + (rTop - rBottom) * (y / height)) * 0.5;
  const pc = add([0, 3.2, 0], scale(panelDir, faceAt(3.2) + 0.3));
  const tilt = 0.9;
  b.obox(pc, [panelDir[2] * 0.32, 0, -panelDir[0] * 0.32],
    add(scale(panelDir, Math.cos(tilt) * 0.28), [0, Math.sin(tilt) * 0.28, 0]),
    add(scale(panelDir, Math.sin(tilt) * 0.02), [0, -Math.cos(tilt) * 0.02, 0]), "window", 0x1c2a3a, FACE.all);
  const lc = add([0, 1.5, 0], scale(panelDir, faceAt(1.5) + 0.12));
  b.obox(lc, [panelDir[2] * 0.2, 0, -panelDir[0] * 0.2], [0, 0.25, 0], scale(panelDir, 0.1), "trim", 0xd8d6cc, FACE.all);

  // The instrument screen: a louvred white box on four legs, its door to the north (here: the back).
  const sx0 = screenX - 0.32;
  const sx1 = screenX + 0.32;
  const sz0 = screenZ - 0.28;
  const sz1 = screenZ + 0.28;
  const sy0 = ground + 1.0;
  const sy1 = ground + 1.6;
  for (const [x, z] of [[sx0 + 0.04, sz0 + 0.04], [sx1 - 0.04, sz0 + 0.04], [sx1 - 0.04, sz1 - 0.04], [sx0 + 0.04, sz1 - 0.04]] as const) {
    b.box(x - 0.03, x + 0.03, ground, sy0, z - 0.03, z + 0.03, "timber", shade(WHITE_PAINT, 0.95), FACE.sides);
  }
  b.box(sx0, sx1, sy0, sy1, sz0, sz1, "boards", WHITE_PAINT, FACE.all);
  b.box(sx0 - 0.05, sx1 + 0.05, sy1, sy1 + 0.05, sz0 - 0.05, sz1 + 0.05, "trim", WHITE_PAINT, FACE.all);
  b.solid(sx0, sx1, ground, sy1 + 0.05, sz0, sz1, "timber");
}
