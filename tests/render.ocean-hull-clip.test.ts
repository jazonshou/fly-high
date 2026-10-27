import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { describe, expect, it } from "vitest";
import { drawnHalfSection, hullHalfBreadthAt } from "../src/render/webgpu/boat/boatHull";
import {
  OCEAN_HULL_CLIP_DEFINE,
  OCEAN_HULL_CLIP_FLOATS_PER_STATION,
  OCEAN_HULL_CLIP_MARGIN_METERS,
  OCEAN_HULL_CLIP_STATIONS,
  OCEAN_HULL_CLIP_WGSL,
  OceanHullClip,
  oceanHullClippedAt,
} from "../src/render/webgpu/boat/oceanHullClip";
import { WATER_FRAGMENT_WGSL } from "../src/render/webgpu/water/SpectralOceanSystem";
import { HULL_LENGTH, RUNABOUT_21_CG, transomX } from "../src/vehicles/boat/hullLines";

/**
 * The sea kept out of the hull (src/render/webgpu/boat/oceanHullClip.ts): the
 * clip never reaches outside the drawn skin, it does reach the water a crest
 * lifts into the cockpit, and it follows the boat.
 */

const SHEER = 12;

/** A deterministic scatter, so a failure names the same point every run. */
function* scatter(count: number): Generator<[number, number, number]> {
  let seed = 0x5eed;
  const next = (): number => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let index = 0; index < count; index += 1) {
    yield [-0.3 + next() * (HULL_LENGTH + 0.6), -0.2 + next() * 1.7, -1.5 + next() * 3];
  }
}

function sheerAt(x: number): number {
  return drawnHalfSection(Math.min(HULL_LENGTH, Math.max(0, x)), [])[SHEER]![1];
}

describe("the hull clip's volume", () => {
  it("stays inside the drawn skin everywhere it clips", () => {
    let worst = Number.NEGATIVE_INFINITY;
    let worstAt = "";
    for (const [x, y, z] of scatter(40_000)) {
      if (!oceanHullClippedAt(x, y, z)) continue;
      expect(x, `clipped aft of the transom at ${x}, ${y}`).toBeGreaterThanOrEqual(transomX(y));
      expect(x).toBeLessThanOrEqual(HULL_LENGTH);
      expect(y, `clipped above the sheer at ${x}`).toBeLessThanOrEqual(sheerAt(x) + 0.01);
      const over = Math.abs(z) - hullHalfBreadthAt(x, y);
      if (over > worst) {
        worst = over;
        worstAt = `${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)}`;
      }
    }
    // Strictly inside, by at least half the margin: the reduced sections and
    // their interpolation between stations never eat the rest of it.
    expect(worst, `the clip reaches past the skin at ${worstAt}`).toBeLessThan(-OCEAN_HULL_CLIP_MARGIN_METERS / 2);
  });

  it("clears the water a crest lifts into the cockpit, up to the sheer", () => {
    let missed = 0;
    let inside = 0;
    for (const [x, y, z] of scatter(40_000)) {
      // Comfortably inside: away from the skin, the transom, the stem and the sheer.
      if (x < transomX(y) + 0.08 || x > HULL_LENGTH - 0.6) continue;
      if (y > sheerAt(x) - 0.04 || Math.abs(z) > hullHalfBreadthAt(x, y) - 0.08) continue;
      inside += 1;
      if (!oceanHullClippedAt(x, y, z)) missed += 1;
    }
    expect(inside).toBeGreaterThan(2_000);
    expect(missed).toBe(0);
  });

  it("leaves a swamped boat full: nothing above the sheer is clipped", () => {
    for (const x of [0.5, 2, 4, 5.5]) {
      expect(oceanHullClippedAt(x, sheerAt(x) + 0.02, 0)).toBe(false);
      expect(oceanHullClippedAt(x, sheerAt(x) - 0.05, 0)).toBe(true);
    }
  });
});

describe("the hull clip's pose", () => {
  it("maps render space to the hull frame the boat is drawn in", () => {
    const clip = new OceanHullClip();
    const rotation = Quaternion.RotationYawPitchRoll(0.7, -0.08, 0.21);
    const position = new Vector3(123.4, 0.31, -987.6);
    clip.setPose(position, rotation);
    const rows = clip.poseRows;
    for (const body of [new Vector3(0, 0, 0), new Vector3(2.5, -0.3, 0.8), new Vector3(-1.9, 0.4, -1.1)]) {
      // Body to render space as the boat's root places it: p = R b + t.
      const world = body.applyRotationQuaternion(rotation).add(position);
      const hull = rows.map((row) => row.x * world.x + row.y * world.y + row.z * world.z + row.w);
      expect(hull[0]).toBeCloseTo(body.x + RUNABOUT_21_CG.x, 9);
      expect(hull[1]).toBeCloseTo(body.y + RUNABOUT_21_CG.y, 9);
      expect(hull[2]).toBeCloseTo(body.z + RUNABOUT_21_CG.z, 9);
    }
  });

  it("puts every pixel off the hull while the boat is away", () => {
    const clip = new OceanHullClip();
    clip.setPose(new Vector3(0, 0, 0), Quaternion.Identity());
    clip.clearPose();
    const [row0] = clip.poseRows;
    expect(row0!.w).toBeGreaterThan(HULL_LENGTH * 1_000);
  });
});

describe("the hull clip's shader", () => {
  it("bakes the table it was tested against", () => {
    const table = /const OCEAN_HULL_SECTIONS = array<f32, (\d+)>/u.exec(OCEAN_HULL_CLIP_WGSL);
    expect(Number(table?.[1])).toBe(OCEAN_HULL_CLIP_STATIONS * OCEAN_HULL_CLIP_FLOATS_PER_STATION);
  });

  it("sits in the ocean's fragment behind its define, right after the dry-bed discard", () => {
    const declarations = WATER_FRAGMENT_WGSL.indexOf(`#ifdef ${OCEAN_HULL_CLIP_DEFINE}\n${OCEAN_HULL_CLIP_WGSL}\n#endif`);
    expect(declarations).toBeGreaterThan(0);
    expect(declarations).toBeLessThan(WATER_FRAGMENT_WGSL.indexOf("@fragment"));
    expect(WATER_FRAGMENT_WGSL).toContain(
      "  if (depth <= 0.0) { discard; }\n"
      + `#ifdef ${OCEAN_HULL_CLIP_DEFINE}\n`
      + "  // A boat session: no sea inside the hull (boat/oceanHullClip.ts).\n"
      + "  if (oceanHullClipped(input.worldPosition)) { discard; }\n"
      + "#endif\n",
    );
  });
});
