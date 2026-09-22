import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWebGpuAircraft, type AircraftVisual } from "../src/render/webgpu/aircraft";
import {
  FLIGHT_DECK_PANES,
  FLIGHT_DECK_REFERENCE as R,
  PANE_GRID,
  PANE_PROUD,
  SkinCaster,
  paneGrid,
  sightline,
  type Point3,
  type SkinTriangles,
} from "../src/render/webgpu/aircraft/airlinerGlazing";
import { AircraftBuildContext, type LoftSection } from "../src/render/webgpu/aircraft/builders";

/**
 * The 747's flight-deck glass, as BUILT: six panes cast from design angles
 * onto the nose's own triangles, and the centre post between the No.1 pair.
 * docs/findings/AIRLINER_NOSE_GLAZING.md has the design and the corner table.
 *
 * The panes are captured as `skinPanel` returns them, before the merge folds
 * them into `airliner-flight-deck-glazing`, and the first test proves the
 * merged mesh holds exactly those vertices, so everything after is about the
 * glass that is drawn.
 */

interface Panel { name: string; rows: number; columns: number; positions: number[]; indices: number[] }

const DEG = 180 / Math.PI;
let engine: NullEngine;
let scene: Scene;
let visual: AircraftVisual;
const panels: Panel[] = [];
let shell: SkinTriangles;
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
  visual = createWebGpuAircraft(scene, "airliner");
  spy.mockRestore();
  const shellMesh = scene.getMeshByName("airliner-fuselage-shell") as Mesh;
  expect(shellMesh.getWorldMatrix().isIdentity(), "the shell's vertices are not body metres").toBe(true);
  shell = soup(shellMesh);
  caster = new SkinCaster([shell]);
});

afterAll(() => {
  visual.dispose();
  scene.dispose();
  engine.dispose();
});

const pane = (side: "port" | "starboard", name: string): Panel => {
  const found = panels.find((p) => p.name === `${side}-airliner-flight-deck-window-${name}`);
  if (!found) throw new Error(`no ${side} pane ${name}`);
  return found;
};
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

describe("the 747's flight-deck glass", () => {
  it("is six panes and a post, and the merged glazing holds every pane vertex", () => {
    const names = panels.map((p) => p.name).sort();
    expect(names).toEqual([
      "airliner-windscreen-center-post",
      ...["port", "starboard"].flatMap((side) => ["one", "three", "two"].map((n) => `${side}-airliner-flight-deck-window-${n}`)),
    ].sort());
    const merged = (scene.getMeshByName("airliner-flight-deck-glazing") as Mesh).getVerticesData(VertexBuffer.PositionKind)!;
    const keys = new Set<string>();
    for (let i = 0; i < merged.length; i += 3) keys.add(`${merged[i]!.toFixed(6)},${merged[i + 1]!.toFixed(6)},${merged[i + 2]!.toFixed(6)}`);
    const panes = panels.filter((p) => p.name.includes("flight-deck-window"));
    const count = panes.reduce((s, p) => s + p.positions.length / 3, 0);
    expect(merged.length / 3, "the merged glazing holds something besides the six panes").toBe(count);
    for (const p of panes) {
      for (let i = 0; i < p.positions.length; i += 3) {
        expect(keys.has(`${p.positions[i]!.toFixed(6)},${p.positions[i + 1]!.toFixed(6)},${p.positions[i + 2]!.toFixed(6)}`), p.name).toBe(true);
      }
    }
  });

  it("puts every outer-face grid point PANE_PROUD out from the skin, on the design sightline from R", () => {
    for (const side of [1, -1] as const) {
      for (const spec of FLIGHT_DECK_PANES) {
        const built = pane(side > 0 ? "starboard" : "port", spec.name);
        const grid = paneGrid(caster, spec, side);
        for (let row = 0; row < PANE_GRID; row += 1) {
          for (let column = 0; column < PANE_GRID; column += 1) {
            const skin = grid.points[row]![column]!;
            // The skin point IS on its sightline: the design angles, to a micro-degree.
            const want = sightline(
              spec.azimuth[0] + (spec.azimuth[1] - spec.azimuth[0]) * (column / (PANE_GRID - 1)),
              spec.elevation[0] + (spec.elevation[1] - spec.elevation[0]) * (row / (PANE_GRID - 1)),
              side,
            );
            const got = unit(sub(skin, R));
            const off = cross(got, want);
            expect(Math.asin(Math.min(1, Math.hypot(off.x, off.y, off.z))) * DEG).toBeLessThan(1e-6);
            // And the built glass is that point moved out along the skin's normal.
            const expected = add(skin, grid.normals[row]![column]!, PANE_PROUD);
            const outer = vertex(built, 0, row, column);
            expect(Math.hypot(outer.x - expected.x, outer.y - expected.y, outer.z - expected.z)).toBeLessThan(1e-5);
          }
        }
      }
    }
  });

  it("keeps the outer face outside the skin and the inner face inside it, at every cell centre", () => {
    // Along the skin's normal, from a ray cast from R through each cell's centre. The design is 4 cm
    // out and 6 cm in; the chords between grid points sag across the 28-segment nose's facet creases.
    let outerMin = Infinity;
    let innerMax = -Infinity;
    for (const panel of panels) {
      for (const face of [0, 1] as const) {
        for (let row = 0; row < panel.rows - 1; row += 1) {
          for (let column = 0; column < panel.columns - 1; column += 1) {
            const centre = mean(vertex(panel, face, row, column), vertex(panel, face, row, column + 1),
              vertex(panel, face, row + 1, column), vertex(panel, face, row + 1, column + 1));
            const range = Math.hypot(centre.x - R.x, centre.y - R.y, centre.z - R.z);
            const direction = unit(sub(centre, R));
            const hit = caster.exit(R, direction)!;
            const clearance = (range - hit.distance) * dot(direction, hit.normal);
            if (face === 0) outerMin = Math.min(outerMin, clearance);
            else innerMax = Math.max(innerMax, clearance);
          }
        }
      }
    }
    // Measured 0.0216 and -0.0458.
    expect(outerMin).toBeGreaterThan(0.02);
    expect(innerMax).toBeLessThan(-0.04);
  });

  it("draws every face toward the side it is seen from: outer from outside, inner from the flight deck, rim from beside", () => {
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
          const cell = (face: 0 | 1) => mean(vertex(panel, face, row, column), vertex(panel, face, row, column + 1),
            vertex(panel, face, row + 1, column), vertex(panel, face, row + 1, column + 1));
          const outward = unit(sub(cell(0), cell(1)));
          look(add(cell(0), outward, 3), cell(0)); // from outside, 3 m off the glass
          look(R, cell(1)); // from the flight deck
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
    for (const spec of FLIGHT_DECK_PANES) {
      const s = pane("starboard", spec.name);
      const p = pane("port", spec.name);
      for (let i = 0; i < s.positions.length; i += 3) {
        glass = Math.max(glass, Math.abs(s.positions[i]! - p.positions[i]!),
          Math.abs(s.positions[i + 1]! - p.positions[i + 1]!), Math.abs(s.positions[i + 2]! + p.positions[i + 2]!));
      }
    }
    // WHY NOT EXACT: the loft splits every quad on the same diagonal in index order, and that
    // diagonal mirrors the other way on the port side, so the drawn skin itself is not symmetric.
    // The glass is cast onto the skin as drawn and follows it.
    let skin = 0;
    for (let az = 0; az <= 75; az += 5) {
      for (let el = -18; el <= 12; el += 5) {
        const s = caster.exit(R, sightline(az, el, 1))!.point;
        const p = caster.exit(R, sightline(az, el, -1))!.point;
        skin = Math.max(skin, Math.abs(s.x - p.x), Math.abs(s.y - p.y), Math.abs(s.z + p.z));
      }
    }
    expect(skin, "the skin became symmetric: tighten the glass bound").toBeGreaterThan(0.01);
    expect(glass).toBeLessThan(0.025);
  });

  it("shows the sky the design asked for, through the built outer faces, from R", () => {
    const outer = (panel: Panel): SkinTriangles => {
      const indices: number[] = [];
      for (let row = 0; row < panel.rows - 1; row += 1) {
        for (let column = 0; column < panel.columns - 1; column += 1) {
          const k = row * panel.columns + column;
          indices.push(k, k + 1, k + panel.columns, k + 1, k + panel.columns + 1, k + panel.columns);
        }
      }
      return { positions: panel.positions, indices, normals: panel.positions };
    };
    for (const spec of FLIGHT_DECK_PANES) {
      const glass = new SkinCaster([outer(pane("starboard", spec.name))]);
      const centre = (spec.azimuth[0] + spec.azimuth[1]) / 2;
      const through: number[] = [];
      for (let el = -30; el <= 25; el += 0.05) if (glass.exit(R, sightline(centre, el, 1))) through.push(el);
      // One run, and the design range give or take the 4 cm the outer face stands proud.
      const low = Math.min(...through);
      const high = Math.max(...through);
      expect(through.length * 0.05).toBeGreaterThan(high - low - 0.1);
      expect(Math.abs(low - spec.elevation[0]), `No.${spec.name} bottom`).toBeLessThan(1.2);
      expect(Math.abs(high - spec.elevation[1]), `No.${spec.name} top`).toBeLessThan(1.2);
    }
  });
});

describe("the brow over the No.1 panes", () => {
  /** The centreline crown, x -> y, read off a skin by casting straight up. */
  const crownAt = (skin: SkinCaster, x: number) => skin.exit({ x, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })!.point.y;
  /**
   * Where the No.1 glass's top edge lands, and what the skin does there: the
   * crown's slope at that station, and the kink (the brow's crest) in the
   * 0.3 m aft of it, as its height above the glass's top. A crest is a real
   * kink, the slope changing by 0.3 m per metre or more; a straight crown
   * reads float noise there, and noise is not a crest.
   */
  function brow(skin: SkinCaster) {
    const top = paneGrid(skin, FLIGHT_DECK_PANES[0]!, 1).points[PANE_GRID - 1]![0]!;
    const slope = (crownAt(skin, top.x + 0.03) - crownAt(skin, top.x - 0.03)) / 0.06;
    let crest = { bend: 0, rise: 0, aft: 0 };
    for (let aft = 0.02; aft <= 0.3; aft += 0.01) {
      const x = top.x - aft;
      const bend = (crownAt(skin, x - 0.02) - crownAt(skin, x)) / 0.02 - (crownAt(skin, x) - crownAt(skin, x + 0.02)) / 0.02;
      if (bend < -0.3 && bend < crest.bend) crest = { bend, rise: crownAt(skin, x) - top.y, aft };
    }
    return { top, slope, crest };
  }

  it("lands the glass's top edge on the windscreen's steep face, under a crest -- where the old ring put it on the roof", () => {
    const built = brow(caster);
    // Measured: the top edge at x 31.51, the face falling 1.08 m per metre (47 degrees), and the
    // crest (the 31.4 ring) 0.11 m aft and 0.12 m above.
    expect(built.slope).toBeLessThan(-0.9);
    expect(built.crest.aft).toBeLessThan(0.15);
    expect(built.crest.rise).toBeGreaterThan(0.08);

    // CONTROL: the nose as it was, the 31.4 ring at crown 3.15. The same panes cast onto it put
    // their top on the roof, falling 0.40 per metre, with no crest behind it.
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const old: LoftSection[] = [
      { x: 25.5, yRadius: 3, zRadius: 3, yOffset: -0.02 },
      { x: 28, yRadius: 3.1, zRadius: 2.92, yOffset: 0.05 },
      { x: 29.2, yRadius: 3.28, zRadius: 2.7, yOffset: 0.42 },
      { x: 30.4, yRadius: 3.05, zRadius: 2.28, yOffset: 0.5 },
      { x: 31.4, yRadius: 2.72, zRadius: 1.82, yOffset: 0.43 },
      { x: 32.4, yRadius: 2, zRadius: 1.36, yOffset: 0.3 },
      { x: 33.4, yRadius: 1.2, zRadius: 0.92, yOffset: -0.25 },
      { x: 34, yRadius: 0.31, zRadius: 0.34, yOffset: -0.1 },
    ];
    const nose = new AircraftBuildContext(scene).loft("old-nose", old, 28, new StandardMaterial("m", scene), new TransformNode("r", scene));
    const before = brow(new SkinCaster([soup(nose)]));
    expect(before.top.x).toBeCloseTo(31.24, 1);
    expect(before.slope).toBeGreaterThan(-0.5);
    expect(before.crest.rise).toBeLessThan(0.02);
    scene.dispose();
    engine.dispose();
  });
});
