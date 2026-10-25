/**
 * The terrain samplers the agent creates its FlightRenderer with.
 *
 * FlightGame hands the renderer the full sample and, beside it, the height
 * alone (`sampleTerrainHeight`, the same surface bit for bit). With the
 * height-only sampler the ground-cover tile bakes in 32 m steps under its
 * frame budget, and the birds, the spawned airfields and the camera clamp
 * read the height alone; without it the tile keeps its whole-row bake on the
 * full sample. perf:flight asks for the game's pair
 * (`AgentConfig.gameTerrainHeight`), so it flies what a player flies. perf:ab
 * never asks, so its renderers are made as the capture's are, with the full
 * sample alone, and its baselines cannot move. A base built before the option
 * ignores the extra sampler.
 *
 * Pure, so a node test can hold it to that (tests/perf-flight-bakes.test.ts).
 */
export function agentTerrainSamplers<World, Sample>(
  world: World,
  gameTerrainHeight: boolean | null | undefined,
  sampleTerrain: (world: World, x: number, z: number) => Sample,
  sampleTerrainHeight: (world: World, x: number, z: number) => number,
): { readonly terrainSample: (x: number, z: number) => Sample; readonly terrainHeight?: (x: number, z: number) => number } {
  const terrainSample = (x: number, z: number) => sampleTerrain(world, x, z);
  if (gameTerrainHeight !== true) return { terrainSample };
  return { terrainSample, terrainHeight: (x: number, z: number) => sampleTerrainHeight(world, x, z) };
}
