import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it } from "vitest";
import { createWebGpuAircraft, type AircraftVisual } from "../src/render/webgpu/aircraft";

/**
 * The 747-8's draw budget, and the things that must survive spending less.
 *
 * Flying the airliner measured +0.77 ms a frame against the Cessna, +0.70 ms
 * of it CPU, for +2% triangles: it is draw SUBMISSION, not fill or vertex
 * load. Every mesh costs one draw in the colour pass and two more — one per
 * sun-shadow cascade — if it casts, and this airframe was built as 141 meshes
 * of which 113 cast. Everything here runs on a `NullEngine`, so it counts
 * what the renderer will be ASKED to draw; the measured `drawCalls` and the
 * frame time need a GPU and are not this file's claim.
 */

interface Fixture {
  engine: NullEngine;
  scene: Scene;
  visual: AircraftVisual;
}

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.visual.dispose();
    fixture.scene.dispose();
    fixture.engine.dispose();
  }
});

function build(): Fixture {
  const engine = new NullEngine({
    renderWidth: 64,
    renderHeight: 64,
    textureSize: 64,
    deterministicLockstep: false,
    lockstepMaxSteps: 4,
  });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const visual = createWebGpuAircraft(scene, "airliner");
  const fixture: Fixture = { engine, scene, visual };
  fixtures.push(fixture);
  return fixture;
}

interface PaintRecipe {
  readonly baseColor: number;
  readonly liveryColor: number;
}

function paintRecipe(scene: Scene, meshName: string): PaintRecipe {
  const mesh = scene.getMeshByName(meshName);
  if (!mesh) throw new Error(`Missing mesh ${meshName}`);
  const recipe = (mesh.material?.metadata as { aircraftPaintRecipe?: PaintRecipe } | null)
    ?.aircraftPaintRecipe;
  if (!recipe) throw new Error(`${meshName} does not wear a synthesized paint`);
  return recipe;
}

describe("the 747-8's wing is one white surface", () => {
  /**
   * The paint synthesis draws its livery band wherever `liveryColor` differs
   * from `baseColor`, as one diagonal in each mesh's OWN 0..1 UV tile. On the
   * wing's separately-UV'd panels that was a blue dash per part, each at its
   * own angle. A recipe whose two colours are equal has no band to draw, so
   * this reads the recipe rather than a rendered pixel.
   */
  it("paints the wing and everything hinged to it without a livery band", () => {
    const { scene } = build();
    const wingMounted = scene.meshes
      .map((mesh) => mesh.name)
      .filter((name) => /wing$|-(flap|aileron|spoiler)-surface$|flap-track-canoe$/.test(name));
    // NON-VACUITY: at least the two fixed wings, four flaps, four ailerons,
    // ten spoilers and the canoes, whatever the fixed wing is later merged to.
    expect(wingMounted.length).toBeGreaterThanOrEqual(2 + 4 + 4 + 10 + 1);
    for (const name of wingMounted) {
      const recipe = paintRecipe(scene, name);
      expect(recipe.liveryColor, `${name} still carries a livery band`).toBe(recipe.baseColor);
    }
  });

  it("leaves the fuselage its cheatline", () => {
    const { scene } = build();
    const shell = scene.meshes.find((mesh) => /^airliner-fuselage/.test(mesh.name));
    expect(shell, "no fuselage mesh to read the cheatline off").toBeDefined();
    const recipe = paintRecipe(scene, shell!.name);
    expect(recipe.liveryColor).not.toBe(recipe.baseColor);
  });
});
