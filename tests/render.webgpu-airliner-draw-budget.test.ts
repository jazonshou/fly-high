import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE } from "../src/game/types";
import { createWebGpuAircraft, type AircraftVisual } from "../src/render/webgpu/aircraft";
import { isAlphaBlendedAirframeMaterial } from "../src/render/webgpu/aircraft/builders";

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
  // GEAR DOWN, which is how the perf shots fly it and the most the airframe
  // ever draws: the undercarriage is 39 of its meshes.
  visual.update({ ...INITIAL_VISUAL_STATE, gear: 1 }, 1 / 60);
  const fixture: Fixture = { engine, scene, visual };
  fixtures.push(fixture);
  return fixture;
}

/**
 * What `FlightRenderer` registers with the sun shadow generator: everything
 * whose metadata does not say `castsShadow: false`. Babylon then skips
 * alpha-blended casters of its own accord, so they are not counted either.
 */
function castsShadow(mesh: AbstractMesh): boolean {
  if (mesh.metadata?.castsShadow === false) return false;
  return !(mesh.material && isAlphaBlendedAirframeMaterial(mesh.material));
}

function issuesDraw(mesh: AbstractMesh): boolean {
  return mesh.getTotalVertices() > 0 && mesh.isEnabled() && mesh.isVisible;
}

/**
 * The parts the airframe was AUTHORED as, whatever mesh carries them now.
 *
 * A merged mesh records the names it was folded from, so a part can be
 * followed through a merge: asking "does the inboard nacelle still cast a
 * shadow" must not start failing, or silently stop being asked, because the
 * nacelle is now forty triangles of a larger mesh.
 */
function authoredParts(visual: AircraftVisual): Map<string, AbstractMesh> {
  const parts = new Map<string, AbstractMesh>();
  for (const mesh of visual.meshes) {
    const folded = (mesh.metadata as { mergedFrom?: readonly string[] } | null)?.mergedFrom;
    for (const name of folded ?? [mesh.name]) {
      if (parts.has(name)) throw new Error(`"${name}" is carried by two meshes`);
      parts.set(name, mesh);
    }
  }
  return parts;
}

/**
 * MEASURED ON THE UNMODIFIED AIRFRAME (63ae11c), before any of this work:
 * 141 meshes, 113 of them shadow casters, so 141 + 2 x 113 = 367 draws a
 * frame for the aeroplane alone. The in-game capture agrees: the scene issued
 * 491 draws with the 747 against 264 with the Cessna.
 */
const BEFORE = { meshes: 141, casters: 113, draws: 367 } as const;

/** Every part that defines the shadow's OUTLINE on the ground. */
const SILHOUETTE = new RegExp([
  "^airliner-(fuselage|radome|upper-deck|tailcone|belly-fairing)$",
  "-wing$",
  "-tailplane$",
  "^airliner-(vertical-stabilizer|dorsal-fin)$",
  "-engine-(nacelle|pylon)$",
  "-(flap|spoiler|aileron|elevator)-surface$",
  "^rudder-surface$",
  "-gear-(strut|side-brace|bogie-beam|door-leaf)$",
  "^airliner-nose-(strut|drag-brace)$",
  "-tire(-outer|-inner)?$",
].join("|"));

/** Every part whose shadow is inside another part's, or is glass or a lamp. */
const ENCLOSED = new RegExp([
  "-fan-spool-(fan|spinner)$",
  "-engine-inlet$",
  "^airliner-(cabin-window-line|nacelle-chevron|windscreen-center-post)$",
  "^airliner-(instrument-panel|[a-z-]+-gauge|[a-z-]+-needle)$",
  "-(seat|headrest)$",
  "-axle-shaft$",
  "^airliner-nose-axle$",
  "-flight-deck-window-",
  "-light$",
  "^anticollision-beacon$",
].join("|"));

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

describe("the 747-8's draw budget", () => {
  it("spends no more draws than it has been cut to", () => {
    const { visual } = build();
    const drawn = visual.meshes.filter(issuesDraw);
    const casters = drawn.filter(castsShadow);
    // One draw in the colour pass, and one per sun-shadow cascade for a
    // caster. Every quality tier runs two cascades.
    const draws = drawn.length + 2 * casters.length;
    console.info(
      `airliner draw budget: meshes ${BEFORE.meshes} -> ${drawn.length}, `
      + `shadow casters ${BEFORE.casters} -> ${casters.length}, `
      + `predicted draws ${BEFORE.draws} -> ${draws}`,
    );
    // UPPER BOUNDS. Before: 141 meshes, 113 casters, 367 draws. Taking the
    // enclosed parts out of the shadow map removed 25 casters and 50 draws.
    expect(drawn.length).toBeLessThanOrEqual(141);
    expect(casters.length).toBeLessThanOrEqual(88);
    expect(draws).toBeLessThanOrEqual(317);
  });

  it("still carries every part the airframe was authored as", () => {
    const { visual } = build();
    // Nothing dropped and nothing carried twice: `authoredParts` throws on a
    // duplicate, and this pins the total.
    expect(authoredParts(visual).size).toBe(BEFORE.meshes);
  });

  it("keeps every part of the shadow's outline in the shadow map", () => {
    const { visual } = build();
    const outline = [...authoredParts(visual)].filter(([name]) => SILHOUETTE.test(name));
    // NON-VACUITY: 5 fuselage lofts, 8 wing panels, 2 tailplanes, fin and
    // dorsal fin, 4 nacelles and 4 pylons, 4 flaps, 10 spoilers, 4 ailerons,
    // 2 elevators, the rudder, 4 legs, 2 side braces, 4 bogie beams, 6 doors,
    // 2 nose members and 18 tyres.
    expect(outline.map(([name]) => name).sort()).toHaveLength(
      5 + 8 + 2 + 2 + 4 + 4 + 4 + 10 + 4 + 2 + 1 + 4 + 2 + 4 + 6 + 2 + 18,
    );
    for (const [name, mesh] of outline) {
      expect(issuesDraw(mesh), `${name} is not drawn`).toBe(true);
      expect(castsShadow(mesh), `${name} no longer casts a shadow`).toBe(true);
    }
  });

  it("casts nothing from a part whose shadow cannot be seen", () => {
    const { visual } = build();
    const enclosed = [...authoredParts(visual)].filter(([name]) => ENCLOSED.test(name));
    // 4 fans, 4 spinners, 4 inlets, the window line, the chevrons, the centre
    // post, the panel with 5 gauges and 5 needles, 2 seats, 2 headrests, 8
    // main axle shafts and the nose one, 6 panes of glass and 8 lamps.
    expect(enclosed.map(([name]) => name).sort()).toHaveLength(
      4 + 4 + 4 + 1 + 1 + 1 + 11 + 2 + 2 + 8 + 1 + 6 + 8,
    );
    for (const [name, mesh] of enclosed) {
      expect(castsShadow(mesh), `${name} is still in the shadow map`).toBe(false);
    }
  });

  it("sorts every part into exactly one of the two lists", () => {
    // The two patterns above are hand-written, so a part matching NEITHER
    // would be a part nobody decided about. The remainder is named: the
    // beacon blister, the flap track canoes and the four core exhausts are
    // not the outline, but each stands clear of the part it hangs from, so
    // they were left casting rather than argued out of the shadow map.
    const { visual } = build();
    const undecided = [...authoredParts(visual)]
      .filter(([name]) => !SILHOUETTE.test(name) && !ENCLOSED.test(name))
      .map(([name]) => name);
    const both = [...authoredParts(visual)]
      .filter(([name]) => SILHOUETTE.test(name) && ENCLOSED.test(name))
      .map(([name]) => name);
    expect(both).toEqual([]);
    expect(undecided.sort()).toEqual([
      "airliner-beacon-fairing",
      "airliner-flap-track-canoe",
      ...["port", "starboard"].flatMap((side) => ["inboard", "outboard"].map(
        (engine) => `${side}-airliner-${engine}-engine-core`,
      )),
    ].sort());
    const parts = authoredParts(visual);
    for (const name of undecided) {
      expect(castsShadow(parts.get(name)!), `${name} stopped casting`).toBe(true);
    }
  });
});
