import { describe, expect, it } from "vitest";
import {
  OPEN_GROUND_COPSE_SHARE,
  OPEN_GROUND_GROVE_SHARE,
  OPEN_GROUND_LONE_TREE_SHARE,
  OPEN_GROUND_WOODED_FULL,
  OPEN_GROUND_WOODED_ONSET,
  densityField,
  forestFraction,
  forestProvinceSignal,
  openGroundTreeShare,
} from "../src/render/webgpu/detail/densityField";
import { VEGETATION_DENSITY_FIELD_WGSL } from "../src/render/webgpu/detail/densityFieldWgsl";
import { hashSeed } from "../src/world";

const SEED = hashSeed("gate-b-forest-pattern");
const MOISTURE = 0.7;
/** Stems per square metre where only open ground's lone trees stand. */
const LONE_TREES_ONLY = 0.08 * OPEN_GROUND_LONE_TREE_SHARE;

function sample(x: number, z: number) {
  return densityField(SEED, {
            filterWidthMeters: 0,
    x,
    z,
    heightMeters: 320,
    seaLevelMeters: 0,
    slope: 0.04,
    moisture: MOISTURE,
    normalX: 0.01,
    normalZ: 0.02,
    dayOfYear: 171,
  });
}

describe("Gate B forest-pattern variance (assertions 67e/67f)", () => {
  it("authors kilometre-scale meadow and closed-forest provinces", () => {
    let meadowWindow = false;
    let forestWindow = false;
    for (let originZ = -30_000; originZ <= 27_000; originZ += 3_000) {
      for (let originX = -30_000; originX <= 27_000; originX += 3_000) {
        const values: number[] = [];
        for (let dz = 0; dz <= 2_000; dz += 1_000) {
          for (let dx = 0; dx <= 2_000; dx += 1_000) {
            values.push(forestFraction(SEED, originX + dx, originZ + dz, MOISTURE));
          }
        }
        meadowWindow ||= Math.max(...values) < 0.08;
        forestWindow ||= Math.min(...values) > 0.92;
      }
    }
    expect(meadowWindow, "a whole multi-kilometre meadow province").toBe(true);
    expect(forestWindow, "a whole multi-kilometre closed-forest province").toBe(true);
  });

  it("opens below the rendered cap and retains dense stand interiors", () => {
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = 0;
    let sum = 0;
    let count = 0;
    for (let z = -12_000; z <= 12_000; z += 160) {
      for (let x = -12_000; x <= 12_000; x += 160) {
        const stems = sample(x, z).treeStemsPerSquareMeter;
        minimum = Math.min(minimum, stems);
        maximum = Math.max(maximum, stems);
        sum += stems;
        count += 1;
      }
    }
    // 78 rendered stems/ha = 0.0078/m². Openings must author less than
    // that or rendered-share thinning fills them back in.
    expect(minimum).toBeLessThan(0.001);
    expect(maximum).toBeGreaterThan(0.035);
    // The new province/glade/disturbance stack lowers net authored stems;
    // it must not quietly return to a near-uniform closed forest.
    expect(sum / count).toBeLessThan(0.025);
  });

  it("contains hard disturbance boundaries and shorter edge margins", () => {
    let hardBoundary = false;
    const edgeHeights: number[] = [];
    const interiorHeights: number[] = [];
    for (let z = -18_000; z <= 18_000; z += 80) {
      let previous = sample(-18_000, z);
      for (let x = -17_920; x <= 18_000; x += 80) {
        const current = sample(x, z);
        // The blown-down side is no longer exactly empty: open ground's lone
        // trees stand in it (2.4/ha at most away from a copse). The boundary
        // is still a step of twentyfold or more inside one 80 m stride.
        if (
          (previous.treeStemsPerSquareMeter <= LONE_TREES_ONLY
            && current.treeStemsPerSquareMeter > 0.012)
          || (current.treeStemsPerSquareMeter <= LONE_TREES_ONLY
            && previous.treeStemsPerSquareMeter > 0.012)
        ) {
          hardBoundary = true;
        }
        if (current.forestEdge > 0.72) edgeHeights.push(current.heightFactor);
        if (current.forestEdge < 0.08 && current.treeStemsPerSquareMeter > 0.025) {
          interiorHeights.push(current.heightFactor);
        }
        previous = current;
      }
    }
    expect(hardBoundary, "a zero-width windthrow boundary").toBe(true);
    expect(edgeHeights.length).toBeGreaterThan(50);
    expect(interiorHeights.length).toBeGreaterThan(50);
    const mean = (values: readonly number[]) =>
      values.reduce((total, value) => total + value, 0) / values.length;
    expect(mean(edgeHeights)).toBeLessThan(mean(interiorHeights) * 0.82);
  });
});

describe("open ground's own trees: lone trees, copses and groves", () => {
  /** Open country: drier than the forest test's 0.7, still far above the lone tree's own gate. */
  const OPEN_MOISTURE = 0.4;

  function open(x: number, z: number, extra: { dryness?: number; slope?: number } = {}) {
    return densityField(SEED, {
      filterWidthMeters: 0,
      x,
      z,
      heightMeters: 320,
      seaLevelMeters: 0,
      slope: extra.slope ?? 0.04,
      moisture: OPEN_MOISTURE,
      normalX: 0.01,
      normalZ: 0.02,
      dayOfYear: 171,
      ...(extra.dryness === undefined ? {} : { dryness: extra.dryness }),
    });
  }

  it("is a share of the tree base that rises with the province and with the glade field", () => {
    expect(openGroundTreeShare(OPEN_GROUND_WOODED_ONSET, 1)).toBe(0);
    expect(openGroundTreeShare(OPEN_GROUND_WOODED_ONSET - 0.3, 1)).toBe(0);
    expect(openGroundTreeShare(OPEN_GROUND_WOODED_FULL, -1)).toBe(OPEN_GROUND_LONE_TREE_SHARE);
    expect(openGroundTreeShare(0.4, 1)).toBeCloseTo(
      OPEN_GROUND_LONE_TREE_SHARE + OPEN_GROUND_COPSE_SHARE + OPEN_GROUND_GROVE_SHARE, 12);
    let previous = 0;
    for (let signal = OPEN_GROUND_WOODED_ONSET; signal <= 0.3; signal += 0.01) {
      const share = openGroundTreeShare(signal, 0.5);
      expect(share).toBeGreaterThanOrEqual(previous);
      previous = share;
    }
    previous = 0;
    for (let glade = -1; glade <= 1; glade += 0.02) {
      const share = openGroundTreeShare(0, glade);
      expect(share).toBeGreaterThanOrEqual(previous);
      previous = share;
    }
  });

  it("never passes for the forest: a grove stays under 60 stems a hectare", () => {
    // The capture's forest shots search for 0.006 stems/m² (`shotPlacement`),
    // and the near band draws 55 to 79 a hectare.
    const ceiling = 0.08
      * (OPEN_GROUND_LONE_TREE_SHARE + OPEN_GROUND_COPSE_SHARE + OPEN_GROUND_GROVE_SHARE);
    expect(ceiling).toBeLessThan(0.006);
    let meadowMaximum = 0;
    for (let z = -12_000; z <= 12_000; z += 160) {
      for (let x = -12_000; x <= 12_000; x += 160) {
        if (forestFraction(SEED, x, z, OPEN_MOISTURE) > 0) continue;
        meadowMaximum = Math.max(meadowMaximum, open(x, z).treeStemsPerSquareMeter);
      }
    }
    expect(meadowMaximum).toBeGreaterThan(ceiling * 0.5);
    expect(meadowMaximum).toBeLessThanOrEqual(ceiling);
  });

  it("fills the range between no tree and forest, and leaves whole stretches of steppe bare", () => {
    let total = 0;
    let bare = 0;
    let sparse = 0;
    let forest = 0;
    for (let z = -12_000; z <= 12_000; z += 160) {
      for (let x = -12_000; x <= 12_000; x += 160) {
        const stems = open(x, z).treeStemsPerSquareMeter;
        total += 1;
        if (stems === 0) bare += 1;
        else if (stems <= 0.002) sparse += 1;
        else if (stems > 0.0078) forest += 1;
      }
    }
    // Measured 2026-11-12: 14.7% bare, most of the rest under 20 stems/ha,
    // 4.8% closed forest. Before this term the sparse share was the forest's
    // own thin margins only.
    expect(bare / total).toBeGreaterThan(0.08);
    expect(bare / total).toBeLessThan(0.3);
    expect(sparse / total).toBeGreaterThan(0.4);
    expect(forest / total).toBeGreaterThan(0.02);

    let bareWindow = false;
    for (let originZ = -30_000; originZ <= 27_000 && !bareWindow; originZ += 3_000) {
      for (let originX = -30_000; originX <= 27_000 && !bareWindow; originX += 3_000) {
        let maximum = 0;
        for (let dz = 0; dz <= 2_000; dz += 500) {
          for (let dx = 0; dx <= 2_000; dx += 500) {
            maximum = Math.max(maximum, open(originX + dx, originZ + dz).treeStemsPerSquareMeter);
          }
        }
        bareWindow = maximum === 0;
      }
    }
    expect(bareWindow, "a whole 2 km stretch with no tree on it").toBe(true);
  });

  it("stops where the province signal says the country is open", () => {
    for (let z = -12_000; z <= 12_000; z += 400) {
      for (let x = -12_000; x <= 12_000; x += 400) {
        const signal = forestProvinceSignal(SEED, x, z, OPEN_MOISTURE);
        const stems = open(x, z).treeStemsPerSquareMeter;
        if (signal <= OPEN_GROUND_WOODED_ONSET) expect(stems).toBe(0);
      }
    }
  });

  it("grows its trees open: shorter, with the wider crown an edge stem has", () => {
    let seen = 0;
    for (let z = -12_000; z <= 12_000; z += 160) {
      for (let x = -12_000; x <= 12_000; x += 160) {
        if (forestFraction(SEED, x, z, OPEN_MOISTURE) > 0) continue;
        const field = open(x, z);
        if (field.treeStemsPerSquareMeter === 0) continue;
        seen += 1;
        expect(field.forestEdge).toBeGreaterThanOrEqual(0.8 - 1e-12);
      }
    }
    expect(seen).toBeGreaterThan(1_000);
  });

  it("leaves the dry provinces to their own stands", () => {
    // A level desert floor grows no pinyon and keeps no closed forest, so any
    // tree on it would be this term's.
    let maximum = 0;
    for (let z = -6_000; z <= 6_000; z += 200) {
      for (let x = -6_000; x <= 6_000; x += 200) {
        maximum = Math.max(
          maximum, open(x, z, { dryness: 0.45, slope: 0 }).treeStemsPerSquareMeter);
      }
    }
    expect(maximum).toBe(0);
  });

  it("is the same law in the shader twin", () => {
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain("fn vegetationOpenGroundTreeShare(");
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain("fn vegetationForestSignal(");
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain(
      "max(closedStems, openGroundStems) + parklandStems + pinyonStems");
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain(
      "* openStand * slopeFactor * lapse * (1.0 - arid - parkland);");
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain(
      "openGrown = (openGroundStems - closedStems) / openGroundStems;");
    for (const value of [
      OPEN_GROUND_LONE_TREE_SHARE,
      OPEN_GROUND_COPSE_SHARE,
      OPEN_GROUND_GROVE_SHARE,
      OPEN_GROUND_WOODED_ONSET,
      OPEN_GROUND_WOODED_FULL,
    ]) {
      expect(VEGETATION_DENSITY_FIELD_WGSL).toContain(String(value));
    }
  });
});
