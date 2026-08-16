import { sampleNaturalTerrainHeight } from "./terrain";
import { mixSeed, unitFloatFromHash } from "./seed";
import type { AirportDefinition } from "./types";

type AirportFootprint = Pick<
  AirportDefinition,
  | "runwayLength"
  | "runwayWidth"
  | "endSafetyArea"
  | "shoulderWidth"
  | "terrainBlendDistance"
>;

export interface AirportSiteAssessment {
  /** Robust natural-ground datum used for the constructed runway. */
  readonly elevation: number;
  /** Lowest natural terrain beneath the runway platform, relative to sea level. */
  readonly minimumPlatformClearance: number;
  /** Natural relief that must be cut or filled beneath the hard platform. */
  readonly platformRelief: number;
  /** Greatest sampled natural grade along the runway centreline. */
  readonly longitudinalGrade: number;
  /** Greatest sampled natural grade across the runway and shoulders. */
  readonly crossGrade: number;
  /** Natural relief across the complete terrain-blend footprint. */
  readonly blendRelief: number;
  /** Lowest natural terrain in either sampled arrival/departure corridor. */
  readonly minimumApproachClearance: number;
  /** Metres by which the worst obstacle enters a conservative 3-degree approach surface. */
  readonly approachObstruction: number;
  readonly suitable: boolean;
  /** Lower scores are safer and require less terrain modification. */
  readonly score: number;
}

export interface GeneratedAirportSite {
  readonly centerX: number;
  readonly centerZ: number;
  readonly headingRadians: number;
  readonly assessment: AirportSiteAssessment;
}

interface CoarseCandidate {
  readonly centerX: number;
  readonly centerZ: number;
  readonly gradientX: number;
  readonly gradientZ: number;
  readonly score: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const PRIMARY_CANDIDATE_COUNT = 192;
const EXPANDED_CANDIDATE_COUNT = 160;
const DETAILED_PRIMARY_COUNT = 40;
const DETAILED_EXPANDED_COUNT = 8;
const DRY_PLATFORM_CLEARANCE = 8;
// These describe the untouched ground, not the finished pavement. A site may
// be technically gradeable yet still look like an implausible mountain cut in
// a low-altitude fly-by. Keep the accepted envelope deliberately conservative
// and return no airport when the bounded search cannot satisfy it.
const MAX_PLATFORM_RELIEF = 24;
const MAX_LONGITUDINAL_GRADE = 0.065;
const MAX_CROSS_GRADE = 0.12;
const MAX_BLEND_RELIEF = 50;
const MAX_AIRPORT_ELEVATION = 260;
const SITE_CACHE_LIMIT = 24;
const siteCache = new Map<string, GeneratedAirportSite | null>();

function cacheKey(
  seedHash: number,
  seaLevel: number,
  footprint: Readonly<AirportFootprint>,
  preferredHeading: number,
): string {
  return [
    seedHash >>> 0,
    seaLevel,
    footprint.runwayLength,
    footprint.runwayWidth,
    footprint.endSafetyArea,
    footprint.shoulderWidth,
    footprint.terrainBlendDistance,
    preferredHeading,
  ].join(":");
}

function rememberSite(key: string, site: GeneratedAirportSite | null): GeneratedAirportSite | null {
  if (siteCache.size >= SITE_CACHE_LIMIT) {
    const oldest = siteCache.keys().next().value as string | undefined;
    if (oldest !== undefined) siteCache.delete(oldest);
  }
  siteCache.set(key, site);
  return site;
}

function pointAt(
  centerX: number,
  centerZ: number,
  headingRadians: number,
  along: number,
  across: number,
): readonly [number, number] {
  const sinHeading = Math.sin(headingRadians);
  const cosHeading = Math.cos(headingRadians);
  return [
    centerX + along * sinHeading + across * cosHeading,
    centerZ + along * cosHeading - across * sinHeading,
  ];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length * 0.5);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) * 0.5
    : (sorted[middle] ?? 0);
}

/**
 * Evaluates the untouched terrain, never the already-flattened airport sample.
 * This distinction prevents a constructed runway from "proving" its own site
 * is dry and level after it has replaced an ocean or cut through a mountain.
 */
export function assessAirportSite(
  seedHash: number,
  seaLevel: number,
  centerX: number,
  centerZ: number,
  headingRadians: number,
  footprint: Readonly<AirportFootprint>,
): AirportSiteAssessment {
  const halfPlatformLength = footprint.runwayLength * 0.5 + footprint.endSafetyArea;
  const halfPlatformWidth = footprint.runwayWidth * 0.5 + footprint.shoulderWidth;
  // At ~185 m spacing this resolves the terrain kernel's 310 m fine octave;
  // a five-point check could step over an entire wet depression between probes.
  const platformAlong = Array.from(
    { length: 9 },
    (_, index) => -halfPlatformLength + (index / 8) * halfPlatformLength * 2,
  );
  const platformAcross = [-halfPlatformWidth, 0, halfPlatformWidth];
  const platformRows: number[][] = [];
  const platformHeights: number[] = [];

  for (const along of platformAlong) {
    const row: number[] = [];
    for (const across of platformAcross) {
      const [x, z] = pointAt(centerX, centerZ, headingRadians, along, across);
      const height = sampleNaturalTerrainHeight(seedHash, x, z);
      row.push(height);
      platformHeights.push(height);
    }
    platformRows.push(row);
  }

  const elevation = median(platformHeights);
  const platformMinimum = Math.min(...platformHeights);
  const platformMaximum = Math.max(...platformHeights);
  let longitudinalGrade = 0;
  let crossGrade = 0;
  const alongSpacing = (halfPlatformLength * 2) / (platformAlong.length - 1);
  const acrossSpacing = Math.max(1, halfPlatformWidth * 2);

  for (let rowIndex = 1; rowIndex < platformRows.length; rowIndex += 1) {
    const previous = platformRows[rowIndex - 1]?.[1] ?? elevation;
    const current = platformRows[rowIndex]?.[1] ?? elevation;
    longitudinalGrade = Math.max(longitudinalGrade, Math.abs(current - previous) / alongSpacing);
  }
  for (const row of platformRows) {
    crossGrade = Math.max(crossGrade, Math.abs((row[2] ?? elevation) - (row[0] ?? elevation)) / acrossSpacing);
  }

  // The transition footprint is checked independently. A dry runway whose
  // feathered grading extends into water still reads visually as a runway on
  // an artificial island, while extreme relief produces the mountain trench
  // reported by players.
  const blendLength = halfPlatformLength + footprint.terrainBlendDistance;
  const blendWidth = halfPlatformWidth + footprint.terrainBlendDistance;
  const blendHeights: number[] = [];
  for (const along of [-blendLength, -blendLength * 0.5, 0, blendLength * 0.5, blendLength]) {
    for (const across of [-blendWidth, 0, blendWidth]) {
      const [x, z] = pointAt(centerX, centerZ, headingRadians, along, across);
      blendHeights.push(sampleNaturalTerrainHeight(seedHash, x, z));
    }
  }
  const blendMinimum = Math.min(...blendHeights, platformMinimum);
  const blendMaximum = Math.max(...blendHeights, platformMaximum);

  // A 3-degree obstacle surface (5.24%) is sampled from both runway ends. A
  // small threshold allowance covers trees/buildings while rejecting terrain
  // walls that would make either departure or arrival implausible.
  let approachObstruction = Number.NEGATIVE_INFINITY;
  let minimumApproachHeight = Number.POSITIVE_INFINITY;
  const approachDistances = [240, 520, 940, 1_500, 2_250, 3_100, 4_200];
  for (const end of [-1, 1]) {
    for (const distance of approachDistances) {
      const corridorHalfWidth = 70 + distance * 0.095;
      const permittedHeight = elevation + 18 + distance * 0.0524;
      for (const across of [-corridorHalfWidth, 0, corridorHalfWidth]) {
        const along = end * (halfPlatformLength + distance);
        const [x, z] = pointAt(centerX, centerZ, headingRadians, along, across);
        const height = sampleNaturalTerrainHeight(seedHash, x, z);
        // Keep the near-field approach on land so the paved strip cannot read
        // as an offshore platform. Farther portions may legitimately cross a
        // lake or coastline while still being obstacle-safe.
        if (distance <= 520) minimumApproachHeight = Math.min(minimumApproachHeight, height);
        approachObstruction = Math.max(approachObstruction, height - permittedHeight);
      }
    }
  }

  const platformRelief = platformMaximum - platformMinimum;
  const blendRelief = blendMaximum - blendMinimum;
  const minimumPlatformClearance = platformMinimum - seaLevel;
  const minimumApproachClearance = minimumApproachHeight - seaLevel;
  const suitable =
    minimumPlatformClearance >= DRY_PLATFORM_CLEARANCE &&
    blendMinimum >= seaLevel + 2 &&
    elevation <= seaLevel + MAX_AIRPORT_ELEVATION &&
    platformRelief <= MAX_PLATFORM_RELIEF &&
    longitudinalGrade <= MAX_LONGITUDINAL_GRADE &&
    crossGrade <= MAX_CROSS_GRADE &&
    blendRelief <= MAX_BLEND_RELIEF &&
    minimumApproachClearance >= 2 &&
    approachObstruction <= 0;
  const score =
    Math.max(0, DRY_PLATFORM_CLEARANCE - minimumPlatformClearance) * 240 +
    Math.max(0, seaLevel + 2 - blendMinimum) * 180 +
    Math.max(0, 2 - minimumApproachClearance) * 90 +
    platformRelief * 7 +
    longitudinalGrade * 1_400 +
    crossGrade * 360 +
    blendRelief * 1.8 +
    Math.max(0, approachObstruction) * 12 +
    Math.max(0, elevation - (seaLevel + 220)) * 0.75;

  return Object.freeze({
    elevation,
    minimumPlatformClearance,
    platformRelief,
    longitudinalGrade,
    crossGrade,
    blendRelief,
    minimumApproachClearance,
    approachObstruction,
    suitable,
    score,
  });
}

function createCoarseCandidates(
  seedHash: number,
  seaLevel: number,
  count: number,
  startIndex: number,
): CoarseCandidate[] {
  const candidates: CoarseCandidate[] = [];
  const angleOffset = unitFloatFromHash(mixSeed(seedHash, 714)) * Math.PI * 2;
  const radialJitter = 0.82 + unitFloatFromHash(mixSeed(seedHash, 715)) * 0.36;

  for (let localIndex = 0; localIndex < count; localIndex += 1) {
    const index = startIndex + localIndex;
    // A denser low-discrepancy spiral searches actual buildable pockets near
    // the origin instead of jumping between widely separated mountain cells.
    const radius = index === 0 ? 0 : 3_200 * Math.sqrt(index) * radialJitter;
    const angle = angleOffset + index * GOLDEN_ANGLE;
    const centerX = Math.cos(angle) * radius;
    const centerZ = Math.sin(angle) * radius;
    const probeDistance = 820;
    const center = sampleNaturalTerrainHeight(seedHash, centerX, centerZ);
    const west = sampleNaturalTerrainHeight(seedHash, centerX - probeDistance, centerZ);
    const east = sampleNaturalTerrainHeight(seedHash, centerX + probeDistance, centerZ);
    const south = sampleNaturalTerrainHeight(seedHash, centerX, centerZ - probeDistance);
    const north = sampleNaturalTerrainHeight(seedHash, centerX, centerZ + probeDistance);
    const minimum = Math.min(center, west, east, south, north);
    const maximum = Math.max(center, west, east, south, north);
    const relief = maximum - minimum;
    const dryPenalty = Math.max(0, seaLevel + 10 - minimum) * 260;
    const alpinePenalty = Math.max(0, center - (seaLevel + 220)) * 4;
    candidates.push({
      centerX,
      centerZ,
      gradientX: (east - west) / (probeDistance * 2),
      gradientZ: (north - south) / (probeDistance * 2),
      score: dryPenalty + alpinePenalty + relief * 3.4 + Math.max(0, center - seaLevel) * 0.025,
    });
  }

  return candidates.sort((left, right) => left.score - right.score);
}

function axisDifference(left: number, right: number): number {
  const difference = Math.abs(Math.atan2(Math.sin(left - right), Math.cos(left - right)));
  return Math.min(difference, Math.PI - difference);
}

function assessDetailedCandidates(
  seedHash: number,
  seaLevel: number,
  footprint: Readonly<AirportFootprint>,
  preferredHeading: number,
  coarseCandidates: readonly CoarseCandidate[],
  limit: number,
): GeneratedAirportSite[] {
  const sites: GeneratedAirportSite[] = [];
  const detailedCandidates = coarseCandidates.slice(0, limit);
  for (let candidateIndex = 0; candidateIndex < detailedCandidates.length; candidateIndex += 1) {
    const candidate = detailedCandidates[candidateIndex]!;
    // A contour-following runway minimizes grade. Wind alignment remains a
    // candidate too, but cannot override terrain and obstacle safety.
    const contourHeading = Math.atan2(candidate.gradientZ, -candidate.gradientX);
    const headings = [contourHeading, preferredHeading];
    // Reserve the third-heading budget for only the best coarse candidates so
    // the same number of full footprint assessments covers more possible
    // sites. This catches flat pockets the wide spiral would otherwise skip.
    if (candidateIndex < Math.ceil(limit * 0.4)) {
      headings.splice(1, 0, contourHeading + Math.PI * 0.25);
    }
    for (const heading of headings) {
      const normalizedHeading = ((heading % Math.PI) + Math.PI) % Math.PI;
      const assessment = assessAirportSite(
        seedHash,
        seaLevel,
        candidate.centerX,
        candidate.centerZ,
        normalizedHeading,
        footprint,
      );
      // Crosswind is a tie-breaker after terrain work and obstacle clearance.
      const windPenalty = axisDifference(normalizedHeading, preferredHeading) * 4;
      sites.push({
        centerX: candidate.centerX,
        centerZ: candidate.centerZ,
        headingRadians: normalizedHeading,
        assessment: Object.freeze({ ...assessment, score: assessment.score + windPenalty }),
      });
    }
  }
  return sites.sort((left, right) => {
    if (left.assessment.suitable !== right.assessment.suitable) {
      return left.assessment.suitable ? -1 : 1;
    }
    return left.assessment.score - right.assessment.score;
  });
}

/**
 * Deterministically locates a buildable starter airport. The first pass keeps
 * ordinary starts close to the seed origin; an expanded pass is the bounded,
 * safe fallback for seeds whose origin lies in ocean or alpine terrain.
 */
export function findGeneratedAirportSite(
  seedHash: number,
  seaLevel: number,
  footprint: Readonly<AirportFootprint>,
  preferredHeading: number,
): GeneratedAirportSite | null {
  const key = cacheKey(seedHash, seaLevel, footprint, preferredHeading);
  if (siteCache.has(key)) return siteCache.get(key) ?? null;
  const primary = createCoarseCandidates(seedHash, seaLevel, PRIMARY_CANDIDATE_COUNT, 0);
  const primarySites = assessDetailedCandidates(
    seedHash,
    seaLevel,
    footprint,
    preferredHeading,
    primary,
    DETAILED_PRIMARY_COUNT,
  );
  const primarySuitable = primarySites.find((site) => site.assessment.suitable);
  if (primarySuitable) return rememberSite(key, primarySuitable);

  const expanded = createCoarseCandidates(
    seedHash,
    seaLevel,
    EXPANDED_CANDIDATE_COUNT,
    PRIMARY_CANDIDATE_COUNT,
  );
  const expandedSites = assessDetailedCandidates(
    seedHash,
    seaLevel,
    footprint,
    preferredHeading,
    expanded,
    DETAILED_EXPANDED_COUNT,
  );
  const expandedSuitable = expandedSites.find((site) => site.assessment.suitable);
  if (expandedSuitable) return rememberSite(key, expandedSuitable);

  // Safety is preferable to constructing a conspicuously impossible airport.
  // An airport-less world remains fully flyable from its airborne start and is
  // the deterministic fallback if neither bounded search finds a valid site.
  return rememberSite(key, null);
}
