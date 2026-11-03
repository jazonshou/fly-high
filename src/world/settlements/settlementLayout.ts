import type { InfrastructureSegment } from "../infrastructure";
import { INFRASTRUCTURE_PROFILE } from "../infrastructureProfiles";
import { ROAD_CLASS, roadClass, roadFormationHalfWidth } from "../roads/roadClasses";
import { pointSegmentDistance } from "../roads/roadGraph";
import type { RoadGeometry } from "../roads/roadNetwork";
import type { RoadNode } from "../roads/roadNodes";
import { RoadGround, roadGroundAt, roadGroundHeight } from "../roads/roadTerrain";
import { hashSeed } from "../seed";
import {
  STRUCTURE_BODY,
  STRUCTURE_STAIR_RISE,
  STRUCTURE_STAIR_TREAD,
  structureEnvelope,
  structurePorchDepth,
  type StructureEnvelope,
} from "../structures/structureEnvelope";
import { structureToWorld, type StructureArchetype, type StructureRecord } from "../structures/structureRecord";
import type { WorldDefinition } from "../types";
import type { SettlementRoads } from "./settlementRoads";
import { settlementRandom, type SettlementSite } from "./settlementSites";
import { settlementStyleRule } from "./settlementStyles";

/**
 * A settlement's buildings and earthworks, laid out from its site (the
 * plan's "How a settlement is laid out" and "Fitting the ground"):
 *
 *   hamlet      houses fronting the roads that leave the junction, both
 *               sides, nearest the junction first, within 300 m of it
 *   farmstead   a yard 45-75 m off the node, away from its roads: the house
 *   roadside    looking back at the road, a barn turned across it, sheds; a
 *               driveway to the road; a ranch adds a windmill and a tank
 *   outpost     the same yard with a station, a store and a watchtower (a
 *               weather mast in the tundra)
 *   cabin       one cabin (and a sauna in the boreal north)
 *   lookout     a fire lookout on the summit
 *   lighthouse  a lighthouse on the headland and its keeper's cottage inland
 *
 * Every building is tested where it would stand: on dry land (the roads'
 * own ground classes), the ground under it varying no more than its style
 * takes, clear of every road's formation and every junction pad by
 * `SETTLEMENT_ROAD_CLEARANCE` beyond its pad's batters, and clear of the
 * settlement's other buildings. A `plinth` building gets a level pad (the
 * stage's `platform` profile at `SETTLEMENT_PAD_PRIORITY`) over its whole
 * envelope; a `posts` building a clearing that only keeps plants off.
 *
 * Reads only the ground before earthworks and the roads, so a layout never
 * feeds back into where it goes.
 */

/** After the roads' junction pads (8), before the marina (10 and up). */
export const SETTLEMENT_PAD_PRIORITY = 9;
/** Pads, batters and yards keep this far off every formation and junction pad, metres. */
export const SETTLEMENT_ROAD_CLEARANCE = 3;
/** A pad's level core reaches this far past a building's envelope (its eaves), metres. */
const PAD_MARGIN = 0.5;
/** An envelope wider than this, metres (margins included), gets a core of two capsules side by side. */
const CORE_SPLIT_WIDTH = 9;
/** Pads' batter grade, run per metre of rise. */
const PAD_BATTER = 2;
/** Plants keep this far past a pad's batters or a clearing, metres. */
const PAD_PLANT_CLEARANCE = 2;
/** Spacing of the ground samples over a pad, metres. */
const SAMPLE_STEP = 4;
/** Spacing of the road-clearance samples round a pad, metres (the clearance is a distance, so it errs by half this at most). */
const ROAD_SAMPLE_STEP = 2;
/** No building below this height above the sea, metres (the wave-washed edge and a little). */
const SHORE_CLEARANCE = 2;
/** A driveway's half width, metres (a car's track and a little). */
const DRIVEWAY_HALF_WIDTH = 1.6;
/** A yard keeps this far off every formation and junction pad, metres (the plan's 6 m: a yard is no road's verge). */
const YARD_ROAD_CLEARANCE = 6;
/** No yard narrower than this, metres (a yard the roads crowd out is left off). */
const YARD_MIN_RADIUS = 6;
/** Order keys: a site's id x this + the segment's place in the site. */
export const SETTLEMENT_SEGMENT_KEY_STRIDE = 64;

/** One building as laid out: its record, and its envelope's footprint with the batters' reach. */
export interface SettlementBuilding {
  readonly record: StructureRecord;
  readonly envelope: StructureEnvelope;
  /** How far the pad's batters reach past its core, metres (0 for a building on posts). */
  readonly reach: number;
  /** Its pad's segments (a clearing's on posts), as they stand in the layout's `segments`. */
  readonly pads: readonly InfrastructureSegment[];
}

/** A settlement as laid out: its site, buildings, and the stage segments (pads, clearings, yard, driveway). */
export interface SettlementLayout {
  readonly site: SettlementSite;
  readonly buildings: readonly SettlementBuilding[];
  readonly segments: readonly InfrastructureSegment[];
  /** Plots tried, and how many failed a test (the probe's statistics). */
  readonly tried: number;
  readonly refused: number;
  /** Why: too steep, wet or on the shore, past the site's radius, too near a road, a neighbour, or a neighbour's batters. */
  readonly refusedBy: Readonly<Record<SettlementRefusal, number>>;
}

export type SettlementRefusal = "relief" | "shore" | "site" | "road" | "neighbour" | "batter";

interface BuildingSpec {
  readonly archetype: StructureArchetype;
  readonly width: number;
  readonly depth: number;
  readonly storeys: number;
}

/** An oriented rectangle in world x, z: centre, unit axes, half sizes. */
interface Rect {
  readonly cx: number;
  readonly cz: number;
  readonly ax: number;
  readonly az: number;
  readonly halfA: number;
  readonly halfB: number;
}

function rectsOverlap(p: Rect, q: Rect, gap: number): boolean {
  // Separating axes: each rectangle's two (b = (az, -ax), a's right-hand normal).
  const axes = [
    [p.ax, p.az],
    [p.az, -p.ax],
    [q.ax, q.az],
    [q.az, -q.ax],
  ] as const;
  const dx = q.cx - p.cx;
  const dz = q.cz - p.cz;
  for (const [nx, nz] of axes) {
    const pr = p.halfA * Math.abs(p.ax * nx + p.az * nz) + p.halfB * Math.abs(p.az * nx - p.ax * nz);
    const qr = q.halfA * Math.abs(q.ax * nx + q.az * nz) + q.halfB * Math.abs(q.az * nx - q.ax * nz);
    if (Math.abs(dx * nx + dz * nz) > pr + qr + gap) return false;
  }
  return true;
}

const POINT = { x: 0, y: 0, z: 0 };

class SettlementBuilder {
  readonly buildings: SettlementBuilding[] = [];
  readonly segments: InfrastructureSegment[] = [];
  /** Each building's walls (envelope and margin), its pad's core and batters' reach, and the pad's level (NaN on posts). */
  private readonly placed: {
    readonly rect: Rect;
    readonly cores: readonly Capsule[];
    readonly level: number;
    readonly reach: number;
  }[] = [];
  tried = 0;
  refused = 0;
  readonly refusedBy: Record<SettlementRefusal, number> = { relief: 0, shore: 0, site: 0, road: 0, neighbour: 0, batter: 0 };

  constructor(
    readonly world: WorldDefinition,
    readonly roads: SettlementRoads,
    readonly site: SettlementSite,
  ) {}

  get rule() {
    return settlementStyleRule(this.site.style);
  }

  random(channel: number, k: number): number {
    return settlementRandom(this.world, 100 + channel, this.site.id, k);
  }

  /** A spec for an archetype, sized by the style and a seeded scale. */
  spec(archetype: StructureArchetype, k: number): BuildingSpec {
    const rule = this.rule;
    const [w, d] = archetype === "house" ? rule.house : STRUCTURE_BODY[archetype];
    const fixed = archetype === "watchtower" || archetype === "lookout" || archetype === "lighthouse"
      || archetype === "windmill" || archetype === "tank" || archetype === "mast";
    const scale = fixed ? 1 : 0.9 + 0.2 * this.random(1, k);
    let storeys = 1;
    if (archetype === "house") storeys = rule.houseStoreys;
    else if (archetype === "watchtower") storeys = 2;
    else if (archetype === "lookout" || archetype === "lighthouse") storeys = 4 + Math.floor(this.random(2, k) * 3);
    return { archetype, width: round(w * scale), depth: round(d * scale), storeys };
  }

  /**
   * Try a building with its body centred at (x, z), its front facing
   * `heading`: returns it placed, or null (and counts the refusal).
   */
  place(spec: BuildingSpec, x: number, z: number, heading: number, gap: number): SettlementBuilding | null {
    this.tried += 1;
    const placed = this.tryPlace(spec, x, z, heading, gap);
    if (!placed) this.refused += 1;
    return placed;
  }

  private refuse(reason: SettlementRefusal): null {
    this.refusedBy[reason] += 1;
    return null;
  }

  private tryPlace(spec: BuildingSpec, x: number, z: number, heading: number, gap: number): SettlementBuilding | null {
    const world = this.world;
    const rule = this.rule;
    const frame = { x, z, heading, floorY: 0 };
    const ground = (lx: number, lz: number) => {
      structureToWorld(frame, lx, 0, lz, POINT);
      return roadGroundHeight(world, POINT.x, POINT.z);
    };
    // The body's ground: the relief its style takes.
    let lo = Infinity;
    let hi = -Infinity;
    let sum = 0;
    let count = 0;
    forRectPoints(-spec.width * 0.5, spec.width * 0.5, -spec.depth * 0.5, spec.depth * 0.5, true, (lx, lz) => {
      const h = ground(lx, lz);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      sum += h;
      count += 1;
    });
    if (hi - lo > rule.relief) return this.refuse("relief");
    const k = this.buildings.length;
    const r = this.random(3, k);
    const [f0, f1] = rule.foundationHeight;
    const foundationHeight = f0 + (f1 - f0) * r;
    let floorY: number;
    let baseY: number;
    let entryY: number;
    const padY = round(sum / count);
    const towerLike = spec.archetype === "watchtower" || spec.archetype === "lookout" || spec.archetype === "lighthouse";
    const onPad = rule.foundation === "plinth" || towerLike
      || spec.archetype === "windmill" || spec.archetype === "tank" || spec.archetype === "mast";
    if (onPad) {
      floorY = round(padY + (towerLike || spec.archetype === "tank" || spec.archetype === "windmill" || spec.archetype === "mast"
        ? 0.3 : foundationHeight));
      baseY = round(padY - 0.3);
      entryY = padY;
    } else {
      floorY = round(Math.max(hi + 0.4, lo + foundationHeight));
      baseY = round(lo - 0.3);
      // The steps' foot: where they land, walked out twice as the run sets it.
      const start = spec.depth * 0.5 + structurePorchDepth(spec.archetype, this.site.style);
      entryY = ground(0, start + 0.5);
      for (let pass = 0; pass < 2; pass += 1) {
        const run = Math.max(0, Math.round((floorY - entryY) / STRUCTURE_STAIR_RISE)) * STRUCTURE_STAIR_TREAD;
        entryY = Math.min(entryY, ground(0, start + run));
      }
      entryY = round(Math.min(entryY, floorY - 0.2));
    }
    const record: StructureRecord = Object.freeze({
      id: hashSeed(`${this.site.key}#${k}`),
      archetype: spec.archetype,
      style: this.site.style,
      x: round(x),
      z: round(z),
      heading: Math.round(heading * 1e6) / 1e6,
      width: spec.width,
      depth: spec.depth,
      storeys: spec.storeys,
      floorY,
      baseY,
      entryY,
      foundation: onPad ? "plinth" : "posts",
      seed: hashSeed(`${this.site.key}#${k}:seed`),
      settlement: this.site.id,
      settlementKind: this.site.kind,
      basalt: this.site.basalt,
    });
    const envelope = structureEnvelope(record);
    // The pad's core (or the clearing): capsules over the envelope and its
    // margin. Its ground must be dry land above the shore, and for a pad the
    // cut and fill its batters make sets their reach.
    const cores = envelopeCores(record, envelope);
    let ok = true;
    let deviation = 0;
    let coreLo = Infinity;
    let coreHi = -Infinity;
    for (const core of cores) {
      forCapsulePoints(core, core.halfWidth, SAMPLE_STEP, true, (px, pz) => {
        if (!ok) return;
        const h = roadGroundHeight(world, px, pz);
        if (h < world.seaLevel + SHORE_CLEARANCE || roadGroundAt(world, px, pz, h) !== RoadGround.land) ok = false;
        coreLo = Math.min(coreLo, h);
        coreHi = Math.max(coreHi, h);
        deviation = Math.max(deviation, Math.abs(h - padY));
      });
    }
    if (!ok) return this.refuse("shore");
    if (coreHi - coreLo > rule.relief + 1) return this.refuse("relief");
    const reach = onPad ? round(Math.min(10, Math.max(2, (deviation * PAD_BATTER) / 0.7 + 1))) : 0;
    // Inside the site, batters and all: two sites' never meet.
    for (const core of cores) {
      const far = Math.max(Math.hypot(core.ax - this.site.x, core.az - this.site.z), Math.hypot(core.bx - this.site.x, core.bz - this.site.z));
      if (far + core.halfWidth + reach > this.site.radius) return this.refuse("site");
    }
    // Clear of the roads' formations and junction pads by the clearance
    // beyond the batters: the core's outline that far from them (and half
    // the samples' spacing, as the clearance is a distance).
    // A building on posts stands on the natural ground, so out of the
    // roads' batters too.
    const clear = SETTLEMENT_ROAD_CLEARANCE + reach + 0.5 * ROAD_SAMPLE_STEP;
    for (const core of cores) {
      forCapsulePoints(core, core.halfWidth, ROAD_SAMPLE_STEP, false, (px, pz) => {
        if (ok && this.roads.clearance(px, pz) < clear) ok = false;
        if (ok && !onPad && this.roads.earthworksClearance(px, pz) < 0.5 * ROAD_SAMPLE_STEP) ok = false;
      });
    }
    if (!ok) return this.refuse("road");
    // Clear of the other buildings by the gap, wall to wall (their envelopes
    // and margins); and no batter under another building's core: between
    // two pads, a later pad's batter leaves the earlier pad's level alone
    // wherever it has risen past the step between them, so it may come that
    // close; a batter keeps wholly off a clearing, whose posts stand on the
    // natural ground.
    const rect = envelopeRect(record, envelope, PAD_MARGIN);
    const level = onPad ? padY : Number.NaN;
    for (const other of this.placed) {
      if (rectsOverlap(rect, other.rect, gap)) return this.refuse("neighbour");
      let keep = 0;
      if (onPad && !Number.isNaN(other.level)) keep = Math.min(reach, PAD_BATTER * Math.abs(level - other.level)) + 0.5;
      else if (onPad) keep = reach + 0.5;
      else if (!Number.isNaN(other.level)) keep = other.reach + 0.5;
      if (keep > 0 && coresGap(cores, other.cores) < keep) return this.refuse("batter");
    }
    const pads = cores.map((core) => {
      const segment = onPad ? padSegment(world, record, core, reach, this.segmentKey()) : postsClearing(core, this.segmentKey());
      this.segments.push(segment);
      return segment;
    });
    const building: SettlementBuilding = Object.freeze({ record, envelope, reach, pads: Object.freeze(pads) });
    this.buildings.push(building);
    this.placed.push({ rect, cores, level, reach });
    return building;
  }

  /**
   * A yard (painted, plants kept off) round (x, z), as wide as `radius` or
   * as the roads leave room for, and none narrower than `YARD_MIN_RADIUS`.
   */
  yard(x: number, z: number, radius: number): void {
    radius = round(Math.min(radius, this.roads.clearance(x, z) - YARD_ROAD_CLEARANCE));
    if (!(radius >= YARD_MIN_RADIUS)) return;
    this.segments.push(Object.freeze({
      profile: INFRASTRUCTURE_PROFILE.clearing,
      mode: "set",
      priority: SETTLEMENT_PAD_PRIORITY,
      ax: round(x),
      az: round(z),
      bx: round(x),
      bz: round(z),
      halfWidth: radius,
      reach: 0,
      params: Object.freeze([]),
      surface: "gravel",
      plantClearance: PAD_PLANT_CLEARANCE,
      key: this.segmentKey(),
    } satisfies InfrastructureSegment));
  }

  /** A driveway from (x, z) to the nearest road's formation edge within `limit`, if there is one. */
  driveway(x: number, z: number, limit: number): void {
    const near = this.roads.nearestCentreline(x, z, limit, [ROAD_CLASS.track, ROAD_CLASS.gravel]);
    if (!near) return;
    // Its round end just meets the formation's edge: no track paint on the road.
    const stop = roadFormationHalfWidth(roadClass(near.classId)) + DRIVEWAY_HALF_WIDTH;
    if (near.distance < stop + 1) return;
    const t = (near.distance - stop) / near.distance;
    this.segments.push(Object.freeze({
      profile: INFRASTRUCTURE_PROFILE.clearing,
      mode: "set",
      priority: SETTLEMENT_PAD_PRIORITY,
      ax: round(x),
      az: round(z),
      bx: round(x + (near.x - x) * t),
      bz: round(z + (near.z - z) * t),
      halfWidth: DRIVEWAY_HALF_WIDTH,
      reach: 0,
      params: Object.freeze([]),
      surface: "track",
      plantClearance: 0.5,
      key: this.segmentKey(),
    } satisfies InfrastructureSegment));
  }

  /** Forget the buildings and segments from `count` on (an attempt that did not work out). */
  rollback(buildings: number, segments: number): void {
    this.buildings.length = buildings;
    this.placed.length = buildings;
    this.segments.length = segments;
  }

  private segmentKey(): number {
    const index = this.segments.length;
    if (index >= SETTLEMENT_SEGMENT_KEY_STRIDE) throw new RangeError(`Settlement ${this.site.key} has too many segments`);
    return (this.site.id >>> 0) * SETTLEMENT_SEGMENT_KEY_STRIDE + index;
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Points round a rectangle's edge at most `SAMPLE_STEP` apart (and its
 * centre and a middle cross with `inside`), building frame.
 */
function forRectPoints(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  inside: boolean,
  visit: (lx: number, lz: number) => void,
): void {
  const nx = Math.max(1, Math.ceil((maxX - minX) / SAMPLE_STEP));
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / SAMPLE_STEP));
  for (let i = 0; i <= nx; i += 1) {
    const lx = minX + ((maxX - minX) * i) / nx;
    visit(lx, minZ);
    visit(lx, maxZ);
    if (inside) visit(lx, 0.5 * (minZ + maxZ));
  }
  for (let j = 1; j < nz; j += 1) {
    const lz = minZ + ((maxZ - minZ) * j) / nz;
    visit(minX, lz);
    visit(maxX, lz);
    if (inside) visit(0.5 * (minX + maxX), lz);
  }
}

/** The envelope grown by `grow` on every side, as a world rectangle. */
function envelopeRect(record: StructureRecord, envelope: StructureEnvelope, grow: number): Rect {
  const lx = 0.5 * (envelope.minX + envelope.maxX);
  const lz = 0.5 * (envelope.minZ + envelope.maxZ);
  structureToWorld(record, lx, 0, lz, POINT);
  return {
    cx: POINT.x,
    cz: POINT.z,
    ax: Math.cos(record.heading),
    az: -Math.sin(record.heading),
    halfA: 0.5 * (envelope.maxX - envelope.minX) + grow,
    halfB: 0.5 * (envelope.maxZ - envelope.minZ) + grow,
  };
}

/**
 * Capsules whose union covers the envelope grown by `PAD_MARGIN`: one, or
 * across a wide envelope two side by side, each along the longer side over
 * its strip of the shorter, its corners just inside (a strip's corner lies
 * 0.707 of the strip's width from its spine's end). Two bulge past the
 * rectangle half as far as one would (a tenth of the shorter side, not a
 * fifth), so a pad's level ground and batters hug the building.
 */
function envelopeCores(record: StructureRecord, envelope: StructureEnvelope): readonly Capsule[] {
  const sizeX = envelope.maxX - envelope.minX + 2 * PAD_MARGIN;
  const sizeZ = envelope.maxZ - envelope.minZ + 2 * PAD_MARGIN;
  const cx = 0.5 * (envelope.minX + envelope.maxX);
  const cz = 0.5 * (envelope.minZ + envelope.maxZ);
  const alongX = sizeX >= sizeZ;
  const long = alongX ? sizeX : sizeZ;
  const short = alongX ? sizeZ : sizeX;
  const strips = short > CORE_SPLIT_WIDTH ? 2 : 1;
  const strip = short / strips;
  const half = 0.5 * (long - strip);
  const halfWidth = round(Math.SQRT1_2 * strip + 0.05);
  const cores: Capsule[] = [];
  for (let k = 0; k < strips; k += 1) {
    const across = -0.5 * short + strip * (k + 0.5);
    const a = structureToWorld(record, cx + (alongX ? -half : across), 0, cz + (alongX ? across : -half), { x: 0, y: 0, z: 0 });
    const b = structureToWorld(record, cx + (alongX ? half : across), 0, cz + (alongX ? across : half), { x: 0, y: 0, z: 0 });
    cores.push({ ax: round(a.x), az: round(a.z), bx: round(b.x), bz: round(b.z), halfWidth });
  }
  return cores;
}

/** A capsule in world x, z: its spine from a to b and its radius. */
type Capsule = Pick<InfrastructureSegment, "ax" | "az" | "bx" | "bz" | "halfWidth">;

/**
 * Points on a capsule's outline at `radius` from its spine, at most `step`
 * apart, and with `inside` the spine and a ring halfway out.
 */
function forCapsulePoints(c: Capsule, radius: number, step: number, inside: boolean, visit: (x: number, z: number) => void): void {
  const dx = c.bx - c.ax;
  const dz = c.bz - c.az;
  const length = Math.hypot(dx, dz);
  const ux = length > 0 ? dx / length : 1;
  const uz = length > 0 ? dz / length : 0;
  // The right-hand normal of the spine.
  const nx = uz;
  const nz = -ux;
  const rings = inside ? [radius, radius * 0.5, 0] : [radius];
  for (const r of rings) {
    const along = Math.max(1, Math.ceil(length / step));
    for (let i = 0; i <= along; i += 1) {
      const x = c.ax + (dx * i) / along;
      const z = c.az + (dz * i) / along;
      visit(x + nx * r, z + nz * r);
      if (r > 0) visit(x - nx * r, z - nz * r);
    }
    if (r <= 0) continue;
    // The two caps, round from one side to the other.
    const around = Math.max(2, Math.ceil((Math.PI * r) / step));
    for (let j = 1; j < around; j += 1) {
      const angle = (Math.PI * j) / around;
      const along = Math.sin(angle) * r;
      const across = Math.cos(angle) * r;
      visit(c.bx + ux * along + nx * across, c.bz + uz * along + nz * across);
      visit(c.ax - ux * along - nx * across, c.az - uz * along - nz * across);
    }
  }
}

/** How far apart two cores' outlines are (negative where they overlap), metres. */
function coresGap(p: readonly Capsule[], q: readonly Capsule[]): number {
  let gap = Infinity;
  for (const a of p) {
    for (const b of q) {
      gap = Math.min(gap, segmentSegmentDistance(a.ax, a.az, a.bx, a.bz, b.ax, b.az, b.bx, b.bz) - a.halfWidth - b.halfWidth);
    }
  }
  return gap;
}

function segmentSegmentDistance(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): number {
  if (segmentsCross(ax, az, bx, bz, cx, cz, dx, dz)) return 0;
  return Math.min(
    pointSegmentDistance(ax, az, cx, cz, dx, dz),
    pointSegmentDistance(bx, bz, cx, cz, dx, dz),
    pointSegmentDistance(cx, cz, ax, az, bx, bz),
    pointSegmentDistance(dx, dz, ax, az, bx, bz),
  );
}

function segmentsCross(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): boolean {
  const side = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
  const d1 = side(cx, cz, dx, dz, ax, az);
  const d2 = side(cx, cz, dx, dz, bx, bz);
  const d3 = side(ax, az, bx, bz, cx, cz);
  const d4 = side(ax, az, bx, bz, dx, dz);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function padSegment(world: WorldDefinition, record: StructureRecord, core: Capsule, reach: number, key: number): InfrastructureSegment {
  return Object.freeze({
    profile: INFRASTRUCTURE_PROFILE.platform,
    mode: "set",
    priority: SETTLEMENT_PAD_PRIORITY,
    ...core,
    reach,
    params: Object.freeze([round(record.entryY - world.seaLevel), PAD_BATTER]),
    plantClearance: PAD_PLANT_CLEARANCE,
    key,
  } satisfies InfrastructureSegment);
}

function postsClearing(core: Capsule, key: number): InfrastructureSegment {
  return Object.freeze({
    profile: INFRASTRUCTURE_PROFILE.clearing,
    mode: "set",
    priority: SETTLEMENT_PAD_PRIORITY,
    ...core,
    reach: 0,
    params: Object.freeze([]),
    plantClearance: PAD_PLANT_CLEARANCE,
    key,
  } satisfies InfrastructureSegment);
}

/** A road's centreline from a node outward: point and unit tangent at a distance along it. */
class RoadFromNode {
  private readonly forward: boolean;
  readonly length: number;

  constructor(readonly geometry: RoadGeometry, node: RoadNode) {
    this.forward = geometry.edge.a.key === node.key;
    this.length = geometry.station[geometry.station.length - 1] ?? 0;
  }

  at(distance: number, out: { x: number; z: number; tx: number; tz: number }): boolean {
    const { x, z, station } = this.geometry;
    const n = station.length;
    if (n < 2 || distance < 0 || distance > this.length) return false;
    const s = this.forward ? distance : this.length - distance;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (station[mid]! <= s) lo = mid;
      else hi = mid;
    }
    const span = station[hi]! - station[lo]!;
    const t = span > 0 ? (s - station[lo]!) / span : 0;
    out.x = x[lo]! + (x[hi]! - x[lo]!) * t;
    out.z = z[lo]! + (z[hi]! - z[lo]!) * t;
    const dx = x[hi]! - x[lo]!;
    const dz = z[hi]! - z[lo]!;
    const length = Math.hypot(dx, dz) || 1;
    const sign = this.forward ? 1 : -1;
    out.tx = (sign * dx) / length;
    out.tz = (sign * dz) / length;
    return true;
  }
}

/** First plot along a road from the junction, metres (past the largest pad). */
const HAMLET_FIRST_STATION = 38;
/** Last plot along a road from the junction, metres. */
const HAMLET_LAST_STATION = 300;

function layoutHamlet(b: SettlementBuilder): void {
  const node = b.site.node!;
  const rule = b.rule;
  const [lo, hi] = rule.hamletSize;
  const wanted = lo + Math.floor(b.random(10, 0) * (hi - lo + 1));
  const roads = b.roads.edgesAt(node)
    .filter(({ edge }) => edge.classId !== ROAD_CLASS.airport)
    .map(({ geometry }) => new RoadFromNode(geometry, node));
  interface Plot { readonly station: number; readonly road: number; readonly side: 1 | -1; readonly k: number }
  const plots: Plot[] = [];
  roads.forEach((road, index) => {
    for (const side of [1, -1] as const) {
      let station = HAMLET_FIRST_STATION + 8 * b.random(11, index * 2 + (side > 0 ? 0 : 1));
      let k = 0;
      while (station <= Math.min(HAMLET_LAST_STATION, road.length - 20)) {
        plots.push({ station, road: index, side, k: index * 1_000 + (side > 0 ? 0 : 500) + k });
        station += (rule.house[0] + 12) * (0.9 + 0.45 * b.random(12, index * 1_000 + (side > 0 ? 0 : 500) + k));
        k += 1;
      }
    }
  });
  plots.sort((left, right) => left.station - right.station || left.road - right.road || right.side - left.side);
  const point = { x: 0, z: 0, tx: 0, tz: 0 };
  for (const plot of plots) {
    if (b.buildings.length >= wanted) break;
    const road = roads[plot.road]!;
    if (!road.at(plot.station, point)) continue;
    const r = b.random(13, plot.k);
    const archetype: StructureArchetype = b.buildings.length === 0 ? "house" : r < 0.12 ? "store" : r < 0.3 ? "cottage" : "house";
    const spec = b.spec(archetype, plot.k);
    const half = roadFormationHalfWidth(roadClass(road.geometry.edge.classId));
    // The yard side's normal: right of the road's way out is (tz, -tx).
    const nx = plot.side * point.tz;
    const nz = -plot.side * point.tx;
    const front = structurePorchDepth(archetype, b.site.style) + 1.5;
    // A house on posts keeps out of the road's batters as well: past them there.
    const batters = rule.foundation === "posts"
      ? Math.max(0, -b.roads.earthworksClearance(point.x + nx * (half + 0.5), point.z + nz * (half + 0.5)))
      : 0;
    const setback = half + SETTLEMENT_ROAD_CLEARANCE + PAD_MARGIN + 3 + front + batters + spec.depth * 0.5 + 4 * b.random(14, plot.k);
    const x = point.x + nx * setback;
    const z = point.z + nz * setback;
    // The front faces the road.
    b.place(spec, x, z, Math.atan2(-nx, -nz), 4 + 6 * b.random(15, plot.k));
  }
}

/** One building of a yard: its archetype, place in the yard (u right, v towards the road) and turn. */
interface YardRole {
  readonly archetype: StructureArchetype;
  readonly u: number;
  readonly v: number;
  readonly turn: number;
}

/** Between the buildings of a yard, wall to wall, metres. */
const YARD_SPACING = 7;

function yardRoles(b: SettlementBuilder, kind: "farm" | "outpost", main: BuildingSpec): { role: YardRole; spec: BuildingSpec }[] {
  const style = b.site.style;
  const flip = b.random(20, 0) < 0.5 ? 1 : -1;
  const eave = 0.6;
  const mainU = main.width * 0.5 + eave;
  const mainBack = main.depth * 0.5 + eave;
  const roles: { role: YardRole; spec: BuildingSpec }[] = [{ role: { archetype: main.archetype, u: 0, v: 0, turn: 0 }, spec: main }];
  /** Beside the main building, on side `side`, turned or not; `v` its centre's place towards the road. */
  const beside = (archetype: StructureArchetype, k: number, side: number, turned: boolean, v: number) => {
    const spec = b.spec(archetype, k);
    const halfU = (turned ? spec.depth : spec.width) * 0.5 + eave;
    roles.push({ role: { archetype, u: side * (mainU + YARD_SPACING + halfU), v, turn: turned ? side * Math.PI * 0.5 : 0 }, spec });
  };
  /** Behind the main building, `u` across, turned to face it. */
  const behind = (archetype: StructureArchetype, k: number, u: number) => {
    const spec = b.spec(archetype, k);
    roles.push({ role: { archetype, u, v: -(mainBack + YARD_SPACING + spec.depth * 0.5 + eave), turn: Math.PI }, spec });
  };
  if (kind === "outpost") {
    beside("store", 1, flip, false, -1);
    beside(style === "tundra" ? "mast" : "watchtower", 2, -flip, false, 2);
    behind("shed", 3, 0);
    return roles;
  }
  if (style !== "tundra" && style !== "tropical") beside("barn", 1, flip, true, -4);
  beside("shed", 2, -flip, false, -3);
  if (style === "desert" || style === "savanna") {
    // The tank well past the windmill: 14 m between them, about 10 wall to wall.
    behind("windmill", 3, -flip * 4);
    behind("tank", 4, -flip * 18);
  } else if (style === "boreal") {
    behind("sauna", 3, flip * 3);
  } else {
    behind("store", 3, flip * 3);
  }
  return roles;
}

/** Yard centre's distance from the anchor, metres (low, high). */
const YARD_OFFSET: readonly [number, number] = [45, 75];

function layoutYard(b: SettlementBuilder, kind: "farm" | "outpost", away0: number, fixedAway: boolean): void {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const r = b.random(21, attempt);
    const swing = (attempt % 2 === 0 ? 1 : -1) * (fixedAway ? 0.25 * attempt : 0.4 * attempt + 0.3 * r);
    const away = away0 + swing;
    const offset = YARD_OFFSET[0] + (YARD_OFFSET[1] - YARD_OFFSET[0]) * r;
    const yx = b.site.x + Math.sin(away) * offset;
    const yz = b.site.z + Math.cos(away) * offset;
    // The yard frame: v towards the road (the house looks back at it), u to its right.
    const facing = away + Math.PI;
    const vx = Math.sin(facing);
    const vz = Math.cos(facing);
    const ux = Math.cos(facing);
    const uz = -Math.sin(facing);
    const startBuildings = b.buildings.length;
    const startSegments = b.segments.length;
    const mainSpec = b.spec(kind === "outpost" ? "station" : b.site.style === "tundra" ? "cottage" : "house", 0);
    const roles = yardRoles(b, kind, mainSpec);
    let mainBuilding = null;
    for (let index = 0; index < roles.length; index += 1) {
      const { role, spec } = roles[index]!;
      const x = yx + ux * role.u + vx * role.v;
      const z = yz + uz * role.u + vz * role.v;
      const placed = b.place(spec, x, z, facing + role.turn, 4);
      if (index === 0) {
        if (!placed) break;
        mainBuilding = placed;
      }
    }
    if (mainBuilding && b.buildings.length - startBuildings >= 2) {
      b.yard(yx - vx * 6, yz - vz * 6, 12);
      const front = mainBuilding.envelope.maxZ + 2;
      b.driveway(yx + vx * front, yz + vz * front, 160);
      return;
    }
    b.rollback(startBuildings, startSegments);
  }
}

function meanRoadHeading(b: SettlementBuilder, node: RoadNode): number {
  let sx = 0;
  let sz = 0;
  for (const { edge } of b.roads.edgesAt(node)) {
    const other = edge.a.key === node.key ? edge.b : edge.a;
    const heading = Math.atan2(other.x - node.x, other.z - node.z);
    sx += Math.sin(heading);
    sz += Math.cos(heading);
  }
  return Math.atan2(sx, sz);
}

function layoutCabin(b: SettlementBuilder): void {
  const heading = b.random(30, 0) * Math.PI * 2;
  const cabin = b.place(b.spec("cabin", 0), b.site.x, b.site.z, heading, 4);
  if (!cabin || b.site.style !== "boreal" || b.random(31, 0) >= 0.5) return;
  const away = heading + Math.PI * (0.6 + 0.8 * b.random(32, 0));
  b.place(b.spec("sauna", 1), b.site.x + Math.sin(away) * 13, b.site.z + Math.cos(away) * 13, away, 3);
}

function layoutLookout(b: SettlementBuilder): void {
  b.place(b.spec("lookout", 0), b.site.x, b.site.z, b.random(40, 0) * Math.PI * 2, 4);
}

function layoutLighthouse(b: SettlementBuilder): void {
  // Towards the sea: the mean of the directions that are water at 300 m.
  let sx = 0;
  let sz = 0;
  for (let a = 0; a < 16; a += 1) {
    const heading = (a * Math.PI) / 8;
    const h = roadGroundHeight(b.world, b.site.x + Math.sin(heading) * 300, b.site.z + Math.cos(heading) * 300);
    if (h < b.world.seaLevel) {
      sx += Math.sin(heading);
      sz += Math.cos(heading);
    }
  }
  const seaward = Math.atan2(sx, sz);
  const tower = b.place(b.spec("lighthouse", 0), b.site.x, b.site.z, seaward, 4);
  if (!tower) return;
  const inland = seaward + Math.PI;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const swing = (attempt % 2 === 0 ? 1 : -1) * 0.5 * Math.ceil(attempt / 2);
    const distance = 20 + 4 * attempt;
    const x = b.site.x + Math.sin(inland + swing) * distance;
    const z = b.site.z + Math.cos(inland + swing) * distance;
    if (b.place(b.spec("cottage", 1), x, z, Math.atan2(b.site.x - x, b.site.z - z), 4)) return;
  }
}

/** Lay out one site. */
export function layoutSettlement(world: WorldDefinition, roads: SettlementRoads, site: SettlementSite): SettlementLayout {
  const b = new SettlementBuilder(world, roads, site);
  switch (site.kind) {
    case "hamlet":
      layoutHamlet(b);
      break;
    case "farmstead":
    case "outpost":
      layoutYard(b, site.kind === "outpost" ? "outpost" : "farm", meanRoadHeading(b, site.node!) + Math.PI, false);
      break;
    case "roadside": {
      const road = site.road!;
      // The yard's side: right of the road's direction is (tz, -tx).
      const away = Math.atan2(road.side * road.tangentZ, -road.side * road.tangentX);
      layoutYard(b, "farm", away, true);
      break;
    }
    case "cabin":
      layoutCabin(b);
      break;
    case "lookout":
      layoutLookout(b);
      break;
    case "lighthouse":
      layoutLighthouse(b);
      break;
  }
  return Object.freeze({
    site,
    buildings: Object.freeze(b.buildings.slice()),
    segments: Object.freeze(b.segments.slice()),
    tried: b.tried,
    refused: b.refused,
    refusedBy: Object.freeze({ ...b.refusedBy }),
  });
}
