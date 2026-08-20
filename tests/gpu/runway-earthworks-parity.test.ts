import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  RUNWAY_EARTHWORKS_UNIFORM_FLOATS,
  RUNWAY_EARTHWORKS_WGSL,
  packRunwayEarthworksUniform,
  runwayEarthworksHeightLocal,
  runwayPlatformHalfLength,
  runwayPlatformHalfWidth,
} from "../../src/render/webgpu/terrain/RunwayEarthworks";
import { RUNWAY_SDF_WGSL } from "../../src/render/webgpu/terrain/RunwaySurface";
import {
  TERRAIN_KERNEL_PAGE_BYTES,
  TERRAIN_KERNEL_WGSL,
  buildTerrainKernelPageUniform,
  terrainKernelPageBindingWgsl,
} from "../../src/render/webgpu/terrain/TerrainKernel";
import { createWorld, worldToRunway } from "../../src/world";

/**
 * `4-9`'s gate (assertion 82): the runway earthworks agree CPU-to-GPU to
 * within 1 mm across the apron, the shoulder band, the whole
 * `terrainBlendDistance` fade and 20 m beyond it.
 *
 * The regime coverage is the point. The two physics entry points take
 * DIFFERENT short-circuits — `sampleTerrainCollisionHeight` returns early on
 * `getAirportInfluence >= 1` (the full graded platform) while the render path
 * evaluates the fade — so a probe confined to the paved rectangle would test
 * the branch that is analytic on both sides and miss the one that is not.
 */

const KERNEL = /* wgsl */ `
${terrainKernelPageBindingWgsl(0, 0)}
${TERRAIN_KERNEL_WGSL}
${RUNWAY_SDF_WGSL}
${RUNWAY_EARTHWORKS_WGSL}

@group(0) @binding(1) var<storage, read> earthworks: RunwayEarthworks;
@group(0) @binding(2) var<storage, read> probes: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> results: array<vec4f>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes)) { return; }
  kSelectPage(0u);
  // The kernel page binding must stay REACHABLE. This kernel needs only the
  // include's noise and math helpers, so Tint prunes every function that
  // touches the page, the binding vanishes from the module's reflection, and
  // Babylon's bind group then carries an entry the layout does not have —
  // which invalidates the whole command buffer and writes zeros.
  let live = terrainKernelPages[kPageIndex].kept.w * 0.0;
  let probe = probes[id.x];
  // probe = (world x, world z, natural height, unused)
  let local = terrainRunwayLocal(
    vec2f(probe.x, probe.y), earthworks.site.yz, earthworks.frame.x, earthworks.frame.y);
  results[id.x] = vec4f(
    terrainRunwayEarthworksHeight(earthworks, probe.z, probe.x, probe.y) + live,
    terrainRunwayRoundedRect(local.x, local.y, earthworks.frame.z, earthworks.frame.w),
    local.x,
    local.y,
  );
}
`;

describe("runway earthworks CPU/GPU parity (4-9)", () => {
  it("agrees within 1 mm across apron, shoulder, fade and beyond", async () => {
    const world = createWorld("earthworks-parity");
    const airport = world.airport!;
    expect(airport).toBeTruthy();
    const halfLength = runwayPlatformHalfLength(airport);
    const halfWidth = runwayPlatformHalfWidth(airport);
    const reach = airport.terrainBlendDistance + 20;

    interface Probe {
      readonly x: number;
      readonly z: number;
      readonly natural: number;
    }
    const probes: Probe[] = [];
    // A dense grid over every regime, in RUNWAY-LOCAL coordinates so the
    // apron, the shoulder band and the fade are all sampled by construction.
    for (let alongStep = -34; alongStep <= 34; alongStep += 1) {
      for (let acrossStep = -34; acrossStep <= 34; acrossStep += 1) {
        const along = (alongStep / 34) * (halfLength + reach);
        const across = (acrossStep / 34) * (halfWidth + reach);
        const sin = Math.sin(airport.headingRadians);
        const cos = Math.cos(airport.headingRadians);
        const x = airport.centerX + along * sin + across * cos;
        const z = airport.centerZ + along * cos - across * sin;
        // Natural heights that straddle the platform datum, so the cut/fill
        // blend and its bench lobe are both exercised on both sides.
        for (const offset of [-9, -1.5, 0, 1.5, 9]) {
          probes.push({ x, z, natural: airport.elevation + offset });
        }
      }
    }
    expect(probes.length).toBeGreaterThan(20_000);

    const probeData = new Float32Array(probes.length * 4);
    probes.forEach((probe, index) => {
      probeData[index * 4] = probe.x;
      probeData[index * 4 + 1] = probe.z;
      probeData[index * 4 + 2] = probe.natural;
    });

    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, {
      antialias: false,
      enableAllFeatures: false,
      setMaximumLimits: false,
    });
    try {
      await engine.initAsync();
      engine.runRenderLoop(() => {});
      const pageBuffer = new StorageBuffer(engine, TERRAIN_KERNEL_PAGE_BYTES);
      pageBuffer.update(new Uint8Array(buildTerrainKernelPageUniform({
        seedHash: world.seedHash, originX: 0, originZ: 0, filterWidthMeters: 0,
      })));
      const uniformBuffer = new StorageBuffer(engine, RUNWAY_EARTHWORKS_UNIFORM_FLOATS * 4);
      uniformBuffer.update(new Uint8Array(
        packRunwayEarthworksUniform(airport, world.seedHash).buffer,
      ));
      const probeBuffer = new StorageBuffer(engine, probeData.byteLength);
      probeBuffer.update(new Uint8Array(probeData.buffer));
      const resultBuffer = new StorageBuffer(engine, probes.length * 16);

      const shader = new ComputeShader(
        "runway-earthworks-parity",
        engine,
        { computeSource: KERNEL },
        {
          bindingsMapping: {
            terrainKernelPages: { group: 0, binding: 0 },
            earthworks: { group: 0, binding: 1 },
            probes: { group: 0, binding: 2 },
            results: { group: 0, binding: 3 },
          },
        },
      );
      shader.setStorageBuffer("terrainKernelPages", pageBuffer);
      shader.setStorageBuffer("earthworks", uniformBuffer);
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
      const raw = new Float32Array(
        view.buffer.slice(view.byteOffset, view.byteOffset + probes.length * 16),
      );
      const gpu = new Float32Array(probes.length);
      for (let index = 0; index < probes.length; index += 1) gpu[index] = raw[index * 4]!;
      engine.stopRenderLoop();

      let worst = 0;
      let worstIndex = 0;
      let onPlatform = 0;
      let inFade = 0;
      let beyond = 0;
      probes.forEach((probe, index) => {
        const local = worldToRunway(airport, probe.x, probe.z);
        const expected = runwayEarthworksHeightLocal(
          airport,
          probe.natural,
          local.along,
          local.across,
          probe.x,
          probe.z,
          world.seedHash,
        );
        if (Math.abs(expected - probe.natural) < 1e-9) beyond += 1;
        else if (Math.abs(expected - airport.elevation) <= 0.36) onPlatform += 1;
        else inFade += 1;
        const delta = Math.abs(gpu[index]! - expected);
        if (delta > worst) {
          worst = delta;
          worstIndex = index;
        }
      });
      console.log(
        `runway earthworks parity over ${probes.length} probes `
        + `(${onPlatform} platform, ${inFade} batter, ${beyond} untouched): `
        + `max |Δh| = ${(worst * 1_000).toFixed(3)} mm`,
      );
      // The runway-local frame must actually agree: a rotation that is right
      // by luck at the centre and wrong at the ends would still pass a height
      // bound taken only near the apron.
      for (const index of [0, Math.floor(probes.length / 2), probes.length - 1]) {
        const local = worldToRunway(airport, probes[index]!.x, probes[index]!.z);
        expect(raw[index * 4 + 2]!, `along ${index}`).toBeCloseTo(local.along, 1);
        expect(raw[index * 4 + 3]!, `across ${index}`).toBeCloseTo(local.across, 1);
      }
      // Every regime must actually be represented, or the bound is about a
      // branch nobody took.
      expect(onPlatform).toBeGreaterThan(100);
      expect(inFade).toBeGreaterThan(100);
      expect(beyond).toBeGreaterThan(100);
      expect(worst, `worst probe ${worstIndex}`).toBeLessThan(0.001);

      pageBuffer.dispose();
      uniformBuffer.dispose();
      probeBuffer.dispose();
      resultBuffer.dispose();
    } finally {
      engine.dispose();
      canvas.remove();
    }
  }, 240_000);
});
