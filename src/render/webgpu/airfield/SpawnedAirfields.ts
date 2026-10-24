import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import {
  runwayToWorld,
  sampleWind,
  type AirportDefinition,
  type WindSample,
  type WorldDefinition,
} from "@/src/world";
import type { SpawnedAirfieldTier } from "../core/QualityProfile";
import {
  appendPerimeterFenceStations,
  buildFuelFarmGeometry,
  buildSignageGeometry,
  buildWindsockPart,
  perimeterFenceStations,
  windsockHeadingRadians,
  windsockWorldPosition,
  WINDSOCK_MAST_HEIGHT_METERS,
  type FurnitureGeometryAccumulator,
} from "../detail/AirfieldFurniture";
import { buildTowerGeometry, TOWER_PART_NAMES, type TowerGeometry } from "../detail/towerGeometry";
import { AirfieldLightingSystem } from "../lighting/AirfieldLighting";
import type { ClusteredLightDefinition } from "../lighting/ClusteredLighting";
import type { LightPointFixture } from "../lighting/LightPoints";
import {
  HANGAR_FLOOD_INTENSITY,
  HANGAR_FLOOD_RANGE_METERS,
  HANGAR_FLOOD_RGB,
  hangarFaceFloodlights,
  hangarObstructionFixtures,
  towerObstructionFixtures,
} from "../lighting/ObstructionLighting";
import type { AirfieldMaterialSet } from "./AirfieldMaterials";
import {
  airfieldGroundPoints,
  hangarSite,
  poseWindsock,
  towerSite,
  TOWER_PART_SURFACES,
  windsockNodePosition,
  type HangarSite,
  type TowerSite,
} from "./AirfieldPlacement";
import { HANGAR_SITING, hangarShellGeometry, type HangarSurface } from "./AirfieldStructures";
import { sameAirport } from "./AirportFootprint";

/**
 * Airports spawned mid-flight (`world.airports[1..]`) get the home field's
 * airfield: hangars, tower, windsock, perimeter fence, fuel farm and signs, its
 * runway, threshold, approach, PAPI, sign and obstruction lamps, and its hangar
 * floods.
 *
 * **NOTHING IS BUILT IN `setAirports`.** That call only diffs the list. A field's
 * construction — about 2,500 ground samples and ~60 k vertices (50 k
 * triangles) of merged geometry, a few hundred milliseconds of main-thread
 * work if done at once — runs as a queue of small steps inside `update`, under
 * `SPAWNED_AIRFIELD_FRAME_BUDGET_MS` per frame (~120 frames a field).
 *
 * **NO NEW MATERIAL, TEXTURE OR PIPELINE.** Structures draw with the HOME
 * field's material set (`AirportSystem.materials`), with exactly the vertex
 * layouts the home field's meshes already compiled pipelines for; lamps ride
 * the home field's light-point draw; floods are clustered lights reserved at
 * startup. Spawning compiles nothing.
 *
 * **BATCHED, NOT 22 MESHES.** The home field draws its 22 structure meshes
 * separately. A spawned field merges them per (material, vertex layout,
 * shadow role) into 7 — concrete, corrugated metal, glass, steel, the untextured
 * metal furniture, the fence, and the sock that moves — baked into the field
 * root's frame, so a spawned field in view costs 7 beauty draws (plus 6 casters
 * per cascade where the tier casts) and its lamps cost none.
 *
 * **BOUNDED BY TIER.** Only the nearest `maxStructureFields` fields within
 * `structureBuildRadiusMeters` are built; the rest have no meshes and no memory.
 * Built meshes stop drawing beyond `structureCullMeters`. Low builds, lights
 * and reserves nothing. Ranking runs a few times a second, never per frame.
 */

/**
 * Main-thread time a frame may spend building spawned airfields. A step is not
 * started when the one before it says it would end past this, and no step is
 * much over a millisecond, so a building frame stays near the budget.
 */
export const SPAWNED_AIRFIELD_FRAME_BUDGET_MS = 1;
/** How often fields are re-ranked by distance (structures, PAPI, socks, floods). */
export const SPAWNED_AIRFIELD_REFRESH_MS = 250;
/** A PAPI farther than this is not re-resolved per frame. */
export const SPAWNED_PAPI_RADIUS_METERS = 25_000;
/** Per-frame PAPI resolution is limited to this many nearest fields. */
export const SPAWNED_PAPI_FIELDS = 3;
/** A built field is kept until it is this much farther than the build radius. */
const STRUCTURE_RELEASE_FACTOR = 1.2;
/** Fence stations appended per build step (~1,200 on a 3.6 km perimeter). */
const FENCE_STATIONS_PER_STEP = 32;
/** Ground samples between deadline checks. */
const GROUND_SAMPLES_PER_CHECK = 4;

/**
 * WebGPU's clustered batch: `ClusteredLightContainer` sizes its tile mask and
 * light texture in batches of this many, and a container whose lights exceed
 * one batch reallocates both and loops twice per pixel. The reserve stays
 * inside the batch the home field's floods and the aircraft's lights already
 * occupy.
 */
export const CLUSTERED_LIGHT_BATCH_CAPACITY = 32;
/** Two floods per hangar. */
export const SPAWNED_FLOODS_PER_FIELD = HANGAR_SITING.count * 2;
/** Most spawned fields whose floods can be lit at once, whatever the batch has free. */
export const SPAWNED_FLOOD_SLOTS_MAX = 3;
/**
 * Where an unassigned reserve flood waits: a million metres below the world,
 * dark. Its proxy rasterises into no tile, so it sets no mask bit and costs no
 * pixel anything; its intensity is 0 besides.
 */
const PARKED_FLOOD: readonly [number, number, number] = Object.freeze([0, -1_000_000, 0] as const);

/**
 * The clustered reserve for spawned fields' floods, appended to the container's
 * definitions at startup. `ClusteredLightingSystem` builds its lights in its
 * constructor and has no `add`, and constructing a light later would mark every
 * mesh light-dirty, so spawned floods cannot be created in flight; they are
 * parked here and MOVED onto a field instead. Sized to what one clustered batch
 * has free after `existingLights`, in whole fields, at most
 * `SPAWNED_FLOOD_SLOTS_MAX`.
 */
export function spawnedFloodReserve(
  existingLights: number,
): readonly (readonly ClusteredLightDefinition[])[] {
  const free = Math.max(0, CLUSTERED_LIGHT_BATCH_CAPACITY - existingLights);
  const slots = Math.min(SPAWNED_FLOOD_SLOTS_MAX, Math.floor(free / SPAWNED_FLOODS_PER_FIELD));
  const reserve: ClusteredLightDefinition[][] = [];
  for (let slot = 0; slot < slots; slot += 1) {
    const lights: ClusteredLightDefinition[] = [];
    for (let index = 0; index < SPAWNED_FLOODS_PER_FIELD; index += 1) {
      lights.push({
        name: `spawned-hangar-flood-${slot}-${index}`,
        position: PARKED_FLOOD,
        color: HANGAR_FLOOD_RGB,
        intensity: 0,
        rangeMeters: HANGAR_FLOOD_RANGE_METERS,
      });
    }
    reserve.push(lights);
  }
  return reserve;
}

/** The light-point surface spawned lamps are appended to (the home field's). */
export interface SpawnedLampSink {
  setExtraFixtures(
    fixtures: readonly LightPointFixture[],
    colours?: readonly (readonly [number, number, number])[],
  ): void;
  setExtraColors(start: number, colours: readonly (readonly [number, number, number])[]): void;
}

/** The clustered container's by-name controls. */
export interface SpawnedFloodSink {
  setPosition(name: string, x: number, y: number, z: number): boolean;
  setIntensity(name: string, intensity: number): boolean;
}

export interface SpawnedAirfieldOptions {
  readonly scene: Scene;
  /** For the socks' wind; the field definitions come from `setAirports`. */
  readonly world: WorldDefinition;
  /** The HOME field's materials. Shared, never disposed here. */
  readonly materials: AirfieldMaterialSet;
  /** `world.seedHash` — the siting seed the home field's hangars use. */
  readonly seedHash: number;
  /** Live ground at a world point, already aware of spawned airports' earthworks. */
  readonly groundHeight: (x: number, z: number) => number;
  readonly lamps: SpawnedLampSink;
  readonly floods: SpawnedFloodSink | null;
  /** Reserve flood names per slot, from `spawnedFloodReserve`. */
  readonly floodSlots: readonly (readonly string[])[];
  readonly tier: SpawnedAirfieldTier;
  /** Called once per finished structure build with every mesh it made. */
  readonly onStructuresBuilt?: (meshes: readonly Mesh[]) => void;
  /** Clock for the frame budget and the ranking cadence; `performance.now` by default. */
  readonly now?: () => number;
  /** Per-frame build budget, ms; `SPAWNED_AIRFIELD_FRAME_BUDGET_MS` by default. */
  readonly frameBudgetMs?: number;
}

type GroupKey = "concrete" | "metal" | "glass" | "steel" | "furniture" | "fence";

interface GroupSpec {
  readonly key: GroupKey;
  readonly material: keyof Omit<AirfieldMaterialSet, "dispose">;
  readonly uvs: boolean;
  readonly casts: boolean;
}

/**
 * The merged groups, one draw each. Grouped by what a draw cannot mix — the
 * material, whether the vertex layout carries UVs (the home field's furniture
 * has none, and the untextured metal variant is a different pipeline), and
 * whether it casts. The fence keeps its own because it does not cast (see
 * `AirportSystem`). The hangars' clerestory glazing shares the tower cab's
 * casting glass draw: its shadow falls inside the wall's at every sun angle
 * but grazing, and a draw is the scarcer unit here.
 */
const GROUPS: readonly GroupSpec[] = Object.freeze([
  { key: "concrete", material: "concrete", uvs: true, casts: true },
  { key: "metal", material: "metal", uvs: true, casts: true },
  { key: "glass", material: "glass", uvs: true, casts: true },
  { key: "steel", material: "steel", uvs: true, casts: true },
  { key: "furniture", material: "metal", uvs: false, casts: true },
  { key: "fence", material: "metal", uvs: false, casts: false },
] as const);

const HANGAR_GROUP: Readonly<Record<HangarSurface, GroupKey>> = Object.freeze({
  concrete: "concrete",
  metal: "metal",
  glass: "glass",
});

interface GeometryChunk {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array | null;
  /** Relative to the chunk's own first vertex. */
  readonly indices: Uint32Array;
}

/**
 * One merged group under construction. Builders append to small plain arrays
 * (indices relative to what those arrays hold), and every build step ends with
 * `seal()`, which moves them into a typed chunk and empties them. Nothing grows
 * past one step's geometry, so no step pays for re-allocating — or the
 * collector for scavenging — a quarter-million-element array; `pack*`
 * concatenates the chunks at mesh time, one buffer per step.
 */
class GroupBuffer implements FurnitureGeometryAccumulator {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] | null;
  readonly indices: number[] = [];
  private readonly chunks: GeometryChunk[] = [];
  private vertexTotal = 0;
  private indexTotal = 0;

  constructor(withUvs: boolean) {
    this.uvs = withUvs ? [] : null;
  }

  get empty(): boolean {
    return this.indexTotal === 0 && this.indices.length === 0;
  }

  seal(): void {
    if (this.indices.length === 0) return;
    this.chunks.push({
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: this.uvs ? new Float32Array(this.uvs) : null,
      indices: new Uint32Array(this.indices),
    });
    this.vertexTotal += this.positions.length / 3;
    this.indexTotal += this.indices.length;
    this.positions.length = 0;
    this.normals.length = 0;
    if (this.uvs) this.uvs.length = 0;
    this.indices.length = 0;
  }

  packPositions(): Float32Array {
    return this.packFloats(3, (chunk) => chunk.positions);
  }

  packNormals(): Float32Array {
    return this.packFloats(3, (chunk) => chunk.normals);
  }

  packUvs(): Float32Array | null {
    return this.uvs ? this.packFloats(2, (chunk) => chunk.uvs!) : null;
  }

  /** 16-bit while the group allows it, as the home field's meshes are. */
  packIndices(): Uint16Array | Uint32Array {
    const out = this.vertexTotal < 65_536
      ? new Uint16Array(this.indexTotal)
      : new Uint32Array(this.indexTotal);
    let offset = 0;
    let base = 0;
    for (const chunk of this.chunks) {
      const source = chunk.indices;
      for (let index = 0; index < source.length; index += 1) {
        out[offset + index] = source[index]! + base;
      }
      offset += source.length;
      base += chunk.positions.length / 3;
    }
    return out;
  }

  private packFloats(stride: number, pick: (chunk: GeometryChunk) => Float32Array): Float32Array {
    const out = new Float32Array(this.vertexTotal * stride);
    let offset = 0;
    for (const chunk of this.chunks) {
      const source = pick(chunk);
      out.set(source, offset);
      offset += source.length;
    }
    return out;
  }
}

/** Ground heights for one field, filled ahead of the builders that read them. */
class GroundCache {
  private readonly heights = new Map<number, Map<number, number>>();
  private cursor = 0;
  /** Queries the fill did not anticipate (answered live). Zero by construction. */
  misses = 0;

  constructor(private readonly points: Float64Array) {}

  get complete(): boolean {
    return this.cursor * 2 >= this.points.length;
  }

  /** Sample until done or `deadline`; true once every point is cached. */
  fill(sample: (x: number, z: number) => number, now: () => number, deadline: number): boolean {
    const points = this.points;
    while (this.cursor * 2 < points.length) {
      const x = points[this.cursor * 2]!;
      const z = points[this.cursor * 2 + 1]!;
      let row = this.heights.get(x);
      if (!row) {
        row = new Map();
        this.heights.set(x, row);
      }
      if (!row.has(z)) row.set(z, sample(x, z));
      this.cursor += 1;
      if (this.cursor % GROUND_SAMPLES_PER_CHECK === 0 && now() >= deadline) break;
    }
    return this.complete;
  }

  height(x: number, z: number, live: (x: number, z: number) => number): number {
    const cached = this.heights.get(x)?.get(z);
    if (cached !== undefined) return cached;
    this.misses += 1;
    return live(x, z);
  }
}

interface FieldSites {
  readonly hangars: readonly HangarSite[];
  readonly tower: TowerSite;
  readonly obstruction: readonly LightPointFixture[];
  readonly floods: readonly ClusteredLightDefinition[];
}

interface FieldStructures {
  readonly root: TransformNode;
  readonly meshes: readonly Mesh[];
  readonly casters: readonly Mesh[];
  readonly sock: Mesh;
}

interface SpawnedField {
  readonly id: number;
  readonly airport: Readonly<AirportDefinition>;
  readonly sockPoint: { readonly x: number; readonly y: number; readonly z: number };
  /** Made by the first build step, then kept, so a rebuild re-samples nothing. */
  ground: GroundCache | null;
  lighting: AirfieldLightingSystem | null;
  /** Index of this field's first lamp among the spawned lamps. */
  lampStart: number;
  sites: FieldSites | null;
  structures: FieldStructures | null;
  /** A structure build in flight (or queued). */
  building: Generator<void, void, void> | null;
  /** Horizontal distance from the camera at the last ranking. */
  distance: number;
  disposed: boolean;
}

interface Job {
  readonly field: SpawnedField;
  readonly kind: "lamps" | "structures";
  readonly steps: Generator<void, void, void>;
}

export interface SpawnedAirfieldStatistics {
  readonly fields: number;
  readonly structureFields: number;
  readonly structureMeshes: number;
  /** Builds queued or in flight, a pending lamp re-pack counting as one. */
  readonly pendingJobs: number;
  readonly spawnedLamps: number;
  readonly floodSlots: number;
  readonly litFloodFields: number;
  readonly groundCacheMisses: number;
}

const TRANSFORMED = new Vector3();

/**
 * Append the triangles `indices[start, start + count)` of one source mesh to a
 * group, transformed by `matrix` into the field root's frame. Only the
 * vertices those triangles use are copied (a hangar group's source arrays hold
 * the WHOLE shell).
 */
function appendTransformed(
  out: GroupBuffer,
  positions: ArrayLike<number>,
  normals: ArrayLike<number>,
  uvs: ArrayLike<number> | null,
  indices: ArrayLike<number>,
  start: number,
  count: number,
  matrix: Matrix,
): void {
  const remap = new Int32Array(positions.length / 3).fill(-1);
  let next = out.positions.length / 3;
  for (let index = start; index < start + count; index += 1) {
    const vertex = indices[index]!;
    let mapped = remap[vertex]!;
    if (mapped < 0) {
      mapped = next;
      next += 1;
      remap[vertex] = mapped;
      Vector3.TransformCoordinatesFromFloatsToRef(
        positions[vertex * 3]!,
        positions[vertex * 3 + 1]!,
        positions[vertex * 3 + 2]!,
        matrix,
        TRANSFORMED,
      );
      out.positions.push(TRANSFORMED.x, TRANSFORMED.y, TRANSFORMED.z);
      Vector3.TransformNormalFromFloatsToRef(
        normals[vertex * 3]!,
        normals[vertex * 3 + 1]!,
        normals[vertex * 3 + 2]!,
        matrix,
        TRANSFORMED,
      );
      out.normals.push(TRANSFORMED.x, TRANSFORMED.y, TRANSFORMED.z);
      if (out.uvs) out.uvs.push(uvs![vertex * 2]!, uvs![vertex * 2 + 1]!);
    }
    out.indices.push(mapped);
  }
}

/** A node placement as the matrix Babylon would compose for it (`rotation.y` only). */
function placementMatrix(position: readonly [number, number, number], yawRadians: number): Matrix {
  return Matrix.Compose(
    Vector3.One(),
    Quaternion.RotationYawPitchRoll(yawRadians, 0, 0),
    new Vector3(position[0], position[1], position[2]),
  );
}

export class SpawnedAirfieldManager {
  private readonly scene: Scene;
  private readonly world: WorldDefinition;
  private readonly materials: AirfieldMaterialSet;
  private readonly seedHash: number;
  private readonly groundHeight: (x: number, z: number) => number;
  private readonly lamps: SpawnedLampSink;
  private readonly floods: SpawnedFloodSink | null;
  private readonly floodSlotNames: readonly (readonly string[])[];
  private readonly onStructuresBuilt: ((meshes: readonly Mesh[]) => void) | undefined;
  private readonly now: () => number;
  private readonly frameBudgetMs: number;
  private tier: SpawnedAirfieldTier;

  private readonly fields: SpawnedField[] = [];
  private readonly jobs: Job[] = [];
  private nextId = 1;
  private originX = 0;
  private originZ = 0;
  private daylight = 1;
  private lampsDirty = false;
  private lastRefresh = Number.NEGATIVE_INFINITY;
  private deadline = 0;
  /** One tower model serves every field (it takes no parameters); built on first need. */
  private towerGeometry: TowerGeometry | null = null;

  // Ranking products, rebuilt in place at each refresh (no per-frame allocation).
  private readonly ranked: SpawnedField[] = [];
  private readonly papiFields: SpawnedField[] = [];
  private readonly sockFields: SpawnedField[] = [];
  private readonly casterFields: SpawnedField[] = [];
  private readonly floodDesired: SpawnedField[] = [];
  private readonly slotField: (SpawnedField | null)[];
  private readonly slotIntensity: number[];
  private readonly windScratch: WindSample = { x: 0, y: 0, z: 0, speed: 0, gust: 0, turbulence: 0 };
  private readonly axisScratch = new Vector3();
  private readonly byDistance = (a: SpawnedField, b: SpawnedField): number => a.distance - b.distance;
  private disposed = false;

  constructor(options: SpawnedAirfieldOptions) {
    this.scene = options.scene;
    this.world = options.world;
    this.materials = options.materials;
    this.seedHash = options.seedHash;
    this.groundHeight = options.groundHeight;
    this.lamps = options.lamps;
    this.floods = options.floods;
    this.onStructuresBuilt = options.onStructuresBuilt;
    this.now = options.now ?? (() => performance.now());
    this.frameBudgetMs = options.frameBudgetMs ?? SPAWNED_AIRFIELD_FRAME_BUDGET_MS;
    this.tier = options.tier;
    // A slot whose lights the container refused (no clustered support) is not
    // a slot: drop it rather than "light" a name that does not exist.
    this.floodSlotNames = this.floods
      ? options.floodSlots.filter((names) => names.every((name) => this.floods!.setIntensity(name, 0)))
      : [];
    this.slotField = this.floodSlotNames.map(() => null);
    this.slotIntensity = this.floodSlotNames.map(() => 0);
  }

  /**
   * The world's airport list changed (home field first). Diffs it: a retired
   * field is disposed now (cheap), a new one is queued. Builds NOTHING.
   */
  setAirports(airports: readonly Readonly<AirportDefinition>[]): void {
    if (this.disposed) return;
    const spawned = airports.slice(1);
    for (let index = this.fields.length - 1; index >= 0; index -= 1) {
      const field = this.fields[index]!;
      if (spawned.some((airport) => sameAirport(airport, field.airport))) continue;
      this.retire(field);
      this.fields.splice(index, 1);
    }
    for (const airport of spawned) {
      if (this.fields.some((field) => sameAirport(field.airport, airport))) continue;
      const field: SpawnedField = {
        id: this.nextId,
        airport,
        sockPoint: windsockWorldPosition(airport),
        ground: null,
        lighting: null,
        lampStart: 0,
        sites: null,
        structures: null,
        building: null,
        distance: Number.POSITIVE_INFINITY,
        disposed: false,
      };
      this.nextId += 1;
      this.fields.push(field);
      if (this.tier.lamps) this.jobs.push({ field, kind: "lamps", steps: this.lampSteps(field) });
    }
    this.lampsDirty = true;
    this.lastRefresh = Number.NEGATIVE_INFINITY;
  }

  /** A tier change: re-rank now, re-cull, rebuild lamps. Built meshes are kept. */
  setTier(tier: SpawnedAirfieldTier): void {
    if (this.disposed) return;
    const previous = this.tier;
    this.tier = tier;
    if (tier.structureCullMeters !== previous.structureCullMeters) {
      for (const field of this.fields) {
        if (!field.structures) continue;
        for (const mesh of field.structures.meshes) this.applyCull(mesh);
      }
    }
    if (tier.lamps && !previous.lamps) {
      for (const field of this.fields) {
        if (!field.lighting) this.jobs.push({ field, kind: "lamps", steps: this.lampSteps(field) });
      }
    }
    this.lampsDirty = true;
    this.lastRefresh = Number.NEGATIVE_INFINITY;
  }

  setFloatingOrigin(originX: number, originZ: number): void {
    this.originX = originX;
    this.originZ = originZ;
    for (const field of this.fields) {
      if (field.structures) this.placeRoot(field.structures.root, field.airport);
    }
  }

  /** The airfield lamp law's daylight term — the same one the home floods take. */
  setDaylightAttenuation(attenuation: number): void {
    this.daylight = Number.isFinite(attenuation) ? Math.min(1, Math.max(0, attenuation)) : 1;
  }

  /**
   * Once per frame, with the camera's WORLD position. Re-ranks a few times a
   * second, runs queued construction inside the frame budget, resolves the
   * nearest fields' PAPIs and drives the floods.
   */
  update(cameraWorldX: number, cameraWorldY: number, cameraWorldZ: number): void {
    if (this.disposed) return;
    const now = this.now();
    if (now - this.lastRefresh >= SPAWNED_AIRFIELD_REFRESH_MS) {
      this.lastRefresh = now;
      this.refresh(cameraWorldX, cameraWorldZ);
    }
    this.runJobs(now);
    for (let index = 0; index < this.papiFields.length; index += 1) {
      const field = this.papiFields[index]!;
      const lighting = field.lighting;
      if (!lighting || this.lampsDirty) continue;
      if (lighting.update(cameraWorldX, cameraWorldY, cameraWorldZ)) {
        this.lamps.setExtraColors(field.lampStart, lighting.colourList());
      }
    }
    this.driveFloods();
  }

  /** Point every nearby built field's sock into the wind at the sock. */
  updateWindsocks(simulationTimeSeconds: number): void {
    if (this.disposed) return;
    for (let index = 0; index < this.sockFields.length; index += 1) {
      const field = this.sockFields[index]!;
      const structures = field.structures;
      if (!structures) continue;
      const at = field.sockPoint;
      const wind = sampleWind(
        this.world,
        at.x,
        at.y,
        at.z,
        simulationTimeSeconds,
        this.windScratch,
      );
      poseWindsock(
        structures.sock,
        field.airport.headingRadians,
        windsockHeadingRadians(wind.x, wind.z),
        wind.speed,
        this.axisScratch,
      );
    }
  }

  /** Add the casting meshes of built fields near enough to be seen, when the tier casts. */
  addShadowCasters(collect: (mesh: Mesh) => void): void {
    if (!this.tier.structuresCastShadows) return;
    for (let index = 0; index < this.casterFields.length; index += 1) {
      const structures = this.casterFields[index]!.structures;
      if (!structures) continue;
      for (const mesh of structures.casters) collect(mesh);
    }
  }

  get statistics(): SpawnedAirfieldStatistics {
    let structureFields = 0;
    let structureMeshes = 0;
    let groundCacheMisses = 0;
    for (const field of this.fields) {
      groundCacheMisses += field.ground?.misses ?? 0;
      if (!field.structures) continue;
      structureFields += 1;
      structureMeshes += field.structures.meshes.length;
    }
    let spawnedLamps = 0;
    for (const field of this.fields) {
      if (field.lighting) spawnedLamps += field.lighting.fixtures.length + this.obstructionOf(field).length;
    }
    return {
      fields: this.fields.length,
      structureFields,
      structureMeshes,
      pendingJobs: this.jobs.length + (this.lampsDirty ? 1 : 0),
      spawnedLamps: this.tier.lamps ? spawnedLamps : 0,
      floodSlots: this.floodSlotNames.length,
      litFloodFields: this.slotField.filter((field) => field !== null).length,
      groundCacheMisses,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const field of this.fields) {
      this.cancelJobs(field, null);
      this.disposeStructures(field);
    }
    this.fields.length = 0;
    this.jobs.length = 0;
  }

  // -------------------------------------------------------------------------

  private retire(field: SpawnedField): void {
    field.disposed = true;
    this.cancelJobs(field, null);
    this.disposeStructures(field);
    for (let slot = 0; slot < this.slotField.length; slot += 1) {
      if (this.slotField[slot] === field) this.assignSlot(slot, null);
    }
    this.removeFrom(this.papiFields, field);
    this.removeFrom(this.sockFields, field);
    this.removeFrom(this.casterFields, field);
    this.removeFrom(this.ranked, field);
  }

  private removeFrom(list: SpawnedField[], field: SpawnedField): void {
    const index = list.indexOf(field);
    if (index >= 0) list.splice(index, 1);
  }

  /**
   * Drop a field's queued work. `return()` runs a build's `finally`, so a build
   * abandoned between steps disposes whatever meshes it had made so far.
   */
  private cancelJobs(field: SpawnedField, kind: Job["kind"] | null): void {
    for (let index = this.jobs.length - 1; index >= 0; index -= 1) {
      const job = this.jobs[index]!;
      if (job.field !== field || (kind !== null && job.kind !== kind)) continue;
      this.jobs.splice(index, 1);
      job.steps.return(undefined);
    }
  }

  private disposeStructures(field: SpawnedField): void {
    field.building = null;
    if (!field.structures) return;
    // The root and its meshes only: the materials are the home field's.
    field.structures.root.dispose(false, false);
    field.structures = null;
  }

  private refresh(cameraWorldX: number, cameraWorldZ: number): void {
    const ranked = this.ranked;
    ranked.length = 0;
    for (const field of this.fields) {
      field.distance = Math.hypot(
        field.airport.centerX - cameraWorldX,
        field.airport.centerZ - cameraWorldZ,
      );
      ranked.push(field);
    }
    ranked.sort(this.byDistance);

    // Structures: the nearest few within the build radius, at most
    // `maxStructureFields` built or building at once.
    const tier = this.tier;
    let kept = 0;
    for (let rank = 0; rank < ranked.length; rank += 1) {
      const field = ranked[rank]!;
      const wanted = kept < tier.maxStructureFields
        && field.distance <= tier.structureBuildRadiusMeters;
      const keep = kept < tier.maxStructureFields
        && (field.structures !== null || field.building !== null)
        && field.distance <= tier.structureBuildRadiusMeters * STRUCTURE_RELEASE_FACTOR;
      if (wanted || keep) {
        kept += 1;
        if (!field.structures && !field.building) {
          const steps = this.structureSteps(field);
          field.building = steps;
          this.jobs.push({ field, kind: "structures", steps });
        }
      } else if (field.structures || field.building) {
        this.cancelJobs(field, "structures");
        this.disposeStructures(field);
      }
    }

    this.papiFields.length = 0;
    this.sockFields.length = 0;
    this.casterFields.length = 0;
    const visibleReach = tier.structureCullMeters + 2_000;
    for (let rank = 0; rank < ranked.length; rank += 1) {
      const field = ranked[rank]!;
      // Only while the tier draws spawned lamps: a field keeps its lighting
      // system across a drop to low, but its lamps leave the draw.
      if (
        tier.lamps
        && this.papiFields.length < SPAWNED_PAPI_FIELDS
        && field.lighting
        && field.distance <= SPAWNED_PAPI_RADIUS_METERS
      ) this.papiFields.push(field);
      if (field.structures && field.distance <= visibleReach) {
        this.sockFields.push(field);
        this.casterFields.push(field);
      }
    }

    // Floods: the `lit` nearest fields that have their hangars, one slot each.
    // A field keeps the slot it has, so its lights never jump between slots.
    const lit = Math.min(tier.floodFields, this.floodSlotNames.length);
    const desired = this.floodDesired;
    desired.length = 0;
    for (let rank = 0; rank < ranked.length && desired.length < lit; rank += 1) {
      const field = ranked[rank]!;
      if (field.structures && field.sites && field.distance <= visibleReach) desired.push(field);
    }
    for (let slot = 0; slot < this.slotField.length; slot += 1) {
      const field = this.slotField[slot];
      if (field && (slot >= lit || !desired.includes(field))) this.assignSlot(slot, null);
    }
    for (const field of desired) {
      if (this.slotField.includes(field)) continue;
      for (let slot = 0; slot < lit; slot += 1) {
        if (this.slotField[slot] !== null) continue;
        this.assignSlot(slot, field);
        break;
      }
    }
  }

  private assignSlot(slot: number, field: SpawnedField | null): void {
    if (this.slotField[slot] === field) return;
    this.slotField[slot] = field;
    const names = this.floodSlotNames[slot]!;
    for (let index = 0; index < names.length; index += 1) {
      const at = field?.sites?.floods[index]?.position ?? PARKED_FLOOD;
      this.floods?.setPosition(names[index]!, at[0], at[1], at[2]);
      this.floods?.setIntensity(names[index]!, 0);
    }
    this.slotIntensity[slot] = 0;
  }

  private driveFloods(): void {
    if (!this.floods) return;
    for (let slot = 0; slot < this.slotField.length; slot += 1) {
      const target = this.slotField[slot] ? HANGAR_FLOOD_INTENSITY * this.daylight : 0;
      if (target === this.slotIntensity[slot]) continue;
      this.slotIntensity[slot] = target;
      const names = this.floodSlotNames[slot]!;
      for (let index = 0; index < names.length; index += 1) {
        this.floods.setIntensity(names[index]!, target);
      }
    }
  }

  /**
   * Spend this frame's budget: lamp set-ups first (a spawned runway should
   * light before its hangars stand), then the lamp rebuild they call for, then
   * structure steps. The rebuild re-packs every lamp, home and spawned, so it
   * is the one step that is not small: it gets a frame to itself.
   *
   * A step is not started when the last one, taken as the estimate of the
   * next, would end past the deadline — so a frame overruns the budget only by
   * how much one step is dearer than the step before it.
   */
  private runJobs(now: number): void {
    if (this.jobs.length === 0 && !this.lampsDirty) return;
    this.deadline = now + this.frameBudgetMs;
    let stepped = false;
    let at = now;
    let last = 0;
    while (at + last < this.deadline) {
      const job = this.jobs[0];
      if (this.lampsDirty && job?.kind !== "lamps") {
        if (!stepped) this.rebuildLamps();
        return;
      }
      if (!job) return;
      if (job.field.disposed || job.steps.next().done) this.jobs.shift();
      stepped = true;
      const after = this.now();
      last = after - at;
      at = after;
    }
  }

  private obstructionOf(field: SpawnedField): readonly LightPointFixture[] {
    // Obstruction lamps mark buildings, so a tier that builds none shows none.
    return field.sites && this.tier.maxStructureFields > 0 ? field.sites.obstruction : [];
  }

  /** Every spawned field's lamps, in field order, into the home light-point draw. */
  private rebuildLamps(): void {
    this.lampsDirty = false;
    const fixtures: LightPointFixture[] = [];
    const colours: (readonly [number, number, number])[] = [];
    if (this.tier.lamps) {
      for (const field of this.fields) {
        if (!field.lighting) continue;
        field.lampStart = fixtures.length;
        const own = field.lighting.fixtures;
        const current = field.lighting.colourList();
        for (let index = 0; index < own.length; index += 1) {
          fixtures.push(own[index]!);
          colours.push(current[index]!);
        }
        for (const lamp of this.obstructionOf(field)) {
          fixtures.push(lamp);
          colours.push(lamp.color);
        }
      }
    }
    this.lamps.setExtraFixtures(fixtures, colours);
  }

  private *lampSteps(field: SpawnedField): Generator<void, void, void> {
    // The runway, threshold, approach, PAPI and sign lamps need nothing but
    // the airport, so a spawned runway is lit at night before its hangars
    // exist (and at medium on every field but the nearest, where they never do).
    field.lighting = new AirfieldLightingSystem(field.airport);
    this.lampsDirty = true;
    yield;
  }

  /** The whole structure build, one small step per `yield`. */
  private *structureSteps(field: SpawnedField): Generator<void, void, void> {
    const airport = field.airport;
    const live = this.groundHeight;
    if (!field.ground) {
      field.ground = new GroundCache(airfieldGroundPoints(airport));
      yield;
    }
    const cache = field.ground;
    while (!cache.fill(live, this.now, this.deadline)) yield;
    const ground = (x: number, z: number): number => cache.height(x, z, live);
    if (!this.towerGeometry) {
      this.towerGeometry = buildTowerGeometry();
      yield;
    }
    const towerGeometry = this.towerGeometry;

    if (!field.sites) {
      const hangars: HangarSite[] = [];
      for (let index = 0; index < HANGAR_SITING.count; index += 1) {
        hangars.push(hangarSite(airport, index, this.seedHash, ground));
        yield;
      }
      const tower = towerSite(airport, towerGeometry, ground);
      field.sites = {
        hangars,
        tower,
        obstruction: [
          ...towerObstructionFixtures(airport, tower.attachments),
          ...hangars.flatMap((site) => hangarObstructionFixtures(airport, site.attachments)),
        ],
        floods: hangars.flatMap((site) =>
          hangarFaceFloodlights(airport, site.attachments, site.index)),
      };
      // Its obstruction lamps join the light-point draw.
      this.lampsDirty = true;
      yield;
    }
    const sites = field.sites;

    const groups = new Map<GroupKey, GroupBuffer>();
    for (const spec of GROUPS) groups.set(spec.key, new GroupBuffer(spec.uvs));
    const group = (key: GroupKey): GroupBuffer => groups.get(key)!;
    // Ends every appending step (see `GroupBuffer`).
    const seal = (): void => {
      for (const buffer of groups.values()) buffer.seal();
    };

    // Hangars: the shell, split by surface, each hangar placed and yawed as
    // its node is on the home field.
    for (const site of sites.hangars) {
      const shell = hangarShellGeometry(site.plan);
      const matrix = placementMatrix(site.position, site.yawRadians);
      yield;
      for (const part of shell.groups) {
        appendTransformed(
          group(HANGAR_GROUP[part.surface]),
          shell.positions,
          shell.normals,
          shell.uvs,
          shell.indices,
          part.start,
          part.count,
          matrix,
        );
        seal();
        yield;
      }
    }

    // Tower: seven parts on three surfaces.
    {
      const matrix = placementMatrix(sites.tower.position, 0);
      for (const name of TOWER_PART_NAMES) {
        const part = towerGeometry.parts[name];
        appendTransformed(
          group(TOWER_PART_SURFACES[name]),
          part.positions,
          part.normals,
          part.uvs,
          part.indices,
          0,
          part.indices.length,
          matrix,
        );
      }
      seal();
      yield;
    }

    // Windsock mast and swivel are static: merged. The sock moves: its own mesh.
    const windsockAt = windsockNodePosition(airport);
    {
      const matrix = placementMatrix(windsockAt, 0);
      for (const kind of ["mast", "swivel"] as const) {
        const part = buildWindsockPart(kind, 1);
        appendTransformed(
          group("furniture"),
          part.positions,
          part.normals,
          null,
          part.indices,
          0,
          part.indices.length,
          matrix,
        );
      }
      seal();
      yield;
    }

    // Fence, fuel farm, signs: already in the root frame, on the ground they
    // stand on. The fence in slices — it is ~1,200 stations.
    const localHeight = (along: number, across: number): number => {
      const point = runwayToWorld(airport, along, across);
      return ground(point.x, point.z) - airport.elevation;
    };
    const stations = perimeterFenceStations(airport);
    for (let start = 0; start < stations.length; start += FENCE_STATIONS_PER_STEP) {
      appendPerimeterFenceStations(
        group("fence"),
        stations,
        start,
        start + FENCE_STATIONS_PER_STEP,
        localHeight,
      );
      seal();
      yield;
    }
    {
      const identity = Matrix.Identity();
      for (const geometry of [
        buildFuelFarmGeometry(localHeight),
        buildSignageGeometry(airport, localHeight),
      ]) {
        appendTransformed(
          group("furniture"),
          geometry.positions,
          geometry.normals,
          null,
          geometry.indices,
          0,
          geometry.indices.length,
          identity,
        );
      }
      seal();
      yield;
    }

    // Meshes, one per step: each uploads its buffers.
    const root = new TransformNode(`airport-spawned-${field.id}`, this.scene);
    root.rotation.y = airport.headingRadians;
    this.placeRoot(root, airport);
    const meshes: Mesh[] = [];
    const casters: Mesh[] = [];
    let complete = false;
    try {
      for (const spec of GROUPS) {
        const source = group(spec.key);
        if (source.empty) continue;
        // Packed a buffer per step: the fence alone is ~250 k floats a buffer.
        const data = new VertexData();
        data.positions = source.packPositions();
        yield;
        data.normals = source.packNormals();
        yield;
        const uvs = source.packUvs();
        if (uvs) {
          data.uvs = uvs;
          yield;
        }
        data.indices = source.packIndices();
        groups.delete(spec.key);
        yield;
        const mesh = new Mesh(`airport-spawned-${field.id}-${spec.key}`, this.scene);
        data.applyToMesh(mesh, false);
        mesh.material = this.materials[spec.material];
        mesh.parent = root;
        this.applyCull(mesh);
        meshes.push(mesh);
        if (spec.casts) casters.push(mesh);
        yield;
      }
      const sock = new Mesh(`airport-spawned-${field.id}-sock`, this.scene);
      {
        const geometry = buildWindsockPart("sock", 1);
        const data = new VertexData();
        data.positions = geometry.positions;
        data.normals = geometry.normals;
        data.indices = geometry.indices;
        data.applyToMesh(sock, false);
      }
      sock.material = this.materials.accent;
      sock.position.set(windsockAt[0], windsockAt[1] + WINDSOCK_MAST_HEIGHT_METERS, windsockAt[2]);
      sock.rotationQuaternion = Quaternion.Identity();
      sock.parent = root;
      this.applyCull(sock);
      meshes.push(sock);
      casters.push(sock);
      if (field.disposed || field.building === null) return;
      complete = true;
      field.structures = { root, meshes, casters, sock };
      field.building = null;
      this.lastRefresh = Number.NEGATIVE_INFINITY;
      this.onStructuresBuilt?.(meshes);
    } finally {
      // A build abandoned between steps (the field retired, or fell out of the
      // tier's set) leaves nothing behind.
      if (!complete) root.dispose(false, false);
    }
  }

  private placeRoot(root: TransformNode, airport: Readonly<AirportDefinition>): void {
    root.position.set(
      airport.centerX - this.originX,
      airport.elevation,
      airport.centerZ - this.originZ,
    );
  }

  private applyCull(mesh: Mesh): void {
    mesh.removeLODLevel(null);
    if (this.tier.structureCullMeters > 0) {
      mesh.addLODLevel(this.tier.structureCullMeters, null);
    }
  }
}
