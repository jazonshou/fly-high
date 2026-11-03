import { describe, expect, it } from "vitest";
import { createWorld, type WorldDefinition } from "@/src/world";
import {
  relaxRoadPolyline,
  roadTightestRadius,
  roadVerticalProfile,
} from "@/src/world/roads/roadAlignment";
import { ROAD_CLASS, ROAD_CLASSES, roadClass } from "@/src/world/roads/roadClasses";
import { pointSegmentDistance, roadRouteDeviationBound, type RoadBox } from "@/src/world/roads/roadGraph";
import {
  ROAD_AIRPORT_LEAD_STRAIGHT,
  RoadNetwork,
  roadRegionBox,
  roadRegionOf,
  type RoadGeometry,
  type RoadLayer,
  type RoadRegion,
} from "@/src/world/roads/roadNetwork";
import { airportRoadHead } from "@/src/world/roads/roadNodes";
import { routeRoadEdge } from "@/src/world/roads/roadRouting";
import { RoadGround, roadGroundAt, roadGroundHeight } from "@/src/world/roads/roadTerrain";

/**
 * The headless road network (plan phase R1): every road is a pure function of
 * its edge and the world, so any region comes out the same whichever was
 * generated first; every road keeps to its class's grade, curve and earthwork
 * limits, out of the sea and the airport, and inside the corridor bound a
 * spawned airport's veto relies on.
 */

interface Probe {
  readonly world: WorldDefinition;
  readonly network: RoadNetwork;
  readonly regions: readonly (readonly [RoadLayer, number, number])[];
  readonly built: readonly RoadRegion[];
  /** Every road whose edge can reach the probed regions, a margin beyond. */
  readonly roads: readonly RoadGeometry[];
}

/** 3 x 3 regions of each layer round the road head. */
function probe(world: WorldDefinition): Probe {
  const head = airportRoadHead(world)!;
  const cx = roadRegionOf(head.startX);
  const cz = roadRegionOf(head.startZ);
  const regions: [RoadLayer, number, number][] = [];
  for (const layer of ["major", "track"] as const) {
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) regions.push([layer, cx + dx, cz + dz]);
    }
  }
  const network = new RoadNetwork(world);
  const built = regions.map(([layer, rx, rz]) => network.region(layer, rx, rz));
  const box = {
    minX: roadRegionBox(cx - 1, cz - 1).minX,
    minZ: roadRegionBox(cx - 1, cz - 1).minZ,
    maxX: roadRegionBox(cx + 1, cz + 1).maxX,
    maxZ: roadRegionBox(cx + 1, cz + 1).maxZ,
  };
  const roads: RoadGeometry[] = [];
  for (const spec of ROAD_CLASSES) {
    for (const edge of network.edgesNear(spec.id, box, 4_000)) {
      const road = network.geometry(edge);
      if (road) roads.push(road);
    }
  }
  return { world, network, regions, built, roads };
}

/** Building a probe's network takes seconds; a slower runner needs room. */
const HEAVY = 120_000;

const PROBES = new Map<string, Probe>();
function probed(seed?: string | number): Probe {
  const key = String(seed ?? "default");
  let found = PROBES.get(key);
  if (!found) {
    found = probe(seed === undefined ? createWorld() : createWorld(seed));
    PROBES.set(key, found);
  }
  return found;
}

/** A fixed shuffle (xorshift), so a failure reproduces. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const j = (state >>> 0) % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function inBox(x: number, z: number, box: RoadBox): boolean {
  return x >= box.minX && x < box.maxX && z >= box.minZ && z < box.maxZ;
}

describe("road network regions", { timeout: HEAVY }, () => {
  it("come out the same whichever region is generated first", () => {
    const { world, regions, built } = probed();
    expect(built.some((region) => region.pieces.length > 0)).toBe(true);
    for (const seed of [0x9e37_79b9]) {
      const network = new RoadNetwork(world);
      const order = shuffled(regions.map((_, index) => index), seed);
      const again: RoadRegion[] = [];
      for (const index of order) {
        const [layer, rx, rz] = regions[index]!;
        again[index] = network.region(layer, rx, rz);
      }
      expect(again).toEqual(built);
    }
    // A track region alone, on a network that has built nothing else.
    const lone = regions.findIndex(([layer], index) => layer === "track" && built[index]!.pieces.length > 0);
    const [layer, rx, rz] = regions[lone]!;
    expect(new RoadNetwork(world).region(layer, rx, rz)).toEqual(built[lone]);
  });

  it("hold every piece of every road once, in the region its midpoint lies in", () => {
    const { regions, built, roads } = probed();
    for (let index = 0; index < regions.length; index += 1) {
      const [layer, rx, rz] = regions[index]!;
      const box = roadRegionBox(rx, rz);
      const classes: readonly number[] = layer === "major" ? [ROAD_CLASS.gravel, ROAD_CLASS.airport] : [ROAD_CLASS.track];
      const expected = new Set<string>();
      for (const road of roads) {
        if (!classes.includes(road.edge.classId)) continue;
        for (const piece of road.pieces) {
          if (inBox(0.5 * (piece.ax + piece.bx), 0.5 * (piece.az + piece.bz), box)) expected.add(`${piece.edgeId}:${piece.index}`);
        }
      }
      const held = built[index]!.pieces.map((piece) => `${piece.edgeId}:${piece.index}`);
      expect(new Set(held).size).toBe(held.length);
      expect(new Set(held)).toEqual(expected);
    }
  });

  it("list pieces in composition order: class, then edge id, then index", () => {
    const { built } = probed();
    for (const region of built) {
      for (let k = 1; k < region.pieces.length; k += 1) {
        const left = region.pieces[k - 1]!;
        const right = region.pieces[k]!;
        const order = roadClass(left.classId).priority - roadClass(right.classId).priority
          || (left.edgeId >>> 0) - (right.edgeId >>> 0)
          || left.index - right.index;
        expect(order).toBeLessThan(0);
      }
    }
  });
});

describe("roads", { timeout: HEAVY }, () => {
  for (const seed of [undefined, 7, "alpine"] as const) {
    describe(`seed ${String(seed ?? "default")}`, () => {
      it("keep to their class's grade, curvature and earthwork limits", () => {
        const { roads } = probed(seed);
        expect(roads.length).toBeGreaterThan(0);
        for (const road of roads) {
          const spec = roadClass(road.edge.classId);
          const n = road.x.length;
          expect(road.stats.maxFill).toBeLessThanOrEqual(spec.maxFill + 1e-9);
          expect(road.stats.maxCut).toBeLessThanOrEqual(spec.maxCut + 1e-9);
          let steepest = 0;
          for (let k = 0; k < n; k += 1) {
            const fill = road.height[k]! - road.ground[k]!;
            expect(fill).toBeLessThanOrEqual(spec.maxFill + 1e-9);
            expect(-fill).toBeLessThanOrEqual(spec.maxCut + 1e-9);
            expect(Math.abs(road.curvature[k]!)).toBeLessThanOrEqual(1 / roadTightestRadius(spec) + 1e-9);
            if (k + 1 < n) {
              const run = road.station[k + 1]! - road.station[k]!;
              steepest = Math.max(steepest, Math.abs(road.height[k + 1]! - road.height[k]!) / run);
            }
          }
          expect(steepest).toBeLessThanOrEqual(spec.pitchGrade + 1e-9);
          // Only an edge whose band forced it takes a pitch steeper than the class's grade.
          if (!road.stats.gradeRelaxed) expect(steepest).toBeLessThanOrEqual(spec.maxGrade + 1e-9);
        }
      });

      it("stay out of the sea and the home airport (the sealed road's lead-out aside)", () => {
        const { world, roads } = probed(seed);
        const head = airportRoadHead(world)!;
        const lead = Math.hypot(head.exitX - head.startX, head.exitZ - head.startZ);
        for (const road of roads) {
          const airport = road.edge.classId === ROAD_CLASS.airport;
          for (let k = 0; k < road.x.length; k += 1) {
            if (airport && road.station[k]! < lead) continue;
            const x = road.x[k]!;
            const z = road.z[k]!;
            expect(road.ground[k]).toBe(roadGroundHeight(world, x, z));
            const ground = roadGroundAt(world, x, z, road.ground[k]!);
            expect(ground === RoadGround.water || ground === RoadGround.airport).toBe(false);
          }
        }
      });

      it("run from node to node, their pieces a chain through the profile", () => {
        const { world, roads } = probed(seed);
        const head = airportRoadHead(world)!;
        for (const road of roads) {
          const n = road.x.length;
          const startX = road.edge.classId === ROAD_CLASS.airport ? head.startX : road.edge.a.x;
          const startZ = road.edge.classId === ROAD_CLASS.airport ? head.startZ : road.edge.a.z;
          expect(Math.hypot(road.x[0]! - startX, road.z[0]! - startZ)).toBeLessThan(1e-6);
          expect(Math.hypot(road.x[n - 1]! - road.edge.b.x, road.z[n - 1]! - road.edge.b.z)).toBeLessThan(1e-6);
          expect(road.height[0]).toBe(road.edge.a.height);
          expect(road.height[n - 1]).toBe(road.edge.b.height);
          const pieces = road.pieces;
          expect(pieces[0]!.ax).toBe(road.x[0]);
          expect(pieces[0]!.ha).toBe(road.height[0]);
          expect(pieces[pieces.length - 1]!.bx).toBe(road.x[n - 1]);
          expect(pieces[pieces.length - 1]!.hb).toBe(road.height[n - 1]);
          for (let k = 0; k < pieces.length; k += 1) {
            expect(pieces[k]!.index).toBe(k);
            if (k > 0) {
              expect(pieces[k]!.ax).toBe(pieces[k - 1]!.bx);
              expect(pieces[k]!.az).toBe(pieces[k - 1]!.bz);
              expect(pieces[k]!.ha).toBe(pieces[k - 1]!.hb);
            }
          }
        }
      });

      it("lie inside their edge's corridor bound, route and road alike", () => {
        const { world, roads } = probed(seed);
        const head = airportRoadHead(world)!;
        let checked = 0;
        for (const road of roads) {
          const edge = road.edge;
          const airport = edge.classId === ROAD_CLASS.airport;
          const ax = airport ? head.exitX : edge.a.x;
          const az = airport ? head.exitZ : edge.a.z;
          const lead = airport ? Math.hypot(head.exitX - head.startX, head.exitZ - head.startZ) : 0;
          const bound = roadRouteDeviationBound(edge);
          for (let k = 0; k < road.x.length; k += 1) {
            if (road.station[k]! < lead) continue;
            expect(pointSegmentDistance(road.x[k]!, road.z[k]!, ax, az, edge.b.x, edge.b.z)).toBeLessThanOrEqual(bound);
          }
          // The refined A* route itself (first attempt), every few roads.
          if (checked % 4 === 0) {
            const route = routeRoadEdge({
              world, spec: roadClass(edge.classId), ax, az, bx: edge.b.x, bz: edge.b.z, corridor: edge.corridor,
            })!;
            for (let k = 0; k < route.x.length; k += 1) {
              expect(pointSegmentDistance(route.x[k]!, route.z[k]!, ax, az, edge.b.x, edge.b.z)).toBeLessThanOrEqual(bound);
            }
          }
          checked += 1;
        }
      });
    });
  }

  it("take the height of a road they cross that outranks them", () => {
    const { roads } = probed();
    const crossing = roads.filter((road) => road.stats.crossings > 0);
    expect(crossing.length).toBeGreaterThan(0);
    for (const road of crossing) {
      const spec = roadClass(road.edge.classId);
      for (const other of roads) {
        if (other === road) continue;
        const outranks = other.edge.classId > road.edge.classId
          || (other.edge.classId === road.edge.classId && other.edge.id > road.edge.id);
        if (!outranks) continue;
        const nodes = [other.edge.a.key, other.edge.b.key];
        if (nodes.includes(road.edge.a.key) || nodes.includes(road.edge.b.key)) continue;
        for (let k = 0; k < road.x.length; k += 1) {
          for (let m = 0; m < other.x.length; m += 1) {
            if (Math.hypot(road.x[k]! - other.x[m]!, road.z[k]! - other.z[m]!) > 1) continue;
            // Within a metre of the crossing, the pin's sample is at most a step away.
            expect(Math.abs(road.height[k]! - other.height[m]!)).toBeLessThanOrEqual(spec.pitchGrade * 6 + 0.5);
          }
        }
      }
    }
  });

  it("include the sealed road, straight out from the airport's road head", () => {
    const { world, network } = probed();
    const head = airportRoadHead(world)!;
    const edge = network.airportEdge();
    expect(edge).not.toBeNull();
    const road = network.geometry(edge!)!;
    for (let k = 0; k < road.x.length && road.station[k]! <= ROAD_AIRPORT_LEAD_STRAIGHT; k += 1) {
      expect(pointSegmentDistance(road.x[k]!, road.z[k]!, head.startX, head.startZ, head.exitX, head.exitZ)).toBeLessThan(1e-6);
    }
  });
});

describe("road vertical profile", () => {
  const station = Float64Array.from({ length: 201 }, (_, k) => k * 5);
  /** A 60 m crest over 300 m: too steep for 12% without a deep cut. */
  const crest = Float64Array.from(station, (s) => 60 * Math.exp(-(((s - 500) / 120) ** 2)));

  it("keeps within the fill and cut limits by steepening only where it must", () => {
    const profile = roadVerticalProfile({
      ground: crest,
      station,
      pins: [{ station: 0, height: crest[0]! }, { station: 1_000, height: crest[200]! }],
      grades: new Float64Array(200).fill(0.12),
      pitchGrade: 0.5,
      smoothingMeters: 90,
      maxFill: 12,
      maxCut: 14,
    });
    expect(profile.feasible).toBe(true);
    expect(profile.gradeRelaxed).toBe(true);
    expect(profile.maxFill).toBeLessThanOrEqual(12 + 1e-9);
    expect(profile.maxCut).toBeLessThanOrEqual(14 + 1e-9);
    expect(profile.maxGrade).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(profile.height[0]).toBe(crest[0]);
    expect(profile.height[200]).toBe(crest[200]);
    // The first 150 m are flat ground far from the crest: no pitch there.
    for (let k = 0; k < 30; k += 1) expect(Math.abs(profile.height[k + 1]! - profile.height[k]!) / 5).toBeLessThanOrEqual(0.12 + 1e-9);
  });

  it("reports where no profile fits", () => {
    const profile = roadVerticalProfile({
      ground: crest,
      station,
      pins: [{ station: 0, height: crest[0]! }, { station: 1_000, height: crest[200]! }],
      grades: new Float64Array(200).fill(0.12),
      pitchGrade: 0.16,
      smoothingMeters: 90,
      maxFill: 12,
      maxCut: 14,
    });
    expect(profile.feasible).toBe(false);
    expect(profile.infeasible.length).toBeGreaterThan(0);
    for (const k of profile.infeasible) expect(Math.abs(station[k]! - 500)).toBeLessThan(300);
  });
});

describe("road route relaxation", () => {
  it("keeps the ends and moves no point further than it may", () => {
    // A staircase: the grid's stair-steps.
    const x: number[] = [];
    const z: number[] = [];
    for (let k = 0; k <= 40; k += 1) {
      x.push(25 * Math.ceil(k / 2));
      z.push(25 * Math.floor(k / 2));
    }
    const relaxed = relaxRoadPolyline(x, z, 12.5, 30, 25);
    expect(relaxed.x[0]).toBe(0);
    expect(relaxed.z[0]).toBe(0);
    expect(relaxed.x[relaxed.x.length - 1]).toBe(x[x.length - 1]);
    expect(relaxed.z[relaxed.z.length - 1]).toBe(z[z.length - 1]);
    let worst = 0;
    for (let k = 0; k < relaxed.x.length; k += 1) {
      let nearest = Number.POSITIVE_INFINITY;
      for (let m = 0; m + 1 < x.length; m += 1) {
        nearest = Math.min(nearest, pointSegmentDistance(relaxed.x[k]!, relaxed.z[k]!, x[m]!, z[m]!, x[m + 1]!, z[m + 1]!));
      }
      worst = Math.max(worst, nearest);
    }
    expect(worst).toBeLessThanOrEqual(25 + 1e-9);
    // The interior has straightened onto the diagonal.
    const middle = relaxed.x.length >> 1;
    expect(Math.abs(relaxed.x[middle]! - relaxed.z[middle]!)).toBeLessThan(13);
  });
});
