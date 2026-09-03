import {
  getAirportInfluence,
  TERRAIN_NORMAL_SAMPLE_DISTANCE,
  type TerrainSample,
  type WorldDefinition,
} from "@/src/world";
import {
  TERRAIN_READBACK_RING_CAPACITY,
  TerrainAuthority,
} from "@/src/workers/terrainAuthority";
import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_HEIGHT_CORE,
} from "../world/pageGeometry";
import type { TerrainAuxPagePublication } from "./TerrainPageAtlas";

export interface TerrainConsumerHeightAuthority {
  sampleHeight(x: number, z: number, analyticHeight?: number): number | null;
  /** Final-page signed distance; null means the neutral legacy density law. */
  sampleShoreDistance?(x: number, z: number): number | null;
  /** `6-6`: final-page soil depth in metres; null means the 2-15 stand-in. */
  sampleSoilDepth?(x: number, z: number): number | null;
}

export type TerrainConsumerTerrainSample = TerrainSample & {
  readonly shoreDistanceMeters?: number;
  readonly soilDepthMeters?: number;
};

export type TerrainConsumerSample = (
  worldX: number,
  worldZ: number,
) => TerrainConsumerTerrainSample;

interface RetainedAuxPage extends TerrainAuxPagePublication {
  sequence: number;
  active: boolean;
}

/** The two published aux fields; they share one addressing implementation. */
type AuxChannel = "shore" | "soil";

interface RetainedHeightPageAddress {
  tileX: number;
  tileZ: number;
  sequence: number;
}

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function requireSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer`);
  return value;
}

/**
 * Main/detail ecology authority. Heights retain the canonical worker-safe
 * L0 -> macro ladder; this subclass adds the final-page hydrology field that
 * drives the riparian density law. Aux pages deliberately never enter the
 * simulation protocol.
 */
export class TerrainConsumerAuthority extends TerrainAuthority {
  private readonly auxPages: Array<RetainedAuxPage | null> = Array.from(
    { length: TERRAIN_READBACK_RING_CAPACITY },
    () => null,
  );
  private readonly heightPageAddresses: Array<RetainedHeightPageAddress | null> = Array.from(
    { length: TERRAIN_READBACK_RING_CAPACITY },
    () => null,
  );
  private auxSequence = 0;
  private heightSequence = 0;
  private auxPageCount = 0;

  get publishedAuxPageCount(): number {
    return this.auxPageCount;
  }

  override publishPage(
    level: number,
    tileX: number,
    tileZ: number,
    heights: Float32Array,
  ): boolean {
    const published = super.publishPage(level, tileX, tileZ, heights);
    if (!published) return false;
    this.retainHeightPageAddress(tileX, tileZ);
    for (const page of this.auxPages) {
      if (page?.tileX === tileX && page.tileZ === tileZ) page.active = true;
    }
    return true;
  }

  /** Takes ownership of one committed hydrology page. Coarser pages are ignored. */
  publishAuxPage(publication: TerrainAuxPagePublication): boolean {
    requireSafeInteger(publication.level, "Terrain aux page level");
    requireSafeInteger(publication.tileX, "Terrain aux page x");
    requireSafeInteger(publication.tileZ, "Terrain aux page z");
    if (publication.level !== 0) return false;
    requireSafeInteger(publication.coreSize, "Terrain aux core size");
    requireSafeInteger(publication.gutter, "Terrain aux gutter");
    requireSafeInteger(publication.storedEdge, "Terrain aux stored edge");
    requireFinite(publication.texelSizeMeters, "Terrain aux texel size");
    requireFinite(
      publication.shoreDistanceMetersPerUnit,
      "Terrain aux shore-distance unit",
    );
    requireFinite(publication.soilDepthMetersPerUnit, "Terrain aux soil-depth unit");
    if (publication.coreSize <= 0 || publication.gutter < 0) {
      throw new RangeError("Terrain aux core and gutter are invalid");
    }
    if (publication.storedEdge !== publication.coreSize + publication.gutter * 2) {
      throw new RangeError("Terrain aux stored edge does not match its core and gutter");
    }
    if (
      publication.texelSizeMeters <= 0
      || publication.shoreDistanceMetersPerUnit <= 0
      || publication.soilDepthMetersPerUnit <= 0
    ) {
      throw new RangeError("Terrain aux sampling scales must be greater than zero");
    }
    const texels = publication.storedEdge * publication.storedEdge;
    if (publication.shoreDistanceR16Sint.length !== texels) {
      throw new RangeError("Terrain aux shore-distance field length mismatch");
    }
    if (publication.soilDepthR8Unorm.length !== texels) {
      throw new RangeError("Terrain aux soil-depth field length mismatch");
    }

    this.auxSequence += 1;
    let freeIndex = -1;
    let oldestIndex = 0;
    let oldestSequence = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.auxPages.length; index += 1) {
      const page = this.auxPages[index];
      if (page === null || page === undefined) {
        if (freeIndex < 0) freeIndex = index;
        continue;
      }
      if (page.tileX === publication.tileX && page.tileZ === publication.tileZ) {
        this.auxPages[index] = {
          ...publication,
          sequence: this.auxSequence,
          active: this.hasHeightPage(publication.tileX, publication.tileZ),
        };
        return true;
      }
      if (page.sequence < oldestSequence) {
        oldestSequence = page.sequence;
        oldestIndex = index;
      }
    }

    const index = freeIndex >= 0 ? freeIndex : oldestIndex;
    if (this.auxPages[index] === null || this.auxPages[index] === undefined) {
      this.auxPageCount += 1;
    }
    this.auxPages[index] = {
      ...publication,
      sequence: this.auxSequence,
      active: this.hasHeightPage(publication.tileX, publication.tileZ),
    };
    return true;
  }

  override clear(): void {
    super.clear();
    for (let index = 0; index < this.auxPages.length; index += 1) {
      this.auxPages[index] = null;
      this.heightPageAddresses[index] = null;
    }
    this.auxSequence = 0;
    this.heightSequence = 0;
    this.auxPageCount = 0;
  }

  /** Bilinear decode of the committed core+gutter field, in signed metres. */
  sampleShoreDistance(x: number, z: number): number | null {
    return this.sampleAuxChannel(x, z, "shore");
  }

  /**
   * `6-6`: bilinear decode of the committed soil-depth field, in metres.
   *
   * Null is the sentinel every consumer branches on — no provisioned page here,
   * so the `2-15` moisture stand-in remains authoritative and analytic worlds
   * (which never publish an aux page at all) are untouched.
   */
  sampleSoilDepth(x: number, z: number): number | null {
    return this.sampleAuxChannel(x, z, "soil");
  }

  private sampleAuxChannel(
    x: number,
    z: number,
    channel: AuxChannel,
  ): number | null {
    requireFinite(x, "Terrain aux sample x");
    requireFinite(z, "Terrain aux sample z");
    const tileX = Math.floor(x / WORLD_PAGE_BASE_EXTENT_METERS);
    const tileZ = Math.floor(z / WORLD_PAGE_BASE_EXTENT_METERS);
    for (const page of this.auxPages) {
      if (page?.active && page.tileX === tileX && page.tileZ === tileZ) {
        return this.sampleAuxPage(page, x, z, channel);
      }
    }
    // A committed neighbour's four-texel gutter closes the brief interval
    // where one side of a page seam has arrived before the other.
    let newestSequence = Number.NEGATIVE_INFINITY;
    let result: number | null = null;
    for (const page of this.auxPages) {
      if (!page?.active || page.sequence <= newestSequence) continue;
      const sample = this.sampleAuxPage(page, x, z, channel);
      if (sample === null) continue;
      newestSequence = page.sequence;
      result = sample;
    }
    return result;
  }

  private retainHeightPageAddress(tileX: number, tileZ: number): void {
    this.heightSequence += 1;
    let freeIndex = -1;
    let oldestIndex = 0;
    let oldestSequence = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.heightPageAddresses.length; index += 1) {
      const address = this.heightPageAddresses[index];
      if (!address) {
        if (freeIndex < 0) freeIndex = index;
        continue;
      }
      if (address.tileX === tileX && address.tileZ === tileZ) {
        address.sequence = this.heightSequence;
        return;
      }
      if (address.sequence < oldestSequence) {
        oldestSequence = address.sequence;
        oldestIndex = index;
      }
    }
    const index = freeIndex >= 0 ? freeIndex : oldestIndex;
    const evicted = this.heightPageAddresses[index];
    if (evicted) {
      for (const page of this.auxPages) {
        if (page?.tileX === evicted.tileX && page.tileZ === evicted.tileZ) {
          page.active = false;
        }
      }
    }
    this.heightPageAddresses[index] = { tileX, tileZ, sequence: this.heightSequence };
  }

  private hasHeightPage(tileX: number, tileZ: number): boolean {
    return this.heightPageAddresses.some(
      (page) => page?.tileX === tileX && page.tileZ === tileZ,
    );
  }

  private sampleAuxPage(
    page: RetainedAuxPage,
    x: number,
    z: number,
    channel: AuxChannel,
  ): number | null {
    const minimumX = page.tileX * WORLD_PAGE_BASE_EXTENT_METERS;
    const minimumZ = page.tileZ * WORLD_PAGE_BASE_EXTENT_METERS;
    // Hydrology box-averages the 256-square erosion core into its 128-square
    // channel core. Its first sample is consequently one metre inside an L0
    // page, rather than at the height lattice's outer sample.
    const heightTexelSize = WORLD_PAGE_BASE_EXTENT_METERS / WORLD_PAGE_HEIGHT_CORE;
    const sampleOffset = (page.texelSizeMeters - heightTexelSize) * 0.5;
    const column = (
      (x - minimumX - sampleOffset) / page.texelSizeMeters
    ) + page.gutter;
    const row = (
      (z - minimumZ - sampleOffset) / page.texelSizeMeters
    ) + page.gutter;
    const last = page.storedEdge - 1;
    if (column < 0 || row < 0 || column > last || row > last) return null;
    const column0 = Math.floor(column);
    const row0 = Math.floor(row);
    const column1 = Math.min(last, column0 + 1);
    const row1 = Math.min(last, row0 + 1);
    const tx = column - column0;
    const tz = row - row0;
    // Both channels share this addressing exactly; only the stored array and
    // its quantisation scale differ, which is why the arithmetic is written
    // once rather than once per channel.
    const field = channel === "soil" ? page.soilDepthR8Unorm : page.shoreDistanceR16Sint;
    const scale = channel === "soil"
      ? page.soilDepthMetersPerUnit
      : page.shoreDistanceMetersPerUnit;
    const topLeft = field[row0 * page.storedEdge + column0]!;
    const topRight = field[row0 * page.storedEdge + column1]!;
    const bottomLeft = field[row1 * page.storedEdge + column0]!;
    const bottomRight = field[row1 * page.storedEdge + column1]!;
    const top = topLeft + (topRight - topLeft) * tx;
    const bottom = bottomLeft + (bottomRight - bottomLeft) * tx;
    return (top + (bottom - top) * tz) * scale;
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Adapts the canonical L0 -> macro -> analytic height ladder to consumers of
 * the richer world terrain sample. Climate/material fields remain sourced by
 * the caller's sampler; height, normal and slope come from the evolved
 * authority whenever it has an answer.
 *
 * Explicit analytic worlds return the supplied sampler itself. Authored
 * airport earthworks also stay on that exact sampler because page erosion
 * protects the same complete influence footprint.
 */
export function terrainConsumerSampleFromAuthority(
  world: Readonly<WorldDefinition>,
  analyticSample: TerrainConsumerSample,
  authority: TerrainConsumerHeightAuthority,
): TerrainConsumerSample {
  if (world.worldEvolution === "analytic") return analyticSample;

  // 6-6: the ecology channels ride the same publication and the same
  // provisioned-or-not sentinel. A channel that has no page here is simply
  // absent from the sample, which is what every consumer branches on.
  const withEcologyChannels = (
    sample: TerrainConsumerTerrainSample,
    x: number,
    z: number,
  ): TerrainConsumerTerrainSample => {
    const shoreDistanceMeters = authority.sampleShoreDistance?.(x, z);
    const soilDepthMeters = authority.sampleSoilDepth?.(x, z);
    const hasShore = shoreDistanceMeters !== null && shoreDistanceMeters !== undefined;
    const hasSoil = soilDepthMeters !== null && soilDepthMeters !== undefined;
    if (!hasShore && !hasSoil) return sample;
    return {
      ...sample,
      ...(hasShore ? { shoreDistanceMeters } : {}),
      ...(hasSoil ? { soilDepthMeters } : {}),
    };
  };

  const heightAt = (x: number, z: number): number => {
    const analytic = analyticSample(x, z);
    if (world.airport && getAirportInfluence(world.airport, x, z) > 0) {
      return analytic.height;
    }
    return authority.sampleHeight(x, z, analytic.height) ?? analytic.height;
  };

  return (worldX, worldZ) => {
    const analytic = analyticSample(worldX, worldZ);
    if (world.airport && getAirportInfluence(world.airport, worldX, worldZ) > 0) {
      return analytic;
    }
    const height = authority.sampleHeight(worldX, worldZ, analytic.height);
    if (height === null) return withEcologyChannels(analytic, worldX, worldZ);

    const delta = TERRAIN_NORMAL_SAMPLE_DISTANCE;
    const gradientX = (
      heightAt(worldX + delta, worldZ) - heightAt(worldX - delta, worldZ)
    ) / (2 * delta);
    const gradientZ = (
      heightAt(worldX, worldZ + delta) - heightAt(worldX, worldZ - delta)
    ) / (2 * delta);
    const inverseLength = 1 / Math.hypot(gradientX, 1, gradientZ);
    return withEcologyChannels({
      ...analytic,
      height,
      normal: {
        x: -gradientX * inverseLength,
        y: inverseLength,
        z: -gradientZ * inverseLength,
      },
      slope: clamp01(1 - inverseLength),
    }, worldX, worldZ);
  };
}
