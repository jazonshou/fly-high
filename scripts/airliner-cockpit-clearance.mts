/**
 * The 747's cockpit, measured: every angle against its target, every clearance from the
 * shell's outer skin, and how far the overhead pokes through the crown. The same shape as
 * `scripts/bizjet-cockpit-clearance.mts`, and the same numbers as
 * `tests/render.cockpit-airliner.test.ts` (which holds them; this prints them).
 *
 *   1. THE EYE against the four constraints it was solved to (T, glass, skin, span);
 *   2. ANGLES FROM THE EYE against their targets: hood, shelf, opening, screens, post,
 *      pillar, seats;
 *   3. CLEARANCE of every cockpit-only mesh from the shell's OUTER skin, with the
 *      overhead's protrusion above the crown and sideways past the skin;
 *   4. what stands behind the glazing's bottom line.
 *
 * THE SHELL'S OUTER SKIN is the LAST crossing of a ray from the centreline: the fuselage and
 * the radome are two overlapping closed lofts, so the FIRST crossing is the fuselage loft's
 * internal wall (0.99 at x 30.5 where the skin is 1.45) and a parity count says "outside"
 * from anywhere inside. All crossings are the mesh's own triangles (`rayCrossings.mts`),
 * not `pickWithRay`, which returns one hit per mesh.
 *
 * A row marked FAIL exits 1.
 *
 *   npx tsx scripts/airliner-cockpit-clearance.mts
 */
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Ray } from "@babylonjs/core/Culling/ray";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import { INITIAL_VISUAL_STATE } from "@/src/game/types";
import { createAircraft } from "@/src/render/webgpu/aircraft/createAircraft";
import {
  AIRLINER_GLAZING,
  AIRLINER_PANEL,
  AIRLINER_POST,
  airlinerHoodTopY,
  airlinerOverheadUndersideY,
  airlinerPanelFaceX,
  airlinerSeamPostEndpoints,
} from "@/src/render/webgpu/aircraft/cockpit/airlinerCockpit";
import { crossings, distanceToTriangles, worldTriangles } from "./rayCrossings.mts";

const DEG = 180 / Math.PI;
const engine = new NullEngine();
const scene = new Scene(engine);
scene.useRightHandedSystem = true;
const camera = new UniversalCamera("clearance-camera", Vector3.Zero(), scene);
scene.activeCamera = camera;
const visual = createAircraft(scene, "airliner");
visual.update({ ...INITIAL_VISUAL_STATE, gear: 1, onGround: true, altitudeAgl: 0 } as never, 1 / 60);
visual.setCockpitView(true);
visual.root.computeWorldMatrix(true);
for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);

const spec = aircraftSpec("airliner");
const EYE = new Vector3(spec.cockpitEye.forward, spec.cockpitEye.up, spec.cockpitEye.right);
const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "  n/a");
const f3 = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "  n/a");
const f4 = (n: number) => (Number.isFinite(n) ? n.toFixed(4) : "  n/a");
let failures = 0;
function row(quantity: string, target: string, measured: number | string, ok: boolean): void {
  if (!ok) failures += 1;
  console.log(`  ${quantity.padEnd(58)} ${target.padEnd(24)} ${String(typeof measured === "number" ? f2(measured) : measured).padEnd(12)} ${ok ? "ok" : "FAIL"}`);
}

function named(name: string): AbstractMesh {
  const found = scene.getMeshByName(name);
  if (!found) throw new Error(`no mesh ${name}`);
  return found;
}
function worldVertices(mesh: AbstractMesh): Vector3[] {
  mesh.computeWorldMatrix(true);
  const data = mesh.getVerticesData(VertexBuffer.PositionKind) ?? [];
  const world = mesh.getWorldMatrix();
  const out: Vector3[] = [];
  for (let i = 0; i + 2 < data.length; i += 3) out.push(Vector3.TransformCoordinates(new Vector3(data[i]!, data[i + 1]!, data[i + 2]!), world));
  return out;
}
const azel = (p: Vector3) => {
  const d = p.subtract(EYE);
  return { az: Math.atan2(d.z, d.x) * DEG, el: Math.atan2(d.y, Math.hypot(d.x, d.z)) * DEG };
};
const direction = (azimuth: number, elevation: number) => {
  const a = azimuth / DEG;
  const e = elevation / DEG;
  return new Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a));
};
const drawn = (mesh: AbstractMesh) => {
  const material = mesh.material as PBRMaterial | null;
  return mesh.isEnabled() && mesh.isVisible && (mesh.layerMask & camera.layerMask) !== 0 && !(material?.needAlphaBlendingForMesh(mesh) ?? false);
};
const firstHit = (az: number, el: number): string | null => {
  const hit = scene.pickWithRay(new Ray(EYE, direction(az, el), 60), drawn);
  return hit?.hit && hit.pickedMesh ? hit.pickedMesh.name : null;
};

const shell = worldTriangles(named("airliner-fuselage-shell"));
const glazing = worldTriangles(named("airliner-flight-deck-glazing"));
const outerHalfWidth = (x: number, y: number, side: 1 | -1) => {
  const hits = crossings(new Vector3(x, y, 0), new Vector3(0, 0, side), shell);
  return hits.length > 0 ? hits[hits.length - 1]! : Number.NaN;
};
const crownAbove = (x: number, z: number) => {
  const hits = crossings(new Vector3(x, 2.4, z), new Vector3(0, 1, 0), shell);
  return hits.length > 0 ? 2.4 + hits[hits.length - 1]! : Number.NaN;
};
function glassExtent(azimuth: number): { top: number; bottom: number } | null {
  let top = Number.NaN;
  let bottom = Number.NaN;
  for (let e = 40; e >= -40; e -= 0.05) {
    if (crossings(EYE, direction(azimuth, e), glazing).length > 0) {
      if (!Number.isFinite(top)) top = e;
      bottom = e;
    }
  }
  return Number.isFinite(top) ? { top, bottom } : null;
}
function openingTop(azimuth: number): number {
  for (let e = 30; e >= -30; e -= 0.02) if (firstHit(azimuth, e) !== "airliner-cockpit-interior") return e;
  return Number.NaN;
}

console.log(`airliner-cockpit-clearance  eye (${EYE.x}, ${EYE.y}, ${EYE.z}) from the catalogue; the port seat's line`);

// ---- 1. the eye ------------------------------------------------------------------------
console.log("\n1. THE EYE against the constraints it was solved to (scripts/airliner-eye-solve.mts)");
console.log(`  ${"quantity".padEnd(58)} ${"target".padEnd(24)} ${"measured".padEnd(12)}`);
const glass0 = glassExtent(0)!;
const glassY = worldVertices(named("airliner-flight-deck-glazing")).map((v) => v.y);
row("the port No.1 pane's top edge straight ahead (deg)", "+9 or more", glass0.top, glass0.top >= 9);
row("the port No.1 pane's bottom edge straight ahead (deg)", "-9 or lower", glass0.bottom, glass0.bottom <= -9);
row("T = min(top, -bottom) (deg)", ">= 9 (the gate)", Math.min(glass0.top, -glass0.bottom), Math.min(glass0.top, -glass0.bottom) >= 9);
const glassDistance = distanceToTriangles(EYE, glazing);
row("distance to the nearest glass (m)", ">= 0.55", glassDistance, glassDistance >= 0.55);
const skin = crossings(EYE, new Vector3(0, 1, 0), shell)[0]!;
row("skin above the eye (m)", ">= 0.15", skin, skin >= 0.15);
row("the eye's y inside the glazing's vertical span", `${f3(Math.min(...glassY))}..${f3(Math.max(...glassY))}`, EYE.y, EYE.y >= Math.min(...glassY) && EYE.y <= Math.max(...glassY));

// ---- 2. angles -----------------------------------------------------------------------------
console.log("\n2. ANGLES FROM THE EYE against their targets (75 degree lens: the frame is az +-37.5, el +-23.3 at the centre line)");
console.log(`  ${"quantity".padEnd(58)} ${"target".padEnd(24)} ${"measured".padEnd(12)}`);
const farX = airlinerPanelFaceX() + AIRLINER_PANEL.thickness;
const hoodFar = Math.atan2(airlinerHoodTopY() - EYE.y, farX - EYE.x) * DEG;
row("hood's far top edge straight ahead (deg)", "-10.0 +-0.1", hoodFar, Math.abs(hoodFar + 10) < 0.1);
const hoodUnder = Math.atan2(airlinerHoodTopY() - AIRLINER_PANEL.hoodThickness - EYE.y, airlinerPanelFaceX() - AIRLINER_PANEL.hoodOverhang - EYE.x) * DEG;
row("hood's aft edge underside (deg)", "(the line below which the board shows)", hoodUnder, true);
let shelf = Number.NaN;
for (let e = 5; e >= -25; e -= 0.02) if (firstHit(0, e) === "airliner-glareshield") { shelf = e; break; }
row("the shelf's top edge straight ahead (deg)", `over the glass's ${f2(glass0.bottom)}`, shelf, shelf > glass0.bottom && shelf < -8.5);
row("  (the hood's far edge without the dash, below the glass's bottom)", "-10.0 < glass bottom", hoodFar, hoodFar < glass0.bottom);
const top0 = openingTop(0);
row("the opening's top edge straight ahead (deg)", `at or under the glass's ${f2(glass0.top)}`, top0, top0 <= glass0.top + 0.05 && top0 > glass0.top - 1.6);
for (const az of [-30, -20, -8, 4]) {
  const g = glassExtent(az);
  const t = openingTop(az);
  row(`  opening top at azimuth ${az}, glass top ${g ? f2(g.top) : "n/a"}`, "not above the glass", t, !g || t <= g.top + 0.05);
}
const screens = named("airliner-screens");
const screenVertices = worldVertices(screens);
const screenCentres = [0, 1, 2, 3, 4, 5].map((k) => screenVertices.slice(k * 24, k * 24 + 24).reduce((s, v) => s.add(v), Vector3.Zero()).scale(1 / 24));
const targets: [string, number, number, number][] = [["PFD (the pilot's own)", 0, -0.5, 0.5], ["ND", 1, 17.5, 19], ["EICAS", 2, 32.5, 34.5]];
for (const [label, k, lo, hi] of targets) {
  const a = azel(screenCentres[k]!);
  row(`screen ${k + 1} ${label}: azimuth (deg), elevation ${f2(a.el)}`, `${lo}..${hi}`, a.az, a.az >= lo && a.az <= hi);
}
row("screens in the frame (az +-37.5) of six", "3", screenCentres.filter((c) => Math.abs(azel(c).az) < 37.5).length, screenCentres.filter((c) => Math.abs(azel(c).az) < 37.5).length === 3);
const pfd = screenVertices.slice(0, 24);
const screenTopEl = Math.atan2(Math.max(...pfd.map((v) => v.y)) - EYE.y, Math.min(...pfd.map((v) => v.x)) - EYE.x) * DEG;
row("screens' top edge (deg), 1.5 under the hood's underside", `${f2(hoodUnder - 1.5)} +-0.1`, screenTopEl, Math.abs(screenTopEl - (hoodUnder - 1.5)) < 0.1);
// `airliner-cockpit-interior` is the board, the overhead, the pillar and the post merged, in that order: 24, 60, 36 and 38 vertices
const INTERIOR = { board: [0, 24], overhead: [24, 84], pillar: [84, 120], post: [120, 158] } as const;
const interiorVertices = worldVertices(named("airliner-cockpit-interior"));
if (interiorVertices.length !== 158) throw new Error(`the interior mesh has ${interiorVertices.length} vertices, not 158: its parts changed`);
const interiorPart = (which: keyof typeof INTERIOR) => interiorVertices.slice(INTERIOR[which][0], INTERIOR[which][1]);
const post = interiorPart("post");
const foot = post.reduce((a, b) => (b.y < a.y ? b : a));
const design = airlinerSeamPostEndpoints();
row("seam post's foot azimuth (deg), elevation " + f2(azel(foot).el), "-30..-22", azel(foot).az, azel(foot).az > -30 && azel(foot).az < -22);
row("seam post's DESIGN top azimuth (deg), elevation " + f2(azel(design.top).el), "-16..-12", azel(design.top).az, azel(design.top).az > -16 && azel(design.top).az < -12);
// the mesh runs on past the design top (AIRLINER_POST.buryMetres): its cut end lies above the overhead's underside, so it is never shown
const designAxis = design.top.subtract(design.bottom).normalize();
const designLength = Vector3.Distance(design.top, design.bottom);
const topEnd = post.filter((v) => Vector3.Dot(v.subtract(design.bottom), designAxis) > designLength + AIRLINER_POST.buryMetres - 1e-3);
row("post's top end cap: lowest vertex above the overhead's underside (m)", "> 0.01", Math.min(...topEnd.map((v) => v.y)) - airlinerOverheadUndersideY(), Math.min(...topEnd.map((v) => v.y)) - airlinerOverheadUndersideY() > 0.01);
const pillar = interiorPart("pillar");
const bottomCorner = pillar.reduce((a, b) => (b.y < a.y ? b : a));
row("pillar's lowest vertex azimuth (deg), elevation " + f2(azel(bottomCorner).el), "(the crown gap: +3..+35)", azel(bottomCorner).az, azel(bottomCorner).az > -5 && azel(bottomCorner).az < 40);
const overhead = interiorPart("overhead");
row("overhead's underside y", `${f3(AIRLINER_GLAZING.lowestTopY)} (lowest pane top)`, Math.min(...overhead.map((v) => v.y)), Math.abs(Math.min(...overhead.map((v) => v.y)) - airlinerOverheadUndersideY()) < 1e-3);
const seats = worldVertices(named("airliner-flight-deck-interior"));
const pilotSeat = seats.slice(48, 72);
row("port seat centre aft of the eye (m)", "0.05", EYE.x - pilotSeat.reduce((s, v) => s + v.x, 0) / 24, Math.abs(EYE.x - pilotSeat.reduce((s, v) => s + v.x, 0) / 24 - 0.05) < 0.002);
row("port seat's top below the eye (m)", "0.15", EYE.y - Math.max(...pilotSeat.map((v) => v.y)), Math.abs(EYE.y - Math.max(...pilotSeat.map((v) => v.y)) - 0.15) < 0.002);

// ---- 3. clearance ------------------------------------------------------------------------------
console.log("\n3. CLEARANCE of every cockpit-only mesh from the shell's OUTER skin (metres; + is inside). Under: below the crown; measured at each vertex's height by the last crossing of a ray from the centreline.");
console.log(`  ${"mesh".padEnd(34)}${"tightest".padEnd(12)}${"loosest".padEnd(12)}${"n".padEnd(6)}${"outside (n, worst)".padEnd(24)}`);
const parts = visual.cockpitOnlyParts ?? [];
for (const part of parts) {
  const overheadPart = part.name === "airliner-cockpit-interior";
  // the interior mesh is the board, the overhead, the pillar and the post: the board is measured here (the overhead pokes through on purpose, the pillar and the post are compared with the panes' corners below)
  const list = overheadPart ? interiorPart("board") : worldVertices(part);
  const clearances: number[] = [];
  for (const v of list) {
    if (Math.abs(v.z) < 1e-4) continue;
    const wall = outerHalfWidth(v.x, v.y, v.z < 0 ? -1 : 1);
    if (Number.isFinite(wall)) clearances.push(wall - Math.abs(v.z));
  }
  if (clearances.length === 0) {
    console.log(`  ${(part.name + (overheadPart ? " (board only)" : "")).padEnd(34)}${"(no wall at those heights)"}`);
    continue;
  }
  const out = clearances.filter((c) => c < 0);
  console.log(`  ${(part.name + (overheadPart ? " (board only)" : "")).padEnd(34)}${f4(Math.min(...clearances)).padEnd(12)}${f4(Math.max(...clearances)).padEnd(12)}${String(clearances.length).padEnd(6)}${out.length === 0 ? "-" : `${out.length}, ${f4(Math.min(...out))}`}`);
}
console.log("\n   THE PILLAR AND THE POST are placed against the glazing's own built corners, and the panes stand half proud of the skin, so they poke out too;");
console.log("   for comparison, the port No.1 pane's own inner-face corners and the port No.2 pane's forward edge, against the same outer skin:");
for (const [label, c] of [
  ["No.1 bottom inboard", AIRLINER_GLAZING.portOneInner.bottomInboard], ["No.1 bottom outboard", AIRLINER_GLAZING.portOneInner.bottomOutboard],
  ["No.1 top outboard", AIRLINER_GLAZING.portOneInner.topOutboard], ["No.1 top inboard", AIRLINER_GLAZING.portOneInner.topInboard],
  ["No.2 forward bottom", AIRLINER_GLAZING.portTwoForwardInner.bottom], ["No.2 forward top", AIRLINER_GLAZING.portTwoForwardInner.top],
] as const) {
  const wall = outerHalfWidth(c[0], c[1], -1);
  console.log(`     pane corner ${label.padEnd(22)} (${f3(c[0])}, ${f3(c[1])}, ${f3(c[2])})  clearance ${f3(wall - Math.abs(c[2]))}`);
}
console.log("\n   THE OVERHEAD pokes through the skin on purpose (cockpit-only; the shell is hidden from the cockpit camera):");
let worst = 0;
let where = "";
for (const v of overhead) {
  const crown = crownAbove(v.x, v.z);
  if (Number.isFinite(crown) && v.y - crown > worst) {
    worst = v.y - crown;
    where = `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
  }
}
const sideways = Math.max(...overhead.map((v) => {
  const wall = outerHalfWidth(v.x, Math.min(v.y, 3.0), v.z < 0 ? -1 : 1);
  return Number.isFinite(wall) ? Math.abs(v.z) - wall : 0;
}));
console.log(`   greatest protrusion above the crown ${f3(worst)} m at ${where}; sideways past the skin ${f3(sideways)} m (the Global's: 0.846 m above)`);
for (const [x, z] of [[30.4, -0.72], [30.86, -0.72], [31.0, -0.72], [31.2, -0.72], [31.47, -0.30], [31.47, 0]] as const) {
  console.log(`   crown at x ${x.toFixed(2)}, z ${z.toFixed(2)}: ${f3(crownAbove(x, z))}   (the overhead's top face is ${f3(airlinerOverheadUndersideY() + 0.03)})`);
}
console.log("\n   The panel's half-width is the shell's outer half-width at the hood's far top edge less 2 cm:");
console.log(`   outer half-width at (x ${f3(farX)}, y ${f3(airlinerHoodTopY())}) = ${f3(outerHalfWidth(farX, airlinerHoodTopY(), -1))}; panel half-width ${AIRLINER_PANEL.halfWidth}; clearance ${f3(outerHalfWidth(farX, airlinerHoodTopY(), -1) - AIRLINER_PANEL.halfWidth)}`);

// ---- 4. behind the glazing's bottom line ------------------------------------------------------
console.log(`\n4. WHAT STANDS BEHIND THE GLAZING'S BOTTOM LINE (x ${AIRLINER_GLAZING.portOneInner.bottomInboard[0]}); the pillar's plate is 0.04 thick, so it stands 1.4 cm past`);
for (const part of parts) {
  const maxX = Math.max(...worldVertices(part).map((v) => v.x));
  const ok = maxX <= AIRLINER_GLAZING.portOneInner.bottomInboard[0] + 0.02;
  if (!ok) failures += 1;
  console.log(`  ${part.name.padEnd(34)} reaches x ${f3(maxX)}  ${ok ? "ok" : "FAIL"}`);
}
const post2 = airlinerSeamPostEndpoints();
console.log(`\n   seam post from (${f3(post2.bottom.x)}, ${f3(post2.bottom.y)}, ${f3(post2.bottom.z)}) to (${f3(post2.top.x)}, ${f3(post2.top.y)}, ${f3(post2.top.z)}), radius 0.025`);

console.log(failures === 0 ? "\nall rows ok" : `\n${failures} row(s) FAIL`);
process.exitCode = failures === 0 ? 0 : 1;
