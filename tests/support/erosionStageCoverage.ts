import {
  EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS,
  TERRAIN_EROSION_PRODUCTION_CONFIG,
} from "../../src/render/webgpu/terrain/TerrainErosionCompute";
import {
  TERRAIN_EROSION_GEOLOGY_BAND_ROWS,
  TERRAIN_EROSION_SEED_BAND_ROWS,
  TERRAIN_EROSION_STAGE_SEED_COST_MS,
  type TerrainErosionStageMeasurement,
  terrainBreachPitChunks,
} from "../../src/render/webgpu/terrain/TerrainPageErosionGpu";

/**
 * `W-1d`'s per-page non-vacuity check, shared by the GPU cost test and the
 * Node guard that pins its behaviour (`render.webgpu-erosion-stage-coverage`).
 */
export type ErosionCostStage = keyof typeof TERRAIN_EROSION_STAGE_SEED_COST_MS;

/**
 * The complete production DAG for a page with `pits` listed breach pits,
 * derived from the same geometry/configuration constants as the producer. This
 * is the timing sample's non-vacuity guard: a cheap result with a missing
 * shader is not a fast page. Every stage is fixed but the pit carve, which
 * runs one chunk per `BREACH_PIT_CHUNK_PITS` pits.
 */
export function expectedStageDispatches(pits: number): Readonly<Record<ErosionCostStage, number>> {
  return Object.freeze({
    seed: EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS / TERRAIN_EROSION_SEED_BAND_ROWS,
    // Erodibility before breach and repose after stream power.
    geology: (EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS
      / TERRAIN_EROSION_GEOLOGY_BAND_ROWS) * 2,
    breachDirect: 1,
    // Each chunk's dispatch size, written from the pit count the direct pass kept.
    breachArgs: 1,
    // One indirect dispatch per chunk of the list.
    breachPit: terrainBreachPitChunks(pits),
    decode: 1,
    streamPower: TERRAIN_EROSION_PRODUCTION_CONFIG.streamPowerIterations,
    // One gather and one apply per iteration.
    talus: TERRAIN_EROSION_PRODUCTION_CONFIG.talusIterations * 2,
    fineBand: EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS
      / TERRAIN_EROSION_GEOLOGY_BAND_ROWS,
  });
}

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
 * every dispatch of the page and still fails.
 */
export const UNUSABLE_READINGS_PER_PAGE_CAP = 2;

/**
 * Stale readings are the deferred timing's own failure: a pass whose
 * timestamp pair came back exactly as the previous resolve left it, never
 * rewritten (docs/findings/BREACH_PIT_ADMISSION_2026_09_22.md, open item 5).
 * On the reference host a whole frame goes stale now and then, and the cost
 * test pumps four dispatches a frame, so one stale frame alone is past
 * `UNUSABLE_READINGS_PER_PAGE_CAP`. They are tolerated apart from that
 * allowance, up to this share of the page's dispatches. Past it the counter is
 * not being written at all, and a page that measured next to nothing must not
 * pass for one that measured everything.
 */
export const STALE_READINGS_PER_PAGE_SHARE = 0.25;

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
 * every priced one, no more unusable readings than the cap besides those the
 * deferred timing found stale, and no more stale ones than a quarter of the
 * page.
 */
export function erosionStageCoverageFaults(
  samples: Readonly<Record<ErosionCostStage, Readonly<TerrainErosionStageMeasurement>>>,
  expected: Readonly<Record<ErosionCostStage, number>>,
  cap: number = UNUSABLE_READINGS_PER_PAGE_CAP,
): string[] {
  const faults: string[] = [];
  let unusable = 0;
  let stale = 0;
  let total = 0;
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
    stale += Math.min(sample.stale, sample.unusable);
    total += expected[stage];
  }
  if (unusable - stale > cap) {
    faults.push(stale > 0
      ? `${unusable - stale} dispatches read no positive duration besides ${stale} the timing found stale; `
        + `at most ${cap} per page are tolerated`
      : `${unusable} dispatches read no positive duration; at most ${cap} per page are tolerated`);
  }
  if (stale > total * STALE_READINGS_PER_PAGE_SHARE) {
    faults.push(
      `${stale} of ${total} dispatches read stale timestamps; past a quarter of the page, `
      + "the counter is not being written",
    );
  }
  return faults;
}
