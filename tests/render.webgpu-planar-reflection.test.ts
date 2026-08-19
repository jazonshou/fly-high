import { describe, expect, it } from "vitest";
import {
  PLANAR_REFLECTION_FRAGMENT_WGSL,
  acceptsInlandPlanarReflection,
  selectPlanarReflectionPlane,
} from "../src/render/webgpu/water/PlanarWaterReflectionSystem";
import { WATER_FRAGMENT_WGSL } from "../src/render/webgpu/water/SpectralOceanSystem";
import {
  HYDROLOGY_WATER_FRAGMENT_WGSL,
  HYDROLOGY_WATER_VERTEX_WGSL,
} from "../src/render/webgpu/water/HydrologySystem";

/**
 * 2-10 retired the planar-reflection CAPTURE system (the MirrorTexture pass,
 * its budgets and its governor rung). What this suite still guards is the
 * deliberately preserved Class-T surface: the receiver WGSL contract both
 * water materials keep compiled in, and the plane-selection hysteresis
 * `5-12` rebuilds the lake capture around.
 */
describe("WebGPU planar-water reflection policy", () => {
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
