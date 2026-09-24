import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWebGpuAircraft, type AircraftVisual } from "../src/render/webgpu/aircraft";
import { SkinCaster, type SkinTriangles } from "../src/render/webgpu/aircraft/airlinerGlazing";
import { FUSELAGE_SECTIONS } from "../src/render/webgpu/aircraft/airlinerVisual";
import { AircraftBuildContext, loftSectionPoint, type LoftSection } from "../src/render/webgpu/aircraft/builders";

/**
 * The 747's 228 cabin windows sit ON THE SKIN AS DRAWN: each pane's centre on the fuselage loft's own triangles,
 * its face along the skin's smooth normal there, its width along the body, at its design station and height.
 *
 * They used to be placed on the IDEAL section, the smooth ellipse the rings describe. The loft draws 28 flat facets
 * round it, so each pane stood proud of the drawn skin by the facet's sag at its height: 16.3 mm on the barrel,
 * about 20 forward of x 14, 0.5 where the height happened to sit on a ring vertex. The ideal tilt was the plain
 * ellipse's gradient, which leaves out the crown taper, so the upper-deck panes faced 5.3-7.4 degrees below their skin.
 * The 747 nose polish slid the forward upper-deck panes mid-facet (17.9 mm proud, 8.7 and 11.3 degrees off), and in
 * the GPU frames they read as light boxes. The windows are ONE box thin-instanced 228 times, so a positions-and-indices
 * digest never saw any of it: the placement is the instance-matrix buffer.
 *
 * The instrument shares nothing with the placement but the built triangles. The gap is read along each pane's OWN
 * face normal from its centre onto the lofts. The turn is read against the ANALYTIC normal of the loft's ruled surface,
 * worked out here from `FUSELAGE_SECTIONS` with `loftSectionPoint`, not against any vertex normal: the first seating
 * laid the panes on the fuselage's shading normals, and the aft ones inherited the buried aft cap's 35-degree tilt,
 * which a turn read against those same normals called zero.
 */

const D = 180 / Math.PI;
let engine: NullEngine;
let scene: Scene;
let visual: AircraftVisual;
let caster: SkinCaster;
let fuselageShading: SkinCaster;
const skins: Array<SkinTriangles & { positions: number[] }> = [];

beforeAll(() => {
  const original = AircraftBuildContext.prototype.loft;
  const spy = vi.spyOn(AircraftBuildContext.prototype, "loft").mockImplementation(
    function (this: AircraftBuildContext, ...args: Parameters<typeof original>) {
      const mesh = original.apply(this, args);
      // Read NOW: `mergeStatic` disposes the lofts into the shell later.
      if (args[0] === "airliner-fuselage" || args[0] === "airliner-radome") {
        skins.push({
          positions: Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!),
          indices: Array.from(mesh.getIndices()!),
          normals: Array.from(mesh.getVerticesData(VertexBuffer.NormalKind)!),
        });
      }
      return mesh;
    },
  );
  engine = new NullEngine();
  scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  visual = createWebGpuAircraft(scene, "airliner");
  spy.mockRestore();
  caster = new SkinCaster(skins);
  fuselageShading = new SkinCaster([skins[0]!]);
});

afterAll(() => {
  visual.dispose();
  scene.dispose();
  engine.dispose();
});

interface Vec { x: number; y: number; z: number }
interface Pane { centre: Vec; face: Vec; width: Vec }

const unit = (v: Vec): Vec => { const l = Math.hypot(v.x, v.y, v.z); return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y + a.z * b.z;
const angle = (a: Vec, b: Vec) => Math.acos(Math.min(1, Math.abs(dot(unit(a), unit(b))))) * D;

/** Each pane's centre, face normal (local Z) and width axis (local X), off the instance matrices the GPU gets. */
function builtPanes(): Pane[] {
  const line = scene.getMeshByName("airliner-cabin-window-line") as Mesh;
  return line.thinInstanceGetWorldMatrices().map(({ m }) => ({
    centre: { x: m[12]!, y: m[13]!, z: m[14]! },
    face: unit({ x: m[8]!, y: m[9]!, z: m[10]! }),
    width: unit({ x: m[0]!, y: m[1]!, z: m[2]! }),
  }));
}

/** The loft's surface at station x and ring angle `phase`: each ring's point, straight between rings. */
function surfaceAt(x: number, phase: number): Vec {
  let low = FUSELAGE_SECTIONS[0]!;
  let high = FUSELAGE_SECTIONS[FUSELAGE_SECTIONS.length - 1]!;
  for (let index = 1; index < FUSELAGE_SECTIONS.length; index += 1) {
    if (FUSELAGE_SECTIONS[index]!.x >= x) {
      low = FUSELAGE_SECTIONS[index - 1]!;
      high = FUSELAGE_SECTIONS[index]!;
      break;
    }
  }
  const t = (x - low.x) / (high.x - low.x);
  const p = loftSectionPoint(low, phase);
  const q = loftSectionPoint(high, phase);
  return { x, y: p.y + (q.y - p.y) * t, z: p.z + (q.z - p.z) * t };
}

/** The outward normal of that surface at (x, y) on a flank, by its two tangents: round the ring and along the body. */
function smoothNormal(x: number, y: number, side: number): Vec {
  let lo = 0;
  let hi = Math.PI;
  for (let step = 0; step < 60; step += 1) {
    const mid = (lo + hi) / 2;
    if (surfaceAt(x, mid).y > y) lo = mid;
    else hi = mid;
  }
  const phase = (lo + hi) / 2;
  const a = surfaceAt(x, phase - 1e-5);
  const b = surfaceAt(x, phase + 1e-5);
  const c = surfaceAt(x - 1e-4, phase);
  const d = surfaceAt(x + 1e-4, phase);
  const round = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const along = { x: d.x - c.x, y: d.y - c.y, z: d.z - c.z };
  const n = unit({ x: along.y * round.z - along.z * round.y, y: along.z * round.x - along.x * round.z, z: along.x * round.y - along.y * round.x });
  const out = n.z < 0 ? { x: -n.x, y: -n.y, z: -n.z } : n;
  return { x: out.x, y: out.y, z: side * out.z };
}

/** How far the drawn skin is from a pane's centre along its own face, and how far its face is from the smooth normal. */
function seat(pane: Pane): { gap: number; turn: number } {
  const side = Math.sign(pane.centre.z);
  // The box is symmetric through its face, so its local Z may point in or out: take the outward one.
  const sign = Math.sign(pane.face.z * side) || 1;
  const face = { x: sign * pane.face.x, y: sign * pane.face.y, z: sign * pane.face.z };
  const back = 0.5;
  const hit = caster.exit(
    { x: pane.centre.x - face.x * back, y: pane.centre.y - face.y * back, z: pane.centre.z - face.z * back }, face, 2,
  );
  if (!hit) throw new Error(`no skin behind the pane at x ${pane.centre.x.toFixed(2)}`);
  return { gap: hit.distance - back, turn: angle(face, smoothNormal(pane.centre.x, pane.centre.y, side)) };
}

/** The OLD placement, as it was until the fix: the ideal section at the window's height and the plain ellipse's gradient. */
function idealPane(x: number, y: number, side: number, sections: readonly LoftSection[]): Pane {
  let low = sections[0]!;
  let high = sections[sections.length - 1]!;
  for (let index = 1; index < sections.length; index += 1) {
    if (sections[index]!.x >= x) {
      low = sections[index - 1]!;
      high = sections[index]!;
      break;
    }
  }
  const t = Math.min(1, Math.max(0, (x - low.x) / Math.max(1e-6, high.x - low.x)));
  const mix = (a: number, b: number) => a + (b - a) * t;
  const yRadius = mix(low.yRadius, high.yRadius);
  const zRadius = mix(low.zRadius, high.zRadius);
  const yOffset = mix(low.yOffset ?? 0, high.yOffset ?? 0);
  const crownZRadius = mix(low.crownZRadius ?? low.zRadius, high.crownZRadius ?? high.zRadius);
  const rise = (y - yOffset) / yRadius;
  const lift = Math.max(0, rise) ** 2 * (3 - 2 * Math.max(0, rise));
  const halfWidth = zRadius + (crownZRadius - zRadius) * lift;
  const z = halfWidth * Math.sqrt(Math.max(0, 1 - rise * rise));
  const tilt = Math.atan2(rise / yRadius, z / (halfWidth * halfWidth));
  return { centre: { x, y, z: side * z }, face: { x: 0, y: Math.sin(tilt), z: side * Math.cos(tilt) }, width: { x: 1, y: 0, z: 0 } };
}

/** The design stations: 88 main-deck panes from x 24.2 aft and 26 upper-deck from 28.6, every 0.56 m, both flanks. */
const STATIONS = [
  ...Array.from({ length: 88 }, (_, i) => ({ x: 24.2 - i * 0.56, y: 0.2 })),
  ...Array.from({ length: 26 }, (_, i) => ({ x: 28.6 - i * 0.56, y: 2.95 })),
];

describe("the 747's cabin windows", () => {
  it("all 228 sit on the skin as drawn: on it within 2 mm, along its smooth normal, width along the body", () => {
    const panes = builtPanes();
    expect(panes).toHaveLength(228);
    const seats = panes.map(seat);
    expect(Math.max(...seats.map((s) => Math.abs(s.gap) * 1000)), "mm off the skin").toBeLessThanOrEqual(2);
    // Along the SMOOTH surface's normal, to within the 28-facet ring's own interpolation of it: 1.6 degrees at most,
    // measured. Both controls below miss it by 5.3 degrees or more.
    expect(Math.max(...seats.map((s) => s.turn)), "degrees from the smooth normal").toBeLessThanOrEqual(2);
    // The width runs along the body: body x laid into the face's plane.
    for (const pane of panes) {
      const along = unit({ x: 1 - pane.face.x * pane.face.x, y: -pane.face.x * pane.face.y, z: -pane.face.x * pane.face.z });
      expect(angle(pane.width, along)).toBeLessThanOrEqual(1);
    }
  });

  it("each pane is at its design station and height, 114 a side", () => {
    const panes = builtPanes();
    for (const side of [1, -1]) {
      const flank = panes.filter((pane) => Math.sign(pane.centre.z) === side);
      expect(flank).toHaveLength(114);
      for (const station of STATIONS) {
        expect(flank.some((pane) => Math.abs(pane.centre.x - station.x) < 1e-4 && Math.abs(pane.centre.y - station.y) < 1e-4),
          `a pane at x ${station.x.toFixed(2)}, y ${station.y}`).toBe(true);
      }
    }
  });

  it("CONTROL: the ideal-section placement it replaced fails the same instrument, on both decks", () => {
    const old = builtPanes().map((pane) => idealPane(pane.centre.x, pane.centre.y, Math.sign(pane.centre.z), FUSELAGE_SECTIONS));
    const seats = old.map((pane) => ({ pane, ...seat(pane) }));
    const gaps = (keep: (pane: Pane) => boolean) =>
      seats.filter((s) => keep(s.pane)).map((s) => Math.abs(s.gap) * 1000).sort((p, q) => p - q);
    // Proud of the facets, in mm: the main deck by 0.5-20.2 as its 0.2 m height slides round the facets with the
    // section's centre (16.3 on the barrel, where it lands 3.5 degrees from a ring vertex); the forward upper deck,
    // since the nose polish, by 17.9.
    const mainDeck = gaps((pane) => pane.centre.y < 1);
    expect(mainDeck[mainDeck.length >> 1]!).toBeGreaterThan(14);
    expect(Math.max(...gaps((pane) => pane.centre.y > 2 && pane.centre.x > 26.5))).toBeGreaterThan(10);
    // Turned below the skin by the crown taper the plain gradient leaves out: 5.3 to 11.3 degrees, every upper-deck pane.
    expect(Math.min(...seats.filter((s) => s.pane.centre.y > 2).map((s) => s.turn))).toBeGreaterThan(4);
  });

  it("CONTROL: laid on the fuselage's own shading normals, the aft panes take the buried aft cap's tilt", () => {
    const shaded = builtPanes().map((pane): Pane => {
      const side = Math.sign(pane.centre.z);
      const hit = fuselageShading.exit({ x: pane.centre.x, y: pane.centre.y, z: 0 }, { x: 0, y: 0, z: side })!;
      return { centre: hit.point, face: hit.normal, width: { x: 1, y: 0, z: 0 } };
    });
    const seats = shaded.map((pane) => ({ pane, ...seat(pane) }));
    // The buried aft cap at x -26 shares that ring's vertices and tilts its normals 35 degrees aft; the tilt runs
    // forward across the 6 m strip. Every pane in it, eight a side, is off the smooth normal by more than the pin:
    // 2.6 at x -20.60 rising to 25.2 at the aft-most. Forward of it the caps do not reach (1.5 at most).
    const aft = seats.filter((s) => s.pane.centre.x < -20.3);
    expect(aft).toHaveLength(16);
    expect(aft.every((s) => s.turn > 2)).toBe(true);
    expect(Math.max(...aft.map((s) => s.turn))).toBeGreaterThan(20);
    expect(Math.max(...seats.filter((s) => s.pane.centre.x > -20).map((s) => s.turn))).toBeLessThanOrEqual(2);
  });
});
