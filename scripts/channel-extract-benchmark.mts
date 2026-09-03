/**
 * W-1e (Phase 6, Gate W): the committed production-shape channel-extraction
 * and hydrology-mesh startup benchmark.
 *
 * W-5 gave graph hydrology real geometry (marching-squares shorelines,
 * arc-length river lanes, ear-clipped + refined lake interiors) and with it a
 * ~1,132 ms `ChannelNetwork.extract` plus a ~770 ms main-thread mesh build.
 * W-1's eroded time-to-ready budget is 1.5 s for the WHOLE path, so those two
 * legs needed a committed harness before anyone optimized them — this is it.
 *
 * Run with tsx, never vitest (the SSR transform runs hot loops ~4.5x slower
 * than the app; see MEMORY vitest-ssr-transform-4x-slower):
 *
 *   npx tsx scripts/channel-extract-benchmark.mts [seed] [repeats]
 *
 * The macro export is built once through the same operators the production
 * worker runs (the scripts/twi-stats.mts recipe), then `extract()` is run
 * `repeats` times with the observational `ChannelExtractionProfile` the
 * extractor accepts, and the per-leg MINIMUM over the repeats is printed —
 * minima, not means, because this host's thermal drift moves wall time ~20%
 * (MEMORY flyhigh-capture-host-thermal). A/B by running the script in both
 * worktrees, interleaved, on the same host.
 *
 * A content fingerprint of the graph and of the built mesh arrays is printed
 * with every run: the W-1e contract is that extraction and meshing get
 * FASTER without changing one bit, so the fingerprints must match across the
 * A and B sides. tests/render.webgpu-hydrology.test.ts carries the committed
 * byte pin for the same products at fixture scale.
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
  ChannelNetwork,
  channelGraphToHydrologyGeometry,
  createChannelExtractionProfile,
  type ChannelExtractionProfile,
} from "../src/render/webgpu/water/ChannelNetwork";
import {
  buildGraphHydrologyMeshArrays,
  type HydrologyMeshArrays,
} from "../src/render/webgpu/water/HydrologySystem";
import { sampleTerrainMacroEvolutionInputs } from "../src/workers/terrainMacroEvolutionRuntime";
import { createWorld } from "../src/world";

const seed = Number.parseInt(process.argv[2] ?? "333438", 10) >>> 0;
const repeats = Math.max(1, Number.parseInt(process.argv[3] ?? "3", 10));
const world = createWorld(seed, { worldEvolution: "eroded" });
const domain = EVOLUTION_DOMAIN_TEXELS;

/** FNV-1a over the raw bytes of every field, order-sensitive. */
function fingerprint(values: Iterable<number>): string {
  const scratch = new Float64Array(1);
  const bytes = new Uint8Array(scratch.buffer);
  let hash = 0x811c9dc5;
  for (const value of values) {
    scratch[0] = value;
    for (let byte = 0; byte < 8; byte += 1) {
      hash = Math.imul(hash ^ bytes[byte]!, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, "0");
}

function* graphValues(graph: ReturnType<ChannelNetwork["extract"]>): Generator<number> {
  for (const node of graph.nodes) {
    yield node.nodeId;
    yield node.kind.length;
    yield node.worldX;
    yield node.worldZ;
    yield node.elevationMeters;
    yield node.flowAccumulationAreaM2;
    yield node.termination === undefined ? -1 : node.termination.length;
  }
  for (const edge of graph.edges) {
    yield edge.edgeId;
    yield edge.upstreamNodeId;
    yield edge.downstreamNodeId;
    yield edge.flowAccumulationAreaM2;
    yield edge.hydraulicGeometry.wettedWidthMeters;
    yield edge.hydraulicGeometry.bankfullDepthMeters;
    yield edge.hydraulicGeometry.dischargeM3PerSecond;
    yield edge.bankElevationMeters;
    yield edge.thalwegElevationMeters;
  }
  for (const polygon of graph.lakePolygons) {
    yield polygon.polygonRef;
    yield polygon.verticesXZ.length;
    for (const value of polygon.verticesXZ) yield value;
  }
  for (const lake of graph.lakes) {
    yield lake.lakeId;
    yield lake.polygonRef;
    yield lake.spillElevationMeters;
    yield lake.outletNodeId;
    yield lake.maximumDepthMeters;
    yield lake.surfaceAreaM2;
  }
}

function* meshValues(
  built: { readonly rivers: HydrologyMeshArrays; readonly lakes: HydrologyMeshArrays },
): Generator<number> {
  for (const arrays of [built.rivers, built.lakes]) {
    for (const value of arrays.positions) yield value;
    for (const value of arrays.normals) yield value;
    for (const value of arrays.uvs) yield value;
    for (const value of arrays.flowData) yield value;
    for (const value of arrays.waterData) yield value;
    for (const value of arrays.indices) yield value;
  }
}

function time<T>(label: string, run: () => T): T {
  const start = performance.now();
  const value = run();
  const elapsed = performance.now() - start;
  console.log(`${label.padEnd(30)} ${elapsed.toFixed(0).padStart(7)} ms`);
  return value;
}

console.log(
  `seed ${seed} (seedHash ${world.seedHash}), domain ${domain}x${domain}`
  + ` @ ${EVOLUTION_TEXEL_METERS} m, ${repeats} repeats`,
);

const inputs = time("macro sampling", () =>
  sampleTerrainMacroEvolutionInputs({
    width: domain,
    height: domain,
    minWorldX: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX,
    minWorldZ: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ,
    texelSizeMeters: EVOLUTION_TEXEL_METERS,
    seedHash: world.seedHash,
  }));
const evolved = time("macro evolution", () =>
  evolveMacroTerrain({
    width: domain,
    height: domain,
    heights: inputs.heights,
    texelSizeMeters: EVOLUTION_TEXEL_METERS,
    seaLevel: world.seaLevel,
    erodibility: inputs.erodibility,
    reposeDegrees: inputs.reposeDegrees,
  }));
const macro = toTerrainMacroEvolutionExport(evolved, world.seaLevel, {
  worldSeed: world.seed,
  deviceFingerprint: "channel-extract-benchmark",
});
console.log(
  `macro: ${macro.lakes.length} lakes, ${macro.channelSeedTexelIndices.length} channel seeds`,
);
console.log("");

const LEGS = [
  "validateMacro",
  "seedThinning",
  "pathTracing",
  "graphAssembly",
  "shoreline",
  "graphValidation",
  "total",
] as const;

const best = createChannelExtractionProfile();
for (const leg of LEGS) best[leg] = Number.POSITIVE_INFINITY;
let graph = new ChannelNetwork().extract(macro);
let adapterBest = Number.POSITIVE_INFINITY;
let meshBest = Number.POSITIVE_INFINITY;
let geometry = channelGraphToHydrologyGeometry(graph);
let meshArrays = buildGraphHydrologyMeshArrays(geometry.rivers, geometry.lakes);

for (let repeat = 0; repeat < repeats; repeat += 1) {
  const profile: ChannelExtractionProfile = createChannelExtractionProfile();
  graph = new ChannelNetwork().extract(macro, { profile });
  for (const leg of LEGS) best[leg] = Math.min(best[leg], profile[leg]);

  const adapterStart = performance.now();
  geometry = channelGraphToHydrologyGeometry(graph);
  adapterBest = Math.min(adapterBest, performance.now() - adapterStart);

  const meshStart = performance.now();
  meshArrays = buildGraphHydrologyMeshArrays(geometry.rivers, geometry.lakes);
  meshBest = Math.min(meshBest, performance.now() - meshStart);
}

console.log(`ChannelNetwork.extract  (best of ${repeats})`);
for (const leg of LEGS) {
  if (leg === "total") console.log(`  ${"-".repeat(38)}`);
  console.log(`  ${leg.padEnd(22)} ${best[leg].toFixed(1).padStart(9)} ms`);
}
console.log("");
console.log(`hydrology mesh build    (best of ${repeats})`);
console.log(`  ${"graphToHydrology".padEnd(22)} ${adapterBest.toFixed(1).padStart(9)} ms`);
console.log(`  ${"buildMeshArrays".padEnd(22)} ${meshBest.toFixed(1).padStart(9)} ms`);
console.log(`  ${"-".repeat(38)}`);
console.log(
  `  ${"startup total".padEnd(22)} ${(best.total + adapterBest + meshBest).toFixed(1).padStart(9)} ms`,
);
console.log("");
console.log(
  `graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges,`
  + ` ${graph.lakes.length} lakes`,
);
console.log(
  `mesh: rivers ${meshArrays.rivers.positions.length / 3} vertices /`
  + ` ${meshArrays.rivers.indices.length / 3} triangles,`
  + ` lakes ${meshArrays.lakes.positions.length / 3} vertices /`
  + ` ${meshArrays.lakes.indices.length / 3} triangles`
  + ` (${geometry.rivers.length} rivers, ${geometry.lakes.length} lakes)`,
);
console.log(`graph fingerprint ${fingerprint(graphValues(graph))}`);
console.log(`mesh  fingerprint ${fingerprint(meshValues(meshArrays))}`);
