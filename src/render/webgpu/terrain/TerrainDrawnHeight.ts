import { Constants } from "@babylonjs/core/Engines/constants";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { Scene } from "@babylonjs/core/scene";
import { TERRAIN_NODE_GRID_RESOLUTION, terrainNodeSpanMeters } from "./TerrainSpineContract";
import {
  terrainNodeVertexMorphK,
  unpackTerrainCornerMorphs,
  type TerrainNode,
} from "./TerrainQuadtree";
import { TERRAIN_BOUNDARY_MORPH_WGSL } from "./TerrainSurfacePlugin";

/**
 * The ground as the terrain DRAWS it this frame, for whatever has to lie on
 * it: the roads' ribbons and guardrails, and later the tyre tracks.
 *
 * WHY NOT THE HEIGHTS. A ribbon placed on the CPU's heights floats or sinks
 * wherever the terrain draws coarser than its pages: a node's vertices are
 * `2·2^L` m apart, its odd vertices slide onto the parent's lattice as it
 * morphs, and Low never streams L0 beyond the car. The difference between
 * the field and the drawn facets reaches decimetres on a crowned road a few
 * hundred metres out, and a depth bias big enough to hide that pulls a ribbon
 * through the hill in front of it. So a consumer's vertex stage asks the
 * terrain's own question instead: which node drew this point, which of its
 * triangles, and where its three vertices were displaced to.
 *
 * THE LOOKUP. One texel pair per 64 m cell (an L0 node's span) in a square
 * window round the camera, addressed toroidally so the window moves without
 * a rewrite: the record the terrain drew the cell's node with
 * (`writeTerrainNodeBuffers`' two lanes, the channel lane left out) and the
 * cell's own tag where the record carries the provisional axis, so a texel
 * the window left behind reads as missing rather than as another cell's node.
 * It is refreshed only when a consumer asks (one is within reach), after the
 * terrain wrote this frame's node buffers, and only the cells whose record
 * changed are written: one upload per texel row that changed.
 *
 * THE HELPER. `TERRAIN_DRAWN_HEIGHT_WGSL`'s `terrainDrawnSurface` repeats the
 * terrain's displacement (`TerrainSurfacePlugin`'s
 * `CUSTOM_VERTEX_UPDATE_POSITION`, with its boundary morph composed rather
 * than copied) for the three vertices of the drawn triangle under a point,
 * and interpolates them: the height, and the gradient the terrain shades
 * with. A node's interior morphs as a tensor grid, so the interior quad is
 * found by inverting it per axis. Within a quad of an edge it is not a grid:
 * the edge vertices take the synchronised corner morph, and where that and
 * the interior's differ the grid folds, so a triangle can turn over (a back
 * face, culled) and two front faces can cover one point. There the quad's
 * neighbours are tried too and the higher front face wins, as the depth test
 * picks it from above. `terrainDrawnSurfaceAt` is the CPU twin, line for
 * line; a test pins the terrain's vertex code, so a change there fails until
 * this file follows it.
 */

/** One lookup cell: the finest node's span, so no node is smaller than a cell. */
export const TERRAIN_DRAWN_CELL_METERS = terrainNodeSpanMeters(0);

/** The cell tag's period, cells: tags repeat every 64 km, far beyond any window. */
export const TERRAIN_DRAWN_TAG_PERIOD = 1_024;

/** Texels per cell (the two lanes) and floats per cell. */
const TEXELS_PER_CELL = 2;
const FLOATS_PER_CELL = TEXELS_PER_CELL * 4;
const QUADS = TERRAIN_NODE_GRID_RESOLUTION - 1;

/** Room beyond the asked radius that a consumer's geometry may reach, metres. */
export const TERRAIN_DRAWN_WINDOW_MARGIN_METERS = 256;

/** The window edge, cells, for consumers reaching `reachMeters` from the camera: even, so the camera's cell is central. */
export function terrainDrawnWindowCells(reachMeters: number): number {
  const reach = Math.max(0, Number.isFinite(reachMeters) ? reachMeters : 0);
  return 2 * (Math.ceil((reach + TERRAIN_DRAWN_WINDOW_MARGIN_METERS) / TERRAIN_DRAWN_CELL_METERS) + 1);
}

/** The tag a cell's texels carry (never 0, which is a texel never written). */
export function terrainDrawnCellTag(cellX: number, cellZ: number): number {
  const period = TERRAIN_DRAWN_TAG_PERIOD;
  const x = cellX - Math.floor(cellX / period) * period;
  const z = cellZ - Math.floor(cellZ / period) * period;
  return x + z * period + 1;
}

/** This frame's beauty node records, as `TerrainClipmapSystem` wrote them. */
export interface TerrainDrawnNodeRecords {
  readonly nodes: readonly TerrainNode[];
  readonly laneA: Float32Array;
  readonly laneB: Float32Array;
  /** Records written this frame (a prefix of `nodes`). */
  readonly count: number;
}

/** The height atlas the records' slots index, as `TerrainSurfacePlugin.setHeightAtlas` takes its shape. */
export interface TerrainDrawnAtlasShape {
  readonly atlasEdge: number;
  readonly slotEdge: number;
  readonly gutter: number;
  readonly gridEdge: number;
}

/** A CPU copy of the height atlas, for the twin: row-major `atlasEdge²` heights. */
export interface TerrainDrawnAtlasData {
  readonly heights: Float32Array;
  readonly shape: TerrainDrawnAtlasShape;
}

export interface TerrainDrawnSurfaceSample {
  readonly height: number;
  /** dH/dx and dH/dz in world metres: the terrain's shading normal is (-x, 1, -z). */
  readonly gradientX: number;
  readonly gradientZ: number;
}

export interface TerrainDrawnHeightStatistics {
  /** Refreshes since construction (frames a consumer was within reach). */
  readonly refreshes: number;
  /** Cells whose record changed at the last refresh, and texel rows uploaded for them. */
  readonly cellsWritten: number;
  readonly rowsUploaded: number;
  /** Main-thread time of the last refresh, milliseconds. */
  readonly refreshMilliseconds: number;
}

/** The uniforms a consumer's material plugin declares (define-independent, as every plugin here). */
export const TERRAIN_DRAWN_HEIGHT_UNIFORMS: readonly { readonly name: string; readonly size: number; readonly type: string }[] =
  Object.freeze([
    Object.freeze({ name: "terrainDrawnAtlasShape", size: 4, type: "vec4" }),
    Object.freeze({ name: "terrainDrawnWindow", size: 4, type: "vec4" }),
    Object.freeze({ name: "terrainDrawnOrigin", size: 4, type: "vec4" }),
  ]);

/** The textures it binds, by name: both `textureLoad`ed, neither has a sampler. */
export const TERRAIN_DRAWN_HEIGHT_SAMPLERS: readonly string[] = Object.freeze([
  "terrainDrawnLookup",
  "terrainDrawnAtlas",
]);

/**
 * The vertex-stage helper. Declares its two textures; reads the three
 * uniforms above from the consumer's `uniforms` block. Consumers call
 * `terrainDrawnSurfaceAtLocal(position.xz)` with a position in the frame the
 * consumer bound (`TerrainDrawnHeight.bind`'s local origin).
 */
export const TERRAIN_DRAWN_HEIGHT_WGSL = /* wgsl */ `
var terrainDrawnLookup: texture_2d<f32>;
var terrainDrawnAtlas: texture_2d<f32>;

${TERRAIN_BOUNDARY_MORPH_WGSL}

struct TerrainDrawnSurface {
  height: f32,
  // dH/dx, dH/dz in world metres.
  gradient: vec2f,
  valid: bool,
};

struct TerrainDrawnNode {
  a: vec4f,
  b: vec4f,
  sub: vec2f,
  parity: vec2f,
};

// The terrain's terrainSampleHeightGradient, against this binding.
fn terrainDrawnSample(slot: f32, texelX: f32, texelZ: f32) -> vec3f {
  if (slot < 0.0) { return vec3f(0.0); }
  let grid = uniforms.terrainDrawnAtlasShape.w;
  let row = floor(slot / grid);
  let slotOrigin = vec2f(slot - row * grid, row) * uniforms.terrainDrawnAtlasShape.y
    + vec2f(uniforms.terrainDrawnAtlasShape.z);
  let base = floor(vec2f(texelX, texelZ));
  let fraction = vec2f(texelX, texelZ) - base;
  let corner = vec2i(slotOrigin + base);
  let h00 = textureLoad(terrainDrawnAtlas, corner, 0).r;
  let h10 = textureLoad(terrainDrawnAtlas, corner + vec2i(1, 0), 0).r;
  let h01 = textureLoad(terrainDrawnAtlas, corner + vec2i(0, 1), 0).r;
  let h11 = textureLoad(terrainDrawnAtlas, corner + vec2i(1, 1), 0).r;
  let top = h00 + (h10 - h00) * fraction.x;
  let bottom = h01 + (h11 - h01) * fraction.x;
  let gradientX = mix(h10 - h00, h11 - h01, fraction.y);
  let gradientZ = mix(h01 - h00, h11 - h10, fraction.x);
  return vec3f(top + (bottom - top) * fraction.y, gradientX, gradientZ);
}

// A grid vertex's place in the node (0..1), as the terrain's geomorph moves it.
fn terrainDrawnPlace(node: TerrainDrawnNode, gridPosition: vec2f) -> vec2f {
  let quads = ${QUADS}.0;
  let vertexMorphK = terrainSurfaceVertexMorphK(
    node.b.x, node.b.w, gridPosition, node.b.y >= 0.0);
  let evenLattice = floor(gridPosition * 0.5) * 2.0;
  return (gridPosition + (evenLattice - gridPosition) * vertexMorphK) / quads;
}

// A grid vertex as the terrain displaces it: (height, dH per node unit x, z).
fn terrainDrawnVertex(node: TerrainDrawnNode, gridPosition: vec2f) -> vec3f {
  let quads = ${QUADS}.0;
  let vertexMorphK = terrainSurfaceVertexMorphK(
    node.b.x, node.b.w, gridPosition, node.b.y >= 0.0);
  let evenLattice = floor(gridPosition * 0.5) * 2.0;
  let morphed = (gridPosition + (evenLattice - gridPosition) * vertexMorphK) / quads;
  let nodeTexel = (node.sub + morphed) * quads;
  let fineResident = node.a.x >= 0.0;
  let sampledFine = terrainDrawnSample(node.a.x, nodeTexel.x, nodeTexel.y);
  var coarse = sampledFine;
  if (vertexMorphK > 0.0 || !fineResident) {
    let parentTexel = node.parity * 128.0 + node.sub * 16.0 + morphed * (quads * 0.5);
    coarse = terrainDrawnSample(node.b.y, parentTexel.x, parentTexel.y);
  }
  let fine = select(coarse, sampledFine, fineResident);
  let height = fine.x + (coarse.x - fine.x) * vertexMorphK;
  let parentGradient = coarse.yz * (quads * 0.5);
  let fineGradient = select(parentGradient, sampledFine.yz * quads, fineResident);
  return vec3f(height, fineGradient + (parentGradient - fineGradient) * vertexMorphK);
}

// The quad an interior row or column of the morphed tensor grid puts g in.
fn terrainDrawnColumn(g: f32, morphK: f32) -> f32 {
  let pair = clamp(floor(g * 0.5), 0.0, ${QUADS / 2 - 1}.0);
  let along = g - pair * 2.0;
  return pair * 2.0 + select(1.0, 0.0, along < 1.0 - morphK);
}

// Barycentric weights of p in (p0, p1, p2); all -1 for a triangle the morph
// collapsed or turned over (a back face: culled, so never what is drawn).
fn terrainDrawnWeights(p: vec2f, p0: vec2f, p1: vec2f, p2: vec2f) -> vec3f {
  let e1 = p1 - p0;
  let e2 = p2 - p0;
  let d = p - p0;
  let determinant = e1.x * e2.y - e1.y * e2.x;
  if (determinant < 1e-12) { return vec3f(-1.0); }
  let w1 = (d.x * e2.y - d.y * e2.x) / determinant;
  let w2 = (e1.x * d.y - e1.y * d.x) / determinant;
  return vec3f(1.0 - w1 - w2, w1, w2);
}

// The drawn surface at a point, in metres from the window's corner.
fn terrainDrawnSurface(windowPosition: vec2f) -> TerrainDrawnSurface {
  var result: TerrainDrawnSurface;
  result.height = 0.0;
  result.gradient = vec2f(0.0);
  result.valid = false;
  let cellMeters = ${TERRAIN_DRAWN_CELL_METERS}.0;
  let edge = uniforms.terrainDrawnWindow.x;
  let relative = floor(windowPosition / cellMeters);
  if (any(relative < vec2f(0.0)) || any(relative >= vec2f(edge))) { return result; }
  let wrapped = relative + uniforms.terrainDrawnWindow.yz;
  let texel = vec2i(wrapped - floor(wrapped / edge) * edge);
  let laneA = textureLoad(terrainDrawnLookup, vec2i(texel.x * 2, texel.y), 0);
  let absolute = uniforms.terrainDrawnOrigin.xy + relative;
  let period = ${TERRAIN_DRAWN_TAG_PERIOD}.0;
  let tagged = absolute - floor(absolute / period) * period;
  if (laneA.w != tagged.x + tagged.y * period + 1.0) { return result; }
  let laneB = textureLoad(terrainDrawnLookup, vec2i(texel.x * 2 + 1, texel.y), 0);
  if (laneA.x < 0.0 && laneB.y < 0.0) { return result; }

  var node: TerrainDrawnNode;
  node.a = laneA;
  node.b = laneB;
  let parityZ = floor(laneA.y * 0.0078125);
  let afterZ = laneA.y - parityZ * 128.0;
  let parityX = floor(afterZ * 0.015625);
  let subIndex = afterZ - parityX * 64.0;
  let subZ = floor(subIndex * 0.125);
  node.sub = vec2f(subIndex - subZ * 8.0, subZ);
  node.parity = vec2f(parityX, parityZ);

  let cells = exp2(laneA.z);
  let nodeCell = floor(absolute / cells) * cells;
  let span = cellMeters * cells;
  let unit = (windowPosition - (nodeCell - uniforms.terrainDrawnOrigin.xy) * cellMeters) / span;
  let g = clamp(unit * ${QUADS}.0, vec2f(0.0), vec2f(${QUADS}.0));
  let interiorK = select(0.0, clamp(laneB.x, 0.0, 1.0), laneB.y >= 0.0);
  let quad = vec2f(terrainDrawnColumn(g.x, interiorK), terrainDrawnColumn(g.y, interiorK));
  // Within a quad of an edge the grid folds where the edge's synchronised
  // morph and the interior's differ: a quad's triangle can turn over (culled,
  // never drawn) and two front faces can cover one point. Search the
  // neighbourhood of the edge's two quads and take the higher front face,
  // which is the one the depth test keeps from above. Further in, every
  // vertex shares one K and the grid is a tensor grid: the inverted quad is
  // exact.
  let ring = any(quad < vec2f(1.5)) || any(quad > vec2f(${QUADS - 2.5}));
  let reach = select(0, 1, ring);

  var bestScore = -1e9;
  var bestHeight = -1e30;
  var found = false;
  var nearest = vec3f(0.0);
  var nearestScore = -1e9;
  for (var dz = -reach; dz <= reach; dz += 1) {
    for (var dx = -reach; dx <= reach; dx += 1) {
      let q = clamp(quad + vec2f(f32(dx), f32(dz)), vec2f(0.0), vec2f(${QUADS - 1}.0));
      let topLeft = terrainDrawnPlace(node, q);
      let topRight = terrainDrawnPlace(node, q + vec2f(1.0, 0.0));
      let bottomLeft = terrainDrawnPlace(node, q + vec2f(0.0, 1.0));
      let bottomRight = terrainDrawnPlace(node, q + vec2f(1.0, 1.0));
      for (var half = 0; half < 2; half += 1) {
        // The node grid's two triangles: (TL, TR, BL) and (TR, BR, BL).
        var g0 = q;
        var g1 = q + vec2f(1.0, 0.0);
        var p0 = topLeft;
        var p1 = topRight;
        if (half == 1) {
          g0 = q + vec2f(1.0, 0.0);
          g1 = q + vec2f(1.0, 1.0);
          p0 = topRight;
          p1 = bottomRight;
        }
        let g2 = q + vec2f(0.0, 1.0);
        let weights = terrainDrawnWeights(unit, p0, p1, bottomLeft);
        let score = min(weights.x, min(weights.y, weights.z));
        if (score >= -1e-6 || (!found && score > nearestScore)) {
          let blended = terrainDrawnVertex(node, g0) * weights.x
            + terrainDrawnVertex(node, g1) * weights.y
            + terrainDrawnVertex(node, g2) * weights.z;
          if (score >= -1e-6) {
            if (!found || blended.x > bestHeight) {
              bestHeight = blended.x;
              nearest = blended;
            }
            found = true;
          } else {
            nearestScore = score;
            nearest = blended;
          }
        }
      }
    }
  }
  result.height = nearest.x;
  result.gradient = nearest.yz / span;
  result.valid = true;
  return result;
}

// The same, at a position in the consumer's local frame (TerrainDrawnHeight.bind).
fn terrainDrawnSurfaceAtLocal(localPosition: vec2f) -> TerrainDrawnSurface {
  return terrainDrawnSurface(localPosition + uniforms.terrainDrawnOrigin.zw);
}
`;

/**
 * The lookup, its texture and its window. One per terrain, owned by
 * `TerrainClipmapSystem` and refreshed by whichever consumer is in reach.
 */
export class TerrainDrawnHeight {
  /** Window edge, cells. */
  readonly windowCells: number;
  /** The CPU copy of the texture, row-major, two RGBA32F texels per cell. */
  readonly texels: Float32Array;
  private texture: RawTexture | null = null;
  private cornerCellX = 0;
  private cornerCellZ = 0;
  private readonly stamps: Uint32Array;
  private epoch = 0;
  private readonly rowFirst: Int32Array;
  private readonly rowLast: Int32Array;
  private readonly record = new Float32Array(FLOATS_PER_CELL);
  private refreshes = 0;
  private cellsWritten = 0;
  private rowsUploaded = 0;
  private refreshMilliseconds = 0;

  constructor(
    private readonly scene: Scene | null,
    reachMeters: number,
  ) {
    this.windowCells = terrainDrawnWindowCells(reachMeters);
    const edge = this.windowCells;
    this.texels = new Float32Array(edge * edge * FLOATS_PER_CELL);
    this.stamps = new Uint32Array(edge * edge);
    this.rowFirst = new Int32Array(edge).fill(-1);
    this.rowLast = new Int32Array(edge).fill(-1);
  }

  /** Absolute cell index of the window's corner (x, z). */
  get corner(): readonly [number, number] {
    return [this.cornerCellX, this.cornerCellZ];
  }

  get statistics(): TerrainDrawnHeightStatistics {
    return {
      refreshes: this.refreshes,
      cellsWritten: this.cellsWritten,
      rowsUploaded: this.rowsUploaded,
      refreshMilliseconds: this.refreshMilliseconds,
    };
  }

  /**
   * Write the cells within `radiusMeters` of (x, z) from this frame's records
   * and upload the rows that changed. Called after the terrain wrote its node
   * buffers, and only on a frame a consumer is within reach.
   */
  refresh(records: TerrainDrawnNodeRecords, centreX: number, centreZ: number, radiusMeters: number): void {
    const started = performance.now();
    const edge = this.windowCells;
    const half = edge / 2;
    const cell = TERRAIN_DRAWN_CELL_METERS;
    const centreCellX = Math.floor(centreX / cell);
    const centreCellZ = Math.floor(centreZ / cell);
    this.cornerCellX = centreCellX - half;
    this.cornerCellZ = centreCellZ - half;
    const reach = Math.min(half - 1, Math.ceil(Math.max(0, radiusMeters) / cell));
    const minX = centreCellX - reach;
    const maxX = centreCellX + reach;
    const minZ = centreCellZ - reach;
    const maxZ = centreCellZ + reach;
    this.epoch = (this.epoch + 1) >>> 0 || 1;
    this.cellsWritten = 0;
    const record = this.record;
    const count = Math.min(records.count, records.nodes.length);
    for (let index = 0; index < count; index += 1) {
      const node = records.nodes[index]!;
      const cells = 2 ** node.level;
      const nodeX = Math.round(node.originX / cell);
      const nodeZ = Math.round(node.originZ / cell);
      const x0 = Math.max(minX, nodeX);
      const x1 = Math.min(maxX, nodeX + cells - 1);
      const z0 = Math.max(minZ, nodeZ);
      const z1 = Math.min(maxZ, nodeZ + cells - 1);
      if (x0 > x1 || z0 > z1) continue;
      const lane = index * 4;
      record[0] = records.laneA[lane]!;
      record[1] = records.laneA[lane + 1]!;
      record[2] = records.laneA[lane + 2]!;
      record[4] = records.laneB[lane]!;
      record[5] = records.laneB[lane + 1]!;
      record[6] = 0;
      record[7] = records.laneB[lane + 3]!;
      for (let z = z0; z <= z1; z += 1) {
        for (let x = x0; x <= x1; x += 1) this.write(x, z, record);
      }
    }
    // A cell no record covered this frame (the far plane, a transient hole)
    // is written missing, so it never keeps a node that has gone.
    record.fill(0);
    record[0] = -1;
    record[5] = -1;
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const slot = this.slotOf(x, z);
        if (this.stamps[slot] !== this.epoch) this.write(x, z, record);
      }
    }
    this.upload();
    this.refreshes += 1;
    this.refreshMilliseconds = performance.now() - started;
  }

  /**
   * Bind the lookup and the height atlas for a consumer whose vertex
   * positions are relative to (localOriginX, localOriginZ), absolute metres.
   */
  bind(
    uniformBuffer: UniformBuffer,
    atlas: BaseTexture,
    atlasShape: TerrainDrawnAtlasShape,
    localOriginX: number,
    localOriginZ: number,
  ): void {
    const texture = this.ensureTexture();
    if (texture) uniformBuffer.setTexture("terrainDrawnLookup", texture);
    uniformBuffer.setTexture("terrainDrawnAtlas", atlas);
    uniformBuffer.updateFloat4(
      "terrainDrawnAtlasShape",
      atlasShape.atlasEdge,
      atlasShape.slotEdge,
      atlasShape.gutter,
      atlasShape.gridEdge,
    );
    const edge = this.windowCells;
    uniformBuffer.updateFloat4(
      "terrainDrawnWindow",
      edge,
      positiveModulo(this.cornerCellX, edge),
      positiveModulo(this.cornerCellZ, edge),
      TERRAIN_DRAWN_CELL_METERS,
    );
    uniformBuffer.updateFloat4(
      "terrainDrawnOrigin",
      this.cornerCellX,
      this.cornerCellZ,
      localOriginX - this.cornerCellX * TERRAIN_DRAWN_CELL_METERS,
      localOriginZ - this.cornerCellZ * TERRAIN_DRAWN_CELL_METERS,
    );
  }

  /** The texture, created on first use; null without a scene (Node). */
  ensureTexture(): RawTexture | null {
    if (this.texture || !this.scene) return this.texture;
    const edge = this.windowCells;
    this.texture = RawTexture.CreateRGBATexture(
      this.texels,
      edge * TEXELS_PER_CELL,
      edge,
      this.scene,
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
      Constants.TEXTURETYPE_FLOAT,
    );
    this.texture.name = "terrain-drawn-height";
    this.texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    // Everything written so far went up with the creation.
    this.rowFirst.fill(-1);
    this.rowLast.fill(-1);
    return this.texture;
  }

  /** The CPU twin at absolute (x, z), against this lookup as it stands. */
  surfaceAt(atlas: TerrainDrawnAtlasData, x: number, z: number): TerrainDrawnSurfaceSample | null {
    return terrainDrawnSurfaceAt(
      {
        texels: this.texels,
        windowCells: this.windowCells,
        cornerCellX: this.cornerCellX,
        cornerCellZ: this.cornerCellZ,
      },
      atlas,
      x - this.cornerCellX * TERRAIN_DRAWN_CELL_METERS,
      z - this.cornerCellZ * TERRAIN_DRAWN_CELL_METERS,
    );
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
  }

  private slotOf(x: number, z: number): number {
    const edge = this.windowCells;
    return positiveModulo(z, edge) * edge + positiveModulo(x, edge);
  }

  private write(x: number, z: number, record: Float32Array): void {
    const edge = this.windowCells;
    const column = positiveModulo(x, edge);
    const row = positiveModulo(z, edge);
    this.stamps[row * edge + column] = this.epoch;
    record[3] = terrainDrawnCellTag(x, z);
    const base = (row * edge + column) * FLOATS_PER_CELL;
    const texels = this.texels;
    let same = true;
    for (let lane = 0; lane < FLOATS_PER_CELL; lane += 1) {
      if (!Object.is(texels[base + lane], record[lane])) {
        same = false;
        break;
      }
    }
    if (same) return;
    texels.set(record, base);
    this.cellsWritten += 1;
    const first = column * TEXELS_PER_CELL;
    const last = first + TEXELS_PER_CELL - 1;
    if (this.rowFirst[row]! < 0 || first < this.rowFirst[row]!) this.rowFirst[row] = first;
    if (last > this.rowLast[row]!) this.rowLast[row] = last;
  }

  private upload(): void {
    this.rowsUploaded = 0;
    const texture = this.texture;
    const internal = texture?.getInternalTexture();
    const edge = this.windowCells;
    const rowTexels = edge * TEXELS_PER_CELL;
    for (let row = 0; row < edge; row += 1) {
      const first = this.rowFirst[row]!;
      if (first < 0) continue;
      const last = this.rowLast[row]!;
      this.rowFirst[row] = -1;
      this.rowLast[row] = -1;
      if (!internal || !this.scene) continue;
      const start = (row * rowTexels + first) * 4;
      (this.scene.getEngine() as WebGPUEngine).updateTextureData(
        internal,
        this.texels.subarray(start, start + (last - first + 1) * 4),
        first,
        row,
        last - first + 1,
        1,
        0,
        0,
        false,
      );
      this.rowsUploaded += 1;
    }
  }
}

function positiveModulo(value: number, period: number): number {
  return value - Math.floor(value / period) * period;
}

/** What the twin reads of a lookup: its texels and window. */
export interface TerrainDrawnLookupView {
  readonly texels: Float32Array;
  readonly windowCells: number;
  readonly cornerCellX: number;
  readonly cornerCellZ: number;
}

function sampleAtlas(atlas: TerrainDrawnAtlasData, slot: number, texelX: number, texelZ: number): [number, number, number] {
  if (slot < 0) return [0, 0, 0];
  const { atlasEdge, slotEdge, gutter, gridEdge } = atlas.shape;
  const row = Math.floor(slot / gridEdge);
  const originX = (slot - row * gridEdge) * slotEdge + gutter;
  const originZ = row * slotEdge + gutter;
  const baseX = Math.floor(texelX);
  const baseZ = Math.floor(texelZ);
  const fx = texelX - baseX;
  const fz = texelZ - baseZ;
  const cornerX = originX + baseX;
  const cornerZ = originZ + baseZ;
  const at = (x: number, z: number): number => atlas.heights[z * atlasEdge + x] ?? 0;
  const h00 = at(cornerX, cornerZ);
  const h10 = at(cornerX + 1, cornerZ);
  const h01 = at(cornerX, cornerZ + 1);
  const h11 = at(cornerX + 1, cornerZ + 1);
  const top = h00 + (h10 - h00) * fx;
  const bottom = h01 + (h11 - h01) * fx;
  const gradientX = (h10 - h00) + ((h11 - h01) - (h10 - h00)) * fz;
  const gradientZ = (h01 - h00) + ((h11 - h10) - (h01 - h00)) * fx;
  return [top + (bottom - top) * fz, gradientX, gradientZ];
}

interface DrawnNode {
  readonly a: readonly [number, number, number, number];
  readonly b: readonly [number, number, number, number];
  readonly corners: readonly [number, number, number, number];
  readonly subX: number;
  readonly subZ: number;
  readonly parityX: number;
  readonly parityZ: number;
}

function vertexMorph(node: DrawnNode, gridX: number, gridZ: number): number {
  return terrainNodeVertexMorphK(node.b[0], node.corners, gridX, gridZ, node.b[1] >= 0);
}

function placeOf(node: DrawnNode, gridX: number, gridZ: number): [number, number] {
  const k = vertexMorph(node, gridX, gridZ);
  const evenX = Math.floor(gridX * 0.5) * 2;
  const evenZ = Math.floor(gridZ * 0.5) * 2;
  return [(gridX + (evenX - gridX) * k) / QUADS, (gridZ + (evenZ - gridZ) * k) / QUADS];
}

function vertexOf(atlas: TerrainDrawnAtlasData, node: DrawnNode, gridX: number, gridZ: number): [number, number, number] {
  const k = vertexMorph(node, gridX, gridZ);
  const morphedX = (gridX + (Math.floor(gridX * 0.5) * 2 - gridX) * k) / QUADS;
  const morphedZ = (gridZ + (Math.floor(gridZ * 0.5) * 2 - gridZ) * k) / QUADS;
  const fineResident = node.a[0] >= 0;
  const sampledFine = sampleAtlas(atlas, node.a[0], (node.subX + morphedX) * QUADS, (node.subZ + morphedZ) * QUADS);
  let coarse = sampledFine;
  if (k > 0 || !fineResident) {
    coarse = sampleAtlas(
      atlas,
      node.b[1],
      node.parityX * 128 + node.subX * 16 + morphedX * (QUADS * 0.5),
      node.parityZ * 128 + node.subZ * 16 + morphedZ * (QUADS * 0.5),
    );
  }
  const fine = fineResident ? sampledFine : coarse;
  const height = fine[0] + (coarse[0] - fine[0]) * k;
  const parentX = coarse[1] * (QUADS * 0.5);
  const parentZ = coarse[2] * (QUADS * 0.5);
  const fineX = fineResident ? sampledFine[1] * QUADS : parentX;
  const fineZ = fineResident ? sampledFine[2] * QUADS : parentZ;
  return [height, fineX + (parentX - fineX) * k, fineZ + (parentZ - fineZ) * k];
}

function weightsOf(
  px: number, pz: number,
  p0: readonly [number, number], p1: readonly [number, number], p2: readonly [number, number],
): [number, number, number] {
  const e1x = p1[0] - p0[0];
  const e1z = p1[1] - p0[1];
  const e2x = p2[0] - p0[0];
  const e2z = p2[1] - p0[1];
  const dx = px - p0[0];
  const dz = pz - p0[1];
  const determinant = e1x * e2z - e1z * e2x;
  if (determinant < 1e-12) return [-1, -1, -1];
  const w1 = (dx * e2z - dz * e2x) / determinant;
  const w2 = (e1x * dz - e1z * dx) / determinant;
  return [1 - w1 - w2, w1, w2];
}

function columnOf(g: number, morphK: number): number {
  const pair = Math.min(QUADS / 2 - 1, Math.max(0, Math.floor(g * 0.5)));
  return pair * 2 + (g - pair * 2 < 1 - morphK ? 0 : 1);
}

/**
 * `terrainDrawnSurface`'s CPU twin, at a point in metres from the window's
 * corner: null where the WGSL would answer invalid.
 */
export function terrainDrawnSurfaceAt(
  lookup: TerrainDrawnLookupView,
  atlas: TerrainDrawnAtlasData,
  windowX: number,
  windowZ: number,
): TerrainDrawnSurfaceSample | null {
  const cell = TERRAIN_DRAWN_CELL_METERS;
  const edge = lookup.windowCells;
  const relativeX = Math.floor(windowX / cell);
  const relativeZ = Math.floor(windowZ / cell);
  if (relativeX < 0 || relativeZ < 0 || relativeX >= edge || relativeZ >= edge) return null;
  const absoluteX = lookup.cornerCellX + relativeX;
  const absoluteZ = lookup.cornerCellZ + relativeZ;
  const base = (positiveModulo(absoluteZ, edge) * edge + positiveModulo(absoluteX, edge)) * FLOATS_PER_CELL;
  const t = lookup.texels;
  if (t[base + 3] !== terrainDrawnCellTag(absoluteX, absoluteZ)) return null;
  const a = [t[base]!, t[base + 1]!, t[base + 2]!, t[base + 3]!] as const;
  const b = [t[base + 4]!, t[base + 5]!, t[base + 6]!, t[base + 7]!] as const;
  if (a[0] < 0 && b[1] < 0) return null;
  const parityZ = Math.floor(a[1] * 0.0078125);
  const afterZ = a[1] - parityZ * 128;
  const parityX = Math.floor(afterZ * 0.015625);
  const subIndex = afterZ - parityX * 64;
  const subZ = Math.floor(subIndex * 0.125);
  const node: DrawnNode = {
    a,
    b,
    corners: unpackTerrainCornerMorphs(b[3]),
    subX: subIndex - subZ * 8,
    subZ,
    parityX,
    parityZ,
  };
  const cells = 2 ** a[2];
  const span = cell * cells;
  const unitX = (windowX - (Math.floor(absoluteX / cells) * cells - lookup.cornerCellX) * cell) / span;
  const unitZ = (windowZ - (Math.floor(absoluteZ / cells) * cells - lookup.cornerCellZ) * cell) / span;
  const gx = Math.min(QUADS, Math.max(0, unitX * QUADS));
  const gz = Math.min(QUADS, Math.max(0, unitZ * QUADS));
  const interiorK = b[1] >= 0 ? Math.min(1, Math.max(0, b[0])) : 0;
  const quadX = columnOf(gx, interiorK);
  const quadZ = columnOf(gz, interiorK);
  const reach = quadX <= 1 || quadZ <= 1 || quadX >= QUADS - 2 || quadZ >= QUADS - 2 ? 1 : 0;
  let found = false;
  let bestHeight = -1e30;
  let nearestScore = -1e9;
  let nearest: [number, number, number] = [0, 0, 0];
  for (let dz = -reach; dz <= reach; dz += 1) {
    for (let dx = -reach; dx <= reach; dx += 1) {
      const qx = Math.min(QUADS - 1, Math.max(0, quadX + dx));
      const qz = Math.min(QUADS - 1, Math.max(0, quadZ + dz));
      const topLeft = placeOf(node, qx, qz);
      const topRight = placeOf(node, qx + 1, qz);
      const bottomLeft = placeOf(node, qx, qz + 1);
      const bottomRight = placeOf(node, qx + 1, qz + 1);
      for (let half = 0; half < 2; half += 1) {
        const grid: readonly (readonly [number, number])[] = half === 0
          ? [[qx, qz], [qx + 1, qz], [qx, qz + 1]]
          : [[qx + 1, qz], [qx + 1, qz + 1], [qx, qz + 1]];
        const weights = half === 0
          ? weightsOf(unitX, unitZ, topLeft, topRight, bottomLeft)
          : weightsOf(unitX, unitZ, topRight, bottomRight, bottomLeft);
        const score = Math.min(weights[0], weights[1], weights[2]);
        if (!(score >= -1e-6 || (!found && score > nearestScore))) continue;
        const blended: [number, number, number] = [0, 0, 0];
        for (let corner = 0; corner < 3; corner += 1) {
          const vertex = vertexOf(atlas, node, grid[corner]![0], grid[corner]![1]);
          for (let lane = 0; lane < 3; lane += 1) blended[lane] = blended[lane]! + vertex[lane]! * weights[corner]!;
        }
        if (score >= -1e-6) {
          if (!found || blended[0] > bestHeight) {
            bestHeight = blended[0];
            nearest = blended;
          }
          found = true;
        } else {
          nearestScore = score;
          nearest = blended;
        }
      }
    }
  }
  const [height, gradientX, gradientZ] = nearest;
  return { height, gradientX: gradientX / span, gradientZ: gradientZ / span };
}
