import { groundCoverOf } from "./GroundPatchwork";
import { SURFACE_MATERIAL_COUNT, SurfaceMaterial } from "./surfaceMaterials";

/**
 * `V-4` — the far-sward gate, and its soft read.
 *
 * INVARIANT THIS FILE OWNS: which pairs a zero-trust page (level 5 and
 * coarser, 128 m texels and up) may name for the seam feather, and how a
 * fragment between texels that may and texels that may not is drawn.
 *
 * The gate itself is `2026-09-20`'s (world LIVERY): a pair of SWARDS is a
 * climate gradient, smooth at any texel size, so it may supply the feather's
 * target; any pair with sand, rock, gravel, snow, pavement or forest floor in
 * it keeps the continuous Grass base. The CHEAP read took the NEAREST texel's
 * pair and gated it all or nothing, so wherever the pair changes kind (a
 * coast, a treeline) the ground switched between the pair's mottled mixture
 * and the smooth Grass base along a straight 128 m texel line, about 2 km out
 * and following the aeroplane (world V4HYQQ, 2026-09-30: x = -8576 and -8448,
 * to 3-6 m).
 *
 * The SOFT read keeps the gate and removes the line:
 *
 *  1. The bake stores each texel's gate for both season buckets in the one
 *     lane nothing read (`splatWeightHi.a`; canopy closure stays in
 *     `splatWeightLo.a`, the lane the vertex stage reads), computed from the
 *     8-bit weights exactly as the fragment will decode them.
 *  2. The fragment loads the four corners' gates, and where all four agree it
 *     returns the CHEAP read unchanged (both interiors are bit-identical).
 *  3. Between them, the gate is their bilinear blend, and the drawn pair is
 *     the nearest texel's when it passes, else the most-weighted corner that
 *     does. The pair's weight moves toward Grass as the gate falls, through
 *     two layers only, continuously, reaching the Grass base at 0.
 *  4. Everything leaves at CHEAP's confidence, -1: a moved pair is still a
 *     gated pair of swards, and the Grass base is a refused pair (Sand, Sand),
 *     which is exactly how CHEAP hands a refused texel to the fragment. So the
 *     fragment, its class strength and its third candidate are untouched.
 *
 * Every WGSL function below has its CPU twin beside it, line for line; the
 * Node pins run the twins.
 */

/** How vegetated both ids of a pair must be for the pair to count as swards. */
export const TERRAIN_SEAM_SWARD_COVER_MINIMUM = 0.9;
/** A secondary under this share is not part of the pair: its id is noise. */
export const TERRAIN_FAR_SWARD_NEGLIGIBLE_SHARE = 0.02;

/** A texel's (primary id, secondary id, secondary's share), as the fragment picks them. */
export interface FarSwardPair {
  readonly primary: number;
  readonly secondary: number;
  readonly share: number;
}

/** What the page splat hands the fragment: a pair and the confidence lane. */
export interface FarSwardSplat extends FarSwardPair {
  /** The confidence lane: -1, zero trust (the fragment gates the pair itself). */
  readonly w: number;
}

export function farSwardIsSward(id: number): boolean {
  return groundCoverOf(id)[0] >= TERRAIN_SEAM_SWARD_COVER_MINIMUM;
}

/** The gate: may this pair name a sward mixture for the feather? */
export function farSwardPairEligible(pair: FarSwardPair): boolean {
  return farSwardIsSward(pair.primary)
    && (farSwardIsSward(pair.secondary) || pair.share < TERRAIN_FAR_SWARD_NEGLIGIBLE_SHARE);
}

/**
 * The fragment's pair from four ids and four weights (`terrainSurfaceSplatAt`):
 * the heaviest lane, then the next, lanes 0 and 1 compared first.
 */
export function farSwardPairOf(ids: readonly number[], weights: readonly number[]): FarSwardPair {
  let primaryLane = 0;
  let secondaryLane = 1;
  if (weights[1]! > weights[0]!) {
    primaryLane = 1;
    secondaryLane = 0;
  }
  for (let lane = 2; lane < 4; lane += 1) {
    if (weights[lane]! > weights[primaryLane]!) {
      secondaryLane = primaryLane;
      primaryLane = lane;
    } else if (weights[lane]! > weights[secondaryLane]!) {
      secondaryLane = lane;
    }
  }
  const primaryWeight = Math.max(weights[primaryLane]!, 0);
  const secondaryWeight = Math.max(weights[secondaryLane]!, 0);
  return {
    primary: ids[primaryLane]!,
    secondary: ids[secondaryLane]!,
    share: secondaryWeight / Math.max(1e-6, primaryWeight + secondaryWeight),
  };
}

/** A bucket's four weights as the fragment decodes them: lanes 0-2 in 8 bits, lane 3 the residual. */
export function farSwardDecodedWeights(weights: readonly number[]): number[] {
  const q = [0, 1, 2].map((lane) => Math.round(Math.min(1, Math.max(0, weights[lane]!)) * 255) / 255);
  return [q[0]!, q[1]!, q[2]!, Math.max(0, 1 - q[0]! - q[1]! - q[2]!)];
}

/**
 * The bake's gate code for one texel: bit 0 the low season bucket's gate, bit
 * 1 the high one's, each on the weights the fragment will decode.
 */
export function farSwardGateCode(
  ids: readonly number[],
  weightsLo: readonly number[],
  weightsHi: readonly number[],
): number {
  const low = farSwardPairEligible(farSwardPairOf(ids, farSwardDecodedWeights(weightsLo))) ? 1 : 0;
  const high = farSwardPairEligible(farSwardPairOf(ids, farSwardDecodedWeights(weightsHi))) ? 1 : 0;
  return low + 2 * high;
}

/** The byte the bake stores for a code, as the fragment reads it back (unorm8). */
export function farSwardGateStored(code: number): number {
  return Math.round((code / 3) * 255) / 255;
}

/** The fragment's gate for a stored lane and a season blend: exact where both buckets agree. */
export function farSwardGateDecode(stored: number, blend: number): number {
  const code = Math.round(stored * 3);
  const low = code & 1;
  const high = (code >> 1) & 1;
  return low === high ? low : low * (1 - blend) + high * blend;
}

/**
 * A gated pair moved toward the Grass base by `gate` (1 the pair, 0 Grass),
 * in two layers and continuously. A pair holding Grass moves its own share;
 * one without first folds its secondary into its primary (gate 1 to 0.5), then
 * trades the primary for Grass (0.5 to 0), so the upper id changes only where
 * its weight is exactly zero.
 */
export function farSwardTowardGrass(pair: FarSwardPair, gate: number): FarSwardPair {
  const grass = SurfaceMaterial.Grass;
  if (pair.primary === grass) {
    return { primary: grass, secondary: pair.secondary, share: pair.share * gate };
  }
  if (pair.secondary === grass) {
    return { primary: pair.primary, secondary: grass, share: 1 - (1 - pair.share) * gate };
  }
  return gate >= 0.5
    ? { primary: pair.primary, secondary: pair.secondary, share: pair.share * (2 * gate - 1) }
    : { primary: pair.primary, secondary: grass, share: 1 - 2 * gate };
}

/** One of the four texels around a fragment: its decoded gate and its pair. */
export interface FarSwardCorner {
  readonly gate: number;
  readonly pair: FarSwardPair;
}

/** A refused pair at zero trust: the fragment keeps its Grass base, as for a refused CHEAP texel. */
export const FAR_SWARD_GRASS_BASE: FarSwardSplat = Object.freeze({
  primary: SurfaceMaterial.Sand,
  secondary: SurfaceMaterial.Sand,
  share: 0,
  w: -1,
});

/** CHEAP: the nearest texel's pair at full strength. */
export function farSwardCheapSplat(
  corners: readonly FarSwardCorner[],
  fraction: { readonly x: number; readonly y: number },
): FarSwardSplat {
  const nearest = (fraction.x >= 0.5 ? 1 : 0) + (fraction.y >= 0.5 ? 2 : 0);
  return { ...corners[nearest]!.pair, w: -1 };
}

/**
 * SOFT (`terrainSurfaceSoftSplat`). `corners` are (0,0), (1,0), (0,1), (1,1)
 * from the cell's base texel; `fraction` is the fragment's place in the cell.
 */
export function farSwardSoftSplat(
  corners: readonly FarSwardCorner[],
  fraction: { readonly x: number; readonly y: number },
): FarSwardSplat {
  const cheap = farSwardCheapSplat(corners, fraction);
  const gates = corners.map((corner) => corner.gate);
  if (gates.every((gate) => gate === 1) || gates.every((gate) => gate === 0)) return cheap;
  const weights = [
    (1 - fraction.x) * (1 - fraction.y),
    fraction.x * (1 - fraction.y),
    (1 - fraction.x) * fraction.y,
    fraction.x * fraction.y,
  ];
  const gate = weights.reduce((sum, weight, corner) => sum + weight * gates[corner]!, 0);
  let pair: FarSwardPair = cheap;
  if (!farSwardPairEligible(pair)) {
    let best = 0;
    for (let corner = 1; corner < 4; corner += 1) {
      if (weights[corner]! * gates[corner]! > weights[best]! * gates[best]!) best = corner;
    }
    if (!(weights[best]! * gates[best]! > 0)) return FAR_SWARD_GRASS_BASE;
    pair = corners[best]!.pair;
    if (!farSwardPairEligible(pair)) return FAR_SWARD_GRASS_BASE;
  }
  if (gate >= 1) return { ...pair, w: -1 };
  if (!(gate > 0)) return FAR_SWARD_GRASS_BASE;
  return { ...farSwardTowardGrass(pair, gate), w: -1 };
}

/**
 * The bake's half (`LAND_COVER_SPLAT_BAKE_WGSL` includes it): the gate code of
 * one aligned texel. Needs the bake's `SeasonalLandCoverWeights`.
 */
export const FAR_SWARD_BAKE_GATE_WGSL = /* wgsl */ `
fn splatFarSwardIsSward(id: u32) -> bool {
  return ${[...Array(SURFACE_MATERIAL_COUNT).keys()].filter(farSwardIsSward).map((id) => `id == ${id}u`).join(" || ")};
}

// The gate on one bucket, from its weights as the fragment will decode them:
// lanes 0-2 quantised to 8 bits, lane 3 the residual (farSwardGateCode).
fn splatFarSwardGate(ids: vec4f, weights: vec4f) -> f32 {
  let q = round(clamp(weights.xyz, vec3f(0.0), vec3f(1.0)) * 255.0) / 255.0;
  let w = vec4f(q, max(0.0, 1.0 - q.x - q.y - q.z));
  var primaryLane = 0u;
  var secondaryLane = 1u;
  if (w[1] > w[0]) { primaryLane = 1u; secondaryLane = 0u; }
  for (var lane = 2u; lane < 4u; lane = lane + 1u) {
    if (w[lane] > w[primaryLane]) {
      secondaryLane = primaryLane;
      primaryLane = lane;
    } else if (w[lane] > w[secondaryLane]) {
      secondaryLane = lane;
    }
  }
  let primaryWeight = max(w[primaryLane], 0.0);
  let secondaryWeight = max(w[secondaryLane], 0.0);
  let share = secondaryWeight / max(1e-6, primaryWeight + secondaryWeight);
  let eligible = splatFarSwardIsSward(u32(ids[primaryLane] + 0.5))
    && (splatFarSwardIsSward(u32(ids[secondaryLane] + 0.5))
      || share < ${TERRAIN_FAR_SWARD_NEGLIGIBLE_SHARE});
  return select(0.0, 1.0, eligible);
}

// Bit 0 the low bucket, bit 1 the high; stored as code / 3 in an 8-bit lane.
fn splatFarSwardGateStored(aligned: SeasonalLandCoverWeights) -> f32 {
  let code = splatFarSwardGate(aligned.ids, aligned.weightsLo)
    + 2.0 * splatFarSwardGate(aligned.ids, aligned.weightsHi);
  return code / 3.0;
}
`;

/**
 * The fragment's half: needs `terrainSplatWeightHi`, `terrainGroundCoverOf`
 * and `terrainSurfaceSplatAt` / `terrainSurfaceNearestSplat` in scope.
 */
export const FAR_SWARD_SOFT_READ_WGSL = /* wgsl */ `
fn terrainFarSwardEligible(pair: vec3f) -> bool {
  return terrainGroundCoverOf(i32(pair.x)).x >= ${TERRAIN_SEAM_SWARD_COVER_MINIMUM}
    && (terrainGroundCoverOf(i32(pair.y)).x >= ${TERRAIN_SEAM_SWARD_COVER_MINIMUM}
      || pair.z < ${TERRAIN_FAR_SWARD_NEGLIGIBLE_SHARE});
}

// The stored gate of a texel for this season blend (farSwardGateDecode).
fn terrainFarSwardGateAt(texel: vec2i, blend: f32) -> f32 {
  let code = u32(round(textureLoad(terrainSplatWeightHi, texel, 0).a * 3.0));
  let low = f32(code & 1u);
  let high = f32((code >> 1u) & 1u);
  return select(low * (1.0 - blend) + high * blend, low, low == high);
}

// The pair moved toward Grass by the gate (farSwardTowardGrass).
fn terrainFarSwardTowardGrass(pair: vec3f, gate: f32) -> vec3f {
  let grass = ${SurfaceMaterial.Grass}.0;
  if (pair.x == grass) { return vec3f(grass, pair.y, pair.z * gate); }
  if (pair.y == grass) { return vec3f(pair.x, grass, 1.0 - (1.0 - pair.z) * gate); }
  if (gate >= 0.5) { return vec3f(pair.x, pair.y, pair.z * (2.0 * gate - 1.0)); }
  return vec3f(pair.x, grass, 1.0 - 2.0 * gate);
}

// V-4, the SOFT read (farSwardSoftSplat): four gate loads, the nearest pair's
// three, and three more only where the nearest texel is refused beside one
// that is not.
fn terrainSurfaceSoftSplat(atlasPosition: vec2f, blend: f32) -> vec4f {
  let cheap = vec4f(terrainSurfaceNearestSplat(atlasPosition, blend), -1.0);
  // A refused pair at zero trust, as CHEAP hands over a refused texel.
  let grassBase = vec4f(${SurfaceMaterial.Sand}.0, ${SurfaceMaterial.Sand}.0, 0.0, -1.0);
  let base = floor(atlasPosition);
  let fraction = atlasPosition - base;
  let corner = vec2i(base);
  let gates = vec4f(
    terrainFarSwardGateAt(corner, blend),
    terrainFarSwardGateAt(corner + vec2i(1, 0), blend),
    terrainFarSwardGateAt(corner + vec2i(0, 1), blend),
    terrainFarSwardGateAt(corner + vec2i(1, 1), blend));
  if (all(gates == vec4f(1.0)) || all(gates == vec4f(0.0))) { return cheap; }
  let weights = vec4f(
    (1.0 - fraction.x) * (1.0 - fraction.y),
    fraction.x * (1.0 - fraction.y),
    (1.0 - fraction.x) * fraction.y,
    fraction.x * fraction.y);
  let gate = dot(weights, gates);
  var pair = cheap.xyz;
  if (!terrainFarSwardEligible(pair)) {
    let scored = weights * gates;
    var best = 0u;
    for (var index = 1u; index < 4u; index = index + 1u) {
      if (scored[index] > scored[best]) { best = index; }
    }
    if (!(scored[best] > 0.0)) { return grassBase; }
    pair = terrainSurfaceSplatAt(corner + vec2i(i32(best & 1u), i32(best >> 1u)), blend);
    if (!terrainFarSwardEligible(pair)) { return grassBase; }
  }
  if (gate >= 1.0) { return vec4f(pair, -1.0); }
  if (!(gate > 0.0)) { return grassBase; }
  return vec4f(terrainFarSwardTowardGrass(pair, gate), -1.0);
}
`;
