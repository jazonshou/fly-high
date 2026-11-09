import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import type { AtmosphereSnapshot } from "../src/render/webgpu/atmosphere/AtmosphereSystem";
import {
  UNDERWATER_ADAPTATION_MAX_GAIN,
  UnderwaterAdaptation,
  underwaterAdaptationTarget,
  UnderwaterLight,
} from "../src/render/webgpu/underwater/underwaterLight";
import {
  OCEAN_COASTAL_CHLOROPHYLL,
  OCEAN_OPEN_CHLOROPHYLL,
  oceanConstituents,
} from "../src/render/webgpu/water/WaterConstituents";
import {
  createWaterEnvironmentSample,
  WATER_ENVIRONMENT_FIELD_RESOLUTION,
  WATER_ENVIRONMENT_FIELD_SPAN_METERS,
  WaterEnvironmentField,
  type WaterEnvironmentSample,
} from "../src/render/webgpu/water/WaterEnvironmentField";
import { createWorld } from "../src/world";

/**
 * The light under the water (`UnderwaterLight`): the camera's water type from
 * the same chemistry the surface is coloured by, and the attenuation and
 * in-water light the water-column pass fades with. The numbers are held to
 * the published ranges for the water types the chemistry is calibrated on.
 */

const WORLD = createWorld("open-skies");

function atmosphere(sunElevationDegrees: number, sunIlluminance = 1): AtmosphereSnapshot {
  const elevation = (sunElevationDegrees * Math.PI) / 180;
  return {
    sunDirection: new Vector3(Math.cos(elevation), Math.sin(elevation), 0),
    sunColor: new Color3(1, 0.96, 0.9),
    sunIntensity: 5.2,
    skyZenith: new Color3(0.2, 0.35, 0.7),
    skyHorizon: new Color3(0.5, 0.6, 0.75),
    ambientColor: new Color3(0.3, 0.35, 0.4),
    skylightIlluminanceNormalized: 0.6,
    sunIlluminanceNormalized: sunIlluminance,
    sunAngularRadiusRadians: 0.0047,
    cloudCoverage: 0.2,
    humidity: 0.5,
    windSpeed: 5,
    windDirection: new Vector2(1, 0),
    moonDirection: new Vector3(0, -1, 0),
    moonIlluminanceLux: 0,
    moonIlluminatedFraction: 0,
    adaptedLuminanceCdM2: 1_000,
    sceneKeyLuminanceCdM2: 1_000,
  } as AtmosphereSnapshot;
}

function sea(waterDepth: number, x = 0, z = 0) {
  return { kind: "sea" as const, x, z, stillHeight: WORLD.seaLevel, waterDepth };
}

/** An environment field that reads one province everywhere. */
function province(productivity: number, runoff: number): WaterEnvironmentField {
  return {
    sample(_x: number, _z: number, out: WaterEnvironmentSample): WaterEnvironmentSample {
      out.productivity = productivity;
      out.runoff = runoff;
      return out;
    },
  } as unknown as WaterEnvironmentField;
}

/** Metres a diver sees in green (`4.8 / c`, the contrast-threshold rule). */
function visibility(light: UnderwaterLight): number {
  return 4.8 / light.attenuation[1]!;
}

describe("the sea's chemistry on the CPU", () => {
  it("is open-ocean water off the shelf and the coast's in the shallows", () => {
    const open = oceanConstituents(400, 0.5, 0.5);
    const shelf = oceanConstituents(4, 0.5, 0.5);
    // Mid-province is the contrast curve's identity point: 0.22 + 2.6 / 4.
    expect(open.chlorophyll).toBeCloseTo(OCEAN_OPEN_CHLOROPHYLL * 0.87, 6);
    expect(open.sediment).toBe(0);
    expect(shelf.chlorophyll).toBeGreaterThan(OCEAN_COASTAL_CHLOROPHYLL * 0.8);
    expect(shelf.sediment).toBeGreaterThan(4);
    // A wetter coast sheds more into its sea.
    expect(oceanConstituents(10, 0.5, 0.8).sediment).toBeGreaterThan(oceanConstituents(10, 0.5, 0.2).sediment);
  });
});

describe("the environment field on the CPU", () => {
  it("reads as the shaders do: the texel at its centre, a blend between", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const field = new WaterEnvironmentField(scene, WORLD);
    const out = createWaterEnvironmentSample();
    // Before the first bake, the fallback's temperate province.
    field.sample(0, 0, out);
    expect(out.productivity).toBeCloseTo(Math.round(0.35 * 255) / 255, 6);
    expect(out.runoff).toBeCloseTo(Math.round(0.5 * 255) / 255, 6);
    field.update(0, 0);
    const data = (field.fieldTexture as unknown as { _texture: { _bufferView: Uint8Array } })._texture._bufferView;
    const { originX, originZ } = field.placement;
    const texel = WATER_ENVIRONMENT_FIELD_SPAN_METERS / WATER_ENVIRONMENT_FIELD_RESOLUTION;
    const ix = 40;
    const iz = 53;
    const offset = (iz * WATER_ENVIRONMENT_FIELD_RESOLUTION + ix) * 4;
    field.sample(originX + (ix + 0.5) * texel, originZ + (iz + 0.5) * texel, out);
    expect(out.productivity).toBeCloseTo(data[offset]! / 255, 9);
    expect(out.runoff).toBeCloseTo(data[offset + 1]! / 255, 9);
    expect(out.carbonate).toBeCloseTo(data[offset + 2]! / 255, 9);
    // Halfway to the next texel in x: the mean of the two.
    field.sample(originX + (ix + 1) * texel, originZ + (iz + 0.5) * texel, out);
    expect(out.productivity).toBeCloseTo((data[offset]! + data[offset + 4]!) / 2 / 255, 9);
    field.dispose();
    scene.dispose();
    engine.dispose();
  });
});

describe("the light under the water", () => {
  it("fades clear open sea over tens of metres in blue and a few in red", () => {
    const light = new UnderwaterLight(WORLD, null);
    light.setAtmosphere(atmosphere(60));
    light.setWater(sea(400));
    const [red, green, blue] = light.attenuation;
    // Pure water's own absorption sets the red; blue clear-ocean beam
    // attenuation is 0.02-0.04 per metre (Smith and Baker; Jerlov type I).
    expect(red).toBeGreaterThan(0.27);
    expect(green).toBeGreaterThan(0.05);
    expect(green).toBeLessThan(0.08);
    expect(blue).toBeGreaterThan(0.02);
    expect(blue).toBeLessThan(0.04);
    // Light from above: Jerlov type I diffuse attenuation, 0.02-0.035 in blue.
    expect(light.skyDiffuseAttenuation[2]).toBeGreaterThan(0.015);
    expect(light.skyDiffuseAttenuation[2]).toBeLessThan(0.035);
    // The sea's own light is blue.
    expect(light.sunUpwelling[2]).toBeGreaterThan(light.sunUpwelling[1]);
    expect(light.sunUpwelling[1]).toBeGreaterThan(light.sunUpwelling[0]);
  });

  it("closes in over a silty shelf", () => {
    const light = new UnderwaterLight(WORLD, null);
    light.setAtmosphere(atmosphere(60));
    light.setWater(sea(400));
    const open = [...light.attenuation];
    light.setWater(sea(5));
    for (let channel = 0; channel < 3; channel += 1) {
      expect(light.attenuation[channel]!).toBeGreaterThan(open[channel]! + 0.3);
    }
  });

  it("follows the sun: dimmer and from a lower angle at evening", () => {
    const light = new UnderwaterLight(WORLD, null);
    light.setWater(sea(400));
    light.setAtmosphere(atmosphere(70));
    const noon = { upwelling: light.sunUpwelling[2]!, diffuse: light.sunDiffuseAttenuation[2]!, direct: light.directFraction };
    light.setAtmosphere(atmosphere(8, 0.4));
    expect(light.sunUpwelling[2]!).toBeLessThan(noon.upwelling * 0.2);
    // A low sun's refracted beam is slanted, so it dies faster with depth.
    expect(light.sunDiffuseAttenuation[2]!).toBeGreaterThan(noon.diffuse * 1.2);
    expect(light.directFraction).toBeLessThan(noon.direct);
    light.setAtmosphere(atmosphere(-5));
    expect(light.sunUpwelling).toEqual([0, 0, 0]);
    expect(light.directFraction).toBe(0);
  });

  it("resolves the camera's water again only once it has moved far enough to change", () => {
    const light = new UnderwaterLight(WORLD, null);
    light.setWater(sea(30));
    const resolves = light.waterResolves;
    light.setWater(sea(30.1, 2, 2));
    expect(light.waterResolves).toBe(resolves);
    light.setWater(sea(31));
    expect(light.waterResolves).toBe(resolves + 1);
    light.setWater({ kind: "none", x: 0, z: 0, stillHeight: 0, waterDepth: 0 });
    expect(light.waterResolves).toBe(resolves + 1);
  });

  it("is clearer under the water than the sea reads from above, but keeps each coast's order", () => {
    // The camera spots of the before/after shots: the home shelf, the marina
    // basin, a tropical shelf and the open sea off the coast.
    const sites = [
      { name: "home shelf", depth: 12.9, productivity: 0.48, runoff: 0.5, low: 8, high: 9.5 },
      { name: "marina basin", depth: 3, productivity: 0.48, runoff: 0.5, low: 2.5, high: 3.2 },
      { name: "tropical shelf", depth: 12.9, productivity: 0.01, runoff: 0.11, low: 18.5, high: 21 },
      { name: "offshore", depth: 90.8, productivity: 0.32, runoff: 0.45, low: 28, high: 60 },
    ];
    const seen: number[] = [];
    for (const site of sites) {
      const light = new UnderwaterLight(WORLD, province(site.productivity, site.runoff));
      light.setWater(sea(site.depth));
      const metres = visibility(light);
      expect(metres, site.name).toBeGreaterThan(site.low);
      expect(metres, site.name).toBeLessThan(site.high);
      seen.push(metres);
    }
    expect(seen[1]!).toBeLessThan(seen[0]!);
    expect(seen[0]!).toBeLessThan(seen[2]!);
    expect(seen[2]!).toBeLessThan(seen[3]!);
  });

  it("leaves a lake its dissolved colour: a peaty lake stays brown under the water", () => {
    const light = new UnderwaterLight(WORLD, null);
    light.setWater({ kind: "lake", x: 3_000, z: -2_000, stillHeight: WORLD.seaLevel + 300, waterDepth: 6 });
    // CDOM absorbs blue hardest; the particles' share is not cut from it.
    expect(light.absorption[2]!).toBeGreaterThan(light.absorption[1]!);
  });

  it("dims the light from above with depth, by the water's own diffuse attenuation", () => {
    const light = new UnderwaterLight(WORLD, province(0.48, 0.5));
    light.setAtmosphere(atmosphere(60));
    light.setWater(sea(21));
    expect(light.lightRemaining(0)).toBeCloseTo(1, 9);
    expect(light.lightRemaining(-2)).toBeCloseTo(1, 9);
    let previous = 1;
    for (const depth of [1, 3, 8, 20]) {
      const remaining = light.lightRemaining(depth);
      expect(remaining).toBeLessThan(previous);
      previous = remaining;
    }
    // Green carries most of the luminance: past a few metres the light
    // left follows green's diffuse attenuation.
    const green = light.skyDiffuseAttenuation[1]!;
    expect(light.lightRemaining(20) / light.lightRemaining(19)).toBeGreaterThan(Math.exp(-green * 1.3));
    expect(light.lightRemaining(20) / light.lightRemaining(19)).toBeLessThan(Math.exp(-green * 0.8));
    // No light from above at all: nothing to lose, so nothing for the eye to follow.
    const dark = new UnderwaterLight(WORLD, null);
    expect(dark.lightRemaining(10)).toBe(1);
  });

  it("adapts the eye to the light at its depth, within a second or two", () => {
    expect(underwaterAdaptationTarget(1)).toBe(1);
    expect(underwaterAdaptationTarget(0.25)).toBeCloseTo(4, 9);
    expect(underwaterAdaptationTarget(0.001)).toBe(UNDERWATER_ADAPTATION_MAX_GAIN);
    expect(underwaterAdaptationTarget(0)).toBe(UNDERWATER_ADAPTATION_MAX_GAIN);
    const eye = new UnderwaterAdaptation();
    expect(eye.gain).toBe(1);
    const target = 8;
    let seconds = 0;
    while (seconds < 0.25 - 1e-9) {
      eye.update(target, 1 / 60);
      seconds += 1 / 60;
    }
    // Not a cut: a quarter of a second in, the eye is less than halfway there.
    expect(Math.log(eye.gain)).toBeLessThan(Math.log(target) / 2);
    while (seconds < 2 - 1e-9) {
      eye.update(target, 1 / 60);
      seconds += 1 / 60;
    }
    expect(Math.abs(eye.gain / target - 1)).toBeLessThan(0.05);
    // The frame rate does not change where it settles or how fast.
    const coarse = new UnderwaterAdaptation();
    for (let frame = 0; frame < 40; frame += 1) coarse.update(target, 1 / 20);
    expect(coarse.gain).toBeCloseTo(eye.gain, 6);
    // A frame with no time in it moves nothing; back above the water, the surface's eye.
    const held = eye.gain;
    eye.update(1, 0);
    expect(eye.gain).toBe(held);
    eye.reset();
    expect(eye.gain).toBe(1);
  });

  it("takes a lake's own chemistry, not the sea's", () => {
    const light = new UnderwaterLight(WORLD, null);
    light.setWater(sea(6));
    const seaAbsorption = [...light.absorption];
    light.setWater({ kind: "lake", x: 3_000, z: -2_000, stillHeight: WORLD.seaLevel + 300, waterDepth: 6 });
    expect(light.absorption).not.toEqual(seaAbsorption);
    // Inland water carries more dissolved organic matter: it absorbs blue harder.
    expect(light.absorption[2]!).toBeGreaterThan(light.absorption[1]! * 0.5);
  });
});
