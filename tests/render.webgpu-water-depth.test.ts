import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import {
  BathymetryClipmap,
  BATHYMETRY_CLIPMAP_EDGE,
  BATHYMETRY_FAR_TEXEL_METERS,
  BATHYMETRY_LEVELS,
  BATHYMETRY_NEAR_TEXEL_METERS,
  BATHYMETRY_UPDATE_WGSL,
  bathymetryClipmapBytes,
  bathymetryUpdateRectangles,
  sampleBathymetryMacroHeight,
  sampleBathymetryTerrainAuthority,
  toroidalBathymetryTexel,
} from "../src/render/webgpu/water/BathymetryClipmap";
import {
  EVOLUTION_ANALYTIC_BLEND_METERS,
  EVOLUTION_DOMAIN_SAMPLE_COUNT,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
  type TerrainMacroEvolutionExport,
} from "../src/render/webgpu/terrain/TerrainEvolutionContract";
import { createWorld } from "../src/world";
import { HYDROLOGY_WATER_FRAGMENT_WGSL, HYDROLOGY_WATER_VERTEX_WGSL } from
  "../src/render/webgpu/water/HydrologySystem";
import { WATER_FRAGMENT_WGSL } from "../src/render/webgpu/water/SpectralOceanSystem";
import {
  WATER_ABSORPTION_PER_METER,
  WATER_AIR_INTERFACE_CRITICAL_ANGLE_DEGREES,
  WATER_DEPTH_OPTICS_WGSL,
  WATER_SHORE_FADE_METERS,
} from "../src/render/webgpu/water/WaterShaders";

const BATHYMETRY_AUTHORITY_SEED = "bathymetry-authority";
let cachedMacroFixture: TerrainMacroEvolutionExport | null = null;

function macroFixture(): TerrainMacroEvolutionExport {
  if (cachedMacroFixture) return cachedMacroFixture;
  const heightMeters = new Float32Array(EVOLUTION_DOMAIN_SAMPLE_COUNT).fill(20);
  heightMeters[0] = 10;
  heightMeters[1] = 30;
  heightMeters[1_024] = 50;
  heightMeters[1_025] = 70;
  cachedMacroFixture = {
    contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
    provenance: { worldSeed: BATHYMETRY_AUTHORITY_SEED, deviceFingerprint: "node" },
    seaLevelMeters: 0,
    heightMeters,
    flowAccumulationAreaM2: new Float32Array(EVOLUTION_DOMAIN_SAMPLE_COUNT),
    lakeMask: new Uint8Array(EVOLUTION_DOMAIN_SAMPLE_COUNT),
    lakes: [],
    drainageBaseLevels: [],
    channelSeedTexelIndices: new Uint32Array(),
  };
  return cachedMacroFixture;
}

describe("Phase 5 bathymetry clipmap", () => {
  it("pins the two tier-independent R16F levels and their memory", () => {
    expect(BATHYMETRY_LEVELS.map((level) => level.texelMeters)).toEqual([
      BATHYMETRY_NEAR_TEXEL_METERS,
      BATHYMETRY_FAR_TEXEL_METERS,
    ]);
    expect(BATHYMETRY_LEVELS.map((level) => level.spanMeters)).toEqual([
      16_384,
      131_072,
    ]);
    expect(bathymetryClipmapBytes()).toBe(4 * 1_024 * 1_024);
    expect(BATHYMETRY_UPDATE_WGSL).toContain("texture_storage_2d<r16float, write>");
  });

  it("wraps negative coordinates without a signed-remainder seam", () => {
    expect(toroidalBathymetryTexel(-1, -1)).toEqual([
      BATHYMETRY_CLIPMAP_EDGE - 1,
      BATHYMETRY_CLIPMAP_EDGE - 1,
    ]);
    expect(toroidalBathymetryTexel(BATHYMETRY_CLIPMAP_EDGE, 0)).toEqual([0, 0]);
  });

  it("updates strips for a texel crossing and a full square after a teleport", () => {
    expect(bathymetryUpdateRectangles(0, 0, 1, -1)).toEqual([
      { minX: BATHYMETRY_CLIPMAP_EDGE, minZ: -1, width: 1, height: 1_024 },
      { minX: 1, minZ: -1, width: 1_024, height: 1 },
    ]);
    expect(bathymetryUpdateRectangles(0, 0, 2_000, 0)).toEqual([
      { minX: 2_000, minZ: 0, width: 1_024, height: 1_024 },
    ]);
  });

  it("uploads a canonical cell-centred macro authority and retains toroidal strip updates", () => {
    expect(BATHYMETRY_UPDATE_WGSL).toContain(
      "@group(0) @binding(3) var<storage, read> bathymetryMacroHeight",
    );
    expect(BATHYMETRY_UPDATE_WGSL).toContain("- vec2f(0.5)");
    expect(BATHYMETRY_UPDATE_WGSL).toContain("bathymetryParams.water.w > 0.5");
    expect(BATHYMETRY_UPDATE_WGSL).toContain(
      `BATHYMETRY_MACRO_BLEND_METERS: f32 = ${EVOLUTION_ANALYTIC_BLEND_METERS}.0`,
    );
    // Macro activation changes the producer, not the toroidal addressing or
    // strip-update theorem consumed by the two water materials.
    expect(BATHYMETRY_UPDATE_WGSL).toContain("positiveMod(globalTexel.x");
    expect(bathymetryUpdateRectangles(10, 20, 11, 20)).toEqual([{
      minX: 1_034,
      minZ: 20,
      width: 1,
      height: 1_024,
    }]);
  });

  it("samples canonical macro texels at cell centres and blends continuously at the rim", () => {
    const macro = macroFixture();
    const firstCenter = TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX
      + EVOLUTION_TEXEL_METERS * 0.5;
    expect(sampleBathymetryMacroHeight(macro, firstCenter, firstCenter)).toBe(10);
    expect(sampleBathymetryMacroHeight(
      macro,
      firstCenter + EVOLUTION_TEXEL_METERS * 0.5,
      firstCenter,
    )).toBe(20);
    expect(sampleBathymetryMacroHeight(
      macro,
      firstCenter + EVOLUTION_TEXEL_METERS * 0.5,
      firstCenter + EVOLUTION_TEXEL_METERS * 0.5,
    )).toBe(40);

    const analytic = 100;
    const rim = TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX;
    expect(sampleBathymetryTerrainAuthority("analytic", macro, 0, 0, analytic)).toBe(analytic);
    expect(sampleBathymetryTerrainAuthority("eroded", null, 0, 0, analytic)).toBe(analytic);
    expect(sampleBathymetryTerrainAuthority("eroded", macro, 0, 0, analytic)).toBe(20);
    expect(sampleBathymetryTerrainAuthority("eroded", macro, rim, 0, analytic)).toBe(analytic);
    expect(sampleBathymetryTerrainAuthority(
      "eroded",
      macro,
      rim + EVOLUTION_ANALYTIC_BLEND_METERS * 0.5,
      0,
      analytic,
    )).toBe(60);
    expect(sampleBathymetryTerrainAuthority(
      "eroded",
      macro,
      rim + EVOLUTION_ANALYTIC_BLEND_METERS,
      0,
      analytic,
    )).toBe(20);
    const justOutside = sampleBathymetryTerrainAuthority(
      "eroded", macro, rim - 0.01, 0, analytic,
    );
    const justInside = sampleBathymetryTerrainAuthority(
      "eroded", macro, rim + 0.01, 0, analytic,
    );
    expect(justOutside).toBe(analytic);
    expect(Math.abs(justInside - justOutside)).toBeLessThan(1e-6);
  });

  it("keeps analytic worlds unchanged and disposes activated macro state", async () => {
    const macro = macroFixture();
    const engine = new NullEngine();
    const analyticScene = new Scene(engine);
    const analytic = new BathymetryClipmap(
      analyticScene,
      createWorld(BATHYMETRY_AUTHORITY_SEED, {
        airport: false,
        worldEvolution: "analytic",
      }),
    );
    await analytic.initialize(0, 0);
    expect(analytic.isResident).toBe(true);
    analytic.setMacroEvolution(macro);
    expect(analytic.hasMacroEvolution).toBe(false);
    expect(analytic.isResident).toBe(true);
    analytic.dispose();

    const erodedScene = new Scene(engine);
    const eroded = new BathymetryClipmap(
      erodedScene,
      createWorld(BATHYMETRY_AUTHORITY_SEED, {
        airport: false,
        worldEvolution: "eroded",
      }),
    );
    await eroded.initialize(0, 0);
    eroded.setMacroEvolution(macro);
    expect(eroded.hasMacroEvolution).toBe(true);
    expect(eroded.isResident).toBe(false);
    await eroded.recenter(0, 0);
    expect(eroded.isResident).toBe(true);
    eroded.setMacroEvolution(null);
    expect(eroded.hasMacroEvolution).toBe(false);
    expect(eroded.isResident).toBe(false);
    await eroded.recenter(0, 0);
    expect(eroded.isResident).toBe(true);
    eroded.dispose();
    expect(eroded.isDisposed).toBe(true);
    expect(eroded.hasMacroEvolution).toBe(false);
    eroded.setMacroEvolution(macro);
    expect(eroded.hasMacroEvolution).toBe(false);
    expect(await eroded.recenter(0, 0)).toBe(false);
    // Upload is a copy, never a transfer from the canonical authority.
    expect(macro.heightMeters.byteLength).toBe(EVOLUTION_DOMAIN_SAMPLE_COUNT * 4);
    analyticScene.dispose();
    erodedScene.dispose();
    engine.dispose();
  });
});

describe("Phase 5 shared water-depth optics", () => {
  it("pins physical absorption, shoreline and underwater-interface constants", () => {
    expect(WATER_ABSORPTION_PER_METER).toEqual([0.45, 0.07, 0.02]);
    expect(WATER_SHORE_FADE_METERS).toBe(0.4);
    expect(WATER_AIR_INTERFACE_CRITICAL_ANGLE_DEGREES).toBe(48.6);
    expect(WATER_DEPTH_OPTICS_WGSL).toContain("smoothstep(0.0, WATER_SHORE_FADE_METERS, depth)");
    expect(WATER_DEPTH_OPTICS_WGSL).toContain("transmittedSin2 >= 1.0");
    expect(WATER_DEPTH_OPTICS_WGSL).toContain("applyUnderwaterBeerLambert");
    expect(WATER_DEPTH_OPTICS_WGSL).toContain("refract(-view, normal, 1.0 / 1.333)");
  });

  it("composes exactly the same depth include into both materials", () => {
    for (const shader of [WATER_FRAGMENT_WGSL, HYDROLOGY_WATER_FRAGMENT_WGSL]) {
      expect(shader).toContain(WATER_DEPTH_OPTICS_WGSL);
      expect(shader).toContain("waterDepthFromBathymetry");
      expect(shader).toContain("waterShorelineAlpha(depth)");
      expect(shader).toContain("cameraBelow");
    }
    expect(WATER_FRAGMENT_WGSL).not.toContain("deepAbsorption");
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).not.toContain("let riverBed");
    expect(HYDROLOGY_WATER_VERTEX_WGSL).toContain("6371000.0");
  });
});
