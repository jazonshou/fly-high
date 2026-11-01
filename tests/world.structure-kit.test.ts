import { describe, expect, it } from "vitest";
import { KitBuilder } from "../src/world/structures/kit/kitBuilder";
import { walledFrame } from "../src/world/structures/kit/kitBody";
import { structureIndoorLight } from "../src/world/structures/kit/kitIndoorLight";
import { StructureMeshBuilder, structurePartTriangles } from "../src/world/structures/kit/kitMesh";
import { drawRoof } from "../src/world/structures/kit/kitRoof";
import { structureLook } from "../src/world/structures/kit/kitStyles";
import { STRUCTURE_KIT, structureDrawn, structureLayout } from "../src/world/structures/kit/structureKit";
import {
  STRUCTURE_DOOR_HEIGHT,
  STRUCTURE_DOOR_WIDTH,
  STRUCTURE_MIN_CEILING,
  STRUCTURE_RAILING_HEIGHT,
  structureEnvelope,
} from "../src/world/structures/structureEnvelope";
import type { StructureDrawnLevel, StructurePart } from "../src/world/structures/structureModel";
import { ENTERABLE_STRUCTURE_ARCHETYPES, type StructureRecord } from "../src/world/structures/structureRecord";
import { ColliderGrid, type V3, colliderBounds, partBounds, partCorners, rayBox } from "./world.structure-kit-geometry";
import { structureKitSample, structureKitSamples } from "./world.structure-kit-samples";

/**
 * The building kit (structures S3): every archetype in every style, built
 * from sample records the way the settlement layout sizes them. What the
 * walker and the renderer were promised (`structures-interiors`): parts in
 * the envelope, triangle budgets, doors, ceilings, railings, glass, rooms
 * under the eave line.
 */

const SAMPLES = structureKitSamples(2);
const LEVELS: readonly StructureDrawnLevel[] = ["closed", "block", "open"];
const WALLED = (r: StructureRecord) => ENTERABLE_STRUCTURE_ARCHETYPES.has(r.archetype)
  && r.archetype !== "watchtower" && r.archetype !== "lookout" && r.archetype !== "lighthouse";
const TRIANGLE_BUDGET: Readonly<Record<StructureDrawnLevel, number>> = { closed: 1_500, block: 60, open: 4_000 };
const label = (r: StructureRecord) => `${r.archetype}/${r.style}#${r.seed}`;

function fresh(record: StructureRecord): StructureRecord {
  return Object.freeze({ ...record });
}

function trianglesOf(record: StructureRecord, level: StructureDrawnLevel): number {
  const d = structureDrawn(record, level);
  return structurePartTriangles(d.parts) + structurePartTriangles(d.glass);
}

describe("building kit: the contract", () => {
  it("is deterministic: a copy of the record builds the same parts and layout", () => {
    for (const record of SAMPLES) {
      for (const level of LEVELS) {
        const a = JSON.stringify(STRUCTURE_KIT.drawn(fresh(record), level));
        const b = JSON.stringify(STRUCTURE_KIT.drawn(fresh(record), level));
        expect(a, `${label(record)} ${level}`).toBe(b);
      }
      expect(JSON.stringify(STRUCTURE_KIT.layout(fresh(record)))).toBe(JSON.stringify(STRUCTURE_KIT.layout(fresh(record))));
    }
  });

  it("keeps every level inside its triangle budget, and the mesh builder agrees with the count", () => {
    const worst: Record<StructureDrawnLevel, number> = { closed: 0, block: 0, open: 0 };
    for (const record of SAMPLES) {
      for (const level of LEVELS) {
        const tris = trianglesOf(record, level);
        worst[level] = Math.max(worst[level], tris);
        expect(tris, `${label(record)} ${level}`).toBeLessThanOrEqual(TRIANGLE_BUDGET[level]);
        expect(tris, `${label(record)} ${level} draws something`).toBeGreaterThan(level === "block" ? 10 : 150);
      }
      const d = structureDrawn(record, "open");
      const mesh = new StructureMeshBuilder();
      mesh.appendLocal(d.parts);
      mesh.appendLocal(d.glass);
      const arrays = mesh.finish();
      expect(arrays.triangles).toBe(structurePartTriangles(d.parts) + structurePartTriangles(d.glass));
      expect(arrays.positions.length).toBe(arrays.vertices * 3);
      expect(arrays.surface.length).toBe(arrays.vertices);
      expect(arrays.colour.length).toBe(arrays.vertices * 3);
      expect(arrays.centre.length).toBe(arrays.vertices * 2);
    }
    expect(worst.closed).toBeGreaterThan(900);
  });

  it("keeps every part and collider inside the envelope", () => {
    for (const record of SAMPLES) {
      const env = structureEnvelope(record);
      const inside = (b: { minX: number; maxX: number; minZ: number; maxZ: number }) =>
        b.minX >= env.minX - 1e-6 && b.maxX <= env.maxX + 1e-6 && b.minZ >= env.minZ - 1e-6 && b.maxZ <= env.maxZ + 1e-6;
      for (const level of LEVELS) {
        const d = structureDrawn(record, level);
        for (const part of [...d.parts, ...d.glass]) {
          expect(inside(partBounds(part)), `${label(record)} ${level} ${part.surface} ${JSON.stringify(partBounds(part))}`).toBe(true);
        }
      }
      for (const c of structureLayout(record).colliders) {
        expect(inside(colliderBounds(c)), `${label(record)} collider ${c.material}`).toBe(true);
      }
    }
  });

  it("gives the closed and block levels no glass, and only the open level a layout", () => {
    for (const record of SAMPLES) {
      expect(structureDrawn(record, "closed").glass).toHaveLength(0);
      expect(structureDrawn(record, "block").glass).toHaveLength(0);
      const layout = structureLayout(record);
      if (ENTERABLE_STRUCTURE_ARCHETYPES.has(record.archetype)) {
        expect(layout.volumes.length, label(record)).toBeGreaterThan(0);
        expect(layout.portals.some((p) => p.outside), label(record)).toBe(true);
      } else {
        expect(layout.volumes, label(record)).toHaveLength(0);
        expect(layout.colliders.length, label(record)).toBeGreaterThan(3);
      }
    }
  });

  it("uses only valid parts: positive extents, orthogonal box axes, unit indoor factors", () => {
    for (const record of SAMPLES) {
      for (const level of LEVELS) {
        const d = structureDrawn(record, level);
        for (const part of [...d.parts, ...d.glass]) {
          expect(part.indoor).toBeGreaterThanOrEqual(0);
          expect(part.indoor).toBeLessThanOrEqual(1);
          if (part.kind === "box") {
            const u = [part.ux, part.uy, part.uz];
            const v = [part.vx, part.vy, part.vz];
            const w = [part.wx, part.wy, part.wz];
            const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
            const len = (a: number[]) => Math.hypot(a[0]!, a[1]!, a[2]!);
            expect(Math.abs(dot(u, v)) / (len(u) * len(v)), `${label(record)} ${part.surface}`).toBeLessThan(1e-6);
            expect(Math.abs(dot(u, w)) / (len(u) * len(w))).toBeLessThan(1e-6);
            expect(Math.abs(dot(v, w)) / (len(v) * len(w))).toBeLessThan(1e-6);
            expect(part.faces).toBeGreaterThan(0);
          } else {
            expect(part.points.length % 3).toBe(0);
            expect(part.points.length).toBeGreaterThanOrEqual(9);
          }
        }
      }
    }
  });
});

describe("building kit: rooms, doors and the eave line", () => {
  const walled = SAMPLES.filter(WALLED);

  it("puts the roof box's underside on the eave line, the drawn roof's lowest point, and every room below it", () => {
    for (const record of walled) {
      const frame = walledFrame(record, structureLook(record));
      // The drawn roof alone: its lowest point is the fascias' foot, the eave line.
      const roof = new KitBuilder("closed");
      drawRoof(roof, frame.roof);
      let lowest = Infinity;
      for (const part of roof.parts) for (const [, y] of partCorners(part)) lowest = Math.min(lowest, y);
      expect(lowest, label(record)).toBeCloseTo(frame.eaveY, 6);
      const layout = structureLayout(record);
      const roofBox = layout.colliders.find((c) => c.kind === "box" && Math.abs(colliderBounds(c).minY - frame.eaveY) < 1e-6
        && colliderBounds(c).maxX >= frame.hw + 0.4 && colliderBounds(c).minX <= -frame.hw - 0.4);
      expect(roofBox, `${label(record)} roof box`).toBeDefined();
      const rb = colliderBounds(roofBox!);
      expect(rb.maxY, label(record)).toBeCloseTo(frame.geometry.topY, 6);
      // Over the eaves and the gables' rake (0.42 m) all round.
      expect(rb.maxZ).toBeGreaterThanOrEqual(frame.hd + 0.4);
      expect(rb.minZ).toBeLessThanOrEqual(-frame.hd - 0.4);
      for (const v of layout.volumes) expect(v.maxY, `${label(record)} ${v.room}`).toBeLessThanOrEqual(frame.eaveY + 1e-9);
    }
  });

  it("gives every room an interior volume, each floor lying under one, with ceilings at least 2.4 m", () => {
    for (const record of SAMPLES.filter((r) => ENTERABLE_STRUCTURE_ARCHETYPES.has(r.archetype))) {
      const layout = structureLayout(record);
      const names = layout.volumes.map((v) => v.room);
      expect(new Set(names).size, `${label(record)} names ${names.join(", ")}`).toBe(names.length);
      for (const v of layout.volumes) {
        expect(v.maxY - v.minY, `${label(record)} ${v.room}`).toBeGreaterThanOrEqual(STRUCTURE_MIN_CEILING - 1e-9);
        expect(v.maxX - v.minX).toBeGreaterThan(0.9);
        expect(v.maxZ - v.minZ).toBeGreaterThan(0.9);
      }
      // Every floor drawn indoors lies under a volume, at that volume's floor.
      for (const part of structureDrawn(record, "open").parts) {
        if (part.kind !== "box" || part.indoor === 0 || part.faces !== 4) continue;
        if (part.surface !== "floor" && part.surface !== "concrete") continue;
        const b = partBounds(part);
        // Thresholds: the floor across a doorway, inside the partition's thickness.
        if (Math.min(b.maxX - b.minX, b.maxZ - b.minZ) < 0.2) continue;
        const cx = (b.minX + b.maxX) / 2;
        const cz = (b.minZ + b.maxZ) / 2;
        const over = layout.volumes.find((v) => cx >= v.minX - 1e-6 && cx <= v.maxX + 1e-6 && cz >= v.minZ - 1e-6 && cz <= v.maxZ + 1e-6
          && Math.abs(v.minY - b.maxY) < 0.06);
        expect(over, `${label(record)} floor at ${cx.toFixed(2)},${b.maxY.toFixed(2)},${cz.toFixed(2)}`).toBeDefined();
      }
      // Nothing solid hangs lower than 2.4 m over a room's floor (beams, slabs, the roof box).
      for (const v of layout.volumes) {
        // Stairwells and the lighthouse's shaft hold their stairs.
        if (v.room.includes("stairwell") || v.room === "shaft") continue;
        for (const c of layout.colliders) {
          const b = colliderBounds(c);
          if (b.maxX < v.minX + 0.4 || b.minX > v.maxX - 0.4 || b.maxZ < v.minZ + 0.4 || b.minZ > v.maxZ - 0.4) continue;
          if (b.minY > v.minY + 2.1 && b.minY < v.minY + STRUCTURE_MIN_CEILING - 1e-6) {
            expect.fail(`${label(record)} ${v.room}: ${c.material} at ${b.minY.toFixed(2)} over a floor at ${v.minY.toFixed(2)}`);
          }
        }
      }
    }
  });

  it("makes every door at least 0.9 x 2.0 m, open, and clear of anything solid", () => {
    for (const record of SAMPLES.filter((r) => ENTERABLE_STRUCTURE_ARCHETYPES.has(r.archetype))) {
      const layout = structureLayout(record);
      const grid = new ColliderGrid(layout.colliders);
      for (const p of layout.portals) {
        const where = `${label(record)} portal at ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`;
        expect(p.width, where).toBeGreaterThanOrEqual(STRUCTURE_DOOR_WIDTH - 1e-9);
        expect(p.height, where).toBeGreaterThanOrEqual(STRUCTURE_DOOR_HEIGHT - 1e-9);
        expect(p.open, where).toBe(true);
        expect(Math.hypot(p.nx, p.nz), where).toBeCloseTo(1, 6);
        // The clear opening: from just above the sill to the head, across the wall's thickness and a step either side.
        const ax = -p.nz;
        const az = p.nx;
        for (let s = -0.5; s <= 0.5; s += 0.25) {
          for (let k = -0.35; k <= 0.35; k += 0.07) {
            const x = p.x + ax * s * (STRUCTURE_DOOR_WIDTH - 0.1) + p.nx * k;
            const z = p.z + az * s * (STRUCTURE_DOOR_WIDTH - 0.1) + p.nz * k;
            const hit = grid.blocked(x, z, p.y + 0.06, p.y + STRUCTURE_DOOR_HEIGHT - 0.06, 0.02);
            expect(hit, `${where}: solid at s=${s.toFixed(2)} k=${k.toFixed(2)}`).toBe(false);
          }
        }
      }
    }
  });

  it("puts glass in every window: a pane covering it, with a glass collider, and a dark window in the closed shell", () => {
    for (const record of SAMPLES.filter((r) => ENTERABLE_STRUCTURE_ARCHETYPES.has(r.archetype))) {
      const layout = structureLayout(record);
      const glass = structureDrawn(record, "open").glass.map(partBounds);
      const glassColliders = layout.colliders.filter((c) => c.material === "glass").map(colliderBounds);
      const closedWindows = structureDrawn(record, "closed").parts.filter((p) => p.surface === "window").map(partBounds);
      if (record.archetype !== "watchtower") expect(layout.windows.length, label(record)).toBeGreaterThan(0);
      for (const w of layout.windows) {
        const where = `${label(record)} window at ${w.x.toFixed(2)},${w.y.toFixed(2)},${w.z.toFixed(2)}`;
        const ax = Math.abs(w.nz);
        const az = Math.abs(w.nx);
        // How much of the window's face a set of boxes covers (sampled on a 5 x 5 grid).
        const covered = (boxes: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }[], depth: number) => {
          let hits = 0;
          for (let i = 0; i < 5; i += 1) {
            for (let j = 0; j < 5; j += 1) {
              const s = ((i + 0.5) / 5 - 0.5) * w.width * 0.9;
              const y = w.y + ((j + 0.5) / 5 - 0.5) * w.height * 0.9;
              const x = w.x + ax * s;
              const z = w.z + az * s;
              const ok = boxes.some((b) => y >= b.minY - 1e-6 && y <= b.maxY + 1e-6
                && x >= b.minX - (az > 0.5 ? depth : 1e-6) && x <= b.maxX + (az > 0.5 ? depth : 1e-6)
                && z >= b.minZ - (ax > 0.5 ? depth : 1e-6) && z <= b.maxZ + (ax > 0.5 ? depth : 1e-6));
              if (ok) hits += 1;
            }
          }
          return hits / 25;
        };
        expect(covered(glass, 0.5), `${where} glass`).toBeGreaterThanOrEqual(0.7);
        expect(covered(glassColliders, 0.5), `${where} glass collider`).toBeGreaterThanOrEqual(0.7);
        expect(covered(closedWindows, 0.5), `${where} closed shell`).toBeGreaterThanOrEqual(0.7);
      }
    }
  });

  it("puts railings at 1.0 m over the floor they guard", () => {
    let checked = 0;
    for (const record of SAMPLES.filter((r) => ENTERABLE_STRUCTURE_ARCHETYPES.has(r.archetype))) {
      const layout = structureLayout(record);
      const solids = new ColliderGrid(layout.colliders.filter((c) => c.kind === "box" && c.material !== "glass"));
      for (const c of layout.colliders) {
        if (c.kind !== "capsule" || c.material !== "fence") continue;
        if (Math.abs(c.ay - c.by) > 0.01) continue;
        const top = Math.max(c.ay, c.by) + c.radius;
        // The floor beside the rail: the highest support a little to either side of its middle.
        const mx = (c.ax + c.bx) / 2;
        const mz = (c.az + c.bz) / 2;
        const len = Math.hypot(c.bx - c.ax, c.bz - c.az);
        const px = -(c.bz - c.az) / len;
        const pz = (c.bx - c.ax) / len;
        let floor = -Infinity;
        for (const s of [-0.2, -0.1, 0.1, 0.2]) floor = Math.max(floor, solids.supportAt(mx + px * s, mz + pz * s, top - 0.3));
        const where = `${label(record)} rail at ${mx.toFixed(2)},${top.toFixed(2)},${mz.toFixed(2)}`;
        expect(Number.isFinite(floor), where).toBe(true);
        expect(top - floor, where).toBeGreaterThanOrEqual(STRUCTURE_RAILING_HEIGHT - 0.05);
        expect(top - floor, where).toBeLessThanOrEqual(STRUCTURE_RAILING_HEIGHT + 0.06);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe("building kit: colliders agree with the drawn open shell", () => {
  const WALL_SURFACES = new Set(["clapboard", "boards", "logs", "render", "stone", "basalt", "metal", "plaster"]);

  function firstHit(o: V3, d: V3, boxes: readonly StructurePart[]): number {
    let best = Infinity;
    for (const p of boxes) if (p.kind === "box") best = Math.min(best, rayBox(o, d, p));
    return best;
  }

  it("is solid wherever a wall is drawn, and draws something wherever it is solid", () => {
    for (const record of SAMPLES.filter(WALLED)) {
      const drawn = structureDrawn(record, "open");
      const layout = structureLayout(record);
      const walls = drawn.parts.filter((p) => p.kind === "box" && WALL_SURFACES.has(p.surface) && Math.min(...[[p.ux, p.uy, p.uz], [p.vx, p.vy, p.vz], [p.wx, p.wy, p.wz]].map((a) => 2 * Math.hypot(a[0]!, a[1]!, a[2]!))) >= 0.1);
      const everything = [...drawn.parts, ...drawn.glass];
      const boxColliders = layout.colliders.filter((c) => c.kind === "box");
      // Furniture: colliders inside one room (checked against their pieces below), not the shell.
      const inRoom = (c: (typeof layout.colliders)[number]) => {
        const b = colliderBounds(c);
        return layout.volumes.some((v) => b.minX >= v.minX - 1e-6 && b.maxX <= v.maxX + 1e-6 && b.minZ >= v.minZ - 1e-6 && b.maxZ <= v.maxZ + 1e-6
          && b.minY >= v.minY - 1e-6 && b.maxY <= v.maxY + 1e-6);
      };
      const shell = boxColliders.filter((c) => !inRoom(c));
      const frame = walledFrame(record, structureLook(record));
      let rays = 0;
      for (let k = 0; k < frame.storeys; k += 1) {
        for (const lift of [0.9, 1.6]) {
          const y = k * 2.88 + lift;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const span = dx !== 0 ? frame.hd : frame.hw;
            for (let s = -span + 0.2; s <= span - 0.2; s += 0.37) {
              // From well outside, towards the middle.
              const far = (dx !== 0 ? frame.hw : frame.hd) + 4;
              const o: V3 = dx !== 0 ? [dx * far, y, s] : [s, y, dz * far];
              const d: V3 = [-dx, 0, -dz];
              const tWall = firstHit(o, d, walls);
              let tCol = Infinity;
              let tShell = Infinity;
              for (const c of boxColliders) tCol = Math.min(tCol, rayBox(o, d, c as never));
              for (const c of shell) tShell = Math.min(tShell, rayBox(o, d, c as never));
              const tDrawn = firstHit(o, d, everything);
              const where = `${label(record)} ray y=${y.toFixed(2)} from ${dx},${dz} at ${s.toFixed(2)}`;
              if (tWall < Infinity) expect(tCol, `${where}: wall drawn at ${tWall.toFixed(2)} but solid only at ${tCol.toFixed(2)}`).toBeLessThanOrEqual(tWall + 0.06);
              if (tShell < Infinity) expect(tDrawn, `${where}: solid at ${tShell.toFixed(2)} but drawn only at ${tDrawn.toFixed(2)}`).toBeLessThanOrEqual(tShell + 0.06);
              rays += 1;
            }
          }
        }
      }
      expect(rays).toBeGreaterThan(40);
      // Each piece of furniture's collider is the box round what is drawn of it.
      const indoorParts = drawn.parts.filter((p) => p.indoor > 0).map(partBounds);
      for (const c of boxColliders.filter(inRoom)) {
        const cb = colliderBounds(c);
        const within = indoorParts.filter((b) => b.minX >= cb.minX - 0.02 && b.maxX <= cb.maxX + 0.02 && b.minY >= cb.minY - 0.02
          && b.maxY <= cb.maxY + 0.02 && b.minZ >= cb.minZ - 0.02 && b.maxZ <= cb.maxZ + 0.02);
        const where = `${label(record)} furniture collider ${JSON.stringify(cb)}`;
        expect(within.length, where).toBeGreaterThan(0);
        const union = within.reduce((u, b) => ({
          minX: Math.min(u.minX, b.minX), maxX: Math.max(u.maxX, b.maxX), minY: Math.min(u.minY, b.minY),
          maxY: Math.max(u.maxY, b.maxY), minZ: Math.min(u.minZ, b.minZ), maxZ: Math.max(u.maxZ, b.maxZ),
        }));
        for (const k of ["minX", "maxX", "minY", "maxY", "minZ", "maxZ"] as const) expect(Math.abs(union[k] - cb[k]), `${where} ${k}`).toBeLessThan(0.05);
      }
    }
  });
});

describe("building kit: timings", () => {
  /** A fixed float kernel: the in-process yardstick the kit's build times are measured against (CI runners differ). */
  function reference(): number {
    const data = new Float64Array(200_000);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      data[i] = Math.sqrt(i + 1) * Math.sin(i * 0.001);
      sum += data[i]!;
    }
    return sum;
  }

  function median(run: () => void, count: number): number {
    const times: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const t0 = performance.now();
      run();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(count / 2)]!;
  }

  it("builds a hamlet's closed shells and one house's interior in a few reference kernels' time", () => {
    const hamlet: StructureRecord[] = [];
    for (let v = 0; v < 4; v += 1) hamlet.push(structureKitSample("house", "temperate", v));
    for (const a of ["cottage", "barn", "shed", "shed", "store", "sauna"] as const) hamlet.push(structureKitSample(a, "temperate", hamlet.length));
    const closedSet = () => {
      const mesh = new StructureMeshBuilder(16_384);
      for (const r of hamlet) mesh.append(fresh(r), STRUCTURE_KIT.drawn(fresh(r), "closed").parts);
      return mesh.finish();
    };
    const interior = () => {
      const r = fresh(hamlet[0]!);
      const drawn = STRUCTURE_KIT.drawn(r, "open");
      const light = structureIndoorLight(STRUCTURE_KIT.layout(r));
      const mesh = new StructureMeshBuilder();
      mesh.appendLocal(drawn.parts, light);
      mesh.appendLocal(drawn.glass);
      return mesh.finish();
    };
    for (let i = 0; i < 5; i += 1) {
      closedSet();
      interior();
      reference();
    }
    const ref = median(reference, 15);
    const closedMs = median(closedSet, 15);
    const interiorMs = median(interior, 15);
    const work = closedSet();
    const inside = interior();
    console.info(`[structure-kit] hamlet of ${hamlet.length} closed: ${closedMs.toFixed(2)} ms (${work.triangles} tris); `
      + `largest interior: ${interiorMs.toFixed(2)} ms (${inside.triangles} tris lit); reference ${ref.toFixed(2)} ms`);
    // Work counts are the budget; the times are checked as ratios to the in-process reference
    // (cloud container, 2026-11-01: closed about 0.5x, interior about 0.7x the reference).
    expect(work.triangles).toBeLessThan(10 * 1_500);
    expect(inside.triangles).toBeLessThan(4_500);
    expect(closedMs / ref).toBeLessThan(2);
    expect(interiorMs / ref).toBeLessThan(2.5);
  });
});
