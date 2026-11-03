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
import { ROAD_CLASS, ROAD_PRIORITY, roadClass, roadFormationHalfWidth } from "@/src/world/roads/roadClasses";
import {
  roadPieceKey,
  roadRegionInfrastructure,
  roadRegionKey,
  ROAD_PIECE_KEY_STRIDE,
} from "@/src/world/roads/roadInfrastructure";
import {
  RoadNetwork,
  roadRegionOf,
  ROAD_LAYERS,
  ROAD_PAD_APRON_METERS,
  type RoadPiece,
} from "@/src/world/roads/roadNetwork";
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
    // Cut: the ditch's bottom at its width, its far side back at the formation's level at twice it
    // (a 1:3 V either side), then the back slope.
    expect(roadBatterTarget(edge, 1.5, 150, 0.5, 1.5)).toBeCloseTo(edge - 0.5, 12);
    expect(roadBatterTarget(edge, 3, 150, 0.5, 1.5)).toBeCloseTo(edge, 12);
    expect(roadBatterTarget(edge, 4.5, 150, 0.5, 1.5)).toBeCloseTo(edge + 1.5 / ROAD_CUT_BATTER_RUN, 12);
    // A ditch digs into level ground beside the road, the same both sides, and no fill rises over it.
    expect(roadBatterTarget(edge, 0.75, edge, 0.5, 1.5)).toBeCloseTo(edge - 0.25, 12);
    expect(roadBatterTarget(edge, 2.25, edge, 0.5, 1.5)).toBeCloseTo(edge - 0.25, 12);
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

describe("a piece easing its crown out", () => {
  it("runs its cross-fall linearly from a to b, and holds b's past it", () => {
    const spec = roadClass(ROAD_CLASS.gravel);
    const piece: InfrastructureSegment = {
      profile: INFRASTRUCTURE_PROFILE.carriageway,
      mode: "set",
      priority: spec.priority,
      ax: 0, az: 0, bx: 20, bz: 0,
      halfWidth: roadFormationHalfWidth(spec),
      reach: 10,
      // Crown 4% at a, eased to 0 at b; level, no superelevation.
      params: [10, 10, 0, 0, 0.04, spec.ditchDepth, spec.ditchWidth, -0.04],
      key: 1,
    };
    const out: InfrastructureProfileSample = { target: 0, weight: 0 };
    for (const [along, crossfall] of [[0, 0.04], [5, 0.03], [10, 0.02], [20, 0], [21, 0]] as const) {
      for (const across of [-3, 3]) {
        roadCarriagewayHeight(along, across, 20, piece, 0, 0, out);
        expect(out.target).toBeCloseTo(10 + roadCrossOffset(across, 0, crossfall), 12);
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

  it("tilts its level, apron and batters with the plane it is given", () => {
    const tilted: InfrastructureSegment = { ...pad, params: [30, 8, 0.08, 0.03, -0.01] };
    const plane = (along: number, across: number) => sea + 30 + 0.03 * along - 0.01 * across;
    roadJunctionPadHeight(5, -4, 0, tilted, sea + 31, sea, out);
    expect(out.target).toBeCloseTo(plane(5, -4), 9);
    // 2 m into the apron over high ground: 0.16 m over the plane there.
    roadJunctionPadHeight(0, 10, 0, tilted, sea + 40, sea, out);
    expect(out.target).toBeCloseTo(plane(0, 10) + 0.16, 9);
    roadJunctionPadHeight(-15, 0, 0, tilted, sea, sea, out);
    expect(out.target).toBeCloseTo(plane(-15, 0) - 0.24 - 4 / ROAD_FILL_BATTER_RUN, 9);
  });
});

describe("a real network in the stage", () => {
  const head = airportRoadHead(world)!;
  const network = new RoadNetwork(world);
  const rx = roadRegionOf(head.startX);
  const rz = roadRegionOf(head.startZ);
  const regions = ROAD_LAYERS.map((layer) => ({ layer, region: network.region(layer, rx, rz) }));
  const infrastructure = regions.map(({ region }) => roadRegionInfrastructure(network, region));

  it("lays every piece, patch and pad out once, keyed, with reaches sized to the ground", () => {
    expect(infrastructure.map((region) => region.key)).toEqual(ROAD_LAYERS.map((layer) => roadRegionKey(layer, rx, rz)));
    const segments = infrastructure.flatMap((region) => region.segments);
    const pieces = regions.flatMap(({ region }) => region.pieces);
    const others = regions.reduce((sum, { region }) => sum + region.pads.length + region.patches.length, 0);
    expect(segments.length).toBe(pieces.length + others);
    const keys = new Set<string>();
    for (const segment of segments) {
      const unique = `${segment.priority}:${segment.key}`;
      expect(keys.has(unique)).toBe(false);
      keys.add(unique);
    }
    expect(pieces.map(roadPieceKey).every(Number.isSafeInteger)).toBe(true);
    // A crossing patch's batters only run a shoulder into the ditch beside it.
    const patches = segments.filter((segment) => segment.priority === ROAD_PRIORITY.crossing);
    expect(patches.length).toBe(regions.reduce((sum, { region }) => sum + region.patches.length, 0));
    expect(patches.every((segment) => segment.reach === 2 && segment.mode === "set" && segment.surface === undefined)).toBe(true);
    const reaches = segments.filter((segment) => segment.priority !== ROAD_PRIORITY.crossing).map((segment) => segment.reach);
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

  /** The largest rise between points 0.25 m apart across x and z, over a 0.5 m grid of the points `on` keeps round (x, z). */
  function steepestRise(x: number, z: number, radius: number, on: (px: number, pz: number) => boolean): { rise: number; points: number } {
    const index = infrastructureIndex(world);
    const height = (px: number, pz: number) => applyInfrastructure(index, sea, roadGroundHeight(world, px, pz), px, pz);
    let rise = 0;
    let points = 0;
    for (let ox = -radius; ox <= radius; ox += 0.5) {
      for (let oz = -radius; oz <= radius; oz += 0.5) {
        const px = x + ox;
        const pz = z + oz;
        if (ox * ox + oz * oz > radius * radius || !on(px, pz)) continue;
        const h = height(px, pz);
        rise = Math.max(rise, Math.abs(height(px + 0.25, pz) - h), Math.abs(height(px, pz + 0.25) - h));
        points += 1;
      }
    }
    return { rise, points };
  }

  /** Is (x, z) on the formation of one of `pieces`, 0.3 m in from its edge? */
  function onFormation(pieces: readonly RoadPiece[], x: number, z: number): boolean {
    return pieces.some((piece) => {
      const dx = piece.bx - piece.ax;
      const dz = piece.bz - piece.az;
      const t = Math.max(0, Math.min(1, ((x - piece.ax) * dx + (z - piece.az) * dz) / (dx * dx + dz * dz)));
      const distance = Math.hypot(x - piece.ax - dx * t, z - piece.az - dz * t);
      return distance <= roadFormationHalfWidth(roadClass(piece.classId)) - 0.3;
    });
  }

  it("grades a crossing to one level across both formations, its ditch laid over under the lower road", () => {
    clearInfrastructureRegions();
    installInfrastructureRegions(world, infrastructure);
    try {
      const pieces = regions.flatMap(({ region }) => region.pieces);
      const patches = regions.flatMap(({ region }) => region.patches);
      expect(patches.length).toBeGreaterThan(0);
      // One probe per crossing: its first patch piece on each side starts at the outranking formation.
      const starts = patches.filter((patch) => patch.index % 16 === 0);
      for (const start of starts) {
        const near = pieces.filter((piece) => Math.min(
          Math.hypot(piece.ax - start.ax, piece.az - start.az),
          Math.hypot(piece.bx - start.ax, piece.bz - start.az),
          Math.hypot(0.5 * (piece.ax + piece.bx) - start.ax, 0.5 * (piece.az + piece.bz) - start.az),
        ) < 60);
        const { rise, points } = steepestRise(start.ax, start.az, 18, (px, pz) => onFormation(near, px, pz));
        expect(points).toBeGreaterThan(200);
        // A tyre rolls over it: no kerb, no ditch's wall (a 1:3 ditch side is 8 cm in 25 cm).
        expect(rise, `crossing patch at (${start.ax.toFixed(1)}, ${start.az.toFixed(1)})`).toBeLessThan(0.1);
      }
    } finally {
      clearInfrastructureRegions();
    }
  });

  it("lays each pad as a plane the roads meeting it run onto without a kerb", () => {
    clearInfrastructureRegions();
    installInfrastructureRegions(world, infrastructure);
    try {
      const index = infrastructureIndex(world);
      const pieces = regions.flatMap(({ region }) => region.pieces);
      const pads = regions.flatMap(({ region }) => region.pads);
      expect(pads.length).toBeGreaterThan(3);
      for (const pad of pads) {
        const reach = pad.radius + ROAD_PAD_APRON_METERS + 4;
        const near = pieces.filter((piece) => Math.min(
          Math.hypot(piece.ax - pad.x, piece.az - pad.z),
          Math.hypot(piece.bx - pad.x, piece.bz - pad.z),
        ) < reach + 45);
        const { rise } = steepestRise(pad.x, pad.z, reach, (px, pz) => onFormation(near, px, pz));
        expect(rise, `pad at node ${pad.nodeId}`).toBeLessThan(0.1);
        // Its core is its plane (the marina's car park, composed after, aside).
        const coreX = pad.x + 0.5 * pad.radius;
        const plane = pad.height + pad.gradientX * (coreX - pad.x);
        const h = applyInfrastructure(index, sea, roadGroundHeight(world, coreX, pad.z), coreX, pad.z);
        if (Math.abs(h - plane) > 1e-6) expect(pad.gradientX === 0 && pad.gradientZ === 0, `pad at node ${pad.nodeId}`).toBe(true);
      }
    } finally {
      clearInfrastructureRegions();
    }
  });
});
