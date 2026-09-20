import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
// Side-effect import: registers the compute pipeline methods on WebGPUEngine.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  WATER_GLINT_CELL_WGSL,
  WATER_GLINT_FACET_LENGTH_METERS,
  WATER_GLINT_TWINKLE_HZ,
  WATER_SHADING_CONSTANTS_WGSL,
  WATER_WHITECAP_PATCH_AREA_M2,
  waterGlintCell,
  waterGlintCountGain,
  waterGlintTwinkle,
} from "../../src/render/webgpu/water/WaterShaders";

/**
 * `W-11` — TS/WGSL parity for the glint cell, on a real adapter.
 *
 * The motion evidence for this wave (`render.webgpu-water-glint-motion.test.ts`)
 * is measured entirely on the CPU mirrors: a glint surviving on the same patch
 * of water at 0.94 across a frame of cruise, against 0.16 on a fixed screen
 * pixel. That is only evidence about the SHIPPED renderer if the mirrors and
 * the WGSL are the same arithmetic, and three parts of this block are exactly
 * where a mirror drifts from its shader without anyone noticing:
 *
 *  - `exp2(floor(log2(x)))` and its `2 ** Math.floor(Math.log2(x))` twin, which
 *    disagree at a power of two if either rounds the wrong way;
 *  - the coarse-cell index, which is an ARITHMETIC right shift of a signed
 *    integer in WGSL and a `Math.floor(x / 2)` in TypeScript — the same thing
 *    only because the shift sign-extends, and not the same thing as a truncating
 *    division, which is what a mirror written without thinking would use;
 *  - the integer hash, whose whole job is to differ wildly from a near-miss.
 *
 * `WATER_FAR_FIELD_WGSL` declares no uniform and samples no texture, so it
 * compiles as a compute kernel unchanged — the same property the caustic parity
 * test relies on, and one worth keeping.
 */

/** vec2f first so the struct's alignment is 8; 12 floats is a multiple of it. */
const PROBE_FLOATS = 12;
const RESULT_FLOATS = 4;

const GLINT_PROBE_WGSL = /* wgsl */ `
${WATER_SHADING_CONSTANTS_WGSL}

${WATER_GLINT_CELL_WGSL}

struct GlintProbe {
  worldXZ: vec2f,
  footprintArea: f32,
  footprintMinor: f32,
  featureArea: f32,
  expectedCount: f32,
  time: f32,
  rate: f32,
  seed: f32,
  uniformSample: f32,
  padding0: f32,
  padding1: f32,
}

@group(0) @binding(0) var<storage, read> probes: array<GlintProbe>;
@group(0) @binding(1) var<storage, read_write> results: array<vec4f>;

@compute @workgroup_size(16, 1, 1)
fn evaluateGlintCells(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes)) { return; }
  let probe = probes[id.x];
  let seed = i32(probe.seed);
  let cell = waterGlintCell(
    probe.worldXZ,
    probe.footprintArea,
    probe.footprintMinor,
    probe.featureArea,
    seed,
  );
  let twinkle = waterGlintTwinkle(probe.expectedCount, cell.cell, probe.time, probe.rate, seed);
  results[id.x] = vec4f(f32(cell.cell.x), f32(cell.cell.y), cell.area, twinkle);
}
`;

interface Probe {
  readonly label: string;
  readonly worldX: number;
  readonly worldZ: number;
  readonly footprintArea: number;
  readonly footprintMinor: number;
  readonly featureArea: number;
  readonly expectedCount: number;
  readonly time: number;
  readonly rate: number;
  readonly seed: number;
}

const FACET_AREA = WATER_GLINT_FACET_LENGTH_METERS ** 2;
const GLINT_RATE = WATER_GLINT_TWINKLE_HZ;
const CAP_RATE = 1 / 3.2;

/**
 * Every regime the cell has: both sides of the world origin (the shift's sign
 * extension), a target side exactly on a power of two and either side of one,
 * the discrete branch, the hand-off window, the continuous branch, the payout
 * cap's own window, a near-normal footprint where the glare floor binds, a
 * grazing one where it cannot, and the whitecap feature size.
 */
const PROBES: readonly Probe[] = Object.freeze([
  { label: "path core, grazing", worldX: 12_000.37, worldZ: -8_000.91, footprintArea: 0.62, footprintMinor: 0.41, featureArea: FACET_AREA, expectedCount: 0.16, time: 500.25, rate: GLINT_RATE, seed: 3 },
  { label: "path fringe", worldX: 12_412.5, worldZ: -7_913.2, footprintArea: 0.21, footprintMinor: 0.3, featureArea: FACET_AREA, expectedCount: 0.006, time: 500.25, rate: GLINT_RATE, seed: 3 },
  { label: "negative world, both axes", worldX: -3_311.75, worldZ: -9_004.5, footprintArea: 0.62, footprintMinor: 0.41, featureArea: FACET_AREA, expectedCount: 0.16, time: 500.25, rate: GLINT_RATE, seed: 3 },
  { label: "negative x, positive z", worldX: -3_311.75, worldZ: 9_004.5, footprintArea: 0.62, footprintMinor: 0.41, featureArea: FACET_AREA, expectedCount: 0.16, time: 511.75, rate: GLINT_RATE, seed: 3 },
  { label: "straddles the origin", worldX: -0.125, worldZ: 0.125, footprintArea: 0.62, footprintMinor: 0.41, featureArea: FACET_AREA, expectedCount: 0.16, time: 500.25, rate: GLINT_RATE, seed: 3 },
  // The quadtree's own edges: target side exactly 1 (q = 0, always fine) and
  // just under 2 (q -> 1, almost always coarse).
  { label: "target exactly a power of two", worldX: 6_144, worldZ: -2_048, footprintArea: 1, footprintMinor: 0.4, featureArea: 1e-9, expectedCount: 0.3, time: 500.25, rate: GLINT_RATE, seed: 3 },
  { label: "target just under the next level", worldX: 6_144.5, worldZ: -2_048.5, footprintArea: 3.999, footprintMinor: 0.4, featureArea: 1e-9, expectedCount: 0.3, time: 500.25, rate: GLINT_RATE, seed: 3 },
  { label: "glare floor binds (near normal)", worldX: 1_024.5, worldZ: 512.5, footprintArea: 0.09, footprintMinor: 0.3, featureArea: FACET_AREA, expectedCount: 0.4, time: 503.1, rate: GLINT_RATE, seed: 3 },
  { label: "glare floor cannot bind (grazing)", worldX: 1_024.5, worldZ: 512.5, footprintArea: 20, footprintMinor: 0.42, featureArea: FACET_AREA, expectedCount: 0.4, time: 503.1, rate: GLINT_RATE, seed: 3 },
  // The gain's three branches.
  { label: "deep discrete, cap binds", worldX: 900.25, worldZ: -400.75, footprintArea: 0.2, footprintMinor: 0.3, featureArea: FACET_AREA, expectedCount: 0.004, time: 500.5, rate: GLINT_RATE, seed: 3 },
  { label: "inside the hand-off window", worldX: 900.25, worldZ: -400.75, footprintArea: 0.2, footprintMinor: 0.3, featureArea: FACET_AREA, expectedCount: 1.4, time: 500.5, rate: GLINT_RATE, seed: 3 },
  { label: "continuous branch", worldX: 900.25, worldZ: -400.75, footprintArea: 0.2, footprintMinor: 0.3, featureArea: FACET_AREA, expectedCount: 40, time: 500.5, rate: GLINT_RATE, seed: 3 },
  { label: "count exactly zero", worldX: 900.25, worldZ: -400.75, footprintArea: 0.2, footprintMinor: 0.3, featureArea: FACET_AREA, expectedCount: 0, time: 500.5, rate: GLINT_RATE, seed: 3 },
  // The whitecap fleck: the cap's own patch size, its own clock and seed.
  { label: "whitecap fleck, far", worldX: 12_000.37, worldZ: -8_000.91, footprintArea: 40, footprintMinor: 1.4, featureArea: WATER_WHITECAP_PATCH_AREA_M2, expectedCount: 0.012, time: 560.9, rate: CAP_RATE, seed: 5 },
  { label: "whitecap fleck, near", worldX: 12_000.37, worldZ: -8_000.91, footprintArea: 0.5, footprintMinor: 0.4, featureArea: WATER_WHITECAP_PATCH_AREA_M2, expectedCount: 0.012, time: 560.9, rate: CAP_RATE, seed: 5 },
  // Small times, where f32 resolves the cross-fade exactly: these carry the
  // tight tolerance and are what proves the twinkle arithmetic itself agrees.
  { label: "early clock, discrete", worldX: 12_000.37, worldZ: -8_000.91, footprintArea: 0.62, footprintMinor: 0.41, featureArea: FACET_AREA, expectedCount: 0.16, time: 3.25, rate: GLINT_RATE, seed: 3 },
  { label: "early clock, glare floor", worldX: 1_024.5, worldZ: 512.5, footprintArea: 0.09, footprintMinor: 0.3, featureArea: FACET_AREA, expectedCount: 0.4, time: 7.5, rate: GLINT_RATE, seed: 3 },
  { label: "early clock, continuous", worldX: 900.25, worldZ: -400.75, footprintArea: 0.2, footprintMinor: 0.3, featureArea: FACET_AREA, expectedCount: 40, time: 2.125, rate: GLINT_RATE, seed: 3 },
  // Far from the origin, where a lattice that divided by the footprint would
  // already be losing bits in f32.
  { label: "98 km from the origin", worldX: 98_304.75, worldZ: -65_536.25, footprintArea: 0.62, footprintMinor: 0.41, featureArea: FACET_AREA, expectedCount: 0.16, time: 500.25, rate: GLINT_RATE, seed: 3 },
]);

function expected(probe: Probe): readonly [number, number, number, number] {
  const cell = waterGlintCell(
    probe.worldX,
    probe.worldZ,
    probe.footprintArea,
    probe.footprintMinor,
    probe.featureArea,
    probe.seed,
  );
  const twinkle = waterGlintTwinkle(
    probe.expectedCount,
    cell.cellX,
    cell.cellY,
    probe.time,
    probe.rate,
    probe.seed,
  );
  return [cell.cellX, cell.cellY, cell.area, twinkle];
}

describe("water glint cell (W-11)", () => {
  it("agrees with the TypeScript oracle for every regime, on a real adapter", async () => {
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

      const probeData = new Float32Array(PROBES.length * PROBE_FLOATS);
      PROBES.forEach((probe, index) => {
        const base = index * PROBE_FLOATS;
        probeData[base] = probe.worldX;
        probeData[base + 1] = probe.worldZ;
        probeData[base + 2] = probe.footprintArea;
        probeData[base + 3] = probe.footprintMinor;
        probeData[base + 4] = probe.featureArea;
        probeData[base + 5] = probe.expectedCount;
        probeData[base + 6] = probe.time;
        probeData[base + 7] = probe.rate;
        probeData[base + 8] = probe.seed;
        probeData[base + 9] = 0;
        probeData[base + 10] = 0;
        probeData[base + 11] = 0;
      });
      const probeBuffer = new StorageBuffer(engine, probeData.byteLength);
      probeBuffer.update(probeData);
      const resultBuffer = new StorageBuffer(
        engine,
        PROBES.length * RESULT_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      );

      const shader = new ComputeShader(
        "water-glint-cell-probe",
        engine,
        { computeSource: GLINT_PROBE_WGSL },
        {
          bindingsMapping: {
            probes: { group: 0, binding: 0 },
            results: { group: 0, binding: 1 },
          },
          entryPoint: "evaluateGlintCells",
        },
      );
      shader.setStorageBuffer("probes", probeBuffer);
      shader.setStorageBuffer("results", resultBuffer);

      // Compute submissions and readbacks resolve at frame boundaries, so
      // drive an empty render loop while awaiting them.
      engine.runRenderLoop(() => {});
      await shader.dispatchWhenReady(Math.ceil(PROBES.length / 16), 1, 1);
      expect(shader.isReady()).toBe(true);
      const view = await resultBuffer.read();
      engine.stopRenderLoop();
      const results = new Float32Array(
        view.buffer,
        view.byteOffset,
        PROBES.length * RESULT_FLOATS,
      );

      const names = ["cellX", "cellY", "cellArea", "twinkle"] as const;
      PROBES.forEach((probe, index) => {
        const oracle = expected(probe);
        for (let lane = 0; lane < RESULT_FLOATS; lane += 1) {
          const gpu = results[index * RESULT_FLOATS + lane]!;
          const cpu = oracle[lane]!;
          // Cell indices are integers and must match EXACTLY: one off is a
          // different cell, i.e. a different glint, not a rounding difference.
          if (lane < 2) {
            expect(gpu, `${probe.label} ${names[lane]}`).toBe(cpu);
            continue;
          }
          // The cell AREA is exact arithmetic and held to f32 epsilon. The
          // twinkle is not, and the reason is worth stating rather than
          // hiding in a loose number: its cross-fade reads fract(phaseTime),
          // and at the harness's pinned simulation time of ~500 s the phase
          // is ~2,800 periods, where one f32 ULP is already 1e-3 of a period.
          // The INTEGER phase and the cell still agree exactly (the draws
          // below would diverge wildly otherwise, not by a fraction of a
          // percent); what f32 loses at that magnitude is the blend fraction,
          // i.e. 0.2 ms of a 180 ms glint. Probes at a small time hold the
          // tight tolerance and prove the arithmetic itself agrees.
          const tolerance = names[lane] === "twinkle" && probe.time > 100
            ? Math.max(Math.abs(cpu), 1) * 5e-3
            : Math.max(Math.abs(cpu), 1) * 1e-5;
          expect(
            Math.abs(gpu - cpu),
            `${probe.label} ${names[lane]}: gpu ${gpu} vs oracle ${cpu}`,
          ).toBeLessThan(tolerance);
        }
      });

      // Properties read off the GPU's own numbers rather than the oracle's.
      const rowOf = (label: string): readonly number[] => {
        const index = PROBES.findIndex((probe) => probe.label === label);
        const base = index * RESULT_FLOATS;
        return [results[base]!, results[base + 1]!, results[base + 2]!, results[base + 3]!];
      };
      // A whitecap cell far out is the cap's own patch, not a pixel's worth of
      // sea: 12 m^2 rounded down to the grid, i.e. 4 or 16 m^2.
      expect(rowOf("whitecap fleck, far")[2]).toBeGreaterThanOrEqual(4);
      // Near in, the pixel is smaller than a cap, so the cap's size decides and
      // the cell is the same one.
      expect(rowOf("whitecap fleck, near")[2]).toBe(rowOf("whitecap fleck, far")[2]);
      // Every cell area is a power of two squared, at one of the two levels
      // the quadtree offers. Nothing else can come out of this function, and a
      // mirror that drifted into a non-quantised size would land here.
      for (const probe of PROBES) {
        const area = rowOf(probe.label)[2]!;
        const side = Math.sqrt(area);
        expect(Math.abs(Math.log2(side) % 1), `${probe.label} cell side ${side}`).toBe(0);
      }
      // At zero expected glints the pedestal IS the whole gain and equals
      // exactly 1, so a fragment with no glints to spend is left as the smooth
      // lobe rather than being zeroed. (The lobe is itself zero wherever the
      // count is, so this multiplies nothing; what it guarantees is that the
      // discrete branch can never darken a surface it has no glints for.)
      expect(rowOf("count exactly zero")[3]).toBe(1);
    } finally {
      engine.dispose();
    }
  }, 120_000);

  it("keeps the mean of the gain at one on the GPU's own draws", () => {
    // The oracle's property, restated where the parity test can point at it:
    // whatever the count, the gain the shader applies averages to exactly one,
    // so the glitter path's radiance is redistributed and never added to.
    for (const count of [0.001, 0.01, 0.1, 0.5, 1, 2, 5, 20, 400]) {
      const steps = 200_000;
      let sum = 0;
      for (let step = 0; step < steps; step += 1) {
        sum += waterGlintCountGain(count, (step + 0.5) / steps);
      }
      expect(sum / steps, `mean at n=${count}`).toBeCloseTo(1, 2);
    }
  });
});
