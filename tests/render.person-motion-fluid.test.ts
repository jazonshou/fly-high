import { describe, expect, it } from "vitest";
import { doorOpenAt, SEAT } from "../src/render/webgpu/person/carSeat";
import { PersonMotion, type MotionInput } from "../src/render/webgpu/person/motion";
import { BONE, SIDES } from "../src/render/webgpu/person/skeleton";
import { boardingWalkSeconds, boardingWalkShare, PERSON } from "../src/vehicles/person";
import { motionInput, motionOutput, personState, type Mode } from "./personMotionRig";

/**
 * The walker moves as a body does: nothing on him jumps. The sim's walker is
 * a point that reaches walking speed in a sixth of a second, stops in an
 * eighth, turns at 540 degrees a second, and is handed between the ground's
 * frame and the car's in one frame; the figure drawn on it has to start,
 * stop, turn, get in and get out without a part of it leaping from one frame
 * to the next.
 *
 * MEASURED here: the greatest acceleration of the pelvis, the head, the
 * wrists and the ankles in the world, by second differences of their places
 * frame to frame at 60 Hz, m/s2. A pop of 3 cm in one frame reads 108. The
 * bounds are about half as much again as each move measures (in brackets);
 * the motion before the body followed the root measured 210 to 650 on every
 * one of them. A heel strike stops a foot within a frame or two, which is
 * what a foot does, so the feet's bounds are the widest.
 */

const DT = 1 / 60;
// walker.ts: the walker's acceleration and deceleration on the ground, m/s2.
const GROUND_ACCELERATION = 8;
const GROUND_DECELERATION = 12;

interface Peaks {
  pelvis: number;
  head: number;
  hands: number;
  feet: number;
}

const TRACKED: readonly { bone: number; part: keyof Peaks }[] = [
  { bone: BONE.pelvis, part: "pelvis" },
  { bone: BONE.head, part: "head" },
  ...SIDES.flatMap((side) => [
    { bone: side.hand, part: "hands" as const },
    { bone: side.foot, part: "feet" as const },
  ]),
];

/** The tracked points' places in the world frame after frame, and the greatest acceleration of each part. */
class Track {
  readonly peaks: Peaks = { pelvis: 0, head: 0, hands: 0, feet: 0 };
  private readonly last = new Float64Array(TRACKED.length * 3);
  private readonly before = new Float64Array(TRACKED.length * 3);
  private frames = 0;

  /** The root's place in the world (`x`, `y`, `z`) and its turn about +Y (`a`, radians) this frame. */
  record(motion: PersonMotion, x: number, y: number, z: number, a: number): void {
    const g = motion.pose.globalPositions;
    const c = Math.cos(a);
    const s = Math.sin(a);
    for (let i = 0; i < TRACKED.length; i += 1) {
      const { bone, part } = TRACKED[i]!;
      const px = x + g[bone * 3]! * c + g[bone * 3 + 2]! * s;
      const py = y + g[bone * 3 + 1]!;
      const pz = z - g[bone * 3]! * s + g[bone * 3 + 2]! * c;
      if (this.frames >= 2) {
        const acceleration = Math.hypot(
          px - 2 * this.last[i * 3]! + this.before[i * 3]!,
          py - 2 * this.last[i * 3 + 1]! + this.before[i * 3 + 1]!,
          pz - 2 * this.last[i * 3 + 2]! + this.before[i * 3 + 2]!,
        ) / (DT * DT);
        this.peaks[part] = Math.max(this.peaks[part], acceleration);
      }
      this.before[i * 3] = this.last[i * 3]!;
      this.before[i * 3 + 1] = this.last[i * 3 + 1]!;
      this.before[i * 3 + 2] = this.last[i * 3 + 2]!;
      this.last[i * 3] = px;
      this.last[i * 3 + 1] = py;
      this.last[i * 3 + 2] = pz;
    }
    this.frames += 1;
  }
}

type Input = { -readonly [K in keyof MotionInput]: MotionInput[K] };

/** What the player holds at a time: the way to go as a world heading (radians, 0 along +Z, growing toward +X), or null. */
interface Held {
  heading: number | null;
}

const AHEAD = Math.PI / 2;

/** `seconds` on foot on flat ground, the root moved as the sim's walker moves it (`walker.ts`). */
function onFoot(seconds: number, held: (t: number) => Held): Peaks {
  const motion = new PersonMotion();
  const out = motionOutput();
  const input: Input = motionInput(personState("stand"));
  const track = new Track();
  let x = 0;
  let z = 0;
  let heading = AHEAD;
  let vx = 0;
  let vz = 0;
  for (let frame = 0; frame <= Math.round(seconds / DT); frame += 1) {
    const wanted = held(frame * DT).heading;
    const top = wanted === null ? 0 : PERSON.walkSpeed;
    const tx = wanted === null ? 0 : Math.sin(wanted) * top;
    const tz = wanted === null ? 0 : Math.cos(wanted) * top;
    const rate = (top >= Math.hypot(vx, vz) ? GROUND_ACCELERATION : GROUND_DECELERATION) * DT;
    const gap = Math.hypot(tx - vx, tz - vz);
    if (gap <= rate) {
      vx = tx;
      vz = tz;
    } else {
      vx += ((tx - vx) / gap) * rate;
      vz += ((tz - vz) / gap) * rate;
    }
    let turned = 0;
    if (wanted !== null) {
      const most = PERSON.turnRateWalk * DT;
      turned = Math.max(-most, Math.min(most, Math.atan2(Math.sin(wanted - heading), Math.cos(wanted - heading))));
      heading += turned;
    }
    x += vx * DT;
    z += vz * DT;
    const speed = Math.hypot(vx, vz);
    const mode: Mode = speed > 0.1 ? "walk" : "stand";
    input.person = personState(mode, { speed });
    // The root's own axes in the world: forward (cos a, -sin a), right (sin a, cos a).
    const a = heading - Math.PI / 2;
    input.forward = vx * Math.cos(a) - vz * Math.sin(a);
    input.right = vx * Math.sin(a) + vz * Math.cos(a);
    input.turnRate = -turned / DT;
    motion.update(input, DT, out);
    track.record(motion, x, 0, z, a);
  }
  return track.peaks;
}

/** Where a getting-in starts: metres off the door stand along the car's forward and right, and the facing right of the car's. */
const FROM = { forward: -0.7, right: 0.5, facing: 0.3 };

/**
 * Half a second standing where he stood, the whole of getting in, and half a
 * second seated; or seated, the whole of getting out, and a second standing
 * at the door stand as the sim leaves him (`placeAt`: facing away from the
 * car). The root is the renderer's: the feet point on foot, the driver's hip
 * point's frame while boarding and seated.
 */
function inTheCar(action: "getIn" | "getOut"): Peaks {
  const motion = new PersonMotion();
  const out = motionOutput();
  const input: Input = motionInput(personState("stand"));
  const track = new Track();
  const getIn = action === "getIn";
  const distance = Math.hypot(FROM.forward, FROM.right);
  const seconds = getIn ? boardingWalkSeconds(distance) + PERSON.getInSeconds : PERSON.getOutSeconds;
  const walkShare = getIn ? boardingWalkShare(distance) : 0;
  const start = {
    forward: SEAT.doorStand[0] + FROM.forward, up: SEAT.ground, right: SEAT.doorStand[2] + FROM.right, facing: FROM.facing,
    velocityForward: 0, velocityRight: 0,
  };
  const lead = 0.5;
  const tail = getIn ? 0.5 : 1;
  for (let frame = 0; frame <= Math.round((lead + seconds + tail) / DT); frame += 1) {
    const t = frame * DT;
    const boarding = t >= lead && t - lead < seconds;
    let x = 0;
    let y = 0;
    let z = 0;
    let a = 0;
    if (boarding) {
      input.person = personState("board", { boarding: { action, progress: (t - lead) / seconds, side: "right", walkShare } });
    } else if (getIn === t < lead) {
      // On foot: before getting in where he stood, after getting out at the door stand.
      input.person = personState("stand");
      x = getIn ? start.forward : SEAT.doorStand[0];
      y = SEAT.ground;
      z = getIn ? start.right : SEAT.doorStand[2];
      a = getIn ? -start.facing : -Math.PI / 2;
    } else input.person = personState("seated");
    const state = input.person.boarding;
    input.boardingFrom = state?.action === "getIn" ? start : null;
    input.boardingDoor = state ? doorOpenAt(state.action, state.progress, state.walkShare ?? 0) : 0;
    motion.update(input, DT, out);
    track.record(motion, x, y, z, a);
  }
  return track.peaks;
}

function expectUnder(peaks: Peaks, bounds: Peaks): void {
  const read = (p: Peaks) => `pelvis ${p.pelvis.toFixed(0)}, head ${p.head.toFixed(0)}, hands ${p.hands.toFixed(0)}, feet ${p.feet.toFixed(0)}`;
  const message = `peak accelerations, m/s2: ${read(peaks)}; bounds: ${read(bounds)}`;
  expect(peaks.pelvis, message).toBeLessThan(bounds.pelvis);
  expect(peaks.head, message).toBeLessThan(bounds.head);
  expect(peaks.hands, message).toBeLessThan(bounds.hands);
  expect(peaks.feet, message).toBeLessThan(bounds.feet);
}

describe("nothing on the walker jumps", () => {
  it("as he sets off from a stand, walks and stops (25, 32, 35, 88)", () => {
    expectUnder(onFoot(4, (t) => ({ heading: t > 0.5 && t < 2.3 ? AHEAD : null })), { pelvis: 45, head: 55, hands: 70, feet: 140 });
  });

  it("as he is thrown the other way at a walk (43, 43, 60, 115)", () => {
    expectUnder(onFoot(3.6, (t) => ({ heading: t < 1.5 ? AHEAD : AHEAD + Math.PI })), { pelvis: 70, head: 70, hands: 100, feet: 180 });
  });

  it("as he turns from a stand to walk off behind him (29, 32, 47, 92)", () => {
    expectUnder(onFoot(3, (t) => ({ heading: t < 0.6 ? null : AHEAD + Math.PI * 0.75 })), { pelvis: 50, head: 55, hands: 80, feet: 150 });
  });

  it("as he walks to the door, gets in and sits, across the change to the car's frame (18, 18, 42, 56)", () => {
    expectUnder(inTheCar("getIn"), { pelvis: 35, head: 35, hands: 70, feet: 95 });
  });

  it("as he gets out and stands at ease by the door, across the change back to the ground's (28, 28, 63, 56)", () => {
    expectUnder(inTheCar("getOut"), { pelvis: 50, head: 50, hands: 100, feet: 95 });
  });
});
