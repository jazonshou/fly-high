import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Camera } from "@babylonjs/core/Cameras/camera";
// Side effect: registers Babylon's WGSL FXAA vertex shader, which
// `FxaaSharpenPass` runs for its tap coordinates.
import "@babylonjs/core/ShadersWGSL/fxaa.vertex";

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
 * contrast-adaptive sharpening (RCAS, the sharpen half of FSR 1), applied
 * last, so it also counteracts FXAA.
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
 * TWO FORMS, ONE KERNEL (`rcasSharpen` in the WGSL, `rcasSharpen` below).
 *
 *  - Where FXAA runs (no MSAA: tiers 0 and 1), the sharpen rides INSIDE the
 *    FXAA pass (`FxaaSharpenPass`). FXAA already fetches the centre and its
 *    four-neighbour cross, which is exactly RCAS's footprint, so the fused
 *    pass sharpens FXAA's output against that cross and adds no texture
 *    fetch: only RCAS's few dozen ALU. As a separate pass it cost a second
 *    full-screen draw, five taps per pixel, and an LDR target the size of the
 *    raster that FXAA wrote and the sharpen read back (6.6 MiB at tier 1 on a
 *    2560x1440@2 panel). The one difference from sharpening FXAA's output:
 *    the cross is the image before FXAA, so near an edge FXAA smoothed, the
 *    lobe is solved against the unsmoothed neighbours. Those are higher
 *    contrast, so the lobe is the same or smaller there, and the push away
 *    from them moves an FXAA-blended centre back toward its own colour.
 *  - Where FXAA does not run (MSAA tiers 2 and 3), the sharpen is a pass of
 *    its own after the tone map (`SharpenPass`), as before.
 *
 * ORDER. Whichever form runs must be last, after the tone map: it sharpens the
 * display image. At most one is attached, and `FlightRenderer.applyProfile`
 * detaches both before re-attaching the profile's one, because Babylon
 * appends.
 */

const SHARPEN_SHADER = "aerolithRcasSharpen";
const FXAA_SHARPEN_SHADER = "aerolithFxaaRcasSharpen";
/** Babylon's FXAA vertex shader, which the fused pass reuses for its tap coordinates. */
const FXAA_VERTEX_SHADER = "fxaa";
/** Compiles RCAS into the fused pass. Absent at a zero amount, so tier 0 runs FXAA alone. */
const FXAA_SHARPEN_DEFINE = "RCAS_SHARPEN";

/**
 * FXAA 3.11's quality settings, as Babylon's `fxaa.fragment` ships them
 * (`fxaaQualitySubpix`, `fxaaQualityEdgeThreshold`,
 * `fxaaQualityEdgeThresholdMin`). The fused pass ports that shader, and a test
 * holds these to the installed Babylon's, so a Babylon upgrade that retunes
 * its FXAA is seen rather than silently diverged from.
 */
export const FXAA_QUALITY = Object.freeze({
  subpix: 1.0,
  edgeThreshold: 0.166,
  edgeThresholdMin: 0.0833,
});

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

/**
 * The kernel, shared by both forms. `e` is the centre and `b`, `d`, `f`, `h`
 * its north, west, east and south neighbours, display-referred in [0, 1].
 * Symmetric in the four neighbours.
 */
const RCAS_WGSL = `
fn rcasLuma(colour: vec3f) -> f32 {
  return colour.b * 0.5 + (colour.r * 0.5 + colour.g);
}

fn rcasSharpen(e: vec3f, b: vec3f, d: vec3f, f: vec3f, h: vec3f, amount: f32) -> vec3f {
  let mn4 = min(min(b, d), min(f, h));
  let mx4 = max(max(b, d), max(f, h));
  // Guarded where AMD's approximate reciprocal is not: see rcasSharpen.
  let hitMin = min(mn4, e) / max(4.0 * mx4, vec3f(1e-5));
  let hitMax = (vec3f(1.0) - max(mx4, e)) / min(4.0 * mn4 - vec3f(4.0), vec3f(-1e-5));
  let lobeRgb = max(-hitMin, hitMax);
  var lobe = max(-${RCAS_LIMIT.toFixed(6)}, min(max(lobeRgb.r, max(lobeRgb.g, lobeRgb.b)), 0.0))
    * amount;
  let bL = rcasLuma(b);
  let dL = rcasLuma(d);
  let eL = rcasLuma(e);
  let fL = rcasLuma(f);
  let hL = rcasLuma(h);
  let range = max(max(max(bL, dL), max(eL, fL)), hL) - min(min(min(bL, dL), min(eL, fL)), hL);
  let noise = clamp(abs(0.25 * (bL + dL + fL + hL) - eL) / max(range, 1e-5), 0.0, 1.0);
  lobe = lobe * (1.0 - 0.5 * noise);
  return (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
}
`;

/** The standalone pass: the multisampled tiers, which run no FXAA. */
export const RCAS_SHARPEN_WGSL = `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

uniform sharpenAmount: f32;
${RCAS_WGSL}
fn rcasTap(uv: vec2f, offset: vec2f, texel: vec2f) -> vec3f {
  // Explicit level 0: the input has no mip chain and the taps land on texel
  // centres, so this is an exact load through the bilinear sampler.
  return textureSampleLevel(textureSampler, textureSamplerSampler, uv + offset * texel, 0.0).rgb;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let uv = fragmentInputs.vUV;
  let texel = 1.0 / vec2f(textureDimensions(textureSampler, 0));
  let sharpened = rcasSharpen(
    rcasTap(uv, vec2f(0.0, 0.0), texel),
    rcasTap(uv, vec2f(0.0, -1.0), texel),
    rcasTap(uv, vec2f(-1.0, 0.0), texel),
    rcasTap(uv, vec2f(1.0, 0.0), texel),
    rcasTap(uv, vec2f(0.0, 1.0), texel),
    uniforms.sharpenAmount);
  fragmentOutputs.color = vec4f(sharpened, 1.0);
  return fragmentOutputs;
}
`;

/**
 * The fused pass: Babylon's FXAA 3.11 (`fxaa.fragment` with `fxaa.vertex`),
 * statement for statement, then RCAS on its result. Babylon's vertex shader
 * supplies the eight neighbour coordinates, so the taps land where the stock
 * pass's do and, without `RCAS_SHARPEN`, the output is the stock FXAA's.
 *
 * Two departures, neither a change in what FXAA computes: the early exit is
 * an if/else, so there is one return (which is also all Babylon's `MALI`
 * define did), and the four cross taps are kept whole rather than reduced to
 * luma on the spot, because they are RCAS's neighbours.
 */
export const FXAA_RCAS_WGSL = `
varying vUV: vec2f;
varying sampleCoordS: vec2f;
varying sampleCoordE: vec2f;
varying sampleCoordN: vec2f;
varying sampleCoordW: vec2f;
varying sampleCoordNW: vec2f;
varying sampleCoordSE: vec2f;
varying sampleCoordNE: vec2f;
varying sampleCoordSW: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

uniform texelSize: vec2f;
uniform sharpenAmount: f32;
${RCAS_WGSL}
const fxaaQualitySubpix: f32 = ${FXAA_QUALITY.subpix.toFixed(1)};
const fxaaQualityEdgeThreshold: f32 = ${FXAA_QUALITY.edgeThreshold};
const fxaaQualityEdgeThresholdMin: f32 = ${FXAA_QUALITY.edgeThresholdMin};

fn fxaaTap(uv: vec2f) -> vec4f {
  return textureSampleLevel(textureSampler, textureSamplerSampler, uv, 0.0);
}

fn fxaaLuma(rgba: vec4f) -> f32 {
  return dot(rgba.rgb, vec3f(0.2126, 0.7152, 0.0722));
}

// FXAA past its early exit: the pixel sits on an edge or sub-pixel feature.
// Walks the edge both ways and returns where to resample the input.
fn fxaaEdgePosition(
  posMIn: vec2f, texelSize: vec2f,
  lumaM: f32, lumaNIn: f32, lumaSIn: f32, lumaE: f32, lumaW: f32, range: f32,
  coordNW: vec2f, coordSE: vec2f, coordNE: vec2f, coordSW: vec2f
) -> vec2f {
  var posM = posMIn;
  var lumaN = lumaNIn;
  var lumaS = lumaSIn;
  let lumaNW = fxaaLuma(fxaaTap(coordNW));
  let lumaSE = fxaaLuma(fxaaTap(coordSE));
  let lumaNE = fxaaLuma(fxaaTap(coordNE));
  let lumaSW = fxaaLuma(fxaaTap(coordSW));
  let lumaNS = lumaN + lumaS;
  let lumaWE = lumaW + lumaE;
  let subpixRcpRange = 1.0 / range;
  let subpixNSWE = lumaNS + lumaWE;
  let edgeHorz1 = (-2.0 * lumaM) + lumaNS;
  let edgeVert1 = (-2.0 * lumaM) + lumaWE;
  let lumaNESE = lumaNE + lumaSE;
  let lumaNWNE = lumaNW + lumaNE;
  let edgeHorz2 = (-2.0 * lumaE) + lumaNESE;
  let edgeVert2 = (-2.0 * lumaN) + lumaNWNE;
  let lumaNWSW = lumaNW + lumaSW;
  let lumaSWSE = lumaSW + lumaSE;
  let edgeHorz4 = (abs(edgeHorz1) * 2.0) + abs(edgeHorz2);
  let edgeVert4 = (abs(edgeVert1) * 2.0) + abs(edgeVert2);
  let edgeHorz3 = (-2.0 * lumaW) + lumaNWSW;
  let edgeVert3 = (-2.0 * lumaS) + lumaSWSE;
  let edgeHorz = abs(edgeHorz3) + edgeHorz4;
  let edgeVert = abs(edgeVert3) + edgeVert4;
  let subpixNWSWNESE = lumaNWSW + lumaNESE;
  var lengthSign = texelSize.x;
  let horzSpan = edgeHorz >= edgeVert;
  let subpixA = subpixNSWE * 2.0 + subpixNWSWNESE;
  if (!horzSpan) {
    lumaN = lumaW;
    lumaS = lumaE;
  }
  if (horzSpan) {
    lengthSign = texelSize.y;
  }
  let subpixB = (subpixA * (1.0 / 12.0)) - lumaM;
  let gradientN = lumaN - lumaM;
  let gradientS = lumaS - lumaM;
  var lumaNN = lumaN + lumaM;
  let lumaSS = lumaS + lumaM;
  let pairN = abs(gradientN) >= abs(gradientS);
  let gradient = max(abs(gradientN), abs(gradientS));
  if (pairN) {
    lengthSign = -lengthSign;
  }
  let subpixC = clamp(abs(subpixB) * subpixRcpRange, 0.0, 1.0);
  var posB = posM;
  let offNP = vec2f(select(texelSize.x, 0.0, !horzSpan), select(texelSize.y, 0.0, horzSpan));
  if (!horzSpan) {
    posB.x += lengthSign * 0.5;
  }
  if (horzSpan) {
    posB.y += lengthSign * 0.5;
  }
  var posN = posB - offNP * 1.5;
  var posP = posB + offNP * 1.5;
  let subpixD = ((-2.0) * subpixC) + 3.0;
  var lumaEndN = fxaaLuma(fxaaTap(posN));
  let subpixE = subpixC * subpixC;
  var lumaEndP = fxaaLuma(fxaaTap(posP));
  if (!pairN) {
    lumaNN = lumaSS;
  }
  let gradientScaled = gradient * 1.0 / 4.0;
  let lumaMM = lumaM - lumaNN * 0.5;
  let subpixF = subpixD * subpixE;
  let lumaMLTZero = lumaMM < 0.0;
  lumaEndN -= lumaNN * 0.5;
  lumaEndP -= lumaNN * 0.5;
  var doneN = abs(lumaEndN) >= gradientScaled;
  var doneP = abs(lumaEndP) >= gradientScaled;
  if (!doneN) {
    posN -= offNP * 3.0;
  }
  if (!doneP) {
    posP += offNP * 3.0;
  }
  if (!doneN || !doneP) {
    if (!doneN) {
      lumaEndN = fxaaLuma(fxaaTap(posN));
    }
    if (!doneP) {
      lumaEndP = fxaaLuma(fxaaTap(posP));
    }
    if (!doneN) {
      lumaEndN = lumaEndN - lumaNN * 0.5;
    }
    if (!doneP) {
      lumaEndP = lumaEndP - lumaNN * 0.5;
    }
    doneN = abs(lumaEndN) >= gradientScaled;
    doneP = abs(lumaEndP) >= gradientScaled;
    if (!doneN) {
      posN -= offNP * 12.0;
    }
    if (!doneP) {
      posP += offNP * 12.0;
    }
  }
  var dstN = posM.x - posN.x;
  var dstP = posP.x - posM.x;
  if (!horzSpan) {
    dstN = posM.y - posN.y;
    dstP = posP.y - posM.y;
  }
  let goodSpanN = (lumaEndN < 0.0) != lumaMLTZero;
  let spanLength = dstP + dstN;
  let goodSpanP = (lumaEndP < 0.0) != lumaMLTZero;
  let spanLengthRcp = 1.0 / spanLength;
  let directionN = dstN < dstP;
  let dst = min(dstN, dstP);
  let goodSpan = select(goodSpanP, goodSpanN, directionN);
  let subpixG = subpixF * subpixF;
  let pixelOffset = (dst * (-spanLengthRcp)) + 0.5;
  let subpixH = subpixG * fxaaQualitySubpix;
  let pixelOffsetGood = select(0.0, pixelOffset, goodSpan);
  let pixelOffsetSubpix = max(pixelOffsetGood, subpixH);
  if (!horzSpan) {
    posM.x += pixelOffsetSubpix * lengthSign;
  }
  if (horzSpan) {
    posM.y += pixelOffsetSubpix * lengthSign;
  }
  return posM;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let rgbyM = fxaaTap(fragmentInputs.vUV);
  let rgbS = fxaaTap(fragmentInputs.sampleCoordS);
  let rgbE = fxaaTap(fragmentInputs.sampleCoordE);
  let rgbN = fxaaTap(fragmentInputs.sampleCoordN);
  let rgbW = fxaaTap(fragmentInputs.sampleCoordW);
  let lumaM = fxaaLuma(rgbyM);
  let lumaS = fxaaLuma(rgbS);
  let lumaE = fxaaLuma(rgbE);
  let lumaN = fxaaLuma(rgbN);
  let lumaW = fxaaLuma(rgbW);
  let maxSM = max(lumaS, lumaM);
  let minSM = min(lumaS, lumaM);
  let maxESM = max(lumaE, maxSM);
  let minESM = min(lumaE, minSM);
  let maxWN = max(lumaN, lumaW);
  let minWN = min(lumaN, lumaW);
  let rangeMax = max(maxWN, maxESM);
  let rangeMin = min(minWN, minESM);
  let rangeMaxScaled = rangeMax * fxaaQualityEdgeThreshold;
  let range = rangeMax - rangeMin;
  let rangeMaxClamped = max(fxaaQualityEdgeThresholdMin, rangeMaxScaled);
  var colour = rgbyM;
  if (!(range < rangeMaxClamped)) {
    colour = fxaaTap(fxaaEdgePosition(
      fragmentInputs.vUV, uniforms.texelSize, lumaM, lumaN, lumaS, lumaE, lumaW, range,
      fragmentInputs.sampleCoordNW, fragmentInputs.sampleCoordSE,
      fragmentInputs.sampleCoordNE, fragmentInputs.sampleCoordSW));
  }
#ifdef ${FXAA_SHARPEN_DEFINE}
  // The cross is FXAA's input, not its output: see the header.
  colour = vec4f(
    rcasSharpen(colour.rgb, rgbN.rgb, rgbW.rgb, rgbE.rgb, rgbS.rgb, uniforms.sharpenAmount), 1.0);
#endif
  fragmentOutputs.color = colour;
  return fragmentOutputs;
}
`;

function registerShaders(): void {
  ShaderStore.ShadersStoreWGSL[`${SHARPEN_SHADER}FragmentShader`] = RCAS_SHARPEN_WGSL;
  ShaderStore.ShadersStoreWGSL[`${FXAA_SHARPEN_SHADER}FragmentShader`] = FXAA_RCAS_WGSL;
  if (ShaderStore.ShadersStoreWGSL[`${FXAA_VERTEX_SHADER}VertexShader`] === undefined) {
    // Registered by the side-effect import at the top of this file. Failing
    // here, at construction, beats a pipeline that never compiles.
    throw new Error(`Babylon's WGSL "${FXAA_VERTEX_SHADER}" vertex shader is not registered`);
  }
}

function checkAmount(amount: number): number {
  if (!Number.isFinite(amount) || amount < 0 || amount > 1) {
    throw new RangeError(`sharpen amount must be in [0, 1], got ${amount}`);
  }
  return amount;
}

/**
 * The standalone sharpen, for the tiers that run no FXAA. Construct it LAST in
 * the chain: Babylon orders a camera's post-processes by attachment order.
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
    this.amount = checkAmount(amount);
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

/**
 * FXAA with the sharpen fused in: the last pass wherever FXAA runs. At a zero
 * amount RCAS is compiled out and this is Babylon's FXAA. Construct it after
 * the tone map: Babylon orders a camera's post-processes by attachment order.
 */
export class FxaaSharpenPass {
  readonly postProcess: PostProcess;
  private amount: number;
  private attached = true;

  get enabled(): boolean {
    return this.attached;
  }

  constructor(camera: Camera, engine: AbstractEngine, amount: number) {
    registerShaders();
    this.amount = checkAmount(amount);
    // Ratio 1, single-sampled and LDR, as Babylon's FxaaPostProcess was here:
    // its input is the tone map's display image.
    this.postProcess = new PostProcess(
      "final-fxaa", FXAA_SHARPEN_SHADER, ["texelSize", "sharpenAmount"], null,
      1, camera, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, engine, false,
      fxaaSharpenDefines(this.amount), Constants.TEXTURETYPE_UNSIGNED_BYTE, FXAA_VERTEX_SHADER,
      undefined, undefined, undefined, ShaderLanguage.WGSL,
    );
    this.postProcess.samples = 1;
    this.postProcess.onApply = (effect) => {
      const texelSize = this.postProcess.texelSize;
      effect.setFloat2("texelSize", texelSize.x, texelSize.y);
      effect.setFloat("sharpenAmount", this.amount);
    };
  }

  /**
   * RCAS's `con.x`, as `SharpenPass.setAmount`. Crossing zero recompiles the
   * pass with or without RCAS; it happens on a profile change, not per frame.
   */
  setAmount(amount: number): void {
    const sharpened = this.amount > 0;
    this.amount = checkAmount(amount);
    if (this.amount > 0 !== sharpened) {
      this.postProcess.updateEffect(fxaaSharpenDefines(this.amount));
    }
  }

  /** Attach at the END of the chain, or detach. */
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

function fxaaSharpenDefines(amount: number): string | null {
  return amount > 0 ? `#define ${FXAA_SHARPEN_DEFINE}\n` : null;
}
