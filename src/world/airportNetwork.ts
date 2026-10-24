import { runwayToWorld } from "./airport";
import {
  findAirportSiteForCandidate,
  surveyAirportCandidate,
  type AirportFootprint,
  type AirportSiteLimits,
  type CoarseAirportCandidate,
} from "./airportSite";
import { mixSeed, unitFloatFromHash } from "./seed";
import type { AirportDefinition, RunwayPoint, WorldDefinition } from "./types";

/**
 * The airport network: the home field plus airports spawned as the aircraft
 * flies away from every airport it has.
 *
 * Spawning is a pure function of the world, the aircraft's position and
 * heading, and an attempt counter, so the same flight spawns the same
 * airports. The caller owns the clock: it asks `airportSpawnDue` as it flies,
 * runs `findSpawnedAirport` (a bounded batch of candidate sites per call,
 * cheap enough to spread over frames) until one passes or it returns
 * `"exhausted"`, and installs the result with `withAirports`. A spawned
 * runway passes exactly the site contract the home field does
 * (`findAirportSiteForCandidate`), so it is dry, graded, and has clear
 * 3-degree approaches at both ends.
 */
export const AIRPORT_SPAWN_POLICY = Object.freeze({
  /** A new airport is due once the aircraft is this far from every airport. */
  triggerDistanceMeters: 14_000,
  /**
   * The new airport's distance from the aircraft. Always closer than the
   * airport that was nearest (the trigger distance is larger than the band),
   * but far enough out that it is a destination, not a runway underfoot.
   */
  minDistanceMeters: 5_000,
  maxDistanceMeters: 9_000,
  /**
   * Minimum centre-to-centre spacing between any two airports. Several times
   * the reach of one airport's earthworks (half a runway + safety area +
   * blend distance, about 1 km), so `worldAirportAt` can pick the nearest
   * centre and never has to blend two sites.
   */
  minSeparationMeters: 4_000,
  /**
   * Airports the GPU terrain keeps at once (home field included). Spawning
   * past it retires the oldest spawned airport; the home field always stays.
   */
  maxAirports: 8,
  /**
   * Centres surveyed per spawn (five height probes each, ranked dry, low and
   * gentle first, as the starter search ranks its spiral) ...
   */
  surveyedCandidates: 160,
  /** ... and how many of the best-ranked get the full site assessment per call. */
  assessedPerAttempt: 2,
  /**
   * Candidates are kept out of this half-angle either side of the nose so a
   * runway does not appear in the middle of the view; the sides and the rear
   * arcs are all fair game.
   */
  noseExclusionRadians: Math.PI / 4,
});

/**
 * The spawned runway's site contract. The starter field's envelope
 * (`STARTER_AIRPORT_SITE_LIMITS`) is so strict that most terrain regions have
 * no site at all, which is why the starter search falls back to a catalogue
 * of pre-validated regions; a spawn cannot move the world, so it accepts more
 * cut and fill and steeper natural ground. What it does NOT relax is the part
 * an aircraft depends on: the platform and the ground just short of both
 * thresholds stay dry, and nothing may rise into the 3-degree approach
 * surface at either end, so every spawned runway can be flown straight in
 * from 4 km out in either direction.
 */
export const SPAWNED_AIRPORT_SITE_LIMITS: Readonly<AirportSiteLimits> = Object.freeze({
  dryPlatformClearance: 4,
  maxPlatformRelief: 70,
  maxLongitudinalGrade: 0.2,
  maxCrossGrade: 0.4,
  maxBlendRelief: 140,
  maxAirportElevation: 600,
  blendClearance: 0,
  approachClearance: 0,
  approachObstruction: 0,
  certifiedPlatformClearance: 4,
  certifiedBlendClearance: 0,
  certifiedPlatformRelief: 70,
  certifiedBlendRelief: 140,
  certifiedLongitudinalGrade: 0.2,
  certifiedCrossGrade: 0.4,
  certifiedApproachClearance: 0,
  certifiedApproachObstruction: -2,
});

export interface NearestAirport {
  readonly airport: Readonly<AirportDefinition>;
  /** Index into `world.airports`; 0 is the home field. */
  readonly index: number;
  /** Horizontal distance from the query point to the runway centre, metres. */
  readonly distanceMeters: number;
  /** Direction from the query point to the runway centre, clockwise from north (+z), in [0, 2π). */
  readonly bearingRadians: number;
}

export interface RunwayEnd {
  /** Painted runway number for this direction, "01".."36". */
  readonly designator: string;
  /** Centreline point at the landing threshold, on the runway surface. */
  readonly threshold: RunwayPoint;
  /** Direction of travel when landing on this end, clockwise from north (+z), in [0, 2π). */
  readonly landingHeadingRadians: number;
  /** Runway surface elevation above sea level, metres. */
  readonly elevation: number;
  /** Paved length available from this threshold, metres. */
  readonly length: number;
  readonly width: number;
}

const TWO_PI = Math.PI * 2;

function wrapRadians(angle: number): number {
  const wrapped = angle % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

function horizontalDistanceSquared(
  airport: Readonly<AirportDefinition>,
  x: number,
  z: number,
): number {
  const dx = airport.centerX - x;
  const dz = airport.centerZ - z;
  return dx * dx + dz * dz;
}

/** The airport whose runway centre is nearest a world point, or null in an airport-less world. */
export function nearestAirport(
  world: WorldDefinition,
  x: number,
  z: number,
): NearestAirport | null {
  let index = -1;
  let best = Infinity;
  world.airports.forEach((airport, candidate) => {
    const distanceSquared = horizontalDistanceSquared(airport, x, z);
    if (distanceSquared < best) {
      best = distanceSquared;
      index = candidate;
    }
  });
  const airport = world.airports[index];
  if (!airport) return null;
  return {
    airport,
    index,
    distanceMeters: Math.sqrt(best),
    bearingRadians: wrapRadians(Math.atan2(airport.centerX - x, airport.centerZ - z)),
  };
}

function runwayDesignator(landingHeadingRadians: number): string {
  const number = Math.round((wrapRadians(landingHeadingRadians) * 180) / Math.PI / 10) % 36;
  return String(number === 0 ? 36 : number).padStart(2, "0");
}

/**
 * Both landing directions of an airport's runway. The first end lands along
 * `headingRadians` from the `along = -length / 2` threshold; the second lands
 * the reciprocal way from the opposite threshold.
 */
export function getRunwayEnds(
  airport: Readonly<AirportDefinition>,
): readonly [RunwayEnd, RunwayEnd] {
  const halfLength = airport.runwayLength * 0.5;
  const end = (along: number, landingHeadingRadians: number): RunwayEnd => ({
    designator: runwayDesignator(landingHeadingRadians),
    threshold: runwayToWorld(airport, along, 0),
    landingHeadingRadians: wrapRadians(landingHeadingRadians),
    elevation: airport.elevation,
    length: airport.runwayLength,
    width: airport.runwayWidth,
  });
  return [
    end(-halfLength, airport.headingRadians),
    end(halfLength, airport.headingRadians + Math.PI),
  ];
}

const IDENT_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * A stable four-letter identifier for an airport, derived from its site so a
 * respawned airport keeps its name. Not a real ICAO code.
 */
export function airportDesignator(world: WorldDefinition, airport: Readonly<AirportDefinition>): string {
  let hash = mixSeed(world.seedHash, 0x41_49);
  hash = mixSeed(hash, Math.round(airport.centerX));
  hash = mixSeed(hash, Math.round(airport.centerZ));
  let ident = "";
  for (let letter = 0; letter < 4; letter += 1) {
    hash = mixSeed(hash, letter + 1);
    ident += IDENT_LETTERS[Math.floor(unitFloatFromHash(hash) * IDENT_LETTERS.length)] ?? "X";
  }
  return ident;
}

/** True once the aircraft is far enough from every airport that a new one should spawn. */
export function airportSpawnDue(world: WorldDefinition, x: number, z: number): boolean {
  if (!world.airport) return false;
  const nearest = nearestAirport(world, x, z);
  return nearest !== null && nearest.distanceMeters > AIRPORT_SPAWN_POLICY.triggerDistanceMeters;
}

function footprintOf(airport: Readonly<AirportDefinition>): AirportFootprint {
  return {
    runwayLength: airport.runwayLength,
    runwayWidth: airport.runwayWidth,
    endSafetyArea: airport.endSafetyArea,
    shoulderWidth: airport.shoulderWidth,
    terrainBlendDistance: airport.terrainBlendDistance,
  };
}

interface SpawnSurvey {
  readonly key: string;
  readonly ranked: readonly CoarseAirportCandidate[];
}

/** The last survey: one spawn search re-reads it on every attempt. */
let lastSpawnSurvey: SpawnSurvey | null = null;

function spawnSurvey(
  world: WorldDefinition,
  x: number,
  z: number,
  headingRadians: number,
): readonly CoarseAirportCandidate[] {
  const key = [world.seedHash, world.seaLevel, world.airports.length, x, z, headingRadians].join(":");
  if (lastSpawnSurvey?.key === key) return lastSpawnSurvey.ranked;
  const policy = AIRPORT_SPAWN_POLICY;
  const nearest = nearestAirport(world, x, z);
  // A fresh stream per spawn (the airport count), so the second spawn from
  // the same place does not re-survey the first's ground.
  const stream = mixSeed(world.seedHash, 0x41_53 + world.airports.length);
  const arc = TWO_PI - policy.noseExclusionRadians * 2;
  const separation = policy.minSeparationMeters * policy.minSeparationMeters;
  const surveyed: CoarseAirportCandidate[] = [];
  for (let candidate = 0; candidate < policy.surveyedCandidates; candidate += 1) {
    const hash = mixSeed(stream, candidate);
    const bearing = headingRadians + policy.noseExclusionRadians
      + unitFloatFromHash(mixSeed(hash, 1)) * arc;
    // Uniform in AREA over the band, not in radius.
    const inner = policy.minDistanceMeters * policy.minDistanceMeters;
    const outer = policy.maxDistanceMeters * policy.maxDistanceMeters;
    const distance = Math.sqrt(inner + unitFloatFromHash(mixSeed(hash, 2)) * (outer - inner));
    if (nearest && distance >= nearest.distanceMeters) continue;
    const centerX = x + Math.sin(bearing) * distance;
    const centerZ = z + Math.cos(bearing) * distance;
    if (world.airports.some((airport) => horizontalDistanceSquared(airport, centerX, centerZ) < separation)) {
      continue;
    }
    surveyed.push(surveyAirportCandidate(world.seedHash, world.seaLevel, centerX, centerZ));
  }
  surveyed.sort((left, right) => left.score - right.score);
  lastSpawnSurvey = { key, ranked: surveyed };
  return surveyed;
}

/**
 * One bounded step of the spawn search around an ANCHOR: the aircraft's
 * position and heading when the spawn fell due, held fixed for the whole
 * search so every attempt reads the same survey. Attempt `n` gives the full
 * site assessment to the `n`-th batch of the best-ranked surveyed centres;
 * the first runway that passes is returned. `"exhausted"` means no surveyed
 * centre passed, and the caller should re-anchor where the aircraft is now.
 * Deterministic in (world, anchor, attempt).
 */
export function findSpawnedAirport(
  world: WorldDefinition,
  x: number,
  z: number,
  headingRadians: number,
  attempt: number,
): Readonly<AirportDefinition> | null | "exhausted" {
  const home = world.airport;
  if (!home) return "exhausted";
  const ranked = spawnSurvey(world, x, z, headingRadians);
  const batch = AIRPORT_SPAWN_POLICY.assessedPerAttempt;
  const first = Math.max(0, Math.floor(attempt)) * batch;
  if (first >= ranked.length) return "exhausted";
  const footprint = footprintOf(home);
  for (const candidate of ranked.slice(first, first + batch)) {
    const site = findAirportSiteForCandidate(
      world.seedHash,
      world.seaLevel,
      footprint,
      world.prevailingWindRadians,
      candidate,
      SPAWNED_AIRPORT_SITE_LIMITS,
    );
    if (!site) continue;
    return Object.freeze({
      ...footprint,
      centerX: site.centerX,
      centerZ: site.centerZ,
      headingRadians: site.headingRadians,
      // The home field's datum rule (`createWorld`'s buildAirport).
      elevation: Math.max(world.seaLevel + 10, Math.round(site.assessment.elevation * 4) / 4),
    });
  }
  return null;
}

function sameAirport(left: Readonly<AirportDefinition>, right: Readonly<AirportDefinition>): boolean {
  return left.centerX === right.centerX
    && left.centerZ === right.centerZ
    && left.headingRadians === right.headingRadians
    && left.elevation === right.elevation
    && left.runwayLength === right.runwayLength
    && left.runwayWidth === right.runwayWidth;
}

/**
 * The world with a new airport list. `airports[0]` must be the home field;
 * past `maxAirports` the oldest spawned airports are retired so the list
 * always fits the GPU terrain's slots. Returns the same world when nothing
 * changed, so callers can compare by identity.
 */
export function withAirports(
  world: WorldDefinition,
  airports: readonly Readonly<AirportDefinition>[],
): WorldDefinition {
  const home = world.airport;
  if (!home) {
    if (airports.length > 0) throw new Error("A world without a home field cannot gain airports");
    return world;
  }
  const first = airports[0];
  if (!first || !sameAirport(first, home)) {
    throw new Error("airports[0] must be the world's home field");
  }
  const spawned = airports.slice(1).slice(-(AIRPORT_SPAWN_POLICY.maxAirports - 1));
  const next = [home, ...spawned.map((airport) => Object.freeze({ ...airport }))];
  if (
    next.length === world.airports.length
    && next.every((airport, index) => sameAirport(airport, world.airports[index]!))
  ) {
    return world;
  }
  return Object.freeze({ ...world, airports: Object.freeze(next) });
}
