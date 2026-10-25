/**
 * The detail (vegetation) worker's watchdogs, watched from outside: how long
 * `WorldDetailRuntime` has charged its worker for, sampled once per frame by
 * the perf agent (`detailWatchdogSample` in agent.ts reads the runtime's
 * private fields), and how long each worker build took to come back.
 *
 * A charged span is read from the runtime's own clock: the update count and
 * the gap-excluded milliseconds since the marker its deadline counts from, so
 * a slow harness frame inflates nothing the runtime would not count itself.
 * On a runtime that resets the marker only on accepted output (19543c0) a span
 * is a demand episode; on one that resets it on a heartbeat, charged silence.
 * Either way a span the runtime charged 2,000 ms or more would have tripped
 * its 240-update deadline at 120 Hz, however many updates this slower
 * harness actually ran in it.
 *
 * Pure (no DOM), so tests/perf-flight-verdict.test.ts drives it with samples.
 */

/** The 240-update deadline at 120 Hz, in milliseconds. */
export const DETAIL_WATCHDOG_TRIP_AT_120HZ_MILLISECONDS = 2_000;
/** The deadline's millisecond arm, which needs no update count. */
export const DETAIL_WATCHDOG_WALL_DEADLINE_MILLISECONDS = 8_000;
/** The part of a gap between updates the runtime still charges its worker. */
export const DETAIL_WATCHDOG_UPDATE_GAP_ALLOWANCE_MILLISECONDS = 100;

export interface DetailWatchdogSample {
  /** `performance.now()` when sampled. */
  readonly wallMs: number;
  /** The runtime's own clock (`presentationNowMilliseconds`), which its deadlines read. */
  readonly nowMs: number;
  /**
   * That clock at the runtime's last update; null before the first, or with
   * no worker to time. The next update charges at most the allowance of the
   * time since, however long the rest of `render()` took.
   */
  readonly lastUpdateMs: number | null;
  readonly updateSequence: number;
  /**
   * Where each clock's open span started: the update index and the clock's
   * millisecond marker (pushed forward past update gaps over the allowance).
   * Null when no span is open.
   */
  readonly presentationUpdate: number | null;
  readonly presentationMs: number | null;
  readonly generationUpdate: number | null;
  readonly generationMs: number | null;
  /** The generation worker has answered once: its update arm is armed. */
  readonly generationAnswered: boolean;
  /** The worker presentation build in flight; null for none or an inline build. */
  readonly workerBuildId: number | null;
  /** The generation client, as an identity; null when vegetation is generated inline. */
  readonly client: object | null;
  /** Counters that tell an accepted completion from a timed-out or cancelled build. */
  readonly buildTimeouts: number;
  readonly cancellations: number;
}

export interface DetailWatchdogClockReport {
  /** Spans that ended in the window (reset, or replaced by a new one). */
  readonly spans: number;
  /** The longest span seen, as the runtime charges it. */
  readonly maxChargedMs: number;
  readonly maxChargedUpdates: number;
  /** The longest span in raw wall time, first to last frame it was seen open in this window. */
  readonly maxWallMs: number;
  /** Spans that crossed what trips the deadline at 120 Hz in this window. */
  readonly wouldTripAt120Hz: number;
  /** The span still open at the window's end, as charged so far; null when none is. */
  readonly openChargedMs: number | null;
}

export interface DetailWatchdogReport {
  /** Frames sampled, and the wall time from the window's start to its last sample. */
  readonly frames: number;
  readonly wallMs: number;
  /** The presentation-build deadline, and the cell-generation deadline. */
  readonly presentation: DetailWatchdogClockReport;
  readonly generation: DetailWatchdogClockReport;
  /**
   * Each worker build the runtime accepted, first seen pending to gone, when
   * both fell in this window: wall ms and updates. A build that was
   * cancelled, timed out or lost with its worker is not a latency.
   */
  readonly buildLatencyMs: readonly number[];
  readonly buildLatencyUpdates: readonly number[];
  /** Worker builds that went away without being accepted. */
  readonly buildsNotAccepted: number;
  /** Frames (indices in the window) after which the client was gone or another one. */
  readonly workerLostAtFrames: readonly number[];
}

interface OpenSpan {
  chargedUpdates: number;
  firstWallMs: number;
  lastWallMs: number;
  /** Already counted as a would-trip (in this window or an earlier one). */
  counted: boolean;
}

class ChargedClock {
  private open: OpenSpan | null = null;
  private spans = 0;
  private maxChargedMs = 0;
  private maxChargedUpdates = 0;
  private maxWallMs = 0;
  private wouldTrip = 0;
  private lastChargedMs: number | null = null;

  beginWindow(): void {
    this.spans = 0;
    this.maxChargedMs = 0;
    this.maxChargedUpdates = 0;
    this.maxWallMs = 0;
    this.wouldTrip = 0;
    // A span open across the window boundary stays open; its wall time in
    // this window starts at its first sample here (the other arm's leg ran in
    // between, and this runtime did not update).
    if (this.open) this.open.firstWallMs = Number.NaN;
  }

  observe(
    wallMs: number,
    chargedUpdates: number | null,
    chargedMs: number | null,
    tripsAt120Hz: (chargedMs: number) => boolean,
  ): void {
    // A span ends when the marker is cleared, or when its charged count falls:
    // the marker moved past the previous sample's (accepted output, a
    // heartbeat), and a new span started. A paused span keeps its count.
    if (this.open && (chargedUpdates === null || chargedUpdates < this.open.chargedUpdates)) {
      this.open = null;
      this.spans += 1;
    }
    this.lastChargedMs = chargedMs;
    if (chargedUpdates === null || chargedMs === null) return;
    const span = (this.open ??= { chargedUpdates, firstWallMs: wallMs, lastWallMs: wallMs, counted: false });
    if (Number.isNaN(span.firstWallMs)) span.firstWallMs = wallMs;
    span.chargedUpdates = chargedUpdates;
    span.lastWallMs = wallMs;
    this.maxChargedMs = Math.max(this.maxChargedMs, chargedMs);
    this.maxChargedUpdates = Math.max(this.maxChargedUpdates, chargedUpdates);
    this.maxWallMs = Math.max(this.maxWallMs, span.lastWallMs - span.firstWallMs);
    if (!span.counted && tripsAt120Hz(chargedMs)) {
      span.counted = true;
      this.wouldTrip += 1;
    }
  }

  report(): DetailWatchdogClockReport {
    return {
      spans: this.spans,
      maxChargedMs: this.maxChargedMs,
      maxChargedUpdates: this.maxChargedUpdates,
      maxWallMs: this.maxWallMs,
      wouldTripAt120Hz: this.wouldTrip,
      openChargedMs: this.open ? this.lastChargedMs : null,
    };
  }
}

interface TrackedBuild {
  readonly id: number;
  /** Build ids restart with a new client. */
  readonly client: object | null;
  readonly firstWallMs: number;
  readonly firstUpdate: number;
  /** First seen in an earlier window: its latency includes the other arm's leg. */
  earlier: boolean;
  buildTimeouts: number;
  cancellations: number;
}

/**
 * One runtime's watchdog probe. `beginWindow` starts a stream or a flight leg;
 * `observe` takes one sample per frame, right after `render()`; `report` reads
 * the window. Spans and builds carry over between windows.
 */
export class DetailWatchdogProbe {
  private readonly presentation = new ChargedClock();
  private readonly generation = new ChargedClock();
  private build: TrackedBuild | null = null;
  private client: object | null | undefined = undefined;
  private frames = 0;
  private windowStartMs = 0;
  private lastWallMs = 0;
  private latencyMs: number[] = [];
  private latencyUpdates: number[] = [];
  private notAccepted = 0;
  private lostAtFrames: number[] = [];

  beginWindow(wallMs: number): void {
    this.presentation.beginWindow();
    this.generation.beginWindow();
    if (this.build) this.build.earlier = true;
    this.frames = 0;
    this.windowStartMs = wallMs;
    this.lastWallMs = wallMs;
    this.latencyMs = [];
    this.latencyUpdates = [];
    this.notAccepted = 0;
    this.lostAtFrames = [];
  }

  observe(sample: DetailWatchdogSample): void {
    const frame = this.frames;
    this.frames += 1;
    this.lastWallMs = sample.wallMs;
    // Sampled after the whole render(): of the time since the update, the
    // next update lifts all but the allowance off the marker before it checks.
    const nowMs = sample.lastUpdateMs === null
      ? sample.nowMs
      : Math.min(sample.nowMs, sample.lastUpdateMs + DETAIL_WATCHDOG_UPDATE_GAP_ALLOWANCE_MILLISECONDS);
    const charged = (update: number | null, milliseconds: number | null) => update === null || milliseconds === null
      ? { updates: null, ms: null }
      : { updates: sample.updateSequence - update, ms: Math.max(0, nowMs - milliseconds) };
    const presentation = charged(sample.presentationUpdate, sample.presentationMs);
    this.presentation.observe(
      sample.wallMs,
      presentation.updates,
      presentation.ms,
      (ms) => ms >= DETAIL_WATCHDOG_TRIP_AT_120HZ_MILLISECONDS,
    );
    // As the runtime's generation deadline: the update arm only once the
    // worker has answered, the millisecond arm always.
    const generation = charged(sample.generationUpdate, sample.generationMs);
    this.generation.observe(
      sample.wallMs,
      generation.updates,
      generation.ms,
      (ms) => (sample.generationAnswered && ms >= DETAIL_WATCHDOG_TRIP_AT_120HZ_MILLISECONDS)
        || ms >= DETAIL_WATCHDOG_WALL_DEADLINE_MILLISECONDS,
    );
    this.observeBuild(sample);
    if (this.client !== undefined && this.client !== null && sample.client !== this.client) {
      this.lostAtFrames.push(frame);
    }
    this.client = sample.client;
  }

  private observeBuild(sample: DetailWatchdogSample): void {
    const tracked = this.build;
    if (tracked && (sample.workerBuildId !== tracked.id || sample.client !== tracked.client)) {
      // Accepted: the build left while its worker stayed, and the update that
      // removed it neither timed it out nor cancelled anything.
      const accepted = sample.client !== null
        && sample.client === tracked.client
        && sample.buildTimeouts === tracked.buildTimeouts
        && sample.cancellations === tracked.cancellations;
      if (!accepted) {
        this.notAccepted += 1;
      } else if (!tracked.earlier) {
        this.latencyMs.push(sample.wallMs - tracked.firstWallMs);
        this.latencyUpdates.push(sample.updateSequence - tracked.firstUpdate);
      }
      this.build = null;
    }
    if (sample.workerBuildId !== null) {
      this.build ??= {
        id: sample.workerBuildId,
        client: sample.client,
        firstWallMs: sample.wallMs,
        firstUpdate: sample.updateSequence,
        earlier: false,
        buildTimeouts: sample.buildTimeouts,
        cancellations: sample.cancellations,
      };
      this.build.buildTimeouts = sample.buildTimeouts;
      this.build.cancellations = sample.cancellations;
    }
  }

  report(): DetailWatchdogReport {
    return {
      frames: this.frames,
      wallMs: this.lastWallMs - this.windowStartMs,
      presentation: this.presentation.report(),
      generation: this.generation.report(),
      buildLatencyMs: [...this.latencyMs],
      buildLatencyUpdates: [...this.latencyUpdates],
      buildsNotAccepted: this.notAccepted,
      workerLostAtFrames: [...this.lostAtFrames],
    };
  }
}
