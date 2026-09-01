/**
 * `7-10` airfield structures — the parametric hangar's siting rules.
 *
 * **This increment is the seating geometry only.** `buildHangar` and
 * `buildControlTower` construct meshes and need a `Scene`; the rules here are
 * pure arithmetic over `AirportDefinition` and a set of ground samples, so they
 * are testable in Node across many seeds. That split is deliberate and it is
 * the same one `7-7` used: the part that must be numerically right is the part
 * with no renderer in it.
 *
 * ---
 *
 * **The problem this exists to fix, measured rather than described.** Today
 * each hangar is a 46 x 34 m box re-seated by ONE ground sample at its centre —
 * the `CreateBox` loop in `AirportSystem`'s constructor, which is cited by
 * symbol rather than by line on purpose: line citations for this file have gone
 * stale three times this phase, in both directions, and a grep for the symbol
 * cannot rot. Sampling the world's
 * own `sampleTerrainHeight` over that footprint at 2 m spacing gives relief of
 * **2.86-5.52 m** under a single hangar, so the centre-seated box **buries a
 * corner by up to 2.70 m and floats another by up to 2.85 m**. A corner of a
 * 14 m hangar hanging 2.85 m clear of the ground is what ships.
 *
 * **Why `7-7`'s escape is not available here.** That item avoided a
 * seed-dependent ground query twice — the PAPI bar moved inboard onto the
 * graded platform, and the approach lights are held in the threshold's
 * horizontal plane. A hangar cannot do either: its footprint spans `across`
 * 112-158 m, so its **inboard edge is already 81 m beyond the platform's 31 m
 * half-width** and it stands on natural terrain. It has to meet real ground.
 *
 * **So the rules here are RELIEF-RELATIVE and the pins are properties of the
 * rule, not this airport's heights.** That is the opposite discipline from
 * `7-7` on purpose. A test that asserted "the skirt is 3.1 m" would be pinning
 * one seed's terrain; what is actually true is "no corner is buried and none
 * floats", and that holds on every seed or the rule is wrong.
 */

import { mixSeed, unitFloatFromHash } from "../../../world/seed";
import type { AirportDefinition } from "../../../world/types";

/**
 * Where a hangar stands, in runway-local coordinates.
 *
 * **`acrossOffsetMeters` is inherited, not chosen.** 118 m beyond the runway
 * edge is where the three boxes already sit, and moving them is a siting
 * decision with visual consequences that belongs with the art pass, not with a
 * geometry fix. Recorded as inherited so nobody reads it as derived.
 */
export const HANGAR_SITING = Object.freeze({
  count: 3,
  acrossOffsetMeters: 118,
  /** Spacing between adjacent hangars along the runway. */
  alongPitchMeters: 52,
  /** Group centre, as a fraction of runway length from the midpoint. */
  alongCentreFraction: -0.12,
  widthMeters: 46,
  depthMeters: 34,
});

export interface HangarFootprint {
  readonly along: number;
  readonly across: number;
  readonly widthMeters: number;
  readonly depthMeters: number;
}

/** Runway-local footprint of one hangar. */
export function hangarFootprint(
  airport: Readonly<AirportDefinition>,
  index: number,
): HangarFootprint {
  const siting = HANGAR_SITING;
  return {
    along:
      airport.runwayLength * siting.alongCentreFraction
      + (index - (siting.count - 1) / 2) * siting.alongPitchMeters,
    across: airport.runwayWidth * 0.5 + siting.acrossOffsetMeters,
    widthMeters: siting.widthMeters,
    depthMeters: siting.depthMeters,
  };
}

/**
 * Runway-local sample positions covering a footprint, at `stepMeters`.
 *
 * **The corners are guaranteed present regardless of step.** A stride that
 * divides the span unevenly would otherwise stop short of the edges, and the
 * corners are exactly where the current single-sample seating fails — a sampler
 * that misses them would report a smaller relief than the building sees, which
 * is the reassuring answer.
 */
export function hangarFootprintSamples(
  footprint: HangarFootprint,
  stepMeters: number,
): readonly { readonly along: number; readonly across: number }[] {
  if (!(stepMeters > 0)) throw new RangeError("stepMeters must be positive");
  const axis = (half: number): number[] => {
    const out: number[] = [];
    for (let value = -half; value < half; value += stepMeters) out.push(value);
    out.push(half);
    return out;
  };
  const out: { along: number; across: number }[] = [];
  for (const da of axis(footprint.depthMeters / 2)) {
    for (const dc of axis(footprint.widthMeters / 2)) {
      out.push({ along: footprint.along + da, across: footprint.across + dc });
    }
  }
  return Object.freeze(out);
}

export interface HangarSeating {
  /** Altitude of the finished floor slab. */
  readonly baseAltitudeMeters: number;
  /** How far the concrete skirt must reach below the slab. */
  readonly skirtHeightMeters: number;
  /** Ground relief under the footprint, for reporting. */
  readonly reliefMeters: number;
}

/**
 * Minimum skirt, so a hangar on flat ground still reads as founded rather than
 * resting on the grass. Not derived — an art floor, recorded as one.
 */
export const MINIMUM_SKIRT_METERS = 0.35;

/**
 * Seat a hangar on the ground actually under it.
 *
 * **The rule, and it is the whole item:** the slab sits at the HIGHEST ground
 * under the footprint, and the skirt reaches down to the LOWEST. Then no corner
 * is buried (nothing is above the slab) and none floats (the skirt closes the
 * gap). Seating on a centre sample cannot do either, because a centre is
 * neither bound.
 *
 * **Render-only.** This changes where the building sits, never the ground
 * height. The moment a skirt writes terrain height it becomes Class K:
 * collision short-circuits through the same earthworks profile and assertion 63
 * pins the two to under 1 mm.
 */
export function hangarSeatingFrom(groundSamples: readonly number[]): HangarSeating {
  if (groundSamples.length === 0) throw new RangeError("no ground samples");
  for (const sample of groundSamples) {
    if (!Number.isFinite(sample)) {
      // A non-finite sample means the ground query failed. Seating on it would
      // put the hangar at NaN and Babylon would silently not draw it, which
      // looks like "the hangar is missing" rather than "the query broke".
      throw new RangeError("ground sample is not finite — the height query failed");
    }
  }
  const highest = Math.max(...groundSamples);
  const lowest = Math.min(...groundSamples);
  return {
    baseAltitudeMeters: highest,
    skirtHeightMeters: Math.max(highest - lowest, MINIMUM_SKIRT_METERS),
    reliefMeters: highest - lowest,
  };
}

// ---------------------------------------------------------------------------
// The parametric plan, and the shell it produces.
// ---------------------------------------------------------------------------

export type HangarRoofProfile = "gabled" | "arched";

export interface HangarPlan {
  readonly bays: number;
  readonly roof: HangarRoofProfile;
  readonly widthMeters: number;
  readonly depthMeters: number;
  readonly eaveHeightMeters: number;
  readonly ridgeHeightMeters: number;
  readonly skirtHeightMeters: number;
  /** Segments across the span for an arched roof; ignored when gabled. */
  readonly archSegments: number;
}

/**
 * Bay count and roof profile are hash-driven, so three hangars on one field
 * read as different buildings and two fields differ from each other.
 *
 * **Two distinct channels, each mixed with the index.** Deriving one value and
 * varying it by index would make the three hangars a sequence (4, 5, 6) rather
 * than three independent draws, which reads as deliberate rather than
 * incidental — and it would tie the roof profile to the bay count.
 *
 * **This takes `world.seedHash`, never `sourceSeedHash`.** The airfield is
 * earthworks-coupled and therefore terrain-authority: it has to agree with the
 * ground it stands on. On a guaranteed-airport world the two differ — the exact
 * collision that caught two Phase 6 items — so the choice is load-bearing, and
 * the test asserts the sweep exercises worlds where they differ.
 */
export const HANGAR_PLAN_LIMITS = Object.freeze({
  minBays: 3,
  maxBays: 7,
  baseEaveHeightMeters: 11,
  eaveHeightPerBayMeters: 0.9,
  gabledRiseFraction: 0.18,
  archedRiseFraction: 0.32,
  archSegments: 12,
  /** Distinct channels so bay count and profile are independent draws. */
  bayChannel: 8_101,
  profileChannel: 8_102,
});

export function hangarPlanFrom(
  seedHash: number,
  index: number,
  skirtHeightMeters: number,
): HangarPlan {
  const limits = HANGAR_PLAN_LIMITS;
  const siting = HANGAR_SITING;
  const span = limits.maxBays - limits.minBays + 1;
  const bayHash = mixSeed(mixSeed(seedHash, limits.bayChannel), index);
  const profileHash = mixSeed(mixSeed(seedHash, limits.profileChannel), index);
  const bays = limits.minBays + Math.min(span - 1, Math.floor(unitFloatFromHash(bayHash) * span));
  const roof: HangarRoofProfile = unitFloatFromHash(profileHash) < 0.5 ? "gabled" : "arched";
  const eave = limits.baseEaveHeightMeters
    + (bays - limits.minBays) * limits.eaveHeightPerBayMeters;
  const rise = siting.widthMeters
    * (roof === "gabled" ? limits.gabledRiseFraction : limits.archedRiseFraction);
  return {
    bays,
    roof,
    widthMeters: siting.widthMeters,
    depthMeters: siting.depthMeters,
    eaveHeightMeters: eave,
    ridgeHeightMeters: eave + rise,
    skirtHeightMeters,
    archSegments: limits.archSegments,
  };
}

export interface ShellGeometry {
  readonly positions: number[];
  readonly normals: number[];
  readonly indices: number[];
}

/**
 * The hangar shell — skirt, walls and a gabled or arched roof — as ONE closed
 * manifold.
 *
 * **Closed on purpose.** The winding guard's second metric is a signed volume
 * from the divergence theorem, which references no authored normals and no
 * engine convention. It is the metric that cannot be fooled by a builder
 * deriving its normals from its own winding — but it is only meaningful on a
 * closed surface. An open shell would still satisfy the normal-agreement
 * metric while being unmeasurable by the one that matters.
 *
 * The ridge runs along z (the runway-parallel axis) and the span is across x,
 * so the gable ends face ±z and the long wall facing −x looks at the runway.
 */
export function hangarShellGeometry(plan: HangarPlan): ShellGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const halfW = plan.widthMeters / 2;
  const halfD = plan.depthMeters / 2;
  const base = -plan.skirtHeightMeters;

  const quad = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    normal: readonly [number, number, number],
  ) => {
    const start = positions.length / 3;
    for (const point of [a, b, c, d]) {
      positions.push(point[0], point[1], point[2]);
      normals.push(normal[0], normal[1], normal[2]);
    }
    // Wound so `cross(b-a, c-a)` OPPOSES the authored normal, which is
    // Babylon's convention. It is not assumed here: the winding guard reads
    // that convention from Babylon's own primitives at run time and this shell
    // is one of its cases, so an engine change fails there loudly instead of
    // silently reversing every face.
    //
    // **Degenerate triangles are dropped, and that is not tidiness.** A gable
    // quad collapses to a triangle at the eaves, where the roof height equals
    // the eave height. A zero-area triangle contributes 0 to the winding
    // guard's normal-agreement metric, so four of them pull a perfectly wound
    // gabled shell from -1.000 to -0.818 — eating the margin the guard uses to
    // separate correct from inverted, and making "some faces are degenerate"
    // indistinguishable from "some faces are inverted" in its one number.
    for (const [i0, i1, i2] of [[0, 2, 1], [0, 3, 2]] as const) {
      const p0 = [a, b, c, d][i0]!;
      const p1 = [a, b, c, d][i1]!;
      const p2 = [a, b, c, d][i2]!;
      const ux = p1[0] - p0[0];
      const uy = p1[1] - p0[1];
      const uz = p1[2] - p0[2];
      const vx = p2[0] - p0[0];
      const vy = p2[1] - p0[1];
      const vz = p2[2] - p0[2];
      const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      if (area > 1e-9) indices.push(start + i0, start + i1, start + i2);
    }
  };

  /** Roof height at a normalised span coordinate in [-1, 1]. */
  const roofHeight = (t: number): number => {
    const rise = plan.ridgeHeightMeters - plan.eaveHeightMeters;
    return plan.roof === "gabled"
      ? plan.eaveHeightMeters + rise * (1 - Math.abs(t))
      : plan.eaveHeightMeters + rise * Math.cos((t * Math.PI) / 2);
  };

  const steps = plan.roof === "gabled" ? 2 : plan.archSegments;
  const spanAt = (i: number) => -halfW + (plan.widthMeters * i) / steps;

  // Long walls, from the skirt base up to the eave line.
  quad([-halfW, base, -halfD], [-halfW, base, halfD], [-halfW, plan.eaveHeightMeters, halfD],
    [-halfW, plan.eaveHeightMeters, -halfD], [-1, 0, 0]);
  quad([halfW, base, halfD], [halfW, base, -halfD], [halfW, plan.eaveHeightMeters, -halfD],
    [halfW, plan.eaveHeightMeters, halfD], [1, 0, 0]);
  // Gable-end walls, base to eave.
  quad([halfW, base, -halfD], [-halfW, base, -halfD], [-halfW, plan.eaveHeightMeters, -halfD],
    [halfW, plan.eaveHeightMeters, -halfD], [0, 0, -1]);
  quad([-halfW, base, halfD], [halfW, base, halfD], [halfW, plan.eaveHeightMeters, halfD],
    [-halfW, plan.eaveHeightMeters, halfD], [0, 0, 1]);

  for (let i = 0; i < steps; i += 1) {
    const x0 = spanAt(i);
    const x1 = spanAt(i + 1);
    const y0 = roofHeight(x0 / halfW);
    const y1 = roofHeight(x1 / halfW);
    // Gable infill above the eave, one quad per roof segment per end.
    quad([x1, plan.eaveHeightMeters, -halfD], [x0, plan.eaveHeightMeters, -halfD],
      [x0, y0, -halfD], [x1, y1, -halfD], [0, 0, -1]);
    quad([x0, plan.eaveHeightMeters, halfD], [x1, plan.eaveHeightMeters, halfD],
      [x1, y1, halfD], [x0, y0, halfD], [0, 0, 1]);
    // The roof plane for this segment.
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.hypot(dx, dy) || 1;
    quad([x0, y0, -halfD], [x0, y0, halfD], [x1, y1, halfD], [x1, y1, -halfD],
      [-dy / length, dx / length, 0]);
  }

  // The slab, closing the manifold.
  quad([-halfW, base, -halfD], [halfW, base, -halfD], [halfW, base, halfD],
    [-halfW, base, halfD], [0, -1, 0]);

  return { positions, normals, indices };
}

// ---------------------------------------------------------------------------
// Mount points for 7-14's obstruction lighting and 7-7's beacon.
// ---------------------------------------------------------------------------

/** A runway-local point: `[across, y, along]`. */
export type AttachmentPoint = readonly [number, number, number];

/**
 * Where a consumer may mount a fixture on this hangar.
 *
 * **COORDINATES ARE RUNWAY-LOCAL `[across, y, along]` WITH THE HANGAR'S OWN
 * PLACEMENT ALREADY FOLDED IN, and `y` is relative to the airport datum
 * (`airport.elevation`).** A consumer applies NOTHING further. This sentence is
 * here because the equivalent tower API omitted it and a consumer applied the
 * placement a second time, putting fixtures ~190 m off across the runway —
 * finite, plausible, on the airfield, and invisible to any test asserting that
 * N fixtures exist at finite coordinates.
 *
 * **`roofPerimeter` is TRUE CORNERS, deliberately not subdivided.** The 45 m
 * cap on extent-light spacing is an aviation rule, not a property of a shell,
 * and it belongs where it can be tested against the regulation.
 */
export interface HangarAttachments {
  /** Plan outline of the roof, ordered anticlockwise seen from above. */
  readonly roofPerimeter: readonly AttachmentPoint[];
  /**
   * The highest points of the roof — the two ends of the ridge line.
   *
   * Never empty for this shell: BOTH profiles have a ridge. An arched roof is a
   * barrel whose apex is a line, not a dome, so its highest points are the same
   * two ends as the gabled case. A flat roof would return an empty array, and
   * this shell has no flat variant.
   */
  readonly ridgeEnds: readonly AttachmentPoint[];
  /** Overall height from the base of the skirt to the ridge. */
  readonly heightMeters: number;
}

/**
 * Mount points for one hangar, in the order `hangarFootprint` indexes them.
 *
 * `baseAltitudeMeters` comes from `hangarSeatingFrom` — the slab's world
 * altitude — and is converted here to the airport datum so the caller never
 * sees a world coordinate.
 */
export function hangarAttachments(
  airport: Readonly<AirportDefinition>,
  index: number,
  plan: HangarPlan,
  baseAltitudeMeters: number,
): HangarAttachments {
  const footprint = hangarFootprint(airport, index);
  const halfW = plan.widthMeters / 2;
  const halfD = plan.depthMeters / 2;
  // The slab, expressed against the airport datum rather than sea level.
  const slab = baseAltitudeMeters - airport.elevation;
  const at = (x: number, y: number, z: number): AttachmentPoint =>
    [footprint.across + x, slab + y, footprint.along + z];
  return {
    // Anticlockwise from the runway-side, low-along corner, seen from above.
    roofPerimeter: Object.freeze([
      at(-halfW, plan.eaveHeightMeters, -halfD),
      at(halfW, plan.eaveHeightMeters, -halfD),
      at(halfW, plan.eaveHeightMeters, halfD),
      at(-halfW, plan.eaveHeightMeters, halfD),
    ]),
    ridgeEnds: Object.freeze([
      at(0, plan.ridgeHeightMeters, -halfD),
      at(0, plan.ridgeHeightMeters, halfD),
    ]),
    heightMeters: plan.ridgeHeightMeters + plan.skirtHeightMeters,
  };
}
