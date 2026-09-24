import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Constants } from "@babylonjs/core/Engines/constants";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { PBRMaterialDefines } from "@babylonjs/core/Materials/PBR/pbrBaseMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { InternalTexture } from "@babylonjs/core/Materials/Textures/internalTexture";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebGpuAircraft, type AircraftVisual } from "../src/render/webgpu/aircraft";
import { NOSE_SECTIONS } from "../src/render/webgpu/aircraft/airlinerVisual";
import { AircraftBuildContext, type LoftSection } from "../src/render/webgpu/aircraft/builders";
import {
  AIRLINER_LIVERY_SECTIONS,
  AIRLINER_LIVERY_STATION_RANGE,
  CHEATLINE,
  DOOR_WIDTH,
  LIVERY_NAVY,
  MAIN_DECK_DOORS,
  MAIN_DECK_FLOOR_Y,
  PANEL_LINE_STATIONS,
  buildAirlinerLivery,
  phaseOfHeight,
  radomeLiveryPhase,
  type LiveryImage,
} from "../src/render/webgpu/aircraft/airlinerLivery";
import { AIRCRAFT_KINDS, type AircraftKind } from "../src/sim";

/**
 * THE 747's LIVERY AS THE GPU WILL SEE IT: the mesh, the material and the
 * scene, where `render.airliner-livery.test.ts` reads the image alone.
 *
 * That file proves the PICTURE is right. Nothing there can see that the
 * picture is bound to the wrong UV set, sampled with the wrong wrap, laid on a
 * mesh whose vertex layout the device refuses, painted level on a loft that is
 * not the one showing, or left in the scene every time the aeroplane is
 * rebuilt. Each of those was either shipped in a build of this change or
 * measured on one, and each is invisible to a test that only reads bytes.
 *
 * THE DEVICE LIMIT THIS FILE EXISTS FOR. WebGPU counts a fragment stage's
 * inputs against a maximum of 16, `front_facing` included:
 *
 *     Total fragment input variables count
 *     (17 = 16 (user-defined) + 1 (front_facing)) exceeds the maximum (16)
 *
 * An intermediate build of this change put UV1, UV2 AND vertex colour on the
 * fuselage, and with the airfield's clustered container attached the device
 * refused the pipeline outright. Nothing warned: the 747 drew a black canvas
 * under the HTML HUD while every Node test was green, because NullEngine
 * compiles no shaders. The livery rides UV1 now, and the vertex-paint
 * cheatline's COLOUR is gone. The first describe block below turns "someone
 * re-added a colour channel or a second UV set to the fuselage" from a black
 * screen on a GPU into a red test in Node.
 */

const fixtures: Array<{ engine: NullEngine; scene: Scene; visual?: AircraftVisual }> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const entry of fixtures.splice(0)) {
    entry.visual?.dispose();
    entry.scene.dispose();
    entry.engine.dispose();
  }
});

function build(kind: AircraftKind): { scene: Scene; visual: AircraftVisual } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const visual = createWebGpuAircraft(scene, kind);
  fixtures.push({ engine, scene, visual });
  return { scene, visual };
}

function mesh(scene: Scene, name: string): Mesh {
  const found = scene.getMeshByName(name);
  if (!(found instanceof Mesh)) throw new Error(`no mesh "${name}"`);
  return found;
}

function drawnMeshes(scene: Scene): Mesh[] {
  return scene.meshes.filter((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
}

function data(target: Mesh, kind: string): number[] {
  return Array.from(target.getVerticesData(kind) ?? []);
}

/** The vertex kinds a mesh hands its material: each one present is a varying the fragment stage pays for. */
function layout(target: AbstractMesh): { uv: boolean; uv2: boolean; color: boolean } {
  return {
    uv: target.isVerticesDataPresent(VertexBuffer.UVKind),
    uv2: target.isVerticesDataPresent(VertexBuffer.UV2Kind),
    color: target.isVerticesDataPresent(VertexBuffer.ColorKind),
  };
}

/**
 * What the PBR material ITSELF decides to declare for a mesh, from Babylon's
 * own `_prepareDefines` run on a fresh defines object.
 *
 * PRIVATE API, ON PURPOSE. The public route is `isReadyForSubMesh`, and under
 * NullEngine it returns false before it computes a single define, so every
 * define reads false -- including VERTEXCOLOR on a mesh that carries colour.
 * An instrument that reads false on the case it exists to catch is not an
 * instrument. `_prepareDefines` is what `isReadyForSubMesh` calls once the
 * textures are ready, and it reads the same mesh kinds and the same texture
 * `coordinatesIndex` the shader will be built from. If Babylon renames it this
 * throws rather than passing.
 */
function declaredVaryings(target: Mesh): { uv2: boolean; vertexColor: boolean; albedoUv: unknown } {
  const material = target.material;
  if (!(material instanceof PBRMaterial)) throw new Error(`${target.name} is not on a PBR material`);
  const internals = material as unknown as {
    _prepareDefines?: (mesh: Mesh, rendering: Mesh, defines: PBRMaterialDefines, instances: boolean, clip: null) => void;
    _eventInfo?: { defineNames?: Record<string, { type: string; default: unknown }> };
  };
  if (typeof internals._prepareDefines !== "function") {
    throw new Error("PBRBaseMaterial._prepareDefines is gone; this probe needs re-finding, not skipping");
  }
  const defines = new PBRMaterialDefines(internals._eventInfo?.defineNames);
  internals._prepareDefines.call(material, target, target, defines, false, null);
  const read = defines as unknown as Record<string, unknown>;
  return { uv2: read.UV2 === true, vertexColor: read.VERTEXCOLOR === true, albedoUv: read.ALBEDODIRECTUV };
}

/** A copy of `source` with its own geometry, given a colour channel: what the black-screen build did to the shell. */
function withColour(source: Mesh): Mesh {
  const variant = source.clone(`${source.name}-coloured`);
  variant.makeGeometryUnique();
  variant.setVerticesData(VertexBuffer.ColorKind, new Array<number>(variant.getTotalVertices() * 4).fill(1), false);
  return variant;
}

describe("the 747's livery mesh fits the fragment stage", () => {
  it("carries UV1 alone: no second UV set and no vertex colour, so the 17th input cannot come back", () => {
    const { scene } = build("airliner");
    // Found by what it WEARS, not by name, so a second mesh given the livery
    // later is found too.
    const carriers = drawnMeshes(scene).filter(
      (m) => (m.material as PBRMaterial | null)?.albedoTexture?.name === "airliner-livery",
    );
    expect(carriers.map((m) => m.name), "the livery is on some other set of meshes")
      .toEqual(["airliner-fuselage-shell"]);
    const shell = carriers[0]!;

    // POSITIVE CONTROL, FIRST: the shell given a colour channel, as the
    // black-screen build had it. Both instruments must see it, or a false on
    // the shell below means nothing. Synthetic on purpose: no shipped 747 mesh
    // carries colour any more.
    const coloured = withColour(shell);
    expect(layout(coloured).color, "the layout check cannot see a colour buffer").toBe(true);
    expect(declaredVaryings(coloured).vertexColor, "the material probe cannot see vertex colour").toBe(true);
    coloured.dispose();

    // THE CHECK: one UV set and no colour, and the material declares neither a
    // second UV set nor a colour varying, and reads the livery through UV1.
    expect(layout(shell)).toEqual({ uv: true, uv2: false, color: false });
    expect(declaredVaryings(shell)).toEqual({ uv2: false, vertexColor: false, albedoUv: 1 });
  });

  it("never gives one mesh UV1, UV2 and vertex colour together, on any airframe", () => {
    // The same limit, fleet-wide. The Global's livery was vertex colour too
    // until it moved to an image (`bizjetLivery.ts`); the next airframe's
    // could be again.
    const allThree = (target: AbstractMesh) => {
      const kinds = layout(target);
      return kinds.uv && kinds.uv2 && kinds.color;
    };
    const offenders: string[] = [];
    let coloured = 0;
    for (const kind of AIRCRAFT_KINDS) {
      const { scene } = build(kind);
      for (const target of drawnMeshes(scene)) {
        if (layout(target).color) coloured += 1;
        if (allThree(target)) offenders.push(`${kind}/${target.name}`);
      }
    }
    expect(offenders, "a mesh carries all three: its pipeline fails on the GPU and it draws nothing")
      .toEqual([]);
    // NON-VACUITY: the fleet has colour in it, and the check flags a mesh that
    // has all three. Nothing in the fleet carries UV2, so that half is
    // synthetic. The colour half is real but small now: the trainer's
    // propeller disc (its vertex alpha) is the one coloured mesh left, since
    // the Global's livery -- 43 coloured meshes -- became an image.
    expect(coloured, "no mesh has vertex colour, so the conjunction was never tested").toBeGreaterThanOrEqual(1);
    const { scene } = build("airliner");
    const control = withColour(mesh(scene, "airliner-fuselage-shell"));
    control.setVerticesData(VertexBuffer.UV2Kind, data(control, VertexBuffer.UVKind), false);
    expect(allThree(control), "the check cannot see a mesh with all three").toBe(true);
    control.dispose();
  });
});

describe("the station range reaches UV1's u and nothing else", () => {
  const SECTIONS: readonly LoftSection[] = [
    { x: -3, yRadius: 0.9, zRadius: 1.2, yOffset: 0.2 },
    { x: 0, yRadius: 1.5, zRadius: 1.9, yOffset: 0.05, crownZRadius: 1.6 },
    { x: 4, yRadius: 1.1, zRadius: 1.2, squareness: 3 },
  ];
  const OWN_RANGE = { minimumX: -3, length: 7 } as const;
  const SHARED_RANGE = { minimumX: -10, length: 30 } as const;

  function bench(): { context: AircraftBuildContext; root: TransformNode } {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    fixtures.push({ engine, scene });
    return { context: new AircraftBuildContext(scene), root: new TransformNode("bench-root", scene) };
  }

  it("rewrites loft()'s u from the range only when asked, and moves no position, normal, index or v", () => {
    const { context, root } = bench();
    const paint = context.material("range-probe", 0xffffff);
    const plain = context.loft("plain", SECTIONS, 24, paint, root);
    const shared = context.loft("shared", SECTIONS, 24, paint, root, SHARED_RANGE);
    for (const kind of [VertexBuffer.PositionKind, VertexBuffer.NormalKind]) {
      expect(data(shared, kind), `${kind} moved when a station range was passed`).toEqual(data(plain, kind));
    }
    expect(Array.from(shared.getIndices()!)).toEqual(Array.from(plain.getIndices()!));
    expect(layout(shared).uv2, "a station range grew a second UV set").toBe(false);

    // u is the SHARED station of each vertex's own x, and v is untouched, on
    // every vertex -- the two cap centres included.
    const positions = data(shared, VertexBuffer.PositionKind);
    const uv = data(shared, VertexBuffer.UVKind);
    const plainUv = data(plain, VertexBuffer.UVKind);
    for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
      const station = (positions[vertex * 3]! - SHARED_RANGE.minimumX) / SHARED_RANGE.length;
      expect(uv[vertex * 2]!, `vertex ${vertex} u`).toBeCloseTo(station, 6);
      expect(uv[vertex * 2 + 1], `vertex ${vertex} v`).toBe(plainUv[vertex * 2 + 1]);
    }

    // CONTROL, both ways. The loft's OWN range must reproduce the plain loft's
    // UV exactly -- so an absent range and a range are one parametrisation --
    // and the shared range must differ from it almost everywhere, so the loop
    // above read a rewritten u and not the plain one twice.
    const own = context.loft("own", SECTIONS, 24, paint, root, OWN_RANGE);
    expect(data(own, VertexBuffer.UVKind)).toEqual(plainUv);
    const differing = uv.filter((value, index) => index % 2 === 0 && value !== plainUv[index]).length;
    expect(differing, "u equals the plain loft's: the shared range never reached it").toBeGreaterThan(70);
  });

  it("refuses a station range that cannot parametrise anything", () => {
    const { context, root } = bench();
    const paint = context.material("range-probe", 0xffffff);
    for (const range of [
      { minimumX: 0, length: 0 },
      { minimumX: 0, length: -60 },
      { minimumX: 0, length: Number.NaN },
      { minimumX: Number.NaN, length: 60 },
      { minimumX: Number.POSITIVE_INFINITY, length: 60 },
      { minimumX: 0, length: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => context.loft("bad", SECTIONS, 24, paint, root, range), `${range.minimumX}, ${range.length}`)
        .toThrow(RangeError);
    }
    // And a sane one is accepted, so the refusals above are about the range.
    expect(() => context.loft("good", SECTIONS, 24, paint, root, SHARED_RANGE)).not.toThrow();
  });

  it("puts the shared station in the shell's u, the fuselage's own phase in its v, and the radome's re-solved v", () => {
    // Capture each livery loft AS BUILT, before the radome's v is re-solved
    // and before `mergeStatic` folds both into the shell.
    const built = new Map<string, { sections: readonly LoftSection[]; uv: number[] }>();
    const original = AircraftBuildContext.prototype.loft;
    vi.spyOn(AircraftBuildContext.prototype, "loft").mockImplementation(
      function (this: AircraftBuildContext, ...args: Parameters<typeof original>) {
        const made = original.apply(this, args);
        if (args[5]) built.set(args[0], { sections: args[1], uv: data(made, VertexBuffer.UVKind) });
        return made;
      },
    );
    const { scene } = build("airliner");
    vi.restoreAllMocks();
    expect([...built.keys()].sort()).toEqual(["airliner-fuselage", "airliner-radome"]);

    // No mesh in the fleet has a second UV set: the livery is on UV1.
    let scanned = 0;
    const secondUv: string[] = [];
    for (const kind of AIRCRAFT_KINDS) {
      const fleet = kind === "airliner" ? scene : build(kind).scene;
      for (const target of drawnMeshes(fleet)) {
        scanned += 1;
        if (layout(target).uv2) secondUv.push(`${kind}/${target.name}`);
      }
    }
    expect(scanned, "the fleet built too few meshes to mean anything").toBeGreaterThan(300);
    expect(secondUv).toEqual([]);

    const shell = mesh(scene, "airliner-fuselage-shell");
    expect(shell.metadata?.mergedFrom).toEqual(["airliner-fuselage", "airliner-radome"]);
    shell.computeWorldMatrix(true);
    expect(shell.getWorldMatrix().isIdentity(), "the shell is not in body space; x is not the station")
      .toBe(true);
    const positions = data(shell, VertexBuffer.PositionKind);
    const uv = data(shell, VertexBuffer.UVKind);
    const fuselage = built.get("airliner-fuselage")!;
    const radome = built.get("airliner-radome")!;
    const fuselageCount = fuselage.uv.length / 2;
    expect(fuselageCount + radome.uv.length / 2, "the shell is not the two lofts").toBe(positions.length / 3);
    const { minimumX, length } = AIRLINER_LIVERY_STATION_RANGE;
    let moved = 0;
    for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
      const x = positions[vertex * 3]!;
      const y = positions[vertex * 3 + 1]!;
      expect(uv[vertex * 2]!, `shell vertex ${vertex} u`).toBeCloseTo((x - minimumX) / length, 6);
      if (vertex < fuselageCount) {
        expect(uv[vertex * 2 + 1], `fuselage vertex ${vertex} v`).toBe(fuselage.uv[vertex * 2 + 1]);
      } else {
        const own = radome.uv[(vertex - fuselageCount) * 2 + 1]!;
        expect(uv[vertex * 2 + 1]!, `radome vertex ${vertex} v`).toBeCloseTo(radomeLiveryPhase(radome.sections, x, y, own), 12);
        if (Math.abs(uv[vertex * 2 + 1]! - own) > 1e-3) moved += 1;
      }
    }
    // CONTROL: the re-solve moved much of the radome, so the comparison above
    // was not own-phase against own-phase. (80 since the nose join: the radome's
    // 28 ring is now the fuselage's own section scaled 0.97, whose phase the
    // table's barely moves; it was over 100 when that ring was the radome's own.)
    expect(moved, "the radome's v was never re-solved").toBeGreaterThan(50);
  });

  it("changes nothing but the shell's UVs across the whole fleet: built without the range, only UV1 differs", () => {
    // NOT A GOLDEN FILE, deliberately. `render.loft-crown-seam.test.ts` pins
    // positions+indices per airframe and has been re-pinned seven times, each
    // one needing a mesh-by-mesh human check to know the re-pin was innocent.
    // This asks the one question this change raises -- does the station range
    // touch anything besides UV1? -- by building the fleet twice in one run,
    // once as shipped and once with every loft's station range stripped, and
    // diffing the two. It needs no stored value, survives every unrelated
    // geometry change, and fails only if the range leaks.
    const original = AircraftBuildContext.prototype.loft;
    type LoftArgs = Parameters<typeof original>;
    const snapshot = (kind: AircraftKind, alter?: (...args: LoftArgs) => Mesh) => {
      const spy = alter
        ? vi.spyOn(AircraftBuildContext.prototype, "loft").mockImplementation(
          function (this: AircraftBuildContext, ...args: LoftArgs) { return alter.call(this, ...args); },
        )
        : undefined;
      const { scene } = build(kind);
      spy?.mockRestore();
      const out = new Map<string, Record<string, number[]>>();
      const seen = new Map<string, number>();
      for (const target of drawnMeshes(scene)) {
        // Build order is deterministic, so the Nth mesh of a name is the same
        // part in both builds; `uniqueId` is not, and would never match.
        const occurrence = (seen.get(target.name) ?? 0) + 1;
        seen.set(target.name, occurrence);
        const key = occurrence === 1 ? target.name : `${target.name}#${occurrence}`;
        out.set(key, {
          position: data(target, VertexBuffer.PositionKind),
          normal: data(target, VertexBuffer.NormalKind),
          uv: data(target, VertexBuffer.UVKind),
          uv2: data(target, VertexBuffer.UV2Kind),
          color: data(target, VertexBuffer.ColorKind),
          indices: Array.from(target.getIndices() ?? []),
        });
      }
      return out;
    };
    const diff = (a: Map<string, Record<string, number[]>>, b: Map<string, Record<string, number[]>>): string[] => {
      const found: string[] = [];
      expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
      for (const [name, fields] of a) {
        for (const [field, values] of Object.entries(fields)) {
          const other = b.get(name)![field]!;
          if (values.length !== other.length || values.some((value, index) => !Object.is(value, other[index]))) {
            found.push(`${name}.${field}`);
          }
        }
      }
      return found;
    };
    function stripped(this: AircraftBuildContext, ...args: LoftArgs): Mesh {
      // The range stripped and nothing else: the caps argument (the nose's pole) stays.
      return original.call(this, args[0], args[1], args[2], args[3], args[4], undefined, args[6]);
    }

    // Which lofts take the range at all: none on three airframes, two on the 747.
    const withRange: string[] = [];
    const recorder = vi.spyOn(AircraftBuildContext.prototype, "loft").mockImplementation(
      function (this: AircraftBuildContext, ...args: LoftArgs) {
        if (args[5]) withRange.push(args[0]);
        return original.apply(this, args);
      },
    );
    for (const kind of AIRCRAFT_KINDS) build(kind);
    recorder.mockRestore();
    expect(withRange.sort()).toEqual(["airliner-fuselage", "airliner-radome"]);

    for (const kind of AIRCRAFT_KINDS) {
      const expected = kind === "airliner" ? ["airliner-fuselage-shell.uv"] : [];
      expect(diff(snapshot(kind), snapshot(kind, stripped)), kind).toEqual(expected);
    }

    // POSITIVE CONTROL: a range that also leaked into the normals must show up,
    // on the shell's normals, or the comparison above compared nothing.
    const leaky = function (this: AircraftBuildContext, ...args: LoftArgs): Mesh {
      const made = original.apply(this, args);
      if (args[5]) {
        const normals = data(made, VertexBuffer.NormalKind);
        normals[0] = normals[0]! + 1e-3;
        made.setVerticesData(VertexBuffer.NormalKind, normals, false);
      }
      return made;
    };
    expect(diff(snapshot("airliner"), snapshot("airliner", leaky))).toEqual(["airliner-fuselage-shell.normal"]);
  });
});

describe("the skin material", () => {
  it("binds the livery as the skin's albedo on UV1, u clamped and v wrapped, and leaves the body's albedo alone", () => {
    const { scene } = build("airliner");
    const shell = mesh(scene, "airliner-fuselage-shell");
    const skin = shell.material;
    expect(skin).toBeInstanceOf(PBRMaterial);
    expect(skin!.name).toBe("airliner-skin");
    const livery = (skin as PBRMaterial).albedoTexture;
    expect(livery).toBeInstanceOf(RawTexture);
    expect(livery!.name).toBe("airliner-livery");
    expect(livery!.getSize()).toEqual({ width: 2048, height: 512 });
    expect(livery!.coordinatesIndex, "the livery must ride on UV1").toBe(0);
    // u CLAMPS: the station range ends at the fuselage's aft end. v WRAPS: the
    // seam is the duplicated crown vertex.
    expect(livery!.wrapU).toBe(Texture.CLAMP_ADDRESSMODE);
    expect(livery!.wrapV).toBe(Texture.WRAP_ADDRESSMODE);
    expect(declaredVaryings(shell).albedoUv).toBe(1);

    // CONTROL: the body keeps its own synthesized albedo; the livery did not
    // leak onto the rest of the airframe.
    const body = mesh(scene, "airliner-body-exterior").material as PBRMaterial;
    expect(body.name).toBe("airliner-body");
    expect(body.albedoTexture!.name).toBe("airliner-body-albedo");
    expect(body.albedoTexture).not.toBe(livery);
  });

  it("uses the body's normal and metallic-roughness texture OBJECTS on the skin", () => {
    // The skin was first `body.clone()`. `PBRMaterial.clone` clones every
    // texture, and a cloned RawTexture keeps the constructor's defaults and
    // copies none of the settings made after it:
    //
    //   normal map strength (level)   body 0.42   skin 1
    //   wrapU / wrapV                 body WRAP   skin CLAMP
    //   anisotropicFilteringLevel     body 8      skin 4
    //
    // and each clone allocated a GPU texture that nothing owned. Sharing the
    // same objects is the only arrangement with none of that, so this asserts
    // identity, which a clone-then-copy-back cannot pass.
    const { scene } = build("airliner");
    const skin = mesh(scene, "airliner-fuselage-shell").material as PBRMaterial;
    const body = mesh(scene, "airliner-body-exterior").material as PBRMaterial;
    // CONTROL: the body's normal level is paintMaterial's 0.42, not the 1 a
    // fresh (or cloned) RawTexture has, so a dropped setting cannot pass.
    expect(body.bumpTexture!.level).toBe(0.42);
    for (const slot of ["bumpTexture", "metallicTexture"] as const) {
      expect(body[slot], `the body has no ${slot}`).toBeTruthy();
      expect(skin[slot], `${slot}: the skin has its own wrapper (a clone)`).toBe(body[slot]);
    }
    expect(skin.albedoTexture, "the skin wears the body's albedo, not the livery").not.toBe(body.albedoTexture);
    expect(skin.maxSimultaneousLights).toBe(body.maxSimultaneousLights);
  });
});

describe("the cheatline on the built fuselage", () => {
  /**
   * THE INSTRUMENT. A horizontal ray from starboard at (x, y), against the
   * built shell's triangles; the hit with the largest z is the OUTER skin --
   * the one a camera sees -- because the fuselage and the radome overlap from
   * x = 25.5 to 30.6 and one of them is always inside the other. The hit's UV
   * is interpolated barycentrically, as the rasteriser does, and looked up in
   * the livery's level 0 with the sampler's own rules (u CLAMP, v WRAP).
   *
   * It reads the MESH and the IMAGE together, which is the point: the image
   * test proves the band is level on the section table it was solved from,
   * and cannot know which loft's surface that table describes.
   */
  function outerSkin(shell: Mesh) {
    const positions = shell.getVerticesData(VertexBuffer.PositionKind)!;
    const uv = shell.getVerticesData(VertexBuffer.UVKind)!;
    const indices = shell.getIndices()!;
    return (x: number, y: number): { u: number; v: number } | undefined => {
      let best: { z: number; u: number; v: number } | undefined;
      for (let t = 0; t < indices.length; t += 3) {
        const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
        const ax = positions[a * 3]!, ay = positions[a * 3 + 1]!;
        const bx = positions[b * 3]!, by = positions[b * 3 + 1]!;
        const cx = positions[c * 3]!, cy = positions[c * 3 + 1]!;
        const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(det) < 1e-12) continue;
        const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
        const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        const z = l1 * positions[a * 3 + 2]! + l2 * positions[b * 3 + 2]! + l3 * positions[c * 3 + 2]!;
        if (best && z <= best.z) continue;
        best = {
          z,
          u: l1 * uv[a * 2]! + l2 * uv[b * 2]! + l3 * uv[c * 2]!,
          v: l1 * uv[a * 2 + 1]! + l2 * uv[b * 2 + 1]! + l3 * uv[c * 2 + 1]!,
        };
      }
      return best;
    };
  }

  function texel(image: LiveryImage, u: number, v: number): readonly [number, number, number] {
    const column = Math.min(image.width - 1, Math.max(0, Math.floor(u * image.width)));
    const row = ((Math.floor(v * image.height) % image.height) + image.height) % image.height;
    const index = (row * image.width + column) * 4;
    return [image.data[index]!, image.data[index + 1]!, image.data[index + 2]!];
  }

  /** Navy coverage of a texel by its red channel: 0 on white, 1 on navy. */
  function coverage(image: LiveryImage, u: number, v: number): number {
    return (255 - texel(image, u, v)[0]) / (255 - LIVERY_NAVY[0]);
  }

  /** The band's top and bottom edges on the outer starboard skin at one station. */
  function edges(skinAt: ReturnType<typeof outerSkin>, image: LiveryImage, x: number) {
    let top: number | undefined;
    let bottom: number | undefined;
    for (let y = 0.6; y >= -2.4; y -= 0.005) {
      const hit = skinAt(x, y);
      if (!hit || coverage(image, hit.u, hit.v) < 0.5) continue;
      if (top === undefined) top = y;
      bottom = y;
    }
    return { top, bottom };
  }

  // Door 1's span is NOT excluded: the fuselage/radome crossover (x ~ 27.0 for
  // the bottom edge, ~ 27.75 for the top) sits inside it. Only its jambs, its
  // window and the frame lines are.
  const STATIONS = [-20, -6, 5, 13, 21, 26, 27, 27.2, 27.6, 27.8, 28.3, 29, 29.3, 29.6, 30, 30.3, 30.5];
  const clearOfPaint = (x: number) => MAIN_DECK_DOORS.every((door) => {
    const aft = door.x - DOOR_WIDTH / 2;
    const forward = door.x + DOOR_WIDTH / 2;
    return (x < aft - 0.03 || x > aft + 0.09) && (x < forward - 0.09 || x > forward + 0.03)
      && Math.abs(x - door.x) > 0.16;
  }) && PANEL_LINE_STATIONS.every((line) => Math.abs(x - line) > 0.1);
  /** A texel is 4 cm round the cabin; the scan steps 5 mm. */
  const TOLERANCE_M = 0.05;

  it("keeps BOTH band edges level on the OUTER skin across the fuselage/radome crossover", () => {
    // The image's v is solved on the FUSELAGE's sections. With the radome on
    // its own phase, from x ~ 27.0 forward -- where the radome is the outer
    // skin -- the band sat 0.23-0.49 m low, split into two strips at the
    // crossover, and grew to ~1.2 m tall by x = 30.6. `radomeLiveryPhase` is
    // the fix, and this is its acceptance.
    expect(STATIONS.every((x) => x >= CHEATLINE.aftFullX && x <= CHEATLINE.forwardFullX && clearOfPaint(x)),
      "a station sits on a door or a frame line: the scan would find that instead").toBe(true);
    const { scene } = build("airliner");
    const skinAt = outerSkin(mesh(scene, "airliner-fuselage-shell"));
    const livery = buildAirlinerLivery();

    // POSITIVE CONTROL, same instrument, same stations: a band painted as a
    // STRAIGHT row -- the cabin's rows carried forward at constant v, the
    // defect `render.airliner-livery.test.ts` 5b paints -- is level where it
    // was anchored and NOT level forward. If the instrument called that level
    // it could not be trusted to call the shipped band level either.
    const straight: LiveryImage = {
      width: livery.width, height: livery.height, data: new Uint8Array(livery.data.length).fill(255),
    };
    const firstRow = Math.floor(phaseOfHeight(AIRLINER_LIVERY_SECTIONS, -20, CHEATLINE.topY)! * straight.height);
    const lastRow = Math.floor(phaseOfHeight(AIRLINER_LIVERY_SECTIONS, -20, CHEATLINE.bottomY)! * straight.height);
    for (let column = 0; column < straight.width; column += 1) {
      for (let row = firstRow; row <= lastRow; row += 1) {
        for (const r of [row, straight.height - 1 - row]) straight.data.set(LIVERY_NAVY, (r * straight.width + column) * 4);
      }
    }
    expect(Math.abs(edges(skinAt, straight, -20).top! - CHEATLINE.topY)).toBeLessThanOrEqual(TOLERANCE_M);
    const controlOff = STATIONS.filter((x) => {
      const top = edges(skinAt, straight, x).top;
      return top === undefined || Math.abs(top - CHEATLINE.topY) > TOLERANCE_M;
    });
    expect(controlOff.length, "the instrument calls a straight row level").toBeGreaterThanOrEqual(5);

    // THE CHECK: level at every station, on whichever loft is outside there.
    const off = STATIONS.flatMap((x) => {
      const { top, bottom } = edges(skinAt, livery, x);
      return [
        ...(top === undefined || Math.abs(top - CHEATLINE.topY) > TOLERANCE_M ? [`x=${x}: top ${top?.toFixed(3) ?? "none"}`] : []),
        ...(bottom === undefined || Math.abs(bottom - CHEATLINE.bottomY) > TOLERANCE_M ? [`x=${x}: bottom ${bottom?.toFixed(3) ?? "none"}`] : []),
      ];
    });
    expect(off, `band edges should be ${CHEATLINE.topY} / ${CHEATLINE.bottomY} on the outer skin`).toEqual([]);
  });

  it("draws door 1's jambs down to the main-deck floor on the outer skin, like doors 2 and 4", () => {
    // Door 1 straddles the crossover. On the radome's own phase its jambs ran
    // 0.4 m below the floor, and a ghost door window showed under the real one.
    const { scene } = build("airliner");
    const skinAt = outerSkin(mesh(scene, "airliner-fuselage-shell"));
    const livery = buildAirlinerLivery();
    // Door outline: shade 0.55 over white (140) or over navy (15, 32, 59).
    const isOutline = (t: readonly [number, number, number]) => (Math.abs(t[0] - 140) <= 2 && Math.abs(t[1] - 140) <= 2)
      || (Math.abs(t[0] - 15) <= 2 && Math.abs(t[1] - 32) <= 2 && Math.abs(t[2] - 59) <= 2);
    const jambBottom = (x: number) => {
      let bottom: number | undefined;
      for (let y = 2.0; y >= -2.4; y -= 0.005) {
        const hit = skinAt(x, y);
        if (hit && isOutline(texel(livery, hit.u, hit.v))) bottom = y;
      }
      return bottom;
    };
    // CONTROLS, wholly on the fuselage loft.
    for (const x of [-15.01, 17.99]) {
      expect(Math.abs(jambBottom(x)! - MAIN_DECK_FLOOR_Y), `control jamb x=${x}`).toBeLessThanOrEqual(0.05);
    }
    for (const x of [27.47, 28.52]) {
      expect(Math.abs(jambBottom(x)! - MAIN_DECK_FLOOR_Y), `door 1 jamb x=${x}`).toBeLessThanOrEqual(0.05);
    }
  });

  it("re-solves the radome's v without folding it: every ring still runs crown to keel in order", () => {
    // That v is also the paint maps' v, so a fold is mirrored panel lines and
    // a squeeze is smeared ones. The first re-solve folded (a step of -0.25 of
    // its own size at x = 30.4) and squeezed (0.09 at x = 31.4).
    let own: number[] = [];
    let segments = 0;
    const original = AircraftBuildContext.prototype.loft;
    vi.spyOn(AircraftBuildContext.prototype, "loft").mockImplementation(
      function (this: AircraftBuildContext, ...args: Parameters<typeof original>) {
        const made = original.apply(this, args);
        if (args[0] === "airliner-radome") {
          own = data(made, VertexBuffer.UVKind);
          segments = args[2];
        }
        return made;
      },
    );
    const { scene } = build("airliner");
    vi.restoreAllMocks();
    const shell = mesh(scene, "airliner-fuselage-shell");
    const uv = data(shell, VertexBuffer.UVKind);
    const offset = uv.length / 2 - own.length / 2;
    const ring = segments + 1;
    const rings = Math.floor(own.length / 2 / ring);
    const ratios = (v: (index: number) => number) => {
      const found: number[] = [];
      for (let r = 0; r < rings; r += 1) {
        for (let k = 0; k < segments; k += 1) {
          const a = r * ring + k;
          found.push((v(a + 1) - v(a)) / (own[(a + 1) * 2 + 1]! - own[a * 2 + 1]!));
        }
      }
      return found;
    };
    const shipped = ratios((index) => uv[(offset + index) * 2 + 1]!);
    // One ratio per step round every ring of the nose (28 rings since the nose polish; 8 before it).
    expect(shipped.length, "no radome ring was read").toBe(NOSE_SECTIONS.length * 28);
    const worst = { low: Math.min(...shipped), high: Math.max(...shipped) };
    // Measured 0.678 .. 1.315 of the loft's own step over the nose's 28 rings (0.73 .. 1.32 over the old eight).
    expect(worst.low, "a radome ring's v runs backwards or all but stops").toBeGreaterThan(0.6);
    expect(worst.high, "a radome ring's v is stretched").toBeLessThan(1.6);
    // CONTROL: the check sees a fold. Swap two neighbours' v on one ring.
    const folded = [...uv];
    const a = offset + 3 * ring + 9;
    [folded[a * 2 + 1], folded[(a + 1) * 2 + 1]] = [folded[(a + 1) * 2 + 1]!, folded[a * 2 + 1]!];
    expect(Math.min(...ratios((index) => folded[(offset + index) * 2 + 1]!))).toBeLessThan(0);
  });

  it("solves the band against the section table the fuselage is actually BUILT from", () => {
    // `AIRLINER_LIVERY_SECTIONS` is a TRANSCRIPTION of `FUSELAGE_SECTIONS`,
    // which is private to `airlinerVisual.ts`. Nothing ties the two, so the
    // next edit to the fuselage's shape moves the skin and leaves the band
    // solved for the old one: level in the image test, off level on the
    // aeroplane. Read the built loft's rings back instead of trusting the copy.
    const rings: Array<{ x: number; crown: number; keel: number; flank: number }> = [];
    let segments = 0;
    const original = AircraftBuildContext.prototype.loft;
    vi.spyOn(AircraftBuildContext.prototype, "loft").mockImplementation(
      function (this: AircraftBuildContext, ...args: Parameters<typeof original>) {
        const made = original.apply(this, args);
        if (args[0] === "airliner-fuselage") {
          // Read NOW: `mergeStatic` disposes the loft into the shell later.
          const positions = made.getVerticesData(VertexBuffer.PositionKind)!;
          segments = args[2];
          const ring = segments + 1;
          for (let index = 0; index < args[1].length; index += 1) {
            const at = (radial: number) => positions[(index * ring + radial) * 3 + 1]!;
            rings.push({
              x: positions[index * ring * 3]!,
              crown: at(0),
              keel: at(segments / 2),
              flank: at(segments / 4 - 3), // an off-axis vertex, so squareness is read too
            });
          }
        }
        return made;
      },
    );
    build("airliner");
    vi.restoreAllMocks();
    expect(rings.length, "the fuselage loft was never seen").toBe(AIRLINER_LIVERY_SECTIONS.length);

    const mismatch = (table: readonly LoftSection[]): string[] => rings.flatMap((ring, index) => {
      const section = table[index]!;
      const yOffset = section.yOffset ?? 0;
      const angle = ((segments / 4 - 3) / segments) * 2 * Math.PI;
      const shape = Math.sign(Math.cos(angle)) * Math.abs(Math.cos(angle)) ** (2 / (section.squareness ?? 2));
      const expectFlank = yOffset + shape * section.yRadius;
      const wrong = Math.abs(ring.x - section.x) > 1e-9
        || Math.abs(ring.crown - (yOffset + section.yRadius)) > 1e-5
        || Math.abs(ring.keel - (yOffset - section.yRadius)) > 1e-5
        || Math.abs(ring.flank - expectFlank) > 1e-5;
      return wrong ? [`section ${index} at x = ${ring.x}`] : [];
    });
    expect(mismatch(AIRLINER_LIVERY_SECTIONS), "the livery is solved for a fuselage that was not built")
      .toEqual([]);
    // CONTROL: a 2 cm change to one section's offset -- smaller than a texel
    // round the cabin -- is caught, so an equal table is evidence.
    const nudged = AIRLINER_LIVERY_SECTIONS.map((section, index) =>
      index === 6 ? { ...section, yOffset: (section.yOffset ?? 0) + 0.02 } : section);
    expect(mismatch(nudged)).toEqual(["section 6 at x = 13"]);
  });
});

describe("rebuilding the 747", () => {
  it("leaves no texture and no material behind, however many times it is built and disposed", () => {
    // `AircraftVisual.dispose()` is the airframe's promise to release what it
    // built. The game does not see a break in it TODAY only because
    // `FlightRenderer` disposes the scene and then the engine straight after
    // the aircraft, and those sweep up whatever the aircraft left. Any
    // consumer that keeps the scene -- a tool cycling airframes, an in-flight
    // aircraft switch -- would keep a 2048 x 512 livery per build. With the
    // skin built as `body.clone()`, every 747 cycle left the livery, the three
    // nameless RawTextures the clone made of the body's maps, and the
    // `airliner-skin` material: neither the clone nor the livery was
    // registered with the build context.
    //
    // COUNTED ON THE SCENE, NOT THE ENGINE: `engine.getLoadedTexturesCache()`
    // reads 0 under NullEngine even with eleven textures alive, so it cannot
    // see a leak at all.
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    fixtures.push({ engine, scene });
    // WARM-UP: the first PBR build makes the scene's shared BRDF lookup
    // texture, which is the scene's to keep. The baseline includes it.
    createWebGpuAircraft(scene, "trainer").dispose();
    const census = () => ({
      textures: scene.textures.map((texture) => texture.name).sort(),
      materials: scene.materials.map((material) => material.name).sort(),
    });
    const baseline = census();

    // CONTROL 1: an airframe known to clean up reads clean on this instrument...
    for (let cycle = 0; cycle < 3; cycle += 1) createWebGpuAircraft(scene, "trainer").dispose();
    expect(census(), "the trainer leaks: the baseline is wrong, not the 747").toEqual(baseline);
    // CONTROL 2: ...and the instrument sees one texture and one material the
    // build did not own.
    const stray = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene, false, false,
      Constants.TEXTURE_NEAREST_SAMPLINGMODE);
    stray.name = "stray";
    const strayMaterial = new PBRMaterial("stray", scene);
    expect(census().textures.length - baseline.textures.length).toBe(1);
    expect(census().materials.length - baseline.materials.length).toBe(1);
    stray.dispose();
    strayMaterial.dispose();

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const visual = createWebGpuAircraft(scene, "airliner");
      expect(scene.textures.some((texture) => texture.name === "airliner-livery"), "no livery was built")
        .toBe(true);
      visual.dispose();
      expect(census(), `after 747 cycle ${cycle}`).toEqual(baseline);
    }
  });

  it("releases every texture the build ALLOCATED, including the ones no scene list can see", () => {
    // The scene's list is not the whole story. `RawTexture.clone()` -- which
    // `PBRMaterial.clone` calls for every map it copies -- runs the RawTexture
    // CONSTRUCTOR, which allocates a fresh internal texture of the full size,
    // and then overwrites that pointer with the source's. The fresh one is held
    // by nothing, is in no scene list, and is released by no dispose.
    //
    // Reads `InternalTexture._references`: private, and the only count Babylon
    // keeps. `engine.getLoadedTexturesCache()` is the public one and reads 0
    // under NullEngine whatever is alive.
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    fixtures.push({ engine, scene });
    const allocated: InternalTexture[] = [];
    const host = engine as unknown as { createRawTexture: (...args: unknown[]) => InternalTexture };
    const create = host.createRawTexture.bind(engine);
    host.createRawTexture = (...args: unknown[]) => {
      const texture = create(...args);
      allocated.push(texture);
      return texture;
    };
    const alive = () => allocated
      .filter((texture) => (texture as unknown as { _references: number })._references > 0)
      .map((texture) => `${texture.width}x${texture.height}`);

    // CONTROL: an airframe that cleans up allocates textures (so the spy is
    // wired) and releases every one (so "alive" can read empty).
    createWebGpuAircraft(scene, "trainer").dispose();
    expect(allocated.length, "the spy saw no allocation: it is not wired").toBeGreaterThan(0);
    expect(alive(), "the trainer holds textures after dispose: the instrument is wrong").toEqual([]);
    allocated.length = 0;
    // ...and it can see one that is not released.
    const held = create(new Uint8Array(4), 1, 1, Constants.TEXTUREFORMAT_RGBA, false, false, 1, null, 0, 0, false);
    allocated.push(held);
    expect(alive()).toEqual(["1x1"]);
    held.dispose();
    allocated.length = 0;

    createWebGpuAircraft(scene, "airliner").dispose();
    expect(allocated.length, "the 747 allocated nothing: the spy missed its build").toBeGreaterThan(0);
    expect(alive(), "textures the 747 allocated outlive its dispose()").toEqual([]);
  });
});

describe("the spoiler rim material", () => {
  const SPOILERS = ["port", "starboard"].flatMap((side) =>
    ["flight", "ground"].map((group) => `${side}-airliner-${group}-spoilers-surface`)).sort();

  it("is worn by the four spoiler meshes and nothing else, on UV1 alone", () => {
    const { scene } = build("airliner");
    // Found by what it WEARS, so the rim leaking onto the wing is caught too.
    const wearers = drawnMeshes(scene).filter(
      (m) => (m.material as PBRMaterial | null)?.albedoTexture?.name === "airliner-spoiler-rim",
    );
    expect(wearers.map((m) => m.name).sort()).toEqual(SPOILERS);
    for (const spoiler of wearers) {
      expect(spoiler.material!.name).toBe("airliner-spoiler");
      expect(layout(spoiler), spoiler.name).toEqual({ uv: true, uv2: false, color: false });
      expect(declaredVaryings(spoiler), spoiler.name).toEqual({ uv2: false, vertexColor: false, albedoUv: 1 });
    }
    // Four meshes, one material: the rim is one image laid on every panel.
    expect(new Set(wearers.map((m) => m.material)).size).toBe(1);
  });

  it("uses the body's normal and metallic-roughness OBJECTS, and leaves the body's albedo on the body", () => {
    const { scene } = build("airliner");
    const spoiler = mesh(scene, SPOILERS[0]!).material as PBRMaterial;
    const body = mesh(scene, "airliner-body-exterior").material as PBRMaterial;
    for (const slot of ["bumpTexture", "metallicTexture"] as const) {
      expect(spoiler[slot], `${slot}: the spoiler has its own wrapper`).toBe(body[slot]);
    }
    expect(body.albedoTexture!.name).toBe("airliner-body-albedo");
    const rim = spoiler.albedoTexture!;
    expect(rim.wrapU).toBe(Texture.CLAMP_ADDRESSMODE);
    expect(rim.wrapV).toBe(Texture.CLAMP_ADDRESSMODE);
  });

  it("gives every spoiler UVs spanning 0..1 in both axes, so each panel shows the whole rim once", () => {
    const { scene } = build("airliner");
    for (const name of SPOILERS) {
      const uvs = data(mesh(scene, name), VertexBuffer.UVKind);
      const u = uvs.filter((_, index) => index % 2 === 0);
      const v = uvs.filter((_, index) => index % 2 === 1);
      expect([Math.min(...u), Math.max(...u), Math.min(...v), Math.max(...v)], name).toEqual([0, 1, 0, 1]);
    }
  });
});
