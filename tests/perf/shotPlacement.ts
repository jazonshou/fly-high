import type { WorldDefinition } from "../../src/world/types";
import { sampleTerrain, sampleTerrainHeight } from "../../src/world";
import { sunDirectionForClock } from "../../src/render/webgpu/nature/EnvironmentDirector";
import { densityField } from "../../src/render/webgpu/detail/densityField";
import {
  PERF_CAPTURE_DEFAULT_CLOCK,
  headingVectorFromYaw,
  locateShotOffset,
  yawForSunBearing,
  type PerfCaptureShotDefinition,
  type ShotPlacement,
} from "../../scripts/perf-capture.mts";

/**
 * Z-3: feature-located shots resolve their offsets from the terrain field,
 * deterministically per seed.
 *
 * Shared by the two harnesses that render the canonical shot list — the
 * capture (`perf-capture.test.ts`) and the cloud A/B agent
 * (`tests/perf/ab/agent.ts`) — so both photograph the same place. It was a
 * closure inside the capture until the A/B agent needed it; the body is
 * unchanged, and it reads the world it is handed, which is the ACTIVE world
 * (analytic or eroded) at call time, exactly as the closure did.
 */
export function resolveShotPlacement(
  world: WorldDefinition,
  shot: PerfCaptureShotDefinition,
): ShotPlacement {
  const airportX = world.airport?.centerX ?? 0;
  const airportZ = world.airport?.centerZ ?? 0;
  const fallback: ShotPlacement = {
    offsetXMeters: shot.offsetXMeters,
    offsetZMeters: shot.offsetZMeters,
  };
  if (!shot.locate || shot.locate === "fixed") return fallback;
  if (shot.locate === "forest") {
    const found = locateShotOffset((x, z) => {
      for (const [dx, dz] of [[0, 0], [250, 0], [-250, 0], [0, 250], [0, -250]] as const) {
        const sample = sampleTerrain(world, airportX + x + dx, airportZ + z + dz);
        if (sample.biomeName !== "forest") return false;
      }
      return true;
    });
    return found ?? fallback;
  }
  if (shot.locate === "grassland") {
    // Open grass with a guaranteed-clear lens: terrain sampling alone
    // cannot see scattered trees/ferns (two blind landings put one across
    // the camera), but the airport clearance culls ALL detail vegetation
    // except ground-cover blades — so the mown surround is the one place
    // a standing-height blade shot is deterministic. Require solid
    // clearance influence, off the runway itself, on flat grassland.
    const found = locateShotOffset((x, z) => {
      for (const [dx, dz] of [[0, 0], [60, 0], [-60, 0], [0, 60], [0, -60]] as const) {
        const sample = sampleTerrain(world, airportX + x + dx, airportZ + z + dz);
        if (sample.biomeName !== "grassland") return false;
        if (sample.slope > 0.08) return false;
        if (sample.isRunway) return false;
        if (sample.airportInfluence < 0.35 || sample.airportInfluence > 0.85) return false;
      }
      return true;
    }, { stepMeters: 120, maxRadiusMeters: 3_000 });
    return found ?? fallback;
  }
  if (shot.locate === "mountain") {
    // A steep high face 400-900 m ahead on the +x heading, with the
    // camera spot itself standable (moderate slope, above water).
    const found = locateShotOffset((x, z) => {
      const here = sampleTerrain(world, airportX + x, airportZ + z);
      if (here.height < world.seaLevel + 5 || here.slope > 0.3) return false;
      let steep = 0;
      for (const ahead of [400, 650, 900] as const) {
        const face = sampleTerrain(world, airportX + x + ahead, airportZ + z);
        if (face.slope > 0.4 && face.height > here.height + 180) steep += 1;
      }
      return steep >= 2;
    }, { stepMeters: 400, maxRadiusMeters: 20_000 });
    return found ?? fallback;
  }
  if (shot.locate === "cliff") {
    // A steep face 120-280 m ahead — close enough that the rock texture
    // fills the frame at material-detail range.
    const found = locateShotOffset((x, z) => {
      const here = sampleTerrain(world, airportX + x, airportZ + z);
      if (here.height < world.seaLevel + 5 || here.slope > 0.3) return false;
      let steep = 0;
      for (const ahead of [120, 200, 280] as const) {
        const face = sampleTerrain(world, airportX + x + ahead, airportZ + z);
        if (face.slope > 0.45 && face.height > here.height + 60) steep += 1;
      }
      return steep >= 2;
    }, { stepMeters: 300, maxRadiusMeters: 20_000 });
    return found ?? fallback;
  }
  if (shot.locate === "canopy-backlit") {
    // `L-4`: closed canopy along the SUN-DERIVED heading, not +x.
    //
    // Two departures from `forest`, both deliberate:
    //
    // 1. **Gated on the vegetation field, not the biome id.** A biome-only
    //    predicate accepts forest with no stems standing in it — exactly
    //    what shipped `horizon-shadow-far-annulus` at 0 stems/m2 on every
    //    annulus sample, a shot that could not fail.
    // 2. **Scanned along this shot's own heading.** With
    //    `relativeSunBearingDegrees: 0` the corridor the camera looks down
    //    is not the corridor a +x predicate checks, and validating the
    //    wrong corridor blesses terrain the capture never frames.
    //
    // The span 0-2,400 m covers the frame's own reach at 400 m AGL /
    // pitch 20 (479-5,278 m measured), so mid, far and beyond-far canopy
    // are all required rather than hoped for.
    const clock = shot.clock ?? PERF_CAPTURE_DEFAULT_CLOCK;
    const heading = headingVectorFromYaw(
      yawForSunBearing(
        sunDirectionForClock(clock, world.latitudeDegrees),
        shot.relativeSunBearingDegrees ?? 0,
      ),
    );
    const found = locateShotOffset((x, z) => {
      for (let ahead = 0; ahead <= 2_400; ahead += 200) {
        const sx = airportX + x + heading.x * ahead;
        const sz = airportZ + z + heading.z * ahead;
        const sample = sampleTerrain(world, sx, sz);
        if (sample.biomeName === "water") return false;
        const field = densityField(world.sourceSeedHash, {
          x: sx,
          z: sz,
          heightMeters: sample.height,
          seaLevelMeters: world.seaLevel,
          slope: sample.slope,
          moisture: sample.moisture,
          normalX: sample.normal.x,
          normalZ: sample.normal.z,
          airportInfluence: sample.airportInfluence,
          dayOfYear: clock.dayOfYear,
          // 0 = the full-bandwidth field, which is what per-stem placement
          // uses; only a page bake passes a width (`4-6b`/D12).
          filterWidthMeters: 0,
        });
        if (field.treeStemsPerSquareMeter < 0.006 || field.heightFactor < 0.35) return false;
      }
      return true;
    }, { stepMeters: 500, maxRadiusMeters: 18_000 });
    return found ?? fallback;
  }
  if (shot.locate === "coast") {
    // Over water with land ~3 km ahead on the +x heading.
    const found = locateShotOffset((x, z) => {
    const here = sampleTerrainHeight(world, airportX + x, airportZ + z);
    if (here > world.seaLevel - 2) return false;
    const ahead = sampleTerrainHeight(world, airportX + x + 3_000, airportZ + z);
    return ahead > world.seaLevel + 5;
    }, { maxRadiusMeters: 20_000 });
    return found ?? fallback;
  }
  // EXHAUSTIVENESS. This was an unlabelled fallthrough, which is worse than
  // it looks: a NEW `locate` value would have silently received the COAST
  // search — open water with land 3 km ahead — and sited itself on a
  // coastline looking entirely plausible. A wrong placement that looks
  // correct is the class this project keeps shipping.
  //
  // It was also invisible to search: the mode's name appears nowhere in
  // this file except a CAPITALISED comment, so `grep -c "coast"` returns an
  // honest zero and reads as "nobody implements this". That false negative
  // was produced, reported and relayed before it was caught.
  const unhandled: never = shot.locate;
  throw new Error(
    `perf-capture: locate mode ${JSON.stringify(unhandled)} is declared on a shot but `
    + "has no branch in resolvePlacement. Add one — the previous fallthrough "
    + "would have silently applied the coast search to it.",
  );
}
