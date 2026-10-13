import { afterEach, describe, expect, it } from "vitest";
import {
  beginGpuWorkWindow,
  endGpuWorkWindow,
  installGpuWorkCounters,
  stablePassLabel,
  uninstallGpuWorkCounters,
} from "./perf/gpuWorkCounters";

/**
 * The counters wrap WebGPU prototypes, which Node does not have. These fakes
 * stand in for the classes the browser exposes so the arithmetic — what is
 * counted, against which pass, and only inside a window — is pinned without a
 * GPU. The browser half is exercised by every cloud A/B run.
 *
 * Every fake records the arguments it receives: a wrapper that counted the
 * work but dropped or reordered an argument would change what the GPU draws.
 */
const received: unknown[][] = [];

class FakeTexture {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly sampleCount = 1,
  ) {}

  createView(descriptor?: { baseMipLevel?: number }): object {
    received.push(["createView", descriptor]);
    return {};
  }
}
class FakeRenderPass {
  draw(vertexCount: number, instanceCount?: number): void {
    received.push(["draw", vertexCount, instanceCount]);
  }

  drawIndexed(indexCount: number, instanceCount?: number): void {
    received.push(["drawIndexed", indexCount, instanceCount]);
  }

  drawIndirect(): void {}
  drawIndexedIndirect(): void {}
  setPipeline(): void {}
  setBindGroup(): void {}
  executeBundles(bundles: unknown[]): void {
    received.push(["executeBundles", bundles]);
  }

  end(): void {}
}
class FakeComputePass {
  dispatchWorkgroups(x: number, y?: number, z?: number): void {
    received.push(["dispatchWorkgroups", x, y, z]);
  }

  dispatchWorkgroupsIndirect(): void {}
  setPipeline(): void {}
  setBindGroup(): void {}
  end(): void {}
}
class FakeEncoder {
  beginRenderPass(descriptor: unknown): FakeRenderPass {
    received.push(["beginRenderPass", descriptor]);
    return new FakeRenderPass();
  }

  beginComputePass(descriptor?: unknown): FakeComputePass {
    received.push(["beginComputePass", descriptor]);
    return new FakeComputePass();
  }

  copyBufferToBuffer(): void {}
  copyTextureToTexture(): void {}
}
class FakeQueue {
  submit(buffers: unknown[]): void {
    received.push(["submit", buffers]);
  }

  writeBuffer(buffer: object, offset: number, data: unknown, dataOffset?: number, size?: number): void {
    received.push(["writeBuffer", buffer, offset, data, dataOffset, size]);
  }

  writeTexture(): void {}
}
class FakeDevice {
  createRenderPipeline(): object {
    return {};
  }

  createBuffer(descriptor: { size: number }): object {
    received.push(["createBuffer", descriptor]);
    return {};
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
const FAKES: Record<string, unknown> = {
  GPUTexture: FakeTexture,
  GPURenderPassEncoder: FakeRenderPass,
  GPUComputePassEncoder: FakeComputePass,
  GPUCommandEncoder: FakeEncoder,
  GPUQueue: FakeQueue,
  GPUDevice: FakeDevice,
};

function installFakes(): void {
  for (const [name, value] of Object.entries(FAKES)) globals[name] = value;
}

afterEach(() => {
  received.length = 0;
  uninstallGpuWorkCounters();
  for (const name of Object.keys(FAKES)) delete globals[name];
});

describe("GPU work counters", () => {
  it("drops Babylon's per-frame pass prefix and suffix so a pass keeps one key", () => {
    expect(stablePassLabel("[12|3] - terrain-shadow - RenderPass", "render"))
      .toBe("terrain-shadow");
    expect(stablePassLabel("[7|0] - MainRenderPass", "render")).toBe("MainRenderPass");
    expect(stablePassLabel(undefined, "compute")).toBe("(unlabelled compute pass)");
  });

  it("counts draws, vertices, attachment pixels and dispatches per pass, only inside a window", () => {
    installFakes();
    installGpuWorkCounters();
    const colour = new FakeTexture(1_100, 619);
    const depth = new FakeTexture(1_100, 619);
    const colourView = colour.createView();
    const depthView = depth.createView();
    const mip1 = new FakeTexture(512, 512).createView({ baseMipLevel: 1 });
    const encoder = new FakeEncoder();
    const queue = new FakeQueue();

    // Outside a window nothing is counted.
    encoder.beginRenderPass({ label: "[1|0] - MainRenderPass", colorAttachments: [{ view: colourView }] })
      .draw(3);

    beginGpuWorkWindow();
    const main = encoder.beginRenderPass({
      label: "[2|0] - MainRenderPass",
      colorAttachments: [{ view: colourView }, null],
      depthStencilAttachment: { view: depthView },
    });
    main.setPipeline();
    main.setBindGroup();
    main.drawIndexed(600, 10);
    main.draw(3);
    main.drawIndirect();
    const half = encoder.beginRenderPass({ label: "[2|1] - bloom - RenderPass", colorAttachments: [{ view: mip1 }] });
    half.draw(3);
    const compute = encoder.beginComputePass({ label: "ocean-fft" });
    compute.dispatchWorkgroups(16, 16);
    compute.dispatchWorkgroups(4);
    compute.dispatchWorkgroupsIndirect();
    queue.writeBuffer({}, 0, new Float32Array(16));
    queue.writeBuffer({}, 0, new Float32Array(16), 4, 2);
    queue.submit([{}, {}]);
    new FakeDevice().createBuffer({ size: 256 });
    new FakeDevice().createRenderPipeline();
    const counters = endGpuWorkWindow(1);

    expect(counters.frames).toBe(1);
    expect(counters.renderPasses).toBe(2);
    expect(counters.computePasses).toBe(1);
    expect(counters.draws).toBe(3);
    expect(counters.indirectDraws).toBe(1);
    expect(counters.vertices).toBe(600 * 10 + 3 + 3);
    expect(counters.instances).toBe(10 + 1 + 1);
    expect(counters.attachmentPixels).toBe(2 * 1_100 * 619 + 256 * 256);
    expect(counters.dispatches).toBe(2);
    expect(counters.indirectDispatches).toBe(1);
    expect(counters.workgroups).toBe(16 * 16 + 4);
    expect(counters.bufferUploadBytes).toBe(64 + 8);
    expect(counters.submits).toBe(1);
    expect(counters.commandBuffers).toBe(2);
    expect(counters.buffersCreated).toBe(1);
    expect(counters.bufferBytesCreated).toBe(256);
    expect(counters.pipelinesCreated).toBe(1);
    expect(counters.passes["render:MainRenderPass"]).toMatchObject({
      passes: 1,
      draws: 2,
      indirectDraws: 1,
      vertices: 6_003,
      pipelineSwitches: 1,
      bindGroupSets: 1,
      attachmentPixels: 2 * 1_100 * 619,
    });
    expect(counters.passes["render:bloom"]).toMatchObject({ draws: 1, attachmentPixels: 65_536 });
    expect(counters.passes["compute:ocean-fft"]).toMatchObject({ dispatches: 2, workgroups: 260 });

    // Every wrapped call reached the original with its arguments intact.
    const uploaded = new Float32Array(16);
    queue.writeBuffer({}, 0, uploaded, 4, 2);
    expect(received.at(-1)).toEqual(["writeBuffer", {}, 0, uploaded, 4, 2]);
    expect(received).toContainEqual(["drawIndexed", 600, 10]);
    expect(received).toContainEqual(["dispatchWorkgroups", 16, 16, undefined]);
    expect(received).toContainEqual(["createBuffer", { size: 256 }]);

    // Closed again: nothing more accrues, and a second window starts at zero.
    main.draw(3);
    beginGpuWorkWindow();
    expect(endGpuWorkWindow(1).draws).toBe(0);
  });

  it("refuses nested windows and windows before installation", () => {
    expect(() => beginGpuWorkWindow()).toThrow(/installGpuWorkCounters/u);
    installFakes();
    installGpuWorkCounters();
    beginGpuWorkWindow();
    expect(() => beginGpuWorkWindow()).toThrow(/already open/u);
    endGpuWorkWindow(1);
    expect(() => endGpuWorkWindow(1)).toThrow(/No GPU work window/u);
  });

  it("restores the original prototypes on uninstall", () => {
    installFakes();
    const original = FakeRenderPass.prototype.draw;
    installGpuWorkCounters();
    expect(FakeRenderPass.prototype.draw).not.toBe(original);
    uninstallGpuWorkCounters();
    expect(FakeRenderPass.prototype.draw).toBe(original);
  });
});
