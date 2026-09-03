import { describe, expect, it } from "vitest";
import {
  DETAIL_INSTANCE_HEIGHT_MAX_METERS,
  DETAIL_INSTANCE_RADIAL_MAX,
  DETAIL_INSTANCE_RADIAL_MIN,
  DetailInstanceWriter,
  detailPrototypeWorldRadius,
  detailRadialScaleForWorldRadius,
  yawQuaternion,
} from "../src/render/webgpu/detail/instanceFormat";
import {
  SHRUB_VARIANT_COUNTS,
  TREE_VARIANT_COUNTS,
  buildRockPrototype,
  buildShrubPrototype,
  buildTreePrototype,
  type TreePrototypeBand,
} from "../src/render/webgpu/detail/prototypeGeometry";
import type {
  RockVariant,
  ShrubSpecies,
  TreeSpecies,
} from "../src/render/webgpu/detail/types";

const TREE_SPECIES = Object.keys(TREE_VARIANT_COUNTS) as TreeSpecies[];
const SHRUB_SPECIES = Object.keys(SHRUB_VARIANT_COUNTS) as ShrubSpecies[];
const TREE_BANDS: readonly TreePrototypeBand[] = ["near", "mid", "far"];
const ROCK_VARIANTS: readonly RockVariant[] = ["granite", "limestone", "dark"];

function packedRadialScale(radialScale: number, heightScaleMeters: number): number {
  const writer = new DetailInstanceWriter(1);
  writer.push({
    x: 0,
    y: 0,
    z: 0,
    quaternion: yawQuaternion(0),
    heightScaleMeters,
    radialScale,
    fade: 1,
    variant: 0,
    tint: [1, 1, 1, 1],
    windPhase: 0,
    windResponse: 0,
  });
  const bytes = writer.finish();
  const encoded = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint16(22, true);
  return DETAIL_INSTANCE_RADIAL_MIN
    + encoded / 65_535 * (DETAIL_INSTANCE_RADIAL_MAX - DETAIL_INSTANCE_RADIAL_MIN);
}

function expectWorldRadiusRoundTrip(
  label: string,
  prototypeRadiusUnit: number,
  heightMeters: number,
  targetRadiusMeters: number,
): void {
  const radialScale = detailRadialScaleForWorldRadius(
    targetRadiusMeters,
    heightMeters,
    prototypeRadiusUnit,
  );
  expect(radialScale, `${label}: lower range`).toBeGreaterThan(DETAIL_INSTANCE_RADIAL_MIN);
  expect(radialScale, `${label}: upper range`).toBeLessThan(DETAIL_INSTANCE_RADIAL_MAX);
  const decoded = packedRadialScale(radialScale, heightMeters);
  const reconstructed = detailPrototypeWorldRadius(
    prototypeRadiusUnit,
    heightMeters,
    decoded,
  );
  expect(
    Math.abs(reconstructed - targetRadiusMeters),
    `${label}: ${reconstructed} m reconstructed for ${targetRadiusMeters} m target`,
  ).toBeLessThan(Math.max(0.0015, targetRadiusMeters * 0.0002));
}

describe("detail prototype radial scale contract", () => {
  it("round-trips every tree species, geometry variant and LOD band", () => {
    for (const species of TREE_SPECIES) {
      for (let variant = 0; variant < TREE_VARIANT_COUNTS[species]; variant += 1) {
        for (const band of TREE_BANDS) {
          const prototype = buildTreePrototype(species, variant, 7, band);
          if (prototype.crown.boundingRadius > 0) {
            // Covers narrow conifers through broad/edge-expanded deciduous crowns.
            for (const [height, radiusRatio] of [[2.8, 0.12], [35, 0.55]] as const) {
              expectWorldRadiusRoundTrip(
                `${species}/${variant}/${band}/crown`,
                prototype.crown.boundingRadius,
                height,
                height * radiusRatio,
              );
            }
          }
          if (prototype.trunk.boundingRadius > 0) {
            // The lower case is deliberately thinner than every generated
            // species trunk. It encoded as the old 0.5 minimum before this fix.
            for (const [height, radiusRatio] of [[2.8, 0.01], [35, 0.035]] as const) {
              expectWorldRadiusRoundTrip(
                `${species}/${variant}/${band}/trunk`,
                prototype.trunk.boundingRadius,
                height,
                height * radiusRatio,
              );
            }
          }
        }
      }
    }
  });

  it("round-trips all shrub variants and all rock prototypes", () => {
    for (const species of SHRUB_SPECIES) {
      for (let variant = 0; variant < SHRUB_VARIANT_COUNTS[species]; variant += 1) {
        const prototype = buildShrubPrototype(species, variant, 7);
        for (const [height, radiusRatio] of [[0.3, 0.45], [3.5, 0.9]] as const) {
          expectWorldRadiusRoundTrip(
            `${species}/${variant}`,
            prototype.boundingRadius,
            height,
            height * radiusRatio,
          );
        }
      }
    }
    for (const variant of ROCK_VARIANTS) {
      const prototype = buildRockPrototype(variant, 7);
      for (const flattening of [0.45, 0.9]) {
        const radiusMeters = 3;
        expectWorldRadiusRoundTrip(
          `${variant}/${flattening}`,
          prototype.boundingRadius,
          radiusMeters * flattening,
          radiusMeters,
        );
      }
    }
  });

  it("rejects invalid dimensions instead of silently manufacturing a scale", () => {
    expect(() => detailRadialScaleForWorldRadius(-1, 10, 0.4)).toThrow(/world radius/u);
    expect(() => detailRadialScaleForWorldRadius(1, 0, 0.4)).toThrow(/height/u);
    expect(() => detailRadialScaleForWorldRadius(1, 10, 0)).toThrow(/prototype radius/u);
    expect(DETAIL_INSTANCE_HEIGHT_MAX_METERS).toBe(48);
  });
});

/**
 * THE HEIGHT CONTRACT, WHICH IS THE ONE NOBODY WROTE.
 *
 * `PrototypeGeometry.boundingHeight` carries the docblock *"prototype heights
 * are normalized to ~1"*. Everything above this point in the file guards the
 * RADIAL contract, exhaustively, because the radial half is normalised: the CPU
 * divides a desired world radius by the prototype's exact bound
 * (`detailRadialScaleForWorldRadius`) and the round trip is asserted per species,
 * per variant, per band.
 *
 * **The height half has no such normalisation and had no such guard.** The
 * vertex path computes world height as `positionUpdated.y * detailHeight`, which
 * ASSUMES the invariant rather than enforcing it, and `heightScaleMeters` is
 * passed straight through from the generator. So a prototype that does not reach
 * y = 1 renders short by exactly its shortfall, at full authored width.
 *
 * **Trees satisfy the contract. Shrubs do not, and not one of them does.**
 * Measured across every species, every variant and ten seeds: trees 0.92-0.97,
 * hazel 0.580-0.833, juniper 0.581-0.707, sage 0.367-0.472. Sage therefore
 * renders at ~44% of its authored height while its radius is exact.
 *
 * `heightMeters` is unambiguously a world height and three things agree on it:
 * the field name, the generator (`generation.ts` builds hazel as
 * `0.55 + maturity * 2.8`, a metre range), and the radius path, which derives
 * `radiusMeters` from it as a proportion.
 *
 * **This guard asserts what is TRUE TODAY, including the violation**, so the
 * discrepancy is executable rather than buried in a docblock that the code
 * contradicts. It is written to go RED when the violation is fixed — that is the
 * point. If you are here because it failed after normalising shrub prototypes,
 * flip `SHRUBS_SATISFY_THE_CONTRACT` and delete the pin below it.
 */
const PROTOTYPE_HEIGHT_CONTRACT_MIN = 0.9;

/** Flip when shrub prototypes are normalised. See the docblock above. */
const SHRUBS_SATISFY_THE_CONTRACT = false;

const HEIGHT_SEEDS = [1, 2, 3, 5, 7, 11, 13, 17, 19, 23] as const;

describe("prototype height contract", () => {
  it("holds for every tree prototype, which is what makes the shrub gap a gap", () => {
    let checked = 0;
    for (const species of TREE_SPECIES) {
      for (let variant = 0; variant < TREE_VARIANT_COUNTS[species]; variant += 1) {
        for (const band of TREE_BANDS) {
          for (const seed of HEIGHT_SEEDS) {
            const prototype = buildTreePrototype(species, variant, seed, band);
            const height = Math.max(
              prototype.crown.boundingHeight,
              prototype.trunk.boundingHeight,
            );
            checked += 1;
            expect(
              height,
              `${species}/v${variant}/${band}/seed${seed}: a tree prototype must reach `
                + "the normalised height the vertex path assumes",
            ).toBeGreaterThanOrEqual(PROTOTYPE_HEIGHT_CONTRACT_MIN);
          }
        }
      }
    }
    // NON-VACUITY: an empty enumeration passes every assertion above it.
    expect(checked).toBeGreaterThan(100);
  });

  it("records that NO shrub prototype satisfies it, and how far short the worst is", () => {
    let worst = Number.POSITIVE_INFINITY;
    let tallest = 0;
    let checked = 0;
    for (const species of SHRUB_SPECIES) {
      for (let variant = 0; variant < SHRUB_VARIANT_COUNTS[species]; variant += 1) {
        for (const seed of HEIGHT_SEEDS) {
          const height = buildShrubPrototype(species, variant, seed).boundingHeight;
          checked += 1;
          worst = Math.min(worst, height);
          tallest = Math.max(tallest, height);
        }
      }
    }
    expect(checked).toBeGreaterThan(40);

    if (SHRUBS_SATISFY_THE_CONTRACT) {
      expect(worst).toBeGreaterThanOrEqual(PROTOTYPE_HEIGHT_CONTRACT_MIN);
      return;
    }

    // FAILS IF: shrub prototypes are normalised. That is a fix, not a
    // regression — flip the constant above rather than widening this.
    expect(
      tallest,
      "no shrub prototype reaches the normalised height, so every shrub renders "
        + "short at full authored width; if this failed, the violation was fixed",
    ).toBeLessThan(PROTOTYPE_HEIGHT_CONTRACT_MIN);
    // The severity, pinned so it cannot drift quietly in either direction.
    // Sage is the worst: ~0.44, i.e. it renders at ~44% of its authored height.
    expect(worst).toBeGreaterThan(0.3);
    expect(worst).toBeLessThan(0.5);
  });
});
