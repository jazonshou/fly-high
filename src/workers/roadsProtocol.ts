import type { WorldDefinition } from "@/src/world";
import type { InfrastructureRegion } from "@/src/world/infrastructure";
import type { RoadPad, RoadPiece } from "@/src/world/roads/roadNetwork";
import type { RoadStreamLayer } from "@/src/world/roads/roadStreaming";

/**
 * The roads worker (`roads.worker.ts`): the road network generated off the
 * main thread, one region at a time, nearest the observer first
 * (`RoadStreamController` keeps the list). Each region comes back as the
 * stage's streamed region and the pieces and pads it was laid out from (for
 * the ribbons and the guardrails). A settlements region comes back the same
 * way, its buildings in the stage region's `structures` and no pieces or
 * pads of its own.
 */

export interface RoadRegionAddress {
  readonly layer: RoadStreamLayer;
  readonly rx: number;
  readonly rz: number;
}

export type RoadsWorkerCommand =
  /** The world whose terrain the network is laid on (its airports do not matter). */
  | { readonly type: "world"; readonly world: WorldDefinition }
  /**
   * The regions wanted and not yet received, most urgent first: replaces the
   * last list. A region already generated is not sent again.
   */
  | { readonly type: "want"; readonly regions: readonly RoadRegionAddress[] };

export interface RoadsWorkerRegionEvent {
  readonly type: "region";
  readonly address: RoadRegionAddress;
  readonly infrastructure: InfrastructureRegion;
  readonly pieces: readonly RoadPiece[];
  readonly pads: readonly RoadPad[];
  /** Generation time in the worker, milliseconds. */
  readonly milliseconds: number;
}

export type RoadsWorkerEvent =
  | RoadsWorkerRegionEvent
  | { readonly type: "error"; readonly address: RoadRegionAddress | null; readonly message: string };

export function roadRegionAddressKey(address: RoadRegionAddress): string {
  return `${address.layer}:${address.rx}:${address.rz}`;
}
