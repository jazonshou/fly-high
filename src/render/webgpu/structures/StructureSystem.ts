import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import type { StructureTextureEdge } from "@/src/world/structures/kit/kitTextures";
import { SETTLEMENT_STREAM_WINDOW } from "@/src/world/settlements/settlementStreaming";
import type { StructureRecord } from "@/src/world/structures/structureRecord";
import { STRUCTURE_THIN_NEAR_METERS, type StructureMeshArrays } from "../../structures/structureMeshArrays";
import type { StructureTexturePlans } from "../../structures/structureTextures";
import type { StructureNightLighting } from "../../structures/structureNightLighting";
import { StructureLampPool, type StructureLampSink, type StructureLampStatistics } from "../../structures/StructureLampPool";
import { LIGHT_POINT_STRUCTURES } from "../lighting/LightPoints";
import {
  STRUCTURE_SMOKE_RANGE_METERS,
  STRUCTURE_SMOKE_WISPS,
  structureSmokeFlues,
  writeStructureSmokeWisps,
  type StructureSmokeFlue,
} from "../../structures/structureSmoke";
import { STEAM_FLOATS_PER_WISP, type SteamWispWriter } from "../volcanic/VolcanicSteamSystem";
import { StructureRecordStore, type StructureHidden, type StructureRegionRecords } from "../../structures/StructureRecordStore";
import {
  STRUCTURE_HANDOFF_BAND_METERS,
  StructureSets,
  type StructureDrawRanges,
  type StructurePoint,
} from "../../structures/StructureSets";
import type { PipelineWarmUp } from "../core/AsyncPipelineCompiles";
import { uploadMippedTextureArrayPlan } from "../core/TextureArrayMips";
import { prepareMaterialForClusteredLighting } from "../lighting/ClusteredLighting";
import {
  STRUCTURE_BASE_ROUGHNESS,
  STRUCTURE_GLASS_ROUGHNESS,
  STRUCTURE_OPEN_SLOTS,
  STRUCTURE_VERTEX_ATTRIBUTES,
  StructureMaterialPlugin,
  type StructureMaterialRole,
  type StructureTextureArrays,
} from "./StructureMaterialPlugin";

/**
 * The generated buildings on the GPU (the plan's "Drawing it"): at most four
 * draws whatever the number of buildings, one material.
 *
 *   far    every visible building as a block, out to the far radius;
 *   near   the closed shells within the near radius;
 *   open   the few buildings next to the camera, open, with their rooms;
 *   glass  their window glass, blended.
 *
 * `StructureSets` decides who is in each, `StructureMaterialPlugin` draws
 * each building in one set or the other per pixel across the handoff band,
 * from the camera alone. The near set casts the sun's shadows where the
 * profile says (`addShadowCasters`, the renderer's per-frame caster sync); no
 * other set does.
 *
 * MESHES ARE NEW EACH BUILD. A set's arrays come back from the builder (a
 * worker) as a whole; each build is a new mesh and the old one is disposed
 * when the new one is in. A mesh's buffers and index range never change after
 * it is drawn, so no recorded draw bundle replays stale geometry and no
 * caster's depth wrapper is reset under it (`guardedShadowDepthWrapper.ts`).
 * One build per set is in flight at a time; a set decided again meanwhile is
 * built from its latest records once that one lands.
 *
 * NO COMPILE IN A FRAME. The materials are deferred by the renderer
 * (`AsyncPipelineCompiles.defer`); each new mesh is handed to the warm-up,
 * and the far, near and open materials share one effect, so the far blocks
 * that stream in first compile the pipeline the shells use.
 *
 * MATERIAL ARRAYS. Where the profile has a `structureTextureEdge`, the kit's
 * two arrays are asked of the builder once (a worker synthesises, mips and
 * packs them) and uploaded when they land; the materials are compiled
 * textured from the start and read flat placeholders until then, so their
 * arrival swaps two bindings and compiles nothing. A capture waits for them.
 */

/** What the system takes from the quality profile: data, never a tier branch. */
export interface StructureSystemProfile extends StructureDrawRanges {
  /** The near set casts the sun's shadows. */
  readonly structureNearCastsShadows: boolean;
  /** The kit's material arrays' edge; 0 draws the part colours alone. */
  readonly structureTextureEdge: 0 | StructureTextureEdge;
  /** The most light points the buildings' lights take (`StructureLampPool`). */
  readonly structureLampPoints: number;
  /** The homes' chimneys smoke (`structureSmoke.ts`), as wisps of the steam's draw. */
  readonly structureChimneySmoke: boolean;
}

/** Where chimney smoke goes: the volcanic steam's draw (`VolcanicSteamSystem.setExtraWisps`). */
export interface StructureSmokeSink {
  setExtraWisps(count: number, writer: SteamWispWriter | null): void;
}

/** The camera moves this far before the smoking chimneys are chosen again. */
export const STRUCTURE_SMOKE_RESELECT_METERS = 100;

/** The most chimneys smoking at once (the steam's cap, vents first, may allow fewer). */
export const STRUCTURE_SMOKE_MAX_FLUES = 32;

/** Which set a build is for. */
export type StructureSetName = "far" | "near" | "open";

/** One set's arrays: the opaque mesh, and (the open set) its glass. */
export interface StructureMeshBuild {
  readonly opaque: StructureMeshArrays;
  readonly glass: StructureMeshArrays | null;
  /**
   * The set's chimney flues, four floats each: x and z relative to the
   * build's origin, absolute y, and the index of the flue's building in the
   * build's records. Absent from builders that make none.
   */
  readonly chimneys?: Float32Array;
}

/** Where a set's arrays are made: the structures worker, or inline in tests. */
export interface StructureMeshBuilder {
  build(set: StructureSetName, records: readonly StructureRecord[], originX: number, originZ: number): Promise<StructureMeshBuild>;
  /** The kit's material arrays at an edge, mipped and packed. */
  textures(edge: StructureTextureEdge): Promise<StructureTexturePlans>;
  dispose(): void;
}

/** The kit's arrays on the GPU, and how to let them go. */
export interface StructureUploadedTextures extends StructureTextureArrays {
  dispose(): void;
}

/** Plans to GPU arrays: Babylon's raw array textures, or a fake in Node tests. */
export type StructureTextureUpload = (scene: Scene, plans: StructureTexturePlans) => StructureUploadedTextures;

/** The arrays' anisotropy, the other kit-made atlases' (boats, cars, airfields). */
const STRUCTURE_TEXTURE_ANISOTROPY = 8;

export const uploadStructureTextures: StructureTextureUpload = (scene, plans) => {
  const detail = uploadMippedTextureArrayPlan(scene, plans.detail, { name: `structures-detail-${plans.edge}` });
  let normal;
  try {
    normal = uploadMippedTextureArrayPlan(scene, plans.normal, { name: `structures-normal-${plans.edge}` });
  } catch (error) {
    detail.dispose();
    throw error;
  }
  detail.anisotropicFilteringLevel = STRUCTURE_TEXTURE_ANISOTROPY;
  normal.anisotropicFilteringLevel = STRUCTURE_TEXTURE_ANISOTROPY;
  return {
    detail,
    normal,
    dispose: () => {
      detail.dispose();
      normal.dispose();
    },
  };
};

export interface StructureSystemStatistics {
  readonly regions: number;
  readonly visibleBuildings: number;
  readonly hiddenBuildings: number;
  /** Buildings and triangles in each set's mesh as drawn now. */
  readonly farBuildings: number;
  readonly nearBuildings: number;
  readonly openBuildings: number;
  readonly farTriangles: number;
  readonly nearTriangles: number;
  readonly openTriangles: number;
  readonly glassTriangles: number;
  /** Buildings drawn open this frame. */
  readonly drawnOpen: number;
  /** Meshes enabled now (0-4): what the structures add to a frame's beauty draws. */
  readonly enabledMeshes: number;
  readonly shadowCasters: number;
  /** Builds asked for, landed, and failed; builds in flight or waiting now. */
  readonly builds: number;
  readonly landed: number;
  readonly failures: number;
  readonly pendingWork: number;
  /** The material arrays drawn now: their edge (0 none yet, or untextured) and bytes with their chains. */
  readonly textureEdge: number;
  readonly textureBytes: number;
  /** Material arrays asked for, and failed. */
  readonly textureRequests: number;
  readonly textureFailures: number;
  /** The buildings' light points (zeros until `setLamps`). */
  readonly lamps: StructureLampStatistics;
}

interface SetState {
  readonly name: StructureSetName;
  /** The records the mesh drawn now was built from, and its origin. */
  records: readonly StructureRecord[];
  ids: ReadonlySet<number>;
  originX: number;
  originZ: number;
  opaque: Mesh | null;
  glass: Mesh | null;
  triangles: number;
  glassTriangles: number;
  /** A build in flight, and the records decided since, to build when it lands. */
  inFlight: boolean;
  next: { readonly records: readonly StructureRecord[]; readonly originX: number; readonly originZ: number } | null;
}

/** A building's centre sits at the build origin's metre, so its vertices' centre is exact in Float32 for a match. */
function buildOrigin(x: number): number {
  return Math.round(x);
}

export class StructureSystem {
  readonly store = new StructureRecordStore();
  private readonly sets: StructureSets;
  private readonly far: SetState = emptySet("far");
  private readonly near: SetState = emptySet("near");
  private readonly open: SetState = emptySet("open");
  private readonly materialsByRole: Record<StructureMaterialRole, { material: PBRMaterial; plugin: StructureMaterialPlugin }>;
  private profile: StructureSystemProfile;
  private originX = 0;
  private originZ = 0;
  private drawnOpen: readonly StructureRecord[] = [];
  private builds = 0;
  private landed = 0;
  private failures = 0;
  private disposed = false;
  /** The material arrays drawn now, the edge asked for, and the edge whose request is in flight. */
  private textures: { readonly edge: StructureTextureEdge; readonly arrays: StructureUploadedTextures; readonly bytes: number } | null = null;
  private textureInFlight: StructureTextureEdge | null = null;
  private textureRequests = 0;
  private textureFailures = 0;
  private lamps: StructureLampPool | null = null;
  private smoke: StructureSmokeSink | null = null;
  /** The far set's smoking flues, as drawn now; chosen near the camera into the steam's draw. */
  private flues: readonly StructureSmokeFlue[] = [];
  private smokeDirty = false;
  private smokeChosenAt: { x: number; z: number } | null = null;
  private smoking = 0;
  private night: StructureNightLighting | null = null;

  constructor(
    private readonly scene: Scene,
    profile: StructureSystemProfile,
    private readonly builder: StructureMeshBuilder,
    private readonly pipelineWarmUp: PipelineWarmUp | null = null,
    private readonly uploadTextures: StructureTextureUpload = uploadStructureTextures,
  ) {
    this.profile = profile;
    this.sets = new StructureSets(effectiveRanges(profile));
    const textured = profile.structureTextureEdge > 0;
    this.materialsByRole = {
      far: createMaterial(scene, "far", textured),
      near: createMaterial(scene, "near", textured),
      open: createMaterial(scene, "open", textured),
      glass: createMaterial(scene, "glass", false),
    };
    this.wantTextures();
  }

  /** Every material, for the renderer's deferral and the receivers (haze, cloud shadows). */
  get materials(): readonly PBRMaterial[] {
    return Object.values(this.materialsByRole).map((entry) => entry.material);
  }

  /** The meshes drawn now (they change as sets are rebuilt). */
  get meshes(): readonly Mesh[] {
    const out: Mesh[] = [];
    for (const set of [this.far, this.near, this.open]) {
      if (set.opaque) out.push(set.opaque);
      if (set.glass) out.push(set.glass);
    }
    return out;
  }

  /** A change to the streamed regions (`RoadStreamRuntime`'s consumers); road regions are ignored. */
  apply(install: readonly StructureRegionRecords[], remove: readonly string[]): void {
    this.store.apply(install, remove);
  }

  /** The rule that hides buildings (a spawned airport's earthworks over a footprint). */
  setHidden(hidden: StructureHidden | null): void {
    this.store.setHidden(hidden);
  }

  setProfile(profile: StructureSystemProfile): void {
    this.profile = profile;
    this.sets.setRanges(effectiveRanges(profile));
    const textured = profile.structureTextureEdge > 0;
    for (const { plugin } of Object.values(this.materialsByRole)) plugin.setTextured(textured);
    this.wantTextures();
    this.lamps?.setRanges(this.lampRanges());
    this.smokeDirty = true;
  }

  /** The buildings' lights (`structureNightLighting`), every frame or on a change; off until set. */
  setNight(night: StructureNightLighting): void {
    this.night = night;
    for (const { plugin } of Object.values(this.materialsByRole)) plugin.setNight(night);
    this.lamps?.setNight(night);
  }

  /**
   * Where the chimney smoke goes: wisps of the volcanic steam's draw. None
   * until set; drawn only where the profile says (`structureChimneySmoke`).
   */
  setSmoke(sink: StructureSmokeSink): void {
    this.smoke?.setExtraWisps(0, null);
    this.smoke = sink;
    this.smokeDirty = true;
  }

  /** Chimneys smoking now. */
  get smokingChimneys(): number {
    return this.smoking;
  }

  /**
   * Where the buildings' light points go: a group of the home field's
   * light-point draw (`LightPointSystem`), so they cost no draw. None until
   * set; set once, when the draw exists.
   */
  setLamps(sink: StructureLampSink, clockSeconds?: () => number): void {
    this.lamps?.dispose();
    this.lamps = new StructureLampPool(sink, LIGHT_POINT_STRUCTURES, clockSeconds);
    this.lamps.setRanges(this.lampRanges());
    if (this.night) this.lamps.setNight(this.night);
  }

  setFloatingOrigin(x: number, z: number): void {
    this.originX = x;
    this.originZ = z;
    for (const set of [this.far, this.near, this.open]) this.place(set);
  }

  private lampRanges(): ReturnType<typeof lampRangesOf> {
    return lampRangesOf(this.profile);
  }

  /** Builds in flight or waiting, and sets decided but not drawn yet: a capture waits for none. */
  get pendingWork(): number {
    let pending = 0;
    for (const set of [this.far, this.near, this.open]) pending += (set.inFlight ? 1 : 0) + (set.next ? 1 : 0);
    if (this.textureInFlight !== null) pending += 1;
    return pending;
  }

  /** Once a frame, with the camera's absolute position: decide the sets, ask for builds, bind the draws. */
  update(camera: StructurePoint): void {
    if (this.disposed) return;
    const records = this.store.visible();
    const changes = this.sets.update(camera, records, this.store.version);
    if (changes.far) this.request(this.far, changes.far, camera);
    if (changes.near) this.request(this.near, changes.near, camera);
    if (changes.openWanted) this.request(this.open, changes.openWanted, camera);
    this.drawnOpen = this.sets.openDrawn((record) => this.open.ids.has(record.id)).slice(0, STRUCTURE_OPEN_SLOTS);
    this.bind(camera);
    this.lamps?.update(camera, records, this.store.version);
    this.updateSmoke(camera);
  }

  /** The nearest smoking chimneys into the steam's draw, chosen again as the camera moves or the far set changes. */
  private updateSmoke(camera: StructurePoint): void {
    const sink = this.smoke;
    if (!sink) return;
    const at = this.smokeChosenAt;
    if (!this.smokeDirty && at && Math.hypot(camera.x - at.x, camera.z - at.z) < STRUCTURE_SMOKE_RESELECT_METERS) return;
    this.smokeDirty = false;
    this.smokeChosenAt = { x: camera.x, z: camera.z };
    const near: { flue: StructureSmokeFlue; distance: number }[] = [];
    if (this.profile.structureChimneySmoke) {
      const reach = STRUCTURE_SMOKE_RANGE_METERS + STRUCTURE_SMOKE_RESELECT_METERS;
      for (const flue of this.flues) {
        const distance = Math.hypot(flue.x - camera.x, flue.z - camera.z);
        if (distance <= reach) near.push({ flue, distance });
      }
      near.sort((a, b) => a.distance - b.distance || a.flue.seed - b.flue.seed);
    }
    const chosen = near.slice(0, STRUCTURE_SMOKE_MAX_FLUES).map((entry) => entry.flue);
    this.smoking = chosen.length;
    if (chosen.length === 0) {
      sink.setExtraWisps(0, null);
      return;
    }
    sink.setExtraWisps(chosen.length * STRUCTURE_SMOKE_WISPS, (anchorX, anchorZ, windSpeed, out, offset) => {
      for (let index = 0; index < chosen.length; index += 1) {
        writeStructureSmokeWisps(
          chosen[index]!,
          anchorX,
          anchorZ,
          windSpeed,
          STRUCTURE_SMOKE_WISPS,
          out,
          offset + index * STRUCTURE_SMOKE_WISPS * STEAM_FLOATS_PER_WISP,
        );
      }
    });
  }

  /** The renderer's caster sync: the near shells, where the profile casts. */
  addShadowCasters(collect: (mesh: Mesh) => void): void {
    if (!this.profile.structureNearCastsShadows) return;
    if (this.near.opaque) collect(this.near.opaque);
  }

  get statistics(): StructureSystemStatistics {
    const meshes = this.meshes;
    return {
      regions: this.store.regionCount,
      visibleBuildings: this.store.visible().length,
      hiddenBuildings: this.store.hiddenCount(),
      farBuildings: this.far.records.length,
      nearBuildings: this.near.records.length,
      openBuildings: this.open.records.length,
      farTriangles: this.far.triangles,
      nearTriangles: this.near.triangles,
      openTriangles: this.open.triangles,
      glassTriangles: this.open.glassTriangles,
      drawnOpen: this.drawnOpen.length,
      enabledMeshes: meshes.filter((mesh) => mesh.isEnabled(false)).length,
      shadowCasters: this.profile.structureNearCastsShadows && this.near.opaque ? 1 : 0,
      builds: this.builds,
      landed: this.landed,
      failures: this.failures,
      pendingWork: this.pendingWork,
      textureEdge: this.textures?.edge ?? 0,
      textureBytes: this.textures?.bytes ?? 0,
      textureRequests: this.textureRequests,
      textureFailures: this.textureFailures,
      lamps: this.lamps?.statistics ?? { sites: 0, points: 0, dropped: 0, rebuilds: 0, recolours: 0 },
    };
  }

  dispose(): void {
    this.disposed = true;
    this.lamps?.dispose();
    this.lamps = null;
    this.smoke?.setExtraWisps(0, null);
    this.smoke = null;
    for (const set of [this.far, this.near, this.open]) {
      set.opaque?.dispose(false, false);
      set.glass?.dispose(false, false);
      set.opaque = null;
      set.glass = null;
    }
    for (const { material } of Object.values(this.materialsByRole)) material.dispose();
    this.textures?.arrays.dispose();
    this.textures = null;
    this.builder.dispose();
  }

  /**
   * The profile's arrays: none at edge 0 (any drawn are let go), else asked
   * for unless drawn or in flight. One request at a time; one landing at an
   * edge the profile has left since is let go, and the profile's asked for.
   */
  private wantTextures(): void {
    if (this.disposed) return;
    const edge = this.profile.structureTextureEdge;
    if (edge === 0) {
      if (this.textures) this.showTextures(null);
      return;
    }
    if (this.textures?.edge === edge || this.textureInFlight !== null) return;
    this.textureInFlight = edge;
    this.textureRequests += 1;
    this.builder.textures(edge).then(
      (plans) => this.landTextures(edge, plans),
      () => {
        this.textureFailures += 1;
        this.textureInFlight = null;
        // Not asked again: the materials keep their flat placeholders.
      },
    );
  }

  private landTextures(edge: StructureTextureEdge, plans: StructureTexturePlans): void {
    this.textureInFlight = null;
    if (this.disposed) return;
    if (edge !== this.profile.structureTextureEdge) {
      this.wantTextures();
      return;
    }
    let arrays: StructureUploadedTextures;
    try {
      arrays = this.uploadTextures(this.scene, plans);
    } catch {
      this.textureFailures += 1;
      return;
    }
    this.showTextures({ edge, arrays, bytes: plans.detail.totalBytes + plans.normal.totalBytes });
  }

  private showTextures(next: StructureSystem["textures"]): void {
    const previous = this.textures;
    this.textures = next;
    for (const role of ["far", "near", "open"] as const) this.materialsByRole[role].plugin.setTextures(next?.arrays ?? null);
    previous?.arrays.dispose();
  }

  private request(set: SetState, records: readonly StructureRecord[], camera: StructurePoint): void {
    const job = { records, originX: buildOrigin(camera.x), originZ: buildOrigin(camera.z) };
    if (set.inFlight) {
      set.next = job;
      return;
    }
    this.start(set, job);
  }

  private start(set: SetState, job: NonNullable<SetState["next"]>): void {
    set.inFlight = true;
    this.builds += 1;
    if (job.records.length === 0) {
      // Nothing to build: the set empties now.
      queueMicrotask(() => this.land(set, job, null));
      return;
    }
    this.builder.build(set.name, job.records, job.originX, job.originZ).then(
      (build) => this.land(set, job, build),
      () => {
        this.failures += 1;
        this.land(set, job, null, true);
      },
    );
  }

  /** A build is in: its meshes replace the set's (a failure keeps what is drawn), and the next one starts. */
  private land(set: SetState, job: NonNullable<SetState["next"]>, build: StructureMeshBuild | null, failed = false): void {
    set.inFlight = false;
    if (this.disposed) return;
    if (!failed) {
      this.landed += 1;
      set.opaque?.dispose(false, false);
      set.glass?.dispose(false, false);
      set.records = job.records;
      set.ids = new Set(job.records.map((record) => record.id));
      set.originX = job.originX;
      set.originZ = job.originZ;
      const role: StructureMaterialRole = set.name;
      set.opaque = build ? this.createMesh(`structures-${set.name}`, build.opaque, role) : null;
      set.glass = build?.glass ? this.createMesh(`structures-${set.name}-glass`, build.glass, "glass") : null;
      set.triangles = build?.opaque.triangles ?? 0;
      set.glassTriangles = build?.glass?.triangles ?? 0;
      this.place(set);
      if (set.name === "far") {
        // Every building's chimneys are in the far set (it holds them all, as blocks).
        this.flues = build?.chimneys ? structureSmokeFlues(build.chimneys, job.records, job.originX, job.originZ) : [];
        this.smokeDirty = true;
      }
    }
    const next = set.next;
    set.next = null;
    if (next) this.start(set, next);
  }

  private createMesh(name: string, arrays: StructureMeshArrays, role: StructureMaterialRole): Mesh | null {
    if (arrays.triangles === 0) return null;
    const mesh = new Mesh(name, this.scene);
    mesh.setVerticesData(VertexBuffer.PositionKind, arrays.positions, false, 3);
    mesh.setVerticesData(VertexBuffer.NormalKind, arrays.normals, false, 3);
    mesh.setVerticesData(STRUCTURE_VERTEX_ATTRIBUTES.surface.kind, arrays.surface, false, STRUCTURE_VERTEX_ATTRIBUTES.surface.floats);
    mesh.setVerticesData(STRUCTURE_VERTEX_ATTRIBUTES.colour.kind, arrays.colour, false, STRUCTURE_VERTEX_ATTRIBUTES.colour.floats);
    mesh.setVerticesData(STRUCTURE_VERTEX_ATTRIBUTES.indoor.kind, arrays.indoor, false, STRUCTURE_VERTEX_ATTRIBUTES.indoor.floats);
    mesh.setVerticesData(STRUCTURE_VERTEX_ATTRIBUTES.centre.kind, arrays.centre, false, STRUCTURE_VERTEX_ATTRIBUTES.centre.floats);
    mesh.setVerticesData(STRUCTURE_VERTEX_ATTRIBUTES.uv.kind, arrays.uvs, false, STRUCTURE_VERTEX_ATTRIBUTES.uv.floats);
    mesh.setIndices(arrays.indices, arrays.positions.length / 3);
    mesh.material = this.materialsByRole[role].material;
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    const casts = role === "near" && this.profile.structureNearCastsShadows;
    mesh.metadata = { structures: role, castsShadow: casts };
    this.pipelineWarmUp?.warmUp(mesh, casts);
    return mesh;
  }

  private place(set: SetState): void {
    for (const mesh of [set.opaque, set.glass]) {
      mesh?.position.set(set.originX - this.originX, 0, set.originZ - this.originZ);
    }
  }

  /** Each material's camera and radii, in its set's own frame; the near set drops the buildings drawn open. */
  private bind(camera: StructurePoint): void {
    const ranges = this.sets.drawRanges;
    for (const set of [this.far, this.near, this.open]) {
      const dropped: number[] = [];
      for (const record of this.drawnOpen) dropped.push(record.x - set.originX, record.z - set.originZ);
      const binding = {
        cameraX: camera.x - set.originX,
        cameraZ: camera.z - set.originZ,
        nearRadiusMeters: ranges.structureNearRadiusMeters,
        thinNearRadiusMeters: Math.min(STRUCTURE_THIN_NEAR_METERS, ranges.structureNearRadiusMeters),
        bandMeters: STRUCTURE_HANDOFF_BAND_METERS,
        farRadiusMeters: ranges.structureFarRadiusMeters,
        dropped,
      };
      this.materialsByRole[set.name].plugin.setBinding(binding);
      if (set.name === "open") this.materialsByRole.glass.plugin.setBinding(binding);
      const shown = set.name !== "open" || this.drawnOpen.length > 0;
      set.opaque?.setEnabled(shown);
      set.glass?.setEnabled(shown);
    }
  }
}

/** The light points' ranges: the far set's (they come in as its blocks do) and the tier's budget. */
function lampRangesOf(profile: StructureSystemProfile): { nearRadiusMeters: number; bandMeters: number; farRadiusMeters: number; maxPoints: number } {
  const ranges = effectiveRanges(profile);
  return {
    nearRadiusMeters: ranges.structureNearRadiusMeters,
    bandMeters: STRUCTURE_HANDOFF_BAND_METERS,
    farRadiusMeters: ranges.structureFarRadiusMeters,
    maxPoints: profile.structureLampPoints,
  };
}

/** The profile's radii, the far one no further than the settlements stream (`SETTLEMENT_STREAM_WINDOW`). */
function effectiveRanges(profile: StructureDrawRanges): StructureDrawRanges {
  return {
    structureNearRadiusMeters: profile.structureNearRadiusMeters,
    structureFarRadiusMeters: Math.min(profile.structureFarRadiusMeters, SETTLEMENT_STREAM_WINDOW),
    structureOpenBuildings: Math.min(profile.structureOpenBuildings, STRUCTURE_OPEN_SLOTS),
  };
}

function emptySet(name: StructureSetName): SetState {
  return {
    name,
    records: [],
    ids: new Set(),
    originX: 0,
    originZ: 0,
    opaque: null,
    glass: null,
    triangles: 0,
    glassTriangles: 0,
    inFlight: false,
    next: null,
  };
}

/** One role's PBR material and plugin: a dielectric whose albedo is the plugin's. */
function createMaterial(
  scene: Scene,
  role: StructureMaterialRole,
  textured: boolean,
): { material: PBRMaterial; plugin: StructureMaterialPlugin } {
  const material = new PBRMaterial(`structures-${role}`, scene);
  material.albedoColor = Color3.White();
  material.metallic = 0;
  material.roughness = role === "glass" ? STRUCTURE_GLASS_ROUGHNESS : STRUCTURE_BASE_ROUGHNESS;
  if (role === "glass") {
    material.alpha = 0.32;
    material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    material.backFaceCulling = false;
  }
  material.metadata = { structures: role };
  prepareMaterialForClusteredLighting(material);
  const plugin = new StructureMaterialPlugin(material, role, textured);
  return { material, plugin };
}
