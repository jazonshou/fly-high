import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Constants } from "@babylonjs/core/Engines/constants";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import { createSurfaceMaterialArrays } from "@/src/render/webgpu/terrain/MaterialArrayUpload";
import {
  TERRAIN_CHANNEL_TEXTURES,
  TERRAIN_CHANNEL_TEXTURE_COUNT,
  TerrainPageAtlas,
} from "@/src/render/webgpu/terrain/TerrainPageAtlas";
import {
  buildTerrainNodeGrid,
  createTerrainNodeBuffers,
  TERRAIN_PROVISIONAL_AXIS_FROM_HEIGHT,
  writeTerrainNodeBuffers,
  type TerrainNode,
} from "@/src/render/webgpu/terrain/TerrainQuadtree";
import {
  TERRAIN_HEIGHT_SLOT_EDGE,
  TERRAIN_NODE_ATTRIBUTE_A,
  TERRAIN_NODE_ATTRIBUTE_B,
  TERRAIN_NODE_ATTRIBUTE_STRIDE,
  TERRAIN_NODE_GRID_RESOLUTION,
  TERRAIN_PROVISIONAL_AXIS,
  terrainNodeSpanMeters,
} from "@/src/render/webgpu/terrain/TerrainSpineContract";
import { TerrainSurfacePlugin } from "@/src/render/webgpu/terrain/TerrainSurfacePlugin";
import { SURFACE_MATERIAL_COUNT } from "@/src/render/webgpu/terrain/surfaceMaterials";
import { WORLD_PAGE_GUTTER } from "@/src/render/webgpu/world/pageGeometry";
import { createWorldPageAddress } from "@/src/render/webgpu/world/pageKey";
import "@babylonjs/core/Meshes/thinInstanceMesh";

/**
 * Gate `4.5-A`'s two on-adapter assertions — 109 and 110.
 *
 * Both cover halves of the same reported defect ("splotches of solid colour
 * instead of coherent terrain") that no CPU test can see, because both are
 * properties of what a SAMPLER and a VERTEX STAGE do rather than of any number
 * the CPU computes.
 */

const CANVAS_SIZE = 256;

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
  // A readback resolves on `onEndFrameObservable`, so something has to be
  // ending frames.
  engine.runRenderLoop(() => {});
  const device = (engine as unknown as { _device: GPUDevice })._device;
  device.addEventListener("uncapturederror", (event) => {
    gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
  });
}, 60_000);

afterAll(() => {
  engine?.stopRenderLoop();
  engine?.dispose();
  canvas?.remove();
});

/**
 * Write two known primary ids into adjacent texels of a channel-atlas texture
 * and sample it back at the midpoint through the atlas's OWN sampler.
 */
const SPLAT_PROBE_WGSL = /* wgsl */ `
@group(0) @binding(0) var splatTarget: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<storage, read> seeds: array<vec4f>;

@compute @workgroup_size(1, 1, 1)
fn writeIds(@builtin(global_invocation_id) id: vec3<u32>) {
  textureStore(splatTarget, vec2i(i32(id.x), 0), seeds[id.x]);
}
`;

const SPLAT_SAMPLE_WGSL = /* wgsl */ `
@group(0) @binding(0) var splatSourceSampler: sampler;
@group(0) @binding(1) var splatSource: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> sampled: array<vec4f>;
@group(0) @binding(3) var<storage, read> probeUv: array<vec4f>;

@compute @workgroup_size(1, 1, 1)
fn sampleIds(@builtin(global_invocation_id) id: vec3<u32>) {
  sampled[id.x] = textureSampleLevel(
    splatSource, splatSourceSampler, probeUv[id.x].xy, 0.0);
}
`;

describe("terrain splat filtering and the provisional fallback (4.5-A)", () => {
  it("assertion 109: adjacent primary ids sample to an intermediate value", async () => {
    // The defect: the channel atlas was created NEAREST, so `3-0`'s whole
    // ecotone-axis ordering — the reason neighbouring ids are neighbouring
    // MATERIALS — bought nothing, and even a fully resident page rendered as
    // hard-edged single-material blocks at the splat's 2·2^L m texel grid.
    const scene = new Scene(engine);
    try {
      const profile = { ...resolveWebGpuQualityProfile("medium", "balanced"), channelAtlasSlots: 4 };
      const atlas = new TerrainPageAtlas(scene, profile, {
        kind: "channel",
        worldRevision: "splat-filter-test",
        textureCount: TERRAIN_CHANNEL_TEXTURE_COUNT,
      });
      const target = atlas.texture(TERRAIN_CHANNEL_TEXTURES.splatIdLo)!;
      expect(target).not.toBeNull();
      // The sampling mode IS the assertion's subject, so state it up front.
      expect(target.samplingMode).toBe(Texture.BILINEAR_SAMPLINGMODE);

      const scale = 1 / (SURFACE_MATERIAL_COUNT - 1);
      const lowId = 1;
      const highId = 4;
      const seeds = new Float32Array([
        lowId * scale, 0, 0, 1,
        highId * scale, 0, 0, 1,
      ]);
      const seedBuffer = new StorageBuffer(engine, seeds.byteLength);
      seedBuffer.update(new Uint8Array(seeds.buffer));
      const writer = new ComputeShader("splat-write", engine, {
        computeSource: SPLAT_PROBE_WGSL,
      }, {
        entryPoint: "writeIds",
        bindingsMapping: {
          splatTarget: { group: 0, binding: 0 },
          seeds: { group: 0, binding: 1 },
        },
      });
      writer.setStorageTexture("splatTarget", target);
      writer.setStorageBuffer("seeds", seedBuffer);
      await writer.dispatchWhenReady(2, 1, 1);

      // Sample at the exact midpoint between texel 0 and texel 1, plus each
      // texel centre as controls.
      const edge = atlas.atlasEdge;
      const uv = new Float32Array([
        0.5 / edge, 0.5 / edge, 0, 0,
        1.0 / edge, 0.5 / edge, 0, 0,
        1.5 / edge, 0.5 / edge, 0, 0,
      ]);
      const uvBuffer = new StorageBuffer(engine, uv.byteLength);
      uvBuffer.update(new Uint8Array(uv.buffer));
      const results = new StorageBuffer(engine, 3 * 16);
      const sampler = new ComputeShader("splat-sample", engine, {
        computeSource: SPLAT_SAMPLE_WGSL,
      }, {
        entryPoint: "sampleIds",
        bindingsMapping: {
          splatSource: { group: 0, binding: 1 },
          sampled: { group: 0, binding: 2 },
          probeUv: { group: 0, binding: 3 },
        },
      });
      // bindSampler = true: the atlas's own sampling mode is what is under
      // test, not one this test chooses.
      sampler.setTexture("splatSource", target, true);
      sampler.setStorageBuffer("sampled", results);
      sampler.setStorageBuffer("probeUv", uvBuffer);
      await sampler.dispatchWhenReady(3, 1, 1);
      const view = await results.read(0, 3 * 16);
      const read = new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + 3 * 16));
      const ids = [read[0]!, read[4]!, read[8]!].map((value) => value / scale);

      atlas.dispose();
      seedBuffer.dispose();
      uvBuffer.dispose();
      results.dispose();

      // The two texel centres read their own ids...
      expect(ids[0]).toBeCloseTo(lowId, 1);
      expect(ids[2]).toBeCloseTo(highId, 1);
      // ...and the midpoint reads STRICTLY between them. Under NEAREST it
      // read one or the other, which is the hard block edge.
      expect(ids[1], "the midpoint did not blend — the atlas is still NEAREST")
        .toBeGreaterThan(lowId + 0.5);
      expect(ids[1]).toBeLessThan(highId - 0.5);
      expect(ids[1]).toBeCloseTo((lowId + highId) / 2, 0);
    } finally {
      scene.dispose();
    }
    expect(gpuErrors).toEqual([]);
  }, 120_000);

  it("assertion 110: the provisional fallback varies across a single node", async () => {
    // The other half of the reported "splotches": where a page holds no
    // channel slot, the surface fell back to ONE packed material constant per
    // NODE — a solid block up to `512·2^L` m across, worst exactly where
    // streaming is worst. `4.5-A3` walks the ecotone axis per VERTEX from the
    // height this shader has just displaced to; this renders one node over a
    // known height ramp and asserts the ground is not one colour.
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    try {
      const level = 0;
      const span = terrainNodeSpanMeters(level);
      // ORTHOGRAPHIC and straight down over the node, so a sampled row is a
      // clean traverse of the ground rather than a perspective sweep over a
      // surface whose own height varies by 2.4 km.
      const camera = new FreeCamera(
        "fallback-camera", new Vector3(span * 0.5, 6_000, span * 0.5), scene);
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      camera.orthoLeft = -span * 0.5;
      camera.orthoRight = span * 0.5;
      camera.orthoBottom = -span * 0.5;
      camera.orthoTop = span * 0.5;
      camera.upVector = new Vector3(0, 0, 1);
      camera.setTarget(new Vector3(span * 0.5, 0, span * 0.5));
      camera.minZ = 1;
      camera.maxZ = 12_000;
      scene.activeCamera = camera;
      const light = new HemisphericLight("ambient", Vector3.Up(), scene);
      light.intensity = 1.4;

      // A height ramp across the 32 texels ONE NODE samples — not across the
      // whole 264-texel slot. A node spans 32 quads of its page starting at
      // the gutter, so a ramp over the slot would sweep only an eighth of its
      // range under the node and make the assertion nearly vacuous.
      const edge = TERRAIN_HEIGHT_SLOT_EDGE;
      const quads = TERRAIN_NODE_GRID_RESOLUTION - 1;
      const heights = new Float32Array(edge * edge);
      for (let row = 0; row < edge; row += 1) {
        for (let column = 0; column < edge; column += 1) {
          const along = Math.min(1, Math.max(0, (column - WORLD_PAGE_GUTTER) / quads));
          heights[row * edge + column] = along * 2_400;
        }
      }
      const heightAtlas = RawTexture.CreateRTexture(
        heights, edge, edge, scene, false, false,
        Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT,
      );

      const material = new PBRMaterial("fallback-pbr", scene);
      material.metallic = 0;
      material.roughness = 0.93;
      material.backFaceCulling = false;
      const plugin = new TerrainSurfacePlugin(material);
      const arrays = createSurfaceMaterialArrays(scene, "fallback-probe", 128);
      plugin.setArrays(arrays.albedoHeight, arrays.normalMaterial);
      plugin.setSamplingProfile("biplanar", 3);
      plugin.setDetileWarp(0);
      // Sea level 0, so the walk is the height itself. No channel atlas is
      // bound at all: this is the co-residency fallback, by construction.
      plugin.setSeason(171, 45, 0);
      plugin.setHeightAtlas(heightAtlas, {
        atlasEdge: edge,
        slotEdge: edge,
        gutter: WORLD_PAGE_GUTTER,
        gridEdge: 1,
      });

      const mesh = new Mesh("fallback-node", scene);
      buildTerrainNodeGrid().applyToMesh(mesh, false);
      mesh.material = material;
      mesh.alwaysSelectAsActiveMesh = true;

      const node: TerrainNode = Object.freeze({
        address: createWorldPageAddress(level, 0, 0),
        subNodeX: 0,
        subNodeZ: 0,
        originX: 0,
        originZ: 0,
        spanMeters: span,
        level,
        morphK: 0,
        maxDeviationMeters: 0,
        distanceMeters: span,
      });

      const render = async (provisionalAxis: number): Promise<number[]> => {
        const buffers = writeTerrainNodeBuffers({
          nodes: [node],
          originX: 0,
          originZ: 0,
          slotFor: (address) => (address.level === level ? 0 : -1),
          channelSlotFor: () => -1,
          provisionalAxisFor: () => provisionalAxis,
        }, createTerrainNodeBuffers(1));
        mesh.thinInstanceSetBuffer("matrix", buffers.matrices, 16, false);
        mesh.thinInstanceSetBuffer(
          TERRAIN_NODE_ATTRIBUTE_A, buffers.laneA, TERRAIN_NODE_ATTRIBUTE_STRIDE, false);
        mesh.thinInstanceSetBuffer(
          TERRAIN_NODE_ATTRIBUTE_B, buffers.laneB, TERRAIN_NODE_ATTRIBUTE_STRIDE, false);
        mesh.thinInstanceCount = 1;
        for (let frame = 0; frame < 240 && !material.isReady(mesh); frame += 1) {
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
        const context = copy.getContext("2d", { willReadFrequently: true })!;
        context.drawImage(canvas, 0, 0);
        const image = context.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;
        // One row through the middle of the node, sampled across it.
        const row = Math.floor(CANVAS_SIZE * 0.5);
        const samples: number[] = [];
        for (let column = 8; column < CANVAS_SIZE - 8; column += 8) {
          const at = (row * CANVAS_SIZE + column) * 4;
          samples.push(0.2126 * (image[at] ?? 0)
            + 0.7152 * (image[at + 1] ?? 0)
            + 0.0722 * (image[at + 2] ?? 0));
        }
        return samples;
      };

      const derived = await render(TERRAIN_PROVISIONAL_AXIS_FROM_HEIGHT);
      const forced = await render(TERRAIN_PROVISIONAL_AXIS.fallbackAxis);

      heightAtlas.dispose();
      arrays.albedoHeight.dispose();
      arrays.normalMaterial.dispose();
      material.dispose(true, true);
      mesh.dispose(false, false);

      const spread = (values: readonly number[]): number =>
        Math.max(...values) - Math.min(...values);
      console.log(
        `110: derived spread ${spread(derived).toFixed(1)}, `
        + `forced spread ${spread(forced).toFixed(1)}`,
      );
      // Derived per vertex, the node walks the axis: the rendered ground
      // varies across it.
      expect(spread(derived), "the per-vertex fallback rendered one flat colour")
        .toBeGreaterThan(12);
      // Forced to the CPU's grass guard, it is one material — which is
      // exactly what the OLD per-node constant did everywhere, and the
      // non-vacuity control for the assertion above.
      expect(spread(forced), "the forced-axis control was not flat")
        .toBeLessThan(spread(derived) * 0.6);
    } finally {
      scene.dispose();
    }
    expect(gpuErrors).toEqual([]);
  }, 180_000);
});

describe("displaced position reaches the fragment stage (4.5-D3)", () => {
  it("assertion 83b: vPositionW carries the DISPLACED height, not the flat one", async () => {
    // `4-4` displaces at `CUSTOM_VERTEX_UPDATE_POSITION` rather than at
    // `CUSTOM_VERTEX_UPDATE_WORLDPOS` for exactly this reason: `pbr.vertex`
    // assigns `vPositionW` before the WORLDPOS marker, so displacing there
    // moves the rasterised geometry and leaves `vPositionW` at the UNDISPLACED
    // height. Aerial perspective, cloud shadows and the triplanar projection
    // all read it, so the symptom is haze and cloud shadows sitting at the
    // wrong altitude on every slope — a lighting bug that is not one.
    //
    // Read back through the shader's own SUBMERGED term, which is a step in
    // `vPositionW.y` at sea level with a ~2 m band: over a 0-2,400 m ramp
    // across one node, that band is under a texel wide, so the column where
    // the ground stops being wet IS a fragment-stage readback of
    // `vPositionW.y`. Undisplaced, every fragment would read y = 0 and the
    // whole node would be submerged — which is the control below.
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    try {
      const level = 0;
      const span = terrainNodeSpanMeters(level);
      const camera = new FreeCamera(
        "slope-camera", new Vector3(span * 0.5, 6_000, span * 0.5), scene);
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      camera.orthoLeft = -span * 0.5;
      camera.orthoRight = span * 0.5;
      camera.orthoBottom = -span * 0.5;
      camera.orthoTop = span * 0.5;
      camera.upVector = new Vector3(0, 0, 1);
      camera.setTarget(new Vector3(span * 0.5, 0, span * 0.5));
      camera.minZ = 1;
      camera.maxZ = 12_000;
      scene.activeCamera = camera;
      const light = new HemisphericLight("ambient", Vector3.Up(), scene);
      light.intensity = 1.4;

      const edge = TERRAIN_HEIGHT_SLOT_EDGE;
      const quads = TERRAIN_NODE_GRID_RESOLUTION - 1;
      const peak = 2_400;
      const heights = new Float32Array(edge * edge);
      for (let row = 0; row < edge; row += 1) {
        for (let column = 0; column < edge; column += 1) {
          // Over the 32 texels the node samples, starting at the gutter.
          const along = Math.min(1, Math.max(0, (column - WORLD_PAGE_GUTTER) / quads));
          heights[row * edge + column] = along * peak;
        }
      }
      const heightAtlas = RawTexture.CreateRTexture(
        heights, edge, edge, scene, false, false,
        Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT,
      );

      const material = new PBRMaterial("slope-pbr", scene);
      material.metallic = 0;
      material.roughness = 0.93;
      material.backFaceCulling = false;
      const plugin = new TerrainSurfacePlugin(material);
      const arrays = createSurfaceMaterialArrays(scene, "slope-probe", 128);
      plugin.setArrays(arrays.albedoHeight, arrays.normalMaterial);
      plugin.setSamplingProfile("biplanar", 3);
      plugin.setDetileWarp(0);
      plugin.setSeason(171, 45, 0);
      plugin.setHeightAtlas(heightAtlas, {
        atlasEdge: edge,
        slotEdge: edge,
        gutter: WORLD_PAGE_GUTTER,
        gridEdge: 1,
      });

      const mesh = new Mesh("slope-node", scene);
      buildTerrainNodeGrid().applyToMesh(mesh, false);
      mesh.material = material;
      mesh.alwaysSelectAsActiveMesh = true;
      const node: TerrainNode = Object.freeze({
        address: createWorldPageAddress(level, 0, 0),
        subNodeX: 0,
        subNodeZ: 0,
        originX: 0,
        originZ: 0,
        spanMeters: span,
        level,
        morphK: 0,
        maxDeviationMeters: 0,
        distanceMeters: span,
      });
      // ONE material across the whole node, so the only thing that varies with
      // x is the submerged term — i.e. `vPositionW.y`.
      const buffers = writeTerrainNodeBuffers({
        nodes: [node],
        originX: 0,
        originZ: 0,
        slotFor: (address) => (address.level === level ? 0 : -1),
        channelSlotFor: () => -1,
        provisionalAxisFor: () => 4,
      }, createTerrainNodeBuffers(1));
      mesh.thinInstanceSetBuffer("matrix", buffers.matrices, 16, false);
      mesh.thinInstanceSetBuffer(
        TERRAIN_NODE_ATTRIBUTE_A, buffers.laneA, TERRAIN_NODE_ATTRIBUTE_STRIDE, false);
      mesh.thinInstanceSetBuffer(
        TERRAIN_NODE_ATTRIBUTE_B, buffers.laneB, TERRAIN_NODE_ATTRIBUTE_STRIDE, false);
      mesh.thinInstanceCount = 1;

      const sample = async (seaLevelMeters: number): Promise<number[]> => {
        plugin.setSeason(171, 45, seaLevelMeters);
        for (let frame = 0; frame < 240 && !material.isReady(mesh); frame += 1) {
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
        const context = copy.getContext("2d", { willReadFrequently: true })!;
        context.drawImage(canvas, 0, 0);
        const image = context.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;
        const row = Math.floor(CANVAS_SIZE * 0.5);
        const values: number[] = [];
        for (let column = 8; column < CANVAS_SIZE - 8; column += 1) {
          const at = (row * CANVAS_SIZE + column) * 4;
          values.push(0.2126 * (image[at] ?? 0)
            + 0.7152 * (image[at + 1] ?? 0)
            + 0.0722 * (image[at + 2] ?? 0));
        }
        return values;
      };

      const mean = (values: readonly number[]): number =>
        values.reduce((total, value) => total + value, 0) / values.length;

      // Two references, so the assertion calibrates itself: sea level under
      // the whole ramp (nothing submerged) and over all of it (everything).
      const dry = await sample(-1_000);
      const wet = await sample(peak + 1_000);
      // …then at the ramp's midpoint. `vPositionW.y` is what decides which of
      // the two each fragment gets.
      const split = await sample(peak * 0.5);

      const half = Math.floor(split.length / 2);
      const dryMean = mean(dry);
      const wetMean = mean(wet);
      const leftMean = mean(split.slice(0, half - 16));
      const rightMean = mean(split.slice(half + 16));
      console.log(
        `83b: dry ${dryMean.toFixed(1)}, wet ${wetMean.toFixed(1)}, `
        + `split left ${leftMean.toFixed(1)} right ${rightMean.toFixed(1)}`,
      );

      // Non-vacuity: the submerged term has to do something at all.
      expect(
        Math.abs(dryMean - wetMean),
        "the submerged term never fired — this assertion would be vacuous",
      ).toBeGreaterThan(8);
      // The half of the node BELOW the ramp's midpoint reads as the wet
      // reference and the half above reads as the dry one. Undisplaced,
      // `vPositionW.y` would be 0 for every fragment and both halves would
      // read wet.
      const towardWet = Math.abs(leftMean - wetMean) < Math.abs(leftMean - dryMean);
      const towardDry = Math.abs(rightMean - dryMean) < Math.abs(rightMean - wetMean);
      expect(towardWet, "the low half of the ramp did not read as submerged").toBe(true);
      expect(towardDry, "the high half of the ramp did not read as dry").toBe(true);

      heightAtlas.dispose();
      arrays.albedoHeight.dispose();
      arrays.normalMaterial.dispose();
      material.dispose(true, true);
      mesh.dispose(false, false);
    } finally {
      scene.dispose();
    }
    expect(gpuErrors).toEqual([]);
  }, 180_000);
});


