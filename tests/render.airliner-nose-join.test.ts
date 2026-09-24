import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWebGpuAircraft, type AircraftVisual } from "../src/render/webgpu/aircraft";
import { SkinCaster, type SkinTriangles } from "../src/render/webgpu/aircraft/airlinerGlazing";
import { NOSE_SECTIONS } from "../src/render/webgpu/aircraft/airlinerVisual";
import { AircraftBuildContext, type LoftSection } from "../src/render/webgpu/aircraft/builders";

/**
 * The 747's fuselage/radome join, as BUILT: one crossing, at a shallow angle
 * all the way round, instead of the slanted loop of creases the two lofts
 * used to meet on. `FUSELAGE_SECTIONS` in airlinerVisual.ts has the design.
 *
 * The two lofts are captured as `loft` returns them, before the merge folds
 * them into `airliner-fuselage-shell`. The OLD join is rebuilt here from its
 * section tables as a fixture: the control the angle test must fail on, and
 * the reference for what was not allowed to move.
 */

const OLD_FUSELAGE: LoftSection[] = [
  { x: -26, yRadius: 3.08, zRadius: 3.08, yOffset: 0.16 },
  { x: -20, yRadius: 3.25, zRadius: 3.25 },
  { x: -6, yRadius: 3.25, zRadius: 3.25 },
  { x: 0, yRadius: 3.265, zRadius: 3.25, yOffset: 0.015, crownZRadius: 3.23 },
  { x: 5, yRadius: 3.35, zRadius: 3.25, yOffset: 0.1, crownZRadius: 3.14 },
  { x: 9, yRadius: 3.525, zRadius: 3.25, yOffset: 0.275, crownZRadius: 2.94 },
  { x: 13, yRadius: 3.685, zRadius: 3.25, yOffset: 0.435, crownZRadius: 2.76 },
  { x: 17, yRadius: 3.785, zRadius: 3.25, yOffset: 0.535, crownZRadius: 2.65 },
  { x: 21, yRadius: 3.82, zRadius: 3.25, yOffset: 0.57, crownZRadius: 2.61 },
  { x: 26, yRadius: 3.825, zRadius: 3.25, yOffset: 0.575, crownZRadius: 2.6 },
  { x: 28, yRadius: 3.575, zRadius: 3, yOffset: 0.675, crownZRadius: 2.45 },
  { x: 29.6, yRadius: 3.15, zRadius: 2.6, yOffset: 0.65, crownZRadius: 2.2 },
  { x: 30.6, yRadius: 2.55, zRadius: 2.05, yOffset: 0.6, crownZRadius: 1.8 },
];
const OLD_NOSE: LoftSection[] = [
  { x: 25.5, yRadius: 3, zRadius: 3, yOffset: -0.02 },
  { x: 28, yRadius: 3.1, zRadius: 2.92, yOffset: 0.05 },
  { x: 29.2, yRadius: 3.28, zRadius: 2.7, yOffset: 0.42 },
  { x: 30.4, yRadius: 3.05, zRadius: 2.28, yOffset: 0.5 },
  { x: 31.4, yRadius: 2.835, zRadius: 1.82, yOffset: 0.545 },
  { x: 32.4, yRadius: 2, zRadius: 1.36, yOffset: 0.3 },
  { x: 33.4, yRadius: 1.2, zRadius: 0.92, yOffset: -0.25 },
  { x: 34, yRadius: 0.31, zRadius: 0.34, yOffset: -0.1 },
];

const D = 180 / Math.PI;
let engine: NullEngine;
let scene: Scene;
let visual: AircraftVisual;
const built = new Map<string, SkinTriangles & { positions: number[] }>();
let old: { fuselage: SkinTriangles & { positions: number[] }; nose: SkinTriangles & { positions: number[] } };

const copy = (mesh: { getVerticesData(kind: string): ArrayLike<number> | null; getIndices(): ArrayLike<number> | null }) => ({
  positions: Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!),
  indices: Array.from(mesh.getIndices()!),
  normals: Array.from(mesh.getVerticesData(VertexBuffer.NormalKind)!),
});

beforeAll(() => {
  const original = AircraftBuildContext.prototype.loft;
  const spy = vi.spyOn(AircraftBuildContext.prototype, "loft").mockImplementation(
    function (this: AircraftBuildContext, ...args: Parameters<typeof original>) {
      const mesh = original.apply(this, args);
      if (args[0] === "airliner-fuselage" || args[0] === "airliner-radome") built.set(args[0], copy(mesh));
      return mesh;
    },
  );
  engine = new NullEngine();
  scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  visual = createWebGpuAircraft(scene, "airliner");
  spy.mockRestore();
  // The old join, lofted the way the airliner lofts it: 28 segments round.
  const build = new AircraftBuildContext(scene);
  const root = new TransformNode("old-join", scene);
  const material = new StandardMaterial("old-join", scene);
  old = {
    fuselage: copy(build.loft("old-fuselage", OLD_FUSELAGE, 28, material, root)),
    nose: copy(build.loft("old-nose", OLD_NOSE, 28, material, root)),
  };
});

afterAll(() => {
  visual.dispose();
  scene.dispose();
  engine.dispose();
});

/**
 * Every place the two skins cross, round the whole section: from an axis
 * point inside both, along each azimuth, stepping in x and watching which
 * skin is further out. Returns the angle between the two skins' shading
 * normals at each crossing -- the shading step the eye sees as a crease.
 */
function crossings(fuselage: SkinTriangles, nose: SkinTriangles): { azimuth: number; x: number; angle: number }[] {
  const f = new SkinCaster([fuselage]);
  const n = new SkinCaster([nose]);
  const found: { azimuth: number; x: number; angle: number }[] = [];
  for (let azimuth = 0; azimuth < 360; azimuth += 15) {
    const direction = { x: 0, y: Math.cos(azimuth / D), z: Math.sin(azimuth / D) };
    let last: number | null = null;
    for (let step = 0; step <= 1000; step += 1) {
      const x = 26 + step * 0.005;
      const a = f.exit({ x, y: 0.5, z: 0 }, direction);
      const b = n.exit({ x, y: 0.5, z: 0 }, direction);
      if (!a || !b) { last = null; continue; }
      const outward = a.distance - b.distance;
      if (last !== null && outward !== 0 && Math.sign(outward) !== Math.sign(last)) {
        const cos = a.normal.x * b.normal.x + a.normal.y * b.normal.y + a.normal.z * b.normal.z;
        found.push({ azimuth, x, angle: Math.acos(Math.min(1, cos)) * D });
      }
      last = outward;
    }
  }
  return found;
}

describe("the 747's fuselage/radome join", () => {
  it("crosses once, at every azimuth, with the two skins' normals within 5 degrees -- where the old join creased", () => {
    const now = crossings(built.get("airliner-fuselage")!, built.get("airliner-radome")!);
    // One crossing per azimuth, all of them in one ring near x = 29.8.
    expect(now.map((c) => c.azimuth)).toEqual(Array.from({ length: 24 }, (_, i) => i * 15));
    for (const c of now) {
      expect(c.x, `azimuth ${c.azimuth}`).toBeGreaterThan(29.4);
      expect(c.x, `azimuth ${c.azimuth}`).toBeLessThan(30.1);
      expect(c.angle, `azimuth ${c.azimuth} at x ${c.x.toFixed(2)}`).toBeLessThanOrEqual(5);
    }
    // CONTROL: the old join, through the same instrument. It crossed on a slanted
    // loop -- over the top at 29.0-29.9, underneath at 26.9-28.0, three times on
    // each flank -- and creased by 32 degrees at the crown and 19 underneath.
    const before = crossings(old.fuselage, old.nose);
    expect(before.length).toBeGreaterThan(24);
    expect(Math.max(...before.map((c) => c.angle))).toBeGreaterThan(30);
    expect(before.filter((c) => c.angle > 5).length).toBeGreaterThan(20);
  });

  it("moves nothing on the nose from its 29.2 ring to its 32.4 ring, nor 33.4's upper half, nor the fuselage from 26 aft", () => {
    // From 29.2 to 33.4 the nose carries the flight-deck glass, which is cast onto it; aft of 26 the fuselage is the
    // cabin, the doors and the livery's straight run. The nose polish (2026-09-23) re-ringed the nose behind 29.2 and
    // ahead of 33.4 and lowered 33.4's keel, so its rings pair by STATION: a ring is its 29 vertices, laid in order.
    const rings = (positions: number[], count: number) => {
      const out = new Map<number, number[]>();
      for (let ring = 0; ring < count; ring += 1) out.set(positions[ring * 29 * 3]!, positions.slice(ring * 29 * 3, (ring + 1) * 29 * 3));
      return out;
    };
    const nose = built.get("airliner-radome")!;
    const now = rings(nose.positions, NOSE_SECTIONS.length);
    const then = rings(old.nose.positions, OLD_NOSE.length);
    const moved = (x: number, keep: (y: number) => boolean = () => true) => {
      const a = now.get(x)!;
      const b = then.get(x)!;
      let compared = 0;
      let count = 0;
      for (let v = 0; v < 29; v += 1) {
        if (!keep(b[v * 3 + 1]!)) continue;
        compared += 1;
        if (a[v * 3] !== b[v * 3] || a[v * 3 + 1] !== b[v * 3 + 1] || a[v * 3 + 2] !== b[v * 3 + 2]) count += 1;
      }
      return { compared, count };
    };
    for (const x of [29.2, 30.4, 31.4, 32.4]) expect(moved(x), `the nose's ${x} ring`).toEqual({ compared: 29, count: 0 });
    // 33.4: the upper half (and the widest point, at its own height) stays; the keel carried on is the change.
    const upper = moved(33.4, (y) => y >= -0.25);
    expect(upper.compared).toBe(15);
    expect(upper.count).toBe(0);
    // The fuselage's first ten rings (-26 .. 26) are its first 290 vertices in both builds.
    const fuselage = built.get("airliner-fuselage")!;
    let aft = 0;
    for (let v = 0; v < 29 * 10; v += 1) {
      for (let k = 0; k < 3; k += 1) if (fuselage.positions[v * 3 + k] !== old.fuselage.positions[v * 3 + k]) { aft += 1; break; }
    }
    expect(fuselage.positions[29 * 9 * 3]).toBe(26);
    expect(aft).toBe(0);
    // CONTROLS: the same comparison sees the join's 28 ring move, and 33.4's keel.
    expect(moved(28).count).toBeGreaterThan(20);
    // 14, not 13: one widest point is at cos(3 pi / 2) = -1.8e-16, so it reads the lower radius, and moves by an ulp.
    expect(moved(33.4, (y) => y < -0.25)).toEqual({ compared: 14, count: 14 });
  });
});
