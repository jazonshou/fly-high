import { describe, expect, it } from "vitest";
import {
  runwayEarthworksHeightLocal,
  runwayPlatformHeight,
} from "../src/render/webgpu/terrain/RunwayEarthworks";
import {
  MAX_TERRAIN_HEIGHT,
  MAX_WIND_SPEED,
  MIN_TERRAIN_HEIGHT,
  DEFAULT_WORLD_EVOLUTION,
  TerrainBiome,
  assessAirportSite,
  createWorld,
  DETAILED_PRIMARY_COUNT,
  HEADINGS_PER_DETAILED_CANDIDATE,
  readAirportSiteEvaluationCount,
  resetAirportSiteEvaluationCount,
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
  type AirportDefinition,
  type WorldDefinition,
} from "../src/world";

const SAFE_TEST_AIRPORT_SEED = "certified-airport-fixture";

interface DenseAirportOracle {
  readonly minimumPlatformClearance: number;
  readonly platformRelief: number;
  readonly longitudinalGrade: number;
  readonly crossGrade: number;
  readonly minimumBlendClearance: number;
  readonly blendRelief: number;
  readonly minimumApproachClearance: number;
  readonly approachObstruction: number;
}

function independentAxis(minimum: number, maximum: number, maximumSpacing: number): number[] {
  const intervals = Math.max(1, Math.ceil((maximum - minimum) / maximumSpacing));
  return Array.from(
    { length: intervals + 1 },
    (_, index) => minimum + ((maximum - minimum) * index) / intervals,
  );
}

function independentRoundedDistance(
  along: number,
  across: number,
  halfLength: number,
  halfWidth: number,
): number {
  const qAlong = Math.abs(along) - halfLength;
  const qAcross = Math.abs(across) - halfWidth;
  return (
    Math.hypot(Math.max(qAlong, 0), Math.max(qAcross, 0)) +
    Math.min(Math.max(qAlong, qAcross), 0)
  );
}

/**
 * Test-only dense oracle. Its independent 11/13/17 m lattices deliberately do
 * not call assessAirportSite or share any of the production certificate grids.
 */
function independentlyAuditAirport(
  world: Readonly<WorldDefinition>,
  airport: Readonly<AirportDefinition>,
): DenseAirportOracle {
  const halfLength = airport.runwayLength * 0.5 + airport.endSafetyArea;
  const halfWidth = airport.runwayWidth * 0.5 + airport.shoulderWidth;
  const sinHeading = Math.sin(airport.headingRadians);
  const cosHeading = Math.cos(airport.headingRadians);
  const naturalHeight = (along: number, across: number): number =>
    sampleNaturalTerrainHeight(
      world.seedHash,
      airport.centerX + along * sinHeading + across * cosHeading,
      airport.centerZ + along * cosHeading - across * sinHeading,
      0,
    );

  const alongSamples = independentAxis(-halfLength, halfLength, 11);
  const acrossSamples = independentAxis(-halfWidth, halfWidth, 9);
  const platformRows: number[][] = [];
  let platformMinimum = Number.POSITIVE_INFINITY;
  let platformMaximum = Number.NEGATIVE_INFINITY;
  let crossGrade = 0;
  for (const along of alongSamples) {
    const row = acrossSamples.map((across) => naturalHeight(along, across));
    platformRows.push(row);
    platformMinimum = Math.min(platformMinimum, ...row);
    platformMaximum = Math.max(platformMaximum, ...row);
    crossGrade = Math.max(
      crossGrade,
      Math.abs((row.at(-1) ?? 0) - (row[0] ?? 0)) / (halfWidth * 2),
    );
  }

  const alongSpacing = (halfLength * 2) / Math.max(1, alongSamples.length - 1);
  const gradeLag = Math.max(1, Math.ceil(160 / alongSpacing));
  const gradeDistance = gradeLag * alongSpacing;
  let longitudinalGrade = 0;
  for (let rowIndex = gradeLag; rowIndex < platformRows.length; rowIndex += 1) {
    const row = platformRows[rowIndex]!;
    const previous = platformRows[rowIndex - gradeLag]!;
    for (let acrossIndex = 0; acrossIndex < row.length; acrossIndex += 1) {
      longitudinalGrade = Math.max(
        longitudinalGrade,
        Math.abs((row[acrossIndex] ?? 0) - (previous[acrossIndex] ?? 0)) /
          gradeDistance,
      );
    }
  }

  const blendDistance = airport.terrainBlendDistance;
  let blendMinimum = platformMinimum;
  let blendMaximum = platformMaximum;
  for (const along of independentAxis(
    -halfLength - blendDistance,
    halfLength + blendDistance,
    13,
  )) {
    for (const across of independentAxis(
      -halfWidth - blendDistance,
      halfWidth + blendDistance,
      13,
    )) {
      if (
        independentRoundedDistance(along, across, halfLength, halfWidth) > blendDistance
      ) {
        continue;
      }
      const height = naturalHeight(along, across);
      blendMinimum = Math.min(blendMinimum, height);
      blendMaximum = Math.max(blendMaximum, height);
    }
  }

  let approachMinimum = Number.POSITIVE_INFINITY;
  let approachObstruction = Number.NEGATIVE_INFINITY;
  for (const end of [-1, 1]) {
    for (const distance of independentAxis(0, 4_200, 17)) {
      const corridorHalfWidth = 70 + distance * 0.095;
      const permittedHeight = airport.elevation + 18 + distance * 0.0524;
      for (const across of independentAxis(-corridorHalfWidth, corridorHalfWidth, 17)) {
        const height = naturalHeight(end * (halfLength + distance), across);
        if (distance <= 520) approachMinimum = Math.min(approachMinimum, height);
        approachObstruction = Math.max(approachObstruction, height - permittedHeight);
      }
    }
  }

  return {
    minimumPlatformClearance: platformMinimum - world.seaLevel,
    platformRelief: platformMaximum - platformMinimum,
    longitudinalGrade,
    crossGrade,
    minimumBlendClearance: blendMinimum - world.seaLevel,
    blendRelief: blendMaximum - blendMinimum,
    minimumApproachClearance: approachMinimum - world.seaLevel,
    approachObstruction,
  };
}

describe("world seeds", () => {
  it("defaults to the analytic authority while preserving explicit eroded worlds", () => {
    // `G0-1`: the default is analytic. The eroded path generates one page at a
    // time on a single CPU worker, which starves page supply and shows up as a
    // flat sea-level grass plate. Explicit eroded worlds still work; only the
    // no-option default moved. Re-pin this to "eroded" when 5-3/5-4 land the
    // GPU erosion port.
    expect(DEFAULT_WORLD_EVOLUTION).toBe("analytic");
    expect(createWorld("evolution-default", { airport: false }).worldEvolution).toBe(
      "analytic",
    );
    expect(
      createWorld("evolution-parity", {
        airport: false,
        worldEvolution: "analytic",
      }).worldEvolution,
    ).toBe("analytic");
  });

  it("rejects an unknown world-evolution authority at the runtime boundary", () => {
    expect(() =>
      createWorld("invalid-evolution", {
        airport: false,
        worldEvolution: "future-mode",
      } as never),
    ).toThrow(/worldEvolution/);
  });

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

  it("keeps the public seed identity stable while resolving a deterministic flight region", () => {
    const first = createWorld("shareable-region-contract");
    const repeated = createWorld("shareable-region-contract");
    expect(first.seed).toBe("shareable-region-contract");
    expect(first.sourceSeedHash).toBe(hashSeed("shareable-region-contract"));
    expect(repeated).toEqual(first);
    expect(first.airport).not.toBeNull();
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
    const runwayWorld = createWorld(SAFE_TEST_AIRPORT_SEED);
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
  const world = createWorld(SAFE_TEST_AIRPORT_SEED);
  const airport = world.airport!;

  it("keeps the generated runway fixture on a naturally buildable site", () => {
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

  it("grades the entire paved rectangle onto the crowned platform", () => {
    // 3-8: the platform is no longer a plane. A runway is cambered so water
    // sheds, so the paved rectangle sits on `elevation + crown(across)` — the
    // centreline at the datum and the edges up to 0.35 m below it. What must
    // stay exact is that the natural terrain contributes NOTHING here.
    const positions = [
      runwayToWorld(airport, 0, 0),
      runwayToWorld(airport, airport.runwayLength * 0.49, airport.runwayWidth * 0.49),
      runwayToWorld(airport, -airport.runwayLength * 0.49, -airport.runwayWidth * 0.49),
    ];
    for (const position of positions) {
      expect(isPointOnRunway(airport, position.x, position.z)).toBe(true);
      const local = worldToRunway(airport, position.x, position.z);
      expect(sampleTerrainHeight(world, position.x, position.z)).toBeCloseTo(
        runwayPlatformHeight(airport, local.across),
        9,
      );
      const sample = sampleTerrain(world, position.x, position.z);
      expect(sample.isRunway).toBe(true);
      expect(sample.biome).toBe(TerrainBiome.RUNWAY);
    }
    // The centreline is the datum and the shoulder edge is a full crown below.
    const centre = runwayToWorld(airport, 0, 0);
    expect(sampleTerrainHeight(world, centre.x, centre.z)).toBeCloseTo(airport.elevation, 9);
    const halfWidth = airport.runwayWidth * 0.5 + airport.shoulderWidth;
    const edge = runwayToWorld(airport, 0, halfWidth * 0.999);
    expect(airport.elevation - sampleTerrainHeight(world, edge.x, edge.z)).toBeGreaterThan(0.34);
  });

  it("keeps getAirportInfluence total for hand-built definitions", () => {
    // createWorld rejects a non-positive blend distance, but the sampler is
    // also handed AirportDefinitions built by hand — tests, and 3-9's runway
    // binding. Left unguarded, a negative blend distance returns influence 1
    // at every distance, which since 3-8 makes the collision fast path
    // short-circuit to the platform kilometres from the airport while the
    // render path returns natural terrain: the two height authorities
    // disagreeing, which is the one thing §1.3 forbids.
    const far = runwayToWorld(airport, 0, airport.runwayWidth * 40);
    for (const blend of [-240, 0, Number.NaN]) {
      const malformed = { ...airport, terrainBlendDistance: blend };
      expect(getAirportInfluence(malformed, far.x, far.z)).toBe(0);
      // The apron itself is unaffected: influence is still exactly 1 inside.
      const centre = runwayToWorld(airport, 0, 0);
      expect(getAirportInfluence(malformed, centre.x, centre.z)).toBe(1);
    }
    expect(getAirportInfluence(airport, far.x, far.z)).toBe(0);
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

    // 3-8 replaced the single lerp toward a flat disc with the three-zone
    // cut/fill profile; the render path must evaluate exactly that profile.
    const natural = sampleNaturalTerrainHeight(world.seedHash, withinBlend.x, withinBlend.z, 0);
    const local = worldToRunway(airport, withinBlend.x, withinBlend.z);
    expect(sampleTerrainHeight(world, withinBlend.x, withinBlend.z)).toBeCloseTo(
      runwayEarthworksHeightLocal(
        airport,
        natural,
        local.along,
        local.across,
        withinBlend.x,
        withinBlend.z,
        world.seedHash,
      ),
      10,
    );
    expect(sampleTerrainHeight(world, outsideBlend.x, outsideBlend.z)).toBeCloseTo(
      sampleNaturalTerrainHeight(world.seedHash, outsideBlend.x, outsideBlend.z, 0),
      10,
    );
  });

  it("can be disabled for worlds without an airport", () => {
    const noAirport = createWorld("runway-tests", { airport: false });
    expect(noAirport.airport).toBeNull();
    expect(sampleTerrainHeight(noAirport, 0, 0)).toBe(
      sampleNaturalTerrainHeight(noAirport.seedHash, 0, 0, 0),
    );
  });

  it("guarantees independently audited runways across dense varied seeds", () => {
    let availableAirportCount = 0;
    const seedCount = 384;
    const selectionEvaluations: number[] = [];
    const resolvedRegionHashes = new Set<number>();
    for (let index = 0; index < seedCount; index += 1) {
      const variedSeed = `airport-safety-${index}-${Math.imul(index + 17, 2_654_435_761) >>> 0}`;
      resetAirportSiteEvaluationCount();
      const seededWorld = createWorld(variedSeed);
      selectionEvaluations.push(readAirportSiteEvaluationCount());
      resolvedRegionHashes.add(seededWorld.seedHash);
      const seededAirport = seededWorld.airport;
      expect(seededWorld.seed).toBe(variedSeed);
      expect(seededWorld.sourceSeedHash).toBe(hashSeed(variedSeed));
      expect(seededAirport, `${variedSeed} should resolve a safe flight region`).not.toBeNull();
      if (!seededAirport) throw new Error(`${variedSeed} has no airport`);
      availableAirportCount += 1;
      const audit = independentlyAuditAirport(seededWorld, seededAirport);
      const detail = `${variedSeed} dense audit ${JSON.stringify(audit)}`;
      expect(audit.minimumPlatformClearance, `${detail} runway dryness`).toBeGreaterThanOrEqual(8);
      expect(audit.platformRelief, `${detail} platform relief`).toBeLessThanOrEqual(24);
      expect(audit.longitudinalGrade, `${detail} runway grade`).toBeLessThanOrEqual(0.065);
      expect(audit.crossGrade, `${detail} runway cross-grade`).toBeLessThanOrEqual(0.12);
      expect(audit.minimumBlendClearance, `${detail} blend dryness`).toBeGreaterThanOrEqual(2);
      expect(audit.blendRelief, `${detail} construction blend relief`).toBeLessThanOrEqual(50);
      expect(audit.minimumApproachClearance, `${detail} approach dryness`).toBeGreaterThanOrEqual(2);
      expect(audit.approachObstruction, `${detail} approach clearance`).toBeLessThanOrEqual(0);
      expect(seededAirport.elevation, `${variedSeed} airport elevation`).toBeLessThanOrEqual(260);
      expect(
        Math.hypot(seededAirport.centerX, seededAirport.centerZ),
        `${variedSeed} flight-region radius`,
      ).toBeLessThan(45_000);
    }
    expect(availableAirportCount).toBe(seedCount);
    expect(resolvedRegionHashes.size).toBeGreaterThan(112);
    // Guards against an algorithmic regression in site selection — an unbounded
    // or badly seeded search — by COUNTING the work rather than timing it.
    //
    // This assertion used to be a wall-clock p95 under a comment claiming it
    // did not measure hardware speed. It did: the budget was calibrated per
    // machine (150 ms local / 500 ms CI), drifted with load, and passed and
    // failed on identical code twenty minutes apart on the same host. An
    // assertion that states it does not measure hardware speed, and does, is
    // worse than no assertion — it fails a green change and sends someone
    // hunting a regression that is not there.
    //
    // Evaluations are exactly reproducible: the search is a pure function of
    // the seed, with no clock, no concurrency and no allocation sensitivity.
    // Measured over this sweep the per-seed count spans 576..577 — a range of
    // ONE across 384 seeds — and three consecutive runs produced byte-identical
    // totals. So the false-positive rate is zero by construction, not by
    // tolerance, which is what the wall-clock version could never offer.
    //
    // The ceiling is DERIVED from the search's own constants, so widening the
    // search moves the budget with it instead of silently blowing it.
    const sortedEvaluations = selectionEvaluations.sort((left, right) => left - right);
    const p95Evaluations = sortedEvaluations[Math.floor(sortedEvaluations.length * 0.95)]
      ?? Infinity;
    // The primary search is the whole budget; `+ 16` is headroom for the
    // catalogue-region fallback, which adds one evaluation per region walked
    // and measured at most one across this sweep.
    const evaluationCeiling = DETAILED_PRIMARY_COUNT * HEADINGS_PER_DETAILED_CANDIDATE + 16;
    expect(
      p95Evaluations,
      `p95 site evaluations ${p95Evaluations} exceeds the derived ceiling `
      + `${evaluationCeiling}; the search is examining more candidates than its `
      + `own constants allow, which is the regression this guards`,
    ).toBeLessThanOrEqual(evaluationCeiling);
    // A timeout catches a hung test; it is not a performance budget
    // (vitest.config.ts). The p95 assertion directly above is this sweep's
    // performance guard, and it is already scaled for shared hardware; the
    // ceiling here must not quietly be a second, unscaled one. The work is
    // deliberately large and entirely wall-clock independent: 384 site
    // selections plus 384 independent dense oracles, ~9.1M full-bandwidth
    // terrain-kernel evaluations. Vitest's SSR transform turns every
    // cross-module call in that kernel into a namespace property load, so it
    // runs ~4.5x slower here than the same code does in the app — ~40 s on an
    // Apple-silicon laptop, and past 120 s on a shared CI runner sharing four
    // cores with the rest of the suite. That is the 120 s ceiling reporting
    // which machine ran the test, exactly what the note above rejects. Ten
    // minutes is not a claim about how long this should take: it is far
    // enough above every machine that only a genuine hang can trip it.
  }, 600_000);

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
