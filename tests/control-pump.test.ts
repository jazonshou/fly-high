import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
  });

  vi.advanceTimersByTime(100);
  clearInterval(renderInterval);
  pump.dispose();
  const result = { renderFrames, deltas, rolls };
  vi.clearAllTimers();
  vi.useRealTimers();
  return result;
}

describe("fixed-step flight control pump", () => {
  it("keeps control cadence and trajectory identical at 30, 60, and 120 render fps", () => {
    const at120 = controlTrajectoryAtRenderRate(120);
    const at60 = controlTrajectoryAtRenderRate(60);
    const at30 = controlTrajectoryAtRenderRate(30);

    expect(at120.renderFrames).toBeGreaterThan(at60.renderFrames);
    expect(at60.renderFrames).toBeGreaterThan(at30.renderFrames);
    expect(at120.deltas).toHaveLength(12);
    expect(at60.deltas).toEqual(at120.deltas);
    expect(at30.deltas).toEqual(at120.deltas);
    expect(at60.rolls).toEqual(at120.rolls);
    expect(at30.rolls).toEqual(at120.rolls);
    expect(at120.deltas.every((delta) => delta === CONTROL_PUMP_STEP_SECONDS)).toBe(true);
  });

  it("applies only one bounded step when a callback is delayed", () => {
    vi.useFakeTimers();
    const deltas: number[] = [];
    const pump = startFlightControlPump({
      input: {
        getControls(deltaSeconds) {
          deltas.push(deltaSeconds);
          return BASE_CONTROLS;
        },
        consumeActions: () => [],
      },
      simulation: { setControls: () => {} },
      phase: () => "flying",
      handleActions: () => {},
    });

    // Calling the callback after an arbitrary wall-time jump models a timer
    // delayed by a long render/main-thread task. It must not integrate 100 ms.
    vi.setSystemTime(100);
    pump.tick();
    expect(deltas).toEqual([CONTROL_PUMP_STEP_SECONDS]);
    pump.dispose();
  });

  it("does not send controls while paused and stops all work when disposed", () => {
    vi.useFakeTimers();
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
    });

    vi.advanceTimersToNextTimer();
    expect(controlReads).toBe(0);
    expect(controlPosts).toBe(0);
    expect(handled).toEqual([["pause"]]);
    vi.advanceTimersToNextTimer();
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
