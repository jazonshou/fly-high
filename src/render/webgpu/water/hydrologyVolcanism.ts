import type { WorldDefinition } from "@/src/world";
import {
  VolcanicSiteKind,
  createVolcanicGroundSample,
  sampleVolcanicGround,
  volcanicSitesInBounds,
  type VolcanicSite,
} from "@/src/world/volcanism";
import type {
  HydrologyAuthoredBasin,
  HydrologyGenerationConfig,
  HydrologyWorldInputs,
} from "./HydrologyGeneration";

/**
 * Volcanic land's water, as the plain inputs `generateHydrology` takes.
 *
 * - CRATER LAKES. Calderas and maars set their floors to a level, and the
 *   site says what level its lake stands at (`lakeLevelMeters`, NaN for a
 *   crater kept dry). Each one is an authored basin: hydrology shores it on
 *   the region's sampler and the river tracer makes no lake inside its rim.
 * - POROUS GROUND. Fresh cinder and young lava swallow the rain, so no
 *   stream rises on them; an old flank has weathered to soil and keeps its
 *   streams.
 *
 * One definition for both paths that generate a region: the hydrology
 * worker, from its own world, and the renderer's main-thread fallback. Inside
 * the landform core there are no sites, so this returns no inputs at all and
 * generation there is the shipped arithmetic, bit for bit. Class P: no
 * Babylon, no DOM.
 */

/** Cover above which young ground is porous. */
export const VOLCANIC_POROUS_COVER = 0.5;
/** Ground this old (0 fresh .. 1 old) has weathered to soil and keeps its streams. */
export const VOLCANIC_POROUS_AGE = 0.6;

const NO_INPUTS: HydrologyWorldInputs = Object.freeze({});
const SITES: VolcanicSite[] = [];
const GROUND = createVolcanicGroundSample();

/** Does fresh cinder or young lava at (x, z) swallow the rain a stream would rise from? */
export function volcanicGroundIsPorous(world: WorldDefinition, x: number, z: number): boolean {
  const ground = sampleVolcanicGround(world, x, z, 0, GROUND);
  return ground.age < VOLCANIC_POROUS_AGE
    && (ground.lavaCover > VOLCANIC_POROUS_COVER || ground.tephraCover > VOLCANIC_POROUS_COVER);
}

/** A crater's lowest ground: the level its floor is set to (`calderaHeight`, `maarHeight`). */
function craterFloor(site: VolcanicSite): number {
  return site.kind === VolcanicSiteKind.Caldera
    ? site.baseLevelMeters + site.heightMeters - site.craterDepthMeters
    : site.baseLevelMeters - site.craterDepthMeters;
}

/**
 * The farthest a crater's rim crest can stand from its centre: `calderaHeight`
 * and `maarHeight` wobble the rim by 6 % and 8 % of `radiusMeters` with an
 * outline noise in [-1, 1]. The shore march starts here, so it starts outside
 * the crest on every ray and the crest is what it meets first.
 */
function craterRimReach(site: VolcanicSite): number {
  return site.radiusMeters * (site.kind === VolcanicSiteKind.Caldera ? 1.06 : 1.08);
}

/**
 * The volcanic inputs for the region `config` describes: every caldera and
 * maar whose rim comes within `maximumLakeRadiusMeters` of the region (the
 * contract `HydrologyGenerationOptions.authoredBasins` asks for), and the
 * porous-ground test when any site reaches the sources' trace halo.
 */
export function volcanicHydrologyInputs(
  world: WorldDefinition,
  config: HydrologyGenerationConfig,
): HydrologyWorldInputs {
  const half = config.extentMeters * 0.5;
  // Sources are drawn from the trace halo round the region, so any site that
  // reaches it can put porous ground under one.
  const halo = half + config.traceStepMeters * config.maximumTraceSteps;
  volcanicSitesInBounds(
    world,
    config.centerX - halo,
    config.centerZ - halo,
    config.centerX + halo,
    config.centerZ + halo,
    SITES,
  );
  if (SITES.length === 0) return NO_INPUTS;
  let basins: HydrologyAuthoredBasin[] | null = null;
  for (const site of SITES) {
    if (site.kind !== VolcanicSiteKind.Caldera && site.kind !== VolcanicSiteKind.Maar) continue;
    // A caldera's lake stands on its wall, between the floor
    // (`craterRadiusMeters`) and the rim; a maar's in its bowl.
    const rim = craterRimReach(site);
    const outsideX = Math.max(Math.abs(site.x - config.centerX) - half, 0);
    const outsideZ = Math.max(Math.abs(site.z - config.centerZ) - half, 0);
    const reach = rim + config.maximumLakeRadiusMeters;
    if (outsideX * outsideX + outsideZ * outsideZ >= reach * reach) continue;
    (basins ??= []).push(Object.freeze({
      id: `volcanic:${site.id}`,
      centerX: site.x,
      centerZ: site.z,
      levelMeters: site.lakeLevelMeters,
      floorMeters: craterFloor(site),
      rimRadiusMeters: rim,
    }));
  }
  SITES.length = 0;
  const sourceExcluded = (x: number, z: number): boolean => volcanicGroundIsPorous(world, x, z);
  return basins ? { authoredBasins: Object.freeze(basins), sourceExcluded } : { sourceExcluded };
}
