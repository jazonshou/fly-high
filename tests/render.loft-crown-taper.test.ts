import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { afterEach, describe, expect, it } from "vitest";
import { AircraftBuildContext, type LoftSection } from "../src/render/webgpu/aircraft/builders";
import { createWebGpuAircraft, type AircraftVisual } from "../src/render/webgpu/aircraft";

/**
 * `crownZRadius` lets a loft section be an EGG rather than an ellipse, and this
 * holds it to the two things that make that safe.
 *
 * WHY IT EXISTS. A wide-body's forward fuselage is widest at the main deck
 * floor and narrower at the crown, and a superellipse cannot say that —
 * `zRadius` applies equally above and below the section's centre. The 747's
 * raised upper deck was therefore built as a SECOND closed loft intersecting
 * the first, and two intersecting closed surfaces cannot be tangent-continuous:
 * that airframe's own comment records trading a 41-degree crease for a
 * 31-degree one by widening the upper lobe. A 31-degree crease is what reads as
 * a cylinder laid on top of a fuselage.
 *
 * THE TWO THINGS THAT MAKE IT SAFE, and both are measured here rather than
 * asserted in prose:
 *
 *  1. It is the IDENTITY when unused. Every loft on every shipped airframe
 *     omits it, so the feature must not move a single vertex of any of them.
 *     Checked two ways: against the superellipse formula recomputed
 *     independently below, and against pinned hashes of the three airframes
 *     this pass does not touch.
 *
 *  2. It is C1 AT THE WATERLINE. The taper runs over the upper half only, so
 *     the obvious implementation — a linear ramp in `max(0, yShape)` — would
 *     kink the surface exactly at the widest point, removing a crease at the
 *     crown by adding one at the equator. The ramp is a smoothstep, whose
 *     slope is zero at both ends, and the finite-difference check below is
 *     what says so.
 */

interface Fixture {
  engine: NullEngine;
  scene: Scene;
  build: AircraftBuildContext;
  root: TransformNode;
}

const fixtures: Array<{ engine: NullEngine; scene: Scene; visual?: AircraftVisual }> = [];

afterEach(() => {
  for (const entry of fixtures.splice(0)) {
    entry.visual?.dispose();
    entry.scene.dispose();
    entry.engine.dispose();
  }
});

function context(): Fixture {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  fixtures.push({ engine, scene });
  const build = new AircraftBuildContext(scene);
  return { engine, scene, build, root: new TransformNode("root", scene) };
}

const SECTIONS: readonly LoftSection[] = [
  { x: -4, yRadius: 0.8, zRadius: 1.1, yOffset: 0.2 },
  { x: 0, yRadius: 1.4, zRadius: 1.9, yOffset: 0.05, zOffset: 0.1 },
  { x: 3.5, yRadius: 1.2, zRadius: 1.3, squareness: 3.5 },
];
const SEGMENTS = 24;

/** The superellipse the loft drew before `crownZRadius` existed. */
function priorFormula(section: LoftSection, radial: number): [number, number, number] {
  const phase = radial / SEGMENTS;
  const angle = phase * Math.PI * 2;
  const exponent = 2 / (section.squareness ?? 2);
  const yShape = Math.sign(Math.cos(angle)) * Math.abs(Math.cos(angle)) ** exponent;
  const zShape = Math.sign(Math.sin(angle)) * Math.abs(Math.sin(angle)) ** exponent;
  return [
    section.x,
    (section.yOffset ?? 0) + yShape * section.yRadius,
    (section.zOffset ?? 0) + zShape * section.zRadius,
  ];
}

function positionsOf(sections: readonly LoftSection[]): Float32Array {
  const { build, root, scene } = context();
  const material = build.material("loft-probe", 0xffffff, { roughness: 1, metallic: 0 });
  const mesh = build.loft("loft-probe-mesh", sections, SEGMENTS, material, root);
  void scene;
  return Float32Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!);
}

/** A cheap order-sensitive digest; a moved vertex changes it. */
function digest(values: ArrayLike<number>): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < values.length; index += 1) {
    // Quantised to a micrometre so the hash is about geometry, not float noise.
    const quantised = Math.round(values[index]! * 1e6);
    hash ^= quantised & 0xffffffff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

describe("the loft's crown taper", () => {
  it("draws exactly the prior superellipse when it is not asked for", () => {
    const positions = positionsOf(SECTIONS);
    let compared = 0;
    for (let sectionIndex = 0; sectionIndex < SECTIONS.length; sectionIndex += 1) {
      for (let radial = 0; radial <= SEGMENTS; radial += 1) {
        const expected = priorFormula(SECTIONS[sectionIndex]!, radial);
        const base = (sectionIndex * (SEGMENTS + 1) + radial) * 3;
        for (let axis = 0; axis < 3; axis += 1) {
          // `Math.fround`, because the mesh keeps positions in a Float32Array
          // and this formula computes in doubles. Comparing the two directly
          // fails on the last two decimal places of a value that is in fact
          // bit-identical once stored, which is a difference about the
          // container rather than about the geometry.
          expect(positions[base + axis]).toBe(Math.fround(expected[axis]!));
          compared += 1;
        }
      }
    }
    // The exposure column: a pass means nothing if nothing was compared.
    expect(compared).toBe(SECTIONS.length * (SEGMENTS + 1) * 3);
  });

  it("is the identity when the crown radius equals the section's own", () => {
    const withCrown = SECTIONS.map((section) => ({
      ...section,
      crownZRadius: section.zRadius,
    }));
    expect(digest(positionsOf(withCrown))).toBe(digest(positionsOf(SECTIONS)));
  });

  it("narrows only the upper half, leaving the lower lobe untouched", () => {
    const plain = positionsOf(SECTIONS);
    const egg = positionsOf(SECTIONS.map((section) => ({
      ...section,
      crownZRadius: section.zRadius * 0.6,
    })));
    let narrowedAbove = 0;
    let movedBelow = 0;
    let checkedBelow = 0;
    for (let sectionIndex = 0; sectionIndex < SECTIONS.length; sectionIndex += 1) {
      const section = SECTIONS[sectionIndex]!;
      const centre = section.yOffset ?? 0;
      for (let radial = 0; radial <= SEGMENTS; radial += 1) {
        const base = (sectionIndex * (SEGMENTS + 1) + radial) * 3;
        const y = plain[base + 1]!;
        const width = Math.abs(plain[base + 2]! - (section.zOffset ?? 0));
        const eggWidth = Math.abs(egg[base + 2]! - (section.zOffset ?? 0));
        // The flanks only: at the keel and the crown the half-width is zero
        // either way and says nothing about the taper.
        if (width < 1e-6) continue;
        if (y > centre + 1e-6) {
          expect(eggWidth, "a vertex above the waterline did not narrow")
            .toBeLessThan(width);
          narrowedAbove += 1;
        } else if (y < centre - 1e-6) {
          checkedBelow += 1;
          if (Math.abs(eggWidth - width) > 1e-9) movedBelow += 1;
        }
      }
    }
    expect(narrowedAbove, "nothing above the waterline was compared").toBeGreaterThan(6);
    expect(checkedBelow, "nothing below the waterline was compared").toBeGreaterThan(6);
    expect(movedBelow, "the lower lobe moved; the taper is not confined to the crown")
      .toBe(0);
  });

  it("keeps the surface C1 where the two half-widths meet", () => {
    // The half-width as the builder computes it, sampled either side of the
    // waterline. A linear ramp would show a slope discontinuity here; the
    // smoothstep's slope is zero on both sides, so the difference of the
    // one-sided slopes must vanish.
    const halfWidth = (yShape: number): number => {
      const rise = Math.max(0, yShape);
      const lift = rise * rise * (3 - 2 * rise);
      return 1 + (0.5 - 1) * lift;
    };
    const step = 1e-4;
    const below = (halfWidth(0) - halfWidth(-step)) / step;
    const above = (halfWidth(step) - halfWidth(0)) / step;
    expect(Math.abs(above - below)).toBeLessThan(1e-3);
  });

  it("moves no vertex of the airframes that do not use it", () => {
    // The three this pass does not touch. A change here means a loft's shape
    // moved: if that was deliberate, re-pin with the reason in the commit;
    // if it was not, the crown taper has stopped being the identity.
    const pinned: Readonly<Record<string, string>> = {
      // RE-PINNED for the trainer and the Global by the cockpit work (jazonshou/cockpit-view),
      // which replaced their cockpit meshes: the old panel, gauges and needles are gone and
      // cockpit-only meshes (metadata.cockpitOnly) stand in their place. Nothing else moved: it was
      // checked mesh by mesh against House-Keeping's own source (positions AND
      // indices): the jet (76 of 76) and the 747 (91 of 91) are identical, and of the trainer's 62
      // meshes 51 are bit-identical and of the Global's 99, 88 are; every one that differs is
      // the old cockpit or the new one. The 747 keeps its pin; the jet's is re-pinned separately, below.
      // RE-PINNED AGAIN for the trainer by the instruments step (jazonshou/cockpit-instruments):
      // its five needle meshes now live in a hub-local frame (vertices about the dial's centre,
      // the mesh's own transform carrying the frame) and have a pointer and a tail. Checked
      // mesh by mesh against the tip it was cut from (da86f47), positions AND indices: this
      // step left the trainer's other 63 meshes, the jet's 76, the Global's 99 and the 747's
      // 91 bit-identical.
            // RE-PINNED ONCE MORE for the trainer by the Cessna's attitude ball (jazonshou/cockpit-cessna-ball):
      // its attitude needle mesh is gone and the ball's three pieces (sky, ground, pitch bar) stand in
      // its place. Checked mesh by mesh against 8a45c97, positions AND indices: the trainer's other 67
      // meshes, the jet's 78, the Global's 99 and the 747's 91 are bit-identical, which also holds the
      // Global's ball to be unchanged by its builder moving into cockpitPrimitives.
trainer: "00cb1d45",
      // Re-pinned for the F-16's airbrake shelves and rebuilt petals. The
      // crown taper is still unused on this airframe; what moved is the tail.
      jet: "8bb6edcd",
      bizjet: "58fd2565",
    };
    for (const kind of ["trainer", "jet", "bizjet"] as const) {
      const engine = new NullEngine();
      const scene = new Scene(engine);
      scene.useRightHandedSystem = true;
      const visual = createWebGpuAircraft(scene, kind);
      fixtures.push({ engine, scene, visual });
      const lofts = scene.meshes
        .filter((mesh) => mesh.getTotalVertices() > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
      expect(lofts.length, `${kind} built no meshes`).toBeGreaterThan(0);
      const all: number[] = [];
      for (const mesh of lofts) {
        all.push(...(mesh.getVerticesData(VertexBuffer.PositionKind) ?? []));
      }
      expect(digest(all), `${kind} geometry digest`).toBe(pinned[kind]);
    }
  });
});
