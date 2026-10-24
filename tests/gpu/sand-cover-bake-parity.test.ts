import { describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import {
  densityField,
  sandCoverGroundFactor,
  sandCoverTreeFactor,
} from "../../src/render/webgpu/detail/densityField";
import {
  LAND_COVER_FAR_DESERT_FULL_TEXEL_METERS,
  LAND_COVER_FAR_DESERT_START_TEXEL_METERS,
  LAND_COVER_TAP_CANOPY_MIN_TEXEL_METERS,
  classifyLandCover,
  landCoverFarDesertWeights,
  type LandCoverInput,
} from "../../src/render/webgpu/terrain/LandCoverClassifier";
import { PageSplatBake } from "../../src/render/webgpu/terrain/PageOcclusionBake";
import { GlobalHeightPyramid } from "../../src/render/webgpu/terrain/GlobalHeightPyramid";
import {
  terrainClimateProvinceInput,
  terrainLandformInput,
} from "../../src/render/webgpu/terrain/TerrainKernel";
import {
  TERRAIN_CHANNEL_TEXTURES,
  TERRAIN_CHANNEL_TEXTURE_COUNT,
  TerrainPageAtlas,
  TerrainPageGenerator,
  invariantSlotKey,
} from "../../src/render/webgpu/terrain/TerrainPageAtlas";
import {
  TERRAIN_CHANNEL_SLOT_EDGE,
  terrainChannelTexelSizeMeters,
} from "../../src/render/webgpu/terrain/TerrainSpineContract";
import {
  SURFACE_MATERIALS,
  SURFACE_MATERIAL_COUNT,
  SurfaceMaterial,
} from "../../src/render/webgpu/terrain/surfaceMaterials";
import { WORLD_PAGE_BASE_EXTENT_METERS, WORLD_PAGE_GUTTER } from "../../src/render/webgpu/world/pageGeometry";
import {
  createWorldPageAddress,
  worldPageBounds,
  type WorldPageAddress,
} from "../../src/render/webgpu/world/pageKey";
import { createWorld, sampleTerrain } from "../../src/world";
import { sampleLandformCover } from "../../src/world/landforms";

/**
 * The sand seas through the ground BAKE: the sand cover the dunes lay down
 * must reach the splat bake, or the GPU paints the climate's steppe on the
 * dunes while the CPU (vegetation, the HUD's biome) believes they are sand.
 *
 * A world that forces dunes and the high desert, baked over the sand sea 22 km
 * from the capture airport (the one the review shots fly), and compared with
 * the CPU classifier fed the same texel-centre sand cover, the same plant
 * factors on the canopy and the same far-desert twin. Non-vacuity is part of
 * the test: without the cover the high desert bakes tan bunchgrass here, and
 * from the far-desert ramp up it moves every sand texel to straw, so both
 * "Sand dominates" assertions fail on a bake that lost the cover.
 */

const WORLD_SEED = "phase1-perf-baseline";
const DAY = 171;

interface PageTally {
  compared: number;
  agreed: number;
  /** Texels whose CPU sand cover is > 0.9 (the sheet of a full erg). */
  covered: number;
  coveredBakedSand: number;
  bake: number[];
  cpu: number[];
  disagreements: Map<string, number>;
}

function emptyTally(): PageTally {
  return {
    compared: 0,
    agreed: 0,
    covered: 0,
    coveredBakedSand: 0,
    bake: new Array<number>(SURFACE_MATERIAL_COUNT).fill(0),
    cpu: new Array<number>(SURFACE_MATERIAL_COUNT).fill(0),
    disagreements: new Map(),
  };
}

function share(tally: PageTally, histogram: readonly number[]): string {
  return histogram
    .map((n, id) => [SURFACE_MATERIALS[id]?.name ?? `#${id}`, (n / tally.compared) * 100] as const)
    .filter(([, pct]) => pct > 0.05)
    .sort((a, b) => b[1] - a[1])
    .map(([name, pct]) => `${name} ${pct.toFixed(1)}%`)
    .join("  ");
}

async function bakeSandSea(addresses: readonly WorldPageAddress[]): Promise<PageTally[]> {
  const world = createWorld(WORLD_SEED, {
    worldEvolution: "analytic",
    climateProvince: "high-desert",
    landforms: { dunes: true },
  });
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, {
    antialias: false, enableAllFeatures: false, setMaximumLimits: false,
  });
  let scene: Scene | null = null;
  try {
    await engine.initAsync();
    engine.runRenderLoop(() => {});
    scene = new Scene(engine);
    const base = resolveWebGpuQualityProfile("medium", "balanced");
    const profile = { ...base, heightAtlasSlots: 8, channelAtlasSlots: 8 };
    const revision = "sand-cover-bake-parity";
    const heightAtlas = new TerrainPageAtlas(scene, profile, { kind: "height", worldRevision: revision });
    const channelAtlas = new TerrainPageAtlas(scene, profile, {
      kind: "channel", worldRevision: revision, textureCount: TERRAIN_CHANNEL_TEXTURE_COUNT,
    });
    const landform = terrainLandformInput(world);
    const generator = new TerrainPageGenerator(
      engine, heightAtlas, world.seedHash, world.airport ?? null, { world });
    const pyramid = new GlobalHeightPyramid(scene, engine, world.seedHash, { landform });
    const splat = new PageSplatBake(
      engine, heightAtlas, channelAtlas, world.seedHash, world.sourceSeedHash,
      world.seaLevel, world.latitudeDegrees, world.airport ?? null,
      terrainClimateProvinceInput(world), landform,
    );
    heightAtlas.residency.beginFrame(1);
    channelAtlas.residency.beginFrame(1);
    const heightSlots = addresses.map((a) => heightAtlas.residency.request(invariantSlotKey(a), a)!.slot);
    const channelSlots = addresses.map((a) => channelAtlas.residency.request(invariantSlotKey(a), a)!.slot);
    await generator.generate(heightSlots);
    await generator.settle();
    const first = addresses[0]!;
    await pyramid.recenter(first.x * 512 * 2 ** first.level, first.z * 512 * 2 ** first.level);
    expect(await splat.bake(channelSlots, DAY)).toHaveLength(addresses.length);

    const edge = TERRAIN_CHANNEL_SLOT_EDGE;
    const tallies: PageTally[] = [];
    for (let index = 0; index < addresses.length; index += 1) {
      const address = addresses[index]!;
      const tally = emptyTally();
      tallies.push(tally);
      const texel = terrainChannelTexelSizeMeters(address.level);
      const bounds = worldPageBounds(address, WORLD_PAGE_BASE_EXTENT_METERS);
      const origin = channelAtlas.slotOrigin(channelSlots[index]!.slotIndex);
      const ids = await channelAtlas.texture(TERRAIN_CHANNEL_TEXTURES.splatId)!
        .readPixels(0, 0, undefined, true, false, origin.u, origin.v, edge, edge) as Uint8Array;
      const perTapCanopy = texel >= LAND_COVER_TAP_CANOPY_MIN_TEXEL_METERS;

      for (let row = WORLD_PAGE_GUTTER; row < edge - WORLD_PAGE_GUTTER; row += 3) {
        for (let col = WORLD_PAGE_GUTTER; col < edge - WORLD_PAGE_GUTTER; col += 3) {
          const offset = (row * edge + col) * 4;
          const baked = Math.round((ids[offset]! / 255) * (SURFACE_MATERIAL_COUNT - 1));
          const worldX = bounds.minX + (col - WORLD_PAGE_GUTTER + 0.5) * texel;
          const worldZ = bounds.minZ + (row - WORLD_PAGE_GUTTER + 0.5) * texel;
          const sample = sampleTerrain(world, worldX, worldZ, undefined, DAY);
          if (sample.height < world.seaLevel + 5) continue;
          // The bake's cover: once per texel, at the centre, through the
          // natural kernel band-limited at the page's own texel.
          const sandCover = sampleLandformCover(world, worldX, worldZ, texel).sandCover;
          const trees = sandCoverTreeFactor(sandCover);
          const grass = sandCoverGroundFactor(sandCover);

          const fieldAt = (x: number, z: number, at: typeof sample) => densityField(
            world.sourceSeedHash, {
              filterWidthMeters: 0,
              x,
              z,
              heightMeters: at.height,
              seaLevelMeters: world.seaLevel,
              slope: at.slope,
              moisture: at.moisture,
              normalX: at.normal.x,
              normalZ: at.normal.z,
              dayOfYear: DAY,
              temperatureOffset: at.temperatureOffset,
              dryness: at.dryness,
            });
          const centreField = fieldAt(worldX, worldZ, sample);
          let accumulated = new Array<number>(SURFACE_MATERIAL_COUNT).fill(0);
          for (let tap = 0; tap < 4; tap += 1) {
            const tapX = worldX + ((tap & 1) === 1 ? 1 : -1) * texel * 0.25;
            const tapZ = worldZ + ((tap & 2) === 2 ? 1 : -1) * texel * 0.25;
            const tapSample = sampleTerrain(world, tapX, tapZ, undefined, DAY);
            const tapField = perTapCanopy ? fieldAt(tapX, tapZ, tapSample) : centreField;
            const grassCover = tapField.groundCover?.grass;
            const tapInput: LandCoverInput = {
              elevationMeters: tapSample.height - world.seaLevel,
              slope: tapSample.slope,
              moisture: tapSample.moisture,
              temperature: tapSample.temperature,
              aspect: 0,
              airportInfluence: 0,
              dayOfYear: DAY,
              seasonalTemperatureShift: 0,
              canopyClosure: tapField.canopyClosure * trees,
              ...(grassCover !== undefined ? { grassCover: grassCover * grass } : {}),
              temperatureOffset: sample.temperatureOffset,
              dryness: sample.dryness,
              sandCover,
            };
            const tapWeights = classifyLandCover(tapInput);
            tapWeights.ids.forEach((id, slot) => {
              accumulated[id] = accumulated[id]! + (tapWeights.weights[slot] ?? 0) * 0.25;
            });
          }
          accumulated = landCoverFarDesertWeights(accumulated, sample.dryness, texel, sandCover);
          let cpu = 0;
          for (let id = 1; id < SURFACE_MATERIAL_COUNT; id += 1) {
            if (accumulated[id]! > accumulated[cpu]!) cpu = id;
          }

          tally.bake[baked] = tally.bake[baked]! + 1;
          tally.cpu[cpu] = tally.cpu[cpu]! + 1;
          tally.compared += 1;
          if (sandCover > 0.9) {
            tally.covered += 1;
            if (baked === SurfaceMaterial.Sand) tally.coveredBakedSand += 1;
          }
          if (baked === cpu) tally.agreed += 1;
          else {
            const key = `${SURFACE_MATERIALS[cpu]?.name} (cpu) vs ${SURFACE_MATERIALS[baked]?.name} (bake)`;
            tally.disagreements.set(key, (tally.disagreements.get(key) ?? 0) + 1);
          }
        }
      }
    }
    return tallies;
  } finally {
    scene?.dispose();
    engine.stopRenderLoop();
    engine.dispose();
    canvas.remove();
  }
}

function merge(tallies: readonly PageTally[]): PageTally {
  const total = emptyTally();
  for (const tally of tallies) {
    total.compared += tally.compared;
    total.agreed += tally.agreed;
    total.covered += tally.covered;
    total.coveredBakedSand += tally.coveredBakedSand;
    tally.bake.forEach((n, id) => { total.bake[id] = total.bake[id]! + n; });
    tally.cpu.forEach((n, id) => { total.cpu[id] = total.cpu[id]! + n; });
    for (const [k, n] of tally.disagreements) {
      total.disagreements.set(k, (total.disagreements.get(k) ?? 0) + n);
    }
  }
  return total;
}

function report(label: string, tally: PageTally): void {
  console.log(`SAND-BAKE-PARITY ${label}: compared ${tally.compared} texels, ${tally.covered} under a sand sheet`);
  console.log(`  bake: ${share(tally, tally.bake)}`);
  console.log(`  cpu : ${share(tally, tally.cpu)}`);
  console.log(`  agreement ${((tally.agreed / tally.compared) * 100).toFixed(2)}%,`
    + ` sheet baked as Sand ${((tally.coveredBakedSand / Math.max(1, tally.covered)) * 100).toFixed(2)}%`);
  for (const [k, n] of [...tally.disagreements.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`  disagree ${((n / tally.compared) * 100).toFixed(2)}%  ${k}`);
  }
}

/**
 * The sand sea the review shots fly: around (7,271, -50,295), 22 km from the
 * capture airport. Two near L2 pages inside it, the L4 page holding them and
 * its erg edges, and the L5 page above that, past the far-desert ramp.
 */
const NEAR_L2 = [createWorldPageAddress(2, 3, -25), createWorldPageAddress(2, 3, -24)];
const MID_L4 = createWorldPageAddress(4, 0, -7);
const FAR_L5 = createWorldPageAddress(5, 0, -4);

describe("sand-cover bake parity", () => {
  it("bakes the sand sea's sand the CPU classifier describes, near and far", async () => {
    const tallies = await bakeSandSea([...NEAR_L2, MID_L4, FAR_L5]);
    const near = merge(tallies.slice(0, NEAR_L2.length));
    const mid = tallies[NEAR_L2.length]!;
    const far = tallies[NEAR_L2.length + 1]!;
    expect(terrainChannelTexelSizeMeters(2)).toBeLessThanOrEqual(LAND_COVER_FAR_DESERT_START_TEXEL_METERS);
    expect(terrainChannelTexelSizeMeters(5)).toBeGreaterThanOrEqual(LAND_COVER_FAR_DESERT_FULL_TEXEL_METERS);
    report("forced erg L2", near);
    report("forced erg L4", mid);
    report("forced erg L5", far);

    // Non-vacuity: the near pages lie inside a full erg.
    expect(near.compared).toBeGreaterThan(500);
    expect(near.covered / near.compared).toBeGreaterThan(0.6);
    expect(near.agreed / near.compared).toBeGreaterThan(0.9);
    // Under the sheet the bake paints Sand, near and at every range: the far
    // desert's straw remap must not reach a sand sea.
    expect(near.coveredBakedSand / near.covered).toBeGreaterThan(0.9);
    expect(mid.covered).toBeGreaterThan(100);
    expect(mid.coveredBakedSand / mid.covered).toBeGreaterThan(0.9);
    expect(mid.agreed / mid.compared).toBeGreaterThan(0.9);
    expect(far.covered).toBeGreaterThan(50);
    expect(far.coveredBakedSand / far.covered).toBeGreaterThan(0.9);
    expect(far.agreed / far.compared).toBeGreaterThan(0.85);
  }, 300_000);
});
