import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import {
  CANOPY_SURFACE_AMBIENT,
  CANOPY_SURFACE_SPECULAR,
} from "../src/render/webgpu/detail/densityField";
import { WorldDetailRuntime } from "../src/render/webgpu/detail/WorldDetailRuntime";
import { TerrainBiome } from "../src/world";

/**
 * L-2: near/mid bark is baked into the far impostor, so the two
 * representations must apply the same ambient and specular response.
 * Comparing live Babylon materials catches the old 1 / 1 defaults; a source
 * token check would pass if the values were assigned to the wrong material.
 */
describe("tree LOD material response", () => {
  it("keeps every geometry-band trunk on the shared far-impostor response", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: "tree-lod-material-response",
      terrainSample: () => ({
        height: 80,
        slope: 0.04,
        moisture: 0.7,
        biome: TerrainBiome.FOREST,
      }),
    });

    try {
      const barkMaterials = scene.materials.filter(
        (material): material is PBRMaterial => (
          material instanceof PBRMaterial && material.name.startsWith("detail-bark-")
        ),
      );
      expect(
        barkMaterials.length,
        "the runtime built no bark materials, so the response check is vacuous",
      ).toBeGreaterThan(0);

      for (const bark of barkMaterials) {
        expect(bark.environmentIntensity, bark.name).toBe(CANOPY_SURFACE_AMBIENT);
        expect(bark.specularIntensity, bark.name).toBe(CANOPY_SURFACE_SPECULAR);
      }
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
