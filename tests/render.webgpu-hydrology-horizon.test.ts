import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Color3,
  FreeCamera,
  NullEngine,
  RawTexture,
  Scene,
  Vector2,
  Vector3,
  type BaseTexture,
  type Vector4,
} from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import type { AtmosphereSnapshot } from "../src/render/webgpu/atmosphere/AtmosphereSystem";
import { HORIZON_FIELD_LOOKUP_WGSL } from "../src/render/webgpu/terrain/HorizonField";
import {
  HYDROLOGY_GROUND_BOUNCE_CALIBRATION,
  HYDROLOGY_HORIZON_SOFT_BAND,
  HYDROLOGY_WATER_FRAGMENT_WGSL,
  HydrologySystem,
  resolveHydrologyGroundBounce,
  resolveHydrologyHorizonPlacement,
} from "../src/render/webgpu/water/HydrologySystem";
import { fallbackWaterPlanarTexture } from "../src/render/webgpu/water/WaterShaders";

// Terrain occlusion of the reflected sky. The inland fragment reflected a
// SKY-ONLY probe in every direction, so a lake in a valley at dusk showed
// bright horizon sky where a grazing reflection ray actually hits the
// hillside. The fix asks the terrain's global horizon field (`6-11`) whether
// the reflection direction clears the terrain, and shows the atmosphere's
// own ground bounce where it does not. These pins keep the occlusion on the
// sky term alone, composed from the one shared operator.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function stripComments(code: string): string {
  return code.replace(/\/\/.*$/gmu, "");
}

const ATMOSPHERE: AtmosphereSnapshot = {
  sunDirection: new Vector3(-0.36, 0.82, 0.44).normalize(),
  sunColor: new Color3(1, 0.96, 0.88),
  sunIntensity: 4.8,
  skyZenith: new Color3(0.1, 0.36, 0.78),
  skyHorizon: new Color3(0.58, 0.77, 0.96),
  ambientColor: new Color3(0.18, 0.27, 0.42),
  skylightIlluminanceNormalized: 1,
  sunIlluminanceNormalized: 0.92,
  sunAngularRadiusRadians: 0.004675,
  cloudCoverage: 0.32,
  humidity: 0.62,
  windSpeed: 9,
  windDirection: new Vector2(0.93, 0.37).normalize(),
  moonDirection: new Vector3(0, -1, 0),
  moonIlluminanceLux: 0,
  moonIlluminatedFraction: 0,
  adaptedLuminanceCdM2: 6_000,
  sceneKeyLuminanceCdM2: 1_000,
};

const FRAGMENT = HYDROLOGY_WATER_FRAGMENT_WGSL;
const MAIN_START = FRAGMENT.indexOf("@fragment");
/** The helper block this change adds, up to the entry point. */
const HELPERS = FRAGMENT.slice(FRAGMENT.indexOf("fn hydrologyHorizonJitter("), MAIN_START);
const MAIN = FRAGMENT.slice(MAIN_START);

/** The statement (up to its terminating semicolon) that starts with `head`. */
function statement(code: string, head: string): string {
  const start = code.indexOf(head);
  expect(start, `${head} is missing`).toBeGreaterThanOrEqual(0);
  return code.slice(start, code.indexOf(";", start) + 1);
}

describe("hydrology terrain-occluded sky reflection: the fragment", () => {
  it("composes the shared horizon lookup exactly once, before the entry point", () => {
    expect(MAIN_START).toBeGreaterThan(0);
    expect(FRAGMENT.split(HORIZON_FIELD_LOOKUP_WGSL)).toHaveLength(2);
    expect(FRAGMENT.split("fn horizonFieldShadow(")).toHaveLength(2);
    expect(FRAGMENT.indexOf(HORIZON_FIELD_LOOKUP_WGSL)).toBeLessThan(MAIN_START);
    // The consumer is defined after the operator it calls (WGSL wants
    // declarations before use) and calls it exactly once.
    expect(FRAGMENT.indexOf("fn hydrologyTerrainVisibility("))
      .toBeGreaterThan(FRAGMENT.indexOf(HORIZON_FIELD_LOOKUP_WGSL));
    expect(HELPERS.split("horizonFieldShadow(")).toHaveLength(2);
    // The lookup's azimuth index arithmetic lives in ONE place — the shared
    // text — never restated by this consumer (the horizon-field test's rule).
    expect(stripComments(FRAGMENT).split("- 0.5;\n  let wrapped")).toHaveLength(2);
    // The declarations the material binds.
    expect(FRAGMENT).toContain("uniform hydrologyHorizonField: vec4f;");
    expect(FRAGMENT).toContain("uniform groundBounceAlbedo: f32;");
    expect(FRAGMENT).toContain(
      "var hydrologyHorizonASampler: sampler; var hydrologyHorizonA: texture_2d<f32>;",
    );
    expect(FRAGMENT).toContain(
      "var hydrologyHorizonBSampler: sampler; var hydrologyHorizonB: texture_2d<f32>;",
    );
  });

  it("keeps the lookup derivative-free, in uniform control flow, on the field's own sentinel", () => {
    const helpers = stripComments(HELPERS);
    for (const forbidden of ["dpdx(", "dpdy(", "fwidth(", "textureSample(", "if (", "discard"]) {
      expect(helpers, `horizon helpers use ${forbidden}`).not.toContain(forbidden);
    }
    // Both layers are level-0 samples at the world-to-uv mapping the detail
    // consumer uses: (world - origin) * inverseSpan.
    expect(helpers).toContain("let uv = (worldXZ - field.xy) * field.z;");
    expect(helpers).toContain(
      "textureSampleLevel(hydrologyHorizonA, hydrologyHorizonASampler, uv, 0.0)",
    );
    expect(helpers).toContain(
      "textureSampleLevel(hydrologyHorizonB, hydrologyHorizonBSampler, uv, 0.0)",
    );
    // An absent field (inverseSpan 0) mixes to fully visible through a
    // select on the uniform — the parity sentinel — not a branch.
    expect(helpers).toContain("let resident = select(0.0, 1.0, field.z > 0.0);");
    expect(helpers).toContain("return mix(1.0, visibility, resident);");
    // The band and the jitter come from the vec4's w lane and a world-locked
    // spatial hash, never a sin/fract hash (collapses into rows) and never a
    // temporal one (crawls).
    expect(helpers).toContain("field.w,");
    expect(helpers).toContain("hydrologyHorizonJitter(worldXZ * 0.37)");
    expect(helpers).not.toMatch(/fract\s*\(\s*sin\s*\(/u);
    expect(helpers).not.toContain("uniforms.time");
  });

  it("occludes the sky reflection before the planar capture blends over it, and nothing else", () => {
    const main = stripComments(MAIN);
    const unoccluded = main.indexOf(
      "let unoccludedSky = mix(analyticSky, environmentSky, uniforms.environmentValid);",
    );
    const visibility = main.indexOf(
      "let terrainVisibility = hydrologyTerrainVisibility(input.absoluteWorldXZ, reflectionDirection);",
    );
    const occluded = main.indexOf("let skyReflection = mix(");
    const planar = main.indexOf("samplePlanarSceneReflection(");
    expect(unoccluded).toBeGreaterThanOrEqual(0);
    expect(visibility).toBeGreaterThan(unoccluded);
    expect(occluded).toBeGreaterThan(visibility);
    expect(planar).toBeGreaterThan(occluded);
    // The occluded colour is the atmosphere's ground bounce, built from the
    // SAME skyHorizon uniform the analytic sky reads.
    expect(statement(main, "let skyReflection = mix(")).toBe(
      "let skyReflection = mix(\n"
      + "    uniforms.skyHorizon * uniforms.groundBounceAlbedo,\n"
      + "    unoccludedSky,\n"
      + "    terrainVisibility,\n"
      + "  );",
    );
    // And the occluded value is what the planar receiver falls back to.
    expect(statement(main, "let reflection = samplePlanarSceneReflection(")).toContain(
      "    skyReflection,\n  );",
    );
    // Exactly two mentions in the body: the definition and the one mix. The
    // sun lobe, the body colour, the foam and the Fresnel are not sky.
    expect(main.split("terrainVisibility")).toHaveLength(3);
    expect(main.split("groundBounceAlbedo")).toHaveLength(2);
    for (const head of [
      "color += sunSpecular(glintNormal",
      "let transmitted = waterVolumeRadiance(",
      "let fresnel = waterRoughInterfaceFresnel(",
      "var color = transmitted",
    ]) {
      const text = statement(main, head);
      expect(text, `${head} is occluded`).not.toContain("terrainVisibility");
      expect(text, `${head} reads the ground bounce`).not.toContain("groundBounceAlbedo");
    }
    expect(main).toContain("* uniforms.sunColor * directSunVisibility * sparkle;");
  });
});

describe("hydrology terrain-occluded sky reflection: the placement", () => {
  it("publishes the vec4 the fragment reads, with inverseSpan 0 as the absent sentinel", () => {
    expect(resolveHydrologyHorizonPlacement(true, 1_000, -2_000, 65_536)).toEqual({
      originX: 1_000,
      originZ: -2_000,
      inverseSpan: 1 / 65_536,
      softBand: HYDROLOGY_HORIZON_SOFT_BAND,
    });
    const absent = {
      originX: 0,
      originZ: 0,
      inverseSpan: 0,
      softBand: HYDROLOGY_HORIZON_SOFT_BAND,
    };
    // No layers, a span that cannot be inverted, a non-finite origin: each
    // keeps today's behaviour rather than smearing an edge texel.
    expect(resolveHydrologyHorizonPlacement(false, 1_000, -2_000, 65_536)).toEqual(absent);
    expect(resolveHydrologyHorizonPlacement(true, 1_000, -2_000, 0)).toEqual(absent);
    expect(resolveHydrologyHorizonPlacement(true, 1_000, -2_000, -1)).toEqual(absent);
    expect(resolveHydrologyHorizonPlacement(true, 1_000, -2_000, Number.NaN)).toEqual(absent);
    expect(resolveHydrologyHorizonPlacement(true, Number.NaN, -2_000, 65_536)).toEqual(absent);
    expect(resolveHydrologyHorizonPlacement(true, 1_000, Number.POSITIVE_INFINITY, 65_536))
      .toEqual(absent);
  });

  it("restates the detail consumer's soft band and the atmosphere's ground-bounce calibration", () => {
    // Water must not import from detail/, so the band is restated; this pin
    // is what keeps the two from drifting.
    const detailBand = /export const DETAIL_HORIZON_SOFT_BAND = ([\d.]+);/u.exec(
      source("src/render/webgpu/detail/DetailInstanceMaterialPlugin.ts"),
    );
    expect(detailBand).not.toBeNull();
    expect(HYDROLOGY_HORIZON_SOFT_BAND).toBe(Number(detailBand![1]));
    expect(HYDROLOGY_HORIZON_SOFT_BAND).toBeGreaterThan(0);
    // The occluded colour is AtmosphereSystem's `skyHorizon * albedo * 1.15`.
    const calibration = /const GROUND_BOUNCE_CALIBRATION = ([\d.]+);/u.exec(
      source("src/render/webgpu/atmosphere/AtmosphereSystem.ts"),
    );
    expect(calibration).not.toBeNull();
    expect(HYDROLOGY_GROUND_BOUNCE_CALIBRATION).toBe(Number(calibration![1]));
    expect(resolveHydrologyGroundBounce(0.2)).toBeCloseTo(0.2 * HYDROLOGY_GROUND_BOUNCE_CALIBRATION, 12);
    // Albedo is a reflectance: clamped to [0, 1], never negative light.
    expect(resolveHydrologyGroundBounce(4)).toBe(HYDROLOGY_GROUND_BOUNCE_CALIBRATION);
    expect(resolveHydrologyGroundBounce(-1)).toBe(0);
    expect(() => resolveHydrologyGroundBounce(Number.NaN)).toThrow(RangeError);
  });
});

describe("hydrology terrain-occluded sky reflection: the material", () => {
  it("declares the samplers and uniforms in the ShaderMaterial's own lists", () => {
    // setTexture/setVector4 push a missing name into the options on demand,
    // so a runtime check alone is vacuous: the declared lists are pinned at
    // the source.
    const code = source("src/render/webgpu/water/HydrologySystem.ts");
    const construction = code.slice(code.indexOf("new ShaderMaterial("));
    const options = construction.slice(0, construction.indexOf("shaderLanguage: ShaderLanguage.WGSL"));
    const uniforms = options.slice(options.indexOf("uniforms: ["), options.indexOf("samplers: ["));
    const samplers = options.slice(options.indexOf("samplers: ["));
    expect(uniforms).toContain('"hydrologyHorizonField",');
    expect(uniforms).toContain('"groundBounceAlbedo",');
    expect(samplers).toContain('"hydrologyHorizonA",');
    expect(samplers).toContain('"hydrologyHorizonB",');
  });

  it("binds the field when both layers exist and the fallback texel otherwise", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("hydrology-horizon-camera", new Vector3(0, 300, -600), scene);
    const system = new HydrologySystem(scene, camera, {
      atmosphere: ATMOSPHERE,
      worldSeed: 4_242,
      terrainSample: (x, z) => ({
        height: 520 - x * 0.075 + Math.sin(z * 0.004) * 3,
        moisture: 0.64,
      }),
      seaLevel: 0,
      centerX: 0,
      centerZ: 0,
    });
    const material = (system as unknown as {
      material: {
        options: { samplers: string[]; uniforms: string[] };
        _textures: Record<string, BaseTexture>;
        _vectors4: Record<string, Vector4>;
        _floats: Record<string, number>;
      };
    }).material;
    const fallback = fallbackWaterPlanarTexture(scene);
    const placement = () => material._vectors4.hydrologyHorizonField!.asArray();

    // From construction: bound (an unbound declared sampler keeps a WebGPU
    // material un-ready forever) to the fallback, with the absent sentinel,
    // and the atmosphere's default 0.18 albedo under its calibration.
    expect(material.options.samplers).toEqual(
      expect.arrayContaining(["hydrologyHorizonA", "hydrologyHorizonB"]),
    );
    expect(material.options.uniforms).toEqual(
      expect.arrayContaining(["hydrologyHorizonField", "groundBounceAlbedo"]),
    );
    expect(material._textures.hydrologyHorizonA).toBe(fallback);
    expect(material._textures.hydrologyHorizonB).toBe(fallback);
    expect(placement()).toEqual([0, 0, 0, HYDROLOGY_HORIZON_SOFT_BAND]);
    expect(material._floats.groundBounceAlbedo).toBeCloseTo(0.18 * HYDROLOGY_GROUND_BOUNCE_CALIBRATION, 12);

    const layerA = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene);
    const layerB = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene);
    system.setHorizonField(layerA, layerB, 1_000, -2_000, 65_536);
    expect(material._textures.hydrologyHorizonA).toBe(layerA);
    expect(material._textures.hydrologyHorizonB).toBe(layerB);
    expect(placement()).toEqual([1_000, -2_000, 1 / 65_536, HYDROLOGY_HORIZON_SOFT_BAND]);

    // One null layer (the renderer's `?? null` before the first bake, or
    // after a device loss) is an absent field: fallback texel, sentinel.
    system.setHorizonField(null, layerB, 1_000, -2_000, 65_536);
    expect(material._textures.hydrologyHorizonA).toBe(fallback);
    expect(material._textures.hydrologyHorizonB).toBe(fallback);
    expect(placement()).toEqual([0, 0, 0, HYDROLOGY_HORIZON_SOFT_BAND]);
    system.setHorizonField(layerA, layerB, 1_000, -2_000, 0);
    expect(placement()).toEqual([0, 0, 0, HYDROLOGY_HORIZON_SOFT_BAND]);

    system.setGroundBounceAlbedo(0.3);
    expect(material._floats.groundBounceAlbedo).toBeCloseTo(0.3 * HYDROLOGY_GROUND_BOUNCE_CALIBRATION, 12);

    system.dispose();
    layerA.dispose();
    layerB.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("is forwarded by FlightRenderer from the one horizon snapshot the detail consumer reads", () => {
    const code = stripComments(source("src/render/FlightRenderer.ts"));
    // One read of the field per frame, handed to both consumers in turn.
    expect(code.split("this.terrain.globalHorizonField")).toHaveLength(2);
    const detail = code.indexOf("this.detail.setHorizonField(");
    const hydrology = code.indexOf("this.hydrology.setHorizonField(");
    expect(detail).toBeGreaterThan(code.indexOf("this.terrain.globalHorizonField"));
    expect(hydrology).toBeGreaterThan(detail);
    expect(code.slice(detail, hydrology)).not.toContain("this.terrain.globalHorizonField");
    // The ground bounce rides the same publish as the atmosphere snapshot.
    expect(code).toContain("this.hydrology.setAtmosphere(this.atmosphere.snapshot);");
    expect(code).toContain(
      "this.hydrology.setGroundBounceAlbedo(this.atmosphere.surfaceAlbedoLuminance);",
    );
  });
});
