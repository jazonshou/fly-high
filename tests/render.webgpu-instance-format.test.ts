import { describe, expect, it } from "vitest";
import {
  DETAIL_INSTANCE_ATTRIBUTES,
  DETAIL_INSTANCE_HEIGHT_MAX_METERS,
  DETAIL_INSTANCE_RADIAL_MAX,
  DETAIL_INSTANCE_RADIAL_MIN,
  DETAIL_INSTANCE_STRIDE_BYTES,
  DetailInstanceBounds,
  DetailInstanceWriter,
  yawQuaternion,
  type DetailInstanceRecord,
} from "../src/render/webgpu/detail/instanceFormat";
import { DYNAMIC_ALLOCATIONS } from "../src/render/webgpu/core/PerformanceBudget";

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

  it("accumulates generator bounds with the wind extent as an explicit term", () => {
    const bounds = new DetailInstanceBounds();
    expect(bounds.isEmpty).toBe(true);
    bounds.add(RECORD, 1.5);
    expect(bounds.isEmpty).toBe(false);
    const [minX, minY] = bounds.minimum();
    const [maxX, maxY] = bounds.maximum();
    // Radius = height × max(radial, 1) + sway.
    expect(maxX - RECORD.x).toBeCloseTo(12 * 1.05 + 1.5, 5);
    expect(RECORD.x - minX).toBeCloseTo(12 * 1.05 + 1.5, 5);
    expect(minY).toBeCloseTo(RECORD.y - 1.5, 5);
    expect(maxY).toBeCloseTo(RECORD.y + 12 + 1.5, 5);
  });
});
