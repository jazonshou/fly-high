import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { chromiumStdioLaunchOptions } from "./scripts/playwrightChromiumLaunch";

/**
 * The WebGPU-capable test project (0-8).
 *
 * Two Vitest projects on purpose: almost every assertion in Phases 0–1 is a
 * pure function over numbers and belongs in the Node project
 * (vitest.config.ts), where the whole suite runs in seconds. Only shader
 * compilation and CPU/GPU parity need a real adapter, and this project gives
 * them one — headless Chromium through Playwright, with WebGPU enabled over
 * ANGLE Metal.
 *
 * Run with `npm run test:gpu`. Deliberately excluded from `npm run verify`:
 * it needs a machine with a GPU and the Playwright Chromium download. Run it
 * explicitly, and at every gate boundary.
 */
export default defineConfig({
  // Keep the browser optimizer independent from Node and perf Vitest. Sharing
  // Vite's default cache made the canonical verify -> GPU -> perf sequence
  // invalidate this graph on every boundary; one such rebuild passed all 130
  // tests and then stranded Playwright inside ctx.close(). A dedicated cache
  // makes a cold checkout build once and every later project leave it intact.
  cacheDir: "node_modules/.vite-gpu",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  // Browser-mode discovers test files lazily. A late Babylon deep import can
  // rebuild the dependency graph and reload the page while Playwright is
  // closing it, leaving an otherwise-green run stuck in teardown. This is the
  // complete cold-cache dependency set used by the GPU project: pre-bundle it
  // once, preserve Babylon's shared module identity, and forbid late discovery.
  optimizeDeps: {
    noDiscovery: true,
    include: [
      "@babylonjs/core/Buffers/buffer",
      "@babylonjs/core/Buffers/storageBuffer",
      "@babylonjs/core/Cameras/camera",
      "@babylonjs/core/Cameras/freeCamera",
      "@babylonjs/core/Cameras/universalCamera",
      "@babylonjs/core/Compute/computeShader",
      "@babylonjs/core/Culling/boundingInfo",
      "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader",
      "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture",
      "@babylonjs/core/Engines/WebGPU/webgpuDrawContext",
      "@babylonjs/core/Engines/constants",
      "@babylonjs/core/Engines/shaderStore",
      "@babylonjs/core/Engines/webgpuEngine",
      "@babylonjs/core/Layers/layer",
      "@babylonjs/core/Lights/Clustered/index",
      "@babylonjs/core/Lights/IES/iesLoader",
      "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator",
      "@babylonjs/core/Lights/Shadows/shadowGenerator",
      "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent",
      "@babylonjs/core/Lights/directionalLight",
      "@babylonjs/core/Lights/hemisphericLight",
      "@babylonjs/core/Lights/pointLight",
      "@babylonjs/core/Materials/PBR/pbrMaterial",
      "@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture.pure",
      "@babylonjs/core/Materials/Textures/baseTexture.polynomial",
      "@babylonjs/core/Materials/Textures/rawCubeTexture",
      "@babylonjs/core/Materials/Textures/rawTexture",
      "@babylonjs/core/Materials/Textures/rawTexture2DArray",
      "@babylonjs/core/Materials/Textures/rawTexture3D",
      "@babylonjs/core/Materials/Textures/renderTargetTexture",
      "@babylonjs/core/Materials/Textures/texture",
      "@babylonjs/core/Materials/Textures/textureSampler",
      "@babylonjs/core/Materials/imageProcessingConfiguration",
      "@babylonjs/core/Materials/material",
      "@babylonjs/core/Materials/materialPluginBase",
      "@babylonjs/core/Materials/shaderLanguage",
      "@babylonjs/core/Materials/shaderMaterial",
      "@babylonjs/core/Materials/shadowDepthWrapper",
      "@babylonjs/core/Materials/standardMaterial",
      "@babylonjs/core/Materials/uniformBuffer",
      "@babylonjs/core/Maths/math.color",
      "@babylonjs/core/Maths/math.frustum",
      "@babylonjs/core/Maths/math.plane",
      "@babylonjs/core/Maths/math.vector",
      "@babylonjs/core/Meshes/Builders/boxBuilder",
      "@babylonjs/core/Meshes/Builders/boxBuilder.pure",
      "@babylonjs/core/Meshes/Builders/cylinderBuilder.pure",
      "@babylonjs/core/Meshes/Builders/groundBuilder",
      "@babylonjs/core/Meshes/Builders/sphereBuilder",
      "@babylonjs/core/Meshes/Builders/sphereBuilder.pure",
      "@babylonjs/core/Meshes/Builders/torusBuilder.pure",
      "@babylonjs/core/Meshes/WebGPU/webgpuDataBuffer",
      "@babylonjs/core/Meshes/mesh",
      "@babylonjs/core/Meshes/mesh.vertexData",
      "@babylonjs/core/Meshes/thinInstanceMesh",
      "@babylonjs/core/Meshes/transformNode",
      "@babylonjs/core/Misc/HighDynamicRange/cubemapToSphericalPolynomial",
      "@babylonjs/core/Misc/logger",
      "@babylonjs/core/PostProcesses/fxaaPostProcess",
      "@babylonjs/core/PostProcesses/imageProcessingPostProcess",
      "@babylonjs/core/PostProcesses/passPostProcess",
      "@babylonjs/core/PostProcesses/postProcess",
      "@babylonjs/core/Probes/reflectionProbe",
      "@babylonjs/core/Rendering/depthRenderer",
      "@babylonjs/core/scene",
    ],
  },
  test: {
    include: ["tests/gpu/**/*.test.ts"],
    passWithNoTests: false,
    reporters: ["default"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Every file creates its own WebGPUEngine; eight concurrent devices on
    // one adapter made screenshot- and timing-sensitive tests fail at random
    // (observed once the 2-8 file landed). The whole suite is seconds long —
    // determinism beats parallelism here.
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      provider: playwright({
        launchOptions: {
          ...chromiumStdioLaunchOptions(),
          // The chromium-headless-shell has no GPU process; the "chromium"
          // channel selects full Chromium in new-headless mode, which does.
          channel: "chromium",
          args: [
            // Playwright already passes --disable-breakpad, but Chrome for
            // Testing can still launch crashpad handlers on macOS. Those helpers
            // inherit Playwright's stderr socket and can keep Vitest alive after
            // a green summary. Disable both Chromium's crashpad initialization
            // and the crash reporter that official headless builds enable.
            "--disable-crashpad-for-testing",
            "--disable-crash-reporter",
            "--enable-unsafe-webgpu",
            "--use-angle=metal",
            "--enable-features=WebGPU",
          ],
        },
      }),
      instances: [{ browser: "chromium" }],
    },
  },
});
