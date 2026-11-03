import { afterAll, describe, expect, it } from "vitest";
import { createWorld, type WorldDefinition } from "@/src/world";
import {
  clearInfrastructureRegions,
  infrastructureCapsuleDistance,
  infrastructureIndex,
  infrastructureNear,
  infrastructurePlantExclusions,
  infrastructurePlantFactor,
  installInfrastructureRegions,
  type InfrastructureSegment,
} from "@/src/world/infrastructure";
import { INFRASTRUCTURE_PROFILE } from "@/src/world/infrastructureProfiles";
import { CLIMATE_PROVINCE_PRESETS, type ClimateProvinceName } from "@/src/world/climateProvince";
import { roadClass, roadFormationHalfWidth } from "@/src/world/roads/roadClasses";
import { pointSegmentDistance } from "@/src/world/roads/roadGraph";
import { roadPieceReach, roadRegionInfrastructure } from "@/src/world/roads/roadInfrastructure";
import {
  ROAD_LAYERS,
  ROAD_PAD_APRON_METERS,
  RoadNetwork,
  roadRegionBox,
  roadRegionOf,
  type RoadPad,
  type RoadPiece,
} from "@/src/world/roads/roadNetwork";
import { airportRoadHead } from "@/src/world/roads/roadNodes";
import { RoadGround, roadAirportKeepOut, roadGroundAt, roadGroundHeight } from "@/src/world/roads/roadTerrain";
import {
  SETTLEMENT_PAD_PRIORITY,
  SETTLEMENT_ROAD_CLEARANCE,
  SETTLEMENT_SEGMENT_KEY_STRIDE,
  type SettlementBuilding,
  type SettlementLayout,
} from "@/src/world/settlements/settlementLayout";
import { settlementRegion, settlementRegionKey, type SettlementRegion } from "@/src/world/settlements/settlementRegion";
import { SETTLEMENT_AIRPORT_CLEARANCE } from "@/src/world/settlements/settlementSites";
import { settlementStyleAt, settlementStyleRule } from "@/src/world/settlements/settlementStyles";
import { structureEnvelope } from "@/src/world/structures/structureEnvelope";
import { structureToWorld, type StructureRecord } from "@/src/world/structures/structureRecord";
import { sampleTerrainHeight } from "@/src/world/terrain";

/**
 * The settlements' layout (the structures plan's phase S1): each streamed
 * region a pure function of the world and its square, whichever region was
 * asked first; every building on dry land its style can level, clear of its
 * neighbours, every road's formation and junction pad by 3 m beyond its
 * batters, and inside its site; and once the stage composes its pads over
 * the roads, the ground under every building where its record says.
 */

/** Building a probe's road network takes seconds; a slower runner needs room. */
const HEAVY = 180_000;

interface Probe {
  readonly world: WorldDefinition;
  readonly network: RoadNetwork;
  /** 3 x 3 settlement regions round the home airport's road head. */
  readonly regions: readonly SettlementRegion[];
  readonly layouts: readonly SettlementLayout[];
  readonly buildings: readonly SettlementBuilding[];
  /** The roads' pieces and pads round them (every road region a region past the block, both layers). */
  readonly pieces: readonly RoadPiece[];
  readonly pads: readonly RoadPad[];
  readonly roadRegions: ReturnType<typeof roadRegionInfrastructure>[];
}

/**
 * The middle of the probed block: the region south-west of the home
 * airport's road head's, so the block holds two hamlets (houses fronting
 * the roads, where the clearances bind) as well as farms, roadside farms
 * and the airport's keep-out.
 */
function blockOf(world: WorldDefinition): { cx: number; cz: number } {
  const head = airportRoadHead(world)!;
  return { cx: roadRegionOf(head.startX) - 1, cz: roadRegionOf(head.startZ) - 1 };
}

/** The block's 3 x 3 settlement regions, and the roads' a region past it, installed as the worker would. */
function block(world: WorldDefinition, network: RoadNetwork) {
  const { cx, cz } = blockOf(world);
  const roadRegions = [];
  const pieces: RoadPiece[] = [];
  const pads: RoadPad[] = [];
  for (const layer of ROAD_LAYERS) {
    for (let dz = -2; dz <= 2; dz += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const region = network.region(layer, cx + dx, cz + dz);
        pieces.push(...region.pieces);
        pads.push(...region.pads);
        roadRegions.push(roadRegionInfrastructure(network, region));
      }
    }
  }
  const regions: SettlementRegion[] = [];
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dx = -1; dx <= 1; dx += 1) regions.push(settlementRegion(network, cx + dx, cz + dz));
  }
  return { regions, roadRegions, pieces, pads };
}

let cached: Probe | null = null;
function probe(): Probe {
  if (cached) return cached;
  const world = createWorld();
  const network = new RoadNetwork(world);
  const { regions, roadRegions, pieces, pads } = block(world, network);
  const layouts = regions.flatMap((region) => region.layouts);
  cached = { world, network, regions, layouts, buildings: layouts.flatMap((layout) => layout.buildings), pieces, pads, roadRegions };
  return cached;
}

afterAll(() => {
  clearInfrastructureRegions();
});

/** A building's body corners and centre, world x, z. */
function bodyPoints(record: StructureRecord): { x: number; z: number }[] {
  const points: { x: number; z: number }[] = [];
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]] as const) {
    const p = structureToWorld(record, u * record.width * 0.5, 0, v * record.depth * 0.5, { x: 0, y: 0, z: 0 });
    points.push({ x: p.x, z: p.z });
  }
  return points;
}

/** Points round a capsule at `radius` from its spine, `step` apart or closer. */
function capsuleRing(segment: InfrastructureSegment, radius: number, step: number): { x: number; z: number }[] {
  const dx = segment.bx - segment.ax;
  const dz = segment.bz - segment.az;
  const length = Math.hypot(dx, dz);
  const ux = length > 0 ? dx / length : 1;
  const uz = length > 0 ? dz / length : 0;
  const points: { x: number; z: number }[] = [];
  const along = Math.max(1, Math.ceil(length / step));
  for (let i = 0; i <= along; i += 1) {
    const x = segment.ax + (dx * i) / along;
    const z = segment.az + (dz * i) / along;
    points.push({ x: x + uz * radius, z: z - ux * radius }, { x: x - uz * radius, z: z + ux * radius });
  }
  const around = Math.max(4, Math.ceil((Math.PI * radius) / step));
  for (let j = 0; j <= around; j += 1) {
    const angle = Math.PI * (j / around) - Math.PI * 0.5;
    const s = Math.sin(angle) * radius;
    const c = Math.cos(angle) * radius;
    points.push({ x: segment.bx + ux * c + uz * s, z: segment.bz + uz * c - ux * s });
    points.push({ x: segment.ax - ux * c - uz * s, z: segment.az - uz * c + ux * s });
  }
  return points;
}

/** How far (x, z) lies from a capsule's outline (negative inside it). */
function capsuleDistance(segment: InfrastructureSegment, x: number, z: number): number {
  const dx = segment.bx - segment.ax;
  const dz = segment.bz - segment.az;
  const length = Math.hypot(dx, dz);
  const ux = length > 0 ? dx / length : 1;
  const uz = length > 0 ? dz / length : 0;
  const along = (x - segment.ax) * ux + (z - segment.az) * uz;
  const across = (x - segment.ax) * uz - (z - segment.az) * ux;
  return infrastructureCapsuleDistance(along, across, length) - segment.halfWidth;
}

/** Whether the union of a building's pads holds its envelope: corners, edges and centre. */
function coversEnvelope(building: SettlementBuilding): boolean {
  const env = building.envelope;
  for (let i = 0; i <= 8; i += 1) {
    for (let j = 0; j <= 8; j += 1) {
      const lx = env.minX + ((env.maxX - env.minX) * i) / 8;
      const lz = env.minZ + ((env.maxZ - env.minZ) * j) / 8;
      const p = structureToWorld(building.record, lx, 0, lz, { x: 0, y: 0, z: 0 });
      if (!building.pads.some((pad) => capsuleDistance(pad, p.x, p.z) <= 0.02)) return false;
    }
  }
  return true;
}

describe("settlement regions", () => {
  it("come out the same whichever is asked first, and twice alike", { timeout: HEAVY }, () => {
    const { world, regions } = probe();
    const fresh = new RoadNetwork(world);
    const { cx, cz } = blockOf(world);
    const reversed = new Map<string, SettlementRegion>();
    for (let dz = 1; dz >= -1; dz -= 1) {
      for (let dx = 1; dx >= -1; dx -= 1) reversed.set(settlementRegionKey(cx + dx, cz + dz), settlementRegion(fresh, cx + dx, cz + dz));
    }
    for (const region of regions) {
      const other = reversed.get(region.infrastructure.key)!;
      expect(JSON.stringify(other.infrastructure)).toBe(JSON.stringify(region.infrastructure));
      expect(JSON.stringify(settlementRegion(fresh, region.rx, region.rz).infrastructure)).toBe(JSON.stringify(region.infrastructure));
    }
    // The block holds hamlets and farms, so the rest is no vacuous pass.
    const kinds = new Set(regions.flatMap((region) => region.layouts.map((layout) => layout.site.kind)));
    expect([...kinds]).toEqual(expect.arrayContaining(["hamlet", "farmstead", "roadside"]));
    expect(regions.reduce((sum, region) => sum + (region.infrastructure.structures?.length ?? 0), 0)).toBeGreaterThanOrEqual(15);
  });

  it("hold each site once, in its own square, none overlapping another", { timeout: HEAVY }, () => {
    const { regions, layouts } = probe();
    const keys = new Set<string>();
    for (const region of regions) {
      const box = roadRegionBox(region.rx, region.rz);
      for (const layout of region.layouts) {
        expect(keys.has(layout.site.key)).toBe(false);
        keys.add(layout.site.key);
        expect(layout.site.x >= box.minX && layout.site.x < box.maxX && layout.site.z >= box.minZ && layout.site.z < box.maxZ).toBe(true);
      }
    }
    for (let i = 0; i < layouts.length; i += 1) {
      for (let j = i + 1; j < layouts.length; j += 1) {
        const a = layouts[i]!.site;
        const b = layouts[j]!.site;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(a.radius + b.radius);
      }
    }
  });

  it("key their segments uniquely, after every road, with records that match them", { timeout: HEAVY }, () => {
    const { world, regions } = probe();
    const keys = new Set<number>();
    const ids = new Set<number>();
    for (const region of regions) {
      for (const segment of region.infrastructure.segments) {
        expect(segment.priority).toBe(SETTLEMENT_PAD_PRIORITY);
        expect(Number.isSafeInteger(segment.key)).toBe(true);
        expect(keys.has(segment.key!)).toBe(false);
        keys.add(segment.key!);
        expect([INFRASTRUCTURE_PROFILE.platform, INFRASTRUCTURE_PROFILE.clearing]).toContain(segment.profile);
      }
      for (const layout of region.layouts) {
        for (const segment of layout.segments) {
          expect(Math.floor(segment.key! / SETTLEMENT_SEGMENT_KEY_STRIDE)).toBe(layout.site.id >>> 0);
        }
        for (const building of layout.buildings) {
          const record = building.record;
          expect(ids.has(record.id)).toBe(false);
          ids.add(record.id);
          expect(record.settlement).toBe(layout.site.id);
          expect(record.settlementKind).toBe(layout.site.kind);
          expect(record.style).toBe(layout.site.style);
          expect(record.floorY).toBeGreaterThan(record.baseY);
          expect(record.floorY).toBeGreaterThanOrEqual(record.entryY);
          expect(JSON.stringify(structureEnvelope(record))).toBe(JSON.stringify(building.envelope));
        }
      }
      expect(region.infrastructure.structures).toEqual(region.layouts.flatMap((layout) => layout.buildings.map((b) => b.record)));
    }
    // Every building's pad covers it and stands at its entry level.
    for (const layout of regions.flatMap((region) => region.layouts)) {
      for (const building of layout.buildings) {
        expect(building.pads.length).toBeGreaterThanOrEqual(1);
        expect(building.pads.every((pad) => layout.segments.includes(pad))).toBe(true);
        expect(coversEnvelope(building)).toBe(true);
        for (const core of building.pads) {
          if (building.record.foundation === "plinth") {
            expect(core.profile).toBe(INFRASTRUCTURE_PROFILE.platform);
            expect(core.params[0]! + world.seaLevel).toBeCloseTo(building.record.entryY, 6);
            expect(core.reach).toBe(building.reach);
          } else {
            expect(core.profile).toBe(INFRASTRUCTURE_PROFILE.clearing);
          }
        }
      }
    }
  });
});

describe("a settlement's buildings", () => {
  it("stand on dry land their style can level, inside their site", { timeout: HEAVY }, () => {
    const { world, layouts } = probe();
    for (const layout of layouts) {
      const rule = settlementStyleRule(layout.site.style);
      for (const building of layout.buildings) {
        const heights = bodyPoints(building.record).map(({ x, z }) => {
          const h = roadGroundHeight(world, x, z);
          expect(roadGroundAt(world, x, z, h)).toBe(RoadGround.land);
          expect(h).toBeGreaterThan(world.seaLevel + 2);
          return h;
        });
        expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(rule.relief);
        const env = building.envelope;
        for (const [lx, lz] of [[env.minX, env.minZ], [env.maxX, env.minZ], [env.maxX, env.maxZ], [env.minX, env.maxZ]] as const) {
          const p = structureToWorld(building.record, lx, 0, lz, { x: 0, y: 0, z: 0 });
          expect(Math.hypot(p.x - layout.site.x, p.z - layout.site.z)).toBeLessThanOrEqual(layout.site.radius);
        }
      }
    }
  });

  it("keep off the home airport, the marina and each other", { timeout: HEAVY }, () => {
    const { world, layouts, buildings } = probe();
    for (const layout of layouts) {
      expect(roadAirportKeepOut(world, layout.site.x, layout.site.z)).toBeGreaterThanOrEqual(SETTLEMENT_AIRPORT_CLEARANCE);
      for (const building of layout.buildings) {
        expect(infrastructureNear(world, building.record.x, building.record.z, 50)).toBe(false);
      }
    }
    // Envelopes (eaves, porches and steps) never overlap: separating axes.
    const rects = buildings.map(({ record, envelope }) => {
      const centre = structureToWorld(record, 0.5 * (envelope.minX + envelope.maxX), 0, 0.5 * (envelope.minZ + envelope.maxZ), { x: 0, y: 0, z: 0 });
      return {
        cx: centre.x,
        cz: centre.z,
        ax: Math.cos(record.heading),
        az: -Math.sin(record.heading),
        ha: 0.5 * (envelope.maxX - envelope.minX),
        hb: 0.5 * (envelope.maxZ - envelope.minZ),
      };
    });
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const p = rects[i]!;
        const q = rects[j]!;
        const separated = [[p.ax, p.az], [p.az, -p.ax], [q.ax, q.az], [q.az, -q.ax]].some(([nx, nz]) => {
          const pr = p.ha * Math.abs(p.ax * nx! + p.az * nz!) + p.hb * Math.abs(p.az * nx! - p.ax * nz!);
          const qr = q.ha * Math.abs(q.ax * nx! + q.az * nz!) + q.hb * Math.abs(q.az * nx! - q.ax * nz!);
          return Math.abs((q.cx - p.cx) * nx! + (q.cz - p.cz) * nz!) > pr + qr + 2;
        });
        expect(separated).toBe(true);
      }
    }
  });

  it("keep their pads and batters 3 m off every road's formation and junction pad", { timeout: HEAVY }, () => {
    const { world, layouts, pieces, pads } = probe();
    const half = (piece: RoadPiece) => roadFormationHalfWidth(roadClass(piece.classId));
    let checked = 0;
    for (const layout of layouts) {
      for (const segment of layout.segments) {
        if (segment.surface === "track") continue; // a driveway meets its road
        const near = pieces.filter((piece) => pointSegmentDistance(segment.ax, segment.az, piece.ax, piece.az, piece.bx, piece.bz)
          < segment.halfWidth + segment.reach + 80);
        const nearPads = pads.filter((pad) => Math.hypot(pad.x - segment.ax, pad.z - segment.az) < segment.halfWidth + segment.reach + 120);
        // A yard (painted gravel) keeps 6 m off; a pad's batters or a clearing 3 m.
        const keep = segment.surface === "gravel" ? 6 : SETTLEMENT_ROAD_CLEARANCE;
        for (const point of capsuleRing(segment, segment.halfWidth + segment.reach, 0.5)) {
          for (const piece of near) {
            expect(pointSegmentDistance(point.x, point.z, piece.ax, piece.az, piece.bx, piece.bz) - half(piece))
              .toBeGreaterThanOrEqual(keep - 0.05);
          }
          for (const pad of nearPads) {
            expect(Math.hypot(point.x - pad.x, point.z - pad.z) - pad.radius - ROAD_PAD_APRON_METERS)
              .toBeGreaterThanOrEqual(keep - 0.05);
          }
          checked += 1;
        }
        // A clearing under a building on posts keeps out of the roads' batters altogether.
        if (segment.profile === INFRASTRUCTURE_PROFILE.clearing && segment.surface === undefined) {
          for (const point of capsuleRing(segment, segment.halfWidth, 0.5)) {
            for (const piece of near) {
              expect(pointSegmentDistance(point.x, point.z, piece.ax, piece.az, piece.bx, piece.bz) - half(piece)
                - roadPieceReach(world, piece)).toBeGreaterThanOrEqual(-0.05);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1_000);
  });

  it("stand where their records say once the stage composes the pads over the roads", { timeout: HEAVY }, () => {
    const { world, regions, roadRegions, buildings } = probe();
    clearInfrastructureRegions(world);
    installInfrastructureRegions(world, [...roadRegions, ...regions.map((region) => region.infrastructure)]);
    try {
      let plinths = 0;
      let posts = 0;
      const plants = infrastructurePlantExclusions(infrastructureIndex(world));
      for (const { record } of buildings) {
        for (const { x, z } of bodyPoints(record)) {
          // No tree or grass blade inside a building.
          expect(infrastructurePlantFactor(plants, x, z)).toBe(0);
          const h = sampleTerrainHeight(world, x, z);
          if (record.foundation === "plinth") {
            // The pad's level ground, the plinth on it and the footing below.
            expect(Math.abs(h - record.entryY)).toBeLessThan(0.02);
            expect(record.baseY).toBeLessThan(h);
          } else {
            // The natural ground, the floor above it on its posts and the footings in it.
            expect(h).toBeCloseTo(roadGroundHeight(world, x, z), 6);
            expect(record.floorY - h).toBeGreaterThanOrEqual(0.39);
            expect(record.baseY).toBeLessThan(h);
          }
        }
        if (record.foundation === "plinth") plinths += 1;
        else posts += 1;
      }
      expect(plinths).toBeGreaterThan(0);
      // The default world builds on plinths; posts are the north's and the tropics' (the next test).
      expect(posts).toBe(0);
    } finally {
      clearInfrastructureRegions(world);
    }
  });
});

describe("settlement styles", () => {
  const expected: Readonly<Record<ClimateProvinceName, string>> = {
    temperate: "temperate",
    boreal: "boreal",
    tundra: "tundra",
    "high-desert": "desert",
    savanna: "savanna",
    tropical: "tropical",
  };
  it("follow the province at the anchor", () => {
    for (const province of Object.keys(CLIMATE_PROVINCE_PRESETS) as ClimateProvinceName[]) {
      const world = createWorld(undefined, { climateProvince: province });
      const head = airportRoadHead(world)!;
      // A low anchor inland of the road head (the alpine rule reads height).
      const x = head.startX;
      const z = head.startZ;
      expect(settlementStyleAt(world, x, z, world.seaLevel + 40)).toBe(expected[province]);
    }
  });

  it("put the tropics' houses on posts, out of the roads' batters, the ground under them untouched", { timeout: HEAVY }, () => {
    const world = createWorld(undefined, { climateProvince: "tropical" });
    const { regions, roadRegions } = block(world, new RoadNetwork(world));
    const buildings = regions.flatMap((region) => region.layouts.flatMap((layout) => layout.buildings));
    const onPosts = buildings.filter((building) => building.record.foundation === "posts");
    expect(onPosts.filter((building) => building.record.settlementKind === "hamlet").length).toBeGreaterThanOrEqual(5);
    clearInfrastructureRegions(world);
    installInfrastructureRegions(world, [...roadRegions, ...regions.map((region) => region.infrastructure)]);
    try {
      for (const { record } of onPosts) {
        const rule = settlementStyleRule(record.style);
        for (const { x, z } of bodyPoints(record)) {
          const h = sampleTerrainHeight(world, x, z);
          expect(h).toBeCloseTo(roadGroundHeight(world, x, z), 6);
          expect(record.floorY - h).toBeGreaterThanOrEqual(Math.min(0.39, rule.foundationHeight[0]));
          expect(record.baseY).toBeLessThan(h);
        }
      }
    } finally {
      clearInfrastructureRegions(world);
    }
  });
});
