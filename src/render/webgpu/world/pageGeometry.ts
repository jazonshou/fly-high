import { worldPageExtentMeters } from "./pageKey";
import type { WorldPageLayout } from "./payload";

/**
 * Page geometry — one number (Phase 0 item 0-2).
 *
 * Four subsystem designs proposed four incompatible page geometries; the
 * rendering plan resolved them (§1.4) to a single layout: height pages store a
 * 256-sample core, every other channel a 128-texel core, and every page of any
 * kind carries a 4-sample gutter. These constants are the ONLY definition of
 * those numbers. `payload.ts`'s WorldPageLayout stays parameterised so tests
 * can construct other layouts; WORLD_PAGE_LAYOUT below is the only one the
 * renderer ships. Do not introduce a 132², 260², or 66² anywhere — the
 * architecture boundary test fails by name if a second geometry appears.
 *
 * The addressing convention, which is the load-bearing part:
 *
 *   - Core sample (row, column) lives at stored index
 *     (row + gutter) * storedEdge + (column + gutter).
 *   - The gutter extends OUTSIDE the page and never renumbers the core:
 *     gutter samples use core coordinates in [-gutter, 0) and
 *     [core, core + gutter).
 *   - The world coordinate of core sample i along an axis is
 *     pageOrigin + i * texelSize, with texelSize = pageExtent / core.
 *
 * This is the same convention Phase 1's tile halo uses with gutter = 1 and
 * Phase 4's page atlas uses with gutter = 4. It is established and tested
 * once, here.
 */

export const WORLD_PAGE_BASE_EXTENT_METERS = 512;
export const WORLD_PAGE_GUTTER = 4;
/** Height core samples per page edge. Stored edge is 264 with the gutter. */
export const WORLD_PAGE_HEIGHT_CORE = 256;
/** Core texels per edge for every non-height channel. Stored edge is 136. */
export const WORLD_PAGE_CHANNEL_CORE = 128;

/** The single canonical layout the renderer ships. */
export const WORLD_PAGE_LAYOUT: WorldPageLayout = Object.freeze({
  extentMeters: WORLD_PAGE_BASE_EXTENT_METERS,
  heightResolution: WORLD_PAGE_HEIGHT_CORE,
  surfaceResolution: WORLD_PAGE_CHANNEL_CORE,
  gutter: WORLD_PAGE_GUTTER,
});

/** Core coordinates addressed by a stored sample; gutter rows/columns are negative or >= core. */
export interface WorldPageCoreCoordinates {
  readonly row: number;
  readonly column: number;
}

function requireCore(core: number): number {
  if (!Number.isSafeInteger(core) || core <= 0) {
    throw new RangeError("Page core resolution must be a positive integer");
  }
  return core;
}

function requireGutter(gutter: number): number {
  if (!Number.isSafeInteger(gutter) || gutter < 0) {
    throw new RangeError("Page gutter must be a non-negative integer");
  }
  return gutter;
}

function requireStoredCoordinate(
  value: number,
  core: number,
  gutter: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < -gutter || value >= core + gutter) {
    throw new RangeError(
      `${label} must be an integer in [${-gutter}, ${core + gutter}) for core ${core}, gutter ${gutter}`,
    );
  }
  return value;
}

/** Samples per stored page edge: the core plus one gutter band on each side. */
export function storedEdge(core: number, gutter: number = WORLD_PAGE_GUTTER): number {
  return requireCore(core) + requireGutter(gutter) * 2;
}

/**
 * Row-major stored index of core sample (row, column). Gutter samples are
 * addressed with the same core coordinates, extended past the page edge:
 * row and column range over [-gutter, core + gutter).
 */
export function coreToStoredIndex(
  row: number,
  column: number,
  core: number,
  gutter: number = WORLD_PAGE_GUTTER,
): number {
  requireCore(core);
  requireGutter(gutter);
  requireStoredCoordinate(row, core, gutter, "Page row");
  requireStoredCoordinate(column, core, gutter, "Page column");
  return (row + gutter) * storedEdge(core, gutter) + (column + gutter);
}

/** Inverse of coreToStoredIndex. */
export function storedIndexToCore(
  index: number,
  core: number,
  gutter: number = WORLD_PAGE_GUTTER,
): WorldPageCoreCoordinates {
  requireCore(core);
  requireGutter(gutter);
  const edge = storedEdge(core, gutter);
  if (!Number.isSafeInteger(index) || index < 0 || index >= edge * edge) {
    throw new RangeError(`Stored index must be an integer in [0, ${edge * edge})`);
  }
  return {
    row: Math.floor(index / edge) - gutter,
    column: (index % edge) - gutter,
  };
}

/**
 * World-space size of one core texel at a level. Level extents follow
 * worldPageExtentMeters, so this agrees with page bounds by construction.
 */
export function pageTexelSizeMeters(level: number, core: number): number {
  requireCore(core);
  return worldPageExtentMeters(level, WORLD_PAGE_BASE_EXTENT_METERS) / core;
}
