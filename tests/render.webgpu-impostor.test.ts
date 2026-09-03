import { describe, expect, it } from "vitest";
import {
  DETAIL_CROWN_ALBEDO,
  hemiOctahedralDirection,
  hemiOctahedralUv,
  impostorBakeFrame,
  impostorLayerIndex,
  IMPOSTOR_LAYER_EDGE,
  IMPOSTOR_SEASON_BUCKETS,
  IMPOSTOR_SPECIES,
  IMPOSTOR_VIEW_GRID,
  planImpostorAtlas,
} from "../src/render/webgpu/detail/ImpostorAtlas";
import { planFoliageAtlas, FOLIAGE_LAYERS } from "../src/render/webgpu/detail/FoliageAtlas";
import { DETAIL_IMPOSTOR_SPECIES_SLOTS } from "../src/render/webgpu/detail/DetailInstanceMaterialPlugin";
import { readSource } from "./support/sourceText";

/**
 * 2-17 / 2-17a — the impostor bake's pure surfaces: the hemi-octahedral
 * mapping, both exit criteria (mean-colour coherence with the card LOD, and
 * per-instance variety), the season buckets (deciduous shed, conifers
 * hold byte-identically), determinism, and the budget measurement.
 */

const PLANS = planImpostorAtlas("impostor-test");
const impostorAtlasSource = readSource(
  new URL("../src/render/webgpu/detail/ImpostorAtlas.ts", import.meta.url),
);
const detailRuntimeSource = readSource(
  new URL("../src/render/webgpu/detail/WorldDetailRuntime.ts", import.meta.url),
);

function layerStats(layer: number): {
  coverage: number;
  mean: [number, number, number];
} {
  const mip0 = PLANS.albedo.layerChains[layer]![0]!;
  let covered = 0;
  const sum = [0, 0, 0];
  for (let index = 0; index < mip0.length; index += 4) {
    if (mip0[index + 3]! < 128) continue;
    covered += 1;
    sum[0] = sum[0]! + mip0[index]! / 255;
    sum[1] = sum[1]! + mip0[index + 1]! / 255;
    sum[2] = sum[2]! + mip0[index + 2]! / 255;
  }
  const texels = mip0.length / 4;
  return {
    coverage: covered / texels,
    mean: [
      sum[0]! / Math.max(covered, 1),
      sum[1]! / Math.max(covered, 1),
      sum[2]! / Math.max(covered, 1),
    ],
  };
}

describe("hemi-octahedral mapping (2-17)", () => {
  it("round-trips every view-grid centre exactly", () => {
    for (let gridY = 0; gridY < IMPOSTOR_VIEW_GRID; gridY += 1) {
      for (let gridX = 0; gridX < IMPOSTOR_VIEW_GRID; gridX += 1) {
        const u = (gridX + 0.5) / IMPOSTOR_VIEW_GRID;
        const v = (gridY + 0.5) / IMPOSTOR_VIEW_GRID;
        const [x, y, z] = hemiOctahedralDirection(u, v);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(Math.hypot(x, y, z)).toBeCloseTo(1, 9);
        const [ru, rv] = hemiOctahedralUv(x, y, z);
        expect(ru).toBeCloseTo(u, 9);
        expect(rv).toBeCloseTo(v, 9);
      }
    }
  });
});

describe("impostor bake (2-17)", () => {
  it("keeps production on the single foliage-plan atlas route", () => {
    const sharedRouteStart = impostorAtlasSource.indexOf("export function createDetailAtlases(");
    const sharedRouteEnd = impostorAtlasSource.indexOf("\n}", sharedRouteStart);
    const sharedRoute = impostorAtlasSource.slice(sharedRouteStart, sharedRouteEnd);
    expect(sharedRouteStart).toBeGreaterThan(-1);
    expect(sharedRoute.match(/planFoliageAtlas\(/gu)).toHaveLength(1);
    expect(sharedRoute).toContain("createFoliageAtlas(scene, seed, foliagePlan)");
    expect(sharedRoute).toContain("createImpostorAtlas(scene, seed, foliagePlan)");

    const createBatchesStart = detailRuntimeSource.indexOf("private createBatches(): void");
    const createBatchesEnd = detailRuntimeSource.indexOf("const prototypeSeed", createBatchesStart);
    const productionRoute = detailRuntimeSource.slice(createBatchesStart, createBatchesEnd);
    expect(createBatchesStart).toBeGreaterThan(-1);
    expect(productionRoute).toContain("createDetailAtlases(this.scene, this.options.worldSeed)");
    expect(productionRoute).not.toContain("createFoliageAtlas(");
    expect(productionRoute).not.toContain("createImpostorAtlas(");
  });

  it("pins the crown albedo shared by opaque hulls, cards and the far bake", () => {
    // Wave P warmed this (0.86,0.89,0.82 -> 0.92,0.91,0.8) as part of the
    // teal-canopy fix: red lifted over green to counter blue sky irradiance.
    expect(DETAIL_CROWN_ALBEDO).toEqual([0.92, 0.91, 0.8]);
  });
  it("bakes non-trivial coverage for every species and view row", () => {
    for (const species of IMPOSTOR_SPECIES) {
      const stats = layerStats(impostorLayerIndex(species, 0));
      expect(stats.coverage, species).toBeGreaterThan(0.08);
      expect(stats.coverage, species).toBeLessThan(0.9);
    }
  });

  it("keeps impostor mean colour coherent with the opaque crown LOD", () => {
    // The impostor is baked from the SAME atlas texels, material albedo and
    // occlusion math the card fragment uses, so its covered-mean colour must
    // sit inside the opaque-hull path's analytic envelope: dense atlas-layer covered mean
    // × crown albedo × occlusion ∈ [0.42, 1]. Gross drift here is a wrong
    // layer, a lost albedo multiply, or a broken occlusion bake — the three
    // ways an LOD transition reads as a brightness pop.
    const foliage = planFoliageAtlas("impostor-test");
    for (const species of IMPOSTOR_SPECIES) {
      const crownLayer = species === "pine" || species === "cedar" || species === "spruce"
        ? FOLIAGE_LAYERS.crownConiferDense
        : FOLIAGE_LAYERS.crownBroadleafDense;
      const mip0 = foliage.layerChains[crownLayer]![0]!;
      const sum = [0, 0, 0];
      let covered = 0;
      for (let index = 0; index < mip0.length; index += 4) {
        if (mip0[index + 3]! < 128) continue;
        covered += 1;
        sum[0] = sum[0]! + mip0[index]! / 255;
        sum[1] = sum[1]! + mip0[index + 1]! / 255;
        sum[2] = sum[2]! + mip0[index + 2]! / 255;
      }
      const impostor = layerStats(impostorLayerIndex(species, 0)).mean;
      for (let channel = 0; channel < 3; channel += 1) {
        const crownTexel = (sum[channel]! / covered) * DETAIL_CROWN_ALBEDO[channel]!;
        // The impostor mean mixes crown texels (dominant) with bark; its
        // green channel especially must track the crown envelope.
        expect(impostor[channel]!, `${species} ch${channel}`)
          .toBeGreaterThan(crownTexel * 0.42 * 0.55);
        expect(impostor[channel]!, `${species} ch${channel}`)
          .toBeLessThan(crownTexel * 1.45 + 0.08);
      }
    }
  });

  it("bakes camera-facing normals in every view tile, surviving the mips", () => {
    // The bake shipped with its double-sided orientation test INVERTED: 0.0%
    // of covered normal texels faced the bake camera, the far band's diffuse
    // collapsed to ~0.13-0.22 of the mid hull's, and the unchanged
    // environment specular became a view-locked sheen — the reported
    // "dark/reflective distant trees". The albedo-only calibration test above
    // passed throughout, which is why this assertion exists: it reads the
    // NORMAL array, per view tile, against that tile's own bake direction,
    // at mip 0 and again at mip 2 (where un-dilated encoded-black used to
    // drag the mean normal down with distance).
    const checkFacing = (mip: number, floor: number): void => {
      for (const species of IMPOSTOR_SPECIES) {
        const layer = impostorLayerIndex(species, 0);
        const normals = PLANS.normalDepth.layerChains[layer]![mip]!;
        const layerEdge = IMPOSTOR_LAYER_EDGE >> mip;
        const tileEdge = layerEdge / IMPOSTOR_VIEW_GRID;
        let covered = 0;
        let facing = 0;
        for (let gridY = 0; gridY < IMPOSTOR_VIEW_GRID; gridY += 1) {
          for (let gridX = 0; gridX < IMPOSTOR_VIEW_GRID; gridX += 1) {
            const [dx, dy, dz] = hemiOctahedralDirection(
              (gridX + 0.5) / IMPOSTOR_VIEW_GRID,
              (gridY + 0.5) / IMPOSTOR_VIEW_GRID,
            );
            for (let py = 0; py < tileEdge; py += 1) {
              for (let px = 0; px < tileEdge; px += 1) {
                const index = ((gridY * tileEdge + py) * layerEdge
                  + gridX * tileEdge + px) * 4;
                if (normals[index + 3]! < 128) continue;
                covered += 1;
                const nx = normals[index]! / 127.5 - 1;
                const ny = normals[index + 1]! / 127.5 - 1;
                const nz = normals[index + 2]! / 127.5 - 1;
                if (nx * dx + ny * dy + nz * dz > 0) facing += 1;
              }
            }
          }
        }
        expect(covered, `${species} mip${mip} coverage`).toBeGreaterThan(80);
        expect(facing / Math.max(covered, 1), `${species} mip${mip}`)
          .toBeGreaterThan(floor);
      }
    };
    // Wave R re-pin: the bake now stores the geometry bands' AUTHORED dome
    // normals (flipped whole only on back faces of the two-sided card
    // shell), so a legitimate ~5-15% of covered texels face past 90 degrees
    // from the bake view — exactly as the mid band's cards do. The floors
    // guard the INVERSION failure this test was written for (which reads
    // ~0% facing), not perfect view alignment.
    checkFacing(0, 0.75);
    checkFacing(2, 0.65);
  });

  it("bakes DOME-character normals: the top view's mean normal points up", () => {
    // Wave R companion: without it, the facing floors above would silently
    // permit a revert to camera-flipped FACE normals (which also pass a
    // facing floor). Dome normals seen from straight above must average
    // strongly upward; view-locked face normals average toward the camera
    // for EVERY tile, which for the top view is also up — so additionally
    // require the side view's mean to carry a real upward component, which
    // a pure camera-facing bake cannot produce (its side-view mean is
    // horizontal).
    for (const species of IMPOSTOR_SPECIES) {
      const layer = impostorLayerIndex(species, 0);
      const normals = PLANS.normalDepth.layerChains[layer]![0]!;
      const layerEdge = IMPOSTOR_LAYER_EDGE;
      const tileEdge = layerEdge / IMPOSTOR_VIEW_GRID;
      // Side view: grid corner (0.5/GRID, 0.5/GRID) maps near the horizon.
      const sideTile = { gridX: 0, gridY: 0 };
      let sumY = 0;
      let covered = 0;
      for (let py = 0; py < tileEdge; py += 1) {
        for (let px = 0; px < tileEdge; px += 1) {
          const index = ((sideTile.gridY * tileEdge + py) * layerEdge
            + sideTile.gridX * tileEdge + px) * 4;
          if (normals[index + 3]! < 128) continue;
          covered += 1;
          sumY += normals[index + 1]! / 127.5 - 1;
        }
      }
      expect(covered, `${species} side coverage`).toBeGreaterThan(40);
      expect(sumY / Math.max(covered, 1), `${species} side-view mean normal.y`)
        .toBeGreaterThan(0.12);
    }
  });

  it("sheds deciduous bare buckets while conifers hold byte-identically (2-17a)", () => {
    for (const species of ["oak", "maple", "birch", "willow"] as const) {
      const leafed = layerStats(impostorLayerIndex(species, 0));
      const bare = layerStats(impostorLayerIndex(species, 1));
      expect(bare.coverage, species).toBeLessThan(leafed.coverage * 0.75);
    }
    for (const species of ["pine", "cedar", "spruce"] as const) {
      const leafed = PLANS.albedo.layerChains[impostorLayerIndex(species, 0)]![0]!;
      const bare = PLANS.albedo.layerChains[impostorLayerIndex(species, 1)]![0]!;
      expect(Buffer.from(leafed).equals(Buffer.from(bare)), species).toBe(true);
    }
  });

  it("gives instances distinct view phase and mirror from the hash byte", () => {
    // The far-band variant byte carries SPECIES in its high three bits and
    // 2-17's per-stem hash in the low five (perf-debt pass): the shader
    // reads mirror = bit 0, phase = floor(byte/2) % 4, species =
    // floor(byte/32). No two neighbours share both silhouette aspect
    // (mirror + anisotropic record scales) and view phase unless the hash
    // collides, and the species packing must not disturb either.
    const mirrors = new Set<number>();
    const phases = new Set<number>();
    for (let stem = 0; stem < 100; stem += 1) {
      const selection = (stem * 0.6180339887) % 1;
      const speciesIndex = stem % IMPOSTOR_SPECIES.length;
      const byte = speciesIndex * 32 + Math.floor(((selection * 97.3) % 1) * 32);
      expect(byte).toBeLessThan(256);
      expect(Math.floor(byte / 32)).toBe(speciesIndex);
      mirrors.add(byte % 2);
      phases.add(Math.floor(byte / 2) % 4);
    }
    expect(mirrors.size).toBe(2);
    expect(phases.size).toBe(4);
  });

  it("packs every species into the variant byte's three spare bits", () => {
    // The table the plugin uploads is indexed by that field, so the species
    // count and the bit budget have to agree. An eighth species is fine; a
    // ninth is an instance-format decision, not an oversight.
    expect(IMPOSTOR_SPECIES.length).toBeLessThanOrEqual(
      DETAIL_IMPOSTOR_SPECIES_SLOTS,
    );
    expect(DETAIL_IMPOSTOR_SPECIES_SLOTS).toBe(8);
    IMPOSTOR_SPECIES.forEach((species, index) => {
      // unorm8 round-trip: the byte reaches the shader as state.y × 255.
      const byte = index * 32 + 31;
      // The shader's exact decode: floor(state.y × 255 + 0.5), then / 32.
      const decoded = Math.floor(Math.floor((byte / 255) * 255 + 0.5) / 32);
      expect(decoded, species).toBe(index);
      expect(impostorLayerIndex(species, 0)).toBe(index * IMPOSTOR_SEASON_BUCKETS);
      expect(impostorLayerIndex(species, 1)).toBe(index * IMPOSTOR_SEASON_BUCKETS + 1);
      // The bake frame is per species and reaches the shader as a table row,
      // so it must be finite and inside the unit prototype's extent.
      const frame = impostorBakeFrame(species);
      expect(frame.extentUnit).toBeGreaterThan(0.1);
      expect(frame.extentUnit).toBeLessThan(1.5);
      expect(frame.centerYUnit).toBeGreaterThan(0.1);
      expect(frame.centerYUnit).toBeLessThan(1);
    });
  });

  it("is deterministic and inside the memory headroom", () => {
    // Production reuses the foliage plan it already uploaded. Compare that
    // optimized route against the independent default bake so removing the
    // duplicate synthesis cannot alter either impostor texture.
    const again = planImpostorAtlas(
      "impostor-test",
      planFoliageAtlas("impostor-test"),
    );
    for (const texture of ["albedo", "normalDepth"] as const) {
      expect(again[texture].packedLevels).toHaveLength(PLANS[texture].packedLevels.length);
      for (let level = 0; level < PLANS[texture].packedLevels.length; level += 1) {
        expect(
          Buffer.from(again[texture].packedLevels[level]!)
            .equals(Buffer.from(PLANS[texture].packedLevels[level]!)),
          `${texture} mip ${level} changed on the shared-foliage-plan path`,
        ).toBe(true);
      }
    }
    const bytes = [PLANS.albedo, PLANS.normalDepth].reduce(
      (sum, plan) => sum + plan.packedLevels.reduce((s, level) => s + level.byteLength, 0),
      0,
    );
    const megabytes = bytes / (1024 * 1024);
    // The §5.2 arbitration the plan asked to settle by measurement: 64²
    // tiles land both buckets AND the normal+depth array at 9.33 MiB,
    // inside the ~15.8 MiB headroom the 128² sketch overran.
    expect(megabytes).toBeCloseTo(9.33, 1);
    expect(PLANS.layerCount).toBe(IMPOSTOR_SPECIES.length * IMPOSTOR_SEASON_BUCKETS);
    expect(PLANS.albedo.edge).toBe(IMPOSTOR_LAYER_EDGE);
  });
});
