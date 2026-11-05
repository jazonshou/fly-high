import { describe, expect, it, vi } from "vitest";
import { CALM_DRY_MARGIN, CalmWaterSurface } from "../src/sim/water/calmWater";
import { MOUTH_HIGH, WaterSurfaceComposite } from "../src/sim/water/compositeWater";
import {
  HYDROLOGY_EVICTION_KEEP_METERS,
  HydrologyWaterSource,
  packHydrologyWater,
  type HydrologyWaterLake,
  type HydrologyWaterRiver,
} from "../src/sim/water/hydrologyWater";
import {
  createWaterSurfaceSample,
  type HullWaterSampler,
  type WaterSurfaceSample,
  type WaveFieldFocus,
} from "../src/sim/water/types";

/**
 * Lakes and rivers as water the sim stands in (land plan; the boats lead's
 * conditions for the one water authority): the river ribbon and the lake
 * ring as drawn, the bed deciding where either holds water, streaming by
 * region, and the composite's estuary rule with a continuous river mouth.
 */

const sample = createWaterSurfaceSample();

/** A straight river down +z from z = 0 to 300: stations every 30 m, falling 1 cm a metre, 12 m wide, 1.5 m/s. */
function straightRiver(): HydrologyWaterRiver {
  const points = [];
  for (let z = 0; z <= 300; z += 30) {
    points.push({ x: 0, y: 10 - 0.01 * z, z, widthMeters: 12, flowSpeedMetersPerSecond: 1.5 });
  }
  return { points };
}

/** The bed 0.16 m under the river's surface in its channel, rising away from it. */
function channelBed(x: number, z: number): number {
  return 10 - 0.01 * z - 0.16 + 0.05 * Math.max(0, Math.abs(x) - 4);
}

/** A round lake of `radius` about (cx, cz) at `level`: 32 boundary points, as the generator rings them. */
function roundLake(cx: number, cz: number, radius: number, level: number): HydrologyWaterLake {
  const boundary = [];
  for (let i = 0; i < 32; i += 1) {
    const angle = (i / 32) * 2 * Math.PI;
    boundary.push({ x: cx + radius * Math.cos(angle), z: cz + radius * Math.sin(angle) });
  }
  return { surfaceHeight: level, boundary };
}

describe("hydrology water: rivers", () => {
  const source = new HydrologyWaterSource(channelBed);
  source.setRegion("r", packHydrologyWater([straightRiver()], []));

  it("is the drawn ribbon: the stations' surface along the river, out to its half width, with the current along it", () => {
    expect(source.sampleWet(1, 45, sample)).toBe(true);
    expect(sample.kind).toBe("river");
    expect(sample.height).toBeCloseTo(10 - 0.45, 9);
    expect(sample.stillHeight).toBe(sample.height);
    expect(sample.depth).toBeCloseTo(0.16, 9);
    // 1.5 m/s down the river (+z), falling 1 cm a metre.
    expect(Math.hypot(sample.velocity.x, sample.velocity.y, sample.velocity.z)).toBeCloseTo(1.5, 9);
    expect(sample.velocity.x).toBeCloseTo(0, 12);
    expect(sample.velocity.z).toBeGreaterThan(1.49);
    expect(sample.velocity.y / sample.velocity.z).toBeCloseTo(-0.01, 9);
    // The normal leans downstream by the fall.
    expect(sample.normal.z / sample.normal.y).toBeCloseTo(0.01, 9);
    expect(Math.hypot(sample.normal.x, sample.normal.y, sample.normal.z)).toBeCloseTo(1, 12);
    // Half width 6 m (the bed rises 5 cm a metre past 4 m, still under the surface at 5.9 m).
    expect(source.sampleWet(5.9, 45, sample)).toBe(true);
    expect(source.sampleWet(6.1, 45, sample)).toBe(false);
  });

  it("is cut square at its two ends, as the ribbon is", () => {
    expect(source.sampleWet(0, 0.5, sample)).toBe(true);
    expect(source.sampleWet(0, -0.5, sample)).toBe(false);
    expect(source.sampleWet(0, 299.5, sample)).toBe(true);
    expect(source.sampleWet(0, 300.5, sample)).toBe(false);
  });

  it("joins round at a bend, and holds water only where the bed is under its surface", () => {
    const bend = new HydrologyWaterSource(() => 0);
    // East along z = 0, then a right angle north up x = 100.
    bend.setRegion("bend", packHydrologyWater([{
      points: [
        { x: 0, y: 1, z: 0, widthMeters: 10, flowSpeedMetersPerSecond: 1 },
        { x: 100, y: 1, z: 0, widthMeters: 10, flowSpeedMetersPerSecond: 1 },
        { x: 100, y: 1, z: 100, widthMeters: 10, flowSpeedMetersPerSecond: 1 },
      ],
    }], []));
    // Outside the corner, past both segments' ends but within the half width of the joint.
    expect(bend.sampleWet(103, -3, sample)).toBe(true);
    expect(bend.sampleWet(104, -4, sample)).toBe(false);
    // A bank inside the ribbon over its surface is dry.
    const banked = new HydrologyWaterSource((x) => (x > 2 ? 10.2 : 9));
    banked.setRegion("r", packHydrologyWater([straightRiver()], []));
    expect(banked.sampleWet(1, 15, sample)).toBe(true);
    expect(banked.sampleWet(3, 15, sample)).toBe(false);
  });
});

describe("hydrology water: lakes", () => {
  it("is still water at its level inside its ring, over a bed below it", () => {
    // A bowl 12 m deep under a lake at 50 m, with an island rising through it 30 m east of the centre.
    const bed = (x: number, z: number): number => {
      const r = Math.hypot(x - 1_000, z - 2_000);
      const island = 14 - 0.5 * Math.hypot(x - 1_030, z - 2_000);
      return Math.max(38 + 0.12 * r, 38 + island);
    };
    const source = new HydrologyWaterSource(bed);
    source.setRegion("lakes", packHydrologyWater([], [roundLake(1_000, 2_000, 100, 50)]));
    expect(source.sampleWet(1_000, 2_000 - 40, sample)).toBe(true);
    expect(sample.kind).toBe("lake");
    expect(sample.height).toBe(50);
    expect(sample.depth).toBeCloseTo(50 - bed(1_000, 1_960), 9);
    expect(sample.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(sample.normal).toEqual({ x: 0, y: 1, z: 0 });
    // The island's top is dry; outside the ring is none.
    expect(source.sampleWet(1_030, 2_000, sample)).toBe(false);
    expect(source.sampleWet(1_000, 2_000 + 101, sample)).toBe(false);
    // On its own the source answers "none" there, with the bed as the height, as the calm sea does on land.
    expect(source.sample(1_000, 2_101, sample).kind).toBe("none");
    expect(sample.height).toBe(bed(1_000, 2_101));
    expect(sample.depth).toBe(0);
  });

  it("answers the higher surface where two regions overlap", () => {
    const source = new HydrologyWaterSource(() => 0);
    source.setRegion("a", packHydrologyWater([], [roundLake(0, 0, 200, 5)]));
    source.setRegion("b", packHydrologyWater([], [roundLake(0, 0, 200, 5), roundLake(100, 0, 50, 7)]));
    expect(source.sampleWet(0, 0, sample) && sample.height).toBe(5);
    expect(source.sampleWet(100, 0, sample) && sample.height).toBe(7);
  });
});

describe("hydrology water: streaming", () => {
  const lake = packHydrologyWater([], [roundLake(0, 0, 100, 5)]);

  it("answers none where no region has been posted", () => {
    const source = new HydrologyWaterSource(() => 0);
    expect(source.sampleWet(0, 0, sample)).toBe(false);
    expect(source.sample(0, 0, sample).kind).toBe("none");
    source.setRegion("far", packHydrologyWater([], [roundLake(10_000, 0, 100, 5)]));
    expect(source.sampleWet(0, 0, sample)).toBe(false);
  });

  it("replaces a region posted again under its key", () => {
    const source = new HydrologyWaterSource(() => 0);
    source.setRegion("k", lake);
    source.setRegion("k", lake);
    expect(source.regionCount).toBe(1);
    expect(source.sampleWet(0, 0, sample) && sample.height).toBe(5);
    source.setRegion("k", packHydrologyWater([], [roundLake(0, 0, 100, 6)]));
    expect(source.regionCount).toBe(1);
    expect(source.sampleWet(0, 0, sample) && sample.height).toBe(6);
  });

  it("keeps a region asked to go while the vehicle is within about a kilometre of it", () => {
    const source = new HydrologyWaterSource(() => 0);
    source.setRegion("k", lake);
    // No vehicle placed yet: it goes at once.
    source.evictRegion("k");
    expect(source.regionCount).toBe(0);

    source.setRegion("k", lake);
    source.setVehiclePosition(100 + HYDROLOGY_EVICTION_KEEP_METERS - 10, 0);
    source.evictRegion("k");
    expect(source.hasRegion("k")).toBe(true);
    expect(source.sampleWet(0, 0, sample)).toBe(true);
    source.setVehiclePosition(100 + HYDROLOGY_EVICTION_KEEP_METERS + 10, 0);
    expect(source.hasRegion("k")).toBe(false);

    // Posted again while waiting to go, it stays.
    source.setRegion("k", lake);
    source.setVehiclePosition(0, 0);
    source.evictRegion("k");
    source.setRegion("k", lake);
    source.setVehiclePosition(5_000, 0);
    expect(source.hasRegion("k")).toBe(true);
  });

  it("reads the bed only where a river or lake covers the point", () => {
    const bed = vi.fn(() => 0);
    const source = new HydrologyWaterSource(bed);
    const lakes: HydrologyWaterLake[] = [];
    for (let i = 0; i < 400; i += 1) lakes.push(roundLake((i % 20) * 500, Math.floor(i / 20) * 500, 100, 5));
    source.setRegion("many", packHydrologyWater([straightRiver()], lakes));
    for (let i = 0; i < 1_000; i += 1) source.sampleWet(250 + (i % 10), 250 + Math.floor(i / 10), sample);
    expect(bed).not.toHaveBeenCalled();
    expect(source.sampleWet(500, 500, sample)).toBe(true);
    expect(bed).toHaveBeenCalledTimes(1);
  });
});

/** A sea of long, low swell running along +z: 0.3 m high, 80 m long. */
class Swell implements HullWaterSampler {
  times = 0;
  focuses = 0;
  constructor(private readonly bed: (x: number, z: number) => number) {}
  setTime(): void {
    this.times += 1;
  }
  setFocus(): void {
    this.focuses += 1;
  }
  sample(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    const k = (2 * Math.PI) / 80;
    const height = 0.15 * Math.sin(k * z);
    const bed = this.bed(x, z);
    out.kind = bed < height ? "sea" : "none";
    out.height = bed < height ? height : bed;
    out.stillHeight = 0;
    out.depth = Math.max(0, -bed);
    out.velocity.x = 0;
    out.velocity.y = 0;
    out.velocity.z = 0.4 * Math.sin(k * z);
    const slope = 0.15 * k * Math.cos(k * z);
    const n = 1 / Math.sqrt(1 + slope * slope);
    out.normal.x = 0;
    out.normal.y = n;
    out.normal.z = -slope * n;
    return out;
  }
}

describe("the water composite: sea, lakes and rivers", () => {
  /**
   * A river down a beach into the sea: the ground falls 1 cm a metre through
   * sea level at z = 200 and on, the river 0.16 m over it from z = 0 to 300,
   * as the generator lays a ribbon (each station 0.16 m over the ground).
   */
  const beach = (_x: number, z: number): number => 2 - 0.01 * z;
  function mouth(): HydrologyWaterSource {
    const points = [];
    for (let z = 0; z <= 300; z += 30) {
      points.push({ x: 0, y: beach(0, z) + 0.16, z, widthMeters: 20, flowSpeedMetersPerSecond: 1.2 });
    }
    const source = new HydrologyWaterSource(beach);
    source.setRegion("mouth", packHydrologyWater([{ points }], []));
    return source;
  }

  it("is continuous along a river into a calm sea, river then sea, once", () => {
    const water = new WaterSurfaceComposite(new CalmWaterSurface(0, beach), mouth(), 0);
    let previous = water.sample(0, 0, createWaterSurfaceSample()).height;
    const kinds: string[] = [];
    let worst = 0;
    for (let z = 0.02; z <= 400; z += 0.02) {
      const at = water.sample(0, z, sample);
      worst = Math.max(worst, Math.abs(at.height - previous));
      previous = at.height;
      if (kinds.at(-1) !== at.kind) kinds.push(at.kind);
    }
    expect(kinds).toEqual(["river", "sea"]);
    // The river falls 0.2 mm in 2 cm; the mouth's blend adds no step.
    expect(worst).toBeLessThan(0.002);
    // Up the beach the river answers alone; out past the shore the sea does.
    expect(water.sample(0, 150, sample).kind).toBe("river");
    expect(sample.height).toBeCloseTo(beach(0, 150) + 0.16, 9);
    expect(water.sample(0, 250, sample)).toMatchObject({ kind: "sea", height: 0 });
  });

  it("lets the swell run into the mouth and stays continuous with it", () => {
    const sea = new Swell(beach);
    const water = new WaterSurfaceComposite(sea, mouth(), 0);
    let previous = water.sample(0, 100, createWaterSurfaceSample()).height;
    let worst = 0;
    for (let z = 100.02; z <= 400; z += 0.02) {
      const at = water.sample(0, z, sample);
      worst = Math.max(worst, Math.abs(at.height - previous));
      previous = at.height;
    }
    // The swell's steepest rise in 2 cm is 0.15 k 0.02 = 0.24 mm; allow the blend a little more.
    expect(worst).toBeLessThan(0.003);
    // Where the river's surface is below sea level the sea answers, waves and all.
    for (const z of [240, 251, 262, 273, 290]) {
      expect(beach(0, z) + 0.16).toBeLessThan(0);
      expect(water.sample(0, z, sample).kind).toBe("sea");
      expect(sample.height).toBeCloseTo(0.15 * Math.sin(((2 * Math.PI) / 80) * z), 9);
    }
  });

  it("returns the sea's own answer where no lake or river holds water", () => {
    const sea = new Swell(beach);
    const water = new WaterSurfaceComposite(sea, mouth(), 0);
    const direct = createWaterSurfaceSample();
    for (const [x, z] of [[50, 250], [-30, 380], [0, 500], [500, 0]] as const) {
      expect(water.sample(x, z, sample)).toEqual(sea.sample(x, z, direct));
    }
  });

  it("lets a lake well above sea level answer over the sea it overlaps", () => {
    const source = new HydrologyWaterSource(() => -2);
    source.setRegion("lagoon", packHydrologyWater([], [roundLake(0, 0, 100, MOUTH_HIGH + 0.2)]));
    const water = new WaterSurfaceComposite(new CalmWaterSurface(0, () => -2), source, 0);
    expect(water.sample(0, 0, sample)).toMatchObject({ kind: "lake", height: MOUTH_HIGH + 0.2 });
    expect(water.sample(0, 150, sample)).toMatchObject({ kind: "sea", height: 0 });
  });

  it("says dry without reading the bed only where the caller's bed stands a margin over the sea, off the river", () => {
    let reads = 0;
    const counted = (x: number, z: number) => {
      reads += 1;
      return beach(x, z);
    };
    const water = new WaterSurfaceComposite(new CalmWaterSurface(0, counted), mouth(), 0);
    const at = { x: 0, z: 0, height: 0 };
    let dry = 0;
    for (let x = -61; x <= 61; x += 2) {
      for (let z = 0; z <= 400; z += 2) {
        at.x = x;
        at.z = z;
        at.height = beach(x, z);
        if (!water.isDry(at)) continue;
        dry += 1;
        // Dry for certain: the full answer is none there.
        expect(water.sample(x, z, sample).kind).toBe("none");
        // A metre over the sea and outside the 20 m river.
        expect(at.height).toBeGreaterThan(CALM_DRY_MARGIN);
        expect(Math.abs(x)).toBeGreaterThan(10);
      }
    }
    // Up the beach (z under 100) and off the river: all of it.
    expect(dry).toBe(52 * 50);
    // The answers read no bed of their own; only the full samples did.
    expect(reads).toBe(dry);
    // A sea that cannot say is always asked.
    const swell = new WaterSurfaceComposite(new Swell(beach), mouth(), 0);
    at.x = 50;
    at.z = 0;
    at.height = beach(50, 0);
    expect(swell.isDry(at)).toBe(false);
  });

  it("passes the time to both sources and the hull's focus to the sea only", () => {
    const sea = new Swell(beach);
    const inland = mouth();
    const inlandTime = vi.spyOn(inland, "setTime");
    const water = new WaterSurfaceComposite(sea, inland, 0);
    water.setTime(1);
    const focus: WaveFieldFocus = { x: 0, z: 0, heading: 0, halfLength: 3, halfBeam: 1 };
    water.setFocus(focus);
    expect(sea.times).toBe(1);
    expect(inlandTime).toHaveBeenCalledTimes(1);
    expect(sea.focuses).toBe(1);
    // A sea that takes no focus is not focused.
    expect(() => new WaterSurfaceComposite(new CalmWaterSurface(0, beach), inland, 0).setFocus(focus)).not.toThrow();
  });
});
