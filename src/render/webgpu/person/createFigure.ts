import { DOUBLE_ZERO } from "@/src/sim/ground/doubleZero";
import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Effect } from "@babylonjs/core/Materials/effect";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import type { Nullable } from "@babylonjs/core/types";
import type { Scene } from "@babylonjs/core/scene";
import type { PipelineWarmUp } from "../core/AsyncPipelineCompiles";
import type { WebGpuQualityProfile } from "../core/QualityProfile";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { AircraftBuildContext } from "../aircraft/builders";
import { createRawTextureFromMipChain } from "../core/MipChainUpload";
import { buildFigureMipChains, FIGURE_NORMAL_MAP_Y_DOWN, type FigureGeometry, type WalkerBodyAsset, type WalkerBodyMaps } from "./walkerBody";
import type { GroundOffset } from "./footPlant";
import { PersonMotion, type MotionInput } from "./motion";
import { BIND_POSITIONS, BONE, BONE_COUNT, BONE_NAMES } from "./skeleton";
import type { PersonAnimationInput, PersonAnimationOutput, PersonVisual } from "./types";

/** The part of `AsyncPipelineCompiles` the figure uses. */
export interface FigurePipelineCompiles extends PipelineWarmUp {
  defer(material: object): void;
}

export interface FigureOptions {
  /** The body's meshes and maps (`loadWalkerBody`), loaded at the tier's texture size. */
  readonly asset: WalkerBodyAsset;
  /** The tier's figure fields; absent, the finest mesh and every cascade. */
  readonly profile?: Pick<WebGpuQualityProfile, "personFigureFinestLod" | "personShadowCascades">;
  readonly pipelineCompiles?: FigurePipelineCompiles | null;
}

/**
 * The camera distances, metres, past which the figure draws its next coarser
 * mesh (the body's four levels: about 33k triangles within 10 m, 10k to 25 m,
 * 3k to 80 m, 1k beyond), and the band either side of each it must cross
 * before it switches back, so a camera at the edge does not flicker between
 * two meshes.
 */
export const FIGURE_LOD_DISTANCES = Object.freeze([10, 25, 80]);
const LOD_HYSTERESIS = 1.5;
/** How far the skin stands off the bones' origins at most (the crown over the head bone, the hips' sides), metres. */
const BOUNDS_MARGIN = 0.22;
/** Frames a prime waits for its effects before warming regardless (one that never compiles has failed loudly already). */
const PRIME_READY_FRAME_LIMIT = 600;
/** A camera layer mask no camera has: the solid figure still casts while its faded twin is drawn. */
const SHADOW_ONLY_LAYER_MASK = 0;

/**
 * The walker's figure: the realistic body of `walkerBody.ts` (a skinned mesh
 * per level of detail, one atlas of albedo, normal and occlusion-roughness-
 * metal maps) on a flat skeleton of `BONE_COUNT` bones, posed every frame by
 * `PersonMotion`.
 *
 * SKINNING. Every bone is parentless and bound at its bind position with no
 * turn, so a bone's matrix is simply its posed transform in the root frame
 * (`FigurePose.globalMatrices`) and Babylon's skin matrix (inverse bind times
 * final) moves a bind-pose vertex to where the pose puts it. The skeleton's
 * matrices are computed once a frame, in `update`, so the shadow passes read
 * this frame's pose even when the figure itself is off screen, and each draw
 * carries them in its uniforms.
 *
 * DRAWS. One mesh per level of detail, of which one draws, in one material,
 * plus its shadow in the nearest `personShadowCascades` cascades: Babylon
 * draws a caster in every cascade, so where the tier asks for fewer the
 * figure takes itself out of the farther ones' lists, and its faces move
 * toward the light by a bias of its own (`FigureShadows`).
 *
 * FADE. A camera pushed inside the walker's personal space fades it. The
 * solid mesh keeps casting, hidden from the cameras, while a twin sharing its
 * geometry draws blended over a depth pre-pass, so only the nearest skin
 * shows and the shadow does not blink out with the figure.
 *
 * PIPELINES. Both materials are deferred with the renderer's off-frame
 * compiles and warmed at load by two primes: one degenerate triangle each in
 * the figure's vertex layout, skeleton and material (the solid one casting,
 * as the figure does), which once their effects are ready are drawn
 * wherever they are until the compiles report them built, then disabled.
 * They rasterise nothing. A capture's
 * synchronous compiles decline the warm-up and the primes never draw; with no
 * off-frame compiles they draw one frame, compiling at load.
 */
export function createFigure(scene: Scene, options: FigureOptions): PersonVisual {
  const finestLod = options.profile?.personFigureFinestLod ?? 0;
  const castCascades = options.profile?.personShadowCascades ?? Number.POSITIVE_INFINITY;
  const compiles = options.pipelineCompiles ?? null;
  const build = new AircraftBuildContext(scene);

  const root = new TransformNode("person-root", scene);
  root.rotationQuaternion = Quaternion.Identity();
  root.metadata = { personVisual: true, bodyAxes: { forward: "+x", up: "+y", right: "+z" } };

  const skeleton = new Skeleton("person-skeleton", "person-skeleton", scene);
  // In the draws' uniforms: Babylon's bone texture went up through a buffer
  // and a submit of its own every frame (measured, tests/gpu/person-figure).
  skeleton.useTextureToStoreBoneMatrices = false;
  const bones: Bone[] = [];
  for (let bone = 0; bone < BONE_COUNT; bone += 1) {
    const bind = Matrix.Translation(BIND_POSITIONS[bone * 3]!, BIND_POSITIONS[bone * 3 + 1]!, BIND_POSITIONS[bone * 3 + 2]!);
    bones.push(new Bone(BONE_NAMES[bone]!, skeleton, null, bind, null, bind, bone));
  }

  const atlas = createFigureTextures(scene, options.asset.maps);
  build.textures.push(atlas.albedo, atlas.normal, atlas.orm);
  const solid = dress(build.material("person-figure", 0xffffff, { roughness: 1, metallic: 1 }), atlas);
  const faded = dress(build.material("person-figure-fade", 0xffffff, { roughness: 1, metallic: 1, alpha: 1 }), atlas);
  // Blended over its own depth pre-pass whatever the alpha, so its pipeline is the one warmed.
  faded.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  faded.needDepthPrePass = true;
  faded.backFaceCulling = true;
  compiles?.defer(solid);
  compiles?.defer(faded);

  const lods: (Mesh | null)[] = [];
  const geometries = options.asset.lods;
  if (geometries.length !== FIGURE_LOD_DISTANCES.length + 1) throw new Error(`walker body: ${geometries.length} levels of detail, the figure switches between ${FIGURE_LOD_DISTANCES.length + 1}`);
  for (let level = 0; level < geometries.length; level += 1) {
    lods.push(level < finestLod ? null : skinnedMesh(scene, `person-figure-lod${level}`, geometries[level]!, skeleton, solid, root, true));
  }
  const finest = lods[finestLod]!;
  const fadeTwin = finest.clone("person-figure-fade", root, true, false);
  fadeTwin.material = faded;
  fadeTwin.skeleton = skeleton;
  fadeTwin.metadata = { personVisual: true, castsShadow: false };
  fadeTwin.isVisible = false;
  const solidPrime = skinnedMesh(scene, "person-pipeline-prime", primeGeometry(), skeleton, solid, null, true);
  const fadePrime = skinnedMesh(scene, "person-pipeline-prime-fade", primeGeometry(), skeleton, faded, null, false);
  const figureMeshes = lods.filter((mesh): mesh is Mesh => mesh !== null);
  const meshes: AbstractMesh[] = [...figureMeshes, fadeTwin, solidPrime, fadePrime];

  const primes = [
    { mesh: solidPrime, castsShadows: true, ready: false, waited: 0, frames: 0, done: false },
    { mesh: fadePrime, castsShadows: false, ready: false, waited: 0, frames: 0, done: false },
  ];
  let primeObserver: Nullable<Observer<Scene>> = scene.onBeforeRenderObservable.add(() => {
    let pending = false;
    for (const prime of primes) {
      if (prime.done) continue;
      // Its effects first, the main pass's and the shadow map's: a pass skips a
      // mesh whose effect is still compiling, and a warm-up that saw only the
      // shadow draw would end without the main pass's pipeline.
      prime.ready ||= prime.mesh.isReady(true) || ++prime.waited > PRIME_READY_FRAME_LIMIT;
      if (!prime.ready) {
        pending = true;
        continue;
      }
      const status = compiles ? compiles.warmUp(prime.mesh, prime.castsShadows) : prime.frames > 0 ? "warm" : "started";
      prime.frames += 1;
      if (status === "warm" || status === "declined") {
        prime.done = true;
        prime.mesh.setEnabled(false);
      } else {
        pending = true;
      }
    }
    if (!pending) {
      scene.onBeforeRenderObservable.remove(primeObserver);
      primeObserver = null;
    }
  });

  const shadows = new FigureShadows(scene, figureMeshes, castCascades, () => root.isEnabled());
  const motion = new PersonMotion();
  const matrices = new Float32Array(BONE_COUNT * 16);
  const boundsMin = new Vector3();
  const boundsMax = new Vector3();
  const output: PersonAnimationOutput = { footStrikes: 0, strikeStrength: DOUBLE_ZERO, strikeFoot: "left" };
  let current: PersonAnimationInput | null = null;
  const ground: GroundOffset = (forward, right) => current?.groundOffset(forward, right) ?? 0;
  const motionInput: Mutable<MotionInput> = {
    person: null as unknown as MotionInput["person"],
    forward: DOUBLE_ZERO,
    up: DOUBLE_ZERO,
    right: DOUBLE_ZERO,
    turnRate: DOUBLE_ZERO,
    ground,
    steeringWheel: DOUBLE_ZERO,
    lookYaw: DOUBLE_ZERO,
    lookPitch: DOUBLE_ZERO,
    boardingFrom: null,
    boardingDoor: null,
  };
  let lod: number = finestLod;
  let visible = true;
  let fade = 0;

  const showMeshes = (): void => {
    const fading = fade > 0;
    for (let level = finestLod; level < lods.length; level += 1) {
      const mesh = lods[level]!;
      mesh.isVisible = visible && level === lod;
      mesh.layerMask = fading && level === lod ? SHADOW_ONLY_LAYER_MASK : DEFAULT_LAYER_MASK;
    }
    fadeTwin.isVisible = visible && fading && fade < 1 && lod === finestLod;
  };

  const chooseLod = (): void => {
    const camera = scene.activeCamera;
    if (fade > 0 || !camera) {
      lod = finestLod;
      return;
    }
    const distance = Vector3.Distance(camera.globalPosition, root.position);
    let level = lod;
    while (level < FIGURE_LOD_DISTANCES.length && distance > FIGURE_LOD_DISTANCES[level]! + LOD_HYSTERESIS) level += 1;
    while (level > 0 && distance < FIGURE_LOD_DISTANCES[level - 1]! - LOD_HYSTERESIS) level -= 1;
    lod = Math.max(finestLod, level);
  };

  showMeshes();

  return {
    root,
    meshes,
    update(input: PersonAnimationInput, deltaSeconds: number): PersonAnimationOutput {
      current = input;
      // The root's velocity in its own axes: the world's turned back by the root's quaternion.
      const q = root.rotationQuaternion!;
      rotateByConjugate(q, input.velocityX, input.velocityY, input.velocityZ, VELOCITY);
      motionInput.person = input.person;
      motionInput.forward = VELOCITY[0]!;
      motionInput.up = VELOCITY[1]!;
      motionInput.right = VELOCITY[2]!;
      motionInput.turnRate = input.turnRate;
      motionInput.steeringWheel = input.steeringWheel;
      motionInput.lookYaw = input.lookYaw ?? 0;
      motionInput.lookPitch = input.lookPitch ?? 0;
      motionInput.boardingFrom = input.boardingFrom ?? null;
      motionInput.boardingDoor = input.boardingDoor ?? null;
      motion.update(motionInput, deltaSeconds, output);
      current = null;

      const pose = motion.pose;
      pose.globalMatrices(matrices);
      for (let bone = 0; bone < BONE_COUNT; bone += 1) {
        Matrix.FromArrayToRef(matrices, bone * 16, bones[bone]!.getLocalMatrix());
        bones[bone]!.markAsDirty();
      }
      skeleton.prepare(true);

      // The drawn figure's box, from its bones: GPU skinning moves the skin where the bind-pose box cannot follow.
      const positions = pose.globalPositions;
      boundsMin.set(Infinity, Infinity, Infinity);
      boundsMax.set(-Infinity, -Infinity, -Infinity);
      for (let bone = 0; bone < BONE_COUNT; bone += 1) {
        const x = positions[bone * 3]!;
        const y = positions[bone * 3 + 1]!;
        const z = positions[bone * 3 + 2]!;
        if (x < boundsMin.x) boundsMin.x = x;
        if (y < boundsMin.y) boundsMin.y = y;
        if (z < boundsMin.z) boundsMin.z = z;
        if (x > boundsMax.x) boundsMax.x = x;
        if (y > boundsMax.y) boundsMax.y = y;
        if (z > boundsMax.z) boundsMax.z = z;
      }
      boundsMin.addInPlaceFromFloats(-BOUNDS_MARGIN, -BOUNDS_MARGIN, -BOUNDS_MARGIN);
      boundsMax.addInPlaceFromFloats(BOUNDS_MARGIN, BOUNDS_MARGIN, BOUNDS_MARGIN);

      // Every mesh's, so the one a LOD switch or a fade shows next is already right.
      for (const mesh of figureMeshes) mesh.getBoundingInfo().reConstruct(boundsMin, boundsMax);
      fadeTwin.getBoundingInfo().reConstruct(boundsMin, boundsMax);
      chooseLod();
      showMeshes();
      shadows.attach();
      return output;
    },
    setFirstPersonView(enabled: boolean): void {
      motion.setFirstPersonView(enabled);
    },
    setFade(amount: number): void {
      const next = Math.min(1, Math.max(0, amount));
      if (next === fade) return;
      fade = next;
      faded.alpha = 1 - fade;
      if (fade > 0) lod = finestLod;
      showMeshes();
    },
    setVisible(enabled: boolean): void {
      visible = enabled;
      showMeshes();
    },
    dispose(): void {
      if (primeObserver) scene.onBeforeRenderObservable.remove(primeObserver);
      primeObserver = null;
      shadows.dispose();
      for (const mesh of meshes) mesh.dispose(false, false);
      skeleton.dispose();
      root.dispose(false, false);
      build.disposeMaterials();
    },
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const DEFAULT_LAYER_MASK = 0x0fffffff;
const VELOCITY = new Float64Array(3);

interface FigureTextures {
  readonly albedo: RawTexture;
  readonly normal: RawTexture;
  readonly orm: RawTexture;
}

/** Below this the chain stops: a 8-texel level already holds the whole figure in a few colours. */
const MIN_MIP_SIZE = 8;

/** The maps on the GPU with their hand-built mip chains (`buildFigureMipChains`); flat neutral ones where none were decoded. */
function createFigureTextures(scene: Scene, maps: WalkerBodyMaps | null): FigureTextures {
  const source = maps ?? neutralMaps();
  const levels = Math.max(1, Math.log2(source.size / MIN_MIP_SIZE) + 1);
  const chains = buildFigureMipChains(source, levels);
  const upload = (name: string, chain: readonly Uint8Array[], srgb: boolean): RawTexture => {
    const texture = createRawTextureFromMipChain(scene, chain, source.size, source.size, { useSrgbBuffer: srgb });
    texture.name = name;
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    texture.anisotropicFilteringLevel = 4;
    return texture;
  };
  return {
    albedo: upload("person-albedo", chains.albedo, true),
    normal: upload("person-normal", chains.normal, false),
    orm: upload("person-orm", chains.orm, false),
  };
}

/** A small flat stand-in: mid skin-tone albedo, a flat normal, open occlusion, a matt finish. */
function neutralMaps(): WalkerBodyMaps {
  const size = MIN_MIP_SIZE;
  const fill = (r: number, g: number, b: number) => {
    const out = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i += 1) out.set([r, g, b, 255], i * 4);
    return out;
  };
  return { size, albedo: fill(150, 128, 110), normal: fill(128, 128, 255), orm: fill(255, 200, 0) };
}

function dress(material: PBRMaterial, atlas: FigureTextures): PBRMaterial {
  material.albedoTexture = atlas.albedo;
  material.bumpTexture = atlas.normal;
  material.invertNormalMapY = FIGURE_NORMAL_MAP_Y_DOWN;
  material.metallicTexture = atlas.orm;
  material.useAmbientOcclusionFromMetallicTextureRed = true;
  material.useRoughnessFromMetallicTextureAlpha = false;
  material.useRoughnessFromMetallicTextureGreen = true;
  material.useMetallnessFromMetallicTextureBlue = true;
  return material;
}

function skinnedMesh(
  scene: Scene,
  name: string,
  geometry: FigureGeometry,
  skeleton: Skeleton,
  material: PBRMaterial,
  parent: TransformNode | null,
  castsShadow: boolean,
): Mesh {
  const data = new VertexData();
  data.positions = geometry.positions;
  data.normals = geometry.normals;
  data.uvs = geometry.uvs;
  data.indices = geometry.indices;
  data.matricesIndices = geometry.matricesIndices;
  data.matricesWeights = geometry.matricesWeights;
  const mesh = new Mesh(name, scene);
  data.applyToMesh(mesh, false);
  mesh.numBoneInfluencers = 4;
  mesh.skeleton = skeleton;
  mesh.material = material;
  mesh.parent = parent;
  mesh.isPickable = false;
  mesh.receiveShadows = true;
  mesh.metadata = { personVisual: true, castsShadow };
  return mesh;
}

/** One triangle with every corner at the pelvis: the figure's vertex layout, rasterising nothing. */
function primeGeometry(): FigureGeometry {
  const positions = new Float32Array(9);
  const normals = new Float32Array(9);
  const matricesIndices = new Float32Array(12);
  const matricesWeights = new Float32Array(12);
  for (let corner = 0; corner < 3; corner += 1) {
    positions[corner * 3 + 1] = BIND_POSITIONS[BONE.pelvis * 3 + 1]!;
    normals[corner * 3] = 1;
    matricesIndices[corner * 4] = BONE.pelvis;
    matricesWeights[corner * 4] = 1;
  }
  return { positions, normals, uvs: new Float32Array(6), indices: Uint32Array.from([0, 1, 2]), matricesIndices, matricesWeights };
}

/** `out` = the vector (x, y, z) turned by the inverse of the unit quaternion `q`. */
function rotateByConjugate(q: Quaternion, x: number, y: number, z: number, out: Float64Array): void {
  const qx = -q.x;
  const qy = -q.y;
  const qz = -q.z;
  const qw = q.w;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
}

type CustomRenderList = (pass: number, list: Nullable<readonly AbstractMesh[]>, length: number) => Nullable<AbstractMesh[]>;

/**
 * How far the figure's casting faces move toward the light in the shadow
 * pass, metres, in place of the generator's `normalBias`. The renderer's sun
 * casts from back faces with a 0.035 m normal bias, which moves a back face
 * up to that far toward the light: right for terrain and hulls, but further
 * than the nose, lips, brow and eyelids are thick, so their far sides came
 * out in front of the lit cheek and striped it with shadow. The figure's
 * thinnest casters (the ears, the fingers) are thicker than this.
 */
export const FIGURE_SHADOW_NORMAL_BIAS = 0.005;

/**
 * The figure's hooks into the shadow generator that draws it, which it finds
 * by its meshes among the casters (the renderer adds them after the figure
 * is built, so it attaches on an update and leaves everything as it found it
 * on dispose):
 *
 * - its own normal bias (`FIGURE_SHADOW_NORMAL_BIAS`): the generator sets
 *   its uniforms for each draw and then announces the mesh and the effect,
 *   so the figure's draws set the bias again with the figure's value;
 * - out of the cascades past the tier's `personShadowCascades`: Babylon
 *   draws a caster into every cascade of the cascaded generator; its
 *   per-pass render-list hook (pass = cascade) answers the default list less
 *   the figure's meshes for the farther ones, and null (the default list)
 *   otherwise and whenever the figure is not drawn at all.
 */
class FigureShadows {
  private shadowMap: RenderTargetTexture | null = null;
  private previous: CustomRenderList | null = null;
  private readonly filtered: AbstractMesh[] = [];
  private generator: ShadowGenerator | null = null;
  private observers: Observer<unknown>[] = [];
  private drawingFigure = false;
  private searchedAt = -Infinity;
  private updates = 0;

  constructor(
    private readonly scene: Scene,
    private readonly figure: readonly AbstractMesh[],
    private readonly cascades: number,
    private readonly drawn: () => boolean,
  ) {}

  attach(): void {
    this.updates += 1;
    if (this.generator || this.updates - this.searchedAt < 60) return;
    this.searchedAt = this.updates;
    for (const light of this.scene.lights) {
      const generators = light.getShadowGenerators();
      if (!generators) continue;
      for (const generator of generators.values()) {
        const map = generator.getShadowMap();
        if (!map?.renderList?.includes(this.figure[0]!) || !("onBeforeShadowMapRenderObservable" in generator)) continue;
        this.generator = generator as ShadowGenerator;
        this.hookBias(this.generator);
        const total = (generator as { numCascades?: number }).numCascades ?? 1;
        if (Number.isFinite(this.cascades) && total > this.cascades) this.filterCascades(map);
        return;
      }
    }
  }

  private hookBias(generator: ShadowGenerator): void {
    const figure = this.figure;
    this.observers = [
      generator.onBeforeShadowMapRenderMeshObservable.add((mesh) => {
        this.drawingFigure = figure.includes(mesh);
      }),
      generator.onBeforeShadowMapRenderObservable.add((effect) => {
        if (this.drawingFigure) effect.setFloat3("biasAndScaleSM", generator.bias, FIGURE_SHADOW_NORMAL_BIAS, generator.depthScale);
      }),
      generator.onAfterShadowMapRenderMeshObservable.add(() => {
        this.drawingFigure = false;
      }),
    ] as Observer<unknown>[];
  }

  private filterCascades(map: RenderTargetTexture): void {
    this.shadowMap = map;
    this.previous = map.getCustomRenderList as CustomRenderList | null;
    const figure = this.figure;
    map.getCustomRenderList = (pass, list, length) => {
      const chained = this.previous ? this.previous(pass, list, length) : null;
      if (pass < this.cascades || !this.drawn()) return chained;
      const source = chained ?? list;
      if (!source) return null;
      const count = chained ? chained.length : length;
      const filtered = this.filtered;
      filtered.length = 0;
      for (let i = 0; i < count; i += 1) {
        const mesh = source[i]!;
        if (!figure.includes(mesh)) filtered.push(mesh);
      }
      return filtered;
    };
  }

  dispose(): void {
    if (this.shadowMap) this.shadowMap.getCustomRenderList = this.previous;
    const generator = this.generator;
    if (generator) {
      const [before, effect, after] = this.observers;
      generator.onBeforeShadowMapRenderMeshObservable.remove(before as Observer<AbstractMesh>);
      generator.onBeforeShadowMapRenderObservable.remove(effect as Observer<Effect>);
      generator.onAfterShadowMapRenderMeshObservable.remove(after as Observer<AbstractMesh>);
    }
    this.observers = [];
    this.generator = null;
    this.shadowMap = null;
    this.previous = null;
  }
}
