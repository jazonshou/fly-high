import { roundedRectangleSignedDistance } from "@/src/world/airport";
import { clamp, lerp, saturate, smoothstep, valueNoise2D } from "@/src/world/noise";
import { mixSeed } from "@/src/world/seed";
import type { AirportDefinition } from "@/src/world/types";

/**
 * 3-8 — the runway earthworks profile (owner: terrain-material).
 *
 * INVARIANT THIS FILE OWNS: there is exactly one description of the ground the
 * airport sits on, and BOTH the renderer and the physics collision fast path
 * evaluate it.
 *
 * **This item changes the physics authority. It is Class K.** The runway is
 * cambered so water sheds — a 0.35 m crown — and the collision fast path in
 * `sampleTerrainCollisionHeight` returns before any height sampling on the
 * runway branch. Add the crown to the rendered surface alone and the two
 * surfaces disagree by up to 0.35 m across the runway: the aircraft touches
 * down on a surface that is not the one on screen, worst at the edges where a
 * crosswind landing puts you. That is a direct violation of ARCHITECTURE.md
 * §3, and Phase 0's invariant test would NOT have caught it, because that test
 * asserts `getAirportInfluence == 1.0` across the apron — which stays true.
 * The influence is fine; the height behind it is what changes.
 *
 * So the profile is a named function, both authorities call it, and a fifth
 * invariant test (assertion 63) pins them to within 1 mm.
 *
 * Written to the `0-4` portability contract from the first line, because `4-9`
 * transliterates it into WGSL: pure arithmetic over `number`, `max(0, …)`
 * under every `pow`, wrap-safe coordinates (the noise term is `valueNoise2D`,
 * whose lattice is already bounded and f32-exact), and no branch on float
 * equality.
 *
 * NOT a second elevation authority. "Median site elevation" is already where
 * `airport.elevation` comes from — `airportSite.ts:412` is literally
 * `const elevation = median(platformHeights)` — so this file takes the
 * platform datum as given rather than re-deriving it. A second median here
 * would be exactly the parallel-path failure the owner manifest exists to
 * prevent.
 */

/**
 * The profile's constants. Exported as data so `4-9`'s WGSL transliteration
 * and the invariant tests read the same numbers this file does.
 */
export const runwayEarthworksProfile = Object.freeze({
  /**
   * Camber fall from the centreline to the graded edge, metres. A runway
   * sheds water sideways.
   *
   * The geometry works out, which is worth checking before committing to
   * PAINTING the runway rather than meshing it: a crowned runway is a shallow
   * parabola, `y'' = −8c/w²`, and the chord error over a span `h` is
   * `|y''|h²/8`. At c = 0.35 m over the 62 m graded width that is 5.8 mm at
   * 8 m vertex spacing and 23 mm at 16 m — well inside landing-gear tolerance.
   * The coarse terrain mesh represents the crown without special tessellation
   * under the airport, which removes an item the plan might otherwise have
   * needed.
   */
  crownMeters: 0.35,
  /**
   * Cut batters stand steeper than fill embankments — that asymmetry is most
   * of what makes earthworks read as earthworks rather than as a ramp. The
   * exponents shape the transition from the platform edge outward: above 1
   * holds the platform grade longer before falling away.
   */
  fillShapeExponent: 1.75,
  cutShapeExponent: 1.15,
  /**
   * A cut batter is steeper than a fill embankment because it reaches the
   * natural surface over a SHORTER distance, not because its profile leaves
   * the platform edge vertically.
   *
   * The first draft expressed the asymmetry as an exponent below 1, and
   * `d/dt (t^0.62)` is unbounded at t = 0: the batter left the platform edge
   * at 36–51° on real seeds, which the collision path's 2 m central difference
   * then reported as a 5–9° ramp. Both exponents are ≥ 1 now, so the profile
   * leaves the platform tangentially and the normal the aircraft feels is the
   * surface it is on.
   */
  cutBlendScale: 0.62,
  /**
   * Height difference over which cut blends into fill, metres.
   *
   * **This exists because a hard branch here is a cliff.** Cut and fill differ
   * by more than their exponent: the bench term below is +bench for one and
   * −bench for the other, so `if (natural < platform)` puts a step of
   * `2 × benchMeters` wherever the natural surface crosses the platform
   * elevation — which is a closed contour, so it is a RING of cliffs around
   * the airport, and the collision path evaluates the same function. Measured
   * at 1.09 m over 0.25 m of ground on three seeds before this blend existed.
   */
  cutFillBlendMeters: 4,
  /**
   * The blend distance is modulated INWARD by up to this fraction of its
   * nominal value, by a smooth field at `blendNoiseWavelengthMeters`. A
   * CONSTANT blend distance is what makes the |natural − final| contour a
   * closed convex curve — the circular plateau the exit criterion tests for.
   *
   * Inward-only is deliberate and load-bearing: `airport.terrainBlendDistance`
   * stays a hard outer bound, so `getAirportInfluence == 0` still implies the
   * terrain is untouched. Modulating outward would have made the influence
   * field and the earthworks disagree about where the airport ends, which is
   * the second authority this phase is trying not to create.
   */
  blendModulation: 0.45,
  blendNoiseWavelengthMeters: 260,
  /** Noise channel, kept distinct from every kernel channel in terrain.ts. */
  blendNoiseChannel: 240,
  /**
   * A shallow berm at the toe of a fill embankment and a shallow bench at the
   * top of a cut — the third zone. Small, but it is the difference between an
   * embankment and a cone.
   */
  benchMeters: 0.42,
});

/** Half-extents of the graded platform: paved runway plus safety areas and shoulders. */
export function runwayPlatformHalfLength(airport: Readonly<AirportDefinition>): number {
  return airport.runwayLength * 0.5 + airport.endSafetyArea;
}

export function runwayPlatformHalfWidth(airport: Readonly<AirportDefinition>): number {
  return airport.runwayWidth * 0.5 + airport.shoulderWidth;
}

/**
 * Signed distance to the graded platform's rounded rectangle, metres.
 *
 * The same shape `getAirportInfluence` keys on — deliberately, because
 * requirement 1 of this item is that `getAirportInfluence` stays exactly 1.0
 * inside the apron and both must agree about where "inside" ends.
 * `3-9` transliterates this into WGSL with an agreement test (assertion 65).
 */
export function runwayPlatformSignedDistance(
  airport: Readonly<AirportDefinition>,
  along: number,
  across: number,
): number {
  return roundedRectangleSignedDistance(
    along,
    across,
    runwayPlatformHalfLength(airport),
    runwayPlatformHalfWidth(airport),
  );
}

/**
 * The camber, as a SIGNED offset from the platform datum, at a runway-local
 * across coordinate: 0 on the centreline and −`crownMeters` at the graded
 * edge.
 *
 * The sign convention is load-bearing. `airport.elevation` is the site's
 * median elevation and is also the aircraft's spawn datum and the height every
 * pre-Phase-3 test and tuning pass was written against, so the centreline
 * stays exactly there and the camber only lowers the shoulders. Crowning
 * upward instead would have raised the whole runway by 0.35 m relative to
 * spawn.
 *
 * The collision fast path calls exactly this: it stays fast — one analytic
 * evaluation, no noise, no terrain sampling — but it is no longer a lie.
 */
export function runwayCrownHeight(
  airport: Readonly<AirportDefinition>,
  across: number,
): number {
  const halfWidth = runwayPlatformHalfWidth(airport);
  if (halfWidth <= 0) return 0;
  const normalized = clamp(Math.abs(across) / halfWidth, 0, 1);
  return -runwayEarthworksProfile.crownMeters * normalized * normalized;
}

/** The platform's own surface height at a runway-local coordinate. */
export function runwayPlatformHeight(
  airport: Readonly<AirportDefinition>,
  across: number,
): number {
  return airport.elevation + runwayCrownHeight(airport, across);
}

/**
 * The three-zone cut/fill profile, replacing `flattenHeightForAirport`'s
 * single lerp toward a flat disc.
 *
 * Zone 1 — the graded platform (`distance <= 0`): the crowned plane, exactly.
 * Zone 2 — the batter: a cut or fill transition to the natural surface, with
 *          a noise-modulated blend distance and different shapes for cut and
 *          fill.
 * Zone 3 — untouched natural terrain.
 *
 * `along`/`across` are the runway-local coordinates the caller already has
 * (from `worldToRunway`), passed in rather than recomputed so the hot physics
 * path pays for one rotation, not two.
 */
export function runwayEarthworksHeightLocal(
  airport: Readonly<AirportDefinition>,
  naturalHeight: number,
  along: number,
  across: number,
  worldX: number,
  worldZ: number,
  seedHash: number,
): number {
  const platform = runwayPlatformHeight(airport, across);
  const distance = runwayPlatformSignedDistance(airport, along, across);
  if (distance <= 0) return platform;

  const wavelength = runwayEarthworksProfile.blendNoiseWavelengthMeters;
  const wobble = valueNoise2D(
    mixSeed(seedHash, runwayEarthworksProfile.blendNoiseChannel),
    worldX / wavelength,
    worldZ / wavelength,
  );
  // Cut where the hillside stands above the platform, fill where it falls
  // away — blended over `cutFillBlendMeters` of height difference rather than
  // switched, because the two shapes disagree by 2 x benchMeters and a hard
  // branch would put that step on the closed contour where they meet.
  const fillness = saturate(
    0.5 - (naturalHeight - platform) / runwayEarthworksProfile.cutFillBlendMeters,
  );
  const blendDistance = Math.max(
    1,
    airport.terrainBlendDistance
    * (1 - runwayEarthworksProfile.blendModulation * saturate(0.5 + 0.5 * wobble))
    * lerp(runwayEarthworksProfile.cutBlendScale, 1, fillness),
  );
  if (distance >= blendDistance) return naturalHeight;

  const t = saturate(distance / blendDistance);
  // `max(0, …)` under the pow() is the 0-4 rule, not decoration — a negative
  // base is undefined in WGSL.
  const exponent = lerp(
    runwayEarthworksProfile.cutShapeExponent,
    runwayEarthworksProfile.fillShapeExponent,
    fillness,
  );
  const shape = Math.pow(Math.max(0, t), exponent);
  let height = platform + (naturalHeight - platform) * shape;

  // Zone 3's signature: a berm at the toe of a fill and a bench at the head of
  // a cut. A single smooth lobe over the outer half of the batter, signed by
  // the same continuous blend.
  const lobe = smoothstep(0.35, 0.7, t) * (1 - smoothstep(0.7, 1, t));
  height += runwayEarthworksProfile.benchMeters * (fillness * 2 - 1) * lobe;
  return height;
}

// ---------------------------------------------------------------------------
// `4-9` — the earthworks in WGSL
// ---------------------------------------------------------------------------

/**
 * The airport uniform the WGSL earthworks read, packed by
 * `packRunwayEarthworksUniform`.
 *
 * `sinHeading` and `cosHeading` are HOISTED, computed once in f64 on the CPU
 * and passed as f32. WGSL specifies `sin` and `cos` to an ABSOLUTE error
 * bound rather than a relative one, so recomputing the heading rotation per
 * texel is the single largest divergence source in this item — larger than
 * everything else in the profile put together. Hoisting removes it.
 */
export const RUNWAY_EARTHWORKS_UNIFORM_FLOATS = 16;

export function packRunwayEarthworksUniform(
  airport: Readonly<AirportDefinition> | null,
  seedHash: number,
): Float32Array {
  const packed = new Float32Array(RUNWAY_EARTHWORKS_UNIFORM_FLOATS);
  writeRunwayEarthworksUniform(packed, new Uint32Array(packed.buffer), 0, airport, seedHash);
  return packed;
}

/**
 * `packRunwayEarthworksUniform`'s sixteen lanes, written IN PLACE at float
 * `offset` of a buffer seen through two views of the same bytes — every lane,
 * the unused ones zeroed, so a slot that held another airport is fully
 * overwritten.
 */
function writeRunwayEarthworksUniform(
  floats: Float32Array,
  words: Uint32Array,
  offset: number,
  airport: Readonly<AirportDefinition> | null,
  seedHash: number,
): void {
  words.fill(0, offset, offset + RUNWAY_EARTHWORKS_UNIFORM_FLOATS);
  if (!airport) return;
  floats[offset] = 1;
  floats[offset + 1] = airport.centerX;
  floats[offset + 2] = airport.centerZ;
  floats[offset + 3] = airport.elevation;
  floats[offset + 4] = Math.sin(airport.headingRadians);
  floats[offset + 5] = Math.cos(airport.headingRadians);
  floats[offset + 6] = runwayPlatformHalfLength(airport);
  floats[offset + 7] = runwayPlatformHalfWidth(airport);
  floats[offset + 8] = airport.terrainBlendDistance;
  // The noise channel's already-mixed hash: valueNoise2D mixes channel 0 once
  // per evaluation, and both mixes are page constants.
  // Slot 12 is the struct's `seeds: vec4u`: the already-mixed hash reaches
  // the shader as a real u32, never through an f32 lane.
  words[offset + 12] = mixSeed(
    mixSeed(seedHash, runwayEarthworksProfile.blendNoiseChannel),
    0,
  ) >>> 0;
}

/**
 * Airport slots the GPU terrain carries at once: every shader that grades,
 * paints or classifies the ground compiles with arrays of exactly this many,
 * so an airport spawning mid-flight writes uniforms and never recompiles.
 *
 * It is `AIRPORT_SPAWN_POLICY.maxAirports` (`src/world/airportNetwork.ts`),
 * restated rather than imported because `src/world/terrain.ts` imports this
 * module and the network imports the terrain, so the import would close a
 * cycle and this constant would read `undefined` while the template strings
 * below are built. `tests/render.webgpu-airport-terrain.test.ts` pins the two
 * to each other.
 */
export const TERRAIN_AIRPORT_SLOTS = 8;

/** Floats in `RunwayEarthworksSet`: a vec4u header, then one struct per slot. */
export const RUNWAY_EARTHWORKS_SET_FLOATS = 4
  + TERRAIN_AIRPORT_SLOTS * RUNWAY_EARTHWORKS_UNIFORM_FLOATS;

/**
 * Every airport's earthworks uniform, packed for `RunwayEarthworksSet`.
 *
 * Slot `n` holds `packRunwayEarthworksUniform(airports[n])` bit for bit, so a
 * one-airport world uploads exactly the struct it always did, in slot 0, and
 * the shader evaluates it with exactly the arithmetic it always did. The seed
 * lane is written through a u32 view and never passes through an f32 copy,
 * for the reason `packRunwayEarthworksUniform` gives. Past the slot count the
 * list is truncated; the airport network never sends that many.
 *
 * `target`, when given, is rewritten in place — every lane, unused slots
 * zeroed — so a caller that holds one array uploads the same bytes each time.
 */
export function packRunwayEarthworksSetUniform(
  airports: readonly Readonly<AirportDefinition>[],
  seedHash: number,
  target: Float32Array = new Float32Array(RUNWAY_EARTHWORKS_SET_FLOATS),
): Float32Array {
  if (target.length !== RUNWAY_EARTHWORKS_SET_FLOATS) {
    throw new RangeError("Runway earthworks set target has the wrong length");
  }
  const words = new Uint32Array(target.buffer, target.byteOffset, RUNWAY_EARTHWORKS_SET_FLOATS);
  const count = Math.min(airports.length, TERRAIN_AIRPORT_SLOTS);
  words.fill(0, 0, 4);
  words[0] = count;
  for (let slot = 0; slot < TERRAIN_AIRPORT_SLOTS; slot += 1) {
    writeRunwayEarthworksUniform(
      target,
      words,
      4 + slot * RUNWAY_EARTHWORKS_UNIFORM_FLOATS,
      slot < count ? airports[slot]! : null,
      seedHash,
    );
  }
  return target;
}

/**
 * `runwayEarthworksHeightLocal`, transliterated.
 *
 * `3-9` already owns the airport SDF (`RUNWAY_SDF_WGSL`); this CONSUMES it and
 * does not write a second one. The two physics entry points take DIFFERENT
 * short-circuits — `sampleTerrainCollisionHeight` returns early on
 * `getAirportInfluence >= 1` (the full graded platform) while the render path
 * evaluates the fade — so the parity grid has to cover the apron, the shoulder
 * band, the whole `terrainBlendDistance` fade and beyond it, not just the
 * paved rectangle.
 *
 * Requires `kLerp`, `kSaturate`, `kSmoothstep`, `kValueNoiseSplit` and
 * `kMixSeed` from the terrain kernel include, and `terrainRunwayRoundedRect`
 * and `terrainRunwayLocal` from the airport SDF include.
 */
export const RUNWAY_EARTHWORKS_WGSL = /* wgsl */ `
struct RunwayEarthworks {
  // (enabled, centre x, centre z, platform elevation)
  site: vec4f,
  // (sinHeading, cosHeading, half length, half width)
  frame: vec4f,
  // (terrainBlendDistance, 0, 0, 0)
  blend: vec4f,
  // The already-mixed noise hash, as a REAL u32: routing it through an f32
  // lane risks the hash landing on a NaN bit pattern, which a storage load is
  // free to canonicalise.
  seeds: vec4u,
};

const K_CROWN_METERS: f32 = ${runwayEarthworksProfile.crownMeters};
const K_FILL_SHAPE_EXPONENT: f32 = ${runwayEarthworksProfile.fillShapeExponent};
const K_CUT_SHAPE_EXPONENT: f32 = ${runwayEarthworksProfile.cutShapeExponent};
const K_CUT_BLEND_SCALE: f32 = ${runwayEarthworksProfile.cutBlendScale};
const K_CUT_FILL_BLEND_METERS: f32 = ${runwayEarthworksProfile.cutFillBlendMeters};
const K_BLEND_MODULATION: f32 = ${runwayEarthworksProfile.blendModulation};
const K_BLEND_NOISE_WAVELENGTH: f32 = ${runwayEarthworksProfile.blendNoiseWavelengthMeters};
const K_BENCH_METERS: f32 = ${runwayEarthworksProfile.benchMeters};

/** The camber, as a SIGNED offset from the platform datum. */
fn terrainRunwayCrownHeight(earthworks: RunwayEarthworks, across: f32) -> f32 {
  let halfWidth = earthworks.frame.w;
  if (halfWidth <= 0.0) { return 0.0; }
  let normalized = clamp(abs(across) / halfWidth, 0.0, 1.0);
  return -K_CROWN_METERS * normalized * normalized;
}

/**
 * The three-zone cut/fill profile.
 *
 * Zone 1 (distance <= 0) is the crowned platform exactly; zone 2 is a
 * cut-or-fill batter blended over cutFillBlendMeters of HEIGHT difference
 * rather than switched, because the two shapes differ by 2 x benchMeters and
 * a hard branch would put that step on the closed contour where they meet —
 * a RING of cliffs around the airport, which the collision path would feel;
 * zone 3 is untouched natural terrain.
 */
fn terrainRunwayEarthworksHeight(
  earthworks: RunwayEarthworks,
  naturalHeight: f32,
  worldX: f32,
  worldZ: f32,
) -> f32 {
  if (earthworks.site.x < 0.5) { return naturalHeight; }
  let local = terrainRunwayLocal(
    vec2f(worldX, worldZ),
    earthworks.site.yz,
    earthworks.frame.x,
    earthworks.frame.y,
  );
  let platform = earthworks.site.w + terrainRunwayCrownHeight(earthworks, local.y);
  let distance = terrainRunwayRoundedRect(
    local.x, local.y, earthworks.frame.z, earthworks.frame.w,
  );
  if (distance <= 0.0) { return platform; }

  let wobble = kValueNoiseSplit(
    earthworks.seeds.x,
    0,
    worldX / K_BLEND_NOISE_WAVELENGTH,
    0,
    worldZ / K_BLEND_NOISE_WAVELENGTH,
  );
  let fillness = kSaturate(0.5 - (naturalHeight - platform) / K_CUT_FILL_BLEND_METERS);
  let blendDistance = max(
    1.0,
    earthworks.blend.x
      * (1.0 - K_BLEND_MODULATION * kSaturate(0.5 + 0.5 * wobble))
      * kLerp(K_CUT_BLEND_SCALE, 1.0, fillness),
  );
  if (distance >= blendDistance) { return naturalHeight; }

  let t = kSaturate(distance / blendDistance);
  let exponent = kLerp(K_CUT_SHAPE_EXPONENT, K_FILL_SHAPE_EXPONENT, fillness);
  // max(0, ...) under the pow is the 0-4 rule, not decoration: a negative
  // base is undefined in WGSL.
  let shape = pow(max(0.0, t), exponent);
  var height = platform + (naturalHeight - platform) * shape;
  let lobe = kSmoothstep(0.35, 0.7, t) * (1.0 - kSmoothstep(0.7, 1.0, t));
  height = height + K_BENCH_METERS * (fillness * 2.0 - 1.0) * lobe;
  return height;
}
`;

/**
 * Every airport's earthworks, for a shader that grades more than the home
 * field: the struct, plus the nearest-centre selection over it.
 *
 * `worldAirportAt` (`src/world/airport.ts`) is the CPU rule: the airport whose
 * CENTRE is nearest shapes the ground, and only it. Airports stand at least
 * `AIRPORT_SPAWN_POLICY.minSeparationMeters` (4 km) apart and one airport's
 * earthworks reach about 1 km from its centre, so the selection only ever
 * changes airport where both candidates return the natural height bit for
 * bit — which is also why f32 distances here and f64 ones on the CPU can
 * disagree on the bisector without the two heights disagreeing.
 *
 * The selection is the only cost added per texel: one `vec2` difference and
 * `dot` per airport after the first, then ONE evaluation of the unchanged
 * `terrainRunwayEarthworksHeight`. A one-airport world runs zero iterations
 * and evaluates slot 0, which holds exactly the struct the shader read before
 * this existed — so its pages are unchanged to the bit.
 *
 * `binding` names the composer's `var<storage, read> <binding>:
 * RunwayEarthworksSet`. The selection reads it directly rather than taking
 * the set as a parameter: a by-value parameter would copy all eight structs
 * per call, and a storage pointer parameter needs a language extension.
 * Requires `RUNWAY_EARTHWORKS_WGSL`.
 */
export function runwayEarthworksSetWgsl(binding: string): string {
  return /* wgsl */ `
const K_TERRAIN_AIRPORT_SLOTS: u32 = ${TERRAIN_AIRPORT_SLOTS}u;

struct RunwayEarthworksSet {
  // (airport count, 0, 0, 0). With no airport, slot 0 is zeroed and its
  // enabled lane reads 0, so the earthworks return the natural height.
  header: vec4u,
  airports: array<RunwayEarthworks, ${TERRAIN_AIRPORT_SLOTS}>,
};

/** worldAirportAt's nearest-centre rule; ties keep the lower slot, as it does. */
fn terrainRunwayEarthworksSlot(worldX: f32, worldZ: f32) -> u32 {
  let count = min(${binding}.header.x, K_TERRAIN_AIRPORT_SLOTS);
  let worldXz = vec2f(worldX, worldZ);
  let first = worldXz - ${binding}.airports[0].site.yz;
  var best = 0u;
  var bestDistance = dot(first, first);
  for (var slot = 1u; slot < count; slot = slot + 1u) {
    let delta = worldXz - ${binding}.airports[slot].site.yz;
    let distance = dot(delta, delta);
    let closer = distance < bestDistance;
    best = select(best, slot, closer);
    bestDistance = select(bestDistance, distance, closer);
  }
  return best;
}

/** The earthworks of the airport nearest a world point, evaluated once. */
fn terrainRunwayEarthworksNearestHeight(naturalHeight: f32, worldX: f32, worldZ: f32) -> f32 {
  return terrainRunwayEarthworksHeight(
    ${binding}.airports[terrainRunwayEarthworksSlot(worldX, worldZ)],
    naturalHeight,
    worldX,
    worldZ,
  );
}
`;
}
