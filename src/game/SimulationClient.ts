import type { ControlState, FlightMode, FlightVisualState, WeatherPreset } from "./types";
import type { AircraftKind } from "@/src/sim";
import type { AirportDefinition, WorldDefinition } from "@/src/world";
import {
  TERRAIN_READBACK_RING_CAPACITY,
  type TerrainMacroGrid,
  type TerrainPagePublication,
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
/** Present one normal 60 Hz worker snapshot behind the estimated simulation clock. */
export const VISUAL_PRESENTATION_DELAY_SECONDS = 1 / 60;
const CLOCK_OFFSET_WINDOW_SAMPLES = 32;
/**
 * New workers tried after the first one's script fails to load, before the
 * flight gives up. A load failure is retried only until the worker first
 * answers; a worker that loaded and then failed is never replaced.
 */
export const SIMULATION_WORKER_LOAD_RETRIES = 2;
/** The wait before each replacement worker, so a passing fault can clear. */
export const SIMULATION_WORKER_RETRY_DELAY_MILLISECONDS = 500;
export const SIMULATION_WORKER_LOAD_FAILED_MESSAGE =
  "The flight simulation could not load its code. Reload to try again; if it keeps "
  + "failing, check that no browser extension is blocking this site.";
/** A genuine worker-clock slowdown changes phase gradually instead of freezing presentation. */
const CLOCK_OFFSET_UPWARD_SLEW_SECONDS_PER_SECOND = 0.1;

/**
 * Estimate main-clock minus simulation-clock without treating queue latency as
 * clock phase. Arrival delay can only increase a sample, so the recent minimum
 * is the useful NTP-style observation. A persistent increase is admitted at a
 * bounded rate; transient delayed/bursted messages cannot move the clock.
 */
class WorkerClockOffsetEstimator {
  private readonly samples: number[] = [];
  private estimateSeconds: number | null = null;
  private lastObservedAtSeconds: number | null = null;

  get valueSeconds(): number | null {
    return this.estimateSeconds;
  }

  reset(receivedAtSeconds: number, simulationTime: number): void {
    const sample = receivedAtSeconds - simulationTime;
    this.samples.length = 0;
    this.samples.push(sample);
    this.estimateSeconds = sample;
    this.lastObservedAtSeconds = receivedAtSeconds;
  }

  observe(receivedAtSeconds: number, simulationTime: number): void {
    const sample = receivedAtSeconds - simulationTime;
    this.samples.push(sample);
    if (this.samples.length > CLOCK_OFFSET_WINDOW_SAMPLES) this.samples.shift();
    const recentFloor = Math.min(...this.samples);
    if (this.estimateSeconds === null) {
      this.estimateSeconds = recentFloor;
      this.lastObservedAtSeconds = receivedAtSeconds;
      return;
    }

    const elapsed = Math.max(
      0,
      receivedAtSeconds - (this.lastObservedAtSeconds ?? receivedAtSeconds),
    );
    this.lastObservedAtSeconds = receivedAtSeconds;
    this.estimateSeconds = recentFloor <= this.estimateSeconds
      ? recentFloor
      : Math.min(
          recentFloor,
          this.estimateSeconds + elapsed * CLOCK_OFFSET_UPWARD_SLEW_SECONDS_PER_SECOND,
        );
  }
}

function createSimulationWorker(): Worker {
  return new Worker(new URL("../workers/simulation.worker.ts", import.meta.url), {
    type: "module",
    name: "aerolith-flight-simulation",
  });
}

export class SimulationClient {
  private worker: Worker;
  private stateListener: StateListener | null = null;
  private errorListener: ErrorListener | null = null;
  private previousState: FlightVisualState | null = null;
  private latestState: FlightVisualState | null = null;
  private renderState: FlightVisualState | null = null;
  private readonly workerClockOffset = new WorkerClockOffsetEstimator();
  /** A pause changes main-minus-simulation phase without starting a new simulation epoch. */
  private resetClockOnNextState = false;
  /** Presentation freezes immediately when the worker is paused. */
  private presentationPaused = false;
  /** Resume holds the predicted pose until authority catches its displayed time. */
  private resumePresentationFloorSeconds: number | null = null;
  /** The sampled simulation clock may coast or pause, but never move backwards. */
  private lastSampledSimulationTime: number | null = null;
  /**
   * Every command sent before the worker first answered, in order, so a
   * worker whose script failed to load can be replaced and brought to the
   * same state. Null once the worker has answered: its script is running.
   */
  private startupCommands: SimulationCommand[] | null = [];
  private loadRetries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    world: WorldDefinition,
    mode: FlightMode,
    spawn: SpawnKind = "airborne",
    weather: WeatherPreset = "breezy",
    airborneStartAgl = DEFAULT_AIRBORNE_START_AGL,
    attractMode = false,
    aircraft: AircraftKind = "trainer",
  ) {
    this.worker = this.attachWorker();
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
  handoff(mode: FlightMode, trimSeed = 0): void {
    this.send({ type: "handoff", mode, trimSeed });
  }

  /** Atomically rebuilds the live menu flight with demo assistance enabled. */
  returnToAttract(airborneStartAgl = DEFAULT_AIRBORNE_START_AGL): void {
    this.clearPresentationPause();
    this.send({ type: "returnToAttract", airborneStartAgl });
  }

  setPaused(paused: boolean): void {
    if (paused) {
      this.presentationPaused = true;
      if (!this.renderState && this.latestState) {
        this.renderState = cloneVisualState(this.latestState);
        this.lastSampledSimulationTime = this.latestState.simulationTime;
      }
    } else {
      if (this.presentationPaused) {
        this.resumePresentationFloorSeconds = this.renderState?.simulationTime
          ?? this.lastSampledSimulationTime
          ?? this.latestState?.simulationTime
          ?? null;
      }
      this.presentationPaused = false;
      this.resetClockOnNextState = true;
    }
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

  /** The world's full airport list, home field first (see `withAirports`). */
  setAirports(airports: readonly AirportDefinition[]): void {
    this.send({ type: "airports", airports });
  }

  /** Engage the autoland on the nearest airport, or hand back (`src/sim/autoland.ts`). */
  setAutoland(enabled: boolean): void {
    this.send({ type: "autoland", enabled });
  }

  reset(spawn: SpawnKind, airborneStartAgl = DEFAULT_AIRBORNE_START_AGL): void {
    this.clearPresentationPause();
    this.send({ type: "reset", spawn, airborneStartAgl });
  }

  /** Recovers over the Worker's authoritative crash X/Z, never renderer-local coordinates. */
  restartAfterCrash(airborneStartAgl = DEFAULT_AIRBORNE_START_AGL): void {
    this.clearPresentationPause();
    this.send({ type: "restartAfterCrash", airborneStartAgl });
  }

  getRenderState(timestamp = performance.now()): FlightVisualState | null {
    const latest = this.latestState;
    const previous = this.previousState;
    const workerClockOffsetSeconds = this.workerClockOffset.valueSeconds;
    if (!latest) return null;
    if (this.presentationPaused) {
      if (!this.renderState) this.renderState = cloneVisualState(latest);
      this.lastSampledSimulationTime = this.renderState.simulationTime;
      return this.renderState;
    }
    if (this.resetClockOnNextState) {
      // Simulation time is stopped while paused, so the old wall-clock phase
      // is knowingly invalid on resume. Preserve the pose the player actually
      // saw; replacing it with the older authority snapshot visibly rewound
      // up to the full 50 ms coast allowance.
      if (!this.renderState) this.renderState = cloneVisualState(latest);
      this.lastSampledSimulationTime = Math.max(
        this.lastSampledSimulationTime ?? this.renderState.simulationTime,
        this.renderState.simulationTime,
      );
      return this.renderState;
    }
    if (
      this.resumePresentationFloorSeconds !== null
      && latest.simulationTime < this.resumePresentationFloorSeconds
    ) {
      if (!this.renderState) this.renderState = cloneVisualState(latest);
      this.lastSampledSimulationTime = this.resumePresentationFloorSeconds;
      return this.renderState;
    }
    if (this.resumePresentationFloorSeconds !== null) {
      this.resumePresentationFloorSeconds = null;
    }
    if (
      !previous
      || workerClockOffsetSeconds === null
    ) {
      this.lastSampledSimulationTime = latest.simulationTime;
      this.renderState = cloneVisualState(latest);
      return this.renderState;
    }
    if (previous.simulationTime === latest.simulationTime) {
      const estimatedWorkerTime = timestamp / 1_000 - workerClockOffsetSeconds;
      const delayedTargetTime = estimatedWorkerTime - VISUAL_PRESENTATION_DELAY_SECONDS;
      const targetTime = Math.min(
        latest.simulationTime + MAX_VISUAL_EXTRAPOLATION_SECONDS,
        Math.max(
          this.lastSampledSimulationTime ?? latest.simulationTime,
          latest.simulationTime,
          delayedTargetTime,
        ),
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
    const estimatedWorkerTime = timestamp / 1_000 - workerClockOffsetSeconds;
    const delayedTargetTime = estimatedWorkerTime - VISUAL_PRESENTATION_DELAY_SECONDS;
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
    this.disposed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.startupCommands = null;
    this.detachWorker();
    this.stateListener = null;
    this.errorListener = null;
  }

  private attachWorker(): Worker {
    const worker = createSimulationWorker();
    worker.addEventListener("message", this.handleMessage);
    worker.addEventListener("error", this.handleWorkerError);
    return worker;
  }

  private detachWorker(): void {
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleWorkerError);
    this.worker.terminate();
  }

  private send(command: SimulationCommand, transferables: Transferable[] = []): void {
    const startup = this.startupCommands;
    if (startup) {
      // Until the worker answers, a replacement may need this command again.
      // Terrain still transfers to this worker, so the replay keeps a copy;
      // the worker keeps only the newest pages, so only that many are held.
      startup.push(replayableCommand(command));
      if (command.type === "terrainPage") {
        let pages = 0;
        for (const held of startup) if (held.type === "terrainPage") pages += 1;
        if (pages > TERRAIN_READBACK_RING_CAPACITY) {
          startup.splice(startup.findIndex((held) => held.type === "terrainPage"), 1);
        }
      }
    }
    this.worker.postMessage(command, transferables);
  }

  /**
   * Replace a worker whose script failed to load, a bounded number of times.
   * The replacement receives every command the first one was sent.
   */
  private retryWorkerLoad(): void {
    if (this.loadRetries >= SIMULATION_WORKER_LOAD_RETRIES) {
      console.error(
        `The flight simulation worker failed to load ${this.loadRetries + 1} times; `
        + "the browser's Network panel shows which file failed",
      );
      this.startupCommands = null;
      this.errorListener?.(SIMULATION_WORKER_LOAD_FAILED_MESSAGE);
      return;
    }
    this.loadRetries += 1;
    console.warn(
      "The flight simulation worker failed to load; retrying "
      + `(${this.loadRetries} of ${SIMULATION_WORKER_LOAD_RETRIES})`,
    );
    this.detachWorker();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.disposed) return;
      this.worker = this.attachWorker();
      // Copied, not transferred: a later replacement may need them again.
      for (const command of this.startupCommands ?? []) this.worker.postMessage(command);
    }, SIMULATION_WORKER_RETRY_DELAY_MILLISECONDS);
  }

  private clearPresentationPause(): void {
    this.presentationPaused = false;
    this.resumePresentationFloorSeconds = null;
  }

  private readonly handleMessage = (event: MessageEvent<SimulationEvent>): void => {
    // Any answer means the script loaded: from here on, terrain is transferred.
    this.startupCommands = null;
    if (event.data.type === "error") {
      this.errorListener?.(event.data.message);
      return;
    }
    const receivedAtSeconds = performance.now() / 1_000;
    const state = event.data.state;
    const clockRestarted = event.data.type === "ready"
      || this.resetClockOnNextState
      || (this.latestState !== null && state.simulationTime < this.latestState.simulationTime);
    if (clockRestarted) {
      const preserveResumeFloor = this.resetClockOnNextState
        && this.resumePresentationFloorSeconds !== null;
      this.previousState = state;
      this.workerClockOffset.reset(receivedAtSeconds, state.simulationTime);
      this.resetClockOnNextState = false;
      if (!preserveResumeFloor) {
        this.resumePresentationFloorSeconds = null;
        this.lastSampledSimulationTime = state.simulationTime;
        this.renderState = null;
      }
    } else {
      this.previousState = this.latestState ?? state;
      this.workerClockOffset.observe(receivedAtSeconds, state.simulationTime);
    }
    this.latestState = state;
    this.stateListener?.(state);
  };

  private readonly handleWorkerError = (event: ErrorEvent): void => {
    // A script that failed to download or parse is reported as a bare `error`
    // Event with no message (Firefox and Chrome alike); a script that loaded
    // and then threw carries its message. Only the first kind is retried, and
    // only before the worker has answered, while every command is still held.
    if (!event.message && this.startupCommands) {
      this.retryWorkerLoad();
      return;
    }
    this.errorListener?.(event.message || "The flight simulation worker stopped unexpectedly.");
  };
}

/** A command a replay can send again after the original's buffers were transferred. */
function replayableCommand(command: SimulationCommand): SimulationCommand {
  if (command.type === "terrainPage") {
    return { ...command, page: { ...command.page, heights: command.page.heights.slice() } };
  }
  if (command.type === "terrainMacro") {
    return { ...command, macro: { ...command.macro, heights: command.macro.heights.slice() } };
  }
  return command;
}

function lerp(first: number, second: number, alpha: number): number {
  return first + (second - first) * alpha;
}

function lerpAngleDegrees(first: number, second: number, alpha: number): number {
  const delta = ((second - first + 540) % 360) - 180;
  return (first + delta * alpha + 360) % 360;
}

/**
 * The same shortest-way-round lerp for an angle whose home range is (-180, 180],
 * which is bank's: `atan2` gives it a discontinuity at inverted flight, where +170
 * and -170 are 20 degrees apart and their linear average is 0, wings level.
 * Pitch does not need this (it comes from `asin`, so it stays within +-90 and
 * never wraps), and heading has its own `[0, 360)` version above.
 */
function lerpSignedAngleDegrees(first: number, second: number, alpha: number): number {
  const delta = ((second - first + 540) % 360) - 180;
  return ((first + delta * alpha + 540) % 360) - 180;
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
  result.bank = lerpSignedAngleDegrees(first.bank, second.bank, alpha);
  result.angleOfAttack = lerp(first.angleOfAttack, second.angleOfAttack, alpha);
  result.sideslip = lerp(first.sideslip, second.sideslip, alpha);
  result.throttle = lerp(first.throttle, second.throttle, alpha);
  result.engineRpm = lerp(first.engineRpm, second.engineRpm, alpha);
  result.elevator = lerp(first.elevator, second.elevator, alpha);
  result.aileron = lerp(first.aileron, second.aileron, alpha);
  result.rudder = lerp(first.rudder, second.rudder, alpha);
  result.brake = lerp(first.brake, second.brake, alpha);
  result.groundSpoilers = lerp(first.groundSpoilers, second.groundSpoilers, alpha);
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

/**
 * Heading, pitch and bank, in DEGREES, from the state's orientation: the same
 * three angles the simulator's telemetry reports (`getFlightTelemetry`), which
 * the worker converts to degrees, so a predicted frame agrees with a real one.
 *
 * Body +X is forward, +Y up and +Z STARBOARD (D-6, 2026-09-01: forward x up =
 * starboard). This helper once called +Z port and took the y of the port wing
 * as "right", which made its bank the NEGATIVE of the simulator's; heading and
 * pitch were unaffected. Bank is positive for a right wing DOWN, i.e. the
 * starboard wing's world y is negative: `atan2(-starboard.y, up.y)`.
 */
function updateVisualAnglesFromOrientation(state: FlightVisualState): void {
  const { x, y, z, w } = state.orientation;
  const forwardX = 1 - 2 * (y * y + z * z);
  const forwardY = 2 * (x * y + w * z);
  const forwardZ = 2 * (x * z - w * y);
  // World y of body +Z (starboard): the third column's y of the rotation matrix.
  const starboardY = 2 * (y * z - w * x);
  const upY = 1 - 2 * (x * x + z * z);
  state.heading = ((Math.atan2(forwardX, forwardZ) * 180) / Math.PI + 360) % 360;
  state.pitch = (Math.asin(Math.min(1, Math.max(-1, forwardY))) * 180) / Math.PI;
  state.bank = (Math.atan2(-starboardY, upY) * 180) / Math.PI;
}
