import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import {
  DYNAMIC_ALLOCATIONS,
  estimateGpuMemoryBreakdown,
} from "../src/render/webgpu/core/PerformanceBudget";
import {
  resolveWebGpuQualityProfile,
  type WebGpuQualityProfile,
} from "../src/render/webgpu/core/QualityProfile";
import type { QualityLevel } from "../src/game/types";
import type { RenderingMode } from "../src/settings";
import {
  GROUND_GRAIN_LAYER,
  surfaceArrayLayerIds,
} from "../src/render/webgpu/terrain/GroundGrainSynthesis";
import {
  LAND_COVER_CLASSIFIER_WGSL,
  LAND_COVER_SPLAT_BAKE_WGSL,
} from "../src/render/webgpu/terrain/LandCoverClassifier";
import {
  SURFACE_MATERIAL_BASE_COUNT,
  SURFACE_MATERIAL_COUNT,
  SURFACE_MATERIALS,
  SurfaceMaterial,
  type SurfaceMaterialId,
  volcanicFallbackMaterial,
} from "../src/render/webgpu/terrain/surfaceMaterials";
import {
  TERRAIN_BASE_SPARSE_SPLAT_GATHER_WGSL,
  TERRAIN_SPARSE_SPLAT_GATHER_WGSL,
  TerrainSurfacePlugin,
  terrainSparseSplatGatherWgsl,
} from "../src/render/webgpu/terrain/TerrainSurfacePlugin";

/**
 * Volcanic land, phase 2: Basalt and Tephra appended to the material axis.
 *
 * The splat stores a material id as `id / (count - 1)` in an rgba8unorm lane,
 * and both readers decode `floor(byte / 255 * (count - 1) + 0.5)`. Appending
 * two materials changes `count`, and so the byte every existing id is written
 * as. What must not change is the INTEGER every id decodes back to.
 */

const PREVIOUS_MATERIAL_COUNT = 10;

/** WebGPU's f32 -> unorm8 store: round to nearest, after clamping. */
function encodeUnorm8(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

/** The gather's decode, in f32 as the shader evaluates it. */
function decodeId(byte: number, count: number): number {
  const idScale = Math.fround(count - 1);
  const stored = Math.fround(byte / 255);
  const scaled = Math.fround(Math.fround(stored * idScale) + 0.5);
  return Math.min(idScale, Math.max(0, Math.floor(scaled)));
}

describe("volcanic materials (phase 2): the appended axis", () => {
  it("appends Basalt and Tephra after Concrete and moves no existing id", () => {
    expect(SURFACE_MATERIAL_COUNT).toBe(PREVIOUS_MATERIAL_COUNT + 2);
    expect(SURFACE_MATERIALS.slice(0, PREVIOUS_MATERIAL_COUNT).map((spec) => spec.name)).toEqual([
      "Sand", "Grass", "ForestFloor", "Shrub", "Rock", "Snow",
      "DryGrass", "Gravel", "Asphalt", "Concrete",
    ]);
    expect(SurfaceMaterial.Basalt).toBe(10);
    expect(SurfaceMaterial.Tephra).toBe(11);
  });

  it("decodes every splat id to the same integer with the new count", () => {
    // Margin first: a byte must move half a step to decode as a neighbour,
    // and quantisation moves it at most half a byte.
    expect(255 / (SURFACE_MATERIAL_COUNT - 1) / 2).toBeGreaterThan(1);
    for (let id = 0; id < SURFACE_MATERIAL_COUNT; id += 1) {
      const exact = (id / (SURFACE_MATERIAL_COUNT - 1)) * 255;
      // The rounded store, and both neighbouring bytes of the exact value, so
      // a store that truncates or rounds the other way decodes the same.
      for (const byte of new Set([
        encodeUnorm8(Math.fround(id * Math.fround(1 / (SURFACE_MATERIAL_COUNT - 1)))),
        Math.floor(exact),
        Math.ceil(exact),
      ])) {
        expect(decodeId(byte, SURFACE_MATERIAL_COUNT), `id ${id} stored as byte ${byte}`).toBe(id);
      }
    }
    // Ids that existed before the append decode as themselves, never as one
    // of the new materials, and never as each other.
    const decoded = Array.from({ length: PREVIOUS_MATERIAL_COUNT }, (_, id) =>
      decodeId(encodeUnorm8(id / (SURFACE_MATERIAL_COUNT - 1)), SURFACE_MATERIAL_COUNT));
    expect(decoded).toEqual(Array.from({ length: PREVIOUS_MATERIAL_COUNT }, (_, id) => id));
  });

  it("encodes and decodes with the same scale on both sides of the atlas", () => {
    // The bake writes ids * 1 / (LAND_COVER_COUNT - 1) and the classifier's
    // LAND_COVER_COUNT is the material count; the gather reads with
    // SURFACE_MATERIAL_COUNT - 1. One axis, both ends.
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain(
      `const LAND_COVER_COUNT: u32 = ${SURFACE_MATERIAL_COUNT}u;`);
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain("let scale = 1.0 / f32(LAND_COVER_COUNT - 1u);");
    expect(TERRAIN_SPARSE_SPLAT_GATHER_WGSL).toContain(
      `let idScale = f32(${SURFACE_MATERIAL_COUNT - 1});`);
  });

  it("generates the gather for any prefix of the axis, decoding over the whole axis", () => {
    const base = terrainSparseSplatGatherWgsl(PREVIOUS_MATERIAL_COUNT);
    expect(base).toContain(`let idScale = f32(${SURFACE_MATERIAL_COUNT - 1});`);
    expect(base.match(/if \(candidateWeight > primaryWeight\)/gu)).toHaveLength(
      PREVIOUS_MATERIAL_COUNT);
    // Basalt and Tephra share the third bucket's unused lanes there: they
    // accumulate, but no candidate reads them.
    expect(base).not.toContain(`candidateId = ${SurfaceMaterial.Basalt}u;`);
    expect(TERRAIN_SPARSE_SPLAT_GATHER_WGSL).toBe(
      terrainSparseSplatGatherWgsl(SURFACE_MATERIAL_COUNT));
    expect(TERRAIN_SPARSE_SPLAT_GATHER_WGSL.match(/if \(candidateWeight > primaryWeight\)/gu))
      .toHaveLength(SURFACE_MATERIAL_COUNT);
    expect(TERRAIN_SPARSE_SPLAT_GATHER_WGSL).toContain(`candidateId = ${SurfaceMaterial.Tephra}u;`);
    expect(() => terrainSparseSplatGatherWgsl(SURFACE_MATERIAL_COUNT + 1)).toThrow(RangeError);
    expect(() => terrainSparseSplatGatherWgsl(1)).toThrow(RangeError);
  });
});

const VIEWPORT = { cssWidth: 1_280, cssHeight: 720, devicePixelRatio: 1 };
/** One resolved profile per tier, lowest first. */
const PROFILES: readonly WebGpuQualityProfile[] = (() => {
  const byTier = new Map<number, WebGpuQualityProfile>();
  for (const quality of ["low", "medium", "high"] as const satisfies readonly QualityLevel[]) {
    for (const mode of ["performance", "balanced", "ultra"] as const satisfies readonly RenderingMode[]) {
      const profile = resolveWebGpuQualityProfile(quality, mode);
      if (!byTier.has(profile.tier)) byTier.set(profile.tier, profile);
    }
  }
  return [...byTier.keys()].sort((a, b) => a - b).map((tier) => byTier.get(tier)!);
})();

describe("volcanic materials (phase 2): tier 0 carries none", () => {
  it("is a profile datum, off at tier 0 only", () => {
    expect(PROFILES.map((profile) => [profile.tier, profile.volcanicMaterials])).toEqual([
      [0, false], [1, true], [2, true], [3, true],
    ]);
  });

  it("builds tier 0's arrays with the ten layers it had, and every other tier's with all", () => {
    expect(SURFACE_MATERIAL_BASE_COUNT).toBe(SurfaceMaterial.Basalt);
    expect(surfaceArrayLayerIds(false, false)).toEqual(
      Array.from({ length: SURFACE_MATERIAL_BASE_COUNT }, (_, id) => id));
    for (const profile of PROFILES) {
      const ids = surfaceArrayLayerIds(profile.terrainGroundPatchwork, profile.volcanicMaterials);
      const expected = profile.volcanicMaterials || profile.terrainGroundPatchwork
        ? SURFACE_MATERIAL_COUNT
        : SURFACE_MATERIAL_BASE_COUNT;
      expect(ids.filter((id) => id !== GROUND_GRAIN_LAYER), `tier ${profile.tier}`)
        .toHaveLength(expected);
    }
  });

  it("budgets exactly the layers each tier builds", () => {
    const layerMiB = (profile: (typeof PROFILES)[number]): number =>
      estimateGpuMemoryBreakdown(profile, VIEWPORT).materialArraysMiB;
    const low = PROFILES[0]!;
    // Tier 0 at 10 layers; switching the datum on adds exactly the pair.
    const lowWith = layerMiB({ ...low, volcanicMaterials: true });
    expect(lowWith / layerMiB(low)).toBeCloseTo(
      DYNAMIC_ALLOCATIONS.materialArrayLayers
        / (DYNAMIC_ALLOCATIONS.materialArrayLayers - DYNAMIC_ALLOCATIONS.volcanicMaterialLayers),
      9);
    // Where the grain is built the pair stays whatever the datum says.
    const medium = PROFILES[1]!;
    expect(layerMiB({ ...medium, volcanicMaterials: false })).toBe(layerMiB(medium));
  });

  it("remaps volcanic ids to the nearest shipped material, and nothing else", () => {
    expect(volcanicFallbackMaterial(SurfaceMaterial.Basalt)).toBe(SurfaceMaterial.Rock);
    expect(volcanicFallbackMaterial(SurfaceMaterial.Tephra)).toBe(SurfaceMaterial.Gravel);
    for (let id = 0; id < SURFACE_MATERIAL_BASE_COUNT; id += 1) {
      expect(volcanicFallbackMaterial(id as SurfaceMaterialId)).toBe(id);
    }
  });

  it("compiles tier 0's gather with today's candidates, by define", () => {
    expect(TERRAIN_BASE_SPARSE_SPLAT_GATHER_WGSL.match(/if \(candidateWeight > primaryWeight\)/gu))
      .toHaveLength(SURFACE_MATERIAL_BASE_COUNT);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const material = new PBRMaterial("volcanic-define-test", scene);
    const plugin = new TerrainSurfacePlugin(material);
    try {
      const defines: Record<string, boolean> = {};
      plugin.prepareDefines(defines as never);
      expect(defines["TERRAIN_SURFACE_VOLCANIC"]).toBe(true);
      plugin.setVolcanicMaterials(false);
      plugin.prepareDefines(defines as never);
      expect(defines["TERRAIN_SURFACE_VOLCANIC"]).toBe(false);
      const code = Object.values(
        plugin.getCustomCode("fragment", ShaderLanguage.WGSL) as Record<string, string>).join("\n");
      const guard = code.indexOf("#ifdef TERRAIN_SURFACE_VOLCANIC");
      const otherwise = code.indexOf("#else", guard);
      const close = code.indexOf("#endif", otherwise);
      expect(guard).toBeGreaterThan(-1);
      expect(code.slice(guard, otherwise)).toContain(TERRAIN_SPARSE_SPLAT_GATHER_WGSL);
      expect(code.slice(otherwise, close)).toContain(TERRAIN_BASE_SPARSE_SPLAT_GATHER_WGSL);
      // One definition of the function per branch, and none outside them.
      expect(code.match(/fn terrainSurfaceSparseSplat\(/gu)).toHaveLength(2);
    } finally {
      material.dispose(true, true);
      scene.dispose();
      engine.dispose();
    }
  });
});
