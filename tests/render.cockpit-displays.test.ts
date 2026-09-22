import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE } from "../src/game/types";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import { AIRLINER_SCREENS, airlinerScreenPlacements } from "../src/render/webgpu/aircraft/cockpit/airlinerCockpit";
import {
  DISPLAY_ATLAS_HEIGHT,
  DISPLAY_ATLAS_WIDTH,
  DISPLAY_SCREENS,
  DISPLAY_SLOT_HEIGHT,
  DISPLAY_SLOT_WIDTH,
  displaySlots,
} from "../src/render/webgpu/aircraft/cockpit/displays/displayAtlas";
import { drawDisplayAtlas } from "../src/render/webgpu/aircraft/cockpit/displays/displayPages";
import { displayStateFromVisual } from "../src/render/webgpu/aircraft/cockpit/displays/displayStateFromVisual";
import { createRecordingContext } from "./support/recordingContext";
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
    expect(placements).toHaveLength(DISPLAY_SCREENS.length);
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
      expect(slot.screen, `slot ${index} belongs to ${placement.name}`).toBe(placement.name);
      expect(Math.min(...us)).toBeCloseTo(slot.x / DISPLAY_ATLAS_WIDTH, 6);
      expect(Math.max(...us)).toBeCloseTo((slot.x + slot.w) / DISPLAY_ATLAS_WIDTH, 6);
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
  it("runs the adapter and all four page kinds over the six slots without an engine", () => {
    // The live path, covered with no GPU and no canvas: the same recording context the pages' own
    // tests use, so the page code and this integration meet on one interface.
    const context = createRecordingContext();
    const slots = displaySlots();
    const state = displayStateFromVisual(
      { ...INITIAL_VISUAL_STATE, airspeed: 128.6, altitude: 3_048, heading: 237.5, bank: 18.5, engineRpm: 88 },
      { engineCount: 4, fullFlapDegrees: 30 },
    );
    drawDisplayAtlas(context, DISPLAY_ATLAS_WIDTH, DISPLAY_ATLAS_HEIGHT, slots, state);

    // every slot was drawn into: each one clips to its own rectangle first
    const clipRects = context.calls
      .filter((call) => call.method === "rect")
      .map((call) => call.args.map(Number));
    for (const slot of slots) {
      expect(
        clipRects.some(([x, y, w, h]) => x === slot.x && y === slot.y && w === slot.w && h === slot.h),
        `${slot.screen} (${slot.page}) was not clipped to its own rectangle`,
      ).toBe(true);
    }
    // all four page kinds appear, and the six slots cover the atlas exactly
    expect(new Set(slots.map((slot) => slot.page))).toEqual(
      new Set(["pfd", "nd", "eicas-upper", "eicas-lower"]),
    );
    const covered = slots.reduce((sum, slot) => sum + slot.w * slot.h, 0);
    expect(covered).toBe(DISPLAY_ATLAS_WIDTH * DISPLAY_ATLAS_HEIGHT);
    // and nothing was drawn outside the atlas
    for (const [x, y, w, h] of clipRects) {
      expect(x!).toBeGreaterThanOrEqual(0);
      expect(x! + w!).toBeLessThanOrEqual(DISPLAY_ATLAS_WIDTH);
      expect(y! + h!).toBeLessThanOrEqual(DISPLAY_ATLAS_HEIGHT);
    }
  });

  it("draws each screen the page its NAME says, so a swapped slot table cannot pass", () => {
    // The screens are named for what they are, and that is the only ground truth for which page
    // belongs on which: a pilot's `-pfd` screen must draw the PFD. Pairing screens to RECTANGLES is
    // not enough -- swapping two `page` values leaves every rectangle and every UV untouched, and a
    // mutation that put the PFD's picture on the ND passed the whole suite until this existed.
    const expected: Readonly<Record<string, string>> = {
      "port-pfd": "pfd",
      "starboard-pfd": "pfd",
      "port-nd": "nd",
      "starboard-nd": "nd",
      // the two centre screens are the EICAS pair, upper on the port side as the panel is laid out
      "port-eicas": "eicas-upper",
      "starboard-eicas": "eicas-lower",
    };
    const slots = displaySlots();
    expect(slots.map((slot) => slot.screen).sort()).toEqual(Object.keys(expected).sort());
    for (const slot of slots) {
      expect(slot.page, `${slot.screen} draws the wrong page`).toBe(expected[slot.screen]);
    }
    // and each screen's name matches the placement it was built from, so the table cannot drift
    // from the geometry either
    for (const [index, placement] of airlinerScreenPlacements().entries()) {
      expect(slots[index]!.screen).toBe(placement.name);
    }
  });

  it("gives every slot the screens' own shape, not a square", () => {
    // The screens are 0.22 x 0.15 m. A square slot squashes every page, whatever its resolution.
    const screen = AIRLINER_SCREENS.width / AIRLINER_SCREENS.height;
    expect(DISPLAY_SLOT_WIDTH / DISPLAY_SLOT_HEIGHT).toBeCloseTo(screen, 2);
    for (const slot of displaySlots()) expect(slot.w / slot.h).toBeCloseTo(screen, 2);
  });
});
