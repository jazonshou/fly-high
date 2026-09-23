import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebGpuAircraft, type AircraftVisual } from "../src/render/webgpu/aircraft";
import { SkinCaster } from "../src/render/webgpu/aircraft/airlinerGlazing";
import { AircraftBuildContext } from "../src/render/webgpu/aircraft/builders";
import {
  CABIN_PANE_DEPTH,
  CABIN_PANE_PROUD,
  CABIN_WINDOW_CENTRE_Y,
  CABIN_WINDOW_HEIGHT,
  CABIN_WINDOW_SQUARENESS,
  CABIN_WINDOW_WIDTH,
  cabinPaneGrid,
  cabinWindowArea,
  cabinWindowOffset,
  cabinWindowStations,
} from "../src/render/webgpu/aircraft/bizjetCabinWindows";

/**
 * THE GLOBAL'S CABIN PANES AS BUILT: the row, the outline, and the SEAT --
 * how far the glass stands off the skin, measured by ray over the whole
 * window, not at vertices. The old pane passed a vertex-based seating table
 * ("every vertex within 9 mm") that read a CPU copy the GPU never received;
 * `render.aircraft-vertex-buffer-writes` is what makes a CPU read here the
 * GPU's geometry too.
 */

let engine: NullEngine;
let scene: Scene;
let visual: AircraftVisual;
beforeAll(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  visual = createWebGpuAircraft(scene, "bizjet");
});
afterAll(() => {
  visual.dispose();
  scene.dispose();
  engine.dispose();
});

type Triangle = [number, number, number, number, number, number, number, number, number];
/** World-space triangles of a mesh within an x range. */
function triangles(mesh: AbstractMesh, xMin: number, xMax: number): Triangle[] {
  mesh.computeWorldMatrix(true);
  const m = mesh.getWorldMatrix().m;
  const p = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const idx = mesh.getIndices()!;
  const world = (i: number) => {
    const x = p[i * 3]!, y = p[i * 3 + 1]!, z = p[i * 3 + 2]!;
    return [x * m[0]! + y * m[4]! + z * m[8]! + m[12]!, x * m[1]! + y * m[5]! + z * m[9]! + m[13]!, x * m[2]! + y * m[6]! + z * m[10]! + m[14]!];
  };
  const out: Triangle[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = world(idx[t]!), b = world(idx[t + 1]!), c = world(idx[t + 2]!);
    if (Math.max(a[0]!, b[0]!, c[0]!) < xMin || Math.min(a[0]!, b[0]!, c[0]!) > xMax) continue;
    out.push([...a, ...b, ...c] as Triangle);
  }
  return out;
}
/** The largest side*z at which a ray along -side*z through (x, y) meets the triangles: the outermost surface. */
function outermost(tris: readonly Triangle[], x: number, y: number, side: 1 | -1): number | undefined {
  let best: number | undefined;
  for (const [ax, ay, az, bx, by, bz, cx, cy, cz] of tris) {
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-14) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
    const l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
    const z = side * (l1 * az + l2 * bz + l3 * cz);
    if (best === undefined || z > best) best = z;
  }
  return best;
}
/** Sample points inside a window's outline, inset from its edge so the rim is not what is read. */
function samples(station: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let s = -0.9; s <= 0.9 + 1e-9; s += 0.1) {
    for (let t = -0.9; t <= 0.9 + 1e-9; t += 0.1) {
      const { dx, dy } = cabinWindowOffset(s, t);
      out.push({ x: station + dx, y: CABIN_WINDOW_CENTRE_Y + dy });
    }
  }
  return out;
}
/** The glass's clearance over the skin, along the flank's outward z, at every sample of every window on a side. */
function clearances(glass: AbstractMesh, side: 1 | -1, stations: readonly number[]) {
  const skin = scene.getMeshByName("bizjet-fuselage")!;
  const read: number[] = [];
  for (const station of stations) {
    const glassTris = triangles(glass, station - 0.3, station + 0.3);
    const skinTris = triangles(skin, station - 0.3, station + 0.3);
    for (const { x, y } of samples(station)) {
      const g = outermost(glassTris, x, y, side);
      const k = outermost(skinTris, x, y, side);
      if (g === undefined || k === undefined) throw new Error(`no ${g === undefined ? "glass" : "skin"} at (${x.toFixed(3)}, ${y.toFixed(3)})`);
      read.push(g - k);
    }
  }
  return read;
}

describe("the Global's cabin window row", () => {
  it("is fourteen a side at the measured stations, one mesh, one draw, no thin instances", () => {
    const windows = scene.meshes.filter((mesh) => /cabin-window/.test(mesh.name));
    expect(windows.map((mesh) => mesh.name)).toEqual(["bizjet-cabin-windows"]);
    const [glass] = windows as [AbstractMesh];
    expect((glass as unknown as { thinInstanceCount?: number }).thinInstanceCount ?? 0).toBe(0);
    expect((glass.material as PBRMaterial).name).toBe("bizjet-dark");
    expect((glass.metadata as { mergedFrom?: string[] }).mergedFrom).toHaveLength(28);
    const stations = cabinWindowStations();
    expect(stations).toHaveLength(14);
    expect(stations[0]).toBeCloseTo(8.8, 9);
    expect(stations[13]).toBeCloseTo(8.8 - 13 * 0.92, 9);
  });

  it("is the type's pane: a rounded rectangle 0.37 x 0.56 m, 300 square inches within 1 %", () => {
    expect([CABIN_WINDOW_WIDTH, CABIN_WINDOW_HEIGHT, CABIN_WINDOW_SQUARENESS]).toEqual([0.37, 0.56, 4]);
    expect(cabinWindowArea() / 0.00064516).toBeCloseTo(297.7, 0);
    expect(Math.abs(cabinWindowArea() / 0.00064516 - 300) / 300).toBeLessThan(0.01);
    // The outline's extremes: the square's edge lands on it, the centre on the centre.
    expect(cabinWindowOffset(1, 0)).toEqual({ dx: CABIN_WINDOW_WIDTH / 2, dy: 0 });
    expect(cabinWindowOffset(0, -1)).toEqual({ dx: 0, dy: -CABIN_WINDOW_HEIGHT / 2 });
    expect(cabinWindowOffset(0, 0)).toEqual({ dx: 0, dy: 0 });
    // A corner is rounded: the square's corner maps INSIDE the rectangle's corner.
    const corner = cabinWindowOffset(1, 1);
    expect(corner.dx).toBeLessThan(CABIN_WINDOW_WIDTH / 2);
    expect(corner.dy).toBeLessThan(CABIN_WINDOW_HEIGHT / 2);
  });
});

describe("the seat: glass on the skin, measured over the whole window", () => {
  const glass = () => scene.getMeshByName("bizjet-cabin-windows")!;

  it("CONTROL: the instrument reads the skin against itself as exactly flush", () => {
    const skin = scene.getMeshByName("bizjet-fuselage")!;
    const read = clearances(skin, 1, [cabinWindowStations()[6]!]);
    expect(Math.max(...read.map(Math.abs))).toBe(0);
  });

  it("CONTROL: a pane built SUNK by the same tools reads as sunk", () => {
    // The same caster and the same skinPanel, with the glass 4 mm INSIDE the skin.
    const skin = scene.getMeshByName("bizjet-fuselage")!;
    const caster = new SkinCaster([{
      positions: skin.getVerticesData(VertexBuffer.PositionKind)!,
      indices: skin.getIndices()!,
      normals: skin.getVerticesData(VertexBuffer.NormalKind)!,
    }]);
    const station = cabinWindowStations()[6]!;
    const grid = cabinPaneGrid(caster, station, 1);
    // skinPanel refuses a negative proud, rightly, so the grid itself is moved 4 mm in
    // along its own normals and laid with none.
    const sunkPoints = grid.points.map((row, r) => row.map((point, c) => {
      const n = grid.normals[r]![c]!;
      return { x: point.x - 0.004 * n.x, y: point.y - 0.004 * n.y, z: point.z - 0.004 * n.z };
    }));
    const build = new AircraftBuildContext(scene);
    const material = new PBRMaterial("control-glass", scene);
    const sunk = build.skinPanel("control-sunk-pane", sunkPoints, grid.normals, 0, CABIN_PANE_DEPTH, material, new TransformNode("control-root", scene));
    const read = clearances(sunk, 1, [station]);
    expect(Math.max(...read)).toBeLessThan(0);
    sunk.dispose();
    material.dispose();
  });

  for (const side of [1, -1] as const) {
    it(`every ${side > 0 ? "starboard" : "port"} pane stands proud of the skin everywhere, and never far`, () => {
      const read = clearances(glass(), side, cabinWindowStations());
      expect(read.length).toBe(14 * 19 * 19);
      console.info(`[cabin seat] ${side > 0 ? "starboard" : "port"}: ${read.length} rays, glass `
        + `${(Math.min(...read) * 1000).toFixed(2)}..${(Math.max(...read) * 1000).toFixed(2)} mm proud of the skin`);
      // 6 mm proud along the normal at the grid points, less the chord's sag across a
      // facet crease between them (up to 1.8 mm), and the along-z reading is the
      // along-normal one over the flank's cosine (~1.02 at the row).
      expect(Math.min(...read), "the glass sinks under the skin somewhere").toBeGreaterThan(0.003);
      expect(Math.max(...read), "the glass stands off the skin like a stuck-on plate").toBeLessThan(0.009);
      expect(CABIN_PANE_PROUD).toBe(0.006);
    });
  }
});
