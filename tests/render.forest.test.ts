import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  createAspenCanopyGeometry,
  createDetailedTreeTrunkGeometry,
  createFarBroadleafGeometry,
  createFarConiferGeometry,
  createOakCanopyGeometry,
  createPineCanopyGeometry,
  createSpruceCanopyGeometry,
  estimateForestPassTriangles,
  FAR_FOREST_RADIUS,
  FAR_FOREST_RADIAL_BAND_SIZE,
  forestGeometryTriangles,
  FOREST_LOD_CENTER_STEP,
  FOREST_LOD_ANGULAR_SECTORS,
  forestLodAngularSector,
  includesFarTreeLod,
  includesNearTreeLod,
  orderForestLodCandidates,
  selectTreeSpecies,
  snapForestLodCenter,
  TREE_SPECIES_PROFILES,
  treeRenderBudget,
  type ForestLodPriorityCandidate,
  type TreeSpecies,
} from "../src/render/ForestSystem";
import { cascadedShadowBudget } from "../src/render/CascadedShadowController";
import {
  type HybridRenderCapabilities,
} from "../src/render/hybrid/RenderCapabilities";
import { resolveRenderProfile } from "../src/render/hybrid/RenderProfile";

const FOREST_BUDGET_CAPABILITIES: HybridRenderCapabilities = {
  backend: "webgl2",
  webGpuApiAvailable: false,
  hardwareRayTracing: false,
  colorBufferFloat: true,
  floatLinearFiltering: true,
  timerQueries: true,
  parallelShaderCompile: true,
  anisotropicFiltering: true,
  maxTextureSize: 8_192,
  maxRenderbufferSize: 8_192,
  maxDrawBuffers: 4,
  maxColorAttachments: 4,
  maxSamples: 4,
  maxFragmentTextureUnits: 16,
};

describe("deterministic instanced forest", () => {
  it("keeps four distinct silhouettes inside explicit browser triangle budgets", () => {
    const geometries = {
      trunk: createDetailedTreeTrunkGeometry(),
      oak: createOakCanopyGeometry(),
      aspen: createAspenCanopyGeometry(),
      pine: createPineCanopyGeometry(),
      spruce: createSpruceCanopyGeometry(),
      farConifer: createFarConiferGeometry(),
      farBroadleaf: createFarBroadleafGeometry(),
    };
    try {
      const triangles = Object.fromEntries(
        Object.entries(geometries).map(([name, geometry]) => [
          name,
          forestGeometryTriangles(geometry),
        ]),
      );
      expect(triangles.trunk).toBeLessThanOrEqual(56);
      expect(triangles.oak).toBeLessThanOrEqual(100);
      expect(triangles.aspen).toBeLessThanOrEqual(80);
      expect(triangles.pine).toBeLessThanOrEqual(48);
      expect(triangles.spruce).toBeLessThanOrEqual(70);
      expect(triangles.farConifer).toBeLessThanOrEqual(36);
      expect(triangles.farBroadleaf).toBeLessThanOrEqual(36);

      // The worst case assumes every near instance uses the most expensive
      // crown. Runtime species routing is mutually exclusive, so this is a
      // conservative upper bound rather than an average-scene estimate.
      const high = treeRenderBudget("high");
      const worstNear = high.nearInstances * (
        triangles.trunk! + Math.max(
          triangles.oak!,
          triangles.aspen!,
          triangles.pine!,
          triangles.spruce!,
        )
      );
      const worstFar = high.farInstances * Math.max(
        triangles.farConifer!,
        triangles.farBroadleaf!,
      );
      expect(worstNear + worstFar).toBeLessThan(500_000);

      const silhouettes = [
        geometries.oak,
        geometries.aspen,
        geometries.pine,
        geometries.spruce,
      ].map((geometry) => {
        geometry.computeBoundingBox();
        const box = geometry.boundingBox!;
        return [
          Number((box.max.x - box.min.x).toFixed(2)),
          Number((box.max.y - box.min.y).toFixed(2)),
          forestGeometryTriangles(geometry),
        ].join(":");
      });
      expect(new Set(silhouettes).size).toBe(4);

      geometries.trunk.computeBoundingBox();
      expect(5.5 + geometries.trunk.boundingBox!.min.y).toBeGreaterThanOrEqual(-0.001);
      for (const species of ["oak", "aspen", "pine", "spruce"] as const) {
        const crown = geometries[species];
        crown.computeBoundingBox();
        const profile = TREE_SPECIES_PROFILES[species];
        const lowestPlantedVertex = (
          profile.crownCenterHeight + crown.boundingBox!.min.y
        ) * profile.heightScale;
        expect(lowestPlantedVertex).toBeGreaterThanOrEqual(0);
      }
      geometries.farConifer.computeBoundingBox();
      geometries.farBroadleaf.computeBoundingBox();
      expect(geometries.farConifer.boundingBox!.min.y).toBeGreaterThanOrEqual(0);
      expect(geometries.farBroadleaf.boundingBox!.min.y).toBeGreaterThanOrEqual(0);
    } finally {
      Object.values(geometries).forEach((geometry) => geometry.dispose());
    }
  });

  it("accounts honestly for beauty, planar, and configured CSM submissions", () => {
    const geometries = {
      trunk: createDetailedTreeTrunkGeometry(),
      oak: createOakCanopyGeometry(),
      aspen: createAspenCanopyGeometry(),
      pine: createPineCanopyGeometry(),
      spruce: createSpruceCanopyGeometry(),
      farConifer: createFarConiferGeometry(),
      farBroadleaf: createFarBroadleafGeometry(),
    };
    try {
      const nearTrianglesPerInstance = forestGeometryTriangles(geometries.trunk) + Math.max(
        forestGeometryTriangles(geometries.oak),
        forestGeometryTriangles(geometries.aspen),
        forestGeometryTriangles(geometries.pine),
        forestGeometryTriangles(geometries.spruce),
      );
      const farTrianglesPerInstance = Math.max(
        forestGeometryTriangles(geometries.farConifer),
        forestGeometryTriangles(geometries.farBroadleaf),
      );
      const highBudget = treeRenderBudget("high");
      const highProfile = resolveRenderProfile(
        {
          renderingMode: "ray-traced",
          quality: "high",
          outputWidth: 1_920,
          outputHeight: 1_080,
        },
        FOREST_BUDGET_CAPABILITIES,
      );
      const estimate = estimateForestPassTriangles({
        nearInstances: highBudget.nearInstances,
        farInstances: highBudget.farInstances,
        nearTrianglesPerInstance,
        farTrianglesPerInstance,
        shadowCascades: cascadedShadowBudget("high", "ray-traced").cascades,
        planarCadenceMs: highProfile.planar.enabled ? highProfile.planar.cadenceMs : 0,
      });

      expect(estimate).toEqual({
        beautyTriangles: 485_600,
        planarUpdateTriangles: 485_600,
        shadowTriangles: 1_003_200,
        peakTriangles: 1_974_400,
        averageTrianglesPerFrame: 1_974_400,
        planarFrameFraction: 1,
      });
      expect(estimate.peakTriangles).toBeLessThan(2_000_000);
    } finally {
      Object.values(geometries).forEach((geometry) => geometry.dispose());
    }
  });

  it("uses deterministic continuous habitat weights rather than altitude bands", () => {
    const input = {
      height: 540,
      slope: 0.11,
      moisture: 0.68,
      temperature: 0.57,
      selector: 0.413,
    };
    expect(selectTreeSpecies(input)).toBe(selectTreeSpecies(input));

    const species = new Set<TreeSpecies>();
    for (let index = 0; index < 400; index += 1) {
      species.add(selectTreeSpecies({
        height: (index * 37) % 1_250,
        slope: ((index * 17) % 25) / 100,
        moisture: ((index * 43) % 100) / 100,
        temperature: ((index * 61) % 100) / 100,
        selector: ((index * 73) % 400) / 399,
      }));
    }
    expect(species).toEqual(new Set<TreeSpecies>(["oak", "aspen", "pine", "spruce"]));

    let warmLowlandDeciduous = 0;
    let coldHighlandEvergreen = 0;
    for (let index = 0; index < 200; index += 1) {
      const selector = (index + 0.5) / 200;
      const lowland = selectTreeSpecies({
        height: 120,
        slope: 0.04,
        moisture: 0.82,
        temperature: 0.85,
        selector,
      });
      const highland = selectTreeSpecies({
        height: 1_100,
        slope: 0.18,
        moisture: 0.72,
        temperature: 0.24,
        selector,
      });
      if (lowland === "oak" || lowland === "aspen") warmLowlandDeciduous += 1;
      if (highland === "pine" || highland === "spruce") coldHighlandEvergreen += 1;
    }
    expect(warmLowlandDeciduous).toBeGreaterThan(125);
    expect(coldHighlandEvergreen).toBeGreaterThan(170);
  });

  it("never mirrors an instance and keeps every quality budget within capacity", () => {
    expect(treeRenderBudget("low")).toEqual({
      nearInstances: 820,
      farInstances: 1_350,
      rockInstances: 180,
      nearRadius: 3_000,
    });
    expect(treeRenderBudget("medium")).toEqual({
      nearInstances: 1_500,
      farInstances: 2_650,
      rockInstances: 620,
      nearRadius: 4_200,
    });
    expect(treeRenderBudget("high")).toEqual({
      nearInstances: 2_200,
      farInstances: 4_200,
      rockInstances: 900,
      nearRadius: 5_100,
    });

    const rotation = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      1.7,
    );
    for (const profile of Object.values(TREE_SPECIES_PROFILES)) {
      const transform = new THREE.Matrix4().compose(
        new THREE.Vector3(20, 100, -30),
        rotation,
        new THREE.Vector3(profile.widthScale, profile.heightScale, profile.widthScale),
      );
      expect(transform.determinant()).toBeGreaterThan(0);
      expect(profile.crownCenterHeight).toBeGreaterThan(0);
      expect(profile.widthScale).toBeGreaterThan(0);
      expect(profile.heightScale).toBeGreaterThan(0);
    }
  });

  it("keeps forest LOD aircraft-centred and continuous across terrain-tile boundaries", () => {
    // The old implementation jumped its centre from 800 m to 2,400 m at this
    // boundary. Both sides now resolve to the same small, world-stable centre.
    expect(snapForestLodCenter(1_599.9)).toBe(1_600);
    expect(snapForestLodCenter(1_600.1)).toBe(1_600);
    expect(FOREST_LOD_CENTER_STEP).toBeLessThanOrEqual(320);

    const nearRadius = treeRenderBudget("medium").nearRadius;
    for (let index = 0; index < 128; index += 1) {
      const selector = (index + 0.5) / 128;
      // An explicit overlap separates the far cut-in from the randomized near
      // cut-out, so no selector can open a scenery hole during a rebuild.
      expect(includesNearTreeLod((nearRadius * 0.81) ** 2, nearRadius, selector)).toBe(true);
      expect(includesFarTreeLod((nearRadius * 0.79) ** 2, nearRadius, selector)).toBe(true);
      expect(includesNearTreeLod((nearRadius * 1.01) ** 2, nearRadius, selector)).toBe(false);
      expect(includesFarTreeLod((nearRadius * 0.63) ** 2, nearRadius, selector)).toBe(false);
    }

    expect(snapForestLodCenter(-1_600.1)).toBe(-1_600);
    expect(snapForestLodCenter(-1_599.9)).toBe(-1_600);
  });

  it("keeps capped far LOD coverage in every sector across tile and forest-centre boundaries", () => {
    interface FixtureCandidate extends ForestLodPriorityCandidate {
      readonly id: string;
    }
    const cellSize = 380;
    const makeCandidates = (aircraftX: number): FixtureCandidate[] => {
      const centerX = snapForestLodCenter(aircraftX);
      const centerZ = snapForestLodCenter(-1_600.1);
      const minimumCellX = Math.floor((centerX - FAR_FOREST_RADIUS) / cellSize);
      const maximumCellX = Math.ceil((centerX + FAR_FOREST_RADIUS) / cellSize);
      const minimumCellZ = Math.floor((centerZ - FAR_FOREST_RADIUS) / cellSize);
      const maximumCellZ = Math.ceil((centerZ + FAR_FOREST_RADIUS) / cellSize);
      const candidates: FixtureCandidate[] = [];
      for (let cellZ = minimumCellZ; cellZ <= maximumCellZ; cellZ += 1) {
        for (let cellX = minimumCellX; cellX <= maximumCellX; cellX += 1) {
          const x = (cellX + 0.5) * cellSize;
          const z = (cellZ + 0.5) * cellSize;
          const deltaX = x - centerX;
          const deltaZ = z - centerZ;
          const distanceSquared = deltaX * deltaX + deltaZ * deltaZ;
          if (distanceSquared < 1_600 ** 2 || distanceSquared > FAR_FOREST_RADIUS ** 2) {
            continue;
          }
          candidates.push({
            deltaX,
            deltaZ,
            distanceSquared,
            id: `${cellX}:${cellZ}`,
            stableX: cellX,
            stableZ: cellZ,
            tieBreaker: (
              Math.imul(cellX ^ 0x51a7, 0x45d9f3b) ^
              Math.imul(cellZ, 0x27d4eb2d)
            ) >>> 0,
          });
        }
      }
      return candidates;
    };
    const select = (aircraftX: number, quality: "low" | "medium") => {
      const limit = treeRenderBudget(quality).farInstances;
      return orderForestLodCandidates(makeCandidates(aircraftX)).slice(0, limit);
    };
    const expectSectorCoverage = (selection: readonly FixtureCandidate[]) => {
      const sectors = Array.from({ length: FOREST_LOD_ANGULAR_SECTORS }, () => 0);
      for (const candidate of selection) {
        sectors[forestLodAngularSector(candidate.deltaX, candidate.deltaZ)]! += 1;
      }
      expect(Math.min(...sectors)).toBeGreaterThan(selection.length * 0.06);
      expect(Math.max(...sectors) - Math.min(...sectors)).toBeLessThan(
        selection.length * 0.04,
      );
    };

    // A three-tile 12.8 km far grid always contains this radius, including the
    // maximum half-snap between the aircraft and forest LOD centre.
    expect(FAR_FOREST_RADIUS + FOREST_LOD_CENTER_STEP * 0.5).toBeLessThan(1_600 * 8);
    expect(FAR_FOREST_RADIAL_BAND_SIZE).toBe(cellSize * 2);

    for (const quality of ["low", "medium"] as const) {
      const beforeTerrainBoundary = select(1_599.9, quality);
      const afterTerrainBoundary = select(1_600.1, quality);
      expect(beforeTerrainBoundary.map(({ id }) => id)).toEqual(
        afterTerrainBoundary.map(({ id }) => id),
      );
      expectSectorCoverage(beforeTerrainBoundary);

      const beforeForestBoundary = select(1_759.9, quality);
      const afterForestBoundary = select(1_760.1, quality);
      expectSectorCoverage(beforeForestBoundary);
      expectSectorCoverage(afterForestBoundary);
      const previousIds = new Set(beforeForestBoundary.map(({ id }) => id));
      const retained = afterForestBoundary.filter(({ id }) => previousIds.has(id)).length;
      expect(retained / afterForestBoundary.length).toBeGreaterThan(0.88);
    }
  });
});
