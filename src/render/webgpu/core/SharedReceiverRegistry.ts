import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";

interface RegisteredReceiver<TPlugin> {
  readonly material: PBRMaterial;
  readonly plugin: TPlugin;
  readonly removeDisposeObserver: () => void;
}

/**
 * Shared-GPU-resource receiver plumbing (0-7): one shared resource, many PBR
 * materials, one resolved floating-origin binding per projection update,
 * clean registration and disposal.
 *
 * Three subsystems need exactly this shape — cloud shadows (built), the
 * aerial-perspective include (1C-4), and the sky environment probe (1C-6) —
 * and Phase 7's clustered lighting would have been a fourth. This base class
 * is the one implementation of the pattern; subsystems supply their
 * projection/binding types, the plugin they attach, and eligibility rules.
 *
 * Ownership notes the pattern encodes:
 * - The material owns its plugin. Registration attaches one (through the
 *   plugin's own constructor, per Babylon's plugin-manager contract); material
 *   disposal only releases the registry's references.
 * - A material that already carries a plugin of the subsystem's name is
 *   respected, not double-wrapped (terrain installs its own specialized
 *   plugins directly).
 * - `setProjection` resolves absolute projection metadata into one local
 *   binding, then fans it out over the small fixed material set — never over
 *   meshes, instances, or world pages.
 */
export abstract class SharedReceiverRegistry<
  TProjection,
  TBinding,
  TPlugin extends MaterialPluginBase,
> {
  private readonly receivers = new Map<PBRMaterial, RegisteredReceiver<TPlugin>>();
  private projection: TProjection | null = null;
  private binding: TBinding | null = null;
  private disposed = false;

  get registeredMaterialCount(): number {
    return this.receivers.size;
  }

  get currentBinding(): TBinding | null {
    return this.binding;
  }

  /** Registers one eligible material. Duplicate or ineligible calls are no-ops. */
  registerMaterial(material: PBRMaterial): boolean {
    if (this.disposed || this.receivers.has(material)) return false;
    if (!this.isEligibleMaterial(material)) return false;
    // Respect an explicitly installed receiver rather than creating two
    // plugins with the same name.
    if (material.pluginManager?.getPlugin(this.pluginName)) {
      return false;
    }

    const plugin = this.createPlugin(material);
    const disposeObserver = material.onDisposeObservable.add(() => {
      // The material owns and disposes its plugin. Only release our references
      // here; touching plugin defines while its parent is disposing is unsafe.
      this.receivers.delete(material);
    });
    const receiver: RegisteredReceiver<TPlugin> = {
      material,
      plugin,
      removeDisposeObserver: () => disposeObserver.remove(),
    };
    this.receivers.set(material, receiver);
    if (this.projection !== null && this.binding !== null) {
      this.applyProjection(plugin, this.projection, this.binding);
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
   * Resolves absolute projection metadata once per update — including across a
   * floating-origin shift — and shares the one binding with every receiver.
   */
  setProjection(
    projection: TProjection,
    floatingOriginX: number,
    floatingOriginZ: number,
  ): void {
    if (this.disposed) return;
    const binding = this.resolveBinding(projection, floatingOriginX, floatingOriginZ);
    this.projection = projection;
    this.binding = binding;
    for (const receiver of this.receivers.values()) {
      this.applyProjection(receiver.plugin, projection, binding);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const receiver of this.receivers.values()) {
      receiver.removeDisposeObserver();
      this.clearPlugin(receiver.plugin);
    }
    this.receivers.clear();
    this.projection = null;
    this.binding = null;
  }

  /** The plugin-manager name this registry's plugins register under. */
  protected abstract get pluginName(): string;

  /** Whether the shared resource is appropriate for this material at all. */
  protected abstract isEligibleMaterial(material: PBRMaterial): boolean;

  /**
   * Attach the subsystem's plugin to the material and return it. Attachment
   * happens inside the plugin's MaterialPluginBase constructor.
   */
  protected abstract createPlugin(material: PBRMaterial): TPlugin;

  /** Resolve the projection into one floating-origin-local binding. */
  protected abstract resolveBinding(
    projection: TProjection,
    floatingOriginX: number,
    floatingOriginZ: number,
  ): TBinding;

  /** Push an already-resolved projection/binding pair into one plugin. */
  protected abstract applyProjection(
    plugin: TPlugin,
    projection: TProjection,
    binding: TBinding,
  ): void;

  /** Detach the shared resource from one plugin during registry disposal. */
  protected abstract clearPlugin(plugin: TPlugin): void;
}
