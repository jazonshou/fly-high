import { ridgedFbm2D, smoothstep, valueNoise2D } from "./noise";
import { mixSeed } from "./seed";

/**
 * Adds the short-wavelength relief that broad continental and mountain fields
 * cannot provide on their own. Inputs are the already-computed land/uplift
 * masks, keeping this addition bounded and preserving open lowland.
 *
 * `filterWidthMeters` follows the coordinates by the shared kernel convention
 * (see sampleNaturalTerrainHeight). It is a required no-op until 1B-2 lands
 * band-limiting; 0 means the full-bandwidth field.
 */
export function sampleGeologicalRelief(
  seedHash: number,
  x: number,
  z: number,
  filterWidthMeters: number,
  land: number,
  foothillRegion: number,
  mountainRegion: number,
): number {
  if (!Number.isFinite(filterWidthMeters) || filterWidthMeters < 0) {
    throw new RangeError("filterWidthMeters must be finite and non-negative");
  }
  if (land <= 0.0001) return 0;

  // Subtle metre-scale undulation prevents plains from becoming mathematically
  // smooth while remaining gentle enough for off-airport ground contact.
  const groundNoise = valueNoise2D(mixSeed(seedHash, 141), x / 105, z / 105);
  const groundRoughness =
    groundNoise * land * (1.7 + foothillRegion * 7.5 + mountainRegion * 5.5);

  // The render grid previously had no geometric energy between roughly 100 m
  // geological noise and sub-metre shader normals. A restrained 35--70 m band
  // gives low flight and taxi views real undulation while remaining gentle
  // enough for off-airport contact. Airport flattening is applied after this
  // shared natural-height kernel, so paved starts stay physically level.
  const soilUndulation = valueNoise2D(
    mixSeed(seedHash, 144),
    x / 43,
    z / 43,
  );
  const smallRelief = soilUndulation * land *
    (0.7 + foothillRegion * 1.8 + mountainRegion * 1.2);

  // An anisotropic ridge field creates elongated rock ribs rather than round
  // noise bumps. Three octaves reach down to roughly 100 m, matching the near
  // render grid while still contributing broken silhouettes to the mid LOD.
  const rotatedX = x * 0.819 + z * 0.574;
  const rotatedZ = -x * 0.574 + z * 0.819;
  const fractureRidges = ridgedFbm2D(
    mixSeed(seedHash, 142),
    rotatedX / 390,
    rotatedZ / 980,
    3,
  );
  const fractureVariation = valueNoise2D(
    mixSeed(seedHash, 143),
    rotatedX / 155,
    rotatedZ / 240,
  );
  const exposure = smoothstep(0.49, 0.84, fractureRidges);
  const upliftMask = foothillRegion * 0.52 + mountainRegion * 0.78;
  const outcropLift =
    land *
    upliftMask *
    exposure *
    (17 + mountainRegion * 66) *
    (0.82 + fractureVariation * 0.18);

  // The complementary troughs read as gullies and talus channels. They keep
  // the positive ribs from merely inflating the whole mountain mass.
  const ravineSignal = Math.pow(Math.max(0, 1 - fractureRidges), 3.2);
  const ravineCarve =
    land *
    (foothillRegion * 0.32 + mountainRegion * 0.7) *
    ravineSignal *
    (9 + mountainRegion * 48);

  const talusRidges = ridgedFbm2D(
    mixSeed(seedHash, 145),
    rotatedX / 120,
    rotatedZ / 280,
    2,
  );
  const talusMeanRemoved = (talusRidges - 0.58) *
    land * (foothillRegion * 2.8 + mountainRegion * 7.6);

  return groundRoughness + smallRelief + outcropLift - ravineCarve + talusMeanRemoved;
}
