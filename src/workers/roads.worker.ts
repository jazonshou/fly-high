/// <reference lib="webworker" />

import type { WorldDefinition } from "@/src/world";
import { roadRegionInfrastructure } from "@/src/world/roads/roadInfrastructure";
import { roadNetworkFor } from "@/src/world/roads/roadNetwork";
import {
  roadRegionAddressKey,
  type RoadRegionAddress,
  type RoadsWorkerCommand,
  type RoadsWorkerEvent,
} from "./roadsProtocol";

/**
 * The roads worker: one region per task, so a new `want` list (the observer
 * moved) reorders the queue between regions. The network memoises every
 * road's geometry, so a region asked for again (the observer came back after
 * the main thread dropped it) costs only its layout.
 */

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

let world: WorldDefinition | null = null;
let queue: RoadRegionAddress[] = [];
let scheduled = false;
/**
 * Regions posted lately, by address key: a `want` list sent while one was on
 * its way still names it, and is not a request to build it twice.
 */
const recent = new Map<string, number>();
const RECENT_MS = 10_000;

function post(event: RoadsWorkerEvent): void {
  workerScope.postMessage(event);
}

function schedule(): void {
  if (scheduled || queue.length === 0 || !world) return;
  scheduled = true;
  setTimeout(step, 0);
}

function step(): void {
  scheduled = false;
  const current = world;
  if (!current) return;
  const address = queue.shift();
  if (!address) return;
  const key = roadRegionAddressKey(address);
  const started = performance.now();
  const posted = recent.get(key);
  if (posted !== undefined && started - posted < RECENT_MS) {
    schedule();
    return;
  }
  try {
    const region = roadNetworkFor(current).region(address.layer, address.rx, address.rz);
    const infrastructure = roadRegionInfrastructure(current, region);
    post({
      type: "region",
      address,
      infrastructure,
      pieces: region.pieces,
      pads: region.pads,
      milliseconds: performance.now() - started,
    });
    recent.set(key, performance.now());
    for (const [other, at] of recent) {
      if (started - at >= RECENT_MS) recent.delete(other);
    }
  } catch (error) {
    post({ type: "error", address, message: error instanceof Error ? error.message : String(error) });
  }
  schedule();
}

workerScope.addEventListener("message", (event: MessageEvent<RoadsWorkerCommand>) => {
  const command = event.data;
  if (command.type === "world") {
    world = command.world;
    queue = [];
    recent.clear();
    return;
  }
  queue = command.regions.slice();
  schedule();
});
