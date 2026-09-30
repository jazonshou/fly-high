import type { InputAction } from "@/src/input";
import type { ControlState } from "./types";

export const CONTROL_PUMP_HZ = 120;
export const CONTROL_PUMP_STEP_SECONDS = 1 / CONTROL_PUMP_HZ;
const CONTROL_PUMP_INTERVAL_MILLISECONDS = 1_000 / CONTROL_PUMP_HZ;

export type ControlPumpPhase = "menu" | "flying" | "paused" | "viewer";

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
  /** Milliseconds, monotonic. Injected by tests; production reads `performance.now()`. */
  readonly now?: () => number;
  /**
   * Where pilot key events arrive. A key edge runs a tick at once instead of
   * waiting up to one interval, which at a starved 30 Hz is 33 ms of the input
   * chain. Listeners must be added AFTER the input's own, so the pressed-key
   * set is already updated when the tick reads it: FlightGame constructs
   * InputManager (which listens on `window`) before starting the pump.
   */
  readonly keyEvents?: EventTarget;
}

export interface FlightControlPump {
  /** Exposed for deterministic tests; production cadence is owned by the interval below. */
  tick(): void;
  dispose(): void;
}

/**
 * Most fixed steps one tick may apply: 50 ms. A hitch longer than this is
 * absorbed, not replayed, so a stall still cannot throw the controls.
 */
export const CONTROL_PUMP_MAX_CATCH_UP_STEPS = 6;

/**
 * Poll controls independently of visual presentation.
 *
 * InputManager is always advanced in FIXED steps of 1/120 s, so command
 * shaping is identical at any render rate. What changed (2026-09-29, the 4x
 * CPU-throttle baseline): each tick now applies as many steps as WALL time
 * has elapsed, not exactly one. The one-step rule assumed the interval really
 * fires at 120 Hz; on a starved main thread it does not. Chrome's 4x throttle
 * measured 29-31 callbacks a second, so the keyboard throttle, pitch and roll
 * ramps ran four times slow for as long as the host stayed slow, and the
 * first throttled take-off never reached full power.
 *
 * Catch-up is bounded by CONTROL_PUMP_MAX_CATCH_UP_STEPS; time beyond it is
 * dropped, which keeps the original intent that a render hitch is not applied
 * as one sudden control throw. A key edge may borrow one step from the next
 * tick so the new key state posts at once; the borrow is repaid, so over any
 * window the steps applied equal the wall time elapsed (minus dropped stalls).
 * The worker remains the sole owner of fixed-step flight dynamics.
 */
export function startFlightControlPump(options: ControlPumpOptions): FlightControlPump {
  const now = options.now ?? (() => performance.now());
  const stepMilliseconds = CONTROL_PUMP_STEP_SECONDS * 1_000;
  let disposed = false;
  let lastMilliseconds = now();
  /** Elapsed wall time not yet applied as steps; negative after a key-edge borrow. */
  let pendingMilliseconds = 0;

  const run = (edge: boolean): void => {
    if (disposed) return;
    const current = now();
    const elapsed = Math.max(0, current - lastMilliseconds);
    lastMilliseconds = current;
    if (options.isForeground && !options.isForeground()) {
      // Never replay an action queued while the page could not accept pilot input.
      pendingMilliseconds = 0;
      options.input.consumeActions();
      return;
    }

    const phase = options.phase();
    if (phase === "flying") {
      pendingMilliseconds = Math.min(
        pendingMilliseconds + elapsed,
        CONTROL_PUMP_MAX_CATCH_UP_STEPS * stepMilliseconds,
      );
      let steps = Math.max(0, Math.floor(pendingMilliseconds / stepMilliseconds + 1e-9));
      // Borrow at most one step, and only while no earlier borrow is unpaid.
      if (steps === 0 && edge && pendingMilliseconds >= 0) steps = 1;
      pendingMilliseconds -= steps * stepMilliseconds;
      let controls: ControlState | null = null;
      for (let step = 0; step < steps; step += 1) {
        controls = options.input.getControls(CONTROL_PUMP_STEP_SECONDS);
      }
      if (controls) options.simulation.setControls(controls);
    } else {
      // Time spent paused, in the menu or the viewer is not flight time.
      pendingMilliseconds = 0;
    }

    // Pause/resume, camera and global HUD actions must not inherit render
    // latency either. FlightGame's action handler owns the phase policy
    // (camera/reset/pause are gated there while HUD is intentionally global),
    // so the pump delegates immediately in every visible phase.
    const actions = options.input.consumeActions();
    if (actions.length > 0) options.handleActions(actions);
  };
  const tick = (): void => run(false);
  const onKeyEdge = (event: Event): void => {
    // Auto-repeat is a held key, not an edge.
    if ((event as KeyboardEvent).repeat) return;
    run(true);
  };

  const interval = globalThis.setInterval(tick, CONTROL_PUMP_INTERVAL_MILLISECONDS);
  options.keyEvents?.addEventListener("keydown", onKeyEdge);
  options.keyEvents?.addEventListener("keyup", onKeyEdge);
  return {
    tick,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      globalThis.clearInterval(interval);
      options.keyEvents?.removeEventListener("keydown", onKeyEdge);
      options.keyEvents?.removeEventListener("keyup", onKeyEdge);
    },
  };
}
