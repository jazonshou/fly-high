/**
 * Capabilities used by the optional hybrid WebGL 2 frame graph. Detection is
 * deliberately performed on the context already owned by FlightRenderer: a
 * disposable probe context can consume a browser context slot and report a
 * different extension set from the renderer that will do the work.
 */
export interface HybridRenderCapabilities {
  readonly backend: "webgl2";
  readonly webGpuApiAvailable: boolean;
  /** WebGPU exposes no standard hardware ray-query API. This is always false. */
  readonly hardwareRayTracing: false;
  readonly colorBufferFloat: boolean;
  readonly floatLinearFiltering: boolean;
  readonly timerQueries: boolean;
  readonly parallelShaderCompile: boolean;
  readonly anisotropicFiltering: boolean;
  readonly maxTextureSize: number;
  readonly maxRenderbufferSize: number;
  readonly maxDrawBuffers: number;
  readonly maxColorAttachments: number;
  readonly maxSamples: number;
  readonly maxFragmentTextureUnits: number;
}

export interface NavigatorCapabilitySource {
  readonly gpu?: unknown;
}

function finiteInteger(value: unknown, fallback: number, minimum = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.floor(value))
    : fallback;
}

function readLimit(
  context: WebGL2RenderingContext,
  parameter: number | undefined,
  fallback: number,
  minimum = 0,
): number {
  if (parameter === undefined) return fallback;
  try {
    return finiteInteger(context.getParameter(parameter), fallback, minimum);
  } catch {
    return fallback;
  }
}

function hasExtension(context: WebGL2RenderingContext, name: string): boolean {
  try {
    return context.getExtension(name) !== null;
  } catch {
    return false;
  }
}

function defaultNavigatorSource(): NavigatorCapabilitySource | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator as Navigator & NavigatorCapabilitySource;
}

/** Detect optional effects without creating or replacing a graphics context. */
export function detectRenderCapabilities(
  context: WebGL2RenderingContext,
  navigatorSource: NavigatorCapabilitySource | undefined = defaultNavigatorSource(),
): HybridRenderCapabilities {
  return {
    backend: "webgl2",
    webGpuApiAvailable: navigatorSource?.gpu !== undefined,
    // Neither WebGL 2 nor the current WebGPU standard exposes hardware ray queries.
    hardwareRayTracing: false,
    colorBufferFloat: hasExtension(context, "EXT_color_buffer_float"),
    floatLinearFiltering:
      hasExtension(context, "OES_texture_float_linear") ||
      hasExtension(context, "OES_texture_half_float_linear"),
    timerQueries: hasExtension(context, "EXT_disjoint_timer_query_webgl2"),
    parallelShaderCompile: hasExtension(context, "KHR_parallel_shader_compile"),
    anisotropicFiltering:
      hasExtension(context, "EXT_texture_filter_anisotropic") ||
      hasExtension(context, "MOZ_EXT_texture_filter_anisotropic") ||
      hasExtension(context, "WEBKIT_EXT_texture_filter_anisotropic"),
    maxTextureSize: readLimit(context, context.MAX_TEXTURE_SIZE, 2_048, 1),
    maxRenderbufferSize: readLimit(context, context.MAX_RENDERBUFFER_SIZE, 2_048, 1),
    maxDrawBuffers: readLimit(context, context.MAX_DRAW_BUFFERS, 1, 1),
    maxColorAttachments: readLimit(context, context.MAX_COLOR_ATTACHMENTS, 1, 1),
    maxSamples: readLimit(context, context.MAX_SAMPLES, 0),
    maxFragmentTextureUnits: readLimit(
      context,
      context.MAX_TEXTURE_IMAGE_UNITS,
      8,
      1,
    ),
  };
}
