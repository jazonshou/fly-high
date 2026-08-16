import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SimulationClient } from "../src/game/SimulationClient";
import { createWorld } from "../src/world";

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

  terminate(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  WorkerStub.latest = null;
});

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
});
