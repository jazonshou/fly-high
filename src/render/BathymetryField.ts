import * as THREE from "three";

// 64 m texels preserve coves and shoreline shelves without turning the field
// into a full terrain render target. The 512 m recenter remains an exact
// eight-texel translation, so overlapping samples cannot swim between frames.
export const BATHYMETRY_RESOLUTION = 192;
export const BATHYMETRY_SPAN = 12_288;
export const BATHYMETRY_CENTER_SNAP = 512;
export const BATHYMETRY_MAX_DEPTH = 192;
export const BATHYMETRY_STREAM_UPDATE_INTERVAL_MS = 700;

export interface WaterBathymetrySource {
  readonly texture: THREE.DataTexture;
  /** Shared tileable linear-space surface detail; owned by TerrainRenderer. */
  readonly surfaceDetailTexture: THREE.Texture | undefined;
  /** Absolute-world minX, minZ, maxX, maxZ. */
  readonly bounds: THREE.Vector4;
  readonly maxDepth: number;
  readonly resolution: number;
  isValid(): boolean;
  getRevision(): number;
}

export interface BathymetryUpdate {
  worldX: number;
  worldZ: number;
  sourceRevision: number;
  nowMs: number;
  force?: boolean;
}

export interface BathymetryDiagnostics {
  readonly updates: number;
  readonly samplesPerUpdate: number;
  readonly textureBytes: number;
  readonly centerX: number;
  readonly centerZ: number;
  readonly sourceRevision: number;
  readonly valid: boolean;
}

export function snapBathymetryCenter(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const snapped = Math.round(value / BATHYMETRY_CENTER_SNAP) * BATHYMETRY_CENTER_SNAP;
  return snapped === 0 ? 0 : snapped;
}

/** Linear R8 keeps hardware bilinear filtering physically meaningful. */
export function encodeBathymetryDepth(depth: number): number {
  const safeDepth = Number.isFinite(depth)
    ? THREE.MathUtils.clamp(depth, 0, BATHYMETRY_MAX_DEPTH)
    : 0;
  return Math.round((safeDepth / BATHYMETRY_MAX_DEPTH) * 255);
}

export function decodeBathymetryDepth(encoded: number): number {
  const normalized = THREE.MathUtils.clamp(
    Number.isFinite(encoded) ? encoded / 255 : 0,
    0,
    1,
  );
  return normalized * BATHYMETRY_MAX_DEPTH;
}

/**
 * A tiny camera-following field containing true terrain depth below the opaque
 * ocean. Updates are event-driven; `sampleHeight` should normally read the
 * already-loaded render grid rather than invoke a full terrain kernel.
 */
export class BathymetryField implements WaterBathymetrySource {
  readonly bounds = new THREE.Vector4();
  readonly maxDepth = BATHYMETRY_MAX_DEPTH;
  readonly resolution = BATHYMETRY_RESOLUTION;
  readonly texture: THREE.DataTexture;

  private readonly data = new Uint8Array(
    BATHYMETRY_RESOLUTION * BATHYMETRY_RESOLUTION,
  );
  private centerX = Number.NaN;
  private centerZ = Number.NaN;
  private sampledSourceRevision = -1;
  private nextStreamUpdateMs = 0;
  private updateCount = 0;
  private contentHash = 0;
  private valid = false;
  private disposed = false;

  constructor(
    private readonly waterLevel: number,
    readonly surfaceDetailTexture: THREE.Texture | undefined = undefined,
  ) {
    this.texture = new THREE.DataTexture(
      this.data,
      BATHYMETRY_RESOLUTION,
      BATHYMETRY_RESOLUTION,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.texture.name = "terrain-bathymetry-depth";
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.flipY = false;
    this.texture.unpackAlignment = 1;
  }

  isValid(): boolean {
    return this.valid && !this.disposed;
  }

  getRevision(): number {
    return this.updateCount;
  }

  update(
    input: BathymetryUpdate,
    sampleHeight: (worldX: number, worldZ: number) => number | undefined,
  ): boolean {
    if (this.disposed) return false;
    const nextCenterX = snapBathymetryCenter(input.worldX);
    const nextCenterZ = snapBathymetryCenter(input.worldZ);
    const centerChanged =
      nextCenterX !== this.centerX || nextCenterZ !== this.centerZ;
    const revisionChanged = input.sourceRevision !== this.sampledSourceRevision;
    if (!input.force && !centerChanged && !revisionChanged) return false;
    const safeNow = Number.isFinite(input.nowMs) ? Math.max(0, input.nowMs) : 0;
    if (!input.force && !centerChanged && safeNow < this.nextStreamUpdateMs) {
      return false;
    }

    const halfSpan = BATHYMETRY_SPAN * 0.5;
    const minimumX = nextCenterX - halfSpan;
    const minimumZ = nextCenterZ - halfSpan;
    // Bounds describe texture edges. Sampling cell centers gives an exact
    // 64 m lattice, so each 512 m recenter reuses overlap at an eight-texel
    // integer shift with no phase swim.
    const spacing = BATHYMETRY_SPAN / BATHYMETRY_RESOLUTION;
    let nextHash = 0x811c9dc5;
    for (let row = 0; row < BATHYMETRY_RESOLUTION; row += 1) {
      const worldZ = minimumZ + (row + 0.5) * spacing;
      for (let column = 0; column < BATHYMETRY_RESOLUTION; column += 1) {
        const worldX = minimumX + (column + 0.5) * spacing;
        const terrainHeight = sampleHeight(worldX, worldZ);
        const depth = terrainHeight === undefined || !Number.isFinite(terrainHeight)
          ? BATHYMETRY_MAX_DEPTH
          : Math.max(0, this.waterLevel - terrainHeight);
        const encoded = encodeBathymetryDepth(depth);
        this.data[row * BATHYMETRY_RESOLUTION + column] = encoded;
        nextHash = Math.imul(nextHash ^ encoded, 0x01000193) >>> 0;
      }
    }

    const contentChanged = nextHash !== this.contentHash;
    if (!centerChanged && this.valid && !contentChanged) {
      this.sampledSourceRevision = input.sourceRevision;
      this.nextStreamUpdateMs = safeNow + BATHYMETRY_STREAM_UPDATE_INTERVAL_MS;
      return false;
    }

    this.centerX = nextCenterX;
    this.centerZ = nextCenterZ;
    this.sampledSourceRevision = input.sourceRevision;
    this.nextStreamUpdateMs = safeNow + BATHYMETRY_STREAM_UPDATE_INTERVAL_MS;
    this.bounds.set(
      minimumX,
      minimumZ,
      minimumX + BATHYMETRY_SPAN,
      minimumZ + BATHYMETRY_SPAN,
    );
    if (contentChanged || !this.valid) this.texture.needsUpdate = true;
    this.contentHash = nextHash;
    this.valid = true;
    this.updateCount += 1;
    return true;
  }

  getDiagnostics(): BathymetryDiagnostics {
    return {
      updates: this.updateCount,
      samplesPerUpdate: this.data.length,
      textureBytes: this.data.byteLength,
      centerX: this.centerX,
      centerZ: this.centerZ,
      sourceRevision: this.sampledSourceRevision,
      valid: this.isValid(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.valid = false;
    this.texture.dispose();
  }
}
