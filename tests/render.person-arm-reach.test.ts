import { describe, expect, it } from "vitest";
import type { PersonBoardingState } from "../src/game/types";
import { BODY, DOOR_LINES, FRONT_DOOR_HINGE } from "../src/render/webgpu/ground/lc76Lines";
import { ARM_REACH, createHold, PALM_REACH, reachFor, type Hold } from "../src/render/webgpu/person/armReach";
import { doorOpenAt, SEAT } from "../src/render/webgpu/person/carSeat";
import { PersonMotion } from "../src/render/webgpu/person/motion";
import { FigurePose, rotateVector } from "../src/render/webgpu/person/pose";
import { BIND_POSITIONS, SIDES } from "../src/render/webgpu/person/skeleton";
import { boardingWalkSeconds, boardingWalkShare, CAR_SEATING, PERSON } from "../src/vehicles/person";
import { motionInput, motionOutput, personState } from "./personMotionRig";

/**
 * An arm reaching for a hold (`armReach.ts`), and the holds getting in and
 * out of the car (`carSeat.ts`): the wrist comes to the hold with the elbow
 * bent and below it, the hand lies the way the hold says, a hand is only
 * ever on what its arm reaches, and no hand goes through the door.
 */

const DEG = 180 / Math.PI;
const v = new Float64Array(6);

function at(pose: FigurePose, bone: number): [number, number, number] {
  const g = pose.globalPositions;
  return [g[bone * 3]!, g[bone * 3 + 1]!, g[bone * 3 + 2]!];
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

/** The elbow's bend from straight, degrees. */
function elbowBend(pose: FigurePose, side: number): number {
  const bones = SIDES[side]!;
  const s = at(pose, bones.upperArm);
  const e = at(pose, bones.forearm);
  const w = at(pose, bones.hand);
  const u = [e[0] - s[0], e[1] - s[1], e[2] - s[2]];
  const f = [w[0] - e[0], w[1] - e[1], w[2] - e[2]];
  const cos = (u[0]! * f[0]! + u[1]! * f[1]! + u[2]! * f[2]!) / (Math.hypot(...u) * Math.hypot(...f));
  return Math.acos(Math.min(1, Math.max(-1, cos))) * DEG;
}

/** The hand's fingers' and palm's directions as posed (the bind pose's: the fingers down the hand, the palm to the thigh). */
function handWays(pose: FigurePose, side: number): { fingers: number[]; palm: number[] } {
  const bones = SIDES[side]!;
  const b = (bone: number, k: number): number => BIND_POSITIONS[bone * 3 + k]!;
  const f = [b(bones.fingers, 0) - b(bones.hand, 0), b(bones.fingers, 1) - b(bones.hand, 1), b(bones.fingers, 2) - b(bones.hand, 2)];
  const fl = Math.hypot(...f);
  rotateVector(pose.globalRotations, bones.hand * 4, f[0]! / fl, f[1]! / fl, f[2]! / fl, v, 0);
  // The palm faces the thigh, squared to the fingers.
  const dot = (-bones.sign * f[2]!) / fl;
  const n = [(-dot * f[0]!) / fl, (-dot * f[1]!) / fl, -bones.sign - (dot * f[2]!) / fl];
  const nl = Math.hypot(...n);
  rotateVector(pose.globalRotations, bones.hand * 4, n[0]! / nl, n[1]! / nl, n[2]! / nl, v, 3);
  return { fingers: [v[0]!, v[1]!, v[2]!], palm: [v[3]!, v[4]!, v[5]!] };
}

function standing(): FigurePose {
  const pose = new FigurePose();
  pose.computeGlobals();
  return pose;
}

function holdAt(x: number, y: number, z: number, patch: Partial<Hold> = {}): Hold {
  return { ...createHold(), x, y, z, weight: 1, ...patch };
}

const NONE = createHold();
const RIGHT = 1;

describe("an arm reaching for a hold", () => {
  it("brings the wrist a palm short of a grip taken end on, the elbow bent and below the line to it", () => {
    const pose = standing();
    const shoulder = at(pose, SIDES[RIGHT]!.upperArm);
    const hold = holdAt(shoulder[0] + 0.4, shoulder[1] - 0.12, shoulder[2] + 0.02);
    reachFor(pose, NONE, hold);
    const wrist = at(pose, SIDES[RIGHT]!.hand);
    const elbow = at(pose, SIDES[RIGHT]!.forearm);
    expect(distance(wrist, [hold.x, hold.y, hold.z])).toBeCloseTo(PALM_REACH, 3);
    // On the line from the shoulder to the grip.
    expect(distance(wrist, shoulder) + PALM_REACH).toBeCloseTo(distance(shoulder, [hold.x, hold.y, hold.z]), 3);
    expect(elbowBend(pose, RIGHT)).toBeGreaterThan(60);
    // Down and out of the line, not up or across the body.
    const mid = [(shoulder[0] + wrist[0]) / 2, (shoulder[1] + wrist[1]) / 2, (shoulder[2] + wrist[2]) / 2];
    expect(elbow[1]).toBeLessThan(mid[1]! - 0.05);
    expect(elbow[2]).toBeGreaterThan(mid[2]! + 0.03);
  });

  it("never straightens: a hold out of reach draws it out to 35 degrees of bend and no further", () => {
    for (const far of [0.6, 0.8, 2]) {
      const pose = standing();
      const shoulder = at(pose, SIDES[RIGHT]!.upperArm);
      reachFor(pose, NONE, holdAt(shoulder[0] + far, shoulder[1], shoulder[2]));
      expect(elbowBend(pose, RIGHT), `hold ${far} m off`).toBeGreaterThan(30);
      expect(distance(at(pose, SIDES[RIGHT]!.hand), at(pose, SIDES[RIGHT]!.upperArm)), `hold ${far} m off`).toBeLessThan(0.956 * ARM_REACH);
    }
  });

  it("draws out without a snap as the hold goes out of reach", () => {
    let last = 0;
    for (let far = 0.3; far < 1.2; far += 0.01) {
      const pose = standing();
      const shoulder = at(pose, SIDES[RIGHT]!.upperArm);
      reachFor(pose, NONE, holdAt(shoulder[0] + far, shoulder[1] - 0.1, shoulder[2]));
      const reach = distance(at(pose, SIDES[RIGHT]!.hand), at(pose, SIDES[RIGHT]!.upperArm));
      if (last > 0) {
        expect(reach - last, `at ${far.toFixed(2)} m`).toBeLessThan(0.0101);
        expect(reach - last, `at ${far.toFixed(2)} m`).toBeGreaterThan(-1e-3);
      }
      last = reach;
    }
  });

  it("the trunk and the shoulder go after a hold the arm alone would strain for", () => {
    const near = standing();
    const far = standing();
    const shoulder = at(near, SIDES[RIGHT]!.upperArm);
    reachFor(near, NONE, holdAt(shoulder[0] + 0.35, shoulder[1], shoulder[2]));
    reachFor(far, NONE, holdAt(shoulder[0] + 0.7, shoulder[1], shoulder[2]));
    // An easy hold leaves the shoulder where it was; a far one brings it some centimetres forward.
    expect(distance(at(near, SIDES[RIGHT]!.upperArm), shoulder)).toBeLessThan(1e-6);
    expect(at(far, SIDES[RIGHT]!.upperArm)[0] - shoulder[0]).toBeGreaterThan(0.03);
    expect(at(far, SIDES[RIGHT]!.upperArm)[0] - shoulder[0]).toBeLessThan(0.15);
  });

  it("lays a hand on a ledge palm down, the fingers the way the forearm comes, the forearm taking the turn", () => {
    for (const side of [0, 1]) {
      const pose = standing();
      const bones = SIDES[side]!;
      const shoulder = at(pose, bones.upperArm);
      const hold = holdAt(shoulder[0] + 0.3, shoulder[1] - 0.27, shoulder[2] + bones.sign * 0.12, { palm: 1, told: 0 });
      const holds: [Hold, Hold] = side === 0 ? [hold, NONE] : [NONE, hold];
      reachFor(pose, holds[0], holds[1]);
      const ways = handWays(pose, side);
      expect(ways.palm[1], `side ${side}`).toBeLessThan(-0.97);
      expect(Math.abs(ways.fingers[1]!), `side ${side}`).toBeLessThan(0.1);
      // The fingers along the forearm's line over the ledge, within a wrist's easy bend.
      const elbow = at(pose, bones.forearm);
      const wrist = at(pose, bones.hand);
      const flat = Math.hypot(wrist[0] - elbow[0], wrist[2] - elbow[2]);
      const along = (ways.fingers[0]! * (wrist[0] - elbow[0]) + ways.fingers[2]! * (wrist[2] - elbow[2])) / flat;
      expect(along, `side ${side}`).toBeGreaterThan(0.97);
      // The middle of the palm on the hold.
      const palm = [wrist[0] + ways.fingers[0]! * PALM_REACH, wrist[1] + ways.fingers[1]! * PALM_REACH - 0.02, wrist[2] + ways.fingers[2]! * PALM_REACH];
      expect(distance(palm, [hold.x, hold.y, hold.z]), `side ${side}`).toBeLessThan(0.015);
    }
  });

  it("lays the fingers the way it is told when the hold says", () => {
    const pose = standing();
    const shoulder = at(pose, SIDES[RIGHT]!.upperArm);
    const way = [Math.SQRT1_2, 0, -Math.SQRT1_2];
    reachFor(pose, NONE, holdAt(shoulder[0] + 0.32, shoulder[1] - 0.2, shoulder[2], { palm: 1, told: 1, fingersX: way[0]!, fingersY: 0, fingersZ: way[2]! }));
    const ways = handWays(pose, RIGHT);
    expect(ways.fingers[0]! * way[0]! + ways.fingers[2]! * way[2]!).toBeGreaterThan(0.98);
    expect(ways.palm[1]).toBeLessThan(-0.97);
  });

  it("goes to a hold by its weight from the arm as posed", () => {
    const posed = standing();
    const none = standing();
    const half = standing();
    const all = standing();
    const shoulder = at(posed, SIDES[RIGHT]!.upperArm);
    const hold = holdAt(shoulder[0] + 0.4, shoulder[1] - 0.1, shoulder[2]);
    reachFor(none, NONE, { ...hold, weight: 0 });
    reachFor(half, NONE, { ...hold, weight: 0.5 });
    reachFor(all, NONE, hold);
    const hand = SIDES[RIGHT]!.hand;
    expect(distance(at(none, hand), at(posed, hand))).toBe(0);
    // Between the two, on the arm's own arc: nearer each than they are to each other, and not on the chord.
    const whole = distance(at(all, hand), at(posed, hand));
    expect(distance(at(half, hand), at(posed, hand))).toBeLessThan(whole);
    expect(distance(at(half, hand), at(all, hand))).toBeLessThan(whole);
    expect(distance(at(half, hand), at(posed, hand)) + distance(at(half, hand), at(all, hand))).toBeGreaterThan(whole * 1.01);
  });
});

// --- getting in and out -------------------------------------------------------------------------

const DT = 1 / 60;
const HINGE_X = FRONT_DOOR_HINGE.x - CAR_SEATING.driverHip.forward;
const HINGE_Z = FRONT_DOOR_HINGE.z - CAR_SEATING.driverHip.right;
const DOOR_LENGTH = FRONT_DOOR_HINGE.x - DOOR_LINES.frontDoorRear;
const BELT = BODY.belt - (CAR_SEATING.cgAboveGround + CAR_SEATING.driverHip.up);

interface BoardingFrame {
  readonly progress: number;
  readonly door: number;
  readonly holds: readonly [Hold, Hold];
  readonly motion: PersonMotion;
}

/** A getting in (from 0.86 m off the door stand) or a getting out, frame by frame at 60 Hz. */
function board(action: PersonBoardingState["action"], side: "left" | "right", each: (frame: BoardingFrame) => void): void {
  const motion = new PersonMotion();
  const out = motionOutput();
  const sign = side === "right" ? 1 : -1;
  const standZ = side === "right" ? SEAT.doorStand[2] : -SEAT.doorStand[2] + SEAT.passengerOffset;
  const from = { forward: SEAT.doorStand[0] - 0.7, up: SEAT.ground, right: standZ + 0.5 * sign, facing: 0.3 * sign, velocityForward: 0, velocityRight: 0 };
  const getIn = action === "getIn";
  const distanceToDoor = Math.hypot(0.7, 0.5);
  const walkShare = getIn ? boardingWalkShare(distanceToDoor) : 0;
  const seconds = getIn ? boardingWalkSeconds(distanceToDoor) + PERSON.getInSeconds : PERSON.getOutSeconds;
  // Where he was before: on his feet by the car, or in the seat.
  const before = motionInput(personState(getIn ? "stand" : "seated"));
  for (let frame = 0; frame < 30; frame += 1) motion.update(before, DT, out);
  const frames = Math.round(seconds / DT);
  for (let frame = 0; frame <= frames; frame += 1) {
    const progress = Math.min(1, (frame * DT) / seconds);
    const door = doorOpenAt(action, progress, walkShare);
    const boarding: PersonBoardingState = getIn ? { action, progress, side, walkShare } : { action, progress, side };
    motion.update(motionInput(personState("board", { boarding }), { boardingFrom: getIn ? from : null, boardingDoor: door }), DT, out);
    const placement = (motion as unknown as { seat: { placement: { holds: readonly [Hold, Hold] } } }).seat.placement;
    each({ progress, door, holds: placement.holds, motion });
  }
}

/** A seat-frame point against the boarding door as it stands: metres back from its hinge, off its skin (inward negative). */
function againstDoor(point: readonly number[], door: number, side: "left" | "right"): { along: number; out: number } {
  const angle = door * FRONT_DOOR_HINGE.openRadians;
  const dx = point[0]! - HINGE_X;
  const dz = (side === "right" ? point[2]! : -point[2]! + SEAT.passengerOffset) - HINGE_Z;
  return { along: -dx * Math.cos(angle) + dz * Math.sin(angle), out: dx * Math.sin(angle) + dz * Math.cos(angle) };
}

const MOVES: readonly (readonly [PersonBoardingState["action"], "left" | "right"])[] = [["getIn", "right"], ["getOut", "right"], ["getIn", "left"], ["getOut", "left"]];

describe("the hands getting in and out of the car", () => {
  it.each(MOVES)("%s by the %s door: a hand is only on what its arm reaches, and is on it", (action, side) => {
    let held = 0;
    board(action, side, ({ progress, holds, motion }) => {
      for (let hand = 0; hand < 2; hand += 1) {
        const hold = holds[hand]!;
        if (hold.weight < 0.95) continue;
        held += 1;
        const shoulder = at(motion.pose, SIDES[hand]!.upperArm);
        const wrist = at(motion.pose, SIDES[hand]!.hand);
        const label = `${action} ${side} hand ${hand} at ${progress.toFixed(3)}`;
        // Within the arm's length and a palm of the shoulder, and the wrist a palm from it, to a centimetre and a half.
        expect(distance(shoulder, [hold.x, hold.y, hold.z]), label).toBeLessThan(ARM_REACH + PALM_REACH - 0.03);
        expect(distance(wrist, [hold.x, hold.y, hold.z]), label).toBeLessThan(PALM_REACH + 0.015);
        expect(distance(wrist, [hold.x, hold.y, hold.z]), label).toBeGreaterThan(PALM_REACH - 0.015);
      }
    });
    // (Each move has a hand on something for a good part of it.)
    expect(held).toBeGreaterThan(25);
  });

  it.each(MOVES)("%s by the %s door: the elbows keep their bend", (action, side) => {
    board(action, side, ({ progress, holds, motion }) => {
      for (let hand = 0; hand < 2; hand += 1) {
        // (Under half a hold's weight the arm is still more its own swing than the reach.)
        if (holds[hand]!.weight < 0.5) continue;
        expect(elbowBend(motion.pose, hand), `${action} ${side} hand ${hand} at ${progress.toFixed(3)}`).toBeGreaterThan(30);
      }
    });
  });

  it.each(MOVES)("%s by the %s door: no hand goes through the door", (action, side) => {
    board(action, side, ({ progress, door, motion }) => {
      for (let hand = 0; hand < 2; hand += 1) {
        const wrist = at(motion.pose, SIDES[hand]!.hand);
        const ways = handWays(motion.pose, hand);
        const palm = [wrist[0] + ways.fingers[0]! * PALM_REACH, wrist[1] + ways.fingers[1]! * PALM_REACH, wrist[2] + ways.fingers[2]! * PALM_REACH];
        for (const [name, point] of [["wrist", wrist], ["palm", palm]] as const) {
          // Under the belt, between the door's ends: not in its slab (its skin to its card, 0.105 m).
          if (point[1]! > BELT - 0.02) continue;
          const { along, out } = againstDoor(point, door, side);
          if (along < 0.03 || along > DOOR_LENGTH - 0.03) continue;
          const inside = out > -0.1 && out < -0.005;
          expect(inside, `${action} ${side} hand ${hand} ${name} at ${progress.toFixed(3)}: ${along.toFixed(2)} m back, ${out.toFixed(3)} off the skin`).toBe(false);
        }
      }
    });
  });

  it("takes the door's handle only from within an arm of it, not held out on the way", () => {
    let reached = false;
    board("getIn", "right", ({ holds, motion, progress }) => {
      const hold = holds[1];
      if (hold.weight < 0.5 || hold.palm > 0) return;
      // (The outer hand's first hold is the handle; the armrest's is a palm's.)
      if (progress > 0.5) return;
      reached = true;
      expect(distance(at(motion.pose, SIDES[1]!.upperArm), [hold.x, hold.y, hold.z]), `at ${progress.toFixed(3)}`).toBeLessThan(1.4 * ARM_REACH);
    });
    expect(reached).toBe(true);
  });
});
