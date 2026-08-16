import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import type { WaterBathymetrySource } from "../BathymetryField";
import type { HybridRenderCapabilities } from "./RenderCapabilities";
import {
  resolveRenderProfile,
  type RenderProfileRequest,
  type ResolvedRenderProfile,
} from "./RenderProfile";
import {
  PlanarWaterReflectionPass,
  type PlanarWaterReflectionBindings,
} from "./PlanarWaterReflectionPass";
import {
  captureWebGLRendererState,
  restoreWebGLRendererState,
} from "./RendererState";
import {
  HYBRID_COMPOSITE_FRAGMENT_SHADER,
  HYBRID_EFFECT_FRAGMENT_SHADER,
  HYBRID_FULLSCREEN_VERTEX_SHADER,
  HYBRID_SURFACE_HISTORY_FRAGMENT_SHADER,
  HYBRID_TEMPORAL_FRAGMENT_SHADER,
} from "./HybridShaders";

export type HybridPassName =
  | "forward"
  | "planar-reflection"
  | "beauty"
  | "screen-space-effects"
  | "temporal-accumulation"
  | "surface-history"
  | "composite";

export interface HybridRenderFrame {
  nowMs?: number;
  cameraCut?: boolean;
  originShifted?: boolean;
  /** Optional exact floating origin; inferred in 4 km steps when omitted. */
  worldOrigin?: { readonly x: number; readonly z: number };
}

export interface HybridPipelineDiagnostics {
  readonly requestedMode: ResolvedRenderProfile["requestedMode"];
  readonly activeMode: ResolvedRenderProfile["activeMode"];
  readonly technique: ResolvedRenderProfile["technique"];
  readonly hardwareRayTracing: false;
  readonly colorFormat: ResolvedRenderProfile["colorFormat"];
  readonly passOrder: readonly HybridPassName[];
  readonly renderTargetBytes: number;
  readonly historyValid: boolean;
  readonly historyInvalidationReason: string;
  readonly planarUpdates: number;
  readonly framesRendered: number;
  readonly planarConfidence: number;
  readonly waterWorldOrigin: readonly [number, number];
  readonly waterTimeSeconds: number;
  readonly downgradeReasons: readonly string[];
  readonly disposed: boolean;
}

export interface HybridRenderPipelineOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  capabilities: HybridRenderCapabilities;
  profile: ResolvedRenderProfile;
  waterReflection?: PlanarWaterReflectionBindings;
  waterBathymetry?: WaterBathymetrySource;
  prepareReflectionCamera?: (camera: THREE.PerspectiveCamera) => void;
  releaseReflectionCamera?: (camera: THREE.PerspectiveCamera) => void;
}

interface PipelineTargets {
  beauty: THREE.WebGLRenderTarget;
  currentEffects: THREE.WebGLRenderTarget;
  history: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  surfaceHistory: THREE.WebGLRenderTarget;
}

interface PipelineResources {
  targets: PipelineTargets | null;
  planarPass: PlanarWaterReflectionPass | null;
}

function targetTextureType(profile: ResolvedRenderProfile): THREE.TextureDataType {
  return profile.colorFormat === "rgba16f" ? THREE.HalfFloatType : THREE.UnsignedByteType;
}

function configureLinearTargetTexture(texture: THREE.Texture, name: string): void {
  texture.name = name;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
}

function createPipelineTargets(profile: ResolvedRenderProfile): PipelineTargets {
  const type = targetTextureType(profile);
  const depthTexture = new THREE.DepthTexture(
    profile.beautyWidth,
    profile.beautyHeight,
    THREE.UnsignedIntType,
  );
  depthTexture.name = "hybrid-beauty-depth";
  depthTexture.format = THREE.DepthFormat;
  depthTexture.minFilter = THREE.NearestFilter;
  depthTexture.magFilter = THREE.NearestFilter;
  depthTexture.generateMipmaps = false;
  const beauty = new THREE.WebGLRenderTarget(profile.beautyWidth, profile.beautyHeight, {
    type,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
    depthTexture,
    generateMipmaps: false,
  });
  configureLinearTargetTexture(beauty.texture, "hybrid-beauty-color");

  const makeEffectsTarget = (name: string) => {
    const target = new THREE.WebGLRenderTarget(
      profile.effectsWidth,
      profile.effectsHeight,
      {
        type,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      },
    );
    configureLinearTargetTexture(target.texture, name);
    return target;
  };
  const surfaceHistory = new THREE.WebGLRenderTarget(
    profile.effectsWidth,
    profile.effectsHeight,
    {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    },
  );
  surfaceHistory.texture.name = "hybrid-previous-surface-depth-material";
  surfaceHistory.texture.colorSpace = THREE.NoColorSpace;
  surfaceHistory.texture.generateMipmaps = false;
  return {
    beauty,
    currentEffects: makeEffectsTarget("hybrid-current-effects"),
    history: [
      makeEffectsTarget("hybrid-effects-history-a"),
      makeEffectsTarget("hybrid-effects-history-b"),
    ],
    surfaceHistory,
  };
}

function disposePipelineTargets(targets: PipelineTargets | null): void {
  if (!targets) return;
  targets.beauty.dispose();
  targets.currentEffects.dispose();
  targets.history[0].dispose();
  targets.history[1].dispose();
  targets.surfaceHistory.dispose();
}

function sameNumberRecord<T extends object>(
  first: Readonly<T>,
  second: Readonly<T>,
): boolean {
  const firstKeys = Object.keys(first) as Array<keyof T>;
  const secondKeys = Object.keys(second);
  return firstKeys.length === secondKeys.length &&
    firstKeys.every((key) => first[key] === second[key]);
}

/** Semantic equality used to keep resize/settings echoes allocation-free. */
export function resolvedRenderProfilesEqual(
  first: ResolvedRenderProfile,
  second: ResolvedRenderProfile,
): boolean {
  return first.requestedMode === second.requestedMode &&
    first.activeMode === second.activeMode &&
    first.technique === second.technique &&
    first.quality === second.quality &&
    first.outputWidth === second.outputWidth &&
    first.outputHeight === second.outputHeight &&
    first.beautyWidth === second.beautyWidth &&
    first.beautyHeight === second.beautyHeight &&
    first.effectsWidth === second.effectsWidth &&
    first.effectsHeight === second.effectsHeight &&
    first.colorFormat === second.colorFormat &&
    first.bypass === second.bypass &&
    sameNumberRecord(first.planar, second.planar) &&
    sameNumberRecord(first.screenSpace, second.screenSpace) &&
    sameNumberRecord(first.memory, second.memory) &&
    first.downgradeReasons.length === second.downgradeReasons.length &&
    first.downgradeReasons.every(
      (reason, index) => reason === second.downgradeReasons[index],
    );
}

function samePlanarBudget(
  first: ResolvedRenderProfile,
  second: ResolvedRenderProfile,
): boolean {
  return sameNumberRecord(first.planar, second.planar);
}

function samePipelineAllocation(
  first: ResolvedRenderProfile,
  second: ResolvedRenderProfile,
): boolean {
  return first.bypass === second.bypass &&
    first.colorFormat === second.colorFormat &&
    first.beautyWidth === second.beautyWidth &&
    first.beautyHeight === second.beautyHeight &&
    first.effectsWidth === second.effectsWidth &&
    first.effectsHeight === second.effectsHeight &&
    samePlanarBudget(first, second);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shaderMaterial(
  name: string,
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
  toneMapped = false,
): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    name,
    uniforms,
    vertexShader: HYBRID_FULLSCREEN_VERTEX_SHADER,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped,
  });
  material.customProgramCacheKey = () => `${name}-v1`;
  return material;
}

function currentTimeMilliseconds(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function maximumMatrixDifference(first: THREE.Matrix4, second: THREE.Matrix4): number {
  let maximum = 0;
  for (let index = 0; index < 16; index += 1) {
    maximum = Math.max(
      maximum,
      Math.abs((first.elements[index] ?? 0) - (second.elements[index] ?? 0)),
    );
  }
  return maximum;
}

function quaternionAngularDistance(first: THREE.Quaternion, second: THREE.Quaternion): number {
  const cosine = Math.min(1, Math.abs(first.dot(second)));
  return 2 * Math.acos(cosine);
}

export function buildHybridPassOrder(
  profile: ResolvedRenderProfile,
  hasWaterReflection = true,
): readonly HybridPassName[] {
  if (profile.bypass) return ["forward"];
  return [
    ...(profile.planar.enabled && hasWaterReflection
      ? (["planar-reflection"] as const)
      : []),
    "beauty",
    "screen-space-effects",
    "temporal-accumulation",
    "surface-history",
    "composite",
  ];
}

export class HybridRenderPipeline {
  private profile: ResolvedRenderProfile;
  private targets: PipelineTargets | null = null;
  private planarPass: PlanarWaterReflectionPass | null = null;
  private readonly effectMaterial: THREE.ShaderMaterial;
  private readonly temporalMaterial: THREE.ShaderMaterial;
  private readonly surfaceHistoryMaterial: THREE.ShaderMaterial;
  private readonly compositeMaterial: THREE.ShaderMaterial;
  private readonly effectQuad: FullScreenQuad;
  private readonly temporalQuad: FullScreenQuad;
  private readonly surfaceHistoryQuad: FullScreenQuad;
  private readonly compositeQuad: FullScreenQuad;
  private readonly currentViewProjection = new THREE.Matrix4();
  private readonly previousViewProjection = new THREE.Matrix4();
  private readonly previousProjection = new THREE.Matrix4();
  private readonly previousCameraPosition = new THREE.Vector3();
  private readonly previousCameraQuaternion = new THREE.Quaternion();
  private readonly waterWorldOrigin = new THREE.Vector2();
  private waterTimeSeconds = 0;
  private historyReadIndex: 0 | 1 = 0;
  private historyValid = false;
  private historyInvalidationReason = "initial-frame";
  private framesRendered = 0;
  private planarUpdates = 0;
  private lastBathymetryRevision = -1;
  private profileRevision = 0;
  private profileChangeFailure: string | null = null;
  private disposed = false;

  constructor(private readonly options: HybridRenderPipelineOptions) {
    this.profile = options.profile;
    this.effectMaterial = shaderMaterial(
      "hybrid-depth-ssao-ssr",
      HYBRID_EFFECT_FRAGMENT_SHADER,
      {
        beautyMap: { value: null },
        depthMap: { value: null },
        beautyTexel: { value: new THREE.Vector2(1, 1) },
        projectionMatrixValue: { value: new THREE.Matrix4() },
        inverseProjectionMatrix: { value: new THREE.Matrix4() },
        cameraWorldMatrix: { value: new THREE.Matrix4() },
        viewMatrixValue: { value: new THREE.Matrix4() },
        cameraNear: { value: 0.08 },
        cameraFar: { value: 32_000 },
        waterLevel: { value: options.waterReflection?.waterLevel ?? 0 },
        waterTime: { value: 0 },
        waterWorldOrigin: { value: new THREE.Vector2() },
        waterSurfaceDetailMap: {
          value: options.waterBathymetry?.surfaceDetailTexture ?? null,
        },
        waterDetailStrength: { value: 0 },
        aoTapCount: { value: 0 },
        aoRadius: { value: 0 },
        aoStrength: { value: 0 },
        ssrStepCount: { value: 0 },
        ssrMaxDistance: { value: 0 },
        ssrThickness: { value: 0 },
      },
    );
    this.temporalMaterial = shaderMaterial(
      "hybrid-temporal-effects",
      HYBRID_TEMPORAL_FRAGMENT_SHADER,
      {
        currentEffectsMap: { value: null },
        historyMap: { value: null },
        beautyMap: { value: null },
        depthMap: { value: null },
        previousSurfaceMap: { value: null },
        effectsTexel: { value: new THREE.Vector2(1, 1) },
        inverseProjectionMatrix: { value: new THREE.Matrix4() },
        cameraWorldMatrix: { value: new THREE.Matrix4() },
        previousViewProjectionMatrix: { value: new THREE.Matrix4() },
        waterLevel: { value: options.waterReflection?.waterLevel ?? 0 },
        historyWeight: { value: 0 },
        waterHistoryWeight: { value: 0 },
        historyValid: { value: 0 },
      },
    );
    this.surfaceHistoryMaterial = shaderMaterial(
      "hybrid-surface-history",
      HYBRID_SURFACE_HISTORY_FRAGMENT_SHADER,
      {
        depthMap: { value: null },
        beautyMap: { value: null },
      },
    );
    this.compositeMaterial = shaderMaterial(
      "hybrid-bilateral-composite",
      HYBRID_COMPOSITE_FRAGMENT_SHADER,
      {
        beautyMap: { value: null },
        depthMap: { value: null },
        effectsMap: { value: null },
        beautyTexel: { value: new THREE.Vector2(1, 1) },
        effectsTexel: { value: new THREE.Vector2(1, 1) },
        inverseProjectionMatrix: { value: new THREE.Matrix4() },
        cameraWorldMatrix: { value: new THREE.Matrix4() },
        cameraNear: { value: 0.08 },
        waterLevel: { value: options.waterReflection?.waterLevel ?? 0 },
        waterTime: { value: 0 },
        waterWorldOrigin: { value: new THREE.Vector2() },
        waterSurfaceDetailMap: {
          value: options.waterBathymetry?.surfaceDetailTexture ?? null,
        },
        waterDetailStrength: { value: 0 },
        shorelineStrength: { value: 0 },
        waterBathymetryMap: { value: options.waterBathymetry?.texture ?? null },
        waterBathymetryBounds: { value: new THREE.Vector4() },
        waterBathymetryMaxDepth: { value: options.waterBathymetry?.maxDepth ?? 1 },
        waterBathymetryTexel: {
          value: 1 / Math.max(1, options.waterBathymetry?.resolution ?? 1),
        },
        waterBathymetryValid: { value: 0 },
        ssrStrength: { value: 0 },
      },
      true,
    );
    this.effectQuad = new FullScreenQuad(this.effectMaterial);
    this.temporalQuad = new FullScreenQuad(this.temporalMaterial);
    this.surfaceHistoryQuad = new FullScreenQuad(this.surfaceHistoryMaterial);
    this.compositeQuad = new FullScreenQuad(this.compositeMaterial);
    try {
      const resources = this.createResources(this.profile);
      this.targets = resources.targets;
      this.planarPass = resources.planarPass;
      this.invalidateHistory("resources-built");
    } catch (error) {
      // A throwing constructor never exposes an instance that a caller can
      // dispose, so release every object created before the failed allocation.
      this.effectQuad.dispose();
      this.temporalQuad.dispose();
      this.surfaceHistoryQuad.dispose();
      this.compositeQuad.dispose();
      this.effectMaterial.dispose();
      this.temporalMaterial.dispose();
      this.surfaceHistoryMaterial.dispose();
      this.compositeMaterial.dispose();
      throw error;
    }
  }

  setProfile(profile: ResolvedRenderProfile): boolean {
    if (this.disposed) return false;
    if (resolvedRenderProfilesEqual(profile, this.profile)) {
      // A user can return to the retained profile after a rejected request.
      // Clear that obsolete failure without disturbing valid history/captures.
      this.profileChangeFailure = null;
      return true;
    }

    if (samePipelineAllocation(profile, this.profile)) {
      // No fallible allocation is needed. The planar dimensions/format are
      // unchanged, so this only updates the shader/runtime budgets.
      this.profile = profile;
      this.profileRevision += 1;
      this.profileChangeFailure = null;
      this.invalidateHistory("profile-change");
      return true;
    }

    let replacements: PipelineResources;
    try {
      replacements = this.createResources(profile);
    } catch (error) {
      this.profileChangeFailure =
        `Requested render profile could not be activated; retaining the previous profile: ${errorMessage(error)}`;
      return false;
    }
    const previousTargets = this.targets;
    const previousPlanarPass = this.planarPass;
    this.targets = replacements.targets;
    this.planarPass = replacements.planarPass;
    this.profile = profile;
    this.profileRevision += 1;
    this.profileChangeFailure = null;
    this.historyReadIndex = 0;
    this.lastBathymetryRevision = -1;
    this.invalidateHistory("resources-rebuilt");
    // Commit happens before disposal: a failed replacement construction can
    // never tear down the last frame graph that rendered successfully.
    this.disposeReplacedResources(previousTargets, previousPlanarPass);
    return true;
  }

  /** Re-resolve strict budgets for a new physical output size. */
  resize(outputWidth: number, outputHeight: number): boolean {
    return this.setProfile(resolveRenderProfile(
      {
        renderingMode: this.profile.requestedMode,
        quality: this.profile.quality,
        outputWidth,
        outputHeight,
      },
      this.options.capabilities,
    ));
  }

  /** Convenience API for settings integration without constructing a profile. */
  setProfileRequest(request: RenderProfileRequest): boolean {
    return this.setProfile(resolveRenderProfile(request, this.options.capabilities));
  }

  /** Increments only when a different resolved profile is committed. */
  getProfileRevision(): number {
    return this.profileRevision;
  }

  /** Whether the committed frame graph, rather than terrain, owns water absorption. */
  usesHybridComposite(): boolean {
    return !this.profile.bypass;
  }

  /** Recreate attachments invalidated by a restored WebGL context. */
  rebuildAfterContextRestore(): boolean {
    if (this.disposed) return false;
    let replacements: PipelineResources;
    try {
      replacements = this.createResources(this.profile);
    } catch (error) {
      this.profileChangeFailure =
        `WebGL context restoration could not rebuild render attachments: ${errorMessage(error)}`;
      this.invalidateHistory("webgl-context-restore-failed");
      return false;
    }
    const previousTargets = this.targets;
    const previousPlanarPass = this.planarPass;
    this.targets = replacements.targets;
    this.planarPass = replacements.planarPass;
    this.profileChangeFailure = null;
    this.historyReadIndex = 0;
    this.lastBathymetryRevision = -1;
    this.invalidateHistory("webgl-context-restored");
    this.disposeReplacedResources(previousTargets, previousPlanarPass);
    return true;
  }

  invalidateHistory(reason = "external-reset"): void {
    this.historyValid = false;
    this.historyInvalidationReason = reason;
    this.planarPass?.invalidate();
  }

  render(frame: HybridRenderFrame = {}): void {
    if (this.disposed) throw new Error("HybridRenderPipeline has been disposed");
    if (frame.cameraCut) this.invalidateHistory("camera-cut");
    if (frame.originShifted) this.invalidateHistory("floating-origin-shift");
    const renderer = this.options.renderer;
    const camera = this.options.camera;
    if (this.profile.bypass) {
      renderer.render(this.options.scene, camera);
      this.framesRendered += 1;
      return;
    }
    const targets = this.targets;
    if (!targets) throw new Error("Hybrid render targets are unavailable");
    const bathymetryRevision = this.options.waterBathymetry?.getRevision() ?? 0;
    const bathymetryChanged =
      this.lastBathymetryRevision >= 0 &&
      bathymetryRevision !== this.lastBathymetryRevision;

    camera.updateMatrixWorld();
    const safeNowMs = Number.isFinite(frame.nowMs)
      ? Math.max(0, frame.nowMs ?? 0)
      : currentTimeMilliseconds();
    this.waterTimeSeconds = Math.max(0, safeNowMs) * 0.001;
    this.currentViewProjection.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
    const cameraQuaternion = camera.getWorldQuaternion(new THREE.Quaternion());
    this.synchronizeWaterWorldOrigin(frame, cameraPosition);
    let motionWeight = this.profile.screenSpace.temporalHistoryWeight;
    if (this.framesRendered > 0) {
      const translation = cameraPosition.distanceTo(this.previousCameraPosition);
      const rotation = quaternionAngularDistance(cameraQuaternion, this.previousCameraQuaternion);
      const projectionChange = maximumMatrixDifference(
        camera.projectionMatrix,
        this.previousProjection,
      );
      if (translation > 24 || rotation > 0.38 || projectionChange > 0.09) {
        this.invalidateHistory("motion-discontinuity");
      }
      motionWeight *= Math.exp(-translation * 0.035 - rotation * 3.4);
    }

    const saved = captureWebGLRendererState(renderer);
    let renderedPlanar = false;
    try {
      const planarResult = this.planarPass?.render(
        camera,
        safeNowMs,
      );
      renderedPlanar = planarResult?.rendered ?? false;

      renderer.autoClear = false;
      renderer.setScissorTest(false);
      renderer.setRenderTarget(targets.beauty);
      renderer.setViewport(0, 0, targets.beauty.width, targets.beauty.height);
      renderer.clear(true, true, false);
      renderer.render(this.options.scene, camera);

      this.updateEffectUniforms(targets, camera);
      renderer.setRenderTarget(targets.currentEffects);
      renderer.setViewport(
        0,
        0,
        targets.currentEffects.width,
        targets.currentEffects.height,
      );
      renderer.clear(true, false, false);
      this.effectQuad.render(renderer);

      const historyRead = targets.history[this.historyReadIndex];
      const historyWriteIndex: 0 | 1 = this.historyReadIndex === 0 ? 1 : 0;
      const historyWrite = targets.history[historyWriteIndex];
      this.updateTemporalUniforms(
        targets,
        historyRead,
        camera,
        motionWeight,
        bathymetryChanged,
      );
      renderer.setRenderTarget(historyWrite);
      renderer.setViewport(0, 0, historyWrite.width, historyWrite.height);
      renderer.clear(true, false, false);
      this.temporalQuad.render(renderer);

      this.updateSurfaceHistoryUniforms(targets);
      renderer.setRenderTarget(targets.surfaceHistory);
      renderer.setViewport(
        0,
        0,
        targets.surfaceHistory.width,
        targets.surfaceHistory.height,
      );
      renderer.clear(true, false, false);
      this.surfaceHistoryQuad.render(renderer);

      this.updateCompositeUniforms(targets, historyWrite, camera);
      renderer.setRenderTarget(
        saved.renderTarget,
        saved.activeCubeFace,
        saved.activeMipmapLevel,
      );
      renderer.setViewport(saved.viewport);
      renderer.setScissor(saved.scissor);
      renderer.setScissorTest(saved.scissorTest);
      renderer.clear(true, true, false);
      this.compositeQuad.render(renderer);

      this.historyReadIndex = historyWriteIndex;
      this.historyValid = true;
      this.previousViewProjection.copy(this.currentViewProjection);
      this.previousProjection.copy(camera.projectionMatrix);
      this.previousCameraPosition.copy(cameraPosition);
      this.previousCameraQuaternion.copy(cameraQuaternion);
      this.lastBathymetryRevision = bathymetryRevision;
      this.framesRendered += 1;
      if (renderedPlanar) this.planarUpdates += 1;
    } finally {
      restoreWebGLRendererState(renderer, saved);
    }
  }

  getDiagnostics(): HybridPipelineDiagnostics {
    const runtimeReasons = [...this.profile.downgradeReasons];
    if (this.profile.planar.enabled && !this.options.waterReflection) {
      runtimeReasons.push("Planar reflection bindings unavailable; analytic water remains active.");
    }
    if (this.profileChangeFailure) runtimeReasons.push(this.profileChangeFailure);
    return {
      requestedMode: this.profile.requestedMode,
      activeMode: this.profile.activeMode,
      technique: this.profile.technique,
      hardwareRayTracing: false,
      colorFormat: this.profile.colorFormat,
      passOrder: buildHybridPassOrder(this.profile, this.options.waterReflection !== undefined),
      renderTargetBytes: this.profile.memory.estimatedBytes,
      historyValid: this.historyValid,
      historyInvalidationReason: this.historyInvalidationReason,
      planarUpdates: this.planarUpdates,
      framesRendered: this.framesRendered,
      planarConfidence: this.planarPass?.confidence ?? 0,
      waterWorldOrigin: [this.waterWorldOrigin.x, this.waterWorldOrigin.y],
      waterTimeSeconds: this.waterTimeSeconds,
      downgradeReasons: runtimeReasons,
      disposed: this.disposed,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.planarPass?.dispose();
    this.planarPass = null;
    disposePipelineTargets(this.targets);
    this.targets = null;
    this.effectQuad.dispose();
    this.temporalQuad.dispose();
    this.surfaceHistoryQuad.dispose();
    this.compositeQuad.dispose();
    this.effectMaterial.dispose();
    this.temporalMaterial.dispose();
    this.surfaceHistoryMaterial.dispose();
    this.compositeMaterial.dispose();
    this.historyValid = false;
    this.historyInvalidationReason = "disposed";
  }

  private synchronizeWaterWorldOrigin(
    frame: HybridRenderFrame,
    cameraPosition: THREE.Vector3,
  ): void {
    const explicit = frame.worldOrigin;
    if (explicit && Number.isFinite(explicit.x) && Number.isFinite(explicit.z)) {
      this.waterWorldOrigin.set(explicit.x, explicit.z);
      return;
    }
    if (!frame.originShifted || this.framesRendered <= 0) return;
    // FlightRenderer rebases in exact 4 km increments. Comparing the local
    // camera pose before/after the rebase recovers that origin without coupling
    // the frame graph to FlightRenderer. Supplying worldOrigin remains exact.
    const inferredX = Math.round(
      (this.previousCameraPosition.x - cameraPosition.x) / 4_000,
    ) * 4_000;
    const inferredZ = Math.round(
      (this.previousCameraPosition.z - cameraPosition.z) / 4_000,
    ) * 4_000;
    this.waterWorldOrigin.x += inferredX;
    this.waterWorldOrigin.y += inferredZ;
  }

  private createResources(profile: ResolvedRenderProfile): PipelineResources {
    let targets: PipelineTargets | null = null;
    let planarPass: PlanarWaterReflectionPass | null = null;
    try {
      if (!profile.bypass) {
        targets = createPipelineTargets(profile);
        // Force WebGL allocation now. Three otherwise creates framebuffer
        // attachments lazily on the first frame, after the old resources have
        // already been discarded and rollback is no longer possible.
        this.options.renderer.initRenderTarget?.(targets.beauty);
        this.options.renderer.initRenderTarget?.(targets.currentEffects);
        this.options.renderer.initRenderTarget?.(targets.history[0]);
        this.options.renderer.initRenderTarget?.(targets.history[1]);
        this.options.renderer.initRenderTarget?.(targets.surfaceHistory);
        if (this.options.waterReflection && profile.planar.enabled) {
          planarPass = new PlanarWaterReflectionPass({
            renderer: this.options.renderer,
            scene: this.options.scene,
            bindings: this.options.waterReflection,
            budget: profile.planar,
            colorFormat: profile.colorFormat,
            ...(this.options.prepareReflectionCamera
              ? { prepareReflectionCamera: this.options.prepareReflectionCamera }
              : {}),
            ...(this.options.releaseReflectionCamera
              ? { releaseReflectionCamera: this.options.releaseReflectionCamera }
              : {}),
          });
          planarPass.initialize();
        }
      }
      return { targets, planarPass };
    } catch (error) {
      // This candidate never owned the live terrain binding. Discarding it
      // must not clear the still-valid reflection published by the old pass.
      try {
        planarPass?.dispose(false);
      } catch {
        // Continue releasing the remaining candidate attachments.
      }
      try {
        disposePipelineTargets(targets);
      } catch {
        // Preserve the original allocation error for accurate diagnostics.
      }
      throw error;
    }
  }

  private disposeReplacedResources(
    targets: PipelineTargets | null,
    planarPass: PlanarWaterReflectionPass | null,
  ): void {
    try {
      planarPass?.dispose();
    } catch {
      // The replacement is already active. A third-party reflection binding
      // must not turn a successful commit into a false rollback report.
    }
    try {
      disposePipelineTargets(targets);
    } catch {
      // WebGLRenderTarget.dispose normally cannot throw; keep the new graph
      // usable even if an external dispose listener violates that contract.
    }
  }

  private updateEffectUniforms(
    targets: PipelineTargets,
    camera: THREE.PerspectiveCamera,
  ): void {
    const uniforms = this.effectMaterial.uniforms;
    uniforms.beautyMap!.value = targets.beauty.texture;
    uniforms.depthMap!.value = targets.beauty.depthTexture;
    (uniforms.beautyTexel!.value as THREE.Vector2).set(
      1 / targets.beauty.width,
      1 / targets.beauty.height,
    );
    (uniforms.projectionMatrixValue!.value as THREE.Matrix4).copy(camera.projectionMatrix);
    (uniforms.inverseProjectionMatrix!.value as THREE.Matrix4).copy(
      camera.projectionMatrixInverse,
    );
    (uniforms.cameraWorldMatrix!.value as THREE.Matrix4).copy(camera.matrixWorld);
    (uniforms.viewMatrixValue!.value as THREE.Matrix4).copy(camera.matrixWorldInverse);
    uniforms.cameraNear!.value = camera.near;
    uniforms.cameraFar!.value = camera.far;
    uniforms.waterLevel!.value = this.options.waterReflection?.waterLevel ?? 0;
    uniforms.waterTime!.value = this.waterTimeSeconds;
    (uniforms.waterWorldOrigin!.value as THREE.Vector2).copy(this.waterWorldOrigin);
    uniforms.waterSurfaceDetailMap!.value =
      this.options.waterBathymetry?.surfaceDetailTexture ?? null;
    uniforms.waterDetailStrength!.value = this.profile.screenSpace.waterDetailStrength;
    uniforms.aoTapCount!.value = this.profile.screenSpace.aoTaps;
    uniforms.aoRadius!.value = this.profile.screenSpace.aoRadius;
    uniforms.aoStrength!.value = this.profile.screenSpace.aoStrength;
    uniforms.ssrStepCount!.value = this.profile.screenSpace.ssrSteps;
    uniforms.ssrMaxDistance!.value = this.profile.screenSpace.ssrMaxDistance;
    uniforms.ssrThickness!.value = this.profile.screenSpace.ssrThickness;
  }

  private updateTemporalUniforms(
    targets: PipelineTargets,
    historyRead: THREE.WebGLRenderTarget,
    camera: THREE.PerspectiveCamera,
    motionWeight: number,
    bathymetryChanged: boolean,
  ): void {
    const uniforms = this.temporalMaterial.uniforms;
    uniforms.currentEffectsMap!.value = targets.currentEffects.texture;
    uniforms.historyMap!.value = historyRead.texture;
    uniforms.beautyMap!.value = targets.beauty.texture;
    uniforms.depthMap!.value = targets.beauty.depthTexture;
    uniforms.previousSurfaceMap!.value = targets.surfaceHistory.texture;
    (uniforms.effectsTexel!.value as THREE.Vector2).set(
      1 / targets.currentEffects.width,
      1 / targets.currentEffects.height,
    );
    (uniforms.inverseProjectionMatrix!.value as THREE.Matrix4).copy(
      camera.projectionMatrixInverse,
    );
    (uniforms.cameraWorldMatrix!.value as THREE.Matrix4).copy(camera.matrixWorld);
    (uniforms.previousViewProjectionMatrix!.value as THREE.Matrix4).copy(
      this.previousViewProjection,
    );
    uniforms.waterLevel!.value = this.options.waterReflection?.waterLevel ?? 0;
    uniforms.historyWeight!.value = this.historyValid ? motionWeight : 0;
    uniforms.waterHistoryWeight!.value = bathymetryChanged
      ? 0
      : this.profile.screenSpace.waterTemporalHistoryWeight;
    uniforms.historyValid!.value = this.historyValid ? 1 : 0;
  }

  private updateSurfaceHistoryUniforms(targets: PipelineTargets): void {
    const uniforms = this.surfaceHistoryMaterial.uniforms;
    uniforms.depthMap!.value = targets.beauty.depthTexture;
    uniforms.beautyMap!.value = targets.beauty.texture;
  }

  private updateCompositeUniforms(
    targets: PipelineTargets,
    accumulatedEffects: THREE.WebGLRenderTarget,
    camera: THREE.PerspectiveCamera,
  ): void {
    const uniforms = this.compositeMaterial.uniforms;
    uniforms.beautyMap!.value = targets.beauty.texture;
    uniforms.depthMap!.value = targets.beauty.depthTexture;
    uniforms.effectsMap!.value = accumulatedEffects.texture;
    (uniforms.beautyTexel!.value as THREE.Vector2).set(
      1 / targets.beauty.width,
      1 / targets.beauty.height,
    );
    (uniforms.effectsTexel!.value as THREE.Vector2).set(
      1 / accumulatedEffects.width,
      1 / accumulatedEffects.height,
    );
    (uniforms.inverseProjectionMatrix!.value as THREE.Matrix4).copy(
      camera.projectionMatrixInverse,
    );
    (uniforms.cameraWorldMatrix!.value as THREE.Matrix4).copy(camera.matrixWorld);
    uniforms.cameraNear!.value = camera.near;
    uniforms.waterLevel!.value = this.options.waterReflection?.waterLevel ?? 0;
    uniforms.waterTime!.value = this.waterTimeSeconds;
    (uniforms.waterWorldOrigin!.value as THREE.Vector2).copy(this.waterWorldOrigin);
    uniforms.waterSurfaceDetailMap!.value =
      this.options.waterBathymetry?.surfaceDetailTexture ?? null;
    uniforms.waterDetailStrength!.value = this.profile.screenSpace.waterDetailStrength;
    uniforms.shorelineStrength!.value = this.profile.screenSpace.shorelineStrength;
    const bathymetry = this.options.waterBathymetry;
    uniforms.waterBathymetryMap!.value = bathymetry?.texture ?? null;
    const bathymetryBounds = uniforms.waterBathymetryBounds!.value as THREE.Vector4;
    if (bathymetry) bathymetryBounds.copy(bathymetry.bounds);
    else bathymetryBounds.set(0, 0, 0, 0);
    uniforms.waterBathymetryMaxDepth!.value = bathymetry?.maxDepth ?? 1;
    uniforms.waterBathymetryTexel!.value =
      1 / Math.max(1, bathymetry?.resolution ?? 1);
    uniforms.waterBathymetryValid!.value = bathymetry?.isValid() ? 1 : 0;
    uniforms.ssrStrength!.value = this.profile.screenSpace.ssrStrength;
  }
}
