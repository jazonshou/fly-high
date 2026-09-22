import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Scene } from "@babylonjs/core/scene";
import type { AtmosphereSnapshot } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import { SpectralOceanSystem } from "../../src/render/webgpu/water/SpectralOceanSystem";

/**
 * The SHIPPED ocean, driven as the perf harness drives it, read back texel by
 * texel: does a water shot's wave field still depend on what streamed before
 * it once the harness pins the cascade cadence?
 *
 * tests/render.ocean-cascade-pin.test.ts proves the dispatch SCHEDULE is
 * history-free. This proves the thing the schedule is for: the textures the
 * sea is drawn from. It also catches what a schedule test cannot — any other
 * state the ocean carries across the pin — and it is where the one such state,
 * foam, is measured and named.
 *
 * Each arm builds a fresh ocean, runs a pre-pin "history" of N frames (what
 * earlier shots plus this shot's own streaming would have rendered), pins the
 * time exactly as the harness does, optionally pins the cadence, runs the
 * harness's 395 frames to the capture, and reads every cascade back. Histories
 * of 200 and 202 frames differ by 2 mod 4 — exactly the difference the
 * streaming loop's multiple-of-30 exits produce — so unpinned they must
 * disagree in the every-4th-frame cascade and ONLY there.
 */

const SEED = 0x4f434541;
// water-25ft's harness pin: 500 + canonical index 18 x 120 s.
const PIN_TIME_SECONDS = 500 + 18 * 120;
const FRAME_SECONDS = 1 / 60;
// tests/perf/perf-capture.test.ts: 150 settle + 4 drain + 240 measure + 1.
const FRAMES_FROM_PIN_TO_CAPTURE = 150 + 4 + 240 + 1;

const READBACK_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> results: array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn readTexture(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let dimensions = textureDimensions(source);
  if (invocation.x >= dimensions.x || invocation.y >= dimensions.y) { return; }
  results[invocation.x + invocation.y * dimensions.x] =
    textureLoad(source, vec2<i32>(invocation.xy), 0);
}
`;

interface CascadeTextures {
  readonly displacement: RawTexture;
  readonly slopeFoam: readonly [RawTexture, RawTexture];
  readonly slopeMoment: RawTexture;
  readonly normalIndex: 0 | 1;
}

/** One cascade's surface at the captured frame, as RGBA float texels. */
interface CascadeReadback {
  readonly displacement: Float32Array;
  /** slope.x, slope.y, foam, jacobian — the derivation shader's layout. */
  readonly slopeFoam: Float32Array;
  readonly slopeMoment: Float32Array;
}

async function readTexture(
  engine: WebGPUEngine,
  texture: RawTexture,
  resolution: number,
): Promise<Float32Array> {
  const results = new StorageBuffer(engine, resolution * resolution * 4 * 4);
  try {
    const shader = new ComputeShader("ocean-pin-readback", engine, { computeSource: READBACK_WGSL }, {
      entryPoint: "readTexture",
      bindingsMapping: {
        source: { group: 0, binding: 0 },
        results: { group: 0, binding: 1 },
      },
    });
    shader.setTexture("source", texture, false);
    shader.setStorageBuffer("results", results);
    const groups = Math.ceil(resolution / 8);
    await shader.dispatchWhenReady(groups, groups, 1);
    const view = await results.read();
    return new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  } finally {
    results.dispose();
  }
}

const atmosphere: AtmosphereSnapshot = {
  sunDirection: new Vector3(0.3, 0.35, 0.89).normalize(),
  sunColor: new Color3(1, 0.86, 0.7),
  sunIntensity: 3.2,
  skyZenith: new Color3(0.2, 0.36, 0.7),
  skyHorizon: new Color3(0.86, 0.66, 0.5),
  ambientColor: new Color3(0.4, 0.4, 0.45),
  skylightIlluminanceNormalized: 0.7,
  sunIlluminanceNormalized: 0.62,
  sunAngularRadiusRadians: 0.004675,
  cloudCoverage: 0.2,
  humidity: 0.45,
  windSpeed: 8,
  windDirection: new Vector2(0.28, 0.96),
  moonDirection: new Vector3(0, -1, 0),
  moonIlluminanceLux: 0,
  moonIlluminatedFraction: 0,
  adaptedLuminanceCdM2: 4_000,
  sceneKeyLuminanceCdM2: 800,
};

/**
 * Builds a fresh shipped ocean, runs `historyFrames` pre-pin frames, pins time
 * (and, if asked, the cadence) exactly where the harness does, runs to the
 * captured frame, and reads every cascade back.
 */
async function captureOcean(historyFrames: number, pinCadence: boolean): Promise<CascadeReadback[]> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, {
    antialias: false,
    enableAllFeatures: false,
    setMaximumLimits: false,
  });
  try {
    await engine.initAsync();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    // Compute submissions and readbacks resolve at frame boundaries, so pump
    // an empty loop, as tests/gpu/ocean-slope-mips.test.ts does. Bracketing
    // the ocean's frames with beginFrame/endFrame instead left the readback's
    // copy unsubmitted and the test waiting on it forever.
    engine.runRenderLoop(() => {});
    const yieldToLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const nextFrameBoundary = () => new Promise<void>((resolve) => {
      engine.onEndFrameObservable.addOnce(() => resolve());
    });
    const camera = new UniversalCamera("ocean-pin-camera", new Vector3(0, 8, 0), scene);
    scene.activeCamera = camera;
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const ocean = await SpectralOceanSystem.create(scene, camera, 0, profile, SEED, atmosphere);
    try {
      // ONE ocean frame per engine frame, as the harness renders them.
      // Batching thirty updates between frame boundaries left the wave field
      // bit-identical but made FOAM differ between two runs of this very test
      // (cascade 2's floor read 2.82e-2 then 5.74e-3) — a property of the
      // batching, not of the ocean: the real harness renders one frame at a
      // time and its same-history captures are bit-identical over the sea.
      const step = async (time: number) => {
        ocean.update(camera.position, time, FRAME_SECONDS);
        await nextFrameBoundary();
      };
      // The streaming history: a different number of frames per arm, at
      // times that run on from wherever the previous shot left off.
      let time = 100;
      for (let frame = 0; frame < historyFrames; frame += 1) {
        time += FRAME_SECONDS;
        await step(time);
      }
      // The harness's time pin, and the fix.
      time = PIN_TIME_SECONDS;
      if (pinCadence) ocean.pinCascadePhaseForCapture();
      for (let frame = 0; frame < FRAMES_FROM_PIN_TO_CAPTURE; frame += 1) {
        time += FRAME_SECONDS;
        await step(time);
      }
      // The cascades are private to the ocean; reading them is the point of
      // this test, as reading the engine's private device is for others here.
      const cascades = (ocean as unknown as {
        compute: { cascades: readonly CascadeTextures[]; config: { resolution: number } };
      }).compute;
      await yieldToLoop();
      const resolution = cascades.config.resolution;
      const out: CascadeReadback[] = [];
      for (const cascade of cascades.cascades) {
        out.push({
          displacement: await readTexture(engine, cascade.displacement, resolution),
          slopeFoam: await readTexture(engine, cascade.slopeFoam[cascade.normalIndex], resolution),
          slopeMoment: await readTexture(engine, cascade.slopeMoment, resolution),
        });
      }
      return out;
    } finally {
      ocean.dispose();
      scene.dispose();
    }
  } finally {
    engine.stopRenderLoop();
    engine.dispose();
    canvas.remove();
  }
}

/** Largest absolute difference over the given channels (0..3 of RGBA). */
function maxDelta(a: Float32Array, b: Float32Array, channels: readonly number[]): number {
  let largest = 0;
  for (let texel = 0; texel < a.length; texel += 4) {
    for (const channel of channels) {
      largest = Math.max(largest, Math.abs(a[texel + channel]! - b[texel + channel]!));
    }
  }
  return largest;
}

const ALL = [0, 1, 2, 3] as const;
const SLOPE_AND_JACOBIAN = [0, 1, 3] as const;
const FOAM = [2] as const;

describe("the shipped ocean at a capture, across two streaming histories", () => {
  it("unpinned, differs in the every-4th-frame cascade and nowhere else (the positive control)", async () => {
    const cadences = [1, 1, 2, 4];
    const a = await captureOcean(200, false);
    const b = await captureOcean(202, false);
    expect(a).toHaveLength(cadences.length);
    a.forEach((cascade, index) => {
      const moved = maxDelta(cascade.displacement, b[index]!.displacement, ALL);
      // The every-4th cascade was last evolved on a different frame, so at a
      // different time: its waves are elsewhere. The others were not.
      if (cadences[index] === 4) expect(moved, `cascade ${index}`).toBeGreaterThan(0);
      else expect(moved, `cascade ${index}`).toBe(0);
    });
  }, 300_000);

  it("pinned, is the same wave field texel for texel, with foam the one named exception", async () => {
    const a = await captureOcean(200, true);
    const b = await captureOcean(202, true);
    const foamDeltas: number[] = [];
    a.forEach((cascade, index) => {
      const other = b[index]!;
      expect(maxDelta(cascade.displacement, other.displacement, ALL), `displacement ${index}`).toBe(0);
      expect(maxDelta(cascade.slopeFoam, other.slopeFoam, SLOPE_AND_JACOBIAN), `slope ${index}`).toBe(0);
      expect(maxDelta(cascade.slopeMoment, other.slopeMoment, ALL), `slope moment ${index}`).toBe(0);
      foamDeltas.push(maxDelta(cascade.slopeFoam, other.slopeFoam, FOAM));
    });
    // FOAM IS OUTSIDE THE PIN, on purpose. It integrates: every derivation
    // reads the previous foam and decays it with a 2.8 s half-life, so about
    // a fifth of what was there at the pin survives the 395 frames to the
    // capture. That is the named floor the re-captures measured on near water
    // when a shot's own streaming count differs, growing with the difference
    // (0.004/255 mean at 30 frames, 0.012 at 150). Report it here as texel
    // foam units so a change that makes it worse is visible.
    console.log(`ocean-cascade-pin foam floor, max |dfoam| per cascade: ${foamDeltas.map((d) => d.toExponential(2)).join(", ")}`);
    // Measured 2026-09-22 on this adapter, identical over repeated runs:
    // 8.98e-3, 5.38e-3, 2.40e-3 and 0 for the four cascades (the 128-512 m
    // cascade carries no foam — swells that long do not break). The 395 frames
    // to capture are 6.6 s, so a 2.8 s half-life leaves ~20 % of the pre-pin
    // difference. The bound is ~3.3x the worst cascade, there to fail if foam
    // starts carrying much more of its history into a capture (a longer
    // half-life, a shorter settle).
    expect(Math.max(...foamDeltas), "foam carry-over across the pin").toBeLessThan(0.03);
  }, 300_000);
});
