/**
 * Per-pass GPU durations from timestamp queries the HARNESS injects, so a
 * measurement does not depend on whether the renderer under test was built
 * with its own timing switched on — the cloud A/B times an old base commit and
 * a new head commit with the same instrument.
 *
 * On the software adapter these are wall-clock pass durations: SwiftShader
 * writes a timestamp when its queue thread reaches the command, and a pass end
 * drains every outstanding draw first, so `end - begin` covers the load-op
 * clear, every draw and dispatch, any resolve, and any shader JIT the pass
 * triggered. Copies, `writeBuffer` and canvas presentation fall between passes
 * and are deliberately outside every window. Chrome stops quantising
 * timestamps under `--enable-unsafe-webgpu`, which every harness launch sets.
 *
 * Mechanics:
 *  - `requestDevice` gains `timestamp-query` whenever the adapter offers it;
 *  - while a frame is armed, each pass the page begins without its own
 *    `timestampWrites` is given a begin/end slot pair (the descriptor is
 *    restored right after, because Babylon reuses descriptor objects across
 *    frames and an injected field would otherwise outlive the window);
 *  - `finish()` hands an encoder's slots to its command buffer, and `submit()`
 *    appends one extra command buffer that resolves exactly the submitted
 *    slots and copies them to a mappable buffer, read once the work is done.
 */

import { gpuPassKey, type GpuPassKind } from "./gpuPassLabels";

export interface GpuPassDuration {
  readonly label: string;
  readonly kind: GpuPassKind;
  readonly nanoseconds: number;
}

export interface GpuFrameTiming {
  readonly passes: readonly GpuPassDuration[];
  /** Sum of every pass duration: GPU busy time, excluding copies and presentation. */
  readonly totalNanoseconds: number;
  /** Passes whose timestamps came back unusable (end before begin, or missing). */
  readonly invalidPasses: number;
}

interface SlotLabel {
  readonly label: string;
  readonly kind: GpuPassKind;
}

interface DeviceTiming {
  readonly device: GPUDevice;
  readonly querySet: GPUQuerySet;
  readonly resolveBuffer: GPUBuffer;
  readonly readbackPool: GPUBuffer[];
  /** Next free pair index within the armed frame. */
  nextPair: number;
  readonly pairLabels: Map<number, SlotLabel>;
}

interface TimingState {
  installed: boolean;
  armed: boolean;
  readonly devices: WeakMap<object, DeviceTiming>;
  readonly timestampCapable: WeakSet<object>;
  readonly queueTiming: WeakMap<object, DeviceTiming>;
  readonly timings: Set<DeviceTiming>;
  readonly encoderDevice: WeakMap<object, GPUDevice>;
  readonly encoderPairs: WeakMap<object, number[]>;
  readonly bufferPairs: WeakMap<object, number[]>;
  readonly pending: Array<Promise<GpuPassDuration[]>>;
  invalid: number;
  readonly restores: Array<() => void>;
}

/** Pass pairs one frame may time; a frame that needs more reports the excess as invalid. */
export const MAX_TIMED_PASSES_PER_FRAME = 512;
const QUERY_COUNT = MAX_TIMED_PASSES_PER_FRAME * 2;
const STATE_KEY = "__flyHighGpuPassTiming";

function state(): TimingState {
  const holder = globalThis as unknown as Record<string, TimingState | undefined>;
  holder[STATE_KEY] ??= {
    installed: false,
    armed: false,
    devices: new WeakMap(),
    timestampCapable: new WeakSet(),
    queueTiming: new WeakMap(),
    timings: new Set(),
    encoderDevice: new WeakMap(),
    encoderPairs: new WeakMap(),
    bufferPairs: new WeakMap(),
    pending: [],
    invalid: 0,
    restores: [],
  };
  return holder[STATE_KEY]!;
}

/**
 * The contiguous query range that covers every pair in `pairs`. Unwritten
 * queries inside it resolve to zero and are never read, so one range is
 * correct even when two encoders interleaved their allocations.
 */
export function resolveRangeForPairs(pairs: readonly number[]): { first: number; count: number } | null {
  if (pairs.length === 0) return null;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const pair of pairs) {
    low = Math.min(low, pair);
    high = Math.max(high, pair);
  }
  return { first: low * 2, count: (high - low + 1) * 2 };
}

/** Durations for `pairs` from a resolved range that starts at query `first`. */
export function pairDurations(
  resolved: BigUint64Array,
  first: number,
  pairs: readonly number[],
  labels: ReadonlyMap<number, SlotLabel>,
): { durations: GpuPassDuration[]; invalid: number } {
  const durations: GpuPassDuration[] = [];
  let invalid = 0;
  for (const pair of pairs) {
    const begin = resolved[pair * 2 - first];
    const end = resolved[pair * 2 + 1 - first];
    const label = labels.get(pair);
    if (begin === undefined || end === undefined || !label || begin === 0n || end < begin) {
      invalid += 1;
      continue;
    }
    durations.push({ label: label.label, kind: label.kind, nanoseconds: Number(end - begin) });
  }
  return { durations, invalid };
}

function patch<T extends object>(
  target: T | undefined,
  name: string,
  wrap: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown,
): void {
  if (!target) return;
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  const original = descriptor?.value as ((...args: unknown[]) => unknown) | undefined;
  if (typeof original !== "function") return;
  Object.defineProperty(target, name, { ...descriptor, value: wrap(original) });
  state().restores.push(() => Object.defineProperty(target, name, descriptor!));
}

function prototypeOf(name: string): object | undefined {
  return (globalThis as unknown as Record<string, { prototype?: object } | undefined>)[name]?.prototype;
}

/**
 * Makes `device.features` report everything except `feature`. The attribute is
 * [SameObject], so shadowing the setlike methods on that one instance hides
 * the feature from every reader of this device and from no other device.
 */
function hideDeviceFeature(device: GPUDevice, feature: string): void {
  const features = device.features;
  const proto = Object.getPrototypeOf(features) as {
    has(this: GPUSupportedFeatures, name: string): boolean;
    values(this: GPUSupportedFeatures): IterableIterator<string>;
  };
  const visible = (): string[] => [...proto.values.call(features)].filter((name) => name !== feature);
  Object.defineProperties(features, {
    has: { value: (name: string) => name !== feature && proto.has.call(features, name) },
    size: { get: () => visible().length },
    forEach: {
      value: (callback: (value: string, key: string, set: GPUSupportedFeatures) => void, thisArg?: unknown) => {
        for (const name of visible()) callback.call(thisArg, name, name, features);
      },
    },
    values: { value: () => visible()[Symbol.iterator]() },
    keys: { value: () => visible()[Symbol.iterator]() },
    entries: { value: () => visible().map((name) => [name, name] as const)[Symbol.iterator]() },
    [Symbol.iterator]: { value: () => visible()[Symbol.iterator]() },
  });
}

function deviceTiming(device: GPUDevice): DeviceTiming | undefined {
  const shared = state();
  const existing = shared.devices.get(device);
  if (existing) return existing;
  if (!shared.timestampCapable.has(device)) return undefined;
  const timing: DeviceTiming = {
    device,
    querySet: device.createQuerySet({ label: "perf-harness-pass-timing", type: "timestamp", count: QUERY_COUNT }),
    resolveBuffer: device.createBuffer({
      label: "perf-harness-pass-timing-resolve",
      size: QUERY_COUNT * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    }),
    readbackPool: [],
    nextPair: 0,
    pairLabels: new Map(),
  };
  shared.devices.set(device, timing);
  shared.queueTiming.set(device.queue, timing);
  shared.timings.add(timing);
  return timing;
}

/**
 * Patches the WebGPU prototypes. Idempotent; must run before the renderer
 * requests its device, or that device will not have `timestamp-query`.
 */
export function installGpuPassTiming(): void {
  const shared = state();
  if (shared.installed) return;
  if (typeof GPUAdapter === "undefined") return;
  shared.installed = true;

  patch(prototypeOf("GPUAdapter"), "requestDevice", (original) => function (this: GPUAdapter, ...args) {
    const descriptor = { ...((args[0] as GPUDeviceDescriptor | undefined) ?? {}) };
    const requested = [...(descriptor.requiredFeatures ?? [])];
    const pageAsked = requested.includes("timestamp-query");
    const inject = !pageAsked && this.features.has("timestamp-query");
    if (inject) descriptor.requiredFeatures = [...requested, "timestamp-query"];
    return (original.call(this, descriptor) as Promise<GPUDevice>).then((device) => {
      if (pageAsked || inject) shared.timestampCapable.add(device);
      // The page did not ask for timestamps, so it must not see them: Babylon
      // enumerates `device.features` to set `caps.timerQuery`, and a renderer
      // that believes it can time its dispatches starts feeding measured costs
      // into its compute admission — a different workload from the one the
      // capture measures. Only this module knows the feature is there.
      if (inject) hideDeviceFeature(device, "timestamp-query");
      return device;
    });
  });

  patch(prototypeOf("GPUDevice"), "createCommandEncoder", (original) => function (this: GPUDevice, ...args) {
    const encoder = original.apply(this, args) as object;
    shared.encoderDevice.set(encoder, this);
    return encoder;
  });

  const injectTimestamps = (kind: GpuPassKind) =>
    (original: (...args: unknown[]) => unknown) => function (this: object, ...args: unknown[]) {
      const descriptor = args[0] as (GPURenderPassDescriptor | GPUComputePassDescriptor | undefined);
      const device = shared.encoderDevice.get(this);
      const timing = shared.armed && device && descriptor && descriptor.timestampWrites === undefined
        ? deviceTiming(device)
        : undefined;
      if (!timing || !descriptor) return original.apply(this, args);
      if (timing.nextPair >= MAX_TIMED_PASSES_PER_FRAME) {
        shared.invalid += 1;
        return original.apply(this, args);
      }
      const pair = timing.nextPair;
      timing.nextPair += 1;
      timing.pairLabels.set(pair, { label: gpuPassKey(descriptor.label, kind), kind });
      const encoderPairs = shared.encoderPairs.get(this) ?? [];
      encoderPairs.push(pair);
      shared.encoderPairs.set(this, encoderPairs);
      (descriptor as { timestampWrites?: GPURenderPassTimestampWrites }).timestampWrites = {
        querySet: timing.querySet,
        beginningOfPassWriteIndex: pair * 2,
        endOfPassWriteIndex: pair * 2 + 1,
      };
      try {
        return original.apply(this, args);
      } finally {
        delete (descriptor as { timestampWrites?: GPURenderPassTimestampWrites }).timestampWrites;
      }
    };
  patch(prototypeOf("GPUCommandEncoder"), "beginRenderPass", injectTimestamps("render"));
  patch(prototypeOf("GPUCommandEncoder"), "beginComputePass", injectTimestamps("compute"));

  patch(prototypeOf("GPUCommandEncoder"), "finish", (original) => function (this: object, ...args) {
    const buffer = original.apply(this, args) as object;
    const pairs = shared.encoderPairs.get(this);
    if (pairs && pairs.length > 0) {
      shared.bufferPairs.set(buffer, pairs);
      shared.encoderPairs.delete(this);
    }
    return buffer;
  });

  patch(prototypeOf("GPUQueue"), "submit", (original) => function (this: GPUQueue, ...args) {
    const buffers = [...((args[0] as Iterable<GPUCommandBuffer> | undefined) ?? [])];
    const pairs: number[] = [];
    for (const buffer of buffers) {
      const owned = shared.bufferPairs.get(buffer);
      if (!owned) continue;
      pairs.push(...owned);
      shared.bufferPairs.delete(buffer);
    }
    const range = resolveRangeForPairs(pairs);
    // Pairs are allocated on the query set of the encoder's device, and a
    // queue belongs to exactly one device.
    const timing = range ? shared.queueTiming.get(this) : undefined;
    if (!range || !timing) return original.call(this, buffers);
    const readback = timing.readbackPool.pop() ?? timing.device.createBuffer({
      label: "perf-harness-pass-timing-readback",
      size: QUERY_COUNT * 8,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const encoder = timing.device.createCommandEncoder({ label: "perf-harness-pass-timing-resolve" });
    encoder.resolveQuerySet(timing.querySet, range.first, range.count, timing.resolveBuffer, 0);
    encoder.copyBufferToBuffer(timing.resolveBuffer, 0, readback, 0, range.count * 8);
    const result = original.call(this, [...buffers, encoder.finish()]);
    const labels = new Map(timing.pairLabels);
    shared.pending.push(
      readback.mapAsync(GPUMapMode.READ, 0, range.count * 8).then(() => {
        const resolved = new BigUint64Array(readback.getMappedRange(0, range.count * 8).slice(0));
        readback.unmap();
        timing.readbackPool.push(readback);
        const { durations, invalid } = pairDurations(resolved, range.first, pairs, labels);
        shared.invalid += invalid;
        return durations;
      }),
    );
    return result;
  });
}

/** True once a device with `timestamp-query` has timed at least one pass. */
export function gpuPassTimingAvailable(): boolean {
  return state().timings.size > 0;
}

/** Starts timing the passes of the frame about to be rendered. */
export function armGpuPassTiming(): void {
  const shared = state();
  if (!shared.installed) throw new Error("installGpuPassTiming() must run before a frame is armed");
  if (shared.armed) throw new Error("GPU pass timing is already armed");
  shared.armed = true;
  shared.invalid = 0;
  for (const timing of shared.timings) {
    timing.nextPair = 0;
    timing.pairLabels.clear();
  }
}

/**
 * Stops timing and returns every pass timed since `armGpuPassTiming()`,
 * waiting for the readbacks. Call after the frame's work has been submitted.
 */
export async function collectGpuPassTiming(): Promise<GpuFrameTiming> {
  const shared = state();
  if (!shared.armed) throw new Error("GPU pass timing is not armed");
  shared.armed = false;
  const settled = await Promise.all(shared.pending.splice(0));
  const passes = settled.flat();
  return {
    passes,
    totalNanoseconds: passes.reduce((sum, pass) => sum + pass.nanoseconds, 0),
    invalidPasses: shared.invalid,
  };
}

/** Removes every wrapper. For tests of this module; a harness leaves them installed. */
export function uninstallGpuPassTiming(): void {
  const shared = state();
  while (shared.restores.length > 0) shared.restores.pop()!();
  shared.installed = false;
  shared.armed = false;
}
