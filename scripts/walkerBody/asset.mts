/**
 * The bake's output for the game: the coarser levels of detail, simplified
 * from the full mesh with meshoptimizer (keeping UV seams and the normals'
 * and UVs' continuity), and `walker-body.bin` as
 * `src/render/webgpu/person/walkerBody.ts` reads it.
 */
import { MeshoptSimplifier } from "meshoptimizer";
import { WALKER_BODY_MAGIC, WALKER_BODY_VERSION } from "../../src/render/webgpu/person/walkerBody";
import type { ExportedMesh } from "./parts.mts";

/** Triangle targets for the levels after the full mesh (the renderer's switch distances are in `createFigure.ts`). */
export const LOD_TRIANGLES = Object.freeze([10_000, 3_000, 1_000]);

export interface Lod {
  /** Triangles into the full mesh's vertices, wound as the bake built them (outward, counter-clockwise). */
  readonly indices: Uint32Array;
  /** meshoptimizer's error, relative to the mesh's size. */
  readonly error: number;
}

/** Requires `await MeshoptSimplifier.ready`. */
export function buildLods(mesh: ExportedMesh): Lod[] {
  const count = mesh.positions.length / 3;
  // Normals and UVs as attributes: a collapse that bends either is charged for it.
  const attributes = new Float32Array(count * 5);
  for (let v = 0; v < count; v += 1) {
    attributes.set(mesh.normals.subarray(v * 3, v * 3 + 3), v * 5);
    attributes.set(mesh.uvs.subarray(v * 2, v * 2 + 2), v * 5 + 3);
  }
  const lods: Lod[] = [{ indices: mesh.indices, error: 0 }];
  for (const target of LOD_TRIANGLES) {
    const [indices, error] = MeshoptSimplifier.simplifyWithAttributes(mesh.indices, mesh.positions, 3, attributes, 5, [0.5, 0.5, 0.5, 1, 1], null, target * 3, 0.2);
    lods.push({ indices, error });
  }
  return lods;
}

/** `walker-body.bin`: the shared vertices quantised, each level's triangles turned to the renderer's winding, V down the image. */
export function encodeWalkerBody(mesh: ExportedMesh, lods: readonly Lod[]): Uint8Array {
  const count = mesh.positions.length / 3;
  if (count > 65535) throw new Error(`walker body: ${count} vertices will not index as u16`);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < count; v += 1)
    for (let a = 0; a < 3; a += 1) {
      lo[a] = Math.min(lo[a]!, mesh.positions[v * 3 + a]!);
      hi[a] = Math.max(hi[a]!, mesh.positions[v * 3 + a]!);
    }
  const pad = (bytes: number) => Math.ceil(bytes / 4) * 4;
  const size =
    40 + 4 * lods.length + pad(count * 6) + pad(count * 6) + pad(count * 4) + pad(count * 4) + pad(count * 4) + lods.reduce((sum, lod) => sum + pad(lod.indices.length * 2), 0);
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  view.setUint32(0, WALKER_BODY_MAGIC, true);
  view.setUint32(4, WALKER_BODY_VERSION, true);
  view.setUint32(8, lods.length, true);
  view.setUint32(12, count, true);
  for (let a = 0; a < 3; a += 1) {
    view.setFloat32(16 + a * 4, lo[a]!, true);
    view.setFloat32(28 + a * 4, hi[a]!, true);
  }
  let offset = 40;
  for (const lod of lods) {
    view.setUint32(offset, lod.indices.length, true);
    offset += 4;
  }
  const section = <T extends Uint8Array | Uint16Array | Int16Array>(make: (start: number, length: number) => T, bytes: number, length: number): T => {
    const array = make(offset, length);
    offset += pad(bytes * length);
    return array;
  };
  const positions = section((s, n) => new Uint16Array(buffer, s, n), 2, count * 3);
  const normals = section((s, n) => new Int16Array(buffer, s, n), 2, count * 3);
  const uvs = section((s, n) => new Uint16Array(buffer, s, n), 2, count * 2);
  const bones = section((s, n) => new Uint8Array(buffer, s, n), 1, count * 4);
  const weights = section((s, n) => new Uint8Array(buffer, s, n), 1, count * 4);
  for (let v = 0; v < count; v += 1) {
    for (let a = 0; a < 3; a += 1) {
      positions[v * 3 + a] = Math.round(((mesh.positions[v * 3 + a]! - lo[a]!) / (hi[a]! - lo[a]!)) * 65535);
      normals[v * 3 + a] = Math.round(mesh.normals[v * 3 + a]! * 32767);
    }
    uvs[v * 2] = Math.round(Math.min(1, Math.max(0, mesh.uvs[v * 2]!)) * 65535);
    uvs[v * 2 + 1] = Math.round(Math.min(1, Math.max(0, 1 - mesh.uvs[v * 2 + 1]!)) * 65535);
    // Weights to bytes summing to 255: rounded, the remainder to the heaviest.
    const w = [0, 1, 2, 3].map((k) => mesh.weights[v * 4 + k]!);
    const total = w.reduce((s, x) => s + x, 0) || 1;
    const bytes = w.map((x) => Math.round((x / total) * 255));
    const heaviest = w.indexOf(Math.max(...w));
    bytes[heaviest]! += 255 - bytes.reduce((s, x) => s + x, 0);
    for (let k = 0; k < 4; k += 1) {
      bones[v * 4 + k] = mesh.bones[v * 4 + k]!;
      weights[v * 4 + k] = bytes[k]!;
    }
  }
  for (const lod of lods) {
    const indices = section((s, n) => new Uint16Array(buffer, s, n), 2, lod.indices.length);
    for (let t = 0; t < lod.indices.length; t += 3) {
      // The renderer's winding: cross(p1 - p0, p2 - p0) into the solid.
      indices[t] = lod.indices[t]!;
      indices[t + 1] = lod.indices[t + 2]!;
      indices[t + 2] = lod.indices[t + 1]!;
    }
  }
  if (offset !== size) throw new Error(`walker body: wrote ${offset} of ${size} bytes`);
  return new Uint8Array(buffer);
}
