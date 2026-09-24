import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";

/**
 * Per-pass GPU timing that reads each pass's OWN timestamps.
 *
 * Babylon (9.21) gives every timed pass two query slots, `index + 2` and
 * `index + 3`, and records the pass into the frame's encoder, which is
 * submitted at `endFrame`. But its `endPass` resolves those two slots on a
 * separate encoder that it submits AT ONCE, so on the GPU queue the resolve
 * runs before the pass has written them. Every reading is the time of
 * whichever pass last held that slot in an earlier frame (slot indices restart
 * at 0 every frame), and a slot never reached before reads 0. Proven with a
 * heavy and a trivial pass taking turns in slot 0: 26 of 26 readings were
 * exactly the previous occupant's true time
 * (docs/findings/BABYLON_PASS_TIMESTAMP_ORDER_2026_09_22.md).
 *
 * This replaces, on the engine INSTANCE, only the read. Babylon still
 * allocates the slots and puts the `timestampWrites` on each pass. `endPass`
 * now just remembers the pass (its slot, its counter, and the frame id Babylon
 * would have keyed it by). When the frame has been submitted
 * (`onEndFrameObservable` fires after `flushFramebuffer`), ONE resolve covers
 * the frame's whole slot range, ONE copy and ONE `mapAsync` read it back, and
 * each counter receives its own pass's duration through the same
 * `_addDuration(frameId, ns)` Babylon uses. The resolve is submitted after the
 * frame that wrote the slots and before the next frame's encoder can
 * overwrite them, so the order is right by construction.
 *
 * It is also the batching RESOLUTION_PLAN.md section 3.2 recommended: Babylon's
 * one-submit-and-readback per timed pass stretched the reference host's frame
 * from 8.33 to 13.1 ms at 88 timed passes (measured under load); this stays
 * at 8.33 ms at every count (see GpuTimingPolicy.ts for the numbers and the
 * load).
 *
 * Babylon's whole-frame measure (queries 0 and 1, `getGPUFrameTimeCounter`)
 * is left alone: it is one measurement per frame, so its early read is a lag
 * of one frame, not another pass's time.
 */

/** WebGPU's own flag values (`GPUBufferUsage`, `GPUMapMode`), pinned against Babylon's in Node. */
export const DEFERRED_PASS_TIMING_GPU_FLAGS = Object.freeze({
  mapRead: 0x0001,
  copySrc: 0x0004,
  copyDst: 0x0008,
  queryResolve: 0x0200,
  mapModeRead: 0x0001,
});

/** Babylon's whole-frame measure owns queries 0 and 1; pass `index` writes `index + 2` and `index + 3`. */
const PASS_QUERY_OFFSET = 2;

/** The receiving half of Babylon's `WebGPUPerfCounter`. */
export interface PassDurationSink {
  _addDuration(frameId: number, durationNs: number): void;
}

interface TimestampQueryInternals {
  readonly enable: boolean;
  endPass(index: number, sink?: PassDurationSink | null): void;
  readonly _measureDuration?: { readonly _querySet?: { readonly querySet?: GPUQuerySet } };
}

interface Subscribable {
  add(callback: () => void): unknown;
  remove(observer: unknown): boolean;
}

interface EngineInternals {
  readonly frameId: number;
  readonly onEndFrameObservable: Subscribable;
  readonly onDisposeObservable: Subscribable;
  readonly _timestampQuery?: TimestampQueryInternals;
  readonly _device?: GPUDevice;
}

interface PendingPass {
  readonly slot: number;
  readonly sink: PassDurationSink;
  readonly frameId: number;
}

/** The query range one frame's passes wrote: the first pass's begin to the last pass's end. */
export function passQueryRange(slots: readonly number[]): { readonly first: number; readonly count: number } {
  const first = Math.min(...slots) + PASS_QUERY_OFFSET;
  const last = Math.max(...slots) + PASS_QUERY_OFFSET + 1;
  return { first, count: last - first + 1 };
}

/**
 * One pass's duration from a resolved range starting at query `first`. A pair
 * that is not increasing (never written, or a sample the device could not
 * take) is 0, Babylon's own convention, so a consumer can count it as a
 * reading the counter could not give.
 */
export function passDurationNs(values: BigUint64Array, first: number, slot: number): number {
  const at = slot + PASS_QUERY_OFFSET - first;
  const begin = values[at];
  const end = values[at + 1];
  if (begin === undefined || end === undefined || end <= begin) return 0;
  return Number(end - begin);
}

/** A timed shader's counter, the sink its passes are delivered to; undefined when timing is off. */
export function passTimingSinkOf(shader: unknown): PassDurationSink | undefined {
  return (shader as { gpuTimeInFrame?: PassDurationSink } | null | undefined)?.gpuTimeInFrame;
}

type PassDurationListener = (frameId: number, durationNs: number) => void;
const passDurationListeners = new WeakMap<PassDurationSink, Set<PassDurationListener>>();

/**
 * Hear every duration delivered to `sink`, one call per pass, in dispatch
 * order, keyed by the frame the pass was recorded in. Returns the unsubscribe.
 */
export function observePassDurations(sink: PassDurationSink, listener: PassDurationListener): () => void {
  let set = passDurationListeners.get(sink);
  if (!set) {
    set = new Set();
    passDurationListeners.set(sink, set);
  }
  set.add(listener);
  return () => { set.delete(listener); };
}

/** The one delivery path: Babylon's counter first, then whoever observes it. */
export function deliverPassDuration(sink: PassDurationSink, frameId: number, durationNs: number): void {
  sink._addDuration(frameId, durationNs);
  const listeners = passDurationListeners.get(sink);
  if (listeners) for (const listener of listeners) listener(frameId, durationNs);
}

/** What a tape's passes cost since the last `take`. */
export interface PassCostReading {
  /** GPU time of the passes that read a positive duration. */
  readonly milliseconds: number;
  /** Their units (pages, bands, dispatches: whatever `dispatched` was given). */
  readonly units: number;
  /** Units whose pass read no positive duration: a reading the device could not give. */
  readonly unusableUnits: number;
}

/** Passes a tape will wait for before it drops the oldest (a reading that is never coming). */
const PASS_COST_TAPE_LIMIT = 4096;

/**
 * One timed shader's passes, each paired with ITS OWN delivered duration.
 *
 * Why not read Babylon's counter: `counter.current` is the latest frame's sum
 * and `count` moves once per frame, so a meter that polls it loses a frame
 * whenever two land between polls, and prices a delivered frame by whatever
 * batch was dispatched last. Deliveries arrive a frame or more after the
 * dispatch, so both happen. A tape records each pass as it is dispatched,
 * with its frame id and its units, and pairs it with the delivery for that
 * frame, in dispatch order.
 */
export class PassCostTape {
  private readonly passes: Array<{ readonly frameId: number; readonly units: number }> = [];
  private milliseconds = 0;
  private units = 0;
  private unusableUnits = 0;
  private readonly unsubscribe: (() => void) | null;

  constructor(
    private readonly engine: { readonly frameId: number },
    sink: PassDurationSink | null | undefined,
  ) {
    this.unsubscribe = sink
      ? observePassDurations(sink, (frameId, durationNs) => this.deliver(frameId, durationNs))
      : null;
  }

  /** Whether this shader is timed at all (production runs with timing off). */
  get timed(): boolean {
    return this.unsubscribe !== null;
  }

  /** Record one pass, AFTER it was dispatched, and what it is worth. */
  dispatched(units: number): void {
    if (!this.unsubscribe) return;
    this.passes.push({ frameId: this.engine.frameId, units });
    if (this.passes.length > PASS_COST_TAPE_LIMIT) this.passes.shift();
  }

  /** Priced and unusable units since the last call, and the priced passes' time. */
  take(): PassCostReading {
    const reading = { milliseconds: this.milliseconds, units: this.units, unusableUnits: this.unusableUnits };
    this.milliseconds = 0;
    this.units = 0;
    this.unusableUnits = 0;
    return reading;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.passes.length = 0;
  }

  private deliver(frameId: number, durationNs: number): void {
    // A pass from an older frame whose reading never came is dropped, not priced.
    while (this.passes.length > 0 && this.passes[0]!.frameId < frameId) this.passes.shift();
    const pass = this.passes[0];
    if (!pass || pass.frameId !== frameId) return; // a pass this tape did not record
    this.passes.shift();
    if (Number.isFinite(durationNs) && durationNs > 0) {
      this.milliseconds += durationNs / 1_000_000;
      this.units += pass.units;
    } else {
      this.unusableUnits += pass.units;
    }
  }
}

export interface DeferredPassTiming {
  /** Passes whose timestamps were queued. */
  readonly passesTimed: number;
  /** Frames that timed at least one pass. */
  readonly framesTimed: number;
  /** Readbacks issued: one per timed frame, never one per pass. */
  readonly readbacks: number;
  dispose(): void;
}

export interface DeferredPassTimingOptions {
  /** Diagnostics: every delivered duration, as the counter receives it. */
  readonly onPassTimed?: (sink: PassDurationSink, frameId: number, durationNs: number) => void;
}

/**
 * Install on an engine whose GPU timing is already enabled. Returns null when
 * there is nothing to install on (timing off, or no query set).
 */
export function installDeferredPassTiming(
  engine: AbstractEngine,
  options: DeferredPassTimingOptions = {},
): DeferredPassTiming | null {
  const internals = engine as unknown as EngineInternals;
  const timestamp = internals._timestampQuery;
  const querySet = timestamp?._measureDuration?._querySet?.querySet;
  const device = internals._device;
  if (!timestamp || !timestamp.enable || !querySet || !device) return null;

  const flags = DEFERRED_PASS_TIMING_GPU_FLAGS;
  const capacityBytes = querySet.count * 8;
  const resolveBuffer = device.createBuffer({
    label: "deferredPassTimingResolve",
    size: capacityBytes,
    usage: flags.queryResolve | flags.copySrc,
  });
  const spare: GPUBuffer[] = [];
  let pending: PendingPass[] = [];
  let passesTimed = 0;
  let framesTimed = 0;
  let readbacks = 0;
  let disposed = false;

  const babylonEndPass = timestamp.endPass;
  const endPass = (index: number, sink?: PassDurationSink | null): void => {
    if (!timestamp.enable || !sink) return;
    pending.push({ slot: index, sink, frameId: internals.frameId });
    passesTimed += 1;
  };
  (timestamp as { endPass: typeof endPass }).endPass = endPass;

  const onFrameSubmitted = (): void => {
    // `endFrame` has submitted the frame and advanced the id: every pass keyed
    // below it was in an encoder that is on the queue now. A pass recorded
    // between frames is keyed by the next id and waits for that frame.
    let due = 0;
    while (due < pending.length && pending[due]!.frameId < internals.frameId) due += 1;
    if (due === 0) return;
    const passes = pending.slice(0, due);
    pending = pending.slice(due);
    if (!timestamp.enable) return;
    const { first, count } = passQueryRange(passes.map((pass) => pass.slot));
    const bytes = count * 8;
    const target = spare.pop() ?? device.createBuffer({
      label: "deferredPassTimingRead",
      size: capacityBytes,
      usage: flags.mapRead | flags.copyDst,
    });
    const encoder = device.createCommandEncoder({ label: "deferredPassTiming" });
    encoder.resolveQuerySet(querySet, first, count, resolveBuffer, 0);
    encoder.copyBufferToBuffer(resolveBuffer, 0, target, 0, bytes);
    device.queue.submit([encoder.finish()]);
    framesTimed += 1;
    readbacks += 1;
    target.mapAsync(flags.mapModeRead, 0, bytes).then(() => {
      if (disposed) {
        target.unmap();
        target.destroy();
        return;
      }
      const values = new BigUint64Array(target.getMappedRange(0, bytes));
      const durations = passes.map((pass) => passDurationNs(values, first, pass.slot));
      target.unmap();
      spare.push(target);
      passes.forEach((pass, index) => {
        deliverPassDuration(pass.sink, pass.frameId, durations[index]!);
        options.onPassTimed?.(pass.sink, pass.frameId, durations[index]!);
      });
    }, () => {
      // The device went away under the read; there is nothing to deliver.
      target.destroy();
    });
  };
  const frameObserver = internals.onEndFrameObservable.add(onFrameSubmitted);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    internals.onEndFrameObservable.remove(frameObserver);
    internals.onDisposeObservable.remove(disposeObserver);
    if (timestamp.endPass === endPass) {
      (timestamp as { endPass: typeof babylonEndPass }).endPass = babylonEndPass;
    }
    pending = [];
    resolveBuffer.destroy();
    for (const buffer of spare.splice(0)) buffer.destroy();
  };
  const disposeObserver = internals.onDisposeObservable.add(dispose);

  return {
    get passesTimed() { return passesTimed; },
    get framesTimed() { return framesTimed; },
    get readbacks() { return readbacks; },
    dispose,
  };
}
