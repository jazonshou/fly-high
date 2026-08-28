import { describe, expect, it, vi } from "vitest";
import {
  formatGpuUncapturedError,
  GpuUncapturedErrorGuard,
  serializeGpuUncapturedError,
  WebGpuUncapturedError,
} from "../src/render/webgpu/core/GpuUncapturedErrorGuard";

class TestGpuValidationError extends Error {
  constructor(message: string, name = "GPUValidationError") {
    super(message);
    this.name = name;
  }
}

class TestGpuUncapturedErrorEvent extends Event {
  constructor(readonly error: unknown) {
    super("uncapturederror");
  }
}

class FakeGpuDevice {
  listener: EventListener | null = null;
  addCount = 0;
  removeCount = 0;

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    if (type !== "uncapturederror" || listener === null) return;
    this.addCount += 1;
    this.listener = typeof listener === "function"
      ? listener
      : (event) => listener.handleEvent(event);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    if (type !== "uncapturederror" || listener === null) return;
    this.removeCount += 1;
    if (this.listener === listener) this.listener = null;
    else this.listener = null;
  }

  emit(error: unknown): void {
    this.listener?.call(this, new TestGpuUncapturedErrorEvent(error));
  }
}

describe("GpuUncapturedErrorGuard", () => {
  it("subscribes immediately and exposes a stable, useful first failure", () => {
    const device = new FakeGpuDevice();
    const onFailure = vi.fn();
    const guard = new GpuUncapturedErrorGuard(device, onFailure);

    expect(device.addCount).toBe(1);
    expect(guard.failure).toBeNull();
    expect(() => guard.throwIfFailed()).not.toThrow();

    device.emit(new TestGpuValidationError("invalid opaque-crown swizzle assignment"));

    expect(guard.failure).toEqual({
      type: "TestGpuValidationError",
      name: "GPUValidationError",
      message: "invalid opaque-crown swizzle assignment",
    });
    expect(Object.isFrozen(guard.failure)).toBe(true);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(guard.failure);
    expect(formatGpuUncapturedError(guard.failure!)).toBe(
      "TestGpuValidationError (GPUValidationError): invalid opaque-crown swizzle assignment",
    );

    let thrown: unknown;
    try {
      guard.throwIfFailed();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WebGpuUncapturedError);
    expect(thrown).toMatchObject({
      name: "WebGpuUncapturedError",
      failure: guard.failure,
      message: expect.stringContaining("invalid opaque-crown swizzle assignment"),
    });
  });

  it("latches the first error and deduplicates every later device event", () => {
    const device = new FakeGpuDevice();
    const onFailure = vi.fn();
    const guard = new GpuUncapturedErrorGuard(device, onFailure);

    device.emit(new TestGpuValidationError("first"));
    const first = guard.failure;
    device.emit(new TestGpuValidationError("second", "GPUInternalError"));

    expect(guard.failure).toBe(first);
    expect(guard.failure?.message).toBe("first");
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("detaches idempotently and ignores an already-queued callback after disposal", () => {
    const device = new FakeGpuDevice();
    const onFailure = vi.fn();
    const guard = new GpuUncapturedErrorGuard(device, onFailure);
    const queuedListener = device.listener;

    guard.dispose();
    guard.dispose();
    expect(device.removeCount).toBe(1);

    device.emit(new TestGpuValidationError("after detach"));
    queuedListener?.call(device, new TestGpuUncapturedErrorEvent(
      new TestGpuValidationError("already queued"),
    ));

    expect(guard.failure).toBeNull();
    expect(onFailure).not.toHaveBeenCalled();
    expect(() => guard.throwIfFailed()).not.toThrow();
  });

  it("serializes malformed events without losing the error-channel context", () => {
    const failure = serializeGpuUncapturedError({ error: { message: "" } });
    expect(failure).toEqual({
      type: "GPUError",
      name: null,
      message: "WebGPU reported an uncaptured error without a message",
    });
    expect(formatGpuUncapturedError(failure)).toBe(
      "GPUError: WebGPU reported an uncaptured error without a message",
    );
  });
});
