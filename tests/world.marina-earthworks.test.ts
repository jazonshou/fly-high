import { describe, expect, it } from "vitest";
import {
  applyInfrastructure,
  buildInfrastructureIndex,
  createWorld,
  getRunwayEnds,
  infrastructureAnchor,
  infrastructureIndex,
  sampleTerrainHeight,
  sampleTerrainHeightBeforeAirports,
  sampleTerrainHeightBeforeEarthworks,
  type InfrastructureSegment,
  type WorldDefinition,
} from "@/src/world";
import { INFRASTRUCTURE_PROFILE } from "@/src/world/infrastructureProfiles";
import { homeMarina, MARINA_SITE_RULES } from "@/src/world/marina";
import { MARINA_EARTHWORKS, marinaInfrastructure } from "@/src/world/marinaEarthworks";
import { MARINA_LAYOUT, marinaToWorld, type MarinaLayout } from "@/src/world/marinaLayout";

/**
 * The home marina's earthworks on the infrastructure stage: each profile's
 * shape on a flat test ground, then the real marina on 200 worlds, where the
 * finished ground has to be what the layout promised (berth water, the quay
 * level, the slipway's grade) and the home field must be untouched. The GPU
 * twin is held to these within a millimetre by
 * tests/gpu/marina-earthworks-parity.test.ts.
 */

const world = createWorld("open-skies");
const sea = world.seaLevel;

function segment(overrides: Partial<InfrastructureSegment>): InfrastructureSegment {
  return {
    profile: INFRASTRUCTURE_PROFILE.marinaPad,
    mode: "set",
    priority: 0,
    ax: 1_000,
    az: 2_000,
    bx: 1_100,
    bz: 2_000,
    halfWidth: 10,
    reach: 30,
    params: [1.5, 1.5, 2, 0.15],
    ...overrides,
  };
}

/** The stage over a flat ground at `ground`, with explicit segments. */
function on(segments: InfrastructureSegment[], ground: number, x: number, z: number): number {
  const index = buildInfrastructureIndex(world, [() => ({ segments })]);
  return applyInfrastructure(index, sea, ground, x, z);
}

// Segments laid a -> b along +x have +across toward -z ((dirZ, -dirX) = (0, -1)).
describe("marina earthwork profiles", () => {
  it("dredges water to depth with a 1:4 batter, and leaves the land alone", () => {
    const basin = segment({ profile: INFRASTRUCTURE_PROFILE.marinaDredge, mode: "cut", params: [3, 4, 0.3, 1.2] });
    expect(on([basin], sea - 1, 1_050, 2_000)).toBe(sea - 3);
    expect(on([basin], sea - 1, 1_000, 2_010)).toBe(sea - 3);
    // Square corners: a box, not a capsule.
    expect(on([basin], sea - 1, 1_100, 2_010)).toBe(sea - 3);
    // 4 m out of the box, a metre up the batter.
    expect(on([basin], sea - 1, 1_050, 2_014)).toBeCloseTo(sea - 2, 9);
    // Deeper water is never filled; dry land is never dug.
    expect(on([basin], sea - 7, 1_050, 2_000)).toBe(sea - 7);
    expect(on([basin], sea + 2, 1_050, 2_000)).toBe(sea + 2);
  });

  it("levels the quay apron and drops its front as a quay face", () => {
    const apron = segment({});
    expect(on([apron], sea - 3, 1_050, 2_000)).toBe(sea + 1.5);
    expect(on([apron], sea + 4, 1_050, 2_009)).toBe(sea + 1.5);
    // Front (+across = -z): 0.15 run per metre, so 4.5 m down within 0.7 m.
    expect(on([apron], sea - 3, 1_050, 1_990 - 0.675)).toBeCloseTo(sea - 3, 6);
    expect(on([apron], sea - 3, 1_050, 1_990 - 0.15)).toBeCloseTo(sea + 0.5, 6);
    // Back (-across = +z): a 1:2 batter.
    expect(on([apron], sea + 6, 1_050, 2_014)).toBeCloseTo(sea + 3.5, 6);
    // A graded car park: front level at +across, back level at -across.
    const carPark = segment({ params: [1.5, 3.5, 2, 2] });
    expect(on([carPark], sea, 1_050, 1_990)).toBeCloseTo(sea + 1.5, 9);
    expect(on([carPark], sea, 1_050, 2_010)).toBeCloseTo(sea + 3.5, 9);
    expect(on([carPark], sea, 1_050, 2_000)).toBeCloseTo(sea + 2.5, 9);
  });

  it("grades the slipway from its top to its toe", () => {
    const slip = segment({ profile: INFRASTRUCTURE_PROFILE.marinaSlipway, halfWidth: 3, reach: 12, params: [1.5, -1.5, 1.5], bx: 1_024 });
    expect(on([slip], sea - 4, 1_000, 2_000)).toBe(sea + 1.5);
    expect(on([slip], sea - 4, 1_012, 2_002)).toBeCloseTo(sea, 9);
    expect(on([slip], sea - 4, 1_024, 2_000)).toBeCloseTo(sea - 1.5, 9);
    // Its side batter, 1:1.5, down to the bed.
    expect(on([slip], sea - 4, 1_012, 2_004.5)).toBeCloseTo(sea - 1, 9);
  });

  it("raises a breakwater crest with 1:1.5 sides and round heads", () => {
    const mound = segment({
      profile: INFRASTRUCTURE_PROFILE.marinaBreakwater, mode: "fill", halfWidth: 5.5, reach: 18, params: [2, 2.5, 1.5],
    });
    expect(on([mound], sea - 5, 1_050, 2_000)).toBe(sea + 2);
    expect(on([mound], sea - 5, 1_050, 2_002.5)).toBe(sea + 2);
    expect(on([mound], sea - 5, 1_050, 2_005.5)).toBeCloseTo(sea, 9);
    expect(on([mound], sea - 5, 1_050, 2_013)).toBeCloseTo(sea - 5, 9);
    expect(on([mound], sea - 5, 1_105.5, 2_000)).toBeCloseTo(sea, 9);
    // A fill never lowers.
    expect(on([mound], sea + 4, 1_050, 2_000)).toBe(sea + 4);
  });
});

/** The plan probe's seed sequence (tests/world.marina-site.test.ts). */
function seeds(count: number): (string | number)[] {
  const out: (string | number)[] = ["open-skies"];
  let state = 0x51a7e;
  while (out.length < count) {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    out.push(state);
  }
  return out;
}

function at(w: WorldDefinition, layout: MarinaLayout, right: number, out: number): number {
  const p = marinaToWorld(layout.frame, right, out);
  return sampleTerrainHeight(w, p.x, p.z);
}

function earthworksChecks(seed: string | number, w: WorldDefinition): void {
  const layout = homeMarina(w);
  const L = MARINA_LAYOUT;
  const s = w.seaLevel;
  // Berth water: every berth's boat outline, transom to stem, at least 2.5 m deep.
  for (const berth of layout.berths) {
    const sternOut = -L.boatCgFromTransom;
    for (const along of [sternOut, 0, sternOut + L.boatLength]) {
      const sign = berth.side === "landward" ? -1 : 1;
      const right = berth.side === "fuel" ? berth.right + along : berth.right;
      const out = berth.side === "fuel" ? berth.out : berth.out + sign * along;
      expect(s - at(w, layout, right, out), `${seed}: berth ${berth.index} at ${along}`).toBeGreaterThanOrEqual(MARINA_SITE_RULES.berthDepthMeters);
    }
  }
  // The lane is navigable all the way to its end: boat draft and more.
  for (let i = 1; i < layout.lane.length; i += 1) {
    const a = layout.lane[i - 1]!;
    const b = layout.lane[i]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 5));
    for (let k = 0; k <= steps; k += 1) {
      const x = a.x + ((b.x - a.x) * k) / steps;
      const z = a.z + ((b.z - a.z) * k) / steps;
      expect(s - sampleTerrainHeight(w, x, z), `${seed}: lane leg ${i} step ${k}`).toBeGreaterThanOrEqual(2);
    }
  }
  // The quay apron is its level to the bit, with water at the wall's foot.
  expect(at(w, layout, layout.pier.right + 4, -8)).toBe(s + L.quayDeckHeight);
  expect(s - at(w, layout, 0, 0.5), `${seed}: water at the quay`).toBeGreaterThanOrEqual(2);
  // The car park front and back, and its anchor.
  const carPark = layout.carPark;
  const carParkMid = (carPark.rightMin + carPark.rightMax) * 0.5;
  expect(at(w, layout, carParkMid, carPark.outMax)).toBeCloseTo(carPark.frontY, 9);
  expect(at(w, layout, carParkMid, carPark.outMin)).toBeCloseTo(carPark.backY, 9);
  const anchor = infrastructureAnchor(w, "marinaCarPark");
  expect(anchor).not.toBeNull();
  expect(anchor!.x).toBe(layout.carParkAnchor.x);
  expect(sampleTerrainHeight(w, anchor!.x, anchor!.z)).toBeCloseTo(layout.carParkAnchor.y, 9);
  // The slipway at 1:8, top on the apron, toe under water.
  const slip = layout.slipway;
  const slipMid = (slip.outTop + slip.outToe) * 0.5;
  expect(at(w, layout, slip.right, slip.outTop)).toBeCloseTo(slip.topY, 9);
  expect(at(w, layout, slip.right, slip.outToe)).toBeCloseTo(slip.toeY, 9);
  expect(at(w, layout, slip.right, slipMid + 4) - at(w, layout, slip.right, slipMid - 4)).toBeCloseTo(-8 * L.slipwayGrade, 9);
  // The breakwater stands out of the water.
  if (layout.breakwater) {
    const bw = layout.breakwater;
    expect(at(w, layout, (bw.rightA + bw.rightB) * 0.5, bw.out)).toBeCloseTo(bw.crestY, 9);
  }
  // The home field's ground is untouched: no segment reaches it.
  const airport = w.airport!;
  for (const point of [{ x: airport.centerX, z: airport.centerZ }, ...getRunwayEnds(airport).map((end) => end.threshold)]) {
    expect(Object.is(
      sampleTerrainHeightBeforeAirports(w, point.x, point.z),
      sampleTerrainHeightBeforeEarthworks(w, point.x, point.z),
    ), `${seed}: airport ground`).toBe(true);
  }
}

describe("home marina earthworks", () => {
  it("builds the marina's ground on 200 seeds", { timeout: 300_000 }, () => {
    for (const seed of seeds(200)) earthworksChecks(seed, createWorld(seed));
  });

  it("is one source, memoised per marina, with every segment clear of the home field", () => {
    const first = marinaInfrastructure(world);
    expect(marinaInfrastructure(world)).toBe(first);
    expect(first.segments.length).toBeGreaterThanOrEqual(5);
    const index = infrastructureIndex(world);
    expect(index.segments.map((packed) => packed.segment)).toEqual(first.segments);
    // Plants keep off every built pad and the slipway; the basin plants nothing.
    for (const item of first.segments) {
      if (item.profile === INFRASTRUCTURE_PROFILE.marinaPad || item.profile === INFRASTRUCTURE_PROFILE.marinaSlipway) {
        expect(item.plantClearance).toBe(MARINA_EARTHWORKS.padPlantClearance);
        expect(item.surface).toBeDefined();
      }
    }
  });

  it("leaves ground beyond the marina's reach bit for bit", () => {
    const layout = homeMarina(world);
    for (const [right, out] of [[-400, 0], [400, -100], [0, -400], [250, 600]] as const) {
      const p = marinaToWorld(layout.frame, right, out);
      expect(Object.is(sampleTerrainHeightBeforeAirports(world, p.x, p.z), sampleTerrainHeightBeforeEarthworks(world, p.x, p.z)))
        .toBe(true);
    }
  });
});
