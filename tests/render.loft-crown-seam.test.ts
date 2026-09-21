import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { afterEach, describe, expect, it } from "vitest";
import { AircraftBuildContext, type LoftSection } from "../src/render/webgpu/aircraft/builders";
import { createWebGpuAircraft, type AircraftVisual } from "../src/render/webgpu/aircraft";
import { AIRCRAFT_KINDS, type AircraftKind } from "../src/sim";

/**
 * A LOFT'S RING CLOSES AT THE CROWN, and both halves must be shaded as one
 * surface.
 *
 * THE DEFECT. `loft()` repeats its first radial vertex at the end of every
 * section, because the UV has to run 0..1 round the section and one vertex
 * cannot carry two texture coordinates. The two are at the same point in
 * space, but `VertexData.ComputeNormals` only ever sees each one's own
 * triangles — the faces on one side of the seam for one, the other side for
 * the other — and writes them different normals. The surface is continuous and
 * the shading is not, so every lofted body in the game carried a line down its
 * top centreline: measured as the angle between the normal one degree to port
 * of the centreline and one degree to starboard, 20.8 degrees on the 747, 18.2
 * on the F-16, 11.1 on the Cessna and 8.8 on the Global.
 *
 * Against the same measurement 45 degrees round, where there is no seam, those
 * are 19.8 / 16.8 / 8.7 / 6.8 degrees of EXCESS. The control matters: across
 * two degrees of a round section the normal turns two degrees whatever the
 * mesh does, so zero is not the target and a bare seam number cannot be read.
 * Welded, the excess is 3.2 / 0.0 / 0.5 / 0.2.
 *
 * WHAT THIS FILE PINS, because the fix is three lines and its blast radius is
 * every aeroplane:
 *
 *  1. NO VERTEX MOVED. Positions and indices are digested per airframe and
 *     pinned. Welding writes normals and nothing else; if one of these moves,
 *     something other than shading changed.
 *  2. ONLY THE SEAM CHANGED. The welded pairs are counted, and every other
 *     radial vertex is asserted to still disagree with its neighbour — which
 *     is what a curved surface should do and what proves the weld is a seam
 *     repair rather than a smoothing pass over the whole mesh.
 *  3. THE EXCEPTION HOLDS. `airfoilWing` also repeats vertices, at its leading
 *     and trailing edges, and there it is deliberate: a trailing edge IS a
 *     crease. Those are asserted to STILL differ.
 */

const fixtures: Array<{ engine: NullEngine; scene: Scene; visual?: AircraftVisual }> = [];

afterEach(() => {
  for (const entry of fixtures.splice(0)) {
    entry.visual?.dispose();
    entry.scene.dispose();
    entry.engine.dispose();
  }
});

function context(): { scene: Scene; build: AircraftBuildContext; root: TransformNode } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  fixtures.push({ engine, scene });
  return { scene, build: new AircraftBuildContext(scene), root: new TransformNode("root", scene) };
}

/** A cheap order-sensitive digest; a moved vertex changes it. */
function digest(values: ArrayLike<number>): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < values.length; index += 1) {
    const quantised = Math.round(values[index]! * 1e6);
    hash ^= quantised & 0xffffffff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const SECTIONS: readonly LoftSection[] = [
  { x: -3, yRadius: 0.9, zRadius: 1.2, yOffset: 0.2 },
  { x: 0, yRadius: 1.5, zRadius: 1.9, yOffset: 0.05 },
  { x: 4, yRadius: 1.1, zRadius: 1.2, squareness: 3 },
];
const SEGMENTS = 24;
const RING = SEGMENTS + 1;

function normalAt(normals: ArrayLike<number>, vertex: number): [number, number, number] {
  return [normals[vertex * 3]!, normals[vertex * 3 + 1]!, normals[vertex * 3 + 2]!];
}

describe("a loft's crown seam", () => {
  it("gives the two coincident crown vertices one normal, on every section", () => {
    const { build, root } = context();
    const material = build.material("seam-probe", 0xffffff, { roughness: 1, metallic: 0 });
    const mesh = build.loft("seam-probe-mesh", SECTIONS, SEGMENTS, material, root);
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    let welded = 0;
    for (let section = 0; section < SECTIONS.length; section += 1) {
      const first = section * RING;
      const last = first + SEGMENTS;
      // They really are the same point — if this ever stops being true the
      // weld is averaging across a fold, not a seam. NOT bit-identical, and
      // that is arithmetic rather than a defect: the ring's last vertex is at
      // angle 2*pi, where `Math.sin` returns -2.4e-16 rather than zero, so the
      // two crown vertices sit about 3e-16 m apart in z. A tolerance of a
      // nanometre is nine orders of magnitude tighter than anything that could
      // be a real gap and nine looser than the float noise.
      for (let axis = 0; axis < 3; axis += 1) {
        expect(positions[first * 3 + axis]).toBeCloseTo(positions[last * 3 + axis]!, 9);
      }
      expect(normalAt(normals, first), `section ${section} crown normals differ`)
        .toEqual(normalAt(normals, last));
      welded += 1;
    }
    expect(welded, "no sections were checked").toBe(SECTIONS.length);
  });

  it("leaves every other radial vertex alone, so it is a seam repair not a smoothing pass", () => {
    const { build, root } = context();
    const material = build.material("seam-probe", 0xffffff, { roughness: 1, metallic: 0 });
    const mesh = build.loft("seam-probe-mesh", SECTIONS, SEGMENTS, material, root);
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    let compared = 0;
    let identical = 0;
    for (let section = 0; section < SECTIONS.length; section += 1) {
      for (let radial = 0; radial < SEGMENTS - 1; radial += 1) {
        const here = normalAt(normals, section * RING + radial);
        const next = normalAt(normals, section * RING + radial + 1);
        compared += 1;
        if (here.every((value, axis) => value === next[axis]!)) identical += 1;
      }
    }
    expect(compared, "nothing was compared").toBeGreaterThan(60);
    // A curved section turns its normal at every step. Any pair that agrees
    // exactly would mean the weld reached past the seam.
    expect(identical, "normals away from the seam were made identical").toBe(0);
  });

  it("keeps the keel a single vertex, so there is nothing to weld there", () => {
    // The ring starts at angle 0, which is the CROWN. The keel is angle pi —
    // one ordinary vertex, and with an odd segment count not even that. This
    // is why the fix is a crown fix and why the bottom centreline reads the
    // same before and after.
    const { build, root } = context();
    const material = build.material("seam-probe", 0xffffff, { roughness: 1, metallic: 0 });
    const mesh = build.loft("seam-probe-mesh", SECTIONS, SEGMENTS, material, root);
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const keel = SEGMENTS / 2;
    const sharesPoint = (a: number, b: number): boolean =>
      Math.abs(positions[a * 3 + 1]! - positions[b * 3 + 1]!) < 1e-9
      && Math.abs(positions[a * 3 + 2]! - positions[b * 3 + 2]!) < 1e-9;
    let coincident = 0;
    for (let radial = 0; radial <= SEGMENTS; radial += 1) {
      if (radial !== keel && sharesPoint(radial, keel)) coincident += 1;
    }
    expect(coincident, "something else sits on the keel").toBe(0);
    // Non-vacuity: the crown DOES have its pair, by the same test.
    let crownPairs = 0;
    for (let radial = 1; radial <= SEGMENTS; radial += 1) {
      if (sharesPoint(radial, 0)) crownPairs += 1;
    }
    expect(crownPairs, "the crown lost its duplicate, so this test proves nothing").toBe(1);
  });

  it("does NOT weld an aerofoil's trailing edge, which is meant to be a crease", () => {
    const { build, root } = context();
    const material = build.material("wing-probe", 0xffffff, { roughness: 1, metallic: 0 });
    const wing = build.airfoilWing("wing-probe-mesh", {
      rootLeadingX: 2, rootTrailingX: -2, tipLeadingX: 1, tipTrailingX: -1,
      rootZ: 0, tipZ: 4, thicknessRatio: 0.1, chordSegments: 8, spanSegments: 2,
    }, material, root);
    const positions = wing.getVerticesData(VertexBuffer.PositionKind)!;
    const normals = wing.getVerticesData(VertexBuffer.NormalKind)!;
    const half = wing.getTotalVertices() / 2;
    const rowSize = 9;
    let creases = 0;
    for (let span = 0; span <= 2; span += 1) {
      const top = span * rowSize + 8;                 // trailing edge, upper
      const bottom = half + span * rowSize + 8;       // trailing edge, lower
      for (let axis = 0; axis < 3; axis += 1) {
        expect(positions[top * 3 + axis]).toBeCloseTo(positions[bottom * 3 + axis]!, 6);
      }
      expect(normalAt(normals, top), "a trailing edge was welded smooth")
        .not.toEqual(normalAt(normals, bottom));
      creases += 1;
    }
    expect(creases).toBe(3);
  });

  it("needs no weld on the blur disc, whose seam normals already agree", () => {
    // THE OTHER BUILDERS THAT CLOSE A RING, and why only `loft()` is fixed:
    //
    //   planform / verticalProfile  `appendExtrudedIndices` wraps its outline
    //                               with `% count`. No duplicate vertices at
    //                               all, so no seam.
    //   airfoilWing                 duplicates at the leading and trailing
    //                               edges, DELIBERATELY — asserted above to
    //                               still differ.
    //   conformedPanels             the rim is meant to be sharp and shares no
    //                               position between its faces.
    //   box/cylinder/sphere/torus/strutBetween
    //                               Babylon's own builders write their own
    //                               normals; `vertexMesh` never sees them.
    //   radialBlurDisc              duplicates exactly as `loft` does — and is
    //                               the case below.
    //
    // The disc is flat in the Y/Z plane, so every normal is +/-X and the two
    // seam vertices already hold the same one. Welding it would change
    // nothing, which is worth measuring rather than assuming: if the disc ever
    // stops being flat this test says so and the weld list needs revisiting.
    const { build, root } = context();
    const material = build.material("disc-probe", 0xffffff, { roughness: 1, metallic: 0 });
    const disc = build.radialBlurDisc("disc-probe-mesh", 1.2, 24, material, root);
    const normals = disc.getVerticesData(VertexBuffer.NormalKind)!;
    const ring = 25;
    let checked = 0;
    // From ring 1 out. Ring 0 is the disc's CENTRE — all twenty-five of its
    // vertices sit on the axis at the same point, the triangles touching them
    // have zero area, and `ComputeNormals` writes one of them (0, 0, 0) and
    // its twin (-1, 0, 0). That pair disagrees, but it is a degenerate point
    // ring whose normals are undefined rather than wrong, and nothing shades
    // from them. Asserted here so the exception is recorded rather than
    // silently skipped.
    for (let index = 1; index < disc.getTotalVertices() / ring; index += 1) {
      expect(normalAt(normals, index * ring), `blur disc ring ${index} seam`)
        .toEqual(normalAt(normals, index * ring + 24));
      checked += 1;
    }
    expect(checked, "no rings with area were checked").toBe(4);
    const centre = normalAt(normals, 0);
    expect(Math.hypot(...centre), "the centre ring stopped being degenerate")
      .toBeLessThan(1e-9);
  });

  it("moves no vertex of any airframe: positions and indices are bit-identical", () => {
    // Pinned SEPARATELY from normals and from the draw-budget census, which
    // does fold normals in. If one of these four moves, the change was not a
    // shading change.
    // These four were computed on 192ec3b, BEFORE the weld, and again after
    // it. They are the same four values; that is the claim, not just the pin.
    const pinned: Readonly<Record<AircraftKind, string>> = {
      // RE-PINNED for the trainer and the Global by the cockpit work (jazonshou/cockpit-view),
      // which replaced their cockpit meshes: the old panel, gauges and needles are gone and
      // cockpit-only meshes (metadata.cockpitOnly) stand in their place. The claim above still
      // holds and was checked mesh by mesh against House-Keeping's own source (positions AND
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
trainer: "11e1459d",
      // Re-pinned when the F-16 gained its airbrake shelves and its four
      // petals were rebuilt to lie on them. A DELIBERATE geometry change on
      // one airframe, merged alongside the cockpit work's trainer and Global
      // re-pins above; the 747 is untouched by both.
      jet: "b0eb20d5",
      bizjet: "7b2e0a8d",
      airliner: "66da006d",
    };
    for (const kind of AIRCRAFT_KINDS) {
      const engine = new NullEngine();
      const scene = new Scene(engine);
      scene.useRightHandedSystem = true;
      const visual = createWebGpuAircraft(scene, kind);
      fixtures.push({ engine, scene, visual });
      const meshes = scene.meshes
        .filter((mesh) => mesh.getTotalVertices() > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
      expect(meshes.length, `${kind} built no meshes`).toBeGreaterThan(0);
      const geometry: number[] = [];
      for (const mesh of meshes) {
        geometry.push(...(mesh.getVerticesData(VertexBuffer.PositionKind) ?? []));
        geometry.push(...(mesh.getIndices() ?? []));
      }
      expect(digest(geometry), `${kind} positions+indices`).toBe(pinned[kind]);
    }
  });
});
