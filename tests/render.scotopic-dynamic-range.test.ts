import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_EXPOSURE, SCENE_UNIT_TO_NITS } from "../src/render/webgpu/nature/EnvironmentDirector";

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

describe("7-4a: scotopic dynamic range", () => {
  it("ANCHOR — the math below models the SHIPPING shader, and fails if it stops doing so", () => {
    // Every other assertion in this file is arithmetic over `responseAtGroundDecades`,
    // which is a restatement, not the renderer. On its own that is a false pass
    // waiting to happen: change the shader's response and these stay green.
    // So tie the model to the artifact. If either of these two lines moves, the
    // model is stale and the rest of this file must be re-derived before it is
    // trusted again.
    const shader = readFileSync("src/render/webgpu/atmosphere/ScotopicVision.ts", "utf8");
    expect(
      shader.includes("let sigma = max(uniforms.scotopicAdaptedLuminance, 1.0e-5);"),
      "the rod response no longer takes sigma from scotopicAdaptedLuminance",
    ).toBe(true);
    expect(
      shader.includes("let response = nits / (nits + sigma);"),
      "the rod response is no longer Naka-Rushton in the form this file models",
    ).toBe(true);

    // And the auto-centring: the uniform is NAMED for adapted luminance but is
    // FED the scene key, which is the whole reason sigma cancels. This is the
    // wiring 7-4a must not casually 'correct'.
    const renderer = readFileSync("src/render/FlightRenderer.ts", "utf8");
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

  it("PRE-FIX DEFECT — three decades of light-source brightness collapse to 1.0100:1", () => {
    // NOT a property being protected. This is the defect 7-4a exists to remove,
    // pinned so the repair has a number it must move. A runway edge light, a
    // landing light and the moon sit roughly 2 to 5 decades above the ground
    // and all land inside the top 1% of the curve, so they render at
    // indistinguishable brightness.
    //
    // WHEN 7-4a LANDS THIS TEST MUST FAIL, and it must be updated in the same
    // commit with the new measured spread. A green assertion quietly pinning a
    // defect as correct is what let the inverted winding survive; this one says
    // in its own name that it is pinning a defect.
    const low = responseAtGroundDecades(2);
    const high = responseAtGroundDecades(5);
    expect(high / low).toBeCloseTo(1.00998990, 6);

    // The target 7-4a is aiming at, recorded but deliberately NOT asserted —
    // asserting it now would be a red test masquerading as a plan. The highlight
    // term must give three decades of source brightness a spread a viewer can
    // see; the working figure is a per-decade step of at least 1.2x, i.e. a
    // spread above 1.7:1 across those same three decades.
    expect(high / low).toBeLessThan(1.7);
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
