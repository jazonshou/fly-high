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
import {
  generateHydrology,
  type HydrologyGenerationOptions,
  type HydrologyGenerationResult,
  type HydrologyGenerationConfig,
  type HydrologyLake,
  type HydrologyRiver,
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
  WATER_FRESNEL_SCHLICK_WGSL,
  WATER_SHADING_CONSTANTS_WGSL,
  WATER_SHORE_RUNUP_WGSL,
  WATER_SUN_SPECULAR_WGSL,
  WATER_RENDERING_GROUP_ID,
  waterChannelGradePayload,
  waterLakeEffectiveFetchMeters,
  waterLakeFetchPayload,
  waterReflectedSkyWgsl,
  type WaterReflectedSkyParameters,
} from "./WaterShaders";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { BathymetryClipmap } from "./BathymetryClipmap";
import type { ChannelHydrologyGeometry } from "./ChannelNetwork";
import {
  distanceToRingMeters,
  earClipRing,
  refineTriangulation,
} from "./lakeShoreline";
import { resampleHydrologyRiverStations } from "./riverResample";

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

export const HYDROLOGY_WATER_VERTEX_WGSL = /* wgsl */ `
attribute position: vec3f;
attribute uv: vec2f;
attribute flowData: vec4f;
attribute waterData: vec4f;
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
  displacedWorld.y -= dot(baseWorld.xz, baseWorld.xz) / (2.0 * 6371000.0);
  vertexOutputs.position = uniforms.viewProjection * displacedWorld;
  vertexOutputs.worldPosition = displacedWorld.xyz;
  vertexOutputs.absoluteWorldXZ = absoluteXZ;
  vertexOutputs.surfaceNormal = normalize(vec3f(-gradient.x, 1.0, -gradient.y));
  vertexOutputs.flowDirection = flow;
  vertexOutputs.flowSpeed = vertexInputs.flowData.z;
  vertexOutputs.whitewater = vertexInputs.flowData.w;
  vertexOutputs.waterInfo = vertexInputs.waterData;
  vertexOutputs.waterUv = vertexInputs.uv;
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
varying planarReflectionClip: vec4f;
uniform cameraPosition: vec3f;
uniform sunDirection: vec3f;
uniform sunColor: vec3f;
uniform sunAngularRadius: f32;
uniform skyZenith: vec3f;
uniform skyHorizon: vec3f;
uniform sunIlluminanceNormalized: f32;
uniform skylightIlluminanceNormalized: f32;
uniform cloudCoverage: f32;
uniform windDirection: vec2f;
uniform windSpeed: f32;
uniform time: f32;
uniform regionOpacity: f32;
uniform environmentValid: f32;
var environmentCubeSampler: sampler; var environmentCube: texture_cube<f32>;
${WATER_BATHYMETRY_DECLARATIONS_WGSL}

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

${WATER_DETAIL_NOISE_WGSL}

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

${WATER_FOAM_WGSL}

${WATER_ENVIRONMENT_MIP_WGSL}

${waterReflectedSkyWgsl(HYDROLOGY_REFLECTED_SKY_PARAMETERS)}

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
    sqrt(sqrt(baseAlpha * baseAlpha + min(unresolvedSlope, 0.25))),
    0.075,
    0.45,
  );
  let f0 = vec3f(0.0204);
  let fresnel = waterInterfaceFresnel(normal, view, cameraBelow);

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
  let skyReflection = mix(analyticSky, environmentSky, uniforms.environmentValid);
  let reflection = samplePlanarSceneReflection(
    input.planarReflectionClip,
    normal,
    input.worldPosition.y,
    skyReflection,
  );
  let diffuseIlluminanceNormalized = max(
    uniforms.sunIlluminanceNormalized,
    uniforms.skylightIlluminanceNormalized,
  );
  let transmitted = waterVolumeRadiance(
    input.absoluteWorldXZ,
    input.worldPosition.y,
    depth,
    diffuseIlluminanceNormalized,
    normal,
    view,
    cameraBelow,
    directSunVisibility,
    caustic,
    causticBeam,
  );
  var color = transmitted * (vec3f(1.0) - fresnel) + reflection * fresnel;
  // 2-9: the shared solid-angle sun lobe — the sun's angular radius replaced
  // the old gain-of-four multiply.
  color += sunSpecular(glintNormal, view, light, roughness, uniforms.sunAngularRadius, f0)
    * uniforms.sunColor * directSunVisibility;

  let flowCrest = pow(max(
    sin(dot(input.absoluteWorldXZ, input.flowDirection) * 0.13
      - uniforms.time * (1.0 + input.flowSpeed * 1.8)),
    0.0,
  ), 9.0);
  let shorePattern = 0.58 + 0.42 * sin(
    dot(input.absoluteWorldXZ, vec2f(-input.flowDirection.y, input.flowDirection.x)) * 0.19
      + uniforms.time * 0.8,
  );
  var shoreFoam = smoothstep(0.76, 1.0, input.waterInfo.z) * shorePattern * 0.3;
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
  let foamColor = litFoamColor(
    vec3f(0.78, 0.84, 0.82),
    normal,
    light,
    uniforms.sunColor,
    uniforms.skyZenith,
    uniforms.skyHorizon,
    uniforms.skylightIlluminanceNormalized,
    directSunVisibility,
  );
  color = mix(color, foamColor, foam);
  if (cameraBelow) {
    color = applyUnderwaterBeerLambert(
      color,
      distance(uniforms.cameraPosition, input.worldPosition),
      directSunVisibility,
      diffuseIlluminanceNormalized,
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

/**
 * The interleaved CPU attribute arrays a water mesh is uploaded from. Exported
 * only so `W-1e`'s committed benchmark and the graph byte pin can build the
 * exact production arrays without a Babylon device; nothing outside those
 * harnesses may construct meshes from it.
 */
export interface HydrologyMeshArrays {
  readonly positions: number[];
  readonly normals: number[];
  readonly uvs: number[];
  readonly indices: number[];
  readonly flowData: number[];
  readonly waterData: number[];
}

type MeshArrays = HydrologyMeshArrays;

function emptyMeshArrays(): MeshArrays {
  return {
    positions: [],
    normals: [],
    uvs: [],
    indices: [],
    flowData: [],
    waterData: [],
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizedDirection(dx: number, dz: number): readonly [number, number] {
  const length = Math.hypot(dx, dz);
  return length > 1e-6 ? [dx / length, dz / length] : [0, 1];
}

function appendRiver(arrays: MeshArrays, river: HydrologyRiver): void {
  if (river.points.length < 2) return;
  const baseVertex = arrays.positions.length / 3;
  let distanceAlong = 0;
  for (let index = 0; index < river.points.length; index += 1) {
    const point = river.points[index];
    const previous = river.points[Math.max(0, index - 1)];
    const next = river.points[Math.min(river.points.length - 1, index + 1)];
    if (!point || !previous || !next) continue;
    if (index > 0) distanceAlong += Math.hypot(point.x - previous.x, point.z - previous.z);
    const flow = normalizedDirection(next.x - previous.x, next.z - previous.z);
    const rightX = flow[1];
    const rightZ = -flow[0];
    const halfWidth = point.widthMeters * 0.5;
    const localDrop = Math.max(previous.y - next.y, 0);
    const localDistance = Math.max(Math.hypot(next.x - previous.x, next.z - previous.z), 1);
    const grade = localDrop / localDistance;
    const whitewater = clamp(
      (point.flowSpeedMetersPerSecond - 1.5) * 0.24 + grade * 14,
      0,
      1,
    );
    // `5-12`: five lanes give the conservative cover enough transverse
    // resolution for bathymetry-driven per-pixel shoreline trim. Hydraulic
    // depth is exported by the graph and sampled from the bed; this mesh no
    // longer invents it from ribbon width.
    for (const lane of [-1, -0.5, 0, 0.5, 1] as const) {
      const shore = Math.abs(lane);
      arrays.positions.push(
        point.x + rightX * halfWidth * lane,
        point.y,
        point.z + rightZ * halfWidth * lane,
      );
      arrays.normals.push(0, 1, 0);
      arrays.uvs.push(distanceAlong / 16, lane * 0.5 + 0.5);
      arrays.flowData.push(flow[0], flow[1], point.flowSpeedMetersPerSecond, whitewater);
      arrays.waterData.push(0, 0, shore, 0);
    }
  }
  for (let index = 0; index < river.points.length - 1; index += 1) {
    const row = baseVertex + index * 5;
    const nextRow = row + 5;
    for (let lane = 0; lane < 4; lane += 1) {
      const a = row + lane;
      const b = nextRow + lane;
      const c = a + 1;
      const d = b + 1;
      arrays.indices.push(a, b, c, c, b, d);
    }
  }
}

/**
 * The waterline-contained analytic lake plate — the fix for the in-flight
 * "blue blotches over the green terrain… hard geometric shapes that go
 * through the terrain" report (Jason, 2026-09-02), which
 * scripts/hydrology-piercing-probe.mts measured (all five generated lakes
 * pierced by ground, 1.1% of lake area, worst 10.1 m — two instruments
 * converged on (20520, −14630) ±2 m; a coarse first grid read 8.34 m)
 * and the lake-island-piercing capture sited against.
 *
 * The legacy builder was a 32-segment fan from the basin centre at
 * `surfaceHeight`: nothing sampled the interior, so any ground above the
 * surface inside the polygon drew water straight over it — the analytic
 * twin of the recorded W-5 dropped-island residual (lakeShoreline.ts
 * computes island rings and its export contract drops them). Here the
 * plate is the CELL FILL of the submergence field s = surfaceHeight −
 * ground on a per-lake fine grid clipped to the ownership polygon:
 * fully-wet cells emit quads, mixed cells clip at the interpolated zero
 * crossing (saddle cells disambiguate on the centre average,
 * `marchingSquaresIsoRings`' rule), dry cells emit nothing. Islands are
 * holes BY CONSTRUCTION and every mesh edge is a waterline.
 *
 * Attribute semantics reproduce the fan's FIELDS rather than its
 * geometry: uv is the radial map the fan interpolated (0.5 + dir·0.5·r/R),
 * flowData is the legacy constant lane, and waterData carries
 * [max(0.08, s), 1, 1 − clamp(s / maxDepth, 0, 1), 0] — per-vertex REAL
 * depth instead of the centre-only maximum, the same shore gradient the
 * fan produced for a bowl, and the analytic `waterData.w = 0` sentinel
 * unchanged.
 *
 * The grid step scales with radius (≤ ~57×57 nodes, floor 4 m), capping
 * the one-time ground sampling at ~3.3k calls per lake — sub-frame work
 * at region page-in, and no lake generates within ~11 km of any
 * baselined capture vantage.
 */
const LAKE_CONTAINMENT_MAX_NODES_PER_AXIS = 57;
const LAKE_CONTAINMENT_STEP_FLOOR_METERS = 4;
const LAKE_CONTAINMENT_CROSSING_CLAMP = 1e-3;

export function appendContainedLake(
  arrays: MeshArrays,
  lake: HydrologyLake,
  ground: (x: number, z: number) => number,
): void {
  if (lake.boundary.length < 3) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of lake.boundary) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  const span = Math.max(maxX - minX, maxZ - minZ);
  if (!(span > 0)) return;
  const step = Math.max(
    LAKE_CONTAINMENT_STEP_FLOOR_METERS,
    span / (LAKE_CONTAINMENT_MAX_NODES_PER_AXIS - 1),
  );
  // One dry padding node on every side so the fill can never reach the
  // grid rim (the same closed-contour guarantee marchingSquaresIsoRings
  // asks of its callers).
  const width = Math.ceil((maxX - minX) / step) + 3;
  const height = Math.ceil((maxZ - minZ) / step) + 3;
  const originX = minX - step;
  const originZ = minZ - step;
  const inside = (px: number, pz: number): boolean => {
    let odd = false;
    const ring = lake.boundary;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!;
      const b = ring[j]!;
      if ((a.z > pz) !== (b.z > pz)
        && px < ((b.x - a.x) * (pz - a.z)) / (b.z - a.z) + a.x) odd = !odd;
    }
    return odd;
  };
  // Submergence at each node; forced dry outside the ownership polygon so
  // this lake cannot flood terrain another basin owns.
  const submergence = new Float32Array(width * height);
  for (let iz = 0; iz < height; iz += 1) {
    for (let ix = 0; ix < width; ix += 1) {
      const x = originX + ix * step;
      const z = originZ + iz * step;
      submergence[iz * width + ix] = (ix === 0 || iz === 0 || ix === width - 1
        || iz === height - 1 || !inside(x, z))
        ? -1
        : lake.surfaceHeight - ground(x, z);
    }
  }
  const vertexIndex = new Map<number, number>();
  const invRadius = 1 / Math.max(lake.radiusMeters, 1e-6);
  const invMaxDepth = 1 / Math.max(lake.maximumDepthMeters, 1e-6);
  const emitVertex = (key: number, x: number, z: number, depth: number): number => {
    const existing = vertexIndex.get(key);
    if (existing !== undefined) return existing;
    const index = arrays.positions.length / 3;
    const dx = x - lake.centerX;
    const dz = z - lake.centerZ;
    const radial = Math.hypot(dx, dz);
    const scale = radial > 1e-6 ? Math.min(1, radial * invRadius) / radial : 0;
    arrays.positions.push(x, lake.surfaceHeight, z);
    arrays.normals.push(0, 1, 0);
    arrays.uvs.push(0.5 + dx * scale * 0.5, 0.5 + dz * scale * 0.5);
    arrays.flowData.push(lake.flowDirection[0], lake.flowDirection[1], 0.18, 0);
    arrays.waterData.push(
      Math.max(0.08, depth),
      1,
      1 - clamp(depth * invMaxDepth, 0, 1),
      0,
    );
    vertexIndex.set(key, index);
    return index;
  };
  // Vertex keys are quantized world offsets (1/16 m lattice), so a corner
  // shared between any mix of base cells and subdivided cells — and a
  // crossing reached from either direction — resolves to one vertex.
  // Adjacent cells at different subdivision levels leave T-junctions, but
  // every vertex sits at the one surface height, so the mesh is coplanar
  // and a T-junction cannot open a visible gap.
  const vertexKey = (x: number, z: number): number =>
    Math.round((x - originX) * 16) * 2_097_152 + Math.round((z - originZ) * 16);
  // Cached point sampler for sub-grid corners (base nodes pre-fill it).
  const sampleCache = new Map<number, number>();
  const sampleSubmergence = (x: number, z: number): number => {
    const key = vertexKey(x, z);
    const cached = sampleCache.get(key);
    if (cached !== undefined) return cached;
    const value = inside(x, z) ? lake.surfaceHeight - ground(x, z) : -1;
    sampleCache.set(key, value);
    return value;
  };
  for (let iz = 0; iz < height; iz += 1) {
    for (let ix = 0; ix < width; ix += 1) {
      sampleCache.set(
        vertexKey(originX + ix * step, originZ + iz * step),
        submergence[iz * width + ix]!,
      );
    }
  }
  const cornerVertex = (x: number, z: number, s: number): number =>
    emitVertex(vertexKey(x, z), x, z, s);
  const crossingVertex = (
    xA: number, zA: number, sA: number, xB: number, zB: number, sB: number,
  ): number => {
    // Canonicalize on the lower-keyed endpoint so both walk directions
    // resolve the same edge to one vertex.
    if (vertexKey(xB, zB) < vertexKey(xA, zA)) {
      [xA, xB] = [xB, xA];
      [zA, zB] = [zB, zA];
      [sA, sB] = [sB, sA];
    }
    const denominator = sA - sB;
    const t = clamp(
      Math.abs(denominator) > 1e-9 ? sA / denominator : 0.5,
      LAKE_CONTAINMENT_CROSSING_CLAMP,
      1 - LAKE_CONTAINMENT_CROSSING_CLAMP,
    );
    const x = xA + (xB - xA) * t;
    const z = zA + (zB - zA) * t;
    return emitVertex(vertexKey(x, z), x, z, 0);
  };
  const fanOut = (polygon: readonly number[]): void => {
    for (let i = 1; i + 1 < polygon.length; i += 1) {
      arrays.indices.push(polygon[0]!, polygon[i + 1]!, polygon[i]!);
    }
  };
  // A cell subdivides while it straddles the waterline or spans steep
  // ground, down to ~1 m cells: the leaf size bounds how much sub-cell
  // terrain can stand above drawn water (the legacy fan's unbounded
  // version of that error measured 10.1 m, converged).
  const LEAF_STEP_METERS = 1.25;
  const SUBDIVIDE_SPREAD_METERS = 0.75;
  const processCell = (
    x0: number, z0: number, cellStep: number,
    s00: number, s10: number, s11: number, s01: number,
  ): void => {
    const wet = [s00 >= 0, s10 >= 0, s11 >= 0, s01 >= 0] as const;
    const wetCount = Number(wet[0]) + Number(wet[1]) + Number(wet[2]) + Number(wet[3]);
    const minS = Math.min(s00, s10, s11, s01);
    const maxS = Math.max(s00, s10, s11, s01);
    if (wetCount === 0 && maxS < -SUBDIVIDE_SPREAD_METERS) return;
    // Refine only where the waterline can pass through the cell: corner
    // submergence within one spread band of zero. Deep interior stays at
    // the base step — its residual is zero by definition, water over water.
    if (cellStep > LEAF_STEP_METERS
      && minS < SUBDIVIDE_SPREAD_METERS
      && maxS > -SUBDIVIDE_SPREAD_METERS) {
      const half = cellStep / 2;
      const xm = x0 + half;
      const zm = z0 + half;
      const x1 = x0 + cellStep;
      const z1 = z0 + cellStep;
      const sTop = sampleSubmergence(xm, z0);
      const sLeft = sampleSubmergence(x0, zm);
      const sRight = sampleSubmergence(x1, zm);
      const sBottom = sampleSubmergence(xm, z1);
      const sCentre = sampleSubmergence(xm, zm);
      processCell(x0, z0, half, s00, sTop, sCentre, sLeft);
      processCell(xm, z0, half, sTop, s10, sRight, sCentre);
      processCell(xm, zm, half, sCentre, sRight, s11, sBottom);
      processCell(x0, zm, half, sLeft, sCentre, sBottom, s01);
      return;
    }
    if (wetCount === 0) return;
    const x1 = x0 + cellStep;
    const z1 = z0 + cellStep;
    // Corners in edge-walk order.
    const cx = [x0, x1, x1, x0] as const;
    const cz = [z0, z0, z1, z1] as const;
    const cs = [s00, s10, s11, s01] as const;
    if (wetCount === 4) {
      fanOut([
        cornerVertex(cx[0], cz[0], cs[0]),
        cornerVertex(cx[1], cz[1], cs[1]),
        cornerVertex(cx[2], cz[2], cs[2]),
        cornerVertex(cx[3], cz[3], cs[3]),
      ]);
      return;
    }
    // Saddle with a dry centre splits into two opposite corner triangles;
    // every other mixed cell is one simple polygon walked in edge order.
    const saddle = wetCount === 2 && wet[0] === wet[2] && wet[1] === wet[3];
    if (saddle && (s00 + s10 + s11 + s01) * 0.25 < 0) {
      for (let c = 0; c < 4; c += 1) {
        if (!wet[c]) continue;
        const p = (c + 3) % 4;
        const n = (c + 1) % 4;
        fanOut([
          crossingVertex(cx[c]!, cz[c]!, cs[c]!, cx[p]!, cz[p]!, cs[p]!),
          cornerVertex(cx[c]!, cz[c]!, cs[c]!),
          crossingVertex(cx[c]!, cz[c]!, cs[c]!, cx[n]!, cz[n]!, cs[n]!),
        ]);
      }
      return;
    }
    const polygon: number[] = [];
    for (let c = 0; c < 4; c += 1) {
      const n = (c + 1) % 4;
      if (wet[c]) polygon.push(cornerVertex(cx[c]!, cz[c]!, cs[c]!));
      if (wet[c] !== wet[n]) {
        polygon.push(crossingVertex(cx[c]!, cz[c]!, cs[c]!, cx[n]!, cz[n]!, cs[n]!));
      }
    }
    if (polygon.length >= 3) fanOut(polygon);
  };
  for (let iz = 0; iz + 1 < height; iz += 1) {
    for (let ix = 0; ix + 1 < width; ix += 1) {
      processCell(
        originX + ix * step,
        originZ + iz * step,
        step,
        submergence[iz * width + ix]!,
        submergence[iz * width + ix + 1]!,
        submergence[(iz + 1) * width + ix + 1]!,
        submergence[(iz + 1) * width + ix]!,
      );
    }
  }
}

/**
 * W-5 (C-5) — graph-mode river lanes on arc-length stations.
 *
 * Replaces the raw 512 m "ribbons": stations subdivide the exported reach
 * at a width-scaled spacing (see riverResample.ts), Frenet tangents come
 * from central differences over the stations, and whitewater grade is
 * recomputed from the stations. Lane layout, uv and flowData/waterData
 * semantics are the 5-12 contract unchanged: five lanes at
 * [-1,-0.5,0,0.5,1] x halfWidth, uv.x = arcLength / 16 (a world-anchored
 * arc-length parameter — 6-1's advection keys phase off it), uv.y the lane
 * coordinate, waterData.z = |lane| shore proximity. Analytic worlds keep
 * `appendRiver` byte-identical (Gate W non-regression).
 */
function appendGraphRiver(arrays: MeshArrays, river: HydrologyRiver): void {
  const stations = resampleHydrologyRiverStations(river.points);
  if (stations.length < 2) return;
  const baseVertex = arrays.positions.length / 3;
  for (const station of stations) {
    const rightX = station.tangentZ;
    const rightZ = -station.tangentX;
    const halfWidth = station.widthMeters * 0.5;
    // 6-1: the channel sentinel + grade payload. Analytic `appendRiver` keeps
    // pushing a literal 0 here, which is what makes the whole advection term
    // dark in analytic worlds.
    const channelPayload = waterChannelGradePayload(station.grade);
    for (const lane of [-1, -0.5, 0, 0.5, 1] as const) {
      const shore = Math.abs(lane);
      arrays.positions.push(
        station.x + rightX * halfWidth * lane,
        station.y,
        station.z + rightZ * halfWidth * lane,
      );
      arrays.normals.push(0, 1, 0);
      arrays.uvs.push(station.arcLengthMeters / 16, lane * 0.5 + 0.5);
      arrays.flowData.push(
        station.tangentX,
        station.tangentZ,
        station.flowSpeedMetersPerSecond,
        station.whitewater,
      );
      arrays.waterData.push(0, 0, shore, channelPayload);
    }
  }
  for (let index = 0; index < stations.length - 1; index += 1) {
    const row = baseVertex + index * 5;
    const nextRow = row + 5;
    for (let lane = 0; lane < 4; lane += 1) {
      const a = row + lane;
      const b = nextRow + lane;
      const c = a + 1;
      const d = b + 1;
      arrays.indices.push(a, b, c, c, b, d);
    }
  }
}

/** Shore proximity decays to zero this far inside a lake (capped by radius). */
const GRAPH_LAKE_SHORE_BAND_MAXIMUM_METERS = 250;
/**
 * Interior refinement never splits below this edge length. With the 250 m
 * shore band this renders the foam gradient over the last ~24% of a
 * floor-length edge (~120 m) — deliberately of the same order as the ocean's
 * wide shore band; per-pixel shoreline detail is the bathymetry's job
 * (5-12), not this attribute lattice's.
 */
const GRAPH_LAKE_INTERIOR_EDGE_FLOOR_METERS = 512;
/**
 * Interior edges may grow with distance to the shoreline: an edge is split
 * while longer than max(floor, grading x min(endpoint shore distances)) and
 * its triangle is above target area. Shore-adjacent triangles refine to the
 * floor (the waterData gradient resolution); open-water triangles coarsen
 * geometrically, so a lake's triangle count scales with its shoreline
 * length rather than its area. Sizing evidence (seed 333438, ~34,000 km² of
 * retained lakes): a flat 250 m limit produced 8.4M triangles; this graded
 * scheme lands at ~540k for the same worlds.
 */
const GRAPH_LAKE_INTERIOR_EDGE_GRADING = 1;

/**
 * W-5 (C-5) — graph-mode lake interiors.
 *
 * Replaces the centre fan: the marching-squares/Douglas-Peucker shoreline
 * ring is ear-clipped (correct coverage of concave shorelines) and midpoint-
 * refined so interior vertices exist to carry the waterData shore-proximity
 * gradient (boundary z = 1, interior toward 0 over the shore band) that the
 * fan expressed with its single centre vertex. Every vertex sits exactly at
 * `surfaceHeight` — the adapter copies `spillElevationMeters` into it, and
 * the planar-reflection matcher pairs plane heights within 0.05 m, so no
 * averaging is permitted anywhere on this path. Fragment shading still
 * re-derives wave gradients per fragment (fix-pack W3); these vertices are
 * for attribute interpolation and displacement, not normals.
 */
function appendGraphLake(arrays: MeshArrays, lake: HydrologyLake): void {
  const ringCount = lake.boundary.length;
  if (ringCount < 3) return;
  const ringXZ = new Array<number>(ringCount * 2);
  for (let index = 0; index < ringCount; index += 1) {
    const point = lake.boundary[index]!;
    ringXZ[index * 2] = point.x;
    ringXZ[index * 2 + 1] = point.z;
  }
  const earTriangles = earClipRing(ringXZ);
  if (earTriangles.length === 0) return;
  const shoreBand = clamp(lake.radiusMeters, 1, GRAPH_LAKE_SHORE_BAND_MAXIMUM_METERS);
  const positionsXZ = [...ringXZ];
  // W-1e: the shore-distance memo is a typed pair rather than a sparse
  // `number[]` whose entries were written out of order past its initial
  // length (which drops a JS array into dictionary mode). Ring vertices keep
  // their pinned 0; interior vertices are still computed exactly once.
  let shoreDistances = new Float64Array(Math.max(ringCount * 2, 16));
  let shoreReady = new Uint8Array(shoreDistances.length);
  shoreReady.fill(1, 0, ringCount);
  const shoreDistanceAt = (index: number): number => {
    if (index >= shoreReady.length) {
      let capacity = shoreReady.length;
      while (capacity <= index) capacity *= 2;
      const grownDistances = new Float64Array(capacity);
      grownDistances.set(shoreDistances);
      shoreDistances = grownDistances;
      const grownReady = new Uint8Array(capacity);
      grownReady.set(shoreReady);
      shoreReady = grownReady;
    }
    if (shoreReady[index] === 1) return shoreDistances[index]!;
    const distance = distanceToRingMeters(
      positionsXZ[index * 2]!,
      positionsXZ[index * 2 + 1]!,
      ringXZ,
    );
    shoreDistances[index] = distance;
    shoreReady[index] = 1;
    return distance;
  };
  const triangles = refineTriangulation(
    positionsXZ,
    earTriangles,
    (a, b) => Math.max(
      GRAPH_LAKE_INTERIOR_EDGE_FLOOR_METERS,
      GRAPH_LAKE_INTERIOR_EDGE_GRADING * Math.min(shoreDistanceAt(a), shoreDistanceAt(b)),
    ),
  );
  const baseVertex = arrays.positions.length / 3;
  const vertexCount = positionsXZ.length / 2;
  const maximumDepth = Math.max(lake.maximumDepthMeters, 0.08);
  // 6-1: the lake's own span is the fetch ceiling. `radiusMeters` is the
  // exported max centre-to-ring distance, so 2x it is the long chord; the
  // per-vertex nearest-shore distance (already memoised for the shore
  // gradient, so this costs no new ring walk) shortens it near a bank.
  const lakeSpanMeters = lake.radiusMeters * 2;
  for (let index = 0; index < vertexCount; index += 1) {
    const x = positionsXZ[index * 2]!;
    const z = positionsXZ[index * 2 + 1]!;
    const shoreDistance = index < ringCount ? 0 : shoreDistanceAt(index);
    const shore = index < ringCount
      ? 1
      : clamp(1 - shoreDistance / shoreBand, 0, 1);
    const channelPayload = waterLakeFetchPayload(
      waterLakeEffectiveFetchMeters(shoreDistance, lakeSpanMeters),
    );
    arrays.positions.push(x, lake.surfaceHeight, z);
    arrays.normals.push(0, 1, 0);
    // W-1e: one radius per vertex feeds both the normalized direction and the
    // radial factor — `normalizedDirection` computed the same `Math.hypot`
    // the radial term computed again, and allocated a tuple to return it.
    const offsetX = x - lake.centerX;
    const offsetZ = z - lake.centerZ;
    const offsetLength = Math.hypot(offsetX, offsetZ);
    const directionX = offsetLength > 1e-6 ? offsetX / offsetLength : 0;
    const directionZ = offsetLength > 1e-6 ? offsetZ / offsetLength : 1;
    const radial = clamp(offsetLength / Math.max(lake.radiusMeters, 1e-6), 0, 1);
    arrays.uvs.push(0.5 + directionX * 0.5 * radial, 0.5 + directionZ * 0.5 * radial);
    arrays.flowData.push(lake.flowDirection[0], lake.flowDirection[1], 0.18, 0);
    arrays.waterData.push(
      0.08 + (maximumDepth - 0.08) * (1 - shore),
      1,
      shore,
      channelPayload,
    );
  }
  // The ring is CCW; emitting (a, c, b) matches the legacy fan's winding.
  for (let index = 0; index < triangles.length; index += 3) {
    arrays.indices.push(
      baseVertex + triangles[index]!,
      baseVertex + triangles[index + 2]!,
      baseVertex + triangles[index + 1]!,
    );
  }
}

/**
 * `W-1e` harness seam: the graph-mode river and lake attribute arrays exactly
 * as `buildRegion` produces them, without a Babylon device. Used by
 * `scripts/channel-extract-benchmark.mts` and by the graph byte pin in
 * `tests/render.webgpu-hydrology.test.ts`; the renderer path is unchanged and
 * still goes through `buildMesh`.
 */
export function buildGraphHydrologyMeshArrays(
  rivers: readonly HydrologyRiver[],
  lakes: readonly HydrologyLake[],
): { readonly rivers: HydrologyMeshArrays; readonly lakes: HydrologyMeshArrays } {
  const riverArrays = emptyMeshArrays();
  for (const river of rivers) appendGraphRiver(riverArrays, river);
  const lakeArrays = emptyMeshArrays();
  for (const lake of lakes) appendGraphLake(lakeArrays, lake);
  return { rivers: riverArrays, lakes: lakeArrays };
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
        attributes: ["position", "uv", "flowData", "waterData"],
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
          "sunIlluminanceNormalized",
          "skylightIlluminanceNormalized",
          "cloudCoverage",
          "windDirection",
          "windSpeed",
          "time",
          "regionOpacity",
          "environmentValid",
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
      "sunIlluminanceNormalized",
      atmosphere.sunIlluminanceNormalized,
    );
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
          this.graphMode ? appendGraphRiver(arrays, river) : appendRiver(arrays, river)
        ));
      });
      const lakeBuild = buildMesh(this.scene, `hydrology-lakes-${suffix}`, (arrays) => {
        hydrology.lakes.forEach((lake) => (
          this.graphMode
            ? appendGraphLake(arrays, lake)
            : appendContainedLake(arrays, lake, this.analyticGroundSample!)
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
          options: {
            ...this.generationConfig,
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
