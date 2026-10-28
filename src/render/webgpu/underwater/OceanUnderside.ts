import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Geometry } from "@babylonjs/core/Meshes/geometry";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { Material } from "@babylonjs/core/Materials/material";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import { PEAK_SUN_INTENSITY, type AtmosphereSnapshot } from "../atmosphere/AtmosphereSystem";
import { CarPipelinePrime, type CarPipelineCompiles } from "../ground/carPipelinePrime";
import {
  OCEAN_SURFACE_DISPLACEMENT_DECLARATIONS_WGSL,
  OCEAN_SURFACE_DISPLACEMENT_WGSL,
  OCEAN_SURFACE_SAMPLERS,
  OCEAN_SURFACE_SLOPES_WGSL,
  OCEAN_SURFACE_UNIFORMS,
} from "../water/SpectralOceanSystem";
import {
  fallbackWaterEnvironmentCube,
  WATER_CAPILLARY_DETAIL_WGSL,
  WATER_CAUSTIC_WGSL,
  WATER_DETAIL_NOISE_WGSL,
  WATER_ENVIRONMENT_MIP_WGSL,
  WATER_RENDERING_GROUP_ID,
  WATER_SHADING_CONSTANTS_WGSL,
} from "../water/WaterShaders";
import { UNDERWATER_RADIANCE_STEP, type UnderwaterLight } from "./underwaterLight";

/**
 * The sea seen from under it (walking plan, "Underwater view"): a variant of
 * the ocean material on the sea's own disk and displacement, drawn instead of
 * the sea while the camera is under the water and never otherwise.
 *
 * From below, a surface facet is a window and a mirror at once. A ray from
 * the eye meets it at angle i from its normal and leaves into the air at
 * sin t = n sin i (n = 1.333): inside about 48.6 degrees the sky, the clouds
 * and the sun come through, squeezed into a cone over the diver's head
 * (Snell's window), brightened n^2 by the squeeze and dimmed by the Fresnel
 * reflectance; past it the facet is a perfect mirror of the water below
 * (total internal reflection), and the water below is the water's own light,
 * dimmest straight down. The wave normals ripple the window's edge and fold
 * the mirror into it, which is most of what makes the surface read as water.
 *
 * Its light is radiance just under the surface: the water between it and the
 * eye is the water-column pass's, as it is for everything else under water.
 *
 * Tiers (profile data, `underwaterSnellWindow`): with the window the facets
 * are the sea's own (its cascades and capillary tail), the sky the
 * environment probe the sea reflects above water, and the sun a lobe as wide
 * as the sub-pixel waves spread it. Without it the underside is flat: one
 * window of analytic sky and sun, one mirror, no texture reads.
 */

export const OCEAN_UNDERSIDE_SHADER_NAME = "flyHighOceanUnderside";
export const OCEAN_UNDERSIDE_WINDOW_DEFINE = "UNDERSIDE_SNELL_WINDOW";

/** Refractive index of sea water against air (visible light, 15 C, 35 psu). */
export const UNDERWATER_WATER_IOR = 1.333;

/**
 * The sun's peak radiance is clamped to this, in the scene's linear units: the
 * disc through the window is ~7,000 times the sun's irradiance per steradian,
 * and the half-float targets that carry it end at 65,504.
 */
export const OCEAN_UNDERSIDE_SUN_RADIANCE_CEILING = 30_000;

const OCEAN_UNDERSIDE_SLOPE_SAMPLERS: readonly string[] = Array.from({ length: OCEAN_SURFACE_SAMPLERS.length }, (_, index) => [
  `slopeFoam${index}`,
  `slopeMoment${index}`,
]).flat();

export const OCEAN_UNDERSIDE_VERTEX_WGSL = /* wgsl */ `
attribute position: vec3f;
uniform world: mat4x4f;
uniform viewProjection: mat4x4f;
// 1 drawn; 0 while the pipeline is primed at load: every vertex collapses to
// one point and nothing rasterises.
uniform undersideDrawn: f32;
${OCEAN_SURFACE_DISPLACEMENT_DECLARATIONS_WGSL}
varying worldPosition: vec3f;
varying oceanCoordinate: vec2f;
#ifdef ${OCEAN_UNDERSIDE_WINDOW_DEFINE}
varying cascadeFades: vec4f;
varying cascadeFade4: f32;
#endif

${OCEAN_SURFACE_DISPLACEMENT_WGSL}

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  // The sea's own vertex: the same disk, the same cascades and fades, the same
  // marina shelter (the sub-26 m ripple relief, 2.8 cm, is left to the normals).
  let worldXZ = uniforms.oceanWorldOrigin + vertexInputs.position.xz;
  let fades = oceanSurfaceFades(length(vertexInputs.position.xz));
  let displacement = oceanSurfaceCascadeDisplacement(worldXZ, fades.mesh, fades.mesh4);
  let world = uniforms.world * vec4f(vertexInputs.position + displacement, 1.0);
  vertexOutputs.position = uniforms.viewProjection * world * uniforms.undersideDrawn;
  vertexOutputs.worldPosition = world.xyz;
  vertexOutputs.oceanCoordinate = worldXZ + displacement.xz;
#ifdef ${OCEAN_UNDERSIDE_WINDOW_DEFINE}
  vertexOutputs.cascadeFades = fades.pixel;
  vertexOutputs.cascadeFade4 = fades.pixel4;
#endif
}
`;

export const OCEAN_UNDERSIDE_FRAGMENT_WGSL = /* wgsl */ `
varying worldPosition: vec3f;
varying oceanCoordinate: vec2f;
#ifdef ${OCEAN_UNDERSIDE_WINDOW_DEFINE}
varying cascadeFades: vec4f;
varying cascadeFade4: f32;
#endif
uniform cameraPosition: vec3f;
uniform sunDirection: vec3f;
// The sun's irradiance at normal incidence above the water, and the sky's
// radiance at the zenith and the horizon (the sea's own atmosphere uniforms).
uniform sunIrradiance: vec3f;
uniform sunAngularRadius: f32;
uniform skyZenith: vec3f;
uniform skyHorizon: vec3f;
// The water's own light straight down, just under the surface.
uniform waterUpwelling: vec3f;
#ifdef ${OCEAN_UNDERSIDE_WINDOW_DEFINE}
uniform patchLengths0: vec4f;
uniform patchLength4: f32;
uniform cascadeCount: f32;
uniform oceanWind: vec2f;
uniform time: f32;
uniform environmentValid: f32;
var environmentCubeSampler: sampler; var environmentCube: texture_cube<f32>;
${OCEAN_UNDERSIDE_SLOPE_SAMPLERS.map((name) => `var ${name}Sampler: sampler; var ${name}: texture_2d<f32>;`).join("\n")}
#endif

${WATER_SHADING_CONSTANTS_WGSL}

const WATER_IOR: f32 = ${UNDERWATER_WATER_IOR.toFixed(3)};
const RADIANCE_STEP_LOG: f32 = ${Math.log(UNDERWATER_RADIANCE_STEP)};
const SUN_RADIANCE_CEILING: f32 = ${OCEAN_UNDERSIDE_SUN_RADIANCE_CEILING.toFixed(1)};

#ifdef ${OCEAN_UNDERSIDE_WINDOW_DEFINE}
${WATER_CAUSTIC_WGSL}
${WATER_DETAIL_NOISE_WGSL}
${WATER_CAPILLARY_DETAIL_WGSL}
${WATER_ENVIRONMENT_MIP_WGSL}
${OCEAN_SURFACE_SLOPES_WGSL}
#endif

// The sky above the water along a direction, where no probe is bound.
fn analyticSky(direction: vec3f) -> vec3f {
  return mix(uniforms.skyHorizon, uniforms.skyZenith, sqrt(clamp(direction.y, 0.0, 1.0)));
}

// The water's own light seen looking along a direction just under the
// surface: the upwelling straight down, brightening 3x toward level.
fn waterLightAlong(direction: vec3f) -> vec3f {
  return uniforms.waterUpwelling * exp(RADIANCE_STEP_LOG * (1.0 + clamp(direction.y, -1.0, 1.0)));
}

// The sun through the surface: a disc of the sun's angular radius, widened
// by spread radians, holding the sun's irradiance (a normalised Gaussian).
fn sunThrough(direction: vec3f, spread: f32) -> vec3f {
  let light = normalize(uniforms.sunDirection);
  let width = uniforms.sunAngularRadius * uniforms.sunAngularRadius + spread * spread;
  let offAxis = max(2.0 * (1.0 - dot(direction, light)), 0.0);
  let lobe = exp(-0.5 * offAxis / width) / (2.0 * PI * width);
  return min(uniforms.sunIrradiance * lobe, vec3f(SUN_RADIANCE_CEILING));
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
#ifdef ${OCEAN_UNDERSIDE_WINDOW_DEFINE}
  // The sea's facets, summed as its own fragment sums them, and the capillary
  // tail on top: the ripples right over a diver's head are the near field.
  let baseSample = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLengths0.x, slopeFoam0, slopeFoam0Sampler);
  let baseMoment = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLengths0.x, slopeMoment0, slopeMoment0Sampler);
  var slopeSum = baseSample.xy * input.cascadeFades.x;
  var slopeVariance = cascadeSlopeVariance(baseSample, baseMoment, input.cascadeFades.x);
  if (uniforms.cascadeCount > 1.5) { let sample = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLengths0.y, slopeFoam1, slopeFoam1Sampler); let moment = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLengths0.y, slopeMoment1, slopeMoment1Sampler); slopeSum += sample.xy * input.cascadeFades.y; slopeVariance += cascadeSlopeVariance(sample, moment, input.cascadeFades.y); }
  if (uniforms.cascadeCount > 2.5) { let sample = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLengths0.z, slopeFoam2, slopeFoam2Sampler); let moment = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLengths0.z, slopeMoment2, slopeMoment2Sampler); slopeSum += sample.xy * input.cascadeFades.z; slopeVariance += cascadeSlopeVariance(sample, moment, input.cascadeFades.z); }
  if (uniforms.cascadeCount > 3.5) { let sample = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLengths0.w, slopeFoam3, slopeFoam3Sampler); let moment = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLengths0.w, slopeMoment3, slopeMoment3Sampler); slopeSum += sample.xy * input.cascadeFades.w; slopeVariance += cascadeSlopeVariance(sample, moment, input.cascadeFades.w); }
  if (uniforms.cascadeCount > 4.5) { let sample = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLength4, slopeFoam4, slopeFoam4Sampler); let moment = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLength4, slopeMoment4, slopeMoment4Sampler); slopeSum += sample.xy * input.cascadeFade4; slopeVariance += cascadeSlopeVariance(sample, moment, input.cascadeFade4); }
  let capillary = waterCapillaryDetail(
    input.oceanCoordinate,
    uniforms.oceanWind,
    uniforms.time,
    length(slopeSum),
    WaterCausticBeam(0.0, 0.0),
  );
  slopeSum += capillary.slope;
  slopeVariance += capillary.unresolvedMeanSquareSlope;
  let up = normalize(vec3f(slopeSum.x, 1.0, slopeSum.y));
  let unresolvedSlope = sqrt(min(slopeVariance, 0.36));
#else
  let up = vec3f(0.0, 1.0, 0.0);
  let unresolvedSlope = 0.0;
#endif
  let incident = normalize(input.worldPosition - uniforms.cameraPosition);
  // The facet's side the eye is on, and the index the ray leaves into. From
  // above (a trough seen past a crest the camera is under) it is the sea
  // seen from the air, which this variant shades as plain water.
  let fromBelow = uniforms.cameraPosition.y < input.worldPosition.y;
  let normal = select(up, -up, fromBelow);
  let eta = select(1.0 / WATER_IOR, WATER_IOR, fromBelow);
  let cosIncident = clamp(-dot(incident, normal), 0.0, 1.0);
  let sinTransmittedSquared = eta * eta * (1.0 - cosIncident * cosIncident);
  var reflectance = 1.0;
  var transmitted = vec3f(0.0);
  if (sinTransmittedSquared < 1.0) {
    let cosTransmitted = sqrt(1.0 - sinTransmittedSquared);
    // Fresnel, unpolarised, exact (Schlick is poor this close to the
    // critical angle, where the window's rim brightens into the mirror).
    let perpendicular = (eta * cosIncident - cosTransmitted) / (eta * cosIncident + cosTransmitted);
    let parallel = (cosIncident - eta * cosTransmitted) / (cosIncident + eta * cosTransmitted);
    reflectance = 0.5 * (perpendicular * perpendicular + parallel * parallel);
    let direction = eta * incident + (eta * cosIncident - cosTransmitted) * normal;
    // A sub-pixel tilt of the facet turns the ray leaving it by this much
    // more: 0.33 of the tilt overhead, without bound at the window's rim.
    let spread = unresolvedSlope * min(abs(eta * cosIncident / max(cosTransmitted, 0.05) - 1.0), 4.0);
    var beyond: vec3f;
    if (fromBelow) {
#ifdef ${OCEAN_UNDERSIDE_WINDOW_DEFINE}
      let probe = textureSampleLevel(
        environmentCube,
        environmentCubeSampler,
        direction,
        environmentRoughnessToMip(sqrt(spread)),
      ).rgb;
      let sky = mix(analyticSky(direction), probe, uniforms.environmentValid);
#else
      let sky = analyticSky(direction);
#endif
      beyond = sky + sunThrough(direction, spread);
    } else {
      beyond = waterLightAlong(direction);
    }
    // Radiance through an interface scales with the index squared: the sky
    // above is squeezed into the window's cone, n^2 = 1.78 times brighter.
    transmitted = (1.0 - reflectance) * eta * eta * beyond;
  }
  let mirrored = select(analyticSky(reflect(incident, normal)), waterLightAlong(reflect(incident, normal)), fromBelow);
  fragmentOutputs.color = vec4f(max(transmitted + reflectance * mirrored, vec3f(0.0)), 1.0);
}
`;

function registerShaders(): void {
  ShaderStore.ShadersStoreWGSL[`${OCEAN_UNDERSIDE_SHADER_NAME}VertexShader`] = OCEAN_UNDERSIDE_VERTEX_WGSL;
  ShaderStore.ShadersStoreWGSL[`${OCEAN_UNDERSIDE_SHADER_NAME}FragmentShader`] = OCEAN_UNDERSIDE_FRAGMENT_WGSL;
}

/** The parts of `SpectralOceanSystem` the underside draws with. */
export interface OceanUndersideSea {
  /** The sea's drawn disk: the underside shares its geometry and follows its snap. */
  readonly presentationMesh: Mesh;
  bindSurface(material: ShaderMaterial): void;
  bindSlopes(material: ShaderMaterial): void;
  setSurfaceHidden(hidden: boolean): void;
}

export interface OceanUndersideOptions {
  readonly scene: Scene;
  readonly camera: Camera;
  readonly sea: OceanUndersideSea;
  readonly light: UnderwaterLight;
  /** The sky probe the sea reflects (null until one exists: the analytic sky stands in). */
  readonly environmentCube: BaseTexture | null;
  readonly snellWindow: boolean;
  /** The renderer's off-frame pipeline compiles: the underside's pipeline is built at load. */
  readonly pipelineCompiles: CarPipelineCompiles | null;
}

export class OceanUnderside {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly sea: OceanUndersideSea;
  private readonly camera: Camera;
  private readonly light: UnderwaterLight;
  private readonly prime: CarPipelinePrime;
  private readonly upwelling = new Vector3();
  private readonly sunIrradiance = new Vector3();
  private geometry: Geometry | null = null;
  private drawn = false;
  private snellWindow: boolean;

  constructor(options: OceanUndersideOptions) {
    registerShaders();
    this.sea = options.sea;
    this.camera = options.camera;
    this.light = options.light;
    this.snellWindow = options.snellWindow;
    this.material = new ShaderMaterial(
      "spectral-ocean-underside",
      options.scene,
      { vertex: OCEAN_UNDERSIDE_SHADER_NAME, fragment: OCEAN_UNDERSIDE_SHADER_NAME },
      {
        attributes: ["position"],
        uniforms: [
          "world",
          "viewProjection",
          "undersideDrawn",
          ...OCEAN_SURFACE_UNIFORMS,
          "cameraPosition",
          "sunDirection",
          "sunIrradiance",
          "sunAngularRadius",
          "skyZenith",
          "skyHorizon",
          "waterUpwelling",
          "oceanWind",
          "time",
          "environmentValid",
        ],
        samplers: [...OCEAN_SURFACE_SAMPLERS, ...OCEAN_UNDERSIDE_SLOPE_SAMPLERS, "environmentCube"],
        defines: this.snellWindow ? [OCEAN_UNDERSIDE_WINDOW_DEFINE] : [],
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );
    // From below the disk shows its back; the water column fades it by the
    // depth behind it, so it writes none of its own.
    this.material.backFaceCulling = false;
    this.material.transparencyMode = Material.MATERIAL_OPAQUE;
    this.material.alphaMode = Constants.ALPHA_DISABLE;
    this.material.disableDepthWrite = true;
    const environment = options.environmentCube ?? fallbackWaterEnvironmentCube(options.scene);
    if (environment) this.material.setTexture("environmentCube", environment);
    this.material.setFloat("environmentValid", options.environmentCube ? 1 : 0);
    this.material.setFloat("undersideDrawn", 0);
    this.mesh = new Mesh("spectral-ocean-underside", options.scene);
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.renderingGroupId = WATER_RENDERING_GROUP_ID;
    this.mesh.metadata = { waterSurface: true, excludePlanarReflection: true };
    this.mesh.material = this.material;
    this.followSea();
    this.mesh.setEnabled(false);
    this.prime = new CarPipelinePrime(options.pipelineCompiles);
    this.prime.adopt(this.material);
  }

  /** Whether the underside drew this frame (the camera is under the sea). */
  get drawing(): boolean {
    return this.drawn;
  }

  /** The tier's underside: the define recompiles it, and the new pipeline is primed again. */
  setSnellWindow(snellWindow: boolean): void {
    if (snellWindow === this.snellWindow) return;
    this.snellWindow = snellWindow;
    this.material.setDefine(OCEAN_UNDERSIDE_WINDOW_DEFINE, snellWindow);
    this.prime.adopt(this.material);
  }

  setAtmosphere(atmosphere: AtmosphereSnapshot): void {
    const sun = atmosphere.sunColor;
    const scale = atmosphere.sunIlluminanceNormalized * PEAK_SUN_INTENSITY;
    this.sunIrradiance.set(sun.r * scale, sun.g * scale, sun.b * scale);
    this.material.setVector3("sunIrradiance", this.sunIrradiance);
    this.material.setVector3("sunDirection", atmosphere.sunDirection);
    this.material.setFloat("sunAngularRadius", atmosphere.sunAngularRadiusRadians);
    this.material.setColor3("skyZenith", atmosphere.skyZenith);
    this.material.setColor3("skyHorizon", atmosphere.skyHorizon);
  }

  /**
   * Each frame after the sea's `update`: the underside draws instead of the
   * sea while `submerged`, and above the water it is primed (drawn collapsed)
   * until its pipeline is built, then out of the scene.
   */
  update(submerged: boolean, timeSeconds: number): void {
    const priming = !submerged && this.prime.wanted(this.mesh);
    const enabled = submerged || priming;
    if (submerged !== this.drawn) {
      this.drawn = submerged;
      this.sea.setSurfaceHidden(submerged);
      this.material.setFloat("undersideDrawn", submerged ? 1 : 0);
    }
    if (this.mesh.isEnabled(false) !== enabled) this.mesh.setEnabled(enabled);
    if (!enabled) return;
    this.followSea();
    this.sea.bindSurface(this.material);
    this.sea.bindSlopes(this.material);
    this.material.setFloat("time", timeSeconds);
    this.material.setVector3("cameraPosition", this.camera.position);
    const sun = this.light.sunUpwelling;
    const sky = this.light.skyUpwelling;
    this.upwelling.set(sun[0]! + sky[0]!, sun[1]! + sky[1]!, sun[2]! + sky[2]!);
    this.material.setVector3("waterUpwelling", this.upwelling);
  }

  dispose(): void {
    if (this.drawn) this.sea.setSurfaceHidden(false);
    this.mesh.dispose(false, false);
    this.material.dispose(true, false);
  }

  /** The sea's disk as drawn this frame: its geometry (rebuilt with the tier) and its snapped place. */
  private followSea(): void {
    const sea = this.sea.presentationMesh;
    const geometry = sea.geometry;
    if (geometry && geometry !== this.geometry) {
      geometry.applyToMesh(this.mesh);
      this.geometry = geometry;
    }
    this.mesh.position.copyFrom(sea.position);
  }
}
