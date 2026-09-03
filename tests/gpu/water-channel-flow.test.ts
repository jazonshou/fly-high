import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
// Side-effect import: registers the compute pipeline methods on WebGPUEngine.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Logger } from "@babylonjs/core/Misc/logger";
import { Scene } from "@babylonjs/core/scene";
import type { AtmosphereSnapshot } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import { HydrologySystem } from "../../src/render/webgpu/water/HydrologySystem";
import type {
  HydrologyLake,
  HydrologyRiver,
} from "../../src/render/webgpu/water/HydrologyGeneration";
import {
  WATER_CAPILLARY_DETAIL_WGSL,
  WATER_CAUSTIC_WGSL,
  WATER_CHANNEL_FLOW_WGSL,
  WATER_DETAIL_NOISE_WGSL,
  WATER_SHORE_RUNUP_WGSL,
  WATER_FLOW_SCALE_METERS,
  waterFlowCycleSeconds,
  waterFlowPhase,
  waterFlowSpeedGain,
  waterLakeChop,
  waterStandingWave,
} from "../../src/render/webgpu/water/WaterShaders";

/**
 * 6-1 — TS/WGSL parity for channel flow advection, standing waves and
 * fetch-limited lake chop, on a real adapter.
 *
 * Same split as `water-caustics.test.ts`: `WATER_CHANNEL_FLOW_WGSL` declares
 * no uniform, samples no texture and takes no derivative (its caller hands it
 * a footprint precisely so the sentinel branch is legal), so the shipped block
 * runs here as a compute kernel and the exported TypeScript functions are the
 * oracle. Tint also accepts WGSL other back ends reject, so the fragment-stage
 * pipeline creation at the bottom is a compile gate for the block as it is
 * actually composed.
 *
 * The three claims this file owns that a Node test cannot make:
 *  - the ANALYTIC sentinel returns the exact zero struct on the real hardware,
 *    for every field, at world scale, over a wide input sweep;
 *  - the standing wave is WORLD-LOCKED: its phase, crest, breaking weight and
 *    curvature are bit-identical across wildly separated times;
 *  - the advected term carries no per-lane / per-reach / per-page state, so
 *    two fragments at one world point agree bit-for-bit however they were
 *    rasterised.
 */

/** vec2f pairs first (16-byte alignment), then the scalars. */
const PROBE_FLOATS = 16;
const RESULT_FLOATS = 8;

const CHANNEL_PROBE_WGSL = /* wgsl */ `
${WATER_DETAIL_NOISE_WGSL}

${WATER_SHORE_RUNUP_WGSL}

${WATER_CHANNEL_FLOW_WGSL}

struct ChannelProbe {
  worldXZ: vec2f,
  flowDirection: vec2f,
  windVelocity: vec2f,
  // 6-2 repurposed the spare vec2 lane: the bank normal the run-up streaks
  // along, and the shore proximity that gates it.
  bankNormal: vec2f,
  channelPayload: f32,
  lakeFactor: f32,
  flowSpeed: f32,
  arcLengthMeters: f32,
  laneCoordinate: f32,
  time: f32,
  footprint: f32,
  shoreProximity: f32,
}

@group(0) @binding(0) var<storage, read> probes: array<ChannelProbe>;
@group(0) @binding(1) var<storage, read_write> results: array<vec4f>;

@compute @workgroup_size(16, 1, 1)
fn evaluateChannelFlow(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes)) { return; }
  let probe = probes[id.x];
  let flow = waterChannelFlow(
    probe.channelPayload,
    probe.lakeFactor,
    probe.worldXZ,
    probe.flowDirection,
    probe.flowSpeed,
    probe.arcLengthMeters,
    probe.laneCoordinate,
    probe.windVelocity,
    probe.time,
    probe.footprint,
    probe.shoreProximity,
    probe.bankNormal,
  );
  results[id.x * 2u] = vec4f(
    flow.slope.x,
    flow.slope.y,
    flow.unresolvedMeanSquareSlope,
    flow.crest,
  );
  results[id.x * 2u + 1u] = vec4f(
    flow.crestWeight,
    flow.standingPhase,
    flow.standingCurvature,
    flow.bankRunup,
  );
}
`;

/**
 * The pure-arithmetic half, evaluated lane by lane against the exported
 * oracle. `scalarPair` carries the two free inputs each law takes.
 */
const CHANNEL_LAW_WGSL = /* wgsl */ `
${WATER_DETAIL_NOISE_WGSL}

${WATER_SHORE_RUNUP_WGSL}

${WATER_CHANNEL_FLOW_WGSL}

struct LawProbe {
  scalarPair: vec2f,
  scale: f32,
  time: f32,
}

@group(0) @binding(0) var<storage, read> probes: array<LawProbe>;
@group(0) @binding(1) var<storage, read_write> results: array<vec4f>;

@compute @workgroup_size(16, 1, 1)
fn evaluateLaws(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes)) { return; }
  let probe = probes[id.x];
  let cycle = waterFlowCycleSeconds(probe.scale, probe.scalarPair.x);
  let phase = waterFlowPhase(probe.time, cycle);
  let standing = waterStandingWave(probe.scalarPair.x, probe.scalarPair.y);
  let chop = waterLakeChop(probe.scalarPair.x, probe.scalarPair.y);
  results[id.x * 4u] = vec4f(cycle, phase.ageA, phase.ageB, phase.weightA);
  results[id.x * 4u + 1u] = vec4f(
    phase.weightB,
    waterFlowSpeedGain(probe.scalarPair.x),
    standing.wavelengthMeters,
    standing.wavenumber,
  );
  results[id.x * 4u + 2u] = vec4f(
    standing.slopeAmplitude,
    standing.curvatureAmplitude,
    standing.breaking,
    chop.wavelengthMeters,
  );
  results[id.x * 4u + 3u] = vec4f(
    chop.significantHeightMeters,
    chop.slopeAmplitude,
    chop.driftSpeed,
    chop.cycleSeconds,
  );
}
`;

interface ChannelProbe {
  readonly label: string;
  readonly worldXZ: readonly [number, number];
  readonly flowDirection: readonly [number, number];
  readonly windVelocity: readonly [number, number];
  readonly channelPayload: number;
  readonly lakeFactor: number;
  readonly flowSpeed: number;
  readonly arcLengthMeters: number;
  readonly laneCoordinate: number;
  readonly time: number;
  readonly footprint: number;
  readonly shoreProximity: number;
  readonly bankNormal: readonly [number, number];
}

/**
 * A world-scale site on purpose: every lattice here is fed ABSOLUTE metres and
 * the recorded hash failures only appear kilometres out.
 */
const SITE: readonly [number, number] = [128_400.5, -64_120.25];
const FLOW: readonly [number, number] = [0.8, 0.6];
const WIND: readonly [number, number] = [5.2, -2.4];

function riverProbe(
  label: string,
  overrides: Partial<ChannelProbe> = {},
): ChannelProbe {
  return {
    label,
    worldXZ: SITE,
    flowDirection: FLOW,
    windVelocity: WIND,
    channelPayload: 1.5,
    lakeFactor: 0,
    flowSpeed: 2.4,
    arcLengthMeters: 8_412.5,
    laneCoordinate: 0.5,
    time: 91.25,
    footprint: 0.05,
    shoreProximity: 1,
    bankNormal: [0.6, -0.8],
    ...overrides,
  };
}

/**
 * A footprint that leaves the boil and wavelet octaves alive but has already
 * killed the standing train (its wavelength is clamped to 1.2 m at 1 m/s, so
 * it fades out by 0.384 m). Everything the probe then returns is advected,
 * which is what the seam claim is about.
 */
const ADVECTED_ONLY_FOOTPRINT = 0.5;

/** Long times, spanning many cycles of every scale, for the world-lock sweep. */
const WORLD_LOCK_TIMES = [0.5, 17.25, 613.75, 4_099.5, 20_000.125] as const;

/** Exported flow speeds, m/s: a backwater through a torrent past the gain cap. */
const SPEED_SWEEP = [0.2, 0.9, 1.8, 3.1, 4.4] as const;

const GPU_ATMOSPHERE: AtmosphereSnapshot = {
  sunDirection: new Vector3(-0.36, 0.82, 0.44).normalize(),
  sunColor: new Color3(1, 0.96, 0.88),
  sunIntensity: 4.8,
  skyZenith: new Color3(0.1, 0.36, 0.78),
  skyHorizon: new Color3(0.58, 0.77, 0.96),
  ambientColor: new Color3(0.18, 0.27, 0.42),
  skylightIlluminanceNormalized: 1,
  sunIlluminanceNormalized: 0.92,
  sunAngularRadiusRadians: 0.004675,
  cloudCoverage: 0.32,
  humidity: 0.62,
  windSpeed: 9,
  windDirection: new Vector2(0.93, 0.37).normalize(),
  moonDirection: new Vector3(0, -1, 0),
  moonIlluminanceLux: 0,
  moonIlluminatedFraction: 0,
  adaptedLuminanceCdM2: 6_000,
  sceneKeyLuminanceCdM2: 1_000,
};

/** A steep reach, so the standing-wave branch is compiled AND executed. */
const COMPILE_RIVER = {
  id: "compile-reach",
  points: [
    [0, 120, -400],
    [40, 108, -160],
    [60, 101, 90],
    [30, 99, 340],
  ].map(([x, y, z]) => ({
    x: x!,
    y: y!,
    z: z!,
    widthMeters: 18,
    flowSpeedMetersPerSecond: 3.1,
    estimatedDischargeCubicMetersPerSecond: 90,
  })),
  termination: "sea",
  lengthMeters: 760,
  maximumWidthMeters: 18,
} as HydrologyRiver;

const COMPILE_LAKE = {
  id: "compile-lake",
  centerX: 900,
  centerZ: 0,
  surfaceHeight: 98,
  maximumDepthMeters: 22,
  radiusMeters: 620,
  areaSquareMeters: Math.PI * 620 * 620,
  flowDirection: [0, 1],
  boundary: Array.from({ length: 28 }, (_, index) => {
    const angle = (index / 28) * Math.PI * 2;
    return { x: 900 + Math.cos(angle) * 620, y: 98, z: Math.sin(angle) * 620 };
  }),
} as HydrologyLake;

const PROBES: readonly ChannelProbe[] = [
  // --- the analytic sentinel: payload 0 must produce the exact zero struct ---
  riverProbe("analytic river", { channelPayload: 0 }),
  riverProbe("analytic river, fast", { channelPayload: 0, flowSpeed: 6, footprint: 0.004 }),
  riverProbe("analytic lake", { channelPayload: 0, lakeFactor: 1 }),
  riverProbe("analytic lake, gale", {
    channelPayload: 0,
    lakeFactor: 1,
    windVelocity: [21, 9],
    footprint: 0.002,
  }),
  riverProbe("analytic river, far", { channelPayload: 0, footprint: 40 }),
  // --- live channels ---
  riverProbe("steep rapid"),
  riverProbe("steep rapid, elsewhere in time", { time: 1_234.5 }),
  riverProbe("flat reach", { channelPayload: 1.0, flowSpeed: 0.6 }),
  riverProbe("distant reach", { footprint: 22 }),
  {
    label: "big lake",
    worldXZ: SITE,
    flowDirection: FLOW,
    windVelocity: WIND,
    channelPayload: 2,
    lakeFactor: 1,
    flowSpeed: 0.18,
    arcLengthMeters: 0,
    laneCoordinate: 0.5,
    time: 91.25,
    footprint: 0.05,
    shoreProximity: 0,
    bankNormal: [0.6, -0.8],
  },
  {
    label: "pond",
    worldXZ: SITE,
    flowDirection: FLOW,
    windVelocity: WIND,
    channelPayload: 1 + Math.sqrt(60 / 20_000),
    lakeFactor: 1,
    flowSpeed: 0.18,
    arcLengthMeters: 0,
    laneCoordinate: 0.5,
    time: 91.25,
    footprint: 0.05,
    shoreProximity: 0,
    bankNormal: [0.6, -0.8],
  },
  // --- world-locking: identical everything but the clock ---
  ...WORLD_LOCK_TIMES.map((time) => riverProbe(`world lock t=${time}`, { time })),
  // --- seam: one world point reached from two lanes, rows and reaches ---
  //     Mid-channel (shoreProximity 0), because 6-2's bank run-up is keyed on
  //     the arc length ON PURPOSE — the bank swash travels downstream — and it
  //     is therefore the one term that legitimately differs between two
  //     reaches meeting at a point. The thalweg is where the seam claim lives.
  riverProbe("seam A", {
    flowSpeed: 1,
    footprint: ADVECTED_ONLY_FOOTPRINT,
    arcLengthMeters: 0,
    laneCoordinate: 0,
    shoreProximity: 0,
  }),
  riverProbe("seam B", {
    flowSpeed: 1,
    footprint: ADVECTED_ONLY_FOOTPRINT,
    arcLengthMeters: 141_732.5,
    laneCoordinate: 1,
    shoreProximity: 0,
  }),
  riverProbe("seam C", {
    flowSpeed: 1,
    footprint: ADVECTED_ONLY_FOOTPRINT,
    arcLengthMeters: 37.125,
    laneCoordinate: 0.75,
    shoreProximity: 0,
  }),
  // --- 6-2: the bank run-up, on and off the bank band ---
  riverProbe("thalweg", { shoreProximity: 0 }),
  riverProbe("bank edge", { shoreProximity: 0.76 }),
  riverProbe("bank", { shoreProximity: 1 }),
  riverProbe("backwater bank", { shoreProximity: 1, flowSpeed: 0.05 }),
  {
    label: "lake shore",
    worldXZ: SITE,
    flowDirection: FLOW,
    windVelocity: WIND,
    channelPayload: 2,
    lakeFactor: 1,
    flowSpeed: 0.18,
    arcLengthMeters: 0,
    laneCoordinate: 0.5,
    time: 91.25,
    footprint: 0.05,
    shoreProximity: 1,
    bankNormal: [0.6, -0.8],
  },
  {
    label: "pond shore",
    worldXZ: SITE,
    flowDirection: FLOW,
    windVelocity: WIND,
    channelPayload: 1 + Math.sqrt(60 / 20_000),
    lakeFactor: 1,
    flowSpeed: 0.18,
    arcLengthMeters: 0,
    laneCoordinate: 0.5,
    time: 91.25,
    footprint: 0.05,
    shoreProximity: 1,
    bankNormal: [0.6, -0.8],
  },
  // --- amplitude vs exported flow speed, read off the roughness handoff so
  //     the measurement carries no lattice noise at all: past every octave's
  //     fade the term is exactly sum(A_i^2) * speedGain^2 * factor, and the
  //     grade payload is 0 so the standing train contributes nothing.
  ...SPEED_SWEEP.map((flowSpeed) => riverProbe(`speed ${flowSpeed}`, {
    flowSpeed,
    channelPayload: 1,
    footprint: 40,
  })),
];

interface LawProbe {
  readonly label: string;
  readonly first: number;
  readonly second: number;
  readonly scale: number;
  readonly time: number;
}

const LAW_PROBES: readonly LawProbe[] = [
  { label: "still water", first: 0, second: 0, scale: WATER_FLOW_SCALE_METERS[0], time: 0 },
  { label: "slow reach", first: 0.4, second: 0.1, scale: WATER_FLOW_SCALE_METERS[0], time: 3.5 },
  { label: "walking pace", first: 1.2, second: 0.3, scale: WATER_FLOW_SCALE_METERS[1], time: 61.25 },
  { label: "riffle", first: 2.4, second: 0.5, scale: WATER_FLOW_SCALE_METERS[2], time: 611.75 },
  { label: "rapid", first: 3.6, second: 0.85, scale: WATER_FLOW_SCALE_METERS[1], time: 4_097.5 },
  { label: "torrent", first: 6.5, second: 1, scale: WATER_FLOW_SCALE_METERS[0], time: 20_000.5 },
  { label: "gale on a big lake", first: 21, second: 1, scale: WATER_FLOW_SCALE_METERS[2], time: 12.5 },
  { label: "calm on a pond", first: 1.5, second: 0.055, scale: WATER_FLOW_SCALE_METERS[1], time: 44.25 },
  // Phase wrap edges: weightA must vanish exactly where copy A's age wraps.
  { label: "phase wrap", first: 1, second: 0.4, scale: 9, time: 9 },
  { label: "phase midpoint", first: 1, second: 0.4, scale: 9, time: 13.5 },
];

async function runCompute(
  source: string,
  entryPoint: string,
  probeData: Float32Array,
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
      `water-channel-${entryPoint}`,
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
      Math.ceil((probeData.length / PROBE_FLOATS) || 1),
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

describe("6-1 channel flow WGSL/TS parity", () => {
  it("agrees with the exported oracle on every pure law", async () => {
    const LAW_PROBE_FLOATS = 4;
    const probeData = new Float32Array(LAW_PROBES.length * LAW_PROBE_FLOATS);
    LAW_PROBES.forEach((probe, index) => {
      const base = index * LAW_PROBE_FLOATS;
      probeData[base] = probe.first;
      probeData[base + 1] = probe.second;
      probeData[base + 2] = probe.scale;
      probeData[base + 3] = probe.time;
    });
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, { antialias: false });
    await engine.initAsync();
    try {
      const probeBuffer = new StorageBuffer(engine, probeData.byteLength);
      probeBuffer.update(probeData);
      const resultBuffer = new StorageBuffer(
        engine,
        LAW_PROBES.length * 16 * Float32Array.BYTES_PER_ELEMENT,
      );
      const shader = new ComputeShader(
        "water-channel-laws",
        engine,
        { computeSource: CHANNEL_LAW_WGSL },
        {
          bindingsMapping: {
            probes: { group: 0, binding: 0 },
            results: { group: 0, binding: 1 },
          },
          entryPoint: "evaluateLaws",
        },
      );
      shader.setStorageBuffer("probes", probeBuffer);
      shader.setStorageBuffer("results", resultBuffer);
      engine.runRenderLoop(() => {});
      await shader.dispatchWhenReady(Math.ceil(LAW_PROBES.length / 16), 1, 1);
      expect(shader.isReady()).toBe(true);
      const view = await resultBuffer.read();
      engine.stopRenderLoop();
      const results = new Float32Array(
        view.buffer,
        view.byteOffset,
        LAW_PROBES.length * 16,
      );

      const names = [
        "cycleSeconds", "ageA", "ageB", "weightA",
        "weightB", "speedGain", "standingWavelength", "standingWavenumber",
        "standingSlope", "standingCurvature", "breaking", "chopWavelength",
        "chopHs", "chopSlope", "chopDrift", "chopCycle",
      ] as const;
      LAW_PROBES.forEach((probe, index) => {
        const cycle = waterFlowCycleSeconds(probe.scale, probe.first);
        const phase = waterFlowPhase(probe.time, cycle);
        const standing = waterStandingWave(probe.first, probe.second);
        const chop = waterLakeChop(probe.first, probe.second);
        const oracle = [
          cycle, phase.ageA, phase.ageB, phase.weightA,
          phase.weightB, waterFlowSpeedGain(probe.first),
          standing.wavelengthMeters, standing.wavenumber,
          standing.slopeAmplitude, standing.curvatureAmplitude, standing.breaking,
          chop.wavelengthMeters,
          chop.significantHeightMeters, chop.slopeAmplitude,
          chop.driftSpeed, chop.cycleSeconds,
        ];
        // The four phase lanes reach the clock through `fract(time / cycle)`,
        // and f32 drops the low bits of `time / cycle` BEFORE the fract can
        // use them. The residual is therefore the quantum of the accumulated
        // clock, not a shader defect, and it is bounded explicitly here rather
        // than hidden under a blanket fudge — 4 ulps of the cycle count, times
        // the d(weight)/d(phase) of 2 on the weight lanes. At 20,000 s of
        // continuous flight this is ~7e-3 of a 1.4 s cycle, i.e. a tenth of a
        // frame: which is the reason the Lagrangian age is bounded at all.
        const phaseQuantum = Math.abs(probe.time / cycle) * 1.1920929e-7 * 4;
        const laneTolerance = [
          0, phaseQuantum * cycle, phaseQuantum * cycle, phaseQuantum * 2, phaseQuantum * 2,
        ];
        for (let lane = 0; lane < 16; lane += 1) {
          const gpu = results[index * 16 + lane]!;
          const cpu = oracle[lane]!;
          // f32 against f64: single-precision epsilon on the magnitude, plus
          // the clock quantum where it applies.
          const tolerance = Math.max(Math.abs(cpu), 1) * 2e-5 + (laneTolerance[lane] ?? 0);
          expect(
            Math.abs(gpu - cpu),
            `${probe.label} ${names[lane]}: gpu ${gpu} vs oracle ${cpu}`,
          ).toBeLessThan(tolerance);
        }
      });

      // Properties read off the GPU's own numbers.
      const lawOf = (label: string, lane: number): number =>
        results[LAW_PROBES.findIndex((probe) => probe.label === label) * 16 + lane]!;
      // The dual-phase partition: copy A carries zero weight exactly where its
      // age wraps, and the pair is energy-normalised everywhere.
      expect(lawOf("phase wrap", 3)).toBeCloseTo(0, 5);
      expect(lawOf("phase wrap", 4)).toBeCloseTo(1, 5);
      expect(lawOf("phase midpoint", 3)).toBeCloseTo(1, 5);
      expect(lawOf("phase midpoint", 4)).toBeCloseTo(0, 5);
      for (const probe of LAW_PROBES) {
        const weightA = lawOf(probe.label, 3);
        const weightB = lawOf(probe.label, 4);
        expect(
          Math.hypot(weightA, weightB),
          `${probe.label} dual-phase energy`,
        ).toBeCloseTo(1, 4);
      }
      // Standing wavelength is 2 pi v^2 / g between the clamps: a 2.4 m/s
      // riffle stands 3.7 m waves, a 3.6 m/s rapid 8.3 m.
      expect(lawOf("riffle", 6)).toBeCloseTo((2 * Math.PI * 2.4 ** 2) / 9.81, 3);
      expect(lawOf("rapid", 6)).toBeCloseTo((2 * Math.PI * 3.6 ** 2) / 9.81, 3);
      expect(lawOf("still water", 6)).toBeCloseTo(1.2, 5);
      // Never past the Stokes limiting steepness.
      for (const probe of LAW_PROBES) {
        expect(lawOf(probe.label, 8), `${probe.label} standing steepness`)
          .toBeLessThanOrEqual(0.4 + 1e-6);
      }
      // Fetch-limited chop: a pond is centimetres, a big lake is decimetres.
      expect(lawOf("calm on a pond", 12)).toBeLessThan(0.02);
      expect(lawOf("gale on a big lake", 12)).toBeGreaterThan(1);
      // And the chop travels at its own deep-water phase speed.
      const chopWavelength = lawOf("gale on a big lake", 11);
      expect(lawOf("gale on a big lake", 14))
        .toBeCloseTo(Math.sqrt((9.81 * chopWavelength) / (2 * Math.PI)), 3);

      probeBuffer.dispose();
      resultBuffer.dispose();
    } finally {
      engine.dispose();
      canvas.remove();
    }
  });

  it("is exactly dark under the analytic sentinel, world-locked, and seam-free", async () => {
    const probeData = new Float32Array(PROBES.length * PROBE_FLOATS);
    PROBES.forEach((probe, index) => {
      const base = index * PROBE_FLOATS;
      probeData[base] = probe.worldXZ[0];
      probeData[base + 1] = probe.worldXZ[1];
      probeData[base + 2] = probe.flowDirection[0];
      probeData[base + 3] = probe.flowDirection[1];
      probeData[base + 4] = probe.windVelocity[0];
      probeData[base + 5] = probe.windVelocity[1];
      probeData[base + 6] = probe.bankNormal[0];
      probeData[base + 7] = probe.bankNormal[1];
      probeData[base + 8] = probe.channelPayload;
      probeData[base + 9] = probe.lakeFactor;
      probeData[base + 10] = probe.flowSpeed;
      probeData[base + 11] = probe.arcLengthMeters;
      probeData[base + 12] = probe.laneCoordinate;
      probeData[base + 13] = probe.time;
      probeData[base + 14] = probe.footprint;
      probeData[base + 15] = probe.shoreProximity;
    });
    const results = await runCompute(
      CHANNEL_PROBE_WGSL,
      "evaluateChannelFlow",
      probeData,
      PROBES.length * RESULT_FLOATS,
    );
    const fieldsOf = (label: string): readonly number[] => {
      const index = PROBES.findIndex((probe) => probe.label === label);
      expect(index, `probe ${label}`).toBeGreaterThanOrEqual(0);
      return Array.from(results.subarray(index * RESULT_FLOATS, (index + 1) * RESULT_FLOATS));
    };

    // 1. The analytic byte-identity claim, measured on the hardware: the whole
    //    struct is exactly zero, so nothing the fragment adds can move a bit.
    //    `toBe` is Object.is, so a signed zero would fail here too.
    for (const label of [
      "analytic river",
      "analytic river, fast",
      "analytic lake",
      "analytic lake, gale",
      "analytic river, far",
    ]) {
      expect(fieldsOf(label), `${label} must be the exact zero struct`)
        .toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    }
    // And the live probes are NOT zero, so the test above is not vacuous.
    expect(fieldsOf("steep rapid").some((value) => value !== 0)).toBe(true);
    expect(fieldsOf("big lake").some((value) => value !== 0)).toBe(true);

    // 2. World-locking. Crest, breaking weight, phase and curvature are
    //    bit-identical across five decades of clock: the standing train is a
    //    function of the world-anchored arc length and nothing else.
    const locked = WORLD_LOCK_TIMES.map((time) => fieldsOf(`world lock t=${time}`));
    for (const fields of locked.slice(1)) {
      // lanes 3..6 are crest, crestWeight, standingPhase, standingCurvature.
      expect(fields.slice(3, 7)).toEqual(locked[0]!.slice(3, 7));
    }
    expect(locked[0]![5]).not.toBe(0);
    // The ADVECTED half of the same probes did move, so the lock above is a
    // property of the standing term rather than of a dead shader.
    expect(locked.some((fields) => fields[0] !== locked[0]![0])).toBe(true);

    // 3. Seams. One world point, three different arc lengths and lane
    //    coordinates — i.e. reached from different reaches, mesh rows and
    //    lanes — with the standing train faded out. The advected field carries
    //    no such state, so the results agree bit for bit.
    const seamA = fieldsOf("seam A");
    expect(fieldsOf("seam B")).toEqual(seamA);
    expect(fieldsOf("seam C")).toEqual(seamA);
    expect(seamA[0]).not.toBe(0);

    // 3b. 6-2's bank run-up, measured through the shipped shader: dark in the
    //     thalweg and at the band edge, live on the bank, and scaled by the
    //     DRIVER's strength — a backwater bank barely laps, a pond's rim does
    //     not foam at all while a 20 km lake's does.
    expect(fieldsOf("thalweg")[7]).toBe(0);
    expect(fieldsOf("bank edge")[7]).toBe(0);
    expect(fieldsOf("bank")[7]).toBeGreaterThan(0);
    expect(fieldsOf("backwater bank")[7])
      .toBeLessThan(fieldsOf("bank")[7]!);
    expect(fieldsOf("lake shore")[7]).toBeGreaterThan(0);
    expect(fieldsOf("pond shore")[7]!).toBeLessThan(fieldsOf("lake shore")[7]! * 0.15);
    // It is a foam WEIGHT, so it can never leave [0, 1].
    for (const label of ["bank", "backwater bank", "lake shore", "pond shore"]) {
      expect(fieldsOf(label)[7], `${label} bank run-up range`)
        .toBeGreaterThanOrEqual(0);
      expect(fieldsOf(label)[7], `${label} bank run-up range`)
        .toBeLessThanOrEqual(1);
    }

    // 4. Distance behaviour: every octave hands its energy to roughness as it
    //    fades, so a far fragment has slope near zero but non-zero unresolved
    //    mean-square slope.
    const distant = fieldsOf("distant reach");
    expect(Math.hypot(distant[0]!, distant[1]!)).toBeLessThan(1e-6);
    expect(distant[2]).toBeGreaterThan(0);

    // 5. Amplitude rises MONOTONICALLY with the exported flow speed, measured
    //    through the shipped shader. Read at the roughness handoff so the
    //    number is the octaves' energy rather than one lattice sample, and it
    //    must track speedGain^2 exactly.
    const sweep = SPEED_SWEEP.map((speed) => fieldsOf(`speed ${speed}`)[2]!);
    for (let index = 1; index < sweep.length; index += 1) {
      expect(sweep[index]!, `speed ${SPEED_SWEEP[index]} energy`)
        .toBeGreaterThan(sweep[index - 1]!);
    }
    SPEED_SWEEP.forEach((speed, index) => {
      const predicted = (waterFlowSpeedGain(speed) / waterFlowSpeedGain(SPEED_SWEEP[0]!)) ** 2;
      expect(sweep[index]! / sweep[0]!, `speed ${speed} vs speedGain^2`)
        .toBeCloseTo(predicted, 3);
    });
    // A backwater still carries texture (the gain has a floor) and a torrent
    // carries an order of magnitude more of it.
    expect(sweep[0]).toBeGreaterThan(0);
    expect(sweep.at(-1)! / sweep[0]!).toBeGreaterThan(10);
  });

  it("compiles the composed inland fragment blocks at fragment stage", async () => {
    const adapter = await navigator.gpu.requestAdapter();
    expect(adapter).not.toBeNull();
    const device = await adapter!.requestDevice();
    try {
      // Exactly the order the hydrology fragment composes them in.
      const source = /* wgsl */ `
${WATER_CAUSTIC_WGSL}

${WATER_DETAIL_NOISE_WGSL}

${WATER_CAPILLARY_DETAIL_WGSL}

${WATER_SHORE_RUNUP_WGSL}

${WATER_CHANNEL_FLOW_WGSL}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return vec4f(f32(index) - 1.0, f32(index & 1u) * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let worldXZ = vec2f(128000.0 + position.x * 0.05, -64000.0 + position.y * 0.05);
  // The footprint is taken in UNIFORM control flow, exactly as the shipped
  // fragment does, and handed to the sentinel-branched call.
  let derivativeX = dpdx(worldXZ);
  let derivativeY = dpdy(worldXZ);
  let footprint = max(
    min(length(derivativeX), length(derivativeY)),
    max(length(derivativeX), length(derivativeY)) * 0.0625,
  );
  var slope = vec2f(0.0);
  var extra = 0.0;
  if (position.x > 0.0) {
    let flow = waterChannelFlow(
      1.5, 0.0, worldXZ, vec2f(0.8, 0.6), 2.4, 8412.5, 0.5,
      vec2f(5.2, -2.4), 12.5, footprint, 1.0, vec2f(0.6, -0.8));
    slope += flow.slope;
    extra += flow.unresolvedMeanSquareSlope + flow.crest + flow.crestWeight
      + flow.standingPhase + flow.standingCurvature + flow.bankRunup;
  }
  return vec4f(slope, extra, 1.0);
}
`;
      const shaderModule = device.createShaderModule({ code: source });
      const info = await shaderModule.getCompilationInfo();
      const problems = info.messages.filter((message) => message.type !== "info");
      expect(
        problems.map(
          (message) => `${message.type} ${message.lineNum}:${message.linePos} ${message.message}`,
        ),
      ).toEqual([]);
      device.pushErrorScope("validation");
      device.createRenderPipeline({
        layout: "auto",
        vertex: { module: shaderModule, entryPoint: "vertexMain" },
        fragment: {
          module: shaderModule,
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

  /**
   * The whole shipped inland material, through Babylon's own WGSL processor,
   * on a real adapter — the gate nothing else in the tree provides.
   *
   * Every other assertion about `HYDROLOGY_WATER_FRAGMENT_WGSL` is a string
   * match or a text hash, so a swizzle typo or a declaration-order mistake in
   * the composed fragment is not a failing test, it is a renderer stuck on
   * "PREPARING AIRSPACE" — the recorded wave-R incident. 6-1 widened a varying,
   * added a struct-returning call inside a branch and re-routed two fold sites,
   * which is exactly the class of edit that produces one.
   */
  it("compiles the shipped graph-mode inland water material end to end", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, {
      antialias: false,
      enableAllFeatures: false,
      setMaximumLimits: false,
    });
    await engine.initAsync();
    const gpuErrors: string[] = [];
    const device = (engine as unknown as { _device: GPUDevice })._device;
    device.addEventListener("uncapturederror", (event) => {
      gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
    });
    const loggerErrors: string[] = [];
    const originalLoggerError = Logger.Error;
    Logger.Error = ((message: string | unknown[], limit?: number) => {
      loggerErrors.push(Array.isArray(message) ? message.join(" ") : String(message));
      originalLoggerError.call(Logger, message as string, limit);
    }) as typeof Logger.Error;
    const scene = new Scene(engine);
    try {
      const camera = new FreeCamera("channel-flow-camera", new Vector3(0, 12, -160), scene);
      camera.setTarget(new Vector3(0, 0, 0));
      scene.activeCamera = camera;
      const system = new HydrologySystem(scene, camera, {
        atmosphere: GPU_ATMOSPHERE,
        worldSeed: "channel-flow-compile",
        terrainSample: () => {
          throw new Error("graph mode must not sample analytic terrain");
        },
        seaLevel: 0,
        centerX: 0,
        centerZ: 0,
        graphHydrology: { rivers: [COMPILE_RIVER], lakes: [COMPILE_LAKE] },
      });
      expect(system.riverMesh).not.toBeNull();
      expect(system.lakeMesh).not.toBeNull();
      // A pipeline that fails to compile never settles, so the wait is bounded
      // (the D-6 lesson: a documented fallback behind an unbounded await is not
      // a fallback).
      engine.runRenderLoop(() => {});
      let readinessTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          scene.whenReadyAsync(),
          new Promise((_, reject) => {
            readinessTimeout = setTimeout(
              () => reject(new Error("inland water material never became ready")),
              30_000,
            );
          }),
        ]);
      } finally {
        if (readinessTimeout !== undefined) clearTimeout(readinessTimeout);
      }
      // Readiness IS the compile: Babylon reports a material ready only once
      // its Effect has compiled, and a WGSL error leaves it false forever —
      // which is precisely the "PREPARING AIRSPACE" hang. This test
      // deliberately stops here rather than drawing: the material's remaining
      // texture bindings (bathymetry, cloud shadow, sun shadow, planar
      // reflection) come from four subsystems the renderer owns and 6-1 does
      // not touch, so binding stubs for them would test their plumbing, not
      // this shader.
      for (const mesh of [system.riverMesh!, system.lakeMesh!]) {
        expect(mesh.material, `${mesh.name} material`).not.toBeNull();
        expect(mesh.material!.isReady(mesh), `${mesh.name} effect compiled`).toBe(true);
      }
      await device.queue.onSubmittedWorkDone();
      engine.stopRenderLoop();
      expect(gpuErrors, gpuErrors.join("\n\n")).toEqual([]);
      expect(
        loggerErrors.filter((message) => /compil|wgsl|shader source|Effect/iu.test(message)),
        loggerErrors.join("\n\n"),
      ).toEqual([]);
      system.dispose();
    } finally {
      Logger.Error = originalLoggerError;
      scene.dispose();
      engine.dispose();
      canvas.remove();
    }
  }, 60_000);
});
