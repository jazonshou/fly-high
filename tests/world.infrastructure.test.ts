import { describe, expect, it } from "vitest";
import {
  applyInfrastructure,
  buildInfrastructureIndex,
  INFRASTRUCTURE_BIN_METERS,
  infrastructureBin,
  infrastructureBinKey,
  infrastructureCapsuleDistance,
  infrastructureIndex,
  infrastructureNear,
  infrastructurePlantExclusions,
  infrastructurePlantFactor,
  infrastructureSegmentLocal,
  sampleInfrastructureSurface,
  type InfrastructureIndex,
  type InfrastructureProfileSample,
  type InfrastructureSegment,
  type InfrastructureSource,
  type InfrastructureSurfaceSample,
} from "../src/world/infrastructure";
import { INFRASTRUCTURE_PROFILE, INFRASTRUCTURE_PROFILES } from "../src/world/infrastructureProfiles";
import { INFRASTRUCTURE_SOURCES } from "../src/world/infrastructureSources";
import {
  sampleFilteredTerrainHeight,
  sampleTerrainHeight,
  sampleTerrainHeightBeforeAirports,
  sampleTerrainHeightBeforeEarthworks,
} from "../src/world/terrain";
import { createWorld } from "../src/world/world";

const world = createWorld("open-skies");

function pad(overrides: Partial<InfrastructureSegment> = {}): InfrastructureSegment {
  return {
    profile: INFRASTRUCTURE_PROFILE.platform,
    mode: "set",
    priority: 0,
    ax: 1_000,
    az: 2_000,
    bx: 1_100,
    bz: 2_000,
    halfWidth: 20,
    reach: 30,
    params: [1.2, 2],
    ...overrides,
  };
}

function source(...segments: InfrastructureSegment[]): InfrastructureSource {
  return () => ({ segments });
}

/** The segments bin (15, 31) lists. */
function index15x31(index: InfrastructureIndex): number[] | undefined {
  const list = index.bins.get(infrastructureBinKey(15, 31));
  return list && Array.from(list);
}

/** The stage over a flat ground at `ground`. */
function flat(index: InfrastructureIndex, ground: number, x: number, z: number): number {
  return applyInfrastructure(index, world.seaLevel, ground, x, z);
}

/**
 * Every profile's example parameters for the continuity check. A new profile
 * must add one here: its weight has to reach 0 at halfWidth + reach, or the
 * ground steps where the stage stops evaluating it.
 */
const PROFILE_EXAMPLES: Record<string, readonly number[]> = {
  platform: [1.2, 2],
  marinaDredge: [3, 4, 0.3, 1.2],
  marinaPad: [1.5, 1.5, 2, 0.15],
  marinaSlipway: [1.5, -1.5, 1.5],
  marinaBreakwater: [2, 2.5, 1.5],
  carriageway: [1.2, 3.4, 0.03, -0.02, 0.04, 0.5, 1.5],
  junctionPad: [1.2, 6, 0.08],
};

describe("infrastructure stage containment", () => {
  it("ships only the home marina, so every height outside it is the pre-stage height bit for bit", () => {
    expect(INFRASTRUCTURE_SOURCES).toHaveLength(1);
    const index = infrastructureIndex(world);
    expect(index.segments.length).toBeGreaterThan(0);
    let outside = 0;
    for (let i = 0; i < 64; i += 1) {
      const x = -6_000 + i * 197.3;
      const z = 3_000 - i * 151.9;
      if (infrastructureNear(world, x, z, 0.01, index)) continue;
      outside += 1;
      const before = sampleTerrainHeightBeforeEarthworks(world, x, z);
      expect(Object.is(sampleTerrainHeightBeforeAirports(world, x, z), before)).toBe(true);
    }
    expect(outside).toBeGreaterThan(50);
    // The home field is still the platform it was.
    const airport = world.airport!;
    expect(sampleTerrainHeight(world, airport.centerX, airport.centerZ)).toBeCloseTo(airport.elevation, 6);
  });

  it("returns the given height itself outside every segment and in eroded worlds", () => {
    const index = buildInfrastructureIndex(world, [source(pad())]);
    const ground = 12.345678;
    expect(Object.is(flat(index, ground, 1_050, 2_051), ground)).toBe(true);
    expect(Object.is(flat(index, ground, 50_000, 50_000), ground)).toBe(true);
    const eroded = createWorld("open-skies", { worldEvolution: "eroded" });
    expect(infrastructureIndex(eroded, [source(pad())]).segments).toHaveLength(0);
  });
});

describe("infrastructure composition", () => {
  it("levels a platform and batters it to the ground at its grade", () => {
    const index = buildInfrastructureIndex(world, [source(pad())]);
    const level = world.seaLevel + 1.2;
    // On the core, including the round end caps.
    expect(flat(index, 8, 1_050, 2_000)).toBe(level);
    expect(flat(index, -3, 1_050, 1_981)).toBe(level);
    expect(flat(index, 8, 985, 2_000)).toBe(level);
    // 4 m onto the batter of a 1:2 cut: 2 m above the pad, still below ground.
    expect(flat(index, 8, 1_050, 2_024)).toBeCloseTo(level + 2, 12);
    // Past where the batter meets the ground, the ground.
    expect(flat(index, 8, 1_050, 2_040)).toBeCloseTo(8, 12);
    // A fill batters down the same way.
    expect(flat(index, -3, 1_050, 1_976)).toBeCloseTo(level - 2, 12);
  });

  it("cuts only down and fills only up", () => {
    const cut = buildInfrastructureIndex(world, [source(pad({ mode: "cut", params: [-3, 2] }))]);
    const fill = buildInfrastructureIndex(world, [source(pad({ mode: "fill", params: [2, 2] }))]);
    expect(flat(cut, 5, 1_050, 2_000)).toBe(world.seaLevel - 3);
    expect(flat(cut, -10, 1_050, 2_000)).toBe(-10);
    expect(flat(fill, -10, 1_050, 2_000)).toBe(world.seaLevel + 2);
    expect(flat(fill, 10, 1_050, 2_000)).toBe(10);
  });

  it("composes in priority order, then source order, on the running height", () => {
    const low = pad({ priority: 0, params: [1, 2] });
    const high = pad({ priority: 1, params: [4, 2] });
    // The higher priority runs last and wins wherever both are full weight,
    // whichever order they are listed in.
    for (const sources of [[source(low, high)], [source(high), source(low)]]) {
      expect(flat(buildInfrastructureIndex(world, sources), 0, 1_050, 2_000)).toBe(world.seaLevel + 4);
    }
    // Equal priority: the later source wins.
    const tieA = pad({ params: [1, 2] });
    const tieB = pad({ params: [3, 2] });
    expect(flat(buildInfrastructureIndex(world, [source(tieA), source(tieB)]), 0, 1_050, 2_000)).toBe(world.seaLevel + 3);
    expect(flat(buildInfrastructureIndex(world, [source(tieB), source(tieA)]), 0, 1_050, 2_000)).toBe(world.seaLevel + 1);
  });

  it("puts a disc where a segment's ends coincide", () => {
    const disc = buildInfrastructureIndex(world, [source(pad({ bx: 1_000, bz: 2_000, halfWidth: 10 }))]);
    expect(flat(disc, 5, 1_007, 2_007)).toBe(world.seaLevel + 1.2);
    expect(flat(disc, 5, 1_015, 2_000)).toBeCloseTo(world.seaLevel + 1.2 + 2.5, 12);
  });

  it("measures across to the right of a->b", () => {
    // Heading north (+Z), the right is east (+X).
    expect(infrastructureCapsuleDistance(5, 3, 10)).toBe(3);
    expect(infrastructureCapsuleDistance(-3, 4, 10)).toBe(5);
    expect(infrastructureCapsuleDistance(13, -4, 10)).toBe(5);
    const index = buildInfrastructureIndex(world, [source(pad({ ax: 0, az: 0, bx: 0, bz: 100 }))]);
    const local = infrastructureSegmentLocal(index.segments[0]!, 7, 50, { along: 0, across: 0 });
    expect(local.along).toBe(50);
    expect(local.across).toBe(7);
  });
});

describe("infrastructure index", () => {
  it("bins a long diagonal road only where it reaches, and agrees with a brute-force pass", () => {
    const road = pad({ ax: -4_000, az: -4_000, bx: 4_000, bz: 4_000, halfWidth: 4, reach: 16, params: [0, 2] });
    const square = pad({ ax: 3_000, az: -3_000, bx: 3_000, bz: -3_000, halfWidth: 50, reach: 40, params: [6, 1.5] });
    const index = buildInfrastructureIndex(world, [source(road, square)]);
    const bounds = Math.ceil(8_040 / INFRASTRUCTURE_BIN_METERS);
    // A bounding-box binning would list the road in ~bounds^2 bins.
    let roadBins = 0;
    for (const list of index.bins.values()) if (Array.from(list).includes(index.segments.findIndex((s) => s.segment === road))) roadBins += 1;
    expect(roadBins).toBeLessThan(4 * bounds);
    // Every point equals the stage evaluated over all segments with no bins.
    const brute = (ground: number, x: number, z: number) => {
      let h = ground;
      const sample: InfrastructureProfileSample = { target: 0, weight: 0 };
      for (const packed of index.segments) {
        const dx = x - packed.ax;
        const dz = z - packed.az;
        const along = dx * packed.dirX + dz * packed.dirZ;
        const across = dx * packed.dirZ - dz * packed.dirX;
        if (infrastructureCapsuleDistance(along, across, packed.length) >= packed.radius) continue;
        packed.profile.height(along, across, packed.length, packed.segment, h, world.seaLevel, sample);
        if (sample.weight > 0) h = sample.weight >= 1 ? sample.target : h + (sample.target - h) * sample.weight;
      }
      return h;
    };
    for (let i = 0; i < 4_000; i += 1) {
      const t = i / 4_000;
      const x = -4_100 + 8_200 * t + Math.sin(i * 12.9898) * 25;
      const z = -4_100 + 8_200 * t + Math.cos(i * 78.233) * 25;
      const ground = 3 + Math.sin(i);
      expect(flat(index, ground, x, z)).toBe(brute(ground, x, z));
      const qx = 3_000 + Math.sin(i * 1.7) * 120;
      const qz = -3_000 + Math.cos(i * 2.3) * 120;
      expect(flat(index, ground, qx, qz)).toBe(brute(ground, qx, qz));
    }
    expect(index.binMinX).toBe(infrastructureBin(-4_020));
    expect(index.binMaxX).toBe(infrastructureBin(4_020));
    expect(index.bins.get(infrastructureBinKey(infrastructureBin(3_000), infrastructureBin(3_000)))).toBeDefined();
  });

  it("publishes anchors and refuses duplicates", () => {
    const withAnchor: InfrastructureSource = () => ({
      segments: [],
      anchors: [{ name: "marinaCarPark", x: 10, z: 20, headingRadians: 1 }],
    });
    const index = buildInfrastructureIndex(world, [withAnchor]);
    expect(index.anchors.get("marinaCarPark")).toEqual({ name: "marinaCarPark", x: 10, z: 20, headingRadians: 1 });
    expect(() => buildInfrastructureIndex(world, [withAnchor, withAnchor])).toThrow(/Duplicate/);
  });

  it("rejects malformed segments", () => {
    expect(() => buildInfrastructureIndex(world, [source(pad({ profile: 99 }))])).toThrow(RangeError);
    expect(() => buildInfrastructureIndex(world, [source(pad({ halfWidth: -1 }))])).toThrow(RangeError);
    expect(() => buildInfrastructureIndex(world, [source(pad({ ax: Number.NaN }))])).toThrow(RangeError);
    expect(() => buildInfrastructureIndex(world, [source(pad({ params: new Array(9).fill(0) }))])).toThrow(RangeError);
    expect(() => buildInfrastructureIndex(world, [source(pad({ mode: "raise" as never }))])).toThrow(RangeError);
  });

  it("throws when a source reads the staged height while the index is built", () => {
    const greedy: InfrastructureSource = (w) => {
      infrastructureIndex(w, [source(pad())]);
      return { segments: [] };
    };
    expect(() => infrastructureIndex(world, [greedy])).toThrow(/sampleTerrainHeightBeforeEarthworks/);
    // The guard resets after the throw.
    expect(infrastructureIndex(world, [source(pad())]).segments).toHaveLength(1);
  });

  it("tells a spawned airport where infrastructure is", () => {
    const index = buildInfrastructureIndex(world, [source(pad())]);
    expect(infrastructureNear(world, 1_050, 2_000, 0, index)).toBe(true);
    // 50 m reach from the centreline, plus a 1,500 m clearance.
    expect(infrastructureNear(world, 1_050, 2_000 + 1_549, 1_500, index)).toBe(true);
    expect(infrastructureNear(world, 1_050, 2_000 + 1_551, 1_500, index)).toBe(false);
    expect(infrastructureNear(world, 1_050, 2_000, 1_500)).toBe(false);
  });
});

describe("infrastructure surfaces and plants", () => {
  it("paints a segment's core with its surface, feathered across the edge", () => {
    const apron = pad({ surface: "concrete" });
    const basin = pad({ ax: 1_050, bx: 1_050, halfWidth: 60, reach: 10 });
    const index = buildInfrastructureIndex(world, [source(basin, apron)]);
    const out: InfrastructureSurfaceSample = { surface: null, coverage: 0 };
    expect(sampleInfrastructureSurface(index, 1_050, 2_010, out)).toEqual({ surface: "concrete", coverage: 1 });
    // On the edge, half; half a metre out, none. The basin paints nothing.
    expect(sampleInfrastructureSurface(index, 1_050, 2_020, out).coverage).toBeCloseTo(0.5, 12);
    expect(sampleInfrastructureSurface(index, 1_050, 2_020.5, out)).toEqual({ surface: null, coverage: 0 });
    expect(sampleInfrastructureSurface(index, 1_050, 2_045, out).surface).toBeNull();
  });

  it("samples a segment as wide as the texel or wider at the point, whatever the texel", () => {
    const index = buildInfrastructureIndex(world, [source(pad({ surface: "concrete" }))]);
    const point: InfrastructureSurfaceSample = { surface: null, coverage: 0 };
    const over: InfrastructureSurfaceSample = { surface: null, coverage: 0 };
    for (const texel of [0, 4, 16, 40]) {
      for (const z of [2_000, 2_013.7, 2_019.6, 2_020, 2_020.3, 2_031]) {
        sampleInfrastructureSurface(index, 1_041.3, z, point);
        expect(sampleInfrastructureSurface(index, 1_041.3, z, over, texel)).toEqual(point);
      }
    }
  });

  it("paints a road narrower than the texel by the share of each texel it covers", () => {
    // A 5 m gravel road at sub-texel offsets: a column of texels across it
    // paints its width's worth, wherever it falls in them, where a point
    // sample would paint a whole texel or none.
    const out: InfrastructureSurfaceSample = { surface: null, coverage: 0 };
    for (const texel of [8, 16, 32, 64]) {
      for (const offset of [0, 0.3, 0.5, 0.77]) {
        const z = 2_048 + offset * texel;
        const road = pad({ ax: 0, az: z, bx: 4_000, bz: z, halfWidth: 2.5, reach: 4, surface: "gravel" });
        const index = buildInfrastructureIndex(world, [source(road)]);
        let painted = 0;
        let most = 0;
        for (let row = -6; row < 6; row += 1) {
          const sample = sampleInfrastructureSurface(index, 1_500.5, 2_048 + (row + 0.5) * texel, out, texel);
          if (sample.coverage > 0) expect(sample.surface).toBe("gravel");
          painted += sample.coverage * texel;
          most = Math.max(most, sample.coverage);
        }
        expect(painted).toBeCloseTo(5, 9);
        expect(most).toBeLessThanOrEqual(5 / texel + 1e-12);
      }
    }
  });

  it("finds a narrow segment in the texel's other bins when its own bin does not list it", () => {
    // A 2 m pad just over the corner of bin (15, 31), too far from that bin
    // to be listed in it; a texel near the corner covers some of it.
    const corner = pad({ ax: 1_027, az: 2_051, bx: 1_027, bz: 2_051, halfWidth: 1, reach: 1, surface: "asphalt" });
    const index = buildInfrastructureIndex(world, [source(corner)]);
    expect([infrastructureBin(1_020), infrastructureBin(2_044)]).toEqual([15, 31]);
    expect(index15x31(index)).toBeUndefined();
    const out: InfrastructureSurfaceSample = { surface: null, coverage: 0 };
    expect(sampleInfrastructureSurface(index, 1_020, 2_044, out)).toEqual({ surface: null, coverage: 0 });
    // 9.9 m from the centre of a 32 m texel: the 2 m band lies inside its box.
    expect(sampleInfrastructureSurface(index, 1_020, 2_044, out, 32)).toEqual({ surface: "asphalt", coverage: 2 / 32 });
    // A box never reaches past half a bin: at 256 m texels, the same 64 m box.
    expect(sampleInfrastructureSurface(index, 1_020, 2_044, out, 256)).toEqual({ surface: "asphalt", coverage: 2 / 64 });
  });

  it("lets a segment from the texel's other bins win only on more coverage", () => {
    // One pad in the texel's own bin, a later one only in the next bin over,
    // each 9.9 m from the texel's centre: a tie keeps the own bin's pad.
    const own = pad({ ax: 1_013, az: 2_037, bx: 1_013, bz: 2_037, halfWidth: 1, reach: 1, surface: "gravel" });
    const next = (halfWidth: number) => pad({
      ax: 1_027, az: 2_051, bx: 1_027, bz: 2_051, halfWidth, reach: 1, surface: "asphalt",
    });
    const out: InfrastructureSurfaceSample = { surface: null, coverage: 0 };
    const tie = buildInfrastructureIndex(world, [source(own, next(1))]);
    expect(index15x31(tie)).toEqual([0]);
    expect(sampleInfrastructureSurface(tie, 1_020, 2_044, out, 32)).toEqual({ surface: "gravel", coverage: 2 / 32 });
    const more = buildInfrastructureIndex(world, [source(own, next(1.5))]);
    expect(index15x31(more)).toEqual([0]);
    expect(sampleInfrastructureSurface(more, 1_020, 2_044, out, 32)).toEqual({ surface: "asphalt", coverage: 3 / 32 });
  });

  it("keeps plants off segments that ask, and lets them back in over a short band", () => {
    const index = buildInfrastructureIndex(world, [source(pad({ plantClearance: 2 }), pad({ az: 3_000, bz: 3_000 }))]);
    const exclusions = infrastructurePlantExclusions(index);
    expect(exclusions).toEqual([{ ax: 1_000, az: 2_000, bx: 1_100, bz: 2_000, radius: 52 }]);
    expect(infrastructurePlantFactor(exclusions, 1_050, 2_000)).toBe(0);
    expect(infrastructurePlantFactor(exclusions, 1_050, 2_052)).toBe(0);
    expect(infrastructurePlantFactor(exclusions, 1_050, 2_054)).toBeCloseTo(0.5, 12);
    expect(infrastructurePlantFactor(exclusions, 1_050, 2_056)).toBe(1);
    // The segment without a clearance keeps its plants.
    expect(infrastructurePlantFactor(exclusions, 1_050, 3_000)).toBe(1);
  });
});

describe("infrastructure profiles", () => {
  it("are indexed by id and each has an example", () => {
    INFRASTRUCTURE_PROFILES.forEach((profile, index) => {
      expect(profile.id).toBe(index);
      expect(PROFILE_EXAMPLES[profile.name]).toBeDefined();
      expect(profile.wgsl).toContain(`fn terrainInfra_${profile.name}(`);
    });
  });

  it("fade to zero weight where the stage stops evaluating them", () => {
    for (const profile of INFRASTRUCTURE_PROFILES) {
      const segment = pad({ profile: profile.id, params: PROFILE_EXAMPLES[profile.name]! });
      const sample: InfrastructureProfileSample = { target: 0, weight: 0 };
      const edge = segment.halfWidth + segment.reach;
      for (const ground of [-40, -2, 0.5, 3, 25]) {
        for (const along of [-edge + 1e-6, 30]) {
          const across = along < 0 ? 0 : edge - 1e-6;
          profile.height(along, across, 100, segment, ground, world.seaLevel, sample);
          expect(sample.weight * Math.abs(sample.target - ground)).toBeLessThan(1e-4);
        }
      }
    }
  });
});

describe("infrastructure in the render path", () => {
  it("leaves the filtered render height on the collision height with no sources", () => {
    for (let i = 0; i < 16; i += 1) {
      const x = 800 + i * 311;
      const z = -1_200 + i * 97;
      expect(Object.is(sampleFilteredTerrainHeight(world, x, z, 0), sampleTerrainHeight(world, x, z))).toBe(true);
    }
  });
});
