import {
  airportDesignator,
  airportSpawnDue,
  getRunwayEnds,
  nearestAirport,
  withAirports,
  type WorldDefinition,
} from "@/src/world";
import type {
  AirportSpawnRequest,
  AirportSpawnResult,
} from "@/src/workers/airportSpawnProtocol";
import type { FlightVisualState } from "./types";

/** The slice of a Worker the controller uses, so tests can drive it synchronously. */
export interface AirportSpawnWorker {
  postMessage(request: AirportSpawnRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent<AirportSpawnResult>) => void): void;
  terminate(): void;
}

export type AirportSpawnWorkerFactory = () => AirportSpawnWorker | null;

/** How often the flight is checked against the spawn trigger. */
export const AIRPORT_SPAWN_CHECK_INTERVAL_MS = 1_000;
/** After a search finds nothing, the aircraft must fly this far before the next one. */
export const AIRPORT_SPAWN_REANCHOR_METERS = 2_000;

const defaultWorkerFactory: AirportSpawnWorkerFactory = () => {
  if (typeof Worker === "undefined") return null;
  return new Worker(new URL("../workers/airportSpawn.worker.ts", import.meta.url), {
    type: "module",
    name: "fly-high-airport-spawn",
  }) as unknown as AirportSpawnWorker;
};

/**
 * The main thread's copy of the world's airport list, and the loop that grows
 * it: once the aircraft is far from every airport, an anchored spawn search
 * runs on its own worker and the runway it finds is installed with
 * `withAirports`. Listeners (the simulation worker, the renderer, the HUD)
 * hear every change once.
 */
export class AirportNetworkController {
  private currentWorld: WorldDefinition;
  private readonly listeners = new Set<(world: WorldDefinition) => void>();
  private worker: AirportSpawnWorker | null = null;
  private workerUnavailable = false;
  private pending: {
    readonly requestId: number;
    readonly world: WorldDefinition;
    readonly x: number;
    readonly z: number;
  } | null = null;
  private nextRequestId = 1;
  private lastCheckMs = Number.NEGATIVE_INFINITY;
  private failedAnchor: { readonly x: number; readonly z: number } | null = null;
  private disposed = false;

  constructor(
    world: WorldDefinition,
    private readonly createWorker: AirportSpawnWorkerFactory = defaultWorkerFactory,
  ) {
    this.currentWorld = world;
  }

  get world(): WorldDefinition {
    return this.currentWorld;
  }

  /** Subscribe to airport-list changes; returns the unsubscribe. */
  onChange(listener: (world: WorldDefinition) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Feed a flight snapshot. Cheap: at most one distance check per second. */
  observe(state: FlightVisualState, nowMs: number): void {
    if (this.disposed || state.crashed) return;
    if (nowMs - this.lastCheckMs < AIRPORT_SPAWN_CHECK_INTERVAL_MS) return;
    this.lastCheckMs = nowMs;
    if (this.pending) return;
    const { x, z } = state.position;
    if (!airportSpawnDue(this.currentWorld, x, z)) return;
    if (
      this.failedAnchor
      && Math.hypot(x - this.failedAnchor.x, z - this.failedAnchor.z) < AIRPORT_SPAWN_REANCHOR_METERS
    ) {
      return;
    }
    const worker = this.ensureWorker();
    if (!worker) return;
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    this.pending = { requestId, world: this.currentWorld, x, z };
    worker.postMessage({
      requestId,
      world: this.currentWorld,
      x,
      z,
      headingRadians: (state.heading * Math.PI) / 180,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.pending = null;
    this.listeners.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): AirportSpawnWorker | null {
    if (this.worker || this.workerUnavailable) return this.worker;
    try {
      this.worker = this.createWorker();
    } catch (error) {
      console.error("Airport spawn worker unavailable", error);
      this.worker = null;
    }
    if (!this.worker) {
      this.workerUnavailable = true;
      return null;
    }
    this.worker.addEventListener("message", (event) => this.handleResult(event.data));
    return this.worker;
  }

  private handleResult(result: AirportSpawnResult): void {
    const searched = this.pending;
    if (this.disposed || !searched || result.requestId !== searched.requestId) return;
    this.pending = null;
    // The list changed while the search ran: its separation checks are stale.
    if (searched.world !== this.currentWorld) return;
    if (!result.airport) {
      this.failedAnchor = { x: searched.x, z: searched.z };
      return;
    }
    this.failedAnchor = null;
    const next = withAirports(this.currentWorld, [...this.currentWorld.airports, result.airport]);
    if (next === this.currentWorld) return;
    this.currentWorld = next;
    for (const listener of this.listeners) listener(next);
  }
}

/** What the HUD shows about the nearest airport. */
export interface NearestAirportInfo {
  readonly ident: string;
  readonly isHome: boolean;
  /** "05/23": the two landing directions. */
  readonly runways: string;
  readonly distanceMeters: number;
  /** Bearing to the airport in whole degrees, 1..360 as on a compass card. */
  readonly bearingDegrees: number;
  /** Runway centre, a little above the pavement: where the marker points. */
  readonly markerX: number;
  readonly markerY: number;
  readonly markerZ: number;
}

export function describeNearestAirport(
  world: WorldDefinition,
  x: number,
  z: number,
): NearestAirportInfo | null {
  const nearest = nearestAirport(world, x, z);
  if (!nearest) return null;
  const [first, second] = getRunwayEnds(nearest.airport);
  const bearing = Math.round((nearest.bearingRadians * 180) / Math.PI) % 360;
  return {
    ident: airportDesignator(world, nearest.airport),
    isHome: nearest.index === 0,
    runways: `${first.designator}/${second.designator}`,
    distanceMeters: nearest.distanceMeters,
    bearingDegrees: bearing === 0 ? 360 : bearing,
    markerX: nearest.airport.centerX,
    markerY: nearest.airport.elevation + 4,
    markerZ: nearest.airport.centerZ,
  };
}
