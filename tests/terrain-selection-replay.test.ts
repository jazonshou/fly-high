import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  createTerrainNodeBuffers,
  resolveTerrainResidentCornerMorphs,
  selectTerrainNodes,
  writeTerrainNodeBuffers,
  type TerrainNode,
} from "../src/render/webgpu/terrain/TerrainQuadtree";
import type { WorldPageAddress } from "../src/render/webgpu/world/pageKey";

/**
 * CDLOD selection, replayed frame by frame and digested: a refactor of the
 * per-frame selector must reproduce these digests EXACTLY.
 *
 * P5-C (docs/plans/CDLOD_SELECTION_DESIGN_NOTE.md) makes the selector and
 * the corner-morph pass cheaper without changing a single output: same nodes,
 * same addresses, same morph and corner values, same packed instance buffers.
 * Pixels cannot prove that (the rig's frames are noisy at this scale and it
 * shoots tier 1 only), so this pins the arithmetic instead. The digests below
 * were recorded on the PRE-refactor code (Fix-Cockpits 6426cd2).
 *
 * Inputs are deterministic functions of a seed: a per-page measured deviation
 * (some pages unmeasured, which must never split), a measured height range,
 * and slot residency with some parent pages missing (the fix-pack T8 corner
 * path). Two camera paths: a 3,000 ft cruise, and a take-off run from the
 * ground into a climbing turn (the near-ground case where selection is
 * finest). Tiers 0 and 1, whose budgets, thresholds and finest levels differ.
 */

/**
 * 1,080 px over a 60 degree vertical field: 1080 / (2 tan 30). Written as the
 * number, not computed: see `takeoff` for why this file calls no transcendental
 * function to build its inputs.
 */
const PIXELS_PER_METER = 935.3074360871938;
const COARSEST_LEVEL = 9;
const FRAMES = 360;
const FRAME_SECONDS = 1 / 50;

function hash01(seed: number, level: number, x: number, z: number, salt: number): number {
  let h = (seed ^ Math.imul(level + 1, 0x9e3779b1) ^ Math.imul(x, 0x85ebca77)
    ^ Math.imul(z, 0xc2b2ae3d) ^ Math.imul(salt, 0x27d4eb2f)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4_294_967_296;
}

function world(seed: number) {
  return {
    deviationFor: (a: WorldPageAddress): number | null =>
      hash01(seed, a.level, a.x, a.z, 1) < 0.06
        ? null
        : 2.2 * 2 ** a.level * (0.4 + hash01(seed, a.level, a.x, a.z, 2)),
    heightRangeFor: (a: WorldPageAddress): readonly [number, number] | null => {
      if (hash01(seed, a.level, a.x, a.z, 3) < 0.1) return null;
      const low = 40 + 300 * hash01(seed, a.level, a.x, a.z, 4);
      return [low, low + 20 + 2 ** a.level * 6 * hash01(seed, a.level, a.x, a.z, 5)];
    },
    slotFor: (a: WorldPageAddress): number =>
      hash01(seed, a.level, a.x, a.z, 6) < 0.08 ? -1 : (a.level * 97 + a.x * 13 + a.z * 7) & 1023,
  };
}

type Pose = readonly [number, number, number];

/** 3,000 ft (914 m) cruise at 60 m/s with a gentle drift. */
function cruise(frame: number): Pose {
  const t = frame * FRAME_SECONDS;
  return [1_234 + t * 60, 914, -777 + t * 12];
}

/**
 * Ground roll from rest, lift-off at 30 m/s, then a climbing right turn.
 *
 * EXACT ARITHMETIC ONLY (+, -, *, /): the turn's sine and versine are Taylor
 * polynomials, not `Math.sin` and `Math.cos`, and the roll is a product, not
 * `**`. ECMAScript does not require the transcendental functions to round the
 * same way on every machine, and they do not: the first take-off pins, recorded
 * on an arm64 Mac, failed on the x64 Linux CI runner in all four take-off cases
 * and no cruise case, with every node count equal. The path is this test's
 * INPUT, so it has to be the same numbers everywhere; the selector itself uses
 * nothing but exact operations. The heading stays under 0.44 rad over the
 * replay, where these polynomials are within 2e-8 of the functions, which is
 * neither here nor there: any climbing turn would do.
 */
function takeoff(frame: number): Pose {
  const t = frame * FRAME_SECONDS * 4;
  const roll = Math.min(t, 20);
  const rollX = 0.75 * roll * roll;
  if (t <= 20) return [3_000 + rollX, 2, 500];
  const air = t - 20;
  const heading = 0.05 * air;
  const h2 = heading * heading;
  const sine = heading * (1 - (h2 / 6) * (1 - h2 / 20));
  const versine = (h2 / 2) * (1 - (h2 / 12) * (1 - h2 / 30));
  return [3_000 + rollX + 600 * sine, 2 + 5 * air, 500 + 600 * versine];
}

function replayDigest(seed: number, path: (frame: number) => Pose, tier: 0 | 1): { digest: string; nodes: number } {
  const [quality, mode] = tier === 0 ? ["low", "performance"] as const : ["medium", "balanced"] as const;
  const profile = resolveWebGpuQualityProfile(quality, mode);
  const inputs = world(seed);
  const hash = createHash("sha256");
  const buffers = createTerrainNodeBuffers(profile.cdlodNodeBudget);
  let nodeTotal = 0;
  for (let frame = 0; frame < FRAMES; frame += 1) {
    const [x, y, z] = path(frame);
    const nodes: TerrainNode[] = selectTerrainNodes({
      cameraX: x,
      cameraY: y,
      cameraZ: z,
      pixelsPerMeterAtUnitDistance: PIXELS_PER_METER,
      pixelThreshold: profile.cdlodPixelThreshold,
      nodeBudget: profile.cdlodNodeBudget,
      finestResidentLevel: profile.finestResidentLevel,
      coarsestLevel: COARSEST_LEVEL,
      farPlaneMeters: 45_000,
      deviationFor: inputs.deviationFor,
      heightRangeFor: inputs.heightRangeFor,
    });
    nodeTotal += nodes.length;
    hash.update(JSON.stringify(nodes));
    const corners = resolveTerrainResidentCornerMorphs(nodes, inputs.slotFor);
    hash.update(JSON.stringify(corners));
    writeTerrainNodeBuffers({
      nodes,
      originX: Math.floor(x / 2_048) * 2_048,
      originZ: Math.floor(z / 2_048) * 2_048,
      slotFor: inputs.slotFor,
      channelSlotFor: (a) => (inputs.slotFor(a) >= 0 ? (a.x * 3 + a.z) & 127 : -1),
      provisionalAxisFor: (node) => node.level & 3,
    }, buffers);
    hash.update(new Uint8Array(buffers.matrices.buffer, 0, buffers.count * 16 * 4));
    hash.update(new Uint8Array(buffers.laneA.buffer, 0, buffers.count * 4 * 4));
    hash.update(new Uint8Array(buffers.laneB.buffer, 0, buffers.count * 4 * 4));
  }
  return { digest: hash.digest("hex").slice(0, 24), nodes: nodeTotal };
}

/**
 * Recorded on the pre-refactor selector. A change here is a change to what
 * the terrain draws: it must be a decision, re-measured on the rig, never a
 * digest update to make this pass.
 *
 * The four take-off digests were re-recorded on 2026-09-30 when the take-off
 * PATH lost its `Math.sin` and `Math.cos` (see `takeoff`): on the same
 * pre-refactor selector (this file run in a worktree at 7a6e75a, where the
 * four cruise digests still reproduced as the control), not on the code under
 * test. The node counts did not move.
 */
const PINNED: Record<string, { digest: string; nodes: number }> = {
  "seed 7 cruise tier 0": { digest: "6f15dcd9034222911ffea8fd", nodes: 80326 },
  "seed 7 takeoff tier 0": { digest: "b13384e956224c8bce9310b2", nodes: 79920 },
  "seed 7 cruise tier 1": { digest: "bb7ed0aa960ad2fd93ab86bb", nodes: 114964 },
  "seed 7 takeoff tier 1": { digest: "51cef809c6bd5b845247204b", nodes: 114691 },
  "seed 1234567 cruise tier 0": { digest: "f89bda051310d459ded7f258", nodes: 63394 },
  "seed 1234567 takeoff tier 0": { digest: "bea0c83f8db965f7ad0455e1", nodes: 57208 },
  "seed 1234567 cruise tier 1": { digest: "565d78d9408d8eafb59d5997", nodes: 85801 },
  "seed 1234567 takeoff tier 1": { digest: "ecd4420129be884963d59c59", nodes: 75649 },
};

describe("CDLOD selection replay (bit-identity pin for the per-frame selector)", () => {
  for (const seed of [7, 1_234_567]) {
    for (const [pathName, path] of [["cruise", cruise], ["takeoff", takeoff]] as const) {
      for (const tier of [0, 1] as const) {
        const name = `seed ${seed} ${pathName} tier ${tier}`;
        it(`reproduces ${name}`, () => {
          const result = replayDigest(seed, path, tier);
          // Non-vacuity: the budget binds, as it does in flight.
          expect(result.nodes / FRAMES).toBeGreaterThan(tier === 0 ? 150 : 200);
          expect(result).toEqual(PINNED[name]);
        }, 60_000);
      }
    }
  }
});
