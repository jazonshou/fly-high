import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Scene } from "@babylonjs/core/scene";
import {
  LIGHT_POINT_PSF_RADIUS_PIXELS,
  LightPointSystem,
  type LightPointFixture,
} from "../../src/render/webgpu/lighting/LightPoints";
import {
  AIRFIELD_LAMP_PHOTOMETRY,
  AIRFIELD_LAMP_SCENE_SCALE,
} from "../../src/render/webgpu/lighting/AirfieldLighting";

/**
 * `7-5` — the single-lamp radiometry harness (the "day half" instrument of the
 * lamp-visibility investigation, 2026-09-01).
 *
 * The compile test beside this one proves the billboard's shader builds; the
 * constant-fragment probe proved its geometry rasterizes where the runway is.
 * NEITHER proves the real photometric chain delivers a nonzero, correctly
 * scaled value to the HDR buffer — and "the lamps are invisible" spent a
 * morning attributed to depth, position and brightness in turn while every
 * instrument in play measured something else (vegetation state, a probe
 * window's temporary constant, a rod-blind probe colour). This harness
 * isolates ONE fixture through the REAL material into a FLOAT render target
 * and reads the value back, so the chain's output exists as a measurement
 * rather than as the residue of subtracting two contaminated frames.
 *
 * WHAT A PASS LOOKS LIKE IF THE FEATURE WERE ABSENT: black — every assertion
 * below fails on a zero readback, so this cannot green-light an absent
 * feature (the Gate-W lesson).
 *
 * DELIBERATELY NOT PINNED: the absolute display brightness of a lamp. That is
 * the open calibration question (the shipped anchor pins a 10,000 cd lamp to
 * a magnitude-0 star; E = I/d² says it should sit ~15,750x brighter, at
 * magnitude −10.5). This harness pins the STRUCTURE the calibration debate
 * needs to stand on: nonzero delivery, inverse-square behaviour, and the
 * composed tint arithmetic — and prints the measured values for the ledger.
 *
 * Readback discipline: the target is rgba16float — HDR, no sRGB encode, no
 * clamp at display range — read AFTER the final render completes, never
 * interleaved with an in-flight frame (the buffer-ring lesson). NOT
 * rgba32float: WebGPU refuses blending on 32-bit float targets ("Blending is
 * enabled but color format (TextureFormat::RGBA32Float) is not blendable"),
 * and the light-point material's ALPHA_ADD blend state is the shipping
 * configuration this harness exists to exercise — found by this test's first
 * run failing loudly, which is the failure mode it was built to have. Half
 * floats top out at 65,504: the brightest arm below peaks near 5e4, inside
 * range by design — re-check that headroom if intensities grow.
 *
 * The original harness was blocked by an environment wall, not a feature
 * failure. In the `vitest.gpu.config.ts` environment, anything coupled to the
 * canvas swapchain cannot be read back:
 *
 *   Destroyed texture [Texture "IOSurface(...WebgpuSwapChainTexture...)"]
 *   used in a submit.
 *
 * The `Principle Engineer` proved the limit with a positive control rather
 * than inferring it (2026-09-01): a scene CLEARED TO SOLID RED read back as
 * {lit: 0, peak: 0} through `engine.readPixels`, and a
 * `RenderTargetTexture` rendered via `scene.render()` dies on the destroyed
 * swapchain texture above, because custom render targets render inside the
 * same frame that presents. The compute-readback GPU tests
 * (`ocean-slope-mips`, `terrain-height-generate`) work because their
 * textures never ride a presented frame — the wall is specifically
 * swapchain-coupled RENDERING, not readback per se.
 *
 * The probe now takes the first route that note prescribed: render the RTT
 * directly, outside `scene.render()`. No swapchain texture enters the submit,
 * while the real light material, half-float blend target, and device readback
 * remain unchanged. This makes all three assertions an active real-adapter
 * gate instead of parked executable documentation.
 */

const CANVAS_SIZE = 128;
const RTT_SIZE = 128;

/** IEEE 754 half -> float, same decoder as `ocean-slope-mips.test.ts`. */
function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa ? Number.NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/** Babylon's readPixels returns raw halfs or converted floats by path. */
function toFloats(pixels: ArrayBufferView): number[] {
  if (pixels instanceof Float32Array) return [...pixels];
  if (pixels instanceof Uint16Array) return [...pixels].map(halfToFloat);
  throw new TypeError(`Unexpected readPixels buffer ${pixels.constructor.name}`);
}

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const gpuErrors: string[] = [];

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, {
    antialias: false,
    enableAllFeatures: false,
    setMaximumLimits: false,
  });
  await engine.initAsync();
  const device = (engine as unknown as { _device?: GPUDevice })._device;
  device?.addEventListener("uncapturederror", (event) => {
    gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
  });
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

interface LampReading {
  /** Peak linear HDR value across the target (max of R). */
  peak: number;
  /** Sum of R over the whole target — the flux proxy the PSF conserves. */
  flux: number;
  gpuErrorsSeen: string[];
}

/**
 * Render ONE white fixture dead ahead at `distanceMeters` into a float RTT
 * and read the result. Camera at origin looking +Z; no aerial binding is set,
 * which the include defines as transmittance exactly 1 (`aerialParams.w <= 0`
 * early-out), so the reading is `intensity * candela * beam / (d^2 * psf^2)`
 * with candela = 1 (default unit IES profile) and beam = 1 (omnidirectional).
 */
async function readLamp(
  distanceMeters: number,
  intensity: number,
): Promise<LampReading> {
  const gpuErrorOffset = gpuErrors.length;
  const scene = new Scene(engine);
  let system: LightPointSystem | null = null;
  let target: RenderTargetTexture | null = null;
  try {
    scene.clearColor = new Color4(0, 0, 0, 1);
    const camera = new FreeCamera("camera", Vector3.Zero(), scene);
    camera.setTarget(new Vector3(0, 0, 1));
    camera.minZ = 0.08;
    camera.maxZ = Math.max(10_000, distanceMeters * 2);
    scene.activeCamera = camera;

    const fixture: LightPointFixture = {
      position: [0, 0, distanceMeters],
      aim: [0, -1, 0],
      intensity,
      profileRow: 0,
      radiusMeters: AIRFIELD_LAMP_PHOTOMETRY.edge.radiusMeters,
      color: [1, 1, 1],
      beamCosineCutoff: -1,
    };

    system = new LightPointSystem(scene, [fixture], 1);
    system.setOutputSize(RTT_SIZE, RTT_SIZE);
    system.setCameraPosition(camera.position);

    target = new RenderTargetTexture(
      "lamp-radiometry-target",
      RTT_SIZE,
      scene,
      {
        type: Constants.TEXTURETYPE_HALF_FLOAT,
        format: Constants.TEXTUREFORMAT_RGBA,
        generateMipMaps: false,
        generateDepthBuffer: true,
      },
    );
    target.activeCamera = camera;
    target.renderList = scene.meshes.slice();
    target.clearColor = new Color4(0, 0, 0, 1);
    scene.customRenderTargets.push(target);

    // Effects compile asynchronously; a fixed small frame count captures
    // nothing (the post-process-test lesson). Render the target directly so the
    // probe never acquires or submits a canvas swapchain texture.
    let ready = false;
    for (let frame = 0; frame < 240 && !ready; frame += 1) {
      target.render();
      ready = scene.meshes.every((mesh) => mesh.isReady(true));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (let frame = 0; frame < 3; frame += 1) target.render();

    const pixels = toFloats((await target.readPixels())!);
    let peak = 0;
    let flux = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const r = pixels[index]!;
      if (r > peak) peak = r;
      flux += r;
    }

    // Device errors are delivered asynchronously. The offset gives this probe
    // ownership of only the events emitted during its own render/readback, and
    // the queue fence plus one task ensures those events arrive before the
    // immutable reading is returned to its assertion.
    const device = (engine as unknown as { readonly _device: GPUDevice })._device;
    await device.queue.onSubmittedWorkDone();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { peak, flux, gpuErrorsSeen: gpuErrors.slice(gpuErrorOffset) };
  } finally {
    target?.dispose();
    system?.dispose();
    scene.dispose();
  }
}

/** The tint the vertex stage should produce: intensity / (d^2 * psf^2). */
function composedPeak(distanceMeters: number, intensity: number): number {
  return intensity
    / (distanceMeters * distanceMeters * LIGHT_POINT_PSF_RADIUS_PIXELS ** 2);
}

describe("7-5 light-point radiometry on a real adapter", () => {
  it("delivers a nonzero, composition-matching HDR value for one edge lamp at approach range", async () => {
    const distance = 2_500;
    const intensity =
      AIRFIELD_LAMP_PHOTOMETRY.edge.intensityCandela * AIRFIELD_LAMP_SCENE_SCALE;
    const reading = await readLamp(distance, intensity);

    expect(reading.gpuErrorsSeen, reading.gpuErrorsSeen.join("\n")).toEqual([]);
    // Absent feature = black target = this fails. The chain delivered.
    expect(reading.peak).toBeGreaterThan(0);

    // The composed arithmetic, against the measurement. The PSF spends the
    // peak across its profile, so the centre pixel reads BELOW the analytic
    // peak (exp falloff sampled off-centre, MSAA-free rasterization), but the
    // same chain cannot exceed it, and a hidden multiplicative zero or a
    // double-application lands orders of magnitude away, not within the band.
    const expected = composedPeak(distance, intensity);
    expect(reading.peak).toBeLessThanOrEqual(expected * 1.05);
    expect(reading.peak).toBeGreaterThanOrEqual(expected * 0.2);

    // The ledger line the calibration decision will cite.
    console.info(
      `radiometry: edge lamp at ${distance} m, intensity ${intensity} `
      + `(candela ${AIRFIELD_LAMP_PHOTOMETRY.edge.intensityCandela} x scale ${AIRFIELD_LAMP_SCENE_SCALE}): `
      + `peak HDR ${reading.peak.toExponential(3)} vs composed ${expected.toExponential(3)}, `
      + `flux ${reading.flux.toExponential(3)}`,
    );
  }, 120_000);

  it("obeys inverse-square between approach ranges", async () => {
    const intensity =
      AIRFIELD_LAMP_PHOTOMETRY.edge.intensityCandela * AIRFIELD_LAMP_SCENE_SCALE;
    const far = await readLamp(2_500, intensity);
    const near = await readLamp(1_250, intensity);

    expect(far.gpuErrorsSeen, `far reading: ${far.gpuErrorsSeen.join("\n")}`).toEqual([]);
    expect(near.gpuErrorsSeen, `near reading: ${near.gpuErrorsSeen.join("\n")}`).toEqual([]);
    expect(far.peak).toBeGreaterThan(0);
    expect(near.peak).toBeGreaterThan(0);
    // Half the distance, four times the irradiance. Both readings sit on the
    // PSF branch (projected radius at these ranges is centipixels), so the
    // /psf^2 normaliser cancels and the ratio is the inverse-square law
    // alone. Rasterization jitter of the sub-pixel PSF centre gives the band.
    const ratio = near.peak / far.peak;
    expect(ratio).toBeGreaterThan(2.5);
    expect(ratio).toBeLessThan(6.5);
    console.info(
      `radiometry: inverse-square ratio 1250 m / 2500 m = ${ratio.toFixed(2)} (ideal 4.00)`,
    );
  }, 180_000);

  it("scales linearly with intensity where the response chain is not involved", async () => {
    // The HDR buffer has no shoulder: a large intensity lift must arrive
    // exactly that much brighter HERE, whatever the display chain later does
    // with it. If this holds while a displayed frame stays flat, any crush is
    // provably in the response chain, not the lamp path — the discrimination
    // the "1000x changed nothing" measurement of 2026-09-01 could not make.
    // (157x was the physics correction factor the calibration fix later
    // landed; kept as the probe size so the arm spans the same decades.)
    const base =
      AIRFIELD_LAMP_PHOTOMETRY.edge.intensityCandela * AIRFIELD_LAMP_SCENE_SCALE;
    const one = await readLamp(2_500, base);
    const lifted = await readLamp(2_500, base * 157);
    expect(one.gpuErrorsSeen, `base reading: ${one.gpuErrorsSeen.join("\n")}`).toEqual([]);
    expect(
      lifted.gpuErrorsSeen,
      `lifted reading: ${lifted.gpuErrorsSeen.join("\n")}`,
    ).toEqual([]);
    expect(one.peak).toBeGreaterThan(0);
    const ratio = lifted.peak / one.peak;
    expect(ratio).toBeGreaterThan(120);
    expect(ratio).toBeLessThan(200);
    console.info(
      `radiometry: 157x intensity reads ${ratio.toFixed(1)}x in HDR (ideal 157.0)`,
    );
  }, 180_000);
});
