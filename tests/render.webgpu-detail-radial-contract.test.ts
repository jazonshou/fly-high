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
