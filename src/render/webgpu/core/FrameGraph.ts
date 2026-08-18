export type FrameGraphPhase =
  | "simulation"
  | "visibility"
  | "shadows"
  | "opaque"
  | "atmosphere"
  | "water"
  | "volumetrics"
  | "post";

export interface FrameGraphFrame {
  readonly frameIndex: number;
  readonly timeSeconds: number;
  readonly deltaSeconds: number;
  readonly cameraCut: boolean;
  readonly originShifted: boolean;
}

export interface FrameGraphPassContext extends FrameGraphFrame {
  /** Returns true when a lower-frequency pass is scheduled for this frame. */
  runsEvery(interval: number): boolean;
}

export interface FrameGraphPass {
  readonly name: string;
  readonly phase: FrameGraphPhase;
  readonly after?: readonly string[];
  /** One means every frame, two every other frame, and so on. */
  readonly cadence?: number;
  readonly enabled?: () => boolean;
  /** Encode/dispatch this pass without waiting for GPU completion. */
  execute(context: FrameGraphPassContext): void;
  invalidateHistory?(reason: string): void;
  dispose?(): void;
}

export interface FrameGraphPassTiming {
  readonly name: string;
  readonly phase: FrameGraphPhase;
  readonly cpuMilliseconds: number;
  readonly ran: boolean;
}

const PHASE_ORDER: Readonly<Record<FrameGraphPhase, number>> = {
  simulation: 0,
  visibility: 1,
  shadows: 2,
  opaque: 3,
  atmosphere: 4,
  water: 5,
  volumetrics: 6,
  post: 7,
};

function assertCadence(value: number | undefined, passName: string): number {
  const cadence = value ?? 1;
  if (!Number.isInteger(cadence) || cadence < 1) {
    throw new RangeError(`Frame-graph pass ${passName} has an invalid cadence`);
  }
  return cadence;
}

/**
 * Small deterministic scheduler around the renderer's GPU passes.
 *
 * Babylon owns command encoding and GPU resource transitions. This graph owns
 * the higher-level dependency contract, update cadence, history invalidation,
 * diagnostics, and deterministic pass ordering used by the simulator.
 */
export class WebGpuFrameGraph {
  private readonly passes = new Map<string, FrameGraphPass>();
  /** Diagnostic overrides (budget probe); a disabled pass never executes. */
  private readonly disabledOverrides = new Set<string>();
  private ordered: FrameGraphPass[] = [];
  private dirty = false;
  private disposed = false;
  private timings: FrameGraphPassTiming[] = [];

  register(pass: FrameGraphPass): () => void {
    if (this.disposed) throw new Error("Cannot register a pass on a disposed frame graph");
    if (!pass.name.trim()) throw new Error("Frame-graph passes require a non-empty name");
    if (this.passes.has(pass.name)) {
      throw new Error(`Frame-graph pass ${pass.name} is already registered`);
    }
    assertCadence(pass.cadence, pass.name);
    this.passes.set(pass.name, pass);
    this.dirty = true;
    return () => this.unregister(pass.name);
  }

  unregister(name: string): void {
    const pass = this.passes.get(name);
    if (!pass) return;
    this.passes.delete(name);
    pass.dispose?.();
    this.dirty = true;
  }

  get passTimings(): readonly FrameGraphPassTiming[] {
    return this.timings;
  }

  get passNames(): readonly string[] {
    this.compileIfNeeded();
    return this.ordered.map((pass) => pass.name);
  }

  /**
   * Diagnostic pass toggle used by the budget probe (1A-1). Overrides the
   * pass's own `enabled` predicate; never persisted, never used during
   * normal play.
   */
  setPassDisabled(name: string, disabled: boolean): void {
    if (disabled) this.disabledOverrides.add(name);
    else this.disabledOverrides.delete(name);
  }

  clearDisabledPasses(): void {
    this.disabledOverrides.clear();
  }

  execute(frame: FrameGraphFrame): void {
    if (this.disposed) return;
    this.compileIfNeeded();
    const timings: FrameGraphPassTiming[] = [];
    for (const pass of this.ordered) {
      const cadence = assertCadence(pass.cadence, pass.name);
      const shouldRun = !this.disabledOverrides.has(pass.name)
        && (pass.enabled?.() ?? true)
        && frame.frameIndex % cadence === 0;
      if (!shouldRun) {
        timings.push({ name: pass.name, phase: pass.phase, cpuMilliseconds: 0, ran: false });
        continue;
      }
      const started = performance.now();
      pass.execute({
        ...frame,
        runsEvery: (interval) => {
          if (!Number.isInteger(interval) || interval < 1) {
            throw new RangeError("Frame-graph intervals must be positive integers");
          }
          return frame.frameIndex % interval === 0;
        },
      });
      timings.push({
        name: pass.name,
        phase: pass.phase,
        cpuMilliseconds: performance.now() - started,
        ran: true,
      });
    }
    this.timings = timings;
  }

  invalidateHistory(reason: string): void {
    if (this.disposed) return;
    for (const pass of this.passes.values()) pass.invalidateHistory?.(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pass of this.passes.values()) pass.dispose?.();
    this.passes.clear();
    this.ordered = [];
    this.timings = [];
  }

  private compileIfNeeded(): void {
    if (!this.dirty) return;
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const result: FrameGraphPass[] = [];

    const visit = (pass: FrameGraphPass): void => {
      if (visited.has(pass.name)) return;
      if (visiting.has(pass.name)) {
        throw new Error(`Frame-graph dependency cycle contains ${pass.name}`);
      }
      visiting.add(pass.name);
      for (const dependencyName of pass.after ?? []) {
        const dependency = this.passes.get(dependencyName);
        if (!dependency) {
          throw new Error(`Frame-graph pass ${pass.name} depends on missing pass ${dependencyName}`);
        }
        if (PHASE_ORDER[dependency.phase] > PHASE_ORDER[pass.phase]) {
          throw new Error(
            `Frame-graph pass ${pass.name} cannot depend on later phase ${dependency.phase}`,
          );
        }
        visit(dependency);
      }
      visiting.delete(pass.name);
      visited.add(pass.name);
      result.push(pass);
    };

    const stable = [...this.passes.values()].sort((a, b) => {
      const phase = PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase];
      return phase || a.name.localeCompare(b.name);
    });
    for (const pass of stable) visit(pass);
    this.ordered = result;
    this.dirty = false;
  }
}

export interface PassTimingPercentiles {
  readonly name: string;
  readonly phase: FrameGraphPhase;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly lastMs: number;
}

/**
 * Ring-buffered per-pass CPU timing percentiles (1A-1a). The frame graph has
 * measured pass CPU time since it was written and thrown the numbers away
 * every frame; this is the retention half. Skipped-cadence frames record 0 —
 * the percentiles then describe the pass's amortised per-frame cost, which is
 * what Governor B and the HUD need.
 */
export class PassTimingHistory {
  private readonly samples = new Map<string, {
    phase: FrameGraphPhase;
    values: number[];
    cursor: number;
    lastMs: number;
  }>();

  constructor(private readonly windowSize = 240) {
    if (!Number.isInteger(windowSize) || windowSize < 2) {
      throw new RangeError("Pass timing window must be an integer of at least 2");
    }
  }

  record(timings: readonly FrameGraphPassTiming[]): void {
    for (const timing of timings) {
      let entry = this.samples.get(timing.name);
      if (!entry) {
        entry = { phase: timing.phase, values: [], cursor: 0, lastMs: 0 };
        this.samples.set(timing.name, entry);
      }
      if (entry.values.length < this.windowSize) {
        entry.values.push(timing.cpuMilliseconds);
      } else {
        entry.values[entry.cursor] = timing.cpuMilliseconds;
        entry.cursor = (entry.cursor + 1) % this.windowSize;
      }
      entry.lastMs = timing.cpuMilliseconds;
    }
  }

  percentiles(): readonly PassTimingPercentiles[] {
    const result: PassTimingPercentiles[] = [];
    for (const [name, entry] of this.samples) {
      if (entry.values.length === 0) continue;
      const sorted = [...entry.values].sort((a, b) => a - b);
      const rank = (fraction: number) =>
        sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
      result.push({
        name,
        phase: entry.phase,
        p50Ms: rank(0.5),
        p95Ms: rank(0.95),
        lastMs: entry.lastMs,
      });
    }
    return result;
  }

  /** Heaviest passes by p95, for the HUD's `topPassesByCpuMs` row. */
  topByP95(count: number): readonly PassTimingPercentiles[] {
    return [...this.percentiles()]
      .sort((first, second) => second.p95Ms - first.p95Ms)
      .slice(0, Math.max(0, count));
  }

  reset(): void {
    this.samples.clear();
  }
}

export interface BudgetProbeRow {
  readonly pass: string;
  /** Whole-frame GPU p95 with the pass enabled minus with it disabled. */
  readonly gpuP95DeltaMs: number | null;
}

/**
 * The budget probe (1A-1b). Babylon exposes only whole-frame GPU time, so
 * per-pass GPU attribution cycles each pass off for a stage of frames and
 * charges it the p95 delta against the all-on baseline. Pure state machine:
 * the renderer feeds one GPU frame time per frame and applies
 * `currentlyDisabled` to the frame graph. HUD-triggered, never during normal
 * play.
 */
export class FrameGraphBudgetProbe {
  private readonly gpuSamples: number[] = [];
  private readonly deltas = new Map<string, number | null>();
  private stage = -1;
  private baselineP95: number | null = null;
  private frames = 0;
  private finished = false;

  constructor(
    private readonly probePasses: readonly string[],
    private readonly framesPerStage = 120,
  ) {
    if (probePasses.length === 0) {
      throw new RangeError("Budget probe needs at least one pass to cycle");
    }
    if (!Number.isInteger(framesPerStage) || framesPerStage < 8) {
      throw new RangeError("Budget probe stages need at least 8 frames");
    }
  }

  /** Pass to disable this frame; null during the baseline stage or when done. */
  get currentlyDisabled(): string | null {
    if (this.finished || this.stage < 0) return null;
    return this.probePasses[this.stage] ?? null;
  }

  get running(): boolean {
    return !this.finished;
  }

  get report(): readonly BudgetProbeRow[] | null {
    if (!this.finished) return null;
    return this.probePasses.map((pass) => ({
      pass,
      gpuP95DeltaMs: this.deltas.get(pass) ?? null,
    }));
  }

  /** Record one frame's whole-frame GPU time and advance the stage clock. */
  recordFrame(gpuFrameMs: number | null): void {
    if (this.finished) return;
    if (gpuFrameMs !== null && Number.isFinite(gpuFrameMs) && gpuFrameMs > 0) {
      this.gpuSamples.push(gpuFrameMs);
    }
    this.frames += 1;
    if (this.frames < this.framesPerStage) return;
    this.completeStage();
  }

  private completeStage(): void {
    const sorted = [...this.gpuSamples].sort((a, b) => a - b);
    const p95 = sorted.length >= 8
      ? sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null
      : null;
    if (this.stage === -1) {
      this.baselineP95 = p95;
    } else {
      const pass = this.probePasses[this.stage]!;
      this.deltas.set(
        pass,
        this.baselineP95 !== null && p95 !== null ? this.baselineP95 - p95 : null,
      );
    }
    this.gpuSamples.length = 0;
    this.frames = 0;
    this.stage += 1;
    if (this.stage >= this.probePasses.length) this.finished = true;
  }
}
