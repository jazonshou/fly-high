import { isWorldPageKey, type WorldPageKey } from "./pageKey";
import {
  getWorldPageStoredDimensions,
  WORLD_PAGE_MATERIAL_CHANNELS,
  WORLD_PAGE_SCHEMA_VERSION,
  type WorldPageLayout,
  type WorldPagePayload,
} from "./payload";

export interface WorldPageValidationIssue {
  readonly path: string;
  readonly code:
    | "invalid-type"
    | "invalid-value"
    | "invalid-length"
    | "invalid-format"
    | "revision-mismatch"
    | "key-mismatch";
  readonly message: string;
}

export interface WorldPageValidationExpectations {
  readonly key?: WorldPageKey;
  readonly contentRevision?: string;
  readonly extentMeters?: number;
}

export class WorldPageValidationError extends Error {
  constructor(readonly issues: readonly WorldPageValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "WorldPageValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isPowerOfTwo(value: number): boolean {
  if (!Number.isSafeInteger(value) || value < 1) return false;
  const exponent = Math.log2(value);
  return Number.isInteger(exponent);
}

function addIssue(
  issues: WorldPageValidationIssue[],
  path: string,
  code: WorldPageValidationIssue["code"],
  message: string,
): void {
  issues.push({ path, code, message });
}

function requireFiniteNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: WorldPageValidationIssue[],
  minimum = Number.NEGATIVE_INFINITY,
): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    addIssue(issues, `${path}.${key}`, "invalid-type", "must be a finite number");
    return null;
  }
  if (value < minimum) {
    addIssue(issues, `${path}.${key}`, "invalid-value", `must be at least ${minimum}`);
    return null;
  }
  return value;
}

function requireTypedArray<T extends ArrayBufferView & { readonly length: number }>(
  record: Record<string, unknown>,
  key: string,
  constructor: { new (...args: never[]): T },
  expectedLength: number,
  path: string,
  issues: WorldPageValidationIssue[],
): T | null {
  const value = record[key];
  if (!(value instanceof constructor)) {
    addIssue(issues, `${path}.${key}`, "invalid-type", `must be a ${constructor.name}`);
    return null;
  }
  if (value.length !== expectedLength) {
    addIssue(
      issues,
      `${path}.${key}`,
      "invalid-length",
      `must contain exactly ${expectedLength} entries`,
    );
    return null;
  }
  return value;
}

export function validateWorldPageLayout(value: unknown): readonly WorldPageValidationIssue[] {
  const issues: WorldPageValidationIssue[] = [];
  if (!isRecord(value)) {
    addIssue(issues, "layout", "invalid-type", "must be an object");
    return issues;
  }

  requireFiniteNumber(value, "extentMeters", "layout", issues, Number.MIN_VALUE);

  const heightResolution = value.heightResolution;
  if (
    typeof heightResolution !== "number" ||
    !Number.isSafeInteger(heightResolution) ||
    heightResolution < 3 ||
    heightResolution > 2_049 ||
    !isPowerOfTwo(heightResolution - 1)
  ) {
    addIssue(
      issues,
      "layout.heightResolution",
      "invalid-value",
      "must be a 2^n + 1 integer between 3 and 2049",
    );
  }

  const surfaceResolution = value.surfaceResolution;
  if (
    typeof surfaceResolution !== "number" ||
    !Number.isSafeInteger(surfaceResolution) ||
    surfaceResolution < 2 ||
    surfaceResolution > 2_048 ||
    !isPowerOfTwo(surfaceResolution)
  ) {
    addIssue(
      issues,
      "layout.surfaceResolution",
      "invalid-value",
      "must be a power-of-two integer between 2 and 2048",
    );
  }

  const gutter = value.gutter;
  if (typeof gutter !== "number" || !Number.isSafeInteger(gutter) || gutter < 1 || gutter > 8) {
    addIssue(issues, "layout.gutter", "invalid-value", "must be an integer between 1 and 8");
  }
  return issues;
}

function validateHeight(
  value: unknown,
  expectedLength: number,
  issues: WorldPageValidationIssue[],
): void {
  const path = "height";
  if (!isRecord(value)) {
    addIssue(issues, path, "invalid-type", "must be an object");
    return;
  }
  if (value.format !== "r16uint-linear") {
    addIssue(issues, `${path}.format`, "invalid-format", "must be r16uint-linear");
  }
  const samples = requireTypedArray(value, "samples", Uint16Array, expectedLength, path, issues);
  const offset = requireFiniteNumber(value, "offsetMeters", path, issues);
  const scale = requireFiniteNumber(value, "metersPerUnit", path, issues, 0);
  const minimum = requireFiniteNumber(value, "minHeightMeters", path, issues);
  const maximum = requireFiniteNumber(value, "maxHeightMeters", path, issues);
  if (minimum !== null && maximum !== null && minimum > maximum) {
    addIssue(issues, path, "invalid-value", "minHeightMeters must not exceed maxHeightMeters");
  }

  if (
    samples &&
    samples.length > 0 &&
    offset !== null &&
    scale !== null &&
    minimum !== null &&
    maximum !== null
  ) {
    let quantizedMin = 65_535;
    let quantizedMax = 0;
    for (const sample of samples) {
      quantizedMin = Math.min(quantizedMin, sample);
      quantizedMax = Math.max(quantizedMax, sample);
    }
    const decodedMin = offset + quantizedMin * scale;
    const decodedMax = offset + quantizedMax * scale;
    const tolerance = Math.max(1e-5, scale * 0.501);
    if (Math.abs(minimum - decodedMin) > tolerance) {
      addIssue(
        issues,
        `${path}.minHeightMeters`,
        "invalid-value",
        "does not match the minimum decoded sample",
      );
    }
    if (Math.abs(maximum - decodedMax) > tolerance) {
      addIssue(
        issues,
        `${path}.maxHeightMeters`,
        "invalid-value",
        "does not match the maximum decoded sample",
      );
    }
  }
}

function validateMaterial(
  value: unknown,
  texelCount: number,
  issues: WorldPageValidationIssue[],
): void {
  const path = "material";
  if (!isRecord(value)) {
    addIssue(issues, path, "invalid-type", "must be an object");
    return;
  }
  if (value.format !== "rgba8unorm-weights") {
    addIssue(issues, `${path}.format`, "invalid-format", "must be rgba8unorm-weights");
  }
  requireTypedArray(
    value,
    "materialIds",
    Uint16Array,
    WORLD_PAGE_MATERIAL_CHANNELS,
    path,
    issues,
  );
  const weights = requireTypedArray(
    value,
    "weights",
    Uint8Array,
    texelCount * WORLD_PAGE_MATERIAL_CHANNELS,
    path,
    issues,
  );
  if (weights) {
    for (let offset = 0; offset < weights.length; offset += WORLD_PAGE_MATERIAL_CHANNELS) {
      const sum =
        (weights[offset] ?? 0) +
        (weights[offset + 1] ?? 0) +
        (weights[offset + 2] ?? 0) +
        (weights[offset + 3] ?? 0);
      if (sum !== 255) {
        addIssue(
          issues,
          `${path}.weights[${offset / WORLD_PAGE_MATERIAL_CHANNELS}]`,
          "invalid-value",
          "RGBA material weights must sum to 255",
        );
        break;
      }
    }
  }
}

function validateSurface(
  value: unknown,
  texelCount: number,
  issues: WorldPageValidationIssue[],
): void {
  const path = "surface";
  if (!isRecord(value)) {
    addIssue(issues, path, "invalid-type", "must be an object");
    return;
  }
  if (value.format !== "rgba8unorm-surface-v1") {
    addIssue(issues, `${path}.format`, "invalid-format", "must be rgba8unorm-surface-v1");
  }
  requireTypedArray(value, "values", Uint8Array, texelCount * 4, path, issues);
  requireTypedArray(value, "biomes", Uint8Array, texelCount, path, issues);
}

function validateHydrology(
  value: unknown,
  texelCount: number,
  issues: WorldPageValidationIssue[],
): void {
  const path = "hydrology";
  if (!isRecord(value)) {
    addIssue(issues, path, "invalid-type", "must be an object");
    return;
  }
  if (value.format !== "rg16snorm-flow+r16uint-depth+r16sint-shore+r16uint-discharge") {
    addIssue(issues, `${path}.format`, "invalid-format", "has an unsupported hydrology packing");
  }
  requireTypedArray(value, "flowXZ", Int16Array, texelCount * 2, path, issues);
  requireTypedArray(value, "waterDepth", Uint16Array, texelCount, path, issues);
  requireTypedArray(value, "shoreDistance", Int16Array, texelCount, path, issues);
  requireTypedArray(value, "discharge", Uint16Array, texelCount, path, issues);
  requireFiniteNumber(value, "depthMetersPerUnit", path, issues, 0);
  requireFiniteNumber(value, "shoreDistanceMetersPerUnit", path, issues, Number.MIN_VALUE);
  requireFiniteNumber(value, "dischargeLog2Bias", path, issues);
  requireFiniteNumber(value, "dischargeLog2PerUnit", path, issues, 0);
}

/** Deep runtime validation intended for worker, network, and persistent-cache boundaries. */
export function validateWorldPagePayload(
  value: unknown,
  expectations: WorldPageValidationExpectations = {},
): readonly WorldPageValidationIssue[] {
  const issues: WorldPageValidationIssue[] = [];
  if (!isRecord(value)) {
    addIssue(issues, "payload", "invalid-type", "must be an object");
    return issues;
  }

  if (value.schemaVersion !== WORLD_PAGE_SCHEMA_VERSION) {
    addIssue(
      issues,
      "schemaVersion",
      "revision-mismatch",
      `must equal ${WORLD_PAGE_SCHEMA_VERSION}`,
    );
  }
  if (!isWorldPageKey(value.key)) {
    addIssue(issues, "key", "invalid-value", "must be a canonical world page key");
  } else if (expectations.key !== undefined && value.key !== expectations.key) {
    addIssue(issues, "key", "key-mismatch", `must equal ${expectations.key}`);
  }
  if (typeof value.contentRevision !== "string" || value.contentRevision.length === 0) {
    addIssue(issues, "contentRevision", "invalid-value", "must be a non-empty string");
  } else if (
    expectations.contentRevision !== undefined &&
    value.contentRevision !== expectations.contentRevision
  ) {
    addIssue(
      issues,
      "contentRevision",
      "revision-mismatch",
      `must equal ${expectations.contentRevision}`,
    );
  }

  const layoutIssues = validateWorldPageLayout(value.layout);
  issues.push(...layoutIssues);
  if (!isRecord(value.layout) || layoutIssues.length > 0) return issues;
  const layout = value.layout as unknown as WorldPageLayout;
  if (
    expectations.extentMeters !== undefined &&
    layout.extentMeters !== expectations.extentMeters
  ) {
    addIssue(
      issues,
      "layout.extentMeters",
      "invalid-value",
      `must equal ${expectations.extentMeters}`,
    );
  }

  const dimensions = getWorldPageStoredDimensions(layout);
  validateHeight(value.height, dimensions.heightSampleCount, issues);
  validateMaterial(value.material, dimensions.surfaceTexelCount, issues);
  validateSurface(value.surface, dimensions.surfaceTexelCount, issues);
  validateHydrology(value.hydrology, dimensions.surfaceTexelCount, issues);
  return issues;
}

export function isWorldPagePayload(value: unknown): value is WorldPagePayload {
  return validateWorldPagePayload(value).length === 0;
}

export function assertValidWorldPagePayload(
  value: unknown,
  expectations: WorldPageValidationExpectations = {},
): asserts value is WorldPagePayload {
  const issues = validateWorldPagePayload(value, expectations);
  if (issues.length > 0) throw new WorldPageValidationError(issues);
}
