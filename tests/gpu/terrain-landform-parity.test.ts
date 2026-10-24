import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
// Side-effect import: register the compute pipeline methods on WebGPUEngine.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import {
  TERRAIN_KERNEL_PAGE_BYTES,
  TERRAIN_KERNEL_WGSL,
  buildTerrainKernelPageUniform,
  terrainKernelPageBindingWgsl,
  terrainLandformInput,
  type TerrainKernelLandformInput,
} from "../../src/render/webgpu/terrain/TerrainKernel";
import {
  TERRAIN_LANDFORM_WGSL,
  terrainLandformDataBindingWgsl,
} from "../../src/render/webgpu/terrain/TerrainLandformKernel";
import { packVolcanicSiteIndex } from "../../src/render/webgpu/terrain/VolcanicOverlayKernel";
import {
  TerrainPageAtlas,
  TerrainPageGenerator,
  invariantSlotKey,
} from "../../src/render/webgpu/terrain/TerrainPageAtlas";
import {
  TERRAIN_HEIGHT_PARITY_CRITERIA,
  TERRAIN_HEIGHT_SLOT_EDGE,
  terrainTexelSizeMeters,
} from "../../src/render/webgpu/terrain/TerrainSpineContract";
import { WORLD_PAGE_GUTTER } from "../../src/render/webgpu/world/pageGeometry";
import { createWorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import {
  DUNES,
  duneClimateFactors,
  unmaskedProvinceDryness,
  type DuneClimateFactors,
} from "../../src/world/dunes";
import {
  LANDFORM_CORE,
  applyTerrainLandforms,
  landformCoreCenter,
  landformCoreMask,
  sampleLandformCover,
} from "../../src/world/landforms";
import {
  sampleNaturalTerrainHeight,
  sampleNaturalTerrainIntermediates,
  sampleTerrainHeight,
} from "../../src/world/terrain";
import type { WorldDefinition } from "../../src/world/types";
import { createWorld } from "../../src/world/world";

/**
 * The landform stage's CPU/GPU parity: `applyTerrainLandforms` (landforms.ts,
 * dunes.ts) against `terrainLandforms` (TerrainLandformKernel.ts), on a real
 * adapter.
 *
 * Two properties, in the shape of `terrain-height-parity.test.ts`:
 *
 * - CONTAINMENT. Inside the landform core, and on a page built without a
 *   landform input, the GPU hook returns the natural height it was given BIT
 *   FOR BIT. That is the whole of the reason the perf baselines and the
 *   start-airport search cannot move.
 * - PARITY. In a sand sea, forced (10-40 km from the airport) and natural
 *   (an arid erg found 150-600 km out), the GPU agrees with the CPU at filter
 *   widths 0, 128 and 512 within the kernel's own near-field tolerance. 128
 *   and 512 are the mandatory rows for the same reason they are for the
 *   kernel: the dune profile fades to its analytic mean there, and a wrong
 *   mean or band weight is invisible at width 0.
 */

const FILTER_WIDTHS = [0, 128, 512] as const;
/**
 * Erg weight and sand cover, both in [0, 1]. The steepest path from a height
 * error to either is sand cover's smoothstep over 0.4-2.5 m of dune height
 * (slope at most 0.71 per metre), so the stage's 2 mm worst height error
 * bounds it at ~1.4e-3. Measured on SwiftShader: 6e-6 (erg) and 6e-5 (sand).
 * A wrong constant moves either by tenths.
 */
const SAND_TOLERANCE = 2e-3;
const PAGE_METERS = 512;
const NATURAL_WORLD = createWorld("landform-parity");
const FORCED_WORLD = createWorld("landform-parity", { landforms: { dunes: true } });

const KERNEL = /* wgsl */ `
${terrainKernelPageBindingWgsl(0, 0)}
${terrainLandformDataBindingWgsl(0, 3)}
${TERRAIN_KERNEL_WGSL}
${TERRAIN_LANDFORM_WGSL}

struct LandformProbe { pageIndex: u32, pad: u32, localX: f32, localZ: f32 };

@group(0) @binding(1) var<storage, read> probes: array<LandformProbe>;
@group(0) @binding(2) var<storage, read_write> results: array<vec4f>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes)) { return; }
  let probe = probes[id.x];
  kSelectPage(probe.pageIndex);
  // The climate gate first, as a ground bake calls it: before the kernel.
  let gate = terrainLandformClimateGate(probe.localX, probe.localZ);
  // The consumers' order: the natural kernel, then the landforms reading the
  // intermediates that very call recorded.
  let natural = terrainNaturalHeight(probe.localX, probe.localZ);
  let landformed = terrainLandforms(probe.localX, probe.localZ, natural);
  let cover = terrainLandformSandCover(probe.localX, probe.localZ, natural);
  results[id.x * 2u] = vec4f(natural, landformed, select(0.0, 1.0, gate), 0.0);
  results[id.x * 2u + 1u] = vec4f(cover, 0.0, 0.0);
}
`;

/** Floats per probe in the result buffer: (natural, landformed, gate, -), (erg, sand, -, -). */
const RESULT_FLOATS = 8;

function halton(index: number, base: number): number {
  let result = 0;
  let fraction = 1 / base;
  let i = index;
  while (i > 0) {
    result += (i % base) * fraction;
    i = Math.floor(i / base);
    fraction /= base;
  }
  return result;
}

interface ProbeSet {
  readonly name: string;
  readonly world: WorldDefinition;
  readonly landform: TerrainKernelLandformInput | null;
  readonly pageOrigins: readonly (readonly [number, number])[];
  readonly probes: Float32Array;
  readonly worldX: Float64Array;
  readonly worldZ: Float64Array;
  readonly count: number;
}

/** Page origins on the 512 m lattice, each probed at Halton points over its core and gutter. */
function buildProbeSet(
  name: string,
  world: WorldDefinition,
  landform: TerrainKernelLandformInput | null,
  pageOrigins: readonly (readonly [number, number])[],
  perPage: number,
): ProbeSet {
  const count = pageOrigins.length * perPage;
  const probes = new Float32Array(count * 4);
  const pageIndices = new Uint32Array(probes.buffer);
  const worldX = new Float64Array(count);
  const worldZ = new Float64Array(count);
  let index = 0;
  pageOrigins.forEach(([originX, originZ], page) => {
    for (let sample = 0; sample < perPage; sample += 1) {
      const localX = halton(sample + 1, 2) * (PAGE_METERS + 16) - 8;
      const localZ = halton(sample + 1, 3) * (PAGE_METERS + 16) - 8;
      pageIndices[index * 4] = page;
      probes[index * 4 + 2] = localX;
      probes[index * 4 + 3] = localZ;
      // The CPU oracle runs at the point the GPU sees: the f32 local offset.
      worldX[index] = originX + Math.fround(localX);
      worldZ[index] = originZ + Math.fround(localZ);
      index += 1;
    }
  });
  return { name, world, landform, pageOrigins, probes, worldX, worldZ, count };
}

function snapToPage(value: number): number {
  return Math.floor(value / PAGE_METERS) * PAGE_METERS;
}

/** Pages whose centre lies `minRadius`-`maxRadius` from the airport with a positive erg. */
function forcedErgPages(world: WorldDefinition, wanted: number): [number, number][] {
  const center = landformCoreCenter(world);
  const pages: [number, number][] = [];
  const seen = new Set<string>();
  for (let index = 0; index < 20_000 && pages.length < wanted; index += 1) {
    const angle = index * 2.399963;
    const radius = 10_000 + 30_000 * ((index * 0.618034) % 1);
    const x = snapToPage(center.x + Math.cos(angle) * radius);
    const z = snapToPage(center.z + Math.sin(angle) * radius);
    const key = `${x},${z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cover = sampleLandformCover(world, x + PAGE_METERS / 2, z + PAGE_METERS / 2, 0);
    if (cover.ergWeight > 0.05) pages.push([x, z]);
  }
  return pages;
}

/**
 * A natural world's sand seas, found the way a player would: scanning 150-600 km
 * out for arid ground first (the province alone is two lattices), then the
 * whole erg weight.
 */
function naturalErgPages(world: WorldDefinition, wanted: number): [number, number][] {
  const center = landformCoreCenter(world);
  const pages: [number, number][] = [];
  const step = 3_000;
  const outer = 600_000;
  const inner = LANDFORM_CORE.innerRadiusMeters + LANDFORM_CORE.rampMeters;
  for (let gz = -outer; gz <= outer && pages.length < wanted; gz += step) {
    for (let gx = -outer; gx <= outer && pages.length < wanted; gx += step) {
      const radius = Math.hypot(gx, gz);
      if (radius < inner || radius > outer) continue;
      const x = center.x + gx;
      const z = center.z + gz;
      if (unmaskedProvinceDryness(world.seedHash, x, z) <= DUNES.aridDrynessLow) continue;
      if (sampleLandformCover(world, x, z, 0).ergWeight <= 0.2) continue;
      // Spread the pages out: one per 30 km cell at most.
      const tooClose = pages.some(([px, pz]) => Math.hypot(px - x, pz - z) < 30_000);
      if (!tooClose) pages.push([snapToPage(x - PAGE_METERS / 2), snapToPage(z - PAGE_METERS / 2)]);
    }
  }
  return pages;
}

function packPages(set: ProbeSet, filterWidthMeters: number): Uint8Array {
  const packed = new Uint8Array(set.pageOrigins.length * TERRAIN_KERNEL_PAGE_BYTES);
  set.pageOrigins.forEach(([originX, originZ], index) => {
    packed.set(
      new Uint8Array(buildTerrainKernelPageUniform({
        seedHash: set.world.seedHash,
        originX,
        originZ,
        filterWidthMeters,
        landform: set.landform,
      })),
      index * TERRAIN_KERNEL_PAGE_BYTES,
    );
  });
  return packed;
}

async function withEngine<T>(run: (engine: WebGPUEngine) => Promise<T>): Promise<T> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, {
    antialias: false,
    enableAllFeatures: false,
    setMaximumLimits: false,
  });
  try {
    await engine.initAsync();
    engine.runRenderLoop(() => {});
    const result = await run(engine);
    engine.stopRenderLoop();
    return result;
  } finally {
    engine.dispose();
    canvas.remove();
  }
}

/**
 * The volcanic site index round a page, as a bake binds the stream's: built
 * once per page and reused at every width. The CPU oracle runs volcanism too,
 * so the GPU must see the sites near a sand sea (an empty index would draw a
 * natural erg without the volcano beside it, or the erg at full strength
 * where volcanism thins it).
 */
const SITE_INDEXES = new Map<string, Float32Array>();
function siteIndexAround(world: WorldDefinition, originX: number, originZ: number): Float32Array {
  const key = `${world.seed}|${JSON.stringify(world.landforms ?? null)}|${originX},${originZ}`;
  let data = SITE_INDEXES.get(key);
  if (!data) {
    data = packVolcanicSiteIndex(world, originX + PAGE_METERS / 2, originZ + PAGE_METERS / 2).data;
    SITE_INDEXES.set(key, data);
  }
  return data;
}

/**
 * RESULT_FLOATS per probe. One pipeline, one dispatch per page: a natural
 * world's sand seas lie 150-600 km apart, wider than one site index reaches,
 * so each page binds the index round itself.
 */
async function dispatch(
  engine: WebGPUEngine,
  set: ProbeSet,
  filterWidthMeters: number,
): Promise<Float32Array> {
  const perPage = set.count / set.pageOrigins.length;
  const results = new Float32Array(set.count * RESULT_FLOATS);
  const shader = new ComputeShader(
    `terrain-landform-parity-${set.name}-${filterWidthMeters}`,
    engine,
    { computeSource: KERNEL },
    {
      bindingsMapping: {
        terrainKernelPages: { group: 0, binding: 0 },
        probes: { group: 0, binding: 1 },
        results: { group: 0, binding: 2 },
        terrainLandformData: { group: 0, binding: 3 },
      },
    },
  );
  for (let page = 0; page < set.pageOrigins.length; page += 1) {
    const [originX, originZ] = set.pageOrigins[page]!;
    const one = buildProbeSet(set.name, set.world, set.landform, [[originX, originZ]], perPage);
    const pageBuffer = new StorageBuffer(engine, TERRAIN_KERNEL_PAGE_BYTES);
    pageBuffer.update(packPages(one, filterWidthMeters));
    const probeBuffer = new StorageBuffer(engine, one.probes.byteLength);
    probeBuffer.update(new Uint8Array(one.probes.buffer));
    const resultBuffer = new StorageBuffer(engine, one.count * RESULT_FLOATS * 4);
    const index = siteIndexAround(set.world, originX, originZ);
    const data = new StorageBuffer(engine, index.byteLength);
    data.update(index);
    shader.setStorageBuffer("terrainKernelPages", pageBuffer);
    shader.setStorageBuffer("probes", probeBuffer);
    shader.setStorageBuffer("results", resultBuffer);
    shader.setStorageBuffer("terrainLandformData", data);
    await shader.dispatchWhenReady(Math.ceil(one.count / 64), 1, 1);
    const view = await resultBuffer.read();
    results.set(
      new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + one.count * RESULT_FLOATS * 4)),
      page * perPage * RESULT_FLOATS,
    );
    pageBuffer.dispose();
    probeBuffer.dispose();
    resultBuffer.dispose();
    data.dispose();
  }
  return results;
}

describe("landform stage CPU/GPU parity (terrainLandforms)", () => {
  it("returns the natural height bit for bit inside the core and without a landform input", async () => {
    const naturalCenter = landformCoreCenter(NATURAL_WORLD);
    const forcedCenter = landformCoreCenter(FORCED_WORLD);
    // A natural world's core: a 7 x 7 grid of pages out to 90 km, all of each
    // page inside the 120 km inner radius.
    const corePages: [number, number][] = [];
    for (let row = -3; row <= 3; row += 1) {
      for (let column = -3; column <= 3; column += 1) {
        corePages.push([
          snapToPage(naturalCenter.x + column * 28_000),
          snapToPage(naturalCenter.z + row * 28_000),
        ]);
      }
    }
    // A forced world's runway clearance: pages within ~3.6 km of the airport,
    // inside the 5 km inner radius.
    const clearancePages: [number, number][] = [];
    for (let row = -2; row <= 1; row += 1) {
      for (let column = -2; column <= 1; column += 1) {
        clearancePages.push([
          snapToPage(forcedCenter.x) + column * PAGE_METERS,
          snapToPage(forcedCenter.z) + row * PAGE_METERS,
        ]);
      }
    }
    const ergPages = forcedErgPages(FORCED_WORLD, 12);
    expect(ergPages.length, "forced erg pages found").toBeGreaterThanOrEqual(8);
    const sets = [
      buildProbeSet("core", NATURAL_WORLD, terrainLandformInput(NATURAL_WORLD), corePages, 96),
      buildProbeSet(
        "clearance", FORCED_WORLD, terrainLandformInput(FORCED_WORLD), clearancePages, 96),
      // Gain 0: an erg the page was not told about is natural ground.
      buildProbeSet("no-input", FORCED_WORLD, null, ergPages, 96),
    ];
    const report: string[] = [];
    await withEngine(async (engine) => {
      for (const set of sets) {
        for (const filterWidthMeters of FILTER_WIDTHS) {
          const gpu = await dispatch(engine, set, filterWidthMeters);
          const bits = new Uint32Array(gpu.buffer);
          let mismatches = 0;
          let gated = 0;
          let covered = 0;
          for (let index = 0; index < set.count; index += 1) {
            const at = index * RESULT_FLOATS;
            if (bits[at] !== bits[at + 1]) mismatches += 1;
            if (gpu[at + 2] !== 0) gated += 1;
            if (gpu[at + 4] !== 0 || gpu[at + 5] !== 0) covered += 1;
          }
          report.push(
            `${set.name}, fw ${filterWidthMeters}: ${mismatches} of ${set.count} not bit-identical; `
            + `${gated} gated open; ${covered} with sand cover`);
          expect(mismatches, `${set.name} at filter width ${filterWidthMeters}`).toBe(0);
          // No sand sea is possible here, and the ground bake is told so.
          expect(gated, `${set.name} at ${filterWidthMeters}: climate gate open`).toBe(0);
          expect(covered, `${set.name} at ${filterWidthMeters}: sand cover`).toBe(0);
        }
      }
    });
    console.log(`landform containment:\n  ${report.join("\n  ")}`);
  }, 300_000);

  it("agrees with applyTerrainLandforms in forced and natural sand seas at widths 0, 128, 512", async () => {
    const criteria = TERRAIN_HEIGHT_PARITY_CRITERIA;
    const forcedPages = forcedErgPages(FORCED_WORLD, 24);
    const naturalPages = naturalErgPages(NATURAL_WORLD, 8);
    expect(forcedPages.length, "forced erg pages found").toBeGreaterThanOrEqual(16);
    expect(naturalPages.length, "natural erg pages found 150-600 km out").toBeGreaterThanOrEqual(3);
    const sets = [
      buildProbeSet("forced erg", FORCED_WORLD, terrainLandformInput(FORCED_WORLD), forcedPages, 160),
      buildProbeSet(
        "natural erg", NATURAL_WORLD, terrainLandformInput(NATURAL_WORLD), naturalPages, 160),
    ];
    const report: string[] = [];
    await withEngine(async (engine) => {
      for (const set of sets) {
        for (const filterWidthMeters of FILTER_WIDTHS) {
          const gpu = await dispatch(engine, set, filterWidthMeters);
          let worst = 0;
          let worstIndex = 0;
          let worstNatural = 0;
          let moved = 0;
          for (let index = 0; index < set.count; index += 1) {
            const x = set.worldX[index]!;
            const z = set.worldZ[index]!;
            const natural = sampleNaturalTerrainHeight(set.world.seedHash, x, z, filterWidthMeters);
            const expected = applyTerrainLandforms(
              set.world,
              x,
              z,
              natural,
              filterWidthMeters,
              sampleNaturalTerrainIntermediates(set.world.seedHash, x, z, filterWidthMeters),
            );
            if (expected !== natural) moved += 1;
            worstNatural = Math.max(worstNatural, Math.abs(gpu[index * RESULT_FLOATS]! - natural));
            const delta = Math.abs(gpu[index * RESULT_FLOATS + 1]! - expected);
            if (delta > worst) {
              worst = delta;
              worstIndex = index;
            }
          }
          report.push(
            `${set.name}, fw ${filterWidthMeters}: max |Δh| = ${worst.toFixed(5)} m `
            + `at (${set.worldX[worstIndex]!.toFixed(1)}, ${set.worldZ[worstIndex]!.toFixed(1)}); `
            + `natural kernel alone ${worstNatural.toFixed(5)} m; `
            + `${moved} of ${set.count} points moved by the dunes`,
          );
          // Non-vacuous: most probes sit in the sand sea.
          expect(moved, `${set.name} at ${filterWidthMeters}: probes the dunes moved`)
            .toBeGreaterThan(set.count * 0.4);
          expect(worst, `${set.name} at filter width ${filterWidthMeters} over ${set.count} points`)
            .toBeLessThan(criteria.nearToleranceMeters);
        }
      }
    });
    // Printed so the achieved bound is a recorded measurement, not a pass/fail bit.
    console.log(`landform parity:\n  ${report.join("\n  ")}`);
  }, 600_000);

  it("gates and covers the ground as duneClimateFactors and sampleLandformCover do", async () => {
    // The ground bake's two entry points: the climate gate (no kernel) and
    // the sand cover (the dune evaluation the height stage makes). A forced
    // desert, natural ergs, and natural ground 150-600 km out at random, so
    // the gate is seen shut by the province and by the patch as well as open.
    const naturalCenter = landformCoreCenter(NATURAL_WORLD);
    const scattered: [number, number][] = [];
    for (let index = 1; scattered.length < 24; index += 1) {
      const angle = halton(index, 2) * 2 * Math.PI;
      const radius = 150_000 + 450_000 * halton(index, 3);
      scattered.push([
        snapToPage(naturalCenter.x + Math.cos(angle) * radius),
        snapToPage(naturalCenter.z + Math.sin(angle) * radius),
      ]);
    }
    const sets = [
      buildProbeSet(
        "forced desert", FORCED_WORLD, terrainLandformInput(FORCED_WORLD), forcedErgPages(FORCED_WORLD, 8), 64),
      buildProbeSet(
        "natural erg", NATURAL_WORLD, terrainLandformInput(NATURAL_WORLD), naturalErgPages(NATURAL_WORLD, 6), 64),
      buildProbeSet(
        "natural, scattered", NATURAL_WORLD, terrainLandformInput(NATURAL_WORLD), scattered, 32),
    ];
    const climate: DuneClimateFactors = { arid: 0, patch: 0 };
    const report: string[] = [];
    await withEngine(async (engine) => {
      for (const set of sets) {
        for (const filterWidthMeters of FILTER_WIDTHS) {
          const gpu = await dispatch(engine, set, filterWidthMeters);
          let worstErg = 0;
          let worstSand = 0;
          let open = 0;
          let shutWithCover = 0;
          let gateMisses = 0;
          let gateEdges = 0;
          let sanded = 0;
          for (let index = 0; index < set.count; index += 1) {
            const x = set.worldX[index]!;
            const z = set.worldZ[index]!;
            const at = index * RESULT_FLOATS;
            const gate = gpu[at + 2] !== 0;
            const cover = sampleLandformCover(set.world, x, z, filterWidthMeters);
            worstErg = Math.max(worstErg, Math.abs(gpu[at + 4]! - cover.ergWeight));
            worstSand = Math.max(worstSand, Math.abs(gpu[at + 5]! - cover.sandCover));
            if (cover.sandCover > 0) sanded += 1;
            if (gate) open += 1;
            // The gate never shuts on sand the GPU itself draws.
            if (!gate && (gpu[at + 4] !== 0 || gpu[at + 5] !== 0)) shutWithCover += 1;
            // The CPU's early outs: the core mask, then both climate factors.
            const mask = landformCoreMask(set.world, x, z);
            duneClimateFactors(set.world, x, z, climate);
            const cpuGate = mask > 0 && climate.arid > 0 && climate.patch > 0;
            // f32 against f64 may disagree only where a factor is at its edge.
            if (gate !== cpuGate) {
              if (Math.min(mask, climate.arid, climate.patch) > 1e-3) gateMisses += 1;
              else gateEdges += 1;
            }
          }
          report.push(
            `${set.name}, fw ${filterWidthMeters}: max |Δerg| = ${worstErg.toExponential(2)}, `
            + `max |Δsand| = ${worstSand.toExponential(2)}; gate open at ${open} of ${set.count}; `
            + `${sanded} sanded on the CPU; ${gateEdges} gate disagreements at a factor's edge`,
          );
          expect(shutWithCover, `${set.name} at ${filterWidthMeters}: cover where the gate is shut`).toBe(0);
          expect(gateMisses, `${set.name} at ${filterWidthMeters}: gate disagrees off a factor edge`).toBe(0);
          expect(gateEdges, `${set.name} at ${filterWidthMeters}: gate disagrees at an edge`)
            .toBeLessThanOrEqual(set.count * 0.01);
          expect(worstErg, `${set.name} at ${filterWidthMeters}: erg weight`).toBeLessThan(SAND_TOLERANCE);
          expect(worstSand, `${set.name} at ${filterWidthMeters}: sand cover`).toBeLessThan(SAND_TOLERANCE);
        }
      }
    });
    console.log(`landform ground entry points:\n  ${report.join("\n  ")}`);
  }, 600_000);

  it("writes the sand sea sampleTerrainHeight samples into an L0 page of the atlas", async () => {
    // The wiring, end to end: the generator builds the landform rows from its
    // world, pageHeightAt runs natural -> landforms -> earthworks, and the
    // texels collision reads are the CPU authority's to the physics bound.
    const candidates = forcedErgPages(FORCED_WORLD, 24);
    const [originX, originZ] = candidates.reduce((best, page) =>
      sampleLandformCover(FORCED_WORLD, page[0] + PAGE_METERS / 2, page[1] + PAGE_METERS / 2, 0)
        .ergWeight
      > sampleLandformCover(FORCED_WORLD, best[0] + PAGE_METERS / 2, best[1] + PAGE_METERS / 2, 0)
        .ergWeight
        ? page
        : best);
    const address = createWorldPageAddress(0, originX / PAGE_METERS, originZ / PAGE_METERS);
    const texel = terrainTexelSizeMeters(0);
    const heights = await withEngine(async (engine) => {
      const scene = new Scene(engine);
      try {
        const atlas = new TerrainPageAtlas(scene, resolveWebGpuQualityProfile("medium", "balanced"), {
          kind: "height",
          worldRevision: "landform-parity",
        });
        const generator = new TerrainPageGenerator(
          engine, atlas, FORCED_WORLD.seedHash, FORCED_WORLD.airport ?? null, { world: FORCED_WORLD });
        atlas.residency.beginFrame(1);
        const request = atlas.residency.request(invariantSlotKey(address), address)!;
        await generator.generate([request.slot]);
        await generator.settle();
        const origin = atlas.slotOrigin(request.slot.slotIndex);
        const read = await atlas.texture()!.readPixels(
          0, 0, undefined, true, false,
          origin.u, origin.v, TERRAIN_HEIGHT_SLOT_EDGE, TERRAIN_HEIGHT_SLOT_EDGE,
        ) as Float32Array;
        generator.dispose();
        atlas.dispose();
        return read;
      } finally {
        scene.dispose();
      }
    });
    let worst = 0;
    let moved = 0;
    let compared = 0;
    for (let row = 0; row < PAGE_METERS / texel; row += 9) {
      for (let column = 0; column < PAGE_METERS / texel; column += 9) {
        const x = originX + column * texel;
        const z = originZ + row * texel;
        const expected = sampleTerrainHeight(FORCED_WORLD, x, z);
        const stored = heights[(row + WORLD_PAGE_GUTTER) * TERRAIN_HEIGHT_SLOT_EDGE
          + column + WORLD_PAGE_GUTTER]!;
        worst = Math.max(worst, Math.abs(stored - expected));
        if (expected !== sampleNaturalTerrainHeight(FORCED_WORLD.seedHash, x, z, 0)) moved += 1;
        compared += 1;
      }
    }
    console.log(
      `L0 page (${originX}, ${originZ}) vs sampleTerrainHeight over ${compared} texels: `
      + `max |Δh| = ${(worst * 1_000).toFixed(3)} mm; ${moved} moved by the dunes`,
    );
    expect(moved, "texels the dunes moved").toBeGreaterThan(compared * 0.4);
    expect(worst).toBeLessThan(TERRAIN_HEIGHT_PARITY_CRITERIA.physicsToleranceMeters);
  }, 300_000);
});
