/// <reference lib="webworker" />

import { findSpawnedAirport } from "@/src/world";
import type { AirportSpawnRequest, AirportSpawnResult } from "./airportSpawnProtocol";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.addEventListener("message", (event: MessageEvent<AirportSpawnRequest>) => {
  const { requestId, world, x, z, headingRadians } = event.data;
  let airport: AirportSpawnResult["airport"] = null;
  try {
    for (let attempt = 0; ; attempt += 1) {
      const result = findSpawnedAirport(world, x, z, headingRadians, attempt);
      if (result === "exhausted") break;
      if (result) {
        airport = result;
        break;
      }
    }
  } catch (error) {
    console.error("Airport spawn search failed", error);
  }
  workerScope.postMessage({ requestId, airport } satisfies AirportSpawnResult);
});
