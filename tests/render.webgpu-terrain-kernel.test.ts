import { describe, expect, it } from "vitest";
import {
  TERRAIN_KERNEL_CONSTANTS,
  TERRAIN_KERNEL_FORBIDDEN_BUILTINS,
  TERRAIN_KERNEL_LATTICES,
  TERRAIN_KERNEL_LATTICE_COUNT,
  TERRAIN_KERNEL_PAGE_BYTES,
  TERRAIN_KERNEL_WGSL,
  buildTerrainKernelPageUniform,
  terrainKernelPageBindingWgsl,
} from "../src/render/webgpu/terrain/TerrainKernel";
import { hashSeed, mixSeed } from "../src/world/seed";
import { NOISE_LATTICE_WRAP_PERIOD_CELLS } from "../src/world/noise";

const SEED_HASH = hashSeed("phase-4-kernel");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
}

/**
 * `4-1`'s Node-side gate (assertions 78 and 79). The on-adapter parity
 * criteria are `tests/gpu/terrain-height-parity.test.ts`; these are the
 * properties that can be checked without a GPU, and that a GPU test would
 * not catch because the wrong answer still compiles.
 */
describe("terrain height kernel WGSL (4-1)", () => {
  const code = stripComments(TERRAIN_KERNEL_WGSL);

  // Assertion 78.
  it("contains no mix(, smoothstep( or round(", () => {
    // Each has a different rounding rule from the TypeScript it ports:
    // mix is a·(1−t)+b·t against lerp's a+(b−a)·t (102 sites per sample);
    // smoothstep has no low == high guard; round is half-to-even against
    // Math.round's half-toward-+∞.
    for (const builtin of TERRAIN_KERNEL_FORBIDDEN_BUILTINS) {
      expect(code.includes(builtin), `emitted WGSL uses ${builtin}`).toBe(false);
    }
    // The hand-written replacements are all there and all used.
    for (const replacement of ["kLerp(", "kSmoothstep(", "kRound(", "kFade("]) {
      expect(code, replacement).toContain(replacement);
    }
  });

  // Assertion 79.
  it("carries all eleven injected expectation constants verbatim", () => {
    const entries = Object.entries(TERRAIN_KERNEL_CONSTANTS);
    expect(entries).toHaveLength(11);
    for (const [name, value] of entries) {
      const literal = Number.isInteger(value) ? `${value}.0` : String(value);
      expect(code, `${name} = ${literal}`).toContain(literal);
    }
    // …and they are injected, not retyped: the source of each is the module
    // that owns it, so a drift there fails this test rather than shipping.
    expect(TERRAIN_KERNEL_CONSTANTS.RIDGED_OCTAVE_BAND_LIMIT_MEAN).toBe(0.4491);
    expect(TERRAIN_KERNEL_CONSTANTS.MAX_TERRAIN_HEIGHT).toBe(4_500);
  });

  it("enumerates the lattices one evaluation costs", () => {
    // The HEIGHT chain is 34 valueNoise2D calls = 306 avalanche() calls = 612
    // wrapping u32 multiplies. That is the number `4-3`'s compute budget row
    // derives from, and it must not drift when `4-6` appends its own channels.
    const heightChain = TERRAIN_KERNEL_LATTICES.filter(
      (lattice) => !lattice.name.startsWith("moisture") && !lattice.name.startsWith("climate"),
    );
    expect(heightChain).toHaveLength(34);
    // `4-6` (D5) moved the climate chain here from `4-1`: four moisture-broad
    // octaves, the local and rain-shadow channels, and three climate octaves.
    expect(TERRAIN_KERNEL_LATTICE_COUNT).toBe(43);
    const names = TERRAIN_KERNEL_LATTICES.map((lattice) => lattice.name);
    expect(new Set(names).size).toBe(43);
    for (const lattice of TERRAIN_KERNEL_LATTICES) {
      expect(lattice.divisorX, lattice.name).toBeGreaterThan(0);
      expect(lattice.divisorZ, lattice.name).toBeGreaterThan(0);
      expect(lattice.wavelengthMeters, lattice.name).toBeGreaterThan(0);
      expect(lattice.amplitude, lattice.name).toBeGreaterThan(0);
    }
    // The anisotropic geology channels key their fade on the SMALLER period.
    const fracture = TERRAIN_KERNEL_LATTICES.find((l) => l.name === "fractureRidges[0]")!;
    expect(fracture.divisorX).toBe(390);
    expect(fracture.divisorZ).toBe(980);
    expect(fracture.wavelengthMeters).toBe(390);
  });

  it("declares its binding without baking one in", () => {
    // The include declares no bindings: consumers substitute their own, the
    // way the PBR plugin does.
    expect(code).not.toContain("@group");
    expect(terrainKernelPageBindingWgsl(0, 3)).toContain("@group(0) @binding(3)");
    // Pages are a runtime-sized ARRAY: one dispatch may resolve a batch,
    // because Babylon submits a frame's passes as one command buffer and a
    // writeBuffer between dispatches would land before any of them ran.
    expect(terrainKernelPageBindingWgsl(0, 3))
      .toContain("array<TerrainKernelPage>");
    expect(code).toContain("kSelectPage(");
  });

  it("splits every hoisted origin into an exact integer and a unit fraction", () => {
    for (const originX of [0, 512, -8_192, 131_072, 4_000_000]) {
      const buffer = buildTerrainKernelPageUniform({
        seedHash: SEED_HASH,
        originX,
        originZ: -originX * 0.5,
        filterWidthMeters: 0,
      });
      expect(buffer.byteLength).toBe(TERRAIN_KERNEL_PAGE_BYTES);
      const floats = new Float32Array(buffer);
      for (let index = 0; index < TERRAIN_KERNEL_LATTICE_COUNT; index += 1) {
        const cellU = floats[index * 4]!;
        const fracU = floats[index * 4 + 1]!;
        const cellV = floats[index * 4 + 2]!;
        const fracV = floats[index * 4 + 3]!;
        expect(Number.isInteger(cellU)).toBe(true);
        expect(Number.isInteger(cellV)).toBe(true);
        // Exactly representable in f32 and inside the wrap period.
        expect(Math.abs(cellU)).toBeLessThanOrEqual(NOISE_LATTICE_WRAP_PERIOD_CELLS / 2);
        expect(Math.abs(cellV)).toBeLessThanOrEqual(NOISE_LATTICE_WRAP_PERIOD_CELLS / 2);
        expect(fracU).toBeGreaterThanOrEqual(0);
        expect(fracU).toBeLessThan(1);
        expect(fracV).toBeGreaterThanOrEqual(0);
        expect(fracV).toBeLessThan(1);
      }
    }
  });

  it("hoists the band-limit weights and the variance-kept scalars per page", () => {
    const unfiltered = new Float32Array(buildTerrainKernelPageUniform({
      seedHash: SEED_HASH, originX: 0, originZ: 0, filterWidthMeters: 0,
    }));
    const filtered = new Float32Array(buildTerrainKernelPageUniform({
      seedHash: SEED_HASH, originX: 0, originZ: 0, filterWidthMeters: 512,
    }));
    const scaleBase = TERRAIN_KERNEL_LATTICE_COUNT * 4;
    const keptBase = scaleBase + TERRAIN_KERNEL_LATTICE_COUNT * 4;

    // Width 0 is the full-bandwidth kernel: every weight is exactly 1, so the
    // multiplication is a bit-exact no-op.
    for (let index = 0; index < TERRAIN_KERNEL_LATTICE_COUNT; index += 1) {
      expect(unfiltered[scaleBase + index * 4 + 2]).toBe(1);
    }
    expect(unfiltered[keptBase]).toBe(1);
    expect(unfiltered[keptBase + 1]).toBe(1);
    expect(unfiltered[keptBase + 2]).toBe(1);
    expect(unfiltered[keptBase + 3]).toBe(0);

    // At a 512 m footprint the short octaves are gone and the long ones are
    // untouched — the measured shape of the fade.
    const soil = TERRAIN_KERNEL_LATTICES.findIndex((l) => l.name === "soilUndulation");
    const warp = TERRAIN_KERNEL_LATTICES.findIndex((l) => l.name === "warpX");
    expect(filtered[scaleBase + soil * 4 + 2]).toBe(0);
    expect(filtered[scaleBase + warp * 4 + 2]).toBe(1);
    expect(filtered[keptBase]).toBeLessThan(1);
    expect(filtered[keptBase + 3]).toBe(512);
  });

  it("pre-mixes each lattice's seed exactly as valueNoise2D would", () => {
    const buffer = buildTerrainKernelPageUniform({
      seedHash: SEED_HASH, originX: 0, originZ: 0, filterWidthMeters: 0,
    });
    const seedOffset = (TERRAIN_KERNEL_LATTICE_COUNT * 8 + 4) * 4;
    const seeds = new Uint32Array(buffer, seedOffset, TERRAIN_KERNEL_LATTICE_COUNT);
    TERRAIN_KERNEL_LATTICES.forEach((lattice, index) => {
      const channelSeed = mixSeed(SEED_HASH, lattice.channel);
      const octaveSeed = lattice.octaveChannel === null
        ? channelSeed
        : mixSeed(channelSeed, lattice.octaveChannel);
      // valueNoise2D mixes channel 0 once and hashes four corners with it;
      // that mix is a PAGE constant, so hoisting it cannot change the answer.
      expect(seeds[index], lattice.name).toBe(mixSeed(octaveSeed, 0) >>> 0);
    });
    expect(new Set(seeds).size).toBe(TERRAIN_KERNEL_LATTICE_COUNT);
  });
});
