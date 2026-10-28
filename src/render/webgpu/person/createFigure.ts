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
import type { Nullable } from "@babylonjs/core/types";
import type { Scene } from "@babylonjs/core/scene";
import type { PipelineWarmUp } from "../core/AsyncPipelineCompiles";
import type { WebGpuQualityProfile } from "../core/QualityProfile";
import { AircraftBuildContext } from "../aircraft/builders";
import { createFigureAtlasTextures } from "./figureAtlas";
import { buildFigureGeometry, FIGURE_LODS, type FigureGeometry } from "./figureGeometry";
import type { GroundOffset } from "./footPlant";
import { PersonMotion, type MotionInput } from "./motion";
import { BIND_POSITIONS, BONE, BONE_COUNT, BONE_NAMES } from "./skeleton";
import type { PersonAnimationInput, PersonAnimationOutput, PersonVisual } from "./types";

/** The part of `AsyncPipelineCompiles` the figure uses. */
export interface FigurePipelineCompiles extends PipelineWarmUp {
  defer(material: object): void;
}

export interface FigureOptions {
  /** The tier's figure fields; absent, the finest mesh and every cascade. */
  readonly profile?: Pick<WebGpuQualityProfile, "personFigureFinestLod" | "personShadowCascades">;
  readonly pipelineCompiles?: FigurePipelineCompiles | null;
}

/**
 * The camera distances, metres, past which the figure draws its next coarser
 * mesh (the build brief: 9k triangles within 25 m, 3k to 80 m, 0.8k beyond),
 * and the band either side of each it must cross before it switches back, so
 * a camera at the edge does not flicker between two meshes.
 */
export const FIGURE_LOD_DISTANCES = Object.freeze([25, 80]);
const LOD_HYSTERESIS = 1.5;
/** How far the skin stands off the bones' origins at most (the crown over the head bone, the hips' sides), metres. */
const BOUNDS_MARGIN = 0.22;
/** A camera layer mask no camera has: the solid figure still casts while its faded twin is drawn. */
const SHADOW_ONLY_LAYER_MASK = 0;

/**
 * The walker's figure: the skinned mesh of `figureGeometry.ts` on a flat
 * skeleton of `BONE_COUNT` bones, posed every frame by `PersonMotion`.
 *
 * SKINNING. Every bone is parentless and bound at its bind position with no
 * turn, so a bone's matrix is simply its posed transform in the root frame
 * (`FigurePose.globalMatrices`) and Babylon's skin matrix (inverse bind times
 * final) moves a bind-pose vertex to where the pose puts it. The skeleton's
 * matrices go up once a frame, in `update`, so the shadow passes read this
 * frame's pose even when the figure itself is off screen.
 *
 * DRAWS. One mesh per level of detail, of which one draws, in one material,
 * plus its shadow in the nearest `personShadowCascades` cascades: Babylon
 * draws a caster in every cascade, so where the tier asks for fewer the
 * figure takes itself out of the farther ones' lists (`CascadeFilter`).
 *
 * FADE. A camera pushed inside the walker's personal space fades it. The
 * solid mesh keeps casting, hidden from the cameras, while a twin sharing its
 * geometry draws blended over a depth pre-pass, so only the nearest skin
 * shows and the shadow does not blink out with the figure.
 *
 * PIPELINES. Both materials are deferred with the renderer's off-frame
 * compiles and warmed at load by two primes: one degenerate triangle each in
 * the figure's vertex layout, skeleton and material (the solid one casting,
 * as the figure does), drawn wherever they are until the compiles report
 * them built and then disabled. They rasterise nothing. A capture's
 * synchronous compiles decline the warm-up and the primes never draw; with no
 * off-frame compiles they draw one frame, compiling at load.
 */
export function createFigure(scene: Scene, options: FigureOptions = {}): PersonVisual {
  const finestLod = options.profile?.personFigureFinestLod ?? 0;
  const castCascades = options.profile?.personShadowCascades ?? Number.POSITIVE_INFINITY;
  const compiles = options.pipelineCompiles ?? null;
  const build = new AircraftBuildContext(scene);

  const root = new TransformNode("person-root", scene);
  root.rotationQuaternion = Quaternion.Identity();
  root.metadata = { personVisual: true, bodyAxes: { forward: "+x", up: "+y", right: "+z" } };

  const skeleton = new Skeleton("person-skeleton", "person-skeleton", scene);
  const bones: Bone[] = [];
  for (let bone = 0; bone < BONE_COUNT; bone += 1) {
    const bind = Matrix.Translation(BIND_POSITIONS[bone * 3]!, BIND_POSITIONS[bone * 3 + 1]!, BIND_POSITIONS[bone * 3 + 2]!);
    bones.push(new Bone(BONE_NAMES[bone]!, skeleton, null, bind, null, bind, bone));
  }

  const atlas = createFigureAtlasTextures(scene);
  build.textures.push(atlas.albedo, atlas.metallicRoughness);
  const solid = dress(build.material("person-figure", 0xffffff, { roughness: 1, metallic: 1 }), atlas);
  const faded = dress(build.material("person-figure-fade", 0xffffff, { roughness: 1, metallic: 1, alpha: 1 }), atlas);
  // Blended over its own depth pre-pass whatever the alpha, so its pipeline is the one warmed.
  faded.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  faded.needDepthPrePass = true;
  faded.backFaceCulling = true;
  compiles?.defer(solid);
  compiles?.defer(faded);

  const lods: (Mesh | null)[] = [];
  for (let level = 0; level < FIGURE_LODS.length; level += 1) {
    lods.push(level < finestLod ? null : skinnedMesh(scene, `person-figure-lod${level}`, buildFigureGeometry(FIGURE_LODS[level]!), skeleton, solid, root, true));
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
    { mesh: solidPrime, castsShadows: true, done: false },
    { mesh: fadePrime, castsShadows: false, done: false },
  ];
  let primeFrames = 0;
  let primeObserver: Nullable<Observer<Scene>> = scene.onBeforeRenderObservable.add(() => {
    let pending = false;
    for (const prime of primes) {
      if (prime.done) continue;
      const status = compiles ? compiles.warmUp(prime.mesh, prime.castsShadows) : primeFrames > 0 ? "warm" : "started";
      if (status === "warm" || status === "declined") {
        prime.done = true;
        prime.mesh.setEnabled(false);
      } else {
        pending = true;
      }
    }
    primeFrames += 1;
    if (!pending) {
      scene.onBeforeRenderObservable.remove(primeObserver);
      primeObserver = null;
    }
  });

  const cascadeFilter = new CascadeFilter(scene, figureMeshes, castCascades, () => root.isEnabled());
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
      cascadeFilter.attach();
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
      cascadeFilter.dispose();
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

function dress(material: PBRMaterial, atlas: ReturnType<typeof createFigureAtlasTextures>): PBRMaterial {
  material.albedoTexture = atlas.albedo;
  material.metallicTexture = atlas.metallicRoughness;
  material.useAmbientOcclusionFromMetallicTextureRed = false;
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
 * Keeps the figure out of the shadow cascades past the tier's
 * `personShadowCascades`. Babylon draws a caster into every cascade of the
 * cascaded generator; its per-pass render-list hook (pass = cascade) answers
 * the default list less the figure's meshes for the farther ones, and null
 * (the default list) otherwise and whenever the figure is not drawn at all.
 * It finds the generator by the figure's meshes in its casters, which the
 * renderer adds after the figure is built, so it attaches on the first
 * update and leaves the hook as it found it on dispose.
 */
class CascadeFilter {
  private shadowMap: RenderTargetTexture | null = null;
  private previous: CustomRenderList | null = null;
  private readonly filtered: AbstractMesh[] = [];
  /** Found the figure's generator (and filtered it if it has more cascades than the tier's). */
  private resolved = false;
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
    if (this.resolved || !Number.isFinite(this.cascades) || this.updates - this.searchedAt < 60) return;
    this.searchedAt = this.updates;
    for (const light of this.scene.lights) {
      const generators = light.getShadowGenerators();
      if (!generators) continue;
      for (const generator of generators.values()) {
        const map = generator.getShadowMap();
        if (!map?.renderList?.includes(this.figure[0]!)) continue;
        this.resolved = true;
        const total = (generator as { numCascades?: number }).numCascades ?? 1;
        if (total > this.cascades) this.install(map);
        return;
      }
    }
  }

  private install(map: RenderTargetTexture): void {
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
    this.shadowMap = null;
    this.previous = null;
  }
}
