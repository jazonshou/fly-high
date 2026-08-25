import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VISUAL_EXTRAPOLATION_SECONDS,
  SimulationClient,
  VISUAL_PRESENTATION_DELAY_SECONDS,
  extrapolateFlightState,
  interpolateFlightState,
} from "../src/game/SimulationClient";
import { INITIAL_VISUAL_STATE, type FlightVisualState } from "../src/game/types";
import { createWorld } from "../src/world";
import type { SimulationEvent } from "../src/workers/protocol";

class WorkerStub extends EventTarget {
  static latest: WorkerStub | null = null;
  readonly messages: unknown[] = [];
  readonly transfers: Transferable[][] = [];

  constructor() {
    super();
    WorkerStub.latest = this;
  }

  postMessage(message: unknown, transferables: Transferable[] = []): void {
    this.messages.push(message);
    this.transfers.push(transferables);
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

function acceleratedTurningStateAt(simulationTime: number): FlightVisualState {
  const accelerationX = 6;
  const accelerationZ = 1.5;
  const velocity = {
    x: 18 + accelerationX * simulationTime,
    y: 1.25,
    z: -3 + accelerationZ * simulationTime,
  };
  const angle = 0.35 * simulationTime + 0.5 * 0.3 * simulationTime ** 2;
  return visualStateAt(simulationTime, {
    position: {
      x: 18 * simulationTime + 0.5 * accelerationX * simulationTime ** 2,
      y: 700 + velocity.y * simulationTime,
      z: -3 * simulationTime + 0.5 * accelerationZ * simulationTime ** 2,
    },
    velocity,
    orientation: { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) },
    angularVelocity: { x: 0, y: 0.35 + 0.3 * simulationTime, z: 0 },
    altitude: 700 + velocity.y * simulationTime,
    altitudeAgl: 500 + velocity.y * simulationTime,
    verticalSpeed: velocity.y,
  });
}

function quaternionAngularDistance(
  first: FlightVisualState["orientation"],
  second: FlightVisualState["orientation"],
): number {
  const dot = Math.abs(
    first.x * second.x + first.y * second.y + first.z * second.z + first.w * second.w,
  );
  return 2 * Math.acos(Math.min(1, Math.max(-1, dot)));
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

  it("transfers terrain page and macro publications without adapter objects", () => {
    vi.stubGlobal("Worker", WorkerStub);
    const client = new SimulationClient(createWorld(456), "unassisted");
    const worker = WorkerStub.latest!;
    const pageHeights = new Float32Array(256 * 256);
    const macroHeights = new Float32Array(4);

    client.publishTerrainPage({ level: 0, tileX: -2, tileZ: 7, heights: pageHeights });
    client.publishTerrainMacro({
      originX: -256,
      originZ: -256,
      texelSizeMeters: 512,
      width: 2,
      height: 2,
      heights: macroHeights,
    });

    expect(worker.messages.at(-2)).toEqual({
      type: "terrainPage",
      page: { level: 0, tileX: -2, tileZ: 7, heights: pageHeights },
    });
    expect(worker.transfers.at(-2)).toEqual([pageHeights.buffer]);
    expect(worker.messages.at(-1)).toEqual({
      type: "terrainMacro",
      macro: {
        originX: -256,
        originZ: -256,
        texelSizeMeters: 512,
        width: 2,
        height: 2,
        heights: macroHeights,
      },
    });
    expect(worker.transfers.at(-1)).toEqual([macroHeights.buffer]);
    client.dispose();
  });

  it("carries optional worker terrain counters without interpolating them", () => {
    const first = visualStateAt(1);
    const counters = { readbackServed: 12, macroServed: 3, analyticServed: 0 };
    const second = visualStateAt(2, { terrainAuthority: counters });
    expect(interpolateFlightState(first, second, 0.25).terrainAuthority).toBe(counters);

    const staleTarget = visualStateAt(2, { terrainAuthority: counters });
    const extrapolated = extrapolateFlightState(first, 0.01, staleTarget);
    expect(extrapolated).not.toHaveProperty("terrainAuthority");
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

  it("uses a fixed presentation buffer when worker snapshot spacing slips", () => {
    vi.stubGlobal("Worker", WorkerStub);
    let nowMilliseconds = 100_000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMilliseconds);
    const client = new SimulationClient(createWorld(654), "unassisted");
    const worker = WorkerStub.latest!;

    worker.emit({ type: "ready", state: acceleratedTurningStateAt(0) });
    nowMilliseconds = 100_020;
    worker.emit({ type: "snapshot", state: acceleratedTurningStateAt(0.02) });
    // The worker missed two ordinary publications. The interpolation bracket
    // is 50 ms wide, but presentation latency remains exactly one 60 Hz tick.
    nowMilliseconds = 100_070;
    worker.emit({ type: "snapshot", state: acceleratedTurningStateAt(0.07) });
    const rendered = client.getRenderState(100_071)!;

    expect(rendered.simulationTime).toBeCloseTo(
      0.071 - VISUAL_PRESENTATION_DELAY_SECONDS,
      10,
    );
    client.dispose();
  });

  it("keeps accelerated turning presentation smooth through alternating delay and a burst", () => {
    vi.stubGlobal("Worker", WorkerStub);
    let nowMilliseconds = 100_000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMilliseconds);
    const client = new SimulationClient(createWorld(987), "unassisted");
    const worker = WorkerStub.latest!;
    const baseSeconds = 100;
    worker.emit({ type: "ready", state: acceleratedTurningStateAt(0) });

    const events: Array<{ arrival: number; state: FlightVisualState }> = [];
    let previousArrival = baseSeconds;
    for (let index = 1; index <= 32; index += 1) {
      const simulationTime = index / 60;
      const alternatingDelay = index % 2 === 0 ? 0.02 : 0;
      let arrival = baseSeconds + simulationTime + alternatingDelay;
      // Model a 100 ms main-thread block. Worker messages retain order and are
      // dispatched as one burst when the event loop becomes available again.
      if (arrival > baseSeconds + 0.25 && arrival < baseSeconds + 0.35) {
        arrival = baseSeconds + 0.35;
      }
      arrival = Math.max(arrival, previousArrival);
      previousArrival = arrival;
      events.push({ arrival, state: acceleratedTurningStateAt(simulationTime) });
    }

    const samples: Array<{ wallTime: number; state: FlightVisualState }> = [];
    let eventIndex = 0;
    for (let frame = 1; frame <= 62; frame += 1) {
      const wallTime = baseSeconds + frame / 120;
      while (eventIndex < events.length && events[eventIndex]!.arrival <= wallTime + 1e-10) {
        const event = events[eventIndex]!;
        nowMilliseconds = event.arrival * 1_000;
        worker.emit({ type: "snapshot", state: event.state });
        eventIndex += 1;
      }
      // A blocked main thread neither receives rAF nor presents frames.
      if (wallTime > baseSeconds + 0.25 && wallTime < baseSeconds + 0.35) continue;
      const state = structuredClone(client.getRenderState(wallTime * 1_000)!);
      if (wallTime >= baseSeconds + 0.1) samples.push({ wallTime, state });
    }

    let maxPositionError = 0;
    let maxAngularError = 0;
    const positionErrors: Array<{ x: number; y: number; z: number }> = [];
    const angularErrors: number[] = [];
    for (const sample of samples) {
      const expectedTime = sample.wallTime - baseSeconds - VISUAL_PRESENTATION_DELAY_SECONDS;
      const expected = acceleratedTurningStateAt(expectedTime);
      maxPositionError = Math.max(
        maxPositionError,
        Math.hypot(
          sample.state.position.x - expected.position.x,
          sample.state.position.y - expected.position.y,
          sample.state.position.z - expected.position.z,
        ),
      );
      maxAngularError = Math.max(
        maxAngularError,
        quaternionAngularDistance(sample.state.orientation, expected.orientation),
      );
      positionErrors.push({
        x: sample.state.position.x - expected.position.x,
        y: sample.state.position.y - expected.position.y,
        z: sample.state.position.z - expected.position.z,
      });
      angularErrors.push(
        2 * Math.atan2(sample.state.orientation.y, sample.state.orientation.w)
        - 2 * Math.atan2(expected.orientation.y, expected.orientation.w),
      );
    }

    for (let index = 1; index < samples.length; index += 1) {
      const wallDelta = samples[index]!.wallTime - samples[index - 1]!.wallTime;
      const simulationDelta =
        samples[index]!.state.simulationTime - samples[index - 1]!.state.simulationTime;
      // Queue jitter must not become a stopped frame followed by a catch-up
      // frame. The wider bound includes the intentionally missing 100 ms rAF.
      expect(simulationDelta).toBeGreaterThan(wallDelta * 0.8);
      expect(simulationDelta).toBeLessThan(wallDelta * 1.2);
    }

    // The visible jerk is the correction applied when a new authoritative
    // snapshot replaces a coasted prediction. Bound that correction directly;
    // differentiating sub-millimetre interpolation error three times instead
    // would manufacture a huge, non-visual metres/s^3 number.
    let maxPositionCorrectionStep = 0;
    let maxAngularCorrectionStep = 0;
    for (let index = 1; index < positionErrors.length; index += 1) {
      const first = positionErrors[index - 1]!;
      const second = positionErrors[index]!;
      maxPositionCorrectionStep = Math.max(
        maxPositionCorrectionStep,
        Math.hypot(second.x - first.x, second.y - first.y, second.z - first.z),
      );
      maxAngularCorrectionStep = Math.max(
        maxAngularCorrectionStep,
        Math.abs(angularErrors[index]! - angularErrors[index - 1]!),
      );
    }

    expect(maxPositionError).toBeLessThan(0.01);
    expect(maxAngularError).toBeLessThan(0.001);
    expect(maxPositionCorrectionStep).toBeLessThan(0.003);
    expect(maxAngularCorrectionStep).toBeLessThan(0.000_2);
    client.dispose();
  });

  it("slews a persistent upward clock-phase change without freezing presentation", () => {
    vi.stubGlobal("Worker", WorkerStub);
    let nowMilliseconds = 100_000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMilliseconds);
    const client = new SimulationClient(createWorld(741), "unassisted");
    const worker = WorkerStub.latest!;
    worker.emit({ type: "ready", state: acceleratedTurningStateAt(0) });

    for (let index = 1; index <= 40; index += 1) {
      const simulationTime = index / 60;
      nowMilliseconds = (100 + simulationTime) * 1_000;
      worker.emit({ type: "snapshot", state: acceleratedTurningStateAt(simulationTime) });
      client.getRenderState(nowMilliseconds);
    }

    const sampledTimes: number[] = [];
    for (let index = 41; index <= 82; index += 1) {
      const simulationTime = index / 60;
      // The worker permanently lost 50 ms (for example by dropping an
      // accumulator after a stall), so the true clock phase moved upward.
      nowMilliseconds = (100 + simulationTime + 0.05) * 1_000;
      worker.emit({ type: "snapshot", state: acceleratedTurningStateAt(simulationTime) });
      sampledTimes.push(client.getRenderState(nowMilliseconds)!.simulationTime);
    }

    for (let index = 1; index < sampledTimes.length; index += 1) {
      const delta = sampledTimes[index]! - sampledTimes[index - 1]!;
      expect(delta).toBeGreaterThan((1 / 60) * 0.89);
      expect(delta).toBeLessThanOrEqual(1 / 60 + 1e-10);
    }
    client.dispose();
  });

  it("never rewinds a coasted presentation across pause and resume", () => {
    vi.stubGlobal("Worker", WorkerStub);
    let nowMilliseconds = 100_000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMilliseconds);
    const client = new SimulationClient(createWorld(852), "unassisted");
    const worker = WorkerStub.latest!;
    worker.emit({ type: "ready", state: acceleratedTurningStateAt(0) });
    nowMilliseconds = 100_100;
    worker.emit({ type: "snapshot", state: acceleratedTurningStateAt(0.1) });
    client.getRenderState(nowMilliseconds);

    // Coast to the bounded prediction limit before pausing. This is the
    // exact case the old reset branch rewound back to authority (0.1 s).
    nowMilliseconds = 100_200;
    const beforePause = client.getRenderState(nowMilliseconds)!;
    expect(beforePause.simulationTime).toBeCloseTo(0.15, 10);

    client.setPaused(true);
    const frozen = client.getRenderState(110_000)!;
    expect(frozen.simulationTime).toBe(beforePause.simulationTime);
    expect(frozen.position).toEqual(beforePause.position);

    client.setPaused(false);
    const waiting = client.getRenderState(110_000)!;
    expect(waiting.simulationTime).toBe(beforePause.simulationTime);
    expect(waiting.position).toEqual(beforePause.position);

    nowMilliseconds = 110_017;
    worker.emit({ type: "snapshot", state: acceleratedTurningStateAt(0.116_666_666_7) });
    const firstResume = client.getRenderState(110_018)!;
    expect(firstResume.simulationTime).toBe(waiting.simulationTime);
    expect(firstResume.position).toEqual(waiting.position);

    nowMilliseconds = 110_034;
    worker.emit({ type: "snapshot", state: acceleratedTurningStateAt(0.133_333_333_3) });
    const catchingUp = client.getRenderState(110_035)!;
    expect(catchingUp.simulationTime).toBeGreaterThanOrEqual(firstResume.simulationTime);

    nowMilliseconds = 110_051;
    worker.emit({ type: "snapshot", state: acceleratedTurningStateAt(0.15) });
    const caughtUp = client.getRenderState(110_052)!;
    expect(caughtUp.simulationTime).toBeGreaterThanOrEqual(catchingUp.simulationTime);

    nowMilliseconds = 110_068;
    worker.emit({ type: "snapshot", state: acceleratedTurningStateAt(0.166_666_666_7) });
    const resumed = client.getRenderState(110_069)!;
    expect(resumed.simulationTime).toBeGreaterThanOrEqual(caughtUp.simulationTime);
    client.dispose();
  });
});
