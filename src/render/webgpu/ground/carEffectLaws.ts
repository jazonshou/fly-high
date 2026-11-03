import type { CarVisualState, FlightVisualState } from "@/src/game/types";
import { SurfaceMaterial } from "@/src/render/webgpu/terrain/surfaceMaterials";
import { axlePose, onAxle, type CarAxle } from "./carRunningGear";
import {
  BODY,
  LC76_FRONT_TRACK,
  LC76_REAR_TRACK,
  LC76_TYRE_LOADED_RADIUS,
  LC76_TYRE_WIDTH,
} from "./lc76Lines";

/**
 * The LandCruiser's effects, as laws: where each tyre meets the ground, and
 * what that ground gives off under it. Class P: pure numbers, no Babylon, so
 * the particle ring, the tracks and the bow wave (`CarEffects`) read one set
 * of answers and the tests read them too.
 *
 * WHAT THE GROUND GIVES OFF. Per `SurfaceMaterial`: how readily it lifts as
 * dust when dry (fine sand and volcanic ash most, a sward or a forest floor
 * hardly at all, a road almost never), how much of it a tyre flings as mud
 * once soaked, and how dark a print it keeps. Rock, lava and the paved
 * surfaces take no print. The dust's colour is the fine fraction of the
 * ground's own soil: lighter than the bulk ground, as fine grains scatter
 * more, and for the vegetated grounds the soil under the canopy rather than
 * the canopy's green. Wet soil darkens to about 40% of its dry albedo, the
 * measured range for loams and sands, and that is the mud's.
 */

/** How a ground responds to a tyre: dust when dry, mud when soaked, and its print. */
export interface CarSoilResponse {
  /** 0..1: how readily it lifts as dust when dry. */
  readonly dust: number;
  /** 0..1: how much a tyre flings once it is soaked. */
  readonly mud: number;
  /** 0..1: how much a tyre's print darkens it, before the rut's own depth. */
  readonly track: number;
  /** The dust's linear albedo. */
  readonly dustAlbedo: readonly [number, number, number];
}

const NO_SOIL: CarSoilResponse = Object.freeze({ dust: 0, mud: 0, track: 0, dustAlbedo: Object.freeze([0, 0, 0] as const) });

function soil(dust: number, mud: number, track: number, dustAlbedo: readonly [number, number, number]): CarSoilResponse {
  return Object.freeze({ dust, mud, track, dustAlbedo: Object.freeze(dustAlbedo) });
}

/** Indexed by `SurfaceMaterial` id. */
export const CAR_SOIL: readonly CarSoilResponse[] = Object.freeze([
  soil(1, 0.35, 0.16, [0.5, 0.43, 0.3]), // Sand
  soil(0.12, 0.75, 0.16, [0.3, 0.25, 0.18]), // Grass: the loam under the sward
  soil(0.22, 0.9, 0.2, [0.2, 0.16, 0.11]), // ForestFloor
  soil(0.55, 0.65, 0.18, [0.32, 0.27, 0.19]), // Shrub: the bare ground between the bushes
  soil(0.2, 0.1, 0, [0.3, 0.29, 0.27]), // Rock
  soil(0.6, 0.45, 0.3, [0.82, 0.84, 0.88]), // Snow: powder when cold, slush when wet
  soil(0.7, 0.6, 0.2, [0.36, 0.3, 0.2]), // DryGrass
  soil(0.75, 0.3, 0.12, [0.34, 0.31, 0.27]), // Gravel
  soil(0.02, 0, 0, [0.2, 0.2, 0.2]), // Asphalt
  soil(0.04, 0, 0, [0.34, 0.34, 0.33]), // Concrete
  soil(0.12, 0.05, 0, [0.12, 0.12, 0.12]), // Basalt
  soil(0.9, 0.35, 0.26, [0.16, 0.14, 0.13]), // Tephra: dark ash
]);

/**
 * A dust cloud is paler than the ground it rose from: mineral dust scatters
 * almost all the light it meets (a single-scattering albedo near 0.9) and a
 * cloud of it scatters many times, so a sand road's dust reads as a pale tan
 * haze and a forest track's as a grey-brown one. The cloud keeps its soil's
 * hue: the fine fraction's albedo brightened by `CAR_DUST_CLOUD_GAIN`, plus a
 * little grey (`CAR_DUST_CLOUD_FLOOR`) so the darkest soils' dust is not black.
 */
export const CAR_DUST_CLOUD_GAIN = 1.35;
export const CAR_DUST_CLOUD_FLOOR = 0.12;

/** A dust cloud's albedo, one channel, from the ground's fine fraction (`CarSoilResponse.dustAlbedo`). */
export function carDustCloudAlbedo(fine: number): number {
  return Math.min(0.9, CAR_DUST_CLOUD_GAIN * fine + CAR_DUST_CLOUD_FLOOR * (1 - fine));
}

/** Wet soil's albedo against its dry albedo. */
export const CAR_MUD_DARKENING = 0.4;
/** Spray and splash: white water, as the boat's spray clumps are (`SPRAY_ALBEDO`). */
export const CAR_WATER_ALBEDO = 0.62;
/** Diesel smoke: soot in a grey haze of condensate. */
export const CAR_SOOT_ALBEDO = 0.12;

/** The ground's response under a tyre, or none in water or the air. */
export function carSoil(surface: number | undefined): CarSoilResponse {
  if (surface === undefined || !Number.isInteger(surface) || surface < 0) return NO_SOIL;
  return CAR_SOIL[surface] ?? NO_SOIL;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function finite(value: number | undefined, fallback = 0): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

/** Where one tyre meets the ground, world metres. */
export interface CarWheelContact {
  /** The tyre's foot: the lowest point of the loaded tyre. */
  x: number;
  y: number;
  z: number;
  /** The undisturbed ground beside the rut: the foot raised by the tyre's sinkage. */
  surfaceY: number;
  /** The wheel's rolling direction over the ground, a unit vector in world x and z. */
  forwardX: number;
  forwardZ: number;
  /** The tyre carries load: it is on the ground (or the bed of a ford). */
  loaded: boolean;
}

export function createCarWheelContacts(): CarWheelContact[] {
  return [0, 1, 2, 3].map(() => ({ x: 0, y: 0, z: 0, surfaceY: 0, forwardX: 1, forwardZ: 0, loaded: false }));
}

/** A body-frame vector turned into the world by the snapshot's quaternion, written to `out`. */
export function rotateCarBodyToWorld(
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

const scratch = { x: 0, y: 0, z: 0 };

/**
 * Every tyre's foot in the world from the pose and the payload, by the drawn
 * running gear's own law (`axlePose`, `onAxle`): the wheel centre at the
 * axle's end, the foot the loaded radius below it in the axle's frame, so it
 * tilts with the axle's roll and the body's pitch. Allocation-free.
 */
export function carWheelContacts(
  state: Pick<FlightVisualState, "position" | "orientation">,
  car: Readonly<CarVisualState>,
  out: CarWheelContact[],
): CarWheelContact[] {
  for (let wheel = 0; wheel < 4; wheel += 1) {
    const axle: CarAxle = wheel < 2 ? "front" : "rear";
    const side = wheel % 2 === 0 ? -1 : 1;
    const track = axle === "front" ? LC76_FRONT_TRACK : LC76_REAR_TRACK;
    const foot = onAxle(axlePose(car, axle), [0, -LC76_TYRE_LOADED_RADIUS, (side * track) / 2]);
    rotateCarBodyToWorld(state.orientation, foot[0], foot[1], foot[2], scratch);
    const contact = out[wheel]!;
    contact.x = state.position.x + scratch.x;
    contact.y = state.position.y + scratch.y;
    contact.z = state.position.z + scratch.z;
    contact.surfaceY = contact.y + Math.max(0, finite(car.wheelSinkage[wheel]));
    // Positive steer turns the wheel's front to the right (+z).
    const steer = finite(car.wheelSteer[wheel]);
    rotateCarBodyToWorld(state.orientation, Math.cos(steer), 0, Math.sin(steer), scratch);
    const across = Math.hypot(scratch.x, scratch.z);
    contact.forwardX = across > 1e-6 ? scratch.x / across : 1;
    contact.forwardZ = across > 1e-6 ? scratch.z / across : 0;
    contact.loaded = finite(car.wheelLoad[wheel]) > 0;
  }
  return out;
}

/**
 * The water over each tyre's patch, metres, into `out`; returns the water's
 * level, or NaN out of water. `wadingDepth` is the water over the LOWEST
 * tyre's ground (the simulator's rule), so the level is that ground plus it,
 * and a tyre on higher ground (a bank) sits in less of it or none.
 */
export function carWheelWaterDepths(
  car: Readonly<CarVisualState>,
  contacts: readonly CarWheelContact[],
  out: number[],
): number {
  const wading = finite(car.wadingDepth);
  let lowest = Infinity;
  for (let wheel = 0; wheel < 4; wheel += 1) lowest = Math.min(lowest, contacts[wheel]!.surfaceY);
  const level = wading > 0 && Number.isFinite(lowest) ? lowest + wading : Number.NaN;
  for (let wheel = 0; wheel < 4; wheel += 1) {
    out[wheel] = Number.isNaN(level) ? 0 : Math.max(0, level - contacts[wheel]!.surfaceY);
  }
  return level;
}

/** How fast a tyre's tread slides over the ground, m/s: spinning or locked. */
export function carWheelSlipSpeed(car: Readonly<CarVisualState>, wheel: number): number {
  const tread = finite(car.wheelSpinRate[wheel]) * LC76_TYRE_LOADED_RADIUS;
  return Math.abs(tread - finite(car.speed));
}

/**
 * The wetness bands, on the scale the simulator's tyres report it: the land
 * cover's topographic soil moisture (`landCoverWetness`). Measured over the
 * perf seed's land, dry grass sits at 0.24-0.35 in the high desert and
 * 0.35-0.47 in the savanna, grass and forest floor at 0.48-0.70 in the
 * temperate, boreal and tundra provinces; the simulator turns loam to mud
 * from 0.6 to 0.9 (`MUD_WETNESS_LOW`/`HIGH`, src/sim/ground/surface.ts). So
 * the dry provinces lift full dust, temperate ground some and damp ground
 * none, and mud comes off only the ground the simulator drives as mud.
 */
export const CAR_DUST_WETNESS: readonly [number, number] = Object.freeze([0.45, 0.65]) as readonly [number, number];
export const CAR_MUD_WETNESS: readonly [number, number] = Object.freeze([0.6, 0.9]) as readonly [number, number];

/** How dry a soil is for dust: wet ground does not lift. */
function dryness(wetness: number): number {
  return 1 - smoothstep(CAR_DUST_WETNESS[0], CAR_DUST_WETNESS[1], wetness);
}

/** How hard the tyre works the ground: rolling speed, and slip, which digs at any speed. */
function working(speed: number, slipSpeed: number, rolling: readonly [number, number], slipWeight: number): number {
  return smoothstep(rolling[0], rolling[1], speed) + slipWeight * smoothstep(0.5, 5, slipSpeed);
}

/**
 * Dust off one tyre, 0..1: a dry, loose ground under a loaded tyre, more
 * with speed and with wheelspin, which digs at any speed.
 */
export function carDustIntensity(car: Readonly<CarVisualState>, wheel: number, waterDepth = 0): number {
  if (!(finite(car.wheelLoad[wheel]) > 0)) return 0;
  const ground = carSoil(car.wheelSurface[wheel]);
  if (ground.dust <= 0) return 0;
  const speed = Math.abs(finite(car.speed));
  const dry = dryness(finite(car.wheelWetness[wheel])) * (1 - smoothstep(0.005, 0.03, finite(waterDepth)));
  return clamp01(ground.dust * dry * working(speed, carWheelSlipSpeed(car, wheel), [1.5, 14], 0.7));
}

/** Mud flung by one tyre, 0..1: a soaked soil, more with speed and much more spinning. */
export function carMudIntensity(car: Readonly<CarVisualState>, wheel: number, waterDepth = 0): number {
  if (!(finite(car.wheelLoad[wheel]) > 0)) return 0;
  const ground = carSoil(car.wheelSurface[wheel]);
  if (ground.mud <= 0) return 0;
  const speed = Math.abs(finite(car.speed));
  // Under water a tyre throws water, not mud.
  const soaked = smoothstep(CAR_MUD_WETNESS[0], CAR_MUD_WETNESS[1], finite(car.wheelWetness[wheel]))
    * (1 - smoothstep(0.02, 0.08, finite(waterDepth)));
  return clamp01(ground.mud * soaked * working(speed, carWheelSlipSpeed(car, wheel), [3, 16], 1.7) * 0.6);
}

/**
 * Water thrown by one tyre, 0..1: a tyre turning in a ford (on its bed, under
 * water) throws spray with speed and wheelspin; a soaked road gives a fine
 * mist behind the tyres at speed. `waterDepth` is the water over this tyre's
 * patch (`carWheelWaterDepths`); a loaded tyre on surface -1 is in water by
 * the payload's own word, and reads the wading depth if that is deeper.
 */
export function carWaterIntensity(car: Readonly<CarVisualState>, wheel: number, waterDepth = 0): number {
  if (!(finite(car.wheelLoad[wheel]) > 0)) return 0;
  const speed = Math.abs(finite(car.speed));
  const surface = car.wheelSurface[wheel];
  const depth = Math.max(finite(waterDepth), surface === -1 ? finite(car.wadingDepth) : 0);
  if (depth > 0) {
    const immersed = smoothstep(0.03, 0.3, depth);
    return clamp01(immersed * working(speed, carWheelSlipSpeed(car, wheel), [0.8, 6], 0.6));
  }
  if (surface === SurfaceMaterial.Asphalt || surface === SurfaceMaterial.Concrete) {
    return 0.6 * smoothstep(0.5, 0.9, finite(car.wheelWetness[wheel])) * smoothstep(8, 25, speed);
  }
  return 0;
}

/** The splash off the leading bumper wading, 0..1: deep enough to push water, fast enough to throw it. */
export function carBowIntensity(car: Readonly<CarVisualState>): number {
  return smoothstep(0.15, 0.5, finite(car.wadingDepth)) * smoothstep(0.8, 3.5, Math.abs(finite(car.speed)));
}

/**
 * Soot from the tailpipe, 0..1: a diesel under load smokes most while the
 * turbo has not yet spooled (fuel ahead of air), and hardly at all on full
 * boost or off the throttle.
 */
export function carExhaustSoot(car: Readonly<CarVisualState>, throttle: number): number {
  if (!car.engineRunning) return 0;
  const load = clamp01(finite(throttle));
  const boost = clamp01(finite(car.boost));
  return clamp01(smoothstep(0.15, 0.5, load) * load * (0.2 + 0.8 * (1 - boost)));
}

/** A tyre's print: how dark, and how wide. */
export interface CarTrackMark {
  darkness: number;
  halfWidth: number;
}

/** Below this a print is not laid. */
export const CAR_TRACK_MIN_DARKNESS = 0.02;
/** The darkest a print gets: a deep wet rut in its own shadow. */
export const CAR_TRACK_MAX_DARKNESS = 0.55;

/**
 * One tyre's print: the ground's own (a crushed sward, compacted sand), darker
 * wet, and darker and wider the deeper the tyre sinks, as a rut's walls
 * shadow its floor and the displaced soil bulges out either side. Zero in
 * water, in the air, and on rock and paving unless the tyre sinks.
 */
export function carTrackMark(car: Readonly<CarVisualState>, wheel: number, out: CarTrackMark): CarTrackMark {
  out.darkness = 0;
  out.halfWidth = LC76_TYRE_WIDTH / 2;
  const surface = car.wheelSurface[wheel];
  if (!(finite(car.wheelLoad[wheel]) > 0) || surface === undefined || surface < 0) return out;
  const ground = carSoil(surface);
  const sinkage = Math.max(0, finite(car.wheelSinkage[wheel]));
  const rut = smoothstep(0.005, 0.08, sinkage);
  if (ground.track <= 0 && rut <= 0) return out;
  // Damper than the ordinary ground darkens the print, up to soaked.
  const wet = smoothstep(CAR_DUST_WETNESS[0], CAR_MUD_WETNESS[1], finite(car.wheelWetness[wheel]));
  out.darkness = Math.min(CAR_TRACK_MAX_DARKNESS, ground.track * (1 + 0.8 * wet) + 0.22 * rut);
  out.halfWidth = (LC76_TYRE_WIDTH / 2) * (1 + 0.5 * smoothstep(0.01, 0.1, sinkage));
  return out;
}

/** The leading bumper's station: the front one going forward, the rear one reversing. */
export function carLeadingBumperX(speed: number): number {
  return speed < 0 ? BODY.bumperRear : BODY.bumperFront;
}
