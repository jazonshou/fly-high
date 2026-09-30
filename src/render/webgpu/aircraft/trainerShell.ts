import type { LoftSection } from "./builders";

/**
 * The Cessna's fuselage loft, section by section: cowl, cabin tube and tailcone.
 *
 * Its own module because two files need the SAME numbers and neither may hold a
 * copy. `trainerVisual` lofts the exterior shell from them, and the cockpit
 * builds a cowl stand-in from the sections forward of the firewall
 * (`cockpit/trainerCockpit.ts`), because the real cowl lives inside a tube that
 * the cockpit camera cannot show. A copy of these would drift the first time
 * the fuselage was reshaped, and the stand-in would then be a visibly different
 * cowl from the one the aeroplane has.
 *
 * `squareness` carries the type. A Continental O-200 lies on its side, so the
 * cowl is WIDER THAN IT IS DEEP and nearly rectangular in section (zRadius >
 * yRadius at x = 3.70, squareness 2.6); the cabin is a flat-sided box with a
 * flat deck (squareness 6, which is what lets the glass sit on it without
 * mushrooming out over a rounded crown); the tailcone is a plain ellipse.
 *
 * The cabin sections stop at y = 0.00. That is the WINDOW SILL, not the roof:
 * everything above it is the greenhouse, built separately in glass. It also
 * means the cabin section is a CLOSED tube whose top skin is that sill, which a
 * pilot whose eye is above it (y 0.12) looks down onto the outside of.
 */
export const TRAINER_FUSELAGE_SECTIONS: readonly LoftSection[] = Object.freeze([
  { x: -3.2, yRadius: 0.085, zRadius: 0.065, yOffset: 0.175 },
  { x: -1.9, yRadius: 0.215, zRadius: 0.185, yOffset: 0.03, squareness: 2.2 },
  { x: -0.7, yRadius: 0.44, zRadius: 0.33, yOffset: -0.23, squareness: 3.2 },
  { x: 0.3, yRadius: 0.39, zRadius: 0.505, yOffset: -0.39, squareness: 6 },
  { x: 1.6, yRadius: 0.39, zRadius: 0.505, yOffset: -0.39, squareness: 6 },
  { x: 2.42, yRadius: 0.28, zRadius: 0.45, yOffset: -0.34, squareness: 4.5 },
  { x: 3.7, yRadius: 0.17, zRadius: 0.29, yOffset: -0.17, squareness: 2.6 },
].map((section) => Object.freeze(section)));

/**
 * The greenhouse's glass loft, section by section (18 segments round): windscreen, door windows and the
 * "omni-vision" rear window in one closed body (`trainerVisual`). Here for the same reason as the fuselage's: the
 * cockpit keeps every part it builds a set distance INSIDE the glass (the deck, the board, the pillars), and it has
 * to measure against the numbers the glass is lofted from, not a copy of them.
 */
export const TRAINER_CANOPY_SECTIONS: readonly LoftSection[] = Object.freeze([
  { x: -0.7, yRadius: 0.12, zRadius: 0.205, yOffset: 0.055, squareness: 2.6 },
  { x: -0.3, yRadius: 0.2, zRadius: 0.415, yOffset: 0.01, squareness: 3.2 },
  { x: 0.26, yRadius: 0.22, zRadius: 0.44, squareness: 4 },
  { x: 1.6, yRadius: 0.22, zRadius: 0.44, squareness: 4 },
  { x: 2, yRadius: 0.2, zRadius: 0.415, yOffset: -0.01, squareness: 3.6 },
  { x: 2.24, yRadius: 0.105, zRadius: 0.345, yOffset: -0.06, squareness: 3 },
].map((section) => Object.freeze(section)));

/**
 * THE WINDSCREEN CENTRE FRAME (the Cessna pass, S5), shared by the shell that builds it (`trainerVisual`) and the
 * cockpit, whose compass hangs from it. One tapered, flattened strip on the old axis: up the windscreen from its FOOT
 * (buried `bury` on past it, under the cowl deck) to its CORNER, round a FILLET of `bendRadius` there (where a ball
 * joined two round bars), and aft along the glass crown INTO THE ROOF slab. Its section is an ellipse `width` across
 * (over the glass) and `depth` through, both tapering from the foot's to the end's: a windscreen's centre strip, not a
 * round bar.
 */
export const TRAINER_CENTRE_FRAME = Object.freeze({
  foot: Object.freeze({ x: 2.26, y: -0.02 }),
  bury: 0.1,
  corner: Object.freeze({ x: 2, y: 0.21 }),
  intoRoof: Object.freeze({ x: 1.6, y: 0.205 }),
  bendRadius: 0.06,
  /** Across the glass, and through it, at the buried foot and at the end in the roof. */
  footWidth: 0.034,
  footDepth: 0.022,
  endWidth: 0.024,
  endDepth: 0.016,
  bendStations: 8,
  segments: 24,
});

/** The strip's centreline (in the aircraft's x-y plane at z 0) and its half-width and half-depth at each point, foot to end. */
export function trainerCentreFramePath(): { points: { x: number; y: number }[]; halfWidths: number[]; halfDepths: number[] } {
  const f = TRAINER_CENTRE_FRAME;
  const unit = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  };
  const up = unit(f.foot, f.corner);
  const aft = unit(f.corner, f.intoRoof);
  const start = { x: f.foot.x - up.x * f.bury, y: f.foot.y - up.y * f.bury };
  // the fillet: tangent to both runs, `bendRadius` round, its tangent points `bendRadius * tan(turn / 2)` from the corner
  const turn = Math.acos(up.x * aft.x + up.y * aft.y);
  const reach = f.bendRadius * Math.tan(turn / 2);
  const inTo = { x: f.corner.x - up.x * reach, y: f.corner.y - up.y * reach };
  const outOf = { x: f.corner.x + aft.x * reach, y: f.corner.y + aft.y * reach };
  // the bend's centre, `bendRadius` from `inTo` square to the upward run, on the inside of the turn
  const side = up.x * aft.y - up.y * aft.x > 0 ? 1 : -1;
  const centre = { x: inTo.x - side * up.y * f.bendRadius, y: inTo.y + side * up.x * f.bendRadius };
  const a0 = Math.atan2(inTo.y - centre.y, inTo.x - centre.x);
  const a1 = Math.atan2(outOf.y - centre.y, outOf.x - centre.x);
  let sweep = a1 - a0;
  if (sweep > Math.PI) sweep -= 2 * Math.PI;
  if (sweep < -Math.PI) sweep += 2 * Math.PI;
  const bend = Array.from({ length: f.bendStations + 1 }, (_, k) => {
    const a = a0 + (sweep * k) / f.bendStations;
    return { x: centre.x + f.bendRadius * Math.cos(a), y: centre.y + f.bendRadius * Math.sin(a) };
  });
  const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const points = [
    ...[0, 0.25, 0.5, 0.75].map((t) => lerp(start, inTo, t)),
    ...bend,
    ...[0.25, 0.5, 0.75, 1].map((t) => lerp(outOf, f.intoRoof, t)),
  ];
  const along = [0];
  for (let i = 1; i < points.length; i += 1) along.push(along[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
  const length = along[along.length - 1]!;
  return {
    points,
    halfWidths: along.map((s) => (f.footWidth + ((f.endWidth - f.footWidth) * s) / length) / 2),
    halfDepths: along.map((s) => (f.footDepth + ((f.endDepth - f.footDepth) * s) / length) / 2),
  };
}

/** The strip's half-depth (through the glass) at station x on its aft run along the crown, and its axis's height there. */
export function trainerCentreFrameCrownAt(x: number): { y: number; halfDepth: number } {
  const { points, halfDepths } = trainerCentreFramePath();
  for (let i = points.length - 1; i > 0; i -= 1) {
    const [a, b] = [points[i - 1]!, points[i]!];
    if ((a.x - x) * (b.x - x) <= 0 && a.x !== b.x) {
      const t = (x - a.x) / (b.x - a.x);
      return { y: a.y + (b.y - a.y) * t, halfDepth: halfDepths[i - 1]! + (halfDepths[i]! - halfDepths[i - 1]!) * t };
    }
  }
  throw new RangeError(`the centre frame's crown does not pass x ${x}`);
}
