import { describe, expect, it } from "vitest";
import { PERSON, toblerFactor } from "../src/vehicles/person";
import { walk, type WalkRecord } from "./personMotionRig";

/**
 * The walker's drawn gait, driven as the renderer drives it
 * (tests/personMotionRig.ts): cadence against the published bands, planted
 * feet that hold their world point, the walk-run switch at 2.0 m/s seen in
 * the feet (double support walking, a flight phase running), and the knee
 * and pelvis ranges of the published curves.
 *
 * PUBLISHED bands: walking cadence about 100-125 steps a minute at the
 * preferred 1.4 m/s (Grieve & Gear 1966; Murray et al. 1964), running
 * 150-180 from the switch to 4.5 m/s (Cavanagh & Kram 1989); peak knee
 * flexion about 60 degrees walking (swing) and 80-110 running (Winter
 * 1991; Novacheck 1998); the pelvis's vertical travel about 4-5 cm walking
 * (Saunders, Inman & Eberhart 1953).
 */

const cache = new Map<string, WalkRecord>();
function measured(mode: "walk" | "run" | "stand", speed: number, slopeDegrees = 0): WalkRecord {
  const key = `${mode} ${speed} ${slopeDegrees}`;
  let record = cache.get(key);
  if (!record) {
    record = walk(mode, speed, slopeDegrees);
    cache.set(key, record);
  }
  return record;
}

function cadence(record: WalkRecord): number {
  return (record.strikes / record.seconds) * 60;
}

/** The walker's speed up (positive) or down a slope of `degrees`: the sim's Tobler factor on its walk or run. */
function slopeSpeed(base: number, degrees: number): number {
  return base * toblerFactor(Math.tan((degrees * Math.PI) / 180));
}

describe("the walker's gait cadence", () => {
  it.each([
    [1.0, 85, 100],
    [1.4, 105, 125],
    [1.8, 125, 140],
  ])("walks at %f m/s at %i-%i steps a minute", (speed, low, high) => {
    const steps = cadence(measured("walk", speed));
    expect(steps).toBeGreaterThanOrEqual(low);
    expect(steps).toBeLessThanOrEqual(high);
  });

  it.each([
    [2.01, 145, 160],
    [3.0, 150, 170],
    [4.5, 155, 180],
  ])("runs at %f m/s at %i-%i steps a minute", (speed, low, high) => {
    const steps = cadence(measured("run", speed));
    expect(steps).toBeGreaterThanOrEqual(low);
    expect(steps).toBeLessThanOrEqual(high);
  });

  it("steps faster with speed, and every strike reports a strength that grows with it", () => {
    const speeds: [("walk" | "run"), number][] = [["walk", 0.5], ["walk", 1.0], ["walk", 1.4], ["walk", 1.99], ["run", 2.01], ["run", 3.0], ["run", 4.5]];
    let lastCadence = 0;
    let lastStrength = 0;
    for (const [mode, speed] of speeds) {
      const record = measured(mode, speed);
      expect(cadence(record), `${mode} ${speed}`).toBeGreaterThan(lastCadence);
      expect(record.strengths.length).toBe(record.strikes);
      const strength = Math.max(...record.strengths);
      expect(strength, `${mode} ${speed}`).toBeGreaterThanOrEqual(lastStrength);
      expect(strength).toBeLessThanOrEqual(1);
      lastCadence = cadence(record);
      lastStrength = strength;
    }
  });
});

describe("the walker's planted feet", () => {
  it.each([
    ["walk", 0.5],
    ["walk", 1.4],
    ["walk", 1.99],
    ["run", 2.01],
    ["run", 3.0],
    ["run", 4.5],
  ] as const)("hold their place on flat ground: %s at %f m/s", (mode, speed) => {
    const record = measured(mode, speed);
    expect(record.slip).toBeLessThan(0.01);
    expect(record.slipUp).toBeLessThan(0.01);
  });

  it.each([20, 10, -10, -20])("hold their place and the ground on a %i degree slope at the walker's speed there", (degrees) => {
    const record = measured("walk", slopeSpeed(PERSON.walkSpeed, degrees), degrees);
    expect(record.slip).toBeLessThan(0.01);
    expect(record.slipUp).toBeLessThan(0.01);
    // Walking up or down, one foot is always on the ground.
    expect(record.flightFrames).toBe(0);
    expect(record.doubleSupportFrames).toBeGreaterThan(0);
  });

  it.each([20, 10])("hold their place running up a %i degree slope", (degrees) => {
    const record = measured("run", Math.max(PERSON.walkRunSpeed, slopeSpeed(PERSON.runSpeed, degrees)), degrees);
    expect(record.slip).toBeLessThan(0.01);
    expect(record.slipUp).toBeLessThan(0.01);
  });

  it("stand still on both feet", () => {
    const record = measured("stand", 0);
    expect(record.doubleSupportFrames).toBe(record.frames);
    expect(record.strikes).toBe(0);
    expect(record.slip).toBeLessThan(0.002);
  });
});

describe("the walk-run switch at 2.0 m/s", () => {
  it("walks with both feet down at the double-support instants and runs with both off in flight", () => {
    const walking = measured("walk", 1.99);
    const running = measured("run", 2.01);
    expect(walking.flightFrames).toBe(0);
    expect(walking.doubleSupportFrames / walking.frames).toBeGreaterThan(0.08);
    expect(running.doubleSupportFrames).toBe(0);
    expect(running.flightFrames / running.frames).toBeGreaterThan(0.1);
  });

  it("spends longer in flight the faster it runs", () => {
    const runs = [2.01, 3.0, 4.5].map((speed) => measured("run", speed).flightFrames);
    expect(runs[1]!).toBeGreaterThan(runs[0]!);
    expect(runs[2]!).toBeGreaterThan(runs[1]!);
  });
});

describe("the walker's knee and pelvis", () => {
  it("bends the knee about 60 degrees walking and further running", () => {
    const walking = measured("walk", 1.4);
    expect(walking.kneeMost).toBeGreaterThan(52);
    expect(walking.kneeMost).toBeLessThan(68);
    expect(walking.kneeLeast).toBeLessThan(10);
    const running = measured("run", 3.0);
    expect(running.kneeMost).toBeGreaterThan(75);
    expect(running.kneeMost).toBeLessThan(110);
  });

  it("swings the thigh further forward and back with speed", () => {
    const slow = measured("walk", 1.0);
    const fast = measured("walk", 1.8);
    expect(fast.thighMost).toBeGreaterThan(slow.thighMost);
    expect(fast.thighLeast).toBeLessThan(slow.thighLeast);
  });

  it("carries the pelvis up and down 3-7 cm walking, never below the legs' reach", () => {
    const walking = measured("walk", 1.4);
    const bob = walking.pelvisHigh - walking.pelvisLow;
    expect(bob).toBeGreaterThan(0.03);
    expect(bob).toBeLessThan(0.07);
    expect(walking.pelvisHigh).toBeLessThan(0.95);
  });

  it("lowers the body walking down a steep slope, as a walker does, and less on a gentle one", () => {
    const steep = measured("walk", slopeSpeed(PERSON.walkSpeed, -20), -20);
    const gentle = measured("walk", slopeSpeed(PERSON.walkSpeed, -10), -10);
    expect(steep.pelvisLow).toBeLessThan(gentle.pelvisLow);
    expect(steep.pelvisLow).toBeGreaterThan(0.75);
    expect(steep.kneeMost).toBeLessThan(100);
  });
});
