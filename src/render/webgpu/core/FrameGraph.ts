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

  execute(frame: FrameGraphFrame): void {
    if (this.disposed) return;
    this.compileIfNeeded();
    const timings: FrameGraphPassTiming[] = [];
    for (const pass of this.ordered) {
      const cadence = assertCadence(pass.cadence, pass.name);
      const shouldRun = (pass.enabled?.() ?? true) && frame.frameIndex % cadence === 0;
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
