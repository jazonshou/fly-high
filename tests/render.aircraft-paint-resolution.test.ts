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
 * against the Global's 30.6. It painted at 256, and now at 512, where an edge
 * drawn a texel wide is half as wide on the skin. The synthesis's noise was
 * indexed in TEXELS, so at 256 it drew a different design: the panel lines'
 * 8-texel jitter blocks stepped the lines sideways every 10 cm (the "totem
 * pole" at the cabin door). The trainer's recipes therefore draw their noise
 * on a 64-cell UV lattice (`noiseLattice`). Its livery band's edge was also
 * soft by design, a 0.21 m ramp, which no texel count sharpens, so it is
 * narrowed to a texel (`liveryEdge`), and its panel lines from 10 cm at half
 * depth to 3 cm, grooves with them (`panelEdge`). Thin, the lines showed the
 * design's +-4 cm warp, so they run straight (`lineWarp: 0`).
 *
 * The other airframes' paint is pinned byte for byte, and so is the trainer's
 * own 64-texel paint with all its dials removed.
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
 * the trainer; the trainer's are its 512-texel paint with the dials.
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
    "trainer-body@512": "b6fda753ebfee515",
    "trainer-cowl@512": "670581f65f2bc1bf",
    "trainer-accent@512": "cca13a712b7f2c6b",
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
  delete legacy.panelEdge;
  delete legacy.lineWarp;
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
// The airliner's RE-PINNED 33.38 -> 33.17 for the nose polish (2026-09-23), its paint byte-identical: this is a median
// over the shell's triangles, and the nose went from 8 rings to 28, so more of them are the nose's, where the skin
// slopes to the axis and u's gradient along the surface has less of its length in x.
const DENSITY: Record<Exclude<AircraftKind, "trainer">, number> = { jet: 5.45, bizjet: 29.72, airliner: 33.17 };

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

/**
 * The livery band's trailing edge per row of the trainer body's albedo, where
 * the texels cross half way (read linearly between them, as the sampler does),
 * less a straight line fitted through them: in texels along the row. A ramp
 * sharper than a texel draws the diagonal as a staircase, each row's edge
 * snapped towards a texel boundary.
 */
function liveryEdgeResiduals(recipe: AircraftPaintRecipe, edge: number): number[] {
  const albedo = synthesizeAircraftSurface(recipe, edge).albedoMips[0]!;
  const greenness = (x: number, y: number) => {
    const out = (y * edge + (((x % edge) + edge) % edge)) * 4;
    return albedo[out + 1]! - albedo[out + 2]!;
  };
  const rows: number[] = [];
  const crossings: number[] = [];
  // The rows `liveryEdgeTexels` reads.
  for (let y = Math.round(edge * 0.28); y <= Math.round(edge * 0.42); y += 1) {
    const edgeU = 0.39 + 0.37 * ((y + 0.5) / edge);
    const inside = greenness(Math.floor((edgeU - 0.035) * edge), y);
    const outside = greenness(Math.floor((edgeU + 0.035) * edge), y);
    const level = (x: number) => (greenness(x, y) - outside) / (inside - outside);
    for (let x = Math.floor((edgeU - 0.03) * edge); x < (edgeU + 0.03) * edge; x += 1) {
      const [l0, l1] = [level(x), level(x + 1)];
      if (l0 >= 0.5 && l1 < 0.5) {
        rows.push(y);
        crossings.push(x + (l0 - 0.5) / (l0 - l1));
        break;
      }
    }
  }
  const meanRow = rows.reduce((sum, y) => sum + y, 0) / rows.length;
  const meanX = crossings.reduce((sum, x) => sum + x, 0) / crossings.length;
  let covariance = 0;
  let variance = 0;
  rows.forEach((y, i) => {
    covariance += (y - meanRow) * (crossings[i]! - meanX);
    variance += (y - meanRow) ** 2;
  });
  const slope = covariance / variance;
  return crossings.map((x, i) => x - (meanX + slope * (rows[i]! - meanRow)));
}

/**
 * The vertical panel line at `u0` on the trainer body's maps, per row clear of
 * the horizontal lines, the livery and the rivets, in texels: its albedo dip's
 * full width at half depth (read linearly between texels), and its groove's in
 * the normal map: from where the normal first leans more than 0.1 along u to
 * where it last does, within 0.02 of the line, read linearly between texels
 * (whole texels would make it depend on where the line falls in its texel).
 */
function panelLineWidths(recipe: AircraftPaintRecipe, edge: number, u0: number): { band: number[]; groove: number[] } {
  const synthesis = synthesizeAircraftSurface(recipe, edge);
  const albedo = synthesis.albedoMips[0]!;
  const normal = synthesis.normalMips[0]!;
  const luminance = (x: number, y: number) => {
    const out = (y * edge + x) * 4;
    return 0.2126 * albedo[out]! + 0.7152 * albedo[out + 1]! + 0.0722 * albedo[out + 2]!;
  };
  const band: number[] = [];
  const groove: number[] = [];
  for (const [from, to] of [[0.03, 0.17], [0.23, 0.46]] as const) {
    for (let y = Math.round(edge * from); y < Math.round(edge * to); y += 1) {
      // A rivet is a dome on the line every 1/30 of v, 0.6/64 of v in half-length.
      const phase = ((y + 0.5) / edge) * 30 % 1;
      if (Math.min(phase, 1 - phase) / 30 < 0.6 / 64) continue;
      const lo = Math.floor((u0 - 0.02) * edge);
      const hi = Math.ceil((u0 + 0.02) * edge);
      const profile: number[] = [];
      for (let x = lo; x <= hi; x += 1) profile.push(luminance(x, y));
      const clear = (profile[0]! + profile[1]! + profile.at(-1)! + profile.at(-2)!) / 4;
      const half = (clear + Math.min(...profile)) / 2;
      let first = Number.NaN;
      let last = Number.NaN;
      for (let i = 0; i < profile.length - 1; i += 1) {
        const [a, b] = [profile[i]!, profile[i + 1]!];
        if (Number.isNaN(first) && a >= half && b < half) first = i + (a - half) / (a - b);
        if (a < half && b >= half) last = i + (half - a) / (b - a);
      }
      band.push(last - first);
      const lean: number[] = [];
      for (let x = lo; x <= hi; x += 1) lean.push(Math.abs(normal[(y * edge + x) * 4]! / 127.5 - 1));
      const firstLeaning = lean.findIndex((l) => l > 0.1);
      const lastLeaning = lean.findLastIndex((l) => l > 0.1);
      if (firstLeaning < 1 || lastLeaning > lean.length - 2) {
        groove.push(Number.NaN);
      } else {
        const [a0, a1] = [lean[firstLeaning - 1]!, lean[firstLeaning]!];
        const [b0, b1] = [lean[lastLeaning]!, lean[lastLeaning + 1]!];
        groove.push((lastLeaning + (b0 - 0.1) / (b0 - b1)) - (firstLeaning - 1 + (0.1 - a0) / (a1 - a0)));
      }
    }
  }
  return { band, groove };
}

/**
 * Where a panel line runs on the trainer body's albedo, in texels: the
 * darkness-weighted centre of the line across it, at every row (a vertical
 * line at `at` of u, over rows in `spans` of v) or column (a horizontal line
 * at `at` of v, over columns in `spans` of u).
 */
function lineCentres(
  recipe: AircraftPaintRecipe,
  edge: number,
  axis: "vertical" | "horizontal",
  at: number,
  spans: readonly (readonly [number, number])[],
): number[] {
  const albedo = synthesizeAircraftSurface(recipe, edge).albedoMips[0]!;
  const luminance = (along: number, across: number) => {
    const [x, y] = axis === "vertical" ? [across, along] : [along, across];
    const out = (y * edge + x) * 4;
    return 0.2126 * albedo[out]! + 0.7152 * albedo[out + 1]! + 0.0722 * albedo[out + 2]!;
  };
  const lo = Math.floor((at - 0.03) * edge);
  const hi = Math.ceil((at + 0.03) * edge);
  const centres: number[] = [];
  for (const [from, to] of spans) {
    for (let along = Math.round(edge * from); along < Math.round(edge * to); along += 1) {
      let brightest = 0;
      for (let across = lo; across <= hi; across += 1) brightest = Math.max(brightest, luminance(along, across));
      let weight = 0;
      let sum = 0;
      for (let across = lo; across <= hi; across += 1) {
        const dark = Math.max(0, brightest - luminance(along, across) - 8);
        weight += dark;
        sum += dark * across;
      }
      centres.push(sum / weight);
    }
  }
  return centres;
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

  it("paints the trainer's fuselage at 70 texels a metre or more along the body", () => {
    const density = texelsPerMetreAlongBody(build("trainer"), FUSELAGE.trainer);
    console.log(`density trainer ${density.toFixed(2)}`);
    // 64 texels over the 6.9 m body was 9.3: a texel a 10 m chase magnified to
    // 6.5 px at 720p. 256 was 37, and an edge still drew a texel wide.
    expect(density).toBeGreaterThanOrEqual(70);
  });

  it("draws the trainer's livery edge within 2.5 cm of the body", () => {
    const scene = build("trainer");
    const material = scene.getMaterialByName("trainer-body")!;
    const metadata = material.metadata as PaintMetadata;
    const density = texelsPerMetreAlongBody(scene, FUSELAGE.trainer);
    const widths = liveryEdgeTexels(metadata.aircraftPaintRecipe!, metadata.aircraftPaintEdge!);
    const metres = widths.map((width) => width / density).sort((a, b) => a - b);
    console.log(`livery edge (m, 10-90 %): median ${metres[metres.length >> 1]!.toFixed(3)} max ${metres.at(-1)!.toFixed(3)}`);
    expect(metres.every(Number.isFinite), "every row found the edge").toBe(true);
    // The default ramp is 0.21 m across the body, 0.13 m between 10 % and 90 %;
    // at 256 with a one-texel ramp it was 4 cm.
    expect(metres.at(-1)!).toBeLessThanOrEqual(0.025);
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

  it("runs the trainer's panel lines straight: the door line wanders 0.5 cm or less", () => {
    const scene = build("trainer");
    const metadata = scene.getMaterialByName("trainer-body")!.metadata as PaintMetadata;
    const [recipe, edge] = [metadata.aircraftPaintRecipe!, metadata.aircraftPaintEdge!];
    const density = texelsPerMetreAlongBody(scene, FUSELAGE.trainer);
    const spread = (centres: number[]) => Math.max(...centres) - Math.min(...centres);
    // The door line, over rows clear of the horizontal lines, the livery and the soot: about 1.2 m round the body,
    // three of the warp's 0.4 m waves.
    const door = spread(lineCentres(recipe, edge, "vertical", 0.63, [[0.03, 0.17], [0.23, 0.46]]));
    // The line round the body at v 0.49, over columns clear of the vertical lines and the livery (u 0.43-0.57 there).
    const round = spread(lineCentres(recipe, edge, "horizontal", 0.49, [[0.2, 0.36], [0.66, 0.82]]));
    console.log(`panel lines, peak to peak: the door line ${(door / density * 100).toFixed(2)} cm (${door.toFixed(2)} texels), the line at v 0.49 ${round.toFixed(2)} texels`);
    // With the design's warp the door line wanders 3.3 cm peak to peak on screen, about its own width.
    expect(door / density).toBeLessThanOrEqual(0.005);
    expect(round).toBeLessThanOrEqual(0.5);
  });

  it("draws the trainer's livery diagonal straight: no row snaps its edge to the texels", () => {
    const scene = build("trainer");
    const metadata = scene.getMaterialByName("trainer-body")!.metadata as PaintMetadata;
    const residuals = liveryEdgeResiduals(metadata.aircraftPaintRecipe!, metadata.aircraftPaintEdge!);
    const worst = Math.max(...residuals.map(Math.abs));
    const rms = Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / residuals.length);
    console.log(`livery edge off a straight line: worst ${worst.toFixed(3)}, rms ${rms.toFixed(3)} texels over ${residuals.length} rows`);
    expect(residuals.length).toBeGreaterThan(60);
    // A ramp of a tenth of a texel snaps each row's edge up to 0.46 texels off the line.
    expect(worst).toBeLessThanOrEqual(0.2);
  });

  it.each([0.39, 0.63])("draws the trainer's panel line at u %s 3 cm wide, its groove with it", (u0) => {
    const scene = build("trainer");
    const metadata = scene.getMaterialByName("trainer-body")!.metadata as PaintMetadata;
    const density = texelsPerMetreAlongBody(scene, FUSELAGE.trainer);
    const { band, groove } = panelLineWidths(metadata.aircraftPaintRecipe!, metadata.aircraftPaintEdge!, u0);
    const metres = (texels: number[]) => texels.map((texels) => texels / density).sort((a, b) => a - b);
    const [bandMetres, grooveMetres] = [metres(band), metres(groove)];
    const median = (sorted: number[]) => sorted[sorted.length >> 1]!;
    console.log(`panel line u ${u0} (m): band median ${median(bandMetres).toFixed(4)} max ${bandMetres.at(-1)!.toFixed(4)}, groove median ${median(grooveMetres).toFixed(4)} max ${grooveMetres.at(-1)!.toFixed(4)} over ${band.length} rows`);
    expect(bandMetres.every(Number.isFinite) && grooveMetres.every(Number.isFinite), "every row found the line").toBe(true);
    // The default line is 10-11 cm at half depth (28 px abeam at 6 m), its
    // groove 16-18 cm. The groove's floor is the band and a texel either side:
    // a central difference leans the texel beyond the slope. A straight line
    // sits at one phase in its texels, here 6.7-7.0 cm; warped, it read 6.3-7.0.
    expect(median(bandMetres)).toBeLessThanOrEqual(0.032);
    expect(bandMetres.at(-1)!).toBeLessThanOrEqual(0.036);
    expect(median(grooveMetres)).toBeLessThanOrEqual(0.075);
    expect(grooveMetres.at(-1)!).toBeLessThanOrEqual(0.08);
  });
});
