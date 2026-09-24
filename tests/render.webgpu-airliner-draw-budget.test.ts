// Installs `thinInstanceCount`/`thinInstanceGetWorldMatrices`, which the
// geometry census needs to weigh 228 windows as 228 rather than as one.
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
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
import {
  AIRLINER_LIVERY_STATION_RANGE,
  CHEATLINE,
  buildAirlinerLivery,
} from "../src/render/webgpu/aircraft/airlinerLivery";

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
  // the cockpit's kit: 41 authored parts, all cockpit-only, so all outside the shadow map. The board, the
  // glareshield (the rounded deck, unmerged), and the lining round the glass: three strips across the centreline (the
  // sill, the crown and the post) and six a side; and each screen with its bezel's frame, its rim and its well
  "^airliner-(instrument-panel|glareshield)$",
  "^((port|starboard)-)?airliner-lining-",

  "^airliner-(screen|screen-bezel|screen-bezel-rim|screen-well)-(port|starboard)-(pfd|nd|eicas)$",
  "-(seat|headrest)$",
  "-axle-shaft$",
  // the spoiler bays: a 2 mm plate on the wing's skin under each panel, hidden by it until it rises. Its shadow
  // would fall on the skin it lies on, which is to say nowhere; casting it could only acne the wing.
  "-spoilers-bay$",
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

  it("leaves the fuselage its cheatline, in the livery texture on the shared station range", () => {
    // The texture band replaced the vertex-paint band, and deleting the vertex
    // COLOUR buffer is what paid for it: WebGPU allows a fragment stage 16
    // inputs, and UV1 + a second UV set + colour on this shell came to 17 with
    // the airfield's clustered container attached, which black-screened the
    // 747 (docs/findings/AIRLINER_LIVERY_UV.md). So this asserts both: the band
    // is in the texture where the shell samples it, and the shell carries no
    // colour buffer and no second UV set to bring the 17th input back.
    const { scene } = build();
    const shell = scene.getMeshByName("airliner-fuselage-shell");
    expect(shell, "no fuselage shell to read the cheatline off").toBeTruthy();
    // POSITIVE CONTROL: the check can see a colour buffer where there is one.
    const probe = new Mesh("colour-probe", scene);
    probe.setVerticesData(VertexBuffer.PositionKind, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    probe.setVerticesData(VertexBuffer.ColorKind, new Array<number>(12).fill(1));
    expect(probe.getVerticesData(VertexBuffer.ColorKind), "the check cannot see colour").not.toBeNull();
    probe.dispose();
    expect(shell!.getVerticesData(VertexBuffer.ColorKind), "the shell carries vertex colour again").toBeNull();
    expect(shell!.getVerticesData(VertexBuffer.UV2Kind), "the shell carries a second UV set again").toBeNull();

    const albedo = (shell!.material as { albedoTexture?: BaseTexture | null } | null)?.albedoTexture;
    expect(albedo?.name, "the shell does not wear the livery").toBe("airliner-livery");
    expect(albedo!.coordinatesIndex, "the livery must ride on UV1").toBe(0);

    const positions = shell!.getVerticesData(VertexBuffer.PositionKind)!;
    const uvs = shell!.getVerticesData(VertexBuffer.UVKind)!;
    const indices = shell!.getIndices()!;
    const { minimumX, length } = AIRLINER_LIVERY_STATION_RANGE;
    // ONE station range for both lofts: u is x's, on the fuselage and the
    // radome alike. Per-loft u disagreed by 0.615 of the texture at the join.
    let lowestX = Infinity;
    let highestX = -Infinity;
    let worstU = 0;
    for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
      const x = positions[vertex * 3]!;
      lowestX = Math.min(lowestX, x);
      highestX = Math.max(highestX, x);
      worstU = Math.max(worstU, Math.abs(uvs[vertex * 2]! - (x - minimumX) / length));
    }
    expect(lowestX, "the shell lost the fuselage's aft end").toBeLessThan(-25.9);
    expect(highestX, "the shell lost the radome").toBeGreaterThan(33.9);
    expect(worstU, "a shell vertex is off the shared station range").toBeLessThan(1e-6);

    // The band, read where the rasteriser would: at every starboard vertex and
    // triangle centroid in the band's full-strength stations, the texel at the
    // interpolated (u, v), placed at the interpolated body height. `shiftV`
    // moves every lookup round the section, for the control below.
    const image = buildAirlinerLivery();
    const texelAt = (u: number, v: number) => {
      const column = Math.min(image.width - 1, Math.max(0, Math.floor(u * image.width)));
      const row = Math.min(image.height - 1, Math.max(0, Math.floor((v - Math.floor(v)) * image.height)));
      const index = (row * image.width + column) * 4;
      return [image.data[index]!, image.data[index + 1]!, image.data[index + 2]!] as const;
    };
    // Blue-dominant, not "nearer navy than white": the door windows (30, 34,
    // 42) and door seals (140, 140, 140) are both nearer navy, and neither is
    // the cheatline.
    const isNavy = ([r, g, b]: readonly [number, number, number]) => b - r > 40 && b - g > 25 && b < 160;
    const isWhite = ([r, g, b]: readonly [number, number, number]) => Math.min(r, g, b) >= 200;
    const read = (shiftV: number) => {
      const navyHeights: number[] = [];
      let white = 0;
      const sample = (x: number, y: number, z: number, u: number, v: number) => {
        if (!(z > 0) || x < CHEATLINE.aftFullX || x > CHEATLINE.forwardFullX) return;
        const texel = texelAt(u, v + shiftV);
        if (isNavy(texel)) navyHeights.push(y);
        else if (isWhite(texel)) white += 1;
      };
      for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
        sample(positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!,
          uvs[vertex * 2]!, uvs[vertex * 2 + 1]!);
      }
      for (let corner = 0; corner < indices.length; corner += 3) {
        const [a, b, c] = [indices[corner]!, indices[corner + 1]!, indices[corner + 2]!];
        // Not the end caps: a cap fans from a centre vertex at v = 0.5, so its
        // centroids are no height on the skin. Only a cap spans no stations.
        const [xa, xb, xc] = [positions[a * 3]!, positions[b * 3]!, positions[c * 3]!];
        if (Math.max(xa, xb, xc) === Math.min(xa, xb, xc)) continue;
        const mean = (buffer: ArrayLike<number>, stride: number, offset: number) =>
          (buffer[a * stride + offset]! + buffer[b * stride + offset]! + buffer[c * stride + offset]!) / 3;
        sample(mean(positions, 3, 0), mean(positions, 3, 1), mean(positions, 3, 2), mean(uvs, 2, 0), mean(uvs, 2, 1));
      }
      // 5 cm: a texel is 4 cm round the cabin, and a centroid sits on the chord.
      const offBand = navyHeights.filter((y) => y > CHEATLINE.topY + 0.05 || y < CHEATLINE.bottomY - 0.05);
      return { navy: navyHeights.length, white, offBand };
    };

    // BOTH halves: a band covering everything would pass "has navy" as well as
    // one covering nothing passes "has white". Measured 29 navy, 582 white.
    const shipped = read(0);
    expect(shipped.navy, "no navy where the shell samples the livery").toBeGreaterThan(15);
    expect(shipped.white, "no white where the shell samples the livery").toBeGreaterThan(300);
    expect(shipped.offBand.map((y) => y.toFixed(3)), "navy is off the band's heights").toEqual([]);
    // CONTROL: moved 0.02 round the section (about 0.4 m on the flank), the same
    // lookups must put navy off the band, or the check above cannot fail.
    expect(read(0.02).offBand.length, "the placement check cannot see a band 0.4 m out").toBeGreaterThan(10);
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
    //
    // THE COCKPIT'S SEVEN MESHES ARE OUTSIDE THESE BOUNDS, and the bounds did not
    // move when they were added. `issuesDraw` needs `isVisible`, and a cockpit-only
    // part is INVISIBLE outside cockpit view (`configureCockpitOnlyParts`) and never
    // a shadow caster, so it is counted by nothing here; the test below pins that
    // property, and what the kit costs in cockpit view. The old gauge faces and
    // needles were two drawn meshes and are gone (89 drawn, from 91; 205 draws,
    // from 207); the old board was folded into the seats' mesh and is gone with it.
    // THE SIX DISPLAYS COST NOTHING HERE. They are one texture on the ONE merged `airliner-screens`
    // mesh, which already existed and already had one material; the atlas changes which material that
    // is (an emissive one) in cockpit view only, not how many meshes or draws there are. Where there
    // is no 2D canvas -- every run of this test -- the screens keep their flat material entirely.
    expect(drawn.length).toBeLessThanOrEqual(97);
    expect(casters.length).toBeLessThanOrEqual(64);
    expect(draws).toBeLessThanOrEqual(225);
  });

  it("still carries every part the airframe was authored as", () => {
    const { visual } = build();
    // Nothing dropped and nothing carried twice: `authoredParts` throws on a
    // duplicate, and this pins the total.
    //
    // 134 -> 164, DELIBERATELY, by the cockpit: the old instrument panel, its five
    // gauges and its five needles are gone (-11), and the cockpit-only kit adds 41
    // authored parts: the board, the glareshield, six screens, and six each of the
    // bezels' frames, their chamfered rims and the wells behind the screens (P1b: it
    // was 29 with one box a bezel and no wells), and the lining cast round the glass
    // (the sill, the crown and the post across the centreline, and a side each of two
    // pillars, two sills and two crowns). It was 30
    // while the post sat in a wider gap, lined a side each, until the post filled it.
    // It was 18 with the flat window boxes (the board and the overhead, the hood and
    // the dash, the pillar and the seam post, and the twelve screens and bezels), and
    // 21 before that, until the 3D attitude ball came out: the PFD page draws attitude
    // on the screen itself now. The seats and headrests are the same four parts,
    // moved with the pilot.
    //
    // +4, DELIBERATELY, by the spoiler bays: one authored plate per spoiler group and wing
    // (the dark well a raised panel uncovers), folded into one mesh.
    expect(authoredParts(visual).size).toBe(BEFORE.meshes - 11 + 41 + 4);
  });

  it("keeps the cockpit's six meshes outside every draw bound: invisible and never casting until cockpit view", () => {
    const { visual } = build();
    const kit = visual.cockpitOnlyParts ?? [];
    // Six: the interior (the board and the whole window frame's lining on one material), the glareshield (the
    // rounded deck alone), the six screens, their six frames, the frames' six chamfered rims (on the glowing
    // marking) and the six wells behind the screens. The last two came with the framed, recessed screens (P1b):
    // 4 -> 6, two draws on two draw states the frames' own material could not share (the rims glow at night, the
    // wells are the screens' dark face). It was seven until the 3D attitude ball came out -- its sky, ground and
    // pitch bar were three meshes AND three draws standing in front of a PFD that draws its own attitude now.
    expect(kit).toHaveLength(6);
    for (const part of kit) {
      expect(issuesDraw(part), `${part.name} is counted as a draw outside cockpit view`).toBe(false);
      expect(castsShadow(part), `${part.name} casts a shadow`).toBe(false);
    }
    const before = visual.meshes.filter(issuesDraw).length;
    visual.setCockpitView(true);
    // THE PERF RIG DRAWS NONE OF THIS. These six are what a PLAYER's cockpit view costs; the
    // fourteen perf capture shots run `PERF_COCKPIT_RIG`, which disables the aircraft's root
    // entirely in cockpit view, so the aeroplane contributes 0 draws there -- kit, skin, framing and
    // propeller disc alike (`tests/render.cockpit-rig.test.ts`).
    // in cockpit view they are drawn: six draws, no shadow passes
    const during = visual.meshes.filter(issuesDraw);
    expect(during.length - before).toBe(6);
    expect(during.filter(castsShadow).length).toBe(visual.meshes.filter((mesh) => issuesDraw(mesh) && castsShadow(mesh) && !kit.includes(mesh)).length);
    visual.setCockpitView(false);
    expect(visual.meshes.filter(issuesDraw)).toHaveLength(before);
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
    // post, the cockpit's 41 cockpit-only parts (there were the panel with 5 gauges
    // and 5 needles, 11; the kit was 21 until the 3D attitude ball came out, 18
    // until it was cast round the re-lofted glass, and 29 until the framed screens), 2 seats, 2 headrests, 8 main axle
    // shafts and the nose one, 6 panes of glass, 8 lamps and the 4 spoiler bays. The centre
    // post casts nothing whichever camera draws it: its shadow is the nose's.
    expect(enclosed.map(([name]) => name).sort()).toHaveLength(
      4 + 4 + 4 + 1 + 1 + 1 + 41 + 2 + 2 + 8 + 1 + 6 + 8 + 4,
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
    //
    // RE-MEASURED AGAIN by the cockpit, and read rather than accepted. 10,711 vertices to 11,163 is +452:
    // the old panel board (24), its five gauge faces (510) and its five needles (120) are gone, 654; the
    // kit adds 1,106 (board 24, overhead 60, hood 24, dash 36, six screens 144, six bezels 144, the ball's
    // three pieces 600, pillar 36, post 38), and the seats' 48 vertices only moved. The overhead, the dash,
    // the pillar and the ball's two halves are `solidPlate`s: three vertices of their own to a triangle
    // (20, 12, 12 and 2 x 96 triangles), which is why they weigh 60, 36, 36 and 2 x 288 vertices where a
    // shared-vertex extrusion has 12, 8, 8 and 2 x 50. They were built inside out at first, and a ray cast
    // could not say so (tests/render.cockpit-drawn-faces.test.ts asks what the GPU draws). The extents did
    // not move: nothing in the flight deck is at the airframe's edge. The area rose 4,652 -> 4,669 m^2 (the
    // overhead's two faces and the screens), and the signed volume by -0.20 m^3, which is the kit's closed
    // solids counted the right way round: measured, -0.13 of it is the plates being wound outward.
    //
    // Then the seam post went from radius 0.03 to 0.025 (it read chunky in the first live
    // frame): the counts did not move, the sums did, by what 5 mm of radius over 0.7 m of
    // post is: the area by -0.025 m^2, the position sum by 0.02.
    //
    // Then the post's MESH was run 0.08 m past its design top, into the overhead (AIRLINER_POST.buryMetres), and
    // the pillar and the post went onto the interior material and into its mesh. The counts did not move (11,163
    // and 51,624, the same triangles) and nor did the extents. What moved is the post's top ring and cap, 19
    // vertices, 0.08 m along the post's axis (-0.47, 0.66, 0.59): the position sum by (-0.72, +1.00, +0.89), the
    // area by +0.0128 m^2 (a rod of radius 0.025 gaining 0.08 m of side is 0.013), the signed volume by -0.0002.
    //
    // THEN 11,163 TO 10,563 when the 747's 3D attitude ball came out (the PFD page draws attitude on
    // the screen now). Every number below says it was the ball and nothing else that left: -600
    // vertices and -612 indices is exactly its three pieces (two `solidPlate` halves, 96 triangles
    // and 288 vertices each, and a 24-vertex box of 12); the position sum fell by 600 times the
    // PFD's own place, (30.6, 2.67, -0.72) -> (-18,383.6, -1,601.4, +432.0); the area by 0.0162 m^2,
    // which is two discs of radius 0.048 and a bar; the EXTENTS did not move at all, and neither did
    // the signed volume at 2 dp, because the halves are closed solids of half a cubic centimetre.
    //
    // THEN 10,563 TO 11,917 with the nose re-loft (docs/findings/AIRLINER_NOSE_GLAZING.md). The six
    // flight-deck panes went from 24-vertex boxes to skin panels cast onto the nose, 8 x 8 grids of 240
    // vertices and 756 indices each (+1,296 and +4,320), and the centre post from a 38-vertex strut to a
    // 2 x 8 skin strip (+58, +84). The radome's 31.4 ring moved (the brow) and changed no count. The
    // extents did not move. The position sum rose by what 1,354 vertices at the flight deck weigh, about
    // (31.3, 2.78) each: (+42,394, +3,763). Its z moved by +2.5, not 0, because the glass follows the skin
    // AS DRAWN, and the loft splits every quad on the same diagonal, which mirrors the other way on the
    // port side: port and starboard glass differ by up to 2.1 cm. The signed volume moved by -0.72 m^3 and
    // the area by +3.66 m^2, the brow's crown and the new plates less the old boxes.
    //
    // THEN 11,917 TO 12,033 with the fuselage/radome join (FUSELAGE_SECTIONS): the fuselage
    // goes from 13 rings to 17 (27.2 added; 28 reshaped; 29.6 and 30.6 replaced by five that
    // hug the nose from 29.2 to 30.8), +116 vertices (4 x 29) and +672 indices (4 x 28 x 6).
    // The nose keeps its count, and its 28 ring is reshaped. The extents did not move. The
    // position sum rose by about what 116 vertices at x ~ 29.3 weigh (+3,393 in x). The signed
    // volume moved by -13.32 m^3 and the area by +8.01 m^2: the census sums each closed loft on
    // its own, and the fuselage now runs to 30.8 hugging the nose instead of tapering away
    // inside it from 28, so the two overlap more.
    //
    // THEN 12,033 TO 14,555 with the cockpit kit cast round the re-lofted glass. The overhead (60 vertices), the
    // hood (24), the dash (36), the pillar (36) and the port seam post (38) left; the glareshield's lip (a 3-sided
    // `solidPlate`, 24) and the lining came, 16 skin panels of 2,692 vertices and 7,368 indices (a panel of r x c
    // grid points is 2rc + 8(c-1) + 8(r-1) vertices, and the strips are 4x16 and 7x16 across the centreline, then a
    // side each 8x2, 9x2, 5x8, 8x8, 7x2, 6x5 and 9x5): +2,522 and +7,128 exactly. The strips are cast on ONE set of
    // grid lines (`airlinerLiningLines`) so neighbours meet at the same points; sampled on rows of their own, K2's
    // first live frame showed hairline cracks of sky along the crown's seams. The board is the same box, 0.03
    // thinner; the seats moved 0.22 inboard and 0.05 aft with the eye. The extents did not move. The position sum's x
    // rose by about what 2,522 vertices at x ~31 weigh (+78,535); its z by +37.2, most of it the seam post leaving,
    // which stood on the port side alone (38 vertices at z about -1.1). The area rose by 7.42 m^2 (the lining's two
    // faces), the signed volume by -0.66 m^3.
    //
    // THEN, with no count moving, the centre member (CENTRE_POST_HALF_AZIMUTH): the No.1 panes start at az 1.6
    // instead of 2.5 and the post widens from +-1 to +-1.6 to fill the gap. Three meshes moved (the glazing, the
    // post, and the kit's lining, which reads the pane spec); the other 90 are bit-identical against 58f8b28. The
    // position sum's x rose by 4.95 (the inboard glass and the post's new edges sit further forward), the area by
    // 0.136 m^2 (the post's wider strip), the signed volume by -0.006 m^3.
    //
    // THEN the member settled at 1.9 (the cockpit engineer's measurement from the eye on the kit's lining: 3.67
    // degrees against the type's 3.6 and a 3.8 ceiling). The same three meshes moved and no count did; the other 90
    // are bit-identical against 1a0ec56. The position sum's x fell by 1.91 (back toward the 2.5 build), the area rose
    // by 0.078 m^2, the signed volume by -0.004 m^3.
    //
    // THEN, with the counts unchanged, the lining was thinned from the glass's own 0.10 m slab to 0.02 (0.008 out,
    // 0.012 in; K3: its side faces were half of every pillar's apparent width) and the lip, solved against the thin
    // sill's top edge, dropped from -18.04 to -18.57, taking the board's top and the screens down with it. The area
    // fell by 4.16 m^2 (the rims, a fifth as deep) and the signed volume rose by 0.75 m^3 (8 cm less depth over the
    // lining's 9-odd m^2); the position sums moved by what those shifts weigh.
    //
    // THEN 14,555 TO 14,395 when the post filled the centre gap and the kit lined its place: the two gap strips left
    // (8 x 2 grids, 96 vertices and 180 indices each), the post's strip came (9 x 2 on the lining's own rows, 108 and
    // 204), and the centre sill and crown lost their +-1 columns (4 x 16 -> 4 x 14 and 7 x 16 -> 7 x 14: 32 and 96, 44
    // and 168). -160 vertices and -420 indices exactly.
    //
    // THEN 14,395 TO 14,515 with the panel's integration (P1a): the glareshield went from the flush lip's 3-sided wedge
    // (8 triangles, 24 vertices) to a rounded deck (`airlinerGlareshieldSection`: 13 sides, 48 triangles, 144), +120
    // vertices and +120 indices exactly; the board, the screens and the bezels are the same boxes, leaned back 17
    // degrees. The extents and the position sum's z did not move; its x and y rose by what 120 vertices at the deck
    // weigh, about (30.6, 2.65) each (+3,675.7, +318.5). The area rose by 0.43 m^2 (the hood, 0.10 deep, over the
    // wedge's 0.05), the signed volume by -0.005 m^3.
    //
    // THEN 14,515 TO 15,667 with the framed, recessed screens (P1b, `framedScreenFacets`): each bezel's box (24
    // vertices, 36 indices) became a frame and a chamfered rim, closed solids of 16 unshared quads each (96 and 96),
    // and a well came behind each screen (a box, 24 and 36): six times +72 +96 +24 vertices and +60 +96 +36 indices,
    // +1,152 of each exactly. The screens are the same boxes, 0.5 mm thin and recessed. The extents and the position
    // sum's z did not move (each screen's pieces are symmetric about its own centre, and the six about the centreline
    // as before); its x and y rose by what 1,152 vertices at the board weigh, about (30.67, 2.53) each (+35,329.9,
    // +2,909.4). The area rose by 0.080 m^2 (the frames' and rims' walls and backs, the wells), the signed volume by
    // +0.002 m^3.
    //
    // THEN 15,667 TO 16,027 when the spoilers got their bays (the dark well under each panel): twelve conformed
    // plates, 2 x 3 x 5 grids, 30 vertices and 168 indices each (48 a face, 72 round the rim), +360 and +2,016
    // exactly, and nothing else moved. They sit aft and low, on the wing: the position sum's x fell by 1,733.3 and y by
    // 482.5 (360 vertices at a mean of x -4.8, y -1.34), z is untouched (they are symmetric), the area rose by 55.51
    // m^2 (two faces of about 27 m^2 of bay, and their 2 mm rims) and the signed volume by -0.054 m^3 (27 m^2 x 2 mm).
    //
    // THEN 16,027 TO 16,984 with the nose polish (2026-09-23), all of it in airliner-fuselage-shell. The fuselage's
    // 27.2 and 28 rings became fifteen blend rings, 26.2 to 29.0: +13 rings, +377 vertices and +2,184 indices (13 x 28
    // x 6). The nose went from 8 rings and two flat caps to 28 rings, a flat aft cap and a pole: 234 -> 814 vertices
    // and 1,344 -> 4,704 indices, +580 and +3,360. +957 and +5,544 exactly. The extents did not move: the pole is at
    // x 34, where the flat disc was. The rest moved by what 957 vertices round the fore-body weigh and by the reshaped
    // skin: the position sum's x rose by 27,477 (about x 28.7 each), the area by 6.40 m^2 and the signed volume by
    // -13.82 m^3 (it counts the buried nose inside the fuselage as well, so it is a check, not a volume). The normal
    // sum's x rose by 237.9: the nose's new rings face forward.
    const census = geometryCensus(build().visual);
    expect(census.vertices).toBe(16_984);
    expect(census.indices).toBe(71_628);
    expect(census.minimum.x).toBeCloseTo(-38.0000, 4);
    expect(census.minimum.y).toBeCloseTo(-6.4000, 4);
    expect(census.minimum.z).toBeCloseTo(-34.3500, 4);
    expect(census.maximum.x).toBeCloseTo(34.0000, 4);
    expect(census.maximum.y).toBeCloseTo(13.0000, 4);
    expect(census.maximum.z).toBeCloseTo(34.3500, 4);
    expect(census.positionSum.x).toBeCloseTo(200412.3591, 1);
    expect(census.positionSum.y).toBeCloseTo(-12867.8963, 1);
    expect(census.positionSum.z).toBeCloseTo(5.8467, 1);
    expect(census.positionSquares).toBeCloseTo(12688599.61, 0);
    expect(census.normalSum.x).toBeCloseTo(-294.6042, 2);
    expect(census.normalSum.y).toBeCloseTo(78.8021, 2);
    expect(census.normalSum.z).toBeCloseTo(-0.3751, 2);
    expect(census.normalMoment).toBeCloseTo(15998.0733, 1);
    expect(census.signedVolume).toBeCloseTo(-3241.5120, 2);
    expect(census.area).toBeCloseTo(4746.9383, 2);
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
    // 68 again, from 71: the attitude ball's three pieces hung from the PIVOT the cockpit's
    // update turned, exactly as a hinged surface hangs from its hinge. The ball is gone (the PFD
    // page draws attitude), and with it the only cockpit part that was not bolted to the root.
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
      // The centre post: the glass's 0.10 m slab, which against the cockpit kit's
      // 2 cm frame lining would stand 4.8 cm into the cabin; the kit lines its place.
      // (The cockpit camera drew it for a while, when the lining was the same slab.)
      "airliner-windscreen-center-post",
      // AND THE FLIGHT DECK GLAZING, deliberately, by the cockpit: the glass is a
      // refractive PBR, which draws as an opaque slab from inside, so from the
      // pilot's seat it was two dark trapezoids across the windscreen. All six
      // panes are carried by the one merged mesh.
      "starboard-airliner-flight-deck-window-one",
      "starboard-airliner-flight-deck-window-two",
      "starboard-airliner-flight-deck-window-three",
      "port-airliner-flight-deck-window-one",
      "port-airliner-flight-deck-window-two",
      "port-airliner-flight-deck-window-three",
    ].map((name) => {
      const carrier = parts.get(name);
      if (!carrier) throw new Error(`${name} is carried by no mesh`);
      return carrier;
    });
    // The list holds exactly the carriers: no disposed source left in it, and
    // nothing new swept on to the cockpit-excluded layer by a merge.
    expect(new Set(visual.cockpitParts)).toEqual(new Set(formerCockpitParts));
    const exteriorMask = camera.layerMask;

    const exteriorDraws = visual.meshes.filter((mesh) => issuesDraw(mesh) && (mesh.layerMask & camera.layerMask) !== 0);
    visual.setCockpitView(true);
    for (const mesh of visual.meshes) {
      const hidden = (mesh.layerMask & camera.layerMask) === 0;
      expect(hidden, `${mesh.name} in cockpit view`).toBe(formerCockpitParts.includes(mesh));
      // Still drawn, so still a shadow caster: excluded from this camera only.
      expect(mesh.isVisible, mesh.name).toBe(true);
    }
    // WHAT THE COCKPIT CAMERA DRAWS: everything the exterior camera does, less the shell, the post and the glazing,
    // plus the kit's six: 93. (It was 92 before the spoiler bays added their one mesh to both cameras, 90 with the
    // kit's four, before the framed screens' rims and wells, and 91 while the post was drawn from the seat, before
    // the kit lined it. The exterior camera's own count was 89 until the bays.)
    const cockpitDraws = visual.meshes.filter((mesh) => issuesDraw(mesh) && (mesh.layerMask & camera.layerMask) !== 0);
    expect(cockpitDraws.length).toBe(exteriorDraws.length - visual.cockpitParts.length + (visual.cockpitOnlyParts ?? []).length);
    expect(exteriorDraws.length).toBe(90);
    expect(cockpitDraws.length).toBe(93);
    expect(cockpitDraws.map((mesh) => mesh.name)).not.toContain("airliner-windscreen-center-post");
    for (const part of formerCockpitParts) {
      expect(part.layerMask).toBe(AIRCRAFT_EXTERIOR_LAYER_MASK);
    }

    visual.setCockpitView(false);
    expect(camera.layerMask).toBe(exteriorMask);
    const kit = new Set(visual.cockpitOnlyParts ?? []);
    for (const mesh of visual.meshes) {
      expect(mesh.layerMask & camera.layerMask, `${mesh.name} after restore`).not.toBe(0);
      // every part is visible again EXCEPT the cockpit-only kit, which is invisible outside cockpit view by design
      expect(mesh.isVisible, mesh.name).toBe(!kit.has(mesh));
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
