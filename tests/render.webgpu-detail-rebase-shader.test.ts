import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { DetailInstanceMaterialPlugin } from "../src/render/webgpu/detail/DetailInstanceMaterialPlugin";

describe("detail-instance floating-origin shader compensation (67d)", () => {
  it("uses the per-batch mesh offset for distance and impostor-facing calculations", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const material = new PBRMaterial("detail-rebase-shader", scene);
      const plugin = new DetailInstanceMaterialPlugin(material);
      const vertex = plugin.getCustomCode("vertex", ShaderLanguage.WGSL)!;
      const positionCode = vertex["CUSTOM_VERTEX_UPDATE_POSITION"]!;

      expect(positionCode).toContain(
        "let detailInstancePositionW = vertexInputs.instancePosition",
      );
      expect(positionCode).toContain("+ uniforms.detailMeshOffset.xyz");
      expect(positionCode).toContain(
        "scene.vEyePosition.xyz - detailInstancePositionW",
      );
      expect(positionCode).toContain(
        "detailBandWindowEmpty(2.0, detailInstancePositionW)",
      );
      expect(positionCode).toMatch(
        /floor\(vertexInputs\.instanceState\.x \* 255\.0 \+ 0\.5\) \/ 2\.0,\s+detailInstancePositionW,/,
      );
      expect(positionCode).not.toContain(
        "scene.vEyePosition.xyz - vertexInputs.instancePosition",
      );

      const offsetWrites: Array<readonly number[]> = [];
      const uniformBuffer = {
        updateFloat4: (name: string, x: number, y: number, z: number, w: number) => {
          if (name === "detailMeshOffset") offsetWrites.push([x, y, z, w]);
        },
      } as never;
      for (const position of [
        { x: 512, y: 30, z: -256 },
        { x: 0, y: 0, z: 0 },
      ]) {
        plugin.hardBindForSubMesh(
          uniformBuffer,
          undefined,
          undefined,
          { getMesh: () => ({ position }) } as never,
        );
      }
      // Both meshes share one plugin/material. The unconditional hard-bind
      // lifecycle must replace the stale batch's offset before the following
      // rebuilt batch draws, even when Babylon reuses the material effect.
      expect(offsetWrites).toEqual([
        [512, 30, -256, 0],
        [0, 0, 0, 0],
      ]);
      expect(plugin.getUniforms().ubo).toContainEqual({
        name: "detailMeshOffset",
        size: 4,
        type: "vec4",
      });
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });

});
