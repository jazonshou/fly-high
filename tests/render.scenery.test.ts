import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  TerrainRenderer,
  isInsideAirportSceneryClearance,
  setNearTerrainCutoutBounds,
  snapWaterCenter,
} from "../src/render/TerrainRenderer";
import { createWorld, runwayToWorld, sampleTerrain } from "../src/world";

describe("procedural scenery renderer", () => {
  it("creates an immediate relief-bearing horizon and bounded LOD scene", () => {
    const seed = 4_253_686_068;
    const world = createWorld(seed);
    const renderer = new TerrainRenderer(
      (x, z) => sampleTerrain(world, x, z),
      seed,
      1_600,
      "medium",
      world.airport ?? undefined,
    );

    renderer.update(0, 0, 0, 0);
    const horizon = renderer.group.getObjectByName("always-ready-distant-terrain") as
      | THREE.Mesh<THREE.BufferGeometry>
      | undefined;
    expect(horizon).toBeDefined();
    const positions = horizon?.geometry.getAttribute("position") as THREE.BufferAttribute;
    expect(positions.count).toBeGreaterThan(900);
    const heights: number[] = [];
    for (let index = 0; index < positions.count; index += 1) heights.push(positions.getY(index));
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(300);

    // 7x7 near tiles plus 3x3 coarse far tiles: a fixed, inspectable budget.
    expect(renderer.tileCount).toBe(58);
    const nearTerrain = renderer.group.getObjectByName("near-terrain-chunk") as
      | THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
      | undefined;
    expect(nearTerrain?.material.depthFunc).toBe(THREE.LessEqualDepth);
    const farTerrain = renderer.group.getObjectByName("far-terrain-chunk") as
      | THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
      | undefined;
    expect(farTerrain?.position.y).toBe(0);
    expect(farTerrain?.geometry.getAttribute("position").count).toBe(19 * 19);
    expect(farTerrain?.material.customProgramCacheKey()).toBe(
      "far-terrain-near-grid-cutout-v2",
    );
    const shader = {
      uniforms: {},
      vertexShader: "#include <common>\n#include <begin_vertex>",
      fragmentShader:
        "#include <common>\n#include <color_fragment>\n#include <normal_fragment_maps>\n#include <clipping_planes_fragment>",
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    farTerrain?.material.onBeforeCompile(shader, {} as unknown as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain("vTerrainScenePosition");
    expect(shader.fragmentShader).toContain("nearTerrainBounds");
    expect(shader.fragmentShader).toContain("discard");
    expect(shader.fragmentShader).toContain("terrainStrata");
    expect(shader.fragmentShader).toContain("terrainBumpX");
    expect(shader.fragmentShader).toContain("terrainMicroTexture");
    expect(shader.fragmentShader).toContain("terrainVegetationMask");
    expect(shader.fragmentShader).toContain("terrainMicroGradient");
    expect(shader.fragmentShader).toContain("terrainBroadNormalStrength = 0.36");
    expect(shader.fragmentShader).toContain("terrainMicroNormalStrength = 0.9");
    expect(shader.fragmentShader).toContain("terrainWaterCutoutLevel");
    expect(shader.fragmentShader).toContain(
      "vTerrainWorldPosition.y <= terrainWaterCutoutLevel",
    );
    expect(shader.uniforms.nearTerrainBounds).toBeDefined();
    expect(shader.uniforms.terrainWorldOrigin).toBeDefined();
    expect(shader.uniforms.terrainDetailMap).toBeDefined();
    expect(
      (shader.uniforms.terrainDetailMap as { value: THREE.DataTexture }).value.anisotropy,
    ).toBe(8);
    expect(setNearTerrainCutoutBounds(new THREE.Vector4(), 0, 0, 3, 1_600, 0, 0).toArray()).toEqual([
      -4_800,
      6_400,
      -4_800,
      6_400,
    ]);
    expect(renderer.group.getObjectByName("near-tree-canopies")).toBeDefined();
    const broadleafCanopies = renderer.group.getObjectByName("near-tree-canopies") as
      | THREE.InstancedMesh
      | undefined;
    const conifers = renderer.group.getObjectByName("near-conifer-canopies") as
      | THREE.InstancedMesh
      | undefined;
    expect(broadleafCanopies?.geometry.getAttribute("position").count).toBeGreaterThan(100);
    expect(broadleafCanopies?.castShadow).toBe(true);
    expect(conifers).toBeDefined();
    expect(conifers?.castShadow).toBe(true);
    expect(renderer.group.getObjectByName("far-forest-lod")).toBeDefined();
    expect(renderer.group.getObjectByName("scattered-rocks")).toBeDefined();
    expect(renderer.group.getObjectByName("procedural-ground-cover")).toBeDefined();
    expect(renderer.group.getObjectByName("instanced-grass-patches")).toBeDefined();
    renderer.dispose();
  });

  it("uses stable opaque mirrored water anchored to snapped world coordinates", () => {
    const seed = 9_721;
    const world = createWorld(seed);
    const renderer = new TerrainRenderer(
      (x, z) => sampleTerrain(world, x, z),
      seed,
      1_600,
      "medium",
      world.airport ?? undefined,
    );
    renderer.update(3_100, -3_100, 0, 0);
    const water = renderer.group.getObjectByName("stable-procedural-water") as
      | THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>
      | undefined;
    expect(water).toBeDefined();
    expect(water?.position.x).toBe(snapWaterCenter(3_100));
    expect(water?.position.z).toBe(snapWaterCenter(-3_100));
    expect(water?.material.transparent).toBe(false);
    expect(water?.material.depthWrite).toBe(true);
    expect(water?.material.side).toBe(THREE.DoubleSide);
    expect(water?.material.polygonOffset).toBe(false);
    expect(water?.material.roughness).toBeLessThan(0.1);
    expect(water?.material.ior).toBeCloseTo(1.333, 3);
    expect(water?.material.clearcoat).toBe(1);
    expect(water?.receiveShadow).toBe(false);
    expect(water?.position.y).toBeGreaterThan(0.1);
    expect(water?.material.customProgramCacheKey()).toBe(
      "stable-water-mirror-ripples-v5",
    );

    const shader = {
      uniforms: {},
      vertexShader: "#include <common>\n#include <begin_vertex>",
      fragmentShader:
        "#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>\n#include <clearcoat_normal_fragment_maps>",
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    water?.material.onBeforeCompile(shader, {} as unknown as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain("waterFresnel");
    expect(shader.fragmentShader).toContain("waterWaveGradient");
    expect(shader.fragmentShader).toContain("waterDomainWarp");
    expect(shader.fragmentShader).toContain("waterPhaseA");
    expect(shader.fragmentShader).toContain("waterPhaseB");
    expect(shader.fragmentShader).toContain("waterPhaseD");
    expect(shader.fragmentShader).toContain("WATER_DIRECTION_D * cos(fourth)");
    expect(shader.fragmentShader).toContain("WATER_DIRECTION_A * broadWaveA * 0.03");
    expect(shader.fragmentShader).toContain("WATER_DIRECTION_B * broadWaveB * 0.028");
    expect(shader.fragmentShader).toContain("mediumWaveFade");
    expect(shader.fragmentShader).toContain("capillaryWaveFade");
    expect(shader.fragmentShader).toContain("waterReflectionRay");
    expect(shader.fragmentShader).toContain("waterSunGlint");
    expect(shader.fragmentShader).toContain("roughnessFactor");
    expect(shader.fragmentShader).toContain("clearcoatNormal = waterNormalView");
    expect(shader.uniforms.waterTime).toBeDefined();
    expect(shader.uniforms.waterWorldOrigin).toBeDefined();
    renderer.dispose();
  });

  it("keeps the visible runway aligned to collision elevation", () => {
    const seed = 812_893;
    const world = createWorld(seed);
    const airport = world.airport!;
    const renderer = new TerrainRenderer(
      (x, z) => sampleTerrain(world, x, z),
      seed,
      1_600,
      "low",
      airport,
    );
    const surface = renderer.group.getObjectByName("runway-surface") as THREE.Mesh | undefined;
    expect(surface).toBeDefined();
    expect(surface?.position.y).toBeCloseTo(airport.elevation + 0.025, 8);
    expect((surface?.material as THREE.MeshStandardMaterial).depthFunc).toBe(THREE.AlwaysDepth);
    expect(surface?.renderOrder).toBeLessThan(0);
    expect(renderer.group.getObjectByName("runway-markings")).toBeDefined();
    expect(renderer.group.getObjectByName("runway-lights")).toBeDefined();
    renderer.dispose();
  });

  it("keeps vegetation out of the runway and complete service area", () => {
    const airport = createWorld(921_441).airport!;
    const runwayPoint = runwayToWorld(airport, 0, 0);
    const apronPoint = runwayToWorld(
      airport,
      -airport.runwayLength * 0.18,
      airport.runwayWidth * 0.5 + 190,
    );
    const beyondServiceArea = runwayToWorld(
      airport,
      -airport.runwayLength * 0.18,
      airport.runwayWidth * 0.5 + 240,
    );
    expect(isInsideAirportSceneryClearance(airport, runwayPoint.x, runwayPoint.z)).toBe(true);
    expect(isInsideAirportSceneryClearance(airport, apronPoint.x, apronPoint.z)).toBe(true);
    expect(
      isInsideAirportSceneryClearance(
        airport,
        beyondServiceArea.x,
        beyondServiceArea.z,
      ),
    ).toBe(false);
  });
});
