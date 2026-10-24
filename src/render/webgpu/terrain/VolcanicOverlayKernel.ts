import {
  VOLCANISM,
  VolcanicSiteKind,
  volcanicActivityFrame,
  volcanicBinCached,
  volcanicBinSites,
  type VolcanicSite,
} from "@/src/world/volcanism";
import { LANDFORM_CORE } from "@/src/world/landforms";
import { NOISE_LATTICE_WRAP_PERIOD_CELLS } from "@/src/world/noise";
import { mixSeed } from "@/src/world/seed";
import type { WorldDefinition } from "@/src/world/types";

/**
 * The GPU twin of the volcanic overlay (`src/world/volcanism.ts`) — Class K.
 *
 * The CPU finds a point's sites by hashing cells; the GPU cannot afford that
 * per texel, so the CPU packs a SITE INDEX: every site within
 * `VOLCANIC_INDEX.halfExtentMeters` of a centre, binned on the CPU's own
 * 4 km lookup grid. Each bin lists exactly the sites `volcanicBinSites`
 * lists, in the same order, so the two sides apply the same sites in the
 * same order and differ only by f32 rounding.
 *
 * COORDINATES (kernel rule 1). No absolute coordinate reaches the GPU. The
 * index's ORIGIN is the world's landform core centre (the start airport),
 * the point the landform stage hands its page bases relative to, so the
 * origin never moves and two indexes centred anywhere pack a site into the
 * same bits. Every centre, flow start and bin corner is stored relative to
 * the origin as a hi f32 plus the lo f32 left over (split in f64), and a
 * consumer passes its points the same way (its page origin minus the core
 * centre, split in f64 on the CPU, plus its small local offset). Distances
 * subtract hi from hi and lo from lo, so they keep sub-millimetre precision
 * anywhere in the index.
 *
 * LAYOUT, one `array<vec4f>` (u32 fields bitcast):
 *
 *   [0] header: binsX, binsZ (u32), bin size (m), site count (u32)
 *   [1] header: bin grid corner relative to the origin, hi (x, z) and lo (x, z)
 *   [2] header: first bin vec4, first ref vec4, first site vec4, first flow vec4 (u32)
 *   [3] header: wind (x, z), guaranteed field centre relative to the origin (x, z)
 *   [4] header: activity mode (0 off, 1 natural, 2 forced), has a field,
 *       activity octave seeds 0 and 1 (u32)
 *   [5] header: activity octave 0, the origin's lattice split (cell u, frac u, cell v, frac v)
 *   [6] header: activity octave 1, the same
 *   bins:  two per vec4, (first ref, ref count) each (u32)
 *   refs:  four site indices per vec4 (u32)
 *   sites: VOLCANIC_INDEX.siteVec4s each: (kind, centre hi, radius),
 *          (height, crater radius, crater depth, age), (breach, base level,
 *          footprint), (noise seeds A and B, first flow, flow count) (u32),
 *          (centre lo, unused)
 *   flows: VOLCANIC_INDEX.flowVec4s each: (start hi, direction),
 *          (bend, length, width, thickness), (age, start lo x, seed (u32), start lo z)
 *
 * Profiles transliterate `volcanism.ts` line for line through the kernel's
 * hand-written `kLerp` / `kSmoothstep` (rule 2) and avoid `pow`.
 */

export const VOLCANIC_INDEX = Object.freeze({
  /** Sites within this of the index centre are listed: the 131 km height pyramid and a rebuild margin. */
  halfExtentMeters: 72_000,
  headerVec4s: 7,
  siteVec4s: 5,
  flowVec4s: 3,
});

/** A packed index, plus the origin its coordinates are relative to. */
export interface VolcanicSiteIndex {
  /** The landform core centre, world metres. */
  readonly originX: number;
  readonly originZ: number;
  /** The index's centre, world metres (NaN for the empty index). */
  readonly centerX: number;
  readonly centerZ: number;
  /** Exactly `vec4Count * 4` floats. */
  readonly data: Float32Array;
  readonly vec4Count: number;
  readonly siteCount: number;
  readonly flowCount: number;
}

/** The bin range an index centred at (x, z) covers. */
export function volcanicIndexBinRange(centerX: number, centerZ: number): {
  readonly bi0: number;
  readonly bj0: number;
  readonly binsX: number;
  readonly binsZ: number;
} {
  const size = VOLCANISM.binMeters;
  const half = VOLCANIC_INDEX.halfExtentMeters;
  const bi0 = Math.floor((centerX - half) / size);
  const bj0 = Math.floor((centerZ - half) / size);
  return {
    bi0,
    bj0,
    binsX: Math.floor((centerX + half) / size) - bi0 + 1,
    binsZ: Math.floor((centerZ + half) / size) - bj0 + 1,
  };
}

/**
 * Builds up to `maxBins` not-yet-cached bins of the index centred at (x, z)
 * and reports whether all are cached. Lets the renderer spread the first
 * visit of a volcanic area over frames (the 2 ms main-thread rule) and pack
 * only once every bin is warm.
 */
export function warmVolcanicIndexBins(
  world: WorldDefinition,
  centerX: number,
  centerZ: number,
  maxBins: number,
): boolean {
  const range = volcanicIndexBinRange(centerX, centerZ);
  let built = 0;
  for (let j = 0; j < range.binsZ; j += 1) {
    for (let i = 0; i < range.binsX; i += 1) {
      const bi = range.bi0 + i;
      const bj = range.bj0 + j;
      if (volcanicBinCached(world, bi, bj)) continue;
      if (built >= maxBins) return false;
      volcanicBinSites(world, bi, bj);
      built += 1;
    }
  }
  return true;
}

/** The kernel's split origin (`buildTerrainKernelPageUniform`): integer cell plus the f64 remainder. */
function latticeSplit(value: number): readonly [number, number] {
  const periods = Math.floor(value / NOISE_LATTICE_WRAP_PERIOD_CELLS + 0.5);
  const wrapped = periods === 0 ? value : value - periods * NOISE_LATTICE_WRAP_PERIOD_CELLS;
  const cell = Math.floor(wrapped);
  return [cell, wrapped - cell];
}

/**
 * Writes the header rows that depend only on the world (rows 3 to 6) and
 * the origin. Allocation-free past the two tiny split tuples.
 */
function writeWorldHeader(world: WorldDefinition, data: Float32Array, u32: Uint32Array): void {
  const frame = volcanicActivityFrame(world);
  data[12] = Math.sin(world.prevailingWindRadians);
  data[13] = Math.cos(world.prevailingWindRadians);
  const hasField = frame.fieldX === frame.fieldX;
  data[14] = hasField ? frame.fieldX - frame.coreX : 0;
  data[15] = hasField ? frame.fieldZ - frame.coreZ : 0;
  u32[16] = frame.mode;
  u32[17] = hasField ? 1 : 0;
  const a = VOLCANISM.activity;
  const fieldSeed = mixSeed(world.seedHash, a.channel);
  let wavelength = a.baseWavelengthMeters;
  for (let octave = 0; octave < 2; octave += 1) {
    // fbm2D keys octave k on k + 1; valueNoise2D mixes channel 0 itself.
    u32[18 + octave] = mixSeed(mixSeed(fieldSeed, octave + 1), 0) >>> 0;
    const [cellU, fracU] = latticeSplit(frame.coreX / wavelength);
    const [cellV, fracV] = latticeSplit(frame.coreZ / wavelength);
    const row = (5 + octave) * 4;
    data[row] = cellU;
    data[row + 1] = fracU;
    data[row + 2] = cellV;
    data[row + 3] = fracV;
    wavelength /= a.lacunarity;
  }
}

/** The empty index: no bins, no sites, the world's activity. Bound wherever no index is built yet. */
export function emptyVolcanicSiteIndex(world?: WorldDefinition): VolcanicSiteIndex {
  const vec4Count = VOLCANIC_INDEX.headerVec4s + 1;
  const data = new Float32Array(vec4Count * 4);
  const u32 = new Uint32Array(data.buffer);
  data[2] = VOLCANISM.binMeters;
  u32[8] = VOLCANIC_INDEX.headerVec4s;
  u32[9] = VOLCANIC_INDEX.headerVec4s;
  u32[10] = VOLCANIC_INDEX.headerVec4s;
  u32[11] = VOLCANIC_INDEX.headerVec4s;
  let originX = 0;
  let originZ = 0;
  if (world) {
    writeWorldHeader(world, data, u32);
    const frame = volcanicActivityFrame(world);
    originX = frame.coreX;
    originZ = frame.coreZ;
  }
  return {
    originX, originZ, centerX: Number.NaN, centerZ: Number.NaN,
    data, vec4Count, siteCount: 0, flowCount: 0,
  };
}

const enum BuildPhase {
  Idle,
  Warm,
  Collect,
  Write,
  Done,
}

/**
 * Packs the index in slices, so a rebuild never holds the main thread past
 * its budget (the 2 ms rule): `begin` a centre, `step` it each frame with a
 * deadline until it reports done, then read `index`. Every buffer is reused
 * and only grows, so a steady stream of rebuilds creates no garbage beyond
 * the sites a newly visited area generates.
 *
 * The packed bits do not depend on the centre beyond which bins are listed:
 * the origin is the core centre, so overlapping indexes agree exactly.
 */
export class VolcanicSiteIndexBuilder {
  private readonly world: WorldDefinition;
  private readonly originX: number;
  private readonly originZ: number;
  private phase = BuildPhase.Idle;
  private centerX = Number.NaN;
  private centerZ = Number.NaN;
  private bi0 = 0;
  private bj0 = 0;
  private binsX = 0;
  private binsZ = 0;
  private cursor = 0;
  private refCount = 0;
  private flowCount = 0;
  private flowSlot = 0;
  private binFirst = new Uint32Array(0);
  private binLength = new Uint32Array(0);
  private refs = new Uint32Array(1_024);
  private readonly sites: VolcanicSite[] = [];
  private readonly siteSlot = new Map<VolcanicSite, number>();
  private data = new Float32Array(0);
  private u32 = new Uint32Array(0);
  private vec4Count = 0;
  private firstFlow = 0;
  private result: VolcanicSiteIndex | null = null;

  constructor(world: WorldDefinition) {
    this.world = world;
    const frame = volcanicActivityFrame(world);
    this.originX = frame.coreX;
    this.originZ = frame.coreZ;
  }

  get building(): boolean {
    return this.phase !== BuildPhase.Idle && this.phase !== BuildPhase.Done;
  }

  /** The centre being built, or last built (NaN before the first `begin`). */
  get targetX(): number { return this.centerX; }
  get targetZ(): number { return this.centerZ; }

  /** Start packing the index centred at (x, z), dropping any build in progress. */
  begin(centerX: number, centerZ: number): void {
    const range = volcanicIndexBinRange(centerX, centerZ);
    this.centerX = centerX;
    this.centerZ = centerZ;
    this.bi0 = range.bi0;
    this.bj0 = range.bj0;
    this.binsX = range.binsX;
    this.binsZ = range.binsZ;
    const binCount = range.binsX * range.binsZ;
    if (this.binFirst.length < binCount) {
      this.binFirst = new Uint32Array(binCount);
      this.binLength = new Uint32Array(binCount);
    }
    this.cursor = 0;
    this.refCount = 0;
    this.flowCount = 0;
    this.flowSlot = 0;
    this.sites.length = 0;
    this.siteSlot.clear();
    this.result = null;
    this.phase = BuildPhase.Warm;
  }

  /**
   * Work until `deadline` (on `now`'s clock) or done. Returns true once the
   * index is packed. At least one unit of work is done per call, so a build
   * always finishes; a unit is one new bin (well under a millisecond), one
   * row of bin lists or one site.
   */
  step(deadline: number, now: () => number = defaultClock): boolean {
    let first = true;
    while (this.phase !== BuildPhase.Done && this.phase !== BuildPhase.Idle) {
      if (!first && now() >= deadline) return false;
      first = false;
      if (this.phase === BuildPhase.Warm) this.warmOne();
      else if (this.phase === BuildPhase.Collect) this.collectOne();
      else this.writeOne();
    }
    return this.phase === BuildPhase.Done;
  }

  /** The packed index once `step` has reported done; the arrays are reused by the next `begin`. */
  get index(): VolcanicSiteIndex | null {
    return this.result;
  }

  private warmOne(): void {
    const binCount = this.binsX * this.binsZ;
    // Skip cached bins without spending a unit on each.
    while (this.cursor < binCount) {
      const bi = this.bi0 + (this.cursor % this.binsX);
      const bj = this.bj0 + Math.floor(this.cursor / this.binsX);
      this.cursor += 1;
      if (!volcanicBinCached(this.world, bi, bj)) {
        volcanicBinSites(this.world, bi, bj);
        return;
      }
    }
    this.cursor = 0;
    this.phase = BuildPhase.Collect;
  }

  /** One row of bins: their refs, and every site seen for the first time. */
  private collectOne(): void {
    const j = this.cursor;
    for (let i = 0; i < this.binsX; i += 1) {
      const list = volcanicBinSites(this.world, this.bi0 + i, this.bj0 + j);
      const bin = j * this.binsX + i;
      this.binFirst[bin] = this.refCount;
      this.binLength[bin] = list.length;
      if (this.refCount + list.length > this.refs.length) {
        const grown = new Uint32Array(Math.max(this.refs.length * 2, this.refCount + list.length));
        grown.set(this.refs.subarray(0, this.refCount));
        this.refs = grown;
      }
      for (const site of list) {
        let slot = this.siteSlot.get(site);
        if (slot === undefined) {
          slot = this.sites.length;
          this.siteSlot.set(site, slot);
          this.sites.push(site);
          this.flowCount += site.flows.length;
        }
        this.refs[this.refCount] = slot;
        this.refCount += 1;
      }
    }
    this.cursor += 1;
    if (this.cursor >= this.binsZ) this.layout();
  }

  /** Sizes the output, writes the header, bins and refs; sites follow one per unit. */
  private layout(): void {
    const header = VOLCANIC_INDEX.headerVec4s;
    const binCount = this.binsX * this.binsZ;
    const binVec4s = Math.ceil(binCount / 2);
    const refVec4s = Math.max(1, Math.ceil(this.refCount / 4));
    const firstBin = header;
    const firstRef = firstBin + binVec4s;
    const firstSite = firstRef + refVec4s;
    const firstFlow = firstSite + this.sites.length * VOLCANIC_INDEX.siteVec4s;
    const vec4Count = Math.max(firstFlow + this.flowCount * VOLCANIC_INDEX.flowVec4s, firstFlow + 1);
    if (this.data.length < vec4Count * 4) {
      this.data = new Float32Array(Math.ceil(vec4Count * 1.25) * 4);
      this.u32 = new Uint32Array(this.data.buffer);
    }
    const data = this.data;
    const u32 = this.u32;
    data.fill(0, 0, vec4Count * 4);
    const size = VOLCANISM.binMeters;
    u32[0] = this.binsX;
    u32[1] = this.binsZ;
    data[2] = size;
    u32[3] = this.sites.length;
    const cornerX = this.bi0 * size - this.originX;
    const cornerZ = this.bj0 * size - this.originZ;
    data[4] = cornerX;
    data[5] = cornerZ;
    data[6] = cornerX - Math.fround(cornerX);
    data[7] = cornerZ - Math.fround(cornerZ);
    u32[8] = firstBin;
    u32[9] = firstRef;
    u32[10] = firstSite;
    u32[11] = firstFlow;
    writeWorldHeader(this.world, data, u32);
    for (let bin = 0; bin < binCount; bin += 1) {
      u32[firstBin * 4 + bin * 2] = this.binFirst[bin]!;
      u32[firstBin * 4 + bin * 2 + 1] = this.binLength[bin]!;
    }
    u32.set(this.refs.subarray(0, this.refCount), firstRef * 4);
    this.vec4Count = vec4Count;
    this.firstFlow = firstFlow;
    this.cursor = 0;
    this.phase = BuildPhase.Write;
    if (this.sites.length === 0) this.finish();
  }

  private writeOne(): void {
    const data = this.data;
    const u32 = this.u32;
    const slot = this.cursor;
    const site = this.sites[slot]!;
    const base = (u32[10]! + slot * VOLCANIC_INDEX.siteVec4s) * 4;
    const centerX = site.x - this.originX;
    const centerZ = site.z - this.originZ;
    data[base] = site.kind;
    data[base + 1] = centerX;
    data[base + 2] = centerZ;
    data[base + 3] = site.radiusMeters;
    data[base + 4] = site.heightMeters;
    data[base + 5] = site.craterRadiusMeters;
    data[base + 6] = site.craterDepthMeters;
    data[base + 7] = site.age;
    data[base + 8] = site.breachX;
    data[base + 9] = site.breachZ;
    data[base + 10] = site.baseLevelMeters;
    data[base + 11] = site.footprintRadiusMeters;
    // valueNoise2D mixes its seed with channel 0 itself; the GPU takes the mixed hash.
    u32[base + 12] = mixSeed(mixSeed(site.seed, 1), 0) >>> 0;
    u32[base + 13] = mixSeed(mixSeed(site.seed, 2), 0) >>> 0;
    u32[base + 14] = this.flowSlot;
    u32[base + 15] = site.flows.length;
    data[base + 16] = centerX - Math.fround(centerX);
    data[base + 17] = centerZ - Math.fround(centerZ);
    for (const flow of site.flows) {
      const f = (this.firstFlow + this.flowSlot * VOLCANIC_INDEX.flowVec4s) * 4;
      const startX = flow.startX - this.originX;
      const startZ = flow.startZ - this.originZ;
      data[f] = startX;
      data[f + 1] = startZ;
      data[f + 2] = flow.directionX;
      data[f + 3] = flow.directionZ;
      data[f + 4] = flow.bend;
      data[f + 5] = flow.lengthMeters;
      data[f + 6] = flow.widthMeters;
      data[f + 7] = flow.thicknessMeters;
      data[f + 8] = flow.age;
      data[f + 9] = startX - Math.fround(startX);
      u32[f + 10] = mixSeed(flow.seed, 0) >>> 0;
      data[f + 11] = startZ - Math.fround(startZ);
      this.flowSlot += 1;
    }
    this.cursor += 1;
    if (this.cursor >= this.sites.length) this.finish();
  }

  private finish(): void {
    this.phase = BuildPhase.Done;
    this.result = {
      originX: this.originX,
      originZ: this.originZ,
      centerX: this.centerX,
      centerZ: this.centerZ,
      data: this.data.subarray(0, this.vec4Count * 4),
      vec4Count: this.vec4Count,
      siteCount: this.sites.length,
      flowCount: this.flowCount,
    };
  }
}

function defaultClock(): number {
  return performance.now();
}

/**
 * Pack the index centred at (centerX, centerZ) in one go, into fresh arrays
 * (tests and load time; the renderer slices with `VolcanicSiteIndexBuilder`).
 */
export function packVolcanicSiteIndex(
  world: WorldDefinition,
  centerX: number,
  centerZ: number,
): VolcanicSiteIndex {
  const builder = new VolcanicSiteIndexBuilder(world);
  builder.begin(centerX, centerZ);
  builder.step(Number.POSITIVE_INFINITY);
  const index = builder.index!;
  return { ...index, data: index.data.slice() };
}

const KIND = VolcanicSiteKind;
const ACTIVITY = VOLCANISM.activity;
const FIELD = VOLCANISM.guaranteed;

/**
 * The overlay and ground functions. Requires the terrain kernel's scalar
 * helpers (`kLerp`, `kSmoothstep`, `kSaturate`) and hash layer
 * (`kValueNoiseSplit`), and a binding the consumer declares:
 *
 *   var<storage, read> terrainVolcanicIndex: array<vec4f>;
 *
 * Points are index-local metres (see the file comment).
 */
export const VOLCANIC_OVERLAY_WGSL = /* wgsl */ `
// ---------------------------------------------------------------------------
// Volcanic overlay — TRANSLITERATION of src/world/volcanism.ts.
// ---------------------------------------------------------------------------

const V_KIND_CINDER: u32 = ${KIND.Cinder}u;
const V_KIND_MAAR: u32 = ${KIND.Maar}u;
const V_KIND_SHIELD: u32 = ${KIND.Shield}u;
const V_KIND_STRATO: u32 = ${KIND.Strato}u;
const V_KIND_CALDERA: u32 = ${KIND.Caldera}u;
const V_CINDER_APRON_RADII: f32 = 2.6;
const V_MAAR_RING_RADII: f32 = 1.8;
const V_CALDERA_FLANK_RADII: f32 = 2.4;

struct VolcanicSiteData {
  kind: u32,
  center: vec2f,
  centerLo: vec2f,
  radius: f32,
  height: f32,
  craterRadius: f32,
  craterDepth: f32,
  age: f32,
  breach: vec2f,
  baseLevel: f32,
  footprint: f32,
  seedA: u32,
  seedB: u32,
  firstFlow: u32,
  flowCount: u32,
}

struct VolcanicFlowData {
  start: vec2f,
  startLo: vec2f,
  direction: vec2f,
  bend: f32,
  length: f32,
  width: f32,
  thickness: f32,
  age: f32,
  seed: u32,
}

fn vNoise(mixedHash: u32, x: f32, z: f32) -> f32 {
  return kValueNoiseSplit(mixedHash, 0, x, 0, z);
}

fn vToeRamp(t: f32, k: f32) -> f32 {
  var ramp = t - k * 0.5;
  if (t < k) { ramp = (t * t) / (2.0 * k); }
  return ramp / (1.0 - k * 0.5);
}

fn vBand(wavelength: f32, filterWidth: f32) -> f32 {
  if (filterWidth <= 0.0) { return 1.0; }
  return kSmoothstep(2.0 * filterWidth, 3.2 * filterWidth, wavelength);
}

fn vOutline(seed: u32, unit: vec2f) -> f32 {
  return vNoise(seed, unit.x * 1.6 + 7.3, unit.y * 1.6 - 2.1);
}

fn vHeaderU(index: u32) -> vec4<u32> {
  return bitcast<vec4<u32>>(terrainVolcanicIndex[index]);
}

fn vSite(slot: u32) -> VolcanicSiteData {
  let first = vHeaderU(2u).z + slot * ${VOLCANIC_INDEX.siteVec4s}u;
  let a = terrainVolcanicIndex[first];
  let b = terrainVolcanicIndex[first + 1u];
  let c = terrainVolcanicIndex[first + 2u];
  let d = bitcast<vec4<u32>>(terrainVolcanicIndex[first + 3u]);
  let e = terrainVolcanicIndex[first + 4u];
  return VolcanicSiteData(
    u32(a.x), a.yz, e.xy, a.w,
    b.x, b.y, b.z, b.w,
    c.xy, c.z, c.w,
    d.x, d.y, d.z, d.w);
}

fn vFlow(slot: u32) -> VolcanicFlowData {
  let first = vHeaderU(2u).w + slot * ${VOLCANIC_INDEX.flowVec4s}u;
  let a = terrainVolcanicIndex[first];
  let b = terrainVolcanicIndex[first + 1u];
  let c = terrainVolcanicIndex[first + 2u];
  return VolcanicFlowData(a.xy, c.yw, a.zw, b.x, b.y, b.z, b.w, c.x, bitcast<u32>(c.z));
}

/** The bin a point falls in: (first ref, count), or (0, 0) outside the index. */
fn vBin(at: VolcanicPoint) -> vec2<u32> {
  let header = vHeaderU(0u);
  let size = terrainVolcanicIndex[0u].z;
  let corner = terrainVolcanicIndex[1u];
  let cell = floor(((at.hi - corner.xy) + (at.lo - corner.zw) + at.local) / size);
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= f32(header.x) || cell.y >= f32(header.y)) {
    return vec2<u32>(0u, 0u);
  }
  let bin = u32(cell.y) * header.x + u32(cell.x);
  let packed = vHeaderU(vHeaderU(2u).x + bin / 2u);
  if ((bin & 1u) == 0u) { return packed.xy; }
  return packed.zw;
}

fn vRef(refIndex: u32) -> u32 {
  let packed = vHeaderU(vHeaderU(2u).y + refIndex / 4u);
  let lane = refIndex & 3u;
  if (lane == 0u) { return packed.x; }
  if (lane == 1u) { return packed.y; }
  if (lane == 2u) { return packed.z; }
  return packed.w;
}

struct VolcanicPolar {
  r: f32,
  unit: vec2f,
}

fn vPolar(delta: vec2f) -> VolcanicPolar {
  let r = length(delta);
  if (r > 1e-6) { return VolcanicPolar(r, delta / r); }
  return VolcanicPolar(r, vec2f(1.0, 0.0));
}

fn vCinderDelta(site: VolcanicSiteData, r: f32, unit: vec2f) -> f32 {
  let radius = site.radius * (1.0 + 0.1 * vOutline(site.seedA, unit));
  if (r >= radius) { return 0.0; }
  let height = site.height;
  let crater = site.craterRadius;
  var delta: f32;
  if (r < crater) {
    let q = r / crater;
    delta = height - site.craterDepth * (1.0 - q * q);
  } else {
    delta = height * vToeRamp((radius - r) / (radius - crater), 0.18);
  }
  if (site.breach.x != 0.0 || site.breach.y != 0.0) {
    let facing = kSmoothstep(0.8, 0.95, unit.x * site.breach.x + unit.y * site.breach.y);
    if (facing > 0.0) {
      let channel = (height - site.craterDepth) * kSaturate(1.0 - r / radius);
      delta = kLerp(delta, min(delta, channel), facing);
    }
  }
  return delta;
}

fn vShieldDelta(site: VolcanicSiteData, r: f32, unit: vec2f, filterWidth: f32) -> f32 {
  let radius = site.radius * (1.0 + 0.12 * vOutline(site.seedA, unit));
  if (r >= radius) { return 0.0; }
  let q = vToeRamp(1.0 - r / radius, 0.25);
  var delta = site.height * q * (2.0 - q);
  let pit = site.craterRadius;
  if (r < pit) {
    let p = r / pit;
    delta -= site.craterDepth * (1.0 - p * p) * vBand(pit * 2.0, filterWidth);
  }
  return delta;
}

fn vStratoShape(height: f32, q: f32) -> f32 {
  return height * q * q * (0.5 + 0.5 * q);
}

fn vStratoDelta(site: VolcanicSiteData, r: f32, unit: vec2f, filterWidth: f32) -> f32 {
  let radius = site.radius * (1.0 + 0.08 * vOutline(site.seedA, unit));
  if (r >= radius) { return 0.0; }
  let height = site.height;
  let crater = site.craterRadius;
  var delta: f32;
  if (r < crater) {
    let p = r / crater;
    delta = vStratoShape(height, 1.0 - crater / radius)
      - site.craterDepth * (1.0 - p * p) * vBand(crater * 2.0, filterWidth);
  } else {
    delta = vStratoShape(height, 1.0 - r / radius);
  }
  let q = 1.0 - r / radius;
  let gullyWeight = vBand(r * 0.33, filterWidth);
  if (gullyWeight > 0.0 && r > crater) {
    let n = vNoise(site.seedB, unit.x * 6.0 + r * 0.00025, unit.y * 6.0);
    let t = 1.0 - abs(n);
    let t2 = t * t;
    delta -= height * 0.035 * 4.0 * q * (1.0 - q) * t2 * t2 * gullyWeight;
  }
  return delta;
}

fn vCalderaHeight(site: VolcanicSiteData, height: f32, r: f32, unit: vec2f) -> f32 {
  let radius = site.radius * (1.0 + 0.06 * vOutline(site.seedA, unit));
  let s = r / radius;
  if (s >= V_CALDERA_FLANK_RADII) { return height; }
  let rise = site.height;
  var rim = rise;
  if (s > 1.0) {
    let u = (s - 1.0) / (V_CALDERA_FLANK_RADII - 1.0);
    rim = rise * (1.0 - u) * (1.0 - u);
  }
  let floorLevel = site.baseLevel + rise - site.craterDepth;
  let floorWeight = 1.0 - kSmoothstep(0.8, 1.0, s);
  return kLerp(height + rim, floorLevel, floorWeight);
}

fn vMaarHeight(site: VolcanicSiteData, height: f32, r: f32, unit: vec2f) -> f32 {
  let radius = site.radius * (1.0 + 0.08 * vOutline(site.seedA, unit));
  let s = r / radius;
  if (s >= V_MAAR_RING_RADII) { return height; }
  let depth = site.craterDepth;
  let ring = site.height * kSmoothstep(0.75, 1.0, s) * (1.0 - kSmoothstep(1.0, V_MAAR_RING_RADII, s));
  let bowlWeight = 1.0 - kSmoothstep(0.7, 1.0, s);
  if (bowlWeight <= 0.0) { return height + ring; }
  let bowl = site.baseLevel - depth + depth * s * s;
  return kLerp(height + ring, bowl, bowlWeight);
}

/** (along, across) of a point in a flow's frame: flowFrame's parabola. */
fn vFlowFrame(flow: VolcanicFlowData, at: VolcanicPoint) -> vec2f {
  let p = (at.hi - flow.start) + (at.lo - flow.startLo) + at.local;
  let dir = flow.direction;
  let a = p.x * dir.x + p.y * dir.y;
  let b = -p.x * dir.y + p.y * dir.x;
  let ka = flow.bend * a;
  return vec2f(a, (b - 0.5 * ka * a) / sqrt(1.0 + ka * ka));
}

fn vFlowCover(flow: VolcanicFlowData, along: f32, across: f32, filterWidth: f32) -> f32 {
  if (along < -flow.width || along > flow.length + flow.width) { return 0.0; }
  let t = kSaturate(along / flow.length);
  let width = flow.width * (1.0 + 1.2 * t);
  let lobes = vNoise(flow.seed, along / 180.0, 0.37) * 0.18 * width;
  let half = width * 0.5 + lobes;
  let edge = max(max(half * 0.12, 25.0), filterWidth);
  let side = kSmoothstep(half, half - edge, abs(across));
  if (side <= 0.0) { return 0.0; }
  let frontLength = flow.length + vNoise(flow.seed, across / 150.0, 5.1) * 0.15 * width;
  let front = kSmoothstep(frontLength, frontLength - edge, along);
  let start = kSmoothstep(-edge, edge, along);
  return side * front * start;
}

fn vFlowDelta(flow: VolcanicFlowData, at: VolcanicPoint, filterWidth: f32) -> f32 {
  let frame = vFlowFrame(flow, at);
  let cover = vFlowCover(flow, frame.x, frame.y, filterWidth);
  if (cover <= 0.0) { return 0.0; }
  let relief = vNoise(flow.seed, frame.x / 45.0, frame.y / 45.0) * 0.12 * vBand(90.0, filterWidth);
  return flow.thickness * cover * (1.0 + relief) * vBand(flow.width, filterWidth);
}

fn vApplySite(site: VolcanicSiteData, at: VolcanicPoint, height: f32, filterWidth: f32) -> f32 {
  let polar = vPolar(vFromSite(site, at));
  let r = polar.r;
  var result = height;
  if (site.kind == V_KIND_CALDERA) {
    result = kLerp(height, vCalderaHeight(site, height, r, polar.unit), vBand(site.radius * 2.0, filterWidth));
  } else if (site.kind == V_KIND_MAAR) {
    result = kLerp(height, vMaarHeight(site, height, r, polar.unit), vBand(site.radius * 2.0, filterWidth));
  } else if (site.kind == V_KIND_CINDER) {
    let weight = vBand(site.radius * 2.0, filterWidth);
    if (weight > 0.0 && r < site.radius * 1.2) {
      result = height + vCinderDelta(site, r, polar.unit) * weight;
    }
  } else if (site.kind == V_KIND_SHIELD) {
    if (r < site.radius * 1.2) { result = height + vShieldDelta(site, r, polar.unit, filterWidth); }
  } else if (site.kind == V_KIND_STRATO) {
    if (r < site.radius * 1.1) { result = height + vStratoDelta(site, r, polar.unit, filterWidth); }
  }
  for (var k = 0u; k < site.flowCount; k += 1u) {
    let delta = vFlowDelta(vFlow(site.firstFlow + k), at, filterWidth);
    if (delta != 0.0) { result += delta; }
  }
  return result;
}

/**
 * A point as the bakes hand it over: an index-relative base split into hi
 * and lo f32 parts (computed in f64 on the CPU) plus a small local offset.
 * Every distance to a site or flow start subtracts hi from hi and lo from lo
 * before adding the local part, so no f32 sum ever holds a large coordinate
 * and the GPU keeps sub-millimetre agreement with the CPU (the 5 mm physics
 * budget) anywhere in the index.
 */
struct VolcanicPoint {
  hi: vec2f,
  lo: vec2f,
  local: vec2f,
}

fn vFromSite(site: VolcanicSiteData, at: VolcanicPoint) -> vec2f {
  return (at.hi - site.center) + (at.lo - site.centerLo) + at.local;
}

/**
 * applyVolcanicOverlay: the height after the overlay. \`base\` is the
 * index-relative base point (hi.xy, lo.zw), \`local\` the offset from it.
 * Returns \`height\` itself wherever no listed footprint covers the point.
 */
fn terrainVolcanicOverlay(base: vec4f, local: vec2f, height: f32, filterWidth: f32) -> f32 {
  let at = VolcanicPoint(base.xy, base.zw, local);
  let bin = vBin(at);
  var result = height;
  for (var k = 0u; k < bin.y; k += 1u) {
    let site = vSite(vRef(bin.x + k));
    let d = vFromSite(site, at);
    if (dot(d, d) >= site.footprint * site.footprint) { continue; }
    result = vApplySite(site, at, result, filterWidth);
  }
  return result;
}

/** sampleVolcanicGround: (lava cover, tephra cover, age) at a point (see terrainVolcanicOverlay). */
fn terrainVolcanicGround(base: vec4f, local: vec2f, filterWidth: f32) -> vec3f {
  let at = VolcanicPoint(base.xy, base.zw, local);
  let bin = vBin(at);
  let wind = terrainVolcanicIndex[3u].xy;
  var lavaCover = 0.0;
  var tephraCover = 0.0;
  var ageOut = 0.0;
  var strongest = 0.0;
  for (var k = 0u; k < bin.y; k += 1u) {
    let site = vSite(vRef(bin.x + k));
    let d = vFromSite(site, at);
    if (dot(d, d) >= site.footprint * site.footprint) { continue; }
    let polar = vPolar(d);
    let r = polar.r;
    let radius = site.radius;
    var lava = 0.0;
    var tephra = 0.0;
    var age = site.age;
    if (site.kind == V_KIND_CINDER) {
      let downwind = max(0.0, polar.unit.x * wind.x + polar.unit.y * wind.y);
      let apron = radius * (1.5 + (V_CINDER_APRON_RADII - 1.5) * downwind);
      tephra = 1.0 - kSmoothstep(radius * 0.9, apron, r);
    } else if (site.kind == V_KIND_MAAR) {
      let s = r / radius;
      tephra = kSmoothstep(0.6, 0.85, s) * (1.0 - kSmoothstep(1.3, V_MAAR_RING_RADII, s));
    } else if (site.kind == V_KIND_SHIELD) {
      lava = 1.0 - kSmoothstep(0.85, 1.05, r / radius);
    } else if (site.kind == V_KIND_STRATO) {
      let s = r / radius;
      tephra = 1.0 - kSmoothstep(0.25, 0.45, s);
      lava = 0.7 * kSmoothstep(0.2, 0.35, s) * (1.0 - kSmoothstep(0.7, 1.05, s));
      age = min(1.0, site.age + 0.7 * s);
    } else if (site.kind == V_KIND_CALDERA) {
      let s = r / radius;
      tephra = 0.6 * (1.0 - kSmoothstep(0.8, 1.0, s));
      if (s > 1.0) { lava = 0.4 * (1.0 - kSmoothstep(1.0, V_CALDERA_FLANK_RADII, s)); }
    }
    var flowAge = age;
    var flowLava = 0.0;
    for (var f = 0u; f < site.flowCount; f += 1u) {
      let flow = vFlow(site.firstFlow + f);
      let frame = vFlowFrame(flow, at);
      let cover = vFlowCover(flow, frame.x, frame.y, filterWidth);
      if (cover > flowLava) {
        flowLava = cover;
        flowAge = flow.age;
      }
    }
    if (flowLava > lava) {
      lava = flowLava;
      if (flowLava > tephra) { age = flowAge; }
    }
    lavaCover = max(lavaCover, lava);
    tephraCover = max(tephraCover, tephra);
    let cover = max(lava, tephra);
    if (cover > strongest) {
      strongest = cover;
      ageOut = age;
    }
  }
  return vec3f(lavaCover, tephraCover, ageOut);
}

// ---------------------------------------------------------------------------
// Volcanic activity — volcanicActivity: where vents and edifices are likely.
// Dunes multiply by 1 - activity; the far fallback tints by it.
// ---------------------------------------------------------------------------

const V_ACTIVITY_LOW: f32 = ${ACTIVITY.low};
const V_ACTIVITY_HIGH: f32 = ${ACTIVITY.high};
const V_ACTIVITY_SCALE_0: f32 = ${1 / ACTIVITY.baseWavelengthMeters};
const V_ACTIVITY_SCALE_1: f32 = ${ACTIVITY.lacunarity / ACTIVITY.baseWavelengthMeters};
const V_ACTIVITY_AMPLITUDE_1: f32 = ${ACTIVITY.persistence};
const V_FIELD_FULL: f32 = ${FIELD.fullRadiusMeters}.0;
const V_FIELD_OUTER: f32 = ${FIELD.outerRadiusMeters}.0;
const V_FORCED_FLOOR: f32 = ${VOLCANISM.forced.activityFloor};
const V_CORE_INNER: f32 = ${LANDFORM_CORE.innerRadiusMeters}.0;
const V_CORE_OUTER: f32 = ${LANDFORM_CORE.innerRadiusMeters + LANDFORM_CORE.rampMeters}.0;

/** One octave of the activity field: the kernel's split-origin value noise. */
fn vActivityOctave(row: vec4f, seed: u32, scale: f32, p: vec2f) -> f32 {
  return kValueNoiseSplit(seed, i32(row.x), row.y + p.x * scale, i32(row.z), row.w + p.y * scale);
}

/**
 * volcanicActivity at a point relative to the origin (the landform core
 * centre), [0, 1]. Exactly 0 in eroded worlds and inside a natural world's
 * core. Large-scale, so one f32 point is precise enough.
 */
fn terrainVolcanicActivityAt(p: vec2f) -> f32 {
  let mode = vHeaderU(4u);
  if (mode.x == 0u) { return 0.0; }
  let field = (vActivityOctave(terrainVolcanicIndex[5u], mode.z, V_ACTIVITY_SCALE_0, p)
    + vActivityOctave(terrainVolcanicIndex[6u], mode.w, V_ACTIVITY_SCALE_1, p) * V_ACTIVITY_AMPLITUDE_1)
    / (1.0 + V_ACTIVITY_AMPLITUDE_1);
  var activity = kSmoothstep(V_ACTIVITY_LOW, V_ACTIVITY_HIGH, field);
  if (mode.x == 2u) { return max(activity, V_FORCED_FLOOR); }
  if (mode.y != 0u) {
    let near = 1.0 - kSmoothstep(V_FIELD_FULL, V_FIELD_OUTER, length(p - terrainVolcanicIndex[3u].zw));
    if (near > activity) { activity = near; }
  }
  return activity * kSmoothstep(V_CORE_INNER, V_CORE_OUTER, length(p));
}

/** volcanicActivity at a split point (see terrainVolcanicOverlay). */
fn terrainVolcanicActivity(base: vec4f, local: vec2f) -> f32 {
  return terrainVolcanicActivityAt((base.xy + base.zw) + local);
}
`;
