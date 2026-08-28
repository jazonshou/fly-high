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
import { createSurfaceMaterialArrays } from "@/src/render/webgpu/terrain/MaterialArrayUpload";
import {
  buildTerrainNodeGrid,
  createTerrainNodeBuffers,
  packTerrainCornerMorphs,
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
import {
  TERRAIN_BOUNDARY_MORPH_WGSL,
  TERRAIN_SPARSE_SPLAT_GATHER_WGSL,
  TerrainSurfacePlugin,
} from "@/src/render/webgpu/terrain/TerrainSurfacePlugin";
import {
  SURFACE_MATERIAL_COUNT,
  SurfaceMaterial,
} from "@/src/render/webgpu/terrain/surfaceMaterials";
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

/** The shipping sparse gather, wrapped only with bindings and probe outputs. */
const SPLAT_GATHER_PROBE_WGSL = /* wgsl */ `
@group(0) @binding(0) var terrainSplatId: texture_2d<f32>;
@group(0) @binding(1) var terrainSplatWeightLo: texture_2d<f32>;
@group(0) @binding(2) var terrainSplatWeightHi: texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> probeResults: array<vec4f>;

${TERRAIN_SPARSE_SPLAT_GATHER_WGSL}

@compute @workgroup_size(1, 1, 1)
fn probeSparseGather(@builtin(global_invocation_id) id: vec3<u32>) {
  let positions = array<vec2f, 6>(
    // Original categorical-boundary controls.
    vec2f(0.0, 0.0), vec2f(0.5, 0.0), vec2f(1.0, 0.0),
    // All ids, one id crossing lanes/corners, then an exact top-two tie.
    vec2f(3.23, 0.67), vec2f(6.23, 0.67), vec2f(9.5, 0.5));
  let blends = array<f32, 6>(0.0, 0.0, 0.0, 0.0, 0.37, 1.0);
  probeResults[id.x] = vec4f(
    terrainSurfaceSparseSplat(positions[id.x], blends[id.x]), 1.0);
}
`;

const SAME_EDGE_A = packTerrainCornerMorphs([0.2, 0.75, 0.4, 0.75]);
const SAME_EDGE_B = packTerrainCornerMorphs([0.75, 0.9, 0.75, 0.1]);
const FINE_EDGE = packTerrainCornerMorphs([1, 1, 1, 1]);
const COARSE_EDGE = packTerrainCornerMorphs([0, 0, 0, 0]);

/** Exact shipping decoder exercised over two independent node records. */
const BOUNDARY_MORPH_PROBE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> probeResults: array<vec4f>;

${TERRAIN_BOUNDARY_MORPH_WGSL}

fn probeNormal(gradient: vec2f) -> vec3f {
  return normalize(vec3f(-gradient.x, 1.0, -gradient.y));
}

@compute @workgroup_size(33, 1, 1)
fn probeBoundaryMorph(@builtin(local_invocation_id) id: vec3<u32>) {
  let index = id.x;
  let grid = f32(index);
  let even = floor(grid * 0.5) * 2.0;

  // Same-level neighbours retain deliberately different interior K but must
  // execute one identical boundary curve from two separately packed records.
  let sameA = terrainSurfaceVertexMorphK(
    0.07, ${SAME_EDGE_A}.0, vec2f(32.0, grid), true);
  let sameB = terrainSurfaceVertexMorphK(
    0.93, ${SAME_EDGE_B}.0, vec2f(0.0, grid), true);
  let samePositionA = grid + (even - grid) * sameA;
  let samePositionB = grid + (even - grid) * sameB;
  let sameHeightA = mix(10.0 + grid, 31.0 + grid, sameA);
  let sameHeightB = mix(10.0 + grid, 31.0 + grid, sameB);
  let sameNormalA = probeNormal(mix(vec2f(0.2, -0.1), vec2f(-0.4, 0.3), sameA));
  let sameNormalB = probeNormal(mix(vec2f(0.2, -0.1), vec2f(-0.4, 0.3), sameB));
  probeResults[index] = vec4f(
    abs(sameA - sameB),
    abs(samePositionA - samePositionB),
    abs(sameHeightA - sameHeightB),
    length(sameNormalA - sameNormalB));

  // Across L/L+1, each even fine vertex maps to one coarse vertex. Fine K=1
  // and coarse K=0 select the same level-L+1 height and gradient endpoint.
  var crossError = vec4f(0.0);
  if ((index & 1u) == 0u) {
    let fineK = terrainSurfaceVertexMorphK(
      0.17, ${FINE_EDGE}.0, vec2f(32.0, grid), true);
    let coarseGrid = grid * 0.5;
    let coarseK = terrainSurfaceVertexMorphK(
      0.81, ${COARSE_EDGE}.0, vec2f(0.0, coarseGrid), true);
    let finePosition = grid + (even - grid) * fineK;
    let coarsePosition = coarseGrid * 2.0;
    let fineHeight = mix(10.0 + grid, 31.0 + grid, fineK);
    let coarseHeight = mix(31.0 + grid, 52.0 + grid, coarseK);
    let sharedGradient = vec2f(-0.4, 0.3);
    let fineNormal = probeNormal(mix(vec2f(0.2, -0.1), sharedGradient, fineK));
    let coarseNormal = probeNormal(mix(sharedGradient, vec2f(0.6, 0.8), coarseK));
    crossError = vec4f(
      abs(1.0 - fineK) + abs(coarseK),
      abs(finePosition - coarsePosition),
      abs(fineHeight - coarseHeight),
      length(fineNormal - coarseNormal));
  }
  probeResults[33u + index] = crossError;
}
`;

describe("terrain splat filtering and the provisional fallback (4.5-A)", () => {
  it("assertion 109: categorical ids remain real while sparse weights filter", async () => {
    // The old oracle sampled the id atlas bilinearly and REQUIRED a made-up
    // numeric id at a 1 -> 4 boundary. Shipping does the opposite: exact
    // textureLoad ids, bilinear corner weights, sparse accumulation by id.
    // Execute the exact exported shipping WGSL on the adapter so this test
    // cannot pass by validating a test-only sampler path.
    const scene = new Scene(engine);
    const lowId = 1;
    const highId = 4;
    const encodeId = (id: number): number =>
      Math.round((id / (SURFACE_MATERIAL_COUNT - 1)) * 255);
    const decodeId = (encoded: number): number =>
      Math.min(
        SURFACE_MATERIAL_COUNT - 1,
        Math.max(0, Math.floor((encoded / 255) * (SURFACE_MATERIAL_COUNT - 1) + 0.5)),
      );
    const textureWidth = 11;
    const textureHeight = 2;
    const ids = new Uint8Array(textureWidth * textureHeight * 4);
    const weightsLo = new Uint8Array(ids.length);
    const weightsHi = new Uint8Array(ids.length);
    const writeTexel = (
      x: number,
      y: number,
      materialIds: readonly number[],
      lowWeights: readonly number[],
      highWeights: readonly number[],
    ): void => {
      const offset = (y * textureWidth + x) * 4;
      for (let lane = 0; lane < 4; lane += 1) {
        ids[offset + lane] = encodeId(materialIds[lane]!);
        weightsLo[offset + lane] = lowWeights[lane]!;
        weightsHi[offset + lane] = highWeights[lane]!;
      }
    };

    // Preserve the original 1 -> 4 categorical boundary controls at x 0..1.
    for (let y = 0; y < 2; y += 1) {
      writeTexel(0, y, [lowId, 0, 0, 0], [255, 0, 0, 0], [255, 0, 0, 0]);
      writeTexel(1, y, [highId, 0, 0, 0], [255, 0, 0, 0], [255, 0, 0, 0]);
    }

    // Every encoded material id participates with a non-zero weight.
    writeTexel(3, 0, [0, 1, 2, 3], [255, 128, 64, 32], [19, 29, 39, 49]);
    writeTexel(4, 0, [4, 5, 6, 7], [220, 170, 120, 70], [59, 69, 79, 89]);
    writeTexel(3, 1, [8, 9, 0, 1], [210, 160, 110, 60], [99, 109, 119, 129]);
    writeTexel(4, 1, [2, 3, 4, 5], [200, 150, 100, 50], [139, 149, 159, 169]);

    // Material 7 moves from x to y to z to w across the four corners. Both
    // seasonal atlases contribute at blend 0.37, but every addition must land
    // in the same scalar accumulator.
    writeTexel(6, 0, [7, 0, 0, 0], [100, 0, 0, 0], [200, 0, 0, 0]);
    writeTexel(7, 0, [0, 7, 0, 0], [0, 110, 0, 0], [0, 210, 0, 0]);
    writeTexel(6, 1, [0, 0, 7, 0], [0, 0, 120, 0], [0, 0, 220, 0]);
    writeTexel(7, 1, [0, 0, 0, 7], [0, 0, 0, 130], [0, 0, 0, 230]);

    // Equal material-2/material-5 weights in every corner form an exact tie.
    // Ascending strict-`>` selection must keep 2 primary and 5 secondary.
    for (let y = 0; y < 2; y += 1) {
      for (let x = 9; x <= 10; x += 1) {
        writeTexel(x, y, [2, 5, 9, 9], [31, 47, 0, 0], [255, 255, 0, 0]);
      }
    }

    for (let materialId = 0; materialId < SURFACE_MATERIAL_COUNT; materialId += 1) {
      expect(decodeId(encodeId(materialId))).toBe(materialId);
    }

    const referenceGather = (
      baseX: number,
      fraction: readonly [number, number],
      blend: number,
    ): readonly [number, number, number] => {
      const cornerWeights = [
        (1 - fraction[0]) * (1 - fraction[1]),
        fraction[0] * (1 - fraction[1]),
        (1 - fraction[0]) * fraction[1],
        fraction[0] * fraction[1],
      ];
      const coordinates = [
        [baseX, 0], [baseX + 1, 0], [baseX, 1], [baseX + 1, 1],
      ] as const;
      const accumulated = Array.from<number>({ length: SURFACE_MATERIAL_COUNT }).fill(0);
      for (let corner = 0; corner < 4; corner += 1) {
        const [x, y] = coordinates[corner]!;
        const offset = (y * textureWidth + x) * 4;
        for (let lane = 0; lane < 4; lane += 1) {
          const materialId = decodeId(ids[offset + lane]!);
          const low = weightsLo[offset + lane]! / 255;
          const high = weightsHi[offset + lane]! / 255;
          const weight = (low * (1 - blend) + high * blend) * cornerWeights[corner]!;
          accumulated[materialId] = accumulated[materialId]! + weight;
        }
      }
      let primaryId = 0;
      let secondaryId = 0;
      let primaryWeight = -1;
      let secondaryWeight = -1;
      for (let materialId = 0; materialId < SURFACE_MATERIAL_COUNT; materialId += 1) {
        const weight = accumulated[materialId]!;
        if (weight > primaryWeight) {
          secondaryId = primaryId;
          secondaryWeight = primaryWeight;
          primaryId = materialId;
          primaryWeight = weight;
        } else if (weight > secondaryWeight) {
          secondaryId = materialId;
          secondaryWeight = weight;
        }
      }
      secondaryWeight = Math.max(secondaryWeight, 0);
      return [
        primaryId,
        secondaryId,
        secondaryWeight / Math.max(1e-6, Math.max(primaryWeight, 0) + secondaryWeight),
      ];
    };
    const idTexture = RawTexture.CreateRGBATexture(
      ids, textureWidth, textureHeight, scene, false, false, Texture.NEAREST_SAMPLINGMODE,
    );
    const weightLo = RawTexture.CreateRGBATexture(
      weightsLo,
      textureWidth,
      textureHeight,
      scene,
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
    );
    const weightHi = RawTexture.CreateRGBATexture(
      weightsHi,
      textureWidth,
      textureHeight,
      scene,
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
    );
    const results = new StorageBuffer(engine, 6 * 16);
    try {
      const probe = new ComputeShader("shipping-sparse-splat-probe", engine, {
        computeSource: SPLAT_GATHER_PROBE_WGSL,
      }, {
        entryPoint: "probeSparseGather",
        bindingsMapping: {
          terrainSplatId: { group: 0, binding: 0 },
          terrainSplatWeightLo: { group: 0, binding: 1 },
          terrainSplatWeightHi: { group: 0, binding: 2 },
          probeResults: { group: 0, binding: 3 },
        },
      });
      probe.setTexture("terrainSplatId", idTexture, false);
      probe.setTexture("terrainSplatWeightLo", weightLo, false);
      probe.setTexture("terrainSplatWeightHi", weightHi, false);
      probe.setStorageBuffer("probeResults", results);
      await probe.dispatchWhenReady(6, 1, 1);
      const view = await results.read(0, 6 * 16);
      const read = new Float32Array(
        view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
      );
      const controlLow = read.slice(0, 4);
      const boundary = read.slice(4, 8);
      const controlHigh = read.slice(8, 12);

      expect(controlLow[0]).toBe(lowId);
      expect(controlLow[2]).toBe(0);
      expect(controlHigh[0]).toBe(highId);
      expect(controlHigh[2]).toBe(0);
      expect(new Set([boundary[0], boundary[1]])).toEqual(new Set([lowId, highId]));
      expect(boundary[2]).toBeCloseTo(0.5, 5);
      expect([boundary[0], boundary[1]]).not.toContain(2);
      expect([boundary[0], boundary[1]]).not.toContain(3);

      const extendedReferences = [
        referenceGather(3, [0.23, 0.67], 0),
        referenceGather(6, [0.23, 0.67], 0.37),
        referenceGather(9, [0.5, 0.5], 1),
      ];
      for (let probeIndex = 0; probeIndex < extendedReferences.length; probeIndex += 1) {
        const expected = extendedReferences[probeIndex]!;
        const actual = read.slice((probeIndex + 3) * 4, (probeIndex + 4) * 4);
        expect(actual[0], `probe ${probeIndex} primary id`).toBe(expected[0]);
        expect(actual[1], `probe ${probeIndex} secondary id`).toBe(expected[1]);
        expect(actual[2], `probe ${probeIndex} secondary share`).toBeCloseTo(expected[2], 5);
      }
      expect(read.slice(16, 20)[0]).toBe(7);
      expect(read.slice(16, 20)[2]).toBe(0);
      expect(read.slice(20, 24)[0]).toBe(2);
      expect(read.slice(20, 24)[1]).toBe(5);
      expect(read.slice(20, 24)[2]).toBeCloseTo(0.5, 6);
    } finally {
      idTexture.dispose();
      weightLo.dispose();
      weightHi.dispose();
      results.dispose();
      scene.dispose();
    }
    expect(gpuErrors).toEqual([]);
  }, 120_000);

  it("keeps same-level and L/L+1 node boundaries identical on the adapter", async () => {
    const results = new StorageBuffer(engine, 66 * 16);
    try {
      const probe = new ComputeShader("shipping-boundary-morph-probe", engine, {
        computeSource: BOUNDARY_MORPH_PROBE_WGSL,
      }, {
        entryPoint: "probeBoundaryMorph",
        bindingsMapping: {
          probeResults: { group: 0, binding: 0 },
        },
      });
      probe.setStorageBuffer("probeResults", results);
      await probe.dispatchWhenReady(1, 1, 1);
      const view = await results.read(0, 66 * 16);
      const read = new Float32Array(
        view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
      );
      let largestError = 0;
      for (const value of read) largestError = Math.max(largestError, Math.abs(value));
      expect(largestError).toBeLessThanOrEqual(1e-6);
    } finally {
      results.dispose();
    }
    expect(gpuErrors).toEqual([]);
  }, 120_000);

  it("assertion 110: the coarse fallback is continuous and ignores categorical overrides", async () => {
    // Coarse/missing channel pages cannot safely classify 8..256 m texels.
    // The retired altitude walk merely exchanged solid nodes for kilometre-
    // scale Grass→Floor→Shrub→Rock palette lobes. Shipping now keeps one Grass
    // macro base and derives continuous alpine Rock/Snow cover from elevation,
    // slope and stable world noise. Render a 2.4 km ramp and prove both that
    // the obsolete categorical lane cannot change it and that the macro cover
    // still varies smoothly rather than collapsing to one flat colour.
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    try {
      // At level 0 this 2,400 m rise occurs over only 64 m, so the shipping
      // fragment-derived slope candidate correctly saturates to Rock and
      // masks BOTH provisional-axis controls. A level-6 node spans 4,096 m:
      // the same altitude walk crosses the material axis without triggering
      // the independent cliff-rock override this assertion is not testing.
      const level = 6;
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

      const node: TerrainNode = Object.freeze({
        address: createWorldPageAddress(level, 0, 0),
        subNodeX: 0,
        subNodeZ: 0,
        originX: 0,
        originZ: 0,
        spanMeters: span,
        level,
        morphK: 0,
        cornerMorphK: [0, 0, 0, 0] as const,
        maxDeviationMeters: 0,
        distanceMeters: span,
      });

      const mesh = new Mesh("fallback-node", scene);
      buildTerrainNodeGrid().applyToMesh(mesh, false);
      mesh.material = material;
      mesh.alwaysSelectAsActiveMesh = true;
      const buffers = createTerrainNodeBuffers(1);
      // Bind once and update the same resident GPU buffers for each control,
      // exactly as TerrainClipmapSystem does in production. Besides matching
      // shipping ownership, this avoids both stale custom-attribute bindings
      // across two otherwise-identical meshes and destroy-before-submit.
      mesh.thinInstanceSetBuffer("matrix", buffers.matrices, 16, false);
      mesh.thinInstanceSetBuffer(
        TERRAIN_NODE_ATTRIBUTE_A, buffers.laneA, TERRAIN_NODE_ATTRIBUTE_STRIDE, false);
      mesh.thinInstanceSetBuffer(
        TERRAIN_NODE_ATTRIBUTE_B, buffers.laneB, TERRAIN_NODE_ATTRIBUTE_STRIDE, false);
      const updateProbe = (provisionalAxis: number): void => {
        writeTerrainNodeBuffers({
          nodes: [node],
          originX: 0,
          originZ: 0,
          slotFor: (address) => (address.level === level ? 0 : -1),
          channelSlotFor: () => -1,
          provisionalAxisFor: () => provisionalAxis,
        }, buffers);
        mesh.thinInstanceBufferUpdated("matrix");
        mesh.thinInstanceBufferUpdated(TERRAIN_NODE_ATTRIBUTE_A);
        mesh.thinInstanceBufferUpdated(TERRAIN_NODE_ATTRIBUTE_B);
        mesh.thinInstanceCount = buffers.count;
      };
      const render = async (provisionalAxis: number): Promise<number[][]> => {
        updateProbe(provisionalAxis);
        for (let frame = 0; frame < 240 && !material.isReady(mesh); frame += 1) {
          engine.beginFrame();
          scene.render();
          engine.endFrame();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(material.isReady(mesh)).toBe(true);
        // Pace two unmeasured presentations before the captured one. A single
        // immediate submit can leave drawImage observing the preceding A/B
        // frame, while waiting on queue completion after presentation makes
        // Chromium's discard-configured canvas unavailable and reads black.
        for (let warmup = 0; warmup < 2; warmup += 1) {
          engine.beginFrame();
          scene.render();
          engine.endFrame();
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
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
        const samples: number[][] = [];
        for (let column = 8; column < CANVAS_SIZE - 8; column += 1) {
          const at = (row * CANVAS_SIZE + column) * 4;
          samples.push([
            image[at] ?? 0,
            image[at + 1] ?? 0,
            image[at + 2] ?? 0,
          ]);
        }
        return samples;
      };

      const derived = await render(TERRAIN_PROVISIONAL_AXIS_FROM_HEIGHT);
      const forced = await render(TERRAIN_PROVISIONAL_AXIS.fallbackAxis);
      const forcedAsphalt = await render(SurfaceMaterial.Asphalt);

      heightAtlas.dispose();
      arrays.albedoHeight.dispose();
      arrays.normalMaterial.dispose();
      material.dispose(true, true);
      mesh.dispose(false, false);

      const luminances = (values: readonly number[][]): number[] => values.map(
        (value) => 0.2126 * value[0]! + 0.7152 * value[1]! + 0.0722 * value[2]!,
      );
      const spread = (values: readonly number[]): number =>
        Math.max(...values) - Math.min(...values);
      const distance = (first: readonly number[], second: readonly number[]): number =>
        Math.hypot(
          first[0]! - second[0]!,
          first[1]! - second[1]!,
          first[2]! - second[2]!,
        );
      const meanPathDifference = derived.reduce(
        (sum, sample, index) => sum + distance(sample, forced[index]!),
        0,
      ) / derived.length;
      const derivedColorSpan = Math.max(...derived.map(
        (sample) => distance(sample, derived[0]!),
      ));
      const forcedColorSpan = Math.max(...forced.map(
        (sample) => distance(sample, forced[0]!),
      ));
      const adjacentSteps = derived.slice(1).map(
        (sample, index) => distance(sample, derived[index]!),
      );
      const maximumAdjacentStep = Math.max(...adjacentSteps);
      const maximumAdjacentIndex = adjacentSteps.indexOf(maximumAdjacentStep);
      const obsoleteLaneDifference = derived.reduce(
        (sum, sample, index) => sum + distance(sample, forcedAsphalt[index]!),
        0,
      ) / derived.length;
      console.log(
        `110: derived luma spread ${spread(luminances(derived)).toFixed(1)}, `
        + `forced ${spread(luminances(forced)).toFixed(1)}, `
        + `path delta ${meanPathDifference.toFixed(1)}, `
        + `colour span ${derivedColorSpan.toFixed(1)}/${forcedColorSpan.toFixed(1)}, `
        + `adjacent ${maximumAdjacentStep.toFixed(1)}, `
        + `at ${maximumAdjacentIndex} ${derived[maximumAdjacentIndex]!.join("/")}`
        + `→${derived[maximumAdjacentIndex + 1]!.join("/")}, `
        + `obsolete lane ${obsoleteLaneDifference.toFixed(2)}`,
      );
      expect(obsoleteLaneDifference, "the retired categorical fallback lane still affected colour")
        .toBeLessThan(1);
      expect(meanPathDifference, "the from-height sentinel differed from the Grass override")
        .toBeLessThan(1);
      expect(derivedColorSpan, "the macro fallback rendered one flat material appearance")
        .toBeGreaterThan(12);
      expect(maximumAdjacentStep, "the macro fallback contains a categorical colour jump")
        .toBeLessThan(40);
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
      // Use a 4,096 m node for the 2,400 m altitude walk. On a level-0
      // 64 m node that ramp is a near-vertical cliff; the shipping slope-rock
      // override correctly replaces every provisional material with Rock,
      // making the derived and forced controls identical for the wrong reason.
      const level = 6;
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
        cornerMorphK: [0, 0, 0, 0] as const,
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
      const range = Math.abs(dryMean - wetMean);
      expect(
        range,
        "the submerged term never fired — this assertion would be vacuous",
      ).toBeGreaterThan(8);
      // The half of the node BELOW the ramp's midpoint reads as the wet
      // reference; the half above must NOT. Undisplaced, `vPositionW.y`
      // would be 0 for every fragment and both halves would read wet —
      // identical means. Wave Q re-anchored the second assertion: the old
      // "right ≈ dry reference" form assumed the reference renders share
      // the high half's SURFACE, but they move sea level by kilometres and
      // every elevation-above-sea keyed term (alpine rock, the snowline)
      // moves with it — the comparison sat one percent from flipping, and
      // wave Q's roughness convergence tipped it. What the guarded defect
      // actually erases is the LEFT/RIGHT separation, so pin that.
      const towardWet = Math.abs(leftMean - wetMean) < Math.abs(leftMean - dryMean);
      expect(towardWet, "the low half of the ramp did not read as submerged").toBe(true);
      expect(
        rightMean - leftMean,
        "the high half of the ramp read as submerged too — vPositionW.y is flat",
      ).toBeGreaterThan(range * 0.25);

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

describe("CDLOD macro-normal continuity", () => {
  it("interpolates the height-derived normal instead of exposing triangle faces", async () => {
    // This is a direct adapter oracle for the blocky colour plates seen in the
    // high-down capture. PBR debug mode 5 reads the final `normalW` after the
    // terrain plugin. A coarse, curved node also makes the pixel footprint
    // larger than the detail-normal cutoff, so this image is the macro normal
    // that drives lighting, slope cover, and projection selection in shipping.
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    try {
      const level = 8;
      const span = terrainNodeSpanMeters(level);
      const camera = new FreeCamera(
        "normal-continuity-camera",
        new Vector3(span * 0.5, span * 3, span * 0.5),
        scene,
      );
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      camera.orthoLeft = -span * 0.5;
      camera.orthoRight = span * 0.5;
      camera.orthoBottom = -span * 0.5;
      camera.orthoTop = span * 0.5;
      camera.upVector = new Vector3(0, 0, 1);
      camera.setTarget(new Vector3(span * 0.5, 0, span * 0.5));
      camera.minZ = 1;
      camera.maxZ = span * 8;
      scene.activeCamera = camera;
      new HemisphericLight("normal-continuity-light", Vector3.Up(), scene);

      const edge = TERRAIN_HEIGHT_SLOT_EDGE;
      const quads = TERRAIN_NODE_GRID_RESOLUTION - 1;
      const heights = new Float32Array(edge * edge);
      const peak = span * 0.75;
      for (let row = 0; row < edge; row += 1) {
        const z = (row - WORLD_PAGE_GUTTER) / quads;
        for (let column = 0; column < edge; column += 1) {
          const x = (column - WORLD_PAGE_GUTTER) / quads;
          // Keep the gutter on the same analytic surface: the vertex sampler's
          // forward bilinear gradient is then valid at both node boundaries.
          heights[row * edge + column] = peak * (x * x + 0.3 * z * z);
        }
      }
      const heightAtlas = RawTexture.CreateRTexture(
        heights,
        edge,
        edge,
        scene,
        false,
        false,
        Texture.NEAREST_SAMPLINGMODE,
        Constants.TEXTURETYPE_FLOAT,
      );

      const material = new PBRMaterial("normal-continuity-pbr", scene);
      material.metallic = 0;
      material.roughness = 1;
      material.backFaceCulling = false;
      material.debugMode = 5;
      material.debugLimit = -1;
      material.debugFactor = 1;
      const plugin = new TerrainSurfacePlugin(material);
      const arrays = createSurfaceMaterialArrays(scene, "normal-continuity", 128);
      plugin.setArrays(arrays.albedoHeight, arrays.normalMaterial);
      plugin.setSamplingProfile("planar", 2);
      plugin.setDetileWarp(0);
      plugin.setHeightAtlas(heightAtlas, {
        atlasEdge: edge,
        slotEdge: edge,
        gutter: WORLD_PAGE_GUTTER,
        gridEdge: 1,
      });

      const node: TerrainNode = Object.freeze({
        address: createWorldPageAddress(level, 0, 0),
        subNodeX: 0,
        subNodeZ: 0,
        originX: 0,
        originZ: 0,
        spanMeters: span,
        level,
        morphK: 0,
        cornerMorphK: [0, 0, 0, 0] as const,
        maxDeviationMeters: 0,
        distanceMeters: span,
      });
      const mesh = new Mesh("normal-continuity-node", scene);
      buildTerrainNodeGrid().applyToMesh(mesh, false);
      mesh.material = material;
      mesh.alwaysSelectAsActiveMesh = true;
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

      for (let frame = 0; frame < 240 && !material.isReady(mesh); frame += 1) {
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(material.isReady(mesh)).toBe(true);
      for (let warmup = 0; warmup < 2; warmup += 1) {
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      engine.beginFrame();
      scene.render();
      engine.endFrame();

      const copy = document.createElement("canvas");
      copy.width = CANVAS_SIZE;
      copy.height = CANVAS_SIZE;
      const context = copy.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(canvas, 0, 0);
      const pixels = context.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;
      const row = Math.floor(CANVAS_SIZE * 0.43);
      const red: number[] = [];
      for (let column = 12; column < CANVAS_SIZE - 12; column += 1) {
        red.push(pixels[(row * CANVAS_SIZE + column) * 4] ?? 0);
      }
      const deltas = red.slice(1).map((value, index) => Math.abs(value - red[index]!));
      const range = Math.max(...red) - Math.min(...red);
      const changedFraction = deltas.filter((delta) => delta > 0).length / deltas.length;
      const largestStep = Math.max(...deltas);
      console.log(
        `macro normal: range ${range}, changed ${(changedFraction * 100).toFixed(1)}%, `
        + `largest step ${largestStep}`,
      );

      // A face normal has the same value for almost every pixel in each 8px
      // grid cell and jumps at 31 boundaries (~13% changed pixels). Interpolated
      // shared-vertex normals spread the same non-vacuous range continuously.
      expect(range, "the curved height atlas did not affect the final macro normal")
        .toBeGreaterThan(70);
      expect(changedFraction, "the macro normal was quantized into triangle-wide plates")
        .toBeGreaterThan(0.3);
      // Re-pinned 3 → 24 for fix-pack T1: the meso band's strata shading is
      // DELIBERATE high-frequency tone on steep faces (measured step 17 at
      // this zoom), which the old absolute-step gate cannot distinguish from
      // an edge. The plate failure mode this test exists for is still caught:
      // a face-normal render changes ~13% of pixels and fails the 0.3
      // changed-fraction floor above, and a raw triangle edge steps > 24.
      expect(largestStep, "a triangle or grid edge remained visible in the macro normal")
        .toBeLessThanOrEqual(24);

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
