import type { WorldDefinition } from "@/src/world";
import {
  changeInfrastructureRegions,
  prepareInfrastructureRegion,
  type InfrastructureChange,
} from "@/src/world/infrastructure";
import { roadRegionKey } from "@/src/world/roads/roadInfrastructure";
import {
  roadStreamRegions,
  ROAD_STREAM_KEEP_MARGIN,
  type RoadStreamObserver,
} from "@/src/world/roads/roadStreaming";
import type {
  RoadRegionAddress,
  RoadsWorkerCommand,
  RoadsWorkerEvent,
  RoadsWorkerRegionEvent,
} from "@/src/workers/roadsProtocol";

/** The slice of a Worker the controller uses, so tests can drive it synchronously. */
export interface RoadsWorker {
  postMessage(command: RoadsWorkerCommand): void;
  addEventListener(type: "message", listener: (event: MessageEvent<RoadsWorkerEvent>) => void): void;
  terminate(): void;
}

export type RoadsWorkerFactory = () => RoadsWorker | null;

const defaultWorkerFactory: RoadsWorkerFactory = () => {
  if (typeof Worker === "undefined") return null;
  return new Worker(new URL("../../workers/roads.worker.ts", import.meta.url), {
    type: "module",
    name: "fly-high-roads",
  }) as unknown as RoadsWorker;
};

/** How often the observer is checked against the regions held, and how far it may move between. */
export const ROAD_STREAM_CHECK_INTERVAL_MS = 250;

/** Dropped regions kept for an observer that turns back. */
export const ROAD_STREAM_DROPPED_CACHE = 96;

/**
 * Segments one flush installs and drops at most, installs first (always one
 * region of each that is due, however large): composing them in place and
 * writing the GPU's copy takes about a millisecond a thousand segments, and
 * every consumer rebuilds what they reach in the same frame. The largest
 * regions hold ~450.
 */
export const ROAD_STREAM_FLUSH_SEGMENTS = 400;

/** How long after a region fails (the worker threw, or the stage refused it) it is asked again. */
export const ROAD_STREAM_RETRY_MS = 2_000;

/**
 * Failures after which a region is given up: no longer asked or counted as
 * pending, with one console error, until the window leaves it and comes back.
 */
export const ROAD_STREAM_FAILURES_TO_GIVE_UP = 2;

/** A region that failed: how often, and when it is asked again. */
interface RoadRegionFailure {
  failures: number;
  retryAtMs: number;
  /**
   * Asked again since it last failed. Until then a second failure is the
   * same ask answered twice (a `want` re-sent before the first answer
   * landed), and counts once.
   */
  retried: boolean;
}

/** One frame's change to the installed roads. */
export interface RoadStreamChange {
  /** Regions installed this change, with the pieces and pads they were laid out from. */
  readonly installed: readonly RoadsWorkerRegionEvent[];
  /** Stage keys of the regions removed. */
  readonly removed: readonly string[];
  /** The stage's change: its version, and where the ground, paint or plants may differ. */
  readonly infrastructure: InfrastructureChange;
}

/**
 * The main thread's end of the roads: asks the roads worker for the regions
 * the observer needs, most urgent first (`roadStreamRegions`), prepares each
 * as it arrives (`prepareInfrastructureRegion`: validated and binned between
 * frames), and installs them into the infrastructure stage AS ONE CHANGE PER
 * FRAME (`flush`), dropping regions the observer has left in the same change,
 * up to `ROAD_STREAM_FLUSH_SEGMENTS` between them. Listeners (the renderer,
 * the simulation and detail workers) hear each change once, with the regions
 * themselves, so every copy of the stage holds the same ones.
 *
 * `prime` holds startup until the regions round the spawn are in, so the
 * first pages bake with their roads rather than rebuilding under the car.
 */
export class RoadStreamController {
  private worker: RoadsWorker | null = null;
  private workerUnavailable = false;
  /** Installed regions by stage key. */
  private readonly installed = new Map<string, RoadsWorkerRegionEvent>();
  /** Arrived since the last flush. */
  private arrived: RoadsWorkerRegionEvent[] = [];
  /**
   * Regions dropped lately, oldest first: an observer turning back takes its
   * roads from here rather than the worker (which skips a region it posted in
   * the last few seconds).
   */
  private readonly dropped = new Map<string, RoadsWorkerRegionEvent>();
  /** Stage keys within the keep margin at the last check. */
  private keep = new Set<string>();
  /** Installed stage keys past the keep margin, in the order they left it: dropped from the front. */
  private readonly leaving = new Set<string>();
  /** Stage keys asked of the worker and not yet arrived (or failed). */
  private wanted = new Set<string>();
  private lastWant = "";
  private lastCheckMs = Number.NEGATIVE_INFINITY;
  private readonly listeners = new Set<(change: RoadStreamChange) => void>();
  private primeWaiters: { readonly keys: readonly string[]; readonly resolve: () => void }[] = [];
  /** Regions that failed, by stage key: empty unless one has. */
  private readonly failures = new Map<string, RoadRegionFailure>();
  private disposed = false;

  constructor(
    private world: WorldDefinition,
    private readonly createWorker: RoadsWorkerFactory = defaultWorkerFactory,
  ) {}

  /** Subscribe to installs and removals; returns the unsubscribe. */
  onChange(listener: (change: RoadStreamChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Regions installed now, by stage key. Observation only. */
  get installedRegions(): ReadonlyMap<string, RoadsWorkerRegionEvent> {
    return this.installed;
  }

  /**
   * Regions still to come, to install or to drop: asked of the worker and
   * not yet arrived, arrived and not yet flushed, or left and not yet
   * dropped. Zero once the observer's window is in and nothing else is; a
   * capture waits for it. Observation only.
   */
  get pendingRegions(): number {
    return this.wanted.size + this.arrived.length + this.leaving.size;
  }

  /** The live world (a spawned airport's new one shares the terrain, so its regions). */
  setWorld(world: WorldDefinition): void {
    this.world = world;
  }

  /** Feed the observer. Cheap: at most one region scan per `ROAD_STREAM_CHECK_INTERVAL_MS`. */
  observe(observer: RoadStreamObserver, nowMs: number): void {
    if (this.disposed) return;
    if (nowMs - this.lastCheckMs < ROAD_STREAM_CHECK_INTERVAL_MS) return;
    this.lastCheckMs = nowMs;
    const worker = this.ensureWorker();
    if (!worker) return;
    const kept = new Set<string>();
    for (const region of roadStreamRegions(observer, ROAD_STREAM_KEEP_MARGIN)) {
      kept.add(roadRegionKey(region.layer, region.rx, region.rz));
    }
    this.keep = kept;
    for (const key of this.leaving) {
      if (kept.has(key)) this.leaving.delete(key);
    }
    for (const key of this.installed.keys()) {
      if (!kept.has(key)) this.leaving.add(key);
    }
    const want: RoadRegionAddress[] = [];
    const wanted = new Set<string>();
    // Only once a region has failed: which keys the window holds, and
    // whether a retry is due (which re-sends the ask, changed or not).
    const window = this.failures.size > 0 ? new Set<string>() : null;
    let retryDue = false;
    for (const region of roadStreamRegions(observer)) {
      const key = roadRegionKey(region.layer, region.rx, region.rz);
      window?.add(key);
      if (this.installed.has(key) || this.arrived.some((event) => event.infrastructure.key === key)) continue;
      const cached = this.dropped.get(key);
      if (cached) {
        this.dropped.delete(key);
        this.arrived.push(cached);
        continue;
      }
      const failure = window ? this.failures.get(key) : undefined;
      if (failure) {
        if (failure.failures >= ROAD_STREAM_FAILURES_TO_GIVE_UP) continue;
        if (nowMs < failure.retryAtMs) {
          // Backing off: still to come, not asked yet.
          wanted.add(key);
          continue;
        }
        if (!failure.retried) {
          failure.retried = true;
          retryDue = true;
        }
      }
      wanted.add(key);
      want.push({ layer: region.layer, rx: region.rx, rz: region.rz });
    }
    if (window) {
      // A region given up gets one more try once the window has left it:
      // a flight that comes back later asks for it again.
      for (const [key, failure] of this.failures) {
        if (window.has(key) || failure.failures < ROAD_STREAM_FAILURES_TO_GIVE_UP) continue;
        failure.failures = ROAD_STREAM_FAILURES_TO_GIVE_UP - 1;
        failure.retryAtMs = Number.NEGATIVE_INFINITY;
        failure.retried = false;
      }
    }
    this.wanted = wanted;
    const signature = want.map((address) => `${address.layer}:${address.rx}:${address.rz}`).join(",");
    if (signature === this.lastWant && !retryDue) return;
    this.lastWant = signature;
    worker.postMessage({ type: "want", regions: want });
  }

  /**
   * Install what arrived and drop what the observer left, in one change, and
   * tell the listeners. Call once a frame; returns the change, or null.
   *
   * Installs come first, up to `ROAD_STREAM_FLUSH_SEGMENTS`; drops take what
   * they leave of it, in the order the regions left, and at least one region
   * whenever one is due. So a region that leaves is dropped within as many
   * flushes as regions left before it and are still installed, plus one: at
   * most the regions installed when it left.
   */
  flush(): RoadStreamChange | null {
    if (this.disposed) return null;
    const install: RoadsWorkerRegionEvent[] = [];
    let segments = 0;
    let taken = 0;
    for (; taken < this.arrived.length; taken += 1) {
      const event = this.arrived[taken]!;
      const key = event.infrastructure.key;
      if (this.installed.has(key) || install.some((other) => other.infrastructure.key === key)) continue;
      if (!this.keep.has(key)) {
        // Arrived after the observer left it: kept like a dropped region, so
        // a return takes it from the cache instead of asking again.
        this.cacheDropped(key, event);
        continue;
      }
      const size = event.infrastructure.segments.length;
      if (install.length > 0 && segments + size > ROAD_STREAM_FLUSH_SEGMENTS) break;
      install.push(event);
      segments += size;
    }
    this.arrived = this.arrived.slice(taken);
    const removed: string[] = [];
    for (const key of this.leaving) {
      const size = this.installed.get(key)!.infrastructure.segments.length;
      if (removed.length > 0 && segments + size > ROAD_STREAM_FLUSH_SEGMENTS) break;
      removed.push(key);
      segments += size;
    }
    for (const key of removed) this.leaving.delete(key);
    if (install.length === 0 && removed.length === 0) return null;
    const infrastructure = changeInfrastructureRegions(
      this.world,
      install.map((event) => event.infrastructure),
      removed,
    );
    for (const key of removed) {
      const event = this.installed.get(key)!;
      this.installed.delete(key);
      this.cacheDropped(key, event);
    }
    for (const event of install) this.installed.set(event.infrastructure.key, event);
    // Null only in an eroded world, which has no stage: nothing to tell.
    if (!infrastructure) return null;
    const change: RoadStreamChange = { installed: install, removed, infrastructure };
    for (const listener of this.listeners) listener(change);
    this.resolvePrimes();
    return change;
  }

  /**
   * Resolve once every region within `radiusMeters` of the observer is
   * installed, flushing as they arrive (startup has no frames yet), or after
   * `timeoutMs` whatever has come.
   */
  prime(observer: RoadStreamObserver, radiusMeters: number, timeoutMs: number): Promise<void> {
    this.lastCheckMs = Number.NEGATIVE_INFINITY;
    this.observe(observer, 0);
    if (!this.worker) return Promise.resolve();
    const keys = roadStreamRegions({ ...observer, velocityX: 0, velocityZ: 0 })
      .filter((region) => region.distance <= radiusMeters)
      .map((region) => roadRegionKey(region.layer, region.rx, region.rz));
    return new Promise<void>((resolve) => {
      const waiter = { keys, resolve };
      this.primeWaiters.push(waiter);
      setTimeout(() => {
        this.primeWaiters = this.primeWaiters.filter((other) => other !== waiter);
        resolve();
      }, timeoutMs);
      this.resolvePrimes();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    for (const waiter of this.primeWaiters) waiter.resolve();
    this.primeWaiters = [];
    this.worker?.terminate();
    this.worker = null;
  }

  private cacheDropped(key: string, event: RoadsWorkerRegionEvent): void {
    this.dropped.delete(key);
    this.dropped.set(key, event);
    if (this.dropped.size > ROAD_STREAM_DROPPED_CACHE) this.dropped.delete(this.dropped.keys().next().value!);
  }

  private resolvePrimes(): void {
    if (this.primeWaiters.length === 0) return;
    this.primeWaiters = this.primeWaiters.filter((waiter) => {
      if (!waiter.keys.every((key) => this.installed.has(key) || this.gaveUp(key))) return true;
      waiter.resolve();
      return false;
    });
  }

  private ensureWorker(): RoadsWorker | null {
    if (this.worker || this.workerUnavailable) return this.worker;
    try {
      this.worker = this.createWorker();
    } catch (error) {
      console.error("Roads worker unavailable", error);
      this.worker = null;
    }
    if (!this.worker) {
      this.workerUnavailable = true;
      return null;
    }
    this.worker.addEventListener("message", (event) => this.handleEvent(event.data));
    this.worker.postMessage({ type: "world", world: this.world });
    return this.worker;
  }

  private gaveUp(key: string): boolean {
    return (this.failures.get(key)?.failures ?? 0) >= ROAD_STREAM_FAILURES_TO_GIVE_UP;
  }

  /**
   * A region the worker could not lay out, or the stage refused: asked again
   * after `ROAD_STREAM_RETRY_MS`, and given up (one console error, no longer
   * pending) at the `ROAD_STREAM_FAILURES_TO_GIVE_UP`th failure, so a region
   * that can never resolve neither hangs a session nor a capture.
   */
  private fail(key: string, reason: string): void {
    let failure = this.failures.get(key);
    if (!failure) {
      failure = { failures: 0, retryAtMs: 0, retried: true };
      this.failures.set(key, failure);
    }
    if (!failure.retried) return;
    failure.failures += 1;
    failure.retryAtMs = this.lastCheckMs + ROAD_STREAM_RETRY_MS;
    failure.retried = false;
    if (failure.failures < ROAD_STREAM_FAILURES_TO_GIVE_UP) {
      // Still to come: pending through the back-off.
      console.warn(`Road region ${key} failed, asking again in ${ROAD_STREAM_RETRY_MS} ms: ${reason}`);
      return;
    }
    this.wanted.delete(key);
    console.error(`Road region ${key} given up after ${failure.failures} failures: ${reason}`);
    this.resolvePrimes();
  }

  private handleEvent(event: RoadsWorkerEvent): void {
    if (this.disposed) return;
    if (event.type === "error") {
      if (event.address) {
        this.fail(roadRegionKey(event.address.layer, event.address.rx, event.address.rz), event.message);
      } else {
        console.error("Road region failed", event.message);
      }
      return;
    }
    const key = event.infrastructure.key;
    try {
      prepareInfrastructureRegion(event.infrastructure);
    } catch (error) {
      this.fail(key, `refused: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.wanted.delete(key);
    this.failures.delete(key);
    this.arrived.push(event);
    // Before the first frame, nothing else flushes.
    if (this.primeWaiters.length > 0) this.flush();
  }
}
