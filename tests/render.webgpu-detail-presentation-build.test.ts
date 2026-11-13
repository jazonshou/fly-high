import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RENDERED_DENSITY_LAWS } from "../src/render/webgpu/detail/renderedDensity";
import {
  DetailInstanceBounds,
  DetailInstanceWriter,
  detailPrototypeBoundKernel,
  type DetailBillboardFrameBounds,
  type DetailInstanceRecord,
} from "../src/render/webgpu/detail/instanceFormat";
import {
  GROUND_OBJECT_REACH_GROW_SHARE,
  GROUND_OBJECT_REACH_METERS_PER_METER,
  SHRUB_BODY_FAR_PROTOTYPE_KEY,
  SHRUB_BODY_FAR_RADIUS_SHARE,
  SHRUB_BODY_HEIGHT_SHARE,
  SHRUB_BODY_PROTOTYPE_KEY,
  SHRUB_BODY_RADIUS_SHARE,
  SHRUB_BODY_SWAP_METERS_PER_METER,
  SHRUB_CARD_REACH_METERS_PER_METER,
  SHRUB_GROUND_SHADOW_BARE_SHARE,
  SHRUB_GROUND_SHADOW_OPACITY,
  SHRUB_OPEN_DRAWN_PER_HECTARE,
  SHRUB_UNDERSTORY_DRAWN_PER_HECTARE,
  estimateBushRecords,
  shrubOpenDrawnPerHectare,
} from "../src/render/webgpu/detail/groundObjects";
import {
  DETAIL_DENSITY_ADMISSION_MARGIN_SHARE,
  DETAIL_MEMBERSHIP_SLACK_METERS,
  DETAIL_SPARSE_STAND_KEYS,
  DETAIL_TREE_STEM_KEY_NEVER_DRAWN,
  TREE_IMPOSTOR_PROTOTYPE_KEY,
  buildPresentationChunk,
  detailCellMinimumDistanceMeters,
  detailSparseStandStemKey,
  groundObjectRangeCapMeters,
  shrubDrawnShares,
  type DetailPresentationBuildCatalog,
  type DetailPresentationBuildInput,
  type DetailPresentationChunkStatistics,
} from "../src/render/webgpu/detail/presentationBuild";
import {
  TREE_GROUND_SHADOW_PROTOTYPE_BOUNDS,
  TREE_GROUND_SHADOW_PROTOTYPE_KEY,
} from "../src/render/webgpu/detail/treeGroundShadow";
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
  addPrototype(SHRUB_BODY_PROTOTYPE_KEY, 1.09);
  addPrototype(SHRUB_BODY_FAR_PROTOTYPE_KEY, 0.95);
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
    palm: "palm",
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
            "shrub-body",
            "shrub-body-far",
            "shrub-hazel-v0",
            "shrub-sage-v1",
            "rock-granite",
            "rock-limestone",
            "rock-dark",
            "clutter-log",
            "clutter-stump",
          ],
          "name": "family prototypes at the near/mid boundary",
          "packedFingerprint": "74d64e467c47469fa16c1b27901e97672bd61867259fc7174a38ebd13d790416",
          "statistics": {
            "clutterInstances": 2,
            "groundCoverInstances": 0,
            "midCells": 0,
            "nearCells": 1,
            "rockInstances": 3,
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
            "tree-spruce-v2-crown-mid",
            "tree-spruce-v2-trunk-mid",
            "tree-spruce-v0-crown-far",
            "tree-oak-v0-crown-far",
            "tree-maple-v0-crown-far",
            "tree-birch-v0-crown-far",
            "tree-willow-v0-crown-far",
          ],
          "name": "species prototypes at the mid/far boundary with a shifted origin",
          "packedFingerprint": "f726d7281bd17a2f2298c256817964ec590a337e46261590fa500de0ce29e1bb",
          "statistics": {
            "clutterInstances": 0,
            "groundCoverInstances": 0,
            "midCells": 1,
            "nearCells": 0,
            "rockInstances": 0,
            "shrubInstances": 0,
            "treeInstances": 7,
          },
          "workUnits": 9,
        },
        {
          "batchKeys": [
            "tree-impostor",
          ],
          "name": "impostors at the far cull boundary in signed world space",
          "packedFingerprint": "8f0cf0438ed3210f3146a29d1218b3a7ae3174d530d46ee494b8bc398a0b9b79",
          "statistics": {
            "clutterInstances": 0,
            "groundCoverInstances": 0,
            "midCells": 1,
            "nearCells": 0,
            "rockInstances": 0,
            "shrubInstances": 0,
            "treeInstances": 7,
          },
          "workUnits": 2,
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
            "shrub-body",
            "shrub-body-far",
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
          "packedFingerprint": "34cdd808a228fcdc8892fa50ae9ec499f246f36f0880ef82938489d175f916b5",
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

/**
 * 2026-11-12 — the tree ground shadow (`treeGroundShadow.ts`). One more record
 * per stem that has a tree record inside the tier's shadow range, in a batch
 * of its own, and nothing else in the build may move for it.
 */
describe("tree ground shadow records", () => {
  const law = RENDERED_DENSITY_LAWS[1]!;
  const STRIDE = 32;

  function shadowCatalog(): DetailPresentationBuildCatalog {
    const catalog = buildCatalog(true);
    return {
      ...catalog,
      prototypes: {
        ...catalog.prototypes,
        [TREE_GROUND_SHADOW_PROTOTYPE_KEY]: {
          radialUnits: 1,
          boundKernel: detailPrototypeBoundKernel(TREE_GROUND_SHADOW_PROTOTYPE_BOUNDS),
        },
      },
    };
  }

  /** A stand past the near cap: forty stems in the fixture's 0.41 ha cell. */
  function denseCell(): GeneratedDetailCell {
    const cell = fixtureCell(0, 0);
    const trees = Array.from({ length: 40 }, (_, index) => {
      const template = cell.trees[index % cell.trees.length]!;
      return {
        ...template,
        id: `tree-${index}`,
        x: cell.minX + 4 + (index % 8) * 7,
        z: cell.minZ + 6 + Math.floor(index / 8) * 11,
        selection: (index * 0.137) % 1,
      };
    });
    return { ...cell, trees };
  }

  function input(
    cell: GeneratedDetailCell,
    observerX: number,
    observerZ: number,
    treeGroundShadowRangeMeters: number | undefined,
  ): DetailPresentationBuildInput {
    const count = cell.trees.length;
    const distance = detailCellMinimumDistanceMeters(
      observerX, observerZ, cell.cellX, cell.cellZ, cell.cellSizeMeters,
    );
    return {
      residents: [{
        cell,
        treeCanopyRank: Float32Array.from({ length: count }, (_, index) => index / count),
        lod: distance <= law.near.outerRadiusMeters ? "near" : "mid",
        distance,
      }],
      floatingOrigin: { x: 16, y: 80, z: -16 },
      densityLaw: law,
      treeVariantCap: 3,
      treePrototypeMode: "species",
      grassRadiusMeters: 64,
      observerX,
      observerZ,
      ...(treeGroundShadowRangeMeters === undefined ? {} : { treeGroundShadowRangeMeters }),
    };
  }

  function batch(result: BuildResult, key: string): PackedBatch | undefined {
    return result.batches.find((entry) => entry.key === key);
  }

  /** The key-lane codes of a batch's records, one per record. */
  function keyCodes(packed: PackedBatch | undefined): number[] {
    if (!packed) return [];
    return Array.from({ length: packed.bytes.byteLength / STRIDE }, (_, index) =>
      packed.bytes[index * STRIDE + 30]!);
  }

  /**
   * The key codes of the batch's tree shadows alone. Bushes and boulders lay
   * theirs in the same batch with a variant of 0, which no tree writes.
   */
  function treeShadowKeyCodes(result: BuildResult): number[] {
    const packed = batch(result, TREE_GROUND_SHADOW_PROTOTYPE_KEY);
    return keyCodes(packed).filter((_, index) => packed!.bytes[index * STRIDE + 29] !== 0);
  }

  function treeKeyCodes(result: BuildResult): Set<number> {
    const codes = new Set<number>();
    for (const packed of result.batches) {
      if (!packed.key.startsWith("tree-")) continue;
      if (packed.key === TREE_GROUND_SHADOW_PROTOTYPE_KEY) continue;
      for (const code of keyCodes(packed)) codes.add(code);
    }
    return codes;
  }

  it("emits none unless the tier asks, and moves no other byte when it does", () => {
    const cell = denseCell();
    const catalog = shadowCatalog();
    const at = [cell.minX + 32, cell.minZ + 32] as const;
    const without = runBuild(input(cell, at[0], at[1], undefined), catalog, Number.MAX_SAFE_INTEGER);
    const zero = runBuild(input(cell, at[0], at[1], 0), catalog, Number.MAX_SAFE_INTEGER);
    const withShadows = runBuild(
      input(cell, at[0], at[1], law.mid.outerRadiusMeters), catalog, Number.MAX_SAFE_INTEGER,
    );
    expect(batch(without, TREE_GROUND_SHADOW_PROTOTYPE_KEY)).toBeUndefined();
    expect(batch(zero, TREE_GROUND_SHADOW_PROTOTYPE_KEY)).toBeUndefined();
    expect(packedBuildFingerprint(zero.batches)).toBe(packedBuildFingerprint(without.batches));
    expect(batch(withShadows, TREE_GROUND_SHADOW_PROTOTYPE_KEY)).toBeDefined();
    // Every other batch is byte for byte what it was, in the same order.
    const others = withShadows.batches.filter(
      (entry) => entry.key !== TREE_GROUND_SHADOW_PROTOTYPE_KEY,
    );
    expect(packedBuildFingerprint(others)).toBe(packedBuildFingerprint(without.batches));
    expect(withShadows.statistics).toEqual(without.statistics);
  });

  it("lays one under every stem that draws inside the near band, and only those", () => {
    const cell = denseCell();
    const result = runBuild(
      input(cell, cell.minX + 32, cell.minZ + 32, law.mid.outerRadiusMeters),
      shadowCatalog(),
      Number.MAX_SAFE_INTEGER,
    );
    const shadows = treeShadowKeyCodes(result);
    // Inside the near radius the law draws the near cap: every stem whose key
    // is a drawable one has records, and each of those has one shadow.
    expect(shadows.length).toBe(result.statistics.treeInstances);
    // The stand is denser than the cap, so some stems never draw at all: 40
    // stems on 0.4096 ha is 97.7 per hectare against a cap of 78, a key is
    // the rank times 1.252, and the 32 lowest ranks keep theirs at or under 1.
    expect(shadows.length).toBe(32);
    // A shadow's key is its tree's: the lane the shader thins both on.
    const trees = treeKeyCodes(result);
    for (const code of shadows) expect(trees.has(code)).toBe(true);
    expect(new Set(shadows).size).toBe(shadows.length);
  });

  it("thins with the drawn share out in the mid band", () => {
    const cell = denseCell();
    const catalog = shadowCatalog();
    const near = runBuild(
      input(cell, cell.minX + 32, cell.minZ + 32, law.mid.outerRadiusMeters),
      catalog,
      Number.MAX_SAFE_INTEGER,
    );
    const mid = runBuild(
      input(cell, cell.minX + 32 + 600, cell.minZ + 32, law.mid.outerRadiusMeters),
      catalog,
      Number.MAX_SAFE_INTEGER,
    );
    const nearShadows = treeShadowKeyCodes(near);
    const midShadows = treeShadowKeyCodes(mid);
    // 600 m out the drawn share is the impostor floor, 0.3, and a record
    // exists up to the admission margin above it: keys to 0.34, eleven stems.
    expect(nearShadows.length).toBe(32);
    expect(midShadows.length).toBe(11);
    expect(midShadows.length).toBeLessThanOrEqual(mid.statistics.treeInstances);
    // The stems kept are the lowest keys, the ones the shader still draws.
    const kept = Math.max(...midShadows);
    expect(nearShadows.filter((code) => code <= kept).length).toBe(midShadows.length);
    const trees = treeKeyCodes(mid);
    for (const code of midShadows) expect(trees.has(code)).toBe(true);
  });

  it("stops at the range, and at the mid band whatever the range", () => {
    const cell = denseCell();
    const catalog = shadowCatalog();
    const count = (observerOffset: number, range: number): number => keyCodes(batch(
      runBuild(
        input(cell, cell.minX + 32 + observerOffset, cell.minZ + 32, range),
        catalog,
        Number.MAX_SAFE_INTEGER,
      ),
      TREE_GROUND_SHADOW_PROTOTYPE_KEY,
    )).length;
    // A 400 m range reaches its slack further and no more.
    expect(count(400, 400)).toBeGreaterThan(0);
    expect(count(400 + DETAIL_MEMBERSHIP_SLACK_METERS + 40, 400)).toBe(0);
    // A range past the mid band is the mid band.
    const pastMid = law.mid.outerRadiusMeters + DETAIL_MEMBERSHIP_SLACK_METERS + 40;
    expect(count(pastMid, 50_000)).toBe(0);
    expect(count(law.mid.outerRadiusMeters - 40, 50_000)).toBeGreaterThan(0);
  });

  it("packs the same bytes however the build is sliced", () => {
    const cell = denseCell();
    const catalog = shadowCatalog();
    const build = input(cell, cell.minX + 200, cell.minZ - 90, law.mid.outerRadiusMeters);
    const whole = runBuild(build, catalog, Number.MAX_SAFE_INTEGER);
    for (const sliceWidth of [1, 3, 17]) {
      expect(packedBuildFingerprint(runBuild(build, catalog, sliceWidth).batches))
        .toBe(packedBuildFingerprint(whole.batches));
    }
    expect(() => structuredClone(build)).not.toThrow();
  });
});

/**
 * 2026-11-12 — bushes and boulders (`groundObjects.ts`). A bush is up to four
 * records (leaf cards, a solid body, the body's far stand-in, a ground shadow)
 * and a boulder two; how far each is kept resident is its own reach, not a
 * band.
 */
describe("a thin stand's trees", () => {
  const law = RENDERED_DENSITY_LAWS[1]!;
  const STRIDE = 32;
  const { fullAtDensityShare, noneAtDensityShare, lowKey, highKey } = DETAIL_SPARSE_STAND_KEYS;
  const lane = (key: number): number => Math.round(key * 255) / 255;

  /** `count` trees in the fixture's 0.41 ha cell, each with a selection of its own. */
  function stand(count: number): GeneratedDetailCell {
    const cell = fixtureCell(0, 0);
    const trees = Array.from({ length: count }, (_, index) => {
      const template = cell.trees[index % cell.trees.length]!;
      return {
        ...template,
        id: `tree-${index}`,
        x: cell.minX + 4 + (index % 8) * 7,
        z: cell.minZ + 6 + Math.floor(index / 8) * 11,
        selection: (0.07 + index * 0.137) % 1,
      };
    });
    return { ...cell, trees };
  }

  /** The build of one cell seen from `range` metres off its edge. */
  function seenFrom(cell: GeneratedDetailCell, range: number): BuildResult {
    const observerX = cell.minX - range;
    const observerZ = cell.minZ + 32;
    const count = cell.trees.length;
    const distance = detailCellMinimumDistanceMeters(
      observerX, observerZ, cell.cellX, cell.cellZ, cell.cellSizeMeters,
    );
    return runBuild({
      residents: [{
        cell,
        treeCanopyRank: Float32Array.from({ length: count }, (_, index) => index / count),
        lod: distance <= law.near.outerRadiusMeters ? "near" : "mid",
        distance,
      }],
      floatingOrigin: { x: 16, y: 80, z: -16 },
      densityLaw: law,
      treeVariantCap: 3,
      treePrototypeMode: "species",
      grassRadiusMeters: 64,
      observerX,
      observerZ,
    }, buildCatalog(true), Number.MAX_SAFE_INTEGER);
  }

  const records = (packed: PackedBatch | undefined): number =>
    packed ? packed.bytes.byteLength / STRIDE : 0;
  /** The mid band's crown records: one a stem that has a mid mesh. */
  const midCrowns = (result: BuildResult): number => result.batches
    .filter((entry) => /^tree-.*-crown-mid$/u.test(entry.key))
    .reduce((sum, entry) => sum + records(entry), 0);
  const impostors = (result: BuildResult): PackedBatch | undefined =>
    result.batches.find((entry) => entry.key === TREE_IMPOSTOR_PROTOTYPE_KEY);

  it("lifts a thin stand's keys over what the geometry floor admits and under every impostor floor", () => {
    expect(lowKey).toBeLessThan(highKey);
    expect(fullAtDensityShare).toBeLessThan(noneAtDensityShare);
    for (const tierLaw of RENDERED_DENSITY_LAWS) {
      // Far enough out the cell admits no geometry record: the floor and the
      // admission margin together stay under the band.
      expect(lowKey).toBeGreaterThan(tierLaw.farFloorShare + DETAIL_DENSITY_ADMISSION_MARGIN_SHARE);
      // And the stem is never undrawn: the band stays inside the drawn share.
      expect(lane(highKey)).toBeLessThan(tierLaw.impostorFloorShare);
    }
    // A whole lift spreads the stand over the band by each stem's own hash,
    // on the unorm8 lane the key travels in.
    expect(detailSparseStandStemKey(0, fullAtDensityShare, 0)).toBe(lane(lowKey));
    expect(detailSparseStandStemKey(0.01, 0.02, 1)).toBe(lane(highKey));
    const middle = detailSparseStandStemKey(0, 0.02, 0.5);
    expect(middle).toBeGreaterThan(lane(lowKey));
    expect(middle).toBeLessThan(lane(highKey));
    expect(middle * 255).toBeCloseTo(Math.round(middle * 255), 9);
    // Between the two densities the lift tapers, so no stand sits on an edge.
    const tapered = detailSparseStandStemKey(0, (fullAtDensityShare + noneAtDensityShare) / 2, 0);
    expect(tapered).toBeGreaterThan(0);
    expect(tapered).toBeLessThan(lane(lowKey));
    // A forest's keys are its own, a key is never lowered, and a stem the
    // near cap never draws stays that way.
    for (const key of [0, 0.02, 0.5, 254 / 255, DETAIL_TREE_STEM_KEY_NEVER_DRAWN]) {
      expect(detailSparseStandStemKey(key, noneAtDensityShare, 0.5)).toBe(key);
      expect(detailSparseStandStemKey(key, 1, 0.5)).toBe(key);
    }
    expect(detailSparseStandStemKey(0.3, 0.02, 0.5)).toBe(0.3);
    expect(detailSparseStandStemKey(DETAIL_TREE_STEM_KEY_NEVER_DRAWN, 0.02, 0.5))
      .toBe(DETAIL_TREE_STEM_KEY_NEVER_DRAWN);
  });

  it("draws a thin stand as meshes close by and as impostors alone further out", () => {
    // Three trees on 0.4096 ha: 7.3 a hectare, under a tenth of the near cap.
    const cell = stand(3);
    expect(cell.trees.length / 0.4096 / law.nearStemsPerHectare).toBeLessThan(fullAtDensityShare);
    // 200 m out every lifted key is inside the geometry share (0.56), so
    // every tree has its mid mesh.
    const close = seenFrom(cell, 200);
    expect(midCrowns(close)).toBe(3);
    // 700 m out the share is the floor, 0.045, and with the admission margin
    // it stays under the band: no mesh record of any band, so no mesh batch
    // to draw, and one impostor a tree.
    const far = seenFrom(cell, 700);
    expect(far.batchKeys.filter((key) => key.startsWith("tree-"))).toEqual([TREE_IMPOSTOR_PROTOTYPE_KEY]);
    expect(records(impostors(far))).toBe(3);
    expect(far.statistics.treeInstances).toBe(3);
    // The range it turns at: no geometry is admitted once the inverse-square
    // share plus the margin is under the band's low key.
    const turn = law.near.outerRadiusMeters
      / Math.sqrt(lane(lowKey) - DETAIL_DENSITY_ADMISSION_MARGIN_SHARE);
    expect(turn).toBeGreaterThan(law.near.outerRadiusMeters * 3);
    expect(turn).toBeLessThan(law.mid.outerRadiusMeters / 2);
    expect(midCrowns(seenFrom(cell, Math.ceil(turn) + 1))).toBe(0);
  });

  it("gives every tree of a thin stand a key of its own inside the band", () => {
    const far = seenFrom(stand(3), 700);
    const packed = impostors(far)!;
    const codes = Array.from({ length: records(packed) }, (_, index) => packed.bytes[index * STRIDE + 30]!);
    expect(new Set(codes).size).toBe(3);
    for (const code of codes) {
      expect(code).toBeGreaterThanOrEqual(Math.round(lowKey * 255));
      expect(code).toBeLessThanOrEqual(Math.round(highKey * 255));
    }
  });

  it("leaves a forest's widest crowns as meshes out to the mid radius", () => {
    // Forty stems on 0.4096 ha is past the near cap: nothing is lifted, and
    // 700 m out the three lowest keys (to the floor plus the margin, 0.085,
    // at 1.252 a rank) still carry a mid mesh beside their impostor.
    const far = seenFrom(stand(40), 700);
    expect(midCrowns(far)).toBe(3);
    expect(records(impostors(far))).toBeGreaterThan(3);
  });
});

describe("bush and boulder records", () => {
  const law = RENDERED_DENSITY_LAWS[1]!;
  const RANGE = law.mid.outerRadiusMeters;
  type Appended = { readonly key: string; readonly record: DetailInstanceRecord };
  type Shrub = GeneratedDetailCell["shrubs"][number];
  type Rock = GeneratedDetailCell["rocks"][number];

  function groundCatalog(): DetailPresentationBuildCatalog {
    const catalog = buildCatalog(true);
    return {
      ...catalog,
      prototypes: {
        ...catalog.prototypes,
        [TREE_GROUND_SHADOW_PROTOTYPE_KEY]: {
          radialUnits: 1,
          boundKernel: detailPrototypeBoundKernel(TREE_GROUND_SHADOW_PROTOTYPE_BOUNDS),
        },
      },
    };
  }

  function shrub(overrides: Partial<Shrub> = {}): Shrub {
    return {
      kind: "shrub",
      id: "shrub",
      species: "hazel",
      x: 32,
      y: 90,
      z: 32,
      yawRadians: 0.3,
      heightMeters: 1.2,
      radiusMeters: 0.9,
      windPhaseRadians: 1.1,
      windResponse: 0.6,
      color: [0.4, 0.5, 0.3, 0.8],
      selection: 0,
      ...overrides,
    };
  }

  function rock(overrides: Partial<Rock> = {}): Rock {
    return {
      kind: "rock",
      id: "rock",
      variant: "granite",
      x: 32,
      y: 90,
      z: 32,
      yawRadians: 0.3,
      radiusMeters: 2.4,
      flattening: 0.65,
      color: [0.5, 0.48, 0.45, 1],
      selection: 0.5,
      normal: { x: 0.1, y: 0.99, z: -0.05 },
      ...overrides,
    };
  }

  function cellOf(shrubs: readonly Shrub[], rocks: readonly Rock[] = []): GeneratedDetailCell {
    return { ...fixtureCell(0, 0), trees: [], clutter: [], shrubs: [...shrubs], rocks: [...rocks] };
  }

  /** Every record the build appends, with the observer `range` metres east of the cell's centre. */
  function collect(
    cell: GeneratedDetailCell,
    range: number,
    overrides: Partial<DetailPresentationBuildInput> = {},
    catalog = groundCatalog(),
    groundObjectRangeMeters: number | null = RANGE,
  ): { readonly records: Appended[]; readonly statistics: DetailPresentationChunkStatistics } {
    const observerX = cell.minX + 32 + range;
    const observerZ = cell.minZ + 32;
    const distance = detailCellMinimumDistanceMeters(
      observerX, observerZ, cell.cellX, cell.cellZ, cell.cellSizeMeters,
    );
    const records: Appended[] = [];
    const iterator = buildPresentationChunk(
      {
        residents: [{
          cell,
          treeCanopyRank: new Float32Array(0),
          lod: distance <= law.near.outerRadiusMeters ? "near" : "mid",
          distance,
        }],
        floatingOrigin: { x: 0, y: 0, z: 0 },
        densityLaw: law,
        treeVariantCap: 3,
        treePrototypeMode: "species",
        grassRadiusMeters: 0,
        observerX,
        observerZ,
        treeGroundShadowRangeMeters: RANGE,
        ...(groundObjectRangeMeters === null ? {} : { groundObjectRangeMeters }),
        ...overrides,
      },
      catalog,
      { appendInstance: (key, record) => { records.push({ key, record }); } },
    );
    let step = iterator.next();
    while (!step.done) step = iterator.next();
    return { records, statistics: step.value };
  }

  const keysOf = (records: readonly Appended[]): string[] => records.map((entry) => entry.key);

  it("caps a ground object's reach at the tier's range, the near radius without one, and the mid radius", () => {
    expect(groundObjectRangeCapMeters(undefined, law)).toBe(law.near.outerRadiusMeters);
    expect(groundObjectRangeCapMeters(0, law)).toBe(law.near.outerRadiusMeters);
    expect(groundObjectRangeCapMeters(Number.NaN, law)).toBe(law.near.outerRadiusMeters);
    expect(groundObjectRangeCapMeters(400, law)).toBe(400);
    expect(groundObjectRangeCapMeters(50_000, law)).toBe(law.mid.outerRadiusMeters);
  });

  it("hands a bush from cards and body to the stand-in as it recedes, and drops it past its reach", () => {
    // Tall enough that each stage has its own stretch of range.
    const bush = shrub({ heightMeters: 2.4, radiusMeters: 1.6 });
    const cell = cellOf([bush]);
    const bodyHeight = bush.heightMeters * SHRUB_BODY_HEIGHT_SHARE;
    const cardReach = law.near.outerRadiusMeters;
    expect(bush.heightMeters * SHRUB_CARD_REACH_METERS_PER_METER).toBeGreaterThan(cardReach);
    const swap = bodyHeight * SHRUB_BODY_SWAP_METERS_PER_METER;
    const standInStart = swap * (1 - GROUND_OBJECT_REACH_GROW_SHARE);
    const bodyReach = bodyHeight * GROUND_OBJECT_REACH_METERS_PER_METER;
    expect(cardReach).toBeLessThan(standInStart);
    expect(bodyReach).toBeLessThan(RANGE);
    const SLACK = DETAIL_MEMBERSHIP_SLACK_METERS;
    const CARDS = "shrub-hazel-v0";
    const BODY = SHRUB_BODY_PROTOTYPE_KEY;
    const FAR = SHRUB_BODY_FAR_PROTOTYPE_KEY;
    const SHADOW = TREE_GROUND_SHADOW_PROTOTYPE_KEY;

    // Up close: the cards and the body, and no stand-in, because the observer
    // cannot get to where it starts before the chunk is rebuilt.
    const close = collect(cell, 40);
    expect(keysOf(close.records)).toEqual([CARDS, BODY, SHADOW]);
    expect(close.statistics.shrubInstances).toBe(1);
    // One membership slack short of where the body starts to shrink, the
    // stand-in's record is there to take over.
    expect(keysOf(collect(cell, standInStart - SLACK + 5).records)).toEqual([CARDS, BODY, FAR, SHADOW]);
    expect(keysOf(collect(cell, standInStart - SLACK - 5).records)).toEqual([CARDS, BODY, SHADOW]);
    // The CPU keeps each record one slack past the reach the shader draws it
    // to, so a chunk rebuilt 96 m late still has it.
    expect(keysOf(collect(cell, cardReach + SLACK - 5).records)).toEqual([CARDS, BODY, FAR, SHADOW]);
    expect(keysOf(collect(cell, cardReach + SLACK + 5).records)).toEqual([BODY, FAR, SHADOW]);
    expect(keysOf(collect(cell, swap + SLACK - 5).records)).toEqual([BODY, FAR, SHADOW]);
    expect(keysOf(collect(cell, swap + SLACK + 5).records)).toEqual([FAR, SHADOW]);
    expect(keysOf(collect(cell, bodyReach + SLACK - 5).records)).toEqual([FAR, SHADOW]);
    const past = collect(cell, bodyReach + SLACK + 5);
    expect(past.records).toEqual([]);
    expect(past.statistics.shrubInstances).toBe(0);
  });

  it("writes the body a little inside the cards, and a stand-in and a shadow that read the same height", () => {
    const bush = shrub({ selection: 0.25, groundSlopeX: 0.2, groundSlopeZ: -0.1 });
    const { records } = collect(cellOf([bush]), 40);
    const cards = records.find((entry) => entry.key.startsWith("shrub-hazel"))!.record;
    const body = records.find((entry) => entry.key === SHRUB_BODY_PROTOTYPE_KEY)!.record;
    const far = records.find((entry) => entry.key === SHRUB_BODY_FAR_PROTOTYPE_KEY)!.record;
    const shadow = records.find((entry) => entry.key === TREE_GROUND_SHADOW_PROTOTYPE_KEY)!.record;

    expect(cards.heightScaleMeters).toBe(bush.heightMeters);
    expect(cards.fade).toBe(1);
    expect(body.heightScaleMeters).toBeCloseTo(bush.heightMeters * SHRUB_BODY_HEIGHT_SHARE, 12);
    expect([body.x, body.y, body.z]).toEqual([cards.x, cards.y, cards.z]);
    expect(body.quaternion).toEqual(cards.quaternion);
    expect(body.tint).toEqual(bush.color);
    expect(body.variant).toBe(0);
    expect(body.fade).toBe(1);
    expect(body.windResponse).toBeCloseTo(bush.windResponse * 0.5, 12);
    // The body's world radius: the bush's drawn radius times the body's share.
    const drawnRadius = bush.radiusMeters * (0.92 + bush.selection * 0.12);
    expect(body.radialScale * body.heightScaleMeters * 1.09)
      .toBeCloseTo(drawnRadius * SHRUB_BODY_RADIUS_SHARE, 9);

    // The stand-in is the same bush on another mesh. Its inner edge is the
    // body's reach, computed in the shader from the height lane, so the two
    // must carry the same height to hand over at the same range.
    expect(far.heightScaleMeters).toBe(body.heightScaleMeters);
    expect([far.x, far.y, far.z]).toEqual([body.x, body.y, body.z]);
    expect(far.quaternion).toEqual(body.quaternion);
    expect(far.tint).toEqual(body.tint);
    expect(far.windPhase).toBe(body.windPhase);
    expect(far.windResponse).toBe(body.windResponse);
    expect(far.fade).toBe(1);
    expect(far.radialScale * far.heightScaleMeters * 0.95)
      .toBeCloseTo(drawnRadius * SHRUB_BODY_RADIUS_SHARE * SHRUB_BODY_FAR_RADIUS_SHARE, 9);

    // The shadow's shader derives the reach from the height lane, as the
    // stand-in's does, so they must carry the same height.
    expect(shadow.heightScaleMeters).toBe(body.heightScaleMeters);
    expect(shadow.radialScale * shadow.heightScaleMeters)
      .toBeCloseTo(drawnRadius * SHRUB_BODY_RADIUS_SHARE, 9);
    expect(shadow.variant).toBe(0);
    expect(shadow.fade).toBe(1);
    // A bush in four-fifths leaf stops that much less sun than one in full leaf.
    expect(shadow.tint[2]).toBeCloseTo(
      SHRUB_GROUND_SHADOW_OPACITY
        * (SHRUB_GROUND_SHADOW_BARE_SHARE + (1 - SHRUB_GROUND_SHADOW_BARE_SHARE) * 0.8),
      12,
    );
    // Its body shrinks to a core up close, and the shadow has to know.
    expect(shadow.windResponse).toBe(1);
    // The decal lies on the slope the generator read under the bush: its
    // normal is the quaternion's image of +Y.
    const [qx, qy, qz, qw] = shadow.quaternion;
    const normal = [2 * (qx * qy - qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qw * qx)];
    const length = Math.hypot(-0.2, 1, 0.1);
    expect(normal[0]).toBeCloseTo(-0.2 / length, 6);
    expect(normal[1]).toBeCloseTo(1 / length, 6);
    expect(normal[2]).toBeCloseTo(0.1 / length, 6);
  });

  it("keeps an understory bush's solid only as far as its cards", () => {
    const open = shrub();
    const under = shrub({ canopyClosure: 0.8 });
    const bodyHeight = open.heightMeters * SHRUB_BODY_HEIGHT_SHARE;
    const cardReach = open.heightMeters * SHRUB_CARD_REACH_METERS_PER_METER;
    const swap = bodyHeight * SHRUB_BODY_SWAP_METERS_PER_METER;
    const bodyReach = bodyHeight * GROUND_OBJECT_REACH_METERS_PER_METER;
    expect(cardReach).toBeLessThan(swap);

    const close = collect(cellOf([under]), 40).records;
    const body = close.find((entry) => entry.key === SHRUB_BODY_PROTOTYPE_KEY)!.record;
    const far = close.find((entry) => entry.key === SHRUB_BODY_FAR_PROTOTYPE_KEY)!.record;
    const shadow = close.find((entry) => entry.key === TREE_GROUND_SHADOW_PROTOTYPE_KEY)!.record;
    // Each fade lane is the share of that record's own reach it is drawn to:
    // its vertex stage multiplies the reach by it. The body's reach is the
    // swap range; the stand-in's and the shadow's is the bush's.
    expect(body.fade).toBeCloseTo(cardReach / swap, 12);
    expect(far.fade).toBeCloseTo(cardReach / bodyReach, 12);
    expect(shadow.fade).toBe(far.fade);

    const beyond = cardReach + DETAIL_MEMBERSHIP_SLACK_METERS + 5;
    expect(collect(cellOf([under]), beyond).records).toEqual([]);
    expect(keysOf(collect(cellOf([open]), beyond).records)).toContain(SHRUB_BODY_FAR_PROTOTYPE_KEY);
    // Just under the closure that makes a bush understory, it is open ground.
    expect(keysOf(collect(cellOf([shrub({ canopyClosure: 0.49 })]), beyond).records))
      .toContain(SHRUB_BODY_FAR_PROTOTYPE_KEY);
  });

  it("draws a cell's bushes to two budgets, the same bushes from every range", () => {
    const hectares = (64 * 64) / 10_000;
    const open = Array.from({ length: 200 }, (_, index) => shrub({
      id: `open-${index}`,
      x: 2 + (index % 20) * 3,
      z: 2 + Math.floor(index / 20) * 6,
      selection: (index + 0.5) / 200,
    }));
    const under = Array.from({ length: 50 }, (_, index) => shrub({
      id: `under-${index}`,
      x: 3 + (index % 10) * 6,
      z: 5 + Math.floor(index / 10) * 12,
      selection: (index + 0.5) / 50,
      canopyClosure: 0.9,
      windPhaseRadians: 3.3,
    }));
    const cell = cellOf([...open, ...under]);
    const shares = shrubDrawnShares(cell.shrubs, hectares);
    expect(shares.open).toBeCloseTo((SHRUB_OPEN_DRAWN_PER_HECTARE * hectares) / 200, 12);
    expect(shares.understory).toBeCloseTo((SHRUB_UNDERSTORY_DRAWN_PER_HECTARE * hectares) / 50, 12);
    const openDrawn = open.filter((entry) => entry.selection <= shares.open).length;
    const underDrawn = under.filter((entry) => entry.selection <= shares.understory).length;
    expect(openDrawn).toBe(106);
    expect(underDrawn).toBe(25);

    const isUnder = (entry: Appended): boolean => entry.record.windPhase > 0.5;
    const close = collect(cell, 0).records.filter((entry) => entry.key === SHRUB_BODY_PROTOTYPE_KEY);
    expect(close.filter((entry) => !isUnder(entry)).length).toBe(openDrawn);
    expect(close.filter(isUnder).length).toBe(underDrawn);

    // Past the cards the open bushes that are drawn are the same ones: the
    // budget thins by `selection`, never by range.
    const far = collect(cell, 250).records.filter((entry) => entry.key === SHRUB_BODY_FAR_PROTOTYPE_KEY);
    expect(far.length).toBe(openDrawn);
    const place = (entry: Appended): string => `${entry.record.x}:${entry.record.z}`;
    expect(new Set(far.map(place))).toEqual(new Set(close.filter((entry) => !isUnder(entry)).map(place)));

    // A sparse cell draws every bush it has.
    expect(shrubDrawnShares(open.slice(0, 40), hectares)).toEqual({ understory: 1, open: 1 });

    // A tier authored thinner draws to a lower open cap, and the bushes it
    // keeps are the first of the ones a fuller tier draws. The understory's
    // budget does not move.
    const lowCap = shrubOpenDrawnPerHectare(0.45);
    expect(lowCap).toBeCloseTo(SHRUB_OPEN_DRAWN_PER_HECTARE * 0.45, 12);
    const lowShares = shrubDrawnShares(cell.shrubs, hectares, lowCap);
    expect(lowShares.understory).toBe(shares.understory);
    expect(lowShares.open).toBeCloseTo(shares.open * 0.45, 12);
    const low = collect(cell, 250, { shrubOpenDrawnPerHectare: lowCap }).records
      .filter((entry) => entry.key === SHRUB_BODY_FAR_PROTOTYPE_KEY);
    expect(low.length).toBe(open.filter((entry) => entry.selection <= lowShares.open).length);
    expect(low.length).toBeLessThan(far.length * 0.5);
    const drawnFar = new Set(far.map(place));
    for (const entry of low) expect(drawnFar.has(place(entry))).toBe(true);
    // A cap of nothing draws no open bush, and a tier denser than the
    // reference draws to the reference cap, not past it.
    expect(shrubDrawnShares(cell.shrubs, hectares, 0).open).toBe(0);
    expect(shrubOpenDrawnPerHectare(1.4)).toBe(SHRUB_OPEN_DRAWN_PER_HECTARE);
    expect(shrubOpenDrawnPerHectare(0)).toBe(0);
    expect(shrubOpenDrawnPerHectare(Number.NaN)).toBe(0);
  });

  it("is booked by an estimate that counts what the build emits", () => {
    // A field of one bush every 8 m (156 per hectare; the spacing tiles the
    // fixture's 64 m cells) out past a bush's reach, built round an observer
    // at its middle.
    const SPACING = 8;
    const CELL = 64;
    const perHectare = 10_000 / (SPACING * SPACING);
    for (const [understory, height] of [[false, 1.6], [false, 1.1], [true, 1.6]] as const) {
      const common = {
        nearRadiusMeters: law.near.outerRadiusMeters,
        groundObjectRangeMeters: RANGE,
        groundShadowReachMeters: RANGE,
        membershipSlackMeters: DETAIL_MEMBERSHIP_SLACK_METERS,
        drawnPerHectare: perHectare,
        bushHeightMeters: height,
        understory,
      };
      const estimate = estimateBushRecords(common);
      expect(estimate.records).toBeCloseTo(
        estimate.cardRecords + estimate.bodyRecords + estimate.standInRecords
          + estimate.shadowRecords,
        9,
      );
      const span = Math.ceil((estimate.radiusMeters + CELL) / CELL);
      const residents: DetailPresentationBuildInput["residents"][number][] = [];
      for (let cellZ = -span; cellZ < span; cellZ += 1) {
        for (let cellX = -span; cellX < span; cellX += 1) {
          const bushes: Shrub[] = [];
          for (let z = SPACING / 2; z < CELL; z += SPACING) {
            for (let x = SPACING / 2; x < CELL; x += SPACING) {
              bushes.push(shrub({
                id: `${cellX}:${cellZ}:${x}:${z}`,
                x: cellX * CELL + x + ((cellX + cellZ) & 1),
                z: cellZ * CELL + z,
                heightMeters: height,
                radiusMeters: height * 0.7,
                selection: 0,
                ...(understory ? { canopyClosure: 0.9 } : {}),
              }));
            }
          }
          const cell = {
            ...fixtureCell(cellX, cellZ), trees: [], clutter: [], rocks: [], shrubs: bushes,
          };
          const distance = detailCellMinimumDistanceMeters(0, 0, cellX, cellZ, CELL);
          residents.push({
            cell,
            treeCanopyRank: new Float32Array(0),
            lod: distance <= law.near.outerRadiusMeters ? "near" : "mid",
            distance,
          });
        }
      }
      const counts = new Map<string, number>();
      const iterator = buildPresentationChunk(
        {
          residents,
          floatingOrigin: { x: 0, y: 0, z: 0 },
          densityLaw: law,
          treeVariantCap: 1,
          treePrototypeMode: "species",
          grassRadiusMeters: 0,
          observerX: 0,
          observerZ: 0,
          treeGroundShadowRangeMeters: RANGE,
          groundObjectRangeMeters: RANGE,
          // Every bush is drawn: this checks reach, not the budgets.
          shrubOpenDrawnPerHectare: 1e6,
        },
        groundCatalog(),
        { appendInstance: (key) => { counts.set(key, (counts.get(key) ?? 0) + 1); } },
      );
      let step = iterator.next();
      while (!step.done) step = iterator.next();
      const built = {
        cards: counts.get("shrub-hazel-v0") ?? 0,
        body: counts.get(SHRUB_BODY_PROTOTYPE_KEY) ?? 0,
        standIn: counts.get(SHRUB_BODY_FAR_PROTOTYPE_KEY) ?? 0,
        shadow: counts.get(TREE_GROUND_SHADOW_PROTOTYPE_KEY) ?? 0,
      };
      const label = `${understory ? "understory" : "open"} ${height} m`;
      // The grid is coarse against the smaller discs; a few per cent is the grid.
      // Every bush here has selection 0, so the understory's budget draws
      // all of them too.
      const close = (builtCount: number, estimated: number, what: string): void => {
        expect(builtCount, `${label} ${what}`).toBeGreaterThan(0);
        expect(Math.abs(builtCount - estimated), `${label} ${what}: ${builtCount} against ${estimated}`)
          .toBeLessThan(Math.max(estimated * 0.04, 12));
      };
      close(built.cards, estimate.cardRecords, "cards");
      close(built.body, estimate.bodyRecords, "body");
      close(built.standIn, estimate.standInRecords, "stand-in");
      close(built.shadow, estimate.shadowRecords, "shadow");
      close(
        built.cards + built.body + built.standIn + built.shadow, estimate.records, "records");
      if (understory) {
        // Nothing of an understory bush lies past its cards.
        expect(estimate.radiusMeters).toBeCloseTo(
          Math.min(height * SHRUB_CARD_REACH_METERS_PER_METER, law.near.outerRadiusMeters)
            + DETAIL_MEMBERSHIP_SLACK_METERS,
          9,
        );
      } else {
        expect(estimate.standInRecords).toBeGreaterThan(estimate.bodyRecords);
      }
    }
    // No reach or no bushes books nothing.
    const none = estimateBushRecords({
      nearRadiusMeters: law.near.outerRadiusMeters,
      groundObjectRangeMeters: RANGE,
      groundShadowReachMeters: RANGE,
      membershipSlackMeters: DETAIL_MEMBERSHIP_SLACK_METERS,
      drawnPerHectare: 0,
      understory: false,
    });
    expect(none.records).toBe(0);
    expect(none.bushes).toBe(0);
  });

  it("draws one leaf-card model per bush species on a tier that draws one per tree", () => {
    const bushes = Array.from({ length: 40 }, (_, index) => shrub({
      id: `bush-${index}`,
      x: 4 + (index % 8) * 7,
      z: 4 + Math.floor(index / 8) * 11,
      selection: (index + 0.5) / 40,
    }));
    const cardKeys = (treeVariantCap: number): Set<string> => new Set(
      keysOf(collect(cellOf(bushes), 0, { treeVariantCap }).records)
        .filter((key) => key.startsWith("shrub-hazel-")),
    );
    expect(buildCatalog(true).shrubs.hazel.variantCount).toBe(2);
    expect(cardKeys(3)).toEqual(new Set(["shrub-hazel-v0", "shrub-hazel-v1"]));
    expect(cardKeys(1)).toEqual(new Set(["shrub-hazel-v0"]));
    // The cap changes which model a bush's cards use, never which bushes draw.
    const count = (treeVariantCap: number): number =>
      collect(cellOf(bushes), 0, { treeVariantCap }).records
        .filter((entry) => entry.key.startsWith("shrub-hazel-")).length;
    expect(count(1)).toBe(count(3));
    expect(count(1)).toBe(40);
  });

  it("draws the cards alone unless the catalog has both the body and its stand-in", () => {
    const base = groundCatalog();
    const cell = cellOf([shrub()]);
    for (const missing of [SHRUB_BODY_PROTOTYPE_KEY, SHRUB_BODY_FAR_PROTOTYPE_KEY]) {
      const prototypes = { ...base.prototypes };
      delete prototypes[missing];
      const catalog = { ...base, prototypes };
      expect(keysOf(collect(cell, 40, {}, catalog).records), missing).toEqual(["shrub-hazel-v0"]);
      expect(collect(cell, 250, {}, catalog).records, missing).toEqual([]);
    }
  });

  it("lays a bush's shadow only where the tier draws ground shadows", () => {
    const cell = cellOf([shrub()]);
    expect(keysOf(collect(cell, 40, { treeGroundShadowRangeMeters: 0 }).records))
      .toEqual(["shrub-hazel-v0", SHRUB_BODY_PROTOTYPE_KEY, SHRUB_BODY_FAR_PROTOTYPE_KEY]);
  });

  it("draws a boulder while it stands tall enough to see, with its shadow", () => {
    const big = rock();
    const bigReach = big.radiusMeters * big.flattening * GROUND_OBJECT_REACH_METERS_PER_METER;
    expect(bigReach).toBeLessThan(RANGE);
    const inside = collect(cellOf([], [big]), bigReach + DETAIL_MEMBERSHIP_SLACK_METERS - 5);
    expect(keysOf(inside.records)).toEqual(["rock-granite", TREE_GROUND_SHADOW_PROTOTYPE_KEY]);
    expect(inside.statistics.rockInstances).toBe(1);
    expect(collect(cellOf([], [big]), bigReach + DETAIL_MEMBERSHIP_SLACK_METERS + 5).records)
      .toEqual([]);

    // A stone a fifth of a metre tall is gone inside 70 m, whatever the tier.
    const small = rock({ radiusMeters: 0.3, flattening: 0.7 });
    const smallReach = 0.3 * 0.7 * GROUND_OBJECT_REACH_METERS_PER_METER;
    expect(keysOf(collect(cellOf([], [small]), smallReach + DETAIL_MEMBERSHIP_SLACK_METERS - 5).records))
      .toEqual(["rock-granite", TREE_GROUND_SHADOW_PROTOTYPE_KEY]);
    expect(collect(cellOf([], [small]), smallReach + DETAIL_MEMBERSHIP_SLACK_METERS + 5).records)
      .toEqual([]);

    // The tier's cap stops the largest: with no range given it is the near radius.
    const capped = collect(
      cellOf([], [big]),
      law.near.outerRadiusMeters + DETAIL_MEMBERSHIP_SLACK_METERS + 5,
      {},
      groundCatalog(),
      null,
    );
    expect(capped.records).toEqual([]);

    const stone = inside.records[0]!.record;
    const shadow = inside.records[1]!.record;
    expect(stone.heightScaleMeters).toBeCloseTo(big.radiusMeters * big.flattening, 12);
    expect(stone.fade).toBe(1);
    expect(shadow.heightScaleMeters).toBe(stone.heightScaleMeters);
    expect(shadow.variant).toBe(0);
    expect(shadow.tint[2]).toBe(1);
    // A boulder is the same size from every range: nothing for the shadow to follow.
    expect(shadow.windResponse).toBe(0);
    expect(shadow.fade).toBe(1);
  });

  it("stops boulders at the tier's own cap for them, and their shadows with them", () => {
    const big = rock();
    const height = big.radiusMeters * big.flattening;
    const fullReach = height * GROUND_OBJECT_REACH_METERS_PER_METER;
    const BOULDERS = 250;
    expect(fullReach).toBeGreaterThan(BOULDERS * 1.5);
    const capped = { boulderRangeMeters: BOULDERS };
    const inside = collect(
      cellOf([], [big]), BOULDERS + DETAIL_MEMBERSHIP_SLACK_METERS - 5, capped);
    expect(keysOf(inside.records)).toEqual(["rock-granite", TREE_GROUND_SHADOW_PROTOTYPE_KEY]);
    expect(collect(cellOf([], [big]), BOULDERS + DETAIL_MEMBERSHIP_SLACK_METERS + 5, capped).records)
      .toEqual([]);
    // The stone's own material carries the cap. The shadow's law is capped
    // by the ground objects' range, so its record carries the share.
    expect(inside.records[0]!.record.fade).toBe(1);
    expect(inside.records[1]!.record.fade).toBeCloseTo(BOULDERS / fullReach, 12);
    // A stone whose reach is inside the cap is untouched by it.
    const small = rock({ radiusMeters: 0.6, flattening: 0.5 });
    const smallReach = 0.3 * GROUND_OBJECT_REACH_METERS_PER_METER;
    expect(smallReach).toBeLessThan(BOULDERS);
    const smallRecords = collect(
      cellOf([], [small]), smallReach + DETAIL_MEMBERSHIP_SLACK_METERS - 5, capped).records;
    expect(keysOf(smallRecords)).toEqual(["rock-granite", TREE_GROUND_SHADOW_PROTOTYPE_KEY]);
    expect(smallRecords[1]!.record.fade).toBe(1);
    // A boulder cap wider than the ground objects' range changes nothing,
    // and neither does one of zero: both are "no cap of its own".
    for (const boulderRangeMeters of [50_000, 0]) {
      const records = collect(
        cellOf([], [big]), fullReach + DETAIL_MEMBERSHIP_SLACK_METERS - 5, { boulderRangeMeters },
      ).records;
      expect(keysOf(records)).toEqual(["rock-granite", TREE_GROUND_SHADOW_PROTOTYPE_KEY]);
      expect(records[1]!.record.fade).toBe(1);
    }
    // Bushes do not take the boulders' cap.
    const bush = shrub({ heightMeters: 2.4, radiusMeters: 1.6 });
    expect(keysOf(collect(cellOf([bush]), 400, capped).records)).toContain(SHRUB_BODY_FAR_PROTOTYPE_KEY);
  });
});
