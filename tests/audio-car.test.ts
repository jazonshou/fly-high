import { afterEach, describe, expect, it } from "vitest";
import { FlightAudio } from "../src/audio";
import {
  CAR_SOUND_CEILING_HZ,
  CarEventPeaks,
  carFiringHz,
  carSoundTargets,
  carTyreVoice,
} from "../src/audio/carVoice";
import { INITIAL_VISUAL_STATE, type CarVisualState, type FlightVisualState } from "../src/game/types";
import { SurfaceMaterial } from "../src/render/webgpu/terrain/surfaceMaterials";
import { surfaceVehicleSpec } from "../src/vehicles/catalogue";

/** The LandCruiser's sounds (src/audio/carVoice.ts) and how FlightAudio layers them. */

const CAR: CarVisualState = {
  kind: "car",
  speed: 0,
  gearbox: "automatic",
  selector: "D",
  gear: 1,
  range: "2H",
  locks: "off",
  downhillAssist: false,
  downhillAssistActive: false,
  tractionControlActive: false,
  absActive: false,
  clutch: 1,
  engineRunning: true,
  stalled: false,
  flooded: false,
  rolled: false,
  boost: 0,
  headlights: "off",
  brakeLights: false,
  reversing: false,
  tyrePressure: "road",
  tyrePressureBar: 2.4,
  wadingDepth: 0,
  wheelSteer: [0, 0, 0, 0],
  wheelSpin: [0, 0, 0, 0],
  wheelSpinRate: [0, 0, 0, 0],
  wheelLoad: [6_000, 6_000, 5_300, 5_300],
  wheelSlip: [0, 0, 0, 0],
  wheelSinkage: [0, 0, 0, 0],
  wheelSurface: [SurfaceMaterial.Asphalt, SurfaceMaterial.Asphalt, SurfaceMaterial.Asphalt, SurfaceMaterial.Asphalt],
  wheelWetness: [0, 0, 0, 0],
  axleHeave: [0, 0],
  axleRoll: [0, 0],
  steeringWheel: 0,
  bumpStop: 0,
  scrape: 0,
  splash: 0,
};

/** The car rolling at `speed` m/s on its tyres (spin = speed / loaded radius). */
function rolling(speed: number, overrides: Partial<CarVisualState> = {}): CarVisualState {
  const spin = speed / 0.37;
  return { ...CAR, speed, wheelSpinRate: [spin, spin, spin, spin], ...overrides };
}

function at(rpm: number, car: CarVisualState, state: Partial<FlightVisualState> = {}) {
  return { state: { ...INITIAL_VISUAL_STATE, engineRpm: rpm, throttle: 0, vehicle: car, ...state }, car };
}

function targets(rpm: number, car: CarVisualState, state: Partial<FlightVisualState> = {}) {
  const sample = at(rpm, car, state);
  return carSoundTargets(sample.state, sample.car);
}

const everywhere = (surface: number): number[] => [surface, surface, surface, surface];

describe("the car's sound laws", () => {
  it("voices the four-cylinder's firing rate: 25 Hz at idle, about 113 Hz at 3,400 rpm", () => {
    const sound = surfaceVehicleSpec("landcruiser").engineSound;
    const maximum = surfaceVehicleSpec("landcruiser").engineReadout.maximum;
    for (const rpm of [750, 2_000, 3_400]) {
      expect(sound.baseHz + (rpm / maximum) * sound.spanHz).toBeCloseTo(carFiringHz(rpm), 9);
    }
    expect(carFiringHz(750)).toBe(25);
    expect(carFiringHz(3_400)).toBeCloseTo(113.3, 1);
    expect(targets(750, CAR).firingHz).toBe(25);
  });

  it("clatters most at idle and labouring low down, less as the revs rise, and not at all stopped", () => {
    const idle = targets(750, CAR).clatterGain;
    const labouring = targets(1_300, CAR, { throttle: 1 }).clatterGain;
    const revving = targets(3_400, CAR, { throttle: 0.2 }).clatterGain;
    expect(labouring).toBeGreaterThan(idle);
    expect(revving).toBeLessThan(idle * 0.6);
    const stalled = targets(0, { ...CAR, engineRunning: false, stalled: true });
    expect(stalled.clatterGain).toBe(0);
    expect(stalled.engineShare).toBe(0);
    // The starter turns it over quietly.
    const cranking = targets(250, { ...CAR, engineRunning: false });
    expect(cranking.engineShare).toBeGreaterThan(0);
    expect(cranking.engineShare).toBeLessThan(0.35);
    expect(targets(750, CAR).engineShare).toBe(1);
  });

  it("whistles the turbo with boost, rising in pitch, never above the ceiling", () => {
    expect(targets(2_400, rolling(10, { boost: 0 })).turboGain).toBe(0);
    const half = targets(2_400, rolling(10, { boost: 0.5 }));
    const full = targets(2_400, rolling(10, { boost: 1 }));
    expect(full.turboGain).toBeGreaterThan(half.turboGain * 3);
    expect(full.turboHz).toBeGreaterThan(half.turboHz);
    expect(full.turboHz).toBeLessThanOrEqual(CAR_SOUND_CEILING_HZ);
  });

  it("whines the transfer case in 4L only, its pitch the gear mesh's at road speed", () => {
    expect(targets(1_800, rolling(3, { range: "4H" })).whineGain).toBe(0);
    const low = targets(1_800, rolling(3, { range: "4L" }));
    expect(low.whineGain).toBeGreaterThan(0);
    // 3 m/s on a 0.37 m tyre is 1.29 turns a second; x 4.3 x 2.488 x 30 teeth.
    expect(low.whineHz).toBeCloseTo((3 / 0.37 / (2 * Math.PI)) * 4.3 * 2.488 * 30, 6);
    expect(targets(3_800, rolling(12, { range: "4L" })).whineHz).toBe(CAR_SOUND_CEILING_HZ);
  });

  it("names each ground's tyre voice: hiss, crunch, rush or rumble, and none in water", () => {
    expect(carTyreVoice(SurfaceMaterial.Asphalt)).toBe("hiss");
    expect(carTyreVoice(SurfaceMaterial.Concrete)).toBe("hiss");
    expect(carTyreVoice(SurfaceMaterial.Gravel)).toBe("crunch");
    expect(carTyreVoice(SurfaceMaterial.Tephra)).toBe("crunch");
    expect(carTyreVoice(SurfaceMaterial.Sand)).toBe("rush");
    expect(carTyreVoice(SurfaceMaterial.Snow)).toBe("rush");
    for (const soil of [SurfaceMaterial.Grass, SurfaceMaterial.ForestFloor, SurfaceMaterial.Shrub, SurfaceMaterial.DryGrass, SurfaceMaterial.Rock, SurfaceMaterial.Basalt]) {
      expect(carTyreVoice(soil)).toBe("rumble");
    }
    expect(carTyreVoice(-1)).toBeNull();
  });

  it("hisses on asphalt, crunches on gravel with grains faster at speed, rushes on sand: by the ground under each tyre", () => {
    const road = targets(1_800, rolling(20));
    expect(road.hissGain).toBeGreaterThan(0.5);
    expect(road.crunchGain + road.rushGain + road.rumbleGain).toBe(0);
    const gravel = targets(1_800, rolling(8, { wheelSurface: everywhere(SurfaceMaterial.Gravel) }));
    expect(gravel.crunchGain).toBeGreaterThan(0.4);
    expect(gravel.hissGain).toBe(0);
    expect(targets(1_800, rolling(16, { wheelSurface: everywhere(SurfaceMaterial.Gravel) })).crunchGrainHz)
      .toBeGreaterThan(gravel.crunchGrainHz);
    const half = targets(1_800, rolling(8, {
      wheelSurface: [SurfaceMaterial.Asphalt, SurfaceMaterial.Asphalt, SurfaceMaterial.Sand, SurfaceMaterial.Sand],
    }));
    expect(half.rushGain).toBeGreaterThan(0);
    expect(half.rushGain).toBeLessThanOrEqual(0.5 * 1.6);
    // Standing still, or a wheel in the air: no tyre noise.
    expect(targets(750, CAR).hissGain).toBe(0);
    const airborne = targets(1_800, rolling(20, { wheelLoad: [0, 0, 0, 0] }));
    expect(airborne.hissGain).toBe(0);
  });

  it("squeals only a tyre sliding on a hard surface", () => {
    expect(targets(1_800, rolling(15)).squealGain).toBe(0);
    expect(targets(1_800, rolling(15, { wheelSlip: [0.9, 0.9, 0.9, 0.9] })).squealGain).toBeGreaterThan(0.9);
    expect(targets(1_800, rolling(15, {
      wheelSlip: [0.9, 0.9, 0.9, 0.9],
      wheelSurface: everywhere(SurfaceMaterial.Gravel),
    })).squealGain).toBe(0);
  });

  it("rushes water round the wheels while wading, with depth and speed", () => {
    expect(targets(1_200, rolling(2)).wadeGain).toBe(0);
    const shallow = targets(1_200, rolling(2, { wadingDepth: 0.2, wheelSurface: everywhere(-1) })).wadeGain;
    const deep = targets(1_200, rolling(2, { wadingDepth: 0.6, wheelSurface: everywhere(-1) })).wadeGain;
    expect(shallow).toBeGreaterThan(0);
    expect(deep).toBeGreaterThan(shallow);
    expect(targets(800, rolling(0, { wadingDepth: 0.6 })).wadeGain).toBe(0);
  });
});

describe("the car's events", () => {
  it("keeps the largest peak of each kind across snapshots the audio skipped, then starts afresh", () => {
    const peaks = new CarEventPeaks();
    peaks.observe({ ...CAR, bumpStop: 0.6, scrape: 0.02 });
    peaks.observe({ ...CAR, bumpStop: 0.1, splash: 0.4 });
    expect(peaks.take()).toEqual({ knock: 0.6, scrape: 0, splash: 0.4 });
    expect(peaks.take()).toEqual({ knock: 0, scrape: 0, splash: 0 });
  });
});

/** Just enough of a Web Audio context for FlightAudio's graph, counting what it builds. */
class FakeParam {
  value = 0;
  setTargetAtTime(value: number): this {
    this.value = value;
    return this;
  }
  setValueAtTime(value: number): this {
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(): this {
    return this;
  }
  exponentialRampToValueAtTime(): this {
    return this;
  }
}

class FakeNode {
  readonly gain = new FakeParam();
  readonly frequency = new FakeParam();
  readonly detune = new FakeParam();
  readonly Q = new FakeParam();
  type = "";
  buffer: unknown = null;
  curve: unknown = null;
  loop = false;
  connect<T>(target: T): T {
    return target;
  }
  start(): void {}
  stop(): void {}
}

class FakeContext {
  static created: FakeContext[] = [];
  readonly counts = { oscillators: 0, sources: 0, filters: 0, gains: 0, shapers: 0 };
  state: AudioContextState = "running";
  currentTime = 0;
  readonly sampleRate = 8_000;
  readonly destination = new FakeNode();
  constructor() {
    FakeContext.created.push(this);
  }
  createGain(): FakeNode {
    this.counts.gains += 1;
    return new FakeNode();
  }
  createBiquadFilter(): FakeNode {
    this.counts.filters += 1;
    return new FakeNode();
  }
  createOscillator(): FakeNode {
    this.counts.oscillators += 1;
    return new FakeNode();
  }
  createBufferSource(): FakeNode {
    this.counts.sources += 1;
    return new FakeNode();
  }
  createWaveShaper(): FakeNode {
    this.counts.shapers += 1;
    return new FakeNode();
  }
  createBuffer(_channels: number, length: number): { getChannelData(): Float32Array } {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  async resume(): Promise<void> {}
  async suspend(): Promise<void> {}
  async close(): Promise<void> {}
}

const globals = globalThis as unknown as { window?: unknown };
const savedWindow = globals.window;

afterEach(() => {
  globals.window = savedWindow;
  FakeContext.created = [];
});

async function liveAudio(vehicle?: "landcruiser" | "speedboat") {
  globals.window = { AudioContext: FakeContext };
  const audio = new FlightAudio({ aircraft: "trainer", master: 1, engine: 1, wind: 1, ...(vehicle ? { vehicle } : {}) });
  await audio.unlock();
  const context = FakeContext.created[0]!;
  const engineGain = (audio as unknown as { engineGain: FakeNode }).engineGain.gain;
  return { audio, context, engineGain };
}

describe("the car's layer in the audio graph", () => {
  it("builds nothing for an aircraft session, observed or not", async () => {
    const { audio, context } = await liveAudio();
    const before = { ...context.counts };
    for (let frame = 0; frame < 30; frame += 1) {
      const state = { ...INITIAL_VISUAL_STATE, simulationTime: frame / 60 };
      audio.observe(state);
      audio.update(state);
    }
    expect(context.counts).toEqual(before);
    audio.dispose();
  });

  it("builds the car's layer once, on the first car state, with no per-firing or per-grain nodes", async () => {
    const { audio, context } = await liveAudio("landcruiser");
    audio.update({ ...INITIAL_VISUAL_STATE });
    const graph = { ...context.counts };
    const { state } = at(2_200, rolling(12, { boost: 0.6, range: "4L", wheelSurface: everywhere(SurfaceMaterial.Gravel) }), { throttle: 0.8 });
    audio.update(state);
    // One noise source; the firing, turbo, whine, two grain and squeal oscillators; three pulse shapers.
    expect(context.counts.sources - graph.sources).toBe(1);
    expect(context.counts.oscillators - graph.oscillators).toBe(6);
    expect(context.counts.shapers - graph.shapers).toBe(3);
    const built = { ...context.counts };
    for (let frame = 1; frame < 60; frame += 1) audio.update({ ...state, simulationTime: frame / 60 });
    expect(context.counts).toEqual(built);
    audio.dispose();
  });

  it("silences the engine voice when the diesel stalls", async () => {
    const { audio, engineGain } = await liveAudio("landcruiser");
    audio.update(at(750, CAR).state);
    expect(engineGain.value).toBeGreaterThan(0);
    audio.update(at(0, { ...CAR, engineRunning: false, stalled: true }).state);
    expect(engineGain.value).toBe(0);
    audio.dispose();
  });

  it("plays a bump-stop knock seen only on a snapshot the audio skipped", async () => {
    const { audio, context } = await liveAudio("landcruiser");
    const quiet = at(1_500, rolling(6)).state;
    audio.update(quiet);
    const before = context.counts.sources;
    audio.observe(at(1_500, rolling(6, { bumpStop: 0.7 })).state);
    audio.observe(quiet);
    audio.update(quiet);
    // The knock's noise burst.
    expect(context.counts.sources - before).toBe(1);
    audio.update(quiet);
    expect(context.counts.sources - before).toBe(1);
    audio.dispose();
  });
});
