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
import {
  buildOceanFftDispatches,
  oceanTransformNormalizationScale,
  packOceanDerivationUniforms,
  packOceanEvolutionUniforms,
  packOceanFftUniforms,
  packOceanInitializationUniforms,
} from "../../src/render/webgpu/nature/OceanConfig";
import {
  OCEAN_SPATIAL_DERIVATION_WGSL,
  OCEAN_SPECTRUM_EVOLUTION_WGSL,
  OCEAN_SPECTRUM_INITIALIZATION_WGSL,
  OCEAN_STOCKHAM_IFFT_WGSL,
} from "../../src/render/webgpu/nature/OceanShaders";
import type { WeatherPreset } from "../../src/game/types";
import { resolveSeaSpectrumConfig, type SeaWorld } from "../../src/sim/water/seaState";
import { SEA_TWIN_CASCADES, SeaTwin } from "../../src/sim/water/seaTwin";
import {
  packSeaShelterEllipses,
  SEA_SHELTER_MAX_ELLIPSES,
  SEA_SHELTER_UNIFORMS,
  SEA_SHELTER_WGSL,
  seaShelterFactor,
} from "../../src/sim/water/shelter";
import type { SpectralOceanConfig } from "../../src/sim/water/spectrumConfig";
import type { SeaShelterEllipse } from "../../src/sim/water/types";

/**
 * The boats' water authority (docs/architecture/ARCHITECTURE.md §3): a hull
 * floats on the CPU sea twin, and the twin must be the sea the GPU draws. The
 * Node suite proves the twin's wave sum equals an f64 FFT of the shipping
 * spectrum (tests/world.sea-twin.test.ts); this test runs the SHIPPING compute
 * shaders (initialisation, evolution, every Stockham pass in the rgba16float
 * ping-pong, the spatial derivation) and reads back the displacement texture
 * the ocean's vertex stage samples. At a texel-lattice point the half-texel
 * aligned filtered fetch returns exactly that texel, so the readback IS the
 * drawn displacement there, before the distance fades.
 */

// The shipping world's sea inputs (the perf baselines' seed and wind).
const SEA_WORLD: SeaWorld = Object.freeze({
  sourceSeedHash: 0x4f434541,
  prevailingWindRadians: 4.2243797,
  prevailingWindSpeed: 9.62323060631752,
});
// Early in a session, where the f32 phase `omega t` the GPU forms is exact to
// ~1e-6 rad, so what remains is the fp16 transform.
const TIME_SECONDS = 17.25;
const POINTS = 96;
// fp16 keeps 11 significant bits. Each cascade's value passes through
// 2 log2(N) rounded Stockham stages and the stored texel, so the drawn sum is
// held to a few half-float ulps of the largest texel it adds.
const FP16_EPSILON = 2 ** -11;
const FP16_ULPS = 4;

const DISPLACEMENT_READBACK_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> results: array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn readDisplacement(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let dimensions = textureDimensions(source);
  if (invocation.x >= dimensions.x || invocation.y >= dimensions.y) {
    return;
  }
  results[invocation.x + invocation.y * dimensions.x] = textureLoad(source, vec2<i32>(invocation.xy), 0);
}
`;

// The vertex stage's shelter, run as-is: the same WGSL, reading the same
// uniform names through a struct bound as \`uniforms\`.
const SHELTER_PROBE_WGSL = /* wgsl */ `
struct SeaShelterUniforms {
${SEA_SHELTER_UNIFORMS.map((name) => `  ${name}: vec4f,`).join("\n")}
};
@group(0) @binding(0) var<uniform> uniforms: SeaShelterUniforms;
@group(0) @binding(1) var<storage, read> points: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> results: array<u32>;
${SEA_SHELTER_WGSL}
@compute @workgroup_size(64, 1, 1)
fn probeShelter(@builtin(global_invocation_id) invocation: vec3<u32>) {
  if (invocation.x >= arrayLength(&points)) {
    return;
  }
  results[invocation.x] = bitcast<u32>(seaShelterFactor(points[invocation.x]));
}
`;

const compileErrors: string[] = [];
const shaders = new Map<string, ComputeShader>();

function computeShader(
  engine: WebGPUEngine,
  name: string,
  source: string,
  entryPoint: string,
  bindingNames: readonly string[],
): ComputeShader {
  let shader = shaders.get(name);
  if (!shader) {
    shader = new ComputeShader(name, engine, { computeSource: source }, {
      entryPoint,
      bindingsMapping: Object.fromEntries(bindingNames.map((bindingName, binding) => [
        bindingName,
        { group: 0, binding },
      ])),
    });
    shader.onError = (_effect, errors) => {
      compileErrors.push(`${name}: ${errors}`);
    };
    shaders.set(name, shader);
  }
  return shader;
}

// `dispatch` until the pipeline is ready, not `dispatchWhenReady`, which can
// latch on a slow compile (see docs/PERFORMANCE.md, SwiftShader notes).
async function dispatch(shader: ComputeShader, x: number, y: number, z = 1): Promise<void> {
  const deadline = performance.now() + 600_000;
  while (!shader.dispatch(x, y, z)) {
    if (compileErrors.length > 0) throw new Error(compileErrors.join("\n"));
    if (performance.now() > deadline) throw new Error(`${shader.name} never became ready`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function storageTexture(scene: Scene, resolution: number, type: number): RawTexture {
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
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  return texture;
}

/**
 * A uniform buffer holding exactly the bytes `packOcean*Uniforms` packs: the
 * WGSL param structs' layouts, with the spectrum terms the shipping ocean
 * hands its shaders (D1's fetch and energy caps). Every struct opens with four
 * u32 words; the rest are f32.
 */
function packedUniform(engine: WebGPUEngine, name: string, packed: ArrayBuffer): UniformBuffer {
  const view = new DataView(packed);
  const words = packed.byteLength / 4;
  const uniform = new UniformBuffer(engine, undefined, false, name);
  for (let word = 0; word < words; word += 1) uniform.addUniform(`word${word}`, 1);
  uniform.create();
  for (let word = 0; word < words; word += 1) {
    if (word < 4) uniform.updateUInt(`word${word}`, view.getUint32(word * 4, true));
    else uniform.updateFloat(`word${word}`, view.getFloat32(word * 4, true));
  }
  uniform.update();
  return uniform;
}

/**
 * One cascade through the shipping pipeline. Returns the displacement texture
 * the vertex samples, `(dx, h, dz, jacobian)` per texel, x fastest.
 */
async function drawnCascade(
  engine: WebGPUEngine,
  scene: Scene,
  config: SpectralOceanConfig,
  cascadeIndex: number,
  initialization: ArrayBuffer = packOceanInitializationUniforms(config, cascadeIndex),
): Promise<Float32Array> {
  const resolution = config.resolution;
  const groups = Math.ceil(resolution / 8);
  const uniforms: UniformBuffer[] = [];
  const textures: RawTexture[] = [];
  const texture = (type: number) => {
    const created = storageTexture(scene, resolution, type);
    textures.push(created);
    return created;
  };
  const results = new StorageBuffer(engine, resolution * resolution * 16);
  try {
    const initialSpectrum = texture(Constants.TEXTURETYPE_FLOAT);
    const waveData = texture(Constants.TEXTURETYPE_FLOAT);
    const initialize = computeShader(engine, "parity-initialize", OCEAN_SPECTRUM_INITIALIZATION_WGSL, "initializeOceanSpectrum", [
      "params", "initial_spectrum", "wave_data",
    ]);
    uniforms.push(packedUniform(engine, `parity-init-${cascadeIndex}`, initialization));
    initialize.setUniformBuffer("params", uniforms[uniforms.length - 1]!);
    initialize.setStorageTexture("initial_spectrum", initialSpectrum);
    initialize.setStorageTexture("wave_data", waveData);
    await dispatch(initialize, groups, groups);

    const transformA = [texture(Constants.TEXTURETYPE_HALF_FLOAT), texture(Constants.TEXTURETYPE_HALF_FLOAT)] as const;
    const transformB = [texture(Constants.TEXTURETYPE_HALF_FLOAT), texture(Constants.TEXTURETYPE_HALF_FLOAT)] as const;
    const evolution = computeShader(engine, "parity-evolve", OCEAN_SPECTRUM_EVOLUTION_WGSL, "evolveOceanSpectrum", [
      "params", "initial_spectrum", "wave_data", "height_displacement_x", "displacement_z_aux",
    ]);
    uniforms.push(packedUniform(engine, `parity-evolve-${cascadeIndex}`, packOceanEvolutionUniforms(config, cascadeIndex, TIME_SECONDS)));
    evolution.setUniformBuffer("params", uniforms[uniforms.length - 1]!);
    evolution.setTexture("initial_spectrum", initialSpectrum, false);
    evolution.setTexture("wave_data", waveData, false);
    evolution.setStorageTexture("height_displacement_x", transformA[0]);
    evolution.setStorageTexture("displacement_z_aux", transformB[0]);
    await dispatch(evolution, groups, groups);

    let sourceIndex: 0 | 1 = 0;
    const normalization = oceanTransformNormalizationScale(config.cascades[cascadeIndex]!.patchLengthMeters);
    for (const pass of buildOceanFftDispatches(resolution)) {
      const outputIndex = (1 - sourceIndex) as 0 | 1;
      // One shader per pass: a ComputeShader keeps one binding set.
      const fft = computeShader(engine, `parity-fft-${pass.axis}-${pass.stage}-${sourceIndex}`, OCEAN_STOCKHAM_IFFT_WGSL, "stockhamInverseFft", [
        "params", "source_a", "source_b", "destination_a", "destination_b",
      ]);
      uniforms.push(packedUniform(engine, `parity-fft-${pass.axis}-${pass.stage}`, packOceanFftUniforms(resolution, pass.stage, pass.axis, pass.normalize ? normalization : 1)));
      fft.setUniformBuffer("params", uniforms[uniforms.length - 1]!);
      fft.setTexture("source_a", transformA[sourceIndex], false);
      fft.setTexture("source_b", transformB[sourceIndex], false);
      fft.setStorageTexture("destination_a", transformA[outputIndex]);
      fft.setStorageTexture("destination_b", transformB[outputIndex]);
      await dispatch(fft, ...pass.dispatch);
      sourceIndex = outputIndex;
    }

    const displacement = texture(Constants.TEXTURETYPE_HALF_FLOAT);
    const previousSlopeFoam = texture(Constants.TEXTURETYPE_HALF_FLOAT);
    const slopeFoam = texture(Constants.TEXTURETYPE_HALF_FLOAT);
    const slopeMoment = texture(Constants.TEXTURETYPE_HALF_FLOAT);
    const derivation = computeShader(engine, "parity-derive", OCEAN_SPATIAL_DERIVATION_WGSL, "deriveOceanSurface", [
      "params", "spatial_height_displacement_x", "spatial_displacement_z_aux", "previous_slope_foam",
      "displacement_jacobian", "slope_foam", "slope_moment",
    ]);
    uniforms.push(packedUniform(engine, `parity-derive-${cascadeIndex}`, packOceanDerivationUniforms(config, cascadeIndex, 0)));
    derivation.setUniformBuffer("params", uniforms[uniforms.length - 1]!);
    derivation.setTexture("spatial_height_displacement_x", transformA[sourceIndex], false);
    derivation.setTexture("spatial_displacement_z_aux", transformB[sourceIndex], false);
    derivation.setTexture("previous_slope_foam", previousSlopeFoam, false);
    derivation.setStorageTexture("displacement_jacobian", displacement);
    derivation.setStorageTexture("slope_foam", slopeFoam);
    derivation.setStorageTexture("slope_moment", slopeMoment);
    await dispatch(derivation, groups, groups);

    const readback = computeShader(engine, "parity-read", DISPLACEMENT_READBACK_WGSL, "readDisplacement", ["source", "results"]);
    readback.setTexture("source", displacement, false);
    readback.setStorageBuffer("results", results);
    await dispatch(readback, groups, groups);
    const view = await results.read();
    return new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4).slice();
  } finally {
    results.dispose();
    for (const uniform of uniforms) uniform.dispose();
    for (const created of textures) created.dispose();
  }
}

async function shaderShelter(engine: WebGPUEngine, packed: Float64Array, points: Float32Array): Promise<Float32Array> {
  const uniform = new UniformBuffer(engine, undefined, false, "parity-shelter");
  for (const name of SEA_SHELTER_UNIFORMS) uniform.addUniform(name, 4);
  uniform.create();
  for (let slot = 0; slot < SEA_SHELTER_MAX_ELLIPSES; slot += 1) {
    uniform.updateFloat4(`seaShelterA${slot}`, packed[slot * 8]!, packed[slot * 8 + 1]!, packed[slot * 8 + 2]!, packed[slot * 8 + 3]!);
    uniform.updateFloat4(`seaShelterB${slot}`, packed[slot * 8 + 4]!, packed[slot * 8 + 5]!, packed[slot * 8 + 6]!, packed[slot * 8 + 7]!);
  }
  uniform.update();
  const input = new StorageBuffer(engine, points.byteLength);
  input.update(points);
  const output = new StorageBuffer(engine, (points.length / 2) * 4);
  try {
    const probe = computeShader(engine, "parity-shelter", SHELTER_PROBE_WGSL, "probeShelter", ["uniforms", "points", "results"]);
    probe.setUniformBuffer("uniforms", uniform);
    probe.setStorageBuffer("points", input);
    probe.setStorageBuffer("results", output);
    await dispatch(probe, Math.ceil(points.length / 2 / 64), 1);
    const view = await output.read();
    return new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4).slice();
  } finally {
    uniform.dispose();
    input.dispose();
    output.dispose();
  }
}

async function withEngine(run: (engine: WebGPUEngine, scene: Scene) => Promise<void>): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
  let scene: Scene | null = null;
  try {
    await engine.initAsync();
    // Compute dispatches only run inside a frame.
    engine.runRenderLoop(() => {});
    scene = new Scene(engine);
    await run(engine, scene);
  } finally {
    for (const shader of shaders.values()) shader.onError = null;
    shaders.clear();
    scene?.dispose();
    engine.stopRenderLoop();
    engine.dispose();
    canvas.remove();
  }
}

/**
 * The negative control: the initialisation uniform as it was packed before D1,
 * with the config's raw fetch and cascade scale instead of the capped
 * spectrum terms. A light-wind sea drawn from it is not the twin's sea.
 */
function uncappedInitialization(config: SpectralOceanConfig, cascadeIndex: number): ArrayBuffer {
  const packed = packOceanInitializationUniforms(config, cascadeIndex);
  const view = new DataView(packed);
  view.setFloat32(28, config.fetchLengthMeters, true);
  view.setFloat32(40, config.cascades[cascadeIndex]!.spectrumScale, true);
  return packed;
}

/** The drawn `(dx, h, dz)` at a point on every cascade's texel lattice. */
function drawnAt(config: SpectralOceanConfig, drawn: readonly Float32Array[], x: number, z: number): [number, number, number] {
  const n = config.resolution;
  let dx = 0;
  let h = 0;
  let dz = 0;
  SEA_TWIN_CASCADES.forEach((cascade, slot) => {
    const texel = config.cascades[cascade]!.patchLengthMeters / n;
    const u = ((Math.round(x / texel) % n) + n) % n;
    const v = ((Math.round(z / texel) % n) + n) % n;
    const texels = drawn[slot]!;
    dx += texels[(u + v * n) * 4]!;
    h += texels[(u + v * n) * 4 + 1]!;
    dz += texels[(u + v * n) * 4 + 2]!;
  });
  return [dx, h, dz];
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("ocean twin parity", () => {
  it("the drawn sea's displacement is the twin's, within fp16", async () => {
    await withEngine(async (engine, scene) => {
      for (const weather of ["clear", "cloudy"] satisfies WeatherPreset[]) {
        // The twin's canonical config: 256 points, the resolution every
        // tier-2/3 profile draws; tier 0/1 hold the same waves in bands 1-4.
        const config = resolveSeaSpectrumConfig(SEA_WORLD, weather);
        const twin = new SeaTwin(config, { seaLevel: 0, keptVariance: 1, amplitudeFloorMeters: 0 });
        twin.setTime(TIME_SECONDS);
        const n = config.resolution;
        const drawn: Float32Array[] = [];
        const largest = { h: 0, dx: 0, dz: 0 };
        for (const cascade of SEA_TWIN_CASCADES) {
          const texels = await drawnCascade(engine, scene, config, cascade);
          let finite = true;
          let maxH = 0;
          let maxX = 0;
          let maxZ = 0;
          for (let index = 0; index < n * n; index += 1) {
            const dx = texels[index * 4]!;
            const h = texels[index * 4 + 1]!;
            const dz = texels[index * 4 + 2]!;
            finite &&= Number.isFinite(dx) && Number.isFinite(h) && Number.isFinite(dz);
            maxH = Math.max(maxH, Math.abs(h));
            maxX = Math.max(maxX, Math.abs(dx));
            maxZ = Math.max(maxZ, Math.abs(dz));
          }
          // A light-wind sea leaves the 512-2048 m band empty (D1's fully
          // developed cap), so only finiteness is asked of each band.
          expect(finite, `${weather} cascade ${cascade} finite`).toBe(true);
          largest.h += maxH;
          largest.dx += maxX;
          largest.dz += maxZ;
          drawn.push(texels);
        }

        // Points on every cascade's texel lattice (the 4096 m band's texel
        // is 64 m), near the origin and kilometres out.
        const lattice = config.cascades[SEA_TWIN_CASCADES[SEA_TWIN_CASCADES.length - 1]!]!.patchLengthMeters / n;
        const random = createRandom(weather === "clear" ? 11 : 29);
        let worstH = 0;
        let worstX = 0;
        let worstZ = 0;
        let sumSquares = 0;
        let twinSquares = 0;
        for (let point = 0; point < POINTS; point += 1) {
          const x = (Math.floor(random() * 2048) - 1024) * lattice;
          const z = (Math.floor(random() * 2048) - 1024) * lattice;
          const [dx, h, dz] = drawnAt(config, drawn, x, z);
          const expected = twin.exactLabelHeight(x, z);
          worstH = Math.max(worstH, Math.abs(h - expected.h));
          worstX = Math.max(worstX, Math.abs(dx - expected.dx));
          worstZ = Math.max(worstZ, Math.abs(dz - expected.dz));
          sumSquares += (h - expected.h) ** 2;
          twinSquares += expected.h ** 2;
        }
        const tolerance = (largest: number) => FP16_ULPS * FP16_EPSILON * largest;
        const report = `${weather}: worst h ${(worstH * 1000).toFixed(3)} mm (tol ${(tolerance(largest.h) * 1000).toFixed(3)}), `
          + `dx ${(worstX * 1000).toFixed(3)} mm (tol ${(tolerance(largest.dx) * 1000).toFixed(3)}), `
          + `dz ${(worstZ * 1000).toFixed(3)} mm (tol ${(tolerance(largest.dz) * 1000).toFixed(3)}); `
          + `rms h error ${(Math.sqrt(sumSquares / POINTS) * 1000).toFixed(3)} mm of ${Math.sqrt(twinSquares / POINTS).toFixed(3)} m`;
        console.log(report);
        // Not a vacuous match: the points see real waves.
        expect(Math.sqrt(twinSquares / POINTS), report).toBeGreaterThan(0.02);
        expect(worstH, report).toBeLessThanOrEqual(tolerance(largest.h));
        expect(worstX, report).toBeLessThanOrEqual(tolerance(largest.dx));
        expect(worstZ, report).toBeLessThanOrEqual(tolerance(largest.dz));

        if (weather !== "clear") continue;
        // The comparison can fail: the same pipeline fed the pre-D1
        // spectrum terms draws a light-wind sea the twin does not float on.
        const uncapped: Float32Array[] = [];
        for (const cascade of SEA_TWIN_CASCADES) {
          uncapped.push(await drawnCascade(engine, scene, config, cascade, uncappedInitialization(config, cascade)));
        }
        const control = createRandom(11);
        let controlWorst = 0;
        for (let point = 0; point < POINTS; point += 1) {
          const x = (Math.floor(control() * 2048) - 1024) * lattice;
          const z = (Math.floor(control() * 2048) - 1024) * lattice;
          controlWorst = Math.max(controlWorst, Math.abs(drawnAt(config, uncapped, x, z)[1] - twin.exactLabelHeight(x, z).h));
        }
        expect(controlWorst, "the uncapped control must miss the twin").toBeGreaterThan(20 * tolerance(largest.h));
      }
    });
  }, 1_800_000);

  it("the vertex stage's marina shelter is the twin's", async () => {
    await withEngine(async (engine) => {
      const basins: SeaShelterEllipse[] = [
        { centerX: 5312.5, centerZ: -2875.25, heading: 0.6, radiusAlong: 180, radiusAcross: 95, floor: 0.12, feather: 40 },
        { centerX: -1210, centerZ: 860, heading: -1.9, radiusAlong: 70, radiusAcross: 55, floor: 0.3, feather: 25 },
      ];
      const random = createRandom(5);
      const coordinates: number[] = [];
      for (const basin of basins) {
        for (let point = 0; point < 512; point += 1) {
          const angle = random() * Math.PI * 2;
          const reach = random() * 1.6 * (basin.radiusAlong + basin.feather);
          coordinates.push(basin.centerX + reach * Math.sin(angle), basin.centerZ + reach * Math.cos(angle));
        }
      }
      // And the open sea, far from both.
      for (let point = 0; point < 256; point += 1) {
        coordinates.push((random() - 0.5) * 40_000 + 20_000, (random() - 0.5) * 40_000 - 20_000);
      }
      const points = new Float32Array(coordinates);

      // No basin set: every ocean vertex is multiplied by exactly 1.
      const neutral = await shaderShelter(engine, packSeaShelterEllipses([]), points);
      expect(neutral.every((value) => value === 1)).toBe(true);

      const packed = packSeaShelterEllipses(basins);
      const drawn = await shaderShelter(engine, packed, points);
      let worst = 0;
      let inside = 0;
      let outsideExact = true;
      for (let point = 0; point < points.length / 2; point += 1) {
        const x = points[point * 2]!;
        const z = points[point * 2 + 1]!;
        const twin = seaShelterFactor(packed, x, z);
        worst = Math.max(worst, Math.abs(drawn[point]! - twin));
        if (twin < 0.5) inside += 1;
        if (twin === 1) outsideExact &&= drawn[point] === 1;
      }
      expect(inside, "points inside the basins").toBeGreaterThan(100);
      expect(outsideExact, "exactly 1 outside every basin").toBe(true);
      expect(worst).toBeLessThan(1e-5);
    });
  }, 600_000);
});
