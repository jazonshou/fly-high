import { describe, expect, it } from "vitest";
import { createSurfaceSpawn } from "../src/game/surfaceSpawn";
import type { BoatControlState, FlightMode } from "../src/game/types";
import { BoatSimulator } from "../src/sim/boat";
import { MarinaHarbour } from "../src/sim/marina/harbour";
import { NEUTRAL_BOAT_CONTROLS, type SurfaceVehicleEnvironment } from "../src/sim/surface";
import { CalmWaterSurface } from "../src/sim/water";
import { createWorld, sampleTerrainHeight, type WorldDefinition } from "../src/world";
import { marinaStartPose } from "../src/world/marina";

/**
 * The dock start as the worker runs it: the real boat in the home marina's
 * start berth, held by the marina's lines, with the hull meeting the
 * marina's structures through the simulator's own contact. The call order
 * is the worker's (`stepSurface`).
 */

const STEP = 1 / 120;

function environment(world: WorldDefinition): SurfaceVehicleEnvironment {
  const bedHeight = (x: number, z: number) => sampleTerrainHeight(world, x, z);
  return {
    water: new CalmWaterSurface(world.seaLevel, bedHeight),
    wind: { x: 0, y: 0, z: 0 },
    bedHeight,
    gravity: 9.80665,
  };
}

function session(seed: number) {
  const world = createWorld(seed);
  const env = environment(world);
  const boat = new BoatSimulator(createSurfaceSpawn(world, "speedboat"));
  const harbour = new MarinaHarbour(world, boat);
  harbour.makeFastAtStart(world);
  let time = 0;
  const run = (seconds: number, boatControls: Partial<BoatControlState> = {}, assist: FlightMode = "pilot") => {
    const controls = { assist, boat: { ...NEUTRAL_BOAT_CONTROLS, ...boatControls } };
    for (let t = 0; t < seconds; t += STEP) {
      env.water.setTime(time);
      boat.setControls(controls);
      boat.setEnvironment(env);
      harbour.beforeStep(controls.boat, assist === "scenic", env);
      boat.step(STEP);
      harbour.afterStep();
      time += STEP;
    }
  };
  return { world, boat, harbour, run };
}

describe("dock start in the home marina", () => {
  for (const seed of [0x51a7e, 123, 9_001]) {
    it(`lies on its lines at the start berth, then casts off under power (seed ${seed})`, () => {
      const { world, boat, harbour, run } = session(seed);
      const pose = marinaStartPose(world);
      run(10);
      let snapshot = boat.snapshot();
      expect(snapshot.payload.moored).toBe(true);
      expect(harbour.mooring.state).toBe("moored");
      expect(Math.hypot(snapshot.position.x - pose.x, snapshot.position.z - pose.z)).toBeLessThan(0.5);
      expect(snapshot.crashed).toBe(false);

      run(4, { lever: 0.35 });
      snapshot = boat.snapshot();
      expect(harbour.mooring.state).toBe("free");
      expect(snapshot.payload.moored).toBe(false);
      expect(Math.hypot(snapshot.position.x - pose.x, snapshot.position.z - pose.z)).toBeGreaterThan(2);
    });
  }

  it("takes a press as a press only after the first count, and shows MOORED only on lines", () => {
    const { boat, harbour, run } = session(0x51a7e);
    // The first count is the baseline, whatever it is: still moored.
    run(1, { moorPresses: 4 });
    expect(harbour.mooring.state).toBe("moored");
    // A change casts off.
    run(1, { moorPresses: 5 });
    expect(harbour.mooring.state).toBe("free");
    expect(boat.snapshot().payload.moored).toBe(false);
    // Out of the berth under power, stopped, and a press away from any berth.
    run(10, { lever: 0.5, moorPresses: 5 });
    run(15, { lever: 0, moorPresses: 5 });
    const away = harbour.mooring.berthNear(boat.body.position.x, boat.body.position.z) === null;
    run(0.5, { lever: 0, moorPresses: 6 });
    if (away) {
      expect(harbour.mooring.state).toBe("free");
      expect(boat.snapshot().payload.moored).toBe(false);
    }
    expect(away).toBe(true);
  });
});
