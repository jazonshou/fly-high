import { describe, expect, it } from "vitest";
import { BoatSimulator, HULL_TRANSOM_CHINE_BEAM, KNOT, savitskyPlaning, towEquilibrium } from "../src/sim/boat";
import { HULL_TRANSOM, RUNABOUT_21_CG } from "../src/vehicles/boat/hullLines";

/**
 * The oracle: the strip model's bare hull, towed through its CG and free to
 * heave and trim, against Savitsky's 1964 steady-planing equations for the
 * prismatic hull of the same chine beam, deadrise, CG and weight. Held where
 * the equations hold: fully planing (C_V >= 2) and with the chines wet.
 */

const boat = new BoatSimulator();
const hull = {
  beam: HULL_TRANSOM_CHINE_BEAM,
  deadriseDegrees: HULL_TRANSOM.deadriseDegrees,
  lcg: RUNABOUT_21_CG.x,
  vcg: RUNABOUT_21_CG.y,
  weight: boat.definition.mass * 9.80665,
};

describe("boat planing against Savitsky", () => {
  it("solves Savitsky's lift equation at its own equilibrium, chines wet", () => {
    const point = savitskyPlaning(hull, 30 * KNOT);
    const cv = point.speedCoefficient;
    const cl0 = Math.pow(point.trimDegrees, 1.1) * (0.012 * Math.sqrt(point.lambda) + (0.0055 * Math.pow(point.lambda, 2.5)) / (cv * cv));
    const clBeta = hull.weight / (0.5 * 1025 * (30 * KNOT) ** 2 * hull.beam ** 2);
    expect(cl0 - 0.0065 * hull.deadriseDegrees * Math.pow(cl0, 0.6)).toBeCloseTo(clBeta, 5);
    expect(point.chineLength).toBeGreaterThan(0);
  });

  const speeds = [19, 20, 24, 28, 32];

  it.each(speeds)("trims within a degree and drags within 15 percent of Savitsky at %i kn", (knots) => {
    const oracle = savitskyPlaning(hull, knots * KNOT);
    expect(oracle.speedCoefficient).toBeGreaterThanOrEqual(2);
    expect(oracle.chineLength).toBeGreaterThan(0);
    const tow = towEquilibrium(knots, { boat });
    expect(Math.abs(tow.trimDegrees - oracle.trimDegrees)).toBeLessThan(1);
    expect(tow.drag / oracle.drag).toBeGreaterThan(0.85);
    expect(tow.drag / oracle.drag).toBeLessThan(1.15);
    expect(tow.dynamicLiftShare).toBeGreaterThan(0.6);
  });

  it("follows Savitsky's trend: trim falls and drag rises as the speed climbs", () => {
    const low = towEquilibrium(20, { boat });
    const high = towEquilibrium(32, { boat });
    expect(high.trimDegrees).toBeLessThan(low.trimDegrees - 1);
    expect(high.drag).toBeGreaterThan(low.drag);
  });
});
