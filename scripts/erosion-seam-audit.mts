/**
 * W-8 (Phase 6, Gate W, register C-10): the composed-reach seam audit.
 *
 * The single-operator reach theorem (max(16,24,32)=32 < halo 64) does not
 * cover the composed DAG: breach -> MFD -> stream power -> talus can move
 * information 16+24+32 = 72 texels, 8 beyond the halo. Whether that breach
 * is REAL on production content is an empirical question this script
 * answers: generate adjacent production L0/L1 pages across flow regimes and
 * compare their stored overlap bands (the 8 shared columns/rows of
 * core+gutter) for IEEE-754 bit equality — the same invariant assertion 90
 * checks on synthetic 8-texel fixtures, at production scale on real terrain.
 *
 * Run with tsx: npx tsx scripts/erosion-seam-audit.mts [seed]
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
import { buildTerrainMacroLakeField } from "../src/render/webgpu/terrain/TerrainPageHydrology";
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
const macro = toTerrainMacroEvolutionExport(
  evolveMacroTerrain({
    width: domain,
    height: domain,
    heights: inputs.heights,
    texelSizeMeters: EVOLUTION_TEXEL_METERS,
    seaLevel: world.seaLevel,
    erodibility: inputs.erodibility,
    reposeDegrees: inputs.reposeDegrees,
  }),
  world.seaLevel,
  { worldSeed: world.seed, deviceFingerprint: "seam-audit" },
);
const lakes = buildTerrainMacroLakeField(macro);

// Pick pair anchors across flow regimes, like twi-stats.
const anchors: { x: number; z: number; label: string }[] = [];
for (let tz = 160; tz < domain - 160 && anchors.length < 9; tz += 61) {
  for (let tx = 160; tx < domain - 160 && anchors.length < 9; tx += 53) {
    const cell = tz * domain + tx;
    if (macro.heightMeters[cell]! <= world.seaLevel) continue;
    const flow = macro.flowAccumulationAreaM2[cell]!;
    const label = flow > 5e7 ? "valley" : flow > 1e6 ? "slope" : "ridge";
    if (anchors.filter((p) => p.label === label).length >= 3) continue;
    const wx = TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX + (tx + 0.5) * EVOLUTION_TEXEL_METERS;
    const wz = TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ + (tz + 0.5) * EVOLUTION_TEXEL_METERS;
    anchors.push({ x: Math.floor(wx / 512), z: Math.floor(wz / 512), label });
  }
}

const STORED_EDGE = 264;
const GUTTER = 4;
const CORE = 256;

/**
 * Compare the shared stored columns of horizontally adjacent pages (or rows
 * for vertical). Page (x) stores world texel columns [CORE*x-GUTTER,
 * CORE*x+CORE+GUTTER); pages x and x+1 share 2*GUTTER columns.
 */
function compareOverlap(
  a: Float32Array,
  b: Float32Array,
  vertical: boolean,
): { compared: number; mismatches: number; maxAbsDelta: number } {
  let compared = 0;
  let mismatches = 0;
  let maxAbsDelta = 0;
  const aBits = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const bBits = new Uint32Array(b.buffer, b.byteOffset, b.length);
  // Shared band: world texel coords [CORE-GUTTER, CORE+GUTTER) of page A are
  // coords [-GUTTER, GUTTER) of page B. In stored space (core coord + GUTTER):
  // A's stored axis index = CORE + s, B's = s, for s in [0, 2*GUTTER).
  for (let s = 0; s < 2 * GUTTER; s += 1) {
    const aAxis = CORE + s;
    const bAxis = s;
    for (let other = 0; other < STORED_EDGE; other += 1) {
      const aIndex = vertical ? aAxis * STORED_EDGE + other : other * STORED_EDGE + aAxis;
      const bIndex = vertical ? bAxis * STORED_EDGE + other : other * STORED_EDGE + bAxis;
      compared += 1;
      if (aBits[aIndex]! !== bBits[bIndex]!) {
        mismatches += 1;
        maxAbsDelta = Math.max(maxAbsDelta, Math.abs(a[aIndex]! - b[bIndex]!));
      }
    }
  }
  return { compared, mismatches, maxAbsDelta };
}

let totalPairs = 0;
let cleanPairs = 0;
for (const level of [0, 1]) {
  for (const anchor of anchors) {
    const scale = Math.pow(2, level);
    const ax = Math.floor(anchor.x / scale);
    const az = Math.floor(anchor.z / scale);
    for (const [dx, dz, vertical] of [[1, 0, false], [0, 1, true]] as const) {
      const a = generateTerrainErodedPage(world, macro, { level, x: ax, z: az }, lakes);
      const b = generateTerrainErodedPage(world, macro, { level, x: ax + dx, z: az + dz }, lakes);
      const cmp = compareOverlap(a.storedHeight, b.storedHeight, vertical);
      totalPairs += 1;
      if (cmp.mismatches === 0) cleanPairs += 1;
      console.log(
        `L${level} ${anchor.label.padEnd(6)} (${ax},${az})->(${ax + dx},${az + dz}) ${vertical ? "vert" : "horz"}: `
        + `${cmp.mismatches}/${cmp.compared} mismatched texels`
        + (cmp.mismatches ? `, max |delta| ${cmp.maxAbsDelta.toExponential(3)} m` : ""),
      );
    }
  }
}
console.log(`\n${cleanPairs}/${totalPairs} pairs bit-exact on the stored overlap`);
if (cleanPairs !== totalPairs) process.exitCode = 1;
