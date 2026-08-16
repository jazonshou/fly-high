import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { MirrorTexture } from "@babylonjs/core/Materials/Textures/mirrorTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";

export const PLANAR_REFLECTION_SAMPLER = "planarReflection";
export const PLANAR_REFLECTION_UNIFORMS = [
  "planarReflectionViewProjection",
  "planarReflectionPlaneHeight",
  "planarReflectionStrength",
  "planarReflectionValid",
  "planarReflectionReceiverEnabled",
] as const;

/** Shared WGSL helper used by both deep-ocean and inland-water materials. */
export const PLANAR_REFLECTION_FRAGMENT_WGSL = /* wgsl */ `
var planarReflectionSampler: sampler;
var planarReflection: texture_2d<f32>;
uniform planarReflectionPlaneHeight: f32;
uniform planarReflectionStrength: f32;
uniform planarReflectionValid: f32;
uniform planarReflectionReceiverEnabled: f32;

fn samplePlanarSceneReflection(
  reflectionClip: vec4f,
  normal: vec3f,
  surfaceHeight: f32,
  atmosphereFallback: vec3f,
) -> vec3f {
  if (
    uniforms.planarReflectionValid < 0.5
    || uniforms.planarReflectionReceiverEnabled < 0.5
    || reflectionClip.w <= 0.0001
  ) {
    return atmosphereFallback;
  }
  let projected = reflectionClip.xy / reflectionClip.w;
  let distortion = vec2f(normal.x, -normal.z) * 0.0075;
  let uv = vec2f(projected.x * 0.5 + 0.5, 0.5 - projected.y * 0.5) + distortion;
  if (any(uv <= vec2f(0.001)) || any(uv >= vec2f(0.999))) {
    return atmosphereFallback;
  }
  let sceneReflection = textureSampleLevel(
    planarReflection,
    planarReflectionSampler,
    uv,
    0.0,
  );
  let edgeDistance = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
  let edgeConfidence = smoothstep(0.004, 0.035, edgeDistance);
  // One shared capture can serve the ocean or one nearby lake plane. Other
  // elevations retain the analytic atmosphere/cloud Fresnel response.
  let planeDistance = abs(surfaceHeight - uniforms.planarReflectionPlaneHeight);
  let planeConfidence = 1.0 - smoothstep(3.0, 12.0, planeDistance);
  let confidence = clamp(
    sceneReflection.a * uniforms.planarReflectionStrength
      * edgeConfidence * planeConfidence,
    0.0,
    1.0,
  );
  return mix(atmosphereFallback, sceneReflection.rgb, confidence);
}
`;

export interface PlanarReflectionBinding {
  readonly texture: BaseTexture;
  readonly viewProjection: Matrix;
  readonly planeHeight: number;
  readonly strength: number;
  readonly valid: boolean;
  readonly source: "ocean" | "lake";
}

/** Water materials implement this without owning the shared capture texture. */
export interface PlanarReflectionReceiver {
  setPlanarReflection(binding: PlanarReflectionBinding | null): void;
}

export interface PlanarReflectionBudget {
  readonly width: number;
  readonly height: number;
  /** A hard lower bound between capture attempts and successful updates. */
  readonly updateEveryNFrames: number;
  /** Leaves startup frames to the beauty-pass shader compilation path. */
  readonly warmupFrames: number;
  readonly strength: number;
}

export function resolvePlanarReflectionBudget(
  profile: Pick<WebGpuQualityProfile, "tier">,
): PlanarReflectionBudget {
  if (profile.tier === 0) {
    return {
      width: 192,
      height: 108,
      updateEveryNFrames: 8,
      warmupFrames: 8,
      strength: 0.48,
    };
  }
  if (profile.tier === 1) {
    return {
      width: 320,
      height: 180,
      updateEveryNFrames: 5,
      warmupFrames: 6,
      strength: 0.62,
    };
  }
  return {
    width: 480,
    height: 270,
    updateEveryNFrames: 3,
    warmupFrames: 4,
    strength: 0.72,
  };
}

export interface PlanarReflectionLake {
  readonly centerX: number;
  readonly centerZ: number;
  readonly surfaceHeight: number;
  readonly radiusMeters: number;
}

export interface PlanarReflectionObserver {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PlanarReflectionPlaneSelection {
  readonly height: number;
  readonly source: "ocean" | "lake";
  readonly lakeIndex: number | null;
}

const MINIMUM_LAKE_ANGULAR_RADIUS_RADIANS = 0.025;
const LAKE_RELEASE_DISTANCE_MULTIPLIER = 1.15;
const LAKE_RELEASE_ANGULAR_RADIUS_MULTIPLIER = 0.8;

export interface InlandPlanarReflectionReceiverInput {
  readonly source: "ocean" | "lake";
  readonly planeHeight: number;
  readonly isLakeMesh: boolean;
  readonly isCurrentRegion: boolean;
  readonly lakes: readonly Pick<PlanarReflectionLake, "surfaceHeight">[];
}

/** Prevents rivers and paging-retired lake geometry from consuming a lake capture. */
export function acceptsInlandPlanarReflection(
  input: InlandPlanarReflectionReceiverInput,
): boolean {
  return input.source === "lake"
    && input.isLakeMesh
    && input.isCurrentRegion
    && input.lakes.some(
      (lake) => Math.abs(lake.surfaceHeight - input.planeHeight) < 0.05,
    );
}

/**
 * Selects at most one horizontal plane for the shared capture. Lakes only win
 * while close enough to matter; every other water surface uses its analytic
 * sky/cloud fallback rather than sampling a geometrically incorrect plane.
 */
export function selectPlanarReflectionPlane(
  seaLevel: number,
  observer: PlanarReflectionObserver,
  lakes: readonly PlanarReflectionLake[],
  previousSelection: PlanarReflectionPlaneSelection | null = null,
  activationDistanceMeters = 900,
): PlanarReflectionPlaneSelection {
  if (!Number.isFinite(seaLevel)) throw new RangeError("Reflection sea level must be finite");
  if (![observer.x, observer.y, observer.z].every(Number.isFinite)) {
    throw new RangeError("Reflection observer must be finite");
  }
  const activationDistance = Math.max(
    0,
    Number.isFinite(activationDistanceMeters) ? activationDistanceMeters : 0,
  );
  let nearestIndex: number | null = null;
  let nearestEdgeDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < lakes.length; index += 1) {
    const lake = lakes[index];
    if (!lake || ![
      lake.centerX,
      lake.centerZ,
      lake.surfaceHeight,
      lake.radiusMeters,
    ].every(Number.isFinite)) continue;
    const centerDistance = Math.hypot(
      observer.x - lake.centerX,
      observer.z - lake.centerZ,
    );
    const radius = Math.max(0, lake.radiusMeters);
    const edgeDistance = Math.max(0, centerDistance - radius);
    const angularRadius = Math.atan2(
      radius,
      Math.hypot(centerDistance, observer.y - lake.surfaceHeight),
    );
    const retainsPreviousPlane = previousSelection?.source === "lake"
      && Math.abs(previousSelection.height - lake.surfaceHeight) < 0.05;
    const distanceLimit = activationDistance * (
      retainsPreviousPlane ? LAKE_RELEASE_DISTANCE_MULTIPLIER : 1
    );
    const angularLimit = MINIMUM_LAKE_ANGULAR_RADIUS_RADIANS * (
      retainsPreviousPlane ? LAKE_RELEASE_ANGULAR_RADIUS_MULTIPLIER : 1
    );
    if (
      edgeDistance > distanceLimit
      || angularRadius < angularLimit
      || edgeDistance >= nearestEdgeDistance
    ) continue;
    nearestIndex = index;
    nearestEdgeDistance = edgeDistance;
  }
  const nearest = nearestIndex === null ? null : lakes[nearestIndex];
  return nearest
    ? { height: nearest.surfaceHeight, source: "lake", lakeIndex: nearestIndex }
    : { height: seaLevel, source: "ocean", lakeIndex: null };
}

type ReflectionMetadata = {
  readonly excludePlanarReflection?: boolean;
  readonly waterSurface?: boolean;
};

/** Opaque-only capture predicate; it also prevents water-target recursion. */
export function isPlanarReflectionCaster(mesh: AbstractMesh): boolean {
  if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0) {
    return false;
  }
  if (mesh.infiniteDistance) return false;
  const metadata = mesh.metadata as ReflectionMetadata | null;
  if (metadata?.excludePlanarReflection || metadata?.waterSurface) return false;
  const material = mesh.material;
  return material !== null && !material.needAlphaBlendingForMesh(mesh);
}

export type PlanarReflectionUpdateReason =
  | "captured"
  | "cadence"
  | "warmup"
  | "below-plane"
  | "not-ready"
  | "disposed";

export interface PlanarReflectionUpdateResult {
  readonly captured: boolean;
  readonly reason: PlanarReflectionUpdateReason;
}

export interface PlanarReflectionFrame {
  readonly frameIndex: number;
  readonly cameraCut: boolean;
  readonly originShifted: boolean;
}

const INVALID_CAPTURE_FRAME = Number.NEGATIVE_INFINITY;
const CAMERA_PLANE_EPSILON_METERS = 0.05;

/**
 * One manually scheduled WebGPU mirror target shared by all water receivers.
 * It never joins scene.customRenderTargets, so the beauty pass cannot recurse.
 */
export class PlanarWaterReflectionSystem {
  private readonly target: MirrorTexture;
  private readonly receivers = new Set<PlanarReflectionReceiver>();
  private readonly captureViewProjection = Matrix.Identity();
  private readonly candidateViewProjection = Matrix.Identity();
  private budget: PlanarReflectionBudget;
  private planeHeight: number;
  private planeSource: "ocean" | "lake" = "ocean";
  private lastCaptureFrame = INVALID_CAPTURE_FRAME;
  private lastAttemptFrame = INVALID_CAPTURE_FRAME;
  private valid = false;
  private disposed = false;

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
    planeHeight: number,
    profile: Pick<WebGpuQualityProfile, "tier">,
    receivers: readonly PlanarReflectionReceiver[] = [],
  ) {
    if (!Number.isFinite(planeHeight)) {
      throw new RangeError("Planar-reflection height must be finite");
    }
    this.planeHeight = planeHeight;
    this.budget = resolvePlanarReflectionBudget(profile);
    const textureType = scene.getEngine().getCaps().textureHalfFloatRender
      ? Constants.TEXTURETYPE_HALF_FLOAT
      : Constants.TEXTURETYPE_UNSIGNED_BYTE;
    this.target = new MirrorTexture(
      "webgpu-shared-water-planar-reflection",
      { width: this.budget.width, height: this.budget.height },
      scene,
      false,
      textureType,
      Texture.BILINEAR_SAMPLINGMODE,
      true,
    );
    this.target.mirrorPlane = new Plane(0, -1, 0, planeHeight);
    this.target.clearColor = new Color4(0, 0, 0, 0);
    this.target.hasAlpha = true;
    this.target.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.target.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.target.anisotropicFilteringLevel = 1;
    this.target.samples = 1;
    this.target.renderParticles = false;
    this.target.renderSprites = false;
    this.target.enableOutlineRendering = false;
    this.target.useCameraPostProcesses = false;
    this.target.activeCamera = camera;
    this.target.cameraForLOD = camera;
    this.target.renderListPredicate = isPlanarReflectionCaster;
    // MirrorTexture installs its transform callback in its constructor. This
    // later observer therefore snapshots the exact reflected transform used by
    // the capture, before MirrorTexture restores the beauty-pass matrices.
    this.target.onBeforeRenderObservable.add(() => {
      this.candidateViewProjection.copyFrom(this.scene.getTransformMatrix());
    });
    for (const receiver of receivers) this.receivers.add(receiver);
    this.publish(false);
  }

  get texture(): BaseTexture {
    return this.target;
  }

  get currentBudget(): PlanarReflectionBudget {
    return this.budget;
  }

  get captureValid(): boolean {
    return this.valid;
  }

  addReceiver(receiver: PlanarReflectionReceiver): () => void {
    if (this.disposed) throw new Error("Planar-reflection system is disposed");
    this.receivers.add(receiver);
    receiver.setPlanarReflection(this.binding(this.valid));
    return () => {
      if (!this.receivers.delete(receiver)) return;
      receiver.setPlanarReflection(null);
    };
  }

  setProfile(profile: Pick<WebGpuQualityProfile, "tier">): void {
    if (this.disposed) return;
    const next = resolvePlanarReflectionBudget(profile);
    const resized = next.width !== this.budget.width || next.height !== this.budget.height;
    this.budget = next;
    if (resized) this.target.resize({ width: next.width, height: next.height });
    this.invalidate();
  }

  setPlaneHeight(height: number, source: "ocean" | "lake" = "ocean"): void {
    if (!Number.isFinite(height)) throw new RangeError("Planar-reflection height must be finite");
    if (Math.abs(height - this.planeHeight) < 0.01 && source === this.planeSource) return;
    this.planeHeight = height;
    this.planeSource = source;
    this.target.mirrorPlane = new Plane(0, -1, 0, height);
    this.invalidate();
  }

  invalidate(): void {
    if (this.disposed || !this.valid) return;
    this.valid = false;
    this.publish(false);
  }

  update(frame: PlanarReflectionFrame): PlanarReflectionUpdateResult {
    if (this.disposed) return { captured: false, reason: "disposed" };
    if (!Number.isInteger(frame.frameIndex) || frame.frameIndex < 0) {
      throw new RangeError("Planar-reflection frame index must be a non-negative integer");
    }
    if (frame.cameraCut || frame.originShifted) this.invalidate();
    // Camera.globalPosition is lazily refreshed by Babylon's view-matrix path;
    // this pass runs before Scene.render(), so force that inexpensive update.
    this.camera.getViewMatrix();
    if (this.camera.globalPosition.y <= this.planeHeight + CAMERA_PLANE_EPSILON_METERS) {
      this.invalidate();
      return { captured: false, reason: "below-plane" };
    }
    if (frame.frameIndex < this.budget.warmupFrames) {
      return { captured: false, reason: "warmup" };
    }
    const sinceCapture = frame.frameIndex - this.lastCaptureFrame;
    const sinceAttempt = frame.frameIndex - this.lastAttemptFrame;
    if (
      sinceCapture < this.budget.updateEveryNFrames
      || sinceAttempt < this.budget.updateEveryNFrames
    ) {
      return { captured: false, reason: "cadence" };
    }
    this.lastAttemptFrame = frame.frameIndex;
    try {
      const ready = this.withSceneStateRestored(() => this.target.isReadyForRendering());
      if (!ready) {
        this.invalidate();
        return { captured: false, reason: "not-ready" };
      }
      this.withSceneStateRestored(() => this.target.render(false, false));
      this.captureViewProjection.copyFrom(this.candidateViewProjection);
      this.lastCaptureFrame = frame.frameIndex;
      this.valid = true;
      this.publish(true);
      return { captured: true, reason: "captured" };
    } catch (error) {
      this.invalidate();
      console.warn("Unable to update the shared planar water reflection", error);
      return { captured: false, reason: "not-ready" };
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.valid = false;
    for (const receiver of this.receivers) receiver.setPlanarReflection(null);
    this.receivers.clear();
    this.target.dispose();
  }

  private binding(valid: boolean): PlanarReflectionBinding {
    return {
      texture: this.target,
      viewProjection: this.captureViewProjection,
      planeHeight: this.planeHeight,
      strength: this.budget.strength,
      valid,
      source: this.planeSource,
    };
  }

  private publish(valid: boolean): void {
    const binding = this.binding(valid);
    for (const receiver of this.receivers) receiver.setPlanarReflection(binding);
  }

  /** MirrorTexture restores these on its normal path; this closes exception paths too. */
  private withSceneStateRestored<T>(operation: () => T): T {
    const engine: AbstractEngine = this.scene.getEngine();
    const view = this.scene.getViewMatrix().clone();
    const projection = this.scene.getProjectionMatrix().clone();
    const clipPlane = this.scene.clipPlane;
    const activeCamera = this.scene.activeCamera;
    const mirroredCameraPosition = this.scene._mirroredCameraPosition;
    const forcedViewPosition = this.scene._forcedViewPosition;
    const sceneUniformBuffer = this.scene.getSceneUniformBuffer();
    const renderPassId = engine.currentRenderPassId;
    const applyByPostProcess = this.scene.imageProcessingConfiguration._applyByPostProcess;
    let completed = false;
    try {
      const result = operation();
      completed = true;
      return result;
    } finally {
      if (!completed) engine.restoreDefaultFramebuffer();
      this.scene.clipPlane = clipPlane;
      this.scene._mirroredCameraPosition = mirroredCameraPosition;
      this.scene._forcedViewPosition = forcedViewPosition;
      this.scene._activeCamera = activeCamera;
      this.scene.setSceneUniformBuffer(sceneUniformBuffer);
      this.scene.imageProcessingConfiguration._applyByPostProcess = applyByPostProcess;
      engine.currentRenderPassId = renderPassId;
      this.scene.setTransformMatrix(view, projection);
      if (activeCamera) engine.setViewport(activeCamera.viewport);
      this.scene.resetCachedMaterial();
    }
  }
}
