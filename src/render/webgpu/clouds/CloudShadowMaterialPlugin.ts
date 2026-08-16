import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import {
  CLOUD_SHADOW_RECEIVER_FUNCTION_WGSL,
  CLOUD_SHADOW_RECEIVER_SAMPLER,
  resolveCloudShadowReceiverBinding,
  type CloudShadowProjection,
  type CloudShadowReceiverBinding,
} from "./CloudShadowReceiver";

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
  private active = false;

  constructor(material: PBRMaterial) {
    // Stay inactive until a real texture is supplied so isolated terrain tools
    // do not compile a shader with an unbound sampler.
    super(
      material,
      CLOUD_SHADOW_MATERIAL_PLUGIN_NAME,
      210,
      undefined,
      true,
      false,
    );
    this.doNotSerialize = true;
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
   */
  setResolvedProjection(
    projection: CloudShadowProjection,
    binding: CloudShadowReceiverBinding,
  ): void {
    this.projection = projection;
    this.binding = binding;
    if (this.active) return;
    this.active = true;
    this._enable(true);
    this.markAllDefinesAsDirty();
  }

  /** Releases registry-held projection references and removes shader work. */
  clearProjection(): void {
    this.projection = null;
    this.binding = null;
    if (!this.active) return;
    this.active = false;
    this._enable(false);
    this.markAllDefinesAsDirty();
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

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    const projection = this.projection;
    const binding = this.binding;
    if (!projection || !binding) return;
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
