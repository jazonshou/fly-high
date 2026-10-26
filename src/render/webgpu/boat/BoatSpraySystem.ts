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
import { MAX_BOAT_SPRAY_ROOTS, type BoatVisualState, type FlightVisualState } from "@/src/game/types";
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
  WATER_SKY_IRRADIANCE_FRACTION,
  WATER_SUN_IRRADIANCE_SCALE,
} from "@/src/render/webgpu/water/WaterShaders";
import { hashLatticeCoordinates, unitFloatFromHash } from "@/src/world/seed";

/**
 * Boats: the spray a planing hull throws, as ONE instanced draw of
 * camera-facing droplet sprites, and no draw at all while nothing is in the
 * air.
 *
 * WHERE IT COMES FROM. Three sources, each where the real one is:
 *  - **Sheets** from the spray roots the strip model reports
 *    (`BoatVisualState.sprayRoots`): where each strip's wetted chine meets the
 *    surface, thrown at that strip's jet speed. A hard turn loads the outer
 *    chine and the bow sheets come from there.
 *  - **The rooster tail** behind the propeller once the hull is on the plane,
 *    taller as the engine is trimmed out.
 *  - **Prop mist** when the propeller ventilates and throws air and water.
 *
 * WHERE THE WORK IS. A droplet is a closed-form function of its own record
 * and the clock, evaluated in the vertex shader: ballistic flight under
 * gravity with linear drag relaxing it to the wind, growth as the sheet
 * breaks into mist, and a fade. The CPU writes a record once, when the
 * droplet is born, into a ring of `cap` records, and uploads only the chunks
 * it wrote. The per-frame cost is the emission and those chunk uploads; no
 * allocation.
 *
 * DETERMINISTIC. Droplets are born on a fixed 120 Hz lattice of the
 * simulation clock; every random draw, the rounding of each tick's births
 * included, is a hash of (tick, source, droplet), so a pinned capture sees
 * the same spray at any frame rate.
 *
 * LIGHTING is the sea's own light (`setAtmosphere`): the sun and sky the
 * ocean lights its foam with (`waterDownwelling`), from the same snapshot.
 * A clump of droplets is white water in the air, so it takes that light as
 * an albedo, as the wake's foam does, but it hangs in the air, so the sun
 * lights the side of it that faces the sun (a Lambert sphere's phase law,
 * translucent enough that its shaded side is never black) instead of
 * lighting a level surface by the sun's elevation. On top of that, the
 * droplets' forward lobe: spray between the camera and the sun glows.
 * Hazed by `aerialPerspective`.
 *
 * HELD. Droplets fly in the world, so a hull held still while its velocity
 * says it planes (a pinned capture) would throw its spray forward of the
 * bow. Held long enough (`SPRAY_HELD_SECONDS`), the spray is drawn in the
 * hull's frame instead: the same physics, Galilean-shifted by the hull's
 * velocity, which is exactly what the moving boat shows a camera that rides
 * with it.
 *
 * DRAW ORDER. Group 1 (water) at alphaIndex 2.5: after the ocean, inland
 * water and the wake, and after volcanic steam. Depth-tested against the
 * opaque world (the hull hides the spray behind it) and never written.
 */

/** Floats per droplet record: three vec4 attributes. */
export const SPRAY_FLOATS_PER_DROPLET = 12;
/** The largest cap any tier may ask for (pinned by test against the profiles). */
export const SPRAY_INSTANCE_CAPACITY = 4_096;
/** Droplets per upload chunk: the ring is uploaded in whole chunks it wrote. */
export const SPRAY_CHUNK_DROPLETS = 64;
/** The emission lattice, Hz. */
export const SPRAY_EMISSION_HZ = 120;
/** At most this many lattice ticks are emitted in one frame (a hitch drops the rest). */
export const SPRAY_MAX_TICKS_PER_FRAME = 24;
/** The shader clock wraps at this period; lifetimes are far shorter. */
export const SPRAY_CLOCK_PERIOD_SECONDS = 960;
/** The longest any droplet lives; past it with nothing new born, the mesh is disabled. */
export const SPRAY_MAX_LIFETIME_SECONDS = 2.4;
/** The anchor is moved when the boat is this far from it, so records stay small for f32. */
export const SPRAY_REANCHOR_METERS = 2_000;
/**
 * A hull that moves over the ground less than this fraction of what its own
 * velocity says, for `SPRAY_HELD_SECONDS` running, is being HELD: a pinned
 * capture photographs a planing boat that never moves. Its spray is then
 * thrown in the hull's own frame (every velocity, the wind's included, less
 * the hull's), which is the same flight seen from a camera riding along.
 */
export const SPRAY_HELD_FRACTION = 0.1;
export const SPRAY_HELD_SECONDS = 0.5;
/** Standard gravity, m/s². */
const GRAVITY = 9.81;

/** Below this the vertex collapses the sprite, so an invisible droplet rasterises nothing. */
const SPRAY_MIN_VISIBLE_ALPHA = 0.003;

/** Hash channels for the three sources (any distinct integers). */
const SOURCE_SHEET = 0;
const SOURCE_ROOSTER = 64;
const SOURCE_MIST = 65;
/** The hash lane that rounds a tick's fractional births. */
const BIRTH_LANE = 7;

/**
 * How the droplet budget is shared: the steady-state live count of each
 * source at full intensity is this fraction of the cap. They sum below 1 so a
 * hard turn on the plane with a ventilating prop still fits the ring without
 * overwriting droplets still in the air.
 */
export const SPRAY_BUDGET_SHARES = Object.freeze({ sheet: 0.62, rooster: 0.26, mist: 0.1 });

/** Mean lifetimes, seconds: rates are budget / lifetime. */
const SHEET_LIFETIME = { min: 0.8, span: 0.8 };
const ROOSTER_LIFETIME = { min: 1.1, span: 1.0 };
const MIST_LIFETIME = { min: 0.6, span: 0.6 };

/** A sheet root emits nothing below this jet speed, m/s, and full rate from it plus `SHEET_JET_SPAN`. */
export const SHEET_JET_THRESHOLD = 3;
export const SHEET_JET_SPAN = 12;
/** The rooster tail rises once the hull is this far on the plane, and above this speed, m/s. */
export const ROOSTER_PLANING_THRESHOLD = 0.55;
export const ROOSTER_SPEED_THRESHOLD = 9;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** The shader clock: simulation time wrapped to the period, never negative. */
export function sprayClock(simulationTimeSeconds: number): number {
  if (!Number.isFinite(simulationTimeSeconds)) return 0;
  const wrapped = simulationTimeSeconds % SPRAY_CLOCK_PERIOD_SECONDS;
  return wrapped < 0 ? wrapped + SPRAY_CLOCK_PERIOD_SECONDS : wrapped;
}

/** A droplet's age at `clock`, through the wrap. */
export function sprayAge(clock: number, birthClock: number): number {
  const age = clock - birthClock;
  return age < 0 ? age + SPRAY_CLOCK_PERIOD_SECONDS : age;
}

/** One uniform draw in [0, 1) per (tick, source, droplet, lane). */
function unit(tick: number, source: number, droplet: number, lane: number): number {
  return unitFloatFromHash(
    hashLatticeCoordinates(hashLatticeCoordinates(0x5b0a7_5b, tick, source), droplet, lane),
  );
}

/**
 * A tick's whole births from a fractional expectation, rounded by a hash of
 * the tick and source rather than carried between ticks, so the count is a
 * function of the tick alone and a capture is the same at any frame rate.
 */
function births(expected: number, tick: number, source: number): number {
  if (!(expected > 0)) return 0;
  return Math.floor(expected + unit(tick, source, 0, BIRTH_LANE));
}

export interface SprayDropletSample {
  x: number;
  y: number;
  z: number;
  age: number;
  life: number;
  sizeMeters: number;
  alpha: number;
}

export function createSprayDropletSample(): SprayDropletSample {
  return { x: 0, y: 0, z: 0, age: 0, life: 0, sizeMeters: 0, alpha: 0 };
}

/**
 * The vertex shader's flight and fade law, line for line, for tests and
 * reasoning. The WGSL below is the authority; this mirrors its expression.
 * Positions are anchor-relative.
 *
 * Linear drag towards the wind with gravity: dv/dt = -k (v - w) + g gives
 * p(t) = p0 + v0 r + (w + g/k)(t - r), r = (1 - e^(-k t)) / k.
 */
export function sampleSprayDroplet(
  records: Float32Array,
  droplet: number,
  clock: number,
  windX: number,
  windZ: number,
  out: SprayDropletSample,
): SprayDropletSample {
  const at = droplet * SPRAY_FLOATS_PER_DROPLET;
  const age = sprayAge(clock, records[at + 3]!);
  const life = records[at + 7]!;
  const k = Math.max(records[at + 10]!, 0.05);
  const relax = (1 - Math.exp(-k * age)) / k;
  const after = age - relax;
  out.x = records[at]! + records[at + 4]! * relax + windX * after;
  out.y = records[at + 1]! + records[at + 5]! * relax - (GRAVITY / k) * after;
  out.z = records[at + 2]! + records[at + 6]! * relax + windZ * after;
  out.age = age;
  out.life = life;
  const u = life > 0 ? age / life : 1;
  out.sizeMeters = records[at + 8]! * (0.55 + 1.6 * u);
  const below = smoothstep(-0.35, 0.05, out.y - records[at + 1]!);
  out.alpha = u >= 1 || life <= 0
    ? 0
    : records[at + 11]! * smoothstep(0, 0.08, u) * (1 - smoothstep(0.55, 1, u)) * below;
  return out;
}

/** What the emitter reads besides the snapshot: where the drawn propeller is. */
export interface BoatSprayGeometry {
  /** The propeller hub, body frame (+X forward, +Y up, +Z starboard, metres from the CG), engine trimmed in. */
  readonly propellerHub: readonly [number, number, number];
  /** The engine's tilt pivot, body frame: the hub swings about it with `trimAngle`. */
  readonly tiltPivot: readonly [number, number, number];
}

/** A body-frame vector rotated into world by the snapshot's quaternion, written to `out`. */
function rotateBodyToWorld(
  q: FlightVisualState["orientation"],
  x: number,
  y: number,
  z: number,
  out: { x: number; y: number; z: number },
): void {
  // v' = v + 2 w (q x v) + 2 q x (q x v)
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  out.x = x + q.w * tx + (q.y * tz - q.z * ty);
  out.y = y + q.w * ty + (q.z * tx - q.x * tz);
  out.z = z + q.w * tz + (q.x * ty - q.y * tx);
}

interface SprayGpu {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  readonly buffer: Buffer;
  /** One view per upload chunk, made once. */
  readonly chunkViews: readonly Float32Array[];
}

export interface BoatSprayOptions {
  /** `WebGpuQualityProfile.boatSprayParticleCap`. */
  readonly cap: number;
  readonly geometry: BoatSprayGeometry;
  /** Surface wind the droplets relax to, world m/s along x and z. */
  readonly windX?: number;
  readonly windZ?: number;
}

/** The system: one mesh, one material, one instanced draw, or nothing. */
export class BoatSpraySystem {
  private readonly scene: Scene;
  private readonly geometry: BoatSprayGeometry;
  private readonly windX: number;
  private readonly windZ: number;
  private cap = 0;
  private gpu: SprayGpu | null = null;
  private records: Float32Array | null = null;
  private binding: AerialPerspectiveBinding | null = null;
  /** Ring write cursor, in droplets. */
  private cursor = 0;
  /** The last lattice tick emitted, or NaN before the first frame. */
  private lastTick = Number.NaN;
  /** Clock of the most recent birth; past it by the longest life, nothing is alive. */
  private lastBirthClock = Number.NaN;
  private lastClock = 0;
  private readonly dirtyChunks: Uint8Array;
  private anchorX = Number.NaN;
  private anchorZ = Number.NaN;
  private originX = 0;
  private originZ = 0;
  private births = 0;
  private primePending = false;
  private holdX = Number.NaN;
  private holdZ = Number.NaN;
  private holdTime = Number.NaN;
  private heldSeconds = 0;
  /** The horizontal velocity the spray is drawn relative to: zero, or a held hull's own. */
  private readonly frame = { x: 0, z: 0 };
  private readonly anchorUniform = new Vector3();
  private readonly windUniform = new Vector4();
  /** The sun's irradiance at normal incidence over pi, and the sky's on a level surface over pi. */
  private readonly sunUniform = new Vector3(1, 1, 1);
  private readonly skyUniform = new Vector3(0.3, 0.3, 0.3);
  private readonly scratch = { x: 0, y: 0, z: 0 };
  private readonly scratchVelocity = { x: 0, y: 0, z: 0 };
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
  private readonly setAerialVector4 = (
    name: string,
    x: number,
    y: number,
    z: number,
    w: number,
  ): void => {
    let vector = this.aerialVectors4.get(name);
    if (!vector) {
      vector = new Vector4();
      this.aerialVectors4.set(name, vector);
    }
    vector.set(x, y, z, w);
    this.gpu?.material.setVector4(name, vector);
  };

  constructor(scene: Scene, options: BoatSprayOptions) {
    this.scene = scene;
    this.geometry = options.geometry;
    this.windX = Number.isFinite(options.windX) ? options.windX! : 0;
    this.windZ = Number.isFinite(options.windZ) ? options.windZ! : 0;
    this.dirtyChunks = new Uint8Array(SPRAY_INSTANCE_CAPACITY / SPRAY_CHUNK_DROPLETS);
    this.setCap(options.cap);
  }

  /** The cap in force. */
  get capacity(): number {
    return this.cap;
  }

  /** Whether the mesh will be submitted this frame. */
  get drawing(): boolean {
    return this.gpu?.mesh.isEnabled(false) ?? false;
  }

  /** Droplets born since construction. */
  get birthCount(): number {
    return this.births;
  }

  /** The ring of records (`capacity` droplets). Null without GPU resources. */
  get instanceData(): Float32Array | null {
    return this.records;
  }

  /** The velocity the droplets are drawn relative to: zero, or a held hull's own. */
  get referenceVelocity(): { readonly x: number; readonly z: number } {
    return { x: this.frame.x, z: this.frame.z };
  }

  /** The anchor the records are relative to, world metres. */
  get anchor(): { readonly x: number; readonly z: number } {
    return { x: this.anchorX, z: this.anchorZ };
  }

  get mesh(): Mesh | null {
    return this.gpu?.mesh ?? null;
  }

  /** Droplets whose age is inside their life at the last update's clock. */
  liveCount(): number {
    const records = this.records;
    if (!records) return 0;
    let live = 0;
    for (let droplet = 0; droplet < this.cap; droplet += 1) {
      const at = droplet * SPRAY_FLOATS_PER_DROPLET;
      const life = records[at + 7]!;
      if (life > 0 && sprayAge(this.lastClock, records[at + 3]!) < life) live += 1;
    }
    return live;
  }

  /**
   * Apply the tier's cap. The ring is rebuilt at the new size (the droplets in
   * the air are dropped: a tier change is rare and a second of spray is not
   * worth carrying across it). 0 disposes every GPU resource.
   */
  setCap(cap: number): void {
    const next = Number.isFinite(cap)
      ? Math.max(0, Math.min(SPRAY_INSTANCE_CAPACITY, Math.floor(cap / SPRAY_CHUNK_DROPLETS) * SPRAY_CHUNK_DROPLETS))
      : 0;
    if (next === this.cap && (next === 0) === (this.gpu === null)) return;
    this.disposeGpu();
    this.cap = next;
    this.cursor = 0;
    this.lastBirthClock = Number.NaN;
    if (next > 0) this.createGpu();
  }

  /**
   * The light the spray is lit by, from the snapshot the ocean takes too: the
   * two halves of `waterDownwellingRadiance`, the sun's before it is laid on
   * a level surface (`sunDirection.y`), so that the sun term times the sun's
   * elevation sine plus the sky term is exactly the sea's own downwelling.
   */
  setAtmosphere(atmosphere: AtmosphereSnapshot): void {
    const sun = atmosphere.sunIlluminanceNormalized * WATER_SUN_IRRADIANCE_SCALE;
    this.sunUniform.set(atmosphere.sunColor.r * sun, atmosphere.sunColor.g * sun, atmosphere.sunColor.b * sun);
    const sky = 0.5 * WATER_SKY_IRRADIANCE_FRACTION * atmosphere.skylightIlluminanceNormalized;
    this.skyUniform.set(
      (atmosphere.skyZenith.r + atmosphere.skyHorizon.r) * sky,
      (atmosphere.skyZenith.g + atmosphere.skyHorizon.g) * sky,
      (atmosphere.skyZenith.b + atmosphere.skyHorizon.b) * sky,
    );
    this.gpu?.material.setVector3("spraySun", this.sunUniform);
    this.gpu?.material.setVector3("spraySky", this.skyUniform);
  }

  /** The sun and sky the spray is lit by, as the last `setAtmosphere` left them. */
  get lighting(): { readonly sun: Readonly<Vector3>; readonly sky: Readonly<Vector3> } {
    return { sun: this.sunUniform, sky: this.skyUniform };
  }

  setAerialPerspective(binding: AerialPerspectiveBinding): void {
    this.binding = binding;
    const gpu = this.gpu;
    if (!gpu) return;
    applyAerialPerspectiveToShaderMaterial(
      gpu.material,
      binding,
      this.setAerialVector3,
      this.setAerialVector4,
    );
  }

  setFloatingOrigin(originX: number, originZ: number): void {
    this.originX = originX;
    this.originZ = originZ;
    this.syncAnchorUniform();
  }

  /**
   * Per-frame update from the latest snapshot. Allocation-free. Emits every
   * lattice tick since the last frame (at most `SPRAY_MAX_TICKS_PER_FRAME`),
   * placing each droplet at the hull as it was at that tick by running the
   * snapshot's velocity back from `state.simulationTime`.
   */
  update(state: FlightVisualState): void {
    const gpu = this.gpu;
    const records = this.records;
    if (!gpu || !records) return;
    const time = Number.isFinite(state.simulationTime) ? state.simulationTime : 0;
    const clock = sprayClock(time);
    this.lastClock = clock;
    this.trackHold(state, time);
    this.windUniform.set(this.windX - this.frame.x, this.windZ - this.frame.z, 0, clock);

    const boat = state.vehicle?.kind === "boat" ? state.vehicle : null;
    // The epsilon keeps a frame landing exactly on a tick from flooring below it.
    const tick = Math.floor(time * SPRAY_EMISSION_HZ + 1e-6);
    if (Number.isNaN(this.lastTick) || tick < this.lastTick || tick - this.lastTick > 4 * SPRAY_EMISSION_HZ) {
      // First frame, a reset to an earlier time, or a long jump: start the
      // lattice here rather than replaying seconds of spray in one frame.
      this.lastTick = tick - 1;
    }
    if (boat && !state.crashed) {
      this.ensureAnchor(state.position.x, state.position.z);
      const first = Math.max(this.lastTick + 1, tick - SPRAY_MAX_TICKS_PER_FRAME + 1);
      for (let at = first; at <= tick; at += 1) this.emitTick(state, boat, at, time);
    }
    this.lastTick = tick;
    this.flushChunks(gpu);

    const alive = !Number.isNaN(this.lastBirthClock)
      && sprayAge(clock, this.lastBirthClock) <= SPRAY_MAX_LIFETIME_SECONDS;
    const draw = this.primePending || alive;
    this.primePending = false;
    if (gpu.mesh.isEnabled(false) !== draw) gpu.mesh.setEnabled(draw);
  }

  dispose(): void {
    this.disposeGpu();
    this.cap = 0;
  }

  /** Whether the hull is being held still (`SPRAY_HELD_FRACTION`), and the frame that follows from it. */
  private trackHold(state: FlightVisualState, time: number): void {
    const elapsed = time - this.holdTime;
    if (elapsed > 0 && elapsed < 1) {
      const expected = Math.hypot(state.velocity.x, state.velocity.z) * elapsed;
      const moved = Math.hypot(state.position.x - this.holdX, state.position.z - this.holdZ);
      this.heldSeconds = expected > 0.005 && moved < SPRAY_HELD_FRACTION * expected ? this.heldSeconds + elapsed : 0;
    } else if (elapsed !== 0) {
      // The first frame, a jump, or time run backwards: start counting again.
      this.heldSeconds = 0;
    }
    this.holdX = state.position.x;
    this.holdZ = state.position.z;
    this.holdTime = time;
    const held = this.heldSeconds >= SPRAY_HELD_SECONDS;
    this.frame.x = held ? state.velocity.x : 0;
    this.frame.z = held ? state.velocity.z : 0;
  }

  private ensureAnchor(worldX: number, worldZ: number): void {
    if (!Number.isNaN(this.anchorX)
      && Math.abs(worldX - this.anchorX) < SPRAY_REANCHOR_METERS
      && Math.abs(worldZ - this.anchorZ) < SPRAY_REANCHOR_METERS) return;
    const records = this.records!;
    if (!Number.isNaN(this.anchorX)) {
      // Carry the droplets in the air across: rare (every 2 km of travel),
      // and a whole-ring rewrite is a few thousand adds.
      const dx = this.anchorX - worldX;
      const dz = this.anchorZ - worldZ;
      for (let droplet = 0; droplet < this.cap; droplet += 1) {
        const at = droplet * SPRAY_FLOATS_PER_DROPLET;
        records[at] = records[at]! + dx;
        records[at + 2] = records[at + 2]! + dz;
      }
      this.dirtyChunks.fill(1, 0, this.cap / SPRAY_CHUNK_DROPLETS);
    }
    this.anchorX = worldX;
    this.anchorZ = worldZ;
    this.syncAnchorUniform();
  }

  private syncAnchorUniform(): void {
    if (Number.isNaN(this.anchorX)) return;
    this.anchorUniform.set(this.anchorX - this.originX, 0, this.anchorZ - this.originZ);
  }

  /** Every source's births for one lattice tick. */
  private emitTick(state: FlightVisualState, boat: BoatVisualState, tick: number, time: number): void {
    const dt = 1 / SPRAY_EMISSION_HZ;
    // The tick's instant, behind or at the snapshot: run the hull back to it.
    const back = Math.min(0, tick * dt - time);
    const tickClock = sprayClock(tick * dt);
    const capScale = this.cap;
    const speed = Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z);

    // Sheets: the cap's sheet share, spread over the roots by jet intensity.
    const roots = Math.min(boat.sprayRootCount | 0, boat.sprayRoots.length >> 2, MAX_BOAT_SPRAY_ROOTS);
    let total = 0;
    for (let root = 0; root < roots; root += 1) {
      total += clamp01((boat.sprayRoots[root * 4 + 3]! - SHEET_JET_THRESHOLD) / SHEET_JET_SPAN);
    }
    const sheetRate = (SPRAY_BUDGET_SHARES.sheet * capScale) / (SHEET_LIFETIME.min + SHEET_LIFETIME.span / 2);
    const perIntensity = total > 0 ? sheetRate / Math.max(total, 4) : 0;
    for (let root = 0; root < roots; root += 1) {
      const jet = boat.sprayRoots[root * 4 + 3]!;
      const intensity = clamp01((jet - SHEET_JET_THRESHOLD) / SHEET_JET_SPAN);
      const born = births(perIntensity * intensity * dt, tick, SOURCE_SHEET + root);
      for (let index = 0; index < born; index += 1) {
        this.birthSheet(state, boat, root, jet, tick, index, back, tickClock);
      }
    }

    // The rooster tail: on the plane and moving, taller when trimmed out.
    const plane = smoothstep(ROOSTER_PLANING_THRESHOLD, 1, boat.planing)
      * smoothstep(ROOSTER_SPEED_THRESHOLD, ROOSTER_SPEED_THRESHOLD + 6, speed)
      * clamp01(boat.propellerImmersion * 1.4);
    const roosterRate = (SPRAY_BUDGET_SHARES.rooster * capScale) / (ROOSTER_LIFETIME.min + ROOSTER_LIFETIME.span / 2);
    const rooster = births(roosterRate * plane * dt, tick, SOURCE_ROOSTER);
    for (let index = 0; index < rooster; index += 1) {
      this.birthStern(state, boat, SOURCE_ROOSTER, tick, index, back, tickClock, speed);
    }

    // Prop mist: a ventilating propeller throws aerated water.
    const mist = boat.ventilating ? clamp01(0.35 + boat.lever * boat.lever) : 0;
    const mistRate = (SPRAY_BUDGET_SHARES.mist * capScale) / (MIST_LIFETIME.min + MIST_LIFETIME.span / 2);
    const misted = births(mistRate * mist * dt, tick, SOURCE_MIST);
    for (let index = 0; index < misted; index += 1) {
      this.birthStern(state, boat, SOURCE_MIST, tick, index, back, tickClock, speed);
    }
  }

  /** A droplet from a chine root: outboard, up and a little aft, at the jet's speed. */
  private birthSheet(
    state: FlightVisualState,
    boat: BoatVisualState,
    root: number,
    jet: number,
    tick: number,
    index: number,
    back: number,
    tickClock: number,
  ): void {
    const source = SOURCE_SHEET + root;
    const bx = boat.sprayRoots[root * 4]!;
    const by = boat.sprayRoots[root * 4 + 1]!;
    const bz = boat.sprayRoots[root * 4 + 2]!;
    const side = bz < 0 ? -1 : 1;
    const r0 = unit(tick, source, index, 0);
    const r1 = unit(tick, source, index, 1);
    const r2 = unit(tick, source, index, 2);
    const r3 = unit(tick, source, index, 3);
    const r4 = unit(tick, source, index, 4);
    // The sheet leaves the chine across the flow: mostly outboard and up,
    // fanned by the draws so it reads as a sheet and not a jet.
    const ax = -0.25 + 0.35 * (r0 - 0.5);
    const ay = 0.45 + 0.35 * r1;
    const az = side * (0.85 - 0.2 * r1);
    const norm = 1 / Math.hypot(ax, ay, az);
    const throwSpeed = jet * (0.4 + 0.3 * r2);
    rotateBodyToWorld(state.orientation, ax * norm * throwSpeed, ay * norm * throwSpeed, az * norm * throwSpeed, this.scratchVelocity);
    // Water leaving the hull keeps part of the hull's own motion.
    const carry = 0.55 + 0.2 * r3;
    this.scratchVelocity.x += state.velocity.x * carry - this.frame.x;
    this.scratchVelocity.y += state.velocity.y * carry;
    this.scratchVelocity.z += state.velocity.z * carry - this.frame.z;
    rotateBodyToWorld(state.orientation, bx, by, bz, this.scratch);
    this.write(
      state.position.x + this.scratch.x + (state.velocity.x - this.frame.x) * back,
      state.position.y + this.scratch.y + state.velocity.y * back,
      state.position.z + this.scratch.z + (state.velocity.z - this.frame.z) * back,
      tickClock,
      SHEET_LIFETIME.min + SHEET_LIFETIME.span * r4,
      0.22 + 0.3 * r0,
      r3,
      1.1 + 0.8 * r2,
      0.34 + 0.26 * intensityOf(jet),
    );
  }

  /** A droplet from behind the propeller: the rooster tail, or ventilation mist. */
  private birthStern(
    state: FlightVisualState,
    boat: BoatVisualState,
    source: number,
    tick: number,
    index: number,
    back: number,
    tickClock: number,
    speed: number,
  ): void {
    const r0 = unit(tick, source, index, 0);
    const r1 = unit(tick, source, index, 1);
    const r2 = unit(tick, source, index, 2);
    const r3 = unit(tick, source, index, 3);
    const r4 = unit(tick, source, index, 4);
    // The hub, swung about the tilt pivot by the trim.
    const [hx, hy, hz] = this.geometry.propellerHub;
    const [px, py] = this.geometry.tiltPivot;
    const tilt = Number.isFinite(boat.trimAngle) ? boat.trimAngle : 0;
    const c = Math.cos(tilt);
    const s = Math.sin(tilt);
    const dx = hx - px;
    const dy = hy - py;
    // Trimming out swings the lower unit aft and up: a rotation about +Z.
    const bx = px + dx * c + dy * s;
    const by = py - dx * s + dy * c;
    const rooster = source === SOURCE_ROOSTER;
    const lean = 0.1 * (r0 - 0.5);
    // The rooster tail climbs steeply aft, more steeply trimmed out; mist bursts wide.
    const ax = rooster ? -0.55 : -0.6 + 0.4 * (r0 - 0.5);
    const ay = rooster ? 0.8 + 0.4 * Math.max(0, tilt) / 0.28 : 0.35 + 0.4 * r1;
    const az = rooster ? lean : 1.2 * (r1 - 0.5);
    const norm = 1 / Math.hypot(ax, ay, az);
    const throwSpeed = rooster
      ? speed * (0.22 + 0.12 * r2)
      : 2.5 + 3 * r2;
    rotateBodyToWorld(state.orientation, ax * norm * throwSpeed, ay * norm * throwSpeed, az * norm * throwSpeed, this.scratchVelocity);
    const carry = rooster ? 0.62 : 0.8;
    this.scratchVelocity.x += state.velocity.x * carry - this.frame.x;
    this.scratchVelocity.y += state.velocity.y * carry;
    this.scratchVelocity.z += state.velocity.z * carry - this.frame.z;
    rotateBodyToWorld(state.orientation, bx - 0.3, by, hz, this.scratch);
    const life = rooster ? ROOSTER_LIFETIME : MIST_LIFETIME;
    this.write(
      state.position.x + this.scratch.x + (state.velocity.x - this.frame.x) * back,
      state.position.y + this.scratch.y + state.velocity.y * back,
      state.position.z + this.scratch.z + (state.velocity.z - this.frame.z) * back,
      tickClock,
      life.min + life.span * r4,
      rooster ? 0.3 + 0.35 * r3 : 0.2 + 0.25 * r3,
      r2,
      rooster ? 0.9 + 0.5 * r1 : 2.2 + r1,
      rooster ? 0.3 : 0.26,
    );
  }

  /** One record into the ring at the cursor. */
  private write(
    worldX: number,
    worldY: number,
    worldZ: number,
    birthClock: number,
    lifetime: number,
    size: number,
    seed: number,
    drag: number,
    opacity: number,
  ): void {
    const records = this.records!;
    const at = this.cursor * SPRAY_FLOATS_PER_DROPLET;
    records[at] = worldX - this.anchorX;
    records[at + 1] = worldY;
    records[at + 2] = worldZ - this.anchorZ;
    records[at + 3] = birthClock;
    records[at + 4] = this.scratchVelocity.x;
    records[at + 5] = this.scratchVelocity.y;
    records[at + 6] = this.scratchVelocity.z;
    records[at + 7] = lifetime;
    records[at + 8] = size;
    records[at + 9] = seed;
    records[at + 10] = drag;
    records[at + 11] = opacity;
    this.dirtyChunks[Math.floor(this.cursor / SPRAY_CHUNK_DROPLETS)] = 1;
    this.cursor = (this.cursor + 1) % this.cap;
    this.lastBirthClock = birthClock;
    this.births += 1;
  }

  private flushChunks(gpu: SprayGpu): void {
    const chunks = this.cap / SPRAY_CHUNK_DROPLETS;
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      if (this.dirtyChunks[chunk] === 0) continue;
      this.dirtyChunks[chunk] = 0;
      gpu.buffer.updateDirectly(gpu.chunkViews[chunk]!, chunk * SPRAY_CHUNK_DROPLETS * SPRAY_FLOATS_PER_DROPLET, SPRAY_CHUNK_DROPLETS);
    }
  }

  private createGpu(): void {
    const scene = this.scene;
    ShaderStore.ShadersStoreWGSL[`${SPRAY_SHADER_NAME}VertexShader`] = BOAT_SPRAY_VERTEX_WGSL;
    ShaderStore.ShadersStoreWGSL[`${SPRAY_SHADER_NAME}PixelShader`] = BOAT_SPRAY_FRAGMENT_WGSL;
    keepOpaqueDepthForRenderingGroup(scene, WATER_RENDERING_GROUP_ID);

    const mesh = new Mesh("boat-spray", scene);
    const quad = new VertexData();
    quad.positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
    quad.indices = [0, 2, 1, 0, 3, 2];
    quad.applyToMesh(mesh, false);

    // Zero-filled: a zero lifetime is a dead droplet, collapsed in the vertex
    // stage, so the whole ring draws and only live records rasterise.
    const records = new Float32Array(this.cap * SPRAY_FLOATS_PER_DROPLET);
    const buffer = new Buffer(scene.getEngine(), records, true, SPRAY_FLOATS_PER_DROPLET, false, true);
    mesh.setVerticesBuffer(buffer.createVertexBuffer("sprayA", 0, 4));
    mesh.setVerticesBuffer(buffer.createVertexBuffer("sprayB", 4, 4));
    mesh.setVerticesBuffer(buffer.createVertexBuffer("sprayC", 8, 4));
    const chunkViews: Float32Array[] = [];
    for (let chunk = 0; chunk < this.cap / SPRAY_CHUNK_DROPLETS; chunk += 1) {
      const start = chunk * SPRAY_CHUNK_DROPLETS * SPRAY_FLOATS_PER_DROPLET;
      chunkViews.push(records.subarray(start, start + SPRAY_CHUNK_DROPLETS * SPRAY_FLOATS_PER_DROPLET));
    }
    mesh.forcedInstanceCount = this.cap;
    mesh.renderingGroupId = WATER_RENDERING_GROUP_ID;
    mesh.alphaIndex = 2.5;
    mesh.isPickable = false;
    mesh.applyFog = false;
    mesh.receiveShadows = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;

    const material = new ShaderMaterial(
      "boat-spray-material",
      scene,
      SPRAY_SHADER_NAME,
      {
        attributes: ["position", "sprayA", "sprayB", "sprayC"],
        uniforms: [
          "view",
          "projection",
          "cameraPosition",
          "sprayAnchor",
          "sprayWind",
          "spraySun",
          "spraySky",
          ...AERIAL_PERSPECTIVE_UNIFORMS,
        ],
        shaderLanguage: ShaderLanguage.WGSL,
        needAlphaBlending: true,
      },
    );
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    material.transparencyMode = Material.MATERIAL_ALPHABLEND;
    material.alphaMode = Constants.ALPHA_PREMULTIPLIED_PORTERDUFF;
    material.setVector3("sprayAnchor", this.anchorUniform);
    material.setVector4("sprayWind", this.windUniform);
    material.setVector3("spraySun", this.sunUniform);
    material.setVector3("spraySky", this.skyUniform);
    mesh.material = material;
    mesh.setEnabled(false);

    this.gpu = { mesh, material, buffer, chunkViews };
    this.records = records;
    this.primePending = true;
    if (this.binding) this.setAerialPerspective(this.binding);
  }

  private disposeGpu(): void {
    const gpu = this.gpu;
    if (!gpu) return;
    this.gpu = null;
    this.records = null;
    gpu.mesh.dispose(false, false);
    gpu.material.dispose();
    gpu.buffer.dispose();
  }
}

function intensityOf(jet: number): number {
  return clamp01((jet - SHEET_JET_THRESHOLD) / SHEET_JET_SPAN);
}

function wgslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

const SPRAY_SHADER_NAME = "boatSpray";

/** A clump of spray as white water: a little below the wake's fresh foam (0.5) seen face on. */
export const SPRAY_ALBEDO = 0.62;
/** How much sun the side of a clump turned away from it still passes (it is translucent). */
export const SPRAY_TRANSLUCENCY = 0.35;
/** The droplets' forward lobe (large drops, Mie), and how much of the sun it carries. */
export const SPRAY_FORWARD_G = 0.72;
export const SPRAY_GLOW = 0.12;

export const BOAT_SPRAY_VERTEX_WGSL = /* wgsl */ `
attribute position: vec3f;
attribute sprayA: vec4f;
attribute sprayB: vec4f;
attribute sprayC: vec4f;

varying sprayCorner: vec2f;
varying sprayColor: vec3f;
// x alpha, y seed, z age fraction
varying sprayFade: vec3f;

uniform view: mat4x4f;
uniform projection: mat4x4f;
uniform cameraPosition: vec3f;
// Anchor minus floating origin; the records' x and z are relative to it.
uniform sprayAnchor: vec3f;
// xy surface wind, world m/s along x and z; w clock s (wrapped)
uniform sprayWind: vec4f;
// the sun's irradiance at normal incidence over pi; the sky's on a level surface over pi
uniform spraySun: vec3f;
uniform spraySky: vec3f;

${AERIAL_PERSPECTIVE_WGSL}

const SPRAY_PERIOD: f32 = ${wgslFloat(SPRAY_CLOCK_PERIOD_SECONDS)};
const SPRAY_GRAVITY: f32 = ${wgslFloat(GRAVITY)};
const SPRAY_PI: f32 = 3.14159265359;
const SPRAY_ALBEDO: f32 = ${wgslFloat(SPRAY_ALBEDO)};
const SPRAY_TRANSLUCENCY: f32 = ${wgslFloat(SPRAY_TRANSLUCENCY)};
const SPRAY_FORWARD_G: f32 = ${wgslFloat(SPRAY_FORWARD_G)};
const SPRAY_GLOW: f32 = ${wgslFloat(SPRAY_GLOW)};

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let recordA = vertexInputs.sprayA;
  let recordB = vertexInputs.sprayB;
  let recordC = vertexInputs.sprayC;

  // sampleSprayDroplet is this block's CPU twin; change both or neither.
  var age = uniforms.sprayWind.w - recordA.w;
  age = select(age, age + SPRAY_PERIOD, age < 0.0);
  let life = recordB.w;
  let u = select(1.0, age / max(life, 0.0001), life > 0.0);
  let k = max(recordC.z, 0.05);
  let decay = exp(-k * age);
  let relax = (1.0 - decay) / k;
  let after = age - relax;
  let wind = vec3f(uniforms.sprayWind.x, 0.0, uniforms.sprayWind.y);
  let local = recordA.xyz + recordB.xyz * relax + wind * after
    - vec3f(0.0, SPRAY_GRAVITY / k, 0.0) * after;
  let centre = uniforms.sprayAnchor + local;
  let velocity = (recordB.xyz - wind + vec3f(0.0, SPRAY_GRAVITY / k, 0.0)) * decay
    + wind - vec3f(0.0, SPRAY_GRAVITY / k, 0.0);
  let size = recordC.x * (0.55 + 1.6 * u);

  let toCentre = centre - uniforms.cameraPosition;
  let distanceMeters = max(length(toCentre), 0.001);
  // A droplet about to hit the lens fades before it fills the screen.
  let nearFade = smoothstep(size * 0.8, size * 3.0, distanceMeters);
  // Back into the sea: gone once it falls below the surface it left.
  let below = smoothstep(-0.35, 0.05, local.y - recordA.y);
  let lifeFade = smoothstep(0.0, 0.08, u) * (1.0 - smoothstep(0.55, 1.0, u));
  let alpha = select(recordC.w * lifeFade * below * nearFade, 0.0, u >= 1.0 || life <= 0.0);

  // Camera-facing, stretched along the droplet's own motion on screen while
  // it is young and fast: a sheet reads as streaks, mist as puffs.
  let corner = vertexInputs.position.xy;
  let viewVelocity = (uniforms.view * vec4f(velocity, 0.0)).xy;
  let speedOnScreen = length(viewVelocity);
  let axis = select(vec2f(0.0, 1.0), viewVelocity / max(speedOnScreen, 1e-4), speedOnScreen > 1e-4);
  let stretch = min(speedOnScreen * 0.05, 1.6) * (1.0 - u);
  let square = corner * size;
  let offset = square + axis * (dot(square, axis) * stretch);
  let viewCentre = uniforms.view * vec4f(centre, 1.0);
  var clip = uniforms.projection * (viewCentre + vec4f(offset, 0.0, 0.0));
  clip = select(clip, vec4f(0.0, 0.0, 2.0, 1.0), alpha < ${SPRAY_MIN_VISIBLE_ALPHA});

  // White water in the sea's light (see the header): the sunlit fraction of
  // the clump seen at phase angle acos(-mu), translucent, plus the sky, plus
  // the forward glow of spray seen against the sun. Nothing of the sun once
  // it is below the horizon.
  let rayDirection = toCentre / distanceMeters;
  let sunDirection = normalize(uniforms.aerialSunDirection);
  let mu = dot(rayDirection, sunDirection);
  let sun = uniforms.spraySun * smoothstep(-0.02, 0.02, sunDirection.y);
  let phaseAngle = acos(clamp(-mu, -1.0, 1.0));
  let sunlit = (sin(phaseAngle) + (SPRAY_PI - phaseAngle) * cos(phaseAngle)) / SPRAY_PI;
  let lit = SPRAY_TRANSLUCENCY + (1.0 - SPRAY_TRANSLUCENCY) * sunlit;
  let glow = SPRAY_GLOW * 4.0 * SPRAY_PI * aerialMiePhase(mu, SPRAY_FORWARD_G);
  let radiance = SPRAY_ALBEDO * (sun * lit + uniforms.spraySky) + sun * glow;
  let haze = aerialPerspective(centre.y, distanceMeters, mu);

  vertexOutputs.position = clip;
  vertexOutputs.sprayCorner = corner;
  vertexOutputs.sprayColor = radiance * haze.transmittance + haze.inScatter;
  vertexOutputs.sprayFade = vec3f(alpha, recordC.y, u);
}
`;

export const BOAT_SPRAY_FRAGMENT_WGSL = /* wgsl */ `
varying sprayCorner: vec2f;
varying sprayColor: vec3f;
varying sprayFade: vec3f;

fn sprayHash(cell: vec2i) -> f32 {
  var h = (bitcast<u32>(cell.x) * 0x8da6b343u) ^ (bitcast<u32>(cell.y) * 0xd8163841u);
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  h = h ^ (h >> 16u);
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

fn sprayValueNoise(p: vec2f) -> f32 {
  let cell = floor(p);
  let f = p - cell;
  let w = f * f * (vec2f(3.0) - 2.0 * f);
  let i = vec2i(cell);
  let bottom = mix(sprayHash(i), sprayHash(i + vec2i(1, 0)), w.x);
  let top = mix(sprayHash(i + vec2i(0, 1)), sprayHash(i + vec2i(1, 1)), w.x);
  return mix(bottom, top, w.y);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let radiusSquared = dot(fragmentInputs.sprayCorner, fragmentInputs.sprayCorner);
  if (radiusSquared >= 1.0) { discard; }
  // Two octaves of value noise, thresholded harder towards the rim so a
  // droplet cluster breaks into lumps instead of reading as a disc. Mist
  // (late in life) keeps more of the rim than a fresh sheet does.
  let seed = fragmentInputs.sprayFade.y;
  let age = fragmentInputs.sprayFade.z;
  let p = fragmentInputs.sprayCorner * 2.2 + vec2f(seed * 41.0, seed * 17.0 + age * 0.8);
  let noise = 0.62 * sprayValueNoise(p) + 0.38 * sprayValueNoise(p * 2.31 + vec2f(3.7, 9.1));
  let threshold = (0.15 + 0.55 * radiusSquared) * (1.0 - 0.45 * age);
  let density = smoothstep(threshold, threshold + 0.3, noise) * (1.0 - radiusSquared);
  let alpha = fragmentInputs.sprayFade.x * density;
  if (alpha < ${SPRAY_MIN_VISIBLE_ALPHA}) { discard; }
  fragmentOutputs.color = vec4f(max(fragmentInputs.sprayColor, vec3f(0.0)) * alpha, alpha);
}
`;
