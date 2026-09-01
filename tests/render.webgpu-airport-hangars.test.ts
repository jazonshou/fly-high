import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import { AirportSystem } from "../src/render/webgpu/detail/AirportSystem";
import { createWorld } from "../src/world/world";
import {
  HANGAR_SHADOW_CASTING_SURFACES,
  HANGAR_SITING,
  hangarPlanFrom,
  hangarShellGeometry,
} from "../src/render/webgpu/airfield/AirfieldStructures";

/**
 * `7-10`: the hangars reach the renderer's registries THROUGH `AirportSystem`.
 *
 * **This is the live path, and it is a different assertion from the builder's
 * own test.** `render.webgpu-hangar-build.test.ts` proves `buildHangar` parents
 * onto a root it is handed. It says nothing about whether `AirportSystem` calls
 * it, calls it eagerly, or hands it the right root — and a bridge that built
 * lazily or reparented afterwards would pass that test while losing cloud
 * shadows and aerial perspective here.
 *
 * `FlightRenderer` registers airport meshes exactly once, at construction:
 * `shadowCasters` is frozen in this constructor, and `root.getChildMeshes(false)`
 * is walked for the cloud-shadow and aerial-perspective registries. A mesh that
 * misses those joins none of them and **there is no error** — it draws, unlit
 * by cloud shadow and unhazed, visible only in a capture.
 *
 * **What this does NOT cover:** `NullEngine` rasterises nothing, so nothing
 * here says a hangar is visible or correctly shaded. And it asserts the meshes
 * are REGISTERED, not that the registries then do anything with them.
 */

function system() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  // `scene.render()` throws without one, and the eager-build check needs a
  // real render to prove nothing is created on first frame.
  scene.activeCamera = new FreeCamera("probe", new Vector3(0, 5, -20), scene);
  const world = createWorld("hangar-bridge");
  const airport = world.airport;
  if (!airport) throw new Error("world has no airport");
  // A ground function that FALLS AWAY across the footprint, so seating has
  // something to do. A flat stub would let centre-point seating pass too.
  const ground = (x: number, z: number): number => airport.elevation - 4 + (x % 7) * 0.3 + (z % 5) * 0.2;
  const built = new AirportSystem(scene, airport, ground, world.seedHash);
  return {
    scene, airport, world, system: built,
    dispose: () => { built.dispose(); scene.dispose(); engine.dispose(); },
  };
}

const hangarMeshes = (names: readonly string[]) =>
  names.filter((name) => name.startsWith("airport-hangar-"));

/**
 * The surfaces the shell builder emits, asked of the builder rather than
 * listed. `AirportSystem` makes one mesh per group, so this is the per-hangar
 * mesh count for any plan — the group set does not vary with bay count or roof
 * profile, only the triangles inside it do.
 */
const SHELL_SURFACES = [
  ...new Set(hangarShellGeometry(hangarPlanFrom(1, 0, 1)).groups.map((g) => g.surface)),
];

describe("hangars reach the registries through AirportSystem", () => {
  it("puts every hangar mesh in the walk FlightRenderer actually performs", () => {
    const host = system();
    try {
      const walked = hangarMeshes(host.system.root.getChildMeshes(false).map((m) => m.name));
      // DERIVED from the surfaces the shell builder actually emits, not the
      // two this test was written against. The literal `* 2` here broke when
      // `7-10` added glazing — a true failure carrying no information, because
      // the number was incidental to the property (every surface of every
      // hangar is reachable from the root) and the property was not checked.
      expect(
        walked.length,
        "hangar meshes are missing from `root.getChildMeshes(false)`, so they would "
          + "take neither cloud shadows nor aerial perspective, with no error",
      ).toBe(HANGAR_SITING.count * SHELL_SURFACES.length);
      for (let index = 0; index < HANGAR_SITING.count; index += 1) {
        for (const surface of SHELL_SURFACES) {
          expect(walked).toContain(`airport-hangar-${index}-${surface}`);
        }
      }
    } finally {
      host.dispose();
    }
  });

  it("puts every hangar mesh in the frozen shadowCasters array", () => {
    const host = system();
    try {
      const casters = hangarMeshes(host.system.shadowCasters.map((m) => m.name));
      expect(
        casters.length,
        "hangar meshes cast no sun shadow — `shadowCasters` is frozen in the "
          + "constructor, so anything built after it is never added",
      ).toBe(HANGAR_SITING.count * HANGAR_SHADOW_CASTING_SURFACES.length);

      // THE PROPERTY THE COUNT CANNOT EXPRESS, and the one that changed: the
      // glazing DRAWS but does not CAST. `HANGAR_SITING.count * 2` was still
      // arithmetically right after `7-10` — 3 hangars times 2 casting surfaces
      // — so it stayed green while saying nothing about the exclusion that had
      // just been introduced. A count that survives the change it should have
      // been watching is not watching it.
      const walked = hangarMeshes(host.system.root.getChildMeshes(false).map((m) => m.name));
      for (let index = 0; index < HANGAR_SITING.count; index += 1) {
        expect(
          walked,
          `hangar ${index} has no glazing to exclude, so the exclusion below `
          + "proves nothing",
        ).toContain(`airport-hangar-${index}-glass`);
        expect(
          casters,
          `hangar ${index}'s glazing casts a shadow — it stands 6 cm off a wall `
          + "that already casts, and costs a draw per hangar per frame",
        ).not.toContain(`airport-hangar-${index}-glass`);
      }
    } finally {
      host.dispose();
    }
  });

  it("builds eagerly — rendering adds no hangar meshes", () => {
    const host = system();
    try {
      const before = host.system.root.getChildMeshes(false).length;
      host.scene.render();
      host.scene.render();
      expect(
        host.system.root.getChildMeshes(false).length,
        "meshes appeared after the first render, so they missed every registry",
      ).toBe(before);
    } finally {
      host.dispose();
    }
  });

  it("leaves no CreateBox placeholder behind", () => {
    const host = system();
    try {
      // Gate 7D's exit criterion, asserted on the ARTIFACT rather than on the
      // source: the old placeholders were named `airport-hangar-N` with no
      // surface suffix, so a survivor is visible by name.
      const names = host.system.root.getChildMeshes(false).map((m) => m.name);
      const placeholders = names.filter((name) => /^airport-hangar-\d+$/u.test(name));
      expect(placeholders, "a placeholder box survived the 7-10 bridge").toEqual([]);
    } finally {
      host.dispose();
    }
  });

  it("publishes one attachment set per hangar, in index order", () => {
    const host = system();
    try {
      expect(host.system.hangarAttachments.length).toBe(HANGAR_SITING.count);
      for (const mounts of host.system.hangarAttachments) {
        expect(mounts.roofPerimeter.length).toBe(4);
        expect(mounts.ridgeEnds.length).toBe(2);
        expect(mounts.heightMeters).toBeGreaterThan(0);
      }
      // Distinct hangars sit at distinct positions along the runway, so a
      // bridge that published the same set three times fails here.
      const alongs = new Set(host.system.hangarAttachments.map((m) => m.ridgeEnds[0]![2]));
      expect(alongs.size).toBe(HANGAR_SITING.count);
    } finally {
      host.dispose();
    }
  });

  it("seats each hangar on its own ground, not on the datum", () => {
    const host = system();
    try {
      // The stub ground sits below the datum everywhere, so a hangar pinned to
      // `elevation` would have a slab at exactly 0 in local terms. Every node
      // must be below that.
      const nodes = host.system.root.getChildren()
        .filter((node) => /^airport-hangar-\d+$/u.test(node.name));
      expect(nodes.length).toBe(HANGAR_SITING.count);
      for (const node of nodes) {
        expect(
          (node as TransformNode).position.y,
          `${node.name} sits at the datum — the ground query is not reaching it`,
        ).toBeLessThan(0);
      }
    } finally {
      host.dispose();
    }
  });
});
