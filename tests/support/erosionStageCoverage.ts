import {
  EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS,
  TERRAIN_EROSION_PRODUCTION_CONFIG,
} from "../../src/render/webgpu/terrain/TerrainErosionCompute";
import {
  TERRAIN_EROSION_GEOLOGY_BAND_ROWS,
  TERRAIN_EROSION_SEED_BAND_ROWS,
  type TERRAIN_EROSION_STAGE_SEED_COST_MS,
  type TerrainErosionStageMeasurement,
} from "../../src/render/webgpu/terrain/TerrainPageErosionGpu";

/**
 * `W-1d`'s per-page non-vacuity check, shared by the GPU cost test and the
 * Node guard that pins its behaviour (`render.webgpu-erosion-stage-coverage`).
 */
export type ErosionCostStage = keyof typeof TERRAIN_EROSION_STAGE_SEED_COST_MS;

/**
 * The complete production DAG, derived from the same geometry/configuration
 * constants as the producer. This is the timing sample's non-vacuity guard:
 * a cheap result with a missing shader is not a fast page.
 */
export const EXPECTED_STAGE_DISPATCHES: Readonly<Record<ErosionCostStage, number>> = Object.freeze({
  seed: EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS / TERRAIN_EROSION_SEED_BAND_ROWS,
  // Erodibility before breach and repose after stream power.
  geology: (EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS
    / TERRAIN_EROSION_GEOLOGY_BAND_ROWS) * 2,
  breachDirect: 1,
  breachPit: 1,
  decode: 1,
  streamPower: TERRAIN_EROSION_PRODUCTION_CONFIG.streamPowerIterations,
  // One gather and one apply per iteration.
  talus: TERRAIN_EROSION_PRODUCTION_CONFIG.talusIterations * 2,
  fineBand: EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS
    / TERRAIN_EROSION_GEOLOGY_BAND_ROWS,
});

/**
 * Dispatches per page that may read no positive duration and still count as
 * present. An unusable reading prices nothing, so the cap is what bounds the
 * cost a page total can be missing.
 *
 * Why 2. The failure this was built for dropped exactly one breach reading on
 * timed page 1, identically in six runs over two trees and two checkouts, and
 * only while another process loaded the GPU. The breach step records both of
 * its passes in one pump, so two adjacent passes reading nothing together is
 * the next case, and 2 admits it. The cost it can hide is at most two of the
 * dearest pinned dispatch (talus, 0.32 ms): 0.64 ms, 1.7 % of the 37.4 ms
 * pinned page the whole-page alarm compares against twice its price. The Node
 * guard holds that bound. A counter that is broken rather than occasionally
 * unreadable reads nothing for all 163 dispatches and still fails.
 */
export const UNUSABLE_READINGS_PER_PAGE_CAP = 2;

/**
 * Everything wrong with one timed page's stage sample, empty when it is
 * complete: every expected dispatch either priced or unusable, time behind
 * every priced one, and no more unusable readings than the cap.
 */
export function erosionStageCoverageFaults(
  samples: Readonly<Record<ErosionCostStage, Readonly<TerrainErosionStageMeasurement>>>,
  expected: Readonly<Record<ErosionCostStage, number>> = EXPECTED_STAGE_DISPATCHES,
  cap: number = UNUSABLE_READINGS_PER_PAGE_CAP,
): string[] {
  const faults: string[] = [];
  let unusable = 0;
  for (const stage of Object.keys(expected) as ErosionCostStage[]) {
    const sample = samples[stage];
    if (sample.dispatches + sample.unusable !== expected[stage]) {
      faults.push(
        `did not measure every ${stage} dispatch: ${sample.dispatches} priced + `
        + `${sample.unusable} unusable, expected ${expected[stage]}`,
      );
    }
    if (sample.dispatches > 0 && !(sample.milliseconds > 0)) {
      faults.push(`measured ${stage} dispatches but no GPU time`);
    }
    unusable += sample.unusable;
  }
  if (unusable > cap) {
    faults.push(
      `${unusable} dispatches read no positive duration; at most ${cap} per page are tolerated`,
    );
  }
  return faults;
}
