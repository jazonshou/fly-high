import {
  PERSON_SURFACE_COLLIDER_BASE,
  PERSON_SURFACE_WATER,
  type PersonVisualState,
} from "@/src/game/types";
import { SurfaceMaterial } from "@/src/render/webgpu/terrain/surfaceMaterials";
import { CAR_COLLIDER_MATERIAL } from "@/src/sim/ground/carColliders";
import { MARINA_COLLIDER_MATERIAL } from "@/src/sim/marina/colliders";
import { PARKED_CAR_COLLIDER_MATERIAL } from "@/src/sim/person/types";

/**
 * The walker's sounds (the walking plan's "Start, controls, HUD, sound"),
 * built the first time a walker's state arrives, like the car's layer:
 *
 *  - FOOTSTEPS, one per foot strike the drawn figure reports
 *    (`PersonAnimationOutput`), so the sound lands with the foot. Each is a
 *    short burst of filtered noise voiced by what is underfoot
 *    (`PersonVisualState.surface`): a tap on asphalt and concrete, a crunch
 *    of grains on gravel, tephra and snow, a soft scuff on sand, a swish
 *    through grass and leaf litter, a dull knock on rock, a hollow knock on
 *    timber and pontoons, a ring on steel, and a splash once the foot is in
 *    water. A low thud of the body's weight sits under every one.
 *  - BREATHING, heard only after a while running or swimming: the effort
 *    builds over about 25 s of running and fades over about 15 s at rest,
 *    and the breaths come faster with it. None while the head is under, and
 *    a gasp on surfacing from a long dive.
 *  - STROKES while swimming: a splash per stroke at the surface, a muffled
 *    rush under it, at a rate that grows with speed.
 *  - LANDINGS: a thump after a fall, harder with the landing speed.
 *
 * The laws are pure functions so they can be tested without an audio
 * device. As the car's sounds, nothing goes above 1.2 kHz, and the levels sit
 * under the engine's.
 */

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** The highest any of the walker's filters goes, Hz (the car's ceiling). */
export const PERSON_SOUND_CEILING_HZ = 1_200;

/** A footstep's recipe: noise through one filter, dying away, in one or more grains, over a falling sine thud. */
export interface PersonStepVoice {
  readonly name: "tap" | "crunch" | "scuff" | "swish" | "knock" | "hollow" | "ring" | "splash";
  readonly filter: BiquadFilterType;
  readonly hertz: number;
  readonly q: number;
  /** How long the burst takes to die away, seconds. */
  readonly length: number;
  /** Bursts per step, spread over `spread` seconds (gravel's grains). */
  readonly grains: number;
  readonly spread: number;
  /** Relative level, 0..1. */
  readonly level: number;
  /** The body's thud under it, Hz at the start (it falls an octave); 0 for none. */
  readonly bodyHz: number;
}

const STEP_VOICES = {
  tap: { name: "tap", filter: "bandpass", hertz: 1_050, q: 1.4, length: 0.06, grains: 1, spread: 0, level: 0.8, bodyHz: 85 },
  crunch: { name: "crunch", filter: "bandpass", hertz: 950, q: 1.1, length: 0.045, grains: 4, spread: 0.07, level: 0.7, bodyHz: 70 },
  scuff: { name: "scuff", filter: "lowpass", hertz: 520, q: 0.6, length: 0.13, grains: 1, spread: 0, level: 0.55, bodyHz: 60 },
  swish: { name: "swish", filter: "bandpass", hertz: 760, q: 0.8, length: 0.1, grains: 2, spread: 0.035, level: 0.5, bodyHz: 65 },
  knock: { name: "knock", filter: "bandpass", hertz: 620, q: 1.2, length: 0.07, grains: 1, spread: 0, level: 0.75, bodyHz: 80 },
  hollow: { name: "hollow", filter: "bandpass", hertz: 310, q: 4, length: 0.16, grains: 1, spread: 0, level: 0.9, bodyHz: 110 },
  ring: { name: "ring", filter: "bandpass", hertz: 540, q: 9, length: 0.28, grains: 1, spread: 0, level: 0.6, bodyHz: 95 },
  splash: { name: "splash", filter: "lowpass", hertz: 900, q: 0.7, length: 0.24, grains: 2, spread: 0.05, level: 0.8, bodyHz: 50 },
} as const satisfies Record<PersonStepVoice["name"], PersonStepVoice>;

/** Water this deep round the feet splashes rather than voicing the ground, metres. */
export const PERSON_STEP_SPLASH_DEPTH = 0.06;

/** The footstep for what is underfoot: a `PersonVisualState.surface`, and the water round the feet. Null in the air. */
export function personStepVoice(surface: number, waterDepth = 0): PersonStepVoice | null {
  if (surface === PERSON_SURFACE_WATER || waterDepth >= PERSON_STEP_SPLASH_DEPTH) return STEP_VOICES.splash;
  if (surface >= PERSON_SURFACE_COLLIDER_BASE) {
    switch (surface - PERSON_SURFACE_COLLIDER_BASE) {
      case MARINA_COLLIDER_MATERIAL.timber:
      case MARINA_COLLIDER_MATERIAL.pontoon:
      case MARINA_COLLIDER_MATERIAL.hull:
        return STEP_VOICES.hollow;
      case MARINA_COLLIDER_MATERIAL.steel:
      case CAR_COLLIDER_MATERIAL.guardrail:
      case PARKED_CAR_COLLIDER_MATERIAL:
        return STEP_VOICES.ring;
      default:
        // Buildings and the quay: concrete.
        return STEP_VOICES.tap;
    }
  }
  switch (surface) {
    case SurfaceMaterial.Asphalt:
    case SurfaceMaterial.Concrete:
      return STEP_VOICES.tap;
    case SurfaceMaterial.Gravel:
    case SurfaceMaterial.Tephra:
    case SurfaceMaterial.Snow:
      return STEP_VOICES.crunch;
    case SurfaceMaterial.Sand:
      return STEP_VOICES.scuff;
    case SurfaceMaterial.Grass:
    case SurfaceMaterial.DryGrass:
    case SurfaceMaterial.Shrub:
    case SurfaceMaterial.ForestFloor:
      return STEP_VOICES.swish;
    case SurfaceMaterial.Rock:
    case SurfaceMaterial.Basalt:
      return STEP_VOICES.knock;
    default:
      return null;
  }
}

/** Seconds of running to full effort, and of rest to none. */
const EFFORT_RUN_SECONDS = 25;
const EFFORT_SWIM_SECONDS = 40;
const EFFORT_REST_SECONDS = 15;

/**
 * How hard the walker is working, 0..1: it builds while running or swimming
 * (slower), holds while walking, and fades at rest.
 */
export class PersonEffort {
  value = 0;

  step(person: Readonly<PersonVisualState>, seconds: number): number {
    const dt = Math.min(0.5, Math.max(0, Number.isFinite(seconds) ? seconds : 0));
    const moving = person.speed > 0.3;
    if (person.mode === "run" || (person.running && moving && person.mode !== "swim" && person.mode !== "dive")) {
      this.value += dt / EFFORT_RUN_SECONDS;
    } else if ((person.mode === "swim" || person.mode === "dive") && moving) {
      this.value += dt / EFFORT_SWIM_SECONDS;
    } else if (person.mode !== "walk" && person.mode !== "wade") {
      this.value -= dt / EFFORT_REST_SECONDS;
    }
    this.value = clamp01(this.value);
    return this.value;
  }
}

/** Breaths a second at an effort: 15 a minute at rest to 42 at full effort. */
export function breathRateHz(effort: number): number {
  return 0.25 + 0.45 * clamp01(effort);
}

/** How loud the breathing is at an effort: silent until the walker has worked a while. */
export function breathLevel(effort: number): number {
  return smoothstep(0.15, 1, effort);
}

/** Strokes a second at a swimming speed (m/s): an easy breaststroke's 0.5 to a crawl's 1.0. */
export function strokeRateHz(speed: number): number {
  return 0.5 + 0.5 * smoothstep(0.2, 1.6, Math.abs(Number.isFinite(speed) ? speed : 0));
}

/** Landings slower than this make no thump, m/s. */
export const PERSON_LANDING_THUMP_SPEED = 2.5;

const STEP_LEVEL = 0.05;
const BREATH_LEVEL = 0.03;
const STROKE_LEVEL = 0.045;
const LANDING_LEVEL = 0.09;

export class PersonVoice {
  private readonly context: AudioContext;
  private readonly destination: AudioNode;
  private readonly noise: AudioBuffer;
  private readonly effort = new PersonEffort();
  private lastTime = Number.NaN;
  private nextBreath = 0;
  private nextStroke = 0;
  private lastLandingAge = Number.POSITIVE_INFINITY;
  private headUnderSince = Number.NaN;
  private random = 0x2545f491;

  /** `noise` is the graph's looping white-noise buffer. */
  constructor(context: AudioContext, destination: AudioNode, noise: AudioBuffer) {
    this.context = context;
    this.destination = destination;
    this.noise = noise;
  }

  /** A foot struck: `strength` 0..1 as the figure reports it (a walk about 0.4, a run 0.8). */
  step(person: Readonly<PersonVisualState>, strength: number, levels: { wind: number }): void {
    const voice = personStepVoice(person.surface, person.waterDepth);
    if (!voice) return;
    const now = this.context.currentTime;
    const level = levels.wind * STEP_LEVEL * voice.level * (0.35 + 0.65 * clamp01(strength));
    for (let grain = 0; grain < voice.grains; grain += 1) {
      const at = now + (voice.grains > 1 ? (grain / (voice.grains - 1)) * voice.spread * (0.7 + 0.6 * this.nextRandom()) : 0);
      this.burst(at, level * (grain === 0 ? 1 : 0.6), voice.filter, voice.hertz * (0.9 + 0.2 * this.nextRandom()), voice.q, voice.length, grain === 0 ? voice.bodyHz : 0);
    }
  }

  /** This frame's walker: breathing, strokes and landings. */
  update(person: Readonly<PersonVisualState>, levels: { wind: number }): void {
    const now = this.context.currentTime;
    const dt = Number.isFinite(this.lastTime) ? now - this.lastTime : 0;
    this.lastTime = now;
    const effort = this.effort.step(person, dt);
    const headUnder = person.headDepth > 0.05;

    // Breathing, with the head out; a gasp on surfacing from a long dive.
    if (headUnder) {
      if (!Number.isFinite(this.headUnderSince)) this.headUnderSince = now;
    } else {
      if (Number.isFinite(this.headUnderSince) && now - this.headUnderSince > 3) {
        this.breath(now, levels.wind * BREATH_LEVEL * 1.6, 0.5);
        this.nextBreath = now + 1.2;
      }
      this.headUnderSince = Number.NaN;
      const loudness = breathLevel(effort);
      if (loudness > 0.01 && now >= this.nextBreath) {
        const period = 1 / breathRateHz(effort);
        this.breath(now, levels.wind * BREATH_LEVEL * loudness, period);
        this.nextBreath = now + period * (0.92 + 0.16 * this.nextRandom());
      }
    }

    // Strokes while swimming or diving and moving.
    const swimming = (person.mode === "swim" || person.mode === "dive") && person.speed > 0.15;
    if (swimming && now >= this.nextStroke) {
      const share = smoothstep(0.15, 1.4, person.speed);
      if (headUnder) {
        this.burst(now, levels.wind * STROKE_LEVEL * 0.6 * share, "lowpass", 280, 0.7, 0.35, 0);
      } else {
        this.burst(now, levels.wind * STROKE_LEVEL * share, "lowpass", 850, 0.7, 0.26, 0);
        this.burst(now + 0.08, levels.wind * STROKE_LEVEL * 0.5 * share, "bandpass", 600, 1, 0.18, 0);
      }
      this.nextStroke = now + 1 / strokeRateHz(person.speed);
    } else if (!swimming) {
      this.nextStroke = Math.max(this.nextStroke, now);
    }

    // A landing: its age restarts.
    if (person.landingAge < this.lastLandingAge && person.landingSpeed >= PERSON_LANDING_THUMP_SPEED) {
      const hard = smoothstep(PERSON_LANDING_THUMP_SPEED, 9, person.landingSpeed);
      const water = person.surface === PERSON_SURFACE_WATER || person.waterDepth > 0.3;
      if (water) this.burst(now, levels.wind * LANDING_LEVEL * hard, "lowpass", 700, 0.7, 0.5, 45);
      else this.burst(now, levels.wind * LANDING_LEVEL * hard, "lowpass", 220, 0.7, 0.18, 60);
    }
    this.lastLandingAge = person.landingAge;
  }

  /** The walker is away (in the car, or the menu): reset what carries over. */
  silence(): void {
    this.effort.value = 0;
    this.lastTime = Number.NaN;
    this.headUnderSince = Number.NaN;
    this.lastLandingAge = Number.POSITIVE_INFINITY;
  }

  /** An inhale then an exhale over `period` seconds: noise through the mouth's band, rising then falling. */
  private breath(now: number, level: number, period: number): void {
    if (level <= 1e-4) return;
    const inhale = Math.min(0.9, period * 0.38);
    const exhale = Math.min(1.1, period * 0.45);
    this.shaped(now, level * 0.7, 560, inhale);
    this.shaped(now + inhale + period * 0.05, level, 420, exhale);
  }

  /** Noise through a band, swelling over the first third and dying over the rest. */
  private shaped(at: number, level: number, hertz: number, length: number): void {
    const context = this.context;
    const noise = context.createBufferSource();
    noise.buffer = this.noise;
    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = Math.min(PERSON_SOUND_CEILING_HZ, hertz);
    filter.Q.value = 0.9;
    const gain = context.createGain();
    gain.gain.setValueAtTime(1e-4, at);
    gain.gain.linearRampToValueAtTime(level, at + length * 0.33);
    gain.gain.exponentialRampToValueAtTime(1e-4, at + length);
    noise.connect(filter).connect(gain).connect(this.destination);
    noise.start(at, this.nextRandom() * 1.5);
    noise.stop(at + length + 0.02);
  }

  /** One burst of filtered noise dying over `length` seconds, over a falling sine thud when `bodyHz` is given. */
  private burst(at: number, level: number, type: BiquadFilterType, hertz: number, q: number, length: number, bodyHz: number): void {
    if (level <= 1e-4) return;
    const context = this.context;
    const noise = context.createBufferSource();
    noise.buffer = this.noise;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = Math.min(PERSON_SOUND_CEILING_HZ, hertz);
    filter.Q.value = q;
    const gain = context.createGain();
    gain.gain.setValueAtTime(level, at);
    gain.gain.exponentialRampToValueAtTime(1e-4, at + length);
    noise.connect(filter).connect(gain).connect(this.destination);
    noise.start(at, this.nextRandom() * 1.5);
    noise.stop(at + length + 0.02);
    if (bodyHz <= 0) return;
    const body = context.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(bodyHz, at);
    body.frequency.exponentialRampToValueAtTime(bodyHz * 0.5, at + length);
    const bodyGain = context.createGain();
    bodyGain.gain.setValueAtTime(level * 0.9, at);
    bodyGain.gain.exponentialRampToValueAtTime(1e-4, at + length);
    body.connect(bodyGain).connect(this.destination);
    body.start(at);
    body.stop(at + length + 0.02);
  }

  /** xorshift32, 0..1. */
  private nextRandom(): number {
    let x = this.random;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.random = x >>> 0;
    return this.random / 2 ** 32;
  }
}
