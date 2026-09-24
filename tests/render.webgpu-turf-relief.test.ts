import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { SWARD_RELIEF_WAVELENGTHS_METERS } from "@/src/render/webgpu/terrain/SwardRelief";
import { SURFACE_MATERIAL_COUNT, SurfaceMaterial } from "@/src/render/webgpu/terrain/surfaceMaterials";
import {
  TERRAIN_SEAM_SWARD_COVER_MINIMUM,
  TerrainSurfacePlugin,
} from "@/src/render/webgpu/terrain/TerrainSurfacePlugin";
import {
  TERRAIN_TURF_RELIEF_WGSL,
  TURF_RELIEF_ALPINE_HIGH_METERS,
  TURF_RELIEF_ALPINE_LOW_METERS,
  TURF_RELIEF_GENTLE_HIGH,
  TURF_RELIEF_GENTLE_LOW,
  TURF_RELIEF_RANGE_HIGH_METERS,
  TURF_RELIEF_RANGE_LOW_METERS,
  TURF_RELIEF_STRENGTH,
  TURF_RELIEF_SWARD_COVER_MINIMUM,
  terrainTurfMesoGainTerm,
  terrainTurfMesoGainWgsl,
  turfReliefShareOf,
} from "@/src/render/webgpu/terrain/TurfRelief";

/**
 * `D-5` — more of the meso band on alpine turf. What a frame cannot show: a
 * gate that admits forest floor, scree or snow puts the stronger band under
 * trees and on talus; an alpine ramp or slope limit that drifts from the
 * classifier's reaches lowland or rock; a share read off the blend weights
 * rather than off what the seam feather draws leaks onto an untrusted scree
 * primary; a gain declared outside the meso block, or multiplied into the
 * wrong line, is either dead or re-tunes every meadow; and a dial that does
 * not fold the term away is not a rollback.
 */
function fragmentSource(): string {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const material = new PBRMaterial("turf-relief-test", scene);
  const plugin = new TerrainSurfacePlugin(material);
  const source = Object.values(
    plugin.getCustomCode("fragment", ShaderLanguage.WGSL) ?? {}).join("\n");
  material.dispose(true, true);
  scene.dispose();
  engine.dispose();
  return source;
}

/** Index of the brace that closes the block opened at `open`. */
function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

describe("D-5 the gate", () => {
  it("counts only sward: grass, dry grass and heath, by the seam feather's own threshold", () => {
    expect(TURF_RELIEF_SWARD_COVER_MINIMUM).toBe(TERRAIN_SEAM_SWARD_COVER_MINIMUM);
    const shaded = Array.from({ length: SURFACE_MATERIAL_COUNT }, (_, id) => id)
      .filter((id) => turfReliefShareOf(id) > 0)
      .sort((a, b) => a - b);
    expect(shaded).toEqual(
      [SurfaceMaterial.Grass, SurfaceMaterial.Shrub, SurfaceMaterial.DryGrass].sort((a, b) => a - b));
    for (const excluded of [
      SurfaceMaterial.ForestFloor, SurfaceMaterial.Gravel, SurfaceMaterial.Rock,
      SurfaceMaterial.Snow, SurfaceMaterial.Sand, SurfaceMaterial.Asphalt, SurfaceMaterial.Concrete,
    ]) {
      expect(turfReliefShareOf(excluded)).toBe(0);
      expect(TERRAIN_TURF_RELIEF_WGSL).not.toContain(`if (materialIndex == ${excluded}) { return 1.0; }`);
    }
    for (const id of shaded) {
      expect(TERRAIN_TURF_RELIEF_WGSL).toContain(`if (materialIndex == ${id}) { return 1.0; }`);
    }
  });

  it("reads the classifier's own alpine ramp and stops where the classifier's rock begins", () => {
    const classifier = readFileSync(
      join(__dirname, "..", "src", "render", "webgpu", "terrain", "LandCoverClassifier.ts"), "utf8");
    // Both twins of the classifier, so neither can drift away from this gate.
    expect(classifier).toContain(
      `smoothstep(${TURF_RELIEF_ALPINE_LOW_METERS}, ${TURF_RELIEF_ALPINE_HIGH_METERS}, elevation)`);
    expect(classifier).toContain(
      `kSmoothstep(${TURF_RELIEF_ALPINE_LOW_METERS}.0, ${TURF_RELIEF_ALPINE_HIGH_METERS}.0, elevation)`);
    expect(classifier).toContain(`smoothstep(${TURF_RELIEF_GENTLE_HIGH}, 0.58, slope)`);
    expect(TURF_RELIEF_GENTLE_LOW).toBeLessThan(TURF_RELIEF_GENTLE_HIGH);
  });

  it("fades in only as D-3's coarsest octave fades out", () => {
    const d3Coarsest = Math.max(...SWARD_RELIEF_WAVELENGTHS_METERS);
    expect(TURF_RELIEF_RANGE_LOW_METERS).toBeGreaterThanOrEqual(d3Coarsest * 0.125);
    expect(TURF_RELIEF_RANGE_HIGH_METERS).toBeGreaterThanOrEqual(d3Coarsest * 0.34);
  });

  it("carries every factor of the gate, and folds to nothing at strength 0", () => {
    for (const strength of [0, -1, Number.NaN]) {
      expect(terrainTurfMesoGainWgsl(strength)).toBe("");
      expect(terrainTurfMesoGainTerm(strength)).toBe("");
    }
    expect(terrainTurfMesoGainWgsl(1)).toMatch(
      /let terrainTurfMesoGain = 1\.0 \+ 1\.0 \* terrainTurfCover\s+\* \(1\.0 - terrainGroundAirfield\)\s+\* \(1\.0 - clamp\(terrainGroundCanopyClosure, 0\.0, 1\.0\)\)\s+\* smoothstep\(420\.0, 980\.0,\s+terrainElevationDriver\)\s+\* \(1\.0 - smoothstep\(0\.16, 0\.24, terrainSlope\)\)\s+\* smoothstep\(0\.6, 2\.0,\s+terrainFootprint3D\)\s+\* terrainGroundPatchworkOn;/u);
    expect(terrainTurfMesoGainWgsl(2)).toContain("let terrainTurfMesoGain = 1.0 + 2.0 * terrainTurfCover");
    expect(terrainTurfMesoGainTerm(1)).toBe(" * terrainTurfMesoGain");
    // The owner's choice: A, the band doubled on alpine turf.
    expect(TURF_RELIEF_STRENGTH).toBe(1);
  });
});

describe("D-5 in the fragment", () => {
  it("is declared inside the meso block and multiplies exactly the band's slope and tone", () => {
    const source = fragmentSource();
    const meso = source.indexOf("if (terrainMesoWeightA > 0.001) {");
    expect(meso).toBeGreaterThan(0);
    const mesoEnd = matchingBrace(source, source.indexOf("{", meso));
    const gain = source.indexOf("let terrainTurfMesoGain = ");
    const slope = source.indexOf("let terrainMesoSlope = (");
    expect([...source.matchAll(/let terrainTurfMesoGain = /gu)]).toHaveLength(1);
    expect(gain).toBeGreaterThan(meso);
    expect(gain).toBeLessThan(slope);
    expect(slope).toBeLessThan(mesoEnd);
    expect(source).toContain(
      "+ 0.9 * terrainSteep) * terrainTurfMesoGain;\n  terrainNormal = normalize(terrainNormal)\n"
      + "    + vec3f(-terrainMesoSlope.x, 0.0, -terrainMesoSlope.y);");
    expect(source).toContain(
      "terrainAlbedo *= terrainMesoHue * (1.0 + terrainMesoTone * terrainTurfMesoGain) * terrainMesoWeightA");
    expect([...source.matchAll(/terrainTurfMesoGain\b/gu)]).toHaveLength(3);
    // The octaves this replaced are gone, and nothing else re-enters them.
    expect(source).not.toContain("terrainTurfReliefAt");
  });

  it("reads only values declared above the meso block", () => {
    const source = fragmentSource();
    const gain = source.indexOf("let terrainTurfMesoGain = ");
    for (const declaration of [
      /(let|var) terrainTurfCover = /u,
      /(let|var) terrainGroundAirfield = /u,
      /terrainGroundCanopyClosure = terrainSurfaceCanopyClosure\(terrainPageUv\);/u,
      /let terrainGroundPatchworkOn = /u,
      /let terrainElevationDriver = /u,
      /let terrainFootprint3D = /u,
    ]) {
      const at = source.search(declaration);
      expect(at, String(declaration)).toBeGreaterThan(0);
      expect(at, String(declaration)).toBeLessThan(gain);
    }
    expect([...source.matchAll(/var terrainGroundCanopyClosure = /gu)]).toHaveLength(1);
  });

  it("reads the sward share of what is DRAWN, re-targeted inside the seam feather", () => {
    const source = fragmentSource();
    expect([...source.matchAll(/(let|var) terrainTurfCover = /gu)]).toHaveLength(2);
    expect(source).toContain("var terrainTurfCover = terrainTurfShareOf(i32(terrainLowerId)) * terrainBlend0\n"
      + "  + terrainTurfShareOf(i32(terrainUpperId)) * terrainBlend1;");
    expect(source).toContain("let terrainTurfCover = terrainTurfShareOf(i32(terrainPrimaryId)) * terrainBlend0;");
    const feather = source.indexOf("if (terrainUsePageSplat && terrainClassStrength < 0.996) {");
    const featherEnd = matchingBrace(source, source.indexOf("{", feather));
    const retarget = source.indexOf("terrainTurfCover = mix(", feather);
    expect(feather).toBeGreaterThan(0);
    expect(retarget).toBeGreaterThan(feather);
    expect(retarget).toBeLessThan(featherEnd);
    expect(source.slice(retarget, featherEnd)).toMatch(
      /terrainTurfCover = mix\(\s+\(terrainTurfShareOf\(i32\(terrainLowerId\)\) \* \(1\.0 - terrainSeamPair\)\s+\+ terrainTurfShareOf\(i32\(terrainUpperId\)\) \* terrainSeamPair\) \* \(1\.0 - terrainSeamThird\),\s+terrainTurfCover, terrainClassStrength\);/u);
  });

  it("keeps every house trap shut and every brace matched", () => {
    const source = fragmentSource();
    const own = TERRAIN_TURF_RELIEF_WGSL + terrainTurfMesoGainWgsl(1);
    expect(own).not.toContain("`");
    expect(own).not.toMatch(/fract\(sin\(|fwidth\(|dpdx\(|dpdy\(|textureSample/u);
    for (const match of TERRAIN_TURF_RELIEF_WGSL.matchAll(/\bfn\s+(\w+)/gu)) {
      expect(match[1]).toMatch(/^terrainTurf/u);
    }
    const opens = [...source.matchAll(/\{/gu)].length;
    const closes = [...source.matchAll(/\}/gu)].length;
    expect(opens).toBe(closes);
  });
});
