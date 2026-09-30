/**
 * CDLOD selection with the renderer's REAL residency lookup, old against new.
 *
 * `cdlod-selection-benchmark.mts` prices the selector with cheap closures. In
 * the game, `TerrainClipmapSystem` answers every candidate's deviation and
 * height range from the height atlas's residency, and until P5-C each answer
 * built a page-key string and a slot-key string and did a string-keyed Map
 * lookup. This drives the real selector through a real `TerrainAtlasResidency`
 * holding ~the tier's resident pages around a cruise path, and times:
 *   legacy  residency.get(invariantSlotKey(address)) + resident check
 *   index   createResidentInvariantPageLookup(residency), built every frame
 * and checks the two select identical nodes on every frame.
 *
 * Usage: tsx scripts/cdlod-lookup-benchmark.mts [tier] [frames]
 */
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  TerrainAtlasResidency,
  createResidentInvariantPageLookup,
  invariantSlotKey,
} from "../src/render/webgpu/terrain/TerrainPageAtlas";
import { selectTerrainNodes, type TerrainNode } from "../src/render/webgpu/terrain/TerrainQuadtree";
import { createWorldPageAddress, type WorldPageAddress } from "../src/render/webgpu/world/pageKey";

const [tierArg, framesArg] = process.argv.slice(2);
const pairs = [["low", "performance"], ["medium", "balanced"], ["high", "balanced"], ["high", "ultra"]] as const;
const [quality, mode] = pairs[Number(tierArg ?? 0)]!;
const profile = resolveWebGpuQualityProfile(quality, mode);
const frames = Number(framesArg ?? 600);
const PIXELS_PER_METER = 1_080 / (2 * Math.tan((60 * Math.PI) / 360));

// Fill the atlas as in flight: pages at every level around the path, until
// the tier's slot count is used. Deviation doubles per level, so the budget
// binds (224/224 at tier 0, as the baseline measured).
const atlas = new TerrainAtlasResidency(profile.heightAtlasSlots, {
  worldRevision: "lookup-benchmark",
  slotByteLength: 264 * 264 * 4,
});
atlas.beginFrame(1);
let admitted = 0;
outer: for (let level = 9; level >= profile.finestResidentLevel; level -= 1) {
  const reach = level >= 6 ? 3 : 2;
  const extent = 512 * 2 ** level;
  const cx = Math.floor(1_800 / extent);
  const cz = Math.floor(-400 / extent);
  for (let dx = -reach; dx <= reach; dx += 1) {
    for (let dz = -reach; dz <= reach; dz += 1) {
      if (admitted >= profile.heightAtlasSlots) break outer;
      const address = createWorldPageAddress(level, cx + dx, cz + dz);
      const request = atlas.request(invariantSlotKey(address), address);
      if (!request?.token) continue;
      atlas.complete(request.slot.key, request.token, {
        minHeightMeters: 40, maxHeightMeters: 300, maxDeviationFromParent: 2.2 * 2 ** level,
      });
      admitted += 1;
    }
  }
}

function select(x: number, z: number, lookup: (a: WorldPageAddress) => { stats: { maxDeviationFromParent: number; minHeightMeters: number; maxHeightMeters: number } } | undefined): TerrainNode[] {
  return selectTerrainNodes({
    cameraX: x, cameraY: 914, cameraZ: z,
    pixelsPerMeterAtUnitDistance: PIXELS_PER_METER,
    pixelThreshold: profile.cdlodPixelThreshold,
    nodeBudget: profile.cdlodNodeBudget,
    finestResidentLevel: profile.finestResidentLevel,
    coarsestLevel: 9,
    farPlaneMeters: 45_000,
    deviationFor: (a) => lookup(a)?.stats.maxDeviationFromParent ?? null,
    heightRangeFor: (a) => {
      const slot = lookup(a);
      return slot ? [slot.stats.minHeightMeters, slot.stats.maxHeightMeters] : null;
    },
  });
}

const legacy = (a: WorldPageAddress) => {
  const slot = atlas.get(invariantSlotKey(a));
  return slot && slot.lifecycle.state === "resident" ? slot : undefined;
};

const path = (frame: number) => [1_800 + frame * 1.2, -400 + frame * 0.24] as const;
for (let frame = 0; frame < 150; frame += 1) {
  const [x, z] = path(frame);
  select(x, z, legacy);
  select(x, z, createResidentInvariantPageLookup(atlas));
}

let legacyMs = 0;
let indexMs = 0;
let nodes = 0;
for (let frame = 0; frame < frames; frame += 1) {
  const [x, z] = path(frame);
  const t0 = performance.now();
  const a = select(x, z, legacy);
  const t1 = performance.now();
  const b = select(x, z, createResidentInvariantPageLookup(atlas));
  const t2 = performance.now();
  legacyMs += t1 - t0;
  indexMs += t2 - t1;
  nodes += b.length;
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`frame ${frame}: the two lookups selected different nodes`);
}
console.log(`tier ${profile.tier}: ${admitted} resident pages, ${(nodes / frames).toFixed(0)} nodes/frame, outputs identical on all ${frames} frames`);
console.log(`selection, legacy string lookup:   ${(legacyMs / frames).toFixed(3)} ms/frame at 1x (${(4 * legacyMs / frames).toFixed(2)} ms at 4x)`);
console.log(`selection, per-frame page index:   ${(indexMs / frames).toFixed(3)} ms/frame at 1x (${(4 * indexMs / frames).toFixed(2)} ms at 4x)`);
