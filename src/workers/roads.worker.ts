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
 * Regions posted lately, by address key, and when: a `want` list sent while
 * one was on its way still names it, and is not a request to build it twice.
 * It is answered all the same, from the event already posted: the main
 * thread may have let that one go (the observer left it before it landed),
 * and a request it never hears back on stays pending for good.
 */
const recent = new Map<string, { readonly at: number; readonly event: RoadsWorkerEvent }>();
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
  if (posted !== undefined && started - posted.at < RECENT_MS) {
    post(posted.event);
    schedule();
    return;
  }
  try {
    const network = roadNetworkFor(current);
    const region = network.region(address.layer, address.rx, address.rz);
    const infrastructure = roadRegionInfrastructure(network, region);
    const event: RoadsWorkerEvent = {
      type: "region",
      address,
      infrastructure,
      pieces: region.pieces,
      pads: region.pads,
      milliseconds: performance.now() - started,
    };
    post(event);
    recent.set(key, { at: performance.now(), event });
    for (const [other, { at }] of recent) {
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
