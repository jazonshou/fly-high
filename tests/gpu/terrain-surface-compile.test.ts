import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
// Side-effect imports: compute pipelines and raw 2D-array textures on WebGPU.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { TextureSampler } from "@babylonjs/core/Materials/Textures/textureSampler";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { Scene } from "@babylonjs/core/scene";
import type { TerrainTriplanarMode } from "@/src/render/webgpu/core/QualityProfile";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSurfaceMaterialArrays,
  planSurfaceMaterialArrays,
} from "@/src/render/webgpu/terrain/MaterialArrayUpload";
import {
  SURFACE_MATERIAL_COUNT,
  SURFACE_MATERIALS,
  SurfaceMaterial,
} from "@/src/render/webgpu/terrain/surfaceMaterials";
import { RUNWAY_SDF_WGSL } from "@/src/render/webgpu/terrain/RunwaySurface";
import {
  TERRAIN_SURFACE_INJECTION_TOKENS,
  TerrainSurfacePlugin,
  TRIPLANAR_SLOPE_THRESHOLD,
} from "@/src/render/webgpu/terrain/TerrainSurfacePlugin";
import {
  DEFAULT_AIRPORT,
  roundedRectangleSignedDistance,
  runwayToWorld,
  worldToRunway,
} from "@/src/world";

/**
 * 3-2's GPU assertions: 57 (the injections survive into the PROCESSED effect
 * source), 58 (the effect enters neither NORMALMAP nor DETAIL), 55's upload
 * half (Babylon mips only layer 0 of an array — this is the device-side proof
 * that the CPU chain actually landed on every layer) and 61 (ten distinct
 * roughness values reach the shader).
 *
 * Assertion 57 checks the PROCESSED source rather than the plugin's output on
 * purpose: a `!regex` that matches nothing is silent, so the only way to catch
 * a Babylon bump reverting roughness to the material's 0.93 is to look at what
 * was actually compiled. Its Node-side sibling in
 * tests/render.webgpu-terrain-surface.test.ts matches the same anchors against
 * the shipped Babylon files, so a bump fails `npm test` too.
 */

const CANVAS_SIZE = 256;
const PROBE_EDGE = 64;
const PROBE_SEED = "terrain-surface-gpu";

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const gpuErrors: string[] = [];

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, {
    antialias: false,
    enableAllFeatures: false,
    setMaximumLimits: false,
  });
  await engine.initAsync();
  const device = (engine as unknown as { _device: GPUDevice })._device;
  device.addEventListener("uncapturederror", (event) => {
    gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
  });
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

/** A single quad carrying the provisional splat lane in its colour buffer. */
function createSplatQuad(scene: Scene, primary: number, secondary: number, weight: number): Mesh {
  const mesh = new Mesh("terrain-surface-quad", scene);
  const data = new VertexData();
  data.positions = new Float32Array([
    -8, 0, -8,
    8, 0, -8,
    8, 0, 8,
    -8, 0, 8,
  ]);
  data.normals = new Float32Array([
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
  ]);
  const colors = new Float32Array(16);
  for (let vertex = 0; vertex < 4; vertex += 1) {
    colors[vertex * 4] = primary;
    colors[vertex * 4 + 1] = secondary;
    colors[vertex * 4 + 2] = weight;
    colors[vertex * 4 + 3] = -1;
  }
  data.colors = colors;
  data.indices = [0, 1, 2, 0, 2, 3];
  data.applyToMesh(mesh, false);
  // The lane is the plugin's; VERTEXCOLOR must never be defined.
  mesh.useVertexColors = false;
  return mesh;
}

describe("terrain surface plugin compilation (3-2)", () => {
  it("assertions 57 and 58: the injections land and no tangent path compiles", async () => {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    try {
      const camera = new FreeCamera("camera", new Vector3(0, 12, -12), scene);
      camera.setTarget(Vector3.Zero());
      scene.activeCamera = camera;
      new HemisphericLight("ambient", Vector3.Up(), scene);

      const material = new PBRMaterial("terrain-pbr", scene);
      material.metallic = 0;
      material.roughness = 0.93;
      material.enableSpecularAntiAliasing = true;
      material.backFaceCulling = false;
      const plugin = new TerrainSurfacePlugin(material);
      const arrays = createSurfaceMaterialArrays(scene, PROBE_SEED, PROBE_EDGE);
      plugin.setArrays(arrays.albedoHeight, arrays.normalMaterial);
      plugin.setSamplingProfile("triplanar", 3);
      // 3-9's SDF painter is compiled here too — otherwise the only thing that
      // ever compiles TERRAIN_SURFACE_RUNWAY is the app itself.
      plugin.setRunway(DEFAULT_AIRPORT);
      const mesh = createSplatQuad(scene, SurfaceMaterial.Rock, SurfaceMaterial.Gravel, 0.3);
      mesh.material = material;

      for (let frame = 0; frame < 120 && !material.isReady(mesh); frame += 1) {
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(material.isReady(mesh), "the terrain material never became ready").toBe(true);

      // The effect lives on the sub-mesh, not the material: PBRMaterial
      // compiles one variant per sub-mesh define set.
      const effect = mesh.subMeshes[0]?.effect;
      expect(effect, "no effect was compiled for the terrain sub-mesh").toBeTruthy();
      const source = effect!.fragmentSourceCode;
      expect(source.length).toBeGreaterThan(1_000);

      // Assertion 57. A silent no-match would leave roughness at the
      // material's 0.93 — the audit's single-BRDF failure, returning through
      // a dependency bump instead of through code.
      for (const token of TERRAIN_SURFACE_INJECTION_TOKENS) {
        expect(
          source.includes(token),
          `the processed effect source is missing "${token}" — the !regex anchor matched `
          + "nothing and the injection silently did not apply",
        ).toBe(true);
      }
      // The anchors must not have swallowed what they anchor on.
      expect(source).toContain("reflectivityOut.roughness");
      expect(source).toContain("ambientOcclusionBlock(");

      // Assertion 58: no tangent attribute exists, so neither of Babylon's
      // tangent-frame paths may be compiled.
      const defines = effect!.defines;
      expect(defines).not.toMatch(/^#define NORMALMAP/mu);
      expect(defines).not.toMatch(/^#define DETAIL$/mu);
      expect(defines).not.toMatch(/^#define VERTEXCOLOR/mu);
      expect(defines).toMatch(/^#define TERRAIN_SURFACE_TRIPLANAR/mu);
      expect(defines).toMatch(/^#define TERRAIN_SURFACE_THREE_MATERIALS/mu);
      expect(defines).toMatch(/^#define TERRAIN_SURFACE_RUNWAY/mu);
      expect(source).toContain("terrainRunwayRoundedRect");
      expect(effect!.getAttributesNames()).toContain("color");
      expect(effect!.getAttributesNames()).not.toContain("tangent");

      // And it must actually draw something.
      engine.beginFrame();
      scene.render();
      engine.endFrame();
      const copy = document.createElement("canvas");
      copy.width = CANVAS_SIZE;
      copy.height = CANVAS_SIZE;
      const context = copy.getContext("2d")!;
      context.drawImage(canvas, 0, 0);
      const image = context.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;
      let lit = 0;
      for (let index = 0; index < image.length; index += 4) {
        if ((image[index] ?? 0) + (image[index + 1] ?? 0) + (image[index + 2] ?? 0) > 12) lit += 1;
      }
      expect(lit, "the terrain quad rasterized no visible pixels").toBeGreaterThan(500);

      arrays.albedoHeight.dispose();
      arrays.normalMaterial.dispose();
      material.dispose(true, true);
    } finally {
      scene.dispose();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(gpuErrors).toEqual([]);
  }, 120_000);

  it("assertion 55 (upload half) and 61: every layer's mips land, ten roughnesses arrive", async () => {
    // Babylon 9.21.2 mips only layer 0 of an array texture. The CPU reducer
    // exists to work around that, and this is the device-side proof that the
    // work-around actually reached the GPU rather than merely the plan.
    const scene = new Scene(engine);
    try {
      const plans = planSurfaceMaterialArrays(PROBE_SEED, PROBE_EDGE);
      const arrays = createSurfaceMaterialArrays(scene, PROBE_SEED, PROBE_EDGE);
      const probeLevels = [0, 2, 4];
      const sampleCount = SURFACE_MATERIAL_COUNT * probeLevels.length;
      const results = new StorageBuffer(engine, sampleCount * 8 * 4);

      const probeWgsl = /* wgsl */ `
@group(0) @binding(0) var albedoSampler: sampler;
@group(0) @binding(1) var albedoArray: texture_2d_array<f32>;
@group(0) @binding(2) var normalSampler: sampler;
@group(0) @binding(3) var normalArray: texture_2d_array<f32>;
@group(0) @binding(4) var<storage, read_write> results: array<vec4f>;

const LEVELS = array<f32, 3>(0.0, 2.0, 4.0);

@compute @workgroup_size(1, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let layer = i32(id.x);
  let slot = i32(id.y);
  let level = LEVELS[slot];
  // Centre of the layer, sampled at an explicit level so the probe reads the
  // mip under test rather than whatever the sampler would choose.
  let uv = vec2f(0.5, 0.5);
  let a = textureSampleLevel(albedoArray, albedoSampler, uv, layer, level);
  let b = textureSampleLevel(normalArray, normalSampler, uv, layer, level);
  let index = u32(layer * 3 + slot) * 2u;
  results[index] = a;
  results[index + 1u] = b;
}
`;
      const probe = new ComputeShader("terrain-surface-probe", engine, {
        computeSource: probeWgsl,
      }, {
        bindingsMapping: {
          albedoSampler: { group: 0, binding: 0 },
          albedoArray: { group: 0, binding: 1 },
          normalSampler: { group: 0, binding: 2 },
          normalArray: { group: 0, binding: 3 },
          results: { group: 0, binding: 4 },
        },
      });
      const sampler = new TextureSampler();
      sampler.setParameters(
        Texture.WRAP_ADDRESSMODE,
        Texture.WRAP_ADDRESSMODE,
        Texture.WRAP_ADDRESSMODE,
        1,
        Texture.TRILINEAR_SAMPLINGMODE,
      );
      probe.setTextureSampler("albedoSampler", sampler);
      probe.setTexture("albedoArray", arrays.albedoHeight, false);
      probe.setTextureSampler("normalSampler", sampler);
      probe.setTexture("normalArray", arrays.normalMaterial, false);
      probe.setStorageBuffer("results", results);

      engine.runRenderLoop(() => {});
      await probe.dispatchWhenReady(SURFACE_MATERIAL_COUNT, probeLevels.length, 1);
      const bytes = await results.read();
      engine.stopRenderLoop();
      const values = new Float32Array(bytes.buffer, bytes.byteOffset, sampleCount * 8);

      const roughnessAtBase: number[] = [];
      SURFACE_MATERIALS.forEach((spec, layer) => {
        probeLevels.forEach((level, slot) => {
          const base = (layer * probeLevels.length + slot) * 8;
          const levelEdge = PROBE_EDGE >> level;
          // uv (0.5, 0.5) on an even-edged level lands exactly on the corner
          // where texels (h-1, h-1) .. (h, h) meet, so the bilinear tap is the
          // mean of that 2x2 block.
          const half = (levelEdge >> 1) - 1;
          const centre = (half * levelEdge + half) * 4;
          const cpuAlbedo = plans.albedoHeight.layerChains[layer]![level]!;
          const cpuNormal = plans.normalMaterial.layerChains[layer]![level]!;
          // Bilinear at the exact centre of an even-edged level sits between
          // texels, so compare against a 2x2 mean rather than one texel.
          const meanOf = (source: Uint8Array, channel: number): number => {
            const at = centre + channel;
            const right = at + 4;
            const down = at + levelEdge * 4;
            const diagonal = down + 4;
            return (
              (source[at] ?? 0) + (source[right] ?? 0) + (source[down] ?? 0)
              + (source[diagonal] ?? 0)
            ) / 4 / 255;
          };
          for (let channel = 0; channel < 4; channel += 1) {
            expect(
              values[base + channel]!,
              `${spec.name} albedo/height channel ${channel} at mip ${level}`,
            ).toBeCloseTo(meanOf(cpuAlbedo, channel), 1);
            expect(
              values[base + 4 + channel]!,
              `${spec.name} normal/material channel ${channel} at mip ${level}`,
            ).toBeCloseTo(meanOf(cpuNormal, channel), 1);
          }
          if (level === 0) roughnessAtBase.push(values[base + 4 + 2]!);
        });
      });

      // Assertion 61: ten materials, ten distinct roughness values on the
      // device. The uniform-0.93 failure returning by another route would show
      // up here as one value repeated.
      expect(roughnessAtBase).toHaveLength(SURFACE_MATERIAL_COUNT);
      const rounded = new Set(roughnessAtBase.map((value) => Math.round(value * 40)));
      expect(
        rounded.size,
        `roughness values on the device: ${roughnessAtBase.map((v) => v.toFixed(3)).join(", ")}`,
      ).toBeGreaterThanOrEqual(8);
      for (const spec of SURFACE_MATERIALS) {
        const value = roughnessAtBase[spec.id]!;
        expect(value, `${spec.name} roughness floor`).toBeGreaterThanOrEqual(
          spec.roughness[0] - 0.06,
        );
        expect(value, `${spec.name} roughness ceiling`).toBeLessThanOrEqual(
          spec.roughness[1] + 0.06,
        );
      }

      results.dispose();
      arrays.albedoHeight.dispose();
      arrays.normalMaterial.dispose();
    } finally {
      scene.dispose();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(gpuErrors).toEqual([]);
  }, 180_000);
});

describe("every shipped define combination compiles (3-2)", () => {
  it("compiles all twelve triplanar x material-cap x runway variants", async () => {
    // The plugin's WGSL has four independent defines, and a shipping tier
    // selects one combination each. A syntax or type error in a branch no tier
    // exercises during development stays invisible until somebody changes a
    // quality setting — so every combination is compiled here, not just the
    // one the assertion-57 test happens to use.
    const modes: TerrainTriplanarMode[] = ["planar", "biplanar", "triplanar"];
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    try {
      const camera = new FreeCamera("combo-camera", new Vector3(0, 12, -12), scene);
      camera.setTarget(Vector3.Zero());
      scene.activeCamera = camera;
      new HemisphericLight("combo-ambient", Vector3.Up(), scene);
      const arrays = createSurfaceMaterialArrays(scene, PROBE_SEED, 32);

      for (const mode of modes) {
        for (const cap of [2, 3]) {
          for (const runway of [false, true]) {
            const label = `${mode}/${cap}/${runway ? "runway" : "no-runway"}`;
            const material = new PBRMaterial(`combo-${label}`, scene);
            material.metallic = 0;
            material.backFaceCulling = false;
            const plugin = new TerrainSurfacePlugin(material);
            plugin.setArrays(arrays.albedoHeight, arrays.normalMaterial);
            plugin.setSamplingProfile(mode, cap);
            plugin.setRunway(runway ? DEFAULT_AIRPORT : null);
            const mesh = createSplatQuad(
              scene,
              SurfaceMaterial.Rock,
              SurfaceMaterial.Gravel,
              0.3,
            );
            mesh.material = material;
            let ready = false;
            for (let frame = 0; frame < 120 && !ready; frame += 1) {
              engine.beginFrame();
              scene.render();
              engine.endFrame();
              await new Promise((resolve) => setTimeout(resolve, 0));
              ready = material.isReady(mesh);
              if (gpuErrors.length > 0) break;
            }
            expect(ready, `${label} never compiled`).toBe(true);
            expect(gpuErrors, `${label} produced GPU errors`).toEqual([]);
            mesh.dispose(false, false);
            material.dispose(true, false);
          }
        }
      }
      arrays.albedoHeight.dispose();
      arrays.normalMaterial.dispose();
    } finally {
      scene.dispose();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(gpuErrors).toEqual([]);
  }, 300_000);
});

describe("triplanar seam (3-5, assertion 59)", () => {
  it("keeps the projected normal continuous across a ridge", async () => {
    // The failure this catches is the classic one: without per-plane UV sign
    // flips the projection MIRRORS where a normal component changes sign, and
    // every ridge grows a visible reflection seam down its crest. A tent mesh
    // puts that sign flip at a known column, and the crest's rendered
    // discontinuity is compared against the material's own texel-scale
    // variation on the same faces.
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    try {
      const camera = new FreeCamera("ridge-camera", new Vector3(0, 40, 0.001), scene);
      camera.setTarget(Vector3.Zero());
      camera.minZ = 0.5;
      scene.activeCamera = camera;
      const light = new HemisphericLight("ambient", Vector3.Up(), scene);
      light.intensity = 1.4;

      const material = new PBRMaterial("ridge-pbr", scene);
      material.metallic = 0;
      material.roughness = 0.93;
      material.backFaceCulling = false;
      const plugin = new TerrainSurfacePlugin(material);
      const arrays = createSurfaceMaterialArrays(scene, PROBE_SEED, 128);
      plugin.setArrays(arrays.albedoHeight, arrays.normalMaterial);
      plugin.setSamplingProfile("triplanar", 3);
      // Rock on both faces, no secondary: any discontinuity at the crest is
      // the projection's, not the splat's.
      plugin.setDetileWarp(0);

      // A tent running along +Z, crest at x = 0. The two faces have opposite
      // n.x, which is exactly where the per-plane sign flip bites.
      const mesh = new Mesh("ridge", scene);
      const data = new VertexData();
      // The tent's faces must be steeper than TRIPLANAR_SLOPE_THRESHOLD or the
      // projected branch is never entered and this whole test is vacuous — at
      // slope 0.8 the face normal's y is 0.781, giving 1 - |n.y| = 0.219,
      // which is under the 0.22 threshold by a hair. Asserted below.
      const slope = 1.4;
      data.positions = new Float32Array([
        -20, 0, -20, 0, 20 * slope, -20, 20, 0, -20,
        -20, 0, 20, 0, 20 * slope, 20, 20, 0, 20,
      ]);
      const nx = slope / Math.hypot(slope, 1);
      const ny = 1 / Math.hypot(slope, 1);
      expect(
        1 - ny,
        "the tent is too shallow to enter the triplanar branch — this test would be vacuous",
      ).toBeGreaterThan(TRIPLANAR_SLOPE_THRESHOLD + 0.05);
      data.normals = new Float32Array([
        nx, ny, 0, nx, ny, 0, -nx, ny, 0,
        nx, ny, 0, nx, ny, 0, -nx, ny, 0,
      ]);
      const colors = new Float32Array(24);
      for (let vertex = 0; vertex < 6; vertex += 1) {
        colors[vertex * 4] = SurfaceMaterial.Rock;
        colors[vertex * 4 + 1] = SurfaceMaterial.Rock;
        colors[vertex * 4 + 2] = 0;
        colors[vertex * 4 + 3] = -1;
      }
      data.colors = colors;
      data.indices = [0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5];
      data.applyToMesh(mesh, false);
      mesh.useVertexColors = false;
      mesh.material = material;

      for (let frame = 0; frame < 120 && !material.isReady(mesh); frame += 1) {
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(material.isReady(mesh)).toBe(true);

      engine.beginFrame();
      scene.render();
      engine.endFrame();
      const copy = document.createElement("canvas");
      copy.width = CANVAS_SIZE;
      copy.height = CANVAS_SIZE;
      const context = copy.getContext("2d")!;
      context.drawImage(canvas, 0, 0);
      const image = context.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;

      const luminance = (column: number, row: number): number => {
        const at = (row * CANVAS_SIZE + column) * 4;
        return 0.2126 * (image[at] ?? 0)
          + 0.7152 * (image[at + 1] ?? 0)
          + 0.0722 * (image[at + 2] ?? 0);
      };
      // Rows through the middle of the tent, away from its silhouette.
      const rows: number[] = [];
      for (let row = CANVAS_SIZE * 0.35; row < CANVAS_SIZE * 0.65; row += 4) {
        rows.push(Math.floor(row));
      }
      const crest = CANVAS_SIZE / 2;
      let crestStep = 0;
      let interiorStep = 0;
      let interiorSamples = 0;
      for (const row of rows) {
        crestStep += Math.abs(luminance(crest - 1, row) - luminance(crest + 1, row));
        for (let column = crest - 40; column < crest + 40; column += 1) {
          if (Math.abs(column - crest) < 3) continue;
          interiorStep += Math.abs(luminance(column, row) - luminance(column + 2, row));
          interiorSamples += 1;
        }
      }
      const crestMean = crestStep / rows.length;
      const interiorMean = interiorStep / Math.max(1, interiorSamples);
      expect(interiorMean, "the ridge rendered flat — the probe cannot see a seam").toBeGreaterThan(
        0.5,
      );
      // A mirrored projection puts a hard line at the crest; a sign-flipped
      // one leaves it indistinguishable from the material's own variation.
      expect(
        crestMean,
        `crest step ${crestMean.toFixed(2)} vs interior ${interiorMean.toFixed(2)}`,
      ).toBeLessThan(interiorMean * 4 + 6);

      arrays.albedoHeight.dispose();
      arrays.normalMaterial.dispose();
      material.dispose(true, true);
    } finally {
      scene.dispose();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(gpuErrors).toEqual([]);
  }, 180_000);
});

describe("airport SDF transliteration (3-9, assertion 65)", () => {
  it("agrees with the TypeScript to within 1 mm over the airport neighbourhood", async () => {
    // C7: the WGSL is a TRANSLITERATION of roundedRectangleSignedDistance, not
    // a second implementation. The drift this guards against is the one that
    // gave the ocean and the hydrology two different sun discs — and here it
    // would put the painted runway edge somewhere other than where the
    // earthworks graded the ground.
    const airport = DEFAULT_AIRPORT;
    const samples = 256;
    const points: number[] = [];
    const expected: number[] = [];
    let state = 0x2f6e_2b1;
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 4_294_967_296;
    };
    const halfLength = airport.runwayLength * 0.5;
    const halfWidth = airport.runwayWidth * 0.5;
    for (let index = 0; index < samples; index += 1) {
      // Half the sweep straddles the pavement in RUNWAY-LOCAL coordinates —
      // interior, both edges and all four corners — and half spreads wide, so
      // the far-field branch of the SDF is covered too. Sampling a big world
      // square uniformly would have put almost nothing on a 34 m strip.
      const near = index < samples / 2;
      const along = (random() * 2 - 1) * halfLength * (near ? 1.25 : 6);
      const across = (random() * 2 - 1) * halfWidth * (near ? 2.5 : 40);
      const world = runwayToWorld(airport, along, across);
      const x = world.x;
      const z = world.z;
      points.push(x, z);
      const local = worldToRunway(airport, x, z);
      expected.push(roundedRectangleSignedDistance(
        local.along,
        local.across,
        halfLength,
        halfWidth,
      ));
    }

    const input = new StorageBuffer(engine, samples * 2 * 4);
    input.update(new Float32Array(points));
    const output = new StorageBuffer(engine, samples * 4);
    const probeWgsl = /* wgsl */ `
struct RunwayFrame {
  center: vec2f,
  sinHeading: f32,
  cosHeading: f32,
  halfLength: f32,
  halfWidth: f32,
};
@group(0) @binding(0) var<storage, read> points: array<vec2f>;
@group(0) @binding(1) var<storage, read_write> distances: array<f32>;
@group(0) @binding(2) var<uniform> frame: RunwayFrame;

${RUNWAY_SDF_WGSL}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&points)) { return; }
  let local = terrainRunwayLocal(points[id.x], frame.center, frame.sinHeading, frame.cosHeading);
  distances[id.x] = terrainRunwayRoundedRect(local.x, local.y, frame.halfLength, frame.halfWidth);
}
`;
    const uniform = new UniformBuffer(engine, undefined, true, "runway-sdf-frame");
    uniform.addUniform("center", 2);
    uniform.addUniform("sinHeading", 1);
    uniform.addUniform("cosHeading", 1);
    uniform.addUniform("halfLength", 1);
    uniform.addUniform("halfWidth", 1);
    uniform.updateFloat2("center", airport.centerX, airport.centerZ);
    uniform.updateFloat("sinHeading", Math.sin(airport.headingRadians));
    uniform.updateFloat("cosHeading", Math.cos(airport.headingRadians));
    uniform.updateFloat("halfLength", airport.runwayLength * 0.5);
    uniform.updateFloat("halfWidth", airport.runwayWidth * 0.5);
    uniform.update();

    const probe = new ComputeShader("runway-sdf-probe", engine, { computeSource: probeWgsl }, {
      bindingsMapping: {
        points: { group: 0, binding: 0 },
        distances: { group: 0, binding: 1 },
        frame: { group: 0, binding: 2 },
      },
    });
    probe.setStorageBuffer("points", input);
    probe.setStorageBuffer("distances", output);
    probe.setUniformBuffer("frame", uniform);

    engine.runRenderLoop(() => {});
    await probe.dispatchWhenReady(Math.ceil(samples / 64), 1, 1);
    const bytes = await output.read();
    engine.stopRenderLoop();
    const actual = new Float32Array(bytes.buffer, bytes.byteOffset, samples);

    let worst = 0;
    let insideCount = 0;
    for (let index = 0; index < samples; index += 1) {
      worst = Math.max(worst, Math.abs(actual[index]! - expected[index]!));
      if (expected[index]! < 0) insideCount += 1;
    }
    // Non-vacuity: the sweep must actually straddle the pavement boundary.
    expect(insideCount).toBeGreaterThan(4);
    expect(insideCount).toBeLessThan(samples - 4);
    expect(worst, `worst TS/WGSL SDF disagreement ${worst.toFixed(6)} m`).toBeLessThan(1e-3);

    input.dispose();
    output.dispose();
    uniform.dispose();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(gpuErrors).toEqual([]);
  }, 120_000);
});
