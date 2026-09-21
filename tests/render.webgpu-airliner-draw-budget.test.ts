// Installs `thinInstanceCount`/`thinInstanceGetWorldMatrices`, which the
// geometry census needs to weigh 228 windows as 228 rather than as one.
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE } from "../src/game/types";
import {
  AIRCRAFT_EXTERIOR_LAYER_MASK,
  createWebGpuAircraft,
  type AircraftVisual,
} from "../src/render/webgpu/aircraft";
import {
  AircraftBuildContext,
  isAlphaBlendedAirframeMaterial,
} from "../src/render/webgpu/aircraft/builders";

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
  camera: UniversalCamera;
  visual: AircraftVisual;
}

const fixtures: Fixture[] = [];
/** Engines the `mergeStatic` bench tests open; disposing one takes its scene. */
const engines: NullEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
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
  const camera = new UniversalCamera("airliner-budget-camera", Vector3.Zero(), scene);
  scene.activeCamera = camera;
  const visual = createWebGpuAircraft(scene, "airliner");
  // GEAR DOWN, which is how the perf shots fly it and the most the airframe
  // ever draws: the undercarriage is 39 of its meshes.
  visual.update({ ...INITIAL_VISUAL_STATE, gear: 1 }, 1 / 60);
  const fixture: Fixture = { engine, scene, camera, visual };
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
// 140, not 141: the separate `airliner-upper-deck` loft is gone. The forward
// fuselage carries the hump itself now, because two intersecting closed lofts
// cannot be tangent-continuous and left a 38-degree crease at the flight deck.
const BEFORE = { meshes: 134, casters: 113, draws: 367 } as const;

/** Every part that defines the shadow's OUTLINE on the ground. */
const SILHOUETTE = new RegExp([
  "^airliner-(fuselage|radome|upper-deck|tailcone|belly-fairing)$",
  "-wing$",
  "-tailplane$",
  "^airliner-(vertical-stabilizer|dorsal-fin)$",
  "-engine-(nacelle|pylon)$",
  "-(flap|spoilers|aileron|elevator)-surface$",
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
      .filter((name) => /wing$|-(flap|aileron|spoilers)-surface$|flap-track-canoe$/.test(name));
    // NON-VACUITY: at least the two fixed wings, four flaps, four ailerons,
    // four spoiler meshes -- two a side, each carrying the panels that share
    // its hinge line -- and the canoes, whatever the fixed wing is later
    // merged to.
    expect(wingMounted.length).toBeGreaterThanOrEqual(2 + 4 + 4 + 4 + 1);
    for (const name of wingMounted) {
      const recipe = paintRecipe(scene, name);
      expect(recipe.liveryColor, `${name} still carries a livery band`).toBe(recipe.baseColor);
    }
  });

  it("leaves the fuselage its cheatline, painted where a mesh join cannot break it", () => {
    // This used to read the fuselage's RECIPE and assert its livery colour
    // differed from its base -- that is, that it still carried the paint
    // synthesis's UV band. It does not any more, and should not: that band is
    // a diagonal in each mesh's own 0..1 tile, so it stepped and changed angle
    // at every join and never formed a line at all. The cheatline is vertex
    // paint in body coordinates now, so this reads the actual colours.
    const { scene } = build();
    const shell = scene.meshes.find((mesh) => /^airliner-fuselage/.test(mesh.name));
    expect(shell, "no fuselage mesh to read the cheatline off").toBeDefined();
    const colors = shell!.getVerticesData(VertexBuffer.ColorKind);
    expect(colors, "the fuselage carries no vertex colour at all").toBeTruthy();
    let painted = 0;
    let white = 0;
    for (let vertex = 0; vertex < colors!.length / 4; vertex += 1) {
      if (colors![vertex * 4]! < 0.5) painted += 1; else white += 1;
    }
    // Both halves: a cheatline that covered everything would pass a "has
    // paint" check just as well as one that covered nothing.
    expect(painted, "no vertex is in the cheatline").toBeGreaterThan(20);
    expect(white, "every vertex is in the cheatline").toBeGreaterThan(200);
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
    // enclosed parts out of the shadow map removed 25 casters (-> 88, 317
    // draws); folding the root-static parts per material removed 44 meshes
    // and 24 more casters.
    expect(drawn.length).toBeLessThanOrEqual(97);
    expect(casters.length).toBeLessThanOrEqual(64);
    expect(draws).toBeLessThanOrEqual(225);
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
    // NON-VACUITY: 4 fuselage lofts -- it was 5 until the upper deck stopped
    // being its own loft -- 8 wing panels, 2 tailplanes, fin and dorsal fin,
    // 4 nacelles and 4 pylons, 4 flaps, 4 spoiler meshes, 4 ailerons, 2 elevators,
    // the rudder, 4 legs, 2 side braces, 4 bogie beams, 6 doors, 2 nose
    // members and 18 tyres.
    expect(outline.map(([name]) => name).sort()).toHaveLength(
      4 + 8 + 2 + 2 + 4 + 4 + 4 + 4 + 4 + 2 + 1 + 4 + 2 + 4 + 6 + 2 + 18,
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

/**
 * Everything the airframe's geometry adds up to, in WORLD space.
 *
 * A merge that drops a part, bakes a panel without its dihedral, leaves a
 * normal unrotated, offsets an index buffer or flips a winding changes at
 * least one of these, and none of them cares which mesh a vertex lives in —
 * so the same census reads the same numbers before and after a fold. Thin
 * instances are expanded, so losing an instance buffer shows up as well.
 */
interface GeometryCensus {
  vertices: number;
  indices: number;
  minimum: Vector3;
  maximum: Vector3;
  /** Sum of world positions, and of their squared lengths. */
  positionSum: Vector3;
  positionSquares: number;
  /** Sum of unit world normals, and of each normal dotted with its vertex. */
  normalSum: Vector3;
  normalMoment: number;
  /** Signed volume and total area over every triangle: winding and indexing. */
  signedVolume: number;
  area: number;
}

function geometryCensus(visual: AircraftVisual): GeometryCensus {
  const census: GeometryCensus = {
    vertices: 0,
    indices: 0,
    minimum: new Vector3(Infinity, Infinity, Infinity),
    maximum: new Vector3(-Infinity, -Infinity, -Infinity),
    positionSum: Vector3.Zero(),
    positionSquares: 0,
    normalSum: Vector3.Zero(),
    normalMoment: 0,
    signedVolume: 0,
    area: 0,
  };
  for (const part of visual.meshes) {
    if (!(part instanceof Mesh)) throw new Error(`${part.name} is not a Mesh`);
    const positions = part.getVerticesData("position");
    const normals = part.getVerticesData("normal");
    const triangles = part.getIndices();
    if (!positions || !normals || !triangles) throw new Error(`${part.name} has no geometry`);
    census.vertices += part.getTotalVertices();
    census.indices += part.getTotalIndices();
    const world = part.computeWorldMatrix(true);
    const placements = part.thinInstanceCount > 0
      ? part.thinInstanceGetWorldMatrices().map((instance) => instance.multiply(world))
      : [world];
    for (const placement of placements) {
      const points: Vector3[] = [];
      for (let index = 0; index < positions.length; index += 3) {
        const point = Vector3.TransformCoordinates(
          new Vector3(positions[index]!, positions[index + 1]!, positions[index + 2]!),
          placement,
        );
        const normal = Vector3.TransformNormal(
          new Vector3(normals[index]!, normals[index + 1]!, normals[index + 2]!),
          placement,
        ).normalize();
        points.push(point);
        census.minimum.minimizeInPlace(point);
        census.maximum.maximizeInPlace(point);
        census.positionSum.addInPlace(point);
        census.positionSquares += point.lengthSquared();
        census.normalSum.addInPlace(normal);
        census.normalMoment += Vector3.Dot(normal, point);
      }
      for (let index = 0; index < triangles.length; index += 3) {
        const a = points[triangles[index]!]!;
        const b = points[triangles[index + 1]!]!;
        const c = points[triangles[index + 2]!]!;
        census.signedVolume += Vector3.Dot(a, Vector3.Cross(b, c)) / 6;
        census.area += Vector3.Cross(b.subtract(a), c.subtract(a)).length() / 2;
      }
    }
  }
  return census;
}

describe("folding the 747-8's static parts changes how it is drawn, not what is drawn", () => {
  it("adds up to the same geometry the unmerged airframe did", () => {
    // RE-MEASURED after the forward fuselage became ONE egg-sectioned loft.
    //
    // These began as the unmerged airframe's census, taken one commit before
    // the static fold to prove the fold moved no geometry, and they still
    // defend that: any future merge that moves a vertex fails here. What they
    // no longer are is the two-loft aeroplane's numbers, because retiring the
    // separate hump changed the shape on purpose.
    //
    // The drop is the giveaway and it is worth reading rather than accepting:
    // 10,520 vertices to 10,543 and 4,977 m^2 of surface to 4,697. Nearly 280
    // square metres of that area was the two lobes' skin INSIDE each other,
    // drawn and shaded and never visible. One surface has no inside.
    //
    // Then 10,543 to 10,663 when the spoilers were rebuilt: twelve conformed
    // panels of 30 vertices where there were ten boxes of 24. The AREA barely
    // moved (4,696.6 to 4,695.3 m^2) even though two panels were added, which
    // is the seating repair showing up in the census — the boxes stood clear
    // of the wing and counted their whole undersides, the panels lie in it.
    const census = geometryCensus(build().visual);
    expect(census.vertices).toBe(10_663);
    expect(census.indices).toBe(51_552);
    expect(census.minimum.x).toBeCloseTo(-38.0000, 4);
    expect(census.minimum.y).toBeCloseTo(-6.4000, 4);
    expect(census.minimum.z).toBeCloseTo(-34.3500, 4);
    expect(census.maximum.x).toBeCloseTo(34.0000, 4);
    expect(census.maximum.y).toBeCloseTo(13.0000, 4);
    expect(census.maximum.z).toBeCloseTo(34.3500, 4);
    expect(census.positionSum.x).toBeCloseTo(22041.1093, 1);
    expect(census.positionSum.y).toBeCloseTo(-26413.0229, 1);
    expect(census.positionSum.z).toBeCloseTo(-22.0320, 1);
    expect(census.positionSquares).toBeCloseTo(6853278.81, 0);
    expect(census.normalSum.x).toBeCloseTo(-345.9461, 2);
    expect(census.normalSum.y).toBeCloseTo(124.4928, 2);
    expect(census.normalSum.z).toBeCloseTo(0.0913, 2);
    expect(census.normalMoment).toBeCloseTo(10632.1105, 1);
    expect(census.signedVolume).toBeCloseTo(-3232.4065, 2);
    expect(census.area).toBeCloseTo(4695.2708, 2);
  });

  it("keeps every instance of the three thin-instanced parts", () => {
    // `MergeMeshes` reads base geometry and drops the instance buffer, so
    // these three must never have been offered to it.
    const { scene } = build();
    for (const [name, count] of [
      ["airliner-cabin-window-line", 228],
      ["airliner-flap-track-canoe", 8],
      ["airliner-nacelle-chevron", 48],
    ] as const) {
      const part = scene.getMeshByName(name);
      expect(part, name).toBeInstanceOf(Mesh);
      expect((part as Mesh).thinInstanceCount, name).toBe(count);
      expect(part!.metadata?.mergedFrom, `${name} was folded`).toBeUndefined();
    }
  });

  it("folds only parts bolted to the root, and nothing that moves", () => {
    const { visual } = build();
    const folded = visual.meshes.filter((mesh) => mesh.metadata?.mergedFrom !== undefined);
    // NON-VACUITY: the fold happened.
    expect(folded.length).toBeGreaterThanOrEqual(10);
    for (const mesh of folded) {
      expect(mesh.parent, `${mesh.name} is folded but not on the root`).toBe(visual.root);
    }
    // Every mesh that hangs from anything OTHER than the root hangs from a
    // node the pose drives — a hinge or its `-frame`, the rudder, a fan spool,
    // a gear door, the undercarriage. There were 74 before the fold (21
    // control surfaces, 8 fan parts, 6 door leaves, 39 gear parts) and each
    // must still be its own mesh under its own name.
    const hung = visual.meshes.filter((mesh) => mesh.parent !== visual.root);
    expect(hung).toHaveLength(68);
    for (const mesh of hung) {
      expect(mesh.metadata?.mergedFrom, `${mesh.name} moves and was folded`).toBeUndefined();
    }
    // And no mesh the build owns is a disposed source left behind.
    expect(visual.meshes.filter((mesh) => mesh.isDisposed())).toEqual([]);
  });

  it("still resolves every name a test or an instrument looks up", () => {
    const { scene } = build();
    for (const name of [
      // tests/lighting.aircraft-wash, tests/render.webgpu-nav-light-sides
      "anticollision-beacon",
      "port-navigation-light",
      "starboard-navigation-light",
      "port-strobe-light",
      "starboard-strobe-light",
      // tests/render.webgpu-control-surface-sides
      "starboard-aileron-surface",
      "port-aileron-surface",
      "starboard-elevator-surface",
      "port-elevator-surface",
      "rudder-surface",
      "nose-wheel-tire",
      // scripts/flap-joint-frames.mts crops each side's joint by these
      "starboard-airliner-fixed-wing",
      "port-airliner-fixed-wing",
      "starboard-airliner-inner-flap-surface",
      "port-airliner-outer-flap-surface",
    ]) {
      expect(scene.getMeshByName(name), name).not.toBeNull();
    }
    // `scripts/wing-slot-sweep.mts` classifies ray hits BY NAME: `/wing$/` is
    // fixed structure, `-(flap|flaperon|aileron)-surface` a moving surface.
    // With neither it reports every slot CLOSED, which looks like success.
    const names = scene.meshes.map((mesh) => mesh.name);
    expect(names.filter((name) => /wing$/.test(name) && !/flap|aileron/.test(name)))
      .toEqual(["starboard-airliner-fixed-wing", "port-airliner-fixed-wing"]);
    expect(names.filter((name) => /-(flap|aileron)-surface$/.test(name))).toHaveLength(8);
  });

  it("hides the same skin from the cockpit camera, and nothing more", () => {
    const { visual, camera } = build();
    const parts = authoredParts(visual);
    const formerCockpitParts = [
      "airliner-fuselage",
      "airliner-radome",
      // `airliner-upper-deck` was here until the hump became part of the
      // fuselage loft; the skin it used to hide is hidden by the fuselage now.
      "airliner-windscreen-center-post",
    ].map((name) => {
      const carrier = parts.get(name);
      if (!carrier) throw new Error(`${name} is carried by no mesh`);
      return carrier;
    });
    // The list holds exactly the carriers: no disposed source left in it, and
    // nothing new swept on to the cockpit-excluded layer by a merge.
    expect(new Set(visual.cockpitParts)).toEqual(new Set(formerCockpitParts));
    const exteriorMask = camera.layerMask;

    visual.setCockpitView(true);
    for (const mesh of visual.meshes) {
      const hidden = (mesh.layerMask & camera.layerMask) === 0;
      expect(hidden, `${mesh.name} in cockpit view`).toBe(formerCockpitParts.includes(mesh));
      // Still drawn, so still a shadow caster: excluded from this camera only.
      expect(mesh.isVisible, mesh.name).toBe(true);
    }
    for (const part of formerCockpitParts) {
      expect(part.layerMask).toBe(AIRCRAFT_EXTERIOR_LAYER_MASK);
    }

    visual.setCockpitView(false);
    expect(camera.layerMask).toBe(exteriorMask);
    for (const mesh of visual.meshes) {
      expect(mesh.layerMask & camera.layerMask, `${mesh.name} after restore`).not.toBe(0);
      expect(mesh.isVisible, mesh.name).toBe(true);
    }
  });

  it("puts the folded wing and tail back among the surfaces cockpit view keeps visible", () => {
    // `setCockpitVisibility` forces `isVisible` on everything in the rig's
    // `wingSurfaces`, and that list is private. So membership is read through
    // its one effect: hide a surface, enter cockpit view, and it must come
    // back. A folded wing that never rejoined the list stays hidden — which
    // in the game is a cockpit with no wing outside the window.
    const { visual } = build();
    const carriers = new Set(
      [...authoredParts(visual)]
        .filter(([name]) => new RegExp([
          "-airliner-(inboard|outboard|rake-inner|rake-outer)-wing$",
          "-(flap|aileron|elevator)-surface$",
          "-tailplane$",
          "^airliner-vertical-stabilizer$",
        ].join("|")).test(name))
        .map(([, mesh]) => mesh),
    );
    // 2 folded wings and the folded tail, 4 flaps, 4 ailerons, 2 elevators.
    expect(carriers.size).toBe(2 + 1 + 4 + 4 + 2);
    for (const mesh of carriers) mesh.isVisible = false;
    visual.setCockpitView(true);
    for (const mesh of carriers) {
      expect(mesh.isVisible, `${mesh.name} is not a wing surface any more`).toBe(true);
    }
    visual.setCockpitView(false);
  });
});

describe("AircraftBuildContext.mergeStatic", () => {
  function bench(): { scene: Scene; context: AircraftBuildContext; root: TransformNode } {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    engines.push(engine);
    const root = new TransformNode("bench-root", scene);
    return { scene, context: new AircraftBuildContext(scene), root };
  }

  /** Every vertex of a mesh, in world space, as sorted rounded strings. */
  function worldVertices(meshes: readonly Mesh[]): string[] {
    const points: string[] = [];
    for (const mesh of meshes) {
      const positions = mesh.getVerticesData("position")!;
      const world = mesh.computeWorldMatrix(true);
      for (let index = 0; index < positions.length; index += 3) {
        const point = Vector3.TransformCoordinates(
          new Vector3(positions[index]!, positions[index + 1]!, positions[index + 2]!),
          world,
        );
        points.push([point.x, point.y, point.z].map((value) => value.toFixed(4)).join(","));
      }
    }
    return points.sort();
  }

  it("lands the parts where they were, under a parent that is itself moved", () => {
    // Every airframe folds under an identity root, so THIS is the only thing
    // that exercises carrying the merged vertices back out of world space —
    // without it a fold under a moved parent would apply the parent twice.
    const { context, root } = bench();
    root.position.set(5, -2, 3);
    root.rotation.set(0.3, 1.1, -0.4);
    const anchor = new TransformNode("bench-anchor", root.getScene());
    anchor.parent = root;
    anchor.position.set(0, 1, 4);
    anchor.rotation.x = -0.2;
    const paint = context.material("bench-paint", 0xffffff);
    const onRoot = context.box("bench-on-root", 1, 2, 3, paint, root);
    onRoot.position.set(-1, 0.5, 2);
    onRoot.rotation.y = 0.7;
    const onAnchor = context.box("bench-on-anchor", 2, 1, 1, paint, anchor);
    const before = worldVertices([onRoot, onAnchor]);

    const merged = context.mergeStatic("bench-merged", [onRoot, onAnchor], root, {
      staticNodes: [anchor],
    });

    expect(worldVertices([merged])).toEqual(before);
    expect(merged.parent).toBe(root);
    expect(context.meshes).toEqual([merged]);
    expect(onRoot.isDisposed() && onAnchor.isDisposed()).toBe(true);
    // The emptied static node goes with the parts it carried.
    expect(anchor.isDisposed()).toBe(true);
    expect(merged.metadata).toMatchObject({
      aircraftVisual: true,
      castsShadow: true,
      mergedFrom: ["bench-on-root", "bench-on-anchor"],
    });
  });

  it("keeps what the parts agree on: the layer mask, and not casting", () => {
    const { context, root } = bench();
    const paint = context.material("bench-paint", 0xffffff);
    const parts = [0, 1].map((index) => {
      const part = context.box(`bench-part-${index}`, 1, 1, 1, paint, root);
      part.layerMask = AIRCRAFT_EXTERIOR_LAYER_MASK;
      part.metadata = { ...part.metadata, castsShadow: false, cockpitInterior: true, index };
      return part;
    });
    const merged = context.mergeStatic("bench-merged", parts, root);
    expect(merged.layerMask).toBe(AIRCRAFT_EXTERIOR_LAYER_MASK);
    expect(merged.metadata).toMatchObject({ castsShadow: false, cockpitInterior: true });
    // A key the parts DISAGREE on describes neither the whole nor the fold.
    expect(merged.metadata).not.toHaveProperty("index");
  });

  it("keeps glass in the rendering group its material puts it in", () => {
    const { context, root } = bench();
    const glass = context.material("bench-glass", 0x14323f, { alpha: 0.3 });
    const panes = [0, 1].map((index) => context.box(`bench-pane-${index}`, 1, 1, 1, glass, root));
    const group = panes[0]!.renderingGroupId;
    expect(group).not.toBe(0);
    expect(context.mergeStatic("bench-glazing", panes, root).renderingGroupId).toBe(group);
  });

  it("refuses a part that hangs from a node nobody declared static", () => {
    // This is the guard that keeps a flap out of a wing: a hinge, its
    // `-frame`, a rudder `-mount`, a fan spool and the gear node are all just
    // "a node that was not declared".
    const { context, root } = bench();
    const paint = context.material("bench-paint", 0xffffff);
    const hinge = new TransformNode("bench-flap-frame", root.getScene());
    hinge.parent = root;
    const fixed = context.box("bench-fixed", 1, 1, 1, paint, root);
    const moving = context.box("bench-moving", 1, 1, 1, paint, hinge);
    expect(() => context.mergeStatic("bench-merged", [fixed, moving], root))
      .toThrow(/"bench-moving".*hangs from "bench-flap-frame"/);
    // A refusal happens BEFORE anything is disposed.
    expect(fixed.isDisposed() || moving.isDisposed()).toBe(false);
    expect(context.meshes).toEqual([fixed, moving]);
  });

  it("refuses parts that one mesh could not draw the same way", () => {
    const { context, root } = bench();
    const paint = context.material("bench-paint", 0xffffff);
    const other = context.material("bench-other", 0x000000);
    const plain = () => context.box("bench-plain", 1, 1, 1, paint, root);

    const masked = context.box("bench-masked", 1, 1, 1, paint, root);
    masked.layerMask = AIRCRAFT_EXTERIOR_LAYER_MASK;
    expect(() => context.mergeStatic("m", [plain(), masked], root)).toThrow(/layer mask/);

    const repainted = context.box("bench-repainted", 1, 1, 1, other, root);
    expect(() => context.mergeStatic("m", [plain(), repainted], root)).toThrow(/material/);

    const shadowless = context.box("bench-shadowless", 1, 1, 1, paint, root);
    shadowless.metadata = { ...shadowless.metadata, castsShadow: false };
    expect(() => context.mergeStatic("m", [plain(), shadowless], root)).toThrow(/shadow/);

    const instanced = context.box("bench-instanced", 1, 1, 1, paint, root);
    instanced.thinInstanceSetBuffer("matrix", new Float32Array(32), 16, true);
    expect(() => context.mergeStatic("m", [plain(), instanced], root)).toThrow(/instanced/);

    // A loft has no vertex colours and the blur disc does.
    const coloured = context.radialBlurDisc("bench-coloured", 1, 16, paint, root);
    coloured.metadata = { ...coloured.metadata, castsShadow: true };
    coloured.hasVertexAlpha = false;
    expect(() => context.mergeStatic("m", [plain(), coloured], root)).toThrow(/vertex layout/);

    expect(() => context.mergeStatic("m", [plain()], root)).toThrow(/at least two/);
  });
});
