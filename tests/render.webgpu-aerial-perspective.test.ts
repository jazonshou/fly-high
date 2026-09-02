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
  twilightArchStrength,
  twilightAmbientFloorFactor,
  twilightArchRadiance,
  nightZenithFade,
  NIGHT_ZENITH_FALLOFF,
  twilightWarmRadiance,
  twilightBeltRadiance,
  TWILIGHT_WARM_TINT,
  TWILIGHT_WARM_STRENGTH,
  TWILIGHT_BELT_RATIO,
  MOON_TWILIGHT_RECESSION,
  TWILIGHT_ARCH_TINT,
  TWILIGHT_ARCH_STRENGTH,
  TWILIGHT_ARCH_ZENITH_FALLOFF,
  TWILIGHT_ARCH_KEY_FACTOR,
  TWILIGHT_AMBIENT_FLOOR_CUT,
} from "../src/render/webgpu/atmosphere/AerialPerspective";
import {
  SKY_FRAGMENT_WGSL,
  sunDirectionalHorizonGate,
} from "../src/render/webgpu/atmosphere/AtmosphereSystem";
import { DEFAULT_ENVIRONMENT_STATE } from "../src/render/webgpu/nature/EnvironmentState";
import {
  FOG_MODE_NONE,
  collectStartupInvariantFailures,
} from "../src/render/webgpu/core/RenderInvariants";
import {
  CAMERA_FAR_PLANE_METERS,
  resolveWebGpuQualityProfile,
} from "../src/render/webgpu/core/QualityProfile";
import {
  resolveEnvironmentState,
  twilightExposureDipFactor,
} from "../src/render/webgpu/nature/EnvironmentDirector";
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
    // terminator taken from the TRUE sun direction. NIGHT_LOOK §2.1 made
    // `aerialSunDirection` the MOON below twilight (the integral's night
    // source), so the phase now reads a dedicated true-sun uniform — the
    // property this pin guards is unchanged (the drawn phase can never
    // disagree with the real sun-moon geometry), and reading
    // `aerialSunDirection` for the phase would now recreate the self-lit
    // always-full moon this assertion exists to prevent.
    expect(SKY_FRAGMENT_WGSL).toContain("uniform moonDirection: vec3f;");
    expect(SKY_FRAGMENT_WGSL).toContain("dot(surfaceNormal, uniforms.moonPhaseSunDirection)");
    expect(SKY_FRAGMENT_WGSL).not.toContain("dot(surfaceNormal, uniforms.aerialSunDirection)");
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

describe("the twilight arch window (NIGHT_LOOK_ARCHITECTURE 2.6)", () => {
  // ONE window feeds three consumers (dome arch, ambient-floor cut, chroma
  // blend), so its edges are load-bearing three times over: these pins are
  // on the WINDOW ITSELF, separate from every consumer, so a later edge
  // change fails one obvious assertion instead of three confusing ones.
  const sineAt = (solarTimeHours: number): number =>
    resolveEnvironmentState({
      clock: { dayOfYear: 171, solarTimeHours },
      latitudeDegrees: 45,
      weather: "clear",
    }).sun.direction[1];

  it("is zero at every pinned endpoint, by shape", () => {
    // Golden hour (19.0h, +0.111): above the window entirely.
    expect(twilightArchStrength(sineAt(19.0))).toBe(0);
    // Sunset exactly: continuous engagement, zero AT the boundary.
    expect(twilightArchStrength(0)).toBe(0);
    // The release edge itself.
    expect(twilightArchStrength(-0.26)).toBe(0);
    // night-moonlit (23.75h) and night (0h): the approved frames sit well
    // below the release and CANNOT move.
    expect(twilightArchStrength(sineAt(23.75))).toBe(0);
    expect(twilightArchStrength(sineAt(0))).toBe(0);
  });

  it("holds at full strength through the blue hour, dusk-mesopic mid-hold", () => {
    const duskSine = sineAt(20.45);
    expect(duskSine).toBeLessThan(-0.09);
    expect(duskSine).toBeGreaterThan(-0.13);
    expect(twilightArchStrength(duskSine)).toBeCloseTo(1, 6);
  });

  it("releases on the same edges as the 2.1 exposure dip", () => {
    // Behavioral equality, not shared constants: the dip's release runs
    // -0.16 (still fully held) to -0.26 (fully released). If either window
    // moves its release alone, one of these fails.
    expect(twilightExposureDipFactor(-0.16)).toBeCloseTo(0.55, 6);
    expect(twilightArchStrength(-0.16)).toBeCloseTo(1, 6);
    expect(twilightExposureDipFactor(-0.26)).toBeCloseTo(1, 6);
    expect(twilightArchStrength(-0.26)).toBe(0);
  });

  it("paints the sunset lobe toward the TRUE sun, zero outside the window", () => {
    // Round W. Premultiplied warm and belt are zero at every window
    // endpoint by the arch window's own proven shape — no new gate.
    for (const sine of [sineAt(12.5), sineAt(19.0), -0.26, sineAt(23.75), sineAt(0)]) {
      expect(twilightWarmRadiance(sine)).toEqual([0, 0, 0]);
      expect(twilightBeltRadiance(sine)).toEqual([0, 0, 0]);
    }
    const duskWarm = twilightWarmRadiance(sineAt(20.45));
    expect(duskWarm[0]).toBeCloseTo(TWILIGHT_WARM_TINT[0] * TWILIGHT_WARM_STRENGTH, 9);
    expect(duskWarm[0]).toBeGreaterThan(duskWarm[2]! * 2); // warm means R-dominant
    // The belt is the weaker pink tail, by the fixed ratio exactly.
    const duskBelt = twilightBeltRadiance(sineAt(20.45));
    expect(duskBelt[0]).toBeCloseTo(duskWarm[0]! * TWILIGHT_BELT_RATIO, 9);

    // The lobe aims at the TRUE sun, never the nightness-blended source: at
    // dusk with a moon the binding's sunDirection has swung toward the moon,
    // and sunsetDirection must not follow it.
    const duskState = resolveEnvironmentState({
      clock: { dayOfYear: 171, solarTimeHours: 20.45 },
      latitudeDegrees: 45,
      weather: "clear",
    });
    const dusk = resolveAerialPerspectiveBinding(
      duskState, 152, [0.9, 0.4, 0.25], [0.08, 0.075, 0.14], 0.1,
      [0, 1, 0], 0.8,
    );
    const s = duskState.sun.direction;
    const h = Math.hypot(s[0], s[2]);
    expect(dusk.sunsetDirection[0]).toBeCloseTo(s[0] / h, 9);
    expect(dusk.sunsetDirection[1]).toBeCloseTo(s[2] / h, 9);
    expect(Math.hypot(...dusk.sunsetDirection)).toBeCloseTo(1, 9);

    // And the MIRROR shows the azimuthal structure the sky was measured to
    // lack: at 5 deg elevation, sunward is warm (R/B > 1) and anti-solar
    // carries only the fainter pink — sunward red exceeds anti-solar red.
    const el = Math.sin((5 * Math.PI) / 180), c = Math.cos((5 * Math.PI) / 180);
    const sunward = evaluateSkyRadiance(dusk, [
      dusk.sunsetDirection[0] * c, el, dusk.sunsetDirection[1] * c,
    ]);
    const anti = evaluateSkyRadiance(dusk, [
      -dusk.sunsetDirection[0] * c, el, -dusk.sunsetDirection[1] * c,
    ]);
    // STRUCTURAL claims only — the display-domain R/B threshold lives in
    // the frame criteria where the knob budget is registered; a radiance
    // pin that hardcoded it would re-tune the knob from a test.
    const bare = {
      ...dusk,
      twilightWarm: [0, 0, 0] as [number, number, number],
      twilightBelt: [0, 0, 0] as [number, number, number],
    };
    const sunwardBare = evaluateSkyRadiance(bare, [
      dusk.sunsetDirection[0] * c, el, dusk.sunsetDirection[1] * c,
    ]);
    // The lobe at least doubles the sunward red over the azimuth-uniform sky…
    expect(sunward[0]!).toBeGreaterThan(sunwardBare[0]! * 2);
    // …asymmetrically: sunward red beats anti-solar red well past the belt.
    expect(anti[0]!).toBeGreaterThan(0);
    expect(sunward[0]!).toBeGreaterThan(anti[0]! * 1.5);
    // And the anti-solar side gained ONLY the fainter belt, nothing more.
    const antiBare = evaluateSkyRadiance(bare, [
      -dusk.sunsetDirection[0] * c, el, -dusk.sunsetDirection[1] * c,
    ]);
    expect(anti[0]! - antiBare[0]!).toBeLessThan(sunward[0]! - sunwardBare[0]!);
  });

  it("fades the night zenith on the NIGHTNESS gate, and day is exactly zero", () => {
    // Round G (Jason: "the blue transitions into black the further up you
    // look"). Gated by aerialNightness, deliberately NOT the twilight art
    // window — coupling a night ask to five dusk behaviours is the drift
    // this family's tests exist to prevent.
    expect(nightZenithFade(sineAt(12.5))).toBe(0);
    expect(nightZenithFade(sineAt(19.0))).toBe(0);
    expect(nightZenithFade(-0.07)).toBe(0); // nightness engages below here
    expect(nightZenithFade(sineAt(23.75))).toBe(NIGHT_ZENITH_FALLOFF);
    expect(nightZenithFade(sineAt(0))).toBe(NIGHT_ZENITH_FALLOFF);
    const dusk = nightZenithFade(sineAt(20.45));
    expect(dusk).toBeGreaterThan(0);
    expect(dusk).toBeLessThan(NIGHT_ZENITH_FALLOFF);
    // The mirror applies it multiplicatively over scatter AND arch: a zero
    // fade is the identity, so a day binding's sky is bit-identical.
    const noon = resolveAerialPerspectiveBinding(
      DEFAULT_ENVIRONMENT_STATE, 0, [1, 0.96, 0.88], [0.58, 0.77, 0.96], 1,
    );
    expect(noon.nightZenithFade).toBe(0);
    expect(Math.exp(-noon.nightZenithFade * 1)).toBe(1);
  });

  it("keeps the fade (and the arch) OUT of the terrain-haze path — pinned, not assumed", () => {
    // Load-bearing isolation: skyRadiance carries the arch and the zenith
    // fade; applyAerialPerspective is what terrain, water and every surface
    // consumer call. If skyRadiance is ever reached from the surface path,
    // the ground inherits sky-only terms — round 1 measured that failure
    // (the ground flooded). Pin the WGSL structure itself.
    const surfacePath = AERIAL_PERSPECTIVE_WGSL.slice(
      AERIAL_PERSPECTIVE_WGSL.indexOf("fn applyAerialPerspective("),
      AERIAL_PERSPECTIVE_WGSL.indexOf("fn skyRadiance("),
    );
    expect(surfacePath.length).toBeGreaterThan(100);
    expect(surfacePath).not.toContain("skyRadiance(");
    expect(surfacePath).not.toContain("aerialTwilightArch");
    expect(surfacePath).not.toContain("aerialNightZenithFade");
    expect(surfacePath).not.toContain("aerialTwilightWarm");
    expect(surfacePath).not.toContain("aerialTwilightBelt");
    expect(surfacePath).not.toContain("aerialSunsetDir");
    // And the sky path DOES carry both, with the exponential shape.
    const skyPath = AERIAL_PERSPECTIVE_WGSL.slice(
      AERIAL_PERSPECTIVE_WGSL.indexOf("fn skyRadiance("),
    );
    expect(skyPath).toContain("uniforms.aerialTwilightArch");
    expect(skyPath).toContain("exp(-uniforms.aerialNightZenithFade * max(direction.y, 0.0))");
  });

  it("gates the directional sun at the geometric horizon, not the art window", () => {
    // Round S: ground-level direct sun from below the horizon is impossible
    // (refraction ~0.5° ≈ 0.009 sine, inside the ±0.02 band). Exactly 1 at
    // every day clock — this is new code on the daylight path, and the gate
    // being the literal 1 there is what keeps day byte-identical.
    expect(sunDirectionalHorizonGate(sineAt(12.5))).toBe(1);
    expect(sunDirectionalHorizonGate(sineAt(19.0))).toBe(1);
    expect(sunDirectionalHorizonGate(0.02)).toBe(1);
    expect(sunDirectionalHorizonGate(0)).toBeCloseTo(0.5, 9);
    expect(sunDirectionalHorizonGate(-0.02)).toBe(0);
    expect(sunDirectionalHorizonGate(sineAt(20.45))).toBe(0);
    expect(sunDirectionalHorizonGate(sineAt(23.75))).toBe(0);
    expect(sunDirectionalHorizonGate(sineAt(0))).toBe(0);
    // And it is DELIBERATELY not the §2.6 twilight window: at sine −0.05 the
    // art window is fully open while the horizon gate is long closed. If
    // someone routes the gate through the window, this divergence assertion
    // fails before any frame does.
    expect(twilightArchStrength(-0.05)).toBeCloseTo(1, 6);
    expect(sunDirectionalHorizonGate(-0.05)).toBe(0);
  });

  it("recedes the moon only inside the window (consumer #6)", () => {
    // MOON_PEAK is a night calibration; mid-hold the moon keeps ~10% and
    // returns to full EXACTLY at the release, so the approved night frames
    // and the moon anchor's arithmetic are untouched by shape.
    const recession = (sine: number): number =>
      1 - MOON_TWILIGHT_RECESSION * twilightArchStrength(sine);
    expect(recession(sineAt(12.5))).toBe(1);
    expect(recession(sineAt(19.0))).toBe(1);
    expect(recession(sineAt(23.75))).toBe(1);
    expect(recession(sineAt(0))).toBe(1);
    expect(recession(-0.26)).toBe(1);
    expect(recession(sineAt(20.45))).toBeCloseTo(1 - MOON_TWILIGHT_RECESSION, 6);
  });

  it("cuts the ambient floor only inside the window", () => {
    // Outside: EXACTLY 1 — golden hour and the approved night frames get
    // the shipped max(scale, 0.2) byte-for-byte, preserving the floor's
    // own fp16/rod rationale where it binds.
    expect(twilightAmbientFloorFactor(sineAt(19.0))).toBe(1);
    expect(twilightAmbientFloorFactor(sineAt(23.75))).toBe(1);
    expect(twilightAmbientFloorFactor(sineAt(0))).toBe(1);
    // Mid-hold: the floor drops to 0.2 x (1 - cut) so ground can follow
    // the sky down through the blue hour.
    expect(twilightAmbientFloorFactor(sineAt(20.45)))
      .toBeCloseTo(1 - TWILIGHT_AMBIENT_FLOOR_CUT, 6);
  });

  it("feeds the binding a SKY-PATH arch at dusk and leaves day and night untouched", () => {
    // RESHAPED after round 1: the arch rode `ambient`, which the terrain
    // haze paints onto every distant pixel — the ground flooded (terrain
    // +2.1x, stop condition 3). It is now its own binding field, consumed
    // ONLY by skyRadiance(), so dome and IBL receive it and the haze does
    // not. `ambient` stays the daylight-gated expression — [0,0,0] at dusk.
    const horizon: [number, number, number] = [0.08, 0.075, 0.14];
    const duskState = resolveEnvironmentState({
      clock: { dayOfYear: 171, solarTimeHours: 20.45 },
      latitudeDegrees: 45,
      weather: "clear",
    });
    const dusk = resolveAerialPerspectiveBinding(duskState, 120, [0.9, 0.4, 0.25], horizon, 0.1);
    expect(dusk.ambient).toEqual([0, 0, 0]);
    expect(dusk.twilightArch[2]).toBeCloseTo(TWILIGHT_ARCH_TINT[2] * TWILIGHT_ARCH_STRENGTH, 9);
    expect(dusk.twilightArch[2]).toBeGreaterThan(dusk.twilightArch[0] * 2);
    // Night: window closed — no arch, ambient stays zero; the approved
    // night sky cannot have gained a term.
    const nightState = resolveEnvironmentState({
      clock: { dayOfYear: 171, solarTimeHours: 23.75 },
      latitudeDegrees: 45,
      weather: "clear",
    });
    const night = resolveAerialPerspectiveBinding(
      nightState, 120, [0.9, 0.4, 0.25], horizon, 0, [0, 1, 0], 0.8,
    );
    expect(night.ambient).toEqual([0, 0, 0]);
    expect(night.twilightArch).toEqual([0, 0, 0]);
    // Noon: arch zero, ambient is the daylight expression untouched.
    const noon = resolveAerialPerspectiveBinding(
      DEFAULT_ENVIRONMENT_STATE, 0, [1, 0.96, 0.88], [0.58, 0.77, 0.96], 1,
    );
    expect(noon.ambient[0]).toBeCloseTo(0.58 * 0.9, 6);
    expect(noon.twilightArch).toEqual([0, 0, 0]);
  });

  it("adds the arch in the sky integral with the explicit gradient, mirror and WGSL alike", () => {
    const horizon: [number, number, number] = [0.08, 0.075, 0.14];
    const duskState = resolveEnvironmentState({
      clock: { dayOfYear: 171, solarTimeHours: 20.45 },
      latitudeDegrees: 45,
      weather: "clear",
    });
    const dusk = resolveAerialPerspectiveBinding(duskState, 120, [0.9, 0.4, 0.25], horizon, 0.1);
    const bare = { ...dusk, twilightArch: [0, 0, 0] as [number, number, number] };
    // The mirror: sky-with-arch minus sky-without is EXACTLY the arch times
    // the gradient times round G's zenith fade — nothing else moved. (The
    // fade multiplies the WHOLE sky output, so it scales the arch's delta
    // too; at dusk the premultiplied fade is partial nightness.)
    const fadeAt = (y: number): number => Math.exp(-dusk.nightZenithFade * Math.max(y, 0));
    const zenithDelta = evaluateSkyRadiance(dusk, [0, 1, 0])[2]!
      - evaluateSkyRadiance(bare, [0, 1, 0])[2]!;
    const horizonDelta = evaluateSkyRadiance(dusk, [0.9994, 0.035, 0])[2]!
      - evaluateSkyRadiance(bare, [0.9994, 0.035, 0])[2]!;
    expect(zenithDelta).toBeCloseTo(
      dusk.twilightArch[2] * (1 - TWILIGHT_ARCH_ZENITH_FALLOFF) * fadeAt(1), 9,
    );
    expect(horizonDelta).toBeCloseTo(
      dusk.twilightArch[2] * (1 - TWILIGHT_ARCH_ZENITH_FALLOFF * 0.035) * fadeAt(0.035), 9,
    );
    // Horizon stays the bright edge of the arch; zenith the dark deep blue.
    expect(horizonDelta).toBeGreaterThan(zenithDelta);
    // And the WGSL carries the same term: the uniform is declared, the sky
    // function consumes it, and the falloff constant matches the export.
    expect(AERIAL_PERSPECTIVE_WGSL).toContain("uniform aerialTwilightArch: vec3f;");
    expect(AERIAL_PERSPECTIVE_WGSL).toContain(
      `* (1.0 - ${TWILIGHT_ARCH_ZENITH_FALLOFF} * clamp(direction.y, 0.0, 1.0))`,
    );
  });

  it("teaches sigma the arch's ground irradiance, in closed form", () => {
    // E/pi for the gradient s(u) = 1 - FALLOFF*u over the hemisphere is
    // 1 - (2/3)*FALLOFF — derived FROM the falloff so they cannot drift.
    expect(TWILIGHT_ARCH_KEY_FACTOR).toBeCloseTo(1 - (2 / 3) * TWILIGHT_ARCH_ZENITH_FALLOFF, 12);
    // Zero outside the window: day and night sigma are bit-identical.
    expect(twilightArchRadiance(0.5)).toEqual([0, 0, 0]);
    expect(twilightArchRadiance(-0.369)).toEqual([0, 0, 0]);
    // Inside: the radiance is the tint at strength, so sigma's term is real.
    const mid = twilightArchRadiance(-0.107);
    expect(mid[2]).toBeCloseTo(TWILIGHT_ARCH_TINT[2] * TWILIGHT_ARCH_STRENGTH, 9);
  });
});
