import { findWebGpuLimitShortfalls, readWebGpuLimits } from "@/src/render/webgpu/core/Capabilities";
import type { BenchAdapterInfo, BenchDeviceReport, BenchWebGpuStatus } from "./types";

/**
 * `?bench=1`: what the report says about the machine and the build. Collected
 * on the intro page, before any renderer exists, and never with WebGL: the
 * game is WebGPU-only and `tests/render.webgpu-only.test.ts` holds `src/` to
 * that. Everything is copied field by field into plain data, because WebGPU
 * and user-agent objects keep their values in prototype getters, which
 * `JSON.stringify` drops (see `readWebGpuLimits`).
 *
 * WebGPU's status uses the renderer's own three gates: an adapter, not a
 * software fallback, and every declared limit met. `rendererLabel` stays null
 * here; the report fills it from a step's `getDiagnostics().adapter`.
 */

type UserAgentDataReport = NonNullable<BenchDeviceReport["uaData"]>;
type WebGpuReport = BenchDeviceReport["webgpu"];

/** The browser globals `collectDevice` reads, injectable for tests. */
export interface DeviceHost {
  readonly navigator: object;
  readonly screen: {
    readonly width: number;
    readonly height: number;
    readonly availWidth: number;
    readonly availHeight: number;
    readonly colorDepth: number;
  };
  readonly window: {
    readonly innerWidth: number;
    readonly innerHeight: number;
    readonly devicePixelRatio: number;
  };
}

interface NavigatorFields {
  readonly userAgent?: string;
  readonly hardwareConcurrency?: number;
  readonly deviceMemory?: number;
  readonly userAgentData?: {
    readonly brands?: readonly unknown[];
    readonly mobile?: boolean;
    readonly platform?: string;
    getHighEntropyValues?(hints: readonly string[]): Promise<Record<string, unknown>>;
  };
  getBattery?(): Promise<{ readonly charging?: boolean; readonly level?: number }>;
  readonly gpu?: {
    requestAdapter(options?: { powerPreference?: string }): Promise<AdapterLike | null>;
    getPreferredCanvasFormat?(): string;
  };
}

interface AdapterLike {
  readonly info?: object;
  /** Before `info`, Chromium exposed this on the adapter and the details through a call. */
  readonly isFallbackAdapter?: boolean;
  requestAdapterInfo?(): Promise<object>;
  readonly features: Iterable<string>;
  readonly limits: object;
}

const HIGH_ENTROPY_HINTS = [
  "platformVersion",
  "architecture",
  "bitness",
  "model",
  "wow64",
  "fullVersionList",
] as const;

/** Each browser call waits at most this long, so the intro never hangs on one. */
export const DEVICE_QUERY_TIMEOUT_MS = 5_000;

function browserDeviceHost(): DeviceHost {
  return { navigator, screen, window };
}

/** The machine as the report records it. Never throws; a missing API reads null. */
export async function collectDevice(
  host: DeviceHost = browserDeviceHost(),
  timeoutMs: number = DEVICE_QUERY_TIMEOUT_MS,
): Promise<BenchDeviceReport> {
  const nav = host.navigator as NavigatorFields;
  const [uaData, battery, webgpu] = await Promise.all([
    readUserAgentData(nav, timeoutMs),
    readBattery(nav, timeoutMs),
    readWebGpu(nav, timeoutMs),
  ]);
  return {
    userAgent: typeof nav.userAgent === "string" ? nav.userAgent : "",
    uaData,
    hardwareConcurrency: finiteOrNull(nav.hardwareConcurrency),
    deviceMemoryGiB: finiteOrNull(nav.deviceMemory),
    screen: {
      width: host.screen.width,
      height: host.screen.height,
      availWidth: host.screen.availWidth,
      availHeight: host.screen.availHeight,
      colorDepth: host.screen.colorDepth,
      devicePixelRatio: host.window.devicePixelRatio,
    },
    window: { innerWidth: host.window.innerWidth, innerHeight: host.window.innerHeight },
    battery,
    webgpu,
  };
}

async function readUserAgentData(
  nav: NavigatorFields,
  timeoutMs: number,
): Promise<UserAgentDataReport | null> {
  const data = nav.userAgentData;
  if (!data) return null;
  const high = await settleWithin(
    async () => await data.getHighEntropyValues?.([...HIGH_ENTROPY_HINTS]) ?? {},
    timeoutMs,
    {} as Record<string, unknown>,
  );
  return {
    brands: brandList(data.brands),
    mobile: data.mobile === true,
    platform: typeof data.platform === "string" ? data.platform : "",
    platformVersion: stringOrNull(high.platformVersion),
    architecture: stringOrNull(high.architecture),
    bitness: stringOrNull(high.bitness),
    model: stringOrNull(high.model),
    wow64: typeof high.wow64 === "boolean" ? high.wow64 : null,
    fullVersionList: brandList(high.fullVersionList),
  };
}

/** Client-hint brands as "Google Chrome 130.0.6723.70", the form the report's words parse. */
function brandList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry: { brand?: unknown; version?: unknown }) =>
    `${String(entry?.brand ?? "")} ${String(entry?.version ?? "")}`.trim());
}

/** The battery alone, for a step page: a discharging laptop may be throttled. Chromium only. */
export function collectBattery(
  nav: object = navigator,
  timeoutMs: number = DEVICE_QUERY_TIMEOUT_MS,
): Promise<BenchDeviceReport["battery"]> {
  return readBattery(nav as NavigatorFields, timeoutMs);
}

async function readBattery(
  nav: NavigatorFields,
  timeoutMs: number,
): Promise<BenchDeviceReport["battery"]> {
  const getBattery = nav.getBattery;
  if (typeof getBattery !== "function") return null;
  const battery = await settleWithin(() => getBattery.call(nav), timeoutMs, null);
  if (!battery || typeof battery.charging !== "boolean" || typeof battery.level !== "number") return null;
  return { charging: battery.charging, level: battery.level };
}

async function readWebGpu(nav: NavigatorFields, timeoutMs: number): Promise<WebGpuReport> {
  const gpu = nav.gpu;
  const empty = {
    adapter: null,
    features: [],
    limits: {},
    limitShortfalls: [],
    timestampQuery: false,
    rendererLabel: null,
  };
  if (!gpu) {
    return {
      ...empty,
      status: "missing",
      reason: "This browser does not offer WebGPU.",
      preferredCanvasFormat: null,
    };
  }
  let preferredCanvasFormat: string | null = null;
  try {
    preferredCanvasFormat = gpu.getPreferredCanvasFormat?.() ?? null;
  } catch {
    preferredCanvasFormat = null;
  }
  // The renderer's own request (`inspectWebGpuCapabilities`, `FlightRenderer`).
  const adapter = await settleWithin(
    () => gpu.requestAdapter({ powerPreference: "high-performance" }),
    timeoutMs,
    null,
  );
  if (!adapter) {
    return {
      ...empty,
      status: "no-adapter",
      reason: "WebGPU is on, but the browser offered no graphics adapter.",
      preferredCanvasFormat,
    };
  }
  const info = adapter.info ?? await settleWithin(
    async () => await adapter.requestAdapterInfo?.() ?? null,
    timeoutMs,
    null,
  );
  const adapterReport = readAdapterInfo(info, adapter);
  const features = [...adapter.features].sort();
  const limits = readWebGpuLimits(adapter.limits);
  const limitShortfalls = findWebGpuLimitShortfalls(limits);
  const status: BenchWebGpuStatus = adapterReport.isFallbackAdapter
    ? "fallback-only"
    : limitShortfalls.length > 0 ? "limits-short" : "ok";
  return {
    status,
    reason: status === "fallback-only"
      ? "Only a software graphics adapter is available; the game needs hardware acceleration."
      : status === "limits-short"
        ? "This graphics adapter falls short of limits the game needs."
        : null,
    adapter: adapterReport,
    features,
    limits,
    limitShortfalls,
    preferredCanvasFormat,
    timestampQuery: features.includes("timestamp-query"),
    rendererLabel: null,
  };
}

/** `GPUAdapterInfo` keeps every field in a prototype getter, so each is named. */
function readAdapterInfo(info: object | null, adapter: AdapterLike): BenchAdapterInfo {
  const fields = (info ?? {}) as {
    readonly vendor?: unknown;
    readonly architecture?: unknown;
    readonly device?: unknown;
    readonly description?: unknown;
    readonly isFallbackAdapter?: unknown;
    readonly subgroupMinSize?: unknown;
    readonly subgroupMaxSize?: unknown;
  };
  return {
    vendor: String(fields.vendor ?? ""),
    architecture: String(fields.architecture ?? ""),
    device: String(fields.device ?? ""),
    description: String(fields.description ?? ""),
    isFallbackAdapter: fields.isFallbackAdapter === true || adapter.isFallbackAdapter === true,
    subgroupMinSize: finiteOrNull(fields.subgroupMinSize),
    subgroupMaxSize: finiteOrNull(fields.subgroupMaxSize),
  };
}

export interface BuildStamp {
  /** The commit a GitHub Pages build was made from; null for any other build. */
  readonly commit: string | null;
  /** The page's module entry script, whose hashed name also tells builds apart. */
  readonly entryScript: string | null;
  /** The path the game is served under, such as "/fly-high/". */
  readonly base: string;
  readonly origin: string;
}

/** `__FLY_HIGH_COMMIT__` where a build defines it (`src/bench/env.d.ts`). */
export function buildCommit(): string | null {
  return typeof __FLY_HIGH_COMMIT__ === "string" && __FLY_HIGH_COMMIT__ !== ""
    ? __FLY_HIGH_COMMIT__
    : null;
}

export function collectBuild(
  page: {
    readonly document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null };
    readonly location: { readonly pathname: string; readonly origin: string; readonly href: string };
  } = { document, location },
): BuildStamp {
  const src = page.document.querySelector("script[type=\"module\"][src]")?.getAttribute("src") ?? null;
  let entryScript: string | null = null;
  if (src !== null) {
    try {
      entryScript = new URL(src, page.location.href).pathname;
    } catch {
      entryScript = null;
    }
  }
  const { pathname, origin } = page.location;
  return {
    commit: buildCommit(),
    entryScript,
    base: pathname.slice(0, pathname.lastIndexOf("/") + 1),
    origin,
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * What `start` resolves to, or `fallback` if it throws, rejects or takes
 * longer than `ms`.
 */
function settleWithin<T, F>(start: () => Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    Promise.resolve().then(start).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
