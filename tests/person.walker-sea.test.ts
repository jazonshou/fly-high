import { describe, expect, it } from "vitest";
import { PERSON_SURFACE_WATER, type WeatherPreset } from "../src/game/types";
import { GroundVehicleSimulator } from "../src/sim/ground";
import { CarSea } from "../src/sim/ground/carSea";
import { WaterSurfaceComposite } from "../src/sim/water/compositeWater";
import { HydrologyWaterSource } from "../src/sim/water/hydrologyWater";
import { resolveSeaSpectrumConfig, type SeaWorld } from "../src/sim/water/seaState";
import { SeaTwin } from "../src/sim/water/seaTwin";
import { createWaterSurfaceSample, type WaterSurfaceSample } from "../src/sim/water/types";
import { PERSON } from "../src/vehicles/person";
import { controls as carControls } from "./support/carRig";
import { controls, environment, flat, payload, rampAlongX, run, STEP, walker, type Ground } from "./support/walkerRig";

/**
 * The walker in a car session's sea (W1 brief, "the walker's sea"): the
 * worker's water is `WaterSurfaceComposite(CarSea, hydrology, seaLevel)`, and
 * `CarSea` asks the boats' sea twin only where the ground under the one
 * asking is below the still sea. The walker focuses it on itself before each
 * sample, so a swimmer gets the twin's fast path round it (no exact sums),
 * and on land the twin is neither stepped nor asked. The walker asks one step
 * in four and carries the answer between, so beside its parked car still
 * rocking in the same sea (whose wheels the twin then follows) it pays the
 * twin's exact sum a quarter as often.
 */

// The shipping world's sea inputs (the perf baselines' seed and wind), as tests/sim.car-sea.test.ts.
const SEA_WORLD: SeaWorld & { readonly seaLevel: number } = Object.freeze({
  sourceSeedHash: 0x4f434541,
  prevailingWindRadians: 4.2243797,
  prevailingWindSpeed: 9.62323060631752,
  seaLevel: 0,
});

/** A twin that counts what the walker asks of it. */
class CountedTwin extends SeaTwin {
  steps = 0;
  samples = 0;
  exact = 0;

  override setTime(time: number): void {
    this.steps += 1;
    super.setTime(time);
  }

  override sample(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    this.samples += 1;
    return super.sample(x, z, out);
  }

  override sampleExact(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    this.exact += 1;
    return super.sampleExact(x, z, out);
  }
}

function twinFor(weather: WeatherPreset): CountedTwin {
  return new CountedTwin(resolveSeaSpectrumConfig(SEA_WORLD, weather), { seaLevel: SEA_WORLD.seaLevel });
}

/** A car session's water over `ground`, as the worker builds it: the car's sea, and lakes and rivers (none here). */
function carSessionWater(ground: Ground, twin: SeaTwin): WaterSurfaceComposite {
  const bed = (x: number, z: number) => ground.height(x, z);
  return new WaterSurfaceComposite(new CarSea(twin, SEA_WORLD.seaLevel), new HydrologyWaterSource(bed), SEA_WORLD.seaLevel);
}

describe("walker in the car's sea", () => {
  for (const [weather, rms, worst] of [["clear", 0.01, 0.025], ["cloudy", 0.02, 0.05]] as const) {
    it(`swims on the twin's ${weather} swell, the eye just over the drawn surface, on the twin's fast path`, () => {
      const ground = flat(-8);
      const twin = twinFor(weather);
      // The same sea summed wave by wave: the surface the renderer draws.
      const drawn = twinFor(weather);
      const env = environment(ground, { water: carSessionWater(ground, twin) });
      const subject = walker({ x: 0, y: -8, z: 0 }, 0, ground);
      run(subject, env, 4, {});
      expect(payload(subject).mode).toBe("swim");
      const sample = createWaterSurfaceSample();
      let squares = 0;
      let largest = 0;
      let count = 0;
      let lowest = Infinity;
      let highest = -Infinity;
      const before = { steps: twin.steps, samples: twin.samples, exact: twin.exact };
      // Twenty seconds swimming across the sea, slowly, then at a crawl.
      const each = (): void => {
        const at = subject.state.position;
        drawn.setTime(subject.state.time);
        const surface = drawn.sampleExact(at.x, at.z, sample).height;
        const error = surface - (at.y + PERSON.eyeHeight) + 0.05;
        squares += error * error;
        largest = Math.max(largest, Math.abs(error));
        count += 1;
        lowest = Math.min(lowest, surface);
        highest = Math.max(highest, surface);
        expect(payload(subject).surface).toBe(PERSON_SURFACE_WATER);
      };
      run(subject, env, 10, { moveZ: 0.5 }, each);
      run(subject, env, 10, { moveX: 1, run: true }, each);
      expect(payload(subject).mode).toBe("swim");
      expect(Math.sqrt(squares / count)).toBeLessThan(rms);
      expect(largest).toBeLessThan(worst);
      // The swell is felt: still water would hold the eye level.
      expect(highest - lowest).toBeGreaterThan(weather === "clear" ? 0.15 : 0.8);
      // Asked one step in four (carried between), stepped no more often, and never summed exactly:
      // the focus is the swimmer's.
      const asked = twin.samples - before.samples;
      expect(Math.abs(asked - count / 4)).toBeLessThanOrEqual(1);
      expect(twin.steps - before.steps).toBeLessThanOrEqual(asked);
      expect(twin.exact - before.exact).toBe(0);
    });
  }

  it("never steps or asks the twin on land, and does from the waterline down the beach", () => {
    // A beach rising along +x at 1:10 through the still waterline at x = 30.
    const ground = rampAlongX(-3, 0, 0.1, 3);
    const twin = twinFor("clear");
    const env = environment(ground, { water: carSessionWater(ground, twin) });
    const subject = walker({ x: 45, y: ground.height(45, 0), z: 0 }, -Math.PI / 2, ground);
    let firstAsked = Number.NaN;
    run(subject, env, 45, { moveX: -1 }, (s) => {
      if (twin.samples > 0 && Number.isNaN(firstAsked)) firstAsked = s.state.position.x;
    });
    // First asked where the ground comes within CarSea's 0.1 m of the still sea.
    expect(firstAsked).toBeLessThan(31.05);
    expect(firstAsked).toBeGreaterThan(30.5);
    expect(subject.state.position.x).toBeLessThan(8);
    expect(payload(subject).mode).toBe("swim");
    expect(twin.exact).toBe(0);
    // And back up the beach: on land again it is left alone.
    run(subject, env, 60, { moveX: 1 });
    expect(subject.state.position.x).toBeGreaterThan(36);
    const left = { steps: twin.steps, samples: twin.samples };
    run(subject, env, 5, {});
    expect(twin.steps).toBe(left.steps);
    expect(twin.samples).toBe(left.samples);
  });

  it("beside its parked car rocking in the same sea, sums the sea exactly only one step in four", () => {
    // Cloudy surf 0.9 m deep, where a handbraked car does not come to rest; the walker gets out by
    // the right-hand door (1.4 m out) and wades off. The car asks first each step, so the twin
    // follows its wheels and the walker's answers are summed wave by wave.
    const ground = flat(-0.9);
    const twin = twinFor("cloudy");
    const env = environment(ground, { water: carSessionWater(ground, twin) });
    const car = new GroundVehicleSimulator({
      position: { x: 0, y: -0.9, z: 0 }, heading: 0, moored: false, car: { gearbox: "automatic", manualClutch: false },
    });
    carControls(car, { handbrake: 1 });
    const subject = walker({ x: 1.4, y: -0.9, z: -0.25 }, Math.PI / 2, ground);
    subject.setControls(controls({ moveX: 1 }));
    const steps = 20 * 120;
    let exactBefore = 0;
    let asked = 0;
    // The walking session's rest rule: under 0.03 m/s and 0.03 rad/s for a second puts it to sleep.
    let rest = 0;
    let longestRest = 0;
    for (let i = 0; i < steps; i += 1) {
      if (i === 120) {
        exactBefore = twin.exact;
        asked = 0;
      }
      env.water.setTime(subject.state.time);
      car.setEnvironment(env);
      car.step(STEP);
      const { velocity, angularVelocity } = car.state;
      const still = Math.hypot(velocity.x, velocity.y, velocity.z) < 0.03
        && Math.hypot(angularVelocity.x, angularVelocity.y, angularVelocity.z) < 0.03;
      rest = still ? rest + STEP : 0;
      longestRest = Math.max(longestRest, rest);
      const samples = twin.samples;
      subject.setEnvironment(env);
      subject.step(STEP);
      asked += twin.samples - samples;
    }
    expect(longestRest).toBeLessThan(1);
    expect(subject.state.position.x).toBeGreaterThan(10);
    expect(payload(subject).waterDepth).toBeGreaterThan(0.2);
    // The walker's asks: one in four steps, every one summed exactly.
    expect(Math.abs(asked - (steps - 120) / 4)).toBeLessThanOrEqual(1);
    expect(twin.exact - exactBefore).toBe(asked);
  });

  it("finds no sea over ground above its still level, where the terrain draws the swash", () => {
    // Cloudy crests run over ground 5 cm above the still sea (inside CarSea's dry margin, so the twin
    // is asked), and over ground 0.4 m under it.
    const sample = createWaterSurfaceSample();
    const drawn = twinFor("cloudy");
    for (const [height, wet] of [[0.05, false], [-0.4, true]] as const) {
      const ground = flat(height);
      const twin = twinFor("cloudy");
      const env = environment(ground, { water: carSessionWater(ground, twin) });
      const subject = walker({ x: 0, y: height, z: 0 }, 0, ground);
      let crest = -Infinity;
      let deepest = 0;
      run(subject, env, 20, {}, (s) => {
        drawn.setTime(s.state.time);
        crest = Math.max(crest, drawn.sampleExact(0, 0, sample).height);
        deepest = Math.max(deepest, payload(s).waterDepth);
      });
      expect(twin.samples).toBeGreaterThan(0);
      expect(crest - height).toBeGreaterThan(0.3);
      if (wet) {
        expect(deepest).toBeGreaterThan(0.3);
      } else {
        expect(deepest).toBe(0);
        expect(payload(subject).surface).not.toBe(PERSON_SURFACE_WATER);
      }
    }
  });
});
