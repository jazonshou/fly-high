/**
 * The walker body's sources: MakeHuman's base mesh, three of its macro
 * targets, its default skeleton and skin weights, and its high-poly eyes.
 *
 * LICENCE. Every asset bundled with MakeHuman (the base mesh and proxies,
 * targets and modifiers, textures, clothes, poses) is released under CC0 1.0
 * Universal (MakeHuman's LICENSE.md, section C, and LICENSE.ASSETS.md); each
 * target file says so in its header too. The bake checks the licence text is
 * still the one it was written against before it uses anything.
 *
 * The files are fetched once from the MakeHuman repository at a fixed commit
 * (`MAKEHUMAN_COMMIT`) and kept under `node_modules/.cache/walker-body/` (or
 * `--sources`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** MakeHuman's master as of 2026-11-02, pinned so a later change upstream cannot change the bake. */
export const MAKEHUMAN_COMMIT = "a8bc2d54ff0ac92e78ff71431b1023eda42bf482";
export const MAKEHUMAN_RAW = `https://raw.githubusercontent.com/makehumancommunity/makehuman/${MAKEHUMAN_COMMIT}`;

export const SOURCE_FILES = [
  "LICENSE.md",
  "makehuman/data/3dobjs/base.obj",
  "makehuman/data/targets/macrodetails/african-male-young.target",
  "makehuman/data/targets/macrodetails/asian-male-young.target",
  "makehuman/data/targets/macrodetails/caucasian-male-young.target",
  "makehuman/data/rigs/default.mhskel",
  "makehuman/data/rigs/default_weights.mhw",
  "makehuman/data/eyes/high-poly/high-poly.obj",
  "makehuman/data/eyes/high-poly/high-poly.mhclo",
] as const;

export async function fetchSources(cacheDir: string): Promise<(path: (typeof SOURCE_FILES)[number]) => string> {
  for (const file of SOURCE_FILES) {
    const local = join(cacheDir, file);
    if (existsSync(local)) continue;
    mkdirSync(dirname(local), { recursive: true });
    const response = await fetch(`${MAKEHUMAN_RAW}/${file}`);
    if (!response.ok) throw new Error(`walker body: ${file}: HTTP ${response.status}`);
    writeFileSync(local, Buffer.from(await response.arrayBuffer()));
  }
  const licence = readFileSync(join(cacheDir, "LICENSE.md"), "utf8");
  if (!/These assets have been released under CC0 1\.0 Universal/.test(licence) || !/\* The base mesh and proxies/.test(licence)) {
    throw new Error("walker body: MakeHuman's LICENSE.md no longer says its bundled assets are CC0; check it before baking");
  }
  return (path) => readFileSync(join(cacheDir, path), "utf8");
}

export interface ObjFace {
  readonly group: string;
  readonly vertices: readonly number[];
  readonly uvs: readonly number[];
}

export interface ObjMesh {
  readonly positions: Float64Array;
  readonly uvs: Float64Array;
  readonly faces: readonly ObjFace[];
}

export function parseObj(text: string): ObjMesh {
  const positions: number[] = [];
  const uvs: number[] = [];
  const faces: ObjFace[] = [];
  let group = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("v ")) {
      const [, x, y, z] = line.split(/\s+/);
      positions.push(Number(x), Number(y), Number(z));
    } else if (line.startsWith("vt ")) {
      const [, u, v] = line.split(/\s+/);
      uvs.push(Number(u), Number(v));
    } else if (line.startsWith("g ")) {
      group = line.slice(2).trim();
    } else if (line.startsWith("f ")) {
      const corners = line.split(/\s+/).slice(1);
      faces.push({
        group,
        vertices: corners.map((c) => Number(c.split("/")[0]) - 1),
        uvs: corners.map((c) => Number(c.split("/")[1] ?? "0") - 1),
      });
    }
  }
  return { positions: Float64Array.from(positions), uvs: Float64Array.from(uvs), faces };
}

/** A target's offsets, added to `positions` times `weight`. */
export function applyTarget(positions: Float64Array, text: string, weight: number): void {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [index, dx, dy, dz] = line.split(/\s+/).map(Number);
    positions[index! * 3]! += dx! * weight;
    positions[index! * 3 + 1]! += dy! * weight;
    positions[index! * 3 + 2]! += dz! * weight;
  }
}

export interface MhSkeleton {
  readonly bones: Readonly<Record<string, { head: string; tail: string; parent: string | null }>>;
  readonly joints: Readonly<Record<string, readonly number[]>>;
}

export function parseSkeleton(text: string): MhSkeleton {
  const json = JSON.parse(text) as MhSkeleton;
  return { bones: json.bones, joints: json.joints };
}

/** Per MakeHuman bone, its vertices and weights. */
export function parseWeights(text: string): Readonly<Record<string, readonly (readonly [number, number])[]>> {
  return (JSON.parse(text) as { weights: Record<string, [number, number][]> }).weights;
}

/** An `.mhclo` fitting: each proxy vertex as three base vertices' weights plus an offset in the base's units. */
export interface MhcloFit {
  readonly refs: readonly (readonly [number, number, number])[];
  readonly weights: readonly (readonly [number, number, number])[];
  readonly offsets: readonly (readonly [number, number, number])[];
  /** The scale references: [vertex a, vertex b, base distance] for x, y and z (the proxy's own axes). */
  readonly scale: readonly (readonly [number, number, number])[];
}

export function parseMhclo(text: string): MhcloFit {
  const refs: [number, number, number][] = [];
  const weights: [number, number, number][] = [];
  const offsets: [number, number, number][] = [];
  const scale: [number, number, number][] = [];
  let inVerts = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === "verts") {
      inVerts = true;
      continue;
    }
    if (["x_scale", "y_scale", "z_scale"].includes(parts[0]!)) {
      scale.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
      continue;
    }
    if (!inVerts) continue;
    if (parts.length === 1) {
      refs.push([Number(parts[0]), Number(parts[0]), Number(parts[0])]);
      weights.push([1, 0, 0]);
      offsets.push([0, 0, 0]);
    } else if (parts.length >= 9) {
      const n = parts.map(Number);
      refs.push([n[0]!, n[1]!, n[2]!]);
      weights.push([n[3]!, n[4]!, n[5]!]);
      offsets.push([n[6]!, n[7]!, n[8]!]);
    } else {
      inVerts = false;
    }
  }
  return { refs, weights, offsets, scale };
}
