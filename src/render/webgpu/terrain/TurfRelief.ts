/**
 * `D-5` — alpine turf at range: more of the meso band on high meadow.
 *
 * The owner's view of the reshaped massifs from 10,000 ft was that the far
 * turf reads "green and flat". Turf there is not bare: fix-pack T1's meso band
 * lays two soft value-noise octaves, 71 m and 23 m, over all ground (normal,
 * tone, hue, roughness), and W-1 gave vegetated ground about twice their
 * slope. What it lacked was AMOUNT: a gain tuned for lowland meadow seen from
 * a few hundred metres reads as flat paint from 2-10 km. This term raises that
 * same band's slope and tone on alpine turf only, so it evaluates no noise of
 * its own.
 *
 * Built and dropped first (2026-09-22, same gate, one tree): two billowed
 * gradient-noise octaves at 120 m and 45 m, calibrated to the microrelief of
 * real alpine meadow (2.9 degrees RMS slope). They cost 6.0 % on
 * high-10000ft-down at 2560 x 1440 and did not read: under that shot's 67.6
 * degree sun the near-field contrast moved 11.82 -> 12.08 at three times the
 * physical amplitude, at an 18.5 h sun the massif's own cast shadows take most
 * of the turf and the lit patches did not change, and they only read at six
 * times physical (~17 degrees RMS, not physical, same cost). This gain at 2x
 * moves the same contrast to 13.00 at -0.6 % (noise). See
 * docs/findings/GROUND_NEAR_FIELD_D.md section 6.
 *
 * The gate is where the work of this file is. Sward only (grass, dry grass,
 * heath: the seam feather's own bar on `groundCoverOf`), read off what the
 * fragment DRAWS — the layer blend weights, re-targeted by the seam feather on
 * an untrusted page exactly as the layers are, so a scree or snow primary with
 * a sward secondary gets none — times the airfield exclusion, times one minus
 * the canopy closure the vegetation system draws (beyond the trusted pages the
 * fallback cannot name forest floor, and an upper forest belt in a cool climate
 * classifies as turf), times the classifier's own alpine ramp, times gentle
 * ground ending where the classifier's `steep` begins, times a fade-in with
 * range where D-3's band has handed over, times W-1's tier switch (Low pays
 * nothing).
 */
import { groundCoverOf } from "./GroundPatchwork";
import { SURFACE_MATERIAL_COUNT } from "./surfaceMaterials";

/**
 * THE dial: EXTRA meso gain on alpine turf. The band's slope and tone are
 * multiplied by `1 + strength x gate` there: 1 doubles them (the owner's
 * choice A), 2 triples them (B, darker and blotchier: -1.6/255 of mean
 * luminance on high-10000ft-down), and 0 folds the term out of the shader.
 */
export const TURF_RELIEF_STRENGTH = 1;
/** The classifier's own alpine ramp (`alpine = smoothstep(420, 980, elevation)`). */
export const TURF_RELIEF_ALPINE_LOW_METERS = 420;
export const TURF_RELIEF_ALPINE_HIGH_METERS = 980;
/**
 * Slope (`1 - |n.y|`) over which turf gives way: 33 to 40 degrees, ending where
 * the classifier's `steep` begins, so the gain never reaches ground the
 * classifier would call rock.
 */
export const TURF_RELIEF_GENTLE_LOW = 0.16;
export const TURF_RELIEF_GENTLE_HIGH = 0.24;
/**
 * Footprint over which the gain fades IN, metres. D-3's coarsest octave (4.3 m)
 * fades out over 0.54-1.46 m under the ground block's octave-weight law, so the
 * two hand over rather than stack; at 1280 x 720 through the flight lens this
 * is roughly 0.6-2 km of slant range (twice that at 2560 x 1440). Nearer, the
 * meso band keeps the amount the lowland tuning gave it.
 */
export const TURF_RELIEF_RANGE_LOW_METERS = 0.6;
export const TURF_RELIEF_RANGE_HIGH_METERS = 2;
/**
 * What counts as sward: the same threshold the seam feather uses on
 * `groundCoverOf`. Grass, dry grass and heath pass; forest floor (0.55) and
 * scree (0.15) do not, and rock, snow, sand and pavement are zero.
 */
export const TURF_RELIEF_SWARD_COVER_MINIMUM = 0.9;

/** 1 for a material the gain may act on, 0 otherwise. CPU twin of the WGSL. */
export function turfReliefShareOf(materialIndex: number): number {
  return groundCoverOf(materialIndex)[0] >= TURF_RELIEF_SWARD_COVER_MINIMUM ? 1 : 0;
}

function wgslFloat(value: number): string {
  const text = String(Number(value.toPrecision(9)));
  return /[.e]/u.test(text) ? text : `${text}.0`;
}

const SHARE_WGSL = Array.from({ length: SURFACE_MATERIAL_COUNT }, (_, id) => id)
  .filter((id) => turfReliefShareOf(id) > 0)
  .map((id) => `  if (materialIndex == ${id}) { return 1.0; }`)
  .join("\n");

/** Composed with the fragment's other helpers; the share lines call it. */
export const TERRAIN_TURF_RELIEF_WGSL = /* wgsl */ `
fn terrainTurfShareOf(materialIndex: i32) -> f32 {
${SHARE_WGSL}
  return 0.0;
}
`;

/**
 * The gain's declaration, spliced into the meso block before the band's slope
 * is formed. Reads `terrainTurfCover` (the sward share of what is drawn, see
 * the module comment), the canopy closure and the tier switch, all declared
 * above the meso block. Empty at strength 0.
 */
export function terrainTurfMesoGainWgsl(strength: number = TURF_RELIEF_STRENGTH): string {
  if (!(strength > 0)) {
    return "";
  }
  return `
  // D-5 (TurfRelief.ts): more of this band on alpine turf, seen from range.
  let terrainTurfMesoGain = 1.0 + ${wgslFloat(strength)} * terrainTurfCover
    * (1.0 - terrainGroundAirfield)
    * (1.0 - clamp(terrainGroundCanopyClosure, 0.0, 1.0))
    * smoothstep(${wgslFloat(TURF_RELIEF_ALPINE_LOW_METERS)}, ${wgslFloat(TURF_RELIEF_ALPINE_HIGH_METERS)},
      terrainElevationDriver)
    * (1.0 - smoothstep(${wgslFloat(TURF_RELIEF_GENTLE_LOW)}, ${wgslFloat(TURF_RELIEF_GENTLE_HIGH)}, terrainSlope))
    * smoothstep(${wgslFloat(TURF_RELIEF_RANGE_LOW_METERS)}, ${wgslFloat(TURF_RELIEF_RANGE_HIGH_METERS)},
      terrainFootprint3D)
    * terrainGroundPatchworkOn;`;
}

/** The factor the band's slope and tone are multiplied by. Empty at strength 0. */
export function terrainTurfMesoGainTerm(strength: number = TURF_RELIEF_STRENGTH): string {
  return strength > 0 ? " * terrainTurfMesoGain" : "";
}
