/**
 * The per-frame CDLOD selection, timed in Node on the tier's real inputs.
 *
 * The 4x-throttle baseline (docs/findings/LOW_TIER_THROTTLE_BASELINE_2026_09_29.md)
 * put `TerrainClipmapSystem.update` at 24% of the throttled main thread, most
 * of it `selectTerrainNodes` and `resolveTerrainResidentCornerMorphs`, re-run
 * from the root ring every frame. This measures those two functions alone,
 * on a camera path, so a proposed change can be priced AND checked for
 * bit-identical output before it goes near the capture rig.
 *
 * Deviation per level follows the clipmap test's measured-everywhere fixture
 * (0.135 m x 2^level) times DEVIATION_SCALE, chosen so the selection
 * terminates on the budget as it does in flight.
 * Usage: [DEVIATION_SCALE=16] tsx scripts/cdlod-selection-benchmark.mts [tier] [frames]
 */
import {
  resolveTerrainResidentCornerMorphs,
  selectTerrainNodes,
  type TerrainNode,
} from "../src/render/webgpu/terrain/TerrainQuadtree";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";

const [tierArg, framesArg] = process.argv.slice(2);
const tierPairs = [
  ["low", "performance"], ["medium", "balanced"], ["high", "balanced"], ["high", "ultra"],
] as const;
const [quality, mode] = tierPairs[Number(tierArg ?? 0)]!;
const profile = resolveWebGpuQualityProfile(quality, mode);
const frames = Number(framesArg ?? 600);
/**
 * Multiplier on the fixture deviation. At 1 the selection stops on the pixel
 * threshold with ~72 nodes; in flight it stops on the BUDGET (the baseline's
 * diagnostics read 224 of 224 at tier 0), so the benchmark defaults to a scale
 * that makes the budget bind the same way.
 */
const DEVIATION_SCALE = Number(process.env.DEVIATION_SCALE ?? "16");

// Same constants TerrainClipmapSystem passes (TerrainClipmapSystem.ts:321, :332).
const PIXELS_PER_METER = 1_080 / (2 * Math.tan((60 * Math.PI) / 360));
const COARSEST_LEVEL = 9;

function selectAt(x: number, y: number, z: number): TerrainNode[] {
  return selectTerrainNodes({
    cameraX: x,
    cameraY: y,
    cameraZ: z,
    pixelsPerMeterAtUnitDistance: PIXELS_PER_METER,
    pixelThreshold: profile.cdlodPixelThreshold,
    nodeBudget: profile.cdlodNodeBudget,
    finestResidentLevel: profile.finestResidentLevel,
    coarsestLevel: COARSEST_LEVEL,
    farPlaneMeters: 45_000,
    deviationFor: (address) => DEVIATION_SCALE * 0.135 * 2 ** address.level,
    heightRangeFor: () => [0, 300],
  });
}

/** A cruise at 3,000 ft and 60 m/s, one frame per 1/50 s (the 4x frame rate). */
function cameraAt(frame: number): [number, number, number] {
  const t = frame / 50;
  return [t * 60, 914, t * 12];
}

const slotFor = () => 0;
// Warm the JIT on a separate path so the timed loop is steady state.
for (let frame = 0; frame < 200; frame += 1) {
  const [x, y, z] = cameraAt(frame + 10_000);
  resolveTerrainResidentCornerMorphs(selectAt(x, y, z), slotFor);
}

let selectMs = 0;
let cornersMs = 0;
let nodeCount = 0;
const levelHistogram = new Map<number, number>();
for (let frame = 0; frame < frames; frame += 1) {
  const [x, y, z] = cameraAt(frame);
  const t0 = performance.now();
  const nodes = selectAt(x, y, z);
  const t1 = performance.now();
  resolveTerrainResidentCornerMorphs(nodes, slotFor);
  const t2 = performance.now();
  selectMs += t1 - t0;
  cornersMs += t2 - t1;
  nodeCount += nodes.length;
  if (frame === 0) for (const node of nodes) levelHistogram.set(node.level, (levelHistogram.get(node.level) ?? 0) + 1);
}

console.log(`deviation scale ${DEVIATION_SCALE}; tier ${profile.tier} (${quality}/${mode}): budget ${profile.cdlodNodeBudget}, threshold ${profile.cdlodPixelThreshold} px, finest L${profile.finestResidentLevel}`);
console.log(`nodes per frame: ${(nodeCount / frames).toFixed(1)}; levels at frame 0: ${[...levelHistogram].sort((a, b) => a[0] - b[0]).map(([l, n]) => `L${l}x${n}`).join(" ")}`);
console.log(`selectTerrainNodes:                 ${(selectMs / frames).toFixed(3)} ms/frame at 1x (${(4 * selectMs / frames).toFixed(2)} ms at 4x)`);
console.log(`resolveTerrainResidentCornerMorphs: ${(cornersMs / frames).toFixed(3)} ms/frame at 1x (${(4 * cornersMs / frames).toFixed(2)} ms at 4x)`);
