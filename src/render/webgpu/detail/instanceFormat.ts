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
 * | 20     | `instanceScale`       | unorm16x2  | height over [0, 48] m; prototype radial multiplier over [0, 4] |
 * | 24     | `instanceTint`        | unorm8x4   | per-instance colour (`2-12` fills)   |
 * | 28     | `instanceState`       | unorm8x4   | fade (`2-14`/`2-17`), variant index, wind phase (turns), wind response |
 *
 * Class P: no Babylon imports, Node-tested byte-for-byte.
 */

export const DETAIL_INSTANCE_STRIDE_BYTES = 32;

export const DETAIL_INSTANCE_HEIGHT_MAX_METERS = 48;
export const DETAIL_INSTANCE_RADIAL_MIN = 0;
export const DETAIL_INSTANCE_RADIAL_MAX = 4;

/**
 * Conservative maximum displacement of the three foliage-wind bands, as a
 * fraction of decoded instance height. The shader's independent trunk,
 * branch and flutter terms sum to < 0.147 at maximum strength/gust; 0.15
 * keeps the CPU culling bound safely outside that envelope.
 */
export const DETAIL_INSTANCE_WIND_PADDING_RATIO = 0.15;

/**
 * The scramble every decorrelation consumer of the phase lane reads through
 * — the reveal-order hash the shader always used, promoted to THE per-stem
 * hash (2026-09-13). Tree records carry their canopy key in the lane, and
 * the drawn population is a key prefix, so without a scramble the drawn
 * forest would sway in phase and the hashed mid/far switch would collapse
 * to a ring. The TS form exists for the CPU bound kernel, which must decode
 * the modifier-1 lean exactly as the shader does; 256 lane codes map to 256
 * distinct phases through it.
 */
export function detailStemHash(lane: number): number {
  const scrambled = lane * 157.31 + 0.371;
  return scrambled - Math.floor(scrambled);
}

/** Authored, unscaled prototype-space AABB. */
export interface DetailPrototypeBounds {
  readonly minimum: readonly [number, number, number];
  readonly maximum: readonly [number, number, number];
  /**
   * Optional normalized-y anchor toward which a shader may contract the
   * prototype. Its zero-xz point joins the pre-rotation envelope.
   */
  readonly contractionPivotYUnit?: number;
}

/**
 * Prototype-only terms used by the hot instance-bound accumulator.
 *
 * A prototype is registered once and may receive tens of thousands of
 * records during an observer rebuild. Selecting the furthest un-sheared box
 * endpoint is therefore registration work, not per-record work. The original
 * bounds remain embedded because character modifier 1 still needs all four
 * sheared XY corners.
 */
export interface DetailPrototypeBoundKernel {
  readonly prototype: DetailPrototypeBounds;
  readonly extremeXUnit: number;
  readonly extremeYUnit: number;
  readonly extremeZUnit: number;
}

/** Builds the immutable, prototype-owned kernel consumed by fused packing. */
export function detailPrototypeBoundKernel(
  prototype: DetailPrototypeBounds,
): DetailPrototypeBoundKernel {
  const furthest = (minimum: number, maximum: number): number =>
    Math.abs(minimum) >= Math.abs(maximum) ? minimum : maximum;
  return Object.freeze({
    prototype,
    extremeXUnit: furthest(prototype.minimum[0], prototype.maximum[0]),
    extremeYUnit: furthest(prototype.minimum[1], prototype.maximum[1]),
    extremeZUnit: furthest(prototype.minimum[2], prototype.maximum[2]),
  });
}

/** Camera-facing far-impostor frame, in unit-height prototype space. */
export interface DetailBillboardFrameBounds {
  readonly extentUnit: number;
  readonly centerYUnit: number;
}

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
  /**
   * Multiplier applied to the prototype's authored X/Z coordinates after
   * height scaling, decoded over [0, 4]. The single scale convention is:
   *
   *   worldRadius = prototypeRadiusUnit * heightMeters * radialScale
   *
   * Callers targeting a world-space radius must use
   * `detailRadialScaleForWorldRadius`; the shader must not multiply a second
   * per-material aspect into this lane.
   */
  readonly radialScale: number;
  /** LOD crossfade / cull fade, 0..1 (127 usable levels — see fade byte). */
  readonly fade: number;
  /**
   * 2-14: fade DIRECTION. An outgoing instance survives `bayer < fade`; an
   * incoming one survives `bayer >= 1 - fade` — with the same per-stem hash
   * on both sides these are EXACT complements, so a crossfading stem covers
   * every pixel exactly once (statistical complements double-draw the whole
   * canopy at fade 0.5). Encoded as the fade byte's low bit.
   */
  readonly fadeIncoming?: boolean;
  /** Crown/rock variant index, 0..255 (high bits: 2-12 character modifiers). */
  readonly variant: number;
  /** Linear RGBA tint, 0..1 per channel. */
  readonly tint: readonly [number, number, number, number];
  /**
   * A stable per-instance uniform in [0, 1). Historically the wind phase in
   * TURNS; since 2026-09-13 the shader reads every decorrelation consumer
   * (wind phase, lean, silhouette wobble, the mid/far switch hash, reveal
   * order) through `detailStemHash` of this lane, and TREE records carry
   * their density-normalised canopy KEY here instead of a random phase — the
   * per-stem LOD threshold the band windows compare against the live share.
   * The drawn subset of a cell is a rank prefix, so the raw lane would sway
   * every drawn tree in phase; the scramble is what keeps it a phase.
   */
  readonly windPhase: number;
  /** Wind response, 0..1. */
  readonly windResponse: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Encode a desired world radius using the record's one radial convention. */
export function detailRadialScaleForWorldRadius(
  radiusMeters: number,
  heightMeters: number,
  prototypeRadiusUnit: number,
): number {
  if (!Number.isFinite(radiusMeters) || radiusMeters < 0) {
    throw new RangeError("Detail world radius must be finite and non-negative");
  }
  if (!Number.isFinite(heightMeters) || heightMeters <= 0) {
    throw new RangeError("Detail height must be finite and greater than zero");
  }
  if (!Number.isFinite(prototypeRadiusUnit) || prototypeRadiusUnit <= 0) {
    throw new RangeError("Detail prototype radius must be finite and greater than zero");
  }
  return Math.min(
    DETAIL_INSTANCE_RADIAL_MAX,
    Math.max(
      DETAIL_INSTANCE_RADIAL_MIN,
      radiusMeters / (heightMeters * prototypeRadiusUnit),
    ),
  );
}

/** CPU mirror of the vertex shader's radial transform, used by contract tests. */
export function detailPrototypeWorldRadius(
  prototypeRadiusUnit: number,
  heightMeters: number,
  radialScale: number,
): number {
  return prototypeRadiusUnit * heightMeters * radialScale;
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

/** Exact local AABB of a prototype position stream (empty geometry is zero-sized). */
export function detailPrototypeBoundsFromPositions(
  positions: ArrayLike<number>,
): DetailPrototypeBounds {
  if (positions.length % 3 !== 0) {
    throw new RangeError("Detail prototype positions must contain complete xyz triples");
  }
  if (positions.length === 0) {
    return Object.freeze({
      minimum: Object.freeze([0, 0, 0] as const),
      maximum: Object.freeze([0, 0, 0] as const),
    });
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index]!;
    const y = positions[index + 1]!;
    const z = positions[index + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new RangeError("Detail prototype positions must be finite");
    }
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return Object.freeze({
    minimum: Object.freeze([minX, minY, minZ] as const),
    maximum: Object.freeze([maxX, maxY, maxZ] as const),
  });
}

function decodedInstanceHeight(record: DetailInstanceRecord): number {
  return unorm16(record.heightScaleMeters / DETAIL_INSTANCE_HEIGHT_MAX_METERS)
    / 65_535 * DETAIL_INSTANCE_HEIGHT_MAX_METERS;
}

function decodedInstanceRadialScale(record: DetailInstanceRecord): number {
  const encoded = unorm16(
    (record.radialScale - DETAIL_INSTANCE_RADIAL_MIN)
      / (DETAIL_INSTANCE_RADIAL_MAX - DETAIL_INSTANCE_RADIAL_MIN),
  );
  return DETAIL_INSTANCE_RADIAL_MIN
    + encoded / 65_535 * (DETAIL_INSTANCE_RADIAL_MAX - DETAIL_INSTANCE_RADIAL_MIN);
}

/** Quaternion for a pure yaw rotation — the pre-`2-15` call-site helper. */
export function yawQuaternion(yawRadians: number): [number, number, number, number] {
  const half = yawRadians / 2;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

/**
 * 2-15 — yaw about the object's own axis, then tilt that axis `blend` of
 * the way from world-up toward the terrain normal (the plan's ~60% rock
 * alignment; clutter lies flatter at higher blends). Hamilton product
 * q_tilt ⊗ q_yaw, unit output.
 */
export function normalAlignedQuaternion(
  normal: { readonly x: number; readonly y: number; readonly z: number },
  yawRadians: number,
  blend: number,
): [number, number, number, number] {
  const mix = Math.min(1, Math.max(0, blend));
  let tx = normal.x * mix;
  let ty = 1 + (normal.y - 1) * mix;
  let tz = normal.z * mix;
  const length = Math.hypot(tx, ty, tz);
  if (!Number.isFinite(length) || length < 1e-6) {
    return yawQuaternion(yawRadians);
  }
  tx /= length; ty /= length; tz /= length;
  // Tilt +y onto the blended axis: axis = up × t = (tz, 0, −tx).
  const axisLength = Math.hypot(tz, tx);
  if (axisLength < 1e-6) return yawQuaternion(yawRadians);
  const angle = Math.acos(Math.min(1, Math.max(-1, ty)));
  const s = Math.sin(angle / 2) / axisLength;
  const qtX = tz * s;
  const qtZ = -tx * s;
  const qtW = Math.cos(angle / 2);
  const [qyX, qyY, qyZ, qyW] = yawQuaternion(yawRadians);
  // Hamilton product (qt ⊗ qy) with qtY = 0.
  const x = qtW * qyX + qtX * qyW + 0 * qyZ - qtZ * qyY;
  const y = qtW * qyY + 0 * qyW + qtZ * qyX - qtX * qyZ;
  const z = qtW * qyZ + qtZ * qyW + qtX * qyY - 0 * qyX;
  const w = qtW * qyW - qtX * qyX - 0 * qyY - qtZ * qyZ;
  const norm = Math.hypot(x, y, z, w) || 1;
  return [x / norm, y / norm, z / norm, w / norm];
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

  /**
   * Adopts one exact packed range whose ArrayBuffer ownership was transferred
   * from the detail worker. No byte copy is performed: the returned writer is
   * the sole mutable owner and can enter the same CPU/GPU publication path as
   * an inline writer.
   */
  static fromTransferredBytes(bytes: Uint8Array, count: number): DetailInstanceWriter {
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new RangeError("Transferred detail instance count must be a positive integer");
    }
    if (
      !(bytes.buffer instanceof ArrayBuffer)
      || bytes.byteOffset !== 0
      || bytes.byteLength !== count * DETAIL_INSTANCE_STRIDE_BYTES
      || bytes.buffer.byteLength !== bytes.byteLength
    ) {
      throw new RangeError("Transferred detail instance bytes must be one exact packed buffer");
    }
    const writer = new DetailInstanceWriter(1);
    writer.buffer = bytes.buffer;
    writer.view = new DataView(writer.buffer);
    writer.countValue = count;
    return writer;
  }

  get count(): number {
    return this.countValue;
  }

  reset(): void {
    this.countValue = 0;
  }

  push(record: DetailInstanceRecord): void {
    this.write(record);
  }

  /**
   * Packs one record and accumulates its culling bound from the SAME encoded
   * scalars. The old runtime called `push` and then `bounds.add`, making both
   * paths independently quantise position, height, radial scale, variant,
   * phase and wind. Besides duplicate hot-loop work, that made it possible for
   * packing and culling to drift apart. This is the production path; `push`
   * remains the small format-only API used by tests and tools.
   */
  pushBounded(
    record: DetailInstanceRecord,
    bounds: DetailInstanceBounds,
    kernel: DetailPrototypeBoundKernel,
    billboardFrame?: DetailBillboardFrameBounds,
  ): void {
    const offset = this.countValue * DETAIL_INSTANCE_STRIDE_BYTES;
    if (offset + DETAIL_INSTANCE_STRIDE_BYTES > this.buffer.byteLength) {
      const grown = new ArrayBuffer(this.buffer.byteLength * 2);
      new Uint8Array(grown).set(new Uint8Array(this.buffer));
      this.buffer = grown;
      this.view = new DataView(this.buffer);
    }
    // Keep the production operation monomorphic. Calling the format-only
    // writer and then decoding its DataView was exact but left most of the
    // duplicate-path cost in the hot loop; these locals are both the bytes
    // written below and the only scalar authority consumed by bounds.
    const positionX = Math.fround(record.x);
    const positionY = Math.fround(record.y);
    const positionZ = Math.fround(record.z);
    const heightCode = unorm16(record.heightScaleMeters / DETAIL_INSTANCE_HEIGHT_MAX_METERS);
    const radialCode = unorm16(
      (record.radialScale - DETAIL_INSTANCE_RADIAL_MIN)
        / (DETAIL_INSTANCE_RADIAL_MAX - DETAIL_INSTANCE_RADIAL_MIN),
    );
    const variantCode = Math.min(255, Math.max(0, Math.round(record.variant)));
    const windPhaseCode = unorm8(record.windPhase % 1);
    const windResponseCode = unorm8(record.windResponse);
    const view = this.view;
    view.setFloat32(offset, positionX, true);
    view.setFloat32(offset + 4, positionY, true);
    view.setFloat32(offset + 8, positionZ, true);
    view.setInt16(offset + 12, snorm16(record.quaternion[0]), true);
    view.setInt16(offset + 14, snorm16(record.quaternion[1]), true);
    view.setInt16(offset + 16, snorm16(record.quaternion[2]), true);
    view.setInt16(offset + 18, snorm16(record.quaternion[3]), true);
    view.setUint16(offset + 20, heightCode, true);
    view.setUint16(offset + 22, radialCode, true);
    view.setUint8(offset + 24, unorm8(record.tint[0]));
    view.setUint8(offset + 25, unorm8(record.tint[1]));
    view.setUint8(offset + 26, unorm8(record.tint[2]));
    view.setUint8(offset + 27, unorm8(record.tint[3]));
    view.setUint8(
      offset + 28,
      Math.min(127, Math.round(clamp01(record.fade) * 127)) * 2
        + (record.fadeIncoming ? 1 : 0),
    );
    view.setUint8(offset + 29, variantCode);
    view.setUint8(offset + 30, windPhaseCode);
    view.setUint8(offset + 31, windResponseCode);
    this.countValue += 1;
    if (billboardFrame) {
      bounds.addEncodedBillboard(
        positionX,
        positionY,
        positionZ,
        heightCode,
        radialCode,
        billboardFrame,
      );
      return;
    }

    const height = heightCode / 65_535 * DETAIL_INSTANCE_HEIGHT_MAX_METERS;
    const radial = DETAIL_INSTANCE_RADIAL_MIN
      + radialCode / 65_535 * (DETAIL_INSTANCE_RADIAL_MAX - DETAIL_INSTANCE_RADIAL_MIN);
    const radialMeters = height * radial;
    const modifier = Math.floor(variantCode / 32);
    let localRadiusSquared: number;

    if (modifier === 1) {
      // Character modifier 1 shears local X by Y. Preserve the complete
      // four-corner calculation for that 15% branch.
      const prototype = kernel.prototype;
      const windPhase = detailStemHash(windPhaseCode / 255);
      const characterLean = 0.1
        + (windPhase * 7.31 - Math.floor(windPhase * 7.31)) * 0.11;
      const minimumX = prototype.minimum[0] * radialMeters;
      const maximumX = prototype.maximum[0] * radialMeters;
      const minimumY = prototype.minimum[1] * height;
      const maximumY = prototype.maximum[1] * height;
      const maximumAbsZ = Math.max(
        Math.abs(prototype.minimum[2] * radialMeters),
        Math.abs(prototype.maximum[2] * radialMeters),
      );
      const shearMinimumY = minimumY * characterLean;
      const shearMaximumY = maximumY * characterLean;
      const minimumXAtMinimumY = minimumX + shearMinimumY;
      const maximumXAtMinimumY = maximumX + shearMinimumY;
      const minimumXAtMaximumY = minimumX + shearMaximumY;
      const maximumXAtMaximumY = maximumX + shearMaximumY;
      const minimumYSquared = minimumY * minimumY;
      const maximumYSquared = maximumY * maximumY;
      const maximumXYRadiusSquared = Math.max(
        minimumXAtMinimumY * minimumXAtMinimumY + minimumYSquared,
        maximumXAtMinimumY * maximumXAtMinimumY + minimumYSquared,
        minimumXAtMaximumY * minimumXAtMaximumY + maximumYSquared,
        maximumXAtMaximumY * maximumXAtMaximumY + maximumYSquared,
      );
      localRadiusSquared = maximumXYRadiusSquared + maximumAbsZ * maximumAbsZ;
    } else {
      // With no shear the maximum box norm is separable. The prototype-owned
      // kernel selected the furthest endpoint on each axis once at registration.
      const extremeX = kernel.extremeXUnit * radialMeters;
      const extremeY = kernel.extremeYUnit * height;
      const extremeZ = kernel.extremeZUnit * radialMeters;
      localRadiusSquared = extremeX * extremeX + extremeY * extremeY;
      localRadiusSquared += extremeZ * extremeZ;
    }

    if (kernel.prototype.contractionPivotYUnit !== undefined) {
      const pivotY = kernel.prototype.contractionPivotYUnit * height;
      localRadiusSquared = Math.max(localRadiusSquared, pivotY * pivotY);
    }
    const windPadding = height * (windResponseCode / 255)
      * DETAIL_INSTANCE_WIND_PADDING_RATIO;
    bounds.addSphere(
      positionX,
      positionY,
      positionZ,
      Math.sqrt(localRadiusSquared) + windPadding + 0.01,
    );
  }

  private write(record: DetailInstanceRecord): void {
    const offset = this.countValue * DETAIL_INSTANCE_STRIDE_BYTES;
    if (offset + DETAIL_INSTANCE_STRIDE_BYTES > this.buffer.byteLength) {
      const grown = new ArrayBuffer(this.buffer.byteLength * 2);
      new Uint8Array(grown).set(new Uint8Array(this.buffer));
      this.buffer = grown;
      this.view = new DataView(this.buffer);
    }
    // These are the exact vertex-lane values for the format-only path.
    const positionX = Math.fround(record.x);
    const positionY = Math.fround(record.y);
    const positionZ = Math.fround(record.z);
    const orientationX = snorm16(record.quaternion[0]);
    const orientationY = snorm16(record.quaternion[1]);
    const orientationZ = snorm16(record.quaternion[2]);
    const orientationW = snorm16(record.quaternion[3]);
    const heightCode = unorm16(record.heightScaleMeters / DETAIL_INSTANCE_HEIGHT_MAX_METERS);
    const radialCode = unorm16(
      (record.radialScale - DETAIL_INSTANCE_RADIAL_MIN)
        / (DETAIL_INSTANCE_RADIAL_MAX - DETAIL_INSTANCE_RADIAL_MIN),
    );
    const tintR = unorm8(record.tint[0]);
    const tintG = unorm8(record.tint[1]);
    const tintB = unorm8(record.tint[2]);
    const tintA = unorm8(record.tint[3]);
    const fadeCode = Math.min(127, Math.round(clamp01(record.fade) * 127)) * 2
      + (record.fadeIncoming ? 1 : 0);
    const variantCode = Math.min(255, Math.max(0, Math.round(record.variant)));
    const windPhaseCode = unorm8(record.windPhase % 1);
    const windResponseCode = unorm8(record.windResponse);
    const view = this.view;
    view.setFloat32(offset, positionX, true);
    view.setFloat32(offset + 4, positionY, true);
    view.setFloat32(offset + 8, positionZ, true);
    view.setInt16(offset + 12, orientationX, true);
    view.setInt16(offset + 14, orientationY, true);
    view.setInt16(offset + 16, orientationZ, true);
    view.setInt16(offset + 18, orientationW, true);
    view.setUint16(offset + 20, heightCode, true);
    view.setUint16(offset + 22, radialCode, true);
    view.setUint8(offset + 24, tintR);
    view.setUint8(offset + 25, tintG);
    view.setUint8(offset + 26, tintB);
    view.setUint8(offset + 27, tintA);
    view.setUint8(offset + 28, fadeCode);
    view.setUint8(offset + 29, variantCode);
    view.setUint8(offset + 30, windPhaseCode);
    view.setUint8(offset + 31, windResponseCode);
    this.countValue += 1;
  }

  /** The packed bytes for exactly the pushed records (a view, not a copy). */
  finish(): Uint8Array {
    return new Uint8Array(this.buffer, 0, this.countValue * DETAIL_INSTANCE_STRIDE_BYTES);
  }
}

/**
 * Side of one culling block, metres: a sixteenth of a 4,096 m presentation
 * chunk. One box over a whole batch is a poor frustum test — the chunk the
 * camera stands in always contains the eye, so every batch in it passed
 * whichever way the camera looked — and a draw call is the unit of cost on
 * every adapter measured (docs/PERFORMANCE.md, "Culling a batch by blocks").
 * On seven capture placements 256 m blocks leave within two batches of an
 * exact per-instance test; 512 m left 16 where 256 m leave nine looking
 * straight down from 1,600 ft, and 128 m bought one or two batches on
 * three placements for four times the boxes.
 */
export const DETAIL_CULL_BLOCK_METERS = 256;

/**
 * Lattice slots a side. A batch's positions lie in one presentation chunk,
 * sixteen blocks wide, but the lattice is the RECORD ORIGIN's — the floating
 * origin the records are relative to, which is not chunk-aligned — so the
 * chunk can touch seventeen lattice blocks a side. A block's slot is its
 * lattice index modulo this, which needs no anchor and no chunk coordinates
 * in the accumulator. A wider chunk only makes two blocks share a slot: the
 * slot's box is still the union of real instance boxes, so the test stays
 * conservative and merely culls less.
 */
export const DETAIL_CULL_BLOCK_SLOTS = 17;

/** Numbers a block in `blockExtents()`: minimum x, y, z then maximum x, y, z. */
export const DETAIL_CULL_BLOCK_STRIDE = 6;

interface DetailCullBlockScratch {
  /** One `DETAIL_CULL_BLOCK_STRIDE` row a slot; an untouched slot is inverted. */
  readonly extents: Float64Array;
  /** Slots written since the scratch was opened, in first-touch order. */
  readonly touched: Uint16Array;
  touchedCount: number;
}

const DETAIL_CULL_BLOCK_SLOT_COUNT = DETAIL_CULL_BLOCK_SLOTS * DETAIL_CULL_BLOCK_SLOTS;
const DETAIL_CULL_BLOCK_SCRATCH_POOL_LIMIT = 96;
const DETAIL_CULL_BLOCKS_UNKNOWN = new Float64Array(0);

/**
 * The dense slot grid is only needed while a batch accumulates (14 KB); a
 * published batch keeps the compact list. A worker build opens one grid a
 * prototype and a jet rebuilds several chunks a second, so the grids are
 * recycled here rather than left to the collector. Per realm: the worker and
 * the main thread each have their own.
 */
const detailCullBlockScratchPool: DetailCullBlockScratch[] = [];

function openDetailCullBlockScratch(): DetailCullBlockScratch {
  const pooled = detailCullBlockScratchPool.pop();
  if (pooled) return pooled;
  const extents = new Float64Array(DETAIL_CULL_BLOCK_SLOT_COUNT * DETAIL_CULL_BLOCK_STRIDE);
  for (let base = 0; base < extents.length; base += DETAIL_CULL_BLOCK_STRIDE) {
    extents[base] = Number.POSITIVE_INFINITY;
    extents[base + 1] = Number.POSITIVE_INFINITY;
    extents[base + 2] = Number.POSITIVE_INFINITY;
    extents[base + 3] = Number.NEGATIVE_INFINITY;
    extents[base + 4] = Number.NEGATIVE_INFINITY;
    extents[base + 5] = Number.NEGATIVE_INFINITY;
  }
  return {
    extents,
    touched: new Uint16Array(DETAIL_CULL_BLOCK_SLOT_COUNT),
    touchedCount: 0,
  };
}

/** Copies the touched slots out (or drops them) and returns the grid clean. */
function closeDetailCullBlockScratch(
  scratch: DetailCullBlockScratch,
  into: Float64Array | null,
): void {
  const extents = scratch.extents;
  for (let index = 0; index < scratch.touchedCount; index += 1) {
    const base = scratch.touched[index]! * DETAIL_CULL_BLOCK_STRIDE;
    if (into !== null) {
      const target = index * DETAIL_CULL_BLOCK_STRIDE;
      into[target] = extents[base]!;
      into[target + 1] = extents[base + 1]!;
      into[target + 2] = extents[base + 2]!;
      into[target + 3] = extents[base + 3]!;
      into[target + 4] = extents[base + 4]!;
      into[target + 5] = extents[base + 5]!;
    }
    extents[base] = Number.POSITIVE_INFINITY;
    extents[base + 1] = Number.POSITIVE_INFINITY;
    extents[base + 2] = Number.POSITIVE_INFINITY;
    extents[base + 3] = Number.NEGATIVE_INFINITY;
    extents[base + 4] = Number.NEGATIVE_INFINITY;
    extents[base + 5] = Number.NEGATIVE_INFINITY;
  }
  scratch.touchedCount = 0;
  if (detailCullBlockScratchPool.length < DETAIL_CULL_BLOCK_SCRATCH_POOL_LIMIT) {
    detailCullBlockScratchPool.push(scratch);
  }
}

/**
 * Generator-side AABB (the plan's named cost): with no CPU matrix buffer,
 * `thinInstanceRefreshBoundingInfo` has no input, so the generator — which
 * knows every position and extent — accumulates bounds itself, with the wind
 * sway as an EXPLICIT term instead of the old `scale(1.01)` fudge.
 *
 * Beside the one box over everything it keeps a box a culling BLOCK: every
 * instance's own box goes into the block its position falls in, so each
 * block's box is exactly as conservative as the whole one and their union is
 * the whole one. See `DETAIL_CULL_BLOCK_METERS`.
 */
export class DetailInstanceBounds {
  private minX = Number.POSITIVE_INFINITY;
  private minY = Number.POSITIVE_INFINITY;
  private minZ = Number.POSITIVE_INFINITY;
  private maxX = Number.NEGATIVE_INFINITY;
  private maxY = Number.NEGATIVE_INFINITY;
  private maxZ = Number.NEGATIVE_INFINITY;
  private blockScratch: DetailCullBlockScratch | null = null;
  private blockList: Float64Array | null = null;
  /** False once extents arrived with no blocks: the blocks cannot cover them. */
  private blocksKnown = true;

  /**
   * Rehydrates a worker-computed finite AABB without replaying its records.
   * `blocks` is the worker's `blockExtents()`; without it the bounds have no
   * blocks and a block test must fall back to the whole box.
   */
  static fromExtents(
    minimum: readonly [number, number, number],
    maximum: readonly [number, number, number],
    blocks?: Float64Array,
  ): DetailInstanceBounds {
    for (let axis = 0; axis < 3; axis += 1) {
      if (
        !Number.isFinite(minimum[axis])
        || !Number.isFinite(maximum[axis])
        || minimum[axis]! > maximum[axis]!
      ) {
        throw new RangeError("Transferred detail instance bounds must be finite and ordered");
      }
    }
    if (blocks !== undefined && !isDetailCullBlockList(blocks, minimum, maximum)) {
      throw new RangeError("Transferred detail culling blocks must be ordered boxes inside the bounds");
    }
    const bounds = new DetailInstanceBounds();
    bounds.minX = minimum[0];
    bounds.minY = minimum[1];
    bounds.minZ = minimum[2];
    bounds.maxX = maximum[0];
    bounds.maxY = maximum[1];
    bounds.maxZ = maximum[2];
    if (blocks === undefined) bounds.blocksKnown = false;
    else bounds.blockList = blocks;
    return bounds;
  }

  reset(): void {
    this.minX = Number.POSITIVE_INFINITY;
    this.minY = Number.POSITIVE_INFINITY;
    this.minZ = Number.POSITIVE_INFINITY;
    this.maxX = Number.NEGATIVE_INFINITY;
    this.maxY = Number.NEGATIVE_INFINITY;
    this.maxZ = Number.NEGATIVE_INFINITY;
    if (this.blockScratch !== null) {
      closeDetailCullBlockScratch(this.blockScratch, null);
      this.blockScratch = null;
    }
    this.blockList = null;
    this.blocksKnown = true;
  }

  /**
   * The culling blocks: `DETAIL_CULL_BLOCK_STRIDE` numbers a block, in the
   * records' own coordinates, in the order the blocks were first written.
   * Every included instance's box lies inside one of them. EMPTY means
   * unknown (nothing included, or extents rehydrated without blocks), never
   * "nothing to draw": a caller with no blocks tests the whole box alone.
   *
   * The first call closes the accumulator's grid and keeps the compact list;
   * the array is this object's until `reset()`, or until it is transferred.
   */
  blockExtents(): Float64Array {
    if (!this.blocksKnown) return DETAIL_CULL_BLOCKS_UNKNOWN;
    if (this.blockList !== null) return this.blockList;
    const scratch = this.blockScratch;
    if (scratch === null) return DETAIL_CULL_BLOCKS_UNKNOWN;
    const list = new Float64Array(scratch.touchedCount * DETAIL_CULL_BLOCK_STRIDE);
    closeDetailCullBlockScratch(scratch, list);
    this.blockScratch = null;
    this.blockList = list;
    return list;
  }

  get isEmpty(): boolean {
    return this.minX > this.maxX;
  }

  add(record: DetailInstanceRecord, prototype: DetailPrototypeBounds): void {
    const height = decodedInstanceHeight(record);
    const radial = decodedInstanceRadialScale(record);
    const radialMeters = height * radial;
    const positionX = Math.fround(record.x);
    const positionY = Math.fround(record.y);
    const positionZ = Math.fround(record.z);

    // Character modifier 1 shears the authored prototype in local X before
    // the quaternion. Decode the packed phase/variant bytes exactly as the
    // shader does so the culling volume encloses the geometry actually drawn.
    const variantByte = Math.min(255, Math.max(0, Math.round(record.variant)));
    const modifier = Math.floor(variantByte / 32);
    const windPhase = detailStemHash(unorm8(record.windPhase % 1) / 255);
    const characterLean = modifier === 1
      ? 0.1 + (windPhase * 7.31 - Math.floor(windPhase * 7.31)) * 0.11
      : 0;

    // A rotation cannot enlarge a sphere. Bound the shader's scaled/sheared
    // prototype AABB in local space, then use that one rotation-invariant
    // radius around the packed f32 instance position. This preserves exact
    // enclosure without decoding/normalising the quaternion or allocating
    // temporary tuples for every one of tens of thousands of instances.
    //
    // The squared norm is convex, so its maximum over the sheared box lies at
    // a corner. Z is independent; X depends on the same Y endpoint through
    // the character-lean shear. Checking the four (X,Y) endpoint pairs and
    // the largest |Z| therefore finds the exact local-box sphere radius.
    const minimumX = prototype.minimum[0] * radialMeters;
    const maximumX = prototype.maximum[0] * radialMeters;
    const minimumY = prototype.minimum[1] * height;
    const maximumY = prototype.maximum[1] * height;
    const maximumAbsZ = Math.max(
      Math.abs(prototype.minimum[2] * radialMeters),
      Math.abs(prototype.maximum[2] * radialMeters),
    );
    const shearMinimumY = minimumY * characterLean;
    const shearMaximumY = maximumY * characterLean;
    const minimumXAtMinimumY = minimumX + shearMinimumY;
    const maximumXAtMinimumY = maximumX + shearMinimumY;
    const minimumXAtMaximumY = minimumX + shearMaximumY;
    const maximumXAtMaximumY = maximumX + shearMaximumY;
    const minimumYSquared = minimumY * minimumY;
    const maximumYSquared = maximumY * maximumY;
    const maximumXYRadiusSquared = Math.max(
      minimumXAtMinimumY * minimumXAtMinimumY + minimumYSquared,
      maximumXAtMinimumY * maximumXAtMinimumY + minimumYSquared,
      minimumXAtMaximumY * minimumXAtMaximumY + maximumYSquared,
      maximumXAtMaximumY * maximumXAtMaximumY + maximumYSquared,
    );
    let localRadiusSquared = maximumXYRadiusSquared + maximumAbsZ * maximumAbsZ;
    if (prototype.contractionPivotYUnit !== undefined) {
      // Dense-crown contraction maps each vertex along the segment toward
      // this pivot. A norm is convex, so enclosing both endpoints encloses
      // every seasonal/thinning state on that segment.
      const pivotY = prototype.contractionPivotYUnit * height;
      localRadiusSquared = Math.max(localRadiusSquared, pivotY * pivotY);
    }

    const decodedWindResponse = unorm8(record.windResponse) / 255;
    const windPadding = height * decodedWindResponse * DETAIL_INSTANCE_WIND_PADDING_RATIO;
    // CPU bounds are f64 while the vertex path is f32. One centimetre covers
    // the accumulated f32 arithmetic error at the renderer's 45 km far plane.
    const radius = Math.sqrt(localRadiusSquared) + windPadding + 0.01;
    this.include(
      positionX,
      positionZ,
      positionX - radius,
      positionY - radius,
      positionZ - radius,
      positionX + radius,
      positionY + radius,
      positionZ + radius,
    );
  }

  /** Hot writer counterpart: includes one already-computed sphere. */
  addSphere(
    positionX: number,
    positionY: number,
    positionZ: number,
    radius: number,
  ): void {
    this.include(
      positionX,
      positionZ,
      positionX - radius,
      positionY - radius,
      positionZ - radius,
      positionX + radius,
      positionY + radius,
      positionZ + radius,
    );
  }

  /**
   * The shared far-tree quad has a different shader transform: it faces the
   * camera, ignores the instance quaternion and uses a per-species bake frame.
   */
  addBillboard(record: DetailInstanceRecord, frame: DetailBillboardFrameBounds): void {
    const height = decodedInstanceHeight(record);
    const radial = decodedInstanceRadialScale(record);
    const extent = Math.max(0, frame.extentUnit);
    const horizontalRadius = height * radial * extent;
    const positionX = Math.fround(record.x);
    const positionY = Math.fround(record.y);
    const positionZ = Math.fround(record.z);
    const minimumY = positionY + height * (frame.centerYUnit - extent);
    const maximumY = positionY + height * (frame.centerYUnit + extent);
    this.include(
      positionX,
      positionZ,
      positionX - horizontalRadius - 0.01,
      minimumY - 0.01,
      positionZ - horizontalRadius - 0.01,
      positionX + horizontalRadius + 0.01,
      maximumY + 0.01,
      positionZ + horizontalRadius + 0.01,
    );
  }

  /** Packed billboard path; no quaternion is involved. */
  addEncodedBillboard(
    positionX: number,
    positionY: number,
    positionZ: number,
    heightCode: number,
    radialCode: number,
    frame: DetailBillboardFrameBounds,
  ): void {
    const height = heightCode / 65_535 * DETAIL_INSTANCE_HEIGHT_MAX_METERS;
    const radial = DETAIL_INSTANCE_RADIAL_MIN
      + radialCode / 65_535 * (DETAIL_INSTANCE_RADIAL_MAX - DETAIL_INSTANCE_RADIAL_MIN);
    const extent = Math.max(0, frame.extentUnit);
    const horizontalRadius = height * radial * extent;
    const minimumY = positionY + height * (frame.centerYUnit - extent);
    const maximumY = positionY + height * (frame.centerYUnit + extent);
    this.include(
      positionX,
      positionZ,
      positionX - horizontalRadius - 0.01,
      minimumY - 0.01,
      positionZ - horizontalRadius - 0.01,
      positionX + horizontalRadius + 0.01,
      maximumY + 0.01,
      positionZ + horizontalRadius + 0.01,
    );
  }

  /** `positionX`/`positionZ` choose the block; the box is the instance's own. */
  private include(
    positionX: number,
    positionZ: number,
    minimumX: number,
    minimumY: number,
    minimumZ: number,
    maximumX: number,
    maximumY: number,
    maximumZ: number,
  ): void {
    this.minX = Math.min(this.minX, minimumX);
    this.minY = Math.min(this.minY, minimumY);
    this.minZ = Math.min(this.minZ, minimumZ);
    this.maxX = Math.max(this.maxX, maximumX);
    this.maxY = Math.max(this.maxY, maximumY);
    this.maxZ = Math.max(this.maxZ, maximumZ);
    if (!this.blocksKnown) return;
    const scratch = this.blockScratch ?? this.openBlockScratch();
    includeDetailCullBlock(
      scratch,
      positionX,
      positionZ,
      minimumX,
      minimumY,
      minimumZ,
      maximumX,
      maximumY,
      maximumZ,
    );
  }

  /**
   * Opens the grid for the first box — or for a box that arrives after the
   * list was already taken, in which case the taken blocks go back in first
   * so none of them is lost.
   */
  private openBlockScratch(): DetailCullBlockScratch {
    const scratch = openDetailCullBlockScratch();
    this.blockScratch = scratch;
    const list = this.blockList;
    this.blockList = null;
    if (list !== null) {
      for (let base = 0; base < list.length; base += DETAIL_CULL_BLOCK_STRIDE) {
        includeDetailCullBlock(
          scratch,
          (list[base]! + list[base + 3]!) * 0.5,
          (list[base + 2]! + list[base + 5]!) * 0.5,
          list[base]!,
          list[base + 1]!,
          list[base + 2]!,
          list[base + 3]!,
          list[base + 4]!,
          list[base + 5]!,
        );
      }
    }
    return scratch;
  }

  minimum(): [number, number, number] {
    return [this.minX, this.minY, this.minZ];
  }

  maximum(): [number, number, number] {
    return [this.maxX, this.maxY, this.maxZ];
  }
}

function includeDetailCullBlock(
  scratch: DetailCullBlockScratch,
  positionX: number,
  positionZ: number,
  minimumX: number,
  minimumY: number,
  minimumZ: number,
  maximumX: number,
  maximumY: number,
  maximumZ: number,
): void {
  let slotX = Math.floor(positionX / DETAIL_CULL_BLOCK_METERS) % DETAIL_CULL_BLOCK_SLOTS;
  if (slotX < 0) slotX += DETAIL_CULL_BLOCK_SLOTS;
  let slotZ = Math.floor(positionZ / DETAIL_CULL_BLOCK_METERS) % DETAIL_CULL_BLOCK_SLOTS;
  if (slotZ < 0) slotZ += DETAIL_CULL_BLOCK_SLOTS;
  // A position that is not a number has no slot. Slot 0 keeps its box inside
  // SOME block, which is all the test needs; the whole bound is already
  // poisoned and is refused where it is consumed.
  const slot = slotX === slotX && slotZ === slotZ ? slotZ * DETAIL_CULL_BLOCK_SLOTS + slotX : 0;
  const base = slot * DETAIL_CULL_BLOCK_STRIDE;
  const extents = scratch.extents;
  if (extents[base]! > extents[base + 3]!) {
    scratch.touched[scratch.touchedCount] = slot;
    scratch.touchedCount += 1;
  }
  if (minimumX < extents[base]!) extents[base] = minimumX;
  if (minimumY < extents[base + 1]!) extents[base + 1] = minimumY;
  if (minimumZ < extents[base + 2]!) extents[base + 2] = minimumZ;
  if (maximumX > extents[base + 3]!) extents[base + 3] = maximumX;
  if (maximumY > extents[base + 4]!) extents[base + 4] = maximumY;
  if (maximumZ > extents[base + 5]!) extents[base + 5] = maximumZ;
}

/**
 * Whether `blocks` is a well-formed block list for bounds of these extents:
 * whole rows, every box finite and ordered, none reaching outside the whole
 * box. The worker boundary and `fromExtents` share this one definition.
 */
export function isDetailCullBlockList(
  blocks: unknown,
  minimum: readonly [number, number, number],
  maximum: readonly [number, number, number],
): blocks is Float64Array {
  if (!(blocks instanceof Float64Array)) return false;
  if (blocks.length === 0 || blocks.length % DETAIL_CULL_BLOCK_STRIDE !== 0) return false;
  for (let base = 0; base < blocks.length; base += DETAIL_CULL_BLOCK_STRIDE) {
    for (let axis = 0; axis < 3; axis += 1) {
      const low = blocks[base + axis]!;
      const high = blocks[base + 3 + axis]!;
      // Written so that a NaN fails every comparison it meets.
      if (!(low <= high && low >= minimum[axis]! && high <= maximum[axis]!)) return false;
    }
  }
  return true;
}

/** The six frustum planes as Babylon hands them to a culling test. */
export interface DetailCullPlane {
  readonly normal: { readonly x: number; readonly y: number; readonly z: number };
  readonly d: number;
}

/**
 * True when some block may be inside the frustum. `blocks` are in the
 * records' coordinates and the offset is the batch mesh's world translation.
 * A block is rejected only when it lies wholly behind one plane — Babylon's
 * own box test, on a smaller box — so a batch this rejects has no instance
 * whose bound touches the frustum and draws nothing it would have drawn.
 */
export function detailCullBlocksIntersectFrustum(
  blocks: Float64Array,
  planes: ArrayLike<DetailCullPlane>,
  offsetX: number,
  offsetY: number,
  offsetZ: number,
): boolean {
  const planeCount = planes.length;
  for (let base = 0; base < blocks.length; base += DETAIL_CULL_BLOCK_STRIDE) {
    const minimumX = blocks[base]! + offsetX;
    const minimumY = blocks[base + 1]! + offsetY;
    const minimumZ = blocks[base + 2]! + offsetZ;
    const maximumX = blocks[base + 3]! + offsetX;
    const maximumY = blocks[base + 4]! + offsetY;
    const maximumZ = blocks[base + 5]! + offsetZ;
    let outside = false;
    for (let index = 0; index < planeCount; index += 1) {
      const plane = planes[index]!;
      const normal = plane.normal;
      // The corner furthest along the normal: if even that one is behind the
      // plane, the whole box is.
      const distance = normal.x * (normal.x >= 0 ? maximumX : minimumX)
        + normal.y * (normal.y >= 0 ? maximumY : minimumY)
        + normal.z * (normal.z >= 0 ? maximumZ : minimumZ)
        + plane.d;
      if (distance < 0) {
        outside = true;
        break;
      }
    }
    if (!outside) return true;
  }
  return false;
}
