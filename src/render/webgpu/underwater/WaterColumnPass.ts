import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { UNDERWATER_RADIANCE_STEP, type UnderwaterLight } from "./underwaterLight";

const WATER_COLUMN_SHADER_NAME = "aerolithUnderwaterColumn";

/** Defined when the scene's depth is the multisampled target's resolved r32float copy. */
const RESOLVED_DEPTH_DEFINE = "#define SCENE_DEPTH_RESOLVED";

/**
 * A view ray with nothing drawn on it (reversed depth's clear value) runs this
 * far, metres: optically infinite in any water.
 */
const UNDRAWN_DISTANCE_METERS = 1.0e6;

/**
 * The floor on `c - K mu`, as a fraction of `c`, for a path climbing toward
 * the surface: the light it climbs into brightens at `K`, never as fast as the
 * beam dies at `c`, but the floor keeps the fade finite for any water type.
 */
const RISING_PATH_FLOOR = 0.2;

/**
 * The water between the camera and everything it sees, while the camera is
 * under the water (walking plan, "Underwater view").
 *
 * A full-screen pass at the HEAD of the post chain, so it owns the scene's
 * target and its depth (`firstPassSampleAssignment`), and it runs only while
 * the camera is submerged: above the water it is not in the chain at all.
 * Per pixel, with `s` the metres of water along the view ray, `mu` the ray's
 * upward cosine and `z` depths below the still surface:
 *
 *   L = L_scene * dim(z_hit) * exp(-c s)
 *     + sum over sun, sky of L_water(z_camera, mu) (1 - exp(-(c - K mu) s))
 *
 * `dim` is what the light from above lost on its way down to what the ray
 * hit (the scene lit it as if in air), `exp(-c s)` what the ray loses on its
 * way back, and the second term the water's own light (`UnderwaterLight`)
 * scattered into the ray: in an asymptotic light field the radiance along a
 * ray of any length is exactly these two, which is why the fade needs no
 * second constant. A ray climbing toward the surface stops there: what lies
 * beyond is the surface's own business (the ocean underside).
 */
export const WATER_COLUMN_FRAGMENT_WGSL = /* wgsl */ `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
#ifdef SCENE_DEPTH_RESOLVED
var sceneDepth: texture_2d<f32>;
#else
var sceneDepth: texture_depth_2d;
#endif

uniform inverseProjection: mat4x4f;
uniform viewToWorld: mat4x4f;
uniform waterAttenuation: vec3f;
uniform sunDiffuseAttenuation: vec3f;
uniform skyDiffuseAttenuation: vec3f;
uniform sunUpwelling: vec3f;
uniform skyUpwelling: vec3f;
uniform directFraction: f32;
// Metres below the still surface (the light) and below the drawn surface
// (where a rising ray leaves the water).
uniform cameraStillDepth: f32;
uniform cameraSurfaceDepth: f32;
// 0 draws the scene through untouched (the load-time warm-up), 1 the water.
uniform waterColumnStrength: f32;

const RADIANCE_STEP_LOG: f32 = ${Math.log(UNDERWATER_RADIANCE_STEP)};

fn sceneDepthAt(coord: vec2i) -> f32 {
#ifdef SCENE_DEPTH_RESOLVED
  return textureLoad(sceneDepth, coord, 0).r;
#else
  return textureLoad(sceneDepth, coord, 0);
#endif
}

// The water's own light along a ray of s metres from the camera, rising at mu.
fn waterPathRadiance(upwelling: vec3f, diffuse: vec3f, mu: f32, s: f32) -> vec3f {
  let rate = max(uniforms.waterAttenuation - diffuse * mu, uniforms.waterAttenuation * ${RISING_PATH_FLOOR});
  return upwelling * exp(-diffuse * uniforms.cameraStillDepth) * (vec3f(1.0) - exp(-rate * s));
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let scene = textureSampleLevel(textureSampler, textureSamplerSampler, fragmentInputs.vUV, 0.0).rgb;
  // The scene target is drawn Y-flipped like every render target, so its
  // texel rows and the clip-space Y the scene was drawn with both run with vUV.
  let size = vec2f(textureDimensions(sceneDepth, 0));
  let depth = sceneDepthAt(vec2i(min(fragmentInputs.vUV * size, size - vec2f(1.0))));
  let ndc = fragmentInputs.vUV * 2.0 - vec2f(1.0);
  let onRay = uniforms.inverseProjection * vec4f(ndc, 0.5, 1.0);
  let ray = normalize((uniforms.viewToWorld * vec4f(onRay.xyz / onRay.w, 0.0)).xyz);
  let hit = uniforms.inverseProjection * vec4f(ndc, depth, 1.0);
  let drawn = depth > 0.0 && abs(hit.w) > 1.0e-12;
  var s = select(${UNDRAWN_DISTANCE_METERS.toFixed(1)}, length(hit.xyz / hit.w), drawn);
  let mu = ray.y;
  if (mu > 0.0) {
    s = min(s, max(uniforms.cameraSurfaceDepth, 0.0) / mu);
  }
  let hitDepth = max(uniforms.cameraStillDepth - mu * s, 0.0);
  let dim = uniforms.directFraction * exp(-uniforms.sunDiffuseAttenuation * hitDepth)
    + (1.0 - uniforms.directFraction) * exp(-uniforms.skyDiffuseAttenuation * hitDepth);
  let brightening = exp(RADIANCE_STEP_LOG * (1.0 + mu));
  let water = scene * dim * exp(-uniforms.waterAttenuation * s)
    + brightening * (
      waterPathRadiance(uniforms.sunUpwelling, uniforms.sunDiffuseAttenuation, mu, s)
      + waterPathRadiance(uniforms.skyUpwelling, uniforms.skyDiffuseAttenuation, mu, s)
    );
  fragmentOutputs.color = vec4f(mix(scene, max(water, vec3f(0.0)), uniforms.waterColumnStrength), 1.0);
  return fragmentOutputs;
}
`;

function registerShader(): void {
  ShaderStore.ShadersStoreWGSL[`${WATER_COLUMN_SHADER_NAME}FragmentShader`] = WATER_COLUMN_FRAGMENT_WGSL;
}

/** The depth texture the pass reads: the scene target's, as the chain head owns it. */
interface DepthTarget {
  readonly depthStencilTexture: unknown;
  resolveMSAADepth: boolean;
}

export class WaterColumnPass {
  readonly postProcess: PostProcess;
  private readonly light: UnderwaterLight;
  private attached = false;
  private resolvedDepth = false;
  private drawn = false;
  private strength = 1;
  private cameraStillDepth = 0;
  private cameraSurfaceDepth = 0;
  private readonly inverseProjection = new Matrix();
  private readonly viewToWorld = new Matrix();

  constructor(camera: Camera, engine: AbstractEngine, samples: number, light: UnderwaterLight) {
    registerShader();
    this.light = light;
    const count = Math.max(1, Math.round(samples));
    this.resolvedDepth = count > 1;
    this.postProcess = new PostProcess(
      "underwater-column",
      WATER_COLUMN_SHADER_NAME,
      [
        "inverseProjection",
        "viewToWorld",
        "waterAttenuation",
        "sunDiffuseAttenuation",
        "skyDiffuseAttenuation",
        "sunUpwelling",
        "skyUpwelling",
        "directFraction",
        "cameraStillDepth",
        "cameraSurfaceDepth",
        "waterColumnStrength",
      ],
      ["sceneDepth"],
      1,
      camera,
      Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
      engine,
      false,
      this.resolvedDepth ? RESOLVED_DEPTH_DEFINE : null,
      Constants.TEXTURETYPE_HALF_FLOAT,
      undefined,
      undefined,
      undefined,
      undefined,
      ShaderLanguage.WGSL,
    );
    // Built attached (the constructor's only way to know its camera), held
    // out of the chain until the camera goes under.
    camera.detachPostProcess(this.postProcess);
    this.postProcess.samples = count;
    // The head's scene target resolves its multisampled depth only when asked.
    this.postProcess.onActivateObservable.add(() => {
      const target = this.postProcess.inputTexture as unknown as DepthTarget | null;
      if (target && this.resolvedDepth) target.resolveMSAADepth = true;
    });
    this.postProcess.onApply = (effect) => this.apply(effect, camera);
  }

  /** Whether the pass is in the camera's chain. */
  get enabled(): boolean {
    return this.attached;
  }

  get samples(): number {
    return this.postProcess.samples;
  }

  /** Whether the pass's shader is compiled, so a frame can draw it. */
  get ready(): boolean {
    return this.postProcess.isReady();
  }

  /**
   * Whether a frame has drawn the pass since its shader last changed: that
   * draw built its render pipeline (a post-process builds it in the frame).
   */
  get warmed(): boolean {
    return this.drawn;
  }

  /**
   * The scene target's sample count while this pass heads the chain. Over 1
   * the depth arrives as the resolved r32float copy, so the shader is rebuilt
   * for that binding (a profile change, never a frame-to-frame one).
   */
  setSamples(samples: number): void {
    const count = Math.max(1, Math.round(samples));
    this.postProcess.samples = count;
    const resolved = count > 1;
    if (resolved !== this.resolvedDepth) {
      this.resolvedDepth = resolved;
      this.drawn = false;
      this.postProcess.updateEffect(resolved ? RESOLVED_DEPTH_DEFINE : null);
    }
  }

  /** Put the pass at the head of the chain, or take it out. */
  setEnabled(camera: Camera, enabled: boolean): void {
    if (enabled === this.attached) return;
    if (enabled) {
      camera.attachPostProcess(this.postProcess, 0);
    } else {
      camera.detachPostProcess(this.postProcess);
    }
    this.attached = enabled;
  }

  /**
   * Back to the head after another pass was attached there (rod vision
   * attaches at 0 as dusk falls): the water is in the scene, rods are in the
   * eye, so the water comes first.
   */
  keepAtHead(camera: Camera): boolean {
    if (!this.attached) return false;
    const chain = camera._postProcesses;
    const first = chain.find((pass) => pass != null) ?? null;
    if (first === this.postProcess) return false;
    camera.detachPostProcess(this.postProcess);
    camera.attachPostProcess(this.postProcess, 0);
    return true;
  }

  /**
   * The camera's depth below the still surface (where the light from above
   * has dimmed to) and below the drawn surface (where a rising ray leaves the
   * water), metres.
   */
  setCameraDepth(stillDepth: number, surfaceDepth: number): void {
    this.cameraStillDepth = Math.max(stillDepth, 0);
    this.cameraSurfaceDepth = Math.max(surfaceDepth, 0);
  }

  /** 0 passes the scene through untouched (a warm-up draw); 1 is the water. */
  setStrength(strength: number): void {
    this.strength = Math.min(Math.max(strength, 0), 1);
  }

  private apply(effect: Effect, camera: Camera): void {
    camera.getProjectionMatrix().invertToRef(this.inverseProjection);
    camera.getViewMatrix().invertToRef(this.viewToWorld);
    effect.setMatrix("inverseProjection", this.inverseProjection);
    effect.setMatrix("viewToWorld", this.viewToWorld);
    const light = this.light;
    effect.setFloat3("waterAttenuation", light.attenuation[0], light.attenuation[1], light.attenuation[2]);
    effect.setFloat3(
      "sunDiffuseAttenuation",
      light.sunDiffuseAttenuation[0],
      light.sunDiffuseAttenuation[1],
      light.sunDiffuseAttenuation[2],
    );
    effect.setFloat3(
      "skyDiffuseAttenuation",
      light.skyDiffuseAttenuation[0],
      light.skyDiffuseAttenuation[1],
      light.skyDiffuseAttenuation[2],
    );
    effect.setFloat3("sunUpwelling", light.sunUpwelling[0], light.sunUpwelling[1], light.sunUpwelling[2]);
    effect.setFloat3("skyUpwelling", light.skyUpwelling[0], light.skyUpwelling[1], light.skyUpwelling[2]);
    effect.setFloat("directFraction", light.directFraction);
    effect.setFloat("cameraStillDepth", this.cameraStillDepth);
    effect.setFloat("cameraSurfaceDepth", this.cameraSurfaceDepth);
    effect.setFloat("waterColumnStrength", this.strength);
    this.drawn = true;
    const target = this.postProcess.inputTexture as unknown as DepthTarget | null;
    if (target?.depthStencilTexture) {
      (effect as unknown as { _bindTexture(name: string, texture: unknown): void })._bindTexture(
        "sceneDepth",
        target.depthStencilTexture,
      );
    }
  }

  dispose(camera: Camera): void {
    this.postProcess.dispose(camera);
  }
}
