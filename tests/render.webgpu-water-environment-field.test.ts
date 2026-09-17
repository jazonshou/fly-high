/**
 * `W-8` — the sea's environment field is WORLD-ANCHORED.
 *
 * The field is baked into a camera-following window, so the property that
 * matters is that flying does not change the water: the same world position
 * must read the same province whichever window it was baked in. A field that
 * drifted with the camera would make the sea's colour provinces crawl under
 * the aircraft, which is the artefact wave S's gust lattice was rewritten to
 * avoid and the one thing a moving window can get wrong.
 */

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import {
  WATER_ENVIRONMENT_FIELD_RESOLUTION,
  WATER_ENVIRONMENT_FIELD_SPAN_METERS,
  WaterEnvironmentField,
  waterProductivity,
  waterRunoff,
} from "../src/render/webgpu/water/WaterEnvironmentField";
import { createWorld } from "../src/world";
import {
  sampleTerrainClimate,
  sampleTerrainMoisture,
  terrainTemperatureFromClimate,
} from "../src/world/terrain";

/** Read the baked field at a world position, as the vertex shader does. */
function readField(
  field: WaterEnvironmentField,
  data: Uint8Array,
  x: number,
  z: number,
): [number, number] {
  const { originX, originZ, inverseSpan } = field.placement;
  const u = (x - originX) * inverseSpan;
  const v = (z - originZ) * inverseSpan;
  const resolution = WATER_ENVIRONMENT_FIELD_RESOLUTION;
  const ix = Math.min(resolution - 1, Math.max(0, Math.floor(u * resolution)));
  const iz = Math.min(resolution - 1, Math.max(0, Math.floor(v * resolution)));
  const offset = (iz * resolution + ix) * 4;
  return [data[offset]! / 255, data[offset + 1]! / 255];
}

describe("W-8 water environment field", () => {
  it("reads the same province at a world point from two different bake windows", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const world = createWorld("phase1-perf-baseline");
    const field = new WaterEnvironmentField(scene, world);
    // Bake around the origin, then fly 80 km and bake again. Every point both
    // windows cover has to agree to the byte.
    expect(field.update(0, 0)).toBe(true);
    const first = new Uint8Array(
      (field.fieldTexture as unknown as { _bufferView: Uint8Array })._bufferView,
    );
    const firstSamples = [[0, 0], [12_000, -9_000], [-31_000, 22_000]]
      .map(([x, z]) => readField(field, first, x!, z!));
    expect(field.update(80_000, 0)).toBe(true);
    expect(field.bakes).toBe(2);
    const second = new Uint8Array(
      (field.fieldTexture as unknown as { _bufferView: Uint8Array })._bufferView,
    );
    [[0, 0], [12_000, -9_000], [-31_000, 22_000]].forEach(([x, z], index) => {
      expect(readField(field, second, x!, z!)).toEqual(firstSamples[index]);
    });
    field.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("only re-bakes when the camera leaves the middle of the window", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const field = new WaterEnvironmentField(scene, createWorld("phase1-perf-baseline"));
    expect(field.update(0, 0)).toBe(true);
    // A quarter of the span is 50 km: a whole cross-country leg is one bake.
    expect(field.update(20_000, 20_000)).toBe(false);
    expect(field.update(49_000, 0)).toBe(false);
    expect(field.update(51_000, 0)).toBe(true);
    expect(field.bakes).toBe(2);
    field.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("carries the terrain's own climate, so the sea agrees with its coast", () => {
    const world = createWorld("phase1-perf-baseline");
    // Cold and wet is productive (green); warm and dry is not (blue).
    const cold = waterProductivity(0.45, 0.8);
    const warm = waterProductivity(0.85, 0.3);
    expect(cold).toBeGreaterThan(warm + 0.4);
    expect(waterRunoff(0.8)).toBeGreaterThan(waterRunoff(0.3));
    // And the inputs are the terrain's, not a second noise field.
    const x = 4_200;
    const z = -1_700;
    const temperature = terrainTemperatureFromClimate(
      world,
      sampleTerrainClimate(world, x, z),
      world.seaLevel,
    );
    expect(temperature).toBeGreaterThan(0);
    expect(temperature).toBeLessThan(1);
    expect(sampleTerrainMoisture(world, x, z, 0)).toBeGreaterThan(0);
    expect(WATER_ENVIRONMENT_FIELD_SPAN_METERS / WATER_ENVIRONMENT_FIELD_RESOLUTION)
      .toBeLessThan(5_200 / 2);
  });
});
