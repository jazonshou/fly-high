import { ColliderWorld } from "../../src/sim/colliders";
import type { GroundPoint } from "../../src/sim/ground/terrainPatch";
import { Walker } from "../../src/sim/person/walker";
import { NEUTRAL_BOAT_CONTROLS, NEUTRAL_PERSON_CONTROLS, type SurfaceVehicleControls, type SurfaceVehicleEnvironment } from "../../src/sim/surface/types";
import { groundOf, STEP, Swell } from "./walkerRig";

/**
 * A course that takes the walker through everything its step does, for the
 * allocation and budget tests: a shore rising 1:8 out of a 5 m deep sea with
 * a long swell on it, a bobbing pontoon off the beach (a mantle out of the
 * water, a plunge off its far edge), a flight of five steps up to a platform
 * with a 0.85 m drop off its end, and trunks among the dunes. The walker
 * circles (32, 0) at 12 m: through the swim, the wade, the stairs, the trunks
 * and back. It runs a third of each lap, jumps every 3 s and dives for 3 s of
 * every 20 while swimming, looking down.
 *
 * The walker reads the shore through its own terrain lattice (no fixed ground,
 * as in the worker), and the controls object is changed in place.
 */

const CENTRE_X = 32;
const RADIUS = 12;
const SEA_LEVEL = 0;

/** The shore at (`out.x`, `out.z`): -5 offshore, rising 1:8 from x = -2 to 3.5, with low dunes. */
function shore(out: GroundPoint): void {
  const x = out.x;
  const z = out.z;
  const raw = -5 + 0.125 * (x + 2);
  const rise = raw < -5 ? -5 : raw > 3.5 ? 3.5 : raw;
  const sx = Math.sin(x / 7);
  const sz = Math.sin(z / 9);
  const cz = Math.cos(z / 9);
  out.height = rise + 0.25 * sx * cz;
  out.dhdx = (raw < -5 || raw > 3.5 ? 0 : 0.125) + (0.25 / 7) * Math.cos(x / 7) * cz;
  out.dhdz = (-0.25 / 9) * sx * sz;
}

const SHORE_POINT: GroundPoint = { x: -0, z: -0, height: -0, dhdx: -0, dhdz: -0 };

export function shoreHeight(x: number, z: number): number {
  SHORE_POINT.x = x;
  SHORE_POINT.z = z;
  shore(SHORE_POINT);
  return SHORE_POINT.height;
}

export interface WalkerCourse {
  readonly walker: Walker;
  readonly environment: SurfaceVehicleEnvironment;
  readonly swell: Swell;
  /**
   * The pontoon bobs while true. `ColliderWorld.setKinematicPose` allocates
   * (its refresh's closure, `Math.hypot`'s result), which is the world's
   * work, not the step's: the allocation test holds it still for its runs.
   */
  pontoonMoves: boolean;
  /** Reads of the terrain's height sampler (`bedHeight`), which the walker's lattice makes for each new node. */
  bedReads: number;
  /** One step of the course: moves the pontoon, keeps the water's clock, sets the input from step `i`, and steps. */
  step(i: number): void;
}

export function walkerCourse(): WalkerCourse {
  const swell = new Swell(groundOf(shore), SEA_LEVEL, 0.25, 30);

  const colliders = new ColliderWorld();
  // Five 0.17 m steps up along +Z on the land side of the lap (x = 44), a 2 m platform, then a drop.
  const base = shoreHeight(44, -2) - 0.2;
  for (let i = 0; i < 5; i += 1) {
    const top = base + 0.2 + 0.17 * (i + 1);
    colliders.addStatic({ kind: "box", center: { x: 44, y: (top + base - 1) / 2, z: -2 + 0.3 * i + 0.15 }, halfExtents: { x: 1.5, y: (top - base + 1) / 2, z: 0.15 } });
  }
  const platformTop = base + 0.2 + 0.85;
  colliders.addStatic({ kind: "box", center: { x: 44, y: (platformTop + base - 1) / 2, z: 1 }, halfExtents: { x: 1.5, y: (platformTop - base + 1) / 2, z: 1.5 } });
  // A pontoon off the beach where the lap is deepest (x = 20), 0.4 m over the still water, bobbing.
  const pontoon = colliders.addKinematic({ kind: "box", center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 1.2, y: 0.3, z: 3 } });
  const pontoonAt = { x: 20.5, y: 0.1, z: 0 };
  const pontoonTurn = { x: 0, y: 0, z: 0, w: 1 };
  const pontoonVelocity = { x: 0, y: 0, z: 0 };
  let lastPontoonSpeed = Number.NaN;

  const nearSolids = new ColliderWorld();
  // Trunks among the dunes, off the stairs' column.
  for (let ix = 0; ix < 4; ix += 1) {
    for (let iz = 0; iz < 7; iz += 1) {
      const x = 40 + 3.1 * ix;
      const z = -11 + 3.9 * iz;
      if (Math.abs(x - 44) < 2.5 && z > -4 && z < 4) continue;
      const y = shoreHeight(x, z);
      nearSolids.addStatic({ kind: "capsule", a: { x, y: y - 0.5, z }, b: { x, y: y + 6, z }, radius: 0.18 + 0.04 * ((ix + iz) % 3) });
    }
  }

  const environment: SurfaceVehicleEnvironment = {
    water: swell,
    wind: { x: 0, y: 0, z: 0 },
    bedHeight: (x, z) => {
      course.bedReads += 1;
      return shoreHeight(x, z);
    },
    colliders,
    nearSolids,
    gravity: 9.80665,
  };
  const person = { ...NEUTRAL_PERSON_CONTROLS };
  const controls: SurfaceVehicleControls = { assist: "scenic", boat: NEUTRAL_BOAT_CONTROLS, person };
  const walker = new Walker({ position: { x: CENTRE_X - RADIUS, y: 0, z: 0.5 }, heading: Math.PI });
  walker.setEnvironment(environment);
  walker.setControls(controls);

  const step = (i: number): void => {
    const time = walker.state.time;
    if (course.pontoonMoves) {
      pontoonAt.y = 0.1 + 0.12 * Math.sin(time * 0.9);
      pontoonVelocity.y = 0.108 * Math.cos(time * 0.9);
    } else {
      pontoonVelocity.y = 0;
    }
    if (course.pontoonMoves || pontoonVelocity.y !== lastPontoonSpeed) {
      colliders.setKinematicPose(pontoon, pontoonAt, pontoonTurn, pontoonVelocity);
      lastPontoonSpeed = pontoonVelocity.y;
    }
    swell.setTime(time);
    // Round (32, 0), +Z on the land side, steering back onto the 12 m circle.
    const position = walker.state.position;
    const dx = position.x - CENTRE_X;
    const dz = position.z;
    const distance = Math.sqrt(dx * dx + dz * dz) + 1e-9;
    const pull = Math.min(Math.max((distance - RADIUS) * 0.3, -0.7), 0.7);
    const mx = -dz / distance - pull * dx / distance;
    const mz = dx / distance - pull * dz / distance;
    const length = Math.sqrt(mx * mx + mz * mz);
    person.moveX = mx / length;
    person.moveZ = mz / length;
    const seconds = i * STEP;
    person.run = seconds % 75 < 25;
    const swimming = walker.mode === "swim" || walker.mode === "dive";
    const diving = swimming && seconds % 20 < 3;
    person.dive = diving;
    person.rise = swimming && seconds % 20 > 3 && seconds % 20 < 6;
    person.lookPitch = diving ? -0.35 : 0;
    person.lookHeading = Math.atan2(person.moveX, person.moveZ);
    if (i % 360 === 0) person.jumpPresses += 1;
    walker.step(STEP);
  };

  const course: WalkerCourse = { walker, environment, swell, pontoonMoves: true, bedReads: 0, step };
  return course;
}
