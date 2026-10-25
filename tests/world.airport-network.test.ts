import { describe, expect, it } from "vitest";
import {
  AIRPORT_SPAWN_POLICY,
  airportSpawnDue,
  createWorld,
  findSpawnedAirport,
  getAirportInfluence,
  getRunwayEnds,
  nearestAirport,
  sampleTerrainCollision,
  sampleTerrainCollisionHeight,
  sampleTerrainHeight,
  withAirports,
  worldAirportAt,
  type AirportDefinition,
  type TerrainCollisionSample,
  type WorldDefinition,
} from "@/src/world";
import { assessAirportSite } from "@/src/world";
import { sampleGroundContact } from "@/src/sim/terrainGrid";

function collisionTarget(): TerrainCollisionSample {
  return { height: 0, normal: { x: 0, y: 1, z: 0 }, isRunway: false, friction: 0 };
}

/** Runs one anchored spawn search to completion, as the game loop does over frames. */
function spawnFrom(
  world: WorldDefinition,
  x: number,
  z: number,
  heading: number,
): Readonly<AirportDefinition> | null {
  for (let attempt = 0; ; attempt += 1) {
    const result = findSpawnedAirport(world, x, z, heading, attempt);
    if (result === "exhausted") return null;
    if (result) return result;
  }
}

describe("airport network", () => {
  it("starts every world with exactly its home field", () => {
    const world = createWorld("open-skies");
    expect(world.airport).not.toBeNull();
    expect(world.airports).toEqual([world.airport]);
    expect(createWorld("open-skies", { airport: false }).airports).toEqual([]);
  });

  it("finds the nearest airport with a clockwise-from-north bearing", () => {
    const world = createWorld("open-skies");
    const home = world.airport!;
    const east = nearestAirport(world, home.centerX - 3_000, home.centerZ);
    expect(east?.index).toBe(0);
    expect(east?.distanceMeters).toBeCloseTo(3_000, 6);
    // The airport lies to the EAST (+x) of the query point: bearing 90 deg.
    expect(east?.bearingRadians).toBeCloseTo(Math.PI / 2, 9);
    const south = nearestAirport(world, home.centerX, home.centerZ + 2_000);
    expect(south?.bearingRadians).toBeCloseTo(Math.PI, 9);
    expect(nearestAirport(createWorld("open-skies", { airport: false }), 0, 0)).toBeNull();
  });

  it("describes both runway ends as reciprocal landings from opposite thresholds", () => {
    const airport = createWorld("open-skies").airport!;
    const [first, second] = getRunwayEnds(airport);
    expect(Math.hypot(
      first.threshold.x - second.threshold.x,
      first.threshold.z - second.threshold.z,
    )).toBeCloseTo(airport.runwayLength, 6);
    expect(first.threshold.y).toBe(airport.elevation);
    const reciprocal = Math.abs(first.landingHeadingRadians - second.landingHeadingRadians);
    expect(reciprocal).toBeCloseTo(Math.PI, 9);
    // Landing on the first end flies FROM its threshold TOWARD the second.
    const dx = second.threshold.x - first.threshold.x;
    const dz = second.threshold.z - first.threshold.z;
    expect(Math.atan2(dx, dz)).toBeCloseTo(
      Math.atan2(Math.sin(first.landingHeadingRadians), Math.cos(first.landingHeadingRadians)),
      9,
    );
    const firstNumber = Number(first.designator);
    const secondNumber = Number(second.designator);
    expect(first.designator).toMatch(/^(0[1-9]|[12]\d|3[0-6])$/);
    expect((firstNumber + 18 - 1) % 36 + 1).toBe(secondNumber);
  });

  it("is due only once the aircraft is past the trigger distance from every airport", () => {
    const world = createWorld("open-skies");
    const home = world.airport!;
    const trigger = AIRPORT_SPAWN_POLICY.triggerDistanceMeters;
    expect(airportSpawnDue(world, home.centerX + trigger - 10, home.centerZ)).toBe(false);
    expect(airportSpawnDue(world, home.centerX + trigger + 10, home.centerZ)).toBe(true);
  });

  for (const seed of ["open-skies", "alpha", "zulu"]) {
    it(`spawns a closer, separated, certified runway for ${seed}`, () => {
      const world = createWorld(seed);
      const home = world.airport!;
      const heading = 2.6;
      const x = home.centerX + Math.sin(heading) * 15_000;
      const z = home.centerZ + Math.cos(heading) * 15_000;
      const spawned = spawnFrom(world, x, z, heading);
      expect(spawned).not.toBeNull();
      const distance = Math.hypot(spawned!.centerX - x, spawned!.centerZ - z);
      expect(distance).toBeGreaterThanOrEqual(AIRPORT_SPAWN_POLICY.minDistanceMeters - 1e-6);
      expect(distance).toBeLessThanOrEqual(AIRPORT_SPAWN_POLICY.maxDistanceMeters + 1e-6);
      expect(distance).toBeLessThan(15_000);
      expect(Math.hypot(spawned!.centerX - home.centerX, spawned!.centerZ - home.centerZ))
        .toBeGreaterThanOrEqual(AIRPORT_SPAWN_POLICY.minSeparationMeters);
      // Out of the nose arc.
      const bearing = Math.atan2(spawned!.centerX - x, spawned!.centerZ - z);
      const offNose = Math.abs(Math.atan2(Math.sin(bearing - heading), Math.cos(bearing - heading)));
      expect(offNose).toBeGreaterThanOrEqual(AIRPORT_SPAWN_POLICY.noseExclusionRadians - 1e-9);
      // The home field's footprint, and ground that stays dry under it.
      expect(spawned!.runwayLength).toBe(home.runwayLength);
      expect(spawned!.runwayWidth).toBe(home.runwayWidth);
      const assessment = assessAirportSite(
        world.seedHash, world.seaLevel, spawned!.centerX, spawned!.centerZ,
        spawned!.headingRadians, spawned!,
      );
      expect(assessment.minimumPlatformClearance).toBeGreaterThanOrEqual(4);
      expect(assessment.approachObstruction).toBeLessThanOrEqual(-2);
      // Deterministic: the same anchor finds the same runway.
      expect(spawnFrom(world, x, z, heading)).toEqual(spawned);

      const next = withAirports(world, [...world.airports, spawned!]);
      expect(next.airports).toHaveLength(2);
      expect(next.airport).toBe(world.airport);
      expect(nearestAirport(next, x, z)?.index).toBe(1);
      expect(airportSpawnDue(next, x, z)).toBe(false);
    });
  }

  it("gives a spawned runway the same crowned collision surface as the home field", () => {
    const world = createWorld("alpha");
    const home = world.airport!;
    const x = home.centerX + 15_000;
    const z = home.centerZ;
    const spawned = spawnFrom(world, x, z, Math.PI / 2)!;
    const next = withAirports(world, [...world.airports, spawned]);
    expect(worldAirportAt(next, spawned.centerX, spawned.centerZ)).toEqual(spawned);
    expect(worldAirportAt(next, home.centerX, home.centerZ)).toBe(home);

    // Centreline: exactly the platform datum, on the runway, at runway friction.
    expect(sampleTerrainCollisionHeight(next, spawned.centerX, spawned.centerZ))
      .toBe(spawned.elevation);
    const contact = sampleTerrainCollision(next, spawned.centerX, spawned.centerZ, collisionTarget());
    expect(contact.isRunway).toBe(true);
    expect(contact.friction).toBe(1.18);
    expect(contact.height).toBe(spawned.elevation);
    const ground = sampleGroundContact(next, spawned.centerX, spawned.centerZ, collisionTarget());
    expect(ground.isRunway).toBe(true);
    expect(ground.height).toBe(spawned.elevation);
    // Before it spawned the same point was natural ground.
    expect(sampleTerrainCollision(world, spawned.centerX, spawned.centerZ, collisionTarget()).isRunway)
      .toBe(false);
    // The whole graded platform is flat to the crown, end to end.
    for (const along of [-0.5, -0.25, 0.25, 0.5]) {
      const px = spawned.centerX + Math.sin(spawned.headingRadians) * along * spawned.runwayLength;
      const pz = spawned.centerZ + Math.cos(spawned.headingRadians) * along * spawned.runwayLength;
      expect(getAirportInfluence(spawned, px, pz)).toBe(1);
      expect(sampleTerrainHeight(next, px, pz)).toBeCloseTo(spawned.elevation, 9);
    }
  });

  it("leaves the home field's terrain bit-identical when other airports exist", () => {
    const world = createWorld("alpha");
    const home = world.airport!;
    const spawned = spawnFrom(world, home.centerX + 15_000, home.centerZ, Math.PI / 2)!;
    const next = withAirports(world, [...world.airports, spawned]);
    for (let index = 0; index < 64; index += 1) {
      const x = home.centerX + (index % 8 - 4) * 173.3;
      const z = home.centerZ + (Math.floor(index / 8) - 4) * 151.7;
      expect(sampleTerrainHeight(next, x, z)).toBe(sampleTerrainHeight(world, x, z));
      expect(sampleTerrainCollisionHeight(next, x, z)).toBe(sampleTerrainCollisionHeight(world, x, z));
    }
  });

  it("keeps the list within the GPU slots, retiring the oldest spawn and never the home field", () => {
    const world = createWorld("open-skies");
    const home = world.airport!;
    const fake = (index: number): AirportDefinition => ({
      ...home,
      centerX: home.centerX + 10_000 * (index + 1),
    });
    const many = [home, ...Array.from({ length: AIRPORT_SPAWN_POLICY.maxAirports + 2 }, (_, i) => fake(i))];
    const next = withAirports(world, many);
    expect(next.airports).toHaveLength(AIRPORT_SPAWN_POLICY.maxAirports);
    expect(next.airports[0]).toBe(home);
    expect(next.airports.at(-1)).toEqual(fake(AIRPORT_SPAWN_POLICY.maxAirports + 1));
    expect(withAirports(next, next.airports)).toBe(next);
    expect(() => withAirports(world, [fake(0)])).toThrow();
  });
});
