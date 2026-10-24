import type { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import type { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { describe, expect, it } from "vitest";
import { GLOBAL_HEIGHT_PYRAMID_WGSL } from "../src/render/webgpu/terrain/GlobalHeightPyramid";
import { terrainPageSplatWgsl } from "../src/render/webgpu/terrain/PageOcclusionBake";
import { RUNWAY_EARTHWORKS_WGSL } from "../src/render/webgpu/terrain/RunwayEarthworks";
import { RUNWAY_SDF_WGSL } from "../src/render/webgpu/terrain/RunwaySurface";
import { terrainPageGenerationWgsl } from "../src/render/webgpu/terrain/TerrainPageAtlas";
import { bathymetryUpdateWgsl } from "../src/render/webgpu/water/BathymetryClipmap";
import {
  TERRAIN_KERNEL_FORBIDDEN_BUILTINS,
  TERRAIN_KERNEL_LATTICES,
  TERRAIN_KERNEL_LATTICE_COUNT,
  TERRAIN_KERNEL_PAGE_BYTES,
  TERRAIN_KERNEL_WGSL,
  buildTerrainKernelPageUniform,
  terrainKernelLatticeBase,
  terrainKernelPageBindingWgsl,
  terrainLandformInput,
} from "../src/render/webgpu/terrain/TerrainKernel";
import {
  TERRAIN_LANDFORM_CONSTANTS,
  TERRAIN_LANDFORM_DATA_PLACEHOLDER_BYTES,
  TERRAIN_LANDFORM_WGSL,
  TerrainLandformDataBinding,
  terrainLandformDataBindingWgsl,
  type TerrainLandformDataSource,
} from "../src/render/webgpu/terrain/TerrainLandformKernel";
import { VOLCANIC_INDEX, emptyVolcanicSiteIndex } from "../src/render/webgpu/terrain/VolcanicOverlayKernel";
import { CLIMATE_PROVINCE } from "../src/world/climateProvince";
import { DUNE_PROFILE_CONSTANTS, DUNES, duneAcrossPhase, duneWindPhase } from "../src/world/dunes";
import { FRACTURE_EXPOSURE_MEAN, FRACTURE_RAVINE_MEAN } from "../src/world/geology";
import { LANDFORM_CORE, landformCoreCenter } from "../src/world/landforms";
import { octaveBandWeight } from "../src/world/noise";
import {
  LOCAL_RIDGES_KNOLL_MEAN,
  RIDGES_INVERSE_POW_31_MEAN,
  RIDGES_POW_212_MEAN,
  sampleNaturalTerrainIntermediates,
} from "../src/world/terrain";
import { createWorld } from "../src/world/world";

/**
 * The landform stage on the GPU: the dune lattices, the four landform rows of
 * the kernel page uniform and the private intermediates `terrainNaturalHeight`
 * records (TerrainKernel.ts), and the include that reads them
 * (TerrainLandformKernel.ts). These are the properties a wrong answer that
 * still compiles would get past; on-adapter parity is
 * `tests/gpu/terrain-landform-parity.test.ts`.
 */

const NATURAL = createWorld("landform-kernel");
const FORCED = createWorld("landform-kernel", { landforms: { dunes: true } });

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
}

/**
 * Whether source calls builtin, matched as a whole word: the volcanic
 * include's terrainVolcanicGround( is not a call to round(.
 */
function callsBuiltin(source: string, builtin: string): boolean {
  return new RegExp(`\\b${builtin.replace(/[()]/gu, "\\$&")}`, "u").test(source);
}

/** The four landform rows: 16 floats after the kept row and the province's two. */
function landformRows(buffer: ArrayBuffer): number[] {
  const floats = new Float32Array(buffer);
  const keptBase = TERRAIN_KERNEL_LATTICE_COUNT * 8;
  return [...floats.slice(keptBase + 12, keptBase + 28)];
}

describe("the dune lattices on the kernel page uniform", () => {
  it("are appended after the provinces, with DUNES' own figures", () => {
    const lastProvince = TERRAIN_KERNEL_LATTICES.findIndex(
      (lattice) => lattice.name === "provinceDryness[1]");
    expect(terrainKernelLatticeBase("duneErgPatch")).toBe(lastProvince + 1);
    const patch = TERRAIN_KERNEL_LATTICES.filter((lattice) => lattice.name.startsWith("duneErgPatch"));
    expect(patch).toHaveLength(DUNES.ergPatch.octaves);
    patch.forEach((lattice, octave) => {
      expect(lattice.space).toBe("world");
      expect(lattice.channel).toBe(DUNES.ergPatch.channel);
      // fbm2D keys its octaves on octave + 1.
      expect(lattice.octaveChannel).toBe(octave + 1);
      expect(lattice.divisorX).toBe(
        DUNES.ergPatch.baseWavelengthMeters / DUNES.ergPatch.lacunarity ** octave);
      expect(lattice.amplitude).toBe(DUNES.ergPatch.persistence ** octave);
      // The CPU calls fbm2D unfiltered: the outline may not move with level.
      expect(lattice.filterWidthMetersOverride).toBe(0);
    });
    for (const [name, field] of [
      ["duneMeander", DUNES.meander],
      ["duneMeanderFine", DUNES.meanderFine],
      ["duneCrest", DUNES.crest],
    ] as const) {
      const lattice = TERRAIN_KERNEL_LATTICES[terrainKernelLatticeBase(name)]!;
      expect(lattice.name).toBe(name);
      expect(lattice.space).toBe("world");
      expect(lattice.channel).toBe(field.channel);
      expect(lattice.octaveChannel).toBeNull();
      expect(lattice.divisorX).toBe(field.wavelengthMeters);
      expect(lattice.divisorZ).toBe(field.wavelengthMeters);
      expect(lattice.wavelengthMeters).toBe(field.wavelengthMeters);
      // filteredValueNoise2D on the CPU: the page's own width applies.
      expect(lattice.filterWidthMetersOverride).toBeUndefined();
    }
    expect(terrainKernelLatticeBase("duneCrest")).toBe(TERRAIN_KERNEL_LATTICE_COUNT - 1);
  });
});

describe("the landform rows of the kernel page uniform", () => {
  const page = { seedHash: NATURAL.seedHash, originX: 40_960, originZ: -12_288, filterWidthMeters: 16 };

  it("are all zero (gain 0) without a landform input, and the uniform keeps its size", () => {
    expect(landformRows(buildTerrainKernelPageUniform(page))).toEqual(new Array(16).fill(0));
    expect(landformRows(buildTerrainKernelPageUniform({ ...page, landform: null })))
      .toEqual(new Array(16).fill(0));
    expect(buildTerrainKernelPageUniform({ ...page, landform: terrainLandformInput(NATURAL) })
      .byteLength).toBe(TERRAIN_KERNEL_PAGE_BYTES);
  });

  it("carry the core offset, the radii, the band weight and the f64-reduced phases", () => {
    const input = terrainLandformInput(NATURAL)!;
    const center = landformCoreCenter(NATURAL);
    const rows = landformRows(buildTerrainKernelPageUniform({ ...page, landform: input }));
    const wind = NATURAL.prevailingWindRadians;
    const windPhase = duneWindPhase(wind, page.originX, page.originZ);
    const across = duneAcrossPhase(wind, page.originX, page.originZ) + windPhase * DUNES.scallopStagger;
    const baseX = page.originX - center.x;
    const baseZ = page.originZ - center.z;
    expect(rows).toEqual([
      Math.fround(page.originX - center.x),
      Math.fround(page.originZ - center.z),
      1,
      0,
      LANDFORM_CORE.innerRadiusMeters,
      LANDFORM_CORE.innerRadiusMeters + LANDFORM_CORE.rampMeters,
      Math.fround(octaveBandWeight(DUNES.spacingMeters, page.filterWidthMeters)),
      0,
      Math.fround(Math.sin(wind)),
      Math.fround(Math.cos(wind)),
      Math.fround(windPhase - Math.floor(windPhase)),
      Math.fround(across - Math.floor(across)),
      Math.fround(baseX),
      Math.fround(baseZ),
      Math.fround(baseX - Math.fround(baseX)),
      Math.fround(baseZ - Math.fround(baseZ)),
    ]);
    // hi + lo recovers the f64 offset to well under a millimetre.
    expect(Math.abs(rows[12]! + rows[14]! - baseX)).toBeLessThan(1e-6);
    expect(Math.abs(rows[13]! + rows[15]! - baseZ)).toBeLessThan(1e-6);
    // The reduced origin phase plus a local offset's phase is the CPU's phase
    // at origin + offset, modulo whole periods: the split is exact in f64.
    for (const [localX, localZ] of [[0, 0], [37.5, -411.25], [4_100, 2_048.75]] as const) {
      const local = (localX * Math.sin(wind) + localZ * Math.cos(wind)) / DUNES.spacingMeters;
      const whole = duneWindPhase(wind, page.originX + localX, page.originZ + localZ);
      const split = rows[10]! + local;
      expect(Math.abs((split - whole) - Math.round(split - whole))).toBeLessThan(1e-6);
    }
  });

  it("hoist the dune profile's band weight: 1 at L0, faded by a 512 m footprint", () => {
    const input = terrainLandformInput(NATURAL)!;
    const kept = (filterWidthMeters: number) =>
      landformRows(buildTerrainKernelPageUniform({ ...page, filterWidthMeters, landform: input }))[6];
    expect(kept(0)).toBe(1);
    expect(kept(64)).toBe(1);
    expect(kept(128)).toBe(Math.fround(octaveBandWeight(DUNES.spacingMeters, 128)));
    expect(kept(512)).toBe(0);
  });

  it("carry a forced world's flag and runway clearance", () => {
    const input = terrainLandformInput(FORCED)!;
    expect(input.forcedDunes).toBe(true);
    const rows = landformRows(buildTerrainKernelPageUniform({ ...page, landform: input }));
    expect(rows[2]).toBe(1);
    expect(rows[3]).toBe(1);
    expect(rows[4]).toBe(LANDFORM_CORE.forcedClearanceMeters);
    expect(rows[5]).toBe(
      LANDFORM_CORE.forcedClearanceMeters + LANDFORM_CORE.forcedClearanceRampMeters);
    expect(terrainLandformInput(NATURAL)!.forcedDunes).toBe(false);
  });

  it("are absent for an eroded world, whose GPU path has no landform stage", () => {
    expect(terrainLandformInput(createWorld("landform-kernel", { worldEvolution: "eroded" })))
      .toBeNull();
  });
});

describe("the natural kernel's recorded intermediates (kNatural)", () => {
  it("records every field the CPU kernel records, after the height and before the clamp", () => {
    const fields = Object.keys(sampleNaturalTerrainIntermediates(NATURAL.seedHash, 0, 0, 0));
    expect(fields.length).toBeGreaterThanOrEqual(14);
    const body = TERRAIN_KERNEL_WGSL.slice(TERRAIN_KERNEL_WGSL.indexOf("fn terrainNaturalHeight("));
    const clampAt = body.indexOf("return kClamp(height, K_MIN_TERRAIN_HEIGHT, K_MAX_TERRAIN_HEIGHT);");
    expect(clampAt).toBeGreaterThan(0);
    for (const field of fields) {
      expect(TERRAIN_KERNEL_WGSL, field).toMatch(new RegExp(`\\n  ${field}: f32,`, "u"));
      const at = body.indexOf(`kNatural.${field} = `);
      expect(at, field).toBeGreaterThan(0);
      expect(at, field).toBeLessThan(clampAt);
    }
    // The warped coordinate is the LOCAL warped offset (rule 1).
    expect(body).toContain("kNatural.warpedX = wx;");
    expect(body).toContain("kNatural.warpedZ = wz;");
    expect(TERRAIN_KERNEL_WGSL).toContain("var<private> kNatural: KNaturalIntermediates;");
  });

  it("declares the landform rows in the page struct, in the builder's order", () => {
    const binding = terrainKernelPageBindingWgsl(0, 0);
    const order = ["kept: vec4f", "province: vec4f", "provinceForced: vec4f",
      "landform: vec4f", "landformRadii: vec4f", "landformWind: vec4f", "landformBase: vec4f",
      "seeds: array<u32"];
    let cursor = 0;
    for (const member of order) {
      const at = binding.indexOf(member, cursor);
      expect(at, member).toBeGreaterThan(cursor - 1);
      cursor = at;
    }
  });
});

describe("the landform include (TerrainLandformKernel.ts)", () => {
  const code = stripComments(TERRAIN_LANDFORM_WGSL);

  it("uses none of the builtins whose rounding differs from the TypeScript", () => {
    for (const builtin of TERRAIN_KERNEL_FORBIDDEN_BUILTINS) {
      expect(callsBuiltin(code, builtin), `landform WGSL uses ${builtin}`).toBe(false);
    }
    expect(callsBuiltin("let g = terrainVolcanicGround(x);", "round(")).toBe(false);
    expect(callsBuiltin("let r = round(x);", "round(")).toBe(true);
  });

  it("emits every injected constant with its f64 value, and reads each one", () => {
    for (const [name, value] of Object.entries(TERRAIN_LANDFORM_CONSTANTS)) {
      const declaration = new RegExp(`\\nconst KL_${name}: f32 = ([^;]+);`, "u").exec(code);
      expect(declaration, name).not.toBeNull();
      expect(Number(declaration![1]), name).toBe(value);
      // Declared and never read is a retyped literal somewhere instead.
      const uses = code.match(new RegExp(`\\bKL_${name}\\b`, "gu")) ?? [];
      expect(uses.length, `KL_${name} is never read`).toBeGreaterThan(1);
    }
    // No KL_ name the table does not supply.
    const declared = [...code.matchAll(/\bconst KL_(\w+): f32/gu)].map((match) => match[1]);
    expect(declared.sort()).toEqual(Object.keys(TERRAIN_LANDFORM_CONSTANTS).sort());
  });

  it("injects the figures dunes.ts reads, from the modules dunes.ts reads them from", () => {
    expect(TERRAIN_LANDFORM_CONSTANTS).toMatchObject({
      LOCAL_RIDGES_KNOLL_MEAN,
      FRACTURE_EXPOSURE_MEAN,
      FRACTURE_RAVINE_MEAN,
      RIDGES_POW_212_MEAN,
      RIDGES_INVERSE_POW_31_MEAN,
      ARID_DRYNESS_LOW: DUNES.aridDrynessLow,
      ARID_DRYNESS_HIGH: DUNES.aridDrynessHigh,
      ERG_PATCH_LOW: DUNES.ergPatch.low,
      ERG_PATCH_HIGH: DUNES.ergPatch.high,
      SPACING: DUNES.spacingMeters,
      BRINK_ROUNDING: DUNES.brinkRoundingMeters,
      SCALLOP_STAGGER: DUNES.scallopStagger,
      SCALLOP_JITTER: DUNES.scallopJitter,
      SAND_COVER_LOW: DUNES.sandCoverLowMeters,
      SAND_COVER_HIGH: DUNES.sandCoverHighMeters,
      SAND_SHEET_LOW: DUNES.sandSheetLow,
      SAND_SHEET_HIGH: DUNES.sandSheetHigh,
      STOSS_TAN: DUNE_PROFILE_CONSTANTS.stossTan,
      SLIP_TAN: DUNE_PROFILE_CONSTANTS.slipTan,
      CREST_HEIGHT_LIMIT: DUNE_PROFILE_CONSTANTS.crestHeightLimitMeters,
      STOSS_SHAPE_INTEGRAL: DUNE_PROFILE_CONSTANTS.stossShapeIntegral,
    });
    // The derived profile constants are the slopes DUNES names.
    expect(DUNE_PROFILE_CONSTANTS.stossTan).toBe(Math.tan(DUNES.stossDegrees * Math.PI / 180));
    expect(DUNE_PROFILE_CONSTANTS.slipTan).toBe(Math.tan(DUNES.slipDegrees * Math.PI / 180));
  });

  it("addresses the dune and dryness lattices at their table bases", () => {
    expect(code).toContain(`kFbm(${terrainKernelLatticeBase("provinceDryness")}u, `
      + `${CLIMATE_PROVINCE.dryness.octaves}u, localX, localZ)`);
    expect(code).toContain(`kFbm(${terrainKernelLatticeBase("duneErgPatch")}u, `
      + `${DUNES.ergPatch.octaves}u, localX, localZ)`);
    for (const name of ["duneMeander", "duneMeanderFine", "duneCrest"]) {
      expect(code, name).toContain(
        `kFilteredNoise(${terrainKernelLatticeBase(name)}u, localX, localZ)`);
    }
  });

  it("declares no binding of its own: the consumer prepends the data binding", () => {
    expect(code).not.toContain("@group");
    expect(terrainLandformDataBindingWgsl(1, 6))
      .toContain("@group(1) @binding(6) var<storage, read> terrainLandformData: array<vec4f>;");
    // The placeholder is the empty volcanic site index: no bins, no volcanism.
    expect(TERRAIN_LANDFORM_DATA_PLACEHOLDER_BYTES).toBe((VOLCANIC_INDEX.headerVec4s + 1) * 16);
    const empty = new Uint32Array(emptyVolcanicSiteIndex().data.buffer);
    expect([empty[0], empty[1], empty[16]]).toEqual([0, 0, 0]);
  });

  it("composes the volcanic include into the hooks, activity read at the page's landform base", () => {
    expect(code).toContain("fn terrainVolcanicActivity(localX: f32, localZ: f32) -> f32 {");
    expect(code).toContain(
      "terrainVolcanicActivitySplit(terrainKernelPages[kPageIndex].landformBase, vec2f(localX, localZ))");
    expect(code).toContain(
      "fn terrainVolcanicOverlay(base: vec4f, local: vec2f, height: f32, filterWidth: f32) -> f32 {");
    expect(code).toContain("fn terrainVolcanicActivityAt(p: vec2f) -> f32 {");
    expect(code).toContain("fn terrainVolcanicGround(base: vec4f, local: vec2f, filterWidth: f32) -> vec3f {");
  });

  it("returns the natural height itself, not natural + 0, for gain 0 and inside the core", () => {
    const body = code.slice(code.indexOf("fn terrainLandforms("));
    expect(body).toContain("if (landform.z <= 0.0) { return natural; }");
    expect(body).toContain("if (coreMask <= 0.0) { return natural; }");
    expect(body).not.toMatch(/natural\s*\+/u);
    // natural -> dunes -> volcanic overlay, the CPU's order.
    expect(body.indexOf("terrainDuneStage(")).toBeLessThan(body.indexOf("terrainVolcanicOverlay("));
    expect(body).toContain("terrainKernelPages[kPageIndex].landformBase");
    expect(body).toContain("terrainKernelPages[kPageIndex].kept.w");
  });
});

/** The body of fn name in source, up to the next top-level fn. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`fn ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("\nfn ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

describe("the ground bake's entry points (climate gate, sand cover)", () => {
  const code = stripComments(TERRAIN_LANDFORM_WGSL);

  it("gates on the climate without ever reaching the natural kernel", () => {
    const gate = functionBody(code, "terrainLandformClimateGate");
    expect(gate).toContain("fn terrainLandformClimateGate(localX: f32, localZ: f32) -> bool {");
    // Gain 0 and the core first, then forced dunes, then arid, then the patch:
    // sampleErgFarWeight's early outs, in its order.
    const order = [
      "if (landform.z <= 0.0) { return false; }",
      "if (terrainLandformCoreMask(localX, localZ) <= 0.0) { return false; }",
      "if (landform.w > 0.0) { return true; }",
      "if (terrainDuneAridFactor(localX, localZ) <= 0.0) { return false; }",
      "return terrainDunePatchFactor(localX, localZ) > 0.0;",
    ];
    let cursor = 0;
    for (const line of order) {
      const at = gate.indexOf(line);
      expect(at, line).toBeGreaterThan(cursor);
      cursor = at;
    }
    // Neither the gate nor anything it calls reads the kernel or its record.
    for (const name of [
      "terrainLandformClimateGate",
      "terrainLandformCoreMask",
      "terrainDuneAridFactor",
      "terrainDunePatchFactor",
    ]) {
      const body = functionBody(code, name);
      expect(body, name).not.toContain("terrainNaturalHeight(");
      expect(body, name).not.toContain("kNatural");
    }
  });

  it("shares the dune evaluation between the height stage and the sand cover", () => {
    const cover = functionBody(code, "terrainLandformSandCover");
    expect(cover).toContain(
      "fn terrainLandformSandCover(localX: f32, localZ: f32, natural: f32) -> vec2f {");
    expect(cover.split("return vec2f(0.0, 0.0);").length - 1).toBe(3);
    expect(cover).toContain("terrainDuneSample(localX, localZ, coreMask)");
    expect(cover).toContain("terrainDuneSandCover(dune.erg, dune.duneHeight)");
    expect(cover).not.toContain("terrainNaturalHeight(");
    expect(functionBody(code, "terrainDuneStage")).toContain("terrainDuneSample(localX, localZ, coreMask)");
    // One dune field evaluation site, one erg weight site: nothing duplicated.
    expect(code.split("terrainDuneField(localX, localZ, erg)").length - 1).toBe(1);
    expect(code.split("terrainDuneErgWeight(localX, localZ, coreMask, relief)").length - 1).toBe(1);
    // The core mask has one definition, used by all three entry points.
    expect(code.split("terrainLandformCoreMask(localX, localZ)").length - 1).toBe(3);
  });
});

describe("the consumers of the landform stage", () => {
  const consumers = [
    ["page generation", terrainPageGenerationWgsl(
      TERRAIN_KERNEL_WGSL,
      terrainKernelPageBindingWgsl(0, 0),
      `${RUNWAY_SDF_WGSL}\n${RUNWAY_EARTHWORKS_WGSL}`,
    ), 6],
    ["height pyramid", GLOBAL_HEIGHT_PYRAMID_WGSL, 3],
    ["bathymetry", bathymetryUpdateWgsl(), 6],
    ["splat bake", terrainPageSplatWgsl(), 8],
  ] as const;

  it("each compose the include once and bind the data at a slot of their own", () => {
    for (const [name, source, binding] of consumers) {
      const declaration = `@group(0) @binding(${binding}) var<storage, read> terrainLandformData`;
      expect(source.split(declaration).length - 1, name).toBe(1);
      expect(source.split("fn terrainLandforms(").length - 1, name).toBe(1);
      // No other group-0 binding shares the slot.
      expect(source.split(`@group(0) @binding(${binding}) `).length - 1, name).toBe(1);
      // The include follows the kernel it reads kNatural from.
      expect(source.indexOf("fn terrainNaturalHeight("), name)
        .toBeLessThan(source.indexOf("fn terrainLandforms("));
    }
  });

  it("run natural -> landforms -> earthworks in the page bake, the CPU's order", () => {
    const body = functionBody(consumers[0][1], "pageHeightAt");
    const natural = body.indexOf("let natural = terrainNaturalHeight(localX, localZ);");
    const landformed = body.indexOf("let landformed = terrainLandforms(localX, localZ, natural);");
    const earthworks = body.indexOf("terrainRunwayEarthworksHeight(");
    expect(natural).toBeGreaterThan(0);
    expect(landformed).toBeGreaterThan(natural);
    expect(earthworks).toBeGreaterThan(landformed);
    expect(body.slice(earthworks)).toMatch(/earthworks,\s*landformed,/u);
  });

  it("draw landforms into the pyramid, and into the bed before the macro blend", () => {
    expect(functionBody(GLOBAL_HEIGHT_PYRAMID_WGSL, "bakePyramid")).toContain(
      "let height = terrainLandforms(localX, localZ, terrainNaturalHeight(localX, localZ));");
    const bed = functionBody(consumers[2][1], "updateBathymetry");
    const landformed = bed.indexOf("var height = terrainLandforms(localX, localZ, natural);");
    expect(landformed).toBeGreaterThan(bed.indexOf("let natural = terrainNaturalHeight(localX, localZ);"));
    expect(landformed).toBeLessThan(bed.indexOf("bathymetryParams.water.w > 0.5"));
  });

  it("give the splat bake the sand cover, behind the gate that reads no kernel", () => {
    const body = functionBody(consumers[3][1], "bakeSplat");
    // The gate comes first, and the kernel runs only inside it: a texel off
    // every erg (and every page inside the landform core) never evaluates it.
    const gate = body.indexOf("if (terrainLandformClimateGate(localX, localZ)) {");
    const cover = body.indexOf(
      "sandCover = terrainLandformSandCover(localX, localZ, terrainNaturalHeight(localX, localZ)).y;");
    expect(gate).toBeGreaterThan(0);
    expect(cover).toBeGreaterThan(gate);
    expect(body.slice(0, gate)).not.toContain("terrainNaturalHeight(");
    // The volcanic ground reads the binding at every texel, never the height stages.
    expect(body).toContain("splatVolcanicGround = terrainVolcanicGround(");
    expect(body).not.toContain("terrainLandforms(");
    // Every classification and both seasons read it.
    expect(body).toContain("splatSupersample(job, localX, localZ, job.placement.z, tapCanopy, province, sandCover);");
    expect(body).toContain("splatSupersample(job, localX, localZ, job.placement.w, tapCanopy, province, sandCover);");
  });
});

describe("TerrainLandformDataBinding", () => {
  const engine = {} as WebGPUEngine;
  function fakeShader(): { shader: ComputeShader; calls: [string, unknown][] } {
    const calls: [string, unknown][] = [];
    const shader = {
      setStorageBuffer: (name: string, buffer: unknown) => { calls.push([name, buffer]); },
    } as unknown as ComputeShader;
    return { shader, calls };
  }
  interface FakeSource {
    bufferVersion: number;
    buffer: StorageBuffer;
    covers: TerrainLandformDataSource["covers"];
    building: boolean;
    coverage: Float64Array;
  }
  function fakeSource(covers: TerrainLandformDataSource["covers"] = () => true): FakeSource {
    return { buffer: {} as StorageBuffer, bufferVersion: 0, covers, building: false, coverage: new Float64Array(4) };
  }

  it("binds a source once, and again only when its buffer, version or shader changes", () => {
    const first = fakeSource();
    const binding = new TerrainLandformDataBinding(first);
    const { shader, calls } = fakeShader();
    binding.bind(engine, shader);
    binding.bind(engine, shader);
    expect(calls).toEqual([["terrainLandformData", first.buffer]]);
    // The stream rebuilt its index in place: same object, new version.
    first.bufferVersion = 1;
    binding.bind(engine, shader);
    binding.bind(engine, shader);
    expect(calls).toHaveLength(2);
    // A new buffer behind the same source.
    first.buffer = {} as StorageBuffer;
    binding.bind(engine, shader);
    expect(calls[2]).toEqual(["terrainLandformData", first.buffer]);
    // A different source, then a recreated pipeline.
    const second = fakeSource();
    binding.setSource(second);
    binding.bind(engine, shader);
    expect(calls[3]).toEqual(["terrainLandformData", second.buffer]);
    const other = fakeShader();
    binding.bind(engine, other.shader);
    expect(other.calls).toEqual([["terrainLandformData", second.buffer]]);
    expect(calls).toHaveLength(4);
  });

  it("asks the source what it covers, and covers everything with the placeholder", () => {
    const asked: number[][] = [];
    const source = fakeSource((minX, minZ, maxX, maxZ) => {
      asked.push([minX, minZ, maxX, maxZ]);
      return minX > 0;
    });
    const binding = new TerrainLandformDataBinding(source);
    expect(binding.hasSource).toBe(true);
    expect(binding.covers(1, 2, 3, 4)).toBe(true);
    expect(binding.covers(-1, 2, 3, 4)).toBe(false);
    expect(asked).toEqual([[1, 2, 3, 4], [-1, 2, 3, 4]]);
    binding.setSource(null);
    expect(binding.hasSource).toBe(false);
    expect(binding.covers(-1, 2, 3, 4)).toBe(true);
  });

  it("holds a bake back only while the source builds something that may cover it", () => {
    const source = fakeSource((minX) => minX > 0);
    source.coverage = Float64Array.of(0, -5, 10, 5);
    const binding = new TerrainLandformDataBinding(source);
    // Settled: nothing better is coming, so even an uncovered page bakes.
    expect(binding.holdsBack(-1, 2, 3, 4)).toBe(false);
    source.building = true;
    expect(binding.holdsBack(-1, 2, 3, 4)).toBe(true);
    expect(binding.holdsBack(1, 2, 3, 4)).toBe(false);
    expect([...binding.coverage]).toEqual([0, -5, 10, 5]);
    // The placeholder never holds back, and covers the plane.
    binding.setSource(null);
    expect(binding.holdsBack(-1, 2, 3, 4)).toBe(false);
    expect([...binding.coverage]).toEqual([-Infinity, -Infinity, Infinity, Infinity]);
  });
});
