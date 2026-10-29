import { describe, expect, it } from "vitest";
import {
  PERF_CAPTURE_DEFAULT_CLOCK,
  PERF_CAPTURE_SEED,
  PERF_CAPTURE_SHOTS,
  type PerfCaptureShotDefinition,
  yawForSunBearing,
} from "../scripts/perf-capture.mts";
import type { CarVisualState, FlightVisualState } from "../src/game/types";
import { carWheelContacts, createCarWheelContacts, rotateCarBodyToWorld } from "../src/render/webgpu/ground/carEffectLaws";
import { sunDirectionForClock } from "../src/render/webgpu/nature/EnvironmentDirector";
import { SurfaceMaterial } from "../src/render/webgpu/terrain/surfaceMaterials";
import { createCarSurface, SurfaceCache } from "../src/sim/ground/surface";
import type { GroundField } from "../src/sim/ground/terrainPatch";
import { sampleGroundContact } from "../src/sim/terrainGrid";
import { LANDCRUISER_76 } from "../src/vehicles/landcruiser76";
import { createWorld, sampleTerrainHeight } from "../src/world";
import type { TerrainCollisionSample, WorldDefinition } from "../src/world/types";
import {
  CAR_SHOT_CLEAR_TREE_METERS,
  CAR_SHOT_FRONT_AXLE_X,
  CAR_SHOT_FRONT_SHARE,
  CAR_SHOT_FRONT_TRACK,
  CAR_SHOT_KERB_MASS,
  CAR_SHOT_LOADED_RADIUS,
  CAR_SHOT_REAR_AXLE_X,
  CAR_SHOT_REAR_TRACK,
  CAR_SHOT_WHEEL_CENTRE_Y,
  carShotEffectsHistoryFrames,
  nearestVegetation,
} from "./perf/carShotState";
import { carShotState, resolveShotPlacement } from "./perf/shotPlacement";

/**
 * The car shots (`PerfCaptureShotDefinition.car`): a pinned pose whose four
 * tyres stand on the terrain where the shot was placed, with the payload the
 * effects read.
 */

const carShots = PERF_CAPTURE_SHOTS.filter((shot) => shot.car !== undefined);
const worlds = new Map<string, WorldDefinition>();

function worldFor(shot: PerfCaptureShotDefinition): WorldDefinition {
  const key = JSON.stringify({ climateProvince: shot.climateProvince ?? null, landforms: shot.landforms ?? null });
  let world = worlds.get(key);
  if (!world) {
    world = createWorld(PERF_CAPTURE_SEED, {
      ...(shot.climateProvince === undefined ? {} : { climateProvince: shot.climateProvince }),
      ...(shot.landforms === undefined ? {} : { landforms: shot.landforms }),
    });
    worlds.set(key, world);
  }
  return world;
}

/** The shot's state as both harnesses build it. */
function shotState(name: string): { world: WorldDefinition; state: FlightVisualState; car: CarVisualState } {
  const shot = carShots.find((candidate) => candidate.name === name)!;
  const world = worldFor(shot);
  const placement = resolveShotPlacement(world, shot);
  const clock = shot.clock ?? PERF_CAPTURE_DEFAULT_CLOCK;
  const yawDegrees = shot.relativeSunBearingDegrees === undefined
    ? 0
    : yawForSunBearing(sunDirectionForClock(clock, world.latitudeDegrees), shot.relativeSunBearingDegrees);
  const state = carShotState(
    world,
    shot.car!,
    {
      x: (world.airport?.centerX ?? 0) + placement.offsetXMeters,
      z: (world.airport?.centerZ ?? 0) + placement.offsetZMeters,
      yawDegrees,
    },
    100,
  );
  return { world, state, car: state.vehicle as CarVisualState };
}

/** The four tyres' feet as the renderer's own effects find them, against the terrain under each. */
function feetOnGround(world: WorldDefinition, state: FlightVisualState, car: CarVisualState): number[] {
  const contacts = createCarWheelContacts();
  carWheelContacts(state, car, contacts);
  return contacts.map((contact) => contact.y - sampleTerrainHeight(world, contact.x, contact.z));
}

describe("car shots", () => {
  it("are four car views, the last shots of all", () => {
    expect(carShots.map((shot) => shot.name)).toEqual([
      "car-clearing-chase",
      "car-dune-cockpit",
      "car-ford-chase",
      "car-dust-chase",
    ]);
    expect(PERF_CAPTURE_SHOTS.slice(-carShots.length).every((shot) => shot.car !== undefined)).toBe(true);
    for (const shot of carShots) expect(shot.boat).toBeUndefined();
  });

  it("type the car's dimensions as LANDCRUISER_76 has them", () => {
    const { geometry, tyre, mass } = LANDCRUISER_76;
    expect(CAR_SHOT_FRONT_AXLE_X).toBe(geometry.frontAxleX);
    expect(CAR_SHOT_REAR_AXLE_X).toBe(geometry.rearAxleX);
    expect(CAR_SHOT_FRONT_TRACK).toBe(geometry.frontTrack);
    expect(CAR_SHOT_REAR_TRACK).toBe(geometry.rearTrack);
    expect(CAR_SHOT_WHEEL_CENTRE_Y).toBe(geometry.wheelCentreY);
    expect(CAR_SHOT_LOADED_RADIUS).toBe(tyre.loadedRadius);
    expect(CAR_SHOT_KERB_MASS).toBe(mass.kerb);
    expect(CAR_SHOT_FRONT_SHARE).toBe(mass.frontAxleShare);
  });

  it("stand every tyre on the terrain, with a body square to itself and the kerb weight on the tyres", () => {
    for (const shot of carShots) {
      const { world, state, car } = shotState(shot.name);
      const feet = feetOnGround(world, state, car);
      for (const gap of feet) expect(Math.abs(gap), `${shot.name}: a tyre off the ground by ${gap.toFixed(3)} m`).toBeLessThan(0.03);
      const forward = { x: 0, y: 0, z: 0 };
      const up = { x: 0, y: 0, z: 0 };
      rotateCarBodyToWorld(state.orientation, 1, 0, 0, forward);
      rotateCarBodyToWorld(state.orientation, 0, 1, 0, up);
      const q = state.orientation;
      expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 9);
      expect(up.y).toBeGreaterThan(0.95);
      // Moving along the body's nose at the run's speed, and every tyre rolling with it.
      const speed = Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z);
      expect(speed).toBeCloseTo(shot.car!.speedMetersPerSecond, 9);
      expect((state.velocity.x * forward.x + state.velocity.y * forward.y + state.velocity.z * forward.z) / speed).toBeCloseTo(1, 9);
      expect(car.speed).toBe(shot.car!.speedMetersPerSecond);
      for (const rate of car.wheelSpinRate) {
        expect(rate * CAR_SHOT_LOADED_RADIUS).toBeGreaterThanOrEqual(car.speed - 1e-9);
      }
      const load = car.wheelLoad.reduce((sum, value) => sum + value, 0);
      expect(load).toBeCloseTo(CAR_SHOT_KERB_MASS * 9.80665, 6);
      expect(state.throttle).toBe(shot.car!.throttle);
      expect(state.onGround).toBe(true);
    }
  });

  it("put the clearing shot's car where no tree the densest tier grows stands within 10 m, and no shrub or rock under it", () => {
    const { world, state, car } = shotState("car-clearing-chase");
    const forward = { x: 0, y: 0, z: 0 };
    rotateCarBodyToWorld(state.orientation, 1, 0, 0, forward);
    const heading = Math.hypot(forward.x, forward.z);
    const nearest = nearestVegetation(world, state.position.x, state.position.z, forward.x / heading, forward.z / heading);
    expect(nearest.tree).toBeGreaterThan(CAR_SHOT_CLEAR_TREE_METERS);
    expect(nearest.tree).toBeLessThan(60);
    expect(nearest.undergrowthInFootprint).toBe(false);
    expect(car.wadingDepth).toBe(0);
    expect(car.wheelSurface.every((material) => material >= 0)).toBe(true);
  });

  it("climb the dune shot's car up a sand flank on aired-down tyres", () => {
    const { world, state, car } = shotState("car-dune-cockpit");
    expect(car.wheelSurface).toEqual([SurfaceMaterial.Sand, SurfaceMaterial.Sand, SurfaceMaterial.Sand, SurfaceMaterial.Sand]);
    expect(car.tyrePressure).toBe("sand");
    expect(car.wheelSinkage.every((sinkage) => sinkage > 0)).toBe(true);
    expect(car.wheelSpinRate[0]! * CAR_SHOT_LOADED_RADIUS).toBeGreaterThan(car.speed);
    // Nose up the flank: 4 to 10 degrees.
    expect(state.pitch).toBeGreaterThan(4);
    expect(state.pitch).toBeLessThan(10);
    expect(state.position.y - world.seaLevel).toBeGreaterThan(2);
  });

  it("wade the ford shot's car up a beach out of 0.45 m of sea", () => {
    const { world, state, car } = shotState("car-ford-chase");
    expect(car.wadingDepth).toBeGreaterThan(0.4);
    expect(car.wadingDepth).toBeLessThan(0.6);
    // Every tyre in the water, wet, and the bed rising ahead.
    expect(car.wheelSurface).toEqual([-1, -1, -1, -1]);
    expect(car.wheelWetness).toEqual([1, 1, 1, 1]);
    // All of it the sea, whose waves the bow wave rides.
    expect(car.wadingSea).toBe(1);
    const forward = { x: 0, y: 0, z: 0 };
    rotateCarBodyToWorld(state.orientation, 1, 0, 0, forward);
    const ahead = sampleTerrainHeight(world, state.position.x + forward.x * 30, state.position.z + forward.z * 30);
    const behind = sampleTerrainHeight(world, state.position.x - forward.x * 30, state.position.z - forward.z * 30);
    expect(ahead).toBeGreaterThan(world.seaLevel);
    expect(behind).toBeLessThan(world.seaLevel - 0.45);
    // The intake stays dry: 0.45 m is well under the 76's wading depth.
    expect(car.wadingDepth).toBeLessThan(LANDCRUISER_76.water.wadingDepth);
  });

  it("pull the dust shot's car away over dry grass with its wheels spinning", () => {
    const { car } = shotState("car-dust-chase");
    const dry = SurfaceMaterial.DryGrass;
    expect(car.wheelSurface).toEqual([dry, dry, dry, dry]);
    expect(car.wheelWetness).toEqual([0, 0, 0, 0]);
    expect(car.wadingDepth).toBe(0);
    for (const rate of car.wheelSpinRate) expect(rate * CAR_SHOT_LOADED_RADIUS).toBeGreaterThan(car.speed + 5);
  });

  it("stand a shot's tyres on the surface the car simulator reports there, where the shot names one", () => {
    const named = carShots.filter((shot) => shot.car!.surface !== undefined);
    expect(named.map((shot) => shot.name)).toEqual(["car-dust-chase"]);
    for (const shot of named) {
      const { world, state, car } = shotState(shot.name);
      const ground = worldGround(world);
      const cache = new SurfaceCache();
      const out = createCarSurface();
      const contacts = createCarWheelContacts();
      carWheelContacts(state, car, contacts);
      for (const contact of contacts) {
        cache.beginStep(world);
        const at = { x: contact.x, z: contact.z, height: 0, dhdx: 0, dhdz: 0 };
        ground.evaluate(at);
        expect(cache.lookup(world, ground, at, out)).toBe(true);
        expect(out.material, `${shot.name}: the simulator's surface under a tyre`).toBe(SurfaceMaterial[shot.car!.surface!]);
      }
    }
  });

  it("run only the dust and the ford shots' effects up to the time pin, the dust's whole life", () => {
    const history = PERF_CAPTURE_SHOTS.filter((shot) => carShotEffectsHistoryFrames(shot.car) > 0);
    expect(history.map((shot) => shot.name)).toEqual(["car-ford-chase", "car-dust-chase"]);
    for (const shot of history) expect(carShotEffectsHistoryFrames(shot.car)).toBe(300);
    expect(carShotEffectsHistoryFrames(undefined)).toBe(0);
    expect(carShotEffectsHistoryFrames({})).toBe(0);
    expect(carShotEffectsHistoryFrames({ effectsHistorySeconds: 0 })).toBe(0);
    expect(carShotEffectsHistoryFrames({ effectsHistorySeconds: -1 })).toBe(0);
    expect(carShotEffectsHistoryFrames({ effectsHistorySeconds: Number.NaN })).toBe(0);
    expect(carShotEffectsHistoryFrames({ effectsHistorySeconds: 1.5 })).toBe(90);
  });

  it("are the same car every time they are built", () => {
    for (const shot of carShots) {
      const first = shotState(shot.name).state;
      const second = shotState(shot.name).state;
      expect(second).toEqual(first);
    }
  });
});

/** The terrain as the car simulator's ground (as `sim.car-terrain.test.ts` builds it). */
function worldGround(world: WorldDefinition): GroundField {
  const contact: TerrainCollisionSample = { height: 0, normal: { x: 0, y: 1, z: 0 }, isRunway: false, friction: 1 };
  return {
    evaluate(at) {
      sampleGroundContact(world, at.x, at.z, contact);
      at.height = contact.height;
      at.dhdx = -contact.normal.x / contact.normal.y;
      at.dhdz = -contact.normal.z / contact.normal.y;
    },
  };
}
