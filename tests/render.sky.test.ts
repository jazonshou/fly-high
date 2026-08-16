import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { SkySystem } from "../src/render/SkySystem";

describe("sky lighting and cloud presentation", () => {
  it("builds a stationary multiscale atmosphere with layered aerosol haze", () => {
    const sky = new SkySystem(11);
    const dome = sky.group.getObjectByName("procedural-atmosphere-dome") as
      | THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>
      | undefined;
    expect(dome).toBeDefined();
    expect(dome?.material.fragmentShader).toContain("atmosphericNoise");
    expect(dome?.material.fragmentShader).toContain("lowAerosolBand");
    expect(dome?.material.fragmentShader).toContain("upperAerosolBand");
    expect(dome?.material.fragmentShader).toContain("directionalHaze");
    expect(dome?.material.fragmentShader).toContain(
      "vec3 skyDirection = normalize(vWorldDirection)",
    );
    expect(dome?.material.fragmentShader).toContain("dot(skyDirection, sunDirection)");
    expect(dome?.material.fragmentShader).not.toContain("uniform float time");

    sky.setAtmosphere("dawn", "cloudy");
    expect(dome?.material.uniforms.hazeAmount?.value).toBeCloseTo(0.68, 6);
    expect(dome?.material.uniforms.atmosphericVariance?.value).toBeCloseTo(0.34, 6);
    expect(dome?.material.uniforms.hazeBandColor?.value).toBeInstanceOf(THREE.Color);
    sky.dispose();
  });

  it("uses three deterministic cloud families with distinct textures and silhouettes", () => {
    const sky = new SkySystem(29);
    const families = ["cumulus", "stratus", "towering"].map((family) =>
      sky.group.getObjectByName(`cloud-family-${family}`) as
        | THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
        | undefined,
    );
    expect(families.every(Boolean)).toBe(true);
    expect(sky.group.children.filter((child) => child instanceof THREE.InstancedMesh)).toHaveLength(3);
    const textures = families.map((family) => family?.material.map?.name);
    expect(new Set(textures).size).toBe(3);
    const textureData = (families[0]?.material.map as THREE.DataTexture).image.data as Uint8Array;
    const alphaValues = new Set<number>();
    for (let offset = 3; offset < textureData.length; offset += 4) {
      alphaValues.add(textureData[offset]!);
    }
    expect(alphaValues.size).toBeGreaterThan(24);
    for (const family of families) {
      const texture = family?.material.map as THREE.DataTexture;
      const data = texture.image.data as Uint8Array;
      const size = texture.image.width as number;
      for (let coordinate = 0; coordinate < size; coordinate += 1) {
        expect(data[(coordinate * 4) + 3]).toBe(0);
        expect(data[((size - 1) * size + coordinate) * 4 + 3]).toBe(0);
        expect(data[(coordinate * size) * 4 + 3]).toBe(0);
        expect(data[(coordinate * size + size - 1) * 4 + 3]).toBe(0);
      }
    }

    const sizes = families.map((family) => {
      family?.geometry.computeBoundingBox();
      return family?.geometry.boundingBox?.getSize(new THREE.Vector3());
    });
    expect(sizes[1]!.x / sizes[1]!.y).toBeGreaterThan(sizes[0]!.x / sizes[0]!.y);
    expect(sizes[2]!.x / sizes[2]!.y).toBeGreaterThan(1.2);
    expect(sizes[2]!.x / sizes[2]!.y).toBeLessThan(sizes[1]!.x / sizes[1]!.y);

    for (const family of families) {
      expect(family?.material.transparent).toBe(true);
      expect(family?.material.depthWrite).toBe(false);
      expect(family?.material.premultipliedAlpha).toBe(true);
      expect(family?.material.blending).toBe(THREE.CustomBlending);
      expect(family?.material.blendEquation).toBe(THREE.AddEquation);
      expect(family?.material.blendSrc).toBe(THREE.OneFactor);
      expect(family?.material.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
      expect(family?.material.blendEquationAlpha).toBe(THREE.AddEquation);
      expect(family?.material.blendSrcAlpha).toBe(THREE.ZeroFactor);
      expect(family?.material.blendDstAlpha).toBe(THREE.OneFactor);
      expect(family?.material.opacity).toBeGreaterThan(0.18);
      expect(family?.material.opacity).toBeLessThan(0.8);
      expect(family?.material.alphaTest).toBe(0);
      expect(family?.material.alphaToCoverage).toBe(false);
      expect(family?.material.forceSinglePass).toBe(true);
      expect(family?.material.side).toBe(THREE.FrontSide);
      expect(family?.geometry.name).toContain("camera-facing-cloud-impostor");
      expect(family?.geometry.userData.cloudCarrier).toBe("camera-facing-soft-impostor");
      // One indexed quad per instance makes card intersections, vertical
      // slices, and exposed carrier edges geometrically impossible.
      expect(family?.geometry.index?.count).toBe(6);
      expect(family?.geometry.getAttribute("position").count).toBe(4);
      expect(family?.geometry.userData.cloudLobeCount).toBeGreaterThanOrEqual(7);
      const positions = family?.geometry.getAttribute("position") as THREE.BufferAttribute;
      expect(
        Array.from({ length: positions.count }, (_, index) => positions.getZ(index)),
      ).toEqual([0, 0, 0, 0]);
      const density = family?.geometry.getAttribute("cloudDensity") as
        | THREE.InstancedBufferAttribute
        | undefined;
      expect(density).toBeDefined();
      const densityValues = Array.from(
        density?.array.subarray(0, family?.instanceMatrix.count ?? 0) ?? [],
      );
      expect(Math.max(...densityValues) - Math.min(...densityValues)).toBeGreaterThan(0.3);
    }

    const cloudShader = {
      uniforms: {},
      vertexShader: "#include <common>\n#include <begin_vertex>\n#include <project_vertex>",
      fragmentShader:
        "#include <common>\n#include <color_fragment>\n#include <emissivemap_fragment>",
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    families[0]?.material.onBeforeCompile(cloudShader, {} as unknown as THREE.WebGLRenderer);
    // Reapplying the callback models a composed renderer hook and must not
    // redeclare the custom instanced attribute.
    families[0]?.material.onBeforeCompile(cloudShader, {} as unknown as THREE.WebGLRenderer);
    expect(cloudShader.vertexShader).toContain("attribute float cloudDensity");
    expect(cloudShader.vertexShader.match(/attribute float cloudDensity/g)).toHaveLength(1);
    expect(cloudShader.vertexShader).toContain("vCloudLocalPosition = position");
    expect(cloudShader.vertexShader).toContain("cloudInstanceCenter");
    expect(cloudShader.vertexShader).toContain("cloudCenterView");
    expect(cloudShader.vertexShader).toContain("cloudRightView");
    expect(cloudShader.vertexShader).toContain("cloudUpView");
    expect(cloudShader.vertexShader).toContain("cloudHorizonStability");
    expect(cloudShader.vertexShader).toContain("cloudHorizonBlend");
    expect(cloudShader.vertexShader).toContain("cloudCameraRightProjected");
    expect(cloudShader.vertexShader).not.toContain("abs(dot(cloudReferenceUp");
    expect(cloudShader.vertexShader).toContain("cloudCarrierRadius");
    expect(cloudShader.vertexShader).toContain("cloudNearPlaneClearance");
    expect(cloudShader.vertexShader).toContain("cloudViewDepthExtent");
    expect(cloudShader.vertexShader).toContain("vCloudProximityFade");
    expect(cloudShader.vertexShader).toContain("cloudClipGuard");
    expect(cloudShader.vertexShader).toContain("vec4(2.0, 2.0, 2.0, 1.0)");
    expect(cloudShader.vertexShader).toContain("vNormal = cloudWorldUpView");
    expect(cloudShader.vertexShader).not.toContain("#include <project_vertex>");
    expect(cloudShader.fragmentShader).toContain("cloudSurfaceDetail = sampledDiffuseColor");
    expect(cloudShader.fragmentShader).toContain("cloudSurfaceDetail.a <= 0.0005");
    expect(cloudShader.fragmentShader).toContain("cloudSilhouetteEdge");
    expect(cloudShader.fragmentShader).toContain("cloudVolumeField");
    expect(cloudShader.fragmentShader).toContain("cloudVolumeVariation");
    expect(cloudShader.fragmentShader).toContain("cloudWispyVariation");
    expect(cloudShader.fragmentShader).toContain("cloudNearTranslucency");
    expect(cloudShader.fragmentShader).toContain("cloudSoftCoverage");
    expect(cloudShader.fragmentShader).toContain("fwidth(cloudSurfaceDetail.a)");
    expect(cloudShader.fragmentShader).toContain("cloudCoolWhiteMottle");
    expect(cloudShader.fragmentShader).toContain("cloudInteriorErosion");
    expect(cloudShader.fragmentShader).toContain("diffuseColor.a *= vCloudDensity");
    expect(cloudShader.fragmentShader).toContain("totalEmissiveRadiance += mix");
    expect(cloudShader.fragmentShader.match(/#include <emissivemap_fragment>/g)).toHaveLength(1);
    expect(cloudShader.fragmentShader).not.toContain("cloudViewFacing");
    expect(cloudShader.fragmentShader).not.toContain("cloudSoftEdge");
    expect(cloudShader.fragmentShader).not.toContain("vCloudObjectNormal");
    expect(families[0]?.material.customProgramCacheKey()).toBe(
      "cloud-camera-impostor-cumulus-v8",
    );

    const twin = new SkySystem(29);
    const cameraPosition = new THREE.Vector3(320, 840, -190);
    sky.update(cameraPosition, 0, 0, 0);
    twin.update(cameraPosition, 0, 0, 0);
    const firstMatrix = new THREE.Matrix4();
    const twinMatrix = new THREE.Matrix4();
    for (const familyName of ["cumulus", "stratus", "towering"]) {
      const original = sky.group.getObjectByName(`cloud-family-${familyName}`) as THREE.InstancedMesh;
      const duplicate = twin.group.getObjectByName(`cloud-family-${familyName}`) as THREE.InstancedMesh;
      original.getMatrixAt(0, firstMatrix);
      duplicate.getMatrixAt(0, twinMatrix);
      expect(twinMatrix.toArray()).toEqual(firstMatrix.toArray());
      const originalData = ((original.material as THREE.MeshStandardMaterial).map as THREE.DataTexture)
        .image.data as Uint8Array;
      const duplicateData = ((duplicate.material as THREE.MeshStandardMaterial).map as THREE.DataTexture)
        .image.data as Uint8Array;
      for (let offset = 0; offset < originalData.length; offset += 257) {
        expect(duplicateData[offset]).toBe(originalData[offset]);
      }
    }
    twin.dispose();

    // The previous carriers could exceed 3.5 km and intersect the camera as
    // giant strips. All active impostors now stay within a compact footprint;
    // close fly-through is represented by shader dissolve rather than a card.
    const cloudScale = new THREE.Vector3();
    const cloudRotation = new THREE.Quaternion();
    const cloudPosition = new THREE.Vector3();
    const physicalWidths: number[] = [];
    const physicalHeights: number[] = [];
    for (const family of families) {
      const geometrySize = family?.geometry.boundingBox?.getSize(new THREE.Vector3());
      if (!family || !geometrySize) continue;
      for (let index = 0; index < family.count; index += 1) {
        family.getMatrixAt(index, firstMatrix);
        firstMatrix.decompose(cloudPosition, cloudRotation, cloudScale);
        physicalWidths.push(geometrySize.x * cloudScale.x);
        physicalHeights.push(geometrySize.y * cloudScale.y);
      }
    }
    expect(Math.max(...physicalWidths)).toBeLessThan(1_400);
    expect(Math.max(...physicalHeights)).toBeLessThan(1_100);

    sky.setAtmosphere("day", "clear");
    const clearCount = families.reduce((sum, family) => sum + (family?.count ?? 0), 0);
    sky.setAtmosphere("day", "cloudy");
    const cloudyCount = families.reduce((sum, family) => sum + (family?.count ?? 0), 0);
    expect(cloudyCount).toBeGreaterThan(clearCount);
    sky.dispose();
  });

  it("enables supported, quality-scaled shadows for the default medium preset", () => {
    const sky = new SkySystem(17);
    sky.setQuality("medium");
    expect(sky.sunLight.castShadow).toBe(true);
    expect(sky.sunLight.shadow.mapSize.x).toBe(1_024);

    sky.setQuality("high");
    expect(sky.sunLight.castShadow).toBe(true);
    expect(sky.sunLight.shadow.mapSize.x).toBe(2_048);

    sky.setQuality("low");
    expect(sky.sunLight.castShadow).toBe(false);
    sky.dispose();
  });

  it("keeps clouds at a world altitude instead of attaching them to the camera", () => {
    const sky = new SkySystem(23);
    const cloudFamilies = sky.group.children.filter(
      (child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh,
    );
    expect(cloudFamilies).toHaveLength(3);
    const matrix = new THREE.Matrix4();
    const firstAltitudes: number[] = [];
    const secondAltitudes: number[] = [];

    sky.update(new THREE.Vector3(0, 700, 0), 0, 0, 0);
    for (let index = 0; index < cloudFamilies[0]!.count; index += 1) {
      cloudFamilies[0]!.getMatrixAt(index, matrix);
      firstAltitudes.push(new THREE.Vector3().setFromMatrixPosition(matrix).y);
    }
    sky.update(new THREE.Vector3(0, 5_700, 0), 0, 0, 0);
    for (let index = 0; index < cloudFamilies[0]!.count; index += 1) {
      cloudFamilies[0]!.getMatrixAt(index, matrix);
      secondAltitudes.push(new THREE.Vector3().setFromMatrixPosition(matrix).y);
    }

    expect(secondAltitudes.sort((a, b) => a - b)).toEqual(firstAltitudes.sort((a, b) => a - b));
    const altitudes: number[] = [];
    for (const family of cloudFamilies) {
      for (let index = 0; index < family.count; index += 1) {
        family.getMatrixAt(index, matrix);
        altitudes.push(new THREE.Vector3().setFromMatrixPosition(matrix).y);
      }
    }
    expect(Math.min(...altitudes)).toBeGreaterThanOrEqual(1_200);
    expect(Math.max(...altitudes)).toBeLessThanOrEqual(4_200);
    expect(Math.max(...altitudes) - Math.min(...altitudes)).toBeGreaterThan(1_200);
    const familyAltitudes = new Map<string, number[]>();
    for (const family of cloudFamilies) {
      const values: number[] = [];
      for (let index = 0; index < family.count; index += 1) {
        family.getMatrixAt(index, matrix);
        values.push(new THREE.Vector3().setFromMatrixPosition(matrix).y);
      }
      familyAltitudes.set(family.name, values);
    }
    expect(Math.max(...familyAltitudes.get("cloud-family-stratus")!)).toBeLessThanOrEqual(2_400);
    expect(Math.min(...familyAltitudes.get("cloud-family-cumulus")!)).toBeGreaterThanOrEqual(2_300);
    expect(Math.max(...familyAltitudes.get("cloud-family-towering")!)).toBeLessThanOrEqual(3_200);
    sky.dispose();
  });
});
