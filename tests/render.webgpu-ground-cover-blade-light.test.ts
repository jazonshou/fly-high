import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import {
  GROUND_COVER_NEAR_NORMAL_BLEND,
  GROUND_COVER_ROOT_ALBEDO,
  GROUND_COVER_TIP_ALBEDO,
  GroundCoverMaterialPlugin,
} from "@/src/render/webgpu/detail/GroundCoverMaterialPlugin";

/**
 * `D-2` — a blade is lit like the ground it stands on.
 *
 * Every near meadow was a field of black spikes, for two reasons a frame shows
 * and no other test would: inside 7 m a blade was lit by its own near-
 * horizontal ribbon normal, and `twoSidedLighting` negates the WHOLE normal on
 * a back face, so with any ground share blended in, a blade seen from behind
 * was lit from underneath.
 */
function code(stage: "vertex" | "fragment"): string {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const material = new PBRMaterial("blade-light-test", scene);
  const plugin = new GroundCoverMaterialPlugin(material);
  const source = Object.values(plugin.getCustomCode(stage, ShaderLanguage.WGSL) ?? {}).join("\n");
  material.dispose(true, true);
  scene.dispose();
  engine.dispose();
  return source;
}

describe("D-2 blade lighting", () => {
  it("floors the blend toward the ground's normal at the camera's feet", () => {
    // Mostly the ground, partly itself: under a half the black spikes return,
    // at one a blade is a decal with no form of its own.
    expect(GROUND_COVER_NEAR_NORMAL_BLEND).toBeGreaterThanOrEqual(0.5);
    expect(GROUND_COVER_NEAR_NORMAL_BLEND).toBeLessThan(0.85);
    expect(code("vertex")).toContain(
      `max(${GROUND_COVER_NEAR_NORMAL_BLEND.toFixed(2)}, smoothstep(7.0, 42.0, groundRange))`);
  });

  it("never lights a blade from underneath, whichever face is showing", () => {
    expect(code("fragment")).toContain("normalW = vec3f(normalW.x, abs(normalW.y), normalW.z);");
  });

  it("runs a blade from under its sward's tone to a little over it", () => {
    // The ground a blade stands on is a sward drawn in depth, shaded between
    // its tufts. A root paler than that shade is a stick stood on the turf,
    // one near black is the spike D-2 removed, and a tip far over the sward's
    // mean is the pale blade the 0.7 and 1.32 pair drew on it.
    expect(GROUND_COVER_ROOT_ALBEDO).toBeGreaterThan(0.35);
    expect(GROUND_COVER_ROOT_ALBEDO).toBeLessThan(0.6);
    expect(GROUND_COVER_TIP_ALBEDO).toBeGreaterThan(0.95);
    expect(GROUND_COVER_TIP_ALBEDO).toBeLessThan(1.2);
    expect(code("fragment")).toContain(
      `mix(${GROUND_COVER_ROOT_ALBEDO.toFixed(2)}, ${GROUND_COVER_TIP_ALBEDO.toFixed(2)},`);
  });
});
