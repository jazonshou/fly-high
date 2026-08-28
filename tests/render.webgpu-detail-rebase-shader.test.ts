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
        "detailBandWindowEmpty(2.0, detailInstancePositionW, vertexInputs.instanceState.z)",
      );
      expect(positionCode).toMatch(
        /floor\(vertexInputs\.instanceState\.x \* 255\.0 \+ 0\.5\) \/ 2\.0,\s+detailInstancePositionW,\s+vertexInputs\.instanceState\.z,/,
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
      for (const mesh of [
        { position: { x: 512, y: 30, z: -256 } },
        { position: { x: 0, y: 0, z: 0 } },
        // Streaming fix-pack: the `.w` lane carries the mesh's reveal value.
        // A ramping mesh publishes its metadata value; every mesh without
        // one (prototypes, foreign meshes) binds the fully-revealed default.
        { position: { x: 0, y: 0, z: 0 }, metadata: { detailReveal: 0.35 } },
      ]) {
        plugin.hardBindForSubMesh(
          uniformBuffer,
          undefined,
          undefined,
          { getMesh: () => mesh } as never,
        );
      }
      // Both meshes share one plugin/material. The unconditional hard-bind
      // lifecycle must replace the stale batch's offset before the following
      // rebuilt batch draws, even when Babylon reuses the material effect.
      // `.w` defaults to 1 — the reveal collapse compiles to a no-op for
      // every steady-state mesh — and follows metadata.detailReveal exactly
      // while a newly created batch mesh ramps in.
      expect(offsetWrites).toEqual([
        [512, 30, -256, 1],
        [0, 0, 0, 1],
        [0, 0, 0, 0.35],
      ]);
      // The reveal collapse must ride the vertex kill, never a fragment
      // discard (early-Z on the opaque crown is the perf keystone).
      expect(positionCode).toContain("uniforms.detailMeshOffset.w");
      expect(positionCode).toContain("positionUpdated = vec3f(0.0, -100000.0, 0.0);");
      const fragment = plugin.getCustomCode("fragment", ShaderLanguage.WGSL)!;
      for (const code of Object.values(fragment)) {
        expect(code).not.toContain("detailMeshOffset.w");
      }
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
