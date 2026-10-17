import { describe, expect, it } from "vitest";
import {
  AERIAL_PLANET_RADIUS_METERS,
  AERIAL_SHADOWED_COLUMN,
  chapmanColumn,
  ozoneSunColumn,
  skyMultipleScattering,
  sunTransmittanceAt,
} from "../src/render/webgpu/atmosphere/AerialSunlight";
import {
  AERIAL_HAZE_PER_POINT_SINE,
  AERIAL_PERSPECTIVE_WGSL,
  AERIAL_PHYSICAL_RELEASE_SINE,
  AERIAL_REFERENCE_SUN_COS,
  AERIAL_SCENE_PEAK_SUN,
  AERIAL_SKY_SHELL_METERS,
  AERIAL_SKY_TWO_POINT_SINE,
  aerialHazeSunSamples,
  aerialPerspectiveCoefficients,
  aerialPhysicalBalance,
  aerialPhysicalGate,
  aerialTravelFor,
  evaluateAerialPerspective,
  evaluateSkyRadiance,
  exponentialPathCentroid,
  resolveAerialPerspectiveBinding,
  visibleScatterFraction,
} from "../src/render/webgpu/atmosphere/AerialPerspective";
import { PEAK_SUN_INTENSITY } from "../src/render/webgpu/atmosphere/AtmosphereSystem";
import {
  MIE_SCALE_HEIGHT_METERS,
  OZONE_CENTER_METERS,
  OZONE_HALF_WIDTH_METERS,
  RAYLEIGH_SCALE_HEIGHT_METERS,
  evaluateTransmittance,
} from "../src/render/webgpu/atmosphere/AtmosphereLuts";
import {
  DEFAULT_ENVIRONMENT_STATE,
  createEnvironmentState,
} from "../src/render/webgpu/nature/EnvironmentState";

/**
 * The sunset rework: sunlight inside the air. Each scattering point is lit
 * by the sun IT sees (a Chapman column on the sphere, not one transmittance
 * at the camera), and the low-sun sky is blue overhead and gold at the
 * sunward horizon because of it.
 */

type Rgb = [number, number, number];
const luminance = (rgb: readonly number[]): number =>
  0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;

function stateWithSunAt(elevationDegrees: number) {
  const radians = (elevationDegrees * Math.PI) / 180;
  return createEnvironmentState({
    sun: { direction: [Math.cos(radians), Math.sin(radians), 0] },
  });
}

/** Column along a straight ray on the sphere, in scale heights of sea-level density. */
function numericColumn(scaleHeight: number, altitude: number, cosZenith: number): number {
  const start = AERIAL_PLANET_RADIUS_METERS + altitude;
  const step = 5;
  let sum = 0;
  for (let t = step / 2; t < 2_000_000; t += step) {
    const radius = Math.sqrt(start * start + t * t + 2 * start * cosZenith * t);
    if (radius < AERIAL_PLANET_RADIUS_METERS) return Infinity;
    if (radius - AERIAL_PLANET_RADIUS_METERS > 30 * scaleHeight) break;
    sum += Math.exp(-(radius - AERIAL_PLANET_RADIUS_METERS) / scaleHeight) * step;
  }
  return sum / scaleHeight;
}

describe("constants shared with the rest of the renderer", () => {
  it("uses the environment's planet and the scene's noon sun", () => {
    expect(AERIAL_PLANET_RADIUS_METERS).toBe(DEFAULT_ENVIRONMENT_STATE.atmosphere.planetRadiusMeters);
    expect(AERIAL_SCENE_PEAK_SUN).toBe(PEAK_SUN_INTENSITY);
  });
});

describe("the Chapman column", () => {
  it("matches a numeric sphere within 6% from the zenith to the horizon", () => {
    for (const scaleHeight of [RAYLEIGH_SCALE_HEIGHT_METERS, MIE_SCALE_HEIGHT_METERS]) {
      for (const altitude of [0, 1_000, 10_000]) {
        for (const cosZenith of [1, 0.5, 0.2, 0.1, 0.05, 0.02, 0]) {
          const ratio = chapmanColumn(scaleHeight, altitude, cosZenith)
            / numericColumn(scaleHeight, altitude, cosZenith);
          expect(Math.abs(ratio - 1), `H ${scaleHeight} h ${altitude} mu ${cosZenith}`)
            .toBeLessThan(0.06);
        }
      }
    }
  });

  it("follows a ray down through its tangent point while the sun clears the planet", () => {
    for (const scaleHeight of [RAYLEIGH_SCALE_HEIGHT_METERS, MIE_SCALE_HEIGHT_METERS]) {
      for (const cosZenith of [-0.02, -0.05]) {
        const ratio = chapmanColumn(scaleHeight, 10_000, cosZenith)
          / numericColumn(scaleHeight, 10_000, cosZenith);
        expect(Math.abs(ratio - 1)).toBeLessThan(0.03);
      }
    }
  });

  it("returns the shadowed column once the planet blocks the sun", () => {
    expect(chapmanColumn(RAYLEIGH_SCALE_HEIGHT_METERS, 0, -0.02)).toBe(AERIAL_SHADOWED_COLUMN);
    expect(chapmanColumn(RAYLEIGH_SCALE_HEIGHT_METERS, 10_000, -0.1)).toBe(AERIAL_SHADOWED_COLUMN);
    expect(numericColumn(RAYLEIGH_SCALE_HEIGHT_METERS, 10_000, -0.1)).toBe(Infinity);
  });

  it("puts the overhead ozone layer's whole area above sea level", () => {
    expect(ozoneSunColumn(0, 1)).toBeCloseTo(OZONE_HALF_WIDTH_METERS, 6);
    expect(ozoneSunColumn(OZONE_CENTER_METERS + OZONE_HALF_WIDTH_METERS, 1)).toBe(0);
    // Slanted through the shell, the column grows but stays finite at the horizon.
    expect(ozoneSunColumn(0, 0)).toBeGreaterThan(ozoneSunColumn(0, 0.5));
    expect(Number.isFinite(ozoneSunColumn(0, 0))).toBe(true);
  });
});

describe("the sun a point sees", () => {
  const coefficients = aerialPerspectiveCoefficients(DEFAULT_ENVIRONMENT_STATE);

  it("reddens toward the horizon and clears with altitude", () => {
    const high = sunTransmittanceAt(coefficients, 0, Math.sin((40 * Math.PI) / 180));
    const low = sunTransmittanceAt(coefficients, 0, Math.sin((3 * Math.PI) / 180));
    expect(low[0] / low[2]).toBeGreaterThan(3 * (high[0] / high[2]));
    const aloft = sunTransmittanceAt(coefficients, 3_000, Math.sin((3 * Math.PI) / 180));
    for (let channel = 0; channel < 3; channel += 1) {
      expect(aloft[channel]!).toBeGreaterThan(low[channel]!);
    }
  });

  it("places a level path's scattering at its middle and a climbing one near its foot", () => {
    expect(exponentialPathCentroid(0, RAYLEIGH_SCALE_HEIGHT_METERS)).toBe(0.5);
    const climbing = exponentialPathCentroid(40_000, RAYLEIGH_SCALE_HEIGHT_METERS);
    expect(climbing).toBeCloseTo(1 / 5 - 1 / (Math.exp(5) - 1), 12);
    expect(exponentialPathCentroid(-40_000, RAYLEIGH_SCALE_HEIGHT_METERS)).toBeCloseTo(1 - climbing, 12);
    expect(visibleScatterFraction(0)).toBe(1);
    expect(visibleScatterFraction(10)).toBeCloseTo(0.1, 4);
  });

  it("switches to its short-path series without a step", () => {
    // Below 0.1 both use a series (exact in f32, where e^x − 1 is not); in
    // double precision the series and the closed form agree to 2e-8 there,
    // a third of an f32 step.
    for (const x of [0.02, 0.0999, -0.0999]) {
      expect(exponentialPathCentroid(x * RAYLEIGH_SCALE_HEIGHT_METERS, RAYLEIGH_SCALE_HEIGHT_METERS))
        .toBeCloseTo(1 / x - 1 / (Math.exp(x) - 1), 7);
    }
    for (const depth of [0.0005, 0.02, 0.0999]) {
      expect(visibleScatterFraction(depth)).toBeCloseTo((1 - Math.exp(-depth)) / depth, 7);
    }
  });
});

describe("multiple scattering (Hillaire's transfer)", () => {
  const coefficients = aerialPerspectiveCoefficients(DEFAULT_ENVIRONMENT_STATE);

  it("is blue by day and dims as the sun sets", () => {
    const noon = skyMultipleScattering(coefficients, AERIAL_REFERENCE_SUN_COS);
    const sunset = skyMultipleScattering(coefficients, 0.02);
    expect(noon[2]).toBeGreaterThan(noon[0]);
    expect(luminance(sunset)).toBeLessThan(luminance(noon) * 0.3);
    expect(luminance(sunset)).toBeGreaterThan(0);
  });

  it("answers from its table without moving between calls", () => {
    const first = skyMultipleScattering(coefficients, 0.3);
    expect(skyMultipleScattering(coefficients, 0.3)).toEqual(first);
  });
});

describe("the low-sun sky", () => {
  const sunsetBinding = (elevationDegrees: number, cameraAltitude = 120) => {
    const state = stateWithSunAt(elevationDegrees);
    return resolveAerialPerspectiveBinding(state, cameraAltitude, [1, 0.48, 0.22], [0.94, 0.3, 0.13], 0.6);
  };

  it("is blue overhead and gold at the sunward horizon", () => {
    for (const elevation of [1, 3, 6]) {
      const binding = sunsetBinding(elevation);
      const zenith = evaluateSkyRadiance(binding, [0, 1, 0]);
      const sunward = evaluateSkyRadiance(binding, [0.9997, 0.025, 0]);
      expect(zenith[2], `zenith at ${elevation} deg`).toBeGreaterThan(zenith[0] * 1.25);
      expect(sunward[0], `sunward at ${elevation} deg`).toBeGreaterThan(sunward[2] * 2);
      expect(luminance(sunward)).toBeGreaterThan(luminance(zenith));
    }
  });

  it("keeps the horizon sky and the long haze path within a factor 1.5", () => {
    // Physically the horizon sky is the brighter of the two (a sea path at
    // 100 km carries ~2/3 of it); a tear between them is what this guards.
    for (const elevation of [2, 5, 10, 20]) {
      const binding = sunsetBinding(elevation);
      for (const azimuth of [0, 90, 180]) {
        const radians = (azimuth * Math.PI) / 180;
        const raw: Rgb = [Math.cos(radians), 0.0025, Math.sin(radians)];
        const length = Math.hypot(...raw);
        const direction = raw.map((value) => value / length) as Rgb;
        const sky = evaluateSkyRadiance(binding, direction);
        const mu = direction[0] * binding.sunDirection[0]
          + direction[1] * binding.sunDirection[1]
          + direction[2] * binding.sunDirection[2];
        const haze = evaluateAerialPerspective(
          binding.coefficients,
          120,
          120,
          100_000,
          mu,
          binding.sunRadiance,
          binding.ambient,
          binding.sunDirection[1],
          aerialTravelFor(direction, binding.sunDirection),
        ).inScatter;
        const ratio = luminance(sky) / luminance(haze);
        expect(ratio, `${elevation} deg, azimuth ${azimuth}`).toBeGreaterThan(1 / 1.5);
        expect(ratio, `${elevation} deg, azimuth ${azimuth}`).toBeLessThan(1.5);
      }
    }
  });
});

describe("the sky's two-point sun", () => {
  it("is mirrored in WGSL and switched on a uniform", () => {
    expect(AERIAL_PERSPECTIVE_WGSL).toContain(
      `const AERIAL_SKY_TWO_POINT_SINE: f32 = ${AERIAL_SKY_TWO_POINT_SINE.toFixed(1)};`,
    );
    expect(AERIAL_PERSPECTIVE_WGSL).toContain(
      "uniforms.aerialSunDirection.y < AERIAL_SKY_TWO_POINT_SINE",
    );
  });

  it("switches to one point above 30 deg without a visible step", () => {
    // Just either side of the switch: the same sky to within 1.5% anywhere.
    const below = Math.asin(AERIAL_SKY_TWO_POINT_SINE - 1e-6) * (180 / Math.PI);
    const above = Math.asin(AERIAL_SKY_TWO_POINT_SINE + 1e-6) * (180 / Math.PI);
    const twoPoint = resolveAerialPerspectiveBinding(stateWithSunAt(below), 150, [1, 0.9, 0.8], [0.6, 0.7, 0.9], 0.9);
    const onePoint = resolveAerialPerspectiveBinding(stateWithSunAt(above), 150, [1, 0.9, 0.8], [0.6, 0.7, 0.9], 0.9);
    for (const elevation of [1, 5, 20, 35, 60, 90]) {
      for (const azimuth of [0, 45, 90, 180]) {
        const e = (elevation * Math.PI) / 180;
        const a = (azimuth * Math.PI) / 180;
        const direction: Rgb = [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
        const ratio = luminance(evaluateSkyRadiance(onePoint, direction))
          / luminance(evaluateSkyRadiance(twoPoint, direction));
        expect(Math.abs(ratio - 1), `elevation ${elevation} azimuth ${azimuth}`).toBeLessThan(0.015);
      }
    }
    // Above the switch the sky IS the one-point integral.
    const direction: Rgb = [0.6, 0.8, 0];
    const mu = direction[0] * onePoint.sunDirection[0] + direction[1] * onePoint.sunDirection[1];
    const single = evaluateAerialPerspective(
      onePoint.coefficients,
      150,
      AERIAL_SKY_SHELL_METERS,
      (AERIAL_SKY_SHELL_METERS - 150) / 0.8,
      mu,
      onePoint.sunRadiance,
      onePoint.ambient,
      onePoint.sunDirection[1],
      { horizontal: 0.6, sunAlong: aerialTravelFor(direction, onePoint.sunDirection).sunAlong },
      1,
    ).inScatter;
    expect(evaluateSkyRadiance(onePoint, direction)).toEqual(single);
  });
});

describe("the surface haze above a 30 deg sun", () => {
  it("is mirrored in WGSL, switched on a uniform, and leaves clouds and sky per point", () => {
    expect(AERIAL_HAZE_PER_POINT_SINE).toBe(0.5);
    expect(aerialHazeSunSamples(0.5)).toBe(0);
    expect(aerialHazeSunSamples(0.4999)).toBe(1);
    expect(AERIAL_PERSPECTIVE_WGSL).toContain("const AERIAL_HAZE_PER_POINT_SINE: f32 = 0.5;");
    expect(AERIAL_PERSPECTIVE_WGSL).toContain(
      "select(1, 0, uniforms.aerialSunDirection.y >= AERIAL_HAZE_PER_POINT_SINE)",
    );
    const along = AERIAL_PERSPECTIVE_WGSL.slice(
      AERIAL_PERSPECTIVE_WGSL.indexOf("fn aerialPerspectiveAlong("),
      AERIAL_PERSPECTIVE_WGSL.indexOf("fn applyAerialPerspective("),
    );
    expect(along).toContain("aerialHazeSunSamples()");
    const plain = AERIAL_PERSPECTIVE_WGSL.slice(
      AERIAL_PERSPECTIVE_WGSL.indexOf("fn aerialPerspective("),
      AERIAL_PERSPECTIVE_WGSL.indexOf("fn aerialPerspectiveAlong("),
    );
    expect(plain).toContain("aerialIntegral(fragmentAltitude, distanceMeters, viewDotSun, 0.0, 0.0, false)");
  });

  // Worst: a hill 600 m above a camera on the ground, 2 km sunward, at 30 deg
  // (2.4%); level and descending paths stay under 1.5%.
  it("lights a surface's path with the camera's sun within 3% of each point's own", () => {
    let worst = 0;
    for (const elevation of [30, 45, 68]) {
      const state = stateWithSunAt(elevation);
      for (const camera of [2, 152, 3_048]) {
        const binding = resolveAerialPerspectiveBinding(
          state,
          camera,
          [1, 0.96, 0.88],
          [0.58, 0.77, 0.96],
          1,
        );
        const sun = binding.sunDirection;
        for (const azimuth of [0, 60, 90, 135, 180]) {
          const radians = (azimuth * Math.PI) / 180;
          const heading = [Math.cos(radians), Math.sin(radians)] as const;
          for (const distance of [500, 2_000, 8_000, 30_000, 100_000]) {
            for (const target of [0, camera, camera + 600]) {
              const length = Math.hypot(distance, target - camera);
              const view: Rgb = [
                (heading[0] * distance) / length,
                (target - camera) / length,
                (heading[1] * distance) / length,
              ];
              const viewDotSun = view[0] * sun[0] + view[1] * sun[1] + view[2] * sun[2];
              const travel = aerialTravelFor(view, sun);
              const run = (quadrature: 0 | 1) => evaluateAerialPerspective(
                binding.coefficients, camera, target, length, viewDotSun,
                binding.sunRadiance, binding.ambient, sun[1], travel, quadrature,
              ).inScatter;
              worst = Math.max(worst, Math.abs(luminance(run(0)) / luminance(run(1)) - 1));
            }
          }
        }
      }
    }
    expect(worst).toBeLessThan(0.03);
    expect(worst).toBeGreaterThan(0);
  });
});

describe("the approved daytime look", () => {
  it("keeps the haze ambient flat above the 55 deg key, as the palette's top row is", () => {
    const sunColor: Rgb = [1, 0.96, 0.88];
    const skyHorizon: Rgb = [0.58, 0.77, 0.96];
    const key = resolveAerialPerspectiveBinding(stateWithSunAt(55), 3_048, sunColor, skyHorizon, 1);
    for (const elevation of [56, 68, 90]) {
      const binding = resolveAerialPerspectiveBinding(
        stateWithSunAt(elevation),
        3_048,
        sunColor,
        skyHorizon,
        1,
      );
      for (let channel = 0; channel < 3; channel += 1) {
        expect(binding.ambient[channel], `${elevation} deg channel ${channel}`)
          .toBeCloseTo(key.ambient[channel]!, 12);
      }
    }
  });
});

describe("the hand-back to the shipped twilight model", () => {
  it("is fully physical at sunset and fully shipped by the release sine", () => {
    expect(aerialPhysicalGate(0)).toBe(1);
    expect(aerialPhysicalGate(AERIAL_PHYSICAL_RELEASE_SINE)).toBe(0);
    expect(aerialPhysicalBalance(0)).toBe(1);
    expect(aerialPhysicalBalance(0.5)).toBe(0);
  });

  it("reproduces the shipped camera-level source and ambient below the window", () => {
    const sunY = -0.055;
    const state = createEnvironmentState({
      sun: { direction: [Math.sqrt(1 - sunY * sunY), sunY, 0] },
    });
    const sunColor: Rgb = [0.9, 0.4, 0.25];
    const skyHorizon: Rgb = [0.3, 0.2, 0.25];
    for (const camera of [12_000, 20_000]) {
      const binding = resolveAerialPerspectiveBinding(state, camera, sunColor, skyHorizon, 0.1);
      const lut = evaluateTransmittance(state.atmosphere, camera, sunY, 12);
      const daylight = Math.min(1, Math.max(0, (sunY + 0.08) / 0.4));
      for (let channel = 0; channel < 3; channel += 1) {
        const shipped = sunColor[channel]! * 0.1 * 1.15 * lut[channel]!;
        const now = binding.sunRadiance[channel]! * binding.sunTransmittance[channel]!;
        if (binding.sunTransmittance[channel]! > 1e-6) {
          expect(now / shipped, `camera ${camera} channel ${channel}`).toBeCloseTo(1, 6);
        }
        expect(binding.ambient[channel]).toBeCloseTo(skyHorizon[channel]! * 0.9 * daylight, 9);
      }
    }
  });
});
