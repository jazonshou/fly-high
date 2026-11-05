import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ControlState, FlightVisualState, PersonControlState } from "@/src/game/types";
import { WORLD_PAGE_BASE_EXTENT_METERS, WORLD_PAGE_HEIGHT_CORE } from "@/src/render/webgpu/world/pageGeometry";
import { NEUTRAL_CAR_CONTROLS, NEUTRAL_PERSON_CONTROLS } from "@/src/sim/surface/types";
import { PERSON } from "@/src/vehicles/person";
import { clearInfrastructureRegions } from "@/src/world/infrastructure";
import { InfrastructureRegionsForwarder, packInfrastructureRegionsUpdate } from "@/src/world/infrastructureSync";
import { createWorld } from "@/src/world/world";
import type { SimulationCommand, SimulationEvent } from "@/src/workers/protocol";

/**
 * A walk in the simulation worker itself, as the game drives it: the "foot"
 * start beside the parked car, walking on the person's controls, getting in
 * with an interact press, driving, and getting out again. The worker module
 * is loaded into a module graph of its own as a real worker has, its tick run
 * on fake timers, its snapshots read back (as tests/sim.car-hydrology-worker
 * does for the car alone).
 */

const world = createWorld();

interface WorkerRealm {
  send(command: SimulationCommand): void;
  groundHeight(x: number, z: number): number;
  latest(): FlightVisualState;
  /** "ready" events: the first state, and a fresh start each time the driven one changes. */
  starts: number;
}

let realm: WorkerRealm;

beforeAll(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  let listener: ((event: { data: SimulationCommand }) => void) | null = null;
  let latest: FlightVisualState | null = null;
  let starts = 0;
  vi.stubGlobal("self", {
    addEventListener: (type: string, handler: typeof listener) => {
      if (type === "message") listener = handler;
    },
    postMessage: (event: SimulationEvent) => {
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "ready") starts += 1;
      if ("state" in event) latest = event.state;
    },
  });
  await import("@/src/workers/simulation.worker");
  const grid = await import("@/src/sim/terrainGrid");
  let workerWorld = world;
  realm = {
    send: (command) => {
      const cloned = structuredClone(command);
      if (cloned.type === "initialize") workerWorld = cloned.world;
      listener!({ data: cloned });
    },
    groundHeight: (x, z) => grid.sampleGroundHeight(workerWorld, x, z),
    latest: () => latest!,
    get starts() {
      return starts;
    },
  };
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
  clearInfrastructureRegions();
});

const PARKED: ControlState = { pitch: 0, roll: 0, yaw: 0, throttle: 0, trim: 0, flaps: 0, brake: 0, gear: 1 };

function onFoot(person: Partial<PersonControlState>, interactPresses: number): ControlState {
  return { ...PARKED, person: { ...NEUTRAL_PERSON_CONTROLS, ...person }, interactPresses };
}

describe("a walk in the simulation worker", () => {
  it("starts on foot by the parked car, walks, gets in, drives and gets out", () => {
    const infrastructure = packInfrastructureRegionsUpdate(new InfrastructureRegionsForwarder(world).initial());
    realm.send({
      type: "initialize",
      world,
      aircraft: "trainer",
      surfaceVehicle: "landcruiser",
      carSetup: { gearbox: "automatic", manualClutch: false },
      mode: "pilot",
      spawn: "foot",
      airborneStartAgl: 450,
      attractMode: false,
      weather: "breezy",
      infrastructure,
      dayOfYear: 171,
    });
    // The L0 pages round the start, so the car's spawn gate opens.
    const start = realm.latest().position;
    const tileX = Math.floor(start.x / WORLD_PAGE_BASE_EXTENT_METERS);
    const tileZ = Math.floor(start.z / WORLD_PAGE_BASE_EXTENT_METERS);
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const heights = new Float32Array(WORLD_PAGE_HEIGHT_CORE * WORLD_PAGE_HEIGHT_CORE)
          .fill(realm.groundHeight(start.x, start.z));
        realm.send({
          type: "terrainPage",
          page: { level: 0, tileX: tileX + dx, tileZ: tileZ + dz, heights, infrastructureVersion: infrastructure.version },
        });
      }
    }
    realm.send({ type: "controls", controls: onFoot({}, 0) });
    realm.send({ type: "pause", paused: false });
    vi.advanceTimersByTime(3_000);

    // On foot, standing at the driver's door, the car parked beside.
    let state = realm.latest();
    expect(state.walking?.driven).toBe("person");
    expect(state.vehicle?.kind).toBe("person");
    if (state.vehicle?.kind !== "person") throw new Error("person payload");
    expect(state.vehicle.grounded).toBe(true);
    const car = state.walking!.car!;
    expect(car.vehicle?.kind).toBe("car");
    const door = Math.hypot(state.position.x - car.position.x, state.position.z - car.position.z);
    expect(door).toBeGreaterThan(1);
    expect(door).toBeLessThan(2.5);
    expect(state.walking?.prompt).toEqual({ action: "getIn", ready: true, reason: null });
    expect(Math.abs(state.position.y - realm.groundHeight(state.position.x, state.position.z))).toBeLessThan(0.1);

    // Walk 3 s straight away from the car: the walking pace, on the ground.
    const away = { x: state.position.x - car.position.x, z: state.position.z - car.position.z };
    const length = Math.hypot(away.x, away.z);
    const from = { ...state.position };
    realm.send({ type: "controls", controls: onFoot({ moveX: away.x / length, moveZ: away.z / length }, 0) });
    vi.advanceTimersByTime(3_000);
    state = realm.latest();
    if (state.vehicle?.kind !== "person") throw new Error("person payload");
    const walked = Math.hypot(state.position.x - from.x, state.position.z - from.z);
    expect(walked).toBeGreaterThan(PERSON.walkSpeed * 2);
    expect(walked).toBeLessThan(PERSON.walkSpeed * 3.2);
    expect(state.walking?.prompt?.action ?? null).not.toBe("getIn");

    // Back to the door, then an interact press gets in.
    realm.send({ type: "controls", controls: onFoot({ moveX: -away.x / length, moveZ: -away.z / length }, 0) });
    vi.advanceTimersByTime(2_600);
    realm.send({ type: "controls", controls: onFoot({}, 0) });
    vi.advanceTimersByTime(800);
    expect(realm.latest().walking?.prompt).toEqual({ action: "getIn", ready: true, reason: null });
    const startsBefore = realm.starts;
    realm.send({ type: "controls", controls: onFoot({}, 1) });
    vi.advanceTimersByTime(Math.ceil(PERSON.getInSeconds * 1_000) + 500);
    state = realm.latest();
    expect(state.walking?.driven).toBe("car");
    expect(state.vehicle?.kind).toBe("car");
    expect(state.walking?.car).toBeNull();
    expect(realm.starts).toBeGreaterThan(startsBefore);

    // Drive forward a little on the car's own controls.
    const parkedAt = { ...state.position };
    const driving = (car: Partial<typeof NEUTRAL_CAR_CONTROLS>, interactPresses: number): ControlState => ({
      ...PARKED,
      car: { ...NEUTRAL_CAR_CONTROLS, ...car },
      interactPresses,
    });
    realm.send({ type: "controls", controls: driving({ accelerator: 0.5 }, 1) });
    vi.advanceTimersByTime(4_000);
    state = realm.latest();
    expect(Math.hypot(state.position.x - parkedAt.x, state.position.z - parkedAt.z)).toBeGreaterThan(1);

    // Stop, and a second press (the profile's held X) gets out again.
    realm.send({ type: "controls", controls: driving({ brake: 1 }, 1) });
    vi.advanceTimersByTime(4_000);
    realm.send({ type: "controls", controls: driving({ brake: 1 }, 2) });
    vi.advanceTimersByTime(Math.ceil(PERSON.getOutSeconds * 1_000) + 500);
    state = realm.latest();
    expect(state.walking?.driven).toBe("person");
    expect(state.vehicle?.kind).toBe("person");
    if (state.vehicle?.kind !== "person") throw new Error("person payload");
    expect(state.vehicle.boarding).toBeNull();
    expect(state.walking?.car?.vehicle?.kind).toBe("car");
  });
});
