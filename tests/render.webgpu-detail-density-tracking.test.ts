import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  detailCellMinimumDistanceMeters,
  WorldDetailRuntime,
} from "../src/render/webgpu/detail";
import { renderedShareAtDistance } from "../src/render/webgpu/detail/renderedDensity";
import { TerrainBiome } from "../src/world";

/**
 * A resident cell's rendered tree share must track the observer's ACTUAL
 * distance, not the distance at the last cell-plan.
 *
 * **The defect, in Jason's words: "trees sometimes only pop into view when I'm
 * very close."** `presentationBuild` feeds `resident.distance` straight into
 * `renderedShareAtDistance` to size each cell's tree budget, and that field was
 * refreshed only when the cell PLAN was rebuilt — gated on a signature that
 * quantises the observer to `cellSizeMeters * 0.5`, **256 m of travel**.
 *
 * **The share curve is flat past `farFloorShare` and steep inside the near
 * radius, so a fixed 256 m error is nothing far out and enormous close in.**
 * Measured against the shipping law before the fix: a tier-1 cell 150 m away
 * rendered 13.6% of its trees and jumped to 100% at the next lattice crossing —
 * **7.33x in one frame, 11.07x at tier 0** — with a hard binary admission
 * (`treeCanopyRank[i] > treeShare`) and `fadeIncoming: false` everywhere, so
 * nothing softened it.
 *
 * **"Sometimes" was the lattice**: whether an approach showed it depended on
 * where the 256 m grid fell relative to the wood, not on the wood or the
 * heading. This test therefore steps the observer at a stride that is NOT a
 * divisor of that lattice, so it does not accidentally sample only the
 * favourable phase.
 *
 * **SCOPE — THIS GUARD IS BLIND TO ARRIVAL LATENCY.** It passes no
 * `workerWorldSeed`, so `WorldDetailRuntime` creates no generation client and
 * every cell is built inline and synchronously. **Streaming latency is zero by
 * construction here.** It asserts a property of the SHARE LAW; a cell that is
 * late because generation has not caught up is invisible to it, and an
 * in-motion foliage DEFICIT cannot be reproduced by this file at all.
 * Identified by `flight-simulator-66`, who found the same blindness in their
 * own probe and checked mine rather than assuming.
 *
 * **What is asserted is the invariant, not the fix's mechanism:** every
 * resident's stored distance must imply a share within tolerance of the share
 * its live distance implies. A future refactor that keeps the property passes;
 * one that reintroduces staleness fails wherever it is visible.
 */
describe("detail density tracks the observer (tree pop-in)", () => {
  it("keeps every resident's share within tolerance of its live distance", () => {
    const engine = new NullEngine({
      renderWidth: 64, renderHeight: 64, textureSize: 64,
      deterministicLockstep: false, lockstepMaxSteps: 4,
    });
    const scene = new Scene(engine);
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: "tree-pop-in",
      // Closed forest everywhere, so cells actually carry trees to withhold.
      terrainSample: () => ({ height: 40, slope: 0.03, moisture: 0.75, biome: TerrainBiome.FOREST }),
    });
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const law = profile.renderedDensityLaw;
    const origin = { x: 0, y: 0, z: 0 };
    const internals = runtime as unknown as {
      readonly cells: Map<string, {
        readonly cellX: number; readonly cellZ: number;
        readonly cellSizeMeters: number; readonly distance: number;
      }>;
    };

    try {
      // Settle at range first, so residents exist with a FAR distance recorded —
      // that stale value is exactly what the defect carried inward.
      let observer = { x: 0, y: 60, z: -900 };
      for (let pass = 0; pass < 96; pass += 1) runtime.update(observer, origin, profile);
      expect(internals.cells.size, "no resident cells were generated").toBeGreaterThan(0);

      // Approach. 37 m is deliberately not a divisor of the 256 m signature
      // lattice, so the walk lands on many phases rather than one.
      let worstDrift = 0;
      let worstAt = 0;
      for (let z = -900; z <= -140; z += 37) {
        observer = { x: 0, y: 60, z };
        runtime.update(observer, origin, profile);
        for (const resident of internals.cells.values()) {
          const live = detailCellMinimumDistanceMeters(
            observer.x, observer.z,
            resident.cellX, resident.cellZ, resident.cellSizeMeters,
          );
          const drift = Math.abs(
            renderedShareAtDistance(law, live) - renderedShareAtDistance(law, resident.distance),
          );
          if (drift > worstDrift) { worstDrift = drift; worstAt = live; }
        }
      }

      // The pre-fix build reached a share drift of ~0.86 (13.6% rendered where
      // the law said 100%). A tolerance well under that fails on it while
      // leaving room for the refresh's own epsilon.
      expect(
        worstDrift,
        `A resident's recorded distance implied a tree share ${worstDrift.toFixed(3)} away `
        + `from the share its live distance implies (worst at ${worstAt.toFixed(0)} m). `
        + "That gap is released as a single un-faded cohort the moment the distance "
        + "refreshes, which is the pop-in Jason reported.",
      ).toBeLessThan(0.10);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
    // **The timeout is generous on purpose, and wall clock is NOT the subject.**
    //
    // Structural publication is serialised at one chunk per update, so the 96
    // settle passes above are the instrument, not padding — shortening them
    // under-settles the runtime and the drift this measures becomes an artifact
    // of an unfinished build rather than of stale distance. The work is
    // therefore irreducible, ~11 s on an idle host.
    //
    // This runs on a shared machine alongside other sessions' builds and
    // captures. At load average ~16 the same test took 42 s and tripped the
    // 30 s default — a guard that goes red because a neighbour was compiling
    // gets relabelled flaky and then stops being read at all, which costs more
    // than the minutes saved. The bound is set well clear of host noise so that
    // a red here means the drift moved.
  }, 180_000);
});
