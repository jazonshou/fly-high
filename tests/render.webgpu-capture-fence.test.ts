import { describe, expect, it, vi } from "vitest";
import { FlightRenderer } from "../src/render/FlightRenderer";

describe("capture GPU fence", () => {
  it("does not resolve before the submitted-work fence resolves", async () => {
    let releaseFence!: () => void;
    const fence = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    const onSubmittedWorkDone = vi.fn(() => fence);
    const receiver = {
      disposed: false,
      deviceLost: false,
      engine: {
        _device: { queue: { onSubmittedWorkDone } },
      },
    } as unknown as FlightRenderer;

    let settled = false;
    const waiting = FlightRenderer.prototype.waitForGpuIdleForCapture.call(receiver);
    void waiting.then(
      () => {
        settled = true;
      },
      () => undefined,
    );
    await Promise.resolve();

    expect(onSubmittedWorkDone).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    releaseFence();
    await waiting;
    expect(settled).toBe(true);
  });

  it("propagates a submitted-work fence rejection", async () => {
    const failure = new Error("queue failed");
    const receiver = {
      disposed: false,
      deviceLost: false,
      engine: {
        _device: { queue: { onSubmittedWorkDone: () => Promise.reject(failure) } },
      },
    } as unknown as FlightRenderer;

    await expect(
      FlightRenderer.prototype.waitForGpuIdleForCapture.call(receiver),
    ).rejects.toBe(failure);
  });

  it("does not touch the queue after disposal or device loss", async () => {
    const onSubmittedWorkDone = vi.fn(() => Promise.resolve());
    const receiver = {
      disposed: true,
      deviceLost: false,
      engine: {
        _device: { queue: { onSubmittedWorkDone } },
      },
    } as unknown as FlightRenderer;

    await FlightRenderer.prototype.waitForGpuIdleForCapture.call(receiver);
    expect(onSubmittedWorkDone).not.toHaveBeenCalled();

    (receiver as unknown as { disposed: boolean; deviceLost: boolean }).disposed = false;
    (receiver as unknown as { disposed: boolean; deviceLost: boolean }).deviceLost = true;
    await FlightRenderer.prototype.waitForGpuIdleForCapture.call(receiver);
    expect(onSubmittedWorkDone).not.toHaveBeenCalled();
  });
});
