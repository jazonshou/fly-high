import type { Camera } from "@babylonjs/core/Cameras/camera";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder.pure";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import type {
  TimeOfDayPreset,
  WeatherPreset,
} from "@/src/game/types";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";

const SKY_SHADER_NAME = "aerolithPhysicalSky";

const SKY_VERTEX_WGSL = /* wgsl */ `
attribute position: vec3f;
uniform worldViewProjection: mat4x4f;
varying direction: vec3f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  vertexOutputs.position = uniforms.worldViewProjection * vec4f(vertexInputs.position, 1.0);
  // WebGPU uses a 0..1 clip-depth range. Babylon's reversed-Z path clears to
  // the far value (zero) and uses GREATER_OR_EQUAL, so the sky passes only the
  // clear depth and cannot overwrite even the most distant terrain.
  vertexOutputs.position.z = 0.0;
  vertexOutputs.direction = vertexInputs.position;
}
`;

const SKY_FRAGMENT_WGSL = /* wgsl */ `
varying direction: vec3f;
uniform sunDirection: vec3f;
uniform sunColor: vec3f;
uniform zenithColor: vec3f;
uniform horizonColor: vec3f;
uniform groundColor: vec3f;
uniform turbidity: f32;
uniform exposure: f32;

const PI: f32 = 3.14159265359;

fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 0.001), 1.5));
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let view = normalize(input.direction);
  let up = clamp(view.y, -1.0, 1.0);
  let horizon = pow(1.0 - max(up, 0.0), 3.2);
  let airMass = 1.0 / max(0.09, up + 0.16);
  let mu = clamp(dot(view, normalize(uniforms.sunDirection)), -1.0, 1.0);
  let rayleighPhase = 3.0 * (1.0 + mu * mu) / (16.0 * PI);
  let miePhase = henyeyGreenstein(mu, 0.78);
  let rayleighTint = vec3f(0.24, 0.52, 1.0) * rayleighPhase * (0.26 + 0.55 / airMass);
  let mieTint = uniforms.sunColor * miePhase * (0.014 + uniforms.turbidity * 0.014);
  var color = mix(uniforms.zenithColor, uniforms.horizonColor, horizon);
  color += rayleighTint * (0.18 + 0.26 * (1.0 - uniforms.turbidity));
  color += mieTint;
  let sunDisc = smoothstep(0.99982, 0.99994, mu);
  let sunHalo = pow(max(mu, 0.0), 512.0) * 0.32;
  color += uniforms.sunColor * (sunDisc * 18.0 + sunHalo);
  color = select(uniforms.groundColor, color, up >= -0.015);
  color *= uniforms.exposure;
  fragmentOutputs.color = vec4f(max(color, vec3f(0.0)), 1.0);
}
`;

function registerShaders(): void {
  ShaderStore.ShadersStoreWGSL[`${SKY_SHADER_NAME}VertexShader`] = SKY_VERTEX_WGSL;
  ShaderStore.ShadersStoreWGSL[`${SKY_SHADER_NAME}PixelShader`] = SKY_FRAGMENT_WGSL;
}

/**
 * Depth-only cascaded shadow map (1A-5). PCF binds and samples only the depth
 * texture and Babylon disables colour writes for the whole shadow pass, yet
 * the stock generator still allocates a full colour attachment per cascade —
 * memory that is cleared every frame and never sampled. Overriding the target
 * creation to pass `noColorAttachment` reclaims it (~128 MiB at 4096² × 4 with
 * the R16F default). Keep `filter = FILTER_PCF`: a colour-sampling filter
 * (ESM/blur variants) would need the attachment back.
 */
export class DepthOnlyCascadedShadowGenerator extends CascadedShadowGenerator {
  protected override _createTargetRenderTexture(): void {
    const engine = this._scene.getEngine();
    this._shadowMap?.dispose();
    const size = { width: this._mapSize, height: this._mapSize, layers: this.numCascades };
    this._shadowMap = new RenderTargetTexture(
      `${this._light.name}_CSMShadowMap`,
      size,
      this._scene,
      false,
      true,
      this._textureType,
      false,
      undefined,
      false,
      false,
      undefined,
      this._useRedTextureType ? 6 : 5,
      false,
      undefined,
      undefined,
      /* noColorAttachment */ true,
    );
    this._shadowMap.createDepthStencilTexture(
      engine.useReverseDepthBuffer ? 516 : 513,
      true,
      undefined,
      undefined,
      undefined,
      `DepthStencilForCSMShadowGenerator-${this._light.name}`,
    );
    this._shadowMap.noPrePassRenderer = true;
  }
}

interface AtmospherePreset {
  readonly sunDirection: Vector3;
  readonly sunColor: Color3;
  readonly zenith: Color3;
  readonly horizon: Color3;
  readonly ground: Color3;
  readonly intensity: number;
  readonly exposure: number;
}

function presetFor(time: TimeOfDayPreset): AtmospherePreset {
  if (time === "dawn") {
    return {
      sunDirection: new Vector3(-0.66, 0.13, 0.74).normalize(),
      sunColor: new Color3(1, 0.48, 0.22),
      zenith: new Color3(0.055, 0.13, 0.32),
      horizon: new Color3(0.94, 0.30, 0.13),
      ground: new Color3(0.055, 0.065, 0.09),
      intensity: 3.1,
      exposure: 0.82,
    };
  }
  if (time === "golden") {
    return {
      sunDirection: new Vector3(0.72, 0.29, 0.63).normalize(),
      sunColor: new Color3(1, 0.66, 0.33),
      zenith: new Color3(0.10, 0.27, 0.56),
      horizon: new Color3(0.91, 0.44, 0.19),
      ground: new Color3(0.08, 0.07, 0.07),
      intensity: 4.1,
      exposure: 0.94,
    };
  }
  return {
    sunDirection: new Vector3(-0.36, 0.82, 0.44).normalize(),
    sunColor: new Color3(1, 0.96, 0.88),
    zenith: new Color3(0.10, 0.36, 0.78),
    horizon: new Color3(0.58, 0.77, 0.96),
    ground: new Color3(0.11, 0.15, 0.18),
    intensity: 5.2,
    exposure: 1.02,
  };
}

export interface AtmosphereSnapshot {
  readonly sunDirection: Vector3;
  readonly sunColor: Color3;
  readonly sunIntensity: number;
  readonly skyZenith: Color3;
  readonly skyHorizon: Color3;
  readonly ambientColor: Color3;
  readonly exposure: number;
  readonly cloudCoverage: number;
  readonly humidity: number;
  readonly windSpeed: number;
  readonly windDirection: Vector2;
}

/** Owns the single physical sun, ambient sky light, analytic HDR sky and CSM. */
export class AtmosphereSystem {
  readonly sun: DirectionalLight;
  readonly ambient: HemisphericLight;
  readonly shadows: CascadedShadowGenerator;
  private readonly sky: Mesh;
  private readonly skyMaterial: ShaderMaterial;
  private snapshotValue: AtmosphereSnapshot;

  constructor(
    private readonly scene: Scene,
    camera: Camera,
    profile: WebGpuQualityProfile,
    windDirectionRadians = Math.atan2(0.72, 0.28),
  ) {
    registerShaders();
    this.sky = CreateSphere("physical-atmosphere", {
      diameter: 120_000,
      segments: 32,
      sideOrientation: Mesh.BACKSIDE,
    }, scene);
    this.sky.infiniteDistance = true;
    this.sky.isPickable = false;
    this.sky.applyFog = false;
    this.skyMaterial = new ShaderMaterial(
      "physical-atmosphere-material",
      scene,
      SKY_SHADER_NAME,
      {
        attributes: ["position"],
        uniforms: [
          "worldViewProjection",
          "sunDirection",
          "sunColor",
          "zenithColor",
          "horizonColor",
          "groundColor",
          "turbidity",
          "exposure",
        ],
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );
    this.skyMaterial.backFaceCulling = false;
    this.skyMaterial.disableDepthWrite = true;
    this.skyMaterial.disableColorWrite = false;
    this.sky.material = this.skyMaterial;

    this.sun = new DirectionalLight("sun", new Vector3(0.36, -0.82, -0.44), scene);
    this.sun.intensity = 5.2;
    this.sun.autoCalcShadowZBounds = false;
    this.ambient = new HemisphericLight("sky-ambient", Vector3.Up(), scene);
    this.ambient.intensity = 0.58;
    this.ambient.groundColor = new Color3(0.08, 0.09, 0.07);

    // 1A-5: depth-only RTT. `usefulFloatFirst` false — with only depth bound
    // there is no colour precision to trade, and the previous `true` silently
    // fell through to half-float anyway because float32-filterable is never
    // requested. `useRedTextureType` true is the 9.21.2 CSM default, pinned
    // explicitly because the memory estimate depends on it.
    this.shadows = new DepthOnlyCascadedShadowGenerator(
      profile.shadowMapSize,
      this.sun,
      false,
      camera,
      true,
    );
    this.shadows.numCascades = profile.shadowCascades;
    this.shadows.stabilizeCascades = true;
    this.shadows.lambda = 0.78;
    this.shadows.cascadeBlendPercentage = 0.12;
    this.shadows.shadowMaxZ = profile.shadowDistance;
    this.shadows.bias = 0.00035;
    this.shadows.normalBias = 0.035;
    this.shadows.filter = ShadowGenerator.FILTER_PCF;
    this.shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;

    const initial = presetFor("day");
    this.snapshotValue = {
      sunDirection: initial.sunDirection,
      sunColor: initial.sunColor,
      sunIntensity: initial.intensity,
      skyZenith: initial.zenith,
      skyHorizon: initial.horizon,
      ambientColor: initial.zenith.scale(0.58),
      exposure: initial.exposure,
      cloudCoverage: 0.18,
      humidity: 0.5,
      windSpeed: 8,
      windDirection: new Vector2(
        Math.sin(windDirectionRadians),
        Math.cos(windDirectionRadians),
      ).normalize(),
    };
    this.setPreset("day", "clear");
  }

  get snapshot(): AtmosphereSnapshot {
    return this.snapshotValue;
  }

  addShadowCaster(mesh: Mesh, includeDescendants = true): void {
    this.shadows.addShadowCaster(mesh, includeDescendants);
  }

  setPreset(time: TimeOfDayPreset, weather: WeatherPreset): void {
    const preset = presetFor(time);
    const cloudCoverage = weather === "cloudy" ? 0.74 : weather === "breezy" ? 0.38 : 0.16;
    const humidity = weather === "cloudy" ? 0.86 : weather === "breezy" ? 0.62 : 0.45;
    const windSpeed = weather === "breezy" ? 17 : weather === "cloudy" ? 10 : 6;
    const overcastDimming = 1 - cloudCoverage * 0.42;
    const sunIntensity = preset.intensity * overcastDimming;
    const ambientIntensity = 0.48 + humidity * 0.22;
    const skyZenith = Color3.Lerp(
      preset.zenith,
      new Color3(0.20, 0.24, 0.29),
      cloudCoverage * 0.5,
    );
    const skyHorizon = Color3.Lerp(
      preset.horizon,
      new Color3(0.52, 0.56, 0.60),
      humidity * 0.42,
    );
    const exposure = preset.exposure * overcastDimming;
    this.sun.direction.copyFrom(preset.sunDirection).scaleInPlace(-1);
    this.sun.diffuse = preset.sunColor;
    this.sun.intensity = sunIntensity;
    this.ambient.diffuse = skyZenith;
    this.ambient.groundColor = preset.ground;
    this.ambient.intensity = ambientIntensity;
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogDensity = weather === "cloudy" ? 0.00008 : weather === "breezy" ? 0.000045 : 0.000028;
    this.scene.fogColor = Color3.Lerp(preset.horizon, new Color3(0.48, 0.52, 0.56), humidity * 0.32);
    this.skyMaterial.setVector3("sunDirection", preset.sunDirection);
    this.skyMaterial.setColor3("sunColor", preset.sunColor);
    this.skyMaterial.setColor3("zenithColor", skyZenith);
    this.skyMaterial.setColor3("horizonColor", skyHorizon);
    this.skyMaterial.setColor3("groundColor", preset.ground);
    this.skyMaterial.setFloat("turbidity", humidity);
    this.skyMaterial.setFloat("exposure", exposure);
    this.snapshotValue = {
      sunDirection: preset.sunDirection.clone(),
      sunColor: preset.sunColor.clone(),
      sunIntensity,
      skyZenith: skyZenith.clone(),
      skyHorizon: skyHorizon.clone(),
      ambientColor: Color3.Lerp(skyZenith, skyHorizon, 0.28).scale(ambientIntensity),
      exposure,
      cloudCoverage,
      humidity,
      windSpeed,
      windDirection: this.snapshotValue.windDirection.clone(),
    };
  }

  update(cameraLocalPosition: Vector3): void {
    this.sky.position.copyFrom(cameraLocalPosition);
  }

  dispose(): void {
    this.shadows.dispose();
    this.sun.dispose();
    this.ambient.dispose();
    this.sky.dispose(false, false);
    this.skyMaterial.dispose(true, true);
  }
}
