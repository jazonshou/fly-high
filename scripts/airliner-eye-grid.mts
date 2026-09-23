/**
 * Candidate 747 left-seat eyes against the BUILT flight-deck glass: the table the catalogue's
 * `cockpitEye` was chosen from (docs/findings/COCKPIT_VIEW_2026_09_20.md, K0).
 *
 * For each eye on a 0.05 m grid (lateral 0.45..0.60 to port, forward +-0.30 about 29.9), at the
 * eye's height (`--up`, default the catalogue's), it reads:
 *
 *   No.1     the port No.1 pane's run of azimuths at the horizon, and whether straight ahead
 *            falls in its middle third;
 *   pillar   the gap outboard of it, where the No.1 / No.2 pillar stands;
 *   post     the centre post's run of azimuths;
 *   opening  No.1's elevation extent through the middle of its run;
 *   glass    the distance to the nearest pane straight ahead.
 *
 * THE APERTURE IS THE PANES' OUTER FACES, rebuilt from each `skinPanel` grid as it is built (the
 * glazing table's own method): a sightline through a pillar gap that grazes a pane's rim is not
 * glass. The targets are the brief's: lateral 0.50..0.55, straight ahead in No.1's middle third,
 * the post at +10..+16, an opening of 28 degrees or more, 1.4 m of glass or more. A row that meets
 * them all is marked **.
 *
 *   npx tsx scripts/airliner-eye-grid.mts [--up <metres>]
 */
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { aircraftSpec } from "../src/aircraft/catalogue";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import { AircraftBuildContext, type SurfacePatch } from "../src/render/webgpu/aircraft/builders";
import { hitTriangle, type Triangle } from "./rayCrossings.mts";

interface Captured { name: string; rows: number; columns: number; positions: number[] }
const captured: Captured[] = [];
const original = AircraftBuildContext.prototype.skinPanel;
AircraftBuildContext.prototype.skinPanel = function (this: AircraftBuildContext, ...args: Parameters<typeof original>) {
  const mesh = original.apply(this, args);
  const points = args[1] as SurfacePatch;
  captured.push({ name: args[0], rows: points.length, columns: points[0]!.length, positions: Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!) });
  return mesh;
};
const outerFace = (pane: Captured): Triangle[] => {
  const v = (row: number, column: number) => {
    const i = (row * pane.columns + column) * 3;
    return new Vector3(pane.positions[i]!, pane.positions[i + 1]!, pane.positions[i + 2]!);
  };
  const out: Triangle[] = [];
  for (let row = 0; row < pane.rows - 1; row += 1) {
    for (let column = 0; column < pane.columns - 1; column += 1) {
      out.push({ a: v(row, column), b: v(row, column + 1), c: v(row + 1, column) });
      out.push({ a: v(row, column + 1), b: v(row + 1, column + 1), c: v(row + 1, column) });
    }
  }
  return out;
};

const upFlag = process.argv.indexOf("--up");
const up = upFlag >= 0 ? Number(process.argv[upFlag + 1]) : aircraftSpec("airliner").cockpitEye.up;
if (!Number.isFinite(up)) throw new Error("--up needs a height in metres");

const engine = new NullEngine();
const scene = new Scene(engine);
scene.useRightHandedSystem = true;
createWebGpuAircraft(scene, "airliner");
AircraftBuildContext.prototype.skinPanel = original;
const glass = (name: string) => {
  const pane = captured.find((c) => c.name === name);
  if (!pane) throw new Error(`no skin panel ${name} was built`);
  return outerFace(pane);
};
const sets: [string, Triangle[]][] = [
  ["post", glass("airliner-windscreen-center-post")],
  ["port-one", glass("port-airliner-flight-deck-window-one")],
  ["port-two", glass("port-airliner-flight-deck-window-two")],
  ["starboard-one", glass("starboard-airliner-flight-deck-window-one")],
];
const DEG = 180 / Math.PI;
const dir = (az: number, el: number) => new Vector3(Math.cos(el / DEG) * Math.cos(az / DEG), Math.sin(el / DEG), Math.cos(el / DEG) * Math.sin(az / DEG));
const nearest = (o: Vector3, d: Vector3, triangles: readonly Triangle[]) => {
  let best = Number.POSITIVE_INFINITY;
  for (const t of triangles) {
    const h = hitTriangle(o, d, t);
    if (Number.isFinite(h) && h > 1e-4 && h < best) best = h;
  }
  return best;
};

function measure(eye: Vector3) {
  const runs: { what: string; from: number; to: number }[] = [];
  for (let az = -45; az <= 45.0001; az += 0.1) {
    let what = "-";
    let best = Number.POSITIVE_INFINITY;
    for (const [name, triangles] of sets) {
      const h = nearest(eye, dir(az, 0), triangles);
      if (h < best) {
        best = h;
        what = name;
      }
    }
    const last = runs.at(-1);
    if (last && last.what === what) last.to = az;
    else runs.push({ what, from: az, to: az });
  }
  const one = runs.filter((r) => r.what === "port-one").sort((a, b) => (b.to - b.from) - (a.to - a.from))[0] ?? null;
  const index = one ? runs.indexOf(one) : -1;
  const pillar = index > 0 && runs[index - 1]!.what === "-" ? runs[index - 1]! : null;
  const post = runs.find((r) => r.what === "post") ?? null;
  let opening = 0;
  if (one) {
    let run = 0;
    for (let el = -35; el <= 35; el += 0.1) {
      if (Number.isFinite(nearest(eye, dir((one.from + one.to) / 2, el), sets[1]![1]))) {
        run += 0.1;
        opening = Math.max(opening, run);
      } else run = 0;
    }
  }
  const glassAhead = Math.min(...sets.slice(1).map(([, triangles]) => nearest(eye, dir(0, 0), triangles)));
  return { one, pillar, post, opening, glassAhead };
}

const span = (r: { from: number; to: number } | null) => (r ? `${r.from.toFixed(1)}..${r.to.toFixed(1)}` : "none");
console.log(`747 eye grid at up ${up}: the panes' outer faces, as built`);
for (const lateral of [0.45, 0.5, 0.55, 0.6]) {
  for (let k = -6; k <= 6; k += 1) {
    const forward = +(29.9 + k * 0.05).toFixed(2);
    const m = measure(new Vector3(forward, up, -lateral));
    const third = m.one ? (m.one.to - m.one.from) / 3 : 0;
    const middleThird = m.one ? m.one.from + third <= 0 && 0 <= m.one.to - third : false;
    const postOk = m.post ? m.post.from >= 10 && m.post.to <= 16 : false;
    const all = lateral >= 0.5 && lateral <= 0.55 && middleThird && postOk && m.opening >= 28 && m.glassAhead >= 1.4;
    console.log(`${all ? "**" : "  "} lateral ${lateral.toFixed(2)} forward ${forward.toFixed(2)} | No.1 ${span(m.one)}${middleThird ? " (ahead in the middle third)" : ""} | pillar ${span(m.pillar)} | post ${span(m.post)} | opening ${m.opening.toFixed(1)} | glass ${m.glassAhead.toFixed(2)}`);
  }
}
scene.dispose();
engine.dispose();
