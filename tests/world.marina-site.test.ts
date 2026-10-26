import { describe, expect, it } from "vitest";
import {
  createWorld,
  getAirportInfluence,
  sampleTerrainHeightBeforeEarthworks,
  spawnedAirportGroundAllowed,
  withAirports,
  worldToRunway,
  type WorldDefinition,
} from "@/src/world";
import {
  homeMarina,
  homeMarinaSite,
  homeMarinaSiteStats,
  MARINA_SITE_RULES,
  marinaStartPose,
} from "@/src/world/marina";
import { MARINA_LAYOUT, marinaToWorld, worldToMarina, type MarinaLayout } from "@/src/world/marinaLayout";

/** The plan probe's seed sequence: "open-skies" and then a fixed xorshift-multiply walk. */
function seeds(count: number): (string | number)[] {
  const out: (string | number)[] = ["open-skies"];
  let state = 0x51a7e;
  while (out.length < count) {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    out.push(state);
  }
  return out;
}

const SEEDS_200 = seeds(200);
const WORLDS = new Map<string | number, WorldDefinition>();
function world(seed: string | number): WorldDefinition {
  let found = WORLDS.get(seed);
  if (!found) {
    found = createWorld(seed);
    WORLDS.set(seed, found);
  }
  return found;
}

function depthAt(w: WorldDefinition, x: number, z: number): number {
  return w.seaLevel - sampleTerrainHeightBeforeEarthworks(w, x, z);
}

/** Distance from a point to a segment, metres. */
function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

describe("home marina site", () => {
  it("finds a site on 200 seeds, every one passing the hard rules", { timeout: 120_000 }, () => {
    const rungs = new Map<string, number>();
    for (const seed of SEEDS_200) {
      const w = world(seed);
      const site = homeMarinaSite(w);
      rungs.set(site.rung, (rungs.get(site.rung) ?? 0) + 1);
      const airport = w.airport!;
      // Outside the approach surfaces and the airport's earthworks.
      const local = worldToRunway(airport, site.x, site.z);
      const insideApproach = Math.abs(local.across) < MARINA_SITE_RULES.approachHalfWidthMeters
        && Math.abs(local.along) < airport.runwayLength * 0.5 + MARINA_SITE_RULES.approachLengthMeters;
      expect(insideApproach, `${seed}: inside the approach surfaces`).toBe(false);
      expect(getAirportInfluence(airport, site.x, site.z), `${seed}: on the airport's earthworks`).toBe(0);
      // The volcanic and sand vetoes.
      expect(spawnedAirportGroundAllowed(w, site.x, site.z), `${seed}: vetoed ground`).toBe(true);
      // A shore: land behind, berth water within the rung's reach, open water past it.
      const out = { x: Math.sin(site.headingRadians), z: Math.cos(site.headingRadians) };
      expect(-depthAt(w, site.x - out.x * 30, site.z - out.z * 30)).toBeGreaterThanOrEqual(0.5);
      expect(Math.abs(depthAt(w, site.x, site.z))).toBeLessThan(1.5);
      expect(site.berthDepthMeters).toBeGreaterThanOrEqual(MARINA_SITE_RULES.berthDepthMeters);
      expect(site.distanceFromAirportMeters).toBeGreaterThanOrEqual(MARINA_SITE_RULES.innerRadiusMeters);
      if (site.rung === "strict" || site.rung === "graded") {
        expect(site.distanceFromAirportMeters).toBeLessThanOrEqual(MARINA_SITE_RULES.outerRadiusMeters);
        expect(site.berthDistanceMeters).toBeLessThanOrEqual(60);
      }
    }
    // Measured 2026-10-26: every one of the 200 is strict. Fewer than 190
    // means the search or the terrain moved, which deserves a look.
    expect(rungs.get("strict") ?? 0).toBeGreaterThanOrEqual(190);
  });

  it("is deterministic and memoised per home airport", () => {
    const a = createWorld("open-skies");
    const b = createWorld("open-skies");
    expect(homeMarinaSite(a)).toEqual(homeMarinaSite(b));
    expect(homeMarina(a)).toEqual(homeMarina(b));
    // Repeated calls return the same object, so they cost nothing.
    expect(homeMarina(a)).toBe(homeMarina(a));
    // A spawned airport builds a new world object; the marina stays.
    const home = a.airport!;
    const spawned = { ...home, centerX: home.centerX + 30_000, centerZ: home.centerZ + 30_000 };
    const grown = withAirports(a, [home, spawned]);
    expect(grown).not.toBe(a);
    expect(homeMarina(grown)).toBe(homeMarina(a));
  });

  it("stays inside its work budget", () => {
    let worst = 0;
    for (const seed of SEEDS_200.slice(0, 60)) worst = Math.max(worst, homeMarinaSiteStats(world(seed)).heightSamples);
    // About 4.3 us per height sample in Node, so 6,000 samples is the 25 ms
    // budget with margin; the worst of 200 seeds measured 5,681.
    expect(worst).toBeLessThanOrEqual(6_000);
    // And in time, on warm worlds whose search has not run yet.
    const times: number[] = [];
    for (const seed of seeds(230).slice(200)) {
      const w = createWorld(seed);
      const started = performance.now();
      homeMarinaSite(w);
      times.push(performance.now() - started);
    }
    times.sort((x, y) => x - y);
    expect(times[Math.floor(times.length / 2)]!).toBeLessThan(25);
  });

  it("searches from the origin when a world has no airport", () => {
    const w = createWorld("open-skies", { airport: false });
    const site = homeMarinaSite(w);
    expect(Number.isFinite(site.x) && Number.isFinite(site.z)).toBe(true);
    expect(homeMarinaSite(w)).toBe(site);
  });

  it("respects the landform vetoes in a forced volcanic desert", { timeout: 60_000 }, () => {
    for (const seed of SEEDS_200.slice(0, 8)) {
      const w = createWorld(seed, { landforms: { dunes: true, volcanic: true } });
      const site = homeMarinaSite(w);
      expect(spawnedAirportGroundAllowed(w, site.x, site.z), `${seed}`).toBe(true);
    }
  });
});

function layoutChecks(seed: string | number, layout: MarinaLayout): void {
  const L = MARINA_LAYOUT;
  const w = world(seed);
  // Every berth is clear of every fixed post by the boat's half beam.
  const start = layout.startBerth;
  expect(start.side).toBe("seaward");
  expect(start.occupied).toBe(false);
  // Bow out: the start berth's bow points along the seaward axis.
  expect(Math.cos(start.bowHeadingRadians - layout.frame.headingRadians)).toBeCloseTo(1, 9);
  // It is the outermost berth at the mouth end.
  for (const berth of layout.berths) {
    if (berth.side !== "seaward") continue;
    expect(berth.right * layout.mouthSide).toBeLessThanOrEqual(start.right * layout.mouthSide + 1e-9);
  }
  // The lane ends in open water, and no post, pontoon or breakwater stands in it.
  const end = layout.lane.at(-1)!;
  expect(depthAt(w, end.x, end.z), `${seed}: lane end`).toBeGreaterThanOrEqual(L.laneOpenWaterDepth);
  const clearance = L.boatBeam * 0.5 + 0.3;
  for (let index = 0; index + 1 < layout.lane.length; index += 1) {
    const a = layout.lane[index]!;
    const b = layout.lane[index + 1]!;
    for (const post of layout.posts) {
      if (post.kind === "cleat") continue;
      const p = marinaToWorld(layout.frame, post.right, post.out);
      expect(segmentDistance(p.x, p.z, a.x, a.z, b.x, b.z) - post.radius, `${seed}: ${post.kind} in the lane`)
        .toBeGreaterThan(clearance);
    }
    // Every metre of the leg keeps the boat's half beam off every pontoon,
    // finger and pump (all axis-aligned in the marina frame).
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    for (let d = 0; d <= length; d += 1) {
      const local = worldToMarina(layout.frame, a.x + ((b.x - a.x) * d) / length, a.z + ((b.z - a.z) * d) / length);
      for (const box of layout.boxes) {
        const gapRight = Math.abs(local.right - box.right) - box.halfRight;
        const gapOut = Math.abs(local.out - box.out) - box.halfOut;
        expect(Math.max(gapRight, gapOut), `${seed}: ${box.kind} at ${box.right},${box.out} in leg ${index}`)
          .toBeGreaterThan(clearance);
      }
    }
    if (layout.breakwater) {
      const bw = layout.breakwater;
      const a0 = marinaToWorld(layout.frame, bw.rightA, bw.out);
      const b0 = marinaToWorld(layout.frame, bw.rightB, bw.out);
      // The mound's waterline edge: crest half width plus its rise over the side slope.
      const waterline = bw.crestHalfWidth + (bw.crestY - layout.seaLevel) * bw.sideSlope;
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const px = a.x + (b.x - a.x) * t;
        const pz = a.z + (b.z - a.z) * t;
        expect(segmentDistance(px, pz, a0.x, a0.z, b0.x, b0.z), `${seed}: lane through the breakwater`)
          .toBeGreaterThan(waterline + clearance);
      }
    }
  }
  // The calm basin covers every berth.
  const e = layout.shelter;
  for (const berth of layout.berths) {
    const p = marinaToWorld(layout.frame, berth.right, berth.out);
    const dx = p.x - e.centerX;
    const dz = p.z - e.centerZ;
    const along = dx * Math.sin(e.heading) + dz * Math.cos(e.heading);
    const across = dx * Math.cos(e.heading) - dz * Math.sin(e.heading);
    expect((along / e.radiusAlong) ** 2 + (across / e.radiusAcross) ** 2, `${seed}: berth ${berth.index}`).toBeLessThanOrEqual(1);
  }
  expect(e.floor).toBeGreaterThan(0);
  expect(e.floor).toBeLessThan(1);
}

describe("home marina layout", () => {
  it("lays out a usable marina on 200 seeds", { timeout: 120_000 }, () => {
    let breakwaters = 0;
    for (const seed of SEEDS_200) {
      const layout = homeMarina(world(seed));
      layoutChecks(seed, layout);
      if (layout.breakwater) breakwaters += 1;
    }
    // Some seeds are exposed enough to need one, and most are not.
    expect(breakwaters).toBeGreaterThan(0);
    expect(breakwaters).toBeLessThan(SEEDS_200.length / 2);
  });

  it("starts the boat at the start berth, bow out, on still water", () => {
    const w = world("open-skies");
    const layout = homeMarina(w);
    const pose = marinaStartPose(w);
    const berth = layout.berths[pose.berthIndex]!;
    expect(berth.start).toBe(true);
    const local = worldToMarina(layout.frame, pose.x, pose.z);
    expect(local.right).toBeCloseTo(berth.right, 9);
    expect(local.out).toBeCloseTo(berth.out, 9);
    expect(pose.headingRadians).toBe(layout.frame.headingRadians);
    expect(pose.stillWaterY).toBe(w.seaLevel);
  });

  it("publishes the car park anchor for the road network", () => {
    const layout = homeMarina(world("open-skies"));
    const anchor = layout.carParkAnchor;
    expect(anchor.name).toBe("marinaCarPark");
    const local = worldToMarina(layout.frame, anchor.x, anchor.z);
    expect(local.out).toBeCloseTo(layout.carPark.outMin, 6);
    // Pointing inland, away from the sea.
    expect(Math.cos(anchor.headingRadians - layout.frame.headingRadians)).toBeCloseTo(-1, 9);
  });
});
