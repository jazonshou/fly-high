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
  AERIAL_CAMERA_SUN_WINDOW,
  AERIAL_NO_TRAVEL,
  AERIAL_PERSPECTIVE_WGSL,
  AERIAL_PHYSICAL_RELEASE_SINE,
  AERIAL_REFERENCE_SUN_COS,
  AERIAL_SCENE_PEAK_SUN,
  AERIAL_SKY_SHELL_METERS,
  aerialCameraSunWeight,
  aerialPerspectiveCoefficients,
  aerialPhysicalBalance,
  aerialPhysicalGate,
  aerialTravelFor,
  evaluateAerialPerspective,
  evaluateSkyRadiance,
  exponentialPathCentroid,
  physicalSkyColours,
  resolveAerialPerspectiveBinding,
  towardPhysicalChroma,
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

describe("the GPU's sun, cheap on a software rasteriser", () => {
  // SwiftShader (the CI's GPU) runs both sides of every branch, a uniform's
  // included, so the per-point sun is written without any it can't fold.
  it("picks the sky's two-point quadrature with a literal, never a uniform", () => {
    expect(AERIAL_PERSPECTIVE_WGSL).not.toContain("AERIAL_SKY_TWO_POINT_SINE");
    const sky = AERIAL_PERSPECTIVE_WGSL.slice(
      AERIAL_PERSPECTIVE_WGSL.indexOf("let aerial = aerialIntegral(", AERIAL_PERSPECTIVE_WGSL.indexOf("fn skyRadiance(")),
    );
    expect(sky.slice(0, sky.indexOf(");")).trimEnd()).toMatch(/,\s*true,$/);
    expect(AERIAL_PERSPECTIVE_WGSL).toContain("return aerialIntegral(fragmentAltitude, distanceMeters, viewDotSun, 0.0, 0.0, false);");
    expect(AERIAL_PERSPECTIVE_WGSL).toContain("dot(viewDirection, uniforms.aerialSunDirection), horizontal, sunAlong, false);");
    // The TS mirror: the sky is the two-point integral at every sun.
    for (const elevationDegrees of [3, 45]) {
      const binding = resolveAerialPerspectiveBinding(stateWithSunAt(elevationDegrees), 150, [1, 0.9, 0.8], [0.6, 0.7, 0.9], 0.9);
      const direction: Rgb = [0.6, 0.8, 0];
      const mu = direction[0] * binding.sunDirection[0] + direction[1] * binding.sunDirection[1];
      const twoPoint = evaluateAerialPerspective(
        binding.coefficients,
        150,
        AERIAL_SKY_SHELL_METERS,
        (AERIAL_SKY_SHELL_METERS - 150) / 0.8,
        mu,
        binding.sunRadiance,
        binding.ambient,
        binding.sunDirection[1],
        { horizontal: 0.6, sunAlong: aerialTravelFor(direction, binding.sunDirection).sunAlong },
        2,
      ).inScatter;
      expect(evaluateSkyRadiance(binding, direction)).toEqual(twoPoint);
    }
  });

  it("tilts each point's sun with series terms, not trig", () => {
    const sun = AERIAL_PERSPECTIVE_WGSL.slice(
      AERIAL_PERSPECTIVE_WGSL.indexOf("fn aerialSunAtFraction("),
      AERIAL_PERSPECTIVE_WGSL.indexOf("fn aerialSunAlongPath("),
    );
    expect(sun).toContain("min(distanceMeters * fraction * horizontal / AERIAL_PLANET_RADIUS, 1.0)");
    expect(sun).not.toMatch(/\b(cos|sin)\(/);
    expect(sun).not.toContain("if (");
    // At the 1 rad clamp the terms are within 0.0014 of cos and 0.0002 of sin.
    const cosAngle = 1 - (0.5 - 1 / 24);
    const sinAngle = 1 - (1 / 6 - 1 / 120);
    expect(Math.abs(cosAngle - Math.cos(1))).toBeLessThan(0.0014);
    expect(Math.abs(sinAngle - Math.sin(1))).toBeLessThan(0.0002);
  });

  it("selects the Chapman column's side instead of branching to it", () => {
    const sun = AERIAL_PERSPECTIVE_WGSL.slice(
      AERIAL_PERSPECTIVE_WGSL.indexOf("fn aerialSunTransmittanceAt("),
      AERIAL_PERSPECTIVE_WGSL.indexOf("fn aerialPathCentroids("),
    );
    expect(sun).not.toContain("if (");
    expect(sun).toContain("let column = select(below, slant, cosZenith >= 0.0);");
    // Both sides share one slant toward |mu|: below the horizon it is the
    // column the ray would carry looking back up.
    for (const scaleHeight of [RAYLEIGH_SCALE_HEIGHT_METERS, MIE_SCALE_HEIGHT_METERS]) {
      const up = chapmanColumn(scaleHeight, 10_000, 0.02);
      const down = chapmanColumn(scaleHeight, 10_000, -0.02);
      const radius = AERIAL_PLANET_RADIUS_METERS + 10_000;
      const tangentRadius = radius * Math.sqrt(1 - 0.02 * 0.02);
      const tangent = Math.sqrt((Math.PI * tangentRadius) / (2 * scaleHeight))
        * Math.exp(-(tangentRadius - AERIAL_PLANET_RADIUS_METERS) / scaleHeight);
      expect(down).toBeCloseTo(2 * tangent - up, 9);
    }
  });

  it("gets both species' density from one exponential, since their scale heights split 24 km", () => {
    expect(24_000 / RAYLEIGH_SCALE_HEIGHT_METERS).toBe(3);
    expect(24_000 / MIE_SCALE_HEIGHT_METERS).toBe(20);
    expect(AERIAL_PERSPECTIVE_WGSL).toContain(
      `const AERIAL_SPECIES_SCALE: vec2f = vec2f(${RAYLEIGH_SCALE_HEIGHT_METERS}.0, ${MIE_SCALE_HEIGHT_METERS}.0);`,
    );
    expect(AERIAL_PERSPECTIVE_WGSL).toContain("const AERIAL_DECAY_UNIT: f32 = 24000.0;");
    expect(AERIAL_PERSPECTIVE_WGSL).toContain("let rayleigh = unit2 * unit;");
    expect(AERIAL_PERSPECTIVE_WGSL).toContain("let mie = unit10 * unit10;");
    const tangent = /const AERIAL_SPECIES_TANGENT: vec2f = vec2f\(([\d.]+), ([\d.]+)\);/
      .exec(AERIAL_PERSPECTIVE_WGSL);
    expect(Number(tangent![1])).toBeCloseTo(Math.sqrt(Math.PI / (2 * RAYLEIGH_SCALE_HEIGHT_METERS)), 9);
    expect(Number(tangent![2])).toBeCloseTo(Math.sqrt(Math.PI / (2 * MIE_SCALE_HEIGHT_METERS)), 9);
    // No pow: it is a log and an exponential per call on SwiftShader.
    expect(AERIAL_PERSPECTIVE_WGSL).not.toMatch(/\bpow\(/);
  });
});

describe("the camera's sun above a 27 deg sun", () => {
  it("is mirrored in WGSL and blends on a uniform, so no draw diverges and above 33 deg a GPU skips it", () => {
    expect(AERIAL_CAMERA_SUN_WINDOW).toEqual([0.45, 0.55]);
    expect(aerialCameraSunWeight(0.45)).toBe(0);
    expect(aerialCameraSunWeight(0.3)).toBe(0);
    expect(aerialCameraSunWeight(0.5)).toBeCloseTo(0.5, 12);
    expect(aerialCameraSunWeight(0.55)).toBe(1);
    expect(aerialCameraSunWeight(0.9)).toBe(1);
    expect(AERIAL_PERSPECTIVE_WGSL).toContain("const AERIAL_CAMERA_SUN_LOW: f32 = 0.45;");
    expect(AERIAL_PERSPECTIVE_WGSL).toContain("const AERIAL_CAMERA_SUN_HIGH: f32 = 0.55;");
    expect(AERIAL_PERSPECTIVE_WGSL).toContain(
      "smoothstep(AERIAL_CAMERA_SUN_LOW, AERIAL_CAMERA_SUN_HIGH, uniforms.aerialSunDirection.y)",
    );
    expect(AERIAL_PERSPECTIVE_WGSL).toContain("if (cameraWeight < 1.0) {");
    // One integral for every consumer: surfaces, clouds and light points, the sky.
    expect(AERIAL_PERSPECTIVE_WGSL).not.toContain("aerialIntegralSampled");
    // Defined once and read once.
    expect(AERIAL_PERSPECTIVE_WGSL.split("aerialCameraSunWeight()").length).toBe(3);
  });

  it("does not step as the sun crosses the window", () => {
    const sunColor: Rgb = [1, 0.96, 0.88];
    const skyHorizon: Rgb = [0.58, 0.77, 0.96];
    const direction: Rgb = [0.94, 0.34, 0];
    for (const sine of [0.45, 0.55]) {
      const elevation = (degrees: number) => resolveAerialPerspectiveBinding(
        stateWithSunAt(degrees), 152, sunColor, skyHorizon, 1,
      );
      const at = (Math.asin(sine) * 180) / Math.PI;
      const a = luminance(evaluateSkyRadiance(elevation(at - 0.01), direction));
      const b = luminance(evaluateSkyRadiance(elevation(at + 0.01), direction));
      expect(Math.abs(b / a - 1)).toBeLessThan(0.002);
    }
  });

  // What the blend gives up against each point's own sun, from the window's
  // foot to noon: a surface's path 2.2% at most (a hill above a camera on the
  // ground, at 45 deg), a path climbing to a cloud 5.7%, and the sky 7.2%,
  // in the aureole of a sun at the window's top. Measured with the blend's
  // own weight, so the window's foot costs nothing.
  it("costs a surface 2.5%, a cloud's haze 6% and the sky's aureole 8% at most", () => {
    let surface = 0;
    let cloud = 0;
    let sky = 0;
    for (const elevation of [27, 30, 33.4, 45, 68]) {
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
        const gap = (
          target: number,
          length: number,
          view: Rgb,
          travel: { horizontal: number; sunAlong: number },
          quadrature: 1 | 2,
        ) => {
          const viewDotSun = view[0] * sun[0] + view[1] * sun[1] + view[2] * sun[2];
          const run = (weight: number) => evaluateAerialPerspective(
            binding.coefficients, camera, target, length, viewDotSun,
            binding.sunRadiance, binding.ambient, sun[1], travel, quadrature, weight,
          ).inScatter;
          return Math.abs(luminance(run(aerialCameraSunWeight(sun[1]))) / luminance(run(0)) - 1);
        };
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
              surface = Math.max(surface, gap(target, length, view, aerialTravelFor(view, sun), 1));
            }
            for (const base of [1_500, 3_000]) {
              if (base <= camera) continue;
              const length = Math.hypot(distance, base - camera);
              const view: Rgb = [
                (heading[0] * distance) / length,
                (base - camera) / length,
                (heading[1] * distance) / length,
              ];
              cloud = Math.max(cloud, gap(base, length, view, AERIAL_NO_TRAVEL, 1));
            }
          }
          for (const up of [0.0025, 0.05, 0.2, 0.5, 0.9]) {
            const across = Math.sqrt(1 - up * up);
            const direction: Rgb = [across * heading[0], up, across * heading[1]];
            const ratio = (weight: number) => {
              const shell = Math.min(Math.max(camera, 0), AERIAL_SKY_SHELL_METERS - 1);
              const viewDotSun = direction[0] * sun[0] + direction[1] * sun[1] + direction[2] * sun[2];
              return evaluateAerialPerspective(
                binding.coefficients, camera, AERIAL_SKY_SHELL_METERS,
                (AERIAL_SKY_SHELL_METERS - shell) / up, viewDotSun,
                binding.sunRadiance, binding.ambient, sun[1],
                { horizontal: across, sunAlong: aerialTravelFor(direction, sun).sunAlong },
                2, weight,
              ).inScatter;
            };
            sky = Math.max(
              sky,
              Math.abs(luminance(ratio(aerialCameraSunWeight(sun[1]))) / luminance(ratio(0)) - 1),
            );
          }
        }
      }
    }
    expect(surface).toBeLessThan(0.025);
    expect(cloud).toBeLessThan(0.06);
    expect(sky).toBeLessThan(0.08);
    expect(Math.min(surface, cloud, sky)).toBeGreaterThan(0);
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

  it("keeps the palette sun's brightness, and the last sunlight's chroma, after sunset", () => {
    const palette: Rgb = [1, 0.42, 0.18];
    const sunAt = (sunY: number): Rgb => {
      const state = createEnvironmentState({
        sun: { direction: [Math.sqrt(1 - sunY * sunY), sunY, 0] },
      });
      const physical = physicalSkyColours(state, palette, [0.7, 0.24, 0.12], 0.2);
      const weight = aerialPhysicalBalance(sunY) * aerialPhysicalGate(sunY);
      return towardPhysicalChroma(palette, physical.sun, weight);
    };
    const sunset = sunAt(0);
    for (const sunY of [-0.001, -0.01, -0.03, -0.049]) {
      const sun = sunAt(sunY);
      // The ground's own sun is shadowed here; the palette's must not go black.
      expect(luminance(sun), `sine ${sunY}`).toBeCloseTo(luminance(palette), 9);
      expect(sun[0]).toBeGreaterThan(sun[1]);
      expect(sun[1]).toBeGreaterThan(sun[2]);
    }
    const justAfter = sunAt(-0.001);
    for (let channel = 0; channel < 3; channel += 1) {
      expect(Math.abs(justAfter[channel]! - sunset[channel]!)).toBeLessThan(0.01);
    }
    expect(towardPhysicalChroma(palette, [0, 0, 0], 0.9)).toEqual(palette);
  });

  it("caches the palette's reference sky per atmosphere, not only per weather", () => {
    const across = Math.sqrt(1 - AERIAL_REFERENCE_SUN_COS * AERIAL_REFERENCE_SUN_COS);
    const sun = { direction: [across, AERIAL_REFERENCE_SUN_COS, 0] as Rgb };
    const clear = createEnvironmentState({ sun });
    const denser = createEnvironmentState({
      sun,
      atmosphere: {
        rayleighScatteringPerMeter: clear.atmosphere.rayleighScatteringPerMeter
          .map((value) => value * 2) as Rgb,
      },
    });
    for (const state of [clear, denser]) {
      // At the reference key the sky is its own reference: a stale entry
      // from the other atmosphere would move these off 1.
      const physical = physicalSkyColours(state, [1, 1, 1], [0.6, 0.6, 0.7], 1);
      for (let channel = 0; channel < 3; channel += 1) {
        expect(physical.zenithRatio[channel]).toBeCloseTo(1, 9);
        expect(physical.horizonRatio[channel]).toBeCloseTo(1, 9);
      }
    }
  });
});
