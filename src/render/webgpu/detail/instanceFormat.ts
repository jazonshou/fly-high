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
  /** Wind phase in TURNS (0..1 wraps 2π). */
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
      const windPhase = windPhaseCode / 255;
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

  /** Rehydrates a worker-computed finite AABB without replaying its records. */
  static fromExtents(
    minimum: readonly [number, number, number],
    maximum: readonly [number, number, number],
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
    const bounds = new DetailInstanceBounds();
    bounds.minX = minimum[0];
    bounds.minY = minimum[1];
    bounds.minZ = minimum[2];
    bounds.maxX = maximum[0];
    bounds.maxY = maximum[1];
    bounds.maxZ = maximum[2];
    return bounds;
  }

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
    const windPhase = unorm8(record.windPhase % 1) / 255;
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
      positionX - horizontalRadius - 0.01,
      minimumY - 0.01,
      positionZ - horizontalRadius - 0.01,
      positionX + horizontalRadius + 0.01,
      maximumY + 0.01,
      positionZ + horizontalRadius + 0.01,
    );
  }

  private include(
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
  }

  minimum(): [number, number, number] {
    return [this.minX, this.minY, this.minZ];
  }

  maximum(): [number, number, number] {
    return [this.maxX, this.maxY, this.maxZ];
  }
}
