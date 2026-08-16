import { describe, expect, it } from "vitest";
import {
  MAX_TERRAIN_HEIGHT,
  MAX_WIND_SPEED,
  MIN_TERRAIN_HEIGHT,
  TerrainBiome,
  assessAirportSite,
  createWorld,
  flattenHeightForAirport,
  getAirportInfluence,
  hashCoordinates,
  hashSeed,
  isPointOnRunway,
  runwayToWorld,
  sampleNaturalTerrainHeight,
  sampleTerrainCollision,
  sampleTerrainCollisionHeight,
  sampleTerrain,
  sampleTerrainHeight,
  sampleWind,
  worldToRunway,
} from "../src/world";

const SAFE_TEST_AIRPORT = Object.freeze({
  centerX: -3_109.8434911464765,
  centerZ: -7_702.165069913508,
  elevation: 35.25,
  headingRadians: 0.6698306877107214,
});
const SAFE_TEST_AIRPORT_SEED = "airport-safety-1-535203442";

describe("world seeds", () => {
  it("hashes text, numbers, and signed coordinates deterministically", () => {
    expect(hashSeed("alpine-dawn")).toBe(hashSeed("alpine-dawn"));
    expect(hashSeed("alpine-dawn")).not.toBe(hashSeed("alpine-dusk"));
    expect(hashSeed(42)).toBe(hashSeed(42));
    expect(hashCoordinates(hashSeed("coordinates"), -17, 29)).toBe(
      hashCoordinates(hashSeed("coordinates"), -17, 29),
    );
    expect(hashCoordinates(hashSeed("coordinates"), -17, 29)).not.toBe(
      hashCoordinates(hashSeed("coordinates"), 17, -29),
    );
  });

  it("rejects non-finite numeric seeds", () => {
    expect(() => createWorld(Number.NaN)).toThrow(RangeError);
    expect(() => createWorld(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("terrain kernel", () => {
  const world = createWorld("world-kernel-tests", { airport: false });

  it("returns identical samples for repeated positive and negative coordinates", () => {
    const coordinates = [
      [-12_345.625, -8_765.25],
      [-1_024, 2_048],
      [0, 0],
      [999.125, -0.25],
      [42_000, 77_000],
    ] as const;

    for (const [x, z] of coordinates) {
      expect(sampleTerrain(world, x, z)).toEqual(sampleTerrain(world, x, z));
      expect(sampleTerrainHeight(world, x, z)).toBe(sampleTerrainHeight(world, x, z));
    }
  });

  it("keeps collision height, normals, runway, and friction identical to visual semantics", () => {
    const runwayWorld = createWorld(SAFE_TEST_AIRPORT_SEED, { airport: SAFE_TEST_AIRPORT });
    const airport = runwayWorld.airport!;
    const runwayPoint = runwayToWorld(airport, airport.runwayLength * 0.25, 0);
    const coordinates: Array<readonly [number, number]> = [
      [runwayPoint.x, runwayPoint.z],
      [0, 0],
      [-12_345.625, -8_765.25],
      [7_200.5, -3_300.25],
      [42_000, 77_000],
    ];
    const target = {
      height: -1,
      normal: { x: 9, y: 9, z: 9 },
      isRunway: false,
      friction: -1,
    };

    for (const [x, z] of coordinates) {
      const full = sampleTerrain(runwayWorld, x, z);
      const collision = sampleTerrainCollision(runwayWorld, x, z, target);
      expect(collision).toBe(target);
      expect(collision.height).toBe(full.height);
      expect(sampleTerrainCollisionHeight(runwayWorld, x, z)).toBeCloseTo(full.height, 12);
      expect(collision.normal.x).toBeCloseTo(full.normal.x, 12);
      expect(collision.normal.y).toBeCloseTo(full.normal.y, 12);
      expect(collision.normal.z).toBeCloseTo(full.normal.z, 12);
      expect(collision.isRunway).toBe(full.isRunway);
      expect(collision.friction).toBe(
        full.isRunway ? 1.18 : full.biome === TerrainBiome.WATER ? 0.05 : 0.86,
      );
    }
  });

  it("changes the landscape when the seed changes", () => {
    const alternate = createWorld("a-different-world", { airport: false });
    const first = createWorld("first-world", { airport: false });
    const points: Array<readonly [number, number]> = [
      [-8_000, -2_500],
      [1_100, 6_700],
      [14_500, -12_300],
    ];
    const differences = points.map(([x, z]) =>
      Math.abs(sampleTerrainHeight(first, x, z) - sampleTerrainHeight(alternate, x, z)),
    );
    expect(Math.max(...differences)).toBeGreaterThan(1);
  });

  it("is continuous across arbitrary and signed lattice boundaries", () => {
    const epsilon = 0.001;
    const boundaries = [-18_000, -1_024, -1, 0, 1, 1_024, 18_000];
    for (const boundary of boundaries) {
      const left = sampleTerrainHeight(world, boundary - epsilon, -3_217.25);
      const right = sampleTerrainHeight(world, boundary + epsilon, -3_217.25);
      const back = sampleTerrainHeight(world, 4_922.75, boundary - epsilon);
      const front = sampleTerrainHeight(world, 4_922.75, boundary + epsilon);
      expect(Math.abs(right - left)).toBeLessThan(0.2);
      expect(Math.abs(front - back)).toBeLessThan(0.2);
    }
  });

  it("always produces finite, normalized, bounded samples", () => {
    for (let z = -24_000; z <= 24_000; z += 4_000) {
      for (let x = -24_000; x <= 24_000; x += 4_000) {
        const sample = sampleTerrain(world, x + 0.375, z - 0.625);
        const values = [
          sample.height,
          sample.normal.x,
          sample.normal.y,
          sample.normal.z,
          sample.slope,
          sample.moisture,
          sample.temperature,
          sample.color.r,
          sample.color.g,
          sample.color.b,
          sample.airportInfluence,
        ];
        expect(values.every(Number.isFinite)).toBe(true);
        expect(sample.height).toBeGreaterThanOrEqual(MIN_TERRAIN_HEIGHT);
        expect(sample.height).toBeLessThanOrEqual(MAX_TERRAIN_HEIGHT);
        expect(Math.hypot(sample.normal.x, sample.normal.y, sample.normal.z)).toBeCloseTo(1, 9);
        expect(sample.normal.y).toBeGreaterThan(0);
        expect(sample.slope).toBeGreaterThanOrEqual(0);
        expect(sample.slope).toBeLessThanOrEqual(1);
        expect(sample.moisture).toBeGreaterThanOrEqual(0);
        expect(sample.moisture).toBeLessThanOrEqual(1);
        expect(sample.temperature).toBeGreaterThanOrEqual(0);
        expect(sample.temperature).toBeLessThanOrEqual(1);
        expect(sample.color.r).toBeGreaterThanOrEqual(0);
        expect(sample.color.r).toBeLessThanOrEqual(1);
      }
    }
  });

  it("contains water, plains, hills, and mountain-scale relief over a broad region", () => {
    const naturalWorld = createWorld("varied-relief", { airport: false });
    const heights: number[] = [];
    for (let z = -40_000; z <= 40_000; z += 4_000) {
      for (let x = -40_000; x <= 40_000; x += 4_000) {
        heights.push(sampleTerrainHeight(naturalWorld, x, z));
      }
    }
    expect(Math.min(...heights)).toBeLessThan(naturalWorld.seaLevel);
    expect(Math.max(...heights)).toBeGreaterThan(naturalWorld.seaLevel + 350);
    expect(heights.some((height) => height > 15 && height < 180)).toBe(true);
  });

  it("provides meaningful regional relief around the starter airport", () => {
    const scenicWorld = createWorld(4_253_686_068, { airport: false });
    const heights: number[] = [];
    for (const radius of [3_000, 6_000, 10_000, 16_000, 24_000]) {
      for (let bearing = 0; bearing < 24; bearing += 1) {
        const angle = (bearing / 24) * Math.PI * 2;
        heights.push(
          sampleTerrainHeight(
            scenicWorld,
            Math.cos(angle) * radius,
            Math.sin(angle) * radius,
          ),
        );
      }
    }
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(420);
    expect(heights.some((height) => height > scenicWorld.seaLevel + 260)).toBe(true);
  });
});

describe("starter airport terrain", () => {
  const world = createWorld(SAFE_TEST_AIRPORT_SEED, { airport: SAFE_TEST_AIRPORT });
  const airport = world.airport!;

  it("keeps the explicit runway fixture on a naturally buildable site", () => {
    expect(
      assessAirportSite(
        world.seedHash,
        world.seaLevel,
        airport.centerX,
        airport.centerZ,
        airport.headingRadians,
        airport,
      ).suitable,
    ).toBe(true);
  });

  it("flattens the entire paved rectangle to the configured elevation", () => {
    const positions = [
      runwayToWorld(airport, 0, 0),
      runwayToWorld(airport, airport.runwayLength * 0.49, airport.runwayWidth * 0.49),
      runwayToWorld(airport, -airport.runwayLength * 0.49, -airport.runwayWidth * 0.49),
    ];
    for (const position of positions) {
      expect(isPointOnRunway(airport, position.x, position.z)).toBe(true);
      expect(sampleTerrainHeight(world, position.x, position.z)).toBeCloseTo(airport.elevation, 10);
      const sample = sampleTerrain(world, position.x, position.z);
      expect(sample.isRunway).toBe(true);
      expect(sample.biome).toBe(TerrainBiome.RUNWAY);
    }
  });

  it("provides inverse runway/world transforms", () => {
    const point = runwayToWorld(airport, 317.5, -12.25);
    const local = worldToRunway(airport, point.x, point.z);
    expect(local.along).toBeCloseTo(317.5, 10);
    expect(local.across).toBeCloseTo(-12.25, 10);
    expect(point.y).toBe(airport.elevation);
  });

  it("smoothly blends back to untouched natural terrain", () => {
    const platformHalfWidth = airport.runwayWidth * 0.5 + airport.shoulderWidth;
    const withinBlend = runwayToWorld(airport, 0, platformHalfWidth + airport.terrainBlendDistance * 0.5);
    const outsideBlend = runwayToWorld(airport, 0, platformHalfWidth + airport.terrainBlendDistance + 1);
    const influence = getAirportInfluence(airport, withinBlend.x, withinBlend.z);
    expect(influence).toBeGreaterThan(0);
    expect(influence).toBeLessThan(1);
    expect(getAirportInfluence(airport, outsideBlend.x, outsideBlend.z)).toBe(0);

    const natural = sampleNaturalTerrainHeight(world.seedHash, withinBlend.x, withinBlend.z);
    expect(sampleTerrainHeight(world, withinBlend.x, withinBlend.z)).toBeCloseTo(
      flattenHeightForAirport(natural, airport, withinBlend.x, withinBlend.z),
      10,
    );
    expect(sampleTerrainHeight(world, outsideBlend.x, outsideBlend.z)).toBeCloseTo(
      sampleNaturalTerrainHeight(world.seedHash, outsideBlend.x, outsideBlend.z),
      10,
    );
  });

  it("can be disabled for worlds without an airport", () => {
    const noAirport = createWorld("runway-tests", { airport: false });
    expect(noAirport.airport).toBeNull();
    expect(sampleTerrainHeight(noAirport, 0, 0)).toBe(
      sampleNaturalTerrainHeight(noAirport.seedHash, 0, 0),
    );
  });

  it("selects dry, low-earthwork runways with clear approaches across many seeds", () => {
    let availableAirportCount = 0;
    for (let index = 0; index < 192; index += 1) {
      const variedSeed = `airport-safety-${index}-${Math.imul(index + 17, 2_654_435_761) >>> 0}`;
      const seededWorld = createWorld(variedSeed);
      const seededAirport = seededWorld.airport;
      if (!seededAirport) continue;
      availableAirportCount += 1;
      const assessment = assessAirportSite(
        seededWorld.seedHash,
        seededWorld.seaLevel,
        seededAirport.centerX,
        seededAirport.centerZ,
        seededAirport.headingRadians,
        seededAirport,
      );

      expect(
        assessment.suitable,
        `${variedSeed} airport assessment ${JSON.stringify(assessment)}`,
      ).toBe(true);
      expect(assessment.minimumPlatformClearance, `${variedSeed} runway dryness`).toBeGreaterThanOrEqual(8);
      expect(assessment.platformRelief, `${variedSeed} platform relief`).toBeLessThanOrEqual(24);
      expect(assessment.longitudinalGrade, `${variedSeed} runway grade`).toBeLessThanOrEqual(0.065);
      expect(assessment.crossGrade, `${variedSeed} runway cross-grade`).toBeLessThanOrEqual(0.12);
      expect(assessment.blendRelief, `${variedSeed} construction blend relief`).toBeLessThanOrEqual(50);
      expect(assessment.elevation, `${variedSeed} airport elevation`).toBeLessThanOrEqual(260);
      expect(assessment.minimumApproachClearance, `${variedSeed} approach dryness`).toBeGreaterThanOrEqual(2);
      expect(assessment.approachObstruction, `${variedSeed} approach clearance`).toBeLessThanOrEqual(0);
      expect(Math.abs(seededAirport.elevation - assessment.elevation)).toBeLessThanOrEqual(0.125);
    }
    // The selector intentionally refuses unsafe seeds, but the bounded search
    // must still expose the runway start often enough to catch search collapse.
    expect(availableAirportCount).toBeGreaterThanOrEqual(8);
    expect(availableAirportCount).toBeLessThan(192);
  }, 30_000);

  it("keeps explicit custom airport sites exact instead of silently relocating them", () => {
    const custom = createWorld("manual-airport", {
      airport: { centerX: 12_345, centerZ: -6_789, headingRadians: 1.17, elevation: 88 },
    }).airport!;
    expect(custom).toMatchObject({
      centerX: 12_345,
      centerZ: -6_789,
      headingRadians: 1.17,
      elevation: 88,
    });
  });
});

describe("wind field", () => {
  const world = createWorld("wind-tests");

  it("is reproducible, continuous, finite, and bounded", () => {
    const original = sampleWind(world, -3_200, 750, 8_100, 125.5);
    expect(sampleWind(world, -3_200, 750, 8_100, 125.5)).toEqual(original);
    const adjacent = sampleWind(world, -3_199.99, 750.01, 8_100.01, 125.51);
    expect(Math.hypot(adjacent.x - original.x, adjacent.y - original.y, adjacent.z - original.z)).toBeLessThan(0.1);

    for (let time = 0; time <= 3_600; time += 137) {
      const wind = sampleWind(world, -20_000 + time * 13, 50 + time, 9_000 - time * 7, time);
      expect([wind.x, wind.y, wind.z, wind.speed, wind.gust, wind.turbulence].every(Number.isFinite)).toBe(true);
      expect(wind.speed).toBeLessThanOrEqual(MAX_WIND_SPEED);
      expect(wind.gust).toBeGreaterThanOrEqual(-1);
      expect(wind.gust).toBeLessThanOrEqual(1);
      expect(wind.turbulence).toBeGreaterThanOrEqual(0);
      expect(wind.turbulence).toBeLessThanOrEqual(1);
    }
  });
});
