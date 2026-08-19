/**
 * 2-11a — the compact 32-byte vegetation instance record.
 *
 * INVARIANT THIS FILE OWNS: the byte layout below is the ONE instance
 * format every detail batch uploads and `DetailInstanceMaterialPlugin`
 * decodes. 96-byte matrix instancing is gone; the world transform is built
 * in the vertex stage from these fields (R-20 proved the mechanism
 * on-adapter, `tests/gpu/instance-format-spike.test.ts`).
 *
 * Layout (32 bytes, grouped into WebGPU-legal vertex formats — the plan's
 * §3.5 table regrouped because a lone f16 is not a vertex format; the spare
 * byte was spent upgrading `radialScale` to unorm16, recorded deviation):
 *
 * | Offset | Attribute             | Format     | Meaning                              |
 * |--------|-----------------------|------------|--------------------------------------|
 * | 0      | `instancePosition`    | float32x3  | cell-local metres                    |
 * | 12     | `instanceOrientation` | snorm16x4  | full rotation quaternion (`2-15`)    |
 * | 20     | `instanceScale`       | unorm16x2  | height over [0, 48] m; radial over [0.5, 1.6] (fraction of height) |
 * | 24     | `instanceTint`        | unorm8x4   | per-instance colour (`2-12` fills)   |
 * | 28     | `instanceState`       | unorm8x4   | fade (`2-14`/`2-17`), variant index, wind phase (turns), wind response |
 *
 * Class P: no Babylon imports, Node-tested byte-for-byte.
 */

export const DETAIL_INSTANCE_STRIDE_BYTES = 32;

export const DETAIL_INSTANCE_HEIGHT_MAX_METERS = 48;
export const DETAIL_INSTANCE_RADIAL_MIN = 0.5;
export const DETAIL_INSTANCE_RADIAL_MAX = 1.6;

/** The attribute table the runtime's vertex buffers and the plugin share. */
export const DETAIL_INSTANCE_ATTRIBUTES = Object.freeze([
  Object.freeze({ kind: "instancePosition", byteOffset: 0, size: 3, type: "float", normalized: false }),
  Object.freeze({ kind: "instanceOrientation", byteOffset: 12, size: 4, type: "snorm16", normalized: true }),
  Object.freeze({ kind: "instanceScale", byteOffset: 20, size: 2, type: "unorm16", normalized: true }),
  Object.freeze({ kind: "instanceTint", byteOffset: 24, size: 4, type: "unorm8", normalized: true }),
  Object.freeze({ kind: "instanceState", byteOffset: 28, size: 4, type: "unorm8", normalized: true }),
] as const);

export interface DetailInstanceRecord {
  /** Cell-local position, metres. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Unit quaternion (x, y, z, w). */
  readonly quaternion: readonly [number, number, number, number];
  /** World height of the instance, metres (0..48). */
  readonly heightScaleMeters: number;
  /** Radius as a fraction of height, decoded over [0.5, 1.6]. */
  readonly radialScale: number;
  /** LOD crossfade / cull fade, 0..1. */
  readonly fade: number;
  /** Crown/rock variant index, 0..255 (high bits: 2-12 character modifiers). */
  readonly variant: number;
  /** Linear RGBA tint, 0..1 per channel. */
  readonly tint: readonly [number, number, number, number];
  /** Wind phase in TURNS (0..1 wraps 2π). */
  readonly windPhase: number;
  /** Wind response, 0..1. */
  readonly windResponse: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function snorm16(value: number): number {
  return Math.round(Math.min(1, Math.max(-1, value)) * 32_767);
}

function unorm16(value: number): number {
  return Math.round(clamp01(value) * 65_535);
}

function unorm8(value: number): number {
  return Math.round(clamp01(value) * 255);
}

/** Quaternion for a pure yaw rotation — the pre-`2-15` call-site helper. */
export function yawQuaternion(yawRadians: number): [number, number, number, number] {
  const half = yawRadians / 2;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

/**
 * Pooled instance writer: pushes 32-byte records into a growable buffer and
 * hands back the exact packed byte range. `reset()` reuses the allocation —
 * the plan's "build into a pooled buffer" requirement.
 */
export class DetailInstanceWriter {
  private buffer: ArrayBuffer;
  private view: DataView;
  private countValue = 0;

  constructor(initialCapacityInstances = 256) {
    this.buffer = new ArrayBuffer(
      Math.max(1, initialCapacityInstances) * DETAIL_INSTANCE_STRIDE_BYTES,
    );
    this.view = new DataView(this.buffer);
  }

  get count(): number {
    return this.countValue;
  }

  reset(): void {
    this.countValue = 0;
  }

  push(record: DetailInstanceRecord): void {
    const offset = this.countValue * DETAIL_INSTANCE_STRIDE_BYTES;
    if (offset + DETAIL_INSTANCE_STRIDE_BYTES > this.buffer.byteLength) {
      const grown = new ArrayBuffer(this.buffer.byteLength * 2);
      new Uint8Array(grown).set(new Uint8Array(this.buffer));
      this.buffer = grown;
      this.view = new DataView(this.buffer);
    }
    const view = this.view;
    view.setFloat32(offset, record.x, true);
    view.setFloat32(offset + 4, record.y, true);
    view.setFloat32(offset + 8, record.z, true);
    view.setInt16(offset + 12, snorm16(record.quaternion[0]), true);
    view.setInt16(offset + 14, snorm16(record.quaternion[1]), true);
    view.setInt16(offset + 16, snorm16(record.quaternion[2]), true);
    view.setInt16(offset + 18, snorm16(record.quaternion[3]), true);
    view.setUint16(
      offset + 20,
      unorm16(record.heightScaleMeters / DETAIL_INSTANCE_HEIGHT_MAX_METERS),
      true,
    );
    view.setUint16(
      offset + 22,
      unorm16(
        (record.radialScale - DETAIL_INSTANCE_RADIAL_MIN)
          / (DETAIL_INSTANCE_RADIAL_MAX - DETAIL_INSTANCE_RADIAL_MIN),
      ),
      true,
    );
    view.setUint8(offset + 24, unorm8(record.tint[0]));
    view.setUint8(offset + 25, unorm8(record.tint[1]));
    view.setUint8(offset + 26, unorm8(record.tint[2]));
    view.setUint8(offset + 27, unorm8(record.tint[3]));
    view.setUint8(offset + 28, unorm8(record.fade));
    view.setUint8(offset + 29, Math.min(255, Math.max(0, Math.round(record.variant))));
    view.setUint8(offset + 30, unorm8(record.windPhase % 1));
    view.setUint8(offset + 31, unorm8(record.windResponse));
    this.countValue += 1;
  }

  /** The packed bytes for exactly the pushed records (a view, not a copy). */
  finish(): Uint8Array {
    return new Uint8Array(this.buffer, 0, this.countValue * DETAIL_INSTANCE_STRIDE_BYTES);
  }
}

/**
 * Generator-side AABB (the plan's named cost): with no CPU matrix buffer,
 * `thinInstanceRefreshBoundingInfo` has no input, so the generator — which
 * knows every position and extent — accumulates bounds itself, with the wind
 * sway as an EXPLICIT term instead of the old `scale(1.01)` fudge.
 */
export class DetailInstanceBounds {
  private minX = Number.POSITIVE_INFINITY;
  private minY = Number.POSITIVE_INFINITY;
  private minZ = Number.POSITIVE_INFINITY;
  private maxX = Number.NEGATIVE_INFINITY;
  private maxY = Number.NEGATIVE_INFINITY;
  private maxZ = Number.NEGATIVE_INFINITY;

  reset(): void {
    this.minX = Number.POSITIVE_INFINITY;
    this.minY = Number.POSITIVE_INFINITY;
    this.minZ = Number.POSITIVE_INFINITY;
    this.maxX = Number.NEGATIVE_INFINITY;
    this.maxY = Number.NEGATIVE_INFINITY;
    this.maxZ = Number.NEGATIVE_INFINITY;
  }

  get isEmpty(): boolean {
    return this.minX > this.maxX;
  }

  add(record: DetailInstanceRecord, windSwayMeters: number): void {
    const radius = record.heightScaleMeters
      * Math.max(record.radialScale, 1)
      + windSwayMeters;
    this.minX = Math.min(this.minX, record.x - radius);
    this.maxX = Math.max(this.maxX, record.x + radius);
    this.minZ = Math.min(this.minZ, record.z - radius);
    this.maxZ = Math.max(this.maxZ, record.z + radius);
    this.minY = Math.min(this.minY, record.y - windSwayMeters);
    this.maxY = Math.max(this.maxY, record.y + record.heightScaleMeters + windSwayMeters);
  }

  minimum(): [number, number, number] {
    return [this.minX, this.minY, this.minZ];
  }

  maximum(): [number, number, number] {
    return [this.maxX, this.maxY, this.maxZ];
  }
}
