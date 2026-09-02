import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Constants } from "@babylonjs/core/Engines/constants";
import { readSource } from "./support/sourceText";

/**
 * The inventory's per-texel arithmetic must read a texture's FORMAT, not only
 * its TYPE.
 *
 * **WHY THIS EXISTS, and it is not hypothetical.** `inventoryGpuMemoryMiB`
 * mapped `TEXTURETYPE_FLOAT` to 16 bytes per texel — correct for RGBA32F and
 * **four times too large for R32F**. The terrain height atlas is a 3696²
 * single-channel float storage texture, so the inventory reported it at
 * **208.44 MiB against a true 52.11**, and the renderer total read 488 MiB
 * against a true ~332 with a 495 MiB ceiling. **Headroom was reported as
 * −0.9 MiB when it was +163.** Three conclusions were drawn from the wrong
 * number, including a "live ceiling breach" that never existed.
 *
 * **Why it survived so long is the part worth guarding against.** The error is
 * a CONSTANT factor on ONE term, so `inventoried / estimated` held a stable
 * ratio across every shot — and that stability was read as evidence the
 * ESTIMATE omitted a whole category. The same observation, the opposite
 * conclusion, and the tightness that made it convincing is what a constant-
 * factor bug produces.
 *
 * **What this guard is and is not.** It cannot walk a built scene — that needs
 * WebGPU, and the Node suite has no device. So it asserts the ARITHMETIC
 * against the format constants, and separately asserts that the shipping
 * function READS the format at all, by reading its source. The second half is
 * the one that would have caught the original defect, because the arithmetic
 * was never wrong about RGBA — it was wrong about never asking.
 */

const SOURCE = readSource("src/render/FlightRenderer.ts");

/**
 * Source with comments removed.
 *
 * Every assertion below reads the IMPLEMENTATION, and a comment that explains
 * a defect necessarily names it — so an un-stripped match tests the
 * explanation rather than the code. That is not hypothetical: the first
 * version of the SHORT check passed against a mutation that deleted the SHORT
 * branch, because the comment above it says `TEXTURETYPE_SHORT`.
 */
const CODE_ONLY = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/\/\/[^\n]*/gu, " ");

/** The shipping table, restated here ONLY to be compared against the source. */
function expectedTexelBytes(type: number, format: number): number {
  const component = type === Constants.TEXTURETYPE_FLOAT
    || type === Constants.TEXTURETYPE_INT
    || type === Constants.TEXTURETYPE_UNSIGNED_INTEGER
    ? 4
    : type === Constants.TEXTURETYPE_HALF_FLOAT
      || type === Constants.TEXTURETYPE_SHORT
      || type === Constants.TEXTURETYPE_UNSIGNED_SHORT
      ? 2
      : 1;
  const channels = format === Constants.TEXTUREFORMAT_R
    || format === Constants.TEXTUREFORMAT_R_INTEGER
    ? 1
    : format === Constants.TEXTUREFORMAT_RG
      || format === Constants.TEXTUREFORMAT_RG_INTEGER
      ? 2
      : format === Constants.TEXTUREFORMAT_RGB
        || format === Constants.TEXTUREFORMAT_RGB_INTEGER
        ? 3
        : 4;
  return channels * component;
}

describe("the GPU memory inventory reads texture FORMAT, not only type", () => {
  it("reads `format` in the shipping per-texel arithmetic", () => {
    // THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT. Reading the
    // artifact, not modelling it: the old code destructured `type` and
    // `generateMipMaps` and never mentioned `format` anywhere in the walk.
    const raw = /private texelBytes\([^)]*\)[^{]*\{[\s\S]*?\n  \}/u.exec(SOURCE);
    expect(raw, "`texelBytes` is gone — the inventory's arithmetic moved").not.toBeNull();
    const walk: [string] = [CODE_ONLY(raw![0])];
    // ASSERT THE CONSTANTS, NOT THE WORD. The first version of this matched
    // /format/ and PASSED against a mutation that renamed the parameter to
    // `unusedFormat` and restored the type-only arithmetic — a guard against
    // false passes, containing one. A channel count cannot be computed without
    // naming the format constants, so naming them is the thing that cannot be
    // faked by an identifier.
    expect(
      walk![0],
      "the per-texel arithmetic never mentions TEXTUREFORMAT_R, so it cannot be "
      + "distinguishing single-channel textures — the defect that reported "
      + "208.44 MiB for a 52.11 MiB atlas",
    ).toMatch(/Constants\.TEXTUREFORMAT_R\b/u);
    expect(
      walk![0],
      "the arithmetic does not distinguish two-channel formats either",
    ).toMatch(/Constants\.TEXTUREFORMAT_RG\b/u);
    expect(
      walk![0],
      "it must still read the TYPE for the component width",
    ).toMatch(/Constants\.TEXTURETYPE_FLOAT/u);
    // And the component width must be the FLOAT width, not the RGBA32F total:
    // the mutation that caused this strengthening set it back to 16.
    expect(
      /\?\s*16\b/u.test(walk![0]),
      "a 16-byte component width is the RGBA32F total, not a float component — "
      + "that is the original bug",
    ).toBe(false);
  });

  it("prices R32F at a quarter of RGBA32F", () => {
    const r32f = expectedTexelBytes(Constants.TEXTURETYPE_FLOAT, Constants.TEXTUREFORMAT_R);
    const rgba32f = expectedTexelBytes(Constants.TEXTURETYPE_FLOAT, Constants.TEXTUREFORMAT_RGBA);
    expect(r32f).toBe(4);
    expect(rgba32f).toBe(16);
    expect(rgba32f / r32f).toBe(4);
  });

  it("reproduces the height atlas's true size and the size that was reported", () => {
    // The concrete numbers, pinned so the correction cannot quietly drift back.
    const EDGE = 3_696;
    const MIB = 1_048_576;
    const truth = EDGE * EDGE
      * expectedTexelBytes(Constants.TEXTURETYPE_FLOAT, Constants.TEXTUREFORMAT_R) / MIB;
    const asReported = EDGE * EDGE
      * expectedTexelBytes(Constants.TEXTURETYPE_FLOAT, Constants.TEXTUREFORMAT_RGBA) / MIB;
    expect(truth).toBeCloseTo(52.11, 1);
    expect(asReported).toBeCloseTo(208.44, 1);
    // And the estimate's own model agrees with the TRUTH, not the report —
    // which is how the defect was finally located.
    expect(asReported - truth).toBeCloseTo(156.33, 1);
  });

  it("covers every channel count the renderer actually creates", () => {
    // NON-VACUITY WITH TEETH: the table must distinguish the formats this
    // renderer really allocates. `CreateRStorageTexture` and `CreateRTexture`
    // appear at eight sites across terrain, water, detail and lighting; a
    // table that collapsed them to RGBA would pass every assertion above that
    // does not name a channel count.
    const byChannels = new Map<number, number>();
    for (const format of [
      Constants.TEXTUREFORMAT_R,
      Constants.TEXTUREFORMAT_RG,
      Constants.TEXTUREFORMAT_RGB,
      Constants.TEXTUREFORMAT_RGBA,
    ]) {
      byChannels.set(format, expectedTexelBytes(Constants.TEXTURETYPE_UNSIGNED_BYTE, format));
    }
    expect([...byChannels.values()]).toEqual([1, 2, 3, 4]);
    expect(
      new Set(byChannels.values()).size,
      "the channel table collapses distinct formats to one size",
    ).toBe(4);
  });

  it("names every texture TYPE the renderer creates, DERIVED from the source", () => {
    // THE ASSERTION THAT WOULD HAVE CAUGHT THE SECOND DEFECT. The first fix for
    // the format bug shipped with a 2x UNDER-count: `shoreDistance` is
    // `TEXTURETYPE_SHORT` and fell through a two-branch table to one byte.
    // Nothing named SHORT, so nothing failed — the same shape as the original,
    // in the repair.
    //
    // The type list is WALKED out of `src/`, not written here. A hand-kept list
    // of types is the identical hazard one level up: it would go stale the next
    // time someone creates a texture with a type nobody added to it.
    const used = new Set<string>();
    const walkDir = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) { walkDir(full); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        for (const m of readSource(full).matchAll(/Constants\.(TEXTURETYPE_[A-Z_]+)/gu)) {
          used.add(m[1]!);
        }
      }
    };
    walkDir("src");

    expect(used.size, "no texture types found — the walk is broken").toBeGreaterThan(1);

    // COMMENTS STRIPPED FIRST. Without this the check passed on a mutation
    // that deleted the SHORT branch, because the comment ABOVE the branch
    // explains the SHORT defect by name. A guard that reads prose as
    // implementation is the same error the comment is describing — third
    // instance tonight, and the only reason it was caught is that the control
    // was run before the guard was believed.
    const walkSource = CODE_ONLY(
      /private texelBytes\([^)]*\)[^{]*\{[\s\S]*?\n  \}/u.exec(SOURCE)![0],
    );
    const widths: Record<string, number> = {
      TEXTURETYPE_FLOAT: 4, TEXTURETYPE_INT: 4, TEXTURETYPE_UNSIGNED_INTEGER: 4,
      TEXTURETYPE_HALF_FLOAT: 2, TEXTURETYPE_SHORT: 2, TEXTURETYPE_UNSIGNED_SHORT: 2,
      TEXTURETYPE_UNSIGNED_BYTE: 1, TEXTURETYPE_BYTE: 1,
    };
    const unhandled: string[] = [];
    for (const name of [...used].sort()) {
      const width = widths[name];
      expect(width, `${name} is created in src/ and this test has no width for it`).toBeDefined();
      // One-byte types are the default branch and correctly go unnamed.
      if (width === 1) continue;
      if (!walkSource.includes(name)) unhandled.push(name);
    }
    expect(
      unhandled,
      "these types are created by the renderer and are NOT named in the "
      + "per-texel arithmetic, so each falls through to the one-byte default",
    ).toEqual([]);
  });

  it("treats RED and R as the same format, because Babylon does", () => {
    // Both are 6; RED_INTEGER and R_INTEGER are both 8. Pinned so a reader does
    // not add a duplicate branch for the alias and conclude the table is short.
    expect(Constants.TEXTUREFORMAT_RED).toBe(Constants.TEXTUREFORMAT_R);
    expect(Constants.TEXTUREFORMAT_RED_INTEGER).toBe(Constants.TEXTUREFORMAT_R_INTEGER);
    // `shoreDistance` is RED_INTEGER + SHORT: one channel, two bytes.
    expect(
      expectedTexelBytes(Constants.TEXTURETYPE_SHORT, Constants.TEXTUREFORMAT_RED_INTEGER),
    ).toBe(2);
  });

  it("defaults an undeclared format to four channels, the safe direction", () => {
    // A texture that never declared a format is Babylon-default RGBA, and for
    // a number used as a CEILING check, over-counting is the direction that
    // fails safe. Recorded as a deliberate choice rather than left implicit.
    expect(expectedTexelBytes(Constants.TEXTURETYPE_UNSIGNED_BYTE, -1)).toBe(4);
  });
});
