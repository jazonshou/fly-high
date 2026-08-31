import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
// Side-effect import: registers the compute pipeline methods on WebGPUEngine.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  WATER_CAPILLARY_DETAIL_WGSL,
  WATER_CAUSTIC_WGSL,
  WATER_DETAIL_NOISE_WGSL,
  WATER_SHOAL_DEPTH_GATE_METERS,
  WATER_SHOAL_MAXIMUM_SLOPE_GAIN,
  WATER_SHOALING_WGSL,
  WATER_SHORE_RUNUP_WGSL,
  WATER_SHORE_STREAK_WGSL,
  waterBreakerIndex,
  waterLinearDispersion,
  waterShelfShoaling,
  waterShoalDepthGate,
  waterShoalingBand,
  waterShoalingCoefficient,
  waterShoreBandSwell,
} from "../../src/render/webgpu/water/WaterShaders";

/**
 * 6-3 — shelf shoaling and depth-limited breaking: TS/WGSL parity on a real
 * adapter, plus the claims a Node test cannot make about the shipped shader
 * text.
 *
 * Same split as `water-shore-runup.test.ts`, `water-caustics.test.ts` and
 * `water-channel-flow.test.ts`: `WATER_SHOALING_WGSL` declares no uniform,
 * samples no texture and takes no derivative, so the shipped block runs here
 * as a compute kernel over 6-2's swell descriptor and the exported TypeScript
 * functions are the oracle.
 *
 * The claims this file owns:
 *  - PARITY, statement for statement, on the hardware's own f32 — including
 *    the two `tanh` calls and the Newton step, which is where an f32/f64
 *    divergence would actually live.
 *  - THE DISPERSION RELATION, measured ON THE GPU. The residual
 *    `kh tanh(kh) - k0 h` is computed in the shader from the shader's own root
 *    and returned, so the plan's "spot checks vs tanh(k*depth)" pin is a
 *    hardware measurement rather than a restatement of the TypeScript.
 *  - THE DEPTH CAP, on hardware, across a depth sweep: the surviving height
 *    never exceeds `gamma h`, and it reaches it in the shallow limit.
 *  - THE 60 M GATE, on hardware: exact zeros beyond it, no epsilon.
 *  - NO OVERFLOW at the relative depths the finest cascade reaches at the
 *    gate, where a literal `sinh(2 kh)` returns `inf` and the group ratio
 *    would be `NaN`.
 *  - THE COMPOSED FRAGMENT COMPILES AND MAKES A PIPELINE, in the shipped call
 *    shape — Tint accepts WGSL other back ends reject, so pipeline creation is
 *    the real gate.
 */

/** Five vec4 lanes, then eight scalars: 28 floats, 112 bytes, 16-aligned. */
const SHELF_PROBE_FLOATS = 28;
const SHELF_RESULT_FLOATS = 16;

const SHELF_PROBE_WGSL = /* wgsl */ `
${WATER_SHORE_RUNUP_WGSL}

${WATER_SHOALING_WGSL}

struct ShelfProbe {
  wavelengths: vec4f,
  meanSquareSlopes: vec4f,
  fades: vec4f,
  slopesX: vec4f,
  slopesZ: vec4f,
  wavelength4: f32,
  meanSquareSlope4: f32,
  fade4: f32,
  slope4x: f32,
  slope4z: f32,
  depthMeters: f32,
  beachSlope: f32,
  padding: f32,
}

@group(0) @binding(0) var<storage, read> probes: array<ShelfProbe>;
@group(0) @binding(1) var<storage, read_write> results: array<vec4f>;

@compute @workgroup_size(16, 1, 1)
fn evaluateShelf(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes)) { return; }
  let probe = probes[id.x];
  let shelf = waterShelfShoaling(
    probe.wavelengths,
    probe.wavelength4,
    probe.meanSquareSlopes,
    probe.meanSquareSlope4,
    probe.fades,
    probe.fade4,
    probe.slopesX,
    probe.slopesZ,
    vec2f(probe.slope4x, probe.slope4z),
    probe.depthMeters,
    probe.beachSlope,
  );
  // The probe band is lane z — the 64 m swell in the shipped cascade set, and
  // the band that wins 6-2's own dominant-band argmax for a wind sea.
  let probeSwell = waterShoreBandSwell(probe.wavelengths.z, probe.meanSquareSlopes.z);
  let band = waterShoalingBand(probeSwell, probe.depthMeters, probe.beachSlope);
  let relativeDeepDepth = WATER_RUNUP_TWO_PI * max(probe.depthMeters, 0.0)
    / max(probe.wavelengths.z, WATER_RUNUP_MINIMUM_WAVELENGTH);
  let dispersion = waterLinearDispersion(relativeDeepDepth);
  results[id.x * 4u] = vec4f(
    shelf.slopeDelta.x,
    shelf.slopeDelta.y,
    shelf.whitewater,
    shelf.weight,
  );
  results[id.x * 4u + 1u] = vec4f(
    band.breakerIndex,
    band.wavenumberGain,
    band.shoalingCoefficient,
    band.whitewater,
  );
  results[id.x * 4u + 2u] = vec4f(
    band.heightGain,
    band.slopeGain,
    dispersion.relativeDepth,
    dispersion.groupSpeedRatio,
  );
  // The dispersion residual, formed on the GPU from the GPU's own root: this
  // is the plan's pin, measured rather than restated.
  results[id.x * 4u + 3u] = vec4f(
    waterShoalDepthGate(probe.depthMeters),
    dispersion.tanhRelativeDepth,
    relativeDeepDepth,
    // A FRESH tanh of the shader's own root, not the linearised one the
    // struct carries — so this measures the dispersion relation rather than
    // the linearisation's self-consistency. The argument is capped for the
    // same overflow reason the solver's are.
    dispersion.relativeDepth
      * tanh(min(dispersion.relativeDepth, WATER_SHOAL_MAXIMUM_TANH_ARGUMENT))
      - relativeDeepDepth,
  );
}
`;

interface ShelfProbe {
  readonly label: string;
  readonly wavelengths: readonly [number, number, number, number, number];
  readonly meanSquareSlopes: readonly [number, number, number, number, number];
  readonly fades: readonly [number, number, number, number, number];
  readonly cascadeSlopes: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
  readonly depthMeters: number;
  readonly beachSlope: number;
}

/** The shipped cascade set's representative wavelengths, sqrt(min*max). */
const SHIPPED_WAVELENGTHS = [2, 16, 64, 256, 1024] as const;
/** The same 12 m/s wind sea 6-2's suites use — one sea state, both items. */
const WIND_SEA_MSS = [0.03, 0.015, 0.004, 0.0002, 0.0000002] as const;
const CASCADE_SLOPES = [
  [0.12, -0.05],
  [0.09, 0.04],
  [0.05, -0.02],
  [0.01, 0.005],
  [0.001, 0],
] as const;

function shelfProbe(label: string, overrides: Partial<ShelfProbe> = {}): ShelfProbe {
  return {
    label,
    wavelengths: SHIPPED_WAVELENGTHS,
    meanSquareSlopes: WIND_SEA_MSS,
    fades: [1, 1, 1, 1, 1],
    cascadeSlopes: CASCADE_SLOPES,
    depthMeters: 2.4,
    beachSlope: 0.06,
    ...overrides,
  };
}

/**
 * Six decades of depth. The shallow end is the last centimetre of the swash
 * zone; 1500 is where the finest cascade's relative depth reaches the value
 * that makes a literal `sinh(2 kh)` overflow to `inf`.
 */
const DEPTH_SWEEP = [
  0, 0.05, 0.15, 0.4, 0.8, 1.2, 1.8, 2.4, 3.2, 4.5, 6, 8, 12, 18, 26, 36, 44, 48, 54, 59.5,
] as const;
/** Past the gate, where every output must be an exact zero. */
const BEYOND_GATE = [60, 61, 90, 250, 1500] as const;
const SLOPE_SWEEP = [0, 0.004, 0.012, 0.036, 0.06, 0.1, 0.16, 0.24, 0.35, 1.4] as const;

const SHELF_PROBES: readonly ShelfProbe[] = [
  // --- the depth sweep, at the shipped sea state ---
  ...DEPTH_SWEEP.map((depthMeters) => shelfProbe(`depth ${depthMeters}`, { depthMeters })),
  ...BEYOND_GATE.map((depthMeters) => shelfProbe(`beyond ${depthMeters}`, { depthMeters })),
  // --- the breaker index's slope dependence ---
  ...SLOPE_SWEEP.map((beachSlope) => shelfProbe(`slope ${beachSlope}`, { beachSlope })),
  // --- sea state: the surf line has to move with it ---
  ...[0.25, 1, 4].flatMap((scale) => [1.2, 2.4, 6, 12].map((depthMeters) => shelfProbe(
    `sea ${scale} depth ${depthMeters}`,
    {
      depthMeters,
      meanSquareSlopes: WIND_SEA_MSS.map((value) => value * scale * scale) as unknown as
        readonly [number, number, number, number, number],
    },
  ))),
  // --- degenerate inputs ---
  shelfProbe("glassy sea", { meanSquareSlopes: [0, 0, 0, 0, 0] }),
  shelfProbe("two-cascade profile", {
    wavelengths: [2, 16, 0, 0, 0],
    meanSquareSlopes: [0.03, 0.015, 0, 0, 0],
    cascadeSlopes: [[0.12, -0.05], [0.09, 0.04], [0, 0], [0, 0], [0, 0]],
  }),
  shelfProbe("faded to nothing", { fades: [0, 0, 0, 0, 0] }),
  shelfProbe("swell band faded", { fades: [1, 1, 0, 1, 1] }),
  shelfProbe("at the waterline", { depthMeters: 0 }),
  shelfProbe("cliff", { beachSlope: 4 }),
  shelfProbe("mudflat", { beachSlope: 0 }),
  shelfProbe("storm sea in the shallows", {
    depthMeters: 0.6,
    meanSquareSlopes: [0.12, 0.06, 0.05, 0.004, 0.00002],
  }),
];

async function runCompute(
  source: string,
  entryPoint: string,
  probeData: Float32Array,
  probeFloats: number,
  resultFloats: number,
): Promise<Float32Array> {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, { antialias: false });
  await engine.initAsync();
  try {
    const probeBuffer = new StorageBuffer(engine, probeData.byteLength);
    probeBuffer.update(probeData);
    const resultBuffer = new StorageBuffer(
      engine,
      resultFloats * Float32Array.BYTES_PER_ELEMENT,
    );
    const shader = new ComputeShader(
      `water-shelf-${entryPoint}`,
      engine,
      { computeSource: source },
      {
        bindingsMapping: {
          probes: { group: 0, binding: 0 },
          results: { group: 0, binding: 1 },
        },
        entryPoint,
      },
    );
    shader.setStorageBuffer("probes", probeBuffer);
    shader.setStorageBuffer("results", resultBuffer);
    // Compute submissions and readbacks resolve at frame boundaries, so drive
    // an empty render loop while awaiting them.
    engine.runRenderLoop(() => {});
    await shader.dispatchWhenReady(
      Math.ceil((probeData.length / probeFloats) / 16) || 1,
      1,
      1,
    );
    expect(shader.isReady()).toBe(true);
    const view = await resultBuffer.read();
    engine.stopRenderLoop();
    const results = new Float32Array(
      view.buffer.slice(view.byteOffset, view.byteOffset + resultFloats * 4),
    );
    probeBuffer.dispose();
    resultBuffer.dispose();
    return results;
  } finally {
    engine.dispose();
    canvas.remove();
  }
}

describe("6-3 shelf shoaling WGSL/TS parity", () => {
  it("agrees with the oracle, solves the dispersion relation, and enforces the cap", async () => {
    const probeData = new Float32Array(SHELF_PROBES.length * SHELF_PROBE_FLOATS);
    SHELF_PROBES.forEach((probe, index) => {
      const base = index * SHELF_PROBE_FLOATS;
      for (let lane = 0; lane < 4; lane += 1) {
        probeData[base + lane] = probe.wavelengths[lane]!;
        probeData[base + 4 + lane] = probe.meanSquareSlopes[lane]!;
        probeData[base + 8 + lane] = probe.fades[lane]!;
        probeData[base + 12 + lane] = probe.cascadeSlopes[lane]![0];
        probeData[base + 16 + lane] = probe.cascadeSlopes[lane]![1];
      }
      probeData[base + 20] = probe.wavelengths[4]!;
      probeData[base + 21] = probe.meanSquareSlopes[4]!;
      probeData[base + 22] = probe.fades[4]!;
      probeData[base + 23] = probe.cascadeSlopes[4]![0];
      probeData[base + 24] = probe.cascadeSlopes[4]![1];
      probeData[base + 25] = probe.depthMeters;
      probeData[base + 26] = probe.beachSlope;
      probeData[base + 27] = 0;
    });
    const results = await runCompute(
      SHELF_PROBE_WGSL,
      "evaluateShelf",
      probeData,
      SHELF_PROBE_FLOATS,
      SHELF_PROBES.length * SHELF_RESULT_FLOATS,
    );
    const fieldsOf = (label: string): readonly number[] => {
      const index = SHELF_PROBES.findIndex((probe) => probe.label === label);
      expect(index, `probe ${label}`).toBeGreaterThanOrEqual(0);
      return Array.from(results.subarray(
        index * SHELF_RESULT_FLOATS,
        (index + 1) * SHELF_RESULT_FLOATS,
      ));
    };

    // 1. Statement-for-statement parity with the exported oracle, every lane
    //    but the residual (which is a cancellation of two ~equal numbers and
    //    is therefore a bound, not a value — it is checked as one in 2).
    const names = [
      "slopeDeltaX", "slopeDeltaZ", "whitewater", "weight",
      "breakerIndex", "wavenumberGain", "shoalingCoefficient", "bandWhitewater",
      "heightGain", "slopeGain", "relativeDepth", "groupSpeedRatio",
      "gate", "tanhRelativeDepth", "relativeDeepDepth", "dispersionResidual",
    ] as const;
    SHELF_PROBES.forEach((probe, index) => {
      const shelf = waterShelfShoaling(
        probe.wavelengths,
        probe.meanSquareSlopes,
        probe.fades,
        probe.cascadeSlopes,
        probe.depthMeters,
        probe.beachSlope,
      );
      const band = waterShoalingBand(
        waterShoreBandSwell(probe.wavelengths[2]!, probe.meanSquareSlopes[2]!),
        probe.depthMeters,
        probe.beachSlope,
      );
      const relativeDeepDepth = (2 * Math.PI * Math.max(probe.depthMeters, 0))
        / Math.max(probe.wavelengths[2]!, 0.25);
      const dispersion = waterLinearDispersion(relativeDeepDepth);
      const oracle = [
        shelf.slopeDelta[0], shelf.slopeDelta[1], shelf.whitewater, shelf.weight,
        band.breakerIndex, band.wavenumberGain, band.shoalingCoefficient, band.whitewater,
        band.heightGain, band.slopeGain, dispersion.relativeDepth, dispersion.groupSpeedRatio,
        waterShoalDepthGate(probe.depthMeters), dispersion.tanhRelativeDepth, relativeDeepDepth,
      ];
      for (let lane = 0; lane < oracle.length; lane += 1) {
        const gpu = results[index * SHELF_RESULT_FLOATS + lane]!;
        const cpu = oracle[lane]!;
        expect(
          Number.isFinite(gpu),
          `${probe.label} ${names[lane]} is not finite: ${gpu}`,
        ).toBe(true);
        // f32 against f64. The chain runs two `tanh`, one `pow`, one `exp` and
        // three roots, and the Newton step amplifies the seed's own quantum by
        // its condition number, so 3e-4 relative is the honest bound rather
        // than a blanket fudge — the physics assertions below all hold far
        // inside it.
        const tolerance = Math.max(Math.abs(cpu), 1) * 3e-4;
        expect(
          Math.abs(gpu - cpu),
          `${probe.label} ${names[lane]}: gpu ${gpu} vs oracle ${cpu}`,
        ).toBeLessThan(tolerance);
      }
    });

    // 2. THE DISPERSION RELATION, measured on the GPU from the GPU's own root.
    //    This is the plan's pin: every solved `kh` satisfies
    //    `kh tanh(kh) = omega^2 h/g = k0 h` to better than 1e-3 relative,
    //    which Eckart's seed alone (5% off near kh = 1) could not do.
    let worstResidual = 0;
    let worstLabel = "";
    for (const probe of SHELF_PROBES) {
      const fields = fieldsOf(probe.label);
      const relativeDeepDepth = fields[14]!;
      if (relativeDeepDepth < 1e-3) continue;
      const relative = Math.abs(fields[15]!) / relativeDeepDepth;
      if (relative > worstResidual) {
        worstResidual = relative;
        worstLabel = probe.label;
      }
    }
    expect(worstResidual, `worst GPU dispersion residual at ${worstLabel}`).toBeLessThan(1e-3);
    // ...and the measurement can fail: it is a real residual on a real root,
    // not a constant zero.
    expect(worstResidual).toBeGreaterThan(0);

    // 3. NO OVERFLOW. At 1500 m the finest cascade's relative depth is ~37,700
    //    and a literal `2 kh/sinh(2 kh)` is `inf/inf`; the tanh rewrite returns
    //    the exact deep-water limit instead. Every lane of every probe is
    //    finite (asserted in 1), and the deep limit is exact here.
    for (const depthMeters of BEYOND_GATE) {
      const fields = fieldsOf(`beyond ${depthMeters}`);
      expect(fields[11], `beyond ${depthMeters} group ratio`).toBeGreaterThanOrEqual(0.5);
      expect(fields[11], `beyond ${depthMeters} group ratio`).toBeLessThan(0.5002);
      expect(fields[6], `beyond ${depthMeters} shoaling coefficient`).toBeCloseTo(1, 3);
      expect(fields[5], `beyond ${depthMeters} wavenumber gain`).toBeCloseTo(1, 3);
    }
    // At the deepest probes the relative depth is far past the tanh cap, where
    // a NaN would have been produced before the cap existed: the group ratio
    // is EXACTLY the deep-water 1/2 and the two gains are exactly 1.
    for (const depthMeters of [250, 1500] as const) {
      const fields = fieldsOf(`beyond ${depthMeters}`);
      expect(fields[11], `beyond ${depthMeters} exact deep limit`).toBe(0.5);
      expect(fields[5], `beyond ${depthMeters} exact wavenumber gain`).toBeCloseTo(1, 6);
      expect(fields[6], `beyond ${depthMeters} exact shoaling`).toBeCloseTo(1, 6);
    }

    // 4. THE 60 M GATE, on the hardware: exact zeros, no epsilon, so open
    //    water is untouched by construction rather than by a small number.
    for (const depthMeters of BEYOND_GATE) {
      const fields = fieldsOf(`beyond ${depthMeters}`);
      expect(Math.abs(fields[0]!), `beyond ${depthMeters} slopeDeltaX`).toBe(0);
      expect(Math.abs(fields[1]!), `beyond ${depthMeters} slopeDeltaZ`).toBe(0);
      expect(fields[2], `beyond ${depthMeters} whitewater`).toBe(0);
      expect(fields[12], `beyond ${depthMeters} gate`).toBe(0);
    }
    expect(WATER_SHOAL_DEPTH_GATE_METERS).toBe(60);
    // And inside it the gate is fully open well before the surf zone.
    expect(fieldsOf("depth 8")[12]).toBe(1);
    expect(fieldsOf("depth 44")[12]).toBe(1);
    expect(fieldsOf("depth 54")[12]).toBeGreaterThan(0);
    expect(fieldsOf("depth 54")[12]).toBeLessThan(1);

    // 5. THE DEPTH CAP, on hardware. The surviving height of the probe band
    //    never exceeds `gamma h`, and it reaches it in the shallow limit —
    //    the depth limit is enforced identically, not approximately.
    const probeHeight = waterShoreBandSwell(64, 0.004).waveHeightMeters;
    for (const depthMeters of DEPTH_SWEEP) {
      const fields = fieldsOf(`depth ${depthMeters}`);
      const surviving = probeHeight * fields[8]!;
      const limit = fields[4]! * depthMeters;
      // `H sqrt(1 - e^(-R^2)) <= H R = gamma h` is an identity in exact
      // arithmetic — the Node suite pins it at 1e-12 in f64 — so what is
      // measured here is how tightly f32 holds it. Worst observed breach is
      // 4e-4 relative, at the shallowest probe where `1 - e^(-R^2)` is a
      // cancellation; 1e-3 is the honest bound.
      expect(surviving, `depth ${depthMeters} cap`)
        .toBeLessThanOrEqual(limit * 1.001 + 1e-6);
    }
    expect(probeHeight * fieldsOf("depth 0.05")[8]!)
      .toBeCloseTo(fieldsOf("depth 0.05")[4]! * 0.05, 4);
    // Offshore the band is untouched to within 0.2% and breaks nothing. It is
    // not exactly 1 and should not be: at 44 m the 64 m swell is at kh = 4.3,
    // the far tail of the shoaling dip, where the coefficient is genuinely
    // 0.9987. The gate is what makes deep water exact, not the physics.
    expect(fieldsOf("depth 44")[8]).toBeGreaterThan(0.99);
    expect(fieldsOf("depth 44")[8]).toBeLessThanOrEqual(1);
    expect(fieldsOf("depth 44")[7]).toBeLessThan(1e-5);

    // 6. THE SHOALING ARC, on hardware. The coefficient dips below 1 in the
    //    transitional band before Green's law takes it up, and the SLOPE gain
    //    peaks inside the surf zone and then collapses as the wave breaks.
    expect(fieldsOf("depth 18")[6], "shoaling dip").toBeLessThan(1);
    expect(fieldsOf("depth 18")[6]).toBeGreaterThan(0.9);
    expect(fieldsOf("depth 0.4")[6], "Green's law tail").toBeGreaterThan(1.5);
    const slopeGain = (depthMeters: number): number => fieldsOf(`depth ${depthMeters}`)[9]!;
    expect(slopeGain(44)).toBeCloseTo(1, 2);
    expect(slopeGain(3.2)).toBeGreaterThan(1.5);
    expect(slopeGain(3.2)).toBeGreaterThan(slopeGain(0.8));
    expect(slopeGain(0.15)).toBeLessThan(0.6);
    for (const depthMeters of DEPTH_SWEEP) {
      expect(
        fieldsOf(`depth ${depthMeters}`)[9],
        `depth ${depthMeters} slope gain guard`,
      ).toBeLessThanOrEqual(WATER_SHOAL_MAXIMUM_SLOPE_GAIN);
    }

    // 7. THE BREAKER INDEX'S SLOPE DEPENDENCE, on hardware. Monotone
    //    non-decreasing, inside the 0.6-0.9 envelope, and a real 23% spread
    //    between the dissipative and reflective ends.
    let previous = 0;
    for (const beachSlope of SLOPE_SWEEP) {
      const index = fieldsOf(`slope ${beachSlope}`)[4]!;
      expect(index, `slope ${beachSlope} monotone`).toBeGreaterThanOrEqual(previous - 1e-6);
      expect(index, `slope ${beachSlope} envelope`).toBeGreaterThanOrEqual(0.6 - 1e-6);
      expect(index, `slope ${beachSlope} envelope`).toBeLessThanOrEqual(0.9 + 1e-6);
      previous = index;
    }
    expect(fieldsOf("slope 0.24")[4]! / fieldsOf("slope 0.012")[4]!).toBeGreaterThan(1.2);
    // A cliff and a mudflat saturate on 6-2's own Hunt clamps, so both items
    // agree about what counts as a beach.
    expect(fieldsOf("cliff")[4]).toBeCloseTo(fieldsOf("slope 0.35")[4]!, 5);
    expect(fieldsOf("mudflat")[4]).toBeCloseTo(fieldsOf("slope 0.004")[4]!, 5);
    // ...and a steeper beach breaks the same sea NEARER TO SHORE, because a
    // higher index lets the wave survive into shallower water: at a fixed
    // depth the reflective beach is breaking LESS of the band than the
    // dissipative one is. This is the direction that makes a shingle face a
    // narrow plunging shorebreak and a sand flat a wide spilling surf zone.
    expect(fieldsOf("slope 0.24")[7]).toBeLessThan(fieldsOf("slope 0.012")[7]!);

    // 8. THE SURF LINE MOVES WITH THE SEA. A bigger swell breaks further out
    //    — the single most recognisable thing surf does — measured through
    //    the shipped aggregate at four depths and three sea states.
    for (const depthMeters of [1.2, 2.4, 6, 12]) {
      const calm = fieldsOf(`sea 0.25 depth ${depthMeters}`)[2]!;
      const shipped = fieldsOf(`sea 1 depth ${depthMeters}`)[2]!;
      const storm = fieldsOf(`sea 4 depth ${depthMeters}`)[2]!;
      expect(calm, `depth ${depthMeters} calm vs shipped`).toBeLessThanOrEqual(shipped);
      expect(shipped, `depth ${depthMeters} shipped vs storm`).toBeLessThanOrEqual(storm);
    }
    // Concretely: at 6 m of depth the shipped sea is barely breaking and a
    // storm sea is well into it.
    expect(fieldsOf("sea 1 depth 6")[2]).toBeLessThan(0.05);
    expect(fieldsOf("sea 4 depth 6")[2]).toBeGreaterThan(0.4);
    // The aggregate is monotone shoreward, so the surf zone is a band and
    // never a ring.
    let previousWhitewater = -1;
    for (const depthMeters of [...DEPTH_SWEEP].reverse()) {
      const value = fieldsOf(`depth ${depthMeters}`)[2]!;
      expect(value, `whitewater at ${depthMeters}`).toBeGreaterThanOrEqual(previousWhitewater - 1e-6);
      previousWhitewater = value;
    }
    expect(fieldsOf("depth 0.05")[2]).toBeGreaterThan(0.98);

    // 9. DEGENERATE INPUTS. A glassy sea, a two-cascade profile, a fully faded
    //    set and the waterline itself all stay finite and inert where they
    //    should be — these are the inputs the real uniform set can produce.
    expect(fieldsOf("glassy sea")[2], "a glassy sea breaks nothing").toBe(0);
    expect(fieldsOf("glassy sea")[3], "a glassy sea has no visible energy").toBe(0);
    expect(fieldsOf("faded to nothing")[3]).toBe(0);
    expect(fieldsOf("faded to nothing")[2]).toBe(0);
    // A cascade the profile does not run publishes wavelength 0, contributes
    // zero weight, and — because a zero-height band keeps ALL of its zero
    // height — leaves that lane's slope alone rather than erasing it.
    expect(fieldsOf("two-cascade profile")[3]).toBeGreaterThan(0);
    expect(Number.isFinite(fieldsOf("two-cascade profile")[0]!)).toBe(true);
    // Fading the swell band moves the aggregate, because the weight it is
    // normalised by is 6-2's own visible-amplitude-squared.
    expect(fieldsOf("swell band faded")[3]).toBeLessThan(fieldsOf("depth 2.4")[3]!);
  });

  it("compiles into the ocean's fragment stage in the shipped call shape", async () => {
    const adapter = await navigator.gpu.requestAdapter();
    expect(adapter).not.toBeNull();
    const device = await adapter!.requestDevice();
    try {
      // The shelf block alone, over 6-2's descriptor: this is the composition
      // order the ocean uses, and if the shelf ever grew a dependency on the
      // noise lattice or a uniform, this compile fails first.
      const standalone = /* wgsl */ `
${WATER_SHORE_RUNUP_WGSL}

${WATER_SHOALING_WGSL}

@compute @workgroup_size(1, 1, 1)
fn shelfOnly() {
  let shelf = waterShelfShoaling(
    vec4f(2.0, 16.0, 64.0, 256.0), 1024.0,
    vec4f(0.03, 0.015, 0.004, 0.0002), 0.0000002,
    vec4f(1.0), 1.0,
    vec4f(0.12, 0.09, 0.05, 0.01), vec4f(-0.05, 0.04, -0.02, 0.005), vec2f(0.001, 0.0),
    2.4,
    0.06,
  );
  _ = shelf.whitewater;
}
`;
      const standaloneModule = device.createShaderModule({ code: standalone });
      const standaloneInfo = await standaloneModule.getCompilationInfo();
      expect(
        standaloneInfo.messages
          .filter((message) => message.type !== "info")
          .map((message) => `${message.type} ${message.lineNum}: ${message.message}`),
      ).toEqual([]);

      // And the ocean's real composition order at FRAGMENT stage, with the
      // shipped shape: the footprint in uniform control flow, the shelf gate
      // wrapping the run-up gate, the slope delta folded into the cascade sum
      // and the whitewater folded into the foam accumulator. Tint accepts WGSL
      // other back ends reject, so the render-pipeline creation below is the
      // real gate.
      const composed = /* wgsl */ `
${WATER_CAUSTIC_WGSL}

${WATER_DETAIL_NOISE_WGSL}

${WATER_CAPILLARY_DETAIL_WGSL}

${WATER_SHORE_RUNUP_WGSL}

${WATER_SHORE_STREAK_WGSL}

${WATER_SHOALING_WGSL}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return vec4f(f32(index) - 1.0, f32(index & 1u) * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let worldXZ = vec2f(212000.0 + position.x * 0.05, -97000.0 + position.y * 0.05);
  let derivativeX = dpdx(worldXZ);
  let derivativeY = dpdy(worldXZ);
  let footprint = max(
    min(length(derivativeX), length(derivativeY)),
    max(length(derivativeX), length(derivativeY)) * 0.0625,
  );
  let depth = abs(position.y) * 0.05;
  var slopeSum = vec2f(0.27, -0.025);
  var foamAmount = 0.04;
  var modulation = 1.0;
  var shelfWhitewater = 0.0;
  if (depth < WATER_SHOAL_DEPTH_GATE_METERS) {
    let bedSlope = vec2f(0.03, -0.02);
    let beachSlope = length(bedSlope);
    let shoreNormal = -normalize(bedSlope + vec2f(0.00001, 0.0));
    let swell = waterDominantShoreSwell(
      vec4f(2.0, 16.0, 64.0, 256.0), 1024.0,
      vec4f(0.03, 0.015, 0.004, 0.0002), 0.0000002,
      vec4f(1.0), 1.0,
    );
    let shelf = waterShelfShoaling(
      vec4f(2.0, 16.0, 64.0, 256.0), 1024.0,
      vec4f(0.03, 0.015, 0.004, 0.0002), 0.0000002,
      vec4f(1.0), 1.0,
      vec4f(0.12, 0.09, 0.05, 0.01), vec4f(-0.05, 0.04, -0.02, 0.005), vec2f(0.001, 0.0),
      depth,
      beachSlope,
    );
    slopeSum += shelf.slopeDelta;
    shelfWhitewater = shelf.whitewater;
    let gate = 1.0 - smoothstep(
      WATER_RUNUP_DEPTH_FADE_START_METERS,
      WATER_RUNUP_DEPTH_GATE_METERS,
      depth,
    );
    if (gate > 0.001) {
      let phase = waterShoreRunupPhase(depth, beachSlope, swell.radianFrequency, 12.5);
      let crestSpacing = WATER_RUNUP_TWO_PI
        * sqrt(WATER_RUNUP_GRAVITY * max(depth, 0.02)) / swell.radianFrequency;
      let resolved = 1.0 - smoothstep(
        crestSpacing * WATER_RUNUP_NYQUIST_FADE_LOW,
        crestSpacing * WATER_RUNUP_NYQUIST_FADE_HIGH,
        footprint,
      );
      let streak = waterShoreStreak(
        waterShoreStreakLattice(
          worldXZ,
          shoreNormal,
          swell.excursionMeters * waterSwashFront(phase),
        ),
        resolved * shelfWhitewater,
      );
      modulation = mix(1.0, waterShoreBore(phase), gate * resolved * shelfWhitewater) * streak;
    }
  }
  foamAmount = max(
    foamAmount,
    shelfWhitewater * WATER_SHOAL_WHITEWATER_COVERAGE * smoothstep(0.0, 1.1, depth),
  );
  return vec4f(modulation, foamAmount, length(slopeSum), 1.0);
}
`;
      const composedModule = device.createShaderModule({ code: composed });
      const composedInfo = await composedModule.getCompilationInfo();
      expect(
        composedInfo.messages
          .filter((message) => message.type !== "info")
          .map((message) => `${message.type} ${message.lineNum}: ${message.message}`),
      ).toEqual([]);
      device.pushErrorScope("validation");
      device.createRenderPipeline({
        layout: "auto",
        vertex: { module: composedModule, entryPoint: "vertexMain" },
        fragment: {
          module: composedModule,
          entryPoint: "fragmentMain",
          targets: [{ format: "rgba8unorm" }],
        },
        primitive: { topology: "triangle-list" },
      });
      expect(await device.popErrorScope()).toBeNull();
    } finally {
      device.destroy();
    }
  });
});

describe("6-3 the closed forms the shader is measured against", () => {
  it("matches Green's law and the textbook shoaling minimum", () => {
    // Kept next to the parity test on purpose: these are the closed forms the
    // hardware assertions above are compared to, so a drift in the oracle is
    // caught here rather than silently agreeing with a drifted shader.
    const exponent = Math.log(
      waterShoalingCoefficient(waterLinearDispersion(1e-2), 1e-2)
      / waterShoalingCoefficient(waterLinearDispersion(1e-3), 1e-3),
    ) / Math.log(10);
    expect(exponent, "Green's law exponent").toBeCloseTo(-0.25, 2);
    let minimum = Number.POSITIVE_INFINITY;
    for (let index = 0; index <= 2000; index += 1) {
      const relativeDeepDepth = 0.1 * Math.exp((index / 2000) * Math.log(100 / 0.1));
      minimum = Math.min(
        minimum,
        waterShoalingCoefficient(waterLinearDispersion(relativeDeepDepth), relativeDeepDepth),
      );
    }
    expect(minimum, "textbook shoaling minimum").toBeCloseTo(0.9129, 2);
    // McCowan's anchor, exactly at an Iribarren number of 1.
    const steepness = waterShoreBandSwell(64, 0.004).waveHeightMeters / 64;
    expect(waterBreakerIndex(Math.sqrt(steepness), steepness)).toBeCloseTo(0.78, 6);
  });
});
