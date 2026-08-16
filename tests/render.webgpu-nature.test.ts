import { describe, expect, it } from "vitest";
import {
  CLOUD_RAYMARCH_SHADER,
  CLOUD_SHADER_MODULES,
  CLOUD_SHADOW_SHADER,
  CLOUD_TEMPORAL_RESOLVE_SHADER,
  DEFAULT_ENVIRONMENT_STATE,
  OCEAN_SHADER_MODULES,
  OCEAN_SPECTRUM_EVOLUTION_SHADER,
  OCEAN_SPECTRUM_INITIALIZATION_SHADER,
  OCEAN_SPATIAL_DERIVATION_SHADER,
  OCEAN_STOCKHAM_IFFT_SHADER,
  assertVolumetricCloudConfig,
  buildOceanFftDispatches,
  buildNatureBindGroupLayoutEntries,
  computeDispatch2D,
  createEnvironmentState,
  packCloudRaymarchUniforms,
  packCloudShadowUniforms,
  packCloudTemporalUniforms,
  packEnvironmentUniforms,
  packOceanDerivationUniforms,
  packOceanEvolutionUniforms,
  packOceanFftUniforms,
  packOceanInitializationUniforms,
  resolveSpectralOceanConfig,
  resolveVolumetricCloudConfig,
  sampleEnvironmentWind,
  type Mat4,
  type NatureShaderModule,
} from "../src/render/webgpu/nature";

const IDENTITY_MATRIX: Mat4 = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

function expectStructurallyCompleteShader(module: NatureShaderModule): void {
  expect(module.code).not.toContain("#version");
  expect(module.code).not.toContain("gl_FragColor");
  expect(module.code).not.toContain("TODO");
  expect(module.code.length).toBeGreaterThan(500);

  let braceDepth = 0;
  for (const character of module.code) {
    if (character === "{") braceDepth += 1;
    if (character === "}") braceDepth -= 1;
    expect(braceDepth).toBeGreaterThanOrEqual(0);
  }
  expect(braceDepth).toBe(0);

  const bindingKeys = new Set<string>();
  for (const binding of module.bindings) {
    const key = `${binding.group}:${binding.binding}`;
    expect(bindingKeys.has(key)).toBe(false);
    bindingKeys.add(key);
    expect(module.code).toContain(`@group(${binding.group}) @binding(${binding.binding})`);
    expect(module.code).toMatch(new RegExp(`\\b${binding.name}\\b`));
    if (binding.kind === "sampled-texture") {
      expect(binding.viewDimension).toBeDefined();
      expect(binding.sampleType).toBeDefined();
    }
    if (binding.kind === "storage-texture") {
      expect(binding.viewDimension).toBeDefined();
      expect(binding.storageFormat).toBeDefined();
    }
    if (binding.kind === "sampler") {
      expect(binding.samplerType).toBeDefined();
    }
  }
  for (const entry of module.entryPoints) {
    expect(module.code).toMatch(new RegExp(`fn\\s+${entry.name}\\s*\\(`));
    expect(module.code).toContain(`@${entry.stage}`);
    if (entry.stage === "compute") {
      expect(entry.workgroupSize).toEqual([8, 8, 1]);
      expect(module.code).toContain("@workgroup_size(8, 8, 1)");
    }
  }
}

describe("shared WebGPU natural environment", () => {
  it("normalizes state, interpolates wind, and packs a stable 256-byte block", () => {
    const state = createEnvironmentState({
      timeSeconds: 42,
      floatingOriginMeters: [1_000, 250, -3_000],
      sun: { direction: [3, 4, 0] },
      windLayers: [
        { altitudeMeters: 0, velocityMetersPerSecond: [2, 4], turbulence: 0.1 },
        { altitudeMeters: 1_000, velocityMetersPerSecond: [6, 8], turbulence: 0.5 },
      ],
    });
    expect(state.sun.direction).toEqual([0.6, 0.8, 0]);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.windLayers)).toBe(true);
    expect(sampleEnvironmentWind(state, 250)).toEqual({
      velocityMetersPerSecond: [3, 5],
      turbulence: 0.2,
    });

    const packed = packEnvironmentUniforms(state);
    expect(packed.byteLength).toBe(256);
    expect(packed[0]).toBe(42);
    expect(packed[8]).toBeCloseTo(0.6, 6);
    expect(packed[9]).toBeCloseTo(0.8, 6);
    expect(packed[10]).toBe(0);
    expect(packed[16]).toBeCloseTo(
      state.atmosphere.planetCenterMeters[0] - state.floatingOriginMeters[0],
      2,
    );
    expect(packed[60]).toBe(2);
  });

  it("rejects physically incoherent environment snapshots", () => {
    expect(() => createEnvironmentState({
      atmosphere: {
        planetRadiusMeters: 10_000,
        atmosphereRadiusMeters: 9_999,
      },
    })).toThrow(/atmosphereRadiusMeters/);
    expect(() => createEnvironmentState({
      windLayers: [
        { altitudeMeters: 1_000, velocityMetersPerSecond: [1, 0], turbulence: 0 },
        { altitudeMeters: 500, velocityMetersPerSecond: [1, 0], turbulence: 0 },
      ],
    })).toThrow(/strictly ascending/);
  });
});

describe("spectral ocean foundations", () => {
  it("validates cascade bands and produces a complete Stockham schedule", () => {
    const config = resolveSpectralOceanConfig();
    expect(config.resolution).toBe(256);
    expect(config.cascades).toHaveLength(5);
    expect(Object.isFrozen(config.cascades)).toBe(true);
    for (let index = 1; index < config.cascades.length; index += 1) {
      expect(config.cascades[index]?.minimumWavelengthMeters).toBe(
        config.cascades[index - 1]?.maximumWavelengthMeters,
      );
    }

    const passes = buildOceanFftDispatches(config.resolution);
    expect(passes).toHaveLength(16);
    expect(passes[0]).toEqual({
      axis: "horizontal",
      stage: 0,
      dispatch: [16, 32, 1],
      normalize: false,
      sourceSlot: "ping",
      destinationSlot: "pong",
    });
    expect(passes[15]).toEqual({
      axis: "vertical",
      stage: 7,
      dispatch: [32, 16, 1],
      normalize: true,
      sourceSlot: "pong",
      destinationSlot: "ping",
    });
    expect(computeDispatch2D(257, 129, [8, 8, 1])).toEqual([33, 17, 1]);
    expect(() => computeDispatch2D(10, 10, [0, 8, 1])).toThrow(/workgroupSize/);
  });

  it("packs uniform buffers exactly as declared by WGSL", () => {
    const config = resolveSpectralOceanConfig({ resolution: 128, seed: 17 });
    const initialization = packOceanInitializationUniforms(config, 1);
    const initView = new DataView(initialization);
    expect(initialization.byteLength).toBe(64);
    expect(initView.getUint32(0, true)).toBe(128);
    expect(initView.getUint32(4, true)).toBe(17);
    expect(initView.getUint32(8, true)).toBe(1);
    expect(initView.getFloat32(16, true)).toBe(256);
    expect(initView.getFloat32(32, true)).toBeCloseTo(config.windDirection[0], 6);

    const evolution = packOceanEvolutionUniforms(config, 2, 12.5);
    expect(evolution.byteLength).toBe(32);
    expect(new DataView(evolution).getFloat32(16, true)).toBe(12.5);
    const fft = packOceanFftUniforms(128, 6, "vertical", true);
    expect(Array.from(new Uint32Array(fft))).toEqual([128, 6, 1, 1]);
    const derivation = packOceanDerivationUniforms(config, 0, 1 / 60);
    expect(derivation.byteLength).toBe(32);
    expect(new DataView(derivation).getFloat32(28, true)).toBeLessThan(1);
  });

  it("rejects aliases, undersampled bands, and invalid FFT stages", () => {
    expect(() => resolveSpectralOceanConfig({ resolution: 192 })).toThrow(/power of two/);
    expect(() => resolveSpectralOceanConfig({
      resolution: 256,
      cascades: [{
        patchLengthMeters: 64,
        minimumWavelengthMeters: 0.1,
        maximumWavelengthMeters: 12,
        spectrumScale: 1,
        updateEveryNFrames: 1,
      }],
    })).toThrow(/Nyquist/);
    expect(() => packOceanFftUniforms(256, 8, "horizontal", false)).toThrow(/stage/);
  });

  it("uses a Stockham autosort mapping that agrees with a direct inverse DFT", () => {
    type Complex = readonly [number, number];
    const multiply = (a: Complex, b: Complex): Complex => [
      a[0] * b[0] - a[1] * b[1],
      a[0] * b[1] + a[1] * b[0],
    ];
    let source: Complex[] = [
      [1, 0], [0.2, -0.4], [-0.1, 0.3], [0.7, 0.1],
      [-0.3, 0.5], [0.4, 0.2], [0, -0.2], [0.6, -0.1],
    ];
    const count = source.length;
    for (let stage = 0; stage < Math.log2(count); stage += 1) {
      const destination: Complex[] = Array.from({ length: count }, () => [0, 0]);
      const span = 1 << stage;
      for (let butterfly = 0; butterfly < count / 2; butterfly += 1) {
        const local = butterfly & (span - 1);
        const block = butterfly >> stage;
        const destination0 = block * span * 2 + local;
        const destination1 = destination0 + span;
        const angle = 2 * Math.PI * local / (span * 2);
        const twiddled = multiply(source[butterfly + count / 2] ?? [0, 0], [
          Math.cos(angle),
          Math.sin(angle),
        ]);
        const first = source[butterfly] ?? [0, 0];
        destination[destination0] = [first[0] + twiddled[0], first[1] + twiddled[1]];
        destination[destination1] = [first[0] - twiddled[0], first[1] - twiddled[1]];
      }
      source = destination;
    }

    const original: Complex[] = [
      [1, 0], [0.2, -0.4], [-0.1, 0.3], [0.7, 0.1],
      [-0.3, 0.5], [0.4, 0.2], [0, -0.2], [0.6, -0.1],
    ];
    const direct = original.map((_, sampleIndex) => original.reduce<Complex>((sum, value, k) => {
      const angle = 2 * Math.PI * k * sampleIndex / count;
      const term = multiply(value, [Math.cos(angle), Math.sin(angle)]);
      return [sum[0] + term[0], sum[1] + term[1]];
    }, [0, 0]));
    source.forEach((value, index) => {
      expect(value[0]).toBeCloseTo(direct[index]?.[0] ?? 0, 8);
      expect(value[1]).toBeCloseTo(direct[index]?.[1] ?? 0, 8);
    });
  });

  it("publishes complete initialization, evolution, FFT, and derivation modules", () => {
    expect(OCEAN_SHADER_MODULES).toEqual([
      OCEAN_SPECTRUM_INITIALIZATION_SHADER,
      OCEAN_SPECTRUM_EVOLUTION_SHADER,
      OCEAN_STOCKHAM_IFFT_SHADER,
      OCEAN_SPATIAL_DERIVATION_SHADER,
    ]);
    OCEAN_SHADER_MODULES.forEach(expectStructurallyCompleteShader);
    expect(OCEAN_SPECTRUM_INITIALIZATION_SHADER.code).toContain("directionalJonswapSpectrum");
    expect(OCEAN_SPECTRUM_EVOLUTION_SHADER.code).toContain("initial_mirrored");
    expect(OCEAN_STOCKHAM_IFFT_SHADER.code).toContain("normalization");
    expect(OCEAN_SPATIAL_DERIVATION_SHADER.code).toContain("jacobian");
    expect(buildNatureBindGroupLayoutEntries(OCEAN_SPECTRUM_INITIALIZATION_SHADER)).toEqual([
      { binding: 0, visibility: 4, buffer: { type: "uniform" } },
      {
        binding: 1,
        visibility: 4,
        storageTexture: { access: "write-only", format: "rgba32float", viewDimension: "2d" },
      },
      {
        binding: 2,
        visibility: 4,
        storageTexture: { access: "write-only", format: "rgba32float", viewDimension: "2d" },
      },
    ]);
  });
});

describe("volumetric cloud foundations", () => {
  it("validates quality controls and packs raymarch, temporal, and shadow blocks", () => {
    const config = resolveVolumetricCloudConfig();
    const environment = createEnvironmentState({
      timeSeconds: 18,
      frameDeltaSeconds: 1 / 30,
      floatingOriginMeters: [1_000, 200, -3_000],
    });
    const raymarch = packCloudRaymarchUniforms(config, environment, {
      inverseViewProjection: IDENTITY_MATRIX,
      previousViewProjection: IDENTITY_MATRIX,
      cameraPositionMeters: [10, 2_500, -20],
      renderSize: [960, 540],
      fullResolutionSize: [1_920, 1_080],
      frameIndex: 7,
      windOffsetMeters: [120, 40],
      weatherMapOriginMeters: [-80_000, -80_000],
    });
    expect(raymarch.byteLength).toBe(352);
    expect(Array.from(raymarch.slice(32, 35))).toEqual([10, 2_500, -20]);
    expect(Array.from(raymarch.slice(48, 50))).toEqual([960, 540]);
    expect(raymarch[50]).toBeCloseTo(1 / 960, 8);
    expect(raymarch[51]).toBeCloseTo(1 / 540, 8);
    expect(raymarch[54]).toBe(7);
    expect(Array.from(raymarch.slice(84, 87))).toEqual([1_000, 200, -3_000]);

    const temporal = packCloudTemporalUniforms(config, [960, 540], true);
    expect(temporal.byteLength).toBe(32);
    expect(Array.from(new Uint32Array(temporal, 0, 4))).toEqual([960, 540, 1, 0]);
    const shadow = packCloudShadowUniforms(config, environment, {
      shadowCenterMeters: [0, 0, 0],
      eastAxis: [1, 0, 0],
      northAxis: [0, 0, 1],
      windOffsetMeters: [120, 40],
      weatherMapOriginMeters: [-80_000, -80_000],
      frameIndex: 7,
    });
    expect(shadow.byteLength).toBe(192);
    expect(Array.from(new Float32Array(shadow).slice(40, 43))).toEqual([1_000, 200, -3_000]);
    expect(new Uint32Array(shadow)[44]).toBe(config.shadowMapResolution);
  });

  it("rejects unstable march and temporal settings", () => {
    expect(() => resolveVolumetricCloudConfig({
      baseAltitudeMeters: 4_000,
      topAltitudeMeters: 3_000,
    })).toThrow(/topAltitudeMeters/);
    expect(() => resolveVolumetricCloudConfig({
      maximumViewSteps: 500,
    })).toThrow(/maximumViewSteps/);
    expect(() => resolveVolumetricCloudConfig({
      forwardPhaseG: 1,
    })).toThrow(/forwardPhaseG/);
    expect(() => assertVolumetricCloudConfig({
      ...resolveVolumetricCloudConfig(),
      shadowMapResolution: 300,
    })).toThrow(/power of two/);
  });

  it("publishes physical raymarch, temporal reprojection, and shadow primitives", () => {
    expect(CLOUD_SHADER_MODULES).toEqual([
      CLOUD_RAYMARCH_SHADER,
      CLOUD_TEMPORAL_RESOLVE_SHADER,
      CLOUD_SHADOW_SHADER,
    ]);
    CLOUD_SHADER_MODULES.forEach(expectStructurallyCompleteShader);
    expect(CLOUD_RAYMARCH_SHADER.code).toContain("cloudHenyeyGreenstein");
    expect(CLOUD_RAYMARCH_SHADER.code).toContain("cloudSunOpticalDepth");
    expect(CLOUD_RAYMARCH_SHADER.code).toContain("multiple_scattering");
    expect(CLOUD_TEMPORAL_RESOLVE_SHADER.code).toContain("distance_confidence");
    expect(CLOUD_TEMPORAL_RESOLVE_SHADER.code).toContain("neighborhood_min");
    expect(CLOUD_SHADOW_SHADER.code).toContain("optical_depth");
  });

  it("keeps production defaults internally valid", () => {
    expect(() => assertVolumetricCloudConfig(resolveVolumetricCloudConfig())).not.toThrow();
    expect(DEFAULT_ENVIRONMENT_STATE.atmosphere.atmosphereRadiusMeters).toBeGreaterThan(
      DEFAULT_ENVIRONMENT_STATE.atmosphere.planetRadiusMeters,
    );
  });
});
