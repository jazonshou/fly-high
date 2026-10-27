import { describe, expect, it } from "vitest";
import {
  applyInfrastructure,
  buildInfrastructureIndex,
  clearInfrastructureRegions,
  infrastructureCapsuleDistance,
  infrastructureIndex,
  infrastructureSegmentLocal,
  installInfrastructureRegions,
  type InfrastructureProfileSample,
  type InfrastructureSegment,
} from "@/src/world/infrastructure";
import { INFRASTRUCTURE_PROFILE } from "@/src/world/infrastructureProfiles";
import {
  roadBatterTarget,
  roadCarriagewayHeight,
  roadCrossOffset,
  roadJunctionPadHeight,
  ROAD_CUT_BATTER_RUN,
  ROAD_FILL_BATTER_RUN,
  ROAD_JOIN_BLEND_METERS,
} from "@/src/world/roadEarthworkProfiles";
import { ROAD_CLASS, roadClass, roadFormationHalfWidth } from "@/src/world/roads/roadClasses";
import {
  roadPieceKey,
  roadRegionInfrastructure,
  roadRegionKey,
  ROAD_PIECE_KEY_STRIDE,
} from "@/src/world/roads/roadInfrastructure";
import { RoadNetwork, roadRegionOf, ROAD_LAYERS } from "@/src/world/roads/roadNetwork";
import { airportRoadHead } from "@/src/world/roads/roadNodes";
import { roadGroundHeight } from "@/src/world/roads/roadTerrain";
import { createWorld } from "@/src/world/world";

/**
 * The roads' earthwork profiles (`roadEarthworkProfiles.ts`) and the layout
 * that turns the network's pieces and pads into stage segments
 * (`roadInfrastructure.ts`): the cross-section, the batters, continuity along
 * a chain of pieces and across its joins, the pads, and a real network's
 * regions installed into the stage. tests/gpu/road-earthworks-parity.test.ts
 * holds the GPU twin to the same profiles within 1 mm.
 */

const world = createWorld();
const sea = world.seaLevel;
const out: InfrastructureProfileSample = { target: 0, weight: 0 };

describe("the cross-section", () => {
  it("is crowned on a straight, a plane on a curve, and rotates its outer half between", () => {
    expect(roadCrossOffset(3.5, 0, 0.04)).toBeCloseTo(-0.14, 12);
    expect(roadCrossOffset(-3.5, 0, 0.04)).toBeCloseTo(-0.14, 12);
    expect(roadCrossOffset(3, 0.06, 0.025)).toBeCloseTo(0.18, 12);
    expect(roadCrossOffset(-3, 0.06, 0.025)).toBeCloseTo(-0.18, 12);
    // Halfway through the runoff: the inner (left) half keeps its fall, the outer is level.
    expect(roadCrossOffset(-3, 0.0125, 0.025)).toBeCloseTo(-0.075, 12);
    expect(roadCrossOffset(3, 0.0125, 0.025)).toBeCloseTo(0, 12);
    // Continuous in the cross slope.
    let previous = roadCrossOffset(4, -0.08, 0.025);
    for (let c = -0.08; c <= 0.08; c += 1e-5) {
      for (const across of [-4, 4]) {
        const offset = roadCrossOffset(across, c, 0.025);
        if (across === 4) {
          expect(Math.abs(offset - previous)).toBeLessThan(1e-3);
          previous = offset;
        }
      }
    }
  });

  it("batters at 1:2 down to low ground, 1:1.5 up from a ditch in a cutting, and leaves the ground between", () => {
    const edge = 100;
    // Fill: far below, the batter itself; the ground once the batter has met it.
    expect(roadBatterTarget(edge, 4, 50, 0.5, 1.5)).toBeCloseTo(edge - 4 / ROAD_FILL_BATTER_RUN, 12);
    // Cut: the ditch's bottom at its width, then the back slope.
    expect(roadBatterTarget(edge, 1.5, 150, 0.5, 1.5)).toBeCloseTo(edge - 0.5, 12);
    expect(roadBatterTarget(edge, 4.5, 150, 0.5, 1.5)).toBeCloseTo(edge - 0.5 + 3 / ROAD_CUT_BATTER_RUN, 12);
    // A ditch digs into level ground beside the road, and no fill rises over it.
    expect(roadBatterTarget(edge, 0.75, edge, 0.5, 1.5)).toBeCloseTo(edge - 0.25, 12);
    expect(roadBatterTarget(edge, 3, edge - 0.6, 0.5, 1.5)).toBe(edge - 0.6);
    // Continuous in the ground and the distance out.
    for (let beyond = 0; beyond <= 20; beyond += 0.37) {
      let last = roadBatterTarget(edge, beyond, 80, 0.5, 1.5);
      for (let ground = 80; ground <= 120; ground += 0.01) {
        const target = roadBatterTarget(edge, beyond, ground, 0.5, 1.5);
        expect(Math.abs(target - last)).toBeLessThanOrEqual(0.0100001);
        last = target;
      }
    }
  });
});

/** A gravel piece: half 3.5 m, crown 4%, ditch 0.5 x 1.5 m. */
function gravelPiece(
  ax: number, az: number, bx: number, bz: number, ha: number, hb: number, key: number, ca = 0, cb = 0,
): InfrastructureSegment {
  const spec = roadClass(ROAD_CLASS.gravel);
  return {
    profile: INFRASTRUCTURE_PROFILE.carriageway,
    mode: "set",
    priority: spec.priority,
    ax, az, bx, bz,
    halfWidth: roadFormationHalfWidth(spec),
    reach: 20,
    params: [ha - sea, hb - sea, ca, cb, spec.crossfall, spec.ditchDepth, spec.ditchWidth],
    surface: "gravel",
    key,
  };
}

describe("a chain of carriageway pieces", () => {
  // A curve of 12 pieces 15 m long turning 4 degrees each, climbing then
  // dipping, over level ground 2 m below its start.
  const x0 = 4_000;
  const z0 = -3_000;
  const base = sea + 40;
  const heights = [0, 0.9, 2.0, 3.2, 4.1, 4.6, 4.8, 4.6, 4.0, 3.1, 2.1, 1.0, 0.2].map((h) => base + h);
  const vertices: { x: number; z: number }[] = [{ x: x0, z: z0 }];
  let heading = 0.3;
  for (let k = 0; k < 12; k += 1) {
    const last = vertices[vertices.length - 1]!;
    vertices.push({ x: last.x + Math.sin(heading) * 15, z: last.z + Math.cos(heading) * 15 });
    heading += (4 * Math.PI) / 180;
  }
  const pieces = vertices.slice(0, -1).map((a, k) => {
    const b = vertices[k + 1]!;
    return gravelPiece(a.x, a.z, b.x, b.z, heights[k]!, heights[k + 1]!, k);
  });
  const index = buildInfrastructureIndex(world, [() => ({ segments: pieces })]);
  const ground = base - 2;

  it("keeps the centreline on the design line, joins included", () => {
    let worst = 0;
    for (let k = 0; k < pieces.length; k += 1) {
      const a = vertices[k]!;
      const b = vertices[k + 1]!;
      for (let t = 0; t <= 1; t += 0.01) {
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const design = heights[k]! + (heights[k + 1]! - heights[k]!) * t;
        worst = Math.max(worst, Math.abs(applyInfrastructure(index, sea, ground, x, z) - design));
      }
    }
    // Inside the join band behind each start, the piece fades in over its
    // neighbour's carried-on grade: a grade change of ~1.5% over a metre.
    expect(worst).toBeLessThan(0.02);
  });

  it("never steps across a join: on the formation, its edges or the batters", () => {
    // Walk 5 cm steps in each piece's direction through the four metres round
    // its far end, where its cap, the next piece's join band and the bend's
    // wedges meet. No point may differ from the last by more than the
    // steepest slope here (a 1:2 batter) allows over 5 cm.
    const step = 0.05;
    let worst = 0;
    for (let k = 0; k < pieces.length; k += 1) {
      const a = vertices[k]!;
      const b = vertices[k + 1]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const ux = (b.x - a.x) / length;
      const uz = (b.z - a.z) / length;
      for (let across = -14; across <= 14; across += 0.5) {
        let last = Number.NaN;
        for (let s = length - 2; s <= length + 2; s += step) {
          const h = applyInfrastructure(index, sea, ground, a.x + ux * s + uz * across, a.z + uz * s - ux * across);
          if (!Number.isNaN(last)) worst = Math.max(worst, Math.abs(h - last));
          last = h;
        }
      }
    }
    expect(worst).toBeLessThan(step / ROAD_FILL_BATTER_RUN + 0.003);
  });

  it("fades in over the join band and out over the reach", () => {
    const piece = pieces[3]!;
    const length = Math.hypot(piece.bx - piece.ax, piece.bz - piece.az);
    roadCarriagewayHeight(-ROAD_JOIN_BLEND_METERS, 0, length, piece, ground, sea, out);
    expect(out.weight).toBe(0);
    roadCarriagewayHeight(-ROAD_JOIN_BLEND_METERS / 2, 0, length, piece, ground, sea, out);
    expect(out.weight).toBeCloseTo(0.5, 12);
    roadCarriagewayHeight(length / 2, piece.halfWidth + piece.reach, length, piece, ground - 50, sea, out);
    expect(out.weight).toBe(0);
    roadCarriagewayHeight(length / 2, piece.halfWidth + 0.69 * piece.reach, length, piece, ground - 50, sea, out);
    expect(out.weight).toBe(1);
  });
});

describe("a junction pad", () => {
  const pad: InfrastructureSegment = {
    profile: INFRASTRUCTURE_PROFILE.junctionPad,
    mode: "set",
    priority: 7,
    ax: 100, az: 200, bx: 100, bz: 200,
    halfWidth: 11,
    reach: 12,
    params: [30, 8, 0.08],
    key: 1,
  };

  it("is level in its core, follows what lies under its apron within the allowance, and batters past its edge", () => {
    roadJunctionPadHeight(0, 4, 0, pad, sea + 31, sea, out);
    expect(out.target).toBe(sea + 30);
    expect(out.weight).toBe(1);
    // 2 m into the apron: up to 0.16 m off level.
    roadJunctionPadHeight(0, 10, 0, pad, sea + 30 - 0.1, sea, out);
    expect(out.target).toBeCloseTo(sea + 30 - 0.1, 9);
    roadJunctionPadHeight(0, 10, 0, pad, sea + 25, sea, out);
    expect(out.target).toBeCloseTo(sea + 30 - 0.16, 9);
    // 4 m past the edge over low ground: the apron's 0.24 m and a 1:2 batter.
    roadJunctionPadHeight(-15, 0, 0, pad, sea, sea, out);
    expect(out.target).toBeCloseTo(sea + 30 - 0.24 - 4 / ROAD_FILL_BATTER_RUN, 9);
  });
});

describe("a real network in the stage", () => {
  const head = airportRoadHead(world)!;
  const network = new RoadNetwork(world);
  const rx = roadRegionOf(head.startX);
  const rz = roadRegionOf(head.startZ);
  const regions = ROAD_LAYERS.map((layer) => ({ layer, region: network.region(layer, rx, rz) }));
  const infrastructure = regions.map(({ region }) => roadRegionInfrastructure(world, region));

  it("lays every piece and pad out once, keyed, with reaches sized to the ground", () => {
    expect(infrastructure.map((region) => region.key)).toEqual(ROAD_LAYERS.map((layer) => roadRegionKey(layer, rx, rz)));
    const segments = infrastructure.flatMap((region) => region.segments);
    const pieces = regions.flatMap(({ region }) => region.pieces);
    expect(segments.length).toBe(pieces.length + regions.reduce((sum, { region }) => sum + region.pads.length, 0));
    const keys = new Set<string>();
    for (const segment of segments) {
      const unique = `${segment.priority}:${segment.key}`;
      expect(keys.has(unique)).toBe(false);
      keys.add(unique);
    }
    expect(pieces.map(roadPieceKey).every(Number.isSafeInteger)).toBe(true);
    const reaches = segments.map((segment) => segment.reach);
    expect(Math.min(...reaches)).toBeGreaterThanOrEqual(3);
    expect(Math.max(...reaches)).toBeLessThanOrEqual(34);
    // Most of a rural network sits on easy ground: far less than the class's reach.
    const median = [...reaches].sort((left, right) => left - right)[Math.floor(reaches.length / 2)]!;
    expect(median).toBeLessThan(12);
  });

  it("puts each piece's centreline on its design height once installed", () => {
    clearInfrastructureRegions();
    installInfrastructureRegions(world, infrastructure);
    try {
      const index = infrastructureIndex(world);
      const local = { along: 0, across: 0 };
      let worst = 0;
      let count = 0;
      for (const { region } of regions) {
        for (const piece of region.pieces) {
          const x = 0.5 * (piece.ax + piece.bx);
          const z = 0.5 * (piece.az + piece.bz);
          const key = roadPieceKey(piece);
          const spec = roadClass(piece.classId);
          // Where another road, a pad or the marina composes over the piece's
          // middle (a junction, a crossing, the marina's car park), that
          // owner shapes the ground; its own chain's neighbours weigh nothing there.
          const overlaid = index.segments.some((packed) => {
            const other = packed.segment;
            const later = other.priority > spec.priority
              || (other.priority === spec.priority && other.key !== undefined && other.key > key);
            if (!later) return false;
            if (other.priority === spec.priority && Math.floor(other.key! / ROAD_PIECE_KEY_STRIDE) === piece.edgeId >>> 0) {
              return false;
            }
            infrastructureSegmentLocal(packed, x, z, local);
            return infrastructureCapsuleDistance(local.along, local.across, packed.length) < packed.radius;
          });
          if (overlaid) continue;
          const h = applyInfrastructure(index, sea, roadGroundHeight(world, x, z), x, z);
          worst = Math.max(worst, Math.abs(h - 0.5 * (piece.ha + piece.hb)));
          count += 1;
        }
      }
      expect(count).toBeGreaterThan(50);
      expect(worst).toBeLessThan(1e-9);
    } finally {
      clearInfrastructureRegions();
    }
  });
});
