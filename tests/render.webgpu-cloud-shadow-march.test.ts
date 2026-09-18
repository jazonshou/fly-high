import { describe, expect, it } from "vitest";
import { CLOUD_SHADOW_WGSL } from "../src/render/webgpu/nature/CloudShaders";

/**
 * wave S — the cloud shadow march.
 *
 * The terrain viewer showed faint horizontal lines scrolling across parked
 * terrain at dusk. They were the cloud shadow map: its jitter was a linear
 * congruence over (texel x, texel y, frame), whose iso-lines run almost
 * exactly east-west and re-phase by 13% of a period on every shadow render,
 * and its march started at the ground and stepped through empty air to the
 * cloud top, so at a low sun each of 20 steps spanned kilometres and the
 * jitter phase decided the transmittance. These pins hold the fix: march the
 * slab only, more steps at low sun, and a stable per-texel hash.
 */
describe("cloud shadow march", () => {
  it("marches the cloud slab from the base-sphere exit to the top-sphere exit", () => {
    expect(CLOUD_SHADOW_WGSL).toContain("params.cloud_radii_density.x,\n  );\n  let outer_hit = cloudRaySphere(");
    expect(CLOUD_SHADOW_WGSL).toContain("let trace_start = max(inner_hit.y, 0.0);");
    expect(CLOUD_SHADOW_WGSL).toContain("let trace_end = max(outer_hit.y, trace_start);");
    expect(CLOUD_SHADOW_WGSL).toContain("let distance = trace_start + (f32(index) + jitter) * step_length;");
    expect(CLOUD_SHADOW_WGSL).toContain("let step_length = (trace_end - trace_start) / max(f32(step_count), 1.0);");
  });

  it("raises the step count at low sun, capped at 48, and unrolls to that cap", () => {
    expect(CLOUD_SHADOW_WGSL).toContain("let elevation = max(dot(radial, sun_direction), 0.25);");
    expect(CLOUD_SHADOW_WGSL).toContain("/ elevation)),\n    48u,\n  );");
    expect(CLOUD_SHADOW_WGSL).toContain("for (var index = 0u; index < 48u; index += 1u) {");
  });

  it("jitters each texel with a stable hash that carries no frame term", () => {
    expect(CLOUD_SHADOW_WGSL).toContain("var hash = (invocation.x * 0x27d4eb2du) ^ (invocation.y * 0x165667b1u);");
    expect(CLOUD_SHADOW_WGSL).toContain("let jitter = f32(hash >> 8u) / 16777216.0;");
    expect(CLOUD_SHADOW_WGSL).not.toContain("invocation.x * 13u");
    expect(CLOUD_SHADOW_WGSL).not.toContain("optical_frame.y) * 17u");
  });
});
