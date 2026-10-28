import type {
  BoatControlState,
  CarControlState,
  CarTyrePressure,
  ControlState,
  PersonControlState,
} from "@/src/game/types";
import { isCarSpawn, type SpawnKind } from "@/src/workers/protocol";

export type InputAction =
  | "pause"
  | "camera"
  | "reset"
  | "hud"
  | "flapsUp"
  | "flapsDown"
  | "gearToggle"
  | "trimUp"
  | "trimDown"
  | "nearestAirport"
  | "autoland"
  | "moor";

export interface InputOptions {
  sensitivity: number;
  deadZone: number;
  invertPitch: boolean;
  mouseFlight: boolean;
}

export function applyDeadZone(value: number, deadZone: number): number {
  const magnitude = Math.abs(value);
  if (magnitude <= deadZone) return 0;
  return Math.sign(value) * Math.min(1, (magnitude - deadZone) / Math.max(1 - deadZone, 0.001));
}

export function responseCurve(value: number, sensitivity: number): number {
  const exponent = 1.65 - Math.min(2, Math.max(0.35, sensitivity)) * 0.55;
  return Math.sign(value) * Math.pow(Math.abs(value), exponent);
}

export function smoothAxis(current: number, target: number, rate: number, deltaSeconds: number): number {
  const alpha = 1 - Math.exp(-Math.max(0, rate) * Math.max(0, deltaSeconds));
  return current + (target - current) * alpha;
}

/**
 * Standard pilot signs, shared by held-key and tap handling: D banks right
 * and sends the positive simulator roll command, A banks left and sends the
 * negative one. The historical inversion this boundary carried (A -> +1) was
 * a workaround for the body-axis mirror settled by D-6 on 2026-09-01 — the
 * sim declared body +Z as port while the rendered mesh's starboard is +Z, so
 * every positive lateral command displayed mirrored. The sim's basis now
 * matches the renderer (+Z = starboard) and no compensation exists anywhere
 * on the roll path.
 */
export function keyboardRollDirection(code: string): -1 | 0 | 1 {
  if (code === "KeyA") return -1;
  if (code === "KeyD") return 1;
  return 0;
}

export function keyboardRollCommand(pressed: ReadonlySet<string>): -1 | 0 | 1 {
  const direction =
    keyboardRollDirection(pressed.has("KeyA") ? "KeyA" : "") +
    keyboardRollDirection(pressed.has("KeyD") ? "KeyD" : "");
  return direction < 0 ? -1 : direction > 0 ? 1 : 0;
}

/** Conventional game-style throttle pair: Shift adds power, Ctrl removes it. */
export function keyboardThrottleDirection(pressed: ReadonlySet<string>): -1 | 0 | 1 {
  const increase = pressed.has("ShiftLeft") || pressed.has("ShiftRight");
  const decrease = pressed.has("ControlLeft") || pressed.has("ControlRight");
  return increase === decrease ? 0 : increase ? 1 : -1;
}

export function keyboardBrakeCommand(pressed: ReadonlySet<string>): 0 | 1 {
  return pressed.has("Space") ? 1 : 0;
}

export function toggledGearPosition(current: number): 0 | 1 {
  return current >= 0.5 ? 0 : 1;
}

/**
 * Rate-limited axis motion for digital controls.  A keyboard key is a button,
 * but a flight control is not: moving progressively toward the requested
 * deflection makes short taps useful while retaining full authority when held.
 */
export function slewAxis(
  current: number,
  target: number,
  engageRate: number,
  releaseRate: number,
  deltaSeconds: number,
): number {
  const returningToCenter = Math.abs(target) < 0.001;
  const reversing = current * target < 0;
  const rate = returningToCenter || reversing ? releaseRate : engageRate;
  const maximumStep = Math.max(0, rate) * Math.max(0, deltaSeconds);
  const difference = target - current;
  if (Math.abs(difference) <= maximumStep) return target;
  return current + Math.sign(difference) * maximumStep;
}

const ACTION_KEYS: Partial<Record<string, InputAction>> = {
  Escape: "pause",
  KeyP: "pause",
  KeyC: "camera",
  KeyR: "reset",
  KeyH: "hud",
  KeyF: "flapsDown",
  KeyV: "flapsUp",
  KeyG: "gearToggle",
  KeyN: "nearestAirport",
  KeyL: "autoland",
  KeyM: "moor",
  ArrowUp: "trimUp",
  ArrowDown: "trimDown",
};

const HELD_CONTROL_KEYS = new Set([
  "KeyW", "KeyS", "KeyA", "KeyD", "KeyQ", "KeyE",
  "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
  "Space", "KeyF", "KeyV", "KeyX",
]);

/**
 * Which set of controls the keys and pad drive. A dock start drives a boat,
 * an airfield start the car; in a car session the walking session switches
 * between `"car"` and `"person"` as the walker gets in and out
 * (`InputManager.setWalkingProfile`).
 */
export type InputProfile = "aircraft" | "boat" | "car" | "person";

export function inputProfileForSpawn(spawn: SpawnKind): InputProfile {
  if (spawn === "dock") return "boat";
  if (spawn === "foot") return "person";
  return isCarSpawn(spawn) ? "car" : "aircraft";
}

/** Aircraft and boat actions with no meaning on foot: their keys are the walker's or free. */
const PERSON_REBOUND_ACTIONS: ReadonlySet<InputAction> = new Set([
  "autoland", "moor", "flapsUp", "flapsDown", "gearToggle", "trimUp", "trimDown",
]);

/** Getting out of the car takes X (or pad Y) HELD this long, so a stray tap never throws you out. */
export const GET_OUT_HOLD_SECONDS = 0.4;
/** Mouse look, radians per pixel moved with the pointer locked. */
const MOUSE_LOOK_RADIANS_PER_PIXEL = 0.0024;
/** Right-stick look at full deflection, rad/s: turning, and looking up and down. */
const STICK_LOOK_YAW_RATE = 2.6;
const STICK_LOOK_PITCH_RATE = 1.8;

/** Look and zoom gathered since the camera last read them (`InputManager.consumeLook`). */
export interface LookDelta {
  /** Radians, positive turning the view right. */
  yaw: number;
  /** Radians, positive looking up. */
  pitch: number;
  /** Wheel notches, positive pulling the camera out. */
  zoom: number;
}

/**
 * The walker's move from the keys or stick, turned into world axes by the
 * camera's heading (`FlightTelemetry.heading`: headings grow turning left,
 * so the view's right is its heading less 90 degrees). `forward` and `right`
 * are -1..1; the result's length never exceeds 1.
 */
export function personMoveFromView(forward: number, right: number, cameraHeading: number): { x: number; z: number } {
  let f = forward;
  let r = right;
  const length = Math.hypot(f, r);
  if (length > 1) {
    f /= length;
    r /= length;
  }
  const sine = Math.sin(cameraHeading);
  const cosine = Math.cos(cameraHeading);
  return { x: f * sine - r * cosine, z: f * cosine + r * sine };
}

/** The car's toggles: each key press is one count on its `CarControlState` counter. */
export const CAR_PRESS_KEYS: Readonly<Record<string, CarPressCounter>> = Object.freeze({
  ShiftLeft: "shiftUpPresses",
  ShiftRight: "shiftUpPresses",
  ControlLeft: "shiftDownPresses",
  ControlRight: "shiftDownPresses",
  KeyM: "autoModePresses",
  KeyT: "rangePresses",
  KeyK: "lockPresses",
  KeyB: "downhillAssistPresses",
  KeyL: "headlightPresses",
});

export type CarPressCounter = {
  [K in keyof CarControlState]: CarControlState[K] extends number
    ? K extends `${string}Presses` ? K : never
    : never;
}[keyof CarControlState];

/** In the car, L and M are the headlights and the automatic's D: neither autolands nor moors. */
const CAR_REBOUND_ACTIONS: ReadonlySet<InputAction> = new Set(["autoland", "moor"]);

/**
 * The car's standard-pad buttons that count presses: the bumpers shift, and
 * the D-pad works what T, K, B and L do (the land plan's controls table).
 */
export const CAR_PAD_PRESSES: Readonly<Record<CarPadButton, CarPressCounter>> = Object.freeze({
  bumperRight: "shiftUpPresses",
  bumperLeft: "shiftDownPresses",
  dpadUp: "rangePresses",
  dpadRight: "lockPresses",
  dpadDown: "downhillAssistPresses",
  dpadLeft: "headlightPresses",
});

export type CarPadButton = "bumperRight" | "bumperLeft" | "dpadUp" | "dpadRight" | "dpadDown" | "dpadLeft";

const CAR_PAD_BUTTONS = Object.keys(CAR_PAD_PRESSES) as CarPadButton[];

/** The car's wheel from A/D at a crawl: lock to lock in about 0.7 s, and back to centre a little faster. */
const CAR_STEER_RATE = 2.8;
const CAR_STEER_RETURN_RATE = 3.4;
/**
 * Road speed at which A/D wind the wheel at half their crawl rate, m/s
 * (36 km/h). A key is all or nothing, so at speed the wheel must move slowly
 * for a tap to be a lane change rather than a swerve. The sim still limits
 * the lock a full key reaches at speed (L1's `steering` record): this eases
 * only how fast the command gets there.
 */
const CAR_STEER_HALF_RATE_SPEED = 10;
/** The slowest the keyboard wheel gets: lock to lock in about 1.8 s, from about 55 km/h up. */
const CAR_STEER_SLOWEST_SCALE = 0.4;

/**
 * How fast A/D turn the car's wheel at this road speed, as a share of the
 * crawl rate: 1 standing, 1/2 at 36 km/h, never under 0.4. The return to
 * centre keeps its full rate, as a real wheel's caster pulls it back harder
 * the faster the car goes.
 */
export function carSteerRateScale(speedMetersPerSecond: number): number {
  const speed = Number.isFinite(speedMetersPerSecond) ? Math.abs(speedMetersPerSecond) : 0;
  return Math.max(CAR_STEER_SLOWEST_SCALE, 1 / (1 + speed / CAR_STEER_HALF_RATE_SPEED));
}
/** Pedals from keys: a key is a button, a pedal is not; full travel in about a fifth of a second. */
const CAR_PEDAL_RATE = 5;
/** The clutch from Q: down in a quarter second, let up over about half a second. */
const CAR_CLUTCH_DOWN_RATE = 4;
const CAR_CLUTCH_UP_RATE = 2.2;

function neutralCarPad(): Record<CarPadButton, boolean> {
  return { bumperRight: false, bumperLeft: false, dpadUp: false, dpadRight: false, dpadDown: false, dpadLeft: false };
}

function neutralCarPresses(): Record<CarPressCounter, number> {
  return {
    shiftUpPresses: 0,
    shiftDownPresses: 0,
    autoModePresses: 0,
    rangePresses: 0,
    lockPresses: 0,
    downhillAssistPresses: 0,
    headlightPresses: 0,
  };
}

/** Lever travel per second while Shift/Ctrl or a trigger is held: neutral to full ahead in 1.7 s. */
const BOAT_LEVER_RATE = 0.6;
const BOAT_STEER_RATE = 1.2;
/** The wheel drifts back to centre when let go, slower than it is turned. */
const BOAT_STEER_RETURN_RATE = 0.8;

/**
 * One step of the boat's single-lever binnacle control. Moving through
 * neutral stops AT neutral, the detent a real lever has, and stays there
 * until the control is released and pushed again: holding Ctrl to slow down
 * must not carry on into reverse.
 */
export function stepBoatLever(
  lever: number,
  direction: number,
  detentHeld: boolean,
  deltaSeconds: number,
): { lever: number; detentHeld: boolean } {
  if (direction === 0) return { lever, detentHeld: false };
  if (detentHeld) return { lever: 0, detentHeld: true };
  const next = Math.min(1, Math.max(-1, lever + direction * BOAT_LEVER_RATE * Math.max(0, deltaSeconds)));
  if (lever !== 0 && (next === 0 || Math.sign(next) !== Math.sign(lever))) {
    return { lever: 0, detentHeld: true };
  }
  return { lever: next, detentHeld: false };
}

const INTERACTIVE_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "a[href]",
  "area[href]",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
].join(",");

interface InteractiveTargetLike {
  tagName?: unknown;
  isContentEditable?: unknown;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}

/**
 * Flight keys must not steal native keyboard activation from focused controls.
 * This is structural rather than instanceof-based so it also behaves in
 * alternate realms (embedded documents) and is directly unit-testable.
 */
export function isFlightShortcutTargetInteractive(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const candidate = target as InteractiveTargetLike;
  const tagName = typeof candidate.tagName === "string"
    ? candidate.tagName.toUpperCase()
    : "";
  if (["BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(tagName)) return true;
  if (
    (tagName === "A" || tagName === "AREA") &&
    candidate.getAttribute?.("href") != null
  ) return true;
  if (candidate.isContentEditable === true) return true;
  const role = candidate.getAttribute?.("role")?.toLowerCase() ?? "";
  if (
    [
      "button",
      "link",
      "textbox",
      "combobox",
      "slider",
      "spinbutton",
      "switch",
      "checkbox",
      "radio",
    ].includes(role)
  ) return true;
  return typeof candidate.closest === "function" &&
    candidate.closest(INTERACTIVE_SELECTOR) != null;
}

export class InputManager {
  private readonly pressed = new Set<string>();
  private readonly actions = new Set<InputAction>();
  private options: InputOptions;
  private roll = 0;
  private pitch = 0;
  private yaw = 0;
  private throttle = 0.68;
  private trim = 0;
  private flaps = 0;
  private gear = 1;
  private mouseRoll = 0;
  private mousePitch = 0;
  private rollTapDirection = 0;
  private pitchTapDirection = 0;
  private yawTapDirection = 0;
  private rollTapRemaining = 0;
  private pitchTapRemaining = 0;
  private yawTapRemaining = 0;
  private pointerLocked = false;
  private disposed = false;
  private profile: InputProfile = "aircraft";
  private boatLever = 0;
  private boatLeverDetent = false;
  private boatSteer = 0;
  private moorPresses = 0;
  private padMoorWasDown = false;
  private carAccelerator = 0;
  private carBrake = 0;
  private carSteer = 0;
  private carClutch = 0;
  private carPresses = neutralCarPresses();
  private carTyrePressure: CarTyrePressure = "road";
  private carSpeed = 0;
  private carPadWasDown = neutralCarPad();
  private interactPresses = 0;
  private interactHeld = 0;
  private interactFired = false;
  private padInteractWasDown = false;
  private jumpPresses = 0;
  private padJumpWasDown = false;
  private cameraHeading = 0;
  private cameraPitch = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private lookZoom = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: InputOptions,
  ) {
    this.options = options;
    window.addEventListener("keydown", this.handleKeyDown, { passive: false });
    window.addEventListener("keyup", this.handleKeyUp, { passive: false });
    window.addEventListener("blur", this.handleBlur);
    window.addEventListener("mousemove", this.handleMouseMove);
    document.addEventListener("pointerlockchange", this.handlePointerLockChange);
    canvas.addEventListener("click", this.handleCanvasClick);
    canvas.addEventListener("wheel", this.handleWheel, { passive: false });
  }

  updateOptions(options: InputOptions): void {
    this.options = options;
    if (!options.mouseFlight && document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  getControls(deltaSeconds: number): ControlState {
    const heldRoll = keyboardRollCommand(this.pressed);
    const heldPitch = (this.pressed.has("KeyW") ? -1 : 0) + (this.pressed.has("KeyS") ? 1 : 0);
    const heldYaw = (this.pressed.has("KeyE") ? 1 : 0) - (this.pressed.has("KeyQ") ? 1 : 0);
    const keyboardRoll = heldRoll || (this.rollTapRemaining > 0 ? this.rollTapDirection : 0);
    const keyboardPitch = heldPitch || (this.pitchTapRemaining > 0 ? this.pitchTapDirection : 0);
    const keyboardYaw = heldYaw || (this.yawTapRemaining > 0 ? this.yawTapDirection : 0);
    this.rollTapRemaining = Math.max(0, this.rollTapRemaining - deltaSeconds);
    this.pitchTapRemaining = Math.max(0, this.pitchTapRemaining - deltaSeconds);
    this.yawTapRemaining = Math.max(0, this.yawTapRemaining - deltaSeconds);

    const gamepad = this.readGamepad();
    const mouseActive = this.options.mouseFlight && this.pointerLocked;
    const sensitivityScale = 0.55 + Math.min(2, Math.max(0.35, this.options.sensitivity)) * 0.45;

    // Analog sources already carry magnitude, so retain it and just remove
    // sampling noise. Digital sources use a bounded slew rate, giving taps a
    // small, predictable response instead of an almost instantaneous full throw.
    if (Math.abs(gamepad.roll) > 0.01) {
      this.roll = smoothAxis(this.roll, gamepad.roll, 11 * sensitivityScale, deltaSeconds);
    } else if (keyboardRoll !== 0 || !mouseActive) {
      this.roll = slewAxis(this.roll, keyboardRoll, 2.15 * sensitivityScale, 3.4, deltaSeconds);
    } else {
      this.roll = smoothAxis(this.roll, this.mouseRoll, 8 * sensitivityScale, deltaSeconds);
    }

    const pitchDirection = this.options.invertPitch ? -1 : 1;
    if (Math.abs(gamepad.pitch) > 0.01) {
      this.pitch = smoothAxis(
        this.pitch,
        gamepad.pitch * pitchDirection,
        10 * sensitivityScale,
        deltaSeconds,
      );
    } else if (keyboardPitch !== 0 || !mouseActive) {
      this.pitch = slewAxis(
        this.pitch,
        keyboardPitch,
        1.7 * sensitivityScale,
        2.8,
        deltaSeconds,
      );
    } else {
      this.pitch = smoothAxis(
        this.pitch,
        this.mousePitch * pitchDirection,
        7.5 * sensitivityScale,
        deltaSeconds,
      );
    }

    if (Math.abs(gamepad.yaw) > 0.01) {
      this.yaw = smoothAxis(this.yaw, gamepad.yaw, 9 * sensitivityScale, deltaSeconds);
    } else {
      this.yaw = slewAxis(this.yaw, keyboardYaw, 1.55 * sensitivityScale, 2.5, deltaSeconds);
    }

    const throttleDirection = keyboardThrottleDirection(this.pressed) + gamepad.throttleStep;
    if (gamepad.throttle !== null) this.throttle = smoothAxis(this.throttle, gamepad.throttle, 4, deltaSeconds);
    else this.throttle = Math.min(1, Math.max(0, this.throttle + throttleDirection * deltaSeconds * 0.6));

    const controls: ControlState = {
      pitch: Math.min(1, Math.max(-1, this.pitch)),
      roll: Math.min(1, Math.max(-1, this.roll)),
      yaw: Math.min(1, Math.max(-1, this.yaw)),
      throttle: this.throttle,
      trim: this.trim,
      flaps: this.flaps,
      brake: Math.max(keyboardBrakeCommand(this.pressed), gamepad.brake),
      gear: this.gear,
    };
    if (this.profile === "boat") controls.boat = this.boatControls(deltaSeconds, gamepad);
    if (this.profile === "car") controls.car = this.carControls(deltaSeconds, gamepad);
    if (this.profile === "person") controls.person = this.personControls(deltaSeconds, gamepad);
    if (this.profile === "car" || this.profile === "person") {
      this.updateInteract(deltaSeconds, gamepad.buttonY);
      controls.interactPresses = this.interactPresses;
    }
    return controls;
  }

  /**
   * In a car session, switch between driving and walking as the walking
   * session says, without a reset: the car's press counts and the interact
   * count carry on (a count that changed would be a press), and so does any
   * key still held.
   */
  setWalkingProfile(profile: "car" | "person"): void {
    if (this.profile === profile || (this.profile !== "car" && this.profile !== "person")) return;
    this.profile = profile;
    this.carAccelerator = 0;
    this.carBrake = 0;
    this.carSteer = 0;
    this.carClutch = 0;
    // A held X that got you out does not count again on foot until released.
    this.interactFired = this.pressed.has("KeyX");
    this.padInteractWasDown = true;
    this.padJumpWasDown = true;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.lookZoom = 0;
    if (profile === "car" && !this.options.mouseFlight && document.pointerLockElement === this.canvas) {
      document.exitPointerLock();
    }
  }

  /**
   * The character camera's heading (`FlightTelemetry.heading`, radians) and
   * pitch (positive up), set by the renderer every frame: the walker moves
   * relative to the first and swims where the second points.
   */
  setCharacterView(heading: number, pitch: number): void {
    if (Number.isFinite(heading)) this.cameraHeading = heading;
    if (Number.isFinite(pitch)) this.cameraPitch = pitch;
  }

  /** The mouse, right-stick and wheel look gathered since the last call, then cleared. */
  consumeLook(out: LookDelta = { yaw: 0, pitch: 0, zoom: 0 }): LookDelta {
    out.yaw = this.lookYaw;
    out.pitch = this.lookPitch;
    out.zoom = this.lookZoom;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.lookZoom = 0;
    return out;
  }

  get inputProfile(): InputProfile {
    return this.profile;
  }

  /**
   * The boat's helm, from the same keys and pad (see the plan's controls
   * table): Shift/Ctrl or the triggers move the lever, A/D (Q/E too) or the
   * left stick turn the wheel, S/W or the right stick work the power trim
   * (S trims out, bow up, as pulling back raises a nose), F/V or the
   * bumpers work the tabs (F lowers them, bow down, as flaps go down), Space
   * or B brings the lever to neutral, M or Y moors and casts off.
   */
  private boatControls(deltaSeconds: number, gamepad: ReturnType<InputManager["readGamepad"]>): BoatControlState {
    const leverDirection = Math.min(1, Math.max(-1, keyboardThrottleDirection(this.pressed) + gamepad.triggers));
    const lever = stepBoatLever(this.boatLever, leverDirection, this.boatLeverDetent, deltaSeconds);
    this.boatLever = lever.lever;
    this.boatLeverDetent = lever.detentHeld;
    if (this.pressed.has("Space") || gamepad.buttonB) {
      this.boatLever = 0;
      this.boatLeverDetent = leverDirection !== 0;
    }

    const keySteer = Math.min(1, Math.max(-1,
      keyboardRollCommand(this.pressed) + (this.pressed.has("KeyE") ? 1 : 0) - (this.pressed.has("KeyQ") ? 1 : 0),
    ));
    if (Math.abs(gamepad.roll) > 0.01) {
      this.boatSteer = smoothAxis(this.boatSteer, gamepad.roll, 8, deltaSeconds);
    } else {
      this.boatSteer = slewAxis(this.boatSteer, keySteer, BOAT_STEER_RATE, BOAT_STEER_RETURN_RATE, deltaSeconds);
    }

    const keyTrim = (this.pressed.has("KeyS") ? 1 : 0) - (this.pressed.has("KeyW") ? 1 : 0);
    const keyTabs = (this.pressed.has("KeyF") ? 1 : 0) - (this.pressed.has("KeyV") ? 1 : 0);
    if (gamepad.buttonY && !this.padMoorWasDown) this.moorPresses += 1;
    this.padMoorWasDown = gamepad.buttonY;
    return {
      lever: this.boatLever,
      steer: Math.min(1, Math.max(-1, this.boatSteer)),
      trim: Math.min(1, Math.max(-1, keyTrim + gamepad.rightStickY)),
      tabs: Math.min(1, Math.max(-1, keyTabs + gamepad.bumpers)),
      moorPresses: this.moorPresses,
    };
  }

  /**
   * The car's pedals and wheel, from the same keys and pad (the land plan's
   * controls table): W or the right trigger is the accelerator, S or the
   * left trigger the brake (the sim reverses on a held S at a stop), A/D or
   * the left stick steer, Space or A the handbrake, Q or X the clutch, and
   * Shift/Ctrl or the bumpers shift up and down. M, T, K, B and L are counted
   * presses (`CAR_PRESS_KEYS`), and the D-pad counts T, K, B and L's
   * (`CAR_PAD_PRESSES`). A/D wind the wheel more slowly the faster the car
   * goes (`carSteerRateScale`); the stick is a position and is not eased.
   */
  private carControls(deltaSeconds: number, gamepad: ReturnType<InputManager["readGamepad"]>): CarControlState {
    const keyAccelerator = this.pressed.has("KeyW") ? 1 : 0;
    const keyBrake = this.pressed.has("KeyS") ? 1 : 0;
    this.carAccelerator = gamepad.rightTrigger > 0.01
      ? gamepad.rightTrigger
      : slewAxis(this.carAccelerator, keyAccelerator, CAR_PEDAL_RATE, CAR_PEDAL_RATE, deltaSeconds);
    this.carBrake = gamepad.leftTrigger > 0.01
      ? gamepad.leftTrigger
      : slewAxis(this.carBrake, keyBrake, CAR_PEDAL_RATE, CAR_PEDAL_RATE, deltaSeconds);

    if (Math.abs(gamepad.roll) > 0.01) {
      this.carSteer = smoothAxis(this.carSteer, gamepad.roll, 10, deltaSeconds);
    } else {
      const engageRate = CAR_STEER_RATE * carSteerRateScale(this.carSpeed);
      this.carSteer = slewAxis(this.carSteer, keyboardRollCommand(this.pressed), engageRate, CAR_STEER_RETURN_RATE, deltaSeconds);
    }
    const clutchDown = this.pressed.has("KeyQ") || gamepad.buttonX;
    this.carClutch = slewAxis(this.carClutch, clutchDown ? 1 : 0, CAR_CLUTCH_DOWN_RATE, CAR_CLUTCH_UP_RATE, deltaSeconds);

    for (const button of CAR_PAD_BUTTONS) {
      if (gamepad[button] && !this.carPadWasDown[button]) this.carPresses[CAR_PAD_PRESSES[button]] += 1;
      this.carPadWasDown[button] = gamepad[button];
    }
    return {
      accelerator: Math.min(1, Math.max(0, this.carAccelerator)),
      brake: Math.min(1, Math.max(0, this.carBrake)),
      steer: Math.min(1, Math.max(-1, this.carSteer)),
      handbrake: this.pressed.has("Space") || gamepad.buttonA ? 1 : 0,
      clutch: Math.min(1, Math.max(0, this.carClutch)),
      ...this.carPresses,
      tyrePressure: this.carTyrePressure,
    };
  }

  /**
   * The walker's controls (the walking plan's controls table): W A S D or
   * the left stick move relative to the camera, Shift or the right trigger
   * runs (or swims the faster stroke), Space or A jumps and rises in the
   * water, Ctrl or B dives. The mouse (pointer locked) and the right stick
   * look, gathered for the camera in `consumeLook`.
   */
  private personControls(deltaSeconds: number, gamepad: ReturnType<InputManager["readGamepad"]>): PersonControlState {
    let forward = (this.pressed.has("KeyW") ? 1 : 0) - (this.pressed.has("KeyS") ? 1 : 0);
    let right = (this.pressed.has("KeyD") ? 1 : 0) - (this.pressed.has("KeyA") ? 1 : 0);
    if (Math.abs(gamepad.roll) > 0.01 || Math.abs(gamepad.pitch) > 0.01) {
      forward = -gamepad.pitch;
      right = gamepad.roll;
    }
    const move = personMoveFromView(forward, right, this.cameraHeading);
    if (gamepad.buttonA && !this.padJumpWasDown) this.jumpPresses += 1;
    this.padJumpWasDown = gamepad.buttonA;
    const pitchDirection = this.options.invertPitch ? -1 : 1;
    this.lookYaw += gamepad.yaw * STICK_LOOK_YAW_RATE * deltaSeconds;
    this.lookPitch -= gamepad.rightStickY * pitchDirection * STICK_LOOK_PITCH_RATE * deltaSeconds;
    return {
      moveX: move.x,
      moveZ: move.z,
      lookHeading: this.cameraHeading,
      lookPitch: this.cameraPitch,
      run: this.pressed.has("ShiftLeft") || this.pressed.has("ShiftRight") || gamepad.rightTrigger > 0.5,
      rise: this.pressed.has("Space") || gamepad.buttonA,
      dive: this.pressed.has("ControlLeft") || this.pressed.has("ControlRight") || gamepad.buttonB,
      jumpPresses: this.jumpPresses,
    };
  }

  /** X or pad Y: a press on foot; in the car, one count only once held `GET_OUT_HOLD_SECONDS`. */
  private updateInteract(deltaSeconds: number, padDown: boolean): void {
    const held = this.pressed.has("KeyX") || padDown;
    if (this.profile === "person") {
      if (padDown && !this.padInteractWasDown) this.interactPresses += 1;
      this.padInteractWasDown = padDown;
      if (!held) this.interactFired = false;
      return;
    }
    this.padInteractWasDown = padDown;
    if (!held) {
      this.interactHeld = 0;
      this.interactFired = false;
      return;
    }
    this.interactHeld += deltaSeconds;
    if (!this.interactFired && this.interactHeld >= GET_OUT_HOLD_SECONDS) {
      this.interactFired = true;
      this.interactPresses += 1;
    }
  }

  /** The tyre pressure preset the pause menu's vehicle panel asks for; the sim inflates only while stopped. */
  setCarTyrePressure(pressure: CarTyrePressure): void {
    this.carTyrePressure = pressure;
  }

  /** The car's road speed from the latest snapshot, m/s, which eases the keyboard wheel. */
  setCarSpeed(speedMetersPerSecond: number): void {
    this.carSpeed = Number.isFinite(speedMetersPerSecond) ? Math.abs(speedMetersPerSecond) : 0;
  }

  consumeActions(): InputAction[] {
    const result = [...this.actions].filter((action) =>
      (this.profile !== "car" || !CAR_REBOUND_ACTIONS.has(action))
      && (this.profile !== "person" || !PERSON_REBOUND_ACTIONS.has(action)));
    this.actions.clear();
    for (const action of result) {
      if (action === "flapsDown") this.flaps = Math.min(1, this.flaps + 0.5);
      if (action === "flapsUp") this.flaps = Math.max(0, this.flaps - 0.5);
      if (action === "gearToggle") this.gear = toggledGearPosition(this.gear);
      if (action === "trimUp") this.trim = Math.min(1, this.trim + 0.04);
      if (action === "trimDown") this.trim = Math.max(-1, this.trim - 0.04);
      if (action === "moor") this.moorPresses += 1;
    }
    return result;
  }

  setThrottle(value: number): void {
    this.throttle = Math.min(1, Math.max(0, value));
  }

  /**
   * Take over the levers the autoland left the aeroplane in, when it hands
   * back. This controller holds throttle, flaps and gear and re-sends them,
   * so without this the first message after a hand-back would snap them to
   * wherever the pilot left them before engaging: the flaps retracting and
   * the gear coming up on short final. Flaps go to the nearest detent.
   */
  adoptConfiguration(throttle: number, flaps: number, gear: number): void {
    this.setThrottle(throttle);
    this.flaps = Math.min(1, Math.max(0, Math.round(flaps * 2) / 2));
    this.gear = gear >= 0.5 ? 1 : 0;
  }

  /**
   * Seed the player's trim, for the menu-to-flight hand-off.
   *
   * This controller OWNS trim: it holds it, steps it on ArrowUp/ArrowDown and
   * re-sends it with every control message. So a trim written anywhere else --
   * in the worker, say -- is overwritten on the next message and the aeroplane
   * slews back to neutral. Seeding has to come through here.
   *
   * The player can re-trim from the seeded value exactly as from any other:
   * it is ordinary trim state, not a mode.
   */
  setTrim(value: number): void {
    this.trim = Math.min(1, Math.max(-1, value));
  }

  resetForSpawn(
    spawn: SpawnKind,
    airborneThrottle = 0.68,
    runwayTrim = 0.04,
    airborneGear = 1,
    runwayFlaps = 0,
  ): void {
    this.profile = inputProfileForSpawn(spawn);
    this.boatLever = 0;
    this.boatLeverDetent = false;
    this.boatSteer = 0;
    this.moorPresses = 0;
    this.carAccelerator = 0;
    this.carBrake = 0;
    this.carSteer = 0;
    this.carClutch = 0;
    this.carPresses = neutralCarPresses();
    // Every drive starts aired up for the road, as the sim's new car does.
    this.carTyrePressure = "road";
    this.carSpeed = 0;
    this.carPadWasDown = neutralCarPad();
    this.interactPresses = 0;
    this.interactHeld = 0;
    this.interactFired = false;
    this.padInteractWasDown = false;
    this.jumpPresses = 0;
    this.padJumpWasDown = false;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.lookZoom = 0;
    this.pressed.clear();
    this.actions.clear();
    this.roll = 0;
    this.pitch = 0;
    this.yaw = 0;
    this.mouseRoll = 0;
    this.mousePitch = 0;
    this.rollTapRemaining = 0;
    this.pitchTapRemaining = 0;
    this.yawTapRemaining = 0;
    this.throttle = spawn === "runway"
      ? 0
      : Math.min(1, Math.max(0, airborneThrottle));
    this.trim = spawn === "runway" ? runwayTrim : 0;
    this.flaps = spawn === "runway" ? Math.min(1, Math.max(0, runwayFlaps)) : 0;
    this.gear = spawn === "runway" ? 1 : Math.min(1, Math.max(0, airborneGear));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    window.removeEventListener("blur", this.handleBlur);
    window.removeEventListener("mousemove", this.handleMouseMove);
    document.removeEventListener("pointerlockchange", this.handlePointerLockChange);
    this.canvas.removeEventListener("click", this.handleCanvasClick);
    this.canvas.removeEventListener("wheel", this.handleWheel);
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (isFlightShortcutTargetInteractive(event.target)) return;
    if (event.repeat) return;
    if (event.code === "KeyD" || event.code === "KeyA") {
      this.rollTapDirection = keyboardRollDirection(event.code);
      this.rollTapRemaining = 0.16;
    } else if (event.code === "KeyS" || event.code === "KeyW") {
      this.pitchTapDirection = event.code === "KeyS" ? 1 : -1;
      this.pitchTapRemaining = 0.16;
    } else if (event.code === "KeyE" || event.code === "KeyQ") {
      this.yawTapDirection = event.code === "KeyE" ? 1 : -1;
      this.yawTapRemaining = 0.14;
    }
    const carPress = this.profile === "car" ? CAR_PRESS_KEYS[event.code] : undefined;
    if (carPress) {
      this.carPresses[carPress] += 1;
      event.preventDefault();
    }
    if (this.profile === "person") {
      if (event.code === "Space") this.jumpPresses += 1;
      if (event.code === "KeyX" && !this.interactFired) {
        this.interactPresses += 1;
        this.interactFired = true;
      }
    }
    const action = ACTION_KEYS[event.code];
    if (action) {
      this.actions.add(action);
      event.preventDefault();
    }
    if (HELD_CONTROL_KEYS.has(event.code)) {
      this.pressed.add(event.code);
      event.preventDefault();
    }
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
    if (event.code === "KeyX") this.interactFired = false;
  };

  private readonly handleBlur = (): void => {
    this.pressed.clear();
    this.mouseRoll = 0;
    this.mousePitch = 0;
    this.rollTapRemaining = 0;
    this.pitchTapRemaining = 0;
    this.yawTapRemaining = 0;
  };

  private readonly handlePointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (!this.pointerLocked) {
      this.mouseRoll = 0;
      this.mousePitch = 0;
    }
  };

  private readonly handleCanvasClick = (): void => {
    if ((this.options.mouseFlight || this.profile === "person") && document.pointerLockElement !== this.canvas) {
      void this.canvas.requestPointerLock();
    }
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (this.profile !== "person") return;
    event.preventDefault();
    // A notch is about 100 pixels in line mode's pixel equivalent.
    const pixels = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
    this.lookZoom += pixels / 100;
  };

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if (this.profile === "person") {
      if (!this.pointerLocked) return;
      const pitchDirection = this.options.invertPitch ? -1 : 1;
      this.lookYaw += event.movementX * MOUSE_LOOK_RADIANS_PER_PIXEL;
      this.lookPitch -= event.movementY * pitchDirection * MOUSE_LOOK_RADIANS_PER_PIXEL;
      return;
    }
    if (!this.options.mouseFlight || !this.pointerLocked) return;
    this.mouseRoll = Math.min(1, Math.max(-1, this.mouseRoll + event.movementX * 0.0028));
    this.mousePitch = Math.min(1, Math.max(-1, this.mousePitch + event.movementY * 0.0028));
  };

  private readGamepad(): {
    roll: number;
    pitch: number;
    yaw: number;
    throttle: number | null;
    throttleStep: number;
    brake: number;
    /** Standard pad only: right trigger minus left, the boat's lever. */
    triggers: number;
    /** Standard pad only: right bumper minus left, the boat's tabs. */
    bumpers: number;
    /** Standard pad only: the right stick's Y, pulled back positive, the boat's trim. */
    rightStickY: number;
    buttonB: boolean;
    buttonY: boolean;
    /** Standard pad only, 0..1: the car's accelerator and brake. */
    rightTrigger: number;
    leftTrigger: number;
    /** Standard pad only: the car's handbrake (A), clutch (X) and shifts (bumpers). */
    buttonA: boolean;
    buttonX: boolean;
    bumperRight: boolean;
    bumperLeft: boolean;
    /** Standard pad only: the car's range, locks, downhill assist and lights. */
    dpadUp: boolean;
    dpadRight: boolean;
    dpadDown: boolean;
    dpadLeft: boolean;
  } {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = [...pads].find((candidate) => candidate?.connected);
    if (!pad) {
      return {
        roll: 0, pitch: 0, yaw: 0, throttle: null, throttleStep: 0, brake: 0,
        triggers: 0, bumpers: 0, rightStickY: 0, buttonB: false, buttonY: false,
        rightTrigger: 0, leftTrigger: 0, buttonA: false, buttonX: false, bumperRight: false, bumperLeft: false,
        dpadUp: false, dpadRight: false, dpadDown: false, dpadLeft: false,
      };
    }
    const axis = (index: number): number =>
      responseCurve(applyDeadZone(pad.axes[index] ?? 0, this.options.deadZone), this.options.sensitivity);
    const roll = axis(0);
    const pitch = axis(1);
    const standardPad = pad.mapping === "standard";
    const yaw = pad.axes.length > 2
      ? axis(2)
      : (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0);
    const throttleAxis = !standardPad && pad.axes.length > 3 ? pad.axes[3] : undefined;
    const throttle = typeof throttleAxis === "number" ? 1 - (throttleAxis + 1) * 0.5 : null;
    return {
      roll,
      pitch,
      yaw,
      throttle,
      throttleStep: standardPad
        ? (pad.buttons[5]?.value ?? 0) - (pad.buttons[4]?.value ?? 0)
        : 0,
      brake: Math.max(
        pad.buttons[0]?.value ?? 0,
        pad.buttons[1]?.value ?? 0,
        standardPad ? pad.buttons[6]?.value ?? 0 : 0,
      ),
      triggers: standardPad ? (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0) : 0,
      bumpers: standardPad ? (pad.buttons[5]?.value ?? 0) - (pad.buttons[4]?.value ?? 0) : 0,
      rightStickY: standardPad && pad.axes.length > 3 ? axis(3) : 0,
      buttonB: (pad.buttons[1]?.value ?? 0) > 0.5,
      buttonY: standardPad && (pad.buttons[3]?.value ?? 0) > 0.5,
      rightTrigger: standardPad ? pad.buttons[7]?.value ?? 0 : 0,
      leftTrigger: standardPad ? pad.buttons[6]?.value ?? 0 : 0,
      buttonA: standardPad && (pad.buttons[0]?.value ?? 0) > 0.5,
      buttonX: standardPad && (pad.buttons[2]?.value ?? 0) > 0.5,
      bumperRight: standardPad && (pad.buttons[5]?.value ?? 0) > 0.5,
      bumperLeft: standardPad && (pad.buttons[4]?.value ?? 0) > 0.5,
      dpadUp: standardPad && (pad.buttons[12]?.value ?? 0) > 0.5,
      dpadDown: standardPad && (pad.buttons[13]?.value ?? 0) > 0.5,
      dpadLeft: standardPad && (pad.buttons[14]?.value ?? 0) > 0.5,
      dpadRight: standardPad && (pad.buttons[15]?.value ?? 0) > 0.5,
    };
  }
}
