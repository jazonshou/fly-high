import type { FlightVisualState } from "@/src/game/types";
import type { AircraftKind } from "@/src/sim";

export interface AudioLevels {
  master: number;
  engine: number;
  wind: number;
}

export interface FlightAudioOptions extends AudioLevels {
  aircraft?: AircraftKind;
}

export function normalizedEngineSpeed(aircraft: AircraftKind, engineRpm: number): number {
  const maximum = aircraft === "jet" ? 100 : 2_600;
  return Math.min(1.2, Math.max(0, engineRpm / maximum));
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
  private levels: AudioLevels;
  private readonly aircraft: AircraftKind;
  private enabled = false;
  private desiredEnabled = false;
  private activationGeneration = 0;
  private disposed = false;
  private lastTouchdown = 0;
  private lastFlapSoundPosition = 0;

  constructor(options: FlightAudioOptions) {
    this.levels = options;
    this.aircraft = options.aircraft ?? "trainer";
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

  update(state: FlightVisualState): void {
    const context = this.context;
    if (!context || !this.enabled) return;
    const now = context.currentTime;
    const rpmRatio = normalizedEngineSpeed(this.aircraft, state.engineRpm);
    const baseFrequency = this.aircraft === "jet"
      ? 88 + rpmRatio * 205
      : 34 + rpmRatio * 58;
    this.engineOscillators.forEach((oscillator, index) => {
      oscillator.frequency.setTargetAtTime(baseFrequency * (index + 1), now, 0.045);
      oscillator.detune.setTargetAtTime(index === 0 ? -4 : 6, now, 0.08);
    });
    this.engineGain?.gain.setTargetAtTime(
      this.levels.engine *
        (this.aircraft === "jet" ? 0.045 + rpmRatio * 0.082 : 0.035 + rpmRatio * 0.1) *
        (0.55 + state.throttle * 0.45),
      now,
      0.07,
    );
    const windAmount = Math.min(1, Math.max(0, (state.airspeed - 15) / 75));
    this.windGain?.gain.setTargetAtTime(this.levels.wind * windAmount * 0.12, now, 0.1);
    const groundSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    const rumble = state.onGround ? Math.min(1, groundSpeed / 34) : 0;
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
    this.stallOscillator?.stop();
    this.windSource?.stop();
    this.engineOscillators = [];
    this.stallOscillator = null;
    this.windSource = null;
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
    this.master.connect(context.destination);

    const engineFilter = context.createBiquadFilter();
    engineFilter.type = "lowpass";
    engineFilter.frequency.value = this.aircraft === "jet" ? 1_450 : 720;
    engineFilter.Q.value = this.aircraft === "jet" ? 0.72 : 1.1;
    this.engineGain = context.createGain();
    this.engineGain.gain.value = 0;
    this.engineGain.connect(engineFilter).connect(this.master);
    for (const harmonic of [1, 2]) {
      const oscillator = context.createOscillator();
      oscillator.type = this.aircraft === "jet"
        ? harmonic === 1 ? "triangle" : "sine"
        : harmonic === 1 ? "sawtooth" : "triangle";
      oscillator.frequency.value = 40 * harmonic;
      oscillator.connect(this.engineGain);
      oscillator.start();
      this.engineOscillators.push(oscillator);
    }

    const noiseBuffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const noise = noiseBuffer.getChannelData(0);
    for (let index = 0; index < noise.length; index += 1) noise[index] = Math.random() * 2 - 1;
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
