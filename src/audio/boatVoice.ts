import type { BoatVisualState, FlightVisualState } from "@/src/game/types";

/**
 * The speedboat's own sounds, layered over the engine voice `FlightAudio`
 * already has. Built the first time a boat's state arrives, so an aircraft
 * session's audio graph is the one it always was.
 *
 *  - THE EXHAUST. A V6 four-stroke fires three times per crank turn, so the
 *    engine's fundamental is rpm / 20 (the catalogue's `engineSound` says so
 *    exactly). An outboard breathes out through its propeller hub: under way
 *    the exhaust is under water and the engine is a low, muffled drone; at
 *    idle the gas leaves through the relief port above the waterline, the
 *    note opens up, and its uneven pulses are the idle burble.
 *  - THE WATER. Hull rush, broadband water noise that grows with speed and
 *    climbs in pitch; a hiss from the spray sheets once the hull planes; and
 *    slaps, short thuds when the hull drops back onto the water, plus small
 *    random laps against a hull lying still.
 *  - VENTILATION. A propeller drawing air sheds its load: the engine races
 *    (the simulator raises the rpm) and the blades whine.
 *
 * The laws are pure functions of the state (`boatSoundTargets`,
 * `BoatSlapDetector`) so they can be tested without an audio device. Every
 * level here sits under the engine's own, and no filter opens above 1.2 kHz:
 * Jason found the engines too high-pitched once (2026-09-29).
 */

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** The engine's low-pass with the exhaust in the air (idle relief) and through the hub, Hz. */
export const BOAT_EXHAUST_OPEN_HZ = 760;
export const BOAT_EXHAUST_SUBMERGED_HZ = 300;

export interface BoatSoundTargets {
  /** The engine voice's low-pass, Hz. */
  readonly engineCutoffHz: number;
  /** How far the idle burble swings the engine's level, 0..1. */
  readonly burbleDepth: number;
  /** Hull rush level, 0..1, and its band centre, Hz. */
  readonly rushGain: number;
  readonly rushHz: number;
  /** Spray hiss level, 0..1. */
  readonly hissGain: number;
  /** Ventilation whine level, 0..1, and its pitch, Hz. */
  readonly whineGain: number;
  readonly whineHz: number;
  /** How many small laps a second a hull lying still takes. */
  readonly lapsPerSecond: number;
}

/** What the boat sounds like in this state. */
export function boatSoundTargets(state: Readonly<FlightVisualState>, boat: Readonly<BoatVisualState>): BoatSoundTargets {
  const speed = Math.max(0, Number.isFinite(boat.speedThroughWater) ? boat.speedThroughWater : 0);
  const rpm = Math.max(0, Number.isFinite(state.engineRpm) ? state.engineRpm : 0);
  const immersion = clamp01(boat.propellerImmersion);
  // The exhaust leaves through the hub once the boat makes way under load;
  // a propeller out of the water (a jump, a hard trim-out) blows it in the air.
  const submerged = immersion * smoothstep(1, 4, speed) * (boat.ventilating ? 0.5 : 1);
  const engineCutoffHz = BOAT_EXHAUST_OPEN_HZ + (BOAT_EXHAUST_SUBMERGED_HZ - BOAT_EXHAUST_OPEN_HZ) * submerged;
  const burbleDepth = 0.45 * (1 - smoothstep(900, 1_800, rpm)) * (1 - submerged);
  const planing = clamp01(boat.planing);
  // A displacement hull pushes water; on the plane less of it is wet.
  const rushGain = smoothstep(0.3, 8, speed) * (1 - 0.35 * planing);
  const rushHz = Math.min(900, 160 + 28 * speed);
  const spray = Math.min(1, Math.max(0, boat.sprayRootCount) / 8);
  const hissGain = planing * smoothstep(6, 16, speed) * spray;
  const whineGain = boat.ventilating ? smoothstep(1_800, 4_500, rpm) : 0;
  // Twice the firing rate: high enough to whine, low enough not to shrill.
  const whineHz = Math.min(1_200, rpm / 10);
  const lapsPerSecond = boat.capsized ? 0 : 1.6 * (1 - smoothstep(0.4, 3, speed));
  return { engineCutoffHz, burbleDepth, rushGain, rushHz, hissGain, whineGain, whineHz, lapsPerSecond };
}

/** An upward kick at the CG that counts as the hull landing, m/s². */
export const BOAT_SLAP_ACCELERATION = 8;

/**
 * Hears the hull land: a sharp upward acceleration of the CG right after it
 * was falling. Returns the slap's strength, 0..1, or 0. Frames further apart
 * than a quarter second (a pause, a reset) are not differenced.
 */
export class BoatSlapDetector {
  private lastTime = Number.NaN;
  private lastVerticalSpeed = 0;

  update(time: number, verticalSpeed: number): number {
    const elapsed = time - this.lastTime;
    const previous = this.lastVerticalSpeed;
    this.lastTime = time;
    this.lastVerticalSpeed = Number.isFinite(verticalSpeed) ? verticalSpeed : 0;
    if (!(elapsed > 1e-4 && elapsed <= 0.25)) return 0;
    const acceleration = (this.lastVerticalSpeed - previous) / elapsed;
    if (previous > -0.4 || acceleration < BOAT_SLAP_ACCELERATION) return 0;
    return clamp01((acceleration - BOAT_SLAP_ACCELERATION) / 30) * 0.7 + clamp01(-previous / 3) * 0.3;
  }

  reset(): void {
    this.lastTime = Number.NaN;
    this.lastVerticalSpeed = 0;
  }
}

/** Levels against the engine's own, at full strength of each law. */
const RUSH_LEVEL = 0.16;
const HISS_LEVEL = 0.07;
const WHINE_LEVEL = 0.035;
const SLAP_LEVEL = 0.2;
const LAP_LEVEL = 0.035;

/**
 * The boat's layer of the audio graph: water noise through three filters,
 * a whine oscillator, and the burble's modulation of the engine's gain.
 * `FlightAudio` owns the context, the master bus and the engine voice.
 */
export class BoatVoice {
  private readonly context: AudioContext;
  private readonly destination: AudioNode;
  private readonly noise: AudioBuffer;
  private readonly rushFilter: BiquadFilterNode;
  private readonly rushGain: GainNode;
  private readonly hissGain: GainNode;
  private readonly whine: OscillatorNode;
  private readonly whineGain: GainNode;
  private readonly burbleGain: GainNode;
  private readonly burbleOscillators: OscillatorNode[] = [];
  private readonly slaps = new BoatSlapDetector();
  private readonly sources: AudioScheduledSourceNode[] = [];
  private nextLapTime = 0;
  private random = 0x2545f491;

  /**
   * `engineGain` is the engine voice's gain param: the burble is added to it.
   * `noise` is the graph's looping white-noise buffer.
   */
  constructor(context: AudioContext, destination: AudioNode, noise: AudioBuffer, engineGain: AudioParam) {
    this.context = context;
    this.destination = destination;
    this.noise = noise;

    const source = context.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    this.rushFilter = context.createBiquadFilter();
    this.rushFilter.type = "bandpass";
    this.rushFilter.frequency.value = 200;
    this.rushFilter.Q.value = 0.55;
    this.rushGain = context.createGain();
    this.rushGain.gain.value = 0;
    source.connect(this.rushFilter).connect(this.rushGain).connect(destination);
    const hissFilter = context.createBiquadFilter();
    hissFilter.type = "bandpass";
    hissFilter.frequency.value = 1_100;
    hissFilter.Q.value = 0.5;
    this.hissGain = context.createGain();
    this.hissGain.gain.value = 0;
    source.connect(hissFilter).connect(this.hissGain).connect(destination);
    source.start();
    this.sources.push(source);

    this.whine = context.createOscillator();
    this.whine.type = "triangle";
    this.whine.frequency.value = 200;
    const whineFilter = context.createBiquadFilter();
    whineFilter.type = "lowpass";
    whineFilter.frequency.value = 1_200;
    whineFilter.Q.value = 0.6;
    this.whineGain = context.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(whineFilter).connect(this.whineGain).connect(destination);
    this.whine.start();
    this.sources.push(this.whine);

    // Two slow, unrelated rates sum into an uneven swing of the engine's level.
    this.burbleGain = context.createGain();
    this.burbleGain.gain.value = 0;
    for (const hertz of [3.3, 5.1]) {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = hertz;
      oscillator.connect(this.burbleGain);
      oscillator.start();
      this.burbleOscillators.push(oscillator);
      this.sources.push(oscillator);
    }
    this.burbleGain.connect(engineGain);
  }

  /** This frame's boat; `engineLevel` is the engine voice's gain target, which the burble swings. */
  update(state: Readonly<FlightVisualState>, boat: Readonly<BoatVisualState>, levels: { engine: number; wind: number }, engineLevel: number): void {
    const now = this.context.currentTime;
    const targets = boatSoundTargets(state, boat);
    this.rushFilter.frequency.setTargetAtTime(targets.rushHz, now, 0.12);
    this.rushGain.gain.setTargetAtTime(levels.wind * RUSH_LEVEL * targets.rushGain, now, 0.12);
    this.hissGain.gain.setTargetAtTime(levels.wind * HISS_LEVEL * targets.hissGain, now, 0.1);
    this.whine.frequency.setTargetAtTime(Math.max(20, targets.whineHz), now, 0.05);
    this.whineGain.gain.setTargetAtTime(levels.engine * WHINE_LEVEL * targets.whineGain, now, 0.06);
    // Half the swing from each oscillator: together they reach `burbleDepth` of the level.
    this.burbleGain.gain.setTargetAtTime(engineLevel * targets.burbleDepth * 0.5, now, 0.2);
    const slap = this.slaps.update(state.simulationTime, state.velocity.y);
    if (slap > 0) this.thud(now, levels.wind * SLAP_LEVEL * slap, 1);
    if (targets.lapsPerSecond > 0 && now >= this.nextLapTime) {
      if (this.nextLapTime > 0) this.thud(now, levels.wind * LAP_LEVEL * (0.5 + 0.5 * this.nextRandom()), 0.45);
      this.nextLapTime = now + (0.3 + 1.4 * this.nextRandom()) / targets.lapsPerSecond;
    }
  }

  /** The boat is away (the menu's attract flight): its water goes quiet. */
  silence(): void {
    const now = this.context.currentTime;
    for (const gain of [this.rushGain, this.hissGain, this.whineGain, this.burbleGain]) {
      gain.gain.setTargetAtTime(0, now, 0.1);
    }
    this.slaps.reset();
    this.nextLapTime = 0;
  }

  dispose(): void {
    for (const source of this.sources) source.stop();
    this.sources.length = 0;
  }

  /** A short low thud of water on the hull: filtered noise and a falling sine. */
  private thud(now: number, level: number, size: number): void {
    if (level <= 1e-4) return;
    const context = this.context;
    const burst = context.createBufferSource();
    burst.buffer = this.noise;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 260 + 240 * (1 - size);
    const gain = context.createGain();
    const length = 0.07 + 0.09 * size;
    gain.gain.setValueAtTime(level, now);
    gain.gain.exponentialRampToValueAtTime(1e-4, now + length);
    burst.connect(filter).connect(gain).connect(this.destination);
    burst.start(now, this.nextRandom() * 1.5);
    burst.stop(now + length + 0.02);
    const body = context.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(70 + 40 * (1 - size), now);
    body.frequency.exponentialRampToValueAtTime(38, now + length);
    const bodyGain = context.createGain();
    bodyGain.gain.setValueAtTime(level * 0.8, now);
    bodyGain.gain.exponentialRampToValueAtTime(1e-4, now + length);
    body.connect(bodyGain).connect(this.destination);
    body.start(now);
    body.stop(now + length + 0.02);
  }

  /** xorshift32, 0..1: the laps' timing needs no more than that. */
  private nextRandom(): number {
    let x = this.random;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.random = x >>> 0;
    return this.random / 2 ** 32;
  }
}
