import { Material } from "@babylonjs/core/Materials/material";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Buffer, VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { createGuardedShadowDepthWrapper } from "@/src/render/webgpu/core/guardedShadowDepthWrapper";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import {
  RENDERED_DENSITY_LAWS,
  renderedShareAtDistance,
  type RenderedDensityLaw,
} from "./renderedDensity";
import { DetailGenerationClient } from "./DetailGenerationClient";
import { DetailInstanceMaterialPlugin } from "./DetailInstanceMaterialPlugin";
import {
  DETAIL_INSTANCE_ATTRIBUTES,
  DETAIL_INSTANCE_RADIAL_MAX,
  DETAIL_INSTANCE_RADIAL_MIN,
  DETAIL_INSTANCE_STRIDE_BYTES,
  DetailInstanceBounds,
  DetailInstanceWriter,
  normalAlignedQuaternion,
  yawQuaternion,
  type DetailInstanceRecord,
} from "./instanceFormat";
import { createFoliageAtlas, type FoliageAtlas } from "./FoliageAtlas";
import {
  createImpostorAtlas,
  impostorBakeFrame,
  impostorLayerIndex,
  IMPOSTOR_SPECIES,
  type ImpostorAtlas,
} from "./ImpostorAtlas";
import { seasonalWinterFraction, type WorldDefinition } from "@/src/world";
import {
  TERRAIN_READBACK_RING_CAPACITY,
  type TerrainMacroGrid,
  type TerrainPagePublication,
} from "@/src/workers/terrainAuthority";
import type { TerrainAuxPagePublication } from "@/src/render/webgpu/terrain/TerrainPageAtlas";
import { WORLD_PAGE_BASE_EXTENT_METERS } from "@/src/render/webgpu/world/pageGeometry";
import {
  buildClutterPrototype,
  buildGrassPatchPrototype,
  buildRockPrototype,
  buildShrubPrototype,
  buildTreePrototype,
  SHRUB_VARIANT_COUNTS,
  TREE_VARIANT_COUNTS,
  type PrototypeGeometry,
} from "./prototypeGeometry";
import { detailCellKey, generateDetailCell, GROUND_COVER_GRID } from "./generation";
import {
  canGenerateNextDetailCell,
  resolveDetailGenerationBudget,
  type DetailGenerationBudget,
} from "./generationBudget";
import {
  detailPresentationChunkCoordinates,
  type DetailPresentationChunkCoordinates,
} from "./spatialChunks";
import {
  DEFAULT_DETAIL_CELL_SIZE_METERS,
  type DetailFloatingOrigin,
  type ClutterKind,
  type DetailLod,
  type GroundCoverArchetype,
  type DetailTerrainSampler,
  type GeneratedDetailCell,
  type RockVariant,
  type ShrubSpecies,
  type TreeSpecies,
  type WorldDetailObserver,
  type WorldDetailStatistics,
} from "./types";

/**
 * The GPU side of one batch: ONE interleaved 32-byte-stride buffer plus the
 * five typed instanced views onto it. Held across rebuilds — see
 * `uploadBatch`.
 */
interface DetailInstanceGpuBuffers {
  readonly shared: Buffer;
  capacityBytes: number;
}

interface DetailBatch {
  readonly mesh: Mesh;
  readonly castsShadows: boolean;
  readonly prototypeKey: string;
  readonly chunkKey: string;
  /** 2-11a: packed 32-byte records built during generation. */
  readonly writer: DetailInstanceWriter;
  readonly bounds: DetailInstanceBounds;
  /**
   * Perf-debt pass: the batch's GPU allocation, reused across rebuilds.
   * Null until the first non-empty upload.
   */
  gpu: DetailInstanceGpuBuffers | null;
  /** Chunk revision whose records the writer currently holds. */
  filledRevision: number;
  /** Floating origin encoded into the currently uploaded instance records. */
  builtOrigin: { x: number; y: number; z: number };
}

interface RetiredDetailBatch {
  readonly batch: DetailBatch;
  readonly disposeAfterUpdate: number;
}

/**
 * A released allocation, RECYCLED rather than destroyed. **Nothing is ever
 * destroyed while the runtime is live.**
 *
 * Measured on-adapter, and the measurement is the reason this is a pool and
 * not a grace window. Destroying a vertex buffer that a submitted command
 * buffer still references is a validation error, and WebGPU rejects the
 * WHOLE submit — the symptom is a black frame at a suspiciously high frame
 * rate, not a missing tree. A four-update grace window produced it
 * immediately; a six-hundred-update one (ten seconds) still produced it,
 * with the diagnostic confirming that NO live mesh held the buffer at
 * eviction time. Whatever retains it inside Babylon 9.21.2's WebGPU backend
 * outlives any window worth waiting, so the runtime stops guessing: released
 * allocations go into a pool and are handed to the next batch that fits.
 *
 * Overwriting a pooled buffer is never an error — `writeBuffer` is ordered
 * on the queue after the previous submit — so reuse only has to outlast the
 * previous owner's last DRAW, which the reuse window covers.
 *
 * Memory is bounded by construction: reuse drains the pool, so live +
 * pooled bytes never exceed the peak working set, which is exactly the
 * `detailInstanceBudget` row `PerformanceBudget.ts` already books. The
 * runtime's statistics publish the pooled byte count so it is visible.
 */
interface PooledInstanceBuffers {
  readonly gpu: DetailInstanceGpuBuffers;
  /** Earliest update at which the previous owner's draws have certainly retired. */
  readonly reusableAfterUpdate: number;
}

interface DetailPrototype {
  readonly mesh: Mesh;
  readonly material: PBRMaterial;
  readonly castsShadows: boolean;
}

interface DetailChunkStatistics {
  readonly nearCells: number;
  readonly midCells: number;
  readonly treeInstances: number;
  readonly shrubInstances: number;
  readonly rockInstances: number;
  readonly clutterInstances: number;
  readonly groundCoverInstances: number;
}

interface DetailPresentationChunk {
  readonly coordinates: DetailPresentationChunkCoordinates;
  readonly batchKeys: Set<string>;
  signature: string;
  revision: number;
  statistics: DetailChunkStatistics;
}

interface MutableDetailChunkStatistics {
  nearCells: number;
  midCells: number;
  treeInstances: number;
  shrubInstances: number;
  rockInstances: number;
  clutterInstances: number;
  groundCoverInstances: number;
}

interface DesiredCell {
  readonly key: string;
  readonly cellX: number;
  readonly cellZ: number;
  readonly distance: number;
  readonly lod: DetailLod;
  readonly priority: number;
}

interface ResidentCell {
  readonly cell: GeneratedDetailCell;
  /**
   * Canopy rank of each stem in `cell.trees`, in [0, 1): 0 is the widest
   * crown in the cell. This — not the placement's uniform `selection` key —
   * is what the rendered-share thinning compares against. See
   * {@link canopyRankOrder}.
   */
  readonly treeCanopyRank: Float32Array;
  lod: DetailLod;
  distance: number;
}

/**
 * Rendered-share thinning selects THE CANOPY, not a random sample of the
 * forest (perf-debt pass).
 *
 * The ecological field authors ~400 stems/ha of closed forest across every
 * age class — measured mean crown radius 3.40 m, median 3.15 m, p90 1.78 m:
 * mostly saplings, as a real stand is. Thinning that to the law's ~70
 * rendered stems/ha by a UNIFORM key keeps saplings and dominants in equal
 * proportion, and the drawn stand's crown cover comes out at 0.26 against
 * Gate 2C's 0.55 criterion — the criterion was never automated, so this went
 * unseen through the whole of Phase 2. Ranking by crown radius instead draws
 * the 70/ha widest crowns (measured mean radius 5.80 m, cover 0.53-0.56),
 * which is exactly the "60-80 stems/ha with 6-7 m crowns" the law's own
 * comment was priced against, and it is what a canopy IS: from the air you
 * see the dominant stems, not the understory beneath them.
 *
 * The key keeps every property D-2 requires of `selection`: deterministic,
 * uniform on [0, 1) by construction (it is a rank quotient), and NESTING —
 * raising the share only ever adds stems, so a band boundary can never make
 * a tree disappear and reappear. `selection` itself is untouched and stays
 * the appearance hash (character modifier, lean, geometry variant, view
 * phase), so nothing about how a drawn tree LOOKS moves with this.
 */
export function canopyRankOrder(
  trees: readonly { readonly crownRadiusMeters: number; readonly selection: number }[],
): Float32Array {
  const order = new Float32Array(trees.length);
  if (trees.length === 0) return order;
  const indices = trees.map((_, index) => index);
  indices.sort((first, second) => {
    const wide = trees[second]!.crownRadiusMeters - trees[first]!.crownRadiusMeters;
    if (wide !== 0) return wide;
    // Deterministic tie-break; equal radii are common at the quantised end.
    return trees[first]!.selection - trees[second]!.selection;
  });
  for (let rank = 0; rank < indices.length; rank += 1) {
    order[indices[rank]!] = rank / trees.length;
  }
  return order;
}

export interface WorldDetailRuntimeOptions {
  readonly worldSeed: string | number;
  readonly terrainSample: DetailTerrainSampler;
  readonly cellSizeMeters?: number;
  /** Sea level anchoring the density field's shoreline/treeline (1B-7). */
  readonly seaLevelMeters?: number;
  /** 2-13a: world latitude for the seasonal kernel. Default 45°N. */
  readonly latitudeDegrees?: number;
  /**
   * Enables off-main-thread generation (1B-10): the worker rebuilds the same
   * world from this seed and streams cells back. Omit it (tests, headless
   * tools) and generation stays inline and synchronous.
   */
  readonly workerWorldSeed?: string | number;
  /** Full live world preserves explicit evolution mode and authored airports in the worker. */
  readonly workerWorld?: Readonly<WorldDefinition>;
}

/**
 * Updates a released instance allocation must sit before another batch may
 * write into it — long enough for the previous owner's last submitted draw
 * to have retired, at ~60 Hz.
 */
export const DETAIL_INSTANCE_BUFFER_REUSE_GRACE_UPDATES = 8;

/**
 * 2-14: width of the dither-crossfade window at the near/mid and mid/far
 * boundaries, and of the cull fade at the vegetation edge. Both clear the
 * 128 m generation cell so per-stem fades sweep smoothly across rebuild
 * granularity.
 */
export const DETAIL_FADE_MARGIN_METERS = 160;
export const DETAIL_CULL_FADE_MARGIN_METERS = 420;

/**
 * 2-16: ground-cover patch expansion. Candidates sit on a hash-jittered
 * 2 m grid (≈ the plan's 2.5 m² patch footprint); acceptance is the 1/d
 * ramp — full density inside 20% of the grass radius, thinning as
 * (0.2·R)/d beyond it, dither-faded over the last 30 m. At the tier-2
 * 220 m radius the integral is ≈ 13.7k patches ≈ 0.66 M triangles,
 * inside the plan's ≤ 0.9 M Balanced exit budget.
 */
export const GROUND_COVER_CANDIDATE_SPACING_METERS = 2;
/**
 * 2-17 close: chunk rebuilds amortized to ONE per update — a rebuild frame
 * carries base render (~30 ms on the capture rig) plus the chunk's append
 * and upload; at three chunks the spike crossed the 41 ms hitch line, at
 * one it stays under. The sweep takes proportionally longer to converge,
 * which the membership slack absorbs.
 */
export const DETAIL_CHUNK_REBUILDS_PER_UPDATE = 1;
/**
 * 2-17 close: how far the observer may travel before a stem's band
 * memberships could be wrong — the observer signature quantum must stay
 * below this. Fades themselves are fragment-computed and continuous.
 */
export const DETAIL_MEMBERSHIP_SLACK_METERS = 96;
export const GROUND_COVER_EDGE_FADE_METERS = 30;
export const GROUND_COVER_FULL_DENSITY_SHARE = 0.2;

/**
 * The one far-band prototype since the perf-debt pass. Every species draws
 * through it; the instance record carries which one.
 */
export const TREE_IMPOSTOR_PROTOTYPE_KEY = "tree-impostor";

/** Row of the plugin's per-species impostor table for a species. */
function impostorSpeciesSlot(species: TreeSpecies): number {
  const index = IMPOSTOR_SPECIES.indexOf(species);
  return index < 0 ? 0 : index;
}

/** Pure 2D hash for candidate jitter/acceptance (world-position keyed). */
function groundCoverHash(x: number, z: number, lane: number): number {
  let h = (Math.imul(Math.round(x * 8), 0x27d4_eb2d)
    ^ Math.imul(Math.round(z * 8), 0x1656_67b1)
    ^ Math.imul(lane + 1, 0x9e37_79b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return ((h ^ (h >>> 14)) >>> 0) / 4_294_967_296;
}

const TREE_SPECIES: readonly TreeSpecies[] = [
  "pine",
  "cedar",
  "spruce",
  "oak",
  "maple",
  "birch",
  "willow",
];
const SHRUB_SPECIES: readonly ShrubSpecies[] = ["juniper", "hazel", "sage"];
const ROCK_VARIANTS: readonly RockVariant[] = ["granite", "limestone", "dark"];

const ZERO_STATISTICS: WorldDetailStatistics = Object.freeze({
  residentCells: 0,
  nearCells: 0,
  midCells: 0,
  generatedCells: 0,
  treeInstances: 0,
  shrubInstances: 0,
  rockInstances: 0,
  clutterInstances: 0,
  groundCoverInstances: 0,
  renderedThinInstances: 0,
  activeBatches: 0,
});

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function distanceToCell(
  x: number,
  z: number,
  cellX: number,
  cellZ: number,
  cellSize: number,
): number {
  const minX = cellX * cellSize;
  const minZ = cellZ * cellSize;
  const maxX = minX + cellSize;
  const maxZ = minZ + cellSize;
  return Math.hypot(Math.max(minX - x, 0, x - maxX), Math.max(minZ - z, 0, z - maxZ));
}

function profileCellBudget(profile: WebGpuQualityProfile): number {
  if (profile.vegetationDistance <= 2_500 || profile.vegetationDensity <= 0.5) return 128;
  if (profile.vegetationDistance <= 5_000 || profile.vegetationDensity <= 0.8) return 384;
  return 896;
}

/**
 * Paged natural/settlement detail built entirely from Babylon meshes and thin
 * instances. Generation is incremental; normal per-frame updates become no-ops
 * until the observer crosses a paging/LOD boundary or the floating origin moves.
 */
export class WorldDetailRuntime {
  private readonly batches = new Map<string, DetailBatch>();
  private readonly retiredBatches: RetiredDetailBatch[] = [];
  private readonly instanceBufferPool: PooledInstanceBuffers[] = [];
  private readonly prototypes = new Map<string, DetailPrototype>();
  private readonly presentationChunks = new Map<string, DetailPresentationChunk>();
  private readonly materials = new Set<PBRMaterial>();
  private readonly instancePlugins = new Set<DetailInstanceMaterialPlugin>();
  private readonly pluginByMaterial = new Map<PBRMaterial, DetailInstanceMaterialPlugin>();
  /** 2-12: crown/trunk radius-per-height per species, from the built prototypes. */
  private readonly crownAspects = new Map<TreeSpecies, number>();
  private readonly trunkAspects = new Map<TreeSpecies, number>();
  /** 2-12b: shrub radius-per-height per species, same convention. */
  private readonly shrubAspects = new Map<ShrubSpecies, number>();
  /** 2-12: the atlas (null under NullEngine — no raw 2D-array support). */
  private foliageAtlas: FoliageAtlas | null = null;
  /** 2-17: the impostor atlas (same NullEngine guard). */
  private impostorAtlas: ImpostorAtlas | null = null;
  /** 2-17 close: plugins whose tree bands use fragment-computed fades. */
  private readonly bandFadePlugins = new Set<DetailInstanceMaterialPlugin>();
  /** 2-17 close: law/grass radii last used, for frontier classification. */
  private lastDensityLaw: RenderedDensityLaw = RENDERED_DENSITY_LAWS[1]!;
  private lastGrassRadius = 150;
  private readonly cells = new Map<string, ResidentCell>();
  private desiredCells: readonly DesiredCell[] = [];
  private desiredKeys = new Set<string>();
  private signature = "";
  private density = Number.NaN;
  private cumulativeGeneratedCells = 0;
  private statisticsValue = ZERO_STATISTICS;
  private batchesDirty = true;
  private windTimeSeconds = 0;
  private updateSequence = 0;
  /** 2-14: observer position at the last rebuild, for per-stem fade radii. */
  private observerX = 0;
  private observerZ = 0;
  /** R-13: the environment clock's day, forwarded to cell generation. */
  private dayOfYear = 0;
  /** Governor B lever 2 (1A-6b): tightens the per-frame generation slice. */
  private generationBudgetCap: DetailGenerationBudget | null = null;
  /** Null when generation is inline; the 1B-10 worker client otherwise. */
  private client: DetailGenerationClient | null = null;
  /** Mirrors the consumer authority's bounded L0 ring for aux-arrival gating. */
  private readonly terrainPageAddresses: string[] = [];
  /** Desired keys with a request in flight, mapped to their request ids. */
  private readonly pendingCells = new Map<string, number>();
  /** Bumped whenever resident cells reset; stale worker results are dropped. */
  private cellEpoch = 0;
  /** `4.5-C1`: the tier datum, refreshed from the profile every update. */
  private vegetationCastsShadows = true;
  private disposed = false;

  readonly cellSizeMeters: number;

  constructor(
    private readonly scene: Scene,
    private readonly options: WorldDetailRuntimeOptions,
  ) {
    this.cellSizeMeters = options.cellSizeMeters ?? DEFAULT_DETAIL_CELL_SIZE_METERS;
    if (
      !Number.isFinite(this.cellSizeMeters) ||
      this.cellSizeMeters < 64 ||
      this.cellSizeMeters > 4_096
    ) {
      throw new RangeError("Detail runtime cell size must be between 64 and 4096 metres");
    }
    this.createBatches();
    if (options.workerWorldSeed !== undefined) {
      this.client = new DetailGenerationClient(
        {
          worldSeed: options.workerWorldSeed,
          ...(options.workerWorld ? { world: options.workerWorld } : {}),
          cellSizeMeters: this.cellSizeMeters,
          seaLevelMeters: options.seaLevelMeters ?? 0,
        },
        () => {
          // Worker died: fall back to inline generation on the next update.
          this.client = null;
          this.pendingCells.clear();
        },
      );
    }
  }

  /**
   * Governor B lever 2: cap the per-frame generation slice below the
   * profile's own budget. Null restores the profile default.
   */
  setGenerationBudgetCap(cap: DetailGenerationBudget | null): void {
    this.generationBudgetCap = cap;
  }

  /** Transfer the canonical macro fallback into the off-thread placement authority. */
  publishTerrainMacro(macro: TerrainMacroGrid): boolean {
    return this.client?.publishTerrainMacro(macro) ?? false;
  }

  /** Transfer one final L0 page into the off-thread placement authority. */
  publishTerrainPage(page: TerrainPagePublication): boolean {
    const published = this.client?.publishTerrainPage(page) ?? false;
    if (page.level !== 0) return published;

    const address = `${page.tileX}:${page.tileZ}`;
    const previousIndex = this.terrainPageAddresses.indexOf(address);
    if (previousIndex >= 0) this.terrainPageAddresses.splice(previousIndex, 1);
    this.terrainPageAddresses.push(address);
    if (this.terrainPageAddresses.length > TERRAIN_READBACK_RING_CAPACITY) {
      this.terrainPageAddresses.shift();
    }
    this.invalidateTerrainPage(page.tileX, page.tileZ);
    return published;
  }

  /**
   * Transfer one committed signed-shore page. An early aux-only arrival is
   * retained by the worker authority but cannot invalidate/cache a cell until
   * its matching final height page has arrived.
   */
  publishTerrainAuxPage(page: TerrainAuxPagePublication): boolean {
    const published = this.client?.publishTerrainAuxPage(page) ?? false;
    if (
      page.level === 0
      && this.terrainPageAddresses.includes(`${page.tileX}:${page.tileZ}`)
    ) {
      this.invalidateTerrainPage(page.tileX, page.tileZ);
    }
    return published;
  }

  private invalidateTerrainPage(tileX: number, tileZ: number): void {

    // Macro-authored cells are already evolved, but the final L0 page owns
    // local incision/detail and signed shoreline. Retire only overlapping
    // cells and requests so their next generation uses the complete product.
    const minimumX = tileX * WORLD_PAGE_BASE_EXTENT_METERS;
    const minimumZ = tileZ * WORLD_PAGE_BASE_EXTENT_METERS;
    const maximumX = minimumX + WORLD_PAGE_BASE_EXTENT_METERS;
    const maximumZ = minimumZ + WORLD_PAGE_BASE_EXTENT_METERS;
    const overlapsPage = (cellX: number, cellZ: number): boolean => {
      const cellMinimumX = cellX * this.cellSizeMeters;
      const cellMinimumZ = cellZ * this.cellSizeMeters;
      return cellMinimumX < maximumX
        && cellMinimumX + this.cellSizeMeters > minimumX
        && cellMinimumZ < maximumZ
        && cellMinimumZ + this.cellSizeMeters > minimumZ;
    };
    let invalidated = false;
    for (const [key, resident] of this.cells) {
      if (!overlapsPage(resident.cell.cellX, resident.cell.cellZ)) continue;
      this.cells.delete(key);
      invalidated = true;
    }
    for (const desired of this.desiredCells) {
      if (!overlapsPage(desired.cellX, desired.cellZ)) continue;
      const requestId = this.pendingCells.get(desired.key);
      if (requestId === undefined) continue;
      this.client?.cancel(requestId);
      this.pendingCells.delete(desired.key);
      invalidated = true;
    }
    if (invalidated) this.batchesDirty = true;
  }

  /**
   * R-13: the environment clock's day, forwarded to cell generation. The
   * density field is deliberately season-invariant today (stems do not move
   * with the calendar), so a change does not invalidate resident cells —
   * `2-13a`'s appearance field is the first consumer that reads it.
   */
  setDayOfYear(dayOfYear: number): void {
    this.dayOfYear = dayOfYear;
    // 2-17a: the impostor buckets cross-fade on the same shed window as the
    // card dissolve (applyFoliageSeason's 0.34–0.7 winterFraction ramp).
    const winter = seasonalWinterFraction(dayOfYear, this.options.latitudeDegrees ?? 45);
    const t = Math.min(1, Math.max(0, (winter - 0.34) / 0.36));
    const mix = t * t * (3 - 2 * t);
    for (const plugin of this.instancePlugins) plugin.setImpostorSeason(mix);
  }

  /** Marks a material's plugin as tree-band shader-faded (2-17 close). */
  private registerBandFadeMaterial(material: PBRMaterial): void {
    const plugin = this.materialPlugin(material);
    if (!plugin) return;
    this.bandFadePlugins.add(plugin);
    // Placeholder radii until the first update supplies the profile's law.
    plugin.setBandFades(400, 1_400, 8_000);
  }

  /** 2-13: the frame's wind snapshot, forwarded to every instance plugin. */
  setWind(directionX: number, directionZ: number, strength: number, gust: number): void {
    for (const plugin of this.instancePlugins) {
      plugin.setWind(directionX, directionZ, strength, gust);
    }
  }

  /**
   * 2-12's translucency term (the recorded gap the perf-debt pass closes):
   * the frame's key light, forwarded from `AtmosphereSystem`'s snapshot on
   * exactly the wind field's pattern. Vegetation consumes the lighting
   * owner's published direction and radiance; it does not define a sun.
   */
  setKeyLight(
    directionX: number,
    directionY: number,
    directionZ: number,
    radiance: readonly [number, number, number],
    strength: number,
  ): void {
    for (const plugin of this.instancePlugins) {
      plugin.setKeyLight(directionX, directionY, directionZ, radiance, strength);
    }
  }

  get statistics(): WorldDetailStatistics {
    return this.statisticsValue;
  }

  update(
    observer: WorldDetailObserver,
    floatingOrigin: DetailFloatingOrigin,
    profile: WebGpuQualityProfile,
    simulationTimeSeconds?: number,
  ): void {
    if (this.disposed) return;
    this.updateSequence += 1;
    this.vegetationCastsShadows = profile.vegetationCastsShadows;
    this.disposeExpiredBatches();
    // Wind phase rides the caller's SIMULATION clock when provided (Z-1):
    // a wall-clock accumulator made every tree's sway phase depend on how
    // long streaming took on that particular run — the perf capture pins
    // simulationTime exactly so reruns are pixel-comparable, and the sway
    // must be a function of it. The wall-clock fallback serves callers with
    // no simulation clock (dev harnesses).
    if (simulationTimeSeconds !== undefined && Number.isFinite(simulationTimeSeconds)) {
      this.windTimeSeconds = Math.max(0, simulationTimeSeconds);
      for (const plugin of this.instancePlugins) plugin.setTimeSeconds(this.windTimeSeconds);
    } else {
      const deltaMilliseconds = this.scene.getEngine().getDeltaTime();
      if (Number.isFinite(deltaMilliseconds)) {
        this.windTimeSeconds += clamp(deltaMilliseconds, 0, 100) / 1_000;
        for (const plugin of this.instancePlugins) plugin.setTimeSeconds(this.windTimeSeconds);
      }
    }
    requireFinite(observer.x, "Detail observer x");
    requireFinite(observer.y, "Detail observer y");
    requireFinite(observer.z, "Detail observer z");
    const velocityX = requireFinite(observer.velocityX ?? 0, "Detail observer x velocity");
    const velocityZ = requireFinite(observer.velocityZ ?? 0, "Detail observer z velocity");
    requireFinite(floatingOrigin.x, "Detail floating-origin x");
    requireFinite(floatingOrigin.y, "Detail floating-origin y");
    requireFinite(floatingOrigin.z, "Detail floating-origin z");
    // 67d: origin changes are corrected for every live batch immediately.
    // The amortized rebuild may still rewrite only one chunk this update;
    // stale records remain valid because their mesh carries the uniform
    // built-origin -> current-origin translation in the meantime.
    this.compensateBatchOrigins(floatingOrigin);
    if (!Number.isFinite(profile.vegetationDistance) || profile.vegetationDistance <= 0) {
      throw new RangeError("Vegetation distance must be finite and greater than zero");
    }
    if (
      !Number.isFinite(profile.vegetationDensity) ||
      profile.vegetationDensity < 0 ||
      profile.vegetationDensity > 2
    ) {
      throw new RangeError("Vegetation density must be between zero and two");
    }

    const speed = Math.hypot(velocityX, velocityZ);
    const lookAheadSeconds = speed > 1 ? Math.min(6, 1_200 / speed) : 0;
    const predictionX = observer.x + velocityX * lookAheadSeconds;
    const predictionZ = observer.z + velocityZ * lookAheadSeconds;
    const quantization = this.cellSizeMeters * 0.5;
    const nextSignature = [
      Math.floor(observer.x / quantization),
      Math.floor(observer.z / quantization),
      Math.floor(predictionX / this.cellSizeMeters),
      Math.floor(predictionZ / this.cellSizeMeters),
      floatingOrigin.x,
      floatingOrigin.y,
      floatingOrigin.z,
      profile.vegetationDistance,
      profile.vegetationDensity,
    ].join(":");

    if (profile.vegetationDensity !== this.density) {
      this.density = profile.vegetationDensity;
      this.cells.clear();
      this.cellEpoch += 1;
      this.pendingCells.clear();
      this.client?.cancelAll();
      this.batchesDirty = true;
    }
    if (nextSignature !== this.signature) {
      this.signature = nextSignature;
      this.planCells(observer, predictionX, predictionZ, profile);
      this.batchesDirty = true;
    }

    for (const desired of this.desiredCells) {
      const resident = this.cells.get(desired.key);
      if (resident) {
        if (resident.lod !== desired.lod || resident.distance !== desired.distance) {
          resident.lod = desired.lod;
          resident.distance = desired.distance;
          this.batchesDirty = true;
        }
      }
    }

    if (this.client !== null) {
      // 1B-10: generation happens on the worker; the main thread only files
      // requests (streaming-priority ordered by the bounded queue) and
      // applies results as they arrive. The Governor B budget cap survives
      // as the request-admission bound.
      const requestCap = this.generationBudgetCap?.maximumCells ?? Number.POSITIVE_INFINITY;
      let admitted = 0;
      for (const desired of this.desiredCells) {
        if (admitted >= requestCap) break;
        if (this.cells.has(desired.key) || this.pendingCells.has(desired.key)) continue;
        const epoch = this.cellEpoch;
        const requestId = this.client.request(
          {
            key: desired.key,
            generation: epoch,
            priority: desired.priority,
            cellX: desired.cellX,
            cellZ: desired.cellZ,
            densityMultiplier: profile.vegetationDensity,
            dayOfYear: this.dayOfYear,
          },
          (cell) => this.onCellGenerated(desired.key, epoch, cell),
          () => this.pendingCells.delete(desired.key),
        );
        if (requestId < 0) break;
        this.pendingCells.set(desired.key, requestId);
        admitted += 1;
      }
    } else {
      const resolvedBudget = resolveDetailGenerationBudget(profile);
      const cap = this.generationBudgetCap;
      // The governor cap can only shrink the profile's own slice, never grow it.
      const generationBudget = cap === null ? resolvedBudget : {
        maximumCells: Math.min(resolvedBudget.maximumCells, cap.maximumCells),
        maximumMilliseconds: Math.min(resolvedBudget.maximumMilliseconds, cap.maximumMilliseconds),
      };
      const generationStartedAt = this.nowMilliseconds();
      let generated = 0;
      for (const desired of this.desiredCells) {
        if (this.cells.has(desired.key)) continue;
        const elapsedMilliseconds = generated === 0
          ? 0
          : Math.max(0, this.nowMilliseconds() - generationStartedAt);
        if (!canGenerateNextDetailCell(generated, elapsedMilliseconds, generationBudget)) break;
        const cell = generateDetailCell({
          worldSeed: this.options.worldSeed,
          cellX: desired.cellX,
          cellZ: desired.cellZ,
          cellSizeMeters: this.cellSizeMeters,
          densityMultiplier: profile.vegetationDensity,
          terrainSample: this.options.terrainSample,
          seaLevelMeters: this.options.seaLevelMeters ?? 0,
          dayOfYear: this.dayOfYear,
          latitudeDegrees: this.options.latitudeDegrees ?? 45,
        });
        this.cells.set(desired.key, {
          cell,
          treeCanopyRank: canopyRankOrder(cell.trees),
          lod: desired.lod,
          distance: desired.distance,
        });
        this.cumulativeGeneratedCells += 1;
        generated += 1;
        this.batchesDirty = true;
      }
    }

    for (const plugin of this.bandFadePlugins) {
      plugin.setBandFades(
        profile.renderedDensityLaw.near.outerRadiusMeters,
        profile.renderedDensityLaw.mid.outerRadiusMeters,
        profile.renderedDensityLaw.far.outerRadiusMeters,
      );
    }
    if (this.batchesDirty) {
      this.observerX = observer.x;
      this.observerZ = observer.z;
      // Stays dirty while the amortized sweep has a backlog.
      this.batchesDirty = this.rebuildBatches(floatingOrigin, profile);
    } else {
      // Camera rotation does not affect paging signatures, but it does change
      // which spatial chunks Babylon submits to the main view.
      this.refreshVisibilityStatistics();
    }
  }

  /**
   * Supplies active, deliberately bounded shadow batches to a CSM or shadow
   * generator.
   *
   * `4.5-C1`: the tier's `vegetationCastsShadows` datum gates the whole list.
   * The near band submits every (species, variant, crown/trunk) mesh once per
   * cascade, which is 148 of tier 1's 347 modelled draws and 3.85 of its 9.02
   * modelled milliseconds — the largest single term, and the only one no lever
   * §5.3 governs can move. Read from the profile each update rather than
   * baked into the prototypes so a runtime quality switch takes effect in the
   * same frame, in both directions.
   */
  addShadowCasters(add: (mesh: Mesh) => void): void {
    if (this.disposed || !this.vegetationCastsShadows) return;
    for (const batch of this.batches.values()) {
      if (batch.castsShadows && batch.mesh.isEnabled() && batch.mesh.forcedInstanceCount > 0) {
        add(batch.mesh);
      }
    }
  }

  /** Visits the fixed shared PBR material set; thin-instance chunks add none. */
  addPbrMaterials(add: (material: PBRMaterial) => void): void {
    if (this.disposed) return;
    for (const material of this.materials) add(material);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.client?.dispose();
    this.client = null;
    this.pendingCells.clear();
    this.cells.clear();
    this.desiredCells = [];
    this.desiredKeys.clear();
    for (const batch of this.batches.values()) {
      batch.mesh.dispose(false, false);
      batch.gpu?.shared.dispose();
      batch.gpu = null;
    }
    this.batches.clear();
    for (const retired of this.retiredBatches) {
      retired.batch.mesh.dispose(false, false);
      retired.batch.gpu?.shared.dispose();
      retired.batch.gpu = null;
    }
    this.retiredBatches.length = 0;
    for (const pooled of this.instanceBufferPool) pooled.gpu.shared.dispose();
    this.instanceBufferPool.length = 0;
    this.presentationChunks.clear();
    for (const prototype of this.prototypes.values()) prototype.mesh.dispose(false, false);
    this.prototypes.clear();
    this.instancePlugins.clear();
    this.pluginByMaterial.clear();
    this.foliageAtlas?.texture.dispose();
    this.foliageAtlas = null;
    for (const material of this.materials) material.dispose(true, true);
    this.materials.clear();
    this.statisticsValue = ZERO_STATISTICS;
  }

  private planCells(
    observer: WorldDetailObserver,
    predictionX: number,
    predictionZ: number,
    profile: WebGpuQualityProfile,
  ): void {
    const radius = profile.vegetationDistance;
    const minCellX = Math.floor((Math.min(observer.x, predictionX) - radius) / this.cellSizeMeters);
    const maxCellX = Math.floor((Math.max(observer.x, predictionX) + radius) / this.cellSizeMeters);
    const minCellZ = Math.floor((Math.min(observer.z, predictionZ) - radius) / this.cellSizeMeters);
    const maxCellZ = Math.floor((Math.max(observer.z, predictionZ) + radius) / this.cellSizeMeters);
    // R-21: the near residency boundary is the law's full-geometry band.
    const nearDistance = Math.min(
      profile.renderedDensityLaw.near.outerRadiusMeters,
      radius * 0.34,
    );
    const candidates: DesiredCell[] = [];
    const travelDistance = Math.hypot(predictionX - observer.x, predictionZ - observer.z);

    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        const distance = distanceToCell(
          observer.x,
          observer.z,
          cellX,
          cellZ,
          this.cellSizeMeters,
        );
        const predictedDistance = distanceToCell(
          predictionX,
          predictionZ,
          cellX,
          cellZ,
          this.cellSizeMeters,
        );
        if (distance > radius && predictedDistance > radius * 0.72) continue;
        candidates.push({
          key: detailCellKey(cellX, cellZ),
          cellX,
          cellZ,
          distance,
          lod: distance <= nearDistance ? "near" : "mid",
          priority: Math.min(distance, predictedDistance * 0.78 + travelDistance * 0.08),
        });
      }
    }
    candidates.sort((first, second) => first.priority - second.priority || first.key.localeCompare(second.key));
    this.desiredCells = candidates.slice(0, profileCellBudget(profile));
    this.desiredKeys = new Set(this.desiredCells.map((candidate) => candidate.key));
    for (const key of this.cells.keys()) {
      if (!this.desiredKeys.has(key)) this.cells.delete(key);
    }
    for (const [key, requestId] of this.pendingCells) {
      if (this.desiredKeys.has(key)) continue;
      this.client?.cancel(requestId);
      this.pendingCells.delete(key);
    }
  }

  /** Applies one worker-generated cell; stale epochs and keys are dropped. */
  private onCellGenerated(key: string, epoch: number, cell: GeneratedDetailCell): void {
    this.pendingCells.delete(key);
    if (this.disposed || epoch !== this.cellEpoch || !this.desiredKeys.has(key)) return;
    const desired = this.desiredCells.find((candidate) => candidate.key === key);
    this.cells.set(key, {
      cell,
      treeCanopyRank: canopyRankOrder(cell.trees),
      lod: desired?.lod ?? "mid",
      distance: desired?.distance ?? Number.POSITIVE_INFINITY,
    });
    this.cumulativeGeneratedCells += 1;
    this.batchesDirty = true;
  }

  private rebuildBatches(
    floatingOrigin: DetailFloatingOrigin,
    profile: WebGpuQualityProfile,
  ): boolean {
    let rebuildsThisUpdate = 0;
    let rebuildBacklog = false;
    this.lastDensityLaw = profile.renderedDensityLaw;
    this.lastGrassRadius = profile.grassRadiusMeters;
    const grouped = new Map<
      string,
      { coordinates: DetailPresentationChunkCoordinates; residents: ResidentCell[] }
    >();
    for (const resident of this.cells.values()) {
      const coordinates = detailPresentationChunkCoordinates(
        resident.cell.cellX,
        resident.cell.cellZ,
      );
      const group = grouped.get(coordinates.key);
      if (group) group.residents.push(resident);
      else grouped.set(coordinates.key, { coordinates, residents: [resident] });
    }

    for (const [chunkKey, chunk] of this.presentationChunks) {
      if (!grouped.has(chunkKey)) this.disposePresentationChunk(chunk);
    }

    // Rendered-share thinning: the density field carries the ECOLOGICAL stem
    // density (300–800/ha closed forest); the R-21 rendered-density LAW
    // (renderedDensity.ts, the one authority 2-12/2-14/2-17 also read)
    // decides what fraction is drawn at each range. The near cap IS the
    // crown-closure density, so closed-forest cells keep their interiors
    // while open cells render everything they authored (they sit under the
    // cap) — the per-cell cap, not a global scalar, is what preserves
    // clumps. Selection is a stable per-stem uniform, so shares nest:
    // raising the budget only ever ADDS stems.
    const densityLaw = profile.renderedDensityLaw;
    const totals: MutableDetailChunkStatistics = {
      nearCells: 0,
      midCells: 0,
      treeInstances: 0,
      shrubInstances: 0,
      rockInstances: 0,
      clutterInstances: 0,
      groundCoverInstances: 0,
        };

    for (const group of grouped.values()) {
      group.residents.sort((first, second) => first.cell.key.localeCompare(second.cell.key));
      const signature = [
        floatingOrigin.x,
        floatingOrigin.y,
        floatingOrigin.z,
        densityLaw.nearStemsPerHectare,
        densityLaw.near.outerRadiusMeters,
        profile.treeVariantCap,
        profile.grassRadiusMeters,
        // 2-17 close: the observer term applies ONLY to FRONTIER chunks —
        // those straddling a band or population edge, where memberships and
        // single-edge baked fades actually change with camera range. An
        // interior chunk (the bulk of the field) rebuilds only when its
        // residents change, restoring the zero-steady-state-rebuild design;
        // a naive global observer term rebuilt EVERY chunk each quantum and
        // the capture measured it as a saturated hitch train.
        this.chunkObserverTerm(group.coordinates),
        ...group.residents.map((resident) => `${resident.cell.key}/${resident.lod}`),
      ].join(":");
      let chunk = this.presentationChunks.get(group.coordinates.key);
      if (!chunk) {
        chunk = {
          coordinates: group.coordinates,
          batchKeys: new Set<string>(),
          signature: "",
          revision: 0,
          statistics: {
            nearCells: 0,
            midCells: 0,
            treeInstances: 0,
            shrubInstances: 0,
            rockInstances: 0,
            clutterInstances: 0,
            groundCoverInstances: 0,
                    },
        };
        this.presentationChunks.set(group.coordinates.key, chunk);
      }
      if (chunk.signature !== signature) {
        // Amortized: at most DETAIL_CHUNK_REBUILDS_PER_UPDATE chunks rebuild
        // per frame — the 64 m observer quantum otherwise rebuilt every
        // chunk in ONE update and the capture measured it as a hitch train
        // (39-147 per 240 frames at approach speeds). Skipped chunks keep
        // their stale signature and rebuild on the following updates;
        // batchesDirty stays set so the sweep continues.
        if (rebuildsThisUpdate >= DETAIL_CHUNK_REBUILDS_PER_UPDATE) {
          rebuildBacklog = true;
        } else {
          rebuildsThisUpdate += 1;
          chunk.statistics = this.rebuildPresentationChunk(
            chunk,
            group.residents,
            floatingOrigin,
            densityLaw,
            profile.treeVariantCap,
            profile.grassRadiusMeters,
          );
          chunk.signature = signature;
        }
      }
      totals.nearCells += chunk.statistics.nearCells;
      totals.midCells += chunk.statistics.midCells;
      totals.treeInstances += chunk.statistics.treeInstances;
      totals.shrubInstances += chunk.statistics.shrubInstances;
      totals.rockInstances += chunk.statistics.rockInstances;
      totals.clutterInstances += chunk.statistics.clutterInstances;
      totals.groundCoverInstances += chunk.statistics.groundCoverInstances;
    }

    this.statisticsValue = {
      residentCells: this.cells.size,
      nearCells: totals.nearCells,
      midCells: totals.midCells,
      generatedCells: this.cumulativeGeneratedCells,
      treeInstances: totals.treeInstances,
      shrubInstances: totals.shrubInstances,
      rockInstances: totals.rockInstances,
      clutterInstances: totals.clutterInstances,
      groundCoverInstances: totals.groundCoverInstances,
      renderedThinInstances: 0,
      activeBatches: 0,
    };
    this.refreshVisibilityStatistics();
    return rebuildBacklog;
  }

  private rebuildPresentationChunk(
    chunk: DetailPresentationChunk,
    residents: readonly ResidentCell[],
    floatingOrigin: DetailFloatingOrigin,
    densityLaw: RenderedDensityLaw,
    treeVariantCap: number,
    grassRadiusMeters: number,
  ): DetailChunkStatistics {
    chunk.revision += 1;
    const nextBatchKeys = new Set<string>();
    const statistics: MutableDetailChunkStatistics = {
      nearCells: 0,
      midCells: 0,
      treeInstances: 0,
      shrubInstances: 0,
      rockInstances: 0,
      clutterInstances: 0,
      groundCoverInstances: 0,
        };

    for (const resident of residents) {
      if (resident.lod === "near") statistics.nearCells += 1;
      else statistics.midCells += 1;

      const cellHectares = (resident.cell.cellSizeMeters * resident.cell.cellSizeMeters) / 10_000;
      const stemsPerHa = resident.cell.trees.length / Math.max(cellHectares, 1e-6);
      // R-21: the law's share curve, keyed on real cell distance. Until 2-14
      // and 2-17 land their card/impostor bands, mid- and far-band stems draw
      // with today's mid geometry — the density is final, the geometry per
      // band arrives with its item.
      const treeBudgetPerHa = densityLaw.nearStemsPerHectare
        * renderedShareAtDistance(densityLaw, resident.distance);
      const treeShare = Math.min(1, treeBudgetPerHa / Math.max(stemsPerHa, 1e-6));
      // Shrubs are woody plants: they ride the SAME law falloff as trees
      // (the pre-law 60-near/6-mid share admitted 137k icosphere shrubs to
      // 8 km — 11M triangles of sub-pixel blobs, +6-15 ms GPU on every
      // shot), plus a hard cutoff at the mid boundary: understory at 1.4 km
      // subtends under half a pixel. 2-12b re-prices the geometry to cards.
      const shrubsPerHa = resident.cell.shrubs.length / Math.max(cellHectares, 1e-6);
      const shrubBudgetPerHa = 60 * renderedShareAtDistance(densityLaw, resident.distance);
      const shrubShare = resident.distance > densityLaw.mid.outerRadiusMeters
        ? 0
        : Math.min(1, shrubBudgetPerHa / Math.max(shrubsPerHa, 1e-6));

      for (let treeIndex = 0; treeIndex < resident.cell.trees.length; treeIndex += 1) {
        const tree = resident.cell.trees[treeIndex]!;
        // Canopy rank, not the uniform selection key — see canopyRankOrder.
        if ((resident.treeCanopyRank[treeIndex] ?? 1) > treeShare) continue;
        const localX = tree.x - floatingOrigin.x;
        const localY = tree.y - floatingOrigin.y;
        const localZ = tree.z - floatingOrigin.z;
        // 2-14: banding by the LAW's radii from the STEM'S OWN distance,
        // with dither-crossfade margins — a stem inside a margin appears in
        // BOTH bands with exactly complementary fade bytes (two-LOD
        // residency; the outgoing side disappears with the next rebuild
        // past the margin). Also the cull fade at the far edge.
        const stemDistance = Math.hypot(
          tree.x - this.observerX,
          tree.z - this.observerZ,
        );
        const memberships = WorldDetailRuntime.fadeBandMemberships(stemDistance, densityLaw);
        if (memberships.length === 0) continue;
        const modifierHash = (tree.selection * 137.3) % 1;
        const modifierBits = modifierHash < 0.55 ? 0
          : modifierHash < 0.70 ? 1
          : modifierHash < 0.82 ? 3
          : modifierHash < 0.92 ? 2
          : 4;
        // Per-instance lean of 2-8 degrees composed into the quaternion.
        const leanRadians = (0.035 + ((tree.selection * 29.3) % 1) * 0.105);
        const leanAzimuth = ((tree.selection * 53.9) % 1) * 2 * Math.PI;
        const quaternion = WorldDetailRuntime.yawLeanQuaternion(
          tree.yawRadians,
          leanRadians,
          leanAzimuth,
        );
        const windPhase = tree.windPhaseRadians / (2 * Math.PI);
        const crownAspect = this.crownAspects.get(tree.species) ?? 0.3;
        const trunkAspect = this.trunkAspects.get(tree.species) ?? 0.02;
        const crownBase: DetailInstanceRecord = {
          x: localX,
          y: localY,
          z: localZ,
          quaternion,
          heightScaleMeters: tree.heightMeters,
          radialScale: WorldDetailRuntime.radialMultiplier(
            tree.crownRadiusMeters,
            tree.heightMeters,
            crownAspect,
          ),
          fade: 1,
          variant: modifierBits * 32,
          tint: tree.color,
          windPhase,
          windResponse: clamp(tree.windResponse, 0, 1),
        };
        const variantHash = (tree.selection * 71.7) % 1;
        for (const membership of memberships) {
          // Geometry variants cap per band (every (species, variant, band)
          // mesh is a draw per chunk at ~26 µs of GPU each — the 2-12
          // finding): far keeps ONE per species, mid three, near the
          // profile's cap. Per-instance scales and tint carry the variety
          // where the meshes collapse.
          const bandVariantCap = membership.band === "far" ? 1
            : membership.band === "mid" ? 3
            : treeVariantCap;
          const variantCount = clamp(
            Math.min(Math.round(TREE_VARIANT_COUNTS[tree.species]), treeVariantCap, bandVariantCap),
            1,
            32,
          );
          const geometryVariant = Math.min(
            variantCount - 1,
            Math.floor(variantHash * variantCount),
          );
          // Far band: geometry variants collapse to one mesh, so the
          // variant byte is FREE — it carries a per-stem hash instead, which
          // the impostor shader turns into a view-phase offset and a mirror
          // (the 2-17 exit criterion: no two same-species impostors within
          // a screen share both silhouette aspect and phase).
          // The fade lane carries the BAND CODE (0 near / 1 mid / 2 far):
          // the fragment computes the actual crossfade window from its own
          // camera range (DETAIL_BAND_FADES).
          const bandCode = membership.band === "near" ? 0 : membership.band === "mid" ? 1 : 2;
          const crown: DetailInstanceRecord = {
            ...crownBase,
            fade: bandCode / 127,
            fadeIncoming: false,
            // Far band: the geometry variants collapse to one mesh, so the
            // byte is free for identity. High three bits = SPECIES (the
            // perf-debt pass's per-instance bake-frame index, which is what
            // lets one mesh serve all seven); low five = 2-17's per-stem
            // hash, whose bit 0 is the mirror and bits 1-2 the view phase.
            variant: membership.band === "far"
              ? impostorSpeciesSlot(tree.species) * 32
                + Math.floor(((tree.selection * 97.3) % 1) * 32)
              : geometryVariant + modifierBits * 32,
          };
          const crownBatchKey = membership.band === "far" && this.impostorAtlas
            ? TREE_IMPOSTOR_PROTOTYPE_KEY
            : `tree-${tree.species}-v${geometryVariant}-crown-${membership.band}`;
          this.appendInstance(
            this.getBatch(crownBatchKey, chunk, nextBatchKeys),
            crown,
          );
          // A trunk exists at near and mid — no floating crowns; the far
          // band's crossed cards carry the whole silhouette, so a trunk
          // crossfading at the mid/far boundary fades against them.
          if (membership.band !== "far") {
            this.appendInstance(
              this.getBatch(
                `tree-${tree.species}-v${geometryVariant}-trunk-${membership.band}`,
                chunk,
                nextBatchKeys,
              ),
              {
                ...crown,
                radialScale: WorldDetailRuntime.radialMultiplier(
                  tree.trunkRadiusMeters,
                  tree.heightMeters,
                  trunkAspect,
                ),
                windResponse: 0.08,
              },
            );
          }
        }
        statistics.treeInstances += 1;
      }

      for (const shrub of resident.cell.shrubs) {
        if (shrubShare <= 0 || shrub.selection > shrubShare) continue;
        // 2-12b: card shrubs with the tree pipeline's exact conventions —
        // geometry variant from the selection hash (both variants inside the
        // near band, one at mid: every (species, variant) mesh is a draw per
        // chunk, and mid shrubs are a few pixels), radial aspect from the
        // built prototype through the shared per-material uniform.
        const shrubDistance = Math.hypot(
          shrub.x - this.observerX,
          shrub.z - this.observerZ,
        );
        const shrubEdge = densityLaw.mid.outerRadiusMeters;
        if (shrubDistance >= shrubEdge) continue;
        // 2-14: shrubs fade out at their mid-boundary cutoff (nothing fades
        // in behind them — understory at that range is sub-pixel).
        const shrubFade = shrubDistance > shrubEdge - DETAIL_FADE_MARGIN_METERS
          ? (shrubEdge - shrubDistance) / DETAIL_FADE_MARGIN_METERS
          : 1;
        const shrubVariantCount = shrubDistance <= densityLaw.near.outerRadiusMeters
          ? SHRUB_VARIANT_COUNTS[shrub.species]
          : 1;
        const shrubVariant = Math.min(
          shrubVariantCount - 1,
          Math.floor(((shrub.selection * 71.7) % 1) * shrubVariantCount),
        );
        const shrubAspect = this.shrubAspects.get(shrub.species) ?? 0.4;
        this.appendInstance(
          this.getBatch(`shrub-${shrub.species}-v${shrubVariant}`, chunk, nextBatchKeys),
          {
            x: shrub.x - floatingOrigin.x,
            y: shrub.y - floatingOrigin.y,
            z: shrub.z - floatingOrigin.z,
            quaternion: yawQuaternion(shrub.yawRadians),
            heightScaleMeters: shrub.heightMeters,
            radialScale: WorldDetailRuntime.radialMultiplier(
              shrub.radiusMeters * (0.92 + shrub.selection * 0.12),
              shrub.heightMeters,
              shrubAspect,
            ),
            fade: shrubFade,
            fadeIncoming: false,
            variant: shrubVariant,
            tint: shrub.color,
            windPhase: shrub.windPhaseRadians / (2 * Math.PI),
            windResponse: clamp(shrub.windResponse, 0, 1),
          },
        );
        statistics.shrubInstances += 1;
      }

      for (const rock of resident.cell.rocks) {
        // 2-15: small rocks live in the near field, boulders (≥ 2.2 m,
        // thinned) reach the mid boundary — each with a 2-14 dither fade at
        // its own edge from the stem's true range.
        const rockDistance = Math.hypot(
          rock.x - this.observerX,
          rock.z - this.observerZ,
        );
        const bigRock = rock.radiusMeters >= 2.2 && rock.selection <= 0.22;
        const rockEdge = bigRock
          ? densityLaw.mid.outerRadiusMeters
          : densityLaw.near.outerRadiusMeters;
        if (rockDistance >= rockEdge) continue;
        const rockFade = rockDistance > rockEdge - DETAIL_FADE_MARGIN_METERS
          ? (rockEdge - rockDistance) / DETAIL_FADE_MARGIN_METERS
          : 1;
        this.appendInstance(
          this.getBatch(`rock-${rock.variant}`, chunk, nextBatchKeys),
          {
            x: rock.x - floatingOrigin.x,
            y: rock.y - floatingOrigin.y,
            z: rock.z - floatingOrigin.z,
            // ~60% terrain-normal alignment through the format's full
            // orientation (the reason the quaternion is in the record).
            quaternion: normalAlignedQuaternion(rock.normal, rock.yawRadians, 0.6),
            heightScaleMeters: rock.radiusMeters * rock.flattening,
            // Width recovery: x_world = proto·height·mult·aspect, so
            // mult = jitter / (1.1 · flattening · 1.4) — inside [0.5, 1.6]
            // across the 0.45–0.9 flattening spread at material aspect 1.4.
            radialScale: WorldDetailRuntime.radialMultiplier(
              rock.radiusMeters * (0.89 + rock.selection * 0.2),
              rock.radiusMeters * rock.flattening * 1.1,
              1.4,
            ),
            fade: rockFade,
            fadeIncoming: false,
            variant: 0,
            tint: rock.color,
            windPhase: 0,
            windResponse: 0,
          },
        );
        statistics.rockInstances += 1;
      }

      // 2-15: ground clutter — near field only (sub-metre debris is
      // invisible past the near boundary), aligned hard to the terrain
      // (logs lie on the ground: 85% blend), faded at the near edge.
      for (const piece of resident.cell.clutter) {
        const clutterDistance = Math.hypot(
          piece.x - this.observerX,
          piece.z - this.observerZ,
        );
        const clutterEdge = densityLaw.near.outerRadiusMeters;
        if (clutterDistance >= clutterEdge) continue;
        const clutterFade = clutterDistance > clutterEdge - DETAIL_FADE_MARGIN_METERS
          ? (clutterEdge - clutterDistance) / DETAIL_FADE_MARGIN_METERS
          : 1;
        this.appendInstance(
          this.getBatch(`clutter-${piece.clutterKind}`, chunk, nextBatchKeys),
          {
            x: piece.x - floatingOrigin.x,
            y: piece.y - floatingOrigin.y,
            z: piece.z - floatingOrigin.z,
            quaternion: normalAlignedQuaternion(piece.normal, piece.yawRadians, 0.85),
            heightScaleMeters: piece.sizeMeters,
            radialScale: 1,
            fade: clutterFade,
            fadeIncoming: false,
            variant: 0,
            tint: piece.color,
            windPhase: 0,
            windResponse: 0,
          },
        );
        statistics.clutterInstances += 1;
      }

      // 2-16: ground-cover expansion — the habitat grid says WHAT grows;
      // the 1/d ramp says how many patches the frame affords at each range
      // (screen-space blade density roughly constant, the grass radius is
      // the §5.3 tier knob). Candidate positions are world-hash keyed, so
      // they never slide with the observer; only acceptance re-thins.
      const grassRadius = grassRadiusMeters;
      if (resident.cell.groundCover.length > 0
        && resident.distance < grassRadius + this.cellSizeMeters) {
        const cell = resident.cell;
        const spacing = GROUND_COVER_CANDIDATE_SPACING_METERS;
        const nodeSpacing = cell.cellSizeMeters / GROUND_COVER_GRID;
        const fullDensityRadius = grassRadius * GROUND_COVER_FULL_DENSITY_SHARE;
        const columns = Math.floor(cell.cellSizeMeters / spacing);
        for (let row = 0; row < columns; row += 1) {
          for (let column = 0; column < columns; column += 1) {
            const baseX = cell.minX + (column + 0.5) * spacing;
            const baseZ = cell.minZ + (row + 0.5) * spacing;
            const jitterX = (groundCoverHash(baseX, baseZ, 0) - 0.5) * spacing;
            const jitterZ = (groundCoverHash(baseX, baseZ, 1) - 0.5) * spacing;
            const x = baseX + jitterX;
            const z = baseZ + jitterZ;
            const patchDistance = Math.hypot(x - this.observerX, z - this.observerZ);
            if (patchDistance >= grassRadius) continue;
            const ramp = Math.min(1, fullDensityRadius / Math.max(patchDistance, 1));
            const nodeColumn = Math.min(
              GROUND_COVER_GRID - 1,
              Math.max(0, Math.floor((x - cell.minX) / nodeSpacing)),
            );
            const nodeRow = Math.min(
              GROUND_COVER_GRID - 1,
              Math.max(0, Math.floor((z - cell.minZ) / nodeSpacing)),
            );
            const node = cell.groundCover[nodeRow * GROUND_COVER_GRID + nodeColumn];
            if (!node || node.coverage <= 0) continue;
            if (groundCoverHash(x, z, 2) >= ramp * node.coverage) continue;
            const heightHash = groundCoverHash(x, z, 3);
            const grassFade = patchDistance > grassRadius - GROUND_COVER_EDGE_FADE_METERS
              ? (grassRadius - patchDistance) / GROUND_COVER_EDGE_FADE_METERS
              : 1;
            // Bilinear height from the habitat grid — a terrainSample call
            // per candidate stalled whole frames on every 64 m rebuild.
            const gridU = clamp((x - cell.minX) / nodeSpacing - 0.5, 0, GROUND_COVER_GRID - 1);
            const gridV = clamp((z - cell.minZ) / nodeSpacing - 0.5, 0, GROUND_COVER_GRID - 1);
            const u0 = Math.floor(gridU);
            const v0 = Math.floor(gridV);
            const u1 = Math.min(GROUND_COVER_GRID - 1, u0 + 1);
            const v1 = Math.min(GROUND_COVER_GRID - 1, v0 + 1);
            const fu = gridU - u0;
            const fv = gridV - v0;
            const heightAt = (row: number, column: number): number =>
              cell.groundCover[row * GROUND_COVER_GRID + column]?.heightMeters ?? node.heightMeters;
            const patchHeight =
              heightAt(v0, u0) * (1 - fu) * (1 - fv)
              + heightAt(v0, u1) * fu * (1 - fv)
              + heightAt(v1, u0) * (1 - fu) * fv
              + heightAt(v1, u1) * fu * fv;
            this.appendInstance(
              this.getBatch(`ground-${node.archetype}`, chunk, nextBatchKeys),
              {
                x: x - floatingOrigin.x,
                y: patchHeight - floatingOrigin.y,
                z: z - floatingOrigin.z,
                quaternion: yawQuaternion(groundCoverHash(x, z, 4) * 2 * Math.PI),
                heightScaleMeters: (0.75 + heightHash * 0.5)
                  * (node.archetype === "reed" ? 1.15
                    : node.archetype === "heather" ? 0.75
                    : node.archetype === "fern" ? 0.85 : 0.8),
                radialScale: 1,
                fade: grassFade,
                fadeIncoming: false,
                variant: 0,
                tint: [node.color[0], node.color[1], node.color[2], 1],
                windPhase: groundCoverHash(x, z, 5),
                windResponse: node.archetype === "heather" ? 0.3
                  : node.archetype === "fern" ? 0.5 : 0.9,
              },
            );
            statistics.groundCoverInstances += 1;
          }
        }
      }

    }

    // Perf-debt pass: only batches this revision NO LONGER populates are
    // retired; the rest keep their mesh, their unique geometry and their GPU
    // instance buffer, and take new bytes in place. (The old code retired
    // every batch of the chunk on every rebuild — the allocation churn the
    // 2-17-close ledger recorded as open debt, and a genuine leak besides:
    // the raw `Buffer`s it published were never disposed, because a
    // VertexBuffer built over an existing Buffer does not own it.)
    for (const batchKey of chunk.batchKeys) {
      if (!nextBatchKeys.has(batchKey)) this.retireBatch(batchKey);
    }
    chunk.batchKeys.clear();
    for (const batchKey of nextBatchKeys) chunk.batchKeys.add(batchKey);
    for (const batchKey of chunk.batchKeys) {
      const batch = this.batches.get(batchKey);
      if (batch) this.uploadBatch(batch, floatingOrigin);
    }
    return statistics;
  }

  /**
   * 2-11a: one interleaved 32-byte-stride buffer per batch (the pooled
   * writer's exact byte range), exposed as five typed instanced vertex
   * buffers.
   *
   * Perf-debt pass — the named "instance-buffer reuse" rung. A rebuild that
   * fits inside the existing allocation now writes into it (`writeBuffer`,
   * queue-ordered after the previous submit) and touches nothing else: no
   * `Buffer`, no `VertexBuffer`, no `resetDrawCache` — which is the
   * expensive half, because it invalidates the mesh's draw wrappers and
   * forces Babylon to rebuild pipeline and bind groups for every pass the
   * mesh appears in. Only GROWTH allocates, and the outgrown allocation
   * waits out the same conservative grace window a retired batch does.
   */
  private uploadBatch(batch: DetailBatch, floatingOrigin: DetailFloatingOrigin): void {
    const count = batch.writer.count;
    batch.mesh.forcedInstanceCount = 0;
    if (count === 0) {
      batch.mesh.setEnabled(false);
      return;
    }
    batch.mesh.setEnabled(true);
    const packed = batch.writer.finish();
    if (batch.gpu !== null && packed.byteLength <= batch.gpu.capacityBytes) {
      // vertexCount stays undefined on purpose: Babylon drops its cached
      // `_data` reference whenever a partial range is written, and that
      // reference is what `getVertexBuffer(...).getData()` reads back.
      batch.gpu.shared.updateDirectly(packed, 0, undefined, true);
    } else {
      if (batch.gpu !== null) this.recycleInstanceBuffers(batch.gpu);
      batch.gpu = this.acquireInstanceBuffers(packed);
      this.bindInstanceBuffers(batch);
    }
    batch.mesh.forcedInstanceCount = count;
    // Generator-computed bounds — thinInstanceRefreshBoundingInfo has no
    // matrix buffer to walk anymore, and the wind extent is already an
    // explicit term in the accumulator.
    batch.mesh.setBoundingInfo(new BoundingInfo(
      Vector3.FromArray(batch.bounds.minimum()),
      Vector3.FromArray(batch.bounds.maximum()),
    ));
    batch.builtOrigin.x = floatingOrigin.x;
    batch.builtOrigin.y = floatingOrigin.y;
    batch.builtOrigin.z = floatingOrigin.z;
    batch.mesh.position.set(0, 0, 0);
  }

  /** Keeps stale, origin-relative records world-stable during the rebuild sweep. */
  private compensateBatchOrigins(floatingOrigin: DetailFloatingOrigin): void {
    for (const batch of this.batches.values()) {
      batch.mesh.position.set(
        batch.builtOrigin.x - floatingOrigin.x,
        batch.builtOrigin.y - floatingOrigin.y,
        batch.builtOrigin.z - floatingOrigin.z,
      );
    }
  }

  /**
   * Takes a pooled allocation big enough for `packed`, or makes one. Pooled
   * entries are searched smallest-fit-first so a large buffer is not spent
   * on a small batch and then unavailable to the batch that needs it.
   */
  private acquireInstanceBuffers(packed: Uint8Array): DetailInstanceGpuBuffers {
    let bestIndex = -1;
    for (let index = 0; index < this.instanceBufferPool.length; index += 1) {
      const entry = this.instanceBufferPool[index]!;
      if (entry.reusableAfterUpdate > this.updateSequence) continue;
      if (entry.gpu.capacityBytes < packed.byteLength) continue;
      if (
        bestIndex < 0
        || entry.gpu.capacityBytes < this.instanceBufferPool[bestIndex]!.gpu.capacityBytes
      ) {
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      const [entry] = this.instanceBufferPool.splice(bestIndex, 1);
      entry!.gpu.shared.updateDirectly(packed, 0, undefined, true);
      return entry!.gpu;
    }
    // Grow with headroom so a slowly filling chunk does not reallocate on
    // every rebuild; the record is 32 bytes, so the slack is cheap.
    const capacityBytes = Math.max(
      DETAIL_INSTANCE_STRIDE_BYTES,
      Math.ceil((packed.byteLength * 1.5) / DETAIL_INSTANCE_STRIDE_BYTES)
        * DETAIL_INSTANCE_STRIDE_BYTES,
    );
    const backing = new Uint8Array(capacityBytes);
    backing.set(packed);
    return {
      shared: new Buffer(
        this.scene.getEngine(),
        backing,
        true,
        DETAIL_INSTANCE_STRIDE_BYTES,
        false,
        true,
        true,
      ),
      capacityBytes,
    };
  }

  /** Exposes one allocation to a mesh as the five typed instanced streams. */
  private bindInstanceBuffers(batch: DetailBatch): void {
    const gpu = batch.gpu;
    if (!gpu) return;
    const engine = this.scene.getEngine();
    const typeFor = (name: string): number =>
      name === "float" ? VertexBuffer.FLOAT
      : name === "snorm16" ? VertexBuffer.SHORT
      : name === "unorm16" ? VertexBuffer.UNSIGNED_SHORT
      : VertexBuffer.UNSIGNED_BYTE;
    for (const attribute of DETAIL_INSTANCE_ATTRIBUTES) {
      batch.mesh.setVerticesBuffer(
        new VertexBuffer(engine, gpu.shared, attribute.kind, {
          updatable: true,
          instanced: true,
          size: attribute.size,
          offset: attribute.byteOffset,
          stride: DETAIL_INSTANCE_STRIDE_BYTES,
          useBytes: true,
          type: typeFor(attribute.type),
          normalized: attribute.normalized,
        }),
        false,
      );
    }
    batch.mesh.resetDrawCache(undefined, true);
  }

  /** Returns an allocation to the pool; nothing is destroyed in flight. */
  private recycleInstanceBuffers(gpu: DetailInstanceGpuBuffers): void {
    this.instanceBufferPool.push({
      gpu,
      reusableAfterUpdate:
        this.updateSequence + DETAIL_INSTANCE_BUFFER_REUSE_GRACE_UPDATES,
    });
  }

  /** Bytes held by pooled allocations — the memory the pool is trading. */
  get pooledInstanceBytes(): number {
    let bytes = 0;
    for (const pooled of this.instanceBufferPool) bytes += pooled.gpu.capacityBytes;
    return bytes;
  }

  private refreshVisibilityStatistics(): void {
    let renderedThinInstances = 0;
    let activeBatches = 0;
    const camera = this.scene.activeCamera;
    for (const batch of this.batches.values()) {
      if (!batch.mesh.isEnabled() || batch.mesh.forcedInstanceCount <= 0) continue;
      if (camera && !camera.isInFrustum(batch.mesh)) continue;
      renderedThinInstances += batch.mesh.forcedInstanceCount;
      activeBatches += 1;
    }
    this.statisticsValue = {
      ...this.statisticsValue,
      renderedThinInstances,
      activeBatches,
    };
  }

  private appendInstance(
    batch: DetailBatch,
    record: DetailInstanceRecord,
  ): void {
    batch.writer.push(record);
    // The wind extent is an explicit bounds term now, not a scale fudge.
    batch.bounds.add(record, record.windResponse * record.heightScaleMeters * 0.11);
  }

  /** Composes yaw with a small lean about a hashed azimuth (2-12). */
  private static yawLeanQuaternion(
    yawRadians: number,
    leanRadians: number,
    leanAzimuthRadians: number,
  ): [number, number, number, number] {
    const [, yy, , yw] = yawQuaternion(yawRadians);
    const halfLean = leanRadians / 2;
    const sinLean = Math.sin(halfLean);
    const lx = Math.cos(leanAzimuthRadians) * sinLean;
    const lz = Math.sin(leanAzimuthRadians) * sinLean;
    const lw = Math.cos(halfLean);
    // q = lean ∘ yaw (yaw = (0, yy, 0, yw)).
    return [
      lx * yw + lz * yy,
      yy * lw,
      lz * yw - lx * yy,
      lw * yw,
    ];
  }

  /**
   * 2-14: which render bands a stem at this range belongs to, with the
   * dither-crossfade fades. Inside a margin the stem carries TWO
   * memberships whose fade bytes are exact complements (outgoing
   * `fade = t`, incoming `fade = 1 - t` with the incoming comparison
   * flipped in the fragment); at the cull radius the far band fades out
   * against nothing. Margins clear the 128 m generation cell so a
   * boundary sweeps smoothly across rebuilds.
   */
  static fadeBandMemberships(
    distanceMeters: number,
    law: RenderedDensityLaw,
  ): ReadonlyArray<{ band: "near" | "mid" | "far" }> {
    const nearEdge = law.near.outerRadiusMeters;
    const midEdge = law.mid.outerRadiusMeters;
    const cullEdge = law.far.outerRadiusMeters;
    const slack = DETAIL_MEMBERSHIP_SLACK_METERS;
    if (!Number.isFinite(distanceMeters) || distanceMeters < 0
      || distanceMeters >= cullEdge + slack) {
      return [];
    }
    const memberships: Array<{ band: "near" | "mid" | "far" }> = [];
    // Membership is generous by ±slack around each margin: the FADE itself
    // is computed per fragment from the true camera range, so a stem merely
    // needs to EXIST in every band whose window it could enter before the
    // next amortized rebuild — out-of-window stems dither to nothing.
    if (distanceMeters <= nearEdge + slack) memberships.push({ band: "near" });
    if (distanceMeters > nearEdge - DETAIL_FADE_MARGIN_METERS - slack
      && distanceMeters <= midEdge + slack) {
      memberships.push({ band: "mid" });
    }
    if (distanceMeters > midEdge - DETAIL_FADE_MARGIN_METERS - slack) {
      memberships.push({ band: "far" });
    }
    return memberships;
  }

  /**
   * 2-17 close: the chunk's observer signature term. Frontier chunks (any
   * band/population edge within the chunk's padded distance envelope) carry
   * the 64 m-quantized observer so memberships and baked edge fades
   * re-bake as the frontier sweeps; interior chunks carry a constant.
   */
  private chunkObserverTerm(coordinates: DetailPresentationChunkCoordinates): string {
    const law = this.lastDensityLaw;
    const minX = coordinates.minCellX * this.cellSizeMeters;
    const minZ = coordinates.minCellZ * this.cellSizeMeters;
    const maxX = (coordinates.maxCellX + 1) * this.cellSizeMeters;
    const maxZ = (coordinates.maxCellZ + 1) * this.cellSizeMeters;
    const nearestX = clamp(this.observerX, minX, maxX);
    const nearestZ = clamp(this.observerZ, minZ, maxZ);
    const minDistance = Math.hypot(nearestX - this.observerX, nearestZ - this.observerZ);
    const cornerDistance = Math.max(
      Math.hypot(minX - this.observerX, minZ - this.observerZ),
      Math.hypot(maxX - this.observerX, minZ - this.observerZ),
      Math.hypot(minX - this.observerX, maxZ - this.observerZ),
      Math.hypot(maxX - this.observerX, maxZ - this.observerZ),
    );
    const pad = DETAIL_FADE_MARGIN_METERS + DETAIL_MEMBERSHIP_SLACK_METERS + 64;
    const cullPad = DETAIL_CULL_FADE_MARGIN_METERS + DETAIL_MEMBERSHIP_SLACK_METERS + 64;
    const edges: readonly (readonly [number, number])[] = [
      [law.near.outerRadiusMeters, pad],
      [law.mid.outerRadiusMeters, pad],
      [law.far.outerRadiusMeters, cullPad],
      [this.lastGrassRadius, GROUND_COVER_EDGE_FADE_METERS + DETAIL_MEMBERSHIP_SLACK_METERS + 64],
    ];
    for (const [edge, padding] of edges) {
      if (minDistance - padding <= edge && cornerDistance + padding >= edge) {
        return `f${Math.round(this.observerX / 64)}:${Math.round(this.observerZ / 64)}`;
      }
    }
    return "interior";
  }

  /** Maps a desired world radius onto the [0.5, 1.6] slenderness multiplier. */
  private static radialMultiplier(
    radiusMeters: number,
    heightMeters: number,
    aspect: number,
  ): number {
    return clamp(
      radiusMeters / Math.max(heightMeters * aspect, 1e-4),
      DETAIL_INSTANCE_RADIAL_MIN,
      DETAIL_INSTANCE_RADIAL_MAX,
    );
  }

  private getBatch(
    prototypeKey: string,
    chunk: DetailPresentationChunk,
    usedBatchKeys: Set<string>,
  ): DetailBatch {
    const coordinates = chunk.coordinates;
    // Perf-debt pass: the key no longer carries the chunk revision. It used
    // to, so every rebuild published a whole new set of meshes — a clone, a
    // `makeGeometryUnique` copy of the prototype geometry and a fresh GPU
    // instance buffer per (prototype, chunk) on every 64 m observer quantum,
    // with the previous set kept alive for four more updates. The immutable
    // publication was there because destroying a buffer a render bundle may
    // still reference is a validation error; reusing one is not — a
    // `writeBuffer` is ordered on the queue against the previous submit — so
    // the batch survives and `uploadBatch` writes into it in place.
    const batchKey = `${prototypeKey}@${coordinates.key}`;
    usedBatchKeys.add(batchKey);
    const existing = this.batches.get(batchKey);
    if (existing) {
      if (existing.filledRevision !== chunk.revision) {
        existing.filledRevision = chunk.revision;
        existing.writer.reset();
        existing.bounds.reset();
      }
      return existing;
    }
    const prototype = this.prototypes.get(prototypeKey);
    if (!prototype) throw new Error(`Missing detail prototype ${prototypeKey}`);
    const mesh = prototype.mesh.clone(
      `detail-${prototypeKey}-chunk-${coordinates.key}`,
      null,
      true,
    );
    if (!mesh) throw new Error(`Unable to create detail batch ${batchKey}`);
    // Mesh clones normally share one Geometry. Thin-instance vertex buffers
    // live on that Geometry in Babylon, so sharing it would make one spatial
    // chunk overwrite (and destroy) another chunk's matrix/color/wind buffers.
    // Prototypes are deliberately low-poly; a unique lightweight Geometry per
    // batch keeps those instance streams independent while materials remain
    // shared across every chunk.
    mesh.makeGeometryUnique();
    mesh.material = prototype.material;
    mesh.isPickable = false;
    mesh.useVertexColors = true;
    // INHERITED, never forced: the impostor prototype opts out — with
    // front_facing and the three blend varyings, 4-cascade shadow inputs
    // push its fragment past the 16-input limit (measured 17: nine CSM
    // lanes + tint + A/B/C + a wasted fade lane), and one invalid pipeline
    // poisons the whole render bundle to a black frame.
    mesh.receiveShadows = prototype.mesh.receiveShadows;
    mesh.alwaysSelectAsActiveMesh = false;
    mesh.setEnabled(false);
    mesh.metadata = {
      detailBatch: prototypeKey,
      detailChunk: coordinates.key,
      detailChunkX: coordinates.x,
      detailChunkZ: coordinates.z,
      detailChunkMinCellX: coordinates.minCellX,
      detailChunkMinCellZ: coordinates.minCellZ,
      detailChunkMaxCellX: coordinates.maxCellX,
      detailChunkMaxCellZ: coordinates.maxCellZ,
      detailCastsShadow: prototype.castsShadows,
    };
    const batch: DetailBatch = {
      mesh,
      castsShadows: prototype.castsShadows,
      prototypeKey,
      chunkKey: coordinates.key,
      writer: new DetailInstanceWriter(),
      bounds: new DetailInstanceBounds(),
      gpu: null,
      filledRevision: chunk.revision,
      builtOrigin: { x: 0, y: 0, z: 0 },
    };
    this.batches.set(batchKey, batch);
    return batch;
  }

  private retireBatch(batchKey: string): void {
    const batch = this.batches.get(batchKey);
    if (!batch) return;
    batch.mesh.setEnabled(false);
    this.batches.delete(batchKey);
    this.retiredBatches.push({
      batch,
      disposeAfterUpdate: this.updateSequence + 4,
    });
  }

  private disposeExpiredBatches(): void {
    let writeIndex = 0;
    for (const retired of this.retiredBatches) {
      if (retired.disposeAfterUpdate <= this.updateSequence) {
        retired.batch.mesh.dispose(false, false);
        // A VertexBuffer built over an existing Buffer does NOT own it (and
        // Babylon 9.21.2 never increments the shared Buffer's reference
        // count either), so disposing the mesh releases nothing. The
        // allocation goes to the pool instead of being destroyed — see
        // PooledInstanceBuffers.
        if (retired.batch.gpu) this.recycleInstanceBuffers(retired.batch.gpu);
        retired.batch.gpu = null;
        continue;
      }
      this.retiredBatches[writeIndex] = retired;
      writeIndex += 1;
    }
    this.retiredBatches.length = writeIndex;

  }

  private disposePresentationChunk(chunk: DetailPresentationChunk): void {
    for (const batchKey of chunk.batchKeys) this.retireBatch(batchKey);
    chunk.batchKeys.clear();
    this.presentationChunks.delete(chunk.coordinates.key);
  }

  private nowMilliseconds(): number {
    return typeof performance === "undefined" ? Date.now() : performance.now();
  }

  private createBatches(): void {
    // 2-12: the foliage atlas's FIRST sampler. Under NullEngine (no raw
    // 2D-array support) the atlas is skipped and materials compile without
    // the atlas define — geometry and instancing stay fully testable.
    const engineFlags = this.scene.getEngine() as { isWebGPU?: boolean; _gl?: unknown };
    if (engineFlags.isWebGPU || engineFlags._gl) {
      this.foliageAtlas = createFoliageAtlas(this.scene, this.options.worldSeed);
      // 2-17: the far band's octahedral impostors, baked on the CPU from
      // the same seed (byte-deterministic; ~0.4 s once at startup).
      this.impostorAtlas = createImpostorAtlas(this.scene, this.options.worldSeed);
    }

    // 2-12: card trees from the built prototypes — species-specific trunks
    // (swept generalised cylinders with root flare and forks) and 40-60
    // tilted crown quads, with 16-direction baked sky occlusion in vertex
    // alpha. Prototypes are unit-height with true proportions, so the
    // per-material radial aspect is the prototype's own crown/trunk radius.
    // Bark stays back-face-culled in its own batch while foliage is
    // two-sided: zero extra draw calls per the plan.
    const prototypeSeed = 7;
    for (const species of TREE_SPECIES) {
      const variantCount = clamp(
        Math.round(TREE_VARIANT_COUNTS[species]),
        1,
        32,
      );
      const crownMaterial = this.createMaterial(
        `detail-foliage-${species}`,
        new Color3(0.62, 0.66, 0.58),
        0.87,
        1,
        true,
      );
      this.registerBandFadeMaterial(crownMaterial);
      crownMaterial.backFaceCulling = false;
      crownMaterial.twoSidedLighting = true;
      // R-2E's mandated mitigation: canopy renders in the alpha-test bucket,
      // AFTER opaque terrain and trunks have filled the depth buffer, so
      // early-Z kills every canopy fragment behind a ridge or a trunk before
      // its two-sided PBR shading runs. The built-in test itself is a no-op
      // here (no albedo texture, material alpha 1) — the plugin's atlas
      // discard is the real test; this move is purely about draw order.
      crownMaterial.transparencyMode = Material.MATERIAL_ALPHATEST;
      const barkMaterial = this.createMaterial(
        `detail-bark-${species}`,
        new Color3(0.58, 0.52, 0.46),
        0.93,
        1,
        true,
      );
      this.registerBandFadeMaterial(barkMaterial);
      for (let variant = 0; variant < variantCount; variant += 1) {
        const prototype = buildTreePrototype(species, variant, prototypeSeed);
        const crownAspect = Math.max(prototype.crown.boundingRadius, 0.05);
        const trunkAspect = Math.max(prototype.trunk.boundingRadius, 0.005);
        if (variant === 0) {
          this.crownAspects.set(species, crownAspect);
          this.trunkAspects.set(species, trunkAspect);
          this.materialPlugin(crownMaterial)?.setRadialAspect(crownAspect);
          this.materialPlugin(barkMaterial)?.setRadialAspect(trunkAspect);
        }
        this.registerBatch(
          `tree-${species}-v${variant}-crown-near`,
          this.buildPrototypeMesh(`detail-tree-${species}-v${variant}-crown`, prototype.crown),
          crownMaterial,
          true,
        );
        this.registerBatch(
          `tree-${species}-v${variant}-trunk-near`,
          this.buildPrototypeMesh(`detail-tree-${species}-v${variant}-trunk`, prototype.trunk),
          barkMaterial,
          true,
        );
        // Mid and far bands draw the law-priced standins (≤48 and ≤8
        // triangles per plant): a trunk exists at mid (no floating crowns);
        // far is crossed cards, crown layer only. 2-14 replaces the mid
        // standin with its authored card tier, 2-17 the far one with
        // octahedral impostors.
        const midPrototype = buildTreePrototype(species, variant, prototypeSeed, "mid");
        const farPrototype = buildTreePrototype(species, variant, prototypeSeed, "far");
        this.registerBatch(
          `tree-${species}-v${variant}-crown-mid`,
          this.buildPrototypeMesh(
            `detail-tree-${species}-v${variant}-crown-mid`,
            midPrototype.crown,
          ),
          crownMaterial,
          false,
        );
        this.registerBatch(
          `tree-${species}-v${variant}-trunk-mid`,
          this.buildPrototypeMesh(
            `detail-tree-${species}-v${variant}-trunk-mid`,
            midPrototype.trunk,
          ),
          barkMaterial,
          false,
        );
        if (variant === 0 && !this.impostorAtlas) {
          // No atlas (NullEngine): the far band keeps 2-12's law-priced
          // crossed cards, one mesh per species.
          this.registerBatch(
            `tree-${species}-v${variant}-crown-far`,
            this.buildPrototypeMesh(
              `detail-tree-${species}-v${variant}-crown-far`,
              farPrototype.crown,
            ),
            crownMaterial,
            false,
          );
        }
      }
    }

    if (this.impostorAtlas) {
      // 2-17: the far band is a billboard impostor — one quad, the
      // three-view blend, the two season buckets. Impostors neither cast nor
      // receive shadows (which frees the cascade varyings the blend lanes
      // consume).
      //
      // Perf-debt pass: ONE mesh and ONE material for all seven species.
      // The quad geometry never differed between them; only the bake frame
      // did, and that is a per-species uniform ROW indexed by the instance's
      // variant byte now. The far band spans more presentation chunks than
      // near and mid combined, so this is the pass's single largest
      // draw-call cut — seven draws per far chunk became one.
      const impostorMaterial = this.createMaterial(
        "detail-impostor",
        new Color3(1, 1, 1),
        0.95,
        1,
        false,
      );
      impostorMaterial.backFaceCulling = false;
      impostorMaterial.twoSidedLighting = true;
      impostorMaterial.transparencyMode = Material.MATERIAL_ALPHATEST;
      this.registerBandFadeMaterial(impostorMaterial);
      this.materialPlugin(impostorMaterial)?.setImpostorAtlas(
        this.impostorAtlas.albedo,
        this.impostorAtlas.normalDepth,
        IMPOSTOR_SPECIES.map((species) => {
          const frame = impostorBakeFrame(species, prototypeSeed);
          return {
            extentUnit: frame.extentUnit,
            centerYUnit: frame.centerYUnit,
            leafedLayer: impostorLayerIndex(species, 0),
            bareLayer: impostorLayerIndex(species, 1),
          };
        }),
      );
      const quad = new Mesh("detail-impostor", this.scene);
      const quadData = new VertexData();
      quadData.positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
      quadData.normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
      quadData.uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
      quadData.indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
      quadData.applyToMesh(quad, false);
      quad.setEnabled(false);
      this.registerBatch(TREE_IMPOSTOR_PROTOTYPE_KEY, quad, impostorMaterial, false);
      // AFTER registerBatch (which forces receive on): impostors must NOT
      // receive shadows — with front_facing (two-sided) and the three blend
      // varyings, the 4-cascade CSM inputs push the fragment past the
      // 16-input limit (17 measured), and one invalid pipeline poisons the
      // whole render bundle to a black frame.
      quad.receiveShadows = false;
    }

    // 2-12b: card shrubs — the flat-shaded icospheres are gone. 12-18
    // alpha-tested foliage quads on a short multi-stem skeleton from the
    // 2-11 atlas layers (hazel broadleaf, juniper scale, sage grey-leaf),
    // with the same atlas sampling, occlusion bake and alpha-test-bucket
    // treatment as tree crowns. Two variants per species; the albedo tint
    // brightens toward white because the perceptual tint distribution now
    // arrives per instance, exactly as it does for trees.
    const shrubColors: Readonly<Record<ShrubSpecies, Color3>> = {
      juniper: new Color3(0.5, 0.56, 0.5),
      hazel: new Color3(0.55, 0.6, 0.48),
      sage: new Color3(0.56, 0.58, 0.53),
    };
    for (const species of SHRUB_SPECIES) {
      const material = this.createMaterial(
        `detail-shrub-${species}-material`,
        shrubColors[species],
        0.91,
        1,
        true,
      );
      material.backFaceCulling = false;
      material.twoSidedLighting = true;
      material.transparencyMode = Material.MATERIAL_ALPHATEST;
      for (let variant = 0; variant < SHRUB_VARIANT_COUNTS[species]; variant += 1) {
        const prototype = buildShrubPrototype(species, variant, prototypeSeed);
        if (variant === 0) {
          const aspect = Math.max(prototype.boundingRadius, 0.05);
          this.shrubAspects.set(species, aspect);
          this.materialPlugin(material)?.setRadialAspect(aspect);
        }
        this.registerBatch(
          `shrub-${species}-v${variant}`,
          this.buildPrototypeMesh(`detail-shrub-${species}-v${variant}`, prototype),
          material,
          false,
        );
      }
    }

    // 2-15: displaced-icosphere rocks — per-lithology normals live in the
    // prototype (limestone smooth, granite/dark flat: the shading-model
    // difference reads as lithology more strongly than colour does).
    const rockColors: Readonly<Record<RockVariant, Color3>> = {
      granite: new Color3(0.38, 0.39, 0.4),
      limestone: new Color3(0.5, 0.48, 0.41),
      dark: new Color3(0.22, 0.24, 0.25),
    };
    for (const variant of ROCK_VARIANTS) {
      const prototype = buildRockPrototype(variant, prototypeSeed);
      this.registerBatch(
        `rock-${variant}`,
        this.buildPrototypeMesh(`detail-rock-${variant}`, prototype),
        // Aspect 1.4 keeps the width-recovery multiplier inside the record's
        // [0.5, 1.6] range across the flattening spread (see the appender).
        this.createMaterial(`detail-rock-material-${variant}`, rockColors[variant], 0.94, 1.4),
        false,
      );
    }

    // 2-15: ground clutter — logs, stumps, branch litter, moss cushions.
    // Litter is alpha-tested cards from the 2-11 twig layer, so its material
    // rides the atlas path double-sided; logs and stumps sample bark layers
    // through the same path but stay culled; moss is untextured (−1).
    const clutterKinds: readonly ClutterKind[] = ["log", "stump", "branchLitter", "mossCushion"];
    for (const kind of clutterKinds) {
      const prototype = buildClutterPrototype(kind, prototypeSeed);
      const material = this.createMaterial(
        `detail-clutter-${kind}-material`,
        kind === "mossCushion" ? new Color3(0.62, 0.68, 0.56) : new Color3(0.64, 0.6, 0.55),
        0.95,
        1,
        true,
      );
      if (kind === "branchLitter") {
        material.backFaceCulling = false;
        material.twoSidedLighting = true;
        material.transparencyMode = Material.MATERIAL_ALPHATEST;
      }
      this.registerBatch(
        `clutter-${kind}`,
        this.buildPrototypeMesh(`detail-clutter-${kind}`, prototype),
        material,
        false,
      );
    }

    // 2-16: ground cover — four habitat archetypes on one blade-patch
    // builder, all riding the atlas path double-sided (blades are
    // alpha-tested textured quads) in the alpha-test bucket.
    const groundCoverArchetypes: readonly GroundCoverArchetype[] = [
      "grass", "fern", "heather", "reed",
    ];
    for (const archetype of groundCoverArchetypes) {
      const prototype = buildGrassPatchPrototype(prototypeSeed, archetype);
      const material = this.createMaterial(
        `detail-ground-${archetype}-material`,
        new Color3(0.85, 0.88, 0.8),
        0.92,
        1,
        true,
      );
      material.backFaceCulling = false;
      material.twoSidedLighting = true;
      material.transparencyMode = Material.MATERIAL_ALPHATEST;
      this.registerBatch(
        `ground-${archetype}`,
        this.buildPrototypeMesh(`detail-ground-${archetype}`, prototype),
        material,
        false,
      );
    }

  }


  private materialPlugin(material: PBRMaterial): DetailInstanceMaterialPlugin | null {
    return this.pluginByMaterial.get(material) ?? null;
  }

  /** 2-12: a Babylon mesh from a pure PrototypeGeometry (typed arrays). */
  private buildPrototypeMesh(name: string, geometry: PrototypeGeometry): Mesh {
    const mesh = new Mesh(name, this.scene);
    const data = new VertexData();
    data.positions = geometry.positions;
    data.normals = geometry.normals;
    data.uvs = geometry.uvs;
    data.tangents = geometry.tangents;
    data.colors = geometry.colors;
    data.indices = geometry.indices;
    data.applyToMesh(mesh, false);
    // The per-vertex atlas layer (−1 = untextured) rides its own buffer.
    mesh.setVerticesBuffer(new VertexBuffer(
      this.scene.getEngine(),
      geometry.atlasLayer,
      "atlasLayer",
      { updatable: false, instanced: false, size: 1 },
    ));
    mesh.setEnabled(false);
    return mesh;
  }

  private createMaterial(
    name: string,
    albedo: Color3,
    roughness: number,
    radialAspect: number,
    samplesFoliageAtlas = false,
  ): PBRMaterial {
    const material = new PBRMaterial(name, this.scene);
    material.albedoColor = albedo;
    material.metallic = 0;
    material.roughness = roughness;
    // 1C-6: full-strength now that scene.environmentTexture exists.
    material.environmentIntensity = 1;
    material.directIntensity = 1.05;
    material.specularIntensity = 1;
    // 2-11a: the transform lives in the plugin now — every detail material
    // carries it (rocks included; their wind response is simply zero).
    const plugin = new DetailInstanceMaterialPlugin(material);
    plugin.setTimeSeconds(this.windTimeSeconds);
    plugin.setRadialAspect(radialAspect);
    if (samplesFoliageAtlas && this.foliageAtlas) {
      plugin.setFoliageAtlas(this.foliageAtlas.texture);
    }
    this.instancePlugins.add(plugin);
    this.pluginByMaterial.set(material, plugin);
    // 0-9 incantation, verbatim: the wrapper is assigned AFTER the vertex-
    // participating plugin attaches and BEFORE the material's first effect
    // compiles — attached later it silently falls back to the undisplaced
    // depth pass, which with no matrix buffer would collapse every shadow
    // instance onto the batch origin.
    //
    // remappedVariables amendment (2-12): with the CSM's normalBias > 0 the
    // wrapper injects `shadowMapVertexNormalBias`, whose WGSL references the
    // varying by its bare GLSL name — unresolved after migration. The remap
    // rewrites it inside the include only; `vertexOutputs.vNormalW` is
    // already assigned by the injection anchor. The 0-9 spike missed this
    // because its generator kept the default normalBias of 0, which compiles
    // the include away (tests/gpu/foliage-material-compile.test.ts pins it).
    const engineFlags = this.scene.getEngine() as { isWebGPU?: boolean; _gl?: unknown };
    if (engineFlags.isWebGPU || engineFlags._gl) {
      // 4.5-0: guarded — bindInstanceBuffers resets a growing batch's draw
      // cache in the same frame the CSM pass renders it, and an unguarded
      // wrapper turns that into the createBindGroup fatal stop.
      material.shadowDepthWrapper = createGuardedShadowDepthWrapper(material, this.scene, {
        remappedVariables: ["vNormalW", "vertexOutputs.vNormalW"],
      });
    }
    this.materials.add(material);
    return material;
  }

  private registerBatch(
    key: string,
    mesh: Mesh,
    material: PBRMaterial,
    castsShadows: boolean,
  ): void {
    mesh.material = material;
    mesh.isPickable = false;
    mesh.useVertexColors = true;
    mesh.receiveShadows = true;
    mesh.setEnabled(false);
    mesh.metadata = { detailPrototype: key };
    this.prototypes.set(key, {
      mesh,
      material,
      castsShadows,
    });
  }
}
