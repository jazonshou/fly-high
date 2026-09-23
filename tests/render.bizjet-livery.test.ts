import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { PBRMaterialDefines } from "@babylonjs/core/Materials/PBR/pbrBaseMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it } from "vitest";
import { createWebGpuAircraft, type AircraftVisual } from "../src/render/webgpu/aircraft";
import type { LiveryImage, LiveryRgb } from "../src/render/webgpu/aircraft/airlinerLivery";
import {
  GLOBAL_BASE_WHITE,
  GLOBAL_BELLY_GREY,
  GLOBAL_HOUSE_SCHEME,
  GLOBAL_HOUSE_STRIPE_SCALE,
  GLOBAL_LIVERY_HEIGHT,
  GLOBAL_LIVERY_SECTIONS,
  GLOBAL_LIVERY_WIDTH,
  GLOBAL_NAVY_SCHEME,
  buildGlobalLiveryImage,
  globalHouseScheme,
  heightOfPhase,
  stripeCentreAt,
  type GlobalLiveryScheme,
  type GlobalLiveryStripe,
} from "../src/render/webgpu/aircraft/bizjetLivery";
import { phaseOfHeight } from "../src/render/webgpu/aircraft/airlinerLivery";

/**
 * THE GLOBAL'S LIVERY: the image, what wears it, and where its lines land on
 * the lofts the renderer draws.
 *
 * Why it exists: the scheme was vertex colour, which held the body material at
 * 16 of 16 fragment inputs live and 17 in a reflection or fog pass -- a
 * pipeline the device refuses -- and drew at rib resolution. The first block
 * pins the input half of that in Node (a GPU is needed to see a refusal, and
 * Node sees the mesh layout that causes one). The rest pins the picture.
 */

const fixtures: Array<{ engine: NullEngine; scene: Scene; visual?: AircraftVisual }> = [];
afterEach(() => {
  for (const entry of fixtures.splice(0)) {
    entry.visual?.dispose();
    entry.scene.dispose();
    entry.engine.dispose();
  }
});

function buildGlobal(): Scene {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const visual = createWebGpuAircraft(scene, "bizjet");
  fixtures.push({ engine, scene, visual });
  return scene;
}

const drawn = (scene: Scene): Mesh[] =>
  scene.meshes.filter((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);

/**
 * What the PBR material itself declares for a mesh, from Babylon's private
 * `_prepareDefines` (the public route returns false under NullEngine before
 * computing a define). The same probe as `render.airliner-livery-mesh`.
 */
function declaresVertexColour(target: Mesh): boolean {
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
  return (defines as unknown as Record<string, unknown>).VERTEXCOLOR === true;
}

function texel(image: LiveryImage, u: number, v: number): LiveryRgb {
  const column = Math.min(image.width - 1, Math.max(0, Math.floor(u * image.width)));
  const row = ((Math.floor(v * image.height) % image.height) + image.height) % image.height;
  const index = (row * image.width + column) * 4;
  return [image.data[index]!, image.data[index + 1]!, image.data[index + 2]!];
}

const distance = (a: LiveryRgb, b: LiveryRgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const stripe = (name: string): GlobalLiveryStripe => {
  const found = GLOBAL_HOUSE_SCHEME.stripes.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no ${name} stripe`);
  return found;
};

describe("the Global's body fits the fragment stage", () => {
  it("carries no vertex colour on any mesh the body or the skin paints, and the probe sees colour when it is there", () => {
    const scene = buildGlobal();
    const painted = drawn(scene).filter((m) => ["bizjet-body", "bizjet-skin"].includes(m.material?.name ?? ""));
    // The lofts, wing panels, winglets, fin, tailplane, nacelles: everything the
    // old scheme painted, and more.
    expect(painted.length, "the body material wears almost nothing: the filter is wrong").toBeGreaterThan(30);

    // POSITIVE CONTROL, FIRST: a painted mesh given a colour channel must read
    // as colour to both instruments, or a false below means nothing.
    const control = painted.find((m) => m.name === "bizjet-fuselage")!.clone("control");
    control.makeGeometryUnique();
    control.setVerticesData(VertexBuffer.ColorKind, new Array<number>(control.getTotalVertices() * 4).fill(1), false);
    expect(control.isVerticesDataPresent(VertexBuffer.ColorKind)).toBe(true);
    expect(declaresVertexColour(control), "the material probe cannot see vertex colour").toBe(true);
    control.dispose();

    const coloured = painted.filter((m) => m.isVerticesDataPresent(VertexBuffer.ColorKind) || declaresVertexColour(m));
    expect(coloured.map((m) => m.name), "vertex colour is the fragment input the livery image freed").toEqual([]);
  });
});

describe("the skin", () => {
  it("is the fuselage, radome and tailcone, wearing the livery on UV1 with u clamped and v wrapped", () => {
    const scene = buildGlobal();
    const wearers = drawn(scene).filter((m) => m.material?.name === "bizjet-skin").map((m) => m.name).sort();
    expect(wearers).toEqual(["bizjet-fuselage", "bizjet-radome", "bizjet-tailcone"]);
    const skin = scene.getMaterialByName("bizjet-skin") as PBRMaterial;
    const livery = skin.albedoTexture as RawTexture;
    expect(livery).toBeInstanceOf(RawTexture);
    expect(livery.name).toBe("bizjet-livery");
    expect(livery.getSize()).toEqual({ width: GLOBAL_LIVERY_WIDTH, height: GLOBAL_LIVERY_HEIGHT });
    expect(livery.coordinatesIndex).toBe(0);
    expect(livery.wrapU).toBe(Texture.CLAMP_ADDRESSMODE);
    expect(livery.wrapV).toBe(Texture.WRAP_ADDRESSMODE);
    // Its own chain, taken over from Babylon (FI-5).
    const internal = livery.getInternalTexture()!;
    expect([internal.generateMipMaps, internal.useMipMaps]).toEqual([false, true]);
  });

  it("has relief of its own with the stretched panel features off, while the body keeps its own", () => {
    const scene = buildGlobal();
    const skin = scene.getMaterialByName("bizjet-skin") as PBRMaterial;
    const body = scene.getMaterialByName("bizjet-body") as PBRMaterial;
    expect(skin.bumpTexture, "the skin shares the body's normal map: the rings and soot stay").not.toBe(body.bumpTexture);
    expect(skin.metallicTexture).not.toBe(body.metallicTexture);
    expect(skin.bumpTexture!.level).toBe(0.42);
    const meta = (material: PBRMaterial) => material.metadata as {
      aircraftPaintFeatureCoverage: Record<string, number>;
      aircraftPaintRecipe: Record<string, number>;
    };
    // The grid and seam are counted only above half strength, and the body's
    // are at 0.45, so their count reads 0 on BOTH: they are pinned by recipe.
    expect(meta(body).aircraftPaintRecipe.panelStrength).toBe(0.45);
    expect(meta(skin).aircraftPaintRecipe.panelStrength).toBe(0);
    for (const feature of ["rivets", "filler", "exhaust-soot", "leading-edge-wear"]) {
      // CONTROL: the body recipe draws each of these, so a zero on the skin is the switch, not a dead feature.
      expect(meta(body).aircraftPaintFeatureCoverage[feature], `the body has no ${feature}`).toBeGreaterThan(0);
      expect(meta(skin).aircraftPaintFeatureCoverage[feature], `the skin still draws ${feature}`).toBe(0);
    }
    expect(body.albedoTexture!.name).toBe("bizjet-body-albedo");
  });

  it("leaves no texture or material behind across rebuilds", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    fixtures.push({ engine, scene });
    createWebGpuAircraft(scene, "trainer").dispose(); // the scene's shared BRDF texture
    const census = () => ({
      textures: scene.textures.map((t) => t.name).sort(),
      materials: scene.materials.map((m) => m.name).sort(),
    });
    const baseline = census();
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const visual = createWebGpuAircraft(scene, "bizjet");
      expect(scene.textures.some((t) => t.name === "bizjet-livery"), "no livery was built").toBe(true);
      visual.dispose();
      expect(census(), `after Global cycle ${cycle}`).toEqual(baseline);
    }
  });
});

describe("the livery image", () => {
  const image = buildGlobalLiveryImage(GLOBAL_HOUSE_SCHEME);

  it("is 1024 x 256 RGBA, opaque, deterministic and not a uniform sheet", () => {
    expect([image.width, image.height]).toEqual([1024, 256]);
    expect(image.data.length).toBe(1024 * 256 * 4);
    for (let index = 3; index < image.data.length; index += 4) if (image.data[index] !== 255) throw new Error("not opaque");
    expect(Buffer.from(buildGlobalLiveryImage(GLOBAL_HOUSE_SCHEME).data).equals(Buffer.from(image.data))).toBe(true);
    const colours = new Set<number>();
    for (let index = 0; index < image.data.length; index += 4) {
      colours.add((image.data[index]! << 16) | (image.data[index + 1]! << 8) | image.data[index + 2]!);
    }
    expect(colours.size).toBeGreaterThan(8);
  });

  it("solves heights on the section table: phaseOfHeight and heightOfPhase invert each other", () => {
    for (const x of [-17, -13.1, -5, 0, 9, 12.4, 13.6, 14.5]) {
      for (const y of [-0.3, 0, 0.1]) {
        const v = phaseOfHeight(GLOBAL_LIVERY_SECTIONS, x, y);
        if (v === undefined) continue;
        expect(heightOfPhase(GLOBAL_LIVERY_SECTIONS, x, v), `x ${x} y ${y}`).toBeCloseTo(y, 9);
        expect(heightOfPhase(GLOBAL_LIVERY_SECTIONS, x, 1 - v), `port, x ${x} y ${y}`).toBeCloseTo(y, 9);
      }
    }
  });

  it("paints the belly grey under the body and the base white on the flank, clear of the pinstripes", () => {
    const u = (x: number) => (x + 18.5) / 33.5;
    const keel = texel(image, u(0), 0.5);
    const flank = texel(image, u(-6), phaseOfHeight(GLOBAL_LIVERY_SECTIONS, -6, 0.6)!);
    expect(distance(keel, GLOBAL_BELLY_GREY)).toBeLessThan(2);
    expect(distance(flank, GLOBAL_BASE_WHITE)).toBeLessThan(2);
  });

  it("keeps the navy scheme a parameter: the same generator paints the navy band on the window row", () => {
    const navy = buildGlobalLiveryImage(GLOBAL_NAVY_SCHEME);
    const band = GLOBAL_NAVY_SCHEME.stripes[0]!;
    const at = texel(navy, (4 + 18.5) / 33.5, phaseOfHeight(GLOBAL_LIVERY_SECTIONS, 4, 0.38)!);
    expect(distance(at, band.colour)).toBeLessThan(2);
    // And the house scheme has no navy there: the window row is white.
    const house = texel(image, (4 + 18.5) / 33.5, phaseOfHeight(GLOBAL_LIVERY_SECTIONS, 4, 0.38)!);
    expect(distance(house, GLOBAL_BASE_WHITE)).toBeLessThan(2);
  });
});

describe("the stripe scale Jason picks from", () => {
  /** The drawn bands down the starboard flank at one station: [colour name, top y, bottom y] per run of rows. */
  function bands(scheme: GlobalLiveryScheme, x: number) {
    const image = buildGlobalLiveryImage(scheme);
    const column = Math.floor(((x + 18.5) / 33.5) * image.width);
    const gold = scheme.stripes[0]!.colour;
    const grey = scheme.stripes[1]!.colour;
    const runs: { name: string; top: number; bottom: number }[] = [];
    for (let row = 0; row < image.height / 2; row += 1) {
      const index = (row * image.width + column) * 4;
      const at: LiveryRgb = [image.data[index]!, image.data[index + 1]!, image.data[index + 2]!];
      // A texel belongs to a line if it is at least half way from the base to the line's colour.
      const toward = (colour: LiveryRgb) => (GLOBAL_BASE_WHITE[0] - at[0]) / (GLOBAL_BASE_WHITE[0] - colour[0]);
      const name = distance(at, gold) < distance(at, grey) ? (toward(gold) >= 0.5 ? "gold" : "") : (toward(grey) >= 0.5 ? "grey" : "");
      const top = heightOfPhase(GLOBAL_LIVERY_SECTIONS, x, row / image.height);
      const bottom = heightOfPhase(GLOBAL_LIVERY_SECTIONS, x, (row + 1) / image.height);
      // Above the belly only: its grey has the pinstripes' red channel.
      if (bottom < scheme.belly!.topY) break;
      const last = runs[runs.length - 1];
      if (name && last?.name === name && Math.abs(last.bottom - top) < 1e-9) last.bottom = bottom;
      else if (name) runs.push({ name, top, bottom });
    }
    return runs;
  }

  it("draws exactly the shipped 2a image at scale 1", () => {
    // The 2a scheme as it was written, literally: pinstripes 0.165 and 0.32 m under a 0.09 m gold.
    const house = globalHouseScheme(1);
    const gold = house.stripes[0]!;
    const literal: GlobalLiveryScheme = {
      ...house,
      stripes: [gold, ...[-0.165, -0.32].map((dy, index) => ({
        ...house.stripes[1]!, name: `pinstripe-${index + 1}`, halfHeight: 0.015,
        centre: gold.centre.map(([x, y]) => [x, y + dy] as const),
      }))],
    };
    expect(Buffer.from(buildGlobalLiveryImage(house).data).equals(Buffer.from(buildGlobalLiveryImage(literal).data))).toBe(true);
  });

  it("ships Jason's pick, 2x: a 0.18 m gold with 0.06 m pinstripes, the gaps as at 1x", () => {
    expect(GLOBAL_HOUSE_STRIPE_SCALE).toBe(2);
    expect(Buffer.from(buildGlobalLiveryImage(GLOBAL_HOUSE_SCHEME).data)
      .equals(Buffer.from(buildGlobalLiveryImage(globalHouseScheme(2)).data))).toBe(true);
    const [gold, first, second] = bands(GLOBAL_HOUSE_SCHEME, 4) as [ReturnType<typeof bands>[0], ReturnType<typeof bands>[0], ReturnType<typeof bands>[0]];
    expect(Math.abs(gold.top - gold.bottom - 0.18)).toBeLessThan(0.04);
    expect(Math.abs(first.top - first.bottom - 0.06)).toBeLessThan(0.04);
    expect(Math.abs(second.top - second.bottom - 0.06)).toBeLessThan(0.04);
    // CONTROL: the 1x reference draws a gold half as thick, so the check above can tell them apart.
    const [oneGold] = bands(globalHouseScheme(1), 4);
    expect((gold.top - gold.bottom) - (oneGold!.top - oneGold!.bottom)).toBeGreaterThan(0.06);
  });

  it("thickens the gold and the pinstripes together at 2x and 3x, and holds the gaps between them", () => {
    // A row is 3.3 cm round the cabin, so a band's measured edge is within a row. That is too
    // coarse to tell held pinstripes (0.03 m) from scaled ones at 2x (0.06); the 3x case (0.09)
    // is the one that fails if the pinstripes stop scaling.
    const TEXEL = 0.04;
    for (const scale of [1, 2, 3]) {
      const runs = bands(globalHouseScheme(scale), 4);
      expect(runs.map((run) => run.name), `x${scale}: the flank's bands top to bottom`).toEqual(["gold", "grey", "grey"]);
      const [gold, first, second] = runs as [typeof runs[0], typeof runs[0], typeof runs[0]];
      expect(Math.abs(gold.top - gold.bottom - 0.09 * scale), `x${scale} gold`).toBeLessThan(TEXEL);
      expect(Math.abs(first.top - first.bottom - 0.03 * scale), `x${scale} pinstripe`).toBeLessThan(TEXEL);
      expect(Math.abs(gold.bottom - first.top - 0.105), `x${scale} first gap`).toBeLessThan(TEXEL);
      expect(Math.abs(first.bottom - second.top - 0.125), `x${scale} second gap`).toBeLessThan(TEXEL);
    }
  });
});

describe("the house cheatline on the built lofts", () => {
  /**
   * THE INSTRUMENT: a horizontal ray from one flank at (x, y) against the three
   * skin lofts' triangles in WORLD space; the hit nearest the ray's origin is
   * the outer skin a camera sees (the lofts overlap for 0.1-0.2 m at each join).
   * Its UV is interpolated barycentrically, as the rasteriser does, and looked
   * up in the image with the sampler's rules. It reads the MESH and the IMAGE
   * together: the image test above cannot know which surface its table is.
   */
  function outerSkin(scene: Scene, flank: 1 | -1) {
    const triangles: { p: Vector3[]; uv: number[][] }[] = [];
    for (const name of ["bizjet-fuselage", "bizjet-radome", "bizjet-tailcone"]) {
      const mesh = scene.getMeshByName(name) as Mesh;
      mesh.computeWorldMatrix(true);
      const world = mesh.getWorldMatrix();
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const uvs = mesh.getVerticesData(VertexBuffer.UVKind)!;
      const indices = mesh.getIndices()!;
      const point = (i: number) => Vector3.TransformCoordinates(
        new Vector3(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!), world);
      for (let t = 0; t < indices.length; t += 3) {
        const corners = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
        triangles.push({ p: corners.map(point), uv: corners.map((i) => [uvs[i * 2]!, uvs[i * 2 + 1]!]) });
      }
    }
    return (x: number, y: number): { u: number; v: number } | undefined => {
      let best: { z: number; u: number; v: number } | undefined;
      for (const { p, uv } of triangles) {
        const [a, b, c] = p as [Vector3, Vector3, Vector3];
        const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
        if (Math.abs(det) < 1e-12) continue;
        const l1 = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / det;
        const l2 = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        const z = (l1 * a.z + l2 * b.z + l3 * c.z) * flank;
        if (best && z <= best.z) continue;
        best = {
          z,
          u: l1 * uv[0]![0]! + l2 * uv[1]![0]! + l3 * uv[2]![0]!,
          v: l1 * uv[0]![1]! + l2 * uv[1]![1]! + l3 * uv[2]![1]!,
        };
      }
      return best;
    };
  }

  /** The drawn centre of the texels closest to `colour` in a vertical scan of one flank at station x. */
  function drawnCentre(skinAt: ReturnType<typeof outerSkin>, image: LiveryImage, x: number, colour: LiveryRgb) {
    const hits: number[] = [];
    for (let y = 0.6; y >= -1.0; y -= 0.004) {
      const hit = skinAt(x, y);
      if (hit && distance(texel(image, hit.u, hit.v), colour) < 30) hits.push(y);
    }
    return hits.length ? (Math.max(...hits) + Math.min(...hits)) / 2 : undefined;
  }

  const image = buildGlobalLiveryImage(GLOBAL_HOUSE_SCHEME);
  /** A texel is 3.3 cm round the cabin (less round the radome); the scan steps 4 mm. */
  const TOLERANCE_M = 0.04;
  // The row (window 2 .. window 11), forward of it, the radome through the
  // table's inexact span (13.2-14.1), and the gold's full extent aft.
  const STATIONS = [-0.4, 0.52, 2.36, 4.2, 6.04, 7.88, 9, 11, 12.9, 13.4, 13.8, 14.2];

  for (const flank of [1, -1] as const) {
    it(`draws the gold where the scheme puts it on the ${flank > 0 ? "starboard" : "port"} flank, rising along the row`, () => {
      const scene = buildGlobal();
      const skinAt = outerSkin(scene, flank);
      const gold = stripe("gold");
      const measured: Record<number, number> = {};
      for (const x of STATIONS) {
        const centre = drawnCentre(skinAt, image, x, gold.colour);
        expect(centre, `no gold at x ${x}`).toBeDefined();
        expect(Math.abs(centre! - stripeCentreAt(gold, x)), `x ${x}: drawn ${centre!.toFixed(3)}`).toBeLessThan(TOLERANCE_M);
        measured[x] = centre!;
      }
      // REVERSE CONTROL: the line is NOT level. A level line at any one height
      // fails the check above at one end or the other, by this much.
      expect(measured[-0.4]! - measured[7.88]!).toBeGreaterThan(0.4);
    });
  }

  it("draws both grey pinstripes parallel beneath the gold, and nothing aft of the fade", () => {
    const scene = buildGlobal();
    const skinAt = outerSkin(scene, 1);
    const gold = stripe("gold");
    for (const x of [1, 5, 8.5]) {
      const goldCentre = drawnCentre(skinAt, image, x, gold.colour)!;
      // Scan below the gold only: the two pinstripes share a colour. A 3 cm
      // line on 3.3 cm texels is partial coverage, often split over two rows,
      // so a texel counts if it is at least 30 % of the way from the base
      // white to the pinstripe grey (and is not gold).
      const grey = stripe("pinstripe-1").colour;
      // Where the scheme puts them, below the gold's centre (0.225 and 0.41 m at the shipped 2x).
      const below = (name: string) => stripeCentreAt(gold, x) - stripeCentreAt(stripe(name), x);
      const [firstBelow, secondBelow] = [below("pinstripe-1"), below("pinstripe-2")];
      const split = goldCentre - (firstBelow + secondBelow) / 2;
      const greys: number[] = [];
      for (let y = goldCentre - gold.halfHeight - 0.03; y >= goldCentre - secondBelow - 0.1; y -= 0.004) {
        const hit = skinAt(x, y);
        if (!hit) continue;
        const at = texel(image, hit.u, hit.v);
        const toward = (GLOBAL_BASE_WHITE[0] - at[0]) / (GLOBAL_BASE_WHITE[0] - grey[0]);
        if (toward > 0.3 && distance(at, gold.colour) > 40) greys.push(y);
      }
      const upper = greys.filter((y) => y > split);
      const lower = greys.filter((y) => y <= split);
      expect(upper.length && lower.length, `x ${x}: pinstripes not found below the gold`).toBeTruthy();
      const mid = (ys: number[]) => (Math.max(...ys) + Math.min(...ys)) / 2;
      expect(Math.abs(mid(upper) - (goldCentre - firstBelow)), `x ${x}: first pinstripe`).toBeLessThan(TOLERANCE_M);
      expect(Math.abs(mid(lower) - (goldCentre - secondBelow)), `x ${x}: second pinstripe`).toBeLessThan(TOLERANCE_M);
    }
    // Aft of the fade (-1.4) the scheme draws no line until the swoosh (stage 2b).
    for (const x of [-3, -8, -14]) {
      expect(drawnCentre(skinAt, image, x, gold.colour), `gold at x ${x}`).toBeUndefined();
    }
  });
});
