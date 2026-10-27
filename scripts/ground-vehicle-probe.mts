/**
 * The LandCruiser 76 driven headless over the real world, as tables:
 * `npx tsx scripts/ground-vehicle-probe.mts [section...] [--seeds=N] [--provinces=a,b]`,
 * sections from
 *
 * - open: about 2 km of open country from the home airport's road head, in
 *   4H at up to 36 km/h, on a line kept off the sea, off the roads, clear of
 *   anything the car can hit and under 22 degrees between 10 m samples,
 *   crossing a road only where it runs at grade (no batter over 20 degrees
 *   between 2 m samples).
 * - slope: the steepest fall-line climb within 4 km of the airport, at most
 *   30 degrees over its 120 m and 32 over any 10 m of it (the plan's 4L
 *   climb), from rest in 4L at 3 m/s.
 * - ford: a river posted across the flattest open ground on that line, as
 *   the renderer posts one (`packHydrologyWater`): 10 m wide, 0.5 m deep at
 *   the crossing, flowing 1 m/s, crossed at 2 m/s.
 * - show: the default world only. From the car's start on the apron round
 *   onto the sealed airport road, along it and the gravel roads to the
 *   steepest gravel climb within reach, and through a ford posted across the
 *   gravel beyond it, as a table of stretches.
 *
 * Every world is a seed (the default and 1..N-1) with a forced climate
 * province (every one unless `--provinces` names some), built as the
 * simulation worker builds the car's: the world's terrain with the road
 * regions round the airport installed (their earthworks and paint), the
 * airports', marina's and guardrails' colliders, and the sea and posted
 * rivers through one water composite. The wind is still. Analytic worlds
 * trace no rivers and their few lakes lie 4 to 7 km from the airport, so the
 * fords are posted.
 *
 * The driver is a pure-pursuit steer on a 2 m polyline with a speed profile
 * (each point's cap, 2.5 m/s^2 of lateral acceleration on its curvature,
 * braking at 2.5 m/s^2 ahead of it) and a PI on the accelerator; off the
 * road it crosses a road at a walk (2.5 m/s), as a driver takes a ditch.
 * Stuck is the accelerator past half for 3 s under 0.25 m/s: the driver backs
 * 4 m straight off in R and tries again, and gives a leg up after three
 * stucks within 30 m.
 *
 * Each leg reports how it ended, its distance, time and average speed, the
 * stuck events, the peak pitch and roll, the deepest wading and the step
 * time (mean, 99.9th percentile and worst, after the first 2 s). docs/CAR_MODEL.md ("Driving the world") keeps the summary.
 *
 * For digging into one world: `PROBE_SEED=3` (or `default`) drives that seed
 * only; `PROBE_TRACE=1` prints the car's state every 15 steps, the show
 * route's sharp turns and the garbage collections behind slow steps;
 * `PROBE_PROFILE_FROM=k` (with the trace) prints the ground and the road
 * pieces under the show route from its point k; `PROBE_NO_ROADS=1` leaves
 * the road regions out.
 */
import type { CarControlState } from "../src/game/types";
import { createSurfaceSpawn } from "../src/game/surfaceSpawn";
import { SurfaceMaterial } from "../src/render/webgpu/terrain/surfaceMaterials";
import { GroundVehicleSimulator } from "../src/sim/ground";
import { CarColliders } from "../src/sim/ground/carColliders";
import { outerAngle, rackLimit } from "../src/sim/ground/steering";
import { DEFAULT_CAR_SETUP, NEUTRAL_BOAT_CONTROLS, NEUTRAL_CAR_CONTROLS } from "../src/sim/surface";
import { sampleGroundHeight } from "../src/sim/terrainGrid";
import { CalmWaterSurface } from "../src/sim/water/calmWater";
import { createWaterSurfaceSample } from "../src/sim/water";
import { WaterSurfaceComposite } from "../src/sim/water/compositeWater";
import { HydrologyWaterSource, packHydrologyWater, type HydrologyWaterRiver } from "../src/sim/water/hydrologyWater";
import { LANDCRUISER_76 } from "../src/vehicles/landcruiser76";
import { runwayToWorld, worldToRunway } from "../src/world/airport";
import { CLIMATE_PROVINCE_NAMES, type ClimateProvinceName } from "../src/world/climateProvince";
import { clearInfrastructureRegions, installInfrastructureRegions } from "../src/world/infrastructure";
import { ROAD_CLASS, type RoadClassId } from "../src/world/roads/roadClasses";
import { roadRegionInfrastructure } from "../src/world/roads/roadInfrastructure";
import { ROAD_LAYERS, roadNetworkFor, roadRegionOf, type RoadPiece } from "../src/world/roads/roadNetwork";
import { airportRoadHead } from "../src/world/roads/roadNodes";
import type { WorldDefinition } from "../src/world/types";
import { createWorld } from "../src/world/world";
import type { ColliderAabb } from "../src/sim/colliders";

const STEP = 1 / 120;
const DEG = Math.PI / 180;
const KMH = 1 / 3.6;
const SPACING = 2;
const SECTIONS = ["open", "slope", "ford", "show"] as const;
type Section = (typeof SECTIONS)[number];

const args = process.argv.slice(2);
const asked = args.filter((a) => !a.startsWith("--"));
for (const name of asked) {
  if (!(SECTIONS as readonly string[]).includes(name)) throw new Error(`Unknown section ${name}: ${SECTIONS.join(", ")}`);
}
const option = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const SEEDS = Number(option("seeds") ?? 5);
const PROVINCES = (option("provinces")?.split(",") ?? [...CLIMATE_PROVINCE_NAMES]) as ClimateProvinceName[];
for (const p of PROVINCES) if (!CLIMATE_PROVINCE_NAMES.includes(p)) throw new Error(`Unknown province ${p}`);
const run = (section: Section) => asked.length === 0 || asked.includes(section);

const TRACE = process.env.PROBE_TRACE === "1";
const gcPauses: { startTime: number; duration: number }[] = [];
const slowSteps: { started: number; end: number; reads: number }[] = [];
if (TRACE) {
  const { PerformanceObserver } = await import("node:perf_hooks");
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) gcPauses.push({ startTime: entry.startTime, duration: entry.duration });
  }).observe({ entryTypes: ["gc"] });
  process.on("exit", () => {
    const tally = new Map<string, number>();
    for (const step of slowSteps) {
      const gc = gcPauses.some((g) => g.startTime < step.end && g.startTime + g.duration > step.started);
      const key = gc ? "gc" : step.reads > 0 ? "some" : "0";
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    console.log("slow steps (>500 us) by cause:", [...tally].map(([k, v]) => `${k === "gc" ? "in a GC pause" : `${k} reads`}: ${v}`).join(", "));
  });
}
let traceHeight: (x: number, z: number) => number = () => NaN;
const f = (value: number, digits = 1, width = 6) => value.toFixed(digits).padStart(width);

// ---------------------------------------------------------------------------
// The world, as the simulation worker gives it to the car.

interface Site {
  readonly world: WorldDefinition;
  readonly label: string;
  readonly height: (x: number, z: number) => number;
  readonly colliders: CarColliders;
  /** Every road piece round the airport, both layers, each once. */
  readonly pieces: readonly RoadPiece[];
  /** Road pieces binned on a 64 m grid, for "is a road near". */
  readonly roadBins: Map<string, RoadPiece[]>;
}

const ROAD_BIN = 64;
const binKey = (x: number, z: number) => `${Math.floor(x / ROAD_BIN)},${Math.floor(z / ROAD_BIN)}`;

function buildSite(seed: number | undefined, province: ClimateProvinceName | undefined): Site {
  const world = createWorld(seed, province ? { climateProvince: province } : {});
  const airport = world.airport!;
  const network = roadNetworkFor(world);
  const rx = roadRegionOf(airport.centerX);
  const rz = roadRegionOf(airport.centerZ);
  const regions = [];
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      for (const layer of ROAD_LAYERS) regions.push(network.region(layer, rx + dx, rz + dz));
    }
  }
  if (process.env.PROBE_NO_ROADS !== "1") installInfrastructureRegions(world, regions.map((region) => roadRegionInfrastructure(world, region)));
  const seen = new Set<string>();
  const pieces: RoadPiece[] = [];
  for (const region of regions) {
    for (const piece of region.pieces) {
      const key = `${piece.edgeId}:${piece.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pieces.push(piece);
    }
  }
  const roadBins = new Map<string, RoadPiece[]>();
  for (const piece of pieces) {
    const x0 = Math.floor(Math.min(piece.ax, piece.bx) / ROAD_BIN);
    const x1 = Math.floor(Math.max(piece.ax, piece.bx) / ROAD_BIN);
    const z0 = Math.floor(Math.min(piece.az, piece.bz) / ROAD_BIN);
    const z1 = Math.floor(Math.max(piece.az, piece.bz) / ROAD_BIN);
    for (let i = x0; i <= x1; i += 1) {
      for (let j = z0; j <= z1; j += 1) {
        const key = `${i},${j}`;
        const bin = roadBins.get(key) ?? [];
        bin.push(piece);
        roadBins.set(key, bin);
      }
    }
  }
  const height = (x: number, z: number) => sampleGroundHeight(world, x, z);
  return {
    world,
    label: `${province ?? "natural"}/${seed ?? "default"}`,
    height,
    colliders: new CarColliders(world, height),
    pieces,
    roadBins,
  };
}

function roadDistance(site: Site, x: number, z: number): number {
  let best = Infinity;
  for (const piece of site.roadBins.get(binKey(x, z)) ?? []) {
    const dx = piece.bx - piece.ax;
    const dz = piece.bz - piece.az;
    const t = Math.max(0, Math.min(1, ((x - piece.ax) * dx + (z - piece.az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - piece.ax - t * dx, z - piece.az - t * dz));
  }
  return best;
}

/** How many distinct roads (edges) pass within `radius` of (x, z). */
function roadsNear(site: Site, x: number, z: number, radius: number): number {
  const edges = new Set<number>();
  for (const piece of site.roadBins.get(binKey(x, z)) ?? []) {
    const dx = piece.bx - piece.ax;
    const dz = piece.bz - piece.az;
    const t = Math.max(0, Math.min(1, ((x - piece.ax) * dx + (z - piece.az) * dz) / (dx * dx + dz * dz || 1)));
    if (Math.hypot(x - piece.ax - t * dx, z - piece.az - t * dz) < radius) edges.add(piece.edgeId);
  }
  return edges.size;
}

const box: ColliderAabb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
const hits: number[] = [];
function colliderNear(site: Site, x: number, z: number, radius: number): boolean {
  const y = site.height(x, z);
  box.minX = x - radius;
  box.maxX = x + radius;
  box.minZ = z - radius;
  box.maxZ = z + radius;
  box.minY = y - 5;
  box.maxY = y + 8;
  hits.length = 0;
  return site.colliders.colliders.query(box, hits) > 0;
}

/** The ground's steepest grade at (x, z) over 5 m either way, rise per metre. */
function gradeAt(site: Site, x: number, z: number): number {
  const gx = (site.height(x + 5, z) - site.height(x - 5, z)) / 10;
  const gz = (site.height(x, z + 5) - site.height(x, z - 5)) / 10;
  return Math.hypot(gx, gz);
}

// ---------------------------------------------------------------------------
// Routes: a polyline at 2 m with a speed cap and a transfer range per point.

type Range = "2H" | "4H" | "4L";

interface Route {
  readonly x: Float64Array;
  readonly z: Float64Array;
  /** The planned speed at each point (cap, curvature and braking ahead), m/s. */
  readonly speed: Float64Array;
  /** Which stretch each point belongs to. */
  readonly stretch: Uint8Array;
  readonly names: readonly string[];
  readonly ranges: readonly Range[];
}

interface RouteBuilder {
  readonly x: number[];
  readonly z: number[];
  readonly cap: number[];
  readonly stretch: number[];
  readonly names: string[];
  readonly ranges: Range[];
}

function routeBuilder(): RouteBuilder {
  return { x: [], z: [], cap: [], stretch: [], names: [], ranges: [] };
}

/** Add a polyline to the route, resampled at 2 m, as stretch `name` at `cap` m/s in `range`. */
function addStretch(route: RouteBuilder, name: string, range: Range, cap: number, xs: readonly number[], zs: readonly number[]): void {
  let stretch = route.names.indexOf(name);
  if (stretch < 0) {
    stretch = route.names.length;
    route.names.push(name);
    route.ranges.push(range);
  }
  let px = route.x.length > 0 ? route.x[route.x.length - 1]! : xs[0]!;
  let pz = route.z.length > 0 ? route.z[route.z.length - 1]! : zs[0]!;
  if (route.x.length === 0) {
    route.x.push(px);
    route.z.push(pz);
    route.cap.push(cap);
    route.stretch.push(stretch);
  }
  for (let i = 0; i < xs.length; i += 1) {
    const tx = xs[i]!;
    const tz = zs[i]!;
    const length = Math.hypot(tx - px, tz - pz);
    const count = Math.floor(length / SPACING);
    for (let k = 1; k <= count; k += 1) {
      const t = (k * SPACING) / length;
      route.x.push(px + (tx - px) * t);
      route.z.push(pz + (tz - pz) * t);
      route.cap.push(cap);
      route.stretch.push(stretch);
    }
    if (count > 0) {
      const t = (count * SPACING) / length;
      px += (tx - px) * t;
      pz += (tz - pz) * t;
    }
  }
}

function finishRoute(route: RouteBuilder, lateral = 2.5, braking = 2.5): Route {
  const n = route.x.length;
  const speed = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    // Curvature from the turn over +-6 m.
    const a = Math.max(0, i - 3);
    const b = Math.min(n - 1, i + 3);
    let cap = route.cap[i]!;
    if (b - a >= 2) {
      const h0 = Math.atan2(route.x[i]! - route.x[a]!, route.z[i]! - route.z[a]!);
      const h1 = Math.atan2(route.x[b]! - route.x[i]!, route.z[b]! - route.z[i]!);
      const turn = Math.abs(wrap(h1 - h0));
      const curvature = turn / ((b - a) * SPACING * 0.5);
      if (curvature > 1e-4) cap = Math.min(cap, Math.sqrt(lateral / curvature));
    }
    speed[i] = Math.max(1.5, cap);
  }
  speed[n - 1] = 0;
  for (let i = n - 2; i >= 0; i -= 1) speed[i] = Math.min(speed[i]!, Math.sqrt(speed[i + 1]! ** 2 + 2 * braking * SPACING));
  return {
    x: Float64Array.from(route.x),
    z: Float64Array.from(route.z),
    speed,
    stretch: Uint8Array.from(route.stretch),
    names: route.names,
    ranges: route.ranges,
  };
}

function wrap(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

// ---------------------------------------------------------------------------
// The car and its driver.

const FULL_LOCK_CENTRE = Math.atan(
  2 / (1 / Math.tan(LANDCRUISER_76.steering.innerLock) + 1 / Math.tan(outerAngle(LANDCRUISER_76.steering.innerLock))),
);
const WHEELBASE = LANDCRUISER_76.geometry.wheelbase;

function startCar(site: Site, x: number, z: number, heading: number, rivers: readonly HydrologyWaterRiver[] = []): GroundVehicleSimulator {
  const world = site.world;
  traceHeight = site.height;
  const sim = new GroundVehicleSimulator({
    position: { x, y: site.height(x, z), z },
    heading,
    moored: false,
    car: { ...DEFAULT_CAR_SETUP },
  });
  const inland = new HydrologyWaterSource(site.height);
  if (rivers.length > 0) inland.setRegion("probe-ford", packHydrologyWater(rivers, []));
  sim.setEnvironment({
    water: new WaterSurfaceComposite(new CalmWaterSurface(world.seaLevel, site.height), inland, world.seaLevel),
    wind: { x: 0, y: 0, z: 0 },
    bedHeight: site.height,
    world,
    colliders: site.colliders.colliders,
    gravity: 9.80665,
  });
  return sim;
}

interface StretchTally {
  distance: number;
  seconds: number;
  topSpeed: number;
  pitch: number;
  roll: number;
  wading: number;
  /** Tyre-seconds on each material, and in water (-1). */
  readonly surfaces: Map<number, number>;
  readonly ranges: Set<string>;
  readonly gears: Set<number>;
  abs: number;
  traction: number;
  climb: number;
}

interface LegResult {
  outcome: "done" | "stuck" | "crashed" | "rolled" | "drowned" | "timeout";
  distance: number;
  seconds: number;
  stuck: number;
  pitch: number;
  roll: number;
  wading: number;
  meanStep: number;
  /** The 99.9th percentile of the steps after the first 2 s, us. */
  slowStep: number;
  /** The slowest step after the first 2 s (a collector pause or a JIT tier change lands in one), us. */
  worstStep: number;
  /** How far off the line the car ended, m. */
  offLine: number;
  readonly stretches: StretchTally[];
  readonly stuckAt: string[];
}

const pedals: CarControlState = { ...NEUTRAL_CAR_CONTROLS };
const controls = { assist: "pilot" as const, boat: NEUTRAL_BOAT_CONTROLS, car: pedals };

function setPedals(sim: GroundVehicleSimulator, accelerator: number, brake: number, steer: number, handbrake = 0): void {
  pedals.accelerator = accelerator;
  pedals.brake = brake;
  pedals.steer = steer;
  pedals.handbrake = handbrake;
  sim.setControls(controls);
}

function pose(sim: GroundVehicleSimulator) {
  const q = sim.state.orientation;
  const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
  const fy = 2 * (q.x * q.y + q.w * q.z);
  const fz = 2 * (q.x * q.z - q.w * q.y);
  const ry = 2 * (q.y * q.z - q.w * q.x);
  const v = sim.state.velocity;
  return {
    heading: Math.atan2(fx, fz),
    pitch: Math.asin(Math.max(-1, Math.min(1, fy))),
    roll: Math.asin(Math.max(-1, Math.min(1, ry))),
    speed: v.x * fx + v.y * fy + v.z * fz,
  };
}

/** Drive `route` from where the car stands; it must already be on the route's first point. */
function driveRoute(sim: GroundVehicleSimulator, route: Route, maxSeconds: number): LegResult {
  const n = route.x.length;
  const stretches: StretchTally[] = route.names.map(() => ({
    distance: 0, seconds: 0, topSpeed: 0, pitch: 0, roll: 0, wading: 0,
    surfaces: new Map(), ranges: new Set(), gears: new Set(), abs: 0, traction: 0, climb: 0,
  }));
  const result: LegResult = {
    outcome: "timeout", distance: 0, seconds: 0, stuck: 0, pitch: 0, roll: 0, wading: 0,
    meanStep: 0, slowStep: 0, worstStep: 0, offLine: 0, stretches, stuckAt: [],
  };
  pedals.rangePresses = 0;
  pedals.lockPresses = 0;
  let index = 0;
  let integral = 0;
  let slowFor = 0;
  /** The back-off after a stuck: 0 driving, 1 pedals up, 2 reversing, 3 stopping, 4 pedals up again. */
  let recovery = 0;
  let recoveryTime = 0;
  let reversedFrom = 0;
  const stuckProgress: number[] = [];
  let stepSum = 0;
  let steps = 0;
  let lastReads = 0;
  let lastStretch = -1;
  let lastY = 0;
  const limit = Math.round(maxSeconds / STEP);
  const stepTimes = new Float64Array(limit);
  let px = sim.state.position.x;
  let pz = sim.state.position.z;
  let rangeWait = 0;
  for (let i = 0; i < limit; i += 1) {
    const at = sim.state.position;
    // The nearest route point, searching ahead only.
    let best = Infinity;
    for (let k = index; k < Math.min(n, index + 40); k += 1) {
      const d = (route.x[k]! - at.x) ** 2 + (route.z[k]! - at.z) ** 2;
      if (d < best) {
        best = d;
        index = k;
      }
    }
    result.offLine = Math.sqrt(best);
    const p = pose(sim);
    const stretch = route.stretch[index]!;
    if (index >= n - 2 && Math.abs(p.speed) < 0.3) {
      result.outcome = "done";
      break;
    }
    // The range the stretch asks for: 4L only from a stop.
    const range = route.ranges[stretch]!;
    let hold = false;
    if (sim.transmission.range !== range) {
      rangeWait += STEP;
      if (rangeWait > 0.5) {
        rangeWait = 0;
        pedals.rangePresses += 1;
      }
      hold = range === "4L" || (sim.transmission.range === "4L");
    }
    const speed = p.speed;
    const lookahead = Math.max(5, Math.min(16, 4 + 0.6 * Math.abs(speed)));
    const target = Math.min(n - 1, index + Math.round(lookahead / SPACING));
    const alpha = wrap(p.heading - Math.atan2(route.x[target]! - at.x, route.z[target]! - at.z));
    const wheel = Math.atan((2 * WHEELBASE * Math.sin(alpha)) / lookahead);
    let steer = Math.max(-1, Math.min(1, wheel / (FULL_LOCK_CENTRE * rackLimit(Math.abs(speed)))));
    const wanted = hold ? 0 : route.speed[index]!;
    let accelerator = 0;
    let brake = 0;
    if (recovery > 0) {
      // Pedals up; S held at the stop selects R and is then its accelerator: back
      // straight off 4 m at up to 1.5 m/s; W (R's brake) stops it; pedals up, so
      // the next W selects D.
      recoveryTime += STEP;
      steer = 0;
      integral = 0;
      if (recovery === 1 && recoveryTime > 0.4) {
        recovery = 2;
        recoveryTime = 0;
        reversedFrom = result.distance;
      } else if (recovery === 2) {
        brake = speed > -1.5 ? 0.35 : 0;
        accelerator = speed < -1.8 ? 0.4 : 0;
        if (result.distance - reversedFrom > 4 || recoveryTime > 6) {
          recovery = 3;
          recoveryTime = 0;
        }
      } else if (recovery === 3) {
        accelerator = 0.6;
        if (Math.abs(speed) < 0.1 || recoveryTime > 4) {
          recovery = 4;
          recoveryTime = 0;
        }
      } else if (recovery === 4 && recoveryTime > 0.4) {
        recovery = 0;
      }
    } else {
      const error = wanted - speed;
      if (error > 0) integral = Math.min(10, integral + error * STEP);
      else integral = Math.max(0, integral + 2 * error * STEP);
      accelerator = Math.max(0, Math.min(1, 0.08 + 0.3 * error + 0.1 * integral + 1.2 * Math.max(0, Math.sin(p.pitch))));
      if (error < -0.8 || wanted === 0) {
        accelerator = 0;
        brake = wanted === 0 ? 0.5 : Math.min(1, -0.2 * error);
      }
      if (wanted > 0.8 && Math.abs(speed) < 0.25 && accelerator > 0.5) slowFor += STEP;
      else slowFor = 0;
      if (slowFor > 3) {
        slowFor = 0;
        result.stuck += 1;
        result.stuckAt.push(`${(result.distance).toFixed(0)} m`);
        stuckProgress.push(index);
        if (stuckProgress.length >= 3 && (index - stuckProgress[stuckProgress.length - 3]!) * SPACING < 30) {
          result.outcome = "stuck";
          break;
        }
        recovery = 1;
        recoveryTime = 0;
      }
    }
    setPedals(sim, accelerator, brake, steer, (hold && Math.abs(speed) < 0.3) || recovery === 4 ? 1 : 0);
    const started = performance.now();
    sim.step(STEP);
    const took = (performance.now() - started) * 1000;
    if (TRACE && i >= 240 && took > 500) {
      const reads = (sim as unknown as { lattice: { reads: number } }).lattice.reads;
      slowSteps.push({ started, end: started + took / 1000, reads: reads - lastReads });
    }
    lastReads = (sim as unknown as { lattice: { reads: number } }).lattice.reads;
    stepSum += took;
    stepTimes[steps] = took;
    steps += 1;

    const now = sim.state.position;
    if (TRACE && (i % 15 === 0)) {
      const v = sim.visualState();
      console.log(`t ${sim.state.time.toFixed(2)} d ${result.distance.toFixed(1)} i ${index} v ${speed.toFixed(2)} want ${wanted.toFixed(1)} acc ${accelerator.toFixed(2)} brk ${brake.toFixed(2)} st ${steer.toFixed(2)} pitch ${(p.pitch / DEG).toFixed(1)} roll ${(p.roll / DEG).toFixed(1)} y ${now.y.toFixed(2)} gnd ${traceHeight(now.x, now.z).toFixed(2)} loads ${v.wheelLoad.map((l) => l.toFixed(0)).join(",")} surf ${v.wheelSurface.join(",")} gear ${v.gear} ${v.range} wade ${v.wadingDepth.toFixed(2)} off ${result.offLine.toFixed(1)}`);
    }
    const moved = Math.hypot(now.x - px, now.z - pz);
    px = now.x;
    pz = now.z;
    result.distance += moved;
    const tally = stretches[stretch]!;
    // The rise while in the stretch (a stretch may come in pieces).
    if (stretch === lastStretch) tally.climb += now.y - lastY;
    lastStretch = stretch;
    lastY = now.y;
    tally.distance += moved;
    tally.seconds += STEP;
    tally.topSpeed = Math.max(tally.topSpeed, Math.abs(speed));
    tally.pitch = Math.max(tally.pitch, Math.abs(p.pitch));
    tally.roll = Math.max(tally.roll, Math.abs(p.roll));
    if (i % 12 === 0) {
      const visual = sim.visualState();
      tally.wading = Math.max(tally.wading, visual.wadingDepth);
      tally.ranges.add(visual.range);
      if (visual.gear > 0) tally.gears.add(visual.gear);
      if (visual.absActive) tally.abs += 0.1;
      if (visual.tractionControlActive) tally.traction += 0.1;
      for (let w = 0; w < 4; w += 1) {
        if (visual.wheelLoad[w]! <= 0) continue;
        const material = visual.wheelSurface[w]!;
        tally.surfaces.set(material, (tally.surfaces.get(material) ?? 0) + 0.1);
      }
      if (visual.rolled) {
        result.outcome = "rolled";
        break;
      }
      if (visual.flooded) {
        result.outcome = "drowned";
        break;
      }
    }
    if (sim.state.crashed) {
      result.outcome = "crashed";
      break;
    }
  }
  result.seconds = sim.state.time;
  result.meanStep = stepSum / Math.max(1, steps);
  const settled = stepTimes.slice(Math.min(240, steps), steps).sort();
  if (settled.length > 0) {
    result.slowStep = settled[Math.min(settled.length - 1, Math.floor(settled.length * 0.999))]!;
    result.worstStep = settled[settled.length - 1]!;
  }
  for (const tally of stretches) {
    result.pitch = Math.max(result.pitch, tally.pitch);
    result.roll = Math.max(result.roll, tally.roll);
    result.wading = Math.max(result.wading, tally.wading);
  }
  return result;
}

/** Hold the brake until the car has settled at its start. */
function settle(sim: GroundVehicleSimulator, rangePresses = 0): void {
  pedals.rangePresses = 0;
  setPedals(sim, 0, 0.6, 0);
  for (let i = 0; i < 120; i += 1) sim.step(STEP);
  pedals.rangePresses = rangePresses;
  setPedals(sim, 0, 0.6, 0);
  for (let i = 0; i < 60; i += 1) sim.step(STEP);
  setPedals(sim, 0, 0, 0);
  sim.step(STEP);
}

// ---------------------------------------------------------------------------
// The open-country line, the slope and the ford.

interface Line {
  readonly x: number[];
  readonly z: number[];
  readonly maxGrade: number;
}

/**
 * About 2 km from the road head's lead-out, in 250 m legs, each turning at
 * most 75 degrees from the last (the first leaves the road at 35 degrees or
 * more). A road may be crossed, not followed: at most 40 m within 10 m of one,
 * and not where it runs in a cut or on a fill.
 */
const CROSSING_BATTER_DEGREES = 20;

function openLine(site: Site): Line | null {
  const head = airportRoadHead(site.world)!;
  const airport = site.world.airport!;
  const platform = (sx: number, sz: number) => {
    const at = worldToRunway(airport, sx, sz);
    const margin = airport.terrainBlendDistance + 150;
    return Math.abs(at.along) < airport.runwayLength * 0.5 + margin
      && Math.abs(at.across) < airport.runwayWidth * 0.5 + airport.shoulderWidth + margin;
  };
  let x = head.exitX;
  let z = head.exitZ;
  let heading = head.headingRadians;
  const xs = [x];
  const zs = [z];
  let maxGrade = 0;
  const offsets = [35, -35, 50, -50, 20, -20, 65, -65, 0, 80, -80];
  for (let leg = 0; leg < 8; leg += 1) {
    let chosen: { heading: number; grade: number } | null = null;
    for (const offset of leg === 0 ? offsets : [0, 15, -15, 30, -30, 45, -45, 60, -60, 75, -75]) {
      const h = heading + offset * DEG;
      const dx = Math.sin(h);
      const dz = Math.cos(h);
      let ok = true;
      let grade = 0;
      let nearRoad = 0;
      let last = site.height(x, z);
      for (let s = 10; s <= 250 && ok; s += 10) {
        const sx = x + dx * s;
        const sz = z + dz * s;
        const y = site.height(sx, sz);
        const step = Math.abs(y - last) / 10;
        last = y;
        grade = Math.max(grade, step);
        const side = Math.abs(site.height(sx - dz * 4, sz + dx * 4) - site.height(sx + dz * 4, sz - dx * 4)) / 8;
        const toRoad = roadDistance(site, sx, sz);
        nearRoad = toRoad < 10 ? nearRoad + 1 : 0;
        ok = y > site.world.seaLevel + 1 && step < Math.tan(22 * DEG) && side < Math.tan(20 * DEG)
          && nearRoad <= 4 && !platform(sx, sz) && !colliderNear(site, sx, sz, 8);
        // A road in a cut or on a fill has batters a 10 m stride steps over: walk the last 10 m at 2 m.
        if (ok && toRoad < 20) {
          let fine = site.height(sx - dx * 10, sz - dz * 10);
          for (let f = 8; f >= 0 && ok; f -= 2) {
            const fy = site.height(sx - dx * f, sz - dz * f);
            ok = Math.abs(fy - fine) / 2 < Math.tan(CROSSING_BATTER_DEGREES * DEG);
            fine = fy;
          }
        }
      }
      if (ok) {
        chosen = { heading: h, grade };
        break;
      }
    }
    if (!chosen) break;
    heading = chosen.heading;
    maxGrade = Math.max(maxGrade, chosen.grade);
    x += Math.sin(heading) * 250;
    z += Math.cos(heading) * 250;
    xs.push(x);
    zs.push(z);
  }
  return xs.length >= 5 ? { x: xs, z: zs, maxGrade } : null;
}

interface Slope {
  readonly x0: number;
  readonly z0: number;
  readonly heading: number;
  readonly grade: number;
  readonly steepest: number;
}

/** The steepest 120 m fall-line climb within 4 km of the airport, off its platform and the roads. */
function findSlope(site: Site): Slope | null {
  const airport = site.world.airport!;
  const keepOut = airport.runwayLength * 0.5 + 400;
  const candidates: { x: number; z: number; g: number }[] = [];
  for (let dx = -4000; dx <= 4000; dx += 100) {
    for (let dz = -4000; dz <= 4000; dz += 100) {
      const r = Math.hypot(dx, dz);
      if (r > 4000 || r < keepOut) continue;
      const x = airport.centerX + dx;
      const z = airport.centerZ + dz;
      if (site.height(x, z) < site.world.seaLevel + 2) continue;
      candidates.push({ x, z, g: gradeAt(site, x, z) });
    }
  }
  candidates.sort((a, b) => b.g - a.g);
  let best: Slope | null = null;
  for (const c of candidates.slice(0, 60)) {
    // Walk down the fall line 60 m to a foot, then measure the climb up it.
    const gx = (site.height(c.x + 5, c.z) - site.height(c.x - 5, c.z)) / 10;
    const gz = (site.height(c.x, c.z + 5) - site.height(c.x, c.z - 5)) / 10;
    const heading = Math.atan2(gx, gz);
    const ux = Math.sin(heading);
    const uz = Math.cos(heading);
    const x0 = c.x - ux * 60;
    const z0 = c.z - uz * 60;
    let ok = true;
    let steepest = 0;
    let last = site.height(x0, z0);
    for (let s = 10; s <= 120 && ok; s += 10) {
      const sx = x0 + ux * s;
      const sz = z0 + uz * s;
      const y = site.height(sx, sz);
      const step = (y - last) / 10;
      last = y;
      steepest = Math.max(steepest, step);
      const side = Math.abs(site.height(sx - uz * 4, sz + ux * 4) - site.height(sx + uz * 4, sz - ux * 4)) / 8;
      ok = step > -0.05 && step < Math.tan(32 * DEG) && side < Math.tan(25 * DEG) && roadDistance(site, sx, sz) > 12
        && !colliderNear(site, sx, sz, 8) && y > site.world.seaLevel + 1;
    }
    for (let s = -40; s < 0 && ok; s += 10) ok = site.height(x0 + ux * s, z0 + uz * s) > site.world.seaLevel + 1 && !colliderNear(site, x0 + ux * s, z0 + uz * s, 8);
    if (!ok) continue;
    const grade = (site.height(x0 + ux * 120, z0 + uz * 120) - site.height(x0, z0)) / 120;
    if (grade > Math.tan(30 * DEG)) continue;
    if (!best || grade > best.grade) best = { x0, z0, heading, grade, steepest };
  }
  return best;
}

interface Ford {
  readonly x: number;
  readonly z: number;
  /** Along the route, the way the car crosses. */
  readonly heading: number;
  readonly river: HydrologyWaterRiver;
}

/** Off the road, within this of a road's centreline the driver slows to `ROAD_CROSSING_SPEED`, m and m/s. */
const ROAD_CROSSING_METERS = 12;
const ROAD_CROSSING_SPEED = 2.5;
/** On the road, at a junction or a crossing, m/s. */
const JUNCTION_SPEED = 3;

const FORD_DEPTH = 0.5;
const FORD_WIDTH = 10;
const FORD_FLOW = 1;

/**
 * A river across `route` at its flattest point between `from` and `to`
 * (route indices), 0.5 m deep there; `offRoad`, with the 64 m before it and
 * the 54 m after it at least 15 m from any road.
 */
function postFord(site: Site, route: { x: ArrayLike<number>; z: ArrayLike<number> }, from: number, to: number, offRoad: boolean): Ford | null {
  let best: { k: number; score: number } | null = null;
  for (let k = from; k <= to; k += 2) {
    const a = Math.max(0, k - 10);
    const b = Math.min(route.x.length - 1, k + 10);
    const heading = Math.atan2(route.x[b]! - route.x[a]!, route.z[b]! - route.z[a]!);
    const turn = Math.abs(wrap(heading - Math.atan2(route.x[k]! - route.x[a]!, route.z[k]! - route.z[a]!)));
    if (turn > 4 * DEG) continue;
    const x = route.x[k]!;
    const z = route.z[k]!;
    if (offRoad) {
      let clear = true;
      for (let j = Math.max(0, k - 32); j <= Math.min(route.x.length - 1, k + 27) && clear; j += 2) {
        clear = roadDistance(site, route.x[j]!, route.z[j]!) > 15;
      }
      if (!clear) continue;
    }
    const along = Math.abs(site.height(route.x[b]!, route.z[b]!) - site.height(route.x[a]!, route.z[a]!)) / ((b - a) * SPACING);
    const side = Math.abs(site.height(x - Math.cos(heading) * 6, z + Math.sin(heading) * 6)
      - site.height(x + Math.cos(heading) * 6, z - Math.sin(heading) * 6)) / 12;
    const score = along + side;
    if (!best || score < best.score) best = { k, score };
  }
  if (!best) return null;
  const k = best.k;
  const a = Math.max(0, k - 10);
  const b = Math.min(route.x.length - 1, k + 10);
  const heading = Math.atan2(route.x[b]! - route.x[a]!, route.z[b]! - route.z[a]!);
  const x = route.x[k]!;
  const z = route.z[k]!;
  // Across the route, from its higher side down.
  let nx = Math.cos(heading);
  let nz = -Math.sin(heading);
  if (site.height(x + nx * 30, z + nz * 30) > site.height(x - nx * 30, z - nz * 30)) {
    nx = -nx;
    nz = -nz;
  }
  const crossing = site.height(x, z) + FORD_DEPTH;
  const points = [];
  let y = Infinity;
  for (let s = -40; s <= 40; s += 8) {
    const sx = x + nx * s;
    const sz = z + nz * s;
    // Each station 0.5 m over its bed, never rising downstream, and exactly that at the crossing.
    y = Math.min(y, s === 0 ? crossing : site.height(sx, sz) + FORD_DEPTH);
    points.push({ x: sx, y: s === 0 ? crossing : y, z: sz, widthMeters: FORD_WIDTH, flowSpeedMetersPerSecond: FORD_FLOW });
  }
  return { x, z, heading, river: { points } };
}

// ---------------------------------------------------------------------------
// The legs.

interface Row {
  readonly site: string;
  readonly note: string;
  readonly result: LegResult | null;
}

function legRow(site: Site, note: string, result: LegResult | null): Row {
  return { site: site.label, note, result };
}

function openLeg(site: Site, line: Line): LegResult {
  const route = routeBuilder();
  addStretch(route, "open", "4H", 36 * KMH, line.x, line.z);
  // A road's side ditch (0.5 m deep and 1.5 m wide on gravel) is crossed at a walk.
  for (let k = 0; k < route.x.length; k += 1) {
    if (roadDistance(site, route.x[k]!, route.z[k]!) < ROAD_CROSSING_METERS) route.cap[k] = ROAD_CROSSING_SPEED;
  }
  const r = finishRoute(route, 2.0, 2.0);
  const sim = startCar(site, r.x[0]!, r.z[0]!, Math.atan2(r.x[1]! - r.x[0]!, r.z[1]! - r.z[0]!));
  settle(sim, 1);
  return driveRoute(sim, r, 600);
}

function slopeLeg(site: Site, slope: Slope): LegResult {
  const ux = Math.sin(slope.heading);
  const uz = Math.cos(slope.heading);
  const route = routeBuilder();
  const sx = slope.x0 - ux * 30;
  const sz = slope.z0 - uz * 30;
  route.x.push(sx);
  route.z.push(sz);
  route.cap.push(3);
  route.stretch.push(0);
  route.names.push("climb");
  route.ranges.push("4L");
  addStretch(route, "climb", "4L", 3, [slope.x0 + ux * 140], [slope.z0 + uz * 140]);
  const r = finishRoute(route);
  const sim = startCar(site, sx, sz, slope.heading);
  settle(sim, 2);
  return driveRoute(sim, r, 240);
}

function fordLeg(site: Site, line: Line): { ford: Ford | null; result: LegResult | null } {
  const dense = routeBuilder();
  addStretch(dense, "open", "4H", 10, line.x, line.z);
  const ford = postFord(site, { x: dense.x, z: dense.z }, Math.min(dense.x.length - 60, 300), Math.min(dense.x.length - 60, 800), true);
  if (!ford) return { ford, result: null };
  const ux = Math.sin(ford.heading);
  const uz = Math.cos(ford.heading);
  const route = routeBuilder();
  const start = { x: ford.x - ux * 60, z: ford.z - uz * 60 };
  route.x.push(start.x);
  route.z.push(start.z);
  route.cap.push(6);
  route.stretch.push(0);
  route.names.push("approach");
  route.ranges.push("4H");
  addStretch(route, "approach", "4H", 6, [ford.x - ux * 12], [ford.z - uz * 12]);
  addStretch(route, "ford", "4H", 2, [ford.x + ux * 8], [ford.z + uz * 8]);
  addStretch(route, "out", "4H", 6, [ford.x + ux * 50], [ford.z + uz * 50]);
  const r = finishRoute(route, 2.0, 1.5);
  const sim = startCar(site, start.x, start.z, ford.heading, [ford.river]);
  if (TRACE) {
    const probe = new HydrologyWaterSource(site.height);
    probe.setRegion("probe-ford", packHydrologyWater([ford.river], []));
    const sample = createWaterSurfaceSample();
    for (let s = -10; s <= 10; s += 1) {
      const x = ford.x + ux * s;
      const z = ford.z + uz * s;
      probe.sample(x, z, sample);
      console.log(`ford ${s} m: ${sample.kind} surface ${sample.height.toFixed(2)} bed ${site.height(x, z).toFixed(2)}`);
    }
    console.log(ford.river.points.map((p) => `${p.y.toFixed(2)}/${site.height(p.x, p.z).toFixed(2)}`).join(" "));
  }
  settle(sim, 1);
  return { ford, result: driveRoute(sim, r, 240) };
}

function outcome(result: LegResult | null): string {
  if (!result) return "no site";
  return result.outcome === "done" ? "done" : `${result.outcome} at ${result.distance.toFixed(0)} m`;
}

function legTable(title: string, rows: readonly Row[]): void {
  console.log(`\n${title}`);
  console.log(" world                    route                       outcome            km    km/h  stuck  pitch  roll  wade m  step us  p99.9 us  worst us  tyres on");
  for (const row of rows) {
    const r = row.result;
    const cells = r
      ? `${outcome(r).padEnd(18)} ${f(r.distance / 1000, 2, 5)}  ${f((r.distance / Math.max(1, r.seconds)) * 3.6, 1, 6)}  ${String(r.stuck).padStart(5)}  ${f(r.pitch / DEG, 1, 5)}  ${f(r.roll / DEG, 1, 4)}  ${f(r.wading, 2, 6)}  ${f(r.meanStep, 0, 7)}  ${f(r.slowStep, 0, 7)}  ${f(r.worstStep, 0, 8)}  ${surfaceMix(legSurfaces(r))}`
      : "no site";
    console.log(` ${row.site.padEnd(24)} ${row.note.padEnd(27)} ${cells}`);
  }
  const done = rows.filter((row) => row.result);
  if (done.length === 0) return;
  const results = done.map((row) => row.result!);
  const finished = results.filter((r) => r.outcome === "done").length;
  const stuck = results.reduce((s, r) => s + r.stuck, 0);
  const speed = results.reduce((s, r) => s + (r.distance / Math.max(1, r.seconds)) * 3.6, 0) / results.length;
  console.log(
    ` summary: ${finished}/${results.length} finished, ${stuck} stuck events, ${results.filter((r) => r.outcome === "crashed").length} crashes, `
    + `${results.filter((r) => r.outcome === "rolled").length} rolled, mean ${speed.toFixed(1)} km/h, peak pitch ${(Math.max(...results.map((r) => r.pitch)) / DEG).toFixed(1)} deg, `
    + `peak roll ${(Math.max(...results.map((r) => r.roll)) / DEG).toFixed(1)} deg, mean step ${(results.reduce((s, r) => s + r.meanStep, 0) / results.length).toFixed(0)} us, `
    + `p99.9 step ${Math.max(...results.map((r) => r.slowStep)).toFixed(0)} us at most, worst step ${Math.max(...results.map((r) => r.worstStep)).toFixed(0)} us`,
  );
}

// ---------------------------------------------------------------------------
// The show drive: the apron, the airport road, the gravel, a climb, a ford.

interface RoadEdgeLine {
  readonly classId: RoadClassId;
  readonly x: number[];
  readonly z: number[];
  readonly y: number[];
  readonly a: number;
  readonly b: number;
  readonly length: number;
}

/** The road pieces as whole edges between nodes (ends within 20 m are one node). */
function roadGraph(site: Site): { edges: RoadEdgeLine[]; nodes: { x: number; z: number }[] } {
  const byEdge = new Map<number, RoadPiece[]>();
  for (const piece of site.pieces) {
    const list = byEdge.get(piece.edgeId) ?? [];
    list.push(piece);
    byEdge.set(piece.edgeId, list);
  }
  const nodes: { x: number; z: number }[] = [];
  const node = (x: number, z: number): number => {
    for (let i = 0; i < nodes.length; i += 1) if (Math.hypot(nodes[i]!.x - x, nodes[i]!.z - z) < 20) return i;
    nodes.push({ x, z });
    return nodes.length - 1;
  };
  const edges: RoadEdgeLine[] = [];
  for (const list of byEdge.values()) {
    list.sort((p, q) => p.index - q.index);
    // Only the run from the first piece held, unbroken.
    const x = [list[0]!.ax];
    const z = [list[0]!.az];
    const y = [list[0]!.ha];
    let length = 0;
    for (let i = 0; i < list.length; i += 1) {
      const piece = list[i]!;
      if (i > 0 && piece.index !== list[i - 1]!.index + 1) break;
      x.push(piece.bx);
      z.push(piece.bz);
      y.push(piece.hb);
      length += Math.hypot(piece.bx - piece.ax, piece.bz - piece.az);
    }
    edges.push({ classId: list[0]!.classId, x, z, y, a: node(x[0]!, z[0]!), b: node(x[x.length - 1]!, z[z.length - 1]!), length });
  }
  return { edges, nodes };
}

interface ShowPlan {
  readonly route: Route;
  readonly ford: Ford;
  readonly climbGrade: number;
  readonly climbLength: number;
}

function planShow(site: Site): ShowPlan | null {
  const world = site.world;
  const airport = world.airport!;
  const spawn = createSurfaceSpawn(world, "landcruiser");
  const head = airportRoadHead(world)!;
  const { edges, nodes } = roadGraph(site);
  const sealed = edges.find((e) => e.classId === ROAD_CLASS.airport && Math.hypot(e.x[0]! - head.startX, e.z[0]! - head.startZ) < 30);
  if (!sealed) return null;
  // Over the gravel from the sealed road's far end, edge by edge, turning at most
  // 100 degrees at a node (a sharper junction is a three-point turn, not a
  // drive), except onto the gravel: the default world's sealed road ends at the
  // end of its gravel road, which leaves at 143 degrees.
  interface Directed { readonly edge: RoadEdgeLine; readonly forward: boolean }
  const key = (d: Directed) => `${edges.indexOf(d.edge)}:${d.forward ? 1 : 0}`;
  const exitHeading = (d: Directed) => {
    const n = d.edge.x.length;
    const [i, j] = d.forward ? [Math.max(0, n - 3), n - 1] : [Math.min(n - 1, 2), 0];
    return Math.atan2(d.edge.x[j]! - d.edge.x[i]!, d.edge.z[j]! - d.edge.z[i]!);
  };
  const entryHeading = (d: Directed) => {
    const n = d.edge.x.length;
    const [i, j] = d.forward ? [0, Math.min(n - 1, 2)] : [n - 1, Math.max(0, n - 3)];
    return Math.atan2(d.edge.x[j]! - d.edge.x[i]!, d.edge.z[j]! - d.edge.z[i]!);
  };
  const endNode = (d: Directed) => (d.forward ? d.edge.b : d.edge.a);
  const startNode = (d: Directed) => (d.forward ? d.edge.a : d.edge.b);
  const first: Directed = { edge: sealed, forward: true };
  if (TRACE) {
    const node = endNode(first);
    console.log(`sealed road ends at ${nodes[node]!.x.toFixed(0)},${nodes[node]!.z.toFixed(0)} heading ${(exitHeading(first) / DEG).toFixed(0)}`);
    for (const edge of edges) {
      if (edge.a !== node && edge.b !== node) continue;
      const d: Directed = { edge, forward: edge.a === node };
      console.log(`  edge class ${edge.classId} ${edge.length.toFixed(0)} m leaves at ${(entryHeading(d) / DEG).toFixed(0)}: turn ${(wrap(entryHeading(d) - exitHeading(first)) / DEG).toFixed(0)}`);
    }
  }
  const dist = new Map<string, number>([[key(first), 0]]);
  const via = new Map<string, Directed>();
  const reached = new Map<string, Directed>([[key(first), first]]);
  const open = new Set([key(first)]);
  while (open.size > 0) {
    let u = "";
    for (const k of open) if (u === "" || dist.get(k)! < dist.get(u)!) u = k;
    open.delete(u);
    const from = reached.get(u)!;
    const node = endNode(from);
    for (const edge of edges) {
      if (edge.classId !== ROAD_CLASS.gravel || (edge.a !== node && edge.b !== node)) continue;
      const next: Directed = { edge, forward: edge.a === node };
      if (Math.abs(wrap(entryHeading(next) - exitHeading(from))) > (from === first ? 150 : 100) * DEG) continue;
      const d = dist.get(u)! + edge.length;
      const k = key(next);
      if (d < (dist.get(k) ?? Infinity) && d < 6000) {
        dist.set(k, d);
        via.set(k, from);
        reached.set(k, next);
        open.add(k);
      }
    }
  }
  // The steepest 200 m uphill on a gravel edge reached, the way it is driven.
  let climb: { edge: RoadEdgeLine; forward: boolean; from: number; to: number; grade: number } | null = null;
  for (const directed of reached.values()) {
    const { edge, forward } = directed;
    if (edge.classId !== ROAD_CLASS.gravel) continue;
    const xs = forward ? edge.x : [...edge.x].reverse();
    const zs = forward ? edge.z : [...edge.z].reverse();
    const ys = forward ? edge.y : [...edge.y].reverse();
    const station = [0];
    for (let i = 1; i < xs.length; i += 1) station.push(station[i - 1]! + Math.hypot(xs[i]! - xs[i - 1]!, zs[i]! - zs[i - 1]!));
    for (let i = 0; i < xs.length; i += 1) {
      let j = i;
      while (j < xs.length - 1 && station[j]! - station[i]! < 200) j += 1;
      if (station[j]! - station[i]! < 150 || station[station.length - 1]! - station[j]! < 150) continue;
      const grade = (ys[j]! - ys[i]!) / (station[j]! - station[i]!);
      if (!climb || grade > climb.grade) climb = { edge, forward, from: i, to: j, grade };
    }
  }
  if (!climb) return null;
  // The gravel path from the sealed road's end to the climb's edge.
  const path: Directed[] = [];
  let at: Directed | undefined = via.get(key({ edge: climb.edge, forward: climb.forward }));
  while (at && at.edge !== sealed) {
    path.unshift(at);
    at = via.get(key(at));
  }
  void startNode;
  void nodes;

  const route = routeBuilder();
  // Round from the apron start (facing the runway) through a U-turn onto the road head.
  const along = airport.runwayLength * -0.12 + 95;
  const across = airport.runwayWidth * 0.5 + 118;
  const frame = (dAlong: number, dAcross: number) => runwayToWorld(airport, along + dAlong, across + dAcross);
  const turn = [frame(0, -6), frame(3, -12), frame(9, -15), frame(15, -12), frame(18, -6), frame(18, 4), frame(10, 22), frame(0, 40)];
  route.x.push(spawn.position.x);
  route.z.push(spawn.position.z);
  route.cap.push(3);
  route.stretch.push(0);
  route.names.push("apron");
  route.ranges.push("2H");
  addStretch(route, "apron", "2H", 4, turn.map((p) => p.x), turn.map((p) => p.z));
  const sealedFrom = sealed.x.findIndex((_, i) => Math.hypot(sealed.x[i]! - head.startX, sealed.z[i]! - head.startZ) > 45);
  addStretch(route, "airport road", "2H", 60 * KMH, sealed.x.slice(sealedFrom), sealed.z.slice(sealedFrom));
  const gravelFrom = route.x.length;
  for (const step of path) {
    addStretch(route, "gravel", "4H", 50 * KMH, step.forward ? step.edge.x : [...step.edge.x].reverse(), step.forward ? step.edge.z : [...step.edge.z].reverse());
  }
  const cx = climb.forward ? climb.edge.x : [...climb.edge.x].reverse();
  const cz = climb.forward ? climb.edge.z : [...climb.edge.z].reverse();
  addStretch(route, "gravel", "4H", 50 * KMH, cx.slice(0, climb.from + 1), cz.slice(0, climb.from + 1));
  addStretch(route, "gravel climb", "4H", 50 * KMH, cx.slice(climb.from + 1, climb.to + 1), cz.slice(climb.from + 1, climb.to + 1));
  const climbEnd = route.x.length;
  addStretch(route, "gravel beyond", "4H", 50 * KMH, cx.slice(climb.to + 1), cz.slice(climb.to + 1));
  const ford = postFord(site, { x: route.x, z: route.z }, climbEnd + 50, Math.min(route.x.length - 60, climbEnd + 400), false);
  if (!ford) return null;
  // Cut the route 50 m past the ford, slowing to wade it.
  let fordIndex = climbEnd;
  for (let k = climbEnd; k < route.x.length; k += 1) {
    if (Math.hypot(route.x[k]! - ford.x, route.z[k]! - ford.z) < Math.hypot(route.x[fordIndex]! - ford.x, route.z[fordIndex]! - ford.z)) fordIndex = k;
  }
  const end = Math.min(route.x.length, fordIndex + 25);
  for (const list of [route.x, route.z, route.cap, route.stretch]) list.length = end;
  const stretch = (name: string) => {
    route.names.push(name);
    route.ranges.push("4H");
    return route.names.length - 1;
  };
  // The ford: down to it at 2 m/s, through it (10 m, five points) and out at 4.
  const toFord = stretch("to the ford");
  const inFord = stretch("ford");
  const outOfFord = stretch("out of the ford");
  const half = Math.ceil(FORD_WIDTH / 2 / SPACING);
  for (let k = fordIndex - 20; k < end; k += 1) {
    route.stretch[k] = k < fordIndex - half ? toFord : k <= fordIndex + half ? inFord : outOfFord;
    route.cap[k] = k <= fordIndex + half ? 2 : 4;
  }
  // The hairpin from the sealed road's end onto the gravel, and the junctions and
  // crossings after it (two roads' pieces within 10 m), at a walk.
  const hairpin = stretch("hairpin onto the gravel");
  const junctions = stretch("gravel junctions");
  for (let k = gravelFrom; k < Math.min(end, gravelFrom + 20); k += 1) {
    route.cap[k] = Math.min(route.cap[k]!, JUNCTION_SPEED);
    route.stretch[k] = hairpin;
  }
  for (let k = gravelFrom + 20; k < fordIndex - 20; k += 1) {
    if (roadsNear(site, route.x[k]!, route.z[k]!, 10) >= 2) {
      route.cap[k] = Math.min(route.cap[k]!, JUNCTION_SPEED);
      route.stretch[k] = junctions;
    }
  }
  const climbLength = Math.hypot(cx[climb.to]! - cx[climb.from]!, cz[climb.to]! - cz[climb.from]!);
  return { route: finishRoute(route), ford, climbGrade: climb.grade, climbLength };
}

const MATERIAL_NAMES = new Map<number, string>([
  ...Object.entries(SurfaceMaterial).map(([name, id]) => [id, name] as [number, string]),
  [-1, "water"],
]);

function legSurfaces(result: LegResult): Map<number, number> {
  const all = new Map<number, number>();
  for (const tally of result.stretches) for (const [m, v] of tally.surfaces) all.set(m, (all.get(m) ?? 0) + v);
  return all;
}

function surfaceMix(surfaces: ReadonlyMap<number, number>): string {
  const total = [...surfaces.values()].reduce((s, v) => s + v, 0);
  return [...surfaces]
    .sort((a, b) => b[1] - a[1])
    .filter(([, v]) => v / total >= 0.05)
    .map(([m, v]) => `${MATERIAL_NAMES.get(m) ?? m} ${Math.round((100 * v) / total)}%`)
    .join(", ");
}

function showDrive(): void {
  const site = buildSite(undefined, undefined);
  const plan = planShow(site);
  if (!plan) {
    console.log("\nshow: no sealed road, gravel climb or ford site round the default airport");
    return;
  }
  const r = plan.route;
  if (TRACE) {
    for (let k = 5; k < r.x.length - 5; k += 1) {
      const h0 = Math.atan2(r.x[k]! - r.x[k - 5]!, r.z[k]! - r.z[k - 5]!);
      const h1 = Math.atan2(r.x[k + 5]! - r.x[k]!, r.z[k + 5]! - r.z[k]!);
      const turn = Math.abs(wrap(h1 - h0)) / DEG;
      if (turn > 30) console.log(`route turn ${turn.toFixed(0)} deg at point ${k} (${(k * SPACING).toFixed(0)} m, ${r.names[r.stretch[k]!]}), planned ${r.speed[k]!.toFixed(1)} m/s`);
    }
    const from = Number(process.env.PROBE_PROFILE_FROM ?? -1);
    for (let k = Math.max(0, from); from >= 0 && k < Math.min(r.x.length, from + 30); k += 1) {
      const x = r.x[k]!;
      const z = r.z[k]!;
      const near = (site.roadBins.get(binKey(x, z)) ?? []).filter((piece) => {
        const dx = piece.bx - piece.ax;
        const dz = piece.bz - piece.az;
        const t = Math.max(0, Math.min(1, ((x - piece.ax) * dx + (z - piece.az) * dz) / (dx * dx + dz * dz || 1)));
        return Math.hypot(x - piece.ax - t * dx, z - piece.az - t * dz) < 8;
      }).map((piece) => `c${piece.classId} e${piece.edgeId % 1000} ${piece.ha.toFixed(2)}..${piece.hb.toFixed(2)}`);
      console.log(`profile ${k} (${k * SPACING} m) at ${x.toFixed(1)},${z.toFixed(1)}: ground ${site.height(x, z).toFixed(2)} | ${[...new Set(near)].join("; ")}`);
    }
  }
  const spawn = createSurfaceSpawn(site.world, "landcruiser");
  const sim = startCar(site, spawn.position.x, spawn.position.z, spawn.heading, [plan.ford.river]);
  settle(sim);
  const result = driveRoute(sim, r, 1200);
  console.log(
    `\nThe default world, from the apron start: the gravel climb is ${(plan.climbGrade * 100).toFixed(1)}% over ${plan.climbLength.toFixed(0)} m; `
    + `the ford is ${FORD_WIDTH} m wide, ${FORD_DEPTH} m deep, flowing ${FORD_FLOW} m/s`,
  );
  console.log(" stretch                      m      s  avg km/h  top km/h  climb m  pitch  roll  wade m  range  gears  tyres on");
  // In the order the route reaches them.
  const order = r.names.map((_, s) => s).sort((p, q) => r.stretch.indexOf(p) - r.stretch.indexOf(q));
  for (const s of order) {
    const t = result.stretches[s]!;
    if (t.seconds === 0) continue;
    console.log(
      ` ${r.names[s]!.padEnd(24)} ${f(t.distance, 0, 5)}  ${f(t.seconds, 0, 5)}  ${f((t.distance / t.seconds) * 3.6, 1, 8)}  ${f(t.topSpeed * 3.6, 1, 8)}  ${f(t.climb, 1, 7)}  ${f(t.pitch / DEG, 1, 5)}  ${f(t.roll / DEG, 1, 4)}  ${f(t.wading, 2, 6)}  ${[...t.ranges].join("/").padEnd(5)}  ${[...t.gears].sort().join("").padEnd(5)}  ${surfaceMix(t.surfaces)}`,
    );
  }
  console.log(
    ` ${outcome(result)}: ${(result.distance / 1000).toFixed(2)} km in ${result.seconds.toFixed(0)} s, ${result.stuck} stuck, `
    + `${result.offLine.toFixed(1)} m off the line at the end; step ${result.meanStep.toFixed(0)} us mean, ${result.slowStep.toFixed(0)} us at the 99.9th percentile, ${result.worstStep.toFixed(0)} us worst (after the first 2 s)`,
  );
  clearInfrastructureRegions(site.world);
}

// ---------------------------------------------------------------------------

const legs = (["open", "slope", "ford"] as const).filter(run);
if (legs.length > 0) {
  const rows: Record<"open" | "slope" | "ford", Row[]> = { open: [], slope: [], ford: [] };
  const seeds: (number | undefined)[] = [undefined];
  for (let s = 1; s < SEEDS; s += 1) seeds.push(s);
  for (const province of PROVINCES) {
    for (const seed of seeds.filter((s) => process.env.PROBE_SEED === undefined || String(s ?? "default") === process.env.PROBE_SEED)) {
      const site = buildSite(seed, province);
      const line = openLine(site);
      if (legs.includes("open")) {
        rows.open.push(legRow(site, line ? `${((line.x.length - 1) * 0.25).toFixed(2)} km, <${(Math.atan(line.maxGrade) / DEG).toFixed(0)} deg` : "", line ? openLeg(site, line) : null));
      }
      if (legs.includes("slope")) {
        const slope = findSlope(site);
        rows.slope.push(legRow(site, slope ? `${(Math.atan(slope.grade) / DEG).toFixed(1)} deg avg, ${(Math.atan(slope.steepest) / DEG).toFixed(0)} max` : "", slope ? slopeLeg(site, slope) : null));
      }
      if (legs.includes("ford")) {
        const ford = line ? fordLeg(site, line) : { ford: null, result: null };
        rows.ford.push(legRow(site, ford.ford ? `${FORD_DEPTH} m, ${FORD_FLOW} m/s` : "", ford.result));
      }
      clearInfrastructureRegions(site.world);
      process.stdout.write(".");
    }
  }
  if (legs.includes("open")) legTable("Open country: 2 km from the airport road head, 4H, up to 36 km/h", rows.open);
  if (legs.includes("slope")) legTable("The steepest fall-line climb within 4 km, 4L from rest, at 3 m/s", rows.slope);
  if (legs.includes("ford")) legTable(`A ford posted across the open line: ${FORD_WIDTH} m wide, ${FORD_DEPTH} m deep, ${FORD_FLOW} m/s, crossed at 2 m/s`, rows.ford);
}
if (run("show")) showDrive();
