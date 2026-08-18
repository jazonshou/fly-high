import { describe, expect, it } from "vitest";
import type { SphericalPolynomial } from "@babylonjs/core/Maths/sphericalPolynomial";
import {
  resolveAerialPerspectiveBinding,
} from "../src/render/webgpu/atmosphere/AerialPerspective";
import {
  bakeSkyIrradiancePolynomial,
  bakeSphericalPolynomialFromRadiance,
} from "../src/render/webgpu/atmosphere/SkyEnvironmentProbe";
import { resolveEnvironmentState } from "../src/render/webgpu/nature/EnvironmentDirector";

/**
 * 1C-6 — the sky environment probe's diffuse half: SH irradiance baked from
 * the skyRadiance TS mirror, validated against the analytic reference the
 * plan demands (a uniform sky of radiance L must give irradiance πL — which
 * in Babylon's Lambertian-radiance convention evaluates back to exactly L).
 */

function evaluatePolynomial(
  polynomial: SphericalPolynomial,
  normal: readonly [number, number, number],
): [number, number, number] {
  const [x, y, z] = normal;
  const result: [number, number, number] = [0, 0, 0];
  const channels = ["x", "y", "z"] as const;
  for (let channel = 0; channel < 3; channel += 1) {
    const axis = channels[channel]!;
    result[channel] = polynomial.x[axis] * x
      + polynomial.y[axis] * y
      + polynomial.z[axis] * z
      + polynomial.xx[axis] * x * x
      + polynomial.yy[axis] * y * y
      + polynomial.zz[axis] * z * z
      + polynomial.xy[axis] * x * y
      + polynomial.yz[axis] * y * z
      + polynomial.zx[axis] * z * x;
  }
  return result;
}

const NORMALS: readonly [number, number, number][] = [
  [0, 1, 0],
  [0, -1, 0],
  [1, 0, 0],
  [0, 0, -1],
  [0.577, 0.577, 0.577],
];

describe("spherical-harmonics irradiance (1C-6)", () => {
  it("returns exactly L for a uniform sky of radiance L — the πL identity", () => {
    const polynomial = bakeSphericalPolynomialFromRadiance(() => [0.8, 0.5, 0.25], 16);
    for (const normal of NORMALS) {
      const irradiance = evaluatePolynomial(polynomial, normal);
      // convertIncidentRadianceToIrradiance (×π for uniform) followed by
      // convertIrradianceToLambertianRadiance (÷π) is the identity here.
      expect(irradiance[0]).toBeCloseTo(0.8, 2);
      expect(irradiance[1]).toBeCloseTo(0.5, 2);
      expect(irradiance[2]).toBeCloseTo(0.25, 2);
    }
  });

  it("lights an up-facing surface more than a down-facing one under a sky-only field", () => {
    const skyOnly = bakeSphericalPolynomialFromRadiance(
      (direction) => (direction[1] > 0 ? [1, 1, 1] : [0, 0, 0]),
      16,
    );
    const up = evaluatePolynomial(skyOnly, [0, 1, 0]);
    const down = evaluatePolynomial(skyOnly, [0, -1, 0]);
    expect(up[1]).toBeGreaterThan(down[1] * 3);
    expect(down[1]).toBeGreaterThanOrEqual(-0.02);
  });

  it("bakes a finite, blue-leaning, upward-dominant irradiance from the real sky", () => {
    const binding = resolveAerialPerspectiveBinding(
      resolveEnvironmentState({
        clock: { dayOfYear: 171, solarTimeHours: 12.5 },
        latitudeDegrees: 45,
        weather: "clear",
      }),
      120,
      [1, 0.96, 0.88],
      [0.58, 0.77, 0.96],
      1,
    );
    const polynomial = bakeSkyIrradiancePolynomial(binding);
    const up = evaluatePolynomial(polynomial, [0, 1, 0]);
    const down = evaluatePolynomial(polynomial, [0, -1, 0]);
    for (const value of [...up, ...down]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    // Skylight lands on upward faces; the below-horizon clamp keeps some
    // energy on downward faces (the haze band), but up must dominate.
    expect(up[2]).toBeGreaterThan(down[2] * 1.15);
    expect(up[2]).toBeGreaterThan(up[0]);
    expect(up[1]).toBeGreaterThan(0.02);
  });
});
