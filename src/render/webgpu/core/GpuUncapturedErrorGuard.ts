/**
 * The small EventTarget surface required from a WebGPU device.
 *
 * Keeping this structural makes the lifecycle policy independently testable
 * without constructing a GPUDevice. A real GPUDevice extends EventTarget and
 * therefore satisfies this contract directly.
 */
export type GpuUncapturedErrorTarget = Pick<
  EventTarget,
  "addEventListener" | "removeEventListener"
>;

/** Stable diagnostic data retained for the first uncaptured device error. */
export interface GpuUncapturedErrorFailure {
  readonly type: string;
  readonly name: string | null;
  readonly message: string;
}

interface GpuUncapturedErrorEventLike {
  readonly error?: unknown;
}

const FALLBACK_ERROR_TYPE = "GPUError";
const FALLBACK_ERROR_MESSAGE = "WebGPU reported an uncaptured error without a message";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Convert the browser event into immutable data safe to retain and report. */
export function serializeGpuUncapturedError(
  event: GpuUncapturedErrorEventLike,
): GpuUncapturedErrorFailure {
  const error = event.error;
  const record = typeof error === "object" && error !== null
    ? error as { readonly constructor?: unknown; readonly name?: unknown; readonly message?: unknown }
    : null;
  const constructorRecord = typeof record?.constructor === "function"
    ? record.constructor as { readonly name?: unknown }
    : null;
  const constructorName = nonEmptyString(constructorRecord?.name);
  const type = constructorName === "Object" ? FALLBACK_ERROR_TYPE : constructorName;

  return Object.freeze({
    type: type ?? FALLBACK_ERROR_TYPE,
    name: nonEmptyString(record?.name),
    message: nonEmptyString(record?.message) ?? FALLBACK_ERROR_MESSAGE,
  });
}

/** Human-readable text shared by thrown failures, UI callbacks, and logs. */
export function formatGpuUncapturedError(failure: GpuUncapturedErrorFailure): string {
  const identity = failure.name && failure.name !== failure.type
    ? `${failure.type} (${failure.name})`
    : failure.type;
  return `${identity}: ${failure.message}`;
}

/** Error thrown by {@link GpuUncapturedErrorGuard.throwIfFailed}. */
export class WebGpuUncapturedError extends Error {
  readonly failure: GpuUncapturedErrorFailure;

  constructor(failure: GpuUncapturedErrorFailure) {
    super(`WebGPU rendering failed: ${formatGpuUncapturedError(failure)}`);
    this.name = "WebGpuUncapturedError";
    this.failure = failure;
  }
}

/**
 * Lifecycle-owned, fail-closed observer for a GPUDevice's asynchronous error
 * channel. The first error is authoritative: subsequent events cannot replace
 * its diagnostic or invoke the terminal callback again.
 */
export class GpuUncapturedErrorGuard {
  private currentFailure: GpuUncapturedErrorFailure | null = null;
  private disposed = false;

  private readonly handleUncapturedError: EventListener = (event) => {
    if (this.disposed || this.currentFailure !== null) return;
    const failure = serializeGpuUncapturedError(event as GpuUncapturedErrorEventLike);
    this.currentFailure = failure;
    this.onFailure?.(failure);
  };

  constructor(
    private readonly target: GpuUncapturedErrorTarget,
    private readonly onFailure?: (failure: GpuUncapturedErrorFailure) => void,
  ) {
    target.addEventListener("uncapturederror", this.handleUncapturedError);
  }

  get failure(): GpuUncapturedErrorFailure | null {
    return this.currentFailure;
  }

  throwIfFailed(): void {
    if (this.currentFailure) throw new WebGpuUncapturedError(this.currentFailure);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.target.removeEventListener("uncapturederror", this.handleUncapturedError);
  }
}
