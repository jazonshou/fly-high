import type { PersonVisualState } from "../../src/game/types";
import type { MotionInput, MotionOutput } from "../../src/render/webgpu/person/motion";
import { motionInput, motionOutput, personState } from "../personMotionRig";

/**
 * The walker's motion through all it draws, for the budget and allocation
 * tests: standing, walking and running on a gentle hill, wading, a jump
 * and its landing, a hard landing, a roll, swimming both strokes, diving,
 * the water mantle and the climb, getting in, driving and getting out. One
 * lap is `COURSE_FRAMES` frames at 60 Hz; `input(frame)` is the renderer's
 * input that frame, written into objects made once.
 */

interface Leg {
  readonly frames: number;
  readonly person: PersonVisualState;
  readonly input: MotionInput;
  /** The person's fields that run with the leg's own clock. */
  readonly clock?: "landing" | "boarding";
}

const hill = (forward: number, right: number): number => 0.08 * forward + 0.04 * Math.sin(0.7 * right);
const swim = { waterDepth: 3, submersion: 0.85, headDepth: -0.05, grounded: false, surface: -2 } as const;

function leg(frames: number, person: PersonVisualState, patch: Partial<MotionInput> = {}, clock?: Leg["clock"]): Leg {
  return clock ? { frames, person, input: motionInput(person, patch), clock } : { frames, person, input: motionInput(person, patch) };
}

const LEGS: readonly Leg[] = [
  leg(90, personState("stand"), { ground: hill, lookYaw: 0.5 }),
  leg(240, personState("walk", { speed: 1.4, slope: 0.08 }), { forward: 1.4, up: 0.11, ground: hill, turnRate: 0.3 }),
  leg(240, personState("run", { speed: 4.2, slope: 0.08 }), { forward: 4.2, up: 0.34, ground: hill, turnRate: -0.2 }),
  leg(120, personState("wade", { speed: 0.9, waterDepth: 0.7, submersion: 0.3 }), { forward: 0.9 }),
  leg(40, personState("air", { speed: 3, grounded: false }), { forward: 3, up: -2 }),
  leg(30, personState("land", { landingSpeed: 6 }), {}, "landing"),
  leg(70, personState("land", { landingSpeed: 9, speed: 2 }), {}, "landing"),
  leg(150, personState("swim", { ...swim, speed: 0.8 }), { forward: 0.8 }),
  leg(150, personState("swim", { ...swim, speed: 1.3, running: true }), { forward: 1.3 }),
  leg(120, personState("dive", { ...swim, headDepth: 2, swimPitch: -0.5, speed: 1 }), { forward: 1 }),
  leg(60, personState("mantle", { swimPitch: -0.2, waterDepth: 2 }), { up: 0.6 }),
  leg(60, personState("mantle", { swimPitch: Math.PI / 2 }), { up: 0.8, forward: 0.4 }),
  leg(120, personState("board", { boarding: { action: "getIn", progress: 0, side: "right" } }), {}, "boarding"),
  leg(240, personState("seated"), { steeringWheel: 1.5 }),
  leg(90, personState("board", { boarding: { action: "getOut", progress: 0, side: "right" } }), {}, "boarding"),
];

export const COURSE_FRAMES = LEGS.reduce((sum, item) => sum + item.frames, 0);

export class PersonMotionCourse {
  readonly output: MotionOutput = motionOutput();
  private readonly people = LEGS.map((item) => item.person as { -readonly [K in keyof PersonVisualState]: PersonVisualState[K] });
  private readonly inputs = LEGS.map((item, index) => ({ ...item.input, person: this.people[index]! }) as { -readonly [K in keyof MotionInput]: MotionInput[K] });

  /** The renderer's input on `frame` of the course (laps repeat). */
  input(frame: number): MotionInput {
    let local = frame % COURSE_FRAMES;
    for (let index = 0; index < LEGS.length; index += 1) {
      const item = LEGS[index]!;
      if (local < item.frames) {
        const person = this.people[index]!;
        const input = this.inputs[index]!;
        if (item.clock === "landing") person.landingAge = local / 60;
        if (item.clock === "boarding" && person.boarding) person.boarding.progress = local / (item.frames - 1);
        if (person.mode === "seated") input.steeringWheel = 1.5 * Math.sin(local / 40);
        return input;
      }
      local -= item.frames;
    }
    return this.inputs[0]!;
  }
}
