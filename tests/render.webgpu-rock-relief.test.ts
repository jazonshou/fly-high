import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { groundNoiseGradient } from "@/src/render/webgpu/terrain/GroundPatchwork";
import {
  ROCK_CRAG_CREASE_MEANS,
  ROCK_CRAG_CREASE_SHARES,
  ROCK_CRAG_CUSPS,
  ROCK_BOUNDARY_LOGIT_LIMIT,
  ROCK_BOUNDARY_SHARES,
  ROCK_BOUNDARY_SLOPE_LIMIT,
  ROCK_CRAG_COARSE_OCTAVES,
  ROCK_CRAG_DEPTH_RATIOS,
  ROCK_CRAG_OCTAVE_SIGNS,
  ROCK_CRAG_VERTICAL_STRETCH,
  ROCK_CRAG_WAVELENGTHS_METERS,
  ROCK_RELIEF_GRAVEL_SHARE,
  TERRAIN_ROCK_RELIEF_WGSL,
  rockBoundaryPushedShare,
  rockCragBillow,
  rockCragCrease,
  rockReliefShareOf,
} from "@/src/render/webgpu/terrain/RockRelief";
import { SurfaceMaterial } from "@/src/render/webgpu/terrain/surfaceMaterials";
import { TerrainSurfacePlugin } from "@/src/render/webgpu/terrain/TerrainSurfacePlugin";

/**
 * `M-2` — rock relief's arithmetic, and the house rules its WGSL has to keep.
 *
 * What is pinned here is what a frame cannot show: a tone whose mean is not one
 * relights every mountain through the scene-mean bounce; a billow whose
 * derivative disagrees with its value lights a crease from the wrong side; and
 * a field keyed on altitude is the black horizontal lines this wave removed,
 * back under a new name.
 */
function walk(count: number, evaluate: (noise: number, dx: number, dy: number) => void): void {
  for (let index = 0; index < count; index += 1) {
    const x = ((index * 0.754_877_666_2) % 1) * 4_096 - 2_048;
    const y = ((index * 0.569_840_290_9) % 1) * 4_096 - 2_048;
    const [noise, dx, dy] = groundNoiseGradient(x, y, 0x71);
    evaluate(noise, dx, dy);
  }
}

describe("M-2 the crag field", () => {
  it("carries, per octave, the mean its tone and occlusion subtract", () => {
    const count = 120_000;
    ROCK_CRAG_CUSPS.forEach((cusp, octave) => {
      let line = 0;
      walk(count, (noise) => {
        line += rockCragCrease(rockCragBillow(noise, cusp).billow);
      });
      expect(Math.abs(line / count - ROCK_CRAG_CREASE_MEANS[octave]!), `octave ${octave}`)
        .toBeLessThan(0.006);
      // Lines are EVENTS on a face, not half of it.
      expect(ROCK_CRAG_CREASE_MEANS[octave]!).toBeLessThan(0.25);
    });
    // Seen from kilometres the coarse octaves must not sparkle; seen close the
    // fine ones must not look melted. Sharper with scale, never a knife.
    expect(ROCK_CRAG_CUSPS.at(-1)!).toBeLessThan(ROCK_CRAG_CUSPS[0]!);
    expect(Math.min(...ROCK_CRAG_CUSPS)).toBeGreaterThan(0.04);
  });

  it("returns the derivative of the billow it returns", () => {
    for (const noise of [-1.7, -0.4, -0.05, 0.02, 0.3, 1.2]) {
      const step = 1e-6;
      const numeric = (rockCragBillow(noise + step, 0.1).billow
        - rockCragBillow(noise - step, 0.1).billow) / (2 * step);
      expect(rockCragBillow(noise, 0.1).slopeFactor).toBeCloseTo(numeric, 5);
    }
    // Rounded, not a knife: the slope passes through zero ON the crease.
    expect(rockCragBillow(0, 0.1).slopeFactor).toBe(0);
    expect(rockCragBillow(0, 0.1).billow).toBe(0.1);
  });

  it("flips its block tone across every crease and nowhere else", () => {
    // The crease is the noise's zero set, so the sign of the block tone differs
    // on its two sides by construction. That is what makes adjacent blocks read
    // as different faces rather than one face with cracks drawn on it.
    expect(rockCragCrease(rockCragBillow(0, 0.18).billow)).toBeGreaterThan(0.6);
    expect(rockCragCrease(rockCragBillow(0.6, 0.18).billow)).toBe(0);
    expect(rockCragCrease(rockCragBillow(-0.6, 0.18).billow)).toBe(0);
  });

  it("uses octaves no two of which register, with a grain that runs downslope", () => {
    const wavelengths = ROCK_CRAG_WAVELENGTHS_METERS;
    for (let first = 0; first < wavelengths.length; first += 1) {
      for (let second = first + 1; second < wavelengths.length; second += 1) {
        const ratio = wavelengths[first]! / wavelengths[second]!;
        expect(Math.abs(ratio - Math.round(ratio)), `${wavelengths[first]} / ${wavelengths[second]}`)
          .toBeGreaterThan(0.15);
      }
    }
    // Rock breaks along convex edges as well as concave creases: billow alone
    // was shot and reads as melted wax.
    expect(new Set(ROCK_CRAG_OCTAVE_SIGNS).size).toBe(2);
    expect(ROCK_CRAG_VERTICAL_STRETCH).toBeGreaterThan(1.5);
    // Anisotropy past ~3 is where a crag field turns back into stripes.
    expect(ROCK_CRAG_VERTICAL_STRETCH).toBeLessThan(3);
    expect(ROCK_CRAG_CREASE_SHARES.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 12);
    // Relief per wavelength is what made the MASSIFS needles; hold it here too,
    // and keep the big forms broad rather than deep.
    expect(Math.max(...ROCK_CRAG_DEPTH_RATIOS)).toBeLessThan(0.12);
    expect(ROCK_CRAG_DEPTH_RATIOS[0]!).toBeLessThan(ROCK_CRAG_DEPTH_RATIOS[2]!);
    // A face needs a hierarchy: a few big forms with detail inside them.
    expect(ROCK_CRAG_WAVELENGTHS_METERS[0]! / ROCK_CRAG_WAVELENGTHS_METERS[2]!).toBeGreaterThan(4);
    expect(ROCK_CRAG_COARSE_OCTAVES).toBe(3);
  });
});

describe("M-2 the material axis and the WGSL it emits", () => {
  it("reads bedrock fully, scree in part, and nothing else", () => {
    expect(rockReliefShareOf(SurfaceMaterial.Rock)).toBe(1);
    expect(rockReliefShareOf(SurfaceMaterial.Gravel)).toBe(ROCK_RELIEF_GRAVEL_SHARE);
    for (const id of [SurfaceMaterial.Grass, SurfaceMaterial.Snow, SurfaceMaterial.Sand,
      SurfaceMaterial.Asphalt, SurfaceMaterial.Concrete, SurfaceMaterial.DryGrass]) {
      expect(rockReliefShareOf(id)).toBe(0);
    }
  });

  it("keeps every house trap shut", () => {
    const source = TERRAIN_ROCK_RELIEF_WGSL;
    expect(source).not.toContain("`");
    expect(source).not.toMatch(/fract\(sin\(/u);
    expect(source).not.toMatch(/fwidth\(/u);
    expect(source).not.toMatch(/textureSample\(/u);
    // Reserved words that have each cost this shader a compile cycle, plus the
    // ones this file's own vocabulary sits next to.
    for (const word of ["sample", "patch", "coherent", "smooth", "target", "filter", "partition"]) {
      expect(source).not.toMatch(new RegExp(`\\b(let|var|fn)\\s+${word}\\b`, "u"));
    }
    // No reversed numeric smoothstep (it degenerates into a hard step).
    for (const match of source.matchAll(/smoothstep\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,/gu)) {
      expect(Number(match[2])).toBeGreaterThan(Number(match[1]));
    }
    // Every function carries the terrain prefix (R-3F).
    for (const match of source.matchAll(/\bfn\s+(\w+)/gu)) {
      expect(match[1]).toMatch(/^terrain(Rock|Snow)/u);
    }
  });

  it("pushes the rock/turf boundary without conjuring rock out of pure ground", () => {
    // Zero and one are fixed points, whatever the push: a pair the classifier
    // calls pure stays pure, so a tongue can only grow from rock that is there.
    for (const push of [-ROCK_BOUNDARY_LOGIT_LIMIT * 3, -1, 0, 1, ROCK_BOUNDARY_LOGIT_LIMIT * 3]) {
      expect(rockBoundaryPushedShare(0, push)).toBe(0);
      expect(rockBoundaryPushedShare(1, push)).toBe(1);
      expect(rockBoundaryPushedShare(0.001, push)).toBe(0.001);
    }
    // No push, no change; and the push is monotone and antisymmetric about a half.
    for (const share of [0.03, 0.2, 0.5, 0.8, 0.97]) {
      expect(rockBoundaryPushedShare(share, 0)).toBeCloseTo(share, 12);
      expect(rockBoundaryPushedShare(share, 2)).toBeGreaterThan(share);
      expect(rockBoundaryPushedShare(share, -2)).toBeLessThan(share);
      expect(rockBoundaryPushedShare(share, 2) + rockBoundaryPushedShare(1 - share, -2))
        .toBeCloseTo(1, 12);
    }
    // Continuous where the pure gate opens: no contour drawn at the threshold.
    expect(rockBoundaryPushedShare(0.0021, 5) - 0.0021).toBeLessThan(0.002);
    // It is what reaches a share the additive push (limited to 0.45 of a ramp
    // one texel wide) could not: a 3 % share carried past a half.
    expect(rockBoundaryPushedShare(0.03, 4)).toBeGreaterThan(0.5);
    // Weighted toward the octaves a tongue is the size of, not the massif's.
    expect(ROCK_BOUNDARY_SHARES.at(-1)!).toBeGreaterThan(ROCK_BOUNDARY_SHARES[0]!);
    expect(ROCK_BOUNDARY_SHARES).toHaveLength(ROCK_CRAG_COARSE_OCTAVES);
    // On the fallback's slope driver, under half its 0.30-0.66 window, so level
    // ground can never be pushed into rock nor a cliff out of it.
    expect(ROCK_BOUNDARY_SLOPE_LIMIT).toBeLessThan(0.18);
  });

  it("draws nothing that is a function of altitude alone", () => {
    // The defect the owner named: "weird black horizontal lines on some side
    // faces". World Y may enter ONLY as the vertical axis of a 2D plane, paired
    // with a horizontal coordinate; a term of `position.y` by itself is a
    // contour line however it is dressed.
    const relief = TERRAIN_ROCK_RELIEF_WGSL;
    const yUses = [...relief.matchAll(/position\.y/gu)].length;
    const planeCalls = [...relief.matchAll(
      /terrainRockCragPlane(?:Coarse|Fine)\(position\.[xz], position\.y,/gu)].length;
    expect(planeCalls).toBe(4);
    expect(yUses).toBe(planeCalls);

    const engine = new NullEngine();
    const scene = new Scene(engine);
    const material = new PBRMaterial("rock-relief-test", scene);
    const plugin = new TerrainSurfacePlugin(material);
    const source = Object.values(
      plugin.getCustomCode("fragment", ShaderLanguage.WGSL) ?? {}).join("\n");
    material.dispose(true, true);
    scene.dispose();
    engine.dispose();
    expect(source).toContain("terrainRockReliefAt(");
    expect(source).not.toContain("terrainStrata");
    expect(source).not.toMatch(/terrainAbsolutePosition\.y \* 0\.1111/u);
  });
});
