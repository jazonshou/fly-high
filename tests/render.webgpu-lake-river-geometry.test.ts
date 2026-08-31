import { describe, expect, it } from "vitest";
import {
  distanceToRingMeters,
  earClipRing,
  extractMacroLakeShoreline,
  marchingSquaresIsoRings,
  refineTriangulation,
  ringSignedArea,
  simplifyClosedRing,
} from "../src/render/webgpu/water/lakeShoreline";
import {
  resampleHydrologyRiverStations,
  riverStationSpacingMeters,
  RIVER_STATION_MAXIMUM_SPACING_METERS,
  RIVER_STATION_MINIMUM_SPACING_METERS,
} from "../src/render/webgpu/water/riverResample";
import type { HydrologyRiverPoint } from "../src/render/webgpu/water/HydrologyGeneration";

/**
 * W-5 (C-5) — unit coverage for the real lake/river geometry helpers:
 * marching squares, Douglas-Peucker, ear clipping with graded refinement,
 * and arc-length river resampling.
 */

function ringPoints(ring: readonly number[]): Array<readonly [number, number]> {
  const points: Array<readonly [number, number]> = [];
  for (let index = 0; index < ring.length; index += 2) {
    points.push([ring[index]!, ring[index + 1]!]);
  }
  return points;
}

function segmentsIntersect(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  d: readonly [number, number],
): boolean {
  const cross = (
    o: readonly [number, number],
    p: readonly [number, number],
    q: readonly [number, number],
  ): number => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function ringIsSimple(ring: readonly number[]): boolean {
  const points = ringPoints(ring);
  const count = points.length;
  for (let first = 0; first < count; first += 1) {
    const a = points[first]!;
    const b = points[(first + 1) % count]!;
    for (let second = first + 2; second < count; second += 1) {
      if (first === 0 && second === count - 1) continue; // adjacent via wrap
      const c = points[second]!;
      const d = points[(second + 1) % count]!;
      if (segmentsIntersect(a, b, c, d)) return false;
    }
  }
  return true;
}

function triangleSignedArea(
  ax: number, az: number, bx: number, bz: number, cx: number, cz: number,
): number {
  return ((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) * 0.5;
}

describe("W-5 marching-squares shorelines", () => {
  it("traces a known synthetic field's 0.5-contour with a closed simple ring", () => {
    // Radial cone: value = 1 - r / R over a 41x41 node grid. The 0.5-contour
    // is the circle of radius R / 2 around the centre.
    const size = 41;
    const center = 20;
    const coneRadius = 16;
    const values = new Float32Array(size * size);
    for (let z = 0; z < size; z += 1) {
      for (let x = 0; x < size; x += 1) {
        values[z * size + x] = Math.max(0, 1 - Math.hypot(x - center, z - center) / coneRadius);
      }
    }
    const rings = marchingSquaresIsoRings(size, size, values, 0.5);
    expect(rings).toHaveLength(1);
    const ring = rings[0]!;
    const points = ringPoints(ring);
    expect(points.length).toBeGreaterThan(16);
    // Closed: every consecutive pair (wrapping) is one marching step apart.
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index]!;
      const next = points[(index + 1) % points.length]!;
      expect(Math.hypot(next[0] - current[0], next[1] - current[1])).toBeLessThanOrEqual(1.5);
    }
    // Simple: no self-intersection.
    expect(ringIsSimple(ring)).toBe(true);
    // Traces the true contour within one fine-grid cell.
    for (const [x, z] of points) {
      const radius = Math.hypot(x - center, z - center);
      expect(Math.abs(radius - coneRadius / 2)).toBeLessThanOrEqual(1);
    }
  });

  it("emits separate rings for separate components and rejects bad input", () => {
    const width = 12;
    const height = 8;
    const values = new Float32Array(width * height);
    // Two 1-node peaks far apart produce two disjoint diamonds.
    values[3 * width + 3] = 1;
    values[4 * width + 8] = 1;
    const rings = marchingSquaresIsoRings(width, height, values, 0.5);
    expect(rings).toHaveLength(2);
    for (const ring of rings) expect(ringIsSimple(ring)).toBe(true);
    expect(() => marchingSquaresIsoRings(3, 3, new Float32Array(4), 0.5)).toThrow(/match/);
    expect(() => marchingSquaresIsoRings(1, 4, new Float32Array(4), 0.5)).toThrow(/2x2/);
  });

  it("Douglas-Peucker preserves anchors and stays within tolerance", () => {
    // A noisy circle: 128 vertices with a small radial wobble.
    const ring: number[] = [];
    for (let index = 0; index < 128; index += 1) {
      const angle = (index / 128) * Math.PI * 2;
      const radius = 100 + Math.sin(index * 1.7) * 0.8;
      ring.push(Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
    const tolerance = 3;
    const simplified = simplifyClosedRing(ring, tolerance);
    expect(simplified.length).toBeLessThan(ring.length);
    expect(simplified.length).toBeGreaterThanOrEqual(6);
    // Anchor endpoints survive verbatim.
    expect(simplified[0]).toBe(ring[0]);
    expect(simplified[1]).toBe(ring[1]);
    // Every original vertex stays within tolerance of the simplified ring
    // (the Douglas-Peucker guarantee, plus a hair of slack for the chord
    // metric at the wrap seam).
    for (let index = 0; index < ring.length; index += 2) {
      expect(distanceToRingMeters(ring[index]!, ring[index + 1]!, simplified))
        .toBeLessThanOrEqual(tolerance + 1e-9);
    }
    // Zero tolerance keeps everything; tiny rings pass through.
    expect(simplifyClosedRing(ring, 0)).toHaveLength(ring.length);
    expect(simplifyClosedRing([0, 0, 4, 0, 4, 4, 0, 4], 10)).toEqual([0, 0, 4, 0, 4, 4, 0, 4]);
  });
});

describe("W-5 ear-clip lake interiors", () => {
  const concaveRing = [
    // A CCW "staircase L" with a deep notch — convex covers of this shape
    // are exactly what the retired overfill gate rejected.
    0, 0, 400, 0, 400, 150, 150, 150, 150, 400, 0, 400,
  ] as const;

  it("triangulates a concave polygon with exact area and uniform winding", () => {
    const triangles = earClipRing(concaveRing);
    expect(triangles.length % 3).toBe(0);
    expect(triangles.length / 3).toBe(concaveRing.length / 2 - 2);
    const polygonArea = ringSignedArea(concaveRing);
    expect(polygonArea).toBeGreaterThan(0); // CCW fixture
    let areaSum = 0;
    for (let index = 0; index < triangles.length; index += 3) {
      const [a, b, c] = [triangles[index]!, triangles[index + 1]!, triangles[index + 2]!];
      const area = triangleSignedArea(
        concaveRing[a * 2]!, concaveRing[a * 2 + 1]!,
        concaveRing[b * 2]!, concaveRing[b * 2 + 1]!,
        concaveRing[c * 2]!, concaveRing[c * 2 + 1]!,
      );
      // No flipped winding: every triangle matches the ring orientation.
      expect(area).toBeGreaterThan(0);
      areaSum += area;
    }
    expect(Math.abs(areaSum - polygonArea)).toBeLessThanOrEqual(1e-6);
    // A CW input yields CW triangles covering the same area.
    const reversed: number[] = [];
    for (let index = concaveRing.length - 2; index >= 0; index -= 2) {
      reversed.push(concaveRing[index]!, concaveRing[index + 1]!);
    }
    const clockwise = earClipRing(reversed);
    let reversedSum = 0;
    for (let index = 0; index < clockwise.length; index += 3) {
      const [a, b, c] = [clockwise[index]!, clockwise[index + 1]!, clockwise[index + 2]!];
      const area = triangleSignedArea(
        reversed[a * 2]!, reversed[a * 2 + 1]!,
        reversed[b * 2]!, reversed[b * 2 + 1]!,
        reversed[c * 2]!, reversed[c * 2 + 1]!,
      );
      expect(area).toBeLessThan(0);
      reversedSum += area;
    }
    expect(Math.abs(reversedSum + polygonArea)).toBeLessThanOrEqual(1e-6);
    // Degenerate input is refused, not looped on.
    expect(earClipRing([0, 0, 1, 1])).toEqual([]);
  });

  it("refines without changing coverage and honours the graded edge limit", () => {
    const positions = [...concaveRing];
    const coarse = earClipRing(concaveRing);
    const refined = refineTriangulation(positions, coarse, 80);
    expect(refined.length).toBeGreaterThan(coarse.length);
    const polygonArea = ringSignedArea(concaveRing);
    let areaSum = 0;
    for (let index = 0; index < refined.length; index += 3) {
      const [a, b, c] = [refined[index]!, refined[index + 1]!, refined[index + 2]!];
      const area = triangleSignedArea(
        positions[a * 2]!, positions[a * 2 + 1]!,
        positions[b * 2]!, positions[b * 2 + 1]!,
        positions[c * 2]!, positions[c * 2 + 1]!,
      );
      expect(area).toBeGreaterThanOrEqual(0);
      areaSum += area;
      let longestEdge = 0;
      for (const [first, second] of [[a, b], [b, c], [c, a]] as const) {
        longestEdge = Math.max(longestEdge, Math.hypot(
          positions[first * 2]! - positions[second * 2]!,
          positions[first * 2 + 1]! - positions[second * 2 + 1]!,
        ));
      }
      // Area-gated longest-edge bisection: every triangle either has all
      // edges under the limit, or is an at-target-area sliver that stopped
      // initiating splits.
      expect(
        longestEdge <= 80 || area <= 0.433 * 80 * 80 + 1e-9,
        `triangle with edge ${longestEdge} and area ${area} escaped refinement`,
      ).toBe(true);
    }
    // Midpoint splitting cannot create or destroy coverage.
    expect(Math.abs(areaSum - polygonArea)).toBeLessThanOrEqual(1e-6);
    // Ring vertices are untouched, created vertices are strictly appended.
    expect(positions.slice(0, concaveRing.length)).toEqual([...concaveRing]);
    expect(positions.length).toBeGreaterThan(concaveRing.length);
    expect(() => refineTriangulation([...concaveRing], coarse, -1)).toThrow(/positive/);
  });

  it("keeps distance-to-ring exact on segment interiors and corners", () => {
    const square = [0, 0, 10, 0, 10, 10, 0, 10];
    expect(distanceToRingMeters(5, 5, square)).toBeCloseTo(5, 12);
    expect(distanceToRingMeters(5, -3, square)).toBeCloseTo(3, 12);
    expect(distanceToRingMeters(-3, -4, square)).toBeCloseTo(5, 12);
    expect(distanceToRingMeters(10, 3, square)).toBeCloseTo(0, 12);
  });
});

describe("W-5 shoreline extraction from macro components", () => {
  it("hugs an L-shaped component and never floods the missing corner", () => {
    // 5x5 macro grid at 100 m texels; L-shaped 3-texel lake.
    const layout = { width: 5, height: 5, texelSizeMeters: 100, originX: 50, originZ: 50 };
    const at = (x: number, z: number): number => z * layout.width + x;
    const component = [at(2, 2), at(3, 2), at(2, 3)];
    const ring = extractMacroLakeShoreline({
      component,
      outletIndex: at(2, 2),
      spillElevationMeters: 90,
      lakeId: 7,
      layout,
    });
    expect(ring).not.toBeNull();
    const vertices = [...ring!];
    expect(vertices.length / 2).toBeGreaterThanOrEqual(6);
    expect(ringIsSimple(vertices)).toBe(true);
    const area = ringSignedArea(vertices);
    // Exported counter-clockwise.
    expect(area).toBeGreaterThan(0);
    // The contour cannot overfill the three-texel wet mask (the convex cover
    // over this shape covered four texels and was rejected outright).
    expect(area).toBeLessThanOrEqual(3 * 100 * 100);
    expect(area).toBeGreaterThanOrEqual(1.5 * 100 * 100);
    // Wet texel centres are inside (positive distance-signed via ray cast).
    const inside = (x: number, z: number): boolean => {
      let crossings = 0;
      const count = vertices.length / 2;
      for (let index = 0; index < count; index += 1) {
        const next = (index + 1) % count;
        const ax = vertices[index * 2]!;
        const az = vertices[index * 2 + 1]!;
        const bx = vertices[next * 2]!;
        const bz = vertices[next * 2 + 1]!;
        if ((az > z) !== (bz > z) && x < ax + ((z - az) / (bz - az)) * (bx - ax)) {
          crossings += 1;
        }
      }
      return crossings % 2 === 1;
    };
    expect(inside(250, 250)).toBe(true);
    expect(inside(350, 250)).toBe(true);
    expect(inside(250, 350)).toBe(true);
    // The dry corner texel centre stays dry.
    expect(inside(350, 350)).toBe(false);
    // Empty components produce no ring.
    expect(extractMacroLakeShoreline({
      component: [],
      outletIndex: 0,
      spillElevationMeters: 0,
      lakeId: 1,
      layout,
    })).toBeNull();
  });
});

describe("W-5 arc-length river resampling", () => {
  const points: HydrologyRiverPoint[] = [
    {
      x: -500, y: 40, z: 0,
      widthMeters: 10,
      flowSpeedMetersPerSecond: 1.2,
      estimatedDischargeCubicMetersPerSecond: 8,
    },
    {
      x: 0, y: 30, z: 0,
      widthMeters: 30,
      flowSpeedMetersPerSecond: 1.6,
      estimatedDischargeCubicMetersPerSecond: 20,
    },
    {
      x: 0, y: 10, z: 500,
      widthMeters: 200,
      flowSpeedMetersPerSecond: 2.4,
      estimatedDischargeCubicMetersPerSecond: 64,
    },
  ];

  it("clamps station spacing to the width law", () => {
    expect(riverStationSpacingMeters(5)).toBe(RIVER_STATION_MINIMUM_SPACING_METERS);
    expect(riverStationSpacingMeters(50)).toBe(100);
    expect(riverStationSpacingMeters(1_000)).toBe(RIVER_STATION_MAXIMUM_SPACING_METERS);
    expect(riverStationSpacingMeters(Number.NaN)).toBe(RIVER_STATION_MINIMUM_SPACING_METERS);
  });

  it("keeps stations on the source polyline with exact node hydraulics", () => {
    const stations = resampleHydrologyRiverStations(points);
    expect(stations.length).toBeGreaterThan(points.length);
    // Every source node survives verbatim (bit-checkable hydraulics).
    for (const point of points) {
      const station = stations.find((candidate) =>
        candidate.x === point.x && candidate.z === point.z);
      expect(station).toBeDefined();
      expect(station!.y).toBe(point.y);
      expect(station!.widthMeters).toBe(point.widthMeters);
      expect(station!.flowSpeedMetersPerSecond).toBe(point.flowSpeedMetersPerSecond);
      expect(station!.estimatedDischargeCubicMetersPerSecond)
        .toBe(point.estimatedDischargeCubicMetersPerSecond);
    }
    // Stations sit exactly on the polyline and their hydraulics are exact
    // linear interpolations of the bracketing exported nodes.
    const sourceRing = [-500, 0, 0, 0, 0, 500];
    for (const station of stations) {
      expect(distanceToRingMeters(station.x, station.z, sourceRing))
        .toBeLessThanOrEqual(1e-9);
    }
    const segment0 = stations.filter((station) => station.z === 0 && station.x > -500 && station.x < 0);
    for (const station of segment0) {
      const t = (station.x + 500) / 500;
      expect(station.widthMeters).toBeCloseTo(10 + 20 * t, 12);
      expect(station.flowSpeedMetersPerSecond).toBeCloseTo(1.2 + 0.4 * t, 12);
      expect(station.estimatedDischargeCubicMetersPerSecond).toBeCloseTo(8 + 12 * t, 12);
    }
    // Arc length is the true accumulated length from the reach head and is
    // strictly monotone (the world-anchored uv.x parameter derives from it).
    expect(stations[0]!.arcLengthMeters).toBe(0);
    expect(stations.at(-1)!.arcLengthMeters).toBeCloseTo(1_000, 9);
    for (let index = 1; index < stations.length; index += 1) {
      expect(stations[index]!.arcLengthMeters)
        .toBeGreaterThan(stations[index - 1]!.arcLengthMeters);
    }
    // Spacing obeys clamp(2 x min-width, 32, 256) per segment: the narrow
    // upstream segment resamples finer than the wide downstream one.
    const upstreamCount = stations.filter((station) => station.z === 0).length;
    const downstreamCount = stations.filter((station) => station.z > 0).length;
    expect(upstreamCount).toBeGreaterThan(downstreamCount);
    for (let index = 1; index < stations.length; index += 1) {
      const step = stations[index]!.arcLengthMeters - stations[index - 1]!.arcLengthMeters;
      expect(step).toBeLessThanOrEqual(RIVER_STATION_MAXIMUM_SPACING_METERS + 1e-9);
    }
    // Frenet tangents are unit-length and follow the flow direction.
    for (const station of stations) {
      expect(Math.hypot(station.tangentX, station.tangentZ)).toBeCloseTo(1, 12);
    }
    expect(stations[0]!.tangentX).toBeCloseTo(1, 12);
    expect(stations.at(-1)!.tangentZ).toBeCloseTo(1, 12);
    // Whitewater recomputes from the resampled stations and stays clamped.
    for (const station of stations) {
      expect(station.whitewater).toBeGreaterThanOrEqual(0);
      expect(station.whitewater).toBeLessThanOrEqual(1);
    }
  });

  it("keeps a shared confluence endpoint a single shared point", () => {
    const junction: HydrologyRiverPoint = {
      x: 120, y: 14, z: -40,
      widthMeters: 22,
      flowSpeedMetersPerSecond: 1.9,
      estimatedDischargeCubicMetersPerSecond: 30,
    };
    const incoming = resampleHydrologyRiverStations([points[0]!, junction]);
    const trunk = resampleHydrologyRiverStations([junction, points[2]!]);
    const tail = incoming.at(-1)!;
    const head = trunk[0]!;
    // The junction is one actual point with one set of hydraulics, so the
    // meshes seam exactly (downstream reach's hydraulics at the junction).
    expect([tail.x, tail.y, tail.z]).toEqual([head.x, head.y, head.z]);
    expect(tail.widthMeters).toBe(head.widthMeters);
    expect(tail.flowSpeedMetersPerSecond).toBe(head.flowSpeedMetersPerSecond);
    expect(head.arcLengthMeters).toBe(0);
    // Degenerate inputs stay bounded.
    expect(resampleHydrologyRiverStations([])).toEqual([]);
    expect(resampleHydrologyRiverStations([junction])).toEqual([]);
    const zeroLength = resampleHydrologyRiverStations([junction, junction]);
    expect(zeroLength).toHaveLength(2);
    expect(zeroLength[1]!.arcLengthMeters).toBe(0);
  });
});
