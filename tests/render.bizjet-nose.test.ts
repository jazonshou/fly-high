import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebGpuAircraft, type AircraftVisual } from "../src/render/webgpu/aircraft";
import { SkinCaster, type Point3, type SkinTriangles } from "../src/render/webgpu/aircraft/airlinerGlazing";
import { cabinPaneGrid, cabinWindowStations } from "../src/render/webgpu/aircraft/bizjetCabinWindows";
import { GLOBAL_FUSELAGE_SECTIONS } from "../src/render/webgpu/aircraft/bizjetLivery";
import { AircraftBuildContext, type LoftSection } from "../src/render/webgpu/aircraft/builders";
import { GLOBAL_8000 } from "../src/sim/aircraft";

/**
 * The Global's nose, re-lofted (phase 3c): the type's half-widths from the
 * brochure's top view and the nose one surface with the cabin (part 1), the
 * crown lowered under a brow to a drooped tip (parts 2-4), held against the
 * brochure's port render (p. 29) through its solved camera.
 * docs/findings/GLOBAL_LIVERY.md has the measurements.
 *
 * Every claim is made against the nose as it was, built here from that
 * build's own tables, so a test that passes has read a difference and not an
 * instrument that sees nothing.
 */

/** The fuselage and radome as they were before phase 3c (after 3b's lip fix), literally. */
const FUSELAGE_BEFORE: readonly LoftSection[] = [
  { x: -13.1, yRadius: 1.0, zRadius: 0.96, yOffset: 0.27 },
  { x: -10.5, yRadius: 1.23, zRadius: 1.19, yOffset: 0.12 },
  { x: -8, yRadius: 1.34, zRadius: 1.33, yOffset: 0.03 },
  { x: -2, yRadius: 1.345, zRadius: 1.345 },
  { x: 4.5, yRadius: 1.345, zRadius: 1.345 },
  { x: 9.5, yRadius: 1.335, zRadius: 1.32 },
  { x: 11.6, yRadius: 1.25, zRadius: 1.19, yOffset: 0.06 },
  { x: 13.2, yRadius: 0.9, zRadius: 0.88, yOffset: -0.02 },
];
const RADOME_BEFORE: readonly LoftSection[] = [
  { x: 13.1, yRadius: 0.9, zRadius: 0.88, yOffset: -0.02 },
  { x: 13.2, yRadius: 0.9, zRadius: 0.88, yOffset: -0.02 },
  { x: 14.1, yRadius: 0.62, zRadius: 0.62, yOffset: -0.12 },
  { x: 14.7, yRadius: 0.34, zRadius: 0.34, yOffset: -0.15 },
  { x: 15, yRadius: 0.1, zRadius: 0.1, yOffset: -0.15 },
];

/** The top view's half-widths (m) at metres aft of the tip, probes filtered, cabin normalised to 1.345. */
const TYPE_HALF_WIDTH: readonly (readonly [number, number])[] = [
  [1.3, 0.851], [2.0, 1.1], [2.5, 1.201], [3.0, 1.272], [3.5, 1.322],
];
const TIP_X = 15;
const RING = 48 + 1;
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Part 4's nose, the level roof (crown 0.87 at the post's head), forward of the 9.5 ring, literally:
 * the render bound's control (docs/findings/GLOBAL_LIVERY.md).
 */
const PART_4_NOSE: readonly LoftSection[] = [
  { x: 9.5, yRadius: 1.335, zRadius: 1.32, yOffset: 0 },
  { x: 10.5, yRadius: 1.2691, zRadius: 1.32, yOffset: -0.0078 },
  { x: 11, yRadius: 1.2157, zRadius: 1.32, yOffset: -0.0157 },
  { x: 11.5, yRadius: 1.1533, zRadius: 1.315, yOffset: -0.03 },
  { x: 11.9, yRadius: 1.0929, zRadius: 1.2806, yOffset: -0.0429 },
  { x: 12.2, yRadius: 1.0489, zRadius: 1.2436, yOffset: -0.0414 },
  { x: 12.4, yRadius: 1.017, zRadius: 1.2152, yOffset: -0.038 },
  { x: 12.55, yRadius: 0.9889, zRadius: 1.1909, yOffset: -0.0409 },
  { x: 12.7, yRadius: 0.9534, zRadius: 1.1606, yOffset: -0.0511 },
  { x: 12.78, yRadius: 0.9304, zRadius: 1.1444, yOffset: -0.0604 },
  { x: 12.87, yRadius: 0.856, zRadius: 1.1263, yOffset: -0.1192 },
  { x: 12.95, yRadius: 0.7705, zRadius: 1.1101, yOffset: -0.1905 },
  { x: 13.03, yRadius: 0.7025, zRadius: 1.0906, yOffset: -0.2441 },
  { x: 13.1, yRadius: 0.6571, zRadius: 1.0686, yOffset: -0.2771 },
  { x: 13.2, yRadius: 0.6212, zRadius: 1.0371, yOffset: -0.2961 },
  { x: 13.31, yRadius: 0.5897, zRadius: 1.0026, yOffset: -0.3097 },
  { x: 13.45, yRadius: 0.5476, zRadius: 0.9503, yOffset: -0.3298 },
  { x: 13.6, yRadius: 0.5039, zRadius: 0.8907, yOffset: -0.3503 },
  { x: 13.8, yRadius: 0.4462, zRadius: 0.8062, yOffset: -0.3779 },
  { x: 14.1, yRadius: 0.3595, zRadius: 0.672, yOffset: -0.4207 },
  { x: 14.4, yRadius: 0.2731, zRadius: 0.502, yOffset: -0.4639 },
  { x: 14.7, yRadius: 0.1868, zRadius: 0.34, yOffset: -0.5072 },
  { x: 15, yRadius: 0.1, zRadius: 0.1, yOffset: -0.55 },
];

/** The brochure's port render (p. 29): its solved camera and its upper silhouette, one row per image column. */
const P29 = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/global-p29-silhouette.json"), "utf8")) as {
  camera: { rotationVector: [number, number, number]; centre: [number, number, number]; focalPx: number; principal: [number, number] };
  upper: { columns: [number, number][]; offsetPx: number };
};

let engine: NullEngine;
let scene: Scene;
let visual: AircraftVisual;
let fuselage: Mesh;
let now: SkinCaster;
let before: SkinCaster;
let fuselageBefore: Mesh;
let radomeBefore: Mesh;

const soup = (mesh: Mesh): SkinTriangles => ({
  positions: mesh.getVerticesData(VertexBuffer.PositionKind)!,
  indices: mesh.getIndices()!,
  normals: mesh.getVerticesData(VertexBuffer.NormalKind)!,
});
const DEG = 180 / Math.PI;
const angleBetween = (a: Point3, b: Point3) =>
  Math.acos(Math.min(1, Math.max(-1, (a.x * b.x + a.y * b.y + a.z * b.z) / (Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z))))) * DEG;
const vec = (data: ArrayLike<number>, i: number): Point3 => ({ x: data[i * 3]!, y: data[i * 3 + 1]!, z: data[i * 3 + 2]! });

beforeAll(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  visual = createWebGpuAircraft(scene, "bizjet");
  fuselage = scene.getMeshByName("bizjet-fuselage") as Mesh;
  expect(fuselage.getWorldMatrix().isIdentity(), "the fuselage's vertices are not body metres").toBe(true);
  now = new SkinCaster([soup(fuselage)]);
  const build = new AircraftBuildContext(scene);
  fuselageBefore = build.loft("before-fuselage", FUSELAGE_BEFORE, 48, new StandardMaterial("b", scene), new TransformNode("b", scene));
  radomeBefore = build.loft("before-radome", RADOME_BEFORE, 40, new StandardMaterial("r", scene), new TransformNode("r", scene));
  before = new SkinCaster([soup(fuselageBefore), soup(radomeBefore)]);
});

afterAll(() => {
  visual.dispose();
  scene.dispose();
  engine.dispose();
});

/** The skin's half-width at a station, cast sideways from the axis at the section's widest height. */
function halfWidth(skin: SkinCaster, x: number, height: number): number {
  return skin.exit({ x, y: height, z: 0 }, { x: 0, y: 0, z: 1 })!.point.z;
}
/** The widest height of the loft table at a station: its yOffset, linear between rings. */
function centreAt(sections: readonly LoftSection[], x: number): number {
  for (let i = 1; i < sections.length; i += 1) {
    const a = sections[i - 1]!;
    const b = sections[i]!;
    if (x <= b.x) return (a.yOffset ?? 0) + ((b.yOffset ?? 0) - (a.yOffset ?? 0)) * ((x - a.x) / (b.x - a.x));
  }
  return sections[sections.length - 1]!.yOffset ?? 0;
}

/** A loft table's section at a station, every radius and the offset linear between rings (as the loft is). */
function sectionAt(sections: readonly LoftSection[], x: number): { yRadius: number; zRadius: number; yOffset: number } {
  for (let i = 1; i < sections.length; i += 1) {
    const a = sections[i - 1]!;
    const b = sections[i]!;
    if (x <= b.x) {
      const f = (x - a.x) / (b.x - a.x);
      const at = (p: number, q: number) => p + (q - p) * f;
      return { yRadius: at(a.yRadius, b.yRadius), zRadius: at(a.zRadius, b.zRadius), yOffset: at(a.yOffset ?? 0, b.yOffset ?? 0) };
    }
  }
  const last = sections[sections.length - 1]!;
  return { yRadius: last.yRadius, zRadius: last.zRadius, yOffset: last.yOffset ?? 0 };
}

/** Body metres to the p. 29 render's pixels, through its solved pinhole; `depth` is along the camera's axis. */
function p29Project(p: Point3): { u: number; v: number; depth: number } {
  const [rx, ry, rz] = P29.camera.rotationVector;
  const angle = Math.hypot(rx, ry, rz);
  const k = { x: rx / angle, y: ry / angle, z: rz / angle };
  const d = { x: p.x - P29.camera.centre[0], y: p.y - P29.camera.centre[1], z: p.z - P29.camera.centre[2] };
  // Rodrigues: the rotation vector's rotation applied to d.
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kd = k.x * d.x + k.y * d.y + k.z * d.z;
  const cross = { x: k.y * d.z - k.z * d.y, y: k.z * d.x - k.x * d.z, z: k.x * d.y - k.y * d.x };
  const q = {
    x: d.x * c + cross.x * s + k.x * kd * (1 - c),
    y: d.y * c + cross.y * s + k.y * kd * (1 - c),
    z: d.z * c + cross.z * s + k.z * kd * (1 - c),
  };
  const f = P29.camera.focalPx;
  return { u: P29.camera.principal[0] + (f * q.x) / q.z, v: P29.camera.principal[1] + (f * q.y) / q.z, depth: q.z };
}

/**
 * How far a loft's upper silhouette stands above the render's (its sky edge), column by column: the
 * topmost projected point of the sections in each column against the render's topmost row, in metres
 * at that point's depth (+ = the loft above the render), with the station it comes from (m aft of the tip).
 */
function p29Residuals(sections: readonly LoftSection[], stations: readonly [number, number], step: number, columns: readonly [number, number]) {
  const top = new Map<number, { v: number; x: number; depth: number }>();
  for (let x = stations[0]; x <= stations[1] + 1e-9; x += step) {
    const section = sectionAt(sections, x);
    for (let degrees = 0; degrees < 360; degrees += 2) {
      const angle = degrees / DEG;
      const q = p29Project({ x, y: section.yOffset + section.yRadius * Math.cos(angle), z: section.zRadius * Math.sin(angle) });
      const u = Math.round(q.u);
      if (u < columns[0] || u > columns[1]) continue;
      const was = top.get(u);
      if (!was || q.v < was.v) top.set(u, { v: q.v, x, depth: q.depth });
    }
  }
  const observed = new Map(P29.upper.columns.map(([u, v]) => [u, v + P29.upper.offsetPx]));
  const rows: { aft: number; above: number }[] = [];
  for (const [u, point] of top) {
    const v = observed.get(u);
    if (v !== undefined) rows.push({ aft: TIP_X - point.x, above: ((v - point.v) * point.depth) / P29.camera.focalPx });
  }
  return rows.sort((a, b) => a.aft - b.aft);
}

describe("the Global's nose (phase 3c)", () => {
  it("is one surface with the cabin: no radome mesh, and the fuselage loft runs to the tip", () => {
    expect(scene.getMeshByName("bizjet-radome")).toBeNull();
    const positions = fuselage.getVerticesData(VertexBuffer.PositionKind)!;
    let maxX = -Infinity;
    for (let i = 0; i < positions.length; i += 3) maxX = Math.max(maxX, positions[i]!);
    expect(maxX).toBe(TIP_X);
    expect(GLOBAL_FUSELAGE_SECTIONS[GLOBAL_FUSELAGE_SECTIONS.length - 1]!.x).toBe(TIP_X);
  });

  it("is as wide as the type from 1.3 to 3.5 m aft of the tip, within 3 cm, where it was 0.12-0.23 m narrower", () => {
    for (const [aft, want] of TYPE_HALF_WIDTH) {
      const x = TIP_X - aft;
      const got = halfWidth(now, x, centreAt(GLOBAL_FUSELAGE_SECTIONS, x));
      expect(Math.abs(got - want), `${aft} m aft: built ${got.toFixed(3)} against the type's ${want}`).toBeLessThan(0.03);
      // CONTROL: the nose before, at the same station.
      const was = halfWidth(before, x, x > 13.2 ? centreAt(RADOME_BEFORE, x) : centreAt(FUSELAGE_BEFORE, x));
      expect(want - was, `${aft} m aft: the nose before was ${was.toFixed(3)}`).toBeGreaterThan(0.1);
    }
  });

  it("holds the keel aft of the flight deck, and lowers the crown ahead of it to a drooped tip without a shelf", () => {
    const up = { x: 0, y: 1, z: 0 };
    const down = { x: 0, y: -1, z: 0 };
    const crownAt = (skin: SkinCaster, x: number, from = -0.45) => skin.exit({ x, y: from, z: 0 }, up)!.point.y;
    const keelAt = (skin: SkinCaster, x: number, from = -0.45) => skin.exit({ x, y: from, z: 0 }, down)!.point.y;
    let keel = 0;
    for (let x = 9.55; x <= 13.2 + 1e-9; x += 0.05) keel = Math.max(keel, Math.abs(keelAt(now, x) - keelAt(before, x, -0.1)));
    let rise = 0;
    let last = crownAt(now, 9.5);
    for (let x = 9.55; x <= 14.95 + 1e-9; x += 0.05) {
      const crown = crownAt(now, x);
      // Going forward the crown only ever falls: no shelf for the windshield's foot to cast past.
      // `rise` is the total climb, summed over every 5 cm that climbs at all.
      rise += Math.max(0, crown - last);
      last = crown;
    }
    // Aft of the flight deck (1.8 m aft of the tip and back) the keel runs through part 1's at the
    // table's anchor stations and smoothly between them: 1.8 cm at most from the nose before,
    // measured. Forward of it the keel droops to the tip.
    expect(keel).toBeLessThan(0.02);
    expect(rise).toBeLessThanOrEqual(0.001);
    // The drop, against the nose before, at the stations the table states (m aft of the tip).
    // Measured (part 5): 0.577 / 0.541 / 0.225 / 0.070 / 0.056, the crown then 0.092 / 0.339 / 0.763
    // / 1.133 / 1.256.
    const drops: [number, number][] = [[1.3, 0.577], [1.8, 0.541], [2.2, 0.225], [3.0, 0.07], [3.5, 0.056]];
    for (const [aft, want] of drops) {
      const x = TIP_X - aft;
      const got = crownAt(before, x, -0.1) - crownAt(now, x);
      expect(Math.abs(got - want), `${aft} m aft: the crown came down ${got.toFixed(3)}`).toBeLessThan(0.03);
    }
    // CONTROL: the same table with its 14.1 ring lifted 25 cm, above the 13.8 ring behind it, reads as a rise.
    const bumped = GLOBAL_FUSELAGE_SECTIONS.map((r) => (r.x === 14.1 ? { ...r, yOffset: (r.yOffset ?? 0) + 0.25 } : r));
    const lofts = new AircraftBuildContext(scene);
    const shelf = new SkinCaster([soup(lofts.loft("shelf", bumped, 48, new StandardMaterial("s", scene), new TransformNode("s", scene)))]);
    let shelfRise = 0;
    let previous = crownAt(shelf, 9.5);
    for (let x = 9.55; x <= 14.7 + 1e-9; x += 0.05) {
      const crown = crownAt(shelf, x);
      shelfRise += Math.max(0, crown - previous);
      previous = crown;
    }
    expect(shelfRise).toBeGreaterThan(0.02);
  });

  it("leaves the cabin aft of the widening bit-identical: every vertex to 9.5 m, every normal to 4.5 m", () => {
    const pNow = fuselage.getVerticesData(VertexBuffer.PositionKind)!;
    const pWas = fuselageBefore.getVerticesData(VertexBuffer.PositionKind)!;
    const nNow = fuselage.getVerticesData(VertexBuffer.NormalKind)!;
    const nWas = fuselageBefore.getVerticesData(VertexBuffer.NormalKind)!;
    const ringOf = (x: number) => FUSELAGE_BEFORE.findIndex((section) => section.x === x);
    // Rings are laid down in section order, RING vertices each, the same order in both.
    for (let i = 0; i < (ringOf(9.5) + 1) * RING * 3; i += 1) expect(pNow[i], `position component ${i}`).toBe(pWas[i]);
    for (let i = 0; i < (ringOf(4.5) + 1) * RING * 3; i += 1) expect(nNow[i], `normal component ${i}`).toBe(nWas[i]);
    // The 9.5 ring's own normals average the span forward of it, which is new; how far they moved.
    let worst = 0;
    for (let v = ringOf(9.5) * RING; v < (ringOf(9.5) + 1) * RING; v += 1) worst = Math.max(worst, angleBetween(vec(nNow, v), vec(nWas, v)));
    // Measured 1.77 degrees: the span forward of the ring no longer narrows.
    expect(worst).toBeLessThan(2.5);
    // CONTROL: the ring just forward of it did move.
    expect(pNow[(ringOf(9.5) + 1) * RING * 3]).not.toBe(pWas[(ringOf(9.5) + 1) * RING * 3]);
  });

  it("keeps the cabin-window row where it was: the same cast points, and the glass off them by a fifth of a millimetre", () => {
    let points = 0;
    let normals = 0;
    for (const side of [1, -1] as const) {
      for (const station of cabinWindowStations()) {
        const a = cabinPaneGrid(now, station, side);
        const b = cabinPaneGrid(before, station, side);
        a.points.forEach((row, r) => row.forEach((p, c) => {
          const q = b.points[r]![c]!;
          points = Math.max(points, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z));
          normals = Math.max(normals, angleBetween(a.normals[r]![c]!, b.normals[r]![c]!));
        }));
      }
    }
    // The points are on the unchanged 4.5-9.5 span, exactly. The first windows' normals
    // interpolate the 9.5 ring's, which turned 1.77 degrees (above); the glass stands 6 mm proud
    // along them, so it moves 0.16 mm at worst (a 1.57-degree turn, measured). No loft that
    // widens the nose forward of 9.5 can hold the 9.5 ring's normals: they average the span
    // forward of it, area-weighted.
    const glass = 0.006 * 2 * Math.sin(normals / DEG / 2);
    expect(points).toBe(0);
    expect(glass).toBeLessThan(0.0002);
  });

  it("straddles the BUILT tip with the sim's two radome contact points, 0.15 m above and below it", () => {
    const positions = fuselage.getVerticesData(VertexBuffer.PositionKind)!;
    let top = -Infinity;
    let bottom = Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i] !== TIP_X) continue;
      top = Math.max(top, positions[i + 1]!);
      bottom = Math.min(bottom, positions[i + 1]!);
    }
    // The tip is drooped, its crown at the gold line: its ring spans -0.65..-0.45 (part 3's -0.55..-0.35,
    // -0.25..-0.05 before).
    expect(top).toBeCloseTo(-0.45, 6);
    expect(bottom).toBeCloseTo(-0.65, 6);
    /** Where each contact point at the tip's station stands against the built tip: + above its top, - below its bottom. */
    const margins = (points: readonly { x: number; y: number; z: number }[]) =>
      points.filter((p) => p.x === TIP_X).map((p) => (p.y > top ? p.y - top : p.y < bottom ? p.y - bottom : 0));
    // The sim's own points (`src/sim/aircraft.ts`): exactly 0.15 m above the tip and 0.15 m below it,
    // so a future tip move that forgets them fails here.
    const now = margins(GLOBAL_8000.airframeContactPoints);
    expect(now.length).toBe(2);
    expect(Math.max(...now)).toBeCloseTo(0.15, 6);
    expect(Math.min(...now)).toBeCloseTo(-0.15, 6);
    // CONTROL: part 3's points, (15, -0.2) and (15, -0.7), against this tip: 0.25 m above it and
    // 0.05 below.
    const was = margins([{ x: 15, y: -0.2, z: 0 }, { x: 15, y: -0.7, z: 0 }]);
    expect(Math.max(...was)).toBeCloseTo(0.25, 6);
    expect(Math.min(...was)).toBeCloseTo(-0.05, 6);
  });

  it("crosses the old join at 13.2 with the normals either side within 5 degrees at every azimuth -- where it creased", () => {
    // The shading normal just aft of 13.2 and just forward of it, round the whole section, cast
    // from the axis at the join's centre height: on the nose before, aft is the fuselage's last
    // span and forward is the radome, the same instrument as the 747's join test.
    const across = (skin: SkinCaster) => {
      const found: { azimuth: number; angle: number }[] = [];
      for (let azimuth = 0; azimuth < 360; azimuth += 15) {
        const direction = { x: 0, y: Math.cos(azimuth / DEG), z: Math.sin(azimuth / DEG) };
        const aft = skin.exit({ x: 13.2 - 0.02, y: -0.02, z: 0 }, direction)!;
        const forward = skin.exit({ x: 13.2 + 0.02, y: -0.02, z: 0 }, direction)!;
        found.push({ azimuth, angle: angleBetween(aft.normal, forward.normal) });
      }
      return found;
    };
    const nowAcross = across(now);
    for (const c of nowAcross) expect(c.angle, `azimuth ${c.azimuth}`).toBeLessThanOrEqual(5);
    // CONTROL: the nose before, through the same instrument.
    const beforeAcross = across(before);
    // Measured: 0.65 degrees at worst now; before, 34.0 at worst and over 5 at all 24 azimuths.
    expect(Math.max(...beforeAcross.map((c) => c.angle))).toBeGreaterThan(20);
    expect(beforeAcross.filter((c) => c.angle > 5).length).toBe(24);
  });

  it("shades the nose as one surface: no crease where the radome met the fuselage's capped end", () => {
    const normals = fuselage.getVerticesData(VertexBuffer.NormalKind)!;
    // The flank vertex (a quarter of the way round) of each ring from 9.5 to the tip's last ring:
    // the angle between consecutive rings' normals is the surface turning, nothing else.
    const first = GLOBAL_FUSELAGE_SECTIONS.findIndex((section) => section.x === 9.5);
    let worst = 0;
    for (let ring = first + 1; ring < GLOBAL_FUSELAGE_SECTIONS.length - 1; ring += 1) {
      for (const radial of [0, 12]) {
        worst = Math.max(worst, angleBetween(vec(normals, (ring - 1) * RING + radial), vec(normals, ring * RING + radial)));
      }
    }
    // CONTROL: the nose before. The fuselage's last ring (13.2) against the radome's ring at the
    // same station, crown and flank: the cap's faces tilted the fuselage's forward.
    const fb = fuselageBefore.getVerticesData(VertexBuffer.NormalKind)!;
    const rb = radomeBefore.getVerticesData(VertexBuffer.NormalKind)!;
    const lastRing = (FUSELAGE_BEFORE.length - 1) * RING;
    const radomeRing = RADOME_BEFORE.findIndex((section) => section.x === 13.2) * 41;
    const crease = Math.max(
      angleBetween(vec(fb, lastRing), vec(rb, radomeRing)),
      angleBetween(vec(fb, lastRing + 12), vec(rb, radomeRing + 10)),
    );
    // Measured: the worst step between rings 11.9 degrees, on the crown into 12.78, the post's head,
    // where the brow turns onto the roof; 9.2 into 12.7 and 8.3 into 13.1, at the face's foot. Through
    // the blend to the drooped tip (13.45 .. 14.7) no step is over 5.6 (render.bizjet-seat-view). 34.0
    // across 13.2 before.
    expect(worst).toBeLessThan(13.5);
    expect(crease).toBeGreaterThan(25);
  });

  it("holds the crown to the p. 29 render: -0.12..+0.10 m over 1.5-2.0 m aft, -0.05..+0.10 from 2.0 to 3.5", () => {
    const cabin = GLOBAL_FUSELAGE_SECTIONS.filter((section) => section.x < 9.5);
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    // CONTROL: the instrument reads the render, in metres, with its sign. The constant section (2-17 m aft
    // of the tip), which the camera was solved on, sits on the render's silhouette to a centimetre, and
    // the same section lifted 0.10 m reads 0.10 above it.
    const onConstant = (sections: readonly LoftSection[]) =>
      p29Residuals(sections, [-8, 15], 0.02, [930, 1860]).filter((r) => r.aft >= 10.5).map((r) => r.above);
    const constant = onConstant(GLOBAL_FUSELAGE_SECTIONS);
    const lifted = onConstant(GLOBAL_FUSELAGE_SECTIONS.map((r) => ({ ...r, yOffset: (r.yOffset ?? 0) + 0.1 })));
    expect(constant.length).toBeGreaterThan(300);
    expect(Math.abs(median(constant))).toBeLessThan(0.01);
    // Measured: a median of +0.4 cm, 90% of columns within 1.5 cm (the rest are the render's antennas),
    // and 0.101 lifted.
    expect(Math.abs(median(lifted) - 0.1)).toBeLessThan(0.01);

    /** The lowest and highest residual over the foot (1.5-2.0 m aft) and the face and roof (2.0-3.5). */
    const bands = (sections: readonly LoftSection[]) => {
      const rows = p29Residuals(sections, [9, 15], 0.005, [470, 999]);
      const range = (from: number, to: number) => {
        const r = rows.filter((q) => q.aft >= from && q.aft <= to).map((q) => q.above);
        return { columns: r.length, low: Math.min(...r), high: Math.max(...r) };
      };
      return { foot: range(1.5, 1.9999), face: range(2.0, 3.5) };
    };
    // Measured: -0.114..-0.047 over the foot, where the face stays under the line so the aim point on
    // final stays in the glass; -0.041..+0.079 over the face and roof, the most over at the brow.
    const built = bands(GLOBAL_FUSELAGE_SECTIONS);
    expect(built.foot.columns).toBeGreaterThan(30);
    expect(built.face.columns).toBeGreaterThan(100);
    expect(built.foot.low).toBeGreaterThanOrEqual(-0.12);
    expect(built.foot.high).toBeLessThanOrEqual(0.1);
    expect(built.face.low).toBeGreaterThanOrEqual(-0.05);
    expect(built.face.high).toBeLessThanOrEqual(0.1);
    // CONTROL: part 4's level roof, through the same instrument, is out on both sides: +0.141 at the
    // brow and -0.129 at 3.5 m aft.
    const part4 = bands([...cabin, ...PART_4_NOSE]);
    expect(part4.face.high).toBeGreaterThan(0.1);
    expect(part4.face.low).toBeLessThan(-0.05);
  });
});
