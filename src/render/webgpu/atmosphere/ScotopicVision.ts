import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Camera } from "@babylonjs/core/Cameras/camera";

/**
 * `7-2` — scotopic (rod) vision (owner: lighting).
 *
 * INVARIANT THIS FILE OWNS: the rod/cone blend, the Purkinje shift, the
 * scotopic desaturation and the acuity loss. It is a POST-PROCESS on linear
 * HDR, not a lighting change — moonlight is only slightly reddened (~4,100 K,
 * see `Ephemeris.MOONLIGHT_TINT`), and the blue of a moonlit night is what
 * the viewer's rods do to it. Putting that blue in the light colour is the
 * classic mistake and `MOONLIGHT_TINT` exists so it cannot be made here.
 *
 * The pass runs BEFORE the tone map, so it sees scene-referred linear
 * radiance and the one exposure curve still lives entirely on the
 * image-processing chain (assertion 29 — this shader never multiplies a
 * private exposure of its own: its display gain arrives already computed
 * from `exposureForState`). It is also the first post-process, so it owns the
 * offscreen beauty target and therefore MSAA (`1B-11`'s rule, moved one
 * stage earlier).
 *
 * The physics, in the order the shader applies it:
 *
 * 1. **Scotopic luminance.** Rods peak at 507 nm against the cones' 555 nm,
 *    so the rod response to an sRGB primary set is heavily green-blue and
 *    almost blind to red — which is why red light preserves dark adaptation
 *    and why a red instrument panel is the one thing that stays legible.
 * 2. **Rod fraction** from the ADAPTED luminance, not the pixel's: vision is
 *    rod-only below ~0.03 cd/m² and cone-only above ~3, and the mesopic
 *    range between is a smooth blend of both. The adapted value is supplied
 *    per frame by `EnvironmentDirector`, computed from real illuminance.
 * 3. **Naka–Rushton rod response** `L/(L + σ)` with σ the scene's key
 *    luminance. This is where the GAIN lives: a dark-adapted eye maps the
 *    scene's own mid-tone to the middle of its range, which is the whole
 *    reason a moonlit field is navigable. It is also self-limiting, so no
 *    night can blow out. See `ScotopicState.adaptedLuminanceCdM2` for why σ
 *    is the scene's key and not the physical adapted luminance.
 * 4. **Acuity loss.** Rod vision resolves ~20/200. A rod-weighted blur is
 *    the cheapest honest expression of it and it is what stops a scotopic
 *    image from looking like a desaturated daylight one.
 *
 * Adaptation hysteresis (light→dark much slower than dark→light) is owned by
 * `EnvironmentDirector.adaptLuminance`, on the CPU, so it is a pure function
 * of pinned inputs and the capture stays deterministic.
 */

const SCOTOPIC_SHADER_NAME = "aerolithScotopicVision";

/**
 * Rod spectral sensitivity resolved onto linear sRGB primaries and
 * normalised to sum 1. V'(λ) peaks at 507 nm — between the sRGB blue
 * (~450 nm) and green (~550 nm) primaries and far from red (~610 nm).
 */
export const SCOTOPIC_WEIGHTS: readonly [number, number, number] = Object.freeze([
  0.03,
  0.42,
  0.55,
]);

/** Photopic luminance weights (Rec. 709), for the cone path. */
export const PHOTOPIC_WEIGHTS: readonly [number, number, number] = Object.freeze([
  0.2126,
  0.7152,
  0.0722,
]);

/**
 * The perceived hue of rod-only vision. Rods are achromatic — they cannot
 * carry colour at all — but the residual blue-grey of a night scene is a
 * real perceptual effect of the rod peak sitting on the short-wave side,
 * and every observer reports it. Normalised to luminance 1 so it tints
 * without brightening.
 */
export const SCOTOPIC_TINT: readonly [number, number, number] = Object.freeze([
  0.72,
  0.94,
  1.55,
]);

/**
 * ART DIRECTION, 2026-09-01 — Jason flew the night and rejected it. **This
 * path is deliberately NOT physiological from here on, and that is the point.**
 *
 * His words, kept verbatim because a future reader will otherwise "correct"
 * this back toward realism on the strength of the docblocks above:
 *
 *   - *"I don't like how everything is black and white — that's not what night
 *     looks like"*
 *   - *"I want to see more blue and there should be a stronger lighting effect
 *     from the moon. It's okay if it's not perfectly realistic — the moon can
 *     be stronger than expected and there can be more blue in the sky than
 *     expected."*
 *   - *"It should be much lighter, less blurry/black-white and more colourful
 *     and peaceful"*
 *   - **"Exaggerated colours are okay, sometimes."**
 *
 * Reference: a Red Dead Redemption 2 night — a deep blue sky with real colour,
 * a landscape you can read, grass and water holding their own hue.
 *
 * **The tension, stated so nobody has to rediscover it: real rod vision IS
 * monochrome and blurry, and the model above was right.** Rods cannot carry
 * colour; the desaturation and the acuity blur are both defensible. Jason is
 * not reporting a bug — he is saying the physiology is the wrong target. **Do
 * not restore the monochrome because rods are achromatic. That is known, and
 * it was traded away on purpose.**
 *
 * How much of the scene's own hue survives the rod blend, 0 = the original
 * achromatic model, 1 = full chroma retention. The rod response still sets
 * LUMINANCE; this only decides whether the result keeps the scene's colour.
 */
export const SCOTOPIC_CHROMA_RETENTION = 0.65;

/**
 * Acuity-blur radius in texels: `BASE + ROD_SCALE * rodFraction`.
 * Was `0.6 + 2.4 * rod` — *"less blurry"* is a direct quote, and at full rod
 * weight the old figure was the dominant reason the night read as soup.
 */
export const SCOTOPIC_BLUR_BASE = 0.25;
export const SCOTOPIC_BLUR_ROD_SCALE = 0.75;

/** Adapted luminance (cd/m²) below which vision is rod-only. */
export const SCOTOPIC_THRESHOLD_CD_M2 = 0.03;
/** Adapted luminance above which vision is cone-only. */
export const PHOTOPIC_THRESHOLD_CD_M2 = 3.0;

/** The shader's daylight-copy threshold, shared with the chain scheduler. */
export const SCOTOPIC_PASS_THRESHOLD = 0.001;

/**
 * `7-4a`: the highlight-preserving term's gain, in output units per doubling
 * of luminance above the adapted level.
 *
 * **Why a second term rather than a change to the response.** The Naka-Rushton
 * response is auto-centred: sigma is the SCENE KEY, which is Lambertian ground
 * under the frame's own lights, so moonlit ground half-saturates at every clock
 * and that is the property worth keeping. The cost is that it has spent 99% of
 * its output by ground x 100 — measured, three decades of light-source
 * brightness (ground x 1e2 to x 1e5) collapse to **1.0100:1**, so a runway edge
 * light, a landing light and the moon render at indistinguishable brightness.
 *
 * This term adds range precisely where the response has already spent itself
 * and is exactly zero at and below sigma, so it cannot disturb the ground.
 * At 0.06 the same three decades span **2.384:1** and every decade above ground
 * steps by at least **1.24x**.
 *
 * **Do NOT fix the compression by feeding sigma the physical adapted
 * luminance.** Measured: sigma 4.21 gives 1.0573:1 over 1e5:1 of input;
 * the physical value (8.0e-5) gives **1.0000:1** — a uniform grey field that
 * passes every capture gate. Compression WORSENS as sigma falls.
 */
export const SCOTOPIC_HIGHLIGHT_GAIN = 0.06;

/**
 * `7-4a`: width of the highlight term's turn-on, in units of `(nits - sigma) /
 * sigma`, i.e. multiples of the adapted level.
 *
 * Without it the term switches on with a derivative jump of 0.095 per unit at
 * sigma — a visible crease exactly where ground meets a light — and the
 * smoothstep degenerates at zero width. At 1.0 the derivative just above the
 * ground is 0.0085 and the term is fully caught up by ground x 2, so nothing
 * brighter than twice the adapted level is suppressed.
 */
export const SCOTOPIC_HIGHLIGHT_KNEE = 1.0;

/** Whether rod vision contributes enough to require the scotopic pass. */
export function shouldRunScotopicPass(rodFraction: number): boolean {
  return Number.isFinite(rodFraction) && rodFraction > SCOTOPIC_PASS_THRESHOLD;
}

/**
 * Rod fraction at an adapted luminance — the mesopic blend, log-interpolated
 * because adaptation is logarithmic in luminance and a linear blend would
 * put the whole transition inside the last 3% of a sunset.
 */
export function rodFractionForAdaptedLuminance(adaptedLuminanceCdM2: number): number {
  if (!(adaptedLuminanceCdM2 > 0)) return 1;
  const low = Math.log10(SCOTOPIC_THRESHOLD_CD_M2);
  const high = Math.log10(PHOTOPIC_THRESHOLD_CD_M2);
  const value = Math.log10(adaptedLuminanceCdM2);
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return 1 - t * t * (3 - 2 * t);
}

const SCOTOPIC_FRAGMENT_WGSL = /* wgsl */ `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

uniform scotopicRodFraction: f32;
uniform scotopicAdaptedLuminance: f32;
uniform scotopicSceneToNits: f32;
uniform scotopicDisplayGain: f32;
uniform scotopicTexelSize: vec2f;

const SCOTOPIC_WEIGHTS: vec3f = vec3f(
  ${SCOTOPIC_WEIGHTS[0]}, ${SCOTOPIC_WEIGHTS[1]}, ${SCOTOPIC_WEIGHTS[2]});
const SCOTOPIC_TINT: vec3f = vec3f(
  ${SCOTOPIC_TINT[0]}, ${SCOTOPIC_TINT[1]}, ${SCOTOPIC_TINT[2]});

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  var scene = textureSample(textureSampler, textureSamplerSampler, fragmentInputs.vUV).rgb;
  let rod = uniforms.scotopicRodFraction;
  if (rod <= ${SCOTOPIC_PASS_THRESHOLD}) {
    // Daylight: the pass is a copy, bit-for-bit. Every capture above civil
    // twilight has to be unchanged by this item existing.
    fragmentOutputs.color = vec4f(scene, 1.0);
    return fragmentOutputs;
  }

  // 4. Acuity loss, applied to the ROD input only. Rod vision resolves about
  // a tenth of foveal cone acuity; four taps on a rotated cross at a
  // rod-weighted radius is enough to read as "I cannot make out detail"
  // without turning the image to soup.
  let blurRadius = uniforms.scotopicTexelSize
    * (${SCOTOPIC_BLUR_BASE} + ${SCOTOPIC_BLUR_ROD_SCALE} * rod);
  var soft = scene;
  soft = soft + textureSample(textureSampler, textureSamplerSampler,
    fragmentInputs.vUV + vec2f(blurRadius.x, blurRadius.y * 0.5)).rgb;
  soft = soft + textureSample(textureSampler, textureSamplerSampler,
    fragmentInputs.vUV - vec2f(blurRadius.x, blurRadius.y * 0.5)).rgb;
  soft = soft + textureSample(textureSampler, textureSamplerSampler,
    fragmentInputs.vUV + vec2f(blurRadius.x * 0.5, -blurRadius.y)).rgb;
  soft = soft + textureSample(textureSampler, textureSamplerSampler,
    fragmentInputs.vUV - vec2f(blurRadius.x * 0.5, -blurRadius.y)).rgb;
  soft = soft * 0.2;

  // 1. Scotopic luminance: the rod system's response to this spectrum.
  let scotopicScene = max(dot(soft, SCOTOPIC_WEIGHTS), 0.0);
  // 3. Naka-Rushton, in real cd/m^2 against the adapted level. This is the
  // gain, and it saturates, so nothing a night scene contains can clip.
  let nits = scotopicScene * uniforms.scotopicSceneToNits;
  let sigma = max(uniforms.scotopicAdaptedLuminance, 1.0e-5);
  let response = nits / (nits + sigma);

  // 7-4a: the highlight-preserving term. Read from the SHARP sample, not the
  // blurred one — a light point is a one-pixel source and the acuity blur
  // above would smear it into the ground before the response ever saw it.
  // Zero at and below sigma by construction, so the ground's half-saturation
  // is untouched; logarithmic above, so decades of source brightness stay
  // ordered where the response has already saturated.
  let sharpNits = max(dot(scene, SCOTOPIC_WEIGHTS), 0.0) * uniforms.scotopicSceneToNits;
  let highlightExcess = max(sharpNits - sigma, 0.0) / sigma;
  let highlight = ${SCOTOPIC_HIGHLIGHT_GAIN}
    * smoothstep(0.0, ${SCOTOPIC_HIGHLIGHT_KNEE}, highlightExcess)
    * log2(1.0 + highlightExcess);

  // Back to scene-linear so the ONE exposure curve on the image-processing
  // chain still owns the display mapping. The gain arrives precomputed.
  let rodLuminance = response * uniforms.scotopicDisplayGain + highlight;
  // ART DIRECTION: let the scene's own hue survive the rod blend. sceneHue is
  // the colour RATIO normalised by the same scotopic weights, so a neutral
  // input stays exactly neutral (the weights sum to 1) and only genuinely
  // coloured ground, water and sky carry through. The rod response still owns
  // luminance; this decides only whether the result is grey.
  let sceneLuminance = max(dot(soft, SCOTOPIC_WEIGHTS), 1.0e-6);
  let sceneHue = soft / sceneLuminance;
  // Per-pixel cone chroma (NIGHT_LOOK_ARCHITECTURE §2.2): a lamp bright
  // enough to see is bright enough to see IN COLOUR. The pixel's own
  // luminance decides how much cone vision sees it, measured RELATIVE TO
  // SIGMA — the frame's adapted level — as a log-space smoothstep on the
  // SHARP nits 7-4a already computes: cone vision takes over where a source
  // sits many multiples above what the eye is adapted to. 4x..64x spans the
  // hand-over (diffuse moonlit ground varies within ~1-3x of the scene key
  // and stays rod-tinted; lamp shoulders, star cores and the moon's disc sit
  // decades above and read in their own colour).
  //
  // DELIBERATELY NOT thresholded in absolute cd/m2: sharpNits is in
  // scene-key-scaled units, which sit ~three orders above the physical
  // adaptation at night (the misplaced-ladder fact this file's own sigma
  // docblock records). An absolute photopic threshold of 3.0 lands INSIDE
  // the moonlit ground's range in those units and would have stripped the
  // rod tint and the retention floor from the entire approved field —
  // caught by composition before any frame was captured, 2026-09-01.
  //
  // Hue follows the same sharp-sample rule as luminance: a point source's
  // hue must come from its own pixels, not the blurred neighbourhood that
  // dilutes it toward grey — 7-4a fixed that seam for luminance and left it
  // open for hue (found independently twice, 2026-09-01).
  let pixelCone = smoothstep(
    ${Math.log(4)},
    ${Math.log(64)},
    log(max(sharpNits, 1.0e-6) / sigma),
  );
  let sharpHue = scene / max(dot(scene, SCOTOPIC_WEIGHTS), 1.0e-6);
  let hue = mix(sceneHue, sharpHue, pixelCone);
  // A fully photopic pixel carries no rod tint — cones see true colour, so
  // the blue night cast fades out exactly where a source is bright enough
  // to defeat it. Tint and hue are both luminance-normalised, so
  // rodLuminance still owns the level throughout.
  let tint = mix(SCOTOPIC_TINT, vec3f(1.0), pixelCone);
  let chromaKeep = max(${SCOTOPIC_CHROMA_RETENTION}, pixelCone);
  let rodImage = mix(
    tint * rodLuminance,
    tint * rodLuminance * hue,
    chromaKeep,
  );

  // 2. The mesopic blend.
  fragmentOutputs.color = vec4f(mix(scene, rodImage, rod), 1.0);
  return fragmentOutputs;
}
`;

function registerShader(): void {
  ShaderStore.ShadersStoreWGSL[`${SCOTOPIC_SHADER_NAME}FragmentShader`] =
    SCOTOPIC_FRAGMENT_WGSL;
}

export interface ScotopicState {
  /**
   * 0 = pure cone vision, 1 = rod-only. Driven by the PHYSICAL adapted
   * luminance: whether it is dark enough for rods is a fact about the world,
   * not about the buffer.
   */
  readonly rodFraction: number;
  /**
   * Luminance at which the rod response is half-saturated — the SCENE's own
   * key, not the physical one.
   *
   * This split is forced by the same fp16 range problem `MOON_PEAK_LIGHT_
   * INTENSITY` records: the beauty buffer is not photometrically scaled at
   * night, so normalising the response against the real 10⁻⁴ cd/m² of a
   * moonless field would drive every pixel to full saturation and hand back
   * a flat grey image — which is exactly what the first night capture of
   * this item showed. Normalising against the scene's own key is what
   * adaptation actually does anyway: it puts the mid-tone where the mid-tone
   * is, whatever the absolute level, and leaves the perceptual difference
   * (desaturation, the Purkinje blue, the acuity loss) to `rodFraction`,
   * which is physical.
   */
  readonly adaptedLuminanceCdM2: number;
  /** Scene-linear → cd/m², from the sun's own calibration. */
  readonly sceneToNits: number;
  /**
   * Scene-linear value the fully-saturated rod response maps to. Derived
   * from `exposureForState` on the CPU so the shader never touches exposure.
   */
  readonly displayGain: number;
}

/** The scotopic post-process. Construct BEFORE the tone map. */
export class ScotopicVisionPass {
  readonly postProcess: PostProcess;
  private attached = true;

  get enabled(): boolean {
    return this.attached;
  }

  get samples(): number {
    return this.postProcess.samples;
  }

  constructor(camera: Camera, engine: AbstractEngine, samples: number) {
    registerShader();
    this.postProcess = new PostProcess(
      "scotopic-vision",
      SCOTOPIC_SHADER_NAME,
      [
        "scotopicRodFraction",
        "scotopicAdaptedLuminance",
        "scotopicSceneToNits",
        "scotopicDisplayGain",
        "scotopicTexelSize",
      ],
      null,
      1,
      camera,
      Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
      engine,
      false,
      undefined,
      Constants.TEXTURETYPE_HALF_FLOAT,
      undefined,
      undefined,
      undefined,
      undefined,
      ShaderLanguage.WGSL,
    );
    // 1B-11's rule, one stage earlier: the FIRST post-process owns the
    // offscreen scene target and its depth buffer, so MSAA lives here now.
    this.postProcess.samples = samples;
    this.setState({
      rodFraction: 0,
      adaptedLuminanceCdM2: 1_000,
      sceneToNits: 1,
      displayGain: 1,
    });
  }

  setState(state: ScotopicState): void {
    this.postProcess.onApply = (effect) => {
      effect.setFloat("scotopicRodFraction", state.rodFraction);
      effect.setFloat("scotopicAdaptedLuminance", state.adaptedLuminanceCdM2);
      effect.setFloat("scotopicSceneToNits", state.sceneToNits);
      effect.setFloat("scotopicDisplayGain", state.displayGain);
      effect.setFloat2(
        "scotopicTexelSize",
        1 / Math.max(1, this.postProcess.width),
        1 / Math.max(1, this.postProcess.height),
      );
    };
  }

  setSamples(samples: number): void {
    this.postProcess.samples = Math.max(1, Math.round(samples));
  }

  /**
   * Remove the daylight copy from the camera chain, or restore it at slot 0
   * before tone mapping when rods contribute again.
   */
  setEnabled(camera: Camera, enabled: boolean): void {
    if (enabled === this.attached) return;
    if (enabled) {
      camera.attachPostProcess(this.postProcess, 0);
    } else {
      camera.detachPostProcess(this.postProcess);
    }
    this.attached = enabled;
  }

  dispose(camera: Camera): void {
    this.postProcess.dispose(camera);
  }
}
