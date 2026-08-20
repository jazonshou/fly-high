import { describe, expect, it } from "vitest";
// Side-effect imports: the shadow scene component and the thin-instance API.
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import {
  attachTerrainSurfacePlugin,
  createTerrainMaterial,
} from "../../src/render/webgpu/terrain/TerrainClipmapSystem";
import { buildTerrainNodeGrid } from "../../src/render/webgpu/terrain/TerrainQuadtree";
import {
  TERRAIN_HEIGHT_SLOT_EDGE,
  TERRAIN_MORPH_FORBIDDEN_VERTEX_SYMBOLS,
} from "../../src/render/webgpu/terrain/TerrainSpineContract";
import { WORLD_PAGE_GUTTER } from "../../src/render/webgpu/world/pageGeometry";

/**
 * Assertion 81 (`4-4`, D7): the REAL terrain material's shadow-map effect
 * carries the displacement include.
 *
 * `ARCHITECTURE.md`'s `0-9` entry records the failure mode: a
 * `ShadowDepthWrapper` attached AFTER the material's first effect compiles
 * silently falls back to the undisplaced default depth pass — the terrain
 * casts the shadow of a flat plane. That is visually plausible and completely
 * invisible to a CPU test, which is why this one exists and why it is written
 * against the material factory the renderer actually calls rather than a
 * synthetic stand-in.
 */
describe("terrain shadow depth wrapper (4-4)", () => {
  it("compiles a shadow effect that carries the vertex displacement", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, {
      antialias: false,
      enableAllFeatures: false,
      setMaximumLimits: false,
    });
    let scene: Scene | null = null;
    try {
      await engine.initAsync();
      scene = new Scene(engine);
      scene.clearColor = new Color4(0, 0, 0, 1);
      const camera = new FreeCamera("camera", new Vector3(0, 200, -200), scene);
      camera.mode = Camera.PERSPECTIVE_CAMERA;
      camera.setTarget(Vector3.Zero());
      scene.activeCamera = camera;

      const light = new DirectionalLight(
        "sun",
        new Vector3(0.4, -1, 0.3).normalize(),
        scene,
      );
      light.position = new Vector3(0, 200, 0);
      light.autoUpdateExtends = false;
      light.shadowFrustumSize = 600;
      light.shadowMinZ = 1;
      light.shadowMaxZ = 600;

      // The REAL factory, in the REAL order: plugins first, then the wrapper,
      // then — and only then — the first effect.
      const material = createTerrainMaterial(scene);
      const plugin = attachTerrainSurfacePlugin(material, scene);
      expect(material.shadowDepthWrapper).toBeTruthy();

      const atlasEdge = 2 * TERRAIN_HEIGHT_SLOT_EDGE;
      const heights = new Float32Array(atlasEdge * atlasEdge);
      for (let index = 0; index < heights.length; index += 1) {
        heights[index] = 40 * Math.sin(index * 0.001);
      }
      const heightAtlas = RawTexture.CreateRTexture(
        heights, atlasEdge, atlasEdge, scene, false, false,
        Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT,
      );
      plugin.setHeightAtlas(heightAtlas, {
        atlasEdge,
        slotEdge: TERRAIN_HEIGHT_SLOT_EDGE,
        gutter: WORLD_PAGE_GUTTER,
        gridEdge: 2,
      });
      expect(plugin.isCdlod).toBe(true);

      const mesh = new Mesh("terrain-cdlod", scene);
      buildTerrainNodeGrid().applyToMesh(mesh, false);
      mesh.material = material;
      mesh.alwaysSelectAsActiveMesh = true;
      const matrices = new Float32Array(2 * 16);
      const laneA = new Float32Array(2 * 4);
      const laneB = new Float32Array(2 * 4);
      for (let index = 0; index < 2; index += 1) {
        matrices[index * 16] = 512;
        matrices[index * 16 + 5] = 1;
        matrices[index * 16 + 10] = 512;
        matrices[index * 16 + 12] = index * 512;
        matrices[index * 16 + 15] = 1;
        laneA[index * 4 + 3] = 2 * 1_600 + 3 * 100 + 40;
        laneB[index * 4 + 2] = 2;
      }
      mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
      mesh.thinInstanceSetBuffer("terrainNodeA", laneA, 4, false);
      mesh.thinInstanceSetBuffer("terrainNodeB", laneB, 4, false);

      const generator = new ShadowGenerator(1_024, light);
      generator.addShadowCaster(mesh);

      // Render until the shadow effect exists — the wrapper compiles it lazily
      // through onEffectCreatedObservable.
      let shadowSource = "";
      for (let frame = 0; frame < 60 && shadowSource === ""; frame += 1) {
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        const subMesh = mesh.subMeshes[0];
        const effect = subMesh
          ? material.shadowDepthWrapper?.getEffect(subMesh, generator, 0)?.effect
          : undefined;
        if (effect?.isReady()) shadowSource = effect.vertexSourceCode;
        await new Promise((resolve) => setTimeout(resolve, 16));
      }

      expect(shadowSource, "no shadow effect ever compiled").not.toBe("");
      // The BEAUTY effect must carry it too, or the two surfaces disagree —
      // which is the depth-fighting failure a shadow-only check would miss.
      expect(material.isReady(mesh, false)).toBe(true);
      expect(material.getEffect()?.vertexSourceCode ?? "").toContain("terrainSampleHeight");
      // The displacement, in the SHADOW pass: without it the terrain casts the
      // shadow of a flat plane.
      expect(shadowSource).toContain("terrainSampleHeight");
      expect(shadowSource).toContain("terrainNodeA");
      expect(shadowSource).toContain("terrainNodeB");

      // Assertion 83a, on the same source: `morphK` must come from the
      // instance record, never from camera state. The same vertex shader runs
      // for the beauty camera, for each cascade under this wrapper, and for
      // the planar-reflection camera — an in-shader camera-relative morph
      // makes those three disagree about where the ground is.
      const morphBlock = shadowSource.slice(
        shadowSource.indexOf("let gridPosition = positionUpdated.xz"),
        shadowSource.indexOf("positionUpdated.y = fine"),
      );
      expect(morphBlock.length).toBeGreaterThan(0);
      for (const symbol of TERRAIN_MORPH_FORBIDDEN_VERTEX_SYMBOLS) {
        expect(morphBlock.includes(symbol), `morph reads ${symbol}`).toBe(false);
      }

      heightAtlas.dispose();
      generator.dispose();
    } finally {
      scene?.dispose();
      engine.dispose();
      canvas.remove();
    }
  }, 180_000);
});
