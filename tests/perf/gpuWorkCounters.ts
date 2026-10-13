/**
 * Host-independent GPU WORK counters, read by wrapping the WebGPU API the page
 * calls. What a frame ASKS the GPU to do — passes, draws, vertices, instances,
 * dispatches, workgroups, attachment pixels, uploads — is a property of the
 * code and the scene, not of the adapter that runs it, so these numbers are the
 * same on the M3 Pro, on a hosted macOS runner and on a software adapter. That
 * makes them the one perf signal that can be compared EXACTLY between two
 * commits on any machine, where every timing signal needs statistics.
 *
 * They are blind to what a draw costs once issued (a heavier fragment shader
 * over the same pixels counts the same), which is what the software-adapter
 * timing in `scripts/perf-ab.mts` is for.
 *
 * Installation is in two layers:
 *  - `installGpuWorkCounters()` patches the prototypes once, before the
 *    renderer exists, so every texture view's size is known when a pass later
 *    names it as an attachment. While no window is open the wrappers forward
 *    immediately, so a capture that never opens one pays one branch per call.
 *  - `beginGpuWorkWindow()` / `endGpuWorkWindow()` bracket the frames whose
 *    work is counted.
 */

import { gpuPassKey, type GpuPassKind } from "./gpuPassLabels";

export { stablePassLabel } from "./gpuPassLabels";

/** Per-pass totals, keyed by the pass's stable label (see `gpuPassLabels.ts`). */
export interface GpuPassWork {
  readonly kind: GpuPassKind;
  passes: number;
  draws: number;
  indirectDraws: number;
  /** Vertices or indices submitted by direct draws, times their instance count. */
  vertices: number;
  instances: number;
  dispatches: number;
  indirectDispatches: number;
  workgroups: number;
  /** Colour plus depth attachment texels the pass binds, times sample count. */
  attachmentPixels: number;
  pipelineSwitches: number;
  bindGroupSets: number;
}

export interface GpuWorkCounters {
  /** Frames the window covered; every total below is a sum over them. */
  frames: number;
  submits: number;
  commandBuffers: number;
  renderPasses: number;
  computePasses: number;
  draws: number;
  indirectDraws: number;
  vertices: number;
  instances: number;
  dispatches: number;
  indirectDispatches: number;
  workgroups: number;
  attachmentPixels: number;
  pipelineSwitches: number;
  bindGroupSets: number;
  bundlesExecuted: number;
  bufferUploadBytes: number;
  textureUploadBytes: number;
  copyCommands: number;
  copyBytes: number;
  pipelinesCreated: number;
  shaderModulesCreated: number;
  texturesCreated: number;
  textureBytesCreated: number;
  buffersCreated: number;
  bufferBytesCreated: number;
  bindGroupsCreated: number;
  passes: Record<string, GpuPassWork>;
}

interface ViewExtent {
  readonly width: number;
  readonly height: number;
  readonly samples: number;
}

interface CounterState {
  installed: boolean;
  open: GpuWorkCounters | null;
  readonly viewExtents: WeakMap<object, ViewExtent>;
  readonly passOf: WeakMap<object, GpuPassWork>;
  readonly restores: Array<() => void>;
}

const STATE_KEY = "__flyHighGpuWorkCounters";

function state(): CounterState {
  const holder = globalThis as unknown as Record<string, CounterState | undefined>;
  holder[STATE_KEY] ??= {
    installed: false,
    open: null,
    viewExtents: new WeakMap(),
    passOf: new WeakMap(),
    restores: [],
  };
  return holder[STATE_KEY]!;
}

function emptyCounters(): GpuWorkCounters {
  return {
    frames: 0,
    submits: 0,
    commandBuffers: 0,
    renderPasses: 0,
    computePasses: 0,
    draws: 0,
    indirectDraws: 0,
    vertices: 0,
    instances: 0,
    dispatches: 0,
    indirectDispatches: 0,
    workgroups: 0,
    attachmentPixels: 0,
    pipelineSwitches: 0,
    bindGroupSets: 0,
    bundlesExecuted: 0,
    bufferUploadBytes: 0,
    textureUploadBytes: 0,
    copyCommands: 0,
    copyBytes: 0,
    pipelinesCreated: 0,
    shaderModulesCreated: 0,
    texturesCreated: 0,
    textureBytesCreated: 0,
    buffersCreated: 0,
    bufferBytesCreated: 0,
    bindGroupsCreated: 0,
    passes: {},
  };
}

function passEntry(
  counters: GpuWorkCounters,
  label: string,
  kind: GpuPassKind,
): GpuPassWork {
  const key = `${kind}:${label}`;
  counters.passes[key] ??= {
    kind,
    passes: 0,
    draws: 0,
    indirectDraws: 0,
    vertices: 0,
    instances: 0,
    dispatches: 0,
    indirectDispatches: 0,
    workgroups: 0,
    attachmentPixels: 0,
    pipelineSwitches: 0,
    bindGroupSets: 0,
  };
  return counters.passes[key]!;
}

function byteLengthOf(data: unknown, offsetElements = 0, sizeElements?: number): number {
  // `SharedArrayBuffer` is not even defined on a page that is not
  // cross-origin isolated, which the A/B agent's page is not.
  const shared = typeof SharedArrayBuffer === "undefined" ? undefined : SharedArrayBuffer;
  if (data instanceof ArrayBuffer || (shared !== undefined && data instanceof shared)) {
    return sizeElements ?? Math.max(0, data.byteLength - offsetElements);
  }
  if (ArrayBuffer.isView(data)) {
    const element = (data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
    if (sizeElements !== undefined) return sizeElements * element;
    return Math.max(0, data.byteLength - offsetElements * element);
  }
  return 0;
}

function textureBytes(descriptor: GPUTextureDescriptor): number {
  // A deliberately coarse size: texel count across the mip chain times a
  // 4-byte texel. The authoritative memory inventory lives in the renderer;
  // this only has to move when allocation churn moves.
  const size = descriptor.size as GPUExtent3DDict | number[];
  const width = Array.isArray(size) ? size[0] ?? 1 : size.width;
  const height = Array.isArray(size) ? size[1] ?? 1 : size.height ?? 1;
  const layers = Array.isArray(size) ? size[2] ?? 1 : size.depthOrArrayLayers ?? 1;
  let texels = 0;
  for (let level = 0; level < (descriptor.mipLevelCount ?? 1); level += 1) {
    texels += Math.max(1, width >> level) * Math.max(1, height >> level) * layers;
  }
  return texels * 4 * (descriptor.sampleCount ?? 1);
}

function patch<T extends object>(
  target: T | undefined,
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

/**
 * Patches the WebGPU prototypes. Idempotent; call before the renderer creates
 * its device so attachment sizes are known for every view.
 */
export function installGpuWorkCounters(): void {
  const shared = state();
  if (shared.installed) return;
  if (typeof GPUTexture === "undefined") return;
  shared.installed = true;

  const viewExtent = (view: unknown): ViewExtent | undefined =>
    view && typeof view === "object" ? shared.viewExtents.get(view) : undefined;

  patch(prototypeOf("GPUTexture"), "createView", (original) => function (this: GPUTexture, ...args) {
    const view = original.apply(this, args) as GPUTextureView;
    const descriptor = args[0] as GPUTextureViewDescriptor | undefined;
    const level = descriptor?.baseMipLevel ?? 0;
    shared.viewExtents.set(view, {
      width: Math.max(1, this.width >> level),
      height: Math.max(1, this.height >> level),
      samples: this.sampleCount,
    });
    return view;
  });

  patch(prototypeOf("GPUCommandEncoder"), "beginRenderPass", (original) => function (this: unknown, ...args) {
    const pass = original.apply(this, args) as object;
    const counters = shared.open;
    if (!counters) return pass;
    const descriptor = args[0] as GPURenderPassDescriptor;
    const entry = passEntry(counters, gpuPassKey(descriptor.label, "render"), "render");
    let pixels = 0;
    for (const attachment of descriptor.colorAttachments ?? []) {
      const extent = viewExtent(attachment?.view);
      if (extent) pixels += extent.width * extent.height * extent.samples;
    }
    const depth = viewExtent(descriptor.depthStencilAttachment?.view);
    if (depth) pixels += depth.width * depth.height * depth.samples;
    entry.passes += 1;
    entry.attachmentPixels += pixels;
    counters.renderPasses += 1;
    counters.attachmentPixels += pixels;
    shared.passOf.set(pass, entry);
    return pass;
  });

  patch(prototypeOf("GPUCommandEncoder"), "beginComputePass", (original) => function (this: unknown, ...args) {
    const pass = original.apply(this, args) as object;
    const counters = shared.open;
    if (!counters) return pass;
    const descriptor = args[0] as GPUComputePassDescriptor | undefined;
    const entry = passEntry(counters, gpuPassKey(descriptor?.label, "compute"), "compute");
    entry.passes += 1;
    counters.computePasses += 1;
    shared.passOf.set(pass, entry);
    return pass;
  });

  const renderPassPrototypes = [prototypeOf("GPURenderPassEncoder"), prototypeOf("GPURenderBundleEncoder")];
  for (const proto of renderPassPrototypes) {
    patch(proto, "draw", (original) => function (this: object, ...args) {
      const counters = shared.open;
      if (counters) {
        const instances = (args[1] as number | undefined) ?? 1;
        const vertices = (args[0] as number) * instances;
        counters.draws += 1;
        counters.vertices += vertices;
        counters.instances += instances;
        const entry = shared.passOf.get(this);
        if (entry) {
          entry.draws += 1;
          entry.vertices += vertices;
          entry.instances += instances;
        }
      }
      return original.apply(this, args);
    });
    patch(proto, "drawIndexed", (original) => function (this: object, ...args) {
      const counters = shared.open;
      if (counters) {
        const instances = (args[1] as number | undefined) ?? 1;
        const vertices = (args[0] as number) * instances;
        counters.draws += 1;
        counters.vertices += vertices;
        counters.instances += instances;
        const entry = shared.passOf.get(this);
        if (entry) {
          entry.draws += 1;
          entry.vertices += vertices;
          entry.instances += instances;
        }
      }
      return original.apply(this, args);
    });
    for (const name of ["drawIndirect", "drawIndexedIndirect"]) {
      patch(proto, name, (original) => function (this: object, ...args) {
        const counters = shared.open;
        if (counters) {
          counters.indirectDraws += 1;
          const entry = shared.passOf.get(this);
          if (entry) entry.indirectDraws += 1;
        }
        return original.apply(this, args);
      });
    }
    patch(proto, "setPipeline", (original) => function (this: object, ...args) {
      const counters = shared.open;
      if (counters) {
        counters.pipelineSwitches += 1;
        const entry = shared.passOf.get(this);
        if (entry) entry.pipelineSwitches += 1;
      }
      return original.apply(this, args);
    });
    patch(proto, "setBindGroup", (original) => function (this: object, ...args) {
      const counters = shared.open;
      if (counters) {
        counters.bindGroupSets += 1;
        const entry = shared.passOf.get(this);
        if (entry) entry.bindGroupSets += 1;
      }
      return original.apply(this, args);
    });
  }
  patch(prototypeOf("GPURenderPassEncoder"), "executeBundles", (original) => function (this: object, ...args) {
    const counters = shared.open;
    if (counters) counters.bundlesExecuted += [...((args[0] as Iterable<unknown>) ?? [])].length;
    return original.apply(this, args);
  });

  const computePass = prototypeOf("GPUComputePassEncoder");
  patch(computePass, "dispatchWorkgroups", (original) => function (this: object, ...args) {
    const counters = shared.open;
    if (counters) {
      const groups = (args[0] as number) * ((args[1] as number | undefined) ?? 1)
        * ((args[2] as number | undefined) ?? 1);
      counters.dispatches += 1;
      counters.workgroups += groups;
      const entry = shared.passOf.get(this);
      if (entry) {
        entry.dispatches += 1;
        entry.workgroups += groups;
      }
    }
    return original.apply(this, args);
  });
  patch(computePass, "dispatchWorkgroupsIndirect", (original) => function (this: object, ...args) {
    const counters = shared.open;
    if (counters) {
      counters.indirectDispatches += 1;
      const entry = shared.passOf.get(this);
      if (entry) entry.indirectDispatches += 1;
    }
    return original.apply(this, args);
  });
  for (const name of ["setPipeline", "setBindGroup"]) {
    patch(computePass, name, (original) => function (this: object, ...args) {
      const counters = shared.open;
      if (counters) {
        const entry = shared.passOf.get(this);
        if (name === "setPipeline") {
          counters.pipelineSwitches += 1;
          if (entry) entry.pipelineSwitches += 1;
        } else {
          counters.bindGroupSets += 1;
          if (entry) entry.bindGroupSets += 1;
        }
      }
      return original.apply(this, args);
    });
  }

  const encoder = prototypeOf("GPUCommandEncoder");
  patch(encoder, "copyBufferToBuffer", (original) => function (this: unknown, ...args) {
    const counters = shared.open;
    if (counters) {
      counters.copyCommands += 1;
      // (src, srcOffset, dst, dstOffset, size) or the newer (src, dst, size?).
      const size = args.length >= 5 ? args[4] : args[2];
      counters.copyBytes += typeof size === "number" ? size : 0;
    }
    return original.apply(this, args);
  });
  for (const name of ["copyBufferToTexture", "copyTextureToBuffer", "copyTextureToTexture"]) {
    patch(encoder, name, (original) => function (this: unknown, ...args) {
      const counters = shared.open;
      if (counters) {
        counters.copyCommands += 1;
        const size = args[2] as GPUExtent3DDict | number[] | undefined;
        if (size) {
          const width = Array.isArray(size) ? size[0] ?? 1 : size.width;
          const height = Array.isArray(size) ? size[1] ?? 1 : size.height ?? 1;
          const layers = Array.isArray(size) ? size[2] ?? 1 : size.depthOrArrayLayers ?? 1;
          counters.copyBytes += width * height * layers * 4;
        }
      }
      return original.apply(this, args);
    });
  }

  const queue = prototypeOf("GPUQueue");
  patch(queue, "submit", (original) => function (this: unknown, ...args) {
    const counters = shared.open;
    if (counters) {
      counters.submits += 1;
      counters.commandBuffers += [...((args[0] as Iterable<unknown>) ?? [])].length;
    }
    return original.apply(this, args);
  });
  patch(queue, "writeBuffer", (original) => function (this: unknown, ...args) {
    const counters = shared.open;
    if (counters) {
      counters.bufferUploadBytes += byteLengthOf(
        args[2],
        (args[3] as number | undefined) ?? 0,
        args[4] as number | undefined,
      );
    }
    return original.apply(this, args);
  });
  patch(queue, "writeTexture", (original) => function (this: unknown, ...args) {
    const counters = shared.open;
    if (counters) {
      const layout = args[2] as GPUTexelCopyBufferLayout | undefined;
      counters.textureUploadBytes += byteLengthOf(args[1], layout?.offset ?? 0);
    }
    return original.apply(this, args);
  });

  const device = prototypeOf("GPUDevice");
  for (const name of [
    "createRenderPipeline",
    "createRenderPipelineAsync",
    "createComputePipeline",
    "createComputePipelineAsync",
  ]) {
    patch(device, name, (original) => function (this: unknown, ...args) {
      if (shared.open) shared.open.pipelinesCreated += 1;
      return original.apply(this, args);
    });
  }
  patch(device, "createShaderModule", (original) => function (this: unknown, ...args) {
    if (shared.open) shared.open.shaderModulesCreated += 1;
    return original.apply(this, args);
  });
  patch(device, "createBindGroup", (original) => function (this: unknown, ...args) {
    if (shared.open) shared.open.bindGroupsCreated += 1;
    return original.apply(this, args);
  });
  patch(device, "createTexture", (original) => function (this: unknown, ...args) {
    if (shared.open) {
      shared.open.texturesCreated += 1;
      shared.open.textureBytesCreated += textureBytes(args[0] as GPUTextureDescriptor);
    }
    return original.apply(this, args);
  });
  patch(device, "createBuffer", (original) => function (this: unknown, ...args) {
    if (shared.open) {
      shared.open.buffersCreated += 1;
      shared.open.bufferBytesCreated += (args[0] as GPUBufferDescriptor).size;
    }
    return original.apply(this, args);
  });
}

/** Removes every wrapper. For tests of this module; a capture leaves them installed. */
export function uninstallGpuWorkCounters(): void {
  const shared = state();
  while (shared.restores.length > 0) shared.restores.pop()!();
  shared.installed = false;
  shared.open = null;
}

export function gpuWorkCountersInstalled(): boolean {
  return state().installed;
}

/** Opens a counting window. Throws if one is already open: windows never nest. */
export function beginGpuWorkWindow(): void {
  const shared = state();
  if (!shared.installed) throw new Error("installGpuWorkCounters() must run before a window opens");
  if (shared.open) throw new Error("A GPU work window is already open");
  shared.open = emptyCounters();
}

/** Closes the window and returns its totals over `frames` frames. */
export function endGpuWorkWindow(frames: number): GpuWorkCounters {
  const shared = state();
  if (!shared.open) throw new Error("No GPU work window is open");
  const counters = shared.open;
  shared.open = null;
  counters.frames = frames;
  return counters;
}
