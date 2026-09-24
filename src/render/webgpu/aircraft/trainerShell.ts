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
