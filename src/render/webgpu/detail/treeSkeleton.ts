import { clamp, lerp } from "@/src/world/noise";
import type { TreeSpecies } from "./types";

/**
 * Deterministic tree skeleton generator (vegetation overhaul, wave T).
 *
 * A Weber & Penn-style parametric stem grammar (SIGGRAPH 1995), reduced to
 * the subset that matters at this renderer's triangle prices: recursive stem
 * chains with per-segment curvature, species-shaped child length falloff
 * (`ShapeRatio`), pipe-model radii, phyllotactic child placement (golden-angle
 * spiral / opposite pairs / conifer whorls), vertical tropism, and decurrent
 * trunk splits. The skeleton is the SINGLE source both mesh detail levels and
 * the leaf-card placement consume: meshing consumes zero RNG, so near and mid
 * prototypes agree on silhouette by construction.
 *
 * INVARIANTS THIS FILE OWNS:
 * - All randomness happens here, in one named stream, in a fixed
 *   parent-before-children traversal order. `buildTreeSkeleton` is a pure
 *   function of (species, variant, seed).
 * - Output is unit-height: trunk base at y = 0, canopy top near y ≈ 1.
 *   Horizontal units are the same as vertical (the runtime's radial
 *   normalization maps `envelopeRadius` onto each stem's authored
 *   crown radius, so proportions — not absolute sizes — are authored here).
 * - Class P: no Babylon import, no Math.random, no Date.now.
 */

// ---------------------------------------------------------------------------
// Deterministic stream (same construction as prototypeGeometry.ts).
// ---------------------------------------------------------------------------

type RandomSource = () => number;

function hashText(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function createRandom(seed: string): RandomSource {
  let state = hashText(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// ---------------------------------------------------------------------------
// Vector helpers (plain objects, build-time only).
// ---------------------------------------------------------------------------

export interface SkeletonVec3 {
  x: number;
  y: number;
  z: number;
}

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;
const GOLDEN_ANGLE = 2.399963229728653;

function norm(v: SkeletonVec3): SkeletonVec3 {
  const length = Math.hypot(v.x, v.y, v.z);
  if (length < 1e-9) return { x: 0, y: 1, z: 0 };
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function cross(a: SkeletonVec3, b: SkeletonVec3): SkeletonVec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** Rotate `v` about unit `axis` by `angle` (Rodrigues). */
function rotateAbout(v: SkeletonVec3, axis: SkeletonVec3, angle: number): SkeletonVec3 {
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const k = cross(axis, v);
  const dot = axis.x * v.x + axis.y * v.y + axis.z * v.z;
  return {
    x: v.x * cosA + k.x * sinA + axis.x * dot * (1 - cosA),
    y: v.y * cosA + k.y * sinA + axis.y * dot * (1 - cosA),
    z: v.z * cosA + k.z * sinA + axis.z * dot * (1 - cosA),
  };
}

/** Any unit vector perpendicular to `axis`, deterministic. */
function perpendicular(axis: SkeletonVec3): SkeletonVec3 {
  const reference = Math.abs(axis.y) < 0.9
    ? { x: 0, y: 1, z: 0 }
    : { x: 1, y: 0, z: 0 };
  return norm(cross(reference, axis));
}

// ---------------------------------------------------------------------------
// Output shapes.
// ---------------------------------------------------------------------------

export interface TreeStem {
  /** 0 = trunk (or trunk fork), 1 = primary branch, 2 = secondary. */
  readonly level: number;
  /** Ring centres along the stem, base first. */
  readonly points: readonly SkeletonVec3[];
  /** Unit axis at each point (the segment direction, averaged at joints). */
  readonly axes: readonly SkeletonVec3[];
  /** Radius at each point (unit-height units). */
  readonly radii: readonly number[];
  /** Bark v-coordinate seed at the base (arc length from the tree base). */
  readonly vStart: number;
}

export interface LeafAnchor {
  /** Card centre. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Card facing (outward, pre-droop), unit. */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Card size multiplier around the species base card size. */
  readonly size: number;
  /** Stable per-anchor hash in [0, 1) for stride selection and jitter. */
  readonly pick: number;
}

/**
 * One palm frond: the rachis as a polyline plus the frame and leaflet reach
 * the meshing folds into a two-sided V. All of it is skeleton output, so the
 * frond strip, like a leaf card, consumes no RNG when it is meshed.
 */
export interface PalmFrond {
  /** Rachis points, petiole base first. */
  readonly points: readonly SkeletonVec3[];
  /** Unit rachis direction at each point. */
  readonly tangents: readonly SkeletonVec3[];
  /** Unit leaflet axis at each point, perpendicular to the tangent. */
  readonly sides: readonly SkeletonVec3[];
  /** Strip half-width at each point (unit-height units). */
  readonly halfWidths: readonly number[];
  /** `halfWidths` over the frond's widest leaflet: the texture's u reach. */
  readonly reach: readonly number[];
  /** Leaflet droop below the frond plane, radians — the V's half-angle. */
  readonly fold: number;
  /** 0 for the youngest (upright, central) frond, 1 for the oldest. */
  readonly age: number;
}

export interface TreeSkeleton {
  readonly stems: readonly TreeStem[];
  readonly anchors: readonly LeafAnchor[];
  /** Palm fronds; empty for every branching species. */
  readonly fronds: readonly PalmFrond[];
  /** Horizontal envelope over stems and card extents — the radial contract. */
  readonly envelopeRadius: number;
  /** Canopy vertical span (drives the interior core and dome normals). */
  readonly crownBaseY: number;
  readonly crownTopY: number;
  readonly crownCenter: SkeletonVec3;
  /** Species base card half-width in unit-height units. */
  readonly cardHalfWidth: number;
}

// ---------------------------------------------------------------------------
// Species presets. Values are hand-mapped from the Weber & Penn tables and
// the conifer construction in the wave-T research notes; the triangle
// estimator test in tests/ is what keeps them inside the band prices.
// ---------------------------------------------------------------------------

interface SpeciesPreset {
  readonly conifer: boolean;
  /** Trunk radius at the base as a fraction of unit height. */
  readonly trunkRadius: number;
  readonly taper: number;
  readonly flare: number;
  /** Trunk segments. */
  readonly trunkSegments: number;
  /** Total random trunk wander (degrees over the whole trunk). */
  readonly trunkCurveV: number;
  /** Decurrent trunks split this many times near the base (0 = excurrent). */
  readonly baseSplits: number;
  readonly splitAngle: number;
  /** Fraction of the trunk that stays branch-free. */
  readonly baseSize: number;
  /** Primary branch count over the branched region. */
  readonly branchCount: number;
  /** "spiral" golden-angle, "opposite" pairs, or conifer "whorl". */
  readonly arrangement: "spiral" | "opposite" | "whorl";
  readonly whorlSize: number;
  /** Branch pitch from the trunk axis (degrees) at the crown base... */
  readonly downAngleLow: number;
  /** ...and at the crown top (Weber&Penn's negative downAngleV). */
  readonly downAngleHigh: number;
  /** Branch length at the widest point, fraction of tree height. */
  readonly branchLength: number;
  readonly branchLengthV: number;
  /** ShapeRatio flavour: 0 conical, 1 spherical, 2 hemispherical, 7 flame. */
  readonly shape: 0 | 1 | 2 | 7;
  readonly branchSegments: number;
  /** Curvature along a branch: total pitch drift in degrees (+ = downward). */
  readonly branchCurve: number;
  readonly branchCurveV: number;
  /** Vertical tropism on outer segments (+ up, − weeping). */
  readonly attractionUp: number;
  readonly radiusPower: number;
  /** Secondaries per primary (broadleaf twig level; conifers use 0). */
  readonly secondaryCount: number;
  readonly secondaryLength: number;
  readonly secondaryDownAngle: number;
  /** Leaf-cluster cards per terminal stem. */
  readonly cardsPerStem: number;
  /** Base card half-width in unit-height units. */
  readonly cardHalfWidth: number;
  /** Downward droop blended into card facing (0..1). */
  readonly cardDroop: number;
}

/** Every species but the palm grows from the branching grammar below. */
export type BranchingTreeSpecies = Exclude<TreeSpecies, "palm">;

const SPECIES_PRESETS: Readonly<Record<BranchingTreeSpecies, SpeciesPreset>> = Object.freeze({
  pine: {
    conifer: true, trunkRadius: 0.014, taper: 0.85, flare: 0.45, trunkSegments: 8,
    trunkCurveV: 14, baseSplits: 0, splitAngle: 0, baseSize: 0.28,
    branchCount: 30, arrangement: "whorl", whorlSize: 5,
    downAngleLow: 104, downAngleHigh: 62,
    branchLength: 0.30, branchLengthV: 0.12, shape: 0, branchSegments: 3,
    branchCurve: 8, branchCurveV: 14, attractionUp: 0.25, radiusPower: 1.4,
    secondaryCount: 0, secondaryLength: 0, secondaryDownAngle: 0,
    cardsPerStem: 3, cardHalfWidth: 0.085, cardDroop: 0.42,
  },
  cedar: {
    conifer: true, trunkRadius: 0.016, taper: 0.8, flare: 0.6, trunkSegments: 8,
    trunkCurveV: 20, baseSplits: 0, splitAngle: 0, baseSize: 0.22,
    branchCount: 28, arrangement: "whorl", whorlSize: 4,
    downAngleLow: 98, downAngleHigh: 58,
    branchLength: 0.34, branchLengthV: 0.14, shape: 0, branchSegments: 3,
    branchCurve: -6, branchCurveV: 16, attractionUp: 0.45, radiusPower: 1.4,
    secondaryCount: 0, secondaryLength: 0, secondaryDownAngle: 0,
    cardsPerStem: 3, cardHalfWidth: 0.092, cardDroop: 0.3,
  },
  spruce: {
    conifer: true, trunkRadius: 0.013, taper: 0.9, flare: 0.4, trunkSegments: 8,
    trunkCurveV: 8, baseSplits: 0, splitAngle: 0, baseSize: 0.16,
    branchCount: 30, arrangement: "whorl", whorlSize: 6,
    downAngleLow: 112, downAngleHigh: 70,
    branchLength: 0.24, branchLengthV: 0.10, shape: 0, branchSegments: 3,
    branchCurve: 14, branchCurveV: 10, attractionUp: 0.35, radiusPower: 1.5,
    secondaryCount: 0, secondaryLength: 0, secondaryDownAngle: 0,
    cardsPerStem: 3, cardHalfWidth: 0.075, cardDroop: 0.5,
  },
  oak: {
    conifer: false, trunkRadius: 0.022, taper: 1.0, flare: 1.1, trunkSegments: 7,
    trunkCurveV: 42, baseSplits: 2, splitAngle: 24, baseSize: 0.3,
    branchCount: 13, arrangement: "spiral", whorlSize: 0,
    downAngleLow: 62, downAngleHigh: 34,
    branchLength: 0.42, branchLengthV: 0.16, shape: 2, branchSegments: 4,
    branchCurve: -14, branchCurveV: 46, attractionUp: 0.35, radiusPower: 1.3,
    secondaryCount: 3, secondaryLength: 0.42, secondaryDownAngle: 42,
    cardsPerStem: 4, cardHalfWidth: 0.115, cardDroop: 0.22,
  },
  maple: {
    conifer: false, trunkRadius: 0.019, taper: 1.0, flare: 0.8, trunkSegments: 7,
    trunkCurveV: 24, baseSplits: 0, splitAngle: 0, baseSize: 0.32,
    branchCount: 12, arrangement: "opposite", whorlSize: 0,
    downAngleLow: 48, downAngleHigh: 28,
    branchLength: 0.40, branchLengthV: 0.12, shape: 1, branchSegments: 4,
    branchCurve: -18, branchCurveV: 28, attractionUp: 0.5, radiusPower: 1.3,
    secondaryCount: 3, secondaryLength: 0.40, secondaryDownAngle: 38,
    cardsPerStem: 4, cardHalfWidth: 0.11, cardDroop: 0.2,
  },
  birch: {
    conifer: false, trunkRadius: 0.012, taper: 0.95, flare: 0.5, trunkSegments: 8,
    trunkCurveV: 18, baseSplits: 0, splitAngle: 0, baseSize: 0.34,
    branchCount: 12, arrangement: "spiral", whorlSize: 0,
    downAngleLow: 55, downAngleHigh: 32,
    branchLength: 0.30, branchLengthV: 0.12, shape: 7, branchSegments: 4,
    branchCurve: 18, branchCurveV: 24, attractionUp: -0.55, radiusPower: 1.2,
    secondaryCount: 2, secondaryLength: 0.44, secondaryDownAngle: 46,
    cardsPerStem: 4, cardHalfWidth: 0.085, cardDroop: 0.5,
  },
  willow: {
    conifer: false, trunkRadius: 0.026, taper: 1.05, flare: 0.9, trunkSegments: 7,
    trunkCurveV: 50, baseSplits: 2, splitAngle: 30, baseSize: 0.2,
    branchCount: 12, arrangement: "spiral", whorlSize: 0,
    downAngleLow: 40, downAngleHigh: 22,
    branchLength: 0.44, branchLengthV: 0.14, shape: 1, branchSegments: 5,
    branchCurve: 34, branchCurveV: 32, attractionUp: -1.9, radiusPower: 1.5,
    secondaryCount: 3, secondaryLength: 0.52, secondaryDownAngle: 30,
    cardsPerStem: 3, cardHalfWidth: 0.095, cardDroop: 0.75,
  },
});

export function treeSkeletonPreset(species: BranchingTreeSpecies): SpeciesPreset {
  return SPECIES_PRESETS[species];
}

/** Weber & Penn's ShapeRatio for the flavours the presets use. */
function shapeRatio(shape: SpeciesPreset["shape"], ratio: number): number {
  const t = clamp(ratio, 0, 1);
  switch (shape) {
    case 0: return 0.2 + 0.8 * t;
    case 1: return 0.2 + 0.8 * Math.sin(Math.PI * t);
    case 2: return 0.2 + 0.8 * Math.sin(0.5 * Math.PI * t);
    case 7: return t <= 0.7 ? 0.5 + 0.5 * (t / 0.7) : 0.5 + 0.5 * ((1 - t) / 0.3);
  }
}

// ---------------------------------------------------------------------------
// Skeleton construction.
// ---------------------------------------------------------------------------

interface MutableStem {
  level: number;
  points: SkeletonVec3[];
  axes: SkeletonVec3[];
  radii: number[];
  vStart: number;
}

interface GrowStemOptions {
  origin: SkeletonVec3;
  direction: SkeletonVec3;
  length: number;
  baseRadius: number;
  tipRadius: number;
  segments: number;
  /** Total deterministic pitch drift over the stem (radians, + = downward). */
  curve: number;
  /** Random per-segment wander amplitude (radians). */
  curveV: number;
  /** Vertical tropism per segment (+ pulls up, − weeps down). */
  attraction: number;
  level: number;
  vStart: number;
  rng: RandomSource;
}

/** March a stem chain; returns the stem and its per-point cumulative t. */
function growStem(options: GrowStemOptions): MutableStem {
  const {
    origin, length, baseRadius, tipRadius, segments, curve, curveV,
    attraction, level, vStart, rng,
  } = options;
  let direction = norm(options.direction);
  const points: SkeletonVec3[] = [{ ...origin }];
  const directions: SkeletonVec3[] = [];
  const segmentLength = length / segments;
  let position = { ...origin };
  for (let segment = 0; segment < segments; segment += 1) {
    if (segment > 0) {
      // Curvature: deterministic drift about the stem's horizontal side axis
      // plus random wander about a random horizontal-ish axis.
      const side = perpendicular(direction);
      const drift = curve / (segments - 1);
      const wander = (rng() * 2 - 1) * curveV;
      direction = rotateAbout(direction, side, drift + wander);
      // Tropism: rotate toward (or away from) +y, stronger near the tip.
      if (attraction !== 0) {
        const up = { x: 0, y: 1, z: 0 };
        const axis = cross(direction, up);
        const axisLength = Math.hypot(axis.x, axis.y, axis.z);
        if (axisLength > 1e-6) {
          const tipWeight = segment / segments;
          const declination = Math.acos(clamp(direction.y, -1, 1));
          const pull = attraction * declination * 0.14 * (0.4 + 0.6 * tipWeight);
          direction = rotateAbout(
            direction,
            { x: axis.x / axisLength, y: axis.y / axisLength, z: axis.z / axisLength },
            pull,
          );
        }
      }
    }
    directions.push(direction);
    position = {
      x: position.x + direction.x * segmentLength,
      y: position.y + direction.y * segmentLength,
      z: position.z + direction.z * segmentLength,
    };
    points.push({ ...position });
  }
  // Point axes: average adjacent segment directions at interior points.
  const axes: SkeletonVec3[] = points.map((_, index) => {
    const before = directions[Math.max(0, index - 1)]!;
    const after = directions[Math.min(directions.length - 1, index)]!;
    return norm({
      x: before.x + after.x,
      y: before.y + after.y,
      z: before.z + after.z,
    });
  });
  const radii = points.map((_, index) => {
    const t = index / (points.length - 1);
    return Math.max(lerp(baseRadius, tipRadius, Math.pow(t, 0.85)), 1e-4);
  });
  return { level, points, axes, radii, vStart };
}

/** Position and axis at a parametric offset along a stem. */
function stemAt(stem: MutableStem, t: number): {
  point: SkeletonVec3;
  axis: SkeletonVec3;
  radius: number;
} {
  const clamped = clamp(t, 0, 1);
  const scaled = clamped * (stem.points.length - 1);
  const index = Math.min(stem.points.length - 2, Math.floor(scaled));
  const fraction = scaled - index;
  const a = stem.points[index]!;
  const b = stem.points[index + 1]!;
  return {
    point: {
      x: lerp(a.x, b.x, fraction),
      y: lerp(a.y, b.y, fraction),
      z: lerp(a.z, b.z, fraction),
    },
    axis: stem.axes[fraction > 0.5 ? index + 1 : index]!,
    radius: lerp(stem.radii[index]!, stem.radii[index + 1]!, fraction),
  };
}

export function buildTreeSkeleton(
  species: TreeSpecies,
  variant: number,
  seed: number,
): TreeSkeleton {
  if (species === "palm") return buildPalmSkeleton(variant, seed);
  const preset = SPECIES_PRESETS[species];
  const rng = createRandom(`tree-skeleton/${species}/${variant}/${seed}`);
  const stems: MutableStem[] = [];
  const anchors: LeafAnchor[] = [];

  // --- Trunk(s) --------------------------------------------------------
  // Decurrent species split the upper trunk into co-dominant forks; the
  // shared lower bole is one stem and each fork continues from its top.
  const trunkTop = preset.baseSplits > 0 ? 0.42 + rng() * 0.08 : 1;
  const trunk = growStem({
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 1, z: 0 },
    length: trunkTop,
    baseRadius: preset.trunkRadius,
    tipRadius: preset.baseSplits > 0
      ? preset.trunkRadius * 0.72
      : preset.trunkRadius * 0.08,
    segments: preset.trunkSegments,
    curve: 0,
    curveV: preset.trunkCurveV * DEG / preset.trunkSegments,
    attraction: 0.4,
    level: 0,
    vStart: 0,
    rng,
  });
  stems.push(trunk);

  /** Stems that may carry primary branches, with their vertical span. */
  const parentStems: Array<{ stem: MutableStem; spanLow: number; spanHigh: number }> = [];
  if (preset.baseSplits > 0) {
    const forkCount = preset.baseSplits;
    const forkAzimuth = rng() * TWO_PI;
    const top = trunk.points[trunk.points.length - 1]!;
    const topRadius = trunk.radii[trunk.radii.length - 1]!;
    for (let fork = 0; fork < forkCount; fork += 1) {
      const azimuth = forkAzimuth + (fork / forkCount) * TWO_PI + (rng() - 0.5) * 0.9;
      const pitch = (preset.splitAngle + (rng() - 0.5) * 10) * DEG;
      const direction = norm({
        x: Math.sin(pitch) * Math.cos(azimuth),
        y: Math.cos(pitch),
        z: Math.sin(pitch) * Math.sin(azimuth),
      });
      const forkStem = growStem({
        origin: { ...top },
        direction,
        length: (1 - trunkTop) * (0.9 + rng() * 0.25),
        // da Vinci for an n-way fork: r_child = r_parent / n^(1/2).
        baseRadius: topRadius / Math.sqrt(forkCount),
        tipRadius: topRadius * 0.05,
        segments: Math.max(3, preset.trunkSegments - 3),
        curve: -0.15,
        curveV: preset.trunkCurveV * DEG / preset.trunkSegments,
        attraction: 0.9,
        level: 0,
        vStart: trunkTop,
        rng,
      });
      stems.push(forkStem);
      parentStems.push({ stem: forkStem, spanLow: 0.06, spanHigh: 0.96 });
    }
  } else {
    parentStems.push({ stem: trunk, spanLow: preset.baseSize, spanHigh: 0.96 });
  }

  // --- Primary branches -------------------------------------------------
  const terminalStems: MutableStem[] = [];
  for (const parent of parentStems) {
    const branchTotal = Math.max(
      2,
      Math.round(preset.branchCount / parentStems.length * (0.9 + rng() * 0.2)),
    );
    let azimuth = rng() * TWO_PI;
    for (let branch = 0; branch < branchTotal; branch += 1) {
      // Stratified placement along the branched span with in-slot jitter.
      const along = parent.spanLow
        + ((branch + 0.35 + rng() * 0.3) / branchTotal)
          * (parent.spanHigh - parent.spanLow);
      const at = stemAt(parent.stem, along);
      // Height fraction over the branched region drives both length falloff
      // and the down-angle blend (Weber&Penn's negative downAngleV).
      const heightFraction = (along - parent.spanLow)
        / Math.max(parent.spanHigh - parent.spanLow, 1e-6);
      if (preset.arrangement === "whorl") {
        azimuth = (Math.floor(branch / preset.whorlSize) * GOLDEN_ANGLE)
          + ((branch % preset.whorlSize) / preset.whorlSize) * TWO_PI
          + rng() * 0.24;
      } else if (preset.arrangement === "opposite") {
        azimuth += branch % 2 === 0 ? Math.PI : Math.PI / 2 + (rng() - 0.5) * 0.3;
      } else {
        azimuth += GOLDEN_ANGLE + (rng() - 0.5) * 0.5;
      }
      const downAngle = lerp(preset.downAngleLow, preset.downAngleHigh, heightFraction)
        * DEG * (0.94 + rng() * 0.12);
      // Branch frame: pitch away from the parent axis toward `azimuth`.
      const parentAxis = at.axis;
      const side = norm(rotateAbout(perpendicular(parentAxis), parentAxis, azimuth));
      const direction = norm(rotateAbout(parentAxis, cross(parentAxis, side), -downAngle));
      const lengthFalloff = preset.conifer
        ? shapeRatio(preset.shape, 1 - heightFraction)
        : shapeRatio(preset.shape, heightFraction);
      const length = preset.branchLength
        * lengthFalloff
        * (1 + (rng() * 2 - 1) * preset.branchLengthV);
      if (length < 0.03) continue;
      const baseRadius = Math.min(
        at.radius * 0.85,
        Math.max(
          at.radius * Math.pow(clamp(length / Math.max(trunkTop, 0.3), 0.05, 1), preset.radiusPower),
          0.0016,
        ),
      );
      const stem = growStem({
        origin: at.point,
        direction,
        length,
        baseRadius,
        tipRadius: Math.max(baseRadius * 0.12, 0.0008),
        segments: preset.branchSegments,
        curve: preset.branchCurve * DEG,
        curveV: preset.branchCurveV * DEG / preset.branchSegments,
        attraction: preset.attractionUp,
        level: 1,
        vStart: along,
        rng,
      });
      stems.push(stem);
      if (preset.secondaryCount > 0) {
        // --- Secondaries (broadleaf twig level) -----------------------
        let secondaryAzimuth = rng() * TWO_PI;
        for (let secondary = 0; secondary < preset.secondaryCount; secondary += 1) {
          const alongBranch = 0.35 + ((secondary + rng() * 0.6) / preset.secondaryCount) * 0.6;
          const atBranch = stemAt(stem, alongBranch);
          secondaryAzimuth += GOLDEN_ANGLE + (rng() - 0.5) * 0.6;
          const secondarySide = norm(rotateAbout(
            perpendicular(atBranch.axis),
            atBranch.axis,
            secondaryAzimuth,
          ));
          const secondaryDirection = norm(rotateAbout(
            atBranch.axis,
            cross(atBranch.axis, secondarySide),
            -(preset.secondaryDownAngle + (rng() - 0.5) * 16) * DEG,
          ));
          const secondaryLength = length * preset.secondaryLength * (0.75 + rng() * 0.5);
          if (secondaryLength < 0.02) continue;
          const secondaryStem = growStem({
            origin: atBranch.point,
            direction: secondaryDirection,
            length: secondaryLength,
            baseRadius: Math.min(atBranch.radius * 0.7, Math.max(atBranch.radius * 0.55, 0.0009)),
            tipRadius: 0.0006,
            segments: 2,
            curve: preset.branchCurve * DEG * 0.5,
            curveV: preset.branchCurveV * DEG * 0.4,
            attraction: preset.attractionUp * 0.7,
            level: 2,
            vStart: alongBranch,
            rng,
          });
          stems.push(secondaryStem);
          terminalStems.push(secondaryStem);
        }
        terminalStems.push(stem);
      } else {
        terminalStems.push(stem);
      }
    }
  }

  // --- Leaf-cluster anchors ---------------------------------------------
  for (const stem of terminalStems) {
    const cards = stem.level >= 2 ? preset.cardsPerStem : Math.max(2, preset.cardsPerStem - 1);
    for (let card = 0; card < cards; card += 1) {
      const along = stem.level >= 2
        ? 0.45 + ((card + rng() * 0.7) / cards) * 0.55
        : 0.55 + ((card + rng() * 0.7) / cards) * 0.45;
      const at = stemAt(stem, Math.min(along, 1));
      // Face outward from the trunk axis, blended with the stem direction,
      // then drooped toward the ground per species.
      const radial = Math.hypot(at.point.x, at.point.z);
      const outward = radial > 0.02
        ? { x: at.point.x / radial, y: 0, z: at.point.z / radial }
        : perpendicular(at.axis);
      let facing = norm({
        x: outward.x * 0.55 + at.axis.x * 0.6,
        y: outward.y * 0.55 + at.axis.y * 0.6 + 0.45,
        z: outward.z * 0.55 + at.axis.z * 0.6,
      });
      facing = norm({
        x: facing.x,
        y: lerp(facing.y, -0.75, preset.cardDroop * (0.5 + rng() * 0.5) * 0.6),
        z: facing.z,
      });
      const jitter = 0.35 + rng() * 0.45;
      anchors.push({
        x: at.point.x + facing.x * preset.cardHalfWidth * jitter,
        y: at.point.y + facing.y * preset.cardHalfWidth * jitter,
        z: at.point.z + facing.z * preset.cardHalfWidth * jitter,
        nx: facing.x,
        ny: facing.y,
        nz: facing.z,
        size: 0.8 + rng() * 0.5,
        pick: rng(),
      });
    }
  }

  // --- Envelope / canopy bounds -----------------------------------------
  let envelopeRadius = 0.02;
  let crownBaseY = Number.POSITIVE_INFINITY;
  let crownTopY = 0;
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  for (const anchor of anchors) {
    const extent = preset.cardHalfWidth * anchor.size;
    envelopeRadius = Math.max(envelopeRadius, Math.hypot(anchor.x, anchor.z) + extent);
    crownBaseY = Math.min(crownBaseY, anchor.y - extent);
    crownTopY = Math.max(crownTopY, anchor.y + extent);
    sumX += anchor.x;
    sumY += anchor.y;
    sumZ += anchor.z;
  }
  for (const stem of stems) {
    for (const point of stem.points) {
      envelopeRadius = Math.max(envelopeRadius, Math.hypot(point.x, point.z));
      crownTopY = Math.max(crownTopY, point.y);
    }
  }
  if (!Number.isFinite(crownBaseY)) crownBaseY = 0.3;
  crownBaseY = Math.max(crownBaseY, 0.05);
  crownTopY = Math.max(crownTopY, crownBaseY + 0.1);
  const anchorCount = Math.max(anchors.length, 1);

  // Normalize to unit height: the decode contract multiplies y by the stem's
  // authored heightMeters, so the skeleton's top must land at ~1.0 or every
  // tree renders taller than its authored height (and taller than the
  // instance record's culling bounds assume). Uniform scale keeps every
  // proportion; radii and card sizes scale with it.
  const heightScale = 1 / Math.max(crownTopY, 1e-3);
  if (Math.abs(heightScale - 1) > 1e-6) {
    for (const stem of stems) {
      for (let index = 0; index < stem.points.length; index += 1) {
        const point = stem.points[index]!;
        point.x *= heightScale;
        point.y *= heightScale;
        point.z *= heightScale;
        stem.radii[index] = stem.radii[index]! * heightScale;
      }
    }
    for (let index = 0; index < anchors.length; index += 1) {
      const anchor = anchors[index]!;
      anchors[index] = {
        ...anchor,
        x: anchor.x * heightScale,
        y: anchor.y * heightScale,
        z: anchor.z * heightScale,
      };
    }
  }
  return {
    stems,
    anchors,
    fronds: [],
    envelopeRadius: envelopeRadius * heightScale,
    crownBaseY: crownBaseY * heightScale,
    crownTopY: crownTopY * heightScale,
    crownCenter: anchors.length > 0
      ? {
        x: (sumX / anchorCount) * heightScale,
        y: (sumY / anchorCount) * heightScale,
        z: (sumZ / anchorCount) * heightScale,
      }
      : { x: 0, y: 0.65, z: 0 },
    cardHalfWidth: preset.cardHalfWidth * heightScale,
  };
}

// ---------------------------------------------------------------------------
// Palm (tropical coast). A coconut palm is not a branching tree, so it does
// not go through the stem grammar above: one unbranched, leaning trunk that
// turns back up toward the light, and a spiral crown of pinnate fronds that
// rise when young and arch over and droop as they age. Proportions follow a
// mature Cocos nucifera (trunk ~16 m, fronds ~5 m with ~1 m leaflets, ~20
// fronds alive at once); the normalization below makes them unit-height.
// ---------------------------------------------------------------------------

/** Rachis segments per frond; the near band meshes every one. */
export const PALM_FROND_SEGMENTS = 8;

/**
 * Leaflet rake toward the frond tip, in texture texels along per texel
 * across. The strip maps the frond's length onto v and two leaflet lengths
 * onto u, and a 5.3 m frond is ~5x its 1.07 m leaflet, so 0.31 is the ~38
 * degree forward angle coconut leaflets hold against the rachis.
 */
export const PALM_FROND_RAKE = 0.31;

/**
 * Leaflet length along a frond (0 petiole, 1 tip) as a fraction of the
 * widest pair: a bare petiole, the longest leaflets just before mid-frond,
 * and short ones at the tip. The foliage atlas draws leaflets to this curve
 * and the strip's edge follows it, so the two cannot drift apart.
 */
export function palmLeafletProfile(t: number): number {
  const u = clamp(t, 0, 1);
  const rise = clamp((u - 0.08) / 0.22, 0, 1);
  const fall = u > 0.38 ? (u - 0.38) / 0.62 : 0;
  return rise * rise * (3 - 2 * rise) * (1 - 0.7 * fall * fall);
}

/**
 * The strip's edge at rachis point `index` of `frond`: out along the
 * leaflet axis and down by the fold, so the two halves meet at the rachis
 * as an inverted V. `widthScale` widens a decimated band's strips.
 */
export function palmFrondEdge(
  frond: PalmFrond,
  index: number,
  sign: -1 | 1,
  widthScale = 1,
): SkeletonVec3 {
  const point = frond.points[index]!;
  const tangent = frond.tangents[index]!;
  const side = frond.sides[index]!;
  const normal = norm(cross(side, tangent));
  const width = frond.halfWidths[index]! * widthScale;
  const across = Math.cos(frond.fold);
  const down = Math.sin(frond.fold);
  return {
    x: point.x + width * (sign * side.x * across - normal.x * down),
    y: point.y + width * (sign * side.y * across - normal.y * down),
    z: point.z + width * (sign * side.z * across - normal.z * down),
  };
}

function buildPalmSkeleton(variant: number, seed: number): TreeSkeleton {
  const rng = createRandom(`tree-skeleton/palm/${variant}/${seed}`);

  // --- Trunk -------------------------------------------------------------
  // Leans from the base and recovers toward vertical with height, with a
  // gentle sideways S; the base swells into the bole.
  const trunkSegments = 10;
  const trunkLength = 0.84 + rng() * 0.04;
  const lean = (5 + rng() * 13) * DEG;
  const leanAzimuth = rng() * TWO_PI;
  const recovery = 0.45 + rng() * 0.35;
  const sway = (rng() - 0.5) * 6 * DEG;
  const swayPhase = rng() * TWO_PI;
  const trunkRadius = 0.0095 * (0.92 + rng() * 0.16);
  const flare = 0.75 + rng() * 0.3;
  const leanX = Math.cos(leanAzimuth);
  const leanZ = Math.sin(leanAzimuth);
  const trunkPoints: SkeletonVec3[] = [{ x: 0, y: 0, z: 0 }];
  const trunkDirections: SkeletonVec3[] = [];
  const segmentLength = trunkLength / trunkSegments;
  let position: SkeletonVec3 = { x: 0, y: 0, z: 0 };
  for (let segment = 0; segment < trunkSegments; segment += 1) {
    const t = (segment + 0.5) / trunkSegments;
    const tilt = lean * (1 - recovery * t * t * (3 - 2 * t));
    const lateral = sway * Math.sin(TWO_PI * t + swayPhase);
    const direction = norm({
      x: Math.sin(tilt) * leanX - Math.sin(lateral) * leanZ,
      y: Math.cos(tilt),
      z: Math.sin(tilt) * leanZ + Math.sin(lateral) * leanX,
    });
    trunkDirections.push(direction);
    position = {
      x: position.x + direction.x * segmentLength,
      y: position.y + direction.y * segmentLength,
      z: position.z + direction.z * segmentLength,
    };
    trunkPoints.push({ ...position });
  }
  const trunkAxes = trunkPoints.map((_, index) => {
    const before = trunkDirections[Math.max(0, index - 1)]!;
    const after = trunkDirections[Math.min(trunkDirections.length - 1, index)]!;
    return norm({ x: before.x + after.x, y: before.y + after.y, z: before.z + after.z });
  });
  const trunkRadii = trunkPoints.map((_, index) => {
    const t = index / trunkSegments;
    return trunkRadius * (1 + flare * Math.pow(1 - t, 10)) * (1 - 0.16 * t);
  });
  const trunk: MutableStem = {
    level: 0,
    points: trunkPoints,
    axes: trunkAxes,
    radii: trunkRadii,
    vStart: 0,
  };

  // --- Fronds ------------------------------------------------------------
  // Golden-angle spiral, youngest first: pitch from near-vertical to past
  // horizontal with age, a droop concentrated in the thin outer rachis, and
  // a leaflet V that opens wider on old fronds. Older fronds attach a little
  // lower on the crown shaft.
  const top = trunkPoints[trunkPoints.length - 1]!;
  const topRadius = trunkRadii[trunkRadii.length - 1]!;
  const frondCount = 18 + Math.floor(rng() * 6);
  const frondLength = 0.33 + rng() * 0.05;
  const frondHalfWidth = frondLength * 0.2;
  const bendWeights: number[] = [];
  for (let segment = 0; segment < PALM_FROND_SEGMENTS; segment += 1) {
    bendWeights.push(Math.pow((segment + 0.5) / PALM_FROND_SEGMENTS, 1.3));
  }
  const bendTotal = bendWeights.reduce((sum, weight) => sum + weight, 0);
  const fronds: PalmFrond[] = [];
  let azimuth = rng() * TWO_PI;
  for (let frond = 0; frond < frondCount; frond += 1) {
    const age = frond / (frondCount - 1);
    azimuth += GOLDEN_ANGLE + (rng() - 0.5) * 0.3;
    const pitch = (lerp(14, 112, Math.pow(age, 0.75)) + (rng() - 0.5) * 12) * DEG;
    // Old fronds arch over until their tips hang, but never fold back past
    // ~175 degrees from vertical into the trunk.
    const droop = Math.min(
      lerp(30, 100, Math.pow(age, 0.8)) * DEG * (0.85 + rng() * 0.3),
      175 * DEG - pitch,
    );
    const youth = clamp(age / 0.35, 0, 1);
    const senescence = clamp((age - 0.85) / 0.15, 0, 1);
    const length = frondLength
      * (0.7 + 0.3 * youth * youth * (3 - 2 * youth))
      * (1 - 0.12 * senescence)
      * (0.93 + rng() * 0.14);
    const fold = lerp(24, 50, age) * DEG * (0.9 + rng() * 0.2);
    const twist = (rng() - 0.5) * 10 * DEG;
    const outwardX = Math.cos(azimuth);
    const outwardZ = Math.sin(azimuth);
    const side0: SkeletonVec3 = { x: -outwardZ, y: 0, z: outwardX };
    // Rotating about -side0 by a positive angle pitches the rachis down.
    const droopAxis: SkeletonVec3 = { x: outwardZ, y: 0, z: -outwardX };
    let direction = norm({
      x: Math.sin(pitch) * outwardX,
      y: Math.cos(pitch),
      z: Math.sin(pitch) * outwardZ,
    });
    const points: SkeletonVec3[] = [{
      x: top.x + outwardX * topRadius * 0.8,
      y: top.y - age * 0.028,
      z: top.z + outwardZ * topRadius * 0.8,
    }];
    const directions: SkeletonVec3[] = [];
    const step = length / PALM_FROND_SEGMENTS;
    for (let segment = 0; segment < PALM_FROND_SEGMENTS; segment += 1) {
      direction = rotateAbout(direction, droopAxis, droop * bendWeights[segment]! / bendTotal);
      direction = norm(rotateAbout(direction, { x: 0, y: 1, z: 0 }, twist / PALM_FROND_SEGMENTS));
      directions.push(direction);
      const last = points[points.length - 1]!;
      points.push({
        x: last.x + direction.x * step,
        y: last.y + direction.y * step,
        z: last.z + direction.z * step,
      });
    }
    const tangents = points.map((_, index) => {
      const before = directions[Math.max(0, index - 1)]!;
      const after = directions[Math.min(directions.length - 1, index)]!;
      return norm({ x: before.x + after.x, y: before.y + after.y, z: before.z + after.z });
    });
    const sides = tangents.map((tangent) => {
      const along = side0.x * tangent.x + side0.y * tangent.y + side0.z * tangent.z;
      return norm({
        x: side0.x - tangent.x * along,
        y: side0.y - tangent.y * along,
        z: side0.z - tangent.z * along,
      });
    });
    const leafletHalfWidth = frondHalfWidth * (length / frondLength);
    const reach = points.map((_, index) => clamp(
      palmLeafletProfile(index / PALM_FROND_SEGMENTS) + 0.04,
      0.12,
      1,
    ));
    fronds.push({
      points,
      tangents,
      sides,
      halfWidths: reach.map((fraction) => fraction * leafletHalfWidth),
      reach,
      fold,
      age,
    });
  }

  // --- Envelope / canopy bounds -----------------------------------------
  let envelopeRadius = 0.02;
  let crownBaseY = Number.POSITIVE_INFINITY;
  let crownTopY = 0;
  for (const point of trunkPoints) {
    envelopeRadius = Math.max(envelopeRadius, Math.hypot(point.x, point.z));
    crownTopY = Math.max(crownTopY, point.y);
  }
  for (const frond of fronds) {
    for (let index = 0; index < frond.points.length; index += 1) {
      for (const point of [
        frond.points[index]!,
        palmFrondEdge(frond, index, -1),
        palmFrondEdge(frond, index, 1),
      ]) {
        envelopeRadius = Math.max(envelopeRadius, Math.hypot(point.x, point.z));
        crownTopY = Math.max(crownTopY, point.y);
        crownBaseY = Math.min(crownBaseY, point.y);
      }
    }
  }

  // Unit height, exactly as the branching builder normalizes.
  const heightScale = 1 / Math.max(crownTopY, 1e-3);
  const scalePoint = (point: SkeletonVec3): SkeletonVec3 => ({
    x: point.x * heightScale,
    y: point.y * heightScale,
    z: point.z * heightScale,
  });
  const scaledTrunk: MutableStem = {
    ...trunk,
    points: trunk.points.map(scalePoint),
    radii: trunk.radii.map((radius) => radius * heightScale),
  };
  const scaledFronds = fronds.map((frond) => ({
    ...frond,
    points: frond.points.map(scalePoint),
    halfWidths: frond.halfWidths.map((width) => width * heightScale),
  }));
  return {
    stems: [scaledTrunk],
    anchors: [],
    fronds: scaledFronds,
    envelopeRadius: envelopeRadius * heightScale,
    crownBaseY: crownBaseY * heightScale,
    crownTopY: crownTopY * heightScale,
    crownCenter: scalePoint(top),
    cardHalfWidth: frondHalfWidth * heightScale,
  };
}

/**
 * Closed-form triangle estimate for a meshed skeleton — part of the authoring
 * loop (a preset that silently blows the band price is a test failure, not a
 * capture surprise). Mirrors prototypeGeometry's meshing arithmetic:
 * tube walls = 2 · sides · (rings − 1); cards = 2 triangles each.
 */
export interface SkeletonMeshBudget {
  readonly trunkSides: number;
  readonly branchSides: number;
  readonly twigSides: number;
  /** Stems with base radius below this are not meshed at all. */
  readonly minimumMeshRadius: number;
  /** Keep every k-th interior ring (first and last always kept). */
  readonly ringStride: number;
  /** Fraction of level-2 stems meshed (1 near, 0 mid). */
  readonly twigShare: number;
  /** Keep every k-th leaf card. */
  readonly cardStride: number;
  /** Card size multiplier compensating the stride. */
  readonly cardScale: number;
  /** Palms: keep every k-th frond (the youngest always kept). */
  readonly frondStride: number;
  /** Palms: keep every k-th rachis point (first and last always kept). */
  readonly frondSegmentStride: number;
  /** Palms: strip width multiplier compensating the frond stride. */
  readonly frondWidthScale: number;
}

/** Rachis point indices a budget keeps: every stride-th, plus the tip. */
export function palmFrondPointIndices(budget: SkeletonMeshBudget): readonly number[] {
  const indices: number[] = [];
  for (let index = 0; index < PALM_FROND_SEGMENTS; index += budget.frondSegmentStride) {
    indices.push(index);
  }
  indices.push(PALM_FROND_SEGMENTS);
  return indices;
}

/** Whether a budget meshes frond `index` (fronds are youngest first). */
export function palmFrondKept(budget: SkeletonMeshBudget, index: number): boolean {
  return index % budget.frondStride === 0;
}

export function estimateSkeletonTriangles(
  skeleton: TreeSkeleton,
  budget: SkeletonMeshBudget,
): number {
  let triangles = 0;
  let twigCounter = 0;
  for (const stem of skeleton.stems) {
    if (stem.radii[0]! < budget.minimumMeshRadius) continue;
    if (stem.level >= 2) {
      twigCounter += 1;
      if (budget.twigShare <= 0) continue;
      if ((twigCounter * budget.twigShare) % 1 >= budget.twigShare) continue;
    }
    const sides = stem.level === 0
      ? budget.trunkSides
      : stem.level === 1 ? budget.branchSides : budget.twigSides;
    const interior = Math.max(0, stem.points.length - 2);
    const rings = 2 + Math.floor(interior / budget.ringStride);
    triangles += 2 * sides * (rings - 1) + sides;
  }
  const cards = Math.ceil(skeleton.anchors.length / budget.cardStride);
  triangles += cards * 2;
  // Palm fronds: two half-strips (the V) of two triangles per kept segment.
  const frondSegments = palmFrondPointIndices(budget).length - 1;
  skeleton.fronds.forEach((_, index) => {
    if (palmFrondKept(budget, index)) triangles += 2 * frondSegments * 2;
  });
  return triangles;
}
