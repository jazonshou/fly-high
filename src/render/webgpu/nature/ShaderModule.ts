/** Shader metadata kept independent of a particular WebGPU engine wrapper. */
export type NatureShaderStage = "compute" | "vertex" | "fragment";

export type NatureBindingKind =
  | "uniform-buffer"
  | "read-only-storage-buffer"
  | "storage-buffer"
  | "sampled-texture"
  | "storage-texture"
  | "sampler";

export type NatureTextureViewDimension = "2d" | "3d";
export type NatureTextureSampleType = "float" | "unfilterable-float" | "depth";
export type NatureStorageTextureFormat = "r32float" | "rgba16float" | "rgba32float";
export type NatureSamplerType = "filtering" | "non-filtering" | "comparison";

export interface NatureShaderBinding {
  readonly group: number;
  readonly binding: number;
  readonly name: string;
  readonly kind: NatureBindingKind;
  readonly viewDimension?: NatureTextureViewDimension;
  readonly sampleType?: NatureTextureSampleType;
  readonly storageFormat?: NatureStorageTextureFormat;
  readonly samplerType?: NatureSamplerType;
}

export interface NatureShaderEntryPoint {
  readonly name: string;
  readonly stage: NatureShaderStage;
  /** Compute workgroup dimensions. Omitted for vertex and fragment stages. */
  readonly workgroupSize?: readonly [number, number, number];
}

/**
 * A complete WGSL module plus enough declarative information for a render graph
 * to create layouts and dispatch it without parsing the source.
 */
export interface NatureShaderModule {
  readonly label: string;
  readonly code: string;
  readonly entryPoints: readonly NatureShaderEntryPoint[];
  readonly bindings: readonly NatureShaderBinding[];
}

export interface PortableBindGroupLayoutEntry {
  readonly binding: number;
  /** Numeric values intentionally match GPUShaderStage: vertex=1, fragment=2, compute=4. */
  readonly visibility: number;
  readonly buffer?: { readonly type: "uniform" | "read-only-storage" | "storage" };
  readonly texture?: {
    readonly sampleType: NatureTextureSampleType;
    readonly viewDimension: NatureTextureViewDimension;
    readonly multisampled: false;
  };
  readonly storageTexture?: {
    readonly access: "write-only";
    readonly format: NatureStorageTextureFormat;
    readonly viewDimension: NatureTextureViewDimension;
  };
  readonly sampler?: { readonly type: NatureSamplerType };
}

/** Convert module metadata into objects structurally compatible with WebGPU layout entries. */
export function buildNatureBindGroupLayoutEntries(
  module: NatureShaderModule,
  group = 0,
): readonly PortableBindGroupLayoutEntry[] {
  const visibility = module.entryPoints.reduce((mask, entry) => {
    if (entry.stage === "vertex") return mask | 1;
    if (entry.stage === "fragment") return mask | 2;
    return mask | 4;
  }, 0);
  return Object.freeze(module.bindings
    .filter((binding) => binding.group === group)
    .map((binding): PortableBindGroupLayoutEntry => {
      const common = { binding: binding.binding, visibility } as const;
      if (binding.kind === "uniform-buffer") {
        return Object.freeze({ ...common, buffer: Object.freeze({ type: "uniform" as const }) });
      }
      if (binding.kind === "read-only-storage-buffer") {
        return Object.freeze({
          ...common,
          buffer: Object.freeze({ type: "read-only-storage" as const }),
        });
      }
      if (binding.kind === "storage-buffer") {
        return Object.freeze({ ...common, buffer: Object.freeze({ type: "storage" as const }) });
      }
      if (binding.kind === "sampler") {
        if (binding.samplerType === undefined) {
          throw new TypeError(`${module.label}:${binding.name} is missing samplerType metadata`);
        }
        return Object.freeze({
          ...common,
          sampler: Object.freeze({ type: binding.samplerType }),
        });
      }
      if (binding.viewDimension === undefined) {
        throw new TypeError(`${module.label}:${binding.name} is missing viewDimension metadata`);
      }
      if (binding.kind === "sampled-texture") {
        if (binding.sampleType === undefined) {
          throw new TypeError(`${module.label}:${binding.name} is missing sampleType metadata`);
        }
        return Object.freeze({
          ...common,
          texture: Object.freeze({
            sampleType: binding.sampleType,
            viewDimension: binding.viewDimension,
            multisampled: false as const,
          }),
        });
      }
      if (binding.storageFormat === undefined) {
        throw new TypeError(`${module.label}:${binding.name} is missing storageFormat metadata`);
      }
      return Object.freeze({
        ...common,
        storageTexture: Object.freeze({
          access: "write-only" as const,
          format: binding.storageFormat,
          viewDimension: binding.viewDimension,
        }),
      });
    }));
}

export function computeDispatch2D(
  width: number,
  height: number,
  workgroupSize: readonly [number, number, number],
): readonly [number, number, number] {
  if (workgroupSize.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError("workgroupSize must contain positive integers");
  }
  const finiteWidth = Number.isFinite(width) ? Math.max(0, Math.ceil(width)) : 0;
  const finiteHeight = Number.isFinite(height) ? Math.max(0, Math.ceil(height)) : 0;
  return [
    Math.ceil(finiteWidth / workgroupSize[0]),
    Math.ceil(finiteHeight / workgroupSize[1]),
    1,
  ];
}
