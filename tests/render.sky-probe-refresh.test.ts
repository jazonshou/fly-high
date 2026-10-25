import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import type { SphericalPolynomial } from "@babylonjs/core/Maths/sphericalPolynomial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { FlightRenderer } from "../src/render/FlightRenderer";
import {
  resolveAerialPerspectiveBinding,
  type AerialPerspectiveBinding,
} from "../src/render/webgpu/atmosphere/AerialPerspective";
import {
  bakeSkyIrradiancePolynomial,
  SKY_IRRADIANCE_SAMPLE_SIZE,
  SkyEnvironmentProbe,
} from "../src/render/webgpu/atmosphere/SkyEnvironmentProbe";
import { resolveEnvironmentState } from "../src/render/webgpu/nature/EnvironmentDirector";

/**
 * `FlightRenderer.refreshSkyProbe`, the renderer's own decision of when and
 * how the sky probe re-lights the world, driven frame by frame on a stand-in
 * renderer that carries only the fields it reads (the real method, called
 * through the prototype) and a real SkyEnvironmentProbe on a NullEngine.
 *
 *  - Synchronous (the capture's renderer): the same irradiance, cloud LUT
 *    bindings and specular re-arm frames as the one-frame re-light before
 *    slicing (347f52a), frame for frame.
 *  - Sliced (a flight): the irradiance lands on frame N, the specular cube
 *    re-arms on N+1 and the cloud LUT re-bakes on N+2 from the very snapshot
 *    the irradiance was sampled from; no frame does two of them.
 *  - A one-frame re-light between a landing and its LUT drops the older LUT;
 *    turning synchronous mid-rebake re-lights from the live binding.
 *  - A teleport (an altitude jump past the threshold between two frames)
 *    re-lights at once from the live binding, whether or not a rebake was in
 *    flight; a jump inside the threshold is a drift and is sliced.
 */

const SENTINEL = 777;
const ALBEDO = 0.21;

function createProbe(now?: () => number) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const probe = new SkyEnvironmentProbe(scene, new Mesh("sky", scene), now);
  let polynomial: SphericalPolynomial | null = null;
  Object.defineProperty(probe.texture, "sphericalPolynomial", {
    get: () => polynomial,
    set: (value: SphericalPolynomial | null) => { polynomial = value; },
    configurable: true,
  });
  return probe;
}

/** A clock that moves 0.05 ms a read, so a 0.5 ms slice samples a fixed number of rows on any host. */
function fakeClock(): () => number {
  let reads = 0;
  return () => { reads += 1; return reads * 0.05; };
}

const env = resolveEnvironmentState({ clock: { dayOfYear: 171, solarTimeHours: 16 }, latitudeDegrees: 45, weather: "clear" });
const bindingAt = (altitude: number): AerialPerspectiveBinding =>
  resolveAerialPerspectiveBinding(env, altitude, [1, 0.9, 0.8], [0.6, 0.7, 0.9], 0.9);

/** The renderer's fields refreshSkyProbe reads and writes. */
interface Receiver {
  skyProbe: SkyEnvironmentProbe;
  atmosphere: { surfaceAlbedoLuminance: number };
  atmosphereResources: { update: (binding: AerialPerspectiveBinding) => void };
  skyProbeStale: boolean;
  skyProbeAltitudeMeters: number;
  skyRebakeSynchronous: boolean;
  skyRebakeSampled: boolean;
  skyProbeRearmPending: boolean;
  skyProbeCameraAltitudeMeters: number;
  skyAmbientLutPending: AerialPerspectiveBinding | null;
  skyRefreshLastMilliseconds: number;
  skyRefreshMaxMilliseconds: number;
  skyRefreshFrameIndex: number;
  frameIndex: number;
}

function receiver(synchronous: boolean, lut: AerialPerspectiveBinding[]): Receiver {
  return {
    skyProbe: createProbe(fakeClock()),
    atmosphere: { surfaceAlbedoLuminance: ALBEDO },
    atmosphereResources: { update: (binding) => lut.push(binding) },
    skyProbeStale: true,
    skyProbeAltitudeMeters: 0,
    skyRebakeSynchronous: synchronous,
    skyRebakeSampled: false,
    skyProbeRearmPending: false,
    skyProbeCameraAltitudeMeters: Number.NaN,
    skyAmbientLutPending: null,
    skyRefreshLastMilliseconds: 0,
    skyRefreshMaxMilliseconds: 0,
    skyRefreshFrameIndex: -1,
    frameIndex: 0,
  };
}

/** One frame: the renderer's frame index moves, then its refresh runs on `binding`. */
const refresh = (target: Receiver, binding: AerialPerspectiveBinding): void => {
  target.frameIndex += 1;
  (FlightRenderer.prototype as unknown as { refreshSkyProbe(b: AerialPerspectiveBinding): void })
    .refreshSkyProbe.call(target, binding);
};

/** The 347f52a block, verbatim in effect. */
function baseRefresh(state: { stale: boolean; altitude: number; poly: SphericalPolynomial | null; lut: AerialPerspectiveBinding[]; rearms: number }, binding: AerialPerspectiveBinding) {
  if (state.stale || Math.abs(binding.cameraAltitudeMeters - state.altitude) > 500) {
    state.poly = bakeSkyIrradiancePolynomial(binding, SKY_IRRADIANCE_SAMPLE_SIZE, ALBEDO);
    state.rearms += 1;
    state.lut.push(binding);
    state.stale = false;
    state.altitude = binding.cameraAltitudeMeters;
  }
}

describe("refreshSkyProbe", () => {
  // A climb of 7 m a frame: a drift re-light every 72 frames or so.
  const climb = Array.from({ length: 400 }, (_, frame) => bindingAt(100 + frame * 7));

  it("sync: same SH, LUT bindings and re-arm frames as 347f52a, frame for frame", () => {
    const lut: AerialPerspectiveBinding[] = [];
    const head = receiver(true, lut);
    const base = { stale: true, altitude: 0, poly: null as SphericalPolynomial | null, lut: [] as AerialPerspectiveBinding[], rearms: 0 };
    let headRearms = 0;
    for (const binding of climb) {
      head.skyProbe.texture.refreshRate = SENTINEL;
      refresh(head, binding);
      if (head.skyProbe.texture.refreshRate === RenderTargetTexture.REFRESHRATE_RENDER_ONCE) headRearms += 1;
      baseRefresh(base, binding);
      expect(head.skyProbe.texture.sphericalPolynomial).toStrictEqual(base.poly);
      expect(headRearms).toBe(base.rearms);
      expect(lut).toEqual(base.lut);
      expect(lut.every((b, i) => b === base.lut[i])).toBe(true);
      expect(head.skyProbeAltitudeMeters).toBe(base.altitude);
    }
    expect(base.rearms).toBeGreaterThan(3);
  });

  it("sliced: SH on N, cube re-arm on N+1, LUT from the very snapshot on N+2", () => {
    const lut: AerialPerspectiveBinding[] = [];
    const head = receiver(false, lut);
    const log: string[] = [];
    let landed: { frame: number; poly: SphericalPolynomial | null; altitude: number } | null = null;
    let applied = 0;
    for (const [frame, binding] of climb.entries()) {
      head.skyProbe.texture.refreshRate = SENTINEL;
      const lutBefore = lut.length;
      const polyBefore = head.skyProbe.texture.sphericalPolynomial;
      refresh(head, binding);
      const rearmed = head.skyProbe.texture.refreshRate === RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
      const polyChanged = head.skyProbe.texture.sphericalPolynomial !== polyBefore;
      const lutFed = lut.length > lutBefore;
      if (frame > 0 && polyChanged) {
        expect(landed).toBeNull();
        landed = { frame, poly: head.skyProbe.texture.sphericalPolynomial, altitude: head.skyProbeAltitudeMeters };
        expect(rearmed).toBe(false);
        expect(lutFed).toBe(false);
      }
      if (frame > 0 && rearmed) {
        expect(landed!.frame).toBe(frame - 1);
        expect(lutFed).toBe(false);
      }
      if (frame > 0 && lutFed) {
        expect(landed!.frame).toBe(frame - 2);
        const fed = lut[lut.length - 1]!;
        expect(landed!.poly).toStrictEqual(bakeSkyIrradiancePolynomial(fed, SKY_IRRADIANCE_SAMPLE_SIZE, ALBEDO));
        expect(landed!.altitude).toBe(fed.cameraAltitudeMeters);
        expect(head.skyProbeAltitudeMeters).toBe(fed.cameraAltitudeMeters);
        expect(fed).not.toBe(binding);
        expect(fed.cameraAltitudeMeters).toBeLessThan(binding.cameraAltitudeMeters);
        expect(rearmed).toBe(false);
        expect(polyChanged).toBe(false);
        applied += 1;
        landed = null;
      }
      log.push(`${frame}:${polyChanged ? "S" : ""}${lutFed ? "L" : ""}${rearmed ? "R" : ""}`);
    }
    expect(applied).toBeGreaterThan(3);
    // Only the first frame (stale: a one-frame re-light) does more than one.
    const multi = log.filter((entry) => /:..+/.test(entry));
    expect(multi).toEqual(["0:SLR"]);
  });

  it("a one-frame re-light between a landing and its LUT drops the older LUT", () => {
    for (const gap of [1, 2]) {
      const lut: AerialPerspectiveBinding[] = [];
      const head = receiver(false, lut);
      let frame = 1;
      refresh(head, climb[0]!);
      let polyBefore = head.skyProbe.texture.sphericalPolynomial;
      for (; frame < climb.length; frame += 1) {
        refresh(head, climb[frame]!);
        if (head.skyProbe.texture.sphericalPolynomial !== polyBefore) break;
        polyBefore = head.skyProbe.texture.sphericalPolynomial;
      }
      expect(head.skyAmbientLutPending).not.toBeNull();
      // gap 1: the stale re-light on N+1 (with the re-arm); gap 2: on N+2 (instead of the LUT).
      if (gap === 2) refresh(head, climb[frame + 1]!);
      head.skyProbeStale = true;
      const live = climb[frame + gap]!;
      const lutLength = lut.length;
      refresh(head, live);
      expect(lut.length).toBe(lutLength + 1);
      expect(lut[lut.length - 1]).toBe(live);
      for (let after = 1; after < 6; after += 1) refresh(head, climb[frame + gap + after]!);
      expect(lut.length).toBe(lutLength + 1);
      expect(head.skyAmbientLutPending).toBeNull();
    }
  });

  it("turning synchronous mid-rebake re-lights from the live binding in one frame and drops the snapshot", () => {
    const lut: AerialPerspectiveBinding[] = [];
    const head = receiver(false, lut);
    let frame = 0;
    for (; frame < climb.length; frame += 1) {
      refresh(head, climb[frame]!);
      if (head.skyProbe.rebakeInProgress) break;
    }
    expect(head.skyProbe.rebakeInProgress).toBe(true);
    head.skyRebakeSynchronous = true;
    const next = climb[frame + 1]!;
    refresh(head, next);
    expect(head.skyProbe.rebakeInProgress).toBe(false);
    expect(lut[lut.length - 1]).toBe(next);
    expect(head.skyProbeAltitudeMeters).toBe(next.cameraAltitudeMeters);
  });

  it("teleport: a jump past the threshold between two frames re-lights from the live binding at once", () => {
    for (const midRebake of [false, true]) {
      const lut: AerialPerspectiveBinding[] = [];
      const head = receiver(false, lut);
      let frame = 0;
      // Climb until a rebake is in flight (midRebake) or has landed and settled.
      for (; frame < climb.length; frame += 1) {
        refresh(head, climb[frame]!);
        if (midRebake && head.skyProbe.rebakeInProgress) break;
        if (!midRebake && frame > 120 && !head.skyProbe.rebakeInProgress && !head.skyProbeRearmPending) break;
      }
      expect(head.skyProbe.rebakeInProgress).toBe(midRebake);
      const from = climb[frame]!.cameraAltitudeMeters;
      const spawn = bindingAt(from > 1500 ? from - 1200 : from + 1200);
      head.skyProbe.texture.refreshRate = SENTINEL;
      refresh(head, spawn);
      expect(head.skyProbe.rebakeInProgress).toBe(false);
      expect(lut[lut.length - 1]).toBe(spawn);
      expect(head.skyProbeAltitudeMeters).toBe(spawn.cameraAltitudeMeters);
      expect(head.skyProbe.texture.sphericalPolynomial).toStrictEqual(
        bakeSkyIrradiancePolynomial(spawn, SKY_IRRADIANCE_SAMPLE_SIZE, ALBEDO),
      );
      expect(head.skyProbe.texture.refreshRate).toBe(RenderTargetTexture.REFRESHRATE_RENDER_ONCE);
      // And the next frame at the new place does nothing more.
      const lutLength = lut.length;
      head.skyProbe.texture.refreshRate = SENTINEL;
      refresh(head, bindingAt(spawn.cameraAltitudeMeters + 3));
      expect(lut.length).toBe(lutLength);
      expect(head.skyProbe.rebakeInProgress).toBe(false);
    }
  });

  it("a jump inside the threshold is a drift: sliced, as a climb", () => {
    const lut: AerialPerspectiveBinding[] = [];
    const head = receiver(false, lut);
    refresh(head, bindingAt(1000));
    expect(lut.length).toBe(1);
    // 400 m in a frame (no flight does it, but it is under the threshold), then 200 m more of drift.
    refresh(head, bindingAt(1400));
    expect(head.skyProbe.rebakeInProgress).toBe(false);
    refresh(head, bindingAt(1600));
    expect(head.skyProbe.rebakeInProgress).toBe(true);
    expect(lut.length).toBe(1);
  });
});
