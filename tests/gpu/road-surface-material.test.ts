import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { RawTexture2DArray } from "@babylonjs/core/Materials/Textures/rawTexture2DArray";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import type { RoadSurfaceRegion } from "../../src/render/webgpu/roads/RoadSurfaceIndex";
import { RoadSurfaceSystem, type RoadSurfaceTerrain } from "../../src/render/webgpu/roads/RoadSurfaceSystem";
import { TerrainDrawnHeight } from "../../src/render/webgpu/terrain/TerrainDrawnHeight";
import { SURFACE_MATERIAL_COUNT } from "../../src/render/webgpu/terrain/surfaceMaterials";
import { ROAD_CLASS, type RoadClassId } from "../../src/world/roads/roadClasses";
import type { RoadPiece } from "../../src/world/roads/roadNetwork";
import { DRAWN_FRAME_CAMERA, buildDrawnFrame, drawnFrameGround } from "../support/terrainDrawnFrame";

/**
 * The roads' two materials on the adapter: the ribbon and the rail compile
 * with `RoadSurfaceMaterialPlugin` (its vertex stage reading the drawn-height
 * lookup, its fragment stage the terrain's material arrays), and draw where
 * the roads are and nowhere else, seen straight down over a real terrain
 * frame's lookup; then again after a change written into the buffers in place.
 */

const CANVAS = 128;
const HALF = 100;
const CLEAR = [255, 0, 255] as const;

function straight(classId: RoadClassId, edgeId: number, ax: number, az: number, bx: number, bz: number, pieces: number): RoadPiece[] {
  const out: RoadPiece[] = [];
  for (let index = 0; index < pieces; index += 1) {
    const x0 = ax + ((bx - ax) * index) / pieces;
    const z0 = az + ((bz - az) * index) / pieces;
    const x1 = ax + ((bx - ax) * (index + 1)) / pieces;
    const z1 = az + ((bz - az) * (index + 1)) / pieces;
    out.push({
      classId, edgeId, index, ax: x0, az: z0, bx: x1, bz: z1,
      ha: drawnFrameGround(x0, z0), hb: drawnFrameGround(x1, z1),
      ca: 0, cb: 0, ka: 0.03, kb: 0.03,
    });
  }
  return out;
}

describe("the roads' ribbon and rail materials on the GPU", () => {
  it("compile, draw the roads in reach where they lie and nowhere else, and redraw a change in place", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS;
    canvas.height = CANVAS;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
    const errors: string[] = [];
    const warn = console.warn;
    const error = console.error;
    const capture = (...args: unknown[]) => {
      const text = args.map(String).join(" ");
      if (/WGSL|shader|Shader|compil/u.test(text)) errors.push(text);
    };
    console.warn = (...args: unknown[]) => { capture(...args); warn(...args); };
    console.error = (...args: unknown[]) => { capture(...args); error(...args); };
    try {
      await engine.initAsync();
      const device = (engine as unknown as { _device: GPUDevice })._device;
      device.addEventListener("uncapturederror", (event) => {
        errors.push(String((event as GPUUncapturedErrorEvent).error.message));
      });
      const scene = new Scene(engine);
      scene.clearColor = new Color4(CLEAR[0] / 255, CLEAR[1] / 255, CLEAR[2] / 255, 1);
      const camera = new FreeCamera("top", new Vector3(DRAWN_FRAME_CAMERA.x, 400, DRAWN_FRAME_CAMERA.z), scene);
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      camera.orthoLeft = -HALF;
      camera.orthoRight = HALF;
      camera.orthoTop = HALF;
      camera.orthoBottom = -HALF;
      camera.minZ = 1;
      camera.maxZ = 1_000;
      camera.upVector = new Vector3(0, 0, 1);
      camera.setTarget(new Vector3(DRAWN_FRAME_CAMERA.x, 0, DRAWN_FRAME_CAMERA.z));
      scene.activeCamera = camera;
      new HemisphericLight("sky", Vector3.Up(), scene).intensity = 1.5;

      const frame = buildDrawnFrame();
      const atlas = new RawTexture(
        frame.atlas.heights, frame.atlas.shape.atlasEdge, frame.atlas.shape.atlasEdge, Constants.TEXTUREFORMAT_R,
        scene, false, false, Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT,
      );
      const layer = (r: number, g: number, b: number, a: number) => {
        const texels = new Uint8Array(4 * 4 * SURFACE_MATERIAL_COUNT * 4);
        for (let index = 0; index < texels.length; index += 4) texels.set([r, g, b, a], index);
        return new RawTexture2DArray(
          texels, 4, 4, SURFACE_MATERIAL_COUNT, Constants.TEXTUREFORMAT_RGBA, scene, false, false,
          Texture.TRILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE,
        );
      };
      let lookup: TerrainDrawnHeight | null = null;
      const terrain: RoadSurfaceTerrain = {
        drawnHeight: (reach) => {
          lookup ??= new TerrainDrawnHeight(scene, reach);
          return lookup;
        },
        refreshDrawnHeight: (x, z, radius) => lookup?.refresh(frame.records, x, z, radius),
        drawnHeightAtlas: { texture: atlas, shape: frame.atlas.shape },
        surfaceMaterialArrays: { albedoHeight: layer(150, 140, 130, 128), normalMaterial: layer(128, 128, 200, 255) },
      };
      const x = DRAWN_FRAME_CAMERA.x;
      const z = DRAWN_FRAME_CAMERA.z;
      const region: RoadSurfaceRegion = {
        key: "gpu",
        pieces: [
          // A gravel road across the view along x, a sealed one along z, a track either side.
          ...straight(ROAD_CLASS.gravel, 1, x - 160, z, x + 160, z, 16),
          ...straight(ROAD_CLASS.airport, 2, x, z - 160, x, z + 160, 16),
          ...straight(ROAD_CLASS.track, 3, x - 160, z + 60, x + 160, z + 60, 16),
          ...straight(ROAD_CLASS.track, 4, x - 160, z - 60, x + 160, z - 60, 16),
        ],
        pads: [{
          classId: ROAD_CLASS.airport, nodeId: 1, x, z, height: drawnFrameGround(x, z),
          gradientX: 0, gradientZ: 0, radius: 12,
        }],
        rails: [{ points: [x + 30, z - 6, x + 90, z - 6], heightMeters: 0.75 }],
      };
      const system = new RoadSurfaceSystem(scene, terrain, { roadRibbonRangeMeters: 300, barrierDrawRangeMeters: 300 });
      // Changes and chunk writes take a frame's budget at a time: update until none is left.
      const settle = () => {
        for (let step = 0; step < 100 && system.pendingWork > 0; step += 1) system.update(x, z);
        expect(system.pendingWork).toBe(0);
      };
      system.apply([region], []);
      system.setFloatingOrigin(0, 0);
      settle();
      expect(system.statistics.draws).toBe(2);
      await scene.whenReadyAsync();
      // Every probe below holds mirrored in x and in z, so the screen's handedness does not matter.
      const isClear = (rgb: readonly number[]) => rgb.every((value, channel) => Math.abs(value - CLEAR[channel]!) < 3);
      const render = async () => {
        // Manual renders on WebGPU need begin/endFrame, and the presented
        // canvas is copied in the same task, before the compositor clears it.
        for (let pass = 0; pass < 3; pass += 1) {
          system.update(x, z);
          engine.beginFrame();
          scene.render();
          engine.endFrame();
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        system.update(x, z);
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        const copy = document.createElement("canvas");
        copy.width = CANVAS;
        copy.height = CANVAS;
        const context = copy.getContext("2d")!;
        context.drawImage(canvas, 0, 0);
        const pixels = context.getImageData(0, 0, CANVAS, CANVAS).data;
        return (worldX: number, worldZ: number): boolean => {
          const column = Math.round(((worldX - x) / (2 * HALF) + 0.5) * (CANVAS - 1));
          const row = Math.round((0.5 - (worldZ - z) / (2 * HALF)) * (CANVAS - 1));
          const index = (row * CANVAS + column) * 4;
          return !isClear([pixels[index]!, pixels[index + 1]!, pixels[index + 2]!]);
        };
      };
      let drawn = await render();
      expect(errors.join(" | ")).toBe("");
      // On the gravel, on the sealed road, on the pad: drawn.
      expect(drawn(x - 70, z)).toBe(true);
      expect(drawn(x, z + 70)).toBe(true);
      expect(drawn(x, z)).toBe(true);
      // Between the roads: nothing. Nor the middle of a track, which is the sward's.
      expect(drawn(x - 50, z - 30)).toBe(false);
      expect(drawn(x + 50, z + 30)).toBe(false);
      expect(drawn(x - 70, z + 60)).toBe(false);

      // The buffers are written in place after the first draw: a road another
      // region brings shows where it lies, and a region removed is gone.
      const { writes, bufferBuilds } = system.statistics;
      system.apply([{ key: "gpu-more", pieces: straight(ROAD_CLASS.gravel, 5, x - 50, z - 160, x - 50, z + 160, 16), pads: [], rails: [] }], []);
      settle();
      expect(system.statistics.writes).toBeGreaterThan(writes);
      expect(system.statistics.bufferBuilds).toBe(bufferBuilds);
      drawn = await render();
      expect(drawn(x - 50, z - 30)).toBe(true);
      expect(drawn(x - 70, z)).toBe(true);
      expect(drawn(x + 50, z + 30)).toBe(false);
      system.apply([], ["gpu"]);
      settle();
      expect(system.statistics.draws).toBe(1);
      expect(system.statistics.bufferBuilds).toBe(bufferBuilds);
      drawn = await render();
      expect(errors.join(" | ")).toBe("");
      expect(drawn(x - 50, z - 30)).toBe(true);
      expect(drawn(x - 50, z + 30)).toBe(true);
      expect(drawn(x - 70, z)).toBe(false);
      expect(drawn(x, z + 70)).toBe(false);
      expect(drawn(x, z)).toBe(false);
      system.dispose();
      scene.dispose();
    } finally {
      console.warn = warn;
      console.error = error;
      engine.dispose();
      canvas.remove();
    }
  }, 60_000);
});
