import { describe, expect, it } from "vitest";
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
  TERRAIN_LANDFORM_DATA_PLACEHOLDER_BYTES,
  TERRAIN_LANDFORM_WGSL,
  terrainLandformDataBindingWgsl,
} from "../src/render/webgpu/terrain/TerrainLandformKernel";
import { DUNES, duneAcrossPhase, duneWindPhase } from "../src/world/dunes";
import { LANDFORM_CORE, landformCoreCenter } from "../src/world/landforms";
import { octaveBandWeight } from "../src/world/noise";
import { sampleNaturalTerrainIntermediates } from "../src/world/terrain";
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
      expect(code.includes(builtin), `landform WGSL uses ${builtin}`).toBe(false);
    }
  });

  it("declares no binding of its own: the consumer prepends the data binding", () => {
    expect(code).not.toContain("@group");
    expect(terrainLandformDataBindingWgsl(1, 6))
      .toContain("@group(1) @binding(6) var<storage, read> terrainLandformData: array<vec4f>;");
    expect(TERRAIN_LANDFORM_DATA_PLACEHOLDER_BYTES).toBe(16);
  });

  it("keeps the volcanic hooks as stubs: activity reads the data binding, the overlay returns its height", () => {
    expect(code).toContain("fn terrainVolcanicActivity(localX: f32, localZ: f32) -> f32 {");
    expect(code).toContain("return kSaturate(terrainLandformData[0].x);");
    expect(code).toContain(
      "fn terrainVolcanicOverlay(base: vec4f, local: vec2f, height: f32, filterWidth: f32) -> f32 {\n"
      + "  return height;\n}");
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
