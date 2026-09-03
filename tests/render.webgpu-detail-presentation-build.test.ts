import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RENDERED_DENSITY_LAWS } from "../src/render/webgpu/detail/renderedDensity";
import {
  DetailInstanceBounds,
  DetailInstanceWriter,
  detailPrototypeBoundKernel,
  type DetailBillboardFrameBounds,
} from "../src/render/webgpu/detail/instanceFormat";
import {
  buildPresentationChunk,
  detailCellMinimumDistanceMeters,
  type DetailPresentationBuildCatalog,
  type DetailPresentationBuildInput,
  type DetailPresentationChunkStatistics,
} from "../src/render/webgpu/detail/presentationBuild";
import type {
  ClutterKind,
  GeneratedDetailCell,
  GroundCoverArchetype,
  RockVariant,
  ShrubSpecies,
  TreeSpecies,
} from "../src/render/webgpu/detail/types";

const TREE_SPECIES: readonly TreeSpecies[] = [
  "pine", "cedar", "spruce", "oak", "maple", "birch", "willow",
];
const SHRUB_SPECIES: readonly ShrubSpecies[] = ["juniper", "hazel", "sage"];
const ROCK_VARIANTS: readonly RockVariant[] = ["granite", "limestone", "dark"];
const CLUTTER_KINDS: readonly ClutterKind[] = [
  "log", "stump", "branchLitter", "mossCushion",
];
const GROUND_ARCHETYPES: readonly GroundCoverArchetype[] = [
  "grass", "fern", "heather", "reed",
];

const UNIT_BOUND_KERNEL = detailPrototypeBoundKernel({
  minimum: [-1, 0, -1],
  maximum: [1, 1, 1],
});
const IMPOSTOR_FRAME: DetailBillboardFrameBounds = {
  extentUnit: 1,
  centerYUnit: 0.5,
};

function buildCatalog(useImpostors: boolean): DetailPresentationBuildCatalog {
  const prototypes: Record<
    string,
    DetailPresentationBuildCatalog["prototypes"][string]
  > = {};
  const addPrototype = (key: string, radialUnits?: number): void => {
    prototypes[key] = radialUnits === undefined
      ? { boundKernel: UNIT_BOUND_KERNEL }
      : { radialUnits, boundKernel: UNIT_BOUND_KERNEL };
  };
  for (const species of TREE_SPECIES) {
    for (let variant = 0; variant < 3; variant += 1) {
      for (const band of ["near", "mid", "far"] as const) {
        addPrototype(`tree-${species}-v${variant}-crown-${band}`, 0.48 + variant * 0.04);
        addPrototype(`tree-${species}-v${variant}-trunk-${band}`, 0.055 + variant * 0.004);
      }
    }
  }
  addPrototype("tree-impostor");
  for (const species of SHRUB_SPECIES) {
    for (let variant = 0; variant < 2; variant += 1) {
      addPrototype(`shrub-${species}-v${variant}`, 0.52 + variant * 0.05);
    }
  }
  for (const variant of ROCK_VARIANTS) addPrototype(`rock-${variant}`, 1.08);
  for (const kind of CLUTTER_KINDS) addPrototype(`clutter-${kind}`);
  for (const archetype of GROUND_ARCHETYPES) addPrototype(`ground-${archetype}`);

  const impostors: Partial<Record<
    TreeSpecies,
    NonNullable<DetailPresentationBuildCatalog["impostors"][TreeSpecies]>
  >> = {};
  for (const [index, species] of TREE_SPECIES.entries()) {
    impostors[species] = {
      radialUnits: 0.46 + index * 0.01,
      frame: IMPOSTOR_FRAME,
    };
  }
  const family: Readonly<Record<TreeSpecies, TreeSpecies>> = {
    pine: "pine",
    cedar: "pine",
    spruce: "pine",
    oak: "oak",
    maple: "oak",
    birch: "oak",
    willow: "willow",
  };
  const trees = Object.fromEntries(TREE_SPECIES.map((species, index) => [
    species,
    {
      prototypeFamily: family[species],
      variantCount: 3,
      trunkTint: [1, 1, 1, index / (TREE_SPECIES.length - 1)] as const,
    },
  ])) as DetailPresentationBuildCatalog["trees"];
  const shrubs = Object.fromEntries(SHRUB_SPECIES.map((species) => [
    species,
    { variantCount: 2 },
  ])) as DetailPresentationBuildCatalog["shrubs"];
  return {
    prototypes,
    impostors,
    trees,
    shrubs,
    groundCoverGrid: 8,
    useImpostors,
  };
}

function fixtureCell(cellX: number, cellZ: number): GeneratedDetailCell {
  const cellSizeMeters = 64;
  const minX = cellX * cellSizeMeters;
  const minZ = cellZ * cellSizeMeters;
  const centerX = minX + 32;
  const centerZ = minZ + 32;
  const normal = { x: 0.08, y: 0.99, z: -0.04 };
  return {
    key: `${cellX}:${cellZ}`,
    cellX,
    cellZ,
    cellSizeMeters,
    minX,
    minZ,
    maxX: minX + cellSizeMeters,
    maxZ: minZ + cellSizeMeters,
    trees: TREE_SPECIES.map((species, index) => ({
      kind: "tree" as const,
      id: `tree-${index}`,
      species,
      x: centerX + (index - 3) * 0.75,
      y: 91 + index * 0.2,
      z: centerZ + ((index % 3) - 1) * 0.8,
      yawRadians: 0.17 + index * 0.21,
      heightMeters: 13 + index,
      crownRadiusMeters: 3.8 + index * 0.31,
      trunkRadiusMeters: 0.31 + index * 0.025,
      windPhaseRadians: 0.4 + index * 0.37,
      windResponse: 0.22 + index * 0.11,
      color: [0.42 + index * 0.025, 0.55, 0.31, 0.9] as const,
      standAge: 0.35 + index * 0.07,
      selection: 0.07 + index * 0.11,
    })),
    shrubs: SHRUB_SPECIES.map((species, index) => ({
      kind: "shrub" as const,
      id: `shrub-${index}`,
      species,
      x: centerX - 5 + index * 4,
      y: 89.5 + index * 0.15,
      z: centerZ + 4 - index * 2,
      yawRadians: 0.25 + index * 0.4,
      heightMeters: 1.1 + index * 0.2,
      radiusMeters: 0.8 + index * 0.15,
      windPhaseRadians: 0.2 + index * 0.7,
      windResponse: 0.5 + index * 0.1,
      color: [0.4, 0.5 + index * 0.04, 0.32, 0.85] as const,
      selection: 0.04 + index * 0.13,
    })),
    rocks: ROCK_VARIANTS.map((variant, index) => ({
      kind: "rock" as const,
      id: `rock-${index}`,
      variant,
      x: centerX + 7 - index * 4,
      y: 89.2,
      z: centerZ - 6 + index * 3,
      yawRadians: 0.3 + index * 0.6,
      radiusMeters: index === 0 ? 2.4 : 1.1 + index * 0.25,
      flattening: 0.65 + index * 0.08,
      color: [0.48 + index * 0.08, 0.46, 0.43, 1] as const,
      selection: 0.1 + index * 0.09,
      normal,
    })),
    clutter: CLUTTER_KINDS.map((clutterKind, index) => ({
      kind: "clutter" as const,
      id: `clutter-${index}`,
      clutterKind,
      x: centerX - 8 + index * 4,
      y: 89.1,
      z: centerZ + 9 - index * 3,
      yawRadians: index * 0.43,
      sizeMeters: 0.55 + index * 0.18,
      color: [0.34, 0.29 + index * 0.03, 0.2, 1] as const,
      selection: 0.15 + index * 0.1,
      normal,
    })),
    groundCover: Array.from({ length: 64 }, (_, index) => ({
      coverage: index % 7 === 0 ? 0 : 0.72,
      archetype: GROUND_ARCHETYPES[index % GROUND_ARCHETYPES.length]!,
      color: [0.31 + (index % 3) * 0.03, 0.48, 0.22] as const,
      heightMeters: 89 + (index % 8) * 0.08 + Math.floor(index / 8) * 0.04,
    })),
  };
}

interface PackedBatch {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly minimum: readonly number[];
  readonly maximum: readonly number[];
}

interface BuildResult {
  readonly statistics: DetailPresentationChunkStatistics;
  readonly workUnits: number;
  readonly batchKeys: readonly string[];
  readonly batches: readonly PackedBatch[];
}

function packedBuildFingerprint(batches: readonly PackedBatch[]): string {
  const hash = createHash("sha256");
  for (const batch of batches) {
    hash.update(JSON.stringify({
      key: batch.key,
      minimum: batch.minimum,
      maximum: batch.maximum,
    }));
    hash.update(batch.bytes);
  }
  return hash.digest("hex");
}

function runBuild(
  input: DetailPresentationBuildInput,
  catalog: DetailPresentationBuildCatalog,
  sliceWidth: number,
): BuildResult {
  const batches = new Map<string, {
    readonly writer: DetailInstanceWriter;
    readonly bounds: DetailInstanceBounds;
  }>();
  const iterator = buildPresentationChunk(input, catalog, {
    appendInstance: (prototypeKey, record, billboardFrame) => {
      let batch = batches.get(prototypeKey);
      if (!batch) {
        batch = { writer: new DetailInstanceWriter(), bounds: new DetailInstanceBounds() };
        batches.set(prototypeKey, batch);
      }
      const prototype = catalog.prototypes[prototypeKey];
      if (!prototype) throw new Error(`Test catalog is missing ${prototypeKey}`);
      batch.writer.pushBounded(record, batch.bounds, prototype.boundKernel, billboardFrame);
    },
  });
  let workUnits = 0;
  let statistics: DetailPresentationChunkStatistics | null = null;
  while (!statistics) {
    for (let step = 0; step < sliceWidth; step += 1) {
      const result = iterator.next();
      workUnits += 1;
      if (result.done) {
        statistics = result.value;
        break;
      }
    }
  }
  const batchKeys = [...batches.keys()];
  return {
    statistics,
    workUnits,
    batchKeys,
    batches: batchKeys.map((key) => {
      const batch = batches.get(key)!;
      return {
        key,
        bytes: batch.writer.finish(),
        minimum: batch.bounds.minimum(),
        maximum: batch.bounds.maximum(),
      };
    }),
  };
}

describe("pure detail presentation build", () => {
  it("keeps the worker boundary Babylon-free and structured-cloneable", () => {
    const source = readFileSync(
      new URL("../src/render/webgpu/detail/presentationBuild.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/@babylonjs\//);
    expect(source).not.toMatch(
      /(?:prototypeGeometry|treePrototypeFamily|FoliageAtlas|ImpostorAtlas|TextureArrayMips)/,
    );
    expect(() => structuredClone(buildCatalog(true))).not.toThrow();
  });

  /**
   * `6-9` — the ground-cover handoff, measured rather than asserted.
   *
   * Wave G retired the GRASS cards globally when the GPU field is live,
   * because nothing else draws grass once it exists. `6-9` generalises the
   * field to fern, heather and reed — but only out to its own outermost ring,
   * so those three retire by RADIUS and the cards still own everything beyond
   * it. The two representations must partition the ground: no archetype may
   * be drawn twice, and none may vanish.
   */
  it("partitions ground cover between the GPU field and the cards (6-9)", () => {
    const law = RENDERED_DENSITY_LAWS[1]!;
    const cell = fixtureCell(0, 0);
    const observerX = cell.minX + 32;
    const observerZ = cell.minZ + 32;
    const catalog = buildCatalog(false);
    const base: DetailPresentationBuildInput = {
      residents: [{
        cell,
        treeCanopyRank: Float32Array.from([0, 1 / 7, 2 / 7, 3 / 7, 4 / 7, 5 / 7, 6 / 7]),
        lod: "near",
        distance: detailCellMinimumDistanceMeters(
          observerX, observerZ, cell.cellX, cell.cellZ, cell.cellSizeMeters,
        ),
      }],
      floatingOrigin: { x: 0, y: 0, z: 0 },
      densityLaw: law,
      treeVariantCap: 3,
      treePrototypeMode: "species",
      grassRadiusMeters: 64,
      observerX,
      observerZ,
    };

    // The CPU-only host — CI's hosted runner, and any adapter without compute
    // shaders. Every archetype is a card, exactly as before wave G.
    const cpuOnly = runBuild(base, catalog, Number.MAX_SAFE_INTEGER);
    // Wave G's shipped state: grass retires, the structured archetypes stay.
    const bladesOnly = runBuild(
      { ...base, groundCoverBladesActive: true },
      catalog,
      Number.MAX_SAFE_INTEGER,
    );
    // `6-9`: the field also carries fern/heather/reed inside its radius.
    const handoff = runBuild(
      { ...base, groundCoverBladesActive: true, groundCoverFieldRadiusMeters: 24 },
      catalog,
      Number.MAX_SAFE_INTEGER,
    );

    // Counts FALL at every step — §5.3's rule, and the ratchet's own
    // direction. Cheaper scatter buys no plants.
    expect(bladesOnly.statistics.groundCoverInstances)
      .toBeLessThan(cpuOnly.statistics.groundCoverInstances);
    expect(handoff.statistics.groundCoverInstances)
      .toBeLessThan(bladesOnly.statistics.groundCoverInstances);
    expect(handoff.statistics.groundCoverInstances).toBeGreaterThan(0);

    // Non-vacuous in the other direction: the cards outside the radius really
    // do survive, so the handoff is a partition and not a deletion. A radius
    // covering the whole grass disc removes them all.
    const everything = runBuild(
      { ...base, groundCoverBladesActive: true, groundCoverFieldRadiusMeters: 1_000 },
      catalog,
      Number.MAX_SAFE_INTEGER,
    );
    expect(everything.statistics.groundCoverInstances).toBe(0);

    // And the field cannot silently take over the CPU-only path: with blades
    // inactive the radius is inert, which is what keeps the inline path — the
    // only path CI's runner ever takes — first-class.
    const inertRadius = runBuild(
      { ...base, groundCoverFieldRadiusMeters: 1_000 },
      catalog,
      Number.MAX_SAFE_INTEGER,
    );
    expect(inertRadius.statistics).toEqual(cpuOnly.statistics);

    // Every other population is untouched: this item moves ground cover and
    // nothing else, so a tree or rock count moving here is a bug.
    for (const other of [bladesOnly, handoff, everything] as const) {
      expect(other.statistics.treeInstances).toBe(cpuOnly.statistics.treeInstances);
      expect(other.statistics.shrubInstances).toBe(cpuOnly.statistics.shrubInstances);
      expect(other.statistics.rockInstances).toBe(cpuOnly.statistics.rockInstances);
      expect(other.statistics.clutterInstances).toBe(cpuOnly.statistics.clutterInstances);
    }

    // The measured handoff, recorded so the numbers are in the tree rather
    // than only in a report.
    expect({
      cpuOnly: cpuOnly.statistics.groundCoverInstances,
      waveG: bladesOnly.statistics.groundCoverInstances,
      handoff: handoff.statistics.groundCoverInstances,
    }).toMatchInlineSnapshot(`
      {
        "cpuOnly": 584,
        "handoff": 149,
        "waveG": 445,
      }
    `);
  });

  it("matches inline bytes across modes, origins, boundaries, and slice widths", () => {
    const fixtures = [
      {
        name: "family prototypes at the near/mid boundary",
        cellX: 0,
        cellZ: 0,
        mode: "families" as const,
        useImpostors: false,
        origin: { x: 0, y: 0, z: 0 },
        boundary: "near" as const,
        grassRadiusMeters: 0,
      },
      {
        name: "species prototypes at the mid/far boundary with a shifted origin",
        cellX: -1,
        cellZ: 0,
        mode: "species" as const,
        useImpostors: false,
        origin: { x: 2_048, y: 37, z: -1_024 },
        boundary: "mid" as const,
        grassRadiusMeters: 0,
      },
      {
        name: "impostors at the far cull boundary in signed world space",
        cellX: -1,
        cellZ: -1,
        mode: "families" as const,
        useImpostors: true,
        origin: { x: -4_096, y: -15, z: 3_072 },
        boundary: "far" as const,
        grassRadiusMeters: 0,
      },
      {
        name: "ground-cover candidate bounds across a negative cell edge",
        cellX: -1,
        cellZ: 0,
        mode: "species" as const,
        useImpostors: true,
        origin: { x: -512, y: 80, z: 256 },
        boundary: "inside" as const,
        grassRadiusMeters: 18,
      },
    ];
    const summaries: {
      readonly name: string;
      readonly statistics: DetailPresentationChunkStatistics;
      readonly workUnits: number;
      readonly batchKeys: readonly string[];
      readonly packedFingerprint: string;
    }[] = [];
    for (const fixture of fixtures) {
      const law = RENDERED_DENSITY_LAWS[1]!;
      const cell = fixtureCell(fixture.cellX, fixture.cellZ);
      const centerX = cell.minX + 32;
      const centerZ = cell.minZ + 32;
      const edge = fixture.boundary === "near" ? law.near.outerRadiusMeters
        : fixture.boundary === "mid" ? law.mid.outerRadiusMeters
        : fixture.boundary === "far" ? law.far.outerRadiusMeters
        : 0;
      const observerX = centerX - edge;
      const observerZ = centerZ;
      const input: DetailPresentationBuildInput = {
        residents: [{
          cell,
          treeCanopyRank: Float32Array.from([
            0, 1 / 7, 2 / 7, 3 / 7, 4 / 7, 5 / 7, 6 / 7,
          ]),
          lod: edge <= law.near.outerRadiusMeters ? "near" : "mid",
          distance: detailCellMinimumDistanceMeters(
            observerX,
            observerZ,
            cell.cellX,
            cell.cellZ,
            cell.cellSizeMeters,
          ),
        }],
        floatingOrigin: fixture.origin,
        densityLaw: law,
        treeVariantCap: 3,
        treePrototypeMode: fixture.mode,
        grassRadiusMeters: fixture.grassRadiusMeters,
        observerX,
        observerZ,
      };
      const catalog = buildCatalog(fixture.useImpostors);
      const drained = runBuild(input, catalog, Number.MAX_SAFE_INTEGER);
      for (const sliceWidth of [1, 3, 17, 257]) {
        const sliced = runBuild(input, catalog, sliceWidth);
        expect(sliced.statistics).toEqual(drained.statistics);
        expect(sliced.workUnits).toBe(drained.workUnits);
        expect(sliced.batchKeys).toEqual(drained.batchKeys);
        expect(sliced.batches).toEqual(drained.batches);
      }
      summaries.push({
        name: fixture.name,
        statistics: drained.statistics,
        workUnits: drained.workUnits,
        batchKeys: drained.batchKeys,
        packedFingerprint: packedBuildFingerprint(drained.batches),
      });
    }
    expect(summaries).toMatchInlineSnapshot(`
      [
        {
          "batchKeys": [
            "tree-pine-v0-crown-near",
            "tree-pine-v0-trunk-near",
            "tree-pine-v0-crown-mid",
            "tree-pine-v0-trunk-mid",
            "tree-pine-v2-crown-near",
            "tree-pine-v2-trunk-near",
            "tree-pine-v2-crown-mid",
            "tree-pine-v2-trunk-mid",
            "tree-oak-v2-crown-near",
            "tree-oak-v2-trunk-near",
            "tree-oak-v2-crown-mid",
            "tree-oak-v2-trunk-mid",
            "tree-oak-v1-crown-near",
            "tree-oak-v1-trunk-near",
            "tree-oak-v1-crown-mid",
            "tree-oak-v1-trunk-mid",
            "tree-willow-v1-crown-near",
            "tree-willow-v1-trunk-near",
            "tree-willow-v1-crown-mid",
            "tree-willow-v1-trunk-mid",
            "shrub-juniper-v1",
            "shrub-hazel-v0",
            "shrub-sage-v0",
            "rock-granite",
            "rock-dark",
            "clutter-log",
            "clutter-stump",
          ],
          "name": "family prototypes at the near/mid boundary",
          "packedFingerprint": "04b0f21e9ad59ba0e06e6286d0c71308fd3f19caf8845b23597da643cc0fad35",
          "statistics": {
            "clutterInstances": 2,
            "groundCoverInstances": 0,
            "midCells": 0,
            "nearCells": 1,
            "rockInstances": 2,
            "shrubInstances": 3,
            "treeInstances": 7,
          },
          "workUnits": 19,
        },
        {
          "batchKeys": [
            "tree-pine-v0-crown-mid",
            "tree-pine-v0-trunk-mid",
            "tree-pine-v0-crown-far",
            "tree-cedar-v2-crown-mid",
            "tree-cedar-v2-trunk-mid",
            "tree-cedar-v0-crown-far",
            "shrub-juniper-v0",
            "shrub-hazel-v0",
          ],
          "name": "species prototypes at the mid/far boundary with a shifted origin",
          "packedFingerprint": "a365bee51a5746cbea585081bf32720d065d54c1de649cfaa4880c13629197cc",
          "statistics": {
            "clutterInstances": 0,
            "groundCoverInstances": 0,
            "midCells": 1,
            "nearCells": 0,
            "rockInstances": 0,
            "shrubInstances": 2,
            "treeInstances": 2,
          },
          "workUnits": 10,
        },
        {
          "batchKeys": [
            "tree-impostor",
          ],
          "name": "impostors at the far cull boundary in signed world space",
          "packedFingerprint": "a2989111e7983d096cc37e4891a5c5e8ec5a6efe1ac4af012c3d26608cf61d8f",
          "statistics": {
            "clutterInstances": 0,
            "groundCoverInstances": 0,
            "midCells": 1,
            "nearCells": 0,
            "rockInstances": 0,
            "shrubInstances": 0,
            "treeInstances": 2,
          },
          "workUnits": 4,
        },
        {
          "batchKeys": [
            "tree-pine-v0-crown-near",
            "tree-pine-v0-trunk-near",
            "tree-pine-v0-crown-mid",
            "tree-pine-v0-trunk-mid",
            "tree-cedar-v2-crown-near",
            "tree-cedar-v2-trunk-near",
            "tree-cedar-v2-crown-mid",
            "tree-cedar-v2-trunk-mid",
            "tree-spruce-v2-crown-near",
            "tree-spruce-v2-trunk-near",
            "tree-spruce-v2-crown-mid",
            "tree-spruce-v2-trunk-mid",
            "tree-oak-v2-crown-near",
            "tree-oak-v2-trunk-near",
            "tree-oak-v2-crown-mid",
            "tree-oak-v2-trunk-mid",
            "tree-maple-v1-crown-near",
            "tree-maple-v1-trunk-near",
            "tree-maple-v1-crown-mid",
            "tree-maple-v1-trunk-mid",
            "tree-birch-v1-crown-near",
            "tree-birch-v1-trunk-near",
            "tree-birch-v1-crown-mid",
            "tree-birch-v1-trunk-mid",
            "tree-willow-v1-crown-near",
            "tree-willow-v1-trunk-near",
            "tree-willow-v1-crown-mid",
            "tree-willow-v1-trunk-mid",
            "shrub-juniper-v1",
            "shrub-hazel-v0",
            "shrub-sage-v1",
            "rock-granite",
            "rock-limestone",
            "rock-dark",
            "clutter-log",
            "clutter-stump",
            "clutter-branchLitter",
            "clutter-mossCushion",
            "ground-reed",
            "ground-grass",
            "ground-heather",
            "ground-fern",
          ],
          "name": "ground-cover candidate bounds across a negative cell edge",
          "packedFingerprint": "caa7ea845f3134580eb48bb7c8d0e47135e911f1134a98ef32aeef6feaa93a1c",
          "statistics": {
            "clutterInstances": 4,
            "groundCoverInstances": 93,
            "midCells": 0,
            "nearCells": 1,
            "rockInstances": 3,
            "shrubInstances": 3,
            "treeInstances": 7,
          },
          "workUnits": 595,
        },
      ]
    `);
  });
});
