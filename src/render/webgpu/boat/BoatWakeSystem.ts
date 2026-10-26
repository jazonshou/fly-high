import { Buffer } from "@babylonjs/core/Buffers/buffer";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { Material } from "@babylonjs/core/Materials/material";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import type { BoatVisualState, FlightVisualState } from "@/src/game/types";
import {
  AERIAL_PERSPECTIVE_UNIFORMS,
  AERIAL_PERSPECTIVE_WGSL,
  applyAerialPerspectiveToShaderMaterial,
  type AerialPerspectiveBinding,
} from "@/src/render/webgpu/atmosphere/AerialPerspective";
import type { AtmosphereSnapshot } from "@/src/render/webgpu/atmosphere/AtmosphereSystem";
import {
  keepOpaqueDepthForRenderingGroup,
  WATER_RENDERING_GROUP_ID,
} from "@/src/render/webgpu/core/RenderingGroups";
import {
  OCEAN_SURFACE_DISPLACEMENT_DECLARATIONS_WGSL,
  OCEAN_SURFACE_DISPLACEMENT_WGSL,
  OCEAN_SURFACE_SAMPLERS,
  OCEAN_SURFACE_UNIFORMS,
} from "@/src/render/webgpu/water/SpectralOceanSystem";
import { waterDownwellingRadiance } from "@/src/render/webgpu/water/WaterShaders";
import { SPRAY_CLOCK_PERIOD_SECONDS, sprayAge, sprayClock } from "./BoatSpraySystem";

/**
 * Boats: the wake, as ONE instanced draw of ribbon segments lying on the
 * drawn sea.
 *
 * WHAT IS DRAWN. A boat's track is kept as a ring of segments, each joining
 * two points where the transom was, with the time it was there, the speed
 * it was making and how much white water it was throwing. Every segment
 * draws three bands across the track:
 *  - **the turbulent wash** behind the propeller and hull: white near the
 *    transom, breaking into patches that fade over 20 to 40 s, and a pale
 *    bubble scar under it that outlasts the foam, widening slowly as
 *    turbulence spreads;
 *  - **two Kelvin arms**, the diverging waves' cusp lines: a point of the
 *    track the boat left `t` seconds ago at speed `v` is `v t` behind it, and
 *    the arms stand `v t tan(19.47°)` either side of it (plus the half-beam
 *    the waves start from). 19.47° is asin(1/3), Kelvin's half-angle, the
 *    same at every speed in deep water. They carry broken water while the
 *    boat makes enough speed to break its bow wave, and fade sooner than the
 *    wash.
 *
 * ON THE SEA. Every vertex is world-locked (the CPU writes world points, the
 * shader never moves them along the track) and placed on the waves by the
 * sea's own displacement (`oceanSurfaceDisplacement`, the include the ocean
 * vertex shader is built from), so the wake rides the swell it was laid on.
 *
 * PRIMED. A segment is committed when the transom has moved
 * `commitSpacing` metres or turned 4 degrees since the last one. On the
 * first frame, or after a jump (a reset, a teleport), the trail is instead
 * rebuilt backwards from the snapshot's velocity and yaw rate as the track
 * the boat would have left holding them: a capture of a boat running at
 * speed shows the wake it would have, and the same wake at any frame rate,
 * because it is a function of the one snapshot. A pose held still while it
 * reports way on (a capture holding one frame) is primed again each second.
 *
 * LIT AS THE SEA'S OWN FOAM. The foam and the scar are albedos under the
 * irradiance the ocean lights its whitecaps and surf with (`waterDownwelling`
 * through its CPU mirror `waterDownwellingRadiance`, from the same atmosphere
 * snapshot), so the wake's white is the surf's white in every light; only the
 * haze comes from the shared aerial include.
 *
 * DRAW ORDER. Group 1 (water) at alphaIndex 1.5: after the ocean and inland
 * water, before the volcanic steam and the spray. Depth-tested against the
 * opaque world and never written. The ocean writes no depth, so nothing of
 * the sea fights it.
 */

/** Ring capacity, in segments: every tier draws this many instances. */
export const WAKE_SEGMENT_CAPACITY = 512;
/** Floats per segment record: four vec4 attributes, two per end. */
export const WAKE_FLOATS_PER_SEGMENT = 16;
/** Kelvin's half-angle, degrees: asin(1/3). */
export const WAKE_KELVIN_HALF_ANGLE_DEGREES = (Math.asin(1 / 3) * 180) / Math.PI;
/** The shortest track between committed points, metres. */
export const WAKE_MIN_SPACING_METERS = 2.5;
/** A heading change that commits a point however short the track, degrees. */
export const WAKE_COMMIT_TURN_DEGREES = 4;
/** Below this speed through the water the transom lays no track. */
export const WAKE_MIN_SPEED = 0.3;
/** Height above the displaced sea the ribbon lies at, metres: above the 2.8 cm ripple relief. */
export const WAKE_LIFT_METERS = 0.04;
/** A transom farther than this from where it is expected is a jump, and the trail is primed afresh. */
export const WAKE_JUMP_METERS = 40;
/** The anchor is moved when the transom is this far from it, so records stay small for f32. */
export const WAKE_REANCHOR_METERS = 2_000;
/** White water's life in the wash, seconds: 20 s for a light wake, 40 s at full strength. */
export const WAKE_FOAM_LIFE_MIN_SECONDS = 20;
export const WAKE_FOAM_LIFE_SPAN_SECONDS = 20;

const TAN_KELVIN = Math.tan(Math.asin(1 / 3));
const COMMIT_TURN_COS = Math.cos((WAKE_COMMIT_TURN_DEGREES * Math.PI) / 180);
/** Vertices per segment: per end, five across the wash and three across each arm. */
const WAKE_VERTICES_PER_END = 11;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * How much white water the transom throws at this instant, 0..1: the wash of
 * a propeller under load and the broken water of a hull making way, more on
 * the plane and when the propeller ventilates.
 */
export function wakeFoamStrength(boat: Readonly<BoatVisualState>, engineRpm: number): number {
  const speed = Number.isFinite(boat.speedThroughWater) ? Math.max(0, boat.speedThroughWater) : 0;
  const inGear = boat.gear !== "neutral" ? 1 : 0;
  const rpm = Number.isFinite(engineRpm) ? engineRpm : 0;
  const propWash = inGear * smoothstep(900, 4_500, rpm) * clamp01(boat.propellerImmersion);
  const hull = smoothstep(1.5, 9, speed) * (0.7 + 0.3 * clamp01(boat.planing));
  const ventilation = boat.ventilating ? 0.25 : 0;
  return clamp01(Math.max(propWash * 0.8, hull) + ventilation);
}

/** How strong the bubble scar is, 0..1: what the propeller and hull stir under the surface. */
export function wakeScarStrength(boat: Readonly<BoatVisualState>, engineRpm: number): number {
  const speed = Number.isFinite(boat.speedThroughWater) ? Math.max(0, boat.speedThroughWater) : 0;
  const inGear = boat.gear !== "neutral" ? 1 : 0;
  const rpm = Number.isFinite(engineRpm) ? engineRpm : 0;
  return clamp01(Math.max(inGear * smoothstep(700, 3_000, rpm), smoothstep(0.5, 6, speed)));
}

/** What the wake reads of the boat: where its transom is, in the body frame. */
export interface BoatWakeGeometry {
  /** The transom's foot on the centreline at the waterline, body frame (+X forward, +Y up, +Z starboard). */
  readonly transom: readonly [number, number, number];
  /** Half the beam the wash and the arms start from, metres. */
  readonly halfBeam: number;
}

/** What the wake needs of the sea: its displacement, bound to the wake's material each frame. */
export interface BoatWakeOcean {
  bindSurface(material: ShaderMaterial): void;
}

export interface BoatWakeOptions {
  /** `WebGpuQualityProfile.boatWakeTrailSeconds`. */
  readonly trailSeconds: number;
  readonly geometry: BoatWakeGeometry;
  readonly seaLevel: number;
  readonly ocean: BoatWakeOcean;
}

/** One end of a segment, as the CPU keeps it. */
interface TrackPoint {
  x: number;
  z: number;
  /** Starboard, horizontal unit vector. */
  lateralX: number;
  lateralZ: number;
  /** Forward, horizontal unit vector. */
  forwardX: number;
  forwardZ: number;
  clock: number;
  speed: number;
  foam: number;
  scar: number;
}

function trackPoint(): TrackPoint {
  return { x: 0, z: 0, lateralX: 0, lateralZ: 1, forwardX: 1, forwardZ: 0, clock: 0, speed: 0, foam: 0, scar: 0 };
}

function copyPoint(from: TrackPoint, to: TrackPoint): void {
  to.x = from.x;
  to.z = from.z;
  to.lateralX = from.lateralX;
  to.lateralZ = from.lateralZ;
  to.forwardX = from.forwardX;
  to.forwardZ = from.forwardZ;
  to.clock = from.clock;
  to.speed = from.speed;
  to.foam = from.foam;
  to.scar = from.scar;
}

interface WakeGpu {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  readonly buffer: Buffer;
}

/** The system: one mesh, one material, one instanced draw. */
export class BoatWakeSystem {
  private readonly scene: Scene;
  private readonly geometry: BoatWakeGeometry;
  private readonly seaLevel: number;
  private readonly ocean: BoatWakeOcean;
  private trailSeconds: number;
  private gpu: WakeGpu | null = null;
  private readonly records = new Float32Array(WAKE_SEGMENT_CAPACITY * WAKE_FLOATS_PER_SEGMENT);
  private binding: AerialPerspectiveBinding | null = null;
  /** The ring slot the head segment (last committed point to the transom now) is written to. */
  private head = 0;
  private hasTrack = false;
  private readonly committed = trackPoint();
  private readonly live = trackPoint();
  private readonly scratch = trackPoint();
  private readonly primeNewer = trackPoint();
  private dirtyFrom = Number.POSITIVE_INFINITY;
  private dirtyTo = -1;
  private anchorX = Number.NaN;
  private anchorZ = Number.NaN;
  private originX = 0;
  private originZ = 0;
  private lastClock = 0;
  private lastLiveClock = Number.NaN;
  /** The last clock the transom laid track at speed; a trail older than that is all faded. */
  private lastMovingClock = Number.NaN;
  /** Draw once after construction so the pipeline compiles at load, as the spray does. */
  private primePending = true;
  private commits = 0;
  private readonly anchorUniform = new Vector4();
  private readonly paramsUniform = new Vector4();
  /** The sea's downwelling irradiance over pi, as its foam is lit (`setAtmosphere`). */
  private readonly downwellingUniform = new Vector3(1, 1, 1);
  private readonly aerialVectors3 = new Map<string, Vector3>();
  private readonly aerialVectors4 = new Map<string, Vector4>();
  private readonly setAerialVector3 = (name: string, x: number, y: number, z: number): void => {
    let vector = this.aerialVectors3.get(name);
    if (!vector) {
      vector = new Vector3();
      this.aerialVectors3.set(name, vector);
    }
    vector.set(x, y, z);
    this.gpu?.material.setVector3(name, vector);
  };
  private readonly setAerialVector4 = (name: string, x: number, y: number, z: number, w: number): void => {
    let vector = this.aerialVectors4.get(name);
    if (!vector) {
      vector = new Vector4();
      this.aerialVectors4.set(name, vector);
    }
    vector.set(x, y, z, w);
    this.gpu?.material.setVector4(name, vector);
  };

  constructor(scene: Scene, options: BoatWakeOptions) {
    this.scene = scene;
    this.geometry = options.geometry;
    this.seaLevel = options.seaLevel;
    this.ocean = options.ocean;
    this.trailSeconds = sanitizeTrail(options.trailSeconds);
    this.createGpu();
  }

  get mesh(): Mesh | null {
    return this.gpu?.mesh ?? null;
  }

  /** The trail in force, seconds. */
  get trail(): number {
    return this.trailSeconds;
  }

  /** Points committed since construction (a priming counts each point it lays). */
  get commitCount(): number {
    return this.commits;
  }

  /** The ring of segment records. */
  get segmentData(): Float32Array {
    return this.records;
  }

  /** The anchor the records are relative to, world metres. */
  get anchor(): { readonly x: number; readonly z: number } {
    return { x: this.anchorX, z: this.anchorZ };
  }

  /** Track spacing for the trail and speed: the ring always holds the whole trail. */
  commitSpacing(speed: number): number {
    return Math.max(WAKE_MIN_SPACING_METERS, (Math.max(0, speed) * this.trailSeconds) / (WAKE_SEGMENT_CAPACITY - 16));
  }

  /** Apply the tier's trail. A shorter trail just fades sooner; the ring is kept. */
  setTrailSeconds(trailSeconds: number): void {
    this.trailSeconds = sanitizeTrail(trailSeconds);
    this.syncParams();
  }

  /** The light the sea's foam is lit by, from the snapshot the ocean takes too. */
  setAtmosphere(atmosphere: AtmosphereSnapshot): void {
    const sun = atmosphere.sunColor.scale(atmosphere.sunIlluminanceNormalized);
    const [r, g, b] = waterDownwellingRadiance(
      [sun.r, sun.g, sun.b],
      [atmosphere.skyZenith.r, atmosphere.skyZenith.g, atmosphere.skyZenith.b],
      [atmosphere.skyHorizon.r, atmosphere.skyHorizon.g, atmosphere.skyHorizon.b],
      atmosphere.skylightIlluminanceNormalized,
      atmosphere.sunDirection.y,
      1,
    );
    this.downwellingUniform.set(r, g, b);
    this.gpu?.material.setVector3("wakeDownwelling", this.downwellingUniform);
  }

  /** The irradiance the foam is lit by, as the last `setAtmosphere` left it. */
  get downwelling(): Readonly<Vector3> {
    return this.downwellingUniform;
  }

  setAerialPerspective(binding: AerialPerspectiveBinding): void {
    this.binding = binding;
    const gpu = this.gpu;
    if (!gpu) return;
    applyAerialPerspectiveToShaderMaterial(gpu.material, binding, this.setAerialVector3, this.setAerialVector4);
  }

  setFloatingOrigin(originX: number, originZ: number): void {
    this.originX = originX;
    this.originZ = originZ;
    this.syncAnchor();
  }

  /** After the ocean's own update: hand the wake this frame's displacement. */
  bindOcean(): void {
    const gpu = this.gpu;
    if (!gpu || !gpu.mesh.isEnabled(false)) return;
    this.ocean.bindSurface(gpu.material);
  }

  /** Whether the mesh will be submitted this frame. */
  get drawing(): boolean {
    return this.gpu?.mesh.isEnabled(false) ?? false;
  }

  /** Per-frame update from the latest snapshot. Allocation-free. */
  update(state: FlightVisualState): void {
    const gpu = this.gpu;
    if (!gpu) return;
    const time = Number.isFinite(state.simulationTime) ? state.simulationTime : 0;
    const clock = sprayClock(time);
    this.lastClock = clock;
    const boat = state.vehicle?.kind === "boat" ? state.vehicle : null;
    if (boat && !state.crashed && !boat.capsized) {
      this.transomPoint(state, boat, clock, this.live);
      this.ensureAnchor(this.live.x, this.live.z);
      const elapsed = Number.isNaN(this.lastLiveClock) ? Number.NaN : sprayAge(clock, this.lastLiveClock);
      const moved = Math.hypot(this.live.x - this.committed.x, this.live.z - this.committed.z);
      const jumped = !this.hasTrack
        || Number.isNaN(elapsed)
        || elapsed > 2
        || moved > WAKE_JUMP_METERS + this.commitSpacing(this.live.speed) + this.live.speed * elapsed;
      // A pose held still while it reports way on (a capture's fixed frame,
      // a replay scrubbed in place) would age its trail out: lay it afresh.
      const sinceCommit = sprayAge(clock, this.committed.clock);
      const held = this.live.speed >= WAKE_MIN_SPEED && sinceCommit > 1 && moved < 0.1 * this.live.speed * sinceCommit;
      if (jumped || held) this.prime(state, clock);
      else this.advance();
      this.lastLiveClock = clock;
    } else {
      this.lastLiveClock = Number.NaN;
    }
    this.syncParams();
    this.flush(gpu);
    const alive = !Number.isNaN(this.lastMovingClock) && sprayAge(clock, this.lastMovingClock) <= this.trailSeconds + 1;
    const draw = this.primePending || alive;
    this.primePending = false;
    if (gpu.mesh.isEnabled(false) !== draw) gpu.mesh.setEnabled(draw);
  }

  dispose(): void {
    const gpu = this.gpu;
    if (!gpu) return;
    this.gpu = null;
    gpu.mesh.dispose(false, false);
    gpu.material.dispose();
    gpu.buffer.dispose();
  }

  /** The transom's foot, world xz, and the boat's state there, into `out`. */
  private transomPoint(state: FlightVisualState, boat: Readonly<BoatVisualState>, clock: number, out: TrackPoint): void {
    const q = state.orientation;
    const [tx, ty, tz] = this.geometry.transom;
    // Body to world: v' = v + 2 w (q x v) + 2 q x (q x v), for the transom and the bow.
    const rotate = (x: number, y: number, z: number, axis: 0 | 2): number => {
      const cx = 2 * (q.y * z - q.z * y);
      const cy = 2 * (q.z * x - q.x * z);
      const cz = 2 * (q.x * y - q.y * x);
      return axis === 0 ? x + q.w * cx + (q.y * cz - q.z * cy) : z + q.w * cz + (q.x * cy - q.y * cx);
    };
    out.x = state.position.x + rotate(tx, ty, tz, 0);
    out.z = state.position.z + rotate(tx, ty, tz, 2);
    let fx = rotate(1, 0, 0, 0);
    let fz = rotate(1, 0, 0, 2);
    const length = Math.hypot(fx, fz);
    if (length > 1e-6) {
      fx /= length;
      fz /= length;
    } else {
      fx = 1;
      fz = 0;
    }
    out.forwardX = fx;
    out.forwardZ = fz;
    // Starboard is forward x up: (fx, 0, fz) x (0, 1, 0) = (-fz, 0, fx).
    out.lateralX = -fz;
    out.lateralZ = fx;
    out.clock = clock;
    out.speed = Number.isFinite(boat.speedThroughWater) ? Math.max(0, boat.speedThroughWater) : 0;
    out.foam = wakeFoamStrength(boat, state.engineRpm);
    out.scar = wakeScarStrength(boat, state.engineRpm);
  }

  /** Lay track up to the transom: commit a point when it is far or turned enough, then redraw the head. */
  private advance(): void {
    const live = this.live;
    const committed = this.committed;
    if (live.speed < WAKE_MIN_SPEED) {
      // Lying still: the track restarts here, so a boat that sets off later
      // does not join its new wake to where it stopped.
      if (sprayAge(live.clock, committed.clock) > this.trailSeconds) copyPoint(live, committed);
      this.writeSegment(this.head, committed, committed);
      return;
    }
    this.lastMovingClock = live.clock;
    const moved = Math.hypot(live.x - committed.x, live.z - committed.z);
    const turned = live.forwardX * committed.forwardX + live.forwardZ * committed.forwardZ < COMMIT_TURN_COS;
    if (moved >= this.commitSpacing(live.speed) || (turned && moved > 0.5)) {
      this.writeSegment(this.head, committed, live);
      this.head = (this.head + 1) % WAKE_SEGMENT_CAPACITY;
      copyPoint(live, committed);
      this.commits += 1;
    }
    this.writeSegment(this.head, committed, live);
  }

  /**
   * Rebuild the trail backwards from the snapshot: the track the transom left
   * holding this velocity and yaw rate for the whole trail, segment by
   * segment at the commit spacing, the newest last.
   */
  private prime(state: FlightVisualState, clock: number): void {
    this.records.fill(0);
    this.markDirty(0, WAKE_SEGMENT_CAPACITY - 1);
    this.head = 0;
    this.hasTrack = true;
    const live = this.live;
    const speed = live.speed;
    copyPoint(live, this.committed);
    if (speed < WAKE_MIN_SPEED) {
      this.writeSegment(this.head, live, live);
      return;
    }
    this.lastMovingClock = clock;
    // Body yaw rate: positive about body +Y swings the bow to port.
    const yawRate = Number.isFinite(state.angularVelocity.y) ? state.angularVelocity.y : 0;
    const spacing = this.commitSpacing(speed);
    const step = spacing / speed;
    const count = Math.min(WAKE_SEGMENT_CAPACITY - 2, Math.ceil((this.trailSeconds + 1) / step));
    // Walk back from the transom: `t` seconds ago the bow pointed `yawRate t`
    // to starboard of now. The oldest segment goes in slot 0 and the newest
    // in slot count - 1, so the head follows it.
    const older = this.scratch;
    const newer = this.primeNewer;
    copyPoint(live, newer);
    for (let back = 1; back <= count; back += 1) {
      const t = back * step;
      const angle = yawRate * t;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      // R_y(-yaw t) applied to the current forward: a +Y rotation by a maps +X toward -Z.
      const fx = live.forwardX * c - live.forwardZ * s;
      const fz = live.forwardX * s + live.forwardZ * c;
      // Mid-step heading, so an arc is followed rather than its chord's tangent.
      const midAngle = yawRate * (t - step / 2);
      const mx = live.forwardX * Math.cos(midAngle) - live.forwardZ * Math.sin(midAngle);
      const mz = live.forwardX * Math.sin(midAngle) + live.forwardZ * Math.cos(midAngle);
      older.x = newer.x - mx * spacing;
      older.z = newer.z - mz * spacing;
      older.forwardX = fx;
      older.forwardZ = fz;
      older.lateralX = -fz;
      older.lateralZ = fx;
      older.clock = sprayClock(clock - t + SPRAY_CLOCK_PERIOD_SECONDS);
      older.speed = speed;
      older.foam = live.foam;
      older.scar = live.scar;
      // Oldest at slot 0 upward: slot (count - back) joins older to newer.
      this.writeSegment(count - back, older, newer);
      copyPoint(older, newer);
      this.commits += 1;
    }
    this.head = count;
    this.writeSegment(this.head, this.committed, live);
  }

  private writeSegment(slot: number, older: TrackPoint, newer: TrackPoint): void {
    const records = this.records;
    const at = slot * WAKE_FLOATS_PER_SEGMENT;
    records[at] = older.x - this.anchorX;
    records[at + 1] = older.z - this.anchorZ;
    records[at + 2] = older.lateralX;
    records[at + 3] = older.lateralZ;
    records[at + 4] = older.clock;
    records[at + 5] = older.speed;
    records[at + 6] = older.foam;
    records[at + 7] = older.scar;
    records[at + 8] = newer.x - this.anchorX;
    records[at + 9] = newer.z - this.anchorZ;
    records[at + 10] = newer.lateralX;
    records[at + 11] = newer.lateralZ;
    records[at + 12] = newer.clock;
    records[at + 13] = newer.speed;
    records[at + 14] = newer.foam;
    records[at + 15] = newer.scar;
    this.markDirty(slot, slot);
  }

  private markDirty(from: number, to: number): void {
    this.dirtyFrom = Math.min(this.dirtyFrom, from);
    this.dirtyTo = Math.max(this.dirtyTo, to);
  }

  private flush(gpu: WakeGpu): void {
    if (this.dirtyTo < this.dirtyFrom) return;
    const from = this.dirtyFrom;
    const to = this.dirtyTo;
    this.dirtyFrom = Number.POSITIVE_INFINITY;
    this.dirtyTo = -1;
    // Usually one or two adjacent slots: the head and the segment it closed.
    gpu.buffer.updateDirectly(
      this.records.subarray(from * WAKE_FLOATS_PER_SEGMENT, (to + 1) * WAKE_FLOATS_PER_SEGMENT),
      from * WAKE_FLOATS_PER_SEGMENT,
      to - from + 1,
    );
  }

  /**
   * Anchor the records near the transom. Moving it rewrites every record
   * relative to the new anchor, which happens once per 2 km of track.
   */
  private ensureAnchor(x: number, z: number): void {
    if (!Number.isNaN(this.anchorX) && Math.abs(x - this.anchorX) < WAKE_REANCHOR_METERS && Math.abs(z - this.anchorZ) < WAKE_REANCHOR_METERS) return;
    const nextX = Math.round(x);
    const nextZ = Math.round(z);
    if (!Number.isNaN(this.anchorX)) {
      const dx = this.anchorX - nextX;
      const dz = this.anchorZ - nextZ;
      const records = this.records;
      for (let slot = 0; slot < WAKE_SEGMENT_CAPACITY; slot += 1) {
        const at = slot * WAKE_FLOATS_PER_SEGMENT;
        if (records[at + 4] === 0 && records[at + 12] === 0 && records[at + 5] === 0) continue;
        records[at] = records[at]! + dx;
        records[at + 1] = records[at + 1]! + dz;
        records[at + 8] = records[at + 8]! + dx;
        records[at + 9] = records[at + 9]! + dz;
      }
      this.markDirty(0, WAKE_SEGMENT_CAPACITY - 1);
    }
    this.anchorX = nextX;
    this.anchorZ = nextZ;
    this.syncAnchor();
  }

  private syncAnchor(): void {
    const anchorX = Number.isNaN(this.anchorX) ? 0 : this.anchorX;
    const anchorZ = Number.isNaN(this.anchorZ) ? 0 : this.anchorZ;
    this.anchorUniform.set(anchorX - this.originX, anchorZ - this.originZ, anchorX, anchorZ);
    this.gpu?.material.setVector4("wakeAnchor", this.anchorUniform);
  }

  private syncParams(): void {
    this.paramsUniform.set(this.lastClock, this.trailSeconds, this.geometry.halfBeam, this.seaLevel);
    this.gpu?.material.setVector4("wakeParams", this.paramsUniform);
  }

  private createGpu(): void {
    const scene = this.scene;
    ShaderStore.ShadersStoreWGSL[`${WAKE_SHADER_NAME}VertexShader`] = BOAT_WAKE_VERTEX_WGSL;
    ShaderStore.ShadersStoreWGSL[`${WAKE_SHADER_NAME}PixelShader`] = BOAT_WAKE_FRAGMENT_WGSL;
    keepOpaqueDepthForRenderingGroup(scene, WATER_RENDERING_GROUP_ID);

    const mesh = new Mesh("boat-wake", scene);
    const template = wakeSegmentTemplate();
    template.applyToMesh(mesh, false);

    const buffer = new Buffer(scene.getEngine(), this.records, true, WAKE_FLOATS_PER_SEGMENT, false, true);
    mesh.setVerticesBuffer(buffer.createVertexBuffer("wakeOlderA", 0, 4));
    mesh.setVerticesBuffer(buffer.createVertexBuffer("wakeOlderB", 4, 4));
    mesh.setVerticesBuffer(buffer.createVertexBuffer("wakeNewerA", 8, 4));
    mesh.setVerticesBuffer(buffer.createVertexBuffer("wakeNewerB", 12, 4));
    mesh.forcedInstanceCount = WAKE_SEGMENT_CAPACITY;
    mesh.renderingGroupId = WATER_RENDERING_GROUP_ID;
    mesh.alphaIndex = 1.5;
    mesh.isPickable = false;
    mesh.applyFog = false;
    mesh.receiveShadows = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;

    const material = new ShaderMaterial(
      "boat-wake-material",
      scene,
      WAKE_SHADER_NAME,
      {
        attributes: ["position", "wakeOlderA", "wakeOlderB", "wakeNewerA", "wakeNewerB"],
        uniforms: [
          "viewProjection",
          "cameraPosition",
          "wakeAnchor",
          "wakeParams",
          "wakeDownwelling",
          ...OCEAN_SURFACE_UNIFORMS,
          ...AERIAL_PERSPECTIVE_UNIFORMS,
        ],
        samplers: [...OCEAN_SURFACE_SAMPLERS],
        shaderLanguage: ShaderLanguage.WGSL,
        needAlphaBlending: true,
      },
    );
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    material.transparencyMode = Material.MATERIAL_ALPHABLEND;
    material.alphaMode = Constants.ALPHA_PREMULTIPLIED_PORTERDUFF;
    mesh.material = material;
    mesh.setEnabled(false);

    this.gpu = { mesh, material, buffer };
    this.syncAnchor();
    this.syncParams();
    material.setVector3("wakeDownwelling", this.downwellingUniform);
    if (this.binding) this.setAerialPerspective(this.binding);
  }
}

function sanitizeTrail(trailSeconds: number): number {
  return Number.isFinite(trailSeconds) ? Math.min(120, Math.max(1, trailSeconds)) : 24;
}

/**
 * One segment's vertices: position = (band, across, end). Band 0 is the
 * wash (five across, -1..1), -1 and +1 the port and starboard arms (three
 * across each). End 0 is the segment's older point, 1 its newer.
 */
export function wakeSegmentTemplate(): VertexData {
  const positions: number[] = [];
  for (let end = 0; end < 2; end += 1) {
    for (const across of [-1, -0.5, 0, 0.5, 1]) positions.push(0, across, end);
    for (const band of [-1, 1]) {
      for (const across of [-1, 0, 1]) positions.push(band, across, end);
    }
  }
  const indices: number[] = [];
  const quad = (a: number, b: number): void => {
    // a, b on the older end; the same columns on the newer end.
    const c = b + WAKE_VERTICES_PER_END;
    const d = a + WAKE_VERTICES_PER_END;
    indices.push(a, b, c, a, c, d);
  };
  for (let column = 0; column < 4; column += 1) quad(column, column + 1);
  for (const first of [5, 8]) {
    quad(first, first + 1);
    quad(first + 1, first + 2);
  }
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  return data;
}

function wgslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

const WAKE_SHADER_NAME = "boatWake";

/** Thick fresh foam, Whitlock's 0.5, as the ocean's surf (`WATER_SURF_FOAM_ALBEDO`). */
export const WAKE_FOAM_ALBEDO = 0.5;
/** The bubble scar: water lightened turquoise by the bubbles under it, as an albedo. */
export const WAKE_SCAR_ALBEDO = Object.freeze([0.05, 0.13, 0.14] as const);
/** The scar's opacity at full strength: it tints the sea, it does not hide it. */
export const WAKE_SCAR_OPACITY = 0.42;

export const BOAT_WAKE_VERTEX_WGSL = /* wgsl */ `
attribute position: vec3f;
attribute wakeOlderA: vec4f;
attribute wakeOlderB: vec4f;
attribute wakeNewerA: vec4f;
attribute wakeNewerB: vec4f;

// x across the band (-1..1), y band (-1 port arm, 0 wash, 1 starboard arm)
varying wakeAcross: vec2f;
// absolute world xz, for the world-locked break-up
varying wakeWorld: vec2f;
// x foam coverage, y scar strength, z overall fade, w age s
varying wakeAmount: vec4f;
varying wakeFoamColor: vec3f;
varying wakeScarColor: vec3f;
// haze: x transmittance (luminance), for the premultiplied in-scatter below
varying wakeInScatter: vec3f;
varying wakeTransmittance: vec3f;

uniform viewProjection: mat4x4f;
uniform cameraPosition: vec3f;
// xy anchor minus floating origin (render space), zw anchor (world)
uniform wakeAnchor: vec4f;
// x clock s (wrapped), y trail s, z half-beam m, w sea level m
uniform wakeParams: vec4f;
// the sea's downwelling irradiance over pi (waterDownwelling, sun and sky)
uniform wakeDownwelling: vec3f;

${OCEAN_SURFACE_DISPLACEMENT_DECLARATIONS_WGSL}

${AERIAL_PERSPECTIVE_WGSL}

${OCEAN_SURFACE_DISPLACEMENT_WGSL}

const WAKE_PERIOD: f32 = ${wgslFloat(SPRAY_CLOCK_PERIOD_SECONDS)};
const WAKE_TAN_KELVIN: f32 = ${TAN_KELVIN.toFixed(7)};
const WAKE_LIFT: f32 = ${wgslFloat(WAKE_LIFT_METERS)};
const WAKE_FOAM_LIFE_MIN: f32 = ${wgslFloat(WAKE_FOAM_LIFE_MIN_SECONDS)};
const WAKE_FOAM_LIFE_SPAN: f32 = ${wgslFloat(WAKE_FOAM_LIFE_SPAN_SECONDS)};
const WAKE_FOAM_ALBEDO: f32 = ${wgslFloat(WAKE_FOAM_ALBEDO)};
const WAKE_SCAR_ALBEDO: vec3f = vec3f(${WAKE_SCAR_ALBEDO.map(wgslFloat).join(", ")});

fn wakeAge(birth: f32) -> f32 {
  let age = uniforms.wakeParams.x - birth;
  return select(age, age + WAKE_PERIOD, age < 0.0);
}

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let band = vertexInputs.position.x;
  let across = vertexInputs.position.y;
  let newerEnd = vertexInputs.position.z > 0.5;
  let point = select(vertexInputs.wakeOlderA, vertexInputs.wakeNewerA, newerEnd);
  let state = select(vertexInputs.wakeOlderB, vertexInputs.wakeNewerB, newerEnd);
  let trail = uniforms.wakeParams.y;
  let halfBeam = uniforms.wakeParams.z;

  // The segment is drawn only while its OLDER end is inside the trail, and
  // only if anything was laid there: decided per segment, so every vertex of
  // a dead segment collapses together and it rasterises nothing.
  let olderAge = wakeAge(vertexInputs.wakeOlderB.x);
  let laid = vertexInputs.wakeOlderB.y + vertexInputs.wakeNewerB.y > 0.0;
  let segmentLive = laid && olderAge < trail;

  let age = wakeAge(state.x);
  let speed = state.y;
  // How far behind the boat this point now is, as if it held its speed.
  let behind = speed * age;
  var offset: f32;
  var foam: f32;
  var scar = 0.0;
  let foamLife = WAKE_FOAM_LIFE_MIN + WAKE_FOAM_LIFE_SPAN * state.z;
  if (band == 0.0) {
    // The wash: as wide as the prop wash at the transom, spreading slowly.
    let halfWidth = halfBeam * (0.72 + 0.2 * sqrt(behind));
    offset = across * halfWidth;
    // Solid white at the transom, broken up within seconds, then lace that lasts.
    foam = state.z * (0.7 * exp(-age / 2.5) + 0.3 * (1.0 - smoothstep(0.0, foamLife, age)));
    scar = state.w * (1.0 - smoothstep(0.35 * trail, trail, age));
  } else {
    // A Kelvin arm: its cusp line at 19.47 degrees, softening as it spreads.
    let armOffset = halfBeam + behind * WAKE_TAN_KELVIN;
    let armHalf = 0.3 + 0.012 * behind;
    offset = band * (armOffset + across * armHalf);
    // The arms are waves: broken water on their crest line near the boat
    // only, gone in seconds.
    foam = smoothstep(4.0, 14.0, speed) * 0.5 * exp(-age / 4.0);
  }
  let fade = 1.0 - smoothstep(0.75 * trail, trail, age);

  let local = point.xy + point.zw * offset;
  let worldXZ = uniforms.wakeAnchor.zw + local;
  let displacement = oceanSurfaceDisplacement(worldXZ);
  let height = uniforms.wakeParams.w + displacement.y + WAKE_LIFT;
  let renderPosition = vec3f(
    uniforms.wakeAnchor.x + local.x + displacement.x,
    height,
    uniforms.wakeAnchor.y + local.y + displacement.z,
  );
  var clip = uniforms.viewProjection * vec4f(renderPosition, 1.0);
  clip = select(vec4f(0.0, 0.0, 2.0, 1.0), clip, segmentLive);

  // Lit as the sea lights its own foam (litFoamColor under waterDownwelling).
  let sunDirection = normalize(uniforms.aerialSunDirection);
  let downwelling = uniforms.wakeDownwelling;
  let toPoint = renderPosition - uniforms.cameraPosition;
  let distanceMeters = max(length(toPoint), 0.001);
  let haze = aerialPerspective(height, distanceMeters, dot(toPoint / distanceMeters, sunDirection));

  vertexOutputs.position = clip;
  vertexOutputs.wakeAcross = vec2f(across, band);
  vertexOutputs.wakeWorld = worldXZ;
  vertexOutputs.wakeAmount = vec4f(foam * fade, scar * fade, fade, age);
  vertexOutputs.wakeFoamColor = WAKE_FOAM_ALBEDO * downwelling;
  vertexOutputs.wakeScarColor = WAKE_SCAR_ALBEDO * downwelling;
  vertexOutputs.wakeInScatter = haze.inScatter;
  vertexOutputs.wakeTransmittance = haze.transmittance;
}
`;

export const BOAT_WAKE_FRAGMENT_WGSL = /* wgsl */ `
varying wakeAcross: vec2f;
varying wakeWorld: vec2f;
varying wakeAmount: vec4f;
varying wakeFoamColor: vec3f;
varying wakeScarColor: vec3f;
varying wakeInScatter: vec3f;
varying wakeTransmittance: vec3f;

const WAKE_SCAR_OPACITY: f32 = ${wgslFloat(WAKE_SCAR_OPACITY)};

fn wakeHash(cell: vec2i) -> f32 {
  var h = (bitcast<u32>(cell.x) * 0x8da6b343u) ^ (bitcast<u32>(cell.y) * 0xd8163841u);
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  h = h ^ (h >> 16u);
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

fn wakeValueNoise(p: vec2f) -> f32 {
  let cell = floor(p);
  let f = p - cell;
  let w = f * f * (vec2f(3.0) - 2.0 * f);
  let i = vec2i(cell);
  let bottom = mix(wakeHash(i), wakeHash(i + vec2i(1, 0)), w.x);
  let top = mix(wakeHash(i + vec2i(0, 1)), wakeHash(i + vec2i(1, 1)), w.x);
  return mix(bottom, top, w.y);
}

// Lace: three octaves, warped so it curls instead of sitting on a lattice,
// the finest faded out where a pixel covers it (it would only shimmer).
fn wakeLace(p: vec2f, footprint: f32) -> f32 {
  let warp = vec2f(
    wakeValueNoise(p * 0.3 + vec2f(3.1, 7.7)),
    wakeValueNoise(p * 0.3 + vec2f(11.3, 1.9)),
  ) - vec2f(0.5);
  let w = p + warp * 3.0;
  let q = vec2f(w.x * 0.8 - w.y * 0.6, w.x * 0.6 + w.y * 0.8);
  let fine = mix(wakeValueNoise(w * 4.6 + vec2f(2.9, 13.4)), 0.5, smoothstep(0.08, 0.22, footprint));
  return 0.5 * wakeValueNoise(w * 0.7) + 0.3 * wakeValueNoise(q * 1.9 + vec2f(17.3, 5.1)) + 0.2 * fine;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  // Before any branch: derivatives need every pixel of the quad.
  let footprint = length(fwidth(fragmentInputs.wakeWorld));
  let across = fragmentInputs.wakeAcross.x;
  let band = fragmentInputs.wakeAcross.y;
  // The wash is fullest on the track and feathers to its edges; an arm is a
  // narrow line of broken water.
  let edge = 1.0 - across * across;
  let profile = select(edge * edge, sqrt(max(edge, 0.0)), abs(band) < 0.5);
  // World-locked, so foam that is laid stays where it was laid.
  let lace = wakeLace(fragmentInputs.wakeWorld, footprint);
  let coverage = clamp(fragmentInputs.wakeAmount.x * profile, 0.0, 1.0);
  // Full coverage is solid foam; as it thins, only the lace's ridges stay,
  // crisp at the edge and thin (the sea showing through) just inside it.
  let threshold = mix(0.74, 0.2, coverage);
  let sharpness = 0.04 + 0.25 * min(footprint, 0.4);
  let body = smoothstep(threshold, threshold + 0.18, lace);
  let foamAlpha = smoothstep(threshold, threshold + sharpness, lace) * mix(0.5, 1.0, body)
    * smoothstep(0.0, 0.08, coverage);
  let scarAlpha = clamp(fragmentInputs.wakeAmount.y * profile, 0.0, 1.0) * WAKE_SCAR_OPACITY;
  let alpha = foamAlpha + scarAlpha * (1.0 - foamAlpha);
  if (alpha < 0.002) { discard; }
  let surface = (fragmentInputs.wakeFoamColor * foamAlpha
    + fragmentInputs.wakeScarColor * scarAlpha * (1.0 - foamAlpha)) / alpha;
  let hazed = surface * fragmentInputs.wakeTransmittance + fragmentInputs.wakeInScatter;
  fragmentOutputs.color = vec4f(max(hazed, vec3f(0.0)) * alpha, alpha);
}
`;
