import { describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import {
  TerrainPageAtlas,
  TerrainPageGenerator,
  invariantSlotKey,
} from "../../src/render/webgpu/terrain/TerrainPageAtlas";
import type { TerrainPageErosionExecutor } from "../../src/render/webgpu/terrain/TerrainPageErosionClient";
import type { TerrainErodedPage } from "../../src/render/webgpu/terrain/TerrainPageErosion";
import {
  EROSION_HALO_TEXELS,
  EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS,
} from "../../src/render/webgpu/terrain/TerrainErosionCompute";
import {
  EVOLUTION_DOMAIN_SAMPLE_COUNT,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  type TerrainMacroEvolutionExport,
} from "../../src/render/webgpu/terrain/TerrainEvolutionContract";
import { TERRAIN_HEIGHT_SLOT_EDGE } from "../../src/render/webgpu/terrain/TerrainSpineContract";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_GUTTER,
  WORLD_PAGE_HEIGHT_CORE,
} from "../../src/render/webgpu/world/pageGeometry";
import { createWorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import {
  detailWorkerCommandTransferables,
  type DetailWorkerCommand,
} from "../../src/workers/detailProtocol";
import { TerrainAuthority } from "../../src/workers/terrainAuthority";
import { createWorld } from "../../src/world";

/**
 * Assertion 91 — "sim-worker grid bytes equal atlas page bytes through the
 * transfer" (Phase 5 §12.1's `gpu/collision-readback` home, written at Phase 6
 * Gate W, W-3).
 *
 * `tests/gpu/terrain-height-generate.test.ts`'s "5D uploads worker-eroded
 * bytes and publishes L0 collision before residency" proves the ORDER of the
 * publication DAG and spot-checks two corner texels. It never reads the atlas
 * back, so nothing proved that the surface the aircraft touches is the surface
 * the GPU actually holds. That is this file: one page walked end to end
 * through the real chain —
 *
 *   worker bytes -> `updateTextureData` -> atlas r32float slot
 *     -> the production core readback (`publishCompletedSlot`)
 *     -> `postMessage` transfer (the real transferable list)
 *     -> `TerrainAuthority.publish` -> `sampleHeight`
 *
 * — with IEEE-754 BIT equality at every hop, compared through `Uint32Array`
 * views so a `+0`/`-0` divergence or a flushed mantissa bit cannot hide behind
 * float equality.
 *
 * Why a synthetic page rather than a real eroded one: the transfer is what is
 * under test, and eroded output is a smooth field that never contains `-0`,
 * never exercises the low mantissa bits, and would spend seconds of adapter
 * time proving nothing extra. The fixture below is a full-mantissa pattern
 * with signed zeros and negatives deliberately planted in both the core and
 * the gutter — the byte path's adversarial input, not its typical one.
 */

const PAGE = createWorldPageAddress(0, 3, -2);
const SLOT_TEXELS = TERRAIN_HEIGHT_SLOT_EDGE * TERRAIN_HEIGHT_SLOT_EDGE;
const CORE_TEXELS = WORLD_PAGE_HEIGHT_CORE * WORLD_PAGE_HEIGHT_CORE;
/** L0 lattice spacing: the collision core's texel pitch in metres. */
const LATTICE_SPACING = WORLD_PAGE_BASE_EXTENT_METERS / WORLD_PAGE_HEIGHT_CORE;

const patternBits = new Uint32Array(1);
const patternFloat = new Float32Array(patternBits.buffer);

/**
 * A deterministic full-mantissa f32. The exponent is pinned to a normal band
 * so no value is subnormal (an adapter may flush those) or infinite, while all
 * 23 mantissa bits and the sign bit vary — which a smooth height ramp, the
 * shape every other page fixture uses, never does.
 */
function fixtureHeight(index: number): number {
  const state = Math.imul(index + 1, 2_654_435_761) >>> 0;
  patternBits[0] = (state & 0x807f_ffff) | 0x4200_0000;
  return patternFloat[0]!;
}

function negativeZero(): number {
  patternBits[0] = 0x8000_0000;
  return patternFloat[0]!;
}

function bitsOf(values: Float32Array): Uint32Array {
  return new Uint32Array(values.buffer, values.byteOffset, values.length);
}

/** First differing index, or -1. Bit views, so `-0 !== 0` and NaN payloads count. */
function firstBitMismatch(
  left: Uint32Array,
  right: Uint32Array,
  count: number,
  leftIndex: (index: number) => number,
  rightIndex: (index: number) => number,
): number {
  for (let index = 0; index < count; index += 1) {
    if (left[leftIndex(index)] !== right[rightIndex(index)]) return index;
  }
  return -1;
}

function buildFixtureStoredHeight(): Float32Array {
  const storedHeight = new Float32Array(SLOT_TEXELS);
  for (let index = 0; index < SLOT_TEXELS; index += 1) {
    storedHeight[index] = fixtureHeight(index);
  }
  // Planted adversaries, addressed in stored (core + gutter) space: signed
  // zeros on both sides of the gutter boundary, and the smallest normal f32
  // next to the largest value the atlas will ever legitimately carry.
  const stored = (row: number, column: number): number =>
    row * TERRAIN_HEIGHT_SLOT_EDGE + column;
  storedHeight[stored(0, 0)] = negativeZero();
  storedHeight[stored(WORLD_PAGE_GUTTER, WORLD_PAGE_GUTTER)] = 0;
  storedHeight[stored(WORLD_PAGE_GUTTER + 1, WORLD_PAGE_GUTTER + 1)] = negativeZero();
  storedHeight[stored(WORLD_PAGE_GUTTER + 2, WORLD_PAGE_GUTTER + 2)] = -8_848.5;
  storedHeight[stored(WORLD_PAGE_GUTTER + 3, WORLD_PAGE_GUTTER + 3)] = 1.1754944e-38;
  storedHeight[stored(TERRAIN_HEIGHT_SLOT_EDGE - 1, TERRAIN_HEIGHT_SLOT_EDGE - 1)] = 9_999.9990234375;
  return storedHeight;
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

describe("terrain collision readback (5-2, assertion 91)", () => {
  it("assertion 91: sim-worker grid bytes equal atlas page bytes through the transfer", async () => {
    const world = createWorld("collision-readback-gpu", {
      airport: false,
      worldEvolution: "eroded",
    });
    const macro: TerrainMacroEvolutionExport = {
      contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
      provenance: { worldSeed: world.seed, deviceFingerprint: "gpu-fixture" },
      seaLevelMeters: world.seaLevel,
      heightMeters: new Float32Array(EVOLUTION_DOMAIN_SAMPLE_COUNT),
      flowAccumulationAreaM2: new Float32Array(EVOLUTION_DOMAIN_SAMPLE_COUNT),
      lakeMask: new Uint8Array(EVOLUTION_DOMAIN_SAMPLE_COUNT),
      lakes: [],
      drainageBaseLevels: [],
      channelSeedTexelIndices: new Uint32Array(0),
    };
    const storedHeight = buildFixtureStoredHeight();
    let minHeightMeters = Number.POSITIVE_INFINITY;
    let maxHeightMeters = Number.NEGATIVE_INFINITY;
    for (const value of storedHeight) {
      minHeightMeters = Math.min(minHeightMeters, value);
      maxHeightMeters = Math.max(maxHeightMeters, value);
    }
    const erodedPage: TerrainErodedPage = {
      address: PAGE,
      coreSize: WORLD_PAGE_HEIGHT_CORE,
      haloTexels: EROSION_HALO_TEXELS,
      scratchEdge: EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS,
      storedEdge: TERRAIN_HEIGHT_SLOT_EDGE,
      storedHeight,
      stats: { minHeightMeters, maxHeightMeters, maxDeviationFromParent: 0.125 },
      protectedSampleCount: 0,
      hydrology: null,
    };
    const executor: TerrainPageErosionExecutor = {
      setMacroEvolution: () => undefined,
      generate: async (requested) => {
        expect(requested).toEqual(PAGE);
        return erodedPage;
      },
      dispose: () => undefined,
    };

    const observed = await withScene(async (engine, scene) => {
      const profile = resolveWebGpuQualityProfile("medium", "balanced");
      const atlas = new TerrainPageAtlas(scene, profile, {
        kind: "height",
        worldRevision: "collision-readback",
      });
      const generator = new TerrainPageGenerator(
        engine,
        atlas,
        world.seedHash,
        world.airport,
        { world, erosionExecutor: executor },
      );
      atlas.residency.beginFrame(1);
      const slot = atlas.residency.request(invariantSlotKey(PAGE), PAGE)!.slot;
      let collision: Float32Array | null = null;
      let stateAtPublication = "";
      generator.setCollisionPagePublisher((page) => {
        stateAtPublication = slot.lifecycle.state;
        collision = page.heights;
      });
      generator.setMacroEvolution(macro);
      await generator.generate([slot]);
      // The collision publication is issued from inside the DAG, so it must
      // already exist by the time `settle()` returns; reading the slot after
      // that is the only readback this test issues itself.
      await generator.settle();
      const origin = atlas.slotOrigin(slot.slotIndex);
      // Let Babylon allocate: a 264-texel r32float row is 1,056 bytes, which
      // is NOT the 256-byte-aligned `bytesPerRow` a copy needs, so the
      // readback is padded internally and a caller-sized buffer overruns it.
      // (The production core readback is 256 texels = 1,024 bytes and aligns,
      // which is why it can hand in its own array.)
      const pixels = await atlas.texture()!.readPixels(
        0, 0, undefined, true, false,
        origin.u, origin.v, TERRAIN_HEIGHT_SLOT_EDGE, TERRAIN_HEIGHT_SLOT_EDGE,
      );
      const result: {
        slotPixels: Float32Array;
        collision: Float32Array | null;
        stateAtPublication: string;
        lifecycle: string;
      } = {
        slotPixels: pixels as Float32Array,
        collision,
        stateAtPublication,
        lifecycle: slot.lifecycle.state,
      };
      generator.dispose();
      atlas.dispose();
      return result;
    });

    expect(observed.lifecycle).toBe("resident");
    // The convergence rule: collision is published while the slot is still
    // `generating`, i.e. from bytes that are already final.
    expect(observed.stateAtPublication).toBe("generating");
    expect(observed.collision).not.toBeNull();
    const collision = observed.collision!;
    expect(collision).toHaveLength(CORE_TEXELS);
    expect(observed.slotPixels).toHaveLength(SLOT_TEXELS);

    // (1) Upload half: every one of the 264² texels the worker produced is the
    // texel the atlas holds, gutter included.
    const uploadedBits = bitsOf(observed.slotPixels);
    const workerBits = bitsOf(storedHeight);
    const uploadMismatch = firstBitMismatch(
      workerBits, uploadedBits, SLOT_TEXELS, (index) => index, (index) => index,
    );
    expect(
      uploadMismatch,
      uploadMismatch < 0 ? "" : `atlas texel ${uploadMismatch} `
        + `holds 0x${uploadedBits[uploadMismatch]!.toString(16)}, `
        + `worker byte was 0x${workerBits[uploadMismatch]!.toString(16)}`,
    ).toBe(-1);

    // (2) Publication half: the core the sim worker is handed is the atlas's
    // own core, read back by the production path at the gutter-addressed
    // origin (GUTTER * EDGE + GUTTER) rather than at texel zero.
    const collisionBits = bitsOf(collision);
    const coreMismatch = firstBitMismatch(
      collisionBits,
      uploadedBits,
      CORE_TEXELS,
      (index) => index,
      (index) => (WORLD_PAGE_GUTTER + Math.floor(index / WORLD_PAGE_HEIGHT_CORE))
        * TERRAIN_HEIGHT_SLOT_EDGE
        + WORLD_PAGE_GUTTER + (index % WORLD_PAGE_HEIGHT_CORE),
    );
    expect(
      coreMismatch,
      coreMismatch < 0 ? "" : `collision core texel ${coreMismatch} diverged from the atlas slot`,
    ).toBe(-1);
    // A gutter-offset regression would still pass a float comparison of a
    // smooth page; pin the two corners the addressing arithmetic decides.
    expect(collisionBits[0]).toBe(
      workerBits[WORLD_PAGE_GUTTER * TERRAIN_HEIGHT_SLOT_EDGE + WORLD_PAGE_GUTTER],
    );
    expect(collisionBits[CORE_TEXELS - 1]).toBe(
      workerBits[
        (WORLD_PAGE_GUTTER + WORLD_PAGE_HEIGHT_CORE - 1) * TERRAIN_HEIGHT_SLOT_EDGE
        + WORLD_PAGE_GUTTER + WORLD_PAGE_HEIGHT_CORE - 1
      ],
    );
    // Signed zero survived the whole GPU round trip, which is the reason this
    // comparison is made on `Uint32Array` views: `0 === -0` in float land.
    expect(Object.is(
      observed.slotPixels[
        (WORLD_PAGE_GUTTER + 1) * TERRAIN_HEIGHT_SLOT_EDGE + WORLD_PAGE_GUTTER + 1
      ],
      -0,
    )).toBe(true);
    expect(Object.is(collision[WORLD_PAGE_HEIGHT_CORE + 1], -0)).toBe(true);

    // (3) The worker boundary itself: the production transferable list, a real
    // structured-clone transfer, and the sim worker's own publish entry point.
    const preTransfer = Uint32Array.from(collisionBits);
    const command: DetailWorkerCommand = {
      type: "terrainPage",
      page: { level: 0, tileX: PAGE.x, tileZ: PAGE.z, heights: collision },
    };
    const transferables = detailWorkerCommandTransferables(command);
    expect(transferables).toHaveLength(1);
    expect(transferables[0]).toBe(collision.buffer);
    const delivered = structuredClone(command, { transfer: transferables });
    expect(collision.buffer.byteLength, "ownership did not transfer").toBe(0);
    const authority = new TerrainAuthority();
    expect(authority.publish(delivered.page)).toBe(true);

    const deliveredBits = bitsOf(delivered.page.heights);
    const transferMismatch = firstBitMismatch(
      preTransfer, deliveredBits, CORE_TEXELS, (index) => index, (index) => index,
    );
    expect(
      transferMismatch,
      transferMismatch < 0 ? "" : `transfer altered core texel ${transferMismatch}`,
    ).toBe(-1);

    // (4) What the aircraft actually touches. Catmull-Rom at an exact lattice
    // point returns the stored texel unchanged (`p1 + 0.5 * 0 * …`), so the
    // authority's answer is bit-comparable to the atlas byte at every interior
    // lattice point — the ladder's own query path, not a private accessor.
    // Interior only: the outer two rings need the neighbouring pages, which
    // this test deliberately never publishes.
    const probe = new Float32Array(1);
    const probeBits = new Uint32Array(probe.buffer);
    let probed = 0;
    let firstBadProbe = "";
    for (let row = 1; row <= WORLD_PAGE_HEIGHT_CORE - 3; row += 3) {
      for (let column = 1; column <= WORLD_PAGE_HEIGHT_CORE - 3; column += 3) {
        const x = (PAGE.x * WORLD_PAGE_HEIGHT_CORE + column) * LATTICE_SPACING;
        const z = (PAGE.z * WORLD_PAGE_HEIGHT_CORE + row) * LATTICE_SPACING;
        const sampled = authority.sampleHeight(x, z);
        probe[0] = sampled ?? Number.NaN;
        probed += 1;
        // `-0 + 0` is `+0`: the spline's constant term normalises a stored
        // negative zero on the way out. Hop (2) already proved the byte itself
        // survived, so the authority is compared on the same normalisation.
        const expectedBits = deliveredBits[row * WORLD_PAGE_HEIGHT_CORE + column]!;
        const normalized = expectedBits === 0x8000_0000 ? 0 : expectedBits;
        if (probeBits[0] !== normalized && firstBadProbe === "") {
          firstBadProbe = `lattice (${column}, ${row}) sampled ${sampled}, `
            + `atlas byte 0x${expectedBits.toString(16)}`;
        }
      }
    }
    expect(firstBadProbe, firstBadProbe).toBe("");
    expect(probed).toBeGreaterThan(7_000);
    expect(authority.countersSnapshot()).toEqual({
      readbackServed: probed,
      macroServed: 0,
      analyticServed: 0,
    });
  }, 180_000);
});
