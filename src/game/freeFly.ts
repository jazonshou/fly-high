import type { FlightVisualState } from "./types";

/**
 * Beta terrain viewer: a Minecraft-creative-style free-fly rig.
 *
 * The controller owns its own DOM listeners (the flight `InputManager`'s
 * WASD/Space/Shift semantics are slew-rate-limited control surfaces — the
 * wrong shape for a translational fly-cam, and remapping them would leak
 * viewer behaviour into flight input). It produces a complete, finite
 * `FlightVisualState` every frame whose `position` IS the camera, so the
 * renderer's streaming observers, floating origin, and shading follow the
 * viewer through the exact seam the simulation already uses.
 */

export interface FreeFlyOptions {
  canvas: HTMLCanvasElement;
  /** Rendered-surface height for the ground clamp (consumer authority). */
  groundHeight: (x: number, z: number) => number;
  /** Pose and clock continuity with the scene being observed. */
  initialState: FlightVisualState;
}

const MIN_SPEED_METERS_PER_SECOND = 2;
const MAX_SPEED_METERS_PER_SECOND = 250;
const DEFAULT_SPEED_METERS_PER_SECOND = 28;
const SPRINT_MULTIPLIER = 3.5;
const MOUSE_LOOK_RADIANS_PER_PIXEL = 0.0022;
const VELOCITY_RESPONSE_PER_SECOND = 9;
const GROUND_CLEARANCE_METERS = 1.2;
const PITCH_LIMIT_RADIANS = 89 * Math.PI / 180;

const MOVEMENT_CODES = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "Space", "KeyC", "ControlLeft", "ControlRight",
]);

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON"
    || target.isContentEditable;
}

export class FreeFlyController {
  private readonly canvas: HTMLCanvasElement;
  private readonly groundHeight: (x: number, z: number) => number;
  private readonly pressed = new Set<string>();
  private yawRadians: number;
  private pitchRadians: number;
  private positionX: number;
  private positionY: number;
  private positionZ: number;
  private velocityX = 0;
  private velocityY = 0;
  private velocityZ = 0;
  private baseSpeed = DEFAULT_SPEED_METERS_PER_SECOND;
  private simulationTime: number;
  private lastUpdateMs: number | null = null;
  private disposed = false;
  private readonly state: FlightVisualState;

  constructor(options: FreeFlyOptions) {
    this.canvas = options.canvas;
    this.groundHeight = options.groundHeight;
    const initial = options.initialState;
    this.positionX = initial.position.x;
    this.positionY = initial.position.y;
    this.positionZ = initial.position.z;
    this.simulationTime = initial.simulationTime;
    // Derive the look direction from the observed pose so entering the viewer
    // does not snap the view: body forward is +X rotated by the orientation.
    const q = initial.orientation;
    const forwardX = 1 - 2 * (q.y * q.y + q.z * q.z);
    const forwardY = 2 * (q.x * q.y + q.w * q.z);
    const forwardZ = 2 * (q.x * q.z - q.w * q.y);
    this.yawRadians = Math.atan2(-forwardZ, forwardX);
    this.pitchRadians = Math.asin(Math.max(-1, Math.min(1, forwardY)));
    this.state = {
      ...initial,
      velocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      airspeed: 0,
      throttle: 0,
      engineRpm: 0,
      elevator: 0,
      aileron: 0,
      rudder: 0,
      brake: 0,
      trim: 0,
      flaps: 0,
      gear: 1,
      loadFactor: 1,
      angleOfAttack: 0,
      sideslip: 0,
      verticalSpeed: 0,
      onGround: false,
      stalled: false,
      crashed: false,
      touchdown: 0,
      position: { x: this.positionX, y: this.positionY, z: this.positionZ },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    };
    this.canvas.addEventListener("click", this.handleCanvasClick);
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    window.addEventListener("mousemove", this.handleMouseMove);
    window.addEventListener("wheel", this.handleWheel, { passive: false });
    window.addEventListener("blur", this.handleWindowBlur);
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  get speedMetersPerSecond(): number {
    return this.baseSpeed;
  }

  /** Advance the rig and return the frame's synthetic visual state. */
  update(nowMs: number): FlightVisualState {
    const deltaSeconds = this.lastUpdateMs === null
      ? 1 / 60
      : Math.max(1 / 240, Math.min(0.1, (nowMs - this.lastUpdateMs) / 1_000));
    this.lastUpdateMs = nowMs;
    this.simulationTime += deltaSeconds;

    const cosPitch = Math.cos(this.pitchRadians);
    const forwardX = Math.cos(this.yawRadians) * cosPitch;
    const forwardY = Math.sin(this.pitchRadians);
    const forwardZ = -Math.sin(this.yawRadians) * cosPitch;
    // Screen-right for a Y-up right-handed camera: forward × up, flattened.
    const rightX = -forwardZ;
    const rightZ = forwardX;
    const rightLength = Math.hypot(rightX, rightZ) || 1;

    let moveX = 0;
    let moveY = 0;
    let moveZ = 0;
    if (this.pressed.has("KeyW")) { moveX += forwardX; moveY += forwardY; moveZ += forwardZ; }
    if (this.pressed.has("KeyS")) { moveX -= forwardX; moveY -= forwardY; moveZ -= forwardZ; }
    if (this.pressed.has("KeyD")) { moveX += rightX / rightLength; moveZ += rightZ / rightLength; }
    if (this.pressed.has("KeyA")) { moveX -= rightX / rightLength; moveZ -= rightZ / rightLength; }
    if (this.pressed.has("Space")) moveY += 1;
    if (this.pressed.has("KeyC") || this.pressed.has("ControlLeft") || this.pressed.has("ControlRight")) {
      moveY -= 1;
    }
    const moveLength = Math.hypot(moveX, moveY, moveZ);
    const sprint = this.pressed.has("ShiftLeft") || this.pressed.has("ShiftRight")
      ? SPRINT_MULTIPLIER
      : 1;
    const speed = this.baseSpeed * sprint;
    const targetX = moveLength > 0 ? (moveX / moveLength) * speed : 0;
    const targetY = moveLength > 0 ? (moveY / moveLength) * speed : 0;
    const targetZ = moveLength > 0 ? (moveZ / moveLength) * speed : 0;
    const response = 1 - Math.exp(-deltaSeconds * VELOCITY_RESPONSE_PER_SECOND);
    this.velocityX += (targetX - this.velocityX) * response;
    this.velocityY += (targetY - this.velocityY) * response;
    this.velocityZ += (targetZ - this.velocityZ) * response;

    this.positionX += this.velocityX * deltaSeconds;
    this.positionY += this.velocityY * deltaSeconds;
    this.positionZ += this.velocityZ * deltaSeconds;

    const ground = this.groundHeight(this.positionX, this.positionZ);
    if (Number.isFinite(ground) && this.positionY < ground + GROUND_CLEARANCE_METERS) {
      this.positionY = ground + GROUND_CLEARANCE_METERS;
      if (this.velocityY < 0) this.velocityY = 0;
    }

    // Orientation whose body +X is the look direction: yaw about +Y composed
    // with pitch about body +Z (q = qYaw ⊗ qPitch).
    const halfYaw = this.yawRadians * 0.5;
    const halfPitch = this.pitchRadians * 0.5;
    const sy = Math.sin(halfYaw);
    const cy = Math.cos(halfYaw);
    const sp = Math.sin(halfPitch);
    const cp = Math.cos(halfPitch);
    const state = this.state;
    state.orientation.x = sy * sp;
    state.orientation.y = sy * cp;
    state.orientation.z = cy * sp;
    state.orientation.w = cy * cp;
    state.position.x = this.positionX;
    state.position.y = this.positionY;
    state.position.z = this.positionZ;
    state.velocity.x = this.velocityX;
    state.velocity.y = this.velocityY;
    state.velocity.z = this.velocityZ;
    state.airspeed = Math.hypot(this.velocityX, this.velocityY, this.velocityZ);
    state.verticalSpeed = this.velocityY;
    state.altitude = this.positionY;
    state.altitudeAgl = Number.isFinite(ground)
      ? Math.max(0, this.positionY - ground)
      : this.positionY;
    state.heading = (Math.atan2(forwardX, forwardZ) * 180 / Math.PI + 360) % 360;
    state.pitch = this.pitchRadians * 180 / Math.PI;
    state.bank = 0;
    state.simulationTime = this.simulationTime;
    return state;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener("click", this.handleCanvasClick);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    window.removeEventListener("mousemove", this.handleMouseMove);
    window.removeEventListener("wheel", this.handleWheel);
    window.removeEventListener("blur", this.handleWindowBlur);
    this.pressed.clear();
    if (this.pointerLocked) document.exitPointerLock();
  }

  private readonly handleCanvasClick = (): void => {
    if (this.disposed || this.pointerLocked) return;
    void this.canvas.requestPointerLock();
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (this.disposed || isInteractiveTarget(event.target)) return;
    if (MOVEMENT_CODES.has(event.code) || event.code.startsWith("Shift")) {
      this.pressed.add(event.code);
      event.preventDefault();
    }
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if (this.disposed || !this.pointerLocked) return;
    this.yawRadians -= event.movementX * MOUSE_LOOK_RADIANS_PER_PIXEL;
    this.pitchRadians = Math.max(
      -PITCH_LIMIT_RADIANS,
      Math.min(PITCH_LIMIT_RADIANS, this.pitchRadians - event.movementY * MOUSE_LOOK_RADIANS_PER_PIXEL),
    );
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (this.disposed || !this.pointerLocked) return;
    event.preventDefault();
    this.baseSpeed = Math.max(
      MIN_SPEED_METERS_PER_SECOND,
      Math.min(MAX_SPEED_METERS_PER_SECOND, this.baseSpeed * Math.exp(-event.deltaY * 0.0011)),
    );
  };

  private readonly handleWindowBlur = (): void => {
    this.pressed.clear();
  };
}
