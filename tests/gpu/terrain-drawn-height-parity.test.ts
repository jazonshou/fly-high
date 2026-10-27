import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { Constants } from "@babylonjs/core/Engines/constants";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import {
  TERRAIN_DRAWN_CELL_METERS,
  TERRAIN_DRAWN_HEIGHT_WGSL,
  TerrainDrawnHeight,
} from "../../src/render/webgpu/terrain/TerrainDrawnHeight";
import {
  DRAWN_FRAME_CAMERA,
  buildDrawnFrame,
  drawnFrameEdgeProbes,
  drawnFrameRing,
} from "../support/terrainDrawnFrame";

/**
 * `TERRAIN_DRAWN_HEIGHT_WGSL` on the adapter against its CPU twin
 * (`terrainDrawnSurfaceAt`, which tests/render.terrain-drawn-height.test.ts
 * holds to the drawn triangles): the same lookup and atlas uploaded as the
 * renderer uploads them, the same probes near the camera, a few hundred
 * metres out, past a kilometre and a few centimetres inside node edges. The
 * GPU's f32 answers within 1 mm of the twin's, and invalid exactly where it is.
 */

const KERNEL = (helper: string) => /* wgsl */ `
struct TerrainDrawnUniforms {
  terrainDrawnAtlasShape: vec4f,
  terrainDrawnWindow: vec4f,
  terrainDrawnOrigin: vec4f,
};
@group(0) @binding(0) var<storage, read> uniforms: TerrainDrawnUniforms;
${helper
    .replace("var terrainDrawnLookup: texture_2d<f32>;", "@group(0) @binding(1) var terrainDrawnLookup: texture_2d<f32>;")
    .replace("var terrainDrawnAtlas: texture_2d<f32>;", "@group(0) @binding(2) var terrainDrawnAtlas: texture_2d<f32>;")}
@group(0) @binding(3) var<storage, read> probes: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> results: array<vec4f>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes)) { return; }
  let surface = terrainDrawnSurfaceAtLocal(probes[id.x].xy);
  results[id.x] = vec4f(surface.height, surface.gradient, select(0.0, 1.0, surface.valid));
}
`;

describe("the drawn-height helper on the GPU", () => {
  it("answers as its CPU twin, within 1 mm, near, mid, far and beside node edges", async () => {
    const frame = buildDrawnFrame();
    const lookup = new TerrainDrawnHeight(null, 1_400);
    lookup.refresh(frame.records, DRAWN_FRAME_CAMERA.x, DRAWN_FRAME_CAMERA.z, 1_400);
    const points = [
      ...drawnFrameRing(20, 90, 256, 1),
      ...drawnFrameRing(300, 500, 256, 2),
      ...drawnFrameRing(1_000, 1_300, 256, 3),
      ...drawnFrameEdgeProbes(frame, 1_300, 768),
      // Outside the window: invalid on both sides.
      [DRAWN_FRAME_CAMERA.x + 5_000, DRAWN_FRAME_CAMERA.z] as [number, number],
    ];
    // The probes in the consumer's local frame: here, the window's corner.
    const [cornerX, cornerZ] = lookup.corner;
    const localOriginX = cornerX * TERRAIN_DRAWN_CELL_METERS + 0.5;
    const localOriginZ = cornerZ * TERRAIN_DRAWN_CELL_METERS - 0.25;
    const probeData = new Float32Array(points.length * 4);
    points.forEach(([x, z], index) => {
      probeData[index * 4] = x - localOriginX;
      probeData[index * 4 + 1] = z - localOriginZ;
    });
    const edge = lookup.windowCells;
    const uniformData = new Float32Array([
      frame.atlas.shape.atlasEdge, frame.atlas.shape.slotEdge, frame.atlas.shape.gutter, frame.atlas.shape.gridEdge,
      edge, ((cornerX % edge) + edge) % edge, ((cornerZ % edge) + edge) % edge, TERRAIN_DRAWN_CELL_METERS,
      cornerX, cornerZ,
      localOriginX - cornerX * TERRAIN_DRAWN_CELL_METERS,
      localOriginZ - cornerZ * TERRAIN_DRAWN_CELL_METERS,
    ]);

    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
    try {
      await engine.initAsync();
      engine.runRenderLoop(() => {});
      const lookupTexture = new RawTexture(
        lookup.texels, edge * 2, edge, Constants.TEXTUREFORMAT_RGBA, engine, false, false,
        Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT,
      );
      const atlasTexture = new RawTexture(
        frame.atlas.heights, frame.atlas.shape.atlasEdge, frame.atlas.shape.atlasEdge, Constants.TEXTUREFORMAT_R,
        engine, false, false, Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT,
      );
      const uniformBuffer = new StorageBuffer(engine, uniformData.byteLength);
      uniformBuffer.update(uniformData);
      const probeBuffer = new StorageBuffer(engine, probeData.byteLength);
      probeBuffer.update(probeData);
      const resultBuffer = new StorageBuffer(engine, points.length * 16);
      const shader = new ComputeShader("terrain-drawn-height-parity", engine, { computeSource: KERNEL(TERRAIN_DRAWN_HEIGHT_WGSL) }, {
        bindingsMapping: {
          uniforms: { group: 0, binding: 0 },
          terrainDrawnLookup: { group: 0, binding: 1 },
          terrainDrawnAtlas: { group: 0, binding: 2 },
          probes: { group: 0, binding: 3 },
          results: { group: 0, binding: 4 },
        },
      });
      shader.setStorageBuffer("uniforms", uniformBuffer);
      shader.setTexture("terrainDrawnLookup", lookupTexture, false);
      shader.setTexture("terrainDrawnAtlas", atlasTexture, false);
      shader.setStorageBuffer("probes", probeBuffer);
      shader.setStorageBuffer("results", resultBuffer);
      const compileErrors: string[] = [];
      shader.onError = (_effect, message) => { compileErrors.push(String(message)); };
      const started = performance.now();
      while (performance.now() - started < 15_000 && compileErrors.length === 0) {
        if (shader.isReady()) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(compileErrors.join(" | ")).toBe("");
      await shader.dispatchWhenReady(Math.ceil(points.length / 64), 1, 1);
      const view = await resultBuffer.read();
      const raw = new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + points.length * 16));

      let worstHeight = 0;
      let worstGradient = 0;
      let invalid = 0;
      points.forEach(([x, z], index) => {
        const twin = lookup.surfaceAt(frame.atlas, x, z);
        const valid = raw[index * 4 + 3]! > 0.5;
        expect(valid, `validity at (${x.toFixed(2)}, ${z.toFixed(2)})`).toBe(twin !== null);
        if (!twin) {
          invalid += 1;
          return;
        }
        worstHeight = Math.max(worstHeight, Math.abs(raw[index * 4]! - twin.height));
        worstGradient = Math.max(
          worstGradient,
          Math.abs(raw[index * 4 + 1]! - twin.gradientX),
          Math.abs(raw[index * 4 + 2]! - twin.gradientZ),
        );
      });
      expect(invalid).toBe(1);
      expect(worstHeight).toBeLessThan(1e-3);
      expect(worstGradient).toBeLessThan(1e-4);
      lookupTexture.dispose();
      atlasTexture.dispose();
      uniformBuffer.dispose();
      probeBuffer.dispose();
      resultBuffer.dispose();
    } finally {
      engine.dispose();
      canvas.remove();
    }
  });
});
