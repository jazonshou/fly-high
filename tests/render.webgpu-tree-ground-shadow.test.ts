import { describe, expect, it } from "vitest";
import {
  DETAIL_INSTANCE_ATTRIBUTES,
  DetailInstanceBounds,
  DetailInstanceWriter,
  detailPrototypeBoundKernel,
} from "../src/render/webgpu/detail/instanceFormat";
import {
  DETAIL_DENSITY_ADMISSION_MARGIN_SHARE,
  DETAIL_MEMBERSHIP_SLACK_METERS,
  estimateTreeGroundShadowRecords,
  treeGroundShadowAdmitted,
  treeGroundShadowReachMeters,
} from "../src/render/webgpu/detail/presentationBuild";
import {
  DETAIL_NEAR_SWITCH_INSET_METERS,
  RENDERED_DENSITY_LAWS,
  drawnShareAtDistance,
  estimateRenderedWoodyLoad,
} from "../src/render/webgpu/detail/renderedDensity";
import {
  TREE_GROUND_SHADOW_BARE_SHARE,
  TREE_GROUND_SHADOW_CROWN_FILL,
  TREE_GROUND_SHADOW_MAX_COTANGENT,
  TREE_GROUND_SHADOW_PROTOTYPE_BOUNDS,
  TREE_GROUND_SHADOW_SHAPES,
  TREE_GROUND_SHADOW_SKY_SHADE_RADIUS,
  TREE_GROUND_SHADOW_SOFT_EDGE,
  TREE_GROUND_SHADOW_TRUNK_STEP_METERS,
  treeGroundShadowFootprint,
  treeGroundShadowRecord,
} from "../src/render/webgpu/detail/treeGroundShadow";
import {
  TREE_GROUND_SHADOW_FRAGMENT_WGSL,
  TREE_GROUND_SHADOW_VERTEX_WGSL,
} from "../src/render/webgpu/detail/TreeGroundShadowMaterial";
import type { DetailTreePlacement, TreeSpecies } from "../src/render/webgpu/detail/types";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";

const SPECIES = Object.keys(TREE_GROUND_SHADOW_SHAPES) as TreeSpecies[];

function tree(overrides: Partial<DetailTreePlacement> = {}): DetailTreePlacement {
  return {
    kind: "tree",
    id: "tree-0",
    species: "oak",
    x: 1_204.5,
    y: 88.25,
    z: -730.75,
    yawRadians: 0.4,
    heightMeters: 16,
    crownRadiusMeters: 4.4,
    trunkRadiusMeters: 0.3,
    windPhaseRadians: 0.2,
    windResponse: 0.4,
    color: [0.4, 0.5, 0.3, 1],
    standAge: 0.5,
    selection: 0.3,
    ...overrides,
  };
}

function rotate(
  v: readonly [number, number, number],
  q: readonly [number, number, number, number],
): [number, number, number] {
  const [x, y, z, w] = q;
  const cx = y * v[2] - z * v[1] + w * v[0];
  const cy = z * v[0] - x * v[2] + w * v[1];
  const cz = x * v[1] - y * v[0] + w * v[2];
  return [
    v[0] + 2 * (y * cz - z * cy),
    v[1] + 2 * (z * cx - x * cz),
    v[2] + 2 * (x * cy - y * cx),
  ];
}

describe("tree ground shadow record", () => {
  it("sits at the stem's base, in the floating origin's frame", () => {
    const record = treeGroundShadowRecord(tree(), 0.25, 0.5, { x: 1_000, y: 80, z: -700 });
    expect(record.x).toBeCloseTo(204.5, 9);
    expect(record.y).toBeCloseTo(8.25, 9);
    expect(record.z).toBeCloseTo(-30.75, 9);
    expect(record.heightScaleMeters).toBe(16);
    // The radial lane is the crown radius over the height (prototype unit 1).
    expect(record.radialScale * record.heightScaleMeters).toBeCloseTo(4.4, 9);
    expect(record.fade).toBe(1);
    expect(record.windResponse).toBe(0);
  });

  it("tilts its plane to the slope the tree stands on", () => {
    const origin = { x: 0, y: 0, z: 0 };
    // Level ground, and a tree the generator gave no slope: the plane is level.
    for (const level of [tree(), tree({ groundSlopeX: 0, groundSlopeZ: 0 })]) {
      const normal = rotate([0, 1, 0], treeGroundShadowRecord(level, 0, 0, origin).quaternion);
      expect(normal[0]).toBeCloseTo(0, 9);
      expect(normal[1]).toBeCloseTo(1, 9);
      expect(normal[2]).toBeCloseTo(0, 9);
    }
    // Height rising 0.3 m per metre east and falling 0.2 per metre north:
    // the normal of y = 0.3 x - 0.2 z is (-0.3, 1, 0.2), normalised.
    const sloped = treeGroundShadowRecord(
      tree({ groundSlopeX: 0.3, groundSlopeZ: -0.2 }), 0, 0, origin,
    );
    const length = Math.hypot(0.3, 1, 0.2);
    const normal = rotate([0, 1, 0], sloped.quaternion);
    expect(normal[0]).toBeCloseTo(-0.3 / length, 6);
    expect(normal[1]).toBeCloseTo(1 / length, 6);
    expect(normal[2]).toBeCloseTo(0.2 / length, 6);
    // Both in-plane axes the shader builds on lie in the ground: a step
    // along either climbs exactly what the slope says.
    for (const axis of [[1, 0, 0], [0, 0, 1]] as const) {
      const inPlane = rotate(axis, sloped.quaternion);
      expect(inPlane[1]).toBeCloseTo(0.3 * inPlane[0] - 0.2 * inPlane[2], 6);
    }
    // A slope that is not a number reads as level, never as NaN.
    const broken = treeGroundShadowRecord(
      tree({ groundSlopeX: Number.NaN, groundSlopeZ: Number.POSITIVE_INFINITY }), 0, 0, origin,
    );
    expect(broken.quaternion.every(Number.isFinite)).toBe(true);
  });

  it("carries the crown's shape, the stand's density and the stem's key", () => {
    const origin = { x: 0, y: 0, z: 0 };
    for (const species of SPECIES) {
      const shape = TREE_GROUND_SHADOW_SHAPES[species];
      const record = treeGroundShadowRecord(tree({ species }), 0.62, 0.37, origin);
      expect(record.tint[0]).toBe(shape.crownCentreUnit);
      expect(record.tint[1]).toBe(shape.crownSemiAxisUnit);
      expect(record.tint[2]).toBeCloseTo(shape.opacity, 9);
      expect(record.tint[3]).toBe(0.37);
      // The same lane, and so the same number, its tree records thin on.
      expect(record.windPhase).toBe(0.62);
      // The crown reaches above its centre and stays above the ground.
      expect(shape.crownCentreUnit - shape.crownSemiAxisUnit).toBeGreaterThan(0);
      expect(shape.crownCentreUnit + shape.crownSemiAxisUnit).toBeLessThanOrEqual(1.1);
      expect(shape.opacity).toBeGreaterThan(0.5);
      expect(shape.opacity).toBeLessThan(1);
    }
    expect(treeGroundShadowRecord(tree(), 0, 4, origin).tint[3]).toBe(1);
    expect(treeGroundShadowRecord(tree(), 0, -1, origin).tint[3]).toBe(0);
  });

  it("thins a bare crown's shadow to its branches", () => {
    const origin = { x: 0, y: 0, z: 0 };
    const opacity = TREE_GROUND_SHADOW_SHAPES.birch.opacity;
    const leaf = (fraction: number): number => treeGroundShadowRecord(
      tree({ species: "birch", color: [0.4, 0.5, 0.3, fraction] }), 0, 0, origin,
    ).tint[2];
    expect(leaf(1)).toBeCloseTo(opacity, 9);
    expect(leaf(0)).toBeCloseTo(opacity * TREE_GROUND_SHADOW_BARE_SHARE, 9);
    expect(leaf(0.5)).toBeGreaterThan(leaf(0));
    expect(leaf(0.5)).toBeLessThan(leaf(1));
    expect(leaf(7)).toBeCloseTo(opacity, 9);
  });

  it("keeps the trunk lane under the packer's modifier bits", () => {
    const origin = { x: 0, y: 0, z: 0 };
    const variant = (trunkRadiusMeters: number): number =>
      treeGroundShadowRecord(tree({ trunkRadiusMeters }), 0, 0, origin).variant;
    expect(variant(0.3)).toBe(Math.round(0.3 / TREE_GROUND_SHADOW_TRUNK_STEP_METERS));
    expect(variant(0)).toBe(1);
    // 32 and up would switch on the packer's lean modifier and its bound.
    expect(variant(5)).toBe(31);
  });

  it("packs into the detail instance record unchanged", () => {
    const record = treeGroundShadowRecord(
      tree({ groundSlopeX: 0.2, groundSlopeZ: 0.1 }), 100 / 255, 0.6, { x: 1_000, y: 0, z: -700 },
    );
    const writer = new DetailInstanceWriter();
    const bounds = new DetailInstanceBounds();
    writer.pushBounded(record, bounds, detailPrototypeBoundKernel(TREE_GROUND_SHADOW_PROTOTYPE_BOUNDS));
    const bytes = writer.finish();
    expect(bytes.byteLength).toBe(32);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getFloat32(0, true)).toBeCloseTo(204.5, 4);
    // The key lane holds the stem's key code, the variant lane the trunk steps.
    expect(view.getUint8(30)).toBe(100);
    expect(view.getUint8(29)).toBe(10);
    expect(view.getUint8(24)).toBe(Math.round(TREE_GROUND_SHADOW_SHAPES.oak.crownCentreUnit * 255));
    expect(view.getUint8(27)).toBe(Math.round(0.6 * 255));
  });
});

describe("tree ground shadow footprint", () => {
  const oak = TREE_GROUND_SHADOW_SHAPES.oak;

  it("is a disc under the crown with the sun overhead", () => {
    const footprint = treeGroundShadowFootprint(16, 4, oak, 0);
    expect(footprint.offsetMeters).toBe(0);
    expect(footprint.semiAlongMeters).toBeCloseTo(4 * TREE_GROUND_SHADOW_CROWN_FILL, 9);
    expect(footprint.semiAcrossMeters).toBeCloseTo(4 * TREE_GROUND_SHADOW_CROWN_FILL, 9);
    expect(footprint.quadStartMeters).toBeCloseTo(-footprint.quadEndMeters, 9);
  });

  it("moves away from the sun and stretches as the sun drops", () => {
    let previous = treeGroundShadowFootprint(16, 4, oak, 0);
    for (const cotangent of [0.4, 1, 1.7, TREE_GROUND_SHADOW_MAX_COTANGENT]) {
      const footprint = treeGroundShadowFootprint(16, 4, oak, cotangent);
      // The crown's middle, at its height, thrown down the sun's ray.
      expect(footprint.offsetMeters).toBeCloseTo(oak.crownCentreUnit * 16 * cotangent, 9);
      expect(footprint.offsetMeters).toBeGreaterThan(previous.offsetMeters);
      expect(footprint.semiAlongMeters).toBeGreaterThan(previous.semiAlongMeters);
      expect(footprint.semiAcrossMeters).toBe(previous.semiAcrossMeters);
      expect(footprint.quadEndMeters).toBeGreaterThan(previous.quadEndMeters);
      previous = footprint;
    }
  });

  it("stops growing at the longest shadow drawn", () => {
    const longest = treeGroundShadowFootprint(16, 4, oak, TREE_GROUND_SHADOW_MAX_COTANGENT);
    expect(treeGroundShadowFootprint(16, 4, oak, 40)).toEqual(longest);
    expect(treeGroundShadowFootprint(16, 4, oak, -3)).toEqual(treeGroundShadowFootprint(16, 4, oak, 0));
  });

  it("keeps the whole shadow, the sky shade and the stem inside the quad", () => {
    for (const species of SPECIES) {
      const shape = TREE_GROUND_SHADOW_SHAPES[species];
      for (const cotangent of [0, 0.3, 1, TREE_GROUND_SHADOW_MAX_COTANGENT]) {
        const footprint = treeGroundShadowFootprint(20, 5, shape, cotangent);
        const skyShade = 5 * TREE_GROUND_SHADOW_SKY_SHADE_RADIUS;
        expect(footprint.quadStartMeters).toBeLessThanOrEqual(-skyShade);
        expect(footprint.quadEndMeters).toBeGreaterThanOrEqual(skyShade);
        expect(footprint.quadHalfWidthMeters).toBeGreaterThanOrEqual(skyShade);
        // The crown shadow out to its soft edge, both ways along the sun.
        expect(footprint.quadEndMeters).toBeGreaterThanOrEqual(
          footprint.offsetMeters + footprint.semiAlongMeters * TREE_GROUND_SHADOW_SOFT_EDGE - 1e-9,
        );
        expect(footprint.quadStartMeters).toBeLessThanOrEqual(
          footprint.offsetMeters - footprint.semiAlongMeters * TREE_GROUND_SHADOW_SOFT_EDGE + 1e-9,
        );
        expect(footprint.quadHalfWidthMeters).toBeGreaterThanOrEqual(
          footprint.semiAcrossMeters * TREE_GROUND_SHADOW_SOFT_EDGE - 1e-9,
        );
      }
    }
  });

  it("never reaches past the bound its batches are culled with", () => {
    const kernel = detailPrototypeBoundKernel(TREE_GROUND_SHADOW_PROTOTYPE_BOUNDS);
    let tightest = Number.POSITIVE_INFINITY;
    for (const species of SPECIES) {
      const shape = TREE_GROUND_SHADOW_SHAPES[species];
      for (const height of [3, 9, 20, 48]) {
        for (const crownOverHeight of [0.08, 0.25, 0.5, 0.9]) {
          const crownRadius = height * crownOverHeight;
          // The packer's sphere round the stem: X and Z in crown radii, Y in heights.
          const bound = Math.hypot(
            kernel.extremeXUnit * crownRadius,
            kernel.extremeYUnit * height,
            kernel.extremeZUnit * crownRadius,
          );
          for (const cotangent of [0, 0.5, 1.5, TREE_GROUND_SHADOW_MAX_COTANGENT, 100]) {
            const footprint = treeGroundShadowFootprint(height, crownRadius, shape, cotangent);
            const reach = Math.hypot(
              Math.max(-footprint.quadStartMeters, footprint.quadEndMeters),
              footprint.quadHalfWidthMeters,
            );
            expect(reach, `${species} ${height} m, crown ${crownRadius} m, cot ${cotangent}`)
              .toBeLessThanOrEqual(bound);
            tightest = Math.min(tightest, bound / reach);
          }
        }
      }
    }
    // Conservative, and not by so much that the bound culls nothing.
    expect(tightest).toBeGreaterThanOrEqual(1);
    expect(tightest).toBeLessThan(1.6);
  });
});

describe("tree ground shadow reach", () => {
  const TIERS = [
    ["low", "performance"], ["medium", "balanced"], ["high", "balanced"], ["high", "ultra"],
  ] as const;

  it("draws on every tier, past the near band and never past the mid band", () => {
    let previous = 0;
    for (const [quality, mode] of TIERS) {
      const profile = resolveWebGpuQualityProfile(quality, mode);
      const law = profile.renderedDensityLaw;
      const range = profile.treeGroundShadowRangeMeters;
      expect(range, `tier ${profile.tier}`).toBeGreaterThan(law.near.outerRadiusMeters);
      expect(range, `tier ${profile.tier}`).toBeLessThanOrEqual(law.mid.outerRadiusMeters);
      expect(range, `tier ${profile.tier}`).toBeGreaterThan(previous);
      previous = range;
      // Where near trees cast real shadows, the decal has ground to cover beyond them.
      if (profile.vegetationCastsShadows) {
        expect(range).toBeGreaterThan(
          3 * (law.near.outerRadiusMeters - DETAIL_NEAR_SWITCH_INSET_METERS),
        );
      }
    }
  });

  it("reaches the range plus the membership slack, capped at the mid band", () => {
    const law = RENDERED_DENSITY_LAWS[1]!;
    expect(treeGroundShadowReachMeters(undefined, law)).toBe(0);
    expect(treeGroundShadowReachMeters(0, law)).toBe(0);
    expect(treeGroundShadowReachMeters(-5, law)).toBe(0);
    expect(treeGroundShadowReachMeters(Number.NaN, law)).toBe(0);
    expect(treeGroundShadowReachMeters(600, law)).toBe(600 + DETAIL_MEMBERSHIP_SLACK_METERS);
    expect(treeGroundShadowReachMeters(50_000, law)).toBe(
      law.mid.outerRadiusMeters + DETAIL_MEMBERSHIP_SLACK_METERS,
    );
  });

  it("admits every stem the shader can draw before the chunk is rebuilt", () => {
    RENDERED_DENSITY_LAWS.forEach((law, tier) => {
      const reach = treeGroundShadowReachMeters(law.mid.outerRadiusMeters, law);
      for (let distance = 0; distance <= reach; distance += 13) {
        // The observer can close one membership slack on a stem before its
        // chunk rebuilds; whatever the shader would draw anywhere in that
        // window must already have a record.
        for (let closer = 0; closer <= DETAIL_MEMBERSHIP_SLACK_METERS; closer += 16) {
          const live = Math.max(0, distance - closer);
          const key = drawnShareAtDistance(law, live);
          expect(
            treeGroundShadowAdmitted(distance, key, law, reach),
            `tier ${tier}: key ${key} at ${distance} m, seen from ${live} m`,
          ).toBe(true);
        }
        // And not the whole field: a key past the share and its margin has none.
        const ceiling = drawnShareAtDistance(
          law, Math.max(0, distance - DETAIL_MEMBERSHIP_SLACK_METERS),
        ) + DETAIL_DENSITY_ADMISSION_MARGIN_SHARE;
        if (ceiling < 1) {
          expect(treeGroundShadowAdmitted(distance, ceiling + 1e-6, law, reach)).toBe(false);
        }
        // A stem the near cap never draws (key 2) never gets a shadow.
        expect(treeGroundShadowAdmitted(distance, 2, law, reach)).toBe(false);
      }
      expect(treeGroundShadowAdmitted(reach + 0.01, 0, law, reach)).toBe(false);
      expect(treeGroundShadowAdmitted(10, 0, law, 0)).toBe(false);
    });
  });

  it("prices its records from the same admission test", () => {
    RENDERED_DENSITY_LAWS.forEach((law, tier) => {
      expect(estimateTreeGroundShadowRecords(0, law)).toBe(0);
      expect(estimateTreeGroundShadowRecords(undefined, law)).toBe(0);
      let previous = 0;
      for (const share of [0.2, 0.45, 0.7, 1]) {
        const range = share * law.mid.outerRadiusMeters;
        const records = estimateTreeGroundShadowRecords(range, law);
        expect(records, `tier ${tier} at ${range} m`).toBeGreaterThan(previous);
        previous = records;
      }
      // Past the mid band there is nothing more to add.
      expect(estimateTreeGroundShadowRecords(1e6, law)).toBe(previous);
      // Every stem inside the near radius has one...
      const estimate = estimateRenderedWoodyLoad(law);
      expect(previous).toBeGreaterThan(estimate.nearStems);
      // ...and beyond it only the drawn share, with its slack and margin: far
      // fewer than one per stem the cap could hold out to the reach.
      const reach = treeGroundShadowReachMeters(law.mid.outerRadiusMeters, law);
      const everyStem = Math.PI * reach * reach / 10_000 * law.nearStemsPerHectare;
      expect(previous).toBeLessThan(everyStem * 0.75);
    });
  });
});

describe("tree ground shadow shader", () => {
  it("reads the detail instance record's attributes and writes a multiplier", () => {
    for (const attribute of DETAIL_INSTANCE_ATTRIBUTES) {
      expect(TREE_GROUND_SHADOW_VERTEX_WGSL).toContain(`attribute ${attribute.kind}:`);
    }
    // ALPHA_MULTIPLY scales what is drawn by the colour and must leave alpha alone.
    expect(TREE_GROUND_SHADOW_FRAGMENT_WGSL).toMatch(
      /fragmentOutputs\.color = vec4f\(keep, 0\.0\);/,
    );
  });

  it("builds the footprint its CPU mirror describes, from the same constants", () => {
    const source = TREE_GROUND_SHADOW_VERTEX_WGSL;
    expect(source).toContain(
      `let semiAcross = crownRadius * ${TREE_GROUND_SHADOW_CROWN_FILL};`,
    );
    expect(source).toContain("let semiAlong = length(vec2f(semiAcross, semiAxis * cotangent));");
    expect(source).toContain("let offset = centreHeight * cotangent;");
    expect(source).toContain(
      `let skyRadius = crownRadius * ${TREE_GROUND_SHADOW_SKY_SHADE_RADIUS};`,
    );
    expect(source).toContain(`let softEdge = ${TREE_GROUND_SHADOW_SOFT_EDGE};`);
    expect(source).toContain(
      `inPlaneLength / max(incidence, 1e-3), ${TREE_GROUND_SHADOW_MAX_COTANGENT});`,
    );
    expect(source).toContain(`* ${TREE_GROUND_SHADOW_TRUNK_STEP_METERS};`);
  });

  it("keeps a shadow on screen where its plane is, and only moves its depth", () => {
    const source = TREE_GROUND_SHADOW_VERTEX_WGSL;
    // The position is on the plane itself: no term along the normal.
    expect(source).toContain("let worldPosition = base + along * planeX + across * planeY;");
    expect(source).toContain("clip.z = depthClip.z / depthClip.w * clip.w;");
  });
});
