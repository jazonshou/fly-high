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
import type { CarVisualState, FlightVisualState } from "@/src/game/types";
import {
  AERIAL_PERSPECTIVE_UNIFORMS,
  AERIAL_PERSPECTIVE_WGSL,
  applyAerialPerspectiveToShaderMaterial,
  type AerialPerspectiveBinding,
} from "@/src/render/webgpu/atmosphere/AerialPerspective";
import type { AtmosphereSnapshot } from "@/src/render/webgpu/atmosphere/AtmosphereSystem";
import {
  SPRAY_CLOCK_PERIOD_SECONDS,
  SPRAY_CLOCK_SLACK_SECONDS,
  sprayAge,
  sprayClock,
} from "@/src/render/webgpu/boat/BoatSpraySystem";
import {
  keepOpaqueDepthForRenderingGroup,
  WATER_RENDERING_GROUP_ID,
} from "@/src/render/webgpu/core/RenderingGroups";
import {
  WATER_SKY_IRRADIANCE_FRACTION,
  WATER_SUN_IRRADIANCE_SCALE,
} from "@/src/render/webgpu/water/WaterShaders";
import { hashLatticeCoordinates, unitFloatFromHash } from "@/src/world/seed";
import { EXHAUST_TIP } from "./carBody";
import {
  CAR_MUD_DARKENING,
  CAR_SOOT_ALBEDO,
  CAR_WATER_ALBEDO,
  carBowIntensity,
  carDustCloudAlbedo,
  carDustIntensity,
  carExhaustSoot,
  carLeadingBumperX,
  carMudIntensity,
  carSoil,
  carWaterIntensity,
  carWheelContacts,
  carWheelSlipSpeed,
  carWheelWaterDepths,
  createCarWheelContacts,
  rotateCarBodyToWorld,
} from "./carEffectLaws";
import { LC76_TYRE_LOADED_RADIUS } from "./lc76Lines";

/**
 * The LandCruiser's airborne effects, as ONE instanced draw of camera-facing
 * sprites, and no draw at all while nothing is in the air: dust, mud, water
 * thrown by the tyres, the splash off the bumper in a ford, and exhaust
 * smoke. The boat's spray (`BoatSpraySystem`) is the pattern, and its clock
 * is shared.
 *
 * WHERE IT COMES FROM. Five sources, each where the real one is:
 *  - **Dust** behind each loaded tyre on dry loose ground (`carDustIntensity`):
 *    slow, light, long-lived puffs that grow, settle hardly at all and drift
 *    away on the wind, in the colour of the soil's fine fraction.
 *  - **Mud** off each tyre on soaked soil (`carMudIntensity`): small dark
 *    clods, thrown back by wheelspin (the tread slides back over the ground
 *    at the slip speed) and lifted off the tread as it climbs behind the
 *    contact, falling ballistically and gone where they land.
 *  - **Water** off each tyre in a ford, fanned out to the side as the tyre
 *    shoulders it aside, and a fine mist behind the tyres on a soaked road at
 *    speed (`carWaterIntensity`).
 *  - **The bow splash** off the leading bumper wading (`carBowIntensity`):
 *    water the bumper drives ahead of it at its own speed, thrown up and out
 *    to the sides. The bow wave's foam on the water is `CarBowWave`.
 *  - **Exhaust** from the tailpipe under load, darkest before the turbo
 *    spools (`carExhaustSoot`), rising slowly as it is warm.
 *
 * WHERE THE WORK IS. A particle is a closed-form function of its own record
 * and the clock, evaluated in the vertex shader: linear drag relaxing it to
 * the wind with gravity scaled per particle (dust and smoke barely fall,
 * smoke rises), growth over its life, and a fade. The CPU writes a record
 * once, at birth, into a ring of `cap` records and uploads the chunks it
 * wrote. No allocation per frame.
 *
 * ON THE GROUND. Each record carries the ground (or water) it was born over:
 * a soft puff rolls along that floor rather than sinking into it, and a hard
 * clod or droplet is gone once it falls through it.
 *
 * DETERMINISTIC, HELD and LIT exactly as the boat's spray: births on the
 * 120 Hz lattice of the simulation clock with every draw a hash; a car held
 * still while its velocity says it moves (a pinned capture) throws in its own
 * frame; the sun and sky the sea lights its foam with, which is the light
 * the terrain is lit with (`WATER_SUN_IRRADIANCE_SCALE`), on each particle's
 * own albedo, so a dust cloud is the colour of the ground it came from in
 * every light.
 *
 * DRAW ORDER. Group 1 (water) at alphaIndex 2.5, where the boat's spray
 * draws (a session has one or the other, never both): after the ocean, the
 * inland water a ford is in, and the bow wave's foam.
 */

/** Floats per particle record: five vec4 attributes. */
export const CAR_PARTICLE_FLOATS = 20;
/** The largest cap any tier may ask for (pinned by test against the profiles). */
export const CAR_PARTICLE_CAPACITY = 1_024;
/** Particles per upload chunk: the ring is uploaded in whole chunks it wrote. */
export const CAR_PARTICLE_CHUNK = 32;
/** The emission lattice, Hz. */
export const CAR_PARTICLE_EMISSION_HZ = 120;
/** At most this many lattice ticks are emitted in one frame (a hitch drops the rest). */
export const CAR_PARTICLE_MAX_TICKS_PER_FRAME = 24;
/** The longest any particle lives; past it with nothing new born, the mesh is disabled. */
export const CAR_PARTICLE_MAX_LIFETIME_SECONDS = 5;
/** The anchor is moved when the car is this far from it, so records stay small for f32. */
export const CAR_PARTICLE_REANCHOR_METERS = 2_000;
/** As `SPRAY_HELD_FRACTION` and `SPRAY_HELD_SECONDS`: a car held still while its velocity says it moves. */
export const CAR_PARTICLE_HELD_FRACTION = 0.1;
export const CAR_PARTICLE_HELD_SECONDS = 0.5;

/**
 * How the budget is shared: the steady-state live count of each source at
 * full intensity is this fraction of the cap. The tyres' throw is mud OR
 * water per tyre (a tyre is on soil or in a ford), so the shares sum below 1
 * and the ring never overwrites a particle still in the air.
 */
export const CAR_PARTICLE_BUDGET_SHARES = Object.freeze({ dust: 0.5, throw: 0.3, bow: 0.1, exhaust: 0.08 });

interface Lifetime {
  readonly min: number;
  readonly span: number;
}
const DUST_LIFETIME: Lifetime = { min: 2.6, span: 2.4 };
const MUD_LIFETIME: Lifetime = { min: 0.5, span: 0.6 };
const WATER_LIFETIME: Lifetime = { min: 0.6, span: 0.6 };
const MIST_LIFETIME: Lifetime = { min: 1, span: 0.8 };
const BOW_LIFETIME: Lifetime = { min: 0.7, span: 0.6 };
const EXHAUST_LIFETIME: Lifetime = { min: 1.4, span: 1.2 };

function meanLife(life: Lifetime): number {
  return life.min + life.span / 2;
}

/** Standard gravity, m/s². */
const GRAVITY = 9.81;
/** Below this the vertex collapses the sprite, so an invisible particle rasterises nothing. */
const CAR_PARTICLE_MIN_VISIBLE_ALPHA = 0.003;

/** Hash channels (any distinct integers): one per tyre for the tyres' sources. */
const SOURCE_DUST = 0;
const SOURCE_MUD = 8;
const SOURCE_WATER = 16;
const SOURCE_BOW = 32;
const SOURCE_EXHAUST = 40;
/** The hash lane that rounds a tick's fractional births. */
const BIRTH_LANE = 7;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** One uniform draw in [0, 1) per (tick, source, particle, lane). */
function unit(tick: number, source: number, particle: number, lane: number): number {
  return unitFloatFromHash(
    hashLatticeCoordinates(hashLatticeCoordinates(0x4c_c76, tick, source), particle, lane),
  );
}

/** A tick's whole births from a fractional expectation, rounded by a hash (see `BoatSpraySystem`). */
function births(expected: number, tick: number, source: number): number {
  if (!(expected > 0)) return 0;
  return Math.floor(expected + unit(tick, source, 0, BIRTH_LANE));
}

export interface CarParticleSample {
  x: number;
  y: number;
  z: number;
  age: number;
  life: number;
  sizeMeters: number;
  alpha: number;
}

export function createCarParticleSample(): CarParticleSample {
  return { x: 0, y: 0, z: 0, age: 0, life: 0, sizeMeters: 0, alpha: 0 };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * The vertex shader's flight and fade law, line for line, for tests and
 * reasoning. The WGSL below is the authority; this mirrors its expression.
 * Positions are anchor-relative in x and z, absolute in y.
 *
 * Linear drag towards the wind with scaled gravity: dv/dt = -k (v - w) + s g
 * gives p(t) = p0 + v0 r + (w + s g / k)(t - r), r = (1 - e^(-k t)) / k.
 */
export function sampleCarParticle(
  records: Float32Array,
  particle: number,
  clock: number,
  windX: number,
  windZ: number,
  out: CarParticleSample,
): CarParticleSample {
  const at = particle * CAR_PARTICLE_FLOATS;
  const age = sprayAge(clock, records[at + 3]!);
  const life = records[at + 7]!;
  const k = Math.max(records[at + 10]!, 0.05);
  const relax = (1 - Math.exp(-k * age)) / k;
  const after = age - relax;
  const fall = (GRAVITY * records[at + 15]!) / k;
  const u = life > 0 ? age / life : 1;
  const size = records[at + 8]! * (1 + records[at + 9]! * u);
  const floor = records[at + 16]!;
  const hardness = records[at + 19]!;
  const rawY = records[at + 1]! + records[at + 5]! * relax - fall * after;
  out.x = records[at]! + records[at + 4]! * relax + windX * after;
  out.y = rawY + (1 - hardness) * Math.max(0, floor + 0.35 * size - rawY);
  out.z = records[at + 2]! + records[at + 6]! * relax + windZ * after;
  out.age = age;
  out.life = life;
  out.sizeMeters = size;
  const below = smoothstep(floor - 0.05, floor + 0.04, rawY);
  const grounded = 1 + hardness * (below - 1);
  out.alpha = u >= 1 || life <= 0
    ? 0
    : records[at + 11]! * smoothstep(0, 0.08, u) * (1 - smoothstep(0.55, 1, u)) * grounded;
  return out;
}

interface CarParticleGpu {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  readonly buffer: Buffer;
  /** One view per upload chunk, made once. */
  readonly chunkViews: readonly Float32Array[];
}

export interface CarParticleOptions {
  /** `WebGpuQualityProfile.vehicleParticleBudget`. */
  readonly cap: number;
  /** Surface wind the particles relax to, world m/s along x and z. */
  readonly windX?: number;
  readonly windZ?: number;
}

/** What a particle is, for the counts the tests read. */
export type CarParticleKind = "dust" | "mud" | "water" | "bow" | "exhaust";

/** What one particle is born as, besides where and how fast. */
interface ParticleLook {
  life: number;
  size: number;
  growth: number;
  drag: number;
  opacity: number;
  r: number;
  g: number;
  b: number;
  gravity: number;
  floor: number;
  glow: number;
  translucency: number;
  hardness: number;
}

/** The system: one mesh, one material, one instanced draw, or nothing. */
export class CarParticleSystem {
  private readonly scene: Scene;
  private readonly windX: number;
  private readonly windZ: number;
  private cap = 0;
  private gpu: CarParticleGpu | null = null;
  private records: Float32Array | null = null;
  private binding: AerialPerspectiveBinding | null = null;
  private cursor = 0;
  private lastTick = Number.NaN;
  private lastBirthClock = Number.NaN;
  private lastClock = 0;
  private readonly dirtyChunks: Uint8Array;
  private anchorX = Number.NaN;
  private anchorZ = Number.NaN;
  private originX = 0;
  private originZ = 0;
  private births = 0;
  private readonly bornBySource: Record<CarParticleKind, number> = { dust: 0, mud: 0, water: 0, bow: 0, exhaust: 0 };
  private primePending = false;
  private holdX = Number.NaN;
  private holdZ = Number.NaN;
  private holdTime = Number.NaN;
  private heldSeconds = 0;
  private readonly frame = { x: 0, z: 0 };
  private readonly contacts = createCarWheelContacts();
  private readonly dust = [0, 0, 0, 0];
  private readonly mud = [0, 0, 0, 0];
  private readonly water = [0, 0, 0, 0];
  private readonly waterDepth = [0, 0, 0, 0];
  private bow = 0;
  private soot = 0;
  private groundY = 0;
  private waterY = 0;
  private readonly forward = { x: 1, y: 0, z: 0 };
  private readonly up = { x: 0, y: 1, z: 0 };
  private readonly right = { x: 0, y: 0, z: 1 };
  private readonly anchorUniform = new Vector3();
  private readonly windUniform = new Vector4();
  private readonly sunUniform = new Vector3(1, 1, 1);
  private readonly skyUniform = new Vector3(0.3, 0.3, 0.3);
  private readonly scratch = { x: 0, y: 0, z: 0 };
  private readonly velocity = { x: 0, y: 0, z: 0 };
  private readonly look: ParticleLook = {
    life: 0, size: 0, growth: 0, drag: 0, opacity: 0, r: 0, g: 0, b: 0,
    gravity: 0, floor: 0, glow: 0, translucency: 0, hardness: 0,
  };
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

  constructor(scene: Scene, options: CarParticleOptions) {
    this.scene = scene;
    this.windX = Number.isFinite(options.windX) ? options.windX! : 0;
    this.windZ = Number.isFinite(options.windZ) ? options.windZ! : 0;
    this.dirtyChunks = new Uint8Array(CAR_PARTICLE_CAPACITY / CAR_PARTICLE_CHUNK);
    this.setCap(options.cap);
  }

  get capacity(): number {
    return this.cap;
  }

  /** Whether the mesh will be submitted this frame. */
  get drawing(): boolean {
    return this.gpu?.mesh.isEnabled(false) ?? false;
  }

  /** Particles born since construction. */
  get birthCount(): number {
    return this.births;
  }

  /** Particles born since construction, by source. */
  get birthsBySource(): Readonly<Record<CarParticleKind, number>> {
    return this.bornBySource;
  }

  /** The ring of records (`capacity` particles). Null without GPU resources. */
  get instanceData(): Float32Array | null {
    return this.records;
  }

  get anchor(): { readonly x: number; readonly z: number } {
    return { x: this.anchorX, z: this.anchorZ };
  }

  /** The velocity the particles are drawn relative to: zero, or a held car's own. */
  get referenceVelocity(): { readonly x: number; readonly z: number } {
    return { x: this.frame.x, z: this.frame.z };
  }

  get mesh(): Mesh | null {
    return this.gpu?.mesh ?? null;
  }

  /** Particles whose age is inside their life at the last update's clock. */
  liveCount(): number {
    const records = this.records;
    if (!records) return 0;
    let live = 0;
    for (let particle = 0; particle < this.cap; particle += 1) {
      const at = particle * CAR_PARTICLE_FLOATS;
      const life = records[at + 7]!;
      if (life > 0 && sprayAge(this.lastClock, records[at + 3]!) < life) live += 1;
    }
    return live;
  }

  /**
   * Apply the tier's budget, in whole upload chunks. The ring is rebuilt at
   * the new size (what is in the air is dropped). 0 disposes every GPU
   * resource.
   */
  setCap(cap: number): void {
    const next = Number.isFinite(cap)
      ? Math.max(0, Math.min(CAR_PARTICLE_CAPACITY, Math.floor(cap / CAR_PARTICLE_CHUNK) * CAR_PARTICLE_CHUNK))
      : 0;
    if (next === this.cap && (next === 0) === (this.gpu === null)) return;
    this.disposeGpu();
    this.cap = next;
    this.cursor = 0;
    this.lastBirthClock = Number.NaN;
    if (next > 0) this.createGpu();
  }

  /** The sea's sun and sky, split as `BoatSpraySystem.setAtmosphere` splits them. */
  setAtmosphere(atmosphere: AtmosphereSnapshot): void {
    const sun = atmosphere.sunIlluminanceNormalized * WATER_SUN_IRRADIANCE_SCALE;
    this.sunUniform.set(atmosphere.sunColor.r * sun, atmosphere.sunColor.g * sun, atmosphere.sunColor.b * sun);
    const sky = 0.5 * WATER_SKY_IRRADIANCE_FRACTION * atmosphere.skylightIlluminanceNormalized;
    this.skyUniform.set(
      (atmosphere.skyZenith.r + atmosphere.skyHorizon.r) * sky,
      (atmosphere.skyZenith.g + atmosphere.skyHorizon.g) * sky,
      (atmosphere.skyZenith.b + atmosphere.skyHorizon.b) * sky,
    );
    this.gpu?.material.setVector3("carSun", this.sunUniform);
    this.gpu?.material.setVector3("carSky", this.skyUniform);
  }

  get lighting(): { readonly sun: Readonly<Vector3>; readonly sky: Readonly<Vector3> } {
    return { sun: this.sunUniform, sky: this.skyUniform };
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
    this.syncAnchorUniform();
  }

  /**
   * Per-frame update from the latest snapshot. Allocation-free. Emits every
   * lattice tick since the last frame (at most
   * `CAR_PARTICLE_MAX_TICKS_PER_FRAME`), each particle where its source was
   * at that tick, by running the snapshot's velocity back from
   * `state.simulationTime`.
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

    const car = state.vehicle?.kind === "car" ? state.vehicle : null;
    const tick = Math.floor(time * CAR_PARTICLE_EMISSION_HZ + 1e-6);
    if (Number.isNaN(this.lastTick) || tick < this.lastTick || tick - this.lastTick > 4 * CAR_PARTICLE_EMISSION_HZ) {
      this.lastTick = tick - 1;
    }
    if (car && !state.crashed) {
      this.ensureAnchor(state.position.x, state.position.z);
      this.sampleSources(state, car);
      const first = Math.max(this.lastTick + 1, tick - CAR_PARTICLE_MAX_TICKS_PER_FRAME + 1);
      for (let at = first; at <= tick; at += 1) this.emitTick(state, car, at, time);
    }
    this.lastTick = tick;
    this.flushChunks(gpu);

    const alive = !Number.isNaN(this.lastBirthClock)
      && sprayAge(clock, this.lastBirthClock) <= CAR_PARTICLE_MAX_LIFETIME_SECONDS;
    const draw = this.primePending || alive;
    this.primePending = false;
    if (gpu.mesh.isEnabled(false) !== draw) gpu.mesh.setEnabled(draw);
  }

  dispose(): void {
    this.disposeGpu();
    this.cap = 0;
  }

  private trackHold(state: FlightVisualState, time: number): void {
    const elapsed = time - this.holdTime;
    if (elapsed > 0 && elapsed < 1) {
      const expected = Math.hypot(state.velocity.x, state.velocity.z) * elapsed;
      const moved = Math.hypot(state.position.x - this.holdX, state.position.z - this.holdZ);
      this.heldSeconds = expected > 0.005 && moved < CAR_PARTICLE_HELD_FRACTION * expected
        ? this.heldSeconds + elapsed
        : 0;
    } else if (elapsed !== 0) {
      this.heldSeconds = 0;
    }
    this.holdX = state.position.x;
    this.holdZ = state.position.z;
    this.holdTime = time;
    const held = this.heldSeconds >= CAR_PARTICLE_HELD_SECONDS;
    this.frame.x = held ? state.velocity.x : 0;
    this.frame.z = held ? state.velocity.z : 0;
  }

  private ensureAnchor(worldX: number, worldZ: number): void {
    if (!Number.isNaN(this.anchorX)
      && Math.abs(worldX - this.anchorX) < CAR_PARTICLE_REANCHOR_METERS
      && Math.abs(worldZ - this.anchorZ) < CAR_PARTICLE_REANCHOR_METERS) return;
    const records = this.records!;
    if (!Number.isNaN(this.anchorX)) {
      const dx = this.anchorX - worldX;
      const dz = this.anchorZ - worldZ;
      for (let particle = 0; particle < this.cap; particle += 1) {
        const at = particle * CAR_PARTICLE_FLOATS;
        records[at] = records[at]! + dx;
        records[at + 2] = records[at + 2]! + dz;
      }
      this.dirtyChunks.fill(1, 0, this.cap / CAR_PARTICLE_CHUNK);
    }
    this.anchorX = worldX;
    this.anchorZ = worldZ;
    this.syncAnchorUniform();
  }

  private syncAnchorUniform(): void {
    if (Number.isNaN(this.anchorX)) return;
    this.anchorUniform.set(this.anchorX - this.originX, 0, this.anchorZ - this.originZ);
  }

  /** The frame's source strengths and the car's axes, read once and shared by every tick. */
  private sampleSources(state: FlightVisualState, car: CarVisualState): void {
    carWheelContacts(state, car, this.contacts);
    const level = carWheelWaterDepths(car, this.contacts, this.waterDepth);
    let ground = 0;
    for (let wheel = 0; wheel < 4; wheel += 1) {
      const depth = this.waterDepth[wheel]!;
      this.dust[wheel] = carDustIntensity(car, wheel, depth);
      this.mud[wheel] = carMudIntensity(car, wheel, depth);
      this.water[wheel] = carWaterIntensity(car, wheel, depth);
      ground += this.contacts[wheel]!.surfaceY;
    }
    this.groundY = ground / 4;
    this.waterY = Number.isNaN(level) ? this.groundY : level;
    this.bow = carBowIntensity(car);
    this.soot = carExhaustSoot(car, state.throttle);
    rotateCarBodyToWorld(state.orientation, 1, 0, 0, this.forward);
    rotateCarBodyToWorld(state.orientation, 0, 1, 0, this.up);
    rotateCarBodyToWorld(state.orientation, 0, 0, 1, this.right);
  }

  /** Every source's births for one lattice tick. */
  private emitTick(state: FlightVisualState, car: CarVisualState, tick: number, time: number): void {
    const dt = 1 / CAR_PARTICLE_EMISSION_HZ;
    const back = Math.min(0, tick * dt - time);
    const tickClock = sprayClock(tick * dt);
    const cap = this.cap;
    const shares = CAR_PARTICLE_BUDGET_SHARES;
    for (let wheel = 0; wheel < 4; wheel += 1) {
      const dust = births((shares.dust * cap * this.dust[wheel]! * dt) / (4 * meanLife(DUST_LIFETIME)), tick, SOURCE_DUST + wheel);
      for (let index = 0; index < dust; index += 1) this.birthDust(state, car, wheel, tick, index, back, tickClock);
      const mud = births((shares.throw * cap * this.mud[wheel]! * dt) / (4 * meanLife(MUD_LIFETIME)), tick, SOURCE_MUD + wheel);
      for (let index = 0; index < mud; index += 1) this.birthThrow(state, car, wheel, false, tick, index, back, tickClock);
      const ford = car.wheelSurface[wheel] === -1;
      const waterLife = ford ? WATER_LIFETIME : MIST_LIFETIME;
      const water = births((shares.throw * cap * this.water[wheel]! * dt) / (4 * meanLife(waterLife)), tick, SOURCE_WATER + wheel);
      for (let index = 0; index < water; index += 1) {
        if (ford) this.birthThrow(state, car, wheel, true, tick, index, back, tickClock);
        else this.birthMist(state, wheel, tick, index, back, tickClock);
      }
    }
    const bow = births((shares.bow * cap * this.bow * dt) / meanLife(BOW_LIFETIME), tick, SOURCE_BOW);
    for (let index = 0; index < bow; index += 1) this.birthBow(state, car, tick, index, back, tickClock);
    const smoke = births((shares.exhaust * cap * this.soot * dt) / meanLife(EXHAUST_LIFETIME), tick, SOURCE_EXHAUST);
    for (let index = 0; index < smoke; index += 1) this.birthExhaust(state, tick, index, back, tickClock);
  }

  /** The car's own velocity, less the frame the particles are drawn in. */
  private carried(state: FlightVisualState, share: number): void {
    this.velocity.x = state.velocity.x * share - this.frame.x;
    this.velocity.y = state.velocity.y * share;
    this.velocity.z = state.velocity.z * share - this.frame.z;
  }

  private add(axis: { x: number; y: number; z: number }, amount: number): void {
    this.velocity.x += axis.x * amount;
    this.velocity.y += axis.y * amount;
    this.velocity.z += axis.z * amount;
  }

  /** Dust behind a tyre: lifted, fanned outboard, slow to settle, growing as it spreads. */
  private birthDust(
    state: FlightVisualState,
    car: CarVisualState,
    wheel: number,
    tick: number,
    index: number,
    back: number,
    tickClock: number,
  ): void {
    const source = SOURCE_DUST + wheel;
    const r0 = unit(tick, source, index, 0);
    const r1 = unit(tick, source, index, 1);
    const r2 = unit(tick, source, index, 2);
    const r3 = unit(tick, source, index, 3);
    const r4 = unit(tick, source, index, 4);
    const contact = this.contacts[wheel]!;
    const side = wheel % 2 === 0 ? -1 : 1;
    const heading = car.speed < 0 ? -1 : 1;
    const intensity = this.dust[wheel]!;
    const slip = carWheelSlipSpeed(car, wheel);
    this.carried(state, 0.35 + 0.2 * r0);
    this.add(this.up, 1 + 2 * r1);
    this.add(this.right, side * (0.3 + 0.6 * r2) * (0.4 + 0.6 * intensity));
    this.add(this.forward, -heading * slip * 0.25 * r3);
    const soilColour = carSoil(car.wheelSurface[wheel]).dustAlbedo;
    const look = this.look;
    look.life = DUST_LIFETIME.min + DUST_LIFETIME.span * r4;
    look.size = 0.5 + 0.5 * r2;
    look.growth = 3.5;
    look.drag = 1.2 + 0.6 * r1;
    look.opacity = (0.25 + 0.3 * r3) * (0.5 + 0.5 * intensity);
    look.r = carDustCloudAlbedo(soilColour[0]);
    look.g = carDustCloudAlbedo(soilColour[1]);
    look.b = carDustCloudAlbedo(soilColour[2]);
    // The car's turbulent wake keeps lifting it.
    look.gravity = -0.02;
    look.floor = contact.surfaceY;
    look.glow = 0.08;
    look.translucency = 0.45;
    look.hardness = 0;
    this.writeAt(
      state,
      "dust",
      contact.x - contact.forwardX * heading * 0.25,
      contact.surfaceY + 0.12,
      contact.z - contact.forwardZ * heading * 0.25,
      back,
      tickClock,
    );
  }

  /**
   * Mud or water off a tyre: thrown back at the slip speed by wheelspin, and
   * lifted off the tread as it climbs behind the contact; water is also
   * shouldered out to the side.
   */
  private birthThrow(
    state: FlightVisualState,
    car: CarVisualState,
    wheel: number,
    water: boolean,
    tick: number,
    index: number,
    back: number,
    tickClock: number,
  ): void {
    const source = (water ? SOURCE_WATER : SOURCE_MUD) + wheel;
    const r0 = unit(tick, source, index, 0);
    const r1 = unit(tick, source, index, 1);
    const r2 = unit(tick, source, index, 2);
    const r3 = unit(tick, source, index, 3);
    const r4 = unit(tick, source, index, 4);
    const contact = this.contacts[wheel]!;
    const side = wheel % 2 === 0 ? -1 : 1;
    const speed = Number.isFinite(car.speed) ? car.speed : 0;
    const heading = speed < 0 ? -1 : 1;
    const spin = Number.isFinite(car.wheelSpinRate[wheel]) ? car.wheelSpinRate[wheel]! : 0;
    // The tread's slide over the ground, signed along the body's forward axis.
    const roost = spin * LC76_TYRE_LOADED_RADIUS - speed;
    this.carried(state, 0.35 + 0.3 * r0);
    this.add(this.forward, -roost * (0.5 + 0.3 * r1));
    this.add(this.up, Math.abs(speed) * (0.12 + 0.18 * r2) + Math.abs(roost) * (0.25 + 0.35 * r2));
    this.add(this.right, side * (water ? Math.abs(speed) * (0.25 + 0.25 * r3) + 0.4 : (0.3 + Math.abs(speed) * 0.08) * r3));
    const look = this.look;
    if (water) {
      look.life = WATER_LIFETIME.min + WATER_LIFETIME.span * r4;
      look.size = 0.12 + 0.12 * r3;
      look.growth = 1.2;
      look.drag = 1 + 0.8 * r1;
      look.opacity = 0.35 + 0.25 * r0;
      look.r = CAR_WATER_ALBEDO;
      look.g = CAR_WATER_ALBEDO;
      look.b = CAR_WATER_ALBEDO;
      look.floor = this.waterY;
      look.glow = 0.12;
      look.translucency = 0.35;
      look.hardness = 0.7;
    } else {
      const soilColour = carSoil(car.wheelSurface[wheel]).dustAlbedo;
      look.life = MUD_LIFETIME.min + MUD_LIFETIME.span * r4;
      look.size = 0.035 + 0.05 * r3;
      look.growth = 0;
      look.drag = 0.25;
      look.opacity = 0.95;
      look.r = soilColour[0] * CAR_MUD_DARKENING;
      look.g = soilColour[1] * CAR_MUD_DARKENING;
      look.b = soilColour[2] * CAR_MUD_DARKENING;
      look.floor = contact.surfaceY;
      look.glow = 0;
      look.translucency = 0.1;
      look.hardness = 1;
    }
    look.gravity = 1;
    this.writeAt(
      state,
      water ? "water" : "mud",
      contact.x - contact.forwardX * heading * 0.32,
      Math.max(contact.surfaceY, water ? this.waterY : contact.surfaceY) + 0.18 + 0.2 * r2,
      contact.z - contact.forwardZ * heading * 0.32,
      back,
      tickClock,
    );
  }

  /** The fine mist behind a tyre on a soaked road at speed. */
  private birthMist(
    state: FlightVisualState,
    wheel: number,
    tick: number,
    index: number,
    back: number,
    tickClock: number,
  ): void {
    const source = SOURCE_WATER + wheel;
    const r0 = unit(tick, source, index, 0);
    const r1 = unit(tick, source, index, 1);
    const r2 = unit(tick, source, index, 2);
    const r4 = unit(tick, source, index, 4);
    const contact = this.contacts[wheel]!;
    const side = wheel % 2 === 0 ? -1 : 1;
    this.carried(state, 0.5 + 0.2 * r0);
    this.add(this.up, 0.5 + 0.8 * r1);
    this.add(this.right, side * (0.4 + 0.8 * r2));
    const look = this.look;
    look.life = MIST_LIFETIME.min + MIST_LIFETIME.span * r4;
    look.size = 0.25 + 0.15 * r2;
    look.growth = 2;
    look.drag = 2.5;
    look.opacity = 0.12 + 0.06 * r1;
    look.r = CAR_WATER_ALBEDO;
    look.g = CAR_WATER_ALBEDO;
    look.b = CAR_WATER_ALBEDO;
    look.gravity = 0.15;
    look.floor = contact.surfaceY;
    look.glow = 0.12;
    look.translucency = 0.5;
    look.hardness = 0;
    this.writeAt(state, "water", contact.x - contact.forwardX * 0.35, contact.surfaceY + 0.15, contact.z - contact.forwardZ * 0.35, back, tickClock);
  }

  /** Water the leading bumper drives ahead of it, thrown up and out to the sides. */
  private birthBow(
    state: FlightVisualState,
    car: CarVisualState,
    tick: number,
    index: number,
    back: number,
    tickClock: number,
  ): void {
    const r0 = unit(tick, SOURCE_BOW, index, 0);
    const r1 = unit(tick, SOURCE_BOW, index, 1);
    const r2 = unit(tick, SOURCE_BOW, index, 2);
    const r3 = unit(tick, SOURCE_BOW, index, 3);
    const r4 = unit(tick, SOURCE_BOW, index, 4);
    const across = 2 * r0 - 1;
    this.carried(state, 1 + 0.15 * r1);
    this.add(this.up, 0.8 + 1.8 * r2 * this.bow);
    this.add(this.right, across * (0.6 + 1 * r3));
    const look = this.look;
    look.life = BOW_LIFETIME.min + BOW_LIFETIME.span * r4;
    look.size = 0.15 + 0.15 * r3;
    look.growth = 1.1;
    look.drag = 1.2;
    look.opacity = 0.35 + 0.25 * r1;
    look.r = CAR_WATER_ALBEDO;
    look.g = CAR_WATER_ALBEDO;
    look.b = CAR_WATER_ALBEDO;
    look.gravity = 1;
    look.floor = this.waterY;
    look.glow = 0.12;
    look.translucency = 0.35;
    look.hardness = 0.7;
    const bumperX = carLeadingBumperX(car.speed);
    rotateCarBodyToWorld(state.orientation, bumperX, 0, across * 0.85, this.scratch);
    this.writeAt(
      state,
      "bow",
      state.position.x + this.scratch.x,
      this.waterY + 0.05,
      state.position.z + this.scratch.z,
      back,
      tickClock,
    );
  }

  /** A puff from the tailpipe: blown back, slowed to the wind, rising and spreading. */
  private birthExhaust(state: FlightVisualState, tick: number, index: number, back: number, tickClock: number): void {
    const r0 = unit(tick, SOURCE_EXHAUST, index, 0);
    const r1 = unit(tick, SOURCE_EXHAUST, index, 1);
    const r2 = unit(tick, SOURCE_EXHAUST, index, 2);
    const r4 = unit(tick, SOURCE_EXHAUST, index, 4);
    this.carried(state, 1);
    this.add(this.forward, -1.2 - 0.6 * r0);
    this.add(this.up, -0.2 + 0.3 * r1);
    this.add(this.right, -0.3 + 0.4 * r2);
    const look = this.look;
    look.life = EXHAUST_LIFETIME.min + EXHAUST_LIFETIME.span * r4;
    look.size = 0.1 + 0.06 * r1;
    look.growth = 7;
    look.drag = 2.5;
    look.opacity = (0.25 + 0.15 * r2) * this.soot;
    look.r = CAR_SOOT_ALBEDO;
    look.g = CAR_SOOT_ALBEDO;
    look.b = CAR_SOOT_ALBEDO;
    look.gravity = -0.08;
    look.floor = this.groundY;
    look.glow = 0.02;
    look.translucency = 0.6;
    look.hardness = 0;
    rotateCarBodyToWorld(state.orientation, EXHAUST_TIP[0], EXHAUST_TIP[1], EXHAUST_TIP[2], this.scratch);
    this.writeAt(
      state,
      "exhaust",
      state.position.x + this.scratch.x,
      state.position.y + this.scratch.y,
      state.position.z + this.scratch.z,
      back,
      tickClock,
    );
  }

  /** One record into the ring at the cursor, from `look` and `velocity`, run back to its tick. */
  private writeAt(
    state: FlightVisualState,
    kind: CarParticleKind,
    worldX: number,
    worldY: number,
    worldZ: number,
    back: number,
    birthClock: number,
  ): void {
    const records = this.records!;
    const look = this.look;
    const at = this.cursor * CAR_PARTICLE_FLOATS;
    records[at] = worldX + (state.velocity.x - this.frame.x) * back - this.anchorX;
    records[at + 1] = worldY + state.velocity.y * back;
    records[at + 2] = worldZ + (state.velocity.z - this.frame.z) * back - this.anchorZ;
    records[at + 3] = birthClock;
    records[at + 4] = this.velocity.x;
    records[at + 5] = this.velocity.y;
    records[at + 6] = this.velocity.z;
    records[at + 7] = look.life;
    records[at + 8] = look.size;
    records[at + 9] = look.growth;
    records[at + 10] = look.drag;
    records[at + 11] = look.opacity;
    records[at + 12] = look.r;
    records[at + 13] = look.g;
    records[at + 14] = look.b;
    records[at + 15] = look.gravity;
    records[at + 16] = look.floor + state.velocity.y * back;
    records[at + 17] = look.glow;
    records[at + 18] = look.translucency;
    records[at + 19] = look.hardness;
    this.dirtyChunks[Math.floor(this.cursor / CAR_PARTICLE_CHUNK)] = 1;
    this.cursor = (this.cursor + 1) % this.cap;
    this.lastBirthClock = birthClock;
    this.births += 1;
    this.bornBySource[kind] += 1;
  }

  private flushChunks(gpu: CarParticleGpu): void {
    const chunks = this.cap / CAR_PARTICLE_CHUNK;
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      if (this.dirtyChunks[chunk] === 0) continue;
      this.dirtyChunks[chunk] = 0;
      gpu.buffer.updateDirectly(gpu.chunkViews[chunk]!, chunk * CAR_PARTICLE_CHUNK * CAR_PARTICLE_FLOATS, CAR_PARTICLE_CHUNK);
    }
  }

  private createGpu(): void {
    const scene = this.scene;
    ShaderStore.ShadersStoreWGSL[`${CAR_PARTICLE_SHADER_NAME}VertexShader`] = CAR_PARTICLE_VERTEX_WGSL;
    ShaderStore.ShadersStoreWGSL[`${CAR_PARTICLE_SHADER_NAME}PixelShader`] = CAR_PARTICLE_FRAGMENT_WGSL;
    keepOpaqueDepthForRenderingGroup(scene, WATER_RENDERING_GROUP_ID);

    const mesh = new Mesh("car-particles", scene);
    const quad = new VertexData();
    quad.positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
    quad.indices = [0, 2, 1, 0, 3, 2];
    quad.applyToMesh(mesh, false);

    // Zero-filled: a zero lifetime is a dead particle, collapsed in the vertex stage.
    const records = new Float32Array(this.cap * CAR_PARTICLE_FLOATS);
    const buffer = new Buffer(scene.getEngine(), records, true, CAR_PARTICLE_FLOATS, false, true);
    for (let lane = 0; lane < 5; lane += 1) {
      mesh.setVerticesBuffer(buffer.createVertexBuffer(CAR_PARTICLE_ATTRIBUTES[lane]!, lane * 4, 4));
    }
    const chunkViews: Float32Array[] = [];
    for (let chunk = 0; chunk < this.cap / CAR_PARTICLE_CHUNK; chunk += 1) {
      const start = chunk * CAR_PARTICLE_CHUNK * CAR_PARTICLE_FLOATS;
      chunkViews.push(records.subarray(start, start + CAR_PARTICLE_CHUNK * CAR_PARTICLE_FLOATS));
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
      "car-particles-material",
      scene,
      CAR_PARTICLE_SHADER_NAME,
      {
        attributes: ["position", ...CAR_PARTICLE_ATTRIBUTES],
        uniforms: [
          "view",
          "projection",
          "cameraPosition",
          "carAnchor",
          "carWind",
          "carSun",
          "carSky",
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
    material.setVector3("carAnchor", this.anchorUniform);
    material.setVector4("carWind", this.windUniform);
    material.setVector3("carSun", this.sunUniform);
    material.setVector3("carSky", this.skyUniform);
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

function wgslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

const CAR_PARTICLE_SHADER_NAME = "carParticles";
const CAR_PARTICLE_ATTRIBUTES = ["carA", "carB", "carC", "carD", "carE"] as const;
/** The forward lobe of fine dust and droplets (Mie). */
export const CAR_PARTICLE_FORWARD_G = 0.72;

export const CAR_PARTICLE_VERTEX_WGSL = /* wgsl */ `
attribute position: vec3f;
// xyz position (x, z from the anchor; y absolute), w birth clock
attribute carA: vec4f;
// xyz velocity, w lifetime
attribute carB: vec4f;
// x size, y growth over the life, z drag, w opacity
attribute carC: vec4f;
// xyz albedo, w gravity scale
attribute carD: vec4f;
// x floor (absolute y), y forward glow, z translucency, w hardness
attribute carE: vec4f;

varying carCorner: vec2f;
varying carColor: vec3f;
// x alpha, y seed, z age fraction, w hardness
varying carFade: vec4f;

uniform view: mat4x4f;
uniform projection: mat4x4f;
uniform cameraPosition: vec3f;
uniform carAnchor: vec3f;
// xy surface wind, world m/s along x and z; w clock s (wrapped)
uniform carWind: vec4f;
uniform carSun: vec3f;
uniform carSky: vec3f;

${AERIAL_PERSPECTIVE_WGSL}

const CAR_PERIOD: f32 = ${wgslFloat(SPRAY_CLOCK_PERIOD_SECONDS)};
const CAR_CLOCK_SLACK: f32 = ${wgslFloat(SPRAY_CLOCK_SLACK_SECONDS)};
const CAR_GRAVITY: f32 = ${wgslFloat(GRAVITY)};
const CAR_PI: f32 = 3.14159265359;
const CAR_FORWARD_G: f32 = ${wgslFloat(CAR_PARTICLE_FORWARD_G)};

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let recordA = vertexInputs.carA;
  let recordB = vertexInputs.carB;
  let recordC = vertexInputs.carC;
  let recordD = vertexInputs.carD;
  let recordE = vertexInputs.carE;

  // sampleCarParticle is this block's CPU twin; change both or neither.
  var age = uniforms.carWind.w - recordA.w;
  age = select(max(age, 0.0), age + CAR_PERIOD, age < -CAR_CLOCK_SLACK);
  let life = recordB.w;
  let u = select(1.0, age / max(life, 0.0001), life > 0.0);
  let k = max(recordC.z, 0.05);
  let decay = exp(-k * age);
  let relax = (1.0 - decay) / k;
  let after = age - relax;
  let wind = vec3f(uniforms.carWind.x, 0.0, uniforms.carWind.y);
  let terminal = wind - vec3f(0.0, CAR_GRAVITY * recordD.w / k, 0.0);
  var local = recordA.xyz + recordB.xyz * relax + terminal * after;
  let velocity = (recordB.xyz - terminal) * decay + terminal;
  let size = recordC.x * (1.0 + recordC.y * u);
  let floorY = recordE.x;
  let hardness = recordE.w;
  let rawY = local.y;
  // A soft puff rolls along the ground it rose from; a clod or a drop is gone through it.
  local.y = rawY + (1.0 - hardness) * max(0.0, floorY + 0.35 * size - rawY);
  let centre = uniforms.carAnchor + local;
  let below = smoothstep(floorY - 0.05, floorY + 0.04, rawY);
  let grounded = 1.0 + hardness * (below - 1.0);

  let toCentre = centre - uniforms.cameraPosition;
  let distanceMeters = max(length(toCentre), 0.001);
  let nearFade = smoothstep(size * 0.8, size * 3.0, distanceMeters);
  let lifeFade = smoothstep(0.0, 0.08, u) * (1.0 - smoothstep(0.55, 1.0, u));
  let alpha = select(recordC.w * lifeFade * grounded * nearFade, 0.0, u >= 1.0 || life <= 0.0);

  // Camera-facing; a hard clod or a young fast drop streaks along its own
  // motion on screen, a soft puff does not.
  let corner = vertexInputs.position.xy;
  let viewVelocity = (uniforms.view * vec4f(velocity, 0.0)).xy;
  let speedOnScreen = length(viewVelocity);
  let axis = select(vec2f(0.0, 1.0), viewVelocity / max(speedOnScreen, 1e-4), speedOnScreen > 1e-4);
  let stretch = min(speedOnScreen * 0.05, 1.6) * (1.0 - u) * hardness;
  let square = corner * size;
  let offset = square + axis * (dot(square, axis) * stretch);
  let viewCentre = uniforms.view * vec4f(centre, 1.0);
  var clip = uniforms.projection * (viewCentre + vec4f(offset, 0.0, 0.0));
  clip = select(clip, vec4f(0.0, 0.0, 2.0, 1.0), alpha < ${CAR_PARTICLE_MIN_VISIBLE_ALPHA});

  // The boat spray's light law on this particle's own albedo: the sunlit
  // fraction of a clump seen at phase angle acos(-mu), translucent by kind,
  // plus the sky, plus the forward glow of fine dust and drops against the sun.
  let rayDirection = toCentre / distanceMeters;
  let sunDirection = normalize(uniforms.aerialSunDirection);
  let mu = dot(rayDirection, sunDirection);
  let sun = uniforms.carSun * smoothstep(-0.02, 0.02, sunDirection.y);
  let phaseAngle = acos(clamp(-mu, -1.0, 1.0));
  let sunlit = (sin(phaseAngle) + (CAR_PI - phaseAngle) * cos(phaseAngle)) / CAR_PI;
  let translucency = recordE.z;
  let lit = translucency + (1.0 - translucency) * sunlit;
  let glow = recordE.y * 4.0 * CAR_PI * aerialMiePhase(mu, CAR_FORWARD_G);
  let radiance = recordD.xyz * (sun * lit + uniforms.carSky) + sun * glow;
  let haze = aerialPerspective(centre.y, distanceMeters, mu);
  let seed = fract(recordA.w * 7.137 + recordA.x * 1.913 + recordA.z * 3.71);

  vertexOutputs.position = clip;
  vertexOutputs.carCorner = corner;
  vertexOutputs.carColor = radiance * haze.transmittance + haze.inScatter;
  vertexOutputs.carFade = vec4f(alpha, seed, u, hardness);
}
`;

export const CAR_PARTICLE_FRAGMENT_WGSL = /* wgsl */ `
varying carCorner: vec2f;
varying carColor: vec3f;
varying carFade: vec4f;

fn carHash(cell: vec2i) -> f32 {
  var h = (bitcast<u32>(cell.x) * 0x8da6b343u) ^ (bitcast<u32>(cell.y) * 0xd8163841u);
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  h = h ^ (h >> 16u);
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

fn carValueNoise(p: vec2f) -> f32 {
  let cell = floor(p);
  let f = p - cell;
  let w = f * f * (vec2f(3.0) - 2.0 * f);
  let i = vec2i(cell);
  let bottom = mix(carHash(i), carHash(i + vec2i(1, 0)), w.x);
  let top = mix(carHash(i + vec2i(0, 1)), carHash(i + vec2i(1, 1)), w.x);
  return mix(bottom, top, w.y);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let radiusSquared = dot(fragmentInputs.carCorner, fragmentInputs.carCorner);
  if (radiusSquared >= 1.0) { discard; }
  // The spray's lumpy clump, by hardness: a soft puff is a wide, smooth
  // threshold that thins as it ages and spreads; a clod is a tight one with
  // a rough rim and a solid middle.
  let seed = fragmentInputs.carFade.y;
  let age = fragmentInputs.carFade.z;
  let hardness = fragmentInputs.carFade.w;
  let p = fragmentInputs.carCorner * 2.2 + vec2f(seed * 41.0, seed * 17.0 + age * 0.8);
  let noise = 0.62 * carValueNoise(p) + 0.38 * carValueNoise(p * 2.31 + vec2f(3.7, 9.1));
  let soft = 1.0 - hardness;
  let threshold = mix(0.05 + 0.4 * radiusSquared, 0.2 + 0.6 * radiusSquared, hardness) * (1.0 - 0.45 * age * soft);
  let width = mix(0.45, 0.1, hardness);
  let density = smoothstep(threshold, threshold + width, noise) * mix(1.0 - radiusSquared, 1.0, 0.6 * hardness);
  let alpha = fragmentInputs.carFade.x * density;
  if (alpha < ${CAR_PARTICLE_MIN_VISIBLE_ALPHA}) { discard; }
  fragmentOutputs.color = vec4f(max(fragmentInputs.carColor, vec3f(0.0)) * alpha, alpha);
}
`;
