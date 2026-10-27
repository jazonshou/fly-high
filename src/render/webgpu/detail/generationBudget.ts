import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";

export interface DetailGenerationBudget {
  /** Hard safety cap even when generation is exceptionally cheap. */
  readonly maximumCells: number;
  /** Cooperative CPU time slice for one runtime update. */
  readonly maximumMilliseconds: number;
}

/**
 * Keeps detail streaming work below a small CPU slice while retaining the
 * existing density-dependent cell caps as a second line of defence.
 */
export function resolveDetailGenerationBudget(
  profile: Pick<WebGpuQualityProfile, "vegetationDensity">,
): DetailGenerationBudget {
  if (profile.vegetationDensity <= 0.5) {
    return { maximumCells: 8, maximumMilliseconds: 0.75 };
  }
  if (profile.vegetationDensity <= 0.8) {
    return { maximumCells: 16, maximumMilliseconds: 1.25 };
  }
  return { maximumCells: 24, maximumMilliseconds: 2 };
}

/**
 * The first pending cell is always admitted so streaming cannot starve when a
 * single procedurally dense cell takes longer than the target time slice.
 */
export function canGenerateNextDetailCell(
  generatedCells: number,
  elapsedMilliseconds: number,
  budget: DetailGenerationBudget,
): boolean {
  if (!Number.isInteger(generatedCells) || generatedCells < 0) {
    throw new RangeError("Generated detail-cell count must be a non-negative integer");
  }
  if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0) {
    throw new RangeError("Detail generation elapsed time must be finite and non-negative");
  }
  if (!Number.isInteger(budget.maximumCells) || budget.maximumCells < 1) {
    throw new RangeError("Detail generation cell budget must be a positive integer");
  }
  if (!Number.isFinite(budget.maximumMilliseconds) || budget.maximumMilliseconds <= 0) {
    throw new RangeError("Detail generation time budget must be finite and positive");
  }
  return (
    generatedCells < budget.maximumCells
    && (generatedCells === 0 || elapsedMilliseconds < budget.maximumMilliseconds)
  );
}

/**
 * Inline generation's pace after a worker failure: a credit in milliseconds
 * and a running average of what one inline cell costs.
 */
export interface InlineCellCredit {
  creditMilliseconds: number;
  averageCellMilliseconds: number;
}

/** How fast the average follows a new cell's cost. */
const INLINE_CELL_AVERAGE_WEIGHT = 0.2;
/** Credit saved up while idle, in average cells (or time slices). */
const INLINE_CELL_CREDIT_CAP = 4;

export function createInlineCellCredit(budget: DetailGenerationBudget): InlineCellCredit {
  return { creditMilliseconds: 0, averageCellMilliseconds: budget.maximumMilliseconds };
}

/**
 * Once per update, after the worker has failed: earns one time slice of
 * credit and says whether this update may start a cell. The first cell of an
 * update is no longer free — it waits until the credit covers an average
 * cell, and `recordInlineCellAfterWorkerFailure` charges what it really took.
 *
 * **This bounds the AVERAGE main-thread time per update, not any one
 * update:** a cell is still one task, so a 150 ms cell is still a 150 ms
 * frame, just no longer every frame. A runtime that never had a worker keeps
 * `canGenerateNextDetailCell` alone.
 */
export function admitInlineCellAfterWorkerFailure(
  state: InlineCellCredit,
  budget: DetailGenerationBudget,
): boolean {
  if (!Number.isFinite(budget.maximumMilliseconds) || budget.maximumMilliseconds <= 0) {
    throw new RangeError("Detail generation time budget must be finite and positive");
  }
  state.creditMilliseconds = Math.min(
    state.creditMilliseconds + budget.maximumMilliseconds,
    INLINE_CELL_CREDIT_CAP * Math.max(state.averageCellMilliseconds, budget.maximumMilliseconds),
  );
  return state.creditMilliseconds >= state.averageCellMilliseconds;
}

/** Charges one inline cell's measured cost and folds it into the average. */
export function recordInlineCellAfterWorkerFailure(
  state: InlineCellCredit,
  cellMilliseconds: number,
): void {
  const cost = Number.isFinite(cellMilliseconds) ? Math.max(0, cellMilliseconds) : 0;
  state.creditMilliseconds -= cost;
  state.averageCellMilliseconds += INLINE_CELL_AVERAGE_WEIGHT * (cost - state.averageCellMilliseconds);
}
