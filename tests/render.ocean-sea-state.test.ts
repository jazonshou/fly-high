import { describe, expect, it } from "vitest";
import { resolveProfileSpectralOceanConfig } from "../src/render/webgpu/water/SpectralOceanSystem";
import {
  oceanSpectrumSeed,
  resolveSeaSpectrumConfig,
  seaSpectrumWindSpeed,
  WEATHER_WIND_SCALE,
} from "../src/sim/water/seaState";
import { readSource } from "./support/sourceText";
import { createWorld } from "../src/world";

describe("D2: the sea follows the weather", () => {
  const world = createWorld("phase1-perf-baseline", { airport: false });

  it("blows the sea with the wind the sim flies through", () => {
    expect(WEATHER_WIND_SCALE).toEqual({ clear: 0.62, breezy: 1, cloudy: 1.28 });
    // Breezy, the game's default, is the world's own wind: its sea is unchanged.
    expect(seaSpectrumWindSpeed(world, "breezy")).toBe(world.prevailingWindSpeed);
    expect(seaSpectrumWindSpeed(world, "clear")).toBe(world.prevailingWindSpeed * 0.62);
    expect(seaSpectrumWindSpeed(world, "cloudy")).toBe(world.prevailingWindSpeed * 1.28);
  });

  it("gives the renderer and the sea twin one config for one world and weather", () => {
    for (const weather of ["clear", "breezy", "cloudy"] as const) {
      const rendered = resolveProfileSpectralOceanConfig(
        { oceanResolution: 256, oceanCascades: 5 },
        oceanSpectrumSeed(world),
        world.prevailingWindRadians,
        seaSpectrumWindSpeed(world, weather),
      );
      expect(resolveSeaSpectrumConfig(world, weather)).toEqual(rendered);
    }
  });

  it("builds the renderer's sea from the world and the weather, and rebuilds it on a preset change", () => {
    const renderer = readSource("src/render/FlightRenderer.ts");
    expect(renderer).toContain("oceanSpectrumSeed(options.world),");
    expect(renderer).toContain("seaSpectrumWindSpeed(options.world, options.weather ?? \"breezy\"),");
    expect(renderer).toContain(
      "this.ocean.setWindSpeed(seaSpectrumWindSpeed(this.worldDefinition, weather));",
    );
  });
});
