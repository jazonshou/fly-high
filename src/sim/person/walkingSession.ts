import type {
  CarControlState,
  CarDoorSide,
  FlightVisualState,
  PersonBoardingState,
  PersonVisualState,
  WalkingPrompt,
  WalkingVisualState,
} from "@/src/game/types";
import { CAR_SEATING, PERSON } from "@/src/vehicles/person";
import type { TerrainCollisionSample } from "@/src/world/types";
import { createColliderContact } from "../colliders";
import { clamp, rotateVectorInto } from "../math";
import {
  NEUTRAL_BOAT_CONTROLS,
  NEUTRAL_CAR_CONTROLS,
  type SurfaceVehicleControls,
  type SurfaceVehicleEnvironment,
  type SurfaceVehicleSimulator,
} from "../surface/types";
import { flightAnglesOf, surfaceVisualState } from "../surface/visualState";
import type { Quaternion, Vec3 } from "../types";
import { createWaterSurfaceSample } from "../water/types";
import type { PersonSimulator } from "./types";

/** Collider group of the parked car's body box. */
export const PARKED_CAR_COLLIDER_GROUP = 7_001;
/** Its material id: a vehicle's body, a wall to the walker. */
export const PARKED_CAR_COLLIDER_MATERIAL = 201;

/** The parked car falls asleep after this long at rest. */
const SLEEP_AFTER_SECONDS = 1;
const REST_SPEED = 0.03;
const REST_TURN_RATE = 0.03;
/** The get-in prompt shows within this distance of a door, metres. */
const PROMPT_DISTANCE = 3;
/** A door side is blocked by a drop or a rise of more than this from the car's footing, metres. */
const DOOR_MAX_STEP = 0.8;

/** Where the walking session starts: in the driver's seat, or on foot by the driver's door. */
export type WalkingStart = "car" | "foot";

/** What a car simulator in a walking session must offer beyond the surface seam. */
export interface WalkingCar extends SurfaceVehicleSimulator {
  /** R while driving: the car back on its newest safe spot. */
  recover?(): void;
  /** Held at its start until the terrain under it streams in (`CarVisualState.settling`). */
  readonly waitingForGround?: boolean;
  /** On its roof or a side (`CarVisualState.rolled`). */
  readonly isRolled?: boolean;
}

interface Boarding extends PersonBoardingState {
  /** Seconds the whole move takes. */
  duration: number;
  /** World pose at the start (feet or hip point) and the standing spot, and the hip point. */
  from: Vec3;
  fromHeading: number;
  stand: Vec3;
  standHeading: number;
  hip: Vec3;
  hipHeading: number;
}

const BODY_UP: Vec3 = Object.freeze({ x: 0, y: 1, z: 0 });

/**
 * The walking session a car session carries (the walking plan, "Getting in
 * and out of the car"): the person and the car, exactly one of them driven.
 *
 * - DRIVING: the car is stepped from the player's car controls, as in a car
 *   session without walking; the person sits aboard and is not simulated.
 * - ON FOOT: the person is stepped from the person controls. The parked car
 *   is stepped with its handbrake on until it has been at rest for a second,
 *   then sleeps: it is no longer stepped, and its body is a static box in the
 *   session's `ColliderWorld` (`PARKED_CAR_COLLIDER_GROUP`) that the walker
 *   walks round. The box is removed before the car is stepped again.
 * - BOARDING: getting in or out, about two seconds; neither is stepped, and
 *   the person's pose moves from where it stood to the driver's door's
 *   standing spot, then to the driver's hip point (and back out).
 *
 * The interact press (`ControlState.interactPresses`, X) gets in within
 * `PERSON.doorReach` of a door with the car slower than
 * `PERSON.boardingCarSpeed`, and gets out of a stopped car by the driver's
 * door, or the left one if the right is blocked by a wall, a drop or water
 * deeper than `PERSON.doorBlockedWaterDepth`.
 */
export class WalkingSession {
  private drivenValue: "car" | "person";
  private boarding: Boarding | null = null;
  private asleep = false;
  private restClock = 0;
  private parkedBox = -1;
  private parkedState: FlightVisualState | null = null;
  private lastInteract: number | null = null;
  private pendingFootStart: boolean;
  private time = 0;
  private prompt: WalkingPrompt | null = null;
  private doors: [number, number] = [0, 0];
  private readonly parkedControls: CarControlState = { ...NEUTRAL_CAR_CONTROLS, handbrake: 1 };
  private readonly carControls: SurfaceVehicleControls = {
    assist: "scenic",
    boat: NEUTRAL_BOAT_CONTROLS,
    car: this.parkedControls,
  };
  private readonly ground: TerrainCollisionSample = {
    height: 0,
    normal: { x: 0, y: 1, z: 0 },
    isRunway: false,
    friction: 1,
  };
  private readonly water = createWaterSurfaceSample();
  private readonly contact = createColliderContact();
  private readonly scratch: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly probe: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly doorSpot: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    readonly car: WalkingCar,
    readonly person: PersonSimulator,
    start: WalkingStart,
    private readonly environment: SurfaceVehicleEnvironment,
  ) {
    this.drivenValue = start === "foot" ? "person" : "car";
    this.pendingFootStart = start === "foot";
  }

  get driven(): "car" | "person" {
    return this.drivenValue;
  }

  /** The driven one's pose: what the worker samples wind and hydrology round. */
  get focus(): Readonly<Vec3> {
    return this.drivenValue === "car" ? this.car.state.position : this.person.state.position;
  }

  /** The driven one has crashed (only the car can). */
  get crashed(): boolean {
    return this.drivenValue === "car" && this.car.state.crashed;
  }

  /**
   * One fixed step. The worker has prepared the shared environment (wind,
   * water time, hydrology focus) for `focus`. Returns true when the driven
   * one changed this step, so the worker posts a fresh start and the renderer
   * cuts rather than blending the car into the person.
   */
  step(dt: number, controls: Readonly<SurfaceVehicleControls>, interactPresses: number | undefined): boolean {
    this.time += dt;
    const interacted = this.lastInteract !== null
      && interactPresses !== undefined
      && interactPresses !== this.lastInteract;
    if (interactPresses !== undefined) this.lastInteract = interactPresses;
    const before = this.drivenValue;

    if (this.boarding) {
      this.advanceBoarding(dt);
    } else if (this.drivenValue === "car") {
      this.carControls.assist = controls.assist;
      this.carControls.boat = controls.boat;
      // Until the car profile's first message after getting in, the car
      // keeps the counts it had (a count that changed would be a press).
      this.carControls.car = controls.car ?? this.parkedControls;
      if (controls.car) this.copyCounters(controls.car);
      this.car.setControls(this.carControls);
      this.car.setEnvironment(this.environment);
      this.car.step(dt);
      this.updatePrompt();
      if (interacted && this.prompt?.ready) this.startGetOut();
    } else {
      this.stepParkedCar(dt, controls);
      if (this.pendingFootStart) {
        // Wait with the car for the terrain at the start, then stand by its door.
        if (!this.carSettling()) {
          this.pendingFootStart = false;
          const side = this.freeDoor() ?? "right";
          this.doorStandPoint(side, this.doorSpot);
          this.person.placeAt(this.doorSpot, this.carHeading());
        }
      } else {
        this.person.setControls(controls);
        this.person.setEnvironment(this.environment);
        this.person.step(dt);
      }
      this.updatePrompt();
      if (interacted && this.prompt?.ready) this.startGetIn();
    }
    this.updateDoors();
    return this.drivenValue !== before;
  }

  /** R: the driven one back on its newest safe spot. Nothing while boarding. */
  recover(): void {
    if (this.boarding) return;
    if (this.drivenValue === "car") this.car.recover?.();
    else if (!this.pendingFootStart) this.person.recover();
  }

  /** Releases the parked car's box from the collider world. */
  dispose(): void {
    this.wake();
  }

  visualState(terrainAuthority: FlightVisualState["terrainAuthority"]): FlightVisualState {
    const walking: WalkingVisualState = {
      driven: this.drivenValue,
      car: null,
      doors: [this.doors[0], this.doors[1]],
      prompt: this.prompt ? { ...this.prompt } : null,
    };
    let state: FlightVisualState;
    if (this.drivenValue === "car") {
      state = surfaceVisualState(this.car.snapshot(), terrainAuthority);
    } else {
      state = surfaceVisualState(this.person.snapshot(), terrainAuthority);
      if (this.boarding) this.applyBoardingPose(state);
      else if (this.pendingFootStart) this.applyFootStartPose(state);
      walking.car = this.asleep && this.parkedState
        ? this.parkedState
        : surfaceVisualState(this.car.snapshot(), undefined);
    }
    state.simulationTime = this.time;
    state.walking = walking;
    return state;
  }

  private stepParkedCar(dt: number, controls: Readonly<SurfaceVehicleControls>): void {
    if (this.asleep) return;
    this.carControls.assist = controls.assist;
    this.carControls.boat = controls.boat;
    this.carControls.car = this.parkedControls;
    this.car.setControls(this.carControls);
    this.car.setEnvironment(this.environment);
    this.car.step(dt);
    const state = this.car.state;
    const atRest = !this.carSettling()
      && Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z) < REST_SPEED
      && Math.hypot(state.angularVelocity.x, state.angularVelocity.y, state.angularVelocity.z) < REST_TURN_RATE;
    this.restClock = atRest ? this.restClock + dt : 0;
    if (this.restClock >= SLEEP_AFTER_SECONDS) this.sleep();
  }

  private sleep(): void {
    this.asleep = true;
    this.parkedState = surfaceVisualState(this.car.snapshot(), undefined);
    const colliders = this.environment.colliders;
    if (!colliders) return;
    const state = this.car.state;
    this.parkedBox = colliders.addStatic(CAR_SEATING.bodyBox, {
      material: PARKED_CAR_COLLIDER_MATERIAL,
      group: PARKED_CAR_COLLIDER_GROUP,
      position: state.position,
      orientation: state.orientation,
    });
  }

  private wake(): void {
    if (this.parkedBox >= 0) this.environment.colliders?.remove(this.parkedBox);
    this.parkedBox = -1;
    this.asleep = false;
    this.restClock = 0;
    this.parkedState = null;
  }

  /** The player's car toggles while driving, so the parked car keeps the same counts. */
  private copyCounters(from: CarControlState): void {
    const parked = this.parkedControls;
    parked.shiftUpPresses = from.shiftUpPresses;
    parked.shiftDownPresses = from.shiftDownPresses;
    parked.autoModePresses = from.autoModePresses;
    parked.rangePresses = from.rangePresses;
    parked.lockPresses = from.lockPresses;
    parked.downhillAssistPresses = from.downhillAssistPresses;
    parked.headlightPresses = from.headlightPresses;
    parked.tyrePressure = from.tyrePressure;
  }

  private carSettling(): boolean {
    return this.car.waitingForGround === true;
  }

  private carSpeed(): number {
    const velocity = this.car.state.velocity;
    return Math.hypot(velocity.x, velocity.z);
  }

  private carHeading(): number {
    return flightAnglesOf(this.car.state.orientation).heading;
  }

  private carRolled(): boolean {
    return this.car.isRolled === true;
  }

  /** A car body-frame point into the world. */
  private carPoint(forward: number, up: number, right: number, out: Vec3): Vec3 {
    out.x = forward;
    out.y = up;
    out.z = right;
    rotateVectorInto(out, this.car.state.orientation, out);
    out.x += this.car.state.position.x;
    out.y += this.car.state.position.y;
    out.z += this.car.state.position.z;
    return out;
  }

  /** The standing spot outside a front door, on the ground (feet point). */
  private doorStandPoint(side: CarDoorSide, out: Vec3): Vec3 {
    const stand = CAR_SEATING.doorStand;
    this.carPoint(stand.forward, 0, side === "right" ? stand.right : -stand.right, out);
    out.y = this.groundHeight(out.x, out.z);
    return out;
  }

  private groundHeight(x: number, z: number): number {
    const environment = this.environment;
    return environment.groundContact
      ? environment.groundContact(x, z, this.ground).height
      : environment.bedHeight(x, z);
  }

  /** Whether a door's standing spot is free of walls, drops and deep water. */
  private doorFree(side: CarDoorSide): boolean {
    const spot = this.doorStandPoint(side, this.scratch);
    // The car's footing: the ground under its centre of gravity at kerb ride.
    const footing = this.car.state.position.y - CAR_SEATING.cgAboveGround;
    if (Math.abs(spot.y - footing) > DOOR_MAX_STEP) return false;
    const water = this.environment.water.sample(spot.x, spot.z, this.water);
    if (water.kind !== "none" && water.height - spot.y > PERSON.doorBlockedWaterDepth) return false;
    const colliders = this.environment.colliders;
    if (colliders) {
      this.probe.x = spot.x;
      this.probe.y = spot.y + 0.9;
      this.probe.z = spot.z;
      if (colliders.deepestSphereContact(this.probe, PERSON.capsuleRadius, this.contact)
        && this.contact.material !== PARKED_CAR_COLLIDER_MATERIAL) return false;
    }
    return true;
  }

  private freeDoor(): CarDoorSide | null {
    if (this.doorFree("right")) return "right";
    if (this.doorFree("left")) return "left";
    return null;
  }

  private updatePrompt(): void {
    if (this.drivenValue === "car") {
      if (this.carSpeed() >= PERSON.boardingCarSpeed || this.carSettling()) {
        this.prompt = null;
        return;
      }
      const free = this.freeDoor() !== null;
      this.prompt = { action: "getOut", ready: free, reason: free ? null : "blocked" };
      return;
    }
    if (this.pendingFootStart) {
      this.prompt = null;
      return;
    }
    const nearest = this.nearestDoor();
    if (nearest.distance > PROMPT_DISTANCE) {
      this.prompt = null;
      return;
    }
    const moving = this.carSpeed() >= PERSON.boardingCarSpeed;
    const blocked = this.carRolled();
    const ready = !moving && !blocked && nearest.distance <= PERSON.doorReach && this.personCanBoard();
    // Too far, or mid-jump: the prompt shows, not yet ready, with no reason to give.
    this.prompt = { action: "getIn", ready, reason: moving ? "moving" : blocked ? "blocked" : null };
  }

  private nearestDoor(): { side: CarDoorSide; distance: number } {
    const position = this.person.state.position;
    const right = this.doorStandPoint("right", this.scratch);
    const rightDistance = Math.hypot(right.x - position.x, right.z - position.z);
    const left = this.doorStandPoint("left", this.scratch);
    const leftDistance = Math.hypot(left.x - position.x, left.z - position.z);
    return rightDistance <= leftDistance
      ? { side: "right", distance: rightDistance }
      : { side: "left", distance: leftDistance };
  }

  private personCanBoard(): boolean {
    const payload = this.person.snapshot().payload;
    if (payload.kind !== "person") return false;
    return payload.grounded
      && (payload.mode === "stand" || payload.mode === "walk" || payload.mode === "run" || payload.mode === "wade");
  }

  private startGetIn(): void {
    const side = this.nearestDoor().side;
    const person = this.person.state;
    const carHeading = this.carHeading();
    const stand = this.doorStandPoint(side, { x: 0, y: 0, z: 0 });
    this.boarding = {
      action: "getIn",
      progress: 0,
      side,
      duration: PERSON.getInSeconds,
      from: { ...person.position },
      fromHeading: flightAnglesOf(person.orientation).heading,
      stand,
      // Facing into the car. Headings grow turning left (D-6): the car's right is its heading less 90 degrees.
      standHeading: carHeading + (side === "right" ? Math.PI / 2 : -Math.PI / 2),
      hip: this.hipPoint({ x: 0, y: 0, z: 0 }),
      hipHeading: carHeading,
    };
  }

  private startGetOut(): void {
    const side = this.freeDoor();
    if (!side) return;
    const carHeading = this.carHeading();
    const hip = this.hipPoint({ x: 0, y: 0, z: 0 });
    this.boarding = {
      action: "getOut",
      progress: 0,
      side,
      duration: PERSON.getOutSeconds,
      from: hip,
      fromHeading: carHeading,
      stand: this.doorStandPoint(side, { x: 0, y: 0, z: 0 }),
      // Out of the door, turned away from the car.
      standHeading: carHeading + (side === "right" ? -Math.PI / 2 : Math.PI / 2),
      hip: { ...hip },
      hipHeading: carHeading,
    };
    this.drivenValue = "person";
    this.asleep = false;
    this.restClock = 0;
  }

  private hipPoint(out: Vec3): Vec3 {
    const hip = CAR_SEATING.driverHip;
    return this.carPoint(hip.forward, hip.up, hip.right, out);
  }

  private advanceBoarding(dt: number): void {
    const boarding = this.boarding!;
    boarding.progress = Math.min(1, boarding.progress + dt / boarding.duration);
    this.prompt = null;
    // The car under the door, held by its handbrake until it sleeps.
    this.carControls.car = this.parkedControls;
    this.stepParkedCar(dt, this.carControls);
    if (boarding.progress < 1) return;
    if (boarding.action === "getIn") {
      this.wake();
      this.drivenValue = "car";
    } else {
      this.person.placeAt(boarding.stand, boarding.standHeading);
    }
    this.boarding = null;
  }

  private updateDoors(): void {
    const boarding = this.boarding;
    if (!boarding) {
      this.doors[0] = 0;
      this.doors[1] = 0;
      return;
    }
    const p = boarding.progress;
    // The figure's hand times itself to these (the figure build's timing).
    const open = boarding.action === "getIn"
      ? Math.min(ramp(p, 0, 0.25), 1 - ramp(p, 0.8, 1))
      : Math.min(ramp(p, 0, 0.2), 1 - ramp(p, 0.75, 1));
    this.doors[0] = boarding.side === "right" ? open : 0;
    this.doors[1] = boarding.side === "left" ? open : 0;
  }

  /** The person's pose while boarding: to the standing spot, then into the seat (or the reverse). */
  private applyBoardingPose(state: FlightVisualState): void {
    const boarding = this.boarding!;
    const p = boarding.progress;
    const position = state.position;
    let heading: number;
    if (boarding.action === "getIn") {
      if (p < 0.25) {
        const t = smooth(p / 0.25);
        lerpInto(position, boarding.from, boarding.stand, t);
        heading = lerpHeading(boarding.fromHeading, boarding.standHeading, t);
      } else {
        // Facing into the car at the door, then forward in the seat.
        const t = smooth(clamp((p - 0.25) / 0.5, 0, 1));
        lerpInto(position, boarding.stand, boarding.hip, t);
        heading = lerpHeading(boarding.standHeading, boarding.hipHeading, t);
      }
    } else {
      const t = smooth(clamp((p - 0.2) / 0.5, 0, 1));
      lerpInto(position, boarding.hip, boarding.stand, t);
      heading = lerpHeading(boarding.hipHeading, boarding.standHeading, t);
    }
    state.velocity.x = 0;
    state.velocity.y = 0;
    state.velocity.z = 0;
    state.angularVelocity.y = 0;
    setYaw(state.orientation, heading);
    state.heading = (heading * 180) / Math.PI;
    state.airspeed = 0;
    state.altitude = position.y;
    const payload = state.vehicle as PersonVisualState;
    payload.mode = "board";
    payload.speed = 0;
    payload.boarding = { action: boarding.action, progress: p, side: boarding.side };
  }

  /** Before the terrain at a foot start answers: stand by the door at the car's footing. */
  private applyFootStartPose(state: FlightVisualState): void {
    const stand = CAR_SEATING.doorStand;
    this.carPoint(stand.forward, -CAR_SEATING.cgAboveGround, stand.right, state.position);
    const heading = this.carHeading();
    setYaw(state.orientation, heading);
    state.heading = (heading * 180) / Math.PI;
    state.altitude = state.position.y;
  }
}

function ramp(value: number, start: number, end: number): number {
  return smooth(clamp((value - start) / (end - start), 0, 1));
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerpInto(out: Vec3, a: Readonly<Vec3>, b: Readonly<Vec3>, t: number): void {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
}

function lerpHeading(a: number, b: number, t: number): number {
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + delta * t;
}

/** A yaw-only orientation for a heading (`FlightTelemetry.heading`): body +X along it. */
function setYaw(out: Quaternion, heading: number): void {
  const half = (heading - Math.PI / 2) * 0.5;
  out.x = BODY_UP.x * Math.sin(half);
  out.y = BODY_UP.y * Math.sin(half);
  out.z = BODY_UP.z * Math.sin(half);
  out.w = Math.cos(half);
}
