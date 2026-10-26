import {
  MAX_BOAT_SPRAY_ROOTS,
  type BoatGear,
  type BoatVisualState,
} from "@/src/game/types";
import { clamp, moveToward, quaternionFromFlightAngles } from "../math";
import type { VehiclePoseState } from "../vehicle";
import { createWaterSurfaceSample } from "../water/types";
import {
  NEUTRAL_BOAT_CONTROLS,
  type SurfaceVehicleControls,
  type SurfaceVehicleEnvironment,
  type SurfaceVehicleSimulator,
  type SurfaceVehicleSnapshot,
  type SurfaceVehicleSpawn,
} from "./types";

/** Full ahead holds about 39 kn, the Runabout 21's top-speed target. */
const FULL_AHEAD_SPEED = 20;
const FULL_ASTERN_SPEED = 3;
const SPEED_TIME_CONSTANT = 3;
const LEVER_RATE = 1.5;
const STEER_RATE = 1.2;
const TRIM_RATE = 0.25;
const TAB_RATE = 0.4;
const MAX_YAW_RATE = 0.5;
const MAX_STEER_ANGLE = (30 * Math.PI) / 180;
const IDLE_RPM = 700;
const LIMITER_RPM = 6_000;
/** CG height above the still waterline at rest. */
const CG_ABOVE_WATER = 0.2;
const DRAFT = 0.45;
const GROUNDING_CRASH_SPEED = 5;

/**
 * A kinematic stand-in for the Runabout 21 so the shared base can run a boat
 * session end to end: spawn, worker loop, snapshot, renderer slot, HUD and
 * input. It rides the water authority's surface with a scripted attitude and
 * has no forces at all.
 *
 * NOT the boat. The speedboat physics work replaces it with `BoatSimulator`
 * behind the same `SurfaceVehicleSimulator` seam (`createSurfaceSimulator`).
 */
export class StandInBoatSimulator implements SurfaceVehicleSimulator {
  readonly state: VehiclePoseState;
  private controls: SurfaceVehicleControls = { assist: "scenic", boat: { ...NEUTRAL_BOAT_CONTROLS } };
  private environment: SurfaceVehicleEnvironment | null = null;
  private readonly water = createWaterSurfaceSample();
  private heading: number;
  private speed = 0;
  private yawRate = 0;
  private lever = 0;
  private steer = 0;
  private trim = 0.2;
  private tabs = 0;
  private rpm = IDLE_RPM;
  private moored: boolean;
  /** The press count last seen; null until the first controls arrive. */
  private moorPresses: number | null = null;
  private onGround = false;
  private readonly payload: BoatVisualState = {
    kind: "boat",
    speedThroughWater: 0,
    gear: "neutral",
    lever: 0,
    steerAngle: 0,
    trim: 0,
    trimAngle: 0,
    tabPort: 0,
    tabStarboard: 0,
    depthUnderKeel: 0,
    propellerImmersion: 1,
    moored: false,
    ventilating: false,
    capsized: false,
    planing: 0,
    wettedLength: 6,
    transomImmersion: 0.4,
    sprayRoots: new Array<number>(MAX_BOAT_SPRAY_ROOTS * 4).fill(0),
    sprayRootCount: 0,
  };

  constructor(spawn: SurfaceVehicleSpawn) {
    this.heading = spawn.heading;
    this.moored = spawn.moored;
    this.state = {
      time: 0,
      position: { ...spawn.position },
      velocity: { x: 0, y: 0, z: 0 },
      orientation: quaternionFromFlightAngles(spawn.heading, 0, 0),
      angularVelocity: { x: 0, y: 0, z: 0 },
      crashed: false,
    };
  }

  setControls(controls: Readonly<SurfaceVehicleControls>): void {
    this.controls = controls;
  }

  setEnvironment(environment: Readonly<SurfaceVehicleEnvironment>): void {
    this.environment = environment;
  }

  step(dt: number): void {
    const environment = this.environment;
    const state = this.state;
    state.time += dt;
    if (!environment || state.crashed) return;
    const input = this.controls.boat;
    if (this.moorPresses === null) this.moorPresses = input.moorPresses;
    if (input.moorPresses !== this.moorPresses) {
      this.moorPresses = input.moorPresses;
      if (this.moored) this.moored = false;
      else if (Math.abs(this.speed) < 0.6) this.moored = true;
    }

    this.lever = moveToward(this.lever, clamp(input.lever, -1, 1), LEVER_RATE * dt);
    this.steer = moveToward(this.steer, clamp(input.steer, -1, 1), STEER_RATE * dt);
    this.trim = clamp(this.trim + clamp(input.trim, -1, 1) * TRIM_RATE * dt, 0, 1);
    this.tabs = clamp(this.tabs + clamp(input.tabs, -1, 1) * TAB_RATE * dt, 0, 1);
    if (this.moored && Math.abs(this.lever) > 0.05) this.moored = false;

    const gear = this.gear();
    const target = this.moored
      ? 0
      : gear === "forward"
        ? this.lever * FULL_AHEAD_SPEED
        : gear === "reverse"
          ? this.lever * FULL_ASTERN_SPEED
          : 0;
    this.speed += (target - this.speed) * (1 - Math.exp(-dt / SPEED_TIME_CONSTANT));
    const steering = Math.min(1, Math.abs(this.speed) / 4) * Math.sign(this.speed);
    this.yawRate = this.steer * MAX_YAW_RATE * steering;
    this.heading += this.yawRate * dt;
    const rpmTarget = gear === "neutral" ? IDLE_RPM : IDLE_RPM + Math.abs(this.lever) * (LIMITER_RPM - IDLE_RPM);
    this.rpm += (rpmTarget - this.rpm) * (1 - Math.exp(-dt / 0.6));

    const forwardX = Math.sin(this.heading);
    const forwardZ = Math.cos(this.heading);
    const nextX = state.position.x + forwardX * this.speed * dt;
    const nextZ = state.position.z + forwardZ * this.speed * dt;
    environment.water.sample(nextX, nextZ, this.water);
    this.onGround = this.water.kind === "none" || this.water.depth < DRAFT;
    if (this.onGround) {
      if (Math.abs(this.speed) > GROUNDING_CRASH_SPEED) state.crashed = true;
      this.speed = 0;
    } else {
      state.position.x = nextX;
      state.position.z = nextZ;
    }
    environment.water.sample(state.position.x, state.position.z, this.water);
    const previousY = state.position.y;
    state.position.y = this.water.height + CG_ABOVE_WATER;
    state.velocity.x = forwardX * this.speed;
    state.velocity.z = forwardZ * this.speed;
    state.velocity.y = dt > 0 ? (state.position.y - previousY) / dt : 0;

    const planing = this.planing();
    const hump = Math.exp(-(((Math.abs(this.speed) - 4.5) / 2) ** 2));
    const pitch = ((6 * hump + 3.5 * planing + (this.trim - 0.2) * 3 - this.tabs * 2) * Math.PI) / 180;
    const bank = clamp(this.yawRate * this.speed * 0.05, -0.26, 0.26);
    const orientation = quaternionFromFlightAngles(this.heading, pitch, bank);
    state.orientation.x = orientation.x;
    state.orientation.y = orientation.y;
    state.orientation.z = orientation.z;
    state.orientation.w = orientation.w;
    state.angularVelocity.x = 0;
    state.angularVelocity.y = this.yawRate;
    state.angularVelocity.z = 0;
  }

  snapshot(): SurfaceVehicleSnapshot {
    const payload = this.payload;
    const planing = this.planing();
    payload.speedThroughWater = Math.abs(this.speed);
    payload.gear = this.gear();
    payload.lever = this.lever;
    payload.steerAngle = this.steer * MAX_STEER_ANGLE;
    payload.trim = this.trim;
    payload.trimAngle = ((-4 + this.trim * 20) * Math.PI) / 180;
    payload.tabPort = this.tabs;
    payload.tabStarboard = this.tabs;
    payload.depthUnderKeel = Math.max(0, this.water.depth - DRAFT);
    payload.moored = this.moored;
    payload.capsized = false;
    payload.planing = planing;
    payload.wettedLength = 6 - planing * 3;
    payload.transomImmersion = 0.4 - planing * 0.3;
    const state = this.state;
    return {
      time: state.time,
      position: { ...state.position },
      velocity: { ...state.velocity },
      orientation: { ...state.orientation },
      angularVelocity: { ...state.angularVelocity },
      throttle: (this.rpm - IDLE_RPM) / (LIMITER_RPM - IDLE_RPM),
      engineRpm: this.rpm,
      onGround: this.onGround,
      crashed: state.crashed,
      payload: { ...payload, sprayRoots: payload.sprayRoots.slice() },
    };
  }

  private gear(): BoatGear {
    return this.lever > 0.05 ? "forward" : this.lever < -0.05 ? "reverse" : "neutral";
  }

  private planing(): number {
    return clamp((Math.abs(this.speed) - 6) / 6, 0, 1);
  }
}
