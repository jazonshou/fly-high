import { sampleClimateProvince, terrainThermalHeight } from "../climateProvince";
import { borealShare, tundraShare } from "../coldBiomes";
import { tropicalCoastWeight } from "../tropicalCoast";
import type { WorldDefinition } from "../types";
import { createVolcanicGroundSample, sampleVolcanicGround } from "../volcanism";
import type { StructureFoundation, StructureStyle } from "../structures/structureRecord";

/**
 * Which regional accent a settlement takes, and the numbers its layout reads
 * per accent (the plan's "Where structures go" and "Styles per biome").
 * Calibrated on 1 November 2026 with every road layer built over a 24 km
 * window round the home airport (`scripts/settlements-probe.mts --half
 * 12000`) to 100 buildings per 100 km² of the default world's land, 78 to
 * 103 across the provinces. (The plan's own probe built the tracks only
 * within their 5 km stream window of the road head, so it counted far fewer
 * farms than the game, which streams tracks round the player everywhere.)
 *
 * One style per settlement, read at its anchor, so a hamlet is never half
 * one style; where two provinces meet, neighbouring settlements fall either
 * way as their anchors do.
 */

/** Thermal height above which a settlement is alpine, metres (the plan's 1,050 m). */
export const SETTLEMENT_ALPINE_THERMAL_METERS = 1_050;

const PROVINCE = { temperatureOffset: 0, dryness: 0 };

/** The style at a point whose ground (before earthworks) stands at `height`. */
export function settlementStyleAt(world: WorldDefinition, x: number, z: number, height: number): StructureStyle {
  const province = sampleClimateProvince(world, x, z, PROVINCE);
  if (tundraShare(province.temperatureOffset) > 0.5) return "tundra";
  if (terrainThermalHeight(height - world.seaLevel, province.temperatureOffset) > SETTLEMENT_ALPINE_THERMAL_METERS) {
    return "alpine";
  }
  if (borealShare(province.temperatureOffset) > 0.5) return "boreal";
  if (tropicalCoastWeight(province.temperatureOffset, province.dryness) > 0.5) return "tropical";
  if (province.dryness >= 0.35) return "desert";
  if (province.dryness >= 0.15) return "savanna";
  return "temperate";
}

const VOLCANIC = createVolcanicGroundSample();

/**
 * Whether a settlement builds in basalt: old lava or tephra under its anchor
 * (fresh lava is no ground for building, `roadGroundAt` refuses it).
 */
export function settlementBasaltAt(world: WorldDefinition, x: number, z: number): boolean {
  sampleVolcanicGround(world, x, z, 0, VOLCANIC);
  return VOLCANIC.lavaCover + VOLCANIC.tephraCover > 0.2;
}

export interface SettlementStyleRule {
  /** Share of road-served gravel nodes given a hamlet. */
  readonly hamlet: number;
  /** Share of road-served track nodes given a farmstead (or ranch). */
  readonly farmstead: number;
  /** Share of track ends (a node with one road) given an outpost instead. */
  readonly outpost: number;
  /** Share of the cabin lattice's cells given a cabin. */
  readonly cabin: number;
  /** Share of the lookout lattice's summits given a fire lookout. */
  readonly lookout: number;
  /** Share of the lighthouse lattice's headlands given a lighthouse. */
  readonly lighthouse: number;
  /** Buildings in a hamlet, inclusive. */
  readonly hamletSize: readonly [number, number];
  /** A roadside spot every this many metres of road on average (`ROADSIDE_OCCUPANCY` of them get a farm). */
  readonly roadsideSpacing: number;
  /**
   * Most the ground may vary under a footprint, metres: what the pad's cut
   * and fill (or the posts) can take.
   */
  readonly relief: number;
  readonly foundation: StructureFoundation;
  /**
   * `plinth`: the plinth's height above the pad, metres (low, high).
   * `posts`: the posts' least height under the highest corner, metres.
   */
  readonly foundationHeight: readonly [number, number];
  /** A house's body, across the front and front to back, metres. */
  readonly house: readonly [number, number];
  /** Storeys a house has. */
  readonly houseStoreys: number;
}

export const SETTLEMENT_STYLE_RULES: Readonly<Record<StructureStyle, SettlementStyleRule>> = Object.freeze({
  temperate: {
    hamlet: 0.7, farmstead: 0.36, outpost: 0.15, cabin: 0.12, lookout: 0.3, lighthouse: 0.6,
    hamletSize: [5, 10], roadsideSpacing: 1_100, relief: 2.5,
    foundation: "plinth", foundationHeight: [0.3, 0.6], house: [11, 8], houseStoreys: 2,
  },
  boreal: {
    hamlet: 0.45, farmstead: 0.28, outpost: 0.3, cabin: 0.22, lookout: 0.45, lighthouse: 0.5,
    hamletSize: [3, 7], roadsideSpacing: 1_250, relief: 2.5,
    foundation: "plinth", foundationHeight: [0.4, 0.7], house: [9, 7.5], houseStoreys: 2,
  },
  tundra: {
    hamlet: 0.2, farmstead: 0.19, outpost: 0.45, cabin: 0.1, lookout: 0, lighthouse: 0.35,
    hamletSize: [2, 5], roadsideSpacing: 1_700, relief: 2.5,
    foundation: "posts", foundationHeight: [0.5, 1], house: [8, 6], houseStoreys: 1,
  },
  alpine: {
    hamlet: 0.15, farmstead: 0.12, outpost: 0.4, cabin: 0.1, lookout: 0.35, lighthouse: 0,
    hamletSize: [2, 5], roadsideSpacing: 1_500, relief: 3,
    foundation: "plinth", foundationHeight: [0.3, 0.5], house: [10, 8], houseStoreys: 2,
  },
  desert: {
    hamlet: 0.45, farmstead: 0.28, outpost: 0.35, cabin: 0.05, lookout: 0.1, lighthouse: 0.4,
    hamletSize: [3, 7], roadsideSpacing: 1_100, relief: 2,
    foundation: "plinth", foundationHeight: [0.2, 0.4], house: [13, 9], houseStoreys: 1,
  },
  savanna: {
    hamlet: 0.45, farmstead: 0.28, outpost: 0.2, cabin: 0.06, lookout: 0.15, lighthouse: 0.5,
    hamletSize: [4, 8], roadsideSpacing: 1_150, relief: 2.5,
    foundation: "plinth", foundationHeight: [0.5, 0.8], house: [12, 9], houseStoreys: 1,
  },
  tropical: {
    hamlet: 0.65, farmstead: 0.33, outpost: 0.1, cabin: 0.1, lookout: 0.1, lighthouse: 0.6,
    hamletSize: [5, 10], roadsideSpacing: 1_200, relief: 3,
    foundation: "posts", foundationHeight: [1, 1.5], house: [10, 8], houseStoreys: 1,
  },
} satisfies Record<StructureStyle, SettlementStyleRule>);

export function settlementStyleRule(style: StructureStyle): SettlementStyleRule {
  return SETTLEMENT_STYLE_RULES[style];
}
