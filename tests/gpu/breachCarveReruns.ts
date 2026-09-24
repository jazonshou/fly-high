import type { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Scene } from "@babylonjs/core/scene";
import { BREACH_PIT_LIST_CAPACITY } from "../../src/render/webgpu/terrain/TerrainPageErosionGpu";
import { decodeOrderableFloatBits } from "../../src/render/webgpu/terrain/TerrainPageErosion";
import { createWorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import { admit, buildHarness, gpuTimingAvailable, type Harness, nextFrame, withScene } from "./terrainPageErosionGpuHarness";

/**
 * The breach re-run gate's page loop and per-page check, shared by the gate
 * (breach-carve-reruns.test.ts) and its positive control
 * (breach-carve-reruns-control.test.ts), so the control exercises exactly the
 * check the gate asserts.
 */

export type Address = readonly [number, number, number];

/** The cost test's page throughout, and a denser one every seventh page. */
export const RERUN_SEQUENCE: readonly Address[] = Array.from({ length: 30 }, (_, index) =>
  (index % 7 === 6 ? [4, -2, 2] : [3, -3, 5]) as Address);

export interface Internals {
  job: {
    stagedJob: { mfd: (payload: { sourceHeight: Float32Array; breachedHeightBits: Uint32Array }) => Promise<Int32Array> };
  } | null;
  buffers: Record<"pitCursor", StorageBuffer> | null;
  shaders: { breachPit: { dispatch(x: number, y: number, z: number): boolean } } | null;
}

export interface PageRow {
  readonly index: number;
  readonly key: string;
  readonly lowered: number;
  readonly differing: number;
  readonly cursor: number;
  readonly listed: number;
}

async function readU32(buffer: StorageBuffer): Promise<number> {
  const view = await buffer.read(0, 4, undefined, true);
  return new Uint32Array(view.buffer.slice(view.byteOffset, view.byteOffset + 4))[0]!;
}

/** Runs the pages in order; `beforePage` may tamper with the producer (the synthetic control). */
export async function runPages(
  harness: Harness,
  sequence: readonly Address[],
  beforePage: (index: number, internals: Internals) => void = () => {},
): Promise<PageRow[]> {
  const internals = harness.producer as unknown as Internals;
  const first = new Map<string, Uint32Array>();
  const rows: PageRow[] = [];
  for (const [index, [level, x, z]] of sequence.entries()) {
    const key = `L${level} ${x},${z}`;
    const slot = admit(harness, createWorldPageAddress(level, x, z));
    let settled = false;
    let failure: unknown = null;
    void harness.producer.beginPage(slot, slot.token!)
      .then(() => { settled = true; })
      .catch((error: unknown) => { failure = error; });
    let captured: { source: Float32Array; bits: Uint32Array } | null = null;
    const staged = internals.job!.stagedJob;
    const mfd = staged.mfd.bind(staged);
    staged.mfd = (payload) => {
      captured = { source: payload.sourceHeight.slice(), bits: payload.breachedHeightBits.slice() };
      return mfd(payload);
    };
    beforePage(index, internals);
    for (let frame = 0; frame < 1500 && !settled && failure === null; frame += 1) {
      await harness.producer.pump(4);
      harness.producer.consumeMeasuredDispatchCostMs();
      await nextFrame();
    }
    if (failure) throw failure;
    if (!settled || !captured) throw new Error(`page #${index} ${key} never converged or never reached MFD`);
    harness.heightAtlas.residency.release(slot.key);
    for (let frame = 0; frame < 12; frame += 1) await nextFrame();
    const cursor = await readU32(internals.buffers!.pitCursor);
    const listed = Math.min(harness.producer.lastBreachPits ?? -1, BREACH_PIT_LIST_CAPACITY);
    const { source, bits } = captured as { source: Float32Array; bits: Uint32Array };
    const breached = decodeOrderableFloatBits(bits);
    let lowered = 0;
    for (let cell = 0; cell < breached.length; cell += 1) if (breached[cell]! < source[cell]!) lowered += 1;
    const reference = first.get(key);
    let differing = 0;
    if (reference) {
      for (let cell = 0; cell < bits.length; cell += 1) if (bits[cell] !== reference[cell]) differing += 1;
    } else {
      first.set(key, bits);
    }
    rows.push({ index, key, lowered, differing, cursor, listed });
  }
  return rows;
}

/** The per-page check: a page is wrong if any listed pit went unclaimed, its surface moved, or nothing was carved. */
export function wrongPages(rows: readonly PageRow[]): string[] {
  return rows
    .filter((row) => row.cursor !== row.listed || row.differing !== 0 || !(row.lowered > 0))
    .map((row) => `#${row.index} ${row.key}: lowered ${row.lowered}, differ ${row.differing}, cursor ${row.cursor}/${row.listed}`);
}

/**
 * The run-level facts the defect's clean and broken runs have not yet been
 * told apart by: what the adapter and device are this launch (the finding's
 * open item on the run-level trigger). One line per run.
 */
export function logRunFacts(engine: WebGPUEngine, timed: boolean): void {
  const internals = engine as unknown as {
    _adapterInfo?: { vendor?: string; architecture?: string; description?: string; device?: string };
    _device?: GPUDevice;
  };
  const info = internals._adapterInfo ?? {};
  const device = internals._device;
  const features = device ? [...device.features].sort().join(",") : "?";
  const limits = device
    ? `maxStorageBuffersPerShaderStage=${device.limits.maxStorageBuffersPerShaderStage}, `
      + `maxComputeWorkgroupsPerDimension=${device.limits.maxComputeWorkgroupsPerDimension}, `
      + `maxBufferSize=${device.limits.maxBufferSize}`
    : "?";
  console.log(`breach rerun run facts: timed=${timed}; adapter ${info.vendor ?? "?"} / ${info.architecture ?? "?"} / `
    + `${info.description ?? "?"}; features ${features}; limits ${limits}; userAgent ${navigator.userAgent}`);
}

export const scene = async <T>(run: (harness: Harness) => Promise<T>, timed: boolean) =>
  withScene(async (engine: WebGPUEngine, sceneObject: Scene) => {
    if (timed && !gpuTimingAvailable(engine)) return null;
    logRunFacts(engine, timed);
    const harness = buildHarness(engine, sceneObject);
    try {
      return await run(harness);
    } finally {
      harness.dispose();
    }
  }, timed);
