import { describe, expect, it } from "vitest";
import { CreateSphereVertexData } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import {
  buildLightPointGeometry,
  LIGHT_POINT_FRAGMENT_WGSL,
  LIGHT_POINT_WGSL,
  iesProfileCoordinate,
  LIGHT_POINT_PSF_RADIUS_PIXELS,
  lightPointFluxNormaliser,
  lightPointRadiusPixels,
  type LightPointFixture,
} from "../src/render/webgpu/lighting/LightPoints";

const FIXTURES: LightPointFixture[] = [
  { position: [0, 1, 0], aim: [0, 1, 0], intensity: 4, profileRow: 0, radiusMeters: 0.1, color: [1, 1, 1] },
  { position: [10, 1, 5], aim: [0, 0, 1], intensity: 2, profileRow: 1, radiusMeters: 0.2, color: [1, 0.6, 0.2] },
  { position: [-8, 2, 3], aim: [1, 0, 0], intensity: 9, profileRow: 0, radiusMeters: 0.05, color: [0.2, 1, 0.3] },
];

describe("7-5 light points", () => {
  it("applies exactly ONE extinction model, and it is the aerial include's", () => {
    // WHAT THIS REPLACED, and why the replacement is not a weakening.
    //
    // This slot held an elaborate, careful pin: that
    // `lightPointAtmosphericTransmission` agreed with the star path's
    // Kasten-Young air mass to 12 decimal places, clamp divergence above 88.6
    // degrees and all. Every assertion in it was true. It modelled the shader
    // instead of reading it, and the shader has since stopped applying an air
    // mass at all -- so the pin would have gone on passing, in full detail,
    // about a term that is no longer in the frame. That is the house failure
    // mode: a guard that MODELS the thing stays green after the thing changes.
    //
    // WHY THE TERM WENT. Kasten-Young integrates the full atmospheric column to
    // space as a function of elevation above the horizon. A runway lamp is a
    // terrestrial source at finite distance, usually BELOW the viewer, which
    // makes the elevation negative. MEASURED across every approach geometry an
    // aircraft can fly (1,200 m at 70 m, 500 m at 30 m, 200 m at 10 m, 1,200 m
    // at 400 m) the elevation clamped to -2 degrees and the air mass pinned to
    // its ceiling of 40 -- a CONSTANT 6.31e-4, a 1,585x attenuation identical
    // in every case, on paths of a few hundred metres. It rendered the whole
    // airfield black and nothing varied with the geometry it modelled.
    //
    // So this reads the SHIPPING shader source for the property that matters:
    // one extinction model, the owned one.
    //
    // COMMENTS STRIPPED FIRST, and this is not fussiness: the docblock that
    // explains why the air-mass term was removed necessarily NAMES it, so a
    // raw substring scan reads the explanation as the offence and fails on a
    // correct shader. `owners.ts` has the same trap recorded -- a boundary
    // guard that matched prose. A guard must read the CODE.
    const code = LIGHT_POINT_WGSL.replace(/\/\/[^\n]*/g, "");
    expect(code).toContain("aerialPerspective(");
    expect(code).toContain("haze.transmittance");
    for (const term of ["airMass", "0.50572", "6.07995"]) {
      expect(
        code.includes(term),
        `the light-point shader carries "${term}" — a second extinction model `
        + "alongside the aerial include, which is the drift the include exists "
        + "to prevent",
      ).toBe(false);
    }
    // And in-scatter still must NOT be added: an additive billboard draws over
    // a framebuffer that already carries the path's in-scatter, so adding it
    // again applies the haze once per light.
    expect(code.includes("haze.inScatter")).toBe(false);
  });

  it("conserves flux exactly across the near->far transition", () => {
    // The pop this prevents: cross-fading a glow into a disc changes total
    // flux as a light approaches. Here peak * area is invariant, so the light
    // SPREADS rather than brightening.
    for (const projected of [0, 0.5, 1.7, 2, 8, 40, 400]) {
      const radius = lightPointRadiusPixels(projected);
      const flux = lightPointFluxNormaliser(radius) * radius * radius;
      expect(flux, `projected ${projected}px`).toBeCloseTo(1, 12);
    }
  });

  it("never renders below the PSF, and is continuous through the crossover", () => {
    expect(lightPointRadiusPixels(0)).toBe(LIGHT_POINT_PSF_RADIUS_PIXELS);
    const below = lightPointRadiusPixels(LIGHT_POINT_PSF_RADIUS_PIXELS - 1e-6);
    const above = lightPointRadiusPixels(LIGHT_POINT_PSF_RADIUS_PIXELS + 1e-6);
    expect(Math.abs(above - below)).toBeLessThan(1e-5);
    let previous = 0;
    for (let projected = 0; projected < 20; projected += 0.25) {
      const radius = lightPointRadiusPixels(projected);
      expect(radius).toBeGreaterThanOrEqual(previous);
      previous = radius;
    }
  });

  it("maps the IES polar angle to [0,1] with the axis at zero", () => {
    expect(iesProfileCoordinate([0, 1, 0], [0, 1, 0])).toBeCloseTo(0, 12);
    expect(iesProfileCoordinate([0, 1, 0], [1, 0, 0])).toBeCloseTo(0.5, 12);
    expect(iesProfileCoordinate([0, 1, 0], [0, -1, 0])).toBeCloseTo(1, 12);
  });

  it("produces no geometry and does not throw with an empty fixture list", () => {
    // `FlightRenderer` constructs this system EMPTY: the fixtures are 7-7's,
    // and wiring it now keeps the integration point exercised across the gate
    // boundary rather than letting it rot unwired.
    //
    // The empty path is asserted rather than tolerated because otherwise
    // "nothing renders" and "the system is broken" are the SAME observation on
    // the day 7-7 populates it — and the first person to see a dark airfield
    // would have no way to tell which they were looking at.
    expect(() => buildLightPointGeometry([])).not.toThrow();
    const empty = buildLightPointGeometry([]);
    expect(empty.indices.length, "no fixtures must mean no triangles").toBe(0);
    expect(empty.positions.length).toBe(0);
    expect(empty.params.length).toBe(0);
    // And one fixture must produce exactly one quad, so "zero" is a real zero
    // rather than a builder that always returns nothing.
    expect(buildLightPointGeometry([FIXTURES[0]!]).indices.length).toBe(6);
  });

  it("assembles the shader with the owned aerial include actually in it", () => {
    // A missing interpolation is invisible to `tsc` and to every Node test that
    // does not look: the string would simply lack the include and fail only on
    // a GPU, in a compile error naming a symbol rather than a missing include.
    // `isReady()` would not catch it either -- a readiness flag is not a
    // compile check.
    expect(LIGHT_POINT_WGSL).toContain("fn aerialPerspective(");
    expect(LIGHT_POINT_WGSL).toContain("aerialPerspective(worldPosition.y");
    expect(LIGHT_POINT_WGSL).toContain("haze.transmittance");
    // In-scatter must NOT be added: an additive billboard draws over a
    // framebuffer that already carries the path's in-scatter, so adding it
    // again puts the haze in once per light.
    expect(LIGHT_POINT_WGSL).not.toContain("haze.inScatter");

    for (const [name, source] of [
      ["vertex", LIGHT_POINT_WGSL],
      ["fragment", LIGHT_POINT_FRAGMENT_WGSL],
    ] as const) {
      const opens = (source.match(/\{/g) ?? []).length;
      const closes = (source.match(/\}/g) ?? []).length;
      expect(opens, `${name} braces balanced`).toBe(closes);
      // A backtick inside a WGSL template literal terminates the string and
      // has already cost two confusing `tsc` failures in this file.
      expect(source.includes("`"), `${name} carries no stray backtick`).toBe(false);
    }
    expect(LIGHT_POINT_WGSL).toContain("@vertex");
    expect(LIGHT_POINT_FRAGMENT_WGSL).toContain("@fragment");
  });

  it("emits one draw's worth of geometry and winds it Babylon's way", () => {
    const g = buildLightPointGeometry(FIXTURES);
    // ONE instanced draw is the design constraint (night draw ceiling 160), so
    // the geometry must be a single index buffer over every fixture.
    expect(g.indices.length).toBe(FIXTURES.length * 6);
    expect(g.positions.length).toBe(FIXTURES.length * 4 * 3);
    expect(g.params.length).toBe(FIXTURES.length * 4 * 4);

    const agreement = (
      positions: ArrayLike<number>, normals: ArrayLike<number>, indices: ArrayLike<number>,
    ): number => {
      let sum = 0; let n = 0;
      for (let t = 0; t * 3 + 2 < indices.length; t += 1) {
        const ia = indices[t * 3]!, ib = indices[t * 3 + 1]!, ic = indices[t * 3 + 2]!;
        const ax = positions[ia * 3]!, ay = positions[ia * 3 + 1]!, az = positions[ia * 3 + 2]!;
        const ux = positions[ib * 3]! - ax, uy = positions[ib * 3 + 1]! - ay, uz = positions[ib * 3 + 2]! - az;
        const vx = positions[ic * 3]! - ax, vy = positions[ic * 3 + 1]! - ay, vz = positions[ic * 3 + 2]! - az;
        const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
        const gl = Math.hypot(gx, gy, gz);
        if (!(gl > 1e-12)) continue;
        const nx = (normals[ia * 3]! + normals[ib * 3]! + normals[ic * 3]!) / 3;
        const ny = (normals[ia * 3 + 1]! + normals[ib * 3 + 1]! + normals[ic * 3 + 1]!) / 3;
        const nz = (normals[ia * 3 + 2]! + normals[ib * 3 + 2]! + normals[ic * 3 + 2]!) / 3;
        const nl = Math.hypot(nx, ny, nz);
        if (!(nl > 1e-9)) continue;
        sum += (gx * nx / nl + gy * ny / nl + gz * nz / nl) / gl; n += 1;
      }
      return sum / Math.max(n, 1);
    };
    const sphere = CreateSphereVertexData({ diameter: 2, segments: 16 }) as unknown as
      { positions: number[]; normals: number[]; indices: number[] };
    const convention = Math.sign(agreement(sphere.positions, sphere.normals, sphere.indices));
    expect(convention).toBe(-1);

    // The billboard quads are flat in the XY plane of their corner basis; give
    // every vertex the +Z normal the quad faces and check the winding against
    // Babylon's convention rather than assuming it.
    const flat = new Float32Array(g.positions.length);
    for (let v = 0; v * 3 + 2 < flat.length; v += 1) flat[v * 3 + 2] = 1;
    const quadPositions = new Float32Array(g.positions.length);
    for (let v = 0; v * 3 + 2 < quadPositions.length; v += 1) {
      quadPositions[v * 3] = g.corners[v * 2]!;
      quadPositions[v * 3 + 1] = g.corners[v * 2 + 1]!;
      quadPositions[v * 3 + 2] = 0;
    }
    expect(Math.sign(agreement(quadPositions, flat, g.indices))).toBe(convention);
  });
});
