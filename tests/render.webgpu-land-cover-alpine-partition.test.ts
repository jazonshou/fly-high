import { describe, expect, it } from "vitest";
import {
  LAND_COVER_CANOPY_CLOSURE_GAIN,
  LAND_COVER_CLASSIFIER_WGSL,
  LAND_COVER_FOREST_FLOOR_LITTER_GAIN,
  LAND_COVER_GRASS_COVER_GAIN,
  classifyLandCover,
  dominantLandCover,
  landCoverLitter,
  landCoverSuitabilities,
  landCoverWetness,
  type LandCoverInput,
} from "../src/render/webgpu/terrain/LandCoverClassifier";
import {
  SURFACE_MATERIAL_COUNT,
  SURFACE_MATERIALS,
  SurfaceMaterial,
} from "../src/render/webgpu/terrain/surfaceMaterials";
import { saturate, smoothstep } from "../src/world/noise";
import { readSource } from "./support/sourceText";

/**
 * ITEM C — THE ALPINE COVER PARTITION.
 *
 * The defect: above ~900 m no vegetated material had any suitability on gentle
 * ground, so tall mountains rendered grey from base to summit. `Grass` and
 * `DryGrass` carry `lowland` (dead by 900 m) and `warm`; `Shrub` dies over
 * 1,150-1,650 m; and `Rock` claimed 0.55 on perfectly FLAT alpine ground. The
 * repair is three gated products — alpine turf, a slope-dependent altitude
 * share for Rock, and a repose-angle scree band for Gravel.
 *
 * **THE INVARIANT THIS FILE EXISTS TO PROVE: every new term is multiplied by
 * `alpine` (= `smoothstep(420, 980, elevation)`), which is EXACTLY 0 at and
 * below 420 m, so every suitability there is BIT-IDENTICAL to the shipped law.**
 * A lowland pixel, the airfield, the shore band and the unclaimed-ground
 * regime (cold + gentle + LOW) cannot move.
 *
 * It is proved two independent ways, because either alone has a hole:
 *
 * 1. against a FROZEN COPY of the shipped arithmetic (`bb078a7`), swept over
 *    ~670k input combinations. A frozen copy can be transcribed wrongly, and a
 *    wrong transcription that happens to share the live law's mistake passes;
 * 2. so the copy is itself pinned to LITERAL values captured by running the
 *    base tree's own `landCoverSuitabilities` (not this copy) on a probe table.
 *    The literals cannot be wrong in the same way the copy could be.
 *
 * And a positive control shows the two laws DO differ above 420 m, so the
 * equality below is not a function compared with itself.
 */

const REFERENCE_DAY = 171;

const at = (overrides: Partial<LandCoverInput>): LandCoverInput => ({
  elevationMeters: 120,
  slope: 0.05,
  moisture: 0.5,
  temperature: 0.6,
  aspect: 0,
  airportInfluence: 0,
  dayOfYear: REFERENCE_DAY,
  seasonalTemperatureShift: 0,
  ...overrides,
});

/**
 * The shipped law at `bb078a7`, frozen. DO NOT "tidy" this toward the live
 * file: its whole value is that it does not follow it.
 *
 * `landCoverWetness` and `landCoverLitter` are imported rather than frozen —
 * item C does not touch either, and the literal table below would catch a
 * change to them just the same.
 */
function shippedSuitabilities(input: LandCoverInput): number[] {
  const elevation = input.elevationMeters;
  const slope = input.slope;
  const wetness = landCoverWetness(input);
  const snowline = 1_520 + input.seasonalTemperatureShift * 2_450 + input.aspect * 90;
  const shore = smoothstep(-1, 3, elevation);
  const dry = 1 - smoothstep(0.28, 0.62, wetness);
  const wet = smoothstep(0.3, 0.64, wetness);
  const warm = smoothstep(0.16, 0.34, input.temperature);
  const steep = smoothstep(0.24, 0.58, slope);
  const gentle = 1 - steep;
  const alpine = smoothstep(420, 980, elevation);
  const lowland = 1 - smoothstep(320, 900, elevation);
  const airfield = saturate(input.airportInfluence);
  const closure = saturate(input.canopyClosure ?? 0);
  const closureGate = input.canopyClosure === undefined
    ? 1
    : closure * (1 + LAND_COVER_CANOPY_CLOSURE_GAIN);
  const sward = saturate(input.grassCover ?? 0);

  const suitability = new Array<number>(SURFACE_MATERIAL_COUNT).fill(0);
  suitability[SurfaceMaterial.Sand] = (1 - shore) * gentle * 1.35;
  suitability[SurfaceMaterial.Grass] = Math.max(
    shore * lowland * gentle * warm * (0.35 + wet * 0.65)
      * (1 + sward * LAND_COVER_GRASS_COVER_GAIN)
    + airfield * 2.4,
    0.02,
  );
  suitability[SurfaceMaterial.ForestFloor] =
    shore * wet * warm * (1 - smoothstep(900, 1_350, elevation)) * (1 - steep * 0.8) * 1.1
    * (1 + landCoverLitter(input) * LAND_COVER_FOREST_FLOOR_LITTER_GAIN)
    * closureGate;
  suitability[SurfaceMaterial.Shrub] =
    shore * alpine * (1 - smoothstep(1_150, 1_650, elevation)) * (0.4 + dry * 0.6) * 0.95;
  suitability[SurfaceMaterial.Rock] = shore * (steep * 1.25 + alpine * 0.55);
  suitability[SurfaceMaterial.Snow] =
    smoothstep(snowline - 90, snowline + 130, elevation)
    // NOT the shipped shedding, deliberately: M-3 moved snow shedding from 60-72
    // degrees to 39-55, and that is the one M-3 term that is NOT gated on
    // `alpine` (a winter snowline reaches the lowlands, and a lowland cliff
    // sheds snow like any other). The frozen law carries the new term so that
    // this sweep keeps testing what it exists to test: that nothing ELSE moves.
    * (1 - smoothstep(0.22, 0.42, slope))
    * 1.5;
  suitability[SurfaceMaterial.DryGrass] =
    shore * lowland * gentle * dry * warm * 0.8 * (1 + sward * LAND_COVER_GRASS_COVER_GAIN);
  suitability[SurfaceMaterial.Gravel] =
    shore * (steep * 0.35 + (1 - shore) * 0.4 + alpine * 0.2);
  return suitability;
}

/**
 * Captured by running the BASE tree's own classifier (`bb078a7`, NOT the frozen
 * copy above) on these inputs. Every probe is at or below the 420 m onset.
 * JSON round-trips a double exactly, so these are the shipped bits.
 */
const BASE_TREE_CAPTURE: ReadonlyArray<readonly [Partial<LandCoverInput>, readonly number[]]> = [
  [{ elevationMeters: 420, slope: 0.05, moisture: 0.5, temperature: 0.48 },
    [0, 0.7001395498200738, 0.6940769387339712, 0, 0, 0, 0.21057336020615783, 0, 0, 0]],
  [{ elevationMeters: 420, slope: 0.2, moisture: 0.2, temperature: 0.1 },
    [0, 0.02, 0, 0, 0, 0, 0, 0, 0, 0]],
  [{ aspect: -0.6, elevationMeters: 419.999, slope: 0.31, moisture: 0.71, temperature: 0.3 },
    [0, 0.7165354989891923, 0.8768196970217308, 0, 0.13713616934663142, 0, 0,
      0.038398127417056796, 0, 0]],
  [{
    dayOfYear: 15, seasonalTemperatureShift: -0.35, elevationMeters: 350, slope: 0.14,
    moisture: 0.33, temperature: 0.22,
  }, [0, 0.09371330513411585, 0.006269082027274586, 0, 0, 0, 0.19375706904220275, 0, 0, 0]],
  [{
    elevationMeters: 120, slope: 0.62, moisture: 0.9, temperature: 0.6, canopyClosure: 0.7,
    grassCover: 0.2,
  }, [0, 0.02, 0.23869999999999997, 0, 1.25, 0, 0, 0.35, 0, 0]],
  [{ elevationMeters: 1.5, slope: 0.02, moisture: 0.4, temperature: 0.66 },
    [0.42714843750000003, 0.33195969239772033, 0.15688010444229603, 0, 0, 0,
      0.39059319662120906, 0.086517333984375, 0, 0]],
  [{
    elevationMeters: 60, slope: 0.05, moisture: 0.8, temperature: 0.5, soilDepthMeters: 3,
    flowAccumulationAreaM2: 4_000_000,
  }, [0, 0.35, 0, 0, 0, 0, 0.8, 0, 0, 0]],
  [{ airportInfluence: 0.8, elevationMeters: 40, slope: 0.01, moisture: 0.9, temperature: 0.64 },
    [0, 2.92, 1.1, 0, 0, 0, 0, 0, 0, 0]],
  [{ elevationMeters: 200, slope: 0.1, moisture: 0.5, temperature: 0.1 },
    [0, 0.02, 0, 0, 0, 0, 0, 0, 0, 0]],
  [{
    aspect: 1, seasonalTemperatureShift: -0.43, elevationMeters: 400, slope: 0.18,
    moisture: 0.15, temperature: 0.05,
  }, [0, 0.02, 0, 0, 0, 0, 0, 0, 0, 0]],
  [{
    aspect: -1, dayOfYear: 15, seasonalTemperatureShift: -0.5, elevationMeters: 400,
    slope: 0.07, moisture: 0.45, temperature: 0.12,
  }, [0, 0.02, 0, 0, 0, 1.5, 0, 0, 0, 0]],
  [{
    elevationMeters: 300, slope: 0.27, moisture: 0.6, temperature: 0.4, canopyClosure: 0,
    grassCover: 0.9,
  }, [0, 1.3399365350338304, 0, 0, 0.02747811927539187, 0, 0.010963829041772923,
    0.007693873397109723, 0, 0]],
];

/** Normalised temperature the climate chain gives a point at this altitude. */
const temperatureAt = (elevationMeters: number): number =>
  saturate(0.66 - elevationMeters / 2_450);

const dominantOf = (input: LandCoverInput) => dominantLandCover(classifyLandCover(input));
const nameOf = (id: number): string => SURFACE_MATERIALS[id]?.name ?? `#${id}`;

describe("item C: the lowland law is bit-identical at and below 420 m", () => {
  it("matches the base tree's own captured values, to the bit", () => {
    for (const [overrides, shipped] of BASE_TREE_CAPTURE) {
      const input = at(overrides);
      expect(input.elevationMeters).toBeLessThanOrEqual(420);
      const live = landCoverSuitabilities(input);
      const frozen = shippedSuitabilities(input);
      for (let id = 0; id < SURFACE_MATERIAL_COUNT; id += 1) {
        // `toBe` is `Object.is`: bit equality, and it tells +0 from -0.
        expect(live[id], `live ${nameOf(id)} at ${JSON.stringify(overrides)}`).toBe(shipped[id]);
        // The frozen copy is pinned to the same literals, so the sweep below is
        // a sweep against the SHIPPED law and not against a transcription of it.
        expect(frozen[id], `frozen ${nameOf(id)} at ${JSON.stringify(overrides)}`)
          .toBe(shipped[id]);
      }
    }
  });

  it("matches the frozen shipped law over the whole input space at or below 420 m", () => {
    const elevations = [-5, 0, 1.5, 3, 40, 120, 320, 380, 419.999, 420];
    const variants: Partial<LandCoverInput>[] = [
      {},
      { canopyClosure: 0.35, grassCover: 0.8 },
      { airportInfluence: 0.6 },
      { canopyClosure: 0, grassCover: 1, soilDepthMeters: 4, flowAccumulationAreaM2: 3_000_000 },
    ];
    let compared = 0;
    let mismatches = 0;
    let first = "";
    for (const elevationMeters of elevations) {
      for (let slope = 0; slope <= 0.9001; slope += 0.03) {
        for (let moisture = 0; moisture <= 1.0001; moisture += 0.125) {
          for (let temperature = 0; temperature <= 0.7001; temperature += 0.05) {
            for (const seasonalTemperatureShift of [0, -0.5]) {
              for (const aspect of [-1, 0.4]) {
                for (const variant of variants) {
                  const input = at({
                    elevationMeters, slope, moisture, temperature, seasonalTemperatureShift,
                    aspect, ...variant,
                  });
                  const live = landCoverSuitabilities(input);
                  const frozen = shippedSuitabilities(input);
                  for (let id = 0; id < SURFACE_MATERIAL_COUNT; id += 1) {
                    compared += 1;
                    if (!Object.is(live[id], frozen[id])) {
                      mismatches += 1;
                      if (!first) {
                        first = `${nameOf(id)} live ${live[id]} vs shipped ${frozen[id]} at `
                          + JSON.stringify(input);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    // Non-vacuity: an empty sweep is the best-looking false pass there is.
    expect(compared).toBeGreaterThan(5_000_000);
    expect(
      mismatches,
      `${mismatches} of ${compared} suitabilities at or below 420 m differ from the shipped `
        + `law — an item-C term has escaped its alpine gate. First: ${first}`,
    ).toBe(0);
  });

  it("POSITIVE CONTROL: the same comparison DOES fire above the onset", () => {
    // Every assertion above is a negative result. This shows the instrument can
    // say yes: one metre of `alpine` is enough for the laws to part.
    let differing = 0;
    for (const elevationMeters of [421, 500, 700, 1_100, 1_400]) {
      const input = at({
        elevationMeters, slope: 0.18, moisture: 0.4, temperature: temperatureAt(elevationMeters),
      });
      const live = landCoverSuitabilities(input);
      const frozen = shippedSuitabilities(input);
      if (live.some((value, id) => !Object.is(value, frozen[id]))) differing += 1;
    }
    expect(differing).toBe(5);
    // And exactly the four materials item C edits move; the other six do not.
    const input = at({ elevationMeters: 1_100, slope: 0.18, moisture: 0.4, temperature: 0.21 });
    const live = landCoverSuitabilities(input);
    const frozen = shippedSuitabilities(input);
    const moved = live
      .map((value, id) => (Object.is(value, frozen[id]) ? -1 : id))
      .filter((id) => id >= 0);
    expect(moved).toEqual([
      SurfaceMaterial.Grass, SurfaceMaterial.Rock, SurfaceMaterial.DryGrass,
      SurfaceMaterial.Gravel,
    ]);
  });
});

describe("item C: the partition it draws on a mountain", () => {
  const ALTITUDE = 1_100;
  const high = (overrides: Partial<LandCoverInput>): LandCoverInput => at({
    elevationMeters: ALTITUDE, temperature: temperatureAt(ALTITUDE), ...overrides,
  });

  it("puts turf on gentle alpine ground that the shipped law painted as rock", () => {
    for (const slope of [0, 0.03, 0.06, 0.1]) {
      const input = high({ slope, moisture: 0.62 });
      expect(nameOf(dominantOf(input)), `slope ${slope}`).toBe("Grass");
    }
    // The shipped law, at the same points: no sward had ANY suitability there.
    const shipped = shippedSuitabilities(high({ slope: 0.03, moisture: 0.62 }));
    expect(shipped[SurfaceMaterial.Grass]).toBe(0.02); // the unclaimed floor, nothing more
    expect(shipped[SurfaceMaterial.DryGrass]).toBe(0);
  });

  it("no longer lets altitude alone claim level ground for Rock", () => {
    const flat = landCoverSuitabilities(high({ slope: 0 }));
    expect(flat[SurfaceMaterial.Rock]).toBeCloseTo(0.25, 12);
    expect(shippedSuitabilities(high({ slope: 0 }))[SurfaceMaterial.Rock]).toBeCloseTo(0.55, 12);
    // …and hands back exactly the shipped share once there is slope to justify
    // it, so a face is as much rock as it ever was.
    for (const slope of [0.3, 0.45, 0.6, 0.8]) {
      expect(landCoverSuitabilities(high({ slope }))[SurfaceMaterial.Rock])
        .toBeCloseTo(shippedSuitabilities(high({ slope }))[SurfaceMaterial.Rock]!, 12);
    }
  });

  it("keeps steep faces rock at any moisture", () => {
    for (const moisture of [0.1, 0.5, 0.9]) {
      for (const slope of [0.45, 0.6, 0.8]) {
        expect(nameOf(dominantOf(high({ slope, moisture }))), `slope ${slope} moisture ${moisture}`)
          .toBe("Rock");
      }
    }
  });

  it("lays scree at the angle of repose on dry ground, and turf on wet", () => {
    // slope 0.13 is ~30 deg and 0.21 is ~38 deg: the band loose debris rests in.
    // (The first cut's band, 0.11-0.17 rising and 0.24-0.32 falling, measured
    // its peak on 35-45 degree ground; it moved down to 0.085-0.145 / 0.20-0.27.)
    for (const slope of [0.145, 0.17, 0.2]) {
      expect(nameOf(dominantOf(high({ slope, moisture: 0.15 }))), `dry, slope ${slope}`)
        .toBe("Gravel");
      expect(nameOf(dominantOf(high({ slope, moisture: 0.8 }))), `wet, slope ${slope}`)
        .toBe("Grass");
    }
    // The shipped law never let Gravel win on a mountain at all.
    expect(nameOf(dominantLandCoverOfShipped(high({ slope: 0.2, moisture: 0.15 }))))
      .not.toBe("Gravel");
    // And the band is a BUMP: it is gone on level ground and on a face.
    const gravelAt = (slope: number): number =>
      landCoverSuitabilities(high({ slope, moisture: 0.15 }))[SurfaceMaterial.Gravel]!
      - shippedSuitabilities(high({ slope, moisture: 0.15 }))[SurfaceMaterial.Gravel]!;
    expect(gravelAt(0.05)).toBe(0);
    expect(gravelAt(0.085)).toBe(0);
    expect(gravelAt(0.17)).toBeCloseTo(0.85, 12);
    expect(gravelAt(0.27)).toBe(0);
    expect(gravelAt(0.6)).toBe(0);
  });

  it("hands gentle ground to Snow below the snowline, not at it", () => {
    // The turf is gone by snowline - 40 m, in summer and in winter alike,
    // because it reads the SAME seasonal, aspect-shifted snowline Snow does.
    for (const [shift, aspect] of [[0, 0], [-0.2, 0], [0, 1], [-0.1, -1]] as const) {
      const snowline = 1_520 + shift * 2_450 + aspect * 90;
      const input = at({
        elevationMeters: snowline - 40, slope: 0.03, moisture: 0.6, temperature: 0.3,
        seasonalTemperatureShift: shift, aspect,
      });
      const live = landCoverSuitabilities(input);
      const frozen = shippedSuitabilities(input);
      expect(live[SurfaceMaterial.Grass]).toBe(frozen[SurfaceMaterial.Grass]);
      expect(live[SurfaceMaterial.DryGrass]).toBe(frozen[SurfaceMaterial.DryGrass]);
    }
    expect(nameOf(dominantOf(at({
      elevationMeters: 1_800, slope: 0.03, temperature: temperatureAt(1_800),
    })))).toBe("Snow");
  });

  it("stays an ecotone: no step in any driver at altitude", () => {
    // The Lipschitz walk of `render.webgpu-land-cover.test.ts` runs at 120 m,
    // where `alpine` is 0 and none of item C's terms are live. This is the same
    // walk where they are. The slope bound is higher than the lowland file's 12
    // and that is a stated consequence, not slack: the scree band's rising edge
    // is 0.06 of slope wide (27-34 deg), so its peak gradient is
    // 0.85 * 1.5 / 0.06 = 21.25 per unit slope. A threshold would be unbounded.
    for (const [driver, from, to, steps, lipschitz] of [
      ["elevationMeters", 400, 2_000, 3_200, 0.02],
      ["slope", 0, 0.9, 1_800, 24],
      ["moisture", 0, 1, 2_000, 12],
      ["temperature", 0, 1, 2_000, 15],
    ] as const) {
      const stepSize = (to - from) / steps;
      for (const moisture of [0.15, 0.8]) {
        let previous: number[] | null = null;
        for (let step = 0; step <= steps; step += 1) {
          const value = from + ((to - from) * step) / steps;
          const suitability = landCoverSuitabilities(
            high({ slope: 0.2, moisture, [driver]: value }),
          );
          if (previous) {
            for (let id = 0; id < SURFACE_MATERIAL_COUNT; id += 1) {
              expect(
                Math.abs(suitability[id]! - previous[id]!),
                `${driver} at ${value.toFixed(3)} jumps ${nameOf(id)}`,
              ).toBeLessThanOrEqual(lipschitz * stepSize);
            }
          }
          previous = suitability;
        }
      }
    }
  });
});

function dominantLandCoverOfShipped(input: LandCoverInput): number {
  const suitability = shippedSuitabilities(input);
  let best = 0;
  for (let id = 1; id < suitability.length; id += 1) {
    if (suitability[id]! > suitability[best]!) best = id;
  }
  return best;
}

describe("item C: the traps this file's history records stay shut", () => {
  const source = readSource(
    new URL("../src/render/webgpu/terrain/LandCoverClassifier.ts", import.meta.url),
  );

  it("gates every new term on alpine, in BOTH laws", () => {
    // The CPU law and its WGSL twin live in one file; a term mirrored into one
    // of them is the `0608fed` defect (the floor that shipped into one of two
    // classifiers). Each structural fragment must therefore appear twice.
    const twice = (pattern: RegExp, what: string) => {
      expect(source.match(pattern)?.length ?? 0, `${what} must appear in the TS law AND the twin`)
        .toBe(2);
    };
    twice(/alpineTurf = shore \* alpine \* turfSlope \* cool \* \(1(?:\.0)? - snowBand\)/gu,
      "the alpine-turf product");
    twice(/alpine \* \(0\.25 \+ 0\.30 \* k?[sS]moothstep\(0\.10, 0\.30, slope\)\)/gu,
      "Rock's slope-dependent altitude share");
    twice(/alpine \* screeBand \* \(0\.5 \+ dry \* 0\.5\) \* 0\.85/gu, "the scree claim");
    twice(/\+ alpineTurf \* \(0\.35 \+ wet \* 0\.65\) \* 0\.9/gu, "Grass's turf share");
    twice(/\+ alpineTurf \* dry \* 0\.95/gu, "DryGrass's turf share");
    // Rock's calibrated pair is untouched, in both laws.
    twice(/steep = k?[sS]moothstep\(0\.24, 0\.58, slope\)/gu, "steep's calibrated window");
    twice(/steep \* 1\.25/gu, "Rock's calibrated coefficient");
    twice(/gentle = 1(?:\.0)? - steep/gu, "the gentle + steep === 1 partition");
    // The flat altitude-only claim is gone from both.
    expect(source).not.toMatch(/alpine \* 0\.55/u);
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain("let alpineTurf = shore * alpine * turfSlope");
  });

  it("writes every falling edge as 1 - smoothstep(lo, hi, x)", () => {
    // A reversed-argument smoothstep degenerates into a hard step here.
    const reversed: string[] = [];
    let literalPairs = 0;
    for (const match of source.matchAll(
      /[sS]moothstep\(\s*(-?[\d._]+)\s*,\s*(-?[\d._]+)\s*,/gu,
    )) {
      literalPairs += 1;
      const low = Number(match[1]!.replaceAll("_", ""));
      const high = Number(match[2]!.replaceAll("_", ""));
      if (!(high > low)) reversed.push(match[0]);
    }
    // The snowline-relative windows are not literal pairs; read their offsets.
    let snowlinePairs = 0;
    for (const match of source.matchAll(
      /[sS]moothstep\(\s*snowline ([+-]) ([\d.]+)\s*,\s*snowline ([+-]) ([\d.]+)\s*,/gu,
    )) {
      snowlinePairs += 1;
      const low = Number(`${match[1]}${match[2]}`);
      const high = Number(`${match[3]}${match[4]}`);
      if (!(high > low)) reversed.push(match[0]);
    }
    expect(reversed, `reversed smoothstep call sites: ${reversed.join(" | ")}`).toEqual([]);
    // The scan is only worth having if it can see the law. Measured: 28 literal
    // windows (13 per law, 2 in the splat bake) and 4 snowline-relative ones
    // (Snow's and snowBand's, per law). The literal bound is deliberately loose
    // so that retiring a window elsewhere does not trip an item-C test.
    expect(literalPairs).toBeGreaterThanOrEqual(20);
    expect(snowlinePairs).toBe(4);
  });

  it("adds no constant: every new claim is zero where its gate is", () => {
    // `Sand + 0.02` and then `Grass + 0.02` each acted as a universal gain. The
    // item-C terms are products, so with `alpine` live but their OWN gates shut
    // they contribute exactly nothing.
    const onFace = at({ elevationMeters: 1_100, slope: 0.7, moisture: 0.5, temperature: 0.21 });
    const live = landCoverSuitabilities(onFace);
    const frozen = shippedSuitabilities(onFace);
    // turfSlope = 0 on a face: no turf. screeBand = 0 past 0.27: no scree.
    expect(live[SurfaceMaterial.Grass]).toBe(frozen[SurfaceMaterial.Grass]);
    expect(live[SurfaceMaterial.DryGrass]).toBe(frozen[SurfaceMaterial.DryGrass]);
    expect(live[SurfaceMaterial.Gravel]).toBe(frozen[SurfaceMaterial.Gravel]);
    // Too cold for turf (below the `cool` window): none, on any slope.
    const frozenSummit = at({ elevationMeters: 1_100, slope: 0.03, temperature: 0 });
    expect(landCoverSuitabilities(frozenSummit)[SurfaceMaterial.DryGrass]).toBe(0);
    expect(landCoverSuitabilities(frozenSummit)[SurfaceMaterial.Grass]).toBe(0.02);
  });
});
