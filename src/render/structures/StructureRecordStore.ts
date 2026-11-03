import type { StructureRecord } from "@/src/world/structures/structureRecord";

/**
 * The generated buildings the main thread knows of: each streamed
 * settlements region's records (`InfrastructureRegion.structures`), as the
 * roads worker laid them out, less any a rule hides (a spawned airport's
 * earthworks over its footprint). What the structure renderer draws from,
 * and what the night lights and the camera's colliders will read.
 *
 * A region installed again replaces its records; `version` moves on every
 * change to what is visible, so a consumer rebuilds only when it must.
 */

/** Whether a rule hides a building (`StructureRecordStore.setHidden`). */
export type StructureHidden = (record: StructureRecord) => boolean;

/** A streamed region as the store takes it: its stage key and its buildings. */
export interface StructureRegionRecords {
  readonly key: string;
  readonly structures?: readonly StructureRecord[];
}

const NEVER_HIDDEN: StructureHidden = () => false;

export class StructureRecordStore {
  private readonly regions = new Map<string, readonly StructureRecord[]>();
  private hidden: StructureHidden = NEVER_HIDDEN;
  private visibleCache: readonly StructureRecord[] | null = null;
  private versionCount = 0;

  /** Moves on every change to the visible records. */
  get version(): number {
    return this.versionCount;
  }

  get regionCount(): number {
    return this.regions.size;
  }

  /**
   * A change to the streamed regions. Only regions with buildings are kept;
   * a removed key that was never kept (a road region) is ignored, so the
   * whole change can be passed in.
   */
  apply(install: readonly StructureRegionRecords[], remove: readonly string[]): void {
    let changed = false;
    for (const key of remove) {
      if (this.regions.delete(key)) changed = true;
    }
    for (const region of install) {
      const records = region.structures ?? [];
      if (records.length === 0) {
        if (this.regions.delete(region.key)) changed = true;
        continue;
      }
      this.regions.set(region.key, records);
      changed = true;
    }
    if (changed) this.touch();
  }

  /** Drop every region (a new world). */
  clear(): void {
    if (this.regions.size === 0) return;
    this.regions.clear();
    this.touch();
  }

  /** The rule that hides buildings; call again when what it reads changes (the airports). */
  setHidden(hidden: StructureHidden | null): void {
    this.hidden = hidden ?? NEVER_HIDDEN;
    this.touch();
  }

  /** Every visible building, in region install order then record order. Cached until the next change. */
  visible(): readonly StructureRecord[] {
    if (this.visibleCache) return this.visibleCache;
    const out: StructureRecord[] = [];
    for (const records of this.regions.values()) {
      for (const record of records) {
        if (!this.hidden(record)) out.push(record);
      }
    }
    this.visibleCache = out;
    return out;
  }

  /** How many buildings the rule hides now (diagnostics). */
  hiddenCount(): number {
    let total = 0;
    for (const records of this.regions.values()) total += records.length;
    return total - this.visible().length;
  }

  private touch(): void {
    this.visibleCache = null;
    this.versionCount += 1;
  }
}
