import { resolveHardwareScalingLevel } from "@/src/render/renderScaleLevel";
import {
  CPU_WORK_MAX_LEVEL,
  GPU_WORK_MAX_LEVEL,
  resolveSignals,
  type GovernorConfig,
  type GovernorSignals,
  type GovernorState,
} from "@/src/render/webgpu/core/AdaptiveGovernor";
import type {
  BenchGovernorDecision,
  BenchGovernorEvents,
  BenchGovernorSnapshot,
  BenchGovernorSummary,
  BenchGovernorWindow,
  BenchSignalClass,
  BenchWindowSpec,
} from "./types";

/**
 * What the governor did during a step, from one read-only probe per frame.
 *
 * The renderer keeps no decision log, but it replaces `lastSignals` with a
 * new object on every decision and never otherwise, so a changed reference is
 * exactly one decision (R4). Each is classified with the governor's own
 * `resolveSignals`, so the report says why it moved, not just that it did.
 *
 * Shares are frame-weighted and come from the pixels the engine actually
 * rendered, not the governor's target scale: when the tier's pixel cap
 * absorbs a step the renderer still records the new scale as applied though
 * nothing changed, and a scale-based "at the floor" would read 100% on a
 * large display (critique S2). Allocates only on a decision.
 */

/** The probe fields the trace reads; `RendererBenchProbe` satisfies it. */
export interface GovernorObservation {
  readonly governorState: GovernorState;
  /** A new object on each decision. */
  readonly governorSignals: GovernorSignals;
  readonly governorConfig: GovernorConfig;
  readonly appliedRenderScale: number;
  /** The engine's render size this frame. */
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly pinned: boolean;
}

/** What sets the rendered size besides the scale. */
export interface ScaleContext {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly devicePixelRatio: number;
  readonly maxDevicePixelRatio: number;
  readonly maxRenderPixels: number;
}

/** Pixels the renderer rasterises at `scale` (renderScaleLevel.ts's rule). */
export function pixelsAtScale(scale: number, context: ScaleContext): number {
  const level = resolveHardwareScalingLevel({ ...context, renderScale: scale });
  return (Math.max(1, context.cssWidth * context.cssHeight)) / (level * level);
}

/** The governor's reading of one window's signals. */
export function classifySignals(
  signals: GovernorSignals,
  config: Pick<GovernorConfig, "gpuTargetMs" | "presentationTargetMs">,
): { readonly signalClass: BenchSignalClass; readonly proxyMs: number | null } {
  const resolved = resolveSignals(signals, config.gpuTargetMs, config.presentationTargetMs);
  return {
    signalClass: resolved.classification,
    proxyMs: resolved.synthesised ? resolved.gpuMs : null,
  };
}

/** Rendered pixels within this fraction count as the same size. */
const PIXEL_TOLERANCE = 0.01;
const DEFAULT_MAX_DECISIONS = 128;

interface MutableEvents {
  scaleDown: number;
  scaleUp: number;
  cpuShed: number;
  cpuRecover: number;
  gpuShed: number;
  gpuRecover: number;
  insensitiveLatched: number;
}

interface Bucket {
  readonly startS: number;
  readonly endS: number;
  frames: number;
  decisions: number;
  readonly events: MutableEvents;
  atFloor: number;
  belowCeiling: number;
  cpuShed: number;
  gpuShed: number;
  cpuAtMax: number;
  gpuAtMax: number;
  scaleStepFrames: number;
  readonly modes: Map<string, number>;
  readonly classes: Map<string, number>;
}

interface MutableSnapshot {
  set: boolean;
  mode: BenchGovernorSnapshot["mode"];
  targetScale: number;
  appliedScale: number;
  renderPixels: number;
  cpuLevel: number;
  gpuLevel: number;
  lever: string | null;
  insensitive: boolean;
}

function bucket(startS: number, endS: number): Bucket {
  return {
    startS,
    endS,
    frames: 0,
    decisions: 0,
    events: { scaleDown: 0, scaleUp: 0, cpuShed: 0, cpuRecover: 0, gpuShed: 0, gpuRecover: 0, insensitiveLatched: 0 },
    atFloor: 0,
    belowCeiling: 0,
    cpuShed: 0,
    gpuShed: 0,
    cpuAtMax: 0,
    gpuAtMax: 0,
    scaleStepFrames: 0,
    modes: new Map(),
    classes: new Map(),
  };
}

function snapshotSlot(): MutableSnapshot {
  return {
    set: false,
    mode: "balanced",
    targetScale: 0,
    appliedScale: 0,
    renderPixels: 0,
    cpuLevel: 0,
    gpuLevel: 0,
    lever: null,
    insensitive: false,
  };
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function shares(map: ReadonlyMap<string, number>, frames: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, count] of [...map].sort(([a], [b]) => a.localeCompare(b))) out[key] = count / frames;
  return out;
}

export interface GovernorTraceOptions {
  /** The flight's windows; frames outside them still count toward the whole flight. */
  readonly windows: { readonly ground: BenchWindowSpec; readonly air: BenchWindowSpec };
  readonly flightS: number;
  readonly scale: ScaleContext;
  readonly maxDecisions?: number;
}

export class GovernorTrace {
  private readonly flight: Bucket;
  private readonly ground: Bucket;
  private readonly air: Bucket;
  /** The three above, for the per-frame loop: built once, so a frame allocates nothing. */
  private readonly buckets: readonly Bucket[];
  private readonly maxDecisions: number;
  private readonly decisions: BenchGovernorDecision[] = [];
  private decisionsTruncated = false;
  private decisionsDuringSettle = 0;
  private config: GovernorConfig | null = null;
  private pinned = false;
  private floorPixels = 0;
  private ceilingPixels = 0;
  private leverAvailable = false;
  private lastSignals: GovernorSignals | null = null;
  private lastState: GovernorState | null = null;
  private lastPixels: number | null = null;
  private lastClass: BenchSignalClass = "unknown";
  private readonly atSettleEnd = snapshotSlot();
  private readonly atFlightStart = snapshotSlot();
  private readonly atEnd = snapshotSlot();

  constructor(private readonly options: GovernorTraceOptions) {
    this.flight = bucket(0, options.flightS);
    this.ground = bucket(options.windows.ground.startS, options.windows.ground.endS);
    this.air = bucket(options.windows.air.startS, options.windows.air.endS);
    this.buckets = [this.flight, this.ground, this.air];
    this.maxDecisions = options.maxDecisions ?? DEFAULT_MAX_DECISIONS;
  }

  /** Every frame, after `render()`: `tS` is flight time, negative during the settle. */
  observe(tS: number, probe: GovernorObservation): void {
    if (this.config === null) this.start(probe);
    const state = probe.governorState;
    const pixels = probe.renderWidth * probe.renderHeight;
    const scaleStep = this.lastPixels !== null && pixels !== this.lastPixels;
    this.lastPixels = pixels;

    const decided = this.lastSignals !== null && probe.governorSignals !== this.lastSignals;
    this.lastSignals = probe.governorSignals;
    if (decided) this.decide(tS, probe, pixels);
    this.lastState = state;

    const slot = tS < 0 ? this.atSettleEnd : this.atEnd;
    this.write(slot, probe, pixels);
    if (tS >= 0 && !this.atFlightStart.set) this.write(this.atFlightStart, probe, pixels);
    if (tS < 0 || tS >= this.options.flightS) return;
    for (const target of this.buckets) {
      if (tS < target.startS || tS >= target.endS) continue;
      target.frames += 1;
      if (scaleStep) target.scaleStepFrames += 1;
      if (this.leverAvailable && pixels <= this.floorPixels * (1 + PIXEL_TOLERANCE)) target.atFloor += 1;
      if (this.leverAvailable && pixels < this.ceilingPixels * (1 - PIXEL_TOLERANCE)) target.belowCeiling += 1;
      if (state.cpuWorkLevel > 0) target.cpuShed += 1;
      if (state.gpuWorkLevel > 0) target.gpuShed += 1;
      if (state.cpuWorkLevel >= CPU_WORK_MAX_LEVEL) target.cpuAtMax += 1;
      if (state.gpuWorkLevel >= GPU_WORK_MAX_LEVEL) target.gpuAtMax += 1;
      increment(target.modes, probe.pinned ? "pinned" : state.mode);
      increment(target.classes, this.lastClass);
    }
  }

  /**
   * The flight's first frame: the settle's decisions were timed by a clock
   * that reads below zero (the flight's start was not yet known), and
   * `offsetS` moves them to count back from that frame, as the log says.
   */
  rebaseSettle(offsetS: number): void {
    for (let index = 0; index < this.decisions.length; index += 1) {
      const [tS, ...rest] = this.decisions[index]!;
      if (tS >= 0) continue;
      // Still below zero, so the settle's decisions stay the settle's.
      this.decisions[index] = Object.freeze([Math.min(-1e-3, tS + offsetS), ...rest] as const);
    }
  }

  summary(): BenchGovernorSummary {
    return {
      pinned: this.pinned,
      config: this.config,
      scaleLeverAvailable: this.leverAvailable,
      floorPixels: this.floorPixels,
      ceilingPixels: this.ceilingPixels,
      atSettleEnd: frozenSnapshot(this.atSettleEnd),
      atFlightStart: frozenSnapshot(this.atFlightStart),
      atEnd: frozenSnapshot(this.atEnd),
      decisionsDuringSettle: this.decisionsDuringSettle,
      decisions: [...this.decisions],
      decisionsTruncated: this.decisionsTruncated,
      flight: this.windowSummary(this.flight),
      windows: { ground: this.windowSummary(this.ground), air: this.windowSummary(this.air) },
    };
  }

  private start(probe: GovernorObservation): void {
    const config = probe.governorConfig;
    this.config = config;
    this.pinned = probe.pinned;
    this.floorPixels = pixelsAtScale(config.scaleFloor, this.options.scale);
    this.ceilingPixels = pixelsAtScale(config.scaleCeiling, this.options.scale);
    // Tier 0 (floor = ceiling), a pixel cap that binds at the floor already,
    // and a pinned renderer all leave the resolution lever nothing to move.
    this.leverAvailable = !probe.pinned
      && this.ceilingPixels > this.floorPixels * (1 + 2 * PIXEL_TOLERANCE);
  }

  private decide(tS: number, probe: GovernorObservation, pixels: number): void {
    const state = probe.governorState;
    const signals = probe.governorSignals;
    const config = this.config ?? probe.governorConfig;
    const { signalClass, proxyMs } = classifySignals(signals, config);
    this.lastClass = signalClass;
    if (this.decisions.length < this.maxDecisions) {
      this.decisions.push(Object.freeze([
        tS,
        state.mode,
        signalClass,
        proxyMs,
        state.renderScale,
        probe.appliedRenderScale,
        pixels,
        state.cpuWorkLevel,
        state.gpuWorkLevel,
        state.lastLever,
        state.resolutionInsensitive,
        signals.gpuP95Ms,
        signals.cpuP95Ms,
        signals.intervalP95Ms,
      ] as const));
    } else {
      this.decisionsTruncated = true;
    }
    if (tS < 0) {
      this.decisionsDuringSettle += 1;
      return;
    }
    const previous = this.lastState;
    for (const target of this.buckets) {
      if (tS < target.startS || tS >= target.endS) continue;
      target.decisions += 1;
      if (previous === null) continue;
      const events = target.events;
      if (state.renderScale < previous.renderScale) events.scaleDown += 1;
      if (state.renderScale > previous.renderScale) events.scaleUp += 1;
      if (state.cpuWorkLevel > previous.cpuWorkLevel) events.cpuShed += 1;
      if (state.cpuWorkLevel < previous.cpuWorkLevel) events.cpuRecover += 1;
      if (state.gpuWorkLevel > previous.gpuWorkLevel) events.gpuShed += 1;
      if (state.gpuWorkLevel < previous.gpuWorkLevel) events.gpuRecover += 1;
      if (state.resolutionInsensitive && !previous.resolutionInsensitive) events.insensitiveLatched += 1;
    }
  }

  private write(slot: MutableSnapshot, probe: GovernorObservation, pixels: number): void {
    const state = probe.governorState;
    slot.set = true;
    slot.mode = probe.pinned ? "pinned" : state.mode;
    slot.targetScale = state.renderScale;
    slot.appliedScale = probe.appliedRenderScale;
    slot.renderPixels = pixels;
    slot.cpuLevel = state.cpuWorkLevel;
    slot.gpuLevel = state.gpuWorkLevel;
    slot.lever = state.lastLever;
    slot.insensitive = state.resolutionInsensitive;
  }

  private windowSummary(target: Bucket): BenchGovernorWindow {
    const frames = target.frames;
    const share = (count: number): number => (frames > 0 ? count / frames : 0);
    const events: BenchGovernorEvents = { ...target.events };
    return {
      frames,
      decisions: target.decisions,
      events,
      share: {
        atScaleFloor: this.leverAvailable ? share(target.atFloor) : null,
        belowCeiling: this.leverAvailable ? share(target.belowCeiling) : null,
        cpuShed: share(target.cpuShed),
        gpuShed: share(target.gpuShed),
        cpuAtMax: share(target.cpuAtMax),
        gpuAtMax: share(target.gpuAtMax),
      },
      modeShare: frames > 0 ? shares(target.modes, frames) : {},
      classShare: frames > 0 ? shares(target.classes, frames) : {},
      scaleStepFrames: target.scaleStepFrames,
    };
  }
}

function frozenSnapshot(slot: MutableSnapshot): BenchGovernorSnapshot | null {
  if (!slot.set) return null;
  return {
    mode: slot.mode,
    targetScale: slot.targetScale,
    appliedScale: slot.appliedScale,
    renderPixels: slot.renderPixels,
    cpuLevel: slot.cpuLevel,
    gpuLevel: slot.gpuLevel,
    lever: slot.lever,
    insensitive: slot.insensitive,
  };
}
