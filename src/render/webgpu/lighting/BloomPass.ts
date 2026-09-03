import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Camera } from "@babylonjs/core/Cameras/camera";

/**
 * `7-5` — bloom (owner: lighting).
 *
 * Bright-pass, separable Gaussian blur, additive composite. It runs AFTER the
 * scotopic pass and BEFORE the ACES tone map, so it sees scene-referred linear
 * radiance: bloom is a property of the lens and the eye, and a bloom applied to
 * display values would spread tone-mapped, already-compressed highlights and
 * lose exactly the range that makes it read.
 *
 * ---------------------------------------------------------------------------
 * TWO FIRST-PASS HAZARDS, FOUND BY READING THE CHAIN RATHER THAN THE PLAN
 *
 * `D-4` prices this item as "a new post-process, its MSAA/first-pass
 * renegotiation with the scotopic pass at slot 0" while also placing bloom
 * BETWEEN scotopic and ACES — i.e. slot 1. Those two clauses cannot both
 * describe one design, and the second is the one that got built.
 *
 * But slot 1 does NOT mean "never first", and that is the part worth writing
 * down. `FlightRenderer.applyScotopicState` DETACHES the scotopic pass in
 * photopic daylight (`ScotopicVision.setEnabled` calls `detachPostProcess`) and
 * hands first-pass ownership to whatever is now at the head of the chain. With
 * bloom inserted, that is bloom, for most of the day. So:
 *
 *  1. **MSAA.** The first post-process owns the offscreen scene target, so it
 *     owns MSAA (`1B-11`). Ownership here is DYNAMIC, not static, and it now
 *     has three possible holders instead of two. It is derived in one place —
 *     `FlightRenderer.applyFirstPassOwnership` — rather than re-branched at
 *     each of the sites that used to hand it back and forth.
 *
 *  2. **Resolution, which is the sharper one.** The first post-process's ratio
 *     determines the size of the target THE SCENE RENDERS INTO. The natural
 *     way to write a bloom is a half-resolution bright-pass, and that would
 *     have rendered the entire scene at half resolution every time scotopic
 *     detached — a catastrophic, intermittent, time-of-day-dependent quality
 *     loss that no unit test would see. **So the bright pass is ratio 1.0** and
 *     the downsample happens at the blur, which can never be first.
 *
 * Neither hazard is reachable today: bloom is gated to tier 1 and
 * `msaaSamples` is 1 there, so every transfer assigns the same number. Both
 * become reachable the moment bloom is funded on a multisampled tier, which is
 * a change the gate's own "UNFUNDED" rows anticipate. The bloom-gate test
 * fails if bloom is ever enabled on a tier with `msaaSamples > 1`, so the
 * dangerous configuration cannot arrive silently.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SHADER CONSTANTS ARE GENERATED
 *
 * The blur taps in the WGSL are emitted from `bloomBlurWeights` at module load,
 * unrolled. Two reasons, both learned here:
 *
 *  - A hand-written weight table beside a TS function that computes the same
 *    thing is a decorative list, and this codebase has found three of those
 *    drifting. Generating them means the test that asserts the weights sum to
 *    one is asserting the numbers that actually ship.
 *  - Unrolled, so there is no dynamic index into a `const` array. WGSL
 *    portability has already cost this project a day (`tanh` overflow, the
 *    sin-hash collapse), and an adapter that rejects dynamic indexing would
 *    fail at pipeline creation on someone else's machine.
 *
 * The weights summing to exactly one is not cosmetic: a blur that does not
 * conserve energy turns bloom from a REDISTRIBUTION of highlight energy into a
 * brightness change, which is the same error class as `C6-8`'s level-shift
 * reading of a redistribution.
 */

const BLOOM_BRIGHT_SHADER = "aerolithBloomBright";
const BLOOM_BLUR_SHADER = "aerolithBloomBlur";
const BLOOM_COMPOSITE_SHADER = "aerolithBloomComposite";

/**
 * Scene-linear luminance at which a highlight starts to bloom.
 *
 * Above 1.0 rather than at it: the tone map's exposure is 1.08, so 1.0 is
 * roughly the value that maps to display white. Blooming below that would put
 * a halo on ordinary lit surfaces — sunlit grass — rather than on sources.
 */
export const BLOOM_THRESHOLD = 1.0;

/**
 * Half-width of the soft knee, in the same units as the threshold.
 *
 * A hard threshold POPS: a light brightening through it gains its entire halo
 * in one frame. That is the same defect class as the light-point near-to-far
 * transition, one stage along, and the fix is the same — make the transition
 * continuous and monotonic rather than making the threshold smaller.
 */
export const BLOOM_KNEE = 0.5;

/**
 * Additive weight of the blurred highlight image at composite.
 *
 * **0.08 -> 0.05 on Jason's note that the runway reads as "too big a blob of
 * lights".** Paired with the sigma reduction below; the two were measured
 * together and separately (`dusk-mesopic`, fixed window on the lamp cluster,
 * same-scene control): sigma alone -15%, sigma plus this -23% of pixels above
 * half-white. Turning bloom off entirely is -44% and reads clinical, so this is
 * deliberately partway to that floor rather than at it.
 */
export const BLOOM_INTENSITY = 0.05;

/** Taps per separable pass. Odd, so there is a centre tap. */
export const BLOOM_BLUR_TAPS = 9;

/**
 * Gaussian sigma in texels of the HALF-RESOLUTION blur target.
 *
 * **HALF-RESOLUTION, so the on-screen extent is TWICE this.** At 2.0 the halo
 * reached ~12 px on a 1280x720 frame (3 sigma x 2), which is what made a line
 * of runway lamps fuse into one mass: the lamps are ~4 px apart at approach
 * range, so a 12 px halo per lamp guarantees overlap. Measured radial falloff
 * on the shipped frame confirmed it -- the light-point sprite itself discards
 * beyond `radius^2 > 1` and contributes exactly nothing past ~2 px, so
 * everything from 4 px out was this term.
 *
 * **1.0 was chosen against the frame, not derived.** It is the point where the
 * runway resolves as a runway and lamp rows separate, while the lights keep a
 * glow rather than becoming the bare sprites that `bloomEnabled: false` gives.
 */
export const BLOOM_BLUR_SIGMA = 1.0;

/** Blur render ratio. The bright pass stays at 1.0 — see hazard 2 above. */
export const BLOOM_BLUR_RATIO = 0.5;

/**
 * The luminance a pixel contributes to the bloom image.
 *
 * The quadratic soft-knee curve. Its three properties, all asserted:
 *
 *  - **Zero at and below `threshold - knee`.** Nothing below the knee blooms,
 *    so ordinary lit geometry is untouched and the pass is a no-op on a scene
 *    with no sources in it.
 *  - **Continuous**, including at both knee ends, so nothing pops.
 *  - **Monotonic non-decreasing.** A brighter source can never contribute LESS
 *    bloom than a dimmer one. This is what keeps bloom compatible with `7-4a`'s
 *    ordering pin: the scotopic highlight term exists to keep decades of source
 *    brightness ordered after the rod response saturates, and a bloom that
 *    inverted anywhere would undo that ordering one stage later.
 */
export function bloomBrightPassWeight(
  luminance: number,
  threshold: number = BLOOM_THRESHOLD,
  knee: number = BLOOM_KNEE,
): number {
  const soft = Math.min(Math.max(luminance - threshold + knee, 0), 2 * knee);
  const quadratic = (soft * soft) / (4 * knee + 1e-6);
  return Math.max(quadratic, luminance - threshold, 0);
}

/**
 * Normalised Gaussian taps, centre first is NOT the convention here — index 0
 * is the leftmost tap, so the array reads in the order the shader walks it.
 *
 * Normalised so the sum is 1 to within floating-point exactness; the caller
 * asserts it rather than trusting it.
 */
export function bloomBlurWeights(
  taps: number = BLOOM_BLUR_TAPS,
  sigma: number = BLOOM_BLUR_SIGMA,
): number[] {
  if (taps < 1 || taps % 2 === 0) {
    throw new Error(`bloom blur needs an odd, positive tap count, got ${taps}`);
  }
  if (!(sigma > 0)) throw new Error(`bloom blur sigma must be positive, got ${sigma}`);
  const radius = (taps - 1) / 2;
  const raw: number[] = [];
  for (let index = 0; index < taps; index += 1) {
    const offset = index - radius;
    raw.push(Math.exp(-(offset * offset) / (2 * sigma * sigma)));
  }
  const total = raw.reduce((sum, value) => sum + value, 0);
  return raw.map((value) => value / total);
}

/** Tap offsets in texels, matching `bloomBlurWeights` index for index. */
export function bloomBlurOffsets(taps: number = BLOOM_BLUR_TAPS): number[] {
  const radius = (taps - 1) / 2;
  return Array.from({ length: taps }, (_, index) => index - radius);
}

/** Emits the unrolled tap lines so the shader carries the tested numbers. */
function emitBlurTaps(): string {
  const weights = bloomBlurWeights();
  const offsets = bloomBlurOffsets();
  return weights
    .map((weight, index) => {
      const offset = offsets[index]!.toFixed(1);
      return `  sum = sum + textureSample(textureSampler, textureSamplerSampler,\n`
        + `    fragmentInputs.vUV + uniforms.bloomBlurDirection * ${offset}).rgb\n`
        + `    * ${weight.toFixed(9)};`;
    })
    .join("\n");
}

export const BLOOM_BRIGHT_WGSL = `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

const BLOOM_PHOTOPIC: vec3f = vec3f(0.2126, 0.7152, 0.0722);

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let scene = textureSample(textureSampler, textureSamplerSampler, fragmentInputs.vUV).rgb;
  let luminance = max(dot(scene, BLOOM_PHOTOPIC), 0.0);
  // The soft-knee curve, identical to bloomBrightPassWeight. Kept in the two
  // languages deliberately -- the TS one is what the ordering tests can reach,
  // and the GPU compile test proves this one is the string that ships.
  let soft = clamp(luminance - ${BLOOM_THRESHOLD} + ${BLOOM_KNEE},
    0.0, ${2 * BLOOM_KNEE});
  let quadratic = (soft * soft) / ${4 * BLOOM_KNEE + 1e-6};
  let contribution = max(quadratic, luminance - ${BLOOM_THRESHOLD});
  // Scale the COLOUR by the ratio of contributed to actual luminance, so the
  // highlight keeps its hue instead of being pushed toward white.
  let weight = max(contribution, 0.0) / max(luminance, 1.0e-5);
  fragmentOutputs.color = vec4f(scene * weight, 1.0);
  return fragmentOutputs;
}
`;

export const BLOOM_BLUR_WGSL = `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

uniform bloomBlurDirection: vec2f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  var sum = vec3f(0.0);
${emitBlurTaps()}
  fragmentOutputs.color = vec4f(sum, 1.0);
  return fragmentOutputs;
}
`;

export const BLOOM_COMPOSITE_WGSL = `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
var bloomSceneSamplerSampler: sampler;
var bloomSceneSampler: texture_2d<f32>;

uniform bloomIntensity: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let scene = textureSample(bloomSceneSampler, bloomSceneSamplerSampler,
    fragmentInputs.vUV).rgb;
  let blurred = textureSample(textureSampler, textureSamplerSampler,
    fragmentInputs.vUV).rgb;
  // ADDITIVE, and additive is the whole reason the pass sits before the tone
  // map: the sum is scene-referred, so ACES compresses scene + halo together
  // and the halo cannot exceed display range on its own.
  fragmentOutputs.color = vec4f(scene + blurred * uniforms.bloomIntensity, 1.0);
  return fragmentOutputs;
}
`;

function registerShaders(): void {
  ShaderStore.ShadersStoreWGSL[`${BLOOM_BRIGHT_SHADER}FragmentShader`] = BLOOM_BRIGHT_WGSL;
  ShaderStore.ShadersStoreWGSL[`${BLOOM_BLUR_SHADER}FragmentShader`] = BLOOM_BLUR_WGSL;
  ShaderStore.ShadersStoreWGSL[`${BLOOM_COMPOSITE_SHADER}FragmentShader`] = BLOOM_COMPOSITE_WGSL;
}

/**
 * The four-pass bloom chain. Construct AFTER the scotopic pass and BEFORE the
 * tone map: Babylon orders a camera's post-processes by attachment order.
 */
export class BloomPass {
  /** Ratio 1.0 so the scene target keeps full resolution when this is first. */
  readonly bright: PostProcess;
  readonly blurHorizontal: PostProcess;
  readonly blurVertical: PostProcess;
  readonly composite: PostProcess;
  private attached = true;

  /** Whether the group is currently in the camera's chain. */
  get enabled(): boolean {
    return this.attached;
  }

  constructor(camera: Camera, engine: AbstractEngine, samples: number) {
    registerShaders();
    this.bright = new PostProcess(
      "bloom-bright", BLOOM_BRIGHT_SHADER, [], null,
      1, camera, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, engine, false,
      undefined, Constants.TEXTURETYPE_HALF_FLOAT, undefined, undefined,
      undefined, undefined, ShaderLanguage.WGSL,
    );
    this.blurHorizontal = this.createBlur(camera, engine, "bloom-blur-h", [1, 0]);
    this.blurVertical = this.createBlur(camera, engine, "bloom-blur-v", [0, 1]);
    this.composite = new PostProcess(
      "bloom-composite", BLOOM_COMPOSITE_SHADER, ["bloomIntensity"],
      ["bloomSceneSampler"],
      1, camera, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, engine, false,
      undefined, Constants.TEXTURETYPE_HALF_FLOAT, undefined, undefined,
      undefined, undefined, ShaderLanguage.WGSL,
    );
    this.composite.onApply = (effect) => {
      effect.setFloat("bloomIntensity", BLOOM_INTENSITY);
      // The bright pass's INPUT is the untouched scene (or the scotopic
      // output). Binding it here is what makes the composite additive against
      // the original rather than against the blurred image.
      effect.setTextureFromPostProcess("bloomSceneSampler", this.bright);
    };
    this.setSamples(samples);
  }

  private createBlur(
    camera: Camera,
    engine: AbstractEngine,
    name: string,
    direction: readonly [number, number],
  ): PostProcess {
    const pass = new PostProcess(
      name, BLOOM_BLUR_SHADER, ["bloomBlurDirection"], null,
      BLOOM_BLUR_RATIO, camera, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, engine, false,
      undefined, Constants.TEXTURETYPE_HALF_FLOAT, undefined, undefined,
      undefined, undefined, ShaderLanguage.WGSL,
    );
    pass.onApply = (effect) => {
      effect.setFloat2(
        "bloomBlurDirection",
        direction[0] / Math.max(1, pass.width),
        direction[1] / Math.max(1, pass.height),
      );
    };
    return pass;
  }

  /**
   * MSAA goes on the bright pass, which is the only member that can ever be
   * first in the chain. The rest are single-sample consumers, exactly as the
   * tone map is today.
   */
  setSamples(samples: number): void {
    this.bright.samples = Math.max(1, Math.round(samples));
    this.blurHorizontal.samples = 1;
    this.blurVertical.samples = 1;
    this.composite.samples = 1;
  }

  /**
   * Attach or detach the whole group, preserving its order.
   *
   * The group is CONSTRUCTED unconditionally, even at tiers where bloom is off,
   * and gated by attachment instead. Constructing it conditionally would fix
   * the chain order at startup, and a later profile change into a bloom-enabled
   * tier could then never insert it in the right place -- the passes would land
   * after the tone map, blooming display values. Four detached post-processes
   * cost nothing per frame; the wrong order costs a silent rendering defect.
   *
   * `firstIndex` is where the group's head belongs: 1 behind an attached
   * scotopic pass, 0 when it has been detached for daylight.
   */
  setEnabled(camera: Camera, enabled: boolean, firstIndex: number): void {
    if (enabled === this.attached) return;
    const group = [this.bright, this.blurHorizontal, this.blurVertical, this.composite];
    if (enabled) {
      group.forEach((pass, offset) => camera.attachPostProcess(pass, firstIndex + offset));
    } else {
      for (const pass of group) camera.detachPostProcess(pass);
    }
    this.attached = enabled;
  }

  dispose(camera: Camera): void {
    this.composite.dispose(camera);
    this.blurVertical.dispose(camera);
    this.blurHorizontal.dispose(camera);
    this.bright.dispose(camera);
  }
}
