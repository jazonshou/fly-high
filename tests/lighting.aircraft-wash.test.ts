import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import {
  AIRCRAFT_CAST_POOLS,
  aircraftWashLights,
} from "../src/render/webgpu/lighting/AircraftLighting";
import type { AircraftKind } from "@/src/sim";

/**
 * `7-15`: the wash lights must sit ON their lamps, on BOTH airframes.
 *
 * **Why this is a test and not a comment.** `aircraftWashLights` transcribes
 * coordinates out of `createAircraft` — the beacon at `(-0.75, 1.02, 0)` on the
 * trainer and `(-1.6, 0.92, 0)` on the jet. **Transcribed constants drift**, and
 * a wash half a metre off its lamp is a glow with no visible source, which is
 * exactly the kind of wrongness nobody notices in a still frame. This reads the
 * built meshes rather than a second copy of the numbers.
 *
 * **Both airframes are asserted because both ship** — `settings/index.ts`
 * accepts `["trainer", "jet"]`, and their lamps are at different coordinates.
 * A trainer-only table would be silently wrong for every jet pilot, and a
 * trainer-only test would not say so.
 */

function scene(): { engine: NullEngine; scene: Scene } {
  const engine = new NullEngine({
    renderWidth: 64, renderHeight: 64, textureSize: 64,
    deterministicLockstep: false, lockstepMaxSteps: 4,
  });
  const s = new Scene(engine);
  s.useRightHandedSystem = true;
  return { engine, scene: s };
}

/** Which lamp mesh each wash light claims to be the spill of. */
const WASH_TO_LAMP: Readonly<Record<string, string>> = Object.freeze({
  "aircraft-beacon-wash": "anticollision-beacon",
  "aircraft-nav-wash-port": "port-navigation-light",
  "aircraft-nav-wash-starboard": "starboard-navigation-light",
  "aircraft-strobe-wash-port": "port-strobe-light",
  "aircraft-strobe-wash-starboard": "starboard-strobe-light",
});

describe("7-15: every wash light sits on the lamp it is the spill of", () => {
  for (const kind of ["trainer", "jet"] as const satisfies readonly AircraftKind[]) {
    it(`${kind}: each wash offset equals its lamp's own position`, () => {
      const fixture = scene();
      try {
        createWebGpuAircraft(fixture.scene, kind);
        const washes = aircraftWashLights(kind);

        // NON-VACUITY, twice. An empty wash list, or a lamp lookup that finds
        // nothing, would make every assertion below pass by having nothing to
        // check — the failure mode this project has hit repeatedly.
        expect(washes.length, `${kind} has no wash lights to check`).toBe(5);

        for (const wash of washes) {
          const lampName = WASH_TO_LAMP[wash.name];
          expect(lampName, `no lamp mapped for wash "${wash.name}"`).toBeDefined();
          const lamp = fixture.scene.meshes.find((m) => m.name === lampName);
          expect(lamp, `${kind}: lamp mesh "${lampName}" not found — the wash `
            + "would be sited on a lamp that does not exist").toBeDefined();
          const p = lamp!.position;
          expect([p.x, p.y, p.z], `${kind}: wash "${wash.name}" is not on "${lampName}"`)
            .toEqual([wash.offset[0], wash.offset[1], wash.offset[2]]);
        }
      } finally {
        fixture.scene.dispose();
        fixture.engine.dispose();
      }
    });

    it(`${kind}: the wash cannot reach the ground the night shots fly over`, () => {
      // The night shots fly at 152 m AGL and the visible ground is further
      // still down the view ray. A wash whose range approached that would be
      // able to light the scene, which is the failure Jason has twice rejected.
      // The protection is geometric, not a tuning: assert it in the source.
      const NIGHT_SHOT_AGL_METERS = 152;
      for (const wash of aircraftWashLights(kind)) {
        expect(
          wash.rangeMeters,
          `${wash.name} reaches ${wash.rangeMeters} m against ${NIGHT_SHOT_AGL_METERS} m `
          + "of air beneath the aircraft — it could spill onto the scene",
        ).toBeLessThan(NIGHT_SHOT_AGL_METERS / 4);
      }
    });
  }

  it("wash names never collide with the cast pools, which are a separate claim", () => {
    const poolNames = new Set(AIRCRAFT_CAST_POOLS.map((p) => p.name));
    expect(poolNames.size, "no cast pools to compare against").toBeGreaterThan(0);
    for (const kind of ["trainer", "jet"] as const) {
      for (const wash of aircraftWashLights(kind)) {
        expect(poolNames.has(wash.name), `"${wash.name}" collides with a cast pool name; `
          + "the container addresses lights by name and one would overwrite the other").toBe(false);
      }
    }
  });
});
