import type { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { describe, expect, it } from "vitest";
import {
  BREACH_PIT_CHUNK_PITS,
  BREACH_PIT_LIST_CAPACITY,
  breachPitSerialWgsl,
  terrainBreachPitChunks,
} from "../../src/render/webgpu/terrain/TerrainPageErosionGpu";
import { createWorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import { admit, buildHarness, nextFrame, withScene } from "./terrainPageErosionGpuHarness";

/**
 * The parallel breach carve against the serial pass it replaces, on the
 * device: the same page, the same inputs, bit for bit
 * (docs/findings/BREACH_PIT_ADMISSION_2026_09_22.md). The serial pass is kept
 * as `breachPitSerialWgsl` for this gate only.
 *
 * Per page: pump the DAG until the direct pass has listed the pits, the args
 * pass has sized the chunks and the count is back, snapshot the breached
 * surface, run the parallel carve chunk by chunk as the DAG does (one
 * workgroup per listed pit, each chunk at its CPU-known size, some chunks
 * sharing a frame and some not) and read the surface and the receivers; then re-run
 * the direct pass to restore its inputs and run the serial control over the
 * whole scratch. Equal outputs, and outputs that differ from the snapshot, or
 * the gate compared two untouched buffers. The claim cursor must end at the
 * listed count: every listed pit claimed exactly once, none past the list.
 */

interface ProducerInternals {
  job: {
    stage: string; breachDirectDone: boolean; breachArgsDone: boolean; asyncInFlight: boolean; breachChunks: number;
  } | null;
  buffers: Record<
    "params" | "heightA" | "heightB" | "mask" | "receivers" | "pitList" | "pitArgs" | "pitCursor", StorageBuffer
  > | null;
  shaders: Record<"breachDirect" | "breachPit", ComputeShader> | null;
}

const PAGES = [[3, -3, 5], [4, -2, 2], [5, -1, 1]] as const;
const EDGE = 384;

async function readU32(buffer: StorageBuffer, count: number): Promise<Uint32Array> {
  const view = await buffer.read(0, count * 4, undefined, true);
  return new Uint32Array(view.buffer.slice(view.byteOffset, view.byteOffset + count * 4));
}

async function settle(): Promise<void> {
  for (let frame = 0; frame < 6; frame += 1) await nextFrame();
}

describe("parallel breach carve, bit for bit against the serial pass", () => {
  it("carves every page's pits exactly as the serial pass does", async () => {
    const rows = await withScene(async (engine, scene) => {
      const harness = buildHarness(engine, scene);
      const internals = harness.producer as unknown as ProducerInternals;
      const out: Array<{
        label: string; pits: number; chunks: number; claimed: number; carved: number; heightDiffs: number; receiverDiffs: number;
      }> = [];
      try {
        for (const [level, x, z] of PAGES) {
          const slot = admit(harness, createWorldPageAddress(level, x, z));
          let failure: unknown = null;
          void harness.producer.beginPage(slot, slot.token!).catch((error: unknown) => { failure = error; });
          const atCarve = () => {
            const job = internals.job;
            return job?.stage === "breach" && job.breachArgsDone && !job.asyncInFlight;
          };
          for (let frame = 0; frame < 900 && !atCarve(); frame += 1) {
            if (failure) throw failure;
            await harness.producer.pump(1);
            await nextFrame();
          }
          if (!atCarve()) throw new Error("never reached the carve");
          const chunks = internals.job!.breachChunks;
          const buffers = internals.buffers!;
          const shaders = internals.shaders!;
          await settle();
          const pits = (await readU32(buffers.pitArgs, 4))[3]!;
          const beforeCarve = await readU32(buffers.heightB, EDGE * EDGE);

          // The parallel carve, chunk by chunk as the DAG dispatches it; two
          // chunks to a frame, so both a shared frame and a new one are covered.
          const listed = Math.min(pits, BREACH_PIT_LIST_CAPACITY);
          for (let chunk = 0; chunk < chunks; chunk += 1) {
            const size = Math.min(BREACH_PIT_CHUNK_PITS, listed - chunk * BREACH_PIT_CHUNK_PITS);
            await shaders.breachPit.dispatchWhenReady(size, 1, 1);
            if (chunk % 2 === 1) await nextFrame();
          }
          await settle();
          const parallelHeight = await readU32(buffers.heightB, EDGE * EDGE);
          const parallelReceivers = await readU32(buffers.receivers, EDGE * EDGE);
          const claimed = (await readU32(buffers.pitCursor, 1))[0]!;

          // Restore the direct pass's inputs, then the serial control.
          buffers.pitArgs.update(new Uint32Array(4));
          await shaders.breachDirect.dispatchWhenReady(EDGE / 8, EDGE / 8, 1);
          await settle();
          const serial = new ComputeShader("breach-pit-serial-control", engine as WebGPUEngine, {
            computeSource: breachPitSerialWgsl(),
          }, {
            bindingsMapping: {
              params: { group: 0, binding: 0 },
              sourceHeight: { group: 0, binding: 1 },
              erosionMaskIn: { group: 0, binding: 2 },
              breachedBits: { group: 0, binding: 3 },
              receivers: { group: 0, binding: 4 },
            },
          });
          serial.setStorageBuffer("params", buffers.params);
          serial.setStorageBuffer("sourceHeight", buffers.heightA);
          serial.setStorageBuffer("erosionMaskIn", buffers.mask);
          serial.setStorageBuffer("breachedBits", buffers.heightB);
          serial.setStorageBuffer("receivers", buffers.receivers);
          await serial.dispatchWhenReady(EDGE / 8, EDGE / 8, 1);
          await settle();
          const serialHeight = await readU32(buffers.heightB, EDGE * EDGE);
          const serialReceivers = await readU32(buffers.receivers, EDGE * EDGE);

          let heightDiffs = 0;
          let receiverDiffs = 0;
          let carved = 0;
          for (let index = 0; index < EDGE * EDGE; index += 1) {
            if (parallelHeight[index] !== serialHeight[index]) heightDiffs += 1;
            if (parallelReceivers[index] !== serialReceivers[index]) receiverDiffs += 1;
            if (parallelHeight[index] !== beforeCarve[index]) carved += 1;
          }
          out.push({ label: `L${level} ${x},${z}`, pits, chunks, claimed, carved, heightDiffs, receiverDiffs });
          harness.producer.cancelActive("identity gate done");
          harness.heightAtlas.residency.release(slot.key);
          await settle();
        }
        return out;
      } finally {
        harness.dispose();
      }
    });
    for (const row of rows) {
      console.log(`breach identity ${row.label}: ${row.pits} pits in ${row.chunks} chunks, ${row.claimed} claimed, `
        + `${row.carved} cells carved; differences: ${row.heightDiffs} heights, ${row.receiverDiffs} receivers`);
    }
    for (const row of rows) {
      expect(row.pits, `${row.label}: no pits, nothing compared`).toBeGreaterThan(0);
      expect(row.chunks, `${row.label}: chunks`).toBe(terrainBreachPitChunks(row.pits));
      expect(row.chunks, `${row.label}: one chunk cannot show the chunks joining up`).toBeGreaterThan(1);
      expect(row.claimed, `${row.label}: pits claimed`).toBe(Math.min(row.pits, BREACH_PIT_LIST_CAPACITY));
      expect(row.carved, `${row.label}: the carve changed nothing, nothing compared`).toBeGreaterThan(0);
      expect({ heights: row.heightDiffs, receivers: row.receiverDiffs }, row.label).toEqual({ heights: 0, receivers: 0 });
    }
  }, 300_000);
});
