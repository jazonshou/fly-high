import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Constants } from "@babylonjs/core/Engines/constants";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import type { SphericalPolynomial } from "@babylonjs/core/Maths/sphericalPolynomial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CubeMapToSphericalPolynomialTools } from "@babylonjs/core/Misc/HighDynamicRange/cubemapToSphericalPolynomial";
import { Scene } from "@babylonjs/core/scene";
import {
  evaluateSkyRadiance,
  resolveAerialPerspectiveBinding,
  type AerialPerspectiveBinding,
} from "../src/render/webgpu/atmosphere/AerialPerspective";
import {
  bakeSkyIrradiancePolynomial,
  bakeSphericalPolynomialFromRadiance,
  DEFAULT_GROUND_BOUNCE_ALBEDO,
  SKY_IRRADIANCE_SAMPLE_SIZE,
  SKY_PROBE_REBAKE_ALTITUDE_METERS,
  SkyEnvironmentProbe,
  SkyIrradianceBake,
  skyProbeRefreshAction,
  type CubeRadianceField,
  type SkyProbeRefreshAction,
} from "../src/render/webgpu/atmosphere/SkyEnvironmentProbe";
import { resolveEnvironmentState } from "../src/render/webgpu/nature/EnvironmentDirector";

/**
 * 1C-6 — the sky environment probe's diffuse half: SH irradiance baked from
 * the skyRadiance TS mirror, validated against the analytic reference the
 * plan demands (a uniform sky of radiance L must give irradiance πL — which
 * in Babylon's Lambertian-radiance convention evaluates back to exactly L).
 */

function evaluatePolynomial(
  polynomial: SphericalPolynomial,
  normal: readonly [number, number, number],
): [number, number, number] {
  const [x, y, z] = normal;
  const result: [number, number, number] = [0, 0, 0];
  const channels = ["x", "y", "z"] as const;
  for (let channel = 0; channel < 3; channel += 1) {
    const axis = channels[channel]!;
    result[channel] = polynomial.x[axis] * x
      + polynomial.y[axis] * y
      + polynomial.z[axis] * z
      + polynomial.xx[axis] * x * x
      + polynomial.yy[axis] * y * y
      + polynomial.zz[axis] * z * z
      + polynomial.xy[axis] * x * y
      + polynomial.yz[axis] * y * z
      + polynomial.zx[axis] * z * x;
  }
  return result;
}

const NORMALS: readonly [number, number, number][] = [
  [0, 1, 0],
  [0, -1, 0],
  [1, 0, 0],
  [0, 0, -1],
  [0.577, 0.577, 0.577],
];

describe("spherical-harmonics irradiance (1C-6)", () => {
  it("returns exactly L for a uniform sky of radiance L — the πL identity", () => {
    const polynomial = bakeSphericalPolynomialFromRadiance(() => [0.8, 0.5, 0.25], 16);
    for (const normal of NORMALS) {
      const irradiance = evaluatePolynomial(polynomial, normal);
      // convertIncidentRadianceToIrradiance (×π for uniform) followed by
      // convertIrradianceToLambertianRadiance (÷π) is the identity here.
      expect(irradiance[0]).toBeCloseTo(0.8, 2);
      expect(irradiance[1]).toBeCloseTo(0.5, 2);
      expect(irradiance[2]).toBeCloseTo(0.25, 2);
    }
  });

  it("lights an up-facing surface more than a down-facing one under a sky-only field", () => {
    const skyOnly = bakeSphericalPolynomialFromRadiance(
      (direction) => (direction[1] > 0 ? [1, 1, 1] : [0, 0, 0]),
      16,
    );
    const up = evaluatePolynomial(skyOnly, [0, 1, 0]);
    const down = evaluatePolynomial(skyOnly, [0, -1, 0]);
    expect(up[1]).toBeGreaterThan(down[1] * 3);
    expect(down[1]).toBeGreaterThanOrEqual(-0.02);
  });

  it("bakes a finite, blue-leaning, upward-dominant irradiance from the real sky", () => {
    const binding = resolveAerialPerspectiveBinding(
      resolveEnvironmentState({
        clock: { dayOfYear: 171, solarTimeHours: 12.5 },
        latitudeDegrees: 45,
        weather: "clear",
      }),
      120,
      [1, 0.96, 0.88],
      [0.58, 0.77, 0.96],
      1,
    );
    const polynomial = bakeSkyIrradiancePolynomial(binding);
    const up = evaluatePolynomial(polynomial, [0, 1, 0]);
    const down = evaluatePolynomial(polynomial, [0, -1, 0]);
    for (const value of [...up, ...down]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    // Skylight lands on upward faces; the below-horizon clamp keeps some
    // energy on downward faces (the haze band), but up must dominate.
    expect(up[2]).toBeGreaterThan(down[2] * 1.15);
    expect(up[2]).toBeGreaterThan(up[0]);
    expect(up[1]).toBeGreaterThan(0.02);
  });
});

describe("R-26 — the light rig's ground bounce is derived, not hardcoded", () => {
  const binding = resolveAerialPerspectiveBinding(
    resolveEnvironmentState({
      clock: { dayOfYear: 171, solarTimeHours: 12.5 },
      latitudeDegrees: 45,
      weather: "clear",
    }),
    120,
    [1, 0.96, 0.88],
    [0.58, 0.77, 0.96],
    1,
  );

  it("scales the below-horizon bake with the surface albedo it is given", () => {
    // Deviation D-6 pinned the below-horizon attenuation at a floor of 0.25 —
    // a ground-bounce fake tuned against a ground colour Phase 3 replaced. It
    // could not move with the season, so G-B's snow-covered world would have
    // bounced exactly as much light as its summer one.
    const down: readonly [number, number, number] = [0, -1, 0];
    const summer = evaluatePolynomial(bakeSkyIrradiancePolynomial(binding, 12, 0.17), down);
    const winter = evaluatePolynomial(bakeSkyIrradiancePolynomial(binding, 12, 0.42), down);
    const luminance = (rgb: readonly [number, number, number]): number =>
      0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    expect(luminance(summer)).toBeGreaterThan(0);
    expect(
      luminance(winter),
      "a snow-covered world must bounce more than a summer one",
    ).toBeGreaterThan(luminance(summer) * 1.3);

    // Up-facing surfaces still see the sky, unattenuated, at every albedo.
    const up: readonly [number, number, number] = [0, 1, 0];
    const upSummer = evaluatePolynomial(bakeSkyIrradiancePolynomial(binding, 12, 0.17), up);
    const upWinter = evaluatePolynomial(bakeSkyIrradiancePolynomial(binding, 12, 0.42), up);
    expect(luminance(upWinter) / luminance(upSummer)).toBeGreaterThan(0.9);
    expect(luminance(upWinter) / luminance(upSummer)).toBeLessThan(1.35);
  });

  it("defaults to the atmospheric ground albedo when no surface has published one", () => {
    // A probe baked before terrain exists must light exactly as it always did.
    const explicit = bakeSkyIrradiancePolynomial(binding, 12, DEFAULT_GROUND_BOUNCE_ALBEDO);
    const implicit = bakeSkyIrradiancePolynomial(binding, 12);
    const down: readonly [number, number, number] = [0, -1, 0];
    expect(evaluatePolynomial(implicit, down)).toEqual(evaluatePolynomial(explicit, down));
    expect(DEFAULT_GROUND_BOUNCE_ALBEDO).toBe(0.18);
  });

  it("D-9: the palette no longer carries a ground row for the light rig", () => {
    // The palette persisted "only for the light rig and the snapshot until
    // Phases 3/7 retire it". This is Phase 3 retiring the light rig's half:
    // AtmosphereSystem derives the HemisphericLight's ground colour from the
    // surface system's mean albedo, so a hand-tuned bounce colour has nowhere
    // left to hide.
    const source = readFileSync(
      join(__dirname, "..", "src", "render", "webgpu", "atmosphere", "AtmosphereSystem.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*ground: new Color3/mu);
    expect(source).not.toContain("palette.ground");
    expect(source).toContain("setSurfaceAlbedo");
    expect(source).toContain("this.ambient.groundColor = skyHorizon.multiply(this.surfaceAlbedo)");
  });
});

/**
 * 19543c0's one-shot bake, kept verbatim: the texel order and arithmetic a
 * sliced bake must reproduce bit for bit.
 */
const REFERENCE_FACES = [
  { name: "right", normal: [1, 0, 0], fileX: [0, 0, -1], fileY: [0, -1, 0] },
  { name: "left", normal: [-1, 0, 0], fileX: [0, 0, 1], fileY: [0, -1, 0] },
  { name: "up", normal: [0, 1, 0], fileX: [1, 0, 0], fileY: [0, 0, 1] },
  { name: "down", normal: [0, -1, 0], fileX: [1, 0, 0], fileY: [0, 0, -1] },
  { name: "front", normal: [0, 0, 1], fileX: [1, 0, 0], fileY: [0, -1, 0] },
  { name: "back", normal: [0, 0, -1], fileX: [-1, 0, 0], fileY: [0, -1, 0] },
] as const;

function referenceOneShotBake(
  radiance: (direction: [number, number, number]) => readonly [number, number, number],
  size: number,
): SphericalPolynomial {
  const du = 2 / size;
  const minUV = du / 2 - 1;
  const faces: Record<string, Float32Array> = {};
  for (const face of REFERENCE_FACES) {
    const data = new Float32Array(size * size * 3);
    for (let y = 0; y < size; y += 1) {
      const v = minUV + y * du;
      for (let x = 0; x < size; x += 1) {
        const u = minUV + x * du;
        const direction: [number, number, number] = [
          face.fileX[0] * u + face.fileY[0] * v + face.normal[0],
          face.fileX[1] * u + face.fileY[1] * v + face.normal[1],
          face.fileX[2] * u + face.fileY[2] * v + face.normal[2],
        ];
        const length = Math.hypot(direction[0], direction[1], direction[2]);
        direction[0] /= length;
        direction[1] /= length;
        direction[2] /= length;
        const rgb = radiance(direction);
        const offset = (y * size + x) * 3;
        data[offset] = rgb[0];
        data[offset + 1] = rgb[1];
        data[offset + 2] = rgb[2];
      }
    }
    faces[face.name] = data;
  }
  return CubeMapToSphericalPolynomialTools.ConvertCubeMapToSphericalPolynomial({
    right: faces["right"]!,
    left: faces["left"]!,
    up: faces["up"]!,
    down: faces["down"]!,
    front: faces["front"]!,
    back: faces["back"]!,
    size,
    format: Constants.TEXTUREFORMAT_RGB,
    type: Constants.TEXTURETYPE_FLOAT,
    gammaSpace: false,
  })!;
}

const POLYNOMIAL_TERMS = ["x", "y", "z", "xx", "yy", "zz", "xy", "yz", "zx"] as const;

function expectBitIdentical(
  actual: SphericalPolynomial | null,
  expected: SphericalPolynomial,
  label: string,
): void {
  expect(actual, label).not.toBeNull();
  let nonZero = 0;
  for (const term of POLYNOMIAL_TERMS) {
    for (const axis of ["x", "y", "z"] as const) {
      const value = actual![term][axis];
      const want = expected[term][axis];
      expect(Object.is(value, want), `${label}: ${term}.${axis} ${value} vs ${want}`).toBe(true);
      if (value !== 0) nonZero += 1;
    }
  }
  // Not vacuous: a real sky lights most of the 27 coefficients.
  expect(nonZero, label).toBeGreaterThan(9);
}

/** Midday, a low sun with its twilight lobes, and a moonlit night at cruise. */
const REBAKE_BINDINGS: readonly { readonly label: string; readonly binding: AerialPerspectiveBinding }[] = [
  {
    label: "midday",
    binding: resolveAerialPerspectiveBinding(
      resolveEnvironmentState({
        clock: { dayOfYear: 171, solarTimeHours: 12.5 },
        latitudeDegrees: 45,
        weather: "clear",
      }),
      120,
      [1, 0.96, 0.88],
      [0.58, 0.77, 0.96],
      1,
    ),
  },
  {
    label: "low sun",
    binding: resolveAerialPerspectiveBinding(
      resolveEnvironmentState({
        clock: { dayOfYear: 171, solarTimeHours: 19.6 },
        latitudeDegrees: 45,
        weather: "breezy",
      }),
      2_400,
      [1, 0.62, 0.34],
      [0.86, 0.6, 0.45],
      0.3,
    ),
  },
  {
    label: "moonlit night",
    binding: resolveAerialPerspectiveBinding(
      resolveEnvironmentState({
        clock: { dayOfYear: 300, solarTimeHours: 23 },
        latitudeDegrees: 45,
        weather: "cloudy",
      }),
      9_000,
      [1, 0.96, 0.88],
      [0.05, 0.07, 0.12],
      0.01,
      [0.3, 0.62, 0.725],
      0.8,
    ),
  },
];

function createProbe(now?: () => number): { probe: SkyEnvironmentProbe; dispose: () => void } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const probe = new SkyEnvironmentProbe(scene, new Mesh("sky", scene), now);
  // The null engine gives the cube no internal texture, so Babylon's own
  // accessor would drop the polynomial; keep what the probe sets instead.
  let polynomial: SphericalPolynomial | null = null;
  Object.defineProperty(probe.texture, "sphericalPolynomial", {
    get: () => polynomial,
    set: (value: SphericalPolynomial | null) => {
      polynomial = value;
    },
    configurable: true,
  });
  return {
    probe,
    dispose: () => {
      probe.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}

/** A clock that moves 0.05 ms every time it is read. */
function fakeClock(): () => number {
  let reads = 0;
  return () => {
    reads += 1;
    return reads * 0.05;
  };
}

describe("F1 — the sky irradiance bake slices without changing a bit", () => {
  it("keeps the one-shot bake's texel order and arithmetic", () => {
    const low = REBAKE_BINDINGS[1]!.binding;
    // The low sun sits within a few degrees of the horizon, where the sky
    // changes fastest with direction.
    expect(low.sunDirection[1]).toBeGreaterThan(-0.05);
    expect(low.sunDirection[1]).toBeLessThan(0.12);
    for (const { label, binding } of REBAKE_BINDINGS) {
      const sky = (direction: [number, number, number]) => evaluateSkyRadiance(binding, direction);
      for (const size of [SKY_IRRADIANCE_SAMPLE_SIZE, 12]) {
        expectBitIdentical(
          bakeSphericalPolynomialFromRadiance(sky, size),
          referenceOneShotBake(sky, size),
          `${label} @ ${size}`,
        );
      }
    }
  });

  it("gives the bit-identical polynomial at a zero, a 0.5 ms and an infinite budget", () => {
    for (const { label, binding } of REBAKE_BINDINGS) {
      for (const albedo of [DEFAULT_GROUND_BOUNCE_ALBEDO, 0.42]) {
        const oneShot = bakeSkyIrradiancePolynomial(binding, SKY_IRRADIANCE_SAMPLE_SIZE, albedo);
        const rows = 6 * SKY_IRRADIANCE_SAMPLE_SIZE;

        const zero = createProbe();
        zero.probe.beginRebake(binding, albedo);
        let zeroCalls = 1;
        while (!zero.probe.advanceRebake(0)) zeroCalls += 1;
        // A zero budget still samples a row a call, and only one.
        expect(zeroCalls).toBe(rows);
        zero.probe.applyRebake();
        expectBitIdentical(zero.probe.texture.sphericalPolynomial, oneShot, `${label} budget 0`);
        zero.dispose();

        const sliced = createProbe(fakeClock());
        sliced.probe.beginRebake(binding, albedo);
        let slicedCalls = 1;
        while (!sliced.probe.advanceRebake(0.5)) slicedCalls += 1;
        expect(slicedCalls).toBeGreaterThan(1);
        expect(slicedCalls).toBeLessThan(rows);
        sliced.probe.applyRebake();
        expectBitIdentical(sliced.probe.texture.sphericalPolynomial, oneShot, `${label} 0.5 ms`);
        sliced.dispose();

        const whole = createProbe();
        whole.probe.beginRebake(binding, albedo);
        expect(whole.probe.advanceRebake(Number.POSITIVE_INFINITY)).toBe(true);
        whole.probe.applyRebake();
        expectBitIdentical(whole.probe.texture.sphericalPolynomial, oneShot, `${label} infinite`);
        whole.dispose();
      }
    }
  });

  it("samples a snapshot: the live binding can move while the rebake runs", () => {
    const original = REBAKE_BINDINGS[1]!.binding;
    const live = structuredClone(original);
    const { probe, dispose } = createProbe();
    probe.beginRebake(live);
    expect(probe.rebakeInProgress).toBe(true);
    // The snapshot is a whole binding, for AtmosphereGpuResources.update.
    expect(probe.rebakeBinding).toStrictEqual(original);
    probe.advanceRebake(0);
    // The renderer's binding moves on every frame of a climb.
    (live as { cameraAltitudeMeters: number }).cameraAltitudeMeters = 30_000;
    (live as { nightZenithFade: number }).nightZenithFade = 0.7;
    (live as { strength: number }).strength = 0.1;
    live.sunDirection[1] = 0.9;
    live.coefficients.rayleighScattering[2] *= 3;
    (live.coefficients as { mieAnisotropy: number }).mieAnisotropy = 0.2;
    live.sunRadiance[0] *= 2;
    live.ambient[1] = 0;
    live.sunTransmittance[2] = 0.5;
    live.twilightArch[0] = 1;
    live.twilightWarm[1] = 1;
    live.twilightBelt[2] = 1;
    live.sunsetDirection[0] = -1;
    while (!probe.advanceRebake(0)) {
      live.sunDirection[0] += 0.01;
    }
    probe.applyRebake();
    expect(probe.rebakeInProgress).toBe(false);
    expectBitIdentical(
      probe.texture.sphericalPolynomial,
      bakeSkyIrradiancePolynomial(original),
      "snapshot",
    );
    expect(probe.rebakeBinding).toStrictEqual(original);
    dispose();
  });

  it("applies the irradiance and re-arms the specular cube as separate steps", () => {
    const { probe, dispose } = createProbe();
    const cube = probe.texture;
    expect(() => probe.applyRebakeIrradiance()).toThrow();
    probe.beginRebake(REBAKE_BINDINGS[0]!.binding);
    expect(() => probe.applyRebakeIrradiance()).toThrow();
    while (!probe.advanceRebake(0)) { /* slice */ }
    // Ready but not applied: still in progress, and it stays ready.
    expect(probe.rebakeInProgress).toBe(true);
    expect(probe.advanceRebake(0)).toBe(true);

    cube.refreshRate = 7;
    probe.applyRebakeIrradiance();
    expect(cube.refreshRate, "the irradiance alone leaves the cube unarmed").toBe(7);
    expectBitIdentical(
      cube.sphericalPolynomial,
      bakeSkyIrradiancePolynomial(REBAKE_BINDINGS[0]!.binding),
      "applied",
    );
    expect(probe.rebakeInProgress).toBe(false);
    expect(probe.advanceRebake(0), "nothing left in flight").toBe(false);
    probe.rearmSpecular();
    expect(cube.refreshRate).toBe(RenderTargetTexture.REFRESHRATE_RENDER_ONCE);
    dispose();
  });

  it("drops a rebake in flight when update() re-lights in one frame", () => {
    const { probe, dispose } = createProbe();
    const [first, second] = REBAKE_BINDINGS;
    probe.beginRebake(first!.binding);
    probe.advanceRebake(0);
    probe.update(second!.binding);
    expect(probe.rebakeInProgress).toBe(false);
    expect(probe.rebakeBinding).toBeNull();
    expect(probe.advanceRebake(Number.POSITIVE_INFINITY)).toBe(false);
    expect(() => probe.applyRebake()).toThrow();
    expectBitIdentical(
      probe.texture.sphericalPolynomial,
      bakeSkyIrradiancePolynomial(second!.binding),
      "update",
    );
    dispose();
  });

  it("counts each advance's and apply's milliseconds and the bakes completed", () => {
    const { probe, dispose } = createProbe(fakeClock());
    expect(probe.rebakeStats).toEqual({
      lastAdvanceMilliseconds: 0,
      maxAdvanceMilliseconds: 0,
      lastApplyMilliseconds: 0,
      maxApplyMilliseconds: 0,
      bakesCompleted: 0,
    });
    probe.update(REBAKE_BINDINGS[0]!.binding);
    expect(probe.rebakeStats.bakesCompleted, "update() is not a sliced bake").toBe(0);
    for (let bake = 1; bake <= 2; bake += 1) {
      probe.beginRebake(REBAKE_BINDINGS[bake]!.binding);
      while (!probe.advanceRebake(0.5)) { /* slice */ }
      probe.applyRebake();
      const stats = probe.rebakeStats;
      expect(stats.bakesCompleted).toBe(bake);
      // Each read moves the fake clock 0.05 ms: the advance spends its
      // 0.5 ms budget, and the converter is one step between two reads.
      expect(stats.maxAdvanceMilliseconds).toBeGreaterThanOrEqual(0.5);
      expect(stats.maxAdvanceMilliseconds).toBeLessThan(0.75);
      expect(stats.lastAdvanceMilliseconds).toBeGreaterThan(0);
      expect(stats.lastAdvanceMilliseconds).toBeLessThanOrEqual(stats.maxAdvanceMilliseconds);
      expect(stats.lastApplyMilliseconds).toBeCloseTo(0.05, 9);
      expect(stats.maxApplyMilliseconds).toBeCloseTo(0.05, 9);
    }
    dispose();
  });

  it("reuses its scratch and never reads the clock at an infinite budget", () => {
    const seen = new Set<[number, number, number]>();
    const field: CubeRadianceField = (direction) => {
      seen.add(direction);
      return [direction[1], 0.5, 0.25];
    };
    const bake = new SkyIrradianceBake();
    expect(bake.done).toBe(false);
    expect(() => bake.advance(0)).toThrow();
    bake.begin(field, 8);
    const noClock = (): number => {
      throw new Error("an infinite budget read the clock");
    };
    expect(bake.advance(Number.POSITIVE_INFINITY, noClock)).toBe(true);
    expect(seen.size, "one direction array serves every sample").toBe(1);
    const first = bake.polynomial();
    // A second bake over the same face arrays gives the same answer.
    bake.begin(field, 8);
    expect(bake.done).toBe(false);
    expect(() => bake.polynomial()).toThrow();
    while (!bake.advance(0)) { /* slice */ }
    expectBitIdentical(bake.polynomial(), first, "reused faces");
    expectBitIdentical(first, referenceOneShotBake(field, 8), "reference");
  });
});

describe("F1 — the probe's refresh decision", () => {
  const DRIFT = SKY_PROBE_REBAKE_ALTITUDE_METERS + 1;

  it("follows the truth table", () => {
    // [stale, drifted, inProgress, synchronous] → action.
    const table: readonly [boolean, boolean, boolean, boolean, SkyProbeRefreshAction][] = [
      [false, false, false, false, "none"],
      [false, true, false, false, "begin"],
      [false, false, true, false, "advance"],
      [false, true, true, false, "advance"],
      [true, false, false, false, "sync"],
      [true, true, false, false, "sync"],
      [true, false, true, false, "sync"],
      [true, true, true, false, "sync"],
      [false, false, false, true, "none"],
      [false, true, false, true, "sync"],
      [false, false, true, true, "sync"],
      [false, true, true, true, "sync"],
      [true, false, false, true, "sync"],
      [true, true, false, true, "sync"],
      [true, false, true, true, "sync"],
      [true, true, true, true, "sync"],
    ];
    expect(table).toHaveLength(16);
    for (const [stale, drifted, inProgress, synchronous, action] of table) {
      for (const sign of [1, -1]) {
        const altitudeDeltaMeters = drifted ? sign * DRIFT : sign * 10;
        expect(
          skyProbeRefreshAction({ stale, altitudeDeltaMeters, inProgress, synchronous }),
          JSON.stringify({ stale, altitudeDeltaMeters, inProgress, synchronous }),
        ).toBe(action);
      }
    }
  });

  it("re-lights past 500 m of drift either way, as the renderer always has", () => {
    const idle = { stale: false, inProgress: false, synchronous: false };
    expect(SKY_PROBE_REBAKE_ALTITUDE_METERS).toBe(500);
    expect(skyProbeRefreshAction({ ...idle, altitudeDeltaMeters: 500 })).toBe("none");
    expect(skyProbeRefreshAction({ ...idle, altitudeDeltaMeters: -500 })).toBe("none");
    expect(skyProbeRefreshAction({ ...idle, altitudeDeltaMeters: 500.001 })).toBe("begin");
    expect(skyProbeRefreshAction({ ...idle, altitudeDeltaMeters: -500.001 })).toBe("begin");
    expect(skyProbeRefreshAction({ ...idle, altitudeDeltaMeters: Number.NaN })).toBe("none");
    expect(skyProbeRefreshAction({ ...idle, synchronous: true, altitudeDeltaMeters: 500.001 }))
      .toBe("sync");
  });
});
