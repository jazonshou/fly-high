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
import { WebGPUDrawContext } from "@babylonjs/core/Engines/WebGPU/webgpuDrawContext";
import type { DataBuffer } from "@babylonjs/core/Buffers/dataBuffer";
import type { Scene } from "@babylonjs/core/scene";
import type { TerrainSample } from "@/src/world/types";
import { TerrainBiome } from "@/src/world";
import { classifyLandCover } from "@/src/render/webgpu/terrain/LandCoverClassifier";
import {
  SURFACE_MATERIALS,
  SurfaceMaterial,
} from "@/src/render/webgpu/terrain/surfaceMaterials";
import { consumeGpuDispatchCostMs } from "@/src/render/webgpu/terrain/TerrainPageAtlas";
import { TERRAIN_REFERENCE_DAY_OF_YEAR } from "@/src/world";
import type { ComputeBudget } from "@/src/render/webgpu/core/ComputeBudget";
import { GroundCoverMaterialPlugin } from "./GroundCoverMaterialPlugin";
import { densityField } from "./densityField";
import {
  GROUND_COVER_ATTRIBUTE_TILE_EDGE,
  GROUND_COVER_BLADE_STRIDE_BYTES,
  GROUND_COVER_COUNTER_RING,
  GROUND_COVER_COUNTER_SLOTS,
  GROUND_COVER_HEIGHT_TILE_EDGE,
  GROUND_COVER_TILE_BAKE_MILLISECONDS_PER_FRAME,
  GROUND_COVER_TILE_SNAP_METERS,
  GROUND_COVER_TILE_SPAN_METERS,
  groundCoverBladeTriangles,
  groundCoverBladeVertices,
  groundCoverCounterBytes,
  groundCoverDrawCount,
  groundCoverLaneCount,
  groundCoverLatticeEdge,
  type GroundCoverLaw,
} from "./groundCoverLaw";
import { GROUND_COVER_COMPUTE_WGSL } from "./groundCoverWgsl";
import {
  assertIndirectInstanceCountSupported,
  createIndirectPublishShader,
  mainPassIndirectBuffer,
  mainRenderPassId,
  probeIndirectInstanceCountSupport,
  type IndirectDrawProbe,
} from "./indirectDrawCapability";
import {
  registerGpuBufferBytes,
  releaseGpuBufferBytes,
} from "@/src/render/webgpu/core/GpuBufferInventory";

/**
 * Wave G — the living ground: per-frame compute-placed ground cover.
 *
 * Architecture (VEGETATION_OVERHAUL_PLAN.md §5): cover parameters are a pure
 * function of world position, regenerated every frame into fixed-capacity
 * STORAGE|VERTEX buffers, consumed as instanced vertex attributes by a PBR
 * material whose plugin evaluates the Bézier ribbon. The data source is a
 * camera-snapped CPU "domain tile": rendered-surface height from the SAME
 * consumer authority the camera clamp reads, and the land-cover classifier's
 * harmonised ground albedo + grass weight — so cover stands on the surface
 * the player sees and wears the colour the terrain shows where it fades out.
 *
 * The whole system gates on camera height above ground: full below
 * `altitudeFadeLowMeters`, gone above `altitudeFadeHighMeters` — free in
 * almost all of the flight envelope.
 *
 * **`6-9` generalised it and paid wave G's two debts.**
 *
 * - *Generalised:* the field is no longer grass-only. A DRIVER tile carries
 *   moisture, canopy shade, the riparian band and the card path's own
 *   ground-cover coverage, and the placement kernel evaluates the SHIPPED
 *   archetype law (`VEGETATION_GROUND_COVER_LAW_WGSL`, the same text the
 *   splat bake composes) to place ferns, heather and reeds as well as grass.
 *   The card path retires those three archetypes inside
 *   `groundCoverHandoffRadiusMeters` and keeps them outside it, so the two
 *   representations partition the ground instead of overlapping.
 * - *Debt 1 — the meter:* the dispatches are admitted through
 *   `ComputeBudget` as `groundCoverCompute` and their measured cost feeds
 *   `observeDispatchCostMs`, which is why they are no longer wrapped in
 *   `withoutDispatchTiming`. A deferred ring simply keeps last frame's
 *   records, which is the property that makes this client safe to put last.
 * - *Debt 2 — the governor:* `groundCoverGateScale` (GPU ladder, after
 *   `vegetationDistanceScale`) multiplies the altitude gate. It moves radii
 *   and per-lane survival without touching lattice sizes, so no GPU buffer is
 *   reallocated when the lever steps.
 *
 * **The cull (§7 R4).** Lanes compact through a workgroup-reduced atomic and
 * the draw takes a conservative count from a readback ring. The readback is
 * the DEFAULT path; the GPU-written indirect count is an opt-in optimisation
 * behind a loud capability assertion over Babylon private state, and it
 * targets the MAIN pass only because `indirectDrawBuffer` is per-DrawWrapper
 * and per-render-pass-id. The blade meshes are registered with no shadow or
 * reflection pass at all, which is what makes one count safe for every pass
 * this mesh appears in.
 */

export interface GroundCoverSystemOptions {
  /** The consumer-authority sampler (eroded height where resident). */
  readonly terrainSample: (x: number, z: number) => TerrainSample;
  /**
   * `6-9`: the shared amortised-compute meter. Optional so the NullEngine
   * fixtures and the CPU-only path construct without one; when it is absent
   * every ring dispatches, which is wave G's un-metered behaviour and is
   * reachable only where there is no compute support to meter.
   */
  readonly computeBudget?: ComputeBudget | null;
  /** `6-9`: world seed for the density field the driver tile bakes. */
  readonly seedHash?: number;
  readonly seaLevelMeters?: number;
  /**
   * `6-9` / §7 R4: opt in to the GPU-written indirect instance count. OFF by
   * default — the CPU-readback count is the shipped path — and asserts
   * loudly at construction when the Babylon private surface has moved.
   */
  readonly indirectInstanceCount?: boolean;
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
  /**
   * `6-9`/`P-5`: the governor's ground-cover rung, 1 at full quality. It
   * multiplies the altitude gate, so it shrinks radii and per-lane survival
   * and leaves every buffer size untouched.
   */
  readonly gateScale?: number;
}

interface GroundCoverRingResources {
  readonly mesh: Mesh;
  readonly blades: StorageBuffer;
  readonly uniforms: UniformBuffer;
  readonly compute: ComputeShader;
  readonly laneCount: number;
  readonly latticeEdge: number;
  readonly indexCount: number;
  /** `6-9`: the conservative instance count this ring is drawing. */
  drawCount: number;
  /** Live count from the newest landed readback; null until one lands. */
  liveCount: number | null;
  /** The optional indirect publish pass and its parameters. */
  publish: ComputeShader | null;
  publishParams: UniformBuffer | null;
  /**
   * The render-pass id whose indirect record this ring's publish pass is
   * bound to, or null when it is not bound. Tracked rather than a boolean
   * because the pass id belongs to the ACTIVE CAMERA: swap the camera (or
   * attach an output render target) and the old binding writes a buffer
   * nothing draws from, which is silent.
   */
  indirectPassId: number | null;
}

const BLADE_BASE_HEIGHT_METERS = 0.42;
const BLADE_BASE_WIDTH_METERS = 0.016;

/** One reusable Plane[] target for the per-frame frustum extraction —
 * `GetPlanesToRef` writes into pre-existing planes, it does not allocate. */
const FRUSTUM_SCRATCH: Plane[] = Array.from(
  { length: 6 },
  () => new Plane(0, 1, 0, 0),
);

/**
 * The blade ribbon, EXPORTED so the winding guard can measure it.
 *
 * `ed5b703` emptied `KNOWN_INVERTED` and reported "six emission sites
 * corrected", one of them "grass". That was `buildGrassPatchPrototype` -- the
 * CARD path, which `presentationBuild` retires GLOBALLY for the grass
 * archetype the moment this compute field is live. So the grass the guard
 * measured is grass no capture draws, and the grass every capture DOES draw
 * was in no test at all: the guard imports only `prototypeGeometry`, and this
 * function was module-private.
 */
export function buildBladeRibbon(segments: number): VertexData {
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
  // Winding: emitted REVERSED, so `cross(b-a, c-a)` opposes the authored +Z
  // normal the way Babylon's own primitives do (measured agreement -1.000).
  // The natural order below reads +1.000 -- the blade was inside-out, so
  // `twoSidedLighting` negated the normal on exactly the fragments facing the
  // viewer and the field took no direct sun. Only the INDEX order moves; the
  // normals above are an independent statement of facing and must not be
  // re-derived from the reversed order, which would flip them back and leave
  // the ribbon self-consistently wrong again.
  const indices: number[] = [];
  for (let row = 0; row < segments - 1; row += 1) {
    const a = row * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const last = (segments - 1) * 2;
  indices.push(last, tip, last + 1);
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
  private driverTexture: RawTexture | null = null;

  // Domain-tile double buffer. The FRONT arrays are what the GPU textures
  // hold; the BACK arrays bake amortised and swap only when complete, so the
  // compute never samples a half-updated tile.
  private readonly backHeights = new Float32Array(
    GROUND_COVER_HEIGHT_TILE_EDGE * GROUND_COVER_HEIGHT_TILE_EDGE,
  );
  private readonly backAttributes = new Uint8Array(
    GROUND_COVER_ATTRIBUTE_TILE_EDGE * GROUND_COVER_ATTRIBUTE_TILE_EDGE * 4,
  );
  private readonly backDrivers = new Uint8Array(
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

  // `6-9` cull state.
  private counters: StorageBuffer | null = null;
  private counterFrame = 0;
  private readbacksInFlight = 0;
  private readonly counterZeros = new Uint32Array(GROUND_COVER_COUNTER_SLOTS);
  private lastDispatchedCostSamples = 0;
  private readonly indirectProbe: IndirectDrawProbe;
  private readonly indirectRequested: boolean;
  /**
   * The floating origin the resident records were written against.
   *
   * **Compaction introduced a stale tail, and the floating origin is the one
   * thing that makes a stale record WRONG rather than merely old.** Wave G
   * wrote every lane every frame, so nothing in the buffer was ever older
   * than the current frame. Now the slots past the live count hold earlier
   * frames' survivors — real blades on real ground, which is exactly why a
   * conservative draw count is safe — except across a rebase, because a
   * record's root is stored ORIGIN-LOCAL (f32 cannot hold a world position
   * at ±262 km). A rebased frame would draw that tail displaced by the whole
   * rebase delta. So a rebase zeroes the lattice buffers: cleared records are
   * degenerate, the dispatching rings refill their survivors in the same
   * encoder, and a ring the meter deferred that frame draws nothing rather
   * than drawing a field 2 km away.
   */
  private residentOriginX = Number.NaN;
  private residentOriginZ = Number.NaN;

  constructor(scene: Scene, options: GroundCoverSystemOptions) {
    this.scene = scene;
    this.options = options;
    this.indirectRequested = options.indirectInstanceCount === true;
    this.indirectProbe = probeIndirectInstanceCountSupport(WebGPUDrawContext?.prototype ?? null);
    // §7 R4's loud startup assertion: asking for the optimisation and finding
    // the private surface gone is a hard failure, not a quiet fallback. Not
    // asking for it is the default and never throws.
    if (this.indirectRequested) assertIndirectInstanceCountSupported(this.indirectProbe);
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
    this.attributeTexture = this.createAttributeTexture("ground-cover-attribute-tile");
    this.driverTexture = this.createAttributeTexture("ground-cover-driver-tile");
  }

  private createAttributeTexture(name: string): RawTexture {
    const texture = RawTexture.CreateRGBATexture(
      null,
      GROUND_COVER_ATTRIBUTE_TILE_EDGE,
      GROUND_COVER_ATTRIBUTE_TILE_EDGE,
      this.scene,
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    texture.name = name;
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    return texture;
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

  get statistics(): {
    activeBladeCapacity: number;
    gateScale: number;
    drawnInstances: number;
    culledInstances: number;
    indirectInstanceCount: boolean;
    /**
     * Rings whose MAIN-pass indirect record the publish pass is writing.
     *
     * Babylon creates a draw wrapper lazily, on a pass's first render, so a
     * ring binds one frame after it first draws — which is exactly the window
     * in which the readback count is still carrying the draw. Reported rather
     * than assumed so "indirect is on" and "indirect is actually driving this
     * ring" cannot be confused for each other.
     */
    indirectBoundRings: number;
  } {
    const capacity = this.rings.reduce((sum, ring) => sum + ring.laneCount, 0);
    const drawn = this.rings.reduce((sum, ring) => sum + ring.drawCount, 0);
    return {
      activeBladeCapacity: capacity,
      gateScale: this.lastGateScale,
      drawnInstances: drawn,
      culledInstances: Math.max(0, capacity - drawn),
      indirectInstanceCount: this.indirectRequested && this.indirectProbe.supported,
      indirectBoundRings: this.rings.reduce(
        (count, ring) => count + (ring.indirectPassId !== null ? 1 : 0),
        0,
      ),
    };
  }

  private buildRings(law: GroundCoverLaw): void {
    this.releaseRings();
    const engine = this.scene.getEngine();
    const material = this.material;
    if (!material || !this.heightTexture || !this.attributeTexture || !this.driverTexture) return;
    if (!this.counters) {
      // Gate 0-c: storage buffers are invisible to the texture/geometry
      // inventory. Report every byte, counter ring included.
      registerGpuBufferBytes(groundCoverCounterBytes());
      this.counters = new StorageBuffer(
        engine as never,
        groundCoverCounterBytes(),
        Constants.BUFFER_CREATIONFLAG_STORAGE
          | Constants.BUFFER_CREATIONFLAG_READWRITE,
        "ground-cover-counters",
      );
    }
    const counters = this.counters;
    this.rings = law.rings.map((ring, index) => {
      const laneCount = groundCoverLaneCount(ring);
      const latticeEdge = groundCoverLatticeEdge(ring);
      registerGpuBufferBytes(laneCount * GROUND_COVER_BLADE_STRIDE_BYTES);
      const blades = new StorageBuffer(
        engine as never,
        laneCount * GROUND_COVER_BLADE_STRIDE_BYTES,
        Constants.BUFFER_CREATIONFLAG_STORAGE
          | Constants.BUFFER_CREATIONFLAG_VERTEX
          | Constants.BUFFER_CREATIONFLAG_WRITE,
        `ground-cover-blades-${index}`,
      );
      const mesh = new Mesh(`ground-cover-ring-${index}`, this.scene);
      const ribbon = buildBladeRibbon(ring.segments);
      ribbon.applyToMesh(mesh, false);
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
      uniforms.addUniform("cover", 4);
      uniforms.addUniform("planes", 4, 6);
      uniforms.create();

      // `6-9`: NOT wrapped in withoutDispatchTiming any more. The counter has
      // a consumer — `ComputeBudget.observeDispatchCostMs("groundCoverCompute")`
      // through `observeDispatchCosts()` below — and the timing policy's
      // TIMED_ON_PURPOSE list names it.
      const compute = new ComputeShader(
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
            groundDriverTile: { group: 0, binding: 4 },
            groundCounters: { group: 0, binding: 5 },
          },
        },
      );
      compute.setUniformBuffer("uniforms", uniforms);
      compute.setStorageBuffer("blades", blades);
      compute.setTexture("groundHeightTile", this.heightTexture!, false);
      compute.setTexture("groundAttributeTile", this.attributeTexture!, false);
      compute.setTexture("groundDriverTile", this.driverTexture!, false);
      compute.setStorageBuffer("groundCounters", counters);

      let publish: ComputeShader | null = null;
      let publishParams: UniformBuffer | null = null;
      if (this.indirectRequested && this.indirectProbe.supported) {
        publishParams = new UniformBuffer(
          engine, undefined, true, `ground-cover-indirect-${index}`,
        );
        publishParams.addUniform("publish", 4);
        publishParams.create();
        publish = createIndirectPublishShader(
          engine,
          `ground-cover-indirect-${index}`,
          publishParams,
          counters,
        );
      }

      return {
        mesh,
        blades,
        uniforms,
        compute,
        laneCount,
        latticeEdge,
        indexCount: ribbon.indices?.length ?? 0,
        drawCount: laneCount,
        liveCount: null,
        publish,
        publishParams,
        indirectPassId: null,
      };
    });
  }

  private releaseRings(): void {
    for (const ring of this.rings) {
      ring.mesh.dispose(false, false);
      ring.blades.dispose();
      releaseGpuBufferBytes(ring.laneCount * GROUND_COVER_BLADE_STRIDE_BYTES);
      ring.uniforms.dispose();
      ring.publishParams?.dispose();
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
      this.driverTexture?.update(this.backDrivers);
    }
  }

  private bakeAttributeRow(attrRow: number): void {
    const attrEdge = GROUND_COVER_ATTRIBUTE_TILE_EDGE;
    const span = GROUND_COVER_TILE_SPAN_METERS;
    const step = span / attrEdge;
    const seaLevel = this.options.seaLevelMeters ?? 0;
    const seedHash = this.options.seedHash;
    const worldZ = this.backTileOriginZ + (attrRow + 0.5) * step;
    for (let column = 0; column < attrEdge; column += 1) {
      const worldX = this.backTileOriginX + (column + 0.5) * step;
      const sample = this.options.terrainSample(worldX, worldZ);
      const at = (attrRow * attrEdge + column) * 4;
      // No cover on runways or in/near water (biome 0 = WATER, 1 = BEACH).
      if (
        sample.isRunway
        || sample.biome === TerrainBiome.WATER
        || sample.biome === TerrainBiome.BEACH
      ) {
        this.backAttributes[at] = 0;
        this.backAttributes[at + 1] = 0;
        this.backAttributes[at + 2] = 0;
        this.backAttributes[at + 3] = 0;
        this.backDrivers[at] = 0;
        this.backDrivers[at + 1] = 0;
        this.backDrivers[at + 2] = 0;
        this.backDrivers[at + 3] = 0;
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
      // Unchanged from wave G, deliberately: this is the GRASS lane's density
      // and moving it would move shipped pixels for a reason 6-9 does not
      // have. The other three archetypes take the card path's coverage below.
      this.backAttributes[at + 3] = Math.round(
        Math.min(1, Math.max(0, grassWeight * 1.35 * clearance)) * 255,
      );
      this.bakeDriverTexel(at, worldX, worldZ, sample, seedHash, seaLevel);
    }
  }

  /**
   * `6-9`: the archetype drivers, from the vegetation density field itself.
   *
   * The field is the authority the card path already reads, so baking its
   * moisture/shade/bank here is what makes the blade field and the retiring
   * fern/heather/reed cards agree about WHICH plant grows where rather than
   * two systems reaching similar answers by different routes. The coverage
   * lane is `generation.ts`'s own ground-cover law, for the same reason: the
   * cards inside the handoff radius are being replaced, so their density has
   * to come with them.
   */
  private bakeDriverTexel(
    at: number,
    worldX: number,
    worldZ: number,
    sample: TerrainSample,
    seedHash: number | undefined,
    seaLevel: number,
  ): void {
    if (seedHash === undefined) {
      // No world seed (fixtures, or a host with no density field): the mix
      // then keys on moisture and slope alone, which is the open-grassland
      // answer and exactly what wave G shipped.
      this.backDrivers[at] = Math.round(Math.min(1, Math.max(0, sample.moisture)) * 255);
      this.backDrivers[at + 1] = 0;
      this.backDrivers[at + 2] = 0;
      this.backDrivers[at + 3] = 0;
      return;
    }
    const field = densityField(seedHash, {
      x: worldX,
      z: worldZ,
      heightMeters: sample.height,
      seaLevelMeters: seaLevel,
      slope: sample.slope,
      moisture: sample.moisture,
      normalX: sample.normal.x,
      normalZ: sample.normal.z,
      airportInfluence: sample.airportInfluence,
      dayOfYear: TERRAIN_REFERENCE_DAY_OF_YEAR,
      filterWidthMeters: 0,
    });
    // The shade term the archetype law takes, exactly as densityField.ts and
    // the WGSL mirror define it: stems relative to the base canopy density.
    const shade = Math.min(1, Math.max(0, field.treeStemsPerSquareMeter / 0.08));
    // `generation.ts`'s ground-cover coverage, with its own rocky/beach gate.
    const closure = Math.min(1, Math.max(0, field.treeStemsPerSquareMeter / 0.05));
    const rocky = sample.biome === TerrainBiome.ALPINE || sample.biome === TerrainBiome.SNOW;
    const coverage = rocky
      ? 0
      : Math.min(1, Math.max(0, 0.35 + sample.moisture * 0.5 + closure * 0.15))
        * (1 - 0.6 * Math.min(1, Math.max(0, sample.airportInfluence)));
    this.backDrivers[at] = Math.round(Math.min(1, Math.max(0, sample.moisture)) * 255);
    this.backDrivers[at + 1] = Math.round(shade * 255);
    this.backDrivers[at + 2] = Math.round(Math.min(1, Math.max(0, field.riparianBand)) * 255);
    this.backDrivers[at + 3] = Math.round(coverage * 255);
  }

  /**
   * Feed the meter what the placement dispatches actually cost.
   *
   * Sampled at the TOP of the update, before this frame's demand is declared,
   * because a timestamp readback lands one or more frames after the dispatch
   * it timed — the same ordering `TerrainClipmapSystem.observeDispatchCosts`
   * documents for the terrain clients.
   */
  private observeDispatchCosts(): void {
    const budget = this.options.computeBudget;
    const first = this.rings[0];
    if (!budget || !first) return;
    const observed = consumeGpuDispatchCostMs(
      first.compute as never,
      1,
      this.lastDispatchedCostSamples,
    );
    this.lastDispatchedCostSamples = observed.sampleCount;
    if (observed.milliseconds !== null) {
      budget.observeDispatchCostMs("groundCoverCompute", observed.milliseconds);
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
    const leverScale = Math.min(1, Math.max(0, input.gateScale ?? 1));
    const gate = (1 - Math.min(1, Math.max(
      0,
      (heightAboveGround - input.law.altitudeFadeLowMeters) / fadeSpan,
    ))) * leverScale;
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

    // `6-9` debt 1: declare the frame's demand, then read the answer once.
    //
    // This declaration is LATE — the renderer runs `terrain.update`, which
    // declares AND reads inside itself, before this update. That is safe
    // because the meter SETTLES a client when its admission is read: the
    // terrain clients' answers are frozen and their milliseconds charged, so
    // this demand competes for what is genuinely left rather than re-opening
    // a decision the renderer has already dispatched against.
    this.observeDispatchCosts();
    const budget = this.options.computeBudget;
    budget?.submit("groundCoverCompute", this.rings.length);
    const admitted = budget ? budget.admitted("groundCoverCompute") : this.rings.length;

    if (
      this.residentOriginX !== input.floatingOriginX
      || this.residentOriginZ !== input.floatingOriginZ
    ) {
      this.residentOriginX = input.floatingOriginX;
      this.residentOriginZ = input.floatingOriginZ;
      // `clearStorageBuffer` records a `clearBuffer` into the frame's own
      // encoder at this point, ahead of the dispatches below, so a ring that
      // does dispatch overwrites the zeros with this frame's survivors and
      // one that does not draws degenerates.
      for (const ring of this.rings) {
        ring.blades.clear();
        ring.liveCount = null;
        ring.drawCount = ring.laneCount;
      }
    }

    // World-space frustum planes: Babylon's planes live in the origin-local
    // scene frame, so shift each plane's distance by the floating origin.
    Frustum.GetPlanesToRef(this.scene.getTransformMatrix(), FRUSTUM_SCRATCH);
    const gateHeightScale = 0.55 + 0.45 * gate;
    const counterFrame = this.counterFrame % GROUND_COVER_COUNTER_RING;
    let dispatched = 0;
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
      uniforms.updateFloat4(
        "cover",
        counterFrame * GROUND_COVER_COUNTER_SLOTS + ringIndex,
        ring.laneCount,
        this.options.seaLevelMeters ?? 0,
        0,
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
      if (ring.compute.isReady() && ringIndex < admitted) {
        if (dispatched === 0) this.resetCounterSlot(counterFrame);
        ring.compute.dispatch(Math.ceil(ring.laneCount / 64), 1, 1);
        this.publishIndirect(ring, counterFrame, ringIndex);
        dispatched += 1;
        this.applyDrawCount(ring);
        ring.mesh.setEnabled(true);
      } else {
        // A deferred ring keeps LAST frame's records and last frame's count,
        // which is why deferring this client is invisible: the lattice is
        // world-anchored, so a frame-old field is the same field.
        ring.mesh.setEnabled(ring.compute.isReady());
      }
      innerRadius = outerRadius;
    }
    if (dispatched === this.rings.length && this.rings.length > 0) {
      this.readCounters(counterFrame);
      this.counterFrame += 1;
    }
  }

  private resetCounterSlot(counterFrame: number): void {
    this.counters?.update(
      this.counterZeros,
      counterFrame * GROUND_COVER_COUNTER_SLOTS * 4,
      GROUND_COVER_COUNTER_SLOTS * 4,
    );
  }

  /**
   * §7 R4's optimisation. The publish pass runs immediately after the ring's
   * placement dispatch, in the same encoder, so the count it writes is this
   * frame's — no readback latency and no safety margin. It touches the MAIN
   * pass's indirect buffer and nothing else.
   */
  private publishIndirect(
    ring: GroundCoverRingResources,
    counterFrame: number,
    ringIndex: number,
  ): void {
    const publish = ring.publish;
    const params = ring.publishParams;
    if (!publish || !params) return;
    const passId = mainRenderPassId(this.scene);
    if (ring.indirectPassId !== passId) {
      const indirect: DataBuffer | null = mainPassIndirectBuffer(
        ring.mesh,
        ring.indexCount,
        passId,
      );
      // Null until the mesh has rendered once under this pass: Babylon
      // creates the draw wrapper lazily. Until then the readback count
      // carries the draw, which is the same degradation the whole feature is
      // designed around.
      if (!indirect) return;
      publish.setStorageBuffer("groundIndirect", indirect as never);
      ring.indirectPassId = passId;
    }
    params.updateUIntArray("publish", new Uint32Array([
      counterFrame * GROUND_COVER_COUNTER_SLOTS + ringIndex,
      ring.laneCount,
      ring.indexCount,
      0,
    ]));
    params.update();
    if (publish.isReady()) publish.dispatch(1, 1, 1);
  }

  /**
   * The conservative count, applied.
   *
   * With indirect ON the mesh's `forcedInstanceCount` is PINNED at capacity —
   * that is what keeps `setIndirectData`'s early-return holding so Babylon
   * never overwrites the GPU-written count. With indirect off (the default)
   * the count IS `forcedInstanceCount`, and because the blade meshes appear
   * in no shadow or reflection pass, one count is safe for every pass they
   * are drawn in.
   */
  private applyDrawCount(ring: GroundCoverRingResources): void {
    if (this.indirectRequested && this.indirectProbe.supported && ring.indirectPassId !== null) {
      ring.drawCount = ring.laneCount;
      ring.mesh.forcedInstanceCount = ring.laneCount;
      return;
    }
    ring.drawCount = groundCoverDrawCount(ring.laneCount, ring.liveCount, ring.drawCount);
    ring.mesh.forcedInstanceCount = ring.drawCount;
  }

  /**
   * Issue the frame's counter readback.
   *
   * Called SYNCHRONOUSLY after the dispatches and before any await, so the
   * `copyBufferToBuffer` lands in this frame's encoder behind them. The slot
   * it reads is not re-zeroed until `GROUND_COVER_COUNTER_RING` frames later,
   * which is what stops the copy from resolving against a fresh zero — the
   * failure mode that returns the atomic identity and draws nothing.
   */
  private readCounters(counterFrame: number): void {
    const counters = this.counters;
    if (!counters) return;
    if (this.readbacksInFlight >= GROUND_COVER_COUNTER_RING - 1) return;
    this.readbacksInFlight += 1;
    const byteLength = groundCoverCounterBytes();
    void counters.read(0, byteLength).then((view) => {
      if (this.disposed) return;
      const counts = new Uint32Array(
        view.buffer.slice(view.byteOffset, view.byteOffset + byteLength),
      );
      const base = counterFrame * GROUND_COVER_COUNTER_SLOTS;
      this.rings.forEach((ring, index) => {
        const live = counts[base + index];
        if (live !== undefined) ring.liveCount = live;
      });
    }).catch(() => {
      // A failed readback leaves `liveCount` where it was; the next frame's
      // draw count therefore holds rather than collapsing, and a permanently
      // failing readback simply keeps drawing the whole lattice.
    }).finally(() => {
      this.readbacksInFlight -= 1;
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseRings();
    if (this.counters) {
      this.counters.dispose();
      releaseGpuBufferBytes(groundCoverCounterBytes());
      this.counters = null;
    }
    this.heightTexture?.dispose();
    this.attributeTexture?.dispose();
    this.driverTexture?.dispose();
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
