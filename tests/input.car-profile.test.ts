import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CarControlState } from "../src/game/types";
import { CAR_PAD_PRESSES, CAR_PRESS_KEYS, carSteerRateScale, InputManager } from "../src/input";

/**
 * The car's input profile: the D-pad counts the same presses as T, K, B and
 * L, the bumpers shift, and the keyboard wheel winds more slowly the faster
 * the car goes. Driven through a real InputManager on stubbed window,
 * document and gamepad globals.
 */

type Listener = (event: { code: string; repeat: boolean; target: unknown; preventDefault: () => void }) => void;

const listeners = new Map<string, Listener[]>();
let buttons: { value: number }[] = [];

function pad(pressed: number[]): void {
  buttons = Array.from({ length: 17 }, (_, index) => ({ value: pressed.includes(index) ? 1 : 0 }));
}

function key(type: "keydown" | "keyup", code: string): void {
  for (const listener of listeners.get(type) ?? []) {
    listener({ code, repeat: false, target: null, preventDefault: () => undefined });
  }
}

function car(input: InputManager, deltaSeconds = 1 / 60): CarControlState {
  const controls = input.getControls(deltaSeconds).car;
  if (!controls) throw new Error("the car profile sends car controls");
  return controls;
}

function createInput(): InputManager {
  const canvas = { addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as HTMLCanvasElement;
  const input = new InputManager(canvas, { sensitivity: 1, deadZone: 0.1, invertPitch: false, mouseFlight: false });
  input.resetForSpawn("airfield");
  return input;
}

beforeEach(() => {
  listeners.clear();
  pad([]);
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    removeEventListener: () => undefined,
  });
  vi.stubGlobal("document", {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    pointerLockElement: null,
  });
  vi.stubGlobal("navigator", {
    getGamepads: () => [{ connected: true, mapping: "standard", axes: [0, 0, 0, 0], buttons }],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the car's input profile", () => {
  it("maps the D-pad to the same presses as T, K, B and L, and the bumpers to the shifts", () => {
    expect(CAR_PAD_PRESSES).toEqual({
      bumperRight: "shiftUpPresses",
      bumperLeft: "shiftDownPresses",
      dpadUp: CAR_PRESS_KEYS.KeyT,
      dpadRight: CAR_PRESS_KEYS.KeyK,
      dpadDown: CAR_PRESS_KEYS.KeyB,
      dpadLeft: CAR_PRESS_KEYS.KeyL,
    });
  });

  it("counts one press per D-pad push, however long it is held", () => {
    const input = createInput();
    // Standard mapping: 12 up, 13 down, 14 left, 15 right.
    pad([12]);
    car(input);
    car(input);
    pad([]);
    car(input);
    pad([15, 14]);
    car(input);
    pad([13]);
    const controls = car(input);
    expect(controls.rangePresses).toBe(1);
    expect(controls.lockPresses).toBe(1);
    expect(controls.headlightPresses).toBe(1);
    expect(controls.downhillAssistPresses).toBe(1);
    expect(controls.shiftUpPresses).toBe(0);
    pad([5]);
    car(input);
    pad([4]);
    const shifted = car(input);
    expect(shifted.shiftUpPresses).toBe(1);
    expect(shifted.shiftDownPresses).toBe(1);
    input.dispose();
  });

  it("counts a key press and a D-pad push on the same counter", () => {
    const input = createInput();
    key("keydown", "KeyT");
    key("keyup", "KeyT");
    pad([12]);
    expect(car(input).rangePresses).toBe(2);
    input.dispose();
  });

  it("eases the keyboard wheel with speed: full at a stop, half at 36 km/h, never under 0.4", () => {
    expect(carSteerRateScale(0)).toBe(1);
    expect(carSteerRateScale(10)).toBeCloseTo(0.5, 12);
    expect(carSteerRateScale(-10)).toBeCloseTo(0.5, 12);
    expect(carSteerRateScale(15)).toBeCloseTo(0.4, 12);
    expect(carSteerRateScale(40)).toBe(0.4);
    expect(carSteerRateScale(Number.NaN)).toBe(1);
  });

  it("winds the wheel from D more slowly at speed, and lets it back to centre at the full rate", () => {
    const standing = createInput();
    const moving = createInput();
    moving.setCarSpeed(25);
    key("keydown", "KeyD");
    const atStop = car(standing, 0.1).steer;
    const atSpeed = car(moving, 0.1).steer;
    expect(atStop).toBeCloseTo(0.28, 6);
    expect(atSpeed).toBeCloseTo(0.28 * 0.4, 6);
    for (let i = 0; i < 30; i += 1) car(moving, 0.1);
    expect(car(moving, 0.1).steer).toBe(1);
    key("keyup", "KeyD");
    // Lock to centre at 3.4 a second whatever the speed.
    expect(car(moving, 0.1).steer).toBeCloseTo(0.66, 6);
    standing.dispose();
    moving.dispose();
  });

  it("starts every drive at a standstill's rate and the road preset", () => {
    const input = createInput();
    input.setCarSpeed(30);
    input.setCarTyrePressure("sand");
    expect(car(input).tyrePressure).toBe("sand");
    input.resetForSpawn("airfield");
    expect(car(input).tyrePressure).toBe("road");
    key("keydown", "KeyA");
    expect(car(input, 0.1).steer).toBeCloseTo(-0.28, 6);
    input.dispose();
  });
});
