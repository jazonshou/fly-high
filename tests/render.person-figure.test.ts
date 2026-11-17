import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROPORTIONS } from "../src/render/webgpu/person/figureProportions";
import { BIND_POSITIONS, BONE, BONE_COUNT, BONE_NAMES, BONE_PARENTS, SIDES } from "../src/render/webgpu/person/skeleton";
import { buildFigureMipChains, decodeWalkerBody, WALKER_TEXTURE_SIZES, type FigureGeometry } from "../src/render/webgpu/person/walkerBody";
import { PERSON } from "../src/vehicles/person";

/**
 * The walker's figure as baked (`scripts/bake-walker-body.mts`, from
 * MakeHuman's CC0 base mesh): the walking plan's 27 bones, four levels of
 * detail of about 33k, 10k, 3k and 1k triangles, skin weights the GPU can
 * use, faces the renderer draws (the repo's convention, as in
 * render.cockpit-drawn-faces: `cross(p1 - p0, p2 - p0)` points into the
 * solid), and texture maps at every tier's size.
 */

const ASSETS = new URL("../src/render/webgpu/person/assets/", import.meta.url);
const read = (name: string): ArrayBuffer => {
  const bytes = readFileSync(new URL(name, ASSETS));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};
const BUILT = decodeWalkerBody(read("walker-body.bin"));
const LEVELS = [0, 1, 2, 3];

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

/** A JPEG's width and height, from its frame header. */
function jpegSize(bytes: Uint8Array): [number, number] {
  let offset = 2;
  while (offset < bytes.length) {
    const marker = bytes[offset + 1]!;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    // SOF0-SOF15, less DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [(bytes[offset + 7]! << 8) | bytes[offset + 8]!, (bytes[offset + 5]! << 8) | bytes[offset + 6]!];
    }
    offset += 2 + length;
  }
  throw new Error("no frame header");
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
  it("has the figure's four levels of detail", () => {
    expect(BUILT).toHaveLength(4);
  });

  it.each([
    [0, 32_000, 34_500],
    [1, 9_500, 10_000],
    [2, 2_850, 3_000],
    [3, 950, 1_000],
  ])("LOD %i draws %i-%i triangles", (level, low, high) => {
    const triangles = BUILT[level]!.indices.length / 3;
    expect(triangles).toBeGreaterThanOrEqual(low);
    expect(triangles).toBeLessThanOrEqual(high);
  });

  it.each(LEVELS)("LOD %i stands 1.76 m from the ground up, no wider than its hands", (level) => {
    const { min, max } = bounds(BUILT[level]!);
    expect(min[1]!).toBeGreaterThanOrEqual(0);
    expect(min[1]!).toBeLessThan(0.003);
    // The crown under the hair at the stature, the hair a few millimetres over it.
    expect(max[1]!).toBeGreaterThan(PERSON.stature - 0.01);
    expect(max[1]!).toBeLessThan(PERSON.stature + 0.015);
    expect(max[2]! - min[2]!).toBeLessThan(0.7);
    expect(max[2]!).toBeCloseTo(-min[2]!, 2);
    // The boots' toes ahead, the heels behind the feet point.
    expect(max[0]!).toBeGreaterThan(0.2);
    expect(min[0]!).toBeGreaterThan(-0.15);
  });

  it.each([
    [0, 0.99],
    [1, 0.98],
    [2, 0.97],
    [3, 0.9],
  ])("LOD %i has whole faces, at least %f of them wound into the solid", (level, share) => {
    const geometry = BUILT[level]!;
    const p = geometry.positions;
    const n = geometry.normals;
    const indices = geometry.indices;
    const vertices = p.length / 3;
    let inward = 0;
    let broken = 0;
    for (let t = 0; t < indices.length; t += 3) {
      for (let k = 0; k < 3; k += 1) if (indices[t + k]! >= vertices) broken += 1;
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
      // Not degenerate (the eyes' and the boots' finest triangles are a few hundredths of a square millimetre).
      if (!(Math.hypot(fx, fy, fz) / 2 > 1e-9)) broken += 1;
      // Into the solid: against the outward vertex normals. A few at the
      // garments' folded edges, where the normals average round the fold, go the other way.
      const nx = n[a]! + n[b]! + n[c]!;
      const ny = n[a + 1]! + n[b + 1]! + n[c + 1]!;
      const nz = n[a + 2]! + n[b + 2]! + n[c + 2]!;
      if (fx * nx + fy * ny + fz * nz < 0) inward += 1;
    }
    expect(broken).toBe(0);
    expect(inward / (indices.length / 3)).toBeGreaterThanOrEqual(share);
  });

  it.each(LEVELS)("LOD %i skins every vertex to four of the 27 bones, unit normals and atlas UVs", (level) => {
    const geometry = BUILT[level]!;
    const vertices = geometry.positions.length / 3;
    expect(geometry.normals).toHaveLength(vertices * 3);
    expect(geometry.uvs).toHaveLength(vertices * 2);
    expect(geometry.matricesIndices).toHaveLength(vertices * 4);
    expect(geometry.matricesWeights).toHaveLength(vertices * 4);
    // Checked in bulk (an expect per vertex runs past CI's time budget on the finest level).
    const wrong: string[] = [];
    for (let v = 0; v < vertices; v += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        const bone = geometry.matricesIndices[v * 4 + k]!;
        const weight = geometry.matricesWeights[v * 4 + k]!;
        if (!Number.isInteger(bone) || bone < 0 || bone >= BONE_COUNT || weight < 0) wrong.push(`vertex ${v}: bone ${bone} weight ${weight}`);
        sum += weight;
      }
      if (Math.abs(sum - 1) > 1e-5) wrong.push(`vertex ${v}: weights sum to ${sum}`);
      const n = geometry.normals;
      if (Math.abs(Math.hypot(n[v * 3]!, n[v * 3 + 1]!, n[v * 3 + 2]!) - 1) > 1e-5) wrong.push(`vertex ${v}: normal not unit`);
      for (let k = 0; k < 2; k += 1) {
        const uv = geometry.uvs[v * 2 + k]!;
        if (uv < 0 || uv > 1) wrong.push(`vertex ${v}: UV ${uv}`);
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
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

describe("the walker's texture maps", () => {
  it.each(WALKER_TEXTURE_SIZES.flatMap((size) => ["albedo", "normal", "orm"].map((map) => [map, size] as const)))("ships the %s map at %i", (map, size) => {
    expect(jpegSize(new Uint8Array(read(`walker-${map}-${size}.jpg`)))).toEqual([size, size]);
  });

  it("halves the maps with unit normals, and roughens where the normals spread (Toksvig)", () => {
    // 4 x 4: the left half's normals lean +X and -X in alternate columns (fine folds), the right half's flat.
    const size = 4;
    const albedo = new Uint8Array(size * size * 4).fill(255);
    const normal = new Uint8Array(size * size * 4);
    const orm = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y += 1)
      for (let x = 0; x < size; x += 1) {
        const i = (y * size + x) * 4;
        const lean = x < 2 ? (x % 2 === 0 ? 0.6 : -0.6) : 0;
        normal.set([Math.round((lean * 0.5 + 0.5) * 255), 128, Math.round((Math.sqrt(1 - lean * lean) * 0.5 + 0.5) * 255), 255], i);
        orm.set([255, 77, 0, 255], i);
      }
    const chains = buildFigureMipChains({ size, albedo, normal, orm }, 3);
    expect(chains.normal.map((level) => level.length)).toEqual([64, 16, 4]);
    const level1 = chains.normal[1]!;
    for (let i = 0; i < 4; i += 1) {
      const v = [0, 1, 2].map((k) => (level1[i * 4 + k]! / 255) * 2 - 1);
      expect(Math.hypot(v[0]!, v[1]!, v[2]!)).toBeCloseTo(1, 1);
    }
    // Level 1's left texel averaged the folds away and is rougher; the right one keeps the roughness.
    expect(chains.orm[1]![1]!).toBeGreaterThan(77 + 40);
    expect(chains.orm[1]![4 + 1]!).toBe(77);
    // White stays white averaged in linear light.
    expect(chains.albedo[2]![0]!).toBe(255);
  });
});
