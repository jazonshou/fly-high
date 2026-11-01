import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { structureSetArrays } from "@/src/render/structures/structureMeshArrays";
import {
  LIGHT_POINT_PROFILE_INTEGRAL,
  STRUCTURE_BEACON_FLASH_SECONDS,
  STRUCTURE_BEACON_PERIOD_SECONDS,
  STRUCTURE_GLAZING,
  STRUCTURE_LAMP_REFERENCE_PIXELS_PER_RADIAN,
  STRUCTURE_WINDOW_LAMP_STANDOFF,
  STRUCTURE_WINDOW_POINT_SCALE,
  structureBeaconFlash,
  structureBeaconUntilFlash,
  structureLampSite,
  structureLampSiteGain,
  structureMastHeight,
  structureWindowLampShare,
  structureWindowSideCandela,
} from "@/src/render/structures/structureLamps";
import { StructureLampPool, type StructureLampSink } from "@/src/render/structures/StructureLampPool";
import {
  STRUCTURE_GLASS_SHARE,
  STRUCTURE_LAMP_RGB,
  STRUCTURE_SCENE_UNIT_TO_NITS,
  STRUCTURE_WINDOW_NITS,
  structureLampLit,
  structureLampThreshold,
  structureNightLighting,
} from "@/src/render/structures/structureNightLighting";
import { AIRFIELD_LAMP_SCENE_SCALE } from "@/src/render/webgpu/lighting/AirfieldLighting";
import {
  LIGHT_POINT_SPAWNED_AIRFIELDS,
  LIGHT_POINT_STRUCTURES,
  LightPointSystem,
  type LightPointFixture,
} from "@/src/render/webgpu/lighting/LightPoints";
import { OBSTRUCTION_LIGHT_RGB } from "@/src/render/webgpu/lighting/ObstructionLighting";
import { StructureSystem, type StructureMeshBuilder } from "@/src/render/webgpu/structures/StructureSystem";
import { STOREY_HEIGHT } from "@/src/world/structures/kit/kitPlan";
import { STRUCTURE_ARCHETYPES, type StructureRecord } from "@/src/world/structures/structureRecord";

/**
 * The buildings' light points (structures S5): lit windows past the near
 * radius, the weather mast's obstruction lights and the lighthouse's flash,
 * as a group of the home field's one light-point draw.
 */

function record(id: number, x: number, z: number, overrides: Partial<StructureRecord> = {}): StructureRecord {
  return {
    id,
    archetype: "house",
    style: "temperate",
    x,
    z,
    heading: 0.6,
    width: 10,
    depth: 8,
    storeys: 2,
    floorY: 30,
    baseY: 29.4,
    entryY: 29.6,
    foundation: "plinth",
    seed: id,
    settlement: 1,
    settlementKind: "hamlet",
    basalt: false,
    ...overrides,
  };
}

const RANGES = { nearRadiusMeters: 400, bandMeters: 40, farRadiusMeters: 3_900, maxPoints: 1_024 };

class FakeSink implements StructureLampSink {
  fixtures: LightPointFixture[] = [];
  colours: (readonly [number, number, number])[] = [];
  rebuilds = 0;
  recolours = 0;
  setGroupFixtures(key: string, fixtures: readonly LightPointFixture[], colours?: readonly (readonly [number, number, number])[]): void {
    expect(key).toBe(LIGHT_POINT_STRUCTURES);
    this.fixtures = [...fixtures];
    this.colours = colours ? colours.map((c) => [c[0], c[1], c[2]] as const) : fixtures.map((f) => f.color);
    this.rebuilds += 1;
  }
  setGroupColors(key: string, start: number, colours: readonly (readonly [number, number, number])[]): void {
    expect(key).toBe(LIGHT_POINT_STRUCTURES);
    expect(start + colours.length).toBeLessThanOrEqual(this.fixtures.length);
    for (let i = 0; i < colours.length; i += 1) this.colours[start + i] = [colours[i]![0], colours[i]![1], colours[i]![2]];
    this.recolours += 1;
  }
}

/** A building's lit id: one whose threshold the evening share passes. */
function litHouse(x: number, z: number, from = 1): StructureRecord {
  for (let id = from; ; id += 1) {
    const r = record(id, x, z);
    if (structureLampThreshold(r) < 0.5) return r;
  }
}

describe("the buildings' light points", () => {
  it("put a house's window light on its four walls, facing out, at window height", () => {
    const house = record(7, 1_000, -500);
    const site = structureLampSite(house)!;
    expect(site.role).toBe("window");
    expect(site.fixtures).toHaveLength(4);
    const c = Math.cos(house.heading);
    const s = Math.sin(house.heading);
    for (const fixture of site.fixtures) {
      // In the building's frame: off the middle of one wall, by the standoff.
      const dx = fixture.position[0] - house.x;
      const dz = fixture.position[2] - house.z;
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      const onSide = Math.abs(Math.abs(lx) - (house.width / 2 + STRUCTURE_WINDOW_LAMP_STANDOFF)) < 1e-9 && Math.abs(lz) < 1e-9
        || Math.abs(Math.abs(lz) - (house.depth / 2 + STRUCTURE_WINDOW_LAMP_STANDOFF)) < 1e-9 && Math.abs(lx) < 1e-9;
      expect(onSide).toBe(true);
      expect(fixture.position[1]).toBeCloseTo(house.floorY + STOREY_HEIGHT, 9);
      // Aimed straight out of that wall, a hemisphere.
      const length = Math.hypot(dx, dz);
      expect(fixture.aim[0]).toBeCloseTo(dx / length, 9);
      expect(fixture.aim[2]).toBeCloseTo(dz / length, 9);
      expect(fixture.aim[1]).toBe(0);
      expect(fixture.beamCosineCutoff).toBe(0);
      expect(fixture.color).toEqual(STRUCTURE_LAMP_RGB);
    }
    // The long walls carry more light than the ends.
    const front = site.fixtures[0]!.intensity;
    const end = site.fixtures[2]!.intensity;
    expect(front / end).toBeCloseTo(house.width / house.depth, 9);
  });

  it("carry the shells' window light, photometrically, at the reference output", () => {
    // The point's integral matches the shader's profile over its quad.
    let sum = 0;
    const n = 400;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const x = -1 + (2 * (i + 0.5)) / n;
        const y = -1 + (2 * (j + 0.5)) / n;
        const r2 = x * x + y * y;
        if (r2 <= 1) sum += Math.exp(-4.5 * r2) * (4 / (n * n));
      }
    }
    expect(LIGHT_POINT_PROFILE_INTEGRAL).toBeCloseTo(sum, 3);
    // A house's front at 800 m: the point's flux on screen (scene units x
    // output pixels) is its glazing's, seen face on, times 2 / pi.
    const house = record(7, 0, 0);
    const d = 800;
    const site = structureLampSite(house)!;
    const pointFlux = (site.fixtures[0]!.intensity / (d * d)) * LIGHT_POINT_PROFILE_INTEGRAL;
    const glazed = STRUCTURE_GLAZING.house * house.width * house.storeys * STOREY_HEIGHT * STRUCTURE_GLASS_SHARE;
    const pixels = glazed * (STRUCTURE_LAMP_REFERENCE_PIXELS_PER_RADIAN / d) ** 2;
    const windowFlux = (STRUCTURE_WINDOW_NITS / STRUCTURE_SCENE_UNIT_TO_NITS) * pixels * (2 / Math.PI);
    expect(pointFlux / windowFlux).toBeCloseTo(1, 9);
    expect(structureWindowSideCandela("house", 10, 2)).toBeCloseTo(60 * 0.75 * 0.091 * 10 * 2 * STOREY_HEIGHT * (2 / Math.PI), 9);
    // Thousands of times dimmer than an airfield lamp of the same candela: not a signal light.
    expect(AIRFIELD_LAMP_SCENE_SCALE / STRUCTURE_WINDOW_POINT_SCALE).toBeGreaterThan(1_000);
  });

  it("give the dark props none, the mast red obstruction lights at its lamps, the lighthouse a flashing beacon", () => {
    for (const archetype of ["windmill", "tank", "watchtower"] as const) {
      expect(structureLampSite(record(3, 0, 0, { archetype }))).toBeNull();
    }
    for (const archetype of STRUCTURE_ARCHETYPES) {
      const site = structureLampSite(record(3, 0, 0, { archetype, width: 5, depth: 5, storeys: 3 }));
      if (site?.role === "window") expect(site.fixtures).toHaveLength(4);
    }

    const mast = record(41, 200, 300, { archetype: "mast", width: 4, depth: 4, storeys: 1, heading: 1.1 });
    const site = structureLampSite(mast)!;
    expect(site.role).toBe("obstruction");
    expect(site.fixtures).toHaveLength(2);
    const height = structureMastHeight(mast);
    expect(site.fixtures.map((f) => f.position[1] - mast.floorY)).toEqual([height + 0.12, height * 0.5].map((y) => expect.closeTo(y, 9)));
    for (const fixture of site.fixtures) {
      expect(fixture.color).toEqual(OBSTRUCTION_LIGHT_RGB);
      expect(fixture.beamCosineCutoff).toBeUndefined();
    }
    // Each stands just off one of the kit's red lamp boxes: the mast's mesh has vertices within 0.25 m.
    const { opaque } = structureSetArrays("near", [mast], 0, 0, false);
    for (const fixture of site.fixtures) {
      let nearest = Infinity;
      for (let v = 0; v < opaque.positions.length; v += 3) {
        nearest = Math.min(nearest, Math.hypot(
          opaque.positions[v]! - fixture.position[0],
          opaque.positions[v + 1]! - fixture.position[1],
          opaque.positions[v + 2]! - fixture.position[2],
        ));
      }
      expect(nearest).toBeLessThan(0.25);
    }

    const lighthouse = record(42, 0, 0, { archetype: "lighthouse", width: 5, depth: 5, storeys: 4, settlementKind: "lighthouse" });
    const beacon = structureLampSite(lighthouse)!;
    expect(beacon.role).toBe("beacon");
    expect(beacon.fixtures).toHaveLength(4);
    for (const fixture of beacon.fixtures) {
      expect(fixture.position[1] - lighthouse.floorY).toBeCloseTo(4 * STOREY_HEIGHT + 1.45, 9);
      expect(fixture.beamCosineCutoff).toBeCloseTo(Math.SQRT1_2, 12);
    }
  });

  it("flash a lighthouse once a period, and know when the next flash starts", () => {
    const phase = 3.3;
    let lit = 0;
    let peak = 0;
    const step = 0.01;
    for (let t = 0; t < STRUCTURE_BEACON_PERIOD_SECONDS; t += step) {
      const f = structureBeaconFlash(t, phase);
      if (f > 0) lit += step;
      peak = Math.max(peak, f);
    }
    expect(lit).toBeCloseTo(STRUCTURE_BEACON_FLASH_SECONDS, 1);
    expect(peak).toBeCloseTo(1, 3);
    for (const t of [0, 1.7, 4.2, 9.9, 123.4]) {
      const until = structureBeaconUntilFlash(t, phase);
      expect(until).toBeGreaterThanOrEqual(0);
      expect(until).toBeLessThan(STRUCTURE_BEACON_PERIOD_SECONDS);
      expect(structureBeaconFlash(t + until + 0.05, phase)).toBeGreaterThan(0);
      if (until > 0.02) expect(structureBeaconFlash(t + until - 0.02, phase)).toBe(0);
    }
  });

  it("light a building's points when its windows are lit, as its block comes in", () => {
    const house = litHouse(0, 0);
    const site = structureLampSite(house)!;
    const evening = structureNightLighting(20, 1).litFraction;
    expect(structureLampLit(site.threshold, evening)).toBe(true);
    // The far set's share: nothing inside the near radius, all past the band, out at the far radius.
    expect(structureLampSiteGain(site, 300, RANGES, evening, 0)).toBe(0);
    expect(structureLampSiteGain(site, 420, RANGES, evening, 0)).toBeCloseTo(0.5, 12);
    expect(structureLampSiteGain(site, 1_500, RANGES, evening, 0)).toBe(1);
    expect(structureLampSiteGain(site, 3_880, RANGES, evening, 0)).toBeCloseTo(0.5, 12);
    expect(structureLampSiteGain(site, 4_000, RANGES, evening, 0)).toBe(0);
    for (const d of [380, 400, 410, 440, 2_000, 3_870, 3_900]) {
      expect(structureWindowLampShare(d, 400, 40, 3_900)).toBe(
        Math.min(1, Math.max(0, (d - 400) / 40)) * Math.min(1, Math.max(0, (3_900 - d) / 40)),
      );
    }
    // Off when the share is below its threshold, and by day.
    expect(structureLampSiteGain(site, 1_500, RANGES, site.threshold, 0)).toBe(0);
    expect(structureLampSiteGain(site, 1_500, RANGES, structureNightLighting(13, 0).litFraction, 0)).toBe(0);
    // The mast's lights are on wherever it is drawn, whoever is home.
    const mast = structureLampSite(record(41, 0, 0, { archetype: "mast", width: 4, depth: 4, storeys: 1 }))!;
    expect(structureLampSiteGain(mast, 100, RANGES, 0, 0)).toBe(1);
  });

  it("choose signal lights first, then the windows nearest the near radius, within the budget", () => {
    const sink = new FakeSink();
    const pool = new StructureLampPool(sink, LIGHT_POINT_STRUCTURES, () => 0);
    pool.setRanges({ ...RANGES, maxPoints: 10 });
    pool.setNight(structureNightLighting(20, 1));
    const records = [
      record(101, 2_000, 0),
      record(102, 600, 0),
      record(103, 100, 0), // inside the near radius: its shell's windows are drawn
      record(104, 900, 0),
      record(105, 3_000, 0, { archetype: "mast", width: 4, depth: 4, storeys: 1 }),
      record(106, 5_000, 0), // past the far radius
      record(107, 700, 0, { archetype: "windmill" }),
    ];
    pool.update({ x: 0, z: 0 }, records, 1);
    // The mast's two, then the houses at 600 and 900 m (four each); the one at 2 km is over budget.
    expect(sink.fixtures).toHaveLength(10);
    expect(sink.fixtures.slice(0, 2).every((f) => f.color === OBSTRUCTION_LIGHT_RGB)).toBe(true);
    expect(pool.statistics).toMatchObject({ sites: 3, points: 10, dropped: 1 });
    const ids = (from: number) => Math.round(sink.fixtures[from]!.position[0]);
    expect([ids(2), ids(6)].map((x) => Math.abs(x - 600) < 10 || Math.abs(x - 900) < 10)).toEqual([true, true]);
  });

  it("rebuild the draw only when the choice changes, and recolour as the camera moves", () => {
    const sink = new FakeSink();
    const pool = new StructureLampPool(sink, LIGHT_POINT_STRUCTURES, () => 0);
    pool.setRanges(RANGES);
    pool.setNight(structureNightLighting(20, 1));
    const a = litHouse(1_000, 0);
    const b = litHouse(1_200, 300, a.id + 1);
    pool.update({ x: 0, z: 0 }, [a, b], 1);
    expect(sink.rebuilds).toBe(1);
    expect(sink.recolours).toBe(1);
    expect(sink.colours.every((c) => c[0] > 0)).toBe(true);
    // Moving 5 m: nothing. 20 m: a recolour, no rebuild.
    pool.update({ x: 5, z: 0 }, [a, b], 1);
    expect([sink.rebuilds, sink.recolours]).toEqual([1, 1]);
    pool.update({ x: 20, z: 0 }, [a, b], 1);
    expect([sink.rebuilds, sink.recolours]).toEqual([1, 2]);
    // A new store version with the same buildings: chosen again, the same, no rebuild.
    pool.update({ x: 20, z: 0 }, [a, b], 2);
    expect(sink.rebuilds).toBe(1);
    // Walking into the near radius of the first: its points go out, the other's stay.
    pool.update({ x: 900, z: 0 }, [a, b], 2);
    expect(sink.rebuilds).toBe(2);
    const lit = sink.colours.map((c) => c[0] > 0);
    expect(lit.filter(Boolean)).toHaveLength(4);
    // Later at night fewer are lit; the night change recolours.
    pool.setNight(structureNightLighting(3, 1));
    const before = sink.recolours;
    pool.update({ x: 900, z: 0 }, [a, b], 2);
    expect(sink.recolours).toBe(before + 1);
    pool.dispose();
    expect(sink.fixtures).toHaveLength(0);
  });

  it("recolour a lighthouse through its flash and not between flashes", () => {
    const sink = new FakeSink();
    let now = 0;
    const pool = new StructureLampPool(sink, LIGHT_POINT_STRUCTURES, () => now);
    pool.setRanges(RANGES);
    pool.setNight(structureNightLighting(22, 1));
    const lighthouse = record(42, 1_000, 0, { archetype: "lighthouse", width: 5, depth: 5, storeys: 4, settlementKind: "lighthouse" });
    const site = structureLampSite(lighthouse)!;
    // Start just after a flash ends.
    now = structureBeaconUntilFlash(0, site.phaseSeconds) + STRUCTURE_BEACON_FLASH_SECONDS + 0.1;
    pool.update({ x: 0, z: 0 }, [lighthouse], 1);
    const first = sink.recolours;
    expect(sink.colours.every((c) => c[0] === 0)).toBe(true);
    // Between flashes: no uploads.
    for (let i = 0; i < 200; i += 1) {
      now += 0.05;
      if (structureBeaconFlash(now, site.phaseSeconds) > 0 || structureBeaconUntilFlash(now, site.phaseSeconds) < 0.06) break;
      pool.update({ x: 0, z: 0 }, [lighthouse], 1);
    }
    expect(sink.recolours).toBe(first);
    // Through the next flash: lit, and dark again after it.
    let peak = 0;
    const end = now + STRUCTURE_BEACON_PERIOD_SECONDS * 0.5;
    while (now < end) {
      now += 1 / 60;
      pool.update({ x: 0, z: 0 }, [lighthouse], 1);
      peak = Math.max(peak, sink.colours[0]![0]);
    }
    expect(peak).toBeGreaterThan(0.9);
    expect(sink.colours.every((c) => c[0] === 0)).toBe(true);
    expect(sink.recolours - first).toBeLessThan(STRUCTURE_BEACON_FLASH_SECONDS * 60 + 5);
  });
});

describe("the light-point draw's groups", () => {
  const lamp = (x: number, color: readonly [number, number, number]): LightPointFixture => ({
    position: [x, 10, 0], aim: [0, 1, 0], intensity: 1, profileRow: 0, radiusMeters: 0.2, color,
  });
  const colourOf = (system: LightPointSystem, index: number): number[] => {
    const buffer = (system as unknown as { colourBuffer: Float32Array }).colourBuffer;
    return [buffer[index * 12]!, buffer[index * 12 + 1]!, buffer[index * 12 + 2]!];
  };

  it("keep every other lamp's colour when one group is replaced", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const system = new LightPointSystem(scene, [lamp(0, [1, 0, 0]), lamp(1, [1, 0, 0])], 1);
    system.setColors([[0, 1, 0], [0, 0, 1]]);
    system.setExtraFixtures([lamp(2, [1, 1, 1])], [[0.5, 0.5, 0.5]]);
    system.setGroupFixtures(LIGHT_POINT_STRUCTURES, [lamp(3, [1, 0.7, 0.4]), lamp(4, [1, 0.7, 0.4])], [[0, 0, 0], [0.2, 0.2, 0.2]]);
    expect(system.extraFixtureCount).toBe(1);
    expect(system.groupFixtureCount(LIGHT_POINT_SPAWNED_AIRFIELDS)).toBe(1);
    expect(system.groupFixtureCount(LIGHT_POINT_STRUCTURES)).toBe(2);
    expect([0, 1, 2, 3, 4].map((i) => colourOf(system, i)[0])).toEqual([0, 0, 0.5, 0, expect.closeTo(0.2, 6)]);
    // A spawned field's PAPI flips: only its lamp changes.
    system.setExtraColors(0, [[1, 0, 0]]);
    expect(colourOf(system, 2)).toEqual([1, 0, 0]);
    // The airports change: the buildings keep their colours, the home field its.
    system.setExtraFixtures([lamp(5, [1, 1, 1]), lamp(6, [1, 1, 1])]);
    expect(colourOf(system, 0)).toEqual([0, 1, 0]);
    expect(colourOf(system, 1)).toEqual([0, 0, 1]);
    expect(colourOf(system, 2)).toEqual([1, 1, 1]);
    expect(colourOf(system, 5)[0]).toBeCloseTo(0.2, 6);
    // The buildings recolour within their own group.
    system.setGroupColors(LIGHT_POINT_STRUCTURES, 1, [[0.9, 0.6, 0.3]]);
    expect(colourOf(system, 5)[0]).toBeCloseTo(0.9, 6);
    expect(colourOf(system, 3)).toEqual([1, 1, 1]);
    expect(() => system.setGroupColors(LIGHT_POINT_STRUCTURES, 1, [[1, 1, 1], [1, 1, 1]])).toThrow(RangeError);
    // Emptying a group drops its lamps and keeps the rest.
    system.setGroupFixtures(LIGHT_POINT_STRUCTURES, []);
    expect(system.groupFixtureCount(LIGHT_POINT_STRUCTURES)).toBe(0);
    expect(colourOf(system, 3)).toEqual([1, 1, 1]);
    system.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("take the buildings' points from the structure system once it has the draw", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const builder: StructureMeshBuilder = {
      build: () => new Promise(() => {}),
      textures: () => new Promise(() => {}),
      dispose: () => {},
    };
    const system = new StructureSystem(scene, {
      structureNearRadiusMeters: 400,
      structureFarRadiusMeters: 4_000,
      structureOpenBuildings: 4,
      structureNearCastsShadows: false,
      structureTextureEdge: 0,
      structureLampPoints: 1_024,
    }, builder, null);
    const points = new LightPointSystem(scene, [lamp(0, [1, 0, 0])], 1);
    system.setLamps(points, () => 0);
    system.setNight(structureNightLighting(20, 1));
    const house = litHouse(1_500, 0);
    system.apply([{ key: "settlements:0:0", structures: [house, record(9_001, 100, 0)] }], []);
    system.update({ x: 0, y: 50, z: 0 });
    // The house past the near radius has four lit points; the one inside has its shell's windows (and points, dark).
    expect(points.groupFixtureCount(LIGHT_POINT_STRUCTURES)).toBe(4);
    expect(system.statistics.lamps).toMatchObject({ sites: 1, points: 4 });
    expect(colourOf(points, 1)[0]).toBeGreaterThan(0);
    system.dispose();
    expect(points.groupFixtureCount(LIGHT_POINT_STRUCTURES)).toBe(0);
    points.dispose();
    scene.dispose();
    engine.dispose();
  });
});
