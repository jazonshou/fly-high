import { describe, expect, it } from "vitest";
import { NEUTRAL_BOAT_CONTROLS } from "../src/sim/surface";
import {
  BoatSimulator,
  buildHullMesh,
  createHydrostaticResult,
  integrateHydrostatics,
  RUNABOUT_21,
  solveRestWaterline,
  WATER_DENSITY,
  type HullMesh,
} from "../src/sim/boat";
import { quaternionFromFlightAngles, rotateVectorInto } from "../src/sim/math";
import { STANDARD_GRAVITY } from "../src/sim/simulation";
import type { Quaternion } from "../src/sim/types";
import {
  HULL_LENGTH,
  HULL_TRANSOM,
  hullHalfSection,
  RUNABOUT_21_CG,
  RUNABOUT_21_REST_WATERLINE,
  type HullSectionPoint,
} from "../src/vehicles/boat/hullLines";

/**
 * The hull floats where the lines say it should, upright and heeled, and
 * rights itself as a deep-V runabout does: the clipped-mesh hydrostatics
 * (Kerner) against the lines' own section integral, the solved rest pose
 * against the constant the drawn boat uses, the righting-arm curve, and the
 * free-decay periods of the integrated boat.
 */

const DEG = Math.PI / 180;
const RHO_G = WATER_DENSITY * STANDARD_GRAVITY;
const WEIGHT = RUNABOUT_21.mass * STANDARD_GRAVITY;

/** The mesh at a pose (CG height over still water 0, orientation), clipped and integrated. */
function hydrostaticsAt(mesh: HullMesh, cgHeight: number, orientation: Quaternion) {
  const result = createHydrostaticResult(mesh);
  const world = new Float64Array(mesh.vertexCount * 3);
  const depth = new Float64Array(mesh.vertexCount);
  const weight = new Float64Array(mesh.triangleCount).fill(1);
  const v = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < mesh.vertexCount; i += 1) {
    v.x = mesh.vertices[i * 3]!;
    v.y = mesh.vertices[i * 3 + 1]!;
    v.z = mesh.vertices[i * 3 + 2]!;
    rotateVectorInto(v, orientation, v);
    world[i * 3] = v.x;
    world[i * 3 + 1] = v.y + cgHeight;
    world[i * 3 + 2] = v.z;
    depth[i] = -(v.y + cgHeight);
  }
  integrateHydrostatics(mesh, world, depth, { x: 0, y: cgHeight, z: 0 }, weight, RHO_G, result);
  return result;
}

/** CG height at which the hull at `orientation` carries its weight, by bisection. */
function floatingHeight(mesh: HullMesh, orientation: Quaternion): number {
  let lo = -3;
  let hi = 3;
  for (let k = 0; k < 60; k += 1) {
    const mid = 0.5 * (lo + hi);
    if (hydrostaticsAt(mesh, mid, orientation).force.y > WEIGHT) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Area of the half-section polygon (keel .. sheer, closed along the deck to the centreline) below `cut`. */
function halfSectionAreaBelow(points: readonly HullSectionPoint[], cut: number): number {
  const ring: { z: number; y: number }[] = points.map((p) => ({ z: p.z, y: p.y }));
  ring.push({ z: 0, y: points[points.length - 1]!.y });
  // Sutherland-Hodgman against y <= cut.
  const clipped: { z: number; y: number }[] = [];
  for (let k = 0; k < ring.length; k += 1) {
    const a = ring[k]!;
    const b = ring[(k + 1) % ring.length]!;
    const aIn = a.y <= cut;
    const bIn = b.y <= cut;
    if (aIn) clipped.push(a);
    if (aIn !== bIn) {
      const t = (cut - a.y) / (b.y - a.y);
      clipped.push({ z: a.z + t * (b.z - a.z), y: cut });
    }
  }
  let area = 0;
  for (let k = 0; k < clipped.length; k += 1) {
    const a = clipped[k]!;
    const b = clipped[(k + 1) % clipped.length]!;
    area += a.z * b.y - b.z * a.y;
  }
  return Math.abs(area) / 2;
}

/**
 * Volume of the LINES (not the mesh) below a still-water plane given in the
 * hull frame as y = a + b x, with the raked transom cutting the aft end.
 */
function linesVolumeBelow(a: number, b: number): number {
  const tanRake = Math.tan(HULL_TRANSOM.rakeDegrees * DEG);
  const points: HullSectionPoint[] = [];
  const n = 1_310;
  let volume = 0;
  for (let k = 0; k < n; k += 1) {
    const x = ((k + 0.5) / n) * HULL_LENGTH;
    hullHalfSection(x, points);
    const cut = Math.min(a + b * x, tanRake > 0 ? x / tanRake : Infinity);
    volume += 2 * halfSectionAreaBelow(points, cut) * (HULL_LENGTH / n);
  }
  return volume;
}

describe("boat hydrostatics", () => {
  const mesh = buildHullMesh();

  it("closes the hull: the area vectors cancel and a sunk hull feels only lift", () => {
    let ax = 0;
    let ay = 0;
    let az = 0;
    const v = mesh.vertices;
    for (let t = 0; t < mesh.triangleCount; t += 1) {
      const i = mesh.triangles[t * 3]! * 3;
      const j = mesh.triangles[t * 3 + 1]! * 3;
      const k = mesh.triangles[t * 3 + 2]! * 3;
      const ux = v[j]! - v[i]!;
      const uy = v[j + 1]! - v[i + 1]!;
      const uz = v[j + 2]! - v[i + 2]!;
      const wx = v[k]! - v[i]!;
      const wy = v[k + 1]! - v[i + 1]!;
      const wz = v[k + 2]! - v[i + 2]!;
      ax += uy * wz - uz * wy;
      ay += uz * wx - ux * wz;
      az += ux * wy - uy * wx;
    }
    expect(Math.hypot(ax, ay, az)).toBeLessThan(1e-9);
    const sunk = hydrostaticsAt(mesh, -5, quaternionFromFlightAngles(0.4, 0.2, 0.7));
    expect(Math.hypot(sunk.force.x, sunk.force.z)).toBeLessThan(1e-6 * sunk.force.y);
    expect(sunk.force.y).toBeCloseTo(RHO_G * sunk.volume, 3);
  });

  it("floats at the rest waterline the drawn boat uses, carrying exactly its weight", () => {
    const rest = solveRestWaterline();
    expect(rest.cgAboveWater).toBeCloseTo(RUNABOUT_21_REST_WATERLINE.cgAboveWater, 3);
    expect(rest.trim / DEG).toBeCloseTo(RUNABOUT_21_REST_WATERLINE.trimDegrees, 2);
    const s = Math.sin(rest.trim);
    const c = Math.cos(rest.trim);
    const keelDepth = (hullX: number) => -(rest.cgAboveWater + (hullX - RUNABOUT_21_CG.x) * s - RUNABOUT_21_CG.y * c);
    expect(keelDepth(0)).toBeCloseTo(RUNABOUT_21_REST_WATERLINE.draftAtTransom, 3);
    expect(keelDepth(RUNABOUT_21_CG.x)).toBeCloseTo(RUNABOUT_21_REST_WATERLINE.draftAtCg, 3);

    const result = hydrostaticsAt(mesh, rest.cgAboveWater, quaternionFromFlightAngles(0, rest.trim, 0));
    expect(Math.abs(result.volume * WATER_DENSITY - RUNABOUT_21.mass) / RUNABOUT_21.mass).toBeLessThan(0.005);
    expect(Math.abs(result.torque.x) + Math.abs(result.torque.z)).toBeLessThan(5);
  });

  it("matches the lines' own section integral at that waterline to 2%", () => {
    const rest = solveRestWaterline();
    // Still water in the hull frame: y = a + b x.
    const s = Math.sin(rest.trim);
    const c = Math.cos(rest.trim);
    const b = -s / c;
    const a = RUNABOUT_21_CG.y - (rest.cgAboveWater - RUNABOUT_21_CG.x * s) / c;
    const lines = linesVolumeBelow(a, b);
    const meshVolume = RUNABOUT_21.mass / WATER_DENSITY;
    expect(Math.abs(lines - meshVolume) / meshVolume).toBeLessThan(0.02);
  });

  it("rights itself to 70 degrees and beyond, with the stability vanishing near the capsize line", () => {
    const rest = solveRestWaterline();
    const arm = (heelDegrees: number) => {
      const orientation = quaternionFromFlightAngles(0, rest.trim, heelDegrees * DEG);
      const result = hydrostaticsAt(mesh, floatingHeight(mesh, orientation), orientation);
      // Heading 0: the roll axis is world +Z, and a righting moment turns starboard-down back up (negative).
      return -result.torque.z / WEIGHT;
    };
    let peak = 0;
    let peakAngle = 0;
    for (let heel = 5; heel <= 70; heel += 5) {
      const gz = arm(heel);
      expect(gz, `GZ at ${heel} deg`).toBeGreaterThan(0);
      if (gz > peak) {
        peak = gz;
        peakAngle = heel;
      }
    }
    // A beamy deep-V: GM about a metre, the largest arm between 35 and 60 degrees.
    expect(arm(5) / Math.sin(5 * DEG)).toBeGreaterThan(0.8);
    expect(arm(5) / Math.sin(5 * DEG)).toBeLessThan(1.6);
    expect(peakAngle).toBeGreaterThanOrEqual(35);
    expect(peakAngle).toBeLessThanOrEqual(60);
    // The arm vanishes between 95 and 115 degrees: past it the hull goes over (the 110 degree capsize rule).
    expect(arm(95)).toBeGreaterThan(0);
    expect(arm(115)).toBeLessThan(0);
    // Upside down it floats, and stays upside down.
    const inverted = quaternionFromFlightAngles(0, rest.trim, Math.PI);
    expect(floatingHeight(mesh, inverted)).toBeGreaterThan(0);
    expect(arm(160)).toBeLessThan(0);
  });

  it("heaves, pitches and rolls at a small runabout's periods, and the motions die away", () => {
    const rest = solveRestWaterline();
    const decay = (kind: "heave" | "pitch" | "roll") => {
      const boat = new BoatSimulator();
      boat.setEnvironment({});
      boat.setControls({ assist: "unassisted", boat: { ...NEUTRAL_BOAT_CONTROLS } });
      if (kind === "heave") boat.state.position.y += 0.08;
      else {
        const q = quaternionFromFlightAngles(0, rest.trim + (kind === "pitch" ? 0.03 : 0), kind === "roll" ? 0.15 : 0);
        Object.assign(boat.state.orientation, q);
      }
      const series: number[] = [];
      for (let i = 0; i < 120 * 12; i += 1) {
        boat.step(1 / 120);
        const t = boat.telemetry();
        series.push(kind === "heave" ? boat.state.position.y - rest.cgAboveWater : kind === "roll" ? t.roll : t.pitch - rest.trim);
      }
      const crossings: number[] = [];
      for (let i = 1; i < series.length; i += 1) if (series[i - 1]! < 0 && series[i]! >= 0) crossings.push(i / 120);
      const period = (crossings[crossings.length - 1]! - crossings[0]!) / (crossings.length - 1);
      const early = Math.max(...series.slice(0, 240).map(Math.abs));
      const late = Math.max(...series.slice(-240).map(Math.abs));
      return { period, early, late };
    };
    const heave = decay("heave");
    const pitch = decay("pitch");
    const roll = decay("roll");
    expect(heave.period).toBeGreaterThan(1.5);
    expect(heave.period).toBeLessThan(2.6);
    expect(pitch.period).toBeGreaterThan(1.5);
    expect(pitch.period).toBeLessThan(2.8);
    expect(roll.period).toBeGreaterThan(2);
    expect(roll.period).toBeLessThan(3.5);
    for (const motion of [heave, pitch, roll]) expect(motion.late).toBeLessThan(0.3 * motion.early);
  });

  it("stays afloat upside down, and a boat held over is a wreck after four seconds", () => {
    const boat = new BoatSimulator();
    boat.setEnvironment({});
    boat.setControls({ assist: "unassisted", boat: { ...NEUTRAL_BOAT_CONTROLS } });
    Object.assign(boat.state.orientation, quaternionFromFlightAngles(0, 0, Math.PI));
    boat.state.position.y = 0.4;
    for (let i = 0; i < 120 * 3; i += 1) boat.step(1 / 120);
    expect(boat.snapshot().payload.capsized).toBe(true);
    expect(boat.state.crashed).toBe(false);
    for (let i = 0; i < 120 * 2; i += 1) boat.step(1 / 120);
    expect(boat.state.crashed).toBe(true);
    for (let i = 0; i < 120 * 20; i += 1) boat.step(1 / 120);
    expect(boat.state.position.y).toBeGreaterThan(-0.5);
    expect(boat.state.position.y).toBeLessThan(1.5);
  });
});
