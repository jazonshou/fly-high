import {
  NEUTRAL_PERSON_CONTROLS,
  type SurfaceVehicleControls,
  type SurfaceVehicleEnvironment,
  type SurfaceVehicleSnapshot,
} from "../surface/types";
import type { PersonControlState, PersonMode, PersonVisualState } from "@/src/game/types";
import { PERSON_SURFACE_WATER } from "@/src/game/types";
import { PERSON, personJumpSpeed, toblerFactor } from "@/src/vehicles/person";
import type { TerrainCollisionSample } from "@/src/world/types";
import { createColliderContact } from "../colliders";
import { clamp, quaternionFromAxisAngle, wrapAngle } from "../math";
import type { Vec3 } from "../types";
import type { VehiclePoseState } from "../vehicle";
import { createWaterSurfaceSample } from "../water/types";
import type { PersonSimulator, PersonSpawn } from "./types";

const UP: Vec3 = Object.freeze({ x: 0, y: 1, z: 0 });
/** Horizontal acceleration toward the commanded velocity on the ground, m/s^2. */
const GROUND_ACCELERATION = 10;
const SWIM_ACCELERATION = 2;
/** Probe spheres against the colliders: at the shins and at the chest. */
const PROBE_HEIGHTS = [0.35, 1.25] as const;

/**
 * A STAND-IN for the walker's physics, so the walking session, the camera,
 * the input and the HUD can be built and tested before the real controller
 * (the person physics build, W1) lands in this directory and replaces it.
 * It walks and runs at the spec's speeds scaled by Tobler's function, jumps,
 * follows the terrain, is pushed out of colliders at two heights, and floats
 * at the surface in water deeper than the swim depth. No step-up onto
 * collider tops, no near solids, no diving, no mantling.
 */
export class StandInWalker implements PersonSimulator {
  readonly state: VehiclePoseState;
  private controls: PersonControlState = NEUTRAL_PERSON_CONTROLS;
  private environment: SurfaceVehicleEnvironment | null = null;
  private heading: number;
  private grounded = true;
  private mode: PersonMode = "stand";
  private lastJumpPresses: number | null = null;
  private landingSpeed = 0;
  private landingAge = 1e3;
  private slope = 0;
  private waterDepth = 0;
  private surface = 0;
  private readonly safe: Vec3;
  private safeHeading: number;
  private readonly ground: TerrainCollisionSample = {
    height: 0,
    normal: { x: 0, y: 1, z: 0 },
    isRunway: false,
    friction: 1,
  };
  private readonly water = createWaterSurfaceSample();
  private readonly contact = createColliderContact();
  private readonly probe: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(spawn: PersonSpawn) {
    this.heading = spawn.heading;
    this.safeHeading = spawn.heading;
    this.safe = { ...spawn.position };
    this.state = {
      time: 0,
      position: { ...spawn.position },
      velocity: { x: 0, y: 0, z: 0 },
      orientation: quaternionFromAxisAngle(UP, spawn.heading - Math.PI / 2),
      angularVelocity: { x: 0, y: 0, z: 0 },
      crashed: false,
    };
  }

  setControls(controls: Readonly<SurfaceVehicleControls>): void {
    this.controls = controls.person ?? NEUTRAL_PERSON_CONTROLS;
  }

  setEnvironment(environment: Readonly<SurfaceVehicleEnvironment>): void {
    this.environment = environment;
  }

  placeAt(position: Readonly<Vec3>, heading: number): void {
    const state = this.state;
    state.position.x = position.x;
    state.position.y = position.y;
    state.position.z = position.z;
    state.velocity.x = 0;
    state.velocity.y = 0;
    state.velocity.z = 0;
    state.angularVelocity.y = 0;
    this.setHeading(heading);
    this.grounded = true;
    this.mode = "stand";
    this.landingAge = 1e3;
    this.safe.x = position.x;
    this.safe.y = position.y;
    this.safe.z = position.z;
    this.safeHeading = heading;
  }

  recover(): void {
    this.placeAt(this.safe, this.safeHeading);
  }

  step(dt: number): void {
    const environment = this.environment;
    if (!environment) return;
    const state = this.state;
    const position = state.position;
    const velocity = state.velocity;
    const controls = this.controls;
    state.time += dt;
    this.landingAge += dt;

    const ground = environment.groundContact
      ? environment.groundContact(position.x, position.z, this.ground)
      : null;
    const groundHeight = ground ? ground.height : environment.bedHeight(position.x, position.z);
    const water = environment.water.sample(position.x, position.z, this.water);
    this.waterDepth = water.kind === "none" ? 0 : Math.max(0, water.height - groundHeight);
    const swimming = this.waterDepth > PERSON.swimDepthFraction * PERSON.stature;
    const wading = !swimming && this.waterDepth > PERSON.wadeDepthFraction * PERSON.stature;

    // The commanded horizontal velocity, and the heading it turns toward.
    let moveX = controls.moveX;
    let moveZ = controls.moveZ;
    const magnitude = Math.hypot(moveX, moveZ);
    if (magnitude > 1) {
      moveX /= magnitude;
      moveZ /= magnitude;
    }
    const moving = magnitude > 0.05;
    const run = controls.run && moving;
    let speed = swimming
      ? (run ? PERSON.swimFastSpeed : PERSON.swimSpeed)
      : (run ? PERSON.runSpeed : PERSON.walkSpeed);
    this.slope = 0;
    if (!swimming && ground && ground.normal.y > 0.2 && moving) {
      const inverse = 1 / Math.hypot(moveX, moveZ);
      // Rise over run along the direction of travel, from the ground normal.
      this.slope = -(ground.normal.x * moveX + ground.normal.z * moveZ) * inverse / ground.normal.y;
      speed *= toblerFactor(this.slope);
    }
    if (wading) {
      const share = (this.waterDepth / PERSON.stature - PERSON.wadeDepthFraction)
        / (PERSON.swimDepthFraction - PERSON.wadeDepthFraction);
      speed *= 1 - 0.6 * clamp(share, 0, 1);
    }
    const targetX = moveX * speed;
    const targetZ = moveZ * speed;
    const control = this.grounded || swimming ? 1 : PERSON.airControl;
    const rate = (swimming ? SWIM_ACCELERATION : GROUND_ACCELERATION) * control * dt;
    velocity.x += clamp(targetX - velocity.x, -rate, rate);
    velocity.z += clamp(targetZ - velocity.z, -rate, rate);
    if (moving) {
      const wanted = Math.atan2(moveX, moveZ);
      const turn = (run ? PERSON.turnRateRun : PERSON.turnRateWalk) * dt;
      let delta = wanted - this.heading;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      const applied = clamp(delta, -turn, turn);
      this.setHeading(this.heading + applied);
      state.angularVelocity.y = dt > 0 ? applied / dt : 0;
    } else {
      state.angularVelocity.y = 0;
    }

    // Vertical: floating, a jump, gravity, and the ground.
    const presses = controls.jumpPresses;
    const jumped = this.lastJumpPresses !== null && presses !== this.lastJumpPresses;
    this.lastJumpPresses = presses;
    if (swimming) {
      // Float with the mouth at the surface: the feet 0.75 H below it.
      const floatFeet = water.height - PERSON.swimDepthFraction * PERSON.stature;
      velocity.y = clamp((floatFeet - position.y) * 4, -2, 2);
      this.grounded = false;
    } else {
      if (jumped && this.grounded) {
        velocity.y = personJumpSpeed(environment.gravity);
        this.grounded = false;
      }
      if (!this.grounded) velocity.y -= environment.gravity * dt;
    }
    position.x += velocity.x * dt;
    position.y += velocity.y * dt;
    position.z += velocity.z * dt;

    this.pushOutOfColliders(environment);

    const floorHeight = environment.groundContact
      ? environment.groundContact(position.x, position.z, this.ground).height
      : environment.bedHeight(position.x, position.z);
    if (!swimming) {
      if (this.grounded && position.y - floorHeight < PERSON.snapDown && velocity.y <= 0) {
        position.y = floorHeight;
        velocity.y = 0;
      } else if (position.y <= floorHeight) {
        if (!this.grounded) {
          this.landingSpeed = -velocity.y;
          this.landingAge = 0;
        }
        position.y = floorHeight;
        velocity.y = 0;
        this.grounded = true;
      } else {
        this.grounded = false;
      }
    } else if (position.y < floorHeight) {
      position.y = floorHeight;
    }
    if (this.grounded && !wading && this.waterDepth === 0) {
      this.safe.x = position.x;
      this.safe.y = position.y;
      this.safe.z = position.z;
      this.safeHeading = this.heading;
    }

    const horizontal = Math.hypot(velocity.x, velocity.z);
    this.surface = this.waterDepth > 0 ? PERSON_SURFACE_WATER : this.grounded ? 0 : -1;
    this.mode = swimming
      ? "swim"
      : !this.grounded
        ? "air"
        : this.landingAge < 0.4 && this.landingSpeed >= 5
          ? "land"
          : wading
            ? "wade"
            : horizontal > PERSON.walkRunSpeed
              ? "run"
              : horizontal > 0.1
                ? "walk"
                : "stand";
  }

  snapshot(): SurfaceVehicleSnapshot {
    const state = this.state;
    const water = this.water;
    const headY = state.position.y + PERSON.eyeHeight;
    const headDepth = water.kind === "none" ? -PERSON.stature : water.height - headY;
    const payload: PersonVisualState = {
      kind: "person",
      mode: this.mode,
      speed: Math.hypot(state.velocity.x, state.velocity.z),
      running: this.controls.run,
      grounded: this.grounded,
      slope: this.grounded ? this.slope : 0,
      waterDepth: this.waterDepth,
      submersion: clamp(this.waterDepth / PERSON.stature, 0, 1),
      headDepth,
      swimPitch: 0,
      landingSpeed: this.landingSpeed,
      landingAge: Math.min(this.landingAge, 60),
      surface: this.surface,
      boarding: null,
    };
    return {
      time: state.time,
      position: { ...state.position },
      velocity: { ...state.velocity },
      orientation: { ...state.orientation },
      angularVelocity: { ...state.angularVelocity },
      throttle: 0,
      engineRpm: 0,
      onGround: this.grounded,
      crashed: false,
      payload,
    };
  }

  private setHeading(heading: number): void {
    this.heading = wrapAngle(heading);
    const half = (this.heading - Math.PI / 2) * 0.5;
    const orientation = this.state.orientation;
    orientation.x = 0;
    orientation.y = Math.sin(half);
    orientation.z = 0;
    orientation.w = Math.cos(half);
  }

  private pushOutOfColliders(environment: Readonly<SurfaceVehicleEnvironment>): void {
    const colliders = environment.colliders;
    if (!colliders) return;
    const position = this.state.position;
    const velocity = this.state.velocity;
    for (const height of PROBE_HEIGHTS) {
      this.probe.x = position.x;
      this.probe.y = position.y + height;
      this.probe.z = position.z;
      if (!colliders.deepestSphereContact(this.probe, PERSON.capsuleRadius, this.contact)) continue;
      const normal = this.contact.normal;
      // Push out horizontally only: tops are not walkable in the stand-in.
      const horizontal = Math.hypot(normal.x, normal.z);
      if (horizontal < 1e-3) continue;
      const nx = normal.x / horizontal;
      const nz = normal.z / horizontal;
      position.x += nx * this.contact.penetration;
      position.z += nz * this.contact.penetration;
      const into = velocity.x * nx + velocity.z * nz;
      if (into < 0) {
        velocity.x -= into * nx;
        velocity.z -= into * nz;
      }
    }
  }
}
