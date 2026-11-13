import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { createWorld, sampleTerrain } from "../src/world";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import {
  DetailInstanceBounds,
  DetailInstanceWriter,
  detailPrototypeBoundKernel,
} from "../src/render/webgpu/detail/instanceFormat";
import {
  packDetailCell,
  packedGroundCoverArchetype,
  PackedClutterView,
  PackedRockView,
  PackedShrubView,
  PackedTreeView,
  type PackedDetailCell,
} from "../src/render/webgpu/detail/packedCell";
import {
  buildPresentationChunk,
  detailCellMinimumDistanceMeters,
  detailTreeCanopyRankOrder,
  type DetailPresentationBuildCatalog,
  type DetailPresentationBuildInput,
} from "../src/render/webgpu/detail/presentationBuild";
import { RENDERED_DENSITY_LAWS } from "../src/render/webgpu/detail/renderedDensity";
import type {
  ClutterKind,
  GeneratedDetailCell,
  GroundCoverArchetype,
  RockVariant,
  ShrubSpecies,
  TreeSpecies,
} from "../src/render/webgpu/detail/types";

/**
 * The detail worker and the inline fallback retain each generated cell as
 * packed columns (`packDetailCell`), and the presentation build reads those
 * columns through cursors. The presentation build's own pinned fingerprints
 * (render.webgpu-detail-presentation-build) were recorded when it still read
 * placement objects; this file proves the packing itself loses nothing.
 */

// The Low bench world, and a cell on its route with every placement kind.
const WORLD = createWorld(0x51a7e);
function generatedCell(cellX: number, cellZ: number): GeneratedDetailCell {
  return generateDetailCell({
    worldSeed: WORLD.seed,
    cellX,
    cellZ,
    cellSizeMeters: 512,
    densityMultiplier: 0.75,
    terrainSample: (x, z) => sampleTerrain(WORLD, x, z),
    seaLevelMeters: WORLD.seaLevel,
    dayOfYear: 172,
    latitudeDegrees: WORLD.latitudeDegrees,
  });
}
const FOREST = generatedCell(14, 3);
const EDGE = generatedCell(12, 2);

/** Rebuilds placement objects from a packed cell, field by field, through the cursors. */
function unpack(packed: PackedDetailCell): GeneratedDetailCell {
  const tree = new PackedTreeView();
  const shrub = new PackedShrubView();
  const rock = new PackedRockView();
  const piece = new PackedClutterView();
  const range = (count: number) => Array.from({ length: count }, (_, index) => index);
  return {
    key: packed.key,
    cellX: packed.cellX,
    cellZ: packed.cellZ,
    cellSizeMeters: packed.cellSizeMeters,
    minX: packed.minX,
    minZ: packed.minZ,
    maxX: packed.maxX,
    maxZ: packed.maxZ,
    trees: range(packed.trees.count).map((index) => {
      tree.at(packed.trees, index);
      return {
        kind: "tree" as const,
        species: tree.species,
        x: tree.x,
        y: tree.y,
        z: tree.z,
        yawRadians: tree.yawRadians,
        heightMeters: tree.heightMeters,
        crownRadiusMeters: tree.crownRadiusMeters,
        trunkRadiusMeters: tree.trunkRadiusMeters,
        windPhaseRadians: tree.windPhaseRadians,
        windResponse: tree.windResponse,
        color: [...tree.color] as [number, number, number, number],
        standAge: tree.standAge,
        selection: tree.selection,
      };
    }),
    shrubs: range(packed.shrubs.count).map((index) => {
      shrub.at(packed.shrubs, index);
      return {
        kind: "shrub" as const,
        species: shrub.species,
        x: shrub.x,
        y: shrub.y,
        z: shrub.z,
        yawRadians: shrub.yawRadians,
        heightMeters: shrub.heightMeters,
        radiusMeters: shrub.radiusMeters,
        windPhaseRadians: shrub.windPhaseRadians,
        windResponse: shrub.windResponse,
        color: [...shrub.color] as [number, number, number, number],
        selection: shrub.selection,
      };
    }),
    rocks: range(packed.rocks.count).map((index) => {
      rock.at(packed.rocks, index);
      return {
        kind: "rock" as const,
        variant: rock.variant,
        x: rock.x,
        y: rock.y,
        z: rock.z,
        yawRadians: rock.yawRadians,
        radiusMeters: rock.radiusMeters,
        flattening: rock.flattening,
        color: [...rock.color] as [number, number, number, number],
        selection: rock.selection,
        normal: { ...rock.normal },
      };
    }),
    clutter: range(packed.clutter.count).map((index) => {
      piece.at(packed.clutter, index);
      return {
        kind: "clutter" as const,
        clutterKind: piece.clutterKind,
        x: piece.x,
        y: piece.y,
        z: piece.z,
        yawRadians: piece.yawRadians,
        sizeMeters: piece.sizeMeters,
        color: [...piece.color] as [number, number, number, number],
        selection: piece.selection,
        normal: { ...piece.normal },
      };
    }),
    groundCover: range(packed.groundCover.count).map((index) => ({
      coverage: packed.groundCover.coverage[index]!,
      archetype: packedGroundCoverArchetype(packed.groundCover, index),
      color: [
        packed.groundCover.colorR[index]!,
        packed.groundCover.colorG[index]!,
        packed.groundCover.colorB[index]!,
      ] as [number, number, number],
      heightMeters: packed.groundCover.heightMeters[index]!,
    })),
  };
}

const TREE_SPECIES: readonly TreeSpecies[] = [
  "pine", "cedar", "spruce", "oak", "maple", "birch", "willow", "palm",
];
const SHRUB_SPECIES: readonly ShrubSpecies[] = ["juniper", "hazel", "sage"];
const ROCK_VARIANTS: readonly RockVariant[] = ["granite", "limestone", "dark"];
const CLUTTER_KINDS: readonly ClutterKind[] = ["log", "stump", "branchLitter", "mossCushion"];
const GROUND_ARCHETYPES: readonly GroundCoverArchetype[] = ["grass", "fern", "heather", "reed"];

function catalog(): DetailPresentationBuildCatalog {
  const kernel = detailPrototypeBoundKernel({ minimum: [-1, 0, -1], maximum: [1, 1, 1] });
  const prototypes: Record<string, DetailPresentationBuildCatalog["prototypes"][string]> = {};
  for (const species of TREE_SPECIES) {
    for (let variant = 0; variant < 3; variant += 1) {
      for (const band of ["near", "mid", "far"] as const) {
        prototypes[`tree-${species}-v${variant}-crown-${band}`] = {
          radialUnits: 0.48 + variant * 0.04,
          boundKernel: kernel,
        };
        prototypes[`tree-${species}-v${variant}-trunk-${band}`] = {
          radialUnits: 0.055,
          boundKernel: kernel,
        };
      }
    }
  }
  for (const species of SHRUB_SPECIES) {
    for (let variant = 0; variant < 2; variant += 1) {
      prototypes[`shrub-${species}-v${variant}`] = { radialUnits: 0.52, boundKernel: kernel };
    }
  }
  for (const variant of ROCK_VARIANTS) {
    prototypes[`rock-${variant}`] = { radialUnits: 1.08, boundKernel: kernel };
  }
  for (const kind of CLUTTER_KINDS) prototypes[`clutter-${kind}`] = { boundKernel: kernel };
  for (const archetype of GROUND_ARCHETYPES) {
    prototypes[`ground-${archetype}`] = { boundKernel: kernel };
  }
  return {
    prototypes,
    impostors: {},
    trees: Object.fromEntries(TREE_SPECIES.map((species) => [species, {
      prototypeFamily: species,
      variantCount: 3,
      trunkTint: [1, 1, 1, 0.5] as const,
    }])) as DetailPresentationBuildCatalog["trees"],
    shrubs: Object.fromEntries(SHRUB_SPECIES.map((species) => [species, {
      variantCount: 2,
    }])) as DetailPresentationBuildCatalog["shrubs"],
    groundCoverGrid: 8,
    useImpostors: false,
  };
}

function buildInput(cell: GeneratedDetailCell): DetailPresentationBuildInput {
  const observerX = cell.minX + 200;
  const observerZ = cell.minZ + 260;
  return {
    residents: [{
      cell: packDetailCell(cell),
      treeCanopyRank: detailTreeCanopyRankOrder(cell.trees),
      lod: "near",
      distance: detailCellMinimumDistanceMeters(
        observerX, observerZ, cell.cellX, cell.cellZ, cell.cellSizeMeters,
      ),
    }],
    floatingOrigin: { x: cell.minX, y: 40, z: cell.minZ },
    densityLaw: RENDERED_DENSITY_LAWS[1]!,
    treeVariantCap: 3,
    treePrototypeMode: "species",
    grassRadiusMeters: 60,
    observerX,
    observerZ,
  };
}

/** A build packed the way the worker packs it, stepped by the caller. */
function startBuild(input: DetailPresentationBuildInput, buildCatalog: DetailPresentationBuildCatalog) {
  const batches = new Map<string, DetailInstanceWriter>();
  const iterator = buildPresentationChunk(input, buildCatalog, {
    appendInstance: (prototypeKey, record, billboardFrame) => {
      let writer = batches.get(prototypeKey);
      if (!writer) batches.set(prototypeKey, writer = new DetailInstanceWriter());
      writer.pushBounded(
        record,
        new DetailInstanceBounds(),
        buildCatalog.prototypes[prototypeKey]!.boundKernel,
        billboardFrame,
      );
    },
  });
  return {
    step: (): boolean => !iterator.next().done,
    fingerprint: () => [...batches].map(([key, writer]) => (
      `${key}:${writer.count}:${createHash("sha256").update(writer.finish()).digest("hex")}`
    )),
  };
}

describe("packed detail cells", () => {
  it("reads back every field of a generated cell bit for bit", () => {
    for (const cell of [FOREST, EDGE]) {
      // Non-vacuous: every placement kind and both colour tuple lengths.
      expect(cell.trees.length).toBeGreaterThan(100);
      expect(cell.shrubs.length).toBeGreaterThan(100);
      expect(cell.rocks.length).toBeGreaterThan(0);
      expect(cell.clutter.length).toBeGreaterThan(0);
      expect(cell.groundCover.length).toBe(64);
      // Strict deep equality compares numbers with Object.is and keys both
      // ways, so a field the packing forgot, or one value off by an ulp (or a
      // lost -0), fails here. Only the first mismatch is diffed: a diff of
      // thousands of placements would take minutes to print.
      const unpacked = unpack(packDetailCell(cell));
      for (const kind of ["trees", "shrubs", "rocks", "clutter", "groundCover"] as const) {
        const actual: readonly unknown[] = unpacked[kind];
        const expected: readonly unknown[] = cell[kind];
        expect(actual.length, kind).toBe(expected.length);
        const first = actual.findIndex((item, index) => !isDeepStrictEqual(item, expected[index]));
        if (first >= 0) expect(actual[first], `${kind}[${first}]`).toEqual(expected[first]);
      }
      expect({ ...unpacked, trees: [], shrubs: [], rocks: [], clutter: [], groundCover: [] })
        .toEqual({ ...cell, trees: [], shrubs: [], rocks: [], clutter: [], groundCover: [] });
    }
    expect(new Set(FOREST.groundCover.map((node) => node.archetype)).size).toBeGreaterThan(2);
  });

  it("stores numbers as Float64 columns and names as codes, with no placement objects", () => {
    const packed = packDetailCell(FOREST);
    for (const kind of ["trees", "shrubs", "rocks", "clutter", "groundCover"] as const) {
      const columns = packed[kind];
      expect(columns.codes).toBeInstanceOf(Uint8Array);
      for (const [field, column] of Object.entries(columns)) {
        if (field === "count" || field === "codes") continue;
        expect(column, `${kind}.${field}`).toBeInstanceOf(Float64Array);
        expect((column as Float64Array).length, `${kind}.${field}`).toBe(columns.count);
      }
    }
    expect(packed.trees.count).toBe(FOREST.trees.length);
  });

  it("refuses a name outside its code table instead of storing a wrong one", () => {
    const tree = FOREST.trees[0]!;
    const bad = { ...FOREST, trees: [{ ...tree, species: "baobab" as TreeSpecies }] };
    expect(() => packDetailCell(bad)).toThrow(/tree species baobab/);
  });

  it("gives every build its own cursors, so interleaved builds keep their bytes", () => {
    // The worker runs several builds at once, one slice at a time. A cursor
    // shared between them would be repointed while a build is suspended.
    const buildCatalog = catalog();
    const alone = [FOREST, EDGE].map((cell) => {
      const build = startBuild(buildInput(cell), buildCatalog);
      while (build.step()) { /* drain */ }
      return build.fingerprint();
    });
    const interleaved = [FOREST, EDGE].map((cell) => startBuild(buildInput(cell), buildCatalog));
    let running = true;
    while (running) {
      running = false;
      for (const build of interleaved) running = build.step() || running;
    }
    expect(alone[0]!.length).toBeGreaterThan(10);
    expect(interleaved.map((build) => build.fingerprint())).toEqual(alone);
  });
});
