import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import { detailStemHash, type DetailInstanceRecord } from "../src/render/webgpu/detail/instanceFormat";
import {
  DETAIL_PROTOTYPE_SEED,
  LOG_PROTOTYPE_AXIS_HEIGHT,
  ROCK_PROTOTYPE_RING,
  ROCK_PROTOTYPE_TOP,
  selectNearSolids,
  STUMP_PROTOTYPE_HEIGHT,
  type NearSolidsSelectionInput,
} from "../src/render/webgpu/detail/nearSolidsSelection";
import { buildPresentationChunk } from "../src/render/webgpu/detail/presentationBuild";
import {
  buildClutterPrototype,
  buildRockPrototype,
  buildTreePrototype,
} from "../src/render/webgpu/detail/prototypeGeometry";
import { RENDERED_DENSITY_LAWS } from "../src/render/webgpu/detail/renderedDensity";
import type { TreeSpecies } from "../src/render/webgpu/detail/types";
import { createColliderSweepHit } from "../src/sim/colliders";
import {
  NEAR_SOLID_KIND,
  NEAR_SOLID_MATERIAL,
  NEAR_SOLID_STRIDE,
  nearSolidsColliderWorld,
  type NearSolidsPost,
} from "../src/sim/person/nearSolids";
import { forestCell, forestHeight, realDetailCatalog, ROCK_VARIANTS } from "./support/nearSolidsFixture";
import { environment, groundOf, run, walker } from "./support/walkerRig";

/**
 * The near solids follow what the near view draws (W1 brief): every trunk
 * drawn within 25 m of the walker has a collider and nothing else does, and
 * each collider sits on the drawn geometry.
 */

interface Drawn {
  readonly key: string;
  readonly record: DetailInstanceRecord;
}

const catalog = realDetailCatalog();
const forest = forestCell();
const CENTER_X = forest.cell.minX + 240;
const CENTER_Z = forest.cell.minZ + 270;

/** Every record the presentation build writes round the centre, as the near view draws it. */
function drawn(law: (typeof RENDERED_DENSITY_LAWS)[number], treeVariantCap: number, treePrototypeMode: "families" | "species"): Drawn[] {
  const records: Drawn[] = [];
  const iterator = buildPresentationChunk(
    {
      residents: [{ ...forest, lod: "near", distance: 0 }],
      floatingOrigin: { x: 0, y: 0, z: 0 },
      densityLaw: law,
      treeVariantCap,
      treePrototypeMode,
      grassRadiusMeters: 0,
      observerX: CENTER_X,
      observerZ: CENTER_Z,
    },
    catalog,
    {
      appendInstance(key, record) {
        records.push({ key, record: { ...record, quaternion: [...record.quaternion], tint: [...record.tint] } });
      },
    },
  );
  for (let step = iterator.next(); !step.done; step = iterator.next());
  return records;
}

function selection(law: (typeof RENDERED_DENSITY_LAWS)[number], treeVariantCap: number, treePrototypeMode: "families" | "species", radius = 48): NearSolidsSelectionInput {
  return {
    residents: [forest],
    centerX: CENTER_X,
    centerZ: CENTER_Z,
    radius,
    nearStemsPerHectare: law.nearStemsPerHectare,
    treeVariantCap,
    treePrototypeMode,
  };
}

interface Solid {
  kind: number;
  a: { x: number; y: number; z: number };
  b: { x: number; y: number; z: number };
  radius: number;
}

function solidsOf(records: Float32Array): Solid[] {
  const solids: Solid[] = [];
  for (let at = 0; at < records.length; at += NEAR_SOLID_STRIDE) {
    solids.push({
      kind: records[at]!,
      a: { x: CENTER_X + records[at + 1]!, y: records[at + 2]!, z: CENTER_Z + records[at + 3]! },
      b: { x: CENTER_X + records[at + 4]!, y: records[at + 5]!, z: CENTER_Z + records[at + 6]! },
      radius: records[at + 7]!,
    });
  }
  return solids;
}

/** A trunk capsule's base: half a metre up its axis from `a`. */
function trunkBase(solid: Solid): { x: number; y: number; z: number } {
  const dx = solid.b.x - solid.a.x;
  const dy = solid.b.y - solid.a.y;
  const dz = solid.b.z - solid.a.z;
  const length = Math.hypot(dx, dy, dz);
  return { x: solid.a.x + (dx / length) * 0.5, y: solid.a.y + (dy / length) * 0.5, z: solid.a.z + (dz / length) * 0.5 };
}

function horizontal(point: { x: number; z: number }): number {
  return Math.hypot(point.x - CENTER_X, point.z - CENTER_Z);
}

function rotate(q: readonly number[], x: number, y: number, z: number): { x: number; y: number; z: number } {
  const [qx, qy, qz, qw] = q as [number, number, number, number];
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return { x: x + qw * tx + (qy * tz - qz * ty), y: y + qw * ty + (qz * tx - qx * tz), z: z + qw * tz + (qx * ty - qy * tx) };
}

function segmentDistance(p: { x: number; y: number; z: number }, a: Solid["a"], b: Solid["b"]): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / (abx * abx + aby * aby + abz * abz)));
  return Math.hypot(p.x - a.x - abx * t, p.y - a.y - aby * t, p.z - a.z - abz * t);
}

const TIERS = [
  { name: "Low", law: RENDERED_DENSITY_LAWS[0]!, cap: 1, mode: "families" as const },
  { name: "Medium", law: RENDERED_DENSITY_LAWS[1]!, cap: 1, mode: "families" as const },
  { name: "High", law: RENDERED_DENSITY_LAWS[2]!, cap: 5, mode: "species" as const },
];

describe("near solids", () => {
  it("are 48 m round the walker, 32 m on Low", () => {
    for (const quality of ["low", "medium", "high"] as const) {
      for (const mode of ["performance", "balanced", "ultra"] as const) {
        const profile = resolveWebGpuQualityProfile(quality, mode);
        expect(profile.nearSolidsRadiusMeters, `${quality}/${mode}`).toBe(profile.tier === 0 ? 32 : 48);
      }
    }
  });

  for (const tier of TIERS) {
    it(`give every trunk the near view draws within 25 m a collider, and no other stem one (${tier.name})`, () => {
      const trunks = drawn(tier.law, tier.cap, tier.mode)
        .filter((entry) => /^tree-.*-trunk-near$/.test(entry.key) && horizontal(entry.record) <= 25);
      const solids = solidsOf(selectNearSolids(selection(tier.law, tier.cap, tier.mode), catalog))
        .filter((solid) => solid.kind === NEAR_SOLID_KIND.trunk)
        .map(trunkBase)
        .filter((base) => horizontal(base) <= 25);
      // The forest is dense enough that the cap, not the authored field, sets what is drawn.
      expect(forest.cell.trees.filter((tree) => horizontal(tree) <= 25).length).toBeGreaterThan(trunks.length * 2);
      expect(trunks.length).toBeGreaterThan(5);
      expect(solids.length).toBe(trunks.length);
      const unmatched = [...solids];
      for (const { record } of trunks) {
        const index = unmatched.findIndex((base) => Math.hypot(base.x - record.x, base.y - record.y, base.z - record.z) < 0.01);
        expect(index, `drawn trunk at ${record.x.toFixed(1)}, ${record.z.toFixed(1)}`).toBeGreaterThanOrEqual(0);
        unmatched.splice(index, 1);
      }
    });
  }

  it("give each drawn rock, log and stump within 25 m a collider, and branch litter, moss and shrubs none", () => {
    const tier = TIERS[1]!;
    const records = drawn(tier.law, tier.cap, tier.mode).filter((entry) => horizontal(entry.record) <= 25);
    const solids = solidsOf(selectNearSolids(selection(tier.law, tier.cap, tier.mode, 25), catalog));
    const kinds = [
      { kind: NEAR_SOLID_KIND.rock, keys: /^rock-/ },
      { kind: NEAR_SOLID_KIND.log, keys: /^clutter-log$/ },
      { kind: NEAR_SOLID_KIND.stump, keys: /^clutter-stump$/ },
    ];
    for (const { kind, keys } of kinds) {
      const pieces = records.filter((entry) => keys.test(entry.key));
      const near = solids.filter((solid) => solid.kind === kind);
      expect(pieces.length, `${keys}`).toBeGreaterThan(0);
      let matched = 0;
      for (const { record } of pieces) {
        // A rock's sphere passes through its top; a log's and a stump's axis runs through the piece's own frame.
        const hit = near.find((solid) => {
          if (kind === NEAR_SOLID_KIND.rock) {
            const up = rotate(record.quaternion, 0, ROCK_PROTOTYPE_TOP * record.heightScaleMeters, 0);
            const top = { x: record.x + up.x, y: record.y + up.y, z: record.z + up.z };
            return Math.abs(Math.hypot(top.x - solid.a.x, top.y - solid.a.y, top.z - solid.a.z) - solid.radius) < 0.01
              && Math.hypot(solid.a.x - record.x, solid.a.z - record.z) < solid.radius;
          }
          const mid = { x: (solid.a.x + solid.b.x) / 2, y: (solid.a.y + solid.b.y) / 2, z: (solid.a.z + solid.b.z) / 2 };
          return Math.hypot(mid.x - record.x, mid.z - record.z) < record.heightScaleMeters * 0.3
            && Math.abs(mid.y - record.y) < record.heightScaleMeters * 0.3;
        });
        if (hit) matched += 1;
      }
      expect(matched, `${keys}`).toBe(pieces.length);
      expect(near.length, `${keys}`).toBe(pieces.length);
    }
    // Branch litter and moss are drawn here too, and stay soft.
    expect(records.some((entry) => entry.key === "clutter-branchLitter" || entry.key === "clutter-mossCushion")).toBe(true);
    expect(solids.every((solid) => (Object.values(NEAR_SOLID_KIND) as number[]).includes(solid.kind))).toBe(true);
  });

  it("fit each trunk capsule to the drawn bark up to 2.5 m", () => {
    const tier = TIERS[2]!;
    const trunks = drawn(tier.law, tier.cap, tier.mode).filter((entry) => /^tree-.*-trunk-near$/.test(entry.key) && horizontal(entry.record) <= 48);
    const solids = solidsOf(selectNearSolids(selection(tier.law, tier.cap, tier.mode), catalog))
      .filter((solid) => solid.kind === NEAR_SOLID_KIND.trunk);
    const prototypes = new Map<string, Float32Array>();
    let leaning = 0;
    for (const { key, record } of trunks) {
      const solid = solids.find((candidate) => {
        const base = trunkBase(candidate);
        return Math.hypot(base.x - record.x, base.y - record.y, base.z - record.z) < 0.01;
      })!;
      const [, species, variant] = /^tree-(\w+)-v(\d+)-trunk-near$/.exec(key)!;
      let positions = prototypes.get(key);
      if (!positions) {
        positions = buildTreePrototype(species as TreeSpecies, Number(variant), DETAIL_PROTOTYPE_SEED).trunk.positions;
        prototypes.set(key, positions);
      }
      // The vertex shader's transform, without wind and wobble.
      const height = record.heightScaleMeters;
      const across = height * record.radialScale;
      const modifier = Math.floor(Math.round(record.variant) / 32);
      const phase = detailStemHash(Math.round(record.windPhase * 255) / 255);
      const shear = modifier === 1 ? 0.1 + ((phase * 7.31) % 1) * 0.11 : 0;
      if (modifier === 1) leaning += 1;
      const ratios: number[] = [];
      for (let at = 0; at < positions.length; at += 3) {
        const y = positions[at + 1]! * height;
        if (y > 2.5) continue;
        const local = rotate(record.quaternion, positions[at]! * across + y * shear, y, positions[at + 2]! * across);
        const distance = segmentDistance({ x: record.x + local.x, y: record.y + local.y, z: record.z + local.z }, solid.a, solid.b);
        // Leave out the branches' bark: whatever stands well off the trunk.
        if (distance < solid.radius * 2.5) ratios.push(distance / solid.radius);
      }
      expect(ratios.length, key).toBeGreaterThanOrEqual(8);
      ratios.sort((first, second) => first - second);
      const median = ratios[Math.floor(ratios.length / 2)]!;
      expect(median, `${key} at ${record.x.toFixed(1)}, ${record.z.toFixed(1)}`).toBeGreaterThan(0.8);
      expect(median, `${key} at ${record.x.toFixed(1)}, ${record.z.toFixed(1)}`).toBeLessThan(1.2);
      expect(ratios[Math.floor(ratios.length * 0.1)]!).toBeGreaterThan(0.6);
      expect(ratios[Math.floor(ratios.length * 0.9)]!).toBeLessThan(1.45);
    }
    expect(trunks.length).toBeGreaterThan(30);
    expect(leaning).toBeGreaterThan(0);
  });

  it("keep the rock, log and stump shapes their prototypes draw", () => {
    for (const variant of ROCK_VARIANTS) {
      const positions = buildRockPrototype(variant, DETAIL_PROTOTYPE_SEED).positions;
      let top = -Infinity;
      let ring = 0;
      let count = 0;
      for (let at = 0; at < positions.length; at += 3) {
        top = Math.max(top, positions[at + 1]!);
        if (Math.abs(positions[at + 1]!) < 0.15) {
          ring += Math.hypot(positions[at]!, positions[at + 2]!);
          count += 1;
        }
      }
      expect(Math.abs(top - ROCK_PROTOTYPE_TOP), variant).toBeLessThan(0.04);
      expect(Math.abs(ring / count - ROCK_PROTOTYPE_RING), variant).toBeLessThan(0.04);
    }
    const log = buildClutterPrototype("log", DETAIL_PROTOTYPE_SEED).localBounds;
    // Axis 0.115 up, radius 0.13 at the thick end, bark displaced by up to 0.018.
    expect(Math.abs(log.maximum[1] - (LOG_PROTOTYPE_AXIS_HEIGHT + 0.13))).toBeLessThan(0.02);
    expect(log.maximum[0] - log.minimum[0]).toBeCloseTo(1, 2);
    const stump = buildClutterPrototype("stump", DETAIL_PROTOTYPE_SEED).localBounds;
    expect(Math.abs(stump.maximum[1] - STUMP_PROTOTYPE_HEIGHT)).toBeLessThan(0.05);
  });

  it("stop the walker at a trunk as a collider world, with the trunk's material", () => {
    const tier = TIERS[1]!;
    const records = selectNearSolids(selection(tier.law, tier.cap, tier.mode), catalog);
    const post: NearSolidsPost = { version: 1, centerX: CENTER_X, centerZ: CENTER_Z, radius: 48, records };
    const world = nearSolidsColliderWorld(post);
    expect(world.size).toBe(records.length / NEAR_SOLID_STRIDE);
    const solids = solidsOf(records);
    const trunk = solids.find((solid) => solid.kind === NEAR_SOLID_KIND.trunk && horizontal(trunkBase(solid)) < 20 && solid.radius > 0.08)!;
    const base = trunkBase(trunk);
    // A ray at chest height through the trunk's axis meets it at its radius.
    const hit = createColliderSweepHit();
    const at = (share: number) => ({ x: base.x - 3 + 6 * share, y: base.y + 1.2, z: base.z });
    expect(world.raycast(at(0), at(1), hit)).toBe(true);
    expect(hit.material).toBe(NEAR_SOLID_MATERIAL.trunk);
    // The walker, on the forest cell's own ground, walking at it from 3 m: stopped a capsule's width short.
    const ground = groundOf((out) => {
      out.height = forestHeight(out.x, out.z);
      out.dhdx = 0.04 * Math.cos(out.x * 0.01);
      out.dhdz = -0.039 * Math.sin(out.z * 0.013);
    });
    const subject = walker({ x: base.x - 3, y: ground.height(base.x - 3, base.z), z: base.z }, Math.PI / 2, ground);
    run(subject, environment(ground, { nearSolids: world }), 4, { moveX: 1 });
    const position = subject.state.position;
    expect(position.x).toBeLessThan(base.x);
    expect(segmentDistance({ x: position.x, y: position.y + 1, z: position.z }, trunk.a, trunk.b)).toBeGreaterThan(trunk.radius + 0.25);
  });
});
