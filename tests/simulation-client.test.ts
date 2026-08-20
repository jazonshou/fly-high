import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VISUAL_EXTRAPOLATION_SECONDS,
  SimulationClient,
  extrapolateFlightState,
} from "../src/game/SimulationClient";
import { INITIAL_VISUAL_STATE, type FlightVisualState } from "../src/game/types";
import { createWorld } from "../src/world";
import type { SimulationEvent } from "../src/workers/protocol";

class WorkerStub extends EventTarget {
  static latest: WorkerStub | null = null;
  readonly messages: unknown[] = [];

  constructor() {
    super();
    WorkerStub.latest = this;
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  emit(event: SimulationEvent): void {
    this.dispatchEvent(new MessageEvent("message", { data: event }));
  }

  terminate(): void {}
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  WorkerStub.latest = null;
});

function visualStateAt(
  simulationTime: number,
  overrides: Partial<FlightVisualState> = {},
): FlightVisualState {
  const velocity = overrides.velocity ?? { x: 10, y: 2, z: -4 };
  return {
    ...INITIAL_VISUAL_STATE,
    ...overrides,
    position: overrides.position ?? {
      x: velocity.x * simulationTime,
      y: 700 + velocity.y * simulationTime,
      z: velocity.z * simulationTime,
    },
    velocity,
    orientation: overrides.orientation ?? { x: 0, y: 0, z: 0, w: 1 },
    angularVelocity: overrides.angularVelocity ?? { x: 0, y: 1, z: 0 },
    altitude: overrides.altitude ?? 700 + velocity.y * simulationTime,
    altitudeAgl: overrides.altitudeAgl ?? 500 + velocity.y * simulationTime,
    verticalSpeed: overrides.verticalSpeed ?? velocity.y,
    simulationTime,
  };
}

describe("simulation worker lifecycle commands", () => {
  it("sends crash recovery separately from an ordinary spawn reset", () => {
    vi.stubGlobal("Worker", WorkerStub);
    const world = createWorld(123);
    const client = new SimulationClient(world, "unassisted");
    const worker = WorkerStub.latest!;

    expect((worker.messages[0] as { world?: unknown }).world).toBe(world);
    expect(worker.messages[0]).toEqual({
      type: "initialize",
      world,
      aircraft: "trainer",
      mode: "unassisted",
      spawn: "airborne",
      weather: "breezy",
      airborneStartAgl: 450,
      attractMode: false,
    });

    client.reset("runway", 450);
    client.restartAfterCrash(735);

    expect(worker.messages.at(-2)).toEqual({
      type: "reset",
      spawn: "runway",
      airborneStartAgl: 450,
    });
    expect(worker.messages.at(-1)).toEqual({
      type: "restartAfterCrash",
      airborneStartAgl: 735,
    });
    client.dispose();
  });

  it("recovers only a crashed simulator from its authoritative world coordinates", () => {
    const workerSource = readFileSync(
      new URL("../src/workers/simulation.worker.ts", import.meta.url),
      "utf8",
    );
    const recovery = workerSource.match(
      /function restartAfterCrash[\s\S]*?\n\}/u,
    )?.[0] ?? "";

    expect(recovery).toContain("simulator.state.crashed");
    expect(recovery).toContain("simulator.state.position.x");
    expect(recovery).toContain("simulator.state.position.z");
    expect(recovery).toContain("simulator.telemetry().heading");
    expect(recovery).toContain("createCrashRecoverySpawn");
    expect(recovery).toContain('installSimulation(\n    "airborne"');
    expect(recovery).not.toContain("originX");
    expect(recovery).not.toContain("originZ");
  });

  it("67a: samples snapshot time monotonically under arrival jitter and caps coasting", () => {
    vi.stubGlobal("Worker", WorkerStub);
    let nowMilliseconds = 100_000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMilliseconds);
    const client = new SimulationClient(createWorld(321), "unassisted");
    const worker = WorkerStub.latest!;

    worker.emit({ type: "ready", state: visualStateAt(0) });
    nowMilliseconds = 100_030;
    worker.emit({ type: "snapshot", state: visualStateAt(0.02) });

    const sampled: FlightVisualState[] = [];
    for (const timestamp of [100_032, 100_050, 100_090]) {
      sampled.push(structuredClone(client.getRenderState(timestamp)!));
    }

    // The next snapshot arrives late enough that an arrival-reanchored clock
    // would snap backwards. The EMA clock and monotone sample guard do not.
    nowMilliseconds = 100_105;
    worker.emit({ type: "snapshot", state: visualStateAt(0.04) });
    for (const timestamp of [100_106, 100_140, 100_300]) {
      sampled.push(structuredClone(client.getRenderState(timestamp)!));
    }
    // A duplicate-time snapshot must not pull a client that has already
    // coasted ahead back to the authoritative edge.
    nowMilliseconds = 100_305;
    worker.emit({ type: "snapshot", state: visualStateAt(0.04) });
    sampled.push(structuredClone(client.getRenderState(100_306)!));

    for (let index = 1; index < sampled.length; index += 1) {
      expect(sampled[index]!.simulationTime).toBeGreaterThanOrEqual(
        sampled[index - 1]!.simulationTime,
      );
    }
    const last = sampled.at(-1)!;
    expect(last.simulationTime).toBeCloseTo(
      0.04 + MAX_VISUAL_EXTRAPOLATION_SECONDS,
      10,
    );
    expect(last.position.x).toBeCloseTo(0.4 + 10 * MAX_VISUAL_EXTRAPOLATION_SECONDS, 10);
    expect(last.orientation.y).toBeGreaterThan(0);
    expect(Math.hypot(
      last.orientation.x,
      last.orientation.y,
      last.orientation.z,
      last.orientation.w,
    )).toBeCloseTo(1, 10);
    client.dispose();
  });

  it("67a: clamps direct extrapolation to 50 ms without mutating its snapshot", () => {
    const snapshot = visualStateAt(4, {
      position: { x: 40, y: 708, z: -16 },
      angularVelocity: { x: 0.4, y: 0.2, z: -0.3 },
    });
    const before = structuredClone(snapshot);
    const extrapolated = extrapolateFlightState(snapshot, 1);

    expect(extrapolated.simulationTime - snapshot.simulationTime).toBeCloseTo(0.05, 12);
    expect(extrapolated.position).toEqual({ x: 40.5, y: 708.1, z: -16.2 });
    expect(snapshot).toEqual(before);
  });
});
