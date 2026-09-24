import { createHash } from "node:crypto";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it } from "vitest";
import {
  AIRCRAFT_PAINT_EDGE,
  synthesizeAircraftSurface,
  type AircraftPaintRecipe,
} from "../src/render/webgpu/aircraft/materialSynthesis";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import type { AircraftKind } from "../src/sim";

/**
 * How many paint texels each airframe puts on its fuselage, and what the paint
 * synthesis draws with them (docs/findings/TRAINER_SKIN_RESOLUTION_2026_09_23.md).
 *
 * The trainer read blurry at a 10 m chase. Its paint had no livery image: one
 * 64-texel map was laid over the whole 6.9 m fuselage, 9.3 texels a metre
 * against the Global's 30.6. It now paints at 256. The synthesis's noise was
 * indexed in TEXELS, so at 256 it drew a different design: the panel lines'
 * 8-texel jitter blocks stepped the lines sideways every 10 cm (the "totem
 * pole" at the cabin door). The trainer's recipes therefore draw their noise
 * on a 64-cell UV lattice (`noiseLattice`). Its livery band's edge was also
 * soft by design, a 0.21 m ramp, which no texel count sharpens, so it is
 * narrowed to 3 cm (`liveryEdge`).
 *
 * The other airframes' paint is pinned byte for byte, and so is the trainer's
 * own 64-texel paint with both dials removed.
 */

const fixtures: { engine: NullEngine; scene: Scene }[] = [];
afterEach(() => {
  for (const { engine, scene } of fixtures.splice(0)) {
    scene.dispose();
    engine.dispose();
  }
});

function build(kind: AircraftKind): Scene {
  const engine = new NullEngine({
    renderWidth: 64,
    renderHeight: 64,
    textureSize: 64,
    deterministicLockstep: false,
    lockstepMaxSteps: 4,
  });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.activeCamera = new UniversalCamera("paint-test-camera", Vector3.Zero(), scene);
  fixtures.push({ engine, scene });
  createWebGpuAircraft(scene, kind);
  return scene;
}

interface PaintMetadata {
  readonly aircraftPaintRecipe?: AircraftPaintRecipe;
  readonly aircraftPaintEdge?: number;
}

function paintHash(recipe: AircraftPaintRecipe, edge: number): string {
  const synthesis = synthesizeAircraftSurface(recipe, edge);
  const hash = createHash("sha256");
  for (const chain of [synthesis.albedoMips, synthesis.normalMips, synthesis.metallicRoughnessMips]) {
    for (const level of chain) hash.update(level);
  }
  return hash.digest("hex").slice(0, 16);
}

/** Every paint material the airframe builds, re-synthesised from its recorded recipe and edge. */
function paintSet(kind: AircraftKind): Record<string, string> {
  const scene = build(kind);
  const out: Record<string, string> = {};
  for (const material of scene.materials) {
    const metadata = material.metadata as PaintMetadata | null;
    if (!(material instanceof PBRMaterial) || !metadata?.aircraftPaintRecipe) continue;
    const edge = metadata.aircraftPaintEdge ?? AIRCRAFT_PAINT_EDGE;
    out[`${material.name}@${edge}`] = paintHash(metadata.aircraftPaintRecipe, edge);
  }
  return out;
}

/**
 * Taken on b4f89bd, before the trainer's dials existed, for every airframe but
 * the trainer; the trainer's are its 256-texel paint with the dials.
 */
const PAINT_SETS: Record<AircraftKind, Record<string, string>> = {
  jet: { "jet-body@64": "012025a1c45afef0", "jet-underside@64": "ec454eb9f37de2f6", "jet-accent@64": "d5c363fbfcba8fec" },
  bizjet: { "bizjet-body@64": "a1e31a5041219fd3", "bizjet-skin@64": "28b3d60347677b8f" },
  airliner: {
    "airliner-body@64": "c485f91c720958b4",
    "airliner-skin@64": "c485f91c720958b4",
    "airliner-spoiler@64": "c485f91c720958b4",
    "airliner-accent@64": "164f1d6ee91b2ab3",
  },
  trainer: {
    "trainer-body@256": "427a4e3a4a4af238",
    "trainer-cowl@256": "d5bd6010227ab8ef",
    "trainer-accent@256": "e266ec5ace4e9d0f",
  },
};

/** The trainer's three recipes at 64 texels, taken on b4f89bd (no dials then). */
const TRAINER_LEGACY_64: Record<string, string> = {
  "trainer-body": "10cdce8f32e34e7f",
  "trainer-cowl": "e26e467a7a50122a",
  "trainer-accent": "24200602e757c663",
};

function withoutDials(recipe: AircraftPaintRecipe): AircraftPaintRecipe {
  const legacy: { -readonly [K in keyof AircraftPaintRecipe]: AircraftPaintRecipe[K] } = { ...recipe };
  delete legacy.noiseLattice;
  delete legacy.liveryEdge;
  return legacy;
}

/**
 * Paint texels per metre along the fuselage: the median over its triangles of
 * |du/dx| (u's gradient in each triangle's plane, x along the body) times the
 * albedo's width and the material's u scale. The 747's fuselage is the merged
 * shell (its fuselage and radome lofts).
 */
function texelsPerMetreAlongBody(scene: Scene, meshName: string): number {
  const mesh = scene.getMeshByName(meshName);
  const material = mesh?.material;
  if (!mesh || !(material instanceof PBRMaterial) || !material.albedoTexture) {
    throw new Error(`${meshName} has no painted PBR material`);
  }
  // The albedo's own width: a repainted livery keeps its paint's recorded
  // edge in its metadata (the 747's skin says 64 over a 2048 image).
  const width = material.albedoTexture.getSize().width;
  const uScale = (material.albedoTexture as { uScale?: number }).uScale ?? 1;
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const uvs = mesh.getVerticesData(VertexBuffer.UVKind)!;
  const indices = mesh.getIndices()!;
  const gradients: number[] = [];
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const [a, b, c] = [indices[triangle]!, indices[triangle + 1]!, indices[triangle + 2]!];
    const p = (i: number) => [positions[3 * i]!, positions[3 * i + 1]!, positions[3 * i + 2]!] as const;
    const [pa, pb, pc] = [p(a), p(b), p(c)];
    const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const du1 = uvs[2 * b]! - uvs[2 * a]!;
    const du2 = uvs[2 * c]! - uvs[2 * a]!;
    // g = s e1 + t e2 with g.e1 = du1 and g.e2 = du2.
    const d11 = e1[0]! * e1[0]! + e1[1]! * e1[1]! + e1[2]! * e1[2]!;
    const d22 = e2[0]! * e2[0]! + e2[1]! * e2[1]! + e2[2]! * e2[2]!;
    const d12 = e1[0]! * e2[0]! + e1[1]! * e2[1]! + e1[2]! * e2[2]!;
    const determinant = d11 * d22 - d12 * d12;
    if (determinant < 1e-12) continue;
    const s1 = (du1 * d22 - du2 * d12) / determinant;
    const t1 = (du2 * d11 - du1 * d12) / determinant;
    gradients.push(Math.abs(s1 * e1[0]! + t1 * e2[0]!));
  }
  gradients.sort((x, y) => x - y);
  return gradients[gradients.length >> 1]! * width * uScale;
}

const FUSELAGE: Record<AircraftKind, string> = {
  trainer: "trainer-fuselage",
  jet: "jet-fuselage",
  bizjet: "bizjet-fuselage",
  airliner: "airliner-fuselage-shell",
};

/**
 * Texels a metre along the body for the airframes this change leaves alone
 * (their builders, meshes and paint are untouched). The trainer's was 9.1 at 64.
 */
const DENSITY: Record<Exclude<AircraftKind, "trainer">, number> = { jet: 5.45, bizjet: 29.72, airliner: 33.38 };

/** 10-90 % widths, in texels, of the livery band's trailing edge along rows of the trainer body's albedo. */
function liveryEdgeTexels(recipe: AircraftPaintRecipe, edge: number): number[] {
  const albedo = synthesizeAircraftSurface(recipe, edge).albedoMips[0]!;
  const greenness = (x: number, y: number) => {
    const out = (y * edge + (((x % edge) + edge) % edge)) * 4;
    return albedo[out + 1]! - albedo[out + 2]!;
  };
  const widths: number[] = [];
  // Rows clear of the horizontal panel lines (v 0.2, 0.49) and the soot (v ~0.69),
  // where the band's trailing edge (decal 0.57: u = 0.39 + 0.37 v) is clear of
  // the vertical lines at u 0.39 and 0.63.
  for (let y = Math.round(edge * 0.28); y <= Math.round(edge * 0.42); y += 1) {
    const v = (y + 0.5) / edge;
    const edgeU = 0.39 + 0.37 * v;
    const at = (u: number) => greenness(Math.floor(u * edge), y);
    const inside = at(edgeU - 0.035);
    const outside = at(edgeU + 0.035);
    const level = (x: number) => (greenness(x, y) - outside) / (inside - outside);
    const cross = (threshold: number) => {
      for (let x = Math.floor((edgeU - 0.03) * edge); x < (edgeU + 0.03) * edge; x += 1) {
        const [l0, l1] = [level(x), level(x + 1)];
        if (l0 >= threshold && l1 < threshold) return x + (l0 - threshold) / (l0 - l1);
      }
      return Number.NaN;
    };
    widths.push(cross(0.1) - cross(0.9));
  }
  return widths;
}

/** Row-to-row moves, in texels, of the vertical panel line at u 0.63 on the trainer body's albedo. */
function panelLineMoves(recipe: AircraftPaintRecipe, edge: number): number[] {
  const albedo = synthesizeAircraftSurface(recipe, edge).albedoMips[0]!;
  const luminance = (x: number, y: number) => {
    const out = (y * edge + x) * 4;
    return 0.2126 * albedo[out]! + 0.7152 * albedo[out + 1]! + 0.0722 * albedo[out + 2]!;
  };
  const centre = (y: number) => {
    let weight = 0;
    let sum = 0;
    const lo = Math.floor(0.6 * edge);
    const hi = Math.ceil(0.66 * edge);
    let brightest = 0;
    for (let x = lo; x <= hi; x += 1) brightest = Math.max(brightest, luminance(x, y));
    for (let x = lo; x <= hi; x += 1) {
      const dark = Math.max(0, brightest - luminance(x, y) - 8);
      weight += dark;
      sum += dark * x;
    }
    return sum / weight;
  };
  const moves: number[] = [];
  // Rows clear of the horizontal lines at v 0.2 and 0.49 and of the livery band.
  for (const [from, to] of [[0.03, 0.17], [0.23, 0.46]] as const) {
    for (let y = Math.round(edge * from); y < Math.round(edge * to); y += 1) {
      moves.push(Math.abs(centre(y + 1) - centre(y)));
    }
  }
  return moves;
}

describe("aircraft paint sets", () => {
  it.each(["jet", "bizjet", "airliner", "trainer"] as const)("the %s's paint is byte-identical to its pin", (kind) => {
    const set = paintSet(kind);
    console.log(kind, JSON.stringify(set));
    expect(set).toEqual(PAINT_SETS[kind]);
  });

  it("draws the trainer's own 64-texel paint as before once its dials are removed", () => {
    const scene = build("trainer");
    const legacy: Record<string, string> = {};
    for (const name of ["trainer-body", "trainer-cowl", "trainer-accent"]) {
      const recipe = (scene.getMaterialByName(name)!.metadata as PaintMetadata).aircraftPaintRecipe!;
      legacy[name] = paintHash(withoutDials(recipe), 64);
    }
    console.log("trainer-legacy-64", JSON.stringify(legacy));
    expect(legacy).toEqual(TRAINER_LEGACY_64);
  });

  it.each(["jet", "bizjet", "airliner"] as const)("the %s keeps its paint density along the body", (kind) => {
    const density = texelsPerMetreAlongBody(build(kind), FUSELAGE[kind]);
    console.log(`density ${kind} ${density.toFixed(2)}`);
    expect(density).toBeCloseTo(DENSITY[kind], 2);
  });

  it("paints the trainer's fuselage at 30 texels a metre or more along the body", () => {
    const density = texelsPerMetreAlongBody(build("trainer"), FUSELAGE.trainer);
    console.log(`density trainer ${density.toFixed(2)}`);
    // 64 texels over the 6.9 m body was 9.3: a texel a 10 m chase magnified to 6.5 px at 720p.
    expect(density).toBeGreaterThanOrEqual(30);
  });

  it("draws the trainer's livery edge within 5 cm of the body", () => {
    const scene = build("trainer");
    const material = scene.getMaterialByName("trainer-body")!;
    const metadata = material.metadata as PaintMetadata;
    const density = texelsPerMetreAlongBody(scene, FUSELAGE.trainer);
    const widths = liveryEdgeTexels(metadata.aircraftPaintRecipe!, metadata.aircraftPaintEdge!);
    const metres = widths.map((width) => width / density).sort((a, b) => a - b);
    console.log(`livery edge (m, 10-90 %): median ${metres[metres.length >> 1]!.toFixed(3)} max ${metres.at(-1)!.toFixed(3)}`);
    expect(metres.every(Number.isFinite), "every row found the edge").toBe(true);
    // The default ramp is 0.21 m across the body, 0.13 m between 10 % and 90 %.
    expect(metres.at(-1)!).toBeLessThanOrEqual(0.05);
  });

  it("keeps the trainer's panel lines continuous: no row steps the line a texel sideways", () => {
    const scene = build("trainer");
    const metadata = scene.getMaterialByName("trainer-body")!.metadata as PaintMetadata;
    const moves = panelLineMoves(metadata.aircraftPaintRecipe!, metadata.aircraftPaintEdge!);
    const worst = Math.max(...moves);
    console.log(`panel line u 0.63: worst row-to-row move ${worst.toFixed(2)} texels over ${moves.length} rows`);
    // Texel-indexed noise jitters the line in 8-texel blocks: at 256 it jumps
    // up to 3 texels (8 cm) every 8 rows, the "totem pole" seam.
    expect(worst).toBeLessThan(0.5);
  });
});
