import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { BathymetryField } from "../src/render/BathymetryField";
import {
  HybridRenderPipeline,
  buildHybridPassOrder,
} from "../src/render/hybrid/HybridRenderPipeline";
import {
  HYBRID_COMPOSITE_FRAGMENT_SHADER,
  HYBRID_EFFECT_FRAGMENT_SHADER,
  HYBRID_SURFACE_HISTORY_FRAGMENT_SHADER,
  HYBRID_TEMPORAL_FRAGMENT_SHADER,
} from "../src/render/hybrid/HybridShaders";
import {
  PlanarWaterReflectionPass,
  configureHorizontalReflectionCamera,
  planarReflectionConfidence,
  reflectAcrossHorizontalPlane,
  type PlanarWaterReflectionBindings,
} from "../src/render/hybrid/PlanarWaterReflectionPass";
import {
  detectRenderCapabilities,
  type HybridRenderCapabilities,
} from "../src/render/hybrid/RenderCapabilities";
import { resolveRenderProfile } from "../src/render/hybrid/RenderProfile";

const CAPABILITIES: HybridRenderCapabilities = {
  backend: "webgl2",
  webGpuApiAvailable: false,
  hardwareRayTracing: false,
  colorBufferFloat: true,
  floatLinearFiltering: true,
  timerQueries: true,
  parallelShaderCompile: true,
  anisotropicFiltering: true,
  maxTextureSize: 8_192,
  maxRenderbufferSize: 8_192,
  maxDrawBuffers: 4,
  maxColorAttachments: 4,
  maxSamples: 4,
  maxFragmentTextureUnits: 16,
};

interface FakeRendererState {
  target: THREE.WebGLRenderTarget | null;
  cubeFace: number;
  mipLevel: number;
  viewport: THREE.Vector4;
  scissor: THREE.Vector4;
  scissorTest: boolean;
  clearColor: THREE.Color;
  clearAlpha: number;
  renderCalls: number;
  clearCalls: number;
  throwOnRenderCall: number | null;
  initializedTargets: number;
  throwOnTargetWidth: number | null;
}

function fakeRenderer(initialTarget: THREE.WebGLRenderTarget | null = null): {
  renderer: THREE.WebGLRenderer;
  state: FakeRendererState;
} {
  const state: FakeRendererState = {
    target: initialTarget,
    cubeFace: 2,
    mipLevel: 1,
    viewport: new THREE.Vector4(7, 9, 311, 173),
    scissor: new THREE.Vector4(11, 13, 211, 127),
    scissorTest: true,
    clearColor: new THREE.Color(0x214365),
    clearAlpha: 0.63,
    renderCalls: 0,
    clearCalls: 0,
    throwOnRenderCall: null,
    initializedTargets: 0,
    throwOnTargetWidth: null,
  };
  const renderer = {
    autoClear: true,
    xr: { enabled: true },
    shadowMap: { autoUpdate: true, needsUpdate: true },
    getRenderTarget: () => state.target,
    getActiveCubeFace: () => state.cubeFace,
    getActiveMipmapLevel: () => state.mipLevel,
    setRenderTarget: (
      target: THREE.WebGLRenderTarget | null,
      cubeFace = 0,
      mipLevel = 0,
    ) => {
      state.target = target;
      state.cubeFace = cubeFace;
      state.mipLevel = mipLevel;
    },
    getViewport: (target: THREE.Vector4) => target.copy(state.viewport),
    setViewport: (x: THREE.Vector4 | number, y?: number, width?: number, height?: number) => {
      if (x instanceof THREE.Vector4) state.viewport.copy(x);
      else state.viewport.set(x, y ?? 0, width ?? 1, height ?? 1);
    },
    getScissor: (target: THREE.Vector4) => target.copy(state.scissor),
    setScissor: (x: THREE.Vector4 | number, y?: number, width?: number, height?: number) => {
      if (x instanceof THREE.Vector4) state.scissor.copy(x);
      else state.scissor.set(x, y ?? 0, width ?? 1, height ?? 1);
    },
    getScissorTest: () => state.scissorTest,
    setScissorTest: (enabled: boolean) => {
      state.scissorTest = enabled;
    },
    getClearColor: (target: THREE.Color) => target.copy(state.clearColor),
    setClearColor: (color: THREE.Color, alpha?: number) => {
      state.clearColor.copy(color);
      if (alpha !== undefined) state.clearAlpha = alpha;
    },
    getClearAlpha: () => state.clearAlpha,
    clear: () => {
      state.clearCalls += 1;
    },
    initRenderTarget: (target: THREE.WebGLRenderTarget) => {
      state.initializedTargets += 1;
      if (target.width === state.throwOnTargetWidth) {
        throw new Error("synthetic target allocation failure");
      }
    },
    render: () => {
      state.renderCalls += 1;
      if (state.throwOnRenderCall === state.renderCalls) {
        throw new Error("synthetic render failure");
      }
    },
  } as unknown as THREE.WebGLRenderer;
  return { renderer, state };
}

function expectRendererState(
  renderer: THREE.WebGLRenderer,
  state: FakeRendererState,
  expectedTarget: THREE.WebGLRenderTarget,
): void {
  expect(state.target).toBe(expectedTarget);
  expect(state.cubeFace).toBe(2);
  expect(state.mipLevel).toBe(1);
  expect(state.viewport.toArray()).toEqual([7, 9, 311, 173]);
  expect(state.scissor.toArray()).toEqual([11, 13, 211, 127]);
  expect(state.scissorTest).toBe(true);
  expect(state.clearColor.getHex()).toBe(0x214365);
  expect(state.clearAlpha).toBeCloseTo(0.63, 8);
  expect(renderer.autoClear).toBe(true);
  expect(renderer.xr.enabled).toBe(true);
  expect(renderer.shadowMap.autoUpdate).toBe(true);
  expect(renderer.shadowMap.needsUpdate).toBe(true);
}

describe("hybrid capability detection", () => {
  it("reads only the supplied WebGL2 context and treats WebGPU as informational", () => {
    const extensions = new Set([
      "EXT_color_buffer_float",
      "OES_texture_float_linear",
      "EXT_disjoint_timer_query_webgl2",
    ]);
    const limits = new Map<number, number>([
      [0x0d33, 4_096],
      [0x84e8, 2_048],
      [0x8824, 4],
      [0x8cdf, 4],
      [0x8d57, 8],
      [0x8872, 16],
    ]);
    const context = {
      MAX_TEXTURE_SIZE: 0x0d33,
      MAX_RENDERBUFFER_SIZE: 0x84e8,
      MAX_DRAW_BUFFERS: 0x8824,
      MAX_COLOR_ATTACHMENTS: 0x8cdf,
      MAX_SAMPLES: 0x8d57,
      MAX_TEXTURE_IMAGE_UNITS: 0x8872,
      getExtension: (name: string) => extensions.has(name) ? {} : null,
      getParameter: (parameter: number) => limits.get(parameter) ?? null,
    } as unknown as WebGL2RenderingContext;

    const result = detectRenderCapabilities(context, { gpu: {} });
    expect(result.backend).toBe("webgl2");
    expect(result.webGpuApiAvailable).toBe(true);
    expect(result.hardwareRayTracing).toBe(false);
    expect(result.colorBufferFloat).toBe(true);
    expect(result.floatLinearFiltering).toBe(true);
    expect(result.timerQueries).toBe(true);
    expect(result.maxTextureSize).toBe(4_096);
    expect(result.maxRenderbufferSize).toBe(2_048);
  });

  it("uses conservative finite fallbacks for broken capability queries", () => {
    const context = {
      MAX_TEXTURE_SIZE: 1,
      MAX_RENDERBUFFER_SIZE: 2,
      MAX_DRAW_BUFFERS: 3,
      MAX_COLOR_ATTACHMENTS: 4,
      MAX_SAMPLES: 5,
      MAX_TEXTURE_IMAGE_UNITS: 6,
      getExtension: () => null,
      getParameter: () => null,
    } as unknown as WebGL2RenderingContext;
    const result = detectRenderCapabilities(context, undefined);
    expect(result.colorBufferFloat).toBe(false);
    expect(result.maxTextureSize).toBe(2_048);
    expect(result.maxDrawBuffers).toBe(1);
    expect(result.maxFragmentTextureUnits).toBe(8);
    expect(result.hardwareRayTracing).toBe(false);
  });
});

describe("bounded hybrid render profiles", () => {
  it("keeps balanced mode allocation-free and on the forward path", () => {
    const profile = resolveRenderProfile(
      { renderingMode: "balanced", quality: "medium", outputWidth: 1_920, outputHeight: 1_080 },
      CAPABILITIES,
    );
    expect(profile.bypass).toBe(true);
    expect(profile.memory.estimatedBytes).toBe(0);
    expect(buildHybridPassOrder(profile)).toEqual(["forward"]);
  });

  it("uses exact half-resolution effects and raises bounded ray-march work", () => {
    const hybrid = resolveRenderProfile(
      { renderingMode: "hybrid", quality: "high", outputWidth: 1_920, outputHeight: 1_080 },
      CAPABILITIES,
    );
    const rayMarched = resolveRenderProfile(
      { renderingMode: "ray-traced", quality: "high", outputWidth: 1_920, outputHeight: 1_080 },
      CAPABILITIES,
    );
    expect(hybrid.effectsWidth).toBe(Math.ceil(hybrid.beautyWidth / 2));
    expect(hybrid.effectsHeight).toBe(Math.ceil(hybrid.beautyHeight / 2));
    expect(rayMarched.screenSpace.ssrSteps).toBeGreaterThan(hybrid.screenSpace.ssrSteps);
    expect(rayMarched.screenSpace.aoTaps).toBeGreaterThan(hybrid.screenSpace.aoTaps);
    expect(rayMarched.screenSpace.waterDetailStrength).toBeGreaterThan(
      hybrid.screenSpace.waterDetailStrength,
    );
    expect(rayMarched.screenSpace.shorelineStrength).toBeGreaterThan(
      hybrid.screenSpace.shorelineStrength,
    );
    expect(hybrid.screenSpace.waterTemporalHistoryWeight).toBeLessThan(
      hybrid.screenSpace.temporalHistoryWeight,
    );
    expect(rayMarched.technique).toBe("ray-marched-screen-space");
    expect(rayMarched.requestedMode).toBe("ray-traced");
    expect(rayMarched.activeMode).toBe("hybrid");
    expect(rayMarched.downgradeReasons).toContain(
      "No WebGPU ray-query backend is active; using half-resolution screen-space ray marching.",
    );
    expect(hybrid.screenSpace.waterDetailStrength).toBeLessThanOrEqual(1);
    expect(rayMarched.screenSpace.waterDetailStrength).toBeLessThanOrEqual(1);
    expect(rayMarched.technique).toBe("ray-marched-screen-space");
    expect(rayMarched.memory.estimatedBytes).toBeLessThanOrEqual(rayMarched.memory.capBytes);
    expect(rayMarched.planar.width).toBeLessThanOrEqual(1_920);
    expect(rayMarched.planar.height).toBeLessThanOrEqual(1_080);
    expect(hybrid.planar.strength).toBeLessThanOrEqual(0.66);
    expect(rayMarched.planar.strength).toBeLessThanOrEqual(0.74);
    expect(hybrid.screenSpace.ssrStrength).toBeLessThanOrEqual(0.09);
    expect(rayMarched.screenSpace.ssrStrength).toBeLessThanOrEqual(0.22);
    expect(rayMarched.screenSpace.waterTemporalHistoryWeight).toBeLessThanOrEqual(0.55);
    // Two refinement taps plus four hit-normal taps follow the bounded
    // half-resolution march, and only run after a crossing is confirmed.
    expect(rayMarched.screenSpace.ssrSteps + 6).toBeLessThanOrEqual(34);
  });

  it("caps oversized targets and downgrades filtered half-float safely", () => {
    const constrained: HybridRenderCapabilities = {
      ...CAPABILITIES,
      colorBufferFloat: false,
      floatLinearFiltering: false,
      maxTextureSize: 1_024,
      maxRenderbufferSize: 768,
    };
    const profile = resolveRenderProfile(
      { renderingMode: "ray-traced", quality: "high", outputWidth: 7_680, outputHeight: 4_320 },
      constrained,
    );
    expect(profile.colorFormat).toBe("rgba8");
    expect(profile.beautyWidth).toBeLessThanOrEqual(768);
    expect(profile.beautyHeight).toBeLessThanOrEqual(768);
    expect(profile.memory.estimatedBytes).toBeLessThanOrEqual(profile.memory.capBytes);
    expect(profile.downgradeReasons.join(" ")).toContain("RGBA8");
  });
});

describe("planar reflection math and state", () => {
  it("keeps reuse confidence finite and monotonic across surface, age, and motion", () => {
    const confidence = (overrides: Partial<Parameters<typeof planarReflectionConfidence>[0]>) =>
      planarReflectionConfidence({
        cameraHeightAboveWater: 12,
        captureAgeMs: 0,
        cadenceMs: 50,
        translationSinceCapture: 0,
        rotationSinceCapture: 0,
        ...overrides,
      });
    expect(confidence({ cameraHeightAboveWater: -1 })).toBe(0);
    expect(confidence({ cameraHeightAboveWater: 0.02 })).toBe(0);
    expect(confidence({ cameraHeightAboveWater: 0.08 })).toBeLessThan(
      confidence({ cameraHeightAboveWater: 0.3 }),
    );
    expect(confidence({ captureAgeMs: 300 })).toBeLessThan(
      confidence({ captureAgeMs: 20 }),
    );
    expect(confidence({ translationSinceCapture: 100 })).toBeLessThan(
      confidence({ translationSinceCapture: 4 }),
    );
    expect(confidence({ rotationSinceCapture: 0.4 })).toBeLessThan(
      confidence({ rotationSinceCapture: 0.02 }),
    );
    for (const value of [
      confidence({ cameraHeightAboveWater: Number.NaN }),
      confidence({ captureAgeMs: Number.POSITIVE_INFINITY }),
      confidence({ translationSinceCapture: Number.POSITIVE_INFINITY }),
      confidence({ rotationSinceCapture: Number.NaN }),
    ]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("mirrors camera position, direction, and up without mutating the source", () => {
    const source = new THREE.PerspectiveCamera(62, 16 / 9, 0.08, 32_000);
    source.position.set(2, 10, 3);
    source.up.set(0.1, 0.98, 0.12).normalize();
    source.lookAt(8, 1, -20);
    source.updateMatrixWorld();
    const originalPosition = source.position.clone();
    const originalDirection = source.getWorldDirection(new THREE.Vector3());
    const originalWorldUp = new THREE.Vector3(0, 1, 0).applyQuaternion(
      source.getWorldQuaternion(new THREE.Quaternion()),
    );
    const reflected = new THREE.PerspectiveCamera();
    const textureMatrix = new THREE.Matrix4();
    configureHorizontalReflectionCamera(source, reflected, 0.14, textureMatrix);

    expect(reflected.position.x).toBeCloseTo(2, 8);
    expect(reflected.position.y).toBeCloseTo(0.28 - 10, 8);
    expect(reflected.position.z).toBeCloseTo(3, 8);
    const reflectedDirection = reflected.getWorldDirection(new THREE.Vector3());
    expect(reflectedDirection.x).toBeCloseTo(originalDirection.x, 6);
    expect(reflectedDirection.y).toBeCloseTo(-originalDirection.y, 6);
    expect(reflectedDirection.z).toBeCloseTo(originalDirection.z, 6);
    const reflectedWorldUp = new THREE.Vector3(0, 1, 0).applyQuaternion(
      reflected.getWorldQuaternion(new THREE.Quaternion()),
    );
    expect(reflectedWorldUp.x).toBeCloseTo(originalWorldUp.x, 6);
    expect(reflectedWorldUp.y).toBeCloseTo(-originalWorldUp.y, 6);
    expect(reflectedWorldUp.z).toBeCloseTo(originalWorldUp.z, 6);
    expect(source.position.toArray()).toEqual(originalPosition.toArray());
    expect(textureMatrix.elements.every(Number.isFinite)).toBe(true);
    expect(reflected.projectionMatrix.equals(source.projectionMatrix)).toBe(false);
    expect(
      reflectAcrossHorizontalPlane(new THREE.Vector3(), new THREE.Vector3(1, 4, 2), 1).toArray(),
    ).toEqual([1, -2, 2]);
  });

  it("enforces cadence and restores renderer and water state on success or failure", () => {
    const savedTarget = new THREE.WebGLRenderTarget(4, 4);
    const { renderer, state } = fakeRenderer(savedTarget);
    let waterVisible = true;
    let assignedTexture: THREE.Texture | null = null;
    const assignedStrengths: number[] = [];
    const assignedMatrices: THREE.Matrix4[] = [];
    const bindings: PlanarWaterReflectionBindings = {
      waterLevel: 0.14,
      withWaterHidden: (render) => {
        const previous = waterVisible;
        waterVisible = false;
        try {
          return render();
        } finally {
          waterVisible = previous;
        }
      },
      setReflection: (texture, matrix, strength) => {
        assignedTexture = texture;
        if (matrix) assignedMatrices.push(matrix.clone());
        if (strength !== undefined) assignedStrengths.push(strength);
      },
    };
    const pass = new PlanarWaterReflectionPass({
      renderer,
      scene: new THREE.Scene(),
      bindings,
      budget: { enabled: true, width: 320, height: 180, cadenceMs: 50, strength: 0.8 },
      colorFormat: "rgba8",
    });
    const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.08, 32_000);
    camera.position.set(0, 20, 0);
    camera.lookAt(10, 0, 0);
    const first = pass.render(camera, 100);
    expect(first).toEqual({ rendered: true, reason: "rendered" });
    expect(waterVisible).toBe(true);
    expect(assignedTexture).toBe(pass.texture);
    expectRendererState(renderer, state, savedTarget);
    const callsAfterFirst = state.renderCalls;
    expect(pass.render(camera, 120).reason).toBe("cadence");
    expect(state.renderCalls).toBe(callsAfterFirst);
    expect(assignedTexture).toBe(pass.texture);
    expect(assignedStrengths.at(-1)).toBeGreaterThan(0);
    expect(assignedStrengths.at(-1)).toBeLessThanOrEqual(0.8);
    expect(assignedMatrices.at(-1)?.equals(assignedMatrices[0]!)).toBe(true);

    camera.position.y = 0.14;
    camera.updateMatrixWorld();
    expect(pass.render(camera, 125).reason).toBe("below-water");
    expect(assignedTexture).toBe(pass.texture);
    expect(assignedStrengths.at(-1)).toBe(0);
    expect(pass.confidence).toBe(0);
    expect(state.renderCalls).toBe(callsAfterFirst);
    camera.position.y = 20;
    camera.updateMatrixWorld();

    state.throwOnRenderCall = state.renderCalls + 1;
    expect(() => pass.render(camera, 200, true)).toThrow("synthetic render failure");
    expect(waterVisible).toBe(true);
    expectRendererState(renderer, state, savedTarget);
    pass.dispose();
    expect(assignedTexture).toBeNull();
    savedTarget.dispose();
  });

  it("refreshes early on large motion and recaptures resized attachments", () => {
    const { renderer, state } = fakeRenderer();
    const assignments: Array<{
      texture: THREE.Texture | null;
      strength: number | undefined;
    }> = [];
    const pass = new PlanarWaterReflectionPass({
      renderer,
      scene: new THREE.Scene(),
      bindings: {
        waterLevel: 0.14,
        withWaterHidden: (render) => render(),
        setReflection: (texture, _matrix, strength) => {
          assignments.push({ texture, strength });
        },
      },
      budget: { enabled: true, width: 320, height: 180, cadenceMs: 100, strength: 0.8 },
      colorFormat: "rgba8",
    });
    const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.08, 32_000);
    camera.position.set(0, 20, 0);
    camera.lookAt(10, 0, 0);
    expect(pass.render(camera, 100).rendered).toBe(true);
    expect(state.renderCalls).toBe(1);

    camera.position.x = 4;
    camera.updateMatrixWorld();
    expect(pass.render(camera, 130).reason).toBe("cadence");
    const reusedConfidence = pass.confidence;
    expect(reusedConfidence).toBeGreaterThan(0);
    expect(reusedConfidence).toBeLessThan(1);

    camera.position.x = 16;
    camera.updateMatrixWorld();
    expect(pass.render(camera, 145).rendered).toBe(true);
    expect(state.renderCalls).toBe(2);

    pass.setBudget(
      { enabled: true, width: 480, height: 270, cadenceMs: 100, strength: 0.8 },
      "rgba8",
    );
    expect(assignments.at(-1)?.texture).toBeNull();
    expect(pass.render(camera, 150).rendered).toBe(true);
    expect(state.renderCalls).toBe(3);
    pass.dispose();
  });
});

describe("hybrid frame graph", () => {
  it("runs the declared order, accumulates history, and restores renderer state", () => {
    const savedTarget = new THREE.WebGLRenderTarget(8, 8);
    const { renderer, state } = fakeRenderer(savedTarget);
    const profile = resolveRenderProfile(
      { renderingMode: "hybrid", quality: "medium", outputWidth: 640, outputHeight: 360 },
      CAPABILITIES,
    );
    const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.08, 32_000);
    camera.position.set(-13, 6, 0);
    camera.lookAt(10, 0, 0);
    const pipeline = new HybridRenderPipeline({
      renderer,
      scene: new THREE.Scene(),
      camera,
      capabilities: CAPABILITIES,
      profile,
    });
    pipeline.render({ nowMs: 0 });
    const diagnostics = pipeline.getDiagnostics();
    expect(diagnostics.passOrder).toEqual([
      "beauty",
      "screen-space-effects",
      "temporal-accumulation",
      "surface-history",
      "composite",
    ]);
    expect(diagnostics.historyValid).toBe(true);
    expect(diagnostics.framesRendered).toBe(1);
    expect(diagnostics.hardwareRayTracing).toBe(false);
    expect(state.renderCalls).toBe(5);
    const internals = pipeline as unknown as {
      temporalMaterial: THREE.ShaderMaterial;
      targets: { surfaceHistory: THREE.WebGLRenderTarget };
    };
    expect(internals.temporalMaterial.uniforms.previousSurfaceMap!.value).toBe(
      internals.targets.surfaceHistory.texture,
    );
    expect(internals.temporalMaterial.uniforms.historyValid!.value).toBe(0);
    expectRendererState(renderer, state, savedTarget);

    pipeline.invalidateHistory("unit-test-reset");
    expect(pipeline.getDiagnostics().historyValid).toBe(false);
    expect(pipeline.getDiagnostics().historyInvalidationReason).toBe("unit-test-reset");
    pipeline.render({ nowMs: 16 });
    expect(pipeline.getDiagnostics().historyValid).toBe(true);
    expect(pipeline.getDiagnostics().historyInvalidationReason).toBe("unit-test-reset");
    expect(internals.temporalMaterial.uniforms.historyValid!.value).toBe(0);
    camera.position.x += 0.75;
    camera.updateMatrixWorld();
    pipeline.render({ nowMs: 24 });
    expect(internals.temporalMaterial.uniforms.historyValid!.value).toBe(1);
    camera.position.x -= 4_000;
    camera.updateMatrixWorld();
    pipeline.render({ nowMs: 32, originShifted: true });
    expect(internals.temporalMaterial.uniforms.historyValid!.value).toBe(0);
    expect(pipeline.getDiagnostics().waterWorldOrigin).toEqual([4_000, 0]);
    pipeline.render({
      nowMs: Number.NaN,
      worldOrigin: { x: 12_000, z: -8_000 },
    });
    expect(internals.temporalMaterial.uniforms.historyValid!.value).toBe(1);
    expect(pipeline.getDiagnostics().waterWorldOrigin).toEqual([12_000, -8_000]);
    expect(Number.isFinite(pipeline.getDiagnostics().waterTimeSeconds)).toBe(true);
    pipeline.dispose();
    expect(pipeline.getDiagnostics().disposed).toBe(true);
    expect(() => pipeline.render()).toThrow("disposed");
    savedTarget.dispose();
  });

  it("rejects only water history for one frame after a bathymetry revision", () => {
    const { renderer } = fakeRenderer();
    const profile = resolveRenderProfile(
      { renderingMode: "hybrid", quality: "medium", outputWidth: 480, outputHeight: 270 },
      CAPABILITIES,
    );
    const bathymetry = new BathymetryField(0.14);
    bathymetry.update(
      { worldX: 0, worldZ: 0, sourceRevision: 1, nowMs: 0 },
      () => -40,
    );
    const pipeline = new HybridRenderPipeline({
      renderer,
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(62, 16 / 9, 0.08, 32_000),
      capabilities: CAPABILITIES,
      profile,
      waterBathymetry: bathymetry,
    });
    const temporalMaterial = (
      pipeline as unknown as { temporalMaterial: THREE.ShaderMaterial }
    ).temporalMaterial;
    pipeline.render({ nowMs: 0 });
    expect(temporalMaterial.uniforms.waterHistoryWeight!.value).toBe(
      profile.screenSpace.waterTemporalHistoryWeight,
    );

    bathymetry.update(
      { worldX: 600, worldZ: 0, sourceRevision: 1, nowMs: 16 },
      () => -40,
    );
    pipeline.render({ nowMs: 16 });
    expect(temporalMaterial.uniforms.waterHistoryWeight!.value).toBe(0);
    expect(pipeline.getDiagnostics().historyValid).toBe(true);
    pipeline.render({ nowMs: 32 });
    expect(temporalMaterial.uniforms.waterHistoryWeight!.value).toBe(
      profile.screenSpace.waterTemporalHistoryWeight,
    );
    pipeline.dispose();
    bathymetry.dispose();
  });

  it("restores all state when an intermediate pass throws", () => {
    const savedTarget = new THREE.WebGLRenderTarget(8, 8);
    const { renderer, state } = fakeRenderer(savedTarget);
    state.throwOnRenderCall = 2;
    const profile = resolveRenderProfile(
      { renderingMode: "ray-traced", quality: "low", outputWidth: 480, outputHeight: 270 },
      CAPABILITIES,
    );
    const pipeline = new HybridRenderPipeline({
      renderer,
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(62, 16 / 9, 0.08, 32_000),
      capabilities: CAPABILITIES,
      profile,
    });
    expect(() => pipeline.render({ nowMs: 0 })).toThrow("synthetic render failure");
    expectRendererState(renderer, state, savedTarget);
    expect(pipeline.getDiagnostics().historyValid).toBe(false);
    pipeline.dispose();
    savedTarget.dispose();
  });

  it("treats an identical resolved profile as a true no-op", () => {
    const { renderer, state } = fakeRenderer();
    const profile = resolveRenderProfile(
      { renderingMode: "hybrid", quality: "low", outputWidth: 640, outputHeight: 360 },
      CAPABILITIES,
    );
    const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.08, 32_000);
    camera.position.set(0, 20, 0);
    camera.lookAt(10, 0, 0);
    const pipeline = new HybridRenderPipeline({
      renderer,
      scene: new THREE.Scene(),
      camera,
      capabilities: CAPABILITIES,
      profile,
      waterReflection: {
        waterLevel: 0.14,
        withWaterHidden: (render) => render(),
        setReflection: () => undefined,
      },
    });

    pipeline.render({ nowMs: 100 });
    const allocations = state.initializedTargets;
    const firstRenderCalls = state.renderCalls;
    const first = pipeline.getDiagnostics();
    expect(first.historyValid).toBe(true);
    expect(first.planarConfidence).toBeGreaterThan(0);

    expect(pipeline.setProfile(resolveRenderProfile(
      { renderingMode: "hybrid", quality: "low", outputWidth: 640, outputHeight: 360 },
      CAPABILITIES,
    ))).toBe(true);
    expect(pipeline.getDiagnostics().historyValid).toBe(true);
    expect(pipeline.getDiagnostics().planarConfidence).toBe(first.planarConfidence);
    expect(state.initializedTargets).toBe(allocations);

    pipeline.render({ nowMs: 120 });
    // Five frame-graph passes only: the valid planar capture remains inside its
    // cadence instead of being needlessly recaptured by a settings/resize echo.
    expect(state.renderCalls - firstRenderCalls).toBe(5);
    pipeline.dispose();
  });

  it("transactionally replaces surface history and rejects it across a profile switch", () => {
    const { renderer, state } = fakeRenderer();
    const initial = resolveRenderProfile(
      { renderingMode: "hybrid", quality: "medium", outputWidth: 640, outputHeight: 360 },
      CAPABILITIES,
    );
    const pipeline = new HybridRenderPipeline({
      renderer,
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(62, 16 / 9, 0.08, 32_000),
      capabilities: CAPABILITIES,
      profile: initial,
    });
    pipeline.render({ nowMs: 0 });
    const initialTargets = (
      pipeline as unknown as { targets: { surfaceHistory: THREE.WebGLRenderTarget } }
    ).targets;
    const initialSurface = initialTargets.surfaceHistory.texture;
    const allocations = state.initializedTargets;

    const replacement = resolveRenderProfile(
      { renderingMode: "ray-traced", quality: "high", outputWidth: 960, outputHeight: 540 },
      CAPABILITIES,
    );
    expect(pipeline.setProfile(replacement)).toBe(true);
    expect(pipeline.getDiagnostics().historyValid).toBe(false);
    expect(pipeline.getDiagnostics().historyInvalidationReason).toBe("resources-rebuilt");
    const replacementTargets = (
      pipeline as unknown as { targets: { surfaceHistory: THREE.WebGLRenderTarget } }
    ).targets;
    expect(replacementTargets.surfaceHistory.texture).not.toBe(initialSurface);
    expect(state.initializedTargets).toBe(allocations + 5);
    pipeline.render({ nowMs: 16 });
    const temporalMaterial = (
      pipeline as unknown as { temporalMaterial: THREE.ShaderMaterial }
    ).temporalMaterial;
    expect(temporalMaterial.uniforms.historyValid!.value).toBe(0);
    expect(pipeline.getDiagnostics().historyValid).toBe(true);
    pipeline.dispose();
  });

  it("retains the known-good profile and history when replacement allocation fails", () => {
    const { renderer, state } = fakeRenderer();
    const reflectionAssignments: Array<THREE.Texture | null> = [];
    const profile = resolveRenderProfile(
      { renderingMode: "hybrid", quality: "medium", outputWidth: 640, outputHeight: 360 },
      CAPABILITIES,
    );
    const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.08, 32_000);
    camera.position.set(0, 20, 0);
    camera.lookAt(10, 0, 0);
    const pipeline = new HybridRenderPipeline({
      renderer,
      scene: new THREE.Scene(),
      camera,
      capabilities: CAPABILITIES,
      profile,
      waterReflection: {
        waterLevel: 0.14,
        withWaterHidden: (render) => render(),
        setReflection: (texture) => {
          reflectionAssignments.push(texture);
        },
      },
    });
    expect(pipeline.usesHybridComposite()).toBe(true);
    pipeline.render({ nowMs: 0 });
    expect(pipeline.getDiagnostics().historyValid).toBe(true);
    expect(reflectionAssignments.at(-1)).not.toBeNull();

    const replacement = resolveRenderProfile(
      { renderingMode: "ray-traced", quality: "medium", outputWidth: 640, outputHeight: 360 },
      CAPABILITIES,
    );
    // The five frame-graph attachments initialize first; fail specifically on
    // the previously-lazy planar target and verify the active binding survives.
    state.throwOnTargetWidth = replacement.planar.width;
    expect(pipeline.setProfile(replacement)).toBe(false);
    expect(pipeline.usesHybridComposite()).toBe(true);
    const retained = pipeline.getDiagnostics();
    expect(retained.requestedMode).toBe("hybrid");
    expect(retained.historyValid).toBe(true);
    expect(retained.downgradeReasons.join(" ")).toContain(
      "retaining the previous profile",
    );
    expect(reflectionAssignments.at(-1)).not.toBeNull();

    state.throwOnTargetWidth = null;
    expect(pipeline.setProfile(profile)).toBe(true);
    expect(pipeline.getDiagnostics().downgradeReasons.join(" ")).not.toContain(
      "retaining the previous profile",
    );
    expect(pipeline.getDiagnostics().historyValid).toBe(true);
    pipeline.render({ nowMs: 16 });
    expect(pipeline.getDiagnostics().framesRendered).toBe(2);
    pipeline.dispose();
  });

  it("reports the committed absorption owner after bypass transitions and failures", () => {
    const { renderer, state } = fakeRenderer();
    const balanced = resolveRenderProfile(
      { renderingMode: "balanced", quality: "medium", outputWidth: 640, outputHeight: 360 },
      CAPABILITIES,
    );
    const hybrid = resolveRenderProfile(
      { renderingMode: "hybrid", quality: "medium", outputWidth: 640, outputHeight: 360 },
      CAPABILITIES,
    );
    const pipeline = new HybridRenderPipeline({
      renderer,
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(62, 16 / 9, 0.08, 32_000),
      capabilities: CAPABILITIES,
      profile: balanced,
    });
    expect(pipeline.usesHybridComposite()).toBe(false);

    state.throwOnTargetWidth = hybrid.effectsWidth;
    expect(pipeline.setProfile(hybrid)).toBe(false);
    expect(pipeline.usesHybridComposite()).toBe(false);

    state.throwOnTargetWidth = null;
    expect(pipeline.setProfile(hybrid)).toBe(true);
    expect(pipeline.usesHybridComposite()).toBe(true);
    expect(pipeline.setProfile(balanced)).toBe(true);
    expect(pipeline.usesHybridComposite()).toBe(false);
    pipeline.dispose();
  });

  it("rebuilds context-bound attachments before invalidated history can resume", () => {
    const { renderer, state } = fakeRenderer();
    const profile = resolveRenderProfile(
      { renderingMode: "hybrid", quality: "low", outputWidth: 320, outputHeight: 180 },
      CAPABILITIES,
    );
    const pipeline = new HybridRenderPipeline({
      renderer,
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(62, 16 / 9, 0.08, 32_000),
      capabilities: CAPABILITIES,
      profile,
    });
    pipeline.render({ nowMs: 0 });
    const allocations = state.initializedTargets;
    expect(pipeline.rebuildAfterContextRestore()).toBe(true);
    expect(state.initializedTargets).toBe(allocations + 5);
    expect(pipeline.getDiagnostics().historyValid).toBe(false);
    expect(pipeline.getDiagnostics().historyInvalidationReason).toBe(
      "webgl-context-restored",
    );
    pipeline.dispose();
  });

  it("keeps the ray mode explicitly screen-space in code and diagnostics", () => {
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("screenSpaceReflection");
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("reconstructViewPosition");
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("ambientVisibility");
    expect(HYBRID_TEMPORAL_FRAGMENT_SHADER).toContain("previousViewProjectionMatrix");
    expect(HYBRID_TEMPORAL_FRAGMENT_SHADER).toContain("previousSurfaceMap");
    expect(HYBRID_TEMPORAL_FRAGMENT_SHADER).toContain("expectedPreviousDepth");
    expect(HYBRID_TEMPORAL_FRAGMENT_SHADER).toContain("depthTolerance");
    expect(HYBRID_SURFACE_HISTORY_FRAGMENT_SHADER).toContain("packDepth24");
    expect(HYBRID_SURFACE_HISTORY_FRAGMENT_SHADER).toContain("waterTag");
    expect(HYBRID_TEMPORAL_FRAGMENT_SHADER).toContain("neighborhoodMinimum");
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("proceduralWaterViewNormal");
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("viewMatrixValue");
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("waterMaterialMask");
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("beautySample.a");
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("solidHitConfidence");
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).not.toContain("waterHeightMask");
    expect(
      HYBRID_EFFECT_FRAGMENT_SHADER.match(/texture2D\(\s*waterSurfaceDetailMap/g),
    ).toHaveLength(3);
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain(
      "visibility = mix(visibility, 1.0, waterMask)",
    );
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("crossedSurface");
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("previousSeparation");
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("previousValid = 0.0");
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("temporalRayPhase");
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("hitFacingConfidence");
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("intervalConfidence");
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("refinement < 2");
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("foundHit < 0.5");
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("HYBRID_SKY_DEPTH = 0.9999999");
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("index < 16");
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).toContain("index < 32");
    expect(HYBRID_TEMPORAL_FRAGMENT_SHADER).toContain("waterHistoryWeight");
    expect(HYBRID_TEMPORAL_FRAGMENT_SHADER).toContain("resolvedHistoryWeight");
    expect(HYBRID_TEMPORAL_FRAGMENT_SHADER).toContain(
      "texture2D(beautyMap, vUv).a",
    );
    expect(HYBRID_COMPOSITE_FRAGMENT_SHADER).toContain("waterWorldOrigin");
    expect(HYBRID_COMPOSITE_FRAGMENT_SHADER).toContain("hybridWaterSlope");
    expect(HYBRID_COMPOSITE_FRAGMENT_SHADER).toContain("hybridWaterSurfaceField");
    expect(HYBRID_COMPOSITE_FRAGMENT_SHADER).toContain("waterSurfaceDetailMap");
    expect(HYBRID_COMPOSITE_FRAGMENT_SHADER).toContain("waterMaterialMaskAt");
    expect(
      HYBRID_COMPOSITE_FRAGMENT_SHADER.match(/texture2D\(\s*waterSurfaceDetailMap/g),
    ).toHaveLength(3);
    expect(HYBRID_COMPOSITE_FRAGMENT_SHADER).toContain("dFdx(worldPosition.xz)");
    expect(HYBRID_COMPOSITE_FRAGMENT_SHADER).toContain("waterFresnel");
    expect(HYBRID_COMPOSITE_FRAGMENT_SHADER).toContain("ssrFresnelWeight");
    expect(HYBRID_COMPOSITE_FRAGMENT_SHADER).toContain("transmittance");
    expect(HYBRID_COMPOSITE_FRAGMENT_SHADER).toContain("shorelineProximity");
    expect(HYBRID_COMPOSITE_FRAGMENT_SHADER).toContain("sampleWaterBathymetry");
    expect(HYBRID_COMPOSITE_FRAGMENT_SHADER).toContain("waterBathymetryMaxDepth");
    expect(HYBRID_COMPOSITE_FRAGMENT_SHADER).toContain(
      "float apparentDepth = mix(fallbackDepth, bathymetry.x, bathymetry.y)",
    );
    expect(HYBRID_COMPOSITE_FRAGMENT_SHADER).toContain(
      "mix(0.17, 0.42, shore) * waterDetailStrength * waterMask",
    );
    expect(HYBRID_COMPOSITE_FRAGMENT_SHADER).toContain(
      "broadVariation * 0.28 + waterRippleEnergy * 0.16",
    );
    expect(HYBRID_COMPOSITE_FRAGMENT_SHADER).not.toMatch(
      /sin\(\s*dot\(worldPosition\.xz/,
    );
    expect(HYBRID_COMPOSITE_FRAGMENT_SHADER).toContain(
      "bilateralEffects(vec2 uv, float centerDistance)",
    );
    expect(HYBRID_EFFECT_FRAGMENT_SHADER).not.toMatch(/rayQuery|traceRayEXT|accelerationStructure/i);
    expect(HYBRID_COMPOSITE_FRAGMENT_SHADER).not.toMatch(
      /rayQuery|traceRayEXT|accelerationStructure/i,
    );
  });
});
