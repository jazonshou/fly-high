import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
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

interface RegisteredReceiver {
  readonly material: PBRMaterial;
  readonly plugin: CloudShadowMaterialPlugin;
  readonly removeDisposeObserver: () => void;
}

/**
 * Cloud shadows are inappropriate for transparent glass and self-lit surfaces:
 * both should remain optically/emissively independent from direct sunlight.
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
 */
export class CloudShadowReceiverRegistry {
  private readonly receivers = new Map<PBRMaterial, RegisteredReceiver>();
  private projection: CloudShadowProjection | null = null;
  private binding: CloudShadowReceiverBinding | null = null;
  private disposed = false;

  get registeredMaterialCount(): number {
    return this.receivers.size;
  }

  get currentBinding(): CloudShadowReceiverBinding | null {
    return this.binding;
  }

  /** Registers one eligible material. Duplicate or ineligible calls are no-ops. */
  registerMaterial(material: PBRMaterial): boolean {
    if (this.disposed || this.receivers.has(material)) return false;
    if (!isOpaqueCloudShadowPbrReceiver(material)) return false;
    // Respect an explicitly installed receiver (terrain owns its specialized
    // plugin directly) rather than creating two plugins with the same name.
    if (material.pluginManager?.getPlugin(CLOUD_SHADOW_MATERIAL_PLUGIN_NAME)) {
      return false;
    }

    const plugin = new CloudShadowMaterialPlugin(material);
    const disposeObserver = material.onDisposeObservable.add(() => {
      // The material owns and disposes its plugin. Only release our references
      // here; touching plugin defines while its parent is disposing is unsafe.
      this.receivers.delete(material);
    });
    const receiver: RegisteredReceiver = {
      material,
      plugin,
      removeDisposeObserver: () => disposeObserver.remove(),
    };
    this.receivers.set(material, receiver);
    if (this.projection && this.binding) {
      plugin.setResolvedProjection(this.projection, this.binding);
    }
    return true;
  }

  /** Registers unique PBR materials referenced by a mesh collection. */
  registerMeshes(meshes: Iterable<AbstractMesh>): number {
    let registered = 0;
    for (const mesh of meshes) {
      if (mesh.material instanceof PBRMaterial && this.registerMaterial(mesh.material)) {
        registered += 1;
      }
    }
    return registered;
  }

  /** Registers a material collection without allocating mesh-level state. */
  registerMaterials(materials: Iterable<PBRMaterial>): number {
    let registered = 0;
    for (const material of materials) {
      if (this.registerMaterial(material)) registered += 1;
    }
    return registered;
  }

  /**
   * Resolves absolute projection metadata once per frame. The remaining loop is
   * over the small, fixed material set—not meshes, instances, or world pages.
   */
  setProjection(
    projection: CloudShadowProjection,
    floatingOriginX: number,
    floatingOriginZ: number,
  ): void {
    if (this.disposed) return;
    const binding = resolveCloudShadowReceiverBinding(
      projection,
      floatingOriginX,
      floatingOriginZ,
    );
    this.projection = projection;
    this.binding = binding;
    for (const receiver of this.receivers.values()) {
      receiver.plugin.setResolvedProjection(projection, binding);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const receiver of this.receivers.values()) {
      receiver.removeDisposeObserver();
      receiver.plugin.clearProjection();
    }
    this.receivers.clear();
    this.projection = null;
    this.binding = null;
  }
}
