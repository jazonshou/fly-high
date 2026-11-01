import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene, ScenePerformancePriority } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { InlineStructureMeshBuilder } from "../../src/render/structures/InlineStructureMeshBuilder";
import { structureSetArrays } from "../../src/render/structures/structureMeshArrays";
import { structureTexturePlans, type StructureTexturePlans } from "../../src/render/structures/structureTextures";
import { STRUCTURE_NIGHT_OFF } from "../../src/render/structures/structureNightLighting";
import { StructureSystem, type StructureMeshBuilder, type StructureSetName } from "../../src/render/webgpu/structures/StructureSystem";
import type { StructureRecord } from "../../src/world/structures/structureRecord";

/**
 * The structures' material and meshes on the adapter: the far blocks, the
 * near shells and the open buildings compile with `StructureMaterialPlugin`
 * and each building is drawn by the set the camera puts it in, seen straight
 * down: a shell inside the near radius, a block past the band, nothing past
 * the far radius; across the band both, on complementary pixels, so the
 * building is whole and never drawn twice; and a building drawn open by the
 * open mesh alone. Each set paints its own colour, so the probes can tell
 * them apart. The engine and scene run as the flight renderer's do (off
 * compatibility mode, materials frozen after their first ready draw), and a
 * set rebuilt after the first draw is seen redrawn. On a textured tier the
 * materials compile reading flat placeholders, and the kit's arrays, once
 * in, add detail around the parts' colours without moving their mean. At
 * night a lit building's windows glow warm, and with the share at 0 none do.
 */

const CANVAS = 240;
const HALF = 120;
const CLEAR = [255, 0, 255] as const;
const SET_COLOURS: Readonly<Record<StructureSetName, readonly [number, number, number]>> = {
  near: [0.8, 0.05, 0.05],
  far: [0.05, 0.05, 0.8],
  open: [0.05, 0.8, 0.05],
};

function record(id: number, x: number, z: number): StructureRecord {
  return {
    id,
    archetype: "house",
    style: "temperate",
    x,
    z,
    heading: 0,
    width: 12,
    depth: 9,
    storeys: 1,
    floorY: 0,
    baseY: -0.5,
    entryY: -0.2,
    foundation: "plinth",
    seed: id,
    settlement: 1,
    settlementKind: "hamlet",
    basalt: false,
  };
}

describe("the structures on the GPU", () => {
  it("draw each building by its set, dither the handoff band whole, and open the building next to the camera", async () => {
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
      scene.useRightHandedSystem = true;
      scene.performancePriority = ScenePerformancePriority.Intermediate;
      scene.autoClear = true;
      scene.clearColor = new Color4(CLEAR[0] / 255, CLEAR[1] / 255, CLEAR[2] / 255, 1);
      const camera = new FreeCamera("top", new Vector3(0, 400, 0), scene);
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      camera.orthoLeft = -HALF;
      camera.orthoRight = HALF;
      camera.orthoTop = HALF;
      camera.orthoBottom = -HALF;
      camera.minZ = 1;
      camera.maxZ = 1_000;
      camera.upVector = new Vector3(0, 0, 1);
      camera.setTarget(Vector3.Zero());
      scene.activeCamera = camera;
      new HemisphericLight("sky", Vector3.Up(), scene).intensity = 1.5;

      const builder = new InlineStructureMeshBuilder((set, records, originX, originZ) => {
        const arrays = structureSetArrays(set, records, originX, originZ).opaque;
        const colour = new Float32Array(arrays.colour.length);
        for (let index = 0; index < colour.length; index += 3) colour.set(SET_COLOURS[set], index);
        return { opaque: { ...arrays, colour }, glass: null };
      });
      // Near to 35 m, the band to 75 m, blocks to 140 m.
      const system = new StructureSystem(scene, {
        structureNearRadiusMeters: 35,
        structureFarRadiusMeters: 140,
        structureOpenBuildings: 2,
        structureNearCastsShadows: false,
        structureTextureEdge: 0,
      }, builder);
      system.setFloatingOrigin(0, 0);
      const near = record(1, -20, 0);
      const band = record(2, 55, 0);
      const far = record(3, 0, 90);
      const beyond = record(4, -110, -110);
      system.apply([{ key: "settlements:0:0", structures: [near, band, far, beyond] }], []);

      const isClear = (rgb: readonly number[]) => rgb.every((value, channel) => Math.abs(value - CLEAR[channel]!) < 3);
      // The system's camera is not the render camera: it stands where the set rules are probed.
      const render = async (at: { x: number; y: number; z: number }) => {
        for (let pass = 0; pass < 6; pass += 1) {
          system.update(at);
          await Promise.resolve();
          await Promise.resolve();
          engine.beginFrame();
          scene.render();
          engine.endFrame();
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        expect(system.pendingWork).toBe(0);
        // The presented canvas is copied in the same task as its frame, before the compositor clears it.
        system.update(at);
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        const copy = document.createElement("canvas");
        copy.width = CANVAS;
        copy.height = CANVAS;
        const context = copy.getContext("2d")!;
        context.drawImage(canvas, 0, 0);
        const pixels = context.getImageData(0, 0, CANVAS, CANVAS).data;
        /** Pixels of each set's colour, and none drawn, over the middle of a building's roof (a 6 m square). */
        return (building: StructureRecord) => {
          const counts = { near: 0, far: 0, open: 0, clear: 0 };
          const pixelsPerMetre = CANVAS / (2 * HALF);
          for (let dz = -3; dz < 3; dz += 1 / pixelsPerMetre) {
            for (let dx = -3; dx < 3; dx += 1 / pixelsPerMetre) {
              // Mirrored probes do not care which way the screen's x runs.
              const column = Math.round(((building.x + dx) / (2 * HALF) + 0.5) * (CANVAS - 1));
              const row = Math.round((0.5 - (building.z + dz) / (2 * HALF)) * (CANVAS - 1));
              const index = (row * CANVAS + column) * 4;
              const rgb = [pixels[index]!, pixels[index + 1]!, pixels[index + 2]!];
              if (isClear(rgb)) counts.clear += 1;
              else if (rgb[0]! > rgb[1]! && rgb[0]! > rgb[2]!) counts.near += 1;
              else if (rgb[2]! > rgb[0]! && rgb[2]! > rgb[1]!) counts.far += 1;
              else counts.open += 1;
            }
          }
          return counts;
        };
      };

      // From 300 m up, over the middle: nothing is opened.
      let seen = await render({ x: 0, y: 300, z: 0 });
      expect(errors.join(" | ")).toBe("");
      // Whichever way the screen runs x and z: the near building (off the
      // middle in x only) and the far one (in z only) must be found.
      const mirrorX = seen(near).clear > 0;
      const mirrorZ = seen(far).clear > 0;
      const probe = (building: StructureRecord) => seen({
        ...building,
        x: mirrorX ? -building.x : building.x,
        z: mirrorZ ? -building.z : building.z,
      });
      expect(probe(near).near).toBeGreaterThan(0);
      expect(probe(near).far + probe(near).clear).toBe(0);
      expect(probe(far).far).toBeGreaterThan(0);
      expect(probe(far).near + probe(far).clear).toBe(0);
      expect(probe(beyond).clear).toBeGreaterThan(0);
      expect(probe(beyond).near + probe(beyond).far).toBe(0);
      // Half way through the band: both sets, on pixels that make the roof whole.
      const handoff = probe(band);
      expect(handoff.near).toBeGreaterThan(handoff.far * 0.4);
      expect(handoff.far).toBeGreaterThan(handoff.near * 0.4);
      expect(handoff.clear).toBe(0);
      expect(system.statistics.drawnOpen).toBe(0);

      // From beside the near building, on the ground: it is drawn open, and its shell is gone.
      seen = await render({ x: near.x + 10, y: 1.5, z: near.z });
      expect(system.statistics.drawnOpen).toBe(1);
      expect(probe(near).open).toBeGreaterThan(0);
      expect(probe(near).near + probe(near).clear).toBe(0);
      expect(errors.join(" | ")).toBe("");

      // A region gone after the first draws: the sets are rebuilt and redrawn.
      system.apply([], ["settlements:0:0"]);
      seen = await render({ x: 0, y: 300, z: 0 });
      for (const building of [near, band, far]) {
        expect(probe(building).near + probe(building).far + probe(building).open).toBe(0);
      }
      expect(system.statistics.visibleBuildings).toBe(0);
      system.dispose();
      scene.dispose();
    } finally {
      console.warn = warn;
      console.error = error;
      engine.dispose();
      canvas.remove();
    }
  }, 60_000);

  it("compile textured on the placeholders, then draw the kit's arrays as detail about the parts' colours", async () => {
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
      scene.useRightHandedSystem = true;
      scene.performancePriority = ScenePerformancePriority.Intermediate;
      scene.autoClear = true;
      scene.clearColor = new Color4(CLEAR[0] / 255, CLEAR[1] / 255, CLEAR[2] / 255, 1);
      // Ten pixels a metre over one house's roof, from straight above.
      const camera = new FreeCamera("top", new Vector3(0, 60, 0), scene);
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      camera.orthoLeft = -12;
      camera.orthoRight = 12;
      camera.orthoTop = 12;
      camera.orthoBottom = -12;
      camera.minZ = 1;
      camera.maxZ = 200;
      camera.upVector = new Vector3(0, 0, 1);
      camera.setTarget(Vector3.Zero());
      scene.activeCamera = camera;
      new HemisphericLight("sky", new Vector3(0.3, 1, 0.2), scene).intensity = 1.5;

      // The kit's builds as they are; the arrays held until the test lets them land.
      const inline = new InlineStructureMeshBuilder();
      let land: (plans: StructureTexturePlans) => void = () => {};
      const builder: StructureMeshBuilder = {
        build: (set, records, originX, originZ) => inline.build(set, records, originX, originZ),
        textures: () => new Promise((resolve) => { land = resolve; }),
        dispose: () => inline.dispose(),
      };
      const system = new StructureSystem(scene, {
        structureNearRadiusMeters: 400,
        structureFarRadiusMeters: 2_000,
        structureOpenBuildings: 2,
        structureNearCastsShadows: false,
        structureTextureEdge: 256,
      }, builder);
      system.setFloatingOrigin(0, 0);
      system.apply([{ key: "settlements:0:0", structures: [record(1, 0, 0)] }], []);
      const at = { x: 0, y: 300, z: 0 };

      /**
       * Luminance over the middle of the roof (a 10 m square): its mean, and
       * its grain (the mean step between neighbouring pixels, which the roof's
       * ridge and pitches barely touch but the layers' courses do).
       */
      const frame = async () => {
        for (let pass = 0; pass < 6; pass += 1) {
          system.update(at);
          await Promise.resolve();
          await Promise.resolve();
          engine.beginFrame();
          scene.render();
          engine.endFrame();
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        system.update(at);
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        const copy = document.createElement("canvas");
        copy.width = CANVAS;
        copy.height = CANVAS;
        const context = copy.getContext("2d")!;
        context.drawImage(canvas, 0, 0);
        const pixels = context.getImageData(0, 0, CANVAS, CANVAS).data;
        const luminance = (row: number, column: number) => {
          const index = (row * CANVAS + column) * 4;
          return 0.2126 * pixels[index]! + 0.7152 * pixels[index + 1]! + 0.0722 * pixels[index + 2]!;
        };
        let clear = 0;
        let sum = 0;
        let steps = 0;
        let count = 0;
        for (let row = HALF - 50; row < HALF + 50; row += 1) {
          for (let column = HALF - 50; column < HALF + 50; column += 1) {
            const index = (row * CANVAS + column) * 4;
            const rgb = [pixels[index]!, pixels[index + 1]!, pixels[index + 2]!];
            if (rgb.every((value, channel) => Math.abs(value - CLEAR[channel]!) < 3)) clear += 1;
            sum += luminance(row, column);
            steps += Math.abs(luminance(row, column + 1) - luminance(row, column)) + Math.abs(luminance(row + 1, column) - luminance(row, column));
            count += 1;
          }
        }
        return { mean: sum / count, grain: steps / (2 * count), clear };
      };

      const flat = await frame();
      expect(errors.join(" | ")).toBe("");
      expect(system.pendingWork).toBe(1);
      expect(flat.clear).toBe(0);
      land(structureTexturePlans(256));
      const textured = await frame();
      expect(errors.join(" | ")).toBe("");
      expect(system.pendingWork).toBe(0);
      expect(system.statistics.textureEdge).toBe(256);
      expect(textured.clear).toBe(0);
      // Detail: the roof's courses and their shading, where the placeholders drew it plain.
      expect(textured.grain).toBeGreaterThan(flat.grain * 5 + 1);
      // About the parts' colours: the layers average mid-grey, so the roof's mean holds.
      expect(Math.abs(textured.mean - flat.mean)).toBeLessThan(flat.mean * 0.25);
      system.dispose();
      scene.dispose();
    } finally {
      console.warn = warn;
      console.error = error;
      engine.dispose();
      canvas.remove();
    }
  }, 60_000);
  it("light a lit building's windows warm at night, on Low and on the kit's arrays, and none with the share at 0", async () => {
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
      scene.useRightHandedSystem = true;
      scene.performancePriority = ScenePerformancePriority.Intermediate;
      scene.autoClear = true;
      scene.clearColor = new Color4(0, 0, 0, 1);
      // The house's front (it faces +z) from 60 m off, past the open radius: its closed shell.
      const camera = new FreeCamera("front", new Vector3(0, 3, 60), scene);
      camera.fov = 0.4;
      camera.minZ = 0.5;
      camera.maxZ = 500;
      camera.setTarget(new Vector3(0, 2.5, 0));
      scene.activeCamera = camera;
      // Moonlight, near enough: the walls barely show.
      new HemisphericLight("sky", new Vector3(0.3, 1, 0.2), scene).intensity = 0.02;

      const warmPixels = async (system: StructureSystem) => {
        const at = { x: 0, y: 3, z: 60 };
        for (let pass = 0; pass < 6; pass += 1) {
          system.update(at);
          await Promise.resolve();
          await Promise.resolve();
          engine.beginFrame();
          scene.render();
          engine.endFrame();
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        // Read back in the frame's own task: a presented canvas reads empty.
        system.update(at);
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        const copy = document.createElement("canvas");
        copy.width = CANVAS;
        copy.height = CANVAS;
        const context = copy.getContext("2d")!;
        context.drawImage(canvas, 0, 0);
        const pixels = context.getImageData(0, 0, CANVAS, CANVAS).data;
        let warm = 0;
        let lit = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          const [r, g, b] = [pixels[index]!, pixels[index + 1]!, pixels[index + 2]!];
          if (r > 60) lit += 1;
          if (r > 60 && r > g && g > b && r > b + 30) warm += 1;
        }
        return { warm, lit };
      };

      for (const structureTextureEdge of [0, 256] as const) {
        const inline = new InlineStructureMeshBuilder();
        const system = new StructureSystem(scene, {
          structureNearRadiusMeters: 400,
          structureFarRadiusMeters: 2_000,
          structureOpenBuildings: 2,
          structureNearCastsShadows: false,
          structureTextureEdge,
        }, inline);
        system.setFloatingOrigin(0, 0);
        system.apply([{ key: "settlements:0:0", structures: [record(1, 0, 0)] }], []);
        // Brighter than the real 60 cd/m², which needs the renderer's night exposure to show.
        system.setNight({ litFraction: 1, windowScene: 0.4, lampScene: 0.2 });
        const on = await warmPixels(system);
        system.setNight({ litFraction: 0, windowScene: 0.4, lampScene: 0.2 });
        const shareZero = await warmPixels(system);
        system.setNight(STRUCTURE_NIGHT_OFF);
        const off = await warmPixels(system);
        expect(errors.join(" | ")).toBe("");
        expect(system.statistics.nearBuildings).toBe(1);
        expect(system.statistics.drawnOpen).toBe(0);
        // The windows: a few hundred pixels at this size, warm.
        expect(on.warm, `edge ${structureTextureEdge}`).toBeGreaterThan(150);
        expect(shareZero.lit).toBe(0);
        expect(off.lit).toBe(0);
        system.dispose();
      }
      scene.dispose();
    } finally {
      console.warn = warn;
      console.error = error;
      engine.dispose();
      canvas.remove();
    }
  }, 60_000);
});
