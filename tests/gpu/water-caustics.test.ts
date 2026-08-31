import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
// Side-effect import: registers the compute pipeline methods on WebGPUEngine.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  WATER_CAPILLARY_DETAIL_WGSL,
  WATER_CAUSTIC_WGSL,
  WATER_CAUSTIC_ZERO,
  WATER_DETAIL_NOISE_WGSL,
  waterCausticBand,
  waterCausticBedGain,
  waterCausticCascadeBands,
  waterCausticNoiseBand,
  waterCausticSinusoidBand,
  waterRefractedSunBeam,
} from "../../src/render/webgpu/water/WaterShaders";

/**
 * 6-4 — TS/WGSL parity for the bed-caustic model, on a real adapter.
 *
 * `WATER_CAUSTIC_WGSL` is deliberately self-contained pure arithmetic — it
 * declares no uniform and samples no texture — precisely so that the block the
 * two water FRAGMENT shaders compose can also be compiled and executed here as
 * a compute kernel. The exported TypeScript functions in `WaterShaders.ts` are
 * the oracle; the Node suite sweeps hundreds of thousands of field samples
 * through them, and this test is what makes that sweep evidence about the
 * shipped shader rather than about a lookalike.
 *
 * The Tint front end also accepts WGSL that other back ends reject (the house
 * lesson behind assertion 51b), so this is a compile gate for the block too,
 * not only a numeric one.
 */

/** Two vec4f plus twelve f32; the struct's 16-byte alignment already divides. */
const PROBE_FLOATS = 20;
const RESULT_FLOATS = 4;

const CAUSTIC_PROBE_WGSL = /* wgsl */ `
${WATER_CAUSTIC_WGSL}

// vec4f members force 16-byte alignment; the host writer below mirrors this
// layout field for field.
struct CausticProbe {
  jacobians: vec4f,
  cascadeScales: vec4f,
  depth: f32,
  sunElevationSine: f32,
  curvature: f32,
  curvatureRms: f32,
  sunVisibility: f32,
  noiseValue: f32,
  noiseCurvatureScale: f32,
  sinusoidPhase: f32,
  sinusoidCurvature: f32,
  jacobian4: f32,
  cascadeScale4: f32,
  padding: f32,
}

@group(0) @binding(0) var<storage, read> probes: array<CausticProbe>;
@group(0) @binding(1) var<storage, read_write> results: array<vec4f>;

@compute @workgroup_size(16, 1, 1)
fn evaluateCaustics(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes)) { return; }
  let probe = probes[id.x];
  let beam = waterRefractedSunBeam(probe.depth, probe.sunElevationSine);
  var caustic = waterCausticBand(
    WaterCaustic(0.0, 0.0),
    probe.curvature,
    probe.curvatureRms,
    beam,
  );
  caustic = waterCausticNoiseBand(caustic, probe.noiseValue, probe.noiseCurvatureScale, beam);
  caustic = waterCausticSinusoidBand(caustic, probe.sinusoidPhase, probe.sinusoidCurvature, beam);
  caustic = waterCausticCascadeBands(
    caustic,
    probe.jacobians,
    probe.jacobian4,
    probe.cascadeScales,
    probe.cascadeScale4,
    beam,
  );
  results[id.x] = vec4f(
    beam.slantMeters,
    beam.weight,
    caustic.curvature,
    waterCausticBedGain(caustic, beam, probe.sunVisibility),
  );
}
`;

type Vec4 = readonly [number, number, number, number];

interface Probe {
  readonly label: string;
  readonly depth: number;
  readonly sunElevationSine: number;
  readonly curvature: number;
  readonly curvatureRms: number;
  readonly sunVisibility: number;
  readonly noiseValue: number;
  readonly noiseCurvatureScale: number;
  readonly sinusoidPhase?: number;
  readonly sinusoidCurvature?: number;
  readonly jacobians?: Vec4;
  readonly jacobian4?: number;
  readonly cascadeScales?: Vec4;
  readonly cascadeScale4?: number;
}

/** The shipped default cascades' k/choppiness, all five lanes active. */
const DEFAULT_CASCADE_SCALES: Vec4 = [2.7318, 0.34148, 0.085371, 0.021343];
const DEFAULT_CASCADE_SCALE_4 = 0.0053357;
/** A crest in cascade 0, near-neutral in the rest — the common real case. */
const CREST_JACOBIANS: Vec4 = [0.91, 0.97, 0.995, 1.001];

/**
 * Every regime the term has: dry bed, the shallow ripple band, the focus, past
 * the focus, a trough, the gate edges, night, shadow, and a grazing sun.
 */
const PROBES: readonly Probe[] = Object.freeze([
  { label: "dry bed", depth: 0, sunElevationSine: 0.9, curvature: -3, curvatureRms: 3, sunVisibility: 1, noiseValue: 0.9, noiseCurvatureScale: 4 },
  { label: "puddle, fine band", depth: 0.4, sunElevationSine: 0.9, curvature: -3.2, curvatureRms: 3.3, sunVisibility: 1, noiseValue: 0.82, noiseCurvatureScale: 15.36 },
  { label: "shallow crest", depth: 1.5, sunElevationSine: 0.75, curvature: -1.1, curvatureRms: 1.2, sunVisibility: 1, noiseValue: 0.77, noiseCurvatureScale: 5.62 },
  { label: "shallow trough", depth: 1.5, sunElevationSine: 0.75, curvature: 1.1, curvatureRms: 1.2, sunVisibility: 1, noiseValue: 0.19, noiseCurvatureScale: 5.62 },
  { label: "at the focus", depth: 6, sunElevationSine: 0.9, curvature: -0.63, curvatureRms: 0.17, sunVisibility: 1, noiseValue: 0.5, noiseCurvatureScale: 0 },
  { label: "past the focus", depth: 6, sunElevationSine: 0.9, curvature: -1.4, curvatureRms: 0.17, sunVisibility: 1, noiseValue: 0.5, noiseCurvatureScale: 0 },
  { label: "flat surface", depth: 3, sunElevationSine: 0.9, curvature: 0, curvatureRms: 0, sunVisibility: 1, noiseValue: 0.5, noiseCurvatureScale: 0 },
  { label: "mid depth", depth: 9, sunElevationSine: 0.55, curvature: -0.18, curvatureRms: 0.164, sunVisibility: 0.8, noiseValue: 0.63, noiseCurvatureScale: 3.1 },
  { label: "inside the fade", depth: 16, sunElevationSine: 0.6, curvature: -0.2, curvatureRms: 0.164, sunVisibility: 1, noiseValue: 0.44, noiseCurvatureScale: 3.1 },
  { label: "gate edge", depth: 23.99, sunElevationSine: 0.6, curvature: -0.2, curvatureRms: 0.164, sunVisibility: 1, noiseValue: 0.44, noiseCurvatureScale: 3.1 },
  { label: "beyond the gate", depth: 24.5, sunElevationSine: 0.6, curvature: -0.2, curvatureRms: 0.164, sunVisibility: 1, noiseValue: 0.44, noiseCurvatureScale: 3.1 },
  { label: "deep ocean", depth: 3_800, sunElevationSine: 0.6, curvature: -0.2, curvatureRms: 0.164, sunVisibility: 1, noiseValue: 0.44, noiseCurvatureScale: 3.1 },
  { label: "grazing sun", depth: 5, sunElevationSine: 0.05, curvature: -0.5, curvatureRms: 0.5, sunVisibility: 1, noiseValue: 0.7, noiseCurvatureScale: 3.1 },
  { label: "night", depth: 5, sunElevationSine: -0.4, curvature: -0.5, curvatureRms: 0.5, sunVisibility: 1, noiseValue: 0.7, noiseCurvatureScale: 3.1 },
  { label: "full shadow", depth: 5, sunElevationSine: 0.9, curvature: -0.5, curvatureRms: 0.5, sunVisibility: 0, noiseValue: 0.7, noiseCurvatureScale: 3.1 },
  { label: "partial shadow", depth: 5, sunElevationSine: 0.9, curvature: -0.5, curvatureRms: 0.5, sunVisibility: 0.35, noiseValue: 0.7, noiseCurvatureScale: 3.1 },
  { label: "full sun twin", depth: 5, sunElevationSine: 0.9, curvature: -0.5, curvatureRms: 0.5, sunVisibility: 1, noiseValue: 0.7, noiseCurvatureScale: 3.1 },
  // The two composed bands the water materials actually call: the spectrum's
  // five cascade lanes, and the inland surface's analytic sinusoid.
  { label: "spectral crest", depth: 12, sunElevationSine: 0.85, curvature: 0, curvatureRms: 0, sunVisibility: 1, noiseValue: 0.5, noiseCurvatureScale: 0, jacobians: CREST_JACOBIANS, jacobian4: 0.9998, cascadeScales: DEFAULT_CASCADE_SCALES, cascadeScale4: DEFAULT_CASCADE_SCALE_4 },
  { label: "spectral trough", depth: 12, sunElevationSine: 0.85, curvature: 0, curvatureRms: 0, sunVisibility: 1, noiseValue: 0.5, noiseCurvatureScale: 0, jacobians: [1.09, 1.03, 1.005, 0.999], jacobian4: 1.0002, cascadeScales: DEFAULT_CASCADE_SCALES, cascadeScale4: DEFAULT_CASCADE_SCALE_4 },
  { label: "profile with two cascades", depth: 12, sunElevationSine: 0.85, curvature: 0, curvatureRms: 0, sunVisibility: 1, noiseValue: 0.5, noiseCurvatureScale: 0, jacobians: [0.91, 0.97, 1, 1], jacobian4: 1, cascadeScales: [2.7318, 0.34148, 0, 0], cascadeScale4: 0 },
  { label: "inland sinusoid", depth: 1.2, sunElevationSine: 0.7, curvature: 0, curvatureRms: 0, sunVisibility: 1, noiseValue: 0.5, noiseCurvatureScale: 0, sinusoidPhase: 2.1, sinusoidCurvature: 0.9 },
  { label: "everything at once", depth: 4, sunElevationSine: 0.65, curvature: -0.4, curvatureRms: 0.45, sunVisibility: 0.9, noiseValue: 0.71, noiseCurvatureScale: 5.6, sinusoidPhase: -3.9, sinusoidCurvature: 0.3, jacobians: CREST_JACOBIANS, jacobian4: 0.9998, cascadeScales: DEFAULT_CASCADE_SCALES, cascadeScale4: DEFAULT_CASCADE_SCALE_4 },
]);

const NEUTRAL_JACOBIANS: Vec4 = [1, 1, 1, 1];
const ZERO_SCALES: Vec4 = [0, 0, 0, 0];

function expected(probe: Probe): readonly [number, number, number, number] {
  const beam = waterRefractedSunBeam(probe.depth, probe.sunElevationSine);
  let caustic = waterCausticBand(
    WATER_CAUSTIC_ZERO,
    probe.curvature,
    probe.curvatureRms,
    beam,
  );
  caustic = waterCausticNoiseBand(caustic, probe.noiseValue, probe.noiseCurvatureScale, beam);
  caustic = waterCausticSinusoidBand(
    caustic,
    probe.sinusoidPhase ?? 0,
    probe.sinusoidCurvature ?? 0,
    beam,
  );
  caustic = waterCausticCascadeBands(
    caustic,
    probe.jacobians ?? NEUTRAL_JACOBIANS,
    probe.jacobian4 ?? 1,
    probe.cascadeScales ?? ZERO_SCALES,
    probe.cascadeScale4 ?? 0,
    beam,
  );
  return [
    beam.slantMeters,
    beam.weight,
    caustic.curvature,
    waterCausticBedGain(caustic, beam, probe.sunVisibility),
  ];
}

describe("water bed caustics (6-4)", () => {
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
        probeData.set(probe.jacobians ?? NEUTRAL_JACOBIANS, base);
        probeData.set(probe.cascadeScales ?? ZERO_SCALES, base + 4);
        probeData[base + 8] = probe.depth;
        probeData[base + 9] = probe.sunElevationSine;
        probeData[base + 10] = probe.curvature;
        probeData[base + 11] = probe.curvatureRms;
        probeData[base + 12] = probe.sunVisibility;
        probeData[base + 13] = probe.noiseValue;
        probeData[base + 14] = probe.noiseCurvatureScale;
        probeData[base + 15] = probe.sinusoidPhase ?? 0;
        probeData[base + 16] = probe.sinusoidCurvature ?? 0;
        probeData[base + 17] = probe.jacobian4 ?? 1;
        probeData[base + 18] = probe.cascadeScale4 ?? 0;
        probeData[base + 19] = 0;
      });
      const probeBuffer = new StorageBuffer(engine, probeData.byteLength);
      probeBuffer.update(probeData);
      const resultBuffer = new StorageBuffer(
        engine,
        PROBES.length * RESULT_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      );

      const shader = new ComputeShader(
        "water-caustic-probe",
        engine,
        { computeSource: CAUSTIC_PROBE_WGSL },
        {
          bindingsMapping: {
            probes: { group: 0, binding: 0 },
            results: { group: 0, binding: 1 },
          },
          entryPoint: "evaluateCaustics",
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

      const names = ["slantMeters", "weight", "curvature", "bedGain"] as const;
      PROBES.forEach((probe, index) => {
        const oracle = expected(probe);
        for (let lane = 0; lane < RESULT_FLOATS; lane += 1) {
          const gpu = results[index * RESULT_FLOATS + lane]!;
          const cpu = oracle[lane]!;
          // f32 against f64: the tolerance is single-precision epsilon on the
          // magnitude, not a conceded fudge. Deep-water slant is a large
          // number that the gate never actually uses, so scale by it.
          const tolerance = Math.max(Math.abs(cpu), 1) * 1e-5;
          expect(
            Math.abs(gpu - cpu),
            `${probe.label} ${names[lane]}: gpu ${gpu} vs oracle ${cpu}`,
          ).toBeLessThan(tolerance);
        }
      });

      // And the properties the whole term exists to guarantee, read off the
      // GPU's own numbers rather than the oracle's.
      const gainOf = (label: string): number => {
        const index = PROBES.findIndex((probe) => probe.label === label);
        return results[index * RESULT_FLOATS + 3]!;
      };
      const weightOf = (label: string): number => {
        const index = PROBES.findIndex((probe) => probe.label === label);
        return results[index * RESULT_FLOATS + 1]!;
      };
      expect(gainOf("dry bed")).toBe(1);
      expect(gainOf("flat surface")).toBeCloseTo(1, 6);
      expect(weightOf("beyond the gate")).toBe(0);
      expect(gainOf("beyond the gate")).toBe(1);
      expect(weightOf("deep ocean")).toBe(0);
      expect(gainOf("deep ocean")).toBe(1);
      expect(gainOf("night")).toBe(1);
      expect(gainOf("full shadow")).toBe(1);
      expect(gainOf("gate edge")).toBeCloseTo(1, 3);
      // Crests brighten, troughs darken, and the focus is the peak.
      expect(gainOf("shallow crest")).toBeGreaterThan(1);
      expect(gainOf("shallow trough")).toBeLessThan(1);
      expect(gainOf("at the focus")).toBeGreaterThan(gainOf("past the focus"));
      expect(gainOf("at the focus")).toBeGreaterThan(1.5);
      // Shadow scales the term rather than switching it: same surface, same
      // depth, 35% of the direct beam.
      expect(gainOf("partial shadow")).toBeGreaterThan(1);
      expect(gainOf("partial shadow") - 1)
        .toBeCloseTo(0.35 * (gainOf("full sun twin") - 1), 5);
      // The spectral cascade lanes: a compressed surface brightens the bed and
      // a stretched one darkens it, and dropping the unused lanes to a zero
      // scale changes nothing measurable (cascades 2-4 convert at 1/32 of
      // cascade 0, which is the whole point of the per-band wavenumber).
      expect(gainOf("spectral crest")).toBeGreaterThan(1.05);
      expect(gainOf("spectral trough")).toBeLessThan(0.98);
      expect(gainOf("profile with two cascades")).toBeCloseTo(gainOf("spectral crest"), 2);
      // The inland sinusoid band is live but weak at the amplitudes the river
      // surface actually carries — it exists for 6-1/6-2 to raise.
      expect(gainOf("inland sinusoid")).toBeGreaterThan(1);
      expect(gainOf("everything at once")).toBeGreaterThan(0.5);
      expect(gainOf("everything at once")).toBeLessThan(2.5);

      probeBuffer.dispose();
      resultBuffer.dispose();
    } finally {
      engine.dispose();
      canvas.remove();
    }
  });

  /**
   * The three shared blocks 6-4 touched, composed in the order both water
   * FRAGMENT shaders use them, validated at FRAGMENT stage through a real
   * render-pipeline creation.
   *
   * Nothing else in the tree compiles the composed water fragments: the
   * extraction gate hashes their text, and every unit assertion is a string
   * match. A declaration-order mistake or a swizzle typo in these blocks is
   * therefore a shader that never compiles and a renderer stuck on
   * "PREPARING AIRSPACE" — precisely the wave-R incident that
   * `render.webgpu-water-extraction.test.ts` documents. These three blocks
   * declare no uniform, sampler or varying (the capillary block needs only
   * `dpdx`/`dpdy`), so they are valid raw WGSL and can be compiled here
   * without standing up the whole ocean.
   */
  it("compiles the shared caustic, noise and capillary blocks at fragment stage", async () => {
    const adapter = await navigator.gpu.requestAdapter();
    expect(adapter).not.toBeNull();
    const device = await adapter!.requestDevice();
    try {
      const source = /* wgsl */ `
${WATER_CAUSTIC_WGSL}

${WATER_DETAIL_NOISE_WGSL}

${WATER_CAPILLARY_DETAIL_WGSL}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return vec4f(f32(index) - 1.0, f32(index & 1u) * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  // A world-scale coordinate on purpose: these lattices are fed ABSOLUTE
  // metres, and the house's recorded hash failures only appear out there.
  let worldXZ = vec2f(128000.0 + position.x * 0.05, -64000.0 + position.y * 0.05);
  let beam = waterRefractedSunBeam(3.0, 0.8);
  let detail = waterCapillaryDetail(worldXZ, vec2f(7.0, 3.0), 12.5, 0.2, beam);
  // Both composed bands the shipped materials call, in their real shapes.
  var caustic = waterCausticCascadeBands(
    detail.caustic,
    vec4f(0.91, 0.97, 0.995, 1.001),
    0.9998,
    vec4f(2.7318, 0.34148, 0.085371, 0.021343),
    0.0053357,
    beam,
  );
  caustic = waterCausticSinusoidBand(caustic, 2.1, 0.9, beam);
  let gain = waterCausticBedGain(caustic, beam, 1.0);
  return vec4f(detail.slope, detail.unresolvedMeanSquareSlope, gain);
}
`;
      const shaderModule = device.createShaderModule({ code: source });
      const info = await shaderModule.getCompilationInfo();
      const problems = info.messages.filter((message) => message.type !== "info");
      expect(
        problems.map((message) => `${message.type} ${message.lineNum}:${message.linePos} ${message.message}`),
      ).toEqual([]);
      // Creating the pipeline is what actually validates the entry points and
      // their interface, not just the parse.
      device.pushErrorScope("validation");
      device.createRenderPipeline({
        layout: "auto",
        vertex: { module: shaderModule, entryPoint: "vertexMain" },
        fragment: { module: shaderModule, entryPoint: "fragmentMain", targets: [{ format: "rgba8unorm" }] },
        primitive: { topology: "triangle-list" },
      });
      expect(await device.popErrorScope()).toBeNull();
    } finally {
      device.destroy();
    }
  });
});
