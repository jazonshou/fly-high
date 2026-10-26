import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBoxVertexData } from "@babylonjs/core/Meshes/Builders/boxBuilder.pure";
import { CreateCylinderVertexData } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.pure";
import type { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { quaternionFromFlightAngles } from "@/src/sim/math";
import { RUNABOUT_21_CG, RUNABOUT_21_OUTBOARD, RUNABOUT_21_REST_WATERLINE } from "@/src/vehicles/boat/hullLines";
import {
  MARINA_LAYOUT,
  marinaBoxOrientation,
  marinaToWorld,
  type MarinaBeacon,
  type MarinaBox,
  type MarinaBoxKind,
  type MarinaLayout,
  type MarinaPost,
  type MarinaPostKind,
} from "@/src/world/marinaLayout";
import {
  aftDeckSurfaces,
  cockpitSurfaces,
  consoleSurfaces,
  foredeckFaceSurface,
  foredeckSurfaces,
  motorWellSurfaces,
  seatSurfaces,
  windscreenFrameSurfaces,
} from "../boat/boatDeck";
import { hullSkinSurfaces, hullStations, rubRailSurfaces, transomSurface } from "../boat/boatHull";
import { BoatMeshData, type Surface, type Vec3Tuple } from "../boat/boatMeshData";
import { outboardSurfaces } from "../boat/boatOutboard";
import { AIRFIELD_LAMP_RGB, AIRFIELD_LAMP_SCENE_SCALE } from "../lighting/AirfieldLighting";
import type { LightPointFixture } from "../lighting/LightPoints";

/**
 * The home marina as drawn: every part from `homeMarina(world)`'s records,
 * the ones the colliders and the earthworks read, so a pile on screen is the
 * pile a hull meets. Pure arithmetic and geometry, so Node tests can hold it
 * to the layout; `MarinaSystem` puts it on the GPU.
 *
 * Four meshes and the airfield's light draw:
 *   boxes       one unit cube, a thin instance per deck, pontoon, finger,
 *               wall, building, roof and life ring, coloured per instance
 *   posts       one unit cylinder, a thin instance per pile, post, cleat,
 *               fender and beacon tower, coloured per instance
 *   boats       one low-detail Runabout 21, a thin instance per moored boat
 *   silhouette  one merged mesh of the big shapes, drawn instead of the three
 *               between `MARINA_VISUAL.detailMeters` and `cullMeters`
 *   lamps       fixtures appended to the airfield's `LightPointSystem`, so the
 *               marina's lamps and beacons cost no draw of their own
 *
 * MARINA ROOT FRAME. Instance matrices and the silhouette are in metres from
 * the site's waterline point (`layout.site`), axes the world's, so they stay
 * small numbers wherever the marina is; the root node carries the site and
 * the floating origin.
 */

export const MARINA_VISUAL = Object.freeze({
  /** Detail inside this camera distance, silhouette beyond it, metres from the site. */
  detailMeters: 1_500,
  /** Nothing drawn (lamps dark) beyond this. */
  cullMeters: 4_000,
  /** A band either side of each switch, so a camera on the line does not flicker. */
  hysteresisMeters: 40,
  /** Sides on a post's cylinder. */
  postTessellation: 10,
});

export type MarinaLevelOfDetail = "detail" | "silhouette" | "culled";

/** The level for a camera `distance` from the site, holding `current` inside the hysteresis band. */
export function marinaLevelOfDetail(distance: number, current: MarinaLevelOfDetail | null): MarinaLevelOfDetail {
  const V = MARINA_VISUAL;
  const band = current === null ? 0 : V.hysteresisMeters;
  const detailEdge = current === "detail" ? V.detailMeters + band : V.detailMeters - band;
  const cullEdge = current === "culled" ? V.cullMeters - band : V.cullMeters + band;
  if (distance < detailEdge) return "detail";
  if (distance < cullEdge) return "silhouette";
  return "culled";
}

type Rgb = readonly [number, number, number];

/**
 * Linear albedo per part. Weathered softwood decking and piles, a light
 * composite pontoon deck, cast concrete, a white-painted hut with a dark red
 * metal roof, a sage-green clad shed, galvanised steel and black rubber.
 */
export const MARINA_BOX_ALBEDO: Readonly<Record<MarinaBoxKind | "lifeRing", Rgb>> = Object.freeze({
  quayWall: [0.34, 0.33, 0.31],
  pierDeck: [0.28, 0.22, 0.16],
  gangway: [0.38, 0.39, 0.40],
  pontoon: [0.46, 0.45, 0.42],
  finger: [0.46, 0.45, 0.42],
  fuelPump: [0.55, 0.07, 0.05],
  hut: [0.70, 0.69, 0.65],
  hutRoof: [0.22, 0.06, 0.05],
  shed: [0.30, 0.36, 0.31],
  shedRoof: [0.24, 0.25, 0.26],
  lifeRingStand: [0.70, 0.70, 0.68],
  lifeRing: [0.85, 0.23, 0.03],
});

export const MARINA_POST_ALBEDO: Readonly<Record<Exclude<MarinaPostKind, "beaconPost">, Rgb>> = Object.freeze({
  pile: [0.19, 0.15, 0.10],
  guidePile: [0.40, 0.41, 0.42],
  lampPost: [0.05, 0.06, 0.06],
  bollardLight: [0.08, 0.08, 0.08],
  cleat: [0.44, 0.44, 0.45],
  fender: [0.04, 0.04, 0.04],
});

/** A beacon tower is painted its light's colour, IALA A: red to port entering, green to starboard. */
export const MARINA_BEACON_POST_ALBEDO: Readonly<Record<MarinaBeacon["color"], Rgb>> = Object.freeze({
  green: [0.03, 0.28, 0.08],
  red: [0.52, 0.04, 0.03],
});

/** One instanced batch: Babylon matrices (16 floats each) and RGBA colours (4 each). */
export interface MarinaInstances {
  readonly count: number;
  readonly matrices: Float32Array;
  readonly colors: Float32Array;
}

/** A merged mesh with a colour per vertex. */
export interface MarinaColouredGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  readonly indices: Uint32Array;
}

const scratchScale = new Vector3();
const scratchRotation = new Quaternion();
const scratchTranslation = new Vector3();
const scratchMatrix = new Matrix();

function writeInstance(
  matrices: Float32Array,
  colors: Float32Array,
  index: number,
  colour: Rgb,
): void {
  Matrix.ComposeToRef(scratchScale, scratchRotation, scratchTranslation, scratchMatrix);
  scratchMatrix.copyToArray(matrices, index * 16);
  colors[index * 4] = colour[0];
  colors[index * 4 + 1] = colour[1];
  colors[index * 4 + 2] = colour[2];
  colors[index * 4 + 3] = 1;
}

/** A box's centre in the marina root frame. */
function rootPoint(layout: MarinaLayout, right: number, out: number, y: number, target: Vector3): Vector3 {
  const p = marinaToWorld(layout.frame, right, out);
  return target.set(p.x - layout.site.x, y, p.z - layout.site.z);
}

function setRotation(orientation: { x: number; y: number; z: number; w: number }): void {
  scratchRotation.set(orientation.x, orientation.y, orientation.z, orientation.w);
}

/** Life rings: a ring on each stand, facing out, just under its top. */
function lifeRingOf(stand: MarinaBox): MarinaBox {
  return Object.freeze({
    ...stand,
    kind: "lifeRingStand",
    out: stand.out + stand.halfOut + 0.05,
    y: stand.y + stand.halfHeight - 0.4,
    halfRight: 0.32,
    halfOut: 0.04,
    halfHeight: 0.32,
  });
}

/**
 * Every box as a scaled unit cube: decks, pontoons, fingers, the quay wall,
 * the hut and shed and their roofs, the fuel pump, the life-ring stands and
 * a ring on each. The cube is `CreateBoxVertexData({ size: 1 })`; box-local
 * x is marina -right and z is out (`marinaBoxOrientation`).
 */
export function marinaBoxInstances(layout: MarinaLayout): MarinaInstances {
  const parts: { box: MarinaBox; colour: Rgb }[] = [];
  for (const box of layout.boxes) {
    parts.push({ box, colour: MARINA_BOX_ALBEDO[box.kind] });
    if (box.kind === "lifeRingStand") parts.push({ box: lifeRingOf(box), colour: MARINA_BOX_ALBEDO.lifeRing });
  }
  const matrices = new Float32Array(parts.length * 16);
  const colors = new Float32Array(parts.length * 4);
  parts.forEach(({ box, colour }, index) => {
    scratchScale.set(box.halfRight * 2, box.halfHeight * 2, box.halfOut * 2);
    setRotation(marinaBoxOrientation(layout.frame, box));
    rootPoint(layout, box.right, box.out, box.y, scratchTranslation);
    writeInstance(matrices, colors, index, colour);
  });
  return Object.freeze({ count: parts.length, matrices, colors });
}

function postColour(layout: MarinaLayout, post: MarinaPost): Rgb {
  if (post.kind !== "beaconPost") return MARINA_POST_ALBEDO[post.kind];
  const beacon = layout.beacons.find((candidate) => candidate.right === post.right && candidate.out === post.out);
  return MARINA_BEACON_POST_ALBEDO[beacon?.color ?? "green"];
}

/** Every post as a scaled unit cylinder (`CreateCylinderVertexData`, height 1, radius 1). */
export function marinaPostInstances(layout: MarinaLayout): MarinaInstances {
  const posts = layout.posts;
  const matrices = new Float32Array(posts.length * 16);
  const colors = new Float32Array(posts.length * 4);
  scratchRotation.set(0, 0, 0, 1);
  posts.forEach((post, index) => {
    scratchScale.set(post.radius, post.topY - post.bottomY, post.radius);
    scratchRotation.set(0, 0, 0, 1);
    rootPoint(layout, post.right, post.out, (post.bottomY + post.topY) * 0.5, scratchTranslation);
    writeInstance(matrices, colors, index, postColour(layout, post));
  });
  return Object.freeze({ count: posts.length, matrices, colors });
}

/**
 * The moored runabouts: one per occupied berth, at rest on still water, bow
 * on the berth's heading and trimmed as the hydrostatics float it. Body frame
 * as the sim's (+X forward, +Y up, +Z starboard, origin at the CG), so the
 * orientation is the sim's own quaternion, as the player's boat is drawn.
 */
export function marinaBoatInstances(layout: MarinaLayout): MarinaInstances {
  const berths = layout.berths.filter((berth) => berth.occupied);
  const matrices = new Float32Array(berths.length * 16);
  const colors = new Float32Array(berths.length * 4);
  const trim = (RUNABOUT_21_REST_WATERLINE.trimDegrees * Math.PI) / 180;
  berths.forEach((berth, index) => {
    scratchScale.set(1, 1, 1);
    setRotation(quaternionFromFlightAngles(berth.bowHeadingRadians, trim, 0));
    rootPoint(layout, berth.right, berth.out, layout.seaLevel + RUNABOUT_21_REST_WATERLINE.cgAboveWater, scratchTranslation);
    writeInstance(matrices, colors, index, [1, 1, 1]);
  });
  return Object.freeze({ count: berths.length, matrices, colors });
}

/** Unit cube and unit cylinder, the two instanced shapes. */
export function marinaUnitBox(): VertexData {
  return CreateBoxVertexData({ size: 1 });
}

export function marinaUnitCylinder(): VertexData {
  return CreateCylinderVertexData({ height: 1, diameter: 2, tessellation: MARINA_VISUAL.postTessellation });
}

/** Accumulates coloured geometry. */
class ColouredMesh {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];

  add(data: { positions: ArrayLike<number>; normals: ArrayLike<number>; indices: ArrayLike<number> }, colour: (x: number, y: number, z: number) => Rgb): void {
    const base = this.positions.length / 3;
    for (let index = 0; index < data.positions.length; index += 3) {
      const x = data.positions[index]!;
      const y = data.positions[index + 1]!;
      const z = data.positions[index + 2]!;
      this.positions.push(x, y, z);
      this.normals.push(data.normals[index]!, data.normals[index + 1]!, data.normals[index + 2]!);
      const rgb = colour(x, y, z);
      this.colors.push(rgb[0], rgb[1], rgb[2], 1);
    }
    for (let index = 0; index < data.indices.length; index += 1) this.indices.push(base + data.indices[index]!);
  }

  /** A unit cube under `matrix`. */
  addBox(matrix: Matrix, colour: Rgb): void {
    const cube = marinaUnitBox();
    const positions = cube.positions!;
    const normals = cube.normals!;
    const p = new Vector3();
    const n = new Vector3();
    const moved: number[] = [];
    const turned: number[] = [];
    for (let index = 0; index < positions.length; index += 3) {
      Vector3.TransformCoordinatesFromFloatsToRef(positions[index]!, positions[index + 1]!, positions[index + 2]!, matrix, p);
      Vector3.TransformNormalFromFloatsToRef(normals[index]!, normals[index + 1]!, normals[index + 2]!, matrix, n);
      n.normalize();
      moved.push(p.x, p.y, p.z);
      turned.push(n.x, n.y, n.z);
    }
    this.add({ positions: moved, normals: turned, indices: cube.indices! }, () => colour);
  }

  build(): MarinaColouredGeometry {
    return Object.freeze({
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      colors: new Float32Array(this.colors),
      indices: new Uint32Array(this.indices),
    });
  }
}

/** Gelcoat, antifouling below the boot top, the deck, upholstery, the screen and the cowl. */
export const MOORED_RUNABOUT_ALBEDO = Object.freeze({
  topsides: [0.78, 0.78, 0.76] as Rgb,
  antifouling: [0.03, 0.05, 0.09] as Rgb,
  rubRail: [0.06, 0.06, 0.07] as Rgb,
  deck: [0.68, 0.67, 0.63] as Rgb,
  seats: [0.52, 0.48, 0.40] as Rgb,
  screen: [0.05, 0.06, 0.07] as Rgb,
  outboard: [0.03, 0.03, 0.03] as Rgb,
});

/** Stations kept from the drawn hull's for a moored boat: every third, and the ends. */
const MOORED_STATION_STRIDE = 3;

/**
 * A low-detail Runabout 21 for the moored boats: the presentation thread's
 * hull, deck, console and outboard surfaces (src/render/webgpu/boat/) on a
 * third of its stations, without the helm, cleats and fittings, coloured per
 * part instead of from the atlas. Body frame, origin at the CG. The bottom
 * below the rest waterline is antifouling, which the sea mostly hides.
 */
export function buildMooredRunaboutGeometry(): MarinaColouredGeometry {
  const C = MOORED_RUNABOUT_ALBEDO;
  const cg: Vec3Tuple = [RUNABOUT_21_CG.x, RUNABOUT_21_CG.y, RUNABOUT_21_CG.z];
  const stations = hullStations();
  const coarse = stations.filter((_, index) => index % MOORED_STATION_STRIDE === 0 || index === stations.length - 1);
  // The boot top: a hand's width above the rest waterline at the CG, in the body frame.
  const bootTop = -RUNABOUT_21_REST_WATERLINE.cgAboveWater + 0.06;
  const mesh = new ColouredMesh();
  const part = (surfaces: readonly Surface[], symmetric: boolean, colour: (x: number, y: number, z: number) => Rgb, origin: Vec3Tuple = cg) => {
    const data = new BoatMeshData();
    for (const surface of surfaces) {
      if (symmetric) data.addSymmetric(surface, origin);
      else data.add(surface, origin);
    }
    mesh.add(data, colour);
  };
  part(hullSkinSurfaces(coarse), true, (_x, y) => (y < bootTop ? C.antifouling : C.topsides));
  part(rubRailSurfaces(coarse), true, () => C.rubRail);
  part([transomSurface()], false, (_x, y) => (y < bootTop ? C.antifouling : C.topsides));
  part([...cockpitSurfaces(), ...foredeckSurfaces(), foredeckFaceSurface(), ...aftDeckSurfaces(), ...motorWellSurfaces()], true, () => C.deck);
  part(seatSurfaces(), true, () => C.seats);
  part([...consoleSurfaces("starboard"), ...consoleSurfaces("port")], false, () => C.deck);
  part(windscreenFrameSurfaces(), false, () => C.screen);
  // The outboard hangs straight down at zero trim and steer: its surfaces are
  // authored about the steer axis point, so shift them by that point less the CG.
  const steer = RUNABOUT_21_OUTBOARD.steerAxisPoint;
  part(outboardSurfaces(), false, () => C.outboard, [cg[0] - steer.x, cg[1] - steer.y, cg[2] - steer.z]);
  return mesh.build();
}

/** The silhouette's moored boat: a box the boat's length, beam and freeboard. */
const SILHOUETTE_BOAT = Object.freeze({ length: 6.2, beam: 2.4, height: 1.1 });

/**
 * The marina beyond `MARINA_VISUAL.detailMeters`: the decks, pontoons,
 * fingers, quay wall, buildings and roofs as boxes, the moored boats as
 * white boxes and the beacon towers as square ones, in one merged mesh with
 * no shadow. Piles, cleats and lamp posts are under a pixel there and are
 * left out. Marina root frame.
 */
export function buildMarinaSilhouette(layout: MarinaLayout): MarinaColouredGeometry {
  const mesh = new ColouredMesh();
  const matrix = new Matrix();
  for (const box of layout.boxes) {
    if (box.kind === "lifeRingStand") continue;
    scratchScale.set(box.halfRight * 2, box.halfHeight * 2, box.halfOut * 2);
    setRotation(marinaBoxOrientation(layout.frame, box));
    rootPoint(layout, box.right, box.out, box.y, scratchTranslation);
    Matrix.ComposeToRef(scratchScale, scratchRotation, scratchTranslation, matrix);
    mesh.addBox(matrix, MARINA_BOX_ALBEDO[box.kind]);
  }
  for (const berth of layout.berths) {
    if (!berth.occupied) continue;
    scratchScale.set(SILHOUETTE_BOAT.length, SILHOUETTE_BOAT.height, SILHOUETTE_BOAT.beam);
    setRotation(quaternionFromFlightAngles(berth.bowHeadingRadians, 0, 0));
    rootPoint(layout, berth.right, berth.out, layout.seaLevel + SILHOUETTE_BOAT.height * 0.5 - 0.3, scratchTranslation);
    Matrix.ComposeToRef(scratchScale, scratchRotation, scratchTranslation, matrix);
    mesh.addBox(matrix, MOORED_RUNABOUT_ALBEDO.topsides);
  }
  for (const post of layout.posts) {
    if (post.kind !== "beaconPost") continue;
    scratchScale.set(post.radius * 2, post.topY - layout.seaLevel, post.radius * 2);
    scratchRotation.set(0, 0, 0, 1);
    rootPoint(layout, post.right, post.out, (post.topY + layout.seaLevel) * 0.5, scratchTranslation);
    Matrix.ComposeToRef(scratchScale, scratchRotation, scratchTranslation, matrix);
    mesh.addBox(matrix, postColour(layout, post));
  }
  return mesh.build();
}

/**
 * Lamp photometry, candela, before the airfield's scene scale: a 4 m LED
 * lantern on the pier, quay and car park (about 1,200 cd; the car park's
 * 6 m columns a little more), a bollard light on the pontoon arm, and the
 * entrance beacons at a small harbour light's 40 cd (about 4 nautical miles
 * nominal range at night).
 */
export const MARINA_LAMP_CANDELA = Object.freeze({
  pier: 1_200,
  quay: 1_200,
  carPark: 1_600,
  pontoon: 80,
  beacon: 40,
});

const MARINA_LAMP_RADIUS_METERS = Object.freeze({ pier: 0.25, quay: 0.25, carPark: 0.3, pontoon: 0.1, beacon: 0.2 });

/** The lanterns' warm white is the airfield's adapted 2,700 K white, so the coast reads lit by the same lamps. */
const MARINA_LAMP_RGB: Rgb = AIRFIELD_LAMP_RGB.white;
const DARK: Rgb = Object.freeze([0, 0, 0] as const);

export interface MarinaLamps {
  /** Lamps first, then one fixture per beacon, in `layout.beacons` order. Absolute world positions. */
  readonly fixtures: readonly LightPointFixture[];
  /** Index in `fixtures` of the first beacon. */
  readonly firstBeacon: number;
}

export function marinaLamps(layout: MarinaLayout): MarinaLamps {
  const fixtures: LightPointFixture[] = [];
  const at = (right: number, out: number, y: number): readonly [number, number, number] => {
    const p = marinaToWorld(layout.frame, right, out);
    return [p.x, y, p.z] as const;
  };
  for (const lamp of layout.lamps) {
    fixtures.push({
      position: at(lamp.right, lamp.out, lamp.y),
      aim: [0, 1, 0] as const,
      intensity: MARINA_LAMP_CANDELA[lamp.kind] * AIRFIELD_LAMP_SCENE_SCALE,
      profileRow: 0,
      radiusMeters: MARINA_LAMP_RADIUS_METERS[lamp.kind],
      color: MARINA_LAMP_RGB,
    });
  }
  const firstBeacon = fixtures.length;
  for (const beacon of layout.beacons) {
    fixtures.push({
      position: at(beacon.right, beacon.out, beacon.y),
      aim: [0, 1, 0] as const,
      intensity: MARINA_LAMP_CANDELA.beacon * AIRFIELD_LAMP_SCENE_SCALE,
      profileRow: 0,
      radiusMeters: MARINA_LAMP_RADIUS_METERS.beacon,
      color: AIRFIELD_LAMP_RGB[beacon.color],
    });
  }
  return Object.freeze({ fixtures: Object.freeze(fixtures), firstBeacon });
}

/** Whether a beacon is in its flash at `timeSeconds`: on for `flashSeconds` of every `periodSeconds`. */
export function marinaBeaconLit(beacon: MarinaBeacon, timeSeconds: number): boolean {
  const period = beacon.periodSeconds;
  const phase = (((timeSeconds + beacon.phaseSeconds) % period) + period) % period;
  return phase < beacon.flashSeconds;
}

/**
 * Every marina fixture's colour now, into `out` (one entry per fixture):
 * lamps steady, beacons in or out of their flash, and everything dark when
 * the marina is culled. Returns whether anything changed.
 */
export function marinaLampColours(
  layout: MarinaLayout,
  lamps: MarinaLamps,
  timeSeconds: number,
  shown: boolean,
  out: Rgb[],
): boolean {
  let changed = out.length !== lamps.fixtures.length;
  out.length = lamps.fixtures.length;
  for (let index = 0; index < lamps.fixtures.length; index += 1) {
    let colour: Rgb = DARK;
    if (shown) {
      if (index < lamps.firstBeacon) colour = lamps.fixtures[index]!.color;
      else {
        const beacon = layout.beacons[index - lamps.firstBeacon]!;
        if (marinaBeaconLit(beacon, timeSeconds)) colour = lamps.fixtures[index]!.color;
      }
    }
    if (out[index] !== colour) {
      out[index] = colour;
      changed = true;
    }
  }
  return changed;
}

/** The marina's bounding radius about the site, metres, for the camera's distance test. */
export function marinaRadius(layout: MarinaLayout): number {
  let radius = 0;
  for (const box of layout.boxes) radius = Math.max(radius, Math.hypot(box.right, box.out) + Math.hypot(box.halfRight, box.halfOut));
  for (const post of layout.posts) radius = Math.max(radius, Math.hypot(post.right, post.out));
  return radius + MARINA_LAYOUT.boatLength;
}
