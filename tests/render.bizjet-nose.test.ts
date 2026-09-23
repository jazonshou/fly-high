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
 * The Global's nose, re-lofted (phase 3c, part 1): the type's half-widths from
 * the brochure's top view, the crown and keel held, and the nose one surface
 * with the cabin. docs/findings/GLOBAL_LIVERY.md has the measurements.
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

  it("holds the crown and the keel: within 2.5 cm of the nose before at every 5 cm from 9.5 m to the tip ring", () => {
    let crown = 0;
    let keel = 0;
    for (let x = 9.5; x <= 14.7 + 1e-9; x += 0.05) {
      const up = { x: 0, y: 1, z: 0 };
      const down = { x: 0, y: -1, z: 0 };
      const axis = { x, y: -0.1, z: 0 };
      crown = Math.max(crown, Math.abs(now.exit(axis, up)!.point.y - before.exit(axis, up)!.point.y));
      keel = Math.max(keel, Math.abs(now.exit(axis, down)!.point.y - before.exit(axis, down)!.point.y));
    }
    // Measured 2.1 cm on the crown and 0.8 cm on the keel: where the old tables' kinks at 11.6
    // and 13.2 now fall between rings, the chord cuts the corner.
    expect(crown).toBeLessThan(0.025);
    expect(keel).toBeLessThan(0.025);
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

  it("keeps the tip ring and the sim's contact points: the tip is where the radome's was", () => {
    const positions = fuselage.getVerticesData(VertexBuffer.PositionKind)!;
    const tip = GLOBAL_FUSELAGE_SECTIONS[GLOBAL_FUSELAGE_SECTIONS.length - 1]!;
    expect(tip).toEqual(RADOME_BEFORE[RADOME_BEFORE.length - 1]);
    expect(GLOBAL_FUSELAGE_SECTIONS[GLOBAL_FUSELAGE_SECTIONS.length - 2]).toEqual(RADOME_BEFORE[RADOME_BEFORE.length - 2]);
    let ringVertices = 0;
    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i] !== TIP_X) continue;
      ringVertices += 1;
      const dy = (positions[i + 1]! - (tip.yOffset ?? 0)) / tip.yRadius;
      const dz = positions[i + 2]! / tip.zRadius;
      // On the tip's ellipse, or the cap's centre on its axis.
      expect(Math.abs(Math.hypot(dy, dz) - 1) < 1e-6 || Math.hypot(dy, dz) < 1e-9).toBe(true);
    }
    expect(ringVertices).toBe(RING + 1);
    // The sim's contact points are its own (`src/sim/aircraft.ts`) and this change does not touch
    // them: the two at the radome still straddle the tip, 0.25 above and below its axis.
    expect(GLOBAL_8000.airframeContactPoints.slice(0, 2)).toEqual([{ x: 15, y: 0.1, z: 0 }, { x: 15, y: -0.4, z: 0 }]);
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
    // Measured: the worst step between rings 7.2 degrees (at the tip, where the nose turns
    // fastest), and 34.0 across 13.2 before.
    expect(worst).toBeLessThan(8);
    expect(crease).toBeGreaterThan(25);
  });
});
