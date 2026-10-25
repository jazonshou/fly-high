/**
 * Shortest paths for a vehicle that cannot turn tighter than a radius: Dubins'
 * six words (L. E. Dubins, 1957; the closed forms are Shkel & Lumelsky's,
 * "Classification of the Dubins set", 2001).
 *
 * Used by the autoland to answer "how does this aeroplane get from where it is
 * onto the final approach course, flying only turns it can actually make?".
 * The radius is the aeroplane's own: `V^2 / (g tan(bank))` at the speed and
 * bank it will fly the pattern at, so a path that comes out of here is a path
 * the flight model can follow without exceeding the bank limit.
 *
 * **The plane is (u, v) = (world z, world x), and that swap is the point.**
 * With it, a pose's angle is exactly the simulator's `telemetry.heading`
 * (`atan2(forward.x, forward.z)`), and the textbook conventions hold unchanged:
 * L is counter-clockwise, which here is heading INCREASING, which in this
 * world is a turn to the pilot's LEFT. R is a pilot's right turn. See the
 * coordinate notes in `src/sim/types.ts` and the heading docblock on
 * `FlightTelemetry`; both have cost afternoons before.
 */

const TWO_PI = Math.PI * 2;

export interface PlanarPose {
  /** World X, metres. */
  readonly x: number;
  /** World Z, metres. */
  readonly z: number;
  /** Radians, the simulator's heading convention: `atan2(dir.x, dir.z)`. */
  readonly heading: number;
}

/** L is a pilot's left turn, R a right turn, S straight. */
export type DubinsSegmentKind = "L" | "R" | "S";

export interface DubinsPath {
  readonly word: string;
  readonly kinds: readonly [DubinsSegmentKind, DubinsSegmentKind, DubinsSegmentKind];
  /** Segment lengths in metres. */
  readonly lengths: readonly [number, number, number];
  readonly radius: number;
  readonly length: number;
  readonly start: PlanarPose;
}

/** One sample of a flattened path. */
export interface PathSample {
  x: number;
  z: number;
  heading: number;
  /** -1 left turn, 0 straight, +1 right turn: the sign of the bank it is flown at. */
  turn: -1 | 0 | 1;
  /** Arc length from the path's start, metres. */
  s: number;
}

function mod2pi(angle: number): number {
  const wrapped = angle % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

/** Wraps to (-pi, pi]. */
export function wrapAngle(angle: number): number {
  const wrapped = mod2pi(angle + Math.PI) - Math.PI;
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

type Word = readonly [DubinsSegmentKind, DubinsSegmentKind, DubinsSegmentKind];

const WORDS: readonly Word[] = [
  ["L", "S", "L"],
  ["R", "S", "R"],
  ["L", "S", "R"],
  ["R", "S", "L"],
  ["R", "L", "R"],
  ["L", "R", "L"],
];

/**
 * Rounding allowance on the closed forms' existence tests. A straight segment
 * of length zero (a goal exactly one arc away) sits on the boundary, and the
 * squared length there comes out as -1e-16 as often as +1e-16: refused, the
 * planner fell back to a word three times as long.
 */
const EXISTENCE_EPSILON = 1e-9;

/**
 * Normalised segment lengths (in radii) for one word, or null where the word
 * has no solution. alpha and beta are the start and end angles measured from
 * the line joining the two poses, d the distance between them in radii.
 */
function wordLengths(word: Word, alpha: number, beta: number, d: number): [number, number, number] | null {
  const sa = Math.sin(alpha);
  const sb = Math.sin(beta);
  const ca = Math.cos(alpha);
  const cb = Math.cos(beta);
  const cab = Math.cos(alpha - beta);
  const key = word.join("");
  if (key === "LSL") {
    const p2 = 2 + d * d - 2 * cab + 2 * d * (sa - sb);
    if (p2 < -EXISTENCE_EPSILON) return null;
    const tmp = Math.atan2(cb - ca, d + sa - sb);
    return [mod2pi(-alpha + tmp), Math.sqrt(Math.max(0, p2)), mod2pi(beta - tmp)];
  }
  if (key === "RSR") {
    const p2 = 2 + d * d - 2 * cab + 2 * d * (sb - sa);
    if (p2 < -EXISTENCE_EPSILON) return null;
    const tmp = Math.atan2(ca - cb, d - sa + sb);
    return [mod2pi(alpha - tmp), Math.sqrt(Math.max(0, p2)), mod2pi(-beta + tmp)];
  }
  if (key === "LSR") {
    const p2 = -2 + d * d + 2 * cab + 2 * d * (sa + sb);
    if (p2 < -EXISTENCE_EPSILON) return null;
    const p = Math.sqrt(Math.max(0, p2));
    const tmp = Math.atan2(-ca - cb, d + sa + sb) - Math.atan2(-2, p);
    return [mod2pi(-alpha + tmp), p, mod2pi(-mod2pi(beta) + tmp)];
  }
  if (key === "RSL") {
    const p2 = d * d - 2 + 2 * cab - 2 * d * (sa + sb);
    if (p2 < -EXISTENCE_EPSILON) return null;
    const p = Math.sqrt(Math.max(0, p2));
    const tmp = Math.atan2(ca + cb, d - sa - sb) - Math.atan2(2, p);
    return [mod2pi(alpha - tmp), p, mod2pi(beta - tmp)];
  }
  if (key === "RLR") {
    const tmp = (6 - d * d + 2 * cab + 2 * d * (sa - sb)) / 8;
    if (Math.abs(tmp) > 1 + EXISTENCE_EPSILON) return null;
    const p = mod2pi(TWO_PI - Math.acos(Math.max(-1, Math.min(1, tmp))));
    const t = mod2pi(alpha - Math.atan2(ca - cb, d - sa + sb) + p / 2);
    return [t, p, mod2pi(alpha - beta - t + p)];
  }
  // LRL
  const tmp = (6 - d * d + 2 * cab + 2 * d * (sb - sa)) / 8;
  if (Math.abs(tmp) > 1 + EXISTENCE_EPSILON) return null;
  const p = mod2pi(TWO_PI - Math.acos(Math.max(-1, Math.min(1, tmp))));
  const t = mod2pi(-alpha - Math.atan2(ca - cb, d + sa - sb) + p / 2);
  return [t, p, mod2pi(mod2pi(beta) - alpha - t + p)];
}

/** Advances a pose along one segment, in place of a closed form per word. */
function advance(
  pose: { x: number; z: number; heading: number },
  kind: DubinsSegmentKind,
  length: number,
  radius: number,
): void {
  // (u, v) = (z, x): heading measured from +u toward +v.
  const u = pose.z;
  const v = pose.x;
  const theta = pose.heading;
  if (kind === "S") {
    pose.z = u + length * Math.cos(theta);
    pose.x = v + length * Math.sin(theta);
    return;
  }
  const sign = kind === "L" ? 1 : -1;
  const next = theta + (sign * length) / radius;
  // Chord form, exact for any arc length and free of the centre's rounding.
  pose.z = u + sign * radius * (Math.sin(next) - Math.sin(theta));
  pose.x = v - sign * radius * (Math.cos(next) - Math.cos(theta));
  pose.heading = next;
}

/** The pose at the end of a path. Exposed so a caller can check a plan lands where it should. */
export function dubinsEndPose(path: DubinsPath): PlanarPose {
  const pose = { x: path.start.x, z: path.start.z, heading: path.start.heading };
  for (let index = 0; index < 3; index += 1) {
    advance(pose, path.kinds[index]!, path.lengths[index]!, path.radius);
  }
  return { x: pose.x, z: pose.z, heading: wrapAngle(pose.heading) };
}

/**
 * The shortest Dubins path between two poses at a turn radius, or null if the
 * inputs are degenerate.
 *
 * Every candidate is integrated and checked against the goal before it is
 * accepted. The closed forms are notoriously easy to transcribe wrong, and a
 * path that ends 400 m beside the runway is a worse failure than no path.
 */
export function shortestDubinsPath(
  start: PlanarPose,
  goal: PlanarPose,
  radius: number,
): DubinsPath | null {
  if (!(radius > 0) || ![start.x, start.z, start.heading, goal.x, goal.z, goal.heading].every(Number.isFinite)) {
    return null;
  }
  const du = goal.z - start.z;
  const dv = goal.x - start.x;
  const distance = Math.hypot(du, dv);
  const d = distance / radius;
  const phi = distance > 1e-9 ? Math.atan2(dv, du) : 0;
  const alpha = mod2pi(start.heading - phi);
  const beta = mod2pi(goal.heading - phi);
  const tolerance = Math.max(0.5, radius * 1e-4);

  let best: DubinsPath | null = null;
  for (const word of WORDS) {
    const normalised = wordLengths(word, alpha, beta, d);
    if (!normalised) continue;
    const lengths: [number, number, number] = [
      normalised[0] * radius,
      normalised[1] * radius,
      normalised[2] * radius,
    ];
    const length = lengths[0] + lengths[1] + lengths[2];
    if (!Number.isFinite(length) || (best && length >= best.length)) continue;
    const candidate: DubinsPath = {
      word: word.join(""),
      kinds: word,
      lengths,
      radius,
      length,
      start: { x: start.x, z: start.z, heading: start.heading },
    };
    const end = dubinsEndPose(candidate);
    if (
      Math.hypot(end.x - goal.x, end.z - goal.z) > tolerance
      || Math.abs(wrapAngle(end.heading - goal.heading)) > 1e-3
    ) continue;
    best = candidate;
  }
  return best;
}

/**
 * Flattens a path into samples no more than `spacing` metres apart, appending
 * to `out` and continuing its arc length. Returns `out`.
 */
export function sampleDubinsPath(
  path: DubinsPath,
  spacing: number,
  out: PathSample[] = [],
): PathSample[] {
  const startS = out.length > 0 ? out[out.length - 1]!.s : 0;
  const pose = { x: path.start.x, z: path.start.z, heading: path.start.heading };
  if (out.length === 0) out.push({ x: pose.x, z: pose.z, heading: wrapAngle(pose.heading), turn: 0, s: 0 });
  let s = startS;
  for (let index = 0; index < 3; index += 1) {
    const kind = path.kinds[index]!;
    const length = path.lengths[index]!;
    if (!(length > 1e-6)) continue;
    const steps = Math.max(1, Math.ceil(length / spacing));
    const step = length / steps;
    const turn = kind === "L" ? -1 : kind === "R" ? 1 : 0;
    for (let i = 0; i < steps; i += 1) {
      advance(pose, kind, step, path.radius);
      s += step;
      out.push({ x: pose.x, z: pose.z, heading: wrapAngle(pose.heading), turn, s });
    }
  }
  return out;
}

/** Appends a straight leg along `heading` to a sampled path. */
export function appendStraight(
  out: PathSample[],
  heading: number,
  length: number,
  spacing: number,
): PathSample[] {
  const last = out[out.length - 1];
  if (!last || !(length > 0)) return out;
  const steps = Math.max(1, Math.ceil(length / spacing));
  const step = length / steps;
  const dx = Math.sin(heading);
  const dz = Math.cos(heading);
  for (let i = 1; i <= steps; i += 1) {
    out.push({
      x: last.x + dx * step * i,
      z: last.z + dz * step * i,
      heading: wrapAngle(heading),
      turn: 0,
      s: last.s + step * i,
    });
  }
  return out;
}
