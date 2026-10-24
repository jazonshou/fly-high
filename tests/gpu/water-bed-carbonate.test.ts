import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
// Side-effect import: registers the compute pipeline methods on WebGPUEngine.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { WATER_DEPTH_OPTICS_WGSL } from "../../src/render/webgpu/water/WaterShaders";

/**
 * The tropical coast's reef carbonate is EXACTLY nothing everywhere else.
 *
 * `analyticWaterBedAlbedo` gained a `carbonate` argument (the water
 * environment field's B channel, 0 outside the tropics) and three mixes by
 * it. `mix(a, b, 0)` is `a * 1 + b * 0`, which is `a` to the bit in IEEE
 * arithmetic whichever way a back end lowers it, but that is an argument;
 * this file is the measurement. The SHIPPED function is lifted out of the
 * shipped include and run beside the bed as it stood before the carbonate
 * (pinned verbatim below), with the carbonate read from a storage buffer so
 * no compiler can fold the zero away, and the two must agree to the bit on
 * the hardware's own f32 across depth, wetness and position (within a bound
 * on Metal, which reassociates; see `METAL_REASSOCIATES`). That makes the
 * temperate sea pixel-identical where the back end keeps source order: the
 * field's B channel is an exact 0 there, and everything else the ocean reads
 * is unchanged.
 *
 * It also pins the direction of the change at full weight: a paler bed that
 * stays pale deeper, which is what turns clear shallows turquoise.
 */

/** The bed before the carbonate, verbatim (WaterShaders.ts, W-8b). */
const LEGACY_BED_WGSL = /* wgsl */ `
fn legacyWaterBedAlbedo(worldXZ: vec2f, bedElevation: f32, wetness: f32) -> vec3f {
  let mineral = 0.5 + 0.5 * sin(dot(worldXZ, vec2f(0.021, 0.017)) + bedElevation * 0.08);
  let sand = mix(
    vec3f(0.42, 0.395, 0.315),
    vec3f(0.22, 0.205, 0.145),
    clamp(wetness, 0.0, 1.0),
  );
  let rock = mix(
    vec3f(0.105, 0.125, 0.105),
    vec3f(0.055, 0.080, 0.070),
    clamp(wetness, 0.0, 1.0),
  );
  let deepSilt = vec3f(0.028, 0.055, 0.052);
  let substrate = mix(rock, sand, mineral * 0.32);
  return mix(substrate, deepSilt, smoothstep(8.0, 45.0, -bedElevation));
}
`;

function shippedBedFunction(): string {
  const start = WATER_DEPTH_OPTICS_WGSL.indexOf("fn analyticWaterBedAlbedo(");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = WATER_DEPTH_OPTICS_WGSL.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return WATER_DEPTH_OPTICS_WGSL.slice(start, end + 3);
}

/** xz, bed elevation, wetness, carbonate, padding: 8 floats, 32 bytes. */
const PROBE_FLOATS = 8;
/** Two vec4u per probe: the shipped bed's bits, then the legacy bed's. */
const RESULT_WORDS_PER_PROBE = 8;

function probeSource(): string {
  return /* wgsl */ `
${shippedBedFunction()}
${LEGACY_BED_WGSL}

struct BedProbe {
  worldXZ: vec2f,
  bedElevation: f32,
  wetness: f32,
  carbonate: f32,
  padding0: f32,
  padding1: f32,
  padding2: f32,
}

@group(0) @binding(0) var<storage, read> probes: array<BedProbe>;
@group(0) @binding(1) var<storage, read_write> results: array<vec4u>;

@compute @workgroup_size(64, 1, 1)
fn evaluateBed(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes)) { return; }
  let probe = probes[id.x];
  let shipped = analyticWaterBedAlbedo(
    probe.worldXZ,
    probe.bedElevation,
    probe.wetness,
    probe.carbonate,
  );
  let legacy = legacyWaterBedAlbedo(probe.worldXZ, probe.bedElevation, probe.wetness);
  results[id.x * 2u] = vec4u(bitcast<vec3u>(shipped), 0u);
  results[id.x * 2u + 1u] = vec4u(bitcast<vec3u>(legacy), 0u);
}
`;
}

interface BedProbe {
  readonly x: number;
  readonly z: number;
  readonly bedElevation: number;
  readonly wetness: number;
  readonly carbonate: number;
}

const POSITIONS = [
  [0, 0], [137.5, -912.25], [-4_210, 3_377], [52_000, -18_500], [-91_300.75, 88_004.5],
] as const;
const BED_ELEVATIONS = [0, -0.4, -1.5, -3, -6, -8, -12, -18, -26, -45, -60, -200] as const;
const WETNESSES = [0, 0.18, 0.5, 0.75, 1, 1.3] as const;

function sweep(carbonate: number): BedProbe[] {
  return POSITIONS.flatMap(([x, z]) => BED_ELEVATIONS.flatMap((bedElevation) =>
    WETNESSES.map((wetness) => ({ x, z, bedElevation, wetness, carbonate }))));
}

async function evaluate(probes: readonly BedProbe[]): Promise<Uint32Array> {
  const probeData = new Float32Array(probes.length * PROBE_FLOATS);
  probes.forEach((probe, index) => {
    const base = index * PROBE_FLOATS;
    probeData[base] = probe.x;
    probeData[base + 1] = probe.z;
    probeData[base + 2] = probe.bedElevation;
    probeData[base + 3] = probe.wetness;
    probeData[base + 4] = probe.carbonate;
  });
  const resultWords = probes.length * RESULT_WORDS_PER_PROBE;
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, { antialias: false });
  await engine.initAsync();
  try {
    const probeBuffer = new StorageBuffer(engine, probeData.byteLength);
    probeBuffer.update(probeData);
    const resultBuffer = new StorageBuffer(engine, resultWords * Uint32Array.BYTES_PER_ELEMENT);
    const shader = new ComputeShader(
      "water-bed-carbonate",
      engine,
      { computeSource: probeSource() },
      {
        bindingsMapping: {
          probes: { group: 0, binding: 0 },
          results: { group: 0, binding: 1 },
        },
        entryPoint: "evaluateBed",
      },
    );
    shader.setStorageBuffer("probes", probeBuffer);
    shader.setStorageBuffer("results", resultBuffer);
    // Compute submissions and readbacks resolve at frame boundaries, so drive
    // an empty render loop while awaiting them.
    engine.runRenderLoop(() => {});
    await shader.dispatchWhenReady(Math.ceil(probes.length / 64), 1, 1);
    expect(shader.isReady()).toBe(true);
    const view = await resultBuffer.read();
    engine.stopRenderLoop();
    const results = new Uint32Array(
      view.buffer.slice(view.byteOffset, view.byteOffset + resultWords * 4),
    );
    probeBuffer.dispose();
    resultBuffer.dispose();
    return results;
  } finally {
    engine.dispose();
    canvas.remove();
  }
}

function rgbAt(results: Uint32Array, probe: number, which: "shipped" | "legacy"): number[] {
  const base = probe * RESULT_WORDS_PER_PROBE + (which === "shipped" ? 0 : 4);
  const floats = new Float32Array(results.buffer, results.byteOffset, results.length);
  return [floats[base]!, floats[base + 1]!, floats[base + 2]!];
}

const luminance = ([r, g, b]: number[]) => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;

/**
 * Chrome on macOS runs WebGPU on Metal, whose compiler contracts and
 * reassociates f32 arithmetic (SwiftShader keeps source order). It folds the
 * bed's shared terms (the mineral weight, the sand mix) differently once the
 * function has more uses of them, so two textually different functions that
 * are equal in exact arithmetic can round apart in the last bits even where
 * every carbonate term is `mix(x, y, 0)`. The macOS suite measured 20 of 1,080 channels apart at a
 * carbonate of 0. Metal is held to a bound instead: 1e-4 of albedo is a
 * fortieth of one display level before the water column dims it further, and
 * a leak of 0.001 carbonate would move the bed by about 3e-4. Every other
 * back end keeps source order and must agree to the bit (SwiftShader does).
 */
const METAL_REASSOCIATES = /Macintosh|Mac OS X/.test(navigator.userAgent);
const METAL_BED_TOLERANCE = 1e-4;

describe("tropical coast reef carbonate (GPU)", () => {
  it("leaves the bed unchanged wherever the carbonate is 0 (to the bit off Metal)", async () => {
    const probes = sweep(0);
    const results = await evaluate(probes);
    const mismatches: string[] = [];
    let largestGap = 0;
    probes.forEach((probe, index) => {
      const base = index * RESULT_WORDS_PER_PROBE;
      const shipped = rgbAt(results, index, "shipped");
      const legacy = rgbAt(results, index, "legacy");
      for (let channel = 0; channel < 3; channel += 1) {
        if (results[base + channel] === results[base + 4 + channel]) continue;
        const gap = Math.abs(shipped[channel]! - legacy[channel]!);
        largestGap = Math.max(largestGap, gap);
        if (!METAL_REASSOCIATES || !(gap <= METAL_BED_TOLERANCE)) {
          mismatches.push(
            `(${probe.x}, ${probe.z}) bed ${probe.bedElevation} m wet ${probe.wetness} channel ${channel}: `
              + `${shipped[channel]} vs ${legacy[channel]}`,
          );
        }
      }
    });
    console.log(
      `reef carbonate at 0: largest bed gap ${largestGap} `
        + `(${METAL_REASSOCIATES ? `Metal, bound ${METAL_BED_TOLERANCE}` : "exact required"})`,
    );
    expect(mismatches).toEqual([]);
  });

  it("lays a paler bed that stays pale deeper at full carbonate", async () => {
    const probes = sweep(1).filter((probe) => probe.wetness <= 0.5);
    const results = await evaluate(probes);
    probes.forEach((probe, index) => {
      const reef = luminance(rgbAt(results, index, "shipped"));
      const silt = luminance(rgbAt(results, index, "legacy"));
      const label = `(${probe.x}, ${probe.z}) bed ${probe.bedElevation} m wet ${probe.wetness}`;
      // A hair of rounding is allowed where both beds have faded to the same
      // deep silt.
      expect(reef, label).toBeGreaterThanOrEqual(silt - 1e-6);
      // Down to 8 m the reef floor is mostly coral sand: at least twice the
      // mixed rock-and-quartz bed it replaces.
      if (probe.bedElevation >= -8) expect(reef, label).toBeGreaterThan(2 * silt);
      // Past 60 m both beds are the same deep silt.
      if (probe.bedElevation <= -60) expect(reef, label).toBeCloseTo(silt, 6);
    });
  });
});
