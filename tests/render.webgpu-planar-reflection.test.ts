import {
  FreeCamera,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  PLANAR_REFLECTION_FRAGMENT_WGSL,
  PlanarWaterReflectionSystem,
  acceptsInlandPlanarReflection,
  isPlanarReflectionCaster,
  resolvePlanarReflectionBudget,
  selectPlanarReflectionPlane,
  type PlanarReflectionReceiver,
} from "../src/render/webgpu/water/PlanarWaterReflectionSystem";
import { WATER_FRAGMENT_WGSL } from "../src/render/webgpu/water/SpectralOceanSystem";
import {
  HYDROLOGY_WATER_FRAGMENT_WGSL,
  HYDROLOGY_WATER_VERTEX_WGSL,
} from "../src/render/webgpu/water/HydrologySystem";

describe("WebGPU planar-water reflection policy", () => {
  it("keeps every quality tier low-resolution and hard-cadenced", () => {
    const budgets = ([0, 1, 2] as const).map((tier) => resolvePlanarReflectionBudget({ tier }));
    for (const budget of budgets) {
      expect(budget.width).toBeLessThanOrEqual(480);
      expect(budget.height).toBeLessThanOrEqual(270);
      expect(budget.updateEveryNFrames).toBeGreaterThanOrEqual(3);
      expect(budget.warmupFrames).toBeGreaterThanOrEqual(4);
      expect(budget.strength).toBeGreaterThan(0);
      expect(budget.strength).toBeLessThan(1);
    }
    expect(budgets.map((budget) => budget.width)).toEqual([192, 320, 480]);
    expect(budgets.map((budget) => budget.updateEveryNFrames)).toEqual([8, 5, 3]);

    expect(resolvePlanarReflectionBudget(
      resolveWebGpuQualityProfile("low", "ultra"),
    )).toEqual(resolvePlanarReflectionBudget(
      resolveWebGpuQualityProfile("medium", "balanced"),
    ));
  });

  it("uses one nearby lake plane and otherwise returns to sea level", () => {
    const lakes = [
      { centerX: 2_000, centerZ: -500, surfaceHeight: 184, radiusMeters: 220 },
      { centerX: -4_000, centerZ: 1_000, surfaceHeight: 92, radiusMeters: 400 },
    ];
    expect(selectPlanarReflectionPlane(0, { x: 2_100, y: 260, z: -540 }, lakes)).toEqual({
      height: 184,
      source: "lake",
      lakeIndex: 0,
    });
    expect(selectPlanarReflectionPlane(0, { x: 8_000, y: 260, z: 8_000 }, lakes)).toEqual({
      height: 0,
      source: "ocean",
      lakeIndex: null,
    });
    expect(() => selectPlanarReflectionPlane(
      0,
      { x: Number.NaN, y: 0, z: 0 },
      lakes,
    )).toThrow(/observer/);
  });

  it("ignores tiny lakes at cruise altitude and releases a selected plane without churn", () => {
    const lakes = [
      { centerX: 0, centerZ: 0, surfaceHeight: 100, radiusMeters: 80 },
    ];
    const selected = selectPlanarReflectionPlane(
      0,
      { x: 0, y: 500, z: 0 },
      lakes,
    );
    expect(selected.source).toBe("lake");
    expect(selectPlanarReflectionPlane(
      0,
      { x: 0, y: 8_000, z: 0 },
      lakes,
      selected,
    ).source).toBe("ocean");

    const nearEdge = { x: 1_000, y: 500, z: 0 };
    expect(selectPlanarReflectionPlane(0, nearEdge, lakes).source).toBe("ocean");
    expect(selectPlanarReflectionPlane(0, nearEdge, lakes, selected).source).toBe("lake");
    expect(selectPlanarReflectionPlane(
      0,
      { x: 1_180, y: 500, z: 0 },
      lakes,
      selected,
    ).source).toBe("ocean");
  });

  it("allows only the selected current lake mesh to consume a lake capture", () => {
    const base = {
      source: "lake" as const,
      planeHeight: 184,
      isLakeMesh: true,
      isCurrentRegion: true,
      lakes: [{ surfaceHeight: 184 }, { surfaceHeight: 420 }],
    };
    expect(acceptsInlandPlanarReflection(base)).toBe(true);
    expect(acceptsInlandPlanarReflection({ ...base, source: "ocean" })).toBe(false);
    expect(acceptsInlandPlanarReflection({ ...base, isLakeMesh: false })).toBe(false);
    expect(acceptsInlandPlanarReflection({ ...base, isCurrentRegion: false })).toBe(false);
    expect(acceptsInlandPlanarReflection({ ...base, planeHeight: 185 })).toBe(false);
  });

  it("captures only enabled opaque finite-distance meshes", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const opaqueMaterial = new PBRMaterial("opaque", scene);
    const opaque = MeshBuilder.CreateBox("opaque", {}, scene);
    opaque.material = opaqueMaterial;
    expect(isPlanarReflectionCaster(opaque)).toBe(true);

    const transparentMaterial = new PBRMaterial("transparent", scene);
    transparentMaterial.alpha = 0.5;
    transparentMaterial.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    const transparent = MeshBuilder.CreateBox("transparent", {}, scene);
    transparent.material = transparentMaterial;
    expect(isPlanarReflectionCaster(transparent)).toBe(false);

    opaque.infiniteDistance = true;
    expect(isPlanarReflectionCaster(opaque)).toBe(false);
    opaque.infiniteDistance = false;
    opaque.metadata = { waterSurface: true };
    expect(isPlanarReflectionCaster(opaque)).toBe(false);
    opaque.metadata = null;
    opaque.setEnabled(false);
    expect(isPlanarReflectionCaster(opaque)).toBe(false);

    scene.dispose();
    engine.dispose();
  });

  it("stays manual/lazy and releases its receiver without joining scene recursion", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("reflection-camera", new Vector3(0, 100, -300), scene);
    scene.activeCamera = camera;
    const setPlanarReflection = vi.fn<PlanarReflectionReceiver["setPlanarReflection"]>();
    const receiver: PlanarReflectionReceiver = { setPlanarReflection };
    const system = new PlanarWaterReflectionSystem(scene, camera, 0, { tier: 0 }, [receiver]);

    expect(scene.customRenderTargets).toHaveLength(0);
    expect(system.update({ frameIndex: 1, cameraCut: true, originShifted: false })).toEqual({
      captured: false,
      reason: "warmup",
    });
    expect(system.captureValid).toBe(false);
    expect(setPlanarReflection).toHaveBeenCalledTimes(1);

    system.dispose();
    system.dispose();
    expect(setPlanarReflection).toHaveBeenLastCalledWith(null);
    scene.dispose();
    engine.dispose();
  });

  it("preserves the analytic atmosphere response when capture confidence is absent", () => {
    expect(PLANAR_REFLECTION_FRAGMENT_WGSL).toContain("return atmosphereFallback");
    expect(PLANAR_REFLECTION_FRAGMENT_WGSL).toContain("sceneReflection.a");
    expect(PLANAR_REFLECTION_FRAGMENT_WGSL).toContain("planarReflectionPlaneHeight");
    expect(PLANAR_REFLECTION_FRAGMENT_WGSL).toContain("planarReflectionReceiverEnabled");
    expect(WATER_FRAGMENT_WGSL).toContain("samplePlanarSceneReflection");
    // 2-9: the planar fallback is the environment/analytic sky blend.
    expect(WATER_FRAGMENT_WGSL).toContain("skyReflection");
    expect(WATER_FRAGMENT_WGSL).toContain("analyticSky");
    expect(HYDROLOGY_WATER_VERTEX_WGSL).toContain("planarReflectionViewProjection");
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain("samplePlanarSceneReflection");
    expect(
      `${PLANAR_REFLECTION_FRAGMENT_WGSL}${WATER_FRAGMENT_WGSL}${HYDROLOGY_WATER_FRAGMENT_WGSL}`,
    ).not.toMatch(
      /gl_FragColor|#version|THREE\./,
    );
  });
});
