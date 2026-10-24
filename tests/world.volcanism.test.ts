import { describe, expect, it } from "vitest";
import { LANDFORM_CORE, landformCoreCenter } from "../src/world/landforms";
import {
  VOLCANISM,
  VolcanicSiteKind,
  applyVolcanicOverlay,
  sampleVolcanicGround,
  volcanicActivity,
  volcanicFlowReach,
  volcanicSitesInBounds,
  volcanicVentsInBounds,
  type VolcanicSite,
} from "../src/world/volcanism";
import {
  sampleFilteredTerrainHeight,
  sampleNaturalTerrainHeight,
  sampleTerrainCollisionHeight,
  sampleTerrainHeight,
} from "../src/world/terrain";
import { createWorld } from "../src/world/world";
import type { WorldDefinition } from "../src/world/types";

/**
 * Volcanic land: sites are whole or absent outside the 120 km landform core,
 * the overlay is the identity everywhere no footprint reaches, and every
 * thread derives the same sites from the seed alone.
 */

const SEEDS = ["open-skies", "terra1", "kilo77", "ash-lab"];

function sitesAround(world: WorldDefinition, halfSpan: number): VolcanicSite[] {
  const center = landformCoreCenter(world);
  return volcanicSitesInBounds(
    world, center.x - halfSpan, center.z - halfSpan, center.x + halfSpan, center.z + halfSpan);
}

function guaranteedStrato(world: WorldDefinition): VolcanicSite {
  const site = sitesAround(world, 200_000).find((candidate) => candidate.id % 4 === 2);
  if (!site) throw new Error("no guaranteed stratovolcano");
  return site;
}

describe("volcanic containment", () => {
  it("puts every site's whole footprint outside the landform core", () => {
    for (const seed of SEEDS) {
      const world = createWorld(seed);
      const center = landformCoreCenter(world);
      const sites = sitesAround(world, 220_000);
      expect(sites.length).toBeGreaterThan(20);
      for (const site of sites) {
        const distance = Math.hypot(site.x - center.x, site.z - center.z);
        expect(distance - site.footprintRadiusMeters).toBeGreaterThanOrEqual(LANDFORM_CORE.innerRadiusMeters);
      }
    }
  });

  it("is the identity, BIT FOR BIT, inside the core and on bare ground outside it", () => {
    for (const seed of SEEDS) {
      const world = createWorld(seed);
      const center = landformCoreCenter(world);
      for (let index = 0; index < 1_500; index += 1) {
        const angle = index * 2.399963;
        const radius = 121_000 * Math.sqrt((index + 0.5) / 1_500);
        const x = center.x + Math.cos(angle) * radius;
        const z = center.z + Math.sin(angle) * radius;
        const natural = sampleNaturalTerrainHeight(world.seedHash, x, z, 0);
        expect(Object.is(applyVolcanicOverlay(world, x, z, natural, 0), natural)).toBe(true);
        expect(Object.is(applyVolcanicOverlay(world, x, z, -0, 512), -0)).toBe(true);
        if (radius < LANDFORM_CORE.innerRadiusMeters) expect(volcanicActivity(world, x, z)).toBe(0);
      }
      // Outside the core, a point no footprint reaches keeps its height object-identically.
      const sites = sitesAround(world, 220_000);
      let bare = 0;
      for (let index = 0; index < 600 && bare < 150; index += 1) {
        const angle = index * 2.399963;
        const radius = 130_000 + 80_000 * ((index * 0.618034) % 1);
        const x = center.x + Math.cos(angle) * radius;
        const z = center.z + Math.sin(angle) * radius;
        const touched = sites.some((site) =>
          Math.hypot(x - site.x, z - site.z) < site.footprintRadiusMeters);
        if (touched) continue;
        bare += 1;
        expect(Object.is(applyVolcanicOverlay(world, x, z, 123.456, 0), 123.456)).toBe(true);
        const ground = sampleVolcanicGround(world, x, z, 0);
        expect(ground).toEqual({ lavaCover: 0, tephraCover: 0, age: 0 });
      }
      expect(bare).toBeGreaterThan(100);
    }
  });

  it("is absent from eroded worlds", () => {
    const world = createWorld("ash-lab", { worldEvolution: "eroded" });
    expect(sitesAround(world, 220_000)).toHaveLength(0);
  });
});

describe("volcanic sites", () => {
  it("are the same in every world instance, whatever box or order asks first", () => {
    const a = createWorld("terra1");
    const b = createWorld("terra1");
    const center = landformCoreCenter(a);
    // b warms its caches from a different corner first.
    volcanicSitesInBounds(b, center.x + 150_000, center.z - 10_000, center.x + 190_000, center.z + 30_000);
    // `stamp` is the lookup's own bookkeeping, not part of a site.
    const describe = (site: VolcanicSite): string =>
      JSON.stringify(site, (key, value: unknown) => (key === "stamp" ? undefined : value));
    const fromA = sitesAround(a, 200_000).map(describe);
    const fromB = sitesAround(b, 200_000).map(describe);
    expect(fromB).toEqual(fromA);
  });

  it("give the same ground on an area's first sample as on every later one", () => {
    // Sites are built on a bin's first visit, in the middle of a height
    // sample, and the dune stage asks for volcanic activity while it still
    // reads the natural kernel's shared intermediates. Building a site must
    // leave those exactly as they were.
    for (const landforms of [{ dunes: true }, { dunes: true, volcanic: true }]) {
      const options = { landforms, climateProvince: "high-desert" } as const;
      const home = landformCoreCenter(createWorld("dune-lab", options));
      for (let k = 0; k < 24; k += 1) {
        const angle = k * 0.9;
        const r = 7_000 + k * 1_500;
        const x = home.x + Math.cos(angle) * r;
        const z = home.z + Math.sin(angle) * r;
        // A fresh world per point: empty caches, so this sample is the first.
        const world = createWorld("dune-lab", options);
        const first = sampleTerrainHeight(world, x, z);
        expect(sampleTerrainHeight(world, x, z)).toBe(first);
        const fresh = createWorld("dune-lab", options);
        const firstFiltered = sampleFilteredTerrainHeight(fresh, x, z, 64);
        expect(sampleFilteredTerrainHeight(fresh, x, z, 64)).toBe(firstFiltered);
      }
    }
  });

  it("guarantee a field with a stratovolcano just past the core", () => {
    for (const seed of SEEDS) {
      const world = createWorld(seed);
      const center = landformCoreCenter(world);
      const strato = guaranteedStrato(world);
      expect(strato.kind).toBe(VolcanicSiteKind.Strato);
      const distance = Math.hypot(strato.x - center.x, strato.z - center.z);
      expect(distance).toBeGreaterThanOrEqual(VOLCANISM.guaranteed.distanceMeters);
      expect(distance).toBeLessThanOrEqual(
        VOLCANISM.guaranteed.distanceMeters + VOLCANISM.guaranteed.distanceSpanMeters);
      expect(strato.heightMeters).toBeGreaterThanOrEqual(1_400);
      expect(strato.heightMeters).toBeLessThanOrEqual(2_500);
      // The field round it holds vents.
      const field = volcanicSitesInBounds(
        world, strato.x - 35_000, strato.z - 35_000, strato.x + 35_000, strato.z + 35_000);
      expect(field.filter((site) => site.kind === VolcanicSiteKind.Cinder).length).toBeGreaterThan(5);
      // The summit stands well above the ground it was built on.
      expect(sampleTerrainHeight(world, strato.x + 600, strato.z)).toBeGreaterThan(
        strato.baseLevelMeters + strato.heightMeters * 0.7);
    }
  });

  it("apply level sites (calderas, maars) before additive ones, then by id", () => {
    const world = createWorld("kilo77");
    const sites = sitesAround(world, 220_000);
    const level = (site: VolcanicSite): number =>
      site.kind === VolcanicSiteKind.Caldera || site.kind === VolcanicSiteKind.Maar ? 0 : 1;
    for (let index = 1; index < sites.length; index += 1) {
      const previous = sites[index - 1]!;
      const site = sites[index]!;
      expect(level(previous) < level(site) || (level(previous) === level(site) && previous.id < site.id))
        .toBe(true);
    }
  });

  it("keep footprints within the search caps", () => {
    for (const seed of SEEDS) {
      for (const site of sitesAround(createWorld(seed), 220_000)) {
        const cap = site.kind === VolcanicSiteKind.Cinder || site.kind === VolcanicSiteKind.Maar
          ? VOLCANISM.vent.maxFootprintMeters
          : VOLCANISM.edifice.maxFootprintMeters;
        expect(site.footprintRadiusMeters).toBeLessThanOrEqual(cap);
        for (const flow of site.flows) {
          expect(volcanicFlowReach(site.x, site.z, flow)).toBeLessThanOrEqual(site.footprintRadiusMeters + 1e-6);
        }
      }
    }
  });
});

describe("volcanic shapes", () => {
  const world = createWorld("ash-lab");
  const sites = sitesAround(world, 220_000);

  it("build young cinder cones at 25-35 degrees with a crater below the rim", () => {
    const cones = sites.filter((site) =>
      site.kind === VolcanicSiteKind.Cinder && site.age < 0.15 && site.radiusMeters > 400
      && site.breachX === 0 && site.breachZ === 0);
    expect(cones.length).toBeGreaterThan(0);
    for (const cone of cones.slice(0, 5)) {
      const crater = cone.craterRadiusMeters;
      const rim = applyVolcanicOverlay(world, cone.x + crater, cone.z, 0, 0);
      const floor = applyVolcanicOverlay(world, cone.x, cone.z, 0, 0);
      expect(rim - floor).toBeGreaterThan(cone.craterDepthMeters * 0.5);
      // Mid-flank slope, sampled along four bearings on bare (zero) ground.
      const slopes: number[] = [];
      for (const [ux, uz] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
        const r = (crater + cone.radiusMeters) * 0.5;
        const inner = applyVolcanicOverlay(world, cone.x + ux * (r - 20), cone.z + uz * (r - 20), 0, 0);
        const outer = applyVolcanicOverlay(world, cone.x + ux * (r + 20), cone.z + uz * (r + 20), 0, 0);
        slopes.push(Math.atan2(inner - outer, 40) * 180 / Math.PI);
      }
      const mean = slopes.reduce((sum, value) => sum + value, 0) / slopes.length;
      expect(mean).toBeGreaterThan(22);
      expect(mean).toBeLessThan(40);
    }
  });

  it("set caldera floors to one level", () => {
    const calderas = SEEDS.flatMap((seed) => {
      const seeded = createWorld(seed);
      return sitesAround(seeded, 260_000)
        .filter((site) => site.kind === VolcanicSiteKind.Caldera)
        .map((site) => ({ world: seeded, site }));
    });
    expect(calderas.length).toBeGreaterThan(0);
    for (const { world: seeded, site } of calderas.slice(0, 4)) {
      const level = site.baseLevelMeters + site.heightMeters - site.craterDepthMeters;
      for (const [ux, uz] of [[0.3, 0], [0, -0.4], [-0.5, 0.2]] as const) {
        const x = site.x + ux * site.radiusMeters;
        const z = site.z + uz * site.radiusMeters;
        // The floor may carry a small cone; elsewhere it is flat at `level`.
        const others = volcanicSitesInBounds(seeded, x - 1, z - 1, x + 1, z + 1)
          .filter((other) => other.id !== site.id);
        if (others.length > 0) continue;
        const natural = sampleNaturalTerrainHeight(seeded.seedHash, x, z, 0);
        expect(applyVolcanicOverlay(seeded, x, z, natural, 0)).toBeCloseTo(level, 6);
      }
      if (site.lakeLevelMeters === site.lakeLevelMeters) {
        expect(site.lakeLevelMeters).toBeGreaterThan(level);
        expect(site.lakeLevelMeters).toBeLessThan(level + site.craterDepthMeters * 0.5);
      }
    }
  });

  it("is continuous across lookup bins (no seams where a bin's site list changes)", () => {
    const strato = guaranteedStrato(world);
    const bin = VOLCANISM.binMeters;
    let crossings = 0;
    for (let row = -20; row <= 20; row += 1) {
      const z = strato.z + row * 1_731;
      const edge = Math.ceil((strato.x - 40_000) / bin) * bin;
      for (let x = edge; x < strato.x + 40_000; x += bin) {
        // The step across the bin edge against the steps either side of it:
        // a seam is a jump, a flank is three similar steps.
        const h = [-0.15, -0.05, 0.05, 0.15].map((offset) => sampleTerrainHeight(world, x + offset, z));
        const across = Math.abs(h[2]! - h[1]!);
        const beside = Math.max(Math.abs(h[1]! - h[0]!), Math.abs(h[3]! - h[2]!));
        expect(across).toBeLessThan(beside * 2 + 1e-3);
        crossings += 1;
      }
    }
    expect(crossings).toBeGreaterThan(600);
  });

  it("bounds every site by its footprint (no seam where a footprint ends)", () => {
    // Just inside and just outside each footprint circle: the step across
    // the circle must look like the steps beside it, never a jump.
    let probes = 0;
    for (const seed of ["ash-lab", "kilo77"]) {
      const seeded = createWorld(seed, seed === "kilo77" ? { landforms: { volcanic: true } } : {});
      const center = landformCoreCenter(seeded);
      const span = seed === "kilo77" ? 40_000 : 220_000;
      const all = volcanicSitesInBounds(
        seeded, center.x - span, center.z - span, center.x + span, center.z + span);
      for (const site of all.slice(0, 120)) {
        for (let spoke = 0; spoke < 90; spoke += 1) {
          const angle = spoke * (Math.PI / 45) + 0.01;
          const ux = Math.cos(angle);
          const uz = Math.sin(angle);
          const h = [-0.03, -0.01, 0.01, 0.03].map((offset) => {
            const r = site.footprintRadiusMeters + offset;
            return applyVolcanicOverlay(seeded, site.x + ux * r, site.z + uz * r, 0, 0);
          });
          const across = Math.abs(h[2]! - h[1]!);
          const beside = Math.max(Math.abs(h[1]! - h[0]!), Math.abs(h[3]! - h[2]!));
          expect(across, `site ${site.id} kind ${site.kind} spoke ${spoke}`).toBeLessThan(beside * 2 + 1e-4);
          probes += 1;
        }
      }
    }
    expect(probes).toBeGreaterThan(10_000);
  });

  it("fades small features with the filter width instead of aliasing them", () => {
    const cone = sites.find((site) => site.kind === VolcanicSiteKind.Cinder && site.radiusMeters < 400);
    expect(cone).toBeDefined();
    const fine = applyVolcanicOverlay(world, cone!.x, cone!.z, 0, 0);
    const coarse = applyVolcanicOverlay(world, cone!.x, cone!.z, 0, 2_048);
    expect(Math.abs(fine)).toBeGreaterThan(5);
    expect(Math.abs(coarse)).toBeLessThan(Math.abs(fine) * 0.05 + 1e-9);
    // Width 0 is the collision kernel: the render path at width 0 agrees.
    expect(sampleFilteredTerrainHeight(world, cone!.x + 37, cone!.z - 11, 0))
      .toBe(sampleTerrainHeight(world, cone!.x + 37, cone!.z - 11));
  });

  it("covers cones in tephra and flows in lava, and steams only from young sites", () => {
    const cone = sites.find((site) => site.kind === VolcanicSiteKind.Cinder)!;
    const onCone = sampleVolcanicGround(world, cone.x + cone.craterRadiusMeters, cone.z, 0);
    expect(onCone.tephraCover).toBe(1);
    const flowSite = sites.find((site) => site.flows.length > 0)!;
    const flow = flowSite.flows[0]!;
    // On the centreline, b = k a^2 / 2 along the start normal (-dirZ, dirX).
    const along = flow.lengthMeters * 0.3;
    const offset = 0.5 * flow.bend * along * along;
    const midX = flow.startX + flow.directionX * along - flow.directionZ * offset;
    const midZ = flow.startZ + flow.directionZ * along + flow.directionX * offset;
    const onFlow = sampleVolcanicGround(world, midX, midZ, 0);
    expect(onFlow.lavaCover).toBeGreaterThan(0.5);
    const center = landformCoreCenter(world);
    const vents = volcanicVentsInBounds(
      world, center.x - 220_000, center.z - 220_000, center.x + 220_000, center.z + 220_000);
    expect(vents.length).toBeGreaterThan(0);
    for (const vent of vents) {
      expect(vent.strength).toBeGreaterThan(0);
      expect(vent.strength).toBeLessThanOrEqual(1);
    }
  });
});

describe("forced volcanic start", () => {
  const world = createWorld("ash-lab", { landforms: { volcanic: true } });
  const airport = world.airport!;

  it("is volcanic near home but keeps the runway and its approaches clear", () => {
    const sites = volcanicSitesInBounds(
      world, airport.centerX - 40_000, airport.centerZ - 40_000, airport.centerX + 40_000, airport.centerZ + 40_000);
    expect(sites.filter((site) => site.kind === VolcanicSiteKind.Cinder).length).toBeGreaterThan(20);
    expect(sites.some((site) => site.kind === VolcanicSiteKind.Strato)).toBe(true);
    const dirX = Math.sin(airport.headingRadians);
    const dirZ = Math.cos(airport.headingRadians);
    const halfLength = airport.runwayLength * 0.5 + VOLCANISM.forced.approachLengthMeters;
    for (const site of sites) {
      const toAirport = Math.hypot(site.x - airport.centerX, site.z - airport.centerZ);
      expect(toAirport - site.footprintRadiusMeters).toBeGreaterThanOrEqual(VOLCANISM.forced.airportClearanceMeters);
      const relX = site.x - airport.centerX;
      const relZ = site.z - airport.centerZ;
      const along = Math.max(-halfLength, Math.min(halfLength, relX * dirX + relZ * dirZ));
      const toLine = Math.hypot(relX - along * dirX, relZ - along * dirZ);
      expect(toLine - site.footprintRadiusMeters).toBeGreaterThanOrEqual(VOLCANISM.forced.approachClearanceMeters);
    }
  });

  it("leaves the airport where the natural world put it", () => {
    const natural = createWorld("ash-lab");
    expect(world.airport).toEqual(natural.airport);
    expect(sampleTerrainCollisionHeight(world, airport.centerX, airport.centerZ))
      .toBe(sampleTerrainCollisionHeight(natural, airport.centerX, airport.centerZ));
  });
});
