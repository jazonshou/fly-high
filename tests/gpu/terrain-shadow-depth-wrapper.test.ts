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
import { terrainHydrologyFloat16Bits } from "../../src/render/webgpu/terrain/TerrainPageHydrology";

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
    const gpuErrors: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const text = args.map((value) => String(value)).join(" ");
      if (text.includes("uncaptured error") || text.includes("Error while parsing WGSL")) {
        gpuErrors.push(text.slice(0, 400));
      }
      originalWarn(...args);
    };
    try {
      await engine.initAsync();
      // An uncaptured GPU error is what a broken shader looks like from the
      // outside: the pipeline is invalid, the render bundle is invalid, the
      // frame's command buffer is invalid, and the screen goes black while
      // every CPU test stays green. Fail on it.
      engine.onContextLostObservable.add(() => gpuErrors.push("device lost"));
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
      const channelTextures: RawTexture[] = [];
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
      // 4-6/4-7: bind the CHANNEL pages too, so this test compiles the
      // `TERRAIN_SURFACE_PAGE_CHANNELS` fragment path as well. It is the only
      // GPU test that does, and its absence is what let a TypeScript-style
      // ternary — which WGSL does not have — reach a running app.
      const channelEdge = 272;
      const channelTexels = new Uint8Array(channelEdge * channelEdge * 4);
      channelTexels.fill(200);
      const channelPage = (): RawTexture => {
        const texture = RawTexture.CreateRGBATexture(
          channelTexels, channelEdge, channelEdge, scene!, false, false,
          Texture.NEAREST_SAMPLINGMODE,
        );
        channelTextures.push(texture);
        return texture;
      };
      // 6-6: a real r16sint shore-distance page too, so this compiles the
      // hydrology fragment path — the integer textureLoad and the wet-litter
      // block — on a real adapter as well as the analytic one.
      const shoreDistanceTexels = new Int16Array(channelEdge * channelEdge);
      for (let index = 0; index < shoreDistanceTexels.length; index += 1) {
        shoreDistanceTexels[index] = (index % 200) - 40;
      }
      const shoreDistancePage = new RawTexture(
        shoreDistanceTexels, channelEdge, channelEdge,
        Constants.TEXTUREFORMAT_RED_INTEGER, scene, false, false,
        Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_SHORT,
      );
      channelTextures.push(shoreDistancePage);
      // 6-5: and a real r16float lake-depth page, so the lake-bed/bank half of
      // the wetness field compiles on a real adapter too. Half-float, sampled
      // by textureLoad with no companion sampler — the sampler budget does not
      // move, and a driver that refused the combination would fail HERE rather
      // than in the app.
      const lakeDepthTexels = new Uint16Array(channelEdge * channelEdge);
      for (let index = 0; index < lakeDepthTexels.length; index += 1) {
        lakeDepthTexels[index] = terrainHydrologyFloat16Bits((index % 97) * 0.05);
      }
      const lakeDepthPage = RawTexture.CreateRTexture(
        lakeDepthTexels, channelEdge, channelEdge, scene, false, false,
        Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT,
      );
      channelTextures.push(lakeDepthPage);
      plugin.setChannelAtlas(
        channelPage(), channelPage(), channelPage(),
        [channelPage(), channelPage(), channelPage(), channelPage()],
        shoreDistancePage,
        lakeDepthPage,
        {
          atlasEdge: channelEdge,
          slotEdge: 136,
          core: 128,
          gutter: WORLD_PAGE_GUTTER,
          gridEdge: 2,
          basePageExtentMeters: 512,
        },
      );
      plugin.setSeasonBlend(0.4);
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
      // NONZERO, deliberately: at normalBias 0 the `shadowMapVertexNormalBias`
      // include compiles away and this test cannot see the failure that
      // actually shipped — the bare `vNormalW` the include references does not
      // resolve after the WGSL migration, the shadow vertex module fails to
      // compile, and the frame's whole command buffer is invalidated. The
      // renderer's CSM runs at 0.035.
      generator.normalBias = 0.035;
      generator.bias = 0.00035;
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
      // The normal-bias include IS in the source (at a nonzero bias Babylon
      // injects it), and the remap must have rewritten every reference it
      // makes to the varying. A BARE `vNormalW` there is the compile failure
      // that shipped, not a style issue.
      expect(shadowSource).toContain("worldLightDirSM");
      const biasBlock = shadowSource.slice(shadowSource.indexOf("worldLightDirSM"));
      expect(biasBlock.slice(0, 600)).not.toMatch(/[^.\w]vNormalW\b/u);
      // The page-channel fragment path must have compiled too.
      const beautyFragment = material.getEffect()?.fragmentSourceCode ?? "";
      expect(beautyFragment).toContain("terrainSurfacePageSplat");
      expect(beautyFragment).toContain("terrainSurfaceHorizonShadow");
      // 6-6: and so must the HYDROLOGY path — this is the only place an r16sint
      // sampled texture, its sampler-free binding and the integer textureLoad
      // meet a real adapter. The equivalent Tint-only check would pass on
      // invalid WGSL (the adapter-is-not-a-portability-oracle lesson).
      expect(beautyFragment).toContain("terrainSurfaceRiparianBand");
      expect(beautyFragment).toContain("terrainWetLitter");

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

      expect(gpuErrors.join("\n---\n")).toBe("");

      heightAtlas.dispose();
      for (const texture of channelTextures) texture.dispose();
      generator.dispose();
    } finally {
      console.warn = originalWarn;
      scene?.dispose();
      engine.dispose();
      canvas.remove();
    }
  }, 180_000);
});
