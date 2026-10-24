/**
 * The climate province where no page can say it: a small CPU-baked field of
 * the province offsets around the camera, for the terrain's FAR FALLBACK.
 *
 * The splat bake reads the province once per texel (`LandCoverClassifier.ts`),
 * so everything a trusted page classifies already follows it. What does not is
 * the ground no page classifies: zero-trust coarse pages whose pair is not two
 * swards, and unresident pages. There the fragment builds its own macro cover
 * from REAL elevation (alpine rock, the snow blanket, the turf-relief gate) on a
 * Grass base, so a tundra province was snowed down to ~880 m by its pages and
 * bare to the reference snowline beyond them, and a desert went green at range:
 * the biome changed with the distance it was seen from, as a ring that follows
 * the aeroplane. GROUND_NEAR_FIELD_D.md section 5 names the real fix, a
 * low-resolution biome field for the whole streaming window, used by far ground
 * AND unresident pages; this is that field, carrying the province's two raw
 * offsets, from which the vertex stage derives tones and the thermal lift, and
 * the landform overlays' far weights (a sand sea's erg weight), which no
 * province offset can predict.
 *
 * WHY THESE NUMBERS. The province changes over ecotones 12 km wide, 2-6 km at
 * the steepest (measured over five seeds, 2026-10-24: 99th-percentile thermal
 * gradient 172 m/km, maximum 305 m/km), so 1.25 km texels resolve every step
 * the field can take. 128 of them span 160 km, and the window recentres on the
 * camera texel by texel, so the 45 km far plane is always inside it. RGBA32F,
 * 256 KiB: (temperature offset, dryness, sand, reserved for the volcanic
 * overlay). It is read with `textureLoad` in the vertex stage only, and the
 * fragment receives it through varyings, so it costs no fragment binding.
 *
 * TOROIDAL, NEAREST FIRST, BUDGETED. Absolute texel `(i, j)` lives in slot
 * `(i mod N, j mod N)`, so moving one texel re-bakes one row or column and
 * nothing else. Each frame walks the window in rings outward from the camera
 * and bakes stale slots until a work budget is spent: a province sample is one
 * unit (1.5 us) and a landform sample `CLIMATE_PROVINCE_FIELD_LANDFORM_COST`
 * more, so the budget below stays under a millisecond, steady flight bakes one
 * 128-texel row every 1.25 km, and a teleport has the camera's own
 * neighbourhood right within a frame and the whole window within about thirty
 * (more where a landform lane has work). A forced province with no landform
 * lane is one constant and never bakes at all.
 *
 * THE TEMPERATE CORE STAYS BIT-IDENTICAL. `sampleClimateProvince` returns
 * exactly 0 within 70 km of the start airport, a bilinear mix of zeros is
 * zero, and an interpolated varying that is zero at all three vertices is zero.
 * Every consumer adds what it derives from these as `x + 0` or `x * (1 + 0)`.
 *
 * Class R for the texture, Class P for the grid (`ClimateProvinceFieldGrid`,
 * Node-tested).
 */

import { Constants } from "@babylonjs/core/Engines/constants";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import {
  sampleClimateProvince,
  type ClimateProvinceSample,
} from "@/src/world/climateProvince";
import type { WorldDefinition } from "@/src/world/types";

/** Texels per axis of the window. */
export const CLIMATE_PROVINCE_FIELD_RESOLUTION = 128;
/** Texel edge, metres: under half the narrowest ecotone the field draws. */
export const CLIMATE_PROVINCE_FIELD_TEXEL_METERS = 1_250;
/**
 * Work units per frame at most, one unit per province sample: ~0.8 ms at the
 * measured 1.5 us, inside the 2 ms main-thread rule, and four whole rows, so
 * steady flight never waits.
 */
export const CLIMATE_PROVINCE_FIELD_SAMPLES_PER_FRAME = 512;
/**
 * Extra units a landform sample spends: the dune stage's far erg weight
 * measured 4.0 us against the province's 1.5 us. Spent only where the lane
 * actually sampled (it returns 0 early in the landform core and outside dry
 * country), so the budget is honest in a sand sea and free everywhere else.
 */
export const CLIMATE_PROVINCE_FIELD_LANDFORM_COST = 3;
/** Floats per texel: temperature offset, dryness, sand, volcanic (reserved). */
export const CLIMATE_PROVINCE_FIELD_LANES = 4;

/**
 * The far weight of a landform overlay at a world point, 0..1: exactly 0 in the
 * temperate core, allocation-free. Returns a negative number to say "I did not
 * sample" (an early out), which costs the budget nothing extra and reads as 0.
 */
export type ClimateProvinceLandformLane = (worldX: number, worldZ: number) => number;

/** The landform lanes the field bakes beside the province. Omitted reads 0. */
export interface ClimateProvinceLandformLanes {
  /** A sand sea's erg weight (`sampleErgFarWeight`, landforms.ts). */
  readonly sand?: ClimateProvinceLandformLane;
}

/** Province samples with lanes, as the CPU twin returns them. */
export interface ClimateProvinceFieldSample extends ClimateProvinceSample {
  sand: number;
}

type ProvinceWorld = Pick<WorldDefinition, "airport" | "seedHash" | "climateProvince">;

/** Absolute texel index no slot can hold: marks a slot as never baked. */
const UNBAKED = -0x7fffffff;

/**
 * The CPU half: a toroidal window of (temperature offset, dryness) texels and
 * the nearest-first schedule that keeps it current. No Babylon, so the
 * schedule, the budget and the core's exact zeros are tested in Node.
 */
export class ClimateProvinceFieldGrid {
  /** RGBA per slot, row-major by slot z: what the texture uploads. */
  readonly data: Float32Array;
  readonly resolution: number;
  readonly texelMeters: number;
  private readonly world: ProvinceWorld;
  private readonly sandLane: ClimateProvinceLandformLane | null;
  private readonly storedX: Int32Array;
  private readonly storedZ: Int32Array;
  /** Window offsets (dx, dz), nearest Chebyshev ring first. */
  private readonly order: Int16Array;
  private readonly target: ClimateProvinceSample = { temperatureOffset: 0, dryness: 0 };
  private centerX = Number.NaN;
  private centerZ = Number.NaN;
  private cursor = 0;
  private settled = false;
  private sampleCount = 0;

  constructor(
    world: ProvinceWorld,
    resolution = CLIMATE_PROVINCE_FIELD_RESOLUTION,
    texelMeters = CLIMATE_PROVINCE_FIELD_TEXEL_METERS,
    landforms: ClimateProvinceLandformLanes = {},
  ) {
    if (!Number.isInteger(resolution) || resolution < 2 || resolution % 2 !== 0) {
      throw new RangeError("Province field resolution must be an even integer of at least 2");
    }
    if (!(texelMeters > 0) || !Number.isFinite(texelMeters)) {
      throw new RangeError("Province field texel must be a positive finite length");
    }
    this.world = world;
    this.sandLane = landforms.sand ?? null;
    this.resolution = resolution;
    this.texelMeters = texelMeters;
    const slots = resolution * resolution;
    this.data = new Float32Array(slots * CLIMATE_PROVINCE_FIELD_LANES);
    this.storedX = new Int32Array(slots).fill(UNBAKED);
    this.storedZ = new Int32Array(slots).fill(UNBAKED);
    this.order = ringOrder(resolution);
    const forced = world.climateProvince;
    if (forced && !this.sandLane) {
      // One province everywhere: the field is a constant and nothing is stale.
      for (let slot = 0; slot < slots; slot += 1) {
        this.data[slot * CLIMATE_PROVINCE_FIELD_LANES] = forced.temperatureOffset;
        this.data[slot * CLIMATE_PROVINCE_FIELD_LANES + 1] = forced.dryness;
      }
      this.settled = true;
    }
  }

  /** True while some slot in the current window still holds stale data. */
  get pending(): boolean {
    return !this.settled;
  }

  /** Texels baked since construction: "rarely", made checkable. */
  get samples(): number {
    return this.sampleCount;
  }

  /**
   * Recentre on a world position and bake stale slots, nearest first, until
   * `budget` work units are spent. Returns how many texels were baked, so the
   * caller uploads only when the data changed. Allocates nothing.
   */
  update(worldX: number, worldZ: number, budget = CLIMATE_PROVINCE_FIELD_SAMPLES_PER_FRAME): number {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) {
      throw new RangeError("Province field needs a finite camera position");
    }
    if (this.world.climateProvince && !this.sandLane) return 0;
    const centerX = Math.floor(worldX / this.texelMeters);
    const centerZ = Math.floor(worldZ / this.texelMeters);
    if (centerX !== this.centerX || centerZ !== this.centerZ) {
      this.centerX = centerX;
      this.centerZ = centerZ;
      this.cursor = 0;
      this.settled = false;
    }
    if (this.settled) return 0;
    const n = this.resolution;
    const order = this.order;
    const end = order.length;
    const sandLane = this.sandLane;
    let baked = 0;
    let spent = 0;
    let cursor = this.cursor;
    while (cursor < end && spent < budget) {
      const absoluteX = centerX + order[cursor]!;
      const absoluteZ = centerZ + order[cursor + 1]!;
      cursor += 2;
      const slot = wrap(absoluteZ, n) * n + wrap(absoluteX, n);
      if (this.storedX[slot] === absoluteX && this.storedZ[slot] === absoluteZ) continue;
      const x = (absoluteX + 0.5) * this.texelMeters;
      const z = (absoluteZ + 0.5) * this.texelMeters;
      const province = sampleClimateProvince(this.world, x, z, this.target);
      const at = slot * CLIMATE_PROVINCE_FIELD_LANES;
      this.data[at] = province.temperatureOffset;
      this.data[at + 1] = province.dryness;
      spent += 1;
      if (sandLane) {
        const sand = sandLane(x, z);
        this.data[at + 2] = sand > 0 ? Math.min(1, sand) : 0;
        if (sand >= 0) spent += CLIMATE_PROVINCE_FIELD_LANDFORM_COST;
      }
      this.storedX[slot] = absoluteX;
      this.storedZ[slot] = absoluteZ;
      baked += 1;
    }
    this.cursor = cursor;
    this.sampleCount += baked;
    if (cursor >= end) this.settled = true;
    return baked;
  }

  /**
   * CPU twin of the vertex stage's read: the bilinear field at a world point,
   * texel centres at `(i + 0.5) * texel`, wrapped exactly as the shader wraps.
   */
  sample(worldX: number, worldZ: number, target: ClimateProvinceFieldSample): ClimateProvinceFieldSample {
    const n = this.resolution;
    const u = worldX / this.texelMeters - 0.5;
    const v = worldZ / this.texelMeters - 0.5;
    const baseU = Math.floor(u);
    const baseV = Math.floor(v);
    const fu = u - baseU;
    const fv = v - baseV;
    const x0 = wrap(baseU, n);
    const z0 = wrap(baseV, n);
    const x1 = x0 + 1 >= n ? 0 : x0 + 1;
    const z1 = z0 + 1 >= n ? 0 : z0 + 1;
    const lanes = CLIMATE_PROVINCE_FIELD_LANES;
    for (let lane = 0; lane < 3; lane += 1) {
      const a = this.data[(z0 * n + x0) * lanes + lane]!;
      const b = this.data[(z0 * n + x1) * lanes + lane]!;
      const c = this.data[(z1 * n + x0) * lanes + lane]!;
      const d = this.data[(z1 * n + x1) * lanes + lane]!;
      const top = a + (b - a) * fu;
      const bottom = c + (d - c) * fu;
      const value = top + (bottom - top) * fv;
      if (lane === 0) target.temperatureOffset = value;
      else if (lane === 1) target.dryness = value;
      else target.sand = value;
    }
    return target;
  }
}

function wrap(index: number, n: number): number {
  const r = index % n;
  return r < 0 ? r + n : r;
}

/**
 * Every window offset in [-n/2, n/2) squared, nearest Chebyshev ring first,
 * as (dx, dz) pairs. A counting sort by ring: built once, no comparison sort.
 */
function ringOrder(n: number): Int16Array {
  const half = n / 2;
  const ringOf = (dx: number, dz: number) => Math.max(Math.abs(dx), Math.abs(dz));
  const counts = new Int32Array(half + 1);
  for (let dz = -half; dz < half; dz += 1) {
    for (let dx = -half; dx < half; dx += 1) counts[ringOf(dx, dz)]! += 1;
  }
  const starts = new Int32Array(half + 1);
  for (let ring = 1; ring <= half; ring += 1) starts[ring] = starts[ring - 1]! + counts[ring - 1]!;
  const order = new Int16Array(n * n * 2);
  for (let dz = -half; dz < half; dz += 1) {
    for (let dx = -half; dx < half; dx += 1) {
      const ring = ringOf(dx, dz);
      const at = starts[ring]!;
      starts[ring] = at + 1;
      order[at * 2] = dx;
      order[at * 2 + 1] = dz;
    }
  }
  return order;
}

/**
 * What the terrain material binds: the window's texture and its shape,
 * `(1 / texel metres, resolution, 0, 0)`. The plugin reads both in the vertex
 * stage only.
 */
export interface ClimateProvinceFieldBinding {
  readonly texture: RawTexture;
  readonly inverseTexelMeters: number;
  readonly resolution: number;
}

function createFieldTexture(scene: Scene, data: Float32Array, edge: number): RawTexture {
  // rgba32float: Babylon declares it unfilterable, which is fine, because the
  // shader only ever textureLoads it (the height atlas's discipline).
  const texture = new RawTexture(
    data,
    edge,
    edge,
    Constants.TEXTUREFORMAT_RGBA,
    scene,
    false,
    false,
    Texture.NEAREST_SAMPLINGMODE,
    Constants.TEXTURETYPE_FLOAT,
  );
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  return texture;
}

/** The Babylon half: the grid, and its texture re-uploaded when a bake lands. */
export class ClimateProvinceField {
  readonly grid: ClimateProvinceFieldGrid;
  private readonly texture: RawTexture;
  private uploads = 0;

  constructor(scene: Scene, world: ProvinceWorld, landforms: ClimateProvinceLandformLanes = {}) {
    this.grid = new ClimateProvinceFieldGrid(
      world,
      CLIMATE_PROVINCE_FIELD_RESOLUTION,
      CLIMATE_PROVINCE_FIELD_TEXEL_METERS,
      landforms,
    );
    this.texture = createFieldTexture(scene, this.grid.data, this.grid.resolution);
    this.texture.name = "terrain-province-field";
  }

  get binding(): ClimateProvinceFieldBinding {
    return {
      texture: this.texture,
      inverseTexelMeters: 1 / this.grid.texelMeters,
      resolution: this.grid.resolution,
    };
  }

  /** Texture uploads since construction (at most one per frame that baked). */
  get uploadCount(): number {
    return this.uploads;
  }

  get pending(): boolean {
    return this.grid.pending;
  }

  /** Once per frame, with the camera's world position. Allocates nothing when settled. */
  update(worldX: number, worldZ: number): void {
    if (this.grid.update(worldX, worldZ) > 0) {
      this.texture.update(this.grid.data);
      this.uploads += 1;
    }
  }

  dispose(): void {
    this.texture.dispose();
  }
}
