import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import {
  CLOUD_SHADOW_PBR_FRAGMENT_GLSL,
  CLOUD_SHADOW_PBR_FRAGMENT_WGSL,
  CloudShadowMaterialPlugin,
} from "../src/render/webgpu/clouds/CloudShadowMaterialPlugin";
import {
  CLOUD_SHADOW_RECEIVER_WGSL,
  isCloudShadowUvInside,
  projectCloudShadowUv,
  resolveCloudShadowReceiverBinding,
  type CloudShadowProjection,
} from "../src/render/webgpu/clouds/CloudShadowReceiver";
import {
  CloudShadowReceiverRegistry,
  isOpaqueCloudShadowPbrReceiver,
} from "../src/render/webgpu/clouds/CloudShadowReceiverRegistry";
import { AirportSystem } from "../src/render/webgpu/detail/AirportSystem";
import { WorldDetailRuntime } from "../src/render/webgpu/detail/WorldDetailRuntime";
import { WildlifeSystem } from "../src/render/webgpu/wildlife/WildlifeSystem";
import { HYDROLOGY_WATER_FRAGMENT_WGSL } from "../src/render/webgpu/water/HydrologySystem";
import { WATER_FRAGMENT_WGSL } from "../src/render/webgpu/water/SpectralOceanSystem";
import { TerrainBiome } from "../src/world";

const UNUSED_TEXTURE = {} as BaseTexture;

function projection(overrides: Partial<CloudShadowProjection> = {}): CloudShadowProjection {
  return {
    texture: UNUSED_TEXTURE,
    centerX: 12_000,
    centerZ: -8_000,
    worldSizeMeters: 10_000,
    referenceAltitudeMeters: 100,
    sunDirectionX: 3,
    sunDirectionY: 4,
    sunDirectionZ: 0,
    valid: true,
    ...overrides,
  };
}

describe("cloud-shadow receiver projection", () => {
  it("normalizes sunlight and converts the absolute map center to floating-origin space", () => {
    const binding = resolveCloudShadowReceiverBinding(projection(), 10_000, -10_000);
    expect(binding).toMatchObject({
      centerLocalX: 2_000,
      centerLocalZ: 2_000,
      worldSizeMeters: 10_000,
      referenceAltitudeMeters: 100,
      sunDirectionZ: 0,
      strength: 1,
      valid: true,
    });
    expect(binding.sunDirectionX).toBeCloseTo(0.6, 12);
    expect(binding.sunDirectionY).toBeCloseTo(0.8, 12);
  });

  it("projects elevated receivers back to the reference plane along inverse sunlight", () => {
    const binding = resolveCloudShadowReceiverBinding(projection(), 10_000, -10_000);
    expect(projectCloudShadowUv(2_000, 100, 2_000, binding)).toEqual({ u: 0.5, v: 0.5 });
    // 800 m above the plane with a normalized (0.6, 0.8, 0) sun moves
    // the reference-plane lookup 600 m toward -x, or 0.06 map UV.
    const elevated = projectCloudShadowUv(2_000, 900, 2_000, binding);
    expect(elevated?.u).toBeCloseTo(0.44, 8);
    expect(elevated?.v).toBeCloseTo(0.5, 8);
    expect(elevated && isCloudShadowUvInside(elevated)).toBe(true);
  });

  it("is invariant across a floating-origin rebase and rejects unsafe projections", () => {
    const first = resolveCloudShadowReceiverBinding(projection(), 10_000, -10_000);
    const rebased = resolveCloudShadowReceiverBinding(projection(), 11_500, -9_250);
    const firstUv = projectCloudShadowUv(2_300, 500, 1_700, first);
    const rebasedUv = projectCloudShadowUv(800, 500, 950, rebased);
    expect(rebasedUv).toEqual(firstUv);

    const belowHorizon = resolveCloudShadowReceiverBinding(
      projection({ sunDirectionY: -0.01 }),
      0,
      0,
    );
    expect(belowHorizon.valid).toBe(false);
    expect(projectCloudShadowUv(0, 0, 0, belowHorizon)).toBeNull();
    expect(() => resolveCloudShadowReceiverBinding(
      projection({ worldSizeMeters: 0 }),
      0,
      0,
    )).toThrow(/worldSizeMeters/);
  });
});

describe("cloud-shadow receiver WGSL", () => {
  it("uses receiver height in terrain/water-compatible projection code", () => {
    expect(CLOUD_SHADOW_RECEIVER_WGSL).toContain(
      "localWorldPosition.y - uniforms.cloudShadowReferenceAltitude",
    );
    expect(CLOUD_SHADOW_RECEIVER_WGSL).toContain(
      "uniforms.cloudShadowSunDirection.xz * inverseSunHeight",
    );
    expect(CLOUD_SHADOW_RECEIVER_WGSL).toContain("textureSampleLevel");
  });

  it("attenuates ocean and hydrology direct sunlight without darkening sky reflection", () => {
    for (const shader of [WATER_FRAGMENT_WGSL, HYDROLOGY_WATER_FRAGMENT_WGSL]) {
      expect(shader).toContain("sampleCloudShadowReceiver(input.worldPosition)");
      expect(shader).toMatch(/cloudShadow\s*\*\s*sunShadow|\*\s*cloudShadow/u);
      expect(shader).toContain("reflectedSky");
    }
    expect(WATER_FRAGMENT_WGSL).not.toContain("reflected * cloudShadow");
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).not.toContain("reflection * cloudShadow");
  });
});

describe("opaque PBR cloud-shadow registry", () => {
  it("covers shared airport, vegetation, and wildlife materials", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const registry = new CloudShadowReceiverRegistry();
    const airport = new AirportSystem(scene, {
      centerX: 0,
      centerZ: 0,
      elevation: 80,
      headingRadians: 0,
      runwayLength: 1_320,
      runwayWidth: 34,
      endSafetyArea: 120,
      shoulderWidth: 14,
      terrainBlendDistance: 220,
    }, () => 80, 1_234);
    const detail = new WorldDetailRuntime(scene, {
      worldSeed: "cloud-shadow-detail",
      terrainSample: () => ({
        height: 80,
        slope: 0.04,
        moisture: 0.7,
        biome: TerrainBiome.FOREST,
      }),
    });
    const wildlife = new WildlifeSystem(scene, {
      worldSeed: "cloud-shadow-wildlife",
      terrainSample: () => ({
        height: 80,
        slope: 0.04,
        biome: TerrainBiome.FOREST,
      }),
    });

    registry.registerMeshes(airport.root.getChildMeshes(false));
    detail.addPbrMaterials((material) => registry.registerMaterial(material));
    wildlife.addPbrMaterials((material) => registry.registerMaterial(material));
    // Building materials left with 1B-5's village deletion.
    for (const materialName of [
      // `7-10` replaced the local `hangar-metal` stand-in with `7-11`'s shared
      // airfield set, so the hangars now wear `airfield-metal` and
      // `airfield-concrete`. Both are listed: the property under test is that
      // an AIRPORT material reaches this registry, and checking only one of the
      // two surfaces would leave the other able to lose cloud shadows silently.
      "airfield-metal",
      "airfield-concrete",
      "detail-foliage-pine",
      // 2-12: per-species bark materials replaced the shared trunk.
      "detail-bark-pine",
      "wildlife-deer",
    ]) {
      expect(
        scene.getMaterialByName(materialName)?.pluginManager?.getPlugin(
          "cloud-shadow-receiver",
        ),
        materialName,
      ).toBeInstanceOf(CloudShadowMaterialPlugin);
    }

    registry.dispose();
    wildlife.dispose();
    detail.dispose();
    airport.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("shadows opaque aircraft parts but not real canopy or navigation-light materials", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    const aircraft = createWebGpuAircraft(scene, "trainer");
    const registry = new CloudShadowReceiverRegistry();
    expect(registry.registerMeshes(aircraft.meshes)).toBeGreaterThan(0);

    const body = scene.getMaterialByName("trainer-body");
    const glass = scene.getMaterialByName("trainer-glass");
    const portLamp = scene.getMaterialByName("trainer-port-lamp");
    expect(body?.pluginManager?.getPlugin("cloud-shadow-receiver")).toBeInstanceOf(
      CloudShadowMaterialPlugin,
    );
    expect(glass?.pluginManager?.getPlugin("cloud-shadow-receiver")).toBeFalsy();
    expect(portLamp?.pluginManager?.getPlugin("cloud-shadow-receiver")).toBeFalsy();

    registry.dispose();
    aircraft.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("registers each opaque lit material once and excludes glass, unlit, and emission", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const opaque = new PBRMaterial("opaque-airframe", scene);
    const glass = new PBRMaterial("cockpit-glass", scene);
    glass.alpha = 0.82;
    glass.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    const lamp = new PBRMaterial("navigation-lamp", scene);
    lamp.emissiveColor = new Color3(1, 0.1, 0.02);
    lamp.emissiveIntensity = 3;
    const unlit = new PBRMaterial("unlit-marker", scene);
    unlit.unlit = true;

    expect(isOpaqueCloudShadowPbrReceiver(opaque)).toBe(true);
    expect(isOpaqueCloudShadowPbrReceiver(glass)).toBe(false);
    expect(isOpaqueCloudShadowPbrReceiver(lamp)).toBe(false);
    expect(isOpaqueCloudShadowPbrReceiver(unlit)).toBe(false);

    const registry = new CloudShadowReceiverRegistry();
    expect(registry.registerMaterials([opaque, glass, lamp, unlit])).toBe(1);
    expect(registry.registerMaterial(opaque)).toBe(false);
    expect(registry.registeredMaterialCount).toBe(1);
    expect(opaque.pluginManager?.getPlugin("cloud-shadow-receiver")).toBeInstanceOf(
      CloudShadowMaterialPlugin,
    );
    expect(glass.pluginManager?.getPlugin("cloud-shadow-receiver")).toBeFalsy();
    expect(lamp.pluginManager?.getPlugin("cloud-shadow-receiver")).toBeFalsy();
    expect(unlit.pluginManager?.getPlugin("cloud-shadow-receiver")).toBeFalsy();

    registry.dispose();
    opaque.dispose(false, false);
    glass.dispose(false, false);
    lamp.dispose(false, false);
    unlit.dispose(false, false);
    scene.dispose();
    engine.dispose();
  });

  it("shares one floating-origin binding and releases disposed material references", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const first = new PBRMaterial("tree-foliage", scene);
    const second = new PBRMaterial("village-wall", scene);
    const registry = new CloudShadowReceiverRegistry();
    registry.registerMaterials([first, second]);

    const cloudProjection = projection();
    registry.setProjection(cloudProjection, 10_000, -10_000);
    expect(registry.currentBinding).toMatchObject({
      centerLocalX: 2_000,
      centerLocalZ: 2_000,
      valid: true,
    });

    const firstPlugin = first.pluginManager?.getPlugin<CloudShadowMaterialPlugin>(
      "cloud-shadow-receiver",
    );
    const secondPlugin = second.pluginManager?.getPlugin<CloudShadowMaterialPlugin>(
      "cloud-shadow-receiver",
    );
    const firstTextures: BaseTexture[] = [];
    const secondTextures: BaseTexture[] = [];
    firstPlugin?.getActiveTextures(firstTextures);
    secondPlugin?.getActiveTextures(secondTextures);
    expect(firstTextures).toEqual([UNUSED_TEXTURE]);
    expect(secondTextures).toEqual([UNUSED_TEXTURE]);

    first.dispose(false, false);
    expect(registry.registeredMaterialCount).toBe(1);
    registry.dispose();
    const releasedTextures: BaseTexture[] = [];
    secondPlugin?.getActiveTextures(releasedTextures);
    expect(releasedTextures).toEqual([]);
    expect(registry.registeredMaterialCount).toBe(0);

    second.dispose(false, false);
    scene.dispose();
    engine.dispose();
  });

  it("publishes matching height-aware WGSL and GLSL PBR injection", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const material = new PBRMaterial("pbr-injection", scene);
    const plugin = new CloudShadowMaterialPlugin(material);

    expect(plugin.getCustomCode("fragment", ShaderLanguage.WGSL)).toBe(
      CLOUD_SHADOW_PBR_FRAGMENT_WGSL,
    );
    expect(plugin.getCustomCode("fragment", ShaderLanguage.GLSL)).toBe(
      CLOUD_SHADOW_PBR_FRAGMENT_GLSL,
    );
    for (const code of [
      CLOUD_SHADOW_PBR_FRAGMENT_WGSL.CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION,
      CLOUD_SHADOW_PBR_FRAGMENT_GLSL.CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION,
    ]) {
      expect(code).toContain("sampleCloudShadowReceiver");
      expect(code).toContain("finalDiffuse *= aerolithCloudShadow");
      expect(code).toContain("#ifndef UNLIT");
      expect(code).not.toContain("finalEmissive");
    }

    material.dispose(false, false);
    scene.dispose();
    engine.dispose();
  });
});
