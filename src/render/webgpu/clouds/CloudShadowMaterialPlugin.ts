import { Constants } from "@babylonjs/core/Engines/constants";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { Scene } from "@babylonjs/core/scene";
import {
  CLOUD_SHADOW_RECEIVER_FUNCTION_WGSL,
  CLOUD_SHADOW_RECEIVER_SAMPLER,
  resolveCloudShadowReceiverBinding,
  type CloudShadowProjection,
  type CloudShadowReceiverBinding,
} from "./CloudShadowReceiver";

/**
 * Z-1: one shared 1×1 full-transmittance texture per scene, bound whenever a
 * receiver has no live projection. The plugin used to stay disabled until the
 * first projection arrived and `_enable(true)` mid-run; materials created
 * after startup (streamed detail prototypes) then drew through a freshly
 * compiled effect before their first bind, and Babylon logged
 * `Texture "cloudShadowSampler" not found` — 36 lines per capture. With a
 * fallback always bound and the plugin enabled from construction, the window
 * does not exist and no mid-flight define churn recompiles receiver shaders.
 */
const FALLBACK_TEXTURES = new WeakMap<Scene, RawTexture>();

function fallbackCloudShadowTexture(scene: Scene): RawTexture {
  // The scene-dispose observer below clears the cache entry, so a cached
  // texture is always live.
  const existing = FALLBACK_TEXTURES.get(scene);
  if (existing) return existing;
  const texture = new RawTexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    Constants.TEXTUREFORMAT_RGBA,
    scene,
    false,
    false,
    Constants.TEXTURE_NEAREST_SAMPLINGMODE,
  );
  texture.name = "cloud-shadow-fallback";
  FALLBACK_TEXTURES.set(scene, texture);
  scene.onDisposeObservable.addOnce(() => {
    texture.dispose();
    FALLBACK_TEXTURES.delete(scene);
  });
  return texture;
}

export const CLOUD_SHADOW_PBR_FRAGMENT_WGSL = Object.freeze({
  CUSTOM_FRAGMENT_DEFINITIONS: CLOUD_SHADOW_RECEIVER_FUNCTION_WGSL,
  CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: /* wgsl */ `
#ifndef UNLIT
let aerolithCloudShadow = sampleCloudShadowReceiver(fragmentInputs.vPositionW);
finalDiffuse *= aerolithCloudShadow;
#ifdef SPECULARTERM
finalSpecularScaled *= aerolithCloudShadow;
#endif
#ifdef SHEEN
finalSheenScaled *= aerolithCloudShadow;
#endif
#ifdef CLEARCOAT
finalClearCoatScaled *= aerolithCloudShadow;
#endif
#endif
`,
});

export const CLOUD_SHADOW_PBR_FRAGMENT_GLSL = Object.freeze({
  CUSTOM_FRAGMENT_DEFINITIONS: /* glsl */ `
uniform sampler2D cloudShadowSampler;

float sampleCloudShadowReceiver(vec3 localWorldPosition) {
  if (cloudShadowReceiverValid < 0.5 || cloudShadowSunDirection.y <= 0.0001) {
    return 1.0;
  }
  float heightAboveReference = localWorldPosition.y - cloudShadowReferenceAltitude;
  float inverseSunHeight = heightAboveReference / cloudShadowSunDirection.y;
  vec2 referencePosition = localWorldPosition.xz
    - cloudShadowSunDirection.xz * inverseSunHeight;
  vec2 shadowUv = (referencePosition - cloudShadowCenterLocal)
    / cloudShadowWorldSize + vec2(0.5);
  if (any(lessThan(shadowUv, vec2(0.0))) || any(greaterThan(shadowUv, vec2(1.0)))) {
    return 1.0;
  }
  float edgeDistance = min(
    min(shadowUv.x, shadowUv.y),
    min(1.0 - shadowUv.x, 1.0 - shadowUv.y)
  );
  float edgeWeight = smoothstep(0.0, 0.025, edgeDistance);
  float transmittance = texture2D(cloudShadowSampler, shadowUv).r;
  return mix(1.0, clamp(transmittance, 0.0, 1.0), cloudShadowStrength * edgeWeight);
}
`,
  CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: /* glsl */ `
#ifndef UNLIT
float aerolithCloudShadow = sampleCloudShadowReceiver(vPositionW);
finalDiffuse *= aerolithCloudShadow;
#ifdef SPECULARTERM
finalSpecularScaled *= aerolithCloudShadow;
#endif
#ifdef SHEEN
finalSheenScaled *= aerolithCloudShadow;
#endif
#ifdef CLEARCOAT
finalClearCoatScaled *= aerolithCloudShadow;
#endif
#endif
`,
});

export const CLOUD_SHADOW_MATERIAL_PLUGIN_NAME = "cloud-shadow-receiver";

/** Applies the cloud transmittance projection to only the PBR material's direct terms. */
export class CloudShadowMaterialPlugin extends MaterialPluginBase {
  private projection: CloudShadowProjection | null = null;
  private binding: CloudShadowReceiverBinding | null = null;
  private readonly fallbackTexture: RawTexture;

  constructor(material: PBRMaterial) {
    super(
      material,
      CLOUD_SHADOW_MATERIAL_PLUGIN_NAME,
      210,
      undefined,
      true,
      false,
    );
    this.doNotSerialize = true;
    // Enabled from construction: the sampler is present in the material's
    // very first effect, bound to the fallback until a projection arrives,
    // and the WGSL's `cloudShadowReceiverValid < 0.5` guard makes the
    // projection-less state an exact multiply-by-one.
    this.fallbackTexture = fallbackCloudShadowTexture(material.getScene());
    // Z-1: binding happens in hardBindForSubMesh (which requires this flag).
    this.registerForExtraEvents = true;
    this._enable(true);
  }

  override getClassName(): string {
    return "CloudShadowMaterialPlugin";
  }

  override isCompatible(): boolean {
    return true;
  }

  setProjection(
    projection: CloudShadowProjection,
    floatingOriginX: number,
    floatingOriginZ: number,
  ): void {
    this.setResolvedProjection(
      projection,
      resolveCloudShadowReceiverBinding(
        projection,
        floatingOriginX,
        floatingOriginZ,
      ),
    );
  }

  /**
   * Publishes a pre-resolved binding. A registry can therefore resolve the
   * absolute projection once and share the immutable result across every PBR
   * receiver material instead of repeating floating-origin math per material.
   * No define churn: the shader code is present from the first compile.
   */
  setResolvedProjection(
    projection: CloudShadowProjection,
    binding: CloudShadowReceiverBinding,
  ): void {
    this.projection = projection;
    this.binding = binding;
  }

  /** Releases registry-held projection references (shading falls back to 1.0). */
  clearProjection(): void {
    this.projection = null;
    this.binding = null;
  }

  override hasTexture(texture: BaseTexture): boolean {
    return this.projection?.texture === texture;
  }

  override getActiveTextures(activeTextures: BaseTexture[]): void {
    if (this.projection) activeTextures.push(this.projection.texture);
  }

  override getSamplers(samplers: string[]): void {
    samplers.push(CLOUD_SHADOW_RECEIVER_SAMPLER);
  }

  override getUniforms(): {
    ubo: Array<{ name: string; size: number; type: string }>;
  } {
    return {
      ubo: [
        { name: "cloudShadowCenterLocal", size: 2, type: "vec2" },
        { name: "cloudShadowWorldSize", size: 1, type: "float" },
        { name: "cloudShadowReferenceAltitude", size: 1, type: "float" },
        { name: "cloudShadowSunDirection", size: 3, type: "vec3" },
        { name: "cloudShadowReceiverValid", size: 1, type: "float" },
        { name: "cloudShadowStrength", size: 1, type: "float" },
      ],
    };
  }

  /**
   * Z-1: bound through hardBindForSubMesh, not bindForSubMesh. The receiver
   * materials are shared by many meshes; a plain bindForSubMesh is skipped
   * for every mesh after the first under `mustRebind === false`, and on
   * WebGPU each submesh draws through its OWN material context — the skipped
   * binds left those contexts without the sampler and Babylon logged
   * `Texture "cloudShadowSampler" not found` on their first frame. Babylon's
   * decal plugin documents this exact hook for this exact reason.
   */
  override hardBindForSubMesh(uniformBuffer: UniformBuffer): void {
    const projection = this.projection;
    const binding = this.binding;
    if (!projection || !binding) {
      // The sampler must never be unbound (Z-1); valid=0 short-circuits the
      // WGSL to an exact multiply-by-one.
      uniformBuffer.setTexture(CLOUD_SHADOW_RECEIVER_SAMPLER, this.fallbackTexture);
      uniformBuffer.updateFloat("cloudShadowReceiverValid", 0);
      return;
    }
    uniformBuffer.setTexture(CLOUD_SHADOW_RECEIVER_SAMPLER, projection.texture);
    uniformBuffer.updateFloat2(
      "cloudShadowCenterLocal",
      binding.centerLocalX,
      binding.centerLocalZ,
    );
    uniformBuffer.updateFloat("cloudShadowWorldSize", binding.worldSizeMeters);
    uniformBuffer.updateFloat(
      "cloudShadowReferenceAltitude",
      binding.referenceAltitudeMeters,
    );
    uniformBuffer.updateFloat3(
      "cloudShadowSunDirection",
      binding.sunDirectionX,
      binding.sunDirectionY,
      binding.sunDirectionZ,
    );
    uniformBuffer.updateFloat("cloudShadowReceiverValid", binding.valid ? 1 : 0);
    uniformBuffer.updateFloat("cloudShadowStrength", binding.strength);
  }

  override getCustomCode(
    shaderType: string,
    shaderLanguage = ShaderLanguage.GLSL,
  ): { [pointName: string]: string } | null {
    if (shaderType !== "fragment") return null;
    return shaderLanguage === ShaderLanguage.WGSL
      ? CLOUD_SHADOW_PBR_FRAGMENT_WGSL
      : CLOUD_SHADOW_PBR_FRAGMENT_GLSL;
  }
}
