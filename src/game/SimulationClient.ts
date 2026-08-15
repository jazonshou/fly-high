import type { ControlState, FlightMode, FlightVisualState, WeatherPreset } from "./types";
import {
  DEFAULT_AIRBORNE_START_AGL,
  type SimulationCommand,
  type SimulationEvent,
  type SpawnKind,
} from "@/src/workers/protocol";

type StateListener = (state: FlightVisualState) => void;
type ErrorListener = (message: string) => void;

export class SimulationClient {
  private readonly worker: Worker;
  private stateListener: StateListener | null = null;
  private errorListener: ErrorListener | null = null;
  private previousState: FlightVisualState | null = null;
  private latestState: FlightVisualState | null = null;
  private latestReceivedAt = 0;
  private renderState: FlightVisualState | null = null;

  constructor(
    seed: number,
    mode: FlightMode,
    spawn: SpawnKind = "airborne",
    weather: WeatherPreset = "breezy",
    airborneStartAgl = DEFAULT_AIRBORNE_START_AGL,
    attractMode = false,
  ) {
    this.worker = new Worker(new URL("../workers/simulation.worker.ts", import.meta.url), {
      type: "module",
      name: "aerolith-flight-simulation",
    });
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleWorkerError);
    this.send({
      type: "initialize",
      seed,
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

  setPaused(paused: boolean): void {
    this.send({ type: "pause", paused });
  }

  reset(spawn: SpawnKind, airborneStartAgl = DEFAULT_AIRBORNE_START_AGL): void {
    this.send({ type: "reset", spawn, airborneStartAgl });
  }

  getRenderState(timestamp = performance.now()): FlightVisualState | null {
    const latest = this.latestState;
    const previous = this.previousState;
    if (!latest) return null;
    if (!previous || previous.simulationTime === latest.simulationTime) return latest;
    const snapshotDuration = Math.max(1 / 240, latest.simulationTime - previous.simulationTime);
    const elapsedSinceSnapshot = Math.max(0, (timestamp - this.latestReceivedAt) / 1_000);
    const targetTime = latest.simulationTime - snapshotDuration + elapsedSinceSnapshot;
    const alpha = Math.min(1, Math.max(0, (targetTime - previous.simulationTime) / snapshotDuration));
    this.renderState = interpolateFlightState(previous, latest, alpha, this.renderState ?? undefined);
    return this.renderState;
  }

  dispose(): void {
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleWorkerError);
    this.worker.terminate();
    this.stateListener = null;
    this.errorListener = null;
  }

  private send(command: SimulationCommand): void {
    this.worker.postMessage(command);
  }

  private readonly handleMessage = (event: MessageEvent<SimulationEvent>): void => {
    if (event.data.type === "error") {
      this.errorListener?.(event.data.message);
      return;
    }
    if (event.data.type === "ready") {
      this.previousState = event.data.state;
    } else {
      this.previousState = this.latestState ?? event.data.state;
    }
    this.latestState = event.data.state;
    this.latestReceivedAt = performance.now();
    this.stateListener?.(event.data.state);
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
  result.loadFactor = lerp(first.loadFactor, second.loadFactor, alpha);
  result.touchdown = lerp(first.touchdown, second.touchdown, alpha);
  result.simulationTime = lerp(first.simulationTime, second.simulationTime, alpha);
  const useSecondFlags = alpha >= 0.5;
  result.onGround = useSecondFlags ? second.onGround : first.onGround;
  result.stalled = useSecondFlags ? second.stalled : first.stalled;
  result.crashed = useSecondFlags ? second.crashed : first.crashed;
  return result;
}
