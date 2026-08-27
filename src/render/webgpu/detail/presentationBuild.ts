import {
  detailRadialScaleForWorldRadius,
  normalAlignedQuaternion,
  yawQuaternion,
  type DetailBillboardFrameBounds,
  type DetailInstanceRecord,
  type DetailPrototypeBoundKernel,
} from "./instanceFormat";
import { renderedShareAtDistance, type RenderedDensityLaw } from "./renderedDensity";
import type {
  DetailFloatingOrigin,
  DetailLod,
  GeneratedDetailCell,
  ShrubSpecies,
  TreeSpecies,
} from "./types";

/**
 * CPU-only presentation synthesis.
 *
 * This module deliberately has no Babylon dependency. Inputs and catalog
 * records are structured-cloneable, while the synchronous sink is the only
 * storage boundary: the live runtime writes into its pooled CPU batches and
 * a worker can instead pack transferable batch streams without changing
 * traversal order, selection, or the generator's bounded work units.
 */

export const DETAIL_FADE_MARGIN_METERS = 100;
export const DETAIL_CULL_FADE_MARGIN_METERS = 420;
// Fix-pack F4: 2 m / 0.2 gave at most one 1.4 m blade patch per 4–11 m² even
// at point-blank range — the reported smooth green sheet between patches.
// Three coordinated moves, sized against the 2-16 closed-form integral
// (π·f·(2R−f)/s² · 48 ≤ 0.9 M at the tier-2 220 m radius, which these
// constants land at ~0.89 M): finer candidates, the full-density share, and
// a near-camera acceptance boost that raises effective coverage toward its
// cap of 1 inside ~28 m — under the integral's worst case by construction,
// so the budget formula is untouched. The spacing MUST divide the 512 m cell
// exactly (512 = 1.6 · 320): the candidate grid is anchored per cell, and a
// non-divisor spacing leaves a bare remainder stripe along every cell edge.
export const GROUND_COVER_CANDIDATE_SPACING_METERS = 1.6;
export const DETAIL_MEMBERSHIP_SLACK_METERS = 96;
export const GROUND_COVER_EDGE_FADE_METERS = 30;
export const GROUND_COVER_FULL_DENSITY_SHARE = 0.17;
export const GROUND_COVER_NEAR_BOOST_RADIUS_METERS = 28;
export const GROUND_COVER_NEAR_BOOST_FACTOR = 0.8;
export const TREE_IMPOSTOR_PROTOTYPE_KEY = "tree-impostor";

/** Cheap hash/rank rejects grouped into one still-bounded scheduler step. */
const DETAIL_PRESENTATION_REJECTION_BLOCK_SIZE = 32;

type DetailFadeBand = "near" | "mid" | "far";
export type DetailFadeBandMembership = Readonly<{ readonly band: DetailFadeBand }>;

const DETAIL_NEAR_MEMBERSHIP: DetailFadeBandMembership = Object.freeze({ band: "near" });
const DETAIL_MID_MEMBERSHIP: DetailFadeBandMembership = Object.freeze({ band: "mid" });
const DETAIL_FAR_MEMBERSHIP: DetailFadeBandMembership = Object.freeze({ band: "far" });

const DETAIL_FADE_MEMBERSHIPS_BY_MASK: readonly (
  readonly DetailFadeBandMembership[]
)[] = Object.freeze([
  Object.freeze([]),
  Object.freeze([DETAIL_NEAR_MEMBERSHIP]),
  Object.freeze([DETAIL_MID_MEMBERSHIP]),
  Object.freeze([DETAIL_NEAR_MEMBERSHIP, DETAIL_MID_MEMBERSHIP]),
  Object.freeze([DETAIL_FAR_MEMBERSHIP]),
  Object.freeze([DETAIL_NEAR_MEMBERSHIP, DETAIL_FAR_MEMBERSHIP]),
  Object.freeze([DETAIL_MID_MEMBERSHIP, DETAIL_FAR_MEMBERSHIP]),
  Object.freeze([DETAIL_NEAR_MEMBERSHIP, DETAIL_MID_MEMBERSHIP, DETAIL_FAR_MEMBERSHIP]),
]);

const IMPOSTOR_SPECIES: readonly TreeSpecies[] = [
  "pine",
  "cedar",
  "spruce",
  "oak",
  "maple",
  "birch",
  "willow",
];

/**
 * Stable canopy rank used by both generation consumers. Ranking by crown
 * radius preserves closure while the selection quotient remains nested as
 * rendered density changes.
 */
export function detailTreeCanopyRankOrder(
  trees: readonly { readonly crownRadiusMeters: number; readonly selection: number }[],
): Float32Array {
  const order = new Float32Array(trees.length);
  if (trees.length === 0) return order;
  const indices = trees.map((_, index) => index);
  indices.sort((first, second) => {
    const wide = trees[second]!.crownRadiusMeters - trees[first]!.crownRadiusMeters;
    if (wide !== 0) return wide;
    return trees[first]!.selection - trees[second]!.selection;
  });
  for (let rank = 0; rank < indices.length; rank += 1) {
    order[indices[rank]!] = rank / trees.length;
  }
  return order;
}

export interface DetailPresentationChunkStatistics {
  readonly nearCells: number;
  readonly midCells: number;
  readonly treeInstances: number;
  readonly shrubInstances: number;
  readonly rockInstances: number;
  readonly clutterInstances: number;
  readonly groundCoverInstances: number;
}

interface MutableDetailPresentationChunkStatistics {
  nearCells: number;
  midCells: number;
  treeInstances: number;
  shrubInstances: number;
  rockInstances: number;
  clutterInstances: number;
  groundCoverInstances: number;
}

export interface DetailPresentationBuildResident {
  readonly cell: GeneratedDetailCell;
  readonly treeCanopyRank: Float32Array;
  readonly lod: DetailLod;
  readonly distance: number;
}

export interface DetailPresentationPrototypeCatalogRecord {
  /** Present for prototypes whose records solve a requested world radius. */
  readonly radialUnits?: number;
  /** Worker packing consumes the same conservative bounds contract as runtime packing. */
  readonly boundKernel: DetailPrototypeBoundKernel;
}

export interface DetailPresentationImpostorCatalogRecord {
  readonly radialUnits: number;
  readonly frame: DetailBillboardFrameBounds;
}

export interface DetailPresentationTreeCatalogRecord {
  readonly prototypeFamily: TreeSpecies;
  readonly variantCount: number;
  readonly trunkTint: readonly [number, number, number, number];
}

export interface DetailPresentationShrubCatalogRecord {
  readonly variantCount: number;
}

/** Structured-cloneable prototype metadata retained independently of Babylon. */
export interface DetailPresentationBuildCatalog {
  readonly prototypes: Readonly<Record<string, DetailPresentationPrototypeCatalogRecord>>;
  readonly impostors: Readonly<
    Partial<Record<TreeSpecies, DetailPresentationImpostorCatalogRecord>>
  >;
  readonly trees: Readonly<Record<TreeSpecies, DetailPresentationTreeCatalogRecord>>;
  readonly shrubs: Readonly<Record<ShrubSpecies, DetailPresentationShrubCatalogRecord>>;
  readonly groundCoverGrid: number;
  readonly useImpostors: boolean;
}

export interface DetailPresentationBuildInput {
  readonly residents: readonly DetailPresentationBuildResident[];
  readonly floatingOrigin: DetailFloatingOrigin;
  readonly densityLaw: RenderedDensityLaw;
  readonly treeVariantCap: number;
  readonly treePrototypeMode: "families" | "species";
  readonly grassRadiusMeters: number;
  /** Wave G: the compute blade system replaces the grass-archetype patches. */
  readonly groundCoverBladesActive?: boolean;
  readonly observerX: number;
  readonly observerZ: number;
}

export interface DetailPresentationBuildSink {
  /**
   * Consumes a record synchronously and in call order. The builder reuses one
   * ground-cover tint tuple, so sinks must pack/copy before returning rather
   * than retain mutable record members by reference.
   */
  appendInstance(
    prototypeKey: string,
    record: DetailInstanceRecord,
    billboardFrame?: DetailBillboardFrameBounds,
  ): void;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function impostorSpeciesSlot(species: TreeSpecies): number {
  const index = IMPOSTOR_SPECIES.indexOf(species);
  return index < 0 ? 0 : index;
}

/** Pure 2D hash for candidate jitter/acceptance (world-position keyed). */
function groundCoverHash(x: number, z: number, lane: number): number {
  let h = (Math.imul(Math.round(x * 8), 0x27d4_eb2d)
    ^ Math.imul(Math.round(z * 8), 0x1656_67b1)
    ^ Math.imul(lane + 1, 0x9e37_79b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return ((h ^ (h >>> 14)) >>> 0) / 4_294_967_296;
}

export interface GroundCoverCandidateRange {
  readonly minimumColumn: number;
  readonly maximumColumnExclusive: number;
  readonly minimumRow: number;
  readonly maximumRowExclusive: number;
}

/** Candidate-grid rectangle whose jitter envelopes can intersect the grass disc. */
export function groundCoverCandidateRange(
  cellMinimumX: number,
  cellMinimumZ: number,
  cellSizeMeters: number,
  observerX: number,
  observerZ: number,
  radiusMeters: number,
  spacingMeters = GROUND_COVER_CANDIDATE_SPACING_METERS,
): GroundCoverCandidateRange {
  requireFinite(cellMinimumX, "Ground-cover cell minimum x");
  requireFinite(cellMinimumZ, "Ground-cover cell minimum z");
  requireFinite(observerX, "Ground-cover observer x");
  requireFinite(observerZ, "Ground-cover observer z");
  if (!Number.isFinite(cellSizeMeters) || cellSizeMeters <= 0) {
    throw new RangeError("Ground-cover cell size must be finite and positive");
  }
  if (!Number.isFinite(radiusMeters) || radiusMeters < 0) {
    throw new RangeError("Ground-cover radius must be finite and non-negative");
  }
  if (!Number.isFinite(spacingMeters) || spacingMeters <= 0) {
    throw new RangeError("Ground-cover candidate spacing must be finite and positive");
  }
  const count = Math.floor(cellSizeMeters / spacingMeters);
  const axisRange = (cellMinimum: number, observer: number): readonly [number, number] => [
    clamp(Math.floor((observer - radiusMeters - cellMinimum) / spacingMeters), 0, count),
    clamp(Math.ceil((observer + radiusMeters - cellMinimum) / spacingMeters), 0, count),
  ];
  const [minimumColumn, maximumColumnExclusive] = axisRange(cellMinimumX, observerX);
  const [minimumRow, maximumRowExclusive] = axisRange(cellMinimumZ, observerZ);
  return {
    minimumColumn,
    maximumColumnExclusive,
    minimumRow,
    maximumRowExclusive,
  };
}

export function detailCellMinimumDistanceMeters(
  x: number,
  z: number,
  cellX: number,
  cellZ: number,
  cellSize: number,
): number {
  const minX = cellX * cellSize;
  const minZ = cellZ * cellSize;
  const maxX = minX + cellSize;
  const maxZ = minZ + cellSize;
  return Math.hypot(Math.max(minX - x, 0, x - maxX), Math.max(minZ - z, 0, z - maxZ));
}

/** Render bands whose padded residency envelope contains a stem. */
export function detailFadeBandMemberships(
  distanceMeters: number,
  law: RenderedDensityLaw,
): readonly DetailFadeBandMembership[] {
  const nearEdge = law.near.outerRadiusMeters;
  const midEdge = law.mid.outerRadiusMeters;
  const cullEdge = law.far.outerRadiusMeters;
  const slack = DETAIL_MEMBERSHIP_SLACK_METERS;
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0
    || distanceMeters >= cullEdge + slack) {
    return DETAIL_FADE_MEMBERSHIPS_BY_MASK[0]!;
  }
  let membershipMask = 0;
  if (distanceMeters <= nearEdge + slack) membershipMask |= 1;
  if (distanceMeters > nearEdge - DETAIL_FADE_MARGIN_METERS - slack
    && distanceMeters <= midEdge + slack) {
    membershipMask |= 2;
  }
  if (distanceMeters > midEdge - DETAIL_FADE_MARGIN_METERS - slack) {
    membershipMask |= 4;
  }
  return DETAIL_FADE_MEMBERSHIPS_BY_MASK[membershipMask]!;
}

/** Composes yaw with a small lean about a hashed azimuth (2-12). */
function yawLeanQuaternion(
  yawRadians: number,
  leanRadians: number,
  leanAzimuthRadians: number,
): [number, number, number, number] {
  const [, yy, , yw] = yawQuaternion(yawRadians);
  const halfLean = leanRadians / 2;
  const sinLean = Math.sin(halfLean);
  const lx = Math.cos(leanAzimuthRadians) * sinLean;
  const lz = Math.sin(leanAzimuthRadians) * sinLean;
  const lw = Math.cos(halfLean);
  return [
    lx * yw + lz * yy,
    yy * lw,
    lz * yw - lx * yy,
    lw * yw,
  ];
}

function requiredPrototypeRadialUnits(
  catalog: DetailPresentationBuildCatalog,
  prototypeKey: string,
  diagnosticKey = prototypeKey,
): number {
  const radialUnits = catalog.prototypes[prototypeKey]?.radialUnits;
  if (radialUnits === undefined) {
    throw new Error(`Missing radial contract for ${diagnosticKey}`);
  }
  return radialUnits;
}

/**
 * Builds one presentation chunk without touching a Mesh, GPU allocation, or
 * Babylon object. A yielded value is exactly one scheduler work unit; do not
 * coalesce or reorder yields without changing the runtime budget contract.
 */
export function* buildPresentationChunk(
  input: DetailPresentationBuildInput,
  catalog: DetailPresentationBuildCatalog,
  sink: DetailPresentationBuildSink,
): Generator<void, DetailPresentationChunkStatistics, void> {
  const {
    residents,
    floatingOrigin,
    densityLaw,
    treeVariantCap,
    treePrototypeMode,
    grassRadiusMeters,
    observerX,
    observerZ,
  } = input;
  const statistics: MutableDetailPresentationChunkStatistics = {
    nearCells: 0,
    midCells: 0,
    treeInstances: 0,
    shrubInstances: 0,
    rockInstances: 0,
    clutterInstances: 0,
    groundCoverInstances: 0,
  };
  const groundCoverTint: [number, number, number, number] = [0, 0, 0, 1];

  for (const resident of residents) {
    yield;
    if (resident.lod === "near") statistics.nearCells += 1;
    else statistics.midCells += 1;

    const cellHectares = (resident.cell.cellSizeMeters * resident.cell.cellSizeMeters) / 10_000;
    const stemsPerHa = resident.cell.trees.length / Math.max(cellHectares, 1e-6);
    const treeBudgetPerHa = densityLaw.nearStemsPerHectare
      * renderedShareAtDistance(densityLaw, resident.distance);
    const treeShare = Math.min(1, treeBudgetPerHa / Math.max(stemsPerHa, 1e-6));
    const shrubsPerHa = resident.cell.shrubs.length / Math.max(cellHectares, 1e-6);
    const shrubBudgetPerHa = 60 * renderedShareAtDistance(densityLaw, resident.distance);
    const shrubShare = resident.distance > densityLaw.mid.outerRadiusMeters
      ? 0
      : Math.min(1, shrubBudgetPerHa / Math.max(shrubsPerHa, 1e-6));
    const currentCellDistance = detailCellMinimumDistanceMeters(
      observerX,
      observerZ,
      resident.cell.cellX,
      resident.cell.cellZ,
      resident.cell.cellSizeMeters,
    );

    const treeCount = currentCellDistance >= densityLaw.far.outerRadiusMeters
        + DETAIL_MEMBERSHIP_SLACK_METERS
      ? 0
      : resident.cell.trees.length;
    let rejectedTreeCandidates = 0;
    for (let treeIndex = 0; treeIndex < treeCount; treeIndex += 1) {
      const tree = resident.cell.trees[treeIndex]!;
      if ((resident.treeCanopyRank[treeIndex] ?? 1) > treeShare) {
        rejectedTreeCandidates += 1;
        if (rejectedTreeCandidates === DETAIL_PRESENTATION_REJECTION_BLOCK_SIZE) {
          yield;
          rejectedTreeCandidates = 0;
        }
        continue;
      }
      yield;
      const localX = tree.x - floatingOrigin.x;
      const localY = tree.y - floatingOrigin.y;
      const localZ = tree.z - floatingOrigin.z;
      const stemDistance = Math.hypot(tree.x - observerX, tree.z - observerZ);
      const memberships = detailFadeBandMemberships(stemDistance, densityLaw);
      if (memberships.length === 0) continue;
      const modifierHash = (tree.selection * 137.3) % 1;
      const modifierBits = modifierHash < 0.55 ? 0
        : modifierHash < 0.70 ? 1
        : modifierHash < 0.82 ? 3
        : modifierHash < 0.92 ? 2
        : 4;
      const leanRadians = 0.035 + ((tree.selection * 29.3) % 1) * 0.105;
      const leanAzimuth = ((tree.selection * 53.9) % 1) * 2 * Math.PI;
      const quaternion = yawLeanQuaternion(tree.yawRadians, leanRadians, leanAzimuth);
      const windPhase = tree.windPhaseRadians / (2 * Math.PI);
      const crownBase: DetailInstanceRecord = {
        x: localX,
        y: localY,
        z: localZ,
        quaternion,
        heightScaleMeters: tree.heightMeters,
        radialScale: 1,
        fade: 1,
        variant: modifierBits * 32,
        tint: tree.color,
        windPhase,
        windResponse: clamp(tree.windResponse, 0, 1),
      };
      const variantHash = (tree.selection * 71.7) % 1;
      for (const membership of memberships) {
        const usesImpostor = membership.band === "far" && catalog.useImpostors;
        const treeCatalog = catalog.trees[tree.species];
        const prototypeSpecies = usesImpostor || treePrototypeMode === "species"
          ? tree.species
          : treeCatalog.prototypeFamily;
        const bandVariantCap = membership.band === "far" ? 1 : 3;
        const variantCount = clamp(
          Math.min(
            Math.round(catalog.trees[prototypeSpecies].variantCount),
            treeVariantCap,
            bandVariantCap,
          ),
          1,
          32,
        );
        const geometryVariant = Math.min(
          variantCount - 1,
          Math.floor(variantHash * variantCount),
        );
        const bandCode = membership.band === "near" ? 0 : membership.band === "mid" ? 1 : 2;
        const crownBatchKey = usesImpostor
          ? TREE_IMPOSTOR_PROTOTYPE_KEY
          : `tree-${prototypeSpecies}-v${geometryVariant}-crown-${membership.band}`;
        const impostor = usesImpostor ? catalog.impostors[tree.species] : undefined;
        const crownPrototypeRadius = usesImpostor
          ? impostor?.radialUnits
          : catalog.prototypes[crownBatchKey]?.radialUnits;
        if (crownPrototypeRadius === undefined) {
          throw new Error(`Missing radial contract for ${crownBatchKey}/${tree.species}`);
        }
        const crown: DetailInstanceRecord = {
          ...crownBase,
          radialScale: detailRadialScaleForWorldRadius(
            tree.crownRadiusMeters,
            tree.heightMeters,
            crownPrototypeRadius,
          ),
          fade: bandCode / 127,
          fadeIncoming: false,
          variant: membership.band === "far"
            ? impostorSpeciesSlot(tree.species) * 32
              + Math.floor(((tree.selection * 97.3) % 1) * 32)
            : geometryVariant + modifierBits * 32,
        };
        const billboardFrame = usesImpostor ? impostor?.frame : undefined;
        if (usesImpostor && !billboardFrame) {
          throw new Error(`Missing impostor bounds frame for ${tree.species}`);
        }
        sink.appendInstance(crownBatchKey, crown, billboardFrame);
        if (membership.band !== "far") {
          // Wave T: the leaf-cluster card shell is the tree's visible canopy
          // at BOTH geometry bands. Every tree part registers the skeleton's
          // shared envelope as its radial contract, so one desired radius
          // (the stem's crown radius) maps bark, core, and cards with one
          // world scale and the parts stay exactly aligned.
          const fringeBatchKey =
            `tree-${prototypeSpecies}-v${geometryVariant}-fringe-${membership.band}`;
          const fringeRadius = catalog.prototypes[fringeBatchKey]?.radialUnits;
          if (fringeRadius !== undefined) {
            sink.appendInstance(fringeBatchKey, {
              ...crown,
              radialScale: detailRadialScaleForWorldRadius(
                tree.crownRadiusMeters,
                tree.heightMeters,
                fringeRadius,
              ),
              // Band code 3 near / 4 mid: each shell owns its window with a
              // dithered handoff at the shared near-switch edge, so the card
              // swap never pops in one frame.
              fade: (membership.band === "near" ? 3 : 4) / 127,
            });
          }
          const trunkBatchKey =
            `tree-${prototypeSpecies}-v${geometryVariant}-trunk-${membership.band}`;
          sink.appendInstance(trunkBatchKey, {
            ...crown,
            radialScale: detailRadialScaleForWorldRadius(
              tree.crownRadiusMeters,
              tree.heightMeters,
              requiredPrototypeRadialUnits(catalog, trunkBatchKey),
            ),
            tint: treeCatalog.trunkTint,
            // The bark part now carries real branches: stiffer than the card
            // shell riding their tips, but no longer a rigid pole.
            windResponse: 0.3,
          });
        }
      }
      statistics.treeInstances += 1;
    }

    let rejectedShrubCandidates = 0;
    for (
      const shrub of shrubShare <= 0
        || currentCellDistance >= densityLaw.mid.outerRadiusMeters
        ? []
        : resident.cell.shrubs
    ) {
      if (shrub.selection > shrubShare) {
        rejectedShrubCandidates += 1;
        if (rejectedShrubCandidates === DETAIL_PRESENTATION_REJECTION_BLOCK_SIZE) {
          yield;
          rejectedShrubCandidates = 0;
        }
        continue;
      }
      yield;
      const shrubDistance = Math.hypot(shrub.x - observerX, shrub.z - observerZ);
      const shrubEdge = densityLaw.mid.outerRadiusMeters;
      if (shrubDistance >= shrubEdge) continue;
      const shrubFade = shrubDistance > shrubEdge - DETAIL_FADE_MARGIN_METERS
        ? (shrubEdge - shrubDistance) / DETAIL_FADE_MARGIN_METERS
        : 1;
      const shrubVariantCount = shrubDistance <= densityLaw.near.outerRadiusMeters
        ? catalog.shrubs[shrub.species].variantCount
        : 1;
      const shrubVariant = Math.min(
        shrubVariantCount - 1,
        Math.floor(((shrub.selection * 71.7) % 1) * shrubVariantCount),
      );
      const shrubBatchKey = `shrub-${shrub.species}-v${shrubVariant}`;
      const shrubPrototypeRadius = catalog.prototypes[shrubBatchKey]?.radialUnits;
      if (shrubPrototypeRadius === undefined) {
        throw new Error(`Missing radial contract for ${shrubBatchKey}`);
      }
      sink.appendInstance(shrubBatchKey, {
        x: shrub.x - floatingOrigin.x,
        y: shrub.y - floatingOrigin.y,
        z: shrub.z - floatingOrigin.z,
        quaternion: yawQuaternion(shrub.yawRadians),
        heightScaleMeters: shrub.heightMeters,
        radialScale: detailRadialScaleForWorldRadius(
          shrub.radiusMeters * (0.92 + shrub.selection * 0.12),
          shrub.heightMeters,
          shrubPrototypeRadius,
        ),
        fade: shrubFade,
        fadeIncoming: false,
        variant: shrubVariant,
        tint: shrub.color,
        windPhase: shrub.windPhaseRadians / (2 * Math.PI),
        windResponse: clamp(shrub.windResponse, 0, 1),
      });
      statistics.shrubInstances += 1;
    }

    for (
      const rock of currentCellDistance >= densityLaw.mid.outerRadiusMeters
        ? []
        : resident.cell.rocks
    ) {
      yield;
      const rockDistance = Math.hypot(rock.x - observerX, rock.z - observerZ);
      const bigRock = rock.radiusMeters >= 2.2 && rock.selection <= 0.22;
      const rockEdge = bigRock
        ? densityLaw.mid.outerRadiusMeters
        : densityLaw.near.outerRadiusMeters;
      if (rockDistance >= rockEdge) continue;
      const rockFade = rockDistance > rockEdge - DETAIL_FADE_MARGIN_METERS
        ? (rockEdge - rockDistance) / DETAIL_FADE_MARGIN_METERS
        : 1;
      const rockBatchKey = `rock-${rock.variant}`;
      sink.appendInstance(rockBatchKey, {
        x: rock.x - floatingOrigin.x,
        y: rock.y - floatingOrigin.y,
        z: rock.z - floatingOrigin.z,
        quaternion: normalAlignedQuaternion(rock.normal, rock.yawRadians, 0.6),
        heightScaleMeters: rock.radiusMeters * rock.flattening,
        radialScale: detailRadialScaleForWorldRadius(
          rock.radiusMeters * (0.89 + rock.selection * 0.2),
          rock.radiusMeters * rock.flattening,
          requiredPrototypeRadialUnits(catalog, rockBatchKey),
        ),
        fade: rockFade,
        fadeIncoming: false,
        variant: 0,
        tint: rock.color,
        windPhase: 0,
        windResponse: 0,
      });
      statistics.rockInstances += 1;
    }

    for (
      const piece of currentCellDistance >= densityLaw.near.outerRadiusMeters
        ? []
        : resident.cell.clutter
    ) {
      yield;
      const clutterDistance = Math.hypot(piece.x - observerX, piece.z - observerZ);
      const clutterEdge = densityLaw.near.outerRadiusMeters;
      if (clutterDistance >= clutterEdge) continue;
      const clutterFade = clutterDistance > clutterEdge - DETAIL_FADE_MARGIN_METERS
        ? (clutterEdge - clutterDistance) / DETAIL_FADE_MARGIN_METERS
        : 1;
      sink.appendInstance(`clutter-${piece.clutterKind}`, {
        x: piece.x - floatingOrigin.x,
        y: piece.y - floatingOrigin.y,
        z: piece.z - floatingOrigin.z,
        quaternion: normalAlignedQuaternion(piece.normal, piece.yawRadians, 0.85),
        heightScaleMeters: piece.sizeMeters,
        radialScale: 1,
        fade: clutterFade,
        fadeIncoming: false,
        variant: 0,
        tint: piece.color,
        windPhase: 0,
        windResponse: 0,
      });
      statistics.clutterInstances += 1;
    }

    const grassRadius = grassRadiusMeters;
    if (resident.cell.groundCover.length > 0 && currentCellDistance < grassRadius) {
      const cell = resident.cell;
      const spacing = GROUND_COVER_CANDIDATE_SPACING_METERS;
      const nodeSpacing = cell.cellSizeMeters / catalog.groundCoverGrid;
      const fullDensityRadius = grassRadius * GROUND_COVER_FULL_DENSITY_SHARE;
      const candidateRange = groundCoverCandidateRange(
        cell.minX,
        cell.minZ,
        cell.cellSizeMeters,
        observerX,
        observerZ,
        grassRadius,
        spacing,
      );
      for (
        let row = candidateRange.minimumRow;
        row < candidateRange.maximumRowExclusive;
        row += 1
      ) {
        for (
          let column = candidateRange.minimumColumn;
          column < candidateRange.maximumColumnExclusive;
          column += 1
        ) {
          yield;
          const baseX = cell.minX + (column + 0.5) * spacing;
          const baseZ = cell.minZ + (row + 0.5) * spacing;
          const jitterX = (groundCoverHash(baseX, baseZ, 0) - 0.5) * spacing;
          const jitterZ = (groundCoverHash(baseX, baseZ, 1) - 0.5) * spacing;
          const x = baseX + jitterX;
          const z = baseZ + jitterZ;
          const patchDistance = Math.hypot(x - observerX, z - observerZ);
          if (patchDistance >= grassRadius) continue;
          const ramp = Math.min(1, fullDensityRadius / Math.max(patchDistance, 1));
          const nodeColumn = Math.min(
            catalog.groundCoverGrid - 1,
            Math.max(0, Math.floor((x - cell.minX) / nodeSpacing)),
          );
          const nodeRow = Math.min(
            catalog.groundCoverGrid - 1,
            Math.max(0, Math.floor((z - cell.minZ) / nodeSpacing)),
          );
          const node = cell.groundCover[nodeRow * catalog.groundCoverGrid + nodeColumn];
          if (!node || node.coverage <= 0) continue;
          // Wave G: the compute blade system carries the grass archetype
          // wherever it is live; the card patches keep the structured
          // archetypes (fern/heather/reed) whose forms blades cannot carry.
          if (input.groundCoverBladesActive && node.archetype === "grass") continue;
          const nearBoost = 1 + GROUND_COVER_NEAR_BOOST_FACTOR
            * Math.max(0, 1 - patchDistance / GROUND_COVER_NEAR_BOOST_RADIUS_METERS);
          if (groundCoverHash(x, z, 2) >= Math.min(1, ramp * node.coverage * nearBoost)) {
            continue;
          }
          const heightHash = groundCoverHash(x, z, 3);
          const grassFade = patchDistance > grassRadius - GROUND_COVER_EDGE_FADE_METERS
            ? (grassRadius - patchDistance) / GROUND_COVER_EDGE_FADE_METERS
            : 1;
          const gridU = clamp(
            (x - cell.minX) / nodeSpacing - 0.5,
            0,
            catalog.groundCoverGrid - 1,
          );
          const gridV = clamp(
            (z - cell.minZ) / nodeSpacing - 0.5,
            0,
            catalog.groundCoverGrid - 1,
          );
          const u0 = Math.floor(gridU);
          const v0 = Math.floor(gridV);
          const u1 = Math.min(catalog.groundCoverGrid - 1, u0 + 1);
          const v1 = Math.min(catalog.groundCoverGrid - 1, v0 + 1);
          const fu = gridU - u0;
          const fv = gridV - v0;
          const height00 = cell.groundCover[v0 * catalog.groundCoverGrid + u0]?.heightMeters
            ?? node.heightMeters;
          const height10 = cell.groundCover[v0 * catalog.groundCoverGrid + u1]?.heightMeters
            ?? node.heightMeters;
          const height01 = cell.groundCover[v1 * catalog.groundCoverGrid + u0]?.heightMeters
            ?? node.heightMeters;
          const height11 = cell.groundCover[v1 * catalog.groundCoverGrid + u1]?.heightMeters
            ?? node.heightMeters;
          const patchHeight =
            height00 * (1 - fu) * (1 - fv)
            + height10 * fu * (1 - fv)
            + height01 * (1 - fu) * fv
            + height11 * fu * fv;
          groundCoverTint[0] = node.color[0];
          groundCoverTint[1] = node.color[1];
          groundCoverTint[2] = node.color[2];
          sink.appendInstance(`ground-${node.archetype}`, {
            x: x - floatingOrigin.x,
            y: patchHeight - floatingOrigin.y,
            z: z - floatingOrigin.z,
            quaternion: yawQuaternion(groundCoverHash(x, z, 4) * 2 * Math.PI),
            heightScaleMeters: (0.75 + heightHash * 0.5)
              * (node.archetype === "reed" ? 1.15
                : node.archetype === "heather" ? 0.75
                : node.archetype === "fern" ? 0.85 : 0.8),
            radialScale: 1,
            fade: grassFade,
            fadeIncoming: false,
            variant: 0,
            tint: groundCoverTint,
            windPhase: groundCoverHash(x, z, 5),
            windResponse: node.archetype === "heather" ? 0.3
              : node.archetype === "fern" ? 0.5 : 0.9,
          });
          statistics.groundCoverInstances += 1;
        }
      }
    }
  }
  return statistics;
}
