import { describe, expect, it } from "vitest";
import {
  BOAT_WATERLINE_LENGTH,
  BoatSimulator,
  HULL_TRANSOM_CHINE_BEAM,
  KNOT,
  RUNABOUT_21,
  TestSea,
  savitskyBrownImpact,
} from "../src/sim/boat";
import type { StabilityAssistMode } from "../src/sim/assists";
import { NEUTRAL_BOAT_CONTROLS } from "../src/sim/surface";
import { CalmWaterSurface, createWaterSurfaceSample } from "../src/sim/water";
import { createSeaTwin } from "../src/sim/water/seaTwin";
import type { HullWaterSampler } from "../src/sim/water/types";
import { HULL_TRANSOM } from "../src/vehicles/boat/hullLines";
import type { BoatControlState } from "../src/game/types";

/**
 * The Runabout 21 in waves: riding a long swell, slamming in a short sea,
 * surviving half an hour of anything a player can do on the game's sea, and
 * lying still in calm water.
 */

const STEP = 1 / 120;
const DEG = Math.PI / 180;

/** The test world's sea inputs (the sea twin's own test world), at a chosen wind. */
function seaWorld(prevailingWindSpeed: number) {
  return { sourceSeedHash: 0x4f434541, prevailingWindRadians: 4.2243797, prevailingWindSpeed, seaLevel: 0 };
}

/** Significant height, 4 sigma of the surface at a point over 20 minutes. */
function significantHeight(water: HullWaterSampler): number {
  const sample = createWaterSurfaceSample();
  let sum = 0;
  let squares = 0;
  let n = 0;
  for (let t = 0; t < 1_200; t += 0.25) {
    water.setTime(t);
    water.sample(0, 0, sample);
    sum += sample.height;
    squares += sample.height * sample.height;
    n += 1;
  }
  return 4 * Math.sqrt(squares / n - (sum / n) ** 2);
}

function afloat(water: HullWaterSampler | CalmWaterSurface, heading: number, knots: number, assist: StabilityAssistMode = "pilot") {
  const boat = new BoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading, moored: false, speed: knots * KNOT, gear: knots > 0 ? "forward" : "neutral", rpm: knots > 0 ? 4_000 : 700 });
  boat.setEnvironment({ water, wind: { x: 0, y: 0, z: 0 }, bedHeight: () => -100, gravity: 9.80665 });
  const controls: { assist: StabilityAssistMode; boat: BoatControlState } = { assist, boat: { ...NEUTRAL_BOAT_CONTROLS } };
  boat.setControls(controls);
  return { boat, controls, telemetry: boat.telemetry() };
}

describe("boat in waves", () => {
  it("rides a long swell, heaving and pitching with it", () => {
    // 1 m high and 80 m long (a 7.2 s period, 14 hull lengths), from dead ahead.
    const sea = new TestSea([{ height: 1, length: 80, direction: Math.PI }]);
    const { boat, telemetry } = afloat(sea, 0, 0);
    const sample = createWaterSurfaceSample();
    const heave: number[] = [];
    const surface: number[] = [];
    const pitch: number[] = [];
    for (let i = 1; i * STEP <= 45; i += 1) {
      boat.step(STEP);
      if (i * STEP < 20) continue;
      boat.telemetry(telemetry);
      const p = boat.state.position;
      sea.sample(p.x, p.z, sample);
      heave.push(p.y);
      surface.push(sample.height);
      pitch.push(telemetry.pitch);
    }
    const span = (values: number[]) => (Math.max(...values) - Math.min(...values)) / 2;
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    expect(span(heave) / span(surface)).toBeGreaterThan(0.85);
    expect(span(heave) / span(surface)).toBeLessThan(1.15);
    // In step with the surface under it.
    const mh = mean(heave);
    const ms = mean(surface);
    let cross = 0;
    let vh = 0;
    let vs = 0;
    heave.forEach((h, i) => {
      cross += (h - mh) * (surface[i]! - ms);
      vh += (h - mh) ** 2;
      vs += (surface[i]! - ms) ** 2;
    });
    expect(cross / Math.sqrt(vh * vs)).toBeGreaterThan(0.95);
    // The bow follows the slope, a k = 2.25 degrees.
    const slope = 0.5 * ((2 * Math.PI) / 80);
    expect(span(pitch) / slope).toBeGreaterThan(0.7);
    expect(span(pitch) / slope).toBeLessThan(1.2);
  });

  it("slams 1-3 g into a 1 m head sea, as Savitsky and Brown predict", () => {
    // The game's drawn sea, its wind set for a 1 m significant height.
    const twin = createSeaTwin(seaWorld(6.8), "breezy");
    const height = significantHeight(twin);
    expect(height).toBeGreaterThan(0.85);
    expect(height).toBeLessThan(1.15);
    const lever = 0.64;
    // Calm-water trim and speed at the same lever, for the prediction.
    const calm = afloat(new CalmWaterSurface(0, () => -100), 0, 20);
    calm.controls.boat.lever = lever;
    calm.boat.setControls(calm.controls);
    for (let t = 0; t < 30; t += STEP) calm.boat.step(STEP);
    calm.boat.telemetry(calm.telemetry);

    // Heading into the wind (the prevailing wind's bearing is where it blows
    // toward): the waves come from dead ahead.
    const run = afloat(twin, seaWorld(6.8).prevailingWindRadians + Math.PI, 20);
    run.controls.boat.lever = lever;
    run.boat.setControls(run.controls);
    for (let t = 0; t < 10; t += STEP) run.boat.step(STEP);
    // Rigid-body vertical acceleration at the CG: the 120 Hz signal averaged over 1/20 s.
    const window: number[] = [];
    const accelerations: number[] = [];
    let speed = 0;
    for (let i = 0; i < 120 * 120; i += 1) {
      run.boat.step(STEP);
      run.boat.telemetry(run.telemetry);
      window.push(run.telemetry.loadFactor - 1);
      if (window.length > 6) window.shift();
      accelerations.push(window.reduce((a, b) => a + b, 0) / window.length);
      speed += run.telemetry.speedThroughWater;
    }
    speed /= 120 * 120;
    expect(run.telemetry.crashed).toBe(false);
    // Each impact's peak, then the mean of the highest tenth.
    const peaks: number[] = [];
    for (let i = 0; i < accelerations.length; ) {
      if (accelerations[i]! <= 0.3) {
        i += 1;
        continue;
      }
      let peak = accelerations[i]!;
      const end = Math.min(accelerations.length, i + 24);
      for (; i < end; i += 1) peak = Math.max(peak, accelerations[i]!);
      peaks.push(peak);
    }
    peaks.sort((a, b) => b - a);
    const tenth = peaks.slice(0, Math.max(1, Math.round(peaks.length / 10)));
    const impact = tenth.reduce((a, b) => a + b, 0) / tenth.length;
    expect(peaks.length).toBeGreaterThan(100);
    expect(impact).toBeGreaterThan(1);
    expect(impact).toBeLessThan(3);
    const predicted = savitskyBrownImpact(
      {
        beam: HULL_TRANSOM_CHINE_BEAM,
        deadriseDegrees: HULL_TRANSOM.deadriseDegrees,
        length: BOAT_WATERLINE_LENGTH,
        weight: RUNABOUT_21.mass * 9.80665,
      },
      height,
      calm.telemetry.runningTrim / DEG,
      speed,
    );
    // The empirical fit's own scatter is about 30 percent. On the sea that
    // travels downwind (2026-10-27) the crest water runs at the bow, the boat
    // slows to 9.5 m/s and slams 2.2 g, 1.41 times the fit at that speed; on
    // the old upwind sea, whose crest water ran away from the bow, it was 0.64.
    expect(impact / predicted).toBeGreaterThan(0.6);
    expect(impact / predicted).toBeLessThan(1.5);
  });

  it("takes half an hour of random helm, throttle, trim and tabs on the game's breezy sea and stays finite", { timeout: 120_000 }, () => {
    const twin = createSeaTwin(seaWorld(9.62323060631752), "breezy");
    const run = afloat(twin, 0, 0, "unassisted");
    let seed = 0x2545f491;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 4_294_967_296;
    };
    const controls = run.controls.boat;
    let recoveries = 0;
    const finite = (v: { x: number; y: number; z: number }) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    for (let i = 0; i < 30 * 60 * 120; i += 1) {
      if (i % 240 === 0) {
        controls.lever = random() * 2.2 - 1.1;
        controls.steer = random() * 2 - 1;
        controls.trim = random() < 0.3 ? Math.sign(random() - 0.5) : 0;
        controls.tabs = random() < 0.2 ? Math.sign(random() - 0.5) : 0;
        run.controls.assist = (["scenic", "pilot", "unassisted"] as const)[Math.floor(random() * 3)]!;
        run.boat.setControls(run.controls);
      }
      run.boat.step(STEP);
      if (i % 120 === 0) {
        const state = run.boat.state;
        expect(finite(state.position) && finite(state.velocity) && finite(state.angularVelocity)).toBe(true);
        expect(Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z)).toBeLessThan(40);
        run.boat.telemetry(run.telemetry);
        expect(Number.isFinite(run.telemetry.rpm) && Number.isFinite(run.telemetry.loadFactor)).toBe(true);
        if (run.telemetry.crashed) {
          // R: upright and afloat where it was.
          recoveries += 1;
          run.boat.reset({ position: { x: state.position.x, y: 0, z: state.position.z }, heading: run.telemetry.heading, moored: false });
        }
      }
    }
    // Random input wrecks a boat now and then, not all the time.
    expect(recoveries).toBeLessThan(30);
  });

  it("lies still at rest in calm water, unmoored, for two minutes", () => {
    const { boat, telemetry } = afloat(new CalmWaterSurface(0, () => -100), 0.7, 0);
    for (let t = 0; t < 10; t += STEP) boat.step(STEP);
    boat.telemetry(telemetry);
    const start = { ...boat.state.position };
    const heading = telemetry.heading;
    const pitch = telemetry.pitch;
    const roll = telemetry.roll;
    for (let t = 0; t < 120; t += STEP) boat.step(STEP);
    boat.telemetry(telemetry);
    const end = boat.state.position;
    expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeLessThan(0.02);
    expect(Math.abs(end.y - start.y)).toBeLessThan(0.002);
    expect(Math.abs(telemetry.heading - heading) / DEG).toBeLessThan(0.1);
    expect(Math.abs(telemetry.pitch - pitch) / DEG).toBeLessThan(0.05);
    expect(Math.abs(telemetry.roll - roll) / DEG).toBeLessThan(0.05);
  });
});
