import { describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import { HORIZON_FIELD_LOOKUP_WGSL } from "../../src/render/webgpu/terrain/HorizonField";

/**
 * `6-11`: what the horizon term DOES, evaluated on a real adapter.
 *
 * Everything else for this item is adjacent to the question. The bake matches
 * a CPU oracle; the define and the shared lookup reach the compiled shader;
 * the field arms through the real pump. None of that shows the operator
 * returning a number that darkens anything — and the same-host A/B capture
 * could not either: it moved no pixels, which is equally consistent with
 * "correctly inert on this shot set" and with "the shot set frames none of
 * the geometry". **The capture bounds the COST. This file bounds the
 * BEHAVIOUR**, and the two claims must not be allowed to stand in for each
 * other.
 *
 * It evaluates the SHIPPED text — `HORIZON_FIELD_LOOKUP_WGSL`, the exact
 * string both fragment consumers compose, asserted by the source scan in
 * `tests/render.webgpu-horizon-field.test.ts` — over a matrix of (horizon,
 * sun) pairs, on the GPU, at f32. A CPU transliteration would be a different
 * program.
 */

const WGSL = /* wgsl */ `
struct Probe {
  // (packed horizon value for every azimuth, sun sin, band, jitter)
  input: vec4f,
};

@group(0) @binding(0) var<storage, read> probes: array<Probe>;
@group(0) @binding(1) var<storage, read_write> results: array<f32>;

${HORIZON_FIELD_LOOKUP_WGSL}

@compute @workgroup_size(64, 1, 1)
fn probeHorizon(@builtin(global_invocation_id) id: vec3<u32>) {
  let probe = probes[id.x];
  let packed = vec4f(probe.input.x);
  // The sun is placed at a fixed azimuth with the requested elevation, so the
  // uniform packed field means the azimuth interpolation cannot change the
  // answer and the test measures the elevation comparison alone.
  let horizontal = sqrt(max(0.0, 1.0 - probe.input.y * probe.input.y));
  let sun = vec3f(horizontal, probe.input.y, 0.0);
  results[id.x] = horizonFieldShadow(packed, packed, sun, probe.input.z, probe.input.w);
}
`;

interface Probe {
  readonly label: string;
  readonly horizonSin: number;
  readonly sunSin: number;
}

/** Sun elevations measured from the capture shots' own clocks at 45N. */
const DUSK_SUN = 0.2475; // hills-dusk-glint, 14.33 deg
const LOW_SUN = 0.1135; // coast-10km-lowsun, 6.52 deg
const HIGH_SUN = 0.7961; // canopy-1200ft, 52.75 deg

const PROBES: readonly Probe[] = [
  { label: "flat ground, dusk sun", horizonSin: 0.0, sunSin: DUSK_SUN },
  { label: "low ridge below dusk sun", horizonSin: 0.10, sunSin: DUSK_SUN },
  { label: "ridge AT the dusk sun", horizonSin: DUSK_SUN, sunSin: DUSK_SUN },
  { label: "ridge above dusk sun", horizonSin: 0.45, sunSin: DUSK_SUN },
  { label: "mountain above dusk sun", horizonSin: 0.90, sunSin: DUSK_SUN },
  { label: "mountain vs LOW sun", horizonSin: 0.90, sunSin: LOW_SUN },
  // The control pair. NOTE the arithmetic, because the first version of this
  // test got it wrong and the test caught it: a "mountain" at sin 0.90 stands
  // at 64.2 deg, so a 52.75 deg midday sun does NOT clear it and is correctly
  // shadowed. To exercise the sun-clears-horizon branch the sun must exceed
  // the horizon by more than the band, so the pairs below are chosen to.
  { label: "ridge below HIGH sun", horizonSin: 0.45, sunSin: HIGH_SUN },
  { label: "mountain below zenith sun", horizonSin: 0.90, sunSin: 0.99 },
  { label: "flat ground, high sun", horizonSin: 0.0, sunSin: HIGH_SUN },
  { label: "sun below the horizontal", horizonSin: 0.0, sunSin: -0.2 },
];

const BAND = 0.05; // DETAIL_HORIZON_SOFT_BAND
const JITTER = 0.5; // the jitter's neutral centre, so the band is symmetric

describe("far-field horizon shadow operator (6-11)", () => {
  it("returns sun visibility that actually tracks the horizon", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, {
      antialias: false, enableAllFeatures: false, setMaximumLimits: false,
    });
    await engine.initAsync();
    engine.runRenderLoop(() => {});
    const scene = new Scene(engine);

    const count = PROBES.length;
    const input = new Float32Array(count * 4);
    PROBES.forEach((probe, index) => {
      input[index * 4] = probe.horizonSin;
      input[index * 4 + 1] = probe.sunSin;
      input[index * 4 + 2] = BAND;
      input[index * 4 + 3] = JITTER;
    });
    const probeBuffer = new StorageBuffer(engine, input.byteLength);
    probeBuffer.update(new Uint8Array(input.buffer));
    const resultBuffer = new StorageBuffer(engine, count * 4);
    const shader = new ComputeShader(
      "horizon-shadow-probe",
      engine,
      { computeSource: WGSL },
      {
        entryPoint: "probeHorizon",
        bindingsMapping: {
          probes: { group: 0, binding: 0 },
          results: { group: 0, binding: 1 },
        },
      },
    );
    shader.setStorageBuffer("probes", probeBuffer);
    shader.setStorageBuffer("results", resultBuffer);
    await shader.dispatchWhenReady(1, 1, 1);
    // `noDelay`: a plain read defers to the next frame's submit, so with no
    // render loop pumping frames the dispatch never lands and the buffer reads
    // back as ZEROS rather than as data — which here would decode as "fully
    // shadowed everywhere" and pass half the assertions below for free.
    const raw = await resultBuffer.read(0, undefined, undefined, true);
    const values = new Float32Array(raw.buffer, raw.byteOffset, count);
    const by = new Map<string, number>();
    PROBES.forEach((probe, index) => {
      by.set(probe.label, values[index]!);
      // eslint-disable-next-line no-console
      console.log(`HORIZON-OP ${probe.label.padEnd(26)} -> ${values[index]!.toFixed(4)}`);
    });

    const get = (label: string) => by.get(label)!;

    // Non-vacuity: an all-zero readback would make every "is shadowed"
    // assertion pass trivially. Flat ground under a sun must be FULLY lit.
    expect(get("flat ground, dusk sun"), "flat ground is not fully lit").toBeCloseTo(1, 5);
    expect(get("flat ground, high sun")).toBeCloseTo(1, 5);

    // THE claim: a horizon above the sun darkens direct light, hard.
    expect(get("mountain above dusk sun"), "a mountain does not shadow the dusk sun")
      .toBeLessThan(0.01);
    expect(get("ridge above dusk sun")).toBeLessThan(0.01);
    expect(get("mountain vs LOW sun")).toBeLessThan(0.01);

    // The control that makes the claim mean something: the same terrain must
    // NOT shadow a sun that clears it. Without this, a term that ignored the
    // sun entirely would pass everything above. Both pairs put the sun more
    // than one band above the horizon.
    expect(get("ridge below HIGH sun"), "the term is not gated on sun elevation")
      .toBeCloseTo(1, 5);
    expect(get("mountain below zenith sun")).toBeCloseTo(1, 5);
    // And the discriminator that proves the gate is the COMPARISON rather than
    // the horizon's magnitude: the same 0.90 horizon is black under the dusk
    // sun and fully lit under the zenith sun.
    expect(get("mountain above dusk sun")).toBeLessThan(0.01);
    expect(get("mountain below zenith sun")).toBeGreaterThan(0.99);

    // A ridge exactly AT the sun sits mid-band — neither lit nor black. This
    // is what makes the terminator a soft penumbra instead of fix-pack T8's
    // banded iso-contour.
    const grazing = get("ridge AT the dusk sun");
    expect(grazing).toBeGreaterThan(0.3);
    expect(grazing).toBeLessThan(0.7);

    // Monotone in the horizon: more terrain in the way is never more light.
    expect(get("low ridge below dusk sun")).toBeGreaterThanOrEqual(grazing);
    expect(grazing).toBeGreaterThanOrEqual(get("ridge above dusk sun"));

    // Below the horizontal the term returns 1 and contributes nothing: the sun
    // lobe it multiplies is already zero, and darkening ambient as well would
    // double-count one occluder. Phase 7 owns night; this must not reach it.
    expect(get("sun below the horizontal"), "the term must be inert below the horizon")
      .toBeCloseTo(1, 5);

    probeBuffer.dispose();
    resultBuffer.dispose();
    scene.dispose();
    engine.stopRenderLoop();
    engine.dispose();
    canvas.remove();
  }, 120_000);
});
