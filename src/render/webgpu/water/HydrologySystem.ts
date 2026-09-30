import type { Camera } from "@babylonjs/core/Cameras/camera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import type { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { Matrix, Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { Material } from "@babylonjs/core/Materials/material";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { AtmosphereSnapshot } from "@/src/render/webgpu/atmosphere/AtmosphereSystem";
import type { WorldSeed } from "@/src/world";
import {
  CLOUD_SHADOW_RECEIVER_SAMPLER,
  CLOUD_SHADOW_RECEIVER_UNIFORMS,
  CLOUD_SHADOW_RECEIVER_WGSL,
  resolveCloudShadowReceiverBinding,
  type CloudShadowProjection,
} from "@/src/render/webgpu/clouds/CloudShadowReceiver";
import {
  AERIAL_PERSPECTIVE_UNIFORMS,
  AERIAL_PERSPECTIVE_WGSL,
  applyAerialPerspectiveToShaderMaterial,
  type AerialPerspectiveBinding,
} from "@/src/render/webgpu/atmosphere/AerialPerspective";
import { HORIZON_FIELD_LOOKUP_WGSL } from "@/src/render/webgpu/terrain/HorizonField";
import {
  generateHydrology,
  hydrologyGenerationConfigData,
  type HydrologyGenerationOptions,
  type HydrologyGenerationResult,
  type HydrologyGenerationConfig,
  type HydrologyLake,
  resolveHydrologyConfig,
} from "./HydrologyGeneration";
import {
  HydrologyGenerationClient,
  type HydrologyGenerationClientLike,
  type HydrologyRegionGenerationResult,
} from "./HydrologyGenerationClient";
import {
  resolveHydrologyPagingConfig,
  selectHydrologyRegion,
  type HydrologyPagingConfig,
  type HydrologyPagingObserver,
  type HydrologyPagingOptions,
  type HydrologyRegionSelection,
} from "./HydrologyPaging";
import {
  PLANAR_REFLECTION_FRAGMENT_WGSL,
  PLANAR_REFLECTION_SAMPLER,
  PLANAR_REFLECTION_UNIFORMS,
  acceptsInlandPlanarReflection,
  type PlanarReflectionBinding,
  type PlanarReflectionReceiver,
} from "./PlanarWaterReflectionSystem";
import {
  bindSunShadowReceiver,
  SUN_SHADOW_FRAGMENT_WGSL,
  SUN_SHADOW_SAMPLER,
  SUN_SHADOW_UNIFORMS,
  SUN_SHADOW_VERTEX_DECLARATIONS_WGSL,
  sunShadowVertexAssignmentWgsl,
  type SunShadowReceiverBinding,
} from "./SunShadowReceiver";
import {
  WATER_CONSTITUENT_WGSL,
} from "./WaterConstituents";
import {
  applyWaterOpticalType,
  WATER_REFERENCE_OPTICAL_TYPE,
  type WaterOpticalType,
  fallbackWaterEnvironmentCube,
  fallbackWaterPlanarTexture,
  configureDepthAwareWaterRendering,
  WATER_BATHYMETRY_DECLARATIONS_WGSL,
  WATER_CHANNEL_FLOW_WGSL,
  WATER_DEPTH_OPTICS_WGSL,
  WATER_ENVIRONMENT_MIP_WGSL,
  WATER_FOAM_WGSL,
  WATER_CAPILLARY_DETAIL_WGSL,
  WATER_DETAIL_NOISE_WGSL,
  WATER_FAR_FIELD_WGSL,
  WATER_FAR_GUST_WGSL,
  WATER_GLINT_DRIFT_FRACTION,
  WATER_GLINT_FACET_LENGTH_METERS,
  WATER_GLINT_SPARKLE_FOOTPRINT_HIGH,
  WATER_GLINT_SPARKLE_FOOTPRINT_LOW,
  WATER_GLINT_TWINKLE_HZ,
  WATER_ROUGH_FRESNEL_MAX_VARIANCE,
  WATER_FRESNEL_SCHLICK_WGSL,
  WATER_SHADING_CONSTANTS_WGSL,
  WATER_SHORE_RUNUP_WGSL,
  WATER_SUN_SPECULAR_WGSL,
  WATER_RENDERING_GROUP_ID,
  waterReflectedSkyWgsl,
  type WaterReflectedSkyParameters,
} from "./WaterShaders";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { BathymetryClipmap } from "./BathymetryClipmap";
import type { ChannelHydrologyGeometry } from "./ChannelNetwork";
import {
  appendContainedLake,
  appendGraphLake,
  appendGraphRiver,
  appendRiver,
  emptyMeshArrays,
  HYDROLOGY_NEUTRAL_CLIMATE,
  type HydrologyClimateSampler,
  type HydrologyMeshArrays,
} from "./hydrologyMeshArrays";

// The geometry builders moved to hydrologyMeshArrays.ts (P2b); the names this
// module always exported stay exported from here.
export {
  appendContainedLake,
  buildGraphHydrologyMeshArrays,
  HYDROLOGY_NEUTRAL_CLIMATE,
  type HydrologyClimateSample,
  type HydrologyClimateSampler,
  type HydrologyMeshArrays,
} from "./hydrologyMeshArrays";

type MeshArrays = HydrologyMeshArrays;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

const HYDROLOGY_SHADER_NAME = "aerolithHydrologyWater";

/**
 * 2-8a/2-9 — the inland-water analytic-sky fallback constants, named at the
 * call site. 2-9 deleted both surfaces' fake sun discs (the sun is the
 * shared Karis lobe now); the slightly darker inland overcast palette and
 * softer horizon falloff survive as the deliberate divergence.
 */
const HYDROLOGY_REFLECTED_SKY_PARAMETERS: WaterReflectedSkyParameters = {
  horizonFalloffExponent: 2.3,
  overcastZenithColor: [0.31, 0.36, 0.41],
  overcastHorizonColor: [0.56, 0.61, 0.65],
};

/**
 * Terrain occlusion of the reflected sky.
 *
 * The inland fragment reflected a SKY-ONLY probe in every direction, so a
 * lake in a valley at dusk showed bright horizon sky where a grazing
 * reflection ray actually hits the hillside — a white/blue sheet against
 * brown hills. The terrain's global horizon field (`6-11`) answers "does this
 * direction clear the terrain horizon at this world XZ" for ANY unit
 * direction, so the reflection direction is asked the question the sun is
 * asked elsewhere. Below the horizon the reflection is the hillside, whose
 * mean radiance is the atmosphere's own ground bounce.
 *
 * The soft band is the detail plugin's value restated (a water consumer must
 * not import from detail/); the calibration mirrors AtmosphereSystem's
 * GROUND_BOUNCE_CALIBRATION (`ground = skyHorizon * albedo * 1.15`, R-26).
 * The test pins both against their sources.
 */
export const HYDROLOGY_HORIZON_SOFT_BAND = 0.05;
export const HYDROLOGY_GROUND_BOUNCE_CALIBRATION = 1.15;
/** AtmosphereSystem's default surface albedo luminance, until the renderer forwards the live one. */
export const HYDROLOGY_DEFAULT_GROUND_ALBEDO_LUMINANCE = 0.18;

/** The vec4 the fragment reads as `hydrologyHorizonField`. */
export interface HydrologyHorizonPlacement {
  readonly originX: number;
  readonly originZ: number;
  /** 1 / spanMeters, or 0 — the "no field" sentinel the fragment mixes to fully visible. */
  readonly inverseSpan: number;
  readonly softBand: number;
}

/**
 * Pure: the placement for a horizon field that is (`resident`) or is not
 * bound. Anything that cannot map world to uv — no layers, a zero or
 * non-finite span, a non-finite origin — publishes inverseSpan 0, so the
 * fragment keeps today's behaviour (the parity sentinel) rather than
 * smearing one edge texel across every lake.
 */
export function resolveHydrologyHorizonPlacement(
  resident: boolean,
  originX: number,
  originZ: number,
  spanMeters: number,
): HydrologyHorizonPlacement {
  const valid = resident
    && Number.isFinite(spanMeters) && spanMeters > 0
    && Number.isFinite(originX) && Number.isFinite(originZ);
  return {
    originX: valid ? originX : 0,
    originZ: valid ? originZ : 0,
    inverseSpan: valid ? 1 / spanMeters : 0,
    softBand: HYDROLOGY_HORIZON_SOFT_BAND,
  };
}

/**
 * Pure: the scalar the fragment multiplies `skyHorizon` by for an occluded
 * reflection — the surface albedo's luminance under the atmosphere's own
 * calibration. The multiply by `skyHorizon` stays in the fragment, from the
 * same uniform the analytic sky reads, so the two cannot drift in scale.
 */
export function resolveHydrologyGroundBounce(albedoLuminance: number): number {
  if (!Number.isFinite(albedoLuminance)) {
    throw new RangeError("Hydrology ground-bounce albedo must be finite");
  }
  return Math.min(1, Math.max(0, albedoLuminance)) * HYDROLOGY_GROUND_BOUNCE_CALIBRATION;
}

export const HYDROLOGY_WATER_VERTEX_WGSL = /* wgsl */ `
attribute position: vec3f;
attribute uv: vec2f;
attribute flowData: vec4f;
attribute waterData: vec4f;
// W-8: this lake's or this station's chemistry, baked at mesh build.
attribute waterChemistry: vec4f;
uniform world: mat4x4f;
uniform viewProjection: mat4x4f;
uniform hydrologyWorldOrigin: vec2f;
uniform windDirection: vec2f;
uniform windSpeed: f32;
uniform time: f32;
uniform planarReflectionViewProjection: mat4x4f;
varying worldPosition: vec3f;
varying absoluteWorldXZ: vec2f;
varying surfaceNormal: vec3f;
varying flowDirection: vec2f;
varying flowSpeed: f32;
varying whitewater: f32;
// 6-1: the w lane is the channel sentinel + payload (grade for rivers, the
// sqrt-encoded fetch for lakes). Analytic-mode builders push a literal 0 into
// it and always have, so widening this varying moves no analytic bit: a
// vec3f interpolant already occupies a full location.
varying waterInfo: vec4f;
varying waterUv: vec2f;
varying waterChemistryVarying: vec4f;
varying planarReflectionClip: vec4f;
${SUN_SHADOW_VERTEX_DECLARATIONS_WGSL}

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let baseWorld = uniforms.world * vec4f(vertexInputs.position, 1.0);
  let absoluteXZ = baseWorld.xz + uniforms.hydrologyWorldOrigin;
  let flow = normalize(vertexInputs.flowData.xy + vec2f(0.00001, 0.0));
  let wind = normalize(uniforms.windDirection + vec2f(0.00001, 0.0));
  let shoreAttenuation = 1.0 - vertexInputs.waterData.z * 0.68;
  let flowFrequency = mix(0.16, 0.055, vertexInputs.waterData.y);
  let windFrequency = mix(0.22, 0.095, vertexInputs.waterData.y);
  let flowAmplitude = (0.025 + min(vertexInputs.flowData.z, 5.0) * 0.014) * shoreAttenuation;
  let windAmplitude = (0.018 + min(uniforms.windSpeed, 24.0) * 0.0028)
    * mix(0.48, 1.0, vertexInputs.waterData.y) * shoreAttenuation;
  let flowPhase = dot(absoluteXZ, flow) * flowFrequency
    - uniforms.time * (0.8 + vertexInputs.flowData.z * 1.7);
  let crossPhase = dot(absoluteXZ, vec2f(-flow.y, flow.x)) * flowFrequency * 1.74
    + uniforms.time * 0.63;
  let windPhase = dot(absoluteXZ, wind) * windFrequency
    - uniforms.time * (0.55 + uniforms.windSpeed * 0.075);
  let waveHeight = sin(flowPhase) * flowAmplitude
    + sin(crossPhase) * flowAmplitude * 0.32
    + sin(windPhase) * windAmplitude;
  let gradient = cos(flowPhase) * flowAmplitude * flowFrequency * flow
    + cos(crossPhase) * flowAmplitude * 0.32 * flowFrequency * 1.74
      * vec2f(-flow.y, flow.x)
    + cos(windPhase) * windAmplitude * windFrequency * wind;
  var displacedWorld = baseWorld;
  displacedWorld.y += waveHeight;
  // No Earth-curvature drop: inland water sits on the same flat datum as the
  // terrain it is depth-tested against, for the reason the ocean vertex gives.
  vertexOutputs.position = uniforms.viewProjection * displacedWorld;
  vertexOutputs.worldPosition = displacedWorld.xyz;
  vertexOutputs.absoluteWorldXZ = absoluteXZ;
  vertexOutputs.surfaceNormal = normalize(vec3f(-gradient.x, 1.0, -gradient.y));
  vertexOutputs.flowDirection = flow;
  vertexOutputs.flowSpeed = vertexInputs.flowData.z;
  vertexOutputs.whitewater = vertexInputs.flowData.w;
  vertexOutputs.waterInfo = vertexInputs.waterData;
  vertexOutputs.waterUv = vertexInputs.uv;
  vertexOutputs.waterChemistryVarying = vertexInputs.waterChemistry;
  vertexOutputs.planarReflectionClip = uniforms.planarReflectionViewProjection * displacedWorld;
${sunShadowVertexAssignmentWgsl("displacedWorld")}
}
`;

export const HYDROLOGY_WATER_FRAGMENT_WGSL = /* wgsl */ `
varying worldPosition: vec3f;
varying absoluteWorldXZ: vec2f;
varying surfaceNormal: vec3f;
varying flowDirection: vec2f;
varying flowSpeed: f32;
varying whitewater: f32;
varying waterInfo: vec4f;
varying waterUv: vec2f;
varying waterChemistryVarying: vec4f;
varying planarReflectionClip: vec4f;
uniform cameraPosition: vec3f;
uniform sunDirection: vec3f;
uniform sunColor: vec3f;
uniform sunAngularRadius: f32;
uniform skyZenith: vec3f;
uniform skyHorizon: vec3f;
uniform skylightIlluminanceNormalized: f32;
uniform cloudCoverage: f32;
uniform windDirection: vec2f;
uniform windSpeed: f32;
uniform time: f32;
uniform regionOpacity: f32;
uniform environmentValid: f32;
// W-7: the optical water type — see the ocean fragment's declaration. Inland
// water is where the type varies most (a peat tarn, a glacial lake and a
// silty river are three different spectra), which W-8 supplies per vertex.
uniform waterAbsorption: vec3f;
uniform waterBackscatter: vec3f;
var environmentCubeSampler: sampler; var environmentCube: texture_cube<f32>;
${WATER_BATHYMETRY_DECLARATIONS_WGSL}
// Terrain occlusion of the reflected sky: the terrain's global horizon field
// ('6-11'), world-anchored — two textures and one vec4 (originX, originZ,
// inverseSpan, softBand). inverseSpan 0 is the "no field yet" sentinel: the
// samplers stay bound to a fallback texel and the lookup mixes to fully
// visible. 'groundBounceAlbedo' is the surface albedo's luminance under the
// atmosphere's ground-bounce calibration (see setGroundBounceAlbedo).
uniform hydrologyHorizonField: vec4f;
uniform groundBounceAlbedo: f32;
var hydrologyHorizonASampler: sampler; var hydrologyHorizonA: texture_2d<f32>;
var hydrologyHorizonBSampler: sampler; var hydrologyHorizonB: texture_2d<f32>;

${CLOUD_SHADOW_RECEIVER_WGSL}
${PLANAR_REFLECTION_FRAGMENT_WGSL}
${SUN_SHADOW_FRAGMENT_WGSL}
${AERIAL_PERSPECTIVE_WGSL}

${WATER_SHADING_CONSTANTS_WGSL}

${WATER_FRESNEL_SCHLICK_WGSL}

// 6-4: the depth include comes first so the capillary block can call the
// shared caustic accumulator it defines (WGSL wants declarations before use).
// The ocean fragment composes the same blocks in the same order.
${WATER_DEPTH_OPTICS_WGSL}

// W-8: the constituent model, composed after the depth include for the
// WaterOptics struct it returns. The same text the ocean composes.
${WATER_CONSTITUENT_WGSL}

${WATER_DETAIL_NOISE_WGSL}

// wave S: the far gust octaves, shared with the ocean.
${WATER_FAR_GUST_WGSL}

${WATER_CAPILLARY_DETAIL_WGSL}

// 6-2: the shared run-up model, composed BEFORE the channel block because the
// bank run-up calls into it. One definition, composed verbatim into both water
// fragments (and, from 6-5, into the terrain surface plugin) — the parity test
// pins that.
${WATER_SHORE_RUNUP_WGSL}

// 6-1: inland-only. Every input is channel-graph hydraulics, so the ocean
// composes nothing of this; it reads the shared noise block above rather than
// redefining any lattice.
${WATER_CHANNEL_FLOW_WGSL}

${WATER_SUN_SPECULAR_WGSL}

// wave S: sparkle, twinkle and the rough-interface Fresnel, shared with the ocean.
${WATER_FAR_FIELD_WGSL}

${WATER_FOAM_WGSL}

${WATER_ENVIRONMENT_MIP_WGSL}

${waterReflectedSkyWgsl(HYDROLOGY_REFLECTED_SKY_PARAMETERS)}

// The shared horizon-field operator, composed verbatim (the terrain and the
// detail plugin compose the same text; the horizon-field test pins that no
// consumer restates its azimuth arithmetic).
${HORIZON_FIELD_LOOKUP_WGSL}

// The terminator jitter's world-locked spatial hash — the construction the
// terrain and detail consumers use, so the field's iso-contours land as
// unstructured penumbra rather than stripes. Spatial, not temporal: a
// per-frame jitter would crawl across a still lake.
fn hydrologyHorizonJitter(point: vec2f) -> f32 {
  var value = fract(vec3f(point.x, point.y, point.x) * 0.1031);
  value += dot(value, value.yzx + vec3f(33.33));
  return fract((value.x + value.y) * value.z);
}

// Sky visibility along 'direction' from absolute world 'worldXZ': 1.0 above
// the terrain horizon, 0.0 below it, smoothstepped across the band. Uniform
// control flow and no derivatives — the field's absence is a uniform
// sentinel folded in by a select, never a branch around the sample.
fn hydrologyTerrainVisibility(worldXZ: vec2f, direction: vec3f) -> f32 {
  let field = uniforms.hydrologyHorizonField;
  let uv = (worldXZ - field.xy) * field.z;
  let packedA = textureSampleLevel(hydrologyHorizonA, hydrologyHorizonASampler, uv, 0.0);
  let packedB = textureSampleLevel(hydrologyHorizonB, hydrologyHorizonBSampler, uv, 0.0);
  let visibility = horizonFieldShadow(
    packedA,
    packedB,
    direction,
    field.w,
    hydrologyHorizonJitter(worldXZ * 0.37),
  );
  let resident = select(0.0, 1.0, field.z > 0.0);
  return mix(1.0, visibility, resident);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let light = normalize(uniforms.sunDirection);
  // 5-11 depth, hoisted above the capillary call by 6-4: the caustic beam gates
  // the capillary block's curvature accumulation, so it has to exist first.
  let depth = waterDepthFromBathymetry(input.worldPosition.y, input.absoluteWorldXZ);
  let causticBeam = waterRefractedSunBeam(depth, light.y);
  // Fix-pack W3: the wave gradient is re-evaluated PER FRAGMENT. The vertex
  // normal was interpolated from meshes with almost no interior vertices — a
  // lake is a centre fan — so interior pixels received a near-constant
  // normal and read as glass. The phases reuse the vertex shader's exact
  // formulas at the fragment's own world position; the vertex keeps owning
  // displacement.
  let fragmentFlow = normalize(input.flowDirection + vec2f(0.00001, 0.0));
  let fragmentWind = normalize(uniforms.windDirection + vec2f(0.00001, 0.0));
  let fragmentShoreAttenuation = 1.0 - input.waterInfo.z * 0.68;
  let fragmentFlowFrequency = mix(0.16, 0.055, input.waterInfo.y);
  let fragmentWindFrequency = mix(0.22, 0.095, input.waterInfo.y);
  let fragmentFlowAmplitude = (0.025 + min(input.flowSpeed, 5.0) * 0.014)
    * fragmentShoreAttenuation;
  let fragmentWindAmplitude = (0.018 + min(uniforms.windSpeed, 24.0) * 0.0028)
    * mix(0.48, 1.0, input.waterInfo.y) * fragmentShoreAttenuation;
  let fragmentFlowPhase = dot(input.absoluteWorldXZ, fragmentFlow) * fragmentFlowFrequency
    - uniforms.time * (0.8 + input.flowSpeed * 1.7);
  let fragmentCrossPhase = dot(input.absoluteWorldXZ, vec2f(-fragmentFlow.y, fragmentFlow.x))
    * fragmentFlowFrequency * 1.74 + uniforms.time * 0.63;
  let fragmentWindPhase = dot(input.absoluteWorldXZ, fragmentWind) * fragmentWindFrequency
    - uniforms.time * (0.55 + uniforms.windSpeed * 0.075);
  let fragmentGradient = cos(fragmentFlowPhase) * fragmentFlowAmplitude
      * fragmentFlowFrequency * fragmentFlow
    + cos(fragmentCrossPhase) * fragmentFlowAmplitude * 0.32 * fragmentFlowFrequency * 1.74
      * vec2f(-fragmentFlow.y, fragmentFlow.x)
    + cos(fragmentWindPhase) * fragmentWindAmplitude * fragmentWindFrequency * fragmentWind;
  // Fix-pack W2: the shared capillary band + sub-grid tail (see
  // WATER_CAPILLARY_DETAIL_WGSL) — rivers and lakes were the worst "glass up
  // close" offenders.
  let capillary = waterCapillaryDetail(
    input.absoluteWorldXZ,
    uniforms.windDirection * uniforms.windSpeed,
    uniforms.time,
    // wave R: the resolved wave slope this fragment already carries, so the
    // unresolved tail — and therefore roughness — becomes a field rather than
    // a constant. Rivers and lakes were the worst offenders: their roughness
    // sat exactly on the 0.28 cap everywhere.
    length(fragmentGradient),
    causticBeam,
  );
  // 6-1: the pixel footprint, computed here in UNIFORM control flow. The
  // channel term runs under the sentinel branch and a derivative built-in may
  // not be called from non-uniform flow; these are the same two derivatives
  // waterCapillaryDetail takes internally on the same value, so after inlining
  // the fragment pays for them once either way. The anisotropy limit is wave
  // R fix 1's, verbatim: fade on the axis the 16x sampler resolves.
  let channelDerivativeX = dpdx(input.absoluteWorldXZ);
  let channelDerivativeY = dpdy(input.absoluteWorldXZ);
  let channelFootprintMajor = max(length(channelDerivativeX), length(channelDerivativeY));
  let channelFootprintMinor = min(length(channelDerivativeX), length(channelDerivativeY));
  let channelFootprint = max(
    channelFootprintMinor,
    channelFootprintMajor * ${(1 / 16).toFixed(6)},
  );
  // wave S: inland water gets the ocean's far field. A lake seen from
  // altitude was one flat mirror of the sky — a per-wind constant
  // roughness, Schlick on the resolved normal (≈65% of the sky at grazing
  // incidence), a smooth sun lobe — which is why it read as a bright white
  // sheet in a dusk valley. The far gust lanes modulate the unresolved
  // variance, the rough-interface Fresnel reads that variance, and the sun
  // lobe sparkles at the glint count, all faded in on the minor footprint so
  // the near field is unchanged. The coarse octave is evaluated per pixel
  // here (the ocean carries it as a varying); a lake is a small share of
  // the frame.
  let farGustWeight = smoothstep(
    ${WATER_GLINT_SPARKLE_FOOTPRINT_LOW.toFixed(3)},
    ${WATER_GLINT_SPARKLE_FOOTPRINT_HIGH.toFixed(3)},
    channelFootprint,
  );
  let farWind = uniforms.windDirection * uniforms.windSpeed;
  let farGust = mix(
    1.0,
    waterFarGustGain(
      waterFarGustCoarse(input.absoluteWorldXZ, farWind, uniforms.time),
      input.absoluteWorldXZ,
      farWind,
      uniforms.time,
      channelFootprintMajor,
    ),
    farGustWeight,
  );
  let farFootprintArea = abs(
    channelDerivativeX.x * channelDerivativeY.y - channelDerivativeX.y * channelDerivativeY.x,
  );
  // 6-1: the sentinel. waterInfo.w is exactly 0 on every analytic-mode
  // vertex, so an analytic world executes this compare and nothing inside.
  // Every accumulator below starts as the pre-6-1 value and is only ever
  // ADDED to inside the branch, so no add-of-zero runs on the analytic path.
  var surfaceSlope = capillary.slope;
  var unresolvedSlope = capillary.unresolvedMeanSquareSlope;
  var channelCrest = 0.0;
  var channelCrestWeight = 0.0;
  var channelStandingPhase = 0.0;
  var channelStandingCurvature = 0.0;
  var channelBankRunup = 0.0;
  if (input.waterInfo.w > 0.0) {
    // 6-2: the bank normal, exactly — no derivative needed. A lane's bank is
    // cross-stream on the side its lane coordinate says (uv.y is lane*0.5+0.5,
    // so 0.5 is the thalweg); a lake ring's is radial, and W-5 writes uv as
    // 0.5 + direction*0.5*radial precisely so that direction survives to here.
    let laneSign = select(-1.0, 1.0, input.waterUv.y >= 0.5);
    let bankNormal = select(
      vec2f(-fragmentFlow.y, fragmentFlow.x) * laneSign,
      normalize(input.waterUv - vec2f(0.5) + vec2f(0.00001, 0.0)),
      input.waterInfo.y >= 0.5,
    );
    let channel = waterChannelFlow(
      input.waterInfo.w,
      input.waterInfo.y,
      input.absoluteWorldXZ,
      fragmentFlow,
      input.flowSpeed,
      // W-5 exports uv.x as arcLength / 16 from the reach head: a
      // world-anchored parameter, continuous along a reach and independent of
      // the camera and of the floating origin.
      input.waterUv.x * 16.0,
      input.waterUv.y,
      uniforms.windDirection * uniforms.windSpeed,
      uniforms.time,
      channelFootprint,
      input.waterInfo.z,
      bankNormal,
    );
    surfaceSlope += channel.slope;
    unresolvedSlope += channel.unresolvedMeanSquareSlope;
    channelCrest = channel.crest;
    channelCrestWeight = channel.crestWeight;
    channelStandingPhase = channel.standingPhase;
    channelStandingCurvature = channel.standingCurvature;
    channelBankRunup = channel.bankRunup;
  }
  // 6-4: inland water carries no spectral Jacobian, so its own three phase
  // terms supply the long half of the convergence signal directly. Each is
  // A*sin(k.x): its Laplacian is exactly -A*|k|^2*sin(k.x), the same quantity
  // the ocean recovers from its stored Jacobian, for the cost of three sines
  // inside the depth gate. At the metre-scale amplitudes and 30-110 m
  // wavelengths these carry, their focal depths are kilometres — they are
  // essentially inert today and exist so that 6-1's advected standing waves
  // and 6-2's run-up focus light the moment they raise real curvature.
  var caustic = capillary.caustic;
  if (causticBeam.weight > 0.0) {
    let crossFrequency = fragmentFlowFrequency * 1.74;
    caustic = waterCausticSinusoidBand(
      caustic,
      fragmentFlowPhase,
      fragmentFlowAmplitude * fragmentFlowFrequency * fragmentFlowFrequency,
      causticBeam,
    );
    caustic = waterCausticSinusoidBand(
      caustic,
      fragmentCrossPhase,
      fragmentFlowAmplitude * 0.32 * crossFrequency * crossFrequency,
      causticBeam,
    );
    caustic = waterCausticSinusoidBand(
      caustic,
      fragmentWindPhase,
      fragmentWindAmplitude * fragmentWindFrequency * fragmentWindFrequency,
      causticBeam,
    );
    // 6-1: the standing wave is the first inland term that raises curvature
    // the 6-4 sinusoid band can see — its Laplacian is exactly
    // -a k^2 sin(phase), which is the shape this band takes. Zero, and
    // therefore skipped, everywhere the sentinel is dark.
    if (channelStandingCurvature > 0.0) {
      caustic = waterCausticSinusoidBand(
        caustic,
        channelStandingPhase,
        channelStandingCurvature,
        causticBeam,
      );
    }
  }
  let geometricNormal = normalize(vec3f(
    -fragmentGradient.x + surfaceSlope.x,
    1.0,
    -fragmentGradient.y + surfaceSlope.y,
  ));
  // wave R fix 7: the glint-only jitter, sun lobe alone.
  let glintNormalUp = normalize(vec3f(
    -fragmentGradient.x + surfaceSlope.x + capillary.glintSlope.x,
    1.0,
    -fragmentGradient.y + surfaceSlope.y + capillary.glintSlope.y,
  ));
  let view = normalize(uniforms.cameraPosition - input.worldPosition);
  let cameraBelow = uniforms.cameraPosition.y < input.worldPosition.y;
  let normal = select(geometricNormal, -geometricNormal, cameraBelow);
  let glintNormal = select(glintNormalUp, -glintNormalUp, cameraBelow);
  let nDotV = max(dot(normal, view), 0.001);
  let nDotL = max(dot(normal, light), 0.0);
  let lakeFactor = clamp(input.waterInfo.y, 0.0, 1.0);
  // Fix-pack W1: fold the capillary band's unresolved energy into the GGX
  // lobe in alpha space, the 2-8 discipline — near water keeps micro-facet
  // sparkle instead of collapsing to a mirror.
  // wave R: cap 0.28 -> 0.45 on both clamps. Inland water arrived pinned
  // EXACTLY at 0.28 across every river and lake pixel — the capillary tail
  // alone exceeded the cap — so the variance the fold exists to express had
  // nowhere to go and every surface rendered with one micro-facet
  // distribution. 0.45 keeps inland water glossier than the open sea (0.5)
  // while leaving the field room to move.
  let baseRoughness = clamp(
    mix(0.14, 0.09, lakeFactor) + input.flowSpeed * 0.008 + uniforms.windSpeed * 0.0016,
    0.075,
    0.45,
  );
  let baseAlpha = baseRoughness * baseRoughness;
  let roughness = clamp(
    sqrt(sqrt(baseAlpha * baseAlpha + min(unresolvedSlope * farGust, 0.25))),
    0.075,
    0.45,
  );
  let f0 = vec3f(0.0204);
  // wave S: the mean Fresnel of a ROUGH interface — see WATER_FAR_FIELD_WGSL (4).
  let fresnel = waterRoughInterfaceFresnel(
    normal,
    view,
    cameraBelow,
    sqrt(min(unresolvedSlope * farGust, ${WATER_ROUGH_FRESNEL_MAX_VARIANCE.toFixed(3)})),
  );

  let cloudShadow = sampleCloudShadowReceiver(input.worldPosition);
  let sunShadow = sampleSunShadowReceiver(
    input.sunShadowClip0,
    input.sunShadowClip1,
    input.sunShadowClip2,
    input.sunShadowClip3,
    input.sunShadowViewDepth,
  );
  let directSunVisibility = cloudShadow * sunShadow;
  // 2-9: sky reflections from the shared environment probe (roughness-mapped
  // mips); the analytic mix is the not-yet-valid fallback and no longer
  // paints a fake sun disc — the sun comes solely from the shared Karis lobe.
  let reflectionDirection = reflect(-view, normal);
  let analyticSky = reflectedSky(reflectionDirection);
  let environmentSky = textureSampleLevel(
    environmentCube,
    environmentCubeSampler,
    reflectionDirection,
    environmentRoughnessToMip(roughness),
  ).rgb;
  let unoccludedSky = mix(analyticSky, environmentSky, uniforms.environmentValid);
  // Terrain occlusion of the reflected sky: where the reflection direction
  // dips under the terrain horizon the ray hits the hillside, not the sky,
  // and the hillside's mean radiance is the atmosphere's own ground bounce
  // (skyHorizon * albedo * 1.15). It occludes the SKY term only, BEFORE the
  // planar capture blends real terrain over it where that capture is valid;
  // the sun lobe, the body colour, the foam and the Fresnel are not sky.
  let terrainVisibility = hydrologyTerrainVisibility(input.absoluteWorldXZ, reflectionDirection);
  // W-10 corrected the occluded value to the sky this fragment would have
  // seen, darkened by the ground's albedo, rather than the palette's raw
  // skyHorizon. The two are the same at midday and diverge badly at night,
  // where the palette row is far brighter than the probe: the ocean's own
  // version of this line lit a moonlit bay white before it was corrected, and
  // an inland lake under a ridge had the same defect waiting.
  let skyReflection = mix(
    unoccludedSky * uniforms.groundBounceAlbedo,
    unoccludedSky,
    terrainVisibility,
  );
  let reflection = samplePlanarSceneReflection(
    input.planarReflectionClip,
    normal,
    input.worldPosition.y,
    skyReflection,
  );
  // W-8: this water body's own chemistry, resolved at mesh build from its
  // catchment (a cold high lake carries rock flour, a wet forest one carries
  // peat, a lowland river carries its own bed) and interpolated here. An
  // analytic world with no chemistry baked carries zeros, which is pure water
  // plus the material's fallback type -- the pre-W-8 look.
  let chemistry = input.waterChemistryVarying;
  var optics = waterOpticsFromUniforms();
  if (dot(chemistry, vec4f(1.0)) > 0.0) {
    optics = waterOpticsFromConstituents(
      WaterConstituents(chemistry.x, chemistry.y, chemistry.z, chemistry.w),
    );
  }
  let downwelling = waterDownwelling(light.y, directSunVisibility);
  let transmitted = waterVolumeRadiance(
    input.absoluteWorldXZ,
    input.worldPosition.y,
    depth,
    optics,
    // Inland beds are terrigenous by definition: a lake or a river bed is the
    // catchment's own silt, so it takes the wet end of the range.
    0.75,
    downwelling,
    light,
    normal,
    view,
    cameraBelow,
    caustic,
    causticBeam,
  );
  var color = transmitted * (vec3f(1.0) - fresnel) + reflection * fresnel;
  // 2-9: the shared solid-angle sun lobe — the sun's angular radius replaced
  // the old gain-of-four multiply.
  // wave S: the lobe is the MEAN of a Poisson count of sun-aiming facets;
  // past the range where glints stop resolving, a mean-one twinkle at the
  // count's own variance turns the smooth sheet back into glitter.
  // W-11: the same glint cell the ocean uses. Inland water had the screen
  // hash too, and a lake is the worst place for it: the camera hangs still
  // over a small body of water, and a pattern welded to the screen over a
  // surface that is not moving is the purest form of the artefact.
  let glintCell = waterGlintCell(
    input.absoluteWorldXZ - farWind * uniforms.time * ${WATER_GLINT_DRIFT_FRACTION.toFixed(3)},
    farFootprintArea,
    channelFootprintMinor,
    ${(WATER_GLINT_FACET_LENGTH_METERS ** 2).toExponential(4)},
    3,
  );
  let glintHalfVector = normalize(view + light);
  let glintExpectedCount = waterGlintExpectedCount(
    max(dot(glintNormal, glintHalfVector), 0.0),
    roughness * roughness,
    uniforms.sunAngularRadius,
    glintCell.area,
  );
  let sparkle = mix(
    1.0,
    waterGlintTwinkle(glintExpectedCount, glintCell.cell, uniforms.time, ${WATER_GLINT_TWINKLE_HZ.toFixed(3)}, 1),
    farGustWeight,
  );
  color += sunSpecular(glintNormal, view, light, roughness, uniforms.sunAngularRadius, f0)
    * uniforms.sunColor * directSunVisibility * sparkle;

  let flowCrest = pow(max(
    sin(dot(input.absoluteWorldXZ, input.flowDirection) * 0.13
      - uniforms.time * (1.0 + input.flowSpeed * 1.8)),
    0.0,
  ), 9.0);
  let shorePattern = 0.58 + 0.42 * sin(
    dot(input.absoluteWorldXZ, vec2f(-input.flowDirection.y, input.flowDirection.x)) * 0.19
      + uniforms.time * 0.8,
  );
  // W-9: the bank ring is now GATED BY ENERGY. It used to be unconditional,
  // so every lake and every reach wore a white collar in dead calm — one of
  // the two things Jason meant by "always white foam". Lapping needs
  // something to lap: on a lake the fetch-limited chop the wind can raise
  // (waterLakeChop's own height, via the sqrt-encoded fetch payload), on a
  // river the boil of its own current. Both go to zero smoothly, so a
  // sheltered tarn at dawn has a clean edge and a windy shore still breaks.
  // The lane's own payload, decoded exactly as waterChannelFlow decodes it
  // (sentinel base removed, clamped): the sqrt-encoded fetch on a lake ring,
  // the normalised grade on a river lane. An analytic world carries 0, which
  // reads as no fetch, so its lakes fall back to the flow-speed term.
  let channelField = clamp(input.waterInfo.w - ${1}.0, 0.0, 1.0);
  let lakeChop = waterLakeChop(uniforms.windSpeed, channelField);
  let bankEnergy = clamp(max(
    smoothstep(0.02, 0.14, lakeChop.significantHeightMeters) * lakeFactor,
    smoothstep(0.35, 1.4, input.flowSpeed),
  ), 0.0, 1.0);
  var shoreFoam = smoothstep(0.76, 1.0, input.waterInfo.z) * shorePattern * 0.3 * bankEnergy;
  // 6-2: on W-5's banks the shore lapping generalises into a real run-up — a
  // swash front that beats at its own driver's period (the boil train on a
  // lane, the fetch-limited chop on a lake shore) and streaks along the bank
  // NORMAL rather than downwind. It is exactly 0 under the analytic sentinel,
  // so this branch never runs in an analytic world and the ramp above keeps
  // every bit it had (6-1's accumulator discipline, verbatim).
  if (channelBankRunup > 0.0) {
    shoreFoam = max(shoreFoam, channelBankRunup);
  }
  // 6-1: where the exported grade stands a wave train up against the Stokes
  // limit, the crest the foam rides stops travelling. The breakup mask below
  // stays advected on purpose — on a real standing wave the foam streams
  // THROUGH a crest that does not move.
  var rapidCrest = flowCrest;
  if (channelCrestWeight > 0.0) {
    rapidCrest = mix(flowCrest, channelCrest, channelCrestWeight);
  }
  let rapidFoam = clamp(input.whitewater * (0.4 + rapidCrest * 0.85), 0.0, 1.0);
  // 2-9: lit foam, advected with the flow so rapids' foam actually travels.
  let foamMask = foamBreakup(
    input.absoluteWorldXZ,
    input.flowDirection * (uniforms.time * (0.5 + input.flowSpeed * 0.6)),
  );
  let foam = clamp(shoreFoam + rapidFoam, 0.0, 1.0) * mix(0.4, 1.0, foamMask);
  // W-9: inland foam is breaking foam — a rapid's boil or a bank's swash —
  // so it carries the thick-fresh-foam reflectance rather than the open sea's
  // effective whitecap value, and it is lit by the shared downwelling
  // irradiance like every other Lambertian surface on the water.
  let foamColor = litFoamColor(
    vec3f(${(0.5 * 0.96).toFixed(3)}, ${(0.5).toFixed(3)}, ${(0.5 * 0.98).toFixed(3)}),
    normal,
    light,
    downwelling,
  );
  color = mix(color, foamColor, foam);
  if (cameraBelow) {
    color = applyUnderwaterBeerLambert(
      color,
      distance(uniforms.cameraPosition, input.worldPosition),
      optics,
      downwelling,
    );
  }
  // 1C-4: rivers and lakes fade on the same shared curve as the terrain
  // around them — inland water no longer punches through the haze.
  color = applyAerialPerspective(
    color,
    input.worldPosition.y,
    distance(uniforms.cameraPosition, input.worldPosition),
    -view,
  );
  let alpha = max(waterShorelineAlpha(depth), foam);
  fragmentOutputs.color = vec4f(
    max(color, vec3f(0.0)),
    alpha * clamp(uniforms.regionOpacity, 0.0, 1.0),
  );
}
`;

function registerHydrologyShaders(): void {
  ShaderStore.ShadersStoreWGSL[`${HYDROLOGY_SHADER_NAME}VertexShader`] = HYDROLOGY_WATER_VERTEX_WGSL;
  ShaderStore.ShadersStoreWGSL[`${HYDROLOGY_SHADER_NAME}PixelShader`] = HYDROLOGY_WATER_FRAGMENT_WGSL;
}

interface MeshBuildResult {
  readonly mesh: Mesh | null;
  readonly vertexCount: number;
  readonly triangleCount: number;
}

function buildMesh(
  scene: Scene,
  name: string,
  append: (arrays: MeshArrays) => void,
): MeshBuildResult {
  const arrays = emptyMeshArrays();
  append(arrays);
  if (arrays.positions.length === 0 || arrays.indices.length === 0) {
    return { mesh: null, vertexCount: 0, triangleCount: 0 };
  }
  const mesh = new Mesh(name, scene);
  const vertexData = new VertexData();
  vertexData.positions = arrays.positions;
  vertexData.normals = arrays.normals;
  vertexData.uvs = arrays.uvs;
  vertexData.indices = arrays.indices;
  vertexData.applyToMesh(mesh, false);
  mesh.setVerticesData("flowData", arrays.flowData, false, 4);
  mesh.setVerticesData("waterData", arrays.waterData, false, 4);
  mesh.setVerticesData("waterChemistry", arrays.waterChemistry, false, 4);
  mesh.isPickable = false;
  mesh.receiveShadows = true;
  mesh.renderingGroupId = WATER_RENDERING_GROUP_ID;
  mesh.alphaIndex = 1;
  return {
    mesh,
    vertexCount: arrays.positions.length / 3,
    triangleCount: arrays.indices.length / 3,
  };
}

/**
 * Static hydrology exported from the canonical terrain-evolution graph. A
 * complete generation result can preserve producer diagnostics; the compact
 * geometry form is promoted to a result without consulting analytic terrain.
 */
export type HydrologyGraphSource = HydrologyGenerationResult | ChannelHydrologyGeometry;

export interface HydrologySystemOptions extends HydrologyGenerationOptions {
  readonly atmosphere: AtmosphereSnapshot;
  /** Shared terrain-depth substrate used by both inland and ocean materials. */
  readonly bathymetry?: BathymetryClipmap;
  /** Prevailing flow direction (towards), clockwise from world north. */
  readonly windDirectionRadians?: number;
  /**
   * wave R fix 8: the prevailing wind SPEED, from the same world definition
   * that supplies `windDirectionRadians`. Inland water used to take its
   * direction from the world and its speed from the atmosphere snapshot,
   * whose `windSpeed` is a cloud-layer number that can differ by 3x — so the
   * ripple amplitude, the drift and the roughness were driven by a wind the
   * direction had never agreed to. Falls back to the atmosphere snapshot when
   * absent, which keeps every pre-wave-R caller and test behaving as before.
   */
  readonly windSpeedMetersPerSecond?: number;
  /** Enables off-main-thread generation from the deterministic built-in world. */
  readonly workerWorldSeed?: WorldSeed;
  /**
   * `W-8`: the climate at an inland water surface, for its chemistry. Absent
   * (every test fixture, every analytic harness) means the neutral temperate
   * province, which is what the pre-W-8 single water type was.
   */
  readonly climateSample?: HydrologyClimateSampler;
  readonly paging?: HydrologyPagingOptions;
  /** Analytic-mode test/custom-world injection point. HydrologySystem assumes ownership. */
  readonly generationClient?: HydrologyGenerationClientLike;
  /**
   * Canonical, already-eroded river/lake geometry. When present this is a
   * static world data source: no legacy downhill tracing, worker construction,
   * or regional paging is performed.
   */
  readonly graphHydrology?: HydrologyGraphSource;
}

export interface HydrologySystemStatistics {
  readonly riverCount: number;
  readonly lakeCount: number;
  readonly terrainSampleCount: number;
  readonly totalRiverLengthMeters: number;
  readonly totalLakeAreaSquareMeters: number;
  readonly meshCount: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly activeRegionKey: string | null;
  readonly activeRegionCenterX: number | null;
  readonly activeRegionCenterZ: number | null;
  readonly residentRegionCount: number;
  readonly generationPending: boolean;
  readonly queuedGenerationCount: number;
  readonly pagingRequestCount: number;
  readonly regionSwapCount: number;
  readonly failedGenerationCount: number;
  readonly discardedGenerationCount: number;
  readonly lastGenerationMilliseconds: number;
  readonly usingMainThreadFallback: boolean;
  readonly lastGenerationUsedWorker: boolean;
  readonly currentRegionOpacity: number;
  readonly previousRegionOpacity: number;
  readonly disposed: boolean;
}

interface HydrologyRegionRuntime {
  readonly selection: HydrologyRegionSelection;
  readonly hydrology: HydrologyGenerationResult;
  readonly root: TransformNode;
  readonly riverMesh: Mesh | null;
  readonly lakeMesh: Mesh | null;
  readonly meshCount: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
  opacity: number;
}

function setRegionOpacity(region: HydrologyRegionRuntime, opacity: number): void {
  region.opacity = clamp(opacity, 0, 1);
  // The explicit shader uniform performs the fade. Visibility only avoids an
  // otherwise depth-writing fully transparent draw at the exact endpoint.
  const submitted = region.opacity > 0 ? 1 : 0;
  if (region.riverMesh) region.riverMesh.visibility = submitted;
  if (region.lakeMesh) region.lakeMesh.visibility = submitted;
}

function disposeRegion(region: HydrologyRegionRuntime): void {
  region.riverMesh?.dispose(false, false);
  region.lakeMesh?.dispose(false, false);
  region.root.dispose(false, false);
}

function generationTimeoutError(milliseconds: number): Error {
  return new Error(`Hydrology region generation timed out after ${milliseconds} ms`);
}

function isHydrologyGenerationResult(
  source: HydrologyGraphSource,
): source is HydrologyGenerationResult {
  return "config" in source && "bounds" in source && "statistics" in source;
}

function resultFromGraphHydrology(
  source: HydrologyGraphSource,
  config: HydrologyGenerationConfig,
): HydrologyGenerationResult {
  if (isHydrologyGenerationResult(source)) return source;
  const riverPointCount = source.rivers.reduce(
    (sum, river) => sum + river.points.length,
    0,
  );
  const halfExtent = config.extentMeters * 0.5;
  return Object.freeze({
    config,
    bounds: Object.freeze({
      minX: config.centerX - halfExtent,
      maxX: config.centerX + halfExtent,
      minZ: config.centerZ - halfExtent,
      maxZ: config.centerZ + halfExtent,
    }),
    rivers: source.rivers,
    lakes: source.lakes,
    statistics: Object.freeze({
      terrainSampleCount: 0,
      haloSourceCellCount: 0,
      maximumDirectionalTraceSamples: 0,
      candidateSourceCount: 0,
      tracedSourceCount: 0,
      riverCount: source.rivers.length,
      lakeCount: source.lakes.length,
      rawRiverPointCount: riverPointCount,
      splinePointCount: riverPointCount,
      totalRiverLengthMeters: source.rivers.reduce(
        (sum, river) => sum + river.lengthMeters,
        0,
      ),
      totalLakeAreaSquareMeters: source.lakes.reduce(
        (sum, lake) => sum + lake.areaSquareMeters,
        0,
      ),
    }),
  });
}

/**
 * Rivers and lakes for the eroded world, with explicit analytic parity mode.
 * Canonical graph geometry remains resident without a generation client;
 * analytic geometry retains the legacy worker paging path. Geometry stays in
 * absolute CPU coordinates while resident roots follow floating-origin rebases.
 */
export class HydrologySystem implements PlanarReflectionReceiver {
  private readonly material: ShaderMaterial;
  private readonly scene: Scene;
  private readonly generationConfig: HydrologyGenerationConfig;
  /** `W-8`: the climate sampler the mesh builders bake chemistry from. */
  private readonly climateSample: HydrologyClimateSampler;
  private readonly pagingConfig: HydrologyPagingConfig;
  private readonly generationClient: HydrologyGenerationClientLike | null;
  private readonly graphMode: boolean;
  /** Ground heights for the contained lake plate; null only in graph mode. */
  private readonly analyticGroundSample: ((x: number, z: number) => number) | null;
  private readonly cloudShadowCenterLocal = Vector2.Zero();
  private readonly cloudShadowSunDirection = Vector3.Up();
  private currentRegion: HydrologyRegionRuntime | null = null;
  private previousRegion: HydrologyRegionRuntime | null = null;
  private cloudShadowProjection: CloudShadowProjection | null = null;
  private sunShadowBinding: SunShadowReceiverBinding | null = null;
  private planarReflectionBinding: PlanarReflectionBinding | null = null;
  private pendingRegionKey: string | null = null;
  private pendingRequestId = -1;
  private requestGeneration = 0;
  private transitionStartSeconds = 0;
  private lastTimeSeconds = 0;
  private pagingRequestCount = 0;
  private regionSwapCount = 0;
  private failedGenerationCount = 0;
  private discardedGenerationCount = 0;
  private lastGenerationMilliseconds = 0;
  private lastGenerationUsedWorker = false;
  private originX = 0;
  private originZ = 0;
  private disposed = false;
  private readonly bathymetry: BathymetryClipmap | null;
  /** wave R fix 8: null when no world wind was supplied (see the option). */
  private worldWindSpeedMetersPerSecond: number | null = null;

  constructor(
    scene: Scene,
    private readonly camera: Camera,
    options: HydrologySystemOptions,
    initializeSynchronously = true,
  ) {
    registerHydrologyShaders();
    configureDepthAwareWaterRendering(scene);
    const {
      atmosphere,
      bathymetry,
      windDirectionRadians,
      windSpeedMetersPerSecond,
      workerWorldSeed,
      paging,
      generationClient,
      graphHydrology,
      ...generationOptions
    } = options;
    this.bathymetry = bathymetry ?? null;
    this.scene = scene;
    this.climateSample = options.climateSample ?? (() => HYDROLOGY_NEUTRAL_CLIMATE);
    const resolvedGenerationConfig = resolveHydrologyConfig(generationOptions);
    this.generationConfig = graphHydrology !== undefined
      && isHydrologyGenerationResult(graphHydrology)
      ? graphHydrology.config
      : resolvedGenerationConfig;
    this.graphMode = graphHydrology !== undefined;
    this.pagingConfig = resolveHydrologyPagingConfig(
      this.generationConfig.centerX,
      this.generationConfig.centerZ,
      this.generationConfig.extentMeters,
      paging,
    );
    this.generationClient = this.graphMode
      ? null
      : generationClient ?? new HydrologyGenerationClient({
        worldSeed: generationOptions.worldSeed,
        terrainSample: generationOptions.terrainSample,
        ...(workerWorldSeed === undefined ? {} : { workerWorldSeed }),
      });
    this.analyticGroundSample = this.graphMode
      ? null
      : (x, z) => generationOptions.terrainSample(x, z).height;
    this.material = new ShaderMaterial(
      "hydrology-water-material",
      scene,
      HYDROLOGY_SHADER_NAME,
      {
        attributes: ["position", "uv", "flowData", "waterData", "waterChemistry"],
        uniforms: [
          "world",
          "viewProjection",
          "hydrologyWorldOrigin",
          "cameraPosition",
          "sunDirection",
          "sunColor",
          "sunAngularRadius",
          "skyZenith",
          "skyHorizon",
          "skylightIlluminanceNormalized",
          "cloudCoverage",
          "windDirection",
          "windSpeed",
          "time",
          "regionOpacity",
          "environmentValid",
          "waterAbsorption",
          "waterBackscatter",
          "hydrologyHorizonField",
          "groundBounceAlbedo",
          "bathymetryNearPlacement",
          "bathymetryFarPlacement",
          "bathymetrySeaLevel",
          ...CLOUD_SHADOW_RECEIVER_UNIFORMS,
          ...PLANAR_REFLECTION_UNIFORMS,
          ...SUN_SHADOW_UNIFORMS,
          ...AERIAL_PERSPECTIVE_UNIFORMS,
        ],
        samplers: [
          CLOUD_SHADOW_RECEIVER_SAMPLER,
          PLANAR_REFLECTION_SAMPLER,
          SUN_SHADOW_SAMPLER,
          "environmentCube",
          "bathymetryNear",
          "bathymetryFar",
          "hydrologyHorizonA",
          "hydrologyHorizonB",
        ],
        needAlphaBlending: true,
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );
    this.material.backFaceCulling = false;
    this.material.transparencyMode = Material.MATERIAL_ALPHABLEND;
    this.material.alphaMode = Constants.ALPHA_COMBINE;
    this.material.disableDepthWrite = true;
    this.material.setVector2("hydrologyWorldOrigin", Vector2.Zero());
    const windRadians = windDirectionRadians ?? 1;
    this.material.setVector2(
      "windDirection",
      new Vector2(Math.sin(windRadians), Math.cos(windRadians)).normalize(),
    );
    // wave R fix 8: one wind owner — see HydrologySystemOptions.
    this.worldWindSpeedMetersPerSecond = windSpeedMetersPerSecond ?? null;
    this.material.setFloat("time", 0);
    this.material.setFloat("regionOpacity", 1);
    this.material.setMatrix("planarReflectionViewProjection", Matrix.Identity());
    this.material.setFloat("planarReflectionPlaneHeight", this.generationConfig.seaLevel);
    this.material.setFloat("planarReflectionStrength", 0);
    this.material.setFloat("planarReflectionValid", 0);
    this.material.setFloat("planarReflectionReceiverEnabled", 0);
    // 2-9: bound from construction (an unbound declared sampler keeps the
    // WebGPU material un-ready forever); the renderer upgrades it to the
    // sky probe once that exists.
    const fallbackCube = fallbackWaterEnvironmentCube(scene);
    if (fallbackCube) this.material.setTexture("environmentCube", fallbackCube);
    this.material.setFloat("environmentValid", 0);
    // Terrain occlusion of the reflected sky: bound from construction for the
    // cube's reason (an unbound declared sampler keeps the material un-ready
    // forever). The renderer forwards the real field once the first horizon
    // bake lands; until then inverseSpan 0 reads as fully visible.
    this.setHorizonField(null, null, 0, 0, 0);
    // W-7: the optical water type. One type per material until W-8 supplies
    // the per-region field; bound from construction because a body colour is
    // not optional.
    this.setWaterOpticalType(WATER_REFERENCE_OPTICAL_TYPE);
    this.setGroundBounceAlbedo(HYDROLOGY_DEFAULT_GROUND_ALBEDO_LUMINANCE);
    this.bathymetry?.bind(this.material);
    // 2-10: the planar capture is retired; the receiver sampler stays bound
    // to a zero-confidence texel until 5-12 re-points a lake capture.
    this.material.setTexture(
      PLANAR_REFLECTION_SAMPLER,
      fallbackWaterPlanarTexture(scene),
    );
    this.setAtmosphere(atmosphere);

    if (graphHydrology !== undefined) {
      const hydrology = resultFromGraphHydrology(graphHydrology, this.generationConfig);
      this.currentRegion = this.buildRegion(this.initialSelection(), hydrology);
    } else if (initializeSynchronously) {
      const hydrology = generateHydrology(generationOptions);
      this.currentRegion = this.buildRegion(this.initialSelection(), hydrology);
    }
  }

  static async create(
    scene: Scene,
    camera: Camera,
    options: HydrologySystemOptions,
    signal?: AbortSignal,
  ): Promise<HydrologySystem> {
    const system = new HydrologySystem(scene, camera, options, false);
    try {
      if (!system.graphMode) {
        await system.requestRegion(system.initialSelection(), signal);
      }
      return system;
    } catch (error) {
      system.dispose();
      throw error;
    }
  }

  get hydrology(): HydrologyGenerationResult {
    const hydrology = this.currentRegion?.hydrology;
    if (!hydrology) throw new Error("Hydrology has not finished its initial generation");
    return hydrology;
  }

  get riverMesh(): Mesh | null {
    return this.currentRegion?.riverMesh ?? null;
  }

  get lakeMesh(): Mesh | null {
    return this.currentRegion?.lakeMesh ?? null;
  }

  /** Only the fully installed current region may drive the shared lake plane. */
  get reflectionLakes(): readonly HydrologyLake[] {
    return this.currentRegion?.hydrology.lakes ?? [];
  }

  setFloatingOrigin(worldX: number, worldZ: number): void {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) {
      throw new RangeError("Hydrology floating origin must be finite");
    }
    this.originX = worldX;
    this.originZ = worldZ;
    for (const region of [this.previousRegion, this.currentRegion]) {
      region?.root.position.set(-worldX, 0, -worldZ);
    }
    this.material.setVector2("hydrologyWorldOrigin", new Vector2(worldX, worldZ));
    this.applyCloudShadowProjection();
  }

  setCloudShadow(projection: CloudShadowProjection): void {
    this.cloudShadowProjection = projection;
    this.applyCloudShadowProjection();
  }

  setSunShadows(shadows: CascadedShadowGenerator): void {
    this.sunShadowBinding?.dispose();
    this.sunShadowBinding = bindSunShadowReceiver(this.material, this.camera, shadows);
  }

  setPlanarReflection(binding: PlanarReflectionBinding | null): void {
    this.planarReflectionBinding = binding;
    if (!binding) {
      this.material.setFloat("planarReflectionValid", 0);
      this.material.setFloat("planarReflectionReceiverEnabled", 0);
      const fallbackPlanar = fallbackWaterPlanarTexture(this.scene);
      if (fallbackPlanar) this.material.setTexture(PLANAR_REFLECTION_SAMPLER, fallbackPlanar);
      return;
    }
    this.material.setTexture(PLANAR_REFLECTION_SAMPLER, binding.texture);
    this.material.setMatrix("planarReflectionViewProjection", binding.viewProjection);
    this.material.setFloat("planarReflectionPlaneHeight", binding.planeHeight);
    this.material.setFloat("planarReflectionStrength", binding.strength);
    this.material.setFloat("planarReflectionValid", binding.valid ? 1 : 0);
  }

  /** Per-frame haze binding, resolved once by the renderer for all consumers. */
  setAerialPerspective(binding: AerialPerspectiveBinding): void {
    applyAerialPerspectiveToShaderMaterial(
      this.material,
      binding,
      (name, x, y, z) => this.material.setVector3(name, new Vector3(x, y, z)),
      (name, x, y, z, w) => this.material.setVector4(name, new Vector4(x, y, z, w)),
    );
  }

  /**
   * `W-7`: inland water's optical type — the fallback every region starts
   * from. `W-8` gives each lake and reach its own chemistry per vertex; this
   * uniform remains what an analytic world (no channel graph) renders with.
   */
  setWaterOpticalType(type: WaterOpticalType): void {
    applyWaterOpticalType(this.material, type);
  }

  setAtmosphere(atmosphere: AtmosphereSnapshot): void {
    this.material.setVector3("sunDirection", atmosphere.sunDirection);
    this.material.setColor3(
      "sunColor",
      atmosphere.sunColor.scale(atmosphere.sunIlluminanceNormalized),
    );
    this.material.setFloat("sunAngularRadius", atmosphere.sunAngularRadiusRadians);
    this.material.setColor3("skyZenith", atmosphere.skyZenith);
    this.material.setColor3("skyHorizon", atmosphere.skyHorizon);
    this.material.setFloat(
      "skylightIlluminanceNormalized",
      atmosphere.skylightIlluminanceNormalized,
    );
    this.material.setFloat("cloudCoverage", atmosphere.cloudCoverage);
    this.material.setFloat(
      "windSpeed",
      this.worldWindSpeedMetersPerSecond ?? atmosphere.windSpeed,
    );
  }

  /**
   * 2-9: environment reflections from the shared sky probe (1C-6). Pass null
   * to fall back to the analytic zenith/horizon sky.
   */
  setEnvironmentReflection(texture: BaseTexture | null): void {
    if (!texture) {
      const fallbackCube = fallbackWaterEnvironmentCube(this.scene);
      if (fallbackCube) this.material.setTexture("environmentCube", fallbackCube);
      this.material.setFloat("environmentValid", 0);
      return;
    }
    this.material.setTexture("environmentCube", texture);
    this.material.setFloat("environmentValid", 1);
  }

  /**
   * Terrain occlusion of the reflected sky: the terrain's global horizon
   * field (`6-11`), on the detail plugin's signature so FlightRenderer
   * forwards the one snapshot to both consumers on the same frame. Null
   * layers (no bake yet, a non-WebGPU engine) rebind the fallback texel and
   * publish inverseSpan 0, which the fragment reads as fully visible — the
   * parity sentinel. `spanMeters` is the field's full world extent; the
   * fragment maps absolute world XZ to uv with one subtract and one multiply.
   */
  setHorizonField(
    layerA: BaseTexture | null,
    layerB: BaseTexture | null,
    originX: number,
    originZ: number,
    spanMeters: number,
  ): void {
    const placement = resolveHydrologyHorizonPlacement(
      layerA !== null && layerB !== null,
      originX,
      originZ,
      spanMeters,
    );
    if (placement.inverseSpan > 0 && layerA && layerB) {
      this.material.setTexture("hydrologyHorizonA", layerA);
      this.material.setTexture("hydrologyHorizonB", layerB);
    } else {
      const fallback = fallbackWaterPlanarTexture(this.scene);
      this.material.setTexture("hydrologyHorizonA", fallback);
      this.material.setTexture("hydrologyHorizonB", fallback);
    }
    this.material.setVector4("hydrologyHorizonField", new Vector4(
      placement.originX,
      placement.originZ,
      placement.inverseSpan,
      placement.softBand,
    ));
  }

  /**
   * The ground bounce an occluded reflection shows: AtmosphereSystem's own
   * `skyHorizon * surfaceAlbedo * 1.15` (R-26), with the albedo's luminance
   * forwarded here because the snapshot does not carry it. Forwarded where
   * the renderer publishes the albedo, i.e. with the atmosphere.
   */
  setGroundBounceAlbedo(albedoLuminance: number): void {
    this.material.setFloat("groundBounceAlbedo", resolveHydrologyGroundBounce(albedoLuminance));
  }

  update(
    timeSeconds: number,
    cameraLocalPosition: Vector3 = this.camera.position,
    observer?: HydrologyPagingObserver,
  ): void {
    if (!Number.isFinite(timeSeconds)) throw new RangeError("Hydrology time must be finite");
    if (this.disposed) return;
    this.lastTimeSeconds = timeSeconds;
    this.material.setFloat("time", timeSeconds);
    this.material.setVector3("cameraPosition", cameraLocalPosition);
    this.bathymetry?.bind(this.material);
    this.updateTransition(timeSeconds);
    // Graph geometry describes the canonical eroded world, not a crop of an
    // analytic field. It remains resident and must never enter legacy paging.
    if (this.graphMode) return;
    const generationClient = this.generationClient;
    if (!generationClient) return;
    const resolvedObserver: HydrologyPagingObserver = observer ?? {
      x: cameraLocalPosition.x + this.originX,
      z: cameraLocalPosition.z + this.originZ,
      velocityX: 0,
      velocityZ: 0,
    };
    const selection = selectHydrologyRegion(resolvedObserver, this.pagingConfig);
    if (selection.key === this.currentRegion?.selection.key) {
      if (this.pendingRegionKey && this.pendingRegionKey !== selection.key) {
        generationClient.cancel(this.pendingRequestId);
      }
      return;
    }
    if (selection.key === this.pendingRegionKey) return;
    if (this.pendingRegionKey) generationClient.cancel(this.pendingRequestId);
    void this.requestRegion(selection).catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") return;
      console.warn(`Unable to page hydrology region ${selection.key}`, error);
    });
  }

  getStatistics(): HydrologySystemStatistics {
    const generated = this.currentRegion?.hydrology.statistics;
    const regions = [this.previousRegion, this.currentRegion].filter(
      (region): region is HydrologyRegionRuntime => region !== null,
    );
    return Object.freeze({
      riverCount: generated?.riverCount ?? 0,
      lakeCount: generated?.lakeCount ?? 0,
      terrainSampleCount: generated?.terrainSampleCount ?? 0,
      totalRiverLengthMeters: generated?.totalRiverLengthMeters ?? 0,
      totalLakeAreaSquareMeters: generated?.totalLakeAreaSquareMeters ?? 0,
      meshCount: regions.reduce((sum, region) => sum + region.meshCount, 0),
      vertexCount: regions.reduce((sum, region) => sum + region.vertexCount, 0),
      triangleCount: regions.reduce((sum, region) => sum + region.triangleCount, 0),
      activeRegionKey: this.currentRegion?.selection.key ?? null,
      activeRegionCenterX: this.currentRegion?.selection.centerX ?? null,
      activeRegionCenterZ: this.currentRegion?.selection.centerZ ?? null,
      residentRegionCount: regions.length,
      generationPending: this.pendingRegionKey !== null,
      queuedGenerationCount: this.generationClient?.queuedCount ?? 0,
      pagingRequestCount: this.pagingRequestCount,
      regionSwapCount: this.regionSwapCount,
      failedGenerationCount: this.failedGenerationCount,
      discardedGenerationCount: this.discardedGenerationCount,
      lastGenerationMilliseconds: this.lastGenerationMilliseconds,
      usingMainThreadFallback: this.generationClient?.isUsingFallback ?? false,
      lastGenerationUsedWorker: this.lastGenerationUsedWorker,
      currentRegionOpacity: this.currentRegion?.opacity ?? 0,
      previousRegionOpacity: this.previousRegion?.opacity ?? 0,
      disposed: this.disposed,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generationClient?.dispose();
    if (this.previousRegion) disposeRegion(this.previousRegion);
    if (this.currentRegion) disposeRegion(this.currentRegion);
    this.previousRegion = null;
    this.currentRegion = null;
    this.pendingRegionKey = null;
    this.pendingRequestId = -1;
    this.sunShadowBinding?.dispose();
    this.sunShadowBinding = null;
    // The cloud transmittance texture is owned by VolumetricCloudSystem.
    this.material.dispose(true, false);
  }

  private initialSelection(): HydrologyRegionSelection {
    return selectHydrologyRegion({
      x: this.pagingConfig.anchorX,
      z: this.pagingConfig.anchorZ,
      velocityX: 0,
      velocityZ: 0,
    }, this.pagingConfig);
  }

  private buildRegion(
    selection: HydrologyRegionSelection,
    hydrology: HydrologyGenerationResult,
  ): HydrologyRegionRuntime {
    const suffix = selection.key.replaceAll(":", "_");
    const root = new TransformNode(`hydrology-region-${suffix}`, this.scene);
    root.position.set(-this.originX, 0, -this.originZ);
    try {
      // W-5: canonical graph geometry gets the arc-length/ear-clip builders;
      // the analytic path keeps appendRiver byte-identical (Gate W), while
      // the analytic LAKE builder was replaced under a sanctioned rebaseline
      // (2026-09-02, Gate W closed and eroded shelved): the legacy fan drew
      // water over any ground above the surface inside its polygon — the
      // measured "blue slash through the terrain" defect. See
      // appendContainedLake and the amendment note on the pinned-hash test
      // in tests/render.webgpu-hydrology.test.ts.
      const riverBuild = buildMesh(this.scene, `hydrology-rivers-${suffix}`, (arrays) => {
        hydrology.rivers.forEach((river) => (
          this.graphMode
            ? appendGraphRiver(arrays, river, this.climateSample, this.generationConfig.seaLevel)
            : appendRiver(arrays, river, this.climateSample, this.generationConfig.seaLevel)
        ));
      });
      const lakeBuild = buildMesh(this.scene, `hydrology-lakes-${suffix}`, (arrays) => {
        hydrology.lakes.forEach((lake) => (
          this.graphMode
            ? appendGraphLake(arrays, lake, this.climateSample, this.generationConfig.seaLevel)
            : appendContainedLake(
              arrays,
              lake,
              this.analyticGroundSample!,
              this.climateSample,
              this.generationConfig.seaLevel,
            )
        ));
      });
      const region: HydrologyRegionRuntime = {
        selection,
        hydrology,
        root,
        riverMesh: riverBuild.mesh,
        lakeMesh: lakeBuild.mesh,
        meshCount: Number(riverBuild.mesh !== null) + Number(lakeBuild.mesh !== null),
        vertexCount: riverBuild.vertexCount + lakeBuild.vertexCount,
        triangleCount: riverBuild.triangleCount + lakeBuild.triangleCount,
        opacity: 1,
      };
      for (const mesh of [region.riverMesh, region.lakeMesh]) {
        if (!mesh) continue;
        mesh.parent = root;
        mesh.material = this.material;
        mesh.metadata = {
          ...(mesh.metadata as Record<string, unknown> | null),
          waterSurface: true,
          excludePlanarReflection: true,
        };
        mesh.onBeforeBindObservable.add(() => {
          this.material.setFloat("regionOpacity", region.opacity);
          // Rivers always retain analytic Fresnel. During paging crossfades,
          // the retired region also retains it even if lake elevations match.
          const binding = this.planarReflectionBinding;
          const selectedCurrentLake = binding !== null && acceptsInlandPlanarReflection({
            source: binding.source,
            planeHeight: binding.planeHeight,
            isLakeMesh: mesh === region.lakeMesh,
            isCurrentRegion: region === this.currentRegion,
            lakes: region.hydrology.lakes,
          });
          this.material.setFloat(
            "planarReflectionReceiverEnabled",
            selectedCurrentLake ? 1 : 0,
          );
        });
      }
      return region;
    } catch (error) {
      root.dispose(false, false);
      throw error;
    }
  }

  private installRegion(
    selection: HydrologyRegionSelection,
    result: HydrologyRegionGenerationResult,
  ): void {
    const next = this.buildRegion(selection, result.hydrology);
    if (this.previousRegion) disposeRegion(this.previousRegion);
    this.previousRegion = this.currentRegion;
    this.currentRegion = next;
    this.lastGenerationMilliseconds = result.elapsedMilliseconds;
    this.lastGenerationUsedWorker = result.workerGenerated;
    if (this.previousRegion) {
      setRegionOpacity(this.previousRegion, 1);
      setRegionOpacity(next, 0);
      this.transitionStartSeconds = this.lastTimeSeconds;
      this.regionSwapCount += 1;
    } else {
      setRegionOpacity(next, 1);
    }
  }

  private updateTransition(timeSeconds: number): void {
    if (!this.previousRegion || !this.currentRegion) return;
    const duration = this.pagingConfig.transitionSeconds;
    const progress = duration <= 0
      ? 1
      : clamp((timeSeconds - this.transitionStartSeconds) / duration, 0, 1);
    // Keep one complete water layer throughout the handoff. Complementary
    // alpha fades make identical high-alpha water dip at the midpoint (or lose
    // one layer to equal-depth rejection); this two-phase overlap cannot open
    // a transparency hole while unique features still fade in and out.
    if (progress <= 0.5) {
      setRegionOpacity(this.previousRegion, 1);
      setRegionOpacity(this.currentRegion, progress * 2);
    } else {
      setRegionOpacity(this.previousRegion, (1 - progress) * 2);
      setRegionOpacity(this.currentRegion, 1);
    }
    if (progress < 1) return;
    disposeRegion(this.previousRegion);
    this.previousRegion = null;
    setRegionOpacity(this.currentRegion, 1);
  }

  private requestRegion(
    selection: HydrologyRegionSelection,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Hydrology system is disposed"));
    if (this.graphMode) return Promise.resolve();
    const generationClient = this.generationClient;
    if (!generationClient) return Promise.resolve();
    const generation = ++this.requestGeneration;
    this.pagingRequestCount += 1;
    this.pendingRegionKey = selection.key;
    const timeoutMilliseconds = this.pagingConfig.generationTimeoutMilliseconds;
    let timedOut = false;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        timedOut = true;
        generationClient.cancel(this.pendingRequestId);
      }, timeoutMilliseconds);
      const clearPending = (): void => {
        clearTimeout(timeout);
        if (generation !== this.requestGeneration) return;
        this.pendingRegionKey = null;
        this.pendingRequestId = -1;
      };
      this.pendingRequestId = generationClient.request(
        {
          key: selection.key,
          generation,
          // Data only: the resolved config also holds this system's sampler
          // functions, which cannot be posted to the worker (see
          // `hydrologyGenerationConfigData`).
          options: {
            ...hydrologyGenerationConfigData(this.generationConfig),
            centerX: selection.centerX,
            centerZ: selection.centerZ,
          },
          ...(signal ? { signal } : {}),
        },
        (result) => {
          clearPending();
          if (this.disposed || generation !== this.requestGeneration) {
            this.discardedGenerationCount += 1;
            resolve();
            return;
          }
          try {
            this.installRegion(selection, result);
            resolve();
          } catch (error) {
            this.failedGenerationCount += 1;
            reject(error);
          }
        },
        (error) => {
          clearPending();
          if (error.name !== "AbortError") this.failedGenerationCount += 1;
          reject(timedOut ? generationTimeoutError(timeoutMilliseconds) : error);
        },
      );
    });
  }

  private applyCloudShadowProjection(): void {
    const projection = this.cloudShadowProjection;
    if (!projection) return;
    const binding = resolveCloudShadowReceiverBinding(
      projection,
      this.originX,
      this.originZ,
    );
    this.cloudShadowCenterLocal.set(binding.centerLocalX, binding.centerLocalZ);
    this.cloudShadowSunDirection.set(
      binding.sunDirectionX,
      binding.sunDirectionY,
      binding.sunDirectionZ,
    );
    this.material.setTexture(CLOUD_SHADOW_RECEIVER_SAMPLER, projection.texture);
    this.material.setVector2("cloudShadowCenterLocal", this.cloudShadowCenterLocal);
    this.material.setFloat("cloudShadowWorldSize", binding.worldSizeMeters);
    this.material.setFloat(
      "cloudShadowReferenceAltitude",
      binding.referenceAltitudeMeters,
    );
    this.material.setVector3("cloudShadowSunDirection", this.cloudShadowSunDirection);
    this.material.setFloat("cloudShadowReceiverValid", binding.valid ? 1 : 0);
    this.material.setFloat("cloudShadowStrength", binding.strength);
  }
}

export {
  // The tracer/generator stay public while explicit analytic parity mode is
  // supported. Graph-backed eroded worlds do not call either API.
  generateHydrology,
  traceDownhillPath,
  resolveHydrologyConfig,
} from "./HydrologyGeneration";
export type {
  DownhillTrace,
  DownhillTraceOptions,
  HydrologyGenerationConfig,
  HydrologyGenerationResult,
  HydrologyLake,
  HydrologyRiver,
  HydrologyTerrainSample,
  HydrologyTerrainSampler,
} from "./HydrologyGeneration";
