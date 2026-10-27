import {
  CAR_WHEELS,
  type CarControlState,
  type CarSetup,
  type CarVisualState,
} from "@/src/game/types";
import type { TerrainCollisionSample } from "@/src/world/types";
import { clamp, quaternionFromFlightAngles, wrapAngle } from "../math";
import {
  DEFAULT_CAR_SETUP,
  NEUTRAL_CAR_CONTROLS,
  type SurfaceVehicleControls,
  type SurfaceVehicleEnvironment,
  type SurfaceVehicleSimulator,
  type SurfaceVehicleSnapshot,
  type SurfaceVehicleSpawn,
} from "../surface/types";
import type { VehiclePoseState } from "../vehicle";

/**
 * A KINEMATIC STAND-IN for the LandCruiser 76, so the car's look, sound, HUD,
 * input and roads can be built against the real seam before its physics
 * exists. A bicycle model on the ground: it drives at the speed the pedals
 * ask for, turns on the 12.6 m circle, and sits on the four wheels' ground
 * heights with no suspension, tyres, soil or water. It never slips, sinks,
 * stalls, floods or rolls; every such field in its payload is neutral.
 *
 * The car physics build replaces it with the full model behind the same
 * `createCarSimulator` (land plan P1/P2); nothing outside `src/sim/ground/`
 * should depend on how this one moves. Unlike the seam asks, its step
 * allocates a quaternion: it is not meant to last.
 */

/** Wheel geometry, body frame, metres from the centre of gravity (52% on the front axle). */
export const LC76_WHEELBASE = 2.73;
export const LC76_FRONT_AXLE_X = 0.48 * LC76_WHEELBASE;
export const LC76_REAR_AXLE_X = LC76_FRONT_AXLE_X - LC76_WHEELBASE;
export const LC76_FRONT_TRACK = 1.555;
export const LC76_REAR_TRACK = 1.46;
/** 265/70R16, loaded. */
export const LC76_WHEEL_RADIUS = 0.37;
/** Centre of gravity above the ground under it, kerb weight (the plan's estimate). */
export const LC76_CG_HEIGHT = 0.8;
/**
 * The bicycle model's lock: the mean of the 34 degree inner and 26 degree
 * outer road wheels, which puts the outer front wheel on the 12.6 m
 * kerb-to-kerb circle.
 */
export const LC76_MAX_STEER = (30 * Math.PI) / 180;
export const LC76_MASS = 2_300;

const WHEEL_X = [LC76_FRONT_AXLE_X, LC76_FRONT_AXLE_X, LC76_REAR_AXLE_X, LC76_REAR_AXLE_X] as const;
const WHEEL_Z = [-LC76_FRONT_TRACK / 2, LC76_FRONT_TRACK / 2, -LC76_REAR_TRACK / 2, LC76_REAR_TRACK / 2] as const;

const MAX_FORWARD_SPEED = 44;
const MAX_REVERSE_SPEED = 6;
const DRIVE_ACCELERATION = 3.2;
const BRAKE_DECELERATION = 7.5;
const ROLLING_DECELERATION = 0.35;
const STEER_RATE = 1.6;
const IDLE_RPM = 750;
const MAX_RPM = 4_500;
/** The AC60 automatic's ratios, on the 4.300 final drive. */
const AT_RATIOS = [3.6, 2.09, 1.488, 1, 0.687, 0.58] as const;
const FINAL_DRIVE = 4.3;
const REVERSE_RATIO = 3.732;
const SHIFT_UP_RPM = 2_600;

const STOPPED = 0.05;

function rpmPerSpeed(ratio: number): number {
  return (ratio * FINAL_DRIVE * 60) / (2 * Math.PI * LC76_WHEEL_RADIUS);
}

export class StandInCarSimulator implements SurfaceVehicleSimulator {
  readonly state: VehiclePoseState;
  private readonly setup: CarSetup;
  private readonly controls: CarControlState = { ...NEUTRAL_CAR_CONTROLS };
  private environment: Readonly<SurfaceVehicleEnvironment> | null = null;
  private heading: number;
  private speed = 0;
  private steer = 0;
  private gear = 1;
  private rpm = IDLE_RPM;
  private throttle = 0;
  private headlights: CarVisualState["headlights"] = "off";
  private headlightPresses: number | null = null;
  private readonly contact: TerrainCollisionSample = {
    height: 0,
    normal: { x: 0, y: 1, z: 0 },
    isRunway: false,
    friction: 1,
  };
  private readonly wheelGround = [0, 0, 0, 0];
  private readonly wheelSpin = [0, 0, 0, 0];

  constructor(spawn?: SurfaceVehicleSpawn) {
    this.setup = spawn?.car ?? DEFAULT_CAR_SETUP;
    this.heading = spawn?.heading ?? 0;
    const position = spawn?.position ?? { x: 0, y: 0, z: 0 };
    this.state = {
      time: 0,
      position: { x: position.x, y: position.y + LC76_CG_HEIGHT, z: position.z },
      velocity: { x: 0, y: 0, z: 0 },
      orientation: quaternionFromFlightAngles(this.heading, 0, 0),
      angularVelocity: { x: 0, y: 0, z: 0 },
      crashed: false,
    };
  }

  setControls(controls: Readonly<SurfaceVehicleControls>): void {
    const car = controls.car ?? NEUTRAL_CAR_CONTROLS;
    const c = this.controls;
    c.accelerator = Number.isFinite(car.accelerator) ? clamp(car.accelerator, 0, 1) : 0;
    c.brake = Number.isFinite(car.brake) ? clamp(car.brake, 0, 1) : 0;
    c.steer = Number.isFinite(car.steer) ? clamp(car.steer, -1, 1) : 0;
    c.handbrake = Number.isFinite(car.handbrake) ? clamp(car.handbrake, 0, 1) : 0;
    c.tyrePressure = car.tyrePressure;
    // A press is a change of count; the first count seen is the baseline.
    if (this.headlightPresses === null) this.headlightPresses = car.headlightPresses;
    else if (car.headlightPresses !== this.headlightPresses) {
      const presses = car.headlightPresses - this.headlightPresses;
      this.headlightPresses = car.headlightPresses;
      for (let i = 0; i < ((presses % 3) + 3) % 3; i += 1) {
        this.headlights = this.headlights === "off" ? "dipped" : this.headlights === "dipped" ? "main" : "off";
      }
    }
  }

  setEnvironment(environment: Readonly<SurfaceVehicleEnvironment>): void {
    this.environment = environment;
  }

  step(dt: number): void {
    const c = this.controls;
    // Pedals: W drives, S brakes and, once stopped, reverses.
    let acceleration = c.accelerator * DRIVE_ACCELERATION - Math.sign(this.speed) * ROLLING_DECELERATION;
    if (c.brake > 0) {
      if (this.speed > STOPPED) acceleration -= c.brake * BRAKE_DECELERATION;
      else acceleration = -c.brake * DRIVE_ACCELERATION * 0.6;
    }
    if (c.handbrake > 0) acceleration -= Math.sign(this.speed) * c.handbrake * BRAKE_DECELERATION;
    let speed = this.speed + acceleration * dt;
    if (c.accelerator === 0 && c.brake === 0 && Math.abs(speed) < STOPPED) speed = 0;
    if (c.accelerator > 0 && this.speed >= 0 && speed < 0) speed = 0;
    this.speed = clamp(speed, -MAX_REVERSE_SPEED, MAX_FORWARD_SPEED);

    this.steer += clamp(c.steer * LC76_MAX_STEER - this.steer, -STEER_RATE * dt, STEER_RATE * dt);
    const yawRate = (this.speed / LC76_WHEELBASE) * Math.tan(this.steer);
    this.heading = wrapAngle(this.heading + yawRate * dt);

    const p = this.state.position;
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    p.x += fx * this.speed * dt;
    p.z += fz * this.speed * dt;

    // Seat it on the four wheels' ground. Body +Z, the right side, is (cos h, -sin h) in plan.
    const rx = fz;
    const rz = -fx;
    for (let i = 0; i < 4; i += 1) {
      this.wheelGround[i] = this.groundAt(p.x + fx * WHEEL_X[i]! + rx * WHEEL_Z[i]!, p.z + fz * WHEEL_X[i]! + rz * WHEEL_Z[i]!);
    }
    const g = this.wheelGround;
    const front = (g[0]! + g[1]!) / 2;
    const rear = (g[2]! + g[3]!) / 2;
    const left = (g[0]! + g[2]!) / 2;
    const right = (g[1]! + g[3]!) / 2;
    const pitch = Math.atan2(front - rear, LC76_WHEELBASE);
    // Bank is positive right side down.
    const bank = Math.atan2(left - right, (LC76_FRONT_TRACK + LC76_REAR_TRACK) / 2);
    const groundAtCg = rear + (front - rear) * (-LC76_REAR_AXLE_X / LC76_WHEELBASE);
    const previousY = p.y;
    p.y = groundAtCg + LC76_CG_HEIGHT;

    const v = this.state.velocity;
    v.x = fx * this.speed;
    v.z = fz * this.speed;
    v.y = dt > 0 ? (p.y - previousY) / dt : 0;
    const q = quaternionFromFlightAngles(this.heading, pitch, bank);
    const o = this.state.orientation;
    o.x = q.x;
    o.y = q.y;
    o.z = q.z;
    o.w = q.w;
    this.state.angularVelocity.y = -yawRate;

    const spinRate = this.speed / LC76_WHEEL_RADIUS;
    for (let i = 0; i < 4; i += 1) {
      this.wheelSpin[i] = ((this.wheelSpin[i]! + spinRate * dt) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    }
    this.updateEngine(dt);
    this.state.time += dt;
  }

  /** A stand-in automatic: shift up at 2,600 rpm, down below 1,100. */
  private updateEngine(dt: number): void {
    const speed = this.speed;
    if (speed < -STOPPED) this.gear = -1;
    else if (this.gear < 1) this.gear = 1;
    if (this.gear >= 1) {
      while (this.gear < AT_RATIOS.length && rpmPerSpeed(AT_RATIOS[this.gear - 1]!) * speed > SHIFT_UP_RPM) this.gear += 1;
      while (this.gear > 1 && rpmPerSpeed(AT_RATIOS[this.gear - 1]!) * speed < 1_100) this.gear -= 1;
    }
    const ratio = this.gear < 0 ? REVERSE_RATIO : AT_RATIOS[this.gear - 1]!;
    const wheelRpm = rpmPerSpeed(ratio) * Math.abs(speed);
    const target = clamp(Math.max(IDLE_RPM + this.controls.accelerator * 900, wheelRpm), IDLE_RPM, MAX_RPM);
    this.rpm += (target - this.rpm) * Math.min(1, dt * 6);
    this.throttle += (this.controls.accelerator - this.throttle) * Math.min(1, dt * 8);
  }

  private groundAt(x: number, z: number): number {
    const env = this.environment;
    if (!env) return this.state.position.y - LC76_CG_HEIGHT;
    if (env.groundContact) return env.groundContact(x, z, this.contact).height;
    return env.bedHeight(x, z);
  }

  snapshot(): SurfaceVehicleSnapshot & { payload: CarVisualState } {
    return {
      time: this.state.time,
      position: { ...this.state.position },
      velocity: { ...this.state.velocity },
      orientation: { ...this.state.orientation },
      angularVelocity: { ...this.state.angularVelocity },
      throttle: this.throttle,
      engineRpm: this.rpm,
      onGround: true,
      crashed: false,
      payload: this.visualState(),
    };
  }

  visualState(): CarVisualState {
    const automatic = this.setup.gearbox === "automatic";
    const stopped = Math.abs(this.speed) < STOPPED;
    const sea = this.environment?.world?.seaLevel ?? Number.NEGATIVE_INFINITY;
    const ground = this.state.position.y - LC76_CG_HEIGHT;
    const spinRate = this.speed / LC76_WHEEL_RADIUS;
    const weight = (LC76_MASS * (this.environment?.gravity ?? 9.80665)) / CAR_WHEELS.length;
    return {
      kind: "car",
      speed: this.speed,
      gearbox: this.setup.gearbox,
      selector: automatic ? (this.gear < 0 ? "R" : stopped && this.controls.accelerator === 0 ? "N" : "D") : null,
      gear: stopped && this.controls.accelerator === 0 ? 0 : this.gear,
      range: "2H",
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
      boost: clamp((this.rpm - 1_400) / 1_400, 0, 1) * this.throttle,
      headlights: this.headlights,
      brakeLights: this.controls.brake > 0 || this.controls.handbrake > 0,
      reversing: this.gear < 0,
      tyrePressure: this.controls.tyrePressure,
      tyrePressureBar: this.controls.tyrePressure === "sand" ? 1.2 : 2.4,
      wadingDepth: Math.max(0, sea - ground),
      wheelSteer: [this.steer, this.steer, 0, 0],
      wheelSpin: [...this.wheelSpin],
      wheelSpinRate: [spinRate, spinRate, spinRate, spinRate],
      wheelLoad: [weight, weight, weight, weight],
      wheelSlip: [0, 0, 0, 0],
      wheelSinkage: [0, 0, 0, 0],
      wheelSurface: [-1, -1, -1, -1],
      axleHeave: [0, 0],
      axleRoll: [0, 0],
      // The 76's rack: about 3.6 turns lock to lock.
      steeringWheel: (this.steer / LC76_MAX_STEER) * Math.PI * 3.6,
      bumpStop: 0,
      scrape: 0,
      splash: 0,
    };
  }
}
