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

import type { Material } from "@babylonjs/core/Materials/material";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import {
  AIRFIELD_ASPECT_V_START,
  AIRFIELD_CONCRETE_TILE_METERS,
  AIRFIELD_METAL_TILE_METERS,
} from "./AirfieldMaterials";
import type { AirportDefinition } from "../../../world/types";
import { hangarFootprint, type HangarPlan } from "./AirfieldSiting";

// The siting and the seeded plan are pure, and live in `AirfieldSiting`
// where a worker can read them without Babylon; the shell is built from them here.
export {
  HANGAR_MAX_YAW_RADIANS,
  HANGAR_PLAN_LIMITS,
  HANGAR_SITING,
  hangarFootprint,
  hangarFootprintSamples,
  hangarPlanFrom,
  hangarSeatingFrom,
  hangarYawRadians,
  MINIMUM_SKIRT_METERS,
  type HangarFootprint,
  type HangarPlan,
  type HangarRoofProfile,
  type HangarSeating,
} from "./AirfieldSiting";

// ---------------------------------------------------------------------------
// The shell the plan produces.
// ---------------------------------------------------------------------------

/**
 * Which material a run of triangles wants.
 *
 * **`glass` costs a third mesh per hangar and is here anyway.** Draw calls are
 * this airfield's binding axis, so a surface earns its group or it does not
 * exist. Glazing cannot be folded into `metal`: the clerestory has to read as
 * a dark, smooth, sky-reflecting band against ribbed galvanized cladding, and
 * that is a material difference, not a texture one.
 *
 * **It carries NO transparency and cuts NO aperture in the shell.** `7-12`'s
 * interior is out of scope, so a transparent clerestory would look through the
 * cladding into an empty box — worse than an opaque one — and it would drag
 * alpha sorting onto three meshes on the critical path. `airfield-glass` is an
 * opaque dark PBR that reads as glazing purely from its reflection of the sky
 * probe — its exact values live in `AirfieldMaterials` (this text once quoted
 * them and went stale the first time they moved), and the OPACITY this
 * paragraph depends on is pinned there: `glass.alpha` is asserted 1 with no
 * transparency mode, so the interior cut cannot be violated by a material
 * edit that forgets this constraint exists.
 */
export type HangarSurface = "metal" | "concrete" | "glass";

/**
 * Which surfaces cast a sun shadow.
 *
 * **Glass is excluded, and that is a priced decision rather than a shrug.**
 * `82c4182` measured this airfield at **2.00 draws per hangar mesh** inside the
 * LOD cull — a delta of +6 over +3 meshes at `reference-viewport` and −6 over
 * the 3 that stopped drawing at `cruise-horizon`, two shots of opposite sign
 * agreeing to three figures. Whichever term the second draw is (the
 * beauty/shadow split is still open at the time of writing), dropping a mesh
 * from the caster list removes one of the two.
 *
 * What the excluded draws would buy: the band stands `clerestoryProudMeters` —
 * 6 cm — off a wall that already casts. Its shadow falls inside the wall's for
 * every sun angle but grazing, where it would add a 6 cm lip. No shipped
 * camera distance resolves that.
 *
 * The bands still RECEIVE shadow, and still take cloud shadow and aerial
 * perspective, because those come from the `getChildMeshes` walk rather than
 * from this list.
 */
export const HANGAR_SHADOW_CASTING_SURFACES: readonly HangarSurface[] =
  Object.freeze(["concrete", "metal"] as const);

// ---------------------------------------------------------------------------
// `7-10` detail: the parts that put geometry on the silhouette.
// ---------------------------------------------------------------------------

/**
 * The detail parts, as a roster.
 *
 * `hangarDetailBoxes` carries a compile-time exhaustiveness check against this
 * list, so a part named here and never emitted fails the build — the same
 * shape `TOWER_PART_NAMES` uses, and for the same reason: 7D is the largest
 * block of hand-authored geometry left in the programme and it is written by
 * sessions that will not be flying it.
 */
export const HANGAR_DETAIL_PARTS = [
  "door-leaf",
  "door-header",
  "clerestory",
  "ridge-vent",
  "gutter",
  "downpipe",
  "pilaster",
] as const;
export type HangarDetailPart = (typeof HANGAR_DETAIL_PARTS)[number];

/**
 * Detail dimensions.
 *
 * **Fractions where the quantity must track the plan, metres where it must
 * not.** Eave height is hash-driven across 11–14.6 m, so a door sized in metres
 * is a full-height door on the short plan and a hatch on the tall one. A gutter
 * is 34 cm deep on every building ever made.
 */
export const HANGAR_DETAIL = Object.freeze({
  /** Sliding door leaves, on the apron-facing (−across) wall. */
  doorLeaves: 4,
  doorWidthFraction: 0.68,
  doorHeightFraction: 0.66,
  /** How far a leaf stands off the cladding. Alternate leaves double it. */
  doorProudMeters: 0.16,
  doorLeafGapMeters: 0.09,
  doorHeaderDepthMeters: 0.55,
  doorHeaderOverhangMeters: 0.3,

  /** Glazed band under the eave, on both across-facing walls. */
  clerestoryHeightMeters: 1.6,
  /** Below the GUTTER, not below the eave — the gutter is in the way. */
  clerestoryDropMeters: 0.5,
  clerestoryInsetFraction: 0.12,
  clerestoryProudMeters: 0.06,
  /** Least vertical gap allowed between the door header and the glazing. */
  clerestoryClearanceMeters: 0.4,

  /** Ridge ventilators. */
  ventCount: 3,
  ventWidthMeters: 1.4,
  ventLengthMeters: 3.2,
  ventHeightMeters: 0.7,
  /** Fraction of the depth the vent run occupies, centred on the ridge. */
  ventSpanFraction: 0.72,

  /** Eave gutters and their downpipes. */
  gutterDepthMeters: 0.34,
  gutterProudMeters: 0.26,
  downpipeWidthMeters: 0.22,

  /** Concrete piers on the gable ends, one per bay boundary. */
  pilasterWidthMeters: 0.7,
  pilasterProudMeters: 0.24,
  pilasterHeightFraction: 0.55,
});

/** An axis-aligned closed solid, in hangar-local metres. */
export interface HangarDetailBox {
  readonly part: HangarDetailPart;
  readonly surface: HangarSurface;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * Every detail solid for one plan, as DATA rather than as triangles.
 *
 * **Separated from the emission on purpose.** Clearance between parts is the
 * property most likely to break when a constant moves, and a door header grown
 * into the glazing renders as z-fighting that no triangle count would catch.
 * Returning boxes lets a test assert clearances directly, over every plan the
 * generator can produce, without reconstructing solids from an index buffer.
 *
 * **Each box is individually CLOSED**, which is what keeps the winding guard's
 * signed-volume metric meaningful. That metric silently `continue`s past any
 * mesh it judges open, so detail that broke the shell's closure would not fail
 * the guard — it would drop the whole hangar out of the one metric that cannot
 * be fooled by a builder deriving its normals from its own winding.
 */
export function hangarDetailBoxes(plan: HangarPlan): readonly HangarDetailBox[] {
  const d = HANGAR_DETAIL;
  const halfW = plan.widthMeters / 2;
  const halfD = plan.depthMeters / 2;
  const base = -plan.skirtHeightMeters;
  const eave = plan.eaveHeightMeters;
  const boxes: HangarDetailBox[] = [];
  const emitted = new Set<HangarDetailPart>();
  const box = (
    part: HangarDetailPart,
    surface: HangarSurface,
    min: readonly [number, number, number],
    max: readonly [number, number, number],
  ): void => {
    emitted.add(part);
    boxes.push({ part, surface, min, max });
  };
  /** A pair of coordinates on one axis, ordered so `min` really is the min. */
  const span = (a: number, b: number): readonly [number, number] =>
    (a <= b ? [a, b] : [b, a]);

  // --- Gutters, at both eaves, running the full depth. ---------------------
  const gutterTop = eave;
  const gutterBottom = eave - d.gutterDepthMeters;
  for (const side of [-1, 1] as const) {
    const [x0, x1] = span(side * halfW, side * (halfW + d.gutterProudMeters));
    box("gutter", "metal", [x0, gutterBottom, -halfD], [x1, gutterTop, halfD]);
    // --- Downpipes, at both ends of each gutter. --------------------------
    // Four of them, and they are the reason `7-11`'s metal recipe stamps
    // "gutter drip points along the top edge": the streaks that texture
    // already draws now have the fitting that would produce them.
    for (const end of [-1, 1] as const) {
      const [z0, z1] = span(end * halfD, end * (halfD - d.downpipeWidthMeters));
      box("downpipe", "metal", [x0, base, z0], [x1, gutterBottom, z1]);
    }
  }

  // --- The door, on the wall the apron sees. --------------------------------
  // −across is the runway side, which is also the face `7-11`'s UV contract
  // treats as maintained. Putting the door on a gable end instead would aim
  // the building's one recognisable feature along the runway, where no
  // approach pose ever sees it.
  const doorWidth = plan.depthMeters * d.doorWidthFraction;
  const doorTop = eave * d.doorHeightFraction;
  const leafPitch = doorWidth / d.doorLeaves;
  for (let leaf = 0; leaf < d.doorLeaves; leaf += 1) {
    // Alternate leaves stand twice as proud: a sliding door runs on two
    // tracks, and equal-depth leaves read as one flat panel with scribed
    // lines rather than as a door that opens.
    const proud = d.doorProudMeters * (leaf % 2 === 0 ? 1 : 2);
    const z0 = -doorWidth / 2 + leaf * leafPitch + d.doorLeafGapMeters / 2;
    box(
      "door-leaf", "metal",
      [-halfW - proud, 0, z0],
      [-halfW, doorTop, z0 + leafPitch - d.doorLeafGapMeters],
    );
  }
  const headerTop = doorTop + d.doorHeaderDepthMeters;
  box(
    "door-header", "metal",
    [-halfW - (d.doorProudMeters * 2 + 0.05), doorTop, -doorWidth / 2 - d.doorHeaderOverhangMeters],
    [-halfW, headerTop, doorWidth / 2 + d.doorHeaderOverhangMeters],
  );

  // --- Clerestory glazing, under both gutters. -----------------------------
  const glazingTop = gutterBottom - d.clerestoryDropMeters;
  const glazingBottom = glazingTop - d.clerestoryHeightMeters;
  if (glazingBottom < headerTop + d.clerestoryClearanceMeters) {
    // Loud rather than smeared. Every plan `hangarPlanFrom` can produce clears
    // this today — asserted over the whole plan space, which is finite — so
    // the throw exists to catch a constant edited later, not a live case.
    throw new RangeError(
      `Hangar clerestory sits at ${glazingBottom.toFixed(2)} m, inside the `
      + `${d.clerestoryClearanceMeters} m clearance above a door header at `
      + `${headerTop.toFixed(2)} m (eave ${eave.toFixed(2)} m)`,
    );
  }
  const glazingInset = plan.depthMeters * d.clerestoryInsetFraction;
  for (const side of [-1, 1] as const) {
    const [x0, x1] = span(side * halfW, side * (halfW + d.clerestoryProudMeters));
    box(
      "clerestory", "glass",
      [x0, glazingBottom, -halfD + glazingInset],
      [x1, glazingTop, halfD - glazingInset],
    );
  }

  // --- Ridge ventilators. --------------------------------------------------
  // Both roof profiles peak at `ridgeHeightMeters` over the centreline —
  // gabled by `1 − |t|` and arched by `cos(t·π/2)`, both 1 at t = 0 — so one
  // placement serves both rather than branching on the profile.
  const ventRun = plan.depthMeters * d.ventSpanFraction;
  const ventPitch = ventRun / d.ventCount;
  for (let vent = 0; vent < d.ventCount; vent += 1) {
    const centre = -ventRun / 2 + (vent + 0.5) * ventPitch;
    // Straddling the crown, which is no longer the centreline. A vent left at
    // across = 0 would float above an off-centre roof by the crown's own drop.
    const crownAcross = halfW * plan.crownOffset;
    box(
      "ridge-vent", "metal",
      [crownAcross - d.ventWidthMeters / 2, plan.ridgeHeightMeters - 0.05, centre - d.ventLengthMeters / 2],
      [crownAcross + d.ventWidthMeters / 2, plan.ridgeHeightMeters + d.ventHeightMeters, centre + d.ventLengthMeters / 2],
    );
  }

  // --- Pilasters on the gable ends, one per bay boundary. ------------------
  // This is the only place the hash-driven bay count becomes visible geometry.
  // Without it `bays` moves the eave height and nothing else, and three
  // hangars differing only in height read as one building at three scales.
  const halfPier = d.pilasterWidthMeters / 2;
  for (let bay = 0; bay <= plan.bays; bay += 1) {
    const raw = -halfW + (plan.widthMeters * bay) / plan.bays;
    // The end piers would otherwise straddle the corner and stand out past
    // the wall they are meant to thicken.
    const centre = Math.min(halfW - halfPier, Math.max(-halfW + halfPier, raw));
    for (const side of [-1, 1] as const) {
      const [z0, z1] = span(side * halfD, side * (halfD + d.pilasterProudMeters));
      box(
        "pilaster", "concrete",
        [centre - halfPier, base, z0],
        [centre + halfPier, eave * d.pilasterHeightFraction, z1],
      );
    }
  }

  // Every part in the roster is emitted for every plan. A part named and never
  // built is the failure this check exists for: it would be listed in the
  // module's own documentation, absent from the winding guard's cases, and
  // absent from the building.
  const missing = HANGAR_DETAIL_PARTS.filter((part) => !emitted.has(part));
  if (missing.length > 0) {
    throw new Error(`Hangar detail parts named but not emitted: ${missing.join(", ")}`);
  }
  return boxes;
}

/** A contiguous run of indices sharing one surface. */
export interface ShellGroup {
  readonly surface: HangarSurface;
  readonly start: number;
  readonly count: number;
}

export interface ShellGeometry {
  readonly positions: number[];
  readonly normals: number[];
  /**
   * World-scale UVs on `7-11`'s contract: U is metres along the face over the
   * tiling period, V runs from the face's TOP edge to its bottom so weathering
   * accumulates with +V. V starts at the face's aspect value rather than 0 —
   * a RANGE START, not a phase offset, because an offset into tiling V would
   * only shift the pattern instead of ageing the face.
   *
   * Aspect is read from the face normal's across component: the runway lies in
   * −across from the hangars, so a −x face is the one the airfield sees and
   * gets repainted, and a +x face is the back nobody maintains.
   */
  readonly uvs: number[];
  readonly indices: number[];
  /**
   * Index runs by surface, in emission order.
   *
   * **One mesh per surface, not per part.** Draw calls are the binding axis on
   * this airfield, so the shell is grouped by material rather than by feature —
   * a hangar costs two draws, not one per wall.
   */
  readonly groups: readonly ShellGroup[];
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

  const uvs: number[] = [];
  const runs: { surface: HangarSurface; indices: number[] }[] = [
    { surface: "concrete", indices: [] },
    { surface: "metal", indices: [] },
    { surface: "glass", indices: [] },
  ];

  const quad = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    normal: readonly [number, number, number],
    surface: HangarSurface,
    // Metres from the FACE's U origin to this quad's corner 0. A face split
    // into segments would otherwise restart its tiling at every seam, because
    // U is measured from corner 0 — visible as a hard jump every 3.8 m on an
    // arched gable, where the split is 12 ways.
    uOriginMeters = 0,
  ) => {
    const start = positions.length / 3;
    const corners = [a, b, c, d];
    // The face's own vertical extent, which is what V is measured against —
    // `7-11`'s contract is top-of-face to bottom-of-face, not a global height.
    const topY = Math.max(...corners.map((p) => p[1]));
    const bottomY = Math.min(...corners.map((p) => p[1]));
    const height = topY - bottomY;
    // Aspect from the normal's ACROSS component. The runway lies in −across
    // from the hangars, so a −x face is the one the airfield sees.
    const aspect = Math.abs(normal[0]) > 0.5
      ? (normal[0] < 0
        ? AIRFIELD_ASPECT_V_START.facingRunway
        : AIRFIELD_ASPECT_V_START.awayFromRunway)
      : AIRFIELD_ASPECT_V_START.sides;
    const period = surface === "metal"
      ? AIRFIELD_METAL_TILE_METERS
      : AIRFIELD_CONCRETE_TILE_METERS;
    for (const point of corners) {
      positions.push(point[0], point[1], point[2]);
      normals.push(normal[0], normal[1], normal[2]);
      // U runs along the face horizontally; V from the top edge downward, so
      // streaks accumulate with +V and read as gravity.
      const u = (uOriginMeters
        + Math.hypot(point[0] - corners[0]![0], point[2] - corners[0]![2])) / period;
      const v = height > 1e-9
        ? aspect + (1 - aspect) * ((topY - point[1]) / height)
        : aspect;
      uvs.push(u, v);
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
      if (area > 1e-9) {
        runs.find((run) => run.surface === surface)!.indices.push(
          start + i0, start + i1, start + i2,
        );
      }
    }
  };

  /**
   * Roof height at a normalised span coordinate in [-1, 1].
   *
   * **The crown is OFF CENTRE and the arch is a superellipse, not a cosine.**
   * The cosine lobe is a dome: rise/half-span 0.64 at the old constants,
   * meeting the wall at 45 degrees, mirror-symmetric. Read as "a semi circle
   * and a square" the first time anyone saw it at 200 px.
   *
   * `u` is distance from the crown, renormalised so each SIDE still reaches
   * exactly 1 at its own eave — that is what lets the peak move without the
   * roof lifting off the walls. Both halves land on `eaveHeightMeters` at
   * t = ±1 for any offset, which the closed-manifold requirement depends on.
   *
   * Neither branch adds a vertex: the segment count is unchanged and only the
   * heights differ. The whole organic pass is free in the draw budget, which
   * it had to be — every casting mesh costs 3.00 draws now.
   */
  const roofHeight = (t: number): number => {
    const rise = plan.ridgeHeightMeters - plan.eaveHeightMeters;
    const c = plan.crownOffset;
    const u = t <= c
      ? (c - t) / (1 + c)
      : (t - c) / (1 - c);
    const clamped = Math.min(1, Math.max(0, u));
    const profile = plan.roof === "gabled"
      // A straight pitch, but off centre: the two slopes now differ, which is
      // the whole point. A symmetric gable is as much a primitive as a dome.
      ? 1 - clamped
      // Superellipse, with p bracketing a true segmental circular arc. p = 2
      // is an ellipse; BELOW 2 approaches the parabola a shallow arch really
      // follows. See `minArchExponent` for why p > 2 is the wrong direction.
      : (1 - clamped ** plan.archExponent) ** (1 / plan.archExponent);
    return plan.eaveHeightMeters + rise * profile;
  };

  const steps = plan.roof === "gabled" ? 2 : plan.archSegments;
  /**
   * Span breakpoints, with the CROWN snapped onto one of them.
   *
   * **Moving the crown in the profile function is not enough; it has to be a
   * VERTEX.** A gabled roof is two segments through x = -halfW, 0, +halfW, so
   * an off-centre peak was never sampled: the polyline still turned at x = 0,
   * at a height BELOW `ridgeHeightMeters`, and the ridge vents — which sit at
   * `ridgeHeightMeters` by construction — floated about 1.2 m above the metal.
   * A silhouette change that only exists between vertices does not exist.
   *
   * Found by an asymmetry assertion failing on the built shell rather than by
   * reading the profile function, which is the only way it could have been
   * found: the arithmetic was right and the sampling was wrong.
   *
   * The count is unchanged — a breakpoint MOVES, none is added — so this is
   * still free in the draw budget.
   */
  const spanBreaks = ((): number[] => {
    const xs: number[] = [];
    for (let i = 0; i <= steps; i += 1) xs.push(-halfW + (plan.widthMeters * i) / steps);
    const crownX = halfW * plan.crownOffset;
    // Snap the interior breakpoint nearest the crown onto it. Interior only:
    // the two eaves are structural and must stay at +/- halfW or the roof
    // leaves the walls.
    let nearest = 1;
    for (let i = 2; i < steps; i += 1) {
      if (Math.abs(xs[i]! - crownX) < Math.abs(xs[nearest]! - crownX)) nearest = i;
    }
    if (steps >= 2) xs[nearest] = crownX;
    return xs;
  })();
  const spanAt = (i: number) => spanBreaks[i]!;

  // Walls, SPLIT AT THE SLAB. Below y=0 is the concrete skirt that closes the
  // gap to the lowest ground; above it is the metal cladding. One shell, two
  // materials, and the split is where the real building's is.
  const wall = (
    lo: number,
    hi: number,
    surface: HangarSurface,
  ) => {
    // The eave walls are single quads: their top edge runs along z at
    // x = ±halfW, which is exactly the edge the first and last roof segments
    // present, so they already meet edge-to-edge.
    quad([-halfW, lo, -halfD], [-halfW, lo, halfD], [-halfW, hi, halfD],
      [-halfW, hi, -halfD], [-1, 0, 0], surface);
    quad([halfW, lo, halfD], [halfW, lo, -halfD], [halfW, hi, -halfD],
      [halfW, hi, halfD], [1, 0, 0], surface);
    // THE GABLE ENDS ARE SPLIT ON THE ROOF'S OWN BREAKPOINTS, and that is a
    // closure fix rather than a tessellation preference.
    //
    // A single full-width quad here presents ONE top edge at the eave, while
    // the gable infill above it presents `steps` of them. Position-keyed, one
    // edge cannot cancel two, so the shell was open by `2 * steps + 2` edges —
    // 6 gabled, 26 arched, all of them on the eave line at z = ±halfD. That is
    // a T-junction: it renders as a hairline crack between wall and gable
    // wherever the two rasterise a fraction of a pixel apart, and it made the
    // "ONE closed manifold" claim above false from the day it landed.
    //
    // The silent half is worse than the crack. The winding guard's signed
    // volume is only defined on a closed surface, so its assertion `continue`s
    // past anything it judges open — the hangar shell was in the guard's case
    // list and was being SKIPPED by the one metric that cannot be fooled by a
    // builder deriving normals from its own winding. It passed by not being
    // measured.
    for (let i = 0; i < steps; i += 1) {
      const x0 = spanAt(i);
      const x1 = spanAt(i + 1);
      quad([x1, lo, -halfD], [x0, lo, -halfD], [x0, hi, -halfD],
        [x1, hi, -halfD], [0, 0, -1], surface, halfW - x1);
      quad([x0, lo, halfD], [x1, lo, halfD], [x1, hi, halfD],
        [x0, hi, halfD], [0, 0, 1], surface, x0 + halfW);
    }
  };
  wall(base, 0, "concrete");
  wall(0, plan.eaveHeightMeters, "metal");

  for (let i = 0; i < steps; i += 1) {
    const x0 = spanAt(i);
    const x1 = spanAt(i + 1);
    const y0 = roofHeight(x0 / halfW);
    const y1 = roofHeight(x1 / halfW);
    // Gable infill above the eave, one quad per roof segment per end.
    quad([x1, plan.eaveHeightMeters, -halfD], [x0, plan.eaveHeightMeters, -halfD],
      [x0, y0, -halfD], [x1, y1, -halfD], [0, 0, -1], "metal", halfW - x1);
    quad([x0, plan.eaveHeightMeters, halfD], [x1, plan.eaveHeightMeters, halfD],
      [x1, y1, halfD], [x0, y0, halfD], [0, 0, 1], "metal", x0 + halfW);
    // The roof plane for this segment.
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.hypot(dx, dy) || 1;
    quad([x0, y0, -halfD], [x0, y0, halfD], [x1, y1, halfD], [x1, y1, -halfD],
      [-dy / length, dx / length, 0], "metal");
  }

  // The underside, closing the manifold — split the same way, because the
  // skirt's gable ends now present `steps` bottom edges rather than one.
  // A fix that closed the eave and opened the sill would have measured as
  // progress (fewer open edges) while leaving the mesh just as unmeasurable.
  for (let i = 0; i < steps; i += 1) {
    const x0 = spanAt(i);
    const x1 = spanAt(i + 1);
    quad([x0, base, -halfD], [x1, base, -halfD], [x1, base, halfD],
      [x0, base, halfD], [0, -1, 0], "concrete");
  }

  /**
   * One closed axis-aligned solid, six faces, each wound counter-clockwise as
   * seen from OUTSIDE — the ordering `quad` already requires, read off the
   * walls above rather than re-derived.
   *
   * **Each solid closes on its own**, so the shell stays a closed manifold no
   * matter how many are added. The winding guard keys edges on POSITION and
   * skips any mesh it judges open, so a detail part that left the surface open
   * would not fail the guard — it would take the hangar out of the guard's
   * signed-volume assertion entirely, silently.
   */
  const solid = (b: HangarDetailBox): void => {
    const [x0, y0, z0] = b.min;
    const [x1, y1, z1] = b.max;
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], b.surface);
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], b.surface);
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], b.surface);
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], b.surface);
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], b.surface);
    quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], b.surface);
  };
  for (const detail of hangarDetailBoxes(plan)) solid(detail);

  const groups: ShellGroup[] = [];
  for (const run of runs) {
    if (run.indices.length === 0) continue;
    groups.push({ surface: run.surface, start: indices.length, count: run.indices.length });
    indices.push(...run.indices);
  }
  return { positions, normals, uvs, indices, groups };
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
    // AT THE TRUE APEX, not at the structural ridge.
    //
    // `ObstructionLighting` mounts its top lamps at `ridgeEnds` plus a 0.5 m
    // stand and reads NOTHING else — it never looks at `heightMeters`. `7-10`'s
    // ventilators stand 0.7 m above the ridge, so ridge-height mounts would put
    // the highest obstruction light 0.2 m BELOW the highest metal on the
    // building. Raising these is what actually fixes that; correcting
    // `heightMeters` alone would have left the consumer reading the stale field.
    //
    // The vents sit on the ridge line, so this is the same line raised to the
    // height it actually reaches — not a new mount in a new place. Both fields
    // now agree about where the top of the building is, which is the point: a
    // truth split across two attachment fields is one stale field waiting to be
    // read.
    // ACROSS THE CROWN, NOT THE CENTRELINE. The organic pass moved the roof's
    // high point off centre, so a mount at across = 0 would hang in the air
    // over a roof that is no longer highest there. `7-14` puts its top
    // obstruction lamp here and the lamp has to sit on the metal.
    ridgeEnds: Object.freeze([
      at(halfW * plan.crownOffset, plan.ridgeHeightMeters + HANGAR_DETAIL.ventHeightMeters, -halfD),
      at(halfW * plan.crownOffset, plan.ridgeHeightMeters + HANGAR_DETAIL.ventHeightMeters, halfD),
    ]),
    // THE RIDGE IS NO LONGER THE TOP. `7-10`'s ventilators stand
    // `ventHeightMeters` above it, and this figure is what `7-14` mounts
    // obstruction lighting against — a light at the ridge would sit BELOW the
    // highest metal on the building, which is the one thing an obstruction
    // light must never do. Asserted against the built geometry's own y extent
    // rather than restated, so a part that grows taller than the vents fails
    // here instead of quietly outranking the light.
    heightMeters: plan.ridgeHeightMeters
      + HANGAR_DETAIL.ventHeightMeters
      + plan.skirtHeightMeters,
  };
}

// ---------------------------------------------------------------------------
// Mesh construction.
// ---------------------------------------------------------------------------

/**
 * Distance policy for airfield structures.
 *
 * **The cull distance is load-bearing rather than decorative:** `buildHangar`
 * installs it as a Babylon LOD level with a null replacement, so beyond it the
 * shell is not drawn at all. A hangar is a scale reference on final approach,
 * so this is far rather than tight — `RENDERING_PLAN.md` §1.5 records that the
 * hangars are the only scale reference on final besides the runway.
 */
export const AIRFIELD_STRUCTURE_LOD = Object.freeze({
  cullDistanceMeters: 6_000,
});


export interface HangarMeshes {
  /** Every mesh built, in group order. Parented under the supplied root. */
  readonly meshes: readonly Mesh[];
  /**
   * The subset of `meshes` that should cast a sun shadow, per
   * `HANGAR_SHADOW_CASTING_SURFACES`.
   *
   * **Returned rather than re-derived by the caller.** `AirportSystem` would
   * otherwise have to decide it from mesh NAMES, which is a second encoding of
   * the same rule in a place that does not change when the surfaces do — and
   * the failure would be silent in the expensive direction: a new
   * non-shadowing surface would quietly start costing a draw per cascade on
   * every shot.
   */
  readonly shadowCasters: readonly Mesh[];
  readonly attachments: HangarAttachments;
}

/**
 * Build one hangar's meshes under `root`.
 *
 * **EAGER, and parented before returning.** `FlightRenderer` walks
 * `airport.root.getChildMeshes(false)` ONCE at construction to populate the
 * cloud-shadow and aerial-perspective registries, and captures `shadowCasters`
 * into a frozen array in the same pass. A generator that built lazily, or that
 * reparented afterwards, would miss both registries **with no error at all** —
 * the hangar would draw, and would silently take neither cloud shadows nor
 * aerial perspective. So nothing here defers work to a first render.
 *
 * **One mesh per SURFACE, not per part.** Draw calls are the binding axis on
 * this airfield; grouping by material keeps a hangar at two draws.
 */
export function buildHangar(
  scene: Scene,
  root: TransformNode,
  index: number,
  plan: HangarPlan,
  attachments: HangarAttachments,
  materials: Readonly<Record<HangarSurface, Material>>,
): HangarMeshes {
  const shell = hangarShellGeometry(plan);
  const meshes: Mesh[] = [];
  const shadowCasters: Mesh[] = [];
  for (const group of shell.groups) {
    const mesh = new Mesh(`airport-hangar-${index}-${group.surface}`, scene);
    const data = new VertexData();
    data.positions = shell.positions;
    data.normals = shell.normals;
    data.uvs = shell.uvs;
    data.indices = shell.indices.slice(group.start, group.start + group.count);
    data.applyToMesh(mesh, false);
    mesh.material = materials[group.surface];
    mesh.parent = root;
    // Beyond the cull distance, draw nothing. `addLODLevel(d, null)` is
    // Babylon's own mechanism, so this is asserted against the mesh rather
    // than against our constant.
    mesh.addLODLevel(AIRFIELD_STRUCTURE_LOD.cullDistanceMeters, null);
    meshes.push(mesh);
    if (HANGAR_SHADOW_CASTING_SURFACES.includes(group.surface)) shadowCasters.push(mesh);
  }
  return { meshes, shadowCasters, attachments };
}
