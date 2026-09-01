import { describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import { densityField } from "../../src/render/webgpu/detail/densityField";
import {
  classifyLandCover,
  type LandCoverInput,
} from "../../src/render/webgpu/terrain/LandCoverClassifier";
import { PageSplatBake } from "../../src/render/webgpu/terrain/PageOcclusionBake";
import { GlobalHeightPyramid } from "../../src/render/webgpu/terrain/GlobalHeightPyramid";
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
} from "../../src/render/webgpu/terrain/surfaceMaterials";
import { WORLD_PAGE_BASE_EXTENT_METERS, WORLD_PAGE_GUTTER } from "../../src/render/webgpu/world/pageGeometry";
import { createWorldPageAddress, worldPageBounds } from "../../src/render/webgpu/world/pageKey";
import { createWorld, sampleTerrain } from "../../src/world";

/**
 * `6-13`: does the BAKE feed the classifier what the CPU thinks it does?
 *
 * The closure gate and the slope-partition fix were both derived and measured
 * entirely on the CPU classifier. The shipping path is the WGSL twin inside
 * the page splat bake, and `D-18` is the precedent for why that gap matters:
 * a seed mismatch made measured closure read 0.008 against 0.90 standing —
 * a channel structurally present and semantically empty. A CPU-derived law
 * change validated only on the CPU could repeat it exactly.
 *
 * So this reads the material the BAKE actually wrote, and compares it to what
 * the CPU classifier says at the same world position. No pixel colours and no
 * inference: `splatId` is the classifier's own answer.
 */

const WORLD_SEED = "phase1-perf-baseline";
/** A level-4 page has ~270 m of relief, so it spans several cover bands. */
const LEVEL = 4;

describe("land-cover bake parity (6-13)", () => {
  it("agrees with the CPU classifier on the material the bake writes", async () => {
    const world = createWorld(WORLD_SEED, { worldEvolution: "analytic" });
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
      const heightAtlas = new TerrainPageAtlas(scene, profile, {
        kind: "height", worldRevision: "bake-parity",
      });
      const channelAtlas = new TerrainPageAtlas(scene, profile, {
        kind: "channel", worldRevision: "bake-parity",
        textureCount: TERRAIN_CHANNEL_TEXTURE_COUNT,
      });
      const generator = new TerrainPageGenerator(
        engine, heightAtlas, world.seedHash, world.airport ?? null,
      );
      const pyramid = new GlobalHeightPyramid(scene, engine, world.seedHash);
      const splat = new PageSplatBake(
        engine, heightAtlas, channelAtlas, world.seedHash, world.sourceSeedHash,
        world.seaLevel, world.latitudeDegrees, world.airport ?? null,
      );

      // Several pages, so the comparison spans varied cover rather than one band.
      const addresses = [
        createWorldPageAddress(LEVEL, 3, -2),
        createWorldPageAddress(LEVEL, 4, -2),
        createWorldPageAddress(LEVEL, 3, -1),
      ];
      heightAtlas.residency.beginFrame(1);
      channelAtlas.residency.beginFrame(1);
      const heightSlots = addresses.map(
        (a) => heightAtlas.residency.request(invariantSlotKey(a), a)!.slot);
      const channelSlots = addresses.map(
        (a) => channelAtlas.residency.request(invariantSlotKey(a), a)!.slot);
      await generator.generate(heightSlots);
      await generator.settle();
      await pyramid.recenter(
        addresses[0]!.x * 512 * 2 ** LEVEL, addresses[0]!.z * 512 * 2 ** LEVEL);
      expect(await splat.bake(channelSlots, 171)).toBe(addresses.length);

      const edge = TERRAIN_CHANNEL_SLOT_EDGE;
      const texel = terrainChannelTexelSizeMeters(LEVEL);
      let compared = 0;
      let agreed = 0;
      const bakeHistogram = new Array<number>(SURFACE_MATERIAL_COUNT).fill(0);
      const cpuHistogram = new Array<number>(SURFACE_MATERIAL_COUNT).fill(0);
      const disagreements = new Map<string, number>();

      for (let index = 0; index < addresses.length; index += 1) {
        const slot = channelSlots[index]!;
        const bounds = worldPageBounds(addresses[index]!, WORLD_PAGE_BASE_EXTENT_METERS);
        const origin = channelAtlas.slotOrigin(slot.slotIndex);
        const ids = await channelAtlas.texture(TERRAIN_CHANNEL_TEXTURES.splatId)!
          .readPixels(0, 0, undefined, true, false, origin.u, origin.v, edge, edge) as Uint8Array;

        for (let row = WORLD_PAGE_GUTTER; row < edge - WORLD_PAGE_GUTTER; row += 3) {
          for (let col = WORLD_PAGE_GUTTER; col < edge - WORLD_PAGE_GUTTER; col += 3) {
            const offset = (row * edge + col) * 4;
            // Ids are stored as unorm over the ten-material axis.
            const baked = Math.round((ids[offset]! / 255) * (SURFACE_MATERIAL_COUNT - 1));

            // The bake's own texel-centre mapping, from PageSplatBake's job.
            const worldX = bounds.minX + (col - WORLD_PAGE_GUTTER + 0.5) * texel;
            const worldZ = bounds.minZ + (row - WORLD_PAGE_GUTTER + 0.5) * texel;

            const sample = sampleTerrain(world, worldX, worldZ, undefined, 171);
            if (sample.height < world.seaLevel + 5) continue;
            const field = densityField(world.sourceSeedHash, {
              filterWidthMeters: 0,
              x: worldX,
              z: worldZ,
              heightMeters: sample.height,
              seaLevelMeters: world.seaLevel,
              slope: sample.slope,
              moisture: sample.moisture,
              normalX: sample.normal.x,
              normalZ: sample.normal.z,
              dayOfYear: 171,
            });
            const input: LandCoverInput = {
              elevationMeters: sample.height - world.seaLevel,
              slope: sample.slope,
              moisture: sample.moisture,
              temperature: sample.temperature ?? 0.5,
              aspect: 0,
              airportInfluence: 0,
              dayOfYear: 171,
              seasonalTemperatureShift: 0,
              canopyClosure: field.canopyClosure,
              grassCover: field.groundCover?.grass,
            };
            const w = classifyLandCover(input);
            let best = 0;
            for (let i = 1; i < w.ids.length; i += 1) {
              if (w.weights[i]! > w.weights[best]!) best = i;
            }
            const cpu = w.ids[best]!;

            bakeHistogram[baked] = (bakeHistogram[baked] ?? 0) + 1;
            cpuHistogram[cpu] = (cpuHistogram[cpu] ?? 0) + 1;
            compared += 1;
            if (baked === cpu) agreed += 1;
            else {
              const key = `${SURFACE_MATERIALS[cpu]?.name} (cpu) vs ${SURFACE_MATERIALS[baked]?.name} (bake)`;
              disagreements.set(key, (disagreements.get(key) ?? 0) + 1);
            }
          }
        }
      }

      const share = (h: readonly number[]) => h
        .map((n, id) => [SURFACE_MATERIALS[id]?.name ?? `#${id}`, (n / compared) * 100] as const)
        .filter(([, pct]) => pct > 0.05)
        .sort((a, b) => b[1] - a[1])
        .map(([name, pct]) => `${name} ${pct.toFixed(1)}%`)
        .join("  ");
      console.log(`BAKE-PARITY compared ${compared} texels across ${addresses.length} pages`);
      console.log(`  bake: ${share(bakeHistogram)}`);
      console.log(`  cpu : ${share(cpuHistogram)}`);
      console.log(`  agreement ${((agreed / compared) * 100).toFixed(2)}%`);
      for (const [k, n] of [...disagreements.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
        console.log(`  disagree ${((n / compared) * 100).toFixed(2)}%  ${k}`);
      }

      expect(compared).toBeGreaterThan(500);
      // The bake and the CPU law are twins. They cannot be bit-identical — the
      // bake samples its own height texels where the CPU samples the analytic
      // field, so texels near a boundary legitimately differ — but a LAW that
      // has drifted, or a channel that is semantically empty, shows up as broad
      // disagreement rather than boundary noise. D-18 read 0.008 against 0.90.
      expect(
        agreed / compared,
        "the baked material disagrees with the CPU classifier too widely to be "
        + "boundary noise — the WGSL twin has drifted or an input channel is empty",
      ).toBeGreaterThan(0.75);
    } finally {
      scene?.dispose();
      engine.stopRenderLoop();
      engine.dispose();
      canvas.remove();
    }
  }, 240_000);
});
