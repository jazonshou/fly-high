import { describe, expect, it } from "vitest";
import {
  GOVERNED_MIN_RENDER_PIXELS,
  GOVERNED_MIN_SNAP_PIXEL_RATIO,
  resolveGovernedHardwareScalingLevel,
  resolveHardwareScalingLevel,
  scalingLevelChanged,
  type GovernedScalingInputs,
  type HardwareScalingInputs,
} from "../src/render/renderScaleLevel";

/**
 * PR B part 2 (G4, design §1.9 and §3.5): the unpinned governor's resolution
 * step applies on the CAPPED frame, down to the tier's pixel floor and never
 * below 0.4 Mpx. Before, the step applied before the cap, so wherever the cap
 * bound (Medium on every display from 1080p up, High at 1440p) the cap
 * swallowed it and the lever was dead.
 *
 * The pinned path (captures, perf:ab, perf:flight) keeps
 * `resolveHardwareScalingLevel`, and at the ceiling the governed resolver is
 * that function's own expression, so a governor that has not stepped renders
 * the same pixels either way.
 */

type Display = Omit<HardwareScalingInputs, "renderScale">;

/** The governed level at render scale `scale` under ceiling `ceiling`. */
function governedLevel(display: Display, ceiling: number, scale: number, minRenderPixels = GOVERNED_MIN_RENDER_PIXELS): number {
  const inputs: GovernedScalingInputs = { ...display, renderScale: scale, ceilingScale: ceiling, minRenderPixels };
  return resolveGovernedHardwareScalingLevel(inputs);
}

/** Rendered megapixels at a level: CSS pixels / level². */
function megapixels(display: Display, level: number): number {
  return Math.max(1, display.cssWidth * display.cssHeight) / (level * level) / 1e6;
}

function display(cssWidth: number, cssHeight: number, devicePixelRatio: number, maxDevicePixelRatio: number, maxRenderPixels: number): Display {
  return { cssWidth, cssHeight, devicePixelRatio, maxDevicePixelRatio, maxRenderPixels };
}

describe("the governed hardware scaling level (G4)", () => {
  it("pins its two constants", () => {
    expect(GOVERNED_MIN_RENDER_PIXELS).toBe(400_000);
    expect(GOVERNED_MIN_SNAP_PIXEL_RATIO).toBe(1.04);
  });

  it("is resolveHardwareScalingLevel, bit for bit, at the ceiling", () => {
    let cases = 0;
    for (const devicePixelRatio of [0, 1, 1.25, 2, 3]) {
      for (const maxDevicePixelRatio of [1, 1.5, 2]) {
        for (const [cssWidth, cssHeight] of [
          [0, 0], [1, 1], [390, 844], [1280, 720], [1366, 768], [1512, 982], [1536, 864], [1920, 1080], [3840, 2160],
        ] as const) {
          for (const maxRenderPixels of [850_000, 1_000_000, 1_500_000, 2_400_000, 4_000_000]) {
            for (const renderScale of [0.05, 0.5, 0.72, 0.75, 0.8, 0.85, 0.86, 0.9, 1, 1.1]) {
              const inputs = { maxDevicePixelRatio, devicePixelRatio, renderScale, cssWidth, cssHeight, maxRenderPixels };
              expect(Object.is(
                resolveGovernedHardwareScalingLevel({
                  ...inputs,
                  ceilingScale: renderScale,
                  minRenderPixels: GOVERNED_MIN_RENDER_PIXELS,
                }),
                resolveHardwareScalingLevel(inputs),
              )).toBe(true);
              cases += 1;
            }
          }
        }
      }
    }
    expect(cases).toBe(5 * 3 * 9 * 5 * 10);
  });

  it("returns 1 / the capped scale at or above the ceiling", () => {
    // Medium at 1080p: the 1.5 Mpx cap binds below the 0.86 ceiling.
    const medium1080 = display(1920, 1080, 1, 1.5, 1_500_000);
    const capped = Math.min(0.86, Math.sqrt(1_500_000 / (1920 * 1080)));
    expect(Object.is(governedLevel(medium1080, 0.86, 0.86), 1 / capped)).toBe(true);
    expect(Object.is(governedLevel(medium1080, 0.86, 1.1), 1 / capped)).toBe(true);
    expect(megapixels(medium1080, governedLevel(medium1080, 0.86, 0.86))).toBeCloseTo(1.5, 9);
  });

  it("steps the capped frame, where the pre-cap step was swallowed by the cap", () => {
    // Medium on a 14" Retina panel: the cap binds well below the requested
    // 1.29, so a pre-cap step to 0.81 changes nothing; after the cap it is
    // (0.81 / 0.86)² of the 1.5 Mpx.
    const retina = display(1512, 982, 2, 1.5, 1_500_000);
    expect(resolveHardwareScalingLevel({ ...retina, renderScale: 0.81 }))
      .toBe(resolveHardwareScalingLevel({ ...retina, renderScale: 0.86 }));
    expect(megapixels(retina, governedLevel(retina, 0.86, 0.81))).toBeCloseTo(1.5 * (0.81 / 0.86) ** 2, 9);
  });

  // Design §3.4, at renderScale = ceiling × sqrt(ratio). [ceiling Mpx, [ratio, floor Mpx]...]
  const FLOORS: readonly (readonly [string, Display, number, number, readonly (readonly [number, number])[]])[] = [
    ["T0 (0.85 Mpx cap) 1920×1080", display(1920, 1080, 1, 1, 850_000), 0.72, 0.85, [[0.6, 0.51], [0.5, 0.425]]],
    ["T0 1366×768 (the minimum binds)", display(1366, 768, 1, 1, 850_000), 0.72, 0.544, [[0.6, 0.4], [0.5, 0.4]]],
    ["T0 1280×720", display(1280, 720, 1, 1, 850_000), 0.72, 0.478, [[0.6, 0.4], [0.5, 0.4]]],
    // 0.413 unsnapped at 0.6: within 4% of the minimum, so on it.
    ["T0 1536×864 (1080p at 125%)", display(1536, 864, 1.25, 1, 850_000), 0.72, 0.688, [[0.6, 0.4], [0.5, 0.4]]],
    ["T0 1512×982@2 (DPR ceiling 1)", display(1512, 982, 2, 1, 850_000), 0.72, 0.77, [[0.6, 0.462], [0.5, 0.4]]],
    ["T0 1366×768 at render scale 0.66", display(1366, 768, 1, 1, 850_000), 0.66, 0.457, [[0.6, 0.4], [0.5, 0.4]]],
    ["T1 (1.5 Mpx cap) 1920×1080", display(1920, 1080, 1, 1.5, 1_500_000), 0.86, 1.5, [[0.6, 0.9], [0.5, 0.75]]],
    ["T1 1512×982@2", display(1512, 982, 2, 1.5, 1_500_000), 0.86, 1.5, [[0.6, 0.9], [0.5, 0.75]]],
    ["T1 2560×1440", display(2560, 1440, 1, 1.5, 1_500_000), 0.86, 1.5, [[0.6, 0.9], [0.5, 0.75]]],
    ["T1 3840×2160", display(3840, 2160, 1, 1.5, 1_500_000), 0.86, 1.5, [[0.6, 0.9], [0.5, 0.75]]],
    ["T1 1366×768", display(1366, 768, 1, 1.5, 1_500_000), 0.86, 0.776, [[0.6, 0.466], [0.5, 0.4]]],
    ["T1 at a 1.2 Mpx cap, 1920×1080", display(1920, 1080, 1, 1.5, 1_200_000), 0.86, 1.2, [[0.6, 0.72], [0.5, 0.6]]],
    ["T2 2560×1440@1", display(2560, 1440, 1, 2, 2_400_000), 1, 2.4, [[0.5625, 1.35]]],
    ["T3 3840×2160", display(3840, 2160, 1, 2, 4_000_000), 1, 4, [[0.5625, 2.25]]],
  ];

  it.each(FLOORS)("floors %s as the design's table says", (_label, view, ceiling, ceilingMpx, floors) => {
    expect(megapixels(view, governedLevel(view, ceiling, ceiling))).toBeCloseTo(ceilingMpx, 3);
    for (const [ratio, floorMpx] of floors) {
      expect(megapixels(view, governedLevel(view, ceiling, ceiling * Math.sqrt(ratio))), `ratio ${ratio}`)
        .toBeCloseTo(floorMpx, 3);
    }
  });

  it("snaps a frame within 4% of the minimum onto it", () => {
    // Low at 1366×768: 0.544 Mpx capped. The step to 0.62 would leave 0.403
    // Mpx, a 0.8% resize below it for nothing a step test can see; it lands
    // on the minimum's own level instead, the same level as any deeper step.
    const low = display(1366, 768, 1, 1, 850_000);
    const atMinimum = governedLevel(low, 0.72, 0.72 * Math.sqrt(0.6));
    expect(megapixels(low, atMinimum)).toBeCloseTo(0.4, 9);
    expect(Object.is(governedLevel(low, 0.72, 0.62), atMinimum)).toBe(true);
    expect(megapixels(low, governedLevel(low, 0.72, 0.67))).toBeCloseTo(0.471, 3);
    expect(governedLevel(low, 0.72, 0.67)).not.toBe(atMinimum);
    // INSTRUMENT: without a minimum the same step is the 0.403 Mpx frame.
    expect(megapixels(low, governedLevel(low, 0.72, 0.62, 0))).toBeCloseTo(0.403, 3);
  });

  it("moves the pixels by 3.85% or more on a real step onto the minimum, not 8%", () => {
    // The snap is measured from the minimum, not from the step: a frame just
    // over 4% above it still steps onto it. Medium at 1217×684 is 0.616 Mpx
    // capped; 0.71 leaves 0.420 Mpx and the floor, 0.6662, would leave
    // 0.370, so the last step is a real resize onto the minimum of 4.7%.
    const medium = display(1217, 684, 1, 1.5, 1_500_000);
    const at071 = governedLevel(medium, 0.86, 0.71);
    const atFloor = governedLevel(medium, 0.86, 0.86 * Math.sqrt(0.6));
    expect(megapixels(medium, at071)).toBeCloseTo(0.4196, 4);
    expect(megapixels(medium, atFloor)).toBeCloseTo(0.4, 9);
    expect(scalingLevelChanged(atFloor, at071)).toBe(true);
    expect(1 - megapixels(medium, atFloor) / megapixels(medium, at071)).toBeCloseTo(0.0468, 4);
    // Swept over windows and steps of 0.025 and 0.05: a step that lands on
    // the minimum at another level starts at least 1.04 × the minimum.
    let smallest = 1;
    let onto = 0;
    for (let cssWidth = 800; cssWidth <= 1600; cssWidth += 16) {
      for (let cssHeight = 450; cssHeight <= 1100; cssHeight += 13) {
        const view = display(cssWidth, cssHeight, 1, 1.5, 1_500_000);
        for (let from = 0.86; from > 0.4; from -= 0.025) {
          for (const step of [0.025, 0.05]) {
            const before = governedLevel(view, 0.86, from);
            const after = governedLevel(view, 0.86, from - step);
            if (!scalingLevelChanged(after, before)) continue;
            if (Math.abs(megapixels(view, after) - 0.4) > 1e-9) continue;
            onto += 1;
            smallest = Math.min(smallest, 1 - megapixels(view, after) / megapixels(view, before));
          }
        }
      }
    }
    expect(onto).toBeGreaterThan(100);
    expect(smallest).toBeGreaterThanOrEqual(1 - 1 / GOVERNED_MIN_SNAP_PIXEL_RATIO - 1e-9);
    expect(smallest).toBeLessThan(0.04);
  });

  it("never shrinks a capped frame under the minimum, or within 4% of it", () => {
    // A phone-sized viewport at Low: 0.171 Mpx capped.
    const phone = display(390, 844, 3, 1, 850_000);
    const phoneCeiling = governedLevel(phone, 0.72, 0.72);
    expect(megapixels(phone, phoneCeiling)).toBeLessThan(0.4);
    // Low at 1280×720 with render scale 0.66: 0.401 Mpx, inside the snap.
    const small = display(1280, 720, 1, 1, 850_000);
    const smallCeiling = governedLevel(small, 0.66, 0.66);
    expect(megapixels(small, smallCeiling)).toBeCloseTo(0.401, 3);
    for (const factor of [0.95, 0.9, 0.8, 0.7746, 0.5, 0.1]) {
      expect(Object.is(governedLevel(phone, 0.72, 0.72 * factor), phoneCeiling), `phone ×${factor}`).toBe(true);
      expect(Object.is(governedLevel(small, 0.66, 0.66 * factor), smallCeiling), `1280×720 ×${factor}`).toBe(true);
    }
  });
});
