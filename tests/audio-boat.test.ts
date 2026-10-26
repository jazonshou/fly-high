import { afterEach, describe, expect, it } from "vitest";
import { FlightAudio } from "../src/audio";
import {
  BOAT_EXHAUST_OPEN_HZ,
  BOAT_EXHAUST_SUBMERGED_HZ,
  BoatSlapDetector,
  boatSoundTargets,
} from "../src/audio/boatVoice";
import { INITIAL_VISUAL_STATE, type BoatVisualState, type FlightVisualState } from "../src/game/types";
import { surfaceVehicleSpec } from "../src/vehicles/catalogue";

/** The speedboat's sounds (src/audio/boatVoice.ts) and how FlightAudio layers them. */

const BOAT: BoatVisualState = {
  kind: "boat",
  speedThroughWater: 0,
  gear: "neutral",
  lever: 0,
  steerAngle: 0,
  trim: 0,
  trimAngle: 0,
  tabPort: 0,
  tabStarboard: 0,
  depthUnderKeel: 4,
  propellerImmersion: 1,
  moored: false,
  ventilating: false,
  capsized: false,
  planing: 0,
  wettedLength: 6,
  transomImmersion: 0.4,
  sprayRoots: [],
  sprayRootCount: 0,
};

function at(rpm: number, boat: Partial<BoatVisualState> = {}, state: Partial<FlightVisualState> = {}) {
  const payload = { ...BOAT, ...boat };
  return { state: { ...INITIAL_VISUAL_STATE, engineRpm: rpm, vehicle: payload, ...state }, boat: payload };
}

function targets(rpm: number, boat: Partial<BoatVisualState> = {}) {
  const { state, boat: payload } = at(rpm, boat);
  return boatSoundTargets(state, payload);
}

const IDLE = targets(700);
const PLANING = targets(5_200, { speedThroughWater: 18, gear: "forward", planing: 0.85, sprayRootCount: 16 });

describe("the boat's sound laws", () => {
  it("voices the V6's firing rate: the fundamental is rpm / 20", () => {
    const sound = surfaceVehicleSpec("speedboat").engineSound;
    const maximum = surfaceVehicleSpec("speedboat").engineReadout.maximum;
    for (const rpm of [700, 3_000, 6_000]) {
      // FlightAudio's law: baseHz + (rpm / maximum) x spanHz.
      expect(sound.baseHz + (rpm / maximum) * sound.spanHz).toBeCloseTo(rpm / 20, 9);
    }
  });

  it("muffles the exhaust through the hub under way and opens it at idle", () => {
    expect(IDLE.engineCutoffHz).toBeCloseTo(BOAT_EXHAUST_OPEN_HZ, 6);
    expect(PLANING.engineCutoffHz).toBeCloseTo(BOAT_EXHAUST_SUBMERGED_HZ, 6);
    // A propeller out of the water blows its exhaust in the air.
    expect(targets(5_200, { speedThroughWater: 18, propellerImmersion: 0 }).engineCutoffHz).toBeCloseTo(BOAT_EXHAUST_OPEN_HZ, 6);
    for (const target of [IDLE, PLANING]) expect(target.engineCutoffHz).toBeLessThanOrEqual(1_200);
  });

  it("burbles at idle and not once the engine is working", () => {
    expect(IDLE.burbleDepth).toBeGreaterThan(0.3);
    expect(targets(2_000).burbleDepth).toBe(0);
    expect(PLANING.burbleDepth).toBe(0);
  });

  it("rushes with speed, hisses only on the plane, and laps only a hull lying still", () => {
    expect(IDLE.rushGain).toBe(0);
    expect(targets(3_000, { speedThroughWater: 4 }).rushGain).toBeGreaterThan(0.2);
    expect(PLANING.rushGain).toBeGreaterThan(0.5);
    expect(PLANING.rushHz).toBeGreaterThan(targets(3_000, { speedThroughWater: 4 }).rushHz);
    expect(IDLE.hissGain).toBe(0);
    expect(targets(4_000, { speedThroughWater: 12, sprayRootCount: 16 }).hissGain).toBe(0);
    expect(PLANING.hissGain).toBeGreaterThan(0.5);
    expect(IDLE.lapsPerSecond).toBeGreaterThan(1);
    expect(PLANING.lapsPerSecond).toBe(0);
    expect(targets(700, { capsized: true }).lapsPerSecond).toBe(0);
  });

  it("whines only while the propeller draws air, and never shrill", () => {
    expect(PLANING.whineGain).toBe(0);
    const ventilating = targets(5_800, { speedThroughWater: 14, ventilating: true });
    expect(ventilating.whineGain).toBeGreaterThan(0.9);
    expect(ventilating.whineHz).toBeCloseTo(580, 6);
    expect(targets(20_000, { ventilating: true }).whineHz).toBe(1_200);
  });
});

describe("hearing the hull land", () => {
  it("slaps when the CG is kicked upward right after falling, harder for a harder landing", () => {
    const soft = new BoatSlapDetector();
    soft.update(10, -1);
    const softSlap = soft.update(10 + 1 / 60, -0.6);
    const hard = new BoatSlapDetector();
    hard.update(10, -2.5);
    const hardSlap = hard.update(10 + 1 / 60, -0.5);
    expect(softSlap).toBeGreaterThan(0);
    expect(hardSlap).toBeGreaterThan(softSlap);
  });

  it("stays quiet on a steady run, a climb, and across a pause", () => {
    const detector = new BoatSlapDetector();
    expect(detector.update(10, 0)).toBe(0);
    expect(detector.update(10 + 1 / 60, 0.01)).toBe(0);
    // Climbing hard from rest is not a landing.
    expect(detector.update(10 + 2 / 60, 0.5)).toBe(0);
    detector.update(20, -2);
    expect(detector.update(21, 0), "a second-long gap is not differenced").toBe(0);
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
  loop = false;
  connect<T>(target: T): T {
    return target;
  }
  start(): void {}
  stop(): void {}
}

class FakeContext {
  static created: FakeContext[] = [];
  readonly counts = { oscillators: 0, sources: 0, filters: 0, gains: 0 };
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

async function liveAudio(vehicle?: "speedboat"): Promise<{ audio: FlightAudio; context: FakeContext; engineFilter: FakeParam }> {
  globals.window = { AudioContext: FakeContext };
  const audio = new FlightAudio({ aircraft: "trainer", master: 1, engine: 1, wind: 1, ...(vehicle ? { vehicle } : {}) });
  await audio.unlock();
  const context = FakeContext.created[0]!;
  const engineFilter = (audio as unknown as { engineFilter: FakeNode }).engineFilter.frequency;
  return { audio, context, engineFilter };
}

describe("the boat's layer in the audio graph", () => {
  it("builds nothing for an aircraft session", async () => {
    const { audio, context } = await liveAudio();
    const before = { ...context.counts };
    for (let frame = 0; frame < 30; frame += 1) audio.update({ ...INITIAL_VISUAL_STATE, simulationTime: frame / 60 });
    expect(context.counts).toEqual(before);
    audio.dispose();
  });

  it("builds the boat's layer once, on the first boat state, and drives the exhaust's low-pass", async () => {
    const { audio, context, engineFilter } = await liveAudio("speedboat");
    // The menu's attract flight first: no boat payload, no boat layer.
    audio.update({ ...INITIAL_VISUAL_STATE });
    const graph = { ...context.counts };
    const { state } = at(5_200, { speedThroughWater: 18, planing: 0.85, sprayRootCount: 16 });
    audio.update(state);
    // The water's noise source, the whine and the burble's two oscillators.
    expect(context.counts.sources - graph.sources).toBe(1);
    expect(context.counts.oscillators - graph.oscillators).toBe(3);
    expect(engineFilter.value).toBeCloseTo(BOAT_EXHAUST_SUBMERGED_HZ, 6);
    const built = { ...context.counts };
    for (let frame = 1; frame < 30; frame += 1) audio.update({ ...state, simulationTime: frame / 60 });
    expect(context.counts).toEqual(built);
    audio.dispose();
  });
});
