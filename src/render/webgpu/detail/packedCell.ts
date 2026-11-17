import type {
  ClutterKind,
  DetailClutterPlacement,
  DetailGroundCoverNode,
  DetailRockPlacement,
  DetailShrubPlacement,
  DetailTreePlacement,
  GeneratedDetailCell,
  GroundCoverArchetype,
  RockVariant,
  ShrubSpecies,
  TreeSpecies,
} from "./types";

/**
 * A generated cell as struct-of-arrays columns, the form the presentation
 * build reads and both cell owners (the detail worker and the inline
 * fallback) retain.
 *
 * The object graph `generateDetailCell` returns costs ~530 B per placement
 * in Node: an object, a colour tuple and about fifteen numbers that pointer
 * compression boxes one by one. A heap snapshot of the detail worker on the
 * Low bench found 89 retained cells holding 133 MiB that way. Columns hold
 * the values the build reads in ~103 B per placement (88 such cells:
 * 38 MiB). That was measured before the build drew ground shadows and solid
 * bushes, which read three more numbers of every tree and of every bush:
 * 24 B more for each of those, 23% more column bytes over six cells of the
 * same world. The bench's heap was not snapshotted again.
 *
 * Every number is a Float64Array element, so it is the exact double the
 * generator produced, and every name is its index in a fixed code table
 * below, so a packed cell reads back bit for bit what was packed: the
 * presentation build's output bytes cannot change. That holds for the
 * fields the build reads, the only ones packed (`TREE_FIELDS` and below).
 */

/**
 * A union's names in a fixed code order. Taking a Record makes a name
 * missing from the table a compile error.
 */
function codeTable<Name extends string>(codes: Readonly<Record<Name, number>>): readonly Name[] {
  const names: Name[] = [];
  for (const name of Object.keys(codes) as Name[]) names[codes[name]] = name;
  return names;
}

const TREE_SPECIES_CODES: Readonly<Record<TreeSpecies, number>> = {
  pine: 0, cedar: 1, spruce: 2, oak: 3, maple: 4, birch: 5, willow: 6, palm: 7,
};
const SHRUB_SPECIES_CODES: Readonly<Record<ShrubSpecies, number>> = {
  juniper: 0, hazel: 1, sage: 2,
};
const ROCK_VARIANT_CODES: Readonly<Record<RockVariant, number>> = {
  granite: 0, limestone: 1, dark: 2,
};
const CLUTTER_KIND_CODES: Readonly<Record<ClutterKind, number>> = {
  log: 0, stump: 1, branchLitter: 2, mossCushion: 3,
};
const GROUND_COVER_ARCHETYPE_CODES: Readonly<Record<GroundCoverArchetype, number>> = {
  grass: 0, fern: 1, heather: 2, reed: 3,
};
const TREE_SPECIES = codeTable(TREE_SPECIES_CODES);
const SHRUB_SPECIES = codeTable(SHRUB_SPECIES_CODES);
const ROCK_VARIANTS = codeTable(ROCK_VARIANT_CODES);
const CLUTTER_KINDS = codeTable(CLUTTER_KIND_CODES);
const GROUND_COVER_ARCHETYPES = codeTable(GROUND_COVER_ARCHETYPE_CODES);

function encode<Name extends string>(
  codes: Readonly<Record<Name, number>>,
  name: Name,
  label: string,
): number {
  // Own keys only: an inherited one ("toString") would get past an
  // `undefined` check and be stored as code 0, the table's first name.
  if (!Object.hasOwn(codes, name)) throw new Error(`Cannot pack unknown ${label} ${String(name)}`);
  return codes[name];
}

/**
 * The fields the presentation build reads, and only those. Not packed:
 * a tree's wind phase (its phase lane carries the stem's LOD key) and stand
 * age, and a clutter piece's selection. A view has no getter for them, so a
 * build that starts reading one fails to compile instead of reading a value
 * nobody packed.
 *
 * A tree's trunk radius and ground slope are read by its ground shadow
 * (`treeGroundShadowRecord`); a bush's canopy closure decides whose budget it
 * is drawn on and its ground slope lays its shadow (`presentationBuild.ts`).
 * The generator always writes them. Where a hand-built placement leaves one
 * out, 0 is packed, which is what the build read for an absent one.
 */
const TREE_FIELDS = [
  "x", "y", "z", "yawRadians", "heightMeters", "crownRadiusMeters", "trunkRadiusMeters",
  "windResponse", "colorR", "colorG", "colorB", "colorA", "selection",
  "groundSlopeX", "groundSlopeZ",
] as const;
const SHRUB_FIELDS = [
  "x", "y", "z", "yawRadians", "heightMeters", "radiusMeters", "windPhaseRadians",
  "windResponse", "colorR", "colorG", "colorB", "colorA", "selection",
  "canopyClosure", "groundSlopeX", "groundSlopeZ",
] as const;
const ROCK_FIELDS = [
  "x", "y", "z", "yawRadians", "radiusMeters", "flattening", "colorR", "colorG", "colorB",
  "colorA", "selection", "normalX", "normalY", "normalZ",
] as const;
const CLUTTER_FIELDS = [
  "x", "y", "z", "yawRadians", "sizeMeters", "colorR", "colorG", "colorB", "colorA",
  "normalX", "normalY", "normalZ",
] as const;
const GROUND_COVER_FIELDS = [
  "coverage", "colorR", "colorG", "colorB", "heightMeters",
] as const;

type Float64Columns<Field extends string> = { readonly [Key in Field]: Float64Array };

/** `codes` holds each placement's name (species, variant, kind) as a table index. */
export type PackedColumns<Field extends string> = Float64Columns<Field> & {
  readonly count: number;
  readonly codes: Uint8Array;
};

export type PackedTreeColumns = PackedColumns<(typeof TREE_FIELDS)[number]>;
export type PackedShrubColumns = PackedColumns<(typeof SHRUB_FIELDS)[number]>;
export type PackedRockColumns = PackedColumns<(typeof ROCK_FIELDS)[number]>;
export type PackedClutterColumns = PackedColumns<(typeof CLUTTER_FIELDS)[number]>;
export type PackedGroundCoverColumns = PackedColumns<(typeof GROUND_COVER_FIELDS)[number]>;

export interface PackedDetailCell {
  readonly key: string;
  readonly cellX: number;
  readonly cellZ: number;
  readonly cellSizeMeters: number;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly trees: PackedTreeColumns;
  readonly shrubs: PackedShrubColumns;
  readonly rocks: PackedRockColumns;
  readonly clutter: PackedClutterColumns;
  /** 2-16: 8×8 habitat nodes, row-major, as `GeneratedDetailCell.groundCover`. */
  readonly groundCover: PackedGroundCoverColumns;
}

/** One Float64Array per kind; each column is a view of its own range. */
function allocateColumns<Field extends string>(
  fields: readonly Field[],
  count: number,
): PackedColumns<Field> {
  const storage = new Float64Array(fields.length * count);
  const columns: Record<string, unknown> = { count, codes: new Uint8Array(count) };
  fields.forEach((field, index) => {
    columns[field] = storage.subarray(index * count, (index + 1) * count);
  });
  return columns as PackedColumns<Field>;
}

function packTrees(trees: readonly DetailTreePlacement[]): PackedTreeColumns {
  const columns = allocateColumns(TREE_FIELDS, trees.length);
  trees.forEach((tree, index) => {
    columns.codes[index] = encode(TREE_SPECIES_CODES, tree.species, "tree species");
    columns.x[index] = tree.x;
    columns.y[index] = tree.y;
    columns.z[index] = tree.z;
    columns.yawRadians[index] = tree.yawRadians;
    columns.heightMeters[index] = tree.heightMeters;
    columns.crownRadiusMeters[index] = tree.crownRadiusMeters;
    columns.trunkRadiusMeters[index] = tree.trunkRadiusMeters;
    columns.windResponse[index] = tree.windResponse;
    columns.colorR[index] = tree.color[0];
    columns.colorG[index] = tree.color[1];
    columns.colorB[index] = tree.color[2];
    columns.colorA[index] = tree.color[3];
    columns.selection[index] = tree.selection;
    columns.groundSlopeX[index] = tree.groundSlopeX ?? 0;
    columns.groundSlopeZ[index] = tree.groundSlopeZ ?? 0;
  });
  return columns;
}

function packShrubs(shrubs: readonly DetailShrubPlacement[]): PackedShrubColumns {
  const columns = allocateColumns(SHRUB_FIELDS, shrubs.length);
  shrubs.forEach((shrub, index) => {
    columns.codes[index] = encode(SHRUB_SPECIES_CODES, shrub.species, "shrub species");
    columns.x[index] = shrub.x;
    columns.y[index] = shrub.y;
    columns.z[index] = shrub.z;
    columns.yawRadians[index] = shrub.yawRadians;
    columns.heightMeters[index] = shrub.heightMeters;
    columns.radiusMeters[index] = shrub.radiusMeters;
    columns.windPhaseRadians[index] = shrub.windPhaseRadians;
    columns.windResponse[index] = shrub.windResponse;
    columns.colorR[index] = shrub.color[0];
    columns.colorG[index] = shrub.color[1];
    columns.colorB[index] = shrub.color[2];
    columns.colorA[index] = shrub.color[3];
    columns.selection[index] = shrub.selection;
    columns.canopyClosure[index] = shrub.canopyClosure ?? 0;
    columns.groundSlopeX[index] = shrub.groundSlopeX ?? 0;
    columns.groundSlopeZ[index] = shrub.groundSlopeZ ?? 0;
  });
  return columns;
}

function packRocks(rocks: readonly DetailRockPlacement[]): PackedRockColumns {
  const columns = allocateColumns(ROCK_FIELDS, rocks.length);
  rocks.forEach((rock, index) => {
    columns.codes[index] = encode(ROCK_VARIANT_CODES, rock.variant, "rock variant");
    columns.x[index] = rock.x;
    columns.y[index] = rock.y;
    columns.z[index] = rock.z;
    columns.yawRadians[index] = rock.yawRadians;
    columns.radiusMeters[index] = rock.radiusMeters;
    columns.flattening[index] = rock.flattening;
    columns.colorR[index] = rock.color[0];
    columns.colorG[index] = rock.color[1];
    columns.colorB[index] = rock.color[2];
    columns.colorA[index] = rock.color[3];
    columns.selection[index] = rock.selection;
    columns.normalX[index] = rock.normal.x;
    columns.normalY[index] = rock.normal.y;
    columns.normalZ[index] = rock.normal.z;
  });
  return columns;
}

function packClutter(clutter: readonly DetailClutterPlacement[]): PackedClutterColumns {
  const columns = allocateColumns(CLUTTER_FIELDS, clutter.length);
  clutter.forEach((piece, index) => {
    columns.codes[index] = encode(CLUTTER_KIND_CODES, piece.clutterKind, "clutter kind");
    columns.x[index] = piece.x;
    columns.y[index] = piece.y;
    columns.z[index] = piece.z;
    columns.yawRadians[index] = piece.yawRadians;
    columns.sizeMeters[index] = piece.sizeMeters;
    columns.colorR[index] = piece.color[0];
    columns.colorG[index] = piece.color[1];
    columns.colorB[index] = piece.color[2];
    columns.colorA[index] = piece.color[3];
    columns.normalX[index] = piece.normal.x;
    columns.normalY[index] = piece.normal.y;
    columns.normalZ[index] = piece.normal.z;
  });
  return columns;
}

function packGroundCover(nodes: readonly DetailGroundCoverNode[]): PackedGroundCoverColumns {
  const columns = allocateColumns(GROUND_COVER_FIELDS, nodes.length);
  nodes.forEach((node, index) => {
    columns.codes[index] = encode(
      GROUND_COVER_ARCHETYPE_CODES,
      node.archetype,
      "ground-cover archetype",
    );
    columns.coverage[index] = node.coverage;
    columns.colorR[index] = node.color[0];
    columns.colorG[index] = node.color[1];
    columns.colorB[index] = node.color[2];
    columns.heightMeters[index] = node.heightMeters;
  });
  return columns;
}

/** Packs a generated cell; the object graph can be dropped afterwards. */
export function packDetailCell(cell: GeneratedDetailCell): PackedDetailCell {
  return {
    key: cell.key,
    cellX: cell.cellX,
    cellZ: cell.cellZ,
    cellSizeMeters: cell.cellSizeMeters,
    minX: cell.minX,
    minZ: cell.minZ,
    maxX: cell.maxX,
    maxZ: cell.maxZ,
    trees: packTrees(cell.trees),
    shrubs: packShrubs(cell.shrubs),
    rocks: packRocks(cell.rocks),
    clutter: packClutter(cell.clutter),
    groundCover: packGroundCover(cell.groundCover),
  };
}

/**
 * Cursors that read one packed placement under its placement field names.
 *
 * `at` repoints the cursor and returns it, so a loop reads `view.at(columns,
 * i).x` without allocating. The colour (and the normal) is a scratch tuple
 * refilled on every read: consume it before the next read, as the
 * presentation sink contract already requires of record members. A
 * presentation build yields between records, so each build owns its cursors.
 *
 * Scratch fields start as NaN so V8 gives them a double representation from
 * the first store instead of migrating them on the first fractional one.
 */
export class PackedTreeView {
  private columns: PackedTreeColumns | null = null;
  private index = 0;
  private readonly tint: [number, number, number, number] = [NaN, NaN, NaN, NaN];

  at(columns: PackedTreeColumns, index: number): this {
    this.columns = columns;
    this.index = index;
    return this;
  }

  get species(): TreeSpecies { return TREE_SPECIES[this.columns!.codes[this.index]!]!; }
  get x(): number { return this.columns!.x[this.index]!; }
  get y(): number { return this.columns!.y[this.index]!; }
  get z(): number { return this.columns!.z[this.index]!; }
  get yawRadians(): number { return this.columns!.yawRadians[this.index]!; }
  get heightMeters(): number { return this.columns!.heightMeters[this.index]!; }
  get crownRadiusMeters(): number { return this.columns!.crownRadiusMeters[this.index]!; }
  get trunkRadiusMeters(): number { return this.columns!.trunkRadiusMeters[this.index]!; }
  get windResponse(): number { return this.columns!.windResponse[this.index]!; }
  get selection(): number { return this.columns!.selection[this.index]!; }
  get groundSlopeX(): number { return this.columns!.groundSlopeX[this.index]!; }
  get groundSlopeZ(): number { return this.columns!.groundSlopeZ[this.index]!; }
  get color(): readonly [number, number, number, number] {
    return fillTint(this.tint, this.columns!, this.index);
  }
}

export class PackedShrubView {
  private columns: PackedShrubColumns | null = null;
  private index = 0;
  private readonly tint: [number, number, number, number] = [NaN, NaN, NaN, NaN];

  at(columns: PackedShrubColumns, index: number): this {
    this.columns = columns;
    this.index = index;
    return this;
  }

  get species(): ShrubSpecies { return SHRUB_SPECIES[this.columns!.codes[this.index]!]!; }
  get x(): number { return this.columns!.x[this.index]!; }
  get y(): number { return this.columns!.y[this.index]!; }
  get z(): number { return this.columns!.z[this.index]!; }
  get yawRadians(): number { return this.columns!.yawRadians[this.index]!; }
  get heightMeters(): number { return this.columns!.heightMeters[this.index]!; }
  get radiusMeters(): number { return this.columns!.radiusMeters[this.index]!; }
  get windPhaseRadians(): number { return this.columns!.windPhaseRadians[this.index]!; }
  get windResponse(): number { return this.columns!.windResponse[this.index]!; }
  get selection(): number { return this.columns!.selection[this.index]!; }
  get canopyClosure(): number { return this.columns!.canopyClosure[this.index]!; }
  get groundSlopeX(): number { return this.columns!.groundSlopeX[this.index]!; }
  get groundSlopeZ(): number { return this.columns!.groundSlopeZ[this.index]!; }
  get color(): readonly [number, number, number, number] {
    return fillTint(this.tint, this.columns!, this.index);
  }
}

export class PackedRockView {
  private columns: PackedRockColumns | null = null;
  private index = 0;
  private readonly tint: [number, number, number, number] = [NaN, NaN, NaN, NaN];
  private readonly surfaceNormal = { x: NaN, y: NaN, z: NaN };

  at(columns: PackedRockColumns, index: number): this {
    this.columns = columns;
    this.index = index;
    return this;
  }

  get variant(): RockVariant { return ROCK_VARIANTS[this.columns!.codes[this.index]!]!; }
  get x(): number { return this.columns!.x[this.index]!; }
  get y(): number { return this.columns!.y[this.index]!; }
  get z(): number { return this.columns!.z[this.index]!; }
  get yawRadians(): number { return this.columns!.yawRadians[this.index]!; }
  get radiusMeters(): number { return this.columns!.radiusMeters[this.index]!; }
  get flattening(): number { return this.columns!.flattening[this.index]!; }
  get selection(): number { return this.columns!.selection[this.index]!; }
  get color(): readonly [number, number, number, number] {
    return fillTint(this.tint, this.columns!, this.index);
  }
  get normal(): { readonly x: number; readonly y: number; readonly z: number } {
    return fillNormal(this.surfaceNormal, this.columns!, this.index);
  }
}

export class PackedClutterView {
  private columns: PackedClutterColumns | null = null;
  private index = 0;
  private readonly tint: [number, number, number, number] = [NaN, NaN, NaN, NaN];
  private readonly surfaceNormal = { x: NaN, y: NaN, z: NaN };

  at(columns: PackedClutterColumns, index: number): this {
    this.columns = columns;
    this.index = index;
    return this;
  }

  get clutterKind(): ClutterKind { return CLUTTER_KINDS[this.columns!.codes[this.index]!]!; }
  get x(): number { return this.columns!.x[this.index]!; }
  get y(): number { return this.columns!.y[this.index]!; }
  get z(): number { return this.columns!.z[this.index]!; }
  get yawRadians(): number { return this.columns!.yawRadians[this.index]!; }
  get sizeMeters(): number { return this.columns!.sizeMeters[this.index]!; }
  get color(): readonly [number, number, number, number] {
    return fillTint(this.tint, this.columns!, this.index);
  }
  get normal(): { readonly x: number; readonly y: number; readonly z: number } {
    return fillNormal(this.surfaceNormal, this.columns!, this.index);
  }
}

/** A ground-cover node's archetype name. */
export function packedGroundCoverArchetype(
  nodes: PackedGroundCoverColumns,
  index: number,
): GroundCoverArchetype {
  return GROUND_COVER_ARCHETYPES[nodes.codes[index]!]!;
}

function fillTint(
  tint: [number, number, number, number],
  columns: Float64Columns<"colorR" | "colorG" | "colorB" | "colorA">,
  index: number,
): readonly [number, number, number, number] {
  tint[0] = columns.colorR[index]!;
  tint[1] = columns.colorG[index]!;
  tint[2] = columns.colorB[index]!;
  tint[3] = columns.colorA[index]!;
  return tint;
}

function fillNormal(
  normal: { x: number; y: number; z: number },
  columns: Float64Columns<"normalX" | "normalY" | "normalZ">,
  index: number,
): { readonly x: number; readonly y: number; readonly z: number } {
  normal.x = columns.normalX[index]!;
  normal.y = columns.normalY[index]!;
  normal.z = columns.normalZ[index]!;
  return normal;
}
