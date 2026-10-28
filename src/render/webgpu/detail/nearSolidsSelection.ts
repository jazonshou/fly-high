import { NEAR_SOLID_KIND, NEAR_SOLID_STRIDE } from "@/src/sim/person/nearSolids";
import {
  detailRadialScaleForWorldRadius,
  detailStemHash,
  normalAlignedQuaternion,
} from "./instanceFormat";
import {
  DETAIL_TREE_STEM_KEY_NEVER_DRAWN,
  detailTreeStemKey,
  yawLeanQuaternion,
  type DetailPresentationBuildCatalog,
} from "./presentationBuild";
import { buildTreeSkeleton } from "./treeSkeleton";
import type { GeneratedDetailCell, TreeSpecies } from "./types";

/**
 * The near solids (`src/sim/person/nearSolids.ts`) of the cells round a
 * point: what the walker and the character camera meet among the plants and
 * stones the near view draws. Pure and Babylon-free, so the detail worker
 * runs it on the cells it retains, and the runtime on inline cells.
 *
 * Every solid follows the record the presentation build writes for it
 * (`buildPresentationChunk`), so the walker meets what is drawn:
 *
 * - **Trunks.** A stem is drawn in the near band exactly when its stem key
 *   (`detailTreeStemKey`, at the law's near cap) is drawable, and its bark is
 *   the near prototype of its species (or family) and geometry variant: the
 *   tree skeleton's trunk (`buildTreeSkeleton`, the prototypes' seed), scaled
 *   by the record's height and radial scale, sheared by the "lean" character
 *   modifier and cut by the broken-top ones as the vertex shader does, then
 *   turned by the stem's yaw and lean. Two capsules follow that trunk: from
 *   half a metre under the base to 2.5 m up, with the drawn trunk's radius
 *   1.2 m up, then on to the lowest branch (a palm's crown) with its radius
 *   halfway. Wind sway and the crown wobble's few per cent are left out.
 * - **Rocks.** The drawn rock is a displaced unit icosphere at the placement
 *   (sunk into the ground), squashed to the rock's height: its top and its
 *   ring at the placement fix a sphere whose cap above the ground is the
 *   rock, tilted with it.
 * - **Logs and stumps.** Capsules along the clutter prototypes' axes, scaled
 *   by the piece's size and laid on the ground as drawn. Branch litter and
 *   moss stay soft, as grass and shrubs do.
 */

/** The seed every detail prototype is built from (`WorldDetailRuntime`). */
export const DETAIL_PROTOTYPE_SEED = 7;

/**
 * A trunk is two capsules: up through the walker's band to this height,
 * metres, then on to the crown, so a curving trunk is followed where the
 * walker touches it. The trunk reaches at least this far up.
 */
const TRUNK_BAND_METERS = 2.5;
/** And never past this share of the tree's height, nor a broken top's break. */
const TRUNK_MAX_TOP_SHARE = 0.9;
const BROKEN_TOP_SHARE = 0.72;
/** Height above the base the trunk's radius is read at: the walker's chest. */
const TRUNK_RADIUS_HEIGHT_METERS = 1.2;
/** The capsule starts this far under the base along the trunk, for sloping ground. */
const TRUNK_ROOT_METERS = 0.5;

/**
 * The rock prototypes' mean radius at their equator and their top, in
 * prototype units (`buildRockPrototype`; held within 0.04 of every variant
 * by the near-solids test).
 */
export const ROCK_PROTOTYPE_RING = 0.97;
export const ROCK_PROTOTYPE_TOP = 0.98;

/** The log prototype (`buildLog`): unit length along +x, axis 0.115 up, radius 0.13 tapering to 0.085. */
export const LOG_PROTOTYPE_AXIS_HEIGHT = 0.115;
export const LOG_PROTOTYPE_RADIUS = 0.105;
/** The stump prototype (`buildStump`): 0.32 tall, radius 0.17 above its flare. */
export const STUMP_PROTOTYPE_HEIGHT = 0.32;
export const STUMP_PROTOTYPE_RADIUS = 0.17;
/** A stump's capsule starts this far under its base, in prototype units. */
const STUMP_ROOT = 0.25;

export interface NearSolidsSelectionResident {
  readonly cell: GeneratedDetailCell;
  /** Canopy rank of each stem in `cell.trees` (`detailTreeCanopyRankOrder`). */
  readonly treeCanopyRank: Float32Array;
}

export interface NearSolidsSelectionInput {
  readonly residents: readonly NearSolidsSelectionResident[];
  /** World metres. */
  readonly centerX: number;
  readonly centerZ: number;
  readonly radius: number;
  /** The tier's near cap (`RenderedDensityLaw.nearStemsPerHectare`). */
  readonly nearStemsPerHectare: number;
  readonly treeVariantCap: number;
  readonly treePrototypeMode: "families" | "species";
}

/** A tree prototype's trunk: ring heights, centres and radii up the stem, prototype units. */
interface TrunkProfile {
  readonly y: Float64Array;
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly radius: Float64Array;
  /** Where the lowest branch leaves the trunk (a palm's crown base), as a share of the height. */
  readonly branchFree: number;
}

const TRUNK_PROFILES = new Map<string, TrunkProfile>();

function trunkProfile(species: TreeSpecies, variant: number): TrunkProfile {
  const key = `${species}/${variant}`;
  const cached = TRUNK_PROFILES.get(key);
  if (cached) return cached;
  const skeleton = buildTreeSkeleton(species, variant, DETAIL_PROTOTYPE_SEED);
  const trunk = skeleton.stems[0]!;
  const count = trunk.points.length;
  let lowestBranch = Number.POSITIVE_INFINITY;
  for (const stem of skeleton.stems) {
    if (stem.level === 1) lowestBranch = Math.min(lowestBranch, stem.points[0]!.y);
  }
  const profile: TrunkProfile = {
    y: new Float64Array(count),
    x: new Float64Array(count),
    z: new Float64Array(count),
    radius: new Float64Array(count),
    branchFree: Number.isFinite(lowestBranch) ? lowestBranch : skeleton.crownBaseY,
  };
  for (let i = 0; i < count; i += 1) {
    const point = trunk.points[i]!;
    profile.y[i] = point.y;
    profile.x[i] = point.x;
    profile.z[i] = point.z;
    profile.radius[i] = trunk.radii[i]!;
  }
  TRUNK_PROFILES.set(key, profile);
  return profile;
}

/** `sampleTrunk`'s answer: the trunk's centre and radius at a height, prototype units. */
const trunkAt = { x: 0, z: 0, radius: 0 };

function sampleTrunk(profile: TrunkProfile, t: number): void {
  const y = profile.y;
  const last = y.length - 1;
  let i = 0;
  while (i < last - 1 && y[i + 1]! < t) i += 1;
  const span = y[i + 1]! - y[i]!;
  const share = span > 1e-9 ? Math.min(1, Math.max(0, (t - y[i]!) / span)) : 0;
  trunkAt.x = profile.x[i]! + (profile.x[i + 1]! - profile.x[i]!) * share;
  trunkAt.z = profile.z[i]! + (profile.z[i + 1]! - profile.z[i]!) * share;
  trunkAt.radius = profile.radius[i]! + (profile.radius[i + 1]! - profile.radius[i]!) * share;
}

class SolidWriter {
  private data = new Float32Array(NEAR_SOLID_STRIDE * 64);
  private length = 0;

  push(kind: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number): void {
    if (this.length + NEAR_SOLID_STRIDE > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const data = this.data;
    const at = this.length;
    data[at] = kind;
    data[at + 1] = ax;
    data[at + 2] = ay;
    data[at + 3] = az;
    data[at + 4] = bx;
    data[at + 5] = by;
    data[at + 6] = bz;
    data[at + 7] = radius;
    this.length = at + NEAR_SOLID_STRIDE;
  }

  finish(): Float32Array {
    return this.data.slice(0, this.length);
  }
}

/** `rotate`'s answer. */
const rotated = { x: 0, y: 0, z: 0 };

/** Rotates (x, y, z) by the unit quaternion q into `rotated`. */
function rotate(q: readonly [number, number, number, number], x: number, y: number, z: number): void {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  rotated.x = x + qw * tx + (qy * tz - qz * ty);
  rotated.y = y + qw * ty + (qz * tx - qx * tz);
  rotated.z = z + qw * tz + (qx * ty - qy * tx);
}

/**
 * The drawn trunk's centre at unit height `t` (world metres from the stem's
 * placement) into `rotated`: the prototype scaled by the record, sheared by
 * the lean modifier, turned by the stem's yaw and lean.
 */
function trunkPoint(
  profile: TrunkProfile,
  t: number,
  height: number,
  across: number,
  shear: number,
  turn: readonly [number, number, number, number],
): void {
  sampleTrunk(profile, t);
  const y = t * height;
  rotate(turn, trunkAt.x * across + y * shear, y, trunkAt.z * across);
}

function fract(value: number): number {
  return value - Math.floor(value);
}

/**
 * The near solids within `radius` of the centre, `NEAR_SOLID_STRIDE` floats
 * each (x and z from the centre, y world height), trunks first.
 */
export function selectNearSolids(
  input: NearSolidsSelectionInput,
  catalog: DetailPresentationBuildCatalog,
): Float32Array {
  const writer = new SolidWriter();
  const { centerX, centerZ, radius } = input;
  const radiusSquared = radius * radius;
  for (const resident of input.residents) {
    const cell = resident.cell;
    if (
      cell.maxX < centerX - radius || cell.minX > centerX + radius
      || cell.maxZ < centerZ - radius || cell.minZ > centerZ + radius
    ) continue;
    const cellHectares = (cell.cellSizeMeters * cell.cellSizeMeters) / 10_000;
    const stemsPerHa = cell.trees.length / Math.max(cellHectares, 1e-6);
    for (let index = 0; index < cell.trees.length; index += 1) {
      const tree = cell.trees[index]!;
      const dx = tree.x - centerX;
      const dz = tree.z - centerZ;
      if (dx * dx + dz * dz > radiusSquared) continue;
      const stemKey = detailTreeStemKey(
        resident.treeCanopyRank[index] ?? 1,
        stemsPerHa,
        input.nearStemsPerHectare,
      );
      if (stemKey >= DETAIL_TREE_STEM_KEY_NEVER_DRAWN) continue;
      const treeCatalog = catalog.trees[tree.species];
      const species = input.treePrototypeMode === "species" ? tree.species : treeCatalog.prototypeFamily;
      const variantCount = Math.min(
        32,
        Math.max(1, Math.min(Math.round(catalog.trees[species].variantCount), input.treeVariantCap, 3)),
      );
      const variant = Math.min(variantCount - 1, Math.floor(((tree.selection * 71.7) % 1) * variantCount));
      const radialUnits = catalog.prototypes[`tree-${species}-v${variant}-trunk-near`]?.radialUnits;
      if (radialUnits === undefined) continue;
      const height = tree.heightMeters;
      const radial = detailRadialScaleForWorldRadius(tree.crownRadiusMeters, height, radialUnits);
      const across = height * radial;
      const profile = trunkProfile(species, variant);
      // The character modifier (the presentation build's variant byte): 1
      // leans the stem by shearing x with height, 2 and 4 break its top.
      const modifierHash = (tree.selection * 137.3) % 1;
      const modifier = modifierHash < 0.55 ? 0
        : modifierHash < 0.70 ? 1
        : modifierHash < 0.82 ? 3
        : modifierHash < 0.92 ? 2
        : 4;
      const shear = modifier === 1
        ? 0.1 + fract(detailStemHash(Math.round(Math.min(1, Math.max(0, stemKey % 1)) * 255) / 255) * 7.31) * 0.11
        : 0;
      let top = Math.min(TRUNK_MAX_TOP_SHARE, Math.max(profile.branchFree, TRUNK_BAND_METERS / height));
      if (modifier === 2 || modifier === 4) top = Math.min(top, BROKEN_TOP_SHARE);
      const turn = yawLeanQuaternion(
        tree.yawRadians,
        0.035 + ((tree.selection * 29.3) % 1) * 0.105,
        ((tree.selection * 53.9) % 1) * 2 * Math.PI,
      );
      // The trunk at its base, at the top of the walker's band and at the top.
      const middle = Math.min(top, TRUNK_BAND_METERS / height);
      trunkPoint(profile, 0, height, across, shear, turn);
      const baseX = rotated.x;
      const baseY = rotated.y;
      const baseZ = rotated.z;
      trunkPoint(profile, middle, height, across, shear, turn);
      const middleX = rotated.x;
      const middleY = rotated.y;
      const middleZ = rotated.z;
      const axisX = middleX - baseX;
      const axisY = middleY - baseY;
      const axisZ = middleZ - baseZ;
      const axisLength = Math.hypot(axisX, axisY, axisZ);
      if (!(axisLength > 1e-6)) continue;
      const root = TRUNK_ROOT_METERS / axisLength;
      sampleTrunk(profile, Math.min(TRUNK_RADIUS_HEIGHT_METERS / height, middle));
      writer.push(
        NEAR_SOLID_KIND.trunk,
        dx + baseX - axisX * root,
        tree.y + baseY - axisY * root,
        dz + baseZ - axisZ * root,
        dx + middleX,
        tree.y + middleY,
        dz + middleZ,
        trunkAt.radius * across,
      );
      if (top - middle < 0.01) continue;
      trunkPoint(profile, top, height, across, shear, turn);
      const topX = rotated.x;
      const topY = rotated.y;
      const topZ = rotated.z;
      sampleTrunk(profile, (middle + top) / 2);
      writer.push(
        NEAR_SOLID_KIND.bole,
        dx + middleX,
        tree.y + middleY,
        dz + middleZ,
        dx + topX,
        tree.y + topY,
        dz + topZ,
        trunkAt.radius * across,
      );
    }
  }

  for (const resident of input.residents) {
    for (const rock of resident.cell.rocks) {
      const dx = rock.x - centerX;
      const dz = rock.z - centerZ;
      if (dx * dx + dz * dz > radiusSquared) continue;
      const radialUnits = catalog.prototypes[`rock-${rock.variant}`]?.radialUnits;
      if (radialUnits === undefined) continue;
      const height = rock.radiusMeters * rock.flattening;
      const radial = detailRadialScaleForWorldRadius(
        rock.radiusMeters * (0.89 + rock.selection * 0.2),
        height,
        radialUnits,
      );
      const ring = ROCK_PROTOTYPE_RING * height * radial;
      const rise = ROCK_PROTOTYPE_TOP * height;
      if (!(ring > 0) || !(rise > 0)) continue;
      // The sphere through the top and the equator ring: its cap is the rock.
      const sphere = (ring * ring + rise * rise) / (2 * rise);
      rotate(normalAlignedQuaternion(rock.normal, rock.yawRadians, 0.6), 0, rise - sphere, 0);
      const x = dx + rotated.x;
      const y = rock.y + rotated.y;
      const z = dz + rotated.z;
      writer.push(NEAR_SOLID_KIND.rock, x, y, z, x, y, z, sphere);
    }
  }

  for (const resident of input.residents) {
    for (const piece of resident.cell.clutter) {
      if (piece.clutterKind !== "log" && piece.clutterKind !== "stump") continue;
      const dx = piece.x - centerX;
      const dz = piece.z - centerZ;
      if (dx * dx + dz * dz > radiusSquared) continue;
      const size = piece.sizeMeters;
      const turn = normalAlignedQuaternion(piece.normal, piece.yawRadians, 0.85);
      if (piece.clutterKind === "log") {
        const half = 0.5 - LOG_PROTOTYPE_RADIUS;
        rotate(turn, -half * size, LOG_PROTOTYPE_AXIS_HEIGHT * size, 0);
        const ax = rotated.x;
        const ay = rotated.y;
        const az = rotated.z;
        rotate(turn, half * size, LOG_PROTOTYPE_AXIS_HEIGHT * size, 0);
        writer.push(
          NEAR_SOLID_KIND.log,
          dx + ax, piece.y + ay, dz + az,
          dx + rotated.x, piece.y + rotated.y, dz + rotated.z,
          LOG_PROTOTYPE_RADIUS * size,
        );
      } else {
        rotate(turn, 0, -STUMP_ROOT * size, 0);
        const ax = rotated.x;
        const ay = rotated.y;
        const az = rotated.z;
        rotate(turn, 0, (STUMP_PROTOTYPE_HEIGHT - STUMP_PROTOTYPE_RADIUS) * size, 0);
        writer.push(
          NEAR_SOLID_KIND.stump,
          dx + ax, piece.y + ay, dz + az,
          dx + rotated.x, piece.y + rotated.y, dz + rotated.z,
          STUMP_PROTOTYPE_RADIUS * size,
        );
      }
    }
  }
  return writer.finish();
}
