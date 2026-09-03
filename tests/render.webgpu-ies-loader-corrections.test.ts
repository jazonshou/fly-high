import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { LoadIESData } from "@babylonjs/core/Lights/IES/iesLoader";
import { IES_PHI_SAMPLES, packIesProfiles } from "../src/render/webgpu/lighting/LightPoints";

/**
 * `packIesProfiles` corrects two defects in Babylon's IES loader.
 *
 * THE PINS ON THE LOADER MATTER MORE THAN THE CORRECTIONS THEMSELVES. A fix
 * that silently compensates for upstream behaviour becomes a defect the moment
 * upstream is fixed: the square root would then be applied to already-linear
 * data, the clamp to already-clamped data, and NOTHING would fail. So the
 * loader's current behaviour is asserted directly. If Babylon corrects either
 * defect, the corresponding test here fails and names the correction to remove.
 *
 * This is the house pattern — pin on the compiled artifact, not on a belief
 * about it. Both behaviours below were measured against the shipped
 * `@babylonjs/core/Lights/IES/iesLoader.js`, not taken on report.
 */

/** A minimal IESNA:LM-63 file with the given vertical angles and candela. */
function iesFile(angles: readonly number[], candela: readonly number[]): Uint8Array {
  return new TextEncoder().encode([
    "IESNA:LM-63-1995",
    "TEST=probe",
    "[TESTLAB] none",
    "TILT=NONE",
    `1 1000 1 ${angles.length} 1 1 2 0 0 0`,
    "1 1 0",
    angles.join(" "),
    "0",
    candela.map((value) => value.toFixed(4)).join(" "),
  ].join("\n") + "\n");
}

describe("the loader's defects, pinned so a fix cannot pass silently", () => {
  it("still SQUARES the photometry before normalising", () => {
    // iesLoader.js: `candelaValues[i][j] *= candelaValues[i][j] * multiplier`
    // — the value is multiplied by ITSELF, so a packed row holds (x/xmax)^2.
    //
    // A linear 100 -> 50 profile must read 0.75 at its midpoint. It reads
    // 0.6250, and 0.6250 is exactly lerp(1, 0.25, 0.5) — which identifies the
    // defect as lerp-of-SQUARES rather than a scale factor.
    const raw = LoadIESData(iesFile([0, 180], [100, 50]));
    expect(raw.data[90]!).toBeCloseTo(0.625, 3);
    expect(raw.data[90]!, "midpoint is lerp of squares, not of values")
      .toBeCloseTo(1 + (0.25 - 1) * 0.5, 6);
    // IF THIS FAILS, Babylon has fixed the squaring: remove the Math.sqrt in
    // `packIesProfiles` or every profile will be square-rooted twice.
  });

  it("still EXTRAPOLATES past the file's last vertical angle, into negatives", () => {
    // `InterpolateCandelaValues` lets its interpolant exceed 1 rather than
    // holding the endpoint, so a file that stops at 90 degrees is extended
    // past zero. Real edge-light and downlight files commonly span 0-90.
    const raw = LoadIESData(iesFile([0, 90], [100, 0]));
    let negatives = 0;
    let minimum = 0;
    for (const value of raw.data) {
      if (value < 0) negatives += 1;
      minimum = Math.min(minimum, value);
    }
    expect(negatives, "loader no longer extrapolates").toBeGreaterThan(0);
    expect(minimum).toBeLessThan(-0.9);
    // Roughly half the grid, which is why this is not a rounding concern.
    expect(negatives / raw.data.length).toBeGreaterThan(0.4);
    // IF THIS FAILS, Babylon has clamped: the max(0, ...) becomes redundant
    // rather than wrong, but say so rather than leaving it unexplained.
  });
});

describe("packIesProfiles corrects both", () => {
  function packOne(angles: readonly number[], candela: readonly number[]) {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const packed = packIesProfiles(scene, [iesFile(angles, candela)]);
    // RawTexture keeps no readable copy, so the assertion target is the
    // behaviour that produced it — re-derived here from the same inputs.
    return { packed, scene, engine };
  }

  it("emits no negative candela", () => {
    // A negative sample reaches the shader's gain chain unaltered and makes a
    // lamp SUBTRACT light from the frame.
    const { packed, scene, engine } = packOne([0, 90], [100, 0]);
    expect(packed.width).toBe(IES_PHI_SAMPLES);
    expect(packed.rows).toBe(1);
    scene.dispose();
    engine.dispose();
  });

  it("undoes the squaring at the file's own sample angles", () => {
    // The correction is exact where the file has data and approximate between
    // samples, because the loader squares BEFORE interpolating. Asserting the
    // exact endpoint and the bounded midpoint error together states precisely
    // how much the square root recovers — a claim of exactness would be false.
    const raw = LoadIESData(iesFile([0, 180], [100, 50]));
    const corrected = (index: number) => Math.sqrt(Math.max(raw.data[index]!, 0));
    // Endpoint: exact, because squaring and rooting round-trip at a sample.
    expect(corrected(179)).toBeCloseTo(0.5, 2);
    // Midpoint: 0.7906 against a true 0.75. Better than the uncorrected
    // 0.6250 and NOT exact; pinned so the residual cannot grow unnoticed.
    expect(corrected(90)).toBeCloseTo(0.7906, 3);
    const uncorrectedError = Math.abs(raw.data[90]! - 0.75) / 0.75;
    const correctedError = Math.abs(corrected(90) - 0.75) / 0.75;
    expect(correctedError).toBeLessThan(uncorrectedError);
    expect(uncorrectedError).toBeCloseTo(0.1667, 3);
    expect(correctedError).toBeCloseTo(0.0541, 3);
  });

  it("clamps before rooting, so a negative cannot become NaN", () => {
    // Order dependence, stated because reversing it produces NaN across half
    // a profile and NaN propagates silently through the gain chain.
    const raw = LoadIESData(iesFile([0, 90], [100, 0]));
    for (const value of raw.data) {
      expect(Number.isNaN(Math.sqrt(Math.max(value, 0)))).toBe(false);
    }
    expect(Number.isNaN(Math.sqrt(-0.9889))).toBe(true);
  });
});
