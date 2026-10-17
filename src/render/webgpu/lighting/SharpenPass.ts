import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Camera } from "@babylonjs/core/Cameras/camera";

/**
 * The final sharpen (owner: lighting, beside bloom — the other display-side
 * pass).
 *
 * WHY IT EXISTS. Every tier presents an image softer than its own raster:
 *
 *  - Tiers 0 and 1 render at 0.72 / 0.86 of the capped pixel budget and run
 *    FXAA, which is a blur along every edge it finds and a mild blur on any
 *    high-contrast texture it mistakes for one.
 *  - Every tier is then UPSCALED by the browser's bilinear canvas scaling,
 *    because `maxRenderPixels` caps the raster below the panel: tier 1 on a
 *    1,728x1,117-point Retina panel draws ~1.5 Mpx for a 7.7 Mpx display, a
 *    2.3x stretch per axis.
 *
 * Neither can be bought back with pixels at the frame budget the tiers hold,
 * so this pass restores acutance instead: AMD FidelityFX's robust
 * contrast-adaptive sharpening (RCAS, the sharpen half of FSR 1), applied as
 * the LAST pass so it also counteracts FXAA.
 *
 * WHY RCAS AND NOT AN UNSHARP MASK. RCAS solves, per pixel, for the largest
 * negative lobe that cannot clip, and that lobe shrinks as the 5-tap cross's
 * contrast grows: soft, low-contrast detail (ground texture under FXAA and the
 * upscale) gets the full lobe, while an edge that is already hard (a ridge
 * against sky, a wing edge, a runway marking) gets little. An unsharp mask
 * does the opposite and rings hardest exactly there, which is the "processed"
 * look this pass must not add. The noise term (`FSR_RCAS_DENOISE` in AMD's
 * source) halves the lobe on isolated single-pixel spikes, so sub-pixel
 * foliage and alpha-tested crowns are not amplified into shimmer.
 *
 * COST. Five bilinear taps at texel centres and a few dozen ALU per pixel at
 * the render raster, plus one LDR target: the chain's previous last pass
 * (FXAA, or the tone map at multisampled tiers) now renders into this pass's
 * input instead of the swapchain.
 *
 * ORDER. It must stay last. `FlightRenderer.applyProfile` re-attaches FXAA on
 * a profile change, and Babylon appends; the pass is detached first and
 * re-attached after, so the chain cannot end up FXAA-after-sharpen.
 */

const SHARPEN_SHADER = "aerolithRcasSharpen";

/**
 * The largest negative lobe RCAS allows: 0.25 - 1/16, AMD's `FSR_RCAS_LIMIT`.
 * At 0.25 the kernel's denominator reaches zero; the 1/16 is AMD's margin.
 */
export const RCAS_LIMIT = 0.25 - 1 / 16;

type Rgb = readonly [number, number, number];

/** AMD's luma: 0.5 R + G + 0.5 B. Only ever used as a ratio, so its scale is free. */
function rcasLuma(colour: Rgb): number {
  return colour[2] * 0.5 + (colour[0] * 0.5 + colour[1]);
}

/**
 * CPU twin of the WGSL below, channel for channel, so the properties the pass
 * is relied on for are testable without a GPU: identity at amount 0, flat
 * fields untouched, no clipping out of [0, 1], and a lobe that backs off at
 * hard edges.
 *
 * Inputs are display-referred, in [0, 1]: the pass runs after the tone map.
 */
export function rcasSharpen(
  centre: Rgb,
  north: Rgb,
  west: Rgb,
  east: Rgb,
  south: Rgb,
  amount: number,
): [number, number, number] {
  const lobeChannels = [0, 1, 2].map((c) => {
    const mn4 = Math.min(north[c]!, west[c]!, east[c]!, south[c]!);
    const mx4 = Math.max(north[c]!, west[c]!, east[c]!, south[c]!);
    const e = centre[c]!;
    // The two guards are the WGSL's: AMD's approximate reciprocal turns a
    // black (mx4 = 0) or white (mn4 = 1) cross into 0 x inf, which is NaN on
    // a strict adapter. Black or white crosses are the night sky and the sun.
    const hitMin = Math.min(mn4, e) / Math.max(4 * mx4, 1e-5);
    const hitMax = (1 - Math.max(mx4, e)) / Math.min(4 * mn4 - 4, -1e-5);
    return Math.max(-hitMin, hitMax);
  });
  let lobe = Math.max(-RCAS_LIMIT, Math.min(Math.max(...lobeChannels), 0)) * amount;
  const lumas = [north, west, centre, east, south].map(rcasLuma);
  const range = Math.max(...lumas) - Math.min(...lumas);
  const noise = Math.min(
    1,
    Math.max(
      0,
      Math.abs(0.25 * (lumas[0]! + lumas[1]! + lumas[3]! + lumas[4]!) - lumas[2]!)
        / Math.max(range, 1e-5),
    ),
  );
  lobe *= 1 - 0.5 * noise;
  const denominator = 4 * lobe + 1;
  return [0, 1, 2].map((c) =>
    (lobe * (north[c]! + west[c]! + east[c]! + south[c]!) + centre[c]!) / denominator,
  ) as [number, number, number];
}

export const RCAS_SHARPEN_WGSL = `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

uniform sharpenAmount: f32;

fn rcasTap(uv: vec2f, offset: vec2f, texel: vec2f) -> vec3f {
  // Explicit level 0: the input has no mip chain and the taps land on texel
  // centres, so this is an exact load through the bilinear sampler.
  return textureSampleLevel(textureSampler, textureSamplerSampler, uv + offset * texel, 0.0).rgb;
}

fn rcasLuma(colour: vec3f) -> f32 {
  return colour.b * 0.5 + (colour.r * 0.5 + colour.g);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let uv = fragmentInputs.vUV;
  let texel = 1.0 / vec2f(textureDimensions(textureSampler, 0));
  let b = rcasTap(uv, vec2f(0.0, -1.0), texel);
  let d = rcasTap(uv, vec2f(-1.0, 0.0), texel);
  let e = rcasTap(uv, vec2f(0.0, 0.0), texel);
  let f = rcasTap(uv, vec2f(1.0, 0.0), texel);
  let h = rcasTap(uv, vec2f(0.0, 1.0), texel);
  let mn4 = min(min(b, d), min(f, h));
  let mx4 = max(max(b, d), max(f, h));
  // Guarded where AMD's approximate reciprocal is not: see rcasSharpen.
  let hitMin = min(mn4, e) / max(4.0 * mx4, vec3f(1e-5));
  let hitMax = (vec3f(1.0) - max(mx4, e)) / min(4.0 * mn4 - vec3f(4.0), vec3f(-1e-5));
  let lobeRgb = max(-hitMin, hitMax);
  var lobe = max(-${RCAS_LIMIT.toFixed(6)}, min(max(lobeRgb.r, max(lobeRgb.g, lobeRgb.b)), 0.0))
    * uniforms.sharpenAmount;
  let bL = rcasLuma(b);
  let dL = rcasLuma(d);
  let eL = rcasLuma(e);
  let fL = rcasLuma(f);
  let hL = rcasLuma(h);
  let range = max(max(max(bL, dL), max(eL, fL)), hL) - min(min(min(bL, dL), min(eL, fL)), hL);
  let noise = clamp(abs(0.25 * (bL + dL + fL + hL) - eL) / max(range, 1e-5), 0.0, 1.0);
  lobe = lobe * (1.0 - 0.5 * noise);
  let sharpened = (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
  fragmentOutputs.color = vec4f(sharpened, 1.0);
  return fragmentOutputs;
}
`;

function registerShaders(): void {
  ShaderStore.ShadersStoreWGSL[`${SHARPEN_SHADER}FragmentShader`] = RCAS_SHARPEN_WGSL;
}

/**
 * The single sharpen pass. Construct it LAST in the chain (after FXAA):
 * Babylon orders a camera's post-processes by attachment order.
 */
export class SharpenPass {
  readonly postProcess: PostProcess;
  private amount = 0;
  private attached = true;

  get enabled(): boolean {
    return this.attached;
  }

  constructor(camera: Camera, engine: AbstractEngine, amount: number) {
    registerShaders();
    // Ratio 1 and single-sampled: it can never be the chain head (the tone map
    // is always attached ahead of it), and its input is the LDR display image.
    this.postProcess = new PostProcess(
      "final-rcas-sharpen", SHARPEN_SHADER, ["sharpenAmount"], null,
      1, camera, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, engine, false,
      undefined, Constants.TEXTURETYPE_UNSIGNED_BYTE, undefined, undefined,
      undefined, undefined, ShaderLanguage.WGSL,
    );
    this.postProcess.samples = 1;
    this.postProcess.onApply = (effect) => {
      effect.setFloat("sharpenAmount", this.amount);
    };
    this.setAmount(amount);
  }

  /** RCAS's `con.x`: 0 is identity, 1 is AMD's full-strength lobe. */
  setAmount(amount: number): void {
    if (!Number.isFinite(amount) || amount < 0 || amount > 1) {
      throw new RangeError(`sharpen amount must be in [0, 1], got ${amount}`);
    }
    this.amount = amount;
  }

  /**
   * Attach at the END of the chain, or detach. A zero amount is detached
   * rather than run as an identity: an identity pass still costs a target and
   * a full-screen draw.
   */
  setEnabled(camera: Camera, enabled: boolean): void {
    if (enabled === this.attached) return;
    if (enabled) camera.attachPostProcess(this.postProcess);
    else camera.detachPostProcess(this.postProcess);
    this.attached = enabled;
  }

  dispose(camera: Camera): void {
    this.postProcess.dispose(camera);
  }
}
