import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { DEFAULT_AIRPORT } from "../src/world/airport";
import { AIRFIELD_ASPECT_V_START } from "../src/render/webgpu/airfield/AirfieldMaterials";
import {
  AIRFIELD_STRUCTURE_LOD,
  buildHangar,
  hangarAttachments,
  hangarDetailBoxes,
  hangarPlanFrom,
  hangarShellGeometry,
} from "../src/render/webgpu/airfield/AirfieldStructures";

/**
 * `7-10`: the hangar's meshes reach the renderer's registries.
 *
 * **This closes the gap the geometry pins could not.** Every seating and shell
 * assertion stays green while nothing is built at all — they test arithmetic.
 * `FlightRenderer` populates the cloud-shadow and aerial-perspective registries
 * from `airport.root.getChildMeshes(false)` ONCE at construction, and freezes
 * `shadowCasters` in the same pass, so a generator that builds lazily or
 * reparents afterwards misses both **with no error**: the hangar draws and
 * silently takes neither cloud shadows nor aerial perspective.
 *
 * So these assert against the REGISTRY SURFACE — what `getChildMeshes` returns
 * — rather than against a list the builder hands back about itself.
 *
 * **What they do NOT cover:** `NullEngine` compiles no shaders and rasterises
 * nothing, so nothing here says the hangar is VISIBLE or correctly shaded. It
 * says the meshes exist, are parented, carry geometry, and would be found by
 * the walk the renderer actually performs.
 */

function scene(): { scene: Scene; dispose: () => void } {
  const engine = new NullEngine();
  const created = new Scene(engine);
  // `scene.render()` throws without one, and the eager-build test needs a real
  // render to prove nothing is created lazily.
  created.activeCamera = new FreeCamera("probe", new Vector3(0, 5, -20), created);
  return {
    scene: created,
    dispose: () => {
      created.dispose();
      engine.dispose();
    },
  };
}

function build(host: Scene, root: TransformNode, index: number) {
  const plan = hangarPlanFrom(1_234, index, 2.5);
  const attachments = hangarAttachments(DEFAULT_AIRPORT, index, plan, DEFAULT_AIRPORT.elevation + 3);
  const materials = {
    metal: new StandardMaterial("metal", host),
    concrete: new StandardMaterial("concrete", host),
    glass: new StandardMaterial("glass", host),
  };
  return { plan, built: buildHangar(host, root, index, plan, attachments, materials), materials };
}

describe("hangar meshes reach the renderer's registries", () => {
  it("is findable by the walk FlightRenderer actually performs", () => {
    const host = scene();
    try {
      const root = new TransformNode("airport", host.scene);
      const { built } = build(host.scene, root, 0);
      // THE ASSERTION THAT MATTERS: not "the builder returned meshes" but "the
      // renderer's own walk finds them". Those differ exactly when a mesh is
      // parented somewhere else, which is the silent failure.
      const walked = root.getChildMeshes(false);
      for (const mesh of built.meshes) {
        expect(walked, `${mesh.name} is not reachable from airport.root`).toContain(mesh);
      }
      expect(walked.length).toBeGreaterThanOrEqual(built.meshes.length);
    } finally {
      host.dispose();
    }
  });

  it("builds eagerly — a later render adds no meshes", () => {
    const host = scene();
    try {
      const root = new TransformNode("airport", host.scene);
      build(host.scene, root, 0);
      const afterBuild = root.getChildMeshes(false).length;
      // The registries are populated once at construction. Anything created on
      // a first render would never be registered.
      host.scene.render();
      host.scene.render();
      expect(
        root.getChildMeshes(false).length,
        "meshes appeared after the first render — they would miss both registries",
      ).toBe(afterBuild);
    } finally {
      host.dispose();
    }
  });

  it("costs one draw per surface, not one per part", () => {
    const host = scene();
    try {
      const root = new TransformNode("airport", host.scene);
      const { built, plan } = build(host.scene, root, 0);
      // Asserted as a PROPERTY, not a count. The first version of this pinned
      // `toBe(2)` and broke the moment `7-10` added glazing — a true failure
      // that carried no information, because the number it defended was
      // incidental and the rule it meant to defend was not being checked at
      // all. What matters is that mesh count tracks MATERIALS and not PARTS.
      const surfaces = new Set(hangarShellGeometry(plan).groups.map((g) => g.surface));
      expect(built.meshes.length).toBe(surfaces.size);
      const names = built.meshes.map((m) => m.name).sort();
      expect(names).toEqual([...surfaces].map((s) => `airport-hangar-0-${s}`).sort());

      // The rule with teeth: a per-part build would cost one draw per solid,
      // and there are dozens. This is the comparison the count was standing in
      // for, and unlike the count it stays true as detail grows.
      const parts = hangarDetailBoxes(plan).length;
      expect(parts, "the detail pass emits no solids").toBeGreaterThan(10);
      expect(
        built.meshes.length,
        "mesh count is tracking parts rather than materials",
      ).toBeLessThan(parts);
    } finally {
      host.dispose();
    }
  });

  it("keeps the glazing out of the caster list and everything else in", () => {
    const host = scene();
    try {
      const root = new TransformNode("airport", host.scene);
      const { built } = build(host.scene, root, 0);
      const casterNames = built.shadowCasters.map((m) => m.name).sort();
      // Every caster is also a mesh — a caster that is not in the scene graph
      // would be a dangling registration.
      for (const caster of built.shadowCasters) {
        expect(built.meshes, `${caster.name} casts but is not a built mesh`).toContain(caster);
      }
      expect(casterNames).toEqual([
        "airport-hangar-0-concrete",
        "airport-hangar-0-metal",
      ]);

      // NON-VACUITY: the glazing must actually EXIST to have been excluded.
      // Without this the assertion above passes just as well on a build that
      // never made a glass mesh at all — which is the same green-by-absence
      // shape as a guard whose case list is empty.
      expect(
        built.meshes.map((m) => m.name),
        "no glass mesh was built, so excluding it from the casters proves nothing",
      ).toContain("airport-hangar-0-glass");

      // `82c4182` measured 2.00 draws per hangar mesh inside the LOD cull, so
      // this exclusion is worth exactly one draw per hangar per frame.
      expect(built.shadowCasters.length).toBe(built.meshes.length - 1);
    } finally {
      host.dispose();
    }
  });

  it("carries real geometry on every mesh", () => {
    const host = scene();
    try {
      const root = new TransformNode("airport", host.scene);
      const { built } = build(host.scene, root, 0);
      for (const mesh of built.meshes) {
        expect(mesh.getTotalVertices(), `${mesh.name} has no vertices`).toBeGreaterThan(0);
        expect(mesh.getTotalIndices(), `${mesh.name} has no indices`).toBeGreaterThan(0);
        expect(mesh.isVerticesDataPresent("uv"), `${mesh.name} has no UVs`).toBe(true);
      }
    } finally {
      host.dispose();
    }
  });

  it("installs the cull distance as a real LOD level", () => {
    const host = scene();
    try {
      const root = new TransformNode("airport", host.scene);
      const { built } = build(host.scene, root, 0);
      for (const mesh of built.meshes) {
        const levels = mesh.getLODLevels();
        expect(levels.length, `${mesh.name} has no LOD level`).toBeGreaterThan(0);
        // Asserted on the MESH, not on our constant — a constant nothing reads
        // is decorative, and this is what makes it load-bearing.
        expect(levels[0]!.distanceOrScreenCoverage)
          .toBe(AIRFIELD_STRUCTURE_LOD.cullDistanceMeters);
        expect(levels[0]!.mesh, "the far level should draw nothing").toBeNull();
      }
    } finally {
      host.dispose();
    }
  });
});

describe("the UV contract 7-11's weathering depends on", () => {
  it("runs V downward, so streaks read as gravity", () => {
    // 7-11 bakes a vertical ageing gradient into the tile and relies on V
    // increasing DOWNWARD. If this inverted, every rust streak would run up.
    const plan = hangarPlanFrom(1_234, 0, 2.5);
    const shell = hangarShellGeometry(plan);
    let checked = 0;
    for (let i = 0; i < shell.positions.length / 3; i += 4) {
      const ys = [0, 1, 2, 3].map((k) => shell.positions[(i + k) * 3 + 1]!);
      const vs = [0, 1, 2, 3].map((k) => shell.uvs[(i + k) * 2 + 1]!);
      const top = ys.indexOf(Math.max(...ys));
      const bottom = ys.indexOf(Math.min(...ys));
      if (Math.abs(ys[top]! - ys[bottom]!) < 1e-9) continue; // horizontal face
      expect(vs[bottom]!, "V does not increase downward").toBeGreaterThan(vs[top]!);
      checked += 1;
    }
    expect(checked, "no vertical face was checked — the assertion is vacuous").toBeGreaterThan(0);
  });

  it("ages the face away from the runway more than the face toward it", () => {
    // The aspect table's whole claim: the face the airfield sees gets
    // repainted, the back face weathers. That is a V-range START, so the back
    // face begins deeper into the ageing gradient.
    const plan = hangarPlanFrom(1_234, 0, 2.5);
    const shell = hangarShellGeometry(plan);
    const startFor = (sign: number): number[] => {
      const out: number[] = [];
      for (let i = 0; i < shell.positions.length / 3; i += 4) {
        if (Math.abs(shell.normals[i * 3]! - sign) > 1e-9) continue;
        const ys = [0, 1, 2, 3].map((k) => shell.positions[(i + k) * 3 + 1]!);
        const top = ys.indexOf(Math.max(...ys));
        out.push(shell.uvs[(i + top) * 2 + 1]!);
      }
      return out;
    };
    const facing = startFor(-1);
    const away = startFor(1);
    expect(facing.length, "no runway-facing face found").toBeGreaterThan(0);
    expect(away.length, "no back face found").toBeGreaterThan(0);
    expect(Math.min(...facing)).toBeCloseTo(AIRFIELD_ASPECT_V_START.facingRunway, 9);
    expect(Math.min(...away)).toBeCloseTo(AIRFIELD_ASPECT_V_START.awayFromRunway, 9);
    expect(Math.min(...away)).toBeGreaterThan(Math.min(...facing));
  });
});
