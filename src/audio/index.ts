import type { FlightVisualState } from "@/src/game/types";
import type { AircraftKind } from "@/src/sim";
import { aircraftSpec, type EngineSoundSpec } from "@/src/aircraft/catalogue";
import { surfaceVehicleSpec, type SurfaceVehicleSpec } from "@/src/vehicles/catalogue";
import { isSurfaceVehicleKind, vehicleClass, type VehicleKind } from "@/src/vehicles/kinds";
import { BoatVoice, boatSoundTargets } from "./boatVoice";
import { CarVoice, carSoundTargets } from "./carVoice";
import { groundWindShare, PersonVoice, UNDERWATER_MUFFLE_HZ } from "./personVoice";

export interface AudioLevels {
  master: number;
  engine: number;
  wind: number;
}

export interface FlightAudioOptions extends AudioLevels {
  aircraft?: AircraftKind;
  /**
   * The surface vehicle this session can drive, if any: its engine voices
   * the graph whenever the state carries its payload, and the aircraft's does
   * otherwise (the menu's attract flight).
   */
  vehicle?: VehicleKind;
}

/** What the listener is in, for a walking session: the air at the walker and the water over the camera. */
export interface AudioSurroundings {
  /** The wind at the walker, m/s on the world's axes: the sim's wind field at the weather's share. */
  windX: number;
  windY: number;
  windZ: number;
  /** How far under the water the render camera is, metres; 0 above it. */
  cameraUnderwaterDepth: number;
}

/** The ground voice's level under the water: the water's own low hum. */
const UNDERWATER_HUM = 0.35;

/** Level of the engine's second harmonic against its fundamental. */
export const ENGINE_SECOND_HARMONIC_GAIN = 0.55;

export function normalizedEngineSpeed(aircraft: AircraftKind, engineRpm: number): number {
  return Math.min(1.2, Math.max(0, engineRpm / aircraftSpec(aircraft).engineReadout.maximum));
}

export class FlightAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private groundGain: GainNode | null = null;
  private stallGain: GainNode | null = null;
  private stallOscillator: OscillatorNode | null = null;
  private engineOscillators: OscillatorNode[] = [];
  private windSource: AudioBufferSourceNode | null = null;
  /**
   * Car sessions only, where the walker can dive: a low-pass after the
   * master, wide open (exactly the Nyquist frequency, which passes
   * everything) until the camera goes under.
   */
  private muffle: BiquadFilterNode | null = null;
  private readonly surroundings: AudioSurroundings = { windX: 0, windY: 0, windZ: 0, cameraUnderwaterDepth: 0 };
  private levels: AudioLevels;
  private readonly aircraft: AircraftKind;
  private readonly surfaceVehicle: SurfaceVehicleSpec | null;
  private readonly walkable: boolean;
  /** The engine the oscillators and filter are tuned for right now. */
  private voicedSound: EngineSoundSpec | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  /** The boat's own layer, built the first time a boat's state arrives. */
  private boatVoice: BoatVoice | null = null;
  /** The car's own layer, built the first time a car's state arrives. */
  private carVoice: CarVoice | null = null;
  /** The walker's footsteps, breathing and strokes, built the first time a walker's state arrives. */
  private personVoice: PersonVoice | null = null;
  private enabled = false;
  private desiredEnabled = false;
  private activationGeneration = 0;
  private disposed = false;
  private lastTouchdown = 0;
  private lastFlapSoundPosition = 0;

  constructor(options: FlightAudioOptions) {
    this.levels = options;
    this.aircraft = options.aircraft ?? "trainer";
    this.surfaceVehicle = options.vehicle && isSurfaceVehicleKind(options.vehicle)
      ? surfaceVehicleSpec(options.vehicle)
      : null;
    this.walkable = options.vehicle !== undefined && vehicleClass(options.vehicle) === "car";
  }

  async unlock(): Promise<void> {
    if (this.disposed) return;
    this.desiredEnabled = true;
    const generation = ++this.activationGeneration;
    if (!this.context) this.createGraph();
    const context = this.context;
    if (!context) {
      if (generation === this.activationGeneration) this.desiredEnabled = false;
      return;
    }
    try {
      if (context.state === "suspended") await context.resume();
    } catch (error) {
      if (generation === this.activationGeneration) {
        this.desiredEnabled = false;
        this.enabled = false;
      }
      throw error;
    }
    this.finishResume(context, generation);
  }

  setLevels(levels: AudioLevels): void {
    this.levels = levels;
    const now = this.context?.currentTime ?? 0;
    this.master?.gain.setTargetAtTime(levels.master, now, 0.05);
  }

  /** The walker's surroundings for the next `update`: the wind at them and the water over the camera. */
  setSurroundings(surroundings: Readonly<AudioSurroundings>): void {
    this.surroundings.windX = surroundings.windX;
    this.surroundings.windY = surroundings.windY;
    this.surroundings.windZ = surroundings.windZ;
    this.surroundings.cameraUnderwaterDepth = surroundings.cameraUnderwaterDepth;
  }

  update(state: FlightVisualState): void {
    const context = this.context;
    if (!context || !this.enabled) return;
    const now = context.currentTime;
    const surface = state.vehicle ? this.surfaceVehicle : null;
    // On foot the engine heard is the parked car's, fading with the walker's distance from it.
    const parked = state.walking?.driven === "person" ? state.walking.car : null;
    const heard = parked ?? state;
    const distanceShare = parked
      ? parkedEngineShare(Math.hypot(state.position.x - parked.position.x, state.position.y - parked.position.y, state.position.z - parked.position.z))
      : 1;
    const levels = distanceShare === 1 ? this.levels : { ...this.levels, engine: this.levels.engine * distanceShare };
    const rpmRatio = surface
      ? Math.min(1.2, Math.max(0, heard.engineRpm / surface.engineReadout.maximum))
      : normalizedEngineSpeed(this.aircraft, state.engineRpm);
    const sound = surface ? surface.engineSound : aircraftSpec(this.aircraft).engineSound;
    if (sound !== this.voicedSound) this.voiceEngine(sound);
    const baseFrequency = sound.baseHz + rpmRatio * sound.spanHz;
    this.engineOscillators.forEach((oscillator, index) => {
      oscillator.frequency.setTargetAtTime(baseFrequency * (index + 1), now, 0.045);
      oscillator.detune.setTargetAtTime(index === 0 ? -4 : 6, now, 0.08);
    });
    const car = surface && heard.vehicle?.kind === "car" ? heard.vehicle : null;
    const carTargets = car ? carSoundTargets(heard, car) : null;
    const engineLevel = levels.engine *
      (sound.gainBase + rpmRatio * sound.gainSpan) *
      (0.55 + heard.throttle * 0.45) *
      // A stalled or flooded diesel is silent; a cranking one is quiet.
      (carTargets ? carTargets.engineShare : 1);
    this.engineGain?.gain.setTargetAtTime(engineLevel, now, 0.07);
    const boat = surface && state.vehicle?.kind === "boat" ? state.vehicle : null;
    if (boat && this.master && this.noiseBuffer && this.engineGain) {
      this.boatVoice ??= new BoatVoice(context, this.master, this.noiseBuffer, this.engineGain.gain);
      this.boatVoice.update(state, boat, this.levels, engineLevel);
      // The exhaust: muffled through the hub under way, open at idle.
      this.engineFilter?.frequency.setTargetAtTime(boatSoundTargets(state, boat).engineCutoffHz, now, 0.15);
    } else {
      this.boatVoice?.silence();
    }
    if (carTargets && this.master && this.noiseBuffer) {
      this.carVoice ??= new CarVoice(context, this.master, this.noiseBuffer);
      this.carVoice.update(carTargets, levels);
    } else {
      this.carVoice?.silence();
    }
    const person = state.vehicle?.kind === "person" ? state.vehicle : null;
    if (person && this.master && this.noiseBuffer) {
      this.personVoice ??= new PersonVoice(context, this.master, this.noiseBuffer);
      this.personVoice.update(person, this.levels);
    } else {
      this.personVoice?.silence();
    }
    const under = this.surroundings.cameraUnderwaterDepth > 0;
    this.muffle?.frequency.setTargetAtTime(under ? UNDERWATER_MUFFLE_HZ : context.sampleRate / 2, now, 0.04);
    // On foot the wind is the air moving past the ear, and none of it is heard under the water.
    const air = this.surroundings;
    const windAmount = person
      ? under ? 0 : groundWindShare(Math.hypot(air.windX - state.velocity.x, air.windY - state.velocity.y, air.windZ - state.velocity.z))
      : Math.min(1, Math.max(0, (state.airspeed - 15) / 75));
    this.windGain?.gain.setTargetAtTime(this.levels.wind * windAmount * 0.12, now, 0.1);
    const groundSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    // Wheels and gear rumble rolling; feet have their footsteps instead; under the water, its own low hum.
    const rumble = under ? UNDERWATER_HUM : !person && state.onGround ? Math.min(1, groundSpeed / 34) : 0;
    this.groundGain?.gain.setTargetAtTime(this.levels.wind * rumble * 0.085, now, 0.055);
    this.stallGain?.gain.setTargetAtTime(state.stalled && !state.onGround ? 0.055 : 0, now, 0.04);

    if (Math.abs(state.flaps - this.lastFlapSoundPosition) >= 0.12) {
      this.playServo();
      this.lastFlapSoundPosition = state.flaps;
    }

    if (state.touchdown > this.lastTouchdown + 0.1 && state.touchdown > 0.2) {
      this.playImpact(Math.min(1, state.touchdown));
    }
    this.lastTouchdown = state.touchdown;
  }

  /**
   * Every snapshot, including those `update` is too busy for: the car's
   * event peaks (bump stops, scrapes, splashes) are per snapshot and would
   * otherwise be lost between updates.
   */
  observe(state: FlightVisualState): void {
    if (state.vehicle?.kind === "car") this.carVoice?.peaks.observe(state.vehicle);
  }

  /**
   * A foot struck as the drawn figure reports it, at once rather than at the
   * next `update`, so the step lands with the foot. `strength` 0..1.
   */
  footstep(state: FlightVisualState, strength: number): void {
    const context = this.context;
    if (!context || !this.enabled || state.vehicle?.kind !== "person" || !this.master || !this.noiseBuffer) return;
    this.personVoice ??= new PersonVoice(context, this.master, this.noiseBuffer);
    this.personVoice.step(state.vehicle, strength, this.levels);
  }

  suspend(): void {
    this.desiredEnabled = false;
    const generation = ++this.activationGeneration;
    this.enabled = false;
    if (this.context?.state === "running") {
      this.requestSuspend(this.context, generation);
    }
  }

  dispose(): void {
    this.desiredEnabled = false;
    this.activationGeneration += 1;
    this.enabled = false;
    this.disposed = true;
    for (const oscillator of this.engineOscillators) oscillator.stop();
    this.boatVoice?.dispose();
    this.boatVoice = null;
    this.carVoice?.dispose();
    this.carVoice = null;
    this.personVoice = null;
    this.stallOscillator?.stop();
    this.windSource?.stop();
    this.engineOscillators = [];
    this.stallOscillator = null;
    this.windSource = null;
    this.muffle = null;
    if (this.context) void this.context.close();
    this.context = null;
  }

  /** Commits only the newest resume and reverses a stale resume after End. */
  private finishResume(context: AudioContext, generation: number): void {
    if (this.disposed) return;
    if (generation !== this.activationGeneration || !this.desiredEnabled) {
      if (!this.desiredEnabled && context.state === "running") {
        this.requestSuspend(context, this.activationGeneration);
      }
      return;
    }
    this.enabled = true;
  }

  /**
   * If a newer unlock arrives while suspend() is still pending, resume again
   * after that old suspension settles. The generation passed here identifies
   * the request that owned the suspension, not whichever action is current.
   */
  private requestSuspend(context: AudioContext, generation: number): void {
    void context.suspend().then(() => {
      if (this.disposed || !this.desiredEnabled) return;
      if (generation === this.activationGeneration || context.state !== "suspended") return;
      const resumeGeneration = this.activationGeneration;
      void context.resume().then(() => {
        this.finishResume(context, resumeGeneration);
      }).catch(() => {
        if (resumeGeneration === this.activationGeneration) this.enabled = false;
      });
    }).catch(() => {
      // Muting is best-effort; a browser audio failure must not affect flight.
    });
  }

  private createGraph(): void {
    const AudioContextConstructor = window.AudioContext;
    if (!AudioContextConstructor) return;
    const context = new AudioContextConstructor();
    this.context = context;
    this.master = context.createGain();
    this.master.gain.value = this.levels.master;
    if (this.walkable) {
      this.muffle = context.createBiquadFilter();
      this.muffle.type = "lowpass";
      this.muffle.frequency.value = context.sampleRate / 2;
      this.master.connect(this.muffle).connect(context.destination);
    } else {
      this.master.connect(context.destination);
    }

    const sound = aircraftSpec(this.aircraft).engineSound;
    const engineFilter = context.createBiquadFilter();
    engineFilter.type = "lowpass";
    engineFilter.frequency.value = sound.filterHz;
    engineFilter.Q.value = sound.filterQ;
    this.engineFilter = engineFilter;
    this.voicedSound = sound;
    this.engineGain = context.createGain();
    this.engineGain.gain.value = 0;
    this.engineGain.connect(engineFilter).connect(this.master);
    for (const harmonic of [1, 2]) {
      const oscillator = context.createOscillator();
      oscillator.type = sound.waveforms[harmonic - 1]!;
      oscillator.frequency.value = 40 * harmonic;
      if (harmonic === 1) {
        oscillator.connect(this.engineGain);
      } else {
        // The second harmonic carries the "whine": it rides at just over half
        // the fundamental's level so the tone stays low and round.
        const harmonicGain = context.createGain();
        harmonicGain.gain.value = ENGINE_SECOND_HARMONIC_GAIN;
        oscillator.connect(harmonicGain).connect(this.engineGain);
      }
      oscillator.start();
      this.engineOscillators.push(oscillator);
    }

    const noiseBuffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const noise = noiseBuffer.getChannelData(0);
    for (let index = 0; index < noise.length; index += 1) noise[index] = Math.random() * 2 - 1;
    this.noiseBuffer = noiseBuffer;
    this.windSource = context.createBufferSource();
    this.windSource.buffer = noiseBuffer;
    this.windSource.loop = true;
    const windFilter = context.createBiquadFilter();
    windFilter.type = "bandpass";
    windFilter.frequency.value = 620;
    windFilter.Q.value = 0.42;
    this.windGain = context.createGain();
    this.windGain.gain.value = 0;
    this.windSource.connect(windFilter).connect(this.windGain).connect(this.master);
    const groundFilter = context.createBiquadFilter();
    groundFilter.type = "lowpass";
    groundFilter.frequency.value = 115;
    this.groundGain = context.createGain();
    this.groundGain.gain.value = 0;
    this.windSource.connect(groundFilter).connect(this.groundGain).connect(this.master);
    this.windSource.start();

    this.stallOscillator = context.createOscillator();
    this.stallOscillator.type = "square";
    this.stallOscillator.frequency.value = 5.8;
    this.stallGain = context.createGain();
    this.stallGain.gain.value = 0;
    this.stallOscillator.connect(this.stallGain).connect(this.master);
    this.stallOscillator.start();
  }

  /** Retunes the engine voice between the aircraft and the surface vehicle. */
  private voiceEngine(sound: EngineSoundSpec): void {
    this.voicedSound = sound;
    if (this.engineFilter) {
      this.engineFilter.frequency.value = sound.filterHz;
      this.engineFilter.Q.value = sound.filterQ;
    }
    this.engineOscillators.forEach((oscillator, index) => {
      oscillator.type = sound.waveforms[index]!;
    });
  }

  private playImpact(amount: number): void {
    const context = this.context;
    if (!context || !this.master) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(82, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(32, context.currentTime + 0.18);
    gain.gain.setValueAtTime(0.12 * amount, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.2);
    oscillator.connect(gain).connect(this.master);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.21);
  }

  private playServo(): void {
    const context = this.context;
    if (!context || !this.master) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(245, context.currentTime);
    oscillator.frequency.linearRampToValueAtTime(165, context.currentTime + 0.24);
    gain.gain.setValueAtTime(0.001, context.currentTime);
    gain.gain.linearRampToValueAtTime(0.018, context.currentTime + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.27);
    oscillator.connect(gain).connect(this.master);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.28);
  }
}

/**
 * How much of a parked car's engine a walker hears at a distance, 0..1: full
 * within 2 m of it, then falling as the inverse square of the distance, as a
 * point source in the open does.
 */
export function parkedEngineShare(distanceMeters: number): number {
  const d = Math.max(2, Number.isFinite(distanceMeters) ? distanceMeters : 2);
  return Math.min(1, (2 / d) ** 2);
}
