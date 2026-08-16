import * as THREE from "three";
import { CSM } from "three/addons/csm/CSM.js";
import type { QualityLevel } from "@/src/game/types";
import type { RenderingMode } from "@/src/settings";

/** Layer 0 remains the normal atmosphere layer. CSM directionals live here. */
export const DEFAULT_CSM_LAYER = 29;

export interface CascadedShadowBudget {
  readonly cascades: 2 | 3;
  readonly shadowMapSize: number;
  readonly maxFar: number;
  readonly lightFar: number;
  readonly lightMargin: number;
  readonly shadowBias: number;
  readonly normalBias: number;
  readonly shadowRadius: number;
  readonly fade: boolean;
}

export type CascadedShadowCasterPredicate = (mesh: THREE.Mesh) => boolean;

export interface CascadedShadowControllerOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sunSource: THREE.DirectionalLight;
  quality?: QualityLevel;
  renderingMode?: RenderingMode;
  layer?: number;
  shadowCastingEnabled?: boolean;
  /** Only controls shadow-map casting. All built-in lit materials still receive the CSM hook. */
  castShadowPredicate?: CascadedShadowCasterPredicate;
  /** Disable only when registration must be deferred until scene construction completes. */
  autoRegisterScene?: boolean;
}

interface DefineSnapshot {
  readonly existed: boolean;
  readonly value: unknown;
}

interface MaterialRegistration {
  readonly material: THREE.Material;
  readonly meshes: Set<THREE.Mesh>;
  readonly hadOwnHook: boolean;
  readonly originalHook: THREE.Material["onBeforeCompile"];
  readonly hadOwnProgramCacheKey: boolean;
  readonly originalProgramCacheKey: THREE.Material["customProgramCacheKey"];
  readonly originalDefinesWereUndefined: boolean;
  readonly defineSnapshots: Readonly<Record<string, DefineSnapshot>>;
  composedHook?: THREE.Material["onBeforeCompile"];
  composedProgramCacheKey?: THREE.Material["customProgramCacheKey"];
}

interface MeshRegistration {
  readonly mesh: THREE.Mesh;
  readonly roots: Set<THREE.Object3D>;
  readonly materials: Set<THREE.Material>;
  readonly originalLayerMask: number;
  readonly originalCastShadow: boolean;
}

const CSM_DEFINE_KEYS = ["USE_CSM", "CSM_CASCADES", "CSM_FADE"] as const;

let globalCsmUsers = 0;
let originalLightsFragmentBegin: string | null = null;
let originalLightsParsBegin: string | null = null;
let installedLightsFragmentBegin: string | null = null;
let installedLightsParsBegin: string | null = null;

function acquireCsmShaderChunks(): void {
  if (globalCsmUsers === 0) {
    originalLightsFragmentBegin = THREE.ShaderChunk.lights_fragment_begin;
    originalLightsParsBegin = THREE.ShaderChunk.lights_pars_begin;
  }
  globalCsmUsers += 1;
}

function rememberInstalledCsmShaderChunks(): void {
  if (installedLightsFragmentBegin === null) {
    installedLightsFragmentBegin = THREE.ShaderChunk.lights_fragment_begin;
    installedLightsParsBegin = THREE.ShaderChunk.lights_pars_begin;
  }
}

function releaseCsmShaderChunks(): void {
  globalCsmUsers = Math.max(0, globalCsmUsers - 1);
  if (globalCsmUsers !== 0) return;

  // Do not overwrite a third party that deliberately replaced the chunks while
  // this controller was active. Restore only the exact addon strings we installed.
  if (
    originalLightsFragmentBegin !== null &&
    THREE.ShaderChunk.lights_fragment_begin === installedLightsFragmentBegin
  ) {
    THREE.ShaderChunk.lights_fragment_begin = originalLightsFragmentBegin;
  }
  if (
    originalLightsParsBegin !== null &&
    THREE.ShaderChunk.lights_pars_begin === installedLightsParsBegin
  ) {
    THREE.ShaderChunk.lights_pars_begin = originalLightsParsBegin;
  }
  originalLightsFragmentBegin = null;
  originalLightsParsBegin = null;
  installedLightsFragmentBegin = null;
  installedLightsParsBegin = null;
}

/** Explicit budgets keep the shadow cost predictable across rendering modes. */
export function cascadedShadowBudget(
  quality: QualityLevel,
  renderingMode: RenderingMode,
): CascadedShadowBudget {
  const qualityIndex = quality === "low" ? 0 : quality === "medium" ? 1 : 2;
  const cascades = quality === "low" ? 2 : 3;
  const mapSizes =
    renderingMode === "balanced"
      ? ([512, 1_024, 1_024] as const)
      : renderingMode === "ray-traced"
        ? ([1_024, 2_048, 2_048] as const)
        : ([512, 1_024, 2_048] as const);
  const farScale = renderingMode === "balanced" ? 0.82 : renderingMode === "ray-traced" ? 1.08 : 1;
  const baseFar = ([3_800, 7_200, 10_000] as const)[qualityIndex];
  const maxFar = Math.round((baseFar * farScale) / 100) * 100;
  const lightMargins = [110, 165, 220] as const;
  const shadowBiases = [-0.00042, -0.00026, -0.00016] as const;
  const normalBiases = [0.42, 0.26, 0.16] as const;
  const shadowRadii = [1, 1.35, 1.7] as const;
  return Object.freeze({
    cascades,
    shadowMapSize: mapSizes[qualityIndex],
    maxFar,
    lightFar: maxFar + 4_000,
    lightMargin: lightMargins[qualityIndex],
    shadowBias: shadowBiases[qualityIndex],
    normalBias: normalBiases[qualityIndex],
    shadowRadius: shadowRadii[qualityIndex],
    fade: quality !== "low",
  });
}

/** CSM supports the built-in light-reactive material families, including Physical. */
export function isCascadedShadowMaterial(material: THREE.Material): boolean {
  if (!material.visible || material instanceof THREE.ShaderMaterial) return false;
  const candidate = material as THREE.Material & {
    isMeshStandardMaterial?: boolean;
    isMeshLambertMaterial?: boolean;
    isMeshPhongMaterial?: boolean;
  };
  return Boolean(
    candidate.isMeshStandardMaterial ||
      candidate.isMeshLambertMaterial ||
      candidate.isMeshPhongMaterial,
  );
}

function materialsForMesh(mesh: THREE.Mesh): THREE.Material[] {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.filter(isCascadedShadowMaterial);
}

function snapshotDefine(material: THREE.Material, key: string): DefineSnapshot {
  const defines = material.defines;
  return {
    existed: Boolean(defines && Object.prototype.hasOwnProperty.call(defines, key)),
    value: defines?.[key],
  };
}

/**
 * Browser-oriented wrapper around Three's WebGL CSM addon.
 *
 * Every visible built-in lit material is patched, even when `receiveShadow` is
 * false. This is essential: the CSM shader selects exactly one cascade light
 * for direct illumination, preventing the otherwise identical directional
 * lights from multiplying cloud, water, and horizon brightness. The original
 * sun is hidden while the controller is alive; unlit/basic sky materials ignore
 * the replacement lights naturally.
 */
export class CascadedShadowController {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly sunSource: THREE.DirectionalLight;
  readonly layer: number;

  private readonly castShadowPredicate: CascadedShadowCasterPredicate | undefined;
  private readonly roots = new Map<THREE.Object3D, Set<THREE.Mesh>>();
  private readonly meshes = new Map<THREE.Mesh, MeshRegistration>();
  private readonly materials = new Map<THREE.Material, MaterialRegistration>();
  private readonly cameraLayerMasks = new Map<THREE.Camera, number>();
  private readonly sunPosition = new THREE.Vector3();
  private readonly sunTargetPosition = new THREE.Vector3();
  private readonly lightDirection = new THREE.Vector3(0.4, -0.6, 0.7).normalize();
  private readonly originalSunVisible: boolean;
  private quality: QualityLevel;
  private renderingMode: RenderingMode;
  private budgetValue: CascadedShadowBudget;
  private csm: CSM;
  private projectionSignature = "";
  private shadowCasting = true;
  private programGeneration = 0;
  private disposed = false;

  constructor(options: CascadedShadowControllerOptions) {
    const layer = options.layer ?? DEFAULT_CSM_LAYER;
    if (!Number.isInteger(layer) || layer < 1 || layer > 31) {
      throw new RangeError("The CSM layer must be an integer from 1 through 31.");
    }
    this.scene = options.scene;
    this.camera = options.camera;
    this.sunSource = options.sunSource;
    this.layer = layer;
    this.quality = options.quality ?? "medium";
    this.renderingMode = options.renderingMode ?? "hybrid";
    this.budgetValue = cascadedShadowBudget(this.quality, this.renderingMode);
    this.castShadowPredicate = options.castShadowPredicate;
    this.originalSunVisible = this.sunSource.visible;
    this.syncLightDirection();

    acquireCsmShaderChunks();
    try {
      this.csm = this.createCsm();
      rememberInstalledCsmShaderChunks();
    } catch (error) {
      releaseCsmShaderChunks();
      throw error;
    }

    this.sunSource.visible = false;
    this.enableLayer(this.camera);
    if (options.autoRegisterScene !== false) this.register(this.scene);
    this.setShadowCastingEnabled(options.shadowCastingEnabled ?? true);
    this.update();
  }

  get budget(): CascadedShadowBudget {
    return this.budgetValue;
  }

  get cascadeLights(): readonly THREE.DirectionalLight[] {
    return this.csm.lights;
  }

  get cascadeBreaks(): readonly number[] {
    return this.csm.breaks;
  }

  get registeredMeshCount(): number {
    return this.meshes.size;
  }

  get registeredMaterialCount(): number {
    return this.materials.size;
  }

  get shadowCastingEnabled(): boolean {
    return this.shadowCasting;
  }

  /** Enables the CSM-light layer on active or planar-reflection cameras. */
  enableLayer(camera: THREE.Camera): void {
    if (!this.cameraLayerMasks.has(camera)) this.cameraLayerMasks.set(camera, camera.layers.mask);
    camera.layers.enable(this.layer);
  }

  /** Restores the exact mask a camera had before `enableLayer`. */
  restoreCameraLayers(camera: THREE.Camera): void {
    const mask = this.cameraLayerMasks.get(camera);
    if (mask === undefined) return;
    camera.layers.mask = mask;
    this.cameraLayerMasks.delete(camera);
  }

  /** Registers one scene subtree. Calling it twice for the same root is idempotent. */
  register(root: THREE.Object3D): number {
    if (this.disposed) return 0;
    const existing = this.roots.get(root);
    if (existing) return existing.size;

    const registered = new Set<THREE.Mesh>();
    root.traverseVisible((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const litMaterials = materialsForMesh(object);
      if (litMaterials.length === 0) return;

      let meshRegistration = this.meshes.get(object);
      if (!meshRegistration) {
        meshRegistration = {
          mesh: object,
          roots: new Set(),
          materials: new Set(litMaterials),
          originalLayerMask: object.layers.mask,
          originalCastShadow: object.castShadow,
        };
        this.meshes.set(object, meshRegistration);
        object.layers.enable(this.layer);
        if (
          object.castShadow &&
          this.castShadowPredicate &&
          !this.castShadowPredicate(object)
        ) {
          object.castShadow = false;
        }
        for (const material of litMaterials) this.retainMaterial(material, object);
      }
      meshRegistration.roots.add(root);
      registered.add(object);
    });
    this.roots.set(root, registered);
    return registered.size;
  }

  unregister(root: THREE.Object3D): void {
    const registered = this.roots.get(root);
    if (!registered) return;
    this.roots.delete(root);
    for (const mesh of registered) {
      const meshRegistration = this.meshes.get(mesh);
      if (!meshRegistration) continue;
      meshRegistration.roots.delete(root);
      if (meshRegistration.roots.size > 0) continue;
      mesh.layers.mask = meshRegistration.originalLayerMask;
      mesh.castShadow = meshRegistration.originalCastShadow;
      for (const material of meshRegistration.materials) this.releaseMaterial(material, mesh);
      this.meshes.delete(mesh);
    }
  }

  /** Re-traverses a dynamically rebuilt subtree while preserving shared registrations. */
  refresh(root: THREE.Object3D): number {
    this.unregister(root);
    return this.register(root);
  }

  /**
   * Enables/disables shadow-map work without removing CSM defines or hooks.
   * Cascade lights remain shadow-capable so Three keeps a stable program layout;
   * zero shadow intensity makes their direct lighting unshadowed when disabled.
   */
  setShadowCastingEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.shadowCasting = enabled;
    for (const light of this.csm.lights) {
      light.castShadow = true;
      light.shadow.intensity = enabled ? 1 : 0;
      light.shadow.autoUpdate = enabled;
      light.shadow.needsUpdate = enabled;
    }
  }

  /** Quality/mode changes are infrequent and rebuild only the bounded CSM resources. */
  configure(quality: QualityLevel, renderingMode: RenderingMode): void {
    if (this.disposed || (quality === this.quality && renderingMode === this.renderingMode)) return;
    this.releaseCsmResources(true);
    this.programGeneration += 1;
    this.quality = quality;
    this.renderingMode = renderingMode;
    this.budgetValue = cascadedShadowBudget(quality, renderingMode);
    this.csm = this.createCsm();
    rememberInstalledCsmShaderChunks();
    for (const registration of this.materials.values()) this.applyCsmMaterial(registration);
    this.projectionSignature = "";
    this.setShadowCastingEnabled(this.shadowCasting);
    this.update();
  }

  /** Syncs source-sun appearance/direction and texel-snapped cascade transforms. */
  update(): void {
    if (this.disposed) return;
    this.sunSource.visible = false;
    this.syncLightDirection();
    this.csm.lightDirection.copy(this.lightDirection);
    this.csm.lightIntensity = Math.max(0, this.sunSource.intensity);
    for (const light of this.csm.lights) {
      light.color.copy(this.sunSource.color);
      light.intensity = Math.max(0, this.sunSource.intensity);
      light.visible = this.originalSunVisible;
    }

    const nextProjectionSignature = [
      this.camera.near,
      this.camera.far,
      this.camera.fov,
      this.camera.aspect,
      this.camera.zoom,
    ].join(":");
    if (nextProjectionSignature !== this.projectionSignature) {
      this.projectionSignature = nextProjectionSignature;
      this.csm.updateFrustums();
    }
    this.camera.updateMatrixWorld();
    this.csm.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseCsmResources(false);
    for (const registration of this.meshes.values()) {
      registration.mesh.layers.mask = registration.originalLayerMask;
      registration.mesh.castShadow = registration.originalCastShadow;
    }
    for (const [camera, mask] of this.cameraLayerMasks) camera.layers.mask = mask;
    this.roots.clear();
    this.meshes.clear();
    this.materials.clear();
    this.cameraLayerMasks.clear();
    this.sunSource.visible = this.originalSunVisible;
    releaseCsmShaderChunks();
  }

  private createCsm(): CSM {
    const budget = this.budgetValue;
    const csm = new CSM({
      camera: this.camera,
      parent: this.scene,
      cascades: budget.cascades,
      maxFar: budget.maxFar,
      mode: "practical",
      shadowMapSize: budget.shadowMapSize,
      shadowBias: budget.shadowBias,
      lightDirection: this.lightDirection.clone(),
      lightIntensity: Math.max(this.sunSource.intensity, Number.EPSILON),
      lightNear: 1,
      lightFar: budget.lightFar,
      lightMargin: budget.lightMargin,
    });
    csm.fade = budget.fade;
    csm.updateFrustums();
    for (const light of csm.lights) {
      light.layers.set(this.layer);
      light.target.layers.set(this.layer);
      light.shadow.bias = budget.shadowBias;
      light.shadow.normalBias = budget.normalBias;
      light.shadow.radius = budget.shadowRadius;
      light.shadow.camera.near = 1;
      light.shadow.camera.far = budget.lightFar;
      light.shadow.camera.updateProjectionMatrix();
    }
    return csm;
  }

  private retainMaterial(material: THREE.Material, mesh: THREE.Mesh): void {
    const existing = this.materials.get(material);
    if (existing) {
      existing.meshes.add(mesh);
      return;
    }
    const defineSnapshots: Record<string, DefineSnapshot> = {};
    for (const key of CSM_DEFINE_KEYS) defineSnapshots[key] = snapshotDefine(material, key);
    const registration: MaterialRegistration = {
      material,
      meshes: new Set([mesh]),
      hadOwnHook: Object.prototype.hasOwnProperty.call(material, "onBeforeCompile"),
      originalHook: material.onBeforeCompile,
      hadOwnProgramCacheKey: Object.prototype.hasOwnProperty.call(
        material,
        "customProgramCacheKey",
      ),
      originalProgramCacheKey: material.customProgramCacheKey,
      originalDefinesWereUndefined: material.defines === undefined,
      defineSnapshots,
    };
    this.materials.set(material, registration);
    this.applyCsmMaterial(registration);
  }

  private applyCsmMaterial(registration: MaterialRegistration): void {
    const { material, originalHook } = registration;
    this.csm.setupMaterial(material);
    const csmHook = material.onBeforeCompile;
    const composedHook: THREE.Material["onBeforeCompile"] = function (
      this: THREE.Material,
      shader,
      renderer,
    ): void {
      originalHook.call(this, shader, renderer);
      csmHook.call(this, shader, renderer);
    };
    registration.composedHook = composedHook;
    material.onBeforeCompile = composedHook;
    // Three may reuse a cached WebGLProgram when the CSM instance is rebuilt
    // with the same cascade count. That program still advertises the old CSM
    // uniforms while the new material hook has a fresh uniform set, causing
    // WebGLUniforms.upload to dereference `undefined` on the next frame. Give
    // each CSM generation a distinct cache identity while preserving every
    // material's existing custom cache key.
    const originalProgramCacheKey = registration.originalProgramCacheKey;
    const generation = this.programGeneration;
    const layer = this.layer;
    const composedProgramCacheKey: THREE.Material["customProgramCacheKey"] = function (
      this: THREE.Material,
    ): string {
      return `${originalProgramCacheKey.call(this)}|csm-${layer}-generation-${generation}`;
    };
    registration.composedProgramCacheKey = composedProgramCacheKey;
    material.customProgramCacheKey = composedProgramCacheKey;
    material.needsUpdate = true;
  }

  private releaseMaterial(material: THREE.Material, mesh: THREE.Mesh): void {
    const registration = this.materials.get(material);
    if (!registration) return;
    registration.meshes.delete(mesh);
    if (registration.meshes.size > 0) return;
    this.csm.shaders.delete(material);
    this.restoreMaterial(registration);
    this.materials.delete(material);
  }

  private restoreMaterial(registration: MaterialRegistration): void {
    const { material } = registration;
    if (registration.hadOwnHook) {
      material.onBeforeCompile = registration.originalHook;
    } else {
      Reflect.deleteProperty(material, "onBeforeCompile");
    }
    if (registration.hadOwnProgramCacheKey) {
      material.customProgramCacheKey = registration.originalProgramCacheKey;
    } else {
      Reflect.deleteProperty(material, "customProgramCacheKey");
    }

    const defines = material.defines ?? {};
    for (const key of CSM_DEFINE_KEYS) {
      const snapshot = registration.defineSnapshots[key]!;
      if (snapshot.existed) defines[key] = snapshot.value;
      else delete defines[key];
    }
    if (registration.originalDefinesWereUndefined && Object.keys(defines).length === 0) {
      material.defines = undefined;
    } else {
      material.defines = defines;
    }
    material.needsUpdate = true;
  }

  private releaseCsmResources(forRebuild: boolean): void {
    const lights = [...this.csm.lights];
    this.csm.remove();
    this.csm.dispose();
    for (const registration of this.materials.values()) this.restoreMaterial(registration);
    for (const light of lights) light.dispose();
    if (!forRebuild) return;
  }

  private syncLightDirection(): void {
    this.sunSource.updateWorldMatrix(true, false);
    this.sunSource.target.updateWorldMatrix(true, false);
    this.sunSource.getWorldPosition(this.sunPosition);
    this.sunSource.target.getWorldPosition(this.sunTargetPosition);
    this.lightDirection.subVectors(this.sunTargetPosition, this.sunPosition);
    if (this.lightDirection.lengthSq() < 1e-10) this.lightDirection.set(0.4, -0.6, 0.7);
    this.lightDirection.normalize();
  }
}
