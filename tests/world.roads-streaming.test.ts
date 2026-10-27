import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RoadStreamController,
  ROAD_STREAM_CHECK_INTERVAL_MS,
  ROAD_STREAM_FLUSH_SEGMENTS,
  ROAD_STREAM_RETRY_MS,
  type RoadsWorker,
  type RoadStreamChange,
} from "@/src/render/roads/RoadStreamController";
import { RoadStreamRuntime, type RoadStreamConsumers } from "@/src/render/roads/RoadStreamRuntime";
import { WORLD_PAGE_BASE_EXTENT_METERS } from "@/src/render/webgpu/world/pageGeometry";
import type {
  RoadRegionAddress,
  RoadsWorkerCommand,
  RoadsWorkerEvent,
  RoadsWorkerRegionEvent,
} from "@/src/workers/roadsProtocol";
import {
  changeInfrastructureRegions,
  clearInfrastructureRegions,
  infrastructureRegionsVersion,
  installedInfrastructureRegionKeys,
  type InfrastructureChange,
  type InfrastructureSegment,
} from "@/src/world/infrastructure";
import type { InfrastructureRegionsUpdate } from "@/src/world/infrastructureSync";
import { INFRASTRUCTURE_PROFILE } from "@/src/world/infrastructureProfiles";
import { roadClass, ROAD_CLASS } from "@/src/world/roads/roadClasses";
import { roadRegionKey } from "@/src/world/roads/roadInfrastructure";
import { roadLayerWindow, roadRegionBox } from "@/src/world/roads/roadNetwork";
import {
  roadRegionDistance,
  roadStreamRegions,
  ROAD_STREAM_KEEP_MARGIN,
  ROAD_STREAM_LEAD_SECONDS,
  type RoadStreamObserver,
} from "@/src/world/roads/roadStreaming";
import { createWorld } from "@/src/world/world";

/**
 * Which road regions the observer is given, in what order, and the main
 * thread's controller that asks the roads worker for them and installs them
 * into the stage once a frame (`RoadStreamController`), and the renderer's
 * end of it (`RoadStreamRuntime`: who hears a change, in what order, and
 * which late page publications it holds back), against a worker stand-in
 * that answers synchronously; and the roads worker's own answer to a region
 * asked for twice.
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

  /** Post the next `count` regions of the last list not yet posted, each of `pieces` pieces. */
  answer(count = Number.POSITIVE_INFINITY, pieces = 1): number {
    let posted = 0;
    for (const address of this.lastWant) {
      if (posted >= count) break;
      const key = `${address.layer}:${address.rx}:${address.rz}`;
      if (this.answered.has(key)) continue;
      this.answered.add(key);
      this.post(regionEvent(address, pieces));
      posted += 1;
    }
    return posted;
  }

  post(event: RoadsWorkerEvent): void {
    this.listener!({ data: event } as MessageEvent<RoadsWorkerEvent>);
  }
}

/** `pieces` short track pieces in the middle of the region. */
function regionEvent(address: RoadRegionAddress, pieces = 1): RoadsWorkerRegionEvent {
  const box = roadRegionBox(address.rx, address.rz);
  const x = 0.5 * (box.minX + box.maxX);
  const z = 0.5 * (box.minZ + box.maxZ);
  const spec = roadClass(ROAD_CLASS.track);
  const segments = Array.from({ length: pieces }, (_, k): InfrastructureSegment => ({
    profile: INFRASTRUCTURE_PROFILE.carriageway,
    mode: "set",
    priority: spec.priority,
    ax: x + k * 20,
    az: z,
    bx: x + k * 20 + 20,
    bz: z,
    halfWidth: 1.75,
    reach: 4,
    params: [30, 30, 0, 0, 0, 0, 0],
    key: ((address.rx & 0xffff) * 65_536 + (address.rz & 0xffff)) * 1_024 + k,
  }));
  return {
    type: "region",
    address,
    infrastructure: { key: roadRegionKey(address.layer, address.rx, address.rz), segments },
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
    expect(change.infrastructure.rects).toHaveLength(10);
    expect(change.infrastructure.version).toBe(infrastructureRegionsVersion(world));
    expect(infrastructureRegionsVersion(world)).toBe(before + 1);
    expect(changes).toEqual([10]);
    expect(controller.flush()).toBeNull();

    // The next ask leaves out what is installed.
    controller.observe(observer, 1_000);
    expect(worker.lastWant).toHaveLength(want.length - 10);
    expect(worker.lastWant[0]).toEqual(want[10]);
    controller.dispose();
  });

  it("installs at most a flush's worth of segments a frame, and the rest next frame", () => {
    const worker = new FakeRoadsWorker();
    const controller = new RoadStreamController(world, () => worker);
    controller.observe({ x: 0, z: 0, velocityX: 0, velocityZ: 0 }, 0);
    const pieces = Math.ceil(ROAD_STREAM_FLUSH_SEGMENTS / 2.5);
    expect(worker.answer(5, pieces)).toBe(5);
    const sizes: number[] = [];
    for (let change = controller.flush(); change; change = controller.flush()) {
      sizes.push(change.installed.length);
      const segments = change.installed.reduce((sum, event) => sum + event.infrastructure.segments.length, 0);
      expect(segments).toBeLessThanOrEqual(ROAD_STREAM_FLUSH_SEGMENTS);
    }
    expect(sizes).toEqual([2, 2, 1]);
    expect(installedInfrastructureRegionKeys(world)).toHaveLength(5);
    controller.dispose();
  });

  it("scans no regions again for an observer where it was while nothing arrives", () => {
    const worker = new FakeRoadsWorker();
    const controller = new RoadStreamController(world, () => worker);
    const still = { x: 3_000, z: 2_000, velocityX: 0, velocityZ: 0 };
    let nowMs = 0;
    const check = (observer = still) => {
      nowMs += ROAD_STREAM_CHECK_INTERVAL_MS;
      controller.observe(observer, nowMs);
      return controller.flush();
    };
    check();
    expect(controller.regionScans).toBe(1);
    const commands = worker.commands.length;
    for (let k = 0; k < 20; k += 1) expect(check()).toBeNull();
    expect(controller.regionScans).toBe(1);
    expect(worker.commands).toHaveLength(commands);
    // Something arrived: the checks scan until it is installed, and ask for what is left.
    worker.answer(3);
    expect(check()!.installed).toHaveLength(3);
    check();
    const scans = controller.regionScans;
    expect(scans).toBeGreaterThan(1);
    expect(worker.lastWant).toHaveLength(controller.pendingRegions);
    for (let k = 0; k < 5; k += 1) check();
    expect(controller.regionScans).toBe(scans);
    // Moved, however little: scanned.
    check({ ...still, x: still.x + 0.5 });
    expect(controller.regionScans).toBe(scans + 1);
    controller.dispose();
  });

  it("refuses a malformed region as it arrives, and installs the rest", () => {
    const worker = new FakeRoadsWorker();
    const controller = new RoadStreamController(world, () => worker);
    controller.observe({ x: 0, z: 0, velocityX: 0, velocityZ: 0 }, 0);
    const [bad, good] = worker.lastWant;
    const broken = regionEvent(bad!);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      worker.post({
        ...broken,
        infrastructure: { ...broken.infrastructure, segments: [{ ...broken.infrastructure.segments[0]!, halfWidth: -1 }] },
      });
      // A first failure is asked again: a warning, not yet an error.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("refused");
    } finally {
      warn.mockRestore();
    }
    worker.post(regionEvent(good!));
    expect(controller.flush()!.installed.map((event) => event.address)).toEqual([good]);
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

  it("keeps a region that lands after the observer has left it, and takes it back from the cache on return", () => {
    const worker = new FakeRoadsWorker();
    const controller = new RoadStreamController(world, () => worker);
    const home = { x: 0, z: 0, velocityX: 0, velocityZ: 0 };
    controller.observe(home, 0);
    const asked = worker.lastWant.slice();
    expect(asked.length).toBeGreaterThan(0);
    controller.observe({ x: 40_000, z: 0, velocityX: 0, velocityZ: 0 }, 1_000);
    // Home's regions land only now, the observer 40 km on: none is installed.
    for (const address of asked) worker.post(regionEvent(address));
    expect(controller.flush()).toBeNull();
    expect(installedInfrastructureRegionKeys(world)).toHaveLength(0);

    // Back home: the cache holds what it can, and only the rest is asked for again.
    const commands = worker.commands.length;
    controller.observe(home, 2_000);
    const back = controller.flush()!;
    expect(back.installed.length).toBeGreaterThan(0);
    const again = worker.commands.length > commands ? worker.lastWant : [];
    const keyOf = (address: RoadRegionAddress) => roadRegionKey(address.layer, address.rx, address.rz);
    const installed = new Set(back.installed.map((event) => event.infrastructure.key));
    expect(again.some((address) => installed.has(keyOf(address)))).toBe(false);
    expect(back.installed.length + again.length).toBe(asked.length);
    expect(controller.pendingRegions).toBe(again.length);
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

describe("a road region that fails", () => {
  const home = { x: 0, z: 0, velocityX: 0, velocityZ: 0 };
  const away = { x: 40_000, z: 0, velocityX: 0, velocityZ: 0 };
  const keyOf = (address: RoadRegionAddress) => roadRegionKey(address.layer, address.rx, address.rz);
  const asks = (worker: FakeRoadsWorker) => worker.commands.filter((command) => command.type === "want").length;
  const failure = (address: RoadRegionAddress, message: string): RoadsWorkerEvent => ({ type: "error", address, message });

  function quietConsole() {
    return {
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  }

  afterEach(() => vi.restoreAllMocks());

  it("changes nothing while every region succeeds: one ask per change in what is missing, never a re-send", () => {
    const { warn, error } = quietConsole();
    const worker = new FakeRoadsWorker();
    const controller = new RoadStreamController(world, () => worker);
    const all = roadStreamRegions(home).map((region) => roadRegionKey(region.layer, region.rx, region.rz));
    expect(all.length).toBeGreaterThan(60);
    let nowMs = 0;
    for (let round = 0; round < 6; round += 1) {
      // Well past any back-off, checked every interval.
      for (const end = nowMs + 3 * ROAD_STREAM_RETRY_MS; nowMs < end; nowMs += 250) controller.observe(home, nowMs);
      expect(asks(worker)).toBe(round + 1);
      expect(worker.lastWant.map(keyOf)).toEqual(all.slice(10 * round));
      expect(controller.pendingRegions).toBe(all.length - 10 * round);
      worker.answer(10);
      controller.flush();
    }
    expect(worker.commands).toHaveLength(1 + 6);
    expect(controller.pendingRegions).toBe(all.length - 60);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("is asked again after the back-off, and given up at the second failure: one error, no longer pending", () => {
    const { warn, error } = quietConsole();
    const worker = new FakeRoadsWorker();
    const controller = new RoadStreamController(world, () => worker);
    controller.observe(home, 0);
    const asked = worker.lastWant.slice();
    const failing = asked[0]!;
    const key = keyOf(failing);

    worker.post(failure(failing, "lost the layout"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(key);
    // The same ask answered twice (a want re-sent before the first answer landed) counts once.
    worker.post(failure(failing, "lost the layout"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    // Still to come through the back-off, but not asked of the worker.
    expect(controller.pendingRegions).toBe(asked.length);
    controller.observe(home, ROAD_STREAM_RETRY_MS / 2);
    expect(worker.lastWant.map(keyOf)).toEqual(asked.slice(1).map(keyOf));
    expect(controller.pendingRegions).toBe(asked.length);

    // The back-off over: asked again, once.
    controller.observe(home, ROAD_STREAM_RETRY_MS);
    expect(worker.lastWant.map(keyOf)).toEqual(asked.map(keyOf));
    const retries = asks(worker);
    controller.observe(home, ROAD_STREAM_RETRY_MS + 500);
    expect(asks(worker)).toBe(retries);

    worker.post(failure(failing, "lost the layout again"));
    expect(error).toHaveBeenCalledTimes(1);
    const message = String(error.mock.calls[0]![0]);
    expect(message).toContain(key);
    expect(message).toContain("lost the layout again");
    expect(controller.pendingRegions).toBe(asked.length - 1);
    // Given up: no longer asked, waited on, or reported again.
    worker.post(failure(failing, "lost the layout again"));
    for (let nowMs = 3_000; nowMs <= 12_000; nowMs += 250) controller.observe(home, nowMs);
    expect(worker.lastWant.map(keyOf)).toEqual(asked.slice(1).map(keyOf));
    expect(error).toHaveBeenCalledTimes(1);
    worker.answer();
    controller.flush();
    expect(controller.pendingRegions).toBe(0);
    expect(installedInfrastructureRegionKeys(world)).toHaveLength(asked.length - 1);
    controller.dispose();
  });

  it("recovers on the retry when the failure passes", () => {
    const { warn, error } = quietConsole();
    const worker = new FakeRoadsWorker();
    const controller = new RoadStreamController(world, () => worker);
    controller.observe(home, 0);
    const failing = worker.lastWant[0]!;
    worker.post(failure(failing, "worker busy"));
    controller.observe(home, ROAD_STREAM_RETRY_MS);
    worker.answer();
    controller.flush();
    expect(installedInfrastructureRegionKeys(world)).toContain(keyOf(failing));
    expect(controller.pendingRegions).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("given up, gets one more try when the window has left it and come back", () => {
    const { error } = quietConsole();
    const worker = new FakeRoadsWorker();
    const controller = new RoadStreamController(world, () => worker);
    controller.observe(home, 0);
    const failing = worker.lastWant[0]!;
    const key = keyOf(failing);
    worker.post(failure(failing, "first"));
    controller.observe(home, ROAD_STREAM_RETRY_MS);
    worker.post(failure(failing, "second"));
    expect(error).toHaveBeenCalledTimes(1);

    // Away and back: asked at once, and one failure gives it up again.
    controller.observe(away, 5_000);
    expect(worker.lastWant.map(keyOf)).not.toContain(key);
    controller.observe(home, 6_000);
    expect(worker.lastWant[0]).toEqual(failing);
    expect(controller.pendingRegions).toBeGreaterThan(0);
    worker.post(failure(failing, "third"));
    expect(error).toHaveBeenCalledTimes(2);
    controller.observe(home, 10_000);
    expect(worker.lastWant.map(keyOf)).not.toContain(key);

    // Away and back again, and this time it comes.
    controller.observe(away, 11_000);
    controller.observe(home, 12_000);
    expect(worker.lastWant[0]).toEqual(failing);
    worker.post(regionEvent(failing));
    expect(controller.flush()!.installed.map((event) => event.infrastructure.key)).toContain(key);
    expect(error).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("does not hold priming once given up", async () => {
    quietConsole();
    const worker = new FakeRoadsWorker();
    const controller = new RoadStreamController(world, () => worker);
    const spawn = { x: 500, z: 500, velocityX: 0, velocityZ: 0 };
    let primed = false;
    const done = controller.prime(spawn, 3_000, 60_000).then(() => { primed = true; });
    const near = roadStreamRegions(spawn).filter((region) => region.distance <= 3_000).length;
    const [failing, ...rest] = worker.lastWant.slice(0, near);
    worker.post(failure(failing!, "first"));
    for (const address of rest) worker.post(regionEvent(address));
    await Promise.resolve();
    expect(primed).toBe(false);
    controller.observe(spawn, ROAD_STREAM_RETRY_MS);
    expect(worker.lastWant[0]).toEqual(failing);
    worker.post(failure(failing!, "second"));
    await done;
    expect(primed).toBe(true);
    controller.dispose();
  });
});

describe("the renderer's road stream runtime", () => {
  /** Every consumer call, in order, with what it was given. */
  function recordingConsumers() {
    const calls: { readonly to: string; readonly version: number; readonly update?: InfrastructureRegionsUpdate }[] = [];
    const drawn: { readonly install: readonly string[]; readonly remove: readonly string[] }[] = [];
    const consumers: RoadStreamConsumers = {
      publishInfrastructure: (update) => calls.push({ to: "simulation", version: update.version, update }),
      detailInfrastructureChanged: (update, change: InfrastructureChange) => {
        expect(change.version).toBe(update.version);
        calls.push({ to: "detail", version: change.version, update });
      },
      groundCoverInfrastructureChanged: (change) => calls.push({ to: "groundCover", version: change.version }),
      infrastructureChanged: (change) => calls.push({ to: "terrain", version: change.version }),
      roadSurfaceChanged: (install, remove) => {
        calls.push({ to: "drawing", version: -1 });
        drawn.push({ install: install.map((region) => region.key), remove: [...remove] });
      },
    };
    return { calls, consumers, drawn };
  }

  /** The level-0 page under the middle of a region's track, as published at `version`. */
  function pageUnder(address: RoadRegionAddress, version: number | undefined) {
    const box = roadRegionBox(address.rx, address.rz);
    const x = 0.5 * (box.minX + box.maxX);
    const z = 0.5 * (box.minZ + box.maxZ);
    return {
      level: 0,
      tileX: Math.floor(x / WORLD_PAGE_BASE_EXTENT_METERS),
      tileZ: Math.floor(z / WORLD_PAGE_BASE_EXTENT_METERS),
      heights: new Float32Array(0),
      ...(version === undefined ? {} : { infrastructureVersion: version }),
    };
  }

  it("tells the workers first, then the ground cover, the terrain and the drawing, each change once and whole", () => {
    const worker = new FakeRoadsWorker();
    const runtime = new RoadStreamRuntime(world, () => worker);
    const { calls, consumers, drawn } = recordingConsumers();
    runtime.setConsumers(consumers);
    // Attaching catches the workers and the drawing up with the whole set (here, none).
    expect(calls.map((call) => call.to)).toEqual(["simulation", "detail", "drawing"]);
    expect(drawn).toEqual([{ install: [], remove: [] }]);
    drawn.length = 0;
    expect(calls[0]!.update).toMatchObject({ reset: true, install: [], remove: [] });
    calls.length = 0;
    const observer = { x: 3_000, z: 2_000, velocityX: 0, velocityZ: 0 };
    expect(runtime.update(observer, 0)).toBeNull();
    const asked = worker.lastWant.length;
    expect(runtime.pendingRegions).toBe(asked);

    worker.answer(3);
    // Arrived but not installed: still pending, and nobody told yet.
    expect(runtime.pendingRegions).toBe(asked);
    expect(calls).toHaveLength(0);
    const change = runtime.update(observer, 1_000)!;
    expect(runtime.pendingRegions).toBe(asked - 3);
    const version = change.infrastructure.version;
    expect(calls.map((call) => call.to)).toEqual(["simulation", "detail", "groundCover", "terrain", "drawing"]);
    expect(calls.filter((call) => call.to !== "drawing").every((call) => call.version === version)).toBe(true);
    // The drawing gets the regions' pieces, pads and rails under the same keys.
    expect(drawn).toEqual([{ install: change.installed.map((event) => event.infrastructure.key), remove: [] }]);
    // The workers get the regions themselves, as an increment on what they hold.
    const update = calls[0]!.update!;
    expect(update).toEqual({
      version,
      reset: false,
      install: change.installed.map((event) => event.infrastructure),
      remove: [],
    });
    expect(calls[1]!.update).toBe(update);

    // Leaving: the removal reaches them the same way.
    calls.length = 0;
    const leaving = runtime.update({ x: 60_000, z: 0, velocityX: 0, velocityZ: 0 }, 2_000)!;
    expect(leaving.removed).toHaveLength(3);
    expect(calls.map((call) => call.to)).toEqual(["simulation", "detail", "groundCover", "terrain", "drawing"]);
    expect(calls[0]!.update!.remove).toEqual(leaving.removed);
    expect(drawn.at(-1)).toEqual({ install: [], remove: leaving.removed });
    runtime.dispose();
  });

  it("catches the workers up with the whole set when its consumers attach after changes", () => {
    const worker = new FakeRoadsWorker();
    const runtime = new RoadStreamRuntime(world, () => worker);
    const observer = { x: 3_000, z: 2_000, velocityX: 0, velocityZ: 0 };
    runtime.update(observer, 0);
    worker.answer(4);
    // Startup: installed with nobody attached, only logged.
    const change = runtime.update(observer, 1_000)!;
    const { calls, consumers, drawn } = recordingConsumers();
    runtime.setConsumers(consumers);
    expect(calls.map((call) => call.to)).toEqual(["simulation", "detail", "drawing"]);
    expect([...drawn[0]!.install].sort()).toEqual(change.installed.map((event) => event.infrastructure.key).sort());
    const snapshot = calls[0]!.update!;
    expect(snapshot.version).toBe(change.infrastructure.version);
    expect(snapshot.reset).toBe(true);
    expect(snapshot.install.map((region) => region.key).sort())
      .toEqual(change.installed.map((event) => event.infrastructure.key).sort());
    expect(calls[1]!.update).toBe(snapshot);
    runtime.dispose();
  });

  it("drops what a jump leaves after its installs, a flush's share at a time, each within its bound, to the same set as one big change", () => {
    const worker = new FakeRoadsWorker();
    const runtime = new RoadStreamRuntime(world, () => worker);
    const held = { simulation: new Set<string>(), detail: new Set<string>(), drawing: new Set<string>() };
    const follow = (set: Set<string>, install: readonly string[], remove: readonly string[], reset = false) => {
      if (reset) set.clear();
      for (const key of remove) set.delete(key);
      for (const key of install) set.add(key);
    };
    let terrain: InfrastructureChange[] = [];
    runtime.setConsumers({
      publishInfrastructure: (update) => follow(held.simulation, update.install.map((region) => region.key), update.remove, update.reset),
      detailInfrastructureChanged: (update) => follow(held.detail, update.install.map((region) => region.key), update.remove, update.reset),
      groundCoverInfrastructureChanged: () => {},
      infrastructureChanged: (change) => terrain.push(change),
      roadSurfaceChanged: (install, remove) => follow(held.drawing, install.map((region) => region.key), remove),
    });
    const changes: RoadStreamChange[] = [];
    runtime.stream.onChange((change) => changes.push(change));
    const segmentsOf = (events: readonly RoadsWorkerRegionEvent[]) => events.reduce((sum, event) => sum + event.infrastructure.segments.length, 0);
    let now = 0;
    const frame = (observer: RoadStreamObserver) => {
      now += 16;
      return runtime.update(observer, now);
    };
    // Home: every region of 60 segments, so a flush installs six.
    const home = { x: 0, z: 0, velocityX: 0, velocityZ: 0 };
    frame(home);
    worker.answer(Number.POSITIVE_INFINITY, 60);
    while (frame(home)) { /* installing */ }
    const homeEvents = new Map(runtime.stream.installedRegions);

    // The perf flight's 9 km jump: what it leaves goes in the order it left
    // (install order), installs first, one at least every flush.
    const away = { x: 9_000, z: 0, velocityX: 0, velocityZ: 0 };
    const kept = new Set(roadStreamRegions(away, ROAD_STREAM_KEEP_MARGIN).map((region) => roadRegionKey(region.layer, region.rx, region.rz)));
    const left = [...homeEvents.keys()].filter((key) => !kept.has(key));
    expect(left.length).toBeGreaterThan(20);
    changes.length = 0;
    terrain = [];
    now += ROAD_STREAM_CHECK_INTERVAL_MS;
    runtime.stream.observe(away, now);
    // Left, and not dropped yet: still pending, so a capture waits for them.
    expect(runtime.pendingRegions).toBe(worker.lastWant.length + left.length);
    worker.answer(Number.POSITIVE_INFINITY, 60);
    let flushes = 0;
    const droppedAt = new Map<string, number>();
    for (let change = frame(away); change; change = frame(away)) {
      flushes += 1;
      const installed = segmentsOf(change.installed);
      const removed = segmentsOf(change.removed.map((key) => homeEvents.get(key)!));
      expect(change.installed.length === 1 || installed <= ROAD_STREAM_FLUSH_SEGMENTS).toBe(true);
      expect(change.removed.length <= 1 || installed + removed <= ROAD_STREAM_FLUSH_SEGMENTS).toBe(true);
      for (const key of change.removed) droppedAt.set(key, flushes);
    }
    expect([...droppedAt.keys()]).toEqual(left);
    left.forEach((key, k) => expect(droppedAt.get(key)!).toBeLessThanOrEqual(k + 1));
    // Installs and drops shared flushes: the drops were spread, not one change.
    expect(changes.filter((change) => change.installed.length > 0 && change.removed.length > 0).length).toBeGreaterThan(1);
    expect(runtime.pendingRegions).toBe(0);

    // Every copy ends on the set one big change would leave, and the terrain
    // was told of every bin it would have been told of.
    const end = new Set(installedInfrastructureRegionKeys(world));
    expect(end).toEqual(new Set([...homeEvents.keys()].filter((key) => kept.has(key))
      .concat(roadStreamRegions(away).map((region) => roadRegionKey(region.layer, region.rx, region.rz)))));
    expect(held.simulation).toEqual(end);
    expect(held.detail).toEqual(end);
    expect(held.drawing).toEqual(end);
    const arrivals = changes.flatMap((change) => change.installed.map((event) => event.infrastructure));
    clearInfrastructureRegions();
    changeInfrastructureRegions(world, [...homeEvents.values()].map((event) => event.infrastructure));
    const whole = changeInfrastructureRegions(world, arrivals, left)!;
    expect(new Set(installedInfrastructureRegionKeys(world))).toEqual(end);
    const union = (pick: (change: InfrastructureChange) => ReadonlySet<number>) => new Set(terrain.flatMap((change) => [...pick(change)]));
    expect(union((change) => change.bins)).toEqual(whole.bins);
    expect(union((change) => change.plantBins)).toEqual(whole.plantBins);
    const rects = (list: readonly InfrastructureChange[]) => list.flatMap((change) => change.rects.map((rect) => JSON.stringify(rect))).sort();
    expect(rects(terrain)).toEqual(rects([whole]));
    // One change per flush, each its own version, in order.
    expect(terrain.map((change) => change.version)).toEqual(changes.map((change) => change.infrastructure.version));
    terrain.forEach((change, k) => expect(change.version).toBe(terrain[0]!.version + k));
    runtime.dispose();
  });

  it("holds back a page baked before a change that reaches it, and only that page", () => {
    const worker = new FakeRoadsWorker();
    const runtime = new RoadStreamRuntime(world, () => worker);
    const observer = { x: 3_000, z: 2_000, velocityX: 0, velocityZ: 0 };
    runtime.update(observer, 0);
    // Two regions apart, so neither change reaches the other's pages.
    const first = worker.lastWant[0]!;
    const second = worker.lastWant.find((address) => address.rx !== first.rx && address.rz !== first.rz)!;
    const before = infrastructureRegionsVersion(world);
    // No consumers yet (startup's priming): the change is still logged.
    worker.post(regionEvent(first!));
    const change = runtime.update(observer, 16)!;
    expect(change.infrastructure.version).toBe(before + 1);

    // Baked before the change, under the road: held back. Baked after it, or
    // never against a streamed region, or far from it: published.
    expect(runtime.holdsBack(pageUnder(first!, before))).toBe(true);
    expect(runtime.holdsBack(pageUnder(first!, before + 1))).toBe(false);
    expect(runtime.holdsBack(pageUnder(first!, undefined))).toBe(false);
    const far = pageUnder(first!, before);
    expect(runtime.holdsBack({ ...far, tileX: far.tileX + 40 })).toBe(false);

    // A second change elsewhere leaves the first road's later pages alone.
    worker.post(regionEvent(second!));
    runtime.update(observer, 1_000);
    expect(runtime.holdsBack(pageUnder(first!, before + 1))).toBe(false);
    expect(runtime.holdsBack(pageUnder(second!, before + 1))).toBe(true);
    runtime.dispose();
  });
});

describe("the roads worker", () => {
  it("answers a region asked for again soon after from the answer it posted, never staying silent", async () => {
    vi.resetModules();
    const posted: RoadsWorkerEvent[] = [];
    let listener: ((event: MessageEvent<RoadsWorkerCommand>) => void) | null = null;
    vi.stubGlobal("self", {
      addEventListener: (_type: string, handler: (event: MessageEvent<RoadsWorkerCommand>) => void) => {
        listener = handler;
      },
      postMessage: (event: RoadsWorkerEvent) => posted.push(event),
    });
    try {
      await import("@/src/workers/roads.worker");
    } finally {
      vi.unstubAllGlobals();
    }
    const send = (command: RoadsWorkerCommand) => listener!({ data: command } as MessageEvent<RoadsWorkerCommand>);
    const until = async (done: () => boolean) => {
      for (let k = 0; k < 2_000 && !done(); k += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(done()).toBe(true);
    };
    // A region far out at sea: no roads, so cheap to lay.
    const address: RoadRegionAddress = { layer: "track", rx: 400, rz: 400 };
    send({ type: "world", world });
    send({ type: "want", regions: [address] });
    await until(() => posted.length === 1);
    expect(posted[0]!.type).toBe("region");
    // Asked again (the main thread let the first answer go): the same answer, not silence and not a rebuild.
    send({ type: "want", regions: [address] });
    await until(() => posted.length === 2);
    expect(posted[1]).toBe(posted[0]);
  });
});
