import { describe, expect, it, vi } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import { GlobalHeightPyramid } from "../../src/render/webgpu/terrain/GlobalHeightPyramid";
import { PageSplatBake } from "../../src/render/webgpu/terrain/PageOcclusionBake";
import {
  INFRASTRUCTURE_SURFACE_MATERIAL,
  TERRAIN_INFRASTRUCTURE_WGSL,
  packTerrainInfrastructure,
  terrainInfrastructureDataBindingWgsl,
} from "../../src/render/webgpu/terrain/TerrainInfrastructureKernel";
import {
  TERRAIN_KERNEL_PAGE_BYTES,
  TERRAIN_KERNEL_WGSL,
  buildTerrainKernelPageUniform,
  terrainKernelPageBindingWgsl,
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
import { SURFACE_MATERIAL_COUNT, SurfaceMaterial } from "../../src/render/webgpu/terrain/surfaceMaterials";
import { WORLD_PAGE_BASE_EXTENT_METERS, WORLD_PAGE_GUTTER } from "../../src/render/webgpu/world/pageGeometry";
import { createWorldPageAddress, worldPageBounds } from "../../src/render/webgpu/world/pageKey";
import {
  buildInfrastructureIndex,
  createWorld,
  infrastructureCapsuleDistance,
  infrastructureIndex,
  INFRASTRUCTURE_PROFILE,
  INFRASTRUCTURE_SURFACE_FEATHER_METERS,
  sampleInfrastructureSurface,
  type InfrastructureSegment,
  type InfrastructureSurfaceSample,
} from "../../src/world";
import { infrastructureSegmentLocal } from "../../src/world/infrastructure";
import { landformCoreCenter } from "../../src/world/landforms";

/**
 * Built ground's paint, on the GPU: `terrainInfrastructureSurface` against
 * the CPU authority (`sampleInfrastructureSurface`), then a real page splat
 * bake with one shipped source standing in, so the paint is read back from
 * the channel atlas the terrain draws from.
 */

// One concrete pad and a gravel strip across it, inside level-0 page (1, -1)
// (x 512..1024, z -512..0). Shipped worlds have no source; this file is the
// first consumer that does.
vi.mock("../../src/world/infrastructureSources", () => ({
  INFRASTRUCTURE_SOURCES: Object.freeze([
    () => ({
      segments: [
        {
          profile: 0, mode: "set", priority: 0,
          ax: 660, az: -300, bx: 780, bz: -290,
          halfWidth: 22, reach: 10, params: [3, 2],
          surface: "concrete", plantClearance: 2,
        },
        {
          profile: 0, mode: "set", priority: 1,
          ax: 600, az: -420, bx: 900, bz: -170,
          halfWidth: 3, reach: 6, params: [3.2, 2],
          surface: "gravel", plantClearance: 2,
        },
      ],
    }),
  ]),
}));

const SURFACE_KERNEL = /* wgsl */ `
${terrainKernelPageBindingWgsl(0, 0)}
${terrainInfrastructureDataBindingWgsl(0, 1)}
${TERRAIN_KERNEL_WGSL}
${TERRAIN_INFRASTRUCTURE_WGSL}

@group(0) @binding(2) var<storage, read> probes: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> results: array<vec4f>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes)) { return; }
  let probe = probes[id.x];
  // probe = (local x, local z, unused, page index)
  kSelectPage(u32(probe.w));
  results[id.x] = vec4f(terrainInfrastructureSurface(probe.x, probe.y), 0.0, 0.0);
}
`;

function segment(overrides: Partial<InfrastructureSegment>): InfrastructureSegment {
  return {
    profile: INFRASTRUCTURE_PROFILE.platform,
    mode: "set",
    priority: 0,
    ax: 0,
    az: 0,
    bx: 0,
    bz: 0,
    halfWidth: 10,
    reach: 20,
    params: [1.2, 2],
    ...overrides,
  };
}

async function createEngine(): Promise<{ engine: WebGPUEngine; canvas: HTMLCanvasElement }> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
  await engine.initAsync();
  engine.runRenderLoop(() => {});
  return { engine, canvas };
}

describe("infrastructure surface paint on the GPU", () => {
  it("matches sampleInfrastructureSurface's material and coverage", async () => {
    const world = createWorld("alpha");
    const core = landformCoreCenter(world);
    const sites = [
      { x: core.x + 2_100, z: core.z + 900 },
      { x: core.x + 26_000, z: core.z - 33_000 },
    ];
    const segments: InfrastructureSegment[] = [];
    for (const site of sites) {
      // An apron, a car park overlapping it, a road through both, a round
      // pad, and a dredged basin that carries no paint at all.
      segments.push(
        segment({ ax: site.x - 50, az: site.z, bx: site.x + 50, bz: site.z + 12, halfWidth: 18, surface: "concrete" }),
        segment({ priority: 1, ax: site.x + 30, az: site.z - 30, bx: site.x + 70, bz: site.z - 30, halfWidth: 14, surface: "asphalt" }),
        segment({ priority: 2, ax: site.x - 300, az: site.z - 200, bx: site.x + 300, bz: site.z + 260, halfWidth: 3.5, reach: 8, surface: "gravel" }),
        segment({ ax: site.x - 90, az: site.z + 60, bx: site.x - 90, bz: site.z + 60, halfWidth: 9, surface: "concrete" }),
        segment({ mode: "cut", ax: site.x - 20, az: site.z - 80, bx: site.x + 20, bz: site.z - 80, halfWidth: 25, params: [-3, 3] }),
      );
    }
    const index = buildInfrastructureIndex(world, [() => ({ segments })]);
    const words = packTerrainInfrastructure(index, world.seaLevel, core);

    const landform = terrainLandformInput(world);
    const pages = sites.map((site) => ({ x: Math.floor((site.x - 400) / 512) * 512, z: Math.floor((site.z - 400) / 512) * 512 }));
    const pageBytes = new Uint8Array(pages.length * TERRAIN_KERNEL_PAGE_BYTES);
    pages.forEach((page, i) => {
      pageBytes.set(new Uint8Array(buildTerrainKernelPageUniform({
        seedHash: world.seedHash, originX: page.x, originZ: page.z, filterWidthMeters: 0, landform,
      })), i * TERRAIN_KERNEL_PAGE_BYTES);
    });

    interface Probe { readonly page: number; readonly x: number; readonly z: number }
    const probes: Probe[] = [];
    sites.forEach((site, page) => {
      for (let i = -120; i <= 120; i += 1) {
        for (let j = -120; j <= 120; j += 1) {
          probes.push({ page, x: site.x + i * 0.93 + 0.13, z: site.z + j * 0.87 - 0.29 });
        }
      }
    });
    const probeData = new Float32Array(probes.length * 4);
    probes.forEach((probe, i) => {
      const page = pages[probe.page]!;
      probeData[i * 4] = probe.x - page.x;
      probeData[i * 4 + 1] = probe.z - page.z;
      probeData[i * 4 + 3] = probe.page;
    });

    const { engine, canvas } = await createEngine();
    try {
      const pageBuffer = new StorageBuffer(engine, pageBytes.byteLength);
      pageBuffer.update(pageBytes);
      const dataBuffer = new StorageBuffer(engine, words.byteLength);
      dataBuffer.update(words);
      const probeBuffer = new StorageBuffer(engine, probeData.byteLength);
      probeBuffer.update(new Uint8Array(probeData.buffer));
      const resultBuffer = new StorageBuffer(engine, probes.length * 16);
      const shader = new ComputeShader("infrastructure-surface", engine, { computeSource: SURFACE_KERNEL }, {
        bindingsMapping: {
          terrainKernelPages: { group: 0, binding: 0 },
          terrainInfrastructureData: { group: 0, binding: 1 },
          probes: { group: 0, binding: 2 },
          results: { group: 0, binding: 3 },
        },
      });
      shader.setStorageBuffer("terrainKernelPages", pageBuffer);
      shader.setStorageBuffer("terrainInfrastructureData", dataBuffer);
      shader.setStorageBuffer("probes", probeBuffer);
      shader.setStorageBuffer("results", resultBuffer);
      const compileErrors: string[] = [];
      shader.onError = (_effect, message) => { compileErrors.push(String(message)); };
      const started = performance.now();
      while (performance.now() - started < 15_000 && compileErrors.length === 0) {
        if (shader.isReady()) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(compileErrors.join(" | ")).toBe("");
      await shader.dispatchWhenReady(Math.ceil(probes.length / 64), 1, 1);
      const view = await resultBuffer.read();
      const raw = new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + probes.length * 16));

      const sample: InfrastructureSurfaceSample = { surface: null, coverage: 0 };
      const local = { along: 0, across: 0 };
      // The runner-up coverage of a DIFFERENT material: where two segments'
      // coverages are within f32 rounding, either may win.
      const contested = (x: number, z: number, best: number): boolean => index.segments.some((packed) => {
        if (packed.segment.surface === undefined || packed.segment.surface === sample.surface) return false;
        infrastructureSegmentLocal(packed, x, z, local);
        const distance = infrastructureCapsuleDistance(local.along, local.across, packed.length);
        const coverage = Math.min(1, Math.max(0,
          0.5 + (packed.segment.halfWidth - distance) / INFRASTRUCTURE_SURFACE_FEATHER_METERS));
        return coverage > 0 && Math.abs(coverage - best) < 1e-3;
      });
      let worstCoverage = 0;
      let painted = 0;
      let wrongMaterial = 0;
      const byMaterial = new Map<number, number>();
      probes.forEach((probe, i) => {
        sampleInfrastructureSurface(index, probe.x, probe.z, sample);
        const id = raw[i * 4]!;
        const coverage = raw[i * 4 + 1]!;
        worstCoverage = Math.max(worstCoverage, Math.abs(coverage - sample.coverage));
        const expected = sample.surface === null ? -1 : INFRASTRUCTURE_SURFACE_MATERIAL[sample.surface];
        if (expected >= 0) {
          painted += 1;
          byMaterial.set(expected, (byMaterial.get(expected) ?? 0) + 1);
        }
        if (id !== expected && !contested(probe.x, probe.z, sample.coverage)) wrongMaterial += 1;
      });
      console.log(
        `surface parity over ${probes.length} probes (${painted} painted: `
        + `${[...byMaterial].map(([m, n]) => `${m}x${n}`).join(" ")}): `
        + `max |d coverage| = ${worstCoverage.toExponential(2)}, wrong material ${wrongMaterial}`,
      );
      expect(byMaterial.get(SurfaceMaterial.Concrete) ?? 0).toBeGreaterThan(5_000);
      expect(byMaterial.get(SurfaceMaterial.Asphalt) ?? 0).toBeGreaterThan(1_000);
      expect(byMaterial.get(SurfaceMaterial.Gravel) ?? 0).toBeGreaterThan(1_000);
      expect(wrongMaterial).toBe(0);
      expect(worstCoverage).toBeLessThan(1e-3);

      pageBuffer.dispose();
      dataBuffer.dispose();
      probeBuffer.dispose();
      resultBuffer.dispose();
    } finally {
      engine.stopRenderLoop();
      engine.dispose();
      canvas.remove();
    }
  }, 240_000);

  it("bakes Concrete and Gravel into the page splat and leaves the rest untouched", async () => {
    const world = createWorld("infrastructure-splat", { worldEvolution: "analytic" });
    const index = infrastructureIndex(world);
    expect(index.segments).toHaveLength(2);
    const address = createWorldPageAddress(0, 1, -1);
    const bounds = worldPageBounds(address, WORLD_PAGE_BASE_EXTENT_METERS);
    expect([bounds.minX, bounds.minZ]).toEqual([512, -512]);
    const texel = terrainChannelTexelSizeMeters(0);
    const landform = terrainLandformInput(world);
    expect(landform).not.toBeNull();

    const { engine, canvas } = await createEngine();
    let scene: Scene | null = null;
    try {
      scene = new Scene(engine);
      const base = resolveWebGpuQualityProfile("medium", "balanced");
      const profile = { ...base, heightAtlasSlots: 4, channelAtlasSlots: 4 };
      const heightAtlas = new TerrainPageAtlas(scene, profile, { kind: "height", worldRevision: "infra-splat" });
      const channelAtlas = new TerrainPageAtlas(scene, profile, {
        kind: "channel", worldRevision: "infra-splat", textureCount: TERRAIN_CHANNEL_TEXTURE_COUNT,
      });
      const generator = new TerrainPageGenerator(engine, heightAtlas, world.seedHash, world.airport ?? null, { world });
      const pyramid = new GlobalHeightPyramid(scene, engine, world.seedHash, { landform });
      heightAtlas.residency.beginFrame(1);
      channelAtlas.residency.beginFrame(1);
      const heightSlot = heightAtlas.residency.request(invariantSlotKey(address), address)!.slot;
      const channelSlot = channelAtlas.residency.request(invariantSlotKey(address), address)!.slot;
      await generator.generate([heightSlot]);
      await generator.settle();
      await pyramid.recenter(bounds.minX, bounds.minZ);

      const edge = TERRAIN_CHANNEL_SLOT_EDGE;
      const origin = channelAtlas.slotOrigin(channelSlot.slotIndex);
      const read = async (textureIndex: number): Promise<Uint8Array> =>
        await channelAtlas.texture(textureIndex)!.readPixels(
          0, 0, undefined, true, false, origin.u, origin.v, edge, edge,
        ) as Uint8Array;
      // The same page twice, over the same heights: painted, then without a
      // world (the empty index), so the only difference is the paint.
      const bakeWith = async (paintWorld: typeof world | null) => {
        const splat = new PageSplatBake(
          engine, heightAtlas, channelAtlas, world.seedHash, world.sourceSeedHash,
          world.seaLevel, world.latitudeDegrees, world.airport ?? null,
          null, landform, null, paintWorld,
        );
        expect(await splat.bake([channelSlot], 171)).toEqual([channelSlot]);
        const result = {
          ids: await read(TERRAIN_CHANNEL_TEXTURES.splatId),
          lo: await read(TERRAIN_CHANNEL_TEXTURES.splatWeightLo),
          hi: await read(TERRAIN_CHANNEL_TEXTURES.splatWeightHi),
        };
        splat.dispose();
        return result;
      };
      const painted = await bakeWith(world);
      const plain = await bakeWith(null);

      const sample: InfrastructureSurfaceSample = { surface: null, coverage: 0 };
      let full = 0;
      let fullOk = 0;
      let bare = 0;
      let bareIdentical = 0;
      let feather = 0;
      let featherCarries = 0;
      const idOf = (byte: number) => Math.round((byte / 255) * (SURFACE_MATERIAL_COUNT - 1));
      for (let row = WORLD_PAGE_GUTTER; row < edge - WORLD_PAGE_GUTTER; row += 1) {
        for (let col = WORLD_PAGE_GUTTER; col < edge - WORLD_PAGE_GUTTER; col += 1) {
          const at = (row * edge + col) * 4;
          const worldX = bounds.minX + (col - WORLD_PAGE_GUTTER + 0.5) * texel;
          const worldZ = bounds.minZ + (row - WORLD_PAGE_GUTTER + 0.5) * texel;
          sampleInfrastructureSurface(index, worldX, worldZ, sample);
          const expected = sample.surface === null ? -1 : INFRASTRUCTURE_SURFACE_MATERIAL[sample.surface];
          if (sample.coverage >= 1) {
            // All of it: the material alone, in slot 0, both seasons, and no
            // canopy in the closure lane.
            full += 1;
            if (
              idOf(painted.ids[at]!) === expected
              && painted.lo[at]! >= 254 && painted.hi[at]! >= 254
              && painted.lo[at + 3]! === 0
            ) fullOk += 1;
          } else if (sample.coverage > 0) {
            feather += 1;
            const ids = [0, 1, 2, 3].map((lane) => idOf(painted.ids[at + lane]!));
            if (ids.includes(expected)) featherCarries += 1;
          } else {
            bare += 1;
            let same = true;
            for (let lane = 0; lane < 4; lane += 1) {
              if (painted.ids[at + lane] !== plain.ids[at + lane]) same = false;
              if (painted.lo[at + lane] !== plain.lo[at + lane]) same = false;
              if (painted.hi[at + lane] !== plain.hi[at + lane]) same = false;
            }
            if (same) bareIdentical += 1;
          }
        }
      }
      console.log(
        `splat paint: ${full} fully painted (${fullOk} as the material alone), `
        + `${feather} feathered (${featherCarries} carry it), ${bare} bare (${bareIdentical} bit-identical)`,
      );
      expect(full).toBeGreaterThan(100);
      expect(fullOk).toBe(full);
      expect(feather).toBeGreaterThan(20);
      expect(featherCarries).toBe(feather);
      expect(bare).toBeGreaterThan(10_000);
      expect(bareIdentical).toBe(bare);

      pyramid.dispose();
      generator.dispose();
      channelAtlas.dispose();
      heightAtlas.dispose();
    } finally {
      scene?.dispose();
      engine.stopRenderLoop();
      engine.dispose();
      canvas.remove();
    }
  }, 300_000);
});
