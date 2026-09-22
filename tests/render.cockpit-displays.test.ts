import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE } from "../src/game/types";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import { airlinerScreenPlacements } from "../src/render/webgpu/aircraft/cockpit/airlinerCockpit";
import {
  DISPLAY_ATLAS_HEIGHT,
  DISPLAY_ATLAS_WIDTH,
  DISPLAY_SLOT_ORDER,
  DISPLAY_SLOT_PIXELS,
  displaySlots,
  paintStubAtlas,
  type DisplayAtlas,
  type DisplayContext2D,
} from "../src/render/webgpu/aircraft/cockpit/displays/displayAtlas";
import { displayStateFrom } from "../src/render/webgpu/aircraft/cockpit/displays/displayState";
import type { AircraftVisual } from "../src/render/webgpu/aircraft/types";

/**
 * The six displays: which screen samples which slot, and that the whole live path runs without a GPU.
 *
 * THE HEADLESS PATH IS THE DEFAULT HERE, and deliberately so. Every Node test builds under
 * `NullEngine`, which has no 2D canvas, so `createDisplayAtlas` returns null and the screens keep
 * their flat material. That is asserted rather than assumed: a suite that silently drew nothing
 * would look exactly like a suite whose displays work.
 *
 * The drawing itself is covered without an engine at all, by running the painter against a RECORDING
 * context. That is the same shape the drawing module's own tests use, so the page code and this
 * integration meet on one interface.
 */

let engine: NullEngine;
let scene: Scene;
let aircraft: AircraftVisual;

function named(name: string): AbstractMesh {
  const found = scene.getMeshByName(name);
  if (!found) throw new Error(`missing mesh ${name}`);
  return found;
}

beforeAll(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.activeCamera = new UniversalCamera("displays-camera", Vector3.Zero(), scene);
  aircraft = createWebGpuAircraft(scene, "airliner");
  aircraft.root.computeWorldMatrix(true);
  for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
});
afterAll(() => {
  aircraft.dispose();
  scene.dispose();
  engine.dispose();
});

describe("the 747's displays, headless", () => {
  it("keeps the screens on their flat material where there is no 2D canvas, and says so", () => {
    expect(aircraft.displaysLive, "NullEngine has no 2D canvas, so nothing should be drawing").toBe(false);
    // the screens still share the instrument-face material the bezel-less boxes were built with:
    // one mesh, one material, exactly as before the displays existed
    const screens = named("airliner-screens");
    expect(screens.material).not.toBeNull();
    expect(screens.material!.name).toBe("airliner-instrument-face");
    // and updating in cockpit view must not throw when there is no atlas to draw into
    aircraft.setCockpitView(true);
    expect(() => aircraft.update({ ...INITIAL_VISUAL_STATE, bank: 12, pitch: -3 }, 1 / 60)).not.toThrow();
    aircraft.setCockpitView(false);
  });

  it("gives each screen its own slot of the atlas, in the order the screens are built", () => {
    // Measured off the MERGED mesh, which is what samples the texture: for each screen, the four
    // vertices of its pilot-facing face (normal -X) must carry the u range of its own slot. This is
    // the pairing a swapped slot table would break, and the frames would then show the PFD's picture
    // on the ND.
    const screens = named("airliner-screens");
    const positions = screens.getVerticesData(VertexBuffer.PositionKind)!;
    const normals = screens.getVerticesData(VertexBuffer.NormalKind)!;
    const uvs = screens.getVerticesData(VertexBuffer.UVKind)!;
    const placements = airlinerScreenPlacements();
    expect(placements).toHaveLength(DISPLAY_SLOT_ORDER.length);
    const slots = displaySlots();
    for (const [index, placement] of placements.entries()) {
      // the face's vertices: normal -X, and at this screen's own z
      const us: number[] = [];
      for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
        if (normals[vertex * 3]! > -0.9) continue;
        if (Math.abs(positions[vertex * 3 + 2]! - placement.centre.z) > 0.12) continue;
        us.push(uvs[vertex * 2]!);
      }
      expect(us.length, `${placement.name}: pilot-facing vertices`).toBe(4);
      const slot = slots[index]!;
      expect(slot.name, `slot ${index} belongs to ${placement.name}`).toBe(placement.name);
      expect(Math.min(...us)).toBeCloseTo(slot.x / DISPLAY_ATLAS_WIDTH, 6);
      expect(Math.max(...us)).toBeCloseTo((slot.x + slot.width) / DISPLAY_ATLAS_WIDTH, 6);
    }
  });

  it("costs no extra draw: still one screens mesh on one material", () => {
    const screenMeshes = aircraft.meshes.filter((mesh) => /^airliner-screen/.test(mesh.name));
    expect(screenMeshes.map((mesh) => mesh.name).sort()).toEqual(["airliner-screen-bezels", "airliner-screens"]);
    // six screens in one mesh, six bezels in another, as before the atlas
    expect((named("airliner-screens").metadata as { mergedFrom?: string[] }).mergedFrom).toHaveLength(6);
  });
});

describe("the 747's displays, drawn", () => {
  /** The recording context: what the drawing module's own tests use, so both meet on one interface. */
  function recorder(): { context: DisplayContext2D; calls: { style: string; rect: number[] }[] } {
    const calls: { style: string; rect: number[] }[] = [];
    const context: DisplayContext2D = {
      fillStyle: "",
      fillRect(x, y, width, height) {
        calls.push({ style: this.fillStyle, rect: [x, y, width, height] });
      },
    };
    return { context, calls };
  }

  it("runs the adapter and the painter over all six slots without an engine", () => {
    const { context, calls } = recorder();
    const atlas = {
      slots: displaySlots(),
      context,
      width: DISPLAY_ATLAS_WIDTH,
      height: DISPLAY_ATLAS_HEIGHT,
    } as unknown as DisplayAtlas;
    const state = displayStateFrom(
      { ...INITIAL_VISUAL_STATE, airspeed: 128.6, altitude: 3_048, heading: 237.5, bank: 18.5 },
      { engineCount: 4, fullFlapDegrees: 30 },
    );
    paintStubAtlas(atlas, state);
    // every slot filled, each at its own x, none overlapping and none outside the atlas
    const fills = calls.filter((call) => call.rect[2] === DISPLAY_SLOT_PIXELS);
    expect(fills).toHaveLength(DISPLAY_SLOT_ORDER.length);
    const xs = fills.map((call) => call.rect[0]!);
    expect(xs).toEqual([0, 256, 512, 768, 1024, 1280]);
    expect(new Set(fills.map((call) => call.style)).size, "each slot is a different colour").toBe(6);
    for (const call of calls) {
      expect(call.rect[0]!).toBeGreaterThanOrEqual(0);
      expect(call.rect[0]! + call.rect[2]!).toBeLessThanOrEqual(DISPLAY_ATLAS_WIDTH);
      expect(call.rect[1]! + call.rect[3]!).toBeLessThanOrEqual(DISPLAY_ATLAS_HEIGHT);
    }
    // the corner mark that proves the face is not mirrored once a frame is shot
    expect(calls.length).toBeGreaterThan(fills.length);
  });
});
