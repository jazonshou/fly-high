import * as THREE from "three";

export interface GroundCoverSurface {
  height: number;
  /** Zero is level ground; values approaching one are increasingly steep. */
  slope: number;
}

export type GroundCoverSurfaceSampler = (
  worldX: number,
  worldZ: number,
) => GroundCoverSurface | undefined;

export type GroundCoverClearanceTest = (worldX: number, worldZ: number) => boolean;

type GroundCoverQuality = "low" | "medium" | "high";

interface GroundCoverBudget {
  radius: number;
  cellSize: number;
  grassLimit: number;
  plantLimit: number;
  density: number;
}

const QUALITY_BUDGETS: Readonly<Record<GroundCoverQuality, GroundCoverBudget>> = {
  low: { radius: 360, cellSize: 14, grassLimit: 620, plantLimit: 110, density: 0.25 },
  medium: { radius: 540, cellSize: 8, grassLimit: 4_200, plantLimit: 700, density: 0.28 },
  high: { radius: 740, cellSize: 7, grassLimit: 9_800, plantLimit: 1_400, density: 0.27 },
};

const MAX_GRASS_INSTANCES = QUALITY_BUDGETS.high.grassLimit;
const MAX_PLANT_INSTANCES = QUALITY_BUDGETS.high.plantLimit;
const CENTER_SNAP = 120;

function hash01(x: number, z: number, seed: number): number {
  let value = Math.imul(x ^ seed, 0x45d9f3b) ^ Math.imul(z, 0x27d4eb2d);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

/**
 * Several tapered, crossed blades form one draw-efficient grass patch. Each
 * instance covers a few square metres, avoiding both a carpet of billboards
 * and the draw-call cost of modelling individual blades.
 */
function createGrassPatchGeometry(): THREE.BufferGeometry {
  const bladeCount = 17;
  const positions = new Float32Array(bladeCount * 9);
  const colors = new Float32Array(bladeCount * 9);
  for (let blade = 0; blade < bladeCount; blade += 1) {
    const angle = blade * 2.399963 + (blade % 3) * 0.27;
    const radius = blade === 0 ? 0 : 0.5 + ((blade * 0.413) % 1) * 1.9;
    const centerX = Math.cos(angle * 1.71) * radius;
    const centerZ = Math.sin(angle * 1.71) * radius;
    const halfWidth = 0.085 + (blade % 4) * 0.025;
    const height = 0.48 + ((blade * 0.347) % 1) * 0.7;
    const directionX = Math.cos(angle);
    const directionZ = Math.sin(angle);
    const offset = blade * 9;
    positions[offset] = centerX - directionX * halfWidth;
    positions[offset + 1] = -0.035;
    positions[offset + 2] = centerZ - directionZ * halfWidth;
    positions[offset + 3] = centerX + directionX * halfWidth;
    positions[offset + 4] = -0.035;
    positions[offset + 5] = centerZ + directionZ * halfWidth;
    positions[offset + 6] = centerX + directionZ * height * 0.12;
    positions[offset + 7] = height;
    positions[offset + 8] = centerZ - directionX * height * 0.12;

    // Dark roots keep the patches visually planted; varied tips break up the
    // flat green that previously made the surface read as a blurry texture.
    colors.set([0.42, 0.5, 0.24, 0.42, 0.5, 0.24, 0.82, 0.91, 0.5], offset);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Small radial leaves provide a second silhouette among the fine grass. */
function createHerbGeometry(): THREE.BufferGeometry {
  const leafCount = 7;
  const positions = new Float32Array(leafCount * 18);
  const colors = new Float32Array(leafCount * 18);
  for (let leaf = 0; leaf < leafCount; leaf += 1) {
    const angle = (leaf / leafCount) * Math.PI * 2;
    const directionX = Math.cos(angle);
    const directionZ = Math.sin(angle);
    const sideX = -directionZ;
    const sideZ = directionX;
    const length = 0.95 + (leaf % 3) * 0.22;
    const halfWidth = 0.22 + (leaf % 2) * 0.05;
    const tipX = directionX * length;
    const tipZ = directionZ * length;
    const midX = directionX * length * 0.54;
    const midZ = directionZ * length * 0.54;
    const height = 0.3 + (leaf % 3) * 0.1;
    const offset = leaf * 18;
    positions.set(
      [
        0, 0, 0,
        midX + sideX * halfWidth, height, midZ + sideZ * halfWidth,
        tipX, 0.08, tipZ,
        0, 0, 0,
        tipX, 0.08, tipZ,
        midX - sideX * halfWidth, height, midZ - sideZ * halfWidth,
      ],
      offset,
    );
    colors.set(
      [
        0.25, 0.36, 0.16,
        0.56, 0.68, 0.31,
        0.4, 0.55, 0.22,
        0.25, 0.36, 0.16,
        0.4, 0.55, 0.22,
        0.56, 0.68, 0.31,
      ],
      offset,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Camera-local, deterministic ground cover. The placements are keyed to world
 * cells, so rebuilding the bounded instance set never makes plants slide with
 * the aircraft or with floating-origin rebases.
 */
export class GroundCoverRenderer {
  readonly group = new THREE.Group();

  private readonly grass: THREE.InstancedMesh;
  private readonly herbs: THREE.InstancedMesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly upAxis = new THREE.Vector3(0, 1, 0);
  private quality: GroundCoverQuality;
  private dirty = true;
  private lastCenterX = Number.NaN;
  private lastCenterZ = Number.NaN;
  private lastOriginX = Number.NaN;
  private lastOriginZ = Number.NaN;
  private nextRefreshTime = 0;

  constructor(
    private readonly seed: number,
    quality: GroundCoverQuality,
    private readonly sampleSurface: GroundCoverSurfaceSampler,
    private readonly isInsideClearance: GroundCoverClearanceTest,
  ) {
    this.quality = quality;
    this.group.name = "procedural-ground-cover";

    const grassMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.96,
      metalness: 0,
      side: THREE.DoubleSide,
      dithering: true,
    });
    const herbMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.91,
      metalness: 0,
      side: THREE.DoubleSide,
      dithering: true,
    });
    this.grass = new THREE.InstancedMesh(
      createGrassPatchGeometry(),
      grassMaterial,
      MAX_GRASS_INSTANCES,
    );
    this.herbs = new THREE.InstancedMesh(
      createHerbGeometry(),
      herbMaterial,
      MAX_PLANT_INSTANCES,
    );
    this.grass.name = "instanced-grass-patches";
    this.herbs.name = "instanced-low-herbs";
    for (const mesh of [this.grass, this.herbs]) {
      mesh.count = 0;
      // Matrices describe a moving bounded set, so a stale automatically
      // computed instanced bound would incorrectly cull the entire patch.
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
    }
  }

  invalidate(): void {
    this.dirty = true;
  }

  setQuality(quality: GroundCoverQuality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.dirty = true;
    this.nextRefreshTime = 0;
  }

  update(worldX: number, worldZ: number, originX: number, originZ: number): void {
    const centerX = Math.round(worldX / CENTER_SNAP) * CENTER_SNAP;
    const centerZ = Math.round(worldZ / CENTER_SNAP) * CENTER_SNAP;
    const originChanged = originX !== this.lastOriginX || originZ !== this.lastOriginZ;
    if (centerX !== this.lastCenterX || centerZ !== this.lastCenterZ || originChanged) {
      this.lastCenterX = centerX;
      this.lastCenterZ = centerZ;
      this.lastOriginX = originX;
      this.lastOriginZ = originZ;
      this.dirty = true;
    }
    if (!this.dirty || performance.now() < this.nextRefreshTime) return;
    this.rebuild(centerX, centerZ, originX, originZ);
    this.dirty = false;
    this.nextRefreshTime = performance.now() + 140;
  }

  private rebuild(centerX: number, centerZ: number, originX: number, originZ: number): void {
    const budget = QUALITY_BUDGETS[this.quality];
    const minimumCellX = Math.floor((centerX - budget.radius) / budget.cellSize);
    const maximumCellX = Math.ceil((centerX + budget.radius) / budget.cellSize);
    const minimumCellZ = Math.floor((centerZ - budget.radius) / budget.cellSize);
    const maximumCellZ = Math.ceil((centerZ + budget.radius) / budget.cellSize);
    const radiusSquared = budget.radius * budget.radius;
    let grassCount = 0;
    let herbCount = 0;

    outer: for (let cellZ = minimumCellZ; cellZ <= maximumCellZ; cellZ += 1) {
      for (let cellX = minimumCellX; cellX <= maximumCellX; cellX += 1) {
        const jitterX = 0.08 + hash01(cellX, cellZ, this.seed ^ 0x782d) * 0.84;
        const jitterZ = 0.08 + hash01(cellZ, cellX, this.seed ^ 0x9a31) * 0.84;
        const x = (cellX + jitterX) * budget.cellSize;
        const z = (cellZ + jitterZ) * budget.cellSize;
        if ((x - centerX) ** 2 + (z - centerZ) ** 2 > radiusSquared) continue;
        if (hash01(cellX, cellZ, this.seed ^ 0xc139) > budget.density) continue;
        if (this.isInsideClearance(x, z)) continue;
        const surface = this.sampleSurface(x, z);
        if (!surface || surface.height <= 3.5 || surface.height >= 1_230 || surface.slope > 0.205) {
          continue;
        }

        const altitudeFade = 1 - THREE.MathUtils.smoothstep(surface.height, 790, 1_230);
        if (hash01(cellZ, cellX, this.seed ^ 0x5f17) > 0.4 + altitudeFade * 0.6) continue;
        const size = 0.82 + hash01(cellX, cellZ, this.seed ^ 0xb431) * 0.62;
        this.position.set(x - originX, surface.height + 0.025, z - originZ);
        this.rotation.setFromAxisAngle(
          this.upAxis,
          hash01(cellZ, cellX, this.seed ^ 0xd713) * Math.PI * 2,
        );
        this.scale.set(size, 0.74 + size * 0.3, size);
        this.matrix.compose(this.position, this.rotation, this.scale);
        this.grass.setMatrixAt(grassCount, this.matrix);
        const grassTone = hash01(cellX, cellZ, this.seed ^ 0x43bd);
        this.color.setHSL(
          0.205 + grassTone * 0.085,
          0.34 + grassTone * 0.18,
          0.25 + grassTone * 0.105,
        );
        this.grass.setColorAt(grassCount, this.color);
        grassCount += 1;

        const herbChance = hash01(cellZ, cellX, this.seed ^ 0x2d97);
        if (herbCount < budget.plantLimit && herbChance > 0.83) {
          const herbScale = 0.7 + hash01(cellX, cellZ, this.seed ^ 0x9163) * 0.62;
          this.position.y = surface.height + 0.018;
          this.rotation.setFromAxisAngle(
            this.upAxis,
            hash01(cellX, cellZ, this.seed ^ 0x1f27) * Math.PI * 2,
          );
          this.scale.setScalar(herbScale);
          this.matrix.compose(this.position, this.rotation, this.scale);
          this.herbs.setMatrixAt(herbCount, this.matrix);
          this.color.setHSL(
            0.235 + herbChance * 0.04,
            0.38 + herbChance * 0.16,
            0.26 + herbChance * 0.08,
          );
          this.herbs.setColorAt(herbCount, this.color);
          herbCount += 1;
        }
        if (grassCount >= budget.grassLimit) break outer;
      }
    }

    this.grass.count = grassCount;
    this.herbs.count = herbCount;
    this.grass.instanceMatrix.needsUpdate = true;
    this.herbs.instanceMatrix.needsUpdate = true;
    if (this.grass.instanceColor) this.grass.instanceColor.needsUpdate = true;
    if (this.herbs.instanceColor) this.herbs.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.grass.geometry.dispose();
    this.herbs.geometry.dispose();
    (this.grass.material as THREE.Material).dispose();
    (this.herbs.material as THREE.Material).dispose();
  }
}
