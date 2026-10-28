import { afterEach, describe, expect, it } from "vitest";
import { FlightAudio } from "../src/audio";
import {
  breathLevel,
  breathRateHz,
  PERSON_SOUND_CEILING_HZ,
  PersonEffort,
  personStepVoice,
  strokeRateHz,
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

async function liveAudio() {
  globals.window = { AudioContext: FakeContext };
  const audio = new FlightAudio({ aircraft: "trainer", vehicle: "landcruiser", master: 1, engine: 1, wind: 1 });
  await audio.unlock();
  return { audio, context: FakeContext.created[0]! };
}

describe("the walker's layer in the audio graph", () => {
  it("plays a footstep at once, its grains by the footing, and none for a driver or in the air", async () => {
    const { audio, context } = await liveAudio();
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
    expect(Math.max(...context.filterHz)).toBeLessThanOrEqual(PERSON_SOUND_CEILING_HZ);
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
});
