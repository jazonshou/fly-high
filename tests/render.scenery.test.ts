import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  TERRAIN_WATER_CUTOUT_LEVEL,
  TerrainRenderer,
  WATER_RENDER_LEVEL,
  createConcentricWaterGeometry,
  isInsideAirportSceneryClearance,
  setNearTerrainCutoutBounds,
  snapWaterCenter,
  terrainVertexResolution,
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
    const horizonMaterial = horizon?.material as THREE.MeshLambertMaterial | undefined;
    expect(horizonMaterial?.customProgramCacheKey()).toBe("horizon-water-cutout-v2");
    expect(horizonMaterial?.depthWrite).toBe(false);
    const horizonShader = {
      uniforms: {},
      vertexShader: "#include <common>\n#include <begin_vertex>",
      fragmentShader: "#include <common>\n#include <color_fragment>",
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    horizonMaterial?.onBeforeCompile(horizonShader, {} as unknown as THREE.WebGLRenderer);
    expect(horizonShader.fragmentShader).toContain("horizonWaterCutoutLevel");
    expect(horizonShader.fragmentShader).toContain("vHorizonSceneHeight");
    expect(horizonShader.fragmentShader).toContain("discard");
    expect(horizonShader.fragmentShader).toContain(TERRAIN_WATER_CUTOUT_LEVEL.toFixed(2));

    // 7x7 near tiles plus 3x3 coarse far tiles: a fixed, inspectable budget.
    expect(renderer.tileCount).toBe(58);
    const nearTerrain = renderer.group.getObjectByName("near-terrain-chunk") as
      | THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
      | undefined;
    expect(nearTerrain?.material.depthFunc).toBe(THREE.LessEqualDepth);
    expect(nearTerrain?.geometry.getAttribute("position").count).toBe(49 * 49);
    const farTerrain = renderer.group.getObjectByName("far-terrain-chunk") as
      | THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
      | undefined;
    expect(farTerrain?.position.y).toBe(0);
    expect(farTerrain?.geometry.getAttribute("position").count).toBe(49 * 49);
    expect(farTerrain?.material.customProgramCacheKey()).toBe(
      "far-terrain-geology-cutout-v7",
    );
    const nearPlaceholderPositions = nearTerrain?.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    const placeholderHeights: number[] = [];
    for (let index = 0; index < nearPlaceholderPositions.count; index += 1) {
      placeholderHeights.push(nearPlaceholderPositions.getY(index));
    }
    expect(Math.max(...placeholderHeights) - Math.min(...placeholderHeights)).toBeGreaterThan(1);
    const shader = {
      uniforms: {},
      vertexShader: "#include <common>\n#include <begin_vertex>",
      fragmentShader:
        "#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>\n#include <clipping_planes_fragment>",
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    farTerrain?.material.onBeforeCompile(shader, {} as unknown as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain("vTerrainScenePosition");
    expect(shader.fragmentShader).toContain("nearTerrainBounds");
    expect(shader.fragmentShader).toContain("discard");
    expect(shader.fragmentShader).toContain("terrainStrata");
    expect(shader.fragmentShader).toContain("terrainBumpX");
    expect(shader.fragmentShader).toContain("terrainMicroTexture");
    expect(shader.fragmentShader).toContain("terrainMicroHighPass");
    expect(shader.fragmentShader).toContain("terrainSurfaceDetailMask");
    expect(shader.fragmentShader).toContain("terrainVegetationMask");
    expect(shader.fragmentShader).toContain("terrainMicroGradient");
    expect(shader.fragmentShader).toContain("terrainRockCoordinates");
    expect(shader.fragmentShader).toContain("terrainScree");
    expect(shader.fragmentShader).toContain("terrainSnowMottle");
    expect(shader.fragmentShader).toContain("terrainSnowRockExposure");
    expect(shader.fragmentShader).toContain("terrainRockDetailFade");
    expect(shader.fragmentShader).toContain(
      "terrainSnowDetailFade = min(terrainPatchFade, terrainRockDetailFade)",
    );
    expect(shader.vertexShader).toContain("vTerrainWorldNormal");
    expect(shader.fragmentShader).toContain("terrainRockTextureX");
    expect(shader.fragmentShader).toContain("terrainProjectionWeight /=");
    expect(shader.fragmentShader).toContain("terrainCrevice");
    expect(shader.fragmentShader).toContain("terrainResolvedRoughness");
    expect(shader.fragmentShader).toContain("terrainRockGradientWorld");
    expect(shader.fragmentShader).toContain("terrainBroadNormalStrength = 1.05");
    expect(shader.fragmentShader).toContain("terrainMicroNormalStrength = 2.15");
    expect(shader.fragmentShader).toContain("terrainRockNormalStrength = 1.9");
    expect(shader.fragmentShader).toContain("terrainWaterCutoutLevel");
    expect(shader.fragmentShader).toContain(
      "vTerrainWorldPosition.y <= terrainWaterCutoutLevel",
    );
    expect(shader.fragmentShader).toContain(TERRAIN_WATER_CUTOUT_LEVEL.toFixed(2));
    expect(shader.uniforms.nearTerrainBounds).toBeDefined();
    expect(shader.uniforms.terrainWorldOrigin).toBeDefined();
    expect(shader.uniforms.terrainDetailMap).toBeDefined();
    expect(
      (shader.uniforms.terrainDetailMap as { value: THREE.DataTexture }).value.anisotropy,
    ).toBe(16);
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
    const rocks = renderer.group.getObjectByName("scattered-rocks") as
      | THREE.InstancedMesh
      | undefined;
    expect(rocks).toBeDefined();
    expect(rocks?.geometry.getAttribute("position").count).toBeGreaterThan(100);
    expect(renderer.group.getObjectByName("procedural-ground-cover")).toBeDefined();
    expect(renderer.group.getObjectByName("instanced-grass-patches")).toBeDefined();
    renderer.dispose();
  });

  it("keeps higher geometric detail within explicit browser budgets", () => {
    expect(terrainVertexResolution("low", "near")).toBe(25);
    expect(terrainVertexResolution("medium", "near")).toBe(49);
    expect(terrainVertexResolution("high", "near")).toBe(65);
    expect(terrainVertexResolution("low", "far")).toBe(25);
    expect(terrainVertexResolution("medium", "far")).toBe(49);
    expect(terrainVertexResolution("high", "far")).toBe(65);

    const mediumNearTriangles = 49 * (49 - 1) ** 2 * 2;
    const mediumFarTriangles = 9 * (49 - 1) ** 2 * 2;
    const highNearTriangles = 49 * (65 - 1) ** 2 * 2;
    const highFarTriangles = 9 * (65 - 1) ** 2 * 2;
    expect(mediumNearTriangles).toBe(225_792);
    expect(mediumFarTriangles).toBe(41_472);
    expect(highNearTriangles).toBeLessThan(402_000);
    expect(highFarTriangles).toBeLessThan(75_000);
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
    expect(water?.geometry.getAttribute("position").count).toBeGreaterThan(1_000);
    expect((water?.geometry.getIndex()?.count ?? 0) / 3).toBeGreaterThan(2_000);
    expect(water?.geometry.boundingSphere?.radius).toBeGreaterThan(40_000);
    expect(water?.frustumCulled).toBe(false);
    expect(water?.renderOrder).toBe(-30);
    expect(water?.position.x).toBe(snapWaterCenter(3_100));
    expect(water?.position.z).toBe(snapWaterCenter(-3_100));
    expect(water?.material.transparent).toBe(false);
    expect(water?.material.depthWrite).toBe(true);
    expect(water?.material.side).toBe(THREE.DoubleSide);
    expect(water?.material.polygonOffset).toBe(false);
    expect(water?.material.roughness).toBeGreaterThanOrEqual(0.1);
    expect(water?.material.roughness).toBeLessThanOrEqual(0.2);
    expect(water?.material.ior).toBeCloseTo(1.333, 3);
    expect(water?.material.clearcoat).toBe(1);
    expect(water?.receiveShadow).toBe(false);
    expect(water?.position.y).toBeGreaterThan(0.1);
    expect(water?.material.customProgramCacheKey()).toBe(
      "stable-water-depth-spectrum-v11",
    );

    const reflectionTexture = new THREE.DataTexture(
      new Uint8Array([92, 136, 164, 255]),
      1,
      1,
      THREE.RGBAFormat,
    );
    reflectionTexture.needsUpdate = true;
    const reflectionMatrix = new THREE.Matrix4().set(
      0.02, 0, 0, 0.5,
      0, 0, 0.02, 0.5,
      0, 0, 1, 0,
      0, 0, 0, 1,
    );
    renderer.setWaterReflection(reflectionTexture, reflectionMatrix, 0.72);

    const shader = {
      uniforms: {},
      vertexShader: "#include <common>\n#include <begin_vertex>",
      fragmentShader:
        "#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>\n#include <clearcoat_normal_fragment_maps>\n#include <opaque_fragment>",
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    water?.material.onBeforeCompile(shader, {} as unknown as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain("waterFresnel");
    expect(shader.fragmentShader).toContain("waterWaveGradient");
    expect(shader.fragmentShader).toContain("waterDomainWarp");
    expect(shader.fragmentShader).toContain("waterSurfaceField");
    expect(shader.fragmentShader).toContain("waterSurfaceDetailMap");
    expect(shader.fragmentShader).toContain("broadSample");
    expect(shader.fragmentShader).toContain("middleSample");
    expect(shader.fragmentShader).toContain("fineSample");
    expect(
      shader.fragmentShader.match(/texture2D\(\s*waterSurfaceDetailMap/g),
    ).toHaveLength(3);
    expect(shader.fragmentShader).toContain("waterRippleEnergy");
    expect(shader.fragmentShader).toContain("broadFade");
    expect(shader.fragmentShader).toContain("middleFade");
    expect(shader.fragmentShader).toContain("fineFade");
    expect(shader.fragmentShader).toContain("waterReflectionRay");
    expect(shader.fragmentShader).toContain("waterAtmosphereField");
    expect(shader.fragmentShader).toContain("waterSunGlint");
    expect(shader.fragmentShader).toContain("waterPlanarReflectionMap");
    expect(shader.fragmentShader).toContain("waterPlanarReflectionMatrix");
    expect(shader.fragmentShader).toContain("waterPlanarBounds");
    expect(shader.fragmentShader).toContain("waterPlanarRoughOffset");
    expect(shader.fragmentShader).toContain("waterPlanarFresnelWeight");
    expect(shader.fragmentShader).toContain("mix(0.024, 0.054, waterPlanarDetailFade)");
    expect(shader.fragmentShader.match(/texture2D\(\s*waterPlanarReflectionMap/g)).toHaveLength(3);
    expect(shader.fragmentShader).toContain("waterBathymetryMap");
    expect(shader.fragmentShader).toContain("waterBathymetryDepth");
    expect(shader.fragmentShader).toContain("waterDepthBodyMix");
    expect(shader.fragmentShader).toContain("waterBathymetryCoverage");
    expect(shader.fragmentShader).toContain("waterForwardTransmittance");
    expect(shader.fragmentShader).toContain("waterShoreSediment");
    expect(shader.fragmentShader).toContain("waterLitBody");
    expect(shader.fragmentShader).toContain("waterSunGlintExponent");
    expect(shader.fragmentShader).toContain("waterSunFresnel");
    expect(shader.fragmentShader).toContain("waterFresnel * mix(0.74, 0.64, waterRippleEnergy)");
    expect(shader.fragmentShader).not.toContain("pow(waterSunAlignment, 420.0)");
    expect(shader.fragmentShader).not.toContain("0.46 + waterFresnel");
    expect(shader.fragmentShader).toContain(
      "outgoingLight = mix(waterLitBody, waterSkyReflection, waterReflectionAmount)",
    );
    expect(shader.fragmentShader).toContain("gl_FragColor.a = 0.0");
    expect(shader.fragmentShader).toContain("uniform vec3 waterSunDirection");
    expect(shader.fragmentShader).toContain("uniform vec3 waterHorizonReflection");
    expect(shader.fragmentShader).toContain("uniform vec3 waterZenithReflection");
    expect(shader.fragmentShader).toContain("uniform vec3 waterSunReflection");
    expect(shader.fragmentShader).not.toContain("WATER_SUN_DIRECTION");
    expect(shader.fragmentShader).toContain("roughnessFactor");
    expect(shader.fragmentShader).toContain("clearcoatNormal = waterNormalView");
    expect(shader.uniforms.waterTime).toBeDefined();
    expect(shader.uniforms.waterWorldOrigin).toBeDefined();
    expect(shader.uniforms.waterSunDirection).toBeDefined();
    expect(shader.uniforms.waterHorizonReflection).toBeDefined();
    expect(shader.uniforms.waterZenithReflection).toBeDefined();
    expect(shader.uniforms.waterSunReflection).toBeDefined();
    expect(shader.uniforms.waterSunGlintStrength).toBeDefined();
    expect(shader.uniforms.waterPlanarReflectionMap).toBeDefined();
    expect(shader.uniforms.waterPlanarReflectionMatrix).toBeDefined();
    expect(shader.uniforms.waterPlanarReflectionStrength).toBeDefined();
    expect(shader.uniforms.waterHybridCompositeStrength).toBeDefined();
    expect(shader.uniforms.waterBathymetryMap).toBeDefined();
    expect(shader.uniforms.waterSurfaceDetailMap).toBeDefined();
    expect(shader.uniforms.waterBathymetryBounds).toBeDefined();
    expect(shader.uniforms.waterBathymetryMaxDepth).toBeDefined();
    expect(shader.uniforms.waterBathymetryTexel).toBeDefined();
    expect(shader.uniforms.waterBathymetryValid).toBeDefined();
    expect(renderer.waterBathymetry.isValid()).toBe(true);
    expect(renderer.waterBathymetry.getRevision()).toBeGreaterThan(0);
    expect(renderer.waterBathymetry.resolution).toBe(192);
    expect(renderer.waterBathymetry.surfaceDetailTexture?.name).toBe(
      "deterministic-terrain-detail",
    );

    const planarMap = shader.uniforms.waterPlanarReflectionMap as THREE.IUniform<THREE.Texture | null>;
    const planarMatrix = shader.uniforms.waterPlanarReflectionMatrix as THREE.IUniform<THREE.Matrix4>;
    const planarStrength = shader.uniforms.waterPlanarReflectionStrength as THREE.IUniform<number>;
    const hybridCompositeStrength = shader.uniforms.waterHybridCompositeStrength as
      THREE.IUniform<number>;
    expect(planarMap.value).toBe(reflectionTexture);
    expect(planarMatrix.value.toArray()).toEqual(reflectionMatrix.toArray());
    expect(planarStrength.value).toBeCloseTo(0.72, 8);
    expect(hybridCompositeStrength.value).toBe(0);
    renderer.setHybridWaterCompositeActive(true);
    expect(hybridCompositeStrength.value).toBe(1);
    renderer.setHybridWaterCompositeActive(false);
    expect(hybridCompositeStrength.value).toBe(0);
    expect(renderer.waterSurface).toBe(water);
    let visibleDuringReflection = true;
    renderer.withWaterSurfaceHidden(() => {
      visibleDuringReflection = renderer.waterSurface.visible;
    });
    expect(visibleDuringReflection).toBe(false);
    expect(renderer.waterSurface.visible).toBe(true);
    expect(() =>
      renderer.withWaterSurfaceHidden(() => {
        throw new Error("reflection render failed");
      }),
    ).toThrow("reflection render failed");
    expect(renderer.waterSurface.visible).toBe(true);
    renderer.setWaterReflection(null);
    expect(planarMap.value).toBeNull();
    expect(planarStrength.value).toBe(0);

    const sunDirection = shader.uniforms.waterSunDirection as THREE.IUniform<THREE.Vector3>;
    const horizonReflection = shader.uniforms.waterHorizonReflection as THREE.IUniform<THREE.Color>;
    const zenithReflection = shader.uniforms.waterZenithReflection as THREE.IUniform<THREE.Color>;
    const glintStrength = shader.uniforms.waterSunGlintStrength as THREE.IUniform<number>;
    const dayDirection = sunDirection.value.clone();
    const dayHorizon = horizonReflection.value.toArray();
    const dayZenith = zenithReflection.value.toArray();
    renderer.setAtmosphere("dawn", "cloudy");
    expect(sunDirection.value.length()).toBeCloseTo(1, 8);
    expect(sunDirection.value.distanceTo(dayDirection)).toBeGreaterThan(0.2);
    expect(horizonReflection.value.toArray()).not.toEqual(dayHorizon);
    expect(zenithReflection.value.toArray()).not.toEqual(dayZenith);
    expect(glintStrength.value).toBeCloseTo(0.26, 8);
    const dawnHorizon = horizonReflection.value.toArray();
    renderer.setAtmosphere("golden", "clear");
    expect(horizonReflection.value.toArray()).not.toEqual(dawnHorizon);
    expect(glintStrength.value).toBeCloseTo(1.08, 8);
    renderer.dispose();
    reflectionTexture.dispose();
  });

  it("removes every terrain fragment that could overlap the opaque water plane", () => {
    expect(TERRAIN_WATER_CUTOUT_LEVEL).toBeGreaterThan(WATER_RENDER_LEVEL);
    expect(TERRAIN_WATER_CUTOUT_LEVEL - WATER_RENDER_LEVEL).toBeCloseTo(0.01, 8);
    expect(TERRAIN_WATER_CUTOUT_LEVEL - WATER_RENDER_LEVEL).toBeLessThan(0.025);
  });

  it("builds a bounded concentric water grid with dense camera-local rings", () => {
    const geometry = createConcentricWaterGeometry();
    const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
    expect(positions.count).toBe(1 + 10 * 128);
    expect(geometry.getIndex()?.count).toBe((128 + 9 * 128 * 2) * 3);
    expect(positions.getX(0)).toBe(0);
    expect(positions.getZ(0)).toBe(0);
    expect(Math.hypot(positions.getX(1), positions.getZ(1))).toBeCloseTo(96, 4);
    expect(geometry.boundingSphere?.radius).toBeCloseTo(42_000, -1);
    geometry.dispose();
  });

  it("keeps the visible runway aligned to collision elevation", () => {
    const seed = 812_893;
    const world = createWorld(seed, { airport: false });
    const airport = {
      centerX: 740,
      centerZ: -420,
      elevation: 86,
      headingRadians: 0.72,
      runwayLength: 1_260,
      runwayWidth: 46,
    };
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
    expect((surface?.material as THREE.MeshStandardMaterial).depthFunc).toBe(
      THREE.LessEqualDepth,
    );
    expect(surface?.renderOrder).toBeLessThan(0);
    expect(renderer.group.getObjectByName("runway-markings")).toBeDefined();
    expect(renderer.group.getObjectByName("runway-lights")).toBeDefined();
    for (const name of [
      "runway-surface",
      "runway-shoulder",
      "runway-markings",
      "airport-apron",
      "airport-taxiway",
    ]) {
      const mesh = renderer.group.getObjectByName(name) as THREE.Mesh | undefined;
      const material = mesh?.material as THREE.Material | undefined;
      expect(material?.depthFunc, name).toBe(THREE.LessEqualDepth);
      expect(material?.polygonOffset, name).toBe(true);
      expect(Math.abs(material?.polygonOffsetFactor ?? 99), name).toBeLessThanOrEqual(3);
      expect(Math.abs(material?.polygonOffsetUnits ?? 99), name).toBeLessThanOrEqual(3);
    }
    renderer.dispose();
  });

  it("does not synthesize airport geometry when the world has no runway", () => {
    const seed = 91_277;
    const world = createWorld(seed, { airport: false });
    const renderer = new TerrainRenderer(
      (x, z) => sampleTerrain(world, x, z),
      seed,
      1_600,
      "low",
      undefined,
    );

    for (const name of [
      "runway-surface",
      "runway-shoulder",
      "runway-markings",
      "runway-lights",
      "airport-apron",
      "airport-taxiway",
      "airport-hangars",
    ]) {
      expect(renderer.group.getObjectByName(name), name).toBeUndefined();
    }
    renderer.dispose();
  });

  it("atomically reveals a complete quality grid and invalidates shadow registration", () => {
    const seed = 44_909;
    const world = createWorld(seed);
    const renderer = new TerrainRenderer(
      (x, z) => sampleTerrain(world, x, z),
      seed,
      1_600,
      "low",
      world.airport ?? undefined,
    );
    type ChunkProbe = {
      mesh: THREE.Mesh;
      ready: boolean;
      vertexResolution: number;
    };
    type RendererProbe = {
      chunks: Map<string, ChunkProbe>;
      retiredChunks: Map<string, ChunkProbe>;
      finishQualityTransitionWhenReady: () => void;
    };
    const probe = renderer as unknown as RendererProbe;

    renderer.update(0, 0, 0, 0);
    expect([...probe.chunks.values()]).toHaveLength(34);
    expect([...probe.chunks.values()].every((chunk) => chunk.mesh.visible)).toBe(true);

    renderer.setQuality("medium");
    renderer.update(0, 0, 0, 0);
    const staged = [...probe.chunks.values()];
    const retired = [...probe.retiredChunks.values()];
    expect(staged).toHaveLength(58);
    expect(staged.every((chunk) => chunk.vertexResolution === 49)).toBe(true);
    expect(staged.every((chunk) => !chunk.mesh.visible)).toBe(true);
    expect(retired).toHaveLength(34);
    expect(retired.every((chunk) => chunk.mesh.visible)).toBe(true);

    for (const chunk of staged.slice(0, -1)) chunk.ready = true;
    probe.finishQualityTransitionWhenReady();
    expect(staged.every((chunk) => !chunk.mesh.visible)).toBe(true);
    expect([...probe.retiredChunks.values()].every((chunk) => chunk.mesh.visible)).toBe(true);

    const revisionBeforeReveal = renderer.sceneRevision;
    staged.at(-1)!.ready = true;
    probe.finishQualityTransitionWhenReady();
    expect(probe.retiredChunks.size).toBe(0);
    expect(staged.every((chunk) => chunk.mesh.visible)).toBe(true);
    expect(renderer.sceneRevision).toBeGreaterThan(revisionBeforeReveal);
    renderer.dispose();
  });

  it("keeps vegetation out of the runway and complete service area", () => {
    const airport = createWorld(921_441, {
      airport: { centerX: 0, centerZ: 0, elevation: 48, headingRadians: 0.73 },
    }).airport!;
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
