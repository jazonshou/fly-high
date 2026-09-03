import { describe, expect, it } from "vitest";
import {
  AIRFIELD_ASPECT_V_START,
  synthesizeAirfieldConcrete,
} from "../src/render/webgpu/airfield/AirfieldMaterials";
import {
  hangarPlanFrom,
  hangarShellGeometry,
} from "../src/render/webgpu/airfield/AirfieldStructures";
import {
  TOWER_PART_NAMES,
  TOWER_PART_SURFACE,
  TOWER_TILE_METERS,
  buildTowerGeometry,
} from "../src/render/webgpu/detail/towerGeometry";
import { createWorld } from "../src/world";

/**
 * `7-11`: the tower's UVs against the contract, measured on the ARTIFACT.
 *
 * **Both halves were wrong and both read as plausible.** V ran 0 at the bottom
 * edge to 1 at the top, so weathering climbed toward the mast and left the base
 * clean — an inverted gradient looks weathered, just wrongly. And U was
 * `i / SIDES`, one tile per face regardless of size, which makes metres-per-tile
 * equal to the band's GIRTH: the base ran 46.4 m per 3.0 m tile, a 15x stretch,
 * while the mast's 2.32 m girth happened to land within 3% of its 2.4 m period
 * and looked fine.
 *
 * **That coincidence is why this reads the artifact rather than the source.** A
 * check that sampled one band could have picked the mast and passed.
 */
const world = createWorld("phase1-perf-baseline", { worldEvolution: "analytic" });

/** Side faces only: a quad with exactly two distinct Y. Skips caps and fans. */
function sideFaces(part: { positions: Float32Array; uvs: Float32Array }) {
  const out: { chord: number; du: number; vTop: number; vBottom: number }[] = [];
  const count = part.positions.length / 3;
  for (let q = 0; q + 3 < count; q += 4) {
    const ys = [0, 1, 2, 3].map((k) => part.positions[(q + k) * 3 + 1]!);
    if (new Set(ys.map((y) => y.toFixed(6))).size !== 2) continue;
    const hi = Math.max(...ys);
    const lo = Math.min(...ys);
    const bottom = [0, 1, 2, 3].filter((k) => ys[k] === lo);
    const top = [0, 1, 2, 3].filter((k) => ys[k] === hi);
    if (bottom.length !== 2 || top.length !== 2) continue;
    const [a, b] = bottom as [number, number];
    out.push({
      chord: Math.hypot(
        part.positions[(q + a) * 3]! - part.positions[(q + b) * 3]!,
        part.positions[(q + a) * 3 + 2]! - part.positions[(q + b) * 3 + 2]!,
      ),
      du: Math.abs(part.uvs[(q + a) * 2]! - part.uvs[(q + b) * 2]!),
      vTop: part.uvs[(q + top[0]!) * 2 + 1]!,
      vBottom: part.uvs[(q + a) * 2 + 1]!,
    });
  }
  return out;
}

describe("tower UV contract (7-11)", () => {
  it("measures U in metres per the surface's tile period, on every band", () => {
    const tower = buildTowerGeometry();
    for (const name of TOWER_PART_NAMES) {
      const faces = sideFaces(tower.parts[name]);
      if (faces.length === 0) continue;
      const period = TOWER_TILE_METERS[TOWER_PART_SURFACE[name]];
      for (const face of faces) {
        // The property, stated as the contract states it: one tile spans
        // `period` METRES of surface — not one tile per face.
        expect(face.chord / face.du, `${name}: metres per tile`).toBeCloseTo(period, 3);
      }
    }
  });

  it("runs V DOWN the face, from the aspect start to 1", () => {
    const tower = buildTowerGeometry();
    const starts = new Set(Object.values(AIRFIELD_ASPECT_V_START));
    for (const name of TOWER_PART_NAMES) {
      for (const face of sideFaces(tower.parts[name])) {
        expect(face.vBottom, `${name}: V at the bottom edge`).toBeCloseTo(1, 6);
        expect(face.vTop, `${name}: V at the top edge`).toBeLessThan(face.vBottom);
        // The top edge must be one of the contract's aspect values, not an
        // arbitrary number that merely happens to be smaller.
        expect(
          [...starts].some((s) => Math.abs(s - face.vTop) < 1e-6),
          `${name}: V top ${face.vTop} is not an AIRFIELD_ASPECT_V_START value`,
        ).toBe(true);
      }
    }
  });

  it("uses more than one aspect bucket around the octagon", () => {
    // A band that classified every face the same way would satisfy the gradient
    // test above while throwing away the whole point of aspect.
    const tower = buildTowerGeometry();
    const tops = new Set(sideFaces(tower.parts.shaft).map((f) => f.vTop.toFixed(6)));
    expect(tops.size).toBeGreaterThan(1);
  });

  it("darkens downward on the real texture, the way the hangar does", () => {
    // THE PIXEL CHECK. The UV assertions above are about numbers; this samples
    // the synthesized concrete at the emitted UVs and asks whether the surface
    // actually gets dirtier toward the ground.
    const concrete = synthesizeAirfieldConcrete(0x59f1_11f1);
    const edge = concrete.edge;
    const albedo = concrete.albedoMips[0]!;
    const sample = (u: number, v: number): number => {
      const x = ((Math.floor(u * edge) % edge) + edge) % edge;
      const y = Math.min(edge - 1, Math.max(0, Math.floor(v * edge)));
      const i = (y * edge + x) * 4;
      return (albedo[i]! * 0.2126 + albedo[i + 1]! * 0.7152 + albedo[i + 2]! * 0.0722) / 255;
    };
    // PAIRED WITHIN EACH FACE. Averaging a whole shell by world height mixes
    // the top of a low face with the bottom of a high one and cancels the
    // gradient — the hangar reads flat that way, which is how this instrument
    // was caught being wrong rather than the geometry.
    const gradient = (part: { positions: Float32Array; uvs: Float32Array }) => {
      const faces = sideFaces(part);
      let sum = 0;
      for (const face of faces) sum += sample(0.5, face.vTop) - sample(0.5, face.vBottom);
      return faces.length ? sum / faces.length : NaN;
    };

    const shell = hangarShellGeometry(hangarPlanFrom(world.seedHash, 0, 2.86));
    const reference = gradient(shell as unknown as { positions: Float32Array; uvs: Float32Array });
    expect(reference, "the hangar reference must itself darken downward").toBeGreaterThan(0);

    const tower = buildTowerGeometry();
    for (const name of ["base", "shaft", "gallery"] as const) {
      expect(gradient(tower.parts[name]), `${name} must darken downward`).toBeGreaterThan(0);
    }
  });
});
