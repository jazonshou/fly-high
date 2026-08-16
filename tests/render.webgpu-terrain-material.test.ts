import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import {
  TERRAIN_MATERIAL_FRAGMENT_GLSL,
  TERRAIN_MATERIAL_FRAGMENT_WGSL,
  TerrainMaterialPlugin,
} from "../src/render/webgpu/terrain/TerrainMaterialPlugin";

describe("terrain PBR procedural material detail", () => {
  it("uses absolute coordinates, non-banded rock mottle, and near triplanar micro normals", () => {
    const code = TERRAIN_MATERIAL_FRAGMENT_WGSL.CUSTOM_FRAGMENT_BEFORE_LIGHTS;
    expect(code).toContain("terrainWorldOrigin");
    expect(code).toContain("terrainSlope");
    expect(code).toContain("terrainRockMottle");
    expect(code).not.toContain("sin(terrainAbsolutePosition.y");
    expect(code).toContain("terrainTriplanarNoise");
    expect(code).toContain("normalW = normalize");
    expect(code).toContain("smoothstep(1200.0, 4200.0");
    expect(TERRAIN_MATERIAL_FRAGMENT_GLSL.CUSTOM_FRAGMENT_BEFORE_LIGHTS).toContain(
      "terrainTriplanarNoise",
    );
  });

  it("publishes compatible WGSL and GLSL PBR injection points", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const material = new PBRMaterial("terrain-test", scene);
    const plugin = new TerrainMaterialPlugin(material);

    expect(plugin.isCompatible()).toBe(true);
    expect(plugin.getUniforms()).toEqual({
      ubo: [{ name: "terrainWorldOrigin", size: 2, type: "vec2" }],
    });
    expect(plugin.getCustomCode("fragment", ShaderLanguage.WGSL)).toBe(
      TERRAIN_MATERIAL_FRAGMENT_WGSL,
    );
    expect(plugin.getCustomCode("fragment", ShaderLanguage.GLSL)).toBe(
      TERRAIN_MATERIAL_FRAGMENT_GLSL,
    );
    expect(plugin.getCustomCode("vertex", ShaderLanguage.WGSL)).toBeNull();

    material.dispose(true, true);
    scene.dispose();
    engine.dispose();
  });
});
