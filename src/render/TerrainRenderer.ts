import * as THREE from "three";
import {
  generateTerrainGridIndices,
  worldToTerrainTile,
  type TerrainTileData,
} from "@/src/world";
import { GroundCoverRenderer, type GroundCoverSurface } from "./GroundCoverRenderer";
import { TerrainGenerationClient } from "./TerrainGenerationClient";

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
}

const FAR_TILE_SCALE = 8;
const FAR_TILE_RADIUS = 1;
// The horizon mesh is tiny compared with the streamed tile grids; spending a
// few hundred extra vertices here removes the faceted mountain silhouette that
// was visible against the sky at medium quality.
const HORIZON_SEGMENTS = 192;
const HORIZON_RADII = [7_200, 11_500, 18_000, 27_000, 39_000] as const;
const MAX_NEAR_TREES = 2_200;
const MAX_FAR_TREES = 4_200;
const MAX_ROCKS = 420;
const TREE_CELL_SIZE = 145;
const FAR_TREE_CELL_SIZE = 380;
const WATER_SIZE = 120_000;
const WATER_CENTER_SNAP = 2_048;
// Keep the rendered surface and the terrain cutout separated deliberately.
// At kilometre-scale view distances a 24-bit perspective depth buffer cannot
// reliably distinguish the old 6 cm water/sea-floor gap.  Removing submerged
// terrain fragments is what guarantees that the two surfaces never z-fight;
// the small offset only gives the shoreline a clean wet edge at close range.
const WATER_RENDER_LEVEL = 0.14;
const TERRAIN_WATER_CUTOUT_LEVEL = 0.11;

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
      const grain =
        periodicNoise01(normalizedX * 41, normalizedZ * 41, 41, seed ^ 0x3341) * 0.6 +
        periodicNoise01(normalizedX * 61, normalizedZ * 61, 61, seed ^ 0x7259) * 0.4;
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
  texture.anisotropy = 8;
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

function createFarTreeGeometry(): THREE.BufferGeometry {
  // Three overlapping whorls read as a tree line instead of a field of
  // identical geometric spikes. This is still only 18 triangles per instance.
  const lower = new THREE.ConeGeometry(1, 0.62, 6, 1, false);
  lower.translate(0, 0.32, 0);
  const middle = new THREE.ConeGeometry(0.76, 0.58, 6, 1, false);
  middle.translate(0, 0.6, 0);
  const crown = new THREE.ConeGeometry(0.5, 0.54, 6, 1, false);
  crown.translate(0, 0.86, 0);
  return mergeGeometryParts([lower, middle, crown]);
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

function createBroadleafCanopyGeometry(): THREE.BufferGeometry {
  // A few overlapping low-poly lobes give a leafy, irregular crown while
  // retaining one material and one instanced draw call for the whole canopy.
  const lobes: Array<readonly [number, number, number, number, number, number]> = [
    [0, 0.3, 0, 5.3, 5.7, 5.1],
    [-3.2, -0.1, 0.7, 3.7, 4.1, 3.5],
    [3.1, 0.25, -0.6, 3.9, 4.3, 3.6],
    [-0.7, 1.9, -2.7, 3.8, 3.9, 3.5],
    [1.1, 1.25, 2.8, 3.6, 4.2, 3.7],
  ];
  const parts = lobes.map(([x, y, z, sx, sy, sz], index) => {
    const geometry = new THREE.IcosahedronGeometry(1, 0);
    geometry.scale(sx, sy, sz);
    geometry.rotateY(index * 1.17);
    geometry.translate(x, y, z);
    return geometry;
  });
  return mergeGeometryParts(parts);
}

function createConiferCanopyGeometry(): THREE.BufferGeometry {
  const lower = new THREE.ConeGeometry(5.9, 10.5, 8, 1, false);
  lower.translate(0, -2.3, 0);
  const middle = new THREE.ConeGeometry(4.7, 10, 8, 1, false);
  middle.translate(0, 2.4, 0);
  const crown = new THREE.ConeGeometry(3.4, 9.2, 8, 1, false);
  crown.translate(0, 6.4, 0);
  return mergeGeometryParts([lower, middle, crown]);
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
  });
  private readonly horizonTerrain: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  private readonly water: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>;
  private readonly runwayGroup = new THREE.Group();
  private readonly treeTrunks: THREE.InstancedMesh;
  private readonly treeCanopies: THREE.InstancedMesh;
  private readonly coniferCanopies: THREE.InstancedMesh;
  private readonly farForest: THREE.InstancedMesh;
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
  private treesDirty = true;
  private nextTreeRefreshTime = 0;
  private horizonCenterX = Number.NaN;
  private horizonCenterZ = Number.NaN;

  constructor(
    private readonly sample: TerrainSampleFunction,
    private readonly seed: number,
    private readonly tileSize = 1_600,
    quality: "low" | "medium" | "high" = "medium",
    private readonly runway?: RenderRunwayDefinition,
  ) {
    this.quality = quality;
    this.resolution = quality === "high" ? 28 : quality === "medium" ? 22 : 16;
    this.farResolution = quality === "high" ? 23 : quality === "medium" ? 19 : 14;
    this.radius = quality === "low" ? 2 : 3;
    this.terrainGeneration = new TerrainGenerationClient(seed);
    this.terrainDetailMap = { value: createTerrainDetailTexture(seed) };
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
    this.group.add(this.horizonTerrain);

    const waterGeometry = new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE, 1, 1);
    waterGeometry.rotateX(-Math.PI / 2);
    const waterMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x0c465d,
      // Water is a smooth dielectric, not a metal.  Most of the apparent
      // roughness comes from the animated normal field below.
      roughness: quality === "low" ? 0.14 : quality === "medium" ? 0.075 : 0.045,
      metalness: 0,
      ior: 1.333,
      specularIntensity: 1,
      clearcoat: quality === "low" ? 0.82 : 1,
      clearcoatRoughness: quality === "low" ? 0.1 : 0.035,
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
    const coniferMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
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
      new THREE.CylinderGeometry(0.48, 0.92, 11, 7),
      trunkMaterial,
      MAX_NEAR_TREES,
    );
    this.treeCanopies = new THREE.InstancedMesh(
      createBroadleafCanopyGeometry(),
      canopyMaterial,
      MAX_NEAR_TREES,
    );
    this.coniferCanopies = new THREE.InstancedMesh(
      createConiferCanopyGeometry(),
      coniferMaterial,
      MAX_NEAR_TREES,
    );
    this.farForest = new THREE.InstancedMesh(
      createFarTreeGeometry(),
      farTreeMaterial,
      MAX_FAR_TREES,
    );
    this.rocks = new THREE.InstancedMesh(
      new THREE.DodecahedronGeometry(1, 0),
      rockMaterial,
      MAX_ROCKS,
    );
    this.treeTrunks.castShadow = quality !== "low";
    this.treeCanopies.castShadow = quality !== "low";
    this.coniferCanopies.castShadow = quality !== "low";
    this.treeTrunks.receiveShadow = true;
    this.treeCanopies.receiveShadow = true;
    this.coniferCanopies.receiveShadow = true;
    this.farForest.castShadow = false;
    this.farForest.receiveShadow = false;
    this.rocks.castShadow = quality === "high";
    this.rocks.receiveShadow = true;
    for (const instances of [
      this.treeTrunks,
      this.treeCanopies,
      this.coniferCanopies,
      this.farForest,
      this.rocks,
    ]) {
      instances.count = 0;
      instances.frustumCulled = false;
      instances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    this.treeTrunks.name = "near-tree-trunks";
    this.treeCanopies.name = "near-tree-canopies";
    this.coniferCanopies.name = "near-conifer-canopies";
    this.farForest.name = "far-forest-lod";
    this.rocks.name = "scattered-rocks";
    this.group.add(
      this.farForest,
      this.treeTrunks,
      this.treeCanopies,
      this.coniferCanopies,
      this.rocks,
      this.groundCover.group,
    );

    this.createRunway();
    this.group.add(this.runwayGroup);
  }

  get tileCount(): number {
    return this.chunks.size;
  }

  update(worldX: number, worldZ: number, originX: number, originZ: number): void {
    if (this.disposed) return;
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
    if (centerChanged) {
      this.centerTileX = nextTileX;
      this.centerTileZ = nextTileZ;
      this.refreshChunks();
      this.treesDirty = true;
    } else {
      this.positionChunks();
    }
    if (originChanged) this.treesDirty = true;
    const now = performance.now();
    if (this.treesDirty && (originChanged || centerChanged || now >= this.nextTreeRefreshTime)) {
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

  setQuality(quality: "low" | "medium" | "high"): void {
    const nextResolution = quality === "high" ? 28 : quality === "medium" ? 22 : 16;
    const nextFarResolution = quality === "high" ? 23 : quality === "medium" ? 19 : 14;
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
    this.coniferCanopies.castShadow = castNearVegetationShadows;
    this.rocks.castShadow = quality === "high";
    this.groundCover.setQuality(quality);
    this.water.material.roughness = quality === "low" ? 0.14 : quality === "medium" ? 0.075 : 0.045;
    this.water.material.clearcoat = quality === "low" ? 0.82 : 1;
    this.water.material.clearcoatRoughness = quality === "low" ? 0.1 : 0.035;
    this.generationEpoch += 1;
    this.terrainGeneration.cancelAll();

    // If a previous quality transition is still loading, retain its complete
    // older terrain set instead of stacking an unbounded third generation.
    if (this.retiredChunks.size > 0) {
      for (const chunk of this.retiredChunks.values()) chunk.mesh.visible = true;
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
      chunk.mesh.visible = false;
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
      chunk.mesh.visible = !this.retiredChunks.has(key);
      this.chunks.set(key, chunk);
      this.requestChunk(chunk, priority);
    }
    this.positionChunks();
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

  private configureNearTerrainSurface(): void {
    this.material.onBeforeCompile = (shader) => this.enhanceTerrainShader(shader);
    this.material.customProgramCacheKey = () => "near-terrain-surface-v2";
  }

  private enhanceTerrainShader(shader: THREE.WebGLProgramParametersWithUniforms): void {
    shader.uniforms.terrainWorldOrigin = this.terrainWorldOrigin;
    shader.uniforms.terrainDetailMap = this.terrainDetailMap;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vTerrainWorldPosition;
        varying float vTerrainWorldSlope;
        uniform vec2 terrainWorldOrigin;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vec4 terrainScenePosition = modelMatrix * vec4(transformed, 1.0);
        vTerrainWorldPosition = terrainScenePosition.xyz;
        vTerrainWorldPosition.xz += terrainWorldOrigin;
        vTerrainWorldSlope = 1.0 - clamp(normalize(mat3(modelMatrix) * objectNormal).y, 0.0, 1.0);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vTerrainWorldPosition;
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
        float terrainMacro = terrainTextureDetail.r;
        float terrainDetail = terrainTextureDetail.g;
        float terrainGrain = terrainTextureDetail.b;
        float terrainPixelFootprint = max(
          length(dFdx(vTerrainWorldPosition.xz)),
          length(dFdy(vTerrainWorldPosition.xz))
        );
        float terrainDetailFade = 1.0 - smoothstep(7.0, 42.0, terrainPixelFootprint);
        float terrainGrainFade = 1.0 - smoothstep(1.5, 14.0, terrainPixelFootprint);
        float terrainPatchFade = 1.0 - smoothstep(15.0, 86.0, terrainPixelFootprint);
        float terrainMicroFade = 1.0 - smoothstep(0.55, 8.0, terrainPixelFootprint);
        float terrainAltitudeRock = smoothstep(520.0, 1450.0, vTerrainWorldPosition.y);
        float terrainRockMask = clamp(
          smoothstep(0.08, 0.52, vTerrainWorldSlope) * 0.76 + terrainAltitudeRock * 0.48,
          0.0,
          0.9
        );
        float terrainSnowMask = smoothstep(0.68, 0.86, max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b)));
        float terrainStrata = 0.5 + 0.5 * sin(
          vTerrainWorldPosition.y * 0.072 + terrainMacro * 6.0
        );
        float terrainBreakup =
          (terrainMacro - 0.5) * 0.16 +
          (terrainDetail - 0.5) * 0.105 * terrainDetailFade +
          (terrainGrain - 0.5) * 0.045 * terrainGrainFade;
        diffuseColor.rgb *= 1.0 + terrainBreakup * (1.0 - terrainSnowMask * 0.5);
        float terrainGreenAffinity = smoothstep(
          0.018,
          0.12,
          diffuseColor.g - max(diffuseColor.r * 0.96, diffuseColor.b)
        );
        float terrainVegetationMask = terrainGreenAffinity *
          (1.0 - terrainRockMask) * (1.0 - terrainSnowMask);
        float terrainMeadowMottle =
          (terrainPatchTexture.r - 0.5) * 0.2 +
          (terrainPatchTexture.g - 0.5) * 0.11;
        diffuseColor.rgb *= 1.0 +
          terrainMeadowMottle * terrainPatchFade * terrainVegetationMask;
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
        );`,
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
        const float terrainBroadNormalStrength = 0.36;
        const float terrainMicroNormalStrength = 0.9;
        normal = normalize(normal + mat3(viewMatrix) * vec3(
          -terrainBumpX * terrainBroadNormalStrength * terrainBumpFade -
            terrainMicroGradient.x * terrainMicroNormalStrength * terrainMicroFade *
              terrainVegetationMask,
          0.0,
          -terrainBumpZ * terrainBroadNormalStrength * terrainBumpFade -
            terrainMicroGradient.y * terrainMicroNormalStrength * terrainMicroFade *
              terrainVegetationMask
        ));`,
      );
  }

  private configureWaterMaterial(material: THREE.MeshPhysicalMaterial): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.waterTime = this.waterTime;
      shader.uniforms.waterWorldOrigin = this.waterWorldOrigin;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
          varying vec3 vWaterWorldPosition;
          uniform vec2 waterWorldOrigin;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          vWaterWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vWaterWorldPosition.xz += waterWorldOrigin;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          varying vec3 vWaterWorldPosition;
          uniform float waterTime;
          uniform vec2 waterWorldOrigin;
          const vec2 WATER_DIRECTION_A = vec2(0.91, 0.414);
          const vec2 WATER_DIRECTION_B = vec2(-0.545, 0.839);
          const vec2 WATER_DIRECTION_C = vec2(0.276, -0.961);
          const vec2 WATER_DIRECTION_D = vec2(-0.936, -0.352);
          const vec3 WATER_SUN_DIRECTION = vec3(0.401, 0.550, -0.728);
          vec2 waterDomainWarp(vec2 point, float time) {
            return vec2(
              sin(dot(point, vec2(-0.423, 0.906)) * 0.0051 + time * 0.16),
              sin(dot(point, vec2(0.719, 0.695)) * 0.0073 - time * 0.12)
            );
          }
          vec2 waterWaveGradient(
            float first,
            float second,
            float third,
            float fourth,
            float pixelFootprint
          ) {
            // Analytic filtering keeps sub-pixel ripples from aliasing as the
            // camera moves. The two balanced, crossed broad waves remain at
            // altitude; only the smaller surface detail fades. Cross-phase
            // modulation keeps either broad component from reading as a set
            // of perfectly parallel bands.
            float mediumWaveFade = 1.0 - smoothstep(4.0, 24.0, pixelFootprint);
            float fineWaveFade = 1.0 - smoothstep(1.0, 8.0, pixelFootprint);
            float capillaryWaveFade = 1.0 - smoothstep(0.35, 3.2, pixelFootprint);
            float broadWaveA = cos(first + sin(second * 0.47) * 0.24);
            float broadWaveB = cos(second + sin(first * 0.43) * 0.22);
            return
              WATER_DIRECTION_A * broadWaveA * 0.03 +
              WATER_DIRECTION_B * broadWaveB * 0.028 +
              WATER_DIRECTION_C * cos(third) * 0.016 * mediumWaveFade +
              WATER_DIRECTION_D * cos(fourth) * 0.007 * fineWaveFade * capillaryWaveFade;
          }`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          vec2 waterWarpSignal = waterDomainWarp(vWaterWorldPosition.xz, waterTime);
          vec2 waterWarpedPosition = vWaterWorldPosition.xz + vec2(
            waterWarpSignal.x * 15.0 + waterWarpSignal.y * 6.0,
            waterWarpSignal.y * 17.0 - waterWarpSignal.x * 5.0
          );
          float waterPhaseA =
            dot(waterWarpedPosition, WATER_DIRECTION_A) * 0.024 +
            waterTime * 0.32 + waterWarpSignal.y * 0.31;
          float waterPhaseB =
            dot(waterWarpedPosition, WATER_DIRECTION_B) * 0.028 -
            waterTime * 0.37 + waterWarpSignal.x * 0.27;
          float waterPhaseC =
            dot(waterWarpedPosition, WATER_DIRECTION_C) * 0.091 +
            waterTime * 0.68 + (waterWarpSignal.x + waterWarpSignal.y) * 0.16;
          float waterPhaseD =
            dot(waterWarpedPosition, WATER_DIRECTION_D) * 0.24 -
            waterTime * 0.93 + waterWarpSignal.y * 0.12;
          float waterPixelFootprint = max(
            length(dFdx(vWaterWorldPosition.xz)),
            length(dFdy(vWaterWorldPosition.xz))
          );
          vec2 waterSlope = waterWaveGradient(
            waterPhaseA,
            waterPhaseB,
            waterPhaseC,
            waterPhaseD,
            waterPixelFootprint
          );
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
          // an analytic reflection of the same sky palette as the scene. This
          // supplies a stable mirror image without a second scene render.
          float waterCosTheta = clamp(dot(waterViewToCamera, waterNormalWorld), 0.0, 1.0);
          float waterFresnel = 0.0204 + 0.9796 * pow(1.0 - waterCosTheta, 5.0);
          vec3 waterReflectionRay = normalize(
            reflect(-waterViewToCamera, waterNormalWorld)
          );
          float waterReflectionHeight = clamp(waterReflectionRay.y, 0.0, 1.0);
          vec3 waterHorizonReflection = vec3(0.56, 0.68, 0.70);
          vec3 waterZenithReflection = vec3(0.035, 0.27, 0.48);
          vec3 waterSkyReflection = mix(
            waterHorizonReflection,
            waterZenithReflection,
            pow(waterReflectionHeight, 0.48)
          );
          float waterSunAlignment = max(
            dot(waterReflectionRay, WATER_SUN_DIRECTION),
            0.0
          );
          float waterSunGlint = pow(waterSunAlignment, 420.0);
          float waterSunHalo = pow(waterSunAlignment, 42.0) * 0.12;
          waterSkyReflection += vec3(1.0, 0.86, 0.62) * (waterSunGlint * 1.4 + waterSunHalo);

          float waterLongWave = clamp(
            0.5 + waterWarpSignal.x * 0.1 + waterWarpSignal.y * 0.075,
            0.0,
            1.0
          );
          vec3 waterDeep = vec3(0.006, 0.07, 0.105) * (0.92 + waterLongWave * 0.12);
          float waterReflectionAmount = clamp(0.36 + waterFresnel * 0.64, 0.0, 1.0);
          diffuseColor.rgb = mix(
            waterDeep,
            waterSkyReflection,
            waterReflectionAmount
          );`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
          // Broader swells are glassy; crossed ripple crests spread the glint
          // slightly instead of producing hard, sparkling aliasing.
          float waterRippleCrossing = abs(cos(waterPhaseB) * cos(waterPhaseC));
          roughnessFactor = clamp(
            roughnessFactor + waterRippleCrossing * 0.018,
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
        );
    };
    material.customProgramCacheKey = () => "stable-water-mirror-ripples-v5";
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
    this.farMaterial.customProgramCacheKey = () => "far-terrain-near-grid-cutout-v2";
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
    };
    chunk.mesh.receiveShadow = true;
    chunk.mesh.castShadow = false;
    chunk.mesh.renderOrder = isFar ? -20 : -10;
    chunk.mesh.name = isFar ? "far-terrain-chunk" : "near-terrain-chunk";
    this.group.add(chunk.mesh);
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
    const centerX = (chunk.tileX + 0.5) * chunk.size;
    const centerZ = (chunk.tileZ + 0.5) * chunk.size;
    // A sampled placeholder is available synchronously and is dramatically
    // less distracting than the old perfectly flat far-grid slab while its
    // worker job is in flight.
    const terrain = this.sample(centerX, centerZ);
    terrainColor(terrain, this.tempColor);

    const positionAttribute = chunk.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const normalAttribute = chunk.mesh.geometry.getAttribute("normal") as THREE.BufferAttribute;
    const colorAttribute = chunk.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const positions = positionAttribute.array as Float32Array;
    const normals = normalAttribute.array as Float32Array;
    const colors = colorAttribute.array as Uint8Array;
    const red = Math.round(this.tempColor.r * 255);
    const green = Math.round(this.tempColor.g * 255);
    const blue = Math.round(this.tempColor.b * 255);

    for (let offset = 0; offset < positions.length; offset += 3) {
      positions[offset + 1] = terrain.height;
      normals[offset] = 0;
      normals[offset + 1] = 1;
      normals[offset + 2] = 0;
      colors[offset] = red;
      colors[offset + 1] = green;
      colors[offset + 2] = blue;
    }
    positionAttribute.needsUpdate = true;
    normalAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
    setTerrainBounds(chunk.mesh.geometry, chunk.size, terrain.height, terrain.height);
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
        chunk.mesh.visible = true;
        const retired = this.retiredChunks.get(key);
        if (retired) retired.mesh.visible = false;
        this.treesDirty = true;
        if (!chunk.isFar) this.groundCover.invalidate();
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
      positions[vertex * 3 + 1] = tile.heights[vertex] ?? 0;
    }
    normals.set(tile.normals.subarray(0, vertexCount * 3));
    colors.set(tile.colors.subarray(0, vertexCount * 3));
    positionAttribute.needsUpdate = true;
    normalAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
    setTerrainBounds(geometry, chunk.size, tile.minHeight, tile.maxHeight);
    return true;
  }

  private finishQualityTransitionWhenReady(): void {
    if (this.retiredChunks.size === 0) return;
    const expectedCount = (this.radius * 2 + 1) ** 2 + (FAR_TILE_RADIUS * 2 + 1) ** 2;
    if (this.chunks.size !== expectedCount) return;
    for (const chunk of this.chunks.values()) {
      if (!chunk.ready) return;
    }
    for (const chunk of this.retiredChunks.values()) this.disposeChunk(chunk);
    this.retiredChunks.clear();
  }

  private disposeChunk(chunk: TerrainChunk): void {
    if (chunk.requestId !== null) this.terrainGeneration.cancel(chunk.requestId);
    chunk.requestId = null;
    chunk.generation += 1;
    chunk.mesh.geometry.dispose();
    chunk.mesh.removeFromParent();
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
    let coniferCount = 0;
    let farCount = 0;
    let rockCount = 0;
    const nearLimit = this.quality === "high" ? MAX_NEAR_TREES : this.quality === "medium" ? 1_500 : 820;
    const farLimit = this.quality === "high" ? MAX_FAR_TREES : this.quality === "medium" ? 2_650 : 1_350;
    const rockLimit = this.quality === "high" ? MAX_ROCKS : this.quality === "medium" ? 260 : 120;
    const nearRadius = this.quality === "high" ? 5_100 : this.quality === "medium" ? 4_200 : 3_000;
    const worldCenterX = (this.centerTileX + 0.5) * this.tileSize;
    const worldCenterZ = (this.centerTileZ + 0.5) * this.tileSize;
    const visibleNearByKey = new Map<string, TerrainChunk>();
    const visibleFarByKey = new Map<string, TerrainChunk>();
    for (const [key, chunk] of this.retiredChunks) {
      if (!chunk.mesh.visible || !chunk.ready) continue;
      (chunk.isFar ? visibleFarByKey : visibleNearByKey).set(key, chunk);
    }
    for (const [key, chunk] of this.chunks) {
      if (!chunk.ready) continue;
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
          if (distanceSquared > nearRadius * nearRadius) continue;
          const localX = x - chunkStartX;
          const localZ = z - chunkStartZ;
          const height = this.sampleChunkHeight(chunk, localX, localZ);
          if (height < 4 || this.isInsideRunwayClearance(x, z)) continue;
          const slope = this.sampleChunkSlope(chunk, localX, localZ);

          // Exposed stone follows elevation and slope rather than appearing
          // only where a tree happened to pass its density test.
          const rockChance = hash01(cellZ, cellX, this.seed ^ 0xb09d);
          const rockThreshold = 0.975 - Math.min(0.065, slope * 0.12) -
            THREE.MathUtils.smoothstep(height, 380, 1_300) * 0.035;
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
            const scale = 0.62 + hash01(cellX, cellZ, this.seed ^ 991) * 0.72;
            this.tempQuaternion.setFromAxisAngle(
              this.upAxis,
              hash01(cellZ, cellX, this.seed ^ 31) * Math.PI * 2,
            );
            const breadth = 0.88 + hash01(cellZ, cellX, this.seed ^ 0x519) * 0.24;
            this.tempScale.set(scale * breadth, scale, scale / breadth);
            this.tempPosition.set(x - this.originX, height + 5.5 * scale, z - this.originZ);
            matrix.compose(this.tempPosition, this.tempQuaternion, this.tempScale);
            this.treeTrunks.setMatrixAt(trunkCount, matrix);
            this.tempColor.setHSL(
              0.075 + hash01(cellX, cellZ, this.seed ^ 0x713) * 0.025,
              0.32,
              0.19 + hash01(cellZ, cellX, this.seed ^ 0x317) * 0.08,
            );
            this.treeTrunks.setColorAt(trunkCount, this.tempColor);

            const tone = hash01(cellX, cellZ, this.seed ^ 0xc412);
            const coniferProbability = THREE.MathUtils.clamp(
              0.3 + height / 1_500 + (0.5 - forestPatch) * 0.22,
              0.22,
              0.82,
            );
            const isConifer = hash01(cellZ, cellX, this.seed ^ 0xa619) < coniferProbability;
            if (isConifer) {
              this.tempPosition.y = height + 7.7 * scale;
              matrix.compose(this.tempPosition, this.tempQuaternion, this.tempScale);
              this.coniferCanopies.setMatrixAt(coniferCount, matrix);
              this.tempColor.setHSL(
                0.32 + tone * 0.035,
                0.35 + tone * 0.12,
                0.155 + tone * 0.075,
              );
              this.coniferCanopies.setColorAt(coniferCount, this.tempColor);
              coniferCount += 1;
            } else {
              this.tempPosition.y = height + 15.2 * scale;
              matrix.compose(this.tempPosition, this.tempQuaternion, this.tempScale);
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
    const farMinimumSquared = (nearRadius * 0.72) ** 2;
    const farMaximumSquared = 18_000 ** 2;
    for (const chunk of visibleFar) {
      const chunkStartX = chunk.tileX * chunk.size;
      const chunkStartZ = chunk.tileZ * chunk.size;
      const minCellX = Math.floor(chunkStartX / FAR_TREE_CELL_SIZE);
      const maxCellX = Math.ceil((chunkStartX + chunk.size) / FAR_TREE_CELL_SIZE);
      const minCellZ = Math.floor(chunkStartZ / FAR_TREE_CELL_SIZE);
      const maxCellZ = Math.ceil((chunkStartZ + chunk.size) / FAR_TREE_CELL_SIZE);
      for (let cellZ = minCellZ; cellZ < maxCellZ && farCount < farLimit; cellZ += 1) {
        for (let cellX = minCellX; cellX < maxCellX && farCount < farLimit; cellX += 1) {
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
          if (distanceSquared < farMinimumSquared || distanceSquared > farMaximumSquared) continue;
          if (this.isInsideRunwayClearance(x, z)) continue;
          const localX = x - chunkStartX;
          const localZ = z - chunkStartZ;
          const height = this.sampleChunkHeight(chunk, localX, localZ);
          if (height < 5 || height > 1_320) continue;
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
          this.tempScale.set(7.4 * scale * widthVariation, 28 * scale, 7.4 * scale / widthVariation);
          matrix.compose(this.tempPosition, this.tempQuaternion, this.tempScale);
          this.farForest.setMatrixAt(farCount, matrix);
          const tone = hash01(cellX, cellZ, this.seed ^ 0x11b3);
          this.tempColor.setHSL(0.29 + tone * 0.04, 0.32 + tone * 0.1, 0.18 + tone * 0.09);
          this.farForest.setColorAt(farCount, this.tempColor);
          farCount += 1;
        }
      }
      if (farCount >= farLimit) break;
    }

    this.treeTrunks.count = trunkCount;
    this.treeCanopies.count = broadleafCount;
    this.coniferCanopies.count = coniferCount;
    this.farForest.count = farCount;
    this.rocks.count = rockCount;
    this.treeTrunks.instanceMatrix.needsUpdate = true;
    this.treeCanopies.instanceMatrix.needsUpdate = true;
    this.coniferCanopies.instanceMatrix.needsUpdate = true;
    this.farForest.instanceMatrix.needsUpdate = true;
    this.rocks.instanceMatrix.needsUpdate = true;
    if (this.treeTrunks.instanceColor) this.treeTrunks.instanceColor.needsUpdate = true;
    if (this.treeCanopies.instanceColor) this.treeCanopies.instanceColor.needsUpdate = true;
    if (this.coniferCanopies.instanceColor) this.coniferCanopies.instanceColor.needsUpdate = true;
    if (this.farForest.instanceColor) this.farForest.instanceColor.needsUpdate = true;
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
    const heightAt = (column: number, row: number) => positions[(row * side + column) * 3 + 1] ?? 0;
    const top = THREE.MathUtils.lerp(heightAt(x0, z0), heightAt(x1, z0), tx);
    const bottom = THREE.MathUtils.lerp(heightAt(x0, z1), heightAt(x1, z1), tx);
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

  private createRunway(): void {
    const centerX = this.runway?.centerX ?? 0;
    const centerZ = this.runway?.centerZ ?? 0;
    // The surface tracks the same elevation used by ground collision. A tiny
    // 25 mm render bias plus polygon offset prevents z-fighting without making
    // the aircraft look as though it hovers above an invisible runway.
    const terrainElevation = this.runway?.elevation ?? this.sample(centerX, centerZ).height;
    const runwayHeight = terrainElevation + 0.025;
    const runwayLength = this.runway?.runwayLength ?? 1_700;
    const runwayWidth = this.runway?.runwayWidth ?? 48;
    const asphalt = new THREE.MeshStandardMaterial({
      color: 0x2e3333,
      roughness: 0.98,
      // Terrain tiles are intentionally coarse relative to runway width, so
      // their interpolated triangles can locally cross the exact airport
      // elevation. Airport pavement is an ordered ground decal: it renders
      // after terrain, writes its real planar depth, then aircraft/objects draw
      // normally on top.
      depthFunc: THREE.AlwaysDepth,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const shoulderMaterial = new THREE.MeshStandardMaterial({
      color: 0x6b6556,
      roughness: 1,
      depthFunc: THREE.AlwaysDepth,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const taxiMaterial = new THREE.MeshStandardMaterial({
      color: 0x454a48,
      roughness: 0.98,
      depthFunc: THREE.AlwaysDepth,
      polygonOffset: true,
      polygonOffsetFactor: -1.5,
      polygonOffsetUnits: -1.5,
    });
    const paint = new THREE.MeshBasicMaterial({
      color: 0xece9d8,
      depthFunc: THREE.AlwaysDepth,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
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

    this.runwayGroup.rotation.y = this.runway?.headingRadians ?? Math.PI / 2;
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
    this.horizonTerrain.geometry.dispose();
    this.horizonMaterial.dispose();
    this.groundCover.dispose();
    (this.water.geometry as THREE.BufferGeometry).dispose();
    (this.water.material as THREE.Material).dispose();
    this.treeTrunks.geometry.dispose();
    this.treeCanopies.geometry.dispose();
    this.coniferCanopies.geometry.dispose();
    this.farForest.geometry.dispose();
    this.rocks.geometry.dispose();
    (this.treeTrunks.material as THREE.Material).dispose();
    (this.treeCanopies.material as THREE.Material).dispose();
    (this.coniferCanopies.material as THREE.Material).dispose();
    (this.farForest.material as THREE.Material).dispose();
    (this.rocks.material as THREE.Material).dispose();
    this.runwayGroup.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.geometry.dispose();
      if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose());
      else child.material.dispose();
    });
  }
}
