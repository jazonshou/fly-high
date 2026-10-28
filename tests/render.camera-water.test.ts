import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  CAMERA_WATER_CARRY_METERS,
  CAMERA_WATER_TWIN_SECONDS,
  CameraWaterSampler,
  copyHydrologyWaterRegion,
  createCameraWaterSample,
  seaHeightSigma,
} from "../src/render/webgpu/underwater/cameraWater";
import { UnderwaterView } from "../src/render/webgpu/underwater/UnderwaterView";
import {
  createSeaSurfacePoint,
  createSeaTwin,
  createWaterSurfaceSample,
  packHydrologyWater,
  resolveSeaSpectrumConfig,
} from "../src/sim/water";
import { createWorld } from "../src/world";
import { homeMarina } from "../src/world/marina";

/**
 * The camera's water on the main thread (src/render/webgpu/underwater/cameraWater.ts):
 * which side of the drawn surface a camera is on and how far, from the sea
 * twin near the sea's surface and from the drawn lakes and rivers.
 */

const WORLD = createWorld("open-skies");
const SEA = WORLD.seaLevel;
/** Open sea 40 m deep everywhere. */
const DEEP = (): number => SEA - 40;
const ALL_CASCADES = 5;

function reference(weather: "clear" | "breezy" | "cloudy") {
  const twin = createSeaTwin(WORLD, weather);
  twin.setShelter([homeMarina(WORLD).shelter]);
  const out = createWaterSurfaceSample();
  return (x: number, z: number, time: number): number => {
    twin.setTime(time);
    return twin.sampleExact(x, z, out).height;
  };
}

describe("the sea twin's one-point path", () => {
  it("agrees with the exact sum as the point and the time move", () => {
    const twin = createSeaTwin(WORLD, "cloudy");
    twin.setShelter([homeMarina(WORLD).shelter]);
    const exact = reference("cloudy");
    const point = createSeaSurfacePoint();
    const focus = { x: 0, z: 0, heading: 0, halfLength: 1, halfBeam: 1 };
    let largest = 0;
    for (let frame = 0; frame < 600; frame += 1) {
      const time = 900 + frame / 60;
      const x = 2_400 + frame * 0.05 + 3 * Math.sin(frame * 0.02);
      const z = -1_800 + 4 * Math.cos(frame * 0.015);
      twin.setTime(time);
      focus.x = x;
      focus.z = z;
      twin.setFocus(focus);
      twin.surfacePointAt(x, z, point);
      if (frame % 30 === 0) largest = Math.max(largest, Math.abs(point.height - exact(x, z, time)));
    }
    expect(largest).toBeLessThan(0.02);
    // A jump of a kilometre converges in the same call.
    twin.setTime(1_000);
    focus.x = 3_400;
    focus.z = -800;
    twin.setFocus(focus);
    expect(twin.surfacePointAt(3_400, -800, point).height).toBeCloseTo(exact(3_400, -800, 1_000), 2);
  });

  it("gives the surface's slope and its rise over a still point", () => {
    const twin = createSeaTwin(WORLD, "breezy");
    const exactTwin = createSeaTwin(WORLD, "breezy");
    const sample = createWaterSurfaceSample();
    const point = createSeaSurfacePoint();
    const x = 1_250;
    const z = 640;
    const time = 700;
    twin.setTime(time);
    twin.setFocus({ x, z, heading: 0, halfLength: 1, halfBeam: 1 });
    twin.surfacePointAt(x, z, point);
    exactTwin.setTime(time);
    const normal = exactTwin.sampleExact(x, z, sample).normal;
    expect(point.slopeX).toBeCloseTo(-normal.x / normal.y, 2);
    expect(point.slopeZ).toBeCloseTo(-normal.z / normal.y, 2);
    exactTwin.setTime(time + 0.002);
    const later = exactTwin.sampleExact(x, z, sample).height;
    exactTwin.setTime(time - 0.002);
    const earlier = exactTwin.sampleExact(x, z, sample).height;
    expect(point.rate).toBeCloseTo((later - earlier) / 0.004, 1);
  });
});

describe("the camera's water", () => {
  it("puts a camera near the sea's surface on the side of the twin's surface", () => {
    const sampler = new CameraWaterSampler(WORLD, "cloudy", DEEP, ALL_CASCADES);
    const exact = reference("cloudy");
    const out = createCameraWaterSample();
    for (let step = 0; step < 24; step += 1) {
      const time = 640 + step * 2.3;
      const x = -2_300 + step * 37;
      const z = 4_100 - step * 11;
      const surface = exact(x, z, time);
      for (const offset of [-0.3, 0.3]) {
        sampler.sample(x, surface + offset, z, time, out);
        expect(out.kind).toBe("sea");
        expect(out.submerged).toBe(offset < 0);
        expect(out.depth).toBeCloseTo(-offset, 1);
        expect(out.stillDepth).toBeCloseTo(SEA - surface - offset, 6);
        expect(out.waterDepth).toBeCloseTo(40, 6);
        expect(Math.abs(out.surfaceHeight - surface)).toBeLessThan(0.02);
      }
    }
    expect(out.clearance).toBeGreaterThan(0.25);
    expect(out.clearance).toBeLessThan(0.4);
  });

  it("asks no twin while the camera is beyond the waves' reach, and builds none", () => {
    const sampler = new CameraWaterSampler(WORLD, "cloudy", DEEP, ALL_CASCADES);
    const out = createCameraWaterSample();
    const reach = 6 * seaHeightSigma(resolveSeaSpectrumConfig(WORLD, "cloudy")) + 0.3;
    for (const height of [SEA - reach - 0.5, SEA - 12, SEA + reach + 0.5, SEA + 300]) {
      sampler.sample(500, height, 500, 800, out);
      expect(out.kind).toBe("sea");
      expect(out.surfaceHeight).toBe(SEA);
      expect(out.submerged).toBe(height < SEA);
    }
    expect(sampler.evaluations).toBe(0);
    expect(sampler.built).toBe(false);
  });

  it("carries a nearby point along the slope, and steps the twin only every few frames", () => {
    const sampler = new CameraWaterSampler(WORLD, "breezy", DEEP, ALL_CASCADES);
    const exact = reference("breezy");
    const out = createCameraWaterSample();
    sampler.build();
    let largest = 0;
    const frames = 240;
    for (let frame = 0; frame < frames; frame += 1) {
      const time = 1_100 + frame / 60;
      // A swimming camera: 1.2 m/s.
      const x = 300 + frame * 0.02;
      const z = 900;
      sampler.sample(x, SEA - 0.5, z, time, out);
      largest = Math.max(largest, Math.abs(out.surfaceHeight - exact(x, z, time)));
    }
    expect(largest).toBeLessThan(0.02);
    // A fresh evaluation each CAMERA_WATER_TWIN_SECONDS (or carry distance), not each frame.
    const expected = Math.ceil(frames / 60 / CAMERA_WATER_TWIN_SECONDS);
    expect(sampler.evaluations).toBeLessThanOrEqual(expected + 1);
    expect(CAMERA_WATER_CARRY_METERS).toBeGreaterThan(0.02 * 60 * CAMERA_WATER_TWIN_SECONDS);
  });

  it("takes off the swell a tier does not draw", () => {
    const drawn = resolveWebGpuQualityProfile("low", "balanced").oceanCascades;
    const low = new CameraWaterSampler(WORLD, "cloudy", DEEP, drawn);
    const full = new CameraWaterSampler(WORLD, "cloudy", DEEP, ALL_CASCADES);
    const heave = createSeaTwin(WORLD, "cloudy");
    heave.setShelter([homeMarina(WORLD).shelter]);
    const lowOut = createCameraWaterSample();
    const fullOut = createCameraWaterSample();
    let largest = 0;
    for (let step = 0; step < 12; step += 1) {
      const time = 600 + step * 3.1;
      const x = 1_500 + step * 21;
      const z = -2_900;
      low.sample(x, SEA, z, time, lowOut);
      full.sample(x, SEA, z, time, fullOut);
      heave.setTime(time);
      heave.setFocus({ x, z, heading: 0, halfLength: 1, halfBeam: 1 });
      const undrawn = heave.undrawnHeave(drawn);
      expect(fullOut.surfaceHeight - lowOut.surfaceHeight).toBeCloseTo(undrawn, 3);
      largest = Math.max(largest, Math.abs(undrawn));
    }
    expect(largest).toBeGreaterThan(0.05);
  });

  it("is dry where the ground stands at or above the still sea", () => {
    const sampler = new CameraWaterSampler(WORLD, "clear", () => SEA + 3, ALL_CASCADES);
    const out = sampler.sample(0, SEA + 1, 0, 600, createCameraWaterSample());
    expect(out.kind).toBe("none");
    expect(out.submerged).toBe(false);
    expect(out.surfaceHeight).toBe(SEA + 3);
    // Even a camera below the ground there (a clamp's business, not the water's).
    expect(sampler.sample(0, SEA - 1, 0, 600, out).submerged).toBe(false);
    expect(sampler.evaluations).toBe(0);
  });

  it("finds a drawn lake, and leaves the copied region to the caller", () => {
    const level = SEA + 120;
    const bed = (): number => level - 6;
    const sampler = new CameraWaterSampler(WORLD, "clear", bed, ALL_CASCADES);
    const region = packHydrologyWater([], [{
      surfaceHeight: level,
      boundary: [{ x: -100, z: -100 }, { x: 100, z: -100 }, { x: 100, z: 100 }, { x: -100, z: 100 }],
    }]);
    const copy = copyHydrologyWaterRegion(region);
    expect(copy.lakeBoundary).not.toBe(region.lakeBoundary);
    expect(Array.from(copy.lakeBoundary)).toEqual(Array.from(region.lakeBoundary));
    sampler.setHydrologyRegion("r0", copy);
    const out = createCameraWaterSample();
    sampler.sample(10, level - 2, -20, 600, out);
    expect(out.kind).toBe("lake");
    expect(out.submerged).toBe(true);
    expect(out.depth).toBeCloseTo(2, 6);
    expect(out.stillDepth).toBeCloseTo(2, 6);
    expect(out.waterDepth).toBeCloseTo(6, 6);
    expect(sampler.sample(10, level + 0.5, -20, 600, out).submerged).toBe(false);
    // Outside the lake: dry.
    expect(sampler.sample(300, level - 2, 0, 600, out).kind).toBe("none");
    // A region the renderer is done with goes once the camera is a kilometre
    // off it, as the worker's does for the walker.
    sampler.evictHydrologyRegion("r0");
    expect(sampler.inlandRegionCount).toBe(1);
    sampler.sample(5_000, level, 0, 600, out);
    expect(sampler.inlandRegionCount).toBe(0);
    expect(sampler.sample(10, level - 2, -20, 600, out).kind).toBe("none");
  });

  it("follows the weather", () => {
    const sampler = new CameraWaterSampler(WORLD, "clear", DEEP, ALL_CASCADES);
    const out = createCameraWaterSample();
    const clear = sampler.sample(800, SEA, 800, 650, out).surfaceHeight;
    const clearance = out.clearance;
    sampler.setWeather("cloudy");
    const cloudy = sampler.sample(800, SEA, 800, 650, out).surfaceHeight;
    expect(cloudy).not.toBeCloseTo(clear, 3);
    expect(cloudy).toBeCloseTo(reference("cloudy")(800, 800, 650), 1);
    expect(out.clearance).toBeGreaterThan(clearance);
  });

  it("hears the drawn lakes before the worker, which keeps the buffers it is sent", () => {
    const level = SEA + 80;
    const view = new UnderwaterView({ world: WORLD, weather: "clear", terrainHeight: () => level - 4, drawnCascades: 5 });
    const sent: { key: string; region: unknown }[] = [];
    const evicted: string[] = [];
    const publisher = view.hydrologyPublisher({
      publishHydrology: (key, region) => sent.push({ key, region }),
      evictHydrology: (key) => evicted.push(key),
    });
    const region = packHydrologyWater([], [{
      surfaceHeight: level,
      boundary: [{ x: -50, z: -50 }, { x: 50, z: -50 }, { x: 50, z: 50 }, { x: -50, z: 50 }],
    }]);
    publisher.publishHydrology("a", region);
    expect(sent).toEqual([{ key: "a", region }]);
    // The worker's transfer detaches the region's buffers; the camera keeps its own copy.
    structuredClone(region, { transfer: [region.lakeBoundary.buffer, region.lakeLevels.buffer] });
    view.update(0, level - 1, 0, 600);
    expect(view.submerged).toBe(true);
    expect(view.camera.kind).toBe("lake");
    publisher.evictHydrology("a");
    expect(evicted).toEqual(["a"]);
  });
});
