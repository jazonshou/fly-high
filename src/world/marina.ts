import { getAirportInfluence, worldToRunway } from "./airport";
import { spawnedAirportGroundAllowed } from "./airportNetwork";
import { buildMarinaLayout, marinaToWorld, type MarinaLayout } from "./marinaLayout";
import { sampleTerrainHeightBeforeEarthworks } from "./terrain";
import type { AirportDefinition, WorldDefinition } from "./types";

/**
 * The home marina's site: a deterministic shore search from the home airport.
 *
 * Every boat session starts moored here (decision D4), so the search must
 * never fail. It reads the ground BEFORE any earthworks
 * (`sampleTerrainHeightBeforeEarthworks`: the natural kernel and the landform
 * stage), because the marina's own earthworks are built from the site it
 * returns; reading the finished ground would feed them back into where the
 * marina goes.
 *
 * COARSE TO FINE. A 250 m lattice over the search annulus finds the lattice
 * edges the coastline crosses; each crossing is bisected to the waterline;
 * a few probes rank every crossing on the hard rules; and only the best
 * dozen get the full assessment (slipway shore, car-park pad, exposure,
 * drainage). About 4,000 height samples, under the 25 ms budget, where the
 * plan's full-resolution probe took 12-18 thousand and 53-98 ms.
 *
 * NEVER FAILS. The fallback ladder, in order:
 *   1. strict: every hard rule, a 1:6 to 1:15 slipway shore and a flat pad,
 *      1.2-6 km from the home airport;
 *   2. graded: the hard rules only (earthworks make up the slope and the pad);
 *   3. wide: the same two rungs 6-12 km out;
 *   4. long pier: berth water up to 200 m from the shore, out to 12 km;
 *   5. dredged: any coast with open water within 1.5 km, dredged to depth,
 *      searched outward until one is found.
 * The rung is recorded on the site, so a test can say which seeds needed it.
 *
 * Memoised per home airport: `withAirports` builds a new world object each
 * time an airport spawns but keeps the home airport object, and the marina
 * depends only on the home field and the terrain, so spawning never
 * re-searches. A world without an airport searches from the origin and is
 * memoised on the world itself.
 */

/** Hard rules and scoring constants, gathered so tests read the same numbers. */
export const MARINA_SITE_RULES = Object.freeze({
  /** The annulus searched first, metres from the home airport's centre ... */
  innerRadiusMeters: 1_200,
  /** ... the near part, whose strict sites win outright ... */
  nearRadiusMeters: 3_500,
  /** ... and the rest of the home annulus. */
  outerRadiusMeters: 6_000,
  /** The annulus the "wide" rung adds. */
  wideOuterRadiusMeters: 12_000,
  /** Coarse lattice spacing; coastline crossings are found on its edges. */
  latticeSpacingMeters: 250,
  /** Bisection steps that take a lattice crossing toward the waterline (250 m / 2^4 = 16 m), then a secant. */
  waterlineBisections: 4,
  /** A crossing whose lattice sea end is shallower than this is skipped unrefined. */
  latticeSeaDepthMeters: 2,
  /** Water a berth needs, metres below still water. */
  berthDepthMeters: 2.5,
  /** The nearest shore distances, metres, at which a berth's depth is looked for. */
  berthDistancesMeters: [30, 40, 50, 60] as readonly number[],
  /** The long-pier rung looks this far out. */
  longPierDistancesMeters: [80, 100, 125, 150, 175, 200] as readonly number[],
  /** Open water within this distance of the berth, along the seaward normal. */
  openWaterDistancesMeters: [120, 200, 300, 400] as readonly number[],
  /** Depth open water needs at distance d: min(4, 1.5 + d / 100). */
  openWaterDepthMeters: 4,
  /** The dredged rung: open water this deep within this distance along the normal. */
  dredgedOpenWaterDistancesMeters: [150, 300, 500, 800, 1_100, 1_500] as readonly number[],
  /** Runway approach surfaces: this far beyond each threshold, this half-width. */
  approachLengthMeters: 6_000,
  approachHalfWidthMeters: 600,
  /** Clearance from the home airport's earthworks blend. */
  airportClearanceMeters: 300,
  /** A slipway shore, rise over run across the waterline. */
  slipwayShoreMinSlope: 1 / 15,
  slipwayShoreMaxSlope: 1 / 6,
  /** A car-park pad's largest grade. */
  padMaxSlope: 0.1,
  /** No river mouth this close. */
  riverMouthClearanceMeters: 300,
  /** Candidates that get the full assessment, best pre-score first. */
  assessedCandidates: 14,
  /** Search radii the dredged rung steps out through, once the wide annulus has nothing. */
  dredgedSearchRadiiMeters: [6_000, 12_000, 24_000, 48_000] as readonly number[],
});

/** Which rung of the fallback ladder chose the site. */
export type MarinaSiteRung = "strict" | "graded" | "wide" | "longPier" | "dredged";

export interface MarinaSite {
  /** The waterline point the marina is built on, world metres. */
  readonly x: number;
  readonly z: number;
  /**
   * The seaward axis, radians, `atan2(out.x, out.z)` as the airport heading.
   * Marina-local `out` runs along it; `along` runs to its right
   * (`(cos h, -sin h)`), starboard when facing the sea.
   */
  readonly headingRadians: number;
  readonly rung: MarinaSiteRung;
  readonly distanceFromAirportMeters: number;
  /** Shore distance of the first berth-depth water, and that depth (natural ground). */
  readonly berthDistanceMeters: number;
  readonly berthDepthMeters: number;
  /** Rise over run across the waterline, ±12 m. */
  readonly shoreSlope: number;
  /** Largest grade over the car-park pad. */
  readonly padSlope: number;
  /** 0 sheltered .. 1 open sea on every seaward bearing. */
  readonly exposure: number;
  readonly score: number;
}

export interface MarinaSiteSearchStats {
  readonly heightSamples: number;
  readonly crossings: number;
  readonly candidates: number;
  readonly strictCandidates: number;
}

/** The home airport's centre, or the origin for a world without one. */
function searchCentre(world: WorldDefinition): { x: number; z: number } {
  return world.airport ? { x: world.airport.centerX, z: world.airport.centerZ } : { x: 0, z: 0 };
}

/** Counted height authority: ground before earthworks, relative to sea level. */
class ShoreSampler {
  samples = 0;
  constructor(private readonly world: WorldDefinition) {}
  height(x: number, z: number): number {
    this.samples += 1;
    return sampleTerrainHeightBeforeEarthworks(this.world, x, z) - this.world.seaLevel;
  }
}

/** One coastline crossing on the coarse lattice, refined to the waterline. */
interface Crossing {
  x: number;
  z: number;
  /** Seaward unit normal and its heading. */
  nx: number;
  nz: number;
  heading: number;
  radius: number;
}

interface PreAssessment {
  crossing: Crossing;
  berthDistance: number;
  berthDepth: number;
  preScore: number;
}

/** Whether a point lies inside the home runway's approach surfaces or near its earthworks. */
function airportVetoes(airport: Readonly<AirportDefinition> | null, x: number, z: number): boolean {
  if (!airport) return false;
  const local = worldToRunway(airport, x, z);
  if (
    Math.abs(local.across) < MARINA_SITE_RULES.approachHalfWidthMeters
    && Math.abs(local.along) < airport.runwayLength * 0.5 + MARINA_SITE_RULES.approachLengthMeters
  ) {
    return true;
  }
  const clearance = MARINA_SITE_RULES.airportClearanceMeters;
  // The blend reaches `terrainBlendDistance` past the platform; probing the
  // influence at the point and a clearance step toward the runway is enough
  // because the platform is convex.
  if (getAirportInfluence(airport, x, z) > 0) return true;
  const dx = airport.centerX - x;
  const dz = airport.centerZ - z;
  const length = Math.hypot(dx, dz);
  if (length < 1) return true;
  return getAirportInfluence(airport, x + (dx / length) * clearance, z + (dz / length) * clearance) > 0;
}

/**
 * Lattice edges the waterline crosses inside an annulus, each bisected to the
 * waterline and given its seaward normal from a central difference.
 */
function findCrossings(
  sampler: ShoreSampler,
  centreX: number,
  centreZ: number,
  innerRadius: number,
  outerRadius: number,
): Crossing[] {
  const spacing = MARINA_SITE_RULES.latticeSpacingMeters;
  const cells = Math.ceil(outerRadius / spacing);
  const size = cells * 2 + 1;
  const heights = new Float64Array(size * size);
  const inside = new Uint8Array(size * size);
  const innerSq = (innerRadius - spacing) ** 2;
  const outerSq = (outerRadius + spacing) ** 2;
  for (let row = 0; row < size; row += 1) {
    const dz = (row - cells) * spacing;
    for (let column = 0; column < size; column += 1) {
      const dx = (column - cells) * spacing;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq < innerSq || distanceSq > outerSq) continue;
      const index = row * size + column;
      inside[index] = 1;
      heights[index] = sampler.height(centreX + dx, centreZ + dz);
    }
  }
  const crossings: Crossing[] = [];
  const consider = (a: number, b: number, ax: number, az: number, bx: number, bz: number) => {
    if (!inside[a] || !inside[b]) return;
    const ha = heights[a]!;
    const hb = heights[b]!;
    if ((ha > 0) === (hb > 0)) return;
    // A berth needs 2.5 m within 60 m of the shore; a lattice sea end shallower
    // than this a whole lattice step out is a flat that cannot give it, and
    // skipping it before refinement is most of the search's saving.
    if (-Math.min(ha, hb) < MARINA_SITE_RULES.latticeSeaDepthMeters) return;
    // Bisect toward the waterline, land end kept positive, then one secant.
    let landX = ha > 0 ? ax : bx;
    let landZ = ha > 0 ? az : bz;
    let landH = Math.max(ha, hb);
    let seaX = ha > 0 ? bx : ax;
    let seaZ = ha > 0 ? bz : az;
    let seaH = Math.min(ha, hb);
    for (let step = 0; step < MARINA_SITE_RULES.waterlineBisections; step += 1) {
      const midX = (landX + seaX) * 0.5;
      const midZ = (landZ + seaZ) * 0.5;
      const midH = sampler.height(midX, midZ);
      if (midH > 0) {
        landX = midX;
        landZ = midZ;
        landH = midH;
      } else {
        seaX = midX;
        seaZ = midZ;
        seaH = midH;
      }
    }
    const t = landH / (landH - seaH);
    const x = landX + (seaX - landX) * t;
    const z = landZ + (seaZ - landZ) * t;
    const radius = Math.hypot(x - centreX, z - centreZ);
    if (radius < innerRadius || radius > outerRadius) return;
    const delta = 10;
    const gx = (sampler.height(x + delta, z) - sampler.height(x - delta, z)) / (2 * delta);
    const gz = (sampler.height(x, z + delta) - sampler.height(x, z - delta)) / (2 * delta);
    const g = Math.hypot(gx, gz);
    if (g < 1e-4) return;
    const nx = -gx / g;
    const nz = -gz / g;
    crossings.push({ x, z, nx, nz, heading: Math.atan2(nx, nz), radius });
  };
  for (let row = 0; row < size; row += 1) {
    const z0 = centreZ + (row - cells) * spacing;
    for (let column = 0; column < size; column += 1) {
      const x0 = centreX + (column - cells) * spacing;
      const index = row * size + column;
      if (column + 1 < size) consider(index, index + 1, x0, z0, x0 + spacing, z0);
      if (row + 1 < size) consider(index, index + size, x0, z0, x0, z0 + spacing);
    }
  }
  return crossings;
}

/** The hard rules a crossing must pass on one rung, and its pre-score. */
function preAssess(
  world: WorldDefinition,
  sampler: ShoreSampler,
  crossing: Crossing,
  berthDistances: readonly number[],
  openWaterDistances: readonly number[],
): PreAssessment | null {
  const { x, z, nx, nz } = crossing;
  if (airportVetoes(world.airport, x, z)) return null;
  // Land behind the waterline: a shore, not a reef or a sea-level pan.
  if (sampler.height(x - nx * 30, z - nz * 30) < 0.5) return null;
  let berthDistance = -1;
  let berthDepth = 0;
  for (const distance of berthDistances) {
    const depth = -sampler.height(x + nx * distance, z + nz * distance);
    if (depth >= MARINA_SITE_RULES.berthDepthMeters) {
      berthDistance = distance;
      berthDepth = depth;
      break;
    }
  }
  if (berthDistance < 0) return null;
  for (const distance of openWaterDistances) {
    const need = Math.min(MARINA_SITE_RULES.openWaterDepthMeters, 1.5 + distance / 100);
    if (-sampler.height(x + nx * (berthDistance + distance), z + nz * (berthDistance + distance)) < need) {
      return null;
    }
  }
  if (!spawnedAirportGroundAllowed(world, x, z)) return null;
  if (!spawnedAirportGroundAllowed(world, x - nx * 60, z - nz * 60)) return null;
  // Short piers and a home near the airport first; the full assessment decides.
  const preScore = -berthDistance / 60 - crossing.radius / 12_000;
  return { crossing, berthDistance, berthDepth, preScore };
}

interface Assessment {
  readonly site: MarinaSite;
  readonly strict: boolean;
}

/** The full assessment: slipway shore, pad, straight shore, exposure, drainage. */
function assess(
  world: WorldDefinition,
  sampler: ShoreSampler,
  candidate: PreAssessment,
  rung: MarinaSiteRung,
): Assessment {
  const { x, z, nx, nz, heading, radius } = candidate.crossing;
  const tx = nz;
  const tz = -nx;
  const h = (along: number, out: number) => sampler.height(x + tx * along + nx * out, z + tz * along + nz * out);

  const shoreSlope = (h(0, -12) - h(0, 12)) / 24;
  // The car park: 14-50 m behind the waterline, 56 m along the shore.
  const padCentre = h(0, -32);
  const padSlope = Math.max(
    Math.abs(h(0, -50) - h(0, -14)) / 36,
    Math.abs(h(28, -32) - h(-28, -32)) / 56,
    Math.abs(h(28, -32) - padCentre) / 28,
    Math.abs(h(-28, -32) - padCentre) / 28,
  );
  // A straight shore keeps the quay cut small: the waterline 30 m either side.
  const shoreOffset = (Math.abs(h(30, 0)) + Math.abs(h(-30, 0))) / Math.max(shoreSlope, 0.02);
  // Exposure: the fraction of seaward bearings with open water 2 km out.
  let open = 0;
  const bearings = 7;
  for (let index = 0; index < bearings; index += 1) {
    const angle = ((index / (bearings - 1)) - 0.5) * Math.PI * 0.8;
    const ox = nx * Math.cos(angle) + tx * Math.sin(angle);
    const oz = nz * Math.cos(angle) + tz * Math.sin(angle);
    let clear = true;
    for (const distance of [500, 1_000, 2_000]) {
      if (sampler.height(x + ox * distance, z + oz * distance) > -1) {
        clear = false;
        break;
      }
    }
    if (clear) open += 1;
  }
  // The prevailing wind blowing onshore (from the sea) doubles the exposure's weight.
  const windTowardX = Math.sin(world.prevailingWindRadians);
  const windTowardZ = Math.cos(world.prevailingWindRadians);
  const onshore = Math.max(0, -(windTowardX * nx + windTowardZ * nz));
  const exposure = (open / bearings) * (0.5 + 0.5 * onshore);
  // Drainage: a shore at the foot of a valley is where a river would reach
  // the sea. The analytic world's tracer draws almost no rivers, so this is a
  // landform proxy rather than a hydrology query: the ground 300 m inland
  // lower than 200 m either side of it.
  const inland = h(0, -MARINA_SITE_RULES.riverMouthClearanceMeters);
  const valleyDepth = Math.min(h(200, -300), h(-200, -300)) - inland;
  const riverMouth = valleyDepth > 8;

  const slopeScore = shoreSlope >= MARINA_SITE_RULES.slipwayShoreMinSlope
    && shoreSlope <= MARINA_SITE_RULES.slipwayShoreMaxSlope
    ? 1
    : shoreSlope < MARINA_SITE_RULES.slipwayShoreMinSlope
      ? Math.max(0, shoreSlope) * 15
      : MARINA_SITE_RULES.slipwayShoreMaxSlope / shoreSlope;
  const padScore = padSlope <= MARINA_SITE_RULES.padMaxSlope ? 1 : MARINA_SITE_RULES.padMaxSlope / padSlope;
  const straightScore = 1 / (1 + shoreOffset / 20);
  const shelterScore = 1 - exposure;
  const score = slopeScore + padScore + 0.5 * straightScore + 2 * shelterScore
    - (riverMouth ? 1 : 0)
    - candidate.berthDistance / 120
    - Math.max(0, radius - 2_000) / 10_000;
  const strict = slopeScore === 1 && padScore === 1 && !riverMouth;
  return {
    strict,
    site: Object.freeze({
      x,
      z,
      headingRadians: heading,
      rung: rung === "graded" && strict ? "strict" : rung,
      distanceFromAirportMeters: radius,
      berthDistanceMeters: candidate.berthDistance,
      berthDepthMeters: candidate.berthDepth,
      shoreSlope,
      padSlope,
      exposure,
      score,
    }),
  };
}

/**
 * The best assessed candidate: the top `assessedCandidates` by pre-score get
 * the full assessment, and a strict site beats any graded one.
 */
function bestOf(
  world: WorldDefinition,
  sampler: ShoreSampler,
  candidates: PreAssessment[],
  rung: MarinaSiteRung,
): { best: Assessment | null; strict: number } {
  candidates.sort((a, b) => b.preScore - a.preScore || a.crossing.x - b.crossing.x || a.crossing.z - b.crossing.z);
  let best: Assessment | null = null;
  let strict = 0;
  const limit = Math.min(candidates.length, MARINA_SITE_RULES.assessedCandidates);
  for (let index = 0; index < limit; index += 1) {
    const assessment = assess(world, sampler, candidates[index]!, rung);
    if (assessment.strict) strict += 1;
    if (
      !best
      || (assessment.strict && !best.strict)
      || (assessment.strict === best.strict && assessment.site.score > best.site.score)
    ) {
      best = assessment;
    }
  }
  return { best, strict };
}

interface SearchResult {
  readonly site: MarinaSite;
  readonly stats: MarinaSiteSearchStats;
}

function searchMarinaSite(world: WorldDefinition): SearchResult {
  const sampler = new ShoreSampler(world);
  const centre = searchCentre(world);
  const rules = MARINA_SITE_RULES;
  let crossingCount = 0;
  let candidateCount = 0;
  let strictCount = 0;
  const finish = (site: MarinaSite): SearchResult => ({
    site,
    stats: Object.freeze({
      heightSamples: sampler.samples,
      crossings: crossingCount,
      candidates: candidateCount,
      strictCandidates: strictCount,
    }),
  });
  const annulus = (inner: number, outer: number) => {
    const crossings = findCrossings(sampler, centre.x, centre.z, inner, outer);
    crossingCount += crossings.length;
    return crossings;
  };
  const candidatesOf = (crossings: readonly Crossing[], berth: readonly number[]) => {
    const out: PreAssessment[] = [];
    for (const crossing of crossings) {
      const candidate = preAssess(world, sampler, crossing, berth, rules.openWaterDistancesMeters);
      if (candidate) out.push(candidate);
    }
    candidateCount += out.length;
    return out;
  };
  const best = (candidates: PreAssessment[], rung: MarinaSiteRung) => {
    const result = bestOf(world, sampler, candidates, rung);
    strictCount += result.strict;
    return result.best;
  };

  // Rung 1, near first: a strict site within 3.5 km wins outright.
  const near = annulus(rules.innerRadiusMeters, rules.nearRadiusMeters);
  const nearCandidates = candidatesOf(near, rules.berthDistancesMeters);
  const nearBest = best(nearCandidates, "graded");
  if (nearBest?.strict) return finish(nearBest.site);
  // Rungs 1-2 over the whole home annulus: strict if any, else graded.
  const far = annulus(rules.nearRadiusMeters, rules.outerRadiusMeters);
  const farBest = best(candidatesOf(far, rules.berthDistancesMeters), "graded");
  const home = [nearBest, farBest].filter((a): a is Assessment => a !== null)
    .sort((a, b) => Number(b.strict) - Number(a.strict) || b.site.score - a.site.score)[0];
  if (home) return finish(home.site);
  // Rung 3: the wide annulus.
  const wide = annulus(rules.outerRadiusMeters, rules.wideOuterRadiusMeters);
  const wideBest = best(candidatesOf(wide, rules.berthDistancesMeters), "wide");
  if (wideBest) return finish(wideBest.site);
  // Rung 4: a long pier reaches the berth water, anywhere out to 12 km.
  const all = near.concat(far, wide);
  const longPier = best(candidatesOf(all, rules.longPierDistancesMeters), "longPier");
  if (longPier) return finish(longPier.site);
  // Rung 5: dredge the basin and its channel; widen until a coast is found.
  let inner = 0;
  for (const outer of rules.dredgedSearchRadiiMeters) {
    const crossings = outer <= rules.wideOuterRadiusMeters
      ? all.filter((crossing) => crossing.radius >= inner && crossing.radius <= outer)
      : annulus(inner, outer);
    const dredged = candidatesOfDredged(world, sampler, crossings);
    candidateCount += dredged.length;
    const dredgedBest = best(dredged, "dredged");
    if (dredgedBest) return finish(dredgedBest.site);
    inner = outer;
  }
  throw new Error(`No coast within ${rules.dredgedSearchRadiiMeters.at(-1)} m of the home airport`);
}

/**
 * The dredged rung's candidates: any shore with water in front of it and open
 * water somewhere within 1.5 km along the normal. The basin and a channel to
 * that water are cut by the dredged-basin profile.
 */
function candidatesOfDredged(
  world: WorldDefinition,
  sampler: ShoreSampler,
  crossings: readonly Crossing[],
): PreAssessment[] {
  const out: PreAssessment[] = [];
  for (const crossing of crossings) {
    const { x, z, nx, nz } = crossing;
    if (airportVetoes(world.airport, x, z)) continue;
    if (sampler.height(x - nx * 30, z - nz * 30) < 0.5) continue;
    if (sampler.height(x + nx * 60, z + nz * 60) >= 0) continue;
    let openAt = -1;
    for (const distance of MARINA_SITE_RULES.dredgedOpenWaterDistancesMeters) {
      if (-sampler.height(x + nx * distance, z + nz * distance) >= MARINA_SITE_RULES.openWaterDepthMeters) {
        openAt = distance;
        break;
      }
    }
    if (openAt < 0) continue;
    if (!spawnedAirportGroundAllowed(world, x, z)) continue;
    const depth = -sampler.height(x + nx * 60, z + nz * 60);
    out.push({ crossing, berthDistance: 60, berthDepth: depth, preScore: -openAt / 1_500 - crossing.radius / 48_000 });
  }
  return out;
}

const BY_AIRPORT = new WeakMap<Readonly<AirportDefinition>, SearchResult>();
const BY_WORLD = new WeakMap<WorldDefinition, SearchResult>();

function searchResult(world: WorldDefinition): SearchResult {
  const key = world.airport;
  const cached = key ? BY_AIRPORT.get(key) : BY_WORLD.get(world);
  if (cached) return cached;
  const result = searchMarinaSite(world);
  if (key) BY_AIRPORT.set(key, result);
  else BY_WORLD.set(world, result);
  return result;
}

/** The home marina's site, searched once per home airport. */
export function homeMarinaSite(world: WorldDefinition): MarinaSite {
  return searchResult(world).site;
}

/** What the search cost, for the budget test and the probe. */
export function homeMarinaSiteStats(world: WorldDefinition): MarinaSiteSearchStats {
  return searchResult(world).stats;
}

const LAYOUTS = new WeakMap<MarinaSite, MarinaLayout>();

/**
 * The home marina: its site and its whole layout, built once per home
 * airport. Cheap to call repeatedly; never called by `createWorld`, so a
 * world costs nothing until something asks for its marina.
 */
export function homeMarina(world: WorldDefinition): MarinaLayout {
  const site = homeMarinaSite(world);
  let layout = LAYOUTS.get(site);
  if (!layout) {
    layout = buildMarinaLayout(world, site, (x, z) => sampleTerrainHeightBeforeEarthworks(world, x, z));
    LAYOUTS.set(site, layout);
  }
  return layout;
}

/**
 * Where a boat session starts (decision D4): the start berth, bow out.
 * `stillWaterY` is world Y of the still sea there; the simulator places its
 * hull at its own equilibrium draft on the calmed surface.
 */
export interface MarinaStartPose {
  readonly x: number;
  readonly z: number;
  readonly stillWaterY: number;
  readonly headingRadians: number;
  readonly berthIndex: number;
}

export function marinaStartPose(world: WorldDefinition): MarinaStartPose {
  const layout = homeMarina(world);
  const berth = layout.startBerth;
  const point = marinaToWorld(layout.frame, berth.right, berth.out);
  return Object.freeze({
    x: point.x,
    z: point.z,
    stillWaterY: layout.seaLevel,
    headingRadians: berth.bowHeadingRadians,
    berthIndex: berth.index,
  });
}
