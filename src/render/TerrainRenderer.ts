import * as THREE from "three";
import type { TimeOfDayPreset, WeatherPreset } from "@/src/game/types";
import {
  generateTerrainGridIndices,
  worldToTerrainTile,
  type TerrainTileData,
  type WorldDefinition,
} from "@/src/world";
import { GroundCoverRenderer, type GroundCoverSurface } from "./GroundCoverRenderer";
import {
  BathymetryField,
  type WaterBathymetrySource,
} from "./BathymetryField";
import {
  applyTerrainBoundaryMorph,
  terrainMorphCoarseStride,
  type TerrainMorphEdges,
} from "./TerrainLodMorph";
import { TerrainGenerationClient } from "./TerrainGenerationClient";
import {
  createAspenCanopyGeometry,
  createDetailedTreeTrunkGeometry,
  createFarBroadleafGeometry,
  createFarConiferGeometry,
  createOakCanopyGeometry,
  createPineCanopyGeometry,
  createSpruceCanopyGeometry,
  FAR_FOREST_RADIUS,
  includesFarTreeLod,
  includesNearTreeLod,
  orderForestLodCandidates,
  selectTreeSpecies,
  snapForestLodCenter,
  TREE_SPECIES_PROFILES,
  treeRenderBudget,
  type ForestLodPriorityCandidate,
} from "./ForestSystem";

export interface RenderTerrainSample {
  height: number;
  normal?: { x: number; y: number; z: number };
  moisture?: number;
  rock?: number;
  slope?: number;
  temperature?: number;
  biome?: string | number;
  color?: { r: number; g: number; b: number };
  airportInfluence?: number;
  isRunway?: boolean;
}

export type TerrainSampleFunction = (x: number, z: number) => RenderTerrainSample;

export interface RenderRunwayDefinition {
  centerX: number;
  centerZ: number;
  elevation: number;
  headingRadians: number;
  runwayLength: number;
  runwayWidth: number;
}

interface TerrainChunk {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  key: string;
  tileX: number;
  tileZ: number;
  generation: number;
  requestId: number | null;
  ready: boolean;
  size: number;
  vertexResolution: number;
  isFar: boolean;
  readonly sourceHeights: Float32Array;
  readonly sourceNormals: Float32Array;
  hasSourceData: boolean;
  sourceRevision: number;
  appliedMorphSignature: string;
}

interface FarForestCandidate extends ForestLodPriorityCandidate {
  readonly cellX: number;
  readonly cellZ: number;
  readonly forestPatch: number;
  readonly height: number;
  readonly x: number;
  readonly z: number;
}

const FAR_TILE_SCALE = 8;
const FAR_TILE_RADIUS = 1;
// The horizon mesh is tiny compared with the streamed tile grids; spending a
// few hundred extra vertices here removes the faceted mountain silhouette that
// was visible against the sky at medium quality.
// The streamed far grid carries the actual lighting and depth, while this
// inexpensive ring only supplies the last silhouette against the atmosphere.
// 256 angular samples keep a 30--40 km ridge below roughly a two-pixel chord at
// common browser resolutions without adding another draw call.
const HORIZON_SEGMENTS = 256;
const HORIZON_RADII = [7_200, 11_500, 18_000, 27_000, 39_000] as const;
const MAX_NEAR_TREES = 2_200;
const MAX_FAR_TREES = 4_200;
const MAX_ROCKS = 900;
const TREE_CELL_SIZE = 145;
const FAR_TREE_CELL_SIZE = 380;
const WATER_RADIUS = 42_000;
const WATER_RADIAL_SEGMENTS = 128;
const WATER_RING_RADII = [96, 192, 384, 768, 1_536, 3_072, 6_144, 12_288, 24_576, WATER_RADIUS] as const;
const WATER_CENTER_SNAP = 512;
// Keep the rendered surface and the terrain cutout separated deliberately.
// At kilometre-scale view distances a 24-bit perspective depth buffer cannot
// reliably distinguish the old 6 cm water/sea-floor gap.  Removing submerged
// terrain fragments is what guarantees that the two surfaces never z-fight;
// the small offset only gives the shoreline a clean wet edge at close range.
export const WATER_RENDER_LEVEL = 0.14;
// Discard every terrain fragment that could quantize onto the opaque ocean.
// Keeping this just above the rendered plane removes the old submerged overlap
// without visibly moving the shoreline up otherwise dry ground.
export const TERRAIN_WATER_CUTOUT_LEVEL = WATER_RENDER_LEVEL + 0.01;

const NEAR_TERRAIN_VERTEX_RESOLUTION = {
  low: 25,
  // 33 m and 25 m samples respectively preserve much more of the 60--100 m
  // geological residual while keeping the default worker/sample budget below
  // 270k visible terrain triangles. The former 40 m grid sat at the Nyquist
  // limit, so worker-generated gullies collapsed into smooth interpolation.
  medium: 49,
  high: 65,
} as const;
const FAR_TERRAIN_VERTEX_RESOLUTION = {
  low: 25,
  // Each 12.8 km far tile spans eight near tiles. Matching segment counts
  // makes every eighth fine edge vertex land on the coarse grid exactly.
  medium: 49,
  high: 65,
} as const;

export function terrainVertexResolution(
  quality: "low" | "medium" | "high",
  lod: "near" | "far",
): number {
  return lod === "near"
    ? NEAR_TERRAIN_VERTEX_RESOLUTION[quality]
    : FAR_TERRAIN_VERTEX_RESOLUTION[quality];
}

function matchingFarVertexResolution(nearVertexResolution: number): number {
  if (nearVertexResolution === NEAR_TERRAIN_VERTEX_RESOLUTION.low) {
    return FAR_TERRAIN_VERTEX_RESOLUTION.low;
  }
  if (nearVertexResolution === NEAR_TERRAIN_VERTEX_RESOLUTION.medium) {
    return FAR_TERRAIN_VERTEX_RESOLUTION.medium;
  }
  if (nearVertexResolution === NEAR_TERRAIN_VERTEX_RESOLUTION.high) {
    return FAR_TERRAIN_VERTEX_RESOLUTION.high;
  }
  throw new RangeError(`Unsupported near terrain resolution: ${nearVertexResolution}`);
}

function hash01(x: number, z: number, seed: number): number {
  let value = Math.imul(x ^ seed, 0x45d9f3b) ^ Math.imul(z, 0x27d4eb2d);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function smoothHashField(x: number, z: number, scale: number, seed: number): number {
  const gridX = x / scale;
  const gridZ = z / scale;
  const x0 = Math.floor(gridX);
  const z0 = Math.floor(gridZ);
  const tx = THREE.MathUtils.smoothstep(gridX - x0, 0, 1);
  const tz = THREE.MathUtils.smoothstep(gridZ - z0, 0, 1);
  const top = THREE.MathUtils.lerp(hash01(x0, z0, seed), hash01(x0 + 1, z0, seed), tx);
  const bottom = THREE.MathUtils.lerp(
    hash01(x0, z0 + 1, seed),
    hash01(x0 + 1, z0 + 1, seed),
    tx,
  );
  return THREE.MathUtils.lerp(top, bottom, tz);
}

function periodicNoise01(x: number, z: number, frequency: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = THREE.MathUtils.smoothstep(x - x0, 0, 1);
  const tz = THREE.MathUtils.smoothstep(z - z0, 0, 1);
  const wrap = (value: number) => ((value % frequency) + frequency) % frequency;
  const top = THREE.MathUtils.lerp(
    hash01(wrap(x0), wrap(z0), seed),
    hash01(wrap(x0 + 1), wrap(z0), seed),
    tx,
  );
  const bottom = THREE.MathUtils.lerp(
    hash01(wrap(x0), wrap(z0 + 1), seed),
    hash01(wrap(x0 + 1), wrap(z0 + 1), seed),
    tx,
  );
  return THREE.MathUtils.lerp(top, bottom, tz);
}

function createTerrainDetailTexture(seed: number): THREE.DataTexture {
  // 256² is only 256 KiB before mipmaps, but preserves sub-metre grass/soil
  // breakup in the close LOD instead of magnifying a blurry 128² field.
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const offset = (row * size + column) * 4;
      const normalizedX = column / size;
      const normalizedZ = row / size;
      const macro =
        periodicNoise01(normalizedX * 4, normalizedZ * 4, 4, seed ^ 0x1721) * 0.58 +
        periodicNoise01(normalizedX * 9, normalizedZ * 9, 9, seed ^ 0x4177) * 0.3 +
        periodicNoise01(normalizedX * 19, normalizedZ * 19, 19, seed ^ 0x711d) * 0.12;
      const detail =
        periodicNoise01(normalizedX * 17, normalizedZ * 17, 17, seed ^ 0x293f) * 0.68 +
        periodicNoise01(normalizedX * 37, normalizedZ * 37, 37, seed ^ 0x61c7) * 0.32;
      const smoothGrain =
        periodicNoise01(normalizedX * 41, normalizedZ * 41, 41, seed ^ 0x3341) * 0.6 +
        periodicNoise01(normalizedX * 61, normalizedZ * 61, 61, seed ^ 0x7259) * 0.4;
      // Value-noise alone is intentionally smooth and was surviving as a soft
      // colour wash even at the highest mip. A bounded cellular/high-pass term
      // supplies gravel, soil pores, and short grass tips. Mipmapping still
      // integrates it at distance, so this sharpness does not turn into crawl.
      const texelHash = hash01(column, row, seed ^ 0x4e2d);
      const fractured = Math.abs(
        periodicNoise01(normalizedX * 73, normalizedZ * 73, 73, seed ^ 0x58a7) * 2 - 1,
      );
      const hardGrain = THREE.MathUtils.smoothstep(fractured, 0.52, 0.91);
      const grain = THREE.MathUtils.clamp(
        smoothGrain * 0.58 + hardGrain * 0.29 + texelHash * 0.13,
        0,
        1,
      );
      data[offset] = Math.round(macro * 255);
      data[offset + 1] = Math.round(detail * 255);
      data[offset + 2] = Math.round(grain * 255);
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = "deterministic-terrain-detail";
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  // Three clamps this request to the device capability at upload time. It is
  // especially important for the long grazing-angle views seen while taxiing.
  texture.anisotropy = 16;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function terrainColor(sample: RenderTerrainSample, target: THREE.Color): THREE.Color {
  if (sample.color) return target.setRGB(sample.color.r, sample.color.g, sample.color.b);
  const moisture = sample.moisture ?? 0.5;
  const rock = sample.rock ?? THREE.MathUtils.smoothstep(sample.height, 420, 1_050);
  if (sample.height < 4) return target.set(0xb8aa79);
  if (sample.height > 1_400) return target.set(0xd7d7cb);
  const lowland = new THREE.Color().setHSL(0.23 + moisture * 0.035, 0.33, 0.31 + moisture * 0.12);
  const stone = new THREE.Color(0x746f64);
  return target.copy(lowland).lerp(stone, THREE.MathUtils.clamp(rock, 0, 0.84));
}

function makeTerrainGeometry(
  tileSize: number,
  vertexResolution: number,
  index: THREE.BufferAttribute,
  placeholderHeight: number,
  placeholderColor: THREE.Color,
): THREE.BufferGeometry {
  const vertexCount = vertexResolution * vertexResolution;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Uint8Array(vertexCount * 3);
  const segments = vertexResolution - 1;
  const red = Math.round(placeholderColor.r * 255);
  const green = Math.round(placeholderColor.g * 255);
  const blue = Math.round(placeholderColor.b * 255);

  let vertexOffset = 0;
  for (let row = 0; row < vertexResolution; row += 1) {
    const localZ = (row / segments) * tileSize;
    for (let column = 0; column < vertexResolution; column += 1) {
      positions[vertexOffset] = (column / segments) * tileSize;
      positions[vertexOffset + 1] = placeholderHeight;
      positions[vertexOffset + 2] = localZ;
      normals[vertexOffset + 1] = 1;
      colors[vertexOffset] = red;
      colors[vertexOffset + 1] = green;
      colors[vertexOffset + 2] = blue;
      vertexOffset += 3;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setAttribute(
    "normal",
    new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setAttribute(
    "color",
    new THREE.BufferAttribute(colors, 3, true).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setIndex(index);
  setTerrainBounds(geometry, tileSize, placeholderHeight, placeholderHeight);
  return geometry;
}

function setTerrainBounds(
  geometry: THREE.BufferGeometry,
  tileSize: number,
  minHeight: number,
  maxHeight: number,
): void {
  const centerHeight = (minHeight + maxHeight) * 0.5;
  const halfVerticalRange = Math.max(1, (maxHeight - minHeight) * 0.5);
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(0, minHeight, 0),
    new THREE.Vector3(tileSize, maxHeight, tileSize),
  );
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(tileSize * 0.5, centerHeight, tileSize * 0.5),
    Math.hypot(tileSize * 0.5, tileSize * 0.5, halfVerticalRange),
  );
}

function createHorizonGeometry(): THREE.BufferGeometry {
  const ringCount = HORIZON_RADII.length;
  const vertexCount = (HORIZON_SEGMENTS + 1) * ringCount;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Uint8Array(vertexCount * 3);
  const indices = new Uint32Array((ringCount - 1) * HORIZON_SEGMENTS * 6);
  let cursor = 0;
  for (let ring = 0; ring < ringCount - 1; ring += 1) {
    for (let segment = 0; segment < HORIZON_SEGMENTS; segment += 1) {
      const current = ring * (HORIZON_SEGMENTS + 1) + segment;
      const next = current + HORIZON_SEGMENTS + 1;
      indices[cursor] = current;
      indices[cursor + 1] = next;
      indices[cursor + 2] = current + 1;
      indices[cursor + 3] = current + 1;
      indices[cursor + 4] = next;
      indices[cursor + 5] = next + 1;
      cursor += 6;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3, true));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

function mergeGeometryParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const unpacked = parts.map((part) => (part.index ? part.toNonIndexed() : part.clone()));
  const vertexCount = unpacked.reduce(
    (sum, geometry) => sum + geometry.getAttribute("position").count,
    0,
  );
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  let offset = 0;
  for (const geometry of unpacked) {
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const normal = geometry.getAttribute("normal") as THREE.BufferAttribute;
    positions.set(position.array as Float32Array, offset * 3);
    normals.set(normal.array as Float32Array, offset * 3);
    offset += position.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  for (const geometry of unpacked) geometry.dispose();
  for (const geometry of parts) geometry.dispose();
  return merged;
}

function createRockOutcropGeometry(): THREE.BufferGeometry {
  // Overlapping, asymmetrically scaled low-poly stones produce fractured
  // outcrops while retaining one instanced draw call for the whole field.
  const core = new THREE.DodecahedronGeometry(1, 0);
  core.scale(1, 0.68, 0.82);
  core.rotateY(0.31);
  const shoulder = new THREE.DodecahedronGeometry(0.72, 0);
  shoulder.scale(1.05, 0.58, 0.76);
  shoulder.rotateY(-0.47);
  shoulder.translate(0.72, -0.18, 0.18);
  const shard = new THREE.DodecahedronGeometry(0.54, 0);
  shard.scale(0.72, 0.92, 0.58);
  shard.rotateZ(0.24);
  shard.translate(-0.62, 0.02, -0.28);
  return mergeGeometryParts([core, shoulder, shard]);
}

/**
 * A camera-centred radial grid avoids rasterising the ocean as two enormous
 * 120 km triangles.  Those triangles repeatedly crossed the near plane and
 * lost interpolation precision as the chase camera banked.  Concentric rings
 * keep primitives compact close to the camera, then grow toward the fogged
 * horizon for a fixed browser-friendly triangle budget.
 */
export function createConcentricWaterGeometry(): THREE.BufferGeometry {
  const ringCount = WATER_RING_RADII.length;
  const vertexCount = 1 + ringCount * WATER_RADIAL_SEGMENTS;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const triangleCount = WATER_RADIAL_SEGMENTS +
    (ringCount - 1) * WATER_RADIAL_SEGMENTS * 2;
  const indices = new Uint16Array(triangleCount * 3);

  normals[1] = 1;
  uvs[0] = 0.5;
  uvs[1] = 0.5;
  for (let ring = 0; ring < ringCount; ring += 1) {
    const radius = WATER_RING_RADII[ring]!;
    for (let segment = 0; segment < WATER_RADIAL_SEGMENTS; segment += 1) {
      const angle = (segment / WATER_RADIAL_SEGMENTS) * Math.PI * 2;
      const vertex = 1 + ring * WATER_RADIAL_SEGMENTS + segment;
      const positionOffset = vertex * 3;
      positions[positionOffset] = Math.cos(angle) * radius;
      positions[positionOffset + 2] = Math.sin(angle) * radius;
      normals[positionOffset + 1] = 1;
      const uvOffset = vertex * 2;
      uvs[uvOffset] = 0.5 + positions[positionOffset]! / (WATER_RADIUS * 2);
      uvs[uvOffset + 1] = 0.5 + positions[positionOffset + 2]! / (WATER_RADIUS * 2);
    }
  }

  let indexOffset = 0;
  for (let segment = 0; segment < WATER_RADIAL_SEGMENTS; segment += 1) {
    const current = 1 + segment;
    const next = 1 + (segment + 1) % WATER_RADIAL_SEGMENTS;
    // Counter-clockwise when viewed from above, so the primary face is +Y.
    indices[indexOffset] = 0;
    indices[indexOffset + 1] = next;
    indices[indexOffset + 2] = current;
    indexOffset += 3;
  }
  for (let ring = 0; ring < ringCount - 1; ring += 1) {
    const innerStart = 1 + ring * WATER_RADIAL_SEGMENTS;
    const outerStart = innerStart + WATER_RADIAL_SEGMENTS;
    for (let segment = 0; segment < WATER_RADIAL_SEGMENTS; segment += 1) {
      const nextSegment = (segment + 1) % WATER_RADIAL_SEGMENTS;
      const innerCurrent = innerStart + segment;
      const innerNext = innerStart + nextSegment;
      const outerCurrent = outerStart + segment;
      const outerNext = outerStart + nextSegment;
      indices[indexOffset] = innerCurrent;
      indices[indexOffset + 1] = outerNext;
      indices[indexOffset + 2] = outerCurrent;
      indices[indexOffset + 3] = innerCurrent;
      indices[indexOffset + 4] = innerNext;
      indices[indexOffset + 5] = outerNext;
      indexOffset += 6;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Snapping keeps the ocean's remote edges stable without changing coverage. */
export function snapWaterCenter(value: number): number {
  return Math.round(value / WATER_CENTER_SNAP) * WATER_CENTER_SNAP;
}

/** Keep procedural objects clear of both the runway strip and service apron. */
export function isInsideAirportSceneryClearance(
  runway: RenderRunwayDefinition | undefined,
  x: number,
  z: number,
): boolean {
  if (!runway) return false;
  const dx = x - runway.centerX;
  const dz = z - runway.centerZ;
  const sinHeading = Math.sin(runway.headingRadians);
  const cosHeading = Math.cos(runway.headingRadians);
  const along = dx * sinHeading + dz * cosHeading;
  const across = dx * cosHeading - dz * sinHeading;
  const runwayStrip =
    Math.abs(along) <= runway.runwayLength * 0.5 + 110 &&
    Math.abs(across) <= runway.runwayWidth * 0.5 + 80;
  const serviceArea =
    across >= runway.runwayWidth * 0.5 + 5 &&
    across <= runway.runwayWidth * 0.5 + 215 &&
    along >= -runway.runwayLength * 0.18 - 150 &&
    along <= -runway.runwayLength * 0.18 + 150;
  return runwayStrip || serviceArea;
}

export function setNearTerrainCutoutBounds(
  target: THREE.Vector4,
  centerTileX: number,
  centerTileZ: number,
  radius: number,
  tileSize: number,
  originX: number,
  originZ: number,
): THREE.Vector4 {
  return target.set(
    (centerTileX - radius) * tileSize - originX,
    (centerTileX + radius + 1) * tileSize - originX,
    (centerTileZ - radius) * tileSize - originZ,
    (centerTileZ + radius + 1) * tileSize - originZ,
  );
}

export class TerrainRenderer {
  readonly group = new THREE.Group();

  private readonly material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
    flatShading: false,
    dithering: true,
    // Normal depth testing preserves self-occlusion across hills and ridges.
    // The overlapping coarse grid is fragment-masked beneath this surface.
    depthFunc: THREE.LessEqualDepth,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  /**
   * Far LOD tiles render first and write ordinary scene depth. They overlap the
   * near grid geometrically, but its covered fragments are discarded so normal
   * depth testing remains correct within every ridge and valley.
   */
  private readonly farMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
    flatShading: false,
    dithering: true,
  });
  private readonly horizonMaterial = new THREE.MeshLambertMaterial({
    vertexColors: true,
    fog: false,
    side: THREE.DoubleSide,
    dithering: true,
    // The horizon is a color-only backdrop. It must not write coarse ring
    // depths in front of the streamed terrain that supersedes it.
    depthWrite: false,
  });
  private readonly horizonTerrain: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  private readonly water: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  private readonly runwayGroup = new THREE.Group();
  private readonly treeTrunks: THREE.InstancedMesh;
  private readonly treeCanopies: THREE.InstancedMesh;
  private readonly aspenCanopies: THREE.InstancedMesh;
  private readonly coniferCanopies: THREE.InstancedMesh;
  private readonly spruceCanopies: THREE.InstancedMesh;
  private readonly farForest: THREE.InstancedMesh;
  private readonly farBroadleafForest: THREE.InstancedMesh;
  private readonly rocks: THREE.InstancedMesh;
  private readonly groundCover: GroundCoverRenderer;
  private readonly terrainGeneration: TerrainGenerationClient;
  private readonly chunks = new Map<string, TerrainChunk>();
  private readonly available: TerrainChunk[] = [];
  private readonly retiredChunks = new Map<string, TerrainChunk>();
  private readonly indexArrays = new Map<number, Uint16Array | Uint32Array>();
  private readonly farCutoutBounds = new THREE.Vector4();
  private readonly terrainWorldOrigin = { value: new THREE.Vector2() };
  private readonly terrainDetailMap: { value: THREE.DataTexture };
  private readonly waterTime = { value: 0 };
  private readonly waterWorldOrigin = { value: new THREE.Vector2() };
  private readonly waterSunDirection = {
    value: new THREE.Vector3(4_300, 5_900, -7_800).normalize(),
  };
  // These are incident-radiance tints, not literal sky albedo. Keeping the
  // reflected horizon below the scene-background value prevents foggy weather
  // from bleaching the ocean into a flat cyan card.
  private readonly waterHorizonReflection = { value: new THREE.Color(0x78989b) };
  private readonly waterZenithReflection = { value: new THREE.Color(0x245f7e) };
  private readonly waterSunReflection = { value: new THREE.Color(0xffdda0) };
  private readonly waterSunGlintStrength = { value: 0.82 };
  private readonly waterPlanarReflectionMap = { value: null as THREE.Texture | null };
  private readonly waterPlanarReflectionMatrix = { value: new THREE.Matrix4() };
  private readonly waterPlanarReflectionStrength = { value: 0 };
  private readonly waterHybridCompositeStrength = { value: 0 };
  private readonly bathymetry: BathymetryField;
  private readonly waterBathymetryValid = { value: 0 };
  private readonly tempMatrix = new THREE.Matrix4();
  private readonly tempPosition = new THREE.Vector3();
  private readonly tempQuaternion = new THREE.Quaternion();
  private readonly tempEuler = new THREE.Euler();
  private readonly tempScale = new THREE.Vector3();
  private readonly tempColor = new THREE.Color();
  private readonly upAxis = new THREE.Vector3(0, 1, 0);
  private centerTileX = Number.NaN;
  private centerTileZ = Number.NaN;
  private originX = 0;
  private originZ = 0;
  private resolution: number;
  private farResolution: number;
  private radius: number;
  private quality: "low" | "medium" | "high";
  private generationEpoch = 0;
  private disposed = false;
  private sceneRevisionValue = 0;
  private bathymetrySourceRevision = 0;
  private treesDirty = true;
  private nextTreeRefreshTime = 0;
  private horizonCenterX = Number.NaN;
  private horizonCenterZ = Number.NaN;
  private forestCenterX = Number.NaN;
  private forestCenterZ = Number.NaN;

  constructor(
    private readonly sample: TerrainSampleFunction,
    private readonly seed: number,
    private readonly tileSize = 1_600,
    quality: "low" | "medium" | "high" = "medium",
    private readonly runway?: RenderRunwayDefinition,
    resolvedWorld?: WorldDefinition,
  ) {
    this.quality = quality;
    this.resolution = terrainVertexResolution(quality, "near") - 1;
    this.farResolution = terrainVertexResolution(quality, "far");
    this.radius = quality === "low" ? 2 : 3;
    this.terrainGeneration = new TerrainGenerationClient(resolvedWorld ?? seed);
    this.terrainDetailMap = { value: createTerrainDetailTexture(seed) };
    // Reuse the deterministic, mipmapped four-channel terrain detail field as
    // the water normal source. Sampling it at independent scales/directions
    // gives the ocean real texture for no additional texture allocation.
    this.bathymetry = new BathymetryField(
      WATER_RENDER_LEVEL,
      this.terrainDetailMap.value,
    );
    this.groundCover = new GroundCoverRenderer(
      seed,
      quality,
      (x, z) => this.sampleLoadedGroundSurface(x, z),
      (x, z) => this.isInsideRunwayClearance(x, z),
    );
    this.group.name = "procedural-world";
    this.configureNearTerrainSurface();
    this.configureFarTerrainCutout();

    this.horizonTerrain = new THREE.Mesh(createHorizonGeometry(), this.horizonMaterial);
    this.horizonTerrain.name = "always-ready-distant-terrain";
    this.horizonTerrain.renderOrder = -40;
    this.horizonTerrain.receiveShadow = false;
    this.horizonTerrain.castShadow = false;
    this.horizonTerrain.frustumCulled = false;
    this.configureHorizonWaterCutout();
    this.group.add(this.horizonTerrain);

    const waterGeometry = createConcentricWaterGeometry();
    const waterMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x0c465d,
      // Water is a smooth dielectric, not a metal.  Most of the apparent
      // roughness comes from the animated normal field below.
      roughness: quality === "low" ? 0.22 : quality === "medium" ? 0.14 : 0.095,
      metalness: 0,
      ior: 1.333,
      specularIntensity: 1,
      clearcoat: quality === "low" ? 0.82 : 1,
      clearcoatRoughness: quality === "low" ? 0.18 : quality === "medium" ? 0.1 : 0.07,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      // Banking below wave height must not make the entire ocean vanish when
      // the chase camera crosses the mathematical surface for a frame.
      side: THREE.DoubleSide,
      dithering: true,
    });
    this.configureWaterMaterial(waterMaterial);
    this.water = new THREE.Mesh(waterGeometry, waterMaterial);
    this.water.name = "stable-procedural-water";
    this.water.position.y = WATER_RENDER_LEVEL;
    // A single 120 km receiver amplifies tiny shadow-map texel changes into
    // conspicuous dark flashes. Reflections and direct specular light provide
    // the correct water lighting cues without sampling the moving shadow map.
    this.water.receiveShadow = false;
    this.water.castShadow = false;
    this.water.frustumCulled = false;
    this.water.renderOrder = -30;
    this.group.add(this.water);

    const trunkMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      flatShading: true,
    });
    const canopyMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      flatShading: true,
      dithering: true,
    });
    const aspenMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.88,
      flatShading: true,
      dithering: true,
    });
    const coniferMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
      flatShading: true,
      dithering: true,
    });
    const spruceMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.97,
      flatShading: true,
      dithering: true,
    });
    const farTreeMaterial = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      flatShading: true,
      dithering: true,
    });
    const rockMaterial = new THREE.MeshStandardMaterial({
      color: 0x77756c,
      roughness: 0.94,
      flatShading: true,
    });
    this.treeTrunks = new THREE.InstancedMesh(
      createDetailedTreeTrunkGeometry(),
      trunkMaterial,
      MAX_NEAR_TREES,
    );
    this.treeCanopies = new THREE.InstancedMesh(
      createOakCanopyGeometry(),
      canopyMaterial,
      MAX_NEAR_TREES,
    );
    this.aspenCanopies = new THREE.InstancedMesh(
      createAspenCanopyGeometry(),
      aspenMaterial,
      MAX_NEAR_TREES,
    );
    this.coniferCanopies = new THREE.InstancedMesh(
      createPineCanopyGeometry(),
      coniferMaterial,
      MAX_NEAR_TREES,
    );
    this.spruceCanopies = new THREE.InstancedMesh(
      createSpruceCanopyGeometry(),
      spruceMaterial,
      MAX_NEAR_TREES,
    );
    this.farForest = new THREE.InstancedMesh(
      createFarConiferGeometry(),
      farTreeMaterial,
      MAX_FAR_TREES,
    );
    this.farBroadleafForest = new THREE.InstancedMesh(
      createFarBroadleafGeometry(),
      farTreeMaterial.clone(),
      MAX_FAR_TREES,
    );
    this.rocks = new THREE.InstancedMesh(
      createRockOutcropGeometry(),
      rockMaterial,
      MAX_ROCKS,
    );
    this.treeTrunks.castShadow = quality !== "low";
    this.treeCanopies.castShadow = quality !== "low";
    this.aspenCanopies.castShadow = quality !== "low";
    this.coniferCanopies.castShadow = quality !== "low";
    this.spruceCanopies.castShadow = quality !== "low";
    this.treeTrunks.receiveShadow = true;
    this.treeCanopies.receiveShadow = true;
    this.aspenCanopies.receiveShadow = true;
    this.coniferCanopies.receiveShadow = true;
    this.spruceCanopies.receiveShadow = true;
    this.farForest.castShadow = false;
    this.farForest.receiveShadow = false;
    this.farBroadleafForest.castShadow = false;
    this.farBroadleafForest.receiveShadow = false;
    this.rocks.castShadow = quality === "high";
    this.rocks.receiveShadow = true;
    for (const instances of [
      this.treeTrunks,
      this.treeCanopies,
      this.aspenCanopies,
      this.coniferCanopies,
      this.spruceCanopies,
      this.farForest,
      this.farBroadleafForest,
      this.rocks,
    ]) {
      instances.count = 0;
      instances.frustumCulled = false;
      instances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    this.treeTrunks.name = "near-tree-trunks";
    this.treeCanopies.name = "near-oak-canopies";
    this.aspenCanopies.name = "near-aspen-canopies";
    this.coniferCanopies.name = "near-pine-canopies";
    this.spruceCanopies.name = "near-spruce-canopies";
    this.farForest.name = "far-conifer-forest-lod";
    this.farBroadleafForest.name = "far-broadleaf-forest-lod";
    this.rocks.name = "scattered-rocks";
    this.group.add(
      this.farForest,
      this.farBroadleafForest,
      this.treeTrunks,
      this.treeCanopies,
      this.aspenCanopies,
      this.coniferCanopies,
      this.spruceCanopies,
      this.rocks,
      this.groundCover.group,
    );

    if (this.runway) {
      this.createRunway(this.runway);
      this.group.add(this.runwayGroup);
    }
  }

  get tileCount(): number {
    return this.chunks.size;
  }

  /** Changes when streamed mesh membership or render visibility changes. */
  get sceneRevision(): number {
    return this.sceneRevisionValue;
  }

  /** Read-only integration seam used to exclude the ocean from reflection passes. */
  get waterSurface(): THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial> {
    return this.water;
  }

  /** Absolute-world underwater depth field shared by forward and hybrid water. */
  get waterBathymetry(): WaterBathymetrySource {
    return this.bathymetry;
  }

  /**
   * Supplies a projected planar reflection without changing the stable opaque
   * fallback. `textureMatrix` maps scene-local water positions to homogeneous
   * reflection UVs, matching Three's Reflector-style projection convention.
   * The render target remains owned by the caller.
   */
  setWaterReflection(
    texture: THREE.Texture | null,
    textureMatrix?: THREE.Matrix4,
    strength = 1,
  ): void {
    this.waterPlanarReflectionMap.value = texture;
    if (textureMatrix) this.waterPlanarReflectionMatrix.value.copy(textureMatrix);
    this.waterPlanarReflectionStrength.value = texture
      ? THREE.MathUtils.clamp(Number.isFinite(strength) ? strength : 0, 0, 1)
      : 0;
  }

  /**
   * Selects one owner for depth absorption. Balanced/forward rendering applies
   * it in this material; hybrid rendering supplies a neutral dark base here and
   * applies Beer-Lambert once in the depth-aware composite.
   */
  setHybridWaterCompositeActive(active: boolean): void {
    this.waterHybridCompositeStrength.value = active ? 1 : 0;
  }

  /** Prevent recursive water rendering while guaranteeing visibility restoration. */
  withWaterSurfaceHidden<T>(renderReflection: () => T): T {
    const wasVisible = this.water.visible;
    this.water.visible = false;
    try {
      return renderReflection();
    } finally {
      this.water.visible = wasVisible;
    }
  }

  update(worldX: number, worldZ: number, originX: number, originZ: number): void {
    if (this.disposed) return;
    const now = performance.now();
    const originChanged = originX !== this.originX || originZ !== this.originZ;
    this.originX = originX;
    this.originZ = originZ;
    this.terrainWorldOrigin.value.set(originX, originZ);
    this.waterWorldOrigin.value.set(originX, originZ);
    const nextHorizonCenterX = Math.round(worldX / 6_400) * 6_400;
    const nextHorizonCenterZ = Math.round(worldZ / 6_400) * 6_400;
    if (
      nextHorizonCenterX !== this.horizonCenterX ||
      nextHorizonCenterZ !== this.horizonCenterZ
    ) {
      this.horizonCenterX = nextHorizonCenterX;
      this.horizonCenterZ = nextHorizonCenterZ;
      this.refreshHorizon();
    } else if (originChanged) {
      this.positionHorizon();
    }
    const nextTileX = worldToTerrainTile(worldX, this.tileSize);
    const nextTileZ = worldToTerrainTile(worldZ, this.tileSize);
    const centerChanged = nextTileX !== this.centerTileX || nextTileZ !== this.centerTileZ;
    const nextForestCenterX = snapForestLodCenter(worldX);
    const nextForestCenterZ = snapForestLodCenter(worldZ);
    const forestCenterChanged =
      nextForestCenterX !== this.forestCenterX || nextForestCenterZ !== this.forestCenterZ;
    this.forestCenterX = nextForestCenterX;
    this.forestCenterZ = nextForestCenterZ;
    if (centerChanged) {
      this.centerTileX = nextTileX;
      this.centerTileZ = nextTileZ;
      this.refreshChunks();
      this.treesDirty = true;
    } else {
      this.positionChunks();
    }
    this.bathymetry.update(
      {
        worldX,
        worldZ,
        sourceRevision: this.bathymetrySourceRevision,
        nowMs: now,
      },
      (sampleX, sampleZ) => this.sampleLoadedBathymetryHeight(sampleX, sampleZ),
    );
    this.waterBathymetryValid.value = this.bathymetry.isValid() ? 1 : 0;
    if (originChanged) this.treesDirty = true;
    if (forestCenterChanged) this.treesDirty = true;
    if (
      this.treesDirty &&
      (originChanged || centerChanged || forestCenterChanged || now >= this.nextTreeRefreshTime)
    ) {
      this.refreshTrees();
      // Worker results can arrive one at a time. Batch their visual-object
      // rebuilds so streaming remains smooth instead of rebuilding thousands
      // of instance matrices dozens of times during startup.
      this.nextTreeRefreshTime = now + 180;
    }
    this.waterTime.value = now * 0.001;
    this.water.position.x = snapWaterCenter(worldX) - originX;
    this.water.position.z = snapWaterCenter(worldZ) - originZ;
    this.groundCover.update(worldX, worldZ, originX, originZ);
    this.runwayGroup.position.set(
      (this.runway?.centerX ?? 0) - originX,
      0,
      (this.runway?.centerZ ?? 0) - originZ,
    );
  }

  /** Keep the analytic ocean reflection synchronized with the visible sky. */
  setAtmosphere(timeOfDay: TimeOfDayPreset, weather: WeatherPreset): void {
    if (timeOfDay === "dawn") {
      this.waterSunDirection.value.set(6_700, 2_100, -6_100).normalize();
      this.waterHorizonReflection.value.set(0x8e655f);
      this.waterZenithReflection.value.set(0x1d405f);
      this.waterSunReflection.value.set(0xffb27d);
    } else if (timeOfDay === "golden") {
      this.waterSunDirection.value.set(6_200, 3_100, -7_200).normalize();
      this.waterHorizonReflection.value.set(0x96745f);
      this.waterZenithReflection.value.set(0x2c5f78);
      this.waterSunReflection.value.set(0xffcf88);
    } else {
      this.waterSunDirection.value.set(4_300, 5_900, -7_800).normalize();
      this.waterHorizonReflection.value.set(0x78989b);
      this.waterZenithReflection.value.set(0x245f7e);
      this.waterSunReflection.value.set(0xffdda0);
    }

    // Clouds brighten the reflected horizon and desaturate the zenith while
    // suppressing the tight solar glint. These are infrequent settings changes,
    // so temporary colors avoid permanent mutable palette state in the renderer.
    const cloudMix = weather === "cloudy" ? 0.48 : weather === "breezy" ? 0.1 : 0;
    if (cloudMix > 0) {
      this.waterHorizonReflection.value.lerp(new THREE.Color(0x718082), cloudMix * 0.58);
      this.waterZenithReflection.value.lerp(new THREE.Color(0x536c78), cloudMix);
    }
    this.waterSunGlintStrength.value =
      weather === "cloudy" ? 0.26 : weather === "clear" ? 1.08 : 0.82;
  }

  setQuality(quality: "low" | "medium" | "high"): void {
    const nextResolution = terrainVertexResolution(quality, "near") - 1;
    const nextFarResolution = terrainVertexResolution(quality, "far");
    const nextRadius = quality === "low" ? 2 : 3;
    if (
      nextResolution === this.resolution &&
      nextFarResolution === this.farResolution &&
      nextRadius === this.radius
    ) {
      return;
    }
    this.quality = quality;
    const castNearVegetationShadows = quality !== "low";
    this.treeTrunks.castShadow = castNearVegetationShadows;
    this.treeCanopies.castShadow = castNearVegetationShadows;
    this.aspenCanopies.castShadow = castNearVegetationShadows;
    this.coniferCanopies.castShadow = castNearVegetationShadows;
    this.spruceCanopies.castShadow = castNearVegetationShadows;
    this.rocks.castShadow = quality === "high";
    this.groundCover.setQuality(quality);
    this.water.material.roughness = quality === "low" ? 0.22 : quality === "medium" ? 0.14 : 0.095;
    this.water.material.clearcoat = quality === "low" ? 0.82 : 1;
    this.water.material.clearcoatRoughness = quality === "low" ? 0.18 : quality === "medium" ? 0.1 : 0.07;
    this.generationEpoch += 1;
    this.terrainGeneration.cancelAll();

    // If a previous quality transition is still loading, retain its complete
    // older terrain set instead of stacking an unbounded third generation.
    if (this.retiredChunks.size > 0) {
      for (const chunk of this.retiredChunks.values()) this.setChunkVisible(chunk, true);
      for (const chunk of this.chunks.values()) this.disposeChunk(chunk);
    } else {
      for (const [key, chunk] of this.chunks) {
        chunk.requestId = null;
        chunk.generation += 1;
        this.retiredChunks.set(key, chunk);
      }
    }
    this.chunks.clear();
    for (const chunk of this.available) this.disposeChunk(chunk);
    this.available.length = 0;

    this.resolution = nextResolution;
    this.farResolution = nextFarResolution;
    this.radius = nextRadius;
    this.centerTileX = Number.NaN;
    this.centerTileZ = Number.NaN;
    this.treesDirty = true;
  }

  private refreshChunks(): void {
    const required = new Set<string>();
    const requiredTiles: Array<{
      key: string;
      tileX: number;
      tileZ: number;
      priority: number;
      size: number;
      vertexResolution: number;
      isFar: boolean;
    }> = [];
    for (let dz = -this.radius; dz <= this.radius; dz += 1) {
      for (let dx = -this.radius; dx <= this.radius; dx += 1) {
        const tileX = this.centerTileX + dx;
        const tileZ = this.centerTileZ + dz;
        const key = `near:${tileX}:${tileZ}`;
        required.add(key);
        requiredTiles.push({
          key,
          tileX,
          tileZ,
          priority: dx * dx + dz * dz,
          size: this.tileSize,
          vertexResolution: this.resolution + 1,
          isFar: false,
        });
      }
    }

    const farTileSize = this.tileSize * FAR_TILE_SCALE;
    const farCenterX = worldToTerrainTile((this.centerTileX + 0.5) * this.tileSize, farTileSize);
    const farCenterZ = worldToTerrainTile((this.centerTileZ + 0.5) * this.tileSize, farTileSize);
    for (let dz = -FAR_TILE_RADIUS; dz <= FAR_TILE_RADIUS; dz += 1) {
      for (let dx = -FAR_TILE_RADIUS; dx <= FAR_TILE_RADIUS; dx += 1) {
        const tileX = farCenterX + dx;
        const tileZ = farCenterZ + dz;
        const key = `far:${tileX}:${tileZ}`;
        required.add(key);
        requiredTiles.push({
          key,
          tileX,
          tileZ,
          // Distant silhouettes are perceptually more important than the
          // twenty-fifth nearby tile. Stream this tiny coarse set immediately
          // after the central near tile so startup never exposes an empty sky.
          priority: 0.35 + (dx * dx + dz * dz) * 0.12,
          size: farTileSize,
          vertexResolution: this.farResolution,
          isFar: true,
        });
      }
    }
    requiredTiles.sort(
      (first, second) =>
        first.priority - second.priority || first.tileZ - second.tileZ || first.tileX - second.tileX,
    );

    for (const [key, chunk] of this.chunks) {
      if (required.has(key)) continue;
      this.chunks.delete(key);
      if (chunk.requestId !== null) this.terrainGeneration.cancel(chunk.requestId);
      chunk.requestId = null;
      chunk.generation += 1;
      this.setChunkVisible(chunk, false);
      this.available.push(chunk);
    }

    for (const tile of requiredTiles) {
      const { key, tileX, tileZ, priority, size, vertexResolution, isFar } = tile;
      if (this.chunks.has(key)) continue;
      const recycledIndex = this.available.findIndex(
        (candidate) => candidate.size === size && candidate.vertexResolution === vertexResolution,
      );
      const recycled =
        recycledIndex >= 0 ? this.available.splice(recycledIndex, 1)[0] : undefined;
      const chunk = recycled ?? this.createChunk(size, vertexResolution, isFar);
      if (recycled) {
        chunk.generation += 1;
      }
      chunk.key = key;
      chunk.tileX = tileX;
      chunk.tileZ = tileZ;
      chunk.size = size;
      chunk.vertexResolution = vertexResolution;
      chunk.isFar = isFar;
      chunk.ready = false;
      this.resetChunkPlaceholder(chunk);
      // A quality change replaces one nested grid topology with another. Do
      // not reveal even non-overlapping edge tiles early: one mixed-resolution
      // frame is enough to expose cracks and invalid far/near morph roles.
      this.setChunkVisible(chunk, this.retiredChunks.size === 0);
      this.chunks.set(key, chunk);
      this.requestChunk(chunk, priority);
    }
    this.positionChunks();
    this.refreshNearTerrainMorphs();
  }

  private positionChunks(): void {
    for (const chunk of this.chunks.values()) {
      chunk.mesh.position.set(
        chunk.tileX * chunk.size - this.originX,
        0,
        chunk.tileZ * chunk.size - this.originZ,
      );
    }
    for (const chunk of this.retiredChunks.values()) {
      chunk.mesh.position.set(
        chunk.tileX * chunk.size - this.originX,
        0,
        chunk.tileZ * chunk.size - this.originZ,
      );
    }
    this.updateFarCutoutBounds();
  }

  /**
   * The streamed grids meet at the outer near-tile edge, but their vertex
   * spacing differs by 8–10×. Morphing only a ten-row exterior band makes the
   * fine edge exactly equal to the nested far edge and removes open cracks,
   * while every interior chunk retains its collision-consistent source shape.
   */
  private refreshNearTerrainMorphs(): void {
    const visibleNearChunks = [...this.chunks.values(), ...this.retiredChunks.values()].filter(
      (chunk) => !chunk.isFar && chunk.mesh.visible,
    );
    if (visibleNearChunks.length === 0) return;
    let minimumTileX = Number.POSITIVE_INFINITY;
    let maximumTileX = Number.NEGATIVE_INFINITY;
    let minimumTileZ = Number.POSITIVE_INFINITY;
    let maximumTileZ = Number.NEGATIVE_INFINITY;
    for (const chunk of visibleNearChunks) {
      minimumTileX = Math.min(minimumTileX, chunk.tileX);
      maximumTileX = Math.max(maximumTileX, chunk.tileX);
      minimumTileZ = Math.min(minimumTileZ, chunk.tileZ);
      maximumTileZ = Math.max(maximumTileZ, chunk.tileZ);
    }

    for (const chunk of visibleNearChunks) {
      if (!chunk.hasSourceData) continue;
      const geometry = chunk.mesh.geometry;
      const positionAttribute = geometry.getAttribute("position") as THREE.BufferAttribute;
      const normalAttribute = geometry.getAttribute("normal") as THREE.BufferAttribute;
      const positions = positionAttribute.array as Float32Array;
      const normals = normalAttribute.array as Float32Array;
      const farResolution = matchingFarVertexResolution(chunk.vertexResolution);
      const coarseStride = terrainMorphCoarseStride(
        chunk.vertexResolution,
        farResolution,
        FAR_TILE_SCALE,
      );
      const edges: TerrainMorphEdges = {
        west: chunk.tileX === minimumTileX,
        east: chunk.tileX === maximumTileX,
        north: chunk.tileZ === minimumTileZ,
        south: chunk.tileZ === maximumTileZ,
      };
      const edgeMask =
        (edges.west ? 1 : 0) |
        (edges.east ? 2 : 0) |
        (edges.north ? 4 : 0) |
        (edges.south ? 8 : 0);
      const morphSignature = `${chunk.sourceRevision}:${edgeMask}`;
      if (morphSignature === chunk.appliedMorphSignature) continue;
      normals.set(chunk.sourceNormals);
      const result = applyTerrainBoundaryMorph(
        positions,
        chunk.sourceHeights,
        chunk.vertexResolution,
        coarseStride,
        edges,
        10,
      );
      positionAttribute.needsUpdate = true;
      if (result.changed) geometry.computeVertexNormals();
      normalAttribute.needsUpdate = true;
      setTerrainBounds(geometry, chunk.size, result.minHeight, result.maxHeight);
      chunk.appliedMorphSignature = morphSignature;
    }
  }

  private configureNearTerrainSurface(): void {
    this.material.onBeforeCompile = (shader) => this.enhanceTerrainShader(shader);
    this.material.customProgramCacheKey = () => "near-terrain-geology-v7";
  }

  private configureHorizonWaterCutout(): void {
    this.horizonMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying float vHorizonSceneHeight;",
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          vHorizonSceneHeight = (modelMatrix * vec4(transformed, 1.0)).y;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          varying float vHorizonSceneHeight;
          const float horizonWaterCutoutLevel = ${TERRAIN_WATER_CUTOUT_LEVEL.toFixed(2)};`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          if (vHorizonSceneHeight <= horizonWaterCutoutLevel) discard;`,
        );
    };
    this.horizonMaterial.customProgramCacheKey = () => "horizon-water-cutout-v2";
  }

  private enhanceTerrainShader(shader: THREE.WebGLProgramParametersWithUniforms): void {
    shader.uniforms.terrainWorldOrigin = this.terrainWorldOrigin;
    shader.uniforms.terrainDetailMap = this.terrainDetailMap;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vTerrainWorldPosition;
        varying vec3 vTerrainWorldNormal;
        varying float vTerrainWorldSlope;
        uniform vec2 terrainWorldOrigin;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vec4 terrainScenePosition = modelMatrix * vec4(transformed, 1.0);
        vTerrainWorldPosition = terrainScenePosition.xyz;
        vTerrainWorldPosition.xz += terrainWorldOrigin;
        vTerrainWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
        vTerrainWorldSlope = 1.0 - clamp(vTerrainWorldNormal.y, 0.0, 1.0);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vTerrainWorldPosition;
        varying vec3 vTerrainWorldNormal;
        varying float vTerrainWorldSlope;
        uniform sampler2D terrainDetailMap;
        const float terrainWaterCutoutLevel = ${TERRAIN_WATER_CUTOUT_LEVEL.toFixed(2)};`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        // Do not leave a second, nearly coplanar surface beneath the ocean.
        // The depth precision at flight-simulator distances is too coarse for
        // a centimetre-scale separation and used to make whole patches blink.
        if (vTerrainWorldPosition.y <= terrainWaterCutoutLevel) discard;
        vec2 terrainDetailUv = vTerrainWorldPosition.xz / 2048.0;
        vec3 terrainTextureDetail = texture2D(terrainDetailMap, terrainDetailUv).rgb;
        vec2 terrainRotatedPosition = vec2(
          vTerrainWorldPosition.x * 0.806 + vTerrainWorldPosition.z * 0.592,
          -vTerrainWorldPosition.x * 0.592 + vTerrainWorldPosition.z * 0.806
        );
        vec2 terrainPatchUv = terrainRotatedPosition / 176.0 +
          (terrainTextureDetail.rg - 0.5) * 0.19;
        vec3 terrainPatchTexture = texture2D(terrainDetailMap, terrainPatchUv).rgb;
        vec2 terrainMicroUv = terrainRotatedPosition / 28.0 +
          (terrainPatchTexture.rg - 0.5) * 0.13;
        vec3 terrainMicroTexture = texture2D(terrainDetailMap, terrainMicroUv).rgb;
        // Slope-aware triplanar rock projection follows the surface instead of
        // stretching a top-down texture down cliffs. Blend all three axes over
        // a narrow band (rather than switching at one threshold) so geology
        // remains continuous while banking past a ridge.
        vec3 terrainProjectionWeight = pow(
          max(abs(normalize(vTerrainWorldNormal)), vec3(0.0001)),
          vec3(6.0)
        );
        terrainProjectionWeight /= max(
          terrainProjectionWeight.x + terrainProjectionWeight.y + terrainProjectionWeight.z,
          0.0001
        );
        vec2 terrainRockCoordinates = vTerrainWorldPosition.xz;
        if (terrainProjectionWeight.y < max(terrainProjectionWeight.x, terrainProjectionWeight.z)) {
          terrainRockCoordinates = terrainProjectionWeight.x > terrainProjectionWeight.z
            ? vTerrainWorldPosition.zy
            : vTerrainWorldPosition.xy;
        }
        vec2 terrainRockWarp = (terrainTextureDetail.rg - 0.5) * 0.19;
        vec2 terrainRockUv = terrainRockCoordinates / 74.0 + terrainRockWarp;
        vec3 terrainRockTextureX = texture2D(
          terrainDetailMap,
          vTerrainWorldPosition.zy / 74.0 + terrainRockWarp
        ).rgb;
        vec3 terrainRockTextureY = texture2D(
          terrainDetailMap,
          vTerrainWorldPosition.xz / 74.0 + terrainRockWarp
        ).rgb;
        vec3 terrainRockTextureZ = texture2D(
          terrainDetailMap,
          vTerrainWorldPosition.xy / 74.0 + terrainRockWarp
        ).rgb;
        vec3 terrainRockTexture =
          terrainRockTextureX * terrainProjectionWeight.x +
          terrainRockTextureY * terrainProjectionWeight.y +
          terrainRockTextureZ * terrainProjectionWeight.z;
        float terrainMacro = terrainTextureDetail.r;
        float terrainDetail = terrainTextureDetail.g;
        float terrainGrain = terrainTextureDetail.b;
        float terrainPixelFootprint = max(
          length(dFdx(vTerrainWorldPosition.xz)),
          length(dFdy(vTerrainWorldPosition.xz))
        );
        float terrainRockPixelFootprint = max(
          length(dFdx(terrainRockCoordinates)),
          length(dFdy(terrainRockCoordinates))
        );
        float terrainDetailFade = 1.0 - smoothstep(7.0, 64.0, terrainPixelFootprint);
        float terrainGrainFade = 1.0 - smoothstep(1.5, 20.0, terrainPixelFootprint);
        float terrainPatchFade = 1.0 - smoothstep(15.0, 96.0, terrainPixelFootprint);
        // The texture itself has mipmaps and anisotropic filtering; keep its
        // high-frequency band visible through normal low-altitude flight, then
        // remove it only when the projected footprint becomes genuinely broad.
        float terrainMicroFade = 1.0 - smoothstep(1.2, 14.0, terrainPixelFootprint);
        float terrainRockDetailFade = 1.0 - smoothstep(12.0, 92.0, terrainRockPixelFootprint);
        float terrainAltitudeRock = smoothstep(520.0, 1450.0, vTerrainWorldPosition.y);
        float terrainRockMask = clamp(
          smoothstep(0.08, 0.52, vTerrainWorldSlope) * 0.76 + terrainAltitudeRock * 0.48,
          0.0,
          0.9
        );
        float terrainSnowMask = smoothstep(0.68, 0.86, max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b)));
        float terrainLayerPhase =
          vTerrainWorldPosition.y * 0.092 +
          terrainRockTexture.r * 4.2 +
          dot(vTerrainWorldPosition.xz, vec2(0.0017, -0.0011));
        float terrainStrata = mix(
          0.5,
          0.5 + 0.5 * sin(terrainLayerPhase),
          terrainRockDetailFade
        );
        float terrainBreakup =
          (terrainMacro - 0.5) * 0.11 +
          (terrainDetail - 0.5) * 0.1 * terrainDetailFade +
          (terrainGrain - 0.5) * 0.08 * terrainGrainFade;
        diffuseColor.rgb *= 1.0 + terrainBreakup * (1.0 - terrainSnowMask * 0.5);
        float terrainGreenAffinity = smoothstep(
          0.018,
          0.12,
          diffuseColor.g - max(diffuseColor.r * 0.96, diffuseColor.b)
        );
        float terrainVegetationMask = terrainGreenAffinity *
          (1.0 - terrainRockMask) * (1.0 - terrainSnowMask);
        float terrainMeadowMottle =
          (terrainPatchTexture.r - 0.5) * 0.1 +
          (terrainPatchTexture.g - 0.5) * 0.055;
        diffuseColor.rgb *= 1.0 +
          terrainMeadowMottle * terrainPatchFade * terrainVegetationMask;
        // A zero-fetch high-pass combination of the existing micro channels
        // reads as blades, soil pores, and mineral grit instead of another
        // smooth colour cloud. It is derivative-gated and mip-filtered, so the
        // signal integrates away rather than crawling at the horizon.
        float terrainMicroHighPass =
          (terrainMicroTexture.b - 0.44) * 0.28 +
          (terrainMicroTexture.g - terrainMicroTexture.r) * 0.2;
        float terrainSurfaceDetailMask = terrainMicroFade *
          (1.0 - terrainSnowMask * 0.72);
        diffuseColor.rgb *= 1.0 + terrainMicroHighPass * terrainSurfaceDetailMask;
        float terrainGrassClusters = smoothstep(
          0.38,
          0.78,
          terrainMicroTexture.g * 0.72 + terrainPatchTexture.b * 0.28
        );
        vec3 terrainGrassTint = vec3(0.72, 0.91, 0.52);
        diffuseColor.rgb = mix(
          diffuseColor.rgb,
          diffuseColor.rgb * terrainGrassTint,
          terrainGrassClusters * terrainMicroFade * terrainVegetationMask * 0.2
        );
        float terrainSoilFlecks = smoothstep(
          0.69,
          0.9,
          terrainMicroTexture.r * 0.58 + terrainMicroTexture.b * 0.42
        );
        diffuseColor.rgb = mix(
          diffuseColor.rgb,
          vec3(0.24, 0.205, 0.125),
          terrainSoilFlecks * terrainMicroFade * terrainVegetationMask * 0.16
        );
        vec3 terrainStone = mix(vec3(0.27, 0.255, 0.225), vec3(0.43, 0.405, 0.36), terrainStrata);
        diffuseColor.rgb = mix(
          diffuseColor.rgb,
          terrainStone * (0.82 + terrainMacro * 0.3),
          terrainRockMask * (0.26 + terrainStrata * 0.24) * (1.0 - terrainSnowMask)
        );
        float terrainScree = mix(
          0.5,
          smoothstep(
            0.54,
            0.86,
            terrainRockTexture.g * 0.62 + terrainRockTexture.b * 0.38
          ),
          terrainRockDetailFade
        );
        float terrainStrataLip = smoothstep(0.78, 0.98, abs(sin(terrainLayerPhase))) *
          terrainRockDetailFade;
        vec3 terrainScreeColor = mix(
          vec3(0.205, 0.19, 0.165),
          vec3(0.49, 0.465, 0.405),
          terrainScree
        );
        diffuseColor.rgb = mix(
          diffuseColor.rgb,
          terrainScreeColor,
          terrainRockMask * (0.08 + terrainScree * 0.2 + terrainStrataLip * 0.11) *
            (1.0 - terrainSnowMask * 0.82)
        );
        float terrainCrevice = smoothstep(
          0.43,
          0.79,
          (1.0 - terrainRockTexture.b) * 0.66 + terrainRockTexture.r * 0.34
        ) * terrainRockDetailFade;
        float terrainFractureEdge = smoothstep(
          0.11,
          0.34,
          abs(terrainRockTexture.r - terrainRockTexture.g)
        ) * terrainRockDetailFade;
        diffuseColor.rgb *= 1.0 - terrainRockMask * (1.0 - terrainSnowMask * 0.72) *
          (terrainCrevice * 0.13 + terrainFractureEdge * 0.055);

        // Snow is not a flat white layer. Reuse the existing world-anchored
        // texture bands so caps retain broad wind slabs, dirty accumulation,
        // and exposed strata without adding another sampler. Derivative fades
        // remove only the frequencies that would shimmer below a pixel.
        float terrainSnowDetailFade = min(terrainPatchFade, terrainRockDetailFade);
        float terrainSnowMottle =
          (terrainMacro - 0.5) * 0.34 +
          (terrainPatchTexture.b - 0.5) * 0.32 * terrainDetailFade +
          (terrainRockTexture.r - 0.5) * 0.42 * terrainSnowDetailFade;
        diffuseColor.rgb *= 1.0 + terrainSnowMottle * terrainSnowMask *
          (0.32 + terrainSnowDetailFade * 0.28);
        float terrainSnowDeposit = clamp(
          0.5 +
          (terrainMacro - 0.5) * 0.58 +
          (terrainRockTexture.b - 0.5) * 0.62 * terrainSnowDetailFade,
          0.0,
          1.0
        );
        vec3 terrainSnowTint = mix(
          vec3(0.72, 0.78, 0.81),
          vec3(1.025, 1.0, 0.94),
          terrainSnowDeposit
        );
        diffuseColor.rgb = mix(
          diffuseColor.rgb,
          diffuseColor.rgb * terrainSnowTint,
          terrainSnowMask * (0.14 + terrainSnowDetailFade * 0.2)
        );

        // Steep snowy faces expose coherent dark ribs even after fine texture
        // has filtered out. Closer views add scree and fractured strata from the
        // same 92 m world projection, avoiding camera-facing texture swimming.
        float terrainSnowSlopeExposure = smoothstep(0.12, 0.5, vTerrainWorldSlope);
        float terrainSnowFracture = smoothstep(
          0.5,
          0.84,
          terrainRockTexture.r * 0.52 + terrainRockTexture.g * 0.48
        );
        float terrainSnowRockExposure = clamp(
          terrainSnowMask * (
            terrainSnowSlopeExposure * (
              0.16 +
              (terrainScree * 0.42 + terrainSnowFracture * 0.24) * terrainSnowDetailFade
            ) +
            terrainStrataLip * terrainRockMask * terrainSnowDetailFade * 0.16
          ),
          0.0,
          0.68
        );
        diffuseColor.rgb = mix(
          diffuseColor.rgb,
          terrainScreeColor * (0.7 + terrainStrata * 0.2),
          terrainSnowRockExposure
        );`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
        // Material-scale roughness variation gives dry soil and fractured rock
        // distinct highlights without making terrain glossy. It reuses the
        // derivative-filtered maps above and costs no additional texture fetch.
        float terrainRockRoughness = mix(0.72, 0.97, terrainRockTexture.b);
        float terrainSoilRoughness = mix(0.84, 1.0, terrainMicroTexture.g);
        float terrainResolvedRoughness = mix(
          terrainSoilRoughness,
          terrainRockRoughness,
          terrainRockMask * terrainRockDetailFade
        );
        roughnessFactor *= mix(1.0, terrainResolvedRoughness, terrainDetailFade);`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        const float terrainDetailTexel = 1.0 / 256.0;
        float terrainBumpCenter = texture2D(terrainDetailMap, terrainDetailUv).g;
        float terrainBumpX = texture2D(
          terrainDetailMap,
          terrainDetailUv + vec2(terrainDetailTexel, 0.0)
        ).g - terrainBumpCenter;
        float terrainBumpZ = texture2D(
          terrainDetailMap,
          terrainDetailUv + vec2(0.0, terrainDetailTexel)
        ).g - terrainBumpCenter;
        float terrainBumpFade = 1.0 - smoothstep(
          1.5,
          14.0,
          max(length(dFdx(vTerrainWorldPosition.xz)), length(dFdy(vTerrainWorldPosition.xz)))
        );
        float terrainMicroBumpCenter = texture2D(terrainDetailMap, terrainMicroUv).b;
        float terrainMicroBumpU = texture2D(
          terrainDetailMap,
          terrainMicroUv + vec2(terrainDetailTexel, 0.0)
        ).b - terrainMicroBumpCenter;
        float terrainMicroBumpV = texture2D(
          terrainDetailMap,
          terrainMicroUv + vec2(0.0, terrainDetailTexel)
        ).b - terrainMicroBumpCenter;
        vec2 terrainMicroGradient = vec2(
          terrainMicroBumpU * 0.806 - terrainMicroBumpV * 0.592,
          terrainMicroBumpU * 0.592 + terrainMicroBumpV * 0.806
        );
        float terrainRockBumpCenter = texture2D(terrainDetailMap, terrainRockUv).g;
        float terrainRockBumpU = texture2D(
          terrainDetailMap,
          terrainRockUv + vec2(terrainDetailTexel, 0.0)
        ).g - terrainRockBumpCenter;
        float terrainRockBumpV = texture2D(
          terrainDetailMap,
          terrainRockUv + vec2(0.0, terrainDetailTexel)
        ).g - terrainRockBumpCenter;
        vec3 terrainRockGradientWorld;
        if (terrainProjectionWeight.x > max(terrainProjectionWeight.y, terrainProjectionWeight.z)) {
          terrainRockGradientWorld = vec3(0.0, -terrainRockBumpV, -terrainRockBumpU);
        } else if (terrainProjectionWeight.y > terrainProjectionWeight.z) {
          terrainRockGradientWorld = vec3(-terrainRockBumpU, 0.0, -terrainRockBumpV);
        } else {
          terrainRockGradientWorld = vec3(-terrainRockBumpU, -terrainRockBumpV, 0.0);
        }
        const float terrainBroadNormalStrength = 1.05;
        const float terrainMicroNormalStrength = 2.15;
        const float terrainRockNormalStrength = 1.9;
        normal = normalize(normal + mat3(viewMatrix) * vec3(
          -terrainBumpX * terrainBroadNormalStrength * terrainBumpFade -
            terrainMicroGradient.x * terrainMicroNormalStrength * terrainMicroFade *
              terrainVegetationMask,
          0.0,
          -terrainBumpZ * terrainBroadNormalStrength * terrainBumpFade -
            terrainMicroGradient.y * terrainMicroNormalStrength * terrainMicroFade *
              terrainVegetationMask
        ) + mat3(viewMatrix) * terrainRockGradientWorld *
          terrainRockNormalStrength * terrainRockMask * terrainRockDetailFade);`,
      );
  }

  private configureWaterMaterial(material: THREE.MeshPhysicalMaterial): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.waterTime = this.waterTime;
      shader.uniforms.waterWorldOrigin = this.waterWorldOrigin;
      shader.uniforms.waterSunDirection = this.waterSunDirection;
      shader.uniforms.waterHorizonReflection = this.waterHorizonReflection;
      shader.uniforms.waterZenithReflection = this.waterZenithReflection;
      shader.uniforms.waterSunReflection = this.waterSunReflection;
      shader.uniforms.waterSunGlintStrength = this.waterSunGlintStrength;
      shader.uniforms.waterPlanarReflectionMap = this.waterPlanarReflectionMap;
      shader.uniforms.waterPlanarReflectionMatrix = this.waterPlanarReflectionMatrix;
      shader.uniforms.waterPlanarReflectionStrength = this.waterPlanarReflectionStrength;
      shader.uniforms.waterHybridCompositeStrength = this.waterHybridCompositeStrength;
      shader.uniforms.waterBathymetryMap = { value: this.bathymetry.texture };
      shader.uniforms.waterSurfaceDetailMap = this.terrainDetailMap;
      shader.uniforms.waterBathymetryBounds = { value: this.bathymetry.bounds };
      shader.uniforms.waterBathymetryMaxDepth = { value: this.bathymetry.maxDepth };
      shader.uniforms.waterBathymetryTexel = { value: 1 / this.bathymetry.resolution };
      shader.uniforms.waterBathymetryValid = this.waterBathymetryValid;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
          varying vec3 vWaterScenePosition;
          varying vec3 vWaterWorldPosition;
          uniform vec2 waterWorldOrigin;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          vWaterScenePosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vWaterWorldPosition = vWaterScenePosition;
          vWaterWorldPosition.xz += waterWorldOrigin;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          varying vec3 vWaterScenePosition;
          varying vec3 vWaterWorldPosition;
          uniform float waterTime;
          uniform vec2 waterWorldOrigin;
          uniform vec3 waterSunDirection;
          uniform vec3 waterHorizonReflection;
          uniform vec3 waterZenithReflection;
          uniform vec3 waterSunReflection;
          uniform float waterSunGlintStrength;
          uniform sampler2D waterPlanarReflectionMap;
          uniform mat4 waterPlanarReflectionMatrix;
          uniform float waterPlanarReflectionStrength;
          uniform float waterHybridCompositeStrength;
          uniform sampler2D waterBathymetryMap;
          uniform sampler2D waterSurfaceDetailMap;
          uniform vec4 waterBathymetryBounds;
          uniform float waterBathymetryMaxDepth;
          uniform float waterBathymetryTexel;
          uniform float waterBathymetryValid;
          vec2 waterDomainWarp(vec2 point, float time) {
            return vec2(
              sin(dot(point, vec2(-0.423, 0.906)) * 0.0017 + time * 0.055),
              sin(dot(point, vec2(0.719, 0.695)) * 0.0023 - time * 0.041)
            );
          }
          vec4 waterSurfaceField(
            vec2 point,
            vec2 warpSignal,
            float time,
            float pixelFootprint
          ) {
            // Three independently oriented, UV-animated normal-map layers are
            // the browser-budget version of an ocean spectrum. Unlike a few
            // coherent sinusoids they do not stamp parallel bands across the
            // surface. World coordinates keep the field fixed while the render
            // grid and floating origin recenter around the aircraft.
            vec2 broadPoint = point + vec2(
              warpSignal.x * 31.0 + warpSignal.y * 11.0,
              warpSignal.y * 37.0 - warpSignal.x * 9.0
            );
            vec2 middlePoint = vec2(
              point.x * 0.819152 - point.y * 0.573576,
              point.x * 0.573576 + point.y * 0.819152
            );
            vec2 finePoint = vec2(
              point.x * 0.438371 + point.y * 0.898794,
              -point.x * 0.898794 + point.y * 0.438371
            );
            vec4 broadSample = texture2D(
              waterSurfaceDetailMap,
              broadPoint * 0.000244140625 + vec2(time * 0.000041, -time * 0.000027)
            );
            vec4 middleSample = texture2D(
              waterSurfaceDetailMap,
              middlePoint * 0.0009765625 + vec2(-time * 0.00023, time * 0.00017)
            );
            vec4 fineSample = texture2D(
              waterSurfaceDetailMap,
              finePoint * 0.00390625 + vec2(time * 0.0011, time * 0.00073)
            );
            vec2 broadNormal = broadSample.rg * 2.0 - 1.0;
            vec2 middleNormal = middleSample.br * 2.0 - 1.0;
            vec2 fineNormal = fineSample.gr * 2.0 - 1.0;
            float broadFade = 1.0 - smoothstep(90.0, 480.0, pixelFootprint);
            float middleFade = 1.0 - smoothstep(12.0, 100.0, pixelFootprint);
            float fineFade = 1.0 - smoothstep(1.5, 20.0, pixelFootprint);
            vec2 slope =
              broadNormal * 0.082 * broadFade +
              middleNormal * 0.047 * middleFade +
              fineNormal * 0.021 * fineFade;
            float surfaceTone = clamp(
              0.5 + dot(broadNormal, vec2(0.28, -0.2)) +
                dot(middleNormal, vec2(-0.09, 0.11)),
              0.0,
              1.0
            );
            float microEnergy = clamp(
              length(middleNormal) * 0.52 + length(fineNormal) * 0.28,
              0.0,
              1.0
            );
            return vec4(slope, surfaceTone, microEnergy);
          }
          vec2 waterWaveGradient(
            vec2 point,
            vec2 warpSignal,
            float time,
            float pixelFootprint
          ) {
            return waterSurfaceField(point, warpSignal, time, pixelFootprint).xy;
          }`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          vec2 waterWarpSignal = waterDomainWarp(vWaterWorldPosition.xz, waterTime);
          float waterPixelFootprint = max(
            length(dFdx(vWaterWorldPosition.xz)),
            length(dFdy(vWaterWorldPosition.xz))
          );
          vec4 waterSurface = waterSurfaceField(
            vWaterWorldPosition.xz,
            waterWarpSignal,
            waterTime,
            waterPixelFootprint
          );
          vec2 waterSlope = waterSurface.xy;
          float waterSurfaceTone = waterSurface.z;
          float waterRippleEnergy = waterSurface.w;
          float waterFaceDirection = gl_FrontFacing ? 1.0 : -1.0;
          vec3 waterNormalWorld = normalize(
            vec3(-waterSlope.x, 1.0, -waterSlope.y) * waterFaceDirection
          );
          vec3 waterCameraWorldPosition = cameraPosition;
          waterCameraWorldPosition.xz += waterWorldOrigin;
          vec3 waterViewDelta = waterCameraWorldPosition - vWaterWorldPosition;
          vec3 waterViewToCamera = waterViewDelta * inversesqrt(
            max(dot(waterViewDelta, waterViewDelta), 0.0001)
          );

          // Schlick Fresnel (F0 = 2.04% for an air/water interface) controls
          // an analytic reflection of the same sky palette as the scene. The
          // planar target below contributes low-frequency scene radiance only;
          // neither path is allowed to turn normal-incidence water into glass.
          float waterCosTheta = clamp(dot(waterViewToCamera, waterNormalWorld), 0.0, 1.0);
          float waterFresnel = 0.0204 + 0.9796 * pow(1.0 - waterCosTheta, 5.0);
          vec3 waterReflectionRay = normalize(
            reflect(-waterViewToCamera, waterNormalWorld)
          );
          float waterReflectionHeight = clamp(waterReflectionRay.y, 0.0, 1.0);
          vec3 waterSkyReflection = mix(
            waterHorizonReflection,
            waterZenithReflection,
            pow(waterReflectionHeight, 0.56)
          );
          float waterHorizonBand = exp(-waterReflectionHeight * 6.5);
          float waterAtmosphereField =
            sin(dot(waterReflectionRay.xz, vec2(7.1, -5.7)) + waterWarpSignal.x * 0.18) * 0.58 +
            sin(dot(waterReflectionRay.xz, vec2(-13.7, 9.3)) + waterWarpSignal.y * 0.14) * 0.42;
          // Rough-surface sky radiance is deliberately energy-bounded. The old
          // nearly-white horizon palette plus a constant reflection floor made
          // every viewing angle read as the same bright blue sheet.
          waterSkyReflection *=
            0.72 + waterSurfaceTone * 0.07 + waterAtmosphereField * 0.025;
          waterSkyReflection = mix(
            waterSkyReflection,
            waterHorizonReflection * 1.055,
            waterHorizonBand * 0.13
          );
          float waterSunAlignment = max(
            dot(waterReflectionRay, waterSunDirection),
            0.0
          );
          float waterSunGlintExponent = mix(260.0, 105.0, waterRippleEnergy);
          float waterSunGlint = pow(waterSunAlignment, waterSunGlintExponent);
          float waterSunHalo = pow(waterSunAlignment, 22.0) * 0.045;
          float waterSunFresnel = mix(0.34, 0.92, sqrt(waterFresnel));
          waterSkyReflection += waterSunReflection *
            (waterSunGlint * 0.58 + waterSunHalo) *
            waterSunGlintStrength * waterSunFresnel;

          // Optional hybrid-renderer hook. The default strength is zero, so no
          // reflection target is sampled until the caller supplies one. Small
          // Three bounded taps treat the planar target as low-frequency
          // radiance. A crossed-wave displacement and anisotropic rough sample
          // break up reflected terrain/cloud silhouettes without allocating a
          // blur target or exposing the reflection as a perfect flat mirror.
          if (waterPlanarReflectionStrength > 0.0001) {
            vec4 waterPlanarProjection = waterPlanarReflectionMatrix *
              vec4(vWaterScenePosition, 1.0);
            if (waterPlanarProjection.w > 0.0001) {
              vec2 waterPlanarUv = waterPlanarProjection.xy / waterPlanarProjection.w;
              float waterPlanarDetailFade = 1.0 - smoothstep(
                5.0,
                36.0,
                waterPixelFootprint
              );
              waterPlanarUv += waterSlope *
                mix(0.024, 0.054, waterPlanarDetailFade);
              float waterPlanarBounds =
                smoothstep(0.0, 0.018, waterPlanarUv.x) *
                smoothstep(0.0, 0.018, waterPlanarUv.y) *
                smoothstep(0.0, 0.018, 1.0 - waterPlanarUv.x) *
                smoothstep(0.0, 0.018, 1.0 - waterPlanarUv.y);
              vec2 waterPlanarRoughAxis = normalize(
                vec2(0.73, 0.68) +
                vec2(waterSlope.y, -waterSlope.x) * 8.0
              );
              float waterPlanarRoughRadius = mix(
                0.0012,
                0.0042,
                clamp(waterRippleEnergy * 0.72 + waterPlanarDetailFade * 0.28, 0.0, 1.0)
              );
              vec2 waterPlanarRoughOffset =
                waterPlanarRoughAxis * waterPlanarRoughRadius;
              vec3 waterPlanarReflection = texture2D(
                waterPlanarReflectionMap,
                clamp(waterPlanarUv, vec2(0.001), vec2(0.999))
              ).rgb * 0.5;
              waterPlanarReflection += texture2D(
                waterPlanarReflectionMap,
                clamp(
                  waterPlanarUv + waterPlanarRoughOffset,
                  vec2(0.001),
                  vec2(0.999)
                )
              ).rgb * 0.25;
              waterPlanarReflection += texture2D(
                waterPlanarReflectionMap,
                clamp(
                  waterPlanarUv - waterPlanarRoughOffset,
                  vec2(0.001),
                  vec2(0.999)
                )
              ).rgb * 0.25;
              float waterPlanarFresnelWeight = mix(
                0.035,
                0.46,
                sqrt(waterFresnel)
              );
              float waterPlanarMix = waterPlanarReflectionStrength *
                waterPlanarBounds * waterPlanarFresnelWeight *
                (1.0 - waterRippleEnergy * 0.32);
              waterSkyReflection = mix(
                waterSkyReflection,
                waterPlanarReflection,
                waterPlanarMix
              );
            }
          }

          float waterLongWave = clamp(
            waterSurfaceTone * 0.72 +
              (0.5 + waterWarpSignal.x * 0.12 + waterWarpSignal.y * 0.08) * 0.28,
            0.0,
            1.0
          );
          vec3 waterDeepFallback = vec3(0.0045, 0.034, 0.052) *
            mix(0.88, 1.08, waterLongWave);
          vec2 waterBathymetryExtent = max(
            waterBathymetryBounds.zw - waterBathymetryBounds.xy,
            vec2(1.0)
          );
          vec2 waterBathymetryUv =
            (vWaterWorldPosition.xz - waterBathymetryBounds.xy) /
            waterBathymetryExtent;
          float waterBathymetryEdge = min(
            min(waterBathymetryUv.x, waterBathymetryUv.y),
            min(1.0 - waterBathymetryUv.x, 1.0 - waterBathymetryUv.y)
          );
          float waterBathymetryCoverage = waterBathymetryValid *
            smoothstep(0.0, waterBathymetryTexel * 2.0, waterBathymetryEdge);
          float waterBathymetryDepth = texture2D(
            waterBathymetryMap,
            clamp(
              waterBathymetryUv,
              vec2(waterBathymetryTexel * 0.5),
              vec2(1.0 - waterBathymetryTexel * 0.5)
            )
          ).r * waterBathymetryMaxDepth;
          float waterDepthBodyMix = smoothstep(2.0, 68.0, waterBathymetryDepth);
          vec3 waterShoreSediment = mix(
            vec3(0.065, 0.102, 0.064),
            vec3(0.16, 0.175, 0.105),
            waterSurfaceTone
          );
          // Beer-Lambert transmission reveals a terrain-like sediment tint in
          // the shallows, then smoothly yields to dark in-scattered deep water.
          // The surface remains opaque/depth-writing; only its radiance changes,
          // so there is no order-dependent shoreline flicker.
          vec3 waterForwardTransmittance = exp(
            -vec3(0.16, 0.075, 0.045) * max(waterBathymetryDepth, 0.0)
          );
          vec3 waterBathymetryBody = mix(
            waterDeepFallback,
            waterShoreSediment,
            waterForwardTransmittance
          );
          waterBathymetryBody *= mix(
            mix(0.92, 1.06, waterSurfaceTone),
            1.0,
            waterDepthBodyMix
          );
          vec3 waterForwardDepthBody = mix(
            waterDeepFallback,
            waterBathymetryBody,
            waterBathymetryCoverage
          );
          vec3 waterDeep = mix(
            waterForwardDepthBody,
            waterDeepFallback,
            waterHybridCompositeStrength
          );
          float waterReflectionAmount = clamp(
            waterFresnel * mix(0.74, 0.64, waterRippleEnergy) +
              waterHorizonBand * 0.022,
            0.022,
            0.78
          );
          diffuseColor.rgb = waterDeep;`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
          // Ripple energy broadens highlights continuously instead of stamping
          // coherent dark/light stripes into the material.
          roughnessFactor = clamp(
            roughnessFactor + waterRippleEnergy * 0.024,
            0.035,
            0.14
          );`,
        )
        .replace(
          "#include <normal_fragment_maps>",
          `#include <normal_fragment_maps>
          vec3 waterNormalView = normalize(mat3(viewMatrix) * waterNormalWorld);
          normal = waterNormalView;`,
        )
        .replace(
          "#include <clearcoat_normal_fragment_maps>",
          `#include <clearcoat_normal_fragment_maps>
          #ifdef USE_CLEARCOAT
            clearcoatNormal = waterNormalView;
          #endif`,
        )
        .replace(
          "#include <opaque_fragment>",
          `// Apply the analytic sky after direct PBR lighting. Treating a sky
          // reflection as diffuse albedo made the ocean unnaturally black.
          vec3 waterLitBody = mix(
            waterDeep,
            max(outgoingLight, waterDeep),
            0.24
          );
          outgoingLight = mix(waterLitBody, waterSkyReflection, waterReflectionAmount);
          #include <opaque_fragment>
          // Exact material classification for post-processing. The canvas is
          // opaque and the final composite restores alpha to one; this channel
          // is free metadata inside the offscreen beauty target.
          gl_FragColor.a = 0.0;`,
        );
    };
    material.customProgramCacheKey = () => "stable-water-depth-spectrum-v12";
  }

  private configureFarTerrainCutout(): void {
    this.farMaterial.onBeforeCompile = (shader) => {
      this.enhanceTerrainShader(shader);
      shader.uniforms.nearTerrainBounds = { value: this.farCutoutBounds };
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vTerrainScenePosition;",
        )
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvTerrainScenePosition = (modelMatrix * vec4(transformed, 1.0)).xz;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vTerrainScenePosition;\nuniform vec4 nearTerrainBounds;",
        )
        .replace(
          "#include <clipping_planes_fragment>",
          `#include <clipping_planes_fragment>
          if (
            vTerrainScenePosition.x >= nearTerrainBounds.x &&
            vTerrainScenePosition.x <= nearTerrainBounds.y &&
            vTerrainScenePosition.y >= nearTerrainBounds.z &&
            vTerrainScenePosition.y <= nearTerrainBounds.w
          ) discard;`,
        );
    };
    this.farMaterial.customProgramCacheKey = () => "far-terrain-geology-cutout-v7";
  }

  private updateFarCutoutBounds(): void {
    if (!Number.isFinite(this.centerTileX) || !Number.isFinite(this.centerTileZ)) return;
    setNearTerrainCutoutBounds(
      this.farCutoutBounds,
      this.centerTileX,
      this.centerTileZ,
      this.radius,
      this.tileSize,
      this.originX,
      this.originZ,
    );
    // During a quality transition the previous complete near grid remains
    // visible. Keep its outer tiles inside the cutout too, then naturally
    // shrink back on the frame after those retired chunks are disposed.
    for (const chunk of this.retiredChunks.values()) {
      if (chunk.isFar || !chunk.mesh.visible) continue;
      this.farCutoutBounds.x = Math.min(
        this.farCutoutBounds.x,
        chunk.tileX * chunk.size - this.originX,
      );
      this.farCutoutBounds.y = Math.max(
        this.farCutoutBounds.y,
        (chunk.tileX + 1) * chunk.size - this.originX,
      );
      this.farCutoutBounds.z = Math.min(
        this.farCutoutBounds.z,
        chunk.tileZ * chunk.size - this.originZ,
      );
      this.farCutoutBounds.w = Math.max(
        this.farCutoutBounds.w,
        (chunk.tileZ + 1) * chunk.size - this.originZ,
      );
    }
  }

  private createChunk(size: number, vertexResolution: number, isFar: boolean): TerrainChunk {
    const geometry = makeTerrainGeometry(
      size,
      vertexResolution,
      this.getIndexAttribute(vertexResolution),
      0,
      this.tempColor.set(0x71805f),
    );
    const chunk: TerrainChunk = {
      mesh: new THREE.Mesh(geometry, isFar ? this.farMaterial : this.material),
      key: "",
      tileX: 0,
      tileZ: 0,
      generation: 1,
      requestId: null,
      ready: false,
      size,
      vertexResolution,
      isFar,
      sourceHeights: isFar
        ? new Float32Array(0)
        : new Float32Array(vertexResolution * vertexResolution),
      sourceNormals: isFar
        ? new Float32Array(0)
        : new Float32Array(vertexResolution * vertexResolution * 3),
      hasSourceData: false,
      sourceRevision: 0,
      appliedMorphSignature: "",
    };
    // New chunks begin hidden so a CSM traverse can never register a mesh
    // during the brief setup window before its transition role is known.
    chunk.mesh.visible = false;
    chunk.mesh.receiveShadow = true;
    chunk.mesh.castShadow = false;
    chunk.mesh.renderOrder = isFar ? -20 : -10;
    chunk.mesh.name = isFar ? "far-terrain-chunk" : "near-terrain-chunk";
    this.group.add(chunk.mesh);
    this.sceneRevisionValue += 1;
    return chunk;
  }

  private getIndexAttribute(vertexResolution: number): THREE.BufferAttribute {
    let indices = this.indexArrays.get(vertexResolution);
    if (!indices) {
      indices = generateTerrainGridIndices(vertexResolution);
      this.indexArrays.set(vertexResolution, indices);
    }
    // Geometry instances share the immutable CPU index array, while separate
    // BufferAttribute identities prevent one pooled geometry's disposal from
    // invalidating another geometry's GPU index buffer.
    return new THREE.BufferAttribute(indices, 1);
  }

  private resetChunkPlaceholder(chunk: TerrainChunk): void {
    chunk.hasSourceData = false;
    const positionAttribute = chunk.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const normalAttribute = chunk.mesh.geometry.getAttribute("normal") as THREE.BufferAttribute;
    const colorAttribute = chunk.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const positions = positionAttribute.array as Float32Array;
    const colors = colorAttribute.array as Uint8Array;
    // A one-sample flat placeholder made a whole 1.6–12.8 km tile inherit the
    // centre's land/water classification. As tiles streamed, those slabs
    // repeatedly covered and uncovered the ocean. A tiny synchronous anchor
    // grid preserves coarse coastline topology until the worker result lands.
    const anchorResolution = chunk.isFar ? 5 : 3;
    const anchorHeights = new Float32Array(anchorResolution * anchorResolution);
    const anchorColors = new Float32Array(anchorResolution * anchorResolution * 3);
    const chunkWorldX = chunk.tileX * chunk.size;
    const chunkWorldZ = chunk.tileZ * chunk.size;
    let minHeight = Number.POSITIVE_INFINITY;
    let maxHeight = Number.NEGATIVE_INFINITY;
    for (let row = 0; row < anchorResolution; row += 1) {
      const fractionZ = row / (anchorResolution - 1);
      for (let column = 0; column < anchorResolution; column += 1) {
        const fractionX = column / (anchorResolution - 1);
        const sample = this.sample(
          chunkWorldX + fractionX * chunk.size,
          chunkWorldZ + fractionZ * chunk.size,
        );
        const anchor = row * anchorResolution + column;
        anchorHeights[anchor] = sample.height;
        minHeight = Math.min(minHeight, sample.height);
        maxHeight = Math.max(maxHeight, sample.height);
        terrainColor(sample, this.tempColor);
        anchorColors[anchor * 3] = this.tempColor.r;
        anchorColors[anchor * 3 + 1] = this.tempColor.g;
        anchorColors[anchor * 3 + 2] = this.tempColor.b;
      }
    }

    const segments = chunk.vertexResolution - 1;
    const anchorSegments = anchorResolution - 1;
    const interpolateAnchor = (
      values: Float32Array,
      stride: number,
      component: number,
      gridX: number,
      gridZ: number,
    ): number => {
      const anchorX = (gridX / segments) * anchorSegments;
      const anchorZ = (gridZ / segments) * anchorSegments;
      const x0 = Math.min(anchorSegments - 1, Math.floor(anchorX));
      const z0 = Math.min(anchorSegments - 1, Math.floor(anchorZ));
      const x1 = x0 + 1;
      const z1 = z0 + 1;
      const tx = anchorX - x0;
      const tz = anchorZ - z0;
      const valueAt = (x: number, z: number) =>
        values[(z * anchorResolution + x) * stride + component] ?? 0;
      return THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(valueAt(x0, z0), valueAt(x1, z0), tx),
        THREE.MathUtils.lerp(valueAt(x0, z1), valueAt(x1, z1), tx),
        tz,
      );
    };

    for (let row = 0; row < chunk.vertexResolution; row += 1) {
      for (let column = 0; column < chunk.vertexResolution; column += 1) {
        const vertex = row * chunk.vertexResolution + column;
        const offset = vertex * 3;
        positions[offset + 1] = interpolateAnchor(anchorHeights, 1, 0, column, row);
        colors[offset] = Math.round(interpolateAnchor(anchorColors, 3, 0, column, row) * 255);
        colors[offset + 1] = Math.round(
          interpolateAnchor(anchorColors, 3, 1, column, row) * 255,
        );
        colors[offset + 2] = Math.round(
          interpolateAnchor(anchorColors, 3, 2, column, row) * 255,
        );
      }
    }
    positionAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
    chunk.mesh.geometry.computeVertexNormals();
    normalAttribute.needsUpdate = true;
    if (!chunk.isFar) {
      for (let vertex = 0; vertex < chunk.vertexResolution * chunk.vertexResolution; vertex += 1) {
        chunk.sourceHeights[vertex] = positions[vertex * 3 + 1] ?? 0;
      }
      chunk.sourceNormals.set(normalAttribute.array as Float32Array);
      chunk.hasSourceData = true;
      chunk.sourceRevision += 1;
    }
    setTerrainBounds(chunk.mesh.geometry, chunk.size, minHeight, maxHeight);
    this.bathymetrySourceRevision += 1;
  }

  private requestChunk(chunk: TerrainChunk, priority: number): void {
    const epoch = this.generationEpoch;
    const generation = chunk.generation;
    const key = chunk.key;
    const vertexResolution = chunk.vertexResolution;
    let requestId = -1;
    requestId = this.terrainGeneration.request(
      {
        key,
        generation,
        priority,
        options: {
          tileX: chunk.tileX,
          tileZ: chunk.tileZ,
          size: chunk.size,
          resolution: vertexResolution,
          includeNormals: true,
          includeColors: true,
          includeClimate: false,
        },
      },
      (tile) => {
        if (
          !this.isCurrentChunk(chunk, key, generation, epoch, requestId) ||
          tile.tileX !== chunk.tileX ||
          tile.tileZ !== chunk.tileZ ||
          tile.size !== chunk.size ||
          tile.resolution !== vertexResolution
        ) {
          return;
        }
        chunk.requestId = null;
        if (!this.applyTile(chunk, tile)) return;
        chunk.ready = true;
        if (this.retiredChunks.size === 0) {
          this.setChunkVisible(chunk, true);
          this.treesDirty = true;
        }
        if (!chunk.isFar && chunk.mesh.visible) {
          this.refreshNearTerrainMorphs();
          this.groundCover.invalidate();
        }
        this.finishQualityTransitionWhenReady();
      },
      () => {
        if (this.isCurrentChunk(chunk, key, generation, epoch, requestId)) {
          chunk.requestId = null;
        }
      },
    );
    chunk.requestId = requestId >= 0 ? requestId : null;
  }

  private isCurrentChunk(
    chunk: TerrainChunk,
    key: string,
    generation: number,
    epoch: number,
    requestId: number,
  ): boolean {
    return (
      !this.disposed &&
      epoch === this.generationEpoch &&
      chunk.generation === generation &&
      chunk.requestId === requestId &&
      this.chunks.get(key) === chunk
    );
  }

  private applyTile(chunk: TerrainChunk, tile: TerrainTileData): boolean {
    const geometry = chunk.mesh.geometry;
    const positionAttribute = geometry.getAttribute("position") as THREE.BufferAttribute;
    const normalAttribute = geometry.getAttribute("normal") as THREE.BufferAttribute;
    const colorAttribute = geometry.getAttribute("color") as THREE.BufferAttribute;
    const positions = positionAttribute.array as Float32Array;
    const normals = normalAttribute.array as Float32Array;
    const colors = colorAttribute.array as Uint8Array;
    const vertexCount = tile.resolution * tile.resolution;
    if (
      tile.heights.length < vertexCount ||
      tile.normals.length < vertexCount * 3 ||
      tile.colors.length < vertexCount * 3 ||
      positions.length !== vertexCount * 3 ||
      normals.length !== vertexCount * 3 ||
      colors.length !== vertexCount * 3 ||
      !Number.isFinite(tile.minHeight) ||
      !Number.isFinite(tile.maxHeight)
    ) {
      return false;
    }

    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const height = tile.heights[vertex] ?? 0;
      positions[vertex * 3 + 1] = height;
      if (!chunk.isFar) chunk.sourceHeights[vertex] = height;
    }
    normals.set(tile.normals.subarray(0, vertexCount * 3));
    if (!chunk.isFar) {
      chunk.sourceNormals.set(tile.normals.subarray(0, vertexCount * 3));
      chunk.hasSourceData = true;
      chunk.sourceRevision += 1;
    }
    colors.set(tile.colors.subarray(0, vertexCount * 3));
    positionAttribute.needsUpdate = true;
    normalAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
    setTerrainBounds(geometry, chunk.size, tile.minHeight, tile.maxHeight);
    this.bathymetrySourceRevision += 1;
    return true;
  }

  private finishQualityTransitionWhenReady(): void {
    if (this.retiredChunks.size === 0) return;
    const expectedCount = (this.radius * 2 + 1) ** 2 + (FAR_TILE_RADIUS * 2 + 1) ** 2;
    if (this.chunks.size !== expectedCount) return;
    for (const chunk of this.chunks.values()) {
      if (!chunk.ready) return;
    }
    // Swap complete terrain sets atomically. Visibility changes increment the
    // scene revision because CSM registration deliberately traverses visible
    // meshes only; the next render must register this formerly hidden set.
    for (const chunk of this.chunks.values()) this.setChunkVisible(chunk, true);
    for (const chunk of this.retiredChunks.values()) this.disposeChunk(chunk);
    this.retiredChunks.clear();
    this.treesDirty = true;
    this.groundCover.invalidate();
    this.updateFarCutoutBounds();
    this.refreshNearTerrainMorphs();
  }

  private setChunkVisible(chunk: TerrainChunk, visible: boolean): void {
    if (chunk.mesh.visible === visible) return;
    chunk.mesh.visible = visible;
    this.sceneRevisionValue += 1;
  }

  private disposeChunk(chunk: TerrainChunk): void {
    if (chunk.requestId !== null) this.terrainGeneration.cancel(chunk.requestId);
    chunk.requestId = null;
    chunk.generation += 1;
    chunk.mesh.geometry.dispose();
    chunk.mesh.removeFromParent();
    this.sceneRevisionValue += 1;
  }

  private refreshHorizon(): void {
    const geometry = this.horizonTerrain.geometry;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const color = geometry.getAttribute("color") as THREE.BufferAttribute;
    const positions = position.array as Float32Array;
    const colors = color.array as Uint8Array;
    const haze = new THREE.Color(0x91a9ac);

    for (let ring = 0; ring < HORIZON_RADII.length; ring += 1) {
      const radius = HORIZON_RADII[ring]!;
      const atmosphericMix = THREE.MathUtils.lerp(0.16, 0.82, ring / (HORIZON_RADII.length - 1));
      for (let segment = 0; segment <= HORIZON_SEGMENTS; segment += 1) {
        const angle = (segment / HORIZON_SEGMENTS) * Math.PI * 2;
        const localX = Math.cos(angle) * radius;
        const localZ = Math.sin(angle) * radius;
        const sample = this.sample(
          this.horizonCenterX + localX,
          this.horizonCenterZ + localZ,
        );
        const vertex = ring * (HORIZON_SEGMENTS + 1) + segment;
        const offset = vertex * 3;
        positions[offset] = localX;
        positions[offset + 1] = sample.height - ring * 1.5;
        positions[offset + 2] = localZ;
        terrainColor(sample, this.tempColor).lerp(haze, atmosphericMix);
        colors[offset] = Math.round(this.tempColor.r * 255);
        colors[offset + 1] = Math.round(this.tempColor.g * 255);
        colors[offset + 2] = Math.round(this.tempColor.b * 255);
      }
    }
    position.needsUpdate = true;
    color.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    this.positionHorizon();
  }

  private positionHorizon(): void {
    this.horizonTerrain.position.set(
      this.horizonCenterX - this.originX,
      -1.5,
      this.horizonCenterZ - this.originZ,
    );
  }

  private refreshTrees(): void {
    this.treesDirty = false;
    const matrix = this.tempMatrix;
    let trunkCount = 0;
    let broadleafCount = 0;
    let aspenCount = 0;
    let coniferCount = 0;
    let spruceCount = 0;
    let farConiferCount = 0;
    let farBroadleafCount = 0;
    let rockCount = 0;
    const forestBudget = treeRenderBudget(this.quality);
    const nearLimit = forestBudget.nearInstances;
    const farLimit = forestBudget.farInstances;
    const rockLimit = forestBudget.rockInstances;
    const nearRadius = forestBudget.nearRadius;
    const worldCenterX = Number.isFinite(this.forestCenterX)
      ? this.forestCenterX
      : (this.centerTileX + 0.5) * this.tileSize;
    const worldCenterZ = Number.isFinite(this.forestCenterZ)
      ? this.forestCenterZ
      : (this.centerTileZ + 0.5) * this.tileSize;
    const visibleNearByKey = new Map<string, TerrainChunk>();
    const visibleFarByKey = new Map<string, TerrainChunk>();
    for (const [key, chunk] of this.retiredChunks) {
      if (!chunk.mesh.visible || !chunk.ready) continue;
      (chunk.isFar ? visibleFarByKey : visibleNearByKey).set(key, chunk);
    }
    for (const [key, chunk] of this.chunks) {
      if (!chunk.mesh.visible || !chunk.ready) continue;
      (chunk.isFar ? visibleFarByKey : visibleNearByKey).set(key, chunk);
    }
    const visibleNear = [...visibleNearByKey.values()].sort(
      (first, second) => first.tileZ - second.tileZ || first.tileX - second.tileX,
    );

    for (const chunk of visibleNear) {
      const chunkStartX = chunk.tileX * chunk.size;
      const chunkStartZ = chunk.tileZ * chunk.size;
      const minCellX = Math.floor(chunkStartX / TREE_CELL_SIZE);
      const maxCellX = Math.ceil((chunkStartX + chunk.size) / TREE_CELL_SIZE);
      const minCellZ = Math.floor(chunkStartZ / TREE_CELL_SIZE);
      const maxCellZ = Math.ceil((chunkStartZ + chunk.size) / TREE_CELL_SIZE);
      for (let cellZ = minCellZ; cellZ < maxCellZ; cellZ += 1) {
        for (let cellX = minCellX; cellX < maxCellX; cellX += 1) {
          const jitterX = 0.12 + hash01(cellX, cellZ, this.seed ^ 0x51a7) * 0.76;
          const jitterZ = 0.12 + hash01(cellZ, cellX, this.seed ^ 0x8f31) * 0.76;
          const x = (cellX + jitterX) * TREE_CELL_SIZE;
          const z = (cellZ + jitterZ) * TREE_CELL_SIZE;
          if (
            x < chunkStartX ||
            x >= chunkStartX + chunk.size ||
            z < chunkStartZ ||
            z >= chunkStartZ + chunk.size
          ) {
            continue;
          }
          const distanceSquared = (x - worldCenterX) ** 2 + (z - worldCenterZ) ** 2;
          if (
            !includesNearTreeLod(
              distanceSquared,
              nearRadius,
              hash01(cellX, cellZ, this.seed ^ 0x2f31),
            )
          ) {
            continue;
          }
          const localX = x - chunkStartX;
          const localZ = z - chunkStartZ;
          const height = this.sampleChunkHeight(chunk, localX, localZ);
          if (height < 4 || this.isInsideRunwayClearance(x, z)) continue;
          const slope = this.sampleChunkSlope(chunk, localX, localZ);

          // Exposed stone follows elevation and slope rather than appearing
          // only where a tree happened to pass its density test.
          const rockChance = hash01(cellZ, cellX, this.seed ^ 0xb09d);
          const rockThreshold = 0.955 - Math.min(0.11, slope * 0.2) -
            THREE.MathUtils.smoothstep(height, 300, 1_300) * 0.06;
          if (rockCount < rockLimit && rockChance > rockThreshold) {
            const rockScale = 1.5 + hash01(cellX, cellZ, this.seed ^ 0x7a91) * 5.2;
            this.tempPosition.set(x - this.originX, height + rockScale * 0.34, z - this.originZ);
            this.tempEuler.set(
              hash01(cellX, cellZ, this.seed ^ 17) * 0.42,
              hash01(cellZ, cellX, this.seed ^ 19) * Math.PI * 2,
              hash01(cellX, cellZ, this.seed ^ 23) * 0.36,
            );
            this.tempQuaternion.setFromEuler(this.tempEuler);
            this.tempScale.set(rockScale, rockScale * (0.46 + slope), rockScale * 0.78);
            matrix.compose(this.tempPosition, this.tempQuaternion, this.tempScale);
            this.rocks.setMatrixAt(rockCount, matrix);
            this.tempColor.setHSL(
              0.105,
              0.045 + hash01(cellX, cellZ, this.seed ^ 27) * 0.045,
              0.3 + hash01(cellX, cellZ, this.seed ^ 29) * 0.18,
            );
            this.rocks.setColorAt(rockCount, this.tempColor);
            rockCount += 1;
          }

          if (height > 1_260 || slope > 0.24 || trunkCount >= nearLimit) continue;
          const forestPatch = smoothHashField(cellX, cellZ, 7.5, this.seed ^ 0x423d);
          const density = hash01(cellX, cellZ, this.seed ^ 0x64d3);
          const treelineFade = 1 - THREE.MathUtils.smoothstep(height, 780, 1_270);
          const densityThreshold = (0.16 + forestPatch * 0.58) * treelineFade;
          if (density > densityThreshold) continue;

          {
            // Reuse the continuous density field as a local moisture proxy and
            // add a much broader climate field.  This keeps species changes
            // gradual (no elevation rings), deterministic, and cheap enough to
            // rebuild while terrain workers stream in.
            const moisture = THREE.MathUtils.clamp(
              0.12 + forestPatch * 0.72 +
                smoothHashField(cellX, cellZ, 19, this.seed ^ 0x79b1) * 0.16,
              0,
              1,
            );
            const temperature = THREE.MathUtils.clamp(
              0.91 - height / 1_620 +
                (smoothHashField(cellX, cellZ, 31, this.seed ^ 0x18e7) - 0.5) * 0.2,
              0,
              1,
            );
            const species = selectTreeSpecies({
              height,
              slope,
              moisture,
              temperature,
              selector: hash01(cellZ, cellX, this.seed ^ 0xa619),
            });
            const profile = TREE_SPECIES_PROFILES[species];
            const scale = 0.62 + hash01(cellX, cellZ, this.seed ^ 991) * 0.72;
            const breadth = 0.88 + hash01(cellZ, cellX, this.seed ^ 0x519) * 0.24;
            const crownWidth = scale * profile.widthScale;
            const crownHeight = scale * profile.heightScale;
            const trunkWidth = scale * Math.sqrt(profile.widthScale) * 0.9;
            this.tempQuaternion.setFromAxisAngle(
              this.upAxis,
              hash01(cellZ, cellX, this.seed ^ 31) * Math.PI * 2,
            );

            // Every scale component remains positive. Besides correct normal
            // orientation, this prevents reflected/CSM passes from receiving
            // inverted winding that looked like upside-down foliage.
            this.tempScale.set(
              trunkWidth * breadth,
              crownHeight,
              trunkWidth / breadth,
            );
            this.tempPosition.set(
              x - this.originX,
              height + 5.5 * crownHeight,
              z - this.originZ,
            );
            matrix.compose(this.tempPosition, this.tempQuaternion, this.tempScale);
            this.treeTrunks.setMatrixAt(trunkCount, matrix);
            const barkTone = hash01(cellZ, cellX, this.seed ^ 0x317);
            if (species === "aspen") {
              this.tempColor.setHSL(0.105, 0.1, 0.52 + barkTone * 0.14);
            } else if (species === "pine") {
              this.tempColor.setHSL(0.065, 0.35, 0.17 + barkTone * 0.08);
            } else if (species === "spruce") {
              this.tempColor.setHSL(0.085, 0.22, 0.15 + barkTone * 0.07);
            } else {
              this.tempColor.setHSL(0.075, 0.32, 0.19 + barkTone * 0.08);
            }
            this.treeTrunks.setColorAt(trunkCount, this.tempColor);

            const tone = hash01(cellX, cellZ, this.seed ^ 0xc412);
            this.tempScale.set(
              crownWidth * breadth,
              crownHeight,
              crownWidth / breadth,
            );
            this.tempPosition.y = height + profile.crownCenterHeight * crownHeight;
            matrix.compose(this.tempPosition, this.tempQuaternion, this.tempScale);
            if (species === "aspen") {
              this.aspenCanopies.setMatrixAt(aspenCount, matrix);
              this.tempColor.setHSL(
                0.18 + tone * 0.09,
                0.3 + tone * 0.18,
                0.31 + tone * 0.12,
              );
              this.aspenCanopies.setColorAt(aspenCount, this.tempColor);
              aspenCount += 1;
            } else if (species === "pine") {
              this.coniferCanopies.setMatrixAt(coniferCount, matrix);
              this.tempColor.setHSL(
                0.32 + tone * 0.035,
                0.35 + tone * 0.12,
                0.155 + tone * 0.075,
              );
              this.coniferCanopies.setColorAt(coniferCount, this.tempColor);
              coniferCount += 1;
            } else if (species === "spruce") {
              this.spruceCanopies.setMatrixAt(spruceCount, matrix);
              this.tempColor.setHSL(
                0.39 + tone * 0.04,
                0.28 + tone * 0.14,
                0.15 + tone * 0.065,
              );
              this.spruceCanopies.setColorAt(spruceCount, this.tempColor);
              spruceCount += 1;
            } else {
              this.treeCanopies.setMatrixAt(broadleafCount, matrix);
              this.tempColor.setHSL(
                0.255 + tone * 0.085,
                0.37 + tone * 0.18,
                0.2 + tone * 0.105,
              );
              this.treeCanopies.setColorAt(broadleafCount, this.tempColor);
              broadleafCount += 1;
            }
            trunkCount += 1;
          }
        }
      }
    }

    const visibleFar = [...visibleFarByKey.values()].sort(
      (first, second) => first.tileZ - second.tileZ || first.tileX - second.tileX,
    );
    const farMaximumSquared = FAR_FOREST_RADIUS ** 2;
    const farCandidates: FarForestCandidate[] = [];
    for (const chunk of visibleFar) {
      const chunkStartX = chunk.tileX * chunk.size;
      const chunkStartZ = chunk.tileZ * chunk.size;
      const minCellX = Math.floor(chunkStartX / FAR_TREE_CELL_SIZE);
      const maxCellX = Math.ceil((chunkStartX + chunk.size) / FAR_TREE_CELL_SIZE);
      const minCellZ = Math.floor(chunkStartZ / FAR_TREE_CELL_SIZE);
      const maxCellZ = Math.ceil((chunkStartZ + chunk.size) / FAR_TREE_CELL_SIZE);
      for (let cellZ = minCellZ; cellZ < maxCellZ; cellZ += 1) {
        for (let cellX = minCellX; cellX < maxCellX; cellX += 1) {
          const forestPatch = smoothHashField(cellX, cellZ, 5.5, this.seed ^ 0xf075);
          if (hash01(cellX, cellZ, this.seed ^ 0x7f05) > 0.22 + forestPatch * 0.5) continue;
          const x = (cellX + 0.1 + hash01(cellX, cellZ, this.seed ^ 0x8ad1) * 0.8) * FAR_TREE_CELL_SIZE;
          const z = (cellZ + 0.1 + hash01(cellZ, cellX, this.seed ^ 0xa173) * 0.8) * FAR_TREE_CELL_SIZE;
          if (
            x < chunkStartX ||
            x >= chunkStartX + chunk.size ||
            z < chunkStartZ ||
            z >= chunkStartZ + chunk.size
          ) {
            continue;
          }
          const distanceSquared = (x - worldCenterX) ** 2 + (z - worldCenterZ) ** 2;
          if (
            distanceSquared > farMaximumSquared ||
            !includesFarTreeLod(
              distanceSquared,
              nearRadius,
              hash01(cellX, cellZ, this.seed ^ 0x713d),
            )
          ) {
            continue;
          }
          if (this.isInsideRunwayClearance(x, z)) continue;
          const localX = x - chunkStartX;
          const localZ = z - chunkStartZ;
          const height = this.sampleChunkHeight(chunk, localX, localZ);
          if (height < 5 || height > 1_320) continue;
          farCandidates.push({
            cellX,
            cellZ,
            deltaX: x - worldCenterX,
            deltaZ: z - worldCenterZ,
            distanceSquared,
            forestPatch,
            height,
            stableX: cellX,
            stableZ: cellZ,
            tieBreaker: hash01(cellX, cellZ, this.seed ^ 0x5d73),
            x,
            z,
          });
        }
      }
    }

    const orderedFarCandidates = orderForestLodCandidates(farCandidates);
    for (
      let candidateIndex = 0;
      candidateIndex < Math.min(farLimit, orderedFarCandidates.length);
      candidateIndex += 1
    ) {
      const candidate = orderedFarCandidates[candidateIndex]!;
      const { cellX, cellZ, forestPatch, height, x, z } = candidate;
      const scale = 0.72 + hash01(cellX, cellZ, this.seed ^ 0x21d3) * 0.88;
      this.tempPosition.set(
        x - this.originX,
        height,
        z - this.originZ,
      );
      this.tempQuaternion.setFromAxisAngle(
        this.upAxis,
        hash01(cellZ, cellX, this.seed ^ 0xc501) * Math.PI * 2,
      );
      const widthVariation = 0.82 + hash01(cellZ, cellX, this.seed ^ 0x237) * 0.34;
      const tone = hash01(cellX, cellZ, this.seed ^ 0x11b3);
      const coniferProbability = THREE.MathUtils.clamp(
        0.2 + height / 1_430 + (0.5 - forestPatch) * 0.3,
        0.16,
        0.93,
      );
      const isConifer = hash01(cellZ, cellX, this.seed ^ 0x391d) < coniferProbability;
      if (isConifer) {
        this.tempScale.set(
          7.4 * scale * widthVariation,
          28 * scale,
          7.4 * scale / widthVariation,
        );
        matrix.compose(this.tempPosition, this.tempQuaternion, this.tempScale);
        this.farForest.setMatrixAt(farConiferCount, matrix);
        this.tempColor.setHSL(
          0.3 + tone * 0.055,
          0.31 + tone * 0.12,
          0.16 + tone * 0.085,
        );
        this.farForest.setColorAt(farConiferCount, this.tempColor);
        farConiferCount += 1;
      } else {
        this.tempScale.set(
          11.2 * scale * widthVariation,
          20 * scale,
          10.1 * scale / widthVariation,
        );
        matrix.compose(this.tempPosition, this.tempQuaternion, this.tempScale);
        this.farBroadleafForest.setMatrixAt(farBroadleafCount, matrix);
        this.tempColor.setHSL(
          0.245 + tone * 0.095,
          0.3 + tone * 0.17,
          0.2 + tone * 0.105,
        );
        this.farBroadleafForest.setColorAt(farBroadleafCount, this.tempColor);
        farBroadleafCount += 1;
      }
    }

    this.treeTrunks.count = trunkCount;
    this.treeCanopies.count = broadleafCount;
    this.aspenCanopies.count = aspenCount;
    this.coniferCanopies.count = coniferCount;
    this.spruceCanopies.count = spruceCount;
    this.farForest.count = farConiferCount;
    this.farBroadleafForest.count = farBroadleafCount;
    this.rocks.count = rockCount;
    this.treeTrunks.instanceMatrix.needsUpdate = true;
    this.treeCanopies.instanceMatrix.needsUpdate = true;
    this.aspenCanopies.instanceMatrix.needsUpdate = true;
    this.coniferCanopies.instanceMatrix.needsUpdate = true;
    this.spruceCanopies.instanceMatrix.needsUpdate = true;
    this.farForest.instanceMatrix.needsUpdate = true;
    this.farBroadleafForest.instanceMatrix.needsUpdate = true;
    this.rocks.instanceMatrix.needsUpdate = true;
    if (this.treeTrunks.instanceColor) this.treeTrunks.instanceColor.needsUpdate = true;
    if (this.treeCanopies.instanceColor) this.treeCanopies.instanceColor.needsUpdate = true;
    if (this.aspenCanopies.instanceColor) this.aspenCanopies.instanceColor.needsUpdate = true;
    if (this.coniferCanopies.instanceColor) this.coniferCanopies.instanceColor.needsUpdate = true;
    if (this.spruceCanopies.instanceColor) this.spruceCanopies.instanceColor.needsUpdate = true;
    if (this.farForest.instanceColor) this.farForest.instanceColor.needsUpdate = true;
    if (this.farBroadleafForest.instanceColor) {
      this.farBroadleafForest.instanceColor.needsUpdate = true;
    }
    if (this.rocks.instanceColor) this.rocks.instanceColor.needsUpdate = true;
  }

  private sampleChunkHeight(chunk: TerrainChunk, localX: number, localZ: number): number {
    const position = chunk.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const positions = position.array as Float32Array;
    const side = Math.round(Math.sqrt(position.count));
    const segments = Math.max(1, side - 1);
    const gridX = THREE.MathUtils.clamp((localX / chunk.size) * segments, 0, segments);
    const gridZ = THREE.MathUtils.clamp((localZ / chunk.size) * segments, 0, segments);
    const x0 = Math.min(segments - 1, Math.floor(gridX));
    const z0 = Math.min(segments - 1, Math.floor(gridZ));
    const x1 = x0 + 1;
    const z1 = z0 + 1;
    const tx = gridX - x0;
    const tz = gridZ - z0;
    const top = THREE.MathUtils.lerp(
      positions[(z0 * side + x0) * 3 + 1] ?? 0,
      positions[(z0 * side + x1) * 3 + 1] ?? 0,
      tx,
    );
    const bottom = THREE.MathUtils.lerp(
      positions[(z1 * side + x0) * 3 + 1] ?? 0,
      positions[(z1 * side + x1) * 3 + 1] ?? 0,
      tx,
    );
    return THREE.MathUtils.lerp(top, bottom, tz);
  }

  private sampleChunkSlope(chunk: TerrainChunk, localX: number, localZ: number): number {
    const spacing = chunk.size / Math.max(1, chunk.vertexResolution - 1);
    const left = this.sampleChunkHeight(chunk, localX - spacing, localZ);
    const right = this.sampleChunkHeight(chunk, localX + spacing, localZ);
    const back = this.sampleChunkHeight(chunk, localX, localZ - spacing);
    const front = this.sampleChunkHeight(chunk, localX, localZ + spacing);
    const gradientX = (right - left) / Math.max(1, spacing * 2);
    const gradientZ = (front - back) / Math.max(1, spacing * 2);
    return 1 - 1 / Math.hypot(gradientX, 1, gradientZ);
  }

  /**
   * Samples the exact render-height grids, including synchronous placeholders,
   * so bathymetry rebuilds never re-run the full climate/normal terrain kernel.
   */
  private sampleLoadedBathymetryHeight(worldX: number, worldZ: number): number | undefined {
    const nearHeight = this.sampleLoadedChunkGridHeight(
      "near",
      this.tileSize,
      worldX,
      worldZ,
    );
    if (nearHeight !== undefined && Number.isFinite(nearHeight)) return nearHeight;
    const farHeight = this.sampleLoadedChunkGridHeight(
      "far",
      this.tileSize * FAR_TILE_SCALE,
      worldX,
      worldZ,
    );
    if (farHeight !== undefined && Number.isFinite(farHeight)) return farHeight;
    // Missing coverage decodes as saturated deep water. Never run thousands of
    // full climate/normal terrain samples on the main thread as a fallback.
    return undefined;
  }

  private sampleLoadedChunkGridHeight(
    prefix: "near" | "far",
    size: number,
    worldX: number,
    worldZ: number,
  ): number | undefined {
    const tileX = worldToTerrainTile(worldX, size);
    const tileZ = worldToTerrainTile(worldZ, size);
    const key = `${prefix}:${tileX}:${tileZ}`;
    const current = this.chunks.get(key);
    const retired = this.retiredChunks.get(key);
    const chunk = current?.ready && current.mesh.visible
      ? current
      : retired?.ready && retired.mesh.visible
        ? retired
        : current?.mesh.visible
          ? current
          : retired?.mesh.visible
            ? retired
            : undefined;
    if (!chunk) return undefined;
    return this.sampleChunkHeight(
      chunk,
      worldX - tileX * size,
      worldZ - tileZ * size,
    );
  }

  /**
   * Ground cover samples the already-loaded render grid instead of invoking
   * the substantially more expensive climate/terrain kernel thousands of
   * times whenever its bounded instance window moves.
   */
  private sampleLoadedGroundSurface(worldX: number, worldZ: number): GroundCoverSurface | undefined {
    const tileX = worldToTerrainTile(worldX, this.tileSize);
    const tileZ = worldToTerrainTile(worldZ, this.tileSize);
    const key = `near:${tileX}:${tileZ}`;
    const current = this.chunks.get(key);
    const retired = this.retiredChunks.get(key);
    const chunk =
      current?.ready && current.mesh.visible
        ? current
        : retired?.ready && retired.mesh.visible
          ? retired
          : undefined;
    if (!chunk) return undefined;
    const localX = worldX - tileX * this.tileSize;
    const localZ = worldZ - tileZ * this.tileSize;
    return {
      height: this.sampleChunkHeight(chunk, localX, localZ),
      slope: this.sampleChunkSlope(chunk, localX, localZ),
    };
  }

  private isInsideRunwayClearance(x: number, z: number): boolean {
    return isInsideAirportSceneryClearance(this.runway, x, z);
  }

  private createRunway(definition: RenderRunwayDefinition): void {
    // The surface tracks the same elevation used by ground collision. A tiny
    // 25 mm render bias plus polygon offset prevents z-fighting without making
    // the aircraft look as though it hovers above an invisible runway.
    const terrainElevation = definition.elevation;
    const runwayHeight = terrainElevation + 0.025;
    const runwayLength = definition.runwayLength;
    const runwayWidth = definition.runwayWidth;
    const asphalt = new THREE.MeshStandardMaterial({
      color: 0x2e3333,
      roughness: 0.98,
      // Terrain tiles are intentionally coarse relative to runway width, so
      // their interpolated triangles can locally cross the exact airport
      // elevation. Airport pavement is an ordered ground decal: it renders
      // after terrain, writes its real planar depth, then aircraft/objects draw
      // normally on top.
      depthFunc: THREE.LessEqualDepth,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const shoulderMaterial = new THREE.MeshStandardMaterial({
      color: 0x6b6556,
      roughness: 1,
      depthFunc: THREE.LessEqualDepth,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const taxiMaterial = new THREE.MeshStandardMaterial({
      color: 0x454a48,
      roughness: 0.98,
      depthFunc: THREE.LessEqualDepth,
      polygonOffset: true,
      polygonOffsetFactor: -1.5,
      polygonOffsetUnits: -1.5,
    });
    const paint = new THREE.MeshBasicMaterial({
      color: 0xece9d8,
      depthFunc: THREE.LessEqualDepth,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });

    const shoulder = new THREE.Mesh(
      new THREE.PlaneGeometry(runwayWidth + 20, runwayLength + 90),
      shoulderMaterial,
    );
    shoulder.rotation.x = -Math.PI / 2;
    shoulder.name = "runway-shoulder";
    shoulder.position.y = terrainElevation + 0.012;
    shoulder.receiveShadow = true;
    shoulder.renderOrder = -8;
    this.runwayGroup.add(shoulder);

    const runway = new THREE.Mesh(new THREE.PlaneGeometry(runwayWidth, runwayLength), asphalt);
    runway.name = "runway-surface";
    runway.rotation.x = -Math.PI / 2;
    runway.position.y = runwayHeight;
    runway.receiveShadow = true;
    runway.renderOrder = -6;
    this.runwayGroup.add(runway);

    const markingTransforms: Array<{ x: number; z: number; width: number; length: number }> = [];
    for (let along = -runwayLength * 0.39; along <= runwayLength * 0.39; along += 72) {
      markingTransforms.push({ x: 0, z: along, width: 1.05, length: 31 });
    }
    for (const end of [-1, 1]) {
      for (let row = -4; row <= 4; row += 1) {
        markingTransforms.push({
          x: row * Math.min(3.7, runwayWidth / 11),
          z: end * (runwayLength * 0.5 - 48),
          width: 1.8,
          length: 24,
        });
      }
      markingTransforms.push(
        { x: -runwayWidth * 0.22, z: end * runwayLength * 0.22, width: 2.7, length: 34 },
        { x: runwayWidth * 0.22, z: end * runwayLength * 0.22, width: 2.7, length: 34 },
      );
    }
    markingTransforms.push(
      { x: -runwayWidth * 0.5 + 0.9, z: 0, width: 0.48, length: runwayLength - 20 },
      { x: runwayWidth * 0.5 - 0.9, z: 0, width: 0.48, length: runwayLength - 20 },
    );
    const markingGeometry = new THREE.PlaneGeometry(1, 1);
    const markings = new THREE.InstancedMesh(markingGeometry, paint, markingTransforms.length);
    markings.name = "runway-markings";
    const planeQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    for (let index = 0; index < markingTransforms.length; index += 1) {
      const marking = markingTransforms[index];
      if (!marking) continue;
      this.tempPosition.set(marking.x, runwayHeight + 0.008, marking.z);
      this.tempScale.set(marking.width, marking.length, 1);
      this.tempMatrix.compose(this.tempPosition, planeQuaternion, this.tempScale);
      markings.setMatrixAt(index, this.tempMatrix);
    }
    markings.instanceMatrix.needsUpdate = true;
    markings.renderOrder = -5;
    this.runwayGroup.add(markings);

    const apron = new THREE.Mesh(new THREE.PlaneGeometry(145, 210), taxiMaterial);
    apron.name = "airport-apron";
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(runwayWidth * 0.5 + 103, terrainElevation + 0.018, -runwayLength * 0.18);
    apron.receiveShadow = true;
    apron.renderOrder = -8;
    this.runwayGroup.add(apron);
    const taxiway = new THREE.Mesh(new THREE.PlaneGeometry(116, 18), taxiMaterial);
    taxiway.name = "airport-taxiway";
    taxiway.rotation.x = -Math.PI / 2;
    taxiway.position.set(runwayWidth * 0.5 + 58, terrainElevation + 0.02, -runwayLength * 0.18);
    taxiway.receiveShadow = true;
    taxiway.renderOrder = -7;
    this.runwayGroup.add(taxiway);

    const hangarMaterial = new THREE.MeshStandardMaterial({ color: 0x8c908b, roughness: 0.82 });
    const hangars = new THREE.InstancedMesh(new THREE.BoxGeometry(44, 15, 30), hangarMaterial, 3);
    hangars.name = "airport-hangars";
    for (let index = 0; index < 3; index += 1) {
      this.tempPosition.set(
        runwayWidth * 0.5 + 135,
        terrainElevation + 7.5,
        -runwayLength * 0.18 + (index - 1) * 55,
      );
      this.tempQuaternion.identity();
      this.tempScale.set(1, 1, 1);
      this.tempMatrix.compose(this.tempPosition, this.tempQuaternion, this.tempScale);
      hangars.setMatrixAt(index, this.tempMatrix);
    }
    hangars.instanceMatrix.needsUpdate = true;
    hangars.castShadow = true;
    hangars.receiveShadow = true;
    this.runwayGroup.add(hangars);

    const lightMaterial = new THREE.MeshBasicMaterial({ color: 0xdff2d4, toneMapped: false });
    const lightPositions: Array<{ x: number; z: number }> = [];
    for (let along = -runwayLength * 0.48; along <= runwayLength * 0.48; along += 55) {
      lightPositions.push(
        { x: -runwayWidth * 0.5 - 1.5, z: along },
        { x: runwayWidth * 0.5 + 1.5, z: along },
      );
    }
    for (const end of [-1, 1]) {
      for (let distance = 45; distance <= 315; distance += 45) {
        lightPositions.push({ x: 0, z: end * (runwayLength * 0.5 + distance) });
        if (distance === 180 || distance === 315) {
          lightPositions.push(
            { x: -12, z: end * (runwayLength * 0.5 + distance) },
            { x: 12, z: end * (runwayLength * 0.5 + distance) },
          );
        }
      }
    }
    const runwayLights = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.62, 5, 4),
      lightMaterial,
      lightPositions.length,
    );
    runwayLights.name = "runway-lights";
    for (let index = 0; index < lightPositions.length; index += 1) {
      const light = lightPositions[index];
      if (!light) continue;
      this.tempPosition.set(light.x, runwayHeight + 0.3, light.z);
      this.tempQuaternion.identity();
      this.tempScale.set(1, 1, 1);
      this.tempMatrix.compose(this.tempPosition, this.tempQuaternion, this.tempScale);
      runwayLights.setMatrixAt(index, this.tempMatrix);
    }
    runwayLights.instanceMatrix.needsUpdate = true;
    runwayLights.frustumCulled = false;
    this.runwayGroup.add(runwayLights);

    this.runwayGroup.rotation.y = definition.headingRadians;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generationEpoch += 1;
    this.terrainGeneration.dispose();
    for (const chunk of this.chunks.values()) this.disposeChunk(chunk);
    for (const chunk of this.available) this.disposeChunk(chunk);
    for (const chunk of this.retiredChunks.values()) this.disposeChunk(chunk);
    this.chunks.clear();
    this.available.length = 0;
    this.retiredChunks.clear();
    this.indexArrays.clear();
    this.material.dispose();
    this.farMaterial.dispose();
    this.terrainDetailMap.value.dispose();
    this.bathymetry.dispose();
    this.horizonTerrain.geometry.dispose();
    this.horizonMaterial.dispose();
    this.groundCover.dispose();
    (this.water.geometry as THREE.BufferGeometry).dispose();
    (this.water.material as THREE.Material).dispose();
    this.treeTrunks.geometry.dispose();
    this.treeCanopies.geometry.dispose();
    this.aspenCanopies.geometry.dispose();
    this.coniferCanopies.geometry.dispose();
    this.spruceCanopies.geometry.dispose();
    this.farForest.geometry.dispose();
    this.farBroadleafForest.geometry.dispose();
    this.rocks.geometry.dispose();
    (this.treeTrunks.material as THREE.Material).dispose();
    (this.treeCanopies.material as THREE.Material).dispose();
    (this.aspenCanopies.material as THREE.Material).dispose();
    (this.coniferCanopies.material as THREE.Material).dispose();
    (this.spruceCanopies.material as THREE.Material).dispose();
    (this.farForest.material as THREE.Material).dispose();
    (this.farBroadleafForest.material as THREE.Material).dispose();
    (this.rocks.material as THREE.Material).dispose();
    this.runwayGroup.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.geometry.dispose();
      if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose());
      else child.material.dispose();
    });
  }
}
