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
    //
    // The BIZJET's has since moved once, for the cabin window panes: the
    // single instanced pane's vertices are bowed to the fuselage section, so
    // the base mesh changed shape. NOTE WHAT DID NOT MOVE IT — seating each
    // pane at its own station is carried entirely in the thin-instance
    // MATRICES, and this digest reads `getVerticesData(PositionKind)` and
    // `getIndices()` only. Instance matrices are not in it, so half of that
    // change is invisible here by construction.
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
      // RE-PINNED YET AGAIN for the trainer and the Global by the drawn-faces fix (jazonshou/cockpit-747):
      // the attitude ball's two halves are `solidPlate`s now, three vertices of their own to a triangle
      // (50 vertices become 288 = 3 x 96 triangles) with flat normals and a winding decided by geometry,
      // so the GPU draws the face the pilot faces and the 2 mm rim. Checked mesh by mesh against e87d9da
      // (unique positions, triangle count, total area, world matrix, material, then positions AND
      // indices): only the halves moved, and each has the same 50 unique positions, the same 96
      // triangles and the same area to 1e-17. The trainer's other 68 of 70 meshes, the Global's other
      // 97 of 99 and all 78 of the jet's are bit-identical, which is why the jet's pin below stays.
      // RE-PINNED for the trainer by the windscreen centre frame's TAPERED TIP (jazonshou/cockpit-post-bury):
      // `windscreen-center-frame` was a cylinder whose top end disc stopped in open air and read as a lit
      // octagon from the pilot's seat (48% of the rays over its own window on the player rig, 51% on the perf
      // rig). It is now the same bar with a cone over its last 0.05 m, collapsing to a true apex, so there is
      // no disc to see: 38 -> 76 vertices, 32 -> 64 triangles, area 0.0566 -> 0.0546 m^2, same foot, axis,
      // radius and material. Checked mesh by mesh against 003318a: it is the ONLY exterior mesh that moves,
      // the trainer's other 50 exterior meshes and all 19 cockpit-only ones are bit-identical, and the jet's
      // 78, the Global's 99 and the 747's 96 do not move at all.
      // RE-PINNED for the trainer when the centre frame stopped ending in the air at EITHER end
      // (jazonshou/cockpit-cessna-junction): its top turns aft at a ball joint and runs over the glass
      // crown into the cabin roof's slab, and its foot runs on 0.09 m past the design foot down under
      // the cowl deck it used to float above. Checked mesh by mesh against ea63db1, positions AND
      // indices: `windscreen-center-frame` is the ONLY mesh of the trainer's 70 that differs (76 -> 307
      // vertices, 64 -> 464 triangles, most of it the ball); the other 69 are bit-identical, and so are
      // all 78 of the jet's, 96 of the Global's and 93 of the 747's.
      // AND AGAIN, after an independent review found the roof slab's edge walls inside-out (`build.planform`
      // winds them against its caps) so the frame's buried end showed through them at grazing angles: the
      // roof is `solidified` now, and the joint is a 16-segment ball 3% over the bars. Against ea63db1, TWO
      // of the trainer's 70 meshes differ: `trainer-cabin-roof` (the same 28 triangles over the same 16
      // positions, and the SAME set of position-UV pairs; only winding and flat normals changed, so 16 -> 84
      // vertices) and `windscreen-center-frame` (76 -> 779 vertices, 64 -> 1,360 triangles). The other 68,
      // and all of the jet's, the Global's and the 747's, are bit-identical.
      // RE-PINNED for the trainer when it kept THREE DIALS (jazonshou/trainer-three-dials; Jason, 2026-09-23):
      // the second row's four meshes are gone (`trainer-vertical-speed-gauge`, `trainer-engine-gauge` and their
      // needles, all cockpit-only). Checked mesh by mesh against c586870 (world positions, indices, material,
      // cockpit roles, visibility in both views): the trainer's other 66 of 70 are bit-identical, and so are
      // all 71 of the jet's, 94 of the Global's and 93 of the 747's.
      trainer: "1f9a6faa",
      // Re-pinned when the F-16 gained its airbrake shelves and its four
      // petals were rebuilt to lie on them. A DELIBERATE geometry change on
      // one airframe, merged alongside the cockpit work's trainer and Global
      // re-pins above; the 747 is untouched by both.
      // RE-PINNED for the F-16's cockpit, phase F1 (jazonshou/cockpit-jet-f1): the five dials and
      // their needles are gone (ten meshes), the tilted `jet-glare-shield` box is a wedge coaming
      // (a `solidPlate` narrowed by `sculptSolid`: 24 -> 36 vertices, 12 triangles) and the board is
      // rebuilt bare under it; ONE mesh is new, the cockpit-only `jet-hud-frame` (three struts
      // merged, 114 vertices, 96 triangles). Checked mesh by mesh against f9d2672, WORLD positions
      // AND indices (`tests/render.cockpit-jet.test.ts` pins every one): of the jet's 78 meshes the
      // other 66 are unmoved to the micrometre, 78 -> 69. The change moves no other airframe (the
      // trainer's 70, the Global's 96 and the 747's 93 meshes), which is why their pins here stay.
      // RE-PINNED for the F-16's MFDs, phase F2: two meshes added, both cockpit-only (`jet-mfd-bezels`, two
      // boxes merged; `jet-screens`, two boxes remapped into the display atlas and merged). The per-mesh gate in
      // `tests/render.cockpit-jet.test.ts` holds the other 66 unmoved.
      jet: "8b08bd05",
      // RE-PINNED for the Global's two ball halves, by the same change and on the same evidence as the trainer's above.
      // RE-PINNED for the Global when its 3D attitude ball came out (its PFD page draws attitude on
      // the screen now, as the 747's does). Checked mesh by mesh against f9d2672, positions AND
      // indices as this digest defines them: of its 99 meshes exactly three are GONE --
      // bizjet-pfd-sky and -ground (288 vertices, 96 triangles, 50 unique positions each) and
      // bizjet-pfd-pitch-bar (24, 12, 8) -- none is new, none changed, and the other 96 are
      // bit-identical. Totals 10,861 -> 10,261 vertices and 17,358 -> 17,154 triangles, which is
      // those three meshes and nothing else. The trainer keeps its ball and its pin.
      // RE-PINNED for the Global's cabin windows (phase 3a): the thin-instanced oval
      // `bizjet-cabin-window-line` (54 vertices, 144 indices, bowed on the CPU copy only --
      // the GPU drew it flat) is GONE, and `bizjet-cabin-windows` is NEW: 28 panes cast onto
      // the fuselage's own triangles and merged, 7,896 vertices and 8,512 triangles, one draw.
      // Checked mesh by mesh against 58f8b28, positions, normals, UVs, indices, world matrix,
      // material and visibility: the Global's other 95 meshes are bit-identical.
      // RE-PINNED for the Global's flight deck (phase 3b): the three glass boxes
      // (`bizjet-windscreen` and the two `*-bizjet-flight-deck-window` slabs, 24 vertices and
      // 12 triangles each) are GONE, `bizjet-flight-deck-glazing` is NEW -- six panes cast onto
      // the nose's own triangles and merged, 1,440 vertices and 1,512 triangles --
      // `bizjet-windscreen-center-post` is re-cast on the skin (a 38-vertex strut -> a 96-vertex
      // `skinPanel`), and `bizjet-radome` gains a ring at 13.2, the fuselage's last, which takes
      // out a 3.8 cm lip the windshield crosses (166 -> 207 vertices, 320 -> 400 triangles).
      // Checked mesh by mesh against 0ba7987, positions, normals, UVs, indices, world matrix,
      // material and visibility: the Global's other 91 meshes are bit-identical.
      // RE-PINNED for the Global's nose (phase 3c, part 1): widened to the type's half-widths and
      // lofted as ONE surface with the cabin. `bizjet-radome` (207 vertices, 400 triangles) is GONE,
      // its rings now the fuselage's; `bizjet-fuselage` goes from 8 rings to 18 (394 -> 884 vertices);
      // the flight-deck glazing and post re-cast onto the wider nose (counts unchanged); and
      // `bizjet-cabin-windows` moves by at most 0.16 mm, the first windows' normals interpolating the
      // 9.5 ring's, which average the new span forward of it. Checked mesh by mesh against d52ccc2,
      // positions, normals, UVs, indices, world matrix, material and visibility: the other 89 meshes
      // are bit-identical, and so is every fuselage vertex to 9.5 m (render.bizjet-nose).
      // RE-PINNED for the Global's nose, phase 3c part 2: the crown lowered ahead of the flight deck
      // (0.45 of the camera-solved drop, the keel and the widths held) and two rings added at 11.75
      // and 12.25 for the brow: `bizjet-fuselage` 884 -> 982 vertices; the flight-deck glazing and
      // post re-cast onto it (counts unchanged); `bizjet-cabin-windows` moves within render.bizjet-nose's
      // 0.2 mm (the 9.5 ring's normals average the span forward of it). Checked mesh by mesh against
      // c252859: the other 89 meshes are bit-identical.
      // RE-PINNED for the Global's crew seats (phase 3c, part 2): placed from catalogue.cockpitEye
      // (bizjetSeats.ts), the cushion 0.80 m under the eye. The two seats are rebuilt from the floor to
      // the cushion, the headrests move, and two seat backs are NEW (24 vertices each). Checked mesh by
      // mesh against b23d9a0: the other 89 meshes are bit-identical.
      // RE-PINNED for the Global's nose, phase 3c part 3: the crown to 0.9 of the camera fit and the tip
      // drooped to the gold line (-0.45), the keel drooping with it forward of 1.8 m aft; ring counts
      // unchanged. The flight-deck glazing and post re-cast onto it, `bizjet-cabin-windows` moves within
      // render.bizjet-nose's 0.2 mm. Checked mesh by mesh against 99ab242: the other 91 meshes, the
      // seats among them, are bit-identical.
      // RE-PINNED for the Global's nose, phase 3c part 4 (d): the crown under a filleted brow, 0.735 at
      // the post's head, and straight from the post's foot to a tip dropped to -0.55; `bizjet-fuselage`
      // 20 rings -> 28 (982 -> 1374 vertices). The flight-deck glazing and post re-cast onto it (counts
      // unchanged), `bizjet-cabin-windows` moves within render.bizjet-nose's 0.2 mm. Checked mesh by mesh
      // against 3d6d97c: the other 91 meshes are bit-identical.
      // RE-PINNED for the Global's nose, phase 3c part 5: the crown on the p. 29 render's corrected
      // silhouette (the sky edge), under it at the foot for the aim point on final and up to 0.09 over
      // it at the brow; ring count unchanged. The flight-deck glazing and post re-cast onto it,
      // `bizjet-cabin-windows` moves within render.bizjet-nose's 0.2 mm. Checked mesh by mesh against
      // 3da1899: the other 91 meshes are bit-identical.
      // RE-PINNED for the Global's cockpit kit, re-solved on the six-pane band (jazonshou/cockpit-bizjet-kit2):
      // the window frame is a lining cast from R onto the skin round the panes, with a sill cap along the side
      // panes' bottom edges, merged with the panel board as `bizjet-cockpit-interior` (NEW, 4816 vertices); the
      // old board, both windscreen posts, the overhead and the side walls are GONE; the lip
      // (`bizjet-glareshield`), the screens and the bezels move to the new eye and deck line (10.88); and the six
      // seat meshes follow the eye to 0.55 (bizjetSeats.ts). Checked mesh by mesh against eeb1606 (positions,
      // normals, UVs, indices, world matrix, material, visibility): the other 81 meshes are bit-identical.
      // RE-PINNED for the Global's nose section, phase 3c part 6: over the windshield the fuselage's upper
      // half is a V of flat panes (`crownSquareness` 1.26-1.47, back to the ellipse by 2.75 m aft), fitted
      // with the crown to both brochure renders; ring count unchanged. `bizjet-fuselage`, the flight-deck
      // glazing and `bizjet-cabin-windows` (within render.bizjet-nose's 0.2 mm) move; the centre post
      // gains a third column on the V's ridge (96 -> 120 vertices); and `bizjet-cockpit-interior`, whose
      // lining is cast along the panes' edges, re-samples (4816 -> 4964 vertices; the kit's own tests
      // re-pin on the cockpit engineer's commit). Checked mesh by mesh against 6638484: the Global's other
      // 86 meshes, and every mesh of the trainer, the jet and the 747, are bit-identical.
      // RE-PINNED for part 6b: the V's crown and waterline filleted (0.15 m) and its upper half sampled by
      // the normal's angle, the rings either side resampled the same way; ring count unchanged.
      // `bizjet-fuselage`, the flight-deck glazing, the post and `bizjet-cockpit-interior`'s lining move
      // (counts unchanged). Checked mesh by mesh against 49916b4: the Global's other 87 meshes, and every
      // mesh of the trainer, the jet and the 747, are bit-identical.
      // RE-PINNED for the Global's kit on part 6b (jazonshou/global-nose-repin): the lining's post and the centre
      // sill and crown take the V's ridge as a column, as the glass post does (`bizjet-cockpit-interior` 4964 -> 5046
      // vertices), and the lip and the board end 5 cm inside the shell as built, 1.3 cm inboard of the pillars' feet
      // (`bizjet-glareshield` narrower, its triangles unchanged); the deck line stays 10.88 and hides the V's low
      // outboard corner by a pinned profile. Checked mesh by mesh against cc16f33 (positions, normals, UVs, indices,
      // world matrix, material, visibility): the other 89 meshes are bit-identical.
      // RE-PINNED for the Global's panel integration, P1a (jazonshou/cockpit-panel-integration): the board's face leans
      // back 15 degrees under a glareshield that is one solid with a rounded aft edge on the deck line, a 45 degree cove
      // under it and a 12 degree hood (`bizjet-glareshield` 8 -> 52 triangles), and the four screens and bezels ride the
      // leaned face; `bizjet-cockpit-interior` keeps its 4816 vertices (the board is still a box, turned). Checked mesh
      // by mesh against 6638484 (positions, normals, UVs, indices, world matrix, material, visibility): the other 87
      // meshes are bit-identical.
      // RE-PINNED for P1b, the Global's bezels: each a frame round its screen on a bezel material of its own
      // (`bizjet-screen-bezels` 48 -> 128 triangles) with a 4 mm 45 degree chamfered rim on the marking material (NEW,
      // `bizjet-screen-bezel-rims`, 128), the screens recessed 3 mm behind the frames' fronts as 0.5 mm plates, and a
      // dark well behind each 2 mm gap (NEW, `bizjet-screen-wells`, 48). Checked mesh by mesh against 92ef8e9
      // (positions, normals, UVs, indices, world matrix, material, visibility): the other 89 meshes are bit-identical.
      // RE-PINNED for P1a and P1b carried onto 7766139 (the V nose merged), with the hood TAPERED in plan to the V's shell
      // (the deck at the pillars' feet as cast, 0.789; the hood's forward end 0.745). Checked mesh by mesh against
      // 7766139: the board (in `bizjet-cockpit-interior`), `bizjet-glareshield`, the screens and the bezels' frames change,
      // the rims and the wells are new; the other 87 meshes are bit-identical.
      // RE-PINNED for P1c, the Global's side consoles (NEW, `bizjet-side-consoles`: the sill caps widened into consoles'
      // tops, flush with the board's ends, a 2 cm lip over a 45 degree cove, down to the board's foot). Checked mesh by mesh
      // against 43d360d: nothing else changes (the other 93 meshes are bit-identical).
      bizjet: "0d9b6dba",
      // RE-PINNED for the 747 by its cockpit (jazonshou/cockpit-747): the old panel, gauge
      // faces and needle meshes are gone, the seats and headrests moved forward with the
      // pilot, and eight cockpit-only meshes stand in their place. Checked mesh by mesh
      // against e87d9da, positions AND indices: the 747's other 88 of 91 meshes are
      // bit-identical, and so is the jet's whole 78 (the trainer's and the Global's differ by their
      // ball's halves alone, see their pins). The kit's plates (overhead, dash, pillar) and the ball's
      // halves are `solidPlate`s, built so the GPU draws them (tests/render.cockpit-drawn-faces.test.ts):
      // the meshes that hold one keep the unique positions, triangle count and area of the plain
      // extrusion, and only the plates' vertices went from shared to three to a triangle. The pillar and
      // the seam post are merged into the interior mesh (there is no windscreen-frame mesh), and the post's
      // mesh runs 0.08 m past its design top into the overhead (AIRLINER_POST.buryMetres).
      // RE-PINNED for the 747 when its 3D attitude ball came out (the PFD page draws attitude on the
      // screen now). Checked mesh by mesh against e27a030, positions AND indices: of its 96 meshes,
      // exactly three are GONE -- airliner-pfd-sky and -ground (288 vertices, 96 triangles, 50 unique
      // positions each) and airliner-pfd-pitch-bar (24, 12, 8) -- none is new, none moved, and the
      // other 93 are bit-identical. Totals 11,163 -> 10,563 vertices and 17,208 -> 17,004 triangles,
      // which is those three meshes and nothing else. The trainer's, the jet's and the Global's pins
      // are untouched by this step, and the Global still carries its own ball.
      // RE-PINNED for the nose re-loft (docs/findings/AIRLINER_NOSE_GLAZING.md). Checked mesh by mesh
      // against House-Keeping 500b80a, positions AND indices: of 93 meshes, exactly three differ.
      // airliner-fuselage-shell (613 vertices, 1,176 triangles, both unchanged) is the radome's 31.4
      // ring raised into the brow. airliner-flight-deck-glazing goes 144 -> 1,440 vertices and 72 ->
      // 1,512 triangles, six boxes become six 8 x 8 skin panels. airliner-windscreen-center-post goes
      // 38 -> 96 and 32 -> 60, a strut becomes a 2 x 8 skin strip. The other 90 are bit-identical, and
      // the other three airframes' pins are untouched.
      // RE-PINNED for the fuselage/radome join. Checked mesh by mesh against 1849fd8: of 93
      // meshes, exactly two differ. airliner-fuselage-shell goes 613 -> 729 vertices and
      // 1,176 -> 1,400 triangles: the fuselage's four extra rings, its reshaped 28 ring and
      // the nose's. airliner-flight-deck-glazing keeps its counts and moves only in the No.3
      // panes' aft third (x 30.21..30.40), by at most 2.7 mm: the nose's shading normals at
      // its 29.2 ring average in the reshaped segment behind it, and the glass is laid along
      // them. The other 91 are bit-identical, the centre post included.
      // RE-PINNED for the cockpit kit cast round the re-lofted glass, and the eye moved to (29.85, 2.93,
      // -0.50). Checked mesh by mesh against a480804, positions AND indices: of 93 meshes, none gone, none
      // new, exactly five differ, all the flight deck's. airliner-cockpit-interior goes 158 -> 2,716 vertices
      // and 76 -> 2,468 triangles (the board and the whole window frame's lining, sills, crowns, pillars and
      // post gaps, where the overhead, the pillar and the seam post were); airliner-glareshield 60 -> 24 and
      // 24 -> 8 (the lip alone, where the hood and the dash were); airliner-screens and
      // airliner-screen-bezels keep their counts and move to the new panel; and
      // airliner-flight-deck-interior keeps its counts, its seats moving under the new eye. The other 88
      // are bit-identical: the shell, the glazing and the centre post included.
      // RE-PINNED for the 747's centre member (jazonshou/747-centre-gap): the No.1 panes start at
      // az 1.6 (CENTRE_POST_HALF_AZIMUTH) where they started at 2.5, and the post widens from +-1 to
      // +-1.6 to fill the gap. Checked mesh by mesh against 58f8b28: three of 93 meshes moved and no
      // count did -- the flight-deck glazing, the centre post, and the cockpit interior, whose lining
      // reads the pane spec -- and the other 90 are bit-identical.
      // RE-PINNED when the member settled at 1.9 (the cockpit engineer's reading from the eye on the kit's
      // lining, 3.67 degrees against the type's 3.6): the same three meshes moved, no count did, and the
      // other 90 are bit-identical against 1a0ec56.
      // RE-PINNED for K3 (the lining thinned to 0.02 m, the lip re-solved to -18.57, the kit lining the post's place
      // where the gap strips were): checked mesh by mesh against 4251e15, none gone, none new, exactly four moved,
      // the kit's own: airliner-cockpit-interior 2,716 -> 2,556 vertices and 2,468 -> 2,328 triangles (the thinner
      // lining, the post's strip for the two gap strips, the board's top), airliner-glareshield (the lip, lower),
      // airliner-screens and airliner-screen-bezels (hung from it). The other 89 are bit-identical, the plane
      // engineer's post included.
      // RE-PINNED for the 747's panel integration, P1a (jazonshou/cockpit-panel-747): the glareshield a rounded deck on the
      // deck line (8 -> 48 triangles), the board, the screens and the bezels leaned back 17 degrees. Checked mesh by mesh
      // against c586870 (positions, normals, UVs, indices, world matrix, material, visibility): airliner-glareshield,
      // airliner-cockpit-interior (the board), airliner-screens and airliner-screen-bezels changed; the other 89 are
      // bit-identical.
      // RE-PINNED for P1b on the 747, the framed, recessed screens (`framedScreenFacets`, the Global's, moved into
      // cockpitPrimitives): each bezel's box a frame on the 747's own bezel material (`airliner-screen-bezels` 72 ->
      // 192 triangles) with a 4 mm 45 degree chamfered rim on the marking (NEW, `airliner-screen-bezel-rims`, 192), the
      // screens 0.5 mm plates recessed 3 mm behind the frames' fronts, and a dark well behind each 2 mm gap (NEW,
      // `airliner-screen-wells`, 72). Checked mesh by mesh against 2432e58: none gone, those two new, airliner-screens
      // and airliner-screen-bezels changed; the other 91 are bit-identical. The Global's 94 are bit-identical against
      // c586870 after the move.
      // RE-PINNED for the spoiler bays (the dark well a raised spoiler uncovers): checked mesh by mesh against
      // 55679ba, none gone and none moved, one new: airliner-spoiler-bays, 360 vertices (twelve plates on the
      // wing's skin, folded into one). The other 95 are bit-identical, the kit's included; so is every mesh of the
      // Global, whose spoilers changed only in how they are posed.
      // RE-PINNED for the nose polish (2026-09-23): checked mesh by mesh against ae8ca49, none gone, none new, four
      // moved. airliner-fuselage-shell 729 -> 1,686 vertices (the fuselage's 27.2 and 28 rings now fifteen blend rings,
      // the nose 8 rings to 28 and a pole). airliner-flight-deck-glazing (0.42 mm at most), airliner-cockpit-interior
      // (the kit's lining, 7.7 mm at most, at x 33.43 on the new tip) and airliner-windscreen-center-post (0.26 mm) keep
      // their counts and move because all three are CAST from R onto the skin and stand off it along its shading
      // normals, which the new rings either side of the nose's 29.2 and 33.4 rings turn; the skin under the glass did
      // not move. The other 92, and every mesh of the Global, are bit-identical.
      airliner: "8dc7d09c",
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
