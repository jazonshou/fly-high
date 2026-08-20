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
