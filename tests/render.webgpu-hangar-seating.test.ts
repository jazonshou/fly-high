import { describe, expect, it } from "vitest";

import { createWorld } from "../src/world/world";
import { runwayToWorld } from "../src/world/airport";
import { sampleTerrainHeight } from "../src/world/terrain";
import {
  HANGAR_PLAN_LIMITS,
  HANGAR_SITING,
  MINIMUM_SKIRT_METERS,
  hangarAttachments,
  hangarFootprint,
  hangarFootprintSamples,
  hangarPlanFrom,
  hangarSeatingFrom,
  hangarShellGeometry,
} from "../src/render/webgpu/airfield/AirfieldStructures";

/**
 * `7-10`: a hangar is seated on the ground under it, not on one sample.
 *
 * **These are pins on the RULE, across seeds — not on this airport's heights.**
 * A hangar stands 81 m beyond the graded platform on natural terrain, so its
 * ground is seed-dependent and no committed height would survive a seed change.
 * What survives is the property: **nothing is buried and nothing floats.**
 *
 * **What these do NOT cover.** No mesh is built and nothing is drawn — there is
 * no skirt geometry here, only the height it must reach. The rule is asserted
 * against `sampleTerrainHeight`, which is what the renderer's `groundHeight`
 * resolves to, but the renderer is not exercised: a wiring mistake that never
 * calls this would leave every assertion below green. And the visual claim in
 * the module docblock — that a 2.85 m float is unmissable — is geometric, not
 * observed; no frame has been captured of it.
 */

// Enough seeds to distinguish a rule from one world's terrain. Each must
// produce a DIFFERENT world, which is asserted rather than assumed: `createWorld`
// takes its seed positionally, and passing an options object instead silently
// yields the same default world for every entry — a sweep that sweeps nothing
// agrees with itself perfectly.
const SEEDS = ["1s9phln", "phase1-perf-baseline", "clustered-spike", "hangar-a", "hangar-b"];
const SAMPLE_STEP_METERS = 2;

const worlds = SEEDS.map((seed) => ({ seed, world: createWorld(seed) }));

function groundUnder(world: ReturnType<typeof createWorld>, index: number): number[] {
  const airport = world.airport;
  if (!airport) throw new Error("world has no airport");
  const footprint = hangarFootprint(airport, index);
  return hangarFootprintSamples(footprint, SAMPLE_STEP_METERS).map((local) => {
    const point = runwayToWorld(airport, local.along, local.across);
    return sampleTerrainHeight(world, point.x, point.z);
  });
}

describe("the seed sweep is actually sweeping", () => {
  it("gives every seed a distinct world", () => {
    const hashes = new Set(worlds.map(({ world }) => world.sourceSeedHash));
    expect(hashes.size, "two seeds produced the same world — the sweep is vacuous").toBe(
      SEEDS.length,
    );
  });

  it("exercises the two-seed collision rather than avoiding it", () => {
    // A guaranteed-airport world replaces `seedHash` during the airport search,
    // so terrain reads a different hash from the one the seed string produced.
    // If these were ever equal the sweep would be testing the easy case.
    for (const { seed, world } of worlds) {
      expect(world.seedHash, `${seed}: seedHash equals sourceSeedHash`).not.toBe(
        world.sourceSeedHash,
      );
    }
  });
});

describe("hangar seating", () => {
  it("covers the footprint's corners whatever the step divides", () => {
    // The corners are exactly where centre-seating fails, so a sampler that
    // misses them reports a smaller relief than the building sees.
    const { world } = worlds[0]!;
    const footprint = hangarFootprint(world.airport!, 0);
    for (const step of [2, 3, 7, 46]) {
      const samples = hangarFootprintSamples(footprint, step);
      const halfW = footprint.widthMeters / 2;
      const halfD = footprint.depthMeters / 2;
      for (const cornerAlong of [-halfD, halfD]) {
        for (const cornerAcross of [-halfW, halfW]) {
          expect(
            samples.some(
              (s) =>
                Math.abs(s.along - (footprint.along + cornerAlong)) < 1e-9
                && Math.abs(s.across - (footprint.across + cornerAcross)) < 1e-9,
            ),
            `step ${step} missed a footprint corner`,
          ).toBe(true);
        }
      }
    }
  });

  it.each(SEEDS.map((seed) => [seed] as const))(
    "%s: no corner is buried and none floats, on any hangar",
    (seed) => {
      const { world } = worlds.find((entry) => entry.seed === seed)!;
      for (let index = 0; index < HANGAR_SITING.count; index += 1) {
        const ground = groundUnder(world, index);
        const seating = hangarSeatingFrom(ground);
        const highest = Math.max(...ground);
        const lowest = Math.min(...ground);
        // BURIED: any ground above the slab would push through the floor.
        expect(
          seating.baseAltitudeMeters,
          `${seed} hangar ${index}: ground reaches above the slab`,
        ).toBeGreaterThanOrEqual(highest);
        // FLOATING: the skirt must reach the lowest ground under the footprint.
        expect(
          seating.baseAltitudeMeters - seating.skirtHeightMeters,
          `${seed} hangar ${index}: the skirt stops ${(
            lowest - (seating.baseAltitudeMeters - seating.skirtHeightMeters)
          ).toFixed(2)} m above the lowest ground`,
        ).toBeLessThanOrEqual(lowest + 1e-9);
      }
    },
  );

  it("is load-bearing: centre-point seating would fail this on real terrain", () => {
    // NON-VACUITY, and the reason the rule exists. If seating on the centre
    // sample also satisfied "nothing buried, nothing floats", the footprint
    // query would be ceremony. Measured across every seed and hangar.
    const failures: string[] = [];
    for (const { seed, world } of worlds) {
      for (let index = 0; index < HANGAR_SITING.count; index += 1) {
        const airport = world.airport!;
        const footprint = hangarFootprint(airport, index);
        const centre = runwayToWorld(airport, footprint.along, footprint.across);
        const centreHeight = sampleTerrainHeight(world, centre.x, centre.z);
        const ground = groundUnder(world, index);
        if (Math.max(...ground) > centreHeight + 0.05) {
          failures.push(
            `${seed}/${index} buries ${(Math.max(...ground) - centreHeight).toFixed(2)} m`,
          );
        }
      }
    }
    expect(
      failures.length,
      "centre-point seating buried nothing anywhere — the footprint query is unnecessary",
    ).toBeGreaterThan(0);
  });

  it("keeps a minimum skirt on ground with no relief", () => {
    const flat = hangarSeatingFrom([20, 20, 20, 20]);
    expect(flat.reliefMeters).toBe(0);
    expect(flat.skirtHeightMeters).toBe(MINIMUM_SKIRT_METERS);
    // And the minimum never SHRINKS a skirt that relief already justifies.
    const steep = hangarSeatingFrom([20, 23]);
    expect(steep.skirtHeightMeters).toBe(3);
  });

  it("makes three hangars on ONE field visually distinct", () => {
    // 7-10's exit criterion, and the one a `{ seed }` test cannot check: with
    // the object form every world is bit-identical, so "distinct under the same
    // seed" would compare one world against itself.
    for (const { seed, world } of worlds) {
      const plans = [0, 1, 2].map((index) => hangarPlanFrom(world.seedHash, index, 1));
      const shapes = new Set(plans.map((p) => `${p.bays}/${p.roof}`));
      expect(
        shapes.size,
        `${seed}: all three hangars are ${[...shapes][0]} — they read as one building repeated`,
      ).toBeGreaterThan(1);
    }
  });

  it("draws bay count and roof profile independently", () => {
    // Two channels, not one value varied by index. If they shared a draw the
    // roof profile would be a function of the bay count, and a five-bay hangar
    // would always be arched — a correlation nobody chose.
    const byBays = new Map<number, Set<string>>();
    for (const { world } of worlds) {
      for (let index = 0; index < 6; index += 1) {
        const plan = hangarPlanFrom(world.seedHash, index, 1);
        byBays.set(plan.bays, (byBays.get(plan.bays) ?? new Set()).add(plan.roof));
      }
    }
    const correlated = [...byBays.entries()].filter(([, roofs]) => roofs.size === 1);
    expect(
      correlated.length,
      `bay counts ${correlated.map(([b]) => b).join(",")} only ever appear with one roof profile`,
    ).toBe(0);
  });

  it("emits both roof profiles across seeds", () => {
    // Non-vacuity for the arched path: if the hash never chose it, half the
    // geometry would be dead code that no test and no frame ever exercises.
    const roofs = new Set(
      worlds.flatMap(({ world }) =>
        [0, 1, 2].map((index) => hangarPlanFrom(world.seedHash, index, 1).roof),
      ),
    );
    expect(roofs).toEqual(new Set(["gabled", "arched"]));
  });

  it("keeps bay count inside its stated limits and is deterministic", () => {
    for (const { world } of worlds) {
      for (let index = 0; index < 3; index += 1) {
        const a = hangarPlanFrom(world.seedHash, index, 1);
        const b = hangarPlanFrom(world.seedHash, index, 1);
        expect(a).toEqual(b);
        expect(a.bays).toBeGreaterThanOrEqual(HANGAR_PLAN_LIMITS.minBays);
        expect(a.bays).toBeLessThanOrEqual(HANGAR_PLAN_LIMITS.maxBays);
        expect(a.ridgeHeightMeters).toBeGreaterThan(a.eaveHeightMeters);
      }
    }
  });

  it("keys the plan on seedHash, not sourceSeedHash", () => {
    // The airfield is earthworks-coupled, so it must agree with the ground it
    // stands on. Using the source hash would build a hangar for a world the
    // terrain is not generating — the collision that caught two Phase 6 items.
    const differing = worlds.filter(
      ({ world }) =>
        JSON.stringify(hangarPlanFrom(world.seedHash, 0, 1))
        !== JSON.stringify(hangarPlanFrom(world.sourceSeedHash, 0, 1)),
    );
    expect(
      differing.length,
      "the two hashes produce identical plans on every seed, so this test cannot "
        + "tell which one the builder used",
    ).toBeGreaterThan(0);
  });

  it("builds a closed shell whose skirt reaches the base", () => {
    for (const roof of ["gabled", "arched"] as const) {
      const plan = { ...hangarPlanFrom(1, 0, 2.5), roof };
      const geometry = hangarShellGeometry(plan);
      expect(geometry.indices.length % 3).toBe(0);
      // The skirt's lowest point is the slab, at -skirtHeight.
      const ys: number[] = [];
      for (let i = 1; i < geometry.positions.length; i += 3) ys.push(geometry.positions[i]!);
      expect(Math.min(...ys)).toBeCloseTo(-plan.skirtHeightMeters, 9);
      expect(Math.max(...ys)).toBeCloseTo(plan.ridgeHeightMeters, 9);
    }
  });

  it("emits no degenerate triangles, which would eat the winding guard's margin", () => {
    // A zero-area triangle contributes 0 to the guard's agreement metric, so a
    // perfectly wound gabled shell read -0.818 instead of -1.000 until these
    // were dropped — making "some faces are degenerate" indistinguishable from
    // "some faces are inverted" in the single number the guard reports.
    for (const roof of ["gabled", "arched"] as const) {
      const plan = { ...hangarPlanFrom(1, 0, 1), roof };
      const { positions, indices } = hangarShellGeometry(plan);
      const at = (i: number) => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
      for (let t = 0; t < indices.length; t += 3) {
        const [a, b, c] = [at(indices[t]!), at(indices[t + 1]!), at(indices[t + 2]!)];
        const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
        const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
        const area = Math.hypot(
          u[1]! * v[2]! - u[2]! * v[1]!,
          u[2]! * v[0]! - u[0]! * v[2]!,
          u[0]! * v[1]! - u[1]! * v[0]!,
        );
        expect(area, `${roof}: triangle ${t / 3} has zero area`).toBeGreaterThan(1e-9);
      }
    }
  });

  it("publishes attachments with the placement already folded in", () => {
    // THE BUG THIS EXISTS TO PREVENT, from 7-14's tower half: a consumer
    // applied the placement a second time and put fixtures ~190 m off across
    // the runway — finite, plausible, on the airfield, and invisible to any
    // test asserting that N fixtures exist at finite coordinates. So assert
    // WHERE they are, not that they exist.
    for (const { seed, world } of worlds) {
      const airport = world.airport!;
      for (let index = 0; index < HANGAR_SITING.count; index += 1) {
        const footprint = hangarFootprint(airport, index);
        const seating = hangarSeatingFrom(groundUnder(world, index));
        const plan = hangarPlanFrom(world.seedHash, index, seating.skirtHeightMeters);
        const mounts = hangarAttachments(airport, index, plan, seating.baseAltitudeMeters);
        for (const point of [...mounts.roofPerimeter, ...mounts.ridgeEnds]) {
          // Every mount sits within the footprint's own half-extents of its
          // centre. Double-applying the placement puts them a whole `across`
          // offset away, which this catches by more than 100 m.
          expect(
            Math.abs(point[0] - footprint.across),
            `${seed}/${index}: mount is ${Math.abs(point[0] - footprint.across).toFixed(1)} m `
              + "from the hangar centre across — placement looks double-applied",
          ).toBeLessThanOrEqual(footprint.widthMeters / 2 + 1e-9);
          expect(Math.abs(point[2] - footprint.along)).toBeLessThanOrEqual(
            footprint.depthMeters / 2 + 1e-9,
          );
        }
      }
    }
  });

  it("describes the roof honestly: four true corners, a ridge at the top", () => {
    for (const roof of ["gabled", "arched"] as const) {
      const airport = worlds[0]!.world.airport!;
      const plan = { ...hangarPlanFrom(1, 0, 1.5), roof };
      const mounts = hangarAttachments(airport, 0, plan, airport.elevation + 3);
      // TRUE CORNERS, not subdivided: the 45 m extent-light spacing cap is an
      // aviation rule and belongs with the regulation, not in a shell.
      expect(mounts.roofPerimeter.length).toBe(4);
      // The ridge is the HIGHEST thing, for both profiles. An arched roof is a
      // barrel with an apex line, not a dome — marking the eave corners as the
      // top would put the obstruction lights below the actual high point.
      const ridgeY = mounts.ridgeEnds[0]![1];
      for (const corner of mounts.roofPerimeter) {
        expect(ridgeY, `${roof}: a roof corner is at or above the ridge`).toBeGreaterThan(corner[1]);
      }
      expect(mounts.ridgeEnds.length).toBe(2);
      expect(mounts.heightMeters).toBeCloseTo(plan.ridgeHeightMeters + plan.skirtHeightMeters, 9);
    }
  });

  it("names its attachment fields stably, so a rename breaks a test", () => {
    const airport = worlds[0]!.world.airport!;
    const mounts = hangarAttachments(airport, 0, hangarPlanFrom(1, 0, 1), airport.elevation);
    expect(Object.keys(mounts).sort()).toEqual(["heightMeters", "ridgeEnds", "roofPerimeter"]);
  });

  it("refuses a failed ground query instead of seating on NaN", () => {
    // A NaN position makes Babylon silently not draw the mesh, which reads as
    // "the hangar is missing" rather than "the height query broke".
    expect(() => hangarSeatingFrom([20, Number.NaN])).toThrow(/not finite/u);
    expect(() => hangarSeatingFrom([])).toThrow(/no ground samples/u);
  });
});
