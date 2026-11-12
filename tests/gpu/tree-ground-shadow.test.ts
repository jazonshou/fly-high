import { Buffer, VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene, ScenePerformancePriority } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import {
  DETAIL_INSTANCE_ATTRIBUTES,
  DETAIL_INSTANCE_STRIDE_BYTES,
  DetailInstanceBounds,
  DetailInstanceWriter,
  detailPrototypeBoundKernel,
} from "../../src/render/webgpu/detail/instanceFormat";
import {
  TREE_GROUND_SHADOW_DIRECT_TO_SKY,
  TREE_GROUND_SHADOW_SKY_COLOUR,
  TREE_GROUND_SHADOW_SKY_SHADE,
  TreeGroundShadowMaterial,
  type TreeGroundShadowLaw,
} from "../../src/render/webgpu/detail/TreeGroundShadowMaterial";
import {
  TREE_GROUND_SHADOW_PROTOTYPE_BOUNDS,
  TREE_GROUND_SHADOW_SHAPES,
  treeGroundShadowFootprint,
  treeGroundShadowRecord,
} from "../../src/render/webgpu/detail/treeGroundShadow";
import type { DetailTreePlacement } from "../../src/render/webgpu/detail/types";

/**
 * The tree ground shadow on a real adapter, drawn the way the flight renderer
 * draws it: compatibility mode off and Intermediate priority (frozen
 * materials, bundle replay), one instanced batch on the detail record.
 *
 * A Node test can pin the record and the footprint's arithmetic; only an
 * adapter shows that the shader compiles, that the quantised record decodes
 * to the footprint its CPU mirror describes, and that `ALPHA_MULTIPLY` scales
 * what is under the decal by the share of light the model says the sun's
 * shadow takes. The frame is cleared to white and seen from straight above,
 * so every probe reads the decal's multiplier itself.
 */

const CANVAS = 128;
/** Half the view's width on the ground, metres: half a metre to the pixel. */
const HALF = 32;

/** Level ground, an oak 16 m tall, 10 m east of the camera's foot. */
const TREE: DetailTreePlacement = {
  kind: "tree",
  id: "oak",
  species: "oak",
  x: 10,
  y: 0,
  z: 0,
  yawRadians: 0,
  heightMeters: 16,
  crownRadiusMeters: 4,
  trunkRadiusMeters: 0.3,
  windPhaseRadians: 0,
  windResponse: 0,
  color: [0.4, 0.5, 0.3, 1],
  standAge: 0.5,
  selection: 0.5,
  groundSlopeX: 0,
  groundSlopeZ: 0,
};
/** Toward the sun: 53 degrees up, in the east. Its shadows fall west. */
const SUN: readonly [number, number, number] = [0.6, 0.8, 0];
const COTANGENT = 0.6 / 0.8;

const LAW: TreeGroundShadowLaw = {
  nearRadiusMeters: 150,
  rangeMeters: 1_000,
  geometryFloorShare: 0.045,
  drawnFloorShare: 0.3,
  nearStemsPerHectare: 78,
  realShadowEdgeMeters: 0,
};

describe("tree ground shadow on the adapter", () => {
  it("compiles, lays the footprint its CPU mirror describes, and takes the sun's share of the light", async () => {
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
      engine.compatibilityMode = false;
      const device = (engine as unknown as { _device: GPUDevice })._device;
      device.addEventListener("uncapturederror", (event) => {
        errors.push(String((event as GPUUncapturedErrorEvent).error.message));
      });
      const scene = new Scene(engine);
      scene.performancePriority = ScenePerformancePriority.Intermediate;
      // The flight renderer's sky covers the frame; here the clear is the lit ground.
      scene.autoClear = true;
      scene.clearColor = new Color4(1, 1, 1, 1);
      const camera = new FreeCamera("top", new Vector3(0, 50, 0), scene);
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      camera.orthoLeft = -HALF;
      camera.orthoRight = HALF;
      camera.orthoTop = HALF;
      camera.orthoBottom = -HALF;
      camera.minZ = 1;
      camera.maxZ = 200;
      camera.upVector = new Vector3(0, 0, 1);
      camera.setTarget(Vector3.Zero());
      scene.activeCamera = camera;

      const shadow = new TreeGroundShadowMaterial(scene);
      const prototype = shadow.createPrototypeMesh();
      shadow.setSun(SUN[0], SUN[1], SUN[2], [1, 1, 1], 1);
      shadow.setSkylight(1);
      shadow.setHazePerMeter(0);
      shadow.setLaw(LAW);

      /** One batch holding one stem's shadow, as the runtime builds its chunks'. */
      const batch = (stemKey: number): Mesh => {
        const writer = new DetailInstanceWriter();
        writer.pushBounded(
          treeGroundShadowRecord(TREE, stemKey, 0.2, { x: 0, y: 0, z: 0 }),
          new DetailInstanceBounds(),
          detailPrototypeBoundKernel(TREE_GROUND_SHADOW_PROTOTYPE_BOUNDS),
        );
        const mesh = prototype.clone(`shadow-batch-${stemKey}`);
        mesh.makeGeometryUnique();
        shadow.configureBatchMesh(mesh);
        const shared = new Buffer(engine, writer.finish(), false, DETAIL_INSTANCE_STRIDE_BYTES, false, true, true);
        for (const attribute of DETAIL_INSTANCE_ATTRIBUTES) {
          mesh.setVerticesBuffer(new VertexBuffer(engine, shared, attribute.kind, {
            updatable: false,
            instanced: true,
            size: attribute.size,
            offset: attribute.byteOffset,
            stride: DETAIL_INSTANCE_STRIDE_BYTES,
            useBytes: true,
            type: attribute.type === "float" ? VertexBuffer.FLOAT
              : attribute.type === "snorm16" ? VertexBuffer.SHORT
              : attribute.type === "unorm16" ? VertexBuffer.UNSIGNED_SHORT
              : VertexBuffer.UNSIGNED_BYTE,
            normalized: attribute.normalized,
          }), false);
        }
        mesh.forcedInstanceCount = 1;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.setEnabled(true);
        return mesh;
      };

      const frame = async (): Promise<Uint8ClampedArray> => {
        for (let index = 0; index < 4; index += 1) {
          engine.beginFrame();
          scene.render();
          engine.endFrame();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        const copy = document.createElement("canvas");
        copy.width = CANVAS;
        copy.height = CANVAS;
        const context = copy.getContext("2d")!;
        context.drawImage(canvas, 0, 0);
        return context.getImageData(0, 0, CANVAS, CANVAS).data;
      };
      /** The pixel a ground point lands on, from the camera's own matrices. */
      const probe = (pixels: Uint8ClampedArray, x: number, z: number): [number, number, number] => {
        const clip = Vector3.TransformCoordinates(new Vector3(x, 0, z), scene.getTransformMatrix());
        const px = Math.min(CANVAS - 1, Math.max(0, Math.floor((clip.x * 0.5 + 0.5) * CANVAS)));
        const py = Math.min(CANVAS - 1, Math.max(0, Math.floor((1 - (clip.y * 0.5 + 0.5)) * CANVAS)));
        const offset = (py * CANVAS + px) * 4;
        return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!];
      };
      const near = (actual: readonly number[], expected: readonly number[], tolerance: number): boolean =>
        actual.every((channel, index) => Math.abs(channel - expected[index]!) <= tolerance);

      const mesh = batch(0.1);
      for (let attempt = 0; attempt < 600 && !shadow.material.isReady(mesh, true); attempt += 1) {
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(shadow.material.isReady(mesh, true), "the shadow material compiles").toBe(true);
      // The camera's matrices are current only after a render.
      expect(Matrix.Identity().equals(scene.getTransformMatrix())).toBe(false);

      // 1. Sun out. The crown's shadow lies where the CPU mirror puts it: west
      // of the stem by the crown centre's height times the sun's cotangent.
      const shape = TREE_GROUND_SHADOW_SHAPES.oak;
      const footprint = treeGroundShadowFootprint(TREE.heightMeters, TREE.crownRadiusMeters, shape, COTANGENT);
      const centreX = TREE.x - footprint.offsetMeters;
      const lit = await frame();
      // What the model says a shaded patch keeps: the sky's share of the
      // light per channel, plus what the crown lets through (opacity 0.9).
      const direct = TREE_GROUND_SHADOW_DIRECT_TO_SKY * SUN[1];
      const keep = TREE_GROUND_SHADOW_SKY_COLOUR.map(
        (sky) => 255 * (1 - (direct / (direct + sky)) * shape.opacity),
      );
      const core = probe(lit, centreX, 0);
      expect(near(core, keep, 6), `crown shadow core ${core} against ${keep.map(Math.round)}`).toBe(true);
      // Bluer than it is red: the sky lights what the sun does not.
      expect(core[2]).toBeGreaterThan(core[0] + 20);
      // Inside the core along and across the sun, lit beyond the soft edge.
      expect(near(probe(lit, centreX - footprint.semiAlongMeters * 0.4, 0), keep, 6)).toBe(true);
      expect(near(probe(lit, centreX, footprint.semiAcrossMeters * 0.4), keep, 6)).toBe(true);
      expect(near(probe(lit, centreX - footprint.semiAlongMeters * 1.3, 0), [255, 255, 255], 2)).toBe(true);
      expect(near(probe(lit, centreX, footprint.semiAcrossMeters * 1.3), [255, 255, 255], 2)).toBe(true);
      expect(near(probe(lit, centreX, -footprint.semiAcrossMeters * 1.3), [255, 255, 255], 2)).toBe(true);
      // Nothing on the sunward side of the tree, and nothing far away.
      expect(near(probe(lit, TREE.x + 8, 0), [255, 255, 255], 2)).toBe(true);
      expect(near(probe(lit, -25, 20), [255, 255, 255], 2)).toBe(true);
      // The sky shade right by the stem, off the trunk's own line: grey, not blue.
      const blob = probe(lit, TREE.x, 1.5);
      expect(blob[0]).toBeLessThan(250);
      expect(blob[0]).toBeGreaterThan(255 * (1 - TREE_GROUND_SHADOW_SKY_SHADE));
      expect(Math.abs(blob[0] - blob[2])).toBeLessThanOrEqual(2);
      // The trunk's shadow joins the stem to the crown's.
      const trunk = probe(lit, TREE.x - 2, 0);
      expect(trunk[0]).toBeLessThan(blob[0] - 40);

      // 2. Sun gone (night, or the key light switched off): no cast shadow,
      // and the sky shade under the crown stays.
      shadow.setSun(SUN[0], SUN[1], SUN[2], [1, 1, 1], 0);
      const dark = await frame();
      expect(near(probe(dark, centreX, 0), [255, 255, 255], 2)).toBe(true);
      expect(near(probe(dark, TREE.x, 1.5), blob, 3)).toBe(true);
      shadow.setSun(SUN[0], SUN[1], SUN[2], [1, 1, 1], 1);

      // 3. A red evening sun takes red from the shadow and leaves the blue.
      shadow.setSun(SUN[0], SUN[1], SUN[2], [1, 0.5, 0.1], 1);
      const evening = probe(await frame(), centreX, 0);
      expect(near(evening.slice(0, 1), keep.slice(0, 1), 6)).toBe(true);
      expect(evening[1]).toBeGreaterThan(core[1] + 15);
      expect(evening[2]).toBeGreaterThan(core[2] + 60);
      shadow.setSun(SUN[0], SUN[1], SUN[2], [1, 1, 1], 1);

      // 4. Inside the range where near trees cast real shadows the decal's
      // cast shadow stands down (the stem is 10 m from the camera's foot).
      shadow.setLaw({ ...LAW, realShadowEdgeMeters: 120 });
      const handed = await frame();
      expect(near(probe(handed, centreX, 0), [255, 255, 255], 2)).toBe(true);
      expect(near(probe(handed, TREE.x, 1.5), blob, 3)).toBe(true);
      // And is whole again where the real shadows have ended.
      shadow.setLaw({ ...LAW, realShadowEdgeMeters: 6 });
      expect(near(probe(await frame(), centreX, 0), keep, 6)).toBe(true);

      // 5. Past the shadow's range nothing draws at all.
      shadow.setLaw({ ...LAW, rangeMeters: 8 });
      const beyond = await frame();
      expect(near(probe(beyond, centreX, 0), [255, 255, 255], 2)).toBe(true);
      expect(near(probe(beyond, TREE.x, 1.5), [255, 255, 255], 2)).toBe(true);

      // 6. A stem the law is not drawing at this range has no shadow: the
      // near band ends at 5 m here, so at 10 m only a quarter of the keys draw.
      const thinned = { ...LAW, nearRadiusMeters: 5, geometryFloorShare: 0, drawnFloorShare: 0 };
      shadow.setLaw(thinned);
      expect(near(probe(await frame(), centreX, 0), keep, 6), "key 0.1 draws under a share of 0.25").toBe(true);
      mesh.setEnabled(false);
      const undrawn = batch(0.9);
      const none = await frame();
      expect(near(probe(none, centreX, 0), [255, 255, 255], 2), "key 0.9 does not").toBe(true);
      expect(near(probe(none, TREE.x, 1.5), [255, 255, 255], 2)).toBe(true);
      // The same stem inside the near band draws whatever its key.
      shadow.setLaw(LAW);
      expect(near(probe(await frame(), centreX, 0), keep, 6)).toBe(true);
      undrawn.dispose();
      mesh.dispose();

      expect(errors, errors.join("\n")).toEqual([]);
      shadow.dispose();
      prototype.dispose();
      scene.dispose();
    } finally {
      console.warn = warn;
      console.error = error;
      engine.dispose();
      canvas.remove();
    }
  }, 120_000);
});
