import { Buffer, VertexBuffer } from "@babylonjs/core/Buffers/buffer";
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
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Scene } from "@babylonjs/core/scene";
import { DetailInstanceMaterialPlugin } from "../../src/render/webgpu/detail/DetailInstanceMaterialPlugin";
import { CloudShadowMaterialPlugin } from "../../src/render/webgpu/clouds/CloudShadowMaterialPlugin";
import { AerialPerspectiveMaterialPlugin } from "../../src/render/webgpu/atmosphere/AerialPerspective";
import { createFoliageAtlas } from "../../src/render/webgpu/detail/FoliageAtlas";
import {
  DETAIL_INSTANCE_ATTRIBUTES,
  DETAIL_INSTANCE_STRIDE_BYTES,
} from "../../src/render/webgpu/detail/instanceFormat";
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
 * `7-0-d`, second half of P4 — the DETAIL material's inter-stage budget.
 *
 * **Deliberately its OWN FILE, and that is a finding rather than tidiness.**
 * Measuring it in the same file as the terrain case failed to compile with
 * `unresolved value 'terrainSurfaceF0'` — `TerrainSurfacePlugin`'s injected
 * code reaching a material that never had that plugin, across two separate
 * `Scene`s. Whatever the sharing mechanism, the consequence for anyone
 * measuring shader budgets is concrete: **two materials with different plugin
 * sets must not be compiled in one module, or one contaminates the other and
 * the numbers describe a permutation that does not ship.**
 *
 * **SCOPE LIMIT — read before quoting any absolute number from this file.** This
 * rig measures the container's DELTA, not the detail material's headroom. Its
 * baseline inter-stage count is **5**, while E-5 measured the shipping detail
 * material at **12**: the CSM receive path does not activate on this minimal
 * quad, so most of the shipping varying budget is absent. The DELTA is the
 * robust part — it is a property of the container's declarations and reproduces
 * on terrain, whose rig IS production-parity — but **the detail material's
 * remaining headroom is NOT measured here and must not be inferred from these
 * numbers.** Compiling the permutation that ships is the whole point; this one
 * does not, and says so rather than reporting 5/16 as if it were headroom.
 *
 * Two receiver registries are included because `FlightRenderer` registers every
 * detail material with both the cloud-shadow and aerial plugins.
 */

const CANVAS_SIZE = 256;

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

/**
 * The other half of P4: the DETAIL material. It sits at a different varying
 * count from terrain and carries its own hand-rolled key-light term, so its
 * budget is not extrapolable from terrain's — E-5 left it at 12.
 *
 * Production parity here means the two receiver registries too: `FlightRenderer`
 * registers every detail material with BOTH the cloud-shadow and aerial
 * plugins, and their inter-stage declarations ride along. Measuring the
 * material without them would understate exactly the resource under pressure.
 */
async function compileDetail(clustered: boolean): Promise<StageProfile> {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);
  const disposables: { dispose(): void }[] = [];
  try {
    const camera = new FreeCamera("detail-camera", new Vector3(0, 20, -30), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    new HemisphericLight("detail-ambient", Vector3.Up(), scene);
    const sun = new DirectionalLight("detail-sun", new Vector3(0.35, -0.72, 0.6), scene);
    const shadows = new CascadedShadowGenerator(1_024, sun, false, camera, true);
    disposables.push(shadows);
    shadows.numCascades = 4;
    shadows.filter = ShadowGenerator.FILTER_PCF;
    shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    shadows.shadowMaxZ = 200;

    const atlas = createFoliageAtlas(scene, "spike-foliage");
    disposables.push(atlas.texture);

    const material = new PBRMaterial("spike-detail", scene);
    material.albedoColor = new Color3(0.4, 0.5, 0.35);
    material.metallic = 0;
    material.roughness = 0.9;
    material.maxSimultaneousLights = 8;
    const plugin = new DetailInstanceMaterialPlugin(material);
    plugin.setTimeSeconds(1.5);
    new CloudShadowMaterialPlugin(material);
    new AerialPerspectiveMaterialPlugin(material);
    plugin.setBandFades(400, 1_400, 8_000);
    plugin.setFoliageAtlas(atlas.texture);

    if (clustered) {
      const points: PointLight[] = [];
      for (let index = 0; index < 4; index += 1) {
        const light = new PointLight(`detail-point-${index}`, new Vector3(index, 5, 0), scene);
        light.range = 40;
        points.push(light);
      }
      const container = new ClusteredLightContainer("detail-cluster", points, scene);
      disposables.push(container);
    }

    const mesh = new Mesh("spike-detail-mesh", scene);
    const data = new VertexData();
    data.positions = [-1, 0, 0, 1, 0, 0, 1, 4, 0, -1, 4, 0];
    data.normals = [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1];
    data.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
    // Production detail meshes carry vertex colours (the prototype builder
    // supplies them). Without them the clustered permutation fails to compile
    // with "struct member color not found" — a HARNESS gap, not a Babylon
    // defect, and worth the four numbers to rule out.
    data.colors = [
      1, 1, 1, 1, 1, 1, 1, 1,
      1, 1, 1, 1, 1, 1, 1, 1,
    ];
    data.indices = [0, 1, 2, 0, 2, 3];
    data.applyToMesh(mesh, false);
    mesh.setVerticesBuffer(new VertexBuffer(
      engine, new Float32Array([0, 0, 0, 0]), "atlasLayer",
      { updatable: false, instanced: false, size: 1 },
    ));
    const shared = new Buffer(
      engine, new Float32Array(DETAIL_INSTANCE_STRIDE_BYTES / 4),
      false, DETAIL_INSTANCE_STRIDE_BYTES, false, true, true,
    );
    const typeFor = (name: string): number =>
      name === "float" ? VertexBuffer.FLOAT
      : name === "snorm16" ? VertexBuffer.SHORT
      : name === "unorm16" ? VertexBuffer.UNSIGNED_SHORT
      : VertexBuffer.UNSIGNED_BYTE;
    for (const attribute of DETAIL_INSTANCE_ATTRIBUTES) {
      mesh.setVerticesBuffer(new VertexBuffer(engine, shared, attribute.kind, {
        updatable: false, instanced: true, size: attribute.size,
        offset: attribute.byteOffset, stride: DETAIL_INSTANCE_STRIDE_BYTES,
        useBytes: true, type: typeFor(attribute.type), normalized: attribute.normalized,
      }), false);
    }
    mesh.material = material;
    mesh.receiveShadows = true;
    mesh.resetDrawCache(undefined, true);
    mesh.forcedInstanceCount = 1;
    mesh.setBoundingInfo(new BoundingInfo(new Vector3(-30, 0, -30), new Vector3(30, 40, 30)));

    let ready = false;
    for (let frame = 0; frame < 240 && !ready; frame += 1) {
      engine.beginFrame();
      scene.render();
      engine.endFrame();
      await new Promise((resolve) => setTimeout(resolve, 0));
      ready = material.isReady(mesh);
      if (gpuErrors.length > 0) break;
    }
    // eslint-disable-next-line no-console
    console.log(`[spike-detail] clustered=${clustered} ready=${ready} gpuErrors=${gpuErrors.length}`);
    expect(ready, `the detail ${clustered ? "clustered" : "baseline"} permutation never compiled`).toBe(true);
    const effect = mesh.subMeshes[0]?.effect;
    expect(effect, "no detail effect compiled").toBeTruthy();
    return profileFragment(effect!.fragmentSourceCode, effect!.defines);
  } finally {
    for (const disposable of disposables) disposable.dispose();
    scene.dispose();
  }
}

describe("7-0-d: clustered lighting on the DETAIL material", () => {
  it("P4 second half: the DETAIL material's inter-stage budget", async () => {
    const base = await compileDetail(false);
    const clustered = await compileDetail(true);
    const report = {
      interStage: [base.interStage, clustered.interStage],
      allTextures: [base.allTextures.length, clustered.allTextures.length],
      samplers: [base.samplers.length, clustered.samplers.length],
      fragmentStorageBuffers: [base.storageBuffers.length, clustered.storageBuffers.length],
      clusteredDefine: /CLUSTLIGHT/u.test(clustered.defines),
    };
    // eslint-disable-next-line no-console
    console.log(`[spike-detail] ${JSON.stringify(report)}`);
    expect(report.clusteredDefine, "no CLUSTLIGHT define reached the detail material").toBe(true);
    // DELTAS ONLY — see this file's scope limit. The absolute counts here are
    // not the shipping permutation and no headroom claim may be built on them.
    expect(clustered.interStage - base.interStage).toBe(1);
    expect(clustered.samplers.length - base.samplers.length).toBe(0);
    expect(clustered.allTextures.length - base.allTextures.length).toBe(1);
    expect(clustered.storageBuffers.length - base.storageBuffers.length).toBe(1);
    // The rig is knowingly below parity; pin that so nobody later reads its
    // baseline as the detail material's real budget.
    expect(
      base.interStage,
      "this rig's baseline moved — if it now reaches the shipping ~12, the scope "
      + "limit in this file's docblock is stale and headroom CAN be read from it",
    ).toBeLessThan(10);
  }, 180_000);
});
