export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Mat4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export function isPowerOfTwo(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

export function assertFiniteNumber(value: number, path: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${path} must be finite`);
  }
}

export function assertRange(
  value: number,
  minimum: number,
  maximum: number,
  path: string,
): void {
  assertFiniteNumber(value, path);
  if (value < minimum || value > maximum) {
    throw new RangeError(`${path} must be in [${minimum}, ${maximum}], received ${value}`);
  }
}

export function assertPositive(value: number, path: string): void {
  assertFiniteNumber(value, path);
  if (value <= 0) {
    throw new RangeError(`${path} must be greater than zero, received ${value}`);
  }
}

export function assertVec2(value: Vec2, path: string): void {
  assertFiniteNumber(value[0], `${path}[0]`);
  assertFiniteNumber(value[1], `${path}[1]`);
}

export function assertVec3(value: Vec3, path: string): void {
  assertFiniteNumber(value[0], `${path}[0]`);
  assertFiniteNumber(value[1], `${path}[1]`);
  assertFiniteNumber(value[2], `${path}[2]`);
}

export function normalizeVec2(value: Vec2, fallback: Vec2 = [1, 0]): Vec2 {
  assertVec2(value, "vector");
  const length = Math.hypot(value[0], value[1]);
  if (length <= 1e-8) return fallback;
  return [value[0] / length, value[1] / length];
}

export function normalizeVec3(value: Vec3, fallback: Vec3 = [0, 1, 0]): Vec3 {
  assertVec3(value, "vector");
  const length = Math.hypot(value[0], value[1], value[2]);
  if (length <= 1e-8) return fallback;
  return [value[0] / length, value[1] / length, value[2] / length];
}

export function assertAscending(values: readonly number[], path: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined || current <= previous) {
      throw new RangeError(`${path} must be strictly ascending`);
    }
  }
}

export function freezeTuple2(value: Vec2): Vec2 {
  return Object.freeze([value[0], value[1]]) as Vec2;
}

export function freezeTuple3(value: Vec3): Vec3 {
  return Object.freeze([value[0], value[1], value[2]]) as Vec3;
}

