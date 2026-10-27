import { describe, expect, it } from "vitest";
import type { WeatherPreset } from "../src/game/types";
import { GroundVehicleSimulator } from "../src/sim/ground";
import { CarSea, type CarSeaTwin } from "../src/sim/ground/carSea";
import { WaterSurfaceComposite } from "../src/sim/water/compositeWater";
import { HydrologyWaterSource } from "../src/sim/water/hydrologyWater";
import { resolveSeaSpectrumConfig, type SeaWorld } from "../src/sim/water/seaState";
import { createSeaTwin, SeaTwin } from "../src/sim/water/seaTwin";
import { createWaterSurfaceSample, type WaterSurfaceSample } from "../src/sim/water/types";
import { LANDCRUISER_76 } from "../src/vehicles/landcruiser76";
import { controls, headingOf, speedOf, STEP } from "./support/carRig";

/**
 * The car in the sea it is drawn in (land plan, "Water"): the boat's sea
 * twin, felt only where the car's ground is under the still sea level, and
 * never stepped while the car is ashore.
 */

// The shipping world's sea inputs (the perf baselines' seed and wind), as tests/world.sea-twin.test.ts.
const SEA_WORLD: SeaWorld & { readonly seaLevel: number } = Object.freeze({
  sourceSeedHash: 0x4f434541,
  prevailingWindRadians: 4.2243797,
  prevailingWindSpeed: 9.62323060631752,
  seaLevel: 0,
});

const GEOMETRY = LANDCRUISER_76.geometry;

/** A sea ford `depth` deep: down at 4% through the still waterline at z = 25, 10 m level, and up again. */
function seaFord(depth: number): { bed: (x: number, z: number) => number; far: number } {
  const down = (1 + depth) / 0.04;
  const far = 2 * down + 10;
  return { bed: (_x, z) => Math.max(-depth, 1 - 0.04 * z, 1 - 0.04 * (far - z)), far };
}

/** The car on its own lattice over `bed`, as in the worker, wading `water`. */
function seaCar(bed: (x: number, z: number) => number, water: CarSea): GroundVehicleSimulator {
  const sim = new GroundVehicleSimulator({
    position: { x: 0, y: bed(0, 0), z: 0 }, heading: 0, moored: false, car: { gearbox: "automatic", manualClutch: false },
  });
  sim.setEnvironment({
    water: new WaterSurfaceComposite(water, new HydrologyWaterSource(bed), 0),
    wind: { x: 0, y: 0, z: 0 },
    bedHeight: bed,
    world: null,
    colliders: null,
    gravity: 9.80665,
  });
  return sim;
}

/** One step as the worker takes it: the water's time first. */
function step(sim: GroundVehicleSimulator, water: CarSea): void {
  water.setTime(sim.state.time);
  sim.step(STEP);
}

/** Into 4L, then at walking pace (1.4 m/s) along +z to `until`, then braked; `each` after every step. */
function wadeTo(sim: GroundVehicleSimulator, water: CarSea, until: number, seconds: number, each?: () => void): void {
  let lean = 0;
  for (let i = 0; i < Math.round(seconds / STEP); i += 1) {
    if (i < 130) controls(sim, { handbrake: 1, rangePresses: i > 10 ? 2 : 0 });
    else if (sim.state.position.z < until) {
      const error = 1.4 - speedOf(sim);
      lean = Math.max(0, Math.min(1, lean + 0.15 * error * STEP));
      const steer = Math.max(-1, Math.min(1, 3 * headingOf(sim)));
      controls(sim, { rangePresses: 2, steer, accelerator: Math.max(0, Math.min(1, 0.1 + 0.4 * error + lean)) });
    } else controls(sim, { rangePresses: 2, brake: 1 });
    step(sim, water);
    each?.();
  }
}

/** Where wheel `w`'s contact stands, from the car's pose: x, z into `out`. */
function wheelPoint(sim: GroundVehicleSimulator, w: number, out: { x: number; z: number }): void {
  const heading = headingOf(sim);
  const along = w < 2 ? GEOMETRY.frontAxleX : GEOMETRY.rearAxleX;
  // Body +Z is right: world (-cos h, sin h). Wheels 0 and 2 are on the left.
  const across = (w % 2 === 0 ? -0.5 : 0.5) * (w < 2 ? GEOMETRY.frontTrack : GEOMETRY.rearTrack);
  out.x = sim.state.position.x + Math.sin(heading) * along - Math.cos(heading) * across;
  out.z = sim.state.position.z + Math.cos(heading) * along + Math.sin(heading) * across;
}

/** The twin's exact sum at the four wheels: the highest surface, and the highest at the front pair. */
function exactAtWheels(sim: GroundVehicleSimulator, exact: SeaTwin, sample: WaterSurfaceSample): { top: number; front: number } {
  exact.setTime(sim.state.time);
  const point = { x: 0, z: 0 };
  let top = -Infinity;
  let front = -Infinity;
  for (let w = 0; w < 4; w += 1) {
    wheelPoint(sim, w, point);
    const height = exact.sampleExact(point.x, point.z, sample).height;
    top = Math.max(top, height);
    if (w < 2) front = Math.max(front, height);
  }
  return { top, front };
}

/** A twin that counts what the car asks of it. */
class CountedTwin extends SeaTwin {
  steps = 0;
  samples = 0;

  override setTime(time: number): void {
    this.steps += 1;
    super.setTime(time);
  }

  override sample(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    this.samples += 1;
    return super.sample(x, z, out);
  }
}

function countedTwin(weather: WeatherPreset): CountedTwin {
  return new CountedTwin(resolveSeaSpectrumConfig(SEA_WORLD, weather), { seaLevel: SEA_WORLD.seaLevel });
}

describe("car in the sea", () => {
  it("wades a beach ford's waves: the wading depth follows the twin's surface, and the swell is felt", () => {
    // Clear weather (1.8 mm rms between the twin's fast path and its exact sum on a hull) and a ford
    // 0.2 m deep, whose crests stay under the intake.
    const { bed, far } = seaFord(0.2);
    const water = new CarSea(createSeaTwin(SEA_WORLD, "clear"), 0);
    const exact = createSeaTwin(SEA_WORLD, "clear");
    const sample = createWaterSurfaceSample();
    const sim = seaCar(bed, water);
    let squared = 0;
    let worst = 0;
    let count = 0;
    let shallowest = Infinity;
    let deepest = 0;
    let i = 0;
    wadeTo(sim, water, far + 5, 75, () => {
      i += 1;
      const z = sim.state.position.z;
      // Every eighth step with all four wheels on the level bed (wheels within 1.5 m of the body origin).
      if (i % 8 !== 0 || z < far / 2 - 3.5 || z > far / 2 + 3.5) return;
      const { top } = exactAtWheels(sim, exact, sample);
      const expected = Math.max(0, top + 0.2);
      const error = sim.visualState().wadingDepth - expected;
      squared += error * error;
      worst = Math.max(worst, Math.abs(error));
      count += 1;
      shallowest = Math.min(shallowest, sim.visualState().wadingDepth);
      deepest = Math.max(deepest, sim.visualState().wadingDepth);
    });
    expect(count).toBeGreaterThan(40);
    // Within the twin's own error, the 33 ms a wheel's answer is held and the 25 ms the twin may lag.
    expect(Math.sqrt(squared / count)).toBeLessThan(0.008);
    expect(worst).toBeLessThan(0.025);
    // Still water would hold it at 0.2 m.
    expect(deepest - shallowest).toBeGreaterThan(0.1);
    expect(sim.engine.flooded).toBe(false);
    expect(sim.state.position.z).toBeGreaterThan(far);
  });

  it("hydrolocks in Cloudy surf only when the twin's crest reaches the intake", () => {
    // A 0.3 m ford under Cloudy's 2.4 m sea: the drawn crests stand over a metre above the bed.
    const { bed, far } = seaFord(0.3);
    const water = new CarSea(createSeaTwin(SEA_WORLD, "cloudy"), 0);
    const exact = createSeaTwin(SEA_WORLD, "cloudy");
    const sample = createWaterSurfaceSample();
    const sim = seaCar(bed, water);
    let intakeClear = Number.NaN;
    wadeTo(sim, water, far + 5, 60, () => {
      if (!Number.isNaN(intakeClear) || !sim.engine.flooded) return;
      // The intake stands the published wading depth over the front wheels' ground (the car is all but level).
      const { front } = exactAtWheels(sim, exact, sample);
      intakeClear = bed(0, sim.state.position.z + GEOMETRY.frontAxleX) + LANDCRUISER_76.water.wadingDepth - front;
    });
    expect(sim.engine.flooded).toBe(true);
    expect(intakeClear).toBeLessThan(0.05);
  });

  it("never steps or samples the twin while every wheel stands above the still sea", () => {
    const { bed } = seaFord(0.2);
    const twin = countedTwin("clear");
    const water = new CarSea(twin, 0);
    const sim = seaCar(bed, water);
    // Down the beach to 0.35 m above the still sea at the front wheels (z = 16.3).
    wadeTo(sim, water, 15, 20);
    expect(sim.state.position.z).toBeGreaterThan(14);
    expect(twin.steps).toBe(0);
    expect(twin.samples).toBe(0);
    // On into the sea: now it is asked about one wheel a step and stepped every fourth step.
    const samplesBefore = twin.samples;
    wadeTo(sim, water, 40, 25);
    expect(sim.visualState().wadingDepth).toBeGreaterThan(0.05);
    expect(twin.samples - samplesBefore).toBeGreaterThan(0);
    expect(twin.samples).toBeLessThanOrEqual(Math.round(25 / STEP) + 3);
    expect(twin.steps).toBeLessThan(twin.samples / 3);
  });

  it("allocates nothing in the step while wading the sea but the two numbers of each call into the water", () => {
    // Parked on a level bed 0.2 m under a swell. The twin's own sums box some of their doubles
    // (about 150 B a step on this path), so the car and its sea are timed here over a single
    // allocation-free wave train in the twin's place.
    class Swell implements CarSeaTwin {
      samples = 0;
      private time = Number.NaN;
      setConfig(): void {}
      setTime(time: number): void {
        this.time = time;
      }
      setFocus(): void {}
      sample(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
        this.samples += 1;
        const phase = 0.1 * (x + z) - 1.2 * this.time;
        out.kind = "sea";
        out.height = 0.15 * Math.sin(phase);
        out.stillHeight = 0;
        out.depth = 30;
        out.velocity.x = 0;
        out.velocity.y = -0.18 * Math.cos(phase);
        out.velocity.z = 0;
        out.normal.x = 0;
        out.normal.y = 1;
        out.normal.z = 0;
        return out;
      }
    }
    const bed = (): number => -0.2;
    const twin = new Swell();
    const water = new CarSea(twin, 0);
    const sim = seaCar(bed, water);
    controls(sim, { handbrake: 1 });
    for (let k = 0; k < 600; k += 1) step(sim, water);
    expect(sim.visualState().wadingDepth).toBeGreaterThan(0.05);
    const run = (): { grown: number; allowed: number; steps: number; calls: number } => {
      const before = process.memoryUsage().heapUsed;
      const callsBefore = twin.samples;
      for (let k = 0; k < 20_000; k += 1) step(sim, water);
      const calls = twin.samples - callsBefore;
      return { grown: process.memoryUsage().heapUsed - before, allowed: 32 * 1024 + 32 * calls, steps: 20_000, calls };
    };
    const deadline = performance.now() + 30_000;
    let streak = 0;
    let last = { grown: Number.NaN, allowed: 0, steps: 0, calls: 0 };
    while (streak < 3 && performance.now() < deadline) {
      last = run();
      streak = last.grown >= 0 && last.grown < last.allowed ? streak + 1 : 0;
    }
    expect(streak, `last run grew the heap by ${last.grown} B of ${last.allowed}`).toBe(3);
    // One call a step into the water.
    expect(last.calls).toBe(last.steps);
  });
});
