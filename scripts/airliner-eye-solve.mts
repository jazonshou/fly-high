/**
 * Where should the 747's pilot's eye be? Numbers only, from the BUILT meshes.
 *
 * The catalogue's eye was (28.8, 3.1, 0), on the centreline between two seats that
 * stand 2 m behind the glass. The 747's flight-deck glazing is one merged mesh of
 * six thick boxes laid on the nose crown, and the only glass straight ahead of a
 * pilot in the port seat (z -0.72) is the port No.1 pane, so this finds the eye
 * that reads it as far above AND below the horizon as it can, with the PM's
 * constraints, the same as the Global's (`scripts/global-eye-solve.mts`):
 *
 *  1. eye y inside the glazing's own vertical span;
 *  2. straight ahead, the pane's TOP edge reads +T or more and its BOTTOM edge -T
 *     or lower (T is maximised; the gate for building was T >= 9);
 *  3. the eye is at least 0.55 m from the nearest glass (exact point-to-triangle
 *     distance, not a box);
 *  4. at least 0.15 m of skin above it (the first surface overhead).
 *
 * The old panel and the old seats are NOT obstacles: they are interior geometry
 * the cockpit deletes and moves, and they were the reason the old eye could read
 * no more than +5 / -7 (the seats 2 m behind the glass). The deck is built around
 * the eye this finds.
 *
 * Every angle is computed twice, analytically from the boxes' edges cut by the
 * vertical plane through the eye, and by ray-casting the built triangles; they
 * must agree, or one of them misread the world transform.
 *
 *   npx tsx scripts/airliner-eye-solve.mts
 *   EYE_F=29.9 EYE_U=2.93 npx tsx scripts/airliner-eye-solve.mts   # report one eye
 */
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import { createAircraft } from "@/src/render/webgpu/aircraft/createAircraft";
import { INITIAL_VISUAL_STATE } from "@/src/game/types";
import { crossings, distanceToTriangles, worldTriangles } from "./rayCrossings.mts";

const DEG = 180 / Math.PI;
const EYE_RIGHT = -0.72;
const engine = new NullEngine();
const scene = new Scene(engine);
scene.useRightHandedSystem = true;
const visual = createAircraft(scene, "airliner");
visual.update({ ...INITIAL_VISUAL_STATE, gear: 1, onGround: true, altitudeAgl: 0 } as never, 1 / 60);
visual.root.computeWorldMatrix(true);
for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);

function named(name: string): AbstractMesh {
  const found = scene.getMeshByName(name);
  if (!found) throw new Error(`no mesh ${name}`);
  return found;
}
const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "  n/a");
const f3 = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "  n/a");

const glazingMesh = named("airliner-flight-deck-glazing");
const glazing = worldTriangles(glazingMesh);
const shell = worldTriangles(named("airliner-fuselage-shell"));
const paneCount = (glazingMesh.metadata as { mergedFrom: string[] }).mergedFrom.length;
const all = (() => {
  glazingMesh.computeWorldMatrix(true);
  const data = glazingMesh.getVerticesData(VertexBuffer.PositionKind)!;
  const world = glazingMesh.getWorldMatrix();
  const out: Vector3[] = [];
  for (let i = 0; i + 2 < data.length; i += 3) out.push(Vector3.TransformCoordinates(new Vector3(data[i]!, data[i + 1]!, data[i + 2]!), world));
  return out;
})();
const glassY0 = Math.min(...all.map((v) => v.y));
const glassY1 = Math.max(...all.map((v) => v.y));

/**
 * Elevation extremes straight ahead of the glass along the eye's own z, analytically: every box edge cut by the
 * vertical plane z = eye.z ahead of the eye, and the angle of each cut point.
 */
function analyticExtremes(eye: Vector3): { top: number; bottom: number } | null {
  const angles: number[] = [];
  for (let k = 0; k < paneCount; k += 1) {
    const corners = [...new Map(all.slice(k * 24, k * 24 + 24).map((v) => [`${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`, v])).values()];
    // a convex box's silhouette along that plane is the hull of its edges' cuts; the cuts of ALL corner pairs contain every edge's
    for (let i = 0; i < corners.length; i += 1) for (let j = i + 1; j < corners.length; j += 1) {
      const a = corners[i]!;
      const b = corners[j]!;
      const da = a.z - eye.z;
      const db = b.z - eye.z;
      if (da * db > 0 || da === db) continue;
      const p = a.add(b.subtract(a).scale(da / (da - db)));
      if (p.x > eye.x) angles.push(Math.atan2(p.y - eye.y, p.x - eye.x) * DEG);
    }
  }
  return angles.length >= 2 ? { top: Math.max(...angles), bottom: Math.min(...angles) } : null;
}
/** The same two numbers by ray-casting the built triangles in 0.05 degree steps. */
function scannedExtremes(eye: Vector3): { top: number; bottom: number } {
  let top = Number.NaN;
  let bottom = Number.NaN;
  for (let e = 45; e >= -60; e -= 0.05) {
    const r = e / DEG;
    if (crossings(eye, new Vector3(Math.cos(r), Math.sin(r), 0), glazing).length > 0) {
      if (!Number.isFinite(top)) top = e;
      bottom = e;
    }
  }
  return { top, bottom };
}

interface Candidate { x: number; y: number; top: number; bottom: number; glass: number; skin: number; span: boolean }
function evaluate(x: number, y: number): Candidate {
  const eye = new Vector3(x, y, EYE_RIGHT);
  const e = analyticExtremes(eye);
  const skin = crossings(eye, new Vector3(0, 1, 0), shell)[0] ?? Number.NaN;
  return {
    x, y, top: e?.top ?? Number.NaN, bottom: e?.bottom ?? Number.NaN,
    glass: distanceToTriangles(eye, glazing), skin, span: y >= glassY0 - 1e-9 && y <= glassY1 + 1e-9,
  };
}
const feasible = (c: Candidate) => c.span && c.glass >= 0.55 && c.skin >= 0.15;
const T = (c: Candidate) => Math.min(c.top, -c.bottom);

const catalogue = aircraftSpec("airliner").cockpitEye;
console.log(`airliner-eye-solve  catalogue eye (${catalogue.forward}, ${catalogue.up}, ${catalogue.right}); the port seat's line z ${EYE_RIGHT}; glass y span ${f3(glassY0)}..${f3(glassY1)}`);

// ---- CONTROL: the analytic edges and the ray-cast triangles must agree
console.log("\nCONTROL  analytic edge arithmetic vs ray-casting the built triangles, straight ahead, at four eyes");
for (const [x, y] of [[28.8, 3.1], [29.1, 2.95], [29.9, 2.93], [30.4, 2.85]] as const) {
  const a = evaluate(x, y);
  const s = scannedExtremes(new Vector3(x, y, EYE_RIGHT));
  console.log(`  eye (${x}, ${y}): analytic top ${f2(a.top)} bottom ${f2(a.bottom)}   ray-cast top ${f2(s.top)} bottom ${f2(s.bottom)}   |diff| ${f2(Math.max(Math.abs(a.top - s.top), Math.abs(a.bottom - s.bottom)))}`);
}

// ---- THE MAXIMUM
const step = 0.005;
const grid: Candidate[] = [];
for (let x = 29.4; x <= 30.4 + 1e-9; x += step) for (let y = 2.7; y <= 3.15 + 1e-9; y += step) {
  const c = evaluate(Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000);
  if (feasible(c)) grid.push(c);
}
const best = grid.reduce((a, b) => (T(b) > T(a) ? b : a));
console.log(`\nMAXIMISE T over x 29.4..30.4, y 2.7..3.15, step ${step} (${grid.length} points meet the span, glass and skin constraints)`);
console.log(`  best T ${f2(T(best))} at (${best.x}, ${best.y}): top ${f2(best.top)} bottom ${f2(best.bottom)} glass ${f3(best.glass)} skin ${f3(best.skin)}   (bound by the 0.55 m glass distance)`);
const nine = grid.filter((c) => T(c) >= 9);
console.log(`  T >= 9 for x ${f2(Math.min(...nine.map((c) => c.x)))}..${f2(Math.max(...nine.map((c) => c.x)))}, y ${f2(Math.min(...nine.map((c) => c.y)))}..${f2(Math.max(...nine.map((c) => c.y)))} (${nine.length} points)`);
console.log("  the best T at each x:");
for (const x of [29.6, 29.7, 29.8, 29.85, 29.9, 29.92, 29.95, 30.0, 30.1, 30.2]) {
  const at = grid.filter((c) => Math.abs(c.x - x) < step / 2).sort((a, b) => T(b) - T(a))[0];
  console.log(`    x ${x.toFixed(2)}: ${at ? `T ${f2(T(at))} at y ${at.y}: top ${f2(at.top)} bottom ${f2(at.bottom)} glass ${f3(at.glass)} skin ${f3(at.skin)}` : "none (glass < 0.55, or out of the span)"}`);
}

// ---- THE EYE, and any other asked for
const F = Number(process.env.EYE_F ?? catalogue.forward);
const U = Number(process.env.EYE_U ?? catalogue.up);
const chosen = evaluate(F, U);
const s = scannedExtremes(new Vector3(F, U, EYE_RIGHT));
console.log(`\nREPORT for the eye (${F}, ${U}, ${EYE_RIGHT})${process.env.EYE_F ? "" : " = the catalogue's"}`);
console.log(`  span ${chosen.span ? "ok" : "FAILS"};  top ${f2(chosen.top)} bottom ${f2(chosen.bottom)}  T ${f2(T(chosen))} (>= 9: ${T(chosen) >= 9 ? "ok" : "FAILS"});  glass ${f3(chosen.glass)} m (>= 0.55: ${chosen.glass >= 0.55 ? "ok" : "FAILS"});  skin above ${f3(chosen.skin)} m (>= 0.15: ${chosen.skin >= 0.15 ? "ok" : "FAILS"})`);
console.log(`  ray-cast check: top ${f2(s.top)}, bottom ${f2(s.bottom)}`);
