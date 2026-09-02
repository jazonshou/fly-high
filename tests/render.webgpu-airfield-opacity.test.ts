/**
 * `7-12`'s cut condition: **no airfield surface is genuinely transparent.**
 *
 * The hangar interior was cut on a stated consequence — *"no surface may be
 * genuinely transparent onto unmodelled space, and the shell has no aperture"*.
 * The aperture half is guarded by `7-10`'s closed-manifold arm. **This is the
 * transparency half, and until now nothing enforced it.**
 *
 * **What makes it live rather than theoretical.** The detail pass added
 * CLERESTORY GLAZING to every hangar: `HangarSurface` gained a `"glass"` member
 * and `hangarDetailBoxes` emits a `clerestory` box on both eaves. A transparent
 * clerestory looks through the wall into an interior that does not exist — a
 * black void on the approach, which is the exact thing the cut was conditioned
 * on. `AirfieldMaterials.glass` is deliberately opaque (dark, smooth, reflective,
 * sky probe supplying the reflection), but **"it should be using the opaque one"
 * is not the same claim as "it is."**
 *
 * **ASSERTED ON THE ARTIFACT, and that distinction has teeth here.**
 * `tests/render.webgpu-hangar-build.test.ts` builds hangars with
 * `StandardMaterial` STAND-INS — three throwaway materials named metal,
 * concrete and glass. Every assertion there stays green no matter what the
 * shipping materials do, because the shipping materials are never constructed.
 * So this file builds the real `AirportSystem`, which calls
 * `createAirfieldMaterials` itself, and interrogates the material objects that
 * are actually hanging off the actually-built meshes.
 *
 * **Babylon has four independent ways to become see-through** and a material
 * needs only one of them, so checking `alpha` alone would be a guard with three
 * holes: `alpha < 1`, a blending `transparencyMode`, an `opacityTexture`, and
 * alpha-testing on an albedo texture's alpha channel. All four are checked, via
 * Babylon's own `needAlphaBlending()` / `needAlphaTesting()` where possible —
 * those are the predicates the RENDERER consults, so they are the artifact in a
 * way that reading the fields is not.
 */
import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Material } from "@babylonjs/core/Materials/material";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";

import { AirportSystem } from "../src/render/webgpu/detail/AirportSystem";
import { DEFAULT_AIRPORT } from "../src/world/airport";

function host() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.activeCamera = new FreeCamera("probe", new Vector3(0, 5, -20), scene);
  return { scene, dispose: () => { scene.dispose(); engine.dispose(); } };
}

/** A flat ground, so seating is deterministic and the test is about materials. */
const FLAT_GROUND = () => DEFAULT_AIRPORT.elevation;

interface Offence {
  readonly mesh: string;
  readonly material: string;
  readonly reason: string;
}

function transparencyOffences(meshes: readonly AbstractMesh[]): Offence[] {
  const out: Offence[] = [];
  for (const mesh of meshes) {
    const material: Material | null = mesh.material;
    if (!material) continue;
    const note = (reason: string) =>
      out.push({ mesh: mesh.name, material: material.name, reason });

    // The two predicates the renderer itself consults when deciding which
    // bucket a mesh draws in. These are the artifact; the fields below are
    // corroboration for a clearer failure message.
    if (material.needAlphaBlending()) note("needAlphaBlending() is true");
    if (material.needAlphaTesting()) note("needAlphaTesting() is true");

    if (material.alpha !== 1) note(`alpha is ${material.alpha}, not 1`);
    if (material.transparencyMode !== null
      && material.transparencyMode !== undefined
      && material.transparencyMode !== 0) {
      note(`transparencyMode is ${material.transparencyMode}, not OPAQUE`);
    }
    if (material instanceof PBRMaterial) {
      if (material.opacityTexture) note("carries an opacityTexture");
      if (material.useAlphaFromAlbedoTexture) note("useAlphaFromAlbedoTexture is true");
    }
  }
  return out;
}

describe("7-12's cut condition: no airfield surface is transparent", () => {
  it("builds every airfield mesh opaque, materials and all", () => {
    const { scene, dispose } = host();
    try {
      const airport = new AirportSystem(scene, DEFAULT_AIRPORT, FLAT_GROUND, 1_234);
      const meshes = airport.root.getChildMeshes(false);

      // NON-VACUITY, and it is not optional. Every assertion below is a
      // for-loop over `meshes`: if the walk returns nothing — a renamed root, a
      // lazy builder, a constructor that failed quietly — the whole file passes
      // by having nothing to check, which is the shape this project has found
      // six times tonight in other costumes.
      expect(meshes.length).toBeGreaterThan(0);
      expect(meshes.filter((m) => m.material !== null).length).toBeGreaterThan(0);

      const offences = transparencyOffences(meshes);
      expect(
        offences,
        offences.map((o) => `${o.mesh} [${o.material}]: ${o.reason}`).join("\n"),
      ).toEqual([]);
    } finally {
      dispose();
    }
  });

  it("actually reaches the CLERESTORY, which is the surface the cut was about", () => {
    // FAILS IF: the glazing stops being built, is renamed out of the walk, or
    // never receives a material. Without this the test above would keep passing
    // while the one surface `7-12`'s condition was written about went unchecked
    // — a guard that covers everything except the thing it exists for.
    const { scene, dispose } = host();
    try {
      const airport = new AirportSystem(scene, DEFAULT_AIRPORT, FLAT_GROUND, 1_234);
      const meshes = airport.root.getChildMeshes(false);

      const glazing = meshes.filter((m) => m.name.includes("glass"));
      expect(glazing.length).toBeGreaterThan(0);
      for (const mesh of glazing) {
        expect(mesh.material, `${mesh.name} has no material at all`).not.toBeNull();
      }
      expect(transparencyOffences(glazing)).toEqual([]);
    } finally {
      dispose();
    }
  });

  it("would CATCH a transparent surface, proved by making one", () => {
    // The positive control. Everything above is an assertion that a list is
    // empty, and a list is empty both when nothing is wrong and when nothing is
    // examined. This makes a real offence and requires the detector to see it,
    // so an `expect([]).toEqual([])` that can never fail is ruled out.
    const { scene, dispose } = host();
    try {
      const airport = new AirportSystem(scene, DEFAULT_AIRPORT, FLAT_GROUND, 1_234);
      const meshes = airport.root.getChildMeshes(false);
      const victim = meshes.find((m) => m.material instanceof PBRMaterial);
      expect(victim).toBeDefined();

      const material = victim!.material as PBRMaterial;
      const restore = material.alpha;
      material.alpha = 0.5;
      const caught = transparencyOffences([victim!]);
      material.alpha = restore;

      expect(caught.length).toBeGreaterThan(0);
      expect(caught.some((o) => o.reason.includes("alpha"))).toBe(true);
      // And the tree is clean again afterwards, so this test cannot leave the
      // scene in a state that makes a later one fail for the wrong reason.
      expect(transparencyOffences([victim!])).toEqual([]);
    } finally {
      dispose();
    }
  });
});
