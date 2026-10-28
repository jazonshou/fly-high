import { describe, expect, it } from "vitest";
import { FIGURE_ATLAS_SIZE, synthesizeFigureAtlas } from "../src/render/webgpu/person/figureAtlas";
import { buildFigureGeometry, FIGURE_LODS, type FigureGeometry } from "../src/render/webgpu/person/figureGeometry";
import { PROPORTIONS } from "../src/render/webgpu/person/figureProportions";
import { BIND_POSITIONS, BONE, BONE_COUNT, BONE_NAMES, BONE_PARENTS, SIDES } from "../src/render/webgpu/person/skeleton";
import { PERSON } from "../src/vehicles/person";

/**
 * The walker's figure as built: the walking plan's 27 bones, three LODs of
 * about 9k, 3k and 0.8k triangles (W2 brief), skin weights the GPU can use,
 * and faces the renderer draws (the repo's convention, as in
 * render.cockpit-drawn-faces: `cross(p1 - p0, p2 - p0)` points into the
 * solid). The body's volume is a 1.76 m adult's, about 0.07 m^3, plus
 * clothes and boots.
 */

const BUILT = FIGURE_LODS.map((lod) => buildFigureGeometry(lod));

function bounds(geometry: FigureGeometry): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const p = geometry.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k]!, p[i + k]!);
      max[k] = Math.max(max[k]!, p[i + k]!);
    }
  }
  return { min, max };
}

describe("the walker's skeleton", () => {
  it("has the walking plan's 27 bones, each after its parent", () => {
    expect(BONE_COUNT).toBe(27);
    expect(BONE_NAMES).toHaveLength(27);
    expect(BONE_PARENTS).toHaveLength(27);
    expect(BONE_PARENTS[BONE.root]).toBe(-1);
    expect(BONE_PARENTS[BONE.pelvis]).toBe(BONE.root);
    for (let bone = 1; bone < BONE_COUNT; bone += 1) {
      expect(BONE_PARENTS[bone]!).toBeGreaterThanOrEqual(0);
      expect(BONE_PARENTS[bone]!).toBeLessThan(bone);
    }
  });

  it("stands its joints at the stature's proportions, the sides mirrored", () => {
    expect(PROPORTIONS.stature).toBe(PERSON.stature);
    const y = (bone: number): number => BIND_POSITIONS[bone * 3 + 1]!;
    const left = SIDES[0]!;
    const right = SIDES[1]!;
    // Hip, knee and ankle heights at Drillis and Contini's 0.530, 0.285 and 0.039 of the stature, within 2 cm.
    expect(Math.abs(y(left.thigh) - 0.53 * PERSON.stature)).toBeLessThan(0.02);
    expect(Math.abs(y(left.shin) - 0.285 * PERSON.stature)).toBeLessThan(0.02);
    expect(Math.abs(y(left.foot) - 0.039 * PERSON.stature)).toBeLessThan(0.02);
    for (const [a, b] of [[left.thigh, right.thigh], [left.upperArm, right.upperArm], [left.hand, right.hand], [left.toe, right.toe]] as const) {
      expect(BIND_POSITIONS[a * 3]!).toBeCloseTo(BIND_POSITIONS[b * 3]!, 9);
      expect(BIND_POSITIONS[a * 3 + 1]!).toBeCloseTo(BIND_POSITIONS[b * 3 + 1]!, 9);
      expect(BIND_POSITIONS[a * 3 + 2]!).toBeCloseTo(-BIND_POSITIONS[b * 3 + 2]!, 9);
    }
  });
});

describe("the walker's figure meshes", () => {
  it.each([
    [0, 8_500, 9_500],
    [1, 2_700, 3_300],
    [2, 700, 900],
  ])("LOD %i draws %i-%i triangles", (level, low, high) => {
    const triangles = BUILT[level]!.indices.length / 3;
    expect(triangles).toBeGreaterThanOrEqual(low);
    expect(triangles).toBeLessThanOrEqual(high);
  });

  it.each([0, 1, 2])("LOD %i stands 1.76 m from the ground up, no wider than its hands", (level) => {
    const { min, max } = bounds(BUILT[level]!);
    expect(min[1]!).toBeGreaterThanOrEqual(0);
    expect(min[1]!).toBeLessThan(0.003);
    expect(max[1]!).toBeGreaterThan(PERSON.stature - 0.005);
    expect(max[1]!).toBeLessThan(PERSON.stature + 0.015);
    expect(max[2]! - min[2]!).toBeLessThan(0.7);
    expect(max[2]!).toBeCloseTo(-min[2]!, 2);
    // The boots' toes ahead, the heels behind the feet point.
    expect(max[0]!).toBeGreaterThan(0.2);
    expect(min[0]!).toBeGreaterThan(-0.15);
  });

  it.each([0, 1, 2])("LOD %i has whole, drawn faces round an adult's volume", (level) => {
    const geometry = BUILT[level]!;
    const p = geometry.positions;
    const n = geometry.normals;
    const indices = geometry.indices;
    const vertices = p.length / 3;
    let volume = 0;
    for (let t = 0; t < indices.length; t += 3) {
      for (let k = 0; k < 3; k += 1) expect(indices[t + k]!).toBeLessThan(vertices);
      const a = indices[t]! * 3;
      const b = indices[t + 1]! * 3;
      const c = indices[t + 2]! * 3;
      const ux = p[b]! - p[a]!;
      const uy = p[b + 1]! - p[a + 1]!;
      const uz = p[b + 2]! - p[a + 2]!;
      const vx = p[c]! - p[a]!;
      const vy = p[c + 1]! - p[a + 1]!;
      const vz = p[c + 2]! - p[a + 2]!;
      const fx = uy * vz - uz * vy;
      const fy = uz * vx - ux * vz;
      const fz = ux * vy - uy * vx;
      // No sliver of a triangle under a few square millimetres.
      expect(Math.hypot(fx, fy, fz) / 2).toBeGreaterThan(5e-6);
      // Into the solid: against the outward vertex normals.
      const nx = n[a]! + n[b]! + n[c]!;
      const ny = n[a + 1]! + n[b + 1]! + n[c + 1]!;
      const nz = n[a + 2]! + n[b + 2]! + n[c + 2]!;
      expect(fx * nx + fy * ny + fz * nz).toBeLessThan(0);
      volume -= (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!)
        - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!)
        + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6;
    }
    expect(volume).toBeGreaterThan(0.05);
    expect(volume).toBeLessThan(0.1);
  });

  it.each([0, 1, 2])("LOD %i skins every vertex to four of the 27 bones, unit normals and atlas UVs", (level) => {
    const geometry = BUILT[level]!;
    const vertices = geometry.positions.length / 3;
    expect(geometry.normals).toHaveLength(vertices * 3);
    expect(geometry.uvs).toHaveLength(vertices * 2);
    expect(geometry.matricesIndices).toHaveLength(vertices * 4);
    expect(geometry.matricesWeights).toHaveLength(vertices * 4);
    for (let v = 0; v < vertices; v += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        const bone = geometry.matricesIndices[v * 4 + k]!;
        const weight = geometry.matricesWeights[v * 4 + k]!;
        expect(Number.isInteger(bone)).toBe(true);
        expect(bone).toBeGreaterThanOrEqual(0);
        expect(bone).toBeLessThan(BONE_COUNT);
        expect(weight).toBeGreaterThanOrEqual(0);
        sum += weight;
      }
      expect(sum).toBeCloseTo(1, 5);
      const n = geometry.normals;
      expect(Math.hypot(n[v * 3]!, n[v * 3 + 1]!, n[v * 3 + 2]!)).toBeCloseTo(1, 5);
      for (let k = 0; k < 2; k += 1) {
        expect(geometry.uvs[v * 2 + k]!).toBeGreaterThanOrEqual(0);
        expect(geometry.uvs[v * 2 + k]!).toBeLessThanOrEqual(1);
      }
    }
  });

  it("weights the feet to the feet and the head to the head", () => {
    const geometry = BUILT[0]!;
    const p = geometry.positions;
    let soles = 0;
    let crowns = 0;
    for (let v = 0; v < p.length / 3; v += 1) {
      let heaviest = 0;
      for (let k = 1; k < 4; k += 1) {
        if (geometry.matricesWeights[v * 4 + k]! > geometry.matricesWeights[v * 4 + heaviest]!) heaviest = k;
      }
      const bone = geometry.matricesIndices[v * 4 + heaviest]!;
      if (p[v * 3 + 1]! < 0.02) {
        soles += 1;
        expect([SIDES[0]!.foot, SIDES[0]!.toe, SIDES[1]!.foot, SIDES[1]!.toe]).toContain(bone);
      }
      if (p[v * 3 + 1]! > 1.7) {
        crowns += 1;
        expect(bone).toBe(BONE.head);
      }
    }
    expect(soles).toBeGreaterThan(20);
    expect(crowns).toBeGreaterThan(20);
  });
});

describe("the walker's clothes atlas", () => {
  it("fills both maps at the atlas's size", () => {
    const atlas = synthesizeFigureAtlas();
    expect(atlas.albedo).toHaveLength(FIGURE_ATLAS_SIZE * FIGURE_ATLAS_SIZE * 4);
    expect(atlas.metallicRoughness).toHaveLength(FIGURE_ATLAS_SIZE * FIGURE_ATLAS_SIZE * 4);
    let opaque = 0;
    for (let i = 3; i < atlas.albedo.length; i += 4) if (atlas.albedo[i] === 255) opaque += 1;
    expect(opaque).toBe(FIGURE_ATLAS_SIZE * FIGURE_ATLAS_SIZE);
  });
});
