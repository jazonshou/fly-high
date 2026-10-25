import { describe, expect, it } from "vitest";
import {
  createWorld,
  findSpawnedAirport,
  getRunwayEnds,
  sampleNaturalTerrainHeight,
  spawnedAirportGroundAllowed,
  spawnedAirportSiteHeight,
  type AirportDefinition,
  type WorldDefinition,
} from "@/src/world";
import {
  SPAWNED_AIRPORT_VOLCANIC_CLEARANCE_METERS,
  SPAWNED_AIRPORT_VOLCANIC_COVER_MAX,
} from "@/src/world/airportNetwork";
import { landformCoreCenter } from "@/src/world/landforms";
import {
  applyVolcanicOverlay,
  createVolcanicGroundSample,
  sampleVolcanicGround,
  volcanicSitesInBounds,
  type VolcanicSite,
} from "@/src/world/volcanism";

/**
 * Volcanic land on the spawned-airport seams: the survey reads the overlay's
 * ground, and no runway is placed on or beside a volcano.
 */

/** Runs one anchored spawn search to completion, as the spawn worker does. */
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

/** The natural world's guaranteed stratovolcano, just past the landform core. */
function guaranteedStrato(world: WorldDefinition): VolcanicSite {
  const center = landformCoreCenter(world);
  const site = volcanicSitesInBounds(
    world, center.x - 200_000, center.z - 200_000, center.x + 200_000, center.z + 200_000,
  ).find((candidate) => candidate.id % 4 === 2);
  if (!site) throw new Error("no guaranteed stratovolcano");
  return site;
}

/** Whether an edifice's base comes within the clearance of a point. */
function nearVolcano(world: WorldDefinition, x: number, z: number): boolean {
  const c = SPAWNED_AIRPORT_VOLCANIC_CLEARANCE_METERS;
  return volcanicSitesInBounds(world, x - c, z - c, x + c, z + c)
    .some((site) => Math.hypot(site.x - x, site.z - z) - site.radiusMeters < c);
}

/** Lava plus tephra at a point. */
function volcanicCover(world: WorldDefinition, x: number, z: number): number {
  const ground = sampleVolcanicGround(world, x, z, 0, createVolcanicGroundSample());
  return ground.lavaCover + ground.tephraCover;
}

describe("spawned airports and volcanic land", () => {
  it("survey the volcanic overlay's ground", () => {
    const world = createWorld("open-skies");
    const strato = guaranteedStrato(world);
    const siteHeight = spawnedAirportSiteHeight(world);
    // Up the flank to the rim: the ground the world draws, not the natural kernel.
    let largestRiseMeters = 0;
    for (let step = 0; step <= 8; step += 1) {
      const x = strato.x + strato.radiusMeters * (1 - step / 8);
      const z = strato.z;
      const natural = sampleNaturalTerrainHeight(world.seedHash, x, z, 0);
      largestRiseMeters = Math.max(largestRiseMeters, siteHeight(x, z) - natural);
    }
    expect(largestRiseMeters).toBeGreaterThan(strato.heightMeters * 0.5);
    expect(applyVolcanicOverlay(world, strato.x, strato.z, 0, 0)).not.toBe(0);
  });

  it("refuses volcanic ground and the clearance around it", () => {
    const world = createWorld("open-skies");
    const home = world.airport!;
    expect(spawnedAirportGroundAllowed(world, home.centerX, home.centerZ)).toBe(true);
    const strato = guaranteedStrato(world);
    expect(spawnedAirportGroundAllowed(world, strato.x, strato.z)).toBe(false);

    // A 24 km square over the field, every 600 m.
    let volcanicPoints = 0;
    let cones = 0;
    let allowed = 0;
    for (let row = -20; row <= 20; row += 1) {
      for (let column = -20; column <= 20; column += 1) {
        const x = strato.x + column * 600;
        const z = strato.z + row * 600;
        const ok = spawnedAirportGroundAllowed(world, x, z);
        const onVolcanicGround = volcanicCover(world, x, z) > SPAWNED_AIRPORT_VOLCANIC_COVER_MAX;
        const nearCone = nearVolcano(world, x, z);
        expect(ok).toBe(!onVolcanicGround && !nearCone);
        if (onVolcanicGround) volcanicPoints += 1;
        if (nearCone) cones += 1;
        if (ok) allowed += 1;
      }
    }
    expect(volcanicPoints).toBeGreaterThan(50);
    expect(cones).toBeGreaterThan(50);
    // Not the whole field: the ground between the cones and flows stays open.
    expect(allowed).toBeGreaterThan(41 * 41 * 0.05);
  });

  it("spawns no runway on or beside a volcano", () => {
    const world = createWorld("open-skies");
    const strato = guaranteedStrato(world);
    // From over the summit every candidate (5-9 km out) is on the cone, so
    // the search is exhausted. From 15 km north, 5.5 km past the cone's foot,
    // part of the ring is the cone and part open ground (this field's rugged
    // ground exhausts many anchors with no veto at all, so the anchor is one
    // that spawns on every heading).
    expect(spawnFrom(world, strato.x, strato.z, 0)).toBeNull();
    const anchor = { x: strato.x, z: strato.z + 15_000 };
    let spawned = 0;
    for (const heading of [0, 2, 4]) {
      const airport = spawnFrom(world, anchor.x, anchor.z, heading);
      if (!airport) continue;
      spawned += 1;
      for (const point of [
        { x: airport.centerX, z: airport.centerZ },
        ...getRunwayEnds(airport).map(({ threshold }) => threshold),
      ]) {
        expect(nearVolcano(world, point.x, point.z)).toBe(false);
        expect(volcanicCover(world, point.x, point.z)).toBeLessThanOrEqual(SPAWNED_AIRPORT_VOLCANIC_COVER_MAX);
      }
    }
    expect(spawned).toBeGreaterThan(0);
  });
});
