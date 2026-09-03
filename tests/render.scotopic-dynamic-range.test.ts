import { describe, expect, it } from "vitest";
import { MAX_EXPOSURE, SCENE_UNIT_TO_NITS } from "../src/render/webgpu/nature/EnvironmentDirector";
import { readSource } from "./support/sourceText";
import {
  SCOTOPIC_HIGHLIGHT_GAIN,
  SCOTOPIC_HIGHLIGHT_KNEE,
} from "../src/render/webgpu/atmosphere/ScotopicVision";

/**
 * `7-4a`'s target, expressed so it cannot be argued about.
 *
 * `ScotopicVision`'s rod response is Naka-Rushton, `nits / (nits + sigma)`, with
 * sigma fed the SCENE KEY luminance rather than the physical adapted luminance
 * (`FlightRenderer.applyScotopicState`, commented there as deliberate). The scene
 * key is Lambertian ground under the frame's actual lights
 * (`AtmosphereSystem`), which is the same quantity the ground itself renders at.
 *
 * **So the curve auto-centres on the ground, and sigma cancels out of every
 * ratio.** Writing a scene value as `ground x 10^d`:
 *
 *     response(ground x 10^d) = (sigma x 10^d) / (sigma x 10^d + sigma)
 *                             = 10^d / (10^d + 1)
 *
 * — a pure function of `d`, independent of sigma, of `SCENE_UNIT_TO_NITS`, and of
 * the display gain (which cancels from a ratio of two outputs). **That is why
 * these assertions need no measured input and no duplicated constant.** The
 * earlier working quoted an absolute sweep and a measured sigma of 4.21 cd/m2;
 * both were correct and neither is necessary, and a test that imported them
 * would have been pinning a number instead of a property.
 *
 * The auto-centring is a REAL INVARIANT and 7-4a must not break it — it is what
 * makes moonlit ground land at the same output at every clock. **Do not "fix"
 * the response by feeding sigma the physical adapted luminance**; the third test
 * below shows why, and the plan's own phrasing invites exactly that change.
 */

/** `nits / (nits + sigma)`, written in decades relative to the ground. */
function responseAtGroundDecades(d: number): number {
  const relative = 10 ** d;
  return relative / (relative + 1);
}

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * `7-4a`'s SHIPPED output, in decades relative to the ground: the rod response
 * plus the highlight term. The display gain cancels from a ratio of two
 * responses but NOT once an additive term joins it, so this one carries it.
 */
function outputAtGroundDecades(d: number): number {
  const relative = 10 ** d;
  const excess = Math.max(relative - 1, 0);
  const highlight = SCOTOPIC_HIGHLIGHT_GAIN
    * smoothstep(0, SCOTOPIC_HIGHLIGHT_KNEE, excess)
    * Math.log2(1 + excess);
  return responseAtGroundDecades(d) * DISPLAY_GAIN + highlight;
}

/** `SCOTOPIC_MID_GREY_TARGET / MAX_EXPOSURE`, the gain the CPU precomputes. */
const DISPLAY_GAIN = 0.16 / MAX_EXPOSURE;

describe("7-4a: scotopic dynamic range", () => {
  it("ANCHOR — the math below models the SHIPPING shader, and fails if it stops doing so", () => {
    // Every other assertion in this file is arithmetic over `responseAtGroundDecades`,
    // which is a restatement, not the renderer. On its own that is a false pass
    // waiting to happen: change the shader's response and these stay green.
    // So tie the model to the artifact. If either of these two lines moves, the
    // model is stale and the rest of this file must be re-derived before it is
    // trusted again.
    const shader = readSource("src/render/webgpu/atmosphere/ScotopicVision.ts");
    expect(
      shader.includes("let sigma = max(uniforms.scotopicAdaptedLuminance, 1.0e-5);"),
      "the rod response no longer takes sigma from scotopicAdaptedLuminance",
    ).toBe(true);
    expect(
      shader.includes("let response = nits / (nits + sigma);"),
      "the rod response is no longer Naka-Rushton in the form this file models",
    ).toBe(true);
    // 7-4a's highlight term, read from the SHARP sample so a one-pixel source
    // is not smeared into the ground by the acuity blur before it is seen.
    expect(
      shader.includes("let highlightExcess = max(sharpNits - sigma, 0.0) / sigma;"),
      "the highlight term's excess is no longer measured against sigma",
    ).toBe(true);
    expect(
      shader.includes("dot(scene, SCOTOPIC_WEIGHTS)"),
      "the highlight term no longer reads the SHARP sample — a light point will "
      + "be smeared by the acuity blur before the response sees it",
    ).toBe(true);

    // And the auto-centring: the uniform is NAMED for adapted luminance but is
    // FED the scene key, which is the whole reason sigma cancels. This is the
    // wiring 7-4a must not casually 'correct'.
    const renderer = readSource("src/render/FlightRenderer.ts");
    expect(
      renderer.includes("adaptedLuminanceCdM2: snapshot.sceneKeyLuminanceCdM2,"),
      "sigma is no longer fed the SCENE KEY — the auto-centring invariant is gone",
    ).toBe(true);
  });

  it("INVARIANT — the rod curve auto-centres: ground half-saturates at every clock", () => {
    // The ground renders at the scene key, and sigma IS the scene key, so the
    // ground is always at exactly 50% of the rod ceiling regardless of the hour
    // or the moon's phase. 7-4a must preserve this.
    expect(responseAtGroundDecades(0)).toBeCloseTo(0.5, 12);
  });

  it("INVARIANT — the response depends only on the ratio to the ground, never on absolute scale", () => {
    // Sigma cancels: a uniform scale of the whole scene (exposure, moon
    // intensity, albedo) moves the ground and the source together and cannot
    // change their relative response. This is the reason a scene PRE-EXPOSURE
    // alone cannot repair the defect below — it is a no-op on this ratio unless
    // sigma is held fixed, and holding it fixed trades ground for sources
    // one-for-one rather than fixing anything.
    for (const scale of [1e-6, 1e-3, 1, 1e3, 1e6]) {
      const ground = scale;
      const source = scale * 1e3;
      const ratio = (source / (source + ground)) / (ground / (ground + ground));
      expect(ratio).toBeCloseTo(1.998, 3);
    }
  });

  it("FIXED by 7-4a — three decades of source brightness are now distinguishable", () => {
    // This was `PRE-FIX DEFECT — ... collapse to 1.0100:1`, pinning the defect
    // so the repair had a number it had to move. 7-4a moved it, so the
    // assertion is INVERTED here in the same commit, exactly as that pin
    // instructed. The pre-fix value is kept in the message because a fix whose
    // starting point is forgotten cannot be shown to have worked.
    const low = outputAtGroundDecades(2);
    const high = outputAtGroundDecades(5);
    const spread = high / low;

    // Pre-fix this ratio was 1.0100:1 — a runway edge light, a landing light
    // and the moon at indistinguishable brightness.
    expect(spread, "the light-source band collapsed again").toBeGreaterThan(1.7);
    expect(spread).toBeCloseTo(2.384, 2);

    // Every decade above the ground must step visibly, not just the endpoints.
    for (let d = 1; d <= 5; d += 1) {
      const step = outputAtGroundDecades(d) / outputAtGroundDecades(d - 1);
      expect(step, `decade ${d - 1} -> ${d} is not distinguishable`).toBeGreaterThan(1.2);
    }
  });

  it("7-4a did NOT disturb the ground: the response half-saturates as before", () => {
    // The highlight term is exactly zero at and below sigma, so the auto-centred
    // ground is untouched. This is the property the near-miss repair destroys.
    expect(outputAtGroundDecades(0)).toBeCloseTo(0.5 * DISPLAY_GAIN, 12);
    expect(responseAtGroundDecades(0)).toBeCloseTo(0.5, 12);
  });

  it("the near-miss repair makes it strictly worse, monotonically", () => {
    // The plan describes the defect as sigma half-saturating "at the scene's key
    // luminance, NOT the physical adapted luminance", which reads as an
    // instruction to substitute the physical value. Physical adapted luminance
    // at night is orders of magnitude BELOW the scene key, and shrinking sigma
    // pushes everything further into saturation: the spread over any fixed
    // absolute band falls monotonically toward 1.0, a uniform grey field that
    // passes every capture gate.
    const spreadForSigma = (sigma: number): number => {
      const lo = 0.01 * SCENE_UNIT_TO_NITS;
      const hi = 1000 * SCENE_UNIT_TO_NITS;
      return (hi / (hi + sigma)) / (lo / (lo + sigma));
    };
    const spreads = [4.21, 1.0, 0.05, 8.0e-5].map(spreadForSigma);
    for (let i = 1; i < spreads.length; i += 1) {
      expect(spreads[i]!, `spread must fall as sigma falls (index ${i})`)
        .toBeLessThan(spreads[i - 1]!);
    }
    // At the physically correct adapted luminance the image is flat.
    expect(spreads.at(-1)!).toBeCloseTo(1.0, 5);
  });

  it("the exposure ladder's docstring drift is real and 7-4a owns it", () => {
    // `MAX_EXPOSURE`'s docblock says it "evaluates to ~4.66 at the shipped
    // constants". It does not. Pinned so the repair cannot forget the docstring
    // while re-deriving the ladder.
    expect(MAX_EXPOSURE).toBeCloseTo(4.698026433055187, 12);
    expect(Math.abs(MAX_EXPOSURE - 4.66)).toBeGreaterThan(0.03);
  });
});
