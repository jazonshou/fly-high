import type { InfrastructureSource } from "./infrastructure";
import { marinaInfrastructure } from "./marinaEarthworks";

/**
 * Every source of infrastructure segments, in composition order (ties in
 * `priority` keep this order). With none, the stage is a no-op everywhere.
 *
 * The home marina's earthworks (`marinaEarthworks.ts`): dredged basin,
 * breakwater, quay apron, car park, slipway, and the `marinaCarPark` anchor.
 */
export const INFRASTRUCTURE_SOURCES: readonly InfrastructureSource[] = Object.freeze([
  marinaInfrastructure,
]);
