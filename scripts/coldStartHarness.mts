/** Result of giving an already-submitted queue fence a bounded teardown drain. */
export type BoundedFenceDrainResult = "no-fence" | "settled" | "timed-out";
export type BoundedSettlementResult = Exclude<BoundedFenceDrainResult, "no-fence">;

/**
 * Pixel evidence is intentionally permissive about colour and terrain palette.
 * This small threshold only requires distributed lower-frame structure; the
 * terrain-node count below supplies the scene-specific half of the proof.
 */
export const COLD_START_MIN_FOREGROUND_DETAIL_FRACTION = 0.005;

export interface ColdStartFrameCompletenessEvidence {
  /** Failures from the shared whole-frame blank/structure gate. */
  readonly imageContentFailures: readonly string[];
  /** Horizontal detail in the lower outer frame, away from the aircraft. */
  readonly foregroundDetailFraction: number;
  /** `RenderDiagnostics.terrainTiles`: CDLOD nodes drawn by this frame. */
  readonly terrainTiles: number;
}

/**
 * A cold frame is complete only when independent pixel and renderer evidence
 * agree. Pixel statistics reject blank/slate frames but a structured cloud
 * layer can satisfy them; `terrainTiles` prevents that atmosphere-only image
 * from standing in for the scene the cold-start shot is supposed to render.
 */
export function coldStartFrameCompletenessFailures(
  evidence: ColdStartFrameCompletenessEvidence,
): string[] {
  const failures = [...evidence.imageContentFailures];
  if (!Number.isSafeInteger(evidence.terrainTiles) || evidence.terrainTiles <= 0) {
    failures.push(
      `terrain draw count ${String(evidence.terrainTiles)} does not contain a CDLOD terrain node`,
    );
  }
  if (!Number.isFinite(evidence.foregroundDetailFraction)
    || evidence.foregroundDetailFraction <= COLD_START_MIN_FOREGROUND_DETAIL_FRACTION) {
    failures.push(
      `lower-frame detail fraction ${String(evidence.foregroundDetailFraction)} is not above `
      + COLD_START_MIN_FOREGROUND_DETAIL_FRACTION,
    );
  }
  return failures;
}

/** Observe either settlement edge without allowing an already-failed cleanup to hang. */
export async function settleWithin(
  promise: Promise<unknown>,
  timeoutMilliseconds: number,
): Promise<BoundedSettlementResult> {
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds < 0) {
    throw new RangeError("Settlement timeout must be finite and non-negative");
  }
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      new Promise<"timed-out">((resolve) => {
        timeout = setTimeout(() => resolve("timed-out"), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

/**
 * Keep a teardown's error observers alive while an outstanding queue fence gets
 * a bounded chance to settle, then yield one task for asynchronous error
 * delivery. Fence rejection is deliberately consumed: the caller is already
 * handling the primary timeout failure, and this helper owns only cleanup.
 */
export async function drainFenceAndErrorDeliveryTurn(
  fence: Promise<void> | null,
  timeoutMilliseconds: number,
): Promise<BoundedFenceDrainResult> {
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds < 0) {
    throw new RangeError("Fence drain timeout must be finite and non-negative");
  }

  let result: BoundedFenceDrainResult = "no-fence";
  if (fence !== null) {
    result = await settleWithin(fence, timeoutMilliseconds);
  }

  await new Promise((resolve) => setTimeout(resolve, 0));
  return result;
}
