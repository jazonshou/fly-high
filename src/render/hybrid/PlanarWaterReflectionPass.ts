import * as THREE from "three";
import type {
  HybridTargetFormat,
  PlanarReflectionBudget,
} from "./RenderProfile";
import {
  captureWebGLRendererState,
  restoreWebGLRendererState,
} from "./RendererState";

const REFLECTION_BIAS_MATRIX = new THREE.Matrix4().set(
  0.5, 0, 0, 0.5,
  0, 0.5, 0, 0.5,
  0, 0, 0.5, 0.5,
  0, 0, 0, 1,
);

export interface PlanarWaterReflectionBindings {
  readonly waterLevel: number;
  withWaterHidden<T>(render: () => T): T;
  setReflection(
    texture: THREE.Texture | null,
    textureMatrix?: THREE.Matrix4,
    strength?: number,
  ): void;
}

export interface PlanarWaterReflectionPassOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  bindings: PlanarWaterReflectionBindings;
  budget: PlanarReflectionBudget;
  colorFormat: HybridTargetFormat;
  clipBias?: number;
  /** Enables renderer-specific layers (for example CSM light layer 29). */
  prepareReflectionCamera?: (camera: THREE.PerspectiveCamera) => void;
  /** Optional inverse hook for integrations that retain external camera state. */
  releaseReflectionCamera?: (camera: THREE.PerspectiveCamera) => void;
}

export interface PlanarReflectionResult {
  rendered: boolean;
  reason: "rendered" | "cadence" | "below-water" | "disabled";
}

export interface PlanarReflectionConfidenceInput {
  cameraHeightAboveWater: number;
  captureAgeMs: number;
  cadenceMs: number;
  translationSinceCapture: number;
  rotationSinceCapture: number;
}

function finiteNonNegative(value: number): number {
  if (value === Number.POSITIVE_INFINITY) return Number.MAX_VALUE;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

/**
 * Confidence for reusing a planar capture. It fades continuously at the water
 * plane and under stale/large camera motion, avoiding binary texture toggles.
 */
export function planarReflectionConfidence(
  input: PlanarReflectionConfidenceInput,
): number {
  const height = finiteNonNegative(input.cameraHeightAboveWater);
  if (height <= 0.02) return 0;
  const cadence = Math.max(1, finiteNonNegative(input.cadenceMs));
  const age = finiteNonNegative(input.captureAgeMs);
  const translation = finiteNonNegative(input.translationSinceCapture);
  const rotation = finiteNonNegative(input.rotationSinceCapture);
  const altitudeConfidence = smoothstep(0.02, 0.42, height);
  const ageFade = smoothstep(cadence * 1.35, cadence * 4.8, age);
  const ageConfidence = 1 - ageFade * 0.84;
  // Capture-time projection is intentionally reused for a few frames. A
  // strong per-frame motion fade made its strength pulse down between captures
  // and jump back to one at every refresh, which was more visible than the
  // small bounded projection error. Large motion still triggers the early
  // refresh in render(); this confidence only softens genuinely stale reuse.
  const translationScale = 320 + Math.sqrt(Math.min(height, 10_000)) * 8;
  const motionConfidence = Math.exp(
    -translation / translationScale - rotation * 0.72,
  );
  return THREE.MathUtils.clamp(
    altitudeConfidence * ageConfidence * motionConfidence,
    0,
    1,
  );
}

/** Reflect a position or direction across a horizontal plane. */
export function reflectAcrossHorizontalPlane(
  target: THREE.Vector3,
  source: THREE.Vector3,
  waterLevel: number,
  direction = false,
): THREE.Vector3 {
  target.copy(source);
  target.y = direction ? -source.y : waterLevel * 2 - source.y;
  return target;
}

/**
 * Applies Eric Lengyel's oblique near-plane projection. The supplied plane is
 * expressed in scene coordinates and the camera projection is mutated.
 */
export function applyObliqueClippingPlane(
  camera: THREE.PerspectiveCamera,
  scenePlane: THREE.Plane,
  clipBias: number,
): THREE.Vector4 {
  const cameraPlane = scenePlane.clone().applyMatrix4(camera.matrixWorldInverse);
  const clipPlane = new THREE.Vector4(
    cameraPlane.normal.x,
    cameraPlane.normal.y,
    cameraPlane.normal.z,
    cameraPlane.constant,
  );
  const elements = camera.projectionMatrix.elements;
  const q = new THREE.Vector4(
    (Math.sign(clipPlane.x) + (elements[8] ?? 0)) / (elements[0] ?? 1),
    (Math.sign(clipPlane.y) + (elements[9] ?? 0)) / (elements[5] ?? 1),
    -1,
    (1 + (elements[10] ?? 0)) / (elements[14] ?? -1),
  );
  const denominator = clipPlane.dot(q);
  if (Math.abs(denominator) < 1e-8) return clipPlane;
  clipPlane.multiplyScalar(2 / denominator);
  elements[2] = clipPlane.x;
  elements[6] = clipPlane.y;
  elements[10] = clipPlane.z + 1 - clipBias;
  elements[14] = clipPlane.w;
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  return clipPlane;
}

/**
 * Configures a camera and projective texture matrix without modifying the
 * source camera. The matrix consumes scene-space water positions directly.
 */
export function configureHorizontalReflectionCamera(
  source: THREE.PerspectiveCamera,
  reflection: THREE.PerspectiveCamera,
  waterLevel: number,
  textureMatrix: THREE.Matrix4,
  clipBias = 0.002,
): void {
  source.updateMatrixWorld();
  const sourcePosition = source.getWorldPosition(new THREE.Vector3());
  const sourceDirection = source.getWorldDirection(new THREE.Vector3());
  const sourceUp = new THREE.Vector3(0, 1, 0).applyQuaternion(
    source.getWorldQuaternion(new THREE.Quaternion()),
  );
  const reflectedPosition = reflectAcrossHorizontalPlane(
    new THREE.Vector3(),
    sourcePosition,
    waterLevel,
  );
  const sourceTarget = sourcePosition.clone().add(sourceDirection);
  const reflectedTarget = reflectAcrossHorizontalPlane(
    new THREE.Vector3(),
    sourceTarget,
    waterLevel,
  );
  const reflectedUp = reflectAcrossHorizontalPlane(
    new THREE.Vector3(),
    sourceUp,
    0,
    true,
  ).normalize();

  reflection.copy(source, false);
  reflection.position.copy(reflectedPosition);
  reflection.up.copy(reflectedUp);
  reflection.lookAt(reflectedTarget);
  reflection.updateMatrixWorld();
  reflection.projectionMatrix.copy(source.projectionMatrix);
  reflection.projectionMatrixInverse.copy(source.projectionMatrixInverse);

  // Use the unclipped projection for stable projective UVs, like Three's
  // Reflector. The oblique projection is only needed by the capture draw.
  textureMatrix.copy(REFLECTION_BIAS_MATRIX)
    .multiply(reflection.projectionMatrix)
    .multiply(reflection.matrixWorldInverse);
  applyObliqueClippingPlane(
    reflection,
    new THREE.Plane(new THREE.Vector3(0, 1, 0), -waterLevel),
    clipBias,
  );
}

function createReflectionTarget(
  width: number,
  height: number,
  format: HybridTargetFormat,
): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: true,
    stencilBuffer: false,
    type: format === "rgba16f" ? THREE.HalfFloatType : THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
  });
  target.texture.name = "hybrid-planar-water-reflection";
  target.texture.colorSpace = THREE.LinearSRGBColorSpace;
  return target;
}

export class PlanarWaterReflectionPass {
  readonly reflectionCamera = new THREE.PerspectiveCamera();
  readonly textureMatrix = new THREE.Matrix4();

  private target: THREE.WebGLRenderTarget;
  private readonly candidateTextureMatrix = new THREE.Matrix4();
  private readonly capturePosition = new THREE.Vector3();
  private readonly captureQuaternion = new THREE.Quaternion();
  private budget: PlanarReflectionBudget;
  private colorFormat: HybridTargetFormat;
  private lastRenderTime = Number.NEGATIVE_INFINITY;
  private hasValidCapture = false;
  private lastConfidence = 0;
  private disposed = false;
  private readonly clipBias: number;

  constructor(private readonly options: PlanarWaterReflectionPassOptions) {
    this.budget = { ...options.budget };
    this.colorFormat = options.colorFormat;
    this.clipBias = options.clipBias ?? 0.002;
    this.target = createReflectionTarget(
      Math.max(1, this.budget.width),
      Math.max(1, this.budget.height),
      this.colorFormat,
    );
  }

  get texture(): THREE.Texture {
    return this.target.texture;
  }

  /** Normalized confidence currently applied to the cached capture. */
  get confidence(): number {
    return this.lastConfidence;
  }

  /** Allocate and validate the attachment before a transactional graph swap. */
  initialize(): void {
    if (this.disposed) return;
    this.options.renderer.initRenderTarget(this.target);
  }

  setBudget(budget: PlanarReflectionBudget, colorFormat: HybridTargetFormat): void {
    if (this.disposed) return;
    const formatChanged = colorFormat !== this.colorFormat;
    const dimensionsChanged =
      Math.max(1, budget.width) !== this.target.width ||
      Math.max(1, budget.height) !== this.target.height;
    this.budget = { ...budget };
    if (formatChanged) {
      const previous = this.target;
      this.colorFormat = colorFormat;
      this.target = createReflectionTarget(
        Math.max(1, budget.width),
        Math.max(1, budget.height),
        colorFormat,
      );
      previous.dispose();
      this.lastRenderTime = Number.NEGATIVE_INFINITY;
      this.hasValidCapture = false;
      this.lastConfidence = 0;
      this.options.bindings.setReflection(null);
      return;
    }
    if (dimensionsChanged) {
      this.target.setSize(Math.max(1, budget.width), Math.max(1, budget.height));
      // setSize reallocates the attachment, so the previous pixels are no
      // longer a valid capture even though the Texture object is unchanged.
      this.lastRenderTime = Number.NEGATIVE_INFINITY;
      this.hasValidCapture = false;
      this.lastConfidence = 0;
      this.options.bindings.setReflection(null);
      return;
    }
    if (!budget.enabled) {
      this.hasValidCapture = false;
      this.lastConfidence = 0;
      this.lastRenderTime = Number.NEGATIVE_INFINITY;
      this.options.bindings.setReflection(null);
    } else if (this.hasValidCapture) {
      this.options.bindings.setReflection(
        this.target.texture,
        this.textureMatrix,
        this.budget.strength * this.lastConfidence,
      );
    }
  }

  invalidate(): void {
    this.lastRenderTime = Number.NEGATIVE_INFINITY;
  }

  render(
    sourceCamera: THREE.PerspectiveCamera,
    nowMs: number,
    force = false,
  ): PlanarReflectionResult {
    if (this.disposed || !this.budget.enabled) {
      this.lastConfidence = 0;
      this.options.bindings.setReflection(null);
      return { rendered: false, reason: "disabled" };
    }
    sourceCamera.updateMatrixWorld();
    const cameraPosition = sourceCamera.getWorldPosition(new THREE.Vector3());
    const cameraQuaternion = sourceCamera.getWorldQuaternion(new THREE.Quaternion());
    const cameraHeight = cameraPosition.y - this.options.bindings.waterLevel;
    if (cameraHeight <= 0.02) {
      this.lastConfidence = 0;
      if (this.hasValidCapture) {
        this.options.bindings.setReflection(
          this.target.texture,
          this.textureMatrix,
          0,
        );
      } else {
        this.options.bindings.setReflection(null);
      }
      return { rendered: false, reason: "below-water" };
    }
    const safeNow = Number.isFinite(nowMs)
      ? Math.max(0, nowMs)
      : Number.isFinite(this.lastRenderTime)
        ? this.lastRenderTime + this.budget.cadenceMs
        : 0;
    const captureAge = this.hasValidCapture
      ? Math.max(0, safeNow - this.lastRenderTime)
      : Number.POSITIVE_INFINITY;
    const translation = this.hasValidCapture
      ? cameraPosition.distanceTo(this.capturePosition)
      : Number.POSITIVE_INFINITY;
    const rotation = this.hasValidCapture
      ? 2 * Math.acos(Math.min(1, Math.abs(cameraQuaternion.dot(this.captureQuaternion))))
      : Number.POSITIVE_INFINITY;
    const minimumMotionRefreshAge = Math.min(this.budget.cadenceMs * 0.42, 28);
    const translationRefresh = Math.max(8, Math.min(45, cameraHeight * 0.04));
    const motionRefresh = this.hasValidCapture &&
      captureAge >= minimumMotionRefreshAge &&
      (translation > translationRefresh || rotation > 0.055);
    if (!force &&
        this.hasValidCapture &&
        captureAge < this.budget.cadenceMs &&
        !motionRefresh) {
      this.lastConfidence = planarReflectionConfidence({
        cameraHeightAboveWater: cameraHeight,
        captureAgeMs: captureAge,
        cadenceMs: this.budget.cadenceMs,
        translationSinceCapture: translation,
        rotationSinceCapture: rotation,
      });
      this.options.bindings.setReflection(
        this.target.texture,
        this.textureMatrix,
        this.budget.strength * this.lastConfidence,
      );
      return { rendered: false, reason: "cadence" };
    }

    configureHorizontalReflectionCamera(
      sourceCamera,
      this.reflectionCamera,
      this.options.bindings.waterLevel,
      this.candidateTextureMatrix,
      this.clipBias,
    );
    this.options.prepareReflectionCamera?.(this.reflectionCamera);
    const renderer = this.options.renderer;
    const saved = captureWebGLRendererState(renderer);
    try {
      renderer.xr.enabled = false;
      // Reuse the main camera's current shadow maps. Otherwise a reflection
      // capture followed by the beauty pass renders every cascade twice.
      renderer.shadowMap.autoUpdate = false;
      renderer.autoClear = false;
      renderer.setRenderTarget(this.target);
      renderer.setViewport(0, 0, this.target.width, this.target.height);
      renderer.setScissorTest(false);
      renderer.clear(true, true, false);
      // The clear and draw overwrite the only bounded reflection attachment.
      // Do not advertise it as reusable until the entire capture and binding
      // callback have succeeded.
      this.hasValidCapture = false;
      this.lastConfidence = 0;
      this.options.bindings.withWaterHidden(() => {
        renderer.render(this.options.scene, this.reflectionCamera);
      });
      const captureConfidence = planarReflectionConfidence({
        cameraHeightAboveWater: cameraHeight,
        captureAgeMs: 0,
        cadenceMs: this.budget.cadenceMs,
        translationSinceCapture: 0,
        rotationSinceCapture: 0,
      });
      this.textureMatrix.copy(this.candidateTextureMatrix);
      this.options.bindings.setReflection(
        this.target.texture,
        this.textureMatrix,
        this.budget.strength * captureConfidence,
      );
      // Commit cadence state only after setReflection succeeds; failed callers
      // can retry immediately rather than being held behind a stale interval.
      this.lastRenderTime = safeNow;
      this.capturePosition.copy(cameraPosition);
      this.captureQuaternion.copy(cameraQuaternion);
      this.hasValidCapture = true;
      this.lastConfidence = captureConfidence;
      return { rendered: true, reason: "rendered" };
    } finally {
      restoreWebGLRendererState(renderer, saved);
    }
  }

  dispose(clearBinding = true): void {
    if (this.disposed) return;
    this.disposed = true;
    if (clearBinding) this.options.bindings.setReflection(null);
    this.options.releaseReflectionCamera?.(this.reflectionCamera);
    this.target.dispose();
  }
}
