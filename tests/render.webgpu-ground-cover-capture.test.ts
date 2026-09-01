import { readFileSync } from "node:fs";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { GroundCoverSystem } from "../src/render/webgpu/detail/GroundCoverSystem";
import type { TerrainSample } from "../src/world/types";

/**
 * `VITE_PERF_HIDE_VEGETATION` must actually hide the compute ground cover.
 *
 * **The defect this replaces.** `FlightRenderer.setVegetationVisibleForCapture`
 * hid vegetation by walking `scene.meshes`, matching the `detail-` prefix and
 * setting `isVisible`. Ground-cover rings are named `ground-cover-ring-N`, so
 * the prefix missed them — and fixing only the prefix was NOT enough, which is
 * the part worth keeping: `GroundCoverSystem` re-asserts `setEnabled()` on
 * every ring every update, so an `isVisible` written from outside is
 * overwritten on the next frame. **Measured: with the prefix corrected, the
 * mask moved 5 pixels and the blade-only effect still landed ~100% in the
 * terrain control.**
 *
 * So the flag must live with the owner, and these are the properties that make
 * it work rather than merely exist.
 *
 * The real behavioural proof needs rings, and rings need compute support that
 * `NullEngine` does not have — so the behavioural legs live in
 * `tests/gpu/ground-cover-capture-suppression.test.ts`. What is checkable here
 * is the STRUCTURE, and the structural failure is the likely one: a sixth
 * enable site added later that bypasses the gate.
 */

function flatSample(): TerrainSample {
  return {
    height: 0, slope: 0, moisture: 0.5, temperature: 0.5,
    normal: { x: 0, y: 1, z: 0 },
  } as unknown as TerrainSample;
}

const SOURCE = readFileSync(
  "src/render/webgpu/detail/GroundCoverSystem.ts", "utf8");

describe("ground-cover capture suppression", () => {
  it("routes EVERY ring enable through the one gate", () => {
    // The gate can only be forgotten at a call site that bypasses it, so this
    // asserts there are none. `setRingEnabled` is the single writer; the two
    // lines inside it and inside `setVisibleForCapture` are the exceptions.
    const direct = SOURCE.split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => line.includes("ring.mesh.setEnabled("))
      .filter(({ line }) => !line.startsWith("*") && !line.startsWith("//"));
    // Two legitimate writers: the gate itself, and the immediate application
    // inside the setter. Anything else is a bypass.
    expect(
      direct.length,
      `expected exactly 2 direct \`ring.mesh.setEnabled(\` writers (the gate and `
      + `the setter); found ${direct.length} at lines ${direct.map((d) => d.n).join(", ")}. `
      + "A new enable site that bypasses `setRingEnabled` will ignore the capture "
      + "flag, and the blades will silently survive into the vegetation-hidden frame "
      + "exactly as they did before.",
    ).toBe(2);
  });

  it("consults the flag in the gate rather than at the call sites", () => {
    expect(SOURCE).toContain("this.hiddenForCapture ? false : enabled");
  });

  it("reports how many meshes it suppressed, so a caller can see a no-op", () => {
    // The non-vacuity signal, copied from `setVegetationVisibleForCapture`'s
    // own return: a harness that gets 0 back knows nothing was hidden. Four
    // instruments this phase passed by examining nothing.
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const system = new GroundCoverSystem(scene, { terrainSample: () => flatSample() });
      // NullEngine has no compute support, so there are no rings to suppress
      // and the honest answer is 0 — the count reports reality rather than
      // claiming success.
      expect(system.setVisibleForCapture(false)).toBe(0);
      expect(system.setVisibleForCapture(true)).toBe(0);
      system.dispose();
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });

  it("is reached from the renderer's single capture entry point", () => {
    // The harness calls `setVegetationVisibleForCapture` and nothing else, so
    // the system's flag has to be reachable from there or it is dead code.
    const renderer = readFileSync("src/render/FlightRenderer.ts", "utf8");
    const body = renderer.slice(
      renderer.indexOf("setVegetationVisibleForCapture(visible: boolean): number"),
    ).slice(0, 1400);
    expect(body).toContain("this.groundCover.setVisibleForCapture(visible)");
    // And its count must be ADDED, not discarded: the harness asserts the
    // total is non-zero, which is only meaningful if the blades contribute.
    expect(body).toContain("toggled += this.groundCover.setVisibleForCapture(visible)");
  });
});
