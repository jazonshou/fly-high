import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aircraftSpec } from "../src/aircraft/catalogue";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import type { AircraftVisual } from "../src/render/webgpu/aircraft/types";
import type { AircraftKind } from "../src/sim";

/**
 * WHAT THE GPU DRAWS, not what a ray hits.
 *
 * A ray cast hits a triangle whichever way it faces. The GPU culls back faces. So every test
 * that ray-casts (the clearance tests, the "nothing shows as sky" tests, picking) can be true of
 * the GEOMETRY and false of the PICTURE, and one was: the 747's overhead, dash and pillar, and the
 * attitude ball's halves on all three aircraft, were built inside out (`verticalProfile` builds a
 * counter-clockwise outline inside out and winds its thin edge walls against its caps), so the
 * GPU drew their far faces from inside, lit by normals pointing into the solid. The pillar read
 * as a black void with terrain showing under it, and every ray-cast test was green.
 *
 * So this asks the question the GPU asks. From the cockpit camera's eye, over a grid of the
 * frame, for EACH cockpit-only mesh, the NEAREST triangle of that mesh along the ray must be one
 * the GPU draws. The convention, MEASURED on a `build.box` face that visibly renders (and asserted
 * on one first, below, both ways): a drawn face has `cross(p1 - p0, p2 - p0)` pointing INTO the solid,
 * i.e. `dot(cross, rayDirection) > 0`.
 *
 * The allowance is ZERO, and the shared builder's defect (its edge walls are wound against its
 * caps) is handled where the plates are made (`solidPlate`), not here. It was found because the
 * first version of this asserted zero on ONE grid and read zero by luck: on a 1 degree grid of
 * round angles the 2 mm rim of the attitude ball's halves was never the nearest face, and on
 * grids offset by 0.13, 0.37, 0.61 and 0.83 degrees it was, for 1 to 3 of the roughly 25 rays
 * that touch a half (bizjet-pfd-sky 1 / 2 / 0 / 0, airliner-pfd-sky and -ground 0 / 0 / 3 / 1,
 * bizjet-pfd-ground 0 / 0 / 0 / 1). So this runs at TWO offsets, 0.37 and 0.61, the two that found
 * rim rays.
 *
 * WHY THE GRID IS OFFSET AT ALL: a ray that runs exactly along an edge built to a round angle picks
 * either face by rounding. The 747's hood's far top edge is built to read -10.00 degrees, which is
 * a grid line at az 0, el -10: that ray hit the hood's far face, which is wound correctly, and read
 * "culled". No ray here runs along an edge built to a round number.
 *
 * TWO GUARDS AGAINST A CLEAN READING THAT MEANS NOTHING:
 *  - every mesh must be HIT by more than zero rays (a mesh the grid never touches reads as clean,
 *    and void has to look different from clean). A mesh smaller than the grid's step (the needles,
 *    the pitch bars, the attitude ball's halves) or beyond the frame's edge (the starboard post and
 *    door) is sampled on a fine grid over its OWN angular extent instead, so what it reads is about
 *    it and not about luck;
 *  - flat-shaded triangles (three equal vertex normals: a box, a plate) must have their shading
 *    normal facing the eye, dot(normal, rayDirection) < 0. That guards `solidPlate`'s own normals:
 *    written inward, they would bring the black void back with every other test green.
 */

const DEG = Math.PI / 180;
const NEAR_PLANE = 0.08;
const OFFSETS = [0.37, 0.61] as const;

/** Meshes beyond the 75 degree frame's edge: checked over their own angular extent instead, not left out of the checking. */
const BEYOND_THE_FRAME: Readonly<Record<AircraftKind, readonly string[]>> = {
  trainer: ["trainer-windscreen-post-starboard", "trainer-door-starboard"],
  jet: [],
  bizjet: [],
  airliner: [],
};
/**
 * Under a degree across at the eye (the needles, the pitch bars) or a few degrees with a 2 mm rim in them
 * (the attitude ball's halves): a 0.1 degree grid over their own extent. On the 1 degree frame grid a half
 * takes one to three rays in two dozen on its rim, by luck; on this one the rim is certain to be sampled.
 */
const TINY = /-needle$|-pitch-bar$|-(sky|ground)$/;
const TINY_STEP = 0.1;
const BEYOND_STEP = 0.25;

/**
 * THE CONTROL'S BOX, per aircraft: a `build.box` the pilot plainly sees, closed and convex and
 * wound by Babylon itself, so the convention can be asserted both ways before anything else is
 * measured with it. The Cessna's MECHANICAL ball still has a pitch bar to use. Both glass decks'
 * balls are gone (their PFD pages draw attitude), so their control is the pilot's PFD SCREEN, box 0
 * of the merged screens mesh -- the same kind of object, and one that is lit up in front of him.
 */
const CONTROL: Readonly<Record<AircraftKind, { readonly mesh: string; readonly block?: number } | null>> = {
  trainer: { mesh: "trainer-attitude-pitch-bar" },
  bizjet: { mesh: "bizjet-screens", block: 0 },
  airliner: { mesh: "airliner-screens", block: 0 },
  // The F-16's pilot's left MFD screen, box 0 of the merged screens mesh, as the glass decks' are. (It was the
  // panel board, a `build.box` until the F-16 pass made the board a narrowed `solidPlate`: a control wound by the
  // rule it is there to check.)
  jet: { mesh: "jet-screens", block: 0 },
};

/** How many cockpit-only meshes each aircraft has, so a mesh going missing cannot pass as a clean run. */
// The Global's went 8 -> 4 when its kit was re-solved on the six-pane band: the old board, posts, overhead and walls
// are gone, and the board and the window frame's lining are one mesh. The trainer's went 19 -> 15 when it kept
// three dials: the second row's two gauge faces and two needles are gone. The 747's went 4 -> 6 with its framed,
// recessed screens (P1b): the bezels' rims and the wells behind the screens.
const KIT_SIZE: Readonly<Record<AircraftKind, number>> = { trainer: 15, bizjet: 7, airliner: 6, jet: 3 };
/**
 * Meshes that are NOT cockpit-only but frame the pilot's view all the same, walked with the kit: the F-16's
 * coaming is an ordinary airframe part (from outside it is the hood over the panel), a `solidPlate` narrowed
 * by `sculptSolid`, and its rail is the deck line from the seat; its board is the dash under the rail's cove
 * (step 1 of the F-16 pass: another narrowed `solidPlate`), which the pilot sees from the cove's foot down.
 * Both are held to the same zero here. (The 747's centre post was walked here while the cockpit camera drew
 * it; the kit lines its place now.)
 */
const ALSO_WALKED: Readonly<Record<AircraftKind, readonly string[]>> = {
  trainer: [],
  bizjet: [],
  airliner: [],
  jet: ["jet-glare-shield", "jet-instrument-panel"],
};

interface Prepared {
  readonly name: string;
  /** Per triangle: p0, e1, e2 (x, y, z each), and the geometric cross e1 x e2. */
  readonly data: Float64Array;
  /** The shading normal of each triangle if it is FLAT-shaded (three equal vertex normals), else NaN. */
  readonly flat: Float64Array;
  readonly count: number;
  readonly centre: Vector3;
  /** The eight corners of the mesh's world bounding box. */
  readonly corners: readonly Vector3[];
}

/**
 * One mesh's triangles in world space. `block` restricts it to the k-th 24-vertex box of a MERGED
 * mesh (`build.box` writes 24 vertices and 12 triangles in source order), which is how the control
 * below gets at one closed convex box inside `airliner-screens`. The centre and corners are then
 * that block's own, not the merged mesh's, so "inside" means inside THAT box.
 */
function prepare(mesh: AbstractMesh, block?: number): Prepared {
  mesh.computeWorldMatrix(true);
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
  const indices = mesh.getIndices()!;
  const world = mesh.getWorldMatrix();
  const point = (i: number) => Vector3.TransformCoordinates(new Vector3(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!), world);
  const normal = (i: number) => Vector3.TransformNormal(new Vector3(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!), world).normalize();
  const lowest = block === undefined ? 0 : block * 24;
  const highest = block === undefined ? Number.POSITIVE_INFINITY : lowest + 24;
  const kept: number[] = [];
  for (let t = 0; t < indices.length / 3; t += 1) {
    const [ia, ib, ic] = [indices[t * 3]!, indices[t * 3 + 1]!, indices[t * 3 + 2]!];
    if (ia >= lowest && ia < highest && ib >= lowest && ib < highest && ic >= lowest && ic < highest) kept.push(t);
  }
  const count = kept.length;
  const data = new Float64Array(count * 12);
  const flat = new Float64Array(count * 3).fill(Number.NaN);
  for (const [t, source] of kept.entries()) {
    const [ia, ib, ic] = [indices[source * 3]!, indices[source * 3 + 1]!, indices[source * 3 + 2]!];
    const p0 = point(ia);
    const e1 = point(ib).subtract(p0);
    const e2 = point(ic).subtract(p0);
    const cross = Vector3.Cross(e1, e2);
    data.set([p0.x, p0.y, p0.z, e1.x, e1.y, e1.z, e2.x, e2.y, e2.z, cross.x, cross.y, cross.z], t * 12);
    const [na, nb, nc] = [normal(ia), normal(ib), normal(ic)];
    if (Vector3.Distance(na, nb) < 1e-4 && Vector3.Distance(na, nc) < 1e-4) flat.set([na.x, na.y, na.z], t * 3);
  }
  if (block === undefined) {
    const box = mesh.getBoundingInfo().boundingBox;
    return { name: mesh.name, data, flat, count, centre: box.centerWorld.clone(), corners: box.vectorsWorld.map((corner) => corner.clone()) };
  }
  const blockPoints = Array.from({ length: 24 }, (_, i) => point(lowest + i));
  const low = new Vector3(Math.min(...blockPoints.map((v) => v.x)), Math.min(...blockPoints.map((v) => v.y)), Math.min(...blockPoints.map((v) => v.z)));
  const high = new Vector3(Math.max(...blockPoints.map((v) => v.x)), Math.max(...blockPoints.map((v) => v.y)), Math.max(...blockPoints.map((v) => v.z)));
  const corners = [low.x, high.x].flatMap((x) => [low.y, high.y].flatMap((y) => [low.z, high.z].map((z) => new Vector3(x, y, z))));
  return { name: `${mesh.name}[box ${block}]`, data, flat, count, centre: low.add(high).scale(0.5), corners };
}

interface Tally {
  rays: number;
  drawn: number;
  culled: number;
  flatChecked: number;
  flatBad: number;
  /** The first few culled rays, for the message. */
  examples: string[];
}

/** From `eye` along the unit `d`: the nearest triangle of this mesh (Moller-Trumbore, double sided), or null. */
function nearest(mesh: Prepared, eye: Vector3, d: Vector3, cutoff: number): { t: number; distance: number } | null {
  let best = Number.POSITIVE_INFINITY;
  let index = -1;
  const { data } = mesh;
  for (let t = 0; t < mesh.count; t += 1) {
    const o = t * 12;
    const e1x = data[o + 3]!, e1y = data[o + 4]!, e1z = data[o + 5]!;
    const e2x = data[o + 6]!, e2y = data[o + 7]!, e2z = data[o + 8]!;
    const hx = d.y * e2z - d.z * e2y, hy = d.z * e2x - d.x * e2z, hz = d.x * e2y - d.y * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-12) continue;
    const sx = eye.x - data[o]!, sy = eye.y - data[o + 1]!, sz = eye.z - data[o + 2]!;
    const u = (sx * hx + sy * hy + sz * hz) / det;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (d.x * qx + d.y * qy + d.z * qz) / det;
    if (v < 0 || u + v > 1) continue;
    const distance = (e2x * qx + e2y * qy + e2z * qz) / det;
    if (distance <= cutoff || distance >= best) continue;
    best = distance;
    index = t;
  }
  return index < 0 ? null : { t: index, distance: best };
}

const direction = (azimuth: number, elevation: number) => {
  const a = azimuth * DEG;
  const e = elevation * DEG;
  return new Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a));
};
/** The GPU's rule, measured on a box: a drawn face's cross product points into the solid. */
const isDrawn = (mesh: Prepared, t: number, d: Vector3) =>
  mesh.data[t * 12 + 9]! * d.x + mesh.data[t * 12 + 10]! * d.y + mesh.data[t * 12 + 11]! * d.z > 0;

function sample(mesh: Prepared, eye: Vector3, rays: readonly (readonly [number, number])[], cutoff = NEAR_PLANE): Tally {
  const tally: Tally = { rays: 0, drawn: 0, culled: 0, flatChecked: 0, flatBad: 0, examples: [] };
  for (const [az, el] of rays) {
    const d = direction(az, el);
    const hit = nearest(mesh, eye, d, cutoff);
    if (!hit) continue;
    tally.rays += 1;
    if (isDrawn(mesh, hit.t, d)) tally.drawn += 1;
    else {
      tally.culled += 1;
      if (tally.examples.length < 3) tally.examples.push(`(az ${az.toFixed(2)}, el ${el.toFixed(2)}) at ${hit.distance.toFixed(3)} m, triangle ${hit.t}`);
    }
    const nx = mesh.flat[hit.t * 3]!;
    if (Number.isFinite(nx)) {
      tally.flatChecked += 1;
      if (nx * d.x + mesh.flat[hit.t * 3 + 1]! * d.y + mesh.flat[hit.t * 3 + 2]! * d.z >= 0) tally.flatBad += 1;
    }
  }
  return tally;
}
const grid = (azFrom: number, azTo: number, elFrom: number, elTo: number, step: number, offset: number) => {
  const rays: [number, number][] = [];
  for (let az = azFrom + offset; az <= azTo; az += step) for (let el = elFrom + offset; el <= elTo; el += step) rays.push([az, el]);
  return rays;
};

describe.each(["trainer", "bizjet", "airliner", "jet"] as const)("what the GPU draws of the %s's cockpit-only parts", (kind) => {
  let engine: NullEngine;
  let scene: Scene;
  let aircraft: AircraftVisual;
  let eye: Vector3;
  let meshes: Prepared[];
  const angles = (point: Vector3) => {
    const d = point.subtract(eye);
    return { az: Math.atan2(d.z, d.x) / DEG, el: Math.atan2(d.y, Math.hypot(d.x, d.z)) / DEG };
  };
  /** The angular extent of a mesh's bounding box from the eye, padded by half a degree. Every mesh sampled this way is in front of the eye. */
  const extentGrid = (mesh: Prepared, step: number, offset: number) => {
    const seen = mesh.corners.map(angles);
    const azimuths = seen.map((a) => a.az);
    const elevations = seen.map((a) => a.el);
    const [azFrom, azTo] = [Math.min(...azimuths) - 0.5, Math.max(...azimuths) + 0.5];
    if (azTo - azFrom > 120) throw new Error(`${mesh.name} spans ${(azTo - azFrom).toFixed(0)} degrees of azimuth: not a mesh to sample by its extent`);
    return grid(azFrom, azTo, Math.min(...elevations) - 0.5, Math.max(...elevations) + 0.5, step, offset * step);
  };

  beforeAll(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    scene.activeCamera = new UniversalCamera("drawn-faces-camera", Vector3.Zero(), scene);
    aircraft = createWebGpuAircraft(scene, kind);
    aircraft.root.computeWorldMatrix(true);
    for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
    aircraft.setCockpitView(true);
    const spec = aircraftSpec(kind).cockpitEye;
    eye = new Vector3(spec.forward, spec.up, spec.right);
    // NOT `.map(prepare)`: map passes the index, which `prepare` now reads as a box block.
    const walked = [...(aircraft.cockpitOnlyParts ?? [])];
    for (const name of ALSO_WALKED[kind]) {
      const mesh = scene.getMeshByName(name);
      if (!mesh) throw new Error(`${kind}: ${name} is listed to be walked but was not built`);
      walked.push(mesh);
    }
    meshes = walked.map((mesh) => prepare(mesh));
  });
  afterAll(() => {
    aircraft.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("agrees with a box: the convention says a box's front is drawn and its inside is not (the control)", () => {
    const control = CONTROL[kind]!;
    expect(control, `${kind} has a control box`).not.toBeNull();
    const source = scene.getMeshByName(control.mesh);
    expect(source, `the control box's mesh ${control.mesh}`).not.toBeNull();
    const bar = prepare(source!, control.block);
    expect(bar.count, "the control is ONE box: 12 triangles").toBe(12);
    const centre = angles(bar.centre);
    const fromOutside = sample(bar, eye, grid(centre.az - 0.2, centre.az + 0.2, centre.el - 0.05, centre.el + 0.05, 0.05, 0));
    expect(fromOutside.rays, "rays at the bar's centre hit the bar").toBeGreaterThan(10);
    expect(fromOutside.drawn, "from the eye the bar's nearest face is DRAWN").toBe(fromOutside.rays);
    expect(fromOutside.flatChecked, "and a box is flat-shaded, so the normal check sees it").toBe(fromOutside.rays);
    expect(fromOutside.flatBad, "with its normal toward the eye").toBe(0);
    // and from INSIDE the box (its own centre, looking out, no near plane) the nearest face is one the GPU culls
    const oblique: [number, number][] = [[10, 7], [100, -5], [190, 9], [-80, 12], [20, 80], [40, -75]];
    const inside = sample(bar, bar.centre, oblique, 0);
    expect(inside.rays, "every ray from inside a closed box hits it").toBe(oblique.length);
    expect(inside.culled, "seen from inside, a box's faces are culled").toBe(inside.rays);
    expect(inside.flatBad, "and their normals point away").toBe(inside.rays);
  });

  it.each(OFFSETS)("draws the nearest face of every cockpit-only mesh, at a grid offset by %s degrees, and shades flat faces toward the eye", (offset) => {
    const frame = grid(-37, 37, -21, 21, 1, offset);
    const problems: string[] = [];
    const report: string[] = [];
    for (const mesh of meshes) {
      let rays: readonly (readonly [number, number])[];
      let how: string;
      if (TINY.test(mesh.name)) {
        rays = extentGrid(mesh, TINY_STEP, offset);
        how = `${TINY_STEP} degree grid over its extent`;
      } else if (BEYOND_THE_FRAME[kind].includes(mesh.name)) {
        rays = extentGrid(mesh, BEYOND_STEP, offset);
        how = `${BEYOND_STEP} degree grid over its extent`;
      } else {
        rays = frame;
        how = "frame grid";
      }
      const tally = sample(mesh, eye, rays);
      report.push(`${mesh.name.padEnd(36)} ${how.padEnd(34)} rays hitting ${String(tally.rays).padStart(5)}  culled ${tally.culled}  flat faces ${tally.flatChecked} (facing away ${tally.flatBad})`);
      // VOID MUST LOOK DIFFERENT FROM CLEAN: a mesh no ray touched proves nothing
      if (tally.rays === 0) problems.push(`${mesh.name}: no ray hit it on the ${how}, so its zero means nothing`);
      if (tally.culled > 0) problems.push(`${mesh.name}: the nearest face is CULLED for ${tally.culled} of ${tally.rays} rays, e.g. ${tally.examples.join("; ")}`);
      if (tally.flatBad > 0) problems.push(`${mesh.name}: ${tally.flatBad} of ${tally.flatChecked} flat-shaded nearest faces have their shading normal pointing AWAY from the eye`);
    }
    console.info(`${kind}, offset ${offset}:\n  ${report.join("\n  ")}`);
    expect(problems).toEqual([]);
  });

  it("finds every cockpit-only mesh: the list this test walks is the aircraft's own", () => {
    // PINNED per aircraft rather than bounded below: the 747's kit went 7 -> 4 when its 3D attitude
    // ball came out, and a bound would have let that pass in silence either way.
    expect((aircraft.cockpitOnlyParts ?? []).length, `${kind}'s cockpit-only meshes`).toBe(KIT_SIZE[kind]);
    expect(meshes.length, `${kind}'s walked meshes: the kit and the parts listed beside it`).toBe(KIT_SIZE[kind] + ALSO_WALKED[kind].length);
    expect(meshes.map((mesh) => mesh.name).sort()).toEqual([...(aircraft.cockpitOnlyParts ?? []).map((mesh) => mesh.name), ...ALSO_WALKED[kind]].sort());
    // a part walked beside the kit is an ordinary part, not a cockpit-only one: the two lists do not overlap
    for (const name of ALSO_WALKED[kind]) expect((aircraft.cockpitOnlyParts ?? []).map((mesh) => mesh.name), name).not.toContain(name);
    // the meshes exempted from the frame grid are real ones, so an exemption cannot outlive its mesh
    for (const name of BEYOND_THE_FRAME[kind]) expect(meshes.map((mesh) => mesh.name), name).toContain(name);
  });
});
