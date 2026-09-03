import { describe, expect, it } from "vitest";

import {
  classifyLandCover,
  landCoverSuitabilities,
  type LandCoverInput,
} from "../src/render/webgpu/terrain/LandCoverClassifier";
import {
  CANOPY_CLOSURE_FILTER_WIDTH_METERS,
  densityField,
} from "../src/render/webgpu/detail/densityField";
import {
  SURFACE_MATERIALS,
  SurfaceMaterial,
  type SurfaceMaterialId,
} from "../src/render/webgpu/terrain/surfaceMaterials";
import {
  createWorld,
  sampleTerrain,
  TERRAIN_REFERENCE_DAY_OF_YEAR,
  type WorldDefinition,
} from "../src/world";
import { sunDirectionForClock } from "../src/render/webgpu/nature/EnvironmentDirector";
import {
  headingVectorFromYaw,
  locateShotOffset,
  yawForSunBearing,
} from "../scripts/perf-capture.mts";

const WORLD = createWorld("phase1-perf-baseline", { worldEvolution: "analytic" });
const AIRPORT_X = WORLD.airport?.centerX ?? 0;
const AIRPORT_Z = WORLD.airport?.centerZ ?? 0;
const DAY = TERRAIN_REFERENCE_DAY_OF_YEAR;

function mountainCamera(): { x: number; z: number } {
  const located = locateShotOffset((offsetX, offsetZ) => {
    const here = sampleTerrain(WORLD, AIRPORT_X + offsetX, AIRPORT_Z + offsetZ);
    if (here.height < WORLD.seaLevel + 5 || here.slope > 0.3) return false;
    let steep = 0;
    for (const ahead of [400, 650, 900] as const) {
      const face = sampleTerrain(WORLD, AIRPORT_X + offsetX + ahead, AIRPORT_Z + offsetZ);
      if (face.slope > 0.4 && face.height > here.height + 180) steep += 1;
    }
    return steep >= 2;
  }, { stepMeters: 400, maxRadiusMeters: 20_000 });
  if (!located) throw new Error("The canonical mountain capture has no qualifying terrain");
  return {
    x: AIRPORT_X + located.offsetXMeters,
    z: AIRPORT_Z + located.offsetZMeters,
  };
}

interface ClassifiedPoint {
  readonly slope: number;
  readonly input: LandCoverInput;
  readonly weights: ReadonlyMap<SurfaceMaterialId, number>;
  readonly dominant: SurfaceMaterialId;
}

const MATERIALS_OF_INTEREST = new Set<SurfaceMaterialId>([
  SurfaceMaterial.Grass,
  SurfaceMaterial.DryGrass,
  SurfaceMaterial.Rock,
  SurfaceMaterial.Gravel,
]);

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.floor(fraction * (sorted.length - 1))] ?? Number.NaN;
}

interface DistributionSummary {
  readonly count: number;
  readonly p10: number;
  readonly p25: number;
  readonly median: number;
  readonly p75: number;
  readonly p90: number;
}

function summary(values: readonly number[]): DistributionSummary {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p10: percentile(sorted, 0.1),
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
  };
}

function nameOf(id: SurfaceMaterialId): string {
  return SURFACE_MATERIALS[id]!.name;
}

function classifierResult(input: LandCoverInput): Pick<ClassifiedPoint, "weights" | "dominant"> {
  const classified = classifyLandCover(input);
  const weights = new Map<SurfaceMaterialId, number>();
  for (let index = 0; index < classified.ids.length; index += 1) {
    weights.set(classified.ids[index]!, classified.weights[index]!);
  }
  return { weights, dominant: classified.ids[0]! };
}

function classifyPoint(world: WorldDefinition, x: number, z: number): ClassifiedPoint {
  const terrain = sampleTerrain(world, x, z, undefined, DAY);
  const vegetation = densityField(world.sourceSeedHash, {
    x,
    z,
    heightMeters: terrain.height,
    seaLevelMeters: world.seaLevel,
    slope: terrain.slope,
    moisture: terrain.moisture,
    normalX: terrain.normal.x,
    normalZ: terrain.normal.z,
    airportInfluence: terrain.airportInfluence,
    shoreDistanceMeters: 1e9,
    dayOfYear: DAY,
    filterWidthMeters: CANOPY_CLOSURE_FILTER_WIDTH_METERS,
  });
  const input: LandCoverInput = {
    elevationMeters: terrain.height - world.seaLevel,
    slope: terrain.slope,
    moisture: terrain.moisture,
    temperature: terrain.temperature,
    // The shipping splat bake deliberately leaves the classifier aspect at 0.
    aspect: 0,
    airportInfluence: terrain.airportInfluence,
    dayOfYear: DAY,
    seasonalTemperatureShift: 0,
    canopyClosure: vegetation.canopyClosure,
    grassCover: vegetation.grassCover,
  };
  return {
    slope: terrain.slope,
    input,
    ...classifierResult(input),
  };
}

interface PatchPopulation {
  readonly boundedChords: number;
  readonly reportedScaleChords: number;
  readonly mineralBoundaryCrossings: number;
  readonly rockFraction: number;
}

function patchPopulation(
  grid: readonly (readonly ClassifiedPoint[])[],
  spacingMeters: number,
): PatchPopulation {
  let boundedChords = 0;
  let reportedScaleChords = 0;
  let mineralBoundaryCrossings = 0;
  let rockPoints = 0;
  let steepPoints = 0;
  const addLine = (line: readonly ClassifiedPoint[]) => {
    let start = 0;
    while (start < line.length) {
      const material = line[start]!.dominant;
      let end = start + 1;
      while (end < line.length && line[end]!.dominant === material) end += 1;
      if (
        start > 0
        && end < line.length
        && MATERIALS_OF_INTEREST.has(material)
        && line.slice(start, end).every((point) => point.slope >= 0.08)
      ) {
        boundedChords += 1;
        const width = (end - start) * spacingMeters;
        if (width >= 12 && width <= 100) reportedScaleChords += 1;
      }
      start = end;
    }
    for (let index = 0; index + 1 < line.length; index += 1) {
      const first = line[index]!;
      const second = line[index + 1]!;
      if (
        first.slope >= 0.08
        && second.slope >= 0.08
        && first.dominant !== second.dominant
        && (first.dominant === SurfaceMaterial.Rock || second.dominant === SurfaceMaterial.Rock)
        && MATERIALS_OF_INTEREST.has(first.dominant)
        && MATERIALS_OF_INTEREST.has(second.dominant)
      ) mineralBoundaryCrossings += 1;
    }
  };
  for (const row of grid) {
    for (const point of row) {
      if (point.slope < 0.08) continue;
      steepPoints += 1;
      if (point.dominant === SurfaceMaterial.Rock) rockPoints += 1;
    }
    addLine(row);
  }
  for (let column = 0; column < grid[0]!.length; column += 1) {
    addLine(grid.map((row) => row[column]!));
  }
  return {
    boundedChords,
    reportedScaleChords,
    mineralBoundaryCrossings,
    rockFraction: rockPoints / steepPoints,
  };
}

function slopeAveragedGrid(
  grid: readonly (readonly ClassifiedPoint[])[],
  spacingMeters: number,
  halfWidthMeters: number,
): ClassifiedPoint[][] {
  const rows = grid.length;
  const columns = grid[0]!.length;
  const integral = new Float64Array((rows + 1) * (columns + 1));
  const at = (row: number, column: number) => row * (columns + 1) + column;
  for (let row = 0; row < rows; row += 1) {
    let rowSum = 0;
    for (let column = 0; column < columns; column += 1) {
      rowSum += grid[row]![column]!.input.slope;
      integral[at(row + 1, column + 1)] = integral[at(row, column + 1)]! + rowSum;
    }
  }
  const radius = Math.round(halfWidthMeters / spacingMeters);
  return grid.map((sourceRow, row) => sourceRow.map((point, column) => {
    const lowRow = Math.max(0, row - radius);
    const highRow = Math.min(rows - 1, row + radius);
    const lowColumn = Math.max(0, column - radius);
    const highColumn = Math.min(columns - 1, column + radius);
    const sum = integral[at(highRow + 1, highColumn + 1)]!
      - integral[at(lowRow, highColumn + 1)]!
      - integral[at(highRow + 1, lowColumn)]!
      + integral[at(lowRow, lowColumn)]!;
    const count = (highRow - lowRow + 1) * (highColumn - lowColumn + 1);
    const input = { ...point.input, slope: sum / count };
    return { ...point, input, ...classifierResult(input) };
  }));
}

describe("mountain land-cover scale diagnostic", () => {
  /**
   * The handover's unresolved choice was whether the reported 13-100 m camo
   * patches come from the spatial drivers or from wide classifier blends. This
   * samples the canonical `mountain-close` site's actual heading on the 4 m L0
   * channel footprint. Inputs follow the analytic splat bake: real terrain
   * height/slope/climate, closure evaluated at its fixed 60 m footprint, no
   * eroded hydrology, and classifier aspect deliberately zero.
   *
   * A patch width is a bounded chord through one dominant material. A blend
   * width is the distance for the outgoing member of a material pair to fall
   * from 75% to 25% of that pair's stored classifier weight. Those two numbers
   * distinguish field scale from transition softness without changing either.
   * The one-input replacement at each adjacent boundary identifies which real
   * classifier input moved the competing suitabilities most over that step.
   *
   * This is an evidence pin, not approval of the look. A deliberate scale fix
   * should move these assertions and the corresponding visual baseline in the
   * same reviewed change.
   */
  it("pins the 13-100 m patches to the slope field, not the blend width", () => {
    const camera = mountainCamera();
    const spacing = 4;
    const columns = 301;
    const rows = 301;
    const yaw = yawForSunBearing(
      sunDirectionForClock({ dayOfYear: DAY, solarTimeHours: 17.8 }, WORLD.latitudeDegrees),
      140,
    );
    const heading = headingVectorFromYaw(yaw);
    const across = { x: -heading.z, z: heading.x };
    const originX = camera.x + heading.x * 100 - across.x * ((rows - 1) * spacing) / 2;
    const originZ = camera.z + heading.z * 100 - across.z * ((rows - 1) * spacing) / 2;
    const grid: ClassifiedPoint[][] = [];
    const slopeHistogram = new Map<SurfaceMaterialId, number>();
    let steepPoints = 0;
    for (let row = 0; row < rows; row += 1) {
      const gridRow: ClassifiedPoint[] = [];
      for (let column = 0; column < columns; column += 1) {
        const point = classifyPoint(
          WORLD,
          originX + heading.x * column * spacing + across.x * row * spacing,
          originZ + heading.z * column * spacing + across.z * row * spacing,
        );
        gridRow.push(point);
        if (point.slope >= 0.08) {
          steepPoints += 1;
          slopeHistogram.set(point.dominant, (slopeHistogram.get(point.dominant) ?? 0) + 1);
        }
      }
      grid.push(gridRow);
    }

    const runWidths = new Map<SurfaceMaterialId, number[]>();
    const transitionWidths = new Map<string, number[]>();
    const boundaryDrivers = new Map<string, Map<string, number>>();
    const addLine = (line: readonly ClassifiedPoint[]) => {
      let start = 0;
      while (start < line.length) {
        const material = line[start]!.dominant;
        let end = start + 1;
        while (end < line.length && line[end]!.dominant === material) end += 1;
        const bounded = start > 0 && end < line.length;
        const allSteep = line.slice(start, end).every((point) => point.slope >= 0.08);
        if (bounded && allSteep && MATERIALS_OF_INTEREST.has(material)) {
          const widths = runWidths.get(material) ?? [];
          widths.push((end - start) * spacing);
          runWidths.set(material, widths);
        }
        start = end;
      }

      for (let boundary = 0; boundary + 1 < line.length; boundary += 1) {
        const left = line[boundary]!;
        const right = line[boundary + 1]!;
        if (
          left.dominant === right.dominant
          || !MATERIALS_OF_INTEREST.has(left.dominant)
          || !MATERIALS_OF_INTEREST.has(right.dominant)
          || left.slope < 0.08
          || right.slope < 0.08
        ) continue;
        const from = left.dominant;
        const to = right.dominant;
        const share = (point: ClassifiedPoint): number => {
          const a = point.weights.get(from) ?? 0;
          const b = point.weights.get(to) ?? 0;
          return a / Math.max(1e-9, a + b);
        };
        let low = boundary;
        while (low >= 0 && line[low]!.slope >= 0.08 && share(line[low]!) < 0.75) low -= 1;
        let high = boundary + 1;
        while (high < line.length && line[high]!.slope >= 0.08 && share(line[high]!) > 0.25) high += 1;
        if (low < 0 || high >= line.length) continue;
        if (share(line[low]!) < 0.75 || share(line[high]!) > 0.25) continue;
        const key = [nameOf(from), nameOf(to)].sort().join(" ↔ ");
        const widths = transitionWidths.get(key) ?? [];
        widths.push((high - low) * spacing);
        transitionWidths.set(key, widths);

        const pairDelta = (input: LandCoverInput): number => {
          const suitability = landCoverSuitabilities(input);
          return suitability[from]! - suitability[to]!;
        };
        const before = pairDelta(left.input);
        const fields = [
          "elevationMeters",
          "slope",
          "moisture",
          "temperature",
          "canopyClosure",
          "grassCover",
        ] as const;
        let driver = "none";
        let largestEffect = 0;
        for (const field of fields) {
          const changed = pairDelta({
            ...left.input,
            [field]: right.input[field],
          });
          const effect = Math.abs(changed - before);
          if (effect > largestEffect) {
            largestEffect = effect;
            driver = field;
          }
        }
        const counts = boundaryDrivers.get(key) ?? new Map<string, number>();
        counts.set(driver, (counts.get(driver) ?? 0) + 1);
        boundaryDrivers.set(key, counts);
      }
    };
    for (const row of grid) addLine(row);
    for (let column = 0; column < columns; column += 1) {
      addLine(grid.map((row) => row[column]!));
    }

    // Non-vacuity: 57,602/90,601 samples meet the >=23 degree face threshold,
    // and all three colours implicated by the report occupy material area.
    expect(steepPoints / (columns * rows)).toBeGreaterThan(0.6);
    expect((slopeHistogram.get(SurfaceMaterial.Grass) ?? 0) / steepPoints).toBeGreaterThan(0.5);
    expect((slopeHistogram.get(SurfaceMaterial.DryGrass) ?? 0) / steepPoints).toBeGreaterThan(0.15);
    expect((slopeHistogram.get(SurfaceMaterial.Rock) ?? 0) / steepPoints).toBeGreaterThan(0.2);

    const grassRuns = summary(runWidths.get(SurfaceMaterial.Grass) ?? []);
    const dryGrassRuns = summary(runWidths.get(SurfaceMaterial.DryGrass) ?? []);
    const rockRuns = summary(runWidths.get(SurfaceMaterial.Rock) ?? []);
    // Measured medians are 36 m for all three; their central halves span
    // 12-92 m. That independently reproduces the handover's 13-100 m band.
    for (const distribution of [grassRuns, dryGrassRuns, rockRuns]) {
      expect(distribution.count).toBeGreaterThan(500);
      expect(distribution.median).toBeGreaterThanOrEqual(28);
      expect(distribution.median).toBeLessThanOrEqual(48);
      expect(distribution.p75).toBeLessThanOrEqual(100);
    }

    const grassRockKey = [nameOf(SurfaceMaterial.Grass), nameOf(SurfaceMaterial.Rock)]
      .sort().join(" ↔ ");
    const dryRockKey = [nameOf(SurfaceMaterial.DryGrass), nameOf(SurfaceMaterial.Rock)]
      .sort().join(" ↔ ");
    const grassDryKey = [nameOf(SurfaceMaterial.Grass), nameOf(SurfaceMaterial.DryGrass)]
      .sort().join(" ↔ ");
    const grassRockBlend = summary(transitionWidths.get(grassRockKey) ?? []);
    const dryRockBlend = summary(transitionWidths.get(dryRockKey) ?? []);
    const grassDryBlend = summary(transitionWidths.get(grassDryKey) ?? []);

    // Rock boundaries account for 3,037 measured crossings. Their median
    // softness is only 8-12 m, far below the 36 m patch chord. Direct
    // Grass/DryGrass ecotones are the opposite: a 256 m median, too broad to be
    // the reported blobs. Widening smoothsteps therefore targets the edge, not
    // the field that keeps creating a new patch centre.
    expect(grassRockBlend.count + dryRockBlend.count).toBeGreaterThan(3_000);
    expect(grassRockBlend.median).toBeLessThanOrEqual(16);
    expect(dryRockBlend.median).toBeLessThanOrEqual(12);
    expect(grassDryBlend.median).toBeGreaterThanOrEqual(128);
    expect(grassRuns.median / grassRockBlend.median).toBeGreaterThanOrEqual(2.5);
    expect(dryGrassRuns.median / dryRockBlend.median).toBeGreaterThanOrEqual(3);

    const driverShare = (pair: string, driver: string): number => {
      const counts = boundaryDrivers.get(pair) ?? new Map<string, number>();
      const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
      return (counts.get(driver) ?? 0) / Math.max(1, total);
    };
    // The attribution is effectively categorical: 99.9-100% slope at mineral
    // boundaries, 100% moisture at the sparse direct grass ecotones.
    expect(driverShare(grassRockKey, "slope")).toBeGreaterThan(0.99);
    expect(driverShare(dryRockKey, "slope")).toBeGreaterThan(0.99);
    expect(driverShare(grassDryKey, "moisture")).toBeGreaterThan(0.99);

    const baselinePopulation = patchPopulation(grid, spacing);
    const counterfactuals = [8, 16, 32, 64].map((halfWidthMeters) => ({
      halfWidthMeters,
      population: patchPopulation(
        slopeAveragedGrid(grid, spacing, halfWidthMeters),
        spacing,
      ),
    }));
    // Counterfactual only: average the existing normalized slope over wider
    // footprints while every other production input stays fixed. This predicts
    // the scale lever's effect; it is NOT a proposed implementation. A real fix
    // must resolve the LOD authority decision (propagated statistic versus a
    // roughness channel) rather than locally inventing another slope owner.
    expect(baselinePopulation.reportedScaleChords).toBeGreaterThan(2_000);
    expect(baselinePopulation.mineralBoundaryCrossings).toBeGreaterThan(3_000);
    expect(baselinePopulation.rockFraction).toBeGreaterThan(0.2);

    const at = (halfWidthMeters: number): PatchPopulation =>
      counterfactuals.find((entry) => entry.halfWidthMeters === halfWidthMeters)!.population;
    // A 16 m half-width (33 m box support) removes 39% of reported-scale chords
    // and 41% of mineral crossings, while Rock moves only 23.25% -> 21.83%.
    // That is a viable causal region: the patches fall without Rock flooding or
    // disappearing. The wider probes map the trade-off rather than blessing it.
    expect(at(16).reportedScaleChords / baselinePopulation.reportedScaleChords)
      .toBeLessThan(0.7);
    expect(at(16).mineralBoundaryCrossings / baselinePopulation.mineralBoundaryCrossings)
      .toBeLessThan(0.7);
    expect(Math.abs(at(16).rockFraction - baselinePopulation.rockFraction))
      .toBeLessThan(0.02);
    expect(at(32).reportedScaleChords / baselinePopulation.reportedScaleChords)
      .toBeLessThan(0.5);
    expect(at(32).rockFraction / baselinePopulation.rockFraction).toBeGreaterThan(0.75);
    // At 64 m half-width Rock is down by 35%, identifying the destructive end
    // of the sweep instead of pretending every amount of smoothing is safe.
    expect(at(64).rockFraction / baselinePopulation.rockFraction).toBeLessThan(0.75);
  }, 30_000);
});
