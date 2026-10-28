import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { OCEAN_SURFACE_SLOPES_WGSL, type OceanCausticTarget } from "../water/SpectralOceanSystem";
import {
  WATER_CAPILLARY_DETAIL_WGSL,
  WATER_CAUSTIC_WGSL,
  WATER_DETAIL_NOISE_WGSL,
} from "../water/WaterShaders";
import { UNDERWATER_RADIANCE_STEP, type UnderwaterLight } from "./underwaterLight";

const WATER_COLUMN_SHADER_NAME = "aerolithUnderwaterColumn";

/** Defined when the scene's depth is the multisampled target's resolved r32float copy. */
const RESOLVED_DEPTH_DEFINE = "#define SCENE_DEPTH_RESOLVED";
/** Defined on the tiers that lay the sea's caustics on what the water column sees. */
const CAUSTICS_DEFINE = "#define WATER_COLUMN_CAUSTICS";

const CAUSTIC_SLOPE_SAMPLERS: readonly string[] = Array.from({ length: 5 }, (_, index) => `slopeFoam${index}`);

/** The sea's caustic sources (`SpectralOceanSystem.bindCaustics`). */
export interface WaterColumnCausticSource {
  bindCaustics(target: OceanCausticTarget): void;
}

/**
 * A cascade's caustic fades out where the footprint of a pixel on what it
 * lands on reaches this fraction of the band's wavelength (gone at the upper
 * value: two pixels a wavelength), as the sea's own cascades fade by pixel.
 */
const CAUSTIC_FOOTPRINT_FADE_LOW = 0.15;
const CAUSTIC_FOOTPRINT_FADE_HIGH = 0.5;

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
 *
 * On the tiers with caustics (`underwaterCaustics`) the sun's share of `dim`
 * carries the sea's caustic web where the ray lands under the water: the same
 * surface curvature (each cascade's stored Jacobian and the capillary tail)
 * focused by the same refracted beam (`WATER_CAUSTIC_WGSL`) the sea lays on
 * its bed when seen from above, so a bed shows one pattern from either side.
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
#ifdef WATER_COLUMN_CAUSTICS
// Render space to world xz (the floating origin), and the sea's caustic sources.
uniform worldOrigin: vec2f;
uniform sunElevationSine: f32;
uniform time: f32;
uniform oceanWind: vec2f;
uniform patchLengths0: vec4f;
uniform patchLength4: f32;
uniform cascadeCount: f32;
uniform causticCurvatureScales0: vec4f;
uniform causticCurvatureScale4: f32;
uniform cascadeWavelengths0: vec4f;
uniform cascadeWavelength4: f32;
// 1 in the sea; 0 in a lake or river, whose caustics are the capillary tail's
// alone, as they are seen from above (inland water carries no Jacobian).
uniform seaCascades: f32;
${CAUSTIC_SLOPE_SAMPLERS.map((name) => `var ${name}Sampler: sampler; var ${name}: texture_2d<f32>;`).join("\n")}

${WATER_CAUSTIC_WGSL}
${WATER_DETAIL_NOISE_WGSL}
${WATER_CAPILLARY_DETAIL_WGSL}
${OCEAN_SURFACE_SLOPES_WGSL}

// The collimated share's gain at a point under the water, depth metres below
// the still surface: the sea's caustic sheet (1 where there is none).
fn waterColumnCaustic(worldXZ: vec2f, depth: f32) -> f32 {
  let beam = waterRefractedSunBeam(depth, uniforms.sunElevationSine);
  let footprint = max(length(dpdx(worldXZ)), length(dpdy(worldXZ)));
  let capillary = waterCapillaryDetail(worldXZ, uniforms.oceanWind, uniforms.time, 0.0, beam);
  var jacobians = vec4f(1.0);
  var jacobian4 = 1.0;
  jacobians.x = sampleSlopeTexture(worldXZ, uniforms.patchLengths0.x, slopeFoam0, slopeFoam0Sampler).w;
  if (uniforms.cascadeCount > 1.5) { jacobians.y = sampleSlopeTexture(worldXZ, uniforms.patchLengths0.y, slopeFoam1, slopeFoam1Sampler).w; }
  if (uniforms.cascadeCount > 2.5) { jacobians.z = sampleSlopeTexture(worldXZ, uniforms.patchLengths0.z, slopeFoam2, slopeFoam2Sampler).w; }
  if (uniforms.cascadeCount > 3.5) { jacobians.w = sampleSlopeTexture(worldXZ, uniforms.patchLengths0.w, slopeFoam3, slopeFoam3Sampler).w; }
  if (uniforms.cascadeCount > 4.5) { jacobian4 = sampleSlopeTexture(worldXZ, uniforms.patchLength4, slopeFoam4, slopeFoam4Sampler).w; }
  let fades = vec4f(1.0) - smoothstep(
    vec4f(${CAUSTIC_FOOTPRINT_FADE_LOW}),
    vec4f(${CAUSTIC_FOOTPRINT_FADE_HIGH}),
    vec4f(footprint) / max(uniforms.cascadeWavelengths0, vec4f(0.001)),
  );
  let fade4 = 1.0 - smoothstep(
    ${CAUSTIC_FOOTPRINT_FADE_LOW},
    ${CAUSTIC_FOOTPRINT_FADE_HIGH},
    footprint / max(uniforms.cascadeWavelength4, 0.001),
  );
  let caustic = waterCausticCascadeBands(
    capillary.caustic,
    jacobians,
    jacobian4,
    uniforms.causticCurvatureScales0 * fades * uniforms.seaCascades,
    uniforms.causticCurvatureScale4 * fade4 * uniforms.seaCascades,
    beam,
  );
  return waterCausticSheetGain(caustic, beam);
}
#endif

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
  // Nothing drawn: a finite stand-in, so its neighbours' derivatives stay finite.
  let hitView = select(vec3f(0.0, 0.0, -1.0), hit.xyz / hit.w, drawn);
  let mu = ray.y;
  let hitDistance = select(${UNDRAWN_DISTANCE_METERS.toFixed(1)}, length(hitView), drawn);
  // A rising ray stops at the surface.
  let s = select(
    hitDistance,
    min(hitDistance, max(uniforms.cameraSurfaceDepth, 0.0) / max(mu, 1.0e-6)),
    mu > 0.0,
  );
  let hitDepth = max(uniforms.cameraStillDepth - mu * s, 0.0);
#ifdef WATER_COLUMN_CAUSTICS
  let worldHit = (uniforms.viewToWorld * vec4f(hitView, 1.0)).xyz;
  let caustic = select(1.0, waterColumnCaustic(worldHit.xz + uniforms.worldOrigin, hitDepth), drawn);
#else
  let caustic = 1.0;
#endif
  let dim = uniforms.directFraction * exp(-uniforms.sunDiffuseAttenuation * hitDepth) * caustic
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

export interface WaterColumnCaustics {
  readonly source: WaterColumnCausticSource;
  /** `profile.underwaterCaustics`. */
  readonly enabled: boolean;
}

export class WaterColumnPass {
  readonly postProcess: PostProcess;
  private readonly light: UnderwaterLight;
  private readonly causticSource: WaterColumnCausticSource | null;
  private caustics: boolean;
  private timeSeconds = 0;
  private worldOriginX = 0;
  private worldOriginZ = 0;
  private seaCascades = 1;
  private attached = false;
  private resolvedDepth = false;
  private drawn = false;
  private strength = 1;
  private cameraStillDepth = 0;
  private cameraSurfaceDepth = 0;
  private readonly inverseProjection = new Matrix();
  private readonly viewToWorld = new Matrix();

  constructor(
    camera: Camera,
    engine: AbstractEngine,
    samples: number,
    light: UnderwaterLight,
    caustics: WaterColumnCaustics | null = null,
  ) {
    registerShader();
    this.light = light;
    this.causticSource = caustics?.source ?? null;
    this.caustics = this.causticSource !== null && (caustics?.enabled ?? false);
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
        "worldOrigin",
        "sunElevationSine",
        "time",
        "oceanWind",
        "patchLengths0",
        "patchLength4",
        "cascadeCount",
        "causticCurvatureScales0",
        "causticCurvatureScale4",
        "cascadeWavelengths0",
        "cascadeWavelength4",
        "seaCascades",
      ],
      ["sceneDepth", ...CAUSTIC_SLOPE_SAMPLERS],
      1,
      camera,
      Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
      engine,
      false,
      this.defines(),
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
      this.postProcess.updateEffect(this.defines());
    }
  }

  /** The tier's caustics (`profile.underwaterCaustics`): a new shader, warmed again. */
  setCaustics(enabled: boolean): void {
    const caustics = enabled && this.causticSource !== null;
    if (caustics === this.caustics) return;
    this.caustics = caustics;
    this.drawn = false;
    this.postProcess.updateEffect(this.defines());
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

  /**
   * The frame's clock (the sea's, which the caustics' capillary tail rides),
   * the floating origin (world x and z at the render origin), and whether the
   * camera's water is the sea: only the sea's cascades fold light on its bed.
   */
  setWorld(timeSeconds: number, worldOriginX: number, worldOriginZ: number, sea: boolean): void {
    this.timeSeconds = timeSeconds;
    this.worldOriginX = worldOriginX;
    this.worldOriginZ = worldOriginZ;
    this.seaCascades = sea ? 1 : 0;
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
    if (this.caustics && this.causticSource) {
      this.causticSource.bindCaustics(effect);
      effect.setFloat2("worldOrigin", this.worldOriginX, this.worldOriginZ);
      effect.setFloat("sunElevationSine", light.sunElevationSine);
      effect.setFloat("time", this.timeSeconds);
      effect.setFloat("seaCascades", this.seaCascades);
    }
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

  private defines(): string | null {
    const defines = [
      this.resolvedDepth ? RESOLVED_DEPTH_DEFINE : null,
      this.caustics ? CAUSTICS_DEFINE : null,
    ].filter((define) => define !== null);
    return defines.length > 0 ? defines.join("\n") : null;
  }
}
