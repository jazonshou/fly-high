/**
 * The LandCruiser 76's grip, surface by surface, on flat test ground:
 * `npx tsx scripts/car-traction-probe.mts [section...] [--surfaces=a,b] [--json=path]`,
 * sections from
 *
 * - accel: from rest, full throttle with the wheel held straight, in 2H and
 *   4H: seconds to 10 m/s (36 km/h) and how hard the driven tyres slip.
 * - corner: the ramp-steer test (ISO 4138's constant speed, rising steer) at
 *   10 m/s in 4H: the wheel wound from straight to the lock the speed allows
 *   over 8 s while a PI holds the speed. The most lateral acceleration the
 *   car holds (until its body slides past 20 degrees), the body's sideslip
 *   and the front and rear tyres' slip angles there, the lateral
 *   acceleration at 5 degrees of sideslip, and the turn's radius against
 *   the wheels' kinematic one at a quarter of the lock (1 is neutral).
 * - keys: what a player's keys do: W and D held from straight running at
 *   12 m/s for 3 s, in 2H and 4H, the wheel wound as the input profile winds
 *   it. The radius at the end, the peak sideslip, and whether the car spun
 *   (sideslip past 30 degrees, or going backwards).
 * - brake: 12 m/s to a stop on Space in 4H, metres.
 * - climb: the steepest plane the car climbs 20 m up from rest at 60%
 *   pedal, in 4H and 4L (2.5 degree steps).
 *
 * Every surface is every tyre's, from `describeSurface` as the worker gives
 * it, roughness and all; the ground under it is an exact plane. The numbers
 * go to stdout as tables and, with `--json`, to a file for a before/after.
 */
import { writeFileSync } from "node:fs";
import type { CarControlState } from "../src/game/types";
import { SurfaceMaterial } from "../src/render/webgpu/terrain/surfaceMaterials";
import { GroundVehicleSimulator } from "../src/sim/ground";
import { describeSnow, describeSurface, type CarSurface } from "../src/sim/ground/surface";
import type { GroundField } from "../src/sim/ground/terrainPatch";
import { NEUTRAL_BOAT_CONTROLS, NEUTRAL_CAR_CONTROLS } from "../src/sim/surface";
import { LANDCRUISER_76 } from "../src/vehicles/landcruiser76";

const STEP = 1 / 120;
const G = 9.80665;
const DEG = 180 / Math.PI;
const WHEELBASE = LANDCRUISER_76.geometry.wheelbase;
/** The front axle ahead of the body origin (the kerb CG), m. */
const FRONT_AXLE_X = LANDCRUISER_76.geometry.frontAxleX;

type SurfaceFill = (out: CarSurface) => void;

/** The surfaces probed: the roads, then the ground off them. */
const SURFACES: ReadonlyArray<readonly [string, SurfaceFill]> = [
  ["asphalt", (out) => describeSurface(SurfaceMaterial.Asphalt, 0, out)],
  ["gravel", (out) => describeSurface(SurfaceMaterial.Gravel, 0, out)],
  ["track", (out) => {
    describeSurface(SurfaceMaterial.Gravel, 0, out);
    out.friction = 0.7;
    out.rollingResistance = 0.025;
    out.roughness = 0.012;
  }],
  ["rock", (out) => describeSurface(SurfaceMaterial.Rock, 0, out)],
  ["grass", (out) => describeSurface(SurfaceMaterial.Grass, 0, out)],
  ["dry grass", (out) => describeSurface(SurfaceMaterial.DryGrass, 0, out)],
  ["forest floor", (out) => describeSurface(SurfaceMaterial.ForestFloor, 0, out)],
  ["shrub", (out) => describeSurface(SurfaceMaterial.Shrub, 0, out)],
  ["damp grass", (out) => describeSurface(SurfaceMaterial.Grass, 0.75, out)],
  ["mud", (out) => describeSurface(SurfaceMaterial.Grass, 1, out)],
  ["sand", (out) => describeSurface(SurfaceMaterial.Sand, 0, out)],
  ["tephra", (out) => describeSurface(SurfaceMaterial.Tephra, 0, out)],
  ["deep snow", (out) => describeSnow(0.2, out)],
  ["packed snow", (out) => describeSnow(0.03, out)],
];

function plane(degrees: number): GroundField {
  const grade = Math.tan(degrees / DEG);
  return {
    evaluate(out) {
      out.height = grade * out.z;
      out.dhdx = 0;
      out.dhdz = grade;
    },
  };
}

const FLAT = plane(0);

function carOn(ground: GroundField, fill: SurfaceFill): GroundVehicleSimulator {
  return new GroundVehicleSimulator(
    { position: { x: 0, y: 0, z: 0 }, heading: 0, moored: false },
    { ground, surface: (_at, out) => { fill(out); } },
  );
}

function controls(sim: GroundVehicleSimulator, input: Partial<CarControlState>): void {
  sim.setControls({ assist: "pilot", boat: NEUTRAL_BOAT_CONTROLS, car: { ...NEUTRAL_CAR_CONTROLS, ...input } });
}

function hold(sim: GroundVehicleSimulator, seconds: number, input: Partial<CarControlState>): void {
  controls(sim, input);
  for (let i = Math.round(seconds / STEP); i > 0; i -= 1) sim.step(STEP);
}

/**
 * Parked on the handbrake, then `rangePresses` presses of T (0 2H, 1 4H,
 * 2 4L). The sim's press counter takes its first reading as the baseline, so
 * the presses come a step after a reading of none.
 */
function select(sim: GroundVehicleSimulator, rangePresses: number, seconds = 1): void {
  hold(sim, 0.1, { handbrake: 1 });
  hold(sim, seconds, { handbrake: 1, rangePresses });
}

/** The car's motion in its own frame: forward and rightward speed, yaw rate (positive turning right), m/s and rad/s. */
interface BodyMotion {
  forward: number;
  right: number;
  yawRate: number;
  heading: number;
}

function bodyMotion(sim: GroundVehicleSimulator, out: BodyMotion): BodyMotion {
  const q = sim.state.orientation;
  const v = sim.state.velocity;
  const w = sim.state.angularVelocity;
  // Body axes in the world: +X forward, +Y up, +Z right.
  const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
  const fy = 2 * (q.x * q.y + q.w * q.z);
  const fz = 2 * (q.x * q.z - q.w * q.y);
  const ux = 2 * (q.x * q.y - q.w * q.z);
  const uy = 1 - 2 * (q.x * q.x + q.z * q.z);
  const uz = 2 * (q.y * q.z + q.w * q.x);
  const rx = 2 * (q.x * q.z + q.w * q.y);
  const ry = 2 * (q.y * q.z - q.w * q.x);
  const rz = 1 - 2 * (q.x * q.x + q.y * q.y);
  out.forward = v.x * fx + v.y * fy + v.z * fz;
  out.right = v.x * rx + v.y * ry + v.z * rz;
  // A right turn is a negative rotation about up.
  out.yawRate = -(w.x * ux + w.y * uy + w.z * uz);
  out.heading = Math.atan2(fx, fz);
  return out;
}

const motion: BodyMotion = { forward: 0, right: 0, yawRate: 0, heading: 0 };

/** Speed PI on the accelerator (and the brake above the target), as a driver holds a speed. */
class SpeedHold {
  private integral = 0;
  constructor(private readonly target: number) {}
  pedals(speed: number): { accelerator: number; brake: number } {
    const error = this.target - speed;
    this.integral = Math.max(-1, Math.min(1, this.integral + 0.4 * error * STEP));
    const command = 0.25 * error + this.integral;
    return { accelerator: Math.max(0, Math.min(1, command)), brake: Math.max(0, Math.min(1, -command - 0.1)) };
  }
}

/** Bring a car to `speed` in a straight line on flat ground in `range` presses (0 2H, 1 4H, 2 4L). */
function launch(fill: SurfaceFill, speed: number, rangePresses: number): GroundVehicleSimulator {
  const sim = carOn(FLAT, fill);
  select(sim, rangePresses);
  const pi = new SpeedHold(speed);
  for (let t = 0; t < 30; t += STEP) {
    bodyMotion(sim, motion);
    controls(sim, { rangePresses, ...pi.pedals(motion.forward), steer: Math.max(-1, Math.min(1, 4 * motion.heading)) });
    sim.step(STEP);
    if (t > 4 && Math.abs(motion.forward - speed) < 0.05) break;
  }
  return sim;
}

/** Slip angles of the front and rear tyres, degrees: the angle between the tyre's heading and its contact's travel. */
function slipAngles(sim: GroundVehicleSimulator): { front: number; rear: number } {
  const steer = sim.steering;
  const lat = (forward: number, right: number, x: number, wheelAngle: number): number => {
    const yaw = motion.yawRate;
    // A point x ahead of the CG moves right at yawRate * x.
    const travel = Math.atan2(right + yaw * x, forward);
    return (travel - wheelAngle) * DEG;
  };
  const front = lat(motion.forward, motion.right, FRONT_AXLE_X, 0.5 * (steer.left + steer.right));
  const rear = lat(motion.forward, motion.right, FRONT_AXLE_X - WHEELBASE, 0);
  return { front, rear };
}

interface AccelResult { to10: number; slip: number }

function accel(fill: SurfaceFill, rangePresses: number): AccelResult {
  const sim = carOn(FLAT, fill);
  select(sim, rangePresses);
  let slip = 0;
  let n = 0;
  for (let t = 0; t < 30; t += STEP) {
    bodyMotion(sim, motion);
    if (motion.forward >= 10) return { to10: t, slip: slip / Math.max(1, n) };
    controls(sim, { rangePresses, accelerator: 1, steer: Math.max(-1, Math.min(1, 4 * motion.heading)) });
    sim.step(STEP);
    slip += sim.wheelSlipRatio[2]! + sim.wheelSlipRatio[3]!;
    n += 2;
  }
  return { to10: Number.POSITIVE_INFINITY, slip: slip / Math.max(1, n) };
}

interface CornerResult {
  /** The most lateral acceleration held (smoothed over 0.25 s) before the body slid past 20 degrees of sideslip, g. */
  maxLateralG: number;
  sideslipAtMax: number;
  frontSlipAtMax: number;
  rearSlipAtMax: number;
  /** Lateral acceleration with the body at 5 degrees of sideslip, g: how much the car turns while it still points where it goes. */
  lateralGAt5: number;
  /** The turn's radius against the kinematic (wheelbase / tan steer) at a quarter of the reachable lock: 1 is neutral, more understeers. */
  understeerQuarter: number;
  /** The body slid past 20 degrees: it spun or drifted wide. */
  slid: boolean;
}

/** The car's sideways acceleration, from the change of its world velocity across a step, on its own right axis. */
class LateralMeter {
  private vx = Number.NaN;
  private vz = Number.NaN;
  smoothed = 0;
  update(sim: GroundVehicleSimulator): number {
    const v = sim.state.velocity;
    const q = sim.state.orientation;
    if (!Number.isNaN(this.vx)) {
      const ax = (v.x - this.vx) / STEP;
      const az = (v.z - this.vz) / STEP;
      const rx = 2 * (q.x * q.z + q.w * q.y);
      const rz = 1 - 2 * (q.x * q.x + q.y * q.y);
      const norm = Math.hypot(rx, rz) || 1;
      const a = (ax * rx + az * rz) / norm;
      this.smoothed += (a - this.smoothed) * (STEP / 0.25);
    }
    this.vx = v.x;
    this.vz = v.z;
    return this.smoothed;
  }
}

/** ISO 4138-style ramp steer at `speed` in 4H: the input wound from straight to full over 8 s at a held speed. */
function corner(fill: SurfaceFill, speed: number): CornerResult {
  const sim = launch(fill, speed, 1);
  const pi = new SpeedHold(speed);
  const meter = new LateralMeter();
  const result: CornerResult = {
    maxLateralG: 0, sideslipAtMax: 0, frontSlipAtMax: 0, rearSlipAtMax: 0, lateralGAt5: Number.NaN, understeerQuarter: Number.NaN, slid: false,
  };
  const quarter = 0.25 * rackLimitAt(speed);
  const seconds = 8;
  for (let t = 0; t < seconds; t += STEP) {
    bodyMotion(sim, motion);
    controls(sim, { rangePresses: 1, ...pi.pedals(motion.forward), steer: t / seconds });
    sim.step(STEP);
    bodyMotion(sim, motion);
    const lateral = meter.update(sim) / G;
    const beta = Math.atan2(motion.right, motion.forward) * DEG;
    if (Math.abs(beta) > 20) {
      result.slid = true;
      break;
    }
    if (Number.isNaN(result.lateralGAt5) && Math.abs(beta) >= 5) result.lateralGAt5 = lateral;
    if (lateral > result.maxLateralG) {
      result.maxLateralG = lateral;
      result.sideslipAtMax = beta;
      const a = slipAngles(sim);
      result.frontSlipAtMax = a.front;
      result.rearSlipAtMax = a.rear;
    }
    if (Number.isNaN(result.understeerQuarter) && sim.steering.rack >= quarter) {
      const v = Math.hypot(motion.forward, motion.right);
      const radius = v / Math.max(1e-6, motion.yawRate);
      const mean = 0.5 * (sim.steering.left + sim.steering.right);
      result.understeerQuarter = radius / (WHEELBASE / Math.tan(mean));
    }
  }
  return result;
}

/** The rack a full key reaches at `speed` (steering.ts's limit). */
function rackLimitAt(speed: number): number {
  const sim = carOn(FLAT, (out) => describeSurface(SurfaceMaterial.Asphalt, 0, out));
  sim.steering.input = 1;
  for (let i = 0; i < 600; i += 1) sim.steering.update({ dt: STEP, speed });
  return sim.steering.rack;
}

interface KeysResult { yawRate: number; radius: number; peakSideslip: number; spun: boolean; endSpeed: number }

/**
 * W and D held at 12 m/s for 3 s, the wheel wound at the keyboard's rate
 * (src/input: 2.8 a second at a crawl, half that at 10 m/s). The yaw rate
 * and radius at the end, the peak sideslip, and whether it spun (sideslip
 * past 30 degrees, or the car going backwards).
 */
function keys(fill: SurfaceFill, rangePresses: number): KeysResult {
  const speed = 12;
  const sim = launch(fill, speed, rangePresses);
  let steer = 0;
  let peak = 0;
  let spun = false;
  for (let t = 0; t < 3; t += STEP) {
    bodyMotion(sim, motion);
    const v = Math.hypot(motion.forward, motion.right);
    steer = Math.min(1, steer + ((2.8 * 10) / (10 + v)) * STEP);
    controls(sim, { rangePresses, accelerator: 1, steer });
    sim.step(STEP);
    bodyMotion(sim, motion);
    const beta = Math.abs(Math.atan2(motion.right, motion.forward)) * DEG;
    if (motion.forward < 0 && v > 1) spun = true;
    peak = Math.max(peak, beta);
    if (beta > 30) spun = true;
  }
  const v = Math.hypot(motion.forward, motion.right);
  return { yawRate: motion.yawRate * DEG, radius: v / Math.max(1e-6, Math.abs(motion.yawRate)), peakSideslip: peak, spun, endSpeed: v };
}

function brake(fill: SurfaceFill): number {
  const sim = launch(fill, 12, 1);
  const x0 = sim.state.position.x;
  const z0 = sim.state.position.z;
  for (let t = 0; t < 30; t += STEP) {
    bodyMotion(sim, motion);
    if (motion.forward < 0.05) break;
    controls(sim, { rangePresses: 1, brake: 1, steer: Math.max(-1, Math.min(1, 4 * motion.heading)) });
    sim.step(STEP);
  }
  return Math.hypot(sim.state.position.x - x0, sim.state.position.z - z0);
}

/** The steepest plane (2.5 degree steps) climbed 20 m from rest at 60% pedal within 25 s. */
function climb(fill: SurfaceFill, rangePresses: number): number {
  let best = 0;
  for (let degrees = 5; degrees <= 40; degrees += 2.5) {
    const sim = carOn(plane(degrees), fill);
    select(sim, rangePresses, 1.5);
    const z0 = sim.state.position.z;
    let made = false;
    for (let t = 0; t < 25; t += STEP) {
      bodyMotion(sim, motion);
      controls(sim, { rangePresses, accelerator: 0.6, steer: Math.max(-1, Math.min(1, 4 * motion.heading)) });
      sim.step(STEP);
      if ((sim.state.position.z - z0) / Math.cos(degrees / DEG) > 20) {
        made = true;
        break;
      }
    }
    if (!made) break;
    best = degrees;
  }
  return best;
}

const args = process.argv.slice(2);
const flags = new Map(args.filter((a) => a.startsWith("--")).map((a) => {
  const [k, v] = a.slice(2).split("=");
  return [k!, v ?? ""] as const;
}));
const sections = args.filter((a) => !a.startsWith("--"));
const want = (s: string) => sections.length === 0 || sections.includes(s);
const only = flags.get("surfaces")?.split(",");
const surfaces = SURFACES.filter(([name]) => !only || only.includes(name));
const report: Record<string, Record<string, unknown>> = {};
const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "never");

for (const [name, fill] of surfaces) {
  const row: Record<string, unknown> = {};
  report[name] = row;
  const cells: string[] = [name.padEnd(13)];
  if (want("accel")) {
    const a2 = accel(fill, 0);
    const a4 = accel(fill, 1);
    row.accel = { "2H": a2, "4H": a4 };
    cells.push(`0-10 m/s 2H ${f(a2.to10, 2)} s (slip ${f(a2.slip, 2)}), 4H ${f(a4.to10, 2)} s`);
  }
  if (want("corner")) {
    const c = corner(fill, 10);
    row.corner = c;
    cells.push(`corner@10 4H max ${f(c.maxLateralG, 2)} g (beta ${f(c.sideslipAtMax)}, slip F ${f(c.frontSlipAtMax)} R ${f(c.rearSlipAtMax)})${c.slid ? " SLID" : ""}, ${f(c.lateralGAt5, 2)} g at 5 deg beta, R/kin@1/4 ${f(c.understeerQuarter, 2)}`);
  }
  if (want("keys")) {
    const k2 = keys(fill, 0);
    const k4 = keys(fill, 1);
    row.keys = { "2H": k2, "4H": k4 };
    const kk = (k: KeysResult) => `r ${f(k.radius)} m beta ${f(k.peakSideslip)}${k.spun ? " SPUN" : ""}`;
    cells.push(`W+D@12 2H ${kk(k2)}, 4H ${kk(k4)}`);
  }
  if (want("brake")) {
    const b = brake(fill);
    row.brake = b;
    cells.push(`brake 12-0 ${f(b)} m`);
  }
  if (want("climb")) {
    const c4h = climb(fill, 1);
    const c4l = climb(fill, 2);
    row.climb = { "4H": c4h, "4L": c4l };
    cells.push(`climb 4H ${f(c4h)} 4L ${f(c4l)} deg`);
  }
  console.log(cells.join(" | "));
}

const json = flags.get("json");
if (json) writeFileSync(json, JSON.stringify(report, null, 2));
