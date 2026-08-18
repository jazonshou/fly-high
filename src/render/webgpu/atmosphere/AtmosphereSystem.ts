import type { Camera } from "@babylonjs/core/Cameras/camera";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder.pure";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import {
  DEFAULT_ENVIRONMENT_STATE,
  type EnvironmentState,
} from "@/src/render/webgpu/nature/EnvironmentState";
import { exposureForState } from "@/src/render/webgpu/nature/EnvironmentDirector";
import {
  AERIAL_PERSPECTIVE_UNIFORMS,
  AERIAL_PERSPECTIVE_WGSL,
  applyAerialPerspectiveToShaderMaterial,
  type AerialPerspectiveBinding,
} from "./AerialPerspective";

const SKY_SHADER_NAME = "aerolithPhysicalSky";

/** The clear-noon palette peak; sunIlluminanceNormalized is relative to it. */
const PEAK_SUN_INTENSITY = 5.2;

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

export const SKY_FRAGMENT_WGSL = /* wgsl */ `
varying direction: vec3f;
${AERIAL_PERSPECTIVE_WGSL}

// The sun's true angular radius — must equal EnvironmentState's
// sun.angularRadiusRadians; the agreement is pinned by test.
const SUN_ANGULAR_RADIUS: f32 = 0.004675;
const SUN_LIMB_DARKENING: f32 = 0.6;
const SUN_DISC_RADIANCE: f32 = 40.0;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let view = normalize(input.direction);
  // 1C-5: the sky IS the shared aerial-perspective integral run to the top
  // of the atmosphere — terrain haze and sky agree by construction, not by
  // tuning, and the below-horizon clamp shows the haze limit instead of a
  // painted ground colour.
  var color = skyRadiance(view);
  // The real sun: true angular size, limb-darkened, reddened by the same
  // transmittance the haze uses — it sets red because the air says so.
  let mu = clamp(dot(view, normalize(uniforms.aerialSunDirection)), -1.0, 1.0);
  // Small-angle chord: acos(mu) loses f32 precision exactly where the disc is.
  let theta = sqrt(max(2.0 * (1.0 - mu), 0.0));
  let radius = theta / SUN_ANGULAR_RADIUS;
  if (radius < 1.1) {
    let limb = 1.0 - SUN_LIMB_DARKENING
      * (1.0 - sqrt(max(1.0 - radius * radius, 0.0)));
    let disc = smoothstep(1.1, 0.98, radius) * max(limb, 0.0);
    color += uniforms.aerialSunRadiance * uniforms.aerialSunTransmittance
      * (disc * SUN_DISC_RADIANCE);
  }
  // 1C-2: the sky writes linear HDR; the one exposure curve lives on the
  // image-processing chain. No shader multiplies its own exposure again.
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

interface AtmospherePalette {
  readonly sunColor: Color3;
  readonly zenith: Color3;
  readonly horizon: Color3;
  readonly ground: Color3;
  readonly intensity: number;
}

/**
 * The look anchors, continuous in sun elevation (1C-1). The three deleted
 * presets survive as anchor rows at the elevations their hand-tuned sun
 * vectors actually had (dawn ≈ 7.5°, golden ≈ 17°, day ≈ 55°), plus a dim
 * pre-1C-10 floor below the horizon, so scrubbing the clock moves through
 * the same art direction the presets carried — with every angle in between.
 */
const PALETTE_ANCHORS: readonly (AtmospherePalette & { readonly elevationDegrees: number })[] = [
  {
    elevationDegrees: -12,
    sunColor: new Color3(0.9, 0.4, 0.25),
    zenith: new Color3(0.012, 0.03, 0.085),
    horizon: new Color3(0.08, 0.075, 0.14),
    ground: new Color3(0.02, 0.024, 0.035),
    intensity: 0.0,
  },
  {
    elevationDegrees: 0,
    sunColor: new Color3(1, 0.42, 0.18),
    zenith: new Color3(0.03, 0.08, 0.22),
    horizon: new Color3(0.7, 0.24, 0.12),
    ground: new Color3(0.04, 0.05, 0.07),
    intensity: 1.1,
  },
  {
    elevationDegrees: 7.5,
    sunColor: new Color3(1, 0.48, 0.22),
    zenith: new Color3(0.055, 0.13, 0.32),
    horizon: new Color3(0.94, 0.3, 0.13),
    ground: new Color3(0.055, 0.065, 0.09),
    intensity: 3.1,
  },
  {
    elevationDegrees: 17,
    sunColor: new Color3(1, 0.66, 0.33),
    zenith: new Color3(0.1, 0.27, 0.56),
    horizon: new Color3(0.91, 0.44, 0.19),
    ground: new Color3(0.08, 0.07, 0.07),
    intensity: 4.1,
  },
  {
    elevationDegrees: 55,
    sunColor: new Color3(1, 0.96, 0.88),
    zenith: new Color3(0.1, 0.36, 0.78),
    horizon: new Color3(0.58, 0.77, 0.96),
    ground: new Color3(0.11, 0.15, 0.18),
    intensity: 5.2,
  },
];

function lerpColor(a: Color3, b: Color3, t: number): Color3 {
  return Color3.Lerp(a, b, t);
}

function paletteForElevation(elevationDegrees: number): AtmospherePalette {
  const anchors = PALETTE_ANCHORS;
  if (elevationDegrees <= anchors[0]!.elevationDegrees) return anchors[0]!;
  const last = anchors[anchors.length - 1]!;
  if (elevationDegrees >= last.elevationDegrees) return last;
  for (let index = 1; index < anchors.length; index += 1) {
    const upper = anchors[index]!;
    if (elevationDegrees > upper.elevationDegrees) continue;
    const lower = anchors[index - 1]!;
    const t =
      (elevationDegrees - lower.elevationDegrees)
      / (upper.elevationDegrees - lower.elevationDegrees);
    return {
      sunColor: lerpColor(lower.sunColor, upper.sunColor, t),
      zenith: lerpColor(lower.zenith, upper.zenith, t),
      horizon: lerpColor(lower.horizon, upper.horizon, t),
      ground: lerpColor(lower.ground, upper.ground, t),
      intensity: lower.intensity + (upper.intensity - lower.intensity) * t,
    };
  }
  return last;
}

export interface AtmosphereSnapshot {
  readonly sunDirection: Vector3;
  readonly sunColor: Color3;
  readonly sunIntensity: number;
  readonly skyZenith: Color3;
  readonly skyHorizon: Color3;
  readonly ambientColor: Color3;
  /**
   * sunIntensity over the clear-noon peak (1C-2): the named replacement for
   * the /5.2 normalisers that lived in three shaders. Multiply sunColor by
   * this; never re-derive the constant.
   */
  readonly sunIlluminanceNormalized: number;
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
    // 1C-4: Babylon's fog is permanently off. The aerial-perspective include
    // is the only atmospheric term; FOGMODE_NONE is asserted at startup so
    // fog and haze can never double-apply through #include<fogFragment>.
    scene.fogMode = Scene.FOGMODE_NONE;
    this.skyMaterial = new ShaderMaterial(
      "physical-atmosphere-material",
      scene,
      SKY_SHADER_NAME,
      {
        attributes: ["position"],
        uniforms: ["worldViewProjection", ...AERIAL_PERSPECTIVE_UNIFORMS],
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
    this.ambient.intensity = 0.05;
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

    const initialPalette = paletteForElevation(46);
    this.snapshotValue = {
      sunDirection: new Vector3(0.35, 0.72, 0.6).normalize(),
      sunColor: initialPalette.sunColor,
      sunIntensity: initialPalette.intensity,
      skyZenith: initialPalette.zenith,
      skyHorizon: initialPalette.horizon,
      ambientColor: initialPalette.zenith.scale(0.58),
      sunIlluminanceNormalized: initialPalette.intensity / PEAK_SUN_INTENSITY,
      cloudCoverage: 0.18,
      humidity: 0.5,
      windSpeed: 8,
      windDirection: new Vector2(
        Math.sin(windDirectionRadians),
        Math.cos(windDirectionRadians),
      ).normalize(),
    };
    this.applyEnvironment(DEFAULT_ENVIRONMENT_STATE);
  }

  get snapshot(): AtmosphereSnapshot {
    return this.snapshotValue;
  }

  /** The sky dome, exposed so the environment probe (1C-6) can render it. */
  get skyMesh(): Mesh {
    return this.sky;
  }

  /**
   * Per-frame haze binding (1C-4/1C-5). The sky material consumes the same
   * shared uniforms every other receiver does — one integral, one binding.
   */
  setAerialPerspective(binding: AerialPerspectiveBinding): void {
    applyAerialPerspectiveToShaderMaterial(
      this.skyMaterial,
      binding,
      (name, x, y, z) => this.skyMaterial.setVector3(name, new Vector3(x, y, z)),
      (name, x, y, z, w) => this.skyMaterial.setVector4(name, new Vector4(x, y, z, w)),
    );
  }

  addShadowCaster(mesh: Mesh, includeDescendants = true): void {
    this.shadows.addShadowCaster(mesh, includeDescendants);
  }

  /**
   * Applies one continuous environment instant (1C-1). The sun direction is
   * the NOAA solar position resolved by the EnvironmentDirector; the look
   * interpolates the palette anchors by real sun elevation. Weather is read
   * from the state's continuous fields (coverage dimming, humidity haze) —
   * 1C-2 owns the single exposure curve, and 1C-4 owns all haze, so this
   * touches neither fog nor any per-shader exposure.
   */
  applyEnvironment(state: EnvironmentState): void {
    const sunDirection = new Vector3(
      state.sun.direction[0],
      state.sun.direction[1],
      state.sun.direction[2],
    ).normalize();
    const elevationDegrees = Math.asin(Math.min(1, Math.max(-1, sunDirection.y))) * 180 / Math.PI;
    const palette = paletteForElevation(elevationDegrees);
    const cloudCoverage = state.weather.cloudCoverage;
    const humidity = state.weather.relativeHumidity;
    const windSpeed = Math.hypot(
      state.windLayers[0]?.velocityMetersPerSecond[0] ?? 6,
      state.windLayers[0]?.velocityMetersPerSecond[1] ?? 0,
    ) / 0.56;
    const overcastDimming = 1 - cloudCoverage * 0.42;
    const sunIntensity = palette.intensity * overcastDimming;
    // 1C-2: the ONE exposure curve. The relative-EV100 formula preserves the
    // day+clear look exactly; every private shader exposure is deleted.
    this.scene.imageProcessingConfiguration.exposure = exposureForState(state);
    // 1C-6: IBL now carries the skylight. The hemispheric light survives
    // only as a small ground-bounce approximation, so skylight is not
    // double-counted; the snapshot's ambientColor keeps the old scale — it
    // describes sky-ambient radiance for shaders (clouds), not this light.
    const ambientIntensity = 0.05;
    const snapshotAmbientScale = 0.48 + humidity * 0.22;
    const skyZenith = Color3.Lerp(
      palette.zenith,
      new Color3(0.20, 0.24, 0.29),
      cloudCoverage * 0.5,
    );
    const skyHorizon = Color3.Lerp(
      palette.horizon,
      new Color3(0.52, 0.56, 0.60),
      humidity * 0.42,
    );
    this.sun.direction.copyFrom(sunDirection).scaleInPlace(-1);
    this.sun.diffuse = palette.sunColor;
    this.sun.intensity = sunIntensity;
    this.ambient.diffuse = skyZenith;
    this.ambient.groundColor = palette.ground;
    this.ambient.intensity = ambientIntensity;
    this.snapshotValue = {
      sunDirection: sunDirection.clone(),
      sunColor: palette.sunColor.clone(),
      sunIntensity,
      skyZenith: skyZenith.clone(),
      skyHorizon: skyHorizon.clone(),
      ambientColor: Color3.Lerp(skyZenith, skyHorizon, 0.28).scale(snapshotAmbientScale),
      sunIlluminanceNormalized: sunIntensity / PEAK_SUN_INTENSITY,
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
