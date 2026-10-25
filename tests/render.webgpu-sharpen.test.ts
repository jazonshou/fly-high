import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { readSource } from "./support/sourceText";
import {
  FXAA_MOVED_SHARPEN_GAIN,
  FXAA_QUALITY,
  FXAA_RCAS_WGSL,
  RCAS_LIMIT,
  RCAS_SHARPEN_WGSL,
  rcasSharpen,
} from "../src/render/webgpu/lighting/SharpenPass";
import { resolveWebGpuQualityProfile, standaloneSharpen } from "../src/render/webgpu/core/QualityProfile";

/**
 * The final RCAS sharpen: the properties that decide whether it reads as
 * "sharper" or as "processed", and the chain position that decides whether it
 * runs at all. None of them is a screenshot.
 */

type Rgb = [number, number, number];
const grey = (value: number): Rgb => [value, value, value];

/** Deterministic, so a failure reproduces. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("RCAS is a no-op where it must be", () => {
  it("is the identity at amount 0", () => {
    const random = mulberry32(7);
    let worst = 0;
    for (let trial = 0; trial < 2_000; trial += 1) {
      const taps = Array.from({ length: 5 }, () => [random(), random(), random()] as Rgb);
      const out = rcasSharpen(taps[0]!, taps[1]!, taps[2]!, taps[3]!, taps[4]!, 0);
      for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(out[c]! - taps[0]![c]!));
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it("leaves a flat field untouched at full strength", () => {
    // Sky, haze and water at range are flat over five pixels; a sharpen that
    // moved them would shift the whole frame's tone.
    for (const value of [0, 0.02, 0.5, 0.98, 1]) {
      const flat = grey(value);
      const out = rcasSharpen(flat, flat, flat, flat, flat, 1);
      for (let c = 0; c < 3; c += 1) expect(Math.abs(out[c]! - value)).toBeLessThan(1e-12);
    }
  });
});

describe("RCAS cannot clip or go non-finite", () => {
  it("keeps every output in [0, 1] for any LDR neighbourhood", () => {
    // The guarantee RCAS is built on: the lobe is solved so the 5-tap kernel
    // cannot overshoot the display range. Random crosses, including saturated
    // ones, at every strength the profile can ask for.
    const random = mulberry32(42);
    const pick = () => {
      const r = random();
      // A third of taps pinned to the ends, where the guards matter.
      return r < 0.15 ? 0 : r > 0.85 ? 1 : random();
    };
    let lowest = Infinity;
    let highest = -Infinity;
    let nonFinite = 0;
    for (let trial = 0; trial < 20_000; trial += 1) {
      const taps = Array.from({ length: 5 }, () => [pick(), pick(), pick()] as Rgb);
      const amount = random();
      const out = rcasSharpen(taps[0]!, taps[1]!, taps[2]!, taps[3]!, taps[4]!, amount);
      for (const channel of out) {
        if (!Number.isFinite(channel)) nonFinite += 1;
        lowest = Math.min(lowest, channel);
        highest = Math.max(highest, channel);
      }
    }
    expect(nonFinite).toBe(0);
    expect(lowest).toBeGreaterThanOrEqual(-1e-9);
    expect(highest).toBeLessThanOrEqual(1 + 1e-9);
    // Non-vacuous: the sweep reached both ends of the range.
    expect(lowest).toBeLessThan(0.01);
    expect(highest).toBeGreaterThan(0.99);
  });

  it("is finite on all-black and all-white crosses (night sky, the sun)", () => {
    // AMD's approximate reciprocal turns these into 0 x inf; the shader's
    // guards are what keep a strict adapter from writing NaN.
    for (const centre of [0, 1]) {
      for (const ring of [0, 1]) {
        const out = rcasSharpen(grey(centre), grey(ring), grey(ring), grey(ring), grey(ring), 1);
        expect(out.every(Number.isFinite)).toBe(true);
      }
    }
  });
});

describe("RCAS is contrast-adaptive, which is why it does not ring", () => {
  /** How far the centre moved, as a fraction of its cross's contrast. */
  function relativeGain(low: number, high: number): number {
    const centre = (low + high) / 2 + (high - low) * 0.1;
    const out = rcasSharpen(grey(centre), grey(centre), grey(low), grey(high), grey(centre), 1);
    return (out[0] - centre) / (high - low);
  }

  it("sharpens a soft, low-contrast edge", () => {
    // Non-vacuous: without this, every test above is passed by the identity.
    expect(relativeGain(0.4, 0.5)).toBeGreaterThan(0.01);
  });

  it("backs off on an edge that is already hard", () => {
    // THE PROPERTY THE PASS WAS CHOSEN FOR. An unsharp mask's overshoot grows
    // with edge contrast, so it halos ridges against sky hardest; RCAS's lobe
    // shrinks instead. The ratio is the evidence: same geometry, ten times the
    // contrast, a fraction of the relative push.
    const soft = relativeGain(0.4, 0.5);
    const hard = relativeGain(0.05, 0.95);
    expect(hard).toBeGreaterThanOrEqual(0);
    expect(hard).toBeLessThan(soft * 0.5);
  });

  it("never exceeds AMD's lobe limit", () => {
    // A low-contrast cross is where the solved lobe is largest; at full
    // strength the clamp is what binds. Recover the lobe from the output.
    const n = 0.5;
    const e = 0.52;
    const out = rcasSharpen(grey(e), grey(n), grey(n), grey(n), grey(n), 1)[0];
    // out = (4wn + e)/(4w + 1)  ->  w = (e - out) / (4(out - n))
    const lobe = (e - out) / (4 * (out - n));
    expect(lobe).toBeLessThan(0);
    expect(-lobe).toBeLessThanOrEqual(RCAS_LIMIT + 1e-12);
  });

  it("halves the lobe on an isolated single-pixel spike", () => {
    // The denoise term. A lone bright pixel (a sub-pixel crown, a glint) has
    // noise = 1; its push is computed here by hand from AMD's equations:
    // lobe = max(-0.4/1.6, (1-0.6)/(1.6-4)) = -1/6, halved to -1/12, so the
    // output is (0.6 - 1.6/12) / (1 - 4/12) = 0.7. Undamped it would be 1.0.
    const out = rcasSharpen(grey(0.6), grey(0.4), grey(0.4), grey(0.4), grey(0.4), 1)[0];
    expect(out).toBeCloseTo(0.7, 10);
  });
});

describe("the shipped shader and the chain", () => {
  it("carries the tested lobe limit and both guards, in both forms", () => {
    for (const shader of [RCAS_SHARPEN_WGSL, FXAA_RCAS_WGSL]) {
      expect(shader).toContain(`-${RCAS_LIMIT.toFixed(6)}`);
      expect(shader).toContain("max(4.0 * mx4, vec3f(1e-5))");
      expect(shader).toContain("min(4.0 * mn4 - vec3f(4.0), vec3f(-1e-5))");
      expect(shader).toContain("1.0 - 0.5 * noise");
      expect(shader).toContain("uniforms.sharpenAmount");
    }
    // The fused pass's make-up gain on the pixels FXAA moved, capped at full
    // strength so the lobe stays inside the range RCAS is solved for.
    expect(FXAA_MOVED_SHARPEN_GAIN).toBeGreaterThan(1);
    expect(FXAA_MOVED_SHARPEN_GAIN).toBeLessThan(1.5);
    expect(FXAA_RCAS_WGSL).toContain(
      `min(1.0, uniforms.sharpenAmount * ${FXAA_MOVED_SHARPEN_GAIN.toFixed(2)})`,
    );
  });

  it("is ratio 1 and single-sampled", () => {
    // A downsampling sharpen would blur, and it can never be the chain head.
    const source = readSource("src/render/webgpu/lighting/SharpenPass.ts");
    const ctor = /this\.postProcess = new PostProcess\(([\s\S]*?)\);/.exec(source)?.[1];
    expect(ctor, "could not find the sharpen constructor").toBeTruthy();
    expect(/,\s*1,\s*camera,/.test(ctor!)).toBe(true);
    expect(source).toContain("this.postProcess.samples = 1;");
  });

  const renderer = readSource("src/render/FlightRenderer.ts");

  it("is constructed after the tone map, FXAA first, so whichever runs is last", () => {
    // Construction order is attachment order is render order.
    const toneMap = renderer.indexOf("new ImageProcessingPostProcess(");
    const fxaa = renderer.indexOf("new FxaaSharpenPass(");
    const sharpen = renderer.indexOf("new SharpenPass(");
    expect(toneMap).toBeGreaterThan(-1);
    expect(fxaa, "FXAA is not constructed after the tone map").toBeGreaterThan(toneMap);
    expect(sharpen, "the standalone sharpen is not constructed after FXAA").toBeGreaterThan(fxaa);
    // Babylon's own FXAA would be a second, unsharpened FXAA in the chain.
    expect(renderer).not.toContain("FxaaPostProcess");
  });

  it("detaches both final passes on a profile change before re-attaching the profile's one", () => {
    // Babylon appends on attach. Re-attaching one with the other still on
    // would leave the wrong one last.
    const sharpenOff = renderer.indexOf("this.sharpen.setEnabled(this.camera, false);");
    const fxaaOff = renderer.indexOf("this.fxaa.setEnabled(this.camera, false);", sharpenOff);
    const fxaaOn = renderer.indexOf(
      "this.fxaa.setEnabled(this.camera, this.profile.msaaSamples === 1);",
      fxaaOff,
    );
    const sharpenOn = renderer.indexOf(
      "this.sharpen.setEnabled(this.camera, standaloneSharpen(this.profile));",
      fxaaOff,
    );
    expect(sharpenOff, "applyProfile does not detach the standalone sharpen").toBeGreaterThan(-1);
    expect(fxaaOff, "applyProfile does not detach FXAA").toBeGreaterThan(sharpenOff);
    expect(fxaaOn, "FXAA is not re-attached after both come off").toBeGreaterThan(fxaaOff);
    expect(sharpenOn, "the sharpen is not re-attached after both come off").toBeGreaterThan(fxaaOff);
    // The fused pass takes the profile's strength before it can draw with it.
    expect(renderer.indexOf("this.fxaa.setAmount(this.profile.sharpenAmount);", fxaaOff))
      .toBeGreaterThan(fxaaOff);
  });

  it("rides inside FXAA wherever FXAA runs, and is a pass of its own only where it does not", () => {
    // The point of the fused form: a sharpened FXAA tier pays for one
    // full-screen pass, not two. And no tier runs both forms, or neither while
    // asking for a sharpen.
    let fused = 0;
    for (const quality of ["low", "medium", "high"] as const) {
      for (const mode of ["performance", "balanced", "ultra"] as const) {
        const profile = resolveWebGpuQualityProfile(quality, mode);
        const fxaaRuns = profile.msaaSamples === 1;
        expect(standaloneSharpen(profile)).toBe(!fxaaRuns && profile.sharpenAmount > 0);
        if (fxaaRuns && profile.sharpenAmount > 0) fused += 1;
      }
    }
    expect(fused, "no profile exercises the fused form").toBeGreaterThan(0);
    expect(standaloneSharpen(resolveWebGpuQualityProfile("medium", "balanced"))).toBe(false);
  });

  it("has a valid strength on every tier, stronger where FXAA runs", () => {
    // FXAA tiers lose more acutance (the FXAA blur plus a lower render scale),
    // so they get the stronger sharpen.
    const tiers = new Set<number>();
    for (const quality of ["low", "medium", "high"] as const) {
      for (const mode of ["performance", "balanced", "ultra"] as const) {
        const profile = resolveWebGpuQualityProfile(quality, mode);
        tiers.add(profile.tier);
        expect(profile.sharpenAmount).toBeGreaterThanOrEqual(0);
        expect(profile.sharpenAmount).toBeLessThanOrEqual(1);
      }
    }
    expect(tiers.size, "the sweep did not reach every tier").toBe(4);
    const fxaaTier = resolveWebGpuQualityProfile("medium", "balanced");
    const msaaTier = resolveWebGpuQualityProfile("high", "ultra");
    expect(fxaaTier.msaaSamples).toBe(1);
    expect(msaaTier.msaaSamples).toBeGreaterThan(1);
    expect(fxaaTier.sharpenAmount).toBeGreaterThan(msaaTier.sharpenAmount);
  });
});

describe("the fused FXAA pass is Babylon's FXAA", () => {
  // The installed Babylon's shipped WGSL, which the fused pass ports. Read as
  // text: it is a generated module whose export is marked internal.
  const require = createRequire(import.meta.url);
  const babylonFxaa = readFileSync(
    require.resolve("@babylonjs/core/ShadersWGSL/fxaa.fragment.js"),
    "utf8",
  );
  const compact = (text: string) => text.replace(/\s+/g, "");

  it("runs at Babylon's quality settings", () => {
    expect(babylonFxaa).toContain(`fxaaQualitySubpix: f32=${FXAA_QUALITY.subpix.toFixed(1)};`);
    expect(babylonFxaa).toContain(`fxaaQualityEdgeThreshold: f32=${FXAA_QUALITY.edgeThreshold};`);
    expect(babylonFxaa).toContain(`fxaaQualityEdgeThresholdMin: f32=${FXAA_QUALITY.edgeThresholdMin};`);
    expect(compact(FXAA_RCAS_WGSL)).toContain(`fxaaQualityEdgeThreshold:f32=${FXAA_QUALITY.edgeThreshold};`);
    expect(compact(FXAA_RCAS_WGSL)).toContain(`fxaaQualityEdgeThresholdMin:f32=${FXAA_QUALITY.edgeThresholdMin};`);
    expect(compact(FXAA_RCAS_WGSL)).toContain(`fxaaQualitySubpix:f32=${FXAA_QUALITY.subpix.toFixed(1)};`);
  });

  it("weighs luma and walks the edge as Babylon's does", () => {
    // The luma weights and the three search steps (1.5, 3 and 12 texels) are
    // what decide which pixels FXAA moves and how far; a port that drifted on
    // any of them would anti-alias differently while compiling fine.
    expect(babylonFxaa).toContain("vec3f(0.2126,0.7152,0.0722)");
    expect(compact(FXAA_RCAS_WGSL)).toContain("vec3f(0.2126,0.7152,0.0722)");
    for (const step of ["offNP.x*1.5", "offNP.x*3.0", "offNP.x*12.0"]) {
      expect(babylonFxaa, `Babylon's FXAA no longer steps ${step}`).toContain(step);
    }
    for (const step of ["offNP*1.5", "offNP*3.0", "offNP*12.0"]) {
      expect(compact(FXAA_RCAS_WGSL)).toContain(step);
    }
    expect(compact(FXAA_RCAS_WGSL)).toContain("(subpixA*(1.0/12.0))-lumaM");
    expect(compact(FXAA_RCAS_WGSL)).toContain("gradient*1.0/4.0");
  });

  it("compiles RCAS in only when asked, so a zero amount is FXAA alone", () => {
    const rcasCall = FXAA_RCAS_WGSL.indexOf("rcasSharpen(colour.rgb");
    const gain = FXAA_RCAS_WGSL.indexOf("let amount = select(");
    const ifdef = FXAA_RCAS_WGSL.lastIndexOf("#ifdef RCAS_SHARPEN", rcasCall);
    const endif = FXAA_RCAS_WGSL.indexOf("#endif", rcasCall);
    expect(rcasCall).toBeGreaterThan(-1);
    expect(ifdef, "the RCAS call is not inside #ifdef RCAS_SHARPEN").toBeGreaterThan(-1);
    expect(gain, "the make-up gain is not inside #ifdef RCAS_SHARPEN").toBeGreaterThan(ifdef);
    expect(endif).toBeGreaterThan(rcasCall);
  });
});
