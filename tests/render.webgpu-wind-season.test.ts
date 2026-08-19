import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Scene } from "@babylonjs/core/scene";
import { seasonalWinterFraction } from "../src/world";
import { TerrainBiome } from "../src/world";
import { DetailInstanceMaterialPlugin } from "../src/render/webgpu/detail/DetailInstanceMaterialPlugin";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import type { DetailTerrainSample } from "../src/render/webgpu/detail/types";

/**
 * 2-13 / 2-13a — the wind and season surfaces that are pure code: the
 * three-band WGSL and its wind uniform contract, and the seasonal crown
 * (autumn hue turn, leaf fall in the tint alpha lane, canopy snow) driven
 * by R-13's anchored kernel through generation.
 */

const LATITUDE = 45;

function findDayWithWinterFraction(target: number): number {
  let bestDay = 171;
  let bestError = Number.POSITIVE_INFINITY;
  for (let day = 1; day <= 365; day += 1) {
    const error = Math.abs(seasonalWinterFraction(day, LATITUDE) - target);
    if (error < bestError) {
      bestError = error;
      bestDay = day;
    }
  }
  return bestDay;
}

function forestSampler(height: number): (x: number, z: number) => DetailTerrainSample {
  return () => ({
    height,
    slope: 0.05,
    moisture: 0.6,
    biome: height > 1_200 ? TerrainBiome.HIGHLAND : TerrainBiome.FOREST,
    normal: { x: 0, y: 1, z: 0 },
  });
}

function collectTrees(dayOfYear: number, height = 320) {
  const trees = [];
  for (let cellZ = 0; cellZ < 4; cellZ += 1) {
    for (let cellX = 0; cellX < 4; cellX += 1) {
      const cell = generateDetailCell({
        worldSeed: "wind-season",
        cellX,
        cellZ,
        cellSizeMeters: 128,
        densityMultiplier: 1,
        terrainSample: forestSampler(height),
        seaLevelMeters: 0,
        dayOfYear,
        latitudeDegrees: LATITUDE,
      });
      trees.push(...cell.trees);
    }
  }
  return trees;
}

const DECIDUOUS = new Set(["oak", "maple", "birch", "willow"]);
const CONIFERS = new Set(["pine", "cedar", "spruce"]);

function hueOf(color: readonly [number, number, number, number]): number {
  const [r, g, b] = color;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  return ((hue / 6) + 1) % 1;
}

describe("three-band wind plugin surface (2-13)", () => {
  it("carries all three bands and the wind uniform contract", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const material = new PBRMaterial("wind-test", scene);
      const plugin = new DetailInstanceMaterialPlugin(material);

      const vertex = plugin.getCustomCode("vertex", ShaderLanguage.WGSL)!;
      const positionCode = vertex["CUSTOM_VERTEX_UPDATE_POSITION"]!;
      expect(positionCode).toContain("Band 1 — trunk sway");
      expect(positionCode).toContain("Band 2 — branch flex");
      expect(positionCode).toContain("Band 3 — leaf flutter");
      expect(positionCode).toContain("uniforms.detailWind");
      const uniformNames = plugin.getUniforms().ubo.map((entry) => entry.name);
      expect(uniformNames).toContain("detailWind");

      // The fragment sheds leaves by uv-cell dissolve from the tint's alpha
      // lane (a threshold lift cannot drop painted leaves — interiors carry
      // alpha ≈ 1; the 2-17 bake measured 17.1% → 16.3%).
      const fragment = plugin.getCustomCode("fragment", ShaderLanguage.WGSL)!;
      expect(fragment["CUSTOM_FRAGMENT_UPDATE_ALBEDO"]).toContain("detailLeafHash");
      expect(fragment["CUSTOM_FRAGMENT_UPDATE_ALBEDO"]).toContain(
        "clamp(fragmentInputs.detailInstanceTint.a, 0.0, 1.0)",
      );

      // setWind normalizes direction and clamps strength/gust into [0, 1].
      plugin.setWind(3, 4, 2.5, -1);
      const writes = new Map<string, readonly number[]>();
      plugin.bindForSubMesh({
        updateFloat: (name: string, value: number) => writes.set(name, [value]),
        updateFloat4: (name: string, x: number, y: number, z: number, w: number) =>
          writes.set(name, [x, y, z, w]),
      } as never);
      const wind = writes.get("detailWind")!;
      expect(wind[0]).toBeCloseTo(0.6, 5);
      expect(wind[1]).toBeCloseTo(0.8, 5);
      expect(wind[2]).toBe(1);
      expect(wind[3]).toBe(0);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});

describe("seasonal crown (2-13a)", () => {
  it("holds the tuned midsummer world at the reference day", () => {
    const trees = collectTrees(171);
    expect(trees.length).toBeGreaterThan(200);
    for (const tree of trees) {
      expect(tree.color[3], tree.species).toBeGreaterThan(0.9);
    }
  });

  it("sheds deciduous crowns in deep winter while conifers hold", () => {
    const deepWinterDay = findDayWithWinterFraction(1);
    const trees = collectTrees(deepWinterDay);
    const deciduous = trees.filter((tree) => DECIDUOUS.has(tree.species));
    const conifers = trees.filter((tree) => CONIFERS.has(tree.species));
    expect(deciduous.length).toBeGreaterThan(60);
    expect(conifers.length).toBeGreaterThan(60);
    const bareShare = deciduous.filter((tree) => tree.color[3] < 0.25).length
      / deciduous.length;
    // Phenology jitter means a few stragglers hold longer; most shed.
    expect(bareShare).toBeGreaterThan(0.8);
    for (const tree of conifers) {
      expect(tree.color[3], tree.species).toBeGreaterThan(0.9);
    }
  });

  it("turns deciduous hues toward amber in autumn, leaves mostly on", () => {
    const autumnDay = findDayWithWinterFraction(0.3);
    const summer = collectTrees(171).filter((tree) => DECIDUOUS.has(tree.species));
    const autumn = collectTrees(autumnDay).filter((tree) => DECIDUOUS.has(tree.species));
    const meanHue = (group: typeof summer) =>
      group.reduce((sum, tree) => sum + hueOf(tree.color), 0) / group.length;
    // Green sits near 0.28 turns, amber near 0.08 — autumn pulls the mean
    // down by well over the stand-to-stand noise.
    expect(meanHue(autumn)).toBeLessThan(meanHue(summer) - 0.03);
    const leafyShare = autumn.filter((tree) => tree.color[3] > 0.6).length / autumn.length;
    expect(leafyShare).toBeGreaterThan(0.5);
  });

  it("whitens crowns under the descended snowline, shedding on steep ground", () => {
    // The deep-winter snowline at 45°N descends to ~84 m ASL, so the same
    // 320 m forest is green in summer and snow-whitened in deep winter.
    const deepWinterDay = findDayWithWinterFraction(1);
    const winter = collectTrees(deepWinterDay).filter((tree) => CONIFERS.has(tree.species));
    const summer = collectTrees(171).filter((tree) => CONIFERS.has(tree.species));
    expect(winter.length).toBeGreaterThan(60);
    const minChannel = (color: readonly [number, number, number, number]) =>
      Math.min(color[0], color[1], color[2]);
    const meanMin = (group: typeof winter) =>
      group.reduce((sum, tree) => sum + minChannel(tree.color), 0) / group.length;
    expect(meanMin(winter)).toBeGreaterThan(meanMin(summer) + 0.15);
    // The slope-shedding weight is untestable through generation: the
    // density field stops growing trees above slope ~0.2, far below the
    // 0.55 shedding threshold — the term exists to match seasonalSnowCover's
    // ground rule and becomes live on 2-15's rocks, which do reach 0.9.
  });
});
