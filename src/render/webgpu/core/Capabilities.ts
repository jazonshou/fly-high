export interface WebGpuCapabilityReport {
  readonly supported: boolean;
  readonly reason: string | null;
  readonly features: ReadonlySet<string>;
  readonly limits: Readonly<Record<string, number>>;
}

/** Read-only adapter probe used before constructing the Babylon WebGPU engine. */
export async function inspectWebGpuCapabilities(): Promise<WebGpuCapabilityReport> {
  if (typeof navigator === "undefined") {
    return { supported: false, reason: "WebGPU requires a browser environment.", features: new Set(), limits: {} };
  }
  const gpu = navigator.gpu;
  if (!gpu) {
    return {
      supported: false,
      reason: "This browser does not expose WebGPU. Use a current hardware-accelerated browser.",
      features: new Set(),
      limits: {},
    };
  }
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter || adapter.info.isFallbackAdapter) {
    return {
      supported: false,
      reason: adapter
        ? "Only a software WebGPU adapter is available; hardware acceleration is required."
        : "No compatible WebGPU adapter is available.",
      features: new Set(),
      limits: {},
    };
  }
  const limits: Record<string, number> = {};
  const source = adapter.limits as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "number") limits[key] = value;
  }
  return {
    supported: true,
    reason: null,
    features: new Set([...adapter.features]),
    limits,
  };
}
