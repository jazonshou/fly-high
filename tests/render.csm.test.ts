import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  CascadedShadowController,
  DEFAULT_CSM_LAYER,
  cascadedShadowBudget,
  isCascadedShadowMaterial,
} from "../src/render/CascadedShadowController";

interface CsmFixture {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
}

function createFixture(): CsmFixture {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.2, 16_000);
  camera.position.set(160, 720, -380);
  camera.lookAt(1_800, 420, 0);
  camera.updateMatrixWorld();
  const sun = new THREE.DirectionalLight(0xffd7a2, 2.3);
  sun.position.set(4_300, 5_900, -7_800);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  scene.add(sun, sun.target);
  return { scene, camera, sun };
}

function addMesh(
  scene: THREE.Scene,
  name: string,
  material: THREE.Material,
  castShadow: boolean,
  receiveShadow: boolean,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  scene.add(mesh);
  return mesh;
}

function mockShader(): THREE.WebGLProgramParametersWithUniforms {
  return {
    uniforms: {},
    vertexShader: "#include <common>\nvoid main() {}",
    fragmentShader: "#include <common>\nvoid main() {}",
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
}

describe("browser-efficient cascaded shadow controller", () => {
  it("composes existing material hooks and patches every built-in lit family once", () => {
    const { scene, camera, sun } = createFixture();
    const terrainMaterial = new THREE.MeshStandardMaterial();
    terrainMaterial.defines = {
      TERRAIN_DETAIL: 1,
      USE_CSM: 7,
      CSM_CASCADES: 99,
      CSM_FADE: "legacy",
    };
    const originalHook: THREE.Material["onBeforeCompile"] = (shader) => {
      shader.uniforms.terrainHookRan = { value: 1 };
      shader.vertexShader += "\n// terrain-hook";
    };
    terrainMaterial.onBeforeCompile = originalHook;
    const terrain = addMesh(scene, "terrain", terrainMaterial, true, true);

    const waterMaterial = new THREE.MeshPhysicalMaterial();
    const cloudMaterial = new THREE.MeshStandardMaterial({ transparent: true });
    const horizonMaterial = new THREE.MeshLambertMaterial();
    const phongMaterial = new THREE.MeshPhongMaterial();
    const waterDefines = { ...waterMaterial.defines };
    const cloudDefines = { ...cloudMaterial.defines };
    const horizonDefines = horizonMaterial.defines && { ...horizonMaterial.defines };
    addMesh(scene, "water", waterMaterial, false, false);
    addMesh(scene, "cloud", cloudMaterial, false, false);
    addMesh(scene, "horizon", horizonMaterial, false, false);
    addMesh(scene, "aircraft", phongMaterial, true, true);
    const shaderMaterial = new THREE.ShaderMaterial();
    const basicMaterial = new THREE.MeshBasicMaterial();
    addMesh(scene, "custom-sky", shaderMaterial, false, false);
    addMesh(scene, "sun-disc", basicMaterial, false, false);

    const controller = new CascadedShadowController({ scene, camera, sunSource: sun });
    try {
      expect(controller.registeredMaterialCount).toBe(5);
      expect(controller.registeredMeshCount).toBe(5);
      expect(isCascadedShadowMaterial(waterMaterial)).toBe(true);
      expect(isCascadedShadowMaterial(cloudMaterial)).toBe(true);
      expect(isCascadedShadowMaterial(horizonMaterial)).toBe(true);
      expect(isCascadedShadowMaterial(shaderMaterial)).toBe(false);
      expect(isCascadedShadowMaterial(basicMaterial)).toBe(false);

      const shader = mockShader();
      terrainMaterial.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
      expect(shader.uniforms.terrainHookRan).toEqual({ value: 1 });
      expect(shader.vertexShader).toContain("terrain-hook");
      expect(shader.uniforms.CSM_cascades).toBeDefined();
      expect(shader.uniforms.cameraNear).toBeDefined();
      expect(shader.uniforms.shadowFar).toBeDefined();
      expect(terrainMaterial.defines?.USE_CSM).toBe(1);
      expect(terrainMaterial.defines?.CSM_CASCADES).toBe(3);
      expect(terrainMaterial.defines?.CSM_FADE).toBe("");
      expect(waterMaterial.defines?.USE_CSM).toBe(1);
      expect(cloudMaterial.defines?.USE_CSM).toBe(1);
      expect(horizonMaterial.defines?.USE_CSM).toBe(1);
      expect(shaderMaterial.defines?.USE_CSM).toBeUndefined();
      expect(basicMaterial.defines?.USE_CSM).toBeUndefined();
      expect(terrain.layers.isEnabled(DEFAULT_CSM_LAYER)).toBe(true);
    } finally {
      controller.dispose();
    }

    expect(terrainMaterial.onBeforeCompile).toBe(originalHook);
    expect(terrainMaterial.defines).toEqual({
      TERRAIN_DETAIL: 1,
      USE_CSM: 7,
      CSM_CASCADES: 99,
      CSM_FADE: "legacy",
    });
    expect(waterMaterial.defines).toEqual(waterDefines);
    expect(cloudMaterial.defines).toEqual(cloudDefines);
    expect(horizonMaterial.defines).toEqual(horizonDefines);
  });

  it("isolates cascade lights on one layer, syncs the source sun, and restores masks", () => {
    const { scene, camera, sun } = createFixture();
    const receiver = addMesh(
      scene,
      "receiver",
      new THREE.MeshStandardMaterial(),
      true,
      true,
    );
    const excludedCaster = addMesh(
      scene,
      "excluded-caster",
      new THREE.MeshLambertMaterial(),
      true,
      false,
    );
    const custom = addMesh(scene, "shader", new THREE.ShaderMaterial(), false, false);
    receiver.layers.set(5);
    const originalReceiverMask = receiver.layers.mask;
    const originalCameraMask = camera.layers.mask;
    const originalSunMask = sun.layers.mask;
    const reflectionCamera = new THREE.PerspectiveCamera(60, 1, 0.2, 12_000);
    reflectionCamera.layers.set(7);
    const originalReflectionMask = reflectionCamera.layers.mask;

    const controller = new CascadedShadowController({
      scene,
      camera,
      sunSource: sun,
      castShadowPredicate: (mesh) => mesh.name !== "excluded-caster",
    });
    controller.enableLayer(reflectionCamera);
    try {
      expect(sun.visible).toBe(false);
      expect(sun.layers.mask).toBe(originalSunMask);
      expect(sun.layers.isEnabled(0)).toBe(true);
      expect(sun.layers.isEnabled(DEFAULT_CSM_LAYER)).toBe(false);
      expect(camera.layers.isEnabled(0)).toBe(true);
      expect(camera.layers.isEnabled(DEFAULT_CSM_LAYER)).toBe(true);
      expect(reflectionCamera.layers.isEnabled(7)).toBe(true);
      expect(reflectionCamera.layers.isEnabled(DEFAULT_CSM_LAYER)).toBe(true);
      expect(receiver.layers.isEnabled(5)).toBe(true);
      expect(receiver.layers.isEnabled(DEFAULT_CSM_LAYER)).toBe(true);
      expect(excludedCaster.layers.isEnabled(DEFAULT_CSM_LAYER)).toBe(true);
      expect(excludedCaster.castShadow).toBe(false);
      expect(
        (excludedCaster.material as THREE.MeshLambertMaterial).defines?.USE_CSM,
      ).toBe(1);
      expect(custom.layers.isEnabled(DEFAULT_CSM_LAYER)).toBe(false);

      sun.color.set(0x88aaff);
      sun.intensity = 1.37;
      sun.position.set(3_000, 7_000, -2_000);
      sun.target.position.set(450, 120, 900);
      controller.update();
      for (const light of controller.cascadeLights) {
        expect(light.layers.isEnabled(DEFAULT_CSM_LAYER)).toBe(true);
        expect(light.layers.isEnabled(0)).toBe(false);
        expect(light.color.getHex()).toBe(sun.color.getHex());
        expect(light.intensity).toBeCloseTo(1.37, 8);
      }
    } finally {
      controller.dispose();
    }

    expect(sun.visible).toBe(true);
    expect(receiver.layers.mask).toBe(originalReceiverMask);
    expect(excludedCaster.castShadow).toBe(true);
    expect(camera.layers.mask).toBe(originalCameraMask);
    expect(reflectionCamera.layers.mask).toBe(originalReflectionMask);
  });

  it("uses bounded practical budgets and toggles shadows without replacing hooks", () => {
    expect(cascadedShadowBudget("low", "balanced")).toMatchObject({
      cascades: 2,
      shadowMapSize: 512,
      fade: false,
    });
    expect(cascadedShadowBudget("medium", "hybrid")).toMatchObject({
      cascades: 3,
      shadowMapSize: 1_024,
      maxFar: 7_200,
      fade: true,
    });
    expect(cascadedShadowBudget("high", "ray-traced")).toMatchObject({
      cascades: 3,
      shadowMapSize: 2_048,
      maxFar: 10_800,
      fade: true,
    });

    const { scene, camera, sun } = createFixture();
    const material = new THREE.MeshStandardMaterial();
    const originalProgramCacheKey = () => "terrain-custom-shader";
    material.customProgramCacheKey = originalProgramCacheKey;
    addMesh(scene, "terrain", material, true, true);
    const controller = new CascadedShadowController({
      scene,
      camera,
      sunSource: sun,
      quality: "low",
      renderingMode: "balanced",
    });
    try {
      expect(controller.cascadeLights).toHaveLength(2);
      expect(controller.cascadeBreaks).toHaveLength(2);
      expect(controller.cascadeLights[0]?.shadow.mapSize.x).toBe(512);
      const composedHook = material.onBeforeCompile;
      const initialCsmProgramCacheKey = material.customProgramCacheKey();
      expect(initialCsmProgramCacheKey).toContain("terrain-custom-shader|csm-");
      controller.setShadowCastingEnabled(false);
      expect(controller.shadowCastingEnabled).toBe(false);
      expect(material.onBeforeCompile).toBe(composedHook);
      for (const light of controller.cascadeLights) {
        expect(light.castShadow).toBe(true);
        expect(light.shadow.intensity).toBe(0);
        expect(light.shadow.autoUpdate).toBe(false);
      }
      controller.setShadowCastingEnabled(true);
      expect(material.onBeforeCompile).toBe(composedHook);
      for (const light of controller.cascadeLights) {
        expect(light.shadow.intensity).toBe(1);
        expect(light.shadow.autoUpdate).toBe(true);
        expect(light.shadow.needsUpdate).toBe(true);
      }

      const retiredLights = [...controller.cascadeLights];
      controller.configure("high", "ray-traced");
      expect(material.customProgramCacheKey()).not.toBe(initialCsmProgramCacheKey);
      expect(controller.cascadeLights).toHaveLength(3);
      expect(controller.cascadeBreaks).toHaveLength(3);
      expect(controller.budget.maxFar).toBe(10_800);
      expect(controller.cascadeLights[0]?.shadow.mapSize.x).toBe(2_048);
      expect(controller.cascadeLights[0]?.shadow.normalBias).toBeCloseTo(0.16, 8);
      expect(retiredLights.every((light) => light.parent === null)).toBe(true);
      const shader = mockShader();
      material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
      expect(shader.uniforms.CSM_cascades).toBeDefined();
    } finally {
      controller.dispose();
    }
    expect(material.customProgramCacheKey).toBe(originalProgramCacheKey);
  });

  it("reference-counts the addon shader chunks and restores global state on final disposal", () => {
    const originalFragmentChunk = THREE.ShaderChunk.lights_fragment_begin;
    const originalParsChunk = THREE.ShaderChunk.lights_pars_begin;
    const first = createFixture();
    const second = createFixture();
    const firstController = new CascadedShadowController({
      ...first,
      sunSource: first.sun,
      autoRegisterScene: false,
    });
    const installedFragmentChunk = THREE.ShaderChunk.lights_fragment_begin;
    const secondController = new CascadedShadowController({
      ...second,
      sunSource: second.sun,
      autoRegisterScene: false,
    });
    try {
      expect(installedFragmentChunk).not.toBe(originalFragmentChunk);
      expect(THREE.ShaderChunk.lights_pars_begin).not.toBe(originalParsChunk);
      firstController.dispose();
      expect(THREE.ShaderChunk.lights_fragment_begin).toBe(installedFragmentChunk);
    } finally {
      firstController.dispose();
      secondController.dispose();
    }
    expect(THREE.ShaderChunk.lights_fragment_begin).toBe(originalFragmentChunk);
    expect(THREE.ShaderChunk.lights_pars_begin).toBe(originalParsChunk);
  });

  it("rejects the normal atmosphere layer and out-of-range layer indices", () => {
    const { scene, camera, sun } = createFixture();
    expect(
      () => new CascadedShadowController({ scene, camera, sunSource: sun, layer: 0 }),
    ).toThrow(RangeError);
    expect(
      () => new CascadedShadowController({ scene, camera, sunSource: sun, layer: 32 }),
    ).toThrow(RangeError);
  });
});
