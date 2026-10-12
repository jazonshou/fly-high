/**
 * Lets a harness stream a shot on a software adapter without paying to draw
 * frames nobody will look at.
 *
 * Streaming is the long pole of a capture: terrain pages and detail cells are
 * admitted a few per frame, so a shot needs a FRAME COUNT (hundreds) before it
 * settles, whatever each frame costs. On the M3 Pro a frame is ~8 ms; on
 * SwiftShader the cruise-horizon scene pass alone is ~5 s, so the same
 * hundreds of frames take most of an hour. While the gate is closed the draws
 * of the frame's own images are dropped at the WebGPU boundary — pipelines,
 * bind groups, passes, clears and every compute dispatch still run — so the
 * frame costs its compute and its CPU work, and what streams is exactly what
 * would have streamed: page admission and LOD selection are CPU-side, and the
 * GPU results streaming waits on (page generation, bounds, collision heights,
 * ground-cover counts) are all compute.
 *
 * **Which draws.** Only those in a render pass whose every target texture was
 * also the target of a render pass in each of the two previous frames: scene
 * colour and depth, shadow maps, the post-process chain. Anything else draws
 * normally, because a draw into a target that is not re-rendered every frame
 * is a BAKE, and a bake's result outlives the gate:
 *  - the sky probe's six cube faces and the cloud ambient LUT render once per
 *    environment change (`SkyEnvironmentProbe`, `AtmosphereGpuResources`);
 *  - Babylon's clear-quad records a render bundle ONCE and replays it for the
 *    life of the engine (`webgpuClearQuad`), so a bundle recorded while its
 *    draw was being dropped would clear nothing ever after.
 * So bundle encoders are never touched — a suppressed pass drops the bundles
 * it executes instead — and a pass whose targets the gate cannot identify is
 * never suppressed. `gpuDrawGateStats().bakedWhileClosed` names every pass
 * that drew while the gate was closed, so a new bake shows up in the report.
 *
 * What a closed gate does change is the pixels and any temporal history built
 * from them, which is why a harness renders ordinary frames before closing it
 * (so the shot's own bakes happen with draws, and the per-frame targets are
 * known) and reopens it for settle frames before it measures or photographs
 * anything.
 */

import { stablePassLabel } from "./gpuPassLabels";

export interface GpuDrawGateStats {
  /** Frames marked with `markGpuDrawGateFrame()` since installation. */
  readonly frames: number;
  /** Draw and bundle calls dropped while the gate was closed. */
  readonly droppedDraws: number;
  /** Render passes whose draws were dropped. */
  readonly suppressedPasses: number;
  /** Passes that drew while the gate was closed, by stable label: bakes. */
  readonly bakedWhileClosed: Readonly<Record<string, number>>;
}

interface DrawGateState {
  installed: boolean;
  suppressed: boolean;
  frame: number;
  droppedDraws: number;
  suppressedPasses: number;
  bakedWhileClosed: Record<string, number>;
  readonly viewTextures: WeakMap<object, object>;
  /** The last three distinct frames each texture was a render-pass target in. */
  readonly targetFrames: WeakMap<object, number[]>;
  readonly suppressedEncoders: WeakSet<object>;
  readonly restores: Array<() => void>;
}

const STATE_KEY = "__flyHighGpuDrawGate";

function state(): DrawGateState {
  const holder = globalThis as unknown as Record<string, DrawGateState | undefined>;
  holder[STATE_KEY] ??= {
    installed: false,
    suppressed: false,
    frame: 0,
    droppedDraws: 0,
    suppressedPasses: 0,
    bakedWhileClosed: {},
    viewTextures: new WeakMap(),
    targetFrames: new WeakMap(),
    suppressedEncoders: new WeakSet(),
    restores: [],
  };
  return holder[STATE_KEY]!;
}

const DRAW_METHODS = ["draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect", "executeBundles"] as const;

function patch(
  target: object | undefined,
  name: string,
  wrap: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown,
): void {
  if (!target) return;
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  const original = descriptor?.value as ((...args: unknown[]) => unknown) | undefined;
  if (typeof original !== "function") return;
  Object.defineProperty(target, name, { ...descriptor, value: wrap(original) });
  state().restores.push(() => Object.defineProperty(target, name, descriptor!));
}

function prototypeOf(name: string): object | undefined {
  return (globalThis as unknown as Record<string, { prototype?: object } | undefined>)[name]?.prototype;
}

interface AttachmentLike {
  readonly view?: object;
}

/** The textures a pass renders into, or null when any of them is unknown. */
function passTargets(shared: DrawGateState, descriptor: GPURenderPassDescriptor): object[] | null {
  const textureClass = (globalThis as unknown as { GPUTexture?: new () => object }).GPUTexture;
  const resolve = (view: object | undefined): object | undefined => {
    if (!view) return undefined;
    if (textureClass && view instanceof textureClass) return view;
    return shared.viewTextures.get(view);
  };
  const targets: object[] = [];
  for (const attachment of (descriptor.colorAttachments ?? []) as Iterable<AttachmentLike | null | undefined>) {
    if (!attachment) continue;
    const texture = resolve(attachment.view);
    if (!texture) return null;
    targets.push(texture);
  }
  const depth = descriptor.depthStencilAttachment as AttachmentLike | undefined;
  if (depth) {
    const texture = resolve(depth.view);
    if (!texture) return null;
    targets.push(texture);
  }
  return targets.length > 0 ? targets : null;
}

/** Patches texture views, render-pass creation and the draw entry points once. Idempotent. */
export function installGpuDrawGate(): void {
  const shared = state();
  if (shared.installed) return;
  if (!prototypeOf("GPURenderPassEncoder") || !prototypeOf("GPUCommandEncoder")) return;
  shared.installed = true;

  patch(prototypeOf("GPUTexture"), "createView", (original) => function (this: object, ...args) {
    const view = original.apply(this, args) as object;
    shared.viewTextures.set(view, this);
    return view;
  });

  patch(prototypeOf("GPUCommandEncoder"), "beginRenderPass", (original) => function (this: object, ...args) {
    const descriptor = args[0] as GPURenderPassDescriptor | undefined;
    const encoder = original.apply(this, args) as object;
    const targets = descriptor ? passTargets(shared, descriptor) : null;
    if (!targets) return encoder;
    const frame = shared.frame;
    const everyFrame = targets.every((texture) => {
      const frames = shared.targetFrames.get(texture);
      return frames !== undefined && frames.includes(frame - 1) && frames.includes(frame - 2);
    });
    for (const texture of targets) {
      const frames = shared.targetFrames.get(texture) ?? [];
      if (frames[frames.length - 1] !== frame) {
        frames.push(frame);
        if (frames.length > 3) frames.shift();
      }
      shared.targetFrames.set(texture, frames);
    }
    if (!shared.suppressed) return encoder;
    if (everyFrame) {
      shared.suppressedEncoders.add(encoder);
      shared.suppressedPasses += 1;
    } else {
      const label = stablePassLabel(descriptor?.label, "render");
      shared.bakedWhileClosed[label] = (shared.bakedWhileClosed[label] ?? 0) + 1;
    }
    return encoder;
  });

  for (const name of DRAW_METHODS) {
    patch(prototypeOf("GPURenderPassEncoder"), name, (original) => function (this: object, ...args) {
      if (shared.suppressedEncoders.has(this)) {
        shared.droppedDraws += 1;
        return undefined;
      }
      return original.apply(this, args);
    });
  }
}

/**
 * Starts a new frame for the gate's every-frame test. Call once before each
 * frame is rendered, gate open or closed.
 */
export function markGpuDrawGateFrame(): void {
  state().frame += 1;
}

/** Closes (true) or reopens (false) the gate. */
export function setGpuDrawsSuppressed(suppressed: boolean): void {
  const shared = state();
  if (suppressed && !shared.installed) {
    throw new Error("installGpuDrawGate() must run before draws can be suppressed");
  }
  shared.suppressed = suppressed;
}

export function gpuDrawsSuppressed(): boolean {
  return state().suppressed;
}

export function gpuDrawGateStats(): GpuDrawGateStats {
  const shared = state();
  return {
    frames: shared.frame,
    droppedDraws: shared.droppedDraws,
    suppressedPasses: shared.suppressedPasses,
    bakedWhileClosed: { ...shared.bakedWhileClosed },
  };
}

/** Zeroes the counts in `gpuDrawGateStats()`; the target history is kept. */
export function resetGpuDrawGateStats(): void {
  const shared = state();
  shared.droppedDraws = 0;
  shared.suppressedPasses = 0;
  shared.bakedWhileClosed = {};
}

/** Removes the wrappers. For tests of this module. */
export function uninstallGpuDrawGate(): void {
  const shared = state();
  while (shared.restores.length > 0) shared.restores.pop()!();
  shared.installed = false;
  shared.suppressed = false;
  shared.frame = 0;
  resetGpuDrawGateStats();
}
