import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { SharedReceiverRegistry } from "@/src/render/webgpu/core/SharedReceiverRegistry";
import {
  CLOUD_SHADOW_MATERIAL_PLUGIN_NAME,
  CloudShadowMaterialPlugin,
} from "./CloudShadowMaterialPlugin";
import {
  resolveCloudShadowReceiverBinding,
  type CloudShadowProjection,
  type CloudShadowReceiverBinding,
} from "./CloudShadowReceiver";

const MATERIAL_VISIBILITY_EPSILON = 1e-4;

/**
 * Cloud shadows are inappropriate for transparent glass and self-lit surfaces:
 * both should remain optically/emissively independent from direct sunlight.
 * Alpha-TESTED materials stay eligible (2-12): a surviving fragment is fully
 * opaque — the mode only moves the draw after the opaque bucket (R-2E), and
 * a canopy that failed to darken under a cloud bank would be glaring.
 */
export function isOpaqueCloudShadowPbrReceiver(material: PBRMaterial): boolean {
  if (material.unlit) return false;
  if (!Number.isFinite(material.alpha) || material.alpha < 1 - MATERIAL_VISIBILITY_EPSILON) {
    return false;
  }
  const transparencyMode = material.transparencyMode;
  if (
    transparencyMode !== null
    && transparencyMode !== PBRMaterial.PBRMATERIAL_OPAQUE
    && transparencyMode !== PBRMaterial.PBRMATERIAL_ALPHATEST
  ) {
    return false;
  }
  const emissiveColor = material.emissiveColor;
  const hasEmissiveColor = Math.max(
    emissiveColor.r,
    emissiveColor.g,
    emissiveColor.b,
  ) > MATERIAL_VISIBILITY_EPSILON;
  const hasActiveEmission = material.emissiveIntensity > MATERIAL_VISIBILITY_EPSILON
    && (hasEmissiveColor || material.emissiveTexture !== null);
  return !hasActiveEmission;
}

/**
 * Owns the small set of opaque PBR cloud-shadow plugins used by natural scene
 * materials. Materials are registered once; the renderer publishes one world
 * projection update and this registry shares its one resolved floating-origin
 * binding across all materials. Thin instances therefore add no CPU work.
 *
 * Built on SharedReceiverRegistry (0-7): the registration, projection fan-out
 * and disposal plumbing is the shared pattern; this class supplies only the
 * cloud-shadow specifics.
 */
export class CloudShadowReceiverRegistry extends SharedReceiverRegistry<
  CloudShadowProjection,
  CloudShadowReceiverBinding,
  CloudShadowMaterialPlugin
> {
  protected get pluginName(): string {
    return CLOUD_SHADOW_MATERIAL_PLUGIN_NAME;
  }

  protected isEligibleMaterial(material: PBRMaterial): boolean {
    return isOpaqueCloudShadowPbrReceiver(material);
  }

  protected createPlugin(material: PBRMaterial): CloudShadowMaterialPlugin {
    return new CloudShadowMaterialPlugin(material);
  }

  protected resolveBinding(
    projection: CloudShadowProjection,
    floatingOriginX: number,
    floatingOriginZ: number,
  ): CloudShadowReceiverBinding {
    return resolveCloudShadowReceiverBinding(projection, floatingOriginX, floatingOriginZ);
  }

  protected applyProjection(
    plugin: CloudShadowMaterialPlugin,
    projection: CloudShadowProjection,
    binding: CloudShadowReceiverBinding,
  ): void {
    plugin.setResolvedProjection(projection, binding);
  }

  protected clearPlugin(plugin: CloudShadowMaterialPlugin): void {
    plugin.clearProjection();
  }
}
