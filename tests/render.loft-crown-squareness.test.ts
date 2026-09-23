import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it } from "vitest";
import { AircraftBuildContext, type LoftSection } from "../src/render/webgpu/aircraft/builders";

/**
 * `crownSquareness` gives a loft section's UPPER half its own superellipse
 * exponent, and below 2 that draws it toward a V: the Global's flight deck,
 * flat windshield panes meeting at the centre post (phase 3c, part 6). This
 * holds it to what makes it safe:
 *
 *  1. It is the IDENTITY when unused, or when it equals the section's own
 *     squareness: no vertex of any existing loft moves (and the trainer, jet
 *     and 747 digests in render.loft-crown-seam / -taper are unchanged).
 *  2. It moves the upper half ONLY, and keeps the crown's height and the
 *     half-width at the widest point: the lower half is the ellipse's bit for
 *     bit, and so are the crown and waterline vertices (the seam's to 1e-12).
 *  3. It is TANGENT-CONTINUOUS for any exponent above 1, horizontal at the
 *     crown and vertical at the waterline, which the chord next to each
 *     approaches as the ring is sampled finer; at 1 the crown is a ridge, and
 *     the builder refuses it.
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
const V = (n: number): LoftSection[] => ELLIPSE.map((section) => ({ ...section, crownSquareness: n }));

/** A ring vertex's (y, z), ring `ring`, radial `radial`, `segments` round. */
const at = (positions: Float32Array, segments: number, ring: number, radial: number) => {
  const i = (ring * (segments + 1) + radial) * 3;
  return { y: positions[i + 1]!, z: positions[i + 2]! };
};

describe("the loft's crown squareness", () => {
  it("is the identity when absent, and when it equals the section's own squareness", () => {
    const plain = positionsOf(ELLIPSE, 48);
    expect(Array.from(positionsOf(V(2), 48))).toEqual(Array.from(plain));
    const squared = ELLIPSE.map((section) => ({ ...section, squareness: 3 }));
    expect(Array.from(positionsOf(squared.map((s) => ({ ...s, crownSquareness: 3 })), 48))).toEqual(Array.from(positionsOf(squared, 48)));
  });

  it("moves the upper half only, holding the crown's height and the waterline's width", () => {
    const segments = 48;
    const plain = positionsOf(ELLIPSE, segments);
    const vee = positionsOf(V(1.3), segments);
    for (let ring = 0; ring < 2; ring += 1) {
      // Crown (radial 0, and the seam's copy of it) and both waterline vertices (a quarter and three
      // quarters round): the same points. (At the seam sin(2 pi) is 1e-16, which the V's exponent takes
      // to 1e-24: both are the centre line.)
      for (const radial of [0, segments / 4, (3 * segments) / 4, segments]) {
        const v = at(vee, segments, ring, radial);
        const e = at(plain, segments, ring, radial);
        expect(v.y).toBe(e.y);
        expect(Math.abs(v.z - e.z)).toBeLessThan(1e-12);
      }
      // The lower half, bit for bit.
      for (let radial = segments / 4; radial <= (3 * segments) / 4; radial += 1) {
        expect(at(vee, segments, ring, radial)).toEqual(at(plain, segments, ring, radial));
      }
      // The upper half: every vertex between crown and waterline lower AND inward, both flanks.
      for (const radial of [...Array.from({ length: segments / 4 - 1 }, (_, k) => k + 1), ...Array.from({ length: segments / 4 - 1 }, (_, k) => (3 * segments) / 4 + 1 + k)]) {
        const v = at(vee, segments, ring, radial);
        const e = at(plain, segments, ring, radial);
        expect(v.y).toBeLessThan(e.y);
        expect(Math.abs(v.z)).toBeLessThan(Math.abs(e.z));
      }
    }
  });

  it("stays tangent-continuous at the crown and the waterline for an exponent above 1, and refuses 1", () => {
    // The chord from the crown to its neighbour flattens toward horizontal, and the chord from the
    // waterline up to its neighbour steepens toward vertical, as the ring is sampled finer: the
    // surface has a tangent there, not a corner. Measured at n 1.3 (the Global's is 1.26-1.47).
    const chords = (segments: number) => {
      const p = positionsOf(V(1.3), segments);
      const crown = at(p, segments, 0, 0);
      const nextToCrown = at(p, segments, 0, 1);
      const waterline = at(p, segments, 0, segments / 4);
      const aboveWaterline = at(p, segments, 0, segments / 4 - 1);
      return {
        crownFromHorizontal: Math.atan2(Math.abs(crown.y - nextToCrown.y), Math.abs(nextToCrown.z - crown.z)) * 180 / Math.PI,
        waterlineFromVertical: Math.atan2(Math.abs(waterline.z - aboveWaterline.z), Math.abs(aboveWaterline.y - waterline.y)) * 180 / Math.PI,
      };
    };
    const coarse = chords(48);
    const fine = chords(480);
    const finer = chords(4800);
    expect(fine.crownFromHorizontal).toBeLessThan(coarse.crownFromHorizontal);
    expect(finer.crownFromHorizontal).toBeLessThan(fine.crownFromHorizontal);
    expect(fine.waterlineFromVertical).toBeLessThan(coarse.waterlineFromVertical);
    expect(finer.waterlineFromVertical).toBeLessThan(fine.waterlineFromVertical);
    expect(finer.crownFromHorizontal).toBeLessThan(6);
    expect(finer.waterlineFromVertical).toBeLessThan(6);
    // CONTROL: at exponent 1 the section would be a diamond, with a corner at the crown that no
    // sampling removes, and the builder refuses it.
    expect(() => positionsOf(V(1), 48)).toThrow(RangeError);
  });
});
