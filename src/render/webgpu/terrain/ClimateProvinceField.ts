/**
 * The climate province where no page can say it: a small CPU-baked field of
 * the province's far tone around the camera, for the terrain's FAR FALLBACK.
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
 * AND unresident pages; this is that field. It samples the province's two raw
 * offsets and the landform overlays' far weights (a sand sea's erg weight,
 * which no province offset can predict), and bakes from them, per texel, what
 * the fallback paints: the far tone (`ProvinceFarTone.ts`).
 *
 * WHY THESE NUMBERS. The province changes over ecotones 12 km wide, 2-6 km at
 * the steepest (measured over five seeds, 2026-10-24: 99th-percentile thermal
 * gradient 172 m/km, maximum 305 m/km), so 1.25 km texels resolve every step
 * the field can take. 128 of them span 160 km, and the window recentres on the
 * camera texel by texel, so the 45 km far plane is always inside it. Two
 * half-float textures, 160 KiB: the PAINT, rgba16float (the base tone's
 * per-channel delta, the signed canopy share), and the LIFT, r16float (the
 * thermal lift in metres). Half floats keep 11 significant bits: a tone to a
 * fraction of a display level, the lift to 2 m at the coldest province. The
 * vertex stage samples each once, bilinear with repeat addressing, so the
 * hardware does the filtering and the toroidal wrap; the fragment receives the
 * tone through varyings, so it costs no fragment binding. The raw province lanes
 * (temperature offset, dryness, sand, one reserved for the volcanic overlay)
 * stay on the CPU, in `grid.data`, for the twins and the tests.
 *
 * TOROIDAL, NEAREST FIRST, BUDGETED. Absolute texel `(i, j)` lives in slot
 * `(i mod N, j mod N)`, so moving one texel re-bakes one row or column and
 * nothing else. Each frame walks the window in rings outward from the camera
 * and bakes stale slots until a work budget is spent: a province sample and
 * its tone is one unit (1.5 us warm, of which the tone and its half floats
 * are 0.5) and a landform sample `CLIMATE_PROVINCE_FIELD_LANDFORM_COST` more,
 * so the budget below stays under a millisecond, steady flight bakes one
 * 128-texel row every 1.25 km, and a teleport has the camera's own
 * neighbourhood right within a frame and the whole window within about thirty
 * (more where a landform lane has work). A forced province with no landform
 * lane is one constant and never bakes at all.
 *
 * THE TEMPERATE CORE STAYS BIT-IDENTICAL. `sampleClimateProvince` returns
 * exactly 0 within 70 km of the start airport, the far tone of a zero province
 * is exactly 0 (half float keeps 0 exact), a bilinear mix of zeros is zero, and
 * an interpolated varying that is zero at all three vertices is zero. Every
 * consumer adds what it reads as `x + 0` or `x * (1 + 0)`.
 *
 * Class R for the textures, Class P for the grid (`ClimateProvinceFieldGrid`,
 * Node-tested).
 */

import { Constants } from "@babylonjs/core/Engines/constants";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { FromHalfFloat, ToHalfFloat } from "@babylonjs/core/Misc/halfFloat";
import type { Scene } from "@babylonjs/core/scene";
import {
  sampleClimateProvince,
  type ClimateProvinceSample,
} from "@/src/world/climateProvince";
import type { WorldDefinition } from "@/src/world/types";
import { provinceFarTone, type ProvinceFarTone } from "./ProvinceFarTone";

/** Texels per axis of the window. */
export const CLIMATE_PROVINCE_FIELD_RESOLUTION = 128;
/** Texel edge, metres: under half the narrowest ecotone the field draws. */
export const CLIMATE_PROVINCE_FIELD_TEXEL_METERS = 1_250;
/**
 * Work units per frame at most, one unit per province sample and its baked
 * tone: ~0.8 ms at the measured 1.5 us, inside the 2 ms main-thread rule, and
 * four whole rows, so steady flight never waits.
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
/** Half floats per texel of the paint: base tone delta (rgb), canopy share. */
export const CLIMATE_PROVINCE_FIELD_PAINT_LANES = 4;

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

/** The far tone as the vertex stage reads it back: half floats, filtered. */
export interface ClimateProvinceToneSample {
  readonly base: [number, number, number];
  canopyShare: number;
  thermalLiftMeters: number;
}

type ProvinceWorld = Pick<WorldDefinition, "airport" | "seedHash" | "climateProvince">;

/** Absolute texel index no slot can hold: marks a slot as never baked. */
const UNBAKED = -0x7fffffff;

/**
 * The CPU half: a toroidal window of province texels, their baked far tone,
 * and the nearest-first schedule that keeps it current. No engine, so the
 * schedule, the budget and the core's exact zeros are tested in Node.
 */
export class ClimateProvinceFieldGrid {
  /** The raw province, four lanes per slot, row-major by slot z (CPU only). */
  readonly data: Float32Array;
  /** Half-float bits, four per slot: what the paint texture uploads. */
  readonly paint: Uint16Array;
  /** Half-float bits, one per slot: what the lift texture uploads. */
  readonly lift: Uint16Array;
  readonly resolution: number;
  readonly texelMeters: number;
  private readonly world: ProvinceWorld;
  private readonly sandLane: ClimateProvinceLandformLane | null;
  private readonly storedX: Int32Array;
  private readonly storedZ: Int32Array;
  /** Window offsets (dx, dz), nearest Chebyshev ring first. */
  private readonly order: Int16Array;
  private readonly target: ClimateProvinceSample = { temperatureOffset: 0, dryness: 0 };
  private readonly tone: ProvinceFarTone = {
    thermalLiftMeters: 0, base: [0, 0, 0], canopyShare: 0, canopy: [0, 0, 0],
  };
  private centerX = Number.NaN;
  private centerZ = Number.NaN;
  // The four slots and weights around the last located point (the twins).
  private s00 = 0;
  private s10 = 0;
  private s01 = 0;
  private s11 = 0;
  private fu = 0;
  private fv = 0;
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
    // Half-float 0 is all-zero bits, so an unbaked slot reads the temperate tone.
    this.paint = new Uint16Array(slots * CLIMATE_PROVINCE_FIELD_PAINT_LANES);
    this.lift = new Uint16Array(slots);
    this.storedX = new Int32Array(slots).fill(UNBAKED);
    this.storedZ = new Int32Array(slots).fill(UNBAKED);
    this.order = ringOrder(resolution);
    const forced = world.climateProvince;
    if (forced && !this.sandLane) {
      // One province everywhere: the field is a constant and nothing is stale.
      for (let slot = 0; slot < slots; slot += 1) {
        this.data[slot * CLIMATE_PROVINCE_FIELD_LANES] = forced.temperatureOffset;
        this.data[slot * CLIMATE_PROVINCE_FIELD_LANES + 1] = forced.dryness;
        this.bakeTone(slot, forced.temperatureOffset, forced.dryness, 0);
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
      let sand = 0;
      if (sandLane) {
        const weight = sandLane(x, z);
        sand = weight > 0 ? Math.min(1, weight) : 0;
        this.data[at + 2] = sand;
        if (weight >= 0) spent += CLIMATE_PROVINCE_FIELD_LANDFORM_COST;
      }
      this.bakeTone(slot, province.temperatureOffset, province.dryness, sand);
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
   * The raw province, bilinear at a world point, texel centres at
   * `(i + 0.5) * texel`, wrapped as the sampler wraps: the field before the
   * tone is baked from it.
   */
  sample(worldX: number, worldZ: number, target: ClimateProvinceFieldSample): ClimateProvinceFieldSample {
    const lanes = CLIMATE_PROVINCE_FIELD_LANES;
    const data = this.data;
    this.locate(worldX, worldZ);
    target.temperatureOffset = this.mix(data[this.s00 * lanes]!, data[this.s10 * lanes]!,
      data[this.s01 * lanes]!, data[this.s11 * lanes]!);
    target.dryness = this.mix(data[this.s00 * lanes + 1]!, data[this.s10 * lanes + 1]!,
      data[this.s01 * lanes + 1]!, data[this.s11 * lanes + 1]!);
    target.sand = this.mix(data[this.s00 * lanes + 2]!, data[this.s10 * lanes + 2]!,
      data[this.s01 * lanes + 2]!, data[this.s11 * lanes + 2]!);
    return target;
  }

  /**
   * CPU twin of the vertex stage's read: the baked half-float tone, bilinear
   * at a world point with repeat addressing, as the sampler filters it (up to
   * the hardware's sub-texel weight precision).
   */
  sampleTone(worldX: number, worldZ: number, target: ClimateProvinceToneSample): ClimateProvinceToneSample {
    const lanes = CLIMATE_PROVINCE_FIELD_PAINT_LANES;
    this.locate(worldX, worldZ);
    target.base[0] = this.mixHalves(this.paint, lanes, 0);
    target.base[1] = this.mixHalves(this.paint, lanes, 1);
    target.base[2] = this.mixHalves(this.paint, lanes, 2);
    target.canopyShare = this.mixHalves(this.paint, lanes, 3);
    target.thermalLiftMeters = this.mixHalves(this.lift, 1, 0);
    return target;
  }

  /** The far tone of one slot's province, as half-float bits. Allocates nothing. */
  private bakeTone(slot: number, temperatureOffset: number, dryness: number, sand: number): void {
    const tone = provinceFarTone(temperatureOffset, dryness, this.tone, sand);
    const at = slot * CLIMATE_PROVINCE_FIELD_PAINT_LANES;
    this.paint[at] = ToHalfFloat(tone.base[0]);
    this.paint[at + 1] = ToHalfFloat(tone.base[1]);
    this.paint[at + 2] = ToHalfFloat(tone.base[2]);
    this.paint[at + 3] = ToHalfFloat(tone.canopyShare);
    this.lift[slot] = ToHalfFloat(tone.thermalLiftMeters);
  }

  private locate(worldX: number, worldZ: number): void {
    const n = this.resolution;
    const u = worldX / this.texelMeters - 0.5;
    const v = worldZ / this.texelMeters - 0.5;
    const baseU = Math.floor(u);
    const baseV = Math.floor(v);
    this.fu = u - baseU;
    this.fv = v - baseV;
    const x0 = wrap(baseU, n);
    const z0 = wrap(baseV, n);
    const x1 = x0 + 1 >= n ? 0 : x0 + 1;
    const z1 = z0 + 1 >= n ? 0 : z0 + 1;
    this.s00 = z0 * n + x0;
    this.s10 = z0 * n + x1;
    this.s01 = z1 * n + x0;
    this.s11 = z1 * n + x1;
  }

  /** Bilinear over the located slots' four values. */
  private mix(a: number, b: number, c: number, d: number): number {
    const top = a + (b - a) * this.fu;
    const bottom = c + (d - c) * this.fu;
    return top + (bottom - top) * this.fv;
  }

  /** One lane of half-float bits, decoded and bilinear over the located slots. */
  private mixHalves(bits: Uint16Array, lanes: number, lane: number): number {
    return this.mix(
      FromHalfFloat(bits[this.s00 * lanes + lane]!),
      FromHalfFloat(bits[this.s10 * lanes + lane]!),
      FromHalfFloat(bits[this.s01 * lanes + lane]!),
      FromHalfFloat(bits[this.s11 * lanes + lane]!),
    );
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
 * What the terrain material binds: the window's two textures and the scale
 * from world metres to window UV, `1 / (texel metres x resolution)`. The
 * plugin samples both in the vertex stage only.
 */
export interface ClimateProvinceFieldBinding {
  /** rgba16float: base tone delta (rgb), signed canopy share (a). */
  readonly paint: RawTexture;
  /** r16float: thermal lift, metres. */
  readonly lift: RawTexture;
  readonly inverseWindowMeters: number;
}

function createToneTexture(
  scene: Scene,
  bits: Uint16Array,
  edge: number,
  format: number,
  name: string,
): RawTexture {
  // Half float is filterable in core WebGPU: bilinear, so the vertex takes one
  // sample a texture, and repeat, so the toroidal slot order IS the wrap.
  const texture = new RawTexture(
    bits,
    edge,
    edge,
    format,
    scene,
    false,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
    Constants.TEXTURETYPE_HALF_FLOAT,
  );
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.name = name;
  return texture;
}

/** The Babylon half: the grid, and its textures re-uploaded when a bake lands. */
export class ClimateProvinceField {
  readonly grid: ClimateProvinceFieldGrid;
  private readonly paint: RawTexture;
  private readonly lift: RawTexture;
  private uploads = 0;

  constructor(scene: Scene, world: ProvinceWorld, landforms: ClimateProvinceLandformLanes = {}) {
    this.grid = new ClimateProvinceFieldGrid(
      world,
      CLIMATE_PROVINCE_FIELD_RESOLUTION,
      CLIMATE_PROVINCE_FIELD_TEXEL_METERS,
      landforms,
    );
    const edge = this.grid.resolution;
    this.paint = createToneTexture(
      scene, this.grid.paint, edge, Constants.TEXTUREFORMAT_RGBA, "terrain-province-paint");
    this.lift = createToneTexture(
      scene, this.grid.lift, edge, Constants.TEXTUREFORMAT_R, "terrain-province-lift");
  }

  get binding(): ClimateProvinceFieldBinding {
    return {
      paint: this.paint,
      lift: this.lift,
      inverseWindowMeters: 1 / (this.grid.texelMeters * this.grid.resolution),
    };
  }

  /** Texture uploads since construction (at most one pair per frame that baked). */
  get uploadCount(): number {
    return this.uploads;
  }

  get pending(): boolean {
    return this.grid.pending;
  }

  /** Once per frame, with the camera's world position. Allocates nothing when settled. */
  update(worldX: number, worldZ: number): void {
    if (this.grid.update(worldX, worldZ) > 0) {
      this.paint.update(this.grid.paint);
      this.lift.update(this.grid.lift);
      this.uploads += 1;
    }
  }

  dispose(): void {
    this.paint.dispose();
    this.lift.dispose();
  }
}
