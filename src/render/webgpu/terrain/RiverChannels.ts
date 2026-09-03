import type { HydrologyGenerationResult } from "../water/HydrologyGeneration";

/**
 * `5-12a`: river channels carved into the analytic heightfield.
 *
 * **Why this module exists rather than a branch inside the height function.**
 * The runway is carved by `RunwayEarthworks`, one shared profile evaluated
 * identically by the render path and by physics — the §1.3 same-authority
 * contract. A river channel is the same kind of thing and gets the same
 * treatment: one profile, three authorities, no second copy.
 *
 * **THE ORDERING HAZARD, AND WHY THIS TYPE EXISTS.** Rivers are traced FROM the
 * heightfield and carving MODIFIES it, so a naive implementation traces its own
 * output and oscillates. The defence is not a comment: `CarvedChannelSet` has
 * exactly one constructor and it takes a **finished** `HydrologyGenerationResult`.
 * **You cannot carve rivers you have not traced, because the value that carves
 * them cannot exist until tracing has returned.**
 *
 * The other direction — tracing over already-carved ground — is held by
 * `generateHydrology` requiring a sampler that stops short of this layer. That
 * one is a type constraint and types are erased, so `assertUncarvedSampler`
 * exists as the runtime backstop for any path the types did not cover.
 */

/** A channel centreline segment in world XZ, with the water surface at each end. */
export interface CarvedChannelSegment {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
  readonly halfWidthMeters: number;
  readonly depthMeters: number;
}

declare const CarvedChannelBrand: unique symbol;

/**
 * Channels ready to carve. **Constructible only by `carveChannels`**, so the
 * ordering constraint is carried by the type rather than by discipline.
 */
export interface CarvedChannelSet {
  readonly segments: readonly CarvedChannelSegment[];
  readonly [CarvedChannelBrand]: true;
}

/** An empty set, for worlds and pages with no rivers. Cheap and total. */
// The brand is unexported, so these two casts are the ONLY places a
// `CarvedChannelSet` can come into existence. `tsc` rejected the direct cast,
// which is the brand doing its job; routing through `unknown` here is
// deliberate and deliberately conspicuous.
export const NO_CARVED_CHANNELS: CarvedChannelSet =
  Object.freeze({ segments: Object.freeze([]) }) as unknown as CarvedChannelSet;

/**
 * `5-12a` step 1 is deliberately a NO-OP carve.
 *
 * The ordering and the three-authority agreement are what fail expensively —
 * `3-8` put collision and render 15.3 m apart on the runway, the very feature
 * this copies. So the scaffolding lands first with a profile that changes no
 * height at all, which makes step 1 assertable against a byte-identical world:
 * if anything moves, the wiring is wrong, and no shape question is confounding
 * the answer. Depth and width arrive in step 3, after agreement is proven.
 */
export const CHANNEL_CARVE_ENABLED = false;

/**
 * The only way to make a `CarvedChannelSet`. Takes a COMPLETED hydrology
 * result, which is the whole ordering guarantee.
 */
export function carveChannels(hydrology: HydrologyGenerationResult): CarvedChannelSet {
  if (!CHANNEL_CARVE_ENABLED) return NO_CARVED_CHANNELS;
  const segments: CarvedChannelSegment[] = [];
  for (const river of hydrology.rivers) {
    for (let index = 1; index < river.points.length; index += 1) {
      const previous = river.points[index - 1]!;
      const current = river.points[index]!;
      segments.push({
        x0: previous.x, z0: previous.z, x1: current.x, z1: current.z,
        halfWidthMeters: Math.max(previous.widthMeters, current.widthMeters) * 0.5,
        depthMeters: 0,
      });
    }
  }
  return Object.freeze({ segments: Object.freeze(segments) }) as unknown as CarvedChannelSet;
}

/** Squared distance from a point to a segment, and the parameter along it. */
function distanceSquaredToSegment(
  x: number, z: number, x0: number, z0: number, x1: number, z1: number,
): number {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared < 1e-9) return (x - x0) ** 2 + (z - z0) ** 2;
  let t = ((x - x0) * dx + (z - z0) * dz) / lengthSquared;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = x0 + dx * t;
  const pz = z0 + dz * t;
  return (x - px) ** 2 + (z - pz) ** 2;
}

/**
 * Metres to subtract from the natural height at this point. **Zero everywhere
 * while `CHANNEL_CARVE_ENABLED` is false**, which is what makes step 1 a
 * no-change landing.
 *
 * Shared by the CPU authorities and mirrored by the GPU height kernel. It must
 * stay a pure function of `(channels, x, z)` — a term that reads anything else
 * cannot be evaluated identically on both paths, which is the §1.3 contract and
 * the thing `3-8` broke.
 */
export function channelCarveDepth(
  channels: CarvedChannelSet, x: number, z: number,
): number {
  if (channels.segments.length === 0) return 0;
  let deepest = 0;
  for (const segment of channels.segments) {
    const half = segment.halfWidthMeters;
    if (half <= 0 || segment.depthMeters <= 0) continue;
    const distanceSquared = distanceSquaredToSegment(
      x, z, segment.x0, segment.z0, segment.x1, segment.z1,
    );
    if (distanceSquared >= half * half) continue;
    // Trapezoidal, crudest possible: full depth in the bed, linear to the lip.
    // Shape is step 3; agreement across the three authorities is step 2, and a
    // profile collision has never heard of is worse than no profile.
    const distance = Math.sqrt(distanceSquared);
    const depth = segment.depthMeters * (1 - distance / half);
    if (depth > deepest) deepest = depth;
  }
  return deepest;
}

const CARVED_SAMPLER = Symbol.for("aerolith.carvedTerrainSampler");

/**
 * Mark a terrain sampler as reading the CARVED heightfield.
 *
 * **The runtime half of the ordering defence.** `generateHydrology` refuses a
 * sampler carrying this mark, so tracing over already-carved ground fails loudly
 * instead of quietly oscillating. The type constraint is the first line and is
 * erased at runtime; this one survives compilation and catches any path the
 * types did not cover — a `JSON`-round-tripped closure, a worker boundary, an
 * `as any` written in a hurry.
 *
 * `tests/world.river-carve-ordering.test.ts` proves it fires rather than
 * assuming it: a guard nobody has watched go red is a guard nobody has tested.
 */
export function markCarvedSampler<T extends (...args: never[]) => unknown>(sampler: T): T {
  (sampler as unknown as Record<symbol, boolean>)[CARVED_SAMPLER] = true;
  return sampler;
}

/** Whether a sampler reads carved ground. Total, and safe on any value. */
export function isCarvedSampler(value: unknown): boolean {
  if (typeof value !== "function") return false;
  return (value as unknown as Record<symbol, boolean>)[CARVED_SAMPLER] === true;
}
