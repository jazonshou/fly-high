import { INITIAL_VISUAL_STATE, type CarVisualState, type FlightVisualState } from "../../src/game/types";
import type { WorldDefinition } from "../../src/world/types";
import { sampleTerrain, sampleTerrainHeight } from "../../src/world";
import { densityField } from "../../src/render/webgpu/detail/densityField";
import { generateDetailCell } from "../../src/render/webgpu/detail/generation";
import { DEFAULT_DETAIL_CELL_SIZE_METERS } from "../../src/render/webgpu/detail/types";
import { SurfaceMaterial } from "../../src/render/webgpu/terrain/surfaceMaterials";
import {
  PERF_CAPTURE_DEFAULT_CLOCK,
  headingVectorFromYaw,
  type PerfCaptureCarRun,
} from "../../scripts/perf-capture.mts";

/**
 * A car shot's state (`PerfCaptureShotDefinition.car`), shared by both
 * harnesses so they photograph the same car.
 *
 * **A PINNED POSE, NOT A DRIVE.** The boat shots run the boat simulator
 * because a planing hull's trim and spray roots are what its helm produces.
 * A car's pose on the ground is geometry: its four tyres stand on the
 * terrain, the solid axles roll to meet it and the body takes the mean.
 * Building it here, from the ground alone, keeps the frame where the shot
 * was placed and keeps it still while the car's physics is tuned: a shot
 * whose car moved every time the springs did would rebaseline with them.
 * So this file is part of the A/B instrument (`HARNESS_PATHS`) and both arms
 * photograph the same car, and it imports nothing the car added: its few
 * dimensions are typed here and `tests/perf-car-shots.test.ts` holds them
 * to `LANDCRUISER_76`.
 *
 * The payload is the effects' inputs at the shot's speed: rolling tyres
 * (plus any wheelspin), static loads, the soil the terrain's biome is, wet
 * and in water below the sea, and the water over the lowest tyre's ground.
 */

/** LANDCRUISER_76.geometry and .tyre, body frame, metres (tests/perf-car-shots.test.ts). */
export const CAR_SHOT_FRONT_AXLE_X = 0.48 * 2.73;
export const CAR_SHOT_REAR_AXLE_X = 0.48 * 2.73 - 2.73;
export const CAR_SHOT_FRONT_TRACK = 1.555;
export const CAR_SHOT_REAR_TRACK = 1.46;
export const CAR_SHOT_LOADED_RADIUS = 0.37;
export const CAR_SHOT_WHEEL_CENTRE_Y = 0.37 - 0.8;
/** LANDCRUISER_76.mass: kerb, kg, and the front axle's share. */
export const CAR_SHOT_KERB_MASS = 2_300;
export const CAR_SHOT_FRONT_SHARE = 0.52;

const GRAVITY = 9.80665;
/** Wheel order: front left, front right, rear left, rear right. */
const WHEEL_X = [CAR_SHOT_FRONT_AXLE_X, CAR_SHOT_FRONT_AXLE_X, CAR_SHOT_REAR_AXLE_X, CAR_SHOT_REAR_AXLE_X] as const;
const WHEEL_Z = [
  -CAR_SHOT_FRONT_TRACK / 2,
  CAR_SHOT_FRONT_TRACK / 2,
  -CAR_SHOT_REAR_TRACK / 2,
  CAR_SHOT_REAR_TRACK / 2,
] as const;

/**
 * A clearing has no trunk within this of the car's centre (a crown's reach
 * past the body), and no shrub or rock inside the body's footprint grown by
 * the margin.
 */
export const CAR_SHOT_CLEAR_TREE_METERS = 10;
const FOOTPRINT_HALF_LENGTH = 2.7 + 0.6;
const FOOTPRINT_HALF_WIDTH = 0.95 + 0.6;
/** ...and is ringed by woods: at least this many of 12 points 40 m out carry trees. */
const CLEARING_RING_METERS = 40;
const CLEARING_RING_WOODED = 7;
/** The densest tier's vegetation: the trees any tier draws are among these. */
const CLEARING_DENSITY = 1;

/** The soil under a tyre by the terrain's own classification of the ground. */
const MATERIAL_FOR_BIOME: Readonly<Record<string, number>> = Object.freeze({
  beach: SurfaceMaterial.Sand,
  grassland: SurfaceMaterial.Grass,
  forest: SurfaceMaterial.ForestFloor,
  highland: SurfaceMaterial.Shrub,
  alpine: SurfaceMaterial.Rock,
  snow: SurfaceMaterial.Snow,
  runway: SurfaceMaterial.Asphalt,
});

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Where a car shot stands and which way it faces, before the pose. */
export interface CarShotSite {
  readonly x: number;
  readonly z: number;
  /** Unit heading on the ground plane. */
  readonly forwardX: number;
  readonly forwardZ: number;
}

function wheelGround(world: WorldDefinition, site: CarShotSite, wheel: number): Vec3 {
  const x = site.x + site.forwardX * WHEEL_X[wheel]! - site.forwardZ * WHEEL_Z[wheel]!;
  const z = site.z + site.forwardZ * WHEEL_X[wheel]! + site.forwardX * WHEEL_Z[wheel]!;
  return { x, y: sampleTerrainHeight(world, x, z), z };
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** The rotation whose columns are the body's +X, +Y and +Z in the world. */
function quaternionFromAxes(x: Vec3, y: Vec3, z: Vec3): { x: number; y: number; z: number; w: number } {
  const trace = x.x + y.y + z.z;
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    return { w: s / 4, x: (y.z - z.y) / s, y: (z.x - x.z) / s, z: (x.y - y.x) / s };
  }
  if (x.x > y.y && x.x > z.z) {
    const s = 2 * Math.sqrt(1 + x.x - y.y - z.z);
    return { w: (y.z - z.y) / s, x: s / 4, y: (y.x + x.y) / s, z: (z.x + x.z) / s };
  }
  if (y.y > z.z) {
    const s = 2 * Math.sqrt(1 + y.y - x.x - z.z);
    return { w: (z.x - x.z) / s, x: (y.x + x.y) / s, y: s / 4, z: (z.y + y.z) / s };
  }
  const s = 2 * Math.sqrt(1 + z.z - x.x - y.y);
  return { w: (x.y - y.x) / s, x: (z.x + x.z) / s, y: (z.y + y.z) / s, z: s / 4 };
}

function treeStems(world: WorldDefinition, x: number, z: number): number {
  const sample = sampleTerrain(world, x, z);
  if (sample.height <= world.seaLevel) return 0;
  return densityField(world.sourceSeedHash, {
    x,
    z,
    heightMeters: sample.height,
    seaLevelMeters: world.seaLevel,
    slope: sample.slope,
    moisture: sample.moisture,
    normalX: sample.normal.x,
    normalZ: sample.normal.z,
    airportInfluence: sample.airportInfluence,
    dayOfYear: PERF_CAPTURE_DEFAULT_CLOCK.dayOfYear,
    filterWidthMeters: 0,
  }).treeStemsPerSquareMeter;
}

/** One detail cell's plants at the densest tier, kept for the searches that read it again. */
const cellCache = new Map<string, ReturnType<typeof generateDetailCell>>();

function densestCell(world: WorldDefinition, cellX: number, cellZ: number): ReturnType<typeof generateDetailCell> {
  const key = `${world.seed}/${world.seaLevel}/${cellX}/${cellZ}`;
  let cell = cellCache.get(key);
  if (!cell) {
    if (cellCache.size > 64) cellCache.clear();
    cell = generateDetailCell({
      worldSeed: world.seed,
      cellX,
      cellZ,
      cellSizeMeters: DEFAULT_DETAIL_CELL_SIZE_METERS,
      densityMultiplier: CLEARING_DENSITY,
      terrainSample: (sx, sz) => sampleTerrain(world, sx, sz),
      seaLevelMeters: world.seaLevel,
      dayOfYear: PERF_CAPTURE_DEFAULT_CLOCK.dayOfYear,
      latitudeDegrees: world.latitudeDegrees,
    });
    cellCache.set(key, cell);
  }
  return cell;
}

/**
 * Among the plants the densest tier grows: the nearest trunk to (x, z), and
 * whether any shrub or rock stands inside the footprint of a car there
 * heading (forwardX, forwardZ).
 */
export function nearestVegetation(
  world: WorldDefinition,
  x: number,
  z: number,
  forwardX = 1,
  forwardZ = 0,
): { tree: number; undergrowthInFootprint: boolean } {
  const size = DEFAULT_DETAIL_CELL_SIZE_METERS;
  const reach = CAR_SHOT_CLEAR_TREE_METERS;
  let tree = Infinity;
  let undergrowthInFootprint = false;
  const inFootprint = (px: number, pz: number): boolean => {
    const dx = px - x;
    const dz = pz - z;
    const along = dx * forwardX + dz * forwardZ;
    const across = -dx * forwardZ + dz * forwardX;
    return Math.abs(along) < FOOTPRINT_HALF_LENGTH && Math.abs(across) < FOOTPRINT_HALF_WIDTH;
  };
  for (let cellX = Math.floor((x - reach) / size); cellX <= Math.floor((x + reach) / size); cellX += 1) {
    for (let cellZ = Math.floor((z - reach) / size); cellZ <= Math.floor((z + reach) / size); cellZ += 1) {
      const cell = densestCell(world, cellX, cellZ);
      for (const stem of cell.trees) tree = Math.min(tree, Math.hypot(stem.x - x, stem.z - z));
      for (const plant of [...cell.shrubs, ...cell.rocks]) {
        if (inFootprint(plant.x, plant.z)) undergrowthInFootprint = true;
      }
    }
  }
  return { tree, undergrowthInFootprint };
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

/** The ground's uphill direction at (x, z), unit, on the ground plane. */
function uphill(world: WorldDefinition, x: number, z: number): { x: number; z: number } {
  const d = 2;
  const gx = sampleTerrainHeight(world, x + d, z) - sampleTerrainHeight(world, x - d, z);
  const gz = sampleTerrainHeight(world, x, z + d) - sampleTerrainHeight(world, x, z - d);
  const length = Math.hypot(gx, gz);
  return length > 0 ? { x: gx / length, z: gz / length } : { x: 1, z: 0 };
}

/**
 * Where the shot's car stands (`PerfCaptureCarRun.site`), searched from the
 * shot's placement. Throws rather than standing the car somewhere else.
 */
export function resolveCarShotSite(
  world: WorldDefinition,
  run: PerfCaptureCarRun,
  at: { readonly x: number; readonly z: number; readonly yawDegrees: number },
): CarShotSite {
  const yaw = headingVectorFromYaw(at.yawDegrees);
  if (run.site === "here") return { x: at.x, z: at.z, forwardX: yaw.x, forwardZ: yaw.z };
  if (run.site === "clearing") {
    // Thin trees by the density field first (cheap), then the stems the
    // densest tier really grows (a cell each), so no tier stands a tree in
    // the car.
    const found = ringSearch(at.x, at.z, 5, 150, (x, z) => {
      const here = sampleTerrain(world, x, z);
      // `slope` is 1 - cos of the ground's tilt: 0.01 is 8 degrees.
      if (here.height <= world.seaLevel + 1 || here.slope > 0.01) return false;
      if (treeStems(world, x, z) > 0.003) return false;
      let wooded = 0;
      for (let a = 0; a < 12; a += 1) {
        const angle = (a * Math.PI) / 6;
        if (treeStems(world, x + CLEARING_RING_METERS * Math.cos(angle), z + CLEARING_RING_METERS * Math.sin(angle)) > 0.01) {
          wooded += 1;
        }
      }
      if (wooded < CLEARING_RING_WOODED) return false;
      const nearest = nearestVegetation(world, x, z, yaw.x, yaw.z);
      return nearest.tree > CAR_SHOT_CLEAR_TREE_METERS && !nearest.undergrowthInFootprint;
    });
    if (!found) throw new Error("perf-capture: no forest clearing within 150 m of the car shot's placement");
    return { ...found, forwardX: yaw.x, forwardZ: yaw.z };
  }
  if (run.site === "ford") {
    // A gentle shore: the bed `wadingDepthMeters` down, no more than 1.6 m
    // below or 1.2 m above the sea 25 m round. Then up the beach to the
    // exact depth, facing land.
    const depth = run.wadingDepthMeters ?? 0.45;
    const found = ringSearch(at.x, at.z, 25, 1_500, (x, z) => {
      const h = sampleTerrainHeight(world, x, z) - world.seaLevel;
      if (h < -depth - 0.15 || h > -depth + 0.15) return false;
      for (let a = 0; a < 8; a += 1) {
        const angle = (a * Math.PI) / 4;
        const g = sampleTerrainHeight(world, x + 25 * Math.cos(angle), z + 25 * Math.sin(angle)) - world.seaLevel;
        if (g < -1.6 || g > 1.2) return false;
      }
      return true;
    });
    if (!found) throw new Error("perf-capture: no gentle shore within 1.5 km of the car shot's placement");
    const up = uphill(world, found.x, found.z);
    let { x, z } = found;
    for (let walk = 0; walk < 400; walk += 1) {
      const h = sampleTerrainHeight(world, x, z) - world.seaLevel;
      const toward = h < -depth ? 1 : -1;
      if (Math.abs(h + depth) < 0.01) break;
      x += up.x * 0.05 * toward;
      z += up.z * 0.05 * toward;
    }
    return { x, z, forwardX: up.x, forwardZ: up.z };
  }
  if (run.site === "dune") {
    // The stoss side of a crescent: sand, 5 to 9 degrees (`slope` is 1 - cos
    // of the tilt), steep enough to read as a climb and well short of the
    // slip face. Facing up it.
    const found = ringSearch(at.x, at.z, 15, 600, (x, z) => {
      const here = sampleTerrain(world, x, z);
      return here.biomeName === "beach" && here.height > world.seaLevel + 2 && here.slope > 0.004 && here.slope < 0.012;
    });
    if (!found) throw new Error("perf-capture: no dune flank within 600 m of the car shot's placement");
    const up = uphill(world, found.x, found.z);
    return { x: found.x, z: found.z, forwardX: up.x, forwardZ: up.z };
  }
  const unhandled: never = run.site;
  throw new Error(`perf-capture: car site ${JSON.stringify(unhandled)} has no search`);
}

/** The car's state at a shot (`PerfCaptureShotDefinition.car`). */
export function buildCarShotState(
  world: WorldDefinition,
  run: PerfCaptureCarRun,
  at: { readonly x: number; readonly z: number; readonly yawDegrees: number },
  simulationTime: number,
): FlightVisualState {
  const site = resolveCarShotSite(world, run, at);
  const ground = [0, 1, 2, 3].map((wheel) => wheelGround(world, site, wheel));
  // The body: forward from the rear axle's ground to the front's, right from
  // the left tyres' to the right's, square to forward.
  const mid = (a: Vec3, b: Vec3): Vec3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
  const front = mid(ground[0]!, ground[1]!);
  const rear = mid(ground[2]!, ground[3]!);
  const forward = normalize({ x: front.x - rear.x, y: front.y - rear.y, z: front.z - rear.z });
  const left = mid(ground[0]!, ground[2]!);
  const right = mid(ground[1]!, ground[3]!);
  const across = { x: right.x - left.x, y: right.y - left.y, z: right.z - left.z };
  const along = dot(across, forward);
  const starboard = normalize({
    x: across.x - along * forward.x,
    y: across.y - along * forward.y,
    z: across.z - along * forward.z,
  });
  const up = cross(starboard, forward);
  // Wheel centres a loaded radius above their ground along the body's up;
  // the body origin sits so the two axles' mean heave is zero.
  const centre = ground.map((g) => ({
    x: g.x + up.x * CAR_SHOT_LOADED_RADIUS,
    y: g.y + up.y * CAR_SHOT_LOADED_RADIUS,
    z: g.z + up.z * CAR_SHOT_LOADED_RADIUS,
  }));
  const axles = [mid(centre[0]!, centre[1]!), mid(centre[2]!, centre[3]!)];
  const meanAxle = mid(axles[0]!, axles[1]!);
  const meanX = (CAR_SHOT_FRONT_AXLE_X + CAR_SHOT_REAR_AXLE_X) / 2;
  const origin = {
    x: meanAxle.x - forward.x * meanX - up.x * CAR_SHOT_WHEEL_CENTRE_Y,
    y: meanAxle.y - forward.y * meanX - up.y * CAR_SHOT_WHEEL_CENTRE_Y,
    z: meanAxle.z - forward.z * meanX - up.z * CAR_SHOT_WHEEL_CENTRE_Y,
  };
  const axleHeave = axles.map((axle) => dot({
    x: axle.x - origin.x,
    y: axle.y - origin.y,
    z: axle.z - origin.z,
  }, up) - CAR_SHOT_WHEEL_CENTRE_Y);
  const axleRoll = [0, 1].map((axle) => {
    const l = centre[axle * 2]!;
    const r = centre[axle * 2 + 1]!;
    const span = { x: r.x - l.x, y: r.y - l.y, z: r.z - l.z };
    return Math.atan2(dot(span, up), dot(span, starboard));
  });

  const speed = run.speedMetersPerSecond;
  const roll = speed / CAR_SHOT_LOADED_RADIUS;
  const spin = roll + run.wheelspinRadiansPerSecond;
  const frontLoad = (CAR_SHOT_KERB_MASS * GRAVITY * CAR_SHOT_FRONT_SHARE) / 2;
  const rearLoad = (CAR_SHOT_KERB_MASS * GRAVITY * (1 - CAR_SHOT_FRONT_SHARE)) / 2;
  const lowest = Math.min(...ground.map((g) => g.y));
  const wadingDepth = Math.max(0, world.seaLevel - lowest);
  const surface = ground.map((g) => {
    if (g.y < world.seaLevel) return -1;
    return MATERIAL_FOR_BIOME[sampleTerrain(world, g.x, g.z).biomeName] ?? SurfaceMaterial.Grass;
  });
  const sand = run.tyrePressure === "sand";
  const payload: CarVisualState = {
    kind: "car",
    speed,
    gearbox: "automatic",
    selector: "D",
    gear: speed < 4 ? 1 : 2,
    range: run.range,
    locks: "off",
    downhillAssist: false,
    downhillAssistActive: false,
    tractionControlActive: false,
    absActive: false,
    clutch: 1,
    engineRunning: true,
    stalled: false,
    flooded: false,
    rolled: false,
    boost: run.boost,
    headlights: "off",
    brakeLights: false,
    reversing: false,
    tyrePressure: sand ? "sand" : "road",
    tyrePressureBar: sand ? 1.2 : 2.4,
    wadingDepth,
    settling: false,
    wheelSteer: [0, 0, 0, 0],
    wheelSpin: [0, 0, 0, 0],
    wheelSpinRate: [spin, spin, spin, spin],
    wheelLoad: [frontLoad, frontLoad, rearLoad, rearLoad],
    wheelSlip: [0, 1, 2, 3].map(() => (speed > 0.5 ? (spin * CAR_SHOT_LOADED_RADIUS - speed) / speed : 0)),
    wheelSinkage: surface.map((material) => (material < 0 ? 0 : run.sinkageMeters)),
    wheelSurface: surface,
    wheelWetness: surface.map((material) => (material < 0 ? 1 : 0)),
    axleHeave,
    axleRoll,
    steeringWheel: 0,
    bumpStop: 0,
    scrape: 0,
    splash: 0,
  };
  const orientation = quaternionFromAxes(forward, up, starboard);
  const heading = Math.atan2(forward.x, forward.z) * (180 / Math.PI);
  const pitch = Math.asin(Math.max(-1, Math.min(1, forward.y))) * (180 / Math.PI);
  return {
    ...INITIAL_VISUAL_STATE,
    position: origin,
    velocity: { x: forward.x * speed, y: forward.y * speed, z: forward.z * speed },
    orientation,
    angularVelocity: { x: 0, y: 0, z: 0 },
    airspeed: speed,
    altitude: origin.y,
    altitudeAgl: 0,
    verticalSpeed: forward.y * speed,
    heading,
    pitch,
    bank: Math.atan2(-starboard.y, up.y) * (180 / Math.PI),
    angleOfAttack: 0,
    sideslip: 0,
    throttle: run.throttle,
    elevator: 0,
    aileron: 0,
    rudder: 0,
    brake: 0,
    flaps: 0,
    gear: 1,
    onGround: true,
    simulationTime,
    autoland: null,
    vehicle: payload,
  };
}
