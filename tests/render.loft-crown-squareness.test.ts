import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it } from "vitest";
import { AircraftBuildContext, loftSectionPoint, type LoftSection } from "../src/render/webgpu/aircraft/builders";

/**
 * `crownSquareness` with `crownFillet` makes a loft section's UPPER half a
 * FILLETED V: the superellipse of that exponent, its radii shrunk by the
 * fillet, offset back out by it, and sampled by the outward normal's angle.
 * The Global's flight deck: flat windshield panes meeting at the centre post
 * (phase 3c, part 6b). This holds it to what makes it safe:
 *
 *  1. It is the IDENTITY when unused: no vertex of any existing loft moves
 *     (and the trainer, jet and 747 digests in render.loft-crown-seam / -taper
 *     are unchanged).
 *  2. It moves the upper half ONLY, and keeps the crown's height and the
 *     half-width at the widest point: the lower half is the ellipse's bit for
 *     bit, and every upper vertex lies inside the ellipse through the same
 *     crown and width.
 *  3. It is SMOOTH: the curvature is capped at 1 / fillet, so the crown is
 *     round and not a ridge, and sampled by the normal's angle every facet of
 *     the upper half turns by the same step. An unfilleted V is the control:
 *     its crown's radius shrinks toward nothing as the ring is sampled finer.
 */

const fixtures: Array<{ engine: NullEngine; scene: Scene }> = [];

afterEach(() => {
  for (const entry of fixtures.splice(0)) {
    entry.scene.dispose();
    entry.engine.dispose();
  }
});

function positionsOf(sections: readonly LoftSection[], segments: number): Float32Array {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  fixtures.push({ engine, scene });
  const build = new AircraftBuildContext(scene);
  const material = build.material("v-probe", 0xffffff, { roughness: 1, metallic: 0 });
  const mesh = build.loft("v-probe-mesh", sections, segments, material, new TransformNode("root", scene));
  return Float32Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!);
}

const ELLIPSE: readonly LoftSection[] = [
  { x: 0, yRadius: 0.85, zRadius: 1.14, yOffset: -0.1 },
  { x: 1, yRadius: 0.8, zRadius: 1.1, yOffset: -0.16 },
];
const V = (n: number, fillet: number): LoftSection[] => ELLIPSE.map((s) => ({ ...s, crownSquareness: n, crownFillet: fillet }));

/** A ring vertex's (y, z), ring `ring`, radial `radial`, `segments` round. */
const at = (positions: Float32Array, segments: number, ring: number, radial: number) => {
  const i = (ring * (segments + 1) + radial) * 3;
  return { y: positions[i + 1]!, z: positions[i + 2]! };
};
/** The radius of the circle through three ring vertices. */
const circumradius = (p: { y: number; z: number }, q: { y: number; z: number }, r: { y: number; z: number }) => {
  const a = Math.hypot(p.y - q.y, p.z - q.z);
  const b = Math.hypot(q.y - r.y, q.z - r.z);
  const c = Math.hypot(r.y - p.y, r.z - p.z);
  const area = Math.abs((q.z - p.z) * (r.y - p.y) - (r.z - p.z) * (q.y - p.y)) / 2;
  return (a * b * c) / (4 * area);
};

describe("the loft's filleted crown", () => {
  it("is the identity when absent, and at exponent 2 with no fillet lays the ellipse itself", () => {
    const plain = positionsOf(ELLIPSE, 48);
    expect(Array.from(positionsOf(ELLIPSE.map((s) => ({ ...s })), 48))).toEqual(Array.from(plain));
    // At 2 with no fillet the upper half is the same curve, resampled by the normal's angle.
    const resampled = positionsOf(V(2, 0), 48);
    for (let ring = 0; ring < 2; ring += 1) {
      const s = ELLIPSE[ring]!;
      for (let radial = 0; radial <= 48; radial += 1) {
        const p = at(resampled, 48, ring, radial);
        expect(Math.abs(((p.y - s.yOffset!) / s.yRadius) ** 2 + (p.z / s.zRadius) ** 2 - 1)).toBeLessThan(1e-6);
      }
    }
  });

  it("moves the upper half only, holding the crown's height and the waterline's width, inside the ellipse", () => {
    const segments = 48;
    const plain = positionsOf(ELLIPSE, segments);
    const vee = positionsOf(V(1.35, 0.15), segments);
    for (let ring = 0; ring < 2; ring += 1) {
      const s = ELLIPSE[ring]!;
      // The lower half, bit for bit.
      for (let radial = segments / 4 + 1; radial < (3 * segments) / 4; radial += 1) {
        expect(at(vee, segments, ring, radial)).toEqual(at(plain, segments, ring, radial));
      }
      // The crown's height and the waterline's width, to a micrometre.
      expect(Math.abs(at(vee, segments, ring, 0).y - (s.yOffset! + s.yRadius))).toBeLessThan(1e-6);
      expect(Math.abs(at(vee, segments, ring, segments / 4).z - s.zRadius)).toBeLessThan(1e-6);
      expect(Math.abs(at(vee, segments, ring, segments / 4).y - s.yOffset!)).toBeLessThan(1e-6);
      // Every other upper vertex strictly inside the ellipse: the shoulders come down and in.
      for (const radial of [...Array.from({ length: segments / 4 - 1 }, (_, k) => k + 1), ...Array.from({ length: segments / 4 - 1 }, (_, k) => (3 * segments) / 4 + 1 + k)]) {
        const p = at(vee, segments, ring, radial);
        expect(((p.y - s.yOffset!) / s.yRadius) ** 2 + (p.z / s.zRadius) ** 2).toBeLessThan(1);
      }
    }
  });

  it("is smooth: the crown is round to the fillet's radius, and every upper facet turns by the same step", () => {
    // The crown's radius of curvature, from the crown and the points a step either side of it, the step
    // finer and finer (the loft's own point function, in double precision: at a 4800th of a turn the
    // mesh's float32 vertices are closer than their rounding). The filleted V's converges on the fillet
    // (0.15 m); the unfilleted V's collapses.
    const crownRadius = (section: LoftSection, steps: number) => {
      const step = (2 * Math.PI) / steps;
      return circumradius(loftSectionPoint(section, -step), loftSectionPoint(section, 0), loftSectionPoint(section, step));
    };
    expect(Math.abs(crownRadius(V(1.35, 0.15)[0]!, 480) - 0.15)).toBeLessThan(0.01);
    expect(Math.abs(crownRadius(V(1.35, 0.15)[0]!, 48000) - 0.15)).toBeLessThan(0.001);
    // CONTROL: no fillet, a ridge. Its crown's radius falls with every refinement.
    const ridge480 = crownRadius(V(1.35, 0)[0]!, 480);
    const ridge48000 = crownRadius(V(1.35, 0)[0]!, 48000);
    expect(ridge48000).toBeLessThan(ridge480 / 10);
    expect(ridge48000).toBeLessThan(0.01);
    // Sampled by the normal's angle: consecutive upper facets turn by 360 / segments, to a quarter of a
    // degree (a chord between two samples is the mean tangent only where the curvature is even); no
    // step gathers the turn as the unfilleted, angle-sampled V's did (20 degrees at the waterline).
    const segments = 48;
    const p = positionsOf(V(1.35, 0.15), segments);
    const heading = (k: number) => {
      const a = at(p, segments, 0, k);
      const b = at(p, segments, 0, k + 1);
      return Math.atan2(b.y - a.y, b.z - a.z);
    };
    for (let k = 0; k < segments / 4 - 1; k += 1) {
      expect(Math.abs(Math.abs(heading(k + 1) - heading(k)) * 180 / Math.PI - 360 / segments)).toBeLessThan(0.25);
    }
  });

  it("shares its point with the loft, and refuses a ridge, an oversized fillet or a fillet without a V", () => {
    const segments = 48;
    const p = positionsOf(V(1.35, 0.15), segments);
    for (let radial = 0; radial <= segments; radial += 1) {
      const point = loftSectionPoint(V(1.35, 0.15)[0]!, (radial / segments) * Math.PI * 2);
      expect(at(p, segments, 0, radial).y).toBeCloseTo(point.y, 6);
      expect(at(p, segments, 0, radial).z).toBeCloseTo(point.z, 6);
    }
    expect(() => positionsOf(V(1, 0.15), 48)).toThrow(RangeError);
    expect(() => positionsOf(V(1.35, 0.9), 48)).toThrow(RangeError);
    expect(() => positionsOf(ELLIPSE.map((s) => ({ ...s, crownFillet: 0.1 })), 48)).toThrow(RangeError);
  });
});
