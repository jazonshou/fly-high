import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
// Side-effect import: register the compute pipeline methods on WebGPUEngine.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  TERRAIN_KERNEL_PAGE_BYTES,
  TERRAIN_KERNEL_WGSL,
  buildTerrainKernelPageUniform,
  terrainKernelPageBindingWgsl,
} from "../../src/render/webgpu/terrain/TerrainKernel";
import { TERRAIN_HEIGHT_PARITY_CRITERIA } from "../../src/render/webgpu/terrain/TerrainSpineContract";
import {
  hashLatticeCoordinates,
  hashSeed,
  mixSeed,
  unitFloatFromHash,
} from "../../src/world/seed";
import { sampleNaturalTerrainHeight } from "../../src/world/terrain";

/**
 * `4-1`'s gate: the four parity criteria of `PHASE_4_EXECUTION_PLAN.md` §4 D6
 * (assertions 73, 74, 75), on a real adapter.
 *
 * `RENDERING_PLAN.md:347`'s single criterion — `|Δh| < 0.05 m at
 * |x| = 5×10⁶ m` over 4,096 Halton points — is replaced, because it is wrong
 * twice over. Measured naive-f32 divergence at 5×10⁶ m is 3.47 m, ~70× the
 * bound; and the POINT COUNT is part of the criterion, because a 3,000-point
 * probe reports a pass at ±10⁵ m that a 40,000-point probe fails.
 *
 * The harness is storage-buffer-only, so it does not depend on P2 (r32float
 * readback) — the same pattern `aerial-perspective-agreement.test.ts` proves.
 */

const SEED_HASH = hashSeed("terrain-parity");

const HASH_KERNEL = /* wgsl */ `
${terrainKernelPageBindingWgsl(0, 0)}
${TERRAIN_KERNEL_WGSL}

struct HashProbe { mixedHash: u32, x: i32, z: i32, channel: i32 };

@group(0) @binding(1) var<storage, read> probes: array<HashProbe>;
@group(0) @binding(2) var<storage, read_write> results: array<vec4f>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes)) { return; }
  let probe = probes[id.x];
  let lattice = kHashLatticeCoordinates(probe.mixedHash, probe.x, probe.z);
  // The page binding must stay REACHABLE: Tint prunes unreachable functions,
  // and a binding no live code reads disappears from the module's reflection,
  // which leaves Babylon's bindingsMapping pointing at nothing and the
  // dispatch silently writing zeros. kept.w is the page's filter width, and
  // adding zero times it is exact.
  kSelectPage(0u);
  let live = terrainKernelPages[kPageIndex].kept.w * 0.0;
  results[id.x] = vec4f(
    bitcast<f32>(lattice),
    bitcast<f32>(kMixSeed(probe.mixedHash, probe.channel)),
    kUnitFloatFromHash(lattice) + live,
    bitcast<f32>(kAvalanche(probe.mixedHash)),
  );
}
`;

const HEIGHT_KERNEL = /* wgsl */ `
${terrainKernelPageBindingWgsl(0, 0)}
${TERRAIN_KERNEL_WGSL}

struct HeightProbe { pageIndex: u32, pad: u32, localX: f32, localZ: f32 };

@group(0) @binding(1) var<storage, read> probes: array<HeightProbe>;
@group(0) @binding(2) var<storage, read_write> results: array<f32>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes)) { return; }
  let probe = probes[id.x];
  kSelectPage(probe.pageIndex);
  results[id.x] = terrainNaturalHeight(probe.localX, probe.localZ);
}
`;

/** Deterministic low-discrepancy sequence, so a failure is reproducible. */
function halton(index: number, base: number): number {
  let result = 0;
  let fraction = 1 / base;
  let i = index;
  while (i > 0) {
    result += (i % base) * fraction;
    i = Math.floor(i / base);
    fraction /= base;
  }
  return result;
}

interface ProbeSet {
  readonly pageOrigins: readonly (readonly [number, number])[];
  readonly probes: Float32Array;
  readonly pageIndices: Uint32Array;
  readonly worldX: Float64Array;
  readonly worldZ: Float64Array;
  readonly count: number;
}

/**
 * Build a probe set the way the renderer will actually use the kernel: a grid
 * of PAGE origins, each with local offsets inside one page extent. The
 * absolute coordinate never reaches the GPU, which is the property under
 * test.
 */
function buildProbes(radiusMeters: number, pagesPerAxis: number, perPage: number): ProbeSet {
  const pageOrigins: (readonly [number, number])[] = [];
  const step = (2 * radiusMeters) / pagesPerAxis;
  for (let row = 0; row < pagesPerAxis; row += 1) {
    for (let column = 0; column < pagesPerAxis; column += 1) {
      // Snap to the 512 m page lattice: these are real page origins.
      const x = Math.round((-radiusMeters + column * step) / 512) * 512;
      const z = Math.round((-radiusMeters + row * step) / 512) * 512;
      pageOrigins.push([x, z]);
    }
  }
  const count = pageOrigins.length * perPage;
  const probes = new Float32Array(count * 4);
  const pageIndices = new Uint32Array(probes.buffer);
  const worldX = new Float64Array(count);
  const worldZ = new Float64Array(count);
  let index = 0;
  for (let page = 0; page < pageOrigins.length; page += 1) {
    const [originX, originZ] = pageOrigins[page]!;
    for (let sample = 0; sample < perPage; sample += 1) {
      // 512 m of core plus the 4-texel gutter on both sides (8 m at L0).
      const localX = halton(sample + 1, 2) * 528 - 8;
      const localZ = halton(sample + 1, 3) * 528 - 8;
      pageIndices[index * 4] = page;
      probes[index * 4 + 2] = localX;
      probes[index * 4 + 3] = localZ;
      // The CPU oracle must be evaluated at the SAME point the GPU sees, so
      // the local offset is rounded to f32 first.
      worldX[index] = originX + Math.fround(localX);
      worldZ[index] = originZ + Math.fround(localZ);
      index += 1;
    }
  }
  return { pageOrigins, probes, pageIndices, worldX, worldZ, count };
}

function packPages(
  origins: readonly (readonly [number, number])[],
  filterWidthMeters: number,
): Uint8Array {
  const packed = new Uint8Array(origins.length * TERRAIN_KERNEL_PAGE_BYTES);
  origins.forEach(([originX, originZ], index) => {
    packed.set(
      new Uint8Array(buildTerrainKernelPageUniform({
        seedHash: SEED_HASH,
        originX,
        originZ,
        filterWidthMeters,
      })),
      index * TERRAIN_KERNEL_PAGE_BYTES,
    );
  });
  return packed;
}

async function withEngine<T>(run: (engine: WebGPUEngine) => Promise<T>): Promise<T> {
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
    const result = await run(engine);
    engine.stopRenderLoop();
    return result;
  } finally {
    engine.dispose();
    canvas.remove();
  }
}

async function dispatchHeights(
  engine: WebGPUEngine,
  set: ProbeSet,
  filterWidthMeters: number,
): Promise<Float32Array> {
  const pageBuffer = new StorageBuffer(engine, set.pageOrigins.length * TERRAIN_KERNEL_PAGE_BYTES);
  pageBuffer.update(packPages(set.pageOrigins, filterWidthMeters));
  const probeBuffer = new StorageBuffer(engine, set.probes.byteLength);
  probeBuffer.update(new Uint8Array(set.probes.buffer));
  const resultBuffer = new StorageBuffer(engine, set.count * 4);
  const shader = new ComputeShader(
    `terrain-height-parity-${filterWidthMeters}`,
    engine,
    { computeSource: HEIGHT_KERNEL },
    {
      bindingsMapping: {
        terrainKernelPages: { group: 0, binding: 0 },
        probes: { group: 0, binding: 1 },
        results: { group: 0, binding: 2 },
      },
    },
  );
  shader.setStorageBuffer("terrainKernelPages", pageBuffer);
  shader.setStorageBuffer("probes", probeBuffer);
  shader.setStorageBuffer("results", resultBuffer);
  await shader.dispatchWhenReady(Math.ceil(set.count / 64), 1, 1);
  const view = await resultBuffer.read();
  const heights = new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + set.count * 4));
  pageBuffer.dispose();
  probeBuffer.dispose();
  resultBuffer.dispose();
  return heights;
}

describe("terrain height kernel CPU/GPU parity (4-1)", () => {
  // Criterion 1 / assertion 73.
  it("reproduces the hash layer bit-exactly at every |x|", async () => {
    const probes: { mixedHash: number; x: number; z: number; channel: number }[] = [];
    for (const magnitude of [0, 1, 37, 4_096, 65_535, 65_536, 1_000_003, 2_147_483_600]) {
      for (const sign of [1, -1]) {
        for (const channel of [0, 1, 31, 145, -7]) {
          probes.push({
            mixedHash: mixSeed(SEED_HASH, channel) >>> 0,
            x: sign * magnitude,
            z: -sign * (magnitude ^ 0x5a5a),
            channel,
          });
        }
      }
    }
    const packed = new ArrayBuffer(probes.length * 16);
    const asU32 = new Uint32Array(packed);
    const asI32 = new Int32Array(packed);
    probes.forEach((probe, index) => {
      asU32[index * 4] = probe.mixedHash;
      asI32[index * 4 + 1] = probe.x | 0;
      asI32[index * 4 + 2] = probe.z | 0;
      asI32[index * 4 + 3] = probe.channel | 0;
    });

    const results = await withEngine(async (engine) => {
      const probeBuffer = new StorageBuffer(engine, packed.byteLength);
      probeBuffer.update(new Uint8Array(packed));
      const pageBuffer = new StorageBuffer(engine, TERRAIN_KERNEL_PAGE_BYTES);
      pageBuffer.update(new Uint8Array(buildTerrainKernelPageUniform({
        seedHash: SEED_HASH, originX: 0, originZ: 0, filterWidthMeters: 0,
      })));
      const resultBuffer = new StorageBuffer(engine, probes.length * 16);
      const shader = new ComputeShader(
        "terrain-hash-parity",
        engine,
        { computeSource: HASH_KERNEL },
        {
          bindingsMapping: {
            terrainKernelPages: { group: 0, binding: 0 },
            probes: { group: 0, binding: 1 },
            results: { group: 0, binding: 2 },
          },
        },
      );
      shader.setStorageBuffer("terrainKernelPages", pageBuffer);
      shader.setStorageBuffer("probes", probeBuffer);
      shader.setStorageBuffer("results", resultBuffer);
      await shader.dispatchWhenReady(Math.ceil(probes.length / 64), 1, 1);
      const view = await resultBuffer.read();
      const copy = view.buffer.slice(view.byteOffset, view.byteOffset + probes.length * 16);
      probeBuffer.dispose();
      pageBuffer.dispose();
      resultBuffer.dispose();
      return copy;
    });

    const gpuU32 = new Uint32Array(results);
    const gpuF32 = new Float32Array(results);
    probes.forEach((probe, index) => {
      const context = `probe ${index} (x=${probe.x}, z=${probe.z}, ch=${probe.channel})`;
      const expectedLattice = hashLatticeCoordinates(probe.mixedHash, probe.x, probe.z) >>> 0;
      // toBe, not toBeCloseTo: these are integer operations and seed.ts
      // already guarantees the 24-bit quotient is exact in f32.
      expect(gpuU32[index * 4], context).toBe(expectedLattice);
      expect(gpuU32[index * 4 + 1], context).toBe(mixSeed(probe.mixedHash, probe.channel) >>> 0);
      expect(gpuF32[index * 4 + 2], context).toBe(unitFloatFromHash(expectedLattice));
    });
  }, 120_000);

  // Criteria 2 and 3 / assertions 74 and 75.
  it("agrees with the TypeScript kernel across radius and filter width", async () => {
    const criteria = TERRAIN_HEIGHT_PARITY_CRITERIA;
    // 16×16 page origins × 160 local points = 40,960 points, over each of the
    // five filter widths. The count is part of the criterion.
    const near = buildProbes(criteria.nearRadiusMeters, 16, 160);
    expect(near.count).toBeGreaterThanOrEqual(criteria.nearMinimumSamples);
    const far = buildProbes(criteria.farRadiusMeters, 12, 90);

    // Criterion 3's tail: out to the wrap no-op radius (2.8e6 m at the finest
    // 43 m octave), where the plan's original single criterion put its
    // 5x10^6 m claim. Measured, and reported.
    const wrap = buildProbes(criteria.wrapRadiusMeters, 8, 60);
    const report: string[] = [];
    await withEngine(async (engine) => {
      for (const [set, radius, tolerance] of [
        [near, criteria.nearRadiusMeters, criteria.nearToleranceMeters],
        [far, criteria.farRadiusMeters, criteria.farToleranceMeters],
        [wrap, criteria.wrapRadiusMeters, criteria.wrapRadiusToleranceMeters],
      ] as const) {
        for (const filterWidthMeters of criteria.filterWidthsMeters) {
          const gpu = await dispatchHeights(engine, set, filterWidthMeters);
          let worst = 0;
          let worstIndex = 0;
          for (let index = 0; index < set.count; index += 1) {
            const expected = sampleNaturalTerrainHeight(
              SEED_HASH,
              set.worldX[index]!,
              set.worldZ[index]!,
              filterWidthMeters,
            );
            const delta = Math.abs(gpu[index]! - expected);
            if (delta > worst) {
              worst = delta;
              worstIndex = index;
            }
          }
          report.push(
            `±${radius} m, fw ${filterWidthMeters}: max |Δh| = ${worst.toFixed(5)} m `
            + `at (${set.worldX[worstIndex]!.toFixed(1)}, ${set.worldZ[worstIndex]!.toFixed(1)}) `
            + `over ${set.count} points`,
          );
          expect(
            worst,
            `±${radius} m at filter width ${filterWidthMeters} over ${set.count} points`,
          ).toBeLessThan(tolerance);
        }
      }
    });
    // Printed so the achieved bound is a recorded measurement, not a pass/fail
    // bit: `4-0`'s contract carries the radius this evidences.
    console.log(`terrain height parity:\n  ${report.join("\n  ")}`);
  }, 300_000);
});
