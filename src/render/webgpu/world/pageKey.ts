export const WORLD_PAGE_KEY_PREFIX = "world-page-v1";
export const MAX_WORLD_PAGE_LEVEL = 30;

declare const worldPageKeyBrand: unique symbol;

/** Canonical cache/worker key. Construct with createWorldPageKey. */
export type WorldPageKey = string & { readonly [worldPageKeyBrand]: true };

/** Level zero is the finest page; each subsequent level doubles its edge length. */
export interface WorldPageAddress {
  readonly level: number;
  readonly x: number;
  readonly z: number;
}

export interface WorldPageBounds {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly centerX: number;
  readonly centerZ: number;
  readonly extentMeters: number;
}

function requireSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer`);
  return value;
}

function requireLevel(level: number): number {
  requireSafeInteger(level, "World page level");
  if (level < 0 || level > MAX_WORLD_PAGE_LEVEL) {
    throw new RangeError(`World page level must be between 0 and ${MAX_WORLD_PAGE_LEVEL}`);
  }
  return level;
}

function requireBaseExtent(baseExtentMeters: number): number {
  if (!Number.isFinite(baseExtentMeters) || baseExtentMeters <= 0) {
    throw new RangeError("Base page extent must be finite and greater than zero");
  }
  return baseExtentMeters;
}

export function createWorldPageAddress(level: number, x: number, z: number): WorldPageAddress {
  return {
    level: requireLevel(level),
    x: requireSafeInteger(x, "World page x"),
    z: requireSafeInteger(z, "World page z"),
  };
}

export function isWorldPageAddress(value: unknown): value is WorldPageAddress {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.level === "number" &&
    Number.isSafeInteger(candidate.level) &&
    candidate.level >= 0 &&
    candidate.level <= MAX_WORLD_PAGE_LEVEL &&
    typeof candidate.x === "number" &&
    Number.isSafeInteger(candidate.x) &&
    typeof candidate.z === "number" &&
    Number.isSafeInteger(candidate.z)
  );
}

export function createWorldPageKey(address: WorldPageAddress): WorldPageKey {
  if (!isWorldPageAddress(address)) throw new RangeError("Invalid world page address");
  return `${WORLD_PAGE_KEY_PREFIX}/${address.level}/${address.x}/${address.z}` as WorldPageKey;
}

/** Returns null for malformed and non-canonical representations such as -0 or 01. */
export function parseWorldPageKey(value: string): WorldPageAddress | null {
  const match = /^world-page-v1\/(0|[1-9]\d*)\/(0|-?[1-9]\d*)\/(0|-?[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const address = {
    level: Number(match[1]),
    x: Number(match[2]),
    z: Number(match[3]),
  };
  return isWorldPageAddress(address) && createWorldPageKey(address) === value ? address : null;
}

export function isWorldPageKey(value: unknown): value is WorldPageKey {
  return typeof value === "string" && parseWorldPageKey(value) !== null;
}

export function parentWorldPageAddress(address: WorldPageAddress): WorldPageAddress | null {
  if (!isWorldPageAddress(address)) throw new RangeError("Invalid world page address");
  if (address.level === MAX_WORLD_PAGE_LEVEL) return null;
  return createWorldPageAddress(
    address.level + 1,
    Math.floor(address.x / 2),
    Math.floor(address.z / 2),
  );
}

export function childWorldPageAddresses(address: WorldPageAddress): readonly WorldPageAddress[] {
  if (!isWorldPageAddress(address)) throw new RangeError("Invalid world page address");
  if (address.level === 0) return [];
  const childLevel = address.level - 1;
  const childX = address.x * 2;
  const childZ = address.z * 2;
  return [
    createWorldPageAddress(childLevel, childX, childZ),
    createWorldPageAddress(childLevel, childX + 1, childZ),
    createWorldPageAddress(childLevel, childX, childZ + 1),
    createWorldPageAddress(childLevel, childX + 1, childZ + 1),
  ];
}

export function worldPageExtentMeters(
  level: number,
  baseExtentMeters: number,
): number {
  requireLevel(level);
  requireBaseExtent(baseExtentMeters);
  const extent = baseExtentMeters * 2 ** level;
  if (!Number.isFinite(extent)) throw new RangeError("World page extent exceeds numeric range");
  return extent;
}

export function worldPageBounds(
  address: WorldPageAddress,
  baseExtentMeters: number,
): WorldPageBounds {
  if (!isWorldPageAddress(address)) throw new RangeError("Invalid world page address");
  const extentMeters = worldPageExtentMeters(address.level, baseExtentMeters);
  const minX = address.x * extentMeters;
  const minZ = address.z * extentMeters;
  const maxX = minX + extentMeters;
  const maxZ = minZ + extentMeters;
  if (![minX, minZ, maxX, maxZ].every(Number.isFinite)) {
    throw new RangeError("World page bounds exceed numeric range");
  }
  return {
    minX,
    minZ,
    maxX,
    maxZ,
    centerX: minX + extentMeters * 0.5,
    centerZ: minZ + extentMeters * 0.5,
    extentMeters,
  };
}

export function worldPositionToPageAddress(
  worldX: number,
  worldZ: number,
  level: number,
  baseExtentMeters: number,
): WorldPageAddress {
  if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) {
    throw new RangeError("World position must be finite");
  }
  const extent = worldPageExtentMeters(level, baseExtentMeters);
  return createWorldPageAddress(level, Math.floor(worldX / extent), Math.floor(worldZ / extent));
}
