import { describe, expect, it } from "vitest";
import { readSource } from "./support/sourceText";
import {
  TerrainErosionReadbackFaultError,
  decodeOrderableFloatBits,
  terrainErosionOrderableReadbackFaultIndex,
} from "../src/render/webgpu/terrain/TerrainPageErosion";

/**
 * The readback fault that misdirected four separate agents.
 *
 * A GPU readback whose copy has not been submitted when its map resolves comes
 * back as ZEROS rather than raising. Zero then decodes to `~0 >>> 0` =
 * 0xFFFFFFFF = NaN, the NaN flows into the MFD stage, and the run dies hundreds
 * of lines away with "drainageHeight[0] must be finite" — a message naming a
 * symptom in another subsystem. Four Gate W / Wave agents each attributed it to
 * host contention before the mechanism was pinned.
 *
 * What makes it detectable at all is an arithmetic property of the encoding,
 * proven below rather than assumed: `pOrderableEncode` maps a positive float to
 * `bits | 0x80000000` (high bit always set) and a negative one to `~bits` (zero
 * only for the NaN payload 0xFFFFFFFF), so **zero is not a legal encoding of any
 * finite float**.
 */

/** The WGSL `pOrderableEncode`, restated so the test proves the real mapping. */
function orderableEncode(value: number): number {
  const bits = new Uint32Array(new Float32Array([value]).buffer)[0]!;
  return (bits & 0x8000_0000) !== 0 ? (~bits >>> 0) : (bits | 0x8000_0000) >>> 0;
}

describe("erosion orderable readback fault", () => {
  it("proves zero is unreachable for any finite float, which is what makes the fault detectable", () => {
    const probes = [
      0, -0, 1, -1, 0.5, -0.5, 1e-30, -1e-30, 1e30, -1e30,
      Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE,
      3.4028234663852886e38, -3.4028234663852886e38, 8_848, -11_034, 1 / 3, -(1 / 3),
    ];
    for (const value of probes) {
      expect(orderableEncode(value), `${value} must not encode to zero`).not.toBe(0);
    }
    // A dense sweep, so the claim is not resting on hand-picked probes.
    for (let index = 0; index < 20_000; index += 1) {
      const value = Math.tan(index * 0.7331) * 10 ** ((index % 60) - 30);
      if (!Number.isFinite(value)) continue;
      expect(orderableEncode(value)).not.toBe(0);
    }
    // Zero IS reachable — but only from the one NaN payload, which is not data.
    expect(orderableEncode(Number.NaN)).not.toBe(0);
    const nanPayload = new Float32Array(new Uint32Array([0xffff_ffff]).buffer)[0]!;
    expect(Number.isNaN(nanPayload)).toBe(true);
    expect(orderableEncode(nanPayload)).toBe(0);
  });

  it("locates a faulted readback and leaves a legal one alone", () => {
    const legal = Uint32Array.from([1.5, -2.5, 0, -0, 1e12].map(orderableEncode));
    expect(terrainErosionOrderableReadbackFaultIndex(legal)).toBe(-1);
    expect(terrainErosionOrderableReadbackFaultIndex(new Uint32Array(64))).toBe(0);
    const partial = Uint32Array.from(legal);
    partial[3] = 0;
    expect(terrainErosionOrderableReadbackFaultIndex(partial)).toBe(3);
  });

  it("decodes legal buffers exactly, and refuses faulted ones by naming the cause", () => {
    // Compared against the f32-rounded value: the buffer is f32, so 1e-20 and
    // -1e20 are not the f64 literals and never were.
    const values = [0, -0, 1.5, -2.5, 1e-20, -1e20, 8_848.25].map(Math.fround);
    const decoded = decodeOrderableFloatBits(Uint32Array.from(values.map(orderableEncode)));
    for (let index = 0; index < values.length; index += 1) {
      expect(Object.is(decoded[index], values[index])).toBe(true);
    }

    // The regression this file exists for: WITHOUT the guard this returned a
    // buffer of NaN and the failure surfaced in another subsystem.
    let thrown: unknown;
    try {
      decodeOrderableFloatBits(new Uint32Array(16));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TerrainErosionReadbackFaultError);
    expect(String(thrown)).toMatch(/did not land/);
    // It must name the READBACK, not the arithmetic — the old message pointed
    // at drainage height, which is why it misdirected.
    expect(String(thrown)).not.toMatch(/drainageHeight/);
  });

  it("keeps the producer's reads serialized and its recovery in place", () => {
    const source = readFileSyncSafe(
      "src/render/webgpu/terrain/TerrainPageErosionGpu.ts",
    );
    // Four concurrent reads are what raced the staging machinery.
    const mfdStage = source.slice(
      source.indexOf("private async runReadbackAndMfd"),
      source.indexOf("private async runEvolvedReadbackAndFinish"),
    );
    expect(mfdStage.length).toBeGreaterThan(0);
    // The CALL, not the word — the comment explaining the fix says "Promise.all".
    expect(mfdStage).not.toMatch(/await\s+Promise\.all/);
    expect(mfdStage).toContain("terrainErosionOrderableReadbackFaultIndex");
  });
});

function readFileSyncSafe(path: string): string {
  return readSource(path);
}
