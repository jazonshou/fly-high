// Side-effect imports: register the compute pipeline and raw-texture methods.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import {
  EVOLUTION_DOMAIN_SAMPLE_COUNT,
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
  type TerrainMacroEvolutionExport,
} from "../../src/render/webgpu/terrain/TerrainEvolutionContract";
import {
  TERRAIN_CHANNEL_TEXTURE_COUNT,
  TerrainPageAtlas,
  TerrainPageGenerator,
  invariantSlotKey,
  type TerrainAtlasSlot,
} from "../../src/render/webgpu/terrain/TerrainPageAtlas";
import {
  terrainErosionParentSeedBlock,
  type TerrainErodedPage,
} from "../../src/render/webgpu/terrain/TerrainPageErosion";
import { TerrainPageErosionClient } from "../../src/render/webgpu/terrain/TerrainPageErosionClient";
import { TerrainPageErosionGpu } from "../../src/render/webgpu/terrain/TerrainPageErosionGpu";
import { TERRAIN_HEIGHT_SLOT_EDGE } from "../../src/render/webgpu/terrain/TerrainSpineContract";
import { WORLD_PAGE_GUTTER, WORLD_PAGE_HEIGHT_CORE } from "../../src/render/webgpu/world/pageGeometry";
import type { WorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import { createWorld, type WorldDefinition } from "../../src/world";

/**
 * Shared harness for the two `W-1d` GPU suites.
 *
 * The COST suite lives in its own file on purpose: measuring needs a device
 * created with `timestamp-query` in its `requiredFeatures`, and a page that has
 * already built and torn down five WebGPU devices does not reliably get one
 * back — the request is dropped silently and every compute pass then fails
 * validation with "Timestamp queries used without the timestamp-query feature
 * enabled", which reads downstream as NaN scratch rather than as a device
 * problem. One timed device per page, first thing.
 */

const SEED = "w1d-page-erosion-gpu";
const SLOTS = 16;

export async function withScene<T>(
  run: (engine: WebGPUEngine, scene: Scene) => Promise<T>,
  timed = false,
): Promise<T> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, {
    antialias: false,
    enableAllFeatures: false,
    setMaximumLimits: false,
    // The counter has to be asked for at DEVICE creation; Babylon silently
    // drops an unsupported entry rather than letting requestDevice reject, so
    // enabledExtensions is checked below rather than trusted here.
    ...(timed
      ? { deviceDescriptor: { requiredFeatures: ["timestamp-query"] as GPUFeatureName[] } }
      : {}),
  });
  let scene: Scene | null = null;
  try {
    await engine.initAsync();
    // `engine.enabledExtensions` records what Babylon ASKED the device for,
    // not what it got: the descriptor entry is dropped silently when the
    // request cannot be met, and every compute pass then fails validation with
    // "Timestamp queries used without the timestamp-query feature enabled" —
    // which surfaces downstream as NaN scratch, not as a device problem. Ask
    // the device itself, and only then turn the counters on.
    if (timed) engine.enableGPUTimingMeasurements = gpuTimingAvailable(engine);
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

/** Whether the DEVICE (not the request) actually granted `timestamp-query`. */
export function gpuTimingAvailable(engine: WebGPUEngine): boolean {
  const device = (engine as unknown as { _device?: GPUDevice })._device;
  return device?.features?.has("timestamp-query") ?? false;
}

export const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

/**
 * A deterministic macro export. Synthetic rather than a real 7.5 s macro run:
 * both the GPU producer and the CPU oracle read the SAME export, so what the
 * parity comparison needs is a non-degenerate field, not a geologically
 * evolved one. The height is a smooth two-octave surface that crosses sea
 * level, and the flow field spans four decades of contributing area so the
 * stream-power drive is genuinely spatially varying.
 */
export function macroFixture(seed: string): TerrainMacroEvolutionExport {
  const heightMeters = new Float32Array(EVOLUTION_DOMAIN_SAMPLE_COUNT);
  const flowAccumulationAreaM2 = new Float32Array(EVOLUTION_DOMAIN_SAMPLE_COUNT);
  const edge = EVOLUTION_DOMAIN_TEXELS;
  for (let z = 0; z < edge; z += 1) {
    const worldZ = TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ + (z + 0.5) * EVOLUTION_TEXEL_METERS;
    for (let x = 0; x < edge; x += 1) {
      const worldX = TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX + (x + 0.5) * EVOLUTION_TEXEL_METERS;
      const index = z * edge + x;
      const ridge = Math.sin(worldX * 1.7e-5) * Math.cos(worldZ * 1.3e-5);
      const detail = Math.sin(worldX * 9.1e-5 + 1.7) * Math.sin(worldZ * 7.3e-5 - 0.4);
      heightMeters[index] = Math.fround(420 * ridge + 130 * detail + 60);
      flowAccumulationAreaM2[index] = Math.fround(
        EVOLUTION_TEXEL_METERS * EVOLUTION_TEXEL_METERS
        * (1 + 900 * Math.abs(Math.sin(worldX * 4.3e-5) * Math.cos(worldZ * 3.1e-5))),
      );
    }
  }
  return {
    contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
    provenance: { worldSeed: seed, deviceFingerprint: "gpu-page-fixture" },
    seaLevelMeters: 0,
    heightMeters,
    flowAccumulationAreaM2,
    lakeMask: new Uint8Array(EVOLUTION_DOMAIN_SAMPLE_COUNT),
    lakes: [],
    drainageBaseLevels: [],
    channelSeedTexelIndices: new Uint32Array(0),
  };
}

export interface Harness {
  readonly world: Readonly<WorldDefinition>;
  readonly macro: TerrainMacroEvolutionExport;
  readonly heightAtlas: TerrainPageAtlas;
  readonly channelAtlas: TerrainPageAtlas;
  readonly client: TerrainPageErosionClient;
  readonly producer: TerrainPageErosionGpu;
  dispose(): void;
}

/**
 * The erosion client is forced onto its inline no-Worker branch: the staged
 * stage functions are the SAME pure code in both branches, and a module Worker
 * inside the browser test runner is a second failure surface with nothing to
 * prove here.
 */
export function buildHarness(engine: WebGPUEngine, scene: Scene, parentSeededMaxLevel?: number): Harness {
  const world = createWorld(SEED, { airport: false, worldEvolution: "eroded" });
  const macro = macroFixture(world.seed);
  const base = resolveWebGpuQualityProfile("medium", "balanced");
  const profile = { ...base, heightAtlasSlots: SLOTS, channelAtlasSlots: SLOTS };
  const heightAtlas = new TerrainPageAtlas(scene, profile, {
    kind: "height",
    worldRevision: "page-erosion-gpu",
  });
  const channelAtlas = new TerrainPageAtlas(scene, profile, {
    kind: "channel",
    worldRevision: "page-erosion-gpu",
    textureCount: TERRAIN_CHANNEL_TEXTURE_COUNT,
    requiresHydrology: true,
  });
  const client = new TerrainPageErosionClient(world, {
    workerFactory: () => {
      throw new Error("the staged inline branch is the deliberate test path");
    },
  });
  client.setMacroEvolution(macro);
  const producer = new TerrainPageErosionGpu(engine, {
    world,
    seedHash: world.seedHash,
    airport: world.airport,
    heightAtlas,
    channelAtlas,
    executor: client,
    ...(parentSeededMaxLevel === undefined ? {} : { parentSeededMaxLevel }),
  });
  return {
    world,
    macro,
    heightAtlas,
    channelAtlas,
    client,
    producer,
    dispose: () => {
      producer.dispose();
      client.dispose();
      channelAtlas.dispose();
      heightAtlas.dispose();
    },
  };
}

/** Admit a height slot and hold it; the caller releases it when finished. */
export function admit(harness: Harness, address: WorldPageAddress): TerrainAtlasSlot {
  const key = invariantSlotKey(address);
  const request = harness.heightAtlas.residency.request(key, address);
  if (!request?.token) throw new Error("the fixture atlas refused a slot");
  return request.slot;
}

/**
 * Drive one page's DAG to completion, one frame per pump, and report how many
 * frames it took. `dispatchesPerPump` stands in for the admitted count the
 * clipmap would hand over.
 */
export async function runPage(
  harness: Harness,
  address: WorldPageAddress,
  dispatchesPerPump: number,
): Promise<{ page: TerrainErodedPage; frames: number }> {
  const slot = admit(harness, address);
  const token = slot.token;
  if (!token) throw new Error("admitted slot carries no token");
  let settled: TerrainErodedPage | null = null;
  let failure: unknown = null;
  const pending = harness.producer.beginPage(slot, token)
    .then((page) => { settled = page; })
    .catch((error: unknown) => { failure = error; });
  let frames = 0;
  let stalled = 0;
  let lastProgress = "";
  // Fail fast rather than burning the whole timeout: a WGSL or validation
  // error leaves the stage machine frozen, and 4,000 silent frames is four
  // minutes of a test that already knows the answer.
  while (settled === null && failure === null && frames < 1_500) {
    frames += 1;
    await harness.producer.pump(dispatchesPerPump);
    harness.producer.consumeMeasuredDispatchCostMs();
    const progress = `${harness.producer.activeStage}`;
    stalled = progress === lastProgress ? stalled + 1 : 0;
    lastProgress = progress;
    if (stalled > 240) {
      throw new Error(
        `terrain erosion DAG stalled in stage "${progress}" after ${frames} frames`,
      );
    }
    await nextFrame();
  }
  await pending;
  harness.heightAtlas.residency.release(slot.key);
  if (failure) throw failure;
  if (!settled) throw new Error(`page ${address.level}/${address.x}/${address.z} never converged`);
  return { page: settled, frames };
}

export function sameFloat32Bits(first: Float32Array, second: Float32Array): boolean {
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index += 1) {
    // Object.is separates -0 from 0 and treats NaN as equal to NaN, which is
    // exactly the IEEE-bit contract erosionOverlapIsBitExact enforces.
    if (!Object.is(first[index], second[index])) return false;
  }
  return true;
}

const storedIndex = (row: number, column: number): number =>
  (row + WORLD_PAGE_GUTTER) * TERRAIN_HEIGHT_SLOT_EDGE + (column + WORLD_PAGE_GUTTER);

/**
 * Assertion 90's GPU form on stored pages: two pages adjacent on `axis` must
 * agree bit-for-bit everywhere their stored core+gutter rectangles cover the
 * same world texels — the four-texel band on each side of the shared edge.
 */
export function overlapIsBitExact(
  first: { readonly storedHeight: Float32Array },
  second: { readonly storedHeight: Float32Array },
  axis: "horizontal" | "vertical",
): { exact: boolean; compared: number; worstAbsolute: number } {
  const core = WORLD_PAGE_HEIGHT_CORE;
  const gutter = WORLD_PAGE_GUTTER;
  let exact = true;
  let compared = 0;
  let worstAbsolute = 0;
  for (let cross = -gutter; cross < core + gutter; cross += 1) {
    for (let offset = 0; offset < gutter; offset += 1) {
      const pairs: readonly (readonly [number, number])[] = axis === "horizontal"
        ? [
          [storedIndex(cross, core + offset), storedIndex(cross, offset)],
          [storedIndex(cross, core - gutter + offset), storedIndex(cross, -gutter + offset)],
        ]
        : [
          [storedIndex(core + offset, cross), storedIndex(offset, cross)],
          [storedIndex(core - gutter + offset, cross), storedIndex(-gutter + offset, cross)],
        ];
      for (const [firstIndex, secondIndex] of pairs) {
        const a = first.storedHeight[firstIndex]!;
        const b = second.storedHeight[secondIndex]!;
        compared += 1;
        worstAbsolute = Math.max(worstAbsolute, Math.abs(a - b));
        if (!Object.is(a, b)) exact = false;
      }
    }
  }
  return { exact, compared, worstAbsolute };
}

/**
 * A real `TerrainPageGenerator` in eroded mode with the GPU DAG enabled — the
 * production wiring, not the producer in isolation. It owns the erosion client
 * it is given (dispose() disposes it), so it gets its own.
 */
export function buildGpuGenerator(
  harness: Harness,
  engine: WebGPUEngine,
): TerrainPageGenerator {
  const client = new TerrainPageErosionClient(harness.world, {
    workerFactory: () => {
      throw new Error("the staged inline branch is the deliberate test path");
    },
  });
  const generator = new TerrainPageGenerator(
    engine,
    harness.heightAtlas,
    harness.world.seedHash,
    harness.world.airport,
    {
      world: harness.world,
      channelAtlas: harness.channelAtlas,
      erosionExecutor: client,
    },
  );
  generator.setMacroEvolution(harness.macro);
  return generator;
}

/**
 * Publish the child's 2x2 level-1 seed block through the real upload path —
 * height texels into the height atlas and the four aux fields into the channel
 * atlas — so the GPU seed pass reads exactly what a resident parent holds.
 * Returns how many parents were published.
 */
export async function publishParentBlock(
  harness: Harness,
  engine: WebGPUEngine,
  child: WorldPageAddress,
): Promise<number> {
  // Its own erosion client: TerrainPageGenerator.dispose() owns and disposes
  // whatever executor it was handed, and the harness still needs its own.
  const client = new TerrainPageErosionClient(harness.world, {
    workerFactory: () => {
      throw new Error("the staged inline branch is the deliberate test path");
    },
  });
  const generator = new TerrainPageGenerator(
    engine,
    harness.heightAtlas,
    harness.world.seedHash,
    harness.world.airport,
    {
      world: harness.world,
      channelAtlas: harness.channelAtlas,
      erosionExecutor: client,
      // The parents come from the CPU reference here: the subject under test
      // is the CHILD's seed pass, and a CPU parent lands the same stored bytes
      // through the same upload path with one fewer moving part.
      erosionGpu: false,
    },
  );
  generator.setMacroEvolution(harness.macro);
  let published = 0;
  for (const parent of terrainErosionParentSeedBlock(child)) {
    const key = invariantSlotKey(parent);
    const heightRequest = harness.heightAtlas.residency.request(key, parent);
    const channelRequest = harness.channelAtlas.residency.request(key, parent);
    if (!heightRequest?.token || !channelRequest?.token) continue;
    await generator.generate([heightRequest.slot]);
    await generator.settle();
    for (let wait = 0; wait < 8 && heightRequest.slot.lifecycle.state !== "resident"; wait += 1) {
      await nextFrame();
    }
    if (
      harness.heightAtlas.residency.slotIndexOf(key) >= 0
      && harness.channelAtlas.residency.get(key)?.hydrologyReady === true
    ) published += 1;
  }
  generator.dispose();
  return published;
}
