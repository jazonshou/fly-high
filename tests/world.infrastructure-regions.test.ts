import { afterEach, describe, expect, it } from "vitest";
import { generateHydrology, type HydrologyGenerationOptions } from "@/src/render/webgpu/water/HydrologyGeneration";
import { spawnedAirportGroundAllowed } from "@/src/world/airportNetwork";
import {
  clearInfrastructureRegions,
  INFRASTRUCTURE_PLANT_BLEND_METERS,
  infrastructureIndex,
  infrastructureNear,
  infrastructurePlantExclusions,
  infrastructurePlantExclusionsIn,
  infrastructurePlantFactor,
  infrastructureRegionsVersion,
  infrastructureTerrainKey,
  installedInfrastructureRegionKeys,
  installInfrastructureRegions,
  staticInfrastructureIndex,
  withStaticInfrastructure,
  type InfrastructureRegion,
  type InfrastructureSegment,
} from "@/src/world/infrastructure";
import { INFRASTRUCTURE_PROFILE } from "@/src/world/infrastructureProfiles";
import { homeMarina } from "@/src/world/marina";
import {
  sampleTerrain,
  sampleTerrainHeight,
  sampleTerrainHeightBeforeEarthworks,
} from "@/src/world/terrain";
import { createWorld } from "@/src/world/world";
import { withAirports } from "@/src/world/airportNetwork";

/**
 * Streamed infrastructure regions (the roads' way into the stage): composed
 * the same whatever order they arrive in, shared by every world on a
 * terrain, and invisible to everything laid out on the ground before the
 * stage (the marina's site, a spawned airport's survey and veto, hydrology).
 */

const SEED = "open-skies";
const world = createWorld(SEED);
const airport = world.airport!;

afterEach(() => {
  clearInfrastructureRegions();
});

/** A level strip from (ax, az) to (bx, bz) at `height`, as a road piece might be. */
function strip(key: number, ax: number, az: number, bx: number, bz: number, height: number, priority = 5): InfrastructureSegment {
  return {
    profile: INFRASTRUCTURE_PROFILE.platform,
    mode: "set",
    priority,
    ax,
    az,
    bx,
    bz,
    halfWidth: 4,
    reach: 20,
    // Level at `height` (the platform's elevation param), batters at 1:2.
    params: [height, 2],
    surface: "gravel",
    plantClearance: 2,
    key,
  };
}

/** Three regions of strips crossing near the home field and its marina. */
function regions(): InfrastructureRegion[] {
  const marina = homeMarina(world).carParkAnchor;
  const x0 = airport.centerX;
  const z0 = airport.centerZ;
  return [
    {
      key: "test:a",
      segments: [
        strip(3, x0 + 1_500, z0 - 1_200, x0 + 1_900, z0 - 900, 20),
        strip(1, x0 + 1_900, z0 - 900, x0 + 2_400, z0 - 700, 22),
      ],
    },
    {
      key: "test:b",
      // Crosses region a's strips at another height: the order decides who wins.
      segments: [strip(2, x0 + 1_700, z0 - 700, x0 + 1_800, z0 - 1_300, 30)],
    },
    {
      key: "test:c",
      segments: [
        strip(7, marina.x - 300, marina.z - 300, marina.x + 300, marina.z + 300, marina.y - world.seaLevel + 1, 6),
        strip(5, x0 - 3_000, z0 + 2_000, x0 - 2_000, z0 + 2_600, 15, 6),
      ],
    },
  ];
}

/** Heights over a grid round the strips: what the stage gives. */
function heightsNearStrips(): number[] {
  const out: number[] = [];
  for (let i = 0; i <= 40; i += 1) {
    for (let j = 0; j <= 40; j += 1) {
      out.push(sampleTerrainHeight(world, airport.centerX + 1_400 + i * 30, airport.centerZ - 1_400 + j * 25));
    }
  }
  return out;
}

describe("streamed infrastructure regions", () => {
  it("compose by priority and key, whatever order they arrive in", () => {
    const all = regions();
    installInfrastructureRegions(world, all);
    const forward = infrastructureIndex(world).segments.map((packed) => packed.segment.key);
    const heights = heightsNearStrips();
    expect(forward).toEqual(expect.arrayContaining([1, 2, 3, 5, 7]));

    clearInfrastructureRegions(world);
    installInfrastructureRegions(world, [all[2]!]);
    installInfrastructureRegions(world, [all[1]!, all[0]!]);
    expect(infrastructureIndex(world).segments.map((packed) => packed.segment.key)).toEqual(forward);
    expect(heightsNearStrips()).toEqual(heights);
    // Priority first, then key: the static marina (10 and up) composes after every strip.
    const order = infrastructureIndex(world).segments.map((packed) => [packed.segment.priority, packed.segment.key ?? -1]);
    for (let k = 1; k < order.length; k += 1) {
      const [p0, k0] = order[k - 1]!;
      const [p1, k1] = order[k]!;
      expect(p0! < p1! || (p0 === p1 && (k0! < k1! || k0 === -1))).toBe(true);
    }
  });

  it("change the ground where they reach and nowhere else", () => {
    const x = airport.centerX + 1_700;
    const z = airport.centerZ - 1_050;
    const before = sampleTerrainHeight(world, x, z);
    const far = sampleTerrainHeight(world, airport.centerX - 6_000, airport.centerZ - 6_000);
    installInfrastructureRegions(world, regions());
    expect(sampleTerrainHeight(world, x, z)).not.toBe(before);
    expect(sampleTerrainHeight(world, airport.centerX - 6_000, airport.centerZ - 6_000)).toBe(far);
  });

  it("count a change once: a key already installed or a key not installed changes nothing", () => {
    const start = infrastructureRegionsVersion(world);
    const all = regions();
    const changed = installInfrastructureRegions(world, all);
    expect(changed).toHaveLength(3);
    const version = infrastructureRegionsVersion(world);
    expect(version).toBe(start + 1);
    const index = infrastructureIndex(world);
    expect(installInfrastructureRegions(world, all, ["test:missing"])).toEqual([]);
    expect(infrastructureRegionsVersion(world)).toBe(version);
    expect(infrastructureIndex(world)).toBe(index);
    // Removing reports the region's rectangle: every strip's reach and plant band inside it.
    const removed = installInfrastructureRegions(world, [], ["test:b"]);
    expect(removed).toHaveLength(1);
    const b = all[1]!.segments[0]!;
    const outer = b.halfWidth + b.reach + b.plantClearance! + INFRASTRUCTURE_PLANT_BLEND_METERS;
    expect(removed[0]).toEqual({
      minX: Math.min(b.ax, b.bx) - outer,
      minZ: Math.min(b.az, b.bz) - outer,
      maxX: Math.max(b.ax, b.bx) + outer,
      maxZ: Math.max(b.az, b.bz) + outer,
    });
    expect(infrastructureRegionsVersion(world)).toBe(version + 1);
    expect(infrastructureIndex(world)).not.toBe(index);
    expect(installedInfrastructureRegionKeys(world)).toEqual(["test:a", "test:c"]);
  });

  it("refuse a streamed segment without an order key, before changing anything", () => {
    const unkeyed: InfrastructureSegment = { ...strip(1, 0, 0, 10, 0, 5) };
    delete (unkeyed as { key?: number }).key;
    const keyless: InfrastructureRegion = { key: "test:keyless", segments: [unkeyed] };
    expect(() => installInfrastructureRegions(world, [regions()[0]!, keyless])).toThrow(/order key/);
    expect(installedInfrastructureRegionKeys(world)).toEqual([]);
  });

  it("belong to the terrain: a spawned airport's new world and a fresh world on the same seed share them", () => {
    const spawned = withAirports(world, [airport, { ...airport, centerX: airport.centerX + 40_000 }]);
    expect(spawned).not.toBe(world);
    expect(infrastructureTerrainKey(spawned)).toBe(infrastructureTerrainKey(world));
    installInfrastructureRegions(world, regions());
    const fresh = createWorld(SEED);
    expect(infrastructureIndex(spawned).segments.length).toBe(infrastructureIndex(world).segments.length);
    expect(infrastructureIndex(fresh).segments.length).toBe(infrastructureIndex(world).segments.length);
    // Another seed's terrain has none.
    const other = createWorld("another-seed");
    expect(infrastructureIndex(other)).toBe(staticInfrastructureIndex(other));
  });

  it("leave eroded worlds alone", () => {
    const eroded = { ...world, worldEvolution: "eroded" as const };
    expect(installInfrastructureRegions(eroded, regions())).toEqual([]);
    expect(infrastructureIndex(eroded).segments).toHaveLength(0);
  });
});

describe("what never sees a streamed region", () => {
  it("the ground before the stage, the marina's site and layout, and its anchors", () => {
    const points: [number, number][] = [];
    for (let k = 0; k < 400; k += 1) {
      points.push([airport.centerX + 1_400 + (k % 20) * 55, airport.centerZ - 1_400 + Math.floor(k / 20) * 40]);
    }
    const ground = points.map(([x, z]) => sampleTerrainHeightBeforeEarthworks(world, x, z));
    const marina = homeMarina(world);
    const anchors = staticInfrastructureIndex(world).anchors;
    installInfrastructureRegions(world, regions());
    expect(points.map(([x, z]) => sampleTerrainHeightBeforeEarthworks(world, x, z))).toEqual(ground);
    // A world object built after the install lays its marina out again, on the same ground.
    expect(homeMarina(createWorld(SEED))).toEqual(marina);
    expect(infrastructureIndex(world).anchors).toBe(anchors);
  });

  it("a spawned airport's veto, which reads the static sources", () => {
    const probes: [number, number][] = [];
    for (let k = 0; k < 200; k += 1) {
      probes.push([airport.centerX - 6_000 + (k % 20) * 600, airport.centerZ - 6_000 + Math.floor(k / 20) * 1_200]);
    }
    const near = probes.map(([x, z]) => infrastructureNear(world, x, z, 1_500));
    const allowed = probes.map(([x, z]) => spawnedAirportGroundAllowed(world, x, z));
    installInfrastructureRegions(world, regions());
    expect(probes.map(([x, z]) => infrastructureNear(world, x, z, 1_500))).toEqual(near);
    expect(probes.map(([x, z]) => spawnedAirportGroundAllowed(world, x, z))).toEqual(allowed);
    // The full index would have said otherwise next to a strip.
    const [x, z] = [airport.centerX - 2_500, airport.centerZ + 2_300];
    expect(infrastructureNear(world, x, z, 0, infrastructureIndex(world))).toBe(true);
    expect(infrastructureNear(world, x, z, 0)).toBe(false);
  });

  it("hydrology, which samples inside withStaticInfrastructure", () => {
    // What HydrologySystem hands generation: the renderer's sampler, inside the static scope.
    const config: HydrologyGenerationOptions = {
      worldSeed: world.seed,
      terrainSample: (x: number, z: number) => withStaticInfrastructure(() => sampleTerrain(world, x, z)),
      seaLevel: world.seaLevel,
      centerX: airport.centerX + 1_800,
      centerZ: airport.centerZ - 1_000,
    };
    const before = generateHydrology(config);
    const strips: [number, number][] = [[1_700, -1_050], [1_950, -880], [-2_500, 2_300]];
    const samples = strips.map(([dx, dz]) => sampleTerrain(world, airport.centerX + dx, airport.centerZ + dz));
    installInfrastructureRegions(world, regions());
    expect(generateHydrology(config)).toEqual(before);
    strips.forEach(([dx, dz], k) => {
      const x = airport.centerX + dx;
      const z = airport.centerZ + dz;
      expect(withStaticInfrastructure(() => sampleTerrain(world, x, z))).toEqual(samples[k]);
      // Outside the scope, the strip is there.
      expect(sampleTerrain(world, x, z).height).not.toBe(samples[k]!.height);
    });
  });
});

describe("bin-backed lookups", () => {
  /** A deterministic walk of points round the strips. */
  function* walk(count: number): Generator<[number, number, number]> {
    let state = 0x2545_f491;
    for (let k = 0; k < count; k += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const u = (state >>> 0) / 2 ** 32;
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const v = (state >>> 0) / 2 ** 32;
      yield [airport.centerX - 4_000 + 8_000 * u, airport.centerZ - 3_000 + 6_000 * v, (k % 7) * 260];
    }
  }

  it("infrastructureNear agrees with a scan of every segment", () => {
    installInfrastructureRegions(world, regions());
    const index = infrastructureIndex(world);
    for (const [x, z, clearance] of walk(3_000)) {
      const scan = index.segments.some((packed) => {
        const dx = x - packed.ax;
        const dz = z - packed.az;
        const along = dx * packed.dirX + dz * packed.dirZ;
        const across = dx * packed.dirZ - dz * packed.dirX;
        const distance = along < 0 ? Math.hypot(along, across)
          : along > packed.length ? Math.hypot(along - packed.length, across) : Math.abs(across);
        return distance < packed.radius + clearance;
      });
      expect(infrastructureNear(world, x, z, clearance, index)).toBe(scan);
    }
  });

  it("plant exclusions in a rectangle hold every one that reaches it, in order, and give the same factors", () => {
    installInfrastructureRegions(world, regions());
    const index = infrastructureIndex(world);
    const all = infrastructurePlantExclusions(index);
    expect(all.length).toBeGreaterThan(5);
    let reached = 0;
    for (const [x, z, size] of walk(2_000)) {
      const minX = x;
      const minZ = z;
      const maxX = x + 64 + size;
      const maxZ = z + 64 + size;
      const found = infrastructurePlantExclusionsIn(index, minX, minZ, maxX, maxZ);
      // In composition order, each once.
      const positions = found.map((exclusion) => all.indexOf(exclusion));
      for (let k = 1; k < positions.length; k += 1) expect(positions[k]).toBeGreaterThan(positions[k - 1]!);
      for (const exclusion of all) {
        // Does the blend band reach the rectangle? Nearest point of the
        // segment to the rectangle, by a fine walk along it.
        const reach = exclusion.radius + INFRASTRUCTURE_PLANT_BLEND_METERS;
        let nearest = Number.POSITIVE_INFINITY;
        for (let t = 0; t <= 1; t += 1 / 256) {
          const px = exclusion.ax + (exclusion.bx - exclusion.ax) * t;
          const pz = exclusion.az + (exclusion.bz - exclusion.az) * t;
          const dx = Math.max(minX - px, 0, px - maxX);
          const dz = Math.max(minZ - pz, 0, pz - maxZ);
          nearest = Math.min(nearest, Math.hypot(dx, dz));
        }
        if (nearest < reach - 5) {
          expect(found).toContain(exclusion);
          reached += 1;
        }
      }
      // Every factor inside the rectangle is the full list's.
      for (let k = 0; k < 4; k += 1) {
        const px = minX + ((maxX - minX) * (k + 0.5)) / 4;
        const pz = minZ + ((maxZ - minZ) * ((k * 3) % 4 + 0.5)) / 4;
        expect(infrastructurePlantFactor(found, px, pz)).toBe(infrastructurePlantFactor(all, px, pz));
      }
    }
    expect(reached).toBeGreaterThan(20);
  });
});
