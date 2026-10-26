import type { ColliderWorld } from "../colliders";
import type { Quaternion, Vec3 } from "../types";
import type { BoatControlState } from "@/src/game/types";
import { marinaToWorld, type MarinaBerth, type MarinaLayout } from "@/src/world/marinaLayout";
import type { MarinaColliders } from "./colliders";

/**
 * Mooring lines: spring-dampers from the hull's cleats to a berth's dock
 * cleats, applied every substep as an external load on the boat.
 *
 * MAKING FAST. Within `makeFastRadius` of a berth and slower than
 * `makeFastSpeed`, a press of M makes fast: each line's rest length is its
 * length at that moment, so making fast adds no force by itself (no jolt).
 * In Scenic the same happens on its own once the boat has come to rest in a
 * berth it was not just cast off from. CASTING OFF: M again, or the lever
 * pushed into gear past the detent.
 *
 * LINES ONLY PULL. A line's tension is k * stretch + c * stretch rate, never
 * negative: a slack line carries nothing, as rope does. k and c are sized so
 * six lines hold a 1,800 kg runabout within half a metre in an 11 m/s wind
 * from any side (tests/sim.boat-mooring.test.ts) and ring down in a few
 * seconds. A line pulled past its breaking load parts, and the boat is free.
 *
 * DOCK CLEATS ON PONTOONS MOVE. A cleat on a floating pontoon or finger is
 * carried by that pontoon's kinematic collider, so a line's far end rises and
 * falls with the calmed sea the pontoon rides; fixed cleats stay put.
 */

/**
 * What the boat simulator hands an external load each substep (the physics
 * thread's `BoatLoadContext`). Everything is reused between calls.
 */
export interface MooringLoadContext {
  readonly time: number;
  readonly dt: number;
  readonly position: Readonly<Vec3>;
  readonly orientation: Readonly<Quaternion>;
  readonly velocity: Readonly<Vec3>;
  readonly angularVelocity: Readonly<Vec3>;
  cleatWorld(index: number, out: Vec3): Vec3;
  cleatVelocity(index: number, out: Vec3): Vec3;
  pointVelocity(worldPoint: Readonly<Vec3>, out: Vec3): Vec3;
  addForceAtWorldPoint(force: Readonly<Vec3>, point: Readonly<Vec3>): void;
}

/** Hull cleat indices, in the hull lines' order (`RUNABOUT_21_CLEATS`). */
export const HULL_CLEAT = Object.freeze({
  bow: 0,
  portSpring: 1,
  starboardSpring: 2,
  portStern: 3,
  starboardStern: 4,
});

export const MOORING = Object.freeze({
  /** The boat's centre of gravity must be this close to a berth's ... */
  makeFastRadius: 1.5,
  /** ... and slower than this, to make fast. */
  makeFastSpeed: 0.6,
  /** A cast-off boat must leave its berth by this much before Scenic moors it again. */
  rearmDistance: 4,
  /** The lever past this is in gear, and casts off. */
  leverDetent: 0.08,
  /** Line stiffness, N/m, and damping, N s/m (nylon dock line, a few metres). */
  stiffness: 9_000,
  damping: 2_800,
  /** A line parts above this tension, N (12 mm nylon), or longer than `breakLength`, m. */
  breakingLoad: 30_000,
  breakLength: 12,
  /** Lines made fast off the berth's mark are hauled in (or paid out) at this rate, m/s. */
  haulRate: 0.25,
});

/**
 * The Runabout 21's cleats in the body frame (hull lines' `RUNABOUT_21_CLEATS`
 * less `RUNABOUT_21_CG`), and its CG height above still water at rest. The
 * simulator's `cleatsBody` and rest pose replace these once it is wired.
 */
export const RUNABOUT_21_CLEATS_BODY: readonly Readonly<Vec3>[] = Object.freeze([
  Object.freeze({ x: 4.15, y: 0.74, z: 0 }),
  Object.freeze({ x: 1.35, y: 0.55, z: -1.24 }),
  Object.freeze({ x: 1.35, y: 0.55, z: 1.24 }),
  Object.freeze({ x: -1.6, y: 0.48, z: -1.1 }),
  Object.freeze({ x: -1.6, y: 0.48, z: 1.1 }),
]);
export const RUNABOUT_21_CG_ABOVE_WATER = 0.162;

export interface MooringBoat {
  /** Hull cleats, body frame, in the hull lines' order. */
  readonly cleatsBody: readonly Readonly<Vec3>[];
  /** Centre of gravity above still water at rest, metres. */
  readonly cgAboveWater: number;
}

export const RUNABOUT_21_MOORING: MooringBoat = Object.freeze({
  cleatsBody: RUNABOUT_21_CLEATS_BODY,
  cgAboveWater: RUNABOUT_21_CG_ABOVE_WATER,
});

export type MooringState = "free" | "moored";

interface Line {
  hullCleat: number;
  /** Dock cleat at rest, world. */
  readonly restX: number;
  readonly restY: number;
  readonly restZ: number;
  /** Carrying pontoon collider and the cleat in its local frame, or -1 for a fixed cleat. */
  handle: number;
  readonly local: Vec3;
  restLength: number;
  /** The line's length with the boat on the berth's mark; hauling shortens toward it. */
  targetLength: number;
}

const scratchHull: Vec3 = { x: 0, y: 0, z: 0 };
const scratchHullVelocity: Vec3 = { x: 0, y: 0, z: 0 };
const scratchDock: Vec3 = { x: 0, y: 0, z: 0 };
const scratchDockVelocity: Vec3 = { x: 0, y: 0, z: 0 };
const scratchForce: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Which hull cleat goes to which dock cleat at a berth (see
 * `MarinaBerth.cleats`). Each side's lines go to the same side of the boat,
 * decided in the boat's own frame, so a berth works bow in or bow out.
 */
function linePlan(berth: MarinaBerth, layout: MarinaLayout, heading: number): { hull: number; dock: number }[] {
  // Starboard of the boat, world XZ (src/sim/types.ts: forward x up).
  const starboardX = -Math.cos(heading);
  const starboardZ = Math.sin(heading);
  const centre = marinaToWorld(layout.frame, berth.right, berth.out);
  const side = (index: number) => {
    const cleat = berth.cleats[index]!;
    const p = marinaToWorld(layout.frame, cleat.right, cleat.out);
    return (p.x - centre.x) * starboardX + (p.z - centre.z) * starboardZ > 0 ? "starboard" : "port";
  };
  if (berth.side === "fuel") {
    // Alongside: bow and stern lines to the outer cleats, the dock-side
    // spring and stern quarter to the inner pair.
    const forwardX = Math.sin(heading);
    const forwardZ = Math.cos(heading);
    const along = (index: number) => {
      const cleat = berth.cleats[index]!;
      const p = marinaToWorld(layout.frame, cleat.right, cleat.out);
      return (p.x - centre.x) * forwardX + (p.z - centre.z) * forwardZ;
    };
    const order = [0, 1, 2, 3].sort((a, b) => along(a) - along(b));
    const dockSide = side(order[0]!);
    const spring = dockSide === "starboard" ? HULL_CLEAT.starboardSpring : HULL_CLEAT.portSpring;
    const stern = dockSide === "starboard" ? HULL_CLEAT.starboardStern : HULL_CLEAT.portStern;
    return [
      { hull: stern, dock: order[0]! },
      { hull: spring, dock: order[1]! },
      { hull: stern, dock: order[2]! },
      { hull: HULL_CLEAT.bow, dock: order[3]! },
    ];
  }
  // A finger berth: stern lines to the finger roots, breast lines from the
  // spring cleats to the finger middles, a bow bridle to both finger tips.
  const plan: { hull: number; dock: number }[] = [];
  for (const dock of [0, 1]) {
    plan.push({ hull: side(dock) === "starboard" ? HULL_CLEAT.starboardStern : HULL_CLEAT.portStern, dock });
  }
  for (const dock of [2, 3]) {
    plan.push({ hull: side(dock) === "starboard" ? HULL_CLEAT.starboardSpring : HULL_CLEAT.portSpring, dock });
  }
  for (const dock of [4, 5]) plan.push({ hull: HULL_CLEAT.bow, dock });
  return plan;
}

/**
 * The mooring of one boat at the home marina. Implements the boat
 * simulator's external load (`apply`), and decides making fast and casting
 * off from the boat's controls (`update`, once per 120 Hz step).
 *
 * WIRING, in this order. Once at install: `addMarinaColliders`, then
 * `makeFast(layout.startBerth, ...)` right after the dock spawn, and register
 * this and a `MarinaContactLoad` as external loads. Then every fixed step:
 * `water.setTime`, `poseMarinaPontoons`, `update`, and the boat's step (which
 * calls `apply` per substep). None of it waits for terrain: every collider
 * and berth comes from `homeMarina(world)`, which is pure CPU.
 */
export class Mooring {
  state: MooringState = "free";
  /** The berth the boat is made fast to, or was last cast off from. */
  berth: MarinaBerth | null = null;
  /** True once a line has parted since the last make-fast. */
  parted = false;
  private readonly lines: Line[] = [];
  private lastMoorPresses: number | null = null;
  private armed = true;

  constructor(
    private readonly layout: MarinaLayout,
    private readonly colliders: ColliderWorld | null = null,
    private readonly marinaColliders: MarinaColliders | null = null,
    private readonly boat: MooringBoat = RUNABOUT_21_MOORING,
  ) {}

  /** A hull cleat's world position with the boat at rest on a berth's mark. */
  private markCleat(berth: MarinaBerth, index: number, out: Vec3): Vec3 {
    const cleat = this.boat.cleatsBody[index]!;
    const centre = marinaToWorld(this.layout.frame, berth.right, berth.out);
    const forwardX = Math.sin(berth.bowHeadingRadians);
    const forwardZ = Math.cos(berth.bowHeadingRadians);
    out.x = centre.x + forwardX * cleat.x - forwardZ * cleat.z;
    out.y = this.layout.seaLevel + this.boat.cgAboveWater + cleat.y;
    out.z = centre.z + forwardZ * cleat.x + forwardX * cleat.z;
    return out;
  }

  /** The berth within the make-fast radius of a CG position, nearest first, or null. */
  berthNear(x: number, z: number): MarinaBerth | null {
    let best: MarinaBerth | null = null;
    let bestDistance: number = MOORING.makeFastRadius;
    for (const berth of this.layout.berths) {
      const p = marinaToWorld(this.layout.frame, berth.right, berth.out);
      const distance = Math.hypot(p.x - x, p.z - z);
      if (distance <= bestDistance) {
        best = berth;
        bestDistance = distance;
      }
    }
    return best;
  }

  /**
   * Makes fast at `berth` with lines at their present lengths. `cleatWorld`
   * gives the hull cleats' world positions now (the context's, or the spawn
   * pose's); `heading` is the boat's.
   */
  makeFast(berth: MarinaBerth, heading: number, cleatWorld: (index: number, out: Vec3) => Vec3): void {
    this.lines.length = 0;
    for (const { hull, dock } of linePlan(berth, this.layout, heading)) {
      const cleat = berth.cleats[dock]!;
      const p = marinaToWorld(this.layout.frame, cleat.right, cleat.out);
      const line: Line = {
        hullCleat: hull,
        restX: p.x,
        restY: cleat.y,
        restZ: p.z,
        handle: -1,
        local: { x: 0, y: 0, z: 0 },
        restLength: 0,
        targetLength: 0,
      };
      if (cleat.floating) this.attachToPontoon(line);
      this.dockCleat(line, scratchDock);
      cleatWorld(hull, scratchHull);
      line.restLength = Math.hypot(scratchDock.x - scratchHull.x, scratchDock.y - scratchHull.y, scratchDock.z - scratchHull.z);
      this.markCleat(berth, hull, scratchHull);
      line.targetLength = Math.hypot(line.restX - scratchHull.x, line.restY - scratchHull.y, line.restZ - scratchHull.z);
      this.lines.push(line);
    }
    this.state = "moored";
    this.berth = berth;
    this.parted = false;
    this.armed = false;
  }

  castOff(): void {
    this.lines.length = 0;
    this.state = "free";
  }

  /**
   * Make fast or cast off from this step's controls. `scenic` makes fast on
   * its own. Call once per fixed step, before the substeps.
   */
  update(
    controls: Readonly<BoatControlState>,
    scenic: boolean,
    position: Readonly<Vec3>,
    velocity: Readonly<Vec3>,
    heading: number,
    cleatWorld: (index: number, out: Vec3) => Vec3,
  ): void {
    const pressed = this.lastMoorPresses !== null && controls.moorPresses !== this.lastMoorPresses;
    this.lastMoorPresses = controls.moorPresses;
    const inGear = Math.abs(controls.lever) > MOORING.leverDetent;
    if (this.state === "moored") {
      if (pressed || inGear) this.castOff();
      return;
    }
    if (!this.armed && this.berth) {
      const p = marinaToWorld(this.layout.frame, this.berth.right, this.berth.out);
      if (Math.hypot(p.x - position.x, p.z - position.z) > MOORING.rearmDistance) this.armed = true;
    }
    const speed = Math.hypot(velocity.x, velocity.z);
    if (speed >= MOORING.makeFastSpeed) return;
    const berth = this.berthNear(position.x, position.z);
    if (!berth) return;
    if (pressed || (scenic && !inGear && (this.armed || berth !== this.berth))) {
      this.makeFast(berth, heading, cleatWorld);
    }
  }

  /** The boat simulator's external load: line tensions on the hull cleats. */
  apply(context: MooringLoadContext): void {
    if (this.state !== "moored") return;
    const haul = MOORING.haulRate * context.dt;
    for (const line of this.lines) {
      // Haul the long lines and pay out the short ones until the boat lies on its mark.
      if (line.restLength > line.targetLength) line.restLength = Math.max(line.targetLength, line.restLength - haul);
      else if (line.restLength < line.targetLength) line.restLength = Math.min(line.targetLength, line.restLength + haul);
      this.dockCleat(line, scratchDock);
      this.dockCleatVelocity(line, scratchDock, scratchDockVelocity);
      context.cleatWorld(line.hullCleat, scratchHull);
      context.cleatVelocity(line.hullCleat, scratchHullVelocity);
      const dx = scratchDock.x - scratchHull.x;
      const dy = scratchDock.y - scratchHull.y;
      const dz = scratchDock.z - scratchHull.z;
      const length = Math.hypot(dx, dy, dz);
      if (length > MOORING.breakLength) {
        this.parted = true;
        this.castOff();
        return;
      }
      const stretch = length - line.restLength;
      if (stretch <= 0 || length < 1e-6) continue;
      const ux = dx / length;
      const uy = dy / length;
      const uz = dz / length;
      // The line's rate of lengthening; damping resists it.
      const rate = (scratchDockVelocity.x - scratchHullVelocity.x) * ux
        + (scratchDockVelocity.y - scratchHullVelocity.y) * uy
        + (scratchDockVelocity.z - scratchHullVelocity.z) * uz;
      const tension = MOORING.stiffness * stretch + MOORING.damping * rate;
      if (tension <= 0) continue;
      if (tension > MOORING.breakingLoad) {
        this.parted = true;
        this.castOff();
        return;
      }
      scratchForce.x = ux * tension;
      scratchForce.y = uy * tension;
      scratchForce.z = uz * tension;
      context.addForceAtWorldPoint(scratchForce, scratchHull);
    }
  }

  /** Line count and each line's stretch, for tests and the HUD. */
  lineStretches(cleatWorld: (index: number, out: Vec3) => Vec3): number[] {
    return this.lines.map((line) => {
      this.dockCleat(line, scratchDock);
      cleatWorld(line.hullCleat, scratchHull);
      return Math.hypot(scratchDock.x - scratchHull.x, scratchDock.y - scratchHull.y, scratchDock.z - scratchHull.z)
        - line.restLength;
    });
  }

  private attachToPontoon(line: Line): void {
    if (!this.colliders || !this.marinaColliders) return;
    // The pontoon or finger whose footprint holds the cleat.
    let best = -1;
    let bestDistance = Infinity;
    for (const pontoon of this.marinaColliders.pontoons) {
      const distance = Math.hypot(pontoon.x - line.restX, pontoon.z - line.restZ)
        - Math.max(pontoon.box.halfRight, pontoon.box.halfOut);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = pontoon.handle;
      }
    }
    if (best < 0) return;
    // Its local coordinates at the pontoon's present pose.
    const origin = this.colliders.localToWorld(best, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    const ax = this.colliders.localToWorld(best, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    const ay = this.colliders.localToWorld(best, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 });
    const az = this.colliders.localToWorld(best, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 0 });
    const dx = line.restX - origin.x;
    const dy = line.restY - origin.y;
    const dz = line.restZ - origin.z;
    line.local.x = dx * (ax.x - origin.x) + dy * (ax.y - origin.y) + dz * (ax.z - origin.z);
    line.local.y = dx * (ay.x - origin.x) + dy * (ay.y - origin.y) + dz * (ay.z - origin.z);
    line.local.z = dx * (az.x - origin.x) + dy * (az.y - origin.y) + dz * (az.z - origin.z);
    line.handle = best;
  }

  private dockCleat(line: Line, out: Vec3): Vec3 {
    if (line.handle >= 0 && this.colliders) return this.colliders.localToWorld(line.handle, line.local, out);
    out.x = line.restX;
    out.y = line.restY;
    out.z = line.restZ;
    return out;
  }

  private dockCleatVelocity(line: Line, at: Vec3, out: Vec3): Vec3 {
    if (line.handle >= 0 && this.colliders) return this.colliders.pointVelocity(line.handle, at, out);
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }
}
