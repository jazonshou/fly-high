import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
// Side-effect import: registers the compute pipeline methods on WebGPUEngine.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  WATER_CAPILLARY_DETAIL_WGSL,
  WATER_CAUSTIC_WGSL,
  WATER_DETAIL_NOISE_WGSL,
  WATER_FLOW_GRAVITY,
  WATER_RUNUP_BEACH_SLOPE_MAXIMUM,
  WATER_RUNUP_BEACH_SLOPE_MINIMUM,
  WATER_RUNUP_EXCEEDANCE,
  WATER_RUNUP_STREAK_CELLS_PER_METER,
  WATER_RUNUP_STREAK_STRETCH,
  WATER_SHORE_RUNUP_WGSL,
  WATER_SHORE_STREAK_WGSL,
  waterDominantShoreSwell,
  waterRunupClock,
  waterShoreBore,
  waterShoreRunupHeight,
  waterShoreRunupPhase,
  waterShoreWetness,
  waterSwashFront,
} from "../../src/render/webgpu/water/WaterShaders";

/**
 * 6-2 — shoreline run-up, shore-normal streaking and the 6-5 wetness field:
 * TS/WGSL parity on a real adapter, plus the four claims a Node test cannot
 * make about the shipped shader text.
 *
 * Same split as `water-caustics.test.ts` and `water-channel-flow.test.ts`:
 * `WATER_SHORE_RUNUP_WGSL` declares no uniform, samples no texture and takes
 * no derivative, so the shipped block runs here as a compute kernel and the
 * exported TypeScript functions are the oracle.
 *
 * The claims this file owns:
 *  - THE PHASE LOCK. The run-up's only temporal frequency is the dominant
 *    VISIBLE cascade's, measured through the shipped selection function: fade
 *    one cascade out and the surf re-beats at the next one's rate, on the
 *    hardware, in the same kernel.
 *  - THE RULE IS AMPLITUDE, NOT SLOPE. A sea whose slope is dominated by the
 *    capillary cascade still runs up at the swell cascade's period.
 *  - THE WETNESS FIELD'S SHAPE AND RANGE, evaluated on the hardware over a
 *    sweep that includes every degenerate input 6-5 can hand it.
 *  - STREAK ORIENTATION. The filaments are elongated along the SHORE NORMAL,
 *    and they rotate with it — measured as an anisotropy ratio rather than
 *    asserted from the source.
 */

/** vec4 triples first, then the scalars: 20 floats, 80 bytes, 16-aligned. */
const RUNUP_PROBE_FLOATS = 20;
const RUNUP_RESULT_FLOATS = 12;
const STREAK_PROBE_FLOATS = 8;
const STREAK_RESULT_FLOATS = 8;

const RUNUP_PROBE_WGSL = /* wgsl */ `
${WATER_SHORE_RUNUP_WGSL}

struct RunupProbe {
  wavelengths: vec4f,
  meanSquareSlopes: vec4f,
  fades: vec4f,
  wavelength4: f32,
  meanSquareSlope4: f32,
  fade4: f32,
  beachSlope: f32,
  depthMeters: f32,
  freeboardMeters: f32,
  time: f32,
  padding: f32,
}

@group(0) @binding(0) var<storage, read> probes: array<RunupProbe>;
@group(0) @binding(1) var<storage, read_write> results: array<vec4f>;

@compute @workgroup_size(16, 1, 1)
fn evaluateRunup(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes)) { return; }
  let probe = probes[id.x];
  let swell = waterDominantShoreSwell(
    probe.wavelengths,
    probe.wavelength4,
    probe.meanSquareSlopes,
    probe.meanSquareSlope4,
    probe.fades,
    probe.fade4,
  );
  let runupHeight = waterShoreRunupHeight(swell, probe.beachSlope);
  let phase = waterShoreRunupPhase(
    probe.depthMeters,
    probe.beachSlope,
    swell.radianFrequency,
    probe.time,
  );
  results[id.x * 3u] = vec4f(
    swell.waveHeightMeters,
    swell.wavelengthMeters,
    swell.radianFrequency,
    swell.excursionMeters,
  );
  results[id.x * 3u + 1u] = vec4f(
    runupHeight,
    phase,
    waterSwashFront(phase),
    waterShoreBore(phase),
  );
  results[id.x * 3u + 2u] = vec4f(
    waterShoreWetness(probe.freeboardMeters, runupHeight, phase, swell.radianFrequency),
    waterRunupClock(probe.time),
    0.0,
    0.0,
  );
}
`;

/**
 * The streak lattice, sampled at a point and at four neighbours: two along the
 * shore normal, two along the shore tangent. The anisotropy the test measures
 * from those five numbers is the orientation claim.
 */
const STREAK_PROBE_WGSL = /* wgsl */ `
${WATER_DETAIL_NOISE_WGSL}

${WATER_SHORE_RUNUP_WGSL}

${WATER_SHORE_STREAK_WGSL}

struct StreakProbe {
  worldXZ: vec2f,
  shoreNormal: vec2f,
  stepMeters: f32,
  swashOffsetMeters: f32,
  padding0: f32,
  padding1: f32,
}

@group(0) @binding(0) var<storage, read> probes: array<StreakProbe>;
@group(0) @binding(1) var<storage, read_write> results: array<vec4f>;

@compute @workgroup_size(16, 1, 1)
fn evaluateStreak(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes)) { return; }
  let probe = probes[id.x];
  let normal = normalize(probe.shoreNormal);
  let tangent = vec2f(-normal.y, normal.x);
  let step = probe.stepMeters;
  results[id.x * 2u] = vec4f(
    waterShoreStreakLattice(probe.worldXZ, normal, probe.swashOffsetMeters),
    waterShoreStreakLattice(probe.worldXZ + normal * step, normal, probe.swashOffsetMeters),
    waterShoreStreakLattice(probe.worldXZ - normal * step, normal, probe.swashOffsetMeters),
    waterShoreStreakLattice(probe.worldXZ + tangent * step, normal, probe.swashOffsetMeters),
  );
  results[id.x * 2u + 1u] = vec4f(
    waterShoreStreakLattice(probe.worldXZ - tangent * step, normal, probe.swashOffsetMeters),
    0.0,
    0.0,
    0.0,
  );
}
`;

interface RunupProbe {
  readonly label: string;
  readonly wavelengths: readonly [number, number, number, number, number];
  readonly meanSquareSlopes: readonly [number, number, number, number, number];
  readonly fades: readonly [number, number, number, number, number];
  readonly beachSlope: number;
  readonly depthMeters: number;
  readonly freeboardMeters: number;
  readonly time: number;
}

/** The shipped cascade set's representative wavelengths, sqrt(min*max). */
const SHIPPED_WAVELENGTHS = [2, 16, 64, 256, 1024] as const;
/**
 * A 12 m/s wind sea, band by band: the mean-square slope FALLS steeply with
 * wavelength (a Phillips tail) while the amplitude a = sqrt(2 mss)/k RISES,
 * which is exactly the trap the amplitude rule exists to avoid. These numbers
 * give per-band amplitudes of 0.08, 0.44, 0.91, 0.81 and 0.06 m — the JONSWAP
 * peak lands on cascade 2, where the shipped config's fetch-limited peak
 * wavelength (77.8 m) also lands.
 */
const WIND_SEA_MSS = [0.03, 0.015, 0.004, 0.0002, 0.0000002] as const;

function runupProbe(label: string, overrides: Partial<RunupProbe> = {}): RunupProbe {
  return {
    label,
    wavelengths: SHIPPED_WAVELENGTHS,
    meanSquareSlopes: WIND_SEA_MSS,
    fades: [1, 1, 1, 1, 1],
    beachSlope: 0.06,
    depthMeters: 1.2,
    freeboardMeters: 0.3,
    time: 61.25,
    ...overrides,
  };
}

const DEPTH_SWEEP = [0, 0.25, 1, 2.5, 5, 8.5] as const;
const FREEBOARD_SWEEP = [0, 0.05, 0.2, 0.45, 0.75, 1.1, 1.6] as const;

const RUNUP_PROBES: readonly RunupProbe[] = [
  // --- the dominant-band rule ---
  runupProbe("wind sea"),
  // Same sea, cascade 2 no longer visible: the surf must re-beat on the band
  // that now dominates, which is cascade 3.
  runupProbe("wind sea, swell band faded", { fades: [1, 1, 0, 1, 1] }),
  // ...and with 2 and 3 both gone the beat drops to the 16 m band.
  runupProbe("wind sea, two bands faded", { fades: [1, 1, 0, 0, 1] }),
  // The capillary trap: a hundredfold slope on cascade 0 must NOT win.
  runupProbe("capillary-dominated slope", {
    meanSquareSlopes: [3, 0.015, 0.004, 0.0002, 0.0000002],
  }),
  // A profile running two cascades: the absent ones publish wavelength 0.
  runupProbe("two-cascade profile", {
    wavelengths: [2, 16, 0, 0, 0],
    meanSquareSlopes: [0.03, 0.015, 0, 0, 0],
  }),
  // --- degenerate inputs 6-5 can hand the field ---
  runupProbe("glassy sea", { meanSquareSlopes: [0, 0, 0, 0, 0] }),
  runupProbe("submerged", { freeboardMeters: -2 }),
  runupProbe("at the waterline", { freeboardMeters: 0 }),
  runupProbe("far above the swash", { freeboardMeters: 90 }),
  runupProbe("flat shelf", { beachSlope: 0 }),
  runupProbe("cliff", { beachSlope: 4 }),
  // --- the phase, measured ---
  ...DEPTH_SWEEP.map((depthMeters) => runupProbe(`depth ${depthMeters}`, { depthMeters })),
  runupProbe("clock t0", { time: 100 }),
  runupProbe("clock t1", { time: 101 }),
  runupProbe("clock t2", { time: 103.5 }),
  // --- the wetness field's shape ---
  ...FREEBOARD_SWEEP.map((freeboardMeters) =>
    runupProbe(`freeboard ${freeboardMeters}`, { freeboardMeters })),
  // A full cycle of phases at one point, for the bore's mean and the field's
  // range. 64 samples across 2 pi of the beat, moved by the clock alone.
  ...Array.from({ length: 64 }, (_, index) =>
    runupProbe(`cycle ${index}`, { time: 400 + index * 0.13 })),
];

interface StreakProbe {
  readonly worldXZ: readonly [number, number];
  readonly shoreNormal: readonly [number, number];
  readonly stepMeters: number;
  readonly swashOffsetMeters: number;
}

/**
 * A world-scale coast on purpose: every lattice here is fed ABSOLUTE metres
 * and the recorded hash failures only appear kilometres out.
 */
const COAST_SITE: readonly [number, number] = [212_480.5, -97_340.25];
/** Six shore orientations, none of them a world axis and two of them nearly so. */
const SHORE_NORMAL_ANGLES = [0.02, 0.41, 0.79, 1.24, 1.92, 2.61] as const;
/**
 * One along-shore cell. Features are `1/cells` metres across the beach and
 * `stretch/cells` along it, so a step of one across-cell must move the lattice
 * far less along the normal than along the tangent — by roughly `stretch`.
 */
const STREAK_STEP_METERS = 1 / WATER_RUNUP_STREAK_CELLS_PER_METER;

const STREAK_PROBES: readonly StreakProbe[] = SHORE_NORMAL_ANGLES.flatMap((angle) =>
  Array.from({ length: 48 }, (_, index) => ({
    worldXZ: [
      COAST_SITE[0] + index * 13.37,
      COAST_SITE[1] - index * 7.91,
    ] as const,
    shoreNormal: [Math.cos(angle), Math.sin(angle)] as const,
    stepMeters: STREAK_STEP_METERS,
    swashOffsetMeters: 0,
  })));

async function runCompute(
  source: string,
  entryPoint: string,
  probeData: Float32Array,
  probeFloats: number,
  resultFloats: number,
): Promise<Float32Array> {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, { antialias: false });
  await engine.initAsync();
  try {
    const probeBuffer = new StorageBuffer(engine, probeData.byteLength);
    probeBuffer.update(probeData);
    const resultBuffer = new StorageBuffer(
      engine,
      resultFloats * Float32Array.BYTES_PER_ELEMENT,
    );
    const shader = new ComputeShader(
      `water-runup-${entryPoint}`,
      engine,
      { computeSource: source },
      {
        bindingsMapping: {
          probes: { group: 0, binding: 0 },
          results: { group: 0, binding: 1 },
        },
        entryPoint,
      },
    );
    shader.setStorageBuffer("probes", probeBuffer);
    shader.setStorageBuffer("results", resultBuffer);
    // Compute submissions and readbacks resolve at frame boundaries, so drive
    // an empty render loop while awaiting them.
    engine.runRenderLoop(() => {});
    await shader.dispatchWhenReady(
      Math.ceil((probeData.length / probeFloats) / 16) || 1,
      1,
      1,
    );
    expect(shader.isReady()).toBe(true);
    const view = await resultBuffer.read();
    engine.stopRenderLoop();
    const results = new Float32Array(
      view.buffer.slice(view.byteOffset, view.byteOffset + resultFloats * 4),
    );
    probeBuffer.dispose();
    resultBuffer.dispose();
    return results;
  } finally {
    engine.dispose();
    canvas.remove();
  }
}

describe("6-2 shore run-up WGSL/TS parity", () => {
  it("agrees with the oracle, locks the phase to the visible cascade, and bounds the field", async () => {
    const probeData = new Float32Array(RUNUP_PROBES.length * RUNUP_PROBE_FLOATS);
    RUNUP_PROBES.forEach((probe, index) => {
      const base = index * RUNUP_PROBE_FLOATS;
      for (let lane = 0; lane < 4; lane += 1) {
        probeData[base + lane] = probe.wavelengths[lane]!;
        probeData[base + 4 + lane] = probe.meanSquareSlopes[lane]!;
        probeData[base + 8 + lane] = probe.fades[lane]!;
      }
      probeData[base + 12] = probe.wavelengths[4]!;
      probeData[base + 13] = probe.meanSquareSlopes[4]!;
      probeData[base + 14] = probe.fades[4]!;
      probeData[base + 15] = probe.beachSlope;
      probeData[base + 16] = probe.depthMeters;
      probeData[base + 17] = probe.freeboardMeters;
      probeData[base + 18] = probe.time;
      probeData[base + 19] = 0;
    });
    const results = await runCompute(
      RUNUP_PROBE_WGSL,
      "evaluateRunup",
      probeData,
      RUNUP_PROBE_FLOATS,
      RUNUP_PROBES.length * RUNUP_RESULT_FLOATS,
    );
    const fieldsOf = (label: string): readonly number[] => {
      const index = RUNUP_PROBES.findIndex((probe) => probe.label === label);
      expect(index, `probe ${label}`).toBeGreaterThanOrEqual(0);
      return Array.from(results.subarray(
        index * RUNUP_RESULT_FLOATS,
        (index + 1) * RUNUP_RESULT_FLOATS,
      ));
    };

    // 1. Statement-for-statement parity with the exported oracle, every lane.
    const names = [
      "waveHeight", "wavelength", "radianFrequency", "excursion",
      "runupHeight", "phase", "front", "bore",
      "wetness", "clock", "spare0", "spare1",
    ] as const;
    RUNUP_PROBES.forEach((probe, index) => {
      const swell = waterDominantShoreSwell(
        probe.wavelengths,
        probe.meanSquareSlopes,
        probe.fades,
      );
      const runupHeight = waterShoreRunupHeight(swell, probe.beachSlope);
      const phase = waterShoreRunupPhase(
        probe.depthMeters,
        probe.beachSlope,
        swell.radianFrequency,
        probe.time,
      );
      const oracle = [
        swell.waveHeightMeters, swell.wavelengthMeters,
        swell.radianFrequency, swell.excursionMeters,
        runupHeight, phase, waterSwashFront(phase), waterShoreBore(phase),
        waterShoreWetness(probe.freeboardMeters, runupHeight, phase, swell.radianFrequency),
        waterRunupClock(probe.time), 0, 0,
      ];
      for (let lane = 0; lane < RUNUP_RESULT_FLOATS; lane += 1) {
        const gpu = results[index * RUNUP_RESULT_FLOATS + lane]!;
        const cpu = oracle[lane]!;
        // f32 against f64: single-precision epsilon on the magnitude. The
        // `front`, `bore` and `wetness` lanes ride sin/pow/exp of a phase that
        // is itself an f32 product of a clock and a frequency, so they carry
        // the phase's own quantum times their derivative — bounded here at the
        // phase magnitude rather than hidden under a blanket fudge.
        const phaseQuantum = Math.abs(phase) * 1.1920929e-7 * 8;
        const rides = lane >= 6 && lane <= 8 ? phaseQuantum : 0;
        const tolerance = Math.max(Math.abs(cpu), 1) * 4e-5 + rides;
        expect(
          Math.abs(gpu - cpu),
          `${probe.label} ${names[lane]}: gpu ${gpu} vs oracle ${cpu}`,
        ).toBeLessThan(tolerance);
      }
    });

    // 2. THE PHASE LOCK, measured on the hardware. The dominant band of this
    //    sea is cascade 2 (64 m). Fade it out and the run-up re-beats on
    //    cascade 3 (256 m); fade both and it drops to cascade 1 (16 m). Every
    //    frequency is the deep-water sqrt(g k) of the band that won, so the
    //    surf cannot beat at a rate no visible wave arrives at.
    const deepWaterOmega = (wavelength: number): number =>
      Math.sqrt((WATER_FLOW_GRAVITY * 2 * Math.PI) / wavelength);
    expect(fieldsOf("wind sea")[1]).toBeCloseTo(64, 4);
    expect(fieldsOf("wind sea")[2]).toBeCloseTo(deepWaterOmega(64), 4);
    expect(fieldsOf("wind sea, swell band faded")[1]).toBeCloseTo(256, 4);
    expect(fieldsOf("wind sea, swell band faded")[2]).toBeCloseTo(deepWaterOmega(256), 4);
    expect(fieldsOf("wind sea, two bands faded")[1]).toBeCloseTo(16, 4);
    expect(fieldsOf("wind sea, two bands faded")[2]).toBeCloseTo(deepWaterOmega(16), 4);
    // And the beat genuinely changed: a swell band twice as long beats half as
    // fast, which is the whole point of locking to it.
    expect(fieldsOf("wind sea")[2]! / fieldsOf("wind sea, swell band faded")[2]!)
      .toBeCloseTo(2, 3);

    // 3. THE RULE IS AMPLITUDE, NOT SLOPE. A sea whose mean-square slope is a
    //    hundredfold larger on the capillary cascade still runs up at the
    //    swell cascade's period — keying on slope would beat the surf at the
    //    ripple rate, which is the failure this rule is written to prevent.
    expect(fieldsOf("capillary-dominated slope")[1]).toBeCloseTo(64, 4);
    // A profile that runs two cascades selects among the two it has; the
    // absent ones publish wavelength 0 and score zero.
    expect(fieldsOf("two-cascade profile")[1]).toBeCloseTo(16, 4);

    // 4. The phase advances at exactly omega per second — no second clock, no
    //    drift — and its spatial gradient is the shallow-water wavenumber.
    const omega = fieldsOf("wind sea")[2]!;
    expect(fieldsOf("clock t1")[5]! - fieldsOf("clock t0")[5]!).toBeCloseTo(omega, 3);
    expect(fieldsOf("clock t2")[5]! - fieldsOf("clock t1")[5]!)
      .toBeCloseTo(omega * 2.5, 3);
    // d(phase)/d(depth) = omega / (slope sqrt(g h)) in the constructed frame,
    // which times the slope is the eikonal's omega/sqrt(g h). Measured across
    // the depth sweep against that closed form.
    for (let index = 1; index < DEPTH_SWEEP.length; index += 1) {
      const low = DEPTH_SWEEP[index - 1]!;
      const high = DEPTH_SWEEP[index]!;
      const measured = (fieldsOf(`depth ${high}`)[5]! - fieldsOf(`depth ${low}`)[5]!)
        / (high - low);
      // The exact integral of omega/(slope sqrt(g h)) over [low, high].
      const predicted = (2 * omega * (Math.sqrt(high) - Math.sqrt(low)))
        / (0.06 * Math.sqrt(WATER_FLOW_GRAVITY) * (high - low));
      expect(measured / predicted, `depth ${low}->${high} eikonal`).toBeCloseTo(1, 3);
    }
    // Monotone: the phase always increases offshore, so the bores always
    // travel shoreward.
    for (let index = 1; index < DEPTH_SWEEP.length; index += 1) {
      expect(fieldsOf(`depth ${DEPTH_SWEEP[index]}`)[5]!)
        .toBeGreaterThan(fieldsOf(`depth ${DEPTH_SWEEP[index - 1]}`)[5]!);
    }

    // 5. THE WETNESS FIELD. Range, degenerate inputs, and monotonicity.
    for (const probe of RUNUP_PROBES) {
      const wetness = fieldsOf(probe.label)[8]!;
      expect(wetness, `${probe.label} wetness range`).toBeGreaterThanOrEqual(0);
      expect(wetness, `${probe.label} wetness range`).toBeLessThanOrEqual(1);
      expect(Number.isFinite(wetness), `${probe.label} wetness finite`).toBe(true);
    }
    // A glassy sea raises no run-up, so it wets nothing above the waterline —
    // which is what keeps an analytic world with no published swell on today's
    // behaviour with no branch of its own.
    expect(fieldsOf("glassy sea")[4]).toBe(0);
    expect(fieldsOf("glassy sea")[8]).toBe(0);
    // Submerged ground is wet by definition; the waterline itself is wet.
    expect(fieldsOf("submerged")[8]).toBe(1);
    expect(fieldsOf("at the waterline")[8]).toBe(1);
    // Ninety metres above the swash limit is bone dry.
    expect(fieldsOf("far above the swash")[8]).toBe(0);
    // And it falls monotonically up the beach face.
    const wetnessSweep = FREEBOARD_SWEEP.map(
      (freeboard) => fieldsOf(`freeboard ${freeboard}`)[8]!);
    for (let index = 1; index < wetnessSweep.length; index += 1) {
      expect(
        wetnessSweep[index]!,
        `freeboard ${FREEBOARD_SWEEP[index]} vs ${FREEBOARD_SWEEP[index - 1]}`,
      ).toBeLessThanOrEqual(wetnessSweep[index - 1]! + 1e-6);
    }
    expect(wetnessSweep[0]).toBe(1);
    // The field ends inside the exceedance limit: R here is 0.06 * excursion,
    // so 1.6 m of freeboard is far past 1.35 R and must be exactly zero.
    const runupHeight = fieldsOf("wind sea")[4]!;
    expect(runupHeight).toBeGreaterThan(0.2);
    expect(runupHeight).toBeLessThan(3);
    expect(1.6 / runupHeight).toBeGreaterThan(WATER_RUNUP_EXCEEDANCE);
    expect(wetnessSweep.at(-1)).toBe(0);

    // 6. Hunt's law and the beach-slope clamps, through the shipped shader.
    //    R = tan(beta) sqrt(H L0); the excursion is slope-free, so a cliff and
    //    a flat shelf differ ONLY by their clamped slopes.
    const excursion = fieldsOf("wind sea")[3]!;
    expect(fieldsOf("wind sea")[4]).toBeCloseTo(0.06 * excursion, 4);
    expect(fieldsOf("flat shelf")[4])
      .toBeCloseTo(WATER_RUNUP_BEACH_SLOPE_MINIMUM * excursion, 5);
    expect(fieldsOf("cliff")[4])
      .toBeCloseTo(WATER_RUNUP_BEACH_SLOPE_MAXIMUM * excursion, 4);
    // The excursion is sqrt(H L) with both read off the same band.
    expect(excursion).toBeCloseTo(
      Math.sqrt(fieldsOf("wind sea")[0]! * fieldsOf("wind sea")[1]!), 3);

    // 7. The bore is mean-preserving: wave R's shore band keeps its
    //    time-averaged coverage, so 6-2 redistributes foam rather than adding
    //    any. Measured over 64 phases of one beat, off the GPU's own numbers.
    const cycle = Array.from({ length: 64 }, (_, index) => fieldsOf(`cycle ${index}`)[7]!);
    const cycleMean = cycle.reduce((sum, value) => sum + value, 0) / cycle.length;
    expect(cycleMean).toBeCloseTo(1, 1);
    expect(Math.min(...cycle)).toBeGreaterThan(0);
    expect(Math.max(...cycle)).toBeGreaterThan(1.8);
    // The front is a real swash: above still water for about half the cycle.
    const fronts = Array.from({ length: 64 }, (_, index) => fieldsOf(`cycle ${index}`)[6]!);
    const wetFraction = fronts.filter((value) => value > 0).length / fronts.length;
    expect(wetFraction).toBeGreaterThan(0.35);
    expect(wetFraction).toBeLessThan(0.65);
  });

  it("streaks along the shore normal, and rotates with it", async () => {
    const probeData = new Float32Array(STREAK_PROBES.length * STREAK_PROBE_FLOATS);
    STREAK_PROBES.forEach((probe, index) => {
      const base = index * STREAK_PROBE_FLOATS;
      probeData[base] = probe.worldXZ[0];
      probeData[base + 1] = probe.worldXZ[1];
      probeData[base + 2] = probe.shoreNormal[0];
      probeData[base + 3] = probe.shoreNormal[1];
      probeData[base + 4] = probe.stepMeters;
      probeData[base + 5] = probe.swashOffsetMeters;
      probeData[base + 6] = 0;
      probeData[base + 7] = 0;
    });
    const results = await runCompute(
      STREAK_PROBE_WGSL,
      "evaluateStreak",
      probeData,
      STREAK_PROBE_FLOATS,
      STREAK_PROBES.length * STREAK_RESULT_FLOATS,
    );

    // The lattice's own mean must be 0.5, or `1 + gain (2v - 1)` is not the
    // mean-preserving modulation the shore band's coverage pin needs.
    const centre = STREAK_PROBES.map((_, index) => results[index * STREAK_RESULT_FLOATS]!);
    const mean = centre.reduce((sum, value) => sum + value, 0) / centre.length;
    expect(mean).toBeCloseTo(0.5, 1);
    for (const value of centre) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }

    // The anisotropy, per shore orientation. One along-shore cell of travel
    // must change the lattice far less along the NORMAL than along the
    // tangent — and it must do so for every orientation, which is what makes
    // this a property of the shore normal rather than of a world axis.
    SHORE_NORMAL_ANGLES.forEach((angle, group) => {
      let alongNormal = 0;
      let alongTangent = 0;
      let samples = 0;
      for (let index = 0; index < 48; index += 1) {
        const base = (group * 48 + index) * STREAK_RESULT_FLOATS;
        const here = results[base]!;
        alongNormal += Math.abs(results[base + 1]! - here)
          + Math.abs(results[base + 2]! - here);
        alongTangent += Math.abs(results[base + 3]! - here)
          + Math.abs(results[base + 4]! - here);
        samples += 2;
      }
      alongNormal /= samples;
      alongTangent /= samples;
      expect(alongTangent, `shore normal ${angle} tangent variation`).toBeGreaterThan(0);
      // The lattice is stretched `WATER_RUNUP_STREAK_STRETCH`:1 along the
      // normal, so one across-cell of travel is 1/stretch of a cell along it.
      // Half the tangent's variation is a conservative floor on a 4:1 stretch.
      expect(
        alongNormal / alongTangent,
        `shore normal ${angle} anisotropy (${alongNormal} vs ${alongTangent})`,
      ).toBeLessThan(0.5);
      expect(WATER_RUNUP_STREAK_STRETCH).toBeGreaterThan(1);
    });
  });

  it("compiles the run-up model standalone, as 6-5 will compose it", async () => {
    const adapter = await navigator.gpu.requestAdapter();
    expect(adapter).not.toBeNull();
    const device = await adapter!.requestDevice();
    try {
      // 6-5 composes this block into the TERRAIN surface plugin, which has
      // never heard of the water noise lattice. If the block ever grows a
      // dependency on one, this compile — the block and nothing else — fails.
      const standalone = /* wgsl */ `
${WATER_SHORE_RUNUP_WGSL}

@compute @workgroup_size(1, 1, 1)
fn wetnessOnly() {
  let swell = waterShoreSwell(2.0, 78.0, 11.0);
  let wet = waterShoreWetness(
    0.4,
    waterShoreRunupHeight(swell, 0.06),
    waterShoreRunupPhase(0.0, 0.06, swell.radianFrequency, 12.5),
    swell.radianFrequency,
  );
  _ = wet;
}
`;
      const standaloneModule = device.createShaderModule({ code: standalone });
      const standaloneInfo = await standaloneModule.getCompilationInfo();
      expect(
        standaloneInfo.messages
          .filter((message) => message.type !== "info")
          .map((message) => `${message.type} ${message.lineNum}: ${message.message}`),
      ).toEqual([]);

      // And the ocean's composition order, at FRAGMENT stage, with the shipped
      // call shape: the footprint taken in uniform control flow and the run-up
      // evaluated under a depth gate. Tint accepts WGSL other back ends
      // reject, so the render-pipeline creation below is the real gate.
      const composed = /* wgsl */ `
${WATER_CAUSTIC_WGSL}

${WATER_DETAIL_NOISE_WGSL}

${WATER_CAPILLARY_DETAIL_WGSL}

${WATER_SHORE_RUNUP_WGSL}

${WATER_SHORE_STREAK_WGSL}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return vec4f(f32(index) - 1.0, f32(index & 1u) * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let worldXZ = vec2f(212000.0 + position.x * 0.05, -97000.0 + position.y * 0.05);
  let derivativeX = dpdx(worldXZ);
  let derivativeY = dpdy(worldXZ);
  let footprint = max(
    min(length(derivativeX), length(derivativeY)),
    max(length(derivativeX), length(derivativeY)) * 0.0625,
  );
  let depth = abs(position.y) * 0.01;
  var modulation = 1.0;
  let gate = 1.0 - smoothstep(
    WATER_RUNUP_DEPTH_FADE_START_METERS,
    WATER_RUNUP_DEPTH_GATE_METERS,
    depth,
  );
  if (gate > 0.001) {
    let bedSlope = vec2f(0.03, -0.02);
    let shoreNormal = -normalize(bedSlope + vec2f(0.00001, 0.0));
    let swell = waterDominantShoreSwell(
      vec4f(2.0, 16.0, 64.0, 256.0), 1024.0,
      vec4f(0.03, 0.015, 0.004, 0.0002), 0.0000002,
      vec4f(1.0), 1.0,
    );
    let phase = waterShoreRunupPhase(depth, length(bedSlope), swell.radianFrequency, 12.5);
    let crestSpacing = WATER_RUNUP_TWO_PI
      * sqrt(WATER_RUNUP_GRAVITY * max(depth, 0.02)) / swell.radianFrequency;
    let resolved = 1.0 - smoothstep(
      crestSpacing * WATER_RUNUP_NYQUIST_FADE_LOW,
      crestSpacing * WATER_RUNUP_NYQUIST_FADE_HIGH,
      footprint,
    );
    let streak = waterShoreStreak(
      waterShoreStreakLattice(
        worldXZ,
        shoreNormal,
        swell.excursionMeters * waterSwashFront(phase),
      ),
      resolved,
    );
    modulation = mix(1.0, waterShoreBore(phase), gate * resolved) * streak;
  }
  return vec4f(modulation, gate, depth, 1.0);
}
`;
      const composedModule = device.createShaderModule({ code: composed });
      const composedInfo = await composedModule.getCompilationInfo();
      expect(
        composedInfo.messages
          .filter((message) => message.type !== "info")
          .map((message) => `${message.type} ${message.lineNum}: ${message.message}`),
      ).toEqual([]);
      device.pushErrorScope("validation");
      device.createRenderPipeline({
        layout: "auto",
        vertex: { module: composedModule, entryPoint: "vertexMain" },
        fragment: {
          module: composedModule,
          entryPoint: "fragmentMain",
          targets: [{ format: "rgba8unorm" }],
        },
        primitive: { topology: "triangle-list" },
      });
      expect(await device.popErrorScope()).toBeNull();
    } finally {
      device.destroy();
    }
  });
});
