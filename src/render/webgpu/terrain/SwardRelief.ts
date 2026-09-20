/**
 * `D-3` — sward relief: the band of ground detail between the material tile
 * and the vigour patchwork.
 *
 * The owner's complaint was that the ground "still looks blurry and similar to
 * what it looks like from a far distance" however close the camera gets. That
 * was exact. A sward's material tile is 2 m across and its content is blades
 * and tufts under ~10 cm, deliberately flattened below ~0.5 m^-1 so that it
 * cannot show its repeat; the vigour patchwork above it starts at 18 m. From
 * 8 m to a few hundred metres up, the tile has minified to its mean and the
 * patchwork is a soft gradient, and between them there was NOTHING: no term in
 * the shader had a wavelength between 0.2 m and 6 m. Descending from 600 m to
 * 10 m added no information to the frame, which is what "blurry" means.
 *
 * Seen from the air, what fills that band on real grassland is MOTTLE: clumps
 * that dried paler beside clumps that stayed green, over ground that is gently
 * lumpy. Four incommensurate octaves of the ground block's own integer-hashed
 * gradient noise. Each octave's TONE is the noise pushed through a soft edge,
 * so it reads as blotches with outlines rather than as a gradient; its RELIEF
 * is the plain noise at about 2 % of the wavelength, so light agrees with
 * colour without the ground becoming a surface of objects. Pale is tinted
 * toward straw and dark toward green, because that is the axis a sward varies
 * along; a grey multiplier reads as dirt.
 *
 * Shot and dropped on the way (2026-09-20): BILLOWED octaves (rounded tops,
 * sharp hollows) read as rumpled cloth, because a gradient noise's zero set is
 * a network of long meandering lines and a crease drawn along it is a ripple;
 * CELLULAR DOMES (one tussock per jittered cell, a minority of cells) read as
 * raindrop rings on a pond, because a perfect circle with a shaded skirt is
 * the one shape a meadow never shows from above.
 *
 * World-anchored in absolute metres, each octave faded by footprint and not
 * evaluated once it has, zero-mean so the scene mean, the bounce and W-1's
 * calibration do not move. A minification-proof stand-in for geometry the tile
 * cannot carry, not a second texture: no samples, no memory, nothing to tile.
 */
import { groundNoiseGradient } from "./GroundPatchwork";

/** Hummock, clump, tussock, tuft: no two within 15 % of an integer ratio. */
export const SWARD_RELIEF_WAVELENGTHS_METERS: readonly number[] = [4.3, 1.7, 0.71, 0.31];
export const SWARD_RELIEF_ROTATIONS_DEGREES: readonly number[] = [13, -31, 47, -67];
/**
 * Relief per sigma, metres: about 2 % of the wavelength. Shot at 2.5 % first:
 * right at noon, and at an 8 m eye under a 10 degree sun every hollow was a
 * black streak, because a normal offset casts no penumbra to soften itself.
 */
export const SWARD_RELIEF_HEIGHTS_METERS: readonly number[] = [0.085, 0.033, 0.014, 0.006];
/** Tone per octave at the blotch's plateau. */
export const SWARD_RELIEF_TONES: readonly number[] = [0.045, 0.065, 0.065, 0.05];
/** How hard the noise is pushed through its edge: 1 is a gradient, 3 a stencil. */
export const SWARD_RELIEF_EDGE = 1.9;
/** Pale goes toward straw, dark toward green: per-channel share of the tone. */
export const SWARD_RELIEF_TINT: readonly [number, number, number] = [1.15, 0.95, 0.45];
/**
 * The two dials a cost or look review needs, each a single constant: how many
 * octaves are emitted at all (coarsest first), and one gain on tone AND relief.
 * Zero strength is the rollback.
 */
export const SWARD_RELIEF_OCTAVES = 4;
export const SWARD_RELIEF_STRENGTH = 1;
/**
 * Share of the band opened soil keeps. Not zero: a bare opening with none of it
 * is a smooth plastic blob in a mottled field (lush site from 80 m, 2026-09-20).
 */
export const SWARD_RELIEF_BARE_SHARE = 0.45;
/** Rougher and strawier on dry ground, calmer on lush: gain at either end. */
export const SWARD_RELIEF_LUSH_GAIN = 0.8;
export const SWARD_RELIEF_DRY_GAIN = 1.3;

const SALTS = [0xa1, 0xa2, 0xa3, 0xa4] as const;

/** The edge: odd, bounded by one, slope `SWARD_RELIEF_EDGE` at zero. CPU twin. */
export function swardReliefBlotch(noise: number): number {
  const pushed = noise * SWARD_RELIEF_EDGE;
  return pushed / Math.sqrt(1 + pushed * pushed);
}

/** CPU twin of the summed tone at a world point (all octaves resolved). */
export function swardReliefTone(x: number, z: number): number {
  let tone = 0;
  SWARD_RELIEF_WAVELENGTHS_METERS.forEach((wavelength, octave) => {
    const radians = (SWARD_RELIEF_ROTATIONS_DEGREES[octave]! * Math.PI) / 180;
    const u = (x * Math.cos(radians) - z * Math.sin(radians)) / wavelength + 3.1 + octave * 17.3;
    const v = (x * Math.sin(radians) + z * Math.cos(radians)) / wavelength + 9.7 + octave * 5.9;
    tone += swardReliefBlotch(groundNoiseGradient(u, v, SALTS[octave]!)[0])
      * SWARD_RELIEF_TONES[octave]!;
  });
  return tone;
}

function wgslFloat(value: number): string {
  const text = String(Number(value.toPrecision(9)));
  return /[.e]/u.test(text) ? text : `${text}.0`;
}

function octaveWgsl(wavelength: number, octave: number): string {
  const radians = (SWARD_RELIEF_ROTATIONS_DEGREES[octave]! * Math.PI) / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const inverse = 1 / wavelength;
  return `
  {
    let weight = terrainGroundOctaveWeight(${wgslFloat(wavelength)}, footprintMeters);
    if (weight > 0.001) {
      let field = terrainGroundNoiseGrad(
        vec2f(worldXz.x * ${wgslFloat(c)} - worldXz.y * ${wgslFloat(s)},
              worldXz.x * ${wgslFloat(s)} + worldXz.y * ${wgslFloat(c)}) * ${wgslFloat(inverse)}
          + vec2f(${wgslFloat(3.1 + octave * 17.3)}, ${wgslFloat(9.7 + octave * 5.9)}),
        ${SALTS[octave]}u);
      // Back through the rotation (its transpose) and the scaling.
      let along = vec2f(
        field.y * ${wgslFloat(c)} + field.z * ${wgslFloat(s)},
        -field.y * ${wgslFloat(s)} + field.z * ${wgslFloat(c)});
      let pushed = field.x * ${wgslFloat(SWARD_RELIEF_EDGE)};
      relief = relief + vec3f(
        along * ${wgslFloat(SWARD_RELIEF_HEIGHTS_METERS[octave]! * inverse)},
        pushed * inverseSqrt(1.0 + pushed * pushed) * ${wgslFloat(SWARD_RELIEF_TONES[octave]!)}) * weight;
    }
  }`;
}

/**
 * Composed AFTER `TERRAIN_GROUND_PATCHWORK_WGSL`, whose noise and octave fade
 * it reuses. Returns (d height / dx, d height / dz, tone), tone zero-mean.
 */
export const TERRAIN_SWARD_RELIEF_WGSL = /* wgsl */ `
fn terrainSwardReliefAt(worldXz: vec2f, footprintMeters: f32) -> vec3f {
  var relief = vec3f(0.0);
  // The coarsest octave outlives the rest, so once IT has faded the whole band
  // has: from cruise altitude this function is one compare and a return.
  if (terrainGroundOctaveWeight(${wgslFloat(SWARD_RELIEF_WAVELENGTHS_METERS[0]!)}, footprintMeters) <= 0.001) {
    return relief;
  }
${SWARD_RELIEF_WAVELENGTHS_METERS.slice(0, SWARD_RELIEF_OCTAVES).map(octaveWgsl).join("\n")}
  return relief * ${wgslFloat(SWARD_RELIEF_STRENGTH)};
}
`;
