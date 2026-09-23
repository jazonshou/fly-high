/**
 * A flight deck's corner table, read off the BUILT meshes: the 747's, or the
 * Global's with `--airframe bizjet`.
 *
 * The cockpit engineer's eye solve and kit are placed against the glass as it
 * is built, not against the design angles, so this builds the real aeroplane
 * in a NullEngine, captures each pane as `skinPanel` returns it, proves the
 * merged `<kind>-flight-deck-glazing` holds those same vertices, and prints:
 *
 *   CORNERS   outer and inner face corners of every pane, body metres
 *             (x forward, y up, z starboard), and the outer corners' az/el
 *             from the centreline reference R;
 *   NORMALS   each pane's outer-face normal at its centre, as degrees above
 *             the horizontal and degrees outboard of dead ahead;
 *   OPENING   the glass's true elevation extent along a sightline -- from the
 *             left-seat eye E straight ahead, and from R at each pane's
 *             centre azimuth -- scanned in 0.05 degree steps against the
 *             merged glazing's own triangles;
 *   BROW      where the inboard pane's top edge lands on the centreline: the
 *             crown's slope there, and the crest behind it.
 *
 *   npx tsx scripts/airliner-glazing-table.mts [--airframe airliner|bizjet] [--json <path>]
 */
import { writeFileSync } from "node:fs";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { aircraftSpec } from "../src/aircraft/catalogue";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import {
  FLIGHT_DECK_PANES,
  FLIGHT_DECK_REFERENCE,
  SkinCaster,
  sightline,
  type GlazingPane,
  type Point3,
} from "../src/render/webgpu/aircraft/airlinerGlazing";
import {
  GLOBAL_FLIGHT_DECK_OUTLINES,
  GLOBAL_FLIGHT_DECK_REFERENCE,
  globalGlazingPane,
} from "../src/render/webgpu/aircraft/bizjetGlazing";
import { AircraftBuildContext, type SurfacePatch } from "../src/render/webgpu/aircraft/builders";

/** What differs between the two flight decks; everything else is read the same way. */
interface Airframe {
  readonly kind: "airliner" | "bizjet";
  readonly title: string;
  readonly reference: Point3;
  readonly panes: readonly GlazingPane[];
  /** How each pane's design is printed: the 747's angles, the Global's outline on the body. */
  readonly design: (pane: GlazingPane) => string;
  /** The skin the brow is read off, as named meshes. */
  readonly skin: readonly string[];
  /** The pane whose top edge meets the centreline, and what the table calls it. */
  readonly inboard: string;
  readonly inboardLabel: string;
}
const AIRFRAMES: Record<string, Airframe> = {
  airliner: {
    kind: "airliner",
    title: "747",
    reference: FLIGHT_DECK_REFERENCE,
    panes: FLIGHT_DECK_PANES,
    design: (pane) => `design az ${pane.azimuth.join("..")}  el ${pane.elevation.join("..")}`,
    skin: ["airliner-fuselage-shell"],
    inboard: "one",
    inboardLabel: "No.1",
  },
  bizjet: {
    kind: "bizjet",
    title: "GLOBAL",
    reference: GLOBAL_FLIGHT_DECK_REFERENCE,
    panes: GLOBAL_FLIGHT_DECK_OUTLINES.map((outline) => globalGlazingPane(outline)),
    design: (pane) => {
      const outline = GLOBAL_FLIGHT_DECK_OUTLINES.find((o) => o.name === pane.name)!;
      const edge = (points: readonly (readonly [number, number])[]) => points.map(([aft, angle]) => `${aft}/${angle}`).join(" ");
      return `outline (m aft of the tip / deg from the crown) bottom ${edge(outline.bottom)}; top ${edge(outline.top)}`;
    },
    skin: ["bizjet-fuselage", "bizjet-radome"],
    inboard: "windshield",
    inboardLabel: "windshield",
  },
};
const airframeFlag = process.argv.indexOf("--airframe");
const airframeName = airframeFlag > 0 ? process.argv[airframeFlag + 1]! : "airliner";
const airframe = AIRFRAMES[airframeName];
if (!airframe) throw new Error(`--airframe ${airframeName}: expected one of ${Object.keys(AIRFRAMES).join(", ")}`);
const R = airframe.reference;
const kind = airframe.kind;

const eyeSpec = aircraftSpec(kind).cockpitEye;
const E: Point3 = { x: eyeSpec.forward, y: eyeSpec.up, z: eyeSpec.right };
const DEG = 180 / Math.PI;

// Capture each skin panel as the builder returns it.
interface Captured { name: string; rows: number; columns: number; positions: number[]; normals: number[] }
const captured: Captured[] = [];
const original = AircraftBuildContext.prototype.skinPanel;
AircraftBuildContext.prototype.skinPanel = function (this: AircraftBuildContext, ...args: Parameters<typeof original>) {
  const mesh = original.apply(this, args);
  const points = args[1] as SurfacePatch;
  captured.push({
    name: args[0],
    rows: points.length,
    columns: points[0]!.length,
    positions: Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!),
    normals: Array.from(mesh.getVerticesData(VertexBuffer.NormalKind)!),
  });
  return mesh;
};

const engine = new NullEngine();
const scene = new Scene(engine);
scene.useRightHandedSystem = true;
const visual = createWebGpuAircraft(scene, kind);
const named = (name: string): Mesh => {
  const found = scene.getMeshByName(name);
  if (!found) throw new Error(`no mesh ${name}`);
  return found as Mesh;
};
const triangles = (mesh: Mesh) => ({
  positions: mesh.getVerticesData(VertexBuffer.PositionKind)!,
  indices: mesh.getIndices()!,
  normals: mesh.getVerticesData(VertexBuffer.NormalKind)!,
});
const glazing = named(`${kind}-flight-deck-glazing`);
const skin = airframe.skin.map(named);
// The merged meshes sit under the aircraft root at identity: their vertices are body metres.
for (const mesh of [glazing, ...skin]) {
  if (!mesh.getWorldMatrix().isIdentity()) throw new Error(`${mesh.name} is not at identity; the table would not be body metres`);
}

// PROOF THAT THE CAPTURE IS THE BUILT GLASS: every captured pane vertex is in the merged mesh.
const merged = glazing.getVerticesData(VertexBuffer.PositionKind)!;
const mergedKeys = new Set<string>();
for (let i = 0; i < merged.length; i += 3) mergedKeys.add(`${merged[i]!.toFixed(6)},${merged[i + 1]!.toFixed(6)},${merged[i + 2]!.toFixed(6)}`);
const panes = captured.filter((pane) => pane.name.includes("flight-deck-window"));
let missing = 0;
for (const pane of panes) {
  for (let i = 0; i < pane.positions.length; i += 3) {
    if (!mergedKeys.has(`${pane.positions[i]!.toFixed(6)},${pane.positions[i + 1]!.toFixed(6)},${pane.positions[i + 2]!.toFixed(6)}`)) missing += 1;
  }
}
if (panes.length !== 6) throw new Error(`expected six panes, captured ${panes.length}`);
if (missing > 0) throw new Error(`${missing} captured pane vertices are not in the merged glazing`);

const vertexOf = (pane: Captured, face: 0 | 1, row: number, column: number): Point3 => {
  const i = (face * pane.rows * pane.columns + row * pane.columns + column) * 3;
  return { x: pane.positions[i]!, y: pane.positions[i + 1]!, z: pane.positions[i + 2]! };
};
const angles = (from: Point3, to: Point3, side: number) => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  return { az: Math.atan2(side * dz, dx) * DEG, el: Math.atan2(dy, Math.hypot(dx, dz)) * DEG };
};
const f3 = (p: Point3) => `${p.x.toFixed(3).padStart(7)} ${p.y.toFixed(3).padStart(6)} ${p.z.toFixed(3).padStart(7)}`;

// Two-sided crossing of a ray with a triangle soup; distances only.
const crossings = (origin: Point3, direction: Point3, soup: { positions: ArrayLike<number>; indices: ArrayLike<number> }): number[] => {
  const hits: number[] = [];
  const { positions: p, indices } = soup;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const e1 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
    const e2 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
    const q = [direction.y * e2[2]! - direction.z * e2[1]!, direction.z * e2[0]! - direction.x * e2[2]!, direction.x * e2[1]! - direction.y * e2[0]!];
    const det = e1[0]! * q[0]! + e1[1]! * q[1]! + e1[2]! * q[2]!;
    if (Math.abs(det) < 1e-12) continue;
    const s = [origin.x - p[a]!, origin.y - p[a + 1]!, origin.z - p[a + 2]!];
    const u = (s[0]! * q[0]! + s[1]! * q[1]! + s[2]! * q[2]!) / det;
    if (u < 0 || u > 1) continue;
    const r = [s[1]! * e1[2]! - s[2]! * e1[1]!, s[2]! * e1[0]! - s[0]! * e1[2]!, s[0]! * e1[1]! - s[1]! * e1[0]!];
    const v = (direction.x * r[0]! + direction.y * r[1]! + direction.z * r[2]!) / det;
    if (v < 0 || u + v > 1) continue;
    const distance = (e2[0]! * r[0]! + e2[1]! * r[1]! + e2[2]! * r[2]!) / det;
    if (distance > 1e-6) hits.push(distance);
  }
  return hits;
};
// THE APERTURE IS THE OUTER FACES. A sightline through a pillar gap can graze
// a pane's rim wall, and counting the rims as glass closed the gaps up: the
// first reading put the pilot's straight-ahead view "through glass" along the
// No.1/No.2 pillar. So the scans below cross the outer faces alone, rebuilt
// from each captured grid.
const outerIndices: number[] = [];
const outerPositions: number[] = [];
for (const pane of panes) {
  const base = outerPositions.length / 3;
  outerPositions.push(...pane.positions.slice(0, pane.rows * pane.columns * 3));
  for (let row = 0; row < pane.rows - 1; row += 1) {
    for (let column = 0; column < pane.columns - 1; column += 1) {
      const k = base + row * pane.columns + column;
      outerIndices.push(k, k + 1, k + pane.columns, k + 1, k + pane.columns + 1, k + pane.columns);
    }
  }
}
const glassSoup = { positions: outerPositions, indices: outerIndices };
/** Runs of `scan` (degrees, 0.05 steps over from..to) where the sightline crosses an outer glass face. */
const runsOf = (origin: Point3, sightlineAt: (scan: number) => Point3, from = -50, to = 50): Array<[number, number]> => {
  const runs: Array<[number, number]> = [];
  let start: number | null = null;
  for (let step = Math.round(from / 0.05); step <= Math.round(to / 0.05); step += 1) {
    const scan = step * 0.05;
    const through = crossings(origin, sightlineAt(scan), glassSoup).length > 0;
    if (through && start === null) start = scan;
    if (!through && start !== null) {
      runs.push([start, scan - 0.05]);
      start = null;
    }
  }
  if (start !== null) runs.push([start, to]);
  return runs;
};
/** Elevation runs of glass along one azimuth. */
const openings = (origin: Point3, az: number, side: 1 | -1) => runsOf(origin, (el) => sightline(az, el, side));
const runText = (runs: Array<[number, number]>) => runs.map(([a, b]) => `${a.toFixed(2)}..${b.toFixed(2)} (${(b - a).toFixed(2)} deg)`).join(", ") || "none";

const report: Record<string, unknown> = { reference: R, eye: E, panes: {} };
console.log(`${airframe.title} FLIGHT-DECK GLAZING, from the BUILT meshes (${panes.length} panes, every vertex found in the merged glazing)`);
console.log(`R = (${f3(R)})  azimuth reference;  E = (${f3(E)})  left-seat eye (catalogue.cockpitEye)\n`);
for (const side of [1, -1] as const) {
  const sideName = side > 0 ? "starboard" : "port";
  for (const spec of airframe.panes) {
    const pane = panes.find((p) => p.name === `${sideName}-${kind}-flight-deck-window-${spec.name}`)!;
    const last = { row: pane.rows - 1, column: pane.columns - 1 };
    const cornerCells = {
      bottomInboard: [0, 0], bottomOutboard: [0, last.column], topOutboard: [last.row, last.column], topInboard: [last.row, 0],
    } as const;
    const corners: Record<string, { outer: Point3; inner: Point3; outerFromR: { az: number; el: number } }> = {};
    for (const [key, [row, column]] of Object.entries(cornerCells)) {
      const outer = vertexOf(pane, 0, row, column);
      corners[key] = { outer, inner: vertexOf(pane, 1, row, column), outerFromR: angles(R, outer, side) };
    }
    // Outer-face normal at the centre: the mean of the four middle vertices' shading normals.
    const mid = [Math.floor((pane.rows - 1) / 2), Math.ceil((pane.rows - 1) / 2)];
    const midColumns = [Math.floor((pane.columns - 1) / 2), Math.ceil((pane.columns - 1) / 2)];
    let n = { x: 0, y: 0, z: 0 };
    for (const row of mid) for (const column of midColumns) {
      const i = (row * pane.columns + column) * 3;
      n = { x: n.x + pane.normals[i]!, y: n.y + pane.normals[i + 1]!, z: n.z + pane.normals[i + 2]! };
    }
    const length = Math.hypot(n.x, n.y, n.z);
    n = { x: n.x / length, y: n.y / length, z: n.z / length };
    const normal = { aboveHorizontal: Math.asin(n.y) * DEG, outboard: Math.atan2(side * n.z, n.x) * DEG };
    const centreAz = (spec.azimuth[0] + spec.azimuth[1]) / 2;
    const fromR = openings(R, centreAz, side);
    (report.panes as Record<string, unknown>)[pane.name] = { corners, normal, openingFromR: { azimuth: centreAz, runs: fromR } };
    if (side < 0) continue; // port mirrors starboard; checked below, printed once
    console.log(`PANE ${spec.name.toUpperCase()}  ${airframe.design(spec)}   (starboard; port = z mirrored)`);
    console.log("  corner           outer face (x y z)          inner face (x y z)         outer az/el from R");
    for (const [key, corner] of Object.entries(corners)) {
      console.log(`  ${key.padEnd(15)} ${f3(corner.outer)}   ${f3(corner.inner)}   ${corner.outerFromR.az.toFixed(2).padStart(6)} ${corner.outerFromR.el.toFixed(2).padStart(6)}`);
    }
    console.log(`  outer normal at centre: ${normal.aboveHorizontal.toFixed(1)} deg above horizontal, ${normal.outboard.toFixed(1)} deg outboard of dead ahead`);
    console.log(`  glass from R at az ${centreAz.toFixed(2)}: el ${runText(fromR)}\n`);
  }
}

// Mirror check: port == starboard with z negated, vertex for vertex.
let mirrorError = 0;
for (const spec of airframe.panes) {
  const s = panes.find((p) => p.name === `starboard-${kind}-flight-deck-window-${spec.name}`)!;
  const p = panes.find((q) => q.name === `port-${kind}-flight-deck-window-${spec.name}`)!;
  for (let i = 0; i < s.positions.length; i += 3) {
    mirrorError = Math.max(mirrorError, Math.abs(s.positions[i]! - p.positions[i]!), Math.abs(s.positions[i + 1]! - p.positions[i + 1]!),
      Math.abs(s.positions[i + 2]! + p.positions[i + 2]!));
  }
}
console.log(`MIRROR: port vs starboard, worst vertex difference ${mirrorError.toExponential(2)} m`);

// OPENING from the left seat: straight ahead in elevation, and across in
// azimuth at the horizon (negative = to the pilot's left, outboard).
const ahead = openings(E, 0, 1);
const acrossRuns = runsOf(E, (az) => sightline(az, 0, 1), -90, 90);
console.log(`OPENING from E straight ahead (az 0): el ${runText(ahead)}`);
console.log(`OPENING from E at the horizon (el 0), az left(-)/right(+): ${runText(acrossRuns)}`);
// Each glass run at the horizon is a pane as the pilot sees it: its height
// through the middle of that run is the opening the left seat actually has.
const asSeen = acrossRuns.map(([a, b]) => {
  const middle = (a + b) / 2;
  return { azimuth: [a, b], middle, elevation: openings(E, middle, 1) };
});
for (const run of asSeen) {
  console.log(`  pane seen from E over az ${run.azimuth[0]!.toFixed(2)}..${run.azimuth[1]!.toFixed(2)}: through its middle (az ${run.middle.toFixed(2)}) el ${runText(run.elevation)}`);
}

// BROW: where the inboard glass's top edge lands on the centreline, the crown's
// slope there, and the crest (a kink of 0.3 m per metre or more) in the 0.3 m
// aft of it -- the same definition as tests/render.airliner-glazing.test.ts.
const shellCaster = new SkinCaster(skin.map(triangles));
const crownAt = (x: number) => shellCaster.exit({ x, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })!.point.y;
const one = panes.find((p) => p.name === `starboard-${kind}-flight-deck-window-${airframe.inboard}`)!;
const topInboard = vertexOf(one, 0, one.rows - 1, 0);
const skinTop = { x: topInboard.x, y: crownAt(topInboard.x) };
const slope = (crownAt(skinTop.x + 0.03) - crownAt(skinTop.x - 0.03)) / 0.06;
let crest = { bend: 0, x: NaN, y: NaN };
for (let aft = 0.02; aft <= 0.3; aft += 0.01) {
  const x = skinTop.x - aft;
  const bend = (crownAt(x - 0.02) - crownAt(x)) / 0.02 - (crownAt(x) - crownAt(x + 0.02)) / 0.02;
  if (bend < -0.3 && bend < crest.bend) crest = { bend, x, y: crownAt(x) };
}
const topFromE = angles(E, topInboard, 1).el;
console.log(`BROW: ${airframe.inboardLabel} top-inboard corner (outer face) x ${topInboard.x.toFixed(3)} y ${topInboard.y.toFixed(3)}, ${topFromE.toFixed(1)} deg from E; `
  + `the crown there falls ${(-slope).toFixed(2)} m per metre (${(Math.atan(-slope) * DEG).toFixed(0)} deg)`);
console.log(Number.isFinite(crest.x)
  ? `  crest ${(skinTop.x - crest.x).toFixed(2)} m aft at x ${crest.x.toFixed(2)}, y ${crest.y.toFixed(3)}: ${(crest.y - skinTop.y).toFixed(3)} m above the skin at the glass's top, `
    + `${(crest.y - topInboard.y).toFixed(3)} m above the glass's outer top; the slope turns by ${(-crest.bend).toFixed(2)} m per metre`
  : "  NO CREST in the 0.3 m aft of the glass's top: it sits on the roof");
report.mirrorError = mirrorError;
report.openingFromEyeAhead = ahead;
report.openingFromEyeAtHorizon = asSeen;
report.brow = { topInboard, topFromE, crownSlope: slope, crest };

const json = process.argv.indexOf("--json");
if (json > 0) {
  writeFileSync(process.argv[json + 1]!, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${process.argv[json + 1]}`);
}
visual.dispose();
scene.dispose();
engine.dispose();
