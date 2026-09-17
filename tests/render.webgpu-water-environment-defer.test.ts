/**
 * `W-8` — the environment field's first bake is DEFERRED past the first frame,
 * and it must not become "never baked".
 *
 * Cold start's time-to-ready waits for the first GPU-complete frame, so the
 * field's ~9k terrain-climate samples were landing on the one path this repo
 * gates in milliseconds. Deferring costs a single frame rendered against the
 * neutral mid-province fallback — the province where the contrast curve is the
 * identity, i.e. nothing a frame can show — but a deferral is exactly the kind
 * of optimisation that silently becomes a disablement, so it is pinned here:
 * frame one binds the fallback, frame two binds the baked field.
 *
 * The renderer's node is three lines and needs a WebGPU device to exercise
 * directly, so this test pins the two halves that can be checked without one:
 * the field's own contract (a bake happens when asked, and only when the
 * window has moved) and the renderer's source shape (the deferral flag is
 * consumed once and the update is still called on every later frame).
 */

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { readSource } from "./support/sourceText";
import { WaterEnvironmentField } from "../src/render/webgpu/water/WaterEnvironmentField";
import { createWorld } from "../src/world";

describe("W-8 deferred first bake", () => {
  it("bakes on demand and only when the window has moved", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const field = new WaterEnvironmentField(scene, createWorld("phase1-perf-baseline"));
    // Nothing is baked by construction: the constructor allocates, and the
    // texture it binds until the first bake is the neutral fallback's twin.
    expect(field.bakes).toBe(0);
    expect(field.placement.inverseSpan).toBe(0);
    // The first call bakes, and the placement becomes real.
    expect(field.update(0, 0)).toBe(true);
    expect(field.bakes).toBe(1);
    expect(field.placement.inverseSpan).toBeGreaterThan(0);
    // ...and it does not bake again until the camera leaves the window.
    expect(field.update(1_000, 1_000)).toBe(false);
    expect(field.bakes).toBe(1);
    field.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("consumes the deferral flag exactly once and updates every frame after", () => {
    const source = readSource("src/render/FlightRenderer.ts");
    // Declared true, so the FIRST frame takes the deferral branch.
    expect(source).toContain("private waterEnvironmentBakeDeferred = true;");
    // Consumed in the water node, exactly once, and the else-branch is the
    // real update — not a return, which would make the deferral permanent.
    expect(source.split("waterEnvironmentBakeDeferred").length - 1).toBe(3);
    expect(source).toContain(
      "if (this.waterEnvironmentBakeDeferred) {\n"
      + "          this.waterEnvironmentBakeDeferred = false;\n"
      + "        } else if (this.waterEnvironment.update(this.cameraWorld.x, this.cameraWorld.z)) {\n"
      + "          this.ocean.setWaterEnvironmentField(this.waterEnvironment);\n"
      + "        }",
    );
    // The flag is never reset anywhere else: one flip, forever after a normal
    // per-frame update.
    expect(source.split("waterEnvironmentBakeDeferred = ").length - 1).toBe(2);
  });
});
