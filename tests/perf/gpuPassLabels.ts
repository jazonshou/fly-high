/**
 * One naming rule for GPU passes, shared by the work counters
 * (`gpuWorkCounters.ts`) and the pass timing (`gpuPassTiming.ts`) so a pass's
 * draws and its milliseconds land under the same key.
 *
 * WebGPU only knows the label a pass was begun with. Babylon's are
 * `[frameId|n] - <render target> - RenderPass`, its compute passes have none,
 * and the render target of the main scene is whichever post-process created
 * it (`PostProcessRTT-bloom-bright`), which says nothing about what drew into
 * it. A harness that can see more — the renderer's frame-graph pass that is
 * executing, the Babylon compute shader that is dispatching — installs a
 * decorator here, and every pass is keyed by what it actually is.
 */

export type GpuPassKind = "render" | "compute";

/** Rewrites a pass's stable label at the moment the pass begins. */
export type GpuPassLabelDecorator = (label: string, kind: GpuPassKind) => string;

const DECORATOR_KEY = "__flyHighGpuPassLabelDecorator";

/**
 * Drops Babylon's per-frame `[frameId|n] - ` prefix and its ` - RenderPass`
 * suffix, so a pass keeps one key across frames. Unlabelled passes are keyed
 * by kind alone, never by their position in the frame: that would turn a
 * reordering into a pass-count change.
 */
export function stablePassLabel(label: string | undefined, kind: GpuPassKind): string {
  const trimmed = String(label ?? "")
    .replace(/^\[[^\]]*\]\s*-\s*/u, "")
    .replace(/\s*-\s*RenderPass$/u, "")
    .trim();
  return trimmed === "" ? `(unlabelled ${kind} pass)` : trimmed;
}

export function setGpuPassLabelDecorator(decorator: GpuPassLabelDecorator | null): void {
  (globalThis as unknown as Record<string, GpuPassLabelDecorator | null>)[DECORATOR_KEY] = decorator;
}

/** The key a pass is recorded under: the stable label, decorated if a harness asked. */
export function gpuPassKey(label: string | undefined, kind: GpuPassKind): string {
  const stable = stablePassLabel(label, kind);
  const decorator = (globalThis as unknown as Record<string, GpuPassLabelDecorator | null | undefined>)[
    DECORATOR_KEY
  ];
  return decorator ? decorator(stable, kind) : stable;
}
