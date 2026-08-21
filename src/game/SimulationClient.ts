import type { ControlState, FlightMode, FlightVisualState, WeatherPreset } from "./types";
import type { AircraftKind } from "@/src/sim";
import type { WorldDefinition } from "@/src/world";
import type {
  TerrainMacroGrid,
  TerrainPagePublication,
} from "@/src/workers/terrainAuthority";
import {
  DEFAULT_AIRBORNE_START_AGL,
  type SimulationCommand,
  type SimulationEvent,
  type SpawnKind,
} from "@/src/workers/protocol";

type StateListener = (state: FlightVisualState) => void;
type ErrorListener = (message: string) => void;

/** Heavy frames may coast briefly, but never predict far enough to invent a manoeuvre. */
export const MAX_VISUAL_EXTRAPOLATION_SECONDS = 0.05;
const WORKER_CLOCK_OFFSET_EMA_ALPHA = 0.1;

export class SimulationClient {
  private readonly worker: Worker;
  private stateListener: StateListener | null = null;
  private errorListener: ErrorListener | null = null;
  private previousState: FlightVisualState | null = null;
  private latestState: FlightVisualState | null = null;
  private renderState: FlightVisualState | null = null;
  /** Main-thread seconds minus simulation seconds, smoothed across message jitter. */
  private workerClockOffsetSeconds: number | null = null;
  /** The sampled simulation clock may coast or pause, but never move backwards. */
  private lastSampledSimulationTime: number | null = null;

  constructor(
    world: WorldDefinition,
    mode: FlightMode,
    spawn: SpawnKind = "airborne",
    weather: WeatherPreset = "breezy",
    airborneStartAgl = DEFAULT_AIRBORNE_START_AGL,
    attractMode = false,
    aircraft: AircraftKind = "trainer",
  ) {
    this.worker = new Worker(new URL("../workers/simulation.worker.ts", import.meta.url), {
      type: "module",
      name: "aerolith-flight-simulation",
    });
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleWorkerError);
    this.send({
      type: "initialize",
      world,
      aircraft,
      mode,
      spawn,
      weather,
      airborneStartAgl,
      attractMode,
    });
  }

  onState(listener: StateListener): void {
    this.stateListener = listener;
    if (this.latestState) listener(this.latestState);
  }

  onError(listener: ErrorListener): void {
    this.errorListener = listener;
  }

  setControls(controls: ControlState): void {
    this.send({ type: "controls", controls });
  }

  setMode(mode: FlightMode): void {
    this.send({ type: "mode", mode });
  }

  setWeather(weather: WeatherPreset): void {
    this.send({ type: "weather", weather });
  }

  setAttractMode(enabled: boolean): void {
    this.send({ type: "attract", enabled });
  }

  /** Stops demo automation and selects pilot authority as one Worker command. */
  handoff(mode: FlightMode): void {
    this.send({ type: "handoff", mode });
  }

  /** Atomically rebuilds the live menu flight with demo assistance enabled. */
  returnToAttract(airborneStartAgl = DEFAULT_AIRBORNE_START_AGL): void {
    this.send({ type: "returnToAttract", airborneStartAgl });
  }

  setPaused(paused: boolean): void {
    this.send({ type: "pause", paused });
  }

  /**
   * Transfer one final L0 atlas core to the worker-owned collision ring.
   * The supplied typed array is detached; callers must provide a dedicated
   * readback buffer rather than the renderer's own working view.
   */
  publishTerrainPage(page: TerrainPagePublication): void {
    this.send(
      { type: "terrainPage", page },
      page.heights.buffer instanceof ArrayBuffer ? [page.heights.buffer] : [],
    );
  }

  /** Transfer the once-per-world macro fallback to the simulation worker. */
  publishTerrainMacro(macro: TerrainMacroGrid): void {
    this.send(
      { type: "terrainMacro", macro },
      macro.heights.buffer instanceof ArrayBuffer ? [macro.heights.buffer] : [],
    );
  }

  reset(spawn: SpawnKind, airborneStartAgl = DEFAULT_AIRBORNE_START_AGL): void {
    this.send({ type: "reset", spawn, airborneStartAgl });
  }

  /** Recovers over the Worker's authoritative crash X/Z, never renderer-local coordinates. */
  restartAfterCrash(airborneStartAgl = DEFAULT_AIRBORNE_START_AGL): void {
    this.send({ type: "restartAfterCrash", airborneStartAgl });
  }

  getRenderState(timestamp = performance.now()): FlightVisualState | null {
    const latest = this.latestState;
    const previous = this.previousState;
    if (!latest) return null;
    if (
      !previous
      || this.workerClockOffsetSeconds === null
    ) {
      this.lastSampledSimulationTime = latest.simulationTime;
      this.renderState = cloneVisualState(latest);
      return this.renderState;
    }
    if (previous.simulationTime === latest.simulationTime) {
      const targetTime = Math.min(
        latest.simulationTime + MAX_VISUAL_EXTRAPOLATION_SECONDS,
        Math.max(this.lastSampledSimulationTime ?? latest.simulationTime, latest.simulationTime),
      );
      this.renderState = targetTime > latest.simulationTime
        ? extrapolateFlightState(
            latest,
            targetTime - latest.simulationTime,
            this.renderState ?? undefined,
          )
        : cloneVisualState(latest);
      this.lastSampledSimulationTime = this.renderState.simulationTime;
      return this.renderState;
    }
    const snapshotDuration = Math.max(1 / 240, latest.simulationTime - previous.simulationTime);
    const estimatedWorkerTime = timestamp / 1_000 - this.workerClockOffsetSeconds;
    const delayedTargetTime = estimatedWorkerTime - snapshotDuration;
    const monotoneTargetTime = Math.max(
      this.lastSampledSimulationTime ?? previous.simulationTime,
      delayedTargetTime,
    );
    const targetTime = Math.min(
      latest.simulationTime + MAX_VISUAL_EXTRAPOLATION_SECONDS,
      monotoneTargetTime,
    );
    if (targetTime <= latest.simulationTime) {
      const alpha = (targetTime - previous.simulationTime) / snapshotDuration;
      this.renderState = interpolateFlightState(
        previous,
        latest,
        alpha,
        this.renderState ?? undefined,
      );
    } else {
      this.renderState = extrapolateFlightState(
        latest,
        targetTime - latest.simulationTime,
        this.renderState ?? undefined,
      );
    }
    this.lastSampledSimulationTime = this.renderState.simulationTime;
    return this.renderState;
  }

  dispose(): void {
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleWorkerError);
    this.worker.terminate();
    this.stateListener = null;
    this.errorListener = null;
  }

  private send(command: SimulationCommand, transferables: Transferable[] = []): void {
    this.worker.postMessage(command, transferables);
  }

  private readonly handleMessage = (event: MessageEvent<SimulationEvent>): void => {
    if (event.data.type === "error") {
      this.errorListener?.(event.data.message);
      return;
    }
    const receivedAtSeconds = performance.now() / 1_000;
    const state = event.data.state;
    const clockRestarted = event.data.type === "ready"
      || (this.latestState !== null && state.simulationTime < this.latestState.simulationTime);
    if (clockRestarted) {
      this.previousState = state;
      this.workerClockOffsetSeconds = receivedAtSeconds - state.simulationTime;
      this.lastSampledSimulationTime = state.simulationTime;
      this.renderState = null;
    } else {
      this.previousState = this.latestState ?? state;
      const offsetSample = receivedAtSeconds - state.simulationTime;
      this.workerClockOffsetSeconds = this.workerClockOffsetSeconds === null
        ? offsetSample
        : this.workerClockOffsetSeconds
          + (offsetSample - this.workerClockOffsetSeconds) * WORKER_CLOCK_OFFSET_EMA_ALPHA;
    }
    this.latestState = state;
    this.stateListener?.(state);
  };

  private readonly handleWorkerError = (event: ErrorEvent): void => {
    this.errorListener?.(event.message || "The flight simulation worker stopped unexpectedly.");
  };
}

function lerp(first: number, second: number, alpha: number): number {
  return first + (second - first) * alpha;
}

function lerpAngleDegrees(first: number, second: number, alpha: number): number {
  const delta = ((second - first + 540) % 360) - 180;
  return (first + delta * alpha + 360) % 360;
}

function cloneVisualState(state: FlightVisualState): FlightVisualState {
  return {
    ...state,
    position: { ...state.position },
    velocity: { ...state.velocity },
    orientation: { ...state.orientation },
    angularVelocity: { ...state.angularVelocity },
  };
}

export function interpolateFlightState(
  first: FlightVisualState,
  second: FlightVisualState,
  amount: number,
  target?: FlightVisualState,
): FlightVisualState {
  const alpha = Math.min(1, Math.max(0, amount));
  const result = target ?? cloneVisualState(first);
  result.position.x = lerp(first.position.x, second.position.x, alpha);
  result.position.y = lerp(first.position.y, second.position.y, alpha);
  result.position.z = lerp(first.position.z, second.position.z, alpha);
  result.velocity.x = lerp(first.velocity.x, second.velocity.x, alpha);
  result.velocity.y = lerp(first.velocity.y, second.velocity.y, alpha);
  result.velocity.z = lerp(first.velocity.z, second.velocity.z, alpha);
  result.angularVelocity.x = lerp(first.angularVelocity.x, second.angularVelocity.x, alpha);
  result.angularVelocity.y = lerp(first.angularVelocity.y, second.angularVelocity.y, alpha);
  result.angularVelocity.z = lerp(first.angularVelocity.z, second.angularVelocity.z, alpha);

  let secondX = second.orientation.x;
  let secondY = second.orientation.y;
  let secondZ = second.orientation.z;
  let secondW = second.orientation.w;
  const dot =
    first.orientation.x * secondX +
    first.orientation.y * secondY +
    first.orientation.z * secondZ +
    first.orientation.w * secondW;
  if (dot < 0) {
    secondX *= -1;
    secondY *= -1;
    secondZ *= -1;
    secondW *= -1;
  }
  result.orientation.x = lerp(first.orientation.x, secondX, alpha);
  result.orientation.y = lerp(first.orientation.y, secondY, alpha);
  result.orientation.z = lerp(first.orientation.z, secondZ, alpha);
  result.orientation.w = lerp(first.orientation.w, secondW, alpha);
  const quaternionLength = Math.hypot(
    result.orientation.x,
    result.orientation.y,
    result.orientation.z,
    result.orientation.w,
  );
  const inverseLength = quaternionLength > 1e-8 ? 1 / quaternionLength : 1;
  result.orientation.x *= inverseLength;
  result.orientation.y *= inverseLength;
  result.orientation.z *= inverseLength;
  result.orientation.w *= inverseLength;

  result.airspeed = lerp(first.airspeed, second.airspeed, alpha);
  result.altitudeAgl = lerp(first.altitudeAgl, second.altitudeAgl, alpha);
  result.altitude = lerp(first.altitude, second.altitude, alpha);
  result.verticalSpeed = lerp(first.verticalSpeed, second.verticalSpeed, alpha);
  result.heading = lerpAngleDegrees(first.heading, second.heading, alpha);
  result.pitch = lerp(first.pitch, second.pitch, alpha);
  result.bank = lerp(first.bank, second.bank, alpha);
  result.angleOfAttack = lerp(first.angleOfAttack, second.angleOfAttack, alpha);
  result.sideslip = lerp(first.sideslip, second.sideslip, alpha);
  result.throttle = lerp(first.throttle, second.throttle, alpha);
  result.engineRpm = lerp(first.engineRpm, second.engineRpm, alpha);
  result.elevator = lerp(first.elevator, second.elevator, alpha);
  result.aileron = lerp(first.aileron, second.aileron, alpha);
  result.rudder = lerp(first.rudder, second.rudder, alpha);
  result.brake = lerp(first.brake, second.brake, alpha);
  result.trim = lerp(first.trim, second.trim, alpha);
  result.flaps = lerp(first.flaps, second.flaps, alpha);
  result.gear = lerp(first.gear, second.gear, alpha);
  result.loadFactor = lerp(first.loadFactor, second.loadFactor, alpha);
  result.touchdown = lerp(first.touchdown, second.touchdown, alpha);
  result.simulationTime = lerp(first.simulationTime, second.simulationTime, alpha);
  const useSecondFlags = alpha >= 0.5;
  result.onGround = useSecondFlags ? second.onGround : first.onGround;
  result.stalled = useSecondFlags ? second.stalled : first.stalled;
  result.crashed = useSecondFlags ? second.crashed : first.crashed;
  const terrainAuthority = second.terrainAuthority ?? first.terrainAuthority;
  if (terrainAuthority) result.terrainAuthority = terrainAuthority;
  else delete result.terrainAuthority;
  return result;
}

/**
 * Constant-velocity, constant-body-rate visual prediction. This deliberately
 * does not advance forces, controls, contacts, or flags: the worker remains
 * authoritative, and the renderer only bridges one missed snapshot.
 */
export function extrapolateFlightState(
  state: FlightVisualState,
  durationSeconds: number,
  target?: FlightVisualState,
): FlightVisualState {
  const dt = Math.min(
    MAX_VISUAL_EXTRAPOLATION_SECONDS,
    Math.max(0, Number.isFinite(durationSeconds) ? durationSeconds : 0),
  );
  // A caller may reasonably request an in-place update. Do not let the
  // scratch vectors alias the authoritative snapshot in that case.
  const result = target && target !== state ? target : cloneVisualState(state);
  const position = result.position;
  const velocity = result.velocity;
  const orientation = result.orientation;
  const angularVelocity = result.angularVelocity;
  Object.assign(result, state);
  if (!state.terrainAuthority) delete result.terrainAuthority;
  result.position = position;
  result.velocity = velocity;
  result.orientation = orientation;
  result.angularVelocity = angularVelocity;
  result.position.x = state.position.x + state.velocity.x * dt;
  result.position.y = state.position.y + state.velocity.y * dt;
  result.position.z = state.position.z + state.velocity.z * dt;
  result.velocity.x = state.velocity.x;
  result.velocity.y = state.velocity.y;
  result.velocity.z = state.velocity.z;
  result.angularVelocity.x = state.angularVelocity.x;
  result.angularVelocity.y = state.angularVelocity.y;
  result.angularVelocity.z = state.angularVelocity.z;

  // Same q_dot = 1/2 * q * omega_body convention as the authoritative sim.
  const qx = state.orientation.x;
  const qy = state.orientation.y;
  const qz = state.orientation.z;
  const qw = state.orientation.w;
  const omega = state.angularVelocity;
  const halfDt = 0.5 * dt;
  result.orientation.x = qx + halfDt * (qw * omega.x + qy * omega.z - qz * omega.y);
  result.orientation.y = qy + halfDt * (qw * omega.y - qx * omega.z + qz * omega.x);
  result.orientation.z = qz + halfDt * (qw * omega.z + qx * omega.y - qy * omega.x);
  result.orientation.w = qw + halfDt * (-qx * omega.x - qy * omega.y - qz * omega.z);
  normalizeVisualQuaternion(result.orientation);
  updateVisualAnglesFromOrientation(result);

  result.altitude = state.altitude + state.velocity.y * dt;
  result.altitudeAgl = state.altitudeAgl + state.velocity.y * dt;
  result.verticalSpeed = state.velocity.y;
  result.simulationTime = state.simulationTime + dt;
  return result;
}

function normalizeVisualQuaternion(orientation: FlightVisualState["orientation"]): void {
  const length = Math.hypot(orientation.x, orientation.y, orientation.z, orientation.w);
  if (!Number.isFinite(length) || length < 1e-8) {
    orientation.x = 0;
    orientation.y = 0;
    orientation.z = 0;
    orientation.w = 1;
    return;
  }
  const inverse = 1 / length;
  orientation.x *= inverse;
  orientation.y *= inverse;
  orientation.z *= inverse;
  orientation.w *= inverse;
}

function updateVisualAnglesFromOrientation(state: FlightVisualState): void {
  const { x, y, z, w } = state.orientation;
  // Body +X (forward), +Z (port), and +Y (up), rotated into world space.
  const forwardX = 1 - 2 * (y * y + z * z);
  const forwardY = 2 * (x * y + w * z);
  const forwardZ = 2 * (x * z - w * y);
  const rightY = -2 * (y * z - w * x);
  const upY = 1 - 2 * (x * x + z * z);
  state.heading = ((Math.atan2(forwardX, forwardZ) * 180) / Math.PI + 360) % 360;
  state.pitch = (Math.asin(Math.min(1, Math.max(-1, forwardY))) * 180) / Math.PI;
  state.bank = (Math.atan2(-rightY, upY) * 180) / Math.PI;
}
