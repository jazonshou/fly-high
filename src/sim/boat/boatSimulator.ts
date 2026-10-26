import {
  MAX_BOAT_SPRAY_ROOTS,
  type BoatControlState,
  type BoatGear,
  type BoatVisualState,
  type FlightMode,
} from "@/src/game/types";
import {
  hullToBody,
  RUNABOUT_21_CLEATS,
  RUNABOUT_21_OUTBOARD,
  transomX,
} from "@/src/vehicles/boat/hullLines";
import { createColliderContact, type ColliderAabb, type ColliderWorld } from "../colliders";
import {
  clamp,
  inverseRotateVectorInto,
  normalizeQuaternionInto,
  quaternionFromFlightAngles,
  rotateVectorInto,
} from "../math";
import { RigidBody, type RigidBodyOptions } from "../rigidBody";
import { FIXED_TIME_STEP, MAX_STEP_DURATION, STANDARD_GRAVITY } from "../simulation";
import {
  NEUTRAL_BOAT_CONTROLS,
  type SurfaceVehicleControls,
  type SurfaceVehicleEnvironment,
  type SurfaceVehicleSimulator,
  type SurfaceVehicleSnapshot,
  type SurfaceVehicleSpawn,
} from "../surface/types";
import type { Quaternion, TerrainSampler, Vec3 } from "../types";
import type { VehiclePoseState } from "../vehicle";
import { CalmWaterSurface } from "../water/calmWater";
import {
  createWaterSurfaceSample,
  type HullWaterSampler,
  type WaterSurfaceAuthority,
  type WaveFieldFocus,
} from "../water/types";
import { BoatAssists, createBoatActuatorTargets, type BoatAssistInput } from "./assists";
import { BOAT_CALIBRATION, RUNABOUT_21, type BoatCalibration, type BoatDefinition } from "./definition";
import {
  buildHullMesh,
  buildHullStrips,
  HULL_TAG_BOTTOM,
  HULL_TAG_CHINE,
  HULL_TAG_DECK,
  HULL_TAG_TOPSIDE,
  HULL_TAG_TRANSOM,
  HULL_TRANSOM_CHINE_BEAM,
  type HullMesh,
  type HullStrips,
} from "./hullMesh";
import { createHydrostaticResult, integrateHydrostatics, type HydrostaticResult } from "./hydrostatics";
import { createStripInputs, createStripOutputs, evaluateStrips, type StripInputs, type StripOutputs } from "./planing";
import { discImmersion, OutboardPowertrain } from "./propulsion";

/**
 * The boat's physics: a 6-DOF rigid body (`src/sim/rigidBody.ts`) under
 * hydrostatics on the clipped hull, 2D+t planing strips with their added
 * mass, ITTC-57 skin friction, the pre-planing hump, the outboard's
 * propeller, gearcase fin and trim, the trim tabs, windage, the sea bed and
 * the world's colliders. docs/BOAT_MODEL.md derives every term.
 *
 * Time: the worker calls `step(FIXED_TIME_STEP)` at 120 Hz. Each 120 Hz step
 * samples the water once at every hull point (height, slope, orbital velocity
 * and the surface's own rate of change) and then runs two 240 Hz substeps
 * that advance that sampled surface by its own derivatives, so the stiff
 * hull passes run at 240 Hz while the twin is asked once. Nothing in `step`
 * allocates.
 *
 * Water: any `WaterSurfaceAuthority`; a `HullWaterSampler` is told where the
 * hull is before each step. The clock is `state.time`, which is the
 * `simulationTime` the renderer's ocean is stepped with.
 */

/**
 * The worker's `SurfaceVehicleEnvironment`, every field optional so probes
 * and tests can leave out what they do not exercise (calm sea at 0, no wind,
 * no bed, standard gravity), plus what the marina and tests can add.
 */
export interface BoatEnvironment extends Partial<SurfaceVehicleEnvironment> {
  /** Optional richer bed sample: its normal and friction multiplier at a contact. */
  bedSample?: TerrainSampler;
  /** Docks, piles, pontoons. */
  colliders?: ColliderWorld | null;
  /**
   * The contact law by collider material id (`ColliderContact.material`), so
   * a fendered pontoon can give more than a timber pile. Ids not listed use
   * `DEFAULT_BOAT_CONTACT`.
   */
  contactMaterials?: ReadonlyMap<number, Readonly<BoatContactMaterial>> | null;
  airDensity?: number;
  waterDensity?: number;
}

/** How the hull meets one collider material, per contact probe. */
export interface BoatContactMaterial {
  /** Closing speed along the contact normal above which the hull is wrecked, m/s. */
  crashSpeed: number;
  /** Spring, N/m, and damper, N s/m, on the probe's penetration. */
  stiffness: number;
  damping: number;
  /** Coulomb friction along the face. */
  friction: number;
}

/** Bare GRP on a hard face: piles, walls, rocks. */
export const DEFAULT_BOAT_CONTACT: Readonly<BoatContactMaterial> = Object.freeze({
  crashSpeed: 2.5,
  stiffness: 4e5,
  damping: 1.2e4,
  friction: 0.3,
});

/**
 * The seam's spawn (`position.y` is the still water height there; the hull
 * settles to its own rest draft on it), plus a running start for probes.
 */
export interface BoatSpawn extends SurfaceVehicleSpawn {
  /** Forward speed through the water, m/s. Default 0. */
  speed?: number;
  gear?: BoatGear;
  rpm?: number;
  /** Starting engine trim, degrees. Default fully in. */
  trimDegrees?: number;
}

/** A captive-tow pose: CG height above still water, keel-line trim and heel (radians), speed ahead (m/s). */
export interface CaptivePose {
  cgHeight: number;
  trim: number;
  heel?: number;
  speed: number;
  /** Include the propeller's thrust and torque as the engine now stands. Default true. */
  thrust?: boolean;
  /** The hull alone, as a towing tank (or Savitsky's equations) sees it: no outboard, tabs or windage. */
  bareHull?: boolean;
}

export interface CaptiveLoads {
  /** Net load with weight, body frame (x ahead, y up), N, and moment about the CG, N m (z bow-up). */
  readonly force: Vec3;
  readonly moment: Vec3;
  hydrostaticLift: number;
  dynamicLift: number;
  wettedLength: number;
  displacedVolume: number;
  transomDry: number;
}

export function createCaptiveLoads(): CaptiveLoads {
  return {
    force: { x: 0, y: 0, z: 0 },
    moment: { x: 0, y: 0, z: 0 },
    hydrostaticLift: 0,
    dynamicLift: 0,
    wettedLength: 0,
    displacedVolume: 0,
    transomDry: 0,
  };
}

export interface BoatTelemetry {
  speedOverGround: number;
  /** Forward speed through the water at the CG, m/s (negative going astern). */
  speedThroughWater: number;
  verticalSpeed: number;
  /** Radians, atan2(forward.x, forward.z). */
  heading: number;
  pitch: number;
  /** Starboard down positive. */
  roll: number;
  /** Keel angle to the local water, bow up positive, radians. */
  runningTrim: number;
  /** Sideslip of the hull through the water, radians, positive sliding to starboard. */
  sideslip: number;
  rpm: number;
  throttle: number;
  gear: BoatGear;
  thrust: number;
  /** Vertical acceleration at the CG, g (1 at rest). */
  loadFactor: number;
  depthUnderKeel: number;
  /** Submerged volume, m^3, and the share of the weight carried by planing lift. */
  displacedVolume: number;
  dynamicLiftShare: number;
  ventilation: number;
  crashed: boolean;
  capsized: boolean;
}

/** What a mooring line (or any outside load) sees each substep. Reused: never keep a reference. */
export interface BoatLoadContext {
  readonly time: number;
  readonly dt: number;
  readonly position: Readonly<Vec3>;
  readonly orientation: Readonly<Quaternion>;
  readonly velocity: Readonly<Vec3>;
  /** Body frame. */
  readonly angularVelocity: Readonly<Vec3>;
  cleatWorld(index: number, out: Vec3): Vec3;
  cleatVelocity(index: number, out: Vec3): Vec3;
  pointVelocity(worldPoint: Readonly<Vec3>, out: Vec3): Vec3;
  addForceAtWorldPoint(force: Readonly<Vec3>, point: Readonly<Vec3>): void;
}

export interface BoatExternalLoad {
  apply(context: BoatLoadContext): void;
  /** Set by a load that wrecked the boat (a hard hit on a pile or wall); read after every step. */
  readonly crashed?: boolean;
}

export const WATER_DENSITY = 1_025;
const WATER_VISCOSITY = 1.19e-6;
const AIR_DENSITY = 1.225;
/** The still waterline length at rest, for the length Froude number. */
export const BOAT_WATERLINE_LENGTH = 5.8;
const DEG = Math.PI / 180;
/** Capsize: past this roll for this long the boat is a wreck. */
const CAPSIZE_ROLL = 110 * DEG;
const CAPSIZE_SECONDS = 4;
/** Hard impacts. */
/** Waterplane coefficient of the deep V at rest, for Holtrop & Mennen's transom Froude number. */
const TRANSOM_WATERPLANE_COEFFICIENT = 0.8;
const BED_CRASH_SPEED = 3;
const GROUNDING_CRASH_SPEED = 8;
const BED_STIFFNESS = 3e5;
const BED_DAMPING = 6e3;
const BED_FRICTION = 0.45;
const PROBE_RADIUS = 0.15;
/** A press of the mooring key makes fast only below this speed over the ground, m/s. */
const MAKE_FAST_SPEED = 0.6;
/**
 * The berth hold that stands in for lines when nothing else moors the boat
 * (no external load registered): a spring on the CG's horizontal position
 * and the heading where the boat was made fast, damped to just under critical.
 */
const BERTH_HOLD_STIFFNESS = 6_000;
const BERTH_HOLD_YAW_STIFFNESS = 6e4;
const KNOT = 0.514444;
const BODY_FORWARD: Readonly<Vec3> = Object.freeze({ x: 1, y: 0, z: 0 });
const BODY_UP: Readonly<Vec3> = Object.freeze({ x: 0, y: 1, z: 0 });
const BODY_STARBOARD: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 1 });

/** An angle folded into (-pi, pi]. (`wrapAngle` folds into [0, 2 pi).) */
function signedAngle(angle: number): number {
  return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
}

function isHullWaterSampler(water: WaterSurfaceAuthority | HullWaterSampler): water is HullWaterSampler {
  return typeof (water as Partial<HullWaterSampler>).setFocus === "function";
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}


/** Where the boat floats at rest on still water: CG height above the surface and keel trim. */
export interface RestWaterline {
  cgAboveWater: number;
  trim: number;
}

let restCache: RestWaterline | null = null;

/**
 * Solve the static equilibrium on still water once (heave and trim, by
 * Newton on the clipped-mesh hydrostatics): the pose a dock start places
 * the hull at so nothing jolts.
 */
export function solveRestWaterline(definition: BoatDefinition = RUNABOUT_21): RestWaterline {
  if (restCache && definition === RUNABOUT_21) return restCache;
  const mesh = buildHullMesh();
  const result = createHydrostaticResult(mesh);
  const world = new Float64Array(mesh.vertexCount * 3);
  const depth = new Float64Array(mesh.vertexCount);
  const weight = new Float64Array(mesh.triangleCount).fill(1);
  const centre = { x: 0, y: 0, z: 0 };
  const g = STANDARD_GRAVITY;
  const evaluate = (heave: number, trim: number): [number, number] => {
    const c = Math.cos(trim);
    const s = Math.sin(trim);
    centre.y = heave;
    for (let v = 0; v < mesh.vertexCount; v += 1) {
      const bx = mesh.vertices[v * 3]!;
      const by = mesh.vertices[v * 3 + 1]!;
      world[v * 3] = bx * c - by * s;
      world[v * 3 + 1] = heave + bx * s + by * c;
      world[v * 3 + 2] = mesh.vertices[v * 3 + 2]!;
      depth[v] = -world[v * 3 + 1]!;
    }
    integrateHydrostatics(mesh, world, depth, centre, weight, WATER_DENSITY * g, result);
    return [result.force.y - definition.mass * g, result.torque.z];
  };
  let heave = 0.15;
  let trim = 0;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const [f, m] = evaluate(heave, trim);
    const [fh, mh] = evaluate(heave + 1e-4, trim);
    const [ft, mt] = evaluate(heave, trim + 1e-5);
    const a = (fh - f) / 1e-4;
    const b = (ft - f) / 1e-5;
    const cc = (mh - m) / 1e-4;
    const d = (mt - m) / 1e-5;
    const det = a * d - b * cc;
    if (Math.abs(det) < 1e-12) break;
    const dh = (f * d - b * m) / det;
    const dt = (a * m - cc * f) / det;
    heave -= clamp(dh, -0.05, 0.05);
    trim -= clamp(dt, -0.02, 0.02);
    if (Math.abs(dh) < 1e-7 && Math.abs(dt) < 1e-8) break;
  }
  const solved = { cgAboveWater: heave, trim };
  if (definition === RUNABOUT_21) restCache = solved;
  return solved;
}

/** The CG position and orientation of a boat at rest on still water at `stillWaterY`. */
export function boatRestPose(
  stillWaterY: number,
  x: number,
  z: number,
  heading: number,
  out: { position: Vec3; orientation: Quaternion } = { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
): { position: Vec3; orientation: Quaternion } {
  const rest = solveRestWaterline();
  out.position.x = x;
  out.position.y = stillWaterY + rest.cgAboveWater;
  out.position.z = z;
  const q = quaternionFromFlightAngles(heading, rest.trim, 0);
  out.orientation.x = q.x;
  out.orientation.y = q.y;
  out.orientation.z = q.z;
  out.orientation.w = q.w;
  return out;
}

// Sample-point layout: mesh vertices, strip keel points, then the appendages.
const EXTRA_HUB = 0;
const EXTRA_GEARCASE = 1;
const EXTRA_TAB_PORT = 2;
const EXTRA_TAB_STARBOARD = 3;
const EXTRA_TRANSOM = 4;
const EXTRA_CG = 5;
const EXTRA_COUNT = 6;

/**
 * The shared rigid body, also keeping its own copy of the loads applied
 * since the last `resetRecord`, so a captive tow can read the net load the
 * body itself keeps private. A few additions per load; nothing allocates.
 */
export class LoadRecordingBody extends RigidBody {
  readonly record = {
    forceWorld: { x: 0, y: 0, z: 0 },
    torqueWorld: { x: 0, y: 0, z: 0 },
    torqueBody: { x: 0, y: 0, z: 0 },
  };

  constructor(options: RigidBodyOptions) {
    super(options);
  }

  resetRecord(): void {
    const r = this.record;
    r.forceWorld.x = r.forceWorld.y = r.forceWorld.z = 0;
    r.torqueWorld.x = r.torqueWorld.y = r.torqueWorld.z = 0;
    r.torqueBody.x = r.torqueBody.y = r.torqueBody.z = 0;
  }

  override addForce(forceWorld: Vec3): void {
    super.addForce(forceWorld);
    const f = this.record.forceWorld;
    f.x += forceWorld.x;
    f.y += forceWorld.y;
    f.z += forceWorld.z;
  }

  override addForceAtWorldPoint(forceWorld: Vec3, pointWorld: Vec3): void {
    super.addForceAtWorldPoint(forceWorld, pointWorld);
    const rx = pointWorld.x - this.position.x;
    const ry = pointWorld.y - this.position.y;
    const rz = pointWorld.z - this.position.z;
    const t = this.record.torqueWorld;
    t.x += ry * forceWorld.z - rz * forceWorld.y;
    t.y += rz * forceWorld.x - rx * forceWorld.z;
    t.z += rx * forceWorld.y - ry * forceWorld.x;
  }

  override addForceAtBodyPoint(forceBody: Vec3, pointBody: Vec3): void {
    super.addForceAtBodyPoint(forceBody, pointBody);
    const t = this.record.torqueBody;
    t.x += pointBody.y * forceBody.z - pointBody.z * forceBody.y;
    t.y += pointBody.z * forceBody.x - pointBody.x * forceBody.z;
    t.z += pointBody.x * forceBody.y - pointBody.y * forceBody.x;
  }

  override addTorque(torqueWorld: Vec3): void {
    super.addTorque(torqueWorld);
    const t = this.record.torqueWorld;
    t.x += torqueWorld.x;
    t.y += torqueWorld.y;
    t.z += torqueWorld.z;
  }

  override addTorqueBody(torqueBody: Vec3): void {
    super.addTorqueBody(torqueBody);
    const t = this.record.torqueBody;
    t.x += torqueBody.x;
    t.y += torqueBody.y;
    t.z += torqueBody.z;
  }
}

class LoadContext implements BoatLoadContext {
  time = 0;
  dt = 0;
  constructor(private readonly body: RigidBody, private readonly cleats: readonly Vec3[]) {}
  get position(): Readonly<Vec3> {
    return this.body.position;
  }
  get orientation(): Readonly<Quaternion> {
    return this.body.orientation;
  }
  get velocity(): Readonly<Vec3> {
    return this.body.velocity;
  }
  get angularVelocity(): Readonly<Vec3> {
    return this.body.angularVelocity;
  }
  cleatWorld(index: number, out: Vec3): Vec3 {
    return this.body.bodyToWorldPoint(this.cleats[index]!, out);
  }
  cleatVelocity(index: number, out: Vec3): Vec3 {
    this.body.bodyToWorldPoint(this.cleats[index]!, out);
    return this.body.pointVelocity(out, out);
  }
  pointVelocity(worldPoint: Readonly<Vec3>, out: Vec3): Vec3 {
    return this.body.pointVelocity(worldPoint as Vec3, out);
  }
  addForceAtWorldPoint(force: Readonly<Vec3>, point: Readonly<Vec3>): void {
    this.body.addForceAtWorldPoint(force as Vec3, point as Vec3);
  }
}

export class BoatSimulator implements SurfaceVehicleSimulator {
  readonly definition: BoatDefinition;
  readonly calibration: BoatCalibration;
  readonly state: VehiclePoseState;
  readonly body: LoadRecordingBody;
  readonly mesh: HullMesh;
  readonly strips: HullStrips;
  readonly powertrain: OutboardPowertrain;
  /** Mooring cleats, body frame: bow, port spring, starboard spring, port stern, starboard stern. */
  readonly cleatsBody: readonly Vec3[];
  /** The latest controls the worker set. */
  readonly controls: BoatControlState = { ...NEUTRAL_BOAT_CONTROLS };
  assistMode: FlightMode = "scenic";

  // Actuators.
  steerAngle = 0;
  trimAngle: number;
  tabPort = 0;
  tabStarboard = 0;
  /** The tabs' collective setting the rocker holds; Scenic's levelling rides on it. */
  private tabCollective = 0;
  moored = false;
  /**
   * Who owns `moored`: the boat (mooring presses, the lever casting off, the
   * berth hold), or an outside mooring (the marina's lines) that sets it with
   * `setMoored` and holds the boat itself.
   */
  mooringOwner: "boat" | "external" = "boat";
  capsized = false;

  private environment: BoatEnvironment = {};
  private readonly calm = new CalmWaterSurface(0, () => -1_000);
  private readonly assists: BoatAssists;
  private readonly targets = createBoatActuatorTargets();
  private readonly assistInput: BoatAssistInput = { speed: 0, sideslip: 0, runningTrim: 0, heel: 0, trimAngle: 0, ventilation: 0, dt: 0 };
  private readonly loads: BoatExternalLoad[] = [];
  private readonly loadContext: LoadContext;
  private capsizeTime = 0;
  /** The mooring count last seen; null until the first controls arrive (that count is the baseline). */
  private moorPresses: number | null = null;
  private readonly berth = { x: 0, z: 0, heading: 0 };
  private onGround = false;
  private readonly ratedPower: number;

  // Sample points.
  private readonly pointCount: number;
  private readonly extraBase: number;
  private readonly stripBase: number;
  private readonly pointBody: Float64Array;
  private readonly pointWorld: Float64Array;
  private readonly sampleX: Float64Array;
  private readonly sampleZ: Float64Array;
  private readonly eta: Float64Array;
  private readonly etaX: Float64Array;
  private readonly etaZ: Float64Array;
  private readonly etaT: Float64Array;
  private readonly waterU: Float64Array;
  private readonly waterSample = createWaterSurfaceSample();
  /** The sampler's focus, and its centre's offset forward of the CG: fitted to every sample point the hull can put out. */
  private readonly focus: WaveFieldFocus = { x: 0, z: 0, heading: 0, halfLength: 3.4, halfBeam: 1.4 };
  private focusAhead = 0.6;
  private quantumStart = 0;

  // Hull passes.
  private readonly vertexWorld: Float64Array;
  private readonly vertexDepth: Float64Array;
  private readonly pressureWeight: Float64Array;
  private readonly hydro: HydrostaticResult;
  private readonly stripIn: StripInputs;
  /** 1 / cos(deadrise) per strip: wetted half-beam to panel girth. */
  private readonly stripPanelSecant: Float64Array;
  private readonly stripOut: StripOutputs;

  // Telemetry kept from the last substep.
  private speedThroughWater = 0;
  private froude = 0;
  private transomDry = 0;
  /** Set only inside `captiveLoads` for a bare-hull tow. */
  private bareHull = false;
  private transomDepth = 0;
  private propellerImmersion = 1;
  private depthUnderKeel = 100;
  private loadFactor = 1;
  private sideslip = 0;
  private runningTrim = 0;
  private sprayRoots = new Float64Array(MAX_BOAT_SPRAY_ROOTS * 4);
  private sprayCount = 0;
  /** Peak vertical acceleration at the CG over the last 120 Hz step, g. */
  peakLoadFactor = 1;

  // Scratch.
  private readonly tmpA: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly tmpB: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly tmpC: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly tmpD: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly velocityBody: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly thrustAxis: Vec3 = { x: 1, y: 0, z: 0 };
  private readonly finNormal: Vec3 = { x: 0, y: 0, z: 1 };
  private readonly hubBody: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly gearcaseBody: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly skegBody: Vec3 = { x: 0, y: 0, z: 0 };
  private plateY = 0;
  private readonly probesBody: Float64Array;
  private readonly probeCount: number;
  private readonly contact = createColliderContact();
  private readonly candidates: number[] = [];
  private readonly aabb: ColliderAabb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

  constructor(
    spawn: BoatSpawn = { position: { x: 0, y: 0, z: 0 }, heading: 0, moored: false },
    definition: BoatDefinition = RUNABOUT_21,
    calibration: BoatCalibration = BOAT_CALIBRATION,
  ) {
    this.definition = definition;
    this.calibration = calibration;
    this.mesh = buildHullMesh();
    this.strips = buildHullStrips();
    this.powertrain = new OutboardPowertrain(definition, calibration);
    this.assists = new BoatAssists(definition);
    this.trimAngle = definition.trimMinDegrees * DEG;
    this.body = new LoadRecordingBody({ mass: definition.mass, inertia: definition.inertia });
    this.state = {
      time: 0,
      position: this.body.position,
      velocity: this.body.velocity,
      orientation: this.body.orientation,
      angularVelocity: this.body.angularVelocity,
      crashed: false,
    };
    this.cleatsBody = Object.freeze(RUNABOUT_21_CLEATS.map((cleat) => Object.freeze(hullToBody(cleat))));
    this.loadContext = new LoadContext(this.body, this.cleatsBody);
    this.ratedPower = Math.max(...definition.engine.fullThrottleTorque.map(([rpm, torque]) => (torque * rpm * Math.PI) / 30));

    this.stripBase = this.mesh.vertexCount;
    this.extraBase = this.stripBase + this.strips.count;
    this.pointCount = this.extraBase + EXTRA_COUNT;
    this.pointBody = new Float64Array(this.pointCount * 3);
    this.pointWorld = new Float64Array(this.pointCount * 3);
    this.sampleX = new Float64Array(this.pointCount);
    this.sampleZ = new Float64Array(this.pointCount);
    this.eta = new Float64Array(this.pointCount);
    this.etaX = new Float64Array(this.pointCount);
    this.etaZ = new Float64Array(this.pointCount);
    this.etaT = new Float64Array(this.pointCount);
    this.waterU = new Float64Array(this.pointCount * 3);
    this.pointBody.set(this.mesh.vertices, 0);
    for (let i = 0; i < this.strips.count; i += 1) {
      const p = (this.stripBase + i) * 3;
      this.pointBody[p] = this.strips.x[i]!;
      this.pointBody[p + 1] = this.strips.keelY[i]!;
      this.pointBody[p + 2] = 0;
    }
    this.vertexWorld = new Float64Array(this.mesh.vertexCount * 3);
    this.vertexDepth = new Float64Array(this.mesh.vertexCount);
    this.pressureWeight = new Float64Array(this.mesh.triangleCount);
    this.hydro = createHydrostaticResult(this.mesh);
    this.stripIn = createStripInputs(this.strips);
    this.stripPanelSecant = this.strips.tanDeadrise.map((t) => Math.sqrt(1 + t * t));
    this.stripOut = createStripOutputs(this.strips);

    // Collider probes: the sheer every other ring, the chines, the stem and transom corners.
    const probes: number[] = [];
    const v = this.mesh.vertices;
    for (let k = 0; k < this.mesh.sheerVertices.length; k += 4) {
      const index = this.mesh.sheerVertices[k]!;
      probes.push(v[index * 3]!, v[index * 3 + 1]!, v[index * 3 + 2]!);
      const other = this.mesh.sheerVertices[k + 1];
      if (other !== undefined) probes.push(v[other * 3]!, v[other * 3 + 1]!, v[other * 3 + 2]!);
    }
    for (let k = 0; k < this.mesh.bottomVertices.length; k += 1) {
      const index = this.mesh.bottomVertices[k]!;
      // Keel points of every third ring and the reverse-chine edges.
      if (k % 21 === 0 || k % 7 === 3 || k % 7 === 6) probes.push(v[index * 3]!, v[index * 3 + 1]!, v[index * 3 + 2]!);
    }
    this.probesBody = Float64Array.from(probes);
    this.probeCount = probes.length / 3;

    this.fitWaveFocus();
    this.reset(spawn);
  }

  /**
   * Size the wave sampler's focus to the box every sample point stays in,
   * the outboard swung through its whole trim range at either lock, so the
   * sampler's fast path answers all of them (a point outside it costs a full
   * spectral sum).
   */
  private fitWaveFocus(): void {
    let minX = Infinity;
    let maxX = -Infinity;
    let maxZ = 0;
    const cover = () => {
      for (let i = 0; i < this.pointCount; i += 1) {
        const x = this.pointBody[i * 3]!;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        maxZ = Math.max(maxZ, Math.abs(this.pointBody[i * 3 + 2]!));
      }
    };
    const definition = this.definition;
    for (const trim of [definition.trimMinDegrees, definition.trimMaxDegrees]) {
      for (const steer of [-definition.steerLockDegrees, definition.steerLockDegrees]) {
        this.trimAngle = trim * DEG;
        this.steerAngle = steer * DEG;
        this.updateEngineGeometry();
        this.placeSamplePoints();
        cover();
      }
    }
    this.trimAngle = definition.trimMinDegrees * DEG;
    this.steerAngle = 0;
    this.updateEngineGeometry();
    this.placeSamplePoints();
    this.focusAhead = 0.5 * (minX + maxX);
    this.focus.halfLength = 0.5 * (maxX - minX);
    this.focus.halfBeam = maxZ;
  }

  /** Put the boat back at a spawn: settled at rest on still water, or running at `speed` for probes. */
  reset(spawn: BoatSpawn): void {
    const pose = boatRestPose(spawn.position.y, spawn.position.x, spawn.position.z, spawn.heading);
    const body = this.body;
    body.position.x = pose.position.x;
    body.position.y = pose.position.y;
    body.position.z = pose.position.z;
    body.orientation.x = pose.orientation.x;
    body.orientation.y = pose.orientation.y;
    body.orientation.z = pose.orientation.z;
    body.orientation.w = pose.orientation.w;
    const speed = spawn.speed ?? 0;
    body.velocity.x = Math.sin(spawn.heading) * speed;
    body.velocity.y = 0;
    body.velocity.z = Math.cos(spawn.heading) * speed;
    body.angularVelocity.x = 0;
    body.angularVelocity.y = 0;
    body.angularVelocity.z = 0;
    body.clearForces();
    body.setAddedMass(null);
    this.state.time = 0;
    this.state.crashed = false;
    this.capsized = false;
    this.capsizeTime = 0;
    this.moored = false;
    if (spawn.moored) this.makeFast();
    this.moorPresses = null;
    this.onGround = false;
    this.steerAngle = 0;
    this.trimAngle = (spawn.trimDegrees ?? this.definition.trimMinDegrees) * DEG;
    this.tabPort = 0;
    this.tabStarboard = 0;
    this.tabCollective = 0;
    this.powertrain.reset(spawn.rpm ?? this.definition.engine.idleRpm, spawn.gear ?? "neutral");
    this.assists.reset();
    Object.assign(this.controls, NEUTRAL_BOAT_CONTROLS);
    this.peakLoadFactor = 1;
  }

  /** The worker's input: the assist mode and the boat's own control block. */
  setControls(controls: Readonly<SurfaceVehicleControls>): void {
    this.assistMode = controls.assist;
    const boat = controls.boat;
    this.controls.lever = Number.isFinite(boat.lever) ? clamp(boat.lever, -1, 1) : 0;
    this.controls.steer = Number.isFinite(boat.steer) ? clamp(boat.steer, -1, 1) : 0;
    this.controls.trim = Number.isFinite(boat.trim) ? clamp(boat.trim, -1, 1) : 0;
    this.controls.tabs = Number.isFinite(boat.tabs) ? clamp(boat.tabs, -1, 1) : 0;
    if (Number.isFinite(boat.moorPresses)) this.controls.moorPresses = boat.moorPresses;
  }

  setEnvironment(environment: Readonly<BoatEnvironment>): void {
    this.environment = environment;
  }

  /**
   * Make fast where the boat lies now, or cast off. A marina that moors the
   * boat with its own lines (an external load) sets `mooringOwner` to
   * "external" and calls this to match them.
   */
  setMoored(moored: boolean): void {
    if (moored && !this.moored) this.makeFast();
    else if (!moored) this.moored = false;
  }

  private makeFast(): void {
    this.moored = true;
    this.berth.x = this.body.position.x;
    this.berth.z = this.body.position.z;
    const forward = rotateVectorInto(this.tmpA, this.body.orientation, BODY_FORWARD);
    this.berth.heading = Math.atan2(forward.x, forward.z);
  }

  setMooringOwner(owner: "boat" | "external"): void {
    this.mooringOwner = owner;
  }

  addExternalLoad(load: BoatExternalLoad): void {
    if (!this.loads.includes(load)) this.loads.push(load);
  }

  removeExternalLoad(load: BoatExternalLoad): void {
    const index = this.loads.indexOf(load);
    if (index >= 0) this.loads.splice(index, 1);
  }

  /** Advance by `dt` seconds in 120 Hz quanta (the last one may be short). */
  step(dt: number = FIXED_TIME_STEP): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    let remaining = Math.min(dt, MAX_STEP_DURATION);
    while (remaining > 1e-10) {
      const quantum = Math.min(FIXED_TIME_STEP, remaining);
      this.stepQuantum(quantum);
      remaining -= quantum;
    }
  }

  private water(): WaterSurfaceAuthority {
    return this.environment.water ?? this.calm;
  }

  private stepQuantum(h: number): void {
    const water = this.water();
    const body = this.body;
    water.setTime(this.state.time);
    if (isHullWaterSampler(water)) {
      const forward = rotateVectorInto(this.tmpA, body.orientation, BODY_FORWARD);
      this.focus.x = body.position.x + forward.x * this.focusAhead;
      this.focus.z = body.position.z + forward.z * this.focusAhead;
      this.focus.heading = Math.atan2(forward.x, forward.z);
      water.setFocus(this.focus);
    }
    this.updateMooring();
    this.updateEngineGeometry();
    this.placeSamplePoints();
    this.sampleWater(water);
    this.quantumStart = this.state.time;
    this.peakLoadFactor = 0;
    this.onGround = false;
    const substep = h / 2;
    for (let k = 0; k < 2; k += 1) {
      this.substep(substep, this.state.time + k * substep);
    }
    this.state.time += h;
    this.checkCapsize(h);
    for (let i = 0; i < this.loads.length; i += 1) {
      if (this.loads[i]!.crashed) this.crash();
    }
  }

  /**
   * Mooring presses: the first count seen is the baseline and only a change
   * is a press. A press casts off, or makes fast if the boat is all but
   * stopped; the lever into gear casts off as well.
   */
  private updateMooring(): void {
    if (this.mooringOwner === "external") return;
    const presses = this.controls.moorPresses;
    if (this.moorPresses === null) {
      this.moorPresses = presses;
    } else if (presses !== this.moorPresses) {
      this.moorPresses = presses;
      if (this.moored) this.moored = false;
      else if (Math.hypot(this.body.velocity.x, this.body.velocity.z) < MAKE_FAST_SPEED) this.makeFast();
    }
    if (this.moored && OutboardPowertrain.leverGear(this.controls.lever) !== "neutral") this.moored = false;
  }

  /** The outboard's points after trim and steer, body frame. */
  private updateEngineGeometry(): void {
    const outboard = RUNABOUT_21_OUTBOARD;
    const theta = this.trimAngle;
    const delta = this.steerAngle;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    const pivot = hullToBody(outboard.tiltPivot, this.tmpA);
    const steerPoint = hullToBody(outboard.steerAxisPoint, this.tmpB);
    // Trim: rotate about body z by -theta (trimming out swings the leg aft and up).
    const trimRotate = (v: Vec3): void => {
      const x = v.x * ct + v.y * st;
      const y = -v.x * st + v.y * ct;
      v.x = x;
      v.y = y;
    };
    const axisX = st;
    const axisY = ct;
    const cd = Math.cos(delta);
    const sd = Math.sin(delta);
    // Steer: Rodrigues about the (trimmed) leg axis a = (st, ct, 0).
    const steerRotate = (v: Vec3): void => {
      const dot = axisX * v.x + axisY * v.y;
      const cx = axisY * v.z;
      const cy = -axisX * v.z;
      const cz = axisX * v.y - axisY * v.x;
      const x = v.x * cd + cx * sd + axisX * dot * (1 - cd);
      const y = v.y * cd + cy * sd + axisY * dot * (1 - cd);
      const z = v.z * cd + cz * sd;
      v.x = x;
      v.y = y;
      v.z = z;
    };
    // Steer axis point after trim.
    const s = this.tmpC;
    s.x = steerPoint.x - pivot.x;
    s.y = steerPoint.y - pivot.y;
    s.z = 0;
    trimRotate(s);
    const sx = pivot.x + s.x;
    const sy = pivot.y + s.y;
    const place = (hullPoint: Readonly<Vec3>, out: Vec3): void => {
      hullToBody(hullPoint, out);
      out.x -= steerPoint.x;
      out.y -= steerPoint.y;
      trimRotate(out);
      steerRotate(out);
      out.x += sx;
      out.y += sy;
    };
    place(outboard.propellerHub, this.hubBody);
    place(outboard.gearcaseCentroid, this.gearcaseBody);
    place(outboard.skegBottom, this.skegBody);
    const plate = this.tmpD;
    plate.x = 0.5 * (outboard.antiVentilationPlate.forwardX + outboard.antiVentilationPlate.aftX);
    plate.y = outboard.antiVentilationPlate.y;
    plate.z = 0;
    place(plate, plate);
    this.plateY = plate.y;
    const t = this.thrustAxis;
    t.x = ct;
    t.y = -st;
    t.z = 0;
    steerRotate(t);
    const n = this.finNormal;
    n.x = 0;
    n.y = 0;
    n.z = 1;
    steerRotate(n);
  }

  private placeSamplePoints(): void {
    const e = this.extraBase * 3;
    const pb = this.pointBody;
    pb[e + EXTRA_HUB * 3] = this.hubBody.x;
    pb[e + EXTRA_HUB * 3 + 1] = this.hubBody.y;
    pb[e + EXTRA_HUB * 3 + 2] = 0;
    pb[e + EXTRA_GEARCASE * 3] = this.gearcaseBody.x;
    pb[e + EXTRA_GEARCASE * 3 + 1] = this.gearcaseBody.y;
    pb[e + EXTRA_GEARCASE * 3 + 2] = this.gearcaseBody.z;
    const tabs = this.definition.tabs;
    const tab = this.tmpA;
    tab.x = -0.6 * tabs.chord;
    tab.y = tabs.centreHalfBeam * Math.tan(19 * DEG);
    tab.z = -tabs.centreHalfBeam;
    hullToBody(tab, tab);
    pb[e + EXTRA_TAB_PORT * 3] = tab.x;
    pb[e + EXTRA_TAB_PORT * 3 + 1] = tab.y;
    pb[e + EXTRA_TAB_PORT * 3 + 2] = tab.z;
    pb[e + EXTRA_TAB_STARBOARD * 3] = tab.x;
    pb[e + EXTRA_TAB_STARBOARD * 3 + 1] = tab.y;
    pb[e + EXTRA_TAB_STARBOARD * 3 + 2] = -tab.z;
    const transom = hullToBody({ x: transomX(0), y: 0, z: 0 }, this.tmpB);
    pb[e + EXTRA_TRANSOM * 3] = transom.x;
    pb[e + EXTRA_TRANSOM * 3 + 1] = transom.y;
    pb[e + EXTRA_TRANSOM * 3 + 2] = 0;
    pb[e + EXTRA_CG * 3] = 0;
    pb[e + EXTRA_CG * 3 + 1] = 0;
    pb[e + EXTRA_CG * 3 + 2] = 0;
    this.updateWorldPoints();
  }

  private updateWorldPoints(): void {
    const q = this.body.orientation;
    const p = this.body.position;
    const pb = this.pointBody;
    const pw = this.pointWorld;
    // Rotation matrix once.
    const { x: qx, y: qy, z: qz, w: qw } = q;
    const xx = qx * qx;
    const yy = qy * qy;
    const zz = qz * qz;
    const xy = qx * qy;
    const xz = qx * qz;
    const yz = qy * qz;
    const wx = qw * qx;
    const wy = qw * qy;
    const wz = qw * qz;
    const m00 = 1 - 2 * (yy + zz);
    const m01 = 2 * (xy - wz);
    const m02 = 2 * (xz + wy);
    const m10 = 2 * (xy + wz);
    const m11 = 1 - 2 * (xx + zz);
    const m12 = 2 * (yz - wx);
    const m20 = 2 * (xz - wy);
    const m21 = 2 * (yz + wx);
    const m22 = 1 - 2 * (xx + yy);
    for (let i = 0; i < this.pointCount; i += 1) {
      const bx = pb[i * 3]!;
      const by = pb[i * 3 + 1]!;
      const bz = pb[i * 3 + 2]!;
      pw[i * 3] = p.x + m00 * bx + m01 * by + m02 * bz;
      pw[i * 3 + 1] = p.y + m10 * bx + m11 * by + m12 * bz;
      pw[i * 3 + 2] = p.z + m20 * bx + m21 * by + m22 * bz;
    }
  }

  private sampleWater(water: WaterSurfaceAuthority): void {
    const sample = this.waterSample;
    const pw = this.pointWorld;
    for (let i = 0; i < this.pointCount; i += 1) {
      const x = pw[i * 3]!;
      const z = pw[i * 3 + 2]!;
      water.sample(x, z, sample);
      this.sampleX[i] = x;
      this.sampleZ[i] = z;
      if (sample.kind === "none") {
        this.eta[i] = -1e6;
        this.etaX[i] = 0;
        this.etaZ[i] = 0;
        this.etaT[i] = 0;
        this.waterU[i * 3] = 0;
        this.waterU[i * 3 + 1] = 0;
        this.waterU[i * 3 + 2] = 0;
        continue;
      }
      const ny = Math.max(1e-3, sample.normal.y);
      const sx = -sample.normal.x / ny;
      const sz = -sample.normal.z / ny;
      this.eta[i] = sample.height;
      this.etaX[i] = sx;
      this.etaZ[i] = sz;
      const u = sample.velocity;
      // Kinematic surface condition: eta_t = w - u . grad(eta).
      this.etaT[i] = u.y - u.x * sx - u.z * sz;
      this.waterU[i * 3] = u.x;
      this.waterU[i * 3 + 1] = u.y;
      this.waterU[i * 3 + 2] = u.z;
    }
  }

  /** The sampled surface's height at a point's current world position, at time `time`. */
  private surfaceAt(index: number, time: number): number {
    const e = this.eta[index]!;
    if (e < -1e5) return e;
    const pw = this.pointWorld;
    return (
      e +
      this.etaX[index]! * (pw[index * 3]! - this.sampleX[index]!) +
      this.etaZ[index]! * (pw[index * 3 + 2]! - this.sampleZ[index]!) +
      this.etaT[index]! * (time - this.quantumStart)
    );
  }

  private substep(dt: number, time: number): void {
    const body = this.body;
    const g = this.environment.gravity ?? STANDARD_GRAVITY;
    this.accumulateLoads(dt, time, true);
    body.setAddedMass(this.stripOut.addedMass, { coriolis: false });
    body.step(dt);
    if (!Number.isFinite(body.position.x + body.position.y + body.position.z + body.velocity.x + body.velocity.y + body.velocity.z)) {
      this.recoverFromNonFinite();
    }
    const loadFactor = (body.linearAcceleration.y + g) / g;
    this.loadFactor = loadFactor;
    if (Math.abs(loadFactor) > Math.abs(this.peakLoadFactor)) this.peakLoadFactor = loadFactor;
  }

  /**
   * Every load on the hull at its present state, into the body's
   * accumulators. `actuate` advances the helm, trim, tabs and engine by `dt`
   * first; a captive tow leaves them where they are.
   */
  private accumulateLoads(dt: number, time: number, actuate: boolean): void {
    const body = this.body;
    const g = this.environment.gravity ?? STANDARD_GRAVITY;
    const rho = this.environment.waterDensity ?? WATER_DENSITY;
    const q = body.orientation;
    this.updateWorldPoints();
    const crashed = this.state.crashed;

    // Relative water velocity at the CG and the hull's speed through the water.
    const cgIndex = this.extraBase + EXTRA_CG;
    const vRel = this.tmpA;
    vRel.x = body.velocity.x - this.waterU[cgIndex * 3]!;
    vRel.y = body.velocity.y - this.waterU[cgIndex * 3 + 1]!;
    vRel.z = body.velocity.z - this.waterU[cgIndex * 3 + 2]!;
    inverseRotateVectorInto(this.velocityBody, q, vRel);
    const speed = this.velocityBody.x;
    this.speedThroughWater = speed;
    this.froude = Math.abs(speed) / Math.sqrt(g * BOAT_WATERLINE_LENGTH);
    const horizontal = Math.hypot(this.velocityBody.x, this.velocityBody.z);
    this.sideslip = horizontal > 0.5 ? Math.atan2(this.velocityBody.z, Math.abs(this.velocityBody.x)) : 0;

    // Transom immersion and whether it runs dry.
    const transomIndex = this.extraBase + EXTRA_TRANSOM;
    const transomSurface = this.surfaceAt(transomIndex, time);
    const transomY = this.pointWorld[transomIndex * 3 + 1]!;
    this.transomDepth = transomSurface - transomY;
    const transomFroude = Math.abs(speed) / Math.sqrt(g * Math.max(0.05, this.transomDepth));
    this.transomDry = this.transomDepth <= 0 ? 1 : speed > 0 ? smoothstep(2, 3.5, transomFroude) : 0;
    const dry = this.transomDry;

    // Actuators and engine (before loads, so this substep's thrust acts now).
    if (actuate) this.updateActuators(dt, crashed);

    // --- Hydrostatics on the clipped mesh.
    const mesh = this.mesh;
    for (let v = 0; v < mesh.vertexCount; v += 1) {
      this.vertexWorld[v * 3] = this.pointWorld[v * 3]!;
      this.vertexWorld[v * 3 + 1] = this.pointWorld[v * 3 + 1]!;
      this.vertexWorld[v * 3 + 2] = this.pointWorld[v * 3 + 2]!;
      this.vertexDepth[v] = this.surfaceAt(v, time) - this.pointWorld[v * 3 + 1]!;
    }
    const releaseLength = Math.max(1e-3, this.calibration.transomReleaseBeams * HULL_TRANSOM_CHINE_BEAM);
    for (let t = 0; t < mesh.triangleCount; t += 1) {
      const tag = mesh.tags[t]!;
      if (tag === HULL_TAG_TRANSOM) this.pressureWeight[t] = 1 - dry;
      else if (tag === HULL_TAG_BOTTOM || tag === HULL_TAG_CHINE)
        this.pressureWeight[t] = 1 - dry * (1 - Math.tanh(mesh.triangleTransomDistance[t]! / releaseLength));
      else this.pressureWeight[t] = 1;
    }
    integrateHydrostatics(mesh, this.vertexWorld, this.vertexDepth, body.position, this.pressureWeight, rho * g, this.hydro);
    body.addForce(this.hydro.force);
    body.addTorque(this.hydro.torque);

    // --- Planing strips.
    const strips = this.strips;
    const omega = body.angularVelocity;
    const si = this.stripIn;
    for (let i = 0; i < strips.count; i += 1) {
      const index = this.stripBase + i;
      const surface = this.surfaceAt(index, time);
      const ex = this.etaX[index]!;
      const ez = this.etaZ[index]!;
      const inv = 1 / Math.sqrt(1 + ex * ex + ez * ez);
      const n = this.tmpB;
      n.x = -ex * inv;
      n.y = inv;
      n.z = -ez * inv;
      inverseRotateVectorInto(n, q, n);
      si.normal[i * 3] = n.x;
      si.normal[i * 3 + 1] = n.y;
      si.normal[i * 3 + 2] = n.z;
      const vertical = surface - this.pointWorld[index * 3 + 1]!;
      si.depth[i] = surface < -1e5 ? 0 : vertical * inv;
      // Keel point velocity relative to the water, body frame.
      const bx = this.pointBody[index * 3]!;
      const by = this.pointBody[index * 3 + 1]!;
      const u = this.tmpC;
      u.x = this.waterU[index * 3]!;
      u.y = this.waterU[index * 3 + 1]!;
      u.z = this.waterU[index * 3 + 2]!;
      inverseRotateVectorInto(u, q, u);
      const vb = this.tmpD;
      inverseRotateVectorInto(vb, q, body.velocity);
      si.relativeVelocity[i * 3] = vb.x + omega.y * 0 - omega.z * by - u.x;
      si.relativeVelocity[i * 3 + 1] = vb.y + omega.z * bx - omega.x * 0 - u.y;
      si.relativeVelocity[i * 3 + 2] = vb.z + omega.x * by - omega.y * bx - u.z;
    }
    si.omegaX = omega.x;
    si.omegaY = omega.y;
    si.omegaZ = omega.z;
    si.speed = speed;
    si.transomDry = dry;
    si.froude = this.froude;
    evaluateStrips(strips, si, this.calibration, rho, HULL_TRANSOM_CHINE_BEAM, this.stripOut);
    const so = this.stripOut;
    rotateVectorInto(this.tmpB, q, so.force);
    body.addForce(this.tmpB);
    body.addTorqueBody(so.moment);
    this.sprayCount = so.sprayCount;
    this.sprayRoots.set(so.spray);

    // --- Skin friction over the wetted pieces (ITTC-57 plus roughness).
    this.applyFriction(rho, speed);

    // --- Pre-planing hump (wave-making the strips leave out) and the wet transom's eddy.
    this.applyHump(rho, g);

    if (!this.bareHull) {
      // --- Outboard: propeller, gearcase fin and drag, walk, torque reaction.
      this.applyOutboard(rho, time);

      // --- Trim tabs (Savitsky and Brown).
      this.applyTabs(rho, speed);

      // --- Windage.
      this.applyWindage();
    }

    // --- Sea bed and colliders.
    this.applyBed(g);
    this.applyColliders();

    // --- Outside loads (mooring lines, marina contacts), or the berth hold.
    if (this.loads.length > 0) {
      this.loadContext.time = time;
      this.loadContext.dt = dt;
      for (let i = 0; i < this.loads.length; i += 1) this.loads[i]!.apply(this.loadContext);
    } else if (this.moored && this.mooringOwner === "boat") {
      this.applyBerthHold();
    }

    // --- Gravity, and a little radiation damping at rest.
    this.tmpB.x = 0;
    this.tmpB.y = -body.mass * g;
    this.tmpB.z = 0;
    body.addForce(this.tmpB);
    this.applyRadiationDamping(g, rho);
  }

  /**
   * A captive tow, as in a towing tank: the hull held at `pose` on the
   * present water (heading along world +Z, no rotation), moving ahead at
   * `pose.speed`, with the helm, trim, tabs and engine as they stand. Fills
   * `out` with the net load including weight, body frame, about the CG, and
   * leaves the boat at that pose with no loads pending. `thrust: false`
   * takes the propeller out (a bare-hull tow). For the steady-planing
   * oracle and the calibration probe; not used in the step.
   */
  captiveLoads(pose: Readonly<CaptivePose>, out: CaptiveLoads): CaptiveLoads {
    const body = this.body;
    body.position.x = 0;
    body.position.y = pose.cgHeight;
    body.position.z = 0;
    const q = quaternionFromFlightAngles(0, pose.trim, pose.heel ?? 0);
    body.orientation.x = q.x;
    body.orientation.y = q.y;
    body.orientation.z = q.z;
    body.orientation.w = q.w;
    body.velocity.x = 0;
    body.velocity.y = 0;
    body.velocity.z = pose.speed;
    body.angularVelocity.x = 0;
    body.angularVelocity.y = 0;
    body.angularVelocity.z = 0;
    const water = this.water();
    water.setTime(this.state.time);
    this.updateEngineGeometry();
    this.placeSamplePoints();
    this.sampleWater(water);
    this.quantumStart = this.state.time;
    body.clearForces();
    this.body.resetRecord();
    const thrust = this.powertrain.thrust;
    const torque = this.powertrain.propellerTorque;
    if (pose.thrust === false) {
      this.powertrain.thrust = 0;
      this.powertrain.propellerTorque = 0;
    }
    this.bareHull = pose.bareHull === true;
    this.accumulateLoads(0, this.state.time, false);
    this.bareHull = false;
    this.powertrain.thrust = thrust;
    this.powertrain.propellerTorque = torque;
    const record = this.body.record;
    inverseRotateVectorInto(out.force, body.orientation, record.forceWorld);
    inverseRotateVectorInto(out.moment, body.orientation, record.torqueWorld);
    out.moment.x += record.torqueBody.x;
    out.moment.y += record.torqueBody.y;
    out.moment.z += record.torqueBody.z;
    out.hydrostaticLift = this.hydro.force.y;
    out.dynamicLift = this.stripOut.dynamicLift;
    out.wettedLength = this.stripOut.wettedLength;
    out.displacedVolume = this.hydro.volume;
    out.transomDry = this.transomDry;
    body.clearForces();
    return out;
  }

  private updateActuators(dt: number, crashed: boolean): void {
    const definition = this.definition;
    const up = rotateVectorInto(this.tmpB, this.body.orientation, BODY_UP);
    const right = rotateVectorInto(this.tmpC, this.body.orientation, BODY_STARBOARD);
    const heel = Math.atan2(-right.y, up.y);
    const forward = rotateVectorInto(this.tmpD, this.body.orientation, BODY_FORWARD);
    // Running trim: the keel's pitch against the local water (the strips' average normal is close enough at the CG).
    const transomIndex = this.extraBase + EXTRA_TRANSOM;
    const ex = this.etaX[transomIndex]!;
    const ez = this.etaZ[transomIndex]!;
    const waterPitch = Math.atan(ex * forward.x + ez * forward.z);
    this.runningTrim = Math.asin(clamp(forward.y, -1, 1)) - waterPitch;
    const input = this.assistInput;
    input.speed = this.speedThroughWater;
    input.sideslip = this.sideslip;
    input.runningTrim = this.runningTrim;
    input.heel = heel;
    input.trimAngle = this.trimAngle;
    input.ventilation = this.powertrain.ventilation;
    input.dt = dt;
    const targets = this.assists.apply(this.assistMode, this.controls, input, this.targets);
    // Steering.
    const steerStep = targets.steerRate * dt;
    this.steerAngle += clamp(targets.steerAngle - this.steerAngle, -steerStep, steerStep);
    // Trim.
    const trimMin = definition.trimMinDegrees * DEG;
    const trimMax = definition.trimMaxDegrees * DEG;
    const trimStep = definition.trimRateDegrees * DEG * dt;
    if (targets.trimAuto) this.trimAngle += clamp(targets.trimTarget - this.trimAngle, -trimStep, trimStep);
    else this.trimAngle += targets.trimRate * trimStep;
    this.trimAngle = clamp(this.trimAngle, trimMin, trimMax);
    // Tabs.
    const tabStep = definition.tabs.rate * dt;
    if (targets.tabsAuto) {
      // The rocker moves the collective; the assist's differential rides on it.
      this.tabCollective = clamp(this.tabCollective + targets.tabRate * tabStep, 0, 1);
      const half = 0.5 * targets.tabDifferential;
      const portTarget = clamp(this.tabCollective - half, 0, 1);
      const starboardTarget = clamp(this.tabCollective + half, 0, 1);
      this.tabPort += clamp(portTarget - this.tabPort, -tabStep, tabStep);
      this.tabStarboard += clamp(starboardTarget - this.tabStarboard, -tabStep, tabStep);
    } else {
      this.tabPort = clamp(this.tabPort + targets.tabRate * tabStep, 0, 1);
      this.tabStarboard = clamp(this.tabStarboard + targets.tabRate * tabStep, 0, 1);
      this.tabCollective = 0.5 * (this.tabPort + this.tabStarboard);
    }
    // Engine: inflow along the shaft at the hub, immersion against the local surface.
    const hubIndex = this.extraBase + EXTRA_HUB;
    const inflow = this.pointRelativeVelocityBody(hubIndex, this.tmpA);
    const axial = inflow.x * this.thrustAxis.x + inflow.y * this.thrustAxis.y + inflow.z * this.thrustAxis.z;
    const surface = this.localPropellerSurface(hubIndex);
    const hubDepth = surface - this.pointWorld[hubIndex * 3 + 1]!;
    this.propellerImmersion = discImmersion(hubDepth, 0.5 * definition.propeller.diameter);
    this.powertrain.update(
      dt,
      targets.lever,
      axial,
      this.propellerImmersion,
      this.environment.waterDensity ?? WATER_DENSITY,
      !crashed,
      hubDepth,
      this.environment.gravity ?? STANDARD_GRAVITY,
    );
  }

  /** Behind a dry transom the propeller runs in the transom's hollow, which sits at the transom's keel. */
  private localPropellerSurface(index: number): number {
    const surface = this.surfaceAt(index, this.state.time);
    const transomIndex = this.extraBase + EXTRA_TRANSOM;
    const hollow = this.pointWorld[transomIndex * 3 + 1]! + 0.02;
    return surface - this.transomDry * Math.max(0, surface - hollow);
  }

  /** Velocity of a sample point relative to the water, body frame. */
  private pointRelativeVelocityBody(index: number, out: Vec3): Vec3 {
    const body = this.body;
    const bx = this.pointBody[index * 3]!;
    const by = this.pointBody[index * 3 + 1]!;
    const bz = this.pointBody[index * 3 + 2]!;
    const u = this.tmpD;
    u.x = body.velocity.x - this.waterU[index * 3]!;
    u.y = body.velocity.y - this.waterU[index * 3 + 1]!;
    u.z = body.velocity.z - this.waterU[index * 3 + 2]!;
    inverseRotateVectorInto(out, body.orientation, u);
    const w = body.angularVelocity;
    out.x += w.y * bz - w.z * by;
    out.y += w.z * bx - w.x * bz;
    out.z += w.x * by - w.y * bx;
    return out;
  }

  private applyFriction(rho: number, speed: number): void {
    const pieces = this.hydro.pieces;
    if (pieces.count === 0) return;
    const body = this.body;
    const wettedLength = Math.max(0.5, this.stripOut.wettedLength);
    const flow = Math.max(0.05, Math.abs(speed));
    const reynolds = Math.max(1e5, (flow * wettedLength) / WATER_VISCOSITY);
    const logRe = Math.log10(reynolds) - 2;
    const cf = 0.075 / (logRe * logRe) + this.calibration.roughnessAllowance;
    // The clipped mesh's bottom is the still-water footprint. Once the hull
    // runs, the wetted bottom is the strips' instead: wider by the Wagner
    // pile-up where the spray root runs free, cut at the strakes and chines
    // where it trips, and short of the dry transom's hollow. Friction keeps the
    // mesh's distribution and takes the strips' total.
    let meshBottom = 0;
    for (let k = 0; k < pieces.count; k += 1) {
      const tag = pieces.tag[k]!;
      if (tag !== HULL_TAG_BOTTOM && tag !== HULL_TAG_CHINE) continue;
      meshBottom += Math.hypot(pieces.areaVector[k * 3]!, pieces.areaVector[k * 3 + 1]!, pieces.areaVector[k * 3 + 2]!);
    }
    let stripBottom = 0;
    const strips = this.strips;
    const halfBeams = this.stripOut.wettedHalfBeam;
    for (let i = 0; i < strips.count; i += 1) {
      stripBottom += (halfBeams[i * 2]! + halfBeams[i * 2 + 1]!) * this.stripPanelSecant[i]! * strips.length;
    }
    const running = smoothstep(0.35, 0.9, this.froude);
    const ratio = meshBottom > 1e-3 ? clamp(stripBottom / meshBottom, 0.3, Math.PI / 2) : 1;
    const splash = 1 + (ratio - 1) * running;
    const cgIndex = this.extraBase + EXTRA_CG;
    const ux = this.waterU[cgIndex * 3]!;
    const uy = this.waterU[cgIndex * 3 + 1]!;
    const uz = this.waterU[cgIndex * 3 + 2]!;
    const w = this.tmpB;
    rotateVectorInto(w, body.orientation, body.angularVelocity);
    const force = this.tmpC;
    const point = this.tmpD;
    for (let k = 0; k < pieces.count; k += 1) {
      const tag = pieces.tag[k]!;
      if (tag === HULL_TAG_DECK || tag === HULL_TAG_TRANSOM) continue;
      const rx = pieces.centroid[k * 3]!;
      const ry = pieces.centroid[k * 3 + 1]!;
      const rz = pieces.centroid[k * 3 + 2]!;
      const ax = pieces.areaVector[k * 3]!;
      const ay = pieces.areaVector[k * 3 + 1]!;
      const az = pieces.areaVector[k * 3 + 2]!;
      const area = Math.hypot(ax, ay, az);
      if (area < 1e-9) continue;
      const nx = ax / area;
      const ny = ay / area;
      const nz = az / area;
      const vx = body.velocity.x + (w.y * rz - w.z * ry) - ux;
      const vy = body.velocity.y + (w.z * rx - w.x * rz) - uy;
      const vz = body.velocity.z + (w.x * ry - w.y * rx) - uz;
      const vn = vx * nx + vy * ny + vz * nz;
      const tx = vx - vn * nx;
      const ty = vy - vn * ny;
      const tz = vz - vn * nz;
      const vt = Math.hypot(tx, ty, tz);
      if (vt < 1e-6) continue;
      const scale = -0.5 * rho * cf * vt * area * (tag === HULL_TAG_TOPSIDE ? 1 : splash);
      force.x = scale * tx;
      force.y = scale * ty;
      force.z = scale * tz;
      point.x = body.position.x + rx;
      point.y = body.position.y + ry;
      point.z = body.position.z + rz;
      body.addForceAtWorldPoint(force, point);
    }
  }

  /**
   * The displacement and pre-planing resistance the strips and the clipped
   * mesh leave out: the calibrated hump (wave-making), and Holtrop & Mennen's
   * immersed-transom term while the transom is wet,
   *
   *   R_TR = 1/2 rho V^2 A_T 0.2 (1 - 0.2 F_nT),  F_nT = V / sqrt(2 g A_T / (B (1 + C_WP))),
   *
   * handing over, as the transom runs dry, to the dry transom's lost
   * hydrostatic push (its face's pressures are switched off).
   */
  private applyHump(rho: number, g: number): void {
    const c = this.calibration;
    const fn = this.froude;
    if (fn < 0.05) return;
    const ratio = fn / c.humpFroude;
    const shape = Math.exp(c.humpSharpness * (Math.log(ratio) + 1 - ratio));
    const weight = rho * g * this.hydro.volume;
    const vb = this.velocityBody;
    const horizontal = Math.hypot(vb.x, vb.z);
    if (horizontal < 1e-3) return;
    let drag = c.humpDrag * shape * weight;
    const wet = 1 - this.transomDry;
    if (wet > 0) {
      const pieces = this.hydro.pieces;
      let area = 0;
      for (let k = 0; k < pieces.count; k += 1) {
        if (pieces.tag[k] !== HULL_TAG_TRANSOM) continue;
        area += Math.hypot(pieces.areaVector[k * 3]!, pieces.areaVector[k * 3 + 1]!, pieces.areaVector[k * 3 + 2]!);
      }
      if (area > 1e-4 && vb.x > 0) {
        const fnt = vb.x / Math.sqrt((2 * g * area) / (HULL_TRANSOM_CHINE_BEAM * (1 + TRANSOM_WATERPLANE_COEFFICIENT)));
        if (fnt < 5) drag += 0.5 * rho * vb.x * vb.x * area * 0.2 * (1 - 0.2 * fnt) * wet;
      } else if (area > 1e-4) {
        // Going astern the transom is a flat face pushed into the water.
        drag += 0.5 * rho * vb.x * vb.x * area * c.transomAsternDrag;
      }
    }
    if (drag < 1e-3) return;
    const force = this.tmpB;
    force.x = (-drag * vb.x) / horizontal;
    force.y = 0;
    force.z = (-drag * vb.z) / horizontal;
    rotateVectorInto(force, this.body.orientation, force);
    force.y = 0;
    this.body.addForce(force);
    const moment = this.tmpC;
    moment.x = 0;
    moment.y = 0;
    moment.z = Math.sign(vb.x) * c.humpMoment * shape * weight * BOAT_WATERLINE_LENGTH;
    this.body.addTorqueBody(moment);
  }

  private applyOutboard(rho: number, time: number): void {
    const body = this.body;
    const pt = this.powertrain;
    const definition = this.definition;
    const axis = this.thrustAxis;
    // Thrust along the shaft at the hub, less the thrust deduction.
    const thrust = pt.thrust * (1 - this.calibration.thrustDeduction);
    const force = this.tmpB;
    force.x = axis.x * thrust;
    force.y = axis.y * thrust;
    force.z = axis.z * thrust;
    // Propeller walk: a right-hand propeller pulls the stern to starboard ahead, to port astern.
    const speed = Math.abs(this.speedThroughWater);
    const walk = this.calibration.propellerWalk * pt.thrust / (1 + (speed / 3) * (speed / 3));
    force.z += walk;
    body.addForceAtBodyPoint(force, this.hubBody);
    // The engine's torque reaction rolls the hull against the propeller's rotation.
    const sign = pt.gear === "reverse" ? -1 : pt.gear === "forward" ? 1 : 0;
    const reaction = this.tmpC;
    reaction.x = -sign * pt.propellerTorque * axis.x;
    reaction.y = -sign * pt.propellerTorque * axis.y;
    reaction.z = -sign * pt.propellerTorque * axis.z;
    body.addTorqueBody(reaction);

    // Gearcase and skeg: a low-aspect fin along the shaft, and its drag.
    const gearcaseIndex = this.extraBase + EXTRA_GEARCASE;
    const hubIndex = this.extraBase + EXTRA_HUB;
    const surface = this.localPropellerSurface(hubIndex);
    void time;
    // How much of the leg (plate down to skeg) is under the local surface.
    const plateWorldY = this.worldYOfBody(this.plateY);
    const skegWorldY = this.worldYOfBody(this.skegBody.y);
    const legSpan = Math.max(0.05, plateWorldY - skegWorldY);
    const legImmersion = clamp((surface - skegWorldY) / legSpan, 0, 1);
    if (legImmersion <= 0) return;
    const rel = this.pointRelativeVelocityBody(gearcaseIndex, this.tmpA);
    // Water velocity relative to the fin is -rel.
    const wx = -rel.x;
    const wy = -rel.y;
    const wz = -rel.z;
    const w2 = wx * wx + wy * wy + wz * wz;
    if (w2 < 1e-6) return;
    const n = this.finNormal;
    const normalComponent = wx * n.x + wy * n.y + wz * n.z;
    const chordComponent = -(wx * axis.x + wy * axis.y + wz * axis.z);
    const alpha = Math.atan2(normalComponent, Math.max(1e-6, Math.abs(chordComponent)));
    const sa = Math.sin(alpha);
    const ca = Math.cos(alpha);
    const normalCoefficient = definition.gearcase.liftSlope * sa * ca * ca + 1.1 * sa * Math.abs(sa);
    const q = 0.5 * rho * w2;
    const lift = q * definition.gearcase.finArea * legImmersion * normalCoefficient;
    const speedRel = Math.sqrt(w2);
    const drag = q * definition.gearcase.dragArea * legImmersion;
    force.x = n.x * lift + (wx / speedRel) * drag;
    force.y = n.y * lift + (wy / speedRel) * drag;
    force.z = n.z * lift + (wz / speedRel) * drag;
    body.addForceAtBodyPoint(force, this.gearcaseBody);
  }

  private worldYOfBody(bodyY: number): number {
    // World height of a point on the body's centreline at the transom with body height `bodyY`.
    const q = this.body.orientation;
    const transomIndex = this.extraBase + EXTRA_TRANSOM;
    const up = rotateVectorInto(this.tmpC, q, BODY_UP);
    return this.pointWorld[transomIndex * 3 + 1]! + (bodyY - this.pointBody[transomIndex * 3 + 1]!) * up.y;
  }

  private applyTabs(rho: number, speed: number): void {
    if (speed <= 0.2) return;
    const tabs = this.definition.tabs;
    const so = this.stripOut;
    const q = 0.5 * rho * speed * speed;
    const force = this.tmpB;
    const point = this.tmpC;
    for (let side = 0; side < 2; side += 1) {
      const deflection = (side === 0 ? this.tabPort : this.tabStarboard) * tabs.maxDegrees;
      if (deflection <= 0) continue;
      const wetted = so.wettedHalfBeam[side]!;
      const inner = tabs.centreHalfBeam - 0.5 * tabs.span;
      const wet = clamp((wetted - inner) / tabs.span, 0, 1);
      // Even off the plane the tab sits in the water behind a wet transom.
      const immersion = Math.max(wet, this.transomDepth > 0.05 ? 1 - this.transomDry : 0);
      if (immersion <= 0) continue;
      // Savitsky and Brown (1976): lift = 0.046 chord span delta(deg) q.
      const lift = 0.046 * tabs.chord * tabs.span * deflection * q * immersion;
      const delta = deflection * DEG;
      force.x = -Math.sin(delta) * lift;
      force.y = Math.cos(delta) * lift;
      force.z = 0;
      const index = this.extraBase + (side === 0 ? EXTRA_TAB_PORT : EXTRA_TAB_STARBOARD);
      point.x = this.pointBody[index * 3]!;
      point.y = this.pointBody[index * 3 + 1]!;
      point.z = this.pointBody[index * 3 + 2]!;
      this.body.addForceAtBodyPoint(force, point);
    }
  }

  private applyWindage(): void {
    const body = this.body;
    const wind = this.environment.wind;
    const air = this.tmpA;
    air.x = (wind?.x ?? 0) - body.velocity.x;
    air.y = (wind?.y ?? 0) - body.velocity.y;
    air.z = (wind?.z ?? 0) - body.velocity.z;
    inverseRotateVectorInto(air, body.orientation, air);
    const speed = Math.hypot(air.x, air.y, air.z);
    if (speed < 1e-3) return;
    const windage = this.definition.windage;
    const half = 0.5 * (this.environment.airDensity ?? AIR_DENSITY) * speed;
    const force = this.tmpB;
    force.x = half * windage.dragAreaX * air.x;
    force.y = half * windage.dragAreaY * air.y;
    force.z = half * windage.dragAreaZ * air.z;
    body.addForceAtBodyPoint(force, hullToBody(windage.centre, this.tmpC));
  }

  private applyBed(g: number): void {
    const bedHeight = this.environment.bedHeight;
    const body = this.body;
    const transomIndex = this.extraBase + EXTRA_TRANSOM;
    if (!bedHeight) {
      this.depthUnderKeel = 100;
      return;
    }
    const tx = this.pointWorld[transomIndex * 3]!;
    const tz = this.pointWorld[transomIndex * 3 + 2]!;
    this.depthUnderKeel = this.pointWorld[transomIndex * 3 + 1]! - bedHeight(tx, tz);
    // Cheap reject: the whole hull is well clear of the bed under its middle.
    const cx = body.position.x;
    const cz = body.position.z;
    if (body.position.y - bedHeight(cx, cz) > 6 && this.depthUnderKeel > 3) return;
    const mesh = this.mesh;
    const pw = this.pointWorld;
    const point = this.tmpB;
    const force = this.tmpC;
    const velocity = this.tmpD;
    let load = 0;
    for (let k = 0; k < mesh.bottomVertices.length + 1; k += 1) {
      let x: number;
      let y: number;
      let z: number;
      if (k < mesh.bottomVertices.length) {
        const index = mesh.bottomVertices[k]!;
        x = pw[index * 3]!;
        y = pw[index * 3 + 1]!;
        z = pw[index * 3 + 2]!;
      } else {
        body.bodyToWorldPoint(this.skegBody, point);
        x = point.x;
        y = point.y;
        z = point.z;
      }
      const bed = bedHeight(x, z);
      const penetration = bed - y;
      if (!(penetration > 0)) continue;
      this.onGround = true;
      // Bed normal from the height field (or the richer sample).
      let nx: number;
      let ny: number;
      let nz: number;
      let friction = BED_FRICTION;
      const sample = this.environment.bedSample?.(x, z);
      if (sample?.normal) {
        nx = sample.normal.x;
        ny = sample.normal.y;
        nz = sample.normal.z;
        friction *= sample.friction ?? 1;
      } else {
        const dx = bedHeight(x + 0.5, z) - bedHeight(x - 0.5, z);
        const dz = bedHeight(x, z + 0.5) - bedHeight(x, z - 0.5);
        const inv = 1 / Math.hypot(dx, 1, dz);
        nx = -dx * inv;
        ny = inv;
        nz = -dz * inv;
      }
      point.x = x;
      point.y = y;
      point.z = z;
      body.pointVelocity(point, velocity);
      const vn = velocity.x * nx + velocity.y * ny + velocity.z * nz;
      if (vn < -BED_CRASH_SPEED && penetration < 0.08) this.crash();
      const normalForce = Math.max(0, BED_STIFFNESS * penetration - BED_DAMPING * vn);
      load += normalForce;
      const tx = velocity.x - vn * nx;
      const ty = velocity.y - vn * ny;
      const tz = velocity.z - vn * nz;
      const vt = Math.hypot(tx, ty, tz);
      const slip = vt > 1e-4 ? (friction * normalForce * Math.min(1, vt / 0.3)) / vt : 0;
      force.x = nx * normalForce - slip * tx;
      force.y = ny * normalForce - slip * ty;
      force.z = nz * normalForce - slip * tz;
      body.addForceAtWorldPoint(force, point);
    }
    const groundSpeed = Math.hypot(body.velocity.x, body.velocity.z);
    if (load > 0.5 * body.mass * g && groundSpeed > GROUNDING_CRASH_SPEED) this.crash();
  }

  private applyColliders(): void {
    const colliders = this.environment.colliders;
    if (!colliders || colliders.size === 0) return;
    const body = this.body;
    const reach = 4.2;
    const box = this.aabb;
    box.minX = body.position.x - reach;
    box.maxX = body.position.x + reach;
    box.minY = body.position.y - reach;
    box.maxY = body.position.y + reach;
    box.minZ = body.position.z - reach;
    box.maxZ = body.position.z + reach;
    const count = colliders.query(box, this.candidates);
    if (count === 0) return;
    const materials = this.environment.contactMaterials;
    const centre = this.tmpB;
    const velocity = this.tmpC;
    const force = this.tmpD;
    const contact = this.contact;
    for (let p = 0; p < this.probeCount; p += 1) {
      centre.x = this.probesBody[p * 3]!;
      centre.y = this.probesBody[p * 3 + 1]!;
      centre.z = this.probesBody[p * 3 + 2]!;
      body.bodyToWorldPoint(centre, centre);
      for (let c = 0; c < count; c += 1) {
        if (!colliders.contactSphere(this.candidates[c]!, centre, PROBE_RADIUS, contact)) continue;
        body.pointVelocity(contact.point, velocity);
        velocity.x -= contact.pointVelocity.x;
        velocity.y -= contact.pointVelocity.y;
        velocity.z -= contact.pointVelocity.z;
        const n = contact.normal;
        const vn = velocity.x * n.x + velocity.y * n.y + velocity.z * n.z;
        const law = materials?.get(contact.material) ?? DEFAULT_BOAT_CONTACT;
        if (vn < -law.crashSpeed && contact.penetration < 0.1) this.crash();
        const normalForce = Math.max(0, law.stiffness * contact.penetration - law.damping * vn);
        const tx = velocity.x - vn * n.x;
        const ty = velocity.y - vn * n.y;
        const tz = velocity.z - vn * n.z;
        const vt = Math.hypot(tx, ty, tz);
        const slip = vt > 1e-4 ? (law.friction * normalForce * Math.min(1, vt / 0.2)) / vt : 0;
        force.x = n.x * normalForce - slip * tx;
        force.y = n.y * normalForce - slip * ty;
        force.z = n.z * normalForce - slip * tz;
        body.addForceAtWorldPoint(force, contact.point);
      }
    }
  }

  private applyBerthHold(): void {
    const body = this.body;
    const mass = this.definition.mass;
    const damping = 1.8 * Math.sqrt(BERTH_HOLD_STIFFNESS * mass * 1.3);
    const force = this.tmpB;
    force.x = -BERTH_HOLD_STIFFNESS * (body.position.x - this.berth.x) - damping * body.velocity.x;
    force.y = 0;
    force.z = -BERTH_HOLD_STIFFNESS * (body.position.z - this.berth.z) - damping * body.velocity.z;
    body.addForce(force);
    const forward = rotateVectorInto(this.tmpC, body.orientation, BODY_FORWARD);
    const error = signedAngle(Math.atan2(forward.x, forward.z) - this.berth.heading);
    // A positive rotation about world +y turns the bow from +Z toward +X: the heading's own sense.
    const yawRate = rotateVectorInto(this.tmpD, body.orientation, body.angularVelocity).y;
    const yawDamping = 1.8 * Math.sqrt(BERTH_HOLD_YAW_STIFFNESS * this.definition.inertia.yy * 1.3);
    force.x = 0;
    force.y = -BERTH_HOLD_YAW_STIFFNESS * error - yawDamping * yawRate;
    force.z = 0;
    body.addTorque(force);
  }

  /**
   * At rest the strips' momentum terms vanish, and the radiated waves that
   * damp a real hull's heave, pitch and roll are not in a strip model; a small
   * linear damping, a fraction of critical from the hydrostatic stiffness,
   * stands in for them and fades out as the hull starts to plane.
   */
  private applyRadiationDamping(g: number, rho: number): void {
    const zeta = this.calibration.radiationDamping * (1 - smoothstep(0.3, 0.8, this.froude));
    if (zeta <= 0 || this.hydro.volume <= 0) return;
    const body = this.body;
    const share = Math.min(1, this.hydro.volume / (this.definition.mass / rho));
    const mass = this.definition.mass;
    // Hydrostatic stiffness of the rest waterplane, scaled by how much of it is wet.
    const heaveStiffness = 9.3e4 * share * (rho * g) / (WATER_DENSITY * STANDARD_GRAVITY);
    const heaveDamping = 2 * zeta * Math.sqrt(heaveStiffness * mass * 3);
    const inertia = this.definition.inertia;
    const pitchDamping = 2 * zeta * Math.sqrt(2.4e5 * share * inertia.zz * 3);
    const rollDamping = 2 * zeta * Math.sqrt(1.5e4 * share * inertia.xx * 2);
    const force = this.tmpB;
    force.x = 0;
    force.y = -heaveDamping * body.velocity.y;
    force.z = 0;
    body.addForce(force);
    const moment = this.tmpC;
    moment.x = -rollDamping * body.angularVelocity.x;
    moment.y = 0;
    moment.z = -pitchDamping * body.angularVelocity.z;
    body.addTorqueBody(moment);
  }

  private crash(): void {
    this.state.crashed = true;
  }

  private checkCapsize(h: number): void {
    const up = rotateVectorInto(this.tmpA, this.body.orientation, BODY_UP);
    const tilt = Math.acos(clamp(up.y, -1, 1));
    if (tilt > CAPSIZE_ROLL) {
      this.capsized = true;
      this.capsizeTime += h;
      if (this.capsizeTime >= CAPSIZE_SECONDS) this.state.crashed = true;
    } else {
      this.capsized = false;
      this.capsizeTime = 0;
    }
  }

  private recoverFromNonFinite(): void {
    const body = this.body;
    body.velocity.x = 0;
    body.velocity.y = 0;
    body.velocity.z = 0;
    body.angularVelocity.x = 0;
    body.angularVelocity.y = 0;
    body.angularVelocity.z = 0;
    if (!Number.isFinite(body.position.x + body.position.y + body.position.z)) {
      body.position.x = 0;
      body.position.y = 0;
      body.position.z = 0;
    }
    normalizeQuaternionInto(body.orientation, body.orientation);
    this.state.crashed = true;
  }

  telemetry(out?: BoatTelemetry): BoatTelemetry {
    const body = this.body;
    const q = body.orientation;
    const forward = rotateVectorInto({ x: 0, y: 0, z: 0 }, q, BODY_FORWARD);
    const up = rotateVectorInto({ x: 0, y: 0, z: 0 }, q, BODY_UP);
    const right = rotateVectorInto({ x: 0, y: 0, z: 0 }, q, BODY_STARBOARD);
    const pt = this.powertrain;
    const result = out ?? ({} as BoatTelemetry);
    result.speedOverGround = Math.hypot(body.velocity.x, body.velocity.z);
    result.speedThroughWater = this.speedThroughWater;
    result.verticalSpeed = body.velocity.y;
    result.heading = Math.atan2(forward.x, forward.z);
    result.pitch = Math.asin(clamp(forward.y, -1, 1));
    result.roll = Math.atan2(-right.y, up.y);
    result.runningTrim = this.runningTrim;
    result.sideslip = this.sideslip;
    result.rpm = pt.rpm;
    result.throttle = pt.throttle;
    result.gear = pt.gear;
    result.thrust = pt.thrust;
    result.loadFactor = this.loadFactor;
    result.depthUnderKeel = this.depthUnderKeel;
    result.displacedVolume = this.hydro.volume;
    result.dynamicLiftShare = clamp(this.stripOut.dynamicLift / (this.definition.mass * STANDARD_GRAVITY), 0, 1);
    result.ventilation = pt.ventilation;
    result.crashed = this.state.crashed;
    result.capsized = this.capsized;
    return result;
  }

  visualState(): BoatVisualState {
    const definition = this.definition;
    const trimMin = definition.trimMinDegrees * DEG;
    const trimMax = definition.trimMaxDegrees * DEG;
    const roots = new Array<number>(MAX_BOAT_SPRAY_ROOTS * 4).fill(0);
    for (let i = 0; i < this.sprayCount * 4; i += 1) roots[i] = this.sprayRoots[i]!;
    return {
      kind: "boat",
      speedThroughWater: this.speedThroughWater,
      gear: this.powertrain.gear,
      lever: this.controls.lever,
      steerAngle: this.steerAngle,
      trim: (this.trimAngle - trimMin) / (trimMax - trimMin),
      trimAngle: this.trimAngle,
      tabPort: this.tabPort,
      tabStarboard: this.tabStarboard,
      depthUnderKeel: this.depthUnderKeel,
      propellerImmersion: this.propellerImmersion,
      moored: this.moored,
      ventilating: this.powertrain.ventilation > 0.5,
      capsized: this.capsized,
      planing: clamp(this.stripOut.dynamicLift / (definition.mass * STANDARD_GRAVITY), 0, 1),
      wettedLength: this.stripOut.wettedLength,
      transomImmersion: this.transomDepth,
      sprayRoots: roots,
      sprayRootCount: this.sprayCount,
    };
  }

  /** The seam's snapshot: pose, engine, and the boat payload the HUD and renderer read. */
  snapshot(): SurfaceVehicleSnapshot {
    const body = this.body;
    const pt = this.powertrain;
    return {
      time: this.state.time,
      position: { ...body.position },
      velocity: { ...body.velocity },
      orientation: { ...body.orientation },
      angularVelocity: { ...body.angularVelocity },
      throttle: clamp((pt.engineTorque * pt.crankSpeed) / this.ratedPower, 0, 1),
      engineRpm: pt.rpm,
      onGround: this.onGround,
      crashed: this.state.crashed,
      payload: this.visualState(),
    };
  }

  /** Knots, for probes and tests. */
  static knots(metresPerSecond: number): number {
    return metresPerSecond / KNOT;
  }
}
