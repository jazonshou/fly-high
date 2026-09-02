import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bakeMultipleScatteringLut,
  bakeTransmittanceLut,
  evaluateTransmittance,
  sampleLut,
  transmittanceLutUv,
} from "../src/render/webgpu/atmosphere/AtmosphereLuts";
import {
  BASE_EXPOSURE,
  REFERENCE_EV100,
  exposureForState,
  MAX_EXPOSURE,
  resolveEnvironmentState,
} from "../src/render/webgpu/nature/EnvironmentDirector";
import { DEFAULT_ENVIRONMENT_STATE } from "../src/render/webgpu/nature/EnvironmentState";
import { readSource } from "./support/sourceText";

/**
 * 1C-3 — the transmittance/multiple-scattering model and its LUT bake, and
 * 1C-2's assertion 29: no shader source under src/ multiplies its own
 * exposure again.
 */

const ATMOSPHERE = DEFAULT_ENVIRONMENT_STATE.atmosphere;

describe("atmosphere transmittance (1C-3)", () => {
  it("agrees with a 10× step reference within 1%", () => {
    for (const [altitude, cosZenith] of [
      [0, 1],
      [0, 0.35],
      [0, 0.05],
      [1_500, 0.6],
      [10_000, 0.15],
      [30_000, 0.9],
    ] as const) {
      const lutStep = evaluateTransmittance(ATMOSPHERE, altitude, cosZenith, 40);
      const reference = evaluateTransmittance(ATMOSPHERE, altitude, cosZenith, 400);
      for (let channel = 0; channel < 3; channel += 1) {
        expect(
          Math.abs(lutStep[channel]! - reference[channel]!),
          `altitude ${altitude} mu ${cosZenith} channel ${channel}`,
        ).toBeLessThan(0.01);
      }
    }
  });

  it("behaves physically: more air, less light, blue first", () => {
    const zenith = evaluateTransmittance(ATMOSPHERE, 0, 1);
    const slanted = evaluateTransmittance(ATMOSPHERE, 0, 0.2);
    const grazing = evaluateTransmittance(ATMOSPHERE, 0, 0.02);
    for (let channel = 0; channel < 3; channel += 1) {
      expect(zenith[channel]!).toBeGreaterThan(slanted[channel]!);
      expect(slanted[channel]!).toBeGreaterThan(grazing[channel]!);
      expect(zenith[channel]!).toBeGreaterThan(0.5);
      expect(zenith[channel]!).toBeLessThanOrEqual(1);
    }
    // Rayleigh: blue extinguishes faster than red — the sunset machinery.
    expect(grazing[0]!).toBeGreaterThan(grazing[2]! * 3);
    // Near space: nothing left to absorb.
    const high = evaluateTransmittance(ATMOSPHERE, 95_000, 0.4);
    expect(high[1]!).toBeGreaterThan(0.995);
  });

  it("samples the baked LUT within 1% of direct evaluation", () => {
    const lut = bakeTransmittanceLut(ATMOSPHERE);
    for (const [altitude, cosZenith] of [
      [0, 0.82],
      [120, 0.31],
      [4_000, 0.09],
      [12_000, 0.55],
    ] as const) {
      const { u, v } = transmittanceLutUv(ATMOSPHERE, altitude, cosZenith);
      const sampled = sampleLut(lut, u, v);
      const direct = evaluateTransmittance(ATMOSPHERE, altitude, cosZenith);
      for (let channel = 0; channel < 3; channel += 1) {
        expect(Math.abs(sampled[channel]! - direct[channel]!)).toBeLessThan(0.01);
      }
    }
  });

  it("bakes a finite, positive multiple-scattering ambient", () => {
    const transmittance = bakeTransmittanceLut(ATMOSPHERE);
    const multiple = bakeMultipleScatteringLut(ATMOSPHERE, transmittance);
    expect(multiple.width).toBe(32);
    let positive = 0;
    for (let index = 0; index < multiple.data.length; index += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        const value = multiple.data[index + channel]!;
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        if (value > 0) positive += 1;
      }
    }
    expect(positive).toBeGreaterThan(multiple.data.length / 8);
  });
});

describe("single exposure (1C-2)", () => {
  it("preserves the day+clear look exactly at the reference key", () => {
    const day = resolveEnvironmentState({
      clock: { dayOfYear: 171, solarTimeHours: 12.5 },
      latitudeDegrees: 45,
      weather: "clear",
    });
    // The reference anchors at the old preset's sun height; midsummer noon
    // at 45°N sits within a few percent of it — and the curve's weak
    // adaptation keeps the whole neighbourhood within a couple percent of
    // the 1.08 base.
    expect(exposureForState(day)).toBeGreaterThan(BASE_EXPOSURE * 0.97);
    expect(exposureForState(day)).toBeLessThan(BASE_EXPOSURE * 1.03);
    expect(Number.isFinite(REFERENCE_EV100)).toBe(true);
  });

  it("opens up at dawn and clamps into the twilight floor", () => {
    const dawn = resolveEnvironmentState({
      clock: { dayOfYear: 171, solarTimeHours: 5.5 },
      latitudeDegrees: 45,
      weather: "clear",
    });
    const night = resolveEnvironmentState({
      clock: { dayOfYear: 171, solarTimeHours: 0 },
      latitudeDegrees: 45,
      weather: "clear",
    });
    const day = resolveEnvironmentState({
      clock: { dayOfYear: 171, solarTimeHours: 12.5 },
      latitudeDegrees: 45,
      weather: "clear",
    });
    expect(exposureForState(dawn)).toBeGreaterThan(exposureForState(day));
    expect(exposureForState(night)).toBeGreaterThanOrEqual(exposureForState(dawn));
    // 7-2 reopened the ceiling the realignment named as "a magic number with
    // no stated night rationale". It is derived now: the curve keeps opening
    // down to the illuminance at which human vision hands over to the rods
    // and stops there, because past that point ScotopicVision's
    // Naka-Rushton response is what a person's night vision does. Both the
    // value and the fact that it BINDS at midnight are pinned, so neither
    // the curve nor the scotopic threshold can move silently.
    expect(exposureForState(night)).toBeLessThanOrEqual(MAX_EXPOSURE);
    expect(MAX_EXPOSURE).toBeCloseTo(4.698, 2);
    expect(exposureForState(night)).toBeCloseTo(MAX_EXPOSURE, 6);
    expect(MAX_EXPOSURE).toBeGreaterThan(2.6);
  });
});

describe("no private exposure multiplies (1C-2, assertion 29)", () => {
  it("keeps `uniforms.exposure` and `uniform exposure` out of src/ shader code", () => {
    const root = join(__dirname, "..", "src");
    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        const content = readSource(path);
        if (/uniforms\.exposure|uniform exposure\b|\* exposure;/.test(content)) {
          offenders.push(path);
        }
      }
    };
    walk(root);
    expect(offenders, "one exposure curve — the image-processing chain's").toEqual([]);
  });
});
