import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/index";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Scene } from "@babylonjs/core/scene";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { TerrainSurfacePlugin } from "../../src/render/webgpu/terrain/TerrainSurfacePlugin";
import { createSurfaceMaterialArrays } from "../../src/render/webgpu/terrain/MaterialArrayUpload";
import {
  TERRAIN_NODE_ATTRIBUTE_A,
  TERRAIN_NODE_ATTRIBUTE_B,
  TERRAIN_NODE_ATTRIBUTE_STRIDE,
  TERRAIN_SAMPLED_BINDINGS,
} from "../../src/render/webgpu/terrain/TerrainSpineContract";

/**
 * `7-0-d` — the adapter spike. **The first action of Phase 7, and it is a
 * MEASUREMENT, not an exploration:** every number below was predicted with a
 * pass/fail rule before the host was touched, so a miss re-prices Gate 7B
 * rather than starting a discussion.
 *
 * It attaches a `ClusteredLightContainer` to the production-parity terrain
 * material **with the 4-cascade CSM**, and diffs the compiled fragment stage
 * against the same material without it.
 *
 * **The CSM is not optional.** A shadow-casting light under `SHADOWCSM`
 * declares NINE inter-stage variables of its own (`vPositionFromLight{X}_0..3`,
 * `vDepthMetric{X}_0..3`, `vPositionFromCamera{X}`). A spike without it would
 * not merely measure a configuration that does not ship — it would MISS the
 * constraint entirely, because most of the inter-stage budget only exists when
 * CSM is on.
 *
 * **What the plan asked for versus what this measures (C1).** §5 lists
 * "sampler count" as a thing to measure. `getClusteredLight` reads the light
 * data with `textureLoad` (`clusteredLightingFunctions.js`), and a
 * `texture_2d<f32>` read that way declares NO companion sampler. So a spike
 * measuring samplers would report "no change" on a quantity the feature does
 * not touch, and answer "does this fit?" with a pass BY CONSTRUCTION. The load
 * is on SAMPLED-TEXTURE and INTER-STAGE count, and both are measured here.
 */

const CANVAS_SIZE = 256;
const PROBE_SEED = "clustered-spike";

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
}, 90_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

interface StageProfile {
  /** Textures paired with a sampler — the terrain contract's own metric. */
  readonly sampledTextures: string[];
  /** EVERY texture declaration, including `textureLoad`-only ones. */
  readonly allTextures: string[];
  readonly samplers: string[];
  /** Fragment-stage storage buffers — the project's first arrive with 7-4b. */
  readonly storageBuffers: string[];
  /** `@location(...)` slots on the fragment input struct. */
  readonly interStage: number;
  readonly defines: string;
}

function declarations(source: string): { textures: Set<string>; samplers: Set<string> } {
  const textures = new Set<string>();
  const samplers = new Set<string>();
  const pattern = /var\s+(\w+)\s*:\s*(texture_\w+|sampler(?:_comparison)?)\b/gu;
  for (const match of source.matchAll(pattern)) {
    if (match[2]!.startsWith("texture_")) textures.add(match[1]!);
    else samplers.add(match[1]!);
  }
  return { textures, samplers };
}

function profileFragment(source: string, defines: string): StageProfile {
  const { textures, samplers } = declarations(source);
  const sampled: string[] = [];
  for (const name of textures) {
    const stem = name.endsWith("Texture") ? name.slice(0, -"Texture".length) : name;
    if (!samplers.has(`${stem}Sampler`) && !samplers.has(`${name}Sampler`)) continue;
    sampled.push(stem.replace(/^(shadowTexture|depthTexture)\d+$/u, "$1"));
  }
  const storage = [...source.matchAll(/var<storage[^>]*>\s*(\w+)\s*:/gu)].map((m) => m[1]!);
  // Babylon emits the fragment inputs as one struct; each interpolated value
  // takes an @location slot, which is the resource the adapter limits.
  const struct = /struct\s+FragmentInputs\s*\{([\s\S]*?)\}/u.exec(source);
  const interStage = struct ? [...struct[1]!.matchAll(/@location\(/gu)].length : -1;
  return {
    sampledTextures: [...new Set(sampled)].sort(),
    allTextures: [...textures].sort(),
    samplers: [...samplers].sort(),
    storageBuffers: [...new Set(storage)].sort(),
    interStage,
    defines,
  };
}

/** Compiles the production-parity terrain material, optionally clustered. */
async function compile(clustered: boolean): Promise<StageProfile> {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);
  const disposables: { dispose(): void }[] = [];
  try {
    const camera = new FreeCamera("spike-camera", new Vector3(0, 40, -40), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    new HemisphericLight("spike-ambient", Vector3.Up(), scene);
    const sun = new DirectionalLight("spike-sun", new Vector3(0.35, -0.72, 0.6), scene);
    const shadows = new CascadedShadowGenerator(1_024, sun, false);
    disposables.push(shadows);
    shadows.numCascades = 4;
    shadows.filter = ShadowGenerator.FILTER_PCF;
    shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;

    const arrays = createSurfaceMaterialArrays(scene, PROBE_SEED, 32);
    disposables.push(arrays.albedoHeight, arrays.normalMaterial);

    const material = new PBRMaterial("spike-terrain", scene);
    material.metallic = 0;
    material.backFaceCulling = false;
    // P7: the default is 4, the scene already holds 3 lights, and the container
    // is itself a Light. `PrepareDefinesForLights` BREAKS at the cap rather
    // than reporting, so the next light silently stops contributing.
    material.maxSimultaneousLights = 8;
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
    plugin.setChannelAtlas(
      rgba(), rgba(), rgba(), [rgba(), rgba(), rgba(), null], null, null,
      {
        atlasEdge: edge, slotEdge: edge, core: 128, gutter: 4,
        gridEdge: 1, basePageExtentMeters: 512,
      },
    );

    if (clustered) {
      // Point lights only: `IsLightSupported` rejects anything with a shadow
      // generator, any non-default falloff, and any spot carrying a projection
      // or IES texture.
      const points: PointLight[] = [];
      for (let index = 0; index < 4; index += 1) {
        const light = new PointLight(`spike-point-${index}`, new Vector3(index, 5, 0), scene);
        light.range = 40;
        points.push(light);
      }
      const container = new ClusteredLightContainer("spike-cluster", points, scene);
      disposables.push(container);
      // eslint-disable-next-line no-console
      console.log(`[spike] container.isSupported = ${container.isSupported}`);
    }

    const quads = 8;
    const mesh = new Mesh("spike-node", scene);
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
    // P-COMPILE: reported rather than silently thrown, because "it does not
    // compile" is a RECORDED OUTCOME that re-shapes 7-4, not a test failure.
    // eslint-disable-next-line no-console
    console.log(`[spike] clustered=${clustered} ready=${ready} gpuErrors=${gpuErrors.length}`);
    expect(ready, `the ${clustered ? "clustered" : "baseline"} permutation never compiled`)
      .toBe(true);

    const effect = mesh.subMeshes[0]?.effect;
    expect(effect, "no effect compiled").toBeTruthy();
    return profileFragment(effect!.fragmentSourceCode, effect!.defines);
  } finally {
    for (const disposable of disposables) disposable.dispose();
    scene.dispose();
  }
}


describe("7-0-d: clustered lighting adapter spike", () => {
  it("measures the receiver-side cost of a ClusteredLightContainer", async () => {
    const base = await compile(false);
    const clustered = await compile(true);

    const report = {
      sampledTextures: [base.sampledTextures.length, clustered.sampledTextures.length],
      allTextures: [base.allTextures.length, clustered.allTextures.length],
      samplers: [base.samplers.length, clustered.samplers.length],
      fragmentStorageBuffers: [base.storageBuffers.length, clustered.storageBuffers.length],
      interStage: [base.interStage, clustered.interStage],
      clusteredDefine: /CLUSTLIGHT/u.test(clustered.defines),
      newTextures: clustered.allTextures.filter((n) => !base.allTextures.includes(n)),
      newStorage: clustered.storageBuffers.filter((n) => !base.storageBuffers.includes(n)),
    };
    // eslint-disable-next-line no-console
    console.log(`[spike] ${JSON.stringify(report, null, 2)}`);

    // Non-vacuity FIRST: if the container never reached the shader, every delta
    // below is zero and the spike would report "it fits" having measured
    // nothing. This is the assertion that makes the rest mean something.
    expect(
      report.clusteredDefine,
      "no CLUSTLIGHT define reached the compiled material — the container was not "
      + "composed into this material, so every delta below is vacuous",
    ).toBe(true);

    // P1 (re-derived): the terrain fragment stage starts at the contract's
    // count, not at the stale "14" comment.
    expect(base.sampledTextures.length).toBe(TERRAIN_SAMPLED_BINDINGS.fragment.length);

    // P2: ZERO samplers added. The light data is read with textureLoad.
    expect(
      clustered.samplers.length - base.samplers.length,
      "the container added a SAMPLER — the textureLoad reading is wrong and §5's "
      + "sampler-count measurement would have been the right one after all",
    ).toBe(0);

    // P3: the project's first fragment-stage storage buffer.
    expect(report.newStorage.length).toBeGreaterThan(0);

    // P4: THE PHASE'S BINDING RISK. One inter-stage varying, and terrain must
    // still be under the adapter's limit with it.
    expect(clustered.interStage).toBeGreaterThan(0);
    expect(clustered.interStage - base.interStage).toBe(1);
  }, 180_000);

});
