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

const HYDROLOGY_SHADER_NAME = "aerolithHydrologyWater";

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
varying waterInfo: vec3f;
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
  vertexOutputs.position = uniforms.viewProjection * displacedWorld;
  vertexOutputs.worldPosition = displacedWorld.xyz;
  vertexOutputs.absoluteWorldXZ = absoluteXZ;
  vertexOutputs.surfaceNormal = normalize(vec3f(-gradient.x, 1.0, -gradient.y));
  vertexOutputs.flowDirection = flow;
  vertexOutputs.flowSpeed = vertexInputs.flowData.z;
  vertexOutputs.whitewater = vertexInputs.flowData.w;
  vertexOutputs.waterInfo = vertexInputs.waterData.xyz;
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
varying waterInfo: vec3f;
varying waterUv: vec2f;
varying planarReflectionClip: vec4f;
uniform cameraPosition: vec3f;
uniform sunDirection: vec3f;
uniform sunColor: vec3f;
uniform skyZenith: vec3f;
uniform skyHorizon: vec3f;
uniform cloudCoverage: f32;
uniform windDirection: vec2f;
uniform windSpeed: f32;
uniform time: f32;
uniform regionOpacity: f32;

${CLOUD_SHADOW_RECEIVER_WGSL}
${PLANAR_REFLECTION_FRAGMENT_WGSL}
${SUN_SHADOW_FRAGMENT_WGSL}
${AERIAL_PERSPECTIVE_WGSL}

const PI: f32 = 3.14159265359;

fn fresnelSchlick(cosine: f32, f0: vec3f) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(1.0 - cosine, 5.0);
}

fn distributionGgx(normal: vec3f, halfVector: vec3f, roughness: f32) -> f32 {
  let alpha = roughness * roughness;
  let alpha2 = alpha * alpha;
  let nDotH = max(dot(normal, halfVector), 0.0);
  let denominator = nDotH * nDotH * (alpha2 - 1.0) + 1.0;
  return alpha2 / max(PI * denominator * denominator, 0.000001);
}

fn geometrySchlickGgx(nDotDirection: f32, roughness: f32) -> f32 {
  let k = (roughness + 1.0) * (roughness + 1.0) * 0.125;
  return nDotDirection / max(nDotDirection * (1.0 - k) + k, 0.0001);
}

fn reflectedSky(direction: vec3f, worldXZ: vec2f, directSunVisibility: f32) -> vec3f {
  let horizonAmount = pow(1.0 - clamp(direction.y, 0.0, 1.0), 2.3);
  var sky = mix(uniforms.skyZenith, uniforms.skyHorizon, horizonAmount);
  // Match the ocean fallback: cloud coverage changes reflected energy, but an
  // unrelated procedural cloud pattern must not masquerade as a reflection of
  // the volumetric sky.
  let overcast = smoothstep(0.18, 0.92, uniforms.cloudCoverage);
  let overcastSky = mix(vec3f(0.31, 0.36, 0.41), vec3f(0.56, 0.61, 0.65), horizonAmount);
  sky = mix(sky, overcastSky, overcast * 0.52);
  let solarGlare = pow(max(dot(direction, normalize(uniforms.sunDirection)), 0.0), 1800.0);
  return sky + uniforms.sunColor * solarGlare * 11.0 * directSunVisibility
    * (1.0 - overcast * 0.88);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let normal = normalize(input.surfaceNormal);
  let view = normalize(uniforms.cameraPosition - input.worldPosition);
  let light = normalize(uniforms.sunDirection);
  let halfVector = normalize(view + light);
  let nDotV = max(dot(normal, view), 0.001);
  let nDotL = max(dot(normal, light), 0.0);
  let lakeFactor = clamp(input.waterInfo.y, 0.0, 1.0);
  let depth = max(input.waterInfo.x, 0.04);
  let roughness = clamp(
    mix(0.14, 0.09, lakeFactor) + input.flowSpeed * 0.008 + uniforms.windSpeed * 0.0016,
    0.075,
    0.28,
  );
  let f0 = vec3f(0.0204);
  let fresnel = fresnelSchlick(nDotV, f0);
  let distribution = distributionGgx(normal, halfVector, roughness);
  let geometry = geometrySchlickGgx(nDotV, roughness)
    * geometrySchlickGgx(max(nDotL, 0.001), roughness);
  let sunSpecular = distribution * geometry
    * fresnelSchlick(max(dot(view, halfVector), 0.0), f0)
    / max(4.0 * nDotV * max(nDotL, 0.001), 0.001);

  let cloudShadow = sampleCloudShadowReceiver(input.worldPosition);
  let sunShadow = sampleSunShadowReceiver(
    input.sunShadowClip0,
    input.sunShadowClip1,
    input.sunShadowClip2,
    input.sunShadowClip3,
    input.sunShadowViewDepth,
  );
  let directSunVisibility = cloudShadow * sunShadow;
  let atmosphereReflection = reflectedSky(
    reflect(-view, normal),
    input.absoluteWorldXZ,
    directSunVisibility,
  );
  let reflection = samplePlanarSceneReflection(
    input.planarReflectionClip,
    normal,
    input.worldPosition.y,
    atmosphereReflection,
  );
  let absorption = mix(vec3f(0.42, 0.105, 0.055), vec3f(0.28, 0.075, 0.038), lakeFactor);
  let depthTransmittance = exp(-absorption * depth);
  let riverBed = vec3f(0.095, 0.105, 0.075);
  let lakeBed = vec3f(0.025, 0.065, 0.064);
  let bed = mix(riverBed, lakeBed, lakeFactor);
  let volumeScatter = mix(vec3f(0.025, 0.17, 0.15), vec3f(0.012, 0.105, 0.13), lakeFactor)
    * (1.0 - depthTransmittance);
  let transmitted = bed * depthTransmittance + volumeScatter;
  var color = transmitted * (vec3f(1.0) - fresnel) + reflection * fresnel;
  color += sunSpecular * uniforms.sunColor * nDotL * 4.0 * directSunVisibility;

  let flowCrest = pow(max(
    sin(dot(input.absoluteWorldXZ, input.flowDirection) * 0.13
      - uniforms.time * (1.0 + input.flowSpeed * 1.8)),
    0.0,
  ), 9.0);
  let shorePattern = 0.58 + 0.42 * sin(
    dot(input.absoluteWorldXZ, vec2f(-input.flowDirection.y, input.flowDirection.x)) * 0.19
      + uniforms.time * 0.8,
  );
  let shoreFoam = smoothstep(0.76, 1.0, input.waterInfo.z) * shorePattern * 0.3;
  let rapidFoam = clamp(input.whitewater * (0.4 + flowCrest * 0.85), 0.0, 1.0);
  let foam = clamp(shoreFoam + rapidFoam, 0.0, 1.0);
  color = mix(color, vec3f(0.78, 0.84, 0.82), foam);
  // 1C-4: rivers and lakes fade on the same shared curve as the terrain
  // around them — inland water no longer punches through the haze.
  color = applyAerialPerspective(
    color,
    input.worldPosition.y,
    distance(uniforms.cameraPosition, input.worldPosition),
    -view,
  );
  // Alpha now represents shallow transmission and region crossfade, not a
  // constant translucent plastic sheet. Even shallow water retains enough
  // optical density to read as a surface from flight altitude.
  let alpha = clamp(mix(0.88, 0.995, 1.0 - exp(-depth * 0.82)) + foam * 0.01, 0.86, 0.995);
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

interface MeshArrays {
  readonly positions: number[];
  readonly normals: number[];
  readonly uvs: number[];
  readonly indices: number[];
  readonly flowData: number[];
  readonly waterData: number[];
}

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
    const depth = 0.22 + point.widthMeters * 0.075;
    for (const lane of [-1, 0, 1] as const) {
      const shore = Math.abs(lane);
      arrays.positions.push(
        point.x + rightX * halfWidth * lane,
        point.y,
        point.z + rightZ * halfWidth * lane,
      );
      arrays.normals.push(0, 1, 0);
      arrays.uvs.push(distanceAlong / 16, lane * 0.5 + 0.5);
      arrays.flowData.push(flow[0], flow[1], point.flowSpeedMetersPerSecond, whitewater);
      arrays.waterData.push(depth * (1 - shore * 0.8), 0, shore, 0);
    }
  }
  for (let index = 0; index < river.points.length - 1; index += 1) {
    const row = baseVertex + index * 3;
    const nextRow = row + 3;
    for (let lane = 0; lane < 2; lane += 1) {
      const a = row + lane;
      const b = nextRow + lane;
      const c = a + 1;
      const d = b + 1;
      arrays.indices.push(a, b, c, c, b, d);
    }
  }
}

function appendLake(arrays: MeshArrays, lake: HydrologyLake): void {
  if (lake.boundary.length < 3) return;
  const centerVertex = arrays.positions.length / 3;
  arrays.positions.push(lake.centerX, lake.surfaceHeight, lake.centerZ);
  arrays.normals.push(0, 1, 0);
  arrays.uvs.push(0.5, 0.5);
  arrays.flowData.push(lake.flowDirection[0], lake.flowDirection[1], 0.18, 0);
  arrays.waterData.push(lake.maximumDepthMeters, 1, 0, 0);
  for (const point of lake.boundary) {
    const direction = normalizedDirection(point.x - lake.centerX, point.z - lake.centerZ);
    arrays.positions.push(point.x, point.y, point.z);
    arrays.normals.push(0, 1, 0);
    arrays.uvs.push(0.5 + direction[0] * 0.5, 0.5 + direction[1] * 0.5);
    arrays.flowData.push(lake.flowDirection[0], lake.flowDirection[1], 0.18, 0);
    arrays.waterData.push(0.08, 1, 1, 0);
  }
  for (let index = 0; index < lake.boundary.length; index += 1) {
    const current = centerVertex + 1 + index;
    const next = centerVertex + 1 + (index + 1) % lake.boundary.length;
    arrays.indices.push(centerVertex, next, current);
  }
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
  // Preserve opaque depth by sharing the main group; transparent meshes are
  // already drawn after opaque geometry by Babylon's rendering manager.
  mesh.renderingGroupId = 0;
  return {
    mesh,
    vertexCount: arrays.positions.length / 3,
    triangleCount: arrays.indices.length / 3,
  };
}

export interface HydrologySystemOptions extends HydrologyGenerationOptions {
  readonly atmosphere: AtmosphereSnapshot;
  /** Prevailing flow direction (towards), clockwise from world north. */
  readonly windDirectionRadians?: number;
  /** Enables off-main-thread generation from the deterministic built-in world. */
  readonly workerWorldSeed?: WorldSeed;
  readonly paging?: HydrologyPagingOptions;
  /** Test/custom-world injection point. HydrologySystem assumes ownership. */
  readonly generationClient?: HydrologyGenerationClientLike;
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

/**
 * Deterministic endless rivers and lakes. Overlapping regions are generated in
 * a worker ahead of the observer and swapped only when complete. Geometry stays
 * in absolute CPU coordinates while each resident root follows floating-origin
 * rebases and the shader reconstructs absolute x/z for phase-stable ripples.
 */
export class HydrologySystem implements PlanarReflectionReceiver {
  private readonly material: ShaderMaterial;
  private readonly scene: Scene;
  private readonly generationConfig: HydrologyGenerationConfig;
  private readonly pagingConfig: HydrologyPagingConfig;
  private readonly generationClient: HydrologyGenerationClientLike;
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

  constructor(
    scene: Scene,
    private readonly camera: Camera,
    options: HydrologySystemOptions,
    initializeSynchronously = true,
  ) {
    registerHydrologyShaders();
    const {
      atmosphere,
      windDirectionRadians,
      workerWorldSeed,
      paging,
      generationClient,
      ...generationOptions
    } = options;
    this.scene = scene;
    this.generationConfig = resolveHydrologyConfig(generationOptions);
    this.pagingConfig = resolveHydrologyPagingConfig(
      this.generationConfig.centerX,
      this.generationConfig.centerZ,
      this.generationConfig.extentMeters,
      paging,
    );
    this.generationClient = generationClient ?? new HydrologyGenerationClient({
      worldSeed: generationOptions.worldSeed,
      terrainSample: generationOptions.terrainSample,
      ...(workerWorldSeed === undefined ? {} : { workerWorldSeed }),
    });
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
          "skyZenith",
          "skyHorizon",
          "cloudCoverage",
          "windDirection",
          "windSpeed",
          "time",
          "regionOpacity",
          ...CLOUD_SHADOW_RECEIVER_UNIFORMS,
          ...PLANAR_REFLECTION_UNIFORMS,
          ...SUN_SHADOW_UNIFORMS,
          ...AERIAL_PERSPECTIVE_UNIFORMS,
        ],
        samplers: [
          CLOUD_SHADOW_RECEIVER_SAMPLER,
          PLANAR_REFLECTION_SAMPLER,
          SUN_SHADOW_SAMPLER,
        ],
        needAlphaBlending: true,
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );
    this.material.backFaceCulling = false;
    this.material.transparencyMode = Material.MATERIAL_ALPHABLEND;
    this.material.alphaMode = Constants.ALPHA_COMBINE;
    this.material.disableDepthWrite = false;
    this.material.setVector2("hydrologyWorldOrigin", Vector2.Zero());
    const windRadians = windDirectionRadians ?? 1;
    this.material.setVector2(
      "windDirection",
      new Vector2(Math.sin(windRadians), Math.cos(windRadians)).normalize(),
    );
    this.material.setFloat("time", 0);
    this.material.setFloat("regionOpacity", 1);
    this.material.setMatrix("planarReflectionViewProjection", Matrix.Identity());
    this.material.setFloat("planarReflectionPlaneHeight", this.generationConfig.seaLevel);
    this.material.setFloat("planarReflectionStrength", 0);
    this.material.setFloat("planarReflectionValid", 0);
    this.material.setFloat("planarReflectionReceiverEnabled", 0);
    this.setAtmosphere(atmosphere);

    if (initializeSynchronously) {
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
      await system.requestRegion(system.initialSelection(), signal);
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
      this.material.removeTexture(PLANAR_REFLECTION_SAMPLER);
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
    this.material.setColor3("skyZenith", atmosphere.skyZenith);
    this.material.setColor3("skyHorizon", atmosphere.skyHorizon);
    this.material.setFloat("cloudCoverage", atmosphere.cloudCoverage);
    this.material.setFloat("windSpeed", atmosphere.windSpeed);
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
    this.updateTransition(timeSeconds);
    const resolvedObserver: HydrologyPagingObserver = observer ?? {
      x: cameraLocalPosition.x + this.originX,
      z: cameraLocalPosition.z + this.originZ,
      velocityX: 0,
      velocityZ: 0,
    };
    const selection = selectHydrologyRegion(resolvedObserver, this.pagingConfig);
    if (selection.key === this.currentRegion?.selection.key) {
      if (this.pendingRegionKey && this.pendingRegionKey !== selection.key) {
        this.generationClient.cancel(this.pendingRequestId);
      }
      return;
    }
    if (selection.key === this.pendingRegionKey) return;
    if (this.pendingRegionKey) this.generationClient.cancel(this.pendingRequestId);
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
      queuedGenerationCount: this.generationClient.queuedCount,
      pagingRequestCount: this.pagingRequestCount,
      regionSwapCount: this.regionSwapCount,
      failedGenerationCount: this.failedGenerationCount,
      discardedGenerationCount: this.discardedGenerationCount,
      lastGenerationMilliseconds: this.lastGenerationMilliseconds,
      usingMainThreadFallback: this.generationClient.isUsingFallback,
      lastGenerationUsedWorker: this.lastGenerationUsedWorker,
      currentRegionOpacity: this.currentRegion?.opacity ?? 0,
      previousRegionOpacity: this.previousRegion?.opacity ?? 0,
      disposed: this.disposed,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generationClient.dispose();
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
      const riverBuild = buildMesh(this.scene, `hydrology-rivers-${suffix}`, (arrays) => {
        hydrology.rivers.forEach((river) => appendRiver(arrays, river));
      });
      const lakeBuild = buildMesh(this.scene, `hydrology-lakes-${suffix}`, (arrays) => {
        hydrology.lakes.forEach((lake) => appendLake(arrays, lake));
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
    const generation = ++this.requestGeneration;
    this.pagingRequestCount += 1;
    this.pendingRegionKey = selection.key;
    const timeoutMilliseconds = this.pagingConfig.generationTimeoutMilliseconds;
    let timedOut = false;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        timedOut = true;
        this.generationClient.cancel(this.pendingRequestId);
      }, timeoutMilliseconds);
      const clearPending = (): void => {
        clearTimeout(timeout);
        if (generation !== this.requestGeneration) return;
        this.pendingRegionKey = null;
        this.pendingRequestId = -1;
      };
      this.pendingRequestId = this.generationClient.request(
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
