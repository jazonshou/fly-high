import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
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
  applyInfrastructure,
  buildInfrastructureIndex,
  createWorld,
  infrastructureCapsuleDistance,
  INFRASTRUCTURE_PROFILE,
  type InfrastructureSegment,
} from "../../src/world";
import { infrastructureSegmentLocal } from "../../src/world/infrastructure";
import { landformCoreCenter } from "../../src/world/landforms";

/**
 * The infrastructure stage's GPU twin (`TERRAIN_INFRASTRUCTURE_WGSL`) against
 * the CPU authority (`applyInfrastructure`) over every mode, the composition
 * order, round ends, a disc, a long diagonal road crossing many bins, a
 * site 30 km from the core centre, where a bare f32 world coordinate would be
 * a few millimetres coarse, and one 160 km out, as far from the others as
 * streamed regions can be from the home marina (past the 65 km a dense bin
 * grid could span). Agreement within 1 mm, as the runway earthworks.
 */

const KERNEL = /* wgsl */ `
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
  // probe = (local x, local z, ground, page index)
  kSelectPage(u32(probe.w));
  results[id.x] = vec4f(terrainInfrastructure(probe.x, probe.y, probe.z), 0.0, 0.0, 0.0);
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

describe("infrastructure stage CPU/GPU parity", () => {
  it("applies every segment within 1 mm of the CPU authority", async () => {
    const world = createWorld("alpha");
    const core = landformCoreCenter(world);
    const sites = [
      { x: core.x + 1_800, z: core.z - 2_300 },
      { x: core.x - 30_000, z: core.z + 21_000 },
      { x: core.x + 140_000, z: core.z - 80_000 },
    ];
    const segments: InfrastructureSegment[] = [];
    for (const site of sites) {
      // A dredged basin, a breakwater-like fill, an apron pad over both, a
      // round car park, and a diagonal access road through all of it.
      segments.push(
        segment({ mode: "cut", ax: site.x - 60, az: site.z, bx: site.x + 60, bz: site.z + 15, halfWidth: 35, reach: 25, params: [-3, 3] }),
        segment({ mode: "fill", priority: 1, ax: site.x - 90, az: site.z - 50, bx: site.x + 90, bz: site.z - 48, halfWidth: 4, reach: 8, params: [2, 1.5] }),
        segment({ priority: 2, ax: site.x + 70, az: site.z + 40, bx: site.x + 110, bz: site.z + 40, halfWidth: 12, reach: 18, params: [1.2, 2] }),
        segment({ priority: 2, ax: site.x - 120, az: site.z + 80, bx: site.x - 120, bz: site.z + 80, halfWidth: 25, reach: 15, params: [3.5, 2] }),
        segment({ priority: 3, ax: site.x - 900, az: site.z - 700, bx: site.x + 1_100, bz: site.z + 650, halfWidth: 3.5, reach: 14, params: [4, 2] }),
      );
    }
    const index = buildInfrastructureIndex(world, [() => ({ segments })]);
    const words = packTerrainInfrastructure(index, world.seaLevel, core);

    // One kernel page per site, origin a few hundred metres off it, the way a
    // real page's origin falls; probes are local to their page.
    const landform = terrainLandformInput(world);
    const pages = sites.map((site) => ({ x: Math.floor((site.x - 700) / 512) * 512, z: Math.floor((site.z - 700) / 512) * 512 }));
    const pageBytes = new Uint8Array(pages.length * TERRAIN_KERNEL_PAGE_BYTES);
    pages.forEach((page, i) => {
      pageBytes.set(new Uint8Array(buildTerrainKernelPageUniform({
        seedHash: world.seedHash, originX: page.x, originZ: page.z, filterWidthMeters: 0, landform,
      })), i * TERRAIN_KERNEL_PAGE_BYTES);
    });

    interface Probe { readonly page: number; readonly x: number; readonly z: number; readonly ground: number }
    const probes: Probe[] = [];
    sites.forEach((site, page) => {
      for (let i = -70; i <= 70; i += 1) {
        for (let j = -70; j <= 70; j += 1) {
          const x = site.x + i * 2.37 + 0.31;
          const z = site.z + j * 2.11 - 0.17;
          for (const ground of [-6, 0.4, 2.9, 11]) probes.push({ page, x, z, ground });
        }
      }
      // Along the road, both sides of it, out to its far end.
      for (let t = 0; t <= 400; t += 1) {
        const x = site.x - 900 + (2_000 * t) / 400;
        const z = site.z - 700 + (1_350 * t) / 400;
        for (const off of [-20, -9, -3.4, 0, 2, 7.7, 17.9]) {
          probes.push({ page, x: x + off * 0.56, z: z - off * 0.83, ground: 5 + Math.sin(t) * 6 });
        }
      }
    });
    const probeData = new Float32Array(probes.length * 4);
    probes.forEach((probe, i) => {
      const page = pages[probe.page]!;
      probeData[i * 4] = probe.x - page.x;
      probeData[i * 4 + 1] = probe.z - page.z;
      probeData[i * 4 + 2] = probe.ground;
      probeData[i * 4 + 3] = probe.page;
    });

    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
    try {
      await engine.initAsync();
      engine.runRenderLoop(() => {});
      const pageBuffer = new StorageBuffer(engine, pageBytes.byteLength);
      pageBuffer.update(pageBytes);
      const dataBuffer = new StorageBuffer(engine, words.byteLength);
      dataBuffer.update(words);
      const probeBuffer = new StorageBuffer(engine, probeData.byteLength);
      probeBuffer.update(new Uint8Array(probeData.buffer));
      const resultBuffer = new StorageBuffer(engine, probes.length * 16);
      const shader = new ComputeShader("infrastructure-parity", engine, { computeSource: KERNEL }, {
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

      let worst = 0;
      let worstIndex = 0;
      let changed = 0;
      let untouchedExact = 0;
      let untouched = 0;
      const local = { along: 0, across: 0 };
      const outsideEverySegment = (x: number, z: number) => index.segments.every((packed) => {
        infrastructureSegmentLocal(packed, x, z, local);
        // A centimetre clear of the reach, so f32 rounding cannot pull it in.
        return infrastructureCapsuleDistance(local.along, local.across, packed.length) >= packed.radius + 0.01;
      });
      probes.forEach((probe, i) => {
        const expected = applyInfrastructure(index, world.seaLevel, probe.ground, probe.x, probe.z);
        const gpu = raw[i * 4]!;
        if (expected !== probe.ground) changed += 1;
        if (outsideEverySegment(probe.x, probe.z)) {
          untouched += 1;
          if (gpu === Math.fround(probe.ground)) untouchedExact += 1;
        }
        const delta = Math.abs(gpu - expected);
        if (delta > worst) {
          worst = delta;
          worstIndex = i;
        }
      });
      console.log(
        `infrastructure parity over ${probes.length} probes (${changed} moved, ${untouched} out of reach): `
        + `max |dh| = ${(worst * 1_000).toFixed(3)} mm`,
      );
      expect(changed).toBeGreaterThan(50_000);
      // Ground no segment reaches passes through as itself, bit for bit.
      expect(untouched).toBeGreaterThan(50_000);
      expect(untouchedExact).toBe(untouched);
      expect(worst, `worst probe ${worstIndex}`).toBeLessThan(0.001);

      // An empty index (no sources: what every world ships with) passes every
      // height through bit for bit.
      dataBuffer.update(new Uint32Array(12));
      await shader.dispatchWhenReady(Math.ceil(probes.length / 64), 1, 1);
      const emptyView = await resultBuffer.read();
      const empty = new Float32Array(emptyView.buffer.slice(emptyView.byteOffset, emptyView.byteOffset + probes.length * 16));
      let emptyExact = 0;
      probes.forEach((probe, i) => {
        if (empty[i * 4] === Math.fround(probe.ground)) emptyExact += 1;
      });
      expect(emptyExact).toBe(probes.length);
      engine.stopRenderLoop();

      pageBuffer.dispose();
      dataBuffer.dispose();
      probeBuffer.dispose();
      resultBuffer.dispose();
    } finally {
      engine.dispose();
      canvas.remove();
    }
  }, 240_000);
});
