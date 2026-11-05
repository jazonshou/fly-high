import { afterEach, describe, expect, it } from "vitest";
import { FlightAudio } from "../src/audio";
import {
  breathLevel,
  breathRateHz,
  groundWindShare,
  PERSON_BUBBLE,
  PERSON_GROUND_WIND_MAX,
  PERSON_SOUND_CEILING_HZ,
  PersonEffort,
  personStepVoice,
  strokeRateHz,
  UNDERWATER_MUFFLE_HZ,
} from "../src/audio/personVoice";
import {
  INITIAL_VISUAL_STATE,
  PERSON_SURFACE_COLLIDER_BASE,
  PERSON_SURFACE_WATER,
  type FlightVisualState,
  type PersonVisualState,
} from "../src/game/types";
import { SurfaceMaterial } from "../src/render/webgpu/terrain/surfaceMaterials";
import { CAR_COLLIDER_MATERIAL } from "../src/sim/ground/carColliders";
import { MARINA_COLLIDER_MATERIAL } from "../src/sim/marina/colliders";
import { PARKED_CAR_COLLIDER_MATERIAL } from "../src/sim/person/types";

/** The walker's sounds (src/audio/personVoice.ts) and how FlightAudio layers them. */

const WALKER: PersonVisualState = {
  kind: "person",
  mode: "walk",
  speed: 1.3,
  running: false,
  grounded: true,
  slope: 0,
  waterDepth: 0,
  submersion: 0,
  headDepth: -1.6,
  swimPitch: 0,
  landingSpeed: 0,
  landingAge: 100,
  surface: SurfaceMaterial.Grass,
  boarding: null,
};

const onFoot = (person: Partial<PersonVisualState> = {}): FlightVisualState => ({
  ...INITIAL_VISUAL_STATE,
  velocity: { x: 0, y: 0, z: 0 },
  vehicle: { ...WALKER, ...person },
});

describe("the walker's sound laws", () => {
  it("voices each footing: tap, crunch, scuff, swish, knock, hollow, ring, splash, and nothing in the air", () => {
    expect(personStepVoice(SurfaceMaterial.Asphalt)?.name).toBe("tap");
    expect(personStepVoice(SurfaceMaterial.Concrete)?.name).toBe("tap");
    expect(personStepVoice(SurfaceMaterial.Gravel)?.name).toBe("crunch");
    expect(personStepVoice(SurfaceMaterial.Snow)?.name).toBe("crunch");
    expect(personStepVoice(SurfaceMaterial.Sand)?.name).toBe("scuff");
    expect(personStepVoice(SurfaceMaterial.Grass)?.name).toBe("swish");
    expect(personStepVoice(SurfaceMaterial.ForestFloor)?.name).toBe("swish");
    expect(personStepVoice(SurfaceMaterial.Rock)?.name).toBe("knock");
    expect(personStepVoice(PERSON_SURFACE_COLLIDER_BASE + MARINA_COLLIDER_MATERIAL.pontoon)?.name).toBe("hollow");
    expect(personStepVoice(PERSON_SURFACE_COLLIDER_BASE + MARINA_COLLIDER_MATERIAL.timber)?.name).toBe("hollow");
    expect(personStepVoice(PERSON_SURFACE_COLLIDER_BASE + MARINA_COLLIDER_MATERIAL.concrete)?.name).toBe("tap");
    expect(personStepVoice(PERSON_SURFACE_COLLIDER_BASE + PARKED_CAR_COLLIDER_MATERIAL)?.name).toBe("ring");
    expect(personStepVoice(PERSON_SURFACE_COLLIDER_BASE + CAR_COLLIDER_MATERIAL.building)?.name).toBe("tap");
    expect(personStepVoice(PERSON_SURFACE_WATER)?.name).toBe("splash");
    // Ankle-deep on sand splashes; a wet sole does not.
    expect(personStepVoice(SurfaceMaterial.Sand, 0.2)?.name).toBe("splash");
    expect(personStepVoice(SurfaceMaterial.Sand, 0.01)?.name).toBe("scuff");
    expect(personStepVoice(-1)).toBeNull();
  });

  it("keeps every footstep under the car's 1.2 kHz ceiling", () => {
    for (const surface of [...Object.values(SurfaceMaterial), PERSON_SURFACE_WATER, PERSON_SURFACE_COLLIDER_BASE + 104]) {
      const voice = personStepVoice(surface);
      if (voice) expect(voice.hertz * 1.1).toBeLessThanOrEqual(PERSON_SOUND_CEILING_HZ);
    }
  });

  it("builds effort running, more slowly swimming, holds it walking and lets it go at rest", () => {
    const effort = new PersonEffort();
    for (let t = 0; t < 12.5; t += 0.05) effort.step({ ...WALKER, mode: "run", speed: 4, running: true }, 0.05);
    expect(effort.value).toBeCloseTo(0.5, 2);
    for (let t = 0; t < 5; t += 0.05) effort.step(WALKER, 0.05);
    expect(effort.value).toBeCloseTo(0.5, 2);
    for (let t = 0; t < 7.5; t += 0.05) effort.step({ ...WALKER, mode: "stand", speed: 0 }, 0.05);
    expect(effort.value).toBeCloseTo(0, 2);
    for (let t = 0; t < 20; t += 0.05) effort.step({ ...WALKER, mode: "swim", speed: 1 }, 0.05);
    expect(effort.value).toBeCloseTo(0.5, 2);
  });

  it("breathes faster with effort and is silent until the walker has worked a while", () => {
    expect(breathRateHz(0)).toBeCloseTo(0.25, 9);
    expect(breathRateHz(1)).toBeCloseTo(0.7, 9);
    expect(breathLevel(0)).toBe(0);
    expect(breathLevel(0.1)).toBe(0);
    expect(breathLevel(1)).toBe(1);
    expect(strokeRateHz(0)).toBeCloseTo(0.5, 9);
    expect(strokeRateHz(2)).toBeCloseTo(1, 9);
  });

  it("hears the wind past the ear: nothing in a light air, most of it at 10 m/s, louder running into it", () => {
    expect(groundWindShare(0)).toBe(0);
    expect(groundWindShare(1)).toBe(0);
    expect(groundWindShare(10)).toBe(PERSON_GROUND_WIND_MAX);
    expect(groundWindShare(30)).toBe(PERSON_GROUND_WIND_MAX);
    expect(groundWindShare(Number.NaN)).toBe(0);
    // A 3 m/s breeze: running into it at 4 m/s, standing in it, running with it.
    expect(groundWindShare(7)).toBeGreaterThan(groundWindShare(3));
    expect(groundWindShare(3)).toBeGreaterThan(groundWindShare(1));
  });

  it("keeps the bubbles and the muffle under the ceiling", () => {
    expect(PERSON_BUBBLE.highHz * PERSON_BUBBLE.rise).toBeLessThanOrEqual(PERSON_SOUND_CEILING_HZ);
    expect(UNDERWATER_MUFFLE_HZ).toBeLessThanOrEqual(PERSON_SOUND_CEILING_HZ);
  });
});

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
  readonly filterHz: number[] = [];
  /** Every gain node, in the order made: the graph's own are master, engine, its second harmonic, wind, ground, stall. */
  readonly gains: FakeNode[] = [];
  state: AudioContextState = "running";
  currentTime = 0;
  readonly sampleRate = 8_000;
  readonly destination = new FakeNode();
  constructor() {
    FakeContext.created.push(this);
  }
  createGain(): FakeNode {
    this.counts.gains += 1;
    const node = new FakeNode();
    this.gains.push(node);
    return node;
  }
  createBiquadFilter(): FakeNode {
    this.counts.filters += 1;
    const node = new FakeNode();
    const filterHz = this.filterHz;
    // Read the frequency each filter ends up set to.
    let hertz = 0;
    Object.defineProperty(node.frequency, "value", {
      get: () => hertz,
      set: (value: number) => {
        hertz = value;
        filterHz.push(value);
      },
    });
    return node;
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

async function liveAudio(vehicle: "landcruiser" | "speedboat" | null = "landcruiser") {
  globals.window = { AudioContext: FakeContext };
  const audio = new FlightAudio({ aircraft: "trainer", ...(vehicle ? { vehicle } : {}), master: 1, engine: 1, wind: 1 });
  await audio.unlock();
  return { audio, context: FakeContext.created[0]! };
}

describe("the walker's layer in the audio graph", () => {
  it("plays a footstep at once, its grains by the footing, and none for a driver or in the air", async () => {
    const { audio, context } = await liveAudio();
    const filtersBefore = context.filterHz.length;
    let before = context.counts.sources;
    audio.footstep(onFoot({ surface: SurfaceMaterial.Gravel }), 0.5);
    expect(context.counts.sources - before).toBe(4);
    before = context.counts.sources;
    audio.footstep(onFoot({ surface: SurfaceMaterial.Asphalt }), 0.5);
    expect(context.counts.sources - before).toBe(1);
    before = context.counts.sources;
    audio.footstep(INITIAL_VISUAL_STATE, 0.5);
    audio.footstep(onFoot({ surface: -1 }), 0.5);
    expect(context.counts.sources - before).toBe(0);
    expect(Math.max(...context.filterHz.slice(filtersBefore))).toBeLessThanOrEqual(PERSON_SOUND_CEILING_HZ);
    audio.dispose();
  });

  it("breathes only after running a while, and not with the head under", async () => {
    const { audio, context } = await liveAudio();
    const running = onFoot({ mode: "run", speed: 4.5, running: true });
    const sourcesAt = () => context.counts.sources;
    audio.update(running);
    const start = sourcesAt();
    for (let t = 0; t < 3; t += 0.05) {
      context.currentTime += 0.05;
      audio.update(running);
    }
    expect(sourcesAt() - start).toBe(0);
    for (let t = 0; t < 20; t += 0.05) {
      context.currentTime += 0.05;
      audio.update(running);
    }
    const breathing = sourcesAt();
    expect(breathing - start).toBeGreaterThan(4);
    const diving = onFoot({ mode: "dive", speed: 0, headDepth: 1.5, waterDepth: 3, submersion: 1, surface: PERSON_SURFACE_WATER });
    for (let t = 0; t < 2; t += 0.05) {
      context.currentTime += 0.05;
      audio.update(diving);
    }
    expect(sourcesAt() - breathing).toBe(0);
    audio.dispose();
  });

  it("thumps a hard landing once, and splashes strokes while swimming", async () => {
    const { audio, context } = await liveAudio();
    audio.update(onFoot({ landingAge: 3, landingSpeed: 6 }));
    let before = context.counts.sources;
    context.currentTime += 0.05;
    audio.update(onFoot({ landingAge: 0.01, landingSpeed: 6 }));
    expect(context.counts.sources - before).toBe(1);
    before = context.counts.sources;
    context.currentTime += 0.05;
    audio.update(onFoot({ landingAge: 0.06, landingSpeed: 6 }));
    expect(context.counts.sources - before).toBe(0);
    const swimming = onFoot({ mode: "swim", speed: 1.2, waterDepth: 2.5, headDepth: -0.1, surface: PERSON_SURFACE_WATER });
    before = context.counts.sources;
    for (let t = 0; t < 4; t += 0.05) {
      context.currentTime += 0.05;
      audio.update(swimming);
    }
    // About 0.9 strokes a second, two bursts each.
    const strokes = (context.counts.sources - before) / 2;
    expect(strokes).toBeGreaterThanOrEqual(3);
    expect(strokes).toBeLessThanOrEqual(5);
    audio.dispose();
  });

  it("lets out bubbles as the head goes under, and a breath of them every few seconds after", async () => {
    const { audio, context } = await liveAudio();
    const diving = onFoot({ mode: "dive", speed: 0, headDepth: 1.5, waterDepth: 3, submersion: 1, surface: PERSON_SURFACE_WATER });
    audio.update(onFoot({ mode: "swim", speed: 0, headDepth: -0.1, waterDepth: 3, surface: PERSON_SURFACE_WATER }));
    let before = context.counts.oscillators;
    context.currentTime += 0.05;
    audio.update(diving);
    expect(context.counts.oscillators - before).toBe(9);
    before = context.counts.oscillators;
    for (let t = 0; t < 2; t += 0.05) {
      context.currentTime += 0.05;
      audio.update(diving);
    }
    expect(context.counts.oscillators - before).toBe(0);
    for (let t = 0; t < 6; t += 0.05) {
      context.currentTime += 0.05;
      audio.update(diving);
    }
    expect(context.counts.oscillators - before).toBeGreaterThanOrEqual(5);
    audio.dispose();
  });

  it("muffles everything while the camera is under, in car sessions only", async () => {
    const { audio, context } = await liveAudio();
    const withMuffle = context.counts.filters;
    const nyquist = context.sampleRate / 2;
    // The muffle starts wide open: the Nyquist frequency passes everything.
    expect(context.filterHz).toContain(nyquist);
    audio.setSurroundings({ windX: 0, windY: 0, windZ: 0, cameraUnderwaterDepth: 1.2 });
    audio.update(onFoot({ mode: "dive", headDepth: 1.5, waterDepth: 3, submersion: 1, surface: PERSON_SURFACE_WATER }));
    expect(context.filterHz.at(-1)).toBe(UNDERWATER_MUFFLE_HZ);
    audio.setSurroundings({ windX: 0, windY: 0, windZ: 0, cameraUnderwaterDepth: 0 });
    audio.update(onFoot());
    expect(context.filterHz.at(-1)).toBe(nyquist);
    audio.dispose();
    for (const vehicle of [null, "speedboat"] as const) {
      FakeContext.created = [];
      const other = await liveAudio(vehicle);
      // A walker can only dive from the car: the aircraft and the boat keep their graph as it was.
      expect(other.context.counts.filters).toBe(withMuffle - 1);
      expect(other.context.filterHz).not.toContain(other.context.sampleRate / 2);
      other.audio.dispose();
    }
  });

  it("hears the wind at the walker, not their speed, and the water's hum under it", async () => {
    const { audio, context } = await liveAudio();
    const windGain = context.gains[3]!;
    const groundGain = context.gains[4]!;
    const calm = { windX: 0, windY: 0, windZ: 0, cameraUnderwaterDepth: 0 };
    audio.setSurroundings(calm);
    audio.update(onFoot({ mode: "stand", speed: 0 }));
    expect(windGain.gain.value).toBe(0);
    // A 4 m/s breeze along +x: standing in it, running into it, running with it.
    const breeze = { ...calm, windX: 4 };
    audio.setSurroundings(breeze);
    audio.update(onFoot({ mode: "stand", speed: 0 }));
    const standing = windGain.gain.value;
    expect(standing).toBeGreaterThan(0);
    audio.update({ ...onFoot({ mode: "run", speed: 4, running: true }), velocity: { x: -4, y: 0, z: 0 } });
    expect(windGain.gain.value).toBeGreaterThan(standing);
    audio.update({ ...onFoot({ mode: "run", speed: 4, running: true }), velocity: { x: 4, y: 0, z: 0 } });
    expect(windGain.gain.value).toBe(0);
    // Feet do not rumble like wheels.
    audio.update({ ...onFoot({ mode: "run", speed: 4, running: true }), velocity: { x: 4, y: 0, z: 0 }, onGround: true });
    expect(groundGain.gain.value).toBe(0);
    // Under the water: no wind, the water's low hum.
    audio.setSurroundings({ ...breeze, cameraUnderwaterDepth: 0.8 });
    audio.update(onFoot({ mode: "dive", headDepth: 1, waterDepth: 3, submersion: 1, surface: PERSON_SURFACE_WATER }));
    expect(windGain.gain.value).toBe(0);
    expect(groundGain.gain.value).toBeGreaterThan(0);
    audio.dispose();
  });
});
