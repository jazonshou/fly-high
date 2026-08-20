import { isWorldPageKey, type WorldPageKey } from "./pageKey";

export const WORLD_PAGE_LIFECYCLE_STATES = [
  "unloaded",
  "queued",
  "loading",
  "cpu-ready",
  "uploading",
  // 4-2: a GPU-generated page never passes through "cpu-ready" — there is no
  // CPU payload to be ready. It is queued, dispatched, and resident.
  "generating",
  "resident",
  "evicting",
  "failed",
] as const;

export type WorldPageLifecycleState = (typeof WORLD_PAGE_LIFECYCLE_STATES)[number];

export const WORLD_PAGE_ALLOWED_TRANSITIONS: Readonly<
  Record<WorldPageLifecycleState, readonly WorldPageLifecycleState[]>
> = {
  unloaded: ["queued"],
  queued: ["loading", "generating", "unloaded", "failed"],
  loading: ["cpu-ready", "unloaded", "failed"],
  "cpu-ready": ["uploading", "unloaded"],
  uploading: ["resident", "cpu-ready", "unloaded", "failed"],
  generating: ["resident", "unloaded", "failed"],
  resident: ["evicting"],
  evicting: ["resident", "cpu-ready", "unloaded"],
  failed: ["queued", "unloaded"],
};

export interface WorldPageOperationToken {
  readonly key: WorldPageKey;
  readonly epoch: number;
}

export interface WorldPageLifecycleSnapshot {
  readonly key: WorldPageKey;
  readonly state: WorldPageLifecycleState;
  readonly epoch: number;
  readonly transitionCount: number;
  readonly enteredAtMs: number;
  readonly failure: string | null;
}

export function canTransitionWorldPageLifecycle(
  from: WorldPageLifecycleState,
  to: WorldPageLifecycleState,
): boolean {
  return WORLD_PAGE_ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Enforces the CPU generation -> GPU upload -> residency pipeline and supplies
 * epochs for harmless rejection of stale worker, upload, and eviction results.
 *
 * 4-2 added the GPU-generation branch (`queued -> generating -> resident`)
 * alongside the CPU one. It is a second path, not a widening of the first: the
 * CPU tile path keeps `beginUpload`'s `cpu-ready` assertion until `4-4`
 * retires it.
 */
export class WorldPageLifecycle {
  private stateValue: WorldPageLifecycleState = "unloaded";
  private epochValue = 0;
  private transitionCountValue = 0;
  private enteredAtMsValue: number;
  private failureValue: string | null = null;

  constructor(
    readonly key: WorldPageKey,
    private readonly clock: () => number = Date.now,
  ) {
    if (!isWorldPageKey(key)) throw new RangeError("Lifecycle key must be canonical");
    this.enteredAtMsValue = this.readClock();
  }

  get state(): WorldPageLifecycleState {
    return this.stateValue;
  }

  get epoch(): number {
    return this.epochValue;
  }

  get snapshot(): WorldPageLifecycleSnapshot {
    return {
      key: this.key,
      state: this.stateValue,
      epoch: this.epochValue,
      transitionCount: this.transitionCountValue,
      enteredAtMs: this.enteredAtMsValue,
      failure: this.failureValue,
    };
  }

  /** Starts initial loading or retries a failed request. */
  queue(): WorldPageOperationToken {
    this.requireState("unloaded", "failed");
    const token = this.nextToken();
    this.transition("queued");
    return token;
  }

  beginLoading(token: WorldPageOperationToken): boolean {
    return this.transitionForToken(token, "queued", "loading");
  }

  markCpuReady(token: WorldPageOperationToken): boolean {
    return this.transitionForToken(token, "loading", "cpu-ready");
  }

  /** Starts an asynchronous GPU upload and returns its independent epoch token. */
  beginUpload(): WorldPageOperationToken {
    this.requireState("cpu-ready");
    const token = this.nextToken();
    this.transition("uploading");
    return token;
  }

  markResident(token: WorldPageOperationToken): boolean {
    return this.transitionForToken(token, "uploading", "resident");
  }

  /**
   * 4-2: start a GPU generation for a page that has no CPU payload.
   *
   * Deliberately NOT a widening of `beginUpload`. That call asserts
   * `cpu-ready`, and the CPU tile path still relies on it until `4-4` retires
   * the terrain worker; letting it accept `queued` would delete the one check
   * that catches an upload issued before its payload exists.
   */
  beginGeneration(token: WorldPageOperationToken): boolean {
    return this.transitionForToken(token, "queued", "generating");
  }

  markGenerated(token: WorldPageOperationToken): boolean {
    return this.transitionForToken(token, "generating", "resident");
  }

  beginEviction(): WorldPageOperationToken {
    this.requireState("resident");
    const token = this.nextToken();
    this.transition("evicting");
    return token;
  }

  finishEviction(token: WorldPageOperationToken, retainCpuPayload = true): boolean {
    if (!this.isCurrent(token)) return false;
    this.requireState("evicting");
    this.transition(retainCpuPayload ? "cpu-ready" : "unloaded");
    if (!retainCpuPayload) this.invalidateTokens();
    return true;
  }

  cancelEviction(token: WorldPageOperationToken): boolean {
    return this.transitionForToken(token, "evicting", "resident");
  }

  /** Drop a CPU payload that is not currently referenced by a GPU upload. */
  dropCpuPayload(): void {
    this.requireState("cpu-ready");
    this.transition("unloaded");
    this.invalidateTokens();
  }

  /**
   * Cancels loading, or abandons an upload. A canceled upload may keep its CPU
   * payload so it can be resubmitted without regenerating the page.
   */
  cancelOperation(token: WorldPageOperationToken, retainCpuPayload = false): boolean {
    if (!this.isCurrent(token)) return false;
    if (
      this.stateValue === "queued"
      || this.stateValue === "loading"
      // 4-2: a generating page has no CPU payload to retain, so cancelling it
      // always unloads. The `retainCpuPayload` flag is ignored rather than
      // rejected: an atlas that drops a slot mid-dispatch is a normal event.
      || this.stateValue === "generating"
    ) {
      this.transition("unloaded");
    } else if (this.stateValue === "uploading") {
      this.transition(retainCpuPayload ? "cpu-ready" : "unloaded");
    } else {
      throw new Error(`Cannot cancel a world page operation while ${this.stateValue}`);
    }
    this.invalidateTokens();
    return true;
  }

  markFailed(token: WorldPageOperationToken, message: string): boolean {
    if (!this.isCurrent(token)) return false;
    if (message.trim().length === 0) throw new RangeError("Failure message must not be empty");
    this.requireState("queued", "loading", "uploading", "generating");
    this.failureValue = message;
    this.transition("failed", true);
    return true;
  }

  clearFailure(): void {
    this.requireState("failed");
    this.transition("unloaded");
    this.invalidateTokens();
  }

  isCurrent(token: WorldPageOperationToken): boolean {
    return token.key === this.key && token.epoch === this.epochValue;
  }

  private transitionForToken(
    token: WorldPageOperationToken,
    expected: WorldPageLifecycleState,
    next: WorldPageLifecycleState,
  ): boolean {
    if (!this.isCurrent(token)) return false;
    this.requireState(expected);
    this.transition(next);
    return true;
  }

  private transition(next: WorldPageLifecycleState, preserveFailure = false): void {
    if (!canTransitionWorldPageLifecycle(this.stateValue, next)) {
      throw new Error(`Illegal world page lifecycle transition: ${this.stateValue} -> ${next}`);
    }
    this.stateValue = next;
    this.transitionCountValue += 1;
    this.enteredAtMsValue = this.readClock();
    if (!preserveFailure) this.failureValue = null;
  }

  private requireState(...expected: readonly WorldPageLifecycleState[]): void {
    if (!expected.includes(this.stateValue)) {
      throw new Error(
        `World page ${this.key} is ${this.stateValue}; expected ${expected.join(" or ")}`,
      );
    }
  }

  private nextToken(): WorldPageOperationToken {
    this.epochValue += 1;
    return { key: this.key, epoch: this.epochValue };
  }

  private invalidateTokens(): void {
    this.epochValue += 1;
  }

  private readClock(): number {
    const now = this.clock();
    if (!Number.isFinite(now)) throw new RangeError("World page lifecycle clock must be finite");
    return now;
  }
}
