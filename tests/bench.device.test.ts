import { describe, expect, it } from "vitest";
import {
  buildCommit,
  collectBuild,
  collectDevice,
  type DeviceHost,
} from "../src/bench/device";

/**
 * The `?bench=1` device report, from fake browsers. WebGPU objects keep their
 * values in prototype getters, so the fakes do too: a report built with
 * `JSON.stringify` or `Object.entries` would come back empty.
 */

class FakeAdapterInfo {
  constructor(private readonly values: Record<string, unknown>) {}
  get vendor() { return this.values.vendor; }
  get architecture() { return this.values.architecture; }
  get device() { return this.values.device; }
  get description() { return this.values.description; }
  get isFallbackAdapter() { return this.values.isFallbackAdapter; }
  get subgroupMinSize() { return this.values.subgroupMinSize; }
  get subgroupMaxSize() { return this.values.subgroupMaxSize; }
}

class FakeLimits {
  constructor(private readonly overrides: Record<string, number> = {}) {}
  get maxTextureDimension2D() { return this.overrides.maxTextureDimension2D ?? 16_384; }
  get maxSampledTexturesPerShaderStage() { return 16; }
  get maxBindGroups() { return 4; }
}

function adapter(options: {
  info?: Record<string, unknown> | null;
  legacyInfo?: Record<string, unknown>;
  features?: readonly string[];
  limits?: Record<string, number>;
} = {}) {
  return {
    ...(options.info === null ? {} : {
      info: new FakeAdapterInfo(options.info ?? {
        vendor: "nvidia",
        architecture: "ampere",
        device: "",
        description: "",
        isFallbackAdapter: false,
        subgroupMinSize: 32,
        subgroupMaxSize: 32,
      }),
    }),
    ...(options.legacyInfo
      ? { requestAdapterInfo: () => Promise.resolve(new FakeAdapterInfo(options.legacyInfo!)) }
      : {}),
    features: new Set(options.features ?? ["timestamp-query", "texture-formats-tier1"]),
    limits: new FakeLimits(options.limits),
  };
}

function host(navigator: object): DeviceHost {
  return {
    navigator,
    screen: { width: 2_560, height: 1_440, availWidth: 2_560, availHeight: 1_400, colorDepth: 24 },
    window: { innerWidth: 2_560, innerHeight: 1_329, devicePixelRatio: 1.25 },
  };
}

function chromium(gpuAdapter: unknown = adapter()) {
  return {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0",
    hardwareConcurrency: 16,
    deviceMemory: 8,
    userAgentData: {
      brands: [{ brand: "Chromium", version: "131" }],
      mobile: false,
      platform: "Windows",
      getHighEntropyValues: (hints: readonly string[]) => Promise.resolve({
        hints,
        platformVersion: "15.0.0",
        architecture: "x86",
        bitness: "64",
        model: "",
        wow64: false,
        fullVersionList: [{ brand: "Chromium", version: "131.0.6778.86" }],
      }),
    },
    getBattery: () => Promise.resolve({ charging: false, level: 0.62, dischargingTime: 9_000 }),
    gpu: {
      requestAdapter: (options: unknown) => Promise.resolve(
        (options as { powerPreference?: string }).powerPreference === "high-performance"
          ? gpuAdapter
          : null,
      ),
      getPreferredCanvasFormat: () => "bgra8unorm",
    },
  };
}

describe("the device report", () => {
  it("copies a Chromium machine field by field into plain data", async () => {
    const report = await collectDevice(host(chromium()));

    expect(report.userAgent).toContain("Chrome/131");
    expect(report.hardwareConcurrency).toBe(16);
    expect(report.deviceMemoryGiB).toBe(8);
    expect(report.uaData).toEqual({
      brands: [{ brand: "Chromium", version: "131" }],
      mobile: false,
      platform: "Windows",
      platformVersion: "15.0.0",
      architecture: "x86",
      bitness: "64",
      model: "",
      wow64: false,
      fullVersionList: [{ brand: "Chromium", version: "131.0.6778.86" }],
    });
    expect(report.screen).toEqual({
      width: 2_560, height: 1_440, availWidth: 2_560, availHeight: 1_400, colorDepth: 24, devicePixelRatio: 1.25,
    });
    expect(report.window).toEqual({ innerWidth: 2_560, innerHeight: 1_329 });
    expect(report.battery).toEqual({ charging: false, level: 0.62 });
    expect(report.webgpu).toEqual({
      status: "ok",
      reason: null,
      adapter: {
        vendor: "nvidia",
        architecture: "ampere",
        device: "",
        description: "",
        isFallbackAdapter: false,
        subgroupMinSize: 32,
        subgroupMaxSize: 32,
      },
      features: ["texture-formats-tier1", "timestamp-query"],
      limits: { maxTextureDimension2D: 16_384, maxSampledTexturesPerShaderStage: 16, maxBindGroups: 4 },
      limitShortfalls: [],
      preferredCanvasFormat: "bgra8unorm",
      timestampQuery: true,
    });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("reports a browser without WebGPU or client hints, as Firefox and Safari may be", async () => {
    const report = await collectDevice(host({ userAgent: "Mozilla/5.0 Firefox/140.0", hardwareConcurrency: 8 }));

    expect(report.uaData).toBeNull();
    expect(report.deviceMemoryGiB).toBeNull();
    expect(report.battery).toBeNull();
    expect(report.webgpu).toEqual({
      status: "missing",
      reason: "This browser does not offer WebGPU.",
      adapter: null,
      features: [],
      limits: {},
      limitShortfalls: [],
      preferredCanvasFormat: null,
      timestampQuery: false,
    });
  });

  it("applies the renderer's gates: an adapter, not a fallback, every limit met", async () => {
    const none = await collectDevice(host(chromium(null)));
    expect(none.webgpu.status).toBe("no-adapter");
    expect(none.webgpu.preferredCanvasFormat).toBe("bgra8unorm");

    const rejecting = chromium();
    rejecting.gpu.requestAdapter = () => Promise.reject(new Error("blocklisted"));
    expect((await collectDevice(host(rejecting))).webgpu.status).toBe("no-adapter");

    const throwing = chromium();
    throwing.gpu.requestAdapter = () => {
      throw new Error("synchronous");
    };
    expect((await collectDevice(host(throwing))).webgpu.status).toBe("no-adapter");

    const software = await collectDevice(host(chromium(adapter({
      info: { vendor: "google", architecture: "swiftshader", isFallbackAdapter: true },
    }))));
    expect(software.webgpu.status).toBe("fallback-only");
    expect(software.webgpu.adapter?.architecture).toBe("swiftshader");
    expect(software.webgpu.adapter?.subgroupMinSize).toBeNull();

    const small = await collectDevice(host(chromium(adapter({ limits: { maxTextureDimension2D: 4_096 } }))));
    expect(small.webgpu.status).toBe("limits-short");
    expect(small.webgpu.limitShortfalls).toEqual([
      { limit: "maxTextureDimension2D", required: 8_192, reported: 4_096 },
    ]);
  });

  it("reads adapter details through the older call when the adapter has no info", async () => {
    const report = await collectDevice(host(chromium(adapter({
      info: null,
      legacyInfo: { vendor: "amd", architecture: "rdna-3", device: "", description: "" },
      features: [],
    }))));
    expect(report.webgpu.adapter?.vendor).toBe("amd");
    expect(report.webgpu.adapter?.architecture).toBe("rdna-3");
    expect(report.webgpu.timestampQuery).toBe(false);
  });

  it("does not wait forever on a browser call that never answers", async () => {
    const stalled = chromium();
    stalled.getBattery = () => new Promise(() => undefined);
    stalled.userAgentData.getHighEntropyValues = () => new Promise(() => undefined);
    const report = await collectDevice(host(stalled), 20);
    expect(report.battery).toBeNull();
    expect(report.uaData?.platform).toBe("Windows");
    expect(report.uaData?.platformVersion).toBeNull();
    expect(report.webgpu.status).toBe("ok");
  });
});

describe("the build stamp", () => {
  it("has no commit outside a Pages build", () => {
    expect(buildCommit()).toBeNull();
  });

  it("names the entry script and the path the game is served under", () => {
    const stamp = collectBuild({
      document: {
        querySelector: (selector) => selector === "script[type=\"module\"][src]"
          ? { getAttribute: () => "./assets/index-Bx1yQ9.js" }
          : null,
      },
      location: {
        href: "https://jazonshou.github.io/fly-high/?bench=1",
        pathname: "/fly-high/",
        origin: "https://jazonshou.github.io",
      },
    });
    expect(stamp).toEqual({
      commit: null,
      entryScript: "/fly-high/assets/index-Bx1yQ9.js",
      base: "/fly-high/",
      origin: "https://jazonshou.github.io",
    });
  });

  it("has no entry script on a page without one", () => {
    const stamp = collectBuild({
      document: { querySelector: () => null },
      location: { href: "http://localhost:3000/index.html", pathname: "/index.html", origin: "http://localhost:3000" },
    });
    expect(stamp.entryScript).toBeNull();
    expect(stamp.base).toBe("/");
  });
});
