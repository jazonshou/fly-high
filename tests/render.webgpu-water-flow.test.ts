import { describe, expect, it } from "vitest";
import { Color3, FreeCamera, NullEngine, Scene, Vector2, Vector3 } from "@babylonjs/core";
import type { AtmosphereSnapshot } from "../src/render/webgpu/atmosphere/AtmosphereSystem";
import {
  HYDROLOGY_WATER_FRAGMENT_WGSL,
  HYDROLOGY_WATER_VERTEX_WGSL,
  HydrologySystem,
} from "../src/render/webgpu/water/HydrologySystem";
import type {
  HydrologyLake,
  HydrologyRiver,
} from "../src/render/webgpu/water/HydrologyGeneration";
import {
  WATER_CHANNEL_FLOW_WGSL,
  WATER_CHANNEL_GRADE_REFERENCE,
  WATER_CHANNEL_SENTINEL_BASE,
  WATER_FLOW_CYCLE_MAXIMUM_SECONDS,
  WATER_FLOW_CYCLE_MINIMUM_SECONDS,
  WATER_FLOW_DRIFT_FRACTION,
  WATER_FLOW_FADE_HIGH,
  WATER_FLOW_FADE_LOW,
  WATER_FLOW_GRAVITY,
  WATER_FLOW_SCALE_METERS,
  WATER_FLOW_SLOPE_AMPLITUDE,
  WATER_FLOW_SPEED_GAIN_CAP,
  WATER_LAKE_CHOP_FADE_HIGH,
  WATER_LAKE_CHOP_FADE_LOW,
  WATER_LAKE_CHOP_HEIGHT_COEFFICIENT,
  WATER_LAKE_EFFECTIVE_FETCH_FACTOR,
  WATER_LAKE_FETCH_FLOOR_METERS,
  WATER_LAKE_FETCH_REFERENCE_METERS,
  WATER_STANDING_BREAK_HIGH,
  WATER_STANDING_BREAK_LOW,
  WATER_STANDING_FADE_HIGH,
  WATER_STANDING_FADE_LOW,
  WATER_STANDING_MAXIMUM_SLOPE,
  WATER_STANDING_MAXIMUM_WAVELENGTH_METERS,
  WATER_STANDING_MINIMUM_WAVELENGTH_METERS,
  waterChannelGradePayload,
  waterFlowCycleSeconds,
  waterFlowPhase,
  waterFlowSpeedGain,
  waterLakeChop,
  waterLakeEffectiveFetchMeters,
  waterLakeFetchPayload,
  waterStandingWave,
} from "../src/render/webgpu/water/WaterShaders";
import { WATER_FRAGMENT_WGSL, WATER_VERTEX_WGSL }
  from "../src/render/webgpu/water/SpectralOceanSystem";
import { resampleHydrologyRiverStations } from "../src/render/webgpu/water/riverResample";

/**
 * 6-1 — river/lake flow advection, world-locked standing waves and
 * fetch-limited lake chop.
 *
 * `tests/gpu/water-channel-flow.test.ts` pins the exported oracle used below
 * against the shipped WGSL on a real adapter and measures the analytic
 * sentinel, the world lock and the seam behaviour on the hardware. This file
 * owns the physics sweeps a GPU test would be too heavy to carry, the
 * composition rules, and the CPU payload the shader decodes.
 */

const ATMOSPHERE: AtmosphereSnapshot = {
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

function river(points: ReadonlyArray<readonly [number, number, number]>): HydrologyRiver {
  return {
    id: "reach",
    points: points.map(([x, y, z]) => ({
      x,
      y,
      z,
      widthMeters: 12,
      flowSpeedMetersPerSecond: 2,
      estimatedDischargeCubicMetersPerSecond: 40,
    })),
    termination: "sea",
    lengthMeters: 0,
    maximumWidthMeters: 12,
  } as HydrologyRiver;
}

function lake(radius: number, sides = 24): HydrologyLake {
  const boundary = Array.from({ length: sides }, (_, index) => {
    const angle = (index / sides) * Math.PI * 2;
    return { x: Math.cos(angle) * radius, y: 100, z: Math.sin(angle) * radius };
  });
  return {
    id: "lake",
    centerX: 0,
    centerZ: 0,
    surfaceHeight: 100,
    maximumDepthMeters: 14,
    radiusMeters: radius,
    areaSquareMeters: Math.PI * radius * radius,
    flowDirection: [0, 1],
    boundary,
  } as HydrologyLake;
}

function buildMeshes(
  rivers: readonly HydrologyRiver[],
  lakes: readonly HydrologyLake[],
): { readonly riverWater: number[]; readonly lakeWater: number[]; readonly riverUv: number[] } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera("flow-camera", new Vector3(0, 300, -600), scene);
  const system = new HydrologySystem(scene, camera, {
    atmosphere: ATMOSPHERE,
    worldSeed: "flow-6-1",
    terrainSample: () => {
      throw new Error("graph mode must not sample analytic terrain");
    },
    seaLevel: 0,
    centerX: 0,
    centerZ: 0,
    graphHydrology: { rivers, lakes },
  });
  const riverWater = Array.from(system.riverMesh?.getVerticesData("waterData") ?? []);
  const riverUv = Array.from(system.riverMesh?.getVerticesData("uv") ?? []);
  const lakeWater = Array.from(system.lakeMesh?.getVerticesData("waterData") ?? []);
  system.dispose();
  scene.dispose();
  engine.dispose();
  return { riverWater, lakeWater, riverUv };
}

describe("6-1 channel flow composition", () => {
  it("is composed into the inland material only, from one definition", () => {
    // Every input is channel-graph hydraulics, so the ocean composes nothing
    // of this. Naming that here keeps 6-2/6-3 from assuming otherwise when
    // they take the ocean surface.
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain(WATER_CHANNEL_FLOW_WGSL);
    expect(WATER_FRAGMENT_WGSL).not.toContain(WATER_CHANNEL_FLOW_WGSL);
    expect(WATER_VERTEX_WGSL).not.toContain("waterChannelFlow");
    expect(HYDROLOGY_WATER_VERTEX_WGSL).not.toContain("waterChannelFlow");
    for (const helper of [
      "fn waterFlowPhase(",
      "fn waterFlowOctave(",
      "fn waterFlowSpeedGain(",
      "fn waterStandingWave(",
      "fn waterLakeChop(",
      "fn waterChannelFlow(",
    ]) {
      expect(HYDROLOGY_WATER_FRAGMENT_WGSL.split(helper)).toHaveLength(2);
      expect(WATER_FRAGMENT_WGSL, `ocean must not define ${helper}`)
        .not.toContain(helper);
    }
    // It reuses the shared lattices rather than redefining one — the §3.6
    // drift the extraction gate exists to prevent.
    const code = WATER_CHANNEL_FLOW_WGSL.replace(/\/\/.*$/gmu, "");
    expect(code).toContain("waterCapillaryOctave(");
    expect(code).toContain("waterDetailValue(");
    expect(code).toContain("waterGustField(");
    expect(code).not.toContain("fn waterDetailHash");
  });

  it("declares no uniform, binding, sampler or derivative", () => {
    // This is what lets the GPU parity test compile and run the shipped block
    // standalone — and, more importantly, what makes the sentinel branch legal:
    // a derivative built-in may not be called from non-uniform control flow, so
    // the footprint is a parameter and the caller takes it in uniform flow.
    const code = WATER_CHANNEL_FLOW_WGSL.replace(/\/\/.*$/gmu, "");
    for (const forbidden of [
      "uniforms.", "texture", "sampler", "@group", "var<", "dpdx", "dpdy", "fwidth",
    ]) {
      expect(code, `channel flow block must not reference ${forbidden}`)
        .not.toContain(forbidden);
    }
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain("let channelDerivativeX = dpdx(");
    // The derivatives are taken before the sentinel branch opens.
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL.indexOf("let channelDerivativeX"))
      .toBeLessThan(HYDROLOGY_WATER_FRAGMENT_WGSL.indexOf("if (input.waterInfo.w > 0.0)"));
  });

  it("keeps every smoothstep window ascending", () => {
    // The reversed-smoothstep incident: the clamped helper turns a reversed
    // pair into a hard step, and ten masks shipped that way. Every window here
    // is a pair of exported constants, so the check is on the constants.
    expect(WATER_FLOW_FADE_LOW).toBeLessThan(WATER_FLOW_FADE_HIGH);
    expect(WATER_STANDING_FADE_LOW).toBeLessThan(WATER_STANDING_FADE_HIGH);
    expect(WATER_LAKE_CHOP_FADE_LOW).toBeLessThan(WATER_LAKE_CHOP_FADE_HIGH);
    expect(WATER_STANDING_BREAK_LOW).toBeLessThan(WATER_STANDING_BREAK_HIGH);
    // And no literal reversed pair crept into the block.
    const code = WATER_CHANNEL_FLOW_WGSL
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/.*$/gmu, "");
    const reversed: string[] = [];
    for (const match of code.matchAll(/smoothstep\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,/gu)) {
      if (Number(match[2]) <= Number(match[1])) reversed.push(match[0]);
    }
    expect(reversed).toEqual([]);
  });

  it("generates its WGSL constants from the TypeScript the oracle uses", () => {
    // No literal is re-typed across the language boundary: a retune moves the
    // shader and the oracle in the same edit.
    expect(WATER_CHANNEL_FLOW_WGSL).toContain(
      `const WATER_CHANNEL_SENTINEL_BASE: f32 = ${WATER_CHANNEL_SENTINEL_BASE}.0;`,
    );
    expect(WATER_CHANNEL_FLOW_WGSL).toContain(
      `const WATER_LAKE_CHOP_HEIGHT_COEFFICIENT: f32 = ${WATER_LAKE_CHOP_HEIGHT_COEFFICIENT};`,
    );
    expect(WATER_CHANNEL_FLOW_WGSL).toContain(
      `const WATER_STANDING_MAXIMUM_SLOPE: f32 = ${WATER_STANDING_MAXIMUM_SLOPE};`,
    );
    expect(WATER_CHANNEL_FLOW_WGSL).toContain(
      `const WATER_FLOW_SCALE_BOIL: f32 = ${WATER_FLOW_SCALE_METERS[0]}.0;`,
    );
    expect(WATER_CHANNEL_FLOW_WGSL).toContain(
      `const WATER_FLOW_SLOPE_WAVELET: f32 = ${WATER_FLOW_SLOPE_AMPLITUDE[1]};`,
    );
  });
});

describe("6-1 the analytic sentinel", () => {
  it("guards every channel term behind the zero payload", () => {
    // The dark-by-default contract, checked at the composition level: nothing
    // 6-1 adds is evaluated, and nothing 6-1 adds is ARITHMETICALLY folded in,
    // outside the sentinel branch. `surfaceSlope` and `unresolvedSlope` start
    // as the pre-6-1 expressions and are only ever `+=`-ed inside it, so the
    // analytic path executes no add-of-zero that could turn a signed zero.
    const fragment = HYDROLOGY_WATER_FRAGMENT_WGSL;
    expect(fragment).toContain("var surfaceSlope = capillary.slope;");
    expect(fragment).toContain(
      "var unresolvedSlope = capillary.unresolvedMeanSquareSlope;",
    );
    expect(fragment).toContain("if (input.waterInfo.w > 0.0) {");
    // Exactly one call site, inside the guard.
    const guardIndex = fragment.indexOf("if (input.waterInfo.w > 0.0) {");
    const callIndex = fragment.indexOf("waterChannelFlow(\n      input.waterInfo.w");
    expect(callIndex).toBeGreaterThan(guardIndex);
    expect(fragment.split("waterChannelFlow(")).toHaveLength(3); // 1 definition + 1 call
    // The three downstream consumers are each guarded by a value that is zero
    // when the sentinel is dark.
    expect(fragment).toContain("if (channelStandingCurvature > 0.0) {");
    expect(fragment).toContain("if (channelCrestWeight > 0.0) {");
    expect(fragment).toContain("var rapidCrest = flowCrest;");
    // The pre-6-1 fold sites now read the accumulators, not the raw capillary
    // struct, so there is exactly one place the channel term can enter.
    expect(fragment).toContain("-fragmentGradient.x + surfaceSlope.x,");
    expect(fragment).toContain("min(unresolvedSlope, 0.25)");
  });

  it("returns the exact zero struct for a dark payload", () => {
    // The oracle half of the same claim; the GPU test measures it on hardware.
    expect(waterStandingWave(2.4, 0).slopeAmplitude).toBe(0);
    expect(waterStandingWave(2.4, 0).curvatureAmplitude).toBe(0);
    expect(waterStandingWave(2.4, 0).breaking).toBe(0);
    expect(waterLakeChop(9, 0).significantHeightMeters).toBe(0);
    expect(waterLakeChop(9, 0).slopeAmplitude).toBe(0);
  });

  it("keeps analytic builders writing a literal zero into the payload lane", () => {
    // The sentinel only works because the analytic mesh builders never touch
    // `waterData.w`. The W-5 analytic non-regression byte pin is the primary
    // guard; this is the readable statement of why it matters.
    const analytic = buildMeshesAnalytic();
    for (let index = 3; index < analytic.riverWater.length; index += 4) {
      expect(analytic.riverWater[index]).toBe(0);
    }
    for (let index = 3; index < analytic.lakeWater.length; index += 4) {
      expect(analytic.lakeWater[index]).toBe(0);
    }
    expect(analytic.riverWater.length).toBeGreaterThan(0);
    expect(analytic.lakeWater.length).toBeGreaterThan(0);
  });
});

/** Analytic mode: no `graphHydrology`, so the legacy builders run. */
function buildMeshesAnalytic(): {
  readonly riverWater: number[];
  readonly lakeWater: number[];
} {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera("flow-analytic-camera", new Vector3(0, 300, -600), scene);
  // The same two fixtures the W-5 analytic non-regression pin uses: a tilted
  // plane the downhill tracer carves rivers on, and a bowl the basin filler
  // ponds a lake in.
  const riverSystem = new HydrologySystem(scene, camera, {
    atmosphere: ATMOSPHERE,
    worldSeed: "hydrology-system",
    terrainSample: (x, z) => ({ height: 520 - x * 0.075 + Math.sin(z * 0.004) * 3, moisture: 0.64 }),
    extentMeters: 2_400,
    sourceCandidateSpacingMeters: 400,
    minimumSourceElevationAboveSeaMeters: 0,
    minimumSourceSeparationMeters: 300,
    traceStepMeters: 60,
    maximumTraceSteps: 60,
    minimumRiverPoints: 5,
    maximumRivers: 4,
    maximumLakes: 1,
  });
  const lakeSystem = new HydrologySystem(scene, camera, {
    atmosphere: ATMOSPHERE,
    worldSeed: "basin-lakes",
    terrainSample: (x, z) => ({ height: 100 + (x * x + z * z) * 0.002, moisture: 0.78 }),
    extentMeters: 1_600,
    sourceCandidateSpacingMeters: 260,
    minimumSourceElevationAboveSeaMeters: 0,
    minimumSourceSeparationMeters: 250,
    traceStepMeters: 40,
    maximumTraceSteps: 40,
    minimumRiverPoints: 4,
    maximumRivers: 4,
    maximumLakes: 2,
  });
  const riverWater = Array.from(riverSystem.riverMesh?.getVerticesData("waterData") ?? []);
  const lakeWater = Array.from(lakeSystem.lakeMesh?.getVerticesData("waterData") ?? []);
  riverSystem.dispose();
  lakeSystem.dispose();
  scene.dispose();
  engine.dispose();
  return { riverWater, lakeWater };
}

describe("6-1 dual-phase advection", () => {
  it("partitions the cycle so a copy carries no weight where its age wraps", () => {
    const cycle = 3.5;
    for (const wrap of [0, cycle, 2 * cycle, 97 * cycle]) {
      const phase = waterFlowPhase(wrap, cycle);
      expect(phase.ageA).toBeCloseTo(0, 6);
      expect(phase.weightA).toBeCloseTo(0, 6);
      expect(phase.weightB).toBeCloseTo(1, 6);
    }
    for (const half of [0.5 * cycle, 1.5 * cycle, 20.5 * cycle]) {
      const phase = waterFlowPhase(half, cycle);
      expect(phase.ageB).toBeCloseTo(0, 6);
      expect(phase.weightB).toBeCloseTo(0, 6);
      expect(phase.weightA).toBeCloseTo(1, 6);
    }
  });

  it("holds the composed variance constant across the whole cycle", () => {
    // The two copies read decorrelated lattice offsets, so their variances add
    // and the pair must be energy-normalised. Without it the field pulses by
    // 30% twice a cycle, which is the classic naive-crossfade artefact.
    for (let step = 0; step <= 400; step += 1) {
      const phase = waterFlowPhase((step / 400) * 7.25, 7.25);
      expect(Math.hypot(phase.weightA, phase.weightB)).toBeCloseTo(1, 6);
      expect(phase.weightA).toBeGreaterThanOrEqual(0);
      expect(phase.weightB).toBeGreaterThanOrEqual(0);
    }
  });

  it("bounds the Lagrangian age, and therefore the strain and the coordinate", () => {
    // The reason the construction exists. An unbounded `v·t` shears the
    // lattice, overflows the coordinate and pops; a bounded age does none of
    // the three. The bound is the cycle, and the cycle is one correlation
    // length of travel.
    for (const scale of WATER_FLOW_SCALE_METERS) {
      for (const speed of [0, 0.05, 0.4, 1.3, 2.8, 6, 11]) {
        const cycle = waterFlowCycleSeconds(scale, speed);
        expect(cycle).toBeGreaterThanOrEqual(WATER_FLOW_CYCLE_MINIMUM_SECONDS);
        expect(cycle).toBeLessThanOrEqual(WATER_FLOW_CYCLE_MAXIMUM_SECONDS);
        for (const time of [0, 1.5, 97.25, 4_000, 86_400]) {
          const phase = waterFlowPhase(time, cycle);
          expect(phase.ageA).toBeGreaterThanOrEqual(0);
          expect(phase.ageA).toBeLessThan(cycle * (1 + 1e-6));
          expect(phase.ageB).toBeGreaterThanOrEqual(0);
          expect(phase.ageB).toBeLessThan(cycle * (1 + 1e-6));
          // The advected offset never leaves the neighbourhood of the sample
          // point, which is what keeps the world-scale lattice coordinate exact.
          expect(speed * phase.ageA).toBeLessThanOrEqual(
            speed * WATER_FLOW_CYCLE_MAXIMUM_SECONDS + 1e-6,
          );
        }
      }
    }
    // The design rule as a measurement: the drift per cycle is about one
    // feature size wherever the cycle is free. It is NOT free at the fine end
    // — a 0.36 m octave at 3.5 m/s would want a 0.1 s cycle, and below ~0.7 s
    // the cross-fade itself flickers — so the finest octave at speed is
    // deliberately allowed several feature sizes of travel per cycle. Its
    // strain is bounded anyway (that is what the bound is for) and its own
    // footprint fade retires it within ~10 m of the eye.
    for (const speed of [0.6, 1.5, 3, 5]) {
      WATER_FLOW_SCALE_METERS.forEach((scale, index) => {
        const drift = speed * WATER_FLOW_DRIFT_FRACTION[index]!;
        const travelPerCycle = drift * waterFlowCycleSeconds(scale, drift);
        const freeCycle = scale / Math.max(drift, 0.2);
        const clamped = freeCycle < WATER_FLOW_CYCLE_MINIMUM_SECONDS
          || freeCycle > WATER_FLOW_CYCLE_MAXIMUM_SECONDS;
        expect(travelPerCycle / scale).toBeLessThan(clamped ? 8 : 1 + 1e-6);
      });
    }
  });

  it("scales amplitude monotonically with the exported flow speed", () => {
    let previous = -Infinity;
    for (const speed of [0, 0.2, 0.75, 1.4, 2.6, 3.9, WATER_FLOW_SPEED_GAIN_CAP]) {
      const gain = waterFlowSpeedGain(speed);
      expect(gain).toBeGreaterThan(previous);
      previous = gain;
    }
    // A floor, so a backwater still carries texture rather than turning to glass.
    expect(waterFlowSpeedGain(0)).toBeGreaterThan(0);
    // And it saturates rather than growing without bound past the cap.
    expect(waterFlowSpeedGain(40)).toBe(waterFlowSpeedGain(WATER_FLOW_SPEED_GAIN_CAP));
  });
});

describe("6-1 world-locked standing waves", () => {
  it("takes no clock at all", () => {
    // The world-locking proof, at the signature. `waterStandingWave` has no
    // time parameter, and the phase the fragment builds from it is
    // `k · (arcLength + world-locked wander) + lane bow` — arc length is a
    // vertex attribute fixed at build time and `absoluteWorldXZ` is
    // origin-invariant by construction, so no camera move and no floating
    // origin rebase can translate the pattern.
    expect(waterStandingWave.length).toBe(2);
    const body = WATER_CHANNEL_FLOW_WGSL
      .slice(WATER_CHANNEL_FLOW_WGSL.indexOf("fn waterStandingWave("))
      .split("\n}")[0]!;
    expect(body).not.toContain("time");
    // The composed phase, likewise: no clock reaches it.
    const composed = WATER_CHANNEL_FLOW_WGSL
      .slice(WATER_CHANNEL_FLOW_WGSL.indexOf("let phase = standing.wavenumber"))
      .split(";")[0]!;
    expect(composed).toContain("arcLengthMeters");
    expect(composed).not.toContain("time");
  });

  it("stands the wave the dispersion relation says it should", () => {
    // A wave is stationary exactly when c = v, and for a deep-water gravity
    // wave c = sqrt(gλ/2π), so λ = 2π v²/g. Between the clamps that is what
    // ships.
    for (const speed of [1.5, 2, 3, 4, 5, 6]) {
      const expected = (2 * Math.PI * speed * speed) / WATER_FLOW_GRAVITY;
      const wave = waterStandingWave(speed, 0.5);
      if (
        expected > WATER_STANDING_MINIMUM_WAVELENGTH_METERS
        && expected < WATER_STANDING_MAXIMUM_WAVELENGTH_METERS
      ) {
        expect(wave.wavelengthMeters).toBeCloseTo(expected, 6);
        // The phase speed of the wave the shader draws equals the current.
        const phaseSpeed = Math.sqrt(
          (WATER_FLOW_GRAVITY * wave.wavelengthMeters) / (2 * Math.PI),
        );
        expect(phaseSpeed).toBeCloseTo(speed, 5);
      }
    }
    // Faster reaches stand LONGER waves — the observed ordering of haystack
    // spacing with reach velocity.
    expect(waterStandingWave(4, 1).wavelengthMeters)
      .toBeGreaterThan(waterStandingWave(2, 1).wavelengthMeters);
  });

  it("keys amplitude to grade, monotonically, and never past the Stokes limit", () => {
    let previous = -Infinity;
    for (const grade of [0, 0.1, 0.25, 0.4, 0.6, 0.8, 1]) {
      const wave = waterStandingWave(2.6, grade);
      expect(wave.slopeAmplitude).toBeGreaterThanOrEqual(previous);
      previous = wave.slopeAmplitude;
      // The deep-water limiting steepness is ka = 0.443; the ceiling is under
      // it, and past the ceiling the excess becomes crest foam instead.
      expect(wave.slopeAmplitude).toBeLessThanOrEqual(WATER_STANDING_MAXIMUM_SLOPE);
      expect(wave.curvatureAmplitude)
        .toBeCloseTo(wave.slopeAmplitude * wave.wavenumber, 9);
    }
    expect(waterStandingWave(2.6, 1).slopeAmplitude)
      .toBeGreaterThan(waterStandingWave(2.6, 0.1).slopeAmplitude);
    // A flat reach stands nothing at all, whatever its speed.
    for (const speed of [0.5, 2, 5, 9]) {
      expect(waterStandingWave(speed, 0).slopeAmplitude).toBe(0);
      expect(waterStandingWave(speed, 0).breaking).toBe(0);
    }
    // A steep, fast reach breaks; a gentle one does not.
    expect(waterStandingWave(3.5, 1).breaking).toBeGreaterThan(0.9);
    expect(waterStandingWave(1.2, 0.15).breaking).toBe(0);
  });

  it("sets steepness from grade alone and wavelength from speed alone", () => {
    // The measured defect this law replaced: with a speed-LINEAR amplitude,
    // steepness went as 1/v, so a torrent broke less than a riffle at the same
    // grade. Steepness is dimensionless and grade is the energy slope, so
    // grade owns it; speed owns the wavelength through the dispersion relation
    // and therefore owns the amplitude as `a = ka · v² / g`.
    for (const grade of [0.2, 0.5, 0.85, 1]) {
      const speeds = [1.5, 2.5, 4, 6];
      const steepness = speeds.map((speed) => waterStandingWave(speed, grade).slopeAmplitude);
      for (const value of steepness) expect(value).toBeCloseTo(steepness[0]!, 9);
      const breaking = speeds.map((speed) => waterStandingWave(speed, grade).breaking);
      for (const value of breaking) expect(value).toBeCloseTo(breaking[0]!, 9);
      // Amplitude still climbs steeply with the exported speed: a ∝ v² until
      // the wavelength clamps.
      const amplitude = (speed: number): number => {
        const wave = waterStandingWave(speed, grade);
        return wave.slopeAmplitude / wave.wavenumber;
      };
      expect(amplitude(4)).toBeGreaterThan(amplitude(2.5) * 2);
    }
  });
});

describe("6-1 fetch-limited lake chop", () => {
  const fetchFactor = (metres: number): number =>
    Math.sqrt(metres / WATER_LAKE_FETCH_REFERENCE_METERS);

  it("reproduces the fetch-limited growth laws", () => {
    // g·Hs/U² = 0.0016 (g·F/U²)^0.5 — checked against the law directly rather
    // than against the folded coefficient the shader carries.
    for (const wind of [3, 6, 12, 18]) {
      for (const fetch of [200, 2_000, 20_000]) {
        const chop = waterLakeChop(wind, fetchFactor(fetch));
        const law = (0.0016 * wind * wind * Math.sqrt((WATER_FLOW_GRAVITY * fetch) / (wind * wind)))
          / WATER_FLOW_GRAVITY;
        expect(chop.significantHeightMeters).toBeCloseTo(law, 6);
        // g·Tp/U = 0.286 (g·F/U²)^(1/3), and λ = g Tp²/2π.
        const peakPeriod = (0.286 * wind * ((WATER_FLOW_GRAVITY * fetch) / (wind * wind)) ** (1 / 3))
          / WATER_FLOW_GRAVITY;
        const lawWavelength = (WATER_FLOW_GRAVITY * peakPeriod * peakPeriod) / (2 * Math.PI);
        expect(chop.wavelengthMeters).toBeCloseTo(lawWavelength, 4);
      }
    }
    // Hs = 0.0016 · U · sqrt(F/g), folded against the reference fetch so the
    // payload's stored sqrt(F/Fref) enters LINEARLY.
    expect(WATER_LAKE_CHOP_HEIGHT_COEFFICIENT).toBeCloseTo(0.0722438, 6);
  });

  it("leaves a pond glassy and gives a big lake real chop", () => {
    const wind = 6;
    const pond = waterLakeChop(wind, fetchFactor(60));
    const tarn = waterLakeChop(wind, fetchFactor(600));
    const big = waterLakeChop(wind, fetchFactor(20_000));
    expect(pond.significantHeightMeters).toBeLessThan(0.03);
    expect(big.significantHeightMeters).toBeGreaterThan(0.4);
    expect(big.significantHeightMeters / pond.significantHeightMeters).toBeGreaterThan(15);
    // Monotone in fetch, for both the height and the wavelength.
    expect(tarn.significantHeightMeters).toBeGreaterThan(pond.significantHeightMeters);
    expect(big.significantHeightMeters).toBeGreaterThan(tarn.significantHeightMeters);
    expect(tarn.wavelengthMeters).toBeGreaterThan(pond.wavelengthMeters);
    expect(big.wavelengthMeters).toBeGreaterThan(tarn.wavelengthMeters);
    // The pond's chop is short enough that its own footprint fade retires it
    // from the air, which is what "glassy" means at flight altitude.
    expect(pond.wavelengthMeters).toBeLessThan(0.5);
    // Young seas are steeper: the pond is steeper per unit length even though
    // it is far smaller, which is why the fade rather than the amplitude is
    // what makes it read as glass.
    expect(pond.significantHeightMeters / pond.wavelengthMeters)
      .toBeGreaterThan(big.significantHeightMeters / big.wavelengthMeters);
  });

  it("travels at its own phase speed and renews once per wave period", () => {
    for (const fetch of [120, 1_500, 20_000]) {
      const chop = waterLakeChop(7, fetchFactor(fetch));
      expect(chop.driftSpeed).toBeCloseTo(
        Math.sqrt((WATER_FLOW_GRAVITY * chop.wavelengthMeters) / (2 * Math.PI)),
        6,
      );
      // Cycle = λ/c = the wave period, so the drift distance per cycle is
      // exactly one wavelength: the spatially varying drift speed can never
      // shear the lattice, which an unbounded `c(x)·t` certainly would.
      expect(chop.driftSpeed * chop.cycleSeconds)
        .toBeCloseTo(chop.wavelengthMeters, 5);
    }
  });

  it("grows with wind as well as with fetch", () => {
    let previous = -Infinity;
    for (const wind of [0, 1.5, 4, 8, 15, 24]) {
      const chop = waterLakeChop(wind, fetchFactor(8_000));
      expect(chop.significantHeightMeters).toBeGreaterThanOrEqual(previous);
      previous = chop.significantHeightMeters;
    }
    expect(waterLakeChop(0, fetchFactor(20_000)).significantHeightMeters).toBe(0);
  });
});

describe("6-1 the vertex payload", () => {
  it("encodes the sentinel above every analytic value", () => {
    // Analytic vertices carry exactly 0; every graph vertex carries at least
    // the base, so `payload > 0` is a total discriminator with no window in
    // which a live channel could be mistaken for a dark one.
    for (const grade of [0, 1e-6, 0.005, 0.03, 0.06, 0.4, Number.NaN, Infinity]) {
      const payload = waterChannelGradePayload(grade);
      expect(payload).toBeGreaterThanOrEqual(WATER_CHANNEL_SENTINEL_BASE);
      expect(payload).toBeLessThanOrEqual(WATER_CHANNEL_SENTINEL_BASE + 1);
    }
    for (const fetch of [0, 30, 600, 20_000, 1e9, Number.NaN]) {
      const payload = waterLakeFetchPayload(fetch);
      expect(payload).toBeGreaterThanOrEqual(WATER_CHANNEL_SENTINEL_BASE);
      expect(payload).toBeLessThanOrEqual(WATER_CHANNEL_SENTINEL_BASE + 1);
    }
    // Monotone, and saturating at the reference grade.
    expect(waterChannelGradePayload(0.03)).toBeGreaterThan(waterChannelGradePayload(0.01));
    expect(waterChannelGradePayload(WATER_CHANNEL_GRADE_REFERENCE))
      .toBe(WATER_CHANNEL_SENTINEL_BASE + 1);
    // The lake payload stores sqrt(F/Fref), so what the rasteriser interpolates
    // is the significant height rather than the fetch.
    expect(waterLakeFetchPayload(WATER_LAKE_FETCH_REFERENCE_METERS / 4) - 1)
      .toBeCloseTo(0.5, 9);
  });

  it("derives an effective fetch from the shore distance the builder already has", () => {
    const span = 6_000;
    expect(waterLakeEffectiveFetchMeters(0, span)).toBe(WATER_LAKE_FETCH_FLOOR_METERS);
    expect(waterLakeEffectiveFetchMeters(100, span)).toBe(
      WATER_LAKE_EFFECTIVE_FETCH_FACTOR * 100 + WATER_LAKE_FETCH_FLOOR_METERS,
    );
    // Never longer than the lake.
    expect(waterLakeEffectiveFetchMeters(10_000, span)).toBe(span);
    // A pond's own span is the ceiling, so its centre cannot borrow fetch it
    // does not have.
    expect(waterLakeEffectiveFetchMeters(15, 30)).toBe(WATER_LAKE_FETCH_FLOOR_METERS);
    // Monotone in shore distance.
    let previous = -Infinity;
    for (const distance of [0, 20, 90, 400, 1_400, 5_000]) {
      const fetch = waterLakeEffectiveFetchMeters(distance, span);
      expect(fetch).toBeGreaterThanOrEqual(previous);
      previous = fetch;
    }
  });

  it("exports the station grade the payload is built from", () => {
    // `whitewater` cannot be inverted for grade — its clamp saturates exactly
    // where rapids are — so W-5's station gained the grade itself.
    const stations = resampleHydrologyRiverStations(
      river([[0, 300, 0], [120, 288, 0], [240, 285, 0]]).points,
    );
    expect(stations.length).toBeGreaterThan(2);
    for (const station of stations) {
      expect(station.grade).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(station.grade)).toBe(true);
    }
    // The steep half grades ~10x the shallow half.
    const steep = stations[1]!.grade;
    const shallow = stations.at(-2)!.grade;
    expect(steep).toBeGreaterThan(shallow * 3);
  });

  it("writes the payload onto graph rivers and lakes", () => {
    const built = buildMeshes(
      [river([[0, 300, 0], [120, 288, 0], [240, 285, 0]])],
      [lake(1_400)],
    );
    expect(built.riverWater.length).toBeGreaterThan(0);
    expect(built.lakeWater.length).toBeGreaterThan(0);
    const riverPayloads: number[] = [];
    for (let index = 3; index < built.riverWater.length; index += 4) {
      riverPayloads.push(built.riverWater[index]!);
    }
    for (const payload of riverPayloads) {
      expect(payload).toBeGreaterThanOrEqual(WATER_CHANNEL_SENTINEL_BASE);
      expect(payload).toBeLessThanOrEqual(WATER_CHANNEL_SENTINEL_BASE + 1);
    }
    // All five lanes of a station share one payload, exactly as they share
    // uv.x — a lane seam cannot show a discontinuity the geometry does not have.
    for (let station = 0; station * 5 < riverPayloads.length / 1; station += 1) {
      const base = station * 5;
      if (base + 4 >= riverPayloads.length) break;
      const lanePayloads = riverPayloads.slice(base, base + 5);
      expect(new Set(lanePayloads).size).toBe(1);
      const laneUvX = [0, 1, 2, 3, 4].map((lane) => built.riverUv[(base + lane) * 2]!);
      expect(new Set(laneUvX).size).toBe(1);
    }
    // The steep head carries more grade than the flat tail.
    expect(riverPayloads[0]).toBeGreaterThan(riverPayloads.at(-1)!);

    const lakePayloads: number[] = [];
    for (let index = 3; index < built.lakeWater.length; index += 4) {
      lakePayloads.push(built.lakeWater[index]!);
    }
    // Ring vertices sit at the fetch floor; the interior reaches further.
    const floorPayload = waterLakeFetchPayload(WATER_LAKE_FETCH_FLOOR_METERS);
    expect(Math.min(...lakePayloads)).toBeCloseTo(floorPayload, 6);
    expect(Math.max(...lakePayloads)).toBeGreaterThan(floorPayload);
    for (const payload of lakePayloads) {
      expect(payload).toBeGreaterThanOrEqual(WATER_CHANNEL_SENTINEL_BASE);
    }
  });

  it("gives a pond a smaller payload than a big lake at the same shore distance", () => {
    const pond = buildMeshes([], [lake(90)]);
    const big = buildMeshes([], [lake(9_000)]);
    const maximum = (water: readonly number[]): number => {
      let best = 0;
      for (let index = 3; index < water.length; index += 4) {
        best = Math.max(best, water[index]!);
      }
      return best;
    };
    expect(maximum(pond.lakeWater)).toBeLessThan(maximum(big.lakeWater));
    // And that difference is what the growth law turns into "glassy" vs "chop".
    const pondChop = waterLakeChop(6, maximum(pond.lakeWater) - WATER_CHANNEL_SENTINEL_BASE);
    const bigChop = waterLakeChop(6, maximum(big.lakeWater) - WATER_CHANNEL_SENTINEL_BASE);
    expect(bigChop.significantHeightMeters)
      .toBeGreaterThan(pondChop.significantHeightMeters * 5);
  });
});

describe("6-1 seam and confluence continuity", () => {
  it("keys advection off world position alone, never off reach or lane state", () => {
    // The whole seam argument in one assertion: the advected octave takes a
    // world position, a drift vector, a lattice axis and a clock. It has no
    // arc-length, lane, mesh, page or reach parameter, so two fragments at one
    // world point with the same exported hydraulics cannot disagree — across a
    // lane boundary, a mesh row, a page seam, or a confluence.
    const signature = WATER_CHANNEL_FLOW_WGSL
      .slice(WATER_CHANNEL_FLOW_WGSL.indexOf("fn waterFlowOctave("))
      .split(") -> vec2f")[0]!;
    for (const forbidden of ["arcLength", "lane", "reach", "page", "region"]) {
      expect(signature.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(signature).toContain("worldXZ: vec2f");
    expect(signature).toContain("time: f32");
  });

  it("keeps the arc-length parameter continuous along a reach and shared at a node", () => {
    // W-5's contract, restated as 6-1's precondition. The standing wave keys
    // its phase off `uv.x`, so a jump in it would be a visible ring.
    const stations = resampleHydrologyRiverStations(
      river([[0, 300, 0], [400, 280, 60], [900, 262, 200], [1_400, 255, 260]]).points,
    );
    for (let index = 1; index < stations.length; index += 1) {
      const step = stations[index]!.arcLengthMeters - stations[index - 1]!.arcLengthMeters;
      expect(step).toBeGreaterThan(0);
      // No station is further from its neighbour than the resampler's ceiling,
      // so the linear interpolation of the parameter is faithful everywhere.
      expect(step).toBeLessThanOrEqual(256 + 1e-6);
      const chord = Math.hypot(
        stations[index]!.x - stations[index - 1]!.x,
        stations[index]!.z - stations[index - 1]!.z,
      );
      expect(step).toBeCloseTo(chord, 5);
    }
    expect(stations[0]!.arcLengthMeters).toBe(0);

    // A confluence: the tributary and the trunk share the junction point
    // verbatim, so the ADVECTED field (a function of world position) is
    // continuous across it. The arc-length parameter resets there by design —
    // a confluence is a hydraulic discontinuity, and the standing train that
    // rides the parameter is a per-reach quantity.
    const junction: readonly [number, number, number] = [900, 262, 200];
    const tributary = resampleHydrologyRiverStations(
      river([[600, 320, 420], junction]).points,
    );
    const trunk = resampleHydrologyRiverStations(
      river([junction, [1_400, 255, 260]]).points,
    );
    expect(tributary.at(-1)!.x).toBe(trunk[0]!.x);
    expect(tributary.at(-1)!.z).toBe(trunk[0]!.z);
    expect(tributary.at(-1)!.flowSpeedMetersPerSecond)
      .toBe(trunk[0]!.flowSpeedMetersPerSecond);
    expect(trunk[0]!.arcLengthMeters).toBe(0);
  });
});
