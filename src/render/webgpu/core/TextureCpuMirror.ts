import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";

/**
 * Let go of Babylon's CPU copy of a raw texture's uploaded data.
 *
 * Unless the engine is built with `doNotHandleContextLost`, every raw-texture
 * upload also stores the data it was given on the internal texture:
 * `_bufferView` (the last upload) and `_bufferViewArray[level]` (each
 * `updateMipLevel`), so `InternalTexture._rebuild` can upload it again after
 * a lost device. That is a second, CPU-side copy of every hand-built mip
 * chain: about 35 MiB of page heap on Low (foliage and impostor atlases,
 * terrain material arrays, aircraft and airfield paint).
 *
 * Nothing in this renderer reads it. A lost device is fatal here from the
 * moment the engine exists: while `FlightRenderer.create` runs, startup
 * aborts and reports the loss (`GpuDeviceLossLatch`), and once the renderer
 * is built it stops drawing at `onContextLostObservable` and asks for a
 * reload. Babylon still starts its restore, but the game presents no frame
 * drawn with it. Babylon's other readers are `RawCubeTexture.clone`,
 * `SpriteMap` and baked vertex animation, none of which these textures meet;
 * `RawTexture.clone` shares the internal texture, and `readPixels` reads the
 * GPU. Dropping the references changes nothing the GPU received: the
 * uploads have already been issued with the same data.
 *
 * Call it after a texture's last upload. A later upload stores a new copy,
 * so a texture uploaded again must drop it again.
 */
export function dropTextureCpuMirror(texture: BaseTexture): void {
  const internal = texture.getInternalTexture();
  if (!internal) return;
  internal._bufferView = null;
  internal._bufferViewArray = null;
}
