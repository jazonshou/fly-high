/**
 * The trainer's shell, measured, and how far inside it every new cockpit part is.
 *
 * A NullEngine scene, `createAircraft(scene, "trainer")`, and rays. Two
 * questions, both answered from the BUILT meshes rather than from the loft
 * sections in trainerVisual.ts, because a superellipse loft interpolated
 * between stations is exactly the kind of thing whose numbers are easy to
 * transcribe wrongly:
 *
 *  1. THE PROFILE. The shell's half-width at (x, y), and the height of its top
 *     skin at (x, z). The fuselage loft is a CLOSED tube whose cabin-section
 *     top is a flat deck at about y = 0 (the window sill) sloping to about
 *     -0.06 at the cowl, and the pilot's eye is at y 0.12: the pilot looks down
 *     onto the OUTSIDE of that skin. Everything below it is invisible from the
 *     seat, which is what a cockpit built inside the tube has to live with.
 *  2. THE CLEARANCE. For every cockpit-only part the trainer builds
 *     (`visual.cockpitOnlyParts`), every vertex is measured against the shell: a ray from the
 *     centreline at the vertex's own (x, y) toward its side finds the first of
 *     the fuselage or the canopy loft (the canopy is the shell above the sill)
 *     and clearance = that half-width - |z|. It must be POSITIVE: a negative
 *     number is a part poking out through the skin.
 *
 * Picking ignores back-face culling, which is exactly what a distance to a wall
 * seen from the inside needs.
 *
 *   npx tsx scripts/cockpit-shell-clearance.mts
 */
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Ray } from "@babylonjs/core/Culling/ray";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import { createAircraft } from "@/src/render/webgpu/aircraft/createAircraft";
import { INITIAL_VISUAL_STATE } from "@/src/game/types";

const engine = new NullEngine();
const scene = new Scene(engine);
scene.useRightHandedSystem = true;
const visual = createAircraft(scene, "trainer");
visual.update({ ...INITIAL_VISUAL_STATE, gear: 1, onGround: true, altitudeAgl: 0 } as never, 1 / 60);
visual.root.computeWorldMatrix(true);
for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);

const fuselage = scene.getMeshByName("trainer-fuselage");
const canopy = scene.getMeshByName("trainer-canopy");
if (!fuselage || !canopy) throw new Error("no trainer-fuselage / trainer-canopy to measure against");
const shellMeshes = new Set<AbstractMesh>([fuselage, canopy]);
const eye = aircraftSpec("trainer").cockpitEye;

function fixed(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "  n/a ";
}

/**
 * Distance from (x, y, 0) sideways to the shell, or NaN: the WIDEST of the
 * fuselage tube's and the greenhouse glass's surfaces at that point. The tube's
 * top corner is rounded off toward the sill while the glass, whose lower half is
 * inside the tube, keeps its full width down to y = -0.1, so near the sill the
 * cabin is the glass's width and not the tube's. Taking the first hit from the
 * centreline would read the tube's rounded shoulder as the wall.
 */
function halfWidth(x: number, y: number, side: 1 | -1, meshes: Set<AbstractMesh> = shellMeshes): number {
  let widest = Number.NaN;
  for (const mesh of meshes) {
    const hit = scene.pickWithRay(new Ray(new Vector3(x, y, 0), new Vector3(0, 0, side), 3), (m) => m === mesh);
    if (hit?.hit && !(hit.distance <= widest)) widest = hit.distance;
  }
  return widest;
}
/** Height of the first surface of `mesh` below (x, 1, z), or NaN. */
function topSkin(x: number, z: number, mesh: AbstractMesh = fuselage!): number {
  const hit = scene.pickWithRay(new Ray(new Vector3(x, 1, z), new Vector3(0, -1, 0), 3), (m) => m === mesh);
  return hit?.hit && hit.pickedPoint ? hit.pickedPoint.y : Number.NaN;
}

console.log(`cockpit-shell-clearance  eye (${eye.forward}, ${eye.up}, ${eye.right}) from the catalogue`);
console.log("\nSHELL HALF-WIDTH (m) at station x and height y, port side (starboard in brackets); the wider of the fuselage tube and the glass");
const stations = [0.95, 1.2, 1.4, 1.62, 1.8, 2.0, 2.07, 2.24, 2.42];
const heights = [0.15, 0.1, 0.05, -0.02, -0.1, -0.3, -0.6];
console.log(`  ${"x".padEnd(6)}${heights.map((y) => `y ${fixed(y, 2)}`.padStart(15)).join("")}`);
for (const x of stations) {
  console.log(`  ${fixed(x, 2).padEnd(6)}${heights.map((y) => `${fixed(halfWidth(x, y, -1), 3)} (${fixed(halfWidth(x, y, 1), 3)})`.padStart(15)).join("")}`);
}
console.log("\nFUSELAGE TOP SKIN (the deck the pilot looks down onto), y at station x and lateral z");
const zs = [0, -0.26, -0.4, 0.26, 0.4];
console.log(`  ${"x".padEnd(6)}${zs.map((z) => `z ${fixed(z, 2)}`.padStart(11)).join("")}`);
for (const x of [0.6, 1.0, 1.4, 1.62, 1.8, 2.0, 2.07, 2.24, 2.42, 2.8, 3.2, 3.6]) {
  console.log(`  ${fixed(x, 2).padEnd(6)}${zs.map((z) => fixed(topSkin(x, z), 3).padStart(11)).join("")}`);
}
console.log("\nCANOPY (the greenhouse above the sill) TOP, and the roof slab: y at lateral z=0 by station");
for (const x of [0.3, 0.6, 1.0, 1.4, 1.62, 1.8, 2.0, 2.2]) {
  console.log(`  x ${fixed(x, 2)}: canopy top ${fixed(topSkin(x, 0, canopy), 3)}, half-width at y 0.05: ${fixed(halfWidth(x, 0.05, -1, new Set([canopy])), 3)}`);
}

const parts = visual.cockpitOnlyParts ?? [];
if (parts.length > 0) {
  // Each vertex is judged against the shell that EXISTS at its height:
  //   below the fuselage's top skin  -> the tube's wall (the fuselage alone);
  //   above it, under the glass crown -> the greenhouse glass;
  //   above both                      -> nothing encloses it (a post's top ends in
  //                                      the roof slab, a hood stands over the skin).
  // Both shells are hidden from the cockpit camera and every part here is
  // invisible to every other camera, so "outside" can never be seen; the number
  // says how faithfully the part follows where the wall was.
  console.log(`\nCLEARANCE of ${parts.length} cockpit-only meshes from the shell that exists at each vertex's height (metres; + is inside)`);
  console.log(`  ${"mesh".padEnd(36)}${"vs TUBE (below skin)".padEnd(46)}${"vs GLASS (above skin)".padEnd(46)}above both`);
  const summary = (list: { c: number; at: string }[]) => {
    if (list.length === 0) return "-";
    const worst = list.reduce((a, b) => (b.c < a.c ? b : a));
    const best = list.reduce((a, b) => (b.c > a.c ? b : a));
    return `min ${fixed(worst.c, 4)} max ${fixed(best.c, 4)} (n ${list.length})`;
  };
  for (const mesh of parts) {
    mesh.computeWorldMatrix(true);
    const data = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!data) continue;
    const world = mesh.getWorldMatrix();
    const tube: { c: number; at: string }[] = [];
    const glass: { c: number; at: string }[] = [];
    let above = 0;
    for (let i = 0; i + 2 < data.length; i += 3) {
      const v = Vector3.TransformCoordinates(new Vector3(data[i]!, data[i + 1]!, data[i + 2]!), world);
      if (Math.abs(v.z) < 1e-4) continue;
      const side = v.z < 0 ? -1 : 1;
      const skin = topSkin(v.x, v.z, fuselage!);
      const crown = topSkin(v.x, v.z, canopy!);
      const at = `(${fixed(v.x, 3)}, ${fixed(v.y, 3)}, ${fixed(v.z, 3)})`;
      if (Number.isFinite(skin) && v.y <= skin + 1e-4) {
        tube.push({ c: halfWidth(v.x, v.y, side, new Set([fuselage!])) - Math.abs(v.z), at });
      } else if (Number.isFinite(crown) && v.y <= crown + 1e-4) {
        glass.push({ c: halfWidth(v.x, v.y, side, new Set([canopy!])) - Math.abs(v.z), at });
      } else above += 1;
    }
    console.log(`  ${mesh.name.padEnd(36)}${summary(tube).padEnd(46)}${summary(glass).padEnd(46)}${above}`);
  }
}
scene.dispose();
engine.dispose();
