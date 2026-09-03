import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "./support/sourceText";
import {
  CLOUD_RAYMARCH_SHADER,
  CLOUD_SHADER_MODULES,
  CLOUD_SHADOW_SHADER,
  CLOUD_TEMPORAL_RESOLVE_SHADER,
} from "../src/render/webgpu/nature/CloudShaders";
import {
  assertVolumetricCloudConfig,
  packCloudRaymarchUniforms,
  packCloudShadowUniforms,
  packCloudTemporalUniforms,
  resolveVolumetricCloudConfig,
} from "../src/render/webgpu/nature/CloudConfig";
import {
  DEFAULT_ENVIRONMENT_STATE,
  createEnvironmentState,
  packEnvironmentUniforms,
  sampleEnvironmentWind,
} from "../src/render/webgpu/nature/EnvironmentState";
import {
  OCEAN_SHADER_MODULES,
  OCEAN_SPECTRUM_EVOLUTION_SHADER,
  OCEAN_SPECTRUM_INITIALIZATION_SHADER,
  OCEAN_SPATIAL_DERIVATION_SHADER,
  OCEAN_STOCKHAM_IFFT_SHADER,
} from "../src/render/webgpu/nature/OceanShaders";
import {
  buildOceanFftDispatches,
  oceanTransformNormalizationScale,
  packOceanDerivationUniforms,
  packOceanEvolutionUniforms,
  packOceanFftUniforms,
  packOceanInitializationUniforms,
  shouldUpdateOceanCascade,
  resolveSpectralOceanConfig,
} from "../src/render/webgpu/nature/OceanConfig";
import {
  buildNatureBindGroupLayoutEntries,
  computeDispatch2D,
  type NatureShaderModule,
} from "../src/render/webgpu/nature/ShaderModule";

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

  it("phase-spreads slow ocean cascades without changing their cadence", () => {
    const updatesPerFrame = (
      cadences: readonly number[],
      frameCount: number,
    ): number[] => Array.from({ length: frameCount }, (_, frameOffset) => {
      const frameIndex = frameOffset + 1;
      return cadences.filter((cadence) => (
        shouldUpdateOceanCascade(frameIndex, cadence)
      )).length;
    });

    const tierOneCadences = [1, 1, 2, 4];
    const tierTwoCadences = [1, 1, 2, 4, 8];
    const tierOne = updatesPerFrame(tierOneCadences, 4);
    const tierTwo = updatesPerFrame(tierTwoCadences, 8);

    expect(tierOne).toEqual([3, 3, 2, 3]);
    expect(tierTwo).toEqual([3, 3, 3, 3, 3, 3, 2, 3]);
    expect(Math.max(...tierOne)).toBe(3);
    expect(Math.max(...tierTwo)).toBe(3);
    expect(tierOne.reduce((sum, count) => sum + count, 0)).toBe(11);
    expect(tierTwo.reduce((sum, count) => sum + count, 0)).toBe(23);

    for (let cadence = 1; cadence <= 16; cadence += 1) {
      const frameCount = cadence * 3;
      const hits = Array.from({ length: frameCount }, (_, frameIndex) => (
        shouldUpdateOceanCascade(frameIndex, cadence)
      )).filter(Boolean).length;
      expect(hits).toBe(3);
    }
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
    // Pin moved by wave R: the trailing u32 normalise FLAG became an f32
    // normalisation SCALE in its own std140 slot at offset 16, because the
    // factor is now the spectrum's per-cascade cell measure rather than 1/N.
    // The buffer grows 16 -> 32 bytes; the three leading u32s are unchanged.
    const normalizationScale = oceanTransformNormalizationScale(1_024);
    const fft = packOceanFftUniforms(128, 6, "vertical", normalizationScale);
    expect(fft.byteLength).toBe(32);
    expect(Array.from(new Uint32Array(fft, 0, 4))).toEqual([128, 6, 1, 0]);
    expect(new DataView(fft).getFloat32(16, true)).toBeCloseTo(normalizationScale, 6);
    // The scale is sqrt(dk / sqrt(2)) with dk = 2*pi/L: the cell measure that
    // turns a spectral DENSITY into per-cell variance, split across two axes.
    expect(normalizationScale ** 2 * Math.SQRT2).toBeCloseTo((2 * Math.PI) / 1_024, 9);
    expect(() => oceanTransformNormalizationScale(0)).toThrow(/patchLength/);
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
    expect(() => packOceanFftUniforms(256, 8, "horizontal", 1)).toThrow(/stage/);
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

  it("keeps cloud diagnostics out of the per-pixel raymarch", () => {
    // The old diagnostic made every invocation whose ray entered the cloud
    // slab contend on one global atomic, then mapped that buffer every 60
    // frames. It did not influence an output texel and had no runtime
    // consumer, so shipping must not pay for it merely to expose an unused
    // counter.
    expect(CLOUD_RAYMARCH_SHADER.code).not.toContain("density_counter");
    expect(CLOUD_RAYMARCH_SHADER.code).not.toContain("atomicAdd");
    expect(CLOUD_RAYMARCH_SHADER.bindings.map((binding) => binding.name))
      .not.toContain("density_counter");
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
      cameraForward: [0, 0, -1],
      cameraRight: [1, 0, 0],
      cameraUp: [0, 1, 0],
      viewScale: [0.6, 0.35],
      cameraPositionMeters: [10, 2_500, -20],
      renderSize: [960, 540],
      fullResolutionSize: [1_920, 1_080],
      frameIndex: 7,
      windOffsetMeters: [120, 40],
      weatherMapOriginMeters: [-80_000, -80_000],
    });
    // 2-0 adoption: 17 vec4 rows — camera basis replaced the two matrices
    // (rays are built from the shipped 1B-12 basis convention everywhere).
    expect(raymarch.byteLength).toBe(272);
    expect(Array.from(raymarch.slice(0, 3))).toEqual([0, 0, -1]);
    expect(raymarch[3]).toBeCloseTo(0.6, 6);
    expect(Array.from(raymarch.slice(4, 7))).toEqual([1, 0, 0]);
    expect(raymarch[7]).toBeCloseTo(0.35, 6);
    expect(Array.from(raymarch.slice(12, 15))).toEqual([10, 2_500, -20]);
    expect(Array.from(raymarch.slice(28, 30))).toEqual([960, 540]);
    expect(raymarch[30]).toBeCloseTo(1 / 960, 8);
    expect(raymarch[31]).toBeCloseTo(1 / 540, 8);
    expect(raymarch[34]).toBe(7);
    expect(Array.from(raymarch.slice(64, 67))).toEqual([1_000, 200, -3_000]);

    const temporal = packCloudTemporalUniforms(config, {
      renderSize: [960, 540],
      cameraCut: true,
      currentForward: [0, 0, -1],
      currentRight: [1, 0, 0],
      currentUp: [0, 1, 0],
      currentViewScale: [0.6, 0.35],
      previousForward: [0, 0, -1],
      previousRight: [1, 0, 0],
      previousUp: [0, 1, 0],
      previousViewScale: [0.6, 0.35],
      cameraDeltaMeters: [3, -1, 2],
    });
    // 2-0 adoption: 9 vec4 rows — the previous ray basis + absolute camera
    // delta ride in the block (1B-12 reprojection, no cached matrix).
    expect(temporal.byteLength).toBe(144);
    expect(Array.from(new Uint32Array(temporal, 0, 4))).toEqual([960, 540, 1, 0]);
    const temporalFloats = new Float32Array(temporal);
    expect(Array.from(temporalFloats.slice(8, 11))).toEqual([0, 0, -1]);
    expect(temporalFloats[11]).toBe(config.maximumTraceDistanceMeters);
    expect(Array.from(temporalFloats.slice(32, 35))).toEqual([3, -1, 2]);
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

describe("WGSL the spec accepts, not just the adapter in front of us", () => {
  it("assertion 51b: no compound assignment targets a multi-component swizzle", () => {
    // WGSL: the left side of `*=`, `+=`, `-=`, `/=` must be a REFERENCE. A
    // single component (`v.x`) is one; a multi-component swizzle (`v.rgb`) is
    // not, so `v.rgb *= f` is invalid and a spec-strict validator rejects it
    // with "no matching overload for operator *= (swizzle<...>, f32)".
    //
    // This is not hypothetical. `CloudShaders.ts` shipped with exactly that
    // line at Gate 2A and the renderer failed to boot on a stock Chromium —
    // stuck on "PREPARING AIRSPACE", the cloud temporal-resolve compute never
    // compiling. Every GPU test and every perf capture passed, because the
    // Tint build behind the suites' Playwright Chromium accepts it. One
    // adapter agreeing is not the same as the shader being valid, so this
    // check is STATIC and runs in `npm test`.
    const shaderRoot = join(__dirname, "..", "src");
    const offenders: string[] = [];
    const compoundSwizzle = /\.[xyzwrgba]{2,4}\s*(?:\*=|\+=|-=|\/=)/u;
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.ts$/.test(entry.name)) continue;
        readSource(path).split("\n").forEach((line, index) => {
          // Comments describing the rule are not violations of it.
          if (/^\s*(?:\/\/|\*)/.test(line)) return;
          if (compoundSwizzle.test(line)) {
            offenders.push(`${relative(shaderRoot, path)}:${index + 1}  ${line.trim()}`);
          }
        });
      }
    };
    walk(shaderRoot);
    expect(
      offenders,
      "compound assignment to a multi-component swizzle is invalid WGSL — assign the whole "
      + "vector instead, e.g. `v = vec4f(v.rgb * s, v.a);`",
    ).toEqual([]);
  });
});
