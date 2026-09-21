/**
 * The Global's shell, and how far inside it every cockpit-only part stands.
 *
 * A NullEngine scene, `createAircraft(scene, "bizjet")`, and rays. Two
 * questions, both answered from the BUILT meshes:
 *
 *  1. THE MODEL. `bizjetCockpit.ts` computes the shell's half-width and crown
 *     height in closed form from the fuselage loft's sections (an ellipse of
 *     linearly interpolated radii at every station). Here that model is held to
 *     ray casts at a grid of stations; if the fuselage is ever reshaped the
 *     error column stops being millimetres and every clearance below is void.
 *  2. THE CLEARANCE. For every vertex of every cockpit-only part:
 *       - under the crown at its (x, z): the lateral distance to the wall at
 *         its height, half-width(x, y) - |z|; POSITIVE is inside the shell;
 *       - above the crown: how far above the skin it stands (protrusion);
 *       - where the shell is not that wide at any height (|z| > zRadius at that
 *         station): how far beyond the widest part of the shell it is.
 *     The overhead is expected to fall in the last two: it starts at the glass's
 *     top edge, which at the pilot's z stands above the crown that falls away
 *     sideways. It is cockpit-only and the cockpit camera culls the shell from
 *     inside, so nothing can see it; the numbers say by how much.
 *
 *   npx tsx scripts/bizjet-cockpit-clearance.mts
 */
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Ray } from "@babylonjs/core/Culling/ray";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import { createAircraft } from "@/src/render/webgpu/aircraft/createAircraft";
import {
  BIZJET_POST,
  BIZJET_SILL_Y,
  bizjetPostEndpoints,
  bizjetShellHalfWidth,
  bizjetShellRing,
  bizjetShellTop,
} from "@/src/render/webgpu/aircraft/cockpit/bizjetCockpit";
import { INITIAL_VISUAL_STATE } from "@/src/game/types";

const engine = new NullEngine();
const scene = new Scene(engine);
scene.useRightHandedSystem = true;
const visual = createAircraft(scene, "bizjet");
visual.update({ ...INITIAL_VISUAL_STATE, gear: 1, onGround: true, altitudeAgl: 0 } as never, 1 / 60);
visual.root.computeWorldMatrix(true);
for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);

const fuselage = scene.getMeshByName("bizjet-fuselage");
if (!fuselage) throw new Error("no bizjet-fuselage to measure against");
const eye = aircraftSpec("bizjet").cockpitEye;
const f = (value: number, digits = 3) => (Number.isFinite(value) ? value.toFixed(digits) : "  n/a ");

function castHalfWidth(x: number, y: number): number {
  const hit = scene.pickWithRay(new Ray(new Vector3(x, y, 0), new Vector3(0, 0, -1), 5), (m) => m === fuselage);
  return hit?.hit ? hit.distance : Number.NaN;
}
function castTop(x: number, z: number): number {
  const hit = scene.pickWithRay(new Ray(new Vector3(x, 3, z), new Vector3(0, -1, 0), 8), (m) => m === fuselage);
  return hit?.hit && hit.pickedPoint ? hit.pickedPoint.y : Number.NaN;
}

console.log(`bizjet-cockpit-clearance  eye (${eye.forward}, ${eye.up}, ${eye.right}) from the catalogue`);

// ---- 1. the model against the built mesh ------------------------------------------------
console.log("\nMODEL vs RAY CAST  (metres; |model - cast|)");
let worstWidth = 0;
let worstTop = 0;
for (const x of [11.6, 11.9, 12.2, 12.5, 12.8, 13.1]) {
  for (const y of [-0.15, 0.2, 0.52, 0.65, 0.9]) {
    const m = bizjetShellHalfWidth(x, y);
    const c = castHalfWidth(x, y);
    if (Number.isFinite(m) && Number.isFinite(c)) worstWidth = Math.max(worstWidth, Math.abs(m - c));
  }
  for (const z of [0, -0.26, -0.52, -0.7]) {
    const m = bizjetShellTop(x, z);
    const c = castTop(x, z);
    if (Number.isFinite(m) && Number.isFinite(c)) worstTop = Math.max(worstTop, Math.abs(m - c));
  }
}
console.log(`  half-width at 6 stations x 5 heights: worst error ${f(worstWidth, 5)};  crown height at 6 stations x 4 lateral z: worst error ${f(worstTop, 5)}`);
console.log(`  (a loft's superellipse at squareness 2 is the ellipse; the ring at x 12.5 by the model: ${JSON.stringify(bizjetShellRing(12.5))})`);

// ---- 2. the clearance ------------------------------------------------------------------
function worldVertices(mesh: AbstractMesh): Vector3[] {
  mesh.computeWorldMatrix(true);
  const data = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!data) return [];
  const world = mesh.getWorldMatrix();
  const out: Vector3[] = [];
  for (let i = 0; i + 2 < data.length; i += 3) {
    out.push(Vector3.TransformCoordinates(new Vector3(data[i]!, data[i + 1]!, data[i + 2]!), world));
  }
  return out;
}

const parts = visual.cockpitOnlyParts ?? [];
console.log(`\nCLEARANCE of ${parts.length} cockpit-only meshes (metres). Under the crown: distance to the wall at that height, + is inside. Above the crown: protrusion over the skin. Beyond: past the widest part of the shell.`);
console.log(`  ${"mesh".padEnd(30)}${"under the crown (min .. max, n)".padEnd(46)}${"above the crown (max protrusion, n)".padEnd(50)}beyond the shell (max overhang, n)`);
for (const mesh of parts) {
  const under: { c: number; at: string }[] = [];
  const above: { c: number; at: string }[] = [];
  const beyond: { c: number; at: string }[] = [];
  for (const v of worldVertices(mesh)) {
    if (Math.abs(v.z) < 1e-4) continue;
    const at = `(${f(v.x, 3)}, ${f(v.y, 3)}, ${f(v.z, 3)})`;
    const top = bizjetShellTop(v.x, v.z);
    if (!Number.isFinite(top)) {
      beyond.push({ c: Math.abs(v.z) - bizjetShellRing(v.x).zRadius, at });
    } else if (v.y > top + 1e-4) {
      above.push({ c: v.y - top, at });
    } else {
      // The wall is CAST, not modelled: the built fuselage is a 48-gon inscribed
      // in the model's ellipse, up to 7 mm inside it, and the smallest margins
      // here are millimetres.
      const wall = castHalfWidth(v.x, v.y);
      if (Number.isFinite(wall)) under.push({ c: wall - Math.abs(v.z), at });
    }
  }
  const range = (list: { c: number; at: string }[]) => {
    if (list.length === 0) return "-";
    const lo = list.reduce((a, b) => (b.c < a.c ? b : a));
    const hi = list.reduce((a, b) => (b.c > a.c ? b : a));
    return `${f(lo.c, 4)} .. ${f(hi.c, 4)}  n ${list.length}`;
  };
  const worst = (list: { c: number; at: string }[]) => (list.length === 0 ? "-" : `${f(Math.max(...list.map((e) => e.c)), 4)} n ${list.length}`);
  console.log(`  ${mesh.name.padEnd(30)}${range(under).padEnd(46)}${worst(above).padEnd(50)}${worst(beyond)}`);
  const closest = under.length > 0 ? under.reduce((a, b) => (b.c < a.c ? b : a)) : null;
  if (closest && closest.c < 0.01) console.log(`    tightest under the crown: ${f(closest.c, 4)} at ${closest.at}`);
  const highest = above.length > 0 ? above.reduce((a, b) => (b.c > a.c ? b : a)) : null;
  if (highest) console.log(`    highest above the crown: ${f(highest.c, 4)} at ${highest.at}`);
}

// ---- 3. the overhead at the pilot's own z, and where the posts land ---------------------
const overhead = scene.getMeshByName("bizjet-overhead");
if (overhead) {
  const vs = worldVertices(overhead);
  const front = Math.max(...vs.map((v) => v.x));
  const underside = Math.min(...vs.map((v) => v.y));
  console.log("\nTHE OVERHEAD at the pilot's z and at the centreline, front edge and top face");
  console.log(`  x ${f(Math.min(...vs.map((v) => v.x)), 3)}..${f(front, 3)}, underside y ${f(underside, 3)}, top face y ${f(Math.max(...vs.map((v) => v.y)), 3)}, half-width ${f(Math.max(...vs.map((v) => Math.abs(v.z))), 3)}`);
  for (const z of [0, -0.26, eye.right, -0.7, -0.98]) {
    const skin = bizjetShellTop(front, z);
    const skinAtEye = bizjetShellTop(eye.forward, z);
    console.log(`  z ${f(z, 2)}: crown at its front edge (x ${f(front, 3)}) ${f(skin)}; its underside stands ${f(underside - skin)} above it, its top face ${f(Math.max(...vs.map((v) => v.y)) - skin)}; crown at the eye's x ${f(skinAtEye)}`);
  }
}
console.log("\nTHE LEFT POST");
const { bottom, top } = bizjetPostEndpoints(-1);
const az = (p: Vector3) => (Math.atan2(p.z - eye.right, p.x - eye.forward) * 180) / Math.PI;
const wall = castHalfWidth(bottom.x, bottom.y);
console.log(`  (the wall at the foot: model ${f(bizjetShellHalfWidth(bottom.x, bottom.y), 4)}, cast off the built mesh ${f(wall, 4)})`);
console.log(`  foot (${f(bottom.x)}, ${f(bottom.y)}, ${f(bottom.z)}) at ${f(Math.hypot(bottom.x - eye.forward, bottom.z - eye.right), 3)} m from the eye, azimuth ${f(az(bottom), 2)}; the built shell there is ${f(wall)} out, the post's surface is ${f(Math.abs(bottom.z) + BIZJET_POST.radius)} out: ${f(wall - Math.abs(bottom.z) - BIZJET_POST.radius, 4)} to spare (sill height ${BIZJET_SILL_Y})`);
console.log(`  top  (${f(top.x)}, ${f(top.y)}, ${f(top.z)}) at ${f(Math.hypot(top.x - eye.forward, top.z - eye.right), 3)} m from the eye, azimuth ${f(az(top), 2)}; crown there ${f(bizjetShellTop(top.x, top.z))}`);
scene.dispose();
engine.dispose();
