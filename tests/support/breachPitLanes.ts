/**
 * The CPU twin of the parallel breach pit search: one workgroup per pit, its
 * lanes striding the (2r+1)² window, a shared-memory tree reduction choosing
 * the winner (docs/findings/BREACH_PIT_ADMISSION_2026_09_22.md).
 *
 * The serial search keeps the target with the lowest score, ties going to the
 * lowest target index: a total order, so its minimum does not depend on the
 * order targets are visited in. This twin visits them the way the WGSL does,
 * lane `t % LANES` for window target `t`, then reduces lane pairs at strides
 * LANES/2 ... 1 under the same rule, so a test can hold it equal to
 * `breachLocalPits` bit for bit on real pages.
 */
export const BREACH_PIT_LANES = 64;

export interface BreachChoice {
  readonly dx: number;
  readonly dz: number;
  readonly steps: number;
  readonly target: number;
  readonly score: number;
}

/** The window target at index `t`, row-major from (-radius, -radius). */
export function breachWindowOffset(t: number, radius: number): { readonly dx: number; readonly dz: number } {
  const side = radius * 2 + 1;
  return { dx: (t % side) - radius, dz: Math.floor(t / side) - radius };
}

/** The serial search's order: lower score, then lower target index. */
export function betterBreachChoice(current: BreachChoice | null, candidate: BreachChoice | null): BreachChoice | null {
  if (!candidate) return current;
  if (!current) return candidate;
  if (candidate.score < current.score) return candidate;
  if (candidate.score === current.score && candidate.target < current.target) return candidate;
  return current;
}

/** One pit's choice as the lanes and the reduction make it; null when no target qualifies. */
export function laneReducedBreachChoice(
  edge: number,
  height: ArrayLike<number>,
  mask: ArrayLike<number>,
  x: number,
  z: number,
  radius: number,
  epsilon: number,
): BreachChoice | null {
  const lanes: Array<BreachChoice | null> = new Array(BREACH_PIT_LANES).fill(null);
  const own = height[z * edge + x]!;
  const side = radius * 2 + 1;
  for (let t = 0; t < side * side; t += 1) {
    const { dx, dz } = breachWindowOffset(t, radius);
    const steps = Math.max(Math.abs(dx), Math.abs(dz));
    if (steps === 0 || steps > radius) continue;
    const tx = x + dx;
    const tz = z + dz;
    if (tx < 0 || tz < 0 || tx >= edge || tz >= edge) continue;
    const target = tz * edge + tx;
    const distance = Math.hypot(dx, dz);
    if (!(height[target]! + epsilon * distance < own)) continue;
    let clear = true;
    for (let step = 1; step <= steps; step += 1) {
      const px = x + Math.round((dx * step) / steps);
      const pz = z + Math.round((dz * step) / steps);
      if ((mask[pz * edge + px] ?? 0) >= 0.5) { clear = false; break; }
    }
    if (!clear) continue;
    const lane = t % BREACH_PIT_LANES;
    lanes[lane] = betterBreachChoice(lanes[lane]!, { dx, dz, steps, target, score: height[target]! + epsilon * distance });
  }
  for (let stride = BREACH_PIT_LANES / 2; stride >= 1; stride /= 2) {
    for (let lane = 0; lane < stride; lane += 1) {
      lanes[lane] = betterBreachChoice(lanes[lane]!, lanes[lane + stride]!);
    }
  }
  return lanes[0]!;
}

/**
 * The whole breach, pits carved by the lane twin: the direct receiver where a
 * lower neighbour exists, else the lane-reduced choice carved as a monotone
 * min-combined line. Mirrors `breachLocalPits` without receiver hints.
 */
export function laneReducedBreach(
  edge: number,
  height: ArrayLike<number>,
  mask: ArrayLike<number>,
  radius: number,
  epsilon: number,
): { readonly breachedHeight: Float32Array; readonly breachReceivers: Int32Array; readonly pits: number } {
  const breached = Float64Array.from(height as ArrayLike<number>);
  const receivers = new Int32Array(edge * edge).fill(-1);
  let pits = 0;
  for (let z = 1; z < edge - 1; z += 1) {
    for (let x = 1; x < edge - 1; x += 1) {
      const index = z * edge + x;
      if ((mask[index] ?? 0) >= 0.5) continue;
      let directReceiver = -1;
      let directHeight = height[index]!;
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dz === 0) continue;
          const neighbour = (z + dz) * edge + (x + dx);
          if ((mask[neighbour] ?? 0) >= 0.5) continue;
          const candidate = height[neighbour]!;
          if (candidate < directHeight
            || (candidate === directHeight && directReceiver >= 0 && neighbour < directReceiver)) {
            directHeight = candidate;
            directReceiver = neighbour;
          }
        }
      }
      if (directReceiver >= 0) { receivers[index] = directReceiver; continue; }
      pits += 1;
      const best = laneReducedBreachChoice(edge, height, mask, x, z, radius, epsilon);
      if (!best) continue;
      const outlet = height[best.target]!;
      const own = height[index]!;
      for (let step = 1; step < best.steps; step += 1) {
        const cell = (z + Math.round((best.dz * step) / best.steps)) * edge + (x + Math.round((best.dx * step) / best.steps));
        breached[cell] = Math.min(breached[cell]!, own + (outlet - own) * step / best.steps);
      }
      receivers[index] = (z + Math.round(best.dz / best.steps)) * edge + (x + Math.round(best.dx / best.steps));
    }
  }
  return { breachedHeight: Float32Array.from(breached), breachReceivers: receivers, pits };
}
