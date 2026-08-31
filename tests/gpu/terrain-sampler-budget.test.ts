import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSurfaceMaterialArrays } from "@/src/render/webgpu/terrain/MaterialArrayUpload";
import { TerrainSurfacePlugin } from "@/src/render/webgpu/terrain/TerrainSurfacePlugin";
import { terrainHydrologyFloat16Bits } from "@/src/render/webgpu/terrain/TerrainPageHydrology";
import {
  TERRAIN_NODE_ATTRIBUTE_A,
  TERRAIN_NODE_ATTRIBUTE_B,
  TERRAIN_NODE_ATTRIBUTE_STRIDE,
  TERRAIN_HYDROLOGY_ADDS_SAMPLED_BINDINGS,
  TERRAIN_SAMPLED_BINDINGS,
} from "@/src/render/webgpu/terrain/TerrainSpineContract";

/**
 * `6-11.4` — the sampled-binding budget, asserted against the COMPILED effect.
 *
 * `TERRAIN_SAMPLED_BINDINGS` is a hand-maintained list. Until this file existed
 * the only things asserted of it were that its entries are unique and that its
 * length is under `maxTexturesImageUnits` — both statements about the LIST, and
 * neither about the shader it claims to describe. A list checked only against a
 * limit passes forever while drifting arbitrarily far from the artifact, and
 * every number quoted from it inherits the drift. Phase 6 quoted it three times
 * (6-5's and 6-6's binding arithmetic, and §5.6's headroom paragraph), which is
 * how three different sampler counts — 11, 8 and 15 — came to be in circulation
 * at once. Measured here, the truth was a fourth number none of them.
 *
 * Two permutations are compiled, because the set is CONFIGURATION-DEPENDENT and
 * a single flat list cannot describe it honestly:
 *  - the base shipping terrain material (page atlases, triplanar, CDLOD), and
 *  - the same material with 6-5's hydrology channels bound.
 * Both run with a cascaded shadow generator and `receiveShadows`, because the
 * shipping beauty mesh sets exactly that (`TerrainClipmapSystem.ts:498`) and a
 * shadow-receiving PBR fragment declares a sampler the earlier list omitted. A
 * narrower scene compiles a NARROWER shader than ships and would pin a budget
 * the shipping build exceeds — the same undercount this test exists to end.
 */

const CANVAS_SIZE = 256;
const PROBE_SEED = "terrain-sampler-budget";

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const gpuErrors: string[] = [];

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, {
    antialias: false,
    enableAllFeatures: false,
    setMaximumLimits: false,
  });
  await engine.initAsync();
  const device = (engine as unknown as { _device: GPUDevice })._device;
  device.addEventListener("uncapturederror", (event) => {
    gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
  });
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

/**
 * Every texture in a WGSL stage that is SAMPLED — declared as some `texture_*`
 * AND paired with a `sampler`.
 *
 * Babylon's WGSL emitter names a sampled texture's halves `<name>Texture` and
 * `<name>Sampler`, so the shared stem is the binding's name and is what the
 * contract lists. A `texture_2d<i32>` read by `textureLoad` has no companion
 * sampler and correctly does not appear — that is precisely why 6-6 could add
 * signed shore distance without moving the budget, so the derivation has to
 * preserve the distinction rather than count every texture it can see.
 *
 * Babylon suffixes a shadow sampler with the light's INDEX in the scene, which
 * is a property of scene construction and not of the terrain material, so those
 * are normalised to a stable stem.
 */
function sampledBindingsOf(source: string): string[] {
  const textures = new Set<string>();
  const samplers = new Set<string>();
  const declaration = /var\s+(\w+)\s*:\s*(texture_\w+|sampler(?:_comparison)?)\b/gu;
  for (const match of source.matchAll(declaration)) {
    const name = match[1]!;
    if (match[2]!.startsWith("texture_")) textures.add(name);
    else samplers.add(name);
  }
  const sampled: string[] = [];
  for (const name of textures) {
    const stem = name.endsWith("Texture") ? name.slice(0, -"Texture".length) : name;
    if (!samplers.has(`${stem}Sampler`) && !samplers.has(`${name}Sampler`)) continue;
    sampled.push(stem.replace(/^(shadowTexture|depthTexture)\d+$/u, "$1"));
  }
  return [...new Set(sampled)].sort((a, b) => a.localeCompare(b));
}

const sorted = (names: readonly string[]): string[] =>
  [...names].sort((a, b) => a.localeCompare(b));

interface CompiledStages {
  readonly fragment: string[];
  readonly vertex: string[];
  readonly vertexSource: string;
}

/** Compiles the terrain material and returns its per-stage sampled bindings. */
async function compileTerrain(hydrology: boolean): Promise<CompiledStages> {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);
  const disposables: { dispose(): void }[] = [];
  try {
    const camera = new FreeCamera("budget-camera", new Vector3(0, 40, -40), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    new HemisphericLight("budget-ambient", Vector3.Up(), scene);
    const sun = new DirectionalLight("budget-sun", new Vector3(0.35, -0.72, 0.6), scene);
    const shadows = new CascadedShadowGenerator(1_024, sun, false);
    disposables.push(shadows);
    shadows.numCascades = 4;
    shadows.filter = ShadowGenerator.FILTER_PCF;
    shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;

    const arrays = createSurfaceMaterialArrays(scene, PROBE_SEED, 32);
    disposables.push(arrays.albedoHeight, arrays.normalMaterial);

    const material = new PBRMaterial("budget-terrain", scene);
    material.metallic = 0;
    material.backFaceCulling = false;
    const plugin = new TerrainSurfacePlugin(material);
    plugin.setArrays(arrays.albedoHeight, arrays.normalMaterial);
    plugin.setSamplingProfile("triplanar", 3);
    plugin.setCanopyBands(150, 3_000, 0.045);

    const heightEdge = 264;
    const heightAtlas = RawTexture.CreateRTexture(
      new Float32Array(heightEdge * heightEdge).fill(12),
      heightEdge, heightEdge, scene, false, false,
      Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT,
    );
    disposables.push(heightAtlas);
    plugin.setHeightAtlas(heightAtlas, {
      atlasEdge: heightEdge, slotEdge: heightEdge, gutter: 4, gridEdge: 1,
    });

    const edge = 136;
    const rgba = (): RawTexture => {
      const texture = RawTexture.CreateRGBATexture(
        new Uint8Array(edge * edge * 4).fill(128), edge, edge, scene, false, false,
        Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE,
      );
      disposables.push(texture);
      return texture;
    };

    let shoreDistance: RawTexture | null = null;
    let lakeDepth: RawTexture | null = null;
    if (hydrology) {
      // r16sint, exactly as the channel atlas builds it: readable only by
      // textureLoad, so it must NOT appear in the sampled set.
      const shoreTexels = new Int16Array(edge * edge);
      for (let index = 0; index < shoreTexels.length; index += 1) {
        shoreTexels[index] = (index % 160) - 60;
      }
      shoreDistance = new RawTexture(
        shoreTexels, edge, edge, Constants.TEXTUREFORMAT_RED_INTEGER, scene, false, false,
        Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_SHORT,
      );
      disposables.push(shoreDistance);
      const lakeTexels = new Uint16Array(edge * edge);
      for (let index = 0; index < lakeTexels.length; index += 1) {
        lakeTexels[index] = terrainHydrologyFloat16Bits((index % 64) * 0.1);
      }
      lakeDepth = RawTexture.CreateRTexture(
        lakeTexels, edge, edge, scene, false, false,
        Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT,
      );
      disposables.push(lakeDepth);
    }

    plugin.setChannelAtlas(
      rgba(), rgba(), rgba(),
      [rgba(), rgba(), rgba(), null],
      shoreDistance,
      lakeDepth,
      {
        atlasEdge: edge, slotEdge: edge, core: 128, gutter: 4,
        gridEdge: 1, basePageExtentMeters: 512,
      },
    );

    const quads = 8;
    const mesh = new Mesh("budget-node", scene);
    const data = new VertexData();
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    for (let z = 0; z <= quads; z += 1) {
      for (let x = 0; x <= quads; x += 1) {
        positions.push(x / quads, 0, z / quads);
        normals.push(0, 1, 0);
      }
    }
    for (let z = 0; z < quads; z += 1) {
      for (let x = 0; x < quads; x += 1) {
        const base = z * (quads + 1) + x;
        indices.push(base, base + 1, base + quads + 1);
        indices.push(base + 1, base + quads + 2, base + quads + 1);
      }
    }
    data.positions = positions;
    data.normals = normals;
    data.indices = indices;
    data.applyToMesh(mesh, false);
    mesh.useVertexColors = false;
    mesh.material = material;
    mesh.receiveShadows = true;
    shadows.addShadowCaster(mesh);
    mesh.thinInstanceSetBuffer(
      "matrix", new Float32Array(Matrix.Identity().toArray()), 16, false);
    mesh.thinInstanceSetBuffer(
      TERRAIN_NODE_ATTRIBUTE_A, new Float32Array([0, 0, 5, 0]),
      TERRAIN_NODE_ATTRIBUTE_STRIDE, false);
    mesh.thinInstanceSetBuffer(
      TERRAIN_NODE_ATTRIBUTE_B, new Float32Array([0, 0, 5, 0]),
      TERRAIN_NODE_ATTRIBUTE_STRIDE, false);
    mesh.thinInstanceCount = 1;

    let ready = false;
    for (let frame = 0; frame < 240 && !ready; frame += 1) {
      engine.beginFrame();
      scene.render();
      engine.endFrame();
      await new Promise((resolve) => setTimeout(resolve, 0));
      ready = material.isReady(mesh);
      if (gpuErrors.length > 0) break;
    }
    expect(gpuErrors, "the terrain permutation produced GPU errors").toEqual([]);
    expect(ready, "the terrain permutation never compiled").toBe(true);

    const effect = mesh.subMeshes[0]?.effect;
    expect(effect, "no effect compiled for the terrain node").toBeTruthy();
    if (hydrology) {
      // The permutation really is the hydrology one — otherwise this test would
      // silently measure the base shader twice and report a zero delta.
      expect(effect!.defines).toMatch(/^#define TERRAIN_SURFACE_HYDROLOGY_CHANNELS/mu);
    }
    return {
      fragment: sampledBindingsOf(effect!.fragmentSourceCode),
      vertex: sampledBindingsOf(effect!.vertexSourceCode),
      vertexSource: effect!.vertexSourceCode,
    };
  } finally {
    for (const disposable of disposables) disposable.dispose();
    scene.dispose();
  }
}

describe("terrain sampled-binding budget (6-11.4)", () => {
  it("pins the contract against the compiled effect, not against a limit", async () => {
    const base = await compileTerrain(false);

    // Non-vacuity: a regex that matched nothing would make every set equal and
    // the pin meaningless. The fragment stage cannot have zero samplers.
    expect(
      base.fragment.length,
      "the derivation found NO sampled fragment bindings — the WGSL declaration "
      + "shape changed and this test is now vacuous rather than passing",
    ).toBeGreaterThan(4);

    expect(
      base.fragment,
      "the compiled fragment stage's sampled bindings have drifted from "
      + "TERRAIN_SAMPLED_BINDINGS.fragment. The SHADER is the truth: update the "
      + "contract, then re-check the binding arithmetic of anything quoting it.",
    ).toEqual(sorted(TERRAIN_SAMPLED_BINDINGS.fragment));

    expect(
      base.vertex,
      "the compiled vertex stage's sampled bindings have drifted from "
      + "TERRAIN_SAMPLED_BINDINGS.vertex.",
    ).toEqual(sorted(TERRAIN_SAMPLED_BINDINGS.vertex));

    // An empty expectation passes for two very different reasons — the stage
    // really samples nothing, or the stage was never compiled. Pin the reason:
    // the CDLOD vertex path DOES bind the height atlas, and reconstructs its
    // bilinear filter from four textureLoads instead of taking a sampler.
    expect(base.vertexSource).toMatch(/var\s+terrainHeightAtlas\s*:\s*texture_2d/u);
    expect(base.vertexSource).toContain("textureLoad(terrainHeightAtlas");
    expect(base.vertexSource).not.toMatch(/var\s+terrainHeightAtlasSampler\s*:/u);

    // The budget claim itself, now made against a MEASURED count rather than
    // against the list's own length. Nothing in src/ asserts this — the
    // contract's docstring claimed a material-factory assertion that does not
    // exist — so this is the only place the limit is checked against reality.
    const cap = engine.getCaps().maxTexturesImageUnits;
    expect(base.fragment.length).toBeLessThanOrEqual(cap);
    expect(base.vertex.length).toBeLessThanOrEqual(cap);
  }, 300_000);

  it("prices 6-5's hydrology permutation, the configuration its headroom quoted", async () => {
    const hydrology = await compileTerrain(true);

    // The measured claim: binding BOTH hydrology channels costs NOTHING in the
    // sampled budget, because both are textureLoad reads — shore distance is
    // r16sint (an integer texture cannot be filtered, so it needs no sampler by
    // rule) and lake depth is r16float read at an exact texel. D-10's sampler
    // arithmetic rests on this, and it is measured here rather than asserted.
    const base: readonly string[] = TERRAIN_SAMPLED_BINDINGS.fragment;
    const added = hydrology.fragment.filter((name) => !base.includes(name));
    expect(added, "the hydrology permutation added a sampled binding").toEqual([]);
    expect(added.length).toBe(TERRAIN_HYDROLOGY_ADDS_SAMPLED_BINDINGS);
    expect(hydrology.fragment).toEqual(sorted(TERRAIN_SAMPLED_BINDINGS.fragment));
    expect(hydrology.fragment).not.toContain("terrainShoreDistanceAtlas");
    expect(hydrology.fragment).not.toContain("terrainLakeDepthAtlas");

    const cap = engine.getCaps().maxTexturesImageUnits;
    expect(
      hydrology.fragment.length,
      "the widest shipping terrain permutation no longer fits the per-stage limit",
    ).toBeLessThanOrEqual(cap);
  }, 300_000);
});
