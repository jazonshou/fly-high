import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  OCEAN_PRESENTATION_RADIUS_METERS,
  WATER_FRAGMENT_WGSL,
  WATER_VERTEX_WGSL,
  oceanMeshCascadeFadeRadius,
  resolveProfileSpectralOceanConfig,
} from "../src/render/webgpu/water/SpectralOceanSystem";

/**
 * Pin moved by wave R: `oceanPresentationTopology(profile)` was a
 * `profile.tier` table inside water/, the boundary test's last grandfathered
 * tier reader. The lattice is now a profile DATUM, so the same assertions read
 * `profile.oceanPresentation` directly.
 */
const oceanPresentationTopology = (
  profile: ReturnType<typeof resolveWebGpuQualityProfile>,
) => profile.oceanPresentation;

describe("spectral ocean presentation topology", () => {
  it("covers off-axis far-plane corners without adding presentation topology", () => {
    // The camera far plane is view depth, not a radial sphere. A disk equal to
    // 45 km exposed its circular edge in the downward material capture. Only
    // the final coverage-skirt ring moves; the assertions below pin the prior
    // 40 km detail lattice and its mesh-Nyquist fade radii.
    expect(OCEAN_PRESENTATION_RADIUS_METERS).toBe(90_000);
  });

  it("uses a depth-aware, variance-filtered physical surface without a duplicate cloud field", () => {
    // 2-8: distance filtering is Toksvig — the moment mips' slope variance
    // becomes roughness; the old ad-hoc smoothstep distance term is gone.
    expect(WATER_FRAGMENT_WGSL).toContain("slopeVariance");
    expect(WATER_FRAGMENT_WGSL).not.toContain("distanceRoughness");
    // 5-11: bathymetry drives Beer-Lambert transmission and the soft shore;
    // the former constant additive deep colour and opaque alpha are retired.
    expect(WATER_FRAGMENT_WGSL).toContain("WATER_ABSORPTION_PER_METER");
    expect(WATER_FRAGMENT_WGSL).toContain("waterShorelineAlpha(depth)");
    expect(WATER_FRAGMENT_WGSL).not.toContain("deepAbsorption");
    // Slopes are stored and summed directly (fade-weighted) — the clamped
    // normal-recovery denominator must stay deleted.
    expect(WATER_FRAGMENT_WGSL).toContain("cascadeFades");
    expect(WATER_FRAGMENT_WGSL).not.toContain("max(baseSample.y, 0.08)");
    // Mip selection needs derivatives of the UNWRAPPED coordinate.
    expect(WATER_FRAGMENT_WGSL).toContain("textureSampleGrad");
    expect(WATER_FRAGMENT_WGSL).toContain("dpdx(unwrapped)");
    expect(WATER_FRAGMENT_WGSL).toContain(
      "vec4f(max(water, vec3f(0.0)), shorelineAlpha)",
    );
    expect(WATER_FRAGMENT_WGSL).not.toContain("fn cloudNoise");
  });

  it("keys the capillary band on the anisotropy-limited footprint (wave R fix 1)", () => {
    // Fix-pack T2's terrain precedent, now on water: the raw major axis killed
    // both ripple octaves within 10-20 m of a low eye while the minor axis —
    // the one a 16x anisotropic sampler resolves — stayed small for hundreds
    // of metres. Measured reach from a 2 m eye: octave A 14 m -> 63 m,
    // octave B 8.8 m -> 39 m.
    expect(WATER_FRAGMENT_WGSL).toContain("footprintMinor");
    expect(WATER_FRAGMENT_WGSL).toContain("footprintMajor * 0.062500");
    expect(WATER_FRAGMENT_WGSL).not.toContain(
      "let footprint = max(length(dpdx(worldXZ)), length(dpdy(worldXZ)));",
    );
  });

  it("makes roughness a field rather than a constant (wave R fix 2)", () => {
    // The unresolved tail used to be `0.014 * wind01` — one number per frame,
    // so every ocean pixel arrived at 0.328-0.34 and every lake pixel exactly
    // at its 0.28 cap. It now scales with the locally resolved slope and with
    // a world-locked gust field, and the caps have room above them.
    expect(WATER_FRAGMENT_WGSL).toContain("resolvedSlope");
    expect(WATER_FRAGMENT_WGSL).toContain("0.006 * wind01 * slopeGain");
    expect(WATER_FRAGMENT_WGSL).not.toContain("var unresolved = 0.014 * wind01;");
    expect(WATER_FRAGMENT_WGSL).toContain("0.065, 0.5)");
    expect(WATER_FRAGMENT_WGSL).toContain("waterGustField");
    // The gust field is anchored to ABSOLUTE world metres, so it must use the
    // integer hash — a fract-of-product hash degenerates past ~1e5 m, which is
    // a recorded incident in this repo (groundHash2).
    expect(WATER_FRAGMENT_WGSL).toContain("0x27d4eb2du");
    expect(WATER_FRAGMENT_WGSL).not.toMatch(/fn waterDetailHash[\s\S]{0,200}fract\(vec3f/u);
  });

  it("displaces near vertices with the fragment's own ripple lattices (wave R fix 3)", () => {
    // Vertex and fragment must not disagree, so both call the SAME functions
    // out of the shared noise block.
    for (const name of ["waterRippleGradA", "waterRippleGradB", "waterRippleWind", "waterRippleDrift"]) {
      expect(WATER_VERTEX_WGSL, name).toContain(name);
      expect(WATER_FRAGMENT_WGSL, name).toContain(name);
    }
    expect(WATER_VERTEX_WGSL).toContain("detailHeight");
    // Gated on slant range to the rings whose step can carry it.
    expect(WATER_VERTEX_WGSL).toContain("smoothstep(6.0, 26.0, slantRange)");
  });

  it("fades displacement on the lattice's Nyquist but slope on the pixel's (wave R fix 4)", () => {
    // The vertex lattice and the mip-filtered slope texture have different
    // reconstruction limits, so they get different fade ends. The DISPLACEMENT
    // takes min(pixel, mesh); the varying the fragment shades with keeps the
    // pixel fade, so a mesh-faded band survives as a filtered normal instead
    // of being flattened into roughness.
    expect(WATER_VERTEX_WGSL).toContain("cascadeMeshFadeRadii0");
    expect(WATER_VERTEX_WGSL).toContain("min(uniforms.cascadeFadeRadii0.x, uniforms.cascadeMeshFadeRadii0.x)");
    expect(WATER_VERTEX_WGSL).toContain("displacement0Sampler) * meshFades.x");
    expect(WATER_VERTEX_WGSL).toContain("vertexOutputs.cascadeFades = fades;");
  });

  it("gives the sun lobe a jitter the reflection never sees (wave R fix 7)", () => {
    expect(WATER_FRAGMENT_WGSL).toContain("glintSlope");
    expect(WATER_FRAGMENT_WGSL).toContain("sunSpecular(glintNormal");
    // The environment reflection and the Fresnel term stay on the shared
    // normal — jittering those would boil the reflected sky.
    expect(WATER_FRAGMENT_WGSL).toContain("let reflectionDirection = reflect(-view, normal);");
    expect(WATER_FRAGMENT_WGSL).toContain("waterInterfaceFresnel(normal, view, cameraBelow)");
  });

  it("gives the open sea a broken-up shore foam band (wave R fix 6)", () => {
    expect(WATER_FRAGMENT_WGSL).toContain("shoreBand");
    expect(WATER_FRAGMENT_WGSL).toContain("shoreBreakup");
    // It must rise from zero AT the waterline: the disk is drawn over dry land
    // too, where depth is 0 and the surface is transparent.
    expect(WATER_FRAGMENT_WGSL).toContain("smoothstep(0.0, 1.1, depth)");
  });

  it("routes ripples, gusts and foam from the spectrum's own wind (wave R fix 8)", () => {
    expect(WATER_FRAGMENT_WGSL).toContain("uniform oceanWind: vec2f;");
    expect(WATER_FRAGMENT_WGSL).not.toContain("cloudWind");
    expect(WATER_VERTEX_WGSL).toContain("uniforms.oceanWind");
  });

  it("drops the surface with the Earth's curvature before the world transform (1C-7)", () => {
    expect(WATER_VERTEX_WGSL).toContain(
      "dot(vertexInputs.position.xz, vertexInputs.position.xz) / (2.0 * 6371000.0)",
    );
    // The drop applies to the displaced position, before the world transform.
    expect(WATER_VERTEX_WGSL.indexOf("6371000.0"))
      .toBeLessThan(WATER_VERTEX_WGSL.indexOf("uniforms.world * displaced"));
  });

  it("follows the resolved WebGPU tier instead of raw scenery quality", () => {
    const lowUltra = resolveWebGpuQualityProfile("low", "ultra");
    const mediumBalanced = resolveWebGpuQualityProfile("medium", "balanced");
    const highPerformance = resolveWebGpuQualityProfile("high", "performance");
    const highUltra = resolveWebGpuQualityProfile("high", "ultra");

    expect(oceanPresentationTopology(lowUltra)).toEqual(
      oceanPresentationTopology(mediumBalanced),
    );
    expect(oceanPresentationTopology(highPerformance)).toEqual(
      oceanPresentationTopology(mediumBalanced),
    );
    // Pin moved by wave R: 192 -> 240 rings (the near lattice was densified so
    // the mesh can carry cascade 0 at all); 256 angular segments unchanged.
    expect(oceanPresentationTopology(highUltra)).toMatchObject({
      radialRings: 240,
      angularSegments: 256,
    });
  });

  it("keeps every tier's near lattice finer than its cascade-0 Nyquist need", () => {
    // wave R fix 4. The ocean's finest band is 1-8 m; the mesh may only sum a
    // cascade into vertices where its radial step can carry it. These are the
    // measured fade radii the shader now takes the min() with.
    const meshFade = (
      quality: "low" | "medium" | "high",
      mode: "performance" | "balanced" | "ultra",
      wavelength: number,
    ) => oceanMeshCascadeFadeRadius(
      resolveWebGpuQualityProfile(quality, mode).oceanPresentation,
      wavelength,
    );

    // Tier 1, cascade 0 (8 m band top): 44 m before wave R on the 144-ring /
    // 0.75 m lattice — the measured origin of the near-field aliasing — and
    // 49.5 m after, with the innermost rings now genuinely resolving half-metre
    // waves instead of only pretending to.
    expect(meshFade("medium", "balanced", 8)).toBeGreaterThan(45);
    expect(meshFade("medium", "balanced", 8)).toBeLessThan(56);
    expect(oceanMeshCascadeFadeRadius(
      { radialRings: 144, angularSegments: 192, nearStepMeters: 0.75 },
      8,
    )).toBeCloseTo(44.4, 0);

    // Monotone in wavelength, and strictly inside the pixel fade the shader
    // takes the min() against (cascade 0's pixel fade is kilometres).
    expect(meshFade("medium", "balanced", 32))
      .toBeGreaterThan(meshFade("medium", "balanced", 8));
    expect(meshFade("medium", "balanced", 512))
      .toBeGreaterThan(meshFade("medium", "balanced", 128));

    // A band the near step cannot carry anywhere fades to nothing rather than
    // aliasing: half of 0.3 m is below every tier's near step.
    for (const mode of ["performance", "balanced", "ultra"] as const) {
      expect(meshFade("high", mode, 0.3)).toBe(0);
    }
    // Denser tiers reach further before the lattice gives up.
    expect(meshFade("high", "ultra", 8)).toBeGreaterThan(meshFade("low", "performance", 8));
  });

  it("increases radial and angular density monotonically", () => {
    const low = oceanPresentationTopology(
      resolveWebGpuQualityProfile("low", "performance"),
    );
    const medium = oceanPresentationTopology(
      resolveWebGpuQualityProfile("medium", "balanced"),
    );
    const high = oceanPresentationTopology(
      resolveWebGpuQualityProfile("high", "ultra"),
    );

    expect(low.radialRings).toBeLessThan(medium.radialRings);
    expect(medium.radialRings).toBeLessThan(high.radialRings);
    expect(low.angularSegments).toBeLessThan(medium.angularSegments);
    expect(medium.angularSegments).toBeLessThan(high.angularSegments);
  });

  it("keeps every quality profile Nyquist-safe at its selected FFT resolution", () => {
    for (const quality of ["low", "medium", "high"] as const) {
      for (const mode of ["performance", "balanced", "ultra"] as const) {
        const profile = resolveWebGpuQualityProfile(quality, mode);
        const config = resolveProfileSpectralOceanConfig(profile, 0x51a7e);
        expect(config.resolution).toBe(profile.oceanResolution);
        expect(config.cascades).toHaveLength(profile.oceanCascades);
        for (const cascade of config.cascades) {
          expect(cascade.minimumWavelengthMeters).toBeGreaterThanOrEqual(
            2 * cascade.patchLengthMeters / config.resolution,
          );
        }
      }
    }
  });
});
