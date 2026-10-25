import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLIMATE_PROVINCE_FIELD_LANDFORM_COST,
  CLIMATE_PROVINCE_FIELD_LANES,
  CLIMATE_PROVINCE_FIELD_RESOLUTION,
  CLIMATE_PROVINCE_FIELD_SAMPLES_PER_FRAME,
  CLIMATE_PROVINCE_FIELD_TEXEL_METERS,
  ClimateProvinceFieldGrid,
  type ClimateProvinceFieldSample,
  type ClimateProvinceToneSample,
} from "../src/render/webgpu/terrain/ClimateProvinceField";
import {
  PROVINCE_FAR_BASE_DELTAS,
  PROVINCE_FAR_CANOPY_PAINT_DELTA,
  PROVINCE_FAR_CANOPY_TROPICAL_DELTA,
  PROVINCE_FAR_CANOPY_PAINT_RATIO,
  PROVINCE_FAR_CANOPY_RATIOS,
  PROVINCE_FAR_LIFT_METERS_PER_TEMPERATURE,
  PROVINCE_FAR_SWARD_MIXES,
  TERRAIN_PROVINCE_CANOPY_DELTA_WGSL,
  TERRAIN_PROVINCE_TROPICAL_CANOPY_DELTA_WGSL,
  provinceFarTone,
  type ProvinceFarTone,
  provinceFarTundraFromLift,
  swardMixAlbedo,
} from "../src/render/webgpu/terrain/ProvinceFarTone";
import { surfaceMaterialSpec, SurfaceMaterial } from "../src/render/webgpu/terrain/surfaceMaterials";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import {
  IMPOSTOR_ALPHA_TEST_THRESHOLD,
  IMPOSTOR_SPECIES,
  impostorLayerIndex,
  planImpostorAtlas,
} from "../src/render/webgpu/detail/ImpostorAtlas";
import type { DetailTerrainSample } from "../src/render/webgpu/detail/types";
import {
  CLIMATE_PROVINCE_PRESETS,
  climateProvinceCoreCenter,
  sampleClimateProvince,
  type ClimateProvinceSample,
} from "../src/world/climateProvince";
import { borealShare, tundraShare } from "../src/world/coldBiomes";
import { tropicalCoastWeight } from "../src/world/tropicalCoast";
import { dryProvinceShares } from "../src/render/webgpu/detail/densityField";
import { createWorld, sampleTerrain } from "../src/world";
import { ERG_FAR_WEIGHT_SKIPPED, sampleErgFarWeight } from "../src/world/landforms";

/**
 * **Smooth biome transitions at range.** The far fallback (ground no trusted
 * page classifies) reads the climate province through a streamed field
 * (`ClimateProvinceField.ts`) and turns it into tones and a thermal lift
 * (`ProvinceFarTone.ts`), so a biome looks the same from 2 km and from 40 km.
 *
 * The first block is the contract that keeps every baseline bit-identical:
 * inside the temperate core the field is exactly 0 and so is everything the
 * shader derives from it. The rest pins the schedule (nearest first, budgeted,
 * one row per texel of flight) and that the tones are the biomes' own shares.
 */

const WORLD = createWorld("phase1-perf-baseline");
const CORE = climateProvinceCoreCenter(WORLD);

function isZero(value: number): boolean {
  return value === 0;
}

/** Half-float bits of a zero, of either sign: `x + (-0)` is `x` too. */
function isHalfZero(bits: number): boolean {
  return (bits & 0x7fff) === 0;
}

function toneSample(): ClimateProvinceToneSample {
  return { base: [0, 0, 0], canopyShare: 0, thermalLiftMeters: 0 };
}

/** Half precision: 11 significant bits, truncated (Babylon's ToHalfFloat). */
function expectHalfOf(actual: number, exact: number, label: string): void {
  expect(Math.abs(actual - exact), `${label}: ${actual} vs ${exact}`)
    .toBeLessThanOrEqual(Math.abs(exact) * 2 ** -10 + 1e-7);
}

function expectToneOf(actual: ClimateProvinceToneSample, exact: ProvinceFarTone, label: string): void {
  for (let channel = 0; channel < 3; channel += 1) {
    expectHalfOf(actual.base[channel]!, exact.base[channel]!, `${label} base ${channel}`);
  }
  expectHalfOf(actual.canopyShare, exact.canopyShare, `${label} canopy share`);
  expectHalfOf(actual.thermalLiftMeters, exact.thermalLiftMeters, `${label} lift`);
}

describe("the temperate core stays bit-identical", () => {
  it("bakes a field of exact zeros around the start airport", () => {
    const grid = new ClimateProvinceFieldGrid(WORLD, 32, CLIMATE_PROVINCE_FIELD_TEXEL_METERS);
    // 32 texels of 1.25 km: a 40 km window, wholly inside the 70 km core.
    while (grid.pending) grid.update(CORE.x, CORE.z, 4_096);
    expect(grid.data.every(isZero)).toBe(true);
    // And so is the tone the vertex stage samples: zero bits in every lane.
    expect(grid.paint.every(isHalfZero)).toBe(true);
    expect(grid.lift.every(isHalfZero)).toBe(true);
    const sample: ClimateProvinceFieldSample = { temperatureOffset: 1, dryness: 1, sand: 1 };
    const tone = toneSample();
    for (const [dx, dz] of [[0, 0], [7_313, -4_002], [-15_000, 11_111]] as const) {
      grid.sample(CORE.x + dx, CORE.z + dz, sample);
      expect(sample.temperatureOffset).toBe(0);
      expect(sample.dryness).toBe(0);
      grid.sampleTone(CORE.x + dx, CORE.z + dz, tone);
      expect(tone.base.every(isZero)).toBe(true);
      expect(tone.canopyShare === 0 && tone.thermalLiftMeters === 0).toBe(true);
    }
  });

  it("derives zero tones and zero lift from a zero province", () => {
    const tone = provinceFarTone(0, 0);
    expect(tone.base.every(isZero)).toBe(true);
    expect(tone.canopy.every(isZero)).toBe(true);
    expect(tone.thermalLiftMeters === 0).toBe(true);
    expect(provinceFarTundraFromLift(0)).toBe(0);
    // Every consumer is x + x * delta or x + lift: exactly x.
    const x = 0.118_000_1;
    expect(x + x * tone.base[0]!).toBe(x);
    expect(x + tone.thermalLiftMeters).toBe(x);
  });

  it("keeps the shares exactly 0 until each biome's onset", () => {
    for (const offset of [0, -0.03, -0.059, 0.05, 0.12, 0.14]) {
      const tone = provinceFarTone(offset, 0);
      expect(tone.canopy.every(isZero), `T=${offset}`).toBe(true);
      expect(tone.base.every(isZero), `T=${offset}`).toBe(true);
    }
    // A hot, wet province greens the canopy paint and leaves the sward alone.
    const tropical = provinceFarTone(0.4, 0);
    expect(tropical.canopyShare).toBe(-1);
    expect(tropical.base.every(isZero)).toBe(true);
    for (const dryness of [0, 0.05, -0.2]) {
      const tone = provinceFarTone(0, dryness);
      expect(tone.base.every(isZero), `D=${dryness}`).toBe(true);
    }
  });
});

describe("the streamed province field", () => {
  it("is one constant for a forced province, and never samples", () => {
    const tundra = createWorld("open-skies", { climateProvince: "tundra" });
    const grid = new ClimateProvinceFieldGrid(tundra);
    expect(grid.pending).toBe(false);
    expect(grid.update(123_456, -98_765)).toBe(0);
    expect(grid.samples).toBe(0);
    const preset = CLIMATE_PROVINCE_PRESETS.tundra;
    const sample: ClimateProvinceFieldSample = { temperatureOffset: 0, dryness: 0, sand: 0 };
    grid.sample(5_000, 9_000, sample);
    expect(sample.temperatureOffset).toBeCloseTo(preset.temperatureOffset, 6);
    expect(sample.dryness).toBeCloseTo(preset.dryness, 6);
    // Its tone is baked once, everywhere, at construction.
    const tone = grid.sampleTone(-71_234, 15_500, toneSample());
    expectToneOf(tone, provinceFarTone(preset.temperatureOffset, preset.dryness), "tundra");
    expect(tone.thermalLiftMeters).toBeGreaterThan(1_000);
  });

  it("bakes the camera's own neighbourhood first, inside the frame budget", () => {
    const grid = new ClimateProvinceFieldGrid(WORLD);
    // 120 km out, among the provinces.
    const x = CORE.x + 94_000;
    const z = CORE.z + 109_000;
    const baked = grid.update(x, z);
    expect(baked).toBe(CLIMATE_PROVINCE_FIELD_SAMPLES_PER_FRAME);
    expect(grid.pending).toBe(true);
    // 512 nearest-first slots cover rings 0..10 (21x21 = 441) and part of 11:
    // the 12 km around the camera is the real province after one frame.
    const texel = CLIMATE_PROVINCE_FIELD_TEXEL_METERS;
    const sample: ClimateProvinceFieldSample = { temperatureOffset: 0, dryness: 0, sand: 0 };
    const exact: ClimateProvinceSample = { temperatureOffset: 0, dryness: 0 };
    for (const [dx, dz] of [[0, 0], [9, -9], [-10, 4]] as const) {
      const cx = (Math.floor(x / texel) + dx + 0.5) * texel;
      const cz = (Math.floor(z / texel) + dz + 0.5) * texel;
      grid.sample(cx, cz, sample);
      sampleClimateProvince(WORLD, cx, cz, exact);
      expect(sample.temperatureOffset).toBeCloseTo(exact.temperatureOffset, 6);
      expect(sample.dryness).toBeCloseTo(exact.dryness, 6);
    }
    let frames = 1;
    while (grid.pending) {
      expect(grid.update(x, z)).toBeLessThanOrEqual(CLIMATE_PROVINCE_FIELD_SAMPLES_PER_FRAME);
      frames += 1;
    }
    const n = CLIMATE_PROVINCE_FIELD_RESOLUTION;
    expect(frames).toBe(Math.ceil((n * n) / CLIMATE_PROVINCE_FIELD_SAMPLES_PER_FRAME));
    expect(grid.samples).toBe(n * n);
    // Settled: no further work at all.
    expect(grid.update(x, z)).toBe(0);
  });

  it("matches the province at every texel centre once settled", () => {
    const grid = new ClimateProvinceFieldGrid(WORLD, 16, 2_500);
    const x = CORE.x - 60_000;
    const z = CORE.z + 150_000;
    while (grid.pending) grid.update(x, z, 1_000);
    const sample: ClimateProvinceFieldSample = { temperatureOffset: 0, dryness: 0, sand: 0 };
    const exact: ClimateProvinceSample = { temperatureOffset: 0, dryness: 0 };
    const cx = Math.floor(x / 2_500);
    const cz = Math.floor(z / 2_500);
    let moving = 0;
    for (let dz = -8; dz < 8; dz += 1) {
      for (let dx = -8; dx < 8; dx += 1) {
        const px = (cx + dx + 0.5) * 2_500;
        const pz = (cz + dz + 0.5) * 2_500;
        grid.sample(px, pz, sample);
        sampleClimateProvince(WORLD, px, pz, exact);
        expect(sample.temperatureOffset).toBeCloseTo(exact.temperatureOffset, 6);
        expect(sample.dryness).toBeCloseTo(exact.dryness, 6);
        if (exact.temperatureOffset !== 0 || exact.dryness !== 0) moving += 1;
      }
    }
    // The window is out among the provinces, not in the core's zeros.
    expect(moving).toBeGreaterThan(100);
  });

  it("re-bakes one row per texel of steady flight, and nothing else", () => {
    const n = CLIMATE_PROVINCE_FIELD_RESOLUTION;
    const texel = CLIMATE_PROVINCE_FIELD_TEXEL_METERS;
    const grid = new ClimateProvinceFieldGrid(WORLD);
    // 0.3 of the way into a texel, so a 0.4-texel nudge stays inside it.
    const x = (Math.floor((CORE.x + 40_000) / texel) + 0.3) * texel;
    const z = (Math.floor((CORE.z + 120_000) / texel) + 0.3) * texel;
    while (grid.pending) grid.update(x, z);
    const before = grid.samples;
    // Inside the same texel: free.
    expect(grid.update(x + 0.4 * texel, z)).toBe(0);
    // One texel east: exactly one column.
    let baked = 0;
    do baked += grid.update(x + texel, z); while (grid.pending);
    expect(baked).toBe(n);
    // One texel south-west of that: one row and one column, sharing a slot.
    baked = 0;
    do baked += grid.update(x, z - texel); while (grid.pending);
    expect(baked).toBe(2 * n - 1);
    expect(grid.samples).toBe(before + 3 * n - 1);
  });

  it("interpolates bilinearly between texel centres and wraps like the shader", () => {
    const tundra = createWorld("open-skies", { climateProvince: "tundra" });
    const grid = new ClimateProvinceFieldGrid(tundra, 4, 100);
    // Hand-written slots: the wrap at the window edge reads slot 0.
    grid.data.fill(0);
    grid.data[(0 * 4 + 3) * CLIMATE_PROVINCE_FIELD_LANES] = 1; // slot (3, 0)
    const sample: ClimateProvinceFieldSample = { temperatureOffset: 0, dryness: 0, sand: 0 };
    // Halfway between texel 3's centre (350) and texel 4's (450, slot 0).
    grid.sample(400, 50, sample);
    expect(sample.temperatureOffset).toBeCloseTo(0.5, 12);
    // Negative coordinates wrap onto the same slots.
    grid.sample(400 - 4 * 100, 50 - 4 * 100, sample);
    expect(sample.temperatureOffset).toBeCloseTo(0.5, 12);
  });

  it("bakes a landform lane beside the province, and charges the budget for it", () => {
    const calls: Array<[number, number]> = [];
    // A stand-in sand sea: a ramp east of x = 200 km, "no sample" (-1) west of
    // it, the way the dune stage's early outs report themselves.
    const grid = new ClimateProvinceFieldGrid(WORLD, 16, 1_250, {
      sand: (x, z) => {
        calls.push([x, z]);
        return x > 200_000 ? Math.min(1.5, (x - 200_000) / 5_000) : -1;
      },
    });
    // Wholly west: no landform work, so the frame bakes 16 texels a unit.
    expect(grid.update(100_000, 0, 16)).toBe(16);
    expect(calls).toHaveLength(16);
    while (grid.pending) grid.update(100_000, 0, 1_000);
    const west: ClimateProvinceFieldSample = { temperatureOffset: 0, dryness: 0, sand: 0 };
    grid.sample(100_000, 0, west);
    expect(west.sand).toBe(0);
    // Wholly east: each texel costs 1 + LANDFORM_COST units.
    const east = new ClimateProvinceFieldGrid(WORLD, 16, 1_250, {
      sand: (x) => (x > 200_000 ? Math.min(1.5, (x - 200_000) / 5_000) : -1),
    });
    expect(east.update(300_000, 0, 16)).toBe(Math.ceil(16 / (1 + CLIMATE_PROVINCE_FIELD_LANDFORM_COST)));
    while (east.pending) east.update(300_000, 0, 1_000);
    const sample: ClimateProvinceFieldSample = { temperatureOffset: 0, dryness: 0, sand: 0 };
    east.sample(300_000, 0, sample);
    // Clamped to 1 in the lane.
    expect(sample.sand).toBe(1);
    // A forced province with a landform lane still bakes: the lane is not a constant.
    const forced = new ClimateProvinceFieldGrid(
      createWorld("open-skies", { climateProvince: "high-desert" }), 8, 1_250, { sand: () => 0.5 },
    );
    expect(forced.pending).toBe(true);
    while (forced.pending) forced.update(0, 0, 1_000);
    forced.sample(0, 0, sample);
    expect(sample.sand).toBeCloseTo(0.5, 6);
    expect(sample.dryness).toBeCloseTo(CLIMATE_PROVINCE_PRESETS["high-desert"].dryness, 6);
  });

  it("bakes the dune stage's far erg weight into the clipmap's sand lane", () => {
    // The clipmap owns the wiring; it needs a Babylon scene, so pin its source.
    const clipmap = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src/render/webgpu/terrain/TerrainClipmapSystem.ts"),
      "utf8",
    );
    expect(clipmap).toContain("sand: (x, z) => sampleErgFarWeight(world, x, z)");

    // Over the forced sand sea the review shots fly (22 km from the capture
    // airport), the far ground is Sand: the lane reads a full erg.
    const forced = createWorld("phase1-perf-baseline", {
      climateProvince: "high-desert",
      landforms: { dunes: true },
    });
    const ergX = 7_271;
    const ergZ = -50_295;
    const sandSea = new ClimateProvinceFieldGrid(forced, 8, CLIMATE_PROVINCE_FIELD_TEXEL_METERS, {
      sand: (x, z) => sampleErgFarWeight(forced, x, z),
    });
    while (sandSea.pending) sandSea.update(ergX, ergZ, 1_000);
    const sample: ClimateProvinceFieldSample = { temperatureOffset: 0, dryness: 0, sand: 0 };
    sandSea.sample(ergX, ergZ, sample);
    expect(sample.sand).toBeGreaterThan(0.9);

    // Around a natural world's airport every texel is inside the landform
    // core: the lane skips (charging the budget nothing) and reads exactly 0,
    // so the far tone there is the province's own, x + 0.
    let skipped = 0;
    const core = new ClimateProvinceFieldGrid(WORLD, 8, CLIMATE_PROVINCE_FIELD_TEXEL_METERS, {
      sand: (x, z) => {
        const weight = sampleErgFarWeight(WORLD, x, z);
        if (weight === ERG_FAR_WEIGHT_SKIPPED) skipped += 1;
        return weight;
      },
    });
    const airport = WORLD.airport!;
    expect(core.update(airport.centerX, airport.centerZ, 64)).toBe(64);
    expect(skipped).toBe(64);
    core.sample(airport.centerX, airport.centerZ, sample);
    expect(sample.sand).toBe(0);
  });

  it("rejects what it cannot bake", () => {
    expect(() => new ClimateProvinceFieldGrid(WORLD, 3)).toThrow(RangeError);
    expect(() => new ClimateProvinceFieldGrid(WORLD, 8, 0)).toThrow(RangeError);
    const grid = new ClimateProvinceFieldGrid(WORLD, 8);
    expect(() => grid.update(Number.NaN, 0)).toThrow(RangeError);
  });
});

describe("the far tones are the biomes' own", () => {
  it("weights each tone by the share the near ground and the trees use", () => {
    for (const [offset, dryness] of [
      [-0.22, 0], [-0.55, 0], [0, 0.5], [0.12, 0.25], [-0.5, 0.4], [0.28, -0.15], [0.2, 0.1],
    ] as const) {
      const tone = provinceFarTone(offset, dryness);
      const boreal = borealShare(offset);
      const tundra = tundraShare(offset);
      const { arid, parkland } = dryProvinceShares(dryness);
      const baseScale = 1 / Math.max(1, tundra + arid + parkland);
      const tropical = tropicalCoastWeight(offset, dryness);
      // Signed: the tropics never share a point with a taiga or a desert.
      expect(tropical === 0 || boreal + arid === 0).toBe(true);
      const canopyShare = (boreal + arid) / Math.max(1, boreal + arid + parkland) - tropical;
      expect(tone.canopyShare).toBeCloseTo(canopyShare, 12);
      for (let channel = 0; channel < 3; channel += 1) {
        expect(tone.base[channel]).toBeCloseTo((
          tundra * PROVINCE_FAR_BASE_DELTAS.tundra[channel]!
          + arid * PROVINCE_FAR_BASE_DELTAS.arid[channel]!
          + parkland * PROVINCE_FAR_BASE_DELTAS.parkland[channel]!) * baseScale, 12);
        expect(tone.canopy[channel]).toBeCloseTo(
          Math.max(canopyShare, 0) * PROVINCE_FAR_CANOPY_PAINT_DELTA[channel]!
          + Math.max(-canopyShare, 0) * PROVINCE_FAR_CANOPY_TROPICAL_DELTA[channel]!, 12);
      }
      expect(tone.thermalLiftMeters).toBeCloseTo(-offset * PROVINCE_FAR_LIFT_METERS_PER_TEMPERATURE, 9);
      expect(provinceFarTundraFromLift(tone.thermalLiftMeters)).toBeCloseTo(tundra, 9);
    }
  });

  it("paints a full province in its own sward's colour", () => {
    const grass = surfaceMaterialSpec(SurfaceMaterial.Grass).referenceAlbedo;
    const cases = [
      [CLIMATE_PROVINCE_PRESETS.tundra, PROVINCE_FAR_SWARD_MIXES.tundra],
      [CLIMATE_PROVINCE_PRESETS["high-desert"], PROVINCE_FAR_SWARD_MIXES.arid],
    ] as const;
    for (const [preset, mix] of cases) {
      const tone = provinceFarTone(preset.temperatureOffset, preset.dryness);
      const tundra = tundraShare(preset.temperatureOffset);
      const { arid, parkland } = dryProvinceShares(preset.dryness);
      const share = tundra + arid + parkland;
      const target = swardMixAlbedo(mix);
      for (let channel = 0; channel < 3; channel += 1) {
        // The tone moves Grass toward the sward by exactly the biome's share.
        const painted = grass[channel]! * (1 + tone.base[channel]!);
        const expected = grass[channel]! + (target[channel]! - grass[channel]!) * Math.min(1, share);
        expect(painted).toBeCloseTo(expected, 9);
      }
    }
    // A desert's far ground is straw, not grass: brighter and redder.
    const desert = provinceFarTone(0, 0.5);
    expect(desert.base[0]).toBeGreaterThan(0.5);
    expect(desert.base[0]).toBeGreaterThan(desert.base[1]!);
  });

  it("paints a sand sea Sand whatever the province around it grows", () => {
    const sand = surfaceMaterialSpec(SurfaceMaterial.Sand).referenceAlbedo;
    const grass = surfaceMaterialSpec(SurfaceMaterial.Grass).referenceAlbedo;
    for (const [offset, dryness] of [[0, 0], [0, 0.5], [-0.3, 0.45]] as const) {
      const full = provinceFarTone(offset, dryness, undefined, 1);
      const none = provinceFarTone(offset, dryness, undefined, 0);
      const half = provinceFarTone(offset, dryness, undefined, 0.5);
      for (let channel = 0; channel < 3; channel += 1) {
        expect(grass[channel]! * (1 + full.base[channel]!)).toBeCloseTo(sand[channel]!, 9);
        expect(half.base[channel]).toBeCloseTo((full.base[channel]! + none.base[channel]!) / 2, 12);
      }
      // The lane leaves the canopy and the lift alone.
      expect(full.canopy).toEqual(none.canopy);
      expect(full.thermalLiftMeters).toBe(none.thermalLiftMeters);
    }
    // And 0 sand in the core is still exact zeros.
    expect(provinceFarTone(0, 0, undefined, 0).base.every(isZero)).toBe(true);
  });

  it("darkens the far canopy as much as the province's drawn crowns darken", () => {
    // The ratio constants are measured; this re-measures them on a smaller
    // sample (12 cells a province, one seed), so a biome thread changing its
    // species table or tints fails here rather than reopening the ring.
    const plans = planImpostorAtlas("canopy-handoff");
    const speciesAlbedo = new Map<string, readonly [number, number, number]>();
    IMPOSTOR_SPECIES.forEach((species) => {
      const level0 = plans.albedo.layerChains[impostorLayerIndex(species, 0)]![0]!;
      const sum = [0, 0, 0];
      let covered = 0;
      for (let i = 0; i < level0.length; i += 4) {
        if (level0[i + 3]! / 255 < IMPOSTOR_ALPHA_TEST_THRESHOLD) continue;
        for (let c = 0; c < 3; c += 1) sum[c]! += level0[i + c]! / 255;
        covered += 1;
      }
      speciesAlbedo.set(species, [sum[0]! / covered, sum[1]! / covered, sum[2]! / covered]);
    });
    const drawnCrowns = (province: "temperate" | "boreal" | "high-desert" | "savanna" | "tropical") => {
      const world = createWorld("open-skies", { climateProvince: province });
      const sampler = (x: number, z: number) =>
        sampleTerrain(world, x, z) as unknown as DetailTerrainSample;
      const sum = [0, 0, 0];
      let area = 0;
      for (let i = 0; i < 12; i += 1) {
        const cell = generateDetailCell({
          worldSeed: world.seed,
          cellX: 20 + (i % 4) * 14,
          cellZ: -30 + Math.floor(i / 4) * 18,
          terrainSample: sampler,
          seaLevelMeters: world.seaLevel,
          dayOfYear: 171,
          latitudeDegrees: world.latitudeDegrees,
        });
        for (const tree of cell.trees) {
          const crown = Math.PI * tree.crownRadiusMeters ** 2;
          const albedo = speciesAlbedo.get(tree.species)!;
          for (let c = 0; c < 3; c += 1) sum[c]! += crown * albedo[c]! * tree.color[c]!;
          area += crown;
        }
      }
      expect(area, province).toBeGreaterThan(0);
      return sum.map((value) => value / area);
    };
    const temperate = drawnCrowns("temperate");
    const cases = [
      ["boreal", PROVINCE_FAR_CANOPY_RATIOS.boreal],
      ["high-desert", PROVINCE_FAR_CANOPY_RATIOS.arid],
      ["savanna", PROVINCE_FAR_CANOPY_RATIOS.parkland],
      ["tropical", PROVINCE_FAR_CANOPY_RATIOS.tropical],
    ] as const;
    for (const [province, ratios] of cases) {
      const drawn = drawnCrowns(province);
      const preset = CLIMATE_PROVINCE_PRESETS[province];
      // What the paint actually applies there, from the one shared ratio.
      const paint = provinceFarTone(preset.temperatureOffset, preset.dryness).canopy;
      for (let c = 0; c < 3; c += 1) {
        const measured = drawn[c]! / temperate[c]!;
        expect(
          Math.abs(measured - ratios[c]!),
          `${province} channel ${c}: measured ${measured.toFixed(3)} vs table ${ratios[c]}`,
        ).toBeLessThan(0.07);
        // The paint's single ratio stays within 8% of every province's crowns.
        expect(
          Math.abs(measured - (1 + paint[c]!)),
          `${province} channel ${c}: measured ${measured.toFixed(3)} vs paint ${(1 + paint[c]!).toFixed(3)}`,
        ).toBeLessThan(0.08);
      }
    }
    expect(PROVINCE_FAR_CANOPY_PAINT_RATIO).toBe(PROVINCE_FAR_CANOPY_RATIOS.boreal);
  }, 60_000);

  it("bakes the tone per texel into the half floats the vertex stage samples", () => {
    // Out among the provinces, where every lane moves.
    const texel = 2_500;
    const grid = new ClimateProvinceFieldGrid(WORLD, 16, texel, {
      sand: (x) => (x > CORE.x - 70_000 ? -1 : Math.min(1, (CORE.x - 70_000 - x) / 20_000)),
    });
    const x = CORE.x - 75_000;
    const z = CORE.z + 150_000;
    while (grid.pending) grid.update(x, z, 1_000);
    const province: ClimateProvinceFieldSample = { temperatureOffset: 0, dryness: 0, sand: 0 };
    const tone = toneSample();
    const left = toneSample();
    const right = toneSample();
    const cx = Math.floor(x / texel);
    const cz = Math.floor(z / texel);
    let moving = 0;
    for (let dz = -8; dz < 8; dz += 1) {
      for (let dx = -8; dx < 8; dx += 1) {
        const px = (cx + dx + 0.5) * texel;
        const pz = (cz + dz + 0.5) * texel;
        // At a texel centre the sampler returns that texel: the CPU tone of
        // its province, to half precision.
        grid.sample(px, pz, province);
        const exact = provinceFarTone(province.temperatureOffset, province.dryness, undefined, province.sand);
        expectToneOf(grid.sampleTone(px, pz, tone), exact, `texel (${dx}, ${dz})`);
        if (exact.base.some((value) => value !== 0)) moving += 1;
        // Halfway to the next one it is the mean of the two (bilinear, and
        // across the window's edge the repeat wrap).
        if (dx === 7) continue;
        grid.sampleTone(px, pz, left);
        grid.sampleTone(px + texel, pz, right);
        grid.sampleTone(px + texel / 2, pz, tone);
        expect(tone.canopyShare).toBeCloseTo((left.canopyShare + right.canopyShare) / 2, 9);
        expect(tone.thermalLiftMeters).toBeCloseTo((left.thermalLiftMeters + right.thermalLiftMeters) / 2, 6);
        expect(tone.base[0]).toBeCloseTo((left.base[0] + right.base[0]) / 2, 9);
      }
    }
    expect(moving).toBeGreaterThan(100);
    // The window repeats: one window east is the same slots.
    grid.sampleTone(x, z, left);
    grid.sampleTone(x + 16 * texel, z - 16 * texel, right);
    expect(right).toEqual(left);
  });

  it("emits the canopy deltas the fragment applies into WGSL", () => {
    for (const value of PROVINCE_FAR_CANOPY_PAINT_DELTA) {
      expect(TERRAIN_PROVINCE_CANOPY_DELTA_WGSL).toContain(String(Number(value.toPrecision(9))));
    }
    for (const value of PROVINCE_FAR_CANOPY_TROPICAL_DELTA) {
      expect(TERRAIN_PROVINCE_TROPICAL_CANOPY_DELTA_WGSL)
        .toContain(String(Number(value.toPrecision(9))));
    }
  });
});
