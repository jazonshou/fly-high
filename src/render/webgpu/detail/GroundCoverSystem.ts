import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Constants } from "@babylonjs/core/Engines/constants";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Material } from "@babylonjs/core/Materials/material";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { Scene } from "@babylonjs/core/scene";
import type { TerrainSample } from "@/src/world/types";
import { classifyLandCover } from "@/src/render/webgpu/terrain/LandCoverClassifier";
import {
  SURFACE_MATERIALS,
  SurfaceMaterial,
} from "@/src/render/webgpu/terrain/surfaceMaterials";
import { TERRAIN_REFERENCE_DAY_OF_YEAR } from "@/src/world";
import { GroundCoverMaterialPlugin } from "./GroundCoverMaterialPlugin";
import {
  GROUND_COVER_ATTRIBUTE_TILE_EDGE,
  GROUND_COVER_BLADE_STRIDE_BYTES,
  GROUND_COVER_HEIGHT_TILE_EDGE,
  GROUND_COVER_TILE_BAKE_MILLISECONDS_PER_FRAME,
  GROUND_COVER_TILE_SNAP_METERS,
  GROUND_COVER_TILE_SPAN_METERS,
  groundCoverBladeTriangles,
  groundCoverBladeVertices,
  groundCoverLaneCount,
  groundCoverLatticeEdge,
  type GroundCoverLaw,
} from "./groundCoverLaw";
import { GROUND_COVER_COMPUTE_WGSL } from "./groundCoverWgsl";
import { withoutDispatchTiming } from "../core/GpuTimingPolicy";

/**
 * Wave G — the living ground: per-frame compute-placed grass blades.
 *
 * Architecture (VEGETATION_OVERHAUL_PLAN.md §5): blade parameters are a pure
 * function of world position, regenerated every frame into fixed-capacity
 * STORAGE|VERTEX buffers (every lattice lane writes a blade or a degenerate
 * zero — no atomics, counters or indirect draws in v1), consumed as
 * instanced vertex attributes by a PBR material whose plugin evaluates the
 * Bézier ribbon. The data source is a camera-snapped CPU "domain tile":
 * rendered-surface height from the SAME consumer authority the camera clamp
 * reads, and the land-cover classifier's harmonised ground albedo + grass
 * weight — so blades stand on the surface the player sees and wear the
 * colour the terrain shows where they fade out.
 *
 * The whole system gates on camera height above ground: full below
 * `altitudeFadeLowMeters`, gone above `altitudeFadeHighMeters` — free in
 * almost all of the flight envelope.
 */

export interface GroundCoverSystemOptions {
  /** The consumer-authority sampler (eroded height where resident). */
  readonly terrainSample: (x: number, z: number) => TerrainSample;
}

export interface GroundCoverUpdateInput {
  readonly cameraWorldX: number;
  readonly cameraWorldY: number;
  readonly cameraWorldZ: number;
  readonly floatingOriginX: number;
  readonly floatingOriginZ: number;
  readonly law: GroundCoverLaw;
  readonly windDirectionX: number;
  readonly windDirectionZ: number;
  readonly windStrength01: number;
  readonly windGust01: number;
  readonly simulationTimeSeconds: number;
}

interface GroundCoverRingResources {
  readonly mesh: Mesh;
  readonly blades: StorageBuffer;
  readonly uniforms: UniformBuffer;
  readonly compute: ComputeShader;
  readonly laneCount: number;
  readonly latticeEdge: number;
}

const BLADE_BASE_HEIGHT_METERS = 0.42;
const BLADE_BASE_WIDTH_METERS = 0.016;

/** One reusable Plane[] target for the per-frame frustum extraction —
 * `GetPlanesToRef` writes into pre-existing planes, it does not allocate. */
const FRUSTUM_SCRATCH: Plane[] = Array.from(
  { length: 6 },
  () => new Plane(0, 1, 0, 0),
);

function buildBladeRibbon(segments: number): VertexData {
  const vertexCount = 2 * segments + 1;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  for (let row = 0; row < segments; row += 1) {
    const t = row / segments;
    for (let side = 0; side < 2; side += 1) {
      const vertex = row * 2 + side;
      positions[vertex * 3] = side === 0 ? -1 : 1;
      positions[vertex * 3 + 1] = t;
      normals[vertex * 3 + 2] = 1;
      uvs[vertex * 2] = side;
      uvs[vertex * 2 + 1] = t;
    }
  }
  const tip = segments * 2;
  positions[tip * 3] = 0;
  positions[tip * 3 + 1] = 1;
  normals[tip * 3 + 2] = 1;
  uvs[tip * 2] = 0.5;
  uvs[tip * 2 + 1] = 1;
  const indices: number[] = [];
  for (let row = 0; row < segments - 1; row += 1) {
    const a = row * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const last = (segments - 1) * 2;
  indices.push(last, last + 1, tip);
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.uvs = uvs;
  data.indices = indices;
  return data;
}

export class GroundCoverSystem {
  private readonly scene: Scene;
  private readonly options: GroundCoverSystemOptions;
  private readonly gpuActive: boolean;
  private readonly material: PBRMaterial | null = null;
  private readonly plugin: GroundCoverMaterialPlugin | null = null;
  private rings: GroundCoverRingResources[] = [];
  private law: GroundCoverLaw | null = null;
  private heightTexture: RawTexture | null = null;
  private attributeTexture: RawTexture | null = null;

  // Domain-tile double buffer. The FRONT arrays are what the GPU textures
  // hold; the BACK arrays bake amortised and swap only when complete, so the
  // compute never samples a half-updated tile.
  private readonly backHeights = new Float32Array(
    GROUND_COVER_HEIGHT_TILE_EDGE * GROUND_COVER_HEIGHT_TILE_EDGE,
  );
  private readonly backAttributes = new Uint8Array(
    GROUND_COVER_ATTRIBUTE_TILE_EDGE * GROUND_COVER_ATTRIBUTE_TILE_EDGE * 4,
  );
  private frontTileOriginX = 0;
  private frontTileOriginZ = 0;
  private frontTileReady = false;
  private backTileOriginX = 0;
  private backTileOriginZ = 0;
  private backTileRow = -1;
  private warmed = false;
  private disposed = false;
  private readonly planeScratch = new Float32Array(24);
  private lastGateScale = 0;

  constructor(scene: Scene, options: GroundCoverSystemOptions) {
    this.scene = scene;
    this.options = options;
    const caps = scene.getEngine().getCaps() as { supportComputeShaders?: boolean };
    this.gpuActive = caps.supportComputeShaders === true;
    if (!this.gpuActive) return;

    const material = new PBRMaterial("ground-cover-blades", scene);
    material.metallic = 0;
    material.roughness = 0.72;
    material.environmentIntensity = 1;
    material.directIntensity = 1.05;
    material.specularIntensity = 0.55;
    material.backFaceCulling = false;
    material.twoSidedLighting = true;
    material.transparencyMode = Material.MATERIAL_OPAQUE;
    this.plugin = new GroundCoverMaterialPlugin(material);
    this.material = material;

    this.heightTexture = RawTexture.CreateRTexture(
      null,
      GROUND_COVER_HEIGHT_TILE_EDGE,
      GROUND_COVER_HEIGHT_TILE_EDGE,
      scene,
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
      Constants.TEXTURETYPE_FLOAT,
    );
    this.heightTexture.name = "ground-cover-height-tile";
    this.heightTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.heightTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.attributeTexture = RawTexture.CreateRGBATexture(
      null,
      GROUND_COVER_ATTRIBUTE_TILE_EDGE,
      GROUND_COVER_ATTRIBUTE_TILE_EDGE,
      scene,
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    this.attributeTexture.name = "ground-cover-attribute-tile";
    this.attributeTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.attributeTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
  }

  /** The blade material joins the shared cloud-shadow/aerial registries. */
  addPbrMaterials(add: (material: PBRMaterial) => void): void {
    if (this.material) add(this.material);
  }

  /** Rows the amortised tile bake still owes — capture settle reads this. */
  get pendingTileRows(): number {
    if (!this.gpuActive || this.lastGateScale <= 0.02) return 0;
    if (this.backTileRow >= 0) {
      return GROUND_COVER_HEIGHT_TILE_EDGE - this.backTileRow;
    }
    return this.frontTileReady ? 0 : GROUND_COVER_HEIGHT_TILE_EDGE;
  }

  get statistics(): { activeBladeCapacity: number; gateScale: number } {
    return {
      activeBladeCapacity: this.rings.reduce((sum, ring) => sum + ring.laneCount, 0),
      gateScale: this.lastGateScale,
    };
  }

  private buildRings(law: GroundCoverLaw): void {
    this.releaseRings();
    const engine = this.scene.getEngine();
    const material = this.material;
    if (!material || !this.heightTexture || !this.attributeTexture) return;
    this.rings = law.rings.map((ring, index) => {
      const laneCount = groundCoverLaneCount(ring);
      const latticeEdge = groundCoverLatticeEdge(ring);
      const blades = new StorageBuffer(
        engine as never,
        laneCount * GROUND_COVER_BLADE_STRIDE_BYTES,
        Constants.BUFFER_CREATIONFLAG_STORAGE
          | Constants.BUFFER_CREATIONFLAG_VERTEX
          | Constants.BUFFER_CREATIONFLAG_WRITE,
        `ground-cover-blades-${index}`,
      );
      const mesh = new Mesh(`ground-cover-ring-${index}`, this.scene);
      buildBladeRibbon(ring.segments).applyToMesh(mesh, false);
      mesh.material = material;
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.doNotSyncBoundingInfo = true;
      mesh.isPickable = false;
      mesh.receiveShadows = true;
      mesh.forcedInstanceCount = laneCount;
      const bound = ring.outerRadiusMeters + 4;
      mesh.setBoundingInfo(new BoundingInfo(
        new Vector3(-bound, -bound, -bound),
        new Vector3(bound, bound, bound),
      ));
      // bladeA carries plain floats; bladeB carries PACKED u32 fields and
      // must travel as uint32x4 — packed bit patterns routed through float
      // attributes hit NaN canonicalization in the vertex fetch (measured:
      // roots arrived intact, every packed lane arrived scrambled).
      mesh.setVerticesBuffer(
        new VertexBuffer(engine, blades.getBuffer(), "bladeA", {
          updatable: true,
          instanced: true,
          size: 4,
          offset: 0,
          stride: GROUND_COVER_BLADE_STRIDE_BYTES,
          useBytes: true,
          type: VertexBuffer.FLOAT,
        }),
        false,
      );
      mesh.setVerticesBuffer(
        new VertexBuffer(engine, blades.getBuffer(), "bladeB", {
          updatable: true,
          instanced: true,
          size: 4,
          offset: 16,
          stride: GROUND_COVER_BLADE_STRIDE_BYTES,
          useBytes: true,
          type: VertexBuffer.UNSIGNED_INT,
        }),
        false,
      );
      mesh.setEnabled(false);

      const uniforms = new UniformBuffer(engine, undefined, true, `ground-cover-uniforms-${index}`);
      uniforms.addUniform("lattice", 4);
      uniforms.addUniform("tile", 4);
      uniforms.addUniform("camera", 4);
      uniforms.addUniform("ring", 4);
      uniforms.addUniform("origin", 4);
      uniforms.addUniform("planes", 4, 6);
      uniforms.create();

      // Nothing consumes this dispatch's GPU timing, so it opts out of the
      // all-or-nothing measurement tax (GpuTimingPolicy).
      const compute = withoutDispatchTiming(new ComputeShader(
        `ground-cover-place-${index}`,
        engine as never,
        { computeSource: GROUND_COVER_COMPUTE_WGSL },
        {
          entryPoint: "placeGroundCover",
          bindingsMapping: {
            uniforms: { group: 0, binding: 0 },
            blades: { group: 0, binding: 1 },
            groundHeightTile: { group: 0, binding: 2 },
            groundAttributeTile: { group: 0, binding: 3 },
          },
        },
      ));
      compute.setUniformBuffer("uniforms", uniforms);
      compute.setStorageBuffer("blades", blades);
      compute.setTexture("groundHeightTile", this.heightTexture!, false);
      compute.setTexture("groundAttributeTile", this.attributeTexture!, false);
      return { mesh, blades, uniforms, compute, laneCount, latticeEdge };
    });
  }

  private releaseRings(): void {
    for (const ring of this.rings) {
      ring.mesh.dispose(false, false);
      ring.blades.dispose();
      ring.uniforms.dispose();
    }
    this.rings = [];
  }

  /** Advance the amortised tile bake within its CPU budget. */
  private advanceTileBake(desiredOriginX: number, desiredOriginZ: number): void {
    const heightEdge = GROUND_COVER_HEIGHT_TILE_EDGE;
    const attrEdge = GROUND_COVER_ATTRIBUTE_TILE_EDGE;
    const span = GROUND_COVER_TILE_SPAN_METERS;
    const needsRestart = this.backTileRow < 0
      && (!this.frontTileReady
        || desiredOriginX !== this.frontTileOriginX
        || desiredOriginZ !== this.frontTileOriginZ);
    if (needsRestart) {
      this.backTileOriginX = desiredOriginX;
      this.backTileOriginZ = desiredOriginZ;
      this.backTileRow = 0;
    }
    if (this.backTileRow < 0) return;
    const started = performance.now();
    const heightStep = span / heightEdge;
    while (
      this.backTileRow < heightEdge
      && performance.now() - started < GROUND_COVER_TILE_BAKE_MILLISECONDS_PER_FRAME
    ) {
      const row = this.backTileRow;
      const worldZ = this.backTileOriginZ + (row + 0.5) * heightStep;
      for (let column = 0; column < heightEdge; column += 1) {
        const worldX = this.backTileOriginX + (column + 0.5) * heightStep;
        this.backHeights[row * heightEdge + column] =
          this.options.terrainSample(worldX, worldZ).height;
      }
      // Attribute rows bake in lockstep at their coarser cadence.
      const rowsPerAttributeRow = heightEdge / attrEdge;
      if (row % rowsPerAttributeRow === 0) {
        this.bakeAttributeRow(Math.floor(row / rowsPerAttributeRow));
      }
      this.backTileRow += 1;
    }
    if (this.backTileRow >= heightEdge) {
      this.backTileRow = -1;
      this.frontTileOriginX = this.backTileOriginX;
      this.frontTileOriginZ = this.backTileOriginZ;
      this.frontTileReady = true;
      this.heightTexture?.update(this.backHeights);
      this.attributeTexture?.update(this.backAttributes);
    }
  }

  private bakeAttributeRow(attrRow: number): void {
    const attrEdge = GROUND_COVER_ATTRIBUTE_TILE_EDGE;
    const span = GROUND_COVER_TILE_SPAN_METERS;
    const step = span / attrEdge;
    const worldZ = this.backTileOriginZ + (attrRow + 0.5) * step;
    for (let column = 0; column < attrEdge; column += 1) {
      const worldX = this.backTileOriginX + (column + 0.5) * step;
      const sample = this.options.terrainSample(worldX, worldZ);
      const at = (attrRow * attrEdge + column) * 4;
      // No blades on runways or in/near water (biome 0 = WATER, 1 = BEACH).
      if (sample.isRunway || sample.biome === 0 || sample.biome === 1) {
        this.backAttributes[at] = 0;
        this.backAttributes[at + 1] = 0;
        this.backAttributes[at + 2] = 0;
        this.backAttributes[at + 3] = 0;
        continue;
      }
      const normalY = sample.normal.y;
      const horizontal = Math.hypot(sample.normal.x, sample.normal.z);
      const weights = classifyLandCover({
        elevationMeters: sample.height,
        slope: sample.slope,
        moisture: sample.moisture,
        temperature: sample.temperature,
        aspect: horizontal > 1e-6 ? (-sample.normal.z / horizontal) * (1 - normalY) : 0,
        airportInfluence: sample.airportInfluence,
        dayOfYear: TERRAIN_REFERENCE_DAY_OF_YEAR,
        seasonalTemperatureShift: 0,
      });
      let albedoR = 0;
      let albedoG = 0;
      let albedoB = 0;
      let grassWeight = 0;
      let weightTotal = 0;
      for (let index = 0; index < weights.ids.length; index += 1) {
        const id = weights.ids[index]!;
        const weight = weights.weights[index]!;
        const reference = SURFACE_MATERIALS[id]!.referenceAlbedo;
        albedoR += reference[0] * weight;
        albedoG += reference[1] * weight;
        albedoB += reference[2] * weight;
        weightTotal += weight;
        if (id === SurfaceMaterial.Grass || id === SurfaceMaterial.DryGrass) {
          grassWeight += weight;
        }
      }
      const normalize = weightTotal > 1e-6 ? 1 / weightTotal : 0;
      // Airfield platform stays mown grass, but thin toward hard clearances.
      const clearance = 1 - Math.max(0, Math.min(1, sample.airportInfluence)) * 0.35;
      this.backAttributes[at] = Math.round(
        Math.min(1, albedoR * normalize) * 255,
      );
      this.backAttributes[at + 1] = Math.round(Math.min(1, albedoG * normalize) * 255);
      this.backAttributes[at + 2] = Math.round(Math.min(1, albedoB * normalize) * 255);
      this.backAttributes[at + 3] = Math.round(
        Math.min(1, Math.max(0, grassWeight * 1.35 * clearance)) * 255,
      );
    }
  }

  update(input: GroundCoverUpdateInput): void {
    if (!this.gpuActive || this.disposed) return;
    if (this.law !== input.law) {
      this.law = input.law;
      this.buildRings(input.law);
    }
    const groundHeight = this.options.terrainSample(
      input.cameraWorldX,
      input.cameraWorldZ,
    ).height;
    const heightAboveGround = input.cameraWorldY - groundHeight;
    const fadeSpan = Math.max(
      input.law.altitudeFadeHighMeters - input.law.altitudeFadeLowMeters,
      1,
    );
    const gate = 1 - Math.min(1, Math.max(
      0,
      (heightAboveGround - input.law.altitudeFadeLowMeters) / fadeSpan,
    ));
    this.lastGateScale = gate;
    if (gate <= 0.02) {
      for (const ring of this.rings) ring.mesh.setEnabled(false);
      return;
    }

    const snap = GROUND_COVER_TILE_SNAP_METERS;
    const desiredOriginX =
      Math.round((input.cameraWorldX - GROUND_COVER_TILE_SPAN_METERS / 2) / snap) * snap;
    const desiredOriginZ =
      Math.round((input.cameraWorldZ - GROUND_COVER_TILE_SPAN_METERS / 2) / snap) * snap;
    this.advanceTileBake(desiredOriginX, desiredOriginZ);
    if (!this.frontTileReady) {
      for (const ring of this.rings) ring.mesh.setEnabled(false);
      return;
    }

    this.plugin?.setWind(
      input.windDirectionX,
      input.windDirectionZ,
      input.windStrength01,
      input.windGust01,
    );
    this.plugin?.setWindTime(input.simulationTimeSeconds);
    this.plugin?.setCameraLocal(
      input.cameraWorldX - input.floatingOriginX,
      input.cameraWorldY,
      input.cameraWorldZ - input.floatingOriginZ,
    );

    // World-space frustum planes: Babylon's planes live in the origin-local
    // scene frame, so shift each plane's distance by the floating origin.
    Frustum.GetPlanesToRef(this.scene.getTransformMatrix(), FRUSTUM_SCRATCH);
    const gateHeightScale = 0.55 + 0.45 * gate;
    let innerRadius = 0;
    for (let ringIndex = 0; ringIndex < this.rings.length; ringIndex += 1) {
      const ring = this.rings[ringIndex]!;
      const law = input.law.rings[ringIndex]!;
      const outerRadius = law.outerRadiusMeters * (0.35 + 0.65 * gate);
      const spacing = law.spacingMeters;
      const latticeOriginX =
        Math.floor((input.cameraWorldX - law.outerRadiusMeters) / spacing) * spacing;
      const latticeOriginZ =
        Math.floor((input.cameraWorldZ - law.outerRadiusMeters) / spacing) * spacing;
      const uniforms = ring.uniforms;
      uniforms.updateFloat4("lattice", latticeOriginX, latticeOriginZ, spacing, ring.latticeEdge);
      uniforms.updateFloat4(
        "tile",
        this.frontTileOriginX,
        this.frontTileOriginZ,
        1 / GROUND_COVER_TILE_SPAN_METERS,
        GROUND_COVER_TILE_SPAN_METERS / GROUND_COVER_HEIGHT_TILE_EDGE,
      );
      uniforms.updateFloat4(
        "camera",
        input.cameraWorldX,
        input.cameraWorldY,
        input.cameraWorldZ,
        gate,
      );
      uniforms.updateFloat4("ring", innerRadius, outerRadius, law.widthScale, 0);
      uniforms.updateFloat4(
        "origin",
        input.floatingOriginX,
        input.floatingOriginZ,
        BLADE_BASE_HEIGHT_METERS * gateHeightScale,
        BLADE_BASE_WIDTH_METERS,
      );
      for (let plane = 0; plane < 6; plane += 1) {
        const source = FRUSTUM_SCRATCH[plane]!;
        this.planeScratch[plane * 4] = source.normal.x;
        this.planeScratch[plane * 4 + 1] = source.normal.y;
        this.planeScratch[plane * 4 + 2] = source.normal.z;
        this.planeScratch[plane * 4 + 3] = source.d
          - source.normal.x * input.floatingOriginX
          - source.normal.z * input.floatingOriginZ;
      }
      uniforms.updateFloatArray("planes", this.planeScratch);
      uniforms.update();

      if (!this.warmed) {
        this.warmed = true;
        // Compile the pipeline off the critical path; real dispatches begin
        // once isReady reports true.
        void ring.compute.dispatchWhenReady(1, 1, 1).catch(() => undefined);
      }
      if (ring.compute.isReady()) {
        ring.compute.dispatch(Math.ceil(ring.laneCount / 64), 1, 1);
        ring.mesh.setEnabled(true);
      } else {
        ring.mesh.setEnabled(false);
      }
      innerRadius = outerRadius;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseRings();
    this.heightTexture?.dispose();
    this.attributeTexture?.dispose();
    this.material?.dispose(true, true);
  }
}

/** Triangle load the law's live blades submit at worst case (budget test). */
export function estimateGroundCoverTriangles(law: GroundCoverLaw): number {
  return law.rings.reduce(
    (sum, ring) => sum + groundCoverLaneCount(ring) * groundCoverBladeTriangles(ring),
    0,
  );
}

/** Vertex invocations per frame at worst case (the honest v1 cost model). */
export function estimateGroundCoverVertices(law: GroundCoverLaw): number {
  return law.rings.reduce(
    (sum, ring) => sum + groundCoverLaneCount(ring) * groundCoverBladeVertices(ring),
    0,
  );
}
