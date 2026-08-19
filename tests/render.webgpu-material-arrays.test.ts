import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  encodeRgbaPng,
  MATERIAL_PREVIEW_CELL_EDGE,
  MATERIAL_PREVIEW_DEFAULT_EDGE,
  MATERIAL_PREVIEW_DEFAULT_SEED,
  MATERIAL_PREVIEW_ENV,
  MATERIAL_PREVIEW_PATH,
} from "../scripts/material-preview.mts";
import { buildMipChain, toksvigReduce } from "../src/render/webgpu/core/TextureArrayMips";
import {
  composeSurfaceMaterialContactSheet,
  CONTACT_SHEET_VIEWS,
  MATERIAL_REFERENCE_NOTES,
  planSurfaceMaterialArrays,
  synthesizeSurfaceMaterial,
  synthesizeSurfaceMaterialLayers,
  TOKSVIG_ROUGHNESS_GAIN,
} from "../src/render/webgpu/terrain/MaterialArraySynthesis";
import {
  SURFACE_MATERIAL_COUNT,
  SURFACE_MATERIALS,
  SurfaceMaterial,
} from "../src/render/webgpu/terrain/surfaceMaterials";

/**
 * 3-1 — the ten synthesised materials. Assertions 53, 54 and 55 live here,
 * plus the tileability property that makes them usable at all.
 *
 * The edge is 128 rather than the shipping 512: every property under test is
 * scale-invariant by construction (feature sizes are expressed in metres and
 * converted through texels-per-metre), and a 512² sweep costs ~1.1 s of the
 * Node suite for no extra coverage. One 256² case pins that scale invariance.
 */
const EDGE = 128;
const SEED = "surface-material-test-seed";

const plans = planSurfaceMaterialArrays(SEED, EDGE);

function heightMean(layer: Uint8Array): number {
  let sum = 0;
  for (let index = 3; index < layer.length; index += 4) sum += layer[index]!;
  return sum / (layer.length / 4) / 255;
}

/** Mean absolute channel difference between two texel columns. */
function columnDifference(layer: Uint8Array, edge: number, left: number, right: number): number {
  let total = 0;
  for (let row = 0; row < edge; row += 1) {
    const a = (row * edge + left) * 4;
    const b = (row * edge + right) * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      total += Math.abs(layer[a + channel]! - layer[b + channel]!);
    }
  }
  return total / (edge * 4);
}

function rowDifference(layer: Uint8Array, edge: number, top: number, bottom: number): number {
  let total = 0;
  for (let column = 0; column < edge; column += 1) {
    const a = (top * edge + column) * 4;
    const b = (bottom * edge + column) * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      total += Math.abs(layer[a + channel]! - layer[b + channel]!);
    }
  }
  return total / (edge * 4);
}

describe("terrain material array synthesis (3-1)", () => {
  it("assertion 53: every height channel has mean 0.5 ± 0.02", () => {
    // Without this, 3-6's height blend has one layer winning every comparison
    // everywhere and the blend degenerates into a hard mask.
    plans.albedoHeight.layerChains.forEach((chain, layer) => {
      const mean = heightMean(chain[0]!);
      expect(
        mean,
        `${SURFACE_MATERIALS[layer]!.name} height mean ${mean.toFixed(4)}`,
      ).toBeGreaterThan(0.48);
      expect(mean).toBeLessThan(0.52);
    });
  });

  it("assertion 54: mip N is the Toksvig-corrected reduction of N−1", () => {
    // An equality, not a tolerance: the reducer is the definition. Without it
    // distant terrain gets a false sharp highlight from a normal map that has
    // been averaged into flatness — the loudest plastic tell at range.
    plans.normalMaterial.layerChains.forEach((chain, layer) => {
      for (let level = 1; level < chain.length; level += 1) {
        const sourceEdge = EDGE >> (level - 1);
        const expected = toksvigReduce(chain[level - 1]!, sourceEdge, TOKSVIG_ROUGHNESS_GAIN);
        expect(
          Array.from(chain[level]!),
          `${SURFACE_MATERIALS[layer]!.name} mip ${level}`,
        ).toEqual(Array.from(expected));
      }
    });
    // And it must actually roughen. The equality above is satisfied by a
    // reducer with gain zero, so compare against the plain box chain: every
    // layer must come out MATTER than a box reduction of the same normals,
    // and the two materials whose normal fields are steepest must come out
    // markedly so. Without this the assertion is a tautology over its own
    // implementation.
    const meanRoughness = (level: Uint8Array): number => {
      let sum = 0;
      for (let index = 2; index < level.length; index += 4) sum += level[index]!;
      return sum / (level.length / 4);
    };
    plans.normalMaterial.layerChains.forEach((chain, layer) => {
      const box = buildMipChain(chain[0]!, EDGE, "box");
      const name = SURFACE_MATERIALS[layer]!.name;
      const toksvigRoughness = meanRoughness(chain[3]!);
      const boxRoughness = meanRoughness(box[3]!);
      expect(
        toksvigRoughness - boxRoughness,
        `${name}: Toksvig mip3 roughness ${toksvigRoughness.toFixed(1)} vs box `
        + `${boxRoughness.toFixed(1)}`,
      ).toBeGreaterThan(1);
    });
    for (const id of [SurfaceMaterial.Rock, SurfaceMaterial.Gravel]) {
      const chain = plans.normalMaterial.layerChains[id]!;
      const box = buildMipChain(chain[0]!, EDGE, "box");
      expect(
        meanRoughness(chain[3]!) - meanRoughness(box[3]!),
        `${SURFACE_MATERIALS[id]!.name} is the sharpest normal field in the table`,
      ).toBeGreaterThan(3);
    }
  });

  it("assertion 55: all ten layers of both arrays carry a complete mip chain", () => {
    // Babylon mips only layer 0 of a 2D array (verified at
    // webgpuTextureManager.js:716) — this is the property the CPU reducer
    // exists to restore, checked on every layer rather than the first.
    const expectedLevels = Math.log2(EDGE) + 1;
    for (const plan of [plans.albedoHeight, plans.normalMaterial]) {
      expect(plan.layerCount).toBe(SURFACE_MATERIAL_COUNT);
      expect(plan.mipLevelCount).toBe(expectedLevels);
      expect(plan.layerChains).toHaveLength(SURFACE_MATERIAL_COUNT);
      for (const chain of plan.layerChains) {
        expect(chain).toHaveLength(expectedLevels);
        chain.forEach((level, index) => {
          const levelEdge = EDGE >> index;
          expect(level.length).toBe(levelEdge * levelEdge * 4);
        });
      }
      expect(plan.packedLevels).toHaveLength(expectedLevels);
      plan.packedLevels.forEach((packed, level) => {
        const levelEdge = EDGE >> level;
        expect(packed.length).toBe(levelEdge * levelEdge * 4 * SURFACE_MATERIAL_COUNT);
      });
      // The packed buffer really is layer-major: a wrong stride here uploads
      // grass into the rock slot at every level but the first.
      const level = 3;
      const bytesPerLayer = (EDGE >> level) ** 2 * 4;
      const layer = SurfaceMaterial.Rock;
      expect(
        Array.from(
          plan.packedLevels[level]!.subarray(layer * bytesPerLayer, (layer + 1) * bytesPerLayer),
        ),
      ).toEqual(Array.from(plan.layerChains[layer]![level]!));
    }
  });

  it("tiles: the wrap seam is no sharper than the interior", () => {
    // A material that does not tile is worse than no material — the seam is a
    // hard line repeating every few metres across the whole world. Every
    // primitive wraps its lattice indices, so the seam column pair must look
    // like any other adjacent column pair.
    for (const [name, chains] of [
      ["albedo/height", plans.albedoHeight.layerChains],
      ["normal/material", plans.normalMaterial.layerChains],
    ] as const) {
      chains.forEach((chain, layer) => {
        const level = chain[0]!;
        const material = SURFACE_MATERIALS[layer]!.name;
        let interiorColumns = 0;
        let interiorRows = 0;
        const samples = 16;
        for (let sample = 1; sample <= samples; sample += 1) {
          const at = Math.floor((sample * EDGE) / (samples + 2));
          interiorColumns += columnDifference(level, EDGE, at, at + 1);
          interiorRows += rowDifference(level, EDGE, at, at + 1);
        }
        const seamColumns = columnDifference(level, EDGE, EDGE - 1, 0);
        const seamRows = rowDifference(level, EDGE, EDGE - 1, 0);
        expect(
          seamColumns,
          `${material} ${name}: vertical seam ${seamColumns.toFixed(2)} vs interior `
          + `${(interiorColumns / samples).toFixed(2)}`,
        ).toBeLessThan((interiorColumns / samples) * 2 + 1.5);
        expect(
          seamRows,
          `${material} ${name}: horizontal seam ${seamRows.toFixed(2)} vs interior `
          + `${(interiorRows / samples).toFixed(2)}`,
        ).toBeLessThan((interiorRows / samples) * 2 + 1.5);
      });
    }
  });

  it("carries real texel-scale structure in every layer", () => {
    // The audit's measurement to close: "the highest-frequency albedo signal
    // anywhere in the renderer is a 7.1 m smooth value noise applied as ±8%
    // brightness... nothing gives the eye a scale reference below 7 m".
    //
    // The test is a HIGH-FREQUENCY RATIO, not a contrast amplitude. Sand and
    // snow are genuinely low-contrast materials and holding them to rock's
    // spread would only invite fake speckle; what must be true of all ten is
    // that their variance lives at texel scale rather than in a smooth
    // gradient. Mean |Δ| between adjacent texels over the standard deviation
    // is ~1.1 for white noise and ~0 for a ramp.
    plans.albedoHeight.layerChains.forEach((chain, layer) => {
      const level = chain[0]!;
      const texels = EDGE * EDGE;
      const luminance = (texel: number): number => 0.2126 * level[texel * 4]!
        + 0.7152 * level[texel * 4 + 1]!
        + 0.0722 * level[texel * 4 + 2]!;
      let sum = 0;
      let sumSquares = 0;
      for (let texel = 0; texel < texels; texel += 1) {
        const value = luminance(texel);
        sum += value;
        sumSquares += value * value;
      }
      const mean = sum / texels;
      const deviation = Math.sqrt(Math.max(0, sumSquares / texels - mean * mean));
      let neighbour = 0;
      for (let row = 0; row < EDGE; row += 1) {
        for (let column = 0; column < EDGE - 1; column += 1) {
          neighbour += Math.abs(luminance(row * EDGE + column) - luminance(row * EDGE + column + 1));
        }
      }
      const adjacent = neighbour / (EDGE * (EDGE - 1));
      const material = SURFACE_MATERIALS[layer]!.name;
      expect(deviation, `${material} albedo is uniform`).toBeGreaterThan(1);
      expect(
        adjacent,
        `${material} adjacent-texel albedo delta ${adjacent.toFixed(2)}`,
      ).toBeGreaterThan(0.5);
      expect(
        adjacent / deviation,
        `${material} high-frequency ratio ${(adjacent / deviation).toFixed(3)} — the variance `
        + `is in a smooth gradient, not in texel-scale structure`,
      ).toBeGreaterThan(0.1);
    });
  });

  it("is a pure function of seed, material and edge", () => {
    const first = synthesizeSurfaceMaterial(SurfaceMaterial.Rock, SEED, 64);
    const again = synthesizeSurfaceMaterial(SurfaceMaterial.Rock, SEED, 64);
    expect(Array.from(first.albedoHeight)).toEqual(Array.from(again.albedoHeight));
    expect(Array.from(first.normalMaterial)).toEqual(Array.from(again.normalMaterial));
    const otherSeed = synthesizeSurfaceMaterial(SurfaceMaterial.Rock, "other", 64);
    expect(Array.from(otherSeed.albedoHeight)).not.toEqual(Array.from(first.albedoHeight));
    const otherMaterial = synthesizeSurfaceMaterial(SurfaceMaterial.Snow, SEED, 64);
    expect(Array.from(otherMaterial.albedoHeight)).not.toEqual(Array.from(first.albedoHeight));
    expect(() => synthesizeSurfaceMaterial(SurfaceMaterial.Rock, SEED, 100)).toThrow(RangeError);
    expect(() => synthesizeSurfaceMaterial(SurfaceMaterial.Rock, SEED, 4)).toThrow(RangeError);
  });

  it("holds the contract at a second edge, so feature sizes are metric", () => {
    // Recipes size their features in metres and convert through
    // texels-per-metre. If one regressed to texel units, the contract holds at
    // 128 and quietly breaks at the shipping 512.
    const coarse = synthesizeSurfaceMaterialLayers(SEED, 64);
    const fine = synthesizeSurfaceMaterialLayers(SEED, 256);
    for (const layers of [coarse.albedoHeight, fine.albedoHeight]) {
      layers.forEach((layer, index) => {
        const mean = heightMean(layer);
        expect(mean, `${SURFACE_MATERIALS[index]!.name}`).toBeGreaterThan(0.48);
        expect(mean).toBeLessThan(0.52);
      });
    }
  }, 60_000);

  it("keeps every material's roughness inside its 3-0 band and spanning it", () => {
    plans.normalMaterial.layerChains.forEach((chain, layer) => {
      const spec = SURFACE_MATERIALS[layer]!;
      let low = 255;
      let high = 0;
      const level = chain[0]!;
      for (let index = 2; index < level.length; index += 4) {
        const value = level[index]!;
        if (value < low) low = value;
        if (value > high) high = value;
      }
      expect(low / 255, `${spec.name} roughness floor`).toBeGreaterThanOrEqual(
        spec.roughness[0] - 0.01,
      );
      expect(high / 255, `${spec.name} roughness ceiling`).toBeLessThanOrEqual(
        spec.roughness[1] + 0.01,
      );
      // And it must USE the band — a constant would make assertion 61 vacuous.
      expect((high - low) / 255, `${spec.name} roughness span`).toBeGreaterThan(
        (spec.roughness[1] - spec.roughness[0]) * 0.75,
      );
    });
  });

  it("builds the debug contact sheet the recipes are tuned against", () => {
    // §11 R-3A: ten recipes judged by eye is the largest unfalsifiable surface
    // in the programme, and the viewer is the non-negotiable answer to it.
    const sheet = composeSurfaceMaterialContactSheet(plans, 32, [0, 2, 4]);
    expect(sheet.columns).toHaveLength(SURFACE_MATERIAL_COUNT);
    expect(sheet.rows).toHaveLength(3 * CONTACT_SHEET_VIEWS.length);
    expect(sheet.width).toBe(SURFACE_MATERIAL_COUNT * 32);
    expect(sheet.height).toBe(sheet.rows.length * 32);
    expect(sheet.rgba.length).toBe(sheet.width * sheet.height * 4);
    // Non-degenerate: every cell of the albedo row must differ from its
    // neighbours, or the sheet is showing one material ten times.
    const cellLuminance = (column: number, row: number): number => {
      let sum = 0;
      for (let y = 0; y < 32; y += 1) {
        for (let x = 0; x < 32; x += 1) {
          const at = ((row * 32 + y) * sheet.width + column * 32 + x) * 4;
          sum += sheet.rgba[at]! + sheet.rgba[at + 1]! + sheet.rgba[at + 2]!;
        }
      }
      return sum / (32 * 32 * 3);
    };
    const luminances = sheet.columns.map((_, column) => cellLuminance(column, 0));
    expect(new Set(luminances.map((value) => Math.round(value))).size).toBeGreaterThan(6);
    expect(() => composeSurfaceMaterialContactSheet(plans, 32, [99])).toThrow(RangeError);
    // Every material carries a reference note; a recipe without one cannot be
    // re-tuned by anybody who did not write it.
    for (const spec of SURFACE_MATERIALS) {
      expect(MATERIAL_REFERENCE_NOTES[spec.name], `${spec.name} reference note`).toBeTruthy();
    }
  });
});

/**
 * `npm run material:preview` — the debug viewer's write path. Off by default:
 * without the env switch this file never touches the filesystem, so the
 * ordinary Node suite stays hermetic.
 */
describe.runIf(process.env[MATERIAL_PREVIEW_ENV])("material contact sheet", () => {
  it("writes the preview PNG at the shipping edge", () => {
    const seed = process.env["VITE_MATERIAL_SEED"] ?? MATERIAL_PREVIEW_DEFAULT_SEED;
    const edge = Number(process.env["VITE_MATERIAL_EDGE"] ?? MATERIAL_PREVIEW_DEFAULT_EDGE);
    const started = performance.now();
    const preview = planSurfaceMaterialArrays(seed, edge);
    const elapsed = performance.now() - started;
    const sheet = composeSurfaceMaterialContactSheet(preview, MATERIAL_PREVIEW_CELL_EDGE, [0, 2, 4]);
    const output = join(__dirname, "..", MATERIAL_PREVIEW_PATH);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, encodeRgbaPng(sheet.width, sheet.height, sheet.rgba));
    console.log(
      `\n${output}\n  seed "${seed}" at ${edge}x${edge}: synthesis + mips `
      + `${elapsed.toFixed(0)} ms, ${(preview.totalBytes / 1_048_576).toFixed(2)} MiB\n`
      + `  columns: ${sheet.columns.join(", ")}\n`
      + `  rows: ${sheet.rows.join(" | ")}\n`
      + Object.entries(MATERIAL_REFERENCE_NOTES)
        .map(([name, note]) => `  ${name}: ${note}`)
        .join("\n"),
    );
    expect(sheet.rgba.length).toBe(sheet.width * sheet.height * 4);
  }, 300_000);
});
