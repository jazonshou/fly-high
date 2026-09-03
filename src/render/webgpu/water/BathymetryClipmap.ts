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
import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_GUTTER,
  WORLD_PAGE_HEIGHT_CORE,
} from "@/src/render/webgpu/world/pageGeometry";
import { withoutDispatchTiming } from "../core/GpuTimingPolicy";
import {
  registerGpuBufferBytes,
  releaseGpuBufferBytes,
} from "@/src/render/webgpu/core/GpuBufferInventory";

/** Both levels deliberately have the same footprint and GPU format. */
export const BATHYMETRY_CLIPMAP_EDGE = 1_024;
export const BATHYMETRY_NEAR_TEXEL_METERS = 16;
export const BATHYMETRY_FAR_TEXEL_METERS = 128;
export const BATHYMETRY_NEAR_CLAMP_METERS = 256;
export const BATHYMETRY_FAR_CLAMP_METERS = 4_096;
export const BATHYMETRY_LEVEL_COUNT = 2;
export const BATHYMETRY_TEXTURE_BYTES_PER_TEXEL = 2;

const BATHYMETRY_WORKGROUP_EDGE = 8;
export const BATHYMETRY_COMPUTE_TIMEOUT_MILLISECONDS = 30_000;
const BATHYMETRY_COMPUTE_POLL_MILLISECONDS = 16;

/**
 * Above this many changed L0 pages in one recenter, repaint the level whole
 * instead of issuing a rect per page. Each rect costs its own compute pass,
 * bind-group rebuild and buffer pair, so the per-delta path is cheaper only
 * while deltas are few; a residency-wide turnover (atlas reshape, large
 * camera jump) is exactly the case it stops being cheaper. 24 is the L0
 * collision ring's own size — a turnover larger than the ring is a reset,
 * not a stream.
 */
export const BATHYMETRY_PAGE_RECT_BATCH_LIMIT = 24;

export interface BathymetryComputeDispatchPort {
  readonly name: string;
  onCompiled: ComputeShader["onCompiled"];
  onError: ComputeShader["onError"];
  dispatch(x: number, y?: number, z?: number): boolean;
}

export interface BathymetryComputeDispatchOptions {
  readonly timeoutMilliseconds?: number;
  readonly pollMilliseconds?: number;
  readonly signals?: readonly AbortSignal[];
}

function bathymetryAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * Bounded replacement for Babylon's resolve-only `dispatchWhenReady` retry.
 * A WGSL compile error, timeout, startup abort, or owner disposal must settle
 * the caller and remove every timer/listener it installed.
 */
export function dispatchBathymetryComputeWhenReady(
  shader: BathymetryComputeDispatchPort,
  x: number,
  y: number,
  z: number,
  options: BathymetryComputeDispatchOptions = {},
): Promise<void> {
  const timeoutMilliseconds = options.timeoutMilliseconds
    ?? BATHYMETRY_COMPUTE_TIMEOUT_MILLISECONDS;
  const pollMilliseconds = options.pollMilliseconds
    ?? BATHYMETRY_COMPUTE_POLL_MILLISECONDS;
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds < 0) {
    return Promise.reject(new RangeError("Bathymetry compute timeout must be non-negative"));
  }
  if (!Number.isFinite(pollMilliseconds) || pollMilliseconds < 0) {
    return Promise.reject(new RangeError("Bathymetry compute poll interval must be non-negative"));
  }
  const signals = options.signals ?? [];
  if (signals.some((signal) => signal.aborted)) {
    return Promise.reject(bathymetryAbortError(`Dispatch of ${shader.name} was cancelled`));
  }

  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const previousCompiled = shader.onCompiled;
    const previousError = shader.onError;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const cleanup = (): void => {
      if (timer !== null) clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener("abort", onAbort);
      if (shader.onCompiled === onCompiled) shader.onCompiled = previousCompiled;
      if (shader.onError === onError) shader.onError = previousError;
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => {
      finish(bathymetryAbortError(`Dispatch of ${shader.name} was cancelled`));
    };
    const onCompiled: NonNullable<ComputeShader["onCompiled"]> = (effect): void => {
      previousCompiled?.(effect);
    };
    const onError: NonNullable<ComputeShader["onError"]> = (effect, errors): void => {
      try {
        previousError?.(effect, errors);
      } finally {
        finish(new Error(
          `Unable to compile ${shader.name}: ${errors || "unknown WGSL error"}`,
        ));
      }
    };
    const poll = (): void => {
      if (settled) return;
      if (signals.some((signal) => signal.aborted)) {
        onAbort();
        return;
      }
      try {
        if (shader.dispatch(x, y, z)) {
          finish();
          return;
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      // `dispatch()` can synchronously report a compile error through the
      // callback above while still returning false. Do not install a timer
      // after that callback has already completed cleanup.
      if (settled) return;
      if (performance.now() - startedAt >= timeoutMilliseconds) {
        finish(new Error(
          `Timed out dispatching ${shader.name} after ${timeoutMilliseconds} ms`,
        ));
        return;
      }
      timer = setTimeout(poll, pollMilliseconds);
    };

    shader.onCompiled = onCompiled;
    shader.onError = onError;
    for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
    poll();
  });
}

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
 * Deliberately macro-floor only: since W-6, resident eroded L0 pages refine
 * the GPU bathymetry texture beyond this mirror (their converged heights are
 * GPU-resident and residency-dependent), so tests and tooling reading this
 * function see the designed lower bound of the GPU authority, not a bug.
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

// ---------------------------------------------------------------------------
// W-6 (C-6): resident eroded L0 page overlay
// ---------------------------------------------------------------------------

/**
 * Feather width, in metres, that the eroded-page overlay blends across at any
 * page border facing macro-authority ground: two near-level bathymetry texels,
 * so the 16 m / 512 m authority seam never steps.
 */
export const BATHYMETRY_PAGE_FEATHER_METERS = 2 * BATHYMETRY_NEAR_TEXEL_METERS;

/** One resident eroded L0 terrain page and its height-atlas slot origin. */
export interface BathymetryResidentErodedPage {
  readonly tileX: number;
  readonly tileZ: number;
  /** Texel origin of the page's slot inside the terrain height atlas. */
  readonly slotU: number;
  readonly slotV: number;
}

/**
 * The narrow injection seam through which the clipmap learns about resident
 * eroded L0 terrain pages. Wired only when `worldEvolution === "eroded"`
 * (ARCHITECTURE 5-10 row: water consumers may not overlay pages themselves,
 * so the clipmap's own update dispatch is the single implementation site).
 * Callbacks, not captured values: `TerrainClipmapSystem.setQuality` can
 * replace the atlas — and its texture handle — wholesale.
 */
export interface BathymetryErodedPageOverlaySeam {
  /** Resident eroded L0 pages, in any order; the clipmap normalizes. */
  residentErodedL0Pages(): readonly BathymetryResidentErodedPage[];
  /** Terrain height atlas (r32float), or null before textures exist. */
  heightAtlasTexture(): RawTexture | null;
  /** Page-table capacity: the height atlas slot count. */
  pageTableCapacity(): number;
}

/**
 * Structural view of the terrain height atlas so this module needs no import
 * from `terrain/TerrainPageAtlas` — `TerrainPageAtlas` satisfies it as-is.
 */
export interface BathymetryHeightAtlasView {
  readonly residency: {
    readonly slotCount: number;
    readonly entries: readonly {
      readonly address: {
        readonly level: number;
        readonly x: number;
        readonly z: number;
      };
      readonly slotIndex: number;
      readonly lifecycle: { readonly state: string };
    }[];
  };
  slotOrigin(slotIndex: number): { readonly u: number; readonly v: number };
  texture(index?: number): RawTexture | null;
}

/** The few-line wiring `FlightRenderer` uses to connect the seam. */
export function bathymetryErodedPageOverlaySeamFromAtlas(
  atlas: () => BathymetryHeightAtlasView,
): BathymetryErodedPageOverlaySeam {
  return {
    residentErodedL0Pages: () => {
      const view = atlas();
      const pages: BathymetryResidentErodedPage[] = [];
      for (const slot of view.residency.entries) {
        // Only fully resident L0 pages participate: `slotIndexOf` semantics —
        // a generating page's texels are never authority.
        if (slot.lifecycle.state !== "resident" || slot.address.level !== 0) continue;
        const origin = view.slotOrigin(slot.slotIndex);
        pages.push({
          tileX: slot.address.x,
          tileZ: slot.address.z,
          slotU: origin.u,
          slotV: origin.v,
        });
      }
      return pages;
    },
    heightAtlasTexture: () => atlas().texture(0),
    pageTableCapacity: () => atlas().residency.slotCount,
  };
}

function requirePageTableEntry(page: BathymetryResidentErodedPage): void {
  if (
    !Number.isSafeInteger(page.tileX)
    || !Number.isSafeInteger(page.tileZ)
    || !Number.isSafeInteger(page.slotU) || page.slotU < 0
    || !Number.isSafeInteger(page.slotV) || page.slotV < 0
  ) {
    throw new RangeError("Bathymetry page-table entries must be integer tiles and non-negative slot origins");
  }
}

function comparePageTiles(
  first: { readonly tileX: number; readonly tileZ: number },
  second: { readonly tileX: number; readonly tileZ: number },
): number {
  return first.tileZ - second.tileZ || first.tileX - second.tileX;
}

/** Element-wise equality of two sorted snapshots. */
function bathymetryPageListsEqual(
  first: readonly BathymetryResidentErodedPage[],
  second: readonly BathymetryResidentErodedPage[],
): boolean {
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index += 1) {
    const a = first[index]!;
    const b = second[index]!;
    if (
      a.tileX !== b.tileX || a.tileZ !== b.tileZ
      || a.slotU !== b.slotU || a.slotV !== b.slotV
    ) return false;
  }
  return true;
}

/**
 * GPU page-table bytes: a vec4i header (x = entry count) followed by
 * `max(1, capacity)` vec4i entries of (tileX, tileZ, slotU, slotV). The
 * trailing zeroed entries are never indexed — the WGSL loop bound is the
 * count, the same guarantee the 1-float macro sentinel gives in analytic
 * worlds. Deterministic: entries sort by (tileZ, tileX) and a snapshot longer
 * than the capacity keeps the first `capacity` after that sort.
 */
export function buildBathymetryPageTable(
  pages: readonly BathymetryResidentErodedPage[],
  capacity: number,
): Int32Array {
  if (!Number.isSafeInteger(capacity) || capacity < 0) {
    throw new RangeError("Bathymetry page-table capacity must be a non-negative integer");
  }
  const sorted = [...pages].sort(comparePageTiles);
  const seen = new Set<string>();
  for (const page of sorted) {
    requirePageTableEntry(page);
    const key = `${page.tileX}/${page.tileZ}`;
    if (seen.has(key)) {
      throw new RangeError(`Bathymetry page table received tile ${key} twice`);
    }
    seen.add(key);
  }
  const kept = sorted.length > capacity ? sorted.slice(0, capacity) : sorted;
  const table = new Int32Array(4 + Math.max(1, capacity) * 4);
  table[0] = kept.length;
  for (let index = 0; index < kept.length; index += 1) {
    const page = kept[index]!;
    const base = 4 + index * 4;
    table[base] = page.tileX;
    table[base + 1] = page.tileZ;
    table[base + 2] = page.slotU;
    table[base + 3] = page.slotV;
  }
  return table;
}

/**
 * Tiles whose bathymetry footprint must be re-dispatched between two resident
 * snapshots: admissions, evictions and slot moves, deduplicated into one
 * deterministic batch however many deltas the frame produced.
 */
export function diffBathymetryResidentPages(
  previous: readonly BathymetryResidentErodedPage[],
  next: readonly BathymetryResidentErodedPage[],
): readonly { readonly tileX: number; readonly tileZ: number }[] {
  const keyOf = (page: BathymetryResidentErodedPage): string => `${page.tileX}/${page.tileZ}`;
  const remaining = new Map(previous.map((page) => [keyOf(page), page]));
  const changed = new Map<string, { readonly tileX: number; readonly tileZ: number }>();
  for (const page of next) {
    const key = keyOf(page);
    const before = remaining.get(key);
    remaining.delete(key);
    if (before && before.slotU === page.slotU && before.slotV === page.slotV) continue;
    changed.set(key, { tileX: page.tileX, tileZ: page.tileZ });
  }
  for (const page of remaining.values()) {
    changed.set(keyOf(page), { tileX: page.tileX, tileZ: page.tileZ });
  }
  return [...changed.values()].sort(comparePageTiles);
}

/**
 * Level-texel rectangle a page delta dirties, page footprint plus the feather
 * margin: admitting or evicting a page also changes the feather weight of
 * texels just inside its already-resident neighbours. L0 (16 m texels) is a
 * 32×32 footprint dispatched as 36×36; L1 (128 m) a 4×4 dispatched as 6×6.
 */
export function bathymetryPageDirtyRect(
  tileX: number,
  tileZ: number,
  texelMeters: number,
): BathymetryTexelRect {
  if (!Number.isSafeInteger(tileX) || !Number.isSafeInteger(tileZ)) {
    throw new RangeError("Bathymetry page tiles must be integers");
  }
  if (
    !Number.isFinite(texelMeters) || texelMeters <= 0
    || WORLD_PAGE_BASE_EXTENT_METERS % texelMeters !== 0
  ) {
    throw new RangeError("Bathymetry texel size must evenly divide the 512 m page extent");
  }
  const pageTexels = WORLD_PAGE_BASE_EXTENT_METERS / texelMeters;
  const featherTexels = Math.ceil(BATHYMETRY_PAGE_FEATHER_METERS / texelMeters);
  return {
    minX: tileX * pageTexels - featherTexels,
    minZ: tileZ * pageTexels - featherTexels,
    width: pageTexels + featherTexels * 2,
    height: pageTexels + featherTexels * 2,
  };
}

/**
 * Intersection of a dirty rectangle with a level's active window, in GLOBAL
 * texel coordinates — the window is contiguous there; only texture addressing
 * wraps, and the dispatch's per-texel `positiveMod` already handles that.
 * Null when the page lies wholly outside the window (no texel represents it).
 */
export function clipBathymetryRect(
  rect: BathymetryTexelRect,
  originTexelX: number,
  originTexelZ: number,
  edge = BATHYMETRY_CLIPMAP_EDGE,
): BathymetryTexelRect | null {
  if (![originTexelX, originTexelZ, edge].every(Number.isInteger) || edge <= 0) {
    throw new RangeError("Bathymetry window origin and edge must be integers");
  }
  const minX = Math.max(rect.minX, originTexelX);
  const minZ = Math.max(rect.minZ, originTexelZ);
  const maxX = Math.min(rect.minX + rect.width, originTexelX + edge);
  const maxZ = Math.min(rect.minZ + rect.height, originTexelZ + edge);
  if (maxX <= minX || maxZ <= minZ) return null;
  return { minX, minZ, width: maxX - minX, height: maxZ - minZ };
}

/**
 * CPU mirror of the WGSL overlay selection (`bathymetryResidentPageOverlay`),
 * kept literally parallel the way `WATER_DEPTH_OPTICS_WGSL` keeps its two
 * fragment consumers parallel: the covering tile, the 3×3 resident-neighbour
 * mask, the Euclidean distance to the nearest NON-resident neighbour tile,
 * and the smoothstep-shaped feather. Seams between two resident pages feather
 * against nothing — their stored gutters already agree bit-exactly — so the
 * weight stays 1 there and only true macro-facing borders blend.
 */
export function bathymetryErodedPageOverlayWeight(
  pages: readonly BathymetryResidentErodedPage[],
  worldX: number,
  worldZ: number,
): { readonly weight: number; readonly page: BathymetryResidentErodedPage } | null {
  if (pages.length === 0) return null;
  if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) {
    throw new RangeError("Bathymetry overlay coordinates must be finite");
  }
  const tileX = Math.floor(worldX / WORLD_PAGE_BASE_EXTENT_METERS);
  const tileZ = Math.floor(worldZ / WORLD_PAGE_BASE_EXTENT_METERS);
  let covering: BathymetryResidentErodedPage | null = null;
  let residentNeighbors = 0;
  for (const page of pages) {
    const deltaX = page.tileX - tileX;
    const deltaZ = page.tileZ - tileZ;
    if (Math.abs(deltaX) <= 1 && Math.abs(deltaZ) <= 1) {
      residentNeighbors |= 1 << ((deltaZ + 1) * 3 + deltaX + 1);
      if (deltaX === 0 && deltaZ === 0) covering = page;
    }
  }
  if (!covering) return null;
  let authorityDistance = BATHYMETRY_PAGE_FEATHER_METERS;
  for (let deltaZ = -1; deltaZ <= 1; deltaZ += 1) {
    for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
      if (deltaX === 0 && deltaZ === 0) continue;
      if ((residentNeighbors & (1 << ((deltaZ + 1) * 3 + deltaX + 1))) !== 0) continue;
      const minX = (tileX + deltaX) * WORLD_PAGE_BASE_EXTENT_METERS;
      const minZ = (tileZ + deltaZ) * WORLD_PAGE_BASE_EXTENT_METERS;
      const axisX = Math.max(minX - worldX, worldX - (minX + WORLD_PAGE_BASE_EXTENT_METERS), 0);
      const axisZ = Math.max(minZ - worldZ, worldZ - (minZ + WORLD_PAGE_BASE_EXTENT_METERS), 0);
      authorityDistance = Math.min(authorityDistance, Math.hypot(axisX, axisZ));
    }
  }
  const amount = Math.max(0, Math.min(1, authorityDistance / BATHYMETRY_PAGE_FEATHER_METERS));
  return { weight: amount * amount * (3 - 2 * amount), page: covering };
}

/**
 * CPU mirror of the WGSL height fetch: the atlas texel a world position loads
 * from a resident page — slot origin, plus the 4-texel gutter, plus the
 * clamped 2 m core coordinate. NEAREST by construction (a floor, no filter).
 */
export function bathymetryPageHeightAtlasTexel(
  page: BathymetryResidentErodedPage,
  worldX: number,
  worldZ: number,
): readonly [number, number] {
  requirePageTableEntry(page);
  const heightTexelMeters = WORLD_PAGE_BASE_EXTENT_METERS / WORLD_PAGE_HEIGHT_CORE;
  const coreCoordinate = (world: number, tile: number): number => Math.max(0, Math.min(
    WORLD_PAGE_HEIGHT_CORE - 1,
    Math.floor((world - tile * WORLD_PAGE_BASE_EXTENT_METERS) / heightTexelMeters),
  ));
  return [
    page.slotU + WORLD_PAGE_GUTTER + coreCoordinate(worldX, page.tileX),
    page.slotV + WORLD_PAGE_GUTTER + coreCoordinate(worldZ, page.tileZ),
  ];
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

struct BathymetryPageTable {
  // x = resident-entry count; y, z, w reserved.
  header: vec4i,
  // Per entry: eroded L0 tile x/z, height-atlas slot texel origin u/v.
  entries: array<vec4i>,
};

@group(0) @binding(1) var<storage, read> bathymetryParams: BathymetryUpdateParams;
@group(0) @binding(2) var bathymetryTarget: texture_storage_2d<r16float, write>;
@group(0) @binding(3) var<storage, read> bathymetryMacroHeight: array<f32>;
@group(0) @binding(4) var<storage, read> bathymetryPageTable: BathymetryPageTable;
// r32float under layout 'auto': textureLoad only, never textureSample.
@group(0) @binding(5) var bathymetryHeightAtlas: texture_2d<f32>;

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

// W-6: resident eroded L0 page overlay. Numbers interpolate from the ONE
// page-geometry definition (world/pageGeometry.ts) — never restate them.
const BATHYMETRY_PAGE_METERS: f32 = ${WORLD_PAGE_BASE_EXTENT_METERS}.0;
const BATHYMETRY_PAGE_HEIGHT_TEXEL_METERS: f32 =
  ${WORLD_PAGE_BASE_EXTENT_METERS / WORLD_PAGE_HEIGHT_CORE}.0;
const BATHYMETRY_PAGE_CORE_TEXELS: i32 = ${WORLD_PAGE_HEIGHT_CORE};
const BATHYMETRY_PAGE_APRON_TEXELS: i32 = ${WORLD_PAGE_GUTTER};
const BATHYMETRY_PAGE_FEATHER: f32 = ${BATHYMETRY_PAGE_FEATHER_METERS}.0;

fn bathymetryPageHeight(entry: vec4i, worldXZ: vec2f) -> f32 {
  let pageMin = vec2f(entry.xy) * BATHYMETRY_PAGE_METERS;
  let coreTexel = clamp(
    vec2i(floor((worldXZ - pageMin) / BATHYMETRY_PAGE_HEIGHT_TEXEL_METERS)),
    vec2i(0),
    vec2i(BATHYMETRY_PAGE_CORE_TEXELS - 1),
  );
  return textureLoad(
    bathymetryHeightAtlas,
    entry.zw + vec2i(BATHYMETRY_PAGE_APRON_TEXELS) + coreTexel,
    0,
  ).r;
}

// Feather weight toward the covering resident eroded L0 page and that page's
// height, or (0, 0) when no resident page covers this texel. The feather
// measures distance to the nearest NON-resident neighbour tile only: seams
// between two resident pages carry bit-identical gutter data, so blending
// toward macro there would carve a groove along every internal page border.
// Analytic worlds publish an empty table, so this returns before any load —
// the same inertness guarantee as the 1-float macro sentinel.
fn bathymetryResidentPageOverlay(worldXZ: vec2f) -> vec2f {
  let entryCount = bathymetryPageTable.header.x;
  if (entryCount <= 0) {
    return vec2f(0.0, 0.0);
  }
  let centerTile = vec2i(floor(worldXZ / BATHYMETRY_PAGE_METERS));
  var covering = vec4i(0, 0, 0, 0);
  var coveringFound = false;
  var residentNeighbors = 0u;
  for (var index: i32 = 0; index < entryCount; index += 1) {
    let entry = bathymetryPageTable.entries[u32(index)];
    let delta = entry.xy - centerTile;
    if (all(abs(delta) <= vec2i(1, 1))) {
      residentNeighbors |= 1u << u32((delta.y + 1) * 3 + delta.x + 1);
      if (all(delta == vec2i(0, 0))) {
        covering = entry;
        coveringFound = true;
      }
    }
  }
  if (!coveringFound) {
    return vec2f(0.0, 0.0);
  }
  var authorityDistance = BATHYMETRY_PAGE_FEATHER;
  for (var deltaZ: i32 = -1; deltaZ <= 1; deltaZ += 1) {
    for (var deltaX: i32 = -1; deltaX <= 1; deltaX += 1) {
      if (deltaX == 0 && deltaZ == 0) { continue; }
      let bit = 1u << u32((deltaZ + 1) * 3 + deltaX + 1);
      if ((residentNeighbors & bit) != 0u) { continue; }
      let neighborMin = vec2f(centerTile + vec2i(deltaX, deltaZ)) * BATHYMETRY_PAGE_METERS;
      let axisDistance = max(
        max(neighborMin - worldXZ, worldXZ - (neighborMin + vec2f(BATHYMETRY_PAGE_METERS))),
        vec2f(0.0),
      );
      authorityDistance = min(authorityDistance, length(axisDistance));
    }
  }
  let amount = clamp(authorityDistance / BATHYMETRY_PAGE_FEATHER, 0.0, 1.0);
  let weight = amount * amount * (3.0 - 2.0 * amount);
  return vec2f(weight, bathymetryPageHeight(covering, worldXZ));
}

@compute @workgroup_size(${BATHYMETRY_WORKGROUP_EDGE}, ${BATHYMETRY_WORKGROUP_EDGE}, 1)
fn updateBathymetry(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= u32(bathymetryParams.rectangle.z)
      || id.y >= u32(bathymetryParams.rectangle.w)) {
    return;
  }
  kSelectPage(0u);
  let texel = bathymetryParams.water.x;
  let globalTexel = bathymetryParams.rectangle.xy + vec2i(id.xy);
  let worldXZ = vec2f(globalTexel) * texel;
  // Wrong-coordinate bug, original to Phase 5: this bed height was sampled at
  // the DISPATCH-LOCAL invocation coordinates (f32(id.xy) * texel) — terrain
  // transplanted from the dispatch frame near the world origin, a different
  // wrong offset per partial-update rectangle — while the macro blend and
  // page overlay two lines down always used the correct texel WORLD position.
  // So the bathymetry bed the water shaders read has been alien terrain since
  // Phase 5. This is INVISIBLE TODAY: its consumer is the spectral-ocean
  // depth path, and the ocean mesh does not currently render (its vertex
  // reads patchLengths0 = 0 → NaN displacement → degenerate; separate fix).
  // It becomes visible the moment the ocean renders, because a correct bed is
  // what makes near-shore depth, shoaling and the shoreline band correct.
  var height = terrainNaturalHeight(worldXZ.x, worldXZ.y);
  if (bathymetryParams.water.w > 0.5) {
    let macroHeight = sampleBathymetryMacroHeight(worldXZ);
    height = height + (macroHeight - height) * bathymetryMacroBlend(worldXZ);
  }
  // W-6: after the macro blend, before the clamp — resident eroded L0 pages
  // refine the 512 m macro floor with their converged 2 m heights.
  let paged = bathymetryResidentPageOverlay(worldXZ);
  if (paged.x > 0.0) {
    height = height + (paged.y - height) * paged.x;
  }
  let bedDelta = clamp(
    height - bathymetryParams.water.y,
    -bathymetryParams.water.z,
    bathymetryParams.water.z,
  );
  let targetTexel = vec2i(
    positiveMod(globalTexel.x, ${BATHYMETRY_CLIPMAP_EDGE}),
    positiveMod(globalTexel.y, ${BATHYMETRY_CLIPMAP_EDGE}),
  );
  textureStore(bathymetryTarget, targetTexel, vec4f(bedDelta, 0.0, 0.0, 0.0));
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
 *
 * W-6 (C-6): in eroded worlds the update dispatch additionally overlays
 * RESIDENT eroded L0 terrain pages on top of the macro blend, feathered at
 * macro-facing page borders, invalidated per page delta through footprint
 * rects on the per-frame recenter. The consumer binding surface is untouched.
 */
export class BathymetryClipmap {
  private readonly levels: [BathymetryLevelRuntime, BathymetryLevelRuntime];
  private readonly engine: WebGPUEngine | null;
  private readonly erodedPageOverlay: BathymetryErodedPageOverlaySeam | null;
  private shader: ComputeShader | null = null;
  private macroHeightBuffer: StorageBuffer | null = null;
  /** Bytes reported to the renderer's memory-inventory floor (Gate 0-c). */
  private macroHeightBufferBytes = 0;
  private pageTableBuffer: StorageBuffer | null = null;
  private pageTableBufferBytes = 0;
  private pageTableCapacity = 0;
  /** The snapshot currently encoded in the GPU page-table buffer. */
  private bufferedPages: readonly BathymetryResidentErodedPage[] | null = null;
  /** The snapshot whose footprints the textures are known to reflect. */
  private publishedPages: readonly BathymetryResidentErodedPage[] = [];
  private fallbackHeightTexture: RawTexture | null = null;
  private macroEvolution: Readonly<TerrainMacroEvolutionExport> | null = null;
  private macroBufferDirty = true;
  private authorityDirty = false;
  private authorityRevision = 0;
  private updating = false;
  private disposed = false;
  private readonly lifetimeController = new AbortController();

  constructor(
    private readonly scene: Scene,
    private readonly world: Readonly<WorldDefinition>,
    erodedPageOverlay: BathymetryErodedPageOverlaySeam | null = null,
  ) {
    const engine = scene.getEngine() as WebGPUEngine & { isWebGPU?: boolean };
    this.engine = engine.isWebGPU ? engine : null;
    // Mode gate, belt and braces with the wiring gate in FlightRenderer: an
    // analytic world ignores an accidentally supplied seam entirely, so its
    // page table stays the empty sentinel and the WGSL branch stays inert.
    this.erodedPageOverlay = world.worldEvolution === "eroded" ? erodedPageOverlay : null;
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

  async initialize(
    observerX: number,
    observerZ: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.recenter(observerX, observerZ, signal);
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
  async recenter(
    observerX: number,
    observerZ: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.disposed || this.updating) return false;
    if (!Number.isFinite(observerX) || !Number.isFinite(observerZ)) {
      throw new RangeError("Bathymetry observer coordinates must be finite");
    }
    // W-6: one residency snapshot per recenter. All page deltas since the
    // last successful publication coalesce into one rect batch here, and a
    // failed or aborted pass leaves `publishedPages` untouched so the next
    // recenter re-derives and re-dispatches the same footprints (self-healing
    // without any extra in-flight bookkeeping).
    const residentPages = this.residentErodedPagesSnapshot();
    const changedTiles = diffBathymetryResidentPages(this.publishedPages, residentPages);
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
        ? [...bathymetryUpdateRectangles(
          runtime.originTexelX,
          runtime.originTexelZ,
          nextOriginX,
          nextOriginZ,
        )]
        : [{
          minX: nextOriginX,
          minZ: nextOriginZ,
          width: BATHYMETRY_CLIPMAP_EDGE,
          height: BATHYMETRY_CLIPMAP_EDGE,
        }];
      // Page-delta rects: a 512 m page footprint plus its feather margin,
      // skipped when a full-square refresh already repaints the level. This
      // is the budgeted alternative to full-square invalidation — ~5×5
      // workgroups per delta at L0 against 128×128 for a square — and it
      // rides the per-frame recenter like every other clipmap maintenance
      // strip: bounded, untimed, and deliberately NOT admitted through
      // ComputeBudget (this is not a generation DAG, and deferring a strip
      // would serve stale authority under a surf zone for visible frames).
      const fullSquare = rectangles.some((rectangle) =>
        rectangle.width >= BATHYMETRY_CLIPMAP_EDGE
        && rectangle.height >= BATHYMETRY_CLIPMAP_EDGE);
      // ...but "one rect per delta" is only cheaper while the deltas are few.
      // Nothing bounds the batch: an atlas reshape (setQuality) or a large
      // camera jump turns the whole L0 residency over in a single frame, and
      // each rect is its own compute pass, bind-group rebuild and buffer pair.
      // Past the crossover the level repaints wholesale instead — the same
      // work a fresh authority does, and strictly less than N small passes.
      if (!fullSquare && changedTiles.length > BATHYMETRY_PAGE_RECT_BATCH_LIMIT) {
        rectangles.length = 0;
        rectangles.push({
          minX: nextOriginX,
          minZ: nextOriginZ,
          width: BATHYMETRY_CLIPMAP_EDGE,
          height: BATHYMETRY_CLIPMAP_EDGE,
        });
      } else if (!fullSquare) {
        for (const tile of changedTiles) {
          const clipped = clipBathymetryRect(
            bathymetryPageDirtyRect(tile.tileX, tile.tileZ, runtime.definition.texelMeters),
            nextOriginX,
            nextOriginZ,
          );
          if (clipped) rectangles.push(clipped);
        }
      }
      return { runtime, nextOriginX, nextOriginZ, rectangles };
    });
    if (work.every((entry) => entry.rectangles.length === 0)) {
      if (changedTiles.length > 0) {
        // Every delta lies outside both windows: no texel represents those
        // pages, but future strips crossing into them must see the current
        // residency, so the table still refreshes and publishes.
        this.ensurePageTableBuffer(residentPages);
        this.publishedPages = residentPages;
      }
      return false;
    }

    // Apply a pending authority upload before dispatch begins. If authority
    // changes while a dispatch yields, ensureMacroHeightBuffer deliberately
    // leaves the in-flight buffer alone and the revision check invalidates it.
    this.ensureCompute();
    this.ensurePageTableBuffer(residentPages);
    this.updating = true;
    const authorityRevision = this.authorityRevision;
    try {
      for (const entry of work) {
        for (const rectangle of entry.rectangles) {
          await this.dispatch(entry.runtime, rectangle, signal);
        }
        entry.runtime.originTexelX = entry.nextOriginX;
        entry.runtime.originTexelZ = entry.nextOriginZ;
      }
      if (authorityRevision === this.authorityRevision) {
        this.authorityDirty = false;
        this.publishedPages = residentPages;
      }
      return true;
    } catch (error) {
      // A render-loop recenter may be in flight when its owner is disposed.
      // Disposal is a completed lifecycle transition, not an unhandled frame
      // error; explicit startup cancellation still propagates to the caller.
      if (this.disposed && error instanceof Error && error.name === "AbortError") {
        return false;
      }
      throw error;
    } finally {
      this.updating = false;
      if (authorityRevision !== this.authorityRevision) {
        // An authority swap while the bounded readiness dispatch yielded must
        // not publish a half-analytic/half-eroded placement as resident.
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
    this.lifetimeController.abort();
    for (const level of this.levels) level.texture?.dispose();
    this.macroHeightBuffer?.dispose();
    releaseGpuBufferBytes(this.macroHeightBufferBytes);
    this.macroHeightBufferBytes = 0;
    this.pageTableBuffer?.dispose();
    releaseGpuBufferBytes(this.pageTableBufferBytes);
    this.pageTableBufferBytes = 0;
    this.fallbackHeightTexture?.dispose();
    this.macroHeightBuffer = null;
    this.pageTableBuffer = null;
    this.fallbackHeightTexture = null;
    this.bufferedPages = null;
    this.publishedPages = [];
    this.macroEvolution = null;
    this.shader = null;
  }

  /** Sorted, capacity-clamped view of the seam's residency, or empty. */
  private residentErodedPagesSnapshot(): readonly BathymetryResidentErodedPage[] {
    const seam = this.erodedPageOverlay;
    if (!seam) return [];
    const pages = [...seam.residentErodedL0Pages()].sort(comparePageTiles);
    const capacity = seam.pageTableCapacity();
    return pages.length > capacity ? pages.slice(0, capacity) : pages;
  }

  private async dispatch(
    runtime: BathymetryLevelRuntime,
    rectangle: BathymetryTexelRect,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.engine || !runtime.texture) return;
    this.ensureCompute();
    const shader = this.shader;
    const macroHeightBuffer = this.macroHeightBuffer;
    const pageTableBuffer = this.pageTableBuffer;
    // The seam's atlas can be rebuilt (quality reshape), so the texture is
    // re-read every dispatch; the 1×1 sentinel keeps the binding valid when
    // no atlas exists — the WGSL empty-table guard never loads from it.
    const heightAtlasTexture = this.erodedPageOverlay?.heightAtlasTexture()
      ?? this.fallbackHeightTexture;
    if (!shader || !macroHeightBuffer || !pageTableBuffer || !heightAtlasTexture) return;

    const texel = runtime.definition.texelMeters;
    const originX = rectangle.minX * texel;
    const originZ = rectangle.minZ * texel;
    // D11 hazard: `queue.writeBuffer` executes before any command buffer
    // SUBMITTED later in the frame, so updating one shared params buffer
    // between two recorded dispatches retroactively applies the LAST rect's
    // params to both (measured: a page-footprint rect landed at the far
    // level's coordinates while the near rect went undispatched). Every
    // dispatch therefore records against its own short-lived buffers; Babylon
    // defers the GPU-side destroy until after the frame's submit, and the
    // steady-state cost is a few tiny buffers per texel crossing.
    const pageBuffer = new StorageBuffer(this.engine, TERRAIN_KERNEL_PAGE_BYTES);
    const paramsBuffer = new StorageBuffer(this.engine, 32);
    try {
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
      shader.setStorageBuffer("bathymetryPageTable", pageTableBuffer);
      shader.setTexture("bathymetryHeightAtlas", heightAtlasTexture, false);
      shader.setStorageTexture("bathymetryTarget", runtime.texture);
      await dispatchBathymetryComputeWhenReady(
        shader,
        Math.ceil(rectangle.width / BATHYMETRY_WORKGROUP_EDGE),
        Math.ceil(rectangle.height / BATHYMETRY_WORKGROUP_EDGE),
        1,
        {
          signals: signal
            ? [this.lifetimeController.signal, signal]
            : [this.lifetimeController.signal],
        },
      );
    } finally {
      pageBuffer.dispose();
      paramsBuffer.dispose();
    }
  }

  private ensureCompute(): void {
    if (!this.engine) return;
    this.ensureMacroHeightBuffer();
    if (this.fallbackHeightTexture === null) {
      // Keeps the height-atlas binding valid when no seam is wired (analytic
      // worlds) or before the terrain atlas exists; the WGSL empty-table
      // guard means this 1×1 texel is never actually loaded.
      this.fallbackHeightTexture = RawTexture.CreateRTexture(
        new Float32Array([0]),
        1,
        1,
        this.scene,
        false,
        false,
        Texture.NEAREST_SAMPLINGMODE,
        Constants.TEXTURETYPE_FLOAT,
      );
      this.fallbackHeightTexture.name = "bathymetry-height-atlas-sentinel";
    }
    if (this.shader) return;
    this.shader = withoutDispatchTiming(new ComputeShader(
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
          bathymetryPageTable: { group: 0, binding: 4 },
          bathymetryHeightAtlas: { group: 0, binding: 5 },
        },
      },
    ));
  }

  /**
   * Encode the resident-page snapshot into the GPU table. Every table VERSION
   * gets its own buffer rather than an in-place update: `queue.writeBuffer`
   * executes before command buffers submitted later in the frame, so a
   * rewrite would retroactively change the table that already-recorded
   * dispatches read. A recorded dispatch keeps the version bound at record
   * time, and the retired buffer's destroy is deferred past the submit.
   */
  private ensurePageTableBuffer(pages: readonly BathymetryResidentErodedPage[]): void {
    if (!this.engine) return;
    const capacity = Math.max(1, this.erodedPageOverlay?.pageTableCapacity() ?? 0);
    if (
      this.pageTableBuffer
      && this.pageTableCapacity >= capacity
      && this.bufferedPages !== null
      && bathymetryPageListsEqual(this.bufferedPages, pages)
    ) return;
    const table = buildBathymetryPageTable(pages, capacity);
    const next = new StorageBuffer(this.engine, table.byteLength);
    next.update(table);
    this.pageTableBuffer?.dispose();
    // Gate 0-c: storage buffers are invisible to the renderer's texture and
    // geometry inventory, so persistent ones report their own bytes.
    releaseGpuBufferBytes(this.pageTableBufferBytes);
    this.pageTableBufferBytes = table.byteLength;
    registerGpuBufferBytes(this.pageTableBufferBytes);
    this.pageTableBuffer = next;
    this.pageTableCapacity = capacity;
    this.bufferedPages = pages;
  }

  private ensureMacroHeightBuffer(): void {
    if (
      !this.engine
      || (!this.macroBufferDirty && this.macroHeightBuffer)
      || (this.updating && this.macroHeightBuffer)
    ) return;
    this.macroHeightBuffer?.dispose();
    releaseGpuBufferBytes(this.macroHeightBufferBytes);
    const height = this.macroEvolution?.heightMeters;
    if (height) {
      this.macroHeightBufferBytes = height.byteLength;
      registerGpuBufferBytes(this.macroHeightBufferBytes);
      this.macroHeightBuffer = new StorageBuffer(this.engine, height.byteLength);
      this.macroHeightBuffer.update(new Uint8Array(
        height.buffer,
        height.byteOffset,
        height.byteLength,
      ));
    } else {
      // The binding remains valid in analytic mode, while the WGSL branch
      // guarantees this sentinel is never indexed beyond element zero.
      this.macroHeightBufferBytes = Float32Array.BYTES_PER_ELEMENT;
      registerGpuBufferBytes(this.macroHeightBufferBytes);
      this.macroHeightBuffer = new StorageBuffer(this.engine, Float32Array.BYTES_PER_ELEMENT);
      this.macroHeightBuffer.update(new Float32Array([0]));
    }
    this.macroBufferDirty = false;
  }
}
