import type { InputAction } from "@/src/input";
import type { ControlState } from "./types";

export const CONTROL_PUMP_HZ = 120;
export const CONTROL_PUMP_STEP_SECONDS = 1 / CONTROL_PUMP_HZ;
const CONTROL_PUMP_INTERVAL_MILLISECONDS = 1_000 / CONTROL_PUMP_HZ;

export type ControlPumpPhase = "menu" | "flying" | "paused";

export interface ControlPumpInput {
  getControls(deltaSeconds: number): ControlState;
  consumeActions(): InputAction[];
}

export interface ControlPumpSimulation {
  setControls(controls: ControlState): void;
}

export interface ControlPumpOptions {
  readonly input: ControlPumpInput;
  readonly simulation: ControlPumpSimulation;
  readonly phase: () => ControlPumpPhase;
  readonly handleActions: (actions: InputAction[]) => void;
  /** Device loss and hidden/disposed documents can stop work without rebuilding the pump. */
  readonly isForeground?: () => boolean;
}

export interface FlightControlPump {
  /** Exposed for deterministic tests; production cadence is owned by the interval below. */
  tick(): void;
  dispose(): void;
}

/**
 * Poll controls independently of visual presentation.
 *
 * Every callback advances InputManager by exactly one fixed step. A delayed
 * main-thread callback therefore pauses command shaping instead of applying a
 * whole render hitch as one sudden control throw. Timers deliberately do not
 * catch up: the worker remains the sole owner of fixed-step flight dynamics.
 */
export function startFlightControlPump(options: ControlPumpOptions): FlightControlPump {
  let disposed = false;
  const tick = (): void => {
    if (disposed) return;
    if (options.isForeground && !options.isForeground()) {
      // Never replay an action queued while the page could not accept pilot input.
      options.input.consumeActions();
      return;
    }

    const phase = options.phase();
    if (phase === "flying") {
      options.simulation.setControls(
        options.input.getControls(CONTROL_PUMP_STEP_SECONDS),
      );
    }

    // Pause/resume, camera and global HUD actions must not inherit render
    // latency either. FlightGame's action handler owns the phase policy
    // (camera/reset/pause are gated there while HUD is intentionally global),
    // so the pump delegates immediately in every visible phase.
    const actions = options.input.consumeActions();
    if (actions.length > 0) options.handleActions(actions);
  };

  const interval = globalThis.setInterval(tick, CONTROL_PUMP_INTERVAL_MILLISECONDS);
  return {
    tick,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      globalThis.clearInterval(interval);
    },
  };
}
