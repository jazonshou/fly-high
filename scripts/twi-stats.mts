/**
 * W-9 (Phase 6, Gate W): TWI distribution over real eroded L0 pages, the
 * measurement that re-windows `TERRAIN_TWI_DRY`/`TERRAIN_TWI_WET` against
 * real eroded flow statistics (RESOLUTION_PLAN A-3, register row C-11).
 * Also the seed of W-7's statistics instruments — it builds the full macro
 * export and a spread of production-shape pages.
 *
 * Run with tsx (never vitest — the SSR transform is ~4.5x slower):
 *
 *   npx tsx scripts/twi-stats.mts [seed]
 */
import {
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
} from "../src/render/webgpu/terrain/TerrainEvolutionContract";
import {
  evolveMacroTerrain,
  toTerrainMacroEvolutionExport,
} from "../src/render/webgpu/terrain/TerrainMacroEvolution";
import {
  TERRAIN_TWI_SLOPE_EPSILON,
  buildTerrainMacroLakeField,
  terrainTopographicWetnessIndex,
} from "../src/render/webgpu/terrain/TerrainPageHydrology";
import { generateTerrainErodedPage } from "../src/render/webgpu/terrain/TerrainPageErosion";
import { sampleTerrainMacroEvolutionInputs } from "../src/workers/terrainMacroEvolutionRuntime";
import { createWorld } from "../src/world";

const seed = Number.parseInt(process.argv[2] ?? "333438", 10) >>> 0;
const world = createWorld(seed, { worldEvolution: "eroded" });
const domain = EVOLUTION_DOMAIN_TEXELS;

const inputs = sampleTerrainMacroEvolutionInputs({
  width: domain,
  height: domain,
  minWorldX: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX,
  minWorldZ: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ,
  texelSizeMeters: EVOLUTION_TEXEL_METERS,
  seedHash: world.seedHash,
});
const result = evolveMacroTerrain({
  width: domain,
  height: domain,
  heights: inputs.heights,
  texelSizeMeters: EVOLUTION_TEXEL_METERS,
  seaLevel: world.seaLevel,
  erodibility: inputs.erodibility,
  reposeDegrees: inputs.reposeDegrees,
});
const macro = toTerrainMacroEvolutionExport(result, world.seaLevel, {
  worldSeed: world.seed,
  deviceFingerprint: "twi-stats",
});
const lakes = buildTerrainMacroLakeField(macro);

// Pages across the three flow regimes (valley floor / mid-slope / ridge) so
// the window sees the full distribution, not just whichever regime dominates
// by area. Deterministic scan, domain interior only.
const picks: { x: number; z: number; label: string }[] = [];
for (let tz = 128; tz < domain - 128 && picks.length < 24; tz += 37) {
  for (let tx = 128; tx < domain - 128 && picks.length < 24; tx += 41) {
    const cell = tz * domain + tx;
    if (macro.heightMeters[cell]! <= world.seaLevel) continue;
    const flow = macro.flowAccumulationAreaM2[cell]!;
    const label = flow > 5e7 ? "valley" : flow > 1e6 ? "slope" : "ridge";
    if (picks.filter((p) => p.label === label).length >= 8) continue;
    const wx = TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX + (tx + 0.5) * EVOLUTION_TEXEL_METERS;
    const wz = TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ + (tz + 0.5) * EVOLUTION_TEXEL_METERS;
    picks.push({ x: Math.floor(wx / 512), z: Math.floor(wz / 512), label });
  }
}
console.log(`seed ${seed}: ${picks.length} pages (${picks.map((p) => p.label).join(",")})`);

// The physical TWI at channel-texel scale, rebuilt from the page product the
// same way the runtime classifier consumes it: decoded log-flow area plus a
// central-difference slope over the stored heights.
const CHANNEL_EDGE = 136;
const HEIGHT_EDGE = 264;
const twis: number[] = [];
for (const pick of picks) {
  const page = generateTerrainErodedPage(world, macro, { level: 0, x: pick.x, z: pick.z }, lakes);
  if (!page.hydrology) continue;
  const quantized = page.hydrology.hydrology;
  const flow = quantized.flowAccum;
  const bias = quantized.flowAccumLog2Bias;
  const perUnit = quantized.flowAccumLog2PerUnit;
  for (let cz = 1; cz < CHANNEL_EDGE - 1; cz += 1) {
    for (let cx = 1; cx < CHANNEL_EDGE - 1; cx += 1) {
      const areaM2 = Math.max(0, Math.pow(2, bias + flow[cz * CHANNEL_EDGE + cx]! * perUnit) - 1);
      const heightAt = (hx: number, hz: number) =>
        page.storedHeight[Math.min(HEIGHT_EDGE - 1, hz * 2) * HEIGHT_EDGE + Math.min(HEIGHT_EDGE - 1, hx * 2)]!;
      const texelMeters = 4;
      const dx = (heightAt(cx + 1, cz) - heightAt(cx - 1, cz)) / (2 * texelMeters);
      const dz = (heightAt(cx, cz + 1) - heightAt(cx, cz - 1)) / (2 * texelMeters);
      const slope = Math.atan(Math.hypot(dx, dz));
      twis.push(terrainTopographicWetnessIndex(areaM2, slope, TERRAIN_TWI_SLOPE_EPSILON));
    }
  }
}
twis.sort((a, b) => a - b);
const q = (p: number) => twis[Math.min(twis.length - 1, Math.floor(p * twis.length))]!;
console.log(`samples ${twis.length}`);
for (const p of [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 0.999]) {
  console.log(`p${(p * 100).toFixed(1).padStart(5)}  TWI ${q(p).toFixed(2)}`);
}
const below = (t: number) => (twis.filter((v) => v < t).length / twis.length) * 100;
console.log(`current window [4, 18] covers p${below(4).toFixed(1)} .. p${below(18).toFixed(1)}`);
