import { runwayToWorld } from "../../../world/airport";
import { runwayPlatformHeight } from "../terrain/RunwayEarthworks";
import type { AirportDefinition } from "../../../world/types";

/**
 * `7-13` airfield furniture — the windsock's siting and its wind response.
 *
 * **This increment is the arithmetic only**, deliberately, for the same reason
 * `7-7` split its PAPI law out from its billboard: everything here is a pure
 * function of `AirportDefinition` and a wind sample, so it is testable without
 * a host and it is the part that has to be numerically right rather than merely
 * plausible. Meshes and animation follow; they cannot be wrong in a way a
 * number can.
 *
 * ---------------------------------------------------------------------------
 * **THE SOCK NEEDS ITS OWN WIND SAMPLE, AND THE RENDERER DOES NOT TAKE ONE.**
 *
 * `sampleWind(world, x, y, z, t)` is positional, but its only consumer samples
 * at the AIRCRAFT and forwards four scalars to `detail.setWind`
 * (`FlightRenderer`, verified by symbol rather than by line — the citations in
 * the plan for this have gone stale twice). A windsock driven by that snapshot
 * points the way the wind blows *where the aeroplane is*, which on final
 * approach is kilometres from the sock.
 *
 * **Why that is a trap rather than an approximation:** the sock would still
 * point plausibly, still swing, still respond to gusts. Nothing in a frame
 * distinguishes it. `windsockWorldPosition` exists so the sample can be taken
 * where the sock actually stands, and the test asserts the two samples DIFFER
 * rather than asserting the angle looks right — see the note on validation
 * below, because asserting the angle is exactly the check that passes anyway.
 */

/**
 * Wind speed at which a standard windsock is fully extended, m/s.
 *
 * ICAO Annex 14 specifies a sock that is fully extended at **15 kt** and
 * indicates direction down to about **3 kt**. 15 kt = 7.72 m/s. These are the
 * real numbers rather than art-directed ones, so a sock reads as an instrument
 * a pilot could take a speed off, which is what it is for.
 */
export const WINDSOCK_FULL_EXTENSION_MPS = 7.72;

/** Below this the sock hangs and shows no usable direction. 3 kt = 1.54 m/s. */
export const WINDSOCK_MINIMUM_INDICATION_MPS = 1.54;

/**
 * Droop of a slack sock below horizontal, radians. A limp sock hangs close to
 * vertical against the pole; 75 degrees is the visual read of "no wind" without
 * clipping the geometry into the mast.
 */
export const WINDSOCK_SLACK_DROOP_RADIANS = (75 * Math.PI) / 180;

/**
 * How far the sock stands from the runway centreline, metres.
 *
 * Outside the graded shoulder so it is never inside the runway strip, and on
 * the opposite side from the PAPI so the two do not occlude each other on
 * approach — `papiUnitPlacements` sites its units at negative `across` for the
 * `+1` end, so the sock takes positive.
 */
export const WINDSOCK_LATERAL_OFFSET_METERS = 55;

/** Mast height, metres. ICAO calls for the sock to be visible from the air. */
export const WINDSOCK_MAST_HEIGHT_METERS = 6;

/**
 * Where the sock stands, in world metres.
 *
 * Runway midpoint laterally offset — the midpoint rather than a threshold
 * because a sock serves both directions and a pilot on either approach must be
 * able to see it. Height comes through `runwayPlatformHeight`, never
 * `runwayToWorld`'s `y`: that field is `airport.elevation`, which is the
 * surface only on the centreline, and the sock is 55 m off it.
 */
export function windsockWorldPosition(
  airport: Readonly<AirportDefinition>,
): { x: number; y: number; z: number } {
  const across = WINDSOCK_LATERAL_OFFSET_METERS;
  const point = runwayToWorld(airport, 0, across);
  return {
    x: point.x,
    y: runwayPlatformHeight(airport, across) + WINDSOCK_MAST_HEIGHT_METERS,
    z: point.z,
  };
}

/**
 * The heading the sock points, radians clockwise from world north (+z).
 *
 * A windsock streams AWAY from the wind source: it points the direction the air
 * is travelling toward, which is the same convention `sampleWind` returns its
 * vector in and the same one `AirportDefinition.headingRadians` uses, so the
 * two are directly comparable without a sign fix. That comparability is the
 * whole reason to state the convention here rather than leave it implied — a
 * sock reading 180 degrees out still looks like a windsock.
 */
export function windsockHeadingRadians(windX: number, windZ: number): number {
  return Math.atan2(windX, windZ);
}

/**
 * How inflated the sock is, 0 (limp) to 1 (fully extended horizontal).
 *
 * Linear in speed between the indication minimum and full extension, because
 * that is what the instrument is calibrated to: a pilot reads speed off the
 * number of inflated segments, and a curve here would make that reading wrong.
 */
export function windsockInflation(speedMetersPerSecond: number): number {
  const span = WINDSOCK_FULL_EXTENSION_MPS - WINDSOCK_MINIMUM_INDICATION_MPS;
  const above = speedMetersPerSecond - WINDSOCK_MINIMUM_INDICATION_MPS;
  return Math.min(Math.max(above / span, 0), 1);
}

/**
 * Angle below horizontal, radians. 0 is fully extended; the slack droop at
 * zero inflation.
 */
export function windsockDroopRadians(speedMetersPerSecond: number): number {
  return (1 - windsockInflation(speedMetersPerSecond)) * WINDSOCK_SLACK_DROOP_RADIANS;
}

/**
 * Smallest angle between two headings, radians, in [0, pi].
 *
 * Exported because the windsock TEST needs it to assert its own premise — that
 * its validation seed really is a crosswind seed — and a test that computed
 * this itself could drift from what the code means by an angle.
 */
export function headingDifferenceRadians(a: number, b: number): number {
  const raw = Math.abs(a - b) % (2 * Math.PI);
  return raw > Math.PI ? 2 * Math.PI - raw : raw;
}

/**
 * Smallest angle between a runway AXIS and a wind DIRECTION, radians, in
 * [0, pi/2]. 0 is along the runway; pi/2 is a pure crosswind.
 *
 * **A runway is bidirectional and the wind is not**, so this is not
 * `headingDifferenceRadians`. Runway 09 and runway 27 are the same strip of
 * tarmac, so a wind blowing along it at 180 degrees to the stated heading is
 * still a headwind-or-tailwind, not a crosswind — the comparison folds at 90.
 *
 * FOUND BY THIS FILE'S OWN NON-VACUITY TEST, which is why it is a separate
 * function rather than a note. The windsock premise check first used the
 * heading difference and measured `sock-1` at **177.3 degrees**, apparently the
 * most crosswind seed in the set. Folded, it is **2.7 degrees** — the most
 * ALIGNED seed, and exactly what `SWE II 2` measured. The unfolded number is
 * not merely imprecise: it inverts the ordering, so a premise check built on it
 * would have selected the blind seed and called it the validation one.
 */
export function runwayAxisDifferenceRadians(
  runwayHeadingRadians: number,
  windHeadingRadians: number,
): number {
  const heading = headingDifferenceRadians(runwayHeadingRadians, windHeadingRadians);
  return heading > Math.PI / 2 ? Math.PI - heading : heading;
}

// ---------------------------------------------------------------------------
// Geometry. Separated from the arithmetic above because it can only be wrong in
// ways a number cannot be — and one of those ways is winding, which is why
// every part below is enumerated rather than hand-listed: the winding guard
// derives its cases from `WINDSOCK_PART_KINDS`, so a part added here is
// checked without anyone remembering to add it there.
// ---------------------------------------------------------------------------

/** ICAO Annex 14: a windsock is 3.6 m long with a 0.9 m mouth. */
export const WINDSOCK_LENGTH_METERS = 3.6;
export const WINDSOCK_MOUTH_RADIUS_METERS = 0.45;
/** The tail is narrower, which is what makes the sock stream rather than balloon. */
export const WINDSOCK_TAIL_RADIUS_METERS = 0.22;
export const WINDSOCK_MAST_RADIUS_METERS = 0.07;

/**
 * Every part the windsock is built from.
 *
 * THE WINDING GUARD ENUMERATES THIS. `render.webgpu-prototype-winding.test.ts`
 * derives its cases from this array rather than listing parts by hand, because
 * a hand-written case list is the artefact this project has already found
 * rotted twice — `GroundCoverSystem.buildBladeRibbon` shipped inverted while
 * the guard checked a grass card no capture drew, and `clutter.mossCushion` was
 * invisible because three of four kinds were unlisted.
 */
export const WINDSOCK_PART_KINDS = ["mast", "swivel", "sock"] as const;
export type WindsockPartKind = (typeof WINDSOCK_PART_KINDS)[number];

/** Positions, normals and indices — the shape the winding guard consumes. */
export interface WindsockPartGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

/**
 * A tube swept along +y, radius varying by ring.
 *
 * **The index order was DERIVED FROM THE GUARD, not remembered.** The first
 * version wound `(a, c, b)` on the reasoning that this is "Babylon's
 * convention" — a tuple copied from a comment on a different builder. The guard
 * measured +0.994 to +0.997 against Babylon's own -0.9993, i.e. inverted on all
 * three parts and both inflation arms.
 *
 * **A winding tuple is not portable between builders**, which is the reusable
 * part: whether `(a, c, b)` or `(a, b, c)` faces outward depends on how the
 * quad's four corners were ORDERED when they were emitted, and this tube walks
 * its rings in the opposite sense to the builder that comment came from. So
 * there is no convention to remember, only a measurement to take.
 *
 * Normals are the outward radial direction, authored independently of the index
 * order — deliberately, because deriving them FROM the winding would make an
 * inverted tube self-consistently inside-out and invisible to a guard that
 * compares the two. That is exactly how eight surfaces shipped inverted.
 */
function sweptTube(
  segments: number,
  rings: readonly { readonly y: number; readonly radius: number }[],
): WindsockPartGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let r = 0; r < rings.length; r += 1) {
    const ring = rings[r]!;
    // SLOPE-CORRECTED NORMAL. A purely radial `(cos, 0, sin)` is only correct
    // for a straight cylinder; on a tapered or domed section the surface tilts
    // and the normal must tilt with it, or a cone shades as a cylinder.
    //
    // FOUND BY AN UNEXPLAINED DEFICIT, which is the whole reason to compute the
    // expected number rather than eyeball it: every part here matched faceting's
    // `cos(pi/segments)` to ~1e-5 EXCEPT the tank saddle, the most steeply
    // tapered surface, which sat 4.1e-2 low. That residual was the missing
    // slope term. The guard still PASSED it — an inverted winding is what it
    // tests, and a mis-authored normal is not inverted, merely wrong.
    const previous = rings[Math.max(r - 1, 0)]!;
    const next = rings[Math.min(r + 1, rings.length - 1)]!;
    const dy = next.y - previous.y;
    const slope = dy === 0 ? 0 : (next.radius - previous.radius) / dy;
    const inverseLength = 1 / Math.hypot(1, slope);
    for (let s = 0; s <= segments; s += 1) {
      const angle = (s / segments) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      positions.push(cos * ring.radius, ring.y, sin * ring.radius);
      normals.push(cos * inverseLength, -slope * inverseLength, sin * inverseLength);
    }
  }
  const stride = segments + 1;
  for (let r = 0; r + 1 < rings.length; r += 1) {
    for (let s = 0; s < segments; s += 1) {
      const a = r * stride + s;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      // A ring that collapses to the axis — a dome end — makes one triangle of
      // each quad degenerate. Emitting them anyway is how four zero-area
      // triangles hid inside the hangar shell while its metric still passed, so
      // the quad degrades to a fan here instead. Measured: the tank shell shed
      // 16 degenerates and no surface area.
      const lower = rings[r]!.radius;
      const upper = rings[r + 1]!.radius;
      if (lower > 1e-9) indices.push(a, b, c);
      if (upper > 1e-9) indices.push(b, d, c);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}

/**
 * Build one part. `inflation` is `windsockInflation`'s output: it decides how
 * far the sock opens, so a limp sock is narrow and a streaming one is full.
 */
export function buildWindsockPart(
  kind: WindsockPartKind,
  inflation = 1,
): WindsockPartGeometry {
  const open = Math.min(Math.max(inflation, 0), 1);
  if (kind === "mast") {
    return sweptTube(10, [
      { y: 0, radius: WINDSOCK_MAST_RADIUS_METERS },
      { y: WINDSOCK_MAST_HEIGHT_METERS, radius: WINDSOCK_MAST_RADIUS_METERS * 0.72 },
    ]);
  }
  if (kind === "swivel") {
    const top = WINDSOCK_MAST_HEIGHT_METERS;
    return sweptTube(12, [
      { y: top - 0.06, radius: WINDSOCK_MOUTH_RADIUS_METERS * 0.35 },
      { y: top + 0.06, radius: WINDSOCK_MOUTH_RADIUS_METERS * 0.35 },
    ]);
  }
  // The sock, built along +y in its own frame; the renderer orients it by the
  // wind heading and droop. Five rings, which is also the stripe count a pilot
  // counts speed off — the geometry and the banding share their divisions
  // rather than being two numbers that happen to look alike.
  const rings = Array.from({ length: 6 }, (_, index) => {
    const t = index / 5;
    const taper = WINDSOCK_MOUTH_RADIUS_METERS
      + (WINDSOCK_TAIL_RADIUS_METERS - WINDSOCK_MOUTH_RADIUS_METERS) * t;
    // A slack sock collapses toward the mast rather than holding its bore.
    return { y: t * WINDSOCK_LENGTH_METERS, radius: taper * (0.28 + 0.72 * open) };
  });
  return sweptTube(14, rings);
}

// ---------------------------------------------------------------------------
// The rest of `7-13`: fuel tanks, perimeter fence, runway signage.
//
// **Lateral offsets are the shared resource here**, and three sessions are
// placing structures across the same centreline. Recorded together so the next
// one can see the whole band rather than discovering a collision in a frame:
//
//     signage    runway edge + clearance  (derived, ~26 m on this runway)
//     windsock   55 m
//     tower      runwayWidth * 0.5 + 95
//     hangars    118 m
//     fuel farm  135 m   <- this file
//     fence      168 m   <- this file, outermost by construction
//
// The fence is last on purpose: it is the only one whose job is to be outside
// everything else, so it is derived from the outermost structure rather than
// given its own constant to drift against.
// ---------------------------------------------------------------------------

/** A bulk avgas tank: 12 m long, 2.5 m diameter, horizontal on saddles. */
export const FUEL_TANK_LENGTH_METERS = 12;
export const FUEL_TANK_RADIUS_METERS = 1.25;
export const FUEL_FARM_LATERAL_OFFSET_METERS = 135;

/** ICAO Annex 14 perimeter fencing: 2.4 m posts at 3 m centres. */
export const FENCE_POST_HEIGHT_METERS = 2.4;
export const FENCE_POST_SPACING_METERS = 3;
export const FENCE_LATERAL_OFFSET_METERS = 168;

/**
 * A mandatory instruction sign — ICAO Annex 14 Table 5-4, inscription height
 * 300 mm for a code-2 runway, which puts the face at 0.8 m on 0.3 m legs.
 */
export const SIGN_FACE_WIDTH_METERS = 1.5;
export const SIGN_FACE_HEIGHT_METERS = 0.8;
export const SIGN_LEG_HEIGHT_METERS = 0.3;

/**
 * Signage sits at the runway edge plus clearance, DERIVED rather than pinned.
 *
 * A sign is an obstacle beside a runway, so its offset is a function of the
 * runway it serves — a constant would be wrong the first time a seed produced a
 * wider strip, and wrong silently, because a sign inside the graded strip still
 * renders perfectly well.
 */
export function signLateralOffsetMeters(airport: Readonly<AirportDefinition>): number {
  return airport.runwayWidth / 2 + airport.shoulderWidth + 3;
}

/**
 * A flat rectangular panel in the local xy plane, facing +z.
 *
 * Separate from `sweptTube` because a panel has no ring ordering to inherit,
 * so its winding is its own question — and, per the tube's own docblock, a
 * winding tuple copied from another builder is exactly how the windsock shipped
 * inverted on all six cases.
 *
 * **It came out inverted too, and in the opposite direction**, which is the
 * claim confirming itself: the guard passed every `sweptTube` part in the same
 * change and failed `sign.face` alone at +1.000. Tube and panel need OPPOSITE
 * index orders. There is no house convention to carry between builders.
 */
function flatPanel(width: number, height: number, yBase: number): WindsockPartGeometry {
  const hw = width / 2;
  return {
    positions: new Float32Array([
      -hw, yBase, 0, hw, yBase, 0, hw, yBase + height, 0, -hw, yBase + height, 0,
    ]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    // Measured, not remembered — and it is the OPPOSITE of `sweptTube`'s.
    // The tube needs (a, b, c); this panel needs (a, c, b), because its four
    // corners are emitted in the other rotational sense. Written as two
    // explicit triangles rather than a shared helper so the difference is
    // visible instead of hidden behind an argument.
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
  };
}

export const FUEL_TANK_PART_KINDS = ["shell", "saddle"] as const;
export const FENCE_PART_KINDS = ["post", "rail"] as const;
export const SIGN_PART_KINDS = ["face", "leg"] as const;

export function buildFuelTankPart(
  kind: (typeof FUEL_TANK_PART_KINDS)[number],
): WindsockPartGeometry {
  if (kind === "saddle") {
    return sweptTube(8, [
      { y: 0, radius: FUEL_TANK_RADIUS_METERS * 0.55 },
      { y: FUEL_TANK_RADIUS_METERS * 0.6, radius: FUEL_TANK_RADIUS_METERS * 0.75 },
    ]);
  }
  // Domed ends rather than flat caps: a flat-capped cylinder reads as a drum.
  const rings = Array.from({ length: 9 }, (_, index) => {
    const t = index / 8;
    const dome = Math.sin(Math.PI * Math.min(Math.max((t - 0.06) / 0.88, 0), 1)) ** 0.35;
    return { y: t * FUEL_TANK_LENGTH_METERS, radius: FUEL_TANK_RADIUS_METERS * dome };
  });
  return sweptTube(16, rings);
}

export function buildFencePart(
  kind: (typeof FENCE_PART_KINDS)[number],
): WindsockPartGeometry {
  if (kind === "rail") {
    return sweptTube(6, [
      { y: 0, radius: 0.025 },
      { y: FENCE_POST_SPACING_METERS, radius: 0.025 },
    ]);
  }
  return sweptTube(8, [
    { y: 0, radius: 0.05 },
    { y: FENCE_POST_HEIGHT_METERS, radius: 0.045 },
  ]);
}

export function buildSignPart(
  kind: (typeof SIGN_PART_KINDS)[number],
): WindsockPartGeometry {
  if (kind === "leg") {
    return sweptTube(6, [
      { y: 0, radius: 0.04 },
      { y: SIGN_LEG_HEIGHT_METERS, radius: 0.04 },
    ]);
  }
  return flatPanel(SIGN_FACE_WIDTH_METERS, SIGN_FACE_HEIGHT_METERS, SIGN_LEG_HEIGHT_METERS);
}

/**
 * Every furniture surface, as `[label, geometry]`, for the winding guard.
 *
 * **THE GUARD SPREADS THIS RATHER THAN LISTING PARTS.** So furniture added to
 * this file is wound-checked with no change to the test at all — which is one
 * step stronger than deriving from a kind array, because a new kind array would
 * still need wiring. The two failure modes this closes are both on the record:
 * `buildBladeRibbon` shipped inverted while the guard checked a grass card no
 * capture drew, and three of `clutter`'s four kinds were never listed.
 */
export function airfieldFurnitureWindingCases(): ReadonlyArray<
  readonly [string, WindsockPartGeometry]
> {
  const out: (readonly [string, WindsockPartGeometry])[] = [];
  for (const kind of WINDSOCK_PART_KINDS) {
    // Both inflation arms: a slack sock's rings collapse toward the mast, so it
    // is a different mesh and checking one arm would leave the other unwound.
    out.push([`windsock.${kind}.slack`, buildWindsockPart(kind, 0)]);
    out.push([`windsock.${kind}.streaming`, buildWindsockPart(kind, 1)]);
  }
  for (const kind of FUEL_TANK_PART_KINDS) out.push([`fuelTank.${kind}`, buildFuelTankPart(kind)]);
  for (const kind of FENCE_PART_KINDS) out.push([`fence.${kind}`, buildFencePart(kind)]);
  for (const kind of SIGN_PART_KINDS) out.push([`sign.${kind}`, buildSignPart(kind)]);
  return out;
}
