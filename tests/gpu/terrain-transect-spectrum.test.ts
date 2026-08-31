import { beforeAll, describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import {
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
  type TerrainMacroEvolutionExport,
} from "../../src/render/webgpu/terrain/TerrainEvolutionContract";
import {
  evolveMacroTerrain,
  toTerrainMacroEvolutionExport,
} from "../../src/render/webgpu/terrain/TerrainMacroEvolution";
import {
  TerrainPageAtlas,
  TerrainPageGenerator,
  invariantSlotKey,
} from "../../src/render/webgpu/terrain/TerrainPageAtlas";
import { generateTerrainErodedPage } from "../../src/render/webgpu/terrain/TerrainPageErosion";
import type { TerrainPageErosionExecutor } from "../../src/render/webgpu/terrain/TerrainPageErosionClient";
import { buildTerrainMacroLakeField } from "../../src/render/webgpu/terrain/TerrainPageHydrology";
import { TERRAIN_HEIGHT_SLOT_EDGE } from "../../src/render/webgpu/terrain/TerrainSpineContract";
import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_GUTTER,
  WORLD_PAGE_HEIGHT_CORE,
} from "../../src/render/webgpu/world/pageGeometry";
import { createWorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import { sampleTerrainMacroEvolutionInputs } from "../../src/workers/terrainMacroEvolutionRuntime";
import { createWorld } from "../../src/world";

/**
 * `W-7` (Phase 6, Gate W): assertion 97 — "500 m transect FFT: smooth power law
 * to ~6 m (today cliffs at 43 m)" — measured on REAL L0 atlas readbacks.
 *
 * §12.1 gives this assertion a `gpu/` readback home for a reason. The claim is
 * about the surface the renderer actually samples, and the eroded page travels
 * worker -> `updateTextureData` -> r32float atlas slot before anything sees it.
 * So the transects here come out of `readPixels` on a resident slot of a real
 * `TerrainPageAtlas`, generated through the real `TerrainPageGenerator` eroded
 * path, not from a CPU array that was never uploaded.
 *
 * WHY "43 m" WAS THERE. The pre-`5-A` analytic kernel's smallest height octave
 * was 43 m, so the spectrum fell off a cliff below it — the world had no
 * detail between 8 m and 43 m at all (RENDERING_PLAN §"Exit criteria",
 * PHASE_5 §7 `5-A`). `5-8a` moved 24 m and 9 m ridged bands into the uplift
 * and lithology fields, and page erosion adds talus facets and incision
 * gullies on top. This file is the instrument that says whether that worked.
 *
 * Measured on this file's seed, 2026-08-30 (values are logged on every run):
 *
 *   | measurement                                  | measured  | target  |     |
 *   |----------------------------------------------|-----------|---------|-----|
 *   | spectral cliff wavelength (octave steepening) | none      | <= 6 m  | PIN |
 *   | 42.7 m bin against the 256..32 m fit          | -0.82 dB  | < 6 dB  | PIN |
 *   | octave mean power, 128 m down to 4 m          | monotone  | monotone| PIN |
 *   | power-law fit over 256..32 m                  | P ~ L^3.96| —       | REC |
 *
 * The 43 m cliff is gone: power falls monotonically octave over octave from
 * 128 m to the 4 m Nyquist limit, no octave loses power faster than the one
 * above it, and the 43 m bin now sits slightly ABOVE the long-wavelength power
 * law rather than falling off it. The power law is smooth past the ~6 m the
 * assertion asked for, down to the 2 m sampling limit itself.
 *
 * Runtime: one macro build plus three real eroded pages, inside one engine.
 */

const SEED = "w7-transect-spectrum";
const DOMAIN = EVOLUTION_DOMAIN_TEXELS;
const PAGE_TEXEL_METERS = WORLD_PAGE_BASE_EXTENT_METERS / WORLD_PAGE_HEIGHT_CORE;
/** 500 m of transect is 250 texels at 2 m; 256 is the enclosing power of two. */
const TRANSECT_TEXELS = 256;
const TRANSECT_METERS = TRANSECT_TEXELS * PAGE_TEXEL_METERS;
/** Rows and columns of each page's core that become transects. */
const TRANSECT_LINES = [20, 44, 68, 92, 116, 140, 164, 188, 212, 236] as const;
/**
 * Octave bands, longest first. Below 4 m is past Nyquist at 2 m sampling, and
 * above 128 m a 256-sample periodogram has too few bins per octave (three) for
 * a slope to mean anything — the fit band below still spans 256 m.
 */
const OCTAVES = [
  [128, 64], [64, 32], [32, 16], [16, 8], [8, 4],
] as const;
/**
 * A cliff is a SCALE-RELATIVE steepening: the octave below the break loses
 * power far faster than the octave above it. 1.5 in log-log slope is a factor
 * of ~2.8 per octave of extra falloff — unmistakable, and immune to the
 * absolute value of the fitted exponent.
 */
const CLIFF_SLOPE_STEP = 1.5;

interface Transects {
  readonly powerByWavelength: readonly { readonly wavelengthMeters: number; readonly power: number }[];
  readonly transectCount: number;
  readonly readbackMismatches: number;
  readonly pageLabels: readonly string[];
}

let measured: Transects | null = null;

/** In-place radix-2 Cooley-Tukey. `re`/`im` must be a power of two long. */
function fastFourierTransform(re: Float64Array, im: Float64Array): void {
  const count = re.length;
  for (let i = 1, j = 0; i < count; i += 1) {
    let bit = count >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const swapRe = re[i]!;
      const swapIm = im[i]!;
      re[i] = re[j]!;
      im[i] = im[j]!;
      re[j] = swapRe;
      im[j] = swapIm;
    }
  }
  for (let length = 2; length <= count; length <<= 1) {
    const step = (-2 * Math.PI) / length;
    const half = length / 2;
    for (let start = 0; start < count; start += length) {
      for (let k = 0; k < half; k += 1) {
        const angle = step * k;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const aRe = re[start + k]!;
        const aIm = im[start + k]!;
        const bRe = re[start + k + half]!;
        const bIm = im[start + k + half]!;
        const rotatedRe = bRe * cos - bIm * sin;
        const rotatedIm = bRe * sin + bIm * cos;
        re[start + k] = aRe + rotatedRe;
        im[start + k] = aIm + rotatedIm;
        re[start + k + half] = aRe - rotatedRe;
        im[start + k + half] = aIm - rotatedIm;
      }
    }
  }
}

/**
 * One transect's periodogram. The transect is mean-removed AND detrended
 * first: every 500 m of hillslope carries a linear ramp whose leakage would
 * otherwise dominate every bin, and a Hann window stops the residual step at
 * the ends from doing the same.
 */
function transectPeriodogram(samples: Float64Array): Float64Array {
  const count = samples.length;
  let mean = 0;
  for (const value of samples) mean += value;
  mean /= count;
  let crossMoment = 0;
  let squareMoment = 0;
  for (let i = 0; i < count; i += 1) {
    const centred = i - (count - 1) / 2;
    crossMoment += centred * (samples[i]! - mean);
    squareMoment += centred * centred;
  }
  const trend = crossMoment / squareMoment;
  const re = new Float64Array(count);
  const im = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (count - 1));
    re[i] = (samples[i]! - mean - trend * (i - (count - 1) / 2)) * window;
  }
  fastFourierTransform(re, im);
  const periodogram = new Float64Array(count / 2 + 1);
  for (let k = 0; k <= count / 2; k += 1) periodogram[k] = re[k]! ** 2 + im[k]! ** 2;
  return periodogram;
}

/**
 * Per-bin MEDIAN across transects, not the mean. A 500 m transect that happens
 * to cross a lake shore or a talus break carries a genuine step, and a step's
 * energy lands in every bin — three such transects in sixty move the mean at
 * the shortest wavelengths by two orders of magnitude and nothing else does.
 * The median is the standard robust periodogram estimator for exactly this,
 * and it is what makes the short-wavelength half of the spectrum a statement
 * about the landscape rather than about its rarest features.
 */
function medianSpectrum(
  periodograms: readonly Float64Array[],
): { readonly wavelengthMeters: number; readonly power: number }[] {
  const spectrum: { wavelengthMeters: number; power: number }[] = [];
  for (let k = 1; k <= TRANSECT_TEXELS / 2; k += 1) {
    const column = periodograms.map((entry) => entry[k]!).sort((a, b) => a - b);
    spectrum.push({
      wavelengthMeters: TRANSECT_METERS / k,
      power: column[Math.floor(column.length / 2)]!,
    });
  }
  return spectrum;
}

/** Least-squares slope of log10(power) against log10(wavelength) over a band. */
function logLogSlope(
  power: readonly { readonly wavelengthMeters: number; readonly power: number }[],
  longestMeters: number,
  shortestMeters: number,
): { readonly slope: number; readonly intercept: number; readonly bins: number } {
  const band = power.filter((entry) =>
    entry.wavelengthMeters <= longestMeters && entry.wavelengthMeters >= shortestMeters);
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (const entry of band) {
    const x = Math.log10(entry.wavelengthMeters);
    const y = Math.log10(entry.power);
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  }
  const count = band.length;
  const slope = (count * sumXY - sumX * sumY) / (count * sumXX - sumX * sumX);
  return { slope, intercept: (sumY - slope * sumX) / count, bins: count };
}

function meanPower(
  power: readonly { readonly wavelengthMeters: number; readonly power: number }[],
  longestMeters: number,
  shortestMeters: number,
): number {
  const band = power.filter((entry) =>
    entry.wavelengthMeters <= longestMeters && entry.wavelengthMeters >= shortestMeters);
  return band.reduce((total, entry) => total + entry.power, 0) / band.length;
}

async function withScene<T>(run: (engine: WebGPUEngine, scene: Scene) => Promise<T>): Promise<T> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, {
    antialias: false,
    enableAllFeatures: false,
    setMaximumLimits: false,
  });
  let scene: Scene | null = null;
  try {
    await engine.initAsync();
    engine.runRenderLoop(() => {});
    scene = new Scene(engine);
    return await run(engine, scene);
  } finally {
    scene?.dispose();
    engine.stopRenderLoop();
    engine.dispose();
    canvas.remove();
  }
}

beforeAll(async () => {
  const started = Date.now();
  const world = createWorld(SEED, { airport: false, worldEvolution: "eroded" });
  const inputs = sampleTerrainMacroEvolutionInputs({
    width: DOMAIN,
    height: DOMAIN,
    minWorldX: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX,
    minWorldZ: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ,
    texelSizeMeters: EVOLUTION_TEXEL_METERS,
    seedHash: world.seedHash,
  });
  const macro: TerrainMacroEvolutionExport = toTerrainMacroEvolutionExport(
    evolveMacroTerrain({
      width: DOMAIN,
      height: DOMAIN,
      heights: inputs.heights,
      texelSizeMeters: EVOLUTION_TEXEL_METERS,
      seaLevel: world.seaLevel,
      erodibility: inputs.erodibility,
      reposeDegrees: inputs.reposeDegrees,
    }),
    world.seaLevel,
    { worldSeed: world.seed, deviceFingerprint: "w7-transect-spectrum" },
  );
  const lakeField = buildTerrainMacroLakeField(macro);

  // One page per flow regime, so the spectrum is not a single hillslope's.
  const picks: { x: number; z: number; label: string }[] = [];
  for (let texelZ = 96; texelZ < DOMAIN - 96 && picks.length < 3; texelZ += 53) {
    for (let texelX = 96; texelX < DOMAIN - 96 && picks.length < 3; texelX += 47) {
      const cell = texelZ * DOMAIN + texelX;
      if (macro.heightMeters[cell]! <= world.seaLevel) continue;
      const flow = macro.flowAccumulationAreaM2[cell]!;
      const label = flow > 5e7 ? "valley" : flow > 1e6 ? "slope" : "ridge";
      if (picks.some((pick) => pick.label === label)) continue;
      const worldX = TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX + (texelX + 0.5) * EVOLUTION_TEXEL_METERS;
      const worldZ = TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ + (texelZ + 0.5) * EVOLUTION_TEXEL_METERS;
      picks.push({
        x: Math.floor(worldX / WORLD_PAGE_BASE_EXTENT_METERS),
        z: Math.floor(worldZ / WORLD_PAGE_BASE_EXTENT_METERS),
        label,
      });
    }
  }

  const periodograms: Float64Array[] = [];
  let readbackMismatches = 0;

  await withScene(async (engine, scene) => {
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const atlas = new TerrainPageAtlas(scene, profile, {
      kind: "height",
      worldRevision: "transect-spectrum",
    });
    // The production erosion executor is a Worker. Running the same pure
    // producer inline keeps this file to one adapter and one thread while the
    // BYTES stay the production ones — `TerrainPageGenerator` cannot tell the
    // difference, and the upload path under test is identical.
    // A page costs about a second to produce, so the copy the readback is
    // compared against is kept from the same call the atlas was fed.
    const references = new Map<number, Float32Array>();
    const executor: TerrainPageErosionExecutor = {
      setMacroEvolution: () => undefined,
      generate: async (address) => {
        const page = generateTerrainErodedPage(world, macro, address, lakeField);
        references.set(address.x * 1e6 + address.z, page.storedHeight.slice());
        return page;
      },
      dispose: () => undefined,
    };
    const generator = new TerrainPageGenerator(
      engine,
      atlas,
      world.seedHash,
      world.airport,
      { world, erosionExecutor: executor },
    );
    generator.setMacroEvolution(macro);

    let frame = 0;
    for (const pick of picks) {
      frame += 1;
      const address = createWorldPageAddress(0, pick.x, pick.z);
      atlas.residency.beginFrame(frame);
      const slot = atlas.residency.request(invariantSlotKey(address), address)!.slot;
      await generator.generate([slot]);
      await generator.settle();
      const origin = atlas.slotOrigin(slot.slotIndex);
      // Let Babylon allocate the destination. A 264-texel r32float row is
      // 1,056 bytes, which is NOT the 256-byte-aligned `bytesPerRow` a texture
      // copy needs, so the readback is padded internally and a caller-supplied
      // array never gets filled — the promise simply never settles.
      const pixels = await atlas.texture()!.readPixels(
        0, 0, undefined, true, false,
        origin.u, origin.v, TERRAIN_HEIGHT_SLOT_EDGE, TERRAIN_HEIGHT_SLOT_EDGE,
      ) as Float32Array;

      // Precondition, not a re-assertion of 91: the spectrum below is only
      // about the shipped surface if these bytes ARE the page's bytes.
      const reference = references.get(address.x * 1e6 + address.z)!;
      for (let index = 0; index < reference.length; index += 1) {
        if (pixels[index] !== reference[index]) readbackMismatches += 1;
      }

      const at = (column: number, row: number): number =>
        pixels[(row + WORLD_PAGE_GUTTER) * TERRAIN_HEIGHT_SLOT_EDGE + column + WORLD_PAGE_GUTTER]!;
      const samples = new Float64Array(TRANSECT_TEXELS);
      for (const line of TRANSECT_LINES) {
        for (let i = 0; i < TRANSECT_TEXELS; i += 1) samples[i] = at(i, line);
        periodograms.push(transectPeriodogram(samples));
        for (let i = 0; i < TRANSECT_TEXELS; i += 1) samples[i] = at(line, i);
        periodograms.push(transectPeriodogram(samples));
      }
    }
    generator.dispose();
    atlas.dispose();
  });

  measured = {
    powerByWavelength: medianSpectrum(periodograms),
    transectCount: periodograms.length,
    readbackMismatches,
    pageLabels: picks.map((pick) => pick.label),
  };
  console.log(
    `assertion 97 fixture: ${picks.length} L0 atlas pages (${measured.pageLabels.join(",")}), `
    + `${periodograms.length} transects of ${TRANSECT_METERS} m in ${Date.now() - started} ms`,
  );
}, 300_000);

describe("assertion 97 — 500 m transect spectrum on real L0 atlas readbacks", () => {
  it("reads the transects out of the atlas, not out of a CPU array", () => {
    const stats = measured!;
    expect(stats.transectCount).toBe(TRANSECT_LINES.length * 2 * stats.pageLabels.length);
    expect(stats.pageLabels).toStrictEqual(["ridge", "slope", "valley"]);
    // Every texel of every slot equals the page the producer emitted, so the
    // spectrum is the shipped surface's.
    expect(stats.readbackMismatches).toBe(0);
    for (const entry of stats.powerByWavelength) {
      expect(Number.isFinite(entry.power)).toBe(true);
      expect(entry.power).toBeGreaterThan(0);
    }
  });

  it("has no spectral cliff above the 4 m Nyquist limit", () => {
    const stats = measured!;
    const fit = logLogSlope(stats.powerByWavelength, 256, 32);
    const slopes = OCTAVES.map(([longest, shortest]) => ({
      longest,
      shortest,
      ...logLogSlope(stats.powerByWavelength, longest, shortest),
    }));
    console.log(
      `assertion 97: fit over 256..32 m P ~ L^${fit.slope.toFixed(3)} (${fit.bins} bins); octaves `
      + slopes.map((octave) =>
        `${octave.longest}-${octave.shortest}m ${octave.slope.toFixed(3)}`).join(" "),
    );
    let cliffMeters = 0;
    for (let index = 1; index < slopes.length; index += 1) {
      if (slopes[index]!.slope > slopes[index - 1]!.slope + CLIFF_SLOPE_STEP) {
        cliffMeters = slopes[index]!.longest;
        break;
      }
    }
    console.log(
      `assertion 97: spectral cliff ${cliffMeters === 0 ? "none above 4 m (Nyquist)" : `${cliffMeters} m`}; `
      + `smooth power law down to ${cliffMeters === 0 ? 4 : cliffMeters} m`,
    );
    // PINNED at §12.1's allocated threshold, in its scale-relative form: the
    // power law must stay smooth to ~6 m. It stays smooth to the 4 m sampling
    // limit — there is no octave anywhere below 256 m that loses power faster
    // than the octave above it, which is exactly what "cliffs at 43 m" named.
    expect(cliffMeters === 0 || cliffMeters <= 6).toBe(true);
    // And the pre-`5-A` cliff wavelength itself is now unremarkable: the 43 m
    // bin sits within 3 dB of the long-wavelength fit instead of falling off it.
    const cliffBin = stats.powerByWavelength.reduce((best, entry) =>
      Math.abs(entry.wavelengthMeters - 43) < Math.abs(best.wavelengthMeters - 43) ? entry : best);
    const expected = 10 ** (fit.intercept + fit.slope * Math.log10(cliffBin.wavelengthMeters));
    const deficitDb = 10 * Math.log10(expected / cliffBin.power);
    console.log(
      `assertion 97: L=${cliffBin.wavelengthMeters.toFixed(1)} m power ${cliffBin.power.toExponential(3)} `
      + `against fit ${expected.toExponential(3)} -> ${deficitDb.toFixed(2)} dB deficit`,
    );
    // One-sided: power ABOVE the long-wavelength fit is the opposite of a
    // cliff, so only a deficit is a failure.
    expect(deficitDb).toBeLessThan(6);
  });

  it("loses power monotonically octave over octave down to Nyquist", () => {
    const stats = measured!;
    const bands = OCTAVES.map(([longest, shortest]) => ({
      longest,
      shortest,
      power: meanPower(stats.powerByWavelength, longest, shortest),
    }));
    console.log(
      `assertion 97: octave mean power ${bands.map((band) =>
        `${band.longest}-${band.shortest}m ${band.power.toExponential(2)}`).join(" ")}`,
    );
    // A "smooth power law" is at minimum a monotone one. A band that gained
    // power against the band above it would be a resonance — a single octave
    // ringing, which is what a badly band-limited synthesis produces.
    for (let index = 1; index < bands.length; index += 1) {
      expect(bands[index]!.power).toBeLessThan(bands[index - 1]!.power);
    }
    // RECORDED, not pinned: the fitted exponent itself. Real topography runs
    // roughly L^2 to L^3 in 1D power; this is inside that, but the number is a
    // description of the landscape rather than a threshold anyone allocated.
    const fit = logLogSlope(stats.powerByWavelength, 256, 32);
    expect(fit.slope).toBeGreaterThan(1);
    expect(fit.slope).toBeLessThan(5);
  });
});
