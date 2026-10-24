import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  TERRAIN_KERNEL_PAGE_BYTES,
  TERRAIN_KERNEL_WGSL,
  buildTerrainKernelPageUniform,
  terrainKernelPageBindingWgsl,
} from "../../src/render/webgpu/terrain/TerrainKernel";
import {
  VOLCANIC_OVERLAY_WGSL,
  packVolcanicSiteIndex,
} from "../../src/render/webgpu/terrain/VolcanicOverlayKernel";
import { sampleNaturalTerrainHeight } from "../../src/world/terrain";
import {
  applyVolcanicOverlay,
  sampleVolcanicGround,
  volcanicSitesInBounds,
  type VolcanicSite,
} from "../../src/world/volcanism";
import { createWorld } from "../../src/world/world";
import type { WorldDefinition } from "../../src/world/types";

/**
 * The volcanic overlay agrees CPU-to-GPU: every profile, every flow, the
 * level sites and the ground covers, at the collision width and at two page
 * widths, read through the packed site index exactly as the bakes read it.
 */

const KERNEL = /* wgsl */ `
${terrainKernelPageBindingWgsl(0, 0)}
${TERRAIN_KERNEL_WGSL}

@group(0) @binding(1) var<storage, read> terrainVolcanicIndex: array<vec4f>;
// probes: two vec4 each, (base hi, base lo) and (local, height in, filter width)
@group(0) @binding(2) var<storage, read> probes: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> results: array<vec4f>;

${VOLCANIC_OVERLAY_WGSL}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes) / 2u) { return; }
  kSelectPage(0u);
  // Keep the kernel page binding reachable (see runway-earthworks-parity).
  let live = terrainKernelPages[kPageIndex].kept.w * 0.0;
  let base = probes[id.x * 2u];
  let rest = probes[id.x * 2u + 1u];
  let ground = terrainVolcanicGround(base, rest.xy, rest.w);
  results[id.x] = vec4f(terrainVolcanicOverlay(base, rest.xy, rest.z, rest.w) + live, ground);
}
`;

interface Probe {
  readonly world: WorldDefinition;
  readonly x: number;
  readonly z: number;
  readonly height: number;
  readonly filterWidth: number;
}

function probesAround(world: WorldDefinition, sites: readonly VolcanicSite[], out: Probe[]): void {
  for (const site of sites) {
    const reach = Math.min(site.footprintRadiusMeters, site.radiusMeters * 2.6);
    for (let ring = 0; ring < 9; ring += 1) {
      const r = reach * (ring / 8) ** 1.5;
      for (let spoke = 0; spoke < 16; spoke += 1) {
        const angle = spoke * (Math.PI / 8) + ring * 0.37 + site.id * 1e-9;
        const x = site.x + Math.cos(angle) * r;
        const z = site.z + Math.sin(angle) * r;
        const height = Math.fround(sampleNaturalTerrainHeight(world.seedHash, x, z, 0));
        for (const filterWidth of [0, 128, 512]) out.push({ world, x, z, height, filterWidth });
      }
    }
    // Along each flow.
    for (const flow of site.flows) {
      for (let step = 0; step <= 24; step += 1) {
        const along = flow.lengthMeters * (step / 24) * 1.05;
        for (const across of [-0.7, -0.45, -0.2, 0, 0.3, 0.55]) {
          const x = flow.startX + flow.directionX * along - flow.directionZ * across * flow.widthMeters * 2;
          const z = flow.startZ + flow.directionZ * along + flow.directionX * across * flow.widthMeters * 2;
          const height = Math.fround(sampleNaturalTerrainHeight(world.seedHash, x, z, 0));
          out.push({ world, x, z, height, filterWidth: 0 });
        }
      }
    }
  }
}

async function runOnGpu(
  world: WorldDefinition,
  centerX: number,
  centerZ: number,
  probes: readonly Probe[],
): Promise<Float32Array> {
  const index = packVolcanicSiteIndex(world, centerX, centerZ);
  // As a bake hands points over: a base on a 1 km lattice (a page origin),
  // split hi/lo in f64, and the small local offset from it.
  const probeData = new Float32Array(probes.length * 8);
  probes.forEach((probe, slot) => {
    const baseX = Math.floor(probe.x / 1_000) * 1_000 - index.originX;
    const baseZ = Math.floor(probe.z / 1_000) * 1_000 - index.originZ;
    probeData[slot * 8] = baseX;
    probeData[slot * 8 + 1] = baseZ;
    probeData[slot * 8 + 2] = baseX - Math.fround(baseX);
    probeData[slot * 8 + 3] = baseZ - Math.fround(baseZ);
    probeData[slot * 8 + 4] = probe.x - index.originX - baseX;
    probeData[slot * 8 + 5] = probe.z - index.originZ - baseZ;
    probeData[slot * 8 + 6] = probe.height;
    probeData[slot * 8 + 7] = probe.filterWidth;
  });
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
  try {
    await engine.initAsync();
    engine.runRenderLoop(() => {});
    const pageBuffer = new StorageBuffer(engine, TERRAIN_KERNEL_PAGE_BYTES);
    pageBuffer.update(new Uint8Array(buildTerrainKernelPageUniform({
      seedHash: world.seedHash, originX: 0, originZ: 0, filterWidthMeters: 0,
    })));
    const indexBuffer = new StorageBuffer(engine, index.data.byteLength);
    indexBuffer.update(new Uint8Array(index.data.buffer));
    const probeBuffer = new StorageBuffer(engine, probeData.byteLength);
    probeBuffer.update(new Uint8Array(probeData.buffer));
    const resultBuffer = new StorageBuffer(engine, probes.length * 16);
    const shader = new ComputeShader("volcanic-overlay-parity", engine, { computeSource: KERNEL }, {
      bindingsMapping: {
        terrainKernelPages: { group: 0, binding: 0 },
        terrainVolcanicIndex: { group: 0, binding: 1 },
        probes: { group: 0, binding: 2 },
        results: { group: 0, binding: 3 },
      },
    });
    shader.setStorageBuffer("terrainKernelPages", pageBuffer);
    shader.setStorageBuffer("terrainVolcanicIndex", indexBuffer);
    shader.setStorageBuffer("probes", probeBuffer);
    shader.setStorageBuffer("results", resultBuffer);
    const compileErrors: string[] = [];
    shader.onError = (_effect, message) => { compileErrors.push(String(message)); };
    const started = performance.now();
    while (performance.now() - started < 30_000 && compileErrors.length === 0) {
      if (shader.isReady()) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(compileErrors.join(" | ")).toBe("");
    await shader.dispatchWhenReady(Math.ceil(probes.length / 64), 1, 1);
    const view = await resultBuffer.read();
    const raw = new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + probes.length * 16));
    engine.stopRenderLoop();
    pageBuffer.dispose();
    indexBuffer.dispose();
    probeBuffer.dispose();
    resultBuffer.dispose();
    return raw;
  } finally {
    engine.dispose();
    canvas.remove();
  }
}

function compare(probes: readonly Probe[], raw: Float32Array, label: string): void {
  let worstHeight = 0;
  let worstPhysics = 0;
  let worstCover = 0;
  let worstAge = 0;
  let touched = 0;
  let worstAt = "";
  probes.forEach((probe, slot) => {
    const expected = applyVolcanicOverlay(probe.world, probe.x, probe.z, probe.height, probe.filterWidth);
    const ground = sampleVolcanicGround(probe.world, probe.x, probe.z, probe.filterWidth);
    if (expected !== probe.height) touched += 1;
    const delta = Math.abs(raw[slot * 4]! - expected);
    if (delta > worstHeight) {
      const kinds = volcanicSitesInBounds(probe.world, probe.x, probe.z, probe.x, probe.z)
        .map((site) => site.kind).join(",");
      worstAt = `(${probe.x.toFixed(1)}, ${probe.z.toFixed(1)}) width ${probe.filterWidth}, `
        + `sites [${kinds}], lava ${ground.lavaCover.toFixed(2)}, tephra ${ground.tephraCover.toFixed(2)}`;
    }
    worstHeight = Math.max(worstHeight, delta);
    if (probe.filterWidth === 0) worstPhysics = Math.max(worstPhysics, delta);
    worstCover = Math.max(
      worstCover,
      Math.abs(raw[slot * 4 + 1]! - ground.lavaCover),
      Math.abs(raw[slot * 4 + 2]! - ground.tephraCover),
    );
    if (Math.max(ground.lavaCover, ground.tephraCover) > 0.05) {
      worstAge = Math.max(worstAge, Math.abs(raw[slot * 4 + 3]! - ground.age));
    }
  });
  console.log(
    `volcanic overlay parity, ${label}: ${probes.length} probes (${touched} inside a footprint): `
    + `max |dh| ${(worstHeight * 1_000).toFixed(2)} mm (width 0: ${(worstPhysics * 1_000).toFixed(2)} mm), `
    + `max |d cover| ${worstCover.toExponential(2)}, max |d age| ${worstAge.toExponential(2)}; worst at ${worstAt}`,
  );
  expect(touched).toBeGreaterThan(probes.length * 0.5);
  // The kernel's near-field budget is 5 cm; physics reads the CPU, and the
  // rendered surface it lands on must sit within 5 mm of it.
  expect(worstHeight).toBeLessThan(0.05);
  expect(worstPhysics).toBeLessThan(0.005);
  expect(worstCover).toBeLessThan(2e-3);
  expect(worstAge).toBeLessThan(2e-3);
}

describe("volcanic overlay CPU/GPU parity", () => {
  it("agrees round the guaranteed field (stratovolcano, cones, maars, flows)", async () => {
    const world = createWorld("ash-lab");
    const all = volcanicSitesInBounds(world, -400_000, -400_000, 400_000, 400_000);
    const strato = all.find((site) => site.id % 4 === 2)!;
    const sites = volcanicSitesInBounds(
      world, strato.x - 30_000, strato.z - 30_000, strato.x + 30_000, strato.z + 30_000);
    const probes: Probe[] = [];
    probesAround(world, sites, probes);
    const raw = await runOnGpu(world, strato.x, strato.z, probes);
    compare(probes, raw, "guaranteed field");
  }, 240_000);

  it("agrees round a forced start, calderas and shields included", async () => {
    const world = createWorld("kilo77", { landforms: { volcanic: true } });
    const airport = world.airport!;
    const sites = volcanicSitesInBounds(
      world, airport.centerX - 40_000, airport.centerZ - 40_000, airport.centerX + 40_000, airport.centerZ + 40_000);
    const probes: Probe[] = [];
    probesAround(world, sites.slice(0, 60), probes);
    const raw = await runOnGpu(world, airport.centerX, airport.centerZ, probes);
    compare(probes, raw, "forced start");
  }, 240_000);
});
