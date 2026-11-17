import { describe, expect, it } from "vitest";
import {
  GpuDeviceLossLatch,
  type GpuDeviceLostInfoLike,
  WebGpuDeviceLostError,
} from "../src/render/webgpu/core/GpuDeviceLossLatch";

/**
 * The startup half of "a lost device is fatal" (`FlightRenderer.create`).
 * Babylon would restore a lost device with the raw textures empty, since this
 * renderer drops their CPU copies after upload (`TextureCpuMirror.ts`).
 */

function fakeDevice(): { device: { lost: Promise<GpuDeviceLostInfoLike> }; lose: (info: GpuDeviceLostInfoLike) => void } {
  let lose: (info: GpuDeviceLostInfoLike) => void = () => {};
  const lost = new Promise<GpuDeviceLostInfoLike>((resolve) => {
    lose = resolve;
  });
  return { device: { lost }, lose };
}

/** Lets the device's `lost` reactions run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A startup wait the way `awaitRendererStartup` makes one: it rejects when the signal aborts. */
function waitOn(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted wait")), { once: true });
  });
}

describe("GpuDeviceLossLatch", () => {
  it("aborts its signal when the device is lost, so a startup wait stops at once", async () => {
    const { device, lose } = fakeDevice();
    const latch = new GpuDeviceLossLatch(device);
    const wait = waitOn(latch.signal);
    expect(latch.signal.aborted).toBe(false);
    expect(latch.error).toBeNull();

    lose({ reason: "unknown", message: "GPU process exited" });
    await expect(wait).rejects.toThrow("aborted wait");

    expect(latch.error).toBeInstanceOf(WebGpuDeviceLostError);
    expect(latch.signal.reason).toBe(latch.error);
    expect(latch.error?.message).toContain("lost while the renderer was starting (unknown: GPU process exited)");
    expect(latch.error?.message).toContain("Reload");
  });

  it("sees a loss that came before it was watching", async () => {
    // The engine's device can be lost before create() reaches the latch;
    // Babylon's onContextLostObservable has already fired by then.
    const latch = new GpuDeviceLossLatch({ lost: Promise.resolve({ reason: "unknown", message: "" }) });
    await settle();
    expect(latch.signal.aborted).toBe(true);
    expect(latch.error?.message).toContain("(unknown)");
  });

  it("forwards the caller's abort with its reason, which is not a loss", () => {
    const { device } = fakeDevice();
    const caller = new AbortController();
    const latch = new GpuDeviceLossLatch(device, caller.signal);
    const reason = new Error("left the page");
    caller.abort(reason);
    expect(latch.signal.aborted).toBe(true);
    expect(latch.signal.reason).toBe(reason);
    expect(latch.error).toBeNull();

    const already = new AbortController();
    already.abort(reason);
    const late = new GpuDeviceLossLatch(fakeDevice().device, already.signal);
    expect(late.signal.aborted).toBe(true);
    expect(late.signal.reason).toBe(reason);
  });

  it("once disposed, ignores a later loss and lets go of the caller's signal", async () => {
    // Disposed when the renderer takes over (its own observer owns loss), or
    // by startup cleanup before engine.dispose() destroys the device.
    const { device, lose } = fakeDevice();
    const caller = new AbortController();
    const latch = new GpuDeviceLossLatch(device, caller.signal);
    latch.dispose();
    lose({ reason: "destroyed", message: "" });
    await settle();
    caller.abort();
    expect(latch.signal.aborted).toBe(false);
    expect(latch.error).toBeNull();
  });

  it("treats a device with no lost promise as never lost", async () => {
    const latch = new GpuDeviceLossLatch({});
    await settle();
    expect(latch.signal.aborted).toBe(false);
    expect(latch.error).toBeNull();
  });
});
