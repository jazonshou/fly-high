import { describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import { densityField } from "../../src/render/webgpu/detail/densityField";
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
import { terrainClimateProvinceInput } from "../../src/render/webgpu/terrain/TerrainKernel";
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
import type { ClimateProvinceName } from "../../src/world/climateProvince";
import { createWorld, sampleTerrain } from "../../src/world";

/**
 * The dry provinces through the BAKE, not just the CPU law.
 *
 * `land-cover-bake-parity` reads the temperate world, where every dry-province
 * term is exactly 0, so a WGSL twin that had lost all of them would pass it
 * unmoved. This forces the high-desert and savanna presets on the same seed
 * and pages, bakes them on the adapter, and compares the material the bake
 * wrote with the CPU classifier at the same position, fed the same province
 * offsets. Non-vacuity is part of the test: the bake must actually paint the
 * desert's sand and sage and the savanna's straw sward, which the temperate
 * bake never does.
 *
 * The desert reads three levels. Two L2 pages inside the first L4 page are the
 * near ground, below `LAND_COVER_FAR_DESERT_START_TEXEL_METERS`, where the bake
 * must paint the real sand and sage. The L4 pages are two thirds of the way up
 * the far-desert ramp and the L5 page all the way
 * (`LAND_COVER_FAR_DESERT_FULL_TEXEL_METERS`), where no sand, gravel or rock
 * may be dominant. The CPU side applies the same twin at every level.
 */

const WORLD_SEED = "phase1-perf-baseline";
const DAY = 171;

interface PageTally {
  compared: number;
  agreed: number;
  bake: number[];
  cpu: number[];
  disagreements: Map<string, number>;
}

function emptyTally(): PageTally {
  return {
    compared: 0,
    agreed: 0,
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

async function bakeProvince(
  province: ClimateProvinceName,
  addresses: readonly WorldPageAddress[],
): Promise<PageTally[]> {
  const world = createWorld(WORLD_SEED, { worldEvolution: "analytic", climateProvince: province });
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
    const revision = `dry-bake-parity-${province}`;
    const heightAtlas = new TerrainPageAtlas(scene, profile, { kind: "height", worldRevision: revision });
    const channelAtlas = new TerrainPageAtlas(scene, profile, {
      kind: "channel", worldRevision: revision, textureCount: TERRAIN_CHANNEL_TEXTURE_COUNT,
    });
    const generator = new TerrainPageGenerator(engine, heightAtlas, world.seedHash, world.airport ?? null);
    const pyramid = new GlobalHeightPyramid(scene, engine, world.seedHash);
    const splat = new PageSplatBake(
      engine, heightAtlas, channelAtlas, world.seedHash, world.sourceSeedHash,
      world.seaLevel, world.latitudeDegrees, world.airport ?? null,
      terrainClimateProvinceInput(world),
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
            // The bake samples the province once, at the texel centre.
            const tapInput: LandCoverInput = {
              elevationMeters: tapSample.height - world.seaLevel,
              slope: tapSample.slope,
              moisture: tapSample.moisture,
              temperature: tapSample.temperature,
              aspect: 0,
              airportInfluence: 0,
              dayOfYear: DAY,
              seasonalTemperatureShift: 0,
              canopyClosure: tapField.canopyClosure,
              grassCover: tapField.groundCover?.grass,
              temperatureOffset: sample.temperatureOffset,
              dryness: sample.dryness,
            };
            const tapWeights = classifyLandCover(tapInput);
            tapWeights.ids.forEach((id, slot) => {
              accumulated[id] = accumulated[id]! + (tapWeights.weights[slot] ?? 0) * 0.25;
            });
          }
          accumulated = landCoverFarDesertWeights(accumulated, sample.dryness, texel);
          let cpu = 0;
          for (let id = 1; id < SURFACE_MATERIAL_COUNT; id += 1) {
            if (accumulated[id]! > accumulated[cpu]!) cpu = id;
          }

          tally.bake[baked] = tally.bake[baked]! + 1;
          tally.cpu[cpu] = tally.cpu[cpu]! + 1;
          tally.compared += 1;
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
    tally.bake.forEach((n, id) => { total.bake[id] = total.bake[id]! + n; });
    tally.cpu.forEach((n, id) => { total.cpu[id] = total.cpu[id]! + n; });
    for (const [k, n] of tally.disagreements) {
      total.disagreements.set(k, (total.disagreements.get(k) ?? 0) + n);
    }
  }
  return total;
}

function report(label: string, tally: PageTally): void {
  console.log(`DRY-BAKE-PARITY ${label}: compared ${tally.compared} texels`);
  console.log(`  bake: ${share(tally, tally.bake)}`);
  console.log(`  cpu : ${share(tally, tally.cpu)}`);
  console.log(`  agreement ${((tally.agreed / tally.compared) * 100).toFixed(2)}%`);
  for (const [k, n] of [...tally.disagreements.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`  disagree ${((n / tally.compared) * 100).toFixed(2)}%  ${k}`);
  }
}

/** The lowland pages `land-cover-bake-parity` reads, so the two stay comparable. */
const LOWLAND_L4 = [
  createWorldPageAddress(4, 3, -2),
  createWorldPageAddress(4, 4, -2),
  createWorldPageAddress(4, 3, -1),
];
/** A level-5 page over the same ground: zero-trust, past the far-desert size. */
const FAR_L5 = createWorldPageAddress(5, 1, -1);
/** Two near pages inside LOWLAND_L4[0], below the far-desert ramp. */
const NEAR_L2 = [createWorldPageAddress(2, 13, -7), createWorldPageAddress(2, 14, -6)];

describe("dry-province bake parity", () => {
  it("bakes the high desert the CPU classifier describes, near and far", async () => {
    const tallies = await bakeProvince("high-desert", [...NEAR_L2, ...LOWLAND_L4, FAR_L5]);
    const near = merge(tallies.slice(0, NEAR_L2.length));
    const mid = merge(tallies.slice(NEAR_L2.length, NEAR_L2.length + LOWLAND_L4.length));
    const far = tallies[NEAR_L2.length + LOWLAND_L4.length]!;
    expect(terrainChannelTexelSizeMeters(2)).toBeLessThanOrEqual(LAND_COVER_FAR_DESERT_START_TEXEL_METERS);
    expect(terrainChannelTexelSizeMeters(5)).toBeGreaterThanOrEqual(LAND_COVER_FAR_DESERT_FULL_TEXEL_METERS);
    report("high-desert L2", near);
    report("high-desert L4", mid);
    report("high-desert L5", far);

    expect(near.compared).toBeGreaterThan(500);
    // Measured on SwiftShader (2026-10-24): 97.8% on the L2 pages, 99.9% on
    // L4 and 99.3% on L5, against 85% on the temperate pages. Bunchgrass
    // dominates the steppe by a wide margin, so the argmax rarely turns on the
    // bake's band-limited heights and f32 fields; what disagreement is left
    // sits on the edges of the sand flats and the rock outcrops.
    expect(
      near.agreed / near.compared,
      "the baked desert disagrees with the CPU classifier too widely to be boundary noise "
      + "- the WGSL twin of the dry-province terms has drifted",
    ).toBeGreaterThan(0.9);
    // Non-vacuity: the temperate bake paints these pages green Grass, and no
    // inland sand; the desert bake paints tan bunchgrass and bare flats.
    expect(near.bake[SurfaceMaterial.DryGrass]! / near.compared).toBeGreaterThan(0.6);
    expect(near.bake[SurfaceMaterial.Sand]! / near.compared).toBeGreaterThan(0.02);
    expect(near.bake[SurfaceMaterial.Grass]! / near.compared).toBeLessThan(0.1);
    expect(mid.compared).toBeGreaterThan(500);
    expect(mid.agreed / mid.compared).toBeGreaterThan(0.9);

    // Far: no sand, gravel or rock is DOMINANT on a zero-trust desert page; the
    // remap leaves sage and straw, the pair the far-sward gate lets through.
    expect(far.compared).toBeGreaterThan(300);
    const farBare = far.bake[SurfaceMaterial.Sand]! + far.bake[SurfaceMaterial.Gravel]!
      + far.bake[SurfaceMaterial.Rock]!;
    expect(farBare / far.compared).toBeLessThan(0.02);
    expect((far.bake[SurfaceMaterial.DryGrass]! + far.bake[SurfaceMaterial.Shrub]!) / far.compared)
      .toBeGreaterThan(0.8);
    expect(far.agreed / far.compared).toBeGreaterThan(0.9);
  }, 300_000);

  it("bakes the savanna's straw sward the CPU classifier describes", async () => {
    const near = merge(await bakeProvince("savanna", LOWLAND_L4));
    report("savanna L4", near);
    expect(near.compared).toBeGreaterThan(500);
    // Measured on SwiftShader (2026-10-24): 93.0%.
    expect(near.agreed / near.compared).toBeGreaterThan(0.85);
    expect(near.bake[SurfaceMaterial.DryGrass]! / near.compared).toBeGreaterThan(0.5);
  }, 300_000);
});
