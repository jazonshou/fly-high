import { describe, expect, it } from "vitest";
import {
  groundCoverOf,
  groundNoise,
  groundNoiseGradient,
  groundScrubCrownMean,
  groundScrubExpectation,
  GROUND_BARE_EXPECTED_COVERAGE,
  GROUND_BARE_THRESHOLD_HIGH,
  GROUND_BARE_THRESHOLD_LOW,
  GROUND_DRYNESS_AMPLITUDE,
  GROUND_DRYNESS_LOG_RATIO,
  GROUND_DRYNESS_SHAPE,
  GROUND_DRYNESS_SHAPE_VARIANCE,
  GROUND_NOISE_SIGMA,
  GROUND_SCRUB_COVERAGE_FIT,
  GROUND_SCRUB_HEIGHT_FIT,
  GROUND_VIGOUR_COARSE_AMPLITUDE,
  GROUND_VIGOUR_CREASE_AMPLITUDE,
  GROUND_VIGOUR_CREASE_MEAN,
  GROUND_VIGOUR_CREASE_OFFSET,
  GROUND_VIGOUR_CREASE_SHARPNESS,
  GROUND_VIGOUR_FINE_AMPLITUDE,
  GROUND_VIGOUR_LOG_AXIS,
  GROUND_VIGOUR_MID_AMPLITUDE,
  GROUND_VIGOUR_STACK_VARIANCE,
  TERRAIN_GROUND_PATCHWORK_WGSL,
} from "@/src/render/webgpu/terrain/GroundPatchwork";
import { SurfaceMaterial, surfaceMaterialSpec } from "@/src/render/webgpu/terrain/surfaceMaterials";
import { resolveWebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";

/**
 * `W-1` — the ground patchwork's arithmetic, and the house rules its WGSL has
 * to keep.
 *
 * Every claim tested here is one the shader cannot make visible on its own: a
 * term that fades to the wrong expectation draws a ring at the range it fades,
 * and a multiplicative field whose mean is not one relights the world through
 * `R-26`'s ground bounce. Both are slow, quiet defects, so they are pinned
 * numerically against the same CPU twin the constants were measured from.
 */
function sampleField(count: number, salt: number, evaluate: (x: number, y: number) => number) {
  // A fixed low-discrepancy walk: deterministic, and it does not favour the
  // lattice the gradient noise is built on.
  let sum = 0;
  let squares = 0;
  for (let index = 0; index < count; index += 1) {
    const x = ((index * 0.7548776662) % 1) * 4_096 - 2_048 + salt;
    const y = ((index * 0.5698402909) % 1) * 4_096 - 2_048 - salt;
    const value = evaluate(x, y);
    sum += value;
    squares += value * value;
  }
  const mean = sum / count;
  return { mean, variance: squares / count - mean * mean };
}

describe("W-1 the ground patchwork's noise", () => {
  it("is unit variance and zero mean at the declared sigma", () => {
    const { mean, variance } = sampleField(60_000, 11, (x, y) => groundNoise(x / 37, y / 37, 0x4d1));
    expect(Math.abs(mean)).toBeLessThan(0.02);
    expect(variance).toBeGreaterThan(0.9);
    expect(variance).toBeLessThan(1.1);
    // The gain is the reciprocal of the measured sigma, so the two must agree.
    expect(GROUND_NOISE_SIGMA).toBeCloseTo(0.17593, 5);
  });

  it("returns the analytic derivative of its own value", () => {
    const step = 1e-4;
    const points: readonly (readonly [number, number])[] = [
      [12.3456, 7.891], [-3.2, 41.7], [0.5, 0.5], [128.25, -64.75],
    ];
    for (const [x, y] of points) {
      const [value, dx, dy] = groundNoiseGradient(x, y, 5);
      const ahead = groundNoiseGradient(x + step, y, 5)[0];
      const above = groundNoiseGradient(x, y + step, 5)[0];
      expect(dx).toBeCloseTo((ahead - value) / step, 2);
      expect(dy).toBeCloseTo((above - value) / step, 2);
    }
  });

  it("does not degenerate at the world coordinates it is used at", () => {
    // The whole reason the hash is integer: a fract-of-product hash collapses
    // into bands out here, which is the recorded incident behind groundHash2.
    for (const origin of [0, 50_000, 250_000]) {
      const { variance } = sampleField(20_000, origin, (x, y) => groundNoise(x / 53, y / 53, 0x91f3));
      expect(variance).toBeGreaterThan(0.85);
    }
  });
});

describe("W-1 the dryness remap", () => {
  it("keeps the shaping's measured variance", () => {
    const { mean, variance } = sampleField(200_000, 3, (x, y) => {
      const driver = groundNoise(x / 163, y / 163, 0x4d1) * 0.78
        + groundNoise(x / 53, y / 53, 0x91f3) * 0.62;
      return driver / (Math.abs(driver) + GROUND_DRYNESS_SHAPE);
    });
    expect(Math.abs(mean)).toBeLessThan(0.03);
    // The constant the albedo ratio's mean-one correction is derived from.
    expect(variance).toBeGreaterThan(GROUND_DRYNESS_SHAPE_VARIANCE * 0.75);
    expect(variance).toBeLessThan(GROUND_DRYNESS_SHAPE_VARIANCE * 1.25);
  });

  it("is mean one per channel, which is what the light rig integrates", () => {
    const axis = GROUND_DRYNESS_LOG_RATIO;
    const bias = axis.map((channel) =>
      Math.exp(channel * channel * 0.5 * GROUND_DRYNESS_SHAPE_VARIANCE
        * GROUND_DRYNESS_AMPLITUDE * GROUND_DRYNESS_AMPLITUDE));
    for (let channel = 0; channel < 3; channel += 1) {
      const { mean } = sampleField(200_000, 7 + channel, (x, y) => {
        const driver = groundNoise(x / 163, y / 163, 0x4d1) * 0.78
          + groundNoise(x / 53, y / 53, 0x91f3) * 0.62;
        const shaped = driver / (Math.abs(driver) + GROUND_DRYNESS_SHAPE);
        const shift = Math.max(-0.65, Math.min(0.65, shaped * GROUND_DRYNESS_AMPLITUDE));
        return Math.exp(axis[channel]! * shift) / bias[channel]!;
      });
      expect(mean).toBeGreaterThan(0.97);
      expect(mean).toBeLessThan(1.03);
    }
  });

  it("runs between the two reference albedos it interpolates", () => {
    const grass = surfaceMaterialSpec(SurfaceMaterial.Grass).referenceAlbedo;
    const dryGrass = surfaceMaterialSpec(SurfaceMaterial.DryGrass).referenceAlbedo;
    for (let channel = 0; channel < 3; channel += 1) {
      expect(GROUND_DRYNESS_LOG_RATIO[channel]).toBeCloseTo(
        Math.log(dryGrass[channel]! / grass[channel]!),
        10,
      );
    }
  });
});

describe("W-1b the vigour axis", () => {
  const softThreshold = (width: number, value: number): number => {
    const t = Math.min(1, Math.max(0, (value + width) / (2 * width)));
    return t * t * (3 - 2 * t) - 0.5;
  };

  it("centres every mask exactly, at any threshold width", () => {
    // The masks are symmetric about the field's own zero, so their mean is a
    // half whatever the width. That is what makes the stack mean-zero BY
    // CONSTRUCTION rather than by a correction that a footprint could break.
    for (const width of [0.12, 0.35, 0.85, 2]) {
      const { mean } = sampleField(120_000, 5, (x, y) =>
        softThreshold(width, groundNoise(x / 53, y / 53, 0x91f3)));
      expect(Math.abs(mean)).toBeLessThan(0.02);
    }
  });

  it("matches the crease term's measured mean", () => {
    const { mean } = sampleField(200_000, 9, (x, y) =>
      Math.max(0, 1 - Math.abs(groundNoise(x / 53, y / 53, 0x91f3) - GROUND_VIGOUR_CREASE_OFFSET)
        * GROUND_VIGOUR_CREASE_SHARPNESS));
    expect(mean).toBeGreaterThan(GROUND_VIGOUR_CREASE_MEAN - 0.02);
    expect(mean).toBeLessThan(GROUND_VIGOUR_CREASE_MEAN + 0.02);
  });

  it("keeps the stack's variance the mean-one correction was derived from", () => {
    const { mean, variance } = sampleField(200_000, 15, (x, y) => {
      const coarse = groundNoise(x / 163, y / 163, 0x4d1);
      const mid = groundNoise(x / 53, y / 53, 0x91f3);
      const fine = groundNoise(x / 18.4, y / 18.4, 0x6b27);
      const crease = Math.max(0, 1 - Math.abs(mid - GROUND_VIGOUR_CREASE_OFFSET)
        * GROUND_VIGOUR_CREASE_SHARPNESS);
      return softThreshold(0.35, coarse) * GROUND_VIGOUR_COARSE_AMPLITUDE
        + softThreshold(0.35, mid) * GROUND_VIGOUR_MID_AMPLITUDE
        + softThreshold(0.35, fine) * GROUND_VIGOUR_FINE_AMPLITUDE
        - (crease - GROUND_VIGOUR_CREASE_MEAN) * GROUND_VIGOUR_CREASE_AMPLITUDE;
    });
    expect(Math.abs(mean)).toBeLessThan(0.06);
    expect(variance).toBeGreaterThan(GROUND_VIGOUR_STACK_VARIANCE * 0.6);
    expect(variance).toBeLessThan(GROUND_VIGOUR_STACK_VARIANCE * 1.7);
  });

  it("swings luminance by about a fifth and carries hue with it", () => {
    // A brightness ramp alone is the macro wash this axis exists to beat, so
    // the channels must not move together: pale ground goes yellow-warm.
    const [r, g, b] = GROUND_VIGOUR_LOG_AXIS;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const sigma = Math.sqrt(GROUND_VIGOUR_STACK_VARIANCE);
    expect(Math.exp(luma * 2 * sigma)).toBeGreaterThan(1.12);
    expect(Math.exp(luma * 2 * sigma)).toBeLessThan(1.45);
    // Stressed grass goes YELLOW, not merely bright: red leads, green follows,
    // blue trails. A first draft moved blue with red and the ground marbled
    // green against tan — two materials interleaved, which reads as camo.
    expect(r).toBeGreaterThan(g * 1.4);
    expect(g).toBeGreaterThan(b);
  });

  it("is mean one per channel over the stack", () => {
    const bias = GROUND_VIGOUR_LOG_AXIS.map((channel) =>
      Math.exp(channel * channel * 0.5 * GROUND_VIGOUR_STACK_VARIANCE));
    for (let channel = 0; channel < 3; channel += 1) {
      const { mean } = sampleField(150_000, 21 + channel, (x, y) => {
        const coarse = groundNoise(x / 163, y / 163, 0x4d1);
        const mid = groundNoise(x / 53, y / 53, 0x91f3);
        const fine = groundNoise(x / 18.4, y / 18.4, 0x6b27);
        const crease = Math.max(0, 1 - Math.abs(mid - GROUND_VIGOUR_CREASE_OFFSET)
        * GROUND_VIGOUR_CREASE_SHARPNESS);
        const vigour = softThreshold(0.35, coarse) * GROUND_VIGOUR_COARSE_AMPLITUDE
          + softThreshold(0.35, mid) * GROUND_VIGOUR_MID_AMPLITUDE
          + softThreshold(0.35, fine) * GROUND_VIGOUR_FINE_AMPLITUDE
          - (crease - GROUND_VIGOUR_CREASE_MEAN) * GROUND_VIGOUR_CREASE_AMPLITUDE;
        return Math.exp(GROUND_VIGOUR_LOG_AXIS[channel]! * vigour) / bias[channel]!;
      });
      expect(mean).toBeGreaterThan(0.95);
      expect(mean).toBeLessThan(1.05);
    }
  });
});

describe("W-1 the expectations the far field converges to", () => {
  it("matches the bare-ground coverage it fades toward", () => {
    const smoothstep = (low: number, high: number, value: number): number => {
      const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
      return t * t * (3 - 2 * t);
    };
    const { mean } = sampleField(200_000, 13, (x, y) => {
      const field = groundNoise(x / 17.3, y / 17.3, 0x2ab7)
        + groundNoise(x / 6.1, y / 6.1, 0x7c05) * 0.5;
      return smoothstep(GROUND_BARE_THRESHOLD_LOW, GROUND_BARE_THRESHOLD_HIGH, field);
    });
    expect(mean).toBeGreaterThan(GROUND_BARE_EXPECTED_COVERAGE - 0.02);
    expect(mean).toBeLessThan(GROUND_BARE_EXPECTED_COVERAGE + 0.02);
  });

  it("matches the scrub crown coverage at every threshold it is used at", () => {
    for (const threshold of [1.15, 1.5, 1.9, 2.4, 2.75]) {
      const { mean } = sampleField(200_000, 17, (x, y) => {
        const clearance = Math.max(0, groundNoise(x / 5.3, y / 5.3, 0x51a7) - threshold);
        return clearance > 0 ? 1 : 0;
      });
      const predicted = groundScrubExpectation(GROUND_SCRUB_COVERAGE_FIT, threshold);
      // Within a fifth: the fit is a smooth model of a heavy-tailed count, and
      // what matters is that the far field does not drift, not the decimal.
      expect(mean).toBeGreaterThan(predicted * 0.8);
      expect(mean).toBeLessThan(predicted * 1.2);
    }
  });

  it("matches the squared crown profile's own expectation", () => {
    for (const threshold of [1.35, 1.75, 2.2]) {
      const { mean } = sampleField(200_000, 23, (x, y) => {
        const clearance = Math.max(0, groundNoise(x / 5.3, y / 5.3, 0x51a7) - threshold);
        return clearance * clearance;
      });
      const predicted = groundScrubExpectation(GROUND_SCRUB_HEIGHT_FIT, threshold);
      expect(mean).toBeGreaterThan(predicted * 0.8);
      expect(mean).toBeLessThan(predicted * 1.2);
    }
  });

  it("falls with the widening crown edge, never rises", () => {
    // The mean-preserving gain exists because this curve declines; a model
    // that rose with range would brighten the far field instead of holding it.
    let previous = Infinity;
    for (const width of [0.12, 0.3, 0.6, 1.2, 2.4]) {
      const mean = groundScrubCrownMean(1.6, width);
      expect(mean).toBeLessThan(previous);
      previous = mean;
    }
  });
});

describe("W-1 the tier switch", () => {
  it("is off at the tier that cannot afford it and on above", () => {
    // Measured 5.4-8.3% of frame rate on the four capture shots where close
    // vegetated ground fills the frame; Low does not have that headroom.
    // Tier 0 is low/balanced; the tiers above it are the other three rows of
    // the resolved-tier table, which is what the docs row publishes.
    expect(resolveWebGpuQualityProfile("low", "balanced").terrainGroundPatchwork).toBe(false);
    for (const [quality, mode] of [
      ["medium", "balanced"],
      ["high", "balanced"],
      ["high", "ultra"],
    ] as const) {
      expect(resolveWebGpuQualityProfile(quality, mode).terrainGroundPatchwork).toBe(true);
    }
  });

});

describe("W-1 the material axis and the WGSL it emits", () => {
  it("counts only ground a sward can grow on", () => {
    expect(groundCoverOf(SurfaceMaterial.Grass)).toEqual([1, 0]);
    expect(groundCoverOf(SurfaceMaterial.DryGrass)).toEqual([1, 1]);
    for (const id of [
      SurfaceMaterial.Rock,
      SurfaceMaterial.Snow,
      SurfaceMaterial.Sand,
      SurfaceMaterial.Asphalt,
      SurfaceMaterial.Concrete,
    ]) {
      expect(groundCoverOf(id)).toEqual([0, 0]);
    }
  });

  it("keeps every house trap shut", () => {
    const wgsl = TERRAIN_GROUND_PATCHWORK_WGSL;
    // No backtick may reach the fragment, comments included.
    expect(wgsl).not.toContain("`");
    // No sine hash: the integer hash is the whole point at world scale.
    expect(wgsl).not.toContain("fract(sin(");
    expect(wgsl).toContain("0x27d4eb2du");
    // Every smoothstep rises: a reversed pair degenerates into a hard step.
    for (const match of wgsl.matchAll(/smoothstep\(\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/g)) {
      expect(Number(match[2])).toBeGreaterThan(Number(match[1]));
    }
    // No frame index in a hash: there is no TAA to hide a crawl, and a
    // frame-indexed jitter is what made the cloud shadow's iso-lines walk.
    expect(wgsl).not.toMatch(/frameIndex|uniforms\.\w*[Ff]rame/);
    // The crown's antialias is analytic, not fwidth, which spikes at the rim.
    expect(wgsl).not.toContain("fwidth(");
    expect(wgsl).toContain(
      "length(vec2f(dot(worldGradient, worldDdx), dot(worldGradient, worldDdy)))",
    );
  });

  it("fades every octave on its own wavelength", () => {
    expect(TERRAIN_GROUND_PATCHWORK_WGSL).toContain("fn terrainGroundOctaveWeight");
    expect(TERRAIN_GROUND_PATCHWORK_WGSL).toContain(
      "wavelengthMeters * 0.125, wavelengthMeters * 0.34, footprintMeters",
    );
  });
});
