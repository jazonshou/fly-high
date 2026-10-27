import { terrainPageAirportDomain, type TerrainMutableWorldRect } from "@/src/render/webgpu/terrain/AirportReach";
import type { WorldDefinition } from "@/src/world";
import type { InfrastructureChange } from "@/src/world/infrastructure";
import { InfrastructureChangeLog, type InfrastructureRegionsUpdate } from "@/src/world/infrastructureSync";
import type { RoadStreamObserver } from "@/src/world/roads/roadStreaming";
import type { TerrainPagePublication } from "@/src/workers/terrainAuthority";
import {
  RoadStreamController,
  type RoadsWorkerFactory,
  type RoadStreamChange,
} from "./RoadStreamController";

/** Everything that copies or bakes the ground, told of each change to the streamed roads. */
export interface RoadStreamConsumers {
  /** The terrain pages: rebuilt in place where the change reaches (`TerrainClipmapSystem.infrastructureChanged`). */
  infrastructureChanged(change: InfrastructureChange): void;
  /** The detail runtime: its worker's copy, and the cells the change reaches. */
  detailInfrastructureChanged(update: InfrastructureRegionsUpdate, change: InfrastructureChange): void;
  /** The ground cover's tiles the change reaches. */
  groundCoverInfrastructureChanged(change: InfrastructureChange): void;
  /** The simulation worker's copy, when one is attached. */
  publishInfrastructure(update: InfrastructureRegionsUpdate): void;
}

/** Within this of the start, the roads are in before the first page bakes. */
export const ROAD_PRIME_RADIUS_METERS = 3_000;

/** How long startup waits for them at most; later ones rebuild their pages in place. */
export const ROAD_PRIME_TIMEOUT_MS = 4_000;

/**
 * The renderer's end of the streamed roads: the stream controller, the order
 * its changes reach the consumers in, and the log a late page publication is
 * checked against.
 *
 * Order is the whole contract. A change reaches the simulation worker and the
 * detail worker FIRST, posted on the ports their ground arrives on, then the
 * terrain, whose rebuilt pages are published after it; a page batch
 * dispatched before the change and published after it is held back
 * (`holdsBack`) — the terrain rebuilds that page anyway, and the workers have
 * already dropped their copies of it.
 */
export class RoadStreamRuntime {
  readonly log = new InfrastructureChangeLog();
  private readonly controller: RoadStreamController;
  private readonly domain: TerrainMutableWorldRect = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
  private consumers: RoadStreamConsumers | null = null;

  constructor(world: WorldDefinition, createWorker?: RoadsWorkerFactory) {
    this.controller = new RoadStreamController(world, createWorker);
    this.controller.onChange((change) => this.handleChange(change));
  }

  /**
   * Who hears each change from here on. Before any is attached (startup's
   * `prime`, ahead of the first bake) a change is only logged: every consumer
   * built afterwards reads the stage as it then is, and its worker starts
   * from the whole set (`infrastructureRegionsSnapshot`).
   */
  setConsumers(consumers: RoadStreamConsumers | null): void {
    this.consumers = consumers;
  }

  /** Regions still to come or to install (`RoadStreamController.pendingRegions`). */
  get pendingRegions(): number {
    return this.controller.pendingRegions;
  }

  /** Observation only: the controller, for diagnostics and tests. */
  get stream(): RoadStreamController {
    return this.controller;
  }

  /** Hold startup until the roads round (x, z) are installed, or the timeout. */
  prime(x: number, z: number): Promise<void> {
    return this.controller.prime(
      { x, z, velocityX: 0, velocityZ: 0 },
      ROAD_PRIME_RADIUS_METERS,
      ROAD_PRIME_TIMEOUT_MS,
    );
  }

  /** Once a frame, before the terrain updates: ask for what the observer needs, install what came. */
  update(observer: RoadStreamObserver, nowMs: number): RoadStreamChange | null {
    this.controller.observe(observer, nowMs);
    return this.controller.flush();
  }

  /**
   * Whether a terrain page publication describes ground a later change has
   * replaced: the terrain is rebuilding it, so it must not reach a consumer.
   */
  holdsBack(page: TerrainPagePublication): boolean {
    if (page.infrastructureVersion === undefined) return false;
    const domain = terrainPageAirportDomain({ level: page.level, x: page.tileX, z: page.tileZ }, this.domain);
    return this.log.touchedSince(page.infrastructureVersion, domain);
  }

  setWorld(world: WorldDefinition): void {
    this.controller.setWorld(world);
  }

  dispose(): void {
    this.consumers = null;
    this.controller.dispose();
  }

  private handleChange(change: RoadStreamChange): void {
    const infrastructure = change.infrastructure;
    this.log.record(infrastructure);
    const consumers = this.consumers;
    if (!consumers) return;
    const update: InfrastructureRegionsUpdate = {
      version: infrastructure.version,
      reset: false,
      install: change.installed.map((event) => event.infrastructure),
      remove: change.removed,
    };
    consumers.publishInfrastructure(update);
    consumers.detailInfrastructureChanged(update, infrastructure);
    consumers.groundCoverInfrastructureChanged(infrastructure);
    consumers.infrastructureChanged(infrastructure);
  }
}
