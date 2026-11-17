import { SurfaceMaterial } from "@/src/render/webgpu/terrain/surfaceMaterials";
import { PERSON, toblerFactor } from "@/src/vehicles/person";

/**
 * The walker's laws as pure functions of their inputs, so tests can hold
 * them to their sources: how steep a surface can be walked, how running
 * softens Tobler's slope law, how fast a wader goes at each depth, and what
 * a landing at a speed does. The walker's step evaluates them in place from
 * the same tables and numbers (a call that takes or returns a fractional
 * number boxes it where V8 does not inline the call), and its tests hold the
 * walker to these functions.
 */

const DEGREES = Math.PI / 180;

/**
 * The steepest ground the walker walks up, degrees, by `SurfaceMaterial` id
 * (the walking plan, "Slopes"): 35 on grass and soil, 45 on rock and paving,
 * and loose ground at its angle of repose, 33 for sand and scree (gravel,
 * tephra) and 30 for snow. Steeper than this the walker cannot climb and
 * slides down, with the limit as its friction angle, so the slide starts
 * from rest at the limit and grows past it.
 */
export const WALK_SLOPE_LIMIT_DEGREES: readonly number[] = Object.freeze([
  33, // Sand
  35, // Grass
  35, // ForestFloor
  35, // Shrub
  45, // Rock
  30, // Snow
  35, // DryGrass
  33, // Gravel: loose like scree
  45, // Asphalt
  45, // Concrete
  45, // Basalt
  33, // Tephra: volcanic scree
]);

/** The limit on a collider's top (decks, floors, stairs, ramps): paving's. */
export const COLLIDER_SLOPE_LIMIT_DEGREES = 45;

/** tan of each material's limit, for the step to read without trigonometry. */
export const WALK_SLOPE_LIMIT_TAN = Float64Array.from(WALK_SLOPE_LIMIT_DEGREES, (degrees) => Math.tan(degrees * DEGREES));

/** tan of the walk limit on a `SurfaceMaterial` id (grass's for an unknown one). */
export function walkSlopeLimitTan(material: number): number {
  const tan = WALK_SLOPE_LIMIT_TAN[material];
  return tan === undefined ? WALK_SLOPE_LIMIT_TAN[SurfaceMaterial.Grass]! : tan;
}

/**
 * Running on a slope: Tobler's shape, softened (ESTIMATE). Runners slow on
 * climbs and steep descents less, in proportion, than walkers: the exponent
 * is 0.6 of the walk's, so +10% keeps 81% of the run speed (3.6 m/s) where
 * a walker keeps 71%, and +30% keeps 53%.
 */
export const RUN_SLOPE_SOFTENING = 0.6;

export function runSlopeFactor(slope: number): number {
  return Math.exp(-3.5 * RUN_SLOPE_SOFTENING * (Math.abs(slope + 0.05) - 0.05));
}

/** Walk or run slope factor on `slope` (rise over run along the move). */
export function slopeSpeedFactor(slope: number, running: boolean): number {
  return running ? runSlopeFactor(slope) : toblerFactor(slope);
}

/**
 * Wading depths as shares of the stature (Drillis and Contini 1966's body
 * proportions: knee 0.285 H, navel 0.6 H, nipple line 0.72 H) and the speed
 * there, m/s: 1.0 knee deep, 0.6 waist deep, 0.4 chest deep (the walking
 * plan's ESTIMATES; at chest depth Barela et al. 2006's adults chose about a
 * third of their speed on land). From the wading threshold (0.15 H) to the
 * knee the cap falls from the walk speed, and it holds at the chest's to the
 * swimming threshold.
 */
export const WADE_CURVE: readonly (readonly [number, number])[] = Object.freeze([
  Object.freeze([PERSON.wadeDepthFraction, PERSON.walkSpeed] as const),
  Object.freeze([0.285, 1.0] as const),
  Object.freeze([0.6, 0.6] as const),
  Object.freeze([0.72, 0.4] as const),
]);

/** Running (high-stepping) in water goes this much faster than the wading walk, never past the run. */
export const WADE_RUN_FACTOR = 1.5;

/** `WADE_CURVE`'s depth fractions and speeds, for the step. */
export const WADE_DEPTHS = Float64Array.from(WADE_CURVE, (point) => point[0]);
export const WADE_SPEEDS = Float64Array.from(WADE_CURVE, (point) => point[1]);

/**
 * The fastest a walker goes in water `depthFraction` of the stature deep,
 * m/s: no cap (Infinity) in water shallower than the wading threshold.
 */
export function wadingSpeedCap(depthFraction: number, running: boolean): number {
  if (!(depthFraction >= WADE_DEPTHS[0]!)) return Infinity;
  const last = WADE_DEPTHS.length - 1;
  let speed = WADE_SPEEDS[last]!;
  for (let i = 0; i < last; i += 1) {
    const d1 = WADE_DEPTHS[i + 1]!;
    if (depthFraction <= d1) {
      const d0 = WADE_DEPTHS[i]!;
      const t = (depthFraction - d0) / (d1 - d0);
      speed = WADE_SPEEDS[i]! + (WADE_SPEEDS[i + 1]! - WADE_SPEEDS[i]!) * t;
      break;
    }
  }
  return running ? Math.min(PERSON.runSpeed, speed * WADE_RUN_FACTOR) : speed;
}

/** What a landing at a speed does: 0 normal, 1 a hard landing's crouch, 2 a roll (never damage: D5). */
export const LandingKind = Object.freeze({ normal: 0, hard: 1, roll: 2 });

export function landingKind(speed: number): number {
  if (speed >= PERSON.landingRollSpeed) return LandingKind.roll;
  if (speed >= PERSON.landingHardSpeed) return LandingKind.hard;
  return LandingKind.normal;
}
