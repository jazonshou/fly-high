import {
  detailRadialScaleForWorldRadius,
  normalAlignedQuaternion,
  type DetailInstanceRecord,
  type DetailPrototypeBounds,
} from "./instanceFormat";
import type { DetailFloatingOrigin, DetailTreePlacement, TreeSpecies } from "./types";

/**
 * The shadow a drawn tree lays on the ground: one flat decal per stem.
 *
 * Why this exists. Trees cast a real shadow only inside the near band and only
 * where `vegetationCastsShadows` is on, which is nowhere on Low and Medium and
 * 120 to 190 m on High and Ultra. Everywhere else a tree stood on evenly lit
 * ground, which is the largest single reason open ground with a few trees on
 * it read as a painted sheet: nothing tied the tree to the ground.
 *
 * What it is. A quad laid on the slope the tree stands on, darkening the
 * ground already drawn beneath it (the tyre tracks' blend). It carries two
 * shapes: the crown's shadow, an ellipse thrown away from the sun, and a
 * round patch of sky shade under the crown that stays when the sun is hidden.
 *
 * This module is the CPU half and has no Babylon dependency: the record a stem
 * emits, the shape table, and a mirror of the shader's footprint so tests and
 * the culling bound read the same numbers the shader does.
 */

export const TREE_GROUND_SHADOW_PROTOTYPE_KEY = "tree-ground-shadow";

/**
 * The longest shadow drawn, as the cotangent of the sun's height above the
 * ground the tree stands on: 2.5 is a sun 21.8 degrees up. Below that the
 * shadow stops growing and fades instead, because a decal is a flat plane and
 * a 60 m shadow no longer lies on the ground it was fitted to.
 */
export const TREE_GROUND_SHADOW_MAX_COTANGENT = 2.5;

/** The quad reaches this far past the crown shadow's nominal ellipse. */
export const TREE_GROUND_SHADOW_SOFT_EDGE = 1.2;

/** The crown shadow is full inside this share of the ellipse and gone at the soft edge. */
export const TREE_GROUND_SHADOW_CORE = 0.55;

/** The crown throws a shadow a little narrower than its widest branch tips. */
export const TREE_GROUND_SHADOW_CROWN_FILL = 0.92;

/** Radius of the sky shade under the crown, in crown radii. */
export const TREE_GROUND_SHADOW_SKY_SHADE_RADIUS = 1.05;

/** One step of the trunk radius lane, in metres (the lane holds 0 to 31). */
export const TREE_GROUND_SHADOW_TRUNK_STEP_METERS = 0.03;

/**
 * How much of a leafless crown's shadow is left: branches alone.
 * `ImpostorAtlas` bakes its bare bucket at a leaf fraction of 0.08; the
 * branches themselves shade about a quarter of what the leafed crown did.
 */
export const TREE_GROUND_SHADOW_BARE_SHARE = 0.3;

export interface TreeGroundShadowShape {
  /** Height of the crown's middle, as a share of the tree's height. */
  readonly crownCentreUnit: number;
  /** Half the crown's depth, as a share of the tree's height. */
  readonly crownSemiAxisUnit: number;
  /** How much direct sun the leafed crown stops, 0 to 1. */
  readonly opacity: number;
}

/**
 * Crown shape per species, from the same spans the tree prototypes are built
 * on (`TREE_SPECIES_SPECS`: conifer crowns run from 0.25 to 1.0 of the height,
 * broadleaf from 0.45 to 1.05, the palm's from 0.7). A conifer's crown is a
 * cone, so its middle sits lower than the span's midpoint.
 */
export const TREE_GROUND_SHADOW_SHAPES: Readonly<Record<TreeSpecies, TreeGroundShadowShape>> =
  Object.freeze({
    pine: Object.freeze({ crownCentreUnit: 0.6, crownSemiAxisUnit: 0.34, opacity: 0.78 }),
    cedar: Object.freeze({ crownCentreUnit: 0.56, crownSemiAxisUnit: 0.37, opacity: 0.88 }),
    spruce: Object.freeze({ crownCentreUnit: 0.54, crownSemiAxisUnit: 0.38, opacity: 0.9 }),
    oak: Object.freeze({ crownCentreUnit: 0.74, crownSemiAxisUnit: 0.3, opacity: 0.9 }),
    maple: Object.freeze({ crownCentreUnit: 0.74, crownSemiAxisUnit: 0.3, opacity: 0.88 }),
    birch: Object.freeze({ crownCentreUnit: 0.74, crownSemiAxisUnit: 0.3, opacity: 0.7 }),
    willow: Object.freeze({ crownCentreUnit: 0.64, crownSemiAxisUnit: 0.36, opacity: 0.82 }),
    palm: Object.freeze({ crownCentreUnit: 0.9, crownSemiAxisUnit: 0.1, opacity: 0.6 }),
  });

const MAX_CENTRE_UNIT = Math.max(
  ...Object.values(TREE_GROUND_SHADOW_SHAPES).map((shape) => shape.crownCentreUnit),
);
const MAX_SEMI_AXIS_UNIT = Math.max(
  ...Object.values(TREE_GROUND_SHADOW_SHAPES).map((shape) => shape.crownSemiAxisUnit),
);

/**
 * The culling bound of the decal, in the record's own units (X and Z in crown
 * radii, Y in tree heights; the packer turns them into one sphere round the
 * stem). The decal reaches
 *
 *   along the sun: `centre * cot + edge * sqrt(R^2 + (semi * cot)^2)`
 *   across it:     `edge * R`
 *
 * from the stem, which is at most `sqrt(2) * edge * R + cot * (centre + edge *
 * semi) * H`. A sum `p R + q H` is bounded by `sqrt((sqrt(2) p R)^2 +
 * (sqrt(2) q H)^2)`, so those are the units below, split over X and Z.
 */
export const TREE_GROUND_SHADOW_PROTOTYPE_BOUNDS: DetailPrototypeBounds = (() => {
  const radial = Math.SQRT2 * TREE_GROUND_SHADOW_SOFT_EDGE;
  const vertical = Math.SQRT2 * TREE_GROUND_SHADOW_MAX_COTANGENT
    * (MAX_CENTRE_UNIT + TREE_GROUND_SHADOW_SOFT_EDGE * MAX_SEMI_AXIS_UNIT);
  return Object.freeze({
    minimum: Object.freeze([-radial, -vertical, -radial] as const),
    maximum: Object.freeze([radial, vertical, radial] as const),
  });
})();

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The record one stem's shadow travels in, on the detail instance format:
 *
 * - position: the stem's base;
 * - orientation: the tilt of the ground it stands on;
 * - scale: the tree's height, and its crown radius over that height;
 * - tint: crown centre, crown half-depth (both as shares of the height), how
 *   much sun the crown stops, and the stand's density over the near cap;
 * - state: variant holds the trunk radius in 3 cm steps (kept under 32 so the
 *   packer's lean modifier never applies), and the phase lane holds the stem's
 *   key, the same number its tree records carry, so the shadow draws exactly
 *   while the tree does.
 */
export function treeGroundShadowRecord(
  tree: DetailTreePlacement,
  stemKey: number,
  standDensityShare: number,
  floatingOrigin: DetailFloatingOrigin,
): DetailInstanceRecord {
  const shape = TREE_GROUND_SHADOW_SHAPES[tree.species];
  const slopeX = Number.isFinite(tree.groundSlopeX) ? tree.groundSlopeX! : 0;
  const slopeZ = Number.isFinite(tree.groundSlopeZ) ? tree.groundSlopeZ! : 0;
  const normalLength = Math.hypot(slopeX, 1, slopeZ);
  // The tint's alpha is the stem's leaf fraction: 1 in leaf, falling to 0 as
  // a deciduous crown sheds (`applyFoliageSeason`). Evergreens stay at 1.
  const leaf = clamp01(tree.color[3]);
  return {
    x: tree.x - floatingOrigin.x,
    y: tree.y - floatingOrigin.y,
    z: tree.z - floatingOrigin.z,
    quaternion: normalAlignedQuaternion(
      { x: -slopeX / normalLength, y: 1 / normalLength, z: -slopeZ / normalLength },
      0,
      1,
    ),
    heightScaleMeters: tree.heightMeters,
    radialScale: detailRadialScaleForWorldRadius(tree.crownRadiusMeters, tree.heightMeters, 1),
    fade: 1,
    variant: Math.min(
      31,
      Math.max(1, Math.round(tree.trunkRadiusMeters / TREE_GROUND_SHADOW_TRUNK_STEP_METERS)),
    ),
    tint: [
      shape.crownCentreUnit,
      shape.crownSemiAxisUnit,
      shape.opacity * (TREE_GROUND_SHADOW_BARE_SHARE + (1 - TREE_GROUND_SHADOW_BARE_SHARE) * leaf),
      clamp01(standDensityShare),
    ],
    windPhase: stemKey,
    windResponse: 0,
  };
}

export interface TreeGroundShadowFootprint {
  /** Metres from the stem to the crown shadow's centre, away from the sun. */
  readonly offsetMeters: number;
  /** The crown shadow's half-length along the sun, at its nominal edge. */
  readonly semiAlongMeters: number;
  /** Its half-width across the sun, at its nominal edge. */
  readonly semiAcrossMeters: number;
  /** Where the quad starts and ends along the sun, from the stem. */
  readonly quadStartMeters: number;
  readonly quadEndMeters: number;
  /** The quad's half-width. */
  readonly quadHalfWidthMeters: number;
}

/**
 * The shader's footprint, on the CPU: where a crown of this shape throws its
 * shadow for a sun whose height above the ground has this cotangent (any
 * cotangent above `TREE_GROUND_SHADOW_MAX_COTANGENT` is clamped to it).
 */
export function treeGroundShadowFootprint(
  heightMeters: number,
  crownRadiusMeters: number,
  shape: TreeGroundShadowShape,
  sunCotangent: number,
): TreeGroundShadowFootprint {
  const cotangent = Math.min(TREE_GROUND_SHADOW_MAX_COTANGENT, Math.max(0, sunCotangent));
  const across = crownRadiusMeters * TREE_GROUND_SHADOW_CROWN_FILL;
  const along = Math.hypot(across, shape.crownSemiAxisUnit * heightMeters * cotangent);
  const offset = shape.crownCentreUnit * heightMeters * cotangent;
  const skyShade = crownRadiusMeters * TREE_GROUND_SHADOW_SKY_SHADE_RADIUS;
  return {
    offsetMeters: offset,
    semiAlongMeters: along,
    semiAcrossMeters: across,
    quadStartMeters: -Math.max(skyShade, along * TREE_GROUND_SHADOW_SOFT_EDGE - offset),
    quadEndMeters: Math.max(skyShade, offset + along * TREE_GROUND_SHADOW_SOFT_EDGE),
    quadHalfWidthMeters: Math.max(skyShade, across * TREE_GROUND_SHADOW_SOFT_EDGE),
  };
}
