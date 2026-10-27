import { afterEach, describe, expect, it } from "vitest";
import { RoadStreamController, type RoadsWorker } from "@/src/game/RoadStreamController";
import type {
  RoadRegionAddress,
  RoadsWorkerCommand,
  RoadsWorkerEvent,
  RoadsWorkerRegionEvent,
} from "@/src/workers/roadsProtocol";
import {
  clearInfrastructureRegions,
  infrastructureRegionsVersion,
  installedInfrastructureRegionKeys,
  type InfrastructureSegment,
} from "@/src/world/infrastructure";
import { INFRASTRUCTURE_PROFILE } from "@/src/world/infrastructureProfiles";
import { roadClass, ROAD_CLASS } from "@/src/world/roads/roadClasses";
import { roadRegionKey } from "@/src/world/roads/roadInfrastructure";
import { roadLayerWindow, roadRegionBox } from "@/src/world/roads/roadNetwork";
import {
  roadRegionDistance,
  roadStreamRegions,
  ROAD_STREAM_KEEP_MARGIN,
  ROAD_STREAM_LEAD_SECONDS,
} from "@/src/world/roads/roadStreaming";
import { createWorld } from "@/src/world/world";

/**
 * Which road regions the observer is given, in what order, and the main
 * thread's controller that asks the roads worker for them and installs them
 * into the stage once a frame (`RoadStreamController`), against a worker
 * stand-in that answers synchronously.
 */

const world = createWorld();

afterEach(() => clearInfrastructureRegions());

describe("the regions an observer needs", () => {
  it("come nearest first, the ground underfoot before anything ahead", () => {
    const observer = { x: 1_000, z: -500, velocityX: 0, velocityZ: 0 };
    const regions = roadStreamRegions(observer);
    expect(regions[0]!.distance).toBe(0);
    for (let k = 1; k < regions.length; k += 1) expect(regions[k]!.distance).toBeGreaterThanOrEqual(regions[k - 1]!.distance);
    for (const region of regions) {
      expect(region.distance).toBeLessThanOrEqual(roadLayerWindow(region.layer));
      expect(roadRegionDistance(region.rx, region.rz, observer.x, observer.z)).toBe(region.distance);
    }
    // The same observer, the same list.
    expect(roadStreamRegions(observer)).toEqual(regions);
  });

  it("reach ahead of a jet by the lead time, and keep a region's margin more", () => {
    const still = roadStreamRegions({ x: 0, z: 0, velocityX: 0, velocityZ: 0 });
    const jet = roadStreamRegions({ x: 0, z: 0, velocityX: 0, velocityZ: 250 });
    const ahead = 250 * ROAD_STREAM_LEAD_SECONDS;
    const keyOf = (region: { layer: string; rx: number; rz: number }) => `${region.layer}:${region.rx}:${region.rz}`;
    const stillKeys = new Set(still.map(keyOf));
    // Everything a still observer needs, and the window round the lead point too.
    expect(still.every((region) => jet.some((other) => keyOf(other) === keyOf(region)))).toBe(true);
    const beyond = jet.filter((region) => !stillKeys.has(keyOf(region)));
    expect(beyond.length).toBeGreaterThan(0);
    for (const region of beyond) {
      expect(roadRegionDistance(region.rx, region.rz, 0, 0)).toBeGreaterThan(roadLayerWindow(region.layer));
      expect(roadRegionDistance(region.rx, region.rz, 0, ahead)).toBeLessThanOrEqual(roadLayerWindow(region.layer));
    }
    const kept = new Set(roadStreamRegions({ x: 0, z: 0, velocityX: 0, velocityZ: 250 }, ROAD_STREAM_KEEP_MARGIN).map(keyOf));
    expect(jet.every((region) => kept.has(keyOf(region)))).toBe(true);
    expect(kept.size).toBeGreaterThan(jet.length);
  });
});

/** A worker stand-in: records each command; `answer` posts the regions asked for. */
class FakeRoadsWorker implements RoadsWorker {
  readonly commands: RoadsWorkerCommand[] = [];
  private listener: ((event: MessageEvent<RoadsWorkerEvent>) => void) | null = null;

  postMessage(command: RoadsWorkerCommand): void {
    this.commands.push(command);
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<RoadsWorkerEvent>) => void): void {
    this.listener = listener;
  }

  terminate(): void {}

  get lastWant(): readonly RoadRegionAddress[] {
    for (let k = this.commands.length - 1; k >= 0; k -= 1) {
      const command = this.commands[k]!;
      if (command.type === "want") return command.regions;
    }
    return [];
  }

  private readonly answered = new Set<string>();

  /** Post the next `count` regions of the last list not yet posted. */
  answer(count = Number.POSITIVE_INFINITY): number {
    let posted = 0;
    for (const address of this.lastWant) {
      if (posted >= count) break;
      const key = `${address.layer}:${address.rx}:${address.rz}`;
      if (this.answered.has(key)) continue;
      this.answered.add(key);
      this.listener!({ data: regionEvent(address) } as MessageEvent<RoadsWorkerEvent>);
      posted += 1;
    }
    return posted;
  }
}

/** One short track piece in the middle of the region. */
function regionEvent(address: RoadRegionAddress): RoadsWorkerRegionEvent {
  const box = roadRegionBox(address.rx, address.rz);
  const x = 0.5 * (box.minX + box.maxX);
  const z = 0.5 * (box.minZ + box.maxZ);
  const spec = roadClass(ROAD_CLASS.track);
  const segment: InfrastructureSegment = {
    profile: INFRASTRUCTURE_PROFILE.carriageway,
    mode: "set",
    priority: spec.priority,
    ax: x,
    az: z,
    bx: x + 20,
    bz: z,
    halfWidth: 1.75,
    reach: 4,
    params: [30, 30, 0, 0, 0, 0, 0],
    key: (address.rx & 0xffff) * 65_536 + (address.rz & 0xffff),
  };
  return {
    type: "region",
    address,
    infrastructure: { key: roadRegionKey(address.layer, address.rx, address.rz), segments: [segment] },
    pieces: [],
    pads: [],
    milliseconds: 1,
  };
}

describe("the road stream controller", () => {
  it("asks for the regions it lacks, nearest first, and installs a frame's arrivals as one change", () => {
    const worker = new FakeRoadsWorker();
    const controller = new RoadStreamController(world, () => worker);
    const observer = { x: 3_000, z: 2_000, velocityX: 0, velocityZ: 0 };
    controller.observe(observer, 0);
    expect(worker.commands[0]!.type).toBe("world");
    const want = worker.lastWant;
    expect(want.map((address) => `${address.layer}:${address.rx}:${address.rz}`))
      .toEqual(roadStreamRegions(observer).map((region) => `${region.layer}:${region.rx}:${region.rz}`));

    const changes: number[] = [];
    controller.onChange((change) => changes.push(change.installed.length));
    const before = infrastructureRegionsVersion(world);
    worker.answer(10);
    // Nothing installs until the frame flushes, and then all ten at once.
    expect(installedInfrastructureRegionKeys(world)).toHaveLength(0);
    const change = controller.flush()!;
    expect(change.installed).toHaveLength(10);
    expect(change.changed).toHaveLength(10);
    expect(infrastructureRegionsVersion(world)).toBe(before + 1);
    expect(changes).toEqual([10]);
    expect(controller.flush()).toBeNull();

    // The next ask leaves out what is installed.
    controller.observe(observer, 1_000);
    expect(worker.lastWant).toHaveLength(want.length - 10);
    expect(worker.lastWant[0]).toEqual(want[10]);
    controller.dispose();
  });

  it("drops regions the observer has left, and takes them back from its cache when it returns", () => {
    const worker = new FakeRoadsWorker();
    const controller = new RoadStreamController(world, () => worker);
    const home = { x: 0, z: 0, velocityX: 0, velocityZ: 0 };
    controller.observe(home, 0);
    const count = worker.answer();
    controller.flush();
    expect(installedInfrastructureRegionKeys(world)).toHaveLength(count);

    // 40 km east: every home region is past the keep margin.
    const away = { x: 40_000, z: 0, velocityX: 0, velocityZ: 0 };
    controller.observe(away, 1_000);
    const leaving = controller.flush()!;
    expect(leaving.removed).toHaveLength(count);
    expect(leaving.installed).toHaveLength(0);
    expect(installedInfrastructureRegionKeys(world)).toHaveLength(0);

    // Back home: what the cache still holds comes back without the worker.
    const asked = worker.commands.length;
    controller.observe(home, 2_000);
    const back = controller.flush()!;
    expect(back.installed.length).toBeGreaterThan(0);
    const wantedAgain = worker.commands.length > asked ? worker.lastWant.length : 0;
    expect(back.installed.length + wantedAgain).toBe(count);
    controller.dispose();
  });

  it("primes: resolves once the regions round the spawn are in, flushing as they come", async () => {
    const worker = new FakeRoadsWorker();
    const controller = new RoadStreamController(world, () => worker);
    const spawn = { x: 500, z: 500, velocityX: 0, velocityZ: 0 };
    let primed = false;
    const done = controller.prime(spawn, 3_000, 60_000).then(() => { primed = true; });
    const near = roadStreamRegions(spawn).filter((region) => region.distance <= 3_000).length;
    worker.answer(near - 1);
    await Promise.resolve();
    expect(primed).toBe(false);
    worker.answer(1);
    await done;
    expect(primed).toBe(true);
    expect(installedInfrastructureRegionKeys(world).length).toBeGreaterThanOrEqual(near);
    expect(near).toBeGreaterThan(4);
    controller.dispose();
  });
});
