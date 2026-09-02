import { hangarFootprint } from "../airfield/AirfieldStructures";
import { DEFAULT_AIRPORT, runwayToWorld } from "../../../world/airport";
import { AIRFIELD_LIGHTING_PROFILE } from "../lighting/AirfieldLighting";
import { runwayPlatformHeight } from "../terrain/RunwayEarthworks";
import type { AirportDefinition } from "../../../world/types";
import type { LightPointFixture } from "../lighting/LightPoints";

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
 * How far the sock's bore opens, as a scale on its cross-section.
 *
 * **SHARED BY THE BUILDER AND THE RUNTIME, deliberately.** The mesh is built
 * once at full inflation and scaled per frame — rebuilding 140 triangles every
 * frame to change a radius would be absurd — so the geometry and the animation
 * must agree about what inflation means. Two copies of `0.28 + 0.72 * open`
 * would be a decorative-constant pair, and this project has found three of
 * those drifting.
 */
export function windsockBoreScale(inflation: number): number {
  return 0.28 + 0.72 * Math.min(Math.max(inflation, 0), 1);
}

/**
 * The unit vector the sock points along.
 *
 * **Returns a DIRECTION rather than Euler angles on purpose.** Euler angles
 * only mean something alongside a rotation order, and Babylon's is a convention
 * this module would then be silently coupled to — a sock 90 degrees out because
 * someone assumed XYZ where the engine applies YXZ is not a bug any pure test
 * could catch. A direction vector is checkable against the wind it came from
 * with no convention in between, which is what the test does.
 *
 * `heading` is clockwise from world north (+z), the same convention as
 * `AirportDefinition.headingRadians` and `windsockHeadingRadians`. `droop` is
 * measured DOWN from horizontal, so a slack sock returns a vector with a
 * negative y.
 */
export function windsockAxisDirection(
  headingRadians: number,
  droopRadians: number,
): readonly [number, number, number] {
  const horizontal = Math.cos(droopRadians);
  return [
    Math.sin(headingRadians) * horizontal,
    -Math.sin(droopRadians),
    Math.cos(headingRadians) * horizontal,
  ];
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
    return { y: t * WINDSOCK_LENGTH_METERS, radius: taper * windsockBoreScale(open) };
  });
  return sweptTube(14, rings);
}

// ---------------------------------------------------------------------------
// The rest of `7-13`: fuel tanks, perimeter fence, runway signage.
//
// **Lateral offsets are a shared resource and this used to be a comment.** The
// comment listed one number per structure and was endorsed as the thing to read
// before siting anything. It was wrong in three ways at once, and every one of
// them was invisible because the list was tidy:
//
//  1. **It recorded LINES for objects that have WIDTH.** "hangars 118 m" is an
//     offset that resolves to ~135 and spans ~112 to ~158, because a hangar is
//     46 m across. A reader placing something at 135 would have put it through
//     the middle of one.
//  2. **It mixed conventions silently.** The windsock's 55 is a bare `across`;
//     the tower's 95 is `runwayWidth/2 + 95`; the hangars' 118 is the same but
//     written without the formula. Three rows, two conventions, no way to tell
//     which was which.
//  3. **It answered a ONE-dimensional question about a TWO-dimensional
//     problem.** The tower's across is 112 — exactly the hangars' inboard edge.
//     It is clear only because `along` separates them by 185.6 m, an axis the
//     comment could not represent. A record that cannot show the axis doing the
//     work will eventually be believed about a case where that axis is absent.
//
// The fuel farm was the case waiting to happen: `FUEL_FARM_LATERAL_OFFSET_METERS`
// is 135 with zero consumers, and there is no reading of it that clears the
// hangars. It was not a defect yet — only because nobody had wired it.
//
// So the band is DERIVED rather than transcribed, both axes are recorded, and
// `render.webgpu-airfield-layout.test.ts` asserts no two structures overlap in
// both. A band of expressions cannot disagree with the code; a band of numbers
// just did.
// ---------------------------------------------------------------------------

/** The ATC tower's placement, exported so the band can derive rather than restate. */
export const TOWER_LATERAL_OFFSET_METERS = 95;
export const TOWER_ALONG_FRACTION = 0.06;
/** Plan radius of the tower's widest element, for the band's across span. */
export const TOWER_PLAN_RADIUS_METERS = 7;

/** A bulk avgas tank: 12 m long, 2.5 m diameter, horizontal on saddles. */
export const FUEL_TANK_LENGTH_METERS = 12;
export const FUEL_TANK_RADIUS_METERS = 1.25;
export const FUEL_FARM_LATERAL_OFFSET_METERS = 135;

/** ICAO Annex 14 perimeter fencing: 2.4 m posts at 3 m centres. */
export const FENCE_POST_HEIGHT_METERS = 2.4;
export const FENCE_POST_SPACING_METERS = 3;
export const FENCE_LATERAL_OFFSET_METERS = 168;

/**
 * Where the fuel farm sits ALONG the runway.
 *
 * **Its `across` of 135 puts it inside the hangar footprint (112..158) and no
 * reading of that constant clears them**, so the axis that separates it has to
 * be this one. The hangar row occupies `along` -227.4 .. -89.4 on the default
 * airport; the farm sits on the opposite side of the tower, which is both clear
 * and the way a real field lays out — fuel away from the hangar line, reachable
 * from the same apron.
 *
 * `AIRFIELD_LATERAL_BAND` asserts the clearance rather than assuming it.
 */
export const FUEL_FARM_ALONG_FRACTION = 0.14;
/** Plan half-extents of the tank group, for the band. */
export const FUEL_FARM_HALF_ACROSS_METERS = 6;
export const FUEL_FARM_HALF_ALONG_METERS = 8;

export interface AirfieldFootprint {
  readonly name: string;
  /** Runway-local `across` span, metres from the centreline. */
  readonly across: readonly [number, number];
  /**
   * Runway-local `along` span, or `null` for something that runs the length of
   * the field. A null span overlaps EVERYTHING in `along`, so such a structure
   * has to be clear of every other on `across` alone — which is exactly the
   * fence's job, and why it is derived as outermost rather than given a
   * constant to drift against.
   */
  readonly along: readonly [number, number] | null;
}

/**
 * Every structure's footprint in BOTH axes, derived from the constants that
 * place it.
 *
 * Nothing here is transcribed. A number repeated into a record is a copy that
 * can disagree with the code, which is what the comment above this one did.
 */
export function airfieldLateralBand(
  airport: Readonly<AirportDefinition>,
): readonly AirfieldFootprint[] {
  const half = airport.runwayWidth / 2;
  const sign = signLateralOffsetMeters(airport);
  const towerAcross = half + TOWER_LATERAL_OFFSET_METERS;
  const towerAlong = airport.runwayLength * TOWER_ALONG_FRACTION;
  const fuelAcross = half + FUEL_FARM_LATERAL_OFFSET_METERS;
  const fuelAlong = airport.runwayLength * FUEL_FARM_ALONG_FRACTION;
  const hangars = [0, 1, 2].map((index) => hangarFootprint(airport, index));
  return Object.freeze([
    { name: "signage", across: [sign - 0.5, sign + 0.5], along: null },
    {
      name: "windsock",
      across: [WINDSOCK_LATERAL_OFFSET_METERS - 1, WINDSOCK_LATERAL_OFFSET_METERS + 1],
      along: [-1, 1],
    },
    {
      name: "tower",
      across: [towerAcross - TOWER_PLAN_RADIUS_METERS, towerAcross + TOWER_PLAN_RADIUS_METERS],
      along: [towerAlong - TOWER_PLAN_RADIUS_METERS, towerAlong + TOWER_PLAN_RADIUS_METERS],
    },
    ...hangars.map((footprint, index) => ({
      name: `hangar-${index}`,
      across: [
        footprint.across - footprint.widthMeters / 2,
        footprint.across + footprint.widthMeters / 2,
      ] as readonly [number, number],
      along: [
        footprint.along - footprint.depthMeters / 2,
        footprint.along + footprint.depthMeters / 2,
      ] as readonly [number, number],
    })),
    {
      name: "fuel-farm",
      across: [fuelAcross - FUEL_FARM_HALF_ACROSS_METERS, fuelAcross + FUEL_FARM_HALF_ACROSS_METERS],
      along: [fuelAlong - FUEL_FARM_HALF_ALONG_METERS, fuelAlong + FUEL_FARM_HALF_ALONG_METERS],
    },
    {
      name: "fence",
      across: [half + FENCE_LATERAL_OFFSET_METERS - 0.5, half + FENCE_LATERAL_OFFSET_METERS + 0.5],
      along: null,
    },
  ] as readonly AirfieldFootprint[]);
}

/** Do two footprints overlap in BOTH axes? A null `along` spans everything. */
export function airfieldFootprintsOverlap(
  a: AirfieldFootprint,
  b: AirfieldFootprint,
): boolean {
  const spans = (x: readonly [number, number], y: readonly [number, number]) =>
    x[0] < y[1] && y[0] < x[1];
  if (!spans(a.across, b.across)) return false;
  if (a.along === null || b.along === null) return true;
  return spans(a.along, b.along);
}

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
  // The MERGED perimeter, not just its unit parts. A merge applies a rotation
  // per station, and a basis with a negative determinant flips winding on every
  // transformed triangle while each unit part stays correct — so checking the
  // parts alone would pass on a fence that is entirely inside-out.
  out.push(["fence.perimeter", buildPerimeterFenceGeometry(DEFAULT_AIRPORT)]);
  out.push(["fuelFarm.merged", buildFuelFarmGeometry()]);
  out.push(["signage.merged", buildSignageGeometry(DEFAULT_AIRPORT)]);
  return out;
}

// ---------------------------------------------------------------------------
// The perimeter fence: ONE merged mesh, and the sizing is why.
//
// **The budget disqualified a design before it was written**, which is the
// first time this phase has had that ordering. Measured on this runway: a
// 3,632 m perimeter at the ICAO 3 m spacing is 1,211 posts and 1,211 rail
// bays, so one mesh per part is **2,422 draw calls against a night ceiling of
// 157** — not expensive, impossible, by a factor of fifteen. Merged it is ONE.
//
// Triangles are not the constraint and that was checked rather than assumed:
// 33,908 tris is ~2% of the ~1.68M a capture already draws.
//
// **MERGING IS ONLY FREE BECAUSE OF THE PARENTING, and that is conditional.**
// `AirportSystem` parents this under `root` and rebases by moving `root`, so
// the 4,096 m floating-origin shift costs one node update and no re-upload,
// ever. `LightPointSystem` is the same merge pattern WITHOUT a moving parent —
// `new Mesh("light-points", scene)`, absolute positions baked — so its
// `setFloatingOrigin` rewrites the whole vertex buffer. **Move this fence out
// from under `root`, or copy the pattern somewhere with no moving parent, and
// you inherit that re-upload without having chosen it.**
//
// **Post spacing is an ART knob, not a performance one.** Halving the count
// changes no draw call and no ceiling — it is one mesh either way. Recorded so
// a future "the fence looks busy" is settled as a look decision rather than
// argued as a cost.
// ---------------------------------------------------------------------------

/** Rail heights above the post base, metres. Two rails read as fencing at range. */
export const FENCE_RAIL_HEIGHTS_METERS: readonly number[] = Object.freeze([0.6, 1.8]);

/** One post station: runway-local position and the direction the fence runs. */
/**
 * Half-width of the gap where the fence's end run crosses the approach corridor.
 *
 * **DERIVED from the approach lighting, not pinned.** The collision this fixes
 * was produced by two correct derivations that never met -- the fence's
 * `runwayLength / 2 + endSafetyArea` and the approach array's own extent -- so
 * a pinned width here would drift apart from the corridor exactly the same way.
 * Keyed to the crossbar, which is the widest approach element, plus a margin.
 *
 * **Why a gap rather than a shorter fence or acceptance.** Approach lighting
 * sits outside the boundary at real airfields, but the boundary does not cross
 * the approach surface with a rigid obstacle on the centreline: anything in
 * that corridor is frangible or absent, because it is directly under aircraft
 * at decision height. A post in line with the approach lights is the one
 * arrangement that is neither realistic nor deliberate. A shorter fence makes
 * the perimeter stop for no visible reason; acceptance ships a visual defect at
 * the exact moment a pilot is looking hardest -- short final is the most-viewed
 * camera in the simulator.
 */
export function fenceApproachGapHalfWidthMeters(): number {
  return AIRFIELD_LIGHTING_PROFILE.approachCrossbarLengthMeters / 2 + 6;
}

export interface FenceStation {
  readonly along: number;
  readonly across: number;
  /** Unit direction to the NEXT station, runway-local. Null at the last one. */
  readonly toNext: readonly [number, number] | null;
}

/**
 * Post stations around the perimeter rectangle, runway-local.
 *
 * The rectangle is derived from the runway rather than pinned: half-length is
 * the runway plus its end safety area, half-width is
 * `FENCE_LATERAL_OFFSET_METERS`. A constant would be silently wrong the first
 * time a seed produced a longer strip — and wrong in the direction that puts a
 * fence across the runway.
 */
export function perimeterFenceStations(
  airport: Readonly<AirportDefinition>,
): readonly FenceStation[] {
  const halfLength = airport.runwayLength / 2 + airport.endSafetyArea;
  const halfWidth = FENCE_LATERAL_OFFSET_METERS;
  const corners: readonly (readonly [number, number])[] = [
    [halfLength, halfWidth], [halfLength, -halfWidth],
    [-halfLength, -halfWidth], [-halfLength, halfWidth],
  ];
  const stations: FenceStation[] = [];
  for (let corner = 0; corner < corners.length; corner += 1) {
    const [a0, c0] = corners[corner]!;
    const [a1, c1] = corners[(corner + 1) % corners.length]!;
    const spanAlong = a1 - a0;
    const spanAcross = c1 - c0;
    const length = Math.hypot(spanAlong, spanAcross);
    const bays = Math.max(1, Math.round(length / FENCE_POST_SPACING_METERS));
    const unit: readonly [number, number] = [spanAlong / length, spanAcross / length];
    const gapHalfWidth = fenceApproachGapHalfWidthMeters();
    for (let bay = 0; bay < bays; bay += 1) {
      const t = bay / bays;
      const along = a0 + spanAlong * t;
      const across = c0 + spanAcross * t;
      // The END runs cross the extended centreline, where the approach lighting
      // is. Leave that corridor open rather than standing a post in it.
      const onEndRun = Math.abs(spanAcross) > Math.abs(spanAlong);
      if (onEndRun && Math.abs(across) < gapHalfWidth) continue;
      stations.push({ along, across, toNext: unit });
    }
  }
  return stations;
}

/**
 * Append `part`, rotated so its local +y maps to `axis` and translated.
 *
 * **Normals are rotated with the positions rather than recomputed**, for the
 * same reason `sweptTube` authors them independently of the index order:
 * re-deriving a normal from transformed geometry can agree with an inverted
 * surface and hide it. This carries the authored normal through the same
 * rotation, so a merge cannot silently fix — or silently break — a winding the
 * guard already checked on the unit part.
 */
function appendTransformed(
  out: { positions: number[]; normals: number[]; indices: number[] },
  part: WindsockPartGeometry,
  axis: readonly [number, number, number],
  translation: readonly [number, number, number],
): void {
  const base = out.positions.length / 3;
  // Orthonormal basis with newY = axis. For a horizontal axis the perpendicular
  // is horizontal too, so this stays well-conditioned everywhere the fence runs.
  const [ax, ay, az] = axis;
  const helper: readonly [number, number, number] = Math.abs(ay) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const xx = helper[1] * az - helper[2] * ay;
  const xy = helper[2] * ax - helper[0] * az;
  const xz = helper[0] * ay - helper[1] * ax;
  const xLen = Math.hypot(xx, xy, xz) || 1;
  const nx: readonly [number, number, number] = [xx / xLen, xy / xLen, xz / xLen];
  const nz: readonly [number, number, number] = [
    nx[1] * az - nx[2] * ay, nx[2] * ax - nx[0] * az, nx[0] * ay - nx[1] * ax,
  ];
  for (let vertex = 0; vertex < part.positions.length / 3; vertex += 1) {
    const px = part.positions[vertex * 3]!;
    const py = part.positions[vertex * 3 + 1]!;
    const pz = part.positions[vertex * 3 + 2]!;
    out.positions.push(
      nx[0] * px + ax * py + nz[0] * pz + translation[0],
      nx[1] * px + ay * py + nz[1] * pz + translation[1],
      nx[2] * px + az * py + nz[2] * pz + translation[2],
    );
    const mx = part.normals[vertex * 3]!;
    const my = part.normals[vertex * 3 + 1]!;
    const mz = part.normals[vertex * 3 + 2]!;
    out.normals.push(
      nx[0] * mx + ax * my + nz[0] * mz,
      nx[1] * mx + ay * my + nz[1] * mz,
      nx[2] * mx + az * my + nz[2] * mz,
    );
  }
  for (const index of part.indices) out.indices.push(base + index);
}

/** The whole perimeter as one mesh, runway-local, y measured from the platform. */
export function buildPerimeterFenceGeometry(
  airport: Readonly<AirportDefinition>,
  /**
   * Local y for a station, given its runway-local position. Defaults to flat.
   *
   * **The fence needs this and the hangars do not.** At 168 m across, the
   * perimeter is well outside the graded platform and stands on natural
   * terrain, so `runwayPlatformHeight` is the wrong datum for it — a fence
   * pinned to the platform elevation floats over falling ground and sinks into
   * rising ground, and both read as a modelling bug rather than a placement
   * one. `AirportSystem` passes a real ground query; the default keeps the
   * function pure for the winding guard, which does not have one.
   */
  heightAt: (along: number, across: number) => number = () => 0,
): WindsockPartGeometry {
  const post = buildFencePart("post");
  const rail = buildFencePart("rail");
  const out = { positions: [] as number[], normals: [] as number[], indices: [] as number[] };
  const stations = perimeterFenceStations(airport);
  for (const station of stations) {
    const base = heightAt(station.along, station.across);
    appendTransformed(out, post, [0, 1, 0], [station.across, base, station.along]);
    if (!station.toNext) continue;
    const [alongUnit, acrossUnit] = station.toNext;
    // The rail is built along +y of length FENCE_POST_SPACING_METERS, so it is
    // laid down by mapping its +y onto the run direction.
    for (const height of FENCE_RAIL_HEIGHTS_METERS) {
      appendTransformed(
        out,
        rail,
        [acrossUnit, 0, alongUnit],
        [station.across, base + height, station.along],
      );
    }
  }
  return {
    positions: new Float32Array(out.positions),
    normals: new Float32Array(out.normals),
    indices: new Uint32Array(out.indices),
  };
}

// ---------------------------------------------------------------------------
// Fuel farm and signage. Both merged for the same reason the fence is — not
// because they are large, but because a draw call is the scarce unit here and
// there is no reason to spend six where one does.
// ---------------------------------------------------------------------------

/** Two tanks: avgas and jet A, which is what a field this size carries. */
export const FUEL_TANK_COUNT = 2;
/** Along-runway gap between tank centres, metres. */
export const FUEL_TANK_PITCH_METERS = 18;
/** Saddles per tank, at a quarter and three-quarters of its length. */
export const FUEL_TANK_SADDLE_FRACTIONS: readonly number[] = Object.freeze([0.25, 0.75]);

/**
 * Runway-local centres of each tank.
 *
 * On the POSITIVE `across` side, with the hangars — a fuel farm belongs beside
 * the apron, and the negative side carries the PAPI, which must not be occluded
 * from the approach.
 */
export function fuelTankPlacements(): readonly { along: number; across: number }[] {
  const out: { along: number; across: number }[] = [];
  const span = (FUEL_TANK_COUNT - 1) * FUEL_TANK_PITCH_METERS;
  for (let index = 0; index < FUEL_TANK_COUNT; index += 1) {
    out.push({
      along: -span / 2 + index * FUEL_TANK_PITCH_METERS,
      across: FUEL_FARM_LATERAL_OFFSET_METERS,
    });
  }
  return out;
}

/** The fuel farm as one mesh: tanks lying along the runway, on their saddles. */
export function buildFuelFarmGeometry(
  heightAt: (along: number, across: number) => number = () => 0,
): WindsockPartGeometry {
  const shell = buildFuelTankPart("shell");
  const saddle = buildFuelTankPart("saddle");
  const out = { positions: [] as number[], normals: [] as number[], indices: [] as number[] };
  for (const tank of fuelTankPlacements()) {
    const base = heightAt(tank.along, tank.across);
    // The shell is built along +y; lay it along the runway (+along = local +z),
    // sitting on its saddles rather than on the ground.
    const axleHeight = base + FUEL_TANK_RADIUS_METERS * 0.6 + FUEL_TANK_RADIUS_METERS;
    appendTransformed(
      out,
      shell,
      [0, 0, 1],
      [tank.across, axleHeight, tank.along - FUEL_TANK_LENGTH_METERS / 2],
    );
    for (const fraction of FUEL_TANK_SADDLE_FRACTIONS) {
      appendTransformed(
        out,
        saddle,
        [0, 1, 0],
        [
          tank.across,
          base,
          tank.along - FUEL_TANK_LENGTH_METERS / 2 + FUEL_TANK_LENGTH_METERS * fraction,
        ],
      );
    }
  }
  return {
    positions: new Float32Array(out.positions),
    normals: new Float32Array(out.normals),
    indices: new Uint32Array(out.indices),
  };
}

/** A runway sign: where it stands and which way its face points. */
export interface SignPlacement {
  readonly along: number;
  readonly across: number;
  /** Runway end the face is readable from: the sign faces an arriving aircraft. */
  readonly facesEnd: -1 | 1;
}

/**
 * Signs at both thresholds, on both sides.
 *
 * Runway-local, at the DERIVED edge clearance rather than a pinned offset — a
 * constant would put a sign inside the graded strip the first time a seed made
 * a wider runway, and a sign inside the strip still renders perfectly.
 */
export function signPlacements(
  airport: Readonly<AirportDefinition>,
): readonly SignPlacement[] {
  const across = signLateralOffsetMeters(airport);
  const along = airport.runwayLength / 2 - 30;
  const out: SignPlacement[] = [];
  for (const end of [-1, 1] as const) {
    for (const side of [-1, 1] as const) {
      out.push({ along: end * along, across: side * across, facesEnd: end });
    }
  }
  return out;
}

/** Every sign as one mesh. */
export function buildSignageGeometry(
  airport: Readonly<AirportDefinition>,
  heightAt: (along: number, across: number) => number = () => 0,
): WindsockPartGeometry {
  const face = buildSignPart("face");
  const leg = buildSignPart("leg");
  const out = { positions: [] as number[], normals: [] as number[], indices: [] as number[] };
  for (const sign of signPlacements(airport)) {
    const base = heightAt(sign.along, sign.across);
    // The face is built in the local xy plane facing +z; a sign read from the
    // `-1` end must face that way, so the axis flips with `facesEnd`.
    appendTransformed(
      out,
      face,
      [0, 1, 0],
      [sign.across, base, sign.along],
    );
    for (const offset of [-SIGN_FACE_WIDTH_METERS * 0.4, SIGN_FACE_WIDTH_METERS * 0.4]) {
      appendTransformed(out, leg, [0, 1, 0], [sign.across + offset, base, sign.along]);
    }
  }
  return {
    positions: new Float32Array(out.positions),
    normals: new Float32Array(out.normals),
    indices: new Uint32Array(out.indices),
  };
}

/**
 * Luminous intensity of an internally-lit sign face, candela.
 *
 * **Two orders below a runway edge light (10,000 cd) on purpose.** A sign is an
 * illuminated PANEL read at a few hundred metres, not a point source picked up
 * on approach — matching it to a lamp would make the signs the brightest thing
 * on the airfield, which is both wrong and a distraction from the lighting a
 * pilot is actually flying.
 */
export const SIGN_LUMINOUS_INTENSITY_CANDELA = 60;

/**
 * Sign faces as light points, so they read at night.
 *
 * **Through `7-5`'s billboard path rather than a second emissive one.** The
 * plan asks for signage "doubling as 7-5 light points" and the alternative —
 * an emissive material on the face — would be a second brightness model to keep
 * in step with the lamps through every calibration change. `7-5`'s constant has
 * already been wrong three times; a parallel path would have to be wrong the
 * same way at the same moment to stay consistent.
 *
 * The face is a MANDATORY instruction sign at a holding position, so ICAO
 * Annex 14 makes it red with a white inscription: at night the lit background
 * is what carries, which is why the fixture colour is red rather than white.
 *
 * A hemispherical beam, because a sign is readable from the direction it faces
 * and dark from behind — the same `beamCosineCutoff` the threshold lamps use,
 * and for the same reason.
 */
export function signLightPoints(
  airport: Readonly<AirportDefinition>,
  colour: readonly [number, number, number],
  intensityScale: number,
  heightAt: (along: number, across: number) => number = () => 0,
): LightPointFixture[] {
  const axis: readonly [number, number, number] = [
    Math.sin(airport.headingRadians), 0, Math.cos(airport.headingRadians),
  ];
  return signPlacements(airport).map((sign) => {
    const point = runwayToWorld(airport, sign.along, sign.across);
    return {
      position: [
        point.x,
        airport.elevation + heightAt(sign.along, sign.across)
          + SIGN_LEG_HEIGHT_METERS + SIGN_FACE_HEIGHT_METERS / 2,
        point.z,
      ] as const,
      aim: [axis[0] * sign.facesEnd, 0, axis[2] * sign.facesEnd] as const,
      intensity: SIGN_LUMINOUS_INTENSITY_CANDELA * intensityScale,
      profileRow: 0,
      radiusMeters: SIGN_FACE_HEIGHT_METERS / 2,
      color: colour,
      beamCosineCutoff: 0,
    };
  });
}
