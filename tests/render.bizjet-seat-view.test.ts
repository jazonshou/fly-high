import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWebGpuAircraft, type AircraftVisual } from "../src/render/webgpu/aircraft";
import { PANE_GRID, SkinCaster, paneGrid, type Point3, type SkinTriangles } from "../src/render/webgpu/aircraft/airlinerGlazing";
import {
  GLOBAL_FLIGHT_DECK_OUTLINES,
  GLOBAL_FLIGHT_DECK_REFERENCE as R,
  GLOBAL_NOSE_TIP_X,
  globalGlazingPane,
} from "../src/render/webgpu/aircraft/bizjetGlazing";
import { GLOBAL_FUSELAGE_SECTIONS } from "../src/render/webgpu/aircraft/bizjetLivery";
import { AircraftBuildContext, type LoftSection } from "../src/render/webgpu/aircraft/builders";

/**
 * The Global's flight deck from a SEATED eye (phase 3c, parts 2 and 3): what
 * the lowered crown and the drooped tip are for. The requirement: straight
 * ahead the windshield spans -10 to +10 degrees or more (on final the aim point
 * sits 6-8 degrees under the body axis), at least 24 tall, the horizon inside. The eye is (11.90, 0.55, -0.52): the
 * catalogue eye's station and seat, at a seated height, 1.21 m above the floor
 * at -0.66. It is this test's constant, not `catalogue.cockpitEye`, which the
 * cockpit engineer re-solves against these numbers.
 *
 * Everything is read off the BUILT glass (captured as `skinPanel` returns it)
 * and the built skin.
 */

interface Panel { name: string; rows: number; columns: number; positions: number[]; indices: number[] }
const SEAT_EYE: Point3 = { x: 11.9, y: 0.55, z: -0.52 };
/** The nose as part 1 left it (c252859): the crown held, the widths the type's. Literally, for the controls. */
const PART_1_FUSELAGE: readonly LoftSection[] = [
  { x: -13.1, yRadius: 1.0, zRadius: 0.96, yOffset: 0.27 },
  { x: -10.5, yRadius: 1.23, zRadius: 1.19, yOffset: 0.12 },
  { x: -8, yRadius: 1.34, zRadius: 1.33, yOffset: 0.03 },
  { x: -2, yRadius: 1.345, zRadius: 1.345 },
  { x: 4.5, yRadius: 1.345, zRadius: 1.345 },
  { x: 9.5, yRadius: 1.335, zRadius: 1.32 },
  { x: 10.5, yRadius: 1.2945, zRadius: 1.32, yOffset: 0.0286 },
  { x: 11, yRadius: 1.2743, zRadius: 1.32, yOffset: 0.0429 },
  { x: 11.5, yRadius: 1.254, zRadius: 1.315, yOffset: 0.0571 },
  { x: 12, yRadius: 1.1625, zRadius: 1.272, yOffset: 0.04 },
  { x: 12.5, yRadius: 1.0531, zRadius: 1.201, yOffset: 0.015 },
  { x: 13, yRadius: 0.9437, zRadius: 1.1, yOffset: -0.01 },
  { x: 13.35, yRadius: 0.8533, zRadius: 0.99, yOffset: -0.0367 },
  { x: 13.7, yRadius: 0.7444, zRadius: 0.851, yOffset: -0.0756 },
  { x: 14.1, yRadius: 0.62, zRadius: 0.672, yOffset: -0.12 },
  { x: 14.4, yRadius: 0.48, zRadius: 0.502, yOffset: -0.135 },
  // The drooped tip, as the radome ended: the sim's two radome contact points
  // straddle it at y 0.1 and -0.4 (`src/sim/aircraft.ts`).
  { x: 14.7, yRadius: 0.34, zRadius: 0.34, yOffset: -0.15 },
  { x: 15, yRadius: 0.1, zRadius: 0.1, yOffset: -0.15 },
];
const DEG = 180 / Math.PI;
let engine: NullEngine;
let scene: Scene;
let visual: AircraftVisual;
const panels: Panel[] = [];
let skin: SkinCaster;
let fuselage: Mesh;

const soup = (mesh: Mesh): SkinTriangles => ({
  positions: mesh.getVerticesData(VertexBuffer.PositionKind)!,
  indices: mesh.getIndices()!,
  normals: mesh.getVerticesData(VertexBuffer.NormalKind)!,
});
/** A panel's outer face alone, as a triangle soup: the aperture, not the rim. */
const outerFace = (panel: Panel): SkinTriangles => {
  const indices: number[] = [];
  for (let row = 0; row < panel.rows - 1; row += 1) {
    for (let column = 0; column < panel.columns - 1; column += 1) {
      const k = row * panel.columns + column;
      indices.push(k, k + 1, k + panel.columns, k + 1, k + panel.columns + 1, k + panel.columns);
    }
  }
  return { positions: panel.positions, indices, normals: panel.positions };
};
const vertex = (panel: Panel, row: number, column: number): Point3 => {
  const i = (row * panel.columns + column) * 3;
  return { x: panel.positions[i]!, y: panel.positions[i + 1]!, z: panel.positions[i + 2]! };
};
const direction = (azimuth: number, elevation: number): Point3 => ({
  x: Math.cos(elevation / DEG) * Math.cos(azimuth / DEG),
  y: Math.sin(elevation / DEG),
  z: -Math.cos(elevation / DEG) * Math.sin(azimuth / DEG),
});
/** Azimuth (to the pilot's right, +), elevation and range of a point from an eye. */
const sight = (eye: Point3, p: Point3) => {
  const dx = p.x - eye.x; const dy = p.y - eye.y; const dz = p.z - eye.z;
  return { az: Math.atan2(-dz, dx) * DEG, el: Math.atan2(dy, Math.hypot(dx, dz)) * DEG, range: Math.hypot(dx, dy, dz) };
};
/** The elevation run of glass straight ahead of an eye, 0.05-degree steps. */
function aheadRun(glass: SkinCaster, eye: Point3): { low: number; high: number; count: number } {
  const through: number[] = [];
  for (let step = -900; step <= 900; step += 1) if (glass.exit(eye, direction(0, step * 0.05))) through.push(step * 0.05);
  return { low: Math.min(...through), high: Math.max(...through), count: through.length };
}

beforeAll(() => {
  const original = AircraftBuildContext.prototype.skinPanel;
  const spy = vi.spyOn(AircraftBuildContext.prototype, "skinPanel").mockImplementation(
    function (this: AircraftBuildContext, ...args: Parameters<typeof original>) {
      const mesh = original.apply(this, args);
      if (!/bizjet-flight-deck-window|bizjet-windscreen-center-post/.test(args[0])) return mesh;
      panels.push({
        name: args[0], rows: args[1].length, columns: args[1][0]!.length,
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
  fuselage = scene.getMeshByName("bizjet-fuselage") as Mesh;
  skin = new SkinCaster([soup(fuselage)]);
});

afterAll(() => {
  visual.dispose();
  scene.dispose();
  engine.dispose();
});

const pane = (side: "port" | "starboard", name: string) => panels.find((p) => p.name === `${side}-bizjet-flight-deck-window-${name}`)!;

/** The skin's nearest point to an eye, sampled every 3 degrees round a sphere, and straight up. */
function headroom(caster: SkinCaster, eye: Point3) {
  let nearest = Infinity;
  for (let a = 0; a < 360; a += 3) {
    for (let b = -87; b <= 87; b += 3) {
      const hit = caster.exit(eye, { x: Math.cos(b / DEG) * Math.cos(a / DEG), y: Math.sin(b / DEG), z: Math.cos(b / DEG) * Math.sin(a / DEG) });
      if (hit) nearest = Math.min(nearest, hit.distance);
    }
  }
  return { up: caster.exit(eye, { x: 0, y: 1, z: 0 })!.distance, nearest };
}

describe("the Global's flight deck from a seated eye (phase 3c)", () => {
  it("shows -12.7 to +14.0 degrees of windshield straight ahead: 10 below the horizon and 10 above, with margin", () => {
    const windshield = new SkinCaster([outerFace(pane("port", "windshield"))]);
    const seated = aheadRun(windshield, SEAT_EYE);
    // One unbroken run, at least 24 degrees tall, reaching 10 below the horizon and 10 above.
    expect(seated.count * 0.05).toBeGreaterThan(seated.high - seated.low - 0.1);
    expect(seated.high - seated.low).toBeGreaterThanOrEqual(24);
    expect(seated.low).toBeLessThanOrEqual(-10);
    expect(seated.high).toBeGreaterThanOrEqual(10);
    // Measured -12.65 and +13.95 (part 2's crown gave -0.60 and +25.55).
    expect(seated.low).toBeCloseTo(-12.65, 0);
    expect(seated.high).toBeCloseTo(13.95, 0);
    // The corners, as the cockpit engineer reads them: azimuth (right +), elevation, range.
    const w = pane("port", "windshield");
    const expected: [number, number, number, number, number][] = [
      [0, 0, -17.86, -10.63, 1.495], [0, w.columns - 1, 17.33, -12.12, 0.959],
      [w.rows - 1, w.columns - 1, 11.31, 14.25, 0.562], [w.rows - 1, 0, -26.47, 1.34, 0.987],
    ];
    for (const [row, column, az, el, range] of expected) {
      const s = sight(SEAT_EYE, vertex(w, row, column));
      expect(Math.abs(s.az - az), `corner ${row},${column} azimuth ${s.az.toFixed(2)}`).toBeLessThan(0.3);
      expect(Math.abs(s.el - el), `corner ${row},${column} elevation ${s.el.toFixed(2)}`).toBeLessThan(0.3);
      expect(Math.abs(s.range - range), `corner ${row},${column} range ${s.range.toFixed(3)}`).toBeLessThan(0.01);
    }
    // CONTROL: from the old catalogue eye's height, 0.78, the same windshield is wholly below the
    // horizon (-22.5..-7.7): no nose serves an eye that high (docs).
    const high = aheadRun(windshield, { ...SEAT_EYE, y: 0.78 });
    expect(high.high).toBeLessThan(0);
  });

  it("leaves the seated eye as much room as the old eye had: at the seat and 0.3 m ahead of it", () => {
    const glass = (eye: Point3) => {
      let nearest = Infinity;
      for (const p of panels) for (let i = 0; i < p.rows * p.columns; i += 1) {
        nearest = Math.min(nearest, Math.hypot(p.positions[i * 3]! - eye.x, p.positions[i * 3 + 1]! - eye.y, p.positions[i * 3 + 2]! - eye.z));
      }
      return nearest;
    };
    // Measured: at the seat 0.368 straight up, 0.306 to the nearest skin, 0.394 to the nearest glass;
    // 0.3 m ahead 0.262, 0.234 and 0.270 (part 2's crown: 0.472 / 0.401 / 0.442, 0.379 / 0.331 / 0.347).
    const atSeat = headroom(skin, SEAT_EYE);
    expect(atSeat.up).toBeCloseTo(0.368, 2);
    expect(atSeat.nearest).toBeCloseTo(0.306, 2);
    expect(glass(SEAT_EYE)).toBeCloseTo(0.394, 2);
    const ahead = { ...SEAT_EYE, x: SEAT_EYE.x + 0.3 };
    const atAhead = headroom(skin, ahead);
    expect(atAhead.up).toBeCloseTo(0.262, 2);
    expect(atAhead.nearest).toBeCloseTo(0.234, 2);
    expect(glass(ahead)).toBeCloseTo(0.27, 2);
    // CONTROL: the same instrument on part 1's nose from the old eye (0.78) reads what the cockpit
    // engineer's K0 measured independently there: 0.34 straight up, 0.30 nearest.
    const lofts = new AircraftBuildContext(scene);
    const part1 = new SkinCaster([soup(lofts.loft("part-1", PART_1_FUSELAGE, 48, new StandardMaterial("p", scene), new TransformNode("p", scene)))]);
    const old = headroom(part1, { ...SEAT_EYE, y: 0.78 });
    expect(old.up).toBeCloseTo(0.341, 2);
    expect(old.nearest).toBeCloseTo(0.302, 2);
  });

  it("casts the windshield's foot on the loft at x 13.29, not past a shelf, and turns smoothly into the drooped tip", () => {
    const foot = (caster: SkinCaster, side: 1 | -1) =>
      paneGrid(caster, globalGlazingPane(GLOBAL_FLIGHT_DECK_OUTLINES[0]!), side, PANE_GRID, R).points[0]![0]!;
    for (const side of [1, -1] as const) {
      // The outline's foot is 1.69 m aft beside the post; the cast lands on the facet under it.
      expect(foot(skin, side).x).toBeCloseTo(13.292, 2);
    }
    // CONTROL: the same table with its 13.35 and 13.7 rings sunk 12 cm, a dip that leaves the nose
    // ahead of it a shelf. The instrument sees the foot leave the outline: measured 1.950 m aft.
    const sunk = GLOBAL_FUSELAGE_SECTIONS.map((r) => (r.x === 13.35 || r.x === 13.7 ? { ...r, yOffset: (r.yOffset ?? 0) - 0.12 } : r));
    const lofts = new AircraftBuildContext(scene);
    const shelf = new SkinCaster([soup(lofts.loft("dip", sunk, 48, new StandardMaterial("d", scene), new TransformNode("d", scene)))]);
    expect(Math.abs(GLOBAL_NOSE_TIP_X - foot(shelf, 1).x - 1.708)).toBeGreaterThan(0.1);
    // Forward of the windshield to the drooped tip: the turn between consecutive rings, over every
    // radial, stays gentle. Measured 5.9, 3.5, 5.1, 5.9, 6.1 degrees into 13.35 .. 14.7. (Into the
    // tip ring itself it is 32: the ring's normals average the cap that closes the nose.)
    const normals = fuselage.getVerticesData(VertexBuffer.NormalKind)!;
    const RING = 49;
    let previous = 0;
    for (const [x, measured] of [[13.35, 5.92], [13.7, 3.52], [14.1, 5.1], [14.4, 5.86], [14.7, 6.08]] as const) {
      const ring = GLOBAL_FUSELAGE_SECTIONS.findIndex((r) => r.x === x);
      let worst = 0;
      for (let radial = 0; radial < 48; radial += 1) {
        const a = (ring - 1) * RING + radial;
        const b = ring * RING + radial;
        const cos = normals[a * 3]! * normals[b * 3]! + normals[a * 3 + 1]! * normals[b * 3 + 1]! + normals[a * 3 + 2]! * normals[b * 3 + 2]!;
        worst = Math.max(worst, Math.acos(Math.min(1, cos)) * DEG);
      }
      expect(worst, `into ring ${x}`).toBeCloseTo(measured, 1);
      expect(worst, `into ring ${x}: a crease, not a turn`).toBeLessThan(6.5);
      previous = Math.max(previous, worst);
    }
  });

  it("brings the side panes' edges down with the crown: tops at 0.67-0.74, bottoms at 0.33-0.44", () => {
    const edges = (name: string) => {
      const p = pane("port", name);
      const row = (r: number) => Array.from({ length: p.columns }, (_, c) => vertex(p, r, c));
      const top = row(p.rows - 1);
      const bottom = row(0);
      return {
        top: [Math.min(...top.map((q) => q.y)), Math.max(...top.map((q) => q.y))],
        bottom: [Math.min(...bottom.map((q) => q.y)), Math.max(...bottom.map((q) => q.y))],
        nearest: Math.min(...top.map((q) => sight(SEAT_EYE, q).range)),
      };
    };
    // Measured (outer face): forward pane top 0.673-0.706, bottom 0.331-0.376, its top edge 0.394 m
    // from the seated eye; aft pane top 0.670-0.738, bottom 0.359-0.438, 0.403 m.
    const expected: Record<string, { top: number[]; bottom: number[]; nearest: number }> = {
      "forward-side": { top: [0.673, 0.706], bottom: [0.331, 0.376], nearest: 0.394 },
      "aft-side": { top: [0.67, 0.738], bottom: [0.359, 0.438], nearest: 0.403 },
    };
    for (const [name, want] of Object.entries(expected)) {
      const got = edges(name);
      for (const k of [0, 1]) {
        expect(Math.abs(got.top[k]! - want.top[k]!), `${name} top`).toBeLessThan(0.005);
        expect(Math.abs(got.bottom[k]! - want.bottom[k]!), `${name} bottom`).toBeLessThan(0.005);
      }
      expect(Math.abs(got.nearest - want.nearest), `${name} nearest`).toBeLessThan(0.005);
    }
  });
});
