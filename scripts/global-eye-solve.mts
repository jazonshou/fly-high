/**
 * Where should the Global's pilot's eye be? Numbers only, from the BUILT meshes.
 *
 * The catalogue puts the bizjet eye at (11.6, 1.05, -0.52). The windscreen pane
 * is a thick slab centred at y 0.70, 0.56 tall, raked 34 degrees from the
 * vertical, so its top edge is at y 0.98 at most and the eye stands ABOVE it: the
 * whole windscreen is below the pilot's horizon. This finds an eye that sits in
 * the glass's own vertical span, with the four constraints the PM set:
 *
 *  1. eye y between 0.72 and 0.85;
 *  2. straight ahead of the pilot (the z = -0.52 line) the windscreen's TOP edge
 *     reads +14 to +18 degrees and its BOTTOM edge reads -14 or lower;
 *  3. the eye is at least 0.55 m from the nearest point of the windscreen glass;
 *  4. the eye is inside the fuselage with at least 0.15 m to the skin above it.
 *
 * The lateral offset stays -0.52 (over the port seat, which is the pilot's; the
 * meshes called "captain" are on the STARBOARD side).
 *
 * Every angle is computed twice: analytically from the pane's corners, and by
 * RAY-CASTING the built mesh in the vertical plane through the eye. The two must
 * agree; if the world transform or the rotation's sign were misread, the corner
 * arithmetic would still be self-consistent and only the ray would disagree
 * (see units-errors-need-ground-truth).
 *
 *   npx tsx scripts/global-eye-solve.mts
 */
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Ray } from "@babylonjs/core/Culling/ray";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import { createAircraft } from "@/src/render/webgpu/aircraft/createAircraft";
import { INITIAL_VISUAL_STATE } from "@/src/game/types";

const DEG = 180 / Math.PI;
const engine = new NullEngine();
const scene = new Scene(engine);
scene.useRightHandedSystem = true;
const visual = createAircraft(scene, "bizjet");
visual.update({ ...INITIAL_VISUAL_STATE, gear: 1, onGround: true, altitudeAgl: 0 } as never, 1 / 60);
visual.root.computeWorldMatrix(true);
for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);

const catalogue = aircraftSpec("bizjet").cockpitEye;
const EYE_RIGHT = catalogue.right;

function named(name: string): AbstractMesh {
  const found = scene.getMeshByName(name);
  if (!found) throw new Error(`no mesh ${name}`);
  return found;
}
const windscreen = named("bizjet-windscreen");
const sideWindows = [named("port-bizjet-flight-deck-window"), named("starboard-bizjet-flight-deck-window")];
const post = named("bizjet-windscreen-center-post");
const fuselage = named("bizjet-fuselage");
const radome = named("bizjet-radome");
// The seat on the PORT side (negative z) is the pilot's; the meshes' names are the other way round.
const seats = scene.meshes.filter((m) => /seat$/.test(m.name) && m.name.startsWith("bizjet-"));
const headrests = scene.meshes.filter((m) => /headrest$/.test(m.name) && m.name.startsWith("bizjet-"));

function worldVertices(mesh: AbstractMesh): Vector3[] {
  mesh.computeWorldMatrix(true);
  const data = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const world = mesh.getWorldMatrix();
  const out: Vector3[] = [];
  for (let i = 0; i + 2 < data.length; i += 3) {
    out.push(Vector3.TransformCoordinates(new Vector3(data[i]!, data[i + 1]!, data[i + 2]!), world));
  }
  return out;
}
const az = (eye: Vector3, p: Vector3) => Math.atan2(p.z - eye.z, p.x - eye.x) * DEG;
const el = (eye: Vector3, p: Vector3) => Math.atan2(p.y - eye.y, Math.hypot(p.x - eye.x, p.z - eye.z)) * DEG;
const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "  n/a");
const f3 = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "  n/a");

/** Distance from the eye to the nearest point of a box mesh: clamp the eye into the box in its own frame. */
function distanceToBox(eye: Vector3, mesh: AbstractMesh): number {
  mesh.computeWorldMatrix(true);
  const box = mesh.getBoundingInfo().boundingBox;
  const inverse = Matrix.Invert(mesh.getWorldMatrix());
  const local = Vector3.TransformCoordinates(eye, inverse);
  const clamped = new Vector3(
    Math.min(Math.max(local.x, box.minimum.x), box.maximum.x),
    Math.min(Math.max(local.y, box.minimum.y), box.maximum.y),
    Math.min(Math.max(local.z, box.minimum.z), box.maximum.z),
  );
  return Vector3.Distance(Vector3.TransformCoordinates(clamped, mesh.getWorldMatrix()), eye);
}
/** Distance along `direction` from `eye` to the first surface of any of `meshes`, or NaN. */
function castDistance(eye: Vector3, direction: Vector3, meshes: AbstractMesh[]): number {
  let best = Number.NaN;
  for (const mesh of meshes) {
    const hit = scene.pickWithRay(new Ray(eye, direction, 20), (m) => m === mesh);
    if (hit?.hit && !(hit.distance >= best)) best = hit.distance;
  }
  return best;
}

/** The windscreen's elevation extremes straight ahead (az 0, in the vertical plane through the eye), by corner arithmetic. */
function analyticExtremes(eye: Vector3): { top: number; bottom: number } {
  const corners = worldVertices(windscreen).filter((v) => Math.abs(v.z - windscreen.getBoundingInfo().boundingBox.centerWorld.z) > 0.7);
  const seen = new Set<string>();
  const xy = corners.filter((v) => {
    const key = `${v.x.toFixed(4)},${v.y.toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return v.z > 0;
  });
  // In the plane z = eye.z the pane's cross-section is the same rectangle, so an
  // elevation is atan2(dy, dx) with dz = 0.
  const angles = xy.map((v) => Math.atan2(v.y - eye.y, v.x - eye.x) * DEG);
  return { top: Math.max(...angles), bottom: Math.min(...angles) };
}
/** The same two numbers by ray-casting the mesh in 0.02 degree steps at az 0. */
function scannedExtremes(eye: Vector3): { top: number; bottom: number } {
  let top = Number.NaN;
  let bottom = Number.NaN;
  for (let e = 45; e >= -60; e -= 0.02) {
    const r = e / DEG;
    const hit = scene.pickWithRay(new Ray(eye, new Vector3(Math.cos(r), Math.sin(r), 0), 20), (m) => m === windscreen);
    if (hit?.hit) {
      if (!Number.isFinite(top)) top = e;
      bottom = e;
    }
  }
  return { top, bottom };
}

interface Candidate {
  f: number;
  u: number;
  top: number;
  bottom: number;
  glass: number;
  skinAbove: number;
  ok: boolean;
}
function evaluate(f: number, u: number): Candidate {
  const eye = new Vector3(f, u, EYE_RIGHT);
  const { top, bottom } = analyticExtremes(eye);
  const glass = distanceToBox(eye, windscreen);
  const skinAbove = castDistance(eye, new Vector3(0, 1, 0), [fuselage, radome]);
  const ok = u >= 0.72 - 1e-9 && u <= 0.85 + 1e-9 && top >= 14 && top <= 18 && bottom <= -14 && glass >= 0.55 && skinAbove >= 0.15;
  return { f, u, top, bottom, glass, skinAbove, ok };
}

console.log(`global-eye-solve  catalogue eye (${catalogue.forward}, ${catalogue.up}, ${catalogue.right}); lateral offset held at ${EYE_RIGHT}`);
const box = windscreen.getBoundingInfo().boundingBox;
console.log(`windscreen: centre (${f3(box.centerWorld.x)}, ${f3(box.centerWorld.y)}, ${f3(box.centerWorld.z)}), rotation.z ${windscreen.rotation.z}, world vertices ${worldVertices(windscreen).length}`);
const cornerXy: string[] = [];
const uniq = new Map<string, Vector3>();
for (const v of worldVertices(windscreen)) if (v.z > 0) uniq.set(`${v.x.toFixed(3)},${v.y.toFixed(3)}`, v);
for (const v of uniq.values()) cornerXy.push(`(x ${f3(v.x)}, y ${f3(v.y)})`);
console.log(`  pane cross-section corners: ${cornerXy.join("  ")}`);

// ---- CONTROL: the analytic corners and the ray-cast mesh must agree, at the old eye and at a new one.
console.log("\nCONTROL  analytic corner arithmetic vs ray-casting the built mesh, straight ahead (az 0)");
for (const [f, u] of [[catalogue.forward, catalogue.up], [11.95, 0.78], [11.7, 0.9]] as const) {
  const eye = new Vector3(f, u, EYE_RIGHT);
  const a = analyticExtremes(eye);
  const s = scannedExtremes(eye);
  console.log(`  eye (${f}, ${u}): analytic top ${f2(a.top)} bottom ${f2(a.bottom)}   ray-cast top ${f2(s.top)} bottom ${f2(s.bottom)}   |diff| ${f2(Math.max(Math.abs(a.top - s.top), Math.abs(a.bottom - s.bottom)))}`);
}

// ---- THE FEASIBLE REGION
console.log("\nFEASIBLE REGION  (u 0.72..0.85, top +14..+18, bottom <= -14, glass >= 0.55 m, skin above >= 0.15 m); forward scanned 11.30..12.60 step 0.01, up step 0.01");
const grid: Candidate[] = [];
for (let f = 11.3; f <= 12.6 + 1e-9; f += 0.01) {
  for (let u = 0.72; u <= 0.85 + 1e-9; u += 0.01) grid.push(evaluate(f, u));
}
const feasible = grid.filter((c) => c.ok);
console.log(`  ${feasible.length} of ${grid.length} grid points satisfy all four`);
for (const u of [0.72, 0.75, 0.78, 0.8, 0.82, 0.85]) {
  const row = feasible.filter((c) => Math.abs(c.u - u) < 1e-6);
  console.log(`  up ${u.toFixed(2)}: ${row.length === 0 ? "none" : `forward ${f2(Math.min(...row.map((c) => c.f)))} .. ${f2(Math.max(...row.map((c) => c.f)))}`}`);
}
console.log("  which constraint binds at the edge, for up 0.78 (forward, top, bottom, glass distance, skin above):");
for (let f = 11.7; f <= 12.3 + 1e-9; f += 0.05) {
  const c = evaluate(f, 0.78);
  const why = [c.top < 14 ? "top<14" : "", c.top > 18 ? "top>18" : "", c.bottom > -14 ? "bottom>-14" : "", c.glass < 0.55 ? "glass<0.55" : "", c.skinAbove < 0.15 ? "skin<0.15" : ""].filter(Boolean).join(",");
  console.log(`    f ${f2(c.f)}  top ${f2(c.top)}  bottom ${f2(c.bottom)}  glass ${f3(c.glass)}  skin ${f3(c.skinAbove)}  ${c.ok ? "OK" : "FAILS " + why}`);
}

// ---- REPORT ON A CHOSEN EYE (default: the centre of the feasible region at up 0.78, or argv)
const argF = process.env.EYE_F ? Number(process.env.EYE_F) : undefined;
const argU = process.env.EYE_U ? Number(process.env.EYE_U) : undefined;
const at78 = feasible.filter((c) => Math.abs(c.u - 0.78) < 1e-6);
const centre = at78.length > 0 ? (Math.min(...at78.map((c) => c.f)) + Math.max(...at78.map((c) => c.f))) / 2 : 12.0;
const F = argF ?? Math.round(centre * 100) / 100;
const U = argU ?? 0.78;
const eye = new Vector3(F, U, EYE_RIGHT);
console.log(`\nREPORT for the eye (${F}, ${U}, ${EYE_RIGHT})`);
const chosen = evaluate(F, U);
console.log(`  constraints: eye y ${U} (0.72..0.85: ${U >= 0.72 && U <= 0.85 ? "ok" : "FAILS"});  top ${f2(chosen.top)} (+14..+18: ${chosen.top >= 14 && chosen.top <= 18 ? "ok" : "FAILS"});  bottom ${f2(chosen.bottom)} (<= -14: ${chosen.bottom <= -14 ? "ok" : "FAILS"});  glass ${f3(chosen.glass)} m (>= 0.55: ${chosen.glass >= 0.55 ? "ok" : "FAILS"});  skin above ${f3(chosen.skinAbove)} m (>= 0.15: ${chosen.skinAbove >= 0.15 ? "ok" : "FAILS"})`);
const s = scannedExtremes(eye);
console.log(`  ray-cast check straight ahead: top ${f2(s.top)}, bottom ${f2(s.bottom)}`);

console.log("\n  WINDSCREEN, its eight corners (az, el from the eye; the frame is az +-37.5, el +-23.35 at the centre)");
const seenCorner = new Set<string>();
const paneVertices = worldVertices(windscreen);
const paneMid = box.centerWorld.y;
const meanX = (upper: boolean) => {
  const group = paneVertices.filter((v) => (v.y > paneMid) === upper);
  return group.reduce((sum, v) => sum + v.x, 0) / group.length;
};
for (const v of paneVertices.sort((a, b) => a.z - b.z || b.y - a.y || a.x - b.x)) {
  const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
  if (seenCorner.has(key)) continue; // a box has three vertices at each corner, one per face
  seenCorner.add(key);
  const upper = v.y > paneMid;
  // 'back' is the face toward the pilot: the smaller x of the two corners at that height.
  const which = `${v.z < 0 ? "left " : "right"} ${upper ? "top   " : "bottom"} ${v.x < meanX(upper) ? "back " : "front"}`;
  console.log(`    ${which} (x ${f3(v.x)}, y ${f3(v.y)}, z ${f3(v.z)})  az ${f2(az(eye, v))}  el ${f2(el(eye, v))}`);
}
console.log("\n  SIDE-WINDOW GLASS BOXES (all vertices; the eye is inside/next to them)");
for (const mesh of sideWindows) {
  const vs = worldVertices(mesh);
  const inFront = vs.filter((v) => v.x > eye.x + 0.08);
  console.log(`    ${mesh.name}: distance from the eye to its nearest surface ${f3(distanceToBox(eye, mesh))} m; x ${f3(Math.min(...vs.map((v) => v.x)))}..${f3(Math.max(...vs.map((v) => v.x)))}, y ${f3(Math.min(...vs.map((v) => v.y)))}..${f3(Math.max(...vs.map((v) => v.y)))}, |z| ${f3(Math.min(...vs.map((v) => Math.abs(v.z))))}..${f3(Math.max(...vs.map((v) => Math.abs(v.z))))}`);
  console.log(`      vertices ahead of the near plane: az ${f2(Math.min(...inFront.map((v) => az(eye, v))))}..${f2(Math.max(...inFront.map((v) => az(eye, v))))}, el ${f2(Math.min(...inFront.map((v) => el(eye, v))))}..${f2(Math.max(...inFront.map((v) => el(eye, v))))}`);
  const forwardEnd = inFront.filter((v) => v.x > Math.max(...vs.map((p) => p.x)) - 0.05);
  const unique = [...new Set(forwardEnd.map((v) => `(az ${f2(az(eye, v))}, el ${f2(el(eye, v))})`))];
  console.log(`      its forward end, four corners: ${unique.join(" ")}`);
}
console.log("\n  CENTRE POST (bizjet-windscreen-center-post), its two ends");
const postVertices = worldVertices(post);
const lowEnd = postVertices.reduce((a, b) => (b.y < a.y ? b : a));
const highEnd = postVertices.reduce((a, b) => (b.y > a.y ? b : a));
console.log(`    lower end (x ${f3(lowEnd.x)}, y ${f3(lowEnd.y)}): az ${f2(az(eye, lowEnd))} el ${f2(el(eye, lowEnd))};  upper end (x ${f3(highEnd.x)}, y ${f3(highEnd.y)}): az ${f2(az(eye, highEnd))} el ${f2(el(eye, highEnd))}`);
console.log(`    whole post: az ${f2(Math.min(...postVertices.map((v) => az(eye, v))))}..${f2(Math.max(...postVertices.map((v) => az(eye, v))))}, el ${f2(Math.min(...postVertices.map((v) => el(eye, v))))}..${f2(Math.max(...postVertices.map((v) => el(eye, v))))}`);

console.log("\n  SHELL round the eye (distance along each ray to the first fuselage/radome surface, metres)");
const shell = [fuselage, radome];
const dirs: [string, Vector3][] = [["up", new Vector3(0, 1, 0)], ["down", new Vector3(0, -1, 0)], ["port", new Vector3(0, 0, -1)], ["starboard", new Vector3(0, 0, 1)], ["forward", new Vector3(1, 0, 0)], ["aft", new Vector3(-1, 0, 0)]];
for (const [name, d] of dirs) console.log(`    ${name.padEnd(10)} ${f3(castDistance(eye, d, shell))}`);
console.log("    (a ray from inside a closed loft hits its wall on the far side; 'forward' therefore reads the nose)");
console.log(`    the fuselage top skin above the eye's x, by lateral z: ${[0, -0.26, -0.52, -0.7].map((z) => `z ${z}: y ${f3(eye.y + castDistance(new Vector3(F, U, z), new Vector3(0, 1, 0), shell))}`).join("   ")}`);

console.log("\n  SHELL PROFILE: height of the fuselage's top skin (m) at station x, by lateral z, and its half-width at the eye's height (0.78)");
console.log(`    ${"x".padEnd(7)}${[0, -0.26, -0.52, -0.72].map((z) => `top z ${z}`.padStart(13)).join("")}${"half-width".padStart(13)}`);
for (const x of [11.5, 11.7, 11.9, 12.2, 12.5, 12.63, 12.8, 12.95]) {
  const tops = [0, -0.26, -0.52, -0.72].map((z) => {
    const d = castDistance(new Vector3(x, 2, z), new Vector3(0, -1, 0), [fuselage]);
    return Number.isFinite(d) ? f3(2 - d) : "  n/a";
  });
  const wide = castDistance(new Vector3(x, U, 0), new Vector3(0, 0, -1), [fuselage]);
  console.log(`    ${f2(x).padEnd(7)}${tops.map((t) => t.padStart(13)).join("")}${f3(wide).padStart(13)}`);
}

console.log("\n  SEATS (the port seat, z < 0, is the pilot's; the mesh called 'captain' is starboard) relative to the eye");
for (const mesh of [...seats, ...headrests]) {
  const b = mesh.getBoundingInfo().boundingBox;
  const c = b.centerWorld;
  const vs = worldVertices(mesh);
  console.log(`    ${mesh.name.padEnd(30)} centre (${f3(c.x)}, ${f3(c.y)}, ${f3(c.z)})  = eye + (${f3(c.x - eye.x)}, ${f3(c.y - eye.y)}, ${f3(c.z - eye.z)});  x ${f3(Math.min(...vs.map((v) => v.x)))}..${f3(Math.max(...vs.map((v) => v.x)))}, top y ${f3(Math.max(...vs.map((v) => v.y)))}`);
}
console.log("\n  THE PANEL that is there now: bizjet-instrument-panel top y and x");
const panel = scene.getMeshByName("bizjet-instrument-panel");
if (panel) {
  const pv = worldVertices(panel);
  console.log(`    x ${f3(Math.min(...pv.map((v) => v.x)))}..${f3(Math.max(...pv.map((v) => v.x)))}, y ${f3(Math.min(...pv.map((v) => v.y)))}..${f3(Math.max(...pv.map((v) => v.y)))}, z ${f3(Math.min(...pv.map((v) => v.z)))}..${f3(Math.max(...pv.map((v) => v.z)))}; top edge at the eye's z reads el ${f2(el(eye, new Vector3(Math.min(...pv.map((v) => v.x)), Math.max(...pv.map((v) => v.y)), EYE_RIGHT)))} from its rear-top corner`);
}
console.log(`\n  distance from the old catalogue eye (${catalogue.forward}, ${catalogue.up}) to the new one: dx ${f3(F - catalogue.forward)}, dy ${f3(U - catalogue.up)}`);
scene.dispose();
engine.dispose();
