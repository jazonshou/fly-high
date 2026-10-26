import type { InfrastructureSource } from "./infrastructure";

/**
 * Every source of infrastructure segments, in composition order (ties in
 * `priority` keep this order). Empty until a feature adds one; the stage is
 * then a no-op everywhere.
 */
export const INFRASTRUCTURE_SOURCES: readonly InfrastructureSource[] = Object.freeze([]);
