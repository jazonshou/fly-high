import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Scene } from "@babylonjs/core/scene";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import {
  buildOceanFftDispatches,
  oceanTransformNormalizationScale,
  resolveSpectralOceanConfig,
  type SpectralOceanConfig,
} from "../../src/render/webgpu/nature/OceanConfig";
import {
  OCEAN_SPECTRUM_EVOLUTION_WGSL,
  OCEAN_SPECTRUM_INITIALIZATION_WGSL,
  OCEAN_STOCKHAM_IFFT_WGSL,
} from "../../src/render/webgpu/nature/OceanShaders";

const SHIPPING_SEED = 0x4f434541;
const SHIPPING_DEPTH_METERS = 2_000;
const POISONED_CASCADE_INDEX = 3;
const FP16_SAFETY_CEILING = 60_000;

const TEXTURE_PAIR_READBACK_WGSL = /* wgsl */ `
@group(0) @binding(0) var source_a: texture_2d<f32>;
@group(0) @binding(1) var source_b: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> results: array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn readTexturePair(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let dimensions = textureDimensions(source_a);
  if (invocation.x >= dimensions.x || invocation.y >= dimensions.y) {
    return;
  }
  let coordinate = vec2<i32>(invocation.xy);
  let index = invocation.x + invocation.y * dimensions.x;
  results[index * 2u] = textureLoad(source_a, coordinate, 0);
  results[index * 2u + 1u] = textureLoad(source_b, coordinate, 0);
}
`;

interface TextureStatistics {
  readonly nonFiniteTexels: number;
  readonly nonZeroValues: number;
  readonly maximumAbsoluteValue: number;
}

interface InitializedSpectrum {
  readonly initialSpectrum: RawTexture;
  readonly waveData: RawTexture;
  readonly uniform: UniformBuffer;
}

interface OceanTransform {
  readonly transformA: readonly [RawTexture, RawTexture];
  readonly transformB: readonly [RawTexture, RawTexture];
  readonly uniforms: readonly UniformBuffer[];
  readonly finalIndex: 0 | 1;
}

function createCompute(
  name: string,
  engine: WebGPUEngine,
  source: string,
  entryPoint: string,
  bindingNames: readonly string[],
): ComputeShader {
  return new ComputeShader(name, engine, { computeSource: source }, {
    entryPoint,
    bindingsMapping: Object.fromEntries(bindingNames.map((bindingName, binding) => [
      bindingName,
      { group: 0, binding },
    ])),
  });
}

function storageTexture(
  scene: Scene,
  resolution: number,
  type: number,
  name: string,
): RawTexture {
  const texture = RawTexture.CreateRGBAStorageTexture(
    null,
    resolution,
    resolution,
    scene,
    false,
    false,
    Texture.NEAREST_SAMPLINGMODE,
    type,
  );
  texture.name = name;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  return texture;
}

function createInitializationUniform(
  engine: WebGPUEngine,
  config: SpectralOceanConfig,
  cascadeIndex: number,
): UniformBuffer {
  const cascade = config.cascades[cascadeIndex];
  if (!cascade) throw new RangeError(`Missing ocean cascade ${cascadeIndex}`);
  const uniform = new UniformBuffer(engine, undefined, false, `ocean-init-${cascadeIndex}`);
  for (const name of ["resolution", "seed", "cascadeIndex", "padding0"]) {
    uniform.addUniform(name, 1);
  }
  for (const name of ["patchLength", "gravity", "windSpeed", "fetchLength"]) {
    uniform.addUniform(name, 1);
  }
  uniform.addUniform("windDirection", 2);
  for (const name of [
    "spectrumScale",
    "directionalSpread",
    "depth",
    "surfaceTension",
    "minWavelength",
    "maxWavelength",
  ]) {
    uniform.addUniform(name, 1);
  }
  uniform.create();
  uniform.updateUInt("resolution", config.resolution);
  uniform.updateUInt("seed", config.seed);
  uniform.updateUInt("cascadeIndex", cascadeIndex);
  uniform.updateUInt("padding0", 0);
  uniform.updateFloat("patchLength", cascade.patchLengthMeters);
  uniform.updateFloat("gravity", config.gravityMetersPerSecondSquared);
  uniform.updateFloat("windSpeed", config.windSpeedMetersPerSecond);
  uniform.updateFloat("fetchLength", config.fetchLengthMeters);
  uniform.updateFloat2("windDirection", config.windDirection[0], config.windDirection[1]);
  uniform.updateFloat("spectrumScale", cascade.spectrumScale);
  uniform.updateFloat("directionalSpread", config.directionalSpread);
  uniform.updateFloat("depth", config.representativeDepthMeters);
  uniform.updateFloat("surfaceTension", config.surfaceTensionOverDensity);
  uniform.updateFloat("minWavelength", cascade.minimumWavelengthMeters);
  uniform.updateFloat("maxWavelength", cascade.maximumWavelengthMeters);
  uniform.update();
  return uniform;
}

function createEvolutionUniform(
  engine: WebGPUEngine,
  config: SpectralOceanConfig,
  cascadeIndex: number,
): UniformBuffer {
  const uniform = new UniformBuffer(engine, undefined, true, `ocean-evolve-${cascadeIndex}`);
  uniform.addUniform("header", 4);
  uniform.addUniform("time", 1);
  uniform.addUniform("gravity", 1);
  uniform.addUniform("depth", 1);
  uniform.addUniform("choppiness", 1);
  uniform.create();
  uniform.updateUInt4("header", config.resolution, cascadeIndex, 0, 0);
  uniform.updateFloat("time", 17.25);
  uniform.updateFloat("gravity", config.gravityMetersPerSecondSquared);
  uniform.updateFloat("depth", config.representativeDepthMeters);
  uniform.updateFloat("choppiness", config.choppiness);
  uniform.update();
  return uniform;
}

function createFftUniform(
  engine: WebGPUEngine,
  resolution: number,
  stage: number,
  axis: "horizontal" | "vertical",
  normalization: number,
): UniformBuffer {
  const uniform = new UniformBuffer(engine, undefined, false, `ocean-fft-${axis}-${stage}`);
  uniform.addUniform("params", 4);
  uniform.addUniform("normalization", 1);
  uniform.create();
  uniform.updateUInt4("params", resolution, stage, axis === "horizontal" ? 0 : 1, 0);
  uniform.updateFloat("normalization", normalization);
  uniform.update();
  return uniform;
}

function preDepthSaturationSource(): string {
  const stableDepthResponse = "tanh(min(k_length * params.water_depth_m, 10.0))";
  const source = OCEAN_SPECTRUM_INITIALIZATION_WGSL.replace(
    stableDepthResponse,
    "tanh(k_length * params.water_depth_m)",
  );
  if (source === OCEAN_SPECTRUM_INITIALIZATION_WGSL) {
    throw new Error("Unable to construct the pre-saturation ocean initialization control");
  }
  return source;
}

function preFinitenessGuardsInitializationSource(): string {
  const guard = "  let spectrum_finite = spectrum >= 0.0 && spectrum <= 3.0e38;\n"
    + "  let safe_spectrum = select(0.0, spectrum, spectrum_finite);";
  const unsaturated = preDepthSaturationSource();
  const source = unsaturated.replace(
    guard,
    "  let safe_spectrum = spectrum;",
  );
  if (source === unsaturated) {
    throw new Error("Unable to construct the pre-guard ocean initialization control");
  }
  return source;
}

async function initializeSpectrum(
  engine: WebGPUEngine,
  scene: Scene,
  config: SpectralOceanConfig,
  cascadeIndex: number,
  source: string,
  sourceVariant: string,
): Promise<InitializedSpectrum> {
  const resolution = config.resolution;
  const initialSpectrum = storageTexture(
    scene,
    resolution,
    Constants.TEXTURETYPE_FLOAT,
    `ocean-h0-${cascadeIndex}`,
  );
  const waveData = storageTexture(
    scene,
    resolution,
    Constants.TEXTURETYPE_FLOAT,
    `ocean-wave-${cascadeIndex}`,
  );
  const uniform = createInitializationUniform(engine, config, cascadeIndex);
  const shader = createCompute(
    `ocean-initialize-${sourceVariant}-${cascadeIndex}`,
    engine,
    source,
    "initializeOceanSpectrum",
    ["params", "initial_spectrum", "wave_data"],
  );
  shader.setUniformBuffer("params", uniform);
  shader.setStorageTexture("initial_spectrum", initialSpectrum);
  shader.setStorageTexture("wave_data", waveData);
  const groups = Math.ceil(resolution / 8);
  await shader.dispatchWhenReady(groups, groups, 1);
  return { initialSpectrum, waveData, uniform };
}

async function transformSpectrum(
  engine: WebGPUEngine,
  scene: Scene,
  config: SpectralOceanConfig,
  cascadeIndex: number,
  initialized: InitializedSpectrum,
): Promise<OceanTransform> {
  const resolution = config.resolution;
  const cascade = config.cascades[cascadeIndex];
  if (!cascade) throw new RangeError(`Missing ocean cascade ${cascadeIndex}`);
  const transformA = [0, 1].map((index) => storageTexture(
    scene,
    resolution,
    Constants.TEXTURETYPE_HALF_FLOAT,
    `ocean-a${index}-${cascadeIndex}`,
  )) as [RawTexture, RawTexture];
  const transformB = [0, 1].map((index) => storageTexture(
    scene,
    resolution,
    Constants.TEXTURETYPE_HALF_FLOAT,
    `ocean-b${index}-${cascadeIndex}`,
  )) as [RawTexture, RawTexture];
  const evolutionUniform = createEvolutionUniform(engine, config, cascadeIndex);
  const evolution = createCompute(
    `ocean-evolve-${cascadeIndex}`,
    engine,
    OCEAN_SPECTRUM_EVOLUTION_WGSL,
    "evolveOceanSpectrum",
    [
      "params",
      "initial_spectrum",
      "wave_data",
      "height_displacement_x",
      "displacement_z_aux",
    ],
  );
  evolution.setUniformBuffer("params", evolutionUniform);
  evolution.setTexture("initial_spectrum", initialized.initialSpectrum, false);
  evolution.setTexture("wave_data", initialized.waveData, false);
  evolution.setStorageTexture("height_displacement_x", transformA[0]);
  evolution.setStorageTexture("displacement_z_aux", transformB[0]);
  const groups = Math.ceil(resolution / 8);
  await evolution.dispatchWhenReady(groups, groups, 1);

  const uniforms: UniformBuffer[] = [evolutionUniform];
  let sourceIndex: 0 | 1 = 0;
  const normalizationScale = oceanTransformNormalizationScale(cascade.patchLengthMeters);
  for (const pass of buildOceanFftDispatches(resolution)) {
    const outputIndex = (1 - sourceIndex) as 0 | 1;
    const uniform = createFftUniform(
      engine,
      resolution,
      pass.stage,
      pass.axis,
      pass.normalize ? normalizationScale : 1,
    );
    uniforms.push(uniform);
    const shader = createCompute(
      `ocean-fft-${cascadeIndex}-${pass.axis}-${pass.stage}`,
      engine,
      OCEAN_STOCKHAM_IFFT_WGSL,
      "stockhamInverseFft",
      ["params", "source_a", "source_b", "destination_a", "destination_b"],
    );
    shader.setUniformBuffer("params", uniform);
    shader.setTexture("source_a", transformA[sourceIndex], false);
    shader.setTexture("source_b", transformB[sourceIndex], false);
    shader.setStorageTexture("destination_a", transformA[outputIndex]);
    shader.setStorageTexture("destination_b", transformB[outputIndex]);
    await shader.dispatchWhenReady(...pass.dispatch);
    sourceIndex = outputIndex;
  }
  return { transformA, transformB, uniforms, finalIndex: sourceIndex };
}

async function readTexturePair(
  engine: WebGPUEngine,
  first: RawTexture,
  second: RawTexture,
  resolution: number,
): Promise<Float32Array> {
  const resultBuffer = new StorageBuffer(engine, resolution * resolution * 8 * 4);
  try {
    const shader = createCompute(
      "ocean-texture-pair-readback",
      engine,
      TEXTURE_PAIR_READBACK_WGSL,
      "readTexturePair",
      ["source_a", "source_b", "results"],
    );
    shader.setTexture("source_a", first, false);
    shader.setTexture("source_b", second, false);
    shader.setStorageBuffer("results", resultBuffer);
    const groups = Math.ceil(resolution / 8);
    await shader.dispatchWhenReady(groups, groups, 1);
    const view = await resultBuffer.read();
    const values = new Float32Array(view.byteLength / 4);
    values.set(new Float32Array(view.buffer, view.byteOffset, values.length));
    return values;
  } finally {
    resultBuffer.dispose();
  }
}

function textureStatistics(values: Float32Array, textureIndex: 0 | 1): TextureStatistics {
  let nonFiniteTexels = 0;
  let nonZeroValues = 0;
  let maximumAbsoluteValue = 0;
  const textureOffset = textureIndex * 4;
  for (let pixel = 0; pixel < values.length / 8; pixel += 1) {
    let texelFinite = true;
    for (let lane = 0; lane < 4; lane += 1) {
      const value = values[pixel * 8 + textureOffset + lane]!;
      if (!Number.isFinite(value)) {
        texelFinite = false;
        continue;
      }
      if (value !== 0) nonZeroValues += 1;
      maximumAbsoluteValue = Math.max(maximumAbsoluteValue, Math.abs(value));
    }
    if (!texelFinite) nonFiniteTexels += 1;
  }
  return { nonFiniteTexels, nonZeroValues, maximumAbsoluteValue };
}

function disposeInitialization(initialized: InitializedSpectrum): void {
  initialized.uniform.dispose();
  initialized.initialSpectrum.dispose();
  initialized.waveData.dispose();
}

function disposeTransform(transform: OceanTransform): void {
  for (const uniform of transform.uniforms) uniform.dispose();
  for (const texture of [...transform.transformA, ...transform.transformB]) texture.dispose();
}

async function withScene(
  run: (engine: WebGPUEngine, scene: Scene) => Promise<void>,
): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, {
    antialias: false,
    enableAllFeatures: false,
    setMaximumLimits: false,
  });
  let scene: Scene | null = null;
  try {
    await engine.initAsync();
    engine.runRenderLoop(() => {});
    scene = new Scene(engine);
    await run(engine, scene);
  } finally {
    scene?.dispose();
    engine.stopRenderLoop();
    engine.dispose();
    canvas.remove();
  }
}

describe("spectral-ocean GPU finiteness", () => {
  it("stabilizes tier-1 depth response before the fp16 FFT", async () => {
    await withScene(async (engine, scene) => {
      const profile = resolveWebGpuQualityProfile("medium", "balanced");
      expect(profile.tier).toBe(1);
      expect(profile.oceanResolution).toBe(128);
      expect(profile.oceanCascades).toBe(4);
      const profileDefaults = resolveSpectralOceanConfig({
        resolution: profile.oceanResolution,
      });
      const config = resolveSpectralOceanConfig({
        resolution: profile.oceanResolution,
        seed: SHIPPING_SEED,
        representativeDepthMeters: SHIPPING_DEPTH_METERS,
        cascades: profileDefaults.cascades.slice(0, profile.oceanCascades),
      });
      expect(config.seed).toBe(SHIPPING_SEED);
      expect(config.representativeDepthMeters).toBe(SHIPPING_DEPTH_METERS);
      expect(config.cascades).toHaveLength(4);
      expect(config.cascades[POISONED_CASCADE_INDEX]?.patchLengthMeters).toBe(4_096);

      // Negative control one: without the physically lossless tanh saturation,
      // ANGLE/Metal returns zero for the large positive depth arguments in the
      // short-wave cascade. Its independent k-vector output proves the compute
      // ran even though every H0/spectrum/omega lane collapsed to zero.
      const unsaturated = await initializeSpectrum(
        engine,
        scene,
        config,
        0,
        preDepthSaturationSource(),
        "pre-depth-saturation",
      );
      try {
        const values = await readTexturePair(
          engine,
          unsaturated.initialSpectrum,
          unsaturated.waveData,
          config.resolution,
        );
        expect(textureStatistics(values, 0)).toEqual({
          nonFiniteTexels: 0,
          nonZeroValues: 0,
          maximumAbsoluteValue: 0,
        });
        const waveStats = textureStatistics(values, 1);
        expect(waveStats.nonFiniteTexels).toBe(0);
        expect(waveStats.nonZeroValues).toBeGreaterThan(config.resolution);
      } finally {
        disposeInitialization(unsaturated);
      }

      // Negative control two: the same unbounded f32 path before either guard
      // produces non-finite cascade-3 texels. The finite wave data makes this a
      // non-vacuous observation of the spectrum fault, not a failed readback.
      const unguarded = await initializeSpectrum(
        engine,
        scene,
        config,
        POISONED_CASCADE_INDEX,
        preFinitenessGuardsInitializationSource(),
        "pre-finiteness-guards",
      );
      try {
        const values = await readTexturePair(
          engine,
          unguarded.initialSpectrum,
          unguarded.waveData,
          config.resolution,
        );
        expect(textureStatistics(values, 0).nonFiniteTexels).toBeGreaterThan(0);
        expect(textureStatistics(values, 1).nonFiniteTexels).toBe(0);
      } finally {
        disposeInitialization(unguarded);
      }

      // Carry every cascade from the actual tier-1 row through the complete
      // pipeline. Cascades 0 and 3 arm the two known failures; checking the
      // middle bands too makes the shipping four-cascade finiteness claim
      // complete rather than inferred. The first readback covers the fixed f32
      // source; the second covers evolution plus every horizontal/vertical
      // Stockham pass in the shipping rgba16float ping-pong chain.
      for (let cascadeIndex = 0; cascadeIndex < config.cascades.length; cascadeIndex += 1) {
        const initialized = await initializeSpectrum(
          engine,
          scene,
          config,
          cascadeIndex,
          OCEAN_SPECTRUM_INITIALIZATION_WGSL,
          "shipping",
        );
        let transform: OceanTransform | null = null;
        try {
          const initializedValues = await readTexturePair(
            engine,
            initialized.initialSpectrum,
            initialized.waveData,
            config.resolution,
          );
          const initializedSpectrumStats = textureStatistics(initializedValues, 0);
          const initializedWaveStats = textureStatistics(initializedValues, 1);
          expect(initializedSpectrumStats.nonFiniteTexels).toBe(0);
          expect(initializedWaveStats.nonFiniteTexels).toBe(0);
          expect(
            initializedSpectrumStats.nonZeroValues,
            `cascade ${cascadeIndex} initialized spectrum ${JSON.stringify(initializedSpectrumStats)}`,
          ).toBeGreaterThan(0);

          transform = await transformSpectrum(engine, scene, config, cascadeIndex, initialized);
          const transformedValues = await readTexturePair(
            engine,
            transform.transformA[transform.finalIndex],
            transform.transformB[transform.finalIndex],
            config.resolution,
          );
          const transformAStats = textureStatistics(transformedValues, 0);
          const transformBStats = textureStatistics(transformedValues, 1);
          expect(transformAStats.nonFiniteTexels, `cascade ${cascadeIndex} transform A`).toBe(0);
          expect(transformBStats.nonFiniteTexels, `cascade ${cascadeIndex} transform B`).toBe(0);
          expect(Math.max(
            transformAStats.maximumAbsoluteValue,
            transformBStats.maximumAbsoluteValue,
          )).toBeLessThan(FP16_SAFETY_CEILING);
          expect(
            transformAStats.nonZeroValues + transformBStats.nonZeroValues,
            `cascade ${cascadeIndex} must retain spectral energy; A=${JSON.stringify(transformAStats)} B=${JSON.stringify(transformBStats)}`,
          )
            .toBeGreaterThan(config.resolution);
          expect(Math.max(
            transformAStats.maximumAbsoluteValue,
            transformBStats.maximumAbsoluteValue,
          )).toBeGreaterThan(1e-4);
        } finally {
          if (transform) disposeTransform(transform);
          disposeInitialization(initialized);
        }
      }
    });
  }, 120_000);
});
