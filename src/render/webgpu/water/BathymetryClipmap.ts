import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Vector4 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { WorldDefinition, WorldEvolution } from "@/src/world";
import {
  TERRAIN_KERNEL_PAGE_BYTES,
  TERRAIN_KERNEL_WGSL,
  buildTerrainKernelPageUniform,
  terrainKernelPageBindingWgsl,
} from "@/src/render/webgpu/terrain/TerrainKernel";
import {
  EVOLUTION_ANALYTIC_BLEND_METERS,
  EVOLUTION_DOMAIN_SAMPLE_COUNT,
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
  terrainEvolutionMacroBlend,
  type TerrainMacroEvolutionExport,
} from "@/src/render/webgpu/terrain/TerrainEvolutionContract";

/** Both levels deliberately have the same footprint and GPU format. */
export const BATHYMETRY_CLIPMAP_EDGE = 1_024;
export const BATHYMETRY_NEAR_TEXEL_METERS = 16;
export const BATHYMETRY_FAR_TEXEL_METERS = 128;
export const BATHYMETRY_NEAR_CLAMP_METERS = 256;
export const BATHYMETRY_FAR_CLAMP_METERS = 4_096;
export const BATHYMETRY_LEVEL_COUNT = 2;
export const BATHYMETRY_TEXTURE_BYTES_PER_TEXEL = 2;

const BATHYMETRY_WORKGROUP_EDGE = 8;

export interface BathymetryLevelDefinition {
  readonly level: 0 | 1;
  readonly texelMeters: number;
  readonly clampMeters: number;
  readonly spanMeters: number;
}

export const BATHYMETRY_LEVELS: readonly BathymetryLevelDefinition[] = Object.freeze([
  Object.freeze({
    level: 0 as const,
    texelMeters: BATHYMETRY_NEAR_TEXEL_METERS,
    clampMeters: BATHYMETRY_NEAR_CLAMP_METERS,
    spanMeters: BATHYMETRY_CLIPMAP_EDGE * BATHYMETRY_NEAR_TEXEL_METERS,
  }),
  Object.freeze({
    level: 1 as const,
    texelMeters: BATHYMETRY_FAR_TEXEL_METERS,
    clampMeters: BATHYMETRY_FAR_CLAMP_METERS,
    spanMeters: BATHYMETRY_CLIPMAP_EDGE * BATHYMETRY_FAR_TEXEL_METERS,
  }),
]);

export interface BathymetryTexelRect {
  readonly minX: number;
  readonly minZ: number;
  readonly width: number;
  readonly height: number;
}

export interface BathymetryLevelPlacement {
  /** World-grid texel represented by the logical lower-left sample. */
  readonly originTexelX: number;
  readonly originTexelZ: number;
  readonly texelMeters: number;
}

export interface BathymetryShaderBinding {
  readonly nearTexture: RawTexture | null;
  readonly farTexture: RawTexture | null;
  readonly nearPlacement: BathymetryLevelPlacement;
  readonly farPlacement: BathymetryLevelPlacement;
  readonly seaLevel: number;
}

function validateBathymetryMacroEvolution(
  macro: Readonly<TerrainMacroEvolutionExport>,
): void {
  if (macro.contractVersion !== TERRAIN_EVOLUTION_CONTRACT_VERSION) {
    throw new RangeError("Bathymetry macro evolution contract version mismatch");
  }
  if (macro.heightMeters.length !== EVOLUTION_DOMAIN_SAMPLE_COUNT) {
    throw new RangeError("Bathymetry macro height does not match the canonical 1024² domain");
  }
}

/** Bilinear CPU mirror of the storage-buffer lookup used by the update shader. */
export function sampleBathymetryMacroHeight(
  macro: Readonly<TerrainMacroEvolutionExport>,
  worldX: number,
  worldZ: number,
): number {
  validateBathymetryMacroEvolution(macro);
  if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) {
    throw new RangeError("Bathymetry macro coordinates must be finite");
  }
  const sampleAxis = (world: number, minimum: number): readonly [number, number, number] => {
    const coordinate = (world - minimum) / EVOLUTION_TEXEL_METERS - 0.5;
    const first = Math.max(0, Math.min(EVOLUTION_DOMAIN_TEXELS - 1, Math.floor(coordinate)));
    const second = Math.min(EVOLUTION_DOMAIN_TEXELS - 1, first + 1);
    return [first, second, Math.max(0, Math.min(1, coordinate - first))];
  };
  const [x0, x1, tx] = sampleAxis(worldX, TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX);
  const [z0, z1, tz] = sampleAxis(worldZ, TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ);
  const topLeft = macro.heightMeters[z0 * EVOLUTION_DOMAIN_TEXELS + x0]!;
  const topRight = macro.heightMeters[z0 * EVOLUTION_DOMAIN_TEXELS + x1]!;
  const bottomLeft = macro.heightMeters[z1 * EVOLUTION_DOMAIN_TEXELS + x0]!;
  const bottomRight = macro.heightMeters[z1 * EVOLUTION_DOMAIN_TEXELS + x1]!;
  const top = topLeft + (topRight - topLeft) * tx;
  const bottom = bottomLeft + (bottomRight - bottomLeft) * tx;
  return top + (bottom - top) * tz;
}

/**
 * Pure authority selector used by Node tests and CPU recovery tooling. The
 * analytic value is returned verbatim unless an eroded canonical macro is
 * active; the 16-texel rim then blends continuously back to analytic terrain.
 */
export function sampleBathymetryTerrainAuthority(
  worldEvolution: WorldEvolution,
  macro: Readonly<TerrainMacroEvolutionExport> | null,
  worldX: number,
  worldZ: number,
  analyticHeightMeters: number,
): number {
  if (worldEvolution === "analytic" || macro === null) return analyticHeightMeters;
  const macroHeight = sampleBathymetryMacroHeight(macro, worldX, worldZ);
  const blend = terrainEvolutionMacroBlend(worldX, worldZ);
  return analyticHeightMeters + (macroHeight - analyticHeightMeters) * blend;
}

/** Mathematical modulo, unlike JavaScript's signed remainder. */
export function positiveModulo(value: number, modulus: number): number {
  if (!Number.isInteger(modulus) || modulus <= 0) {
    throw new RangeError("Bathymetry modulo must be a positive integer");
  }
  return ((value % modulus) + modulus) % modulus;
}

/**
 * Texture coordinate for an integer world texel. The global modulo mapping
 * means adjacent world texels remain adjacent across the toroidal seam.
 */
export function toroidalBathymetryTexel(
  worldTexelX: number,
  worldTexelZ: number,
  edge = BATHYMETRY_CLIPMAP_EDGE,
): readonly [number, number] {
  return [positiveModulo(worldTexelX, edge), positiveModulo(worldTexelZ, edge)];
}

/**
 * Newly exposed strips after moving a square clipmap. Rectangles may overlap
 * at one corner; that harmless duplicate keeps the rule small and symmetric.
 */
export function bathymetryUpdateRectangles(
  previousOriginX: number,
  previousOriginZ: number,
  nextOriginX: number,
  nextOriginZ: number,
  edge = BATHYMETRY_CLIPMAP_EDGE,
): readonly BathymetryTexelRect[] {
  const dx = nextOriginX - previousOriginX;
  const dz = nextOriginZ - previousOriginZ;
  if (![previousOriginX, previousOriginZ, nextOriginX, nextOriginZ, edge].every(Number.isInteger)) {
    throw new RangeError("Bathymetry origins and edge must be integers");
  }
  if (edge <= 0) throw new RangeError("Bathymetry edge must be positive");
  if (Math.abs(dx) >= edge || Math.abs(dz) >= edge) {
    return [{ minX: nextOriginX, minZ: nextOriginZ, width: edge, height: edge }];
  }
  const rectangles: BathymetryTexelRect[] = [];
  if (dx > 0) {
    rectangles.push({
      minX: previousOriginX + edge,
      minZ: nextOriginZ,
      width: dx,
      height: edge,
    });
  } else if (dx < 0) {
    rectangles.push({
      minX: nextOriginX,
      minZ: nextOriginZ,
      width: -dx,
      height: edge,
    });
  }
  if (dz > 0) {
    rectangles.push({
      minX: nextOriginX,
      minZ: previousOriginZ + edge,
      width: edge,
      height: dz,
    });
  } else if (dz < 0) {
    rectangles.push({
      minX: nextOriginX,
      minZ: nextOriginZ,
      width: edge,
      height: -dz,
    });
  }
  return rectangles;
}

export function bathymetryClipmapBytes(
  edge = BATHYMETRY_CLIPMAP_EDGE,
  levels = BATHYMETRY_LEVEL_COUNT,
): number {
  if (!Number.isInteger(edge) || edge <= 0 || !Number.isInteger(levels) || levels <= 0) {
    throw new RangeError("Bathymetry dimensions must be positive integers");
  }
  return edge * edge * levels * BATHYMETRY_TEXTURE_BYTES_PER_TEXEL;
}

export const BATHYMETRY_UPDATE_WGSL = /* wgsl */ `
${terrainKernelPageBindingWgsl(0, 0)}
${TERRAIN_KERNEL_WGSL}

struct BathymetryUpdateParams {
  // texel metres, sea level, clamp magnitude, macro-authority enabled
  water: vec4f,
  // rectangle's global texel x/z and its width/height
  rectangle: vec4i,
};

@group(0) @binding(1) var<storage, read> bathymetryParams: BathymetryUpdateParams;
@group(0) @binding(2) var bathymetryTarget: texture_storage_2d<r16float, write>;
@group(0) @binding(3) var<storage, read> bathymetryMacroHeight: array<f32>;

const BATHYMETRY_MACRO_EDGE: i32 = ${EVOLUTION_DOMAIN_TEXELS};
const BATHYMETRY_MACRO_TEXEL_METERS: f32 = ${EVOLUTION_TEXEL_METERS}.0;
const BATHYMETRY_MACRO_MIN_WORLD: f32 = ${TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX}.0;
const BATHYMETRY_MACRO_MAX_WORLD: f32 = ${TERRAIN_EVOLUTION_MACRO_LAYOUT.maxWorldX}.0;
const BATHYMETRY_MACRO_BLEND_METERS: f32 = ${EVOLUTION_ANALYTIC_BLEND_METERS}.0;

fn positiveMod(value: i32, modulus: i32) -> i32 {
  return ((value % modulus) + modulus) % modulus;
}

fn sampleBathymetryMacroHeight(worldXZ: vec2f) -> f32 {
  let coordinate = (worldXZ - vec2f(BATHYMETRY_MACRO_MIN_WORLD))
    / BATHYMETRY_MACRO_TEXEL_METERS - vec2f(0.5);
  let first = clamp(vec2i(floor(coordinate)), vec2i(0), vec2i(BATHYMETRY_MACRO_EDGE - 1));
  let second = min(first + vec2i(1), vec2i(BATHYMETRY_MACRO_EDGE - 1));
  let amount = clamp(coordinate - vec2f(first), vec2f(0.0), vec2f(1.0));
  let topLeft = bathymetryMacroHeight[u32(first.y * BATHYMETRY_MACRO_EDGE + first.x)];
  let topRight = bathymetryMacroHeight[u32(first.y * BATHYMETRY_MACRO_EDGE + second.x)];
  let bottomLeft = bathymetryMacroHeight[u32(second.y * BATHYMETRY_MACRO_EDGE + first.x)];
  let bottomRight = bathymetryMacroHeight[u32(second.y * BATHYMETRY_MACRO_EDGE + second.x)];
  let top = topLeft + (topRight - topLeft) * amount.x;
  let bottom = bottomLeft + (bottomRight - bottomLeft) * amount.x;
  return top + (bottom - top) * amount.y;
}

fn bathymetryMacroBlend(worldXZ: vec2f) -> f32 {
  let distanceToRim = min(
    min(worldXZ.x - BATHYMETRY_MACRO_MIN_WORLD, BATHYMETRY_MACRO_MAX_WORLD - worldXZ.x),
    min(worldXZ.y - BATHYMETRY_MACRO_MIN_WORLD, BATHYMETRY_MACRO_MAX_WORLD - worldXZ.y),
  );
  let amount = clamp(distanceToRim / BATHYMETRY_MACRO_BLEND_METERS, 0.0, 1.0);
  return amount * amount * (3.0 - 2.0 * amount);
}

@compute @workgroup_size(${BATHYMETRY_WORKGROUP_EDGE}, ${BATHYMETRY_WORKGROUP_EDGE}, 1)
fn updateBathymetry(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= u32(bathymetryParams.rectangle.z)
      || id.y >= u32(bathymetryParams.rectangle.w)) {
    return;
  }
  kSelectPage(0u);
  let texel = bathymetryParams.water.x;
  var height = terrainNaturalHeight(f32(id.x) * texel, f32(id.y) * texel);
  let globalTexel = bathymetryParams.rectangle.xy + vec2i(id.xy);
  if (bathymetryParams.water.w > 0.5) {
    let worldXZ = vec2f(globalTexel) * texel;
    let macroHeight = sampleBathymetryMacroHeight(worldXZ);
    height = height + (macroHeight - height) * bathymetryMacroBlend(worldXZ);
  }
  let bedDelta = clamp(
    height - bathymetryParams.water.y,
    -bathymetryParams.water.z,
    bathymetryParams.water.z,
  );
  let target = vec2i(
    positiveMod(globalTexel.x, ${BATHYMETRY_CLIPMAP_EDGE}),
    positiveMod(globalTexel.y, ${BATHYMETRY_CLIPMAP_EDGE}),
  );
  textureStore(bathymetryTarget, target, vec4f(bedDelta, 0.0, 0.0, 0.0));
}
`;

interface BathymetryLevelRuntime {
  readonly definition: BathymetryLevelDefinition;
  readonly texture: RawTexture | null;
  originTexelX: number;
  originTexelZ: number;
}

function createBathymetryTexture(
  scene: Scene,
  definition: BathymetryLevelDefinition,
): RawTexture | null {
  const engine = scene.getEngine() as { isWebGPU?: boolean };
  if (!engine.isWebGPU) return null;
  const texture = RawTexture.CreateRStorageTexture(
    null,
    BATHYMETRY_CLIPMAP_EDGE,
    BATHYMETRY_CLIPMAP_EDGE,
    scene,
    false,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
    Constants.TEXTURETYPE_HALF_FLOAT,
  );
  texture.name = `bathymetry-l${definition.level}`;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  return texture;
}

/**
 * Camera-centred two-level bathymetry. Initial population and strip updates
 * use the same terrain-kernel include as terrain generation; `5-A` can swap
 * that include's authority without changing any water consumer.
 */
export class BathymetryClipmap {
  private readonly levels: [BathymetryLevelRuntime, BathymetryLevelRuntime];
  private readonly engine: WebGPUEngine | null;
  private shader: ComputeShader | null = null;
  private paramsBuffer: StorageBuffer | null = null;
  private pageBuffer: StorageBuffer | null = null;
  private macroHeightBuffer: StorageBuffer | null = null;
  private macroEvolution: Readonly<TerrainMacroEvolutionExport> | null = null;
  private macroBufferDirty = true;
  private authorityDirty = false;
  private authorityRevision = 0;
  private updating = false;
  private disposed = false;

  constructor(
    private readonly scene: Scene,
    private readonly world: Readonly<WorldDefinition>,
  ) {
    const engine = scene.getEngine() as WebGPUEngine & { isWebGPU?: boolean };
    this.engine = engine.isWebGPU ? engine : null;
    this.levels = BATHYMETRY_LEVELS.map((definition) => ({
      definition,
      texture: createBathymetryTexture(scene, definition),
      originTexelX: Number.NaN,
      originTexelZ: Number.NaN,
    })) as [BathymetryLevelRuntime, BathymetryLevelRuntime];
  }

  get isResident(): boolean {
    return !this.authorityDirty
      && this.levels.every((level) => Number.isFinite(level.originTexelX));
  }

  get hasMacroEvolution(): boolean {
    return this.macroEvolution !== null;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get binding(): BathymetryShaderBinding {
    const [near, far] = this.levels;
    return {
      nearTexture: near.texture,
      farTexture: far.texture,
      nearPlacement: {
        originTexelX: near.originTexelX,
        originTexelZ: near.originTexelZ,
        texelMeters: near.definition.texelMeters,
      },
      farPlacement: {
        originTexelX: far.originTexelX,
        originTexelZ: far.originTexelZ,
        texelMeters: far.definition.texelMeters,
      },
      seaLevel: this.world.seaLevel,
    };
  }

  async initialize(observerX: number, observerZ: number): Promise<void> {
    await this.recenter(observerX, observerZ);
  }

  /**
   * Activates the canonical eroded authority. Its height is uploaded once to
   * a read-only GPU storage buffer; toroidal clipmap updates remain strips.
   * Switching authority invalidates placement so the next recenter performs
   * one complete refresh. Analytic worlds ignore an accidental macro install.
   */
  setMacroEvolution(macro: Readonly<TerrainMacroEvolutionExport> | null): void {
    if (this.disposed) return;
    const next = this.world.worldEvolution === "eroded" ? macro : null;
    if (next) {
      validateBathymetryMacroEvolution(next);
      if (next.provenance.worldSeed !== this.world.seed) {
        throw new RangeError("Bathymetry macro seed does not match the active world");
      }
      if (next.seaLevelMeters !== this.world.seaLevel) {
        throw new RangeError("Bathymetry macro sea level does not match the active world");
      }
    }
    if (next === this.macroEvolution) return;
    this.macroEvolution = next;
    this.macroBufferDirty = true;
    this.authorityDirty = true;
    this.authorityRevision += 1;
  }

  /** Returns true when at least one texture update was submitted. */
  async recenter(observerX: number, observerZ: number): Promise<boolean> {
    if (this.disposed || this.updating) return false;
    if (!Number.isFinite(observerX) || !Number.isFinite(observerZ)) {
      throw new RangeError("Bathymetry observer coordinates must be finite");
    }
    const work = this.levels.map((runtime) => {
      const centerX = Math.floor(observerX / runtime.definition.texelMeters);
      const centerZ = Math.floor(observerZ / runtime.definition.texelMeters);
      const nextOriginX = centerX - BATHYMETRY_CLIPMAP_EDGE / 2;
      const nextOriginZ = centerZ - BATHYMETRY_CLIPMAP_EDGE / 2;
      const rectangles = this.authorityDirty
        ? [{
          minX: nextOriginX,
          minZ: nextOriginZ,
          width: BATHYMETRY_CLIPMAP_EDGE,
          height: BATHYMETRY_CLIPMAP_EDGE,
        }]
        : Number.isFinite(runtime.originTexelX)
        ? bathymetryUpdateRectangles(
          runtime.originTexelX,
          runtime.originTexelZ,
          nextOriginX,
          nextOriginZ,
        )
        : [{
          minX: nextOriginX,
          minZ: nextOriginZ,
          width: BATHYMETRY_CLIPMAP_EDGE,
          height: BATHYMETRY_CLIPMAP_EDGE,
        }];
      return { runtime, nextOriginX, nextOriginZ, rectangles };
    });
    if (work.every((entry) => entry.rectangles.length === 0)) return false;

    // Apply a pending authority upload before dispatch begins. If authority
    // changes while a dispatch yields, ensureMacroHeightBuffer deliberately
    // leaves the in-flight buffer alone and the revision check invalidates it.
    this.ensureCompute();
    this.updating = true;
    const authorityRevision = this.authorityRevision;
    try {
      for (const entry of work) {
        for (const rectangle of entry.rectangles) {
          await this.dispatch(entry.runtime, rectangle);
        }
        entry.runtime.originTexelX = entry.nextOriginX;
        entry.runtime.originTexelZ = entry.nextOriginZ;
      }
      if (authorityRevision === this.authorityRevision) this.authorityDirty = false;
      return true;
    } finally {
      this.updating = false;
      if (authorityRevision !== this.authorityRevision) {
        // An authority swap while dispatchWhenReady yielded must not publish a
        // half-analytic/half-eroded placement as resident.
        this.authorityDirty = true;
      }
    }
  }

  bind(material: ShaderMaterial): void {
    const binding = this.binding;
    if (binding.nearTexture) material.setTexture("bathymetryNear", binding.nearTexture);
    if (binding.farTexture) material.setTexture("bathymetryFar", binding.farTexture);
    material.setFloat("bathymetrySeaLevel", binding.seaLevel);
    material.setVector4("bathymetryNearPlacement", new Vector4(
      binding.nearPlacement.originTexelX,
      binding.nearPlacement.originTexelZ,
      binding.nearPlacement.texelMeters,
      BATHYMETRY_CLIPMAP_EDGE,
    ));
    material.setVector4("bathymetryFarPlacement", new Vector4(
      binding.farPlacement.originTexelX,
      binding.farPlacement.originTexelZ,
      binding.farPlacement.texelMeters,
      BATHYMETRY_CLIPMAP_EDGE,
    ));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const level of this.levels) level.texture?.dispose();
    this.paramsBuffer?.dispose();
    this.pageBuffer?.dispose();
    this.macroHeightBuffer?.dispose();
    this.paramsBuffer = null;
    this.pageBuffer = null;
    this.macroHeightBuffer = null;
    this.macroEvolution = null;
    this.shader = null;
  }

  private async dispatch(
    runtime: BathymetryLevelRuntime,
    rectangle: BathymetryTexelRect,
  ): Promise<void> {
    if (!this.engine || !runtime.texture) return;
    this.ensureCompute();
    const shader = this.shader;
    const paramsBuffer = this.paramsBuffer;
    const pageBuffer = this.pageBuffer;
    const macroHeightBuffer = this.macroHeightBuffer;
    if (!shader || !paramsBuffer || !pageBuffer || !macroHeightBuffer) return;

    const texel = runtime.definition.texelMeters;
    const originX = rectangle.minX * texel;
    const originZ = rectangle.minZ * texel;
    pageBuffer.update(new Uint8Array(buildTerrainKernelPageUniform({
      seedHash: this.world.seedHash,
      originX,
      originZ,
      filterWidthMeters: texel,
    })));
    const bytes = new ArrayBuffer(32);
    const view = new DataView(bytes);
    view.setFloat32(0, texel, true);
    view.setFloat32(4, this.world.seaLevel, true);
    view.setFloat32(8, runtime.definition.clampMeters, true);
    view.setFloat32(12, this.macroEvolution ? 1 : 0, true);
    view.setInt32(16, rectangle.minX, true);
    view.setInt32(20, rectangle.minZ, true);
    view.setInt32(24, rectangle.width, true);
    view.setInt32(28, rectangle.height, true);
    paramsBuffer.update(new Uint8Array(bytes));
    shader.setStorageBuffer("terrainKernelPages", pageBuffer);
    shader.setStorageBuffer("bathymetryParams", paramsBuffer);
    shader.setStorageBuffer("bathymetryMacroHeight", macroHeightBuffer);
    shader.setStorageTexture("bathymetryTarget", runtime.texture);
    await shader.dispatchWhenReady(
      Math.ceil(rectangle.width / BATHYMETRY_WORKGROUP_EDGE),
      Math.ceil(rectangle.height / BATHYMETRY_WORKGROUP_EDGE),
      1,
    );
  }

  private ensureCompute(): void {
    if (!this.engine) return;
    this.ensureMacroHeightBuffer();
    if (this.shader) return;
    this.paramsBuffer = new StorageBuffer(this.engine, 32);
    this.pageBuffer = new StorageBuffer(this.engine, TERRAIN_KERNEL_PAGE_BYTES);
    this.shader = new ComputeShader(
      "bathymetry-clipmap-update",
      this.engine,
      { computeSource: BATHYMETRY_UPDATE_WGSL },
      {
        entryPoint: "updateBathymetry",
        bindingsMapping: {
          terrainKernelPages: { group: 0, binding: 0 },
          bathymetryParams: { group: 0, binding: 1 },
          bathymetryTarget: { group: 0, binding: 2 },
          bathymetryMacroHeight: { group: 0, binding: 3 },
        },
      },
    );
  }

  private ensureMacroHeightBuffer(): void {
    if (
      !this.engine
      || (!this.macroBufferDirty && this.macroHeightBuffer)
      || (this.updating && this.macroHeightBuffer)
    ) return;
    this.macroHeightBuffer?.dispose();
    const height = this.macroEvolution?.heightMeters;
    if (height) {
      this.macroHeightBuffer = new StorageBuffer(this.engine, height.byteLength);
      this.macroHeightBuffer.update(new Uint8Array(
        height.buffer,
        height.byteOffset,
        height.byteLength,
      ));
    } else {
      // The binding remains valid in analytic mode, while the WGSL branch
      // guarantees this sentinel is never indexed beyond element zero.
      this.macroHeightBuffer = new StorageBuffer(this.engine, Float32Array.BYTES_PER_ELEMENT);
      this.macroHeightBuffer.update(new Float32Array([0]));
    }
    this.macroBufferDirty = false;
  }
}
