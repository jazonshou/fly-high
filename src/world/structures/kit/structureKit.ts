import type { StructureRecord } from "../structureRecord";
import type { StructureDrawnLevel, StructureDrawnModel, StructureKit, StructureLayoutModel } from "../structureModel";
import { KitBuilder } from "./kitBuilder";
import { buildWalled } from "./kitBody";
import { buildProp } from "./kitProps";
import { structureLook } from "./kitStyles";
import { buildTower } from "./kitTowers";

/**
 * THE BUILDING KIT (structures phase S3): one family of buildings with
 * regional accents as parameters, as the plan's "Styles per biome" and
 * "Inside the buildings" set them out. A pure function of the record, the
 * same on every thread and tier: no Babylon, no clock, no global state but a
 * cache keyed by the record object itself.
 */

type Built = { readonly drawn: StructureDrawnModel; readonly layout: StructureLayoutModel | null };

const CACHE: Record<StructureDrawnLevel, WeakMap<StructureRecord, Built>> = {
  closed: new WeakMap(),
  open: new WeakMap(),
  block: new WeakMap(),
};

function build(record: StructureRecord, level: StructureDrawnLevel): Built {
  const cached = CACHE[level].get(record);
  if (cached) return cached;
  const b = new KitBuilder(level);
  const look = structureLook(record);
  switch (record.archetype) {
    case "watchtower":
    case "lookout":
    case "lighthouse":
      buildTower(b, record, look);
      break;
    case "windmill":
    case "tank":
    case "mast":
      buildProp(b, record, look);
      break;
    default:
      buildWalled(b, record, look);
      break;
  }
  const built: Built = {
    drawn: Object.freeze({ parts: b.parts, glass: b.glass }),
    layout: level === "open"
      ? Object.freeze({ colliders: b.colliders, volumes: b.volumes, portals: b.portals, windows: b.windows })
      : null,
  };
  CACHE[level].set(record, built);
  return built;
}

/** One drawn level of a building. */
export function structureDrawn(record: StructureRecord, level: StructureDrawnLevel): StructureDrawnModel {
  return build(record, level).drawn;
}

/** What is solid, where the rooms and doors are, and which windows glow: always the open building's. */
export function structureLayout(record: StructureRecord): StructureLayoutModel {
  return build(record, "open").layout!;
}

/** The kit, as the contract (`structureModel.ts`) names it. */
export const STRUCTURE_KIT: StructureKit = Object.freeze({
  drawn: structureDrawn,
  layout: structureLayout,
});
