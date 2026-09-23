import {
  EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS,
  TERRAIN_EROSION_PRODUCTION_CONFIG,
} from "../../src/render/webgpu/terrain/TerrainErosionCompute";
import {
  TERRAIN_EROSION_GEOLOGY_BAND_ROWS,
  TERRAIN_EROSION_SEED_BAND_ROWS,
  TERRAIN_EROSION_STAGE_SEED_COST_MS,
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
 * Dispatches per page that may read no positive duration before the page is
 * called a broken instrument. A COUNT alarm, not a cost allowance: an unusable
 * reading means "cost unknown", and `chargedStageMs` charges it at its stage's
 * pinned price, so no cost can hide behind one.
 *
 * Why 2. The failure this was built for dropped exactly one breach reading on
 * timed page 1, identically in six runs over two trees and two checkouts, and
 * only while another process loaded the GPU (Babylon read a slot never written
 * before: docs/findings/BABYLON_PASS_TIMESTAMP_ORDER_2026_09_22.md). Two
 * adjacent passes reading nothing together is the next case, and 2 admits it.
 * It used to bound the cost a page could hide, which held only while every
 * dispatch really was as cheap as its pin; on the fixed instrument one pinned
 * at 0.067 ms read ~6 ms (the breach pit carve,
 * docs/findings/BREACH_PIT_ADMISSION_2026_09_22.md). A cap cannot bound a cost
 * nobody knows, which is why an unknown is now charged instead. A
 * counter that is broken rather than occasionally unreadable reads nothing for
 * all 163 dispatches and still fails.
 */
export const UNUSABLE_READINGS_PER_PAGE_CAP = 2;

/**
 * One stage's cost in a page total: what its priced dispatches measured, plus
 * each unusable dispatch charged at the stage's pinned price. Unknown is not
 * free, and it is not a guess either: it is the price the meter admits it at.
 */
export function chargedStageMs(
  sample: Readonly<TerrainErosionStageMeasurement>,
  stage: ErosionCostStage,
): number {
  return sample.milliseconds + sample.unusable * TERRAIN_EROSION_STAGE_SEED_COST_MS[stage];
}

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
