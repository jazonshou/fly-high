import { describe, expect, it } from "vitest";
import type { PersonBoardingState, PersonVisualState } from "../src/game/types";
import { gripPoint, SEAT } from "../src/render/webgpu/person/carSeat";
import { PROPORTIONS } from "../src/render/webgpu/person/figureProportions";
import { PersonMotion, type MotionInput } from "../src/render/webgpu/person/motion";
import { rotateVector } from "../src/render/webgpu/person/pose";
import { BONE, BONE_COUNT, SIDES } from "../src/render/webgpu/person/skeleton";
import { PERSON } from "../src/vehicles/person";
import { motionInput, motionOutput, personState } from "./personMotionRig";

/**
 * The walker's motion besides the gait (render.person-gait): every mode
 * draws a whole pose; the swimmer's eye rides where the sim floats it; the
 * driver holds the wheel and the pedals; getting in and out start and end
 * where the seat and the door stand are; the landings and the climb take
 * the walker's own times; first person hides the head; the head turns
 * where the camera looks.
 */

const DT = 1 / 60;
const v = new Float64Array(3);

function run(motion: PersonMotion, input: MotionInput, seconds: number, each?: (time: number) => void): void {
  const out = motionOutput();
  const frames = Math.round(seconds / DT);
  for (let frame = 1; frame <= frames; frame += 1) {
    motion.update(input, DT, out);
    each?.(frame * DT);
  }
}

function expectWhole(motion: PersonMotion, label: string): void {
  const pose = motion.pose;
  for (let bone = 0; bone < BONE_COUNT; bone += 1) {
    for (let k = 0; k < 3; k += 1) expect(Number.isFinite(pose.globalPositions[bone * 3 + k]!), `${label} bone ${bone}`).toBe(true);
    const q = pose.globalRotations;
    const length = Math.hypot(q[bone * 4]!, q[bone * 4 + 1]!, q[bone * 4 + 2]!, q[bone * 4 + 3]!);
    expect(length, `${label} bone ${bone}`).toBeCloseTo(1, 6);
  }
}

function point(motion: PersonMotion, bone: number): [number, number, number] {
  const g = motion.pose.globalPositions;
  return [g[bone * 3]!, g[bone * 3 + 1]!, g[bone * 3 + 2]!];
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

function boarding(action: PersonBoardingState["action"], progress: number): PersonVisualState {
  return personState("board", { boarding: { action, progress, side: "right" } });
}

describe("every mode of the walker", () => {
  const swimming = { waterDepth: 3, submersion: 0.8, headDepth: -0.05, grounded: false, surface: -2 } as const;
  const cases: [string, PersonVisualState, Partial<MotionInput>][] = [
    ["stand", personState("stand"), {}],
    ["walk", personState("walk", { speed: 1.4 }), { forward: 1.4 }],
    ["run", personState("run", { speed: 4.5 }), { forward: 4.5 }],
    ["wade", personState("wade", { speed: 0.8, waterDepth: 0.6, submersion: 0.3 }), { forward: 0.8 }],
    ["air", personState("air", { speed: 2, grounded: false }), { forward: 2, up: -6 }],
    ["hard landing", personState("land", { landingSpeed: 6, landingAge: 0.2 }), {}],
    ["roll", personState("land", { landingSpeed: 9, landingAge: 0.5, speed: 2 }), {}],
    ["breaststroke", personState("swim", { ...swimming, speed: 0.8 }), { forward: 0.8 }],
    ["crawl", personState("swim", { ...swimming, speed: 1.3, running: true }), { forward: 1.3 }],
    ["treading water", personState("swim", { ...swimming }), {}],
    ["dive", personState("dive", { ...swimming, headDepth: 2, swimPitch: -0.6, speed: 1 }), { forward: 1 }],
    ["water mantle", personState("mantle", { swimPitch: -0.2, waterDepth: 2 }), {}],
    ["climb", personState("mantle", { swimPitch: Math.PI / 2 }), { up: 1 }],
    ["seated", personState("seated"), { steeringWheel: 2 }],
    ["getting in", boarding("getIn", 0.5), {}],
    ["getting out", boarding("getOut", 0.5), {}],
  ];

  it.each(cases)("%s draws a whole pose", (label, person, patch) => {
    const motion = new PersonMotion();
    run(motion, motionInput(person, patch), 3);
    expectWhole(motion, label);
  });

  it("goes through every mode in turn without a broken frame", () => {
    const motion = new PersonMotion();
    for (const [label, person, patch] of cases) {
      run(motion, motionInput(person, patch), 0.4, () => expectWhole(motion, label));
    }
  });
});

describe("the swimmer", () => {
  it.each([
    ["breaststroke", personState("swim", { speed: 0.8, waterDepth: 3, submersion: 0.8, headDepth: -0.05, grounded: false })],
    ["crawl", personState("swim", { speed: 1.3, running: true, waterDepth: 3, submersion: 0.9, headDepth: -0.05, grounded: false })],
    ["dive", personState("dive", { speed: 1, waterDepth: 6, submersion: 1, headDepth: 2, swimPitch: -0.5, grounded: false })],
  ])("%s keeps its eyes where the sim floats them: the root's eye height", (_label, person) => {
    const motion = new PersonMotion();
    let worst = 0;
    run(motion, motionInput(person, { forward: person.speed }), 4, (time) => {
      if (time < 1) return;
      motion.pose.posedPoint(BONE.head, 0.085, PERSON.eyeHeight, 0, v, 0);
      worst = Math.max(worst, Math.hypot(v[0]!, v[1]! - PERSON.eyeHeight, v[2]!));
    });
    expect(worst).toBeLessThan(0.01);
  });

  it("swims in the water, not on it: the shoulders and hips under, the breaststroke's hands never out", () => {
    // The eye floats 5 cm up, so the water is 5 cm under the root's eye height.
    const surface = PERSON.eyeHeight - 0.05;
    const height = (motion: PersonMotion, bone: number): number => motion.pose.globalPositions[bone * 3 + 1]! - surface;
    const hands = [BONE.handL, BONE.fingersL, BONE.handR, BONE.fingersR];

    const breast = new PersonMotion();
    let breastHand = -Infinity;
    let breastShoulder = -Infinity;
    let breastPelvis = -Infinity;
    run(breast, motionInput(personState("swim", { speed: 0.8, waterDepth: 3, submersion: 0.8, headDepth: -0.05, grounded: false }), { forward: 0.8 }), 4, (time) => {
      if (time < 1) return;
      for (const bone of hands) breastHand = Math.max(breastHand, height(breast, bone));
      breastShoulder = Math.max(breastShoulder, height(breast, BONE.upperArmL), height(breast, BONE.upperArmR));
      breastPelvis = Math.max(breastPelvis, height(breast, BONE.pelvis));
    });
    expect(breastHand).toBeLessThan(0);
    expect(breastShoulder).toBeLessThan(-0.05);
    expect(breastPelvis).toBeLessThan(-0.2);

    // The crawl's recovering arm comes out over the water for a part of its cycle; the body and the other shoulder stay in it.
    const crawl = new PersonMotion();
    let crawlLowShoulder = -Infinity;
    let crawlPelvis = -Infinity;
    let crawlHandOut = 0;
    let frames = 0;
    run(crawl, motionInput(personState("swim", { speed: 1.3, running: true, waterDepth: 3, submersion: 0.9, headDepth: -0.05, grounded: false }), { forward: 1.3 }), 4, (time) => {
      if (time < 1) return;
      frames += 1;
      crawlLowShoulder = Math.max(crawlLowShoulder, Math.min(height(crawl, BONE.upperArmL), height(crawl, BONE.upperArmR)));
      crawlPelvis = Math.max(crawlPelvis, height(crawl, BONE.pelvis));
      if (height(crawl, BONE.handL) > 0) crawlHandOut += 1;
    });
    expect(crawlLowShoulder).toBeLessThan(0);
    expect(crawlPelvis).toBeLessThan(-0.1);
    expect(crawlHandOut / frames).toBeGreaterThan(0.15);
    expect(crawlHandOut / frames).toBeLessThan(0.45);
  });

  it("lies prone swimming and upright treading water", () => {
    const up = (motion: PersonMotion): number => {
      rotateVector(motion.pose.globalRotations, BONE.spine3 * 4, 0, 1, 0, v, 0);
      return v[1]!;
    };
    const swimming = new PersonMotion();
    run(swimming, motionInput(personState("swim", { speed: 1.3, running: true, waterDepth: 3, headDepth: -0.05, grounded: false }), { forward: 1.3 }), 3);
    expect(Math.abs(up(swimming))).toBeLessThan(0.5);
    const treading = new PersonMotion();
    run(treading, motionInput(personState("swim", { waterDepth: 3, headDepth: -0.05, grounded: false })), 3);
    expect(up(treading)).toBeGreaterThan(0.85);
  });
});

describe("the driver", () => {
  type Point = [number, number, number];
  function grips(steeringWheel: number): [Point, Point] {
    const out = new Float64Array(6);
    gripPoint(-(Math.PI / 2 + 0.15) + steeringWheel, out, 0);
    gripPoint(Math.PI / 2 + 0.15 + steeringWheel, out, 3);
    return [[out[0]!, out[1]!, out[2]!], [out[3]!, out[4]!, out[5]!]];
  }

  it("holds the wheel at a quarter to three and the pedals with a straight wheel", () => {
    const motion = new PersonMotion();
    run(motion, motionInput(personState("seated")), 1);
    const [left, right] = grips(0);
    // The wrists a palm short of the grips.
    expect(Math.abs(distance(point(motion, SIDES[0]!.hand), left) - 0.075)).toBeLessThan(0.02);
    expect(Math.abs(distance(point(motion, SIDES[1]!.hand), right) - 0.075)).toBeLessThan(0.02);
    // Each hand on its own side of the hub, below its top.
    expect(point(motion, SIDES[1]!.hand)[2]).toBeGreaterThan(SEAT.wheelCentre[2] + 0.1);
    expect(point(motion, SIDES[0]!.hand)[2]).toBeLessThan(SEAT.wheelCentre[2] - 0.1);
    expect(distance(point(motion, SIDES[1]!.foot), SEAT.rightPedal)).toBeLessThan(0.03);
    expect(distance(point(motion, SIDES[0]!.foot), SEAT.leftPedal)).toBeLessThan(0.03);
  });

  it("follows the wheel round and back to the same grips", () => {
    const motion = new PersonMotion();
    const straight = motionInput(personState("seated"));
    run(motion, straight, 1);
    const before = [point(motion, SIDES[0]!.hand), point(motion, SIDES[1]!.hand)];
    for (let k = 0; k <= 60; k += 1) {
      run(motion, motionInput(personState("seated"), { steeringWheel: (2.5 * k) / 60 }), DT);
      expectWhole(motion, `wheel ${k}`);
    }
    for (let k = 60; k >= 0; k -= 1) run(motion, motionInput(personState("seated"), { steeringWheel: (2.5 * k) / 60 }), DT);
    run(motion, straight, 1);
    expect(distance(point(motion, SIDES[0]!.hand), before[0]!)).toBeLessThan(0.01);
    expect(distance(point(motion, SIDES[1]!.hand), before[1]!)).toBeLessThan(0.01);
  });

  it("does not let go of the wheel held just past a re-grip", () => {
    const motion = new PersonMotion();
    const held = motionInput(personState("seated"), { steeringWheel: (2 * Math.PI) / 12 });
    run(motion, held, 1);
    const hands = [point(motion, SIDES[0]!.hand), point(motion, SIDES[1]!.hand)];
    for (let k = 0; k < 120; k += 1) {
      const wobble = (k % 2 === 0 ? 1 : -1) * 0.04;
      run(motion, motionInput(personState("seated"), { steeringWheel: (2 * Math.PI) / 12 + wobble }), DT);
    }
    run(motion, held, 0.5);
    expect(distance(point(motion, SIDES[0]!.hand), hands[0]!)).toBeLessThan(0.01);
    expect(distance(point(motion, SIDES[1]!.hand), hands[1]!)).toBeLessThan(0.01);
  });
});

describe("getting in and out", () => {
  it("ends getting in where the seated driver sits, and starts getting out from there", () => {
    const seated = new PersonMotion();
    run(seated, motionInput(personState("seated")), 1);
    const gotIn = new PersonMotion();
    run(gotIn, motionInput(boarding("getIn", 1)), 1);
    const gettingOut = new PersonMotion();
    run(gettingOut, motionInput(boarding("getOut", 0)), 1);
    for (const bone of [BONE.pelvis, BONE.head, SIDES[0]!.hand, SIDES[1]!.foot]) {
      expect(distance(point(gotIn, bone), point(seated, bone))).toBeLessThan(0.02);
      expect(distance(point(gettingOut, bone), point(seated, bone))).toBeLessThan(0.02);
    }
  });

  it("ends getting out standing at the door stand on the ground", () => {
    const motion = new PersonMotion();
    run(motion, motionInput(boarding("getOut", 1)), 2);
    const pelvis = point(motion, BONE.pelvis);
    expect(Math.hypot(pelvis[0] - SEAT.doorStand[0], pelvis[2] - SEAT.doorStand[2])).toBeLessThan(0.15);
    expect(pelvis[1] - SEAT.ground).toBeGreaterThan(PROPORTIONS.hipHeight - 0.05);
    for (const side of SIDES) expect(point(motion, side.foot)[1] - SEAT.ground).toBeLessThan(0.12);
  });

  it("moves without a jump through the whole of getting in and out", () => {
    for (const action of ["getIn", "getOut"] as const) {
      const motion = new PersonMotion();
      let last: [number, number, number] | null = null;
      let worst = 0;
      const seconds = action === "getIn" ? PERSON.getInSeconds : PERSON.getOutSeconds;
      const frames = Math.round(seconds / DT);
      for (let frame = 0; frame <= frames; frame += 1) {
        run(motion, motionInput(boarding(action, frame / frames)), DT);
        const head = point(motion, BONE.head);
        if (last) worst = Math.max(worst, distance(head, last));
        last = head;
      }
      // No pop: the head never moves faster than a quick swing out of the seat's 6 m/s.
      expect(worst, action).toBeLessThan(6 * DT);
    }
  });
});

describe("landings", () => {
  it("strikes the ground on a landing, not on a plunge into water", () => {
    const motion = new PersonMotion();
    const out = motionOutput();
    motion.update(motionInput(personState("air", { grounded: false, landingAge: 5 })), DT, out);
    motion.update(motionInput(personState("walk", { speed: 1, landingSpeed: 3, landingAge: 0 })), DT, out);
    expect(out.footStrikes).toBeGreaterThanOrEqual(1);
    expect(out.strikeStrength).toBeGreaterThan(0.3);
    expect(out.strikeStrength).toBeLessThanOrEqual(1);
    const plunge = new PersonMotion();
    plunge.update(motionInput(personState("air", { grounded: false, landingAge: 5 })), DT, out);
    plunge.update(motionInput(personState("swim", { grounded: false, waterDepth: 3, headDepth: 0.3, landingSpeed: 6, landingAge: 0 })), DT, out);
    expect(out.footStrikes).toBe(0);
  });

  it("crouches a hard landing over the walker's hard-landing time and stands again", () => {
    const motion = new PersonMotion();
    run(motion, motionInput(personState("stand")), 1);
    const standing = point(motion, BONE.pelvis)[1];
    let lowest = Infinity;
    let lowestAt = 0;
    const out = motionOutput();
    for (let frame = 0; frame * DT <= PERSON.landingHardSeconds; frame += 1) {
      const age = frame * DT;
      motion.update(motionInput(personState("land", { landingSpeed: 7, landingAge: age })), DT, out);
      const y = point(motion, BONE.pelvis)[1];
      if (y < lowest) {
        lowest = y;
        lowestAt = age;
      }
    }
    expect(standing - lowest).toBeGreaterThan(0.2);
    expect(lowestAt).toBeLessThan(0.5 * PERSON.landingHardSeconds);
    expect(standing - point(motion, BONE.pelvis)[1]).toBeLessThan(0.03);
  });

  it("rolls over once in the walker's roll time and comes up on its feet", () => {
    const motion = new PersonMotion();
    run(motion, motionInput(personState("stand")), 1);
    let lowestUp = 1;
    const out = motionOutput();
    for (let frame = 0; frame * DT <= PERSON.landingRollSeconds; frame += 1) {
      motion.update(motionInput(personState("land", { landingSpeed: 9, landingAge: frame * DT, speed: 2 })), DT, out);
      rotateVector(motion.pose.globalRotations, BONE.pelvis * 4, 0, 1, 0, v, 0);
      lowestUp = Math.min(lowestUp, v[1]!);
    }
    expect(lowestUp).toBeLessThan(-0.8);
    rotateVector(motion.pose.globalRotations, BONE.pelvis * 4, 0, 1, 0, v, 0);
    expect(v[1]!).toBeGreaterThan(0.95);
    for (const side of SIDES) expect(point(motion, side.foot)[1]).toBeLessThan(0.15);
  });
});

describe("the climb onto a ledge from the feet", () => {
  /** The sim's path for a climb of `height` onto a ledge `reach` ahead (W1's walker: rise over 60%, over in the last 70%). */
  function climb(height: number, reach: number, each: (t: number, motion: PersonMotion, root: readonly [number, number]) => void): PersonMotion {
    const motion = new PersonMotion();
    run(motion, motionInput(personState("stand")), 1);
    const out = motionOutput();
    const smooth = (a: number, b: number, x: number): number => {
      const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return u * u * (3 - 2 * u);
    };
    let x = 0;
    let y = 0;
    const frames = Math.round(PERSON.mantleSeconds / DT) + 30;
    for (let frame = 1; frame <= frames; frame += 1) {
      const t = Math.min(1, (frame * DT) / PERSON.mantleSeconds);
      const nx = reach * smooth(0.3, 1, t);
      const ny = height * smooth(0, 0.6, t);
      const forward = (nx - x) / DT;
      const up = (ny - y) / DT;
      x = nx;
      y = ny;
      const rootX = x;
      const rootY = y;
      const person = t < 1 ? personState("mantle", { swimPitch: Math.PI / 2 }) : personState("stand");
      // The drawn terrain stays at the climb's foot: the ledge is a collider it does not draw.
      motion.update(motionInput(person, { forward, up, ground: () => -rootY }), DT, out);
      each(t, motion, [rootX, rootY]);
    }
    return motion;
  }

  it.each([[1.0, 0.65], [0.7, 0.35]])("puts the hands on a top %f m up and stands on it", (height, reach) => {
    let worstHand = 0;
    const motion = climb(height, reach, (t, m, root) => {
      if (t < 0.2 || t > 0.5) return;
      for (const side of SIDES) {
        const wrist = point(m, side.hand);
        worstHand = Math.max(worstHand, Math.abs(root[1] + wrist[1] - (height + 0.04)));
      }
    });
    expect(worstHand).toBeLessThan(0.05);
    // Standing on the top at the end, both feet on it.
    expectWhole(motion, "climb");
    for (const side of SIDES) expect(Math.abs(point(motion, side.foot)[1] - PROPORTIONS.ankleHeight)).toBeLessThan(0.03);
    expect(point(motion, BONE.pelvis)[1]).toBeGreaterThan(PROPORTIONS.hipHeight - 0.03);
  });

  it("has a foot on the top before the sim's climb ends", () => {
    let onTop = -1;
    climb(1.0, 0.65, (t, motion) => {
      if (onTop < 0 && motion.feet.feet[0].planted) onTop = t;
    });
    expect(onTop).toBeGreaterThan(0.55);
    expect(onTop).toBeLessThan(0.8);
  });
});

describe("the head", () => {
  it("shrinks into the neck in first person and comes back", () => {
    const motion = new PersonMotion();
    motion.setFirstPersonView(true);
    run(motion, motionInput(personState("walk", { speed: 1.2 }), { forward: 1.2 }), 0.5);
    expect(motion.pose.globalScales[BONE.head]!).toBeLessThan(0.01);
    motion.setFirstPersonView(false);
    run(motion, motionInput(personState("walk", { speed: 1.2 }), { forward: 1.2 }), 0.1);
    expect(motion.pose.globalScales[BONE.head]!).toBeCloseTo(1, 6);
  });

  it("turns toward where the camera looks, and not past what a neck can", () => {
    const facing = (lookYaw: number): number => {
      const motion = new PersonMotion();
      run(motion, motionInput(personState("stand"), { lookYaw }), 1.5);
      rotateVector(motion.pose.globalRotations, BONE.head * 4, 1, 0, 0, v, 0);
      return Math.atan2(v[2]!, v[0]!);
    };
    expect(Math.abs(facing(0))).toBeLessThan(0.1);
    expect(facing(0.6)).toBeGreaterThan(0.4);
    expect(facing(-0.6)).toBeLessThan(-0.4);
    expect(facing(1.5)).toBeLessThan(1.35);
  });
});
