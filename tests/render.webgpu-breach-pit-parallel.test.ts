import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { describe, expect, it } from "vitest";
import {
  BREACH_PIT_CHUNK_PITS,
  BREACH_PIT_CHUNKS,
  BREACH_PIT_LANES,
  BREACH_PIT_LIST_CAPACITY,
  breachPitSerialWgsl,
  breachPitWgsl,
  TerrainPageErosionGpu,
  type TerrainPageErosionGpuOptions,
  terrainBreachPitChunks,
  terrainBreachPitListCheck,
} from "@/src/render/webgpu/terrain/TerrainPageErosionGpu";
import { BREACH_PIT_LANES as TWIN_LANES } from "./support/breachPitLanes";
import { readSource, stripComments } from "./support/sourceText";

/**
 * The breach stage as passes (docs/findings/BREACH_PIT_ADMISSION_2026_09_22.md):
 * the direct pass lists the pits, a one-thread pass writes each carve chunk's
 * indirect dispatch size, the pit count is read back to know how many chunks
 * there are, and the carve runs one workgroup per listed pit, a chunk of
 * `BREACH_PIT_CHUNK_PITS` pits per admitted dispatch. What a frame cannot
 * show: the stage machine's order (a fresh count before the direct pass,
 * nothing carved before the count is read, each chunk from its own arg set), a
 * page whose pits overflow the list failing before anything is carved, a
 * faulted count read never taken for a page without pits, and the carve's
 * arithmetic being the serial pass's character for character.
 */

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

function stagedProducer(options: {
  pits?: number; indirectReadyAfter?: number; faultedReads?: number; holdReads?: boolean;
} = {}) {
  const producer = new TerrainPageErosionGpu({} as AbstractEngine, {} as TerrainPageErosionGpuOptions);
  const calls: string[] = [];
  const pits = options.pits ?? 300;
  let indirectRefusals = options.indirectReadyAfter ?? 0;
  let faultedReads = options.faultedReads ?? 0;
  let rejected: Error | null = null;
  // A held read resolves only when the test releases it, so the stage
  // machine can be seen with the count in flight.
  let releaseReads = () => {};
  const readsReleased = options.holdReads
    ? new Promise<void>((resolve) => { releaseReads = resolve; })
    : Promise.resolve();
  const shader = (name: string) => ({
    name,
    dispatch: () => { calls.push(`dispatch ${name}`); return true; },
    dispatchWhenReady: async () => { calls.push(`dispatchWhenReady ${name}`); },
    dispatchIndirect: (buffer: unknown, offset = 0) => {
      if (indirectRefusals > 0) { indirectRefusals -= 1; calls.push(`not ready ${name}`); return false; }
      calls.push(`dispatchIndirect ${name} from ${(buffer as { label: string }).label} at ${offset}`);
      return true;
    },
  });
  const buffers = {
    pitArgs: {
      label: "pitArgs",
      update: (data: Uint32Array) => {
        calls.push(`reset pitArgs: ${data.length} words, ${data.every((word) => word === 0) ? "all zero" : "NOT ZERO"}`);
      },
      read: async (offset: number, size: number) => {
        calls.push(`read pitArgs ${offset}+${size}`);
        await readsReleased;
        // What the args pass leaves in chunk 0's arg set and the count word;
        // a faulted read is all zeros.
        const head = faultedReads > 0
          ? (faultedReads -= 1, new Uint32Array(4))
          : new Uint32Array([Math.min(pits, BREACH_PIT_CHUNK_PITS), 1, 1, pits]);
        return new Uint8Array(head.buffer);
      },
    },
  };
  const shaders = { breachDirect: shader("breachDirect"), breachArgs: shader("breachArgs"), breachPit: shader("breachPit") };
  const internals = producer as unknown as {
    job: Record<string, unknown> | null;
    ensureBuffers: () => unknown;
    ensureShaders: () => unknown;
    pruneStale: () => void;
    runReadbackAndMfd: () => Promise<void>;
    costTrackers: unknown[];
  };
  internals.ensureBuffers = () => buffers;
  internals.ensureShaders = () => shaders;
  internals.pruneStale = () => {};
  internals.runReadbackAndMfd = async () => { calls.push("readback"); };
  internals.costTrackers = [];
  const job = {
    stage: "breach", breachDirectDone: false, breachArgsDone: false, breachChunks: 0, breachChunksDone: 0,
    asyncInFlight: false, cancelled: false, pumpsUsed: 0, dispatchesUsed: 0,
    stagedJob: { cancel: () => { calls.push("staged job cancelled"); } },
    reject: (error: Error) => { rejected = error; },
  };
  internals.job = job;
  return { producer, calls, job, rejected: () => rejected, current: () => internals.job, releaseReads: () => releaseReads() };
}

describe("breach as passes: the stage machine", () => {
  it("resets the count, lists, sizes, reads the count, then carves a chunk at a time from each chunk's own arg set", async () => {
    const { producer, calls, job, releaseReads } = stagedProducer({ pits: 300, holdReads: true });
    await producer.pump(1);
    expect(job).toMatchObject({ breachDirectDone: true, breachArgsDone: false, stage: "breach" });
    await producer.pump(1);
    expect(job).toMatchObject({ breachArgsDone: true, asyncInFlight: true, breachChunks: 0 });
    // Nothing is offered, and a pump carves nothing, while the count is in flight.
    expect(producer.demand(0).count).toBe(0);
    await producer.pump(3);
    expect(calls.filter((call) => call.startsWith("dispatchIndirect"))).toEqual([]);
    releaseReads();
    await settle();
    expect(job).toMatchObject({ asyncInFlight: false, breachChunks: 3, breachChunksDone: 0, stage: "breach" });
    expect(producer.lastBreachPits).toBe(300);
    expect(producer.demand(0).count).toBe(3);
    await producer.pump(2);
    expect(job).toMatchObject({ breachChunksDone: 2, stage: "breach" });
    expect(producer.demand(0).count).toBe(1);
    await producer.pump(1);
    expect(job.stage).toBe("readback");
    expect(calls).toEqual([
      `reset pitArgs: ${BREACH_PIT_CHUNKS * 4} words, all zero`,
      "dispatch breachDirect",
      "dispatch breachArgs",
      "read pitArgs 0+16",
      "dispatchIndirect breachPit from pitArgs at 0",
      "dispatchIndirect breachPit from pitArgs at 16",
      "dispatchIndirect breachPit from pitArgs at 32",
      "readback",
    ]);
    expect(job.dispatchesUsed).toBe(5);
  });

  it("stops at the count read however many dispatches a pump admits", async () => {
    const { producer, calls, job } = stagedProducer({ pits: 300, holdReads: true });
    await producer.pump(10);
    expect(calls).toEqual([
      `reset pitArgs: ${BREACH_PIT_CHUNKS * 4} words, all zero`,
      "dispatch breachDirect",
      "dispatch breachArgs",
      "read pitArgs 0+16",
    ]);
    expect(job).toMatchObject({ asyncInFlight: true, stage: "breach", dispatchesUsed: 2 });
  });

  it("carves nothing on a page without pits, and goes straight to the readback", async () => {
    const { producer, calls, job } = stagedProducer({ pits: 0 });
    await producer.pump(2);
    await settle();
    expect(calls.filter((call) => call.startsWith("dispatchIndirect"))).toEqual([]);
    expect(calls.at(-1)).toBe("readback");
    expect(job).toMatchObject({ stage: "readback", asyncInFlight: true, breachChunks: 0 });
  });

  it("waits for the carve's pipeline, and a page cancelled meanwhile dispatches and counts nothing", async () => {
    const { producer, calls, job } = stagedProducer({ indirectReadyAfter: 2 });
    Object.assign(job, { breachDirectDone: true, breachArgsDone: true, breachChunks: 1 });
    const pumping = producer.pump(1);
    job.cancelled = true;
    await pumping;
    expect(calls).toEqual(["not ready breachPit"]);
    expect(job).toMatchObject({ dispatchesUsed: 0, breachChunksDone: 0, stage: "breach" });
  });

  it("runs a chunk per listed pits: none for none, one per 128 or part, the list's worth at most", () => {
    expect([0, 1, 127, 128, 129, 372, 794, 1070, 4096, 4097, 9000].map(terrainBreachPitChunks))
      .toEqual([0, 1, 1, 1, 2, 3, 7, 9, 32, 32, 32]);
    expect(BREACH_PIT_CHUNKS * BREACH_PIT_CHUNK_PITS).toBe(BREACH_PIT_LIST_CAPACITY);
  });
});

describe("breach as passes: a page whose pits overflow the list fails loudly", () => {
  it("passes a page at or under capacity, and fails one over it, counting it", () => {
    let overflows = 0;
    const count = () => { overflows += 1; };
    expect(() => terrainBreachPitListCheck(0, count)).not.toThrow();
    expect(() => terrainBreachPitListCheck(BREACH_PIT_LIST_CAPACITY, count)).not.toThrow();
    expect(overflows).toBe(0);
    expect(() => terrainBreachPitListCheck(BREACH_PIT_LIST_CAPACITY + 1, count))
      .toThrow(/breach pit list overflow: 4097 pits on one page, capacity 4096/u);
    expect(overflows).toBe(1);
  });

  it("fails an overfull page at the count read, before any chunk is carved, and counts it", async () => {
    const { producer, calls, rejected, current } = stagedProducer({ pits: BREACH_PIT_LIST_CAPACITY + 1 });
    await producer.pump(2);
    await settle();
    expect(rejected()?.message).toMatch(/breach pit list overflow: 4097 pits on one page/u);
    expect(producer.pitListOverflows).toBe(1);
    expect(current()).toBeNull();
    expect(calls.filter((call) => call.startsWith("dispatchIndirect") || call === "readback")).toEqual([]);
  });

  it("re-reads a count that came back as zeros, and fails the page rather than carve nothing on a second", async () => {
    const once = stagedProducer({ pits: 300, faultedReads: 1 });
    await once.producer.pump(2);
    await settle();
    expect(once.calls.filter((call) => call.startsWith("read"))).toEqual(["read pitArgs 0+16", "read pitArgs 0+16"]);
    expect(once.job).toMatchObject({ breachChunks: 3, asyncInFlight: false });

    const twice = stagedProducer({ pits: 300, faultedReads: 2 });
    await twice.producer.pump(2);
    await settle();
    expect(twice.rejected()?.message).toBe("breach pit count read back as zeros twice");
    expect(twice.calls.filter((call) => call.startsWith("dispatchIndirect") || call === "readback")).toEqual([]);
  });

  it("sizes the list from the survey, and says so", () => {
    expect(BREACH_PIT_LIST_CAPACITY).toBeGreaterThanOrEqual(712 * 4);
    const raw = readFileSync(join(import.meta.dirname, "..", "src", "render", "webgpu", "terrain", "TerrainPageErosionGpu.ts"), "utf8");
    const doc = raw.slice(raw.lastIndexOf("/**", raw.indexOf("export const BREACH_PIT_LIST_CAPACITY")), raw.indexOf("export const BREACH_PIT_LIST_CAPACITY"));
    expect(doc).toContain("712 pits");
    expect(doc).toContain("docs/findings/BREACH_PIT_ADMISSION_2026_09_22.md");
    expect(doc).toContain("LOUDLY");
  });
});

describe("breach as passes: the WGSL", () => {
  const parallel = breachPitWgsl();
  const serial = breachPitSerialWgsl();
  const source = readSource(join(import.meta.dirname, "..", "src", "render", "webgpu", "terrain", "TerrainPageErosionGpu.ts"));

  it("lists exactly the pits the carve works on, and keeps counting past the list", () => {
    expect(source).toContain("if (directReceiver < 0) {");
    expect(source).toContain("let slot = atomicAdd(&pitArgs[3], 1u);");
    expect(source).toMatch(/if \(slot < \$\{BREACH_PIT_LIST_CAPACITY\}u\) \{ pitList\[slot\] = u32\(index\); \}/u);
  });

  it("sizes every chunk from the listed count: full chunks, then the rest, then none", () => {
    expect(source).toContain("let listed = min(pitArgs[3], ${BREACH_PIT_LIST_CAPACITY}u);");
    expect(source).toContain("for (var chunk = 0u; chunk < ${BREACH_PIT_CHUNKS}u; chunk = chunk + 1u) {");
    expect(source).toContain("let first = chunk * ${BREACH_PIT_CHUNK_PITS}u;");
    expect(source).toContain(
      "pitArgs[chunk * 4u] = select(0u, min(listed - first, ${BREACH_PIT_CHUNK_PITS}u), listed > first);");
    expect(source).toContain("pitArgs[chunk * 4u + 1u] = 1u;");
    expect(source).toContain("pitArgs[chunk * 4u + 2u] = 1u;");
    // The same arithmetic on the CPU: the chunks the args pass sizes are the
    // chunks the producer dispatches, and together they cover the list once.
    for (const pits of [0, 1, 127, 128, 129, 372, 794, 1070, 4095, 4096, 4097, 9000]) {
      const listed = Math.min(pits, BREACH_PIT_LIST_CAPACITY);
      const sizes = Array.from({ length: BREACH_PIT_CHUNKS }, (_, chunk) => {
        const first = chunk * BREACH_PIT_CHUNK_PITS;
        return listed > first ? Math.min(listed - first, BREACH_PIT_CHUNK_PITS) : 0;
      });
      const dispatched = sizes.slice(0, terrainBreachPitChunks(pits));
      expect(dispatched.reduce((sum, size) => sum + size, 0), `${pits} pits`).toBe(listed);
      expect(dispatched.every((size) => size > 0), `${pits} pits: an empty chunk dispatched`).toBe(true);
      expect(sizes.slice(dispatched.length).every((size) => size === 0), `${pits} pits: a pit left out`).toBe(true);
    }
  });

  it("claims each workgroup's pit from a cursor the args pass zeroes", () => {
    expect(source).toContain("pitCursor[0] = 0u;");
    expect(parallel).toContain("if (lane == 0u) { claimedSlot = atomicAdd(&pitCursor[0], 1u); }");
    expect(parallel).toContain("let index = i32(pitList[claimedSlot]);");
    const claim = parallel.indexOf("claimedSlot = atomicAdd");
    const barrier = parallel.indexOf("workgroupBarrier();", claim);
    const read = parallel.indexOf("pitList[claimedSlot]");
    expect(barrier).toBeGreaterThan(claim);
    expect(read).toBeGreaterThan(barrier);
    // No chunk is told where it starts: the claim order is the only placement.
    expect(stripComments(parallel)).not.toContain("workgroup_id");
  });

  it("strides the window over the lanes and reduces by the serial search's order", () => {
    expect(BREACH_PIT_LANES).toBe(TWIN_LANES);
    expect(parallel).toContain(`@compute @workgroup_size(${BREACH_PIT_LANES}, 1, 1)`);
    expect(parallel).toContain("for (var t = i32(lane); t < side * side; t = t + i32(LANES)) {");
    expect(parallel).toContain("let dx = t % side - radius;");
    expect(parallel).toContain("let dz = t / side - radius;");
    expect(parallel).toContain("for (var stride = LANES / 2u; stride > 0u; stride = stride / 2u) {");
    expect(parallel).toMatch(
      /return !haveIncumbent \|\| score < incumbentScore\s+\|\| \(score == incumbentScore && candidateTarget < incumbentTarget\);/u);
    // WGSL reserves `target`; a shader naming it fails to compile and the carve never runs.
    expect(stripComments(parallel)).not.toMatch(/\btarget\b/u);
  });

  it("scores, tests and carves with the serial pass's own expressions", () => {
    for (const expression of [
      "let distance = sqrt(f32(dx * dx + dz * dz));",
      "if (!(targetHeight + epsilon * distance < cellHeight)) { continue; }",
      "let score = targetHeight + epsilon * distance;",
      "if (steps == 0 || steps > radius) { continue; }",
      "if (tx < 0 || tz < 0 || tx >= edge || tz >= edge) { continue; }",
      "return floor(value + 0.5);",
      "let px = startX + i32(bRound(f32(dx * step) / f32(steps)));",
      "let pz = startZ + i32(bRound(f32(dz * step) / f32(steps)));",
      "atomicMin(&breachedBits[pathCell], pOrderableEncode(descending));",
    ]) {
      expect(serial, expression).toContain(expression);
      expect(parallel, expression).toContain(expression);
    }
    // The carve's descending height, the same arithmetic on the reduced winner.
    expect(serial).toMatch(/\+ \(outletHeight - cellHeight\) \* f32\(step\) \/ f32\(bestSteps\);/u);
    expect(parallel).toMatch(/\+ \(outletHeight - cellHeight\) \* f32\(step\) \/ f32\(bestStepsAll\);/u);
  });

  it("dispatches each chunk from its own arg set, and never the serial control", () => {
    expect(source).toContain('shaders.breachPit, "breachPit", buffers.pitArgs, job.breachChunksDone * 16, job);');
    expect(source).toContain("while (!shader.dispatchIndirect(args, offset)) {");
    expect(source).toContain("{ computeSource: breachPitWgsl() },");
    expect(source).not.toContain("{ computeSource: breachPitSerialWgsl() },");
  });

  it("creates the arg-set buffer writable, readable back and usable for an indirect dispatch", () => {
    const babylonConstants = readFileSync(join(
      dirname(createRequire(import.meta.url).resolve("@babylonjs/core")), "Engines/constants.js"), "utf8");
    expect(babylonConstants).toContain("Constants.BUFFER_CREATIONFLAG_READWRITE = 3;");
    expect(babylonConstants).toContain("Constants.BUFFER_CREATIONFLAG_INDIRECT = 64;");
    expect(source).toContain("const PIT_ARGS_CREATION_FLAGS = 3 | 64;");
    expect(source).toContain(
      'pitArgs: new StorageBuffer(engine, PIT_ARGS_RESET.byteLength, PIT_ARGS_CREATION_FLAGS, "pageErosionPitArgs"),');
    expect(source).toContain("const PIT_ARGS_RESET = new Uint32Array(BREACH_PIT_CHUNKS * 4);");
  });
});
