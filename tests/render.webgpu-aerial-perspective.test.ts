import { describe, expect, it } from "vitest";
import { terrainNodeSpanMeters } from "../src/render/webgpu/terrain/TerrainSpineContract";
import {
  AERIAL_PERSPECTIVE_FUNCTIONS_WGSL,
  AERIAL_PERSPECTIVE_UNIFORMS,
  AERIAL_PERSPECTIVE_WGSL,
  aerialPerspectiveCoefficients,
  evaluateAerialPerspective,
  exponentialPathIntegral,
  evaluateSkyRadiance,
  mieTurbidityMultiplier,
  ozonePathIntegral,
  ozoneTentIntegral,
  resolveAerialPerspectiveBinding,
} from "../src/render/webgpu/atmosphere/AerialPerspective";
import { SKY_FRAGMENT_WGSL } from "../src/render/webgpu/atmosphere/AtmosphereSystem";
import { DEFAULT_ENVIRONMENT_STATE } from "../src/render/webgpu/nature/EnvironmentState";
import {
  FOG_MODE_NONE,
  collectStartupInvariantFailures,
} from "../src/render/webgpu/core/RenderInvariants";
import {
  CAMERA_FAR_PLANE_METERS,
  resolveWebGpuQualityProfile,
} from "../src/render/webgpu/core/QualityProfile";
import { resolveEnvironmentState } from "../src/render/webgpu/nature/EnvironmentDirector";
import {
  MIE_SCALE_HEIGHT_METERS,
  OZONE_CENTER_METERS,
  OZONE_HALF_WIDTH_METERS,
  RAYLEIGH_SCALE_HEIGHT_METERS,
} from "../src/render/webgpu/atmosphere/AtmosphereLuts";

/**
 * 1C-4 — the aerial-perspective include: closed forms against numerical
 * references, the turbidity calibration the far plane depends on
 * (assertion 33), and the two startup guards (assertion 32). Assertion 31
 * (TS/WGSL agreement on a real adapter) lives in tests/gpu/.
 */

const CLEAR_NOON = resolveEnvironmentState({
  clock: { dayOfYear: 171, solarTimeHours: 12.5 },
  latitudeDegrees: 45,
  weather: "clear",
});

function numericExponentialIntegral(
  h0: number,
  h1: number,
  d: number,
  scaleHeight: number,
  steps = 4_000,
): number {
  let sum = 0;
  for (let index = 0; index < steps; index += 1) {
    const t = (index + 0.5) / steps;
    const altitude = Math.max(h0 + (h1 - h0) * t, 0);
    sum += Math.exp(-altitude / scaleHeight);
  }
  return (sum / steps) * d;
}

function numericOzoneIntegral(h0: number, h1: number, d: number, steps = 4_000): number {
  let sum = 0;
  for (let index = 0; index < steps; index += 1) {
    const t = (index + 0.5) / steps;
    const altitude = Math.max(h0 + (h1 - h0) * t, 0);
    sum += Math.max(0, 1 - Math.abs(altitude - OZONE_CENTER_METERS) / OZONE_HALF_WIDTH_METERS);
  }
  return (sum / steps) * d;
}

describe("closed-form path integrals (1C-4)", () => {
  it("matches a numerical reference within 0.5% for exponential species", () => {
    for (const [h0, h1, d] of [
      [0, 0, 45_000],
      [0, 2_800, 30_000],
      [9_000, 150, 42_000],
      [1_200, 11_000, 45_000],
      [30, 45, 18_000],
    ] as const) {
      for (const scaleHeight of [RAYLEIGH_SCALE_HEIGHT_METERS, MIE_SCALE_HEIGHT_METERS]) {
        const closed = exponentialPathIntegral(h0, h1, d, scaleHeight);
        const numeric = numericExponentialIntegral(h0, h1, d, scaleHeight);
        expect(Math.abs(closed - numeric) / Math.max(numeric, 1e-9)).toBeLessThan(0.005);
      }
    }
  });

  it("matches a numerical reference within 0.5% for the ozone tent", () => {
    for (const [h0, h1, d] of [
      [0, 45_000, 90_000],
      [8_000, 26_000, 40_000],
      [26_000, 12_000, 30_000],
      [20_000, 21_000, 5_000],
    ] as const) {
      const closed = ozonePathIntegral(h0, h1, d);
      const numeric = numericOzoneIntegral(h0, h1, d);
      expect(Math.abs(closed - numeric) / Math.max(numeric, 1e-9)).toBeLessThan(0.005);
    }
  });

  it("integrates the tent to its exact area", () => {
    expect(ozoneTentIntegral(OZONE_CENTER_METERS + OZONE_HALF_WIDTH_METERS))
      .toBeCloseTo(OZONE_HALF_WIDTH_METERS, 6);
    expect(ozoneTentIntegral(OZONE_CENTER_METERS)).toBeCloseTo(OZONE_HALF_WIDTH_METERS / 2, 6);
    expect(ozoneTentIntegral(OZONE_CENTER_METERS - OZONE_HALF_WIDTH_METERS)).toBe(0);
  });
});

describe("the TS mirror's behaviour (1C-4)", () => {
  const binding = resolveAerialPerspectiveBinding(
    CLEAR_NOON,
    0,
    [1, 0.96, 0.88],
    [0.58, 0.77, 0.96],
    1,
  );

  function sample(distance: number, toAltitude = 0, mu = 0.3) {
    return evaluateAerialPerspective(
      binding.coefficients,
      binding.cameraAltitudeMeters,
      toAltitude,
      distance,
      mu,
      binding.sunRadiance,
      binding.ambient,
      binding.sunTransmittance,
    );
  }

  it("is the identity at zero distance", () => {
    const zero = sample(0);
    expect(zero.transmittance).toEqual([1, 1, 1]);
    expect(zero.inScatter).toEqual([0, 0, 0]);
  });

  it("loses transmittance monotonically with distance, gaining in-scatter", () => {
    let previous = sample(1);
    for (const distance of [100, 1_000, 5_000, 15_000, 30_000, 45_000]) {
      const current = sample(distance);
      for (let channel = 0; channel < 3; channel += 1) {
        expect(current.transmittance[channel]!).toBeLessThan(previous.transmittance[channel]!);
        expect(current.inScatter[channel]!).toBeGreaterThan(previous.inScatter[channel]!);
        expect(current.transmittance[channel]!).toBeGreaterThanOrEqual(0);
        expect(current.transmittance[channel]!).toBeLessThanOrEqual(1);
      }
      previous = current;
    }
  });

  it("hazes an upward ray less than a level one — the height falloff the audit demanded", () => {
    const level = sample(20_000, 0);
    const upward = sample(20_000, 9_000);
    for (let channel = 0; channel < 3; channel += 1) {
      expect(upward.transmittance[channel]!).toBeGreaterThan(level.transmittance[channel]!);
    }
  });

  it("scatters more looking toward the sun than away from it", () => {
    const toward = sample(25_000, 0, 0.98);
    const away = sample(25_000, 0, -0.98);
    // Forward Mie lobe dominates; Rayleigh's symmetric term keeps both finite.
    expect(toward.inScatter[0]!).toBeGreaterThan(away.inScatter[0]!);
    expect(away.inScatter[2]!).toBeGreaterThan(0);
  });
});

describe("turbidity calibration and the far plane (assertion 33)", () => {
  it("expresses weather turbidity exactly once, pinned", () => {
    expect(mieTurbidityMultiplier(0)).toBe(1);
    expect(mieTurbidityMultiplier(0.45)).toBeCloseTo(12.7, 5);
    expect(mieTurbidityMultiplier(1)).toBe(27);
    // Clamped outside [0, 1]; humidity is a fraction, not a percentage.
    expect(mieTurbidityMultiplier(40)).toBe(27);
  });

  it("reaches ≥95% luminance opacity at the far plane in clear weather at ground level", () => {
    const coefficients = aerialPerspectiveCoefficients(CLEAR_NOON);
    const { transmittance } = evaluateAerialPerspective(
      coefficients,
      0,
      0,
      CAMERA_FAR_PLANE_METERS,
      0.2,
      [1, 1, 1],
      [0, 0, 0],
      [1, 1, 1],
    );
    const luminance = 0.2126 * transmittance[0]
      + 0.7152 * transmittance[1]
      + 0.0722 * transmittance[2];
    expect(luminance).toBeLessThanOrEqual(0.05);
    // ...while a 10 km mountain is still clearly visible: haze, not soup.
    const near = evaluateAerialPerspective(
      coefficients,
      0,
      0,
      10_000,
      0.2,
      [1, 1, 1],
      [0, 0, 0],
      [1, 1, 1],
    );
    const nearLuminance = 0.2126 * near.transmittance[0]
      + 0.7152 * near.transmittance[1]
      + 0.0722 * near.transmittance[2];
    expect(nearLuminance).toBeGreaterThan(0.4);
  });

  it("keeps every tier's guaranteed ring coverage consistent with the far plane", () => {
    expect(CAMERA_FAR_PLANE_METERS).toBe(45_000);
    const combos = [
      ["low", "performance"],
      ["low", "balanced"],
      ["medium", "balanced"],
      ["high", "balanced"],
      ["high", "ultra"],
    ] as const;
    for (const [quality, mode] of combos) {
      const profile = resolveWebGpuQualityProfile(quality, mode);
      // 4-5: the ring ladder is gone. The quadtree roots at level 9 (32,768 m
      // nodes) and `selectTerrainNodes` sizes its root ring from the far
      // plane, so coverage is no longer a per-tier constant that could fall
      // short of it — EVERY tier now covers the far plane by construction,
      // including tier 0, which used to stop at 32.8 km.
      const rootSpan = terrainNodeSpanMeters(9);
      expect(
        rootSpan * 2,
        `tier ${profile.tier} must cover the far plane`,
      ).toBeGreaterThanOrEqual(CAMERA_FAR_PLANE_METERS);
      // What DOES stay a tier knob is how finely that coverage is resolved.
      expect(profile.cdlodNodeBudget).toBeGreaterThan(0);
    }
  });
});

describe("startup guards (assertion 32)", () => {
  const baseline = {
    timestampQuerySupported: true,
    gpuTimingEnabled: true,
    requestedFeatures: [],
    grantedFeatures: [],
  };

  it("rejects image processing applied in-shader", () => {
    const failures = collectStartupInvariantFailures({
      ...baseline,
      imageProcessingAppliedByPostProcess: false,
      sceneFogMode: FOG_MODE_NONE,
    });
    expect(failures.some((failure) => failure.includes("post-process"))).toBe(true);
  });

  it("rejects any Babylon fog mode other than FOGMODE_NONE", () => {
    const failures = collectStartupInvariantFailures({
      ...baseline,
      imageProcessingAppliedByPostProcess: true,
      sceneFogMode: 2,
    });
    expect(failures.some((failure) => failure.includes("FOGMODE_NONE"))).toBe(true);
  });

  it("passes the healthy configuration, and stays silent when fields are omitted", () => {
    expect(collectStartupInvariantFailures({
      ...baseline,
      imageProcessingAppliedByPostProcess: true,
      sceneFogMode: FOG_MODE_NONE,
    })).toEqual([]);
    expect(collectStartupInvariantFailures(baseline)).toEqual([]);
  });
});

describe("the physical sky (1C-5)", () => {
  const binding = resolveAerialPerspectiveBinding(
    CLEAR_NOON,
    120,
    [1, 0.96, 0.88],
    [0.58, 0.77, 0.96],
    1,
  );
  const luminance = (rgb: readonly [number, number, number]): number =>
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

  it("meets the terrain haze at the horizon — same integral, same limit", () => {
    // A horizontal sky ray and an extremely long horizontal haze path must
    // converge on the same radiance: this is the coastline-tear fix made
    // structural. Perpendicular to the sun so the comparison uses the same mu.
    const sunDirection = binding.sunDirection;
    const azimuth = [sunDirection[2], 0, -sunDirection[0]] as [number, number, number];
    const horizontal = Math.hypot(azimuth[0], azimuth[2]);
    const direction: [number, number, number] = [
      azimuth[0] / horizontal,
      0.0025,
      azimuth[2] / horizontal,
    ];
    const sky = evaluateSkyRadiance(binding, direction);
    const mu = direction[0] * sunDirection[0]
      + direction[1] * sunDirection[1]
      + direction[2] * sunDirection[2];
    const haze = evaluateAerialPerspective(
      binding.coefficients,
      binding.cameraAltitudeMeters,
      binding.cameraAltitudeMeters,
      2_000_000,
      mu,
      binding.sunRadiance,
      binding.ambient,
      binding.sunTransmittance,
    ).inScatter;
    for (let channel = 0; channel < 3; channel += 1) {
      expect(Math.abs(sky[channel]! - haze[channel]!)).toBeLessThan(0.02);
    }
  });

  it("keeps the zenith darker and bluer than the horizon", () => {
    const zenith = evaluateSkyRadiance(binding, [0, 1, 0]);
    const horizon = evaluateSkyRadiance(binding, [1, 0.0025, 0]);
    expect(luminance(zenith)).toBeLessThan(luminance(horizon) * 0.55);
    expect(zenith[2]!).toBeGreaterThan(zenith[0]! * 1.5);
  });

  it("fills the below-horizon sphere with bright haze, not a ground colour", () => {
    // Rays under the horizon read the clamped horizon integral, so the strip
    // between the terrain edge and the geometric horizon is haze that the
    // world's own fade already matches.
    const below = evaluateSkyRadiance(binding, [0.92, -0.39, 0]);
    const horizon = evaluateSkyRadiance(binding, [1, 0.0025, 0]);
    expect(luminance(below)).toBeGreaterThan(luminance(horizon) * 0.5);
  });

  it("draws the sun disc at the state's true angular radius", () => {
    expect(DEFAULT_ENVIRONMENT_STATE.sun.angularRadiusRadians).toBeCloseTo(0.004675, 9);
    expect(SKY_FRAGMENT_WGSL).toContain("SUN_ANGULAR_RADIUS: f32 = 0.004675");
    expect(SKY_FRAGMENT_WGSL).toContain("skyRadiance(view)");
    // The disc reddens through the shared transmittance — no private tint.
    expect(SKY_FRAGMENT_WGSL).toContain("uniforms.aerialSunTransmittance");
  });
});

describe("night below the horizon (1C-10, superseded by Gate 7A)", () => {
  it("keeps midnight inside the exposure clamp with the sun below the horizon", () => {
    const midnight = resolveEnvironmentState({
      clock: { dayOfYear: 171, solarTimeHours: 0 },
      latitudeDegrees: 45,
      weather: "clear",
    });
    expect(midnight.sun.direction[1]).toBeLessThan(0);
    const binding = resolveAerialPerspectiveBinding(
      midnight,
      120,
      [0.9, 0.4, 0.25],
      [0.08, 0.075, 0.14],
      0,
    );
    // The daylight gate takes the haze ambient to zero and the sun term is
    // dark: the sky integral goes near-black without producing NaNs.
    const zenith = evaluateSkyRadiance(binding, [0, 1, 0]);
    for (const value of zenith) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeLessThan(0.02);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it("has no placeholder star hash or anti-solar moon left in it (7-1, 7-3)", () => {
    // 1C-10's placeholder hashed the view direction into identical "stars"
    // on a dome that never rotated, and nailed the moon to the exact
    // anti-solar point — so it was always full and always opposite the sun.
    // Gate 7A deletes both; the negative assertion is what keeps them from
    // creeping back beside the real ones.
    expect(SKY_FRAGMENT_WGSL).not.toContain("starMask");
    expect(SKY_FRAGMENT_WGSL).not.toContain("starHash");
    expect(SKY_FRAGMENT_WGSL).not.toContain("normalize(-uniforms.aerialSunDirection)");
    // The real moon: its own ephemeris direction and angular radius, and a
    // terminator taken from the sky's OWN sun direction, so the drawn phase
    // can never disagree with the light the scene is lit by.
    expect(SKY_FRAGMENT_WGSL).toContain("uniform moonDirection: vec3f;");
    expect(SKY_FRAGMENT_WGSL).toContain("dot(surfaceNormal, uniforms.aerialSunDirection)");
    expect(SKY_FRAGMENT_WGSL).toContain("earthshine");
    // The Milky Way rides the star field's own galactic frame.
    expect(SKY_FRAGMENT_WGSL).toContain("uniforms.galacticPole");
    expect(SKY_FRAGMENT_WGSL).toContain("uniforms.galacticCenter");
  });
});

describe("the include's WGSL surface (1C-4)", () => {
  it("declares exactly the uniforms the binding fans out", () => {
    for (const name of AERIAL_PERSPECTIVE_UNIFORMS) {
      expect(AERIAL_PERSPECTIVE_WGSL).toContain(`uniform ${name}:`);
    }
  });

  it("strips every uniform declaration from the plugin/kernel variant", () => {
    expect(AERIAL_PERSPECTIVE_FUNCTIONS_WGSL).not.toMatch(/uniform aerial/);
    expect(AERIAL_PERSPECTIVE_FUNCTIONS_WGSL).toContain("fn aerialPerspective(");
    expect(AERIAL_PERSPECTIVE_FUNCTIONS_WGSL).toContain("fn applyAerialPerspective(");
  });
});
