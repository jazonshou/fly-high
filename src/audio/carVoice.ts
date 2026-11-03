import type { CarVisualState, FlightVisualState } from "@/src/game/types";
import { SurfaceMaterial } from "@/src/render/webgpu/terrain/surfaceMaterials";

/**
 * The LandCruiser's own sounds, layered over the engine voice `FlightAudio`
 * already has (the catalogue's rpm / 30 firing note: a four-cylinder
 * four-stroke fires twice per crank turn, 25 Hz at the 750 rpm idle and
 * about 113 Hz at 3,400 rpm, a sawtooth with its harmonics and a square
 * second). Built the first time a car's state arrives, so an aircraft or a
 * boat session's audio graph is the one it always was.
 *
 *  - THE DIESEL. Each firing knocks: band-passed noise gated by a narrow
 *    pulse once per firing, loudest at idle and under load at low rpm, where
 *    a diesel clatters, and buried by the note as the revs rise.
 *  - THE TURBO. A whistle that rises in pitch and level with boost.
 *  - LOW RANGE. The transfer case's gear whine, in 4L only, its pitch the
 *    gear mesh's: road speed through the final drive and the 2.488 low ratio.
 *  - THE TYRES, by the material under each (`wheelSurface`): a hiss on
 *    asphalt and concrete, a crunch on gravel and tephra whose grains come
 *    faster with speed, a soft rush on sand and snow, a low rumble on soil
 *    and rock, and a squeal when a tyre slides on a hard surface.
 *  - WATER. A rush round the wheels while wading, growing with depth and
 *    speed.
 *  - EVENTS, from the payload's peaks: bump-stop knocks, body scrapes and
 *    splashes. The peaks are per snapshot, and audio updates less often than
 *    snapshots arrive, so `FlightAudio.observe` keeps the largest of each
 *    between updates (`CarEventPeaks`).
 *
 * The laws are pure functions of the state (`carSoundTargets`) so they can be
 * tested without an audio device. Every level sits under the engine's own,
 * and no filter or tone goes above 1.2 kHz: Jason found the engines too
 * high-pitched once (2026-09-29).
 */

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** The highest any of the car's tones or filters goes, Hz. */
export const CAR_SOUND_CEILING_HZ = 1_200;

/** The firing rate of the 1GD's four cylinders: two firings per crank turn. */
export function carFiringHz(engineRpm: number): number {
  return Math.max(0, finite(engineRpm)) / 30;
}

/** The low range's gear mesh: final drive, transfer low and about 30 teeth on the driven gear. */
const LOW_RANGE_MESH_PER_WHEEL_TURN = 4.3 * 2.488 * 30;

/** How each surface sounds under a rolling tyre. */
export type CarTyreVoice = "hiss" | "crunch" | "rush" | "rumble";

/** The voice of each `SurfaceMaterial` id; -1 (water, the air) has none. */
export function carTyreVoice(surface: number): CarTyreVoice | null {
  switch (surface) {
    case SurfaceMaterial.Asphalt:
    case SurfaceMaterial.Concrete:
      return "hiss";
    case SurfaceMaterial.Gravel:
    case SurfaceMaterial.Tephra:
      return "crunch";
    case SurfaceMaterial.Sand:
    case SurfaceMaterial.Snow:
      return "rush";
    case SurfaceMaterial.Grass:
    case SurfaceMaterial.ForestFloor:
    case SurfaceMaterial.Shrub:
    case SurfaceMaterial.DryGrass:
    case SurfaceMaterial.Rock:
    case SurfaceMaterial.Basalt:
      return "rumble";
    default:
      return null;
  }
}

export interface CarSoundTargets {
  /** The engine voice's level, as a share of what `FlightAudio` would give it: 0 with the engine stopped. */
  readonly engineShare: number;
  /** Clatter level, 0..1, and the firing rate that gates it, Hz. */
  readonly clatterGain: number;
  readonly firingHz: number;
  /** Turbo whistle level, 0..1, and pitch, Hz. */
  readonly turboGain: number;
  readonly turboHz: number;
  /** Low-range gear whine level, 0..1, and pitch, Hz. */
  readonly whineGain: number;
  readonly whineHz: number;
  /** Tyre noise levels, 0..1, each summed over the tyres on that kind of ground. */
  readonly hissGain: number;
  readonly crunchGain: number;
  /** How many grains of gravel a second each tyre crunches. */
  readonly crunchGrainHz: number;
  readonly rushGain: number;
  readonly rumbleGain: number;
  /** A tyre sliding on a hard surface, 0..1. */
  readonly squealGain: number;
  /** Water round the wheels, 0..1. */
  readonly wadeGain: number;
}

/** What the car sounds like in this state. */
export function carSoundTargets(state: Readonly<FlightVisualState>, car: Readonly<CarVisualState>): CarSoundTargets {
  const rpm = Math.max(0, finite(state.engineRpm));
  const load = clamp01(state.throttle);
  const speed = Math.abs(finite(car.speed));
  // Running, or cranking: the starter turns it over at a couple of hundred rpm, quietly.
  const engineShare = car.engineRunning ? 1 : 0.35 * smoothstep(80, 400, rpm);
  const running = car.engineRunning ? 1 : 0;
  const firingHz = carFiringHz(rpm);
  // A diesel clatters at idle and when it labours low down; revs bury it.
  const clatterGain = running * (0.55 + 0.45 * load) * (1 - 0.6 * smoothstep(1_400, 3_200, rpm));
  const boost = clamp01(car.boost);
  const turboGain = running * boost * boost * smoothstep(1_000, 2_200, rpm);
  const turboHz = Math.min(CAR_SOUND_CEILING_HZ, 420 + 640 * boost);

  let spin = 0;
  for (const rate of car.wheelSpinRate) spin += Math.abs(finite(rate));
  spin /= Math.max(1, car.wheelSpinRate.length);
  const lowRange = car.range === "4L" ? 1 : 0;
  const whineHz = Math.min(CAR_SOUND_CEILING_HZ, (spin / (2 * Math.PI)) * LOW_RANGE_MESH_PER_WHEEL_TURN);
  const whineGain = lowRange * smoothstep(0.5, 4, spin) * (0.5 + 0.5 * load);

  let hiss = 0;
  let crunch = 0;
  let rush = 0;
  let rumble = 0;
  let squeal = 0;
  const tyres = Math.max(1, car.wheelSurface.length);
  for (let wheel = 0; wheel < car.wheelSurface.length; wheel += 1) {
    if (!(finite(car.wheelLoad[wheel] ?? 0) > 0)) continue;
    const voice = carTyreVoice(car.wheelSurface[wheel] ?? -1);
    const rolling = Math.abs(finite(car.wheelSpinRate[wheel] ?? 0)) * 0.37;
    const slip = clamp01(car.wheelSlip[wheel] ?? 0);
    const share = 1 / tyres;
    if (voice === "hiss") {
      hiss += share * smoothstep(1, 25, rolling);
      squeal += share * smoothstep(0.35, 0.8, slip) * smoothstep(1, 6, Math.max(rolling, speed));
    } else if (voice === "crunch") {
      crunch += share * smoothstep(0.3, 12, rolling) * (1 + 0.5 * slip);
    } else if (voice === "rush") {
      rush += share * smoothstep(0.5, 15, rolling) * (1 + 0.6 * slip);
    } else if (voice === "rumble") {
      rumble += share * smoothstep(0.5, 18, rolling) * (1 + 0.3 * slip);
    }
  }
  const crunchGrainHz = Math.min(90, 5 + 4.5 * speed);
  const wadeGain = smoothstep(0.03, 0.6, car.wadingDepth) * smoothstep(0.2, 4, speed);
  return {
    engineShare,
    clatterGain,
    firingHz,
    turboGain,
    turboHz,
    whineGain,
    whineHz,
    hissGain: Math.min(1, hiss),
    crunchGain: Math.min(1, crunch),
    crunchGrainHz,
    rushGain: Math.min(1, rush),
    rumbleGain: Math.min(1, rumble),
    squealGain: Math.min(1, squeal),
    wadeGain,
  };
}

/** Below these the payload's peaks are noise, not an event. */
const KNOCK_THRESHOLD = 0.08;
const SCRAPE_THRESHOLD = 0.08;
const SPLASH_THRESHOLD = 0.08;

/**
 * The payload's event peaks (bump stop, scrape, splash), kept at their
 * largest from every snapshot until the audio takes them, so a peak on a
 * snapshot the audio skipped is still heard.
 */
export class CarEventPeaks {
  bumpStop = 0;
  scrape = 0;
  splash = 0;

  observe(car: Readonly<CarVisualState>): void {
    this.bumpStop = Math.max(this.bumpStop, clamp01(car.bumpStop));
    this.scrape = Math.max(this.scrape, clamp01(car.scrape));
    this.splash = Math.max(this.splash, clamp01(car.splash));
  }

  /** The events since the last take, as 0..1 strengths (0: none), and a fresh start. */
  take(): { knock: number; scrape: number; splash: number } {
    const events = {
      knock: this.bumpStop >= KNOCK_THRESHOLD ? this.bumpStop : 0,
      scrape: this.scrape >= SCRAPE_THRESHOLD ? this.scrape : 0,
      splash: this.splash >= SPLASH_THRESHOLD ? this.splash : 0,
    };
    this.reset();
    return events;
  }

  reset(): void {
    this.bumpStop = 0;
    this.scrape = 0;
    this.splash = 0;
  }
}

/** Levels against the engine's own, at full strength of each law. */
const CLATTER_LEVEL = 0.07;
const TURBO_LEVEL = 0.03;
const WHINE_LEVEL = 0.03;
const HISS_LEVEL = 0.07;
const CRUNCH_LEVEL = 0.12;
const RUSH_LEVEL = 0.08;
const RUMBLE_LEVEL = 0.1;
const SQUEAL_LEVEL = 0.035;
const WADE_LEVEL = 0.16;
const KNOCK_LEVEL = 0.22;
const SCRAPE_LEVEL = 0.12;
const SPLASH_LEVEL = 0.22;

/** A pulse at the end of each cycle of a sawtooth: 0 for most of the cycle, up to 1 for its last 15%. */
function pulseCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(256);
  for (let index = 0; index < curve.length; index += 1) {
    const x = (index / (curve.length - 1)) * 2 - 1;
    curve[index] = smoothstep(0.7, 0.95, x);
  }
  return curve;
}

/**
 * The car's layer of the audio graph. `FlightAudio` owns the context, the
 * master bus and the engine voice; the clatter and the crunch gate a shared
 * noise source with pulse trains (a sawtooth through a pulse-shaping curve),
 * so a firing or a grain costs nothing per event.
 */
export class CarVoice {
  private readonly context: AudioContext;
  private readonly destination: AudioNode;
  private readonly noise: AudioBuffer;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly firing: OscillatorNode;
  private readonly clatterGain: GainNode;
  private readonly turbo: OscillatorNode;
  private readonly turboGain: GainNode;
  private readonly whine: OscillatorNode;
  private readonly whineGain: GainNode;
  private readonly hissGain: GainNode;
  private readonly grains: OscillatorNode[] = [];
  private readonly crunchGain: GainNode;
  private readonly rushGain: GainNode;
  private readonly rumbleGain: GainNode;
  private readonly squeal: OscillatorNode;
  private readonly squealGain: GainNode;
  private readonly wadeGain: GainNode;
  private readonly gains: GainNode[];
  readonly peaks = new CarEventPeaks();
  private lastKnockTime = -1;
  private random = 0x6d2b79f5;

  /** `noise` is the graph's looping white-noise buffer. */
  constructor(context: AudioContext, destination: AudioNode, noise: AudioBuffer) {
    this.context = context;
    this.destination = destination;
    this.noise = noise;
    const curve = pulseCurve();

    const source = context.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    source.start();
    this.sources.push(source);
    const band = (type: BiquadFilterType, hertz: number, q: number): BiquadFilterNode => {
      const filter = context.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = hertz;
      filter.Q.value = q;
      return filter;
    };
    const silent = (): GainNode => {
      const gain = context.createGain();
      gain.gain.value = 0;
      return gain;
    };
    const tone = (type: OscillatorType, hertz: number): OscillatorNode => {
      const oscillator = context.createOscillator();
      oscillator.type = type;
      oscillator.frequency.value = hertz;
      oscillator.start();
      this.sources.push(oscillator);
      return oscillator;
    };
    const pulses = (oscillator: OscillatorNode, gate: GainNode): void => {
      const shaper = context.createWaveShaper();
      shaper.curve = curve;
      oscillator.connect(shaper).connect(gate.gain);
    };

    // The clatter: noise through the knock's band, opened once per firing.
    this.firing = tone("sawtooth", 25);
    const clatterGate = silent();
    pulses(this.firing, clatterGate);
    this.clatterGain = silent();
    source.connect(band("bandpass", 1_000, 1.3)).connect(clatterGate).connect(this.clatterGain).connect(destination);

    this.turbo = tone("sine", 420);
    this.turboGain = silent();
    this.turbo.connect(this.turboGain).connect(destination);

    this.whine = tone("triangle", 200);
    this.whineGain = silent();
    this.whine.connect(band("lowpass", CAR_SOUND_CEILING_HZ, 0.6)).connect(this.whineGain).connect(destination);

    this.hissGain = silent();
    source.connect(band("bandpass", 850, 0.7)).connect(this.hissGain).connect(destination);

    // The crunch: two grain trains at unrelated rates, so the grains fall unevenly.
    const crunchGate = silent();
    for (let index = 0; index < 2; index += 1) {
      const grain = tone("sawtooth", 10);
      pulses(grain, crunchGate);
      this.grains.push(grain);
    }
    this.crunchGain = silent();
    source.connect(band("bandpass", 650, 0.9)).connect(crunchGate).connect(this.crunchGain).connect(destination);

    this.rushGain = silent();
    source.connect(band("lowpass", 380, 0.5)).connect(this.rushGain).connect(destination);
    this.rumbleGain = silent();
    source.connect(band("lowpass", 160, 0.7)).connect(this.rumbleGain).connect(destination);

    this.squeal = tone("triangle", 690);
    this.squealGain = silent();
    this.squeal.connect(this.squealGain).connect(destination);

    this.wadeGain = silent();
    source.connect(band("bandpass", 420, 0.6)).connect(this.wadeGain).connect(destination);

    this.gains = [
      this.clatterGain, this.turboGain, this.whineGain, this.hissGain, this.crunchGain,
      this.rushGain, this.rumbleGain, this.squealGain, this.wadeGain,
    ];
  }

  /** This frame's car, as `carSoundTargets` hears it. */
  update(targets: Readonly<CarSoundTargets>, levels: { engine: number; wind: number }): void {
    const now = this.context.currentTime;
    this.firing.frequency.setTargetAtTime(Math.max(1, targets.firingHz), now, 0.04);
    this.clatterGain.gain.setTargetAtTime(levels.engine * CLATTER_LEVEL * targets.clatterGain, now, 0.08);
    this.turbo.frequency.setTargetAtTime(targets.turboHz, now, 0.12);
    this.turboGain.gain.setTargetAtTime(levels.engine * TURBO_LEVEL * targets.turboGain, now, 0.15);
    this.whine.frequency.setTargetAtTime(Math.max(20, targets.whineHz), now, 0.05);
    this.whineGain.gain.setTargetAtTime(levels.engine * WHINE_LEVEL * targets.whineGain, now, 0.1);
    this.hissGain.gain.setTargetAtTime(levels.wind * HISS_LEVEL * targets.hissGain, now, 0.1);
    this.grains[0]!.frequency.setTargetAtTime(targets.crunchGrainHz, now, 0.1);
    this.grains[1]!.frequency.setTargetAtTime(targets.crunchGrainHz * 1.618, now, 0.1);
    this.crunchGain.gain.setTargetAtTime(levels.wind * CRUNCH_LEVEL * targets.crunchGain, now, 0.1);
    this.rushGain.gain.setTargetAtTime(levels.wind * RUSH_LEVEL * targets.rushGain, now, 0.12);
    this.rumbleGain.gain.setTargetAtTime(levels.wind * RUMBLE_LEVEL * targets.rumbleGain, now, 0.1);
    this.squealGain.gain.setTargetAtTime(levels.wind * SQUEAL_LEVEL * targets.squealGain, now, 0.05);
    this.wadeGain.gain.setTargetAtTime(levels.wind * WADE_LEVEL * targets.wadeGain, now, 0.12);
    const events = this.peaks.take();
    // Bump stops come in pairs and trains over rough ground; one knock per 0.1 s.
    if (events.knock > 0 && now - this.lastKnockTime >= 0.1) {
      this.lastKnockTime = now;
      this.burst(now, levels.wind * KNOCK_LEVEL * events.knock, "lowpass", 220, 0.09, 64);
    }
    if (events.scrape > 0) this.burst(now, levels.wind * SCRAPE_LEVEL * events.scrape, "bandpass", 700, 0.28, 0);
    if (events.splash > 0) this.burst(now, levels.wind * SPLASH_LEVEL * events.splash, "lowpass", 900, 0.45, 48);
  }

  /** The car is away (the menu's attract flight): its layer goes quiet. */
  silence(): void {
    const now = this.context.currentTime;
    for (const gain of this.gains) gain.gain.setTargetAtTime(0, now, 0.1);
    this.peaks.reset();
  }

  dispose(): void {
    for (const source of this.sources) source.stop();
    this.sources.length = 0;
  }

  /**
   * One event: a burst of filtered noise that dies away over `length`
   * seconds, with a falling sine body under it when `bodyHz` is given (a
   * knock's thump, a splash's weight).
   */
  private burst(now: number, level: number, type: BiquadFilterType, hertz: number, length: number, bodyHz: number): void {
    if (level <= 1e-4) return;
    const context = this.context;
    const noise = context.createBufferSource();
    noise.buffer = this.noise;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = hertz;
    filter.Q.value = type === "bandpass" ? 1.1 : 0.7;
    const gain = context.createGain();
    gain.gain.setValueAtTime(level, now);
    gain.gain.exponentialRampToValueAtTime(1e-4, now + length);
    noise.connect(filter).connect(gain).connect(this.destination);
    noise.start(now, this.nextRandom() * 1.5);
    noise.stop(now + length + 0.02);
    if (bodyHz <= 0) return;
    const body = context.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(bodyHz, now);
    body.frequency.exponentialRampToValueAtTime(bodyHz * 0.5, now + length);
    const bodyGain = context.createGain();
    bodyGain.gain.setValueAtTime(level * 0.8, now);
    bodyGain.gain.exponentialRampToValueAtTime(1e-4, now + length);
    body.connect(bodyGain).connect(this.destination);
    body.start(now);
    body.stop(now + length + 0.02);
  }

  /** xorshift32, 0..1: where in the noise a burst starts. */
  private nextRandom(): number {
    let x = this.random;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.random = x >>> 0;
    return this.random / 2 ** 32;
  }
}
