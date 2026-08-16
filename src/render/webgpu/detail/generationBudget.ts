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
