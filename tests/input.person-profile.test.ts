import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET_OUT_HOLD_SECONDS, InputManager, personMoveFromView } from "../src/input";

/**
 * The walker's input profile and the walking session's switch between it and
 * the car's: W A S D move relative to the camera, Space jumps, X gets in on a
 * press and out only on a hold, and the switch keeps the car's press counts.
 * Driven through a real InputManager on stubbed window, document and gamepad
 * globals, as the car profile's test is.
 */

type Listener = (event: { code: string; repeat: boolean; target: unknown; preventDefault: () => void }) => void;

const listeners = new Map<string, Listener[]>();
let buttons: { value: number }[] = [];
let axes = [0, 0, 0, 0];

function pad(pressed: number[], stick: number[] = [0, 0, 0, 0]): void {
  buttons = Array.from({ length: 17 }, (_, index) => ({ value: pressed.includes(index) ? 1 : 0 }));
  axes = stick;
}

function key(type: "keydown" | "keyup", code: string): void {
  for (const listener of listeners.get(type) ?? []) {
    listener({ code, repeat: false, target: null, preventDefault: () => undefined });
  }
}

function createInput(spawn: "foot" | "airfield"): InputManager {
  const canvas = { addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as HTMLCanvasElement;
  const input = new InputManager(canvas, { sensitivity: 1, deadZone: 0.1, invertPitch: false, mouseFlight: false });
  input.resetForSpawn(spawn);
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
    exitPointerLock: () => undefined,
  });
  vi.stubGlobal("navigator", {
    getGamepads: () => [{ connected: true, mapping: "standard", axes, buttons }],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("person move", () => {
  it("turns the keys by the camera's heading, headings growing to the left", () => {
    // Facing north (+Z): forward is +Z, right is -X.
    expect(personMoveFromView(1, 0, 0).z).toBeCloseTo(1, 12);
    expect(personMoveFromView(0, 1, 0).x).toBeCloseTo(-1, 12);
    // Facing +X (heading 90 degrees): right is +Z, the body's starboard.
    const right = personMoveFromView(0, 1, Math.PI / 2);
    expect(right.x).toBeCloseTo(0, 12);
    expect(right.z).toBeCloseTo(1, 12);
    const diagonal = personMoveFromView(1, 1, 0.3);
    expect(Math.hypot(diagonal.x, diagonal.z)).toBeCloseTo(1, 12);
  });
});

describe("person profile", () => {
  it("sends the walker's controls on a foot start, and no car block", () => {
    const input = createInput("foot");
    expect(input.inputProfile).toBe("person");
    input.setCharacterView(Math.PI / 2, 0.2);
    key("keydown", "KeyW");
    key("keydown", "ShiftLeft");
    const controls = input.getControls(1 / 60);
    expect(controls.car).toBeUndefined();
    expect(controls.person?.moveX).toBeCloseTo(1, 12);
    expect(controls.person?.moveZ).toBeCloseTo(0, 12);
    expect(controls.person?.run).toBe(true);
    expect(controls.person?.lookPitch).toBe(0.2);
    key("keydown", "Space");
    expect(input.getControls(1 / 60).person?.jumpPresses).toBe(1);
    pad([0]);
    expect(input.getControls(1 / 60).person?.jumpPresses).toBe(2);
    pad([1]);
    expect(input.getControls(1 / 60).person?.dive).toBe(true);
  });

  it("drops the aircraft and boat actions on foot, and keeps camera, reset and pause", () => {
    const input = createInput("foot");
    for (const code of ["KeyF", "KeyG", "KeyL", "KeyM", "KeyC", "KeyR", "Escape"]) key("keydown", code);
    expect(input.consumeActions().sort()).toEqual(["camera", "pause", "reset"]);
  });

  it("counts X as a press on foot, and only a held X in the car", () => {
    const input = createInput("foot");
    expect(input.getControls(1 / 60).interactPresses).toBe(0);
    key("keydown", "KeyX");
    expect(input.getControls(1 / 60).interactPresses).toBe(1);
    key("keyup", "KeyX");

    input.setWalkingProfile("car");
    expect(input.inputProfile).toBe("car");
    key("keydown", "KeyX");
    let presses = 0;
    for (let t = 0; t < GET_OUT_HOLD_SECONDS - 0.05; t += 1 / 60) presses = input.getControls(1 / 60).interactPresses ?? -1;
    expect(presses).toBe(1);
    for (let t = 0; t < 0.2; t += 1 / 60) presses = input.getControls(1 / 60).interactPresses ?? -1;
    expect(presses).toBe(2);
    // Held on through the switch to walking, it does not count again.
    input.setWalkingProfile("person");
    expect(input.getControls(1 / 60).interactPresses).toBe(2);
    key("keyup", "KeyX");
    key("keydown", "KeyX");
    expect(input.getControls(1 / 60).interactPresses).toBe(3);
  });

  it("keeps the car's press counts across getting out and back in", () => {
    const input = createInput("airfield");
    key("keydown", "KeyL");
    key("keydown", "KeyT");
    const before = input.getControls(1 / 60).car!;
    input.setWalkingProfile("person");
    input.getControls(1 / 60);
    input.setWalkingProfile("car");
    const after = input.getControls(1 / 60).car!;
    expect(after.headlightPresses).toBe(before.headlightPresses);
    expect(after.rangePresses).toBe(before.rangePresses);
    expect(after.accelerator).toBe(0);
  });

  it("gathers the right stick's look for the camera, and clears it once read", () => {
    const input = createInput("foot");
    pad([], [0, 0, 1, 0]);
    input.getControls(0.5);
    const look = input.consumeLook();
    expect(look.yaw).toBeCloseTo(1.3, 6);
    expect(input.consumeLook().yaw).toBe(0);
  });
});
