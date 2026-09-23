import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { aircraftSpec } from "../src/aircraft/catalogue";
import { createWebGpuAircraft, type AircraftVisual } from "../src/render/webgpu/aircraft";
import {
  PANE_GRID,
  SkinCaster,
  paneGrid,
  sightline,
  type Point3,
  type SkinTriangles,
} from "../src/render/webgpu/aircraft/airlinerGlazing";
import {
  GLOBAL_CENTRE_POST,
  GLOBAL_FLIGHT_DECK_OUTLINES,
  GLOBAL_FLIGHT_DECK_REFERENCE as R,
  GLOBAL_NOSE_TIP_X,
  GLOBAL_PANE_DEPTH,
  GLOBAL_PANE_PROUD,
  globalCentrePostPane,
  globalGlazingPane,
  globalSkinSectionAt,
  outlinePoint,
  type GlobalPaneOutline,
} from "../src/render/webgpu/aircraft/bizjetGlazing";
import { AircraftBuildContext, type LoftSection } from "../src/render/webgpu/aircraft/builders";

/**
 * The Global's flight-deck glass, as BUILT: the type's six panes, laid out on
 * the body from the brochure's top view and cast from R onto the nose's own
 * triangles, and the centre post between the windshields.
 * docs/findings/GLOBAL_LIVERY.md ("Phase 3b") has the outline and the corner
 * table (`scripts/airliner-glazing-table.mts --airframe bizjet`).
 *
 * The panes are captured as `skinPanel` returns them, before the merge folds
 * them into `bizjet-flight-deck-glazing`, and the first test proves the merged
 * mesh holds exactly those vertices, so everything after is about the glass
 * that is drawn.
 */

interface Panel { name: string; rows: number; columns: number; positions: number[]; indices: number[] }

const DEG = 180 / Math.PI;
const eye = aircraftSpec("bizjet").cockpitEye;
/** The left-seat eye: where the cockpit looks through the glass from. */
const E: Point3 = { x: eye.forward, y: eye.up, z: eye.right };
let engine: NullEngine;
let scene: Scene;
let visual: AircraftVisual;
const panels: Panel[] = [];
let caster: SkinCaster;

const soup = (mesh: Mesh): SkinTriangles => ({
  positions: mesh.getVerticesData(VertexBuffer.PositionKind)!,
  indices: mesh.getIndices()!,
  normals: mesh.getVerticesData(VertexBuffer.NormalKind)!,
});

beforeAll(() => {
  const original = AircraftBuildContext.prototype.skinPanel;
  const spy = vi.spyOn(AircraftBuildContext.prototype, "skinPanel").mockImplementation(
    function (this: AircraftBuildContext, ...args: Parameters<typeof original>) {
      const mesh = original.apply(this, args);
      // The flight deck's glass and post only: the cabin row is `render.bizjet-cabin-windows`'s.
      if (!/bizjet-flight-deck-window|bizjet-windscreen-center-post/.test(args[0])) return mesh;
      panels.push({
        name: args[0],
        rows: args[1].length,
        columns: args[1][0]!.length,
        positions: Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!),
        indices: Array.from(mesh.getIndices()!),
      });
      return mesh;
    },
  );
  engine = new NullEngine();
  scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  visual = createWebGpuAircraft(scene, "bizjet");
  spy.mockRestore();
  const skin = ["bizjet-fuselage"].map((name) => scene.getMeshByName(name) as Mesh);
  for (const mesh of skin) expect(mesh.getWorldMatrix().isIdentity(), `${mesh.name}'s vertices are not body metres`).toBe(true);
  caster = new SkinCaster(skin.map(soup));
});

afterAll(() => {
  visual.dispose();
  scene.dispose();
  engine.dispose();
});

const pane = (side: "port" | "starboard", name: string): Panel => {
  const found = panels.find((p) => p.name === `${side}-bizjet-flight-deck-window-${name}`);
  if (!found) throw new Error(`no ${side} pane ${name}`);
  return found;
};
const post = (): Panel => panels.find((p) => p.name === "bizjet-windscreen-center-post")!;
/** Face 0 is the outer face, 1 the inner, each `rows x columns` in grid order; the rim follows. */
const vertex = (panel: Panel, face: 0 | 1, row: number, column: number): Point3 => {
  const i = (face * panel.rows * panel.columns + row * panel.columns + column) * 3;
  return { x: panel.positions[i]!, y: panel.positions[i + 1]!, z: panel.positions[i + 2]! };
};
const sub = (a: Point3, b: Point3): Point3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Point3, b: Point3, scale = 1): Point3 => ({ x: a.x + b.x * scale, y: a.y + b.y * scale, z: a.z + b.z * scale });
const dot = (a: Point3, b: Point3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Point3, b: Point3): Point3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const unit = (a: Point3): Point3 => { const l = Math.hypot(a.x, a.y, a.z); return { x: a.x / l, y: a.y / l, z: a.z / l }; };
const mean = (...ps: Point3[]): Point3 => ({
  x: ps.reduce((s, p) => s + p.x, 0) / ps.length,
  y: ps.reduce((s, p) => s + p.y, 0) / ps.length,
  z: ps.reduce((s, p) => s + p.z, 0) / ps.length,
});
/** Where a point is on the body: metres aft of the nose tip, and degrees round its station's section from the crown. */
const onBody = (point: Point3): { aft: number; angle: number } => {
  const section = globalSkinSectionAt(point.x);
  return {
    aft: GLOBAL_NOSE_TIP_X - point.x,
    angle: Math.atan2(Math.abs(point.z) / section.zRadius, (point.y - section.yOffset) / section.yRadius) * DEG,
  };
};

/** The nearest triangle of `panel` along a ray, as the cross product of its first two edges. */
function nearestFace(panel: Panel, origin: Point3, direction: Point3): Point3 | null {
  let best: { distance: number; face: Point3 } | null = null;
  const p = (index: number): Point3 => ({
    x: panel.positions[index * 3]!, y: panel.positions[index * 3 + 1]!, z: panel.positions[index * 3 + 2]!,
  });
  for (let t = 0; t < panel.indices.length; t += 3) {
    const a = p(panel.indices[t]!);
    const e1 = sub(p(panel.indices[t + 1]!), a);
    const e2 = sub(p(panel.indices[t + 2]!), a);
    const q = cross(direction, e2);
    const det = dot(e1, q);
    if (Math.abs(det) < 1e-12) continue;
    const s = sub(origin, a);
    const u = dot(s, q) / det;
    if (u < 0 || u > 1) continue;
    const r = cross(s, e1);
    const v = dot(direction, r) / det;
    if (v < 0 || u + v > 1) continue;
    const distance = dot(e2, r) / det;
    if (distance > 1e-6 && (!best || distance < best.distance)) best = { distance, face: cross(e1, e2) };
  }
  return best?.face ?? null;
}

/** The outer face's least clearance outside the skin, and the inner face's least inside it, at every cell centre. */
function clearances(of: readonly Panel[], skin: SkinCaster): { outer: number; inner: number } {
  let outer = Infinity;
  let inner = -Infinity;
  for (const panel of of) {
    for (const face of [0, 1] as const) {
      for (let row = 0; row < panel.rows - 1; row += 1) {
        for (let column = 0; column < panel.columns - 1; column += 1) {
          const centre = mean(vertex(panel, face, row, column), vertex(panel, face, row, column + 1),
            vertex(panel, face, row + 1, column), vertex(panel, face, row + 1, column + 1));
          const range = Math.hypot(centre.x - R.x, centre.y - R.y, centre.z - R.z);
          const direction = unit(sub(centre, R));
          const hit = skin.exit(R, direction)!;
          const clearance = (range - hit.distance) * dot(direction, hit.normal);
          if (face === 0) outer = Math.min(outer, clearance);
          else inner = Math.max(inner, clearance);
        }
      }
    }
  }
  return { outer, inner };
}

/** The worst gap, in station and in angle, between a cast grid and the outline it was cast from. */
function outlineError(grid: { points: readonly (readonly Point3[])[] }, outline: GlobalPaneOutline) {
  let aft = 0;
  let angle = 0;
  for (let row = 0; row < PANE_GRID; row += 1) {
    for (let column = 0; column < PANE_GRID; column += 1) {
      const [wantAft, wantAngle] = outlinePoint(outline, column / (PANE_GRID - 1), row / (PANE_GRID - 1));
      const got = onBody(grid.points[row]![column]!);
      aft = Math.max(aft, Math.abs(got.aft - wantAft));
      angle = Math.max(angle, Math.abs(got.angle - wantAngle));
    }
  }
  return { aft, angle };
}

describe("the Global's flight-deck glass", () => {
  it("is six panes and a post, the merged glazing holds every pane vertex and nothing else, and the boxes are gone", () => {
    expect(panels.map((p) => p.name).sort()).toEqual([
      "bizjet-windscreen-center-post",
      ...["port", "starboard"].flatMap((side) =>
        ["aft-side", "forward-side", "windshield"].map((n) => `${side}-bizjet-flight-deck-window-${n}`)),
    ].sort());
    const merged = (scene.getMeshByName("bizjet-flight-deck-glazing") as Mesh).getVerticesData(VertexBuffer.PositionKind)!;
    const keys = new Set<string>();
    for (let i = 0; i < merged.length; i += 3) keys.add(`${merged[i]!.toFixed(6)},${merged[i + 1]!.toFixed(6)},${merged[i + 2]!.toFixed(6)}`);
    const panes = panels.filter((p) => p.name.includes("flight-deck-window"));
    expect(merged.length / 3, "the merged glazing holds something besides the six panes")
      .toBe(panes.reduce((s, p) => s + p.positions.length / 3, 0));
    for (const p of panes) {
      for (let i = 0; i < p.positions.length; i += 3) {
        expect(keys.has(`${p.positions[i]!.toFixed(6)},${p.positions[i + 1]!.toFixed(6)},${p.positions[i + 2]!.toFixed(6)}`), p.name).toBe(true);
      }
    }
    for (const gone of ["bizjet-windscreen", "port-bizjet-flight-deck-window", "starboard-bizjet-flight-deck-window"]) {
      expect(scene.getMeshByName(gone), gone).toBeNull();
    }
  });

  it("puts every outer-face grid point GLOBAL_PANE_PROUD out from the skin, on the sightline from R through the outline", () => {
    for (const side of [1, -1] as const) {
      for (const outline of GLOBAL_FLIGHT_DECK_OUTLINES) {
        const spec = globalGlazingPane(outline);
        const built = pane(side > 0 ? "starboard" : "port", outline.name);
        const grid = paneGrid(caster, spec, side, PANE_GRID, R);
        for (let row = 0; row < PANE_GRID; row += 1) {
          for (let column = 0; column < PANE_GRID; column += 1) {
            const skin = grid.points[row]![column]!;
            const [azimuth, elevation] = spec.at!(column / (PANE_GRID - 1), row / (PANE_GRID - 1));
            const off = cross(unit(sub(skin, R)), sightline(azimuth, elevation, side));
            expect(Math.asin(Math.min(1, Math.hypot(off.x, off.y, off.z))) * DEG).toBeLessThan(1e-6);
            const expected = add(skin, grid.normals[row]![column]!, GLOBAL_PANE_PROUD);
            const outer = vertex(built, 0, row, column);
            expect(Math.hypot(outer.x - expected.x, outer.y - expected.y, outer.z - expected.z)).toBeLessThan(1e-5);
          }
        }
      }
    }
    const grid = paneGrid(caster, globalCentrePostPane(), 1, 2, R);
    for (let row = 0; row < PANE_GRID; row += 1) {
      for (let column = 0; column < 2; column += 1) {
        const expected = add(grid.points[row]![column]!, grid.normals[row]![column]!, GLOBAL_PANE_PROUD);
        const outer = vertex(post(), 0, row, column);
        expect(Math.hypot(outer.x - expected.x, outer.y - expected.y, outer.z - expected.z)).toBeLessThan(1e-5);
      }
    }
  });

  it("lands every grid point at the type's station and angle round the section, and the instrument reads a moved pane", () => {
    let aft = 0;
    let angle = 0;
    for (const side of [1, -1] as const) {
      for (const outline of GLOBAL_FLIGHT_DECK_OUTLINES) {
        const error = outlineError(paneGrid(caster, globalGlazingPane(outline), side, PANE_GRID, R), outline);
        aft = Math.max(aft, error.aft);
        angle = Math.max(angle, error.angle);
      }
    }
    // The outline is a point on the loft's smooth section; the cast lands on the facet under it,
    // up to 2 mm inside at 48 segments round, which moves it along the sightline, and the
    // steeper the skin to the sightline the further. Measured 18.2 mm and 0.28 degrees at worst on
    // part 3's nose (10.8 and 0.15 on part 2's, 5.0 and 0.13 on part 1's, 5.7 and 0.11 before 3c).
    expect(aft).toBeLessThan(0.025);
    expect(angle).toBeLessThan(0.5);

    // CONTROL: the windshield cast from an outline 0.1 m further aft and 5 degrees further round
    // reads as exactly that against the outline it was not cast from.
    const windshield = GLOBAL_FLIGHT_DECK_OUTLINES[0]!;
    const moved: GlobalPaneOutline = {
      ...windshield,
      bottom: windshield.bottom.map(([a, t]) => [a + 0.1, t + 5] as const),
      top: windshield.top.map(([a, t]) => [a + 0.1, t + 5] as const),
    };
    const misplaced = outlineError(paneGrid(caster, globalGlazingPane(moved), 1, PANE_GRID, R), windshield);
    expect(misplaced.aft).toBeGreaterThan(0.095);
    expect(misplaced.angle).toBeGreaterThan(4.5);
  });

  it("keeps the outer face outside the skin and the inner face inside it, at every cell centre", () => {
    // Along the skin's normal, from a ray cast from R through each cell's centre. The design is
    // 12 mm out and 30 mm in; the chords between grid points cross the nose's facet creases.
    // Measured 7.0 mm out and 19.4 mm in at worst on part 4 (d)'s nose, whose brow and face are
    // filleted for this (with the brow a single knee: 0.4 mm INSIDE); 6.2 and 19.8 on part 3's, 6.6
    // and 19.5 on part 2's, 7.5 and 29.4 on part 1's, 4.5 and 19.6 before phase 3c.
    const { outer, inner } = clearances(panels, caster);
    expect(outer).toBeGreaterThan(0.003);
    expect(inner).toBeLessThan(-0.015);

    // CONTROL, and one reason the nose is one loft: the nose as it was before phase 3b, a
    // fuselage ending on a cap at 13.2 and a radome running from its own 13.1 ring, 3.8 cm inside
    // the fuselage's end at the crown. The windshield crosses 13.2, and cast onto that skin its
    // outer face goes UNDER the lip. The two tables are that build's, literally.
    const engine = new NullEngine();
    const scene2 = new Scene(engine);
    const fuselageBefore: LoftSection[] = [
      { x: 4.5, yRadius: 1.345, zRadius: 1.345 },
      { x: 9.5, yRadius: 1.335, zRadius: 1.32 },
      { x: 11.6, yRadius: 1.25, zRadius: 1.19, yOffset: 0.06 },
      { x: 13.2, yRadius: 0.9, zRadius: 0.88, yOffset: -0.02 },
    ];
    const radomeBefore: LoftSection[] = [
      { x: 13.1, yRadius: 0.9, zRadius: 0.88, yOffset: -0.02 },
      { x: 14.1, yRadius: 0.62, zRadius: 0.62, yOffset: -0.12 },
      { x: 14.7, yRadius: 0.34, zRadius: 0.34, yOffset: -0.15 },
      { x: 15, yRadius: 0.1, zRadius: 0.1, yOffset: -0.15 },
    ];
    const lofts = new AircraftBuildContext(scene2);
    const withLip = new SkinCaster([
      soup(lofts.loft("old-fuselage", fuselageBefore, 48, new StandardMaterial("f", scene2), new TransformNode("f", scene2))),
      soup(lofts.loft("old-radome", radomeBefore, 40, new StandardMaterial("r", scene2), new TransformNode("r", scene2))),
    ]);
    const build2 = new AircraftBuildContext(scene2);
    const oldPanels = ([
      ["old-starboard-windshield", globalGlazingPane(GLOBAL_FLIGHT_DECK_OUTLINES[0]!), PANE_GRID, 1],
      ["old-port-windshield", globalGlazingPane(GLOBAL_FLIGHT_DECK_OUTLINES[0]!), PANE_GRID, -1],
      ["old-post", globalCentrePostPane(), 2, 1],
    ] as const).map(([name, spec, columns, side]) => {
      const grid = paneGrid(withLip, spec, side, columns, R);
      const mesh = build2.skinPanel(name, grid.points, grid.normals, GLOBAL_PANE_PROUD, GLOBAL_PANE_DEPTH,
        new StandardMaterial(name, scene2), new TransformNode(name, scene2));
      return {
        name, rows: PANE_GRID, columns,
        positions: Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!),
        indices: Array.from(mesh.getIndices()!),
      };
    });
    // Measured 174 mm under. The control aims its sightlines through TODAY's section table, so the
    // number moves with the nose: 33 mm under on part 2's, 5.9 on part 1's, and 15.9 for the
    // glass first built on that skin, aimed through that build's own table.
    const before = clearances(oldPanels, withLip);
    expect(before.outer).toBeLessThan(-0.004);
    scene2.dispose();
    engine.dispose();
  });

  it("draws every face toward the side it is seen from: outer from outside, inner from R and the left seat, rim from beside", () => {
    // A drawn face has cross(e1, e2) pointing INTO the solid, i.e. along the ray that sees it
    // (convention measured on a build.box; tests/render.cockpit-drawn-faces.test.ts).
    const drawnFraction = (panel: Panel): { drawn: number; total: number } => {
      let drawn = 0;
      let total = 0;
      const look = (origin: Point3, target: Point3) => {
        const direction = unit(sub(target, origin));
        const face = nearestFace(panel, origin, direction);
        expect(face, `${panel.name}: the ray missed`).not.toBeNull();
        total += 1;
        if (dot(face!, direction) > 0) drawn += 1;
      };
      const skinCentre = mean(...Array.from({ length: panel.rows * panel.columns }, (_, k) =>
        mean(vertex(panel, 0, Math.floor(k / panel.columns), k % panel.columns), vertex(panel, 1, Math.floor(k / panel.columns), k % panel.columns))));
      for (let row = 0; row < panel.rows - 1; row += 1) {
        for (let column = 0; column < panel.columns - 1; column += 1) {
          // Aimed at each of the cell's two triangles (`skinPanel` splits it on the
          // (row, column + 1) -- (row + 1, column) diagonal): the quad's own centre is off both when
          // the cell is not flat, and from the seat, which is nearly level with the windshield's
          // foot, a ray at it grazes past them.
          const v = (face: 0 | 1, r: number, c: number) => vertex(panel, face, row + r, column + c);
          for (const triangle of [[[0, 0], [0, 1], [1, 0]], [[0, 1], [1, 1], [1, 0]]] as const) {
            const centroid = (face: 0 | 1) => mean(...triangle.map(([r, c]) => v(face, r, c)));
            const outward = unit(sub(centroid(0), centroid(1)));
            look(add(centroid(0), outward, 3), centroid(0)); // from outside, 3 m off the glass
            look(R, centroid(1)); // from the centreline reference
            look(E, centroid(1)); // from the left seat
          }
        }
      }
      // The rim: each wall quad's own four vertices follow the faces, four per boundary edge.
      const rimStart = 2 * panel.rows * panel.columns;
      for (let k = rimStart; k < panel.positions.length / 3; k += 4) {
        const corners = [0, 1, 2, 3].map((j) => ({
          x: panel.positions[(k + j) * 3]!, y: panel.positions[(k + j) * 3 + 1]!, z: panel.positions[(k + j) * 3 + 2]!,
        }));
        const centre = mean(...corners);
        const across = sub(centre, skinCentre);
        const depth = unit(sub(corners[0]!, corners[2]!));
        const outward = unit(sub(across, { x: depth.x * dot(across, depth), y: depth.y * dot(across, depth), z: depth.z * dot(across, depth) }));
        look(add(centre, outward, 0.02), centre);
      }
      return { drawn, total };
    };
    for (const panel of panels) {
      const { drawn, total } = drawnFraction(panel);
      expect(drawn, `${panel.name}: ${total - drawn} of ${total} faces seen from their own side are culled`).toBe(total);
    }
    // CONTROL: the same pane wound the other way round is culled from every side.
    const reversed = { ...panels[0]!, indices: panels[0]!.indices.map((_, i, all) => all[i - (i % 3) + [0, 2, 1][i % 3]!]!) };
    expect(drawnFraction(reversed).drawn).toBe(0);
  });

  it("mirrors port onto starboard to within the skin's own triangulation, and no better", () => {
    let glass = 0;
    for (const outline of GLOBAL_FLIGHT_DECK_OUTLINES) {
      const s = pane("starboard", outline.name);
      const p = pane("port", outline.name);
      for (let i = 0; i < s.positions.length; i += 3) {
        glass = Math.max(glass, Math.abs(s.positions[i]! - p.positions[i]!),
          Math.abs(s.positions[i + 1]! - p.positions[i + 1]!), Math.abs(s.positions[i + 2]! + p.positions[i + 2]!));
      }
    }
    // WHY NOT EXACT: the loft splits every quad on the same diagonal in index order, and that
    // diagonal mirrors the other way on the port side, so the drawn skin is not symmetric. The
    // glass is cast onto the skin as drawn and follows it. The skin's own asymmetry is read
    // over the band the glass covers.
    let skin = 0;
    for (let az = 0; az <= 105; az += 5) {
      for (let el = -30; el <= 15; el += 3) {
        const s = caster.exit(R, sightline(az, el, 1))!.point;
        const p = caster.exit(R, sightline(az, el, -1))!.point;
        skin = Math.max(skin, Math.abs(s.x - p.x), Math.abs(s.y - p.y), Math.abs(s.z + p.z));
      }
    }
    // The skin is sampled over the band the glass covers from R, which on part 3's lowered nose runs
    // down to el -30. Measured 7.1 mm on the glass and 7.8 on the skin (3.8 and 4.1 on part 2's
    // nose, 2.1 and 1.9 on part 1's).
    expect(skin, "the skin became symmetric: tighten the glass bound").toBeGreaterThan(0.001);
    expect(glass).toBeLessThan(0.009);
  });

  it("runs the top edge as one line under the crown: from the post, back and down round the section to the aft edge", () => {
    // The outer face's top row of each starboard pane, windshield then forward side then aft side.
    const topEdge = GLOBAL_FLIGHT_DECK_OUTLINES.map((outline) => {
      const p = pane("starboard", outline.name);
      return Array.from({ length: p.columns }, (_, column) => onBody(vertex(p, 0, p.rows - 1, column)));
    });
    const line = topEdge.flat();
    // It starts beside the post, clear of the crown by the post's own half-angle and no more.
    expect(line[0]!.angle).toBeGreaterThan(GLOBAL_CENTRE_POST.halfAngle - 0.5);
    expect(line[0]!.angle).toBeLessThan(GLOBAL_CENTRE_POST.halfAngle + 1);
    // Going aft it only ever goes further round the section, i.e. down from the crown.
    for (let k = 1; k < line.length; k += 1) {
      expect(line[k]!.aft, `top edge point ${k}`).toBeGreaterThan(line[k - 1]!.aft);
      expect(line[k]!.angle, `top edge point ${k}`).toBeGreaterThan(line[k - 1]!.angle - 0.5);
    }
    // Across the pillar and the mid post the line steps as wide as the post is and no further.
    for (let pane = 1; pane < topEdge.length; pane += 1) {
      const before = topEdge[pane - 1]![topEdge[pane - 1]!.length - 1]!;
      const after = topEdge[pane]![0]!;
      expect(after.aft - before.aft, `gap before pane ${pane}`).toBeGreaterThan(0.03);
      expect(after.aft - before.aft, `gap before pane ${pane}`).toBeLessThan(0.1);
      expect(after.angle - before.angle, `step before pane ${pane}`).toBeLessThan(5);
    }
    // It ends where the type's does, 51 degrees round the section at 3.40 m aft: the side glass
    // is on the flank, under the shoulder, not on the roof.
    expect(line[line.length - 1]!.aft).toBeCloseTo(3.4, 1);
    expect(line[line.length - 1]!.angle).toBeGreaterThan(48);
  });
});
