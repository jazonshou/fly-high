import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_PUMP_MAX_CATCH_UP_STEPS,
  CONTROL_PUMP_STEP_SECONDS,
  startFlightControlPump,
  type ControlPumpPhase,
} from "../src/game/controlPump";
import type { ControlState } from "../src/game/types";
import type { InputAction } from "../src/input";

const BASE_CONTROLS: ControlState = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: 0.5,
  trim: 0,
  flaps: 0,
  brake: 0,
  gear: 1,
};

afterEach(() => {
  vi.useRealTimers();
});

function controlTrajectoryAtRenderRate(renderHz: number): {
  renderFrames: number;
  deltas: number[];
  rolls: number[];
} {
  vi.useFakeTimers();
  let renderFrames = 0;
  let roll = 0;
  const deltas: number[] = [];
  const rolls: number[] = [];
  const renderInterval = setInterval(() => {
    renderFrames += 1;
  }, 1_000 / renderHz);
  const pump = startFlightControlPump({
    input: {
      getControls(deltaSeconds) {
        deltas.push(deltaSeconds);
        roll += deltaSeconds * 2;
        return { ...BASE_CONTROLS, roll };
      },
      consumeActions: () => [],
    },
    simulation: {
      setControls: (controls) => rolls.push(controls.roll),
    },
    phase: () => "flying",
    handleActions: () => {},
    now: () => Date.now(),
  });

  vi.advanceTimersByTime(100);
  clearInterval(renderInterval);
  pump.dispose();
  const result = { renderFrames, deltas, rolls };
  vi.clearAllTimers();
  vi.useRealTimers();
  return result;
}

describe("fixed-step flight control pump with wall-time catch-up", () => {
  it("keeps control cadence and trajectory identical at 30, 60, and 120 render fps", () => {
    const at120 = controlTrajectoryAtRenderRate(120);
    const at60 = controlTrajectoryAtRenderRate(60);
    const at30 = controlTrajectoryAtRenderRate(30);

    expect(at120.renderFrames).toBeGreaterThan(at60.renderFrames);
    expect(at60.renderFrames).toBeGreaterThan(at30.renderFrames);
    // Fixed steps, as many as the fake clock says elapsed by the last callback.
    expect(at120.deltas.length).toBeGreaterThanOrEqual(11);
    expect(at120.deltas.length).toBeLessThanOrEqual(12);
    expect(at60.deltas).toEqual(at120.deltas);
    expect(at30.deltas).toEqual(at120.deltas);
    expect(at60.rolls).toEqual(at120.rolls);
    expect(at30.rolls).toEqual(at120.rolls);
    expect(at120.deltas.every((delta) => delta === CONTROL_PUMP_STEP_SECONDS)).toBe(true);
  });

  it("applies a bounded catch-up, not the whole stall, when a callback is delayed", () => {
    vi.useFakeTimers();
    let clock = 0;
    const deltas: number[] = [];
    let posts = 0;
    const pump = startFlightControlPump({
      input: {
        getControls(deltaSeconds) {
          deltas.push(deltaSeconds);
          return BASE_CONTROLS;
        },
        consumeActions: () => [],
      },
      simulation: { setControls: () => { posts += 1; } },
      phase: () => "flying",
      handleActions: () => {},
      now: () => clock,
    });

    // A callback 100 ms late models a timer held up by a long main-thread
    // task. It must not replay 100 ms as one control throw: at most 50 ms of
    // fixed steps apply, and the controls post once.
    clock = 100;
    pump.tick();
    expect(CONTROL_PUMP_MAX_CATCH_UP_STEPS * CONTROL_PUMP_STEP_SECONDS).toBeCloseTo(0.05, 12);
    expect(deltas).toEqual(Array(CONTROL_PUMP_MAX_CATCH_UP_STEPS).fill(CONTROL_PUMP_STEP_SECONDS));
    expect(posts).toBe(1);
    pump.dispose();
  });

  /** Keyboard-style throttle: 0.6 per second of control time, as InputManager integrates it. */
  function throttleRamp(tickHz: number, seconds: number): { reachedFullAtMs: number | null; at1s: number } {
    vi.useFakeTimers();
    let clock = 0;
    let throttle = 0;
    let reachedFullAtMs: number | null = null;
    let at1s = Number.NaN;
    const pump = startFlightControlPump({
      input: {
        getControls(deltaSeconds) {
          throttle = Math.min(1, throttle + 0.6 * deltaSeconds);
          return { ...BASE_CONTROLS, throttle };
        },
        consumeActions: () => [],
      },
      simulation: {
        setControls(controls) {
          if (reachedFullAtMs === null && controls.throttle >= 1) reachedFullAtMs = clock;
        },
      },
      phase: () => "flying",
      handleActions: () => {},
      now: () => clock,
    });
    const period = 1_000 / tickHz;
    for (let tick = 1; tick * period <= seconds * 1_000 + 1e-6; tick += 1) {
      clock = tick * period;
      pump.tick();
      if (Math.abs(clock - 1_000) < period / 2) at1s = throttle;
    }
    pump.dispose();
    return { reachedFullAtMs, at1s };
  }

  it("reaches full throttle in the same wall time when callbacks starve to 30 Hz", () => {
    // Measured at Chrome's 4x CPU throttle: 29-31 callbacks a second. With
    // one step per callback the lever took four times as long to move.
    const full = throttleRamp(120, 2.5);
    const starved = throttleRamp(30, 2.5);
    expect(full.reachedFullAtMs).not.toBeNull();
    expect(starved.reachedFullAtMs).not.toBeNull();
    // 1 / 0.6 s = 1,667 ms of control time either way; the starved pump can
    // only notice it at its own 33 ms callbacks.
    expect(Math.abs(starved.reachedFullAtMs! - full.reachedFullAtMs!)).toBeLessThanOrEqual(1_000 / 30);
    expect(starved.at1s).toBeCloseTo(full.at1s, 9);
    expect(full.at1s).toBeCloseTo(0.6, 9);
  });

  it("posts a key edge at once and repays the borrowed step", () => {
    vi.useFakeTimers();
    let clock = 0;
    let steps = 0;
    let posts = 0;
    const keys = new EventTarget();
    const pump = startFlightControlPump({
      input: {
        getControls() {
          steps += 1;
          return BASE_CONTROLS;
        },
        consumeActions: () => [],
      },
      simulation: { setControls: () => { posts += 1; } },
      phase: () => "flying",
      handleActions: () => {},
      now: () => clock,
      keyEvents: keys,
    });

    clock = 2;
    keys.dispatchEvent(new Event("keydown"));
    expect(posts).toBe(1);
    expect(steps).toBe(1);
    // Auto-repeat is a held key: no extra tick, no second borrow.
    clock = 3;
    keys.dispatchEvent(Object.assign(new Event("keydown"), { repeat: true }));
    expect(posts).toBe(1);
    // Over 100 ms the steps applied still equal the elapsed time: the borrow
    // is repaid by the next callbacks rather than added on top.
    for (let t = 1; t * (1_000 / 120) <= 100 + 1e-9; t += 1) {
      clock = t * (1_000 / 120);
      pump.tick();
    }
    expect(steps).toBe(12);
    pump.dispose();
  });

  it("does not replay time spent paused as control steps", () => {
    vi.useFakeTimers();
    let clock = 0;
    let steps = 0;
    let phase: ControlPumpPhase = "paused";
    const pump = startFlightControlPump({
      input: {
        getControls() {
          steps += 1;
          return BASE_CONTROLS;
        },
        consumeActions: () => [],
      },
      simulation: { setControls: () => {} },
      phase: () => phase,
      handleActions: () => {},
      now: () => clock,
    });
    for (let t = 1; t <= 120; t += 1) {
      clock = t * (1_000 / 120);
      pump.tick();
    }
    expect(steps).toBe(0);
    phase = "flying";
    clock += 1_000 / 120;
    pump.tick();
    expect(steps).toBe(1);
    pump.dispose();
  });

  it("does not send controls while paused and stops all work when disposed", () => {
    vi.useFakeTimers();
    // One callback = one fixed step of wall time. The fake timers' Date moves
    // in whole milliseconds, which would read 8 ms and apply no step at all.
    let clock = 0;
    const nextCallback = (): void => {
      clock += 1_000 / 120;
      vi.advanceTimersToNextTimer();
    };
    let phase: ControlPumpPhase = "paused";
    let controlReads = 0;
    let controlPosts = 0;
    let actionReads = 0;
    const handled: InputAction[][] = [];
    const pump = startFlightControlPump({
      input: {
        getControls() {
          controlReads += 1;
          return BASE_CONTROLS;
        },
        consumeActions() {
          actionReads += 1;
          return actionReads === 1 ? ["pause"] : [];
        },
      },
      simulation: { setControls: () => { controlPosts += 1; } },
      phase: () => phase,
      handleActions(actions) {
        handled.push(actions);
        if (actions.includes("pause")) phase = "flying";
      },
      now: () => clock,
    });

    nextCallback();
    expect(controlReads).toBe(0);
    expect(controlPosts).toBe(0);
    expect(handled).toEqual([["pause"]]);
    nextCallback();
    expect(controlReads).toBe(1);
    expect(controlPosts).toBe(1);

    pump.dispose();
    const readsAtDispose = actionReads;
    vi.advanceTimersByTime(100);
    expect(actionReads).toBe(readsAtDispose);
    expect(controlPosts).toBe(1);
  });

  it("delegates menu actions so the handler can keep global HUD input live", () => {
    vi.useFakeTimers();
    let actionReads = 0;
    let handled = 0;
    const pump = startFlightControlPump({
      input: {
        getControls: () => BASE_CONTROLS,
        consumeActions() {
          actionReads += 1;
          return ["hud"];
        },
      },
      simulation: { setControls: () => { throw new Error("menu posted controls"); } },
      phase: () => "menu",
      handleActions: () => { handled += 1; },
    });

    vi.advanceTimersToNextTimer();
    expect(actionReads).toBe(1);
    expect(handled).toBe(1);
    pump.dispose();
  });
});
