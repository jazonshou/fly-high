import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { ProceduralTexture } from "@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture.pure";
import type { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { DepthRenderer } from "@babylonjs/core/Rendering/depthRenderer";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";
import {
  DEFAULT_ENVIRONMENT_STATE,
} from "@/src/render/webgpu/nature/EnvironmentState";
import {
  bakeTransmittanceLut,
  TRANSMITTANCE_LUT_HEIGHT,
  TRANSMITTANCE_LUT_WIDTH,
} from "./AtmosphereLuts";
import {
  AERIAL_PERSPECTIVE_UNIFORMS,
  AERIAL_PERSPECTIVE_WGSL,
  applyAerialPerspectiveToShaderMaterial,
  type AerialPerspectiveBinding,
} from "./AerialPerspective";
import { BLUE_NOISE_SIZE, generateBlueNoiseTile } from "./blueNoise";

/**
 * Atmosphere GPU resources (2-0a, R-18 — owner: lighting).
 *
 * INVARIANT THIS FILE OWNS: every GPU resource the adopted cloud shader
 * requires that the atmosphere is the truth source for — the transmittance
 * LUT texture (deviation D-4 kept the bake CPU-side; this is its first GPU
 * upload), the sky ambient LUT (the same `skyRadiance` integral the sky dome
 * and IBL use, evaluated into a small table), the blue-noise jitter tile,
 * and the scene depth the ray march clips against — has exactly one
 * definition site, here.
 *
 * Deviations from the R-18 wording, recorded in the decision log:
 * - The "sky-view LUT" is an (elevation × sun-relative azimuth) table baked
 *   per environment change, matching how the cloud march actually consumes
 *   ambient; a full Hillaire sky-view LUT would duplicate the sky dome's
 *   closed form for no additional consumer.
 * - The multiple-scattering LUT stays CPU-only: no shader binds it today,
 *   and uploading an unread texture is the dead-code habit this programme
 *   is correcting.
 */

export const SKY_AMBIENT_LUT_WIDTH = 64;
export const SKY_AMBIENT_LUT_HEIGHT = 32;

/**
 * One texel = sky radiance for a view direction at elevation `u·2−1` and
 * horizontal azimuth `v·2π` relative to the sun, using the shared aerial
 * perspective integral — the identical closed form the sky dome renders and
 * the IBL bakes, so the cloud ambient cannot drift from the sky it sits in.
 */
const SKY_AMBIENT_FRAGMENT_WGSL = /* wgsl */ `
varying vUV: vec2f;

${AERIAL_PERSPECTIVE_WGSL}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let view_elevation = clamp(input.vUV.x * 2.0 - 1.0, -1.0, 1.0);
  let relative_azimuth = input.vUV.y * 2.0 * AERIAL_PI;
  let horizontal = sqrt(max(1.0 - view_elevation * view_elevation, 0.0));
  let sun = uniforms.aerialSunDirection;
  let sun_horizontal = normalize(select(
    vec2f(1.0, 0.0),
    sun.xz,
    dot(sun.xz, sun.xz) > 1e-8,
  ));
  let sun_tangent = vec2f(-sun_horizontal.y, sun_horizontal.x);
  let azimuth_direction = sun_horizontal * cos(relative_azimuth)
    + sun_tangent * sin(relative_azimuth);
  let direction = vec3f(
    azimuth_direction.x * horizontal,
    view_elevation,
    azimuth_direction.y * horizontal,
  );
  fragmentOutputs.color = vec4f(skyRadiance(direction), 1.0);
}
`;

/** IEEE 754 float32 → float16 bits (round-to-nearest-even is unnecessary here). */
export function floatToHalf(value: number): number {
  const floatView = new Float32Array(1);
  const intView = new Uint32Array(floatView.buffer);
  floatView[0] = value;
  const bits = intView[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  let mantissa = bits & 0x7f_ffff;
  if (exponent <= 0) return sign; // flush denormals to signed zero
  if (exponent >= 31) return sign | 0x7c00; // overflow to infinity
  mantissa >>= 13;
  return sign | (exponent << 10) | mantissa;
}

function halfFloatQuad(data: Float32Array): Uint16Array {
  const halves = new Uint16Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    halves[index] = floatToHalf(data[index]!);
  }
  return halves;
}

/** Owns the atmosphere-truth GPU textures the cloud pipeline binds. */
export class AtmosphereGpuResources {
  readonly transmittanceLut: RawTexture;
  readonly blueNoise: RawTexture;
  readonly skyAmbientLut: ProceduralTexture;
  private readonly depthRenderer: DepthRenderer;
  private disposed = false;

  constructor(
    private readonly scene: Scene,
    camera: Camera,
    excludedFromDepth: (mesh: AbstractMesh) => boolean,
  ) {
    // D-4's first GPU upload: the CPU bake is the tested truth; the texture
    // is a verbatim rgba16float copy of it, uploaded once (the atmosphere
    // coefficients are runtime constants — turbidity rides the uniforms).
    const baked = bakeTransmittanceLut(DEFAULT_ENVIRONMENT_STATE.atmosphere);
    this.transmittanceLut = new RawTexture(
      halfFloatQuad(baked.data),
      baked.width,
      baked.height,
      Constants.TEXTUREFORMAT_RGBA,
      scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE,
      Constants.TEXTURETYPE_HALF_FLOAT,
    );
    this.transmittanceLut.name = "atmosphere-transmittance-lut";
    this.transmittanceLut.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.transmittanceLut.wrapV = Texture.CLAMP_ADDRESSMODE;
    if (
      baked.width !== TRANSMITTANCE_LUT_WIDTH
      || baked.height !== TRANSMITTANCE_LUT_HEIGHT
    ) {
      throw new RangeError("Transmittance LUT bake does not match its declared size");
    }

    this.blueNoise = new RawTexture(
      generateBlueNoiseTile(),
      BLUE_NOISE_SIZE,
      BLUE_NOISE_SIZE,
      Constants.TEXTUREFORMAT_R,
      scene,
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    this.blueNoise.name = "cloud-blue-noise";
    this.blueNoise.wrapU = Texture.WRAP_ADDRESSMODE;
    this.blueNoise.wrapV = Texture.WRAP_ADDRESSMODE;

    this.skyAmbientLut = new ProceduralTexture(
      "sky-ambient-lut",
      { width: SKY_AMBIENT_LUT_WIDTH, height: SKY_AMBIENT_LUT_HEIGHT },
      { fragmentSource: SKY_AMBIENT_FRAGMENT_WGSL },
      scene,
      {
        shaderLanguage: ShaderLanguage.WGSL,
        type: Constants.TEXTURETYPE_HALF_FLOAT,
        format: Constants.TEXTUREFORMAT_RGBA,
        samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
        generateDepthBuffer: false,
        generateStencilBuffer: false,
        generateMipMaps: false,
        gammaSpace: false,
        skipSceneRegistration: true,
      },
      false,
      false,
      Constants.TEXTURETYPE_HALF_FLOAT,
    );
    // Rendered manually: once at warm-up (the cloud startup barrier) and once
    // per environment change from update().
    this.skyAmbientLut.refreshRate = -1;
    this.skyAmbientLut.autoClear = false;
    this.skyAmbientLut.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.skyAmbientLut.wrapV = Texture.WRAP_ADDRESSMODE;

    // The march clips against real scene depth (R-18): a dedicated depth
    // pass over the opaque scene storing CAMERA-SPACE Z in metres (clear
    // value 0 = sky, unambiguous). Sky, shells and other non-occluders are
    // excluded through the caller's predicate.
    this.depthRenderer = new DepthRenderer(
      scene,
      Constants.TEXTURETYPE_FLOAT,
      camera,
      false,
      Texture.NEAREST_SAMPLINGMODE,
      true,
      "cloud-scene-depth",
    );
    const depthMap = this.depthRenderer.getDepthMap();
    depthMap.renderListPredicate = (mesh) => !excludedFromDepth(mesh);
    scene.customRenderTargets.push(depthMap);
  }

  get sceneDepth(): RenderTargetTexture {
    return this.depthRenderer.getDepthMap();
  }

  /** Re-bake the sky ambient LUT for a new environment binding. */
  update(binding: AerialPerspectiveBinding): void {
    if (this.disposed) return;
    applyAerialPerspectiveToShaderMaterial(
      {
        setFloat: (name, value) => this.skyAmbientLut.setFloat(name, value),
      },
      binding,
      (name, x, y, z) => {
        this.skyAmbientLut.setVector3(name, new Vector3(x, y, z));
      },
      (name, x, y, z, w) => {
        this.skyAmbientLut.setVector4(name, new Vector4(x, y, z, w));
      },
    );
    if (this.skyAmbientLut.isReady()) this.skyAmbientLut.render();
  }

  /** Renders the ambient LUT once it can (the cloud startup barrier calls this). */
  warm(): boolean {
    if (this.disposed || !this.skyAmbientLut.isReady()) return false;
    if (this.skyAmbientLut.getInternalTexture() == null) this.skyAmbientLut.render();
    return this.skyAmbientLut.getInternalTexture() != null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const depthMap = this.depthRenderer.getDepthMap();
    const index = this.scene.customRenderTargets.indexOf(depthMap);
    if (index >= 0) this.scene.customRenderTargets.splice(index, 1);
    this.depthRenderer.dispose();
    this.transmittanceLut.dispose();
    this.blueNoise.dispose();
    this.skyAmbientLut.dispose();
  }
}

export { AERIAL_PERSPECTIVE_UNIFORMS };
