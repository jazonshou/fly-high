import * as THREE from "three";

export interface SavedWebGLRendererState {
  readonly renderTarget: THREE.WebGLRenderTarget | null;
  readonly activeCubeFace: number;
  readonly activeMipmapLevel: number;
  readonly viewport: THREE.Vector4;
  readonly scissor: THREE.Vector4;
  readonly scissorTest: boolean;
  readonly clearColor: THREE.Color;
  readonly clearAlpha: number;
  readonly autoClear: boolean;
  readonly xrEnabled: boolean;
  readonly shadowAutoUpdate: boolean;
  readonly shadowNeedsUpdate: boolean;
}

export function captureWebGLRendererState(
  renderer: THREE.WebGLRenderer,
): SavedWebGLRendererState {
  return {
    renderTarget: renderer.getRenderTarget(),
    activeCubeFace: renderer.getActiveCubeFace(),
    activeMipmapLevel: renderer.getActiveMipmapLevel(),
    viewport: renderer.getViewport(new THREE.Vector4()),
    scissor: renderer.getScissor(new THREE.Vector4()),
    scissorTest: renderer.getScissorTest(),
    clearColor: renderer.getClearColor(new THREE.Color()),
    clearAlpha: renderer.getClearAlpha(),
    autoClear: renderer.autoClear,
    xrEnabled: renderer.xr.enabled,
    shadowAutoUpdate: renderer.shadowMap.autoUpdate,
    shadowNeedsUpdate: renderer.shadowMap.needsUpdate,
  };
}

export function restoreWebGLRendererState(
  renderer: THREE.WebGLRenderer,
  state: SavedWebGLRendererState,
): void {
  renderer.setRenderTarget(
    state.renderTarget,
    state.activeCubeFace,
    state.activeMipmapLevel,
  );
  renderer.setViewport(state.viewport);
  renderer.setScissor(state.scissor);
  renderer.setScissorTest(state.scissorTest);
  renderer.setClearColor(state.clearColor, state.clearAlpha);
  renderer.autoClear = state.autoClear;
  renderer.xr.enabled = state.xrEnabled;
  renderer.shadowMap.autoUpdate = state.shadowAutoUpdate;
  renderer.shadowMap.needsUpdate = state.shadowNeedsUpdate;
}

