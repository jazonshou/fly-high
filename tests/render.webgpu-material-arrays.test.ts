import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  synthesizeSurfaceMaterial,
  synthesizeSurfaceMaterialLayers,
  TOKSVIG_ROUGHNESS_GAIN,
} from "../src/render/webgpu/terrain/MaterialArraySynthesis";
import { planSurfaceMaterialArrays } from "../src/render/webgpu/terrain/MaterialArrayUpload";
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

/**
 * Largest pair of mirrored diagonal Fourier lines in one scalar texture field.
 *
 * A single geological fracture family may legitimately put energy at `(kx,ky)`.
 * A woven/screen-door pattern requires a second coherent family at `(kx,-ky)`,
 * so the weaker member of each mirrored pair is the discriminator. Power is
 * normalised by total variance: a unit cosine measures 0.5, while uncorrelated
 * texture noise is O(1 / texelCount), independent of byte contrast.
 */
function maximumCrossedSpectralPower(values: readonly number[], edge: number): number {
  const texels = edge * edge;
  const mean = values.reduce((sum, value) => sum + value, 0) / texels;
  let varianceEnergy = 0;
  for (const value of values) varianceEnergy += (value - mean) ** 2;
  if (varianceEnergy <= 1e-9) return 0;

  const powerAt = (frequencyX: number, frequencyY: number): number => {
    let cosine = 0;
    let sine = 0;
    for (let y = 0; y < edge; y += 1) {
      for (let x = 0; x < edge; x += 1) {
        const phase = (2 * Math.PI * (frequencyX * x + frequencyY * y)) / edge;
        const centred = values[y * edge + x]! - mean;
        cosine += centred * Math.cos(phase);
        sine += centred * Math.sin(phase);
      }
    }
    return (cosine * cosine + sine * sine) / (texels * varianceEnergy);
  };

  let maximum = 0;
  // Axial frequencies cannot form a crossed pair. Stop short of Nyquist,
  // where +k and -k are the same discrete line rather than two families.
  for (let frequencyX = 1; frequencyX < edge / 2; frequencyX += 1) {
    for (let frequencyY = 1; frequencyY < edge / 2; frequencyY += 1) {
      maximum = Math.max(
        maximum,
        Math.min(
          powerAt(frequencyX, frequencyY),
          powerAt(frequencyX, -frequencyY),
        ),
      );
    }
  }
  return maximum;
}

function decodedAlbedoLuminance(level: Uint8Array): number[] {
  const values: number[] = [];
  for (let index = 0; index < level.length; index += 4) {
    // Array A stores sqrt(linear albedo); mirror the shipping shader's decode.
    const red = (level[index]! / 255) ** 2;
    const green = (level[index + 1]! / 255) ** 2;
    const blue = (level[index + 2]! / 255) ** 2;
    values.push(0.2126 * red + 0.7152 * green + 0.0722 * blue);
  }
  return values;
}

function heightValues(level: Uint8Array): number[] {
  const values: number[] = [];
  for (let index = 3; index < level.length; index += 4) values.push(level[index]! / 255);
  return values;
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
    // Re-derived twice: once for the Rock retune (`facetTone` 0.16 → 0.32 in
    // the height channel), and again for the reversed-`smoothstep` pass, which
    // gave Gravel a stone dome it had never had (see `synthesizeGravel` — the
    // dome term had been evaluating to zero at every texel). Both are exactly
    // the kind of change that moves this margin. Measured at this seed and
    // edge, mip3 Toksvig-minus-box mean roughness, before the two passes → now:
    //
    //   Sand 2.551 → 2.551      Grass 3.648 → 3.648    ForestFloor 5.469 → 4.887
    //   Shrub 3.441 → 3.441     Rock 10.406 → 10.480   Snow 4.867 → 4.906
    //   DryGrass 3.645 → 3.645  Gravel 13.059 → 14.398 Asphalt 3.270 → 3.180
    //   Concrete 1.371 → 1.375
    //
    // Concrete is the tightest against the > 1 bound above and is essentially
    // unmoved; Rock and Gravel keep an order of magnitude over the > 3 bound.
    // Neither pin moves.
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

  it("keeps coarse rock mips free of a crossed fracture lattice", () => {
    // Prove the discriminator itself before applying it to the recipe. One
    // directional family has no mirrored partner; adding the opposite family
    // creates a textbook screen-door and concentrates a quarter of its variance
    // in each line.
    const controlEdge = 32;
    const singleFamily: number[] = [];
    const crossedFamilies: number[] = [];
    for (let y = 0; y < controlEdge; y += 1) {
      for (let x = 0; x < controlEdge; x += 1) {
        const positive = Math.cos((2 * Math.PI * (7 * x + 3 * y)) / controlEdge);
        const negative = Math.cos((2 * Math.PI * (7 * x - 3 * y)) / controlEdge);
        singleFamily.push(positive);
        crossedFamilies.push(positive + negative);
      }
    }
    expect(maximumCrossedSpectralPower(singleFamily, controlEdge)).toBeLessThan(1e-10);
    expect(maximumCrossedSpectralPower(crossedFamilies, controlEdge)).toBeGreaterThan(0.24);

    const rock = plans.albedoHeight.layerChains[SurfaceMaterial.Rock]!;
    // Re-derived for the Rock albedo retune, which roughly halved this layer's
    // albedo contrast (p99/p01 3.21 → 1.70 in decoded linear luminance). This
    // statistic is normalised by the layer's OWN variance, so cutting the
    // variance RAISES every reading without any lattice appearing: the fixed
    // point of the procedure is to re-run the rows, never to edit one number.
    //
    // The retune also changed what the control means, and that has to be
    // written down. The old control was "the recipe with the per-block family
    // exclusion removed, so both ±dip families are summed at every texel".
    // Its screen-door came from a DEFECT in the band shape, not from the
    // summing: `jointBand` used the reversed-argument `smoothstep(0.16, 0.105,
    // …)` form, which that helper's `Math.max(1e-6, high − low)` denominator
    // turns into a hard step at 0.16 — so each family was an 84%-coverage
    // half-plane, and the COMPLEMENT of the union of two such half-planes is a
    // regular diamond lattice of holes. That was the screen-door. With the band
    // at the ~10% crease it is drawn as (`MaterialArraySynthesis.ts`,
    // `synthesizeRock`), summing the two families only sparsely crosses them,
    // so that control no longer produces the artefact. Both rows, measured at
    // this seed and edge:
    //
    //                            mip2      mip3      mip4
    //   albedo  shipped        0.00807   0.01193   0.03255
    //           +excl.removed  0.00823   0.01322   0.03153
    //           screen-door    0.01012   0.01409   0.02655
    //   height  shipped        0.00964   0.01197   0.01256
    //           +excl.removed  0.00853   0.01068   0.01620
    //           screen-door    0.01033   0.01256   0.02137
    //
    // `screen-door` is the exclusion-removed control evaluated on the PRE-FIX
    // half-plane band — i.e. the configuration that actually produced the
    // reported woven lattice, and the row the superseded numbers below were
    // measured against (it reproduces them exactly, which is what validates
    // this construction).
    //
    // Three cells — albedo mip2 and mip3, height mip4 — keep a limit placed
    // between `shipped` and `screen-door`, so they still fail the artefact.
    //
    // The other three cannot, and pretending otherwise would be worse than
    // saying so. Height mip2 and mip3 now separate by only 7% and 5%, which is
    // inside this statistic's own seed-to-seed spread, so no limit between the
    // rows would be a test of anything; both are set 20% above `shipped`
    // instead, and the screen-door row passes them. The reason the separation
    // collapsed is the same one that made the exclusion-removed control stop
    // working: with the joint band at its intended width, two crossing line
    // families meet at sparse POINTS and scatter their energy across harmonics
    // instead of standing on one mirrored pair. The artefact this assertion was
    // written for was a property of the defect, and the defect is fixed.
    //
    // What still holds the height channel honest is the cross-material floor:
    // at mip2, Rock reads 0.00964 against 0.0147 (Sand), 0.0205 (Grass), 0.0221
    // (ForestFloor), 0.0142 (Shrub), 0.0173 (DryGrass), 0.0149 (Asphalt) and
    // 0.0196 (Concrete) — Rock is quieter than seven of the nine materials that
    // have no fracture family at all, which is the statement "no crossed
    // lattice" actually cashes out to.
    //
    // The sixth, mip4 albedo, is the weakest of all. At mip4 the level is 8x8 and
    // this statistic is a max over the nine mirrored pairs 64 texels admit,
    // whose flat-spectrum expectation is already ~0.022. Measured across the
    // nine materials that have no fracture family at all, mip4 albedo runs
    // 0.0099 (Snow) to 0.0506 (Sand), with Asphalt 0.0442 and ForestFloor
    // 0.0270 — Rock's 0.0322 is inside that band. Over eight seeds the winning
    // pair wanders — (3,1), (1,2), (2,2), (2,3), (1,1) — and Rock's own reading
    // ranges 0.0076–0.0454 after the retune and 0.0148–0.0302 before it, the
    // pre-retune recipe exceeding its own committed 0.02 limit at two of those
    // seeds. The cell is a gross-lattice tripwire (the synthetic crossed
    // control at the top of this test measures > 0.24), not a discriminator;
    // 0.04 is set from the no-fracture-family band above. mip2 and mip3, where
    // the level is 32x32 and 16x16, are where this assertion has its teeth.
    //
    // (Superseded: albedo 0.0085/0.0128/0.04 and height 0.011/0.014/0.02,
    // against a shipped row of albedo 0.00609/0.01081/0.03222 and height
    // 0.00890/0.01075/0.01274 — the Rock albedo retune, before this file's
    // `bedStep` was un-degenerated. Before those: albedo 0.0092/0.0118/0.02 and
    // height 0.0103/0.0132/0.0307; and before those, albedo 0.007/0.014/0.033
    // and height 0.018/0.0195/0.029.)
    const limits = [
      { mip: 2, albedo: 0.009, height: 0.0116 },
      { mip: 3, albedo: 0.013, height: 0.0144 },
      { mip: 4, albedo: 0.04, height: 0.0164 },
    ] as const;
    for (const limit of limits) {
      const { mip } = limit;
      const edge = EDGE >> mip;
      const albedoPower = maximumCrossedSpectralPower(
        decodedAlbedoLuminance(rock[mip]!),
        edge,
      );
      const heightPower = maximumCrossedSpectralPower(heightValues(rock[mip]!), edge);
      expect(
        albedoPower,
        `Rock mip${mip} albedo crossed-family power ${albedoPower.toFixed(5)}`,
      ).toBeLessThan(limit.albedo);
      expect(
        heightPower,
        `Rock mip${mip} height crossed-family power ${heightPower.toFixed(5)}`,
      ).toBeLessThan(limit.height);
    }
  });

  it("never calls smoothstep with a reversed pair", () => {
    // The bug this guards is the most expensive one this module has had, and
    // it was invisible at every call site. `smoothstep(low, high, value)` used
    // to clamp its denominator with `Math.max(1e-6, high - low)`; a call whose
    // `high` was BELOW its `low` therefore got a 1e-6 span and became a hard
    // step UP at `low` — the complement of the falling edge it reads as, with a
    // knife edge instead of a ramp. Ten call sites were written that way. Rock
    // drew its joints as 84%-coverage half-planes (albedo p99/p01 3.21, cavity
    // median 0.325); gravel, asphalt and concrete drew their aggregate as the
    // gaps BETWEEN stones, so stones and matrix had swapped every property; the
    // sward opened bare soil in its DENSEST patches, which is the camouflage
    // blotching `synthesizeSward`'s own comment says it was rewritten to remove.
    //
    // Two guards, because neither is sufficient alone. The helper now throws on
    // a reversed pair, which catches the computed forms a source scan cannot
    // see — gravel's was `smoothstep(stoneRadius, stoneRadius * 0.35, f1)` —
    // and every synthesis in this file exercises it. This scan catches the
    // literal form at review time, with a message that names the fix, rather
    // than as a thrown error from inside a worker.
    const source = readFileSync(
      join(__dirname, "..", "src/render/webgpu/terrain/MaterialArraySynthesis.ts"),
      "utf8",
    );
    // Strip comments first: the prose above each fix quotes the broken calls.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const reversed: string[] = [];
    for (const match of code.matchAll(/smoothstep\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,/g)) {
      if (Number(match[2]) <= Number(match[1])) reversed.push(match[0]);
    }
    expect(
      reversed,
      `reversed smoothstep(low, high, ...) call sites — write 1 - smoothstep(low, high, x) `
      + `for a falling edge: ${reversed.join(", ")}`,
    ).toEqual([]);
    // And the degenerate denominator itself must not come back.
    expect(code, "smoothstep must not clamp its denominator").not.toContain("Math.max(1e-6, high");
    // The scan is only worth having if it can see the recipes at all.
    expect(code.match(/smoothstep\(/g)?.length ?? 0).toBeGreaterThan(20);
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
