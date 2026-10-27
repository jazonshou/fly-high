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
  TERRAIN_KERNEL_WGSL,
  buildTerrainKernelPageUniform,
  terrainKernelPageBindingWgsl,
  terrainLandformInput,
} from "../../src/render/webgpu/terrain/TerrainKernel";
import {
  applyInfrastructure,
  createWorld,
  infrastructureIndex,
  sampleTerrainHeightBeforeEarthworks,
  type WorldDefinition,
} from "../../src/world";
import { landformCoreCenter } from "../../src/world/landforms";
import { homeMarina } from "../../src/world/marina";
import { marinaToWorld } from "../../src/world/marinaLayout";

/**
 * The home marina's earthworks (src/world/marinaEarthworks.ts and the four
 * marina profiles) through the infrastructure stage's GPU twin, against the
 * CPU authority, on real worlds: one sheltered marina and one behind a
 * breakwater. Probes cover the basin, quay, car park, slipway and breakwater
 * on the real ground and on flat test grounds above and below every level the
 * profiles switch at. Agreement within 1 mm, as the runway earthworks.
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

/** Seeds: open skies (no breakwater) and one exposed enough for a breakwater. */
const SEEDS: readonly (string | number)[] = ["open-skies", 2_871_296_461];

interface Probe {
  readonly x: number;
  readonly z: number;
  readonly ground: number;
}

async function runParity(world: WorldDefinition, label: string): Promise<{ worst: number; changed: number; probes: number }> {
  const layout = homeMarina(world);
  const index = infrastructureIndex(world);
  const core = landformCoreCenter(world);
  const words = packTerrainInfrastructure(index, world.seaLevel, core);
  // One kernel page, its origin a few hundred metres off the site.
  const page = {
    x: Math.floor((layout.site.x - 300) / 512) * 512,
    z: Math.floor((layout.site.z - 300) / 512) * 512,
  };
  const pageBytes = new Uint8Array(buildTerrainKernelPageUniform({
    seedHash: world.seedHash, originX: page.x, originZ: page.z, filterWidthMeters: 0, landform: terrainLandformInput(world),
  }));

  const probes: Probe[] = [];
  const s = world.seaLevel;
  for (let right = -130; right <= 130; right += 1.37) {
    for (let out = -80; out <= 175; out += 1.29) {
      const p = marinaToWorld(layout.frame, right + 0.11, out - 0.07);
      probes.push({ x: p.x, z: p.z, ground: sampleTerrainHeightBeforeEarthworks(world, p.x, p.z) });
      for (const ground of [-7, -2.2, 0.4, 1.4, 2.6, 6]) probes.push({ x: p.x, z: p.z, ground: s + ground });
    }
  }
  const probeData = new Float32Array(probes.length * 4);
  probes.forEach((probe, i) => {
    probeData[i * 4] = probe.x - page.x;
    probeData[i * 4 + 1] = probe.z - page.z;
    probeData[i * 4 + 2] = probe.ground;
    probeData[i * 4 + 3] = 0;
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
    const shader = new ComputeShader("marina-earthworks-parity", engine, { computeSource: KERNEL }, {
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
    engine.stopRenderLoop();
    pageBuffer.dispose();
    dataBuffer.dispose();
    probeBuffer.dispose();
    resultBuffer.dispose();

    let worst = 0;
    let worstIndex = 0;
    let changed = 0;
    probes.forEach((probe, i) => {
      const expected = applyInfrastructure(index, s, probe.ground, probe.x, probe.z);
      if (Math.abs(expected - probe.ground) > 0.01) changed += 1;
      const delta = Math.abs(raw[i * 4]! - expected);
      if (delta > worst) {
        worst = delta;
        worstIndex = i;
      }
    });
    const at = probes[worstIndex]!;
    console.log(
      `marina earthworks parity (${label}): ${probes.length} probes, ${changed} moved, `
      + `max |dh| = ${(worst * 1_000).toFixed(3)} mm at ground ${at.ground.toFixed(2)}`,
    );
    return { worst, changed, probes: probes.length };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}

describe("home marina earthworks CPU/GPU parity", () => {
  it("shapes the marina's ground within 1 mm of the CPU authority", async () => {
    for (const seed of SEEDS) {
      const world = createWorld(seed);
      const result = await runParity(world, String(seed));
      // Most of the window is untouched ground; a good part is quay, basin or mound.
      expect(result.changed).toBeGreaterThan(result.probes / 10);
      expect(result.worst, String(seed)).toBeLessThan(0.001);
    }
    expect(homeMarina(createWorld(SEEDS[1]!)).breakwater).not.toBeNull();
  }, 240_000);
});
