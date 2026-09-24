import { describe, expect, it } from "vitest";
import {
  SWARD_TILING_BAND_KEEP,
  TILING_BAND_CYCLES,
  TILING_BAND_NOTCHED_MATERIALS,
  synthesizeSurfaceMaterial,
} from "../src/render/webgpu/terrain/MaterialArraySynthesis";
import {
  SURFACE_ALBEDO_STORAGE_GAMMA,
  SurfaceMaterial,
  type SurfaceMaterialId,
} from "../src/render/webgpu/terrain/surfaceMaterials";

/**
 * `D-0` — the tiling band.
 *
 * What is pinned is the thing the eye finds first on open ground: power on the
 * Fourier lines with |k| <= 4 cycles per tile. A tile with energy there draws
 * its own period across a field however the shader warps it; seen from the app
 * at 30 m above dry grassland (2026-09-19) it was one dark feature standing in
 * a regular lattice of identical stamps. No assertion pinned the swards' band
 * before this one — the only spectral pin in the suite was Rock's
 * crossed-fracture ceiling, and the sward numbers lived in a docblock.
 *
 * Measured at seed "fly-high", edge 512, decoded linear luminance, as a share
 * of nothing (absolute variance contribution):
 *   Grass     4.65e-5 shipped
 *   DryGrass  2.35e-5 shipped
 */
function tilingBandPower(id: SurfaceMaterialId, seed: string, edge: number): {
  luminance: number;
  height: number;
  meanLuminance: number;
} {
  const bytes = synthesizeSurfaceMaterial(id, seed, edge).albedoHeight;
  const small = 64;
  const block = edge / small;
  const luminance = new Float64Array(small * small);
  const height = new Float64Array(small * small);
  let mean = 0;
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const at = (y * edge + x) * 4;
      const decode = (byte: number): number => Math.pow(byte / 255, SURFACE_ALBEDO_STORAGE_GAMMA);
      const value = 0.2126 * decode(bytes[at]!) + 0.7152 * decode(bytes[at + 1]!)
        + 0.0722 * decode(bytes[at + 2]!);
      const cell = Math.floor(y / block) * small + Math.floor(x / block);
      luminance[cell]! += value / (block * block);
      height[cell]! += bytes[at + 3]! / 255 / (block * block);
      mean += value;
    }
  }
  const bandOf = (field: Float64Array): number => {
    let power = 0;
    for (let ky = -TILING_BAND_CYCLES; ky <= TILING_BAND_CYCLES; ky += 1) {
      for (let kx = -TILING_BAND_CYCLES; kx <= TILING_BAND_CYCLES; kx += 1) {
        if (kx === 0 && ky === 0) continue;
        if (Math.hypot(kx, ky) > TILING_BAND_CYCLES + 1e-9) continue;
        let real = 0;
        let imaginary = 0;
        for (let y = 0; y < small; y += 1) {
          for (let x = 0; x < small; x += 1) {
            const phase = (2 * Math.PI * (kx * x + ky * y)) / small;
            real += field[y * small + x]! * Math.cos(phase);
            imaginary -= field[y * small + x]! * Math.sin(phase);
          }
        }
        power += (real * real + imaginary * imaginary) / (small * small) ** 2;
      }
    }
    return power;
  };
  return {
    luminance: bandOf(luminance),
    height: bandOf(height),
    meanLuminance: mean / (edge * edge),
  };
}

describe("D-0 the tiling band", () => {
  it("is notched on the two layers that carpet open country, and only those", () => {
    expect([...TILING_BAND_NOTCHED_MATERIALS]).toEqual([
      SurfaceMaterial.Grass,
      SurfaceMaterial.DryGrass,
    ]);
    expect(SWARD_TILING_BAND_KEEP).toBeGreaterThan(0);
    expect(SWARD_TILING_BAND_KEEP).toBeLessThanOrEqual(0.35);
  });

  it.each([
    ["Grass", SurfaceMaterial.Grass, 4.65e-5],
    ["DryGrass", SurfaceMaterial.DryGrass, 2.35e-5],
  ] as const)("%s carries under a fifth of the power it shipped with", (name, id, shipped) => {
    const measured = tilingBandPower(id, "fly-high", 512);
    console.info(`D-0 ${name}: |k|<=4 luminance ${measured.luminance.toExponential(3)}`
      + ` (shipped ${shipped.toExponential(2)}), height ${measured.height.toExponential(3)}`);
    expect(measured.luminance).toBeLessThan(shipped * 0.2);
  }, 120_000);

  it("holds at a second seed and at the low tier's edge", () => {
    for (const id of TILING_BAND_NOTCHED_MATERIALS) {
      const measured = tilingBandPower(id, "s3", 256);
      console.info(`D-0 material ${id} at s3/256: ${measured.luminance.toExponential(3)}`);
      expect(measured.luminance).toBeLessThan(1.2e-5);
    }
  }, 120_000);
});
