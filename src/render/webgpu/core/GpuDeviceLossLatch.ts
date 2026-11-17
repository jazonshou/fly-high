/** What a lost GPUDevice reports (`GPUDeviceLostInfo`), read structurally. */
export interface GpuDeviceLostInfoLike {
  readonly reason?: unknown;
  readonly message?: unknown;
}

/** The part of a GPUDevice the latch watches. */
export interface GpuDeviceLossTarget {
  readonly lost?: Promise<GpuDeviceLostInfoLike>;
}

/** Thrown by `FlightRenderer.create` when the device is lost before it finishes. */
export class WebGpuDeviceLostError extends Error {
  constructor(info: GpuDeviceLostInfoLike) {
    const reason = typeof info.reason === "string" && info.reason.length > 0 ? info.reason : "unknown";
    const message = typeof info.message === "string" && info.message.trim().length > 0
      ? `: ${info.message}`
      : "";
    super(
      `The WebGPU device was lost while the renderer was starting (${reason}${message}). `
        + "Reload to recreate the adapter, device, and all GPU resources.",
    );
    this.name = "WebGpuDeviceLostError";
  }
}

/**
 * Makes a lost device fatal during renderer startup.
 *
 * Babylon answers a lost device by making a new one and uploading every raw
 * texture again from the CPU copy it keeps, and this renderer drops those
 * copies once a texture is uploaded (`TextureCpuMirror.ts`), so a restored
 * device would draw those textures empty. The renderer's own
 * `onContextLostObservable` observer exists only once `FlightRenderer.create`
 * has built it, seconds after the engine. This latch covers the time before
 * that. It watches the device's own `lost` promise, which still answers a
 * loss that came before anyone listened, and aborts `signal`, so every
 * startup wait given it stops at once.
 */
export class GpuDeviceLossLatch {
  private lostError: WebGpuDeviceLostError | null = null;
  private disposed = false;
  private readonly controller = new AbortController();
  private readonly abortFromOuter = (): void => {
    this.controller.abort(this.outer?.reason);
  };

  constructor(
    device: GpuDeviceLossTarget,
    private readonly outer?: AbortSignal,
  ) {
    if (outer?.aborted) this.abortFromOuter();
    else outer?.addEventListener("abort", this.abortFromOuter, { once: true });
    void device.lost?.then((info) => {
      if (this.disposed) return;
      this.lostError = new WebGpuDeviceLostError(info);
      this.controller.abort(this.lostError);
    });
  }

  /** Aborted when the caller's signal is, or when the device is lost. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The loss, once the device has been lost; null until then. */
  get error(): WebGpuDeviceLostError | null {
    return this.lostError;
  }

  /** Stop watching: startup is over and the renderer's own observer owns loss. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.outer?.removeEventListener("abort", this.abortFromOuter);
  }
}
