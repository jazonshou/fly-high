import type { LightPointFixture } from "../webgpu/lighting/LightPoints";
import type { StructureRecord } from "@/src/world/structures/structureRecord";
import { STRUCTURE_NIGHT_OFF, type StructureNightLighting } from "./structureNightLighting";
import {
  STRUCTURE_BEACON_FLASH_SECONDS,
  STRUCTURE_BEACON_PERIOD_SECONDS,
  structureBeaconUntilFlash,
  structureLampSite,
  structureLampSiteGain,
  type StructureLampSite,
} from "./structureLamps";

/**
 * The buildings' light points (structures S5), kept in one group of the home
 * field's light-point draw (`LightPointSystem.setGroupFixtures`), so a
 * village's lights add vertices and no draw call.
 *
 * WHICH. Every drawn building with lights (`structureLampSite`) within the
 * far radius, signal lights first (a mast's, a lighthouse's), then windows
 * from the near radius outwards, up to the tier's `maxPoints`. Chosen again
 * when the buildings change or the camera has moved `STRUCTURE_LAMP_RESELECT_METERS`
 * since; the draw's buffers are rebuilt only when the choice changed.
 *
 * HOW BRIGHT. Each building's points are scaled by `structureLampSiteGain`
 * (its windows lit or not, their share against the shells by range, a
 * lighthouse's flash), written when the camera has moved
 * `STRUCTURE_LAMP_RECOLOUR_METERS`, the night changed, or a lighthouse is
 * mid-flash. Day is the draw's own: the light points fade by daylight as the
 * airfield's do.
 */

export interface StructureLampSink {
  setGroupFixtures(
    key: string,
    fixtures: readonly LightPointFixture[],
    colours?: readonly (readonly [number, number, number])[],
  ): void;
  setGroupColors(key: string, start: number, colours: readonly (readonly [number, number, number])[]): void;
}

export interface StructureLampRanges {
  readonly nearRadiusMeters: number;
  readonly bandMeters: number;
  readonly farRadiusMeters: number;
  /** At most this many points (`structureLampPoints`). */
  readonly maxPoints: number;
}

/** The camera moves this far before the lights are chosen again. */
export const STRUCTURE_LAMP_RESELECT_METERS = 150;

/** The camera moves this far before the lights are recoloured for range. */
export const STRUCTURE_LAMP_RECOLOUR_METERS = 10;

export interface StructureLampStatistics {
  /** Buildings with points in the draw, and their points. */
  readonly sites: number;
  readonly points: number;
  /** Buildings within range with lights that the budget left out. */
  readonly dropped: number;
  /** Times the draw's buffers were rebuilt, and recoloured. */
  readonly rebuilds: number;
  readonly recolours: number;
}

type Rgb = [number, number, number];

export class StructureLampPool {
  private ranges: StructureLampRanges | null = null;
  private night: StructureNightLighting = STRUCTURE_NIGHT_OFF;
  private readonly cache = new Map<number, StructureLampSite | null>();
  private sites: readonly StructureLampSite[] = [];
  private colours: Rgb[] = [];
  private selectedVersion = -1;
  private selectedAt: { x: number; z: number } | null = null;
  private colouredAt: { x: number; z: number } | null = null;
  private colouredNight: StructureNightLighting | null = null;
  /** A lighthouse mid-flash (recolour every frame), or when the next flash starts (seconds; null: none). */
  private flashing = false;
  private nextFlashAt: number | null = null;
  private dropped = 0;
  private rebuilds = 0;
  private recolours = 0;

  constructor(
    private readonly sink: StructureLampSink,
    private readonly key: string,
    private readonly clockSeconds: () => number = () => performance.now() / 1000,
  ) {}

  setRanges(ranges: StructureLampRanges): void {
    const was = this.ranges;
    if (was && was.nearRadiusMeters === ranges.nearRadiusMeters && was.bandMeters === ranges.bandMeters
      && was.farRadiusMeters === ranges.farRadiusMeters && was.maxPoints === ranges.maxPoints) return;
    this.ranges = ranges;
    this.selectedAt = null;
  }

  setNight(night: StructureNightLighting): void {
    this.night = night;
  }

  /** Once a frame with the camera's absolute position and the buildings drawn (and their store's version). */
  update(camera: { readonly x: number; readonly z: number }, records: readonly StructureRecord[], version: number): void {
    const ranges = this.ranges;
    if (!ranges) return;
    let rebuilt = false;
    if (version !== this.selectedVersion || !this.selectedAt
      || Math.hypot(camera.x - this.selectedAt.x, camera.z - this.selectedAt.z) >= STRUCTURE_LAMP_RESELECT_METERS) {
      rebuilt = this.select(camera, records, version, ranges);
    }
    if (this.sites.length === 0) return;
    const moved = !this.colouredAt
      || Math.hypot(camera.x - this.colouredAt.x, camera.z - this.colouredAt.z) >= STRUCTURE_LAMP_RECOLOUR_METERS;
    const flashDue = this.flashing || (this.nextFlashAt !== null && this.clockSeconds() >= this.nextFlashAt);
    if (rebuilt || moved || this.night !== this.colouredNight || flashDue) this.recolour(camera, ranges);
  }

  get statistics(): StructureLampStatistics {
    let points = 0;
    for (const site of this.sites) points += site.fixtures.length;
    return { sites: this.sites.length, points, dropped: this.dropped, rebuilds: this.rebuilds, recolours: this.recolours };
  }

  dispose(): void {
    if (this.sites.length > 0) this.sink.setGroupFixtures(this.key, []);
    this.sites = [];
    this.cache.clear();
  }

  /** Choose the buildings; true when the draw's buffers were rebuilt. */
  private select(
    camera: { readonly x: number; readonly z: number },
    records: readonly StructureRecord[],
    version: number,
    ranges: StructureLampRanges,
  ): boolean {
    this.selectedVersion = version;
    this.selectedAt = { x: camera.x, z: camera.z };
    // Every building that could show lights before the next choice.
    const reach = ranges.farRadiusMeters + STRUCTURE_LAMP_RESELECT_METERS;
    const windowFrom = ranges.nearRadiusMeters - STRUCTURE_LAMP_RESELECT_METERS;
    const signals: { site: StructureLampSite; distance: number }[] = [];
    const windows: { site: StructureLampSite; distance: number }[] = [];
    const seen = new Set<number>();
    for (const record of records) {
      const distance = Math.hypot(record.x - camera.x, record.z - camera.z);
      if (distance > reach) continue;
      seen.add(record.id);
      let site = this.cache.get(record.id);
      if (site === undefined) {
        site = structureLampSite(record);
        this.cache.set(record.id, site);
      }
      if (!site) continue;
      if (site.role !== "window") signals.push({ site, distance });
      else if (distance >= windowFrom) windows.push({ site, distance });
    }
    for (const id of this.cache.keys()) if (!seen.has(id)) this.cache.delete(id);
    signals.sort((a, b) => a.distance - b.distance || a.site.id - b.site.id);
    windows.sort((a, b) => a.distance - b.distance || a.site.id - b.site.id);
    const chosen: StructureLampSite[] = [];
    let points = 0;
    let dropped = 0;
    const budget = Math.max(0, Math.floor(ranges.maxPoints));
    for (const { site } of [...signals, ...windows]) {
      if (points + site.fixtures.length > budget) {
        dropped += 1;
        continue;
      }
      chosen.push(site);
      points += site.fixtures.length;
    }
    this.dropped = dropped;
    const same = chosen.length === this.sites.length && chosen.every((site, index) => site === this.sites[index]);
    if (same) return false;
    this.sites = chosen;
    this.colours = [];
    const fixtures: LightPointFixture[] = [];
    for (const site of chosen) {
      for (const fixture of site.fixtures) {
        fixtures.push(fixture);
        this.colours.push([0, 0, 0]);
      }
    }
    this.sink.setGroupFixtures(this.key, fixtures, this.colours);
    this.rebuilds += 1;
    this.colouredAt = null;
    return true;
  }

  private recolour(camera: { readonly x: number; readonly z: number }, ranges: StructureLampRanges): void {
    const time = this.clockSeconds();
    const litFraction = this.night.litFraction;
    let index = 0;
    let flashing = false;
    let nextFlashAt: number | null = null;
    for (const site of this.sites) {
      const distance = Math.hypot(site.x - camera.x, site.z - camera.z);
      const gain = structureLampSiteGain(site, distance, ranges, litFraction, time);
      if (site.role === "beacon" && litFraction > 0) {
        // Mid-flash, or a hair past its start (where the flash is still 0):
        // recoloured every frame until it is over.
        const until = structureBeaconUntilFlash(time, site.phaseSeconds);
        if (gain > 0 || until > STRUCTURE_BEACON_PERIOD_SECONDS - STRUCTURE_BEACON_FLASH_SECONDS) flashing = true;
        nextFlashAt = nextFlashAt === null ? time + until : Math.min(nextFlashAt, time + until);
      }
      for (const colour of site.colours) {
        const out = this.colours[index]!;
        out[0] = colour[0] * gain;
        out[1] = colour[1] * gain;
        out[2] = colour[2] * gain;
        index += 1;
      }
    }
    this.sink.setGroupColors(this.key, 0, this.colours);
    this.recolours += 1;
    this.colouredAt = { x: camera.x, z: camera.z };
    this.colouredNight = this.night;
    this.flashing = flashing;
    this.nextFlashAt = nextFlashAt;
  }
}
