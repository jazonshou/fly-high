import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { BufferUsage, MapMode } from "@babylonjs/core/Engines/WebGPU/webgpuConstants";
import { WebGPUPerfCounter } from "@babylonjs/core/Engines/WebGPU/webgpuPerfCounter";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Observable } from "@babylonjs/core/Misc/observable";
import { describe, expect, it } from "vitest";
import {
  DEFERRED_PASS_TIMING_GPU_FLAGS,
  installDeferredPassTiming,
  passDurationNs,
  passQueryRange,
} from "@/src/render/webgpu/core/DeferredPassTiming";
import { readSource } from "./support/sourceText";

/**
 * Per-pass timing that reads each pass's own timestamps
 * (docs/findings/BABYLON_PASS_TIMESTAMP_ORDER_2026_09_22.md). A fake device
 * keeps the one ordering that matters: a frame's passes WRITE their query
 * slots only when the frame is submitted, so a read issued earlier sees the
 * previous occupant, exactly as Babylon's own read does on a real device.
 */

class FakeBuffer {
  readonly data: ArrayBuffer;
  destroyed = false;
  maps = 0;
  constructor(size: number) { this.data = new ArrayBuffer(size); }
  mapAsync(): Promise<void> {
    this.maps += 1;
    return Promise.resolve().then(() => {
      if (this.destroyed) throw new Error("buffer destroyed");
    });
  }
  getMappedRange(offset = 0, size = this.data.byteLength - offset): ArrayBuffer {
    return this.data.slice(offset, offset + size);
  }
  unmap(): void {}
  destroy(): void { this.destroyed = true; }
}

interface Resolve { first: number; count: number }

function fakeGpu() {
  const values = new BigUint64Array(2000);
  const querySet = { count: 2000, values } as unknown as GPUQuerySet & { values: BigUint64Array };
  const buffers: FakeBuffer[] = [];
  const resolves: Resolve[] = [];
  let submits = 0;
  const device = {
    createBuffer: ({ size }: { size: number }) => {
      const buffer = new FakeBuffer(size);
      buffers.push(buffer);
      return buffer;
    },
    createCommandEncoder: () => {
      const ops: Array<() => void> = [];
      return {
        resolveQuerySet: (set: typeof querySet, first: number, count: number, target: FakeBuffer, offset: number) => {
          resolves.push({ first, count });
          ops.push(() => new BigUint64Array(target.data, offset, count).set(set.values.subarray(first, first + count)));
        },
        copyBufferToBuffer: (source: FakeBuffer, from: number, target: FakeBuffer, to: number, size: number) => {
          ops.push(() => new Uint8Array(target.data, to, size).set(new Uint8Array(source.data, from, size)));
        },
        finish: () => ops,
      };
    },
    queue: {
      submit: (commandBuffers: Array<Array<() => void>>) => {
        submits += 1;
        for (const ops of commandBuffers) for (const op of ops) op();
      },
    },
  };
  return { querySet, values, device, buffers, resolves, submits: () => submits };
}

function fakeEngine(options: { enable?: boolean; withQuerySet?: boolean } = {}) {
  const gpu = fakeGpu();
  const babylonReads: number[] = [];
  const timestamp = {
    enable: options.enable ?? true,
    // Babylon's own endPass: resolves the pass's slots immediately. Recorded, never expected.
    endPass(index: number) { babylonReads.push(index); },
    _measureDuration: options.withQuerySet === false ? {} : { _querySet: { querySet: gpu.querySet } },
  };
  const engine = {
    frameId: 1,
    onEndFrameObservable: new Observable<unknown>(),
    onDisposeObservable: new Observable<unknown>(),
    _timestampQuery: timestamp,
    _device: gpu.device,
  };
  let clock = 1_000_000n;
  let slotIndex = 0;
  /** Babylon's `_timestampIndex`: a pass takes the next pair of slots; the frame's end restarts it. */
  const recordPass = (sink: WebGPUPerfCounter | null, durationNs: number) => {
    const index = slotIndex;
    slotIndex += 2;
    (engine._timestampQuery.endPass as (index: number, sink: unknown) => void)(index, sink);
    return { index, durationNs };
  };
  /** What an immediate read of this pass's slots would see now, as Babylon's does. */
  const readNow = (index: number) => passDurationNs(gpu.values, 0, index);
  /** Submit the frame: its passes write their slots now; then `endFrame` advances the id and notifies. */
  const endFrame = (passes: Array<{ index: number; durationNs: number }>) => {
    for (const pass of passes) {
      gpu.values[pass.index + 2] = clock;
      gpu.values[pass.index + 3] = clock + BigInt(pass.durationNs);
      clock += BigInt(pass.durationNs) + 1_000n;
    }
    slotIndex = 0;
    engine.frameId += 1;
    engine.onEndFrameObservable.notifyObservers(engine);
  };
  return { engine, asEngine: engine as unknown as AbstractEngine, gpu, babylonReads, recordPass, readNow, endFrame };
}

const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

describe("deferred per-pass timing: each pass reads its own time", () => {
  for (const order of [["heavy", "trivial"], ["trivial", "heavy"]] as const) {
    it(`gives heavy and trivial passes taking turns in slot 0 their own times (${order.join(" first, ")})`, async () => {
      const fake = fakeEngine();
      const timing = installDeferredPassTiming(fake.asEngine)!;
      const counters = { heavy: new WebGPUPerfCounter(), trivial: new WebGPUPerfCounter() };
      const truth = { heavy: 7_000_000, trivial: 7_500 };
      let staleSeen = 0;
      for (let round = 0; round < 6; round += 1) {
        for (const name of order) {
          const pass = fake.recordPass(counters[name], truth[name]);
          // The fake reproduces the defect: read now, the slot holds its previous occupant.
          if (round + (name === order[0] ? 0 : 1) > 0) {
            expect(fake.readNow(pass.index)).toBe(truth[name === "heavy" ? "trivial" : "heavy"]);
            staleSeen += 1;
          }
          fake.endFrame([pass]);
          await settle();
          expect(counters[name].counter.current, `${name}, round ${round}`).toBe(truth[name]);
        }
      }
      expect(staleSeen).toBe(11);
      expect(fake.babylonReads).toEqual([]);
      timing.dispose();
    });
  }

  it("keys each duration by its frame, and a pass recorded between frames waits for its own", async () => {
    const fake = fakeEngine();
    installDeferredPassTiming(fake.asEngine);
    const counter = new WebGPUPerfCounter();
    const delivered: Array<[number, number]> = [];
    const original = counter._addDuration.bind(counter);
    counter._addDuration = (frameId: number, ns: number) => { delivered.push([frameId, ns]); original(frameId, ns); };
    const first = fake.recordPass(counter, 100);
    const second = fake.recordPass(counter, 200);
    fake.endFrame([first, second]); // frame 1 submitted; id is now 2
    const between = fake.recordPass(counter, 300); // recorded after endFrame: keyed 2
    await settle();
    expect(delivered).toEqual([[1, 100], [1, 200]]);
    expect(counter.counter.current).toBe(300);
    fake.endFrame([between]);
    await settle();
    expect(delivered).toEqual([[1, 100], [1, 200], [2, 300]]);
    expect(counter.counter.current).toBe(300);
    expect(counter.counter.count).toBe(2);
  });

  it("leaves a pass recorded while the frame's end is announced for the frame that submits it", async () => {
    const fake = fakeEngine();
    const counter = new WebGPUPerfCounter();
    let recorded: { index: number; durationNs: number } | null = null;
    // An end-of-frame observer that runs before ours and dispatches at once:
    // its pass is in the NEXT, unsubmitted encoder.
    fake.engine.onEndFrameObservable.addOnce(() => { recorded = fake.recordPass(counter, 4_000); });
    installDeferredPassTiming(fake.asEngine);
    fake.endFrame([]);
    await settle();
    expect(counter.counter.count).toBe(0);
    fake.endFrame([recorded!]);
    await settle();
    expect(counter.counter.current).toBe(4_000);
  });

  it("drops a frame whose slots were never rewritten as stale, never as the previous frame's time", async () => {
    const fake = fakeEngine();
    const timing = installDeferredPassTiming(fake.asEngine)!;
    const competitor = new WebGPUPerfCounter();
    const talus = new WebGPUPerfCounter();
    const fineBand = new WebGPUPerfCounter();
    const delivered: Array<[string, number]> = [];
    for (const [name, counter] of [["competitor", competitor], ["talus", talus], ["fineBand", fineBand]] as const) {
      const original = counter._addDuration.bind(counter);
      counter._addDuration = (frameId: number, ns: number) => { delivered.push([name, ns]); original(frameId, ns); };
    }
    // Frame 1 writes its three slots.
    fake.endFrame([fake.recordPass(competitor, 141_873), fake.recordPass(competitor, 134_165), fake.recordPass(talus, 66_874)]);
    await settle();
    // Frame 2 times three passes in the same slots, and none of them writes:
    // the reference host's stale frame, whose last reading reached another shader.
    fake.recordPass(competitor, 140_000);
    fake.recordPass(competitor, 135_000);
    fake.recordPass(fineBand, 70_000);
    fake.endFrame([]);
    await settle();
    // Frame 3 writes again, and reads true.
    fake.endFrame([fake.recordPass(competitor, 139_000), fake.recordPass(competitor, 133_000), fake.recordPass(fineBand, 71_000)]);
    await settle();
    expect(delivered).toEqual([
      ["competitor", 141_873], ["competitor", 134_165], ["talus", 66_874],
      ["competitor", 0], ["competitor", 0], ["fineBand", 0],
      ["competitor", 139_000], ["competitor", 133_000], ["fineBand", 71_000],
    ]);
    expect(timing.staleReadings).toBe(3);
    expect(fineBand.counter.count).toBe(2);
    expect(fineBand.counter.current).toBe(71_000);
  });

  it("delivers a pair that is not increasing as 0, so a consumer can count it unusable", async () => {
    const fake = fakeEngine();
    installDeferredPassTiming(fake.asEngine);
    const counter = new WebGPUPerfCounter();
    const pass = fake.recordPass(counter, 0);
    fake.endFrame([pass]);
    await settle();
    expect(counter.counter.count).toBe(1);
    expect(counter.counter.current).toBe(0);
    expect(passDurationNs(new BigUint64Array([5n, 3n]), 2, 0)).toBe(0);
    expect(passDurationNs(new BigUint64Array([0n, 0n]), 2, 0)).toBe(0);
    expect(passDurationNs(new BigUint64Array([3n, 5n]), 2, 0)).toBe(2);
  });
});

describe("deferred per-pass timing: one readback per frame", () => {
  it("issues one resolve, one submit and one readback per timed frame, over exactly its slot range", async () => {
    const fake = fakeEngine();
    const timing = installDeferredPassTiming(fake.asEngine)!;
    const counters = Array.from({ length: 44 }, () => new WebGPUPerfCounter());
    for (let frame = 0; frame < 3; frame += 1) {
      const passes = counters.map((counter, index) => fake.recordPass(counter, 1_000 + index));
      fake.endFrame(passes);
    }
    fake.endFrame([]); // a frame that timed nothing costs nothing
    await settle();
    expect(timing.passesTimed).toBe(132);
    expect(timing.framesTimed).toBe(3);
    expect(timing.readbacks).toBe(3);
    expect(fake.gpu.submits()).toBe(3);
    expect(fake.gpu.resolves).toEqual([
      { first: 2, count: 88 }, { first: 2, count: 88 }, { first: 2, count: 88 },
    ]);
    counters.forEach((counter, index) => expect(counter.counter.current).toBe(1_000 + index));
    expect(passQueryRange([4, 0, 2])).toEqual({ first: 2, count: 6 });
  });

  it("never calls Babylon's own per-pass read once installed, and hands it back on dispose", () => {
    const fake = fakeEngine();
    const babylonEndPass = fake.engine._timestampQuery.endPass;
    const timing = installDeferredPassTiming(fake.asEngine)!;
    expect(fake.engine._timestampQuery.endPass).not.toBe(babylonEndPass);
    fake.recordPass(new WebGPUPerfCounter(), 10);
    expect(fake.babylonReads).toEqual([]);
    timing.dispose();
    expect(fake.engine._timestampQuery.endPass).toBe(babylonEndPass);
  });

  it("queues nothing for a pass without a counter", () => {
    const fake = fakeEngine();
    const timing = installDeferredPassTiming(fake.asEngine)!;
    fake.endFrame([fake.recordPass(null, 10)]);
    expect(timing.passesTimed).toBe(0);
    expect(timing.readbacks).toBe(0);
  });

  it("delivers nothing from a readback that lands after dispose, and releases its buffer", async () => {
    const fake = fakeEngine();
    const timing = installDeferredPassTiming(fake.asEngine)!;
    const counter = new WebGPUPerfCounter();
    fake.endFrame([fake.recordPass(counter, 10)]);
    timing.dispose();
    await settle();
    expect(counter.counter.count).toBe(0);
    expect(fake.gpu.buffers.every((buffer) => buffer.destroyed)).toBe(true);
  });

  it("disposes with the engine", () => {
    const fake = fakeEngine();
    const babylonEndPass = fake.engine._timestampQuery.endPass;
    installDeferredPassTiming(fake.asEngine);
    fake.engine.onDisposeObservable.notifyObservers(fake.engine);
    expect(fake.engine._timestampQuery.endPass).toBe(babylonEndPass);
  });

  it("installs nothing when timing is off or there is no query set", () => {
    expect(installDeferredPassTiming(fakeEngine({ enable: false }).asEngine)).toBeNull();
    expect(installDeferredPassTiming(fakeEngine({ withQuerySet: false }).asEngine)).toBeNull();
  });

  it("uses WebGPU's own flag values", () => {
    expect(DEFERRED_PASS_TIMING_GPU_FLAGS).toEqual({
      mapRead: BufferUsage.MapRead,
      copySrc: BufferUsage.CopySrc,
      copyDst: BufferUsage.CopyDst,
      queryResolve: BufferUsage.QueryResolve,
      mapModeRead: MapMode.Read,
    });
  });
});

describe("deferred per-pass timing: the Babylon it replaces a piece of", () => {
  // Read through module resolution: a worktree has no node_modules of its own.
  const babylon = (path: string) => readFileSync(
    join(dirname(createRequire(import.meta.url).resolve("@babylonjs/core")), path), "utf8");

  it("still gives pass `index` the queries index+2 and index+3 in one set of 2000", () => {
    const source = babylon("Engines/WebGPU/webgpuTimestampQuery.js");
    expect(source).toContain("beginningOfPassWriteIndex: index + 2,");
    expect(source).toContain("endOfPassWriteIndex: index + 3,");
    expect(source).toContain("this._measureDuration = new WebGPUDurationMeasure(this._engine, this._device, this._bufferManager, 2000,");
    expect(source).toContain("this._querySet = new WebGPUQuerySet(engine, count,");
    expect(source).toContain("endPass(index, gpuPerfCounter) {");
    expect(babylon("Engines/WebGPU/webgpuQuerySet.js")).toContain("get querySet() {");
  });

  it("still keys a counter's durations by frame id", () => {
    expect(babylon("Engines/WebGPU/webgpuPerfCounter.js")).toContain("_addDuration(currentFrameId, duration) {");
  });

  it("still submits the frame, then advances the id, then notifies the end of the frame", () => {
    const webgpu = babylon("Engines/webgpuEngine.pure.js");
    const endFrame = webgpu.slice(webgpu.indexOf("    endFrame() {"));
    const reset = endFrame.indexOf("this._timestampIndex = 0;");
    const flush = endFrame.indexOf("this.flushFramebuffer(true);");
    const handOff = endFrame.indexOf("super.endFrame();");
    expect(reset).toBeGreaterThan(0);
    expect(flush).toBeGreaterThan(reset);
    expect(handOff).toBeGreaterThan(flush);
    expect(babylon("Engines/abstractEngine.pure.js")).toMatch(
      /endFrame\(\) \{\s+this\._frameId\+\+;\s+this\.onEndFrameObservable\.notifyObservers\(this\);/u);
  });

  it("still routes compute and render passes through the one endPass", () => {
    expect(babylon("Engines/WebGPU/Extensions/engine.computeShader.pure.js"))
      .toContain("this._timestampQuery.endPass(this._timestampIndex, gpuPerfCounter);");
    expect(babylon("Engines/thinWebGPUEngine.js")).toContain("this._timestampQuery.endPass(this._timestampIndex, (");
  });
});

describe("deferred per-pass timing: installed wherever timing is switched on", () => {
  const root = join(import.meta.dirname, "..");

  it("in the renderer, straight after the one switch, and a failure to install is fatal", () => {
    const source = readSource(join(root, "src/render/FlightRenderer.ts"));
    const enable = source.indexOf("engine.enableGPUTimingMeasurements = gpuTimingEnabled;");
    const install = source.indexOf("if (engine.enableGPUTimingMeasurements && !installDeferredPassTiming(engine)) {");
    expect(enable).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(enable);
    // Nothing but comments between them.
    expect(source.slice(enable + "engine.enableGPUTimingMeasurements = gpuTimingEnabled;".length, install).trim()).toBe("");
  });

  it("in every GPU test that switches timing on", () => {
    for (const file of [
      "tests/gpu/terrain-compute-cost.test.ts",
      "tests/gpu/ground-cover-compute.test.ts",
      "tests/gpu/terrainPageErosionGpuHarness.ts",
    ]) {
      const source = readSource(join(root, file));
      const switches = source.match(/enableGPUTimingMeasurements = /gu) ?? [];
      const installs = source.match(/!installDeferredPassTiming\(engine[,)]/gu) ?? [];
      expect(switches.length, file).toBeGreaterThan(0);
      expect(installs.length, file).toBe(switches.length);
    }
  });
});
