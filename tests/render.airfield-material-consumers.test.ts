import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { AirportSystem } from "../src/render/webgpu/detail/AirportSystem";
import { createAirfieldMaterials } from "../src/render/webgpu/airfield/AirfieldMaterials";
import { createWorld } from "../src/world";

/**
 * `7-11`: every material the airfield set BUILDS must reach at least one mesh.
 *
 * **A material with no consumer is not a small waste; it is a surface the
 * renderer cannot show you** — synthesized, disposed, and counted against the
 * 7D memory inventory, while anything wrong with it (a colour, a roughness, a
 * missing `prepareMaterialForClusteredLighting`) stays invisible to every
 * capture.
 *
 * **Recorded because I got this wrong: `glass` was NOT such a material.** I
 * took "glass has zero consumers" from an older note and confirmed it with
 * `git grep "\.glass\b"`, which cannot match how hangars actually reach it —
 * they index the set dynamically by surface name. **The positive control I ran
 * validated the regex, not the access pattern I had assumed**, so it passed
 * while the query was still blind. Glass had three consumers all along, one
 * clerestory per hangar. The tower cab was a fourth surface using a DIFFERENT
 * glass, which is a mismatch bug, not an orphan bug.
 *
 * **The roster is read off the set, not listed here.** A fifth material added
 * to `AirfieldMaterialSet` is required to find a consumer on the day it is
 * added, rather than joining `glass` in being paid for and never drawn.
 *
 * **It walks the built scene rather than scanning source**, because the
 * question is which materials a MESH ends up carrying — a source scan sees a
 * reference in a table that nothing indexes, which is close to the bug itself.
 */
const WORLD_SEED = "phase1-perf-baseline";

function nullScene() {
  const engine = new NullEngine({
    renderWidth: 64, renderHeight: 64, textureSize: 64,
    deterministicLockstep: false, lockstepMaxSteps: 4,
  });
  return { engine, scene: new Scene(engine) };
}

/** The set's own membership, minus the disposer — derived, never listed. */
function materialSetNames(): string[] {
  const { engine, scene } = nullScene();
  const set = createAirfieldMaterials(scene, 4_242);
  const names = Object.entries(set)
    .filter(([, value]) => typeof value !== "function")
    .map(([, value]) => (value as { name: string }).name);
  set.dispose();
  scene.dispose();
  engine.dispose();
  return names;
}

describe("airfield material set (7-11)", () => {
  it("gives every material it builds at least one mesh", () => {
    const expected = materialSetNames();
    expect(expected.length).toBeGreaterThan(0);

    const { engine, scene } = nullScene();
    const world = createWorld(WORLD_SEED, { worldEvolution: "analytic" });
    const airport = world.airport;
    if (!airport) throw new Error("fixture world has no airport");
    const system = new AirportSystem(scene, airport, () => airport.elevation - 7.5, 1_234);

    const used = new Set<string>();
    for (const mesh of scene.meshes) {
      const material = mesh.material;
      if (material) used.add(material.name);
    }

    const orphaned = expected.filter((name) => !used.has(name));
    expect(orphaned, `airfield materials built but reaching no mesh: ${orphaned.join(", ")}`)
      .toEqual([]);

    system.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("puts the shared glass on the tower cab specifically", () => {
    const { engine, scene } = nullScene();
    const world = createWorld(WORLD_SEED, { worldEvolution: "analytic" });
    const airport = world.airport;
    if (!airport) throw new Error("fixture world has no airport");
    const system = new AirportSystem(scene, airport, () => airport.elevation - 7.5, 1_234);

    const cab = scene.meshes.find((mesh) => mesh.name === "airport-tower-cab");
    expect(cab, "the tower cab mesh is missing").toBeDefined();
    // A name check alone would pass on a SECOND, locally-built material that
    // happened to carry the same name — which is the bug re-opened with a
    // rename. So assert the name AND that exactly one such material exists in
    // the scene, which together pin it to the shared instance.
    expect(cab?.material?.name).toBe("airfield-glass");
    const glassMaterials = scene.materials.filter((m) => m.name === "airfield-glass");
    expect(glassMaterials).toHaveLength(1);
    expect(cab?.material).toBe(glassMaterials[0]);

    system.dispose();
    scene.dispose();
    engine.dispose();
  });
});
