import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { describe, expect, it } from "vitest";
import type { PassCostReading, PassCostTape } from "../../src/render/webgpu/core/DeferredPassTiming";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import { GlobalHeightPyramid } from "../../src/render/webgpu/terrain/GlobalHeightPyramid";
import { PageOcclusionBake, PageSplatBake } from "../../src/render/webgpu/terrain/PageOcclusionBake";
import {
  BOUNDS_BUFFER_RING,
  consumeGpuDispatchCostMs,
  invariantSlotKey,
  TERRAIN_CHANNEL_TEXTURE_COUNT,
  type TerrainAtlasSlot,
  TerrainPageAtlas,
  TerrainPageGenerator,
} from "../../src/render/webgpu/terrain/TerrainPageAtlas";
import { createWorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import { hashSeed } from "../../src/world/seed";
import {
  adapterAdvertisesTimestampQuery,
  gpuTimingAvailable,
  NO_TIMESTAMP_QUERY_REASON,
  nextFrame,
  withScene,
} from "./terrainPageErosionGpuHarness";

/**
 * The per-page meters on the device, with batch sizes that vary, read in the
 * clipmap's order (read the meter, then dispatch) while every frame is
 * GPU-bound, which is when a reading lands two or more frames late.
 *
 * For each meter the run keeps three accounts of the same passes: what each
 * batch really took (every delivered pass, with the page count it was
 * dispatched with), what the tape priced, and what the old path
 * (`consumeGpuDispatchCostMs` with the batch dispatched last) priced. The tape
 * must account for every delivered batch at its own page count. The old path
 * must be caught pairing a reading with the wrong batch or losing one, or the
 * run did not exercise the defect and proves nothing.
 */

const SEED_HASH = hashSeed("pass-cost-consumers");
const BATCHES = [1, 4, 2, 8, 3, 6, 1, 5, 2, 7] as const;
const MAX_BATCH = Math.max(...BATCHES);

interface MeterRun {
  readonly name: string;
  readonly batchesDelivered: number;
  readonly deliveredPages: number;
  readonly deliveredMs: number;
  readonly tapePages: number;
  readonly tapeMs: number;
  readonly oldSamples: number;
  readonly oldMispaired: number;
  readonly oldLost: number;
  readonly oldWorstRatio: number;
}

function filler(engine: WebGPUEngine): { dispatch: () => void; dispose: () => void } {
  const sink = new StorageBuffer(engine, 4096 * 64 * 4);
  const shader = new ComputeShader("gpu-bound-filler", engine, {
    computeSource: `
@group(0) @binding(0) var<storage, read_write> sink: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  var x = f32(id.x) * 0.000001;
  for (var i = 0u; i < 4096u; i = i + 1u) { x = fract(x * 1.0001 + 0.37); }
  sink[id.x] = x;
}`,
  }, { bindingsMapping: { sink: { group: 0, binding: 0 } } });
  shader.setStorageBuffer("sink", sink);
  return {
    // Two passes of several milliseconds each: the frame outlasts its interval.
    dispatch: () => { shader.dispatch(4096, 1, 1); shader.dispatch(4096, 1, 1); },
    dispose: () => sink.dispose(),
  };
}

describe("per-page meters priced by each batch's own page count, on the device", () => {
  it("the tape accounts for every batch at its own count; the old path is caught mispairing", async (context) => {
    if (!(await adapterAdvertisesTimestampQuery())) {
      context.skip(`${NO_TIMESTAMP_QUERY_REASON}; the per-page meters' pairing stays unverified on this host`);
    }
    const delivered = new Map<unknown, number[]>();
    const runs = await withScene(async (engine, scene) => {
      if (!gpuTimingAvailable(engine)) return null;
      const base = resolveWebGpuQualityProfile("medium", "balanced");
      const profile = { ...base, heightAtlasSlots: 16, channelAtlasSlots: 16 };
      const heightAtlas = new TerrainPageAtlas(scene, profile, { kind: "height", worldRevision: "pass-cost" });
      const channelAtlas = new TerrainPageAtlas(scene, profile, {
        kind: "channel",
        worldRevision: "pass-cost",
        textureCount: TERRAIN_CHANNEL_TEXTURE_COUNT,
      });
      const generator = new TerrainPageGenerator(engine, heightAtlas, SEED_HASH, null);
      const pyramid = new GlobalHeightPyramid(scene, engine, SEED_HASH);
      const occlusion = new PageOcclusionBake(engine, heightAtlas, channelAtlas, pyramid);
      const splat = new PageSplatBake(engine, heightAtlas, channelAtlas, SEED_HASH, SEED_HASH, 0, 45, null);
      const load = filler(engine);
      try {
        await pyramid.recenter(0, 0);
        const heightSlots: TerrainAtlasSlot[] = [];
        const channelSlots: TerrainAtlasSlot[] = [];
        for (let index = 0; index < MAX_BATCH; index += 1) {
          const address = createWorldPageAddress(3, index, 0);
          const key = invariantSlotKey(address);
          heightSlots.push(heightAtlas.residency.request(key, address)!.slot);
          channelSlots.push(channelAtlas.residency.request(key, address)!.slot);
        }
        // Warm every pipeline and make every height page the bakes read. A
        // generated page is sampleable only once its readback publishes it, so
        // a bake that finds none resident dispatches nothing: retry until both
        // bakes have run over the whole set.
        await generator.generate(heightSlots);
        let warmed = false;
        for (let frame = 0; frame < 240 && !warmed; frame += 1) {
          await nextFrame();
          warmed = (await occlusion.bake(channelSlots)).length === channelSlots.length
            && (await splat.bake(channelSlots, 171)).length === channelSlots.length;
        }
        if (!warmed) throw new Error("the bakes never found their height pages resident");
        for (let frame = 0; frame < 12; frame += 1) await nextFrame();

        engine.stopRenderLoop();
        engine.runRenderLoop(() => load.dispatch());

        const meter = async (
          name: string,
          consumer: { consumeMeasuredDispatchCostMs(): number | null },
          run: (count: number) => Promise<unknown>,
          canDispatch: () => boolean = () => true,
        ): Promise<MeterRun> => {
          const internals = consumer as unknown as {
            costTape: PassCostTape | null;
            shader: { gpuTimeInFrame?: { counter: { count: number; current: number } } } | null;
          };
          const sink = internals.shader?.gpuTimeInFrame;
          const tape = internals.costTape;
          if (!sink || !tape) throw new Error(`${name} has no timed shader or tape`);
          consumer.consumeMeasuredDispatchCostMs();
          delivered.set(sink, []);
          const takes: PassCostReading[] = [];
          const take = tape.take.bind(tape);
          tape.take = () => { const reading = take(); takes.push(reading); return reading; };

          const dispatchedSizes: number[] = [];
          let lastBatch = 0;
          let lastCount = sink.counter.count;
          let seenDeliveries = 0;
          let oldSamples = 0;
          let oldMispaired = 0;
          let oldLost = 0;
          let oldWorstRatio = 1;
          const readBoth = () => {
            consumer.consumeMeasuredDispatchCostMs();
            const passes = delivered.get(sink)!;
            const newDeliveries = passes.length - seenDeliveries;
            const old = consumeGpuDispatchCostMs({ gpuTimeInFrame: sink }, lastBatch, lastCount);
            if (old.sampleCount !== lastCount) {
              oldSamples += 1;
              // `current` holds the LATEST delivered pass; any earlier new one is lost.
              oldLost += Math.max(0, newDeliveries - 1);
              const trueBatch = dispatchedSizes[passes.length - 1]!;
              if (trueBatch !== lastBatch) {
                oldMispaired += 1;
                const ratio = trueBatch / lastBatch;
                oldWorstRatio = Math.max(oldWorstRatio, ratio, 1 / ratio);
              }
            }
            lastCount = old.sampleCount;
            seenDeliveries = passes.length;
          };
          for (const size of BATCHES) {
            await nextFrame();
            readBoth();
            // A consumer that would skip this batch waits, still read every
            // frame, so every size below is one that really dispatched. The
            // generator declines only at production's own limit (a full bounds
            // ring), so it dispatches exactly when the clipmap's would.
            for (let wait = 0; wait < 120 && !canDispatch(); wait += 1) {
              await nextFrame();
              readBoth();
            }
            if (!canDispatch()) throw new Error(`${name} never became ready to dispatch`);
            dispatchedSizes.push(size);
            lastBatch = size;
            await run(size);
          }
          for (let frame = 0; frame < 16; frame += 1) {
            await nextFrame();
            readBoth();
          }
          tape.take = take;
          const passes = delivered.get(sink)!;
          return {
            name,
            batchesDelivered: passes.length,
            deliveredPages: dispatchedSizes.slice(0, passes.length).reduce((sum, size) => sum + size, 0),
            deliveredMs: passes.reduce((sum, ns) => sum + ns, 0) / 1e6,
            tapePages: takes.reduce((sum, reading) => sum + reading.units + reading.unusableUnits, 0),
            tapeMs: takes.reduce((sum, reading) => sum + reading.milliseconds, 0),
            oldSamples,
            oldMispaired,
            oldLost,
            oldWorstRatio,
          };
        };

        return [
          await meter(
            "terrain page generator",
            generator,
            (count) => generator.generate(heightSlots.slice(0, count)),
            () => (generator as unknown as { readbacksInFlight: number }).readbacksInFlight < BOUNDS_BUFFER_RING,
          ),
          await meter("occlusion bake", occlusion, (count) => occlusion.bake(channelSlots.slice(0, count))),
          await meter("splat bake", splat, (count) => splat.bake(channelSlots.slice(0, count), 171)),
        ];
      } finally {
        engine.stopRenderLoop();
        load.dispose();
        generator.dispose();
        occlusion.dispose();
        splat.dispose();
        pyramid.dispose();
        heightAtlas.dispose();
        channelAtlas.dispose();
      }
    }, true, {
      onPassTimed: (sink, _frameId, nanoseconds) => { delivered.get(sink)?.push(nanoseconds); },
    });
    if (!runs) throw new Error("the adapter advertises timestamp-query but the device measured nothing");

    for (const run of runs) {
      console.log(
        `${run.name}: ${run.batchesDelivered}/${BATCHES.length} batches delivered, ${run.deliveredPages} pages, `
        + `${run.deliveredMs.toFixed(3)} ms; tape ${run.tapePages} pages, ${run.tapeMs.toFixed(3)} ms; `
        + `old path ${run.oldSamples} readings, ${run.oldMispaired} with the wrong batch `
        + `(worst x${run.oldWorstRatio.toFixed(2)}), ${run.oldLost} batches lost`,
      );
    }
    for (const run of runs) {
      expect(run.batchesDelivered, run.name).toBe(BATCHES.length);
      // The tape: every delivered batch, at its own page count, all of its time.
      expect(run.tapePages, run.name).toBe(run.deliveredPages);
      expect(Math.abs(run.tapeMs - run.deliveredMs), run.name).toBeLessThan(0.001);
      // The positive control: the old path went wrong on this very run.
      expect(run.oldMispaired + run.oldLost, `${run.name}: the run never exercised the defect`).toBeGreaterThan(0);
    }
  }, 240_000);
});
