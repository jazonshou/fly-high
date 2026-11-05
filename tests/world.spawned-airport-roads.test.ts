import { afterEach, describe, expect, it } from "vitest";
import {
  airportPlatformDistanceToSegment,
  getAirportInfluence,
  roundedRectangleSignedDistance,
  runwayToWorld,
  segmentReachesAirportEarthworks,
  worldToRunway,
} from "@/src/world/airport";
import { findSpawnedAirport, withAirports } from "@/src/world/airportNetwork";
import {
  changeInfrastructureRegions,
  clearInfrastructureRegions,
  infrastructureIndex,
  sampleInfrastructureSurface,
  type InfrastructureRail,
  type InfrastructureRegion,
  type InfrastructureSurfaceSample,
} from "@/src/world/infrastructure";
import { ROAD_CLASS, roadClass, roadFormationHalfWidth } from "@/src/world/roads/roadClasses";
import { roadPieceKey, roadRegionInfrastructure } from "@/src/world/roads/roadInfrastructure";
import {
  airportEarthworksBox,
  clipRoadRegionForAirports,
  roadRegionClipKey,
  roadsVetoAirport,
  type RoadRegionContent,
} from "@/src/world/roads/roadAirports";
import { roadNetworkFor, roadRegionOf, type RoadLayer } from "@/src/world/roads/roadNetwork";
import type { AirportDefinition, WorldDefinition } from "@/src/world/types";
import { createWorld } from "@/src/world/world";

/**
 * Spawned airports and the roads (`roadAirports.ts`): a gravel or sealed
 * road refuses a spawned field whose earthworks it would reach, and a track
 * a spawned field overruns is clipped where it would reach them. Both rest
 * on one test, a capsule against the platform grown by its blend, held here
 * to a brute-force oracle and to the influence's own support.
 */

afterEach(() => clearInfrastructureRegions());

const world = createWorld();
const home = world.airport!;

/** A field with the home footprint, centred and headed as asked. */
function fieldAt(x: number, z: number, headingRadians = home.headingRadians): Readonly<AirportDefinition> {
  return Object.freeze({ ...home, centerX: x, centerZ: z, headingRadians });
}

/** Runs one anchored spawn search to completion, as the spawn worker does (with the roads' veto). */
function spawnFrom(
  from: WorldDefinition,
  x: number,
  z: number,
  heading: number,
  veto?: (world: WorldDefinition, airport: Readonly<AirportDefinition>) => boolean,
): Readonly<AirportDefinition> | null {
  for (let attempt = 0; ; attempt += 1) {
    const result = findSpawnedAirport(from, x, z, heading, attempt, veto);
    if (result === "exhausted") return null;
    if (result) return result;
  }
}

/**
 * The open-skies field spawned flying west 15 km west of home: a field the
 * veto lets through, three track regions of which it overruns.
 */
let westField: Readonly<AirportDefinition> | null = null;
function spawnedWestField(): Readonly<AirportDefinition> {
  westField ??= spawnFrom(world, home.centerX - 15_000, home.centerZ, 1.5 * Math.PI, roadsVetoAirport);
  if (!westField) throw new Error("the west spawn search found no airport");
  return westField;
}

/** Every region of a layer whose square comes within a region of the field's earthworks, as the roads worker lays it out. */
function regionsRound(airport: Readonly<AirportDefinition>, layer: RoadLayer): RoadRegionContent[] {
  const network = roadNetworkFor(world);
  const box = airportEarthworksBox(airport);
  const regions: RoadRegionContent[] = [];
  for (let rx = roadRegionOf(box.minX) - 1; rx <= roadRegionOf(box.maxX) + 1; rx += 1) {
    for (let rz = roadRegionOf(box.minZ) - 1; rz <= roadRegionOf(box.maxZ) + 1; rz += 1) {
      const region = network.region(layer, rx, rz);
      regions.push({ infrastructure: roadRegionInfrastructure(network, region), pieces: region.pieces, pads: region.pads });
    }
  }
  return regions;
}

/** A small deterministic generator for the sweeps. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

describe("a capsule against a field's earthworks", () => {
  const field = fieldAt(1_000, -2_000, 0.917);
  const halfLength = field.runwayLength * 0.5 + field.endSafetyArea;
  const halfWidth = field.runwayWidth * 0.5 + field.shoulderWidth;

  it("measures a segment's distance to the platform, held to a dense walk along it", () => {
    const next = random(7);
    let crossings = 0;
    for (let trial = 0; trial < 400; trial += 1) {
      const a = runwayToWorld(field, (next() - 0.5) * 4_000, (next() - 0.5) * 1_600);
      const b = runwayToWorld(field, (next() - 0.5) * 4_000, (next() - 0.5) * 1_600);
      const exact = airportPlatformDistanceToSegment(field, a.x, a.z, b.x, b.z);
      const steps = 4_000;
      let walked = Infinity;
      for (let k = 0; k <= steps; k += 1) {
        const t = k / steps;
        const local = worldToRunway(field, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
        walked = Math.min(walked, Math.max(0, roundedRectangleSignedDistance(local.along, local.across, halfLength, halfWidth)));
      }
      const step = Math.hypot(b.x - a.x, b.z - a.z) / steps;
      // Never more than the walk finds, and never less by more than the walk's step.
      expect(exact).toBeLessThanOrEqual(walked + 1e-6);
      expect(walked - exact).toBeLessThanOrEqual(step + 1e-6);
      if (exact === 0) crossings += 1;
    }
    expect(crossings).toBeGreaterThan(40);
    expect(crossings).toBeLessThan(360);
  });

  it("reaches exactly as far as the influence: the platform grown by its blend", () => {
    // Out from the side of the platform, and out past a corner.
    const blend = field.terrainBlendDistance;
    for (const [along, across] of [[0, halfWidth], [halfLength, halfWidth], [-halfLength, 0]] as const) {
      const length = Math.hypot(along, across);
      const unit = length > 0 && along !== 0 && across !== 0
        ? [along / length, across / length]
        : along !== 0 ? [Math.sign(along), 0] : [0, Math.sign(across)];
      const point = (distance: number) => runwayToWorld(field, along + unit[0]! * distance, across + unit[1]! * distance);
      const inside = point(blend - 0.05);
      const outside = point(blend + 0.05);
      expect(getAirportInfluence(field, inside.x, inside.z)).toBeGreaterThan(0);
      expect(segmentReachesAirportEarthworks(field, inside.x, inside.z, inside.x, inside.z)).toBe(true);
      expect(getAirportInfluence(field, outside.x, outside.z)).toBe(0);
      expect(segmentReachesAirportEarthworks(field, outside.x, outside.z, outside.x, outside.z)).toBe(false);
      // A capsule's radius stands in for the distance it covers.
      const far = point(blend + 30);
      expect(segmentReachesAirportEarthworks(field, far.x, far.z, far.x, far.z, 29.9)).toBe(false);
      expect(segmentReachesAirportEarthworks(field, far.x, far.z, far.x, far.z, 30.1)).toBe(true);
    }
  });
});

describe("the roads' veto on a spawned field", () => {
  it("refuses a field across a gravel road, and one across the sealed road", () => {
    const network = roadNetworkFor(world);
    const near = { minX: home.centerX - 12_000, minZ: home.centerZ - 12_000, maxX: home.centerX + 12_000, maxZ: home.centerZ + 12_000 };
    const gravel = network.edgesNear(ROAD_CLASS.gravel, near).map((edge) => network.geometry(edge)).find((geometry) => geometry !== null);
    expect(gravel).toBeDefined();
    const middle = gravel!.pieces[Math.floor(gravel!.pieces.length / 2)]!;
    expect(roadsVetoAirport(world, fieldAt(0.5 * (middle.ax + middle.bx), 0.5 * (middle.az + middle.bz)))).toBe(true);

    // The sealed road, where no gravel road comes near: only it can refuse a field there. A
    // strip a few metres across, so it fits where the gravel roads keep their distance.
    const sealed = network.geometry(network.airportEdge()!)!;
    const spec = roadClass(ROAD_CLASS.gravel);
    const gravelReaches = (field: Readonly<AirportDefinition>) =>
      network.edgesNear(ROAD_CLASS.gravel, airportEarthworksBox(field)).some((edge) =>
        [edge.a, edge.b].some((node) => segmentReachesAirportEarthworks(field, node.x, node.z, node.x, node.z, 100))
        || (network.geometry(edge)?.pieces.some((piece) => segmentReachesAirportEarthworks(
          field, piece.ax, piece.az, piece.bx, piece.bz, roadFormationHalfWidth(spec) + spec.reach + 10)) ?? false));
    const alone = sealed.pieces
      .filter((piece) => Math.hypot(piece.ax - home.centerX, piece.az - home.centerZ) > 400)
      .map((piece) => Object.freeze({
        ...home,
        centerX: piece.ax,
        centerZ: piece.az,
        runwayLength: 20,
        endSafetyArea: 0,
        runwayWidth: 4,
        shoulderWidth: 0,
        terrainBlendDistance: 1,
      }))
      .find((field) => !gravelReaches(field));
    expect(alone).toBeDefined();
    expect(roadsVetoAirport(world, alone!)).toBe(true);
  });

  it("passes a field no gravel or sealed road reaches, as the roads worker lays them out", () => {
    const field = spawnedWestField();
    expect(roadsVetoAirport(world, field)).toBe(false);
    // The major layer's stage segments round it, every one: none reaches the earthworks.
    let segments = 0;
    for (const region of regionsRound(field, "major")) {
      for (const segment of region.infrastructure.segments) {
        segments += 1;
        expect(segmentReachesAirportEarthworks(
          field, segment.ax, segment.az, segment.bx, segment.bz, segment.halfWidth + segment.reach,
        )).toBe(false);
      }
    }
    expect(segments).toBeGreaterThan(0);
  });

  it("refuses nothing in an eroded world, which has no roads", () => {
    const eroded = createWorld(undefined, { worldEvolution: "eroded" });
    const network = roadNetworkFor(world);
    const near = { minX: home.centerX - 12_000, minZ: home.centerZ - 12_000, maxX: home.centerX + 12_000, maxZ: home.centerZ + 12_000 };
    const gravel = network.edgesNear(ROAD_CLASS.gravel, near).map((edge) => network.geometry(edge)).find((geometry) => geometry !== null)!;
    const middle = gravel.pieces[Math.floor(gravel.pieces.length / 2)]!;
    expect(roadsVetoAirport(eroded, fieldAt(0.5 * (middle.ax + middle.bx), 0.5 * (middle.az + middle.bz)))).toBe(false);
  });

  it("is the spawn search's last word: a site it refuses gives way to the next that passes", () => {
    const from = { x: home.centerX - 15_000, z: home.centerZ, heading: 1.5 * Math.PI };
    const plain = spawnFrom(world, from.x, from.z, from.heading)!;
    const refused: Readonly<AirportDefinition>[] = [];
    const refuseFirst = (_world: WorldDefinition, airport: Readonly<AirportDefinition>) => {
      refused.push(airport);
      return refused.length === 1;
    };
    const next = spawnFrom(world, from.x, from.z, from.heading, refuseFirst)!;
    expect(refused[0]).toEqual(plain);
    expect(next).not.toEqual(plain);
    expect(next).toEqual(refused[1]);
    // Left out, the search is the one it always was.
    expect(spawnFrom(world, from.x, from.z, from.heading)).toEqual(plain);
  });
});

describe("a track a spawned field overruns", () => {
  it("is clipped where it reaches the earthworks: its segments, pieces and pads, under a key of its own", () => {
    const field = spawnedWestField();
    let clipped = 0;
    for (const region of regionsRound(field, "track")) {
      const out = clipRoadRegionForAirports(region, [field]);
      const segments = region.infrastructure.segments;
      const reaches = segments.map((segment) => segmentReachesAirportEarthworks(
        field, segment.ax, segment.az, segment.bx, segment.bz, segment.halfWidth + segment.reach,
      ));
      if (!reaches.includes(true)) {
        // Untouched: the region itself, under its own key.
        expect(out).toBe(region);
        continue;
      }
      clipped += 1;
      expect(out.infrastructure.key).toBe(roadRegionClipKey(region.infrastructure.key, [field]));
      expect(out.infrastructure.key).toMatch(/^roads:track:-?\d+:-?\d+~[0-9a-f]{8}$/);
      expect(out.infrastructure.segments).toEqual(segments.filter((_, index) => !reaches[index]));
      const kept = new Set(out.infrastructure.segments.map((segment) => segment.key));
      expect(out.pieces).toEqual(region.pieces.filter((piece, index) => !reaches[index] && kept.has(roadPieceKey(piece))));
      const padStart = segments.length - region.pads.length;
      expect(out.pads).toEqual(region.pads.filter((_, index) => !reaches[padStart + index]));
      expect(out.pieces.length).toBeLessThan(region.pieces.length);
    }
    expect(clipped).toBeGreaterThanOrEqual(1);
  });

  it("leaves no surface on the field and its blend, and keeps the track's paint outside", () => {
    const field = spawnedWestField();
    const spawnedWorld = withAirports(world, [home, field]);
    const regions = regionsRound(field, "track");
    const sample: InfrastructureSurfaceSample = { surface: null, coverage: 0 };
    // The track's painted core, sampled along every piece that reaches the field.
    const painted = (installed: readonly InfrastructureRegion[]) => {
      clearInfrastructureRegions();
      changeInfrastructureRegions(spawnedWorld, installed);
      const index = infrastructureIndex(spawnedWorld);
      let inside = 0;
      let outside = 0;
      for (const region of regions) {
        for (const segment of region.infrastructure.segments) {
          if (!segment.surface) continue;
          for (let k = 0; k <= 4; k += 1) {
            const x = segment.ax + ((segment.bx - segment.ax) * k) / 4;
            const z = segment.az + ((segment.bz - segment.az) * k) / 4;
            if (sampleInfrastructureSurface(index, x, z, sample).surface === null) continue;
            if (getAirportInfluence(field, x, z) > 0) inside += 1;
            else outside += 1;
          }
        }
      }
      return { inside, outside };
    };
    const whole = painted(regions.map((region) => region.infrastructure));
    expect(whole.inside).toBeGreaterThan(0);
    const clipped = painted(regions.map((region) => clipRoadRegionForAirports(region, [field]).infrastructure));
    expect(clipped.inside).toBe(0);
    expect(clipped.outside).toBeGreaterThan(0);
    // Everything that painted clear of the field still does, bar the pieces whose batters reach its blend.
    expect(clipped.outside).toBeGreaterThan(0.9 * whole.outside);
  });

  it("keys the clip by the airports that clipped it", () => {
    const field = spawnedWestField();
    const other = fieldAt(field.centerX + 1, field.centerZ);
    const key = "roads:track:1:4";
    expect(roadRegionClipKey(key, [])).toBe(key);
    expect(roadRegionClipKey(key, [field])).toBe(roadRegionClipKey(key, [{ ...field }]));
    expect(roadRegionClipKey(key, [field])).not.toBe(roadRegionClipKey(key, [other]));
    expect(roadRegionClipKey(key, [field, other])).not.toBe(roadRegionClipKey(key, [field]));
  });

  it("cuts a guardrail where it would cross the earthworks, keeping each run's side", () => {
    const field = fieldAt(0, 0, 0);
    const halfLength = field.runwayLength * 0.5 + field.endSafetyArea + field.terrainBlendDistance;
    // Along z through the field, past both ends: the rail's side vector is fixed by its direction.
    const points: number[] = [];
    for (let z = -halfLength - 300; z <= halfLength + 300; z += 25) points.push(400, z);
    const rail: InfrastructureRail = { points, heightMeters: 0.75 };
    const region: RoadRegionContent = {
      infrastructure: { key: "roads:major:0:0", segments: [], rails: [rail] },
      pieces: [],
      pads: [],
    };
    // 400 m across is past the blend (31 + 240): untouched.
    expect(clipRoadRegionForAirports(region, [field])).toBe(region);
    const through = { ...region, infrastructure: { ...region.infrastructure, rails: [{ ...rail, points: points.map((value, index) => (index % 2 === 0 ? 100 : value)) }] } };
    const out = clipRoadRegionForAirports(through, [field]);
    const runs = out.infrastructure.rails!;
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.heightMeters).toBe(0.75);
      for (let k = 0; k + 3 < run.points.length; k += 2) {
        expect(segmentReachesAirportEarthworks(field, run.points[k]!, run.points[k + 1]!, run.points[k + 2]!, run.points[k + 3]!, 1)).toBe(false);
        // Still running +z, as the whole rail did.
        expect(run.points[k + 3]!).toBeGreaterThan(run.points[k + 1]!);
      }
    }
    expect(runs[0]!.points[runs[0]!.points.length - 1]!).toBeLessThan(-halfLength + 100);
    expect(runs[1]!.points[1]!).toBeGreaterThan(halfLength - 100);
  });

  it("refuses a region not laid out a segment per piece, then per pad", () => {
    const field = spawnedWestField();
    const region = regionsRound(field, "track").find((candidate) =>
      clipRoadRegionForAirports(candidate, [field]) !== candidate && candidate.pieces.length > 1)!;
    const shuffled = { ...region, pieces: [...region.pieces.slice(1), region.pieces[0]!] };
    expect(() => clipRoadRegionForAirports(shuffled, [field])).toThrow(/not its piece's/);
  });
});
