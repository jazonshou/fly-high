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
import {
  adaptLuminance,
  adaptedLuminanceCdM2,
  exposureForState,
  horizontalIlluminanceLux,
  REFERENCE_ILLUMINANCE_LUX,
  SCENE_UNIT_TO_NITS,
  twilightExposureDipFactor,
} from "@/src/render/webgpu/nature/EnvironmentDirector";
import {
  equatorialToWorld,
  equatorialToWorldRows,
  equatorialUnitVector,
  localSiderealTimeHours,
} from "./StarCatalogue";
import {
  moonIlluminanceLux,
  moonState,
  FULL_MOON_ILLUMINANCE_LUX,
  MOONLIGHT_TINT,
  type MoonState,
} from "./Ephemeris";
import type { EnvironmentClock } from "@/src/world/environmentClock";
import {
  AERIAL_PERSPECTIVE_UNIFORMS,
  AERIAL_PERSPECTIVE_WGSL,
  aerialNightness,
  applyAerialPerspectiveToShaderMaterial,
  twilightAmbientFloorFactor,
  twilightArchRadiance,
  twilightArchStrength,
  MOON_TWILIGHT_RECESSION,
  TWILIGHT_ARCH_KEY_FACTOR,
  type AerialPerspectiveBinding,
} from "./AerialPerspective";

const SKY_SHADER_NAME = "aerolithPhysicalSky";

/** The clear-noon palette peak; sunIlluminanceNormalized is relative to it. */
const PEAK_SUN_INTENSITY = 5.2;

/**
 * `7-1` — the moon's directional-light intensity at full, zenith, mean
 * distance, in the renderer's linear units.
 *
 * **This is the one art-directed night constant, and the reason is
 * arithmetic, not taste.** A full moon delivers 0.25 lux against the sun's
 * 120,000 — a ratio of 4.8 × 10⁵. The renderer's beauty target is fp16,
 * whose smallest normal value is 6.1 × 10⁻⁵, so at the sun's own calibration
 * (5.2 units = 120,000 lux) moonlit ground would land at 1.1 × 10⁻⁵ and be
 * quantised to nothing before any post-process could see it. Representing
 * night photometrically needs a scene PRE-EXPOSURE applied to every light
 * AND every shader that writes radiance, which `1C-2` deliberately did not
 * build (assertion 29 forbids a shader multiplying its own exposure, which
 * is exactly what a pre-exposure is). `7-4`'s clustered lighting will meet
 * the same 10⁵ range with light points and is where that decision belongs.
 *
 * So the ABSOLUTE level is chosen; everything RELATIVE is physical. Phase,
 * the opposition surge, altitude and the perigee/apogee distance term all
 * come from `Ephemeris.moonIlluminanceLux`, normalised to the full-moon
 * value, and `7-2` reads the true lux for its rod response — so what the
 * viewer perceives is driven by real photometry even though the buffer is
 * not.
 */
export const MOON_PEAK_LIGHT_INTENSITY = 0.18;
// ART DIRECTION 2026-09-01: raised from 0.055 (3.3x) on Jason's direction —
// *"there should be a stronger lighting effect from the moon ... the moon can
// be stronger than expected"*. The docblock above already says the ABSOLUTE
// level is chosen rather than physical, so this moves a number that was always
// art-directed; everything RELATIVE (phase, opposition surge, altitude,
// distance) still comes from real photometry. See SCOTOPIC_CHROMA_RETENTION
// for the rest of the night art direction and the reason it is deliberate.

/**
 * Scene-linear radiance of the moon's disc at full. The disc is far brighter
 * than the ground it lights (albedo 0.12 at 0.25 lux still reads as a small
 * bright object), and this is what makes it read as a light source rather
 * than a grey sticker.
 */
export const MOON_DISC_RADIANCE = 2.1;

/**
 * `7-2` — floor on the sky-ambient scale.
 *
 * The realignment named `ambientIntensity = 0.05` as a constant to reopen,
 * and reopening it PHYSICALLY takes the ground bounce to ~10⁻⁹ of its
 * daylight value at midnight, which the fp16 beauty buffer cannot carry (see
 * `MOON_PEAK_LIGHT_INTENSITY`). So the scale is real over the range the
 * buffer can hold and floors at a fifth of the daylight value — a night sky
 * really does bounce a little light off the ground, and this is the level at
 * which the rod pathway has something to work with. The constant is now a
 * night value with a reason, which is what the realignment asked for.
 */
export const NIGHT_AMBIENT_FLOOR_SCALE = 0.2;

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
uniform sunDiscVisibility: f32;
// 7-1/7-3: the night sky's own inputs. moonFrame = (angularRadius,
// illuminatedFraction, phaseAngle/180, earthshine); galacticPole/Center are
// the galactic frame already rotated into world axes by the star field's own
// matrix, so the Milky Way rides the same sidereal rotation the stars do.
// The disc's TERMINATOR is not in there on purpose — it falls out of the
// sky's own sun direction, so the drawn phase can never disagree with the
// lighting.
uniform moonDirection: vec3f;
// NIGHT_LOOK_ARCHITECTURE 2.1: the TRUE sun, for the moon's phase only.
// aerialSunDirection becomes the MOON below twilight (the integral's night
// source), and a phase computed against it would light the moon with itself
// - permanently full. The terminator must follow the real sun.
uniform moonPhaseSunDirection: vec3f;
uniform moonFrame: vec4f;
uniform moonRadiance: vec3f;
uniform galacticPole: vec3f;
uniform galacticCenter: vec3f;
uniform nightSkyStrength: f32;
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
    // 2-9: zeroed during environment-probe captures. The probe cube is the
    // AMBIENT sky (reflections + IBL); direct sun everywhere is analytic —
    // the CSM light on solids, the Karis lobe on water. A 40x-radiance disc
    // baked into a 128 px cube is sub-texel: it double-counts the sun and
    // renders as a blocky aliasing blob in mirror reflections.
    color += uniforms.aerialSunRadiance * uniforms.aerialSunTransmittance
      * (disc * SUN_DISC_RADIANCE * uniforms.sunDiscVisibility);
  }
  // 7-3: the Milky Way. Surface brightness falls off with galactic latitude
  // and is strongly brightest toward the galactic centre in Sagittarius —
  // the two facts that make the band recognisable. The star field's own
  // sidereal matrix rotated this frame into world axes, so the band and the
  // constellations turn together by construction rather than by tuning.
  // (The 1C-10 placeholder that hashed view directions into identical
  // "stars" on a dome that never rotated is deleted with this item.)
  if (uniforms.nightSkyStrength > 0.0) {
    let galacticSine = clamp(dot(view, uniforms.galacticPole), -1.0, 1.0);
    let band = exp(-abs(galacticSine) / 0.13);
    // Toward the centre the bulge is several times brighter than the
    // anticentre arm, and a dust lane splits it.
    let towardCenter = clamp(dot(view, uniforms.galacticCenter), -1.0, 1.0);
    let bulge = 1.0 + 2.4 * smoothstep(0.25, 0.95, towardCenter);
    let lane = 1.0 - 0.45 * exp(-abs(galacticSine) / 0.035)
      * smoothstep(-0.2, 0.6, towardCenter);
    // Extinction: the band goes out at the horizon like everything else.
    let horizon = smoothstep(-0.02, 0.16, view.y);
    color += vec3f(0.72, 0.78, 1.0)
      * (band * bulge * lane * horizon * 0.00055 * uniforms.nightSkyStrength);
  }

  // 7-1 — the moon: ephemeris direction, true angular size, a phase drawn
  // from the real sun-moon geometry, maria, limb darkening and earthshine.
  let moonMu = clamp(dot(view, uniforms.moonDirection), -1.0, 1.0);
  let moonTheta = sqrt(max(2.0 * (1.0 - moonMu), 0.0));
  let moonRadius = moonTheta / max(uniforms.moonFrame.x, 1e-5);
  if (moonRadius < 1.02) {
    // Reconstruct the surface point on the visible hemisphere. The disc is
    // small enough that an orthographic reconstruction about the view axis
    // is exact to well under a texel of the maria.
    let moonUp = normalize(vec3f(0.0, 1.0, 0.0)
      - uniforms.moonDirection * uniforms.moonDirection.y);
    let moonRight = normalize(cross(moonUp, uniforms.moonDirection));
    let offset = (view - uniforms.moonDirection * moonMu) / max(uniforms.moonFrame.x, 1e-5);
    let discX = clamp(dot(offset, moonRight), -1.0, 1.0);
    let discY = clamp(dot(offset, moonUp), -1.0, 1.0);
    let discZ = sqrt(max(1.0 - discX * discX - discY * discY, 0.0));
    // Surface normal in the moon's own frame, expressed in world axes.
    let surfaceNormal = normalize(
      moonRight * discX + moonUp * discY + uniforms.moonDirection * -discZ);
    // PHASE: the moon's lit hemisphere faces the sun. The sun is far enough
    // that its direction from the moon equals its direction from us, so the
    // terminator falls out of one dot product — no phase parameter is
    // needed and the phase can never disagree with the sky's own sun.
    let lit = clamp(dot(surfaceNormal, uniforms.moonPhaseSunDirection), 0.0, 1.0);
    // Lommel-Seeliger-ish limb behaviour: the moon is famously FLAT, not
    // Lambertian — a full moon is a uniform disc, not a bright centre.
    let limb = lit / max(lit + max(discZ, 0.02), 0.05) * 1.9;
    // Maria: three broad dark basins plus small-scale crater mottling, from
    // the surface position so they rotate with the disc and never swim.
    let mariaField =
      exp(-12.0 * length(vec2f(discX + 0.22, discY - 0.28)))
      + 0.8 * exp(-16.0 * length(vec2f(discX - 0.10, discY - 0.05)))
      + 0.7 * exp(-20.0 * length(vec2f(discX + 0.05, discY + 0.34)));
    let craters = 0.5 + 0.5 * sin(discX * 41.0) * sin(discY * 37.0);
    let albedo = mix(0.135, 0.075, clamp(mariaField, 0.0, 1.0))
      * (0.92 + 0.16 * craters);
    // Earthshine: the dark limb is lit by a nearly FULL Earth whenever the
    // moon is new, which is why the old moon is visible in the new moon's
    // arms. Its strength is the complement of the moon's own phase.
    let earthshine = uniforms.moonFrame.w * (1.0 - lit);
    let disc = smoothstep(1.02, 0.985, moonRadius);
    color += uniforms.moonRadiance
      * (disc * albedo * (limb + earthshine) * 12.0);
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

/**
 * R-26's calibration: `skyHorizon x meanSurfaceAlbedo x this` reproduces the
 * retired `ground` palette row at the reference day+clear key (55 deg sun) to
 * within 0.03 on red and green. Chosen once, against the value it replaces, so
 * daylight does not move on the day the derivation lands.
 */
const GROUND_BOUNCE_CALIBRATION = 1.15;

/**
 * `R-26` removed this table's `ground` row. Deviation `D-9` kept the palette
 * alive "only for the light rig and the snapshot until Phases 3/7 retire it",
 * and the ground row was the light rig's half of that: a hand-tuned bounce
 * colour standing in for a ground that had no albedo. The bounce is derived
 * from the surface system's mean albedo now — see `setSurfaceAlbedo`.
 */
interface AtmospherePalette {
  readonly sunColor: Color3;
  readonly zenith: Color3;
  readonly horizon: Color3;
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
    intensity: 0.0,
  },
  {
    elevationDegrees: 0,
    sunColor: new Color3(1, 0.42, 0.18),
    zenith: new Color3(0.03, 0.08, 0.22),
    horizon: new Color3(0.7, 0.24, 0.12),
    intensity: 1.1,
  },
  {
    elevationDegrees: 7.5,
    sunColor: new Color3(1, 0.48, 0.22),
    zenith: new Color3(0.055, 0.13, 0.32),
    horizon: new Color3(0.94, 0.3, 0.13),
    intensity: 3.1,
  },
  {
    elevationDegrees: 17,
    sunColor: new Color3(1, 0.66, 0.33),
    zenith: new Color3(0.1, 0.27, 0.56),
    horizon: new Color3(0.91, 0.44, 0.19),
    intensity: 4.1,
  },
  {
    elevationDegrees: 55,
    sunColor: new Color3(1, 0.96, 0.88),
    zenith: new Color3(0.1, 0.36, 0.78),
    horizon: new Color3(0.58, 0.77, 0.96),
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
  /**
   * 2-9: the sun's angular radius (1C-1 made it live in EnvironmentState).
   * The water materials' Karis solid-angle specular lobe consumes it — the
   * one physical quantity that replaced four magic sun-glint numbers.
   */
  readonly sunAngularRadiusRadians: number;
  readonly cloudCoverage: number;
  readonly humidity: number;
  readonly windSpeed: number;
  readonly windDirection: Vector2;
  /** 7-1: unit vector toward the moon in world axes. */
  readonly moonDirection: Vector3;
  /** 7-1: the moon's contribution to horizontal illuminance, lux. */
  readonly moonIlluminanceLux: number;
  /** 7-1: illuminated fraction of the disc, 0…1. */
  readonly moonIlluminatedFraction: number;
  /**
   * 7-2: the eye's adapted luminance in cd/m², after the bounded adaptation
   * step. The scotopic pass's rod response reads it; it is a function of
   * pinned inputs only, so the capture stays deterministic.
   */
  readonly adaptedLuminanceCdM2: number;
  /**
   * 7-2: the SCENE's key luminance in cd/m² — Lambertian ground under this
   * frame's own lights. The rod response is half-saturated here, which is
   * what puts a night image in the middle of its range whatever the buffer's
   * absolute scale is.
   */
  readonly sceneKeyLuminanceCdM2: number;
}

/** Owns the single physical sun, ambient sky light, analytic HDR sky and CSM. */
export class AtmosphereSystem {
  readonly sun: DirectionalLight;
  /** 7-1: moonlight, reflected sunlight at ~4,100 K — warm, never blue. */
  readonly moon: DirectionalLight;
  readonly ambient: HemisphericLight;
  /**
   * R-26: the terrain surface system's seasonal mean albedo, pushed in by the
   * renderer. Defaults to the same 0.18 grey the atmospheric ground albedo
   * uses, so a scene without terrain lights exactly as it did.
   */
  private surfaceAlbedo = new Color3(0.18, 0.18, 0.18);
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
        uniforms: [
          "worldViewProjection",
          "sunDiscVisibility",
          "moonDirection",
          "moonPhaseSunDirection",
          "moonFrame",
          "moonRadiance",
          "galacticPole",
          "galacticCenter",
          "nightSkyStrength",
          ...AERIAL_PERSPECTIVE_UNIFORMS,
        ],
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );
    this.skyMaterial.backFaceCulling = false;
    this.skyMaterial.disableDepthWrite = true;
    this.skyMaterial.disableColorWrite = false;
    // 2-9: 1 for the visible sky; the environment probe zeroes it around its
    // cube captures so the reflection/IBL environment carries no baked sun.
    this.skyMaterial.setFloat("sunDiscVisibility", 1);
    // 7-1/7-3 defaults: no moon, no night sky, until the first clock lands.
    this.skyMaterial.setVector3("moonDirection", new Vector3(0, -1, 0));
    this.skyMaterial.setVector3("moonPhaseSunDirection", new Vector3(0, 1, 0));
    this.skyMaterial.setVector4("moonFrame", new Vector4(0.00453, 0, 1, 0));
    this.skyMaterial.setVector3("moonRadiance", new Vector3(0, 0, 0));
    this.skyMaterial.setVector3("galacticPole", new Vector3(0, 1, 0));
    this.skyMaterial.setVector3("galacticCenter", new Vector3(0, -1, 0));
    this.skyMaterial.setFloat("nightSkyStrength", 0);
    this.sky.material = this.skyMaterial;

    this.sun = new DirectionalLight("sun", new Vector3(0.36, -0.82, -0.44), scene);
    this.sun.intensity = 5.2;
    this.sun.autoCalcShadowZBounds = false;
    this.ambient = new HemisphericLight("sky-ambient", Vector3.Up(), scene);
    this.ambient.intensity = 0.05;
    this.ambient.groundColor = new Color3(0.08, 0.09, 0.07);
    // 7-1: the moon as a SECOND directional light. Deliberately not a shadow
    // caster — a second cascade set would double the shadow row for a light
    // whose shadows are, at 0.25 lux, below the contrast a person can
    // resolve, and 7-9's night tier is where that trade is measured.
    this.moon = new DirectionalLight("moon", new Vector3(0, -1, 0), scene);
    this.moon.intensity = 0;
    this.moon.diffuse = new Color3(...MOONLIGHT_TINT);
    this.moon.specular = new Color3(...MOONLIGHT_TINT);
    this.moon.autoCalcShadowZBounds = false;

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
    // Fix-pack T8: cast depth from BACK faces. The 0.035 m normal bias is far
    // below a cascade texel's slope error on a mountainside (0.5–3 m texels at
    // the shipped map sizes), so lit steep faces self-shadowed into black
    // stripes at low sun. Recording the caster's far side instead removes
    // self-comparison on every lit face; residual acne moves to faces already
    // dark from N·L. Casters here are closed volumes (terrain heightfield
    // sheet, lofted aircraft, closed crown hulls), which is the case this
    // technique is standard for.
    this.shadows.forceBackFacesOnly = true;
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
      sunAngularRadiusRadians: DEFAULT_ENVIRONMENT_STATE.sun.angularRadiusRadians,
      cloudCoverage: 0.18,
      humidity: 0.5,
      windSpeed: 8,
      windDirection: new Vector2(
        Math.sin(windDirectionRadians),
        Math.cos(windDirectionRadians),
      ).normalize(),
      moonDirection: new Vector3(0, -1, 0),
      moonIlluminanceLux: 0,
      moonIlluminatedFraction: 0,
      adaptedLuminanceCdM2: adaptedLuminanceCdM2(DEFAULT_ENVIRONMENT_STATE),
      sceneKeyLuminanceCdM2: 1_000,
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
   * 7-3: the galactic frame in world axes, for the Milky Way band. It comes
   * from the star field's own sidereal matrix — one frame definition, two
   * consumers, so the band and the constellations cannot drift apart.
   */
  setGalacticFrame(
    pole: readonly [number, number, number],
    center: readonly [number, number, number],
  ): void {
    this.skyMaterial.setVector3("galacticPole", new Vector3(pole[0], pole[1], pole[2]));
    this.skyMaterial.setVector3("galacticCenter", new Vector3(center[0], center[1], center[2]));
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

  /**
   * R-26: publish the terrain surface system's seasonal mean linear albedo.
   * Both ground-bounce fakes this retires — `D-6`'s SH floor and `D-9`'s
   * palette row — were tuned against a ground that had no albedo at all; this
   * is the number that replaces them, and it moves with the season because a
   * snow-covered world bounces more than twice what a summer one does.
   */
  setSurfaceAlbedo(albedo: readonly [number, number, number]): void {
    this.surfaceAlbedo.set(
      Math.min(1, Math.max(0, albedo[0])),
      Math.min(1, Math.max(0, albedo[1])),
      Math.min(1, Math.max(0, albedo[2])),
    );
  }

  /** The published mean surface albedo, for the sky probe's below-horizon bake. */
  get surfaceAlbedoLuminance(): number {
    return 0.2126 * this.surfaceAlbedo.r
      + 0.7152 * this.surfaceAlbedo.g
      + 0.0722 * this.surfaceAlbedo.b;
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
  applyEnvironment(
    state: EnvironmentState,
    clock?: EnvironmentClock,
    latitudeDegrees = 45,
    deltaSeconds = 0,
  ): void {
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

    // 7-1: the moon, from the clock the environment director already
    // resolved the sun from. Without a clock (the constructor's default
    // state, and every Node test that predates Gate 7A) there is no moon.
    const moon = clock ? moonState(clock) : null;
    const moonDirection = moon
      ? this.moonWorldDirection(moon, clock!, latitudeDegrees)
      : new Vector3(0, -1, 0);
    const moonLux = moon ? moonIlluminanceLux(moon, Math.max(moonDirection.y, 0)) : 0;
    // Physical in every RELATIVE term — phase, opposition surge, altitude,
    // perigee distance — and normalised to the full-moon value, so only the
    // absolute level is art-directed (see MOON_PEAK_LIGHT_INTENSITY).
    //
    // §2.6 round M — the moon RECEDES through twilight (window consumer #6).
    // MOON_PEAK is calibrated so moonlit ground reads at NIGHT; carried into
    // civil twilight unwindowed it made the moon comparable to the entire
    // sky's ground irradiance, when a real 2.7-lux dusk sky swamps a
    // ≤0.25-lux moon ~10×. That warm directional was the cream tree-crown
    // defect (crown R/B 1.17 while the whole dome measured R/B 0.14) —
    // hidden while the rod path processed the warmth away, exposed when the
    // field-adaptation fix routed dusk through the raw path. Scaled HERE, at
    // the derivation, so the light and σ's moon term (which reads this same
    // variable below) recede together by construction; at and below the
    // release the factor is exactly 1 and every night quantity — including
    // the moon anchor's arithmetic — is byte-for-byte the shipped one.
    const moonIntensity = (moonLux / FULL_MOON_ILLUMINANCE_LUX)
      * MOON_PEAK_LIGHT_INTENSITY * overcastDimming
      * (1 - MOON_TWILIGHT_RECESSION * twilightArchStrength(state.sun.direction[1]));
    this.moon.direction.copyFrom(moonDirection).scaleInPlace(-1);
    this.moon.intensity = moonIntensity;

    // 1C-2: the ONE exposure curve. The relative-EV100 formula preserves the
    // day+clear look exactly; every private shader exposure is deleted. 7-2
    // reopened its ceiling — a derived constant now, not a magic 2.6.
    //
    // NIGHT_LOOK_ARCHITECTURE §2.1, Option B (Jason, 2026-09-01): the
    // twilight dip is keyed to SUN ELEVATION — golden hour bright and warm,
    // blue hour properly dark — with both endpoints pinned by the window's
    // shape (golden hour above it, the approved night-moonlit frame 0.11 of
    // sine below its release). Applied HERE, on the CPU, at the one exposure
    // site — assertion 29 still holds and exposureForState's own pins are
    // untouched (the dip is the consumer's, not the curve's).
    this.scene.imageProcessingConfiguration.exposure =
      exposureForState(state, moonLux)
      * twilightExposureDipFactor(state.sun.direction[1]);
    // 1C-6: IBL now carries the skylight. The hemispheric light survives
    // only as a small ground-bounce approximation, so skylight is not
    // double-counted; the snapshot's ambientColor keeps the old scale — it
    // describes sky-ambient radiance for shaders (clouds), not this light.
    //
    // 7-2 reopened the other constant the realignment named: this was an
    // unconditional 0.05 at every hour, so at 22:00 the ground bounce was
    // still a twentieth of a noon sky's — the same lift on a black sky that
    // it is on a blue one, which is precisely "night is dim daylight". It
    // follows the sky's own light now, and is EXACTLY 0.05 at the reference
    // day+clear key so daylight is unchanged.
    // §2.6(b): the floor is a NIGHT constant (fp16 range, rod input) that
    // twilight inherited by accident of max() — it is 10× the physical
    // skylight scale at sunset, so ambient flat-lined from late afternoon
    // to midnight while the dome fell three orders of magnitude. The arch
    // window cuts it through the blue hour only; outside the window the
    // factor is exactly 1 and this line is the shipped expression.
    const ambientIntensity =
      0.05 * Math.max(
        this.skylightScale(state, moonLux),
        NIGHT_AMBIENT_FLOOR_SCALE * twilightAmbientFloorFactor(state.sun.direction[1]),
      );
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
    // Wave Q: Babylon's light.specular defaults to WHITE and PBR ignores it,
    // but every StandardMaterial in the scene (instruments, markers) takes
    // its specular tint from it — at dusk they flared white under a red sun.
    this.sun.specular = palette.sunColor;
    this.sun.intensity = sunIntensity;
    this.ambient.diffuse = skyZenith;
    // R-26: the ground bounce is the sky's own horizon radiance reflected off
    // the surface system's mean albedo, not a palette row. At the reference
    // day+clear key this lands within ~0.03 of the retired row on red and
    // green; the blue it loses is the part that was never physical — ground
    // bounce cannot be bluer than the ground.
    this.ambient.groundColor = skyHorizon.multiply(this.surfaceAlbedo)
      .scale(GROUND_BOUNCE_CALIBRATION);
    this.ambient.intensity = ambientIntensity;

    // 7-1/7-3: the sky's night inputs.
    const nightStrength = Math.min(1, Math.max(0, (-sunDirection.y - 0.03) / 0.25));
    this.skyMaterial.setVector3("moonDirection", moonDirection);
    this.skyMaterial.setVector3("moonPhaseSunDirection", sunDirection);
    // 2.1: as the aerial source hands over to the moon, the SUN-disc branch
    // must not paint a 40x disc at the moon's position - the moon draws its
    // own disc. The probe capture's zeroing still composes (it multiplies
    // through the same uniform in onBeforeBind).
    this.skyMaterial.setFloat(
      "sunDiscVisibility",
      1 - aerialNightness(sunDirection.y),
    );
    this.skyMaterial.setVector4("moonFrame", new Vector4(
      moon?.angularRadiusRadians ?? 0.00453,
      moon?.illuminatedFraction ?? 0,
      (moon?.phaseAngleDegrees ?? 180) / 180,
      // Earthshine is brightest at new moon, because the Earth the dark limb
      // is lit by is then full — and the Earth is ~50× brighter in the
      // moon's sky than the moon is in ours.
      0.055 * (1 - (moon?.illuminatedFraction ?? 0)) ** 1.5,
    ));
    this.skyMaterial.setVector3(
      "moonRadiance",
      new Vector3(...MOONLIGHT_TINT).scaleInPlace(
        MOON_DISC_RADIANCE * Math.min(1, Math.max(0, moonDirection.y * 6 + 0.2)),
      ),
    );
    this.skyMaterial.setFloat("nightSkyStrength", nightStrength);

    // 7-2: bounded adaptation on the pinned clock. A scrub past dusk snaps
    // (deltaSeconds 0), which matches the 1C-6 probe's own "the sun is
    // static between scrubs" invariant and keeps the capture deterministic.
    // 7-2: the SCENE's own key luminance, in the same units the rod response
    // will read pixels in. Lambertian ground under the frame's actual lights
    // — this is what σ has to be, because the buffer is not photometrically
    // scaled at night (see ScotopicState.adaptedLuminanceCdM2).
    //
    // §2.6: the twilight arch is part of the frame's actual light — the IBL
    // probe integrates it onto every material — so σ must count it or the
    // rod response re-exposes the frame around a key that is smaller than
    // the scene (round 1 measured that: terrain up 2.1×, sky up 5.9×).
    // TWILIGHT_ARCH_KEY_FACTOR is the closed-form Lambertian irradiance of
    // the arch's gradient (E/π); the term is exactly zero outside the
    // window, so day and night σ are bit-identical by construction.
    const archRadiance = twilightArchRadiance(state.sun.direction[1]);
    const archKeyIntensity = TWILIGHT_ARCH_KEY_FACTOR
      * (0.2126 * archRadiance[0] + 0.7152 * archRadiance[1] + 0.0722 * archRadiance[2]);
    const sceneKeyLuminance = ((sunIntensity * Math.max(sunDirection.y, 0)
      + moonIntensity * Math.max(moonDirection.y, 0)
      + ambientIntensity
      + archKeyIntensity)
      * state.atmosphere.groundAlbedo[1]) / Math.PI;

    const adaptationTarget = adaptedLuminanceCdM2(state, moonLux);
    const adapted = deltaSeconds > 0
      ? adaptLuminance(this.snapshotValue.adaptedLuminanceCdM2, adaptationTarget, deltaSeconds)
      : adaptationTarget;

    this.snapshotValue = {
      sunDirection: sunDirection.clone(),
      sunColor: palette.sunColor.clone(),
      sunIntensity,
      skyZenith: skyZenith.clone(),
      skyHorizon: skyHorizon.clone(),
      ambientColor: Color3.Lerp(skyZenith, skyHorizon, 0.28).scale(snapshotAmbientScale),
      sunIlluminanceNormalized: sunIntensity / PEAK_SUN_INTENSITY,
      sunAngularRadiusRadians: state.sun.angularRadiusRadians,
      cloudCoverage,
      humidity,
      windSpeed,
      windDirection: this.snapshotValue.windDirection.clone(),
      moonDirection: moonDirection.clone(),
      moonIlluminanceLux: moonLux,
      moonIlluminatedFraction: moon?.illuminatedFraction ?? 0,
      adaptedLuminanceCdM2: adapted,
      sceneKeyLuminanceCdM2: Math.max(sceneKeyLuminance * SCENE_UNIT_TO_NITS, 1e-4),
    };
  }

  /**
   * The moon's equatorial position, put into world axes by the SAME sidereal
   * matrix the star field uses — so the moon sits among the constellations
   * it is actually among, and one frame definition serves both.
   */
  private moonWorldDirection(
    moon: MoonState,
    clock: EnvironmentClock,
    latitudeDegrees: number,
  ): Vector3 {
    const rows = equatorialToWorldRows(localSiderealTimeHours(clock), latitudeDegrees);
    const equatorial = equatorialUnitVector(
      moon.rightAscensionHours,
      moon.declinationDegrees,
    );
    const world = equatorialToWorld(equatorial, rows);
    return new Vector3(world[0], world[1], world[2]).normalize();
  }

  /**
   * Skylight relative to the reference day+clear key — the factor the
   * hemispheric ground bounce scales by. Exactly 1 at the reference, so the
   * daylight look is bit-identical; at 22:00 with no moon it is ~10⁻⁵, which
   * is the point.
   */
  private skylightScale(state: EnvironmentState, moonLux: number): number {
    const overcast = 1 - state.weather.cloudCoverage * 0.42;
    return Math.min(
      1.6,
      (horizontalIlluminanceLux(state, moonLux) * overcast) / REFERENCE_ILLUMINANCE_LUX,
    );
  }

  update(cameraLocalPosition: Vector3): void {
    this.sky.position.copyFrom(cameraLocalPosition);
  }

  dispose(): void {
    this.shadows.dispose();
    this.sun.dispose();
    this.moon.dispose();
    this.ambient.dispose();
    this.sky.dispose(false, false);
    this.skyMaterial.dispose(true, true);
  }
}
