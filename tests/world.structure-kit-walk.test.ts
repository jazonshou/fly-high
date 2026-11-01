import { describe, expect, it } from "vitest";
import { structureLayout } from "../src/world/structures/kit/structureKit";
import { STRUCTURE_STAIR_RISE, STRUCTURE_STAIR_TREAD, structureEnvelope } from "../src/world/structures/structureEnvelope";
import { ENTERABLE_STRUCTURE_ARCHETYPES, STRUCTURE_STYLES, type StructureRecord } from "../src/world/structures/structureRecord";
import { ColliderGrid } from "./world.structure-kit-geometry";
import { structureKitSample } from "./world.structure-kit-samples";

/**
 * The walker's test (plan: "A Node test walks every room from the front
 * door with the walker's capsule and step height"): from the ground in
 * front of the building, a 0.3 m capsule 1.8 m tall that steps up 0.4 m
 * floods everything it can stand on, through the doors and up the stairs,
 * against the building's colliders alone. Every room must be reached.
 */

const CELL = 0.1;
const RADIUS = 0.3;
const STEP = 0.4;
const HEIGHT = 1.8;
const DROP = 1.2;

interface Walk {
  /** Standing heights reached per cell. */
  readonly reached: Map<number, number[]>;
  readonly nx: number;
  readonly minX: number;
  readonly minZ: number;
}

function walk(record: StructureRecord): Walk {
  const layout = structureLayout(record);
  const grid = new ColliderGrid(layout.colliders);
  const env = structureEnvelope(record);
  const minX = env.minX - 0.6;
  const minZ = env.minZ - 0.6;
  const nx = Math.ceil((env.maxX + 0.6 - minX) / CELL);
  const nz = Math.ceil((env.maxZ + 0.6 - minZ) / CELL);
  const ground = record.entryY - record.floorY;
  const reached = new Map<number, number[]>();
  const blockedMemo = new Map<string, boolean>();
  const centre = (i: number, k: number) => [minX + (i + 0.5) * CELL, minZ + (k + 0.5) * CELL] as const;
  const support = (i: number, k: number, from: number): number => {
    const [x, z] = centre(i, k);
    let s = grid.supportAt(x, z, from + STEP);
    if (ground <= from + STEP && ground > s) s = ground;
    return s;
  };
  const fits = (i: number, k: number, s: number): boolean => {
    const key = `${i},${k},${s.toFixed(3)}`;
    let v = blockedMemo.get(key);
    if (v === undefined) {
      const [x, z] = centre(i, k);
      v = !grid.blocked(x, z, s + STEP + RADIUS, s + HEIGHT - RADIUS, RADIUS);
      blockedMemo.set(key, v);
    }
    return v;
  };
  const queue: [number, number, number][] = [];
  const visit = (i: number, k: number, s: number) => {
    const c = i * nz + k;
    const list = reached.get(c);
    if (list?.some((h) => Math.abs(h - s) < 1e-3)) return;
    if (list) list.push(s);
    else reached.set(c, [s]);
    queue.push([i, k, s]);
  };
  // Start on the ground well in front of the building, on its centre line.
  const startI = Math.floor((0 - minX) / CELL);
  const startK = nz - 2;
  visit(startI, startK, ground);
  while (queue.length) {
    const [i, k, y] = queue.pop()!;
    for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const ni = i + di;
      const nk = k + dk;
      if (ni < 0 || nk < 0 || ni >= nx || nk >= nz) continue;
      const s = support(ni, nk, y);
      if (s < y - DROP) continue;
      if (!fits(ni, nk, s)) continue;
      visit(ni, nk, s);
    }
  }
  return { reached, nx: nz, minX, minZ };
}

const ENTERABLE = [...ENTERABLE_STRUCTURE_ARCHETYPES];

describe("building kit: the walker reaches every room", () => {
  for (const archetype of ENTERABLE) {
    it(`walks into every room of every ${archetype}`, () => {
      for (const [style, variant] of STRUCTURE_STYLES.flatMap((st) => [[st, 0], [st, 1]] as const)) {
        const record = structureKitSample(archetype, style, variant);
        const layout = structureLayout(record);
        const w = walk(record);
        const standing: { x: number; z: number; y: number }[] = [];
        for (const [c, heights] of w.reached) {
          const i = Math.floor(c / w.nx);
          const k = c - i * w.nx;
          for (const y of heights) standing.push({ x: w.minX + (i + 0.5) * CELL, z: w.minZ + (k + 0.5) * CELL, y });
        }
        for (const v of layout.volumes) {
          const inRoom = standing.some((p) => p.x >= v.minX && p.x <= v.maxX && p.z >= v.minZ && p.z <= v.maxZ
            && p.y >= v.minY - 0.05 && p.y <= (v.room.includes("stairwell") || v.room === "shaft" ? v.maxY : v.minY + 0.3));
          expect(inRoom, `${archetype}/${style}/${variant}: the walker never stands in ${v.room}`).toBe(true);
        }
      }
    });
  }

  it("climbs every stair in 0.18 m risers and 0.28 m treads", () => {
    for (const archetype of ENTERABLE) {
      for (const style of STRUCTURE_STYLES) {
        const record = structureKitSample(archetype, style, 0);
        const layout = structureLayout(record);
        const grid = new ColliderGrid(layout.colliders);
        for (const v of layout.volumes.filter((vol) => vol.room.includes("stairwell"))) {
          // Up the stairwell's long axis at its middle: the treads' tops step up evenly.
          const alongZ = v.maxZ - v.minZ > v.maxX - v.minX;
          const mid = alongZ ? (v.minX + v.maxX) / 2 : (v.minZ + v.maxZ) / 2;
          const a0 = alongZ ? v.minZ : v.minX;
          const a1 = alongZ ? v.maxZ : v.maxX;
          const heights: number[] = [];
          for (let a = a0 + 0.01; a < a1; a += 0.02) {
            const [x, z] = alongZ ? [mid, a] : [a, mid];
            heights.push(grid.supportAt(x, z, v.maxY - 2.0));
          }
          const levels: { y: number; run: number }[] = [];
          for (const h of heights) {
            const last = levels[levels.length - 1];
            if (last && Math.abs(last.y - h) < 1e-3) last.run += 0.02;
            else levels.push({ y: h, run: 0.02 });
          }
          const treads = levels.filter((l) => l.y > v.minY + 0.05 && l.y < v.minY + 2.88 - 0.05);
          const where = `${archetype}/${style} ${v.room}`;
          expect(treads.length, where).toBeGreaterThanOrEqual(14);
          for (let n = 1; n < treads.length; n += 1) {
            expect(Math.abs(treads[n]!.y - treads[n - 1]!.y), `${where} riser ${n}`).toBeCloseTo(STRUCTURE_STAIR_RISE, 2);
            if (n < treads.length - 1) expect(treads[n]!.run, `${where} tread ${n}`).toBeCloseTo(STRUCTURE_STAIR_TREAD, 1);
          }
        }
      }
    }
  });
});
