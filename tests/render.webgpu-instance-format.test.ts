import { describe, expect, it } from "vitest";
import {
  DETAIL_INSTANCE_ATTRIBUTES,
  DETAIL_INSTANCE_HEIGHT_MAX_METERS,
  DETAIL_INSTANCE_RADIAL_MAX,
  DETAIL_INSTANCE_RADIAL_MIN,
  DETAIL_INSTANCE_STRIDE_BYTES,
  DETAIL_INSTANCE_WIND_PADDING_RATIO,
  DetailInstanceBounds,
  DetailInstanceWriter,
  detailPrototypeBoundKernel,
  detailRadialScaleForWorldRadius,
  normalAlignedQuaternion,
  yawQuaternion,
  type DetailInstanceRecord,
} from "../src/render/webgpu/detail/instanceFormat";
import { DYNAMIC_ALLOCATIONS } from "../src/render/webgpu/core/PerformanceBudget";
import {
  buildRockPrototype,
  buildTreePrototype,
  type PrototypeGeometry,
} from "../src/render/webgpu/detail/prototypeGeometry";
import { treePrototypeSpecies } from "../src/render/webgpu/detail/treePrototypeFamily";

/**
 * 2-11a — the 32-byte record, byte for byte. The GPU side of the same
 * contract (snorm16/unorm8 decode through forcedInstanceCount) is
 * `tests/gpu/instance-format-spike.test.ts` (R-20).
 */

const RECORD: DetailInstanceRecord = {
  x: 12.5,
  y: -3.25,
  z: 987.125,
  quaternion: yawQuaternion(Math.PI / 2),
  heightScaleMeters: 12,
  radialScale: 1.05,
  fade: 0.5,
  variant: 37,
  tint: [0.25, 0.5, 0.75, 1],
  windPhase: 0.25,
  windResponse: 0.6,
};

interface DecodedInstance {
  readonly position: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
  readonly height: number;
  readonly radial: number;
  readonly variant: number;
  readonly windPhase: number;
  readonly windResponse: number;
}

/** Decode through the real writer, exactly as the vertex attributes arrive. */
function decodeInstance(record: DetailInstanceRecord): DecodedInstance {
  const writer = new DetailInstanceWriter(1);
  writer.push(record);
  const bytes = writer.finish();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rawQuaternion = [
    view.getInt16(12, true) / 32_767,
    view.getInt16(14, true) / 32_767,
    view.getInt16(16, true) / 32_767,
    view.getInt16(18, true) / 32_767,
  ] as const;
  const quaternionLength = Math.hypot(...rawQuaternion);
  return {
    position: [
      view.getFloat32(0, true),
      view.getFloat32(4, true),
      view.getFloat32(8, true),
    ],
    quaternion: quaternionLength > 1e-12
      ? [
          rawQuaternion[0] / quaternionLength,
          rawQuaternion[1] / quaternionLength,
          rawQuaternion[2] / quaternionLength,
          rawQuaternion[3] / quaternionLength,
        ]
      : [0, 0, 0, 1],
    height: view.getUint16(20, true) / 65_535 * DETAIL_INSTANCE_HEIGHT_MAX_METERS,
    radial: DETAIL_INSTANCE_RADIAL_MIN
      + view.getUint16(22, true) / 65_535
        * (DETAIL_INSTANCE_RADIAL_MAX - DETAIL_INSTANCE_RADIAL_MIN),
    variant: view.getUint8(29),
    windPhase: view.getUint8(30) / 255,
    windResponse: view.getUint8(31) / 255,
  };
}

function rotateByQuaternion(
  point: readonly [number, number, number],
  quaternion: readonly [number, number, number, number],
): readonly [number, number, number] {
  const [x, y, z] = point;
  const [qx, qy, qz, qw] = quaternion;
  const innerX = qy * z - qz * y + qw * x;
  const innerY = qz * x - qx * z + qw * y;
  const innerZ = qx * y - qy * x + qw * z;
  return [
    x + 2 * (qy * innerZ - qz * innerY),
    y + 2 * (qz * innerX - qx * innerZ),
    z + 2 * (qx * innerY - qy * innerX),
  ];
}

/** Static portion of the production vertex transform, after record packing. */
function transformedVertices(
  geometry: PrototypeGeometry,
  record: DetailInstanceRecord,
): ReadonlyArray<readonly [number, number, number]> {
  const decoded = decodeInstance(record);
  const modifier = Math.floor(decoded.variant / 32);
  const characterLean = modifier === 1
    ? 0.1 + (decoded.windPhase * 7.31 - Math.floor(decoded.windPhase * 7.31)) * 0.11
    : 0;
  const points: Array<readonly [number, number, number]> = [];
  for (let index = 0; index < geometry.positions.length; index += 3) {
    let localX = geometry.positions[index]! * decoded.height * decoded.radial;
    let localY = geometry.positions[index + 1]! * decoded.height;
    const localZ = geometry.positions[index + 2]! * decoded.height * decoded.radial;
    localX += localY * characterLean;
    if (modifier === 2 || modifier === 4) {
      const breakHeight = decoded.height * 0.72;
      localY = Math.min(localY, breakHeight + (localY - breakHeight) * 0.06);
    }
    const rotated = rotateByQuaternion([localX, localY, localZ], decoded.quaternion);
    points.push([
      decoded.position[0] + rotated[0],
      decoded.position[1] + rotated[1],
      decoded.position[2] + rotated[2],
    ]);
  }
  return points;
}

function expectGeometryInsideBounds(
  geometry: PrototypeGeometry,
  record: DetailInstanceRecord,
  bounds: DetailInstanceBounds,
): ReadonlyArray<readonly [number, number, number]> {
  const minimum = bounds.minimum();
  const maximum = bounds.maximum();
  const points = transformedVertices(geometry, record);
  for (const [x, y, z] of points) {
    expect(x).toBeGreaterThanOrEqual(minimum[0] - 1e-6);
    expect(y).toBeGreaterThanOrEqual(minimum[1] - 1e-6);
    expect(z).toBeGreaterThanOrEqual(minimum[2] - 1e-6);
    expect(x).toBeLessThanOrEqual(maximum[0] + 1e-6);
    expect(y).toBeLessThanOrEqual(maximum[1] + 1e-6);
    expect(z).toBeLessThanOrEqual(maximum[2] + 1e-6);
  }
  return points;
}

describe("compact instance format (2-11a)", () => {
  it("packs one record into exactly 32 bytes with the declared layout", () => {
    const writer = new DetailInstanceWriter(1);
    writer.push(RECORD);
    const bytes = writer.finish();
    expect(bytes.byteLength).toBe(DETAIL_INSTANCE_STRIDE_BYTES);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getFloat32(0, true)).toBeCloseTo(12.5, 6);
    expect(view.getFloat32(4, true)).toBeCloseTo(-3.25, 6);
    expect(view.getFloat32(8, true)).toBeCloseTo(987.125, 6);
    // Quaternion for yaw π/2: (0, sin π/4, 0, cos π/4).
    expect(view.getInt16(12, true)).toBe(0);
    expect(view.getInt16(14, true) / 32_767).toBeCloseTo(Math.SQRT1_2, 4);
    expect(view.getInt16(16, true)).toBe(0);
    expect(view.getInt16(18, true) / 32_767).toBeCloseTo(Math.SQRT1_2, 4);
    // Scales decode within quantisation error of their ranges.
    expect(
      (view.getUint16(20, true) / 65_535) * DETAIL_INSTANCE_HEIGHT_MAX_METERS,
    ).toBeCloseTo(12, 3);
    expect(
      DETAIL_INSTANCE_RADIAL_MIN
        + (view.getUint16(22, true) / 65_535)
          * (DETAIL_INSTANCE_RADIAL_MAX - DETAIL_INSTANCE_RADIAL_MIN),
    ).toBeCloseTo(1.05, 4);
    expect([...bytes.subarray(24, 28)]).toEqual([64, 128, 191, 255]);
    // 2-14 fade byte: 7-bit level in the high bits, direction in bit 0
    // (0.5 · 127 rounds to 64 → 128, outgoing).
    expect(bytes[28]).toBe(128);
    expect(bytes[29]).toBe(37);
    expect(bytes[30]).toBe(64);
    expect(bytes[31]).toBe(153);
  });

  it("encodes the 2-14 fade direction bit alongside the 7-bit level", () => {
    const writer = new DetailInstanceWriter(2);
    writer.push({ ...RECORD, fade: 0.5, fadeIncoming: true });
    writer.push({ ...RECORD, fade: 1, fadeIncoming: false });
    const bytes = writer.finish();
    // Incoming at 0.5 → 64·2 + 1; full outgoing → 127·2 (the fast path the
    // fragment takes without evaluating the dither).
    expect(bytes[28]).toBe(129);
    expect(bytes[DETAIL_INSTANCE_STRIDE_BYTES + 28]).toBe(254);
  });

  it("keeps the attribute table consistent with the stride", () => {
    let coveredBytes = 0;
    for (const attribute of DETAIL_INSTANCE_ATTRIBUTES) {
      const bytesPer = attribute.type === "float" ? 4
        : attribute.type === "snorm16" || attribute.type === "unorm16" ? 2
        : 1;
      coveredBytes += bytesPer * attribute.size;
      expect(attribute.byteOffset % bytesPer, attribute.kind).toBe(0);
    }
    expect(coveredBytes).toBe(DETAIL_INSTANCE_STRIDE_BYTES);
    expect(DYNAMIC_ALLOCATIONS.detailInstanceBytes).toBe(DETAIL_INSTANCE_STRIDE_BYTES);
  });

  it("grows the pooled buffer and reuses it across resets", () => {
    const writer = new DetailInstanceWriter(1);
    for (let index = 0; index < 100; index += 1) writer.push(RECORD);
    expect(writer.count).toBe(100);
    expect(writer.finish().byteLength).toBe(100 * DETAIL_INSTANCE_STRIDE_BYTES);
    writer.reset();
    expect(writer.count).toBe(0);
    writer.push(RECORD);
    expect(writer.finish().byteLength).toBe(DETAIL_INSTANCE_STRIDE_BYTES);
  });

  it("adopts an exact transferred buffer and worker-computed bounds without copying", () => {
    const source = new DetailInstanceWriter(2);
    source.push(RECORD);
    source.push({ ...RECORD, x: -44.25, variant: 96 });
    const exact = source.finish().slice();
    const adopted = DetailInstanceWriter.fromTransferredBytes(exact, 2);
    expect(adopted.count).toBe(2);
    expect(adopted.finish().buffer).toBe(exact.buffer);
    expect(adopted.finish()).toEqual(source.finish());

    const minimum = [-7.5, -2, 3.25] as const;
    const maximum = [8, 11.5, 19] as const;
    const bounds = DetailInstanceBounds.fromExtents(minimum, maximum);
    expect(bounds.minimum()).toEqual(minimum);
    expect(bounds.maximum()).toEqual(maximum);
  });

  it("rejects malformed transferred record storage and bounds", () => {
    expect(() => DetailInstanceWriter.fromTransferredBytes(new Uint8Array(31), 1))
      .toThrow(/exact packed buffer/);
    const offset = new Uint8Array(new ArrayBuffer(64), 32, 32);
    expect(() => DetailInstanceWriter.fromTransferredBytes(offset, 1))
      .toThrow(/exact packed buffer/);
    expect(() => DetailInstanceWriter.fromTransferredBytes(new Uint8Array(32), 0))
      .toThrow(/positive integer/);
    expect(() => DetailInstanceBounds.fromExtents(
      [0, Number.NaN, 0],
      [1, 2, 3],
    )).toThrow(/finite and ordered/);
    expect(() => DetailInstanceBounds.fromExtents(
      [2, 0, 0],
      [1, 2, 3],
    )).toThrow(/finite and ordered/);
  });

  it("fuses packing and prototype bounds without changing bytes or bounds", () => {
    const prototype = {
      minimum: [-0.47, -0.08, -0.31],
      maximum: [0.43, 1.09, 0.36],
      contractionPivotYUnit: 0.42,
    } as const;
    const kernel = detailPrototypeBoundKernel(prototype);
    const records = [0, 32, 64, 96, 128, 160, 192, 255].map(
      (variant, index): DetailInstanceRecord => ({
        ...RECORD,
        x: 100.125 + index * 19.375,
        y: -17.75 + index * 3.125,
        z: -830.5 + index * 71.25,
        quaternion: normalAlignedQuaternion(
          { x: 0.17 + index * 0.03, y: 0.96, z: -0.11 - index * 0.02 },
          0.29 + index * 0.47,
          0.6,
        ),
        heightScaleMeters: 3.125 + index * 7.11,
        radialScale: 0.23 + index * 0.61,
        fade: index / 5,
        fadeIncoming: index % 2 === 1,
        variant,
        tint: [0.11 + index * 0.1, 0.82 - index * 0.09, 0.27 + index * 0.07, 1],
        windPhase: 0.037 + index * 0.173,
        windResponse: 0.09 + index * 0.16,
      }),
    );
    const referenceWriter = new DetailInstanceWriter(records.length);
    const fusedWriter = new DetailInstanceWriter(records.length);
    const referenceBounds = new DetailInstanceBounds();
    const fusedBounds = new DetailInstanceBounds();
    for (const record of records) {
      referenceWriter.push(record);
      referenceBounds.add(record, prototype);
      fusedWriter.pushBounded(record, fusedBounds, kernel);
    }

    expect(fusedWriter.finish()).toEqual(referenceWriter.finish());
    expect(fusedBounds.minimum()).toEqual(referenceBounds.minimum());
    expect(fusedBounds.maximum()).toEqual(referenceBounds.maximum());
  });

  it("fuses billboard packing without changing frame bounds", () => {
    const prototype = {
      minimum: [-1, -1, 0],
      maximum: [1, 1, 0],
    } as const;
    const frame = { extentUnit: 0.63, centerYUnit: 0.54 } as const;
    const kernel = detailPrototypeBoundKernel(prototype);
    const referenceWriter = new DetailInstanceWriter(1);
    const fusedWriter = new DetailInstanceWriter(1);
    const referenceBounds = new DetailInstanceBounds();
    const fusedBounds = new DetailInstanceBounds();

    referenceWriter.push(RECORD);
    referenceBounds.addBillboard(RECORD, frame);
    fusedWriter.pushBounded(RECORD, fusedBounds, kernel, frame);

    expect(fusedWriter.finish()).toEqual(referenceWriter.finish());
    expect(fusedBounds.minimum()).toEqual(referenceBounds.minimum());
    expect(fusedBounds.maximum()).toEqual(referenceBounds.maximum());
  });

  it("accumulates a rotation-invariant prototype sphere with explicit wind extent", () => {
    const bounds = new DetailInstanceBounds();
    expect(bounds.isEmpty).toBe(true);
    const record = {
      ...RECORD,
      quaternion: yawQuaternion(0),
      variant: 0,
    };
    const prototype = {
      minimum: [-0.5, 0, -0.25],
      maximum: [0.5, 1, 0.25],
    } as const;
    bounds.add(record, prototype);
    expect(bounds.isEmpty).toBe(false);
    const decoded = decodeInstance(record);
    const padding = decoded.height * decoded.windResponse
      * DETAIL_INSTANCE_WIND_PADDING_RATIO + 0.01;
    const localRadius = Math.hypot(
      0.5 * decoded.height * decoded.radial,
      decoded.height,
      0.25 * decoded.height * decoded.radial,
    );
    const radius = localRadius + padding;
    const [minX, minY, minZ] = bounds.minimum();
    const [maxX, maxY, maxZ] = bounds.maximum();
    expect(minX).toBeCloseTo(decoded.position[0] - radius, 8);
    expect(maxX).toBeCloseTo(decoded.position[0] + radius, 8);
    expect(minY).toBeCloseTo(decoded.position[1] - radius, 8);
    expect(maxY).toBeCloseTo(decoded.position[1] + radius, 8);
    expect(minZ).toBeCloseTo(decoded.position[2] - radius, 8);
    expect(maxZ).toBeCloseTo(decoded.position[2] + radius, 8);
  });

  it("keeps conservative bounds identical across rotations", () => {
    const prototype = {
      minimum: [-0.42, 0.18, -0.31],
      maximum: [0.38, 1.07, 0.29],
      contractionPivotYUnit: 0.42,
    } as const;
    const first = new DetailInstanceBounds();
    const second = new DetailInstanceBounds();
    const record = {
      ...RECORD,
      variant: 32,
      windPhase: 0.37,
      windResponse: 0.91,
    };
    first.add({ ...record, quaternion: yawQuaternion(0) }, prototype);
    second.add({
      ...record,
      quaternion: normalAlignedQuaternion({ x: 0.74, y: 0.22, z: -0.64 }, 2.1, 0.9),
    }, prototype);
    expect(second.minimum()).toEqual(first.minimum());
    expect(second.maximum()).toEqual(first.maximum());
  });

  it("encloses every authored vertex of a rotated, flattened rock", () => {
    const rock = buildRockPrototype("granite", 7);
    const radiusMeters = 3;
    const heightMeters = radiusMeters * 0.45;
    const record: DetailInstanceRecord = {
      ...RECORD,
      x: -27.25,
      y: 42.5,
      z: 91.75,
      quaternion: normalAlignedQuaternion({ x: 0.72, y: 0.4, z: -0.57 }, 1.1, 0.6),
      heightScaleMeters: heightMeters,
      radialScale: detailRadialScaleForWorldRadius(
        radiusMeters,
        heightMeters,
        rock.boundingRadius,
      ),
      variant: 0,
      windResponse: 0,
    };
    const bounds = new DetailInstanceBounds();
    bounds.add(record, rock.localBounds);
    const points = expectGeometryInsideBounds(rock, record, bounds);
    // The old y..y+height approximation clipped tilted rocks below their
    // placement point; make this regression test non-vacuous.
    expect(points.some(([, y]) => y < Math.fround(record.y) - 0.05)).toBe(true);
  });

  it("uses the concrete family prototype envelope for leaned family trees", () => {
    const generatedSpecies = "birch" as const;
    const prototypeSpecies = treePrototypeSpecies(generatedSpecies, "families");
    expect(prototypeSpecies).toBe("oak");
    const concreteCrown = buildTreePrototype(prototypeSpecies, 0, 7, "near").crown;
    const generatedCrown = buildTreePrototype(generatedSpecies, 0, 7, "near").crown;
    expect(concreteCrown.localBounds).not.toEqual(generatedCrown.localBounds);
    const heightMeters = 16;
    const record: DetailInstanceRecord = {
      ...RECORD,
      x: 130.25,
      y: 8.75,
      z: -240.5,
      quaternion: normalAlignedQuaternion({ x: 0.22, y: 0.95, z: -0.2 }, 0.77, 0.4),
      heightScaleMeters: heightMeters,
      radialScale: detailRadialScaleForWorldRadius(
        5.2,
        heightMeters,
        concreteCrown.boundingRadius,
      ),
      // High bits 001 select the shader's local-X character lean.
      variant: 32,
      windPhase: 0.37,
      windResponse: 0.82,
    };
    const bounds = new DetailInstanceBounds();
    bounds.add(record, {
      ...concreteCrown.localBounds,
      contractionPivotYUnit: 0.42,
    });
    expectGeometryInsideBounds(concreteCrown, record, bounds);
    const decoded = decodeInstance(record);
    const collapsedPivot = rotateByQuaternion(
      [0, decoded.height * 0.42, 0],
      decoded.quaternion,
    );
    const collapsedWorld = [
      decoded.position[0] + collapsedPivot[0],
      decoded.position[1] + collapsedPivot[1],
      decoded.position[2] + collapsedPivot[2],
    ] as const;
    const minimum = bounds.minimum();
    const maximum = bounds.maximum();
    for (let axis = 0; axis < 3; axis += 1) {
      expect(collapsedWorld[axis]).toBeGreaterThanOrEqual(minimum[axis]!);
      expect(collapsedWorld[axis]).toBeLessThanOrEqual(maximum[axis]!);
    }
  });

  it("bounds the shared far impostor from its species frame, not its quad quaternion", () => {
    const frame = { extentUnit: 0.62, centerYUnit: 0.55 } as const;
    const record: DetailInstanceRecord = {
      ...RECORD,
      quaternion: normalAlignedQuaternion({ x: 1, y: 0.1, z: -0.4 }, 2.2, 1),
      heightScaleMeters: 20,
      radialScale: 0.4,
      windResponse: 1,
    };
    const decoded = decodeInstance(record);
    const bounds = new DetailInstanceBounds();
    bounds.addBillboard(record, frame);
    const horizontalRadius = decoded.height * decoded.radial * frame.extentUnit;
    expect(bounds.minimum()).toEqual([
      decoded.position[0] - horizontalRadius - 0.01,
      decoded.position[1] + decoded.height * (frame.centerYUnit - frame.extentUnit) - 0.01,
      decoded.position[2] - horizontalRadius - 0.01,
    ]);
    expect(bounds.maximum()).toEqual([
      decoded.position[0] + horizontalRadius + 0.01,
      decoded.position[1] + decoded.height * (frame.centerYUnit + frame.extentUnit) + 0.01,
      decoded.position[2] + horizontalRadius + 0.01,
    ]);
  });
});
