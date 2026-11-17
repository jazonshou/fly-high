import type { CarVisualState, FlightVisualState, PersonVisualState } from "../../src/game/types";
import type { WorldDefinition } from "../../src/world/types";
import { sampleTerrainHeight } from "../../src/world";
import { homeMarina, marinaStartPose } from "../../src/world/marina";
import { marinaHeading, marinaToWorld } from "../../src/world/marinaLayout";
import { SurfaceMaterial } from "../../src/render/webgpu/terrain/surfaceMaterials";
import { buildCarShotState, resolveCarShotSite } from "./carShotState";
import { headingVectorFromYaw, type PerfCaptureCarRun, type PerfCaptureWalkRun } from "../../scripts/perf-capture.mts";

/**
 * A walker shot's state (`PerfCaptureShotDefinition.walk`), shared by both
 * harnesses so they photograph the same walker.
 *
 * **A PINNED POSE, NOT A WALK**, for the car shots' reason: the frame stays
 * where the shot was placed while the walker's physics and figure are tuned.
 * The parked car is a car shot's pose at rest (`buildCarShotState`), in Park
 * with its engine idling as a foot start leaves it. Like `carShotState.ts`
 * it is part of the A/B instrument (`HARNESS_PATHS`) and imports nothing the
 * walker added: its few numbers are typed here and
 * `tests/perf-walk-shots.test.ts` holds them to `PERSON` and `CAR_SEATING`.
 * Its types are type-only imports, gone from the built harness.
 *
 * The harness frames it with the character camera: it cuts the camera at the
 * shot (behind the walker, default pitch), then turns the look by
 * `walkShotLookPitchRadians`.
 */

/** PERSON.stature and PERSON.eyeHeight, metres. */
export const WALK_SHOT_STATURE = 1.76;
export const WALK_SHOT_EYE_HEIGHT = 0.936 * 1.76;
/** CAR_SEATING.doorStand, the driver's door's stand point (body frame: forward, right), and .cgAboveGround, metres. */
export const WALK_SHOT_DOOR_STAND = Object.freeze({ forward: -0.25, right: 1.4 });
export const WALK_SHOT_CAR_CG_ABOVE_GROUND = 0.8;
/** `PERSON_SURFACE_WATER`: `PersonVisualState.surface` for a foot in water. */
export const WALK_SHOT_SURFACE_WATER = -2;

/** The parked car's run: at rest, as a car shot stands it. */
function parkedCarRun(site: PerfCaptureCarRun["site"]): PerfCaptureCarRun {
  return {
    site,
    speedMetersPerSecond: 0,
    wheelspinRadiansPerSecond: 0,
    throttle: 0,
    boost: 0,
    range: "2H",
    tyrePressure: "road",
    sinkageMeters: 0.01,
  };
}

/** A car shot's yaw for a heading (`FlightVisualState.heading`, radians: forward is (sin h, cos h)). */
function yawDegreesForHeading(heading: number): number {
  return (heading * 180) / Math.PI - 90;
}

/** The car parked at (x, z) facing `heading`, its payload in Park. */
function parkedCar(world: WorldDefinition, x: number, z: number, heading: number, simulationTime: number): FlightVisualState {
  const state = buildCarShotState(world, parkedCarRun("here"), { x, z, yawDegrees: yawDegreesForHeading(heading) }, simulationTime);
  return park(state);
}

function park(state: FlightVisualState): FlightVisualState {
  const car = state.vehicle as CarVisualState;
  return { ...state, throttle: 0, vehicle: { ...car, selector: "P", gear: 0 } };
}

interface WalkerPose {
  x: number;
  /** The feet point (`PersonVisualState`): on the ground, or the eye less the eye height in the water. */
  y: number;
  z: number;
  heading: number;
  /** The still water's surface over the walker, or null on dry ground. */
  surface: number | null;
  ground: number;
}

/** The body's share under the surface, as the walker reckons it (src/sim/person/walker.ts `waterAt`). */
function submersion(eyeY: number, surface: number, swimPitch: number, swimming: boolean): number {
  const sine = swimming ? Math.sin(swimPitch) : 1;
  const footY = eyeY - WALK_SHOT_EYE_HEIGHT * sine;
  const crownY = eyeY + (WALK_SHOT_STATURE - WALK_SHOT_EYE_HEIGHT) * sine;
  const low = Math.min(footY, crownY) - 0.125;
  const high = Math.max(footY, crownY) + 0.125;
  return Math.max(0, Math.min(1, (surface - low) / (high - low)));
}

/** Square rings out from (x, z), `step` apart, to `radius`: the first point `accepts` takes. */
function ringSearch(
  x: number,
  z: number,
  step: number,
  radius: number,
  accepts: (x: number, z: number) => boolean,
): { x: number; z: number } | null {
  for (let ring = 0; ring * step <= radius; ring += 1) {
    for (let ix = -ring; ix <= ring; ix += 1) {
      for (let iz = -ring; iz <= ring; iz += 1) {
        if (Math.max(Math.abs(ix), Math.abs(iz)) !== ring) continue;
        if (accepts(x + ix * step, z + iz * step)) return { x: x + ix * step, z: z + iz * step };
      }
    }
  }
  return null;
}

/** The ground's uphill direction at (x, z) over `d` metres, unit, on the ground plane. */
function uphill(world: WorldDefinition, x: number, z: number, d: number): { x: number; z: number } {
  const gx = sampleTerrainHeight(world, x + d, z) - sampleTerrainHeight(world, x - d, z);
  const gz = sampleTerrainHeight(world, x, z + d) - sampleTerrainHeight(world, x, z - d);
  const length = Math.hypot(gx, gz);
  return length > 0 ? { x: gx / length, z: gz / length } : { x: 1, z: 0 };
}

/**
 * Where the walker is and where the car is parked (`PerfCaptureWalkRun.site`),
 * searched from the shot's placement. Throws rather than putting either
 * somewhere else.
 */
export function resolveWalkShotSite(
  world: WorldDefinition,
  run: PerfCaptureWalkRun,
  at: { readonly x: number; readonly z: number; readonly yawDegrees: number },
  simulationTime: number,
): { walker: WalkerPose; car: FlightVisualState } {
  const eyeBelow = (surface: number) => surface - (run.headDepthMeters ?? -0.05) - WALK_SHOT_EYE_HEIGHT;
  if (run.site === "door") {
    const carSite = run.carSite ?? "here";
    const yawDegrees = carSite === "here" && run.carHeadingDegrees !== undefined
      ? run.carHeadingDegrees - 90
      : at.yawDegrees;
    const car = park(buildCarShotState(world, parkedCarRun(carSite), { ...at, yawDegrees }, simulationTime));
    const site = resolveCarShotSite(world, parkedCarRun(carSite), { ...at, yawDegrees });
    const heading = Math.atan2(site.forwardX, site.forwardZ);
    // Body +Z (right) is the heading less 90 degrees: (-forwardZ, forwardX).
    const along = WALK_SHOT_DOOR_STAND.forward + (run.aheadMeters ?? 0);
    const x = car.position.x + site.forwardX * along - site.forwardZ * WALK_SHOT_DOOR_STAND.right;
    const z = car.position.z + site.forwardZ * along + site.forwardX * WALK_SHOT_DOOR_STAND.right;
    const ground = sampleTerrainHeight(world, x, z);
    return { walker: { x, y: ground, z, heading, surface: null, ground }, car };
  }
  if (run.site === "sea") {
    const depth = run.bedDepthMeters ?? 3;
    const found = ringSearch(at.x, at.z, 25, 1_500, (x, z) => {
      const h = sampleTerrainHeight(world, x, z) - world.seaLevel;
      if (Math.abs(h + depth) > 0.25) return false;
      // Shore within 400 m up the slope.
      const up = uphill(world, x, z, 10);
      return sampleTerrainHeight(world, x + up.x * 400, z + up.z * 400) > world.seaLevel + 2;
    });
    if (!found) throw new Error(`perf-capture: no sea ${depth} m deep with a shore near it within 1.5 km of the walk shot's placement`);
    const up = uphill(world, found.x, found.z, 10);
    const heading = Math.atan2(up.x, up.z);
    // The car parked up the beach, where a swimmer left it: the first flat dry ground uphill.
    let carX = found.x;
    let carZ = found.z;
    for (let step = 0; step < 160; step += 1) {
      carX += up.x * 5;
      carZ += up.z * 5;
      if (sampleTerrainHeight(world, carX, carZ) > world.seaLevel + 1.5) break;
    }
    if (sampleTerrainHeight(world, carX, carZ) <= world.seaLevel + 1.5) {
      throw new Error("perf-capture: no dry ground within 800 m up the shore of the walk shot's swimmer");
    }
    const car = parkedCar(world, carX, carZ, heading + Math.PI / 2, simulationTime);
    return {
      walker: {
        x: found.x,
        y: eyeBelow(world.seaLevel),
        z: found.z,
        heading,
        surface: world.seaLevel,
        ground: sampleTerrainHeight(world, found.x, found.z),
      },
      car,
    };
  }
  // The home marina: the car in its car park, nose to the sea.
  const layout = homeMarina(world);
  const anchor = layout.carParkAnchor;
  const car = parkedCar(world, anchor.x, anchor.z, anchor.headingRadians + Math.PI, simulationTime);
  if (run.site === "marinaPier") {
    const deck = layout.boxes.find((box) => box.kind === "pierDeck");
    if (!deck) throw new Error("perf-capture: the home marina has no pier deck for the walk shot");
    // A third of the way out along the deck, facing out along it.
    const along = -deck.halfOut / 3;
    const right = deck.right + Math.sin(deck.yaw) * along;
    const out = deck.out + Math.cos(deck.yaw) * along;
    const point = marinaToWorld(layout.frame, right, out);
    const top = deck.y + deck.halfHeight;
    const heading = marinaHeading(layout.frame, Math.sin(deck.yaw), Math.cos(deck.yaw));
    return { walker: { x: point.x, y: top, z: point.z, heading, surface: null, ground: top }, car };
  }
  if (run.site === "marinaBasin") {
    // Off the start berth, where a boat session's boat lies, facing out.
    const pose = marinaStartPose(world);
    return {
      walker: {
        x: pose.x,
        y: eyeBelow(pose.stillWaterY),
        z: pose.z,
        heading: pose.headingRadians,
        surface: pose.stillWaterY,
        ground: sampleTerrainHeight(world, pose.x, pose.z),
      },
      car,
    };
  }
  const unhandled: never = run.site;
  throw new Error(`perf-capture: walk site ${JSON.stringify(unhandled)} has no search`);
}

/** The character camera's turn up from its default for the shot, radians (`applyCharacterLook`'s pitch). */
export function walkShotLookPitchRadians(run: PerfCaptureWalkRun | undefined): number {
  return ((run?.lookPitchDegrees ?? 0) * Math.PI) / 180;
}

/** The walker's state at a shot: the person driven, the car parked. */
export function buildWalkShotState(
  world: WorldDefinition,
  run: PerfCaptureWalkRun,
  at: { readonly x: number; readonly z: number; readonly yawDegrees: number },
  simulationTime: number,
): FlightVisualState {
  const { walker, car } = resolveWalkShotSite(world, run, at, simulationTime);
  const speed = run.speedMetersPerSecond;
  const swimming = run.mode === "swim" || run.mode === "dive";
  const swimPitch = swimming ? ((run.swimPitchDegrees ?? 0) * Math.PI) / 180 : 0;
  const eyeY = walker.y + WALK_SHOT_EYE_HEIGHT;
  const surface = walker.surface;
  const payload: PersonVisualState = {
    kind: "person",
    mode: run.mode,
    speed,
    running: run.mode === "run",
    grounded: !swimming,
    slope: 0,
    waterDepth: surface === null ? 0 : Math.max(0, surface - walker.y),
    submersion: surface === null ? 0 : submersion(eyeY, surface, swimPitch, swimming),
    headDepth: surface === null ? -WALK_SHOT_STATURE : surface - eyeY,
    swimPitch,
    landingSpeed: 0,
    landingAge: 60,
    surface: surface === null ? SurfaceMaterial.Grass : WALK_SHOT_SURFACE_WATER,
    boarding: null,
  };
  const forward = headingVectorFromYaw(yawDegreesForHeading(walker.heading));
  // About world Y only, body +X forward: a turn of heading - 90 degrees.
  const half = (walker.heading - Math.PI / 2) / 2;
  return {
    ...car,
    position: { x: walker.x, y: walker.y, z: walker.z },
    velocity: { x: forward.x * speed, y: 0, z: forward.z * speed },
    orientation: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
    angularVelocity: { x: 0, y: 0, z: 0 },
    airspeed: 0,
    altitude: walker.y,
    altitudeAgl: walker.y - walker.ground,
    verticalSpeed: 0,
    heading: (walker.heading * 180) / Math.PI,
    pitch: 0,
    bank: 0,
    throttle: 0,
    engineRpm: 0,
    onGround: !swimming,
    simulationTime,
    vehicle: payload,
    walking: { driven: "person", car: { ...car, simulationTime }, doors: [0, 0], prompt: null },
  };
}

/**
 * The walker moved on along a perf:flight walk route (`FlightRequest` on a
 * walker shot): the shot's state `base` with the walker at (x, z) facing
 * `heading` (radians, as `FlightVisualState.heading`) at `speed`. Where the
 * sea is deeper than 0.75 of the walker's stature it swims with its eye
 * `headDepth` under the still surface, diving below 0.3 m; elsewhere it walks
 * on the terrain, wading in the shallows. The car stays where the shot
 * parked it.
 */
export function walkRouteState(
  world: WorldDefinition,
  base: FlightVisualState,
  x: number,
  z: number,
  heading: number,
  headDepth: number,
  speed: number,
  simulationTime: number,
): FlightVisualState {
  const ground = sampleTerrainHeight(world, x, z);
  const sea = world.seaLevel;
  const swimming = sea - ground > 0.75 * WALK_SHOT_STATURE;
  const y = swimming ? sea - headDepth - WALK_SHOT_EYE_HEIGHT : ground;
  const eyeY = y + WALK_SHOT_EYE_HEIGHT;
  const waterDepth = Math.max(0, sea - y);
  const previous = base.vehicle as PersonVisualState;
  const swimPitch = swimming ? previous.swimPitch : 0;
  const mode: PersonVisualState["mode"] = swimming
    ? headDepth > 0.3 ? "dive" : "swim"
    : waterDepth > 0.15 * WALK_SHOT_STATURE ? "wade" : speed > 2.5 ? "run" : speed > 0.05 ? "walk" : "stand";
  const payload: PersonVisualState = {
    ...previous,
    mode,
    speed,
    running: mode === "run",
    grounded: !swimming,
    waterDepth,
    submersion: waterDepth > 0 ? submersion(eyeY, sea, swimPitch, swimming) : 0,
    headDepth: waterDepth > 0 ? sea - eyeY : -WALK_SHOT_STATURE,
    swimPitch,
    surface: waterDepth > 0 ? WALK_SHOT_SURFACE_WATER : SurfaceMaterial.Grass,
  };
  const half = (heading - Math.PI / 2) / 2;
  return {
    ...base,
    position: { x, y, z },
    velocity: { x: Math.sin(heading) * speed, y: 0, z: Math.cos(heading) * speed },
    orientation: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
    altitude: y,
    altitudeAgl: y - ground,
    heading: (heading * 180) / Math.PI,
    onGround: !swimming,
    simulationTime,
    vehicle: payload,
  };
}
