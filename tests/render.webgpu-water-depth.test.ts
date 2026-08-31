import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import {
  BathymetryClipmap,
  BATHYMETRY_CLIPMAP_EDGE,
  BATHYMETRY_COMPUTE_TIMEOUT_MILLISECONDS,
  BATHYMETRY_FAR_TEXEL_METERS,
  BATHYMETRY_LEVELS,
  BATHYMETRY_NEAR_TEXEL_METERS,
  BATHYMETRY_PAGE_FEATHER_METERS,
  BATHYMETRY_UPDATE_WGSL,
  bathymetryClipmapBytes,
  bathymetryErodedPageOverlaySeamFromAtlas,
  bathymetryErodedPageOverlayWeight,
  bathymetryPageDirtyRect,
  bathymetryPageHeightAtlasTexel,
  bathymetryUpdateRectangles,
  buildBathymetryPageTable,
  clipBathymetryRect,
  diffBathymetryResidentPages,
  dispatchBathymetryComputeWhenReady,
  sampleBathymetryMacroHeight,
  sampleBathymetryTerrainAuthority,
  toroidalBathymetryTexel,
  type BathymetryComputeDispatchPort,
  type BathymetryErodedPageOverlaySeam,
  type BathymetryResidentErodedPage,
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
  WATER_CAPILLARY_DETAIL_WGSL,
  WATER_CAUSTIC_DIRECT_SUN_FRACTION,
  WATER_CAUSTIC_FADE_START_METERS,
  WATER_CAUSTIC_GATE_METERS,
  WATER_CAUSTIC_JACOBIAN_SIGMA,
  WATER_CAUSTIC_NOISE_LAPLACIAN,
  WATER_CAUSTIC_NOISE_RMS,
  WATER_CAUSTIC_STRETCH_3_LAPLACIAN,
  WATER_CAUSTIC_SUN_FADE_HIGH,
  WATER_CAUSTIC_SUN_FADE_LOW,
  WATER_CAUSTIC_WGSL,
  WATER_CAUSTIC_ZERO,
  WATER_DEPTH_OPTICS_WGSL,
  WATER_SHORE_FADE_METERS,
  waterCausticBand,
  waterCausticBedGain,
  waterCausticCascadeBands,
  waterCausticNoiseBand,
  waterCausticSinusoidBand,
  waterRefractedSunBeam,
  type WaterCausticAccumulator,
} from "../src/render/webgpu/water/WaterShaders";
import {
  DEFAULT_SPECTRAL_OCEAN_CONFIG,
  OCEAN_CAUSTIC_CHOPPINESS_FLOOR,
  oceanCausticCurvatureScale,
} from "../src/render/webgpu/nature/OceanConfig";

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

function fakeComputeDispatch(
  dispatch: (shader: BathymetryComputeDispatchPort) => boolean,
): BathymetryComputeDispatchPort {
  const shader: BathymetryComputeDispatchPort = {
    name: "bathymetry-fixture",
    onCompiled: null,
    onError: null,
    dispatch: () => dispatch(shader),
  };
  return shader;
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
    expect(BATHYMETRY_COMPUTE_TIMEOUT_MILLISECONDS).toBe(30_000);
    expect(BATHYMETRY_UPDATE_WGSL).toContain("texture_storage_2d<r16float, write>");
  });

  it("rejects a WGSL compile error instead of leaving startup pending", async () => {
    const shader = fakeComputeDispatch((candidate) => {
      candidate.onError?.(
        null as never,
        "reserved keyword 'target'",
      );
      return false;
    });

    await expect(dispatchBathymetryComputeWhenReady(shader, 1, 1, 1))
      .rejects.toThrow("reserved keyword 'target'");
    expect(shader.onCompiled).toBeNull();
    expect(shader.onError).toBeNull();
  });

  it("rejects a compute readiness timeout and clears its callbacks", async () => {
    let dispatches = 0;
    const shader = fakeComputeDispatch(() => {
      dispatches += 1;
      return false;
    });

    await expect(dispatchBathymetryComputeWhenReady(shader, 1, 1, 1, {
      timeoutMilliseconds: 0,
      pollMilliseconds: 0,
    })).rejects.toThrow("Timed out dispatching bathymetry-fixture after 0 ms");
    expect(dispatches).toBe(1);
    expect(shader.onCompiled).toBeNull();
    expect(shader.onError).toBeNull();
  });

  it("settles and stops polling when owner disposal aborts an in-flight dispatch", async () => {
    const lifetime = new AbortController();
    let dispatches = 0;
    const shader = fakeComputeDispatch(() => {
      dispatches += 1;
      return false;
    });
    const pending = dispatchBathymetryComputeWhenReady(shader, 1, 1, 1, {
      timeoutMilliseconds: 60_000,
      pollMilliseconds: 60_000,
      signals: [lifetime.signal],
    });

    expect(dispatches).toBe(1);
    lifetime.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(dispatches).toBe(1);
    expect(shader.onCompiled).toBeNull();
    expect(shader.onError).toBeNull();
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

describe("W-6 eroded bathymetry page overlay (C-6)", () => {
  const overlayPage = (
    tileX: number,
    tileZ: number,
    slotU = 0,
    slotV = 0,
  ): BathymetryResidentErodedPage => ({ tileX, tileZ, slotU, slotV });

  it("builds a deterministic, capacity-clamped page table", () => {
    const pages = [
      overlayPage(5, 0, 264, 0),
      overlayPage(-3, -2, 0, 264),
      overlayPage(4, 0, 528, 0),
    ];
    const table = buildBathymetryPageTable(pages, 8);
    expect(table.length).toBe(4 + 8 * 4);
    expect(table[0]).toBe(3);
    // Sorted by (tileZ, tileX), independent of input order.
    expect([...table.slice(4, 8)]).toEqual([-3, -2, 0, 264]);
    expect([...table.slice(8, 12)]).toEqual([4, 0, 528, 0]);
    expect([...table.slice(12, 16)]).toEqual([5, 0, 264, 0]);
    // Capacity clamp keeps the first entries after the deterministic sort.
    const clamped = buildBathymetryPageTable(pages, 2);
    expect(clamped.length).toBe(4 + 2 * 4);
    expect(clamped[0]).toBe(2);
    expect([...clamped.slice(4, 8)]).toEqual([-3, -2, 0, 264]);
    // The analytic sentinel shape: count 0 with one never-indexed zero entry.
    expect([...buildBathymetryPageTable([], 0)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => buildBathymetryPageTable(
      [overlayPage(5, 0, 264, 0), overlayPage(5, 0, 0, 0)],
      8,
    )).toThrow("twice");
    expect(() => buildBathymetryPageTable(
      [{ tileX: 0.5, tileZ: 0, slotU: 0, slotV: 0 }],
      8,
    )).toThrow(RangeError);
    expect(() => buildBathymetryPageTable([], -1)).toThrow(RangeError);
  });

  it("dirties a page footprint plus the feather margin at both levels", () => {
    expect(BATHYMETRY_PAGE_FEATHER_METERS).toBe(32);
    // L0: a 512 m page is 32×32 bathymetry texels; the feather adds 2 each side.
    expect(bathymetryPageDirtyRect(3, -2, BATHYMETRY_NEAR_TEXEL_METERS)).toEqual({
      minX: 94,
      minZ: -66,
      width: 36,
      height: 36,
    });
    // L1: 4×4 texels; the sub-texel feather still needs 1 texel each side.
    expect(bathymetryPageDirtyRect(3, -2, BATHYMETRY_FAR_TEXEL_METERS)).toEqual({
      minX: 11,
      minZ: -9,
      width: 6,
      height: 6,
    });
    expect(() => bathymetryPageDirtyRect(0, 0, 100)).toThrow(RangeError);
    expect(() => bathymetryPageDirtyRect(0.5, 0, 16)).toThrow(RangeError);
  });

  it("clips page rects to the window; the toroidal wrap stays in addressing", () => {
    const rect = bathymetryPageDirtyRect(31, 0, BATHYMETRY_NEAR_TEXEL_METERS);
    expect(rect.minX).toBe(990);
    expect(clipBathymetryRect(rect, 1000, -500)).toEqual({
      minX: 1000,
      minZ: -2,
      width: 26,
      height: 36,
    });
    // A footprint straddling the 1024-texel wrap stays ONE global rect: the
    // window is contiguous in global texels and only texture addressing
    // wraps, exactly as the movement strips already rely on.
    const straddling = clipBathymetryRect(
      bathymetryPageDirtyRect(32, 0, BATHYMETRY_NEAR_TEXEL_METERS),
      1000,
      -500,
    );
    expect(straddling).toEqual({ minX: 1022, minZ: -2, width: 36, height: 36 });
    expect(toroidalBathymetryTexel(1023, 0)[0]).toBe(1023);
    expect(toroidalBathymetryTexel(1024, 0)[0]).toBe(0);
    // Wholly outside the window: no texel represents the page.
    expect(clipBathymetryRect(rect, 4000, 4000)).toBeNull();
  });

  it("coalesces admissions, evictions and slot moves into one ordered batch", () => {
    const a = overlayPage(0, 0);
    const b = overlayPage(1, 0, 264, 0);
    const c = overlayPage(0, 1, 0, 264);
    expect(diffBathymetryResidentPages([], [])).toEqual([]);
    expect(diffBathymetryResidentPages([a, b], [b, a])).toEqual([]);
    const moved = { ...b, slotU: 528 };
    expect(diffBathymetryResidentPages([a, b], [moved, c])).toEqual([
      { tileX: 0, tileZ: 0 },
      { tileX: 1, tileZ: 0 },
      { tileX: 0, tileZ: 1 },
    ]);
  });

  it("mirrors the WGSL overlay selection: the feather faces macro ground only", () => {
    expect(bathymetryErodedPageOverlayWeight([], 100, 100)).toBeNull();
    expect(bathymetryErodedPageOverlayWeight([overlayPage(1, 0)], 100, 100)).toBeNull();
    const lone = [overlayPage(0, 0)];
    // Interior beyond the feather: full page authority.
    expect(bathymetryErodedPageOverlayWeight(lone, 256, 256)!.weight).toBe(1);
    // On a macro-facing border the weight vanishes — the seam never steps.
    expect(bathymetryErodedPageOverlayWeight(lone, 0, 256)!.weight).toBe(0);
    // Halfway through the feather: the smoothstep midpoint.
    expect(bathymetryErodedPageOverlayWeight(lone, 16, 256)!.weight).toBeCloseTo(0.5, 10);
    // Monotone from border to interior.
    let previousWeight = -1;
    for (let x = 0; x <= 48; x += 4) {
      const { weight } = bathymetryErodedPageOverlayWeight(lone, x, 256)!;
      expect(weight).toBeGreaterThanOrEqual(previousWeight);
      previousWeight = weight;
    }
    // Two resident pages share bit-exact gutters, so their internal seam
    // keeps full weight on both sides — no macro groove along the border.
    const pair = [overlayPage(0, 0), overlayPage(1, 0, 264, 0)];
    expect(bathymetryErodedPageOverlayWeight(pair, 508, 256)!.weight).toBe(1);
    expect(bathymetryErodedPageOverlayWeight(pair, 516, 256)!.weight).toBe(1);
    expect(bathymetryErodedPageOverlayWeight(pair, 508, 256)!.page).toEqual(pair[0]);
    expect(bathymetryErodedPageOverlayWeight(pair, 516, 256)!.page).toEqual(pair[1]);
    // A missing DIAGONAL neighbour still feathers the concave corner.
    const concave = [overlayPage(0, 0), overlayPage(1, 0), overlayPage(0, 1)];
    const corner = bathymetryErodedPageOverlayWeight(concave, 508, 508)!.weight;
    const amount = Math.hypot(4, 4) / BATHYMETRY_PAGE_FEATHER_METERS;
    expect(corner).toBeGreaterThan(0);
    expect(corner).toBeLessThan(1);
    expect(corner).toBeCloseTo(amount * amount * (3 - 2 * amount), 10);
  });

  it("mirrors the NEAREST height-atlas fetch through the stored gutter", () => {
    const page = overlayPage(2, -1, 264, 528);
    expect(bathymetryPageHeightAtlasTexel(page, 1_024, -512)).toEqual([268, 532]);
    expect(bathymetryPageHeightAtlasTexel(page, 1_024 + 7.9, -512 + 2)).toEqual([271, 533]);
    // The final 2 m core texel, never the far gutter.
    expect(bathymetryPageHeightAtlasTexel(page, 1_024 + 511.99, -512 + 511.99)).toEqual([
      264 + 4 + 255,
      528 + 4 + 255,
    ]);
  });

  it("filters the atlas residency view to fully resident L0 pages", () => {
    const view = {
      residency: {
        slotCount: 6,
        entries: [
          {
            address: { level: 0, x: 2, z: -1 },
            slotIndex: 1,
            lifecycle: { state: "resident" },
          },
          {
            address: { level: 0, x: 3, z: -1 },
            slotIndex: 2,
            lifecycle: { state: "generating" },
          },
          {
            address: { level: 1, x: 0, z: 0 },
            slotIndex: 3,
            lifecycle: { state: "resident" },
          },
        ],
      },
      slotOrigin: (slotIndex: number) => ({ u: slotIndex * 264, v: 0 }),
      texture: () => null,
    };
    const seam = bathymetryErodedPageOverlaySeamFromAtlas(() => view);
    expect(seam.residentErodedL0Pages()).toEqual([
      { tileX: 2, tileZ: -1, slotU: 264, slotV: 0 },
    ]);
    expect(seam.pageTableCapacity()).toBe(6);
    expect(seam.heightAtlasTexture()).toBeNull();
  });

  it("declares the overlay bindings with an inert empty-table sentinel", () => {
    expect(BATHYMETRY_UPDATE_WGSL).toContain(
      "@group(0) @binding(4) var<storage, read> bathymetryPageTable",
    );
    expect(BATHYMETRY_UPDATE_WGSL).toContain(
      "@group(0) @binding(5) var bathymetryHeightAtlas: texture_2d<f32>",
    );
    // r32float under layout 'auto': textureLoad only, never textureSample.
    expect(BATHYMETRY_UPDATE_WGSL).toContain("textureLoad(");
    expect(BATHYMETRY_UPDATE_WGSL).not.toContain("textureSample(");
    // The empty-table sentinel returns before any load — analytic worlds
    // keep byte-identical arithmetic, like the 1-float macro sentinel.
    expect(BATHYMETRY_UPDATE_WGSL).toContain("if (entryCount <= 0)");
    expect(BATHYMETRY_UPDATE_WGSL).toContain("if (paged.x > 0.0)");
    // The overlay lands after the macro blend and BEFORE the clamp.
    const overlayAt = BATHYMETRY_UPDATE_WGSL.indexOf(
      "= bathymetryResidentPageOverlay(worldXZ)",
    );
    const clampAt = BATHYMETRY_UPDATE_WGSL.indexOf("let bedDelta = clamp(");
    expect(overlayAt).toBeGreaterThan(-1);
    expect(overlayAt).toBeLessThan(clampAt);
  });

  it("republishes page deltas once per batch through the recenter entry", async () => {
    const macro = macroFixture();
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const pages: BathymetryResidentErodedPage[] = [];
    const seam: BathymetryErodedPageOverlaySeam = {
      residentErodedL0Pages: () => pages.slice(),
      heightAtlasTexture: () => null,
      pageTableCapacity: () => 4,
    };
    const clipmap = new BathymetryClipmap(
      scene,
      createWorld(BATHYMETRY_AUTHORITY_SEED, {
        airport: false,
        worldEvolution: "eroded",
      }),
      seam,
    );
    await clipmap.initialize(0, 0);
    expect(await clipmap.recenter(0, 0)).toBe(false);
    // Three admissions in one frame coalesce into a single rect batch...
    pages.push(overlayPage(0, 0), overlayPage(1, 0, 264, 0), overlayPage(0, 1, 0, 264));
    expect(await clipmap.recenter(0, 0)).toBe(true);
    // ...published exactly once: an unchanged snapshot is no further work.
    expect(await clipmap.recenter(0, 0)).toBe(false);
    // A slot move re-dispatches that page's footprint.
    pages[1] = { ...pages[1]!, slotU: 528 };
    expect(await clipmap.recenter(0, 0)).toBe(true);
    expect(await clipmap.recenter(0, 0)).toBe(false);
    // An eviction re-dispatches too: depth falls back to the macro floor.
    pages.pop();
    expect(await clipmap.recenter(0, 0)).toBe(true);
    expect(await clipmap.recenter(0, 0)).toBe(false);
    // An authority swap owns the refresh: its forced full square covers every
    // pending page delta and the published snapshot moves with it.
    pages.push(overlayPage(2, 2, 264, 264));
    clipmap.setMacroEvolution(macro);
    expect(clipmap.isResident).toBe(false);
    expect(await clipmap.recenter(0, 0)).toBe(true);
    expect(clipmap.isResident).toBe(true);
    expect(await clipmap.recenter(0, 0)).toBe(false);
    // A page outside both level windows publishes without dispatching.
    pages.push(overlayPage(100_000, 100_000));
    expect(await clipmap.recenter(0, 0)).toBe(false);
    pages.pop();
    expect(await clipmap.recenter(0, 0)).toBe(false);
    clipmap.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("ignores the overlay seam entirely in analytic worlds", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    let queried = 0;
    const clipmap = new BathymetryClipmap(
      scene,
      createWorld(BATHYMETRY_AUTHORITY_SEED, {
        airport: false,
        worldEvolution: "analytic",
      }),
      {
        residentErodedL0Pages: () => {
          queried += 1;
          return [overlayPage(0, 0)];
        },
        heightAtlasTexture: () => null,
        pageTableCapacity: () => 4,
      },
    );
    await clipmap.initialize(0, 0);
    expect(await clipmap.recenter(0, 0)).toBe(false);
    expect(await clipmap.recenter(16_000, 0)).toBe(true);
    expect(queried).toBe(0);
    clipmap.dispose();
    scene.dispose();
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

/**
 * 6-4 — Jacobian-driven bed caustics.
 *
 * The assertions below run the exported TypeScript oracle, which
 * `tests/gpu/water-caustics.test.ts` pins against the shipped WGSL on a real
 * adapter. Sweeping the physical properties here (hundreds of thousands of
 * field samples) and pinning agreement there is the split this repo uses
 * whenever a GPU test would be too heavy to be the whole gate.
 */

/**
 * TS mirror of `WATER_DETAIL_NOISE_WGSL`'s integer-hash value lattice — the
 * field the capillary octaves ride, and therefore the field whose statistics
 * the caustic constants were calibrated against. Sampled at a world-scale
 * origin on purpose: a fract-of-product hash degenerates there (the recorded
 * sin-hash incident), and the caustic term reads the lattice VALUE, which is
 * exactly the channel that would show it.
 */
function waterDetailHash(cellX: number, cellY: number, salt: number): number {
  const toU32 = (value: number): number => value >>> 0;
  const multiply = (a: number, b: number): number => Math.imul(a, b) >>> 0;
  let h = toU32(
    toU32(multiply(toU32(Math.trunc(cellX)), 0x27d4eb2d))
    ^ toU32(multiply(toU32(Math.trunc(cellY)), 0x165667b1))
    ^ toU32(multiply(toU32(Math.trunc(salt * 8)), 0x9e3779b9)),
  );
  h = toU32(h ^ (h >>> 15));
  h = multiply(h, 0x2c1b3c6d);
  h = toU32(h ^ (h >>> 12));
  h = multiply(h, 0x297a2d39);
  h = toU32(h ^ (h >>> 15));
  return h * 2.3283064365386963e-10;
}

function waterDetailValue(x: number, y: number, salt: number): number {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const localX = x - cellX;
  const localY = y - cellY;
  const blendX = localX * localX * (3 - 2 * localX);
  const blendY = localY * localY * (3 - 2 * localY);
  const a = waterDetailHash(cellX, cellY, salt);
  const b = waterDetailHash(cellX + 1, cellY, salt);
  const c = waterDetailHash(cellX, cellY + 1, salt);
  const d = waterDetailHash(cellX + 1, cellY + 1, salt);
  return (a + (b - a) * blendX) + ((c + (d - c) * blendX) - (a + (b - a) * blendX)) * blendY;
}

/** The four shipped capillary octaves: slope scale, cells/metre, k^2 factor. */
const CAPILLARY_OCTAVES: ReadonlyArray<readonly [number, number, number]> = [
  [0.14, 2.4, WATER_CAUSTIC_NOISE_LAPLACIAN],
  [0.10, 6.1, WATER_CAUSTIC_NOISE_LAPLACIAN],
  [0.085, 16.667, WATER_CAUSTIC_STRETCH_3_LAPLACIAN],
  [0.06, 50, WATER_CAUSTIC_STRETCH_3_LAPLACIAN],
];

/** Sun 64 degrees up: the elevation both water capture shots are framed near. */
const HIGH_SUN_SINE = 0.9;

function composeCapillaryCaustic(
  worldX: number,
  worldZ: number,
  depthMeters: number,
  octaveFades: readonly number[],
): { readonly caustic: WaterCausticAccumulator; readonly gain: number } {
  const beam = waterRefractedSunBeam(depthMeters, HIGH_SUN_SINE);
  let caustic = WATER_CAUSTIC_ZERO;
  CAPILLARY_OCTAVES.forEach(([slopeScale, cellsPerMeter, laplacian], index) => {
    const fade = octaveFades[index] ?? 0;
    const value = waterDetailValue(worldX * cellsPerMeter, worldZ * cellsPerMeter, index);
    caustic = waterCausticNoiseBand(
      caustic,
      value,
      slopeScale * cellsPerMeter * laplacian * fade,
      beam,
    );
  });
  return { caustic, gain: waterCausticBedGain(caustic, beam, 1) };
}

describe("6-4 bed caustics", () => {
  it("composes into the refracted bed from ONE include, in both materials", () => {
    // The caustic block lives inside the depth include, and the depth include
    // is what the parity test above pins into both materials verbatim — so the
    // single-authority proof is transitive rather than restated.
    expect(WATER_DEPTH_OPTICS_WGSL).toContain(WATER_CAUSTIC_WGSL);
    expect(WATER_DEPTH_OPTICS_WGSL).toContain("bed * causticGain * transmittance + turbidity");
    for (const shader of [WATER_FRAGMENT_WGSL, HYDROLOGY_WATER_FRAGMENT_WGSL]) {
      expect(shader).toContain(WATER_CAUSTIC_WGSL);
      // Exactly one definition and exactly one call, and the call is the one
      // inside waterVolumeRadiance — a second copy in one material is the
      // failure this file is named after.
      expect(shader.split("waterCausticBedGain(")).toHaveLength(3);
      expect(shader.split("fn waterCausticBedGain(")).toHaveLength(2);
      expect(shader.split("fn waterRefractedSunBeam(")).toHaveLength(2);
      expect(shader.split("fn waterCausticBand(")).toHaveLength(2);
    }
    // Neither material assembles bands by hand: the ocean's five cascade lanes
    // and the inland surface's three sinusoids both go through composers that
    // live in the include, so every line of caustic arithmetic in the tree is
    // covered by the GPU parity test.
    // Occurrence counts include the one definition each fragment composes, so
    // "definition only" is 2 and every extra is a call site.
    expect(WATER_FRAGMENT_WGSL.split("waterCausticCascadeBands(")).toHaveLength(3);
    expect(WATER_FRAGMENT_WGSL.split("waterCausticSinusoidBand(")).toHaveLength(2);
    // 6-1 added the fourth inland call site: the world-locked standing-wave
    // train is the first inland term whose curvature this band can actually
    // see (its Laplacian is exactly -a k^2 sin(phase)), which is the raise the
    // 6-4 comment above the inland sinusoids anticipated.
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL.split("waterCausticSinusoidBand(")).toHaveLength(6);
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL.split("waterCausticCascadeBands(")).toHaveLength(2);
    // The depth include must precede the capillary block in both materials:
    // the capillary octaves call into the caustic accumulator, and WGSL wants
    // a declaration before its use.
    for (const shader of [WATER_FRAGMENT_WGSL, HYDROLOGY_WATER_FRAGMENT_WGSL]) {
      expect(shader.indexOf(WATER_CAUSTIC_WGSL))
        .toBeLessThan(shader.indexOf(WATER_CAPILLARY_DETAIL_WGSL));
    }
  });

  it("generates its WGSL constants from the TypeScript the oracle uses", () => {
    // No literal is re-typed across the language boundary: a retune moves the
    // shader and the parity oracle in the same edit.
    expect(WATER_CAUSTIC_WGSL).toContain(
      `const WATER_CAUSTIC_GATE_METERS: f32 = ${WATER_CAUSTIC_GATE_METERS}.0;`,
    );
    expect(WATER_CAUSTIC_WGSL).toContain(
      `const WATER_CAUSTIC_FADE_START_METERS: f32 = ${WATER_CAUSTIC_FADE_START_METERS}.0;`,
    );
    expect(WATER_CAUSTIC_WGSL).toContain(
      `const WATER_CAUSTIC_JACOBIAN_SIGMA: f32 = ${WATER_CAUSTIC_JACOBIAN_SIGMA};`,
    );
    expect(WATER_CAUSTIC_WGSL).toContain(
      `const WATER_CAUSTIC_NOISE_RMS: f32 = ${WATER_CAUSTIC_NOISE_RMS};`,
    );
    // Self-contained pure arithmetic: no uniform, no binding, no sampler and
    // no texture read — which is what lets the GPU parity test compile this
    // block on its own, as a compute kernel AND at fragment stage. Comments are
    // stripped first: the prose above the functions names the texture fades
    // the CALLERS apply.
    const code = WATER_CAUSTIC_WGSL.replace(/\/\/.*$/gmu, "");
    for (const forbidden of ["uniforms.", "texture", "sampler", "@group", "var<", "dpdx"]) {
      expect(code, `caustic block must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("vanishes beyond the depth gate, and costs nothing there", () => {
    const strongCurvature: WaterCausticAccumulator = { curvature: -4, varianceSum: 1 };
    for (const depth of [WATER_CAUSTIC_GATE_METERS, 24.5, 60, 500, 4_000]) {
      const beam = waterRefractedSunBeam(depth, HIGH_SUN_SINE);
      // A zero beam is what makes every downstream block branch-skipped.
      expect(beam.weight).toBe(0);
      expect(beam.slantMeters).toBe(0);
      // ...and the accumulator it produces is the identity, so no band the
      // caller might still evaluate can leak in.
      expect(waterCausticBand(WATER_CAUSTIC_ZERO, -4, 1, beam)).toEqual({
        curvature: -4,
        varianceSum: 1,
      });
      expect(waterCausticBedGain(strongCurvature, beam, 1)).toBe(1);
    }
    // And it is already fading well before the gate, over a band wider than
    // the bathymetry texel — the shipped shore-foam band's lesson: a tight
    // depth key on a 16 m clipmap texel steps in 16 m blocks.
    expect(WATER_CAUSTIC_GATE_METERS - WATER_CAUSTIC_FADE_START_METERS)
      .toBeGreaterThan(BATHYMETRY_NEAR_TEXEL_METERS * 0.75);
    const justInside = waterRefractedSunBeam(WATER_CAUSTIC_GATE_METERS - 0.01, HIGH_SUN_SINE);
    expect(justInside.weight).toBeLessThan(1e-4);
    expect(waterCausticBedGain(strongCurvature, justInside, 1)).toBeCloseTo(1, 4);
  });

  it("is exactly inert where the bed is dry, at night, and in full shadow", () => {
    const strongCurvature: WaterCausticAccumulator = { curvature: -4, varianceSum: 1 };
    // Dry bed: depth 0 means a zero slant path, so the beam has not converged
    // at all and the gain is exactly 1 no matter what the surface is doing.
    // (The shoreline alpha already fades the surface out there; this makes the
    // caustic term incapable of painting anything onto dry land.)
    const dry = waterRefractedSunBeam(0, HIGH_SUN_SINE);
    expect(dry.slantMeters).toBe(0);
    expect(waterCausticBedGain(strongCurvature, dry, 1)).toBe(1);
    // Night, and the low-sun cut.
    for (const sunSine of [-1, -0.2, 0, WATER_CAUSTIC_SUN_FADE_LOW]) {
      const beam = waterRefractedSunBeam(3, sunSine);
      expect(beam.weight).toBe(0);
      expect(waterCausticBedGain(strongCurvature, beam, 1)).toBe(1);
    }
    // Cloud/terrain shadow: no direct beam, no caustic.
    expect(waterCausticBedGain(strongCurvature, waterRefractedSunBeam(3, HIGH_SUN_SINE), 0))
      .toBe(1);
    // A flat surface is inert at every depth: zero curvature, gain 1.
    for (const depth of [0.2, 1, 3, 8, 16, 23]) {
      expect(waterCausticBedGain(
        WATER_CAUSTIC_ZERO,
        waterRefractedSunBeam(depth, HIGH_SUN_SINE),
        1,
      )).toBeCloseTo(1, 12);
    }
  });

  it("responds monotonically to the stored Jacobian, and signs it physically", () => {
    const beam = waterRefractedSunBeam(6, HIGH_SUN_SINE);
    const scale = oceanCausticCurvatureScale(
      DEFAULT_SPECTRAL_OCEAN_CONFIG.cascades[0]!,
      DEFAULT_SPECTRAL_OCEAN_CONFIG.choppiness,
    );
    const gainForJacobian = (jacobian: number): number => waterCausticBedGain(
      waterCausticBand(
        WATER_CAUSTIC_ZERO,
        scale * (jacobian - 1),
        scale * WATER_CAUSTIC_JACOBIAN_SIGMA,
        beam,
      ),
      beam,
      1,
    );
    // Compression (J < 1) is a crest: the surface is a converging lens, so the
    // bed brightens, strictly, all the way to the focus. Stretching (J > 1) is
    // a trough: it spreads the beam and the bed strictly darkens.
    // At J = 1 this pixel sits at the field's MEAN curvature, and because the
    // sheet is mean-normalized against the band's own variance that is the
    // slightly-shaded ground between filaments, not 1.0 — the dark cells a
    // sunlit seabed actually shows. (A band with no statistical spread at all
    // is exactly 1; that case is the inertness test above.)
    let previous = gainForJacobian(1);
    expect(previous).toBeLessThan(1);
    expect(previous).toBeGreaterThan(0.9);
    let previousDark = 1;
    // Up to the focus (this band converges at a fold of ~0.25 under 6 m of
    // water) the response is strictly monotonic in both directions.
    for (let fold = 0.02; fold <= 0.24; fold += 0.02) {
      const brighter = gainForJacobian(1 - fold);
      const darker = gainForJacobian(1 + fold);
      expect(brighter).toBeGreaterThan(previous);
      expect(darker).toBeLessThan(previousDark);
      expect(darker).toBeLessThan(1);
      previous = brighter;
      previousDark = darker;
    }
    // The peak is bounded and lands inside the 2-4x contrast measured on
    // sunlit seabeds, before the direct-sun fraction trims it further.
    expect(previous).toBeGreaterThan(1.5);
    expect(previous).toBeLessThan(1 + WATER_CAUSTIC_DIRECT_SUN_FRACTION * 2.2);
    // Past the focus the beam has crossed over and spreads again — the term
    // has a real focal point rather than a saturating ramp. This is the same
    // reason the gate can sit at 24 m: nothing is left to place beyond it.
    expect(gainForJacobian(1 - 0.5)).toBeLessThan(previous);
    expect(gainForJacobian(1 - 0.5)).toBeLessThan(1.1);
    // Below the sun-elevation ramp the response is proportionally weaker, and
    // a fully shadowed pixel does not respond at all.
    const lowSun = waterRefractedSunBeam(6, (WATER_CAUSTIC_SUN_FADE_LOW + WATER_CAUSTIC_SUN_FADE_HIGH) / 2);
    expect(lowSun.weight).toBeGreaterThan(0);
    expect(lowSun.weight).toBeLessThan(1);
  });

  it("is a focal-length model: the water column picks which band lights up", () => {
    // The whole point of driving this from curvature rather than a texture.
    // Each band's contribution is faded once the column is past its own focal
    // depth, so the visible pattern coarsens as the water deepens.
    const fineBand = 3.3;   // 1/m — roughly the 4 cm capillary octave
    const coarseBand = 0.16; // 1/m — roughly cascade 0's 2 m band
    const shareOfFine = (depth: number): number => {
      const beam = waterRefractedSunBeam(depth, HIGH_SUN_SINE);
      const fine = waterCausticBand(WATER_CAUSTIC_ZERO, fineBand, fineBand, beam).curvature;
      const coarse = waterCausticBand(WATER_CAUSTIC_ZERO, coarseBand, coarseBand, beam).curvature;
      return fine / (fine + coarse);
    };
    expect(shareOfFine(0.5)).toBeGreaterThan(0.85);
    expect(shareOfFine(0.5)).toBeGreaterThan(shareOfFine(3));
    expect(shareOfFine(3)).toBeGreaterThan(shareOfFine(12));
    expect(shareOfFine(20)).toBeLessThan(0.5);
    // Slant path is strictly linear in depth inside the gate — the smoothest
    // possible dependence on a bilinearly-sampled 16 m bathymetry texel, so
    // nothing in the focal term can print the clipmap grid.
    const shallow = waterRefractedSunBeam(2, HIGH_SUN_SINE).slantMeters;
    expect(waterRefractedSunBeam(4, HIGH_SUN_SINE).slantMeters).toBeCloseTo(shallow * 2, 10);
    expect(waterRefractedSunBeam(8, HIGH_SUN_SINE).slantMeters).toBeCloseTo(shallow * 4, 10);
    // Snell bounds the slant: even with the sun on the horizon the refracted
    // beam crosses at most 1.52 depths of water.
    const grazing = waterRefractedSunBeam(10, WATER_CAUSTIC_SUN_FADE_HIGH);
    expect(grazing.slantMeters / 10).toBeGreaterThan(1.4);
    expect(grazing.slantMeters / 10).toBeLessThan(1.52);
  });

  it("moves light without creating any: mean-neutral over the shipped lattice", () => {
    // A caustic redistributes irradiance. Sampled over the real capillary
    // value lattice, at a site 128 km from the origin (world-scale hashes are
    // where the house's sin-fract lattices collapsed), the spatial mean of the
    // bed gain must stay at 1 for every depth inside the gate — otherwise the
    // term is a broad brightness change wearing a caustic costume, and that is
    // what a capture diff would actually be showing.
    const SIDE = 130;
    for (const [label, fades] of [
      ["all four octaves", [1, 1, 1, 1]],
      ["A and B only", [1, 1, 0, 0]],
      ["A only", [1, 0, 0, 0]],
      ["half fades", [0.5, 0.5, 0.5, 0.5]],
    ] as const) {
      for (const depth of [0.4, 1, 3, 8, 16, 23]) {
        let total = 0;
        let brightest = 0;
        let darkest = Infinity;
        for (let i = 0; i < SIDE; i += 1) {
          for (let j = 0; j < SIDE; j += 1) {
            const { gain } = composeCapillaryCaustic(
              128_000 + i * 0.037,
              -64_000 + j * 0.037,
              depth,
              fades,
            );
            total += gain;
            brightest = Math.max(brightest, gain);
            darkest = Math.min(darkest, gain);
          }
        }
        const mean = total / (SIDE * SIDE);
        expect(mean, `${label} at ${depth} m`).toBeGreaterThan(0.95);
        expect(mean, `${label} at ${depth} m`).toBeLessThan(1.05);
        // And it is a real pattern, not a flat multiply: bright filaments on a
        // darker ground, bounded on both sides.
        expect(brightest, `${label} at ${depth} m`).toBeGreaterThan(1);
        expect(darkest, `${label} at ${depth} m`).toBeLessThan(1);
        expect(brightest, `${label} at ${depth} m`).toBeLessThan(2.6);
        expect(darkest, `${label} at ${depth} m`).toBeGreaterThan(0.35);
      }
    }
  });

  it("keeps unrun cascades and flat inland water out of the accumulator", () => {
    const beam = waterRefractedSunBeam(9, HIGH_SUN_SINE);
    const scales = DEFAULT_SPECTRAL_OCEAN_CONFIG.cascades.map((cascade) =>
      oceanCausticCurvatureScale(cascade, DEFAULT_SPECTRAL_OCEAN_CONFIG.choppiness));
    const lanes = [scales[0]!, scales[1]!, scales[2]!, scales[3]!] as const;
    // A three-cascade profile writes zero into the unused lanes, and their
    // stored Jacobian carries the identity 1.0 — inert twice over, so the
    // composed CURVATURE is bit-identical either way.
    const fiveLanes = waterCausticCascadeBands(
      WATER_CAUSTIC_ZERO, [0.91, 0.97, 0.995, 1], 1, lanes, scales[4]!, beam,
    );
    const threeLanes = waterCausticCascadeBands(
      WATER_CAUSTIC_ZERO,
      [0.91, 0.97, 0.995, 1],
      1,
      [lanes[0], lanes[1], lanes[2], 0],
      0,
      beam,
    );
    expect(threeLanes.curvature).toBe(fiveLanes.curvature);
    // The variance is deliberately NOT identical: it is what spread the RUNNING
    // spectrum can produce, not what this fragment happens to be sampling, so a
    // band that is running but momentarily flat still counts toward the
    // mean-neutrality estimate. The two long cascades contribute 0.008% of it.
    expect(threeLanes.varianceSum).toBeLessThan(fiveLanes.varianceSum);
    expect(threeLanes.varianceSum / fiveLanes.varianceSum).toBeGreaterThan(0.999);
    // A perfectly flat spectrum bends no light at all.
    const flat = waterCausticCascadeBands(
      WATER_CAUSTIC_ZERO, [1, 1, 1, 1], 1, lanes, scales[4]!, beam,
    );
    expect(flat.curvature).toBe(0);
    expect(waterCausticBedGain(flat, beam, 1)).toBeLessThan(1);
    // The inland sinusoid band: a zero-amplitude wave is exactly inert, and a
    // crest (sin > 0, so a negative Laplacian) brightens the bed.
    expect(waterCausticSinusoidBand(WATER_CAUSTIC_ZERO, 1.3, 0, beam))
      .toEqual(WATER_CAUSTIC_ZERO);
    const inlandCrest = waterCausticSinusoidBand(WATER_CAUSTIC_ZERO, Math.PI / 2, 0.4, beam);
    const inlandTrough = waterCausticSinusoidBand(WATER_CAUSTIC_ZERO, -Math.PI / 2, 0.4, beam);
    expect(inlandCrest.curvature).toBeLessThan(0);
    expect(inlandTrough.curvature).toBeGreaterThan(0);
    expect(waterCausticBedGain(inlandCrest, beam, 1))
      .toBeGreaterThan(waterCausticBedGain(inlandTrough, beam, 1));
  });

  it("converts each cascade's Jacobian at its own band's wavenumber", () => {
    const { cascades, choppiness } = DEFAULT_SPECTRAL_OCEAN_CONFIG;
    const scales = cascades.map((cascade) => oceanCausticCurvatureScale(cascade, choppiness));
    // k/lambda at the band's geometric-mean wavelength: cascade 0's 0.5-8 m
    // band centres on 2 m, so 2*pi/2/1.15.
    expect(scales[0]).toBeCloseTo((2 * Math.PI) / 2 / choppiness, 10);
    // Strictly decreasing with wavelength — caustic focal length goes as 1/k,
    // so kilometre swell contributes nothing and the short band carries it.
    for (let index = 1; index < scales.length; index += 1) {
      expect(scales[index]!).toBeLessThan(scales[index - 1]!);
    }
    expect(scales.at(-1)!).toBeLessThan(scales[0]! / 100);
    // Cascade 0 reaches its focal depth near the gate, which is one of the
    // three bounds the gate value was chosen from.
    const focalDepth = 1 / (0.2498 * scales[0]! * WATER_CAUSTIC_JACOBIAN_SIGMA);
    expect(focalDepth).toBeGreaterThan(WATER_CAUSTIC_GATE_METERS * 0.8);
    expect(focalDepth).toBeLessThan(WATER_CAUSTIC_GATE_METERS * 1.3);
    // The choppiness floor bounds the amplification of a Jacobian that has
    // stopped carrying signal.
    expect(oceanCausticCurvatureScale(cascades[0]!, 0))
      .toBeCloseTo(oceanCausticCurvatureScale(cascades[0]!, OCEAN_CAUSTIC_CHOPPINESS_FLOOR), 10);
  });
});
