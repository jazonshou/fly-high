import {
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  shouldMeshTerrainLake,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
  terrainHydraulicGeometry,
  validateTerrainChannelGraphExport,
  type TerrainChannelEdgeExport,
  type TerrainChannelGraphExport,
  type TerrainChannelNodeExport,
  type TerrainDrainageTermination,
  type TerrainLakeExport,
  type TerrainLakePolygonExport,
  type TerrainMacroEvolutionExport,
} from "@/src/render/webgpu/terrain/TerrainEvolutionContract";
import type {
  HydrologyLake,
  HydrologyRiver,
  HydrologyRiverPoint,
} from "./HydrologyGeneration";
import { extractMacroLakeShoreline } from "./lakeShoreline";

/** Production uses the canonical layout; explicit layouts exist for small deterministic fixtures. */
export interface ChannelNetworkGridLayout {
  readonly width: number;
  readonly height: number;
  readonly texelSizeMeters: number;
  /** World coordinate of sample (0, 0), rather than the outer cell edge. */
  readonly originX: number;
  readonly originZ: number;
}

/**
 * `W-1e` observation sink: per-leg wall time in milliseconds. Purely
 * observational — passing one cannot change a single extracted bit, and
 * without one `extract` takes no clock readings at all. Owned by
 * `scripts/channel-extract-benchmark.mts`, which is the committed harness
 * for the extraction budget.
 */
export interface ChannelExtractionProfile {
  /** Canonical-field validation of the macro export. */
  validateMacro: number;
  /** Seed thinning: candidate mask plus the upstream-predecessor count. */
  seedThinning: number;
  /** Monotone downstream path tracing from thinned starts. */
  pathTracing: number;
  /** Kept-cell ordering, node records and edge records. */
  graphAssembly: number;
  /** Per-lake component flood, marching-squares shoreline and simplification. */
  shoreline: number;
  /** `validateTerrainChannelGraphExport` over the assembled graph. */
  graphValidation: number;
  /** Whole-call wall time. */
  total: number;
}

export function createChannelExtractionProfile(): ChannelExtractionProfile {
  return {
    validateMacro: 0,
    seedThinning: 0,
    pathTracing: 0,
    graphAssembly: 0,
    shoreline: 0,
    graphValidation: 0,
    total: 0,
  };
}

export interface ChannelNetworkExtractionOptions {
  readonly layout?: ChannelNetworkGridLayout;
  /**
   * Optional producer receiver sidecar. It is intentionally not added to the
   * canonical export: the graph consumes canonical heights/area and accepts
   * this only at the current CPU-reference producer boundary.
   */
  readonly receivers?: ArrayLike<number>;
  /** Test/tuning seam. Production consumes the canonical exported seed mask. */
  readonly minimumFlowAccumulationAreaM2?: number;
  /** Optional `W-1e` timing sink; see ChannelExtractionProfile. */
  readonly profile?: ChannelExtractionProfile;
}

export interface SerializedChannelGraph {
  /** A transfer-owned clone; transferring it does not detach the source graph. */
  readonly graph: TerrainChannelGraphExport;
  readonly transferables: readonly Transferable[];
}

export interface ChannelHydrologyGeometry {
  readonly rivers: readonly HydrologyRiver[];
  readonly lakes: readonly HydrologyLake[];
}

/**
 * A rendered lake needs at least this many wet macro texels behind it: a
 * single 512 m square is exactly the reported wave-R failure shape.
 */
export const MINIMUM_MACRO_LAKE_WET_TEXELS = 2;

const DEFAULT_LAYOUT: ChannelNetworkGridLayout = Object.freeze({
  width: EVOLUTION_DOMAIN_TEXELS,
  height: EVOLUTION_DOMAIN_TEXELS,
  texelSizeMeters: EVOLUTION_TEXEL_METERS,
  originX: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX + EVOLUTION_TEXEL_METERS * 0.5,
  originZ: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ + EVOLUTION_TEXEL_METERS * 0.5,
});

const TERMINATION_NONE = 0;
const TERMINATION_SEA = 1;
const TERMINATION_RIM = 2;
const TERMINATION_LAKE = 3;
const STATUS_UNKNOWN = 0;
const STATUS_VALID = 1;
const STATUS_INVALID = 2;
const ELEVATION_EPSILON_METERS = 1e-4;

const NEIGHBOURS = Object.freeze([
  Object.freeze({ x: -1, z: -1 }),
  Object.freeze({ x: 0, z: -1 }),
  Object.freeze({ x: 1, z: -1 }),
  Object.freeze({ x: -1, z: 0 }),
  Object.freeze({ x: 1, z: 0 }),
  Object.freeze({ x: -1, z: 1 }),
  Object.freeze({ x: 0, z: 1 }),
  Object.freeze({ x: 1, z: 1 }),
] as const);

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function requireLayout(layout: ChannelNetworkGridLayout): ChannelNetworkGridLayout {
  if (!Number.isSafeInteger(layout.width) || layout.width < 2) {
    throw new RangeError("Channel grid width must be an integer of at least two texels");
  }
  if (!Number.isSafeInteger(layout.height) || layout.height < 2) {
    throw new RangeError("Channel grid height must be an integer of at least two texels");
  }
  finite(layout.texelSizeMeters, "Channel grid texel size");
  if (layout.texelSizeMeters <= 0) {
    throw new RangeError("Channel grid texel size must be greater than zero");
  }
  finite(layout.originX, "Channel grid originX");
  finite(layout.originZ, "Channel grid originZ");
  return layout;
}

function indexForTexel(x: number, z: number, layout: ChannelNetworkGridLayout): number {
  if (
    !Number.isSafeInteger(x)
    || !Number.isSafeInteger(z)
    || x < 0
    || z < 0
    || x >= layout.width
    || z >= layout.height
  ) {
    throw new RangeError(`Channel texel (${x}, ${z}) lies outside the macro grid`);
  }
  return z * layout.width + x;
}

function isRim(index: number, layout: ChannelNetworkGridLayout): boolean {
  const x = index % layout.width;
  const z = Math.floor(index / layout.width);
  return x === 0 || z === 0 || x === layout.width - 1 || z === layout.height - 1;
}

function isAdjacent(first: number, second: number, layout: ChannelNetworkGridLayout): boolean {
  if (second < 0 || second >= layout.width * layout.height || first === second) return false;
  const firstX = first % layout.width;
  const firstZ = Math.floor(first / layout.width);
  const secondX = second % layout.width;
  const secondZ = Math.floor(second / layout.width);
  return Math.abs(firstX - secondX) <= 1 && Math.abs(firstZ - secondZ) <= 1;
}

function terminationName(code: number): TerrainDrainageTermination {
  if (code === TERMINATION_SEA) return "sea";
  if (code === TERMINATION_RIM) return "rim";
  if (code === TERMINATION_LAKE) return "lake";
  throw new Error(`Unknown channel termination code ${code}`);
}

function validateMacro(
  macro: TerrainMacroEvolutionExport,
  layout: ChannelNetworkGridLayout,
  receivers: ArrayLike<number> | undefined,
): void {
  if (macro.contractVersion !== TERRAIN_EVOLUTION_CONTRACT_VERSION) {
    throw new RangeError(`Unsupported terrain evolution contract ${macro.contractVersion}`);
  }
  const count = layout.width * layout.height;
  if (
    macro.heightMeters.length !== count
    || macro.flowAccumulationAreaM2.length !== count
    || macro.lakeMask.length !== count
  ) {
    throw new RangeError(`Channel macro fields must each contain exactly ${count} texels`);
  }
  if (receivers && receivers.length !== count) {
    throw new RangeError(`Channel receiver sidecar must contain exactly ${count} texels`);
  }
  if (!Number.isFinite(macro.seaLevelMeters)) {
    throw new RangeError("Channel macro sea level must be finite");
  }
  for (let index = 0; index < count; index += 1) {
    const elevation = macro.heightMeters[index];
    const area = macro.flowAccumulationAreaM2[index];
    const lake = macro.lakeMask[index];
    if (!Number.isFinite(elevation)) {
      throw new RangeError(`Channel macro height ${index} must be finite`);
    }
    if (!Number.isFinite(area) || area! < 0) {
      throw new RangeError(`Channel macro flow accumulation ${index} must be finite and non-negative`);
    }
    if (lake !== 0 && lake !== 1) {
      throw new RangeError(`Channel macro lake mask ${index} must be zero or one`);
    }
  }
  for (const index of macro.channelSeedTexelIndices) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
      throw new RangeError(`Channel seed ${index} lies outside the macro grid`);
    }
  }
}

function progressesDownstream(
  current: number,
  next: number,
  macro: TerrainMacroEvolutionExport,
  terminalCode: number,
): boolean {
  const currentArea = macro.flowAccumulationAreaM2[current]!;
  const nextArea = macro.flowAccumulationAreaM2[next]!;
  if (nextArea < currentArea) return false;
  const currentHeight = macro.heightMeters[current]!;
  const nextHeight = macro.heightMeters[next]!;
  if (terminalCode === TERMINATION_NONE && nextHeight > currentHeight + ELEVATION_EPSILON_METERS) {
    return false;
  }
  return nextArea > currentArea
    || nextHeight < currentHeight - ELEVATION_EPSILON_METERS
    || (
      Math.abs(nextHeight - currentHeight) <= ELEVATION_EPSILON_METERS
      && next > current
    );
}

function localBankHeight(
  first: number,
  second: number,
  macro: TerrainMacroEvolutionExport,
  layout: ChannelNetworkGridLayout,
  thalweg: number,
): number {
  let bank = Math.max(macro.heightMeters[first]!, macro.heightMeters[second]!, thalweg);
  for (const index of [first, second]) {
    const x = index % layout.width;
    const z = Math.floor(index / layout.width);
    for (const offset of NEIGHBOURS) {
      const nx = x + offset.x;
      const nz = z + offset.z;
      if (nx < 0 || nz < 0 || nx >= layout.width || nz >= layout.height) continue;
      const neighbour = nz * layout.width + nx;
      if (neighbour === first || neighbour === second) continue;
      bank = Math.max(bank, macro.heightMeters[neighbour]!);
    }
  }
  return bank;
}

/** Shoelace area of an interleaved X/Z polygon. */
export function lakePolygonAreaSquareMeters(verticesXZ: ArrayLike<number>): number {
  const vertexCount = Math.floor(verticesXZ.length / 2);
  if (vertexCount < 3) return 0;
  let twiceArea = 0;
  for (let index = 0; index < vertexCount; index += 1) {
    const next = (index + 1) % vertexCount;
    twiceArea += verticesXZ[index * 2]! * verticesXZ[next * 2 + 1]!
      - verticesXZ[next * 2]! * verticesXZ[index * 2 + 1]!;
  }
  return Math.abs(twiceArea) * 0.5;
}

/**
 * Whether a coarse macro mask safely supports a rendered polygon. A single
 * wet texel is exactly the reported 512 m square failure, and the declared
 * surface area must cover at least one texel.
 *
 * W-5: the hull-overfill ratio check this gate used to carry existed to
 * reject CONVEX covers of concave/diagonal masks. The marching-squares
 * shoreline cannot overfill — its 0.5 iso-contour of bilinear coverage lies
 * at or inside the wet texel outline by construction — so that check is
 * retired with the convex cover and concave lakes mesh again.
 */
export function macroLakeHasRenderableWetSupport(
  wetTexelCount: number,
  texelSizeMeters: number,
  declaredSurfaceAreaM2: number,
  verticesXZ: ArrayLike<number>,
): boolean {
  if (!Number.isSafeInteger(wetTexelCount) || wetTexelCount < MINIMUM_MACRO_LAKE_WET_TEXELS) {
    return false;
  }
  if (!Number.isFinite(texelSizeMeters) || texelSizeMeters <= 0) return false;
  if (!Number.isFinite(declaredSurfaceAreaM2) || declaredSurfaceAreaM2 <= 0) return false;
  if (declaredSurfaceAreaM2 < texelSizeMeters * texelSizeMeters) return false;
  return lakePolygonAreaSquareMeters(verticesXZ) > 0;
}

function collectLakeComponent(
  outletIndex: number,
  macro: TerrainMacroEvolutionExport,
  layout: ChannelNetworkGridLayout,
  claimed: Uint8Array,
): number[] {
  if (macro.lakeMask[outletIndex] !== 1 || claimed[outletIndex] === 1) return [];
  const component: number[] = [];
  const queue: number[] = [outletIndex];
  claimed[outletIndex] = 1;
  for (let head = 0; head < queue.length; head += 1) {
    const index = queue[head]!;
    component.push(index);
    const x = index % layout.width;
    const z = Math.floor(index / layout.width);
    for (const offset of NEIGHBOURS) {
      const nx = x + offset.x;
      const nz = z + offset.z;
      if (nx < 0 || nz < 0 || nx >= layout.width || nz >= layout.height) continue;
      const neighbour = nz * layout.width + nx;
      if (macro.lakeMask[neighbour] !== 1 || claimed[neighbour] === 1) continue;
      claimed[neighbour] = 1;
      queue.push(neighbour);
    }
  }
  return component;
}

/**
 * Deterministic macro-channel extractor (`5-9`).
 *
 * Thresholded cells follow one monotone downstream receiver. Their union is a
 * one-cell skeleton: branches merge at shared nodes and never duplicate the
 * trunk. Invalid dangling components are omitted rather than assigned a made-
 * up termination. Every exported terminal is sea, the open rim, or a lake.
 */
export class ChannelNetwork {
  extract(
    macro: TerrainMacroEvolutionExport,
    options: ChannelNetworkExtractionOptions = {},
  ): TerrainChannelGraphExport {
    const profile = options.profile;
    const startedAt = profile ? performance.now() : 0;
    let legStartedAt = startedAt;
    const leg = (key: keyof ChannelExtractionProfile): void => {
      if (!profile) return;
      const at = performance.now();
      profile[key] += at - legStartedAt;
      legStartedAt = at;
    };
    const layout = requireLayout(options.layout ?? DEFAULT_LAYOUT);
    validateMacro(macro, layout, options.receivers);
    leg("validateMacro");
    const count = layout.width * layout.height;
    const forcedTerminations = new Uint8Array(count);
    for (const base of macro.drainageBaseLevels) {
      const index = indexForTexel(base.outletTexel.x, base.outletTexel.z, layout);
      forcedTerminations[index] = base.termination === "sea"
        ? TERMINATION_SEA
        : base.termination === "rim"
          ? TERMINATION_RIM
          : TERMINATION_LAKE;
    }
    const meshedLakes = [...macro.lakes]
      .filter(shouldMeshTerrainLake)
      .sort((first, second) => first.lakeId - second.lakeId);
    const lakeIds = new Set<number>();
    const lakeOutletIndices = new Map<number, number>();
    for (const lake of meshedLakes) {
      if (!Number.isSafeInteger(lake.lakeId) || lake.lakeId < 0 || lakeIds.has(lake.lakeId)) {
        throw new RangeError(`Macro lake id ${lake.lakeId} must be unique and non-negative`);
      }
      lakeIds.add(lake.lakeId);
      const outlet = indexForTexel(lake.outletTexel.x, lake.outletTexel.z, layout);
      lakeOutletIndices.set(lake.lakeId, outlet);
      forcedTerminations[outlet] = TERMINATION_LAKE;
    }

    const terminationAt = (index: number): number => {
      if (macro.heightMeters[index]! <= macro.seaLevelMeters) return TERMINATION_SEA;
      if (macro.lakeMask[index] === 1) return TERMINATION_LAKE;
      const forced = forcedTerminations[index]!;
      if (forced !== TERMINATION_NONE) return forced;
      return isRim(index, layout) ? TERMINATION_RIM : TERMINATION_NONE;
    };

    const resolveSuccessor = (current: number): number => {
      const supplied = options.receivers?.[current];
      if (
        supplied !== undefined
        && Number.isSafeInteger(supplied)
        && isAdjacent(current, supplied, layout)
        && progressesDownstream(current, supplied, macro, terminationAt(supplied))
      ) return supplied;

      const x = current % layout.width;
      const z = Math.floor(current / layout.width);
      let best = -1;
      let bestArea = Number.NEGATIVE_INFINITY;
      let bestHeight = Number.POSITIVE_INFINITY;
      for (const offset of NEIGHBOURS) {
        const nx = x + offset.x;
        const nz = z + offset.z;
        if (nx < 0 || nz < 0 || nx >= layout.width || nz >= layout.height) continue;
        const next = nz * layout.width + nx;
        if (!progressesDownstream(current, next, macro, terminationAt(next))) continue;
        const area = macro.flowAccumulationAreaM2[next]!;
        const height = macro.heightMeters[next]!;
        if (
          area > bestArea
          || (area === bestArea && height < bestHeight)
          || (area === bestArea && height === bestHeight && next < best)
        ) {
          best = next;
          bestArea = area;
          bestHeight = height;
        }
      }
      return best;
    };

    const candidates = new Set<number>();
    for (const index of macro.channelSeedTexelIndices) candidates.add(index);
    if (options.minimumFlowAccumulationAreaM2 !== undefined) {
      finite(options.minimumFlowAccumulationAreaM2, "Channel accumulation threshold");
      if (options.minimumFlowAccumulationAreaM2 < 0) {
        throw new RangeError("Channel accumulation threshold must be non-negative");
      }
      for (let index = 0; index < count; index += 1) {
        if (macro.flowAccumulationAreaM2[index]! >= options.minimumFlowAccumulationAreaM2) {
          candidates.add(index);
        }
      }
    }
    // `channelSeedTexelIndices` is the thresholded field, not necessarily a
    // list of headwaters. Thin it before tracing: only cells with no selected
    // upstream predecessor start a path. Wet/sea/rim cells never start an
    // isolated channel merely because their accumulation crossed the cutoff;
    // they enter the graph only when a real upstream path reaches them.
    const candidateMask = new Uint8Array(count);
    for (const index of candidates) {
      if (terminationAt(index) === TERMINATION_NONE) candidateMask[index] = 1;
    }
    const candidateIncoming = new Uint32Array(count);
    for (const index of candidates) {
      if (candidateMask[index] !== 1) continue;
      const next = resolveSuccessor(index);
      if (next >= 0 && candidateMask[next] === 1) {
        candidateIncoming[next] = candidateIncoming[next]! + 1;
      }
    }

    leg("seedThinning");

    const successor = new Int32Array(count);
    successor.fill(-1);
    const status = new Uint8Array(count);
    const depth = new Uint32Array(count);
    const visitStamp = new Uint32Array(count);
    let traversal = 0;
    const starts = [...candidates]
      .filter((index) => candidateMask[index] === 1 && candidateIncoming[index] === 0);
    for (const outlet of lakeOutletIndices.values()) starts.push(outlet);
    starts.sort((first, second) => first - second);
    for (const start of starts) {
      if (status[start] !== STATUS_UNKNOWN) continue;
      traversal += 1;
      if (traversal === 0xffff_ffff) {
        visitStamp.fill(0);
        traversal = 1;
      }
      const path: number[] = [];
      let current = start;
      let valid = false;
      while (true) {
        if (status[current] === STATUS_VALID) {
          valid = true;
          break;
        }
        if (status[current] === STATUS_INVALID) break;
        const termination = terminationAt(current);
        if (termination !== TERMINATION_NONE) {
          forcedTerminations[current] = termination;
          status[current] = STATUS_VALID;
          depth[current] = 0;
          valid = true;
          break;
        }
        if (visitStamp[current] === traversal) {
          status[current] = STATUS_INVALID;
          break;
        }
        visitStamp[current] = traversal;
        path.push(current);
        const next = resolveSuccessor(current);
        if (next < 0) {
          status[current] = STATUS_INVALID;
          break;
        }
        successor[current] = next;
        current = next;
      }
      for (let offset = path.length - 1; offset >= 0; offset -= 1) {
        const index = path[offset]!;
        const next = successor[index]!;
        if (valid && next >= 0 && status[next] === STATUS_VALID) {
          status[index] = STATUS_VALID;
          depth[index] = depth[next]! + 1;
        } else {
          status[index] = STATUS_INVALID;
          valid = false;
        }
      }
    }

    leg("pathTracing");

    const kept: number[] = [];
    for (let index = 0; index < count; index += 1) {
      if (status[index] === STATUS_VALID) kept.push(index);
    }
    kept.sort((first, second) => depth[second]! - depth[first]! || first - second);
    const nodeIdByIndex = new Int32Array(count);
    nodeIdByIndex.fill(-1);
    kept.forEach((index, nodeId) => {
      nodeIdByIndex[index] = nodeId;
    });
    const incoming = new Uint32Array(count);
    for (const index of kept) {
      const next = successor[index]!;
      if (next >= 0 && status[next] === STATUS_VALID) incoming[next] = incoming[next]! + 1;
    }
    const nodes: TerrainChannelNodeExport[] = kept.map((index, nodeId) => {
      const column = index % layout.width;
      const row = Math.floor(index / layout.width);
      const next = successor[index]!;
      const kind = next < 0
        ? "outlet"
        : incoming[index]! > 1
          ? "confluence"
          : incoming[index] === 0
            ? "source"
            : "channel";
      const termination = next < 0
        ? terminationName(forcedTerminations[index]!)
        : undefined;
      return Object.freeze({
        nodeId,
        kind,
        worldX: layout.originX + column * layout.texelSizeMeters,
        worldZ: layout.originZ + row * layout.texelSizeMeters,
        elevationMeters: macro.heightMeters[index]!,
        flowAccumulationAreaM2: macro.flowAccumulationAreaM2[index]!,
        ...(termination ? { termination } : {}),
      });
    });
    const edges: TerrainChannelEdgeExport[] = [];
    for (const index of kept) {
      const next = successor[index]!;
      if (next < 0 || status[next] !== STATUS_VALID) continue;
      const upstreamNodeId = nodeIdByIndex[index]!;
      const downstreamNodeId = nodeIdByIndex[next]!;
      const accumulation = macro.flowAccumulationAreaM2[next]!;
      const thalweg = Math.min(macro.heightMeters[index]!, macro.heightMeters[next]!);
      edges.push(Object.freeze({
        edgeId: edges.length,
        upstreamNodeId,
        downstreamNodeId,
        flowAccumulationAreaM2: accumulation,
        hydraulicGeometry: terrainHydraulicGeometry(accumulation),
        bankElevationMeters: localBankHeight(index, next, macro, layout, thalweg),
        thalwegElevationMeters: thalweg,
      }));
    }

    leg("graphAssembly");

    const lakePolygons: TerrainLakePolygonExport[] = [];
    const lakes: TerrainLakeExport[] = [];
    const claimedLakeTexels = new Uint8Array(count);
    for (const lake of meshedLakes) {
      const outletIndex = lakeOutletIndices.get(lake.lakeId)!;
      const outletNodeId = nodeIdByIndex[outletIndex]!;
      if (outletNodeId < 0) throw new Error(`Lake ${lake.lakeId} has no outlet node`);
      const polygonRef = lakePolygons.length;
      const component = collectLakeComponent(
        outletIndex,
        macro,
        layout,
        claimedLakeTexels,
      );
      if (component.length < MINIMUM_MACRO_LAKE_WET_TEXELS) continue;
      // W-5: the shoreline is the 0.5 contour of the canonical coverage
      // field on a fine per-lake grid (marching squares → Douglas-Peucker),
      // replacing the convex 512 m texel-corner cover.
      const verticesXZ = extractMacroLakeShoreline({
        component,
        outletIndex,
        spillElevationMeters: lake.spillElevationMeters,
        lakeId: lake.lakeId,
        layout,
      });
      if (!verticesXZ || !macroLakeHasRenderableWetSupport(
        component.length,
        layout.texelSizeMeters,
        lake.surfaceAreaM2,
        verticesXZ,
      )) {
        continue;
      }
      lakePolygons.push(Object.freeze({
        polygonRef,
        verticesXZ,
      }));
      lakes.push(Object.freeze({
        lakeId: lake.lakeId,
        polygonRef,
        spillElevationMeters: lake.spillElevationMeters,
        outletNodeId,
        maximumDepthMeters: lake.maximumDepthMeters,
        surfaceAreaM2: lake.surfaceAreaM2,
      }));
    }

    leg("shoreline");

    const graph: TerrainChannelGraphExport = Object.freeze({
      contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
      provenance: macro.provenance,
      nodes: Object.freeze(nodes),
      edges: Object.freeze(edges),
      lakePolygons: Object.freeze(lakePolygons),
      lakes: Object.freeze(lakes),
    });
    const issues = validateTerrainChannelGraphExport(graph);
    if (issues.length > 0) {
      const first = issues[0]!;
      throw new Error(`Channel graph failed validation at ${first.path}: ${first.message}`);
    }
    leg("graphValidation");
    if (profile) profile.total += performance.now() - startedAt;
    return graph;
  }

  /** Prepare an ownership-preserving graph clone for a transfer-fed mesh worker. */
  serializeForWorker(graph: TerrainChannelGraphExport): SerializedChannelGraph {
    const issues = validateTerrainChannelGraphExport(graph);
    if (issues.length > 0) {
      const first = issues[0]!;
      throw new RangeError(`Cannot serialize invalid channel graph at ${first.path}: ${first.message}`);
    }
    const transferables: Transferable[] = [];
    const lakePolygons = graph.lakePolygons.map((polygon) => {
      const verticesXZ = Float32Array.from(polygon.verticesXZ);
      transferables.push(verticesXZ.buffer);
      return Object.freeze({ polygonRef: polygon.polygonRef, verticesXZ });
    });
    const clone: TerrainChannelGraphExport = Object.freeze({
      contractVersion: graph.contractVersion,
      provenance: graph.provenance,
      nodes: graph.nodes,
      edges: graph.edges,
      lakePolygons: Object.freeze(lakePolygons),
      lakes: graph.lakes,
    });
    return Object.freeze({ graph: clone, transferables: Object.freeze(transferables) });
  }
}

function legacyTermination(node: TerrainChannelNodeExport): HydrologyRiver["termination"] {
  if (node.kind === "confluence") return "confluence";
  if (node.termination === "sea") return "sea";
  if (node.termination === "rim") return "boundary";
  if (node.termination === "lake") return "basin";
  return "confluence";
}

function hydrologyPoint(
  node: TerrainChannelNodeExport,
  edge: TerrainChannelEdgeExport,
): HydrologyRiverPoint {
  const hydraulic = edge.hydraulicGeometry;
  const depth = Math.max(hydraulic.bankfullDepthMeters, 1e-3);
  const width = Math.max(hydraulic.wettedWidthMeters, 1e-3);
  const surface = Math.min(edge.bankElevationMeters, edge.thalwegElevationMeters + depth);
  return Object.freeze({
    x: node.worldX,
    y: surface,
    z: node.worldZ,
    widthMeters: hydraulic.wettedWidthMeters,
    flowSpeedMetersPerSecond: hydraulic.dischargeM3PerSecond / (width * depth),
    estimatedDischargeCubicMetersPerSecond: hydraulic.dischargeM3PerSecond,
  });
}

/**
 * Pure compatibility adapter for the existing ribbon/lake mesh builders.
 * Width, depth and discharge are copied from graph edges; no legacy width
 * heuristic or second hydraulic law is allowed here.
 */
export function channelGraphToHydrologyGeometry(
  graph: TerrainChannelGraphExport,
): ChannelHydrologyGeometry {
  const nodes = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const outgoing = new Map<number, TerrainChannelEdgeExport>();
  const incoming = new Map<number, number>();
  for (const edge of graph.edges) {
    outgoing.set(edge.upstreamNodeId, edge);
    incoming.set(edge.downstreamNodeId, (incoming.get(edge.downstreamNodeId) ?? 0) + 1);
  }
  const visited = new Set<number>();
  const rivers: HydrologyRiver[] = [];

  const buildReach = (firstEdge: TerrainChannelEdgeExport): void => {
    if (visited.has(firstEdge.edgeId)) return;
    const reachEdges: TerrainChannelEdgeExport[] = [];
    let edge: TerrainChannelEdgeExport | undefined = firstEdge;
    while (edge && !visited.has(edge.edgeId)) {
      visited.add(edge.edgeId);
      reachEdges.push(edge);
      const downstream = nodes.get(edge.downstreamNodeId);
      if (!downstream || (incoming.get(downstream.nodeId) ?? 0) !== 1) break;
      edge = outgoing.get(downstream.nodeId);
    }
    const firstNode = nodes.get(reachEdges[0]!.upstreamNodeId);
    if (!firstNode) return;
    // All reaches use the downstream reach's export at a shared confluence.
    // That makes the junction one actual point rather than two incoming
    // ribbon endpoints at slightly different widths/heights.
    const firstHydraulicEdge = outgoing.get(firstNode.nodeId) ?? reachEdges[0]!;
    const points: HydrologyRiverPoint[] = [hydrologyPoint(firstNode, firstHydraulicEdge)];
    let lengthMeters = 0;
    for (const reachEdge of reachEdges) {
      const downstream = nodes.get(reachEdge.downstreamNodeId);
      if (!downstream) continue;
      const previous = points.at(-1)!;
      lengthMeters += Math.hypot(downstream.worldX - previous.x, downstream.worldZ - previous.z);
      points.push(hydrologyPoint(downstream, outgoing.get(downstream.nodeId) ?? reachEdge));
    }
    const lastNode = nodes.get(reachEdges.at(-1)!.downstreamNodeId)!;
    rivers.push(Object.freeze({
      id: `channel:${firstEdge.edgeId}`,
      points: Object.freeze(points),
      termination: legacyTermination(lastNode),
      lengthMeters,
      maximumWidthMeters: points.reduce(
        (maximum, point) => Math.max(maximum, point.widthMeters),
        0,
      ),
    }));
  };

  for (const edge of graph.edges) {
    const upstream = nodes.get(edge.upstreamNodeId);
    if (!upstream) continue;
    if ((incoming.get(upstream.nodeId) ?? 0) !== 1 || upstream.kind === "confluence") {
      buildReach(edge);
    }
  }
  for (const edge of graph.edges) buildReach(edge);

  const polygons = new Map(graph.lakePolygons.map((polygon) => [polygon.polygonRef, polygon]));
  const lakes: HydrologyLake[] = graph.lakes.map((lake) => {
    const polygon = polygons.get(lake.polygonRef);
    if (!polygon) throw new RangeError(`Lake ${lake.lakeId} has no polygon`);
    const boundary = [] as Array<{ x: number; y: number; z: number }>;
    let centerX = 0;
    let centerZ = 0;
    for (let index = 0; index < polygon.verticesXZ.length; index += 2) {
      const x = polygon.verticesXZ[index]!;
      const z = polygon.verticesXZ[index + 1]!;
      centerX += x;
      centerZ += z;
      boundary.push(Object.freeze({ x, y: lake.spillElevationMeters, z }));
    }
    centerX /= boundary.length;
    centerZ /= boundary.length;
    let radiusMeters = 0;
    for (const point of boundary) {
      radiusMeters = Math.max(radiusMeters, Math.hypot(point.x - centerX, point.z - centerZ));
    }
    const outlet = nodes.get(lake.outletNodeId);
    const outletEdge = outlet ? outgoing.get(outlet.nodeId) : undefined;
    const downstream = outletEdge ? nodes.get(outletEdge.downstreamNodeId) : undefined;
    const dx = outlet && downstream ? downstream.worldX - outlet.worldX : 0;
    const dz = outlet && downstream ? downstream.worldZ - outlet.worldZ : 0;
    const directionLength = Math.hypot(dx, dz);
    return Object.freeze({
      id: `lake:${lake.lakeId}`,
      centerX,
      centerZ,
      surfaceHeight: lake.spillElevationMeters,
      maximumDepthMeters: lake.maximumDepthMeters,
      radiusMeters,
      areaSquareMeters: lake.surfaceAreaM2,
      flowDirection: Object.freeze([
        directionLength > 1e-6 ? dx / directionLength : 0,
        directionLength > 1e-6 ? dz / directionLength : 0,
      ]) as readonly [number, number],
      boundary: Object.freeze(boundary),
    });
  });
  return Object.freeze({ rivers: Object.freeze(rivers), lakes: Object.freeze(lakes) });
}
